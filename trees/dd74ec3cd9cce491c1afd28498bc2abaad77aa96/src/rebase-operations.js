import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { CliError } from "./errors.js";
import {
  beginGitMetrics,
  endGitMetrics,
  GIT_NO_RERERE,
  runGit,
  withGitObjectSession,
} from "./git.js";
import {
  assertClean,
  changeIdForCommit,
  currentHead,
  gitPath,
  repoContext,
  resolveObjectIds,
  revisionResolves,
  symbolicRef,
  treeId,
} from "./engine.js";
import { newId } from "./ids.js";
import { appendNote } from "./notes.js";
import { faultPoint } from "./faults.js";
import { carryProvenanceForApplications } from "./provenance.js";
import {
  cherryPickHead,
  mergeMessagePath,
  pendingMergeHead,
  readReconciliationState,
  unmergedPaths,
} from "./reconcile-state.js";
import {
  clearRebaseState,
  readRebaseState,
  writeRebaseState,
} from "./rebase-state.js";
import { buildRebasePlan } from "./rebase-plan.js";
import { rebaseProgram } from "./forecasts.js";
import {
  recreatedMergeMessage,
  resolveStepParents,
  unsupportedTopologyError,
} from "./rebase-topology.js";
import { readRebaseForecast, rebaseForecastForPlan } from "./rebase-forecast.js";
import {
  assertOverlayCurrent,
  materializeOverlay,
  reduceToCommittedHead,
  restoreOverlayAfterAbort,
} from "./target-overlay.js";
import {
  captureConflictDescriptors,
  captureResolutionOutcomes,
  materializeResolutionCandidate,
  publishResolution,
} from "./resolutions.js";
import {
  captureSpecMergeOutcomes,
  assertCurrentSpecDecisions,
  compactSpecMerge,
  materializeSpecMerge,
  specMergePlansForOperation,
} from "./specs.js";

/** The program steps that run, which is what progress is counted over. */
function executableSteps(operation) {
  return operation.queue.filter((item) => (item.kind ?? "pick") !== "omit");
}

function requirePendingRebase(cwd) {
  const operation = readRebaseState(cwd);
  if (!operation) {
    throw new CliError("No causal rebase is in progress in this worktree.",
      { code: "no-operation-pending" });
  }
  return operation;
}

function currentBranch(cwd) {
  const ref = symbolicRef("HEAD", cwd);
  if (!ref || !ref.startsWith("refs/heads/")) {
    throw new CliError("Causal rebase requires a named local branch.",
      { code: "precondition-not-met" });
  }
  return {
    ref,
    name: ref.slice("refs/heads/".length),
  };
}

function requireOperationBranch(operation, cwd) {
  const branch = currentBranch(cwd);
  if (branch.ref !== operation.sourceBranchRef) {
    throw new CliError(
      `The rebase journal belongs to branch '${operation.sourceRef}', not '${branch.name}'.`,
      {
        code: "out-of-band-change",
        details: `Switch back to '${operation.sourceRef}' before status recovery, continue, or abort.`,
      },
    );
  }
  return branch;
}

function assertNoGitReplay(cwd) {
  const names = ["CHERRY_PICK_HEAD", "REVERT_HEAD", "MERGE_HEAD", "REBASE_HEAD"];
  const active = names.filter((name) => revisionResolves(name, cwd));
  const privateReplayPaths = ["rebase-merge", "rebase-apply", "sequencer"]
    .map((name) => gitPath(name, cwd))
    .filter((location) => fs.existsSync(path.resolve(cwd, location)));
  if (active.length || privateReplayPaths.length) {
    throw new CliError(
      `Git already has an active replay operation (${[
        ...active,
        ...privateReplayPaths.map((location) => path.basename(location)),
      ].join(", ")}).`, { code: "git-operation-active" },
    );
  }
}

function addActiveDuration(operation, phaseStarted) {
  operation.timings ??= { activeApplicationMs: 0 };
  operation.timings.activeApplicationMs += performance.now() - phaseStarted;
}

function accumulateGitMetrics(operation, metrics) {
  operation.timings ??= { activeApplicationMs: 0 };
  const existing = operation.timings.git ?? {
    count: 0,
    processes: 0,
    sessionQueries: 0,
    cacheHits: 0,
    totalMs: 0,
    failed: 0,
    byCommand: [],
  };
  const byCommand = new Map(
    existing.byCommand.map((item) => [
      item.command,
      {
        ...item,
        processes: item.processes ?? item.count,
        sessionQueries: item.sessionQueries ?? 0,
        cacheHits: item.cacheHits ?? 0,
      },
    ]),
  );
  for (const item of metrics.byCommand) {
    const current = byCommand.get(item.command) ?? {
      command: item.command,
      count: 0,
      processes: 0,
      sessionQueries: 0,
      cacheHits: 0,
      totalMs: 0,
      maxMs: 0,
    };
    current.count += item.count;
    current.processes += item.processes ?? item.count;
    current.sessionQueries += item.sessionQueries ?? 0;
    current.cacheHits += item.cacheHits ?? 0;
    current.totalMs += item.totalMs;
    current.maxMs = Math.max(current.maxMs, item.maxMs);
    byCommand.set(item.command, current);
  }
  operation.timings.git = {
    count: existing.count + metrics.count,
    processes:
      (existing.processes ?? existing.count) +
      (metrics.processes ?? metrics.count),
    sessionQueries:
      (existing.sessionQueries ?? 0) + (metrics.sessionQueries ?? 0),
    cacheHits: (existing.cacheHits ?? 0) + (metrics.cacheHits ?? 0),
    totalMs: Number((existing.totalMs + metrics.totalMs).toFixed(2)),
    failed: existing.failed + metrics.failed,
    byCommand: [...byCommand.values()]
      .map((item) => ({
        ...item,
        totalMs: Number(item.totalMs.toFixed(2)),
        maxMs: Number(item.maxMs.toFixed(2)),
      }))
      .sort((left, right) =>
        right.totalMs - left.totalMs || left.command.localeCompare(right.command),
      ),
  };
}

function markMismatch(operation, message, cwd, details = null) {
  operation.state = "forecast-mismatch";
  writeRebaseState(operation, cwd);
  throw new CliError(message, {
    code: "stale-forecast",
    details:
      details ??
      "Run 'vlab rebase --abort', then generate and review a new forecast.",
  });
}

function expectedForecastStep(operation, change, cwd) {
  if (!operation.forecastApproval) return null;
  const step = operation.forecastApproval.steps[operation.executedCount ?? operation.nextIndex];
  if (!step || step.sourceCommit !== change.commit) {
    markMismatch(
      operation,
      `Rebase forecast '${operation.forecastId}' has a different replay queue.`,
      cwd,
    );
  }
  return step;
}

function validateForecastBefore(operation, change, targetBeforeTree, cwd) {
  const step = expectedForecastStep(operation, change, cwd);
  if (step && step.targetBeforeTree !== targetBeforeTree) {
    markMismatch(
      operation,
      `Rebase forecast '${operation.forecastId}' no longer matches the target-before tree.`,
      cwd,
      [
        `Forecast tree: ${step.targetBeforeTree}`,
        `Actual tree:   ${targetBeforeTree}`,
        "Abort and generate a new forecast.",
      ].join("\n"),
    );
  }
  return step;
}

function validateForecastAfter(operation, change, resultTree, outcome, cwd) {
  const step = expectedForecastStep(operation, change, cwd);
  if (!step) return;
  if (step.resultTree !== resultTree || step.outcome !== outcome) {
    markMismatch(
      operation,
      `Rebase step for ${change.shortCommit} does not match forecast '${operation.forecastId}'.`,
      cwd,
      [
        `Forecast outcome/tree: ${step.outcome} ${step.resultTree ?? "-"}`,
        `Actual outcome/tree:   ${outcome} ${resultTree}`,
        "Abort and generate a new forecast.",
      ].join("\n"),
    );
  }
}

function applicationRecord(operation, change, relation, cwd) {
  const [appliedCommit, sourceTree, resultTree] = resolveObjectIds(
    ["HEAD^{commit}", `${change.commit}^{tree}`, "HEAD^{tree}"],
    cwd,
  );
  const actualChangeId = changeIdForCommit(appliedCommit, cwd);
  if (
    relation !== "contextual-fork" &&
    !change.changeId.startsWith("git:") &&
    actualChangeId !== change.changeId
  ) {
    operation.state = "identity-mismatch";
    writeRebaseState(operation, cwd);
    throw new CliError(
      `Rebased commit '${appliedCommit}' did not preserve Change-Id '${change.changeId}'.`,
      { code: "identity-not-preserved", details: "Abort the rebase; no shared receipts were published." },
    );
  }
  return {
    schema: "vcs-lab.rebase-application/v1",
    type: "rebase-application",
    id: newId("rebase_apply"),
    rebaseOperation: operation.id,
    forecastId: operation.forecastId ?? null,
    originCommit: change.commit,
    originChangeId: change.changeId,
    appliedCommit,
    appliedChangeId: actualChangeId,
    targetBefore: operation.current.targetBefore,
    targetBeforeTree: operation.current.targetBeforeTree,
    sourceTree,
    resultTree,
    relation,
    conflictedPaths: operation.current.conflictedPaths ?? [],
    resolutions: operation.current.resolutionOutcomes ?? [],
    semanticMerges: operation.current.semanticMerges ?? [],
    createdAt: new Date().toISOString(),
  };
}

/**
 * Keep every rewritten commit named by a ref of this operation's own.
 *
 * A merge-preserving rewrite builds one line, leaves it, builds another, and
 * only then joins them. Between leaving a line and joining it, nothing but this
 * journal names its tip; a ref makes that reachability a fact of the repository
 * rather than a property of the reflog, and makes an interrupted operation's
 * work visible to a person looking for it.
 */
function anchorRewritten(operation, originCommit, newCommit, cwd) {
  operation.rewritten ??= {};
  operation.rewritten[originCommit] = newCommit;
  if (operation.plan.mode !== "merge-preserving") return;
  runGit(
    ["update-ref", `refs/vcs-lab/rebase/${operation.id}/${originCommit}`, newCommit],
    { cwd },
  );
}

function releaseAnchors(operation, cwd) {
  if (operation.plan.mode !== "merge-preserving") return;
  for (const originCommit of Object.keys(operation.rewritten ?? {})) {
    runGit(
      ["update-ref", "-d", `refs/vcs-lab/rebase/${operation.id}/${originCommit}`],
      { cwd, allowFailure: true },
    );
  }
}

function rewrittenMap(operation) {
  return new Map(Object.entries(operation.rewritten ?? {}));
}

function recordSuccessfulApplication(operation, relation, cwd) {
  const item = operation.queue[operation.nextIndex];
  const change = item.change ?? item;
  const application = applicationRecord(operation, change, relation, cwd);
  operation.applied.push(application);
  anchorRewritten(operation, change.commit, application.appliedCommit, cwd);
  operation.nextIndex += 1;
  operation.executedCount = (operation.executedCount ?? 0) + 1;
  operation.current = null;
  operation.state = "running";
  faultPoint("rebase:before-journal-advance");
  writeRebaseState(operation, cwd);
  return application;
}

/**
 * Journal and publish one recreated merge.
 *
 * It is not an application record and never becomes one: a recreated merge
 * applies no change, so it has no origin/result correspondence to assert and
 * contributes to no coverage class (ADR-0034). What it records is what was
 * joined, which rewritten parents replaced which originals, and the resolutions
 * the join needed — auditable, and concluded from by nothing.
 */
function recordRecreatedMerge(operation, change, parents, cleanJoin, cwd) {
  const [resultCommit] = resolveObjectIds(["HEAD^{commit}"], cwd);
  const entry = {
    originCommit: change.commit,
    originChangeId: change.changeId,
    resultCommit,
    changeId: operation.current.mergeChangeId,
    cleanJoin,
    parents: parents.map((parent) => ({
      commit: parent.commit,
      replaces: parent.origin,
      source: parent.source,
    })),
    resolutions: operation.current.resolutionOutcomes ?? [],
    semanticMerges: operation.current.semanticMerges ?? [],
    conflictedPaths: operation.current.conflictedPaths ?? [],
    relation: "recreated-merge",
    createdAt: new Date().toISOString(),
  };
  operation.recreatedMerges.push(entry);
  anchorRewritten(operation, change.commit, resultCommit, cwd);
  operation.nextIndex += 1;
  operation.executedCount = (operation.executedCount ?? 0) + 1;
  operation.current = null;
  operation.state = "running";
  faultPoint("rebase:before-journal-advance");
  writeRebaseState(operation, cwd);
  return entry;
}

function forecastResolutionChoices(operation, change, conflicts) {
  if (!operation.forecastApproval) return null;
  const approvals = operation.forecastApproval.approvedResolutions.filter(
    (approval) => approval.sourceCommit === change.commit,
  );
  if (approvals.length === 0) return null;
  if (approvals.length !== conflicts.length) {
    throw new CliError(
      `Rebase forecast '${operation.forecastId}' no longer matches the current conflicts.`,
        { code: "stale-forecast" },
    );
  }
  return conflicts.map((conflict) => {
    const approval = approvals.find(
      (item) =>
        item.path === conflict.path && item.signature === conflict.signature,
    );
    const candidate = approval
      ? conflict.candidates.find(
          (item) =>
            item.id === approval.resolutionId &&
            item.resultBlob === approval.resultBlob,
        )
      : null;
    if (!approval || !candidate) {
      throw new CliError(
        `Rebase forecast '${operation.forecastId}' no longer matches '${conflict.path}'.`,
          { code: "stale-forecast" },
      );
    }
    return { conflict, candidate };
  });
}

function forecastSpecMergeChoices(operation, change, cwd) {
  if (!operation.forecastApproval) return [];
  const approvals = operation.forecastApproval.approvedSpecMerges.filter(
    (approval) => approval.sourceCommit === change.commit,
  );
  if (approvals.length === 0) return [];
  const plans = specMergePlansForOperation(operation, cwd).filter(
    (plan) => plan.status === "clean",
  );
  if (plans.length !== approvals.length) {
    throw new CliError(
      `Rebase forecast '${operation.forecastId}' no longer matches the semantic spec conflicts.`,
        { code: "stale-forecast" },
    );
  }
  return approvals.map((approval) => {
    const plan = plans.find(
      (candidate) =>
        candidate.file === approval.path &&
        candidate.signature === approval.signature &&
        candidate.status === "clean" &&
        candidate.result?.markdownHash === approval.resultMarkdownHash &&
        candidate.result?.manifestHash === approval.resultManifestHash,
    );
    if (!plan) {
      throw new CliError(
        `Rebase forecast '${operation.forecastId}' no longer matches '${approval.path}'.`,
          { code: "stale-forecast" },
      );
    }
    return plan;
  });
}

function applyForecastResolutions(operation, change, cwd) {
  const specChoices = forecastSpecMergeChoices(operation, change, cwd);
  const semanticallyResolved = new Set(
    specChoices.flatMap((plan) => compactSpecMerge(plan).resolvedPaths),
  );
  const exactConflicts = operation.current.conflicts.filter(
    (conflict) => !semanticallyResolved.has(conflict.path),
  );
  const choices = forecastResolutionChoices(operation, change, exactConflicts);
  if (!choices && specChoices.length === 0) return false;
  if (!choices && exactConflicts.length > 0) return false;

  const semanticMerges = specChoices.map((plan) => {
    materializeSpecMerge(plan, cwd);
    return compactSpecMerge(plan, "rebase-forecast-batch");
  });
  operation.current.semanticMerges = captureSpecMergeOutcomes(
    semanticMerges,
    cwd,
  );
  if (
    operation.current.semanticMerges.some(
      (merge) => merge.decision !== "accepted",
    )
  ) {
    throw new CliError("A forecasted semantic spec result changed while staging.",
      { code: "stale-input" });
  }
  for (const { conflict, candidate } of choices ?? []) {
    materializeResolutionCandidate(conflict, candidate, cwd);
    conflict.selectedResolutionId = candidate.id;
    conflict.decisionOverride = null;
    conflict.selectionMethod = "rebase-forecast-batch";
    conflict.suggestionAppliedAt = new Date().toISOString();
  }
  operation.current.resolutionOutcomes = captureResolutionOutcomes(
    exactConflicts,
    cwd,
  );
  writeRebaseState(operation, cwd);
  const recreatingMerge = operation.current.kind === "recreate-merge";
  // A resolved pick is finished by the sequencer; a resolved join is an
  // ordinary commit of a staged index, because nothing is sequencing it.
  if (recreatingMerge) {
    commitRecreatedMerge(operation, change, cwd);
  } else {
    const continued = runGit(
      [...GIT_NO_RERERE, "-c", "core.editor=true", "cherry-pick", "--continue"],
      { cwd, allowFailure: true },
    );
    if (!continued.ok) {
      throw new CliError("Git could not apply the forecasted rebase resolutions.", {
        code: "conflict-blocked",
        details: continued.output,
      });
    }
  }
  const resultTree = treeId("HEAD", cwd);
  const actualOutcome =
    semanticMerges.length && (choices ?? []).length
      ? "semantic-spec-and-exact-resolution"
      : semanticMerges.length
        ? "semantic-spec-merge"
        : "exact-resolution";
  validateForecastAfter(operation, change, resultTree, actualOutcome, cwd);
  if (recreatingMerge) {
    recordRecreatedMerge(
      operation,
      change,
      operation.current.mergeParents.map((parent) => ({
        commit: parent.commit,
        origin: parent.replaces,
        source: parent.source,
      })),
      false,
      cwd,
    );
  } else {
    recordSuccessfulApplication(operation, "contextual-rebase", cwd);
  }
  return true;
}

/**
 * Commit the staged join, under the identity the journal already minted.
 *
 * The message is composed from that journaled identity rather than a fresh one,
 * so a resumed operation commits the join it promised rather than a second one.
 */
function commitRecreatedMerge(operation, change, cwd) {
  fs.writeFileSync(
    mergeMessagePath(cwd),
    recreatedMergeMessage({
      subject: change.subject,
      changeId: operation.current.mergeChangeId,
      originChangeId: change.changeId,
      originCommit: change.commit,
    }),
  );
  const committed = runGit(
    ["-c", "core.editor=true", "commit", "--no-edit"],
    { cwd, allowFailure: true },
  );
  if (!committed.ok) {
    throw new CliError("Git could not commit the recreated merge.", {
      code: "conflict-blocked",
      details: committed.output,
    });
  }
}

function conflictError(operation, result) {
  const queued = operation.queue[operation.nextIndex];
  const change = queued.change ?? queued;
  const paths = operation.current.conflictedPaths;
  if (paths.length === 0) {
    return new CliError(
      `Causal rebase blocked while applying ${change.shortCommit}.`,
      {
        code: "conflict-blocked",
        // vlab's instruction leads; Git's own advice (including
        // 'cherry-pick --skip', the out-of-band path the next command
        // refuses) follows as context rather than as the first thing read.
        details: [
          "No change was silently skipped. Run 'vlab rebase --abort'.",
          "Git did not report conflict paths; the replay may have become unexpectedly empty.",
          result.output ? `Git reported:\n${result.output}` : null,
        ]
          .filter(Boolean)
          .join("\n"),
      },
    );
  }
  const candidates = operation.current.conflicts.reduce(
    (count, conflict) => count + conflict.candidates.length,
    0,
  );
  return new CliError(
    `Causal rebase paused while applying ${change.shortCommit}.`,
    {
      code: "conflict-paused",
      details: [
        result.output,
        `Conflicted paths: ${paths.join(", ")}`,
        candidates
          ? `${candidates} exact prior resolution candidate${candidates === 1 ? "" : "s"} found. Run 'vlab resolve status'.`
          : "No exact prior resolution was found.",
        "Resolve and stage the files, then run 'vlab rebase --continue'.",
        "Run 'vlab rebase --abort' to restore the original branch tip.",
      ].join("\n"),
    },
  );
}

function finalizeRebase(operation, cwd) {
  const [resultCommit, resultTree] = resolveObjectIds(
    ["HEAD^{commit}", "HEAD^{tree}"],
    cwd,
  );
  const predictedTree = operation.forecastApproval?.predictedResultTree;
  if (predictedTree && predictedTree !== resultTree) {
    markMismatch(
      operation,
      `Rebase result does not match forecast '${operation.forecastId}'.`,
      cwd,
      [
        `Forecast tree: ${predictedTree}`,
        `Actual tree:   ${resultTree}`,
        "Abort and generate a new forecast.",
      ].join("\n"),
    );
  }

  // The overlay goes back only after the committed result has verified, and its
  // own prediction is checked before anything is published: a mismatch must
  // leave the operation recoverable by abort rather than half-published.
  //
  // The base of the merge is the tree the source branch held before the rebase
  // started, which the plan already carries, so re-materialization costs no
  // extra repository read. `ours` is the rewritten tip.
  let overlayResult = null;
  if (operation.targetOverlay) {
    const restored = materializeOverlay(
      operation.targetOverlay,
      { baseTree: operation.plan.sourceTree, resultTree },
      cwd,
    );
    if (restored.conflict) {
      markMismatch(
        operation,
        "The caller overlay no longer merges with the rewritten branch.",
        cwd,
        [
          restored.conflict.details,
          "Nothing was published. Run 'vlab rebase --abort' and forecast again.",
        ].join("\n"),
      );
    }
    // The merged draft is on disk from here on, so the worktree is dirty by this
    // operation's own doing. Journaled before the prediction is compared, and
    // written rather than only held in memory, so an abort — after a mismatch or
    // after an interruption in this window — can tell that dirt apart from the
    // user's own and still run. ADR-0028 names abort as the recovery for a
    // re-materialization mismatch, so it has to be reachable from it.
    operation.overlayRematerialized = true;
    writeRebaseState(operation, cwd);
    const predicted = operation.forecastApproval?.predictedOverlayTree ?? null;
    if (predicted && predicted !== restored.tree) {
      markMismatch(
        operation,
        `Re-materializing the caller overlay did not match forecast '${operation.forecastId}'.`,
        cwd,
        [
          `Forecast overlay tree: ${predicted}`,
          `Actual overlay tree:   ${restored.tree}`,
          "Nothing was published. Run 'vlab rebase --abort' and forecast again.",
        ].join("\n"),
      );
    }
    overlayResult = {
      checkpoint: operation.targetOverlay.checkpoint,
      tree: restored.tree,
      predicted,
      rematerialized: true,
    };
  }

  const forkedOrigins = new Set(
    operation.applied
      .filter((application) => application.relation === "contextual-fork")
      .map((application) => application.originCommit),
  );
  // `plan.changes` already excludes every recreated merge, because a merge is
  // not a change (ADR-0034). Nothing here has to subtract them, and nothing may
  // add them back: a receipt that absorbed a join would be claiming the work
  // beneath it.
  const absorbed = operation.plan.changes.filter(
    (change) =>
      !forkedOrigins.has(change.commit) &&
      (change.action !== "review" || operation.acceptCandidates),
  );
  const applications = operation.applied.map((application) => ({
    id: application.id,
    sourceCommit: application.originCommit,
    sourceChangeId: application.originChangeId,
    appliedCommit: application.appliedCommit,
    appliedChangeId: application.appliedChangeId,
    targetBeforeTree: application.targetBeforeTree,
    resultTree: application.resultTree,
    relation: application.relation,
    conflictedPaths: application.conflictedPaths,
    resolutions: application.resolutions,
    semanticMerges: application.semanticMerges,
  }));
  const receipt = {
    schema: "vcs-lab.rebase/v2",
    type: "rebase",
    id: newId("rebase"),
    operationId: operation.id,
    forecastId: operation.forecastId ?? null,
    sourceRef: operation.sourceRef,
    sourceHead: operation.sourceHead,
    ontoRef: operation.ontoRef,
    ontoHead: operation.ontoHead,
    physicalBase: operation.plan.physicalBase,
    effectiveBase: operation.plan.effectiveBase,
    planFingerprint: operation.plan.fingerprint,
    quarantinedFacts: operation.plan.quarantinedFacts ?? [],
    // The range this rebase ran, and the commits the caller declared out of it.
    // A receipt never claims excluded work, so recording the omission beside the
    // range is what makes it auditable rather than invisible (ADR-0032).
    range: operation.plan.range,
    excludedByRange: operation.plan.excludedByRange ?? [],
    acceptCandidates: operation.acceptCandidates,
    candidatePolicy: operation.candidatePolicy,
    omitted: operation.plan.omitted,
    acceptedCandidates: operation.acceptCandidates
      ? operation.plan.candidates.map((candidate) => ({
          ...candidate,
          decision: "omit",
        }))
      : [],
    applications,
    // A join, not a contribution. This entry exists so a reader can audit what
    // the rewrite did to the topology and so provenance can be carried onto the
    // new object; a plan concludes nothing from it, it is not exact evidence
    // under ADR-0004, and it contributes to no coverage class (ADR-0034).
    recreatedMerges: (operation.recreatedMerges ?? []).map((merge) => ({
      originCommit: merge.originCommit,
      originChangeId: merge.originChangeId,
      resultCommit: merge.resultCommit,
      changeId: merge.changeId,
      parents: merge.parents,
      resolutions: merge.resolutions.map((outcome) => ({
        path: outcome.path,
        signature: outcome.signature,
        algorithm: outcome.algorithm,
        // `exact-reused` when a recorded signature supplied the result,
        // `decided` when a person resolved it during the operation.
        origin: outcome.decision === "created" ? "decided" : "exact-reused",
        resolutionId: outcome.selectedResolutionId ?? null,
        resultBlob: outcome.resultBlob ?? null,
      })),
      semanticMerges: merge.semanticMerges,
      cleanJoin: merge.cleanJoin,
      relation: "recreated-merge",
    })),
    forkedSourceCommits: [...forkedOrigins],
    absorbedCommits: absorbed.map((change) => change.commit),
    absorbedChanges: absorbed.map((change) => change.changeId),
    resultCommit,
    sourceTree: operation.plan.sourceTree,
    ontoTree: operation.plan.ontoTree,
    resultTree,
    exactStateEqualityAfter: resultTree === operation.plan.sourceTree,
    timings: {
      activeApplicationMs: Number(
        (operation.timings?.activeApplicationMs ?? 0).toFixed(2),
      ),
      elapsedWallMs: Date.now() - Date.parse(operation.startedAt),
      git: operation.timings?.git ?? null,
    },
    startedAt: operation.startedAt,
    createdAt: new Date().toISOString(),
  };

  // The same non-atomic stretch as the reconciliation publication path, and
  // the same named interruption points (Horizon 2 item 3). A rebase has more
  // at stake: the branch ref has already moved by the time publication starts.
  faultPoint("rebase:before-publish");
  for (const application of operation.applied) {
    for (const outcome of application.resolutions ?? []) {
      publishResolution(outcome, application, cwd);
    }
    appendNote(application.appliedCommit, application, cwd);
    faultPoint("rebase:mid-publish");
  }
  // One read of the notes ref for the whole queue (ADR-0013), as in the
  // reconciliation path.
  carryProvenanceForApplications(operation.applied, cwd);
  // A resolution decided during a recreated merge is an ordinary resolution:
  // the fact that a merge rather than a pick produced the conflict changes
  // nothing about its signature (ADR-0034), so it publishes through the same
  // path and becomes reusable under the same exact rules.
  for (const merge of operation.recreatedMerges ?? []) {
    for (const outcome of merge.resolutions ?? []) {
      publishResolution(
        outcome,
        {
          id: merge.changeId,
          appliedCommit: merge.resultCommit,
          appliedChangeId: merge.changeId,
        },
        cwd,
      );
    }
  }
  faultPoint("rebase:before-receipt");
  appendNote(resultCommit, receipt, cwd);
  releaseAnchors(operation, cwd);
  faultPoint("rebase:before-clear");
  clearRebaseState(cwd);
  return {
    operationId: operation.id,
    plan: operation.plan,
    recreatedMerges: receipt.recreatedMerges,
    receipt,
    // Reported, never published: the overlay is uncommitted context, so it
    // belongs in the command's answer and in no receipt (ADR-0028).
    targetOverlay: overlayResult,
  };
}

function runRebaseQueue(operation, cwd, phaseStarted = performance.now()) {
  const gitMetrics = beginGitMetrics("rebase-application");
  let phaseRecorded = false;
  const finishPhase = (persist) => {
    if (phaseRecorded) return;
    addActiveDuration(operation, phaseStarted);
    accumulateGitMetrics(operation, endGitMetrics(gitMetrics));
    phaseRecorded = true;
    if (persist) writeRebaseState(operation, cwd);
  };
  try {
    while (operation.nextIndex < operation.queue.length) {
      const item = operation.queue[operation.nextIndex];
      const change = item.change ?? item;
      const recreatingMerge = item.kind === "recreate-merge";
      const parents = item.step
        ? resolveStepParents(item.step, operation.ontoHead, rewrittenMap(operation))
        : null;
      if (item.kind === "omit") {
        // The commit collapses out of the rewritten line. Nothing runs and
        // nothing is recorded but the mapping, which a later merge may need.
        anchorRewritten(operation, change.commit, parents[0].commit, cwd);
        operation.nextIndex += 1;
        writeRebaseState(operation, cwd);
        continue;
      }
      // A program with merges jumps between lines, so a step states the parent
      // it applies onto rather than inheriting wherever the last one ended.
      if (parents && currentHead(cwd) !== parents[0].commit) {
        operation.state = "positioning";
        writeRebaseState(operation, cwd);
        runGit(["reset", "--hard", parents[0].commit], { cwd });
      }
      const targetBefore = currentHead(cwd);
      const targetBeforeTree = treeId(targetBefore, cwd);
      operation.state = "applying";
      operation.current = {
        sourceCommit: change.commit,
        sourceChangeId: change.changeId,
        targetBefore,
        targetBeforeTree,
        conflictedPaths: [],
        kind: item.kind,
        ...(recreatingMerge
          ? {
              // Minted and journaled before the commit exists, so an
              // interruption between the two cannot produce a second identity
              // for the same join on resume.
              mergeChangeId: newId("ch"),
              mergeParents: parents.map((parent) => ({
                commit: parent.commit,
                replaces: parent.origin,
                source: parent.source,
              })),
            }
          : {}),
        startedAt: new Date().toISOString(),
      };
      writeRebaseState(operation, cwd);
      const expected = validateForecastBefore(
        operation,
        change,
        targetBeforeTree,
        cwd,
      );

      const result = recreatingMerge
        ? runGit(
            [...GIT_NO_RERERE, "merge", "--no-ff", "--no-commit", parents[1].commit],
            { cwd, allowFailure: true },
          )
        : runGit([...GIT_NO_RERERE, "cherry-pick", "-x", change.commit], {
            cwd,
            allowFailure: true,
          });
      // Both parents became the same line, so the join joins nothing. ADR-0034
      // keeps the existing rule: the operator decides, the machinery does not
      // drop it.
      if (recreatingMerge && result.ok && !pendingMergeHead(cwd)) {
        operation.state = "blocked";
        finishPhase(false);
        writeRebaseState(operation, cwd);
        throw new CliError(
          `Recreating the merge ${change.shortCommit ?? change.commit.slice(0, 12)} would produce no join.`,
          {
            // The existing rule, and the existing code for it: Git could not
            // produce the join, and the operator decides what to do (ADR-0034).
            code: "conflict-blocked",
            details: [
              `Both parents resolved to the same line (${parents[0].commit.slice(0, 12)}).`,
              "Nothing was dropped. Run 'vlab rebase --abort'.",
            ].join("\n"),
          },
        );
      }
      if (result.ok) {
        if (recreatingMerge) {
          commitRecreatedMerge(operation, change, cwd);
          const resultTree = treeId("HEAD", cwd);
          validateForecastAfter(operation, change, resultTree, "clean", cwd);
          recordRecreatedMerge(operation, change, parents, true, cwd);
          continue;
        }
        const resultTree = treeId("HEAD", cwd);
        validateForecastAfter(operation, change, resultTree, "clean", cwd);
        recordSuccessfulApplication(operation, "causal-rebase", cwd);
        continue;
      }

      operation.current.conflictedPaths = unmergedPaths(cwd);
      operation.current.conflicts = captureConflictDescriptors(
        operation.current.conflictedPaths,
        cwd,
      );
      operation.current.gitOutput = result.output;
      operation.state = operation.current.conflictedPaths.length
        ? "conflicted"
        : "blocked";
      if (operation.current.conflictedPaths.length) {
        try {
          if (applyForecastResolutions(operation, change, cwd)) continue;
        } catch (error) {
          if (expected) {
            markMismatch(
              operation,
              `Rebase step for ${change.shortCommit} no longer matches forecast '${operation.forecastId}'.`,
              cwd,
              [error.message, error.details, "Abort and generate a new forecast."]
                .filter(Boolean)
                .join("\n"),
            );
          }
          throw error;
        }
      }
      if (expected) {
        markMismatch(
          operation,
          `Rebase step for ${change.shortCommit} did not reproduce forecast '${operation.forecastId}'.`,
          cwd,
          [result.output, "Abort and generate a new forecast."].filter(Boolean).join("\n"),
        );
      }
      finishPhase(false);
      writeRebaseState(operation, cwd);
      throw conflictError(operation, result);
    }
    finishPhase(false);
    return finalizeRebase(operation, cwd);
  } catch (error) {
    finishPhase(true);
    throw error;
  }
}

function startOperation(branch, ontoRef, plan, options, cwd) {
  const context = repoContext(cwd);
  const forecast = options.forecast;
  return {
    schema: "vcs-lab.rebase-operation/v2",
    id: newId("rebase_op"),
    state: "prepared",
    worktree: context.root,
    sourceRef: branch.name,
    sourceBranchRef: branch.ref,
    sourceHead: plan.sourceHead,
    originalHead: plan.sourceHead,
    ontoRef,
    ontoHead: plan.ontoHead,
    acceptCandidates: Boolean(options.acceptCandidates),
    candidatePolicy:
      plan.candidates.length === 0
        ? "none"
        : options.acceptCandidates
          ? "accepted"
          : "review-required",
    forecastId: forecast?.id ?? null,
    forecastApproval: forecast
      ? {
          id: forecast.id,
          planFingerprint: forecast.planFingerprint,
          steps: forecast.steps,
          approvedResolutions: forecast.approvedResolutions ?? [],
          approvedSpecMerges: forecast.approvedSpecMerges ?? [],
          acceptedCandidates: forecast.acceptedCandidates ?? [],
          predictedResultTree: forecast.predictedResultTree,
          predictedOverlayTree: forecast.predictedOverlayTree ?? null,
        }
      : null,
    // Recorded so an abort can put the captured worktree back, and so a resumed
    // operation in a new process knows an overlay is in play (ADR-0028).
    targetOverlay: forecast?.targetOverlay ?? null,
    plan,
    // Every step of the rewrite, in the order it runs. For a linear range this
    // is the replay queue it has always been; for a merge-preserving one it
    // also carries the recreated merges and the commits that collapse out
    // (ADR-0034), so the parent mapping can be rebuilt after an interruption.
    queue: rebaseProgram(plan),
    nextIndex: 0,
    // Advances only on a step that ran, because a forecast has no entry for a
    // commit nothing replayed.
    executedCount: 0,
    // Original commit to the commit that replaced it, as a plain object so the
    // journal round-trips through JSON.
    rewritten: {},
    recreatedMerges: [],
    applied: [],
    current: null,
    startedAt: new Date().toISOString(),
    timings: {
      activeApplicationMs: 0,
      git: {
        count: 0,
        processes: 0,
        sessionQueries: 0,
        cacheHits: 0,
        totalMs: 0,
        failed: 0,
        byCommand: [],
      },
    },
    updatedAt: new Date().toISOString(),
  };
}

function startRebaseInSession(ontoRef, options, cwd) {
  if (readReconciliationState(cwd) || readRebaseState(cwd)) {
    throw new CliError(
      "A VCS Lab operation is already in progress in this worktree.",
        { code: "operation-in-progress" },
    );
  }
  // A forecast carrying an overlay expects a dirty worktree: the overlay *is* the
  // uncommitted work. The clean check is replaced by a stricter one — the live
  // tree must equal the overlay tree exactly — so "dirty" can never mean
  // "whatever happens to be there" (ADR-0028).
  const approvedOverlay = options.forecastId
    ? readRebaseForecast(options.forecastId, cwd)?.targetOverlay ?? null
    : null;
  if (!approvedOverlay) assertClean(cwd);
  assertNoGitReplay(cwd);
  const branch = currentBranch(cwd);
  const plan = buildRebasePlan(ontoRef, branch.name, cwd, { from: options.from });
  if (!plan.constraints.supported) throw unsupportedTopologyError(plan.topology);
  const forecast = options.forecastId
    ? rebaseForecastForPlan(options.forecastId, plan, cwd)
    : null;
  if (approvedOverlay) {
    // Refuses before anything moves: a drifted worktree is `stale-overlay` and a
    // moved base head or missing checkpoint is `stale-forecast`.
    assertOverlayCurrent(approvedOverlay, cwd);
  }
  const acceptCandidates = Boolean(
    options.acceptCandidates || forecast?.acceptCandidates,
  );
  if (plan.candidates.length && !acceptCandidates) {
    throw new CliError(
      "The rebase plan contains heuristic patch-equivalence candidates.",
      {
        code: "approval-required",
        details:
          "Review 'vlab rebase-plan' and rerun with --accept-candidates, or use a complete reviewed rebase forecast.",
      },
    );
  }

  const operation = startOperation(
    branch,
    ontoRef,
    plan,
    { ...options, acceptCandidates, forecast },
    cwd,
  );
  writeRebaseState(operation, cwd);
  if (approvedOverlay) {
    // The overlay is safe in its checkpoint, so the worktree can be reduced to
    // the committed head and the queue runs exactly as it does without one. This
    // has to happen before the reset onto the new base: that reset would discard
    // the overlay's tracked edits and leave its untracked files stranded in a
    // worktree they no longer belong to.
    operation.state = "reducing-overlay";
    writeRebaseState(operation, cwd);
    reduceToCommittedHead(approvedOverlay, cwd);
  }
  operation.state = "resetting";
  writeRebaseState(operation, cwd);
  runGit(["reset", "--hard", plan.ontoHead], { cwd });
  operation.state = "running";
  writeRebaseState(operation, cwd);
  return runRebaseQueue(operation, cwd, performance.now());
}

export function startRebase(ontoRef, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  return withGitObjectSession(cwd, () =>
    startRebaseInSession(ontoRef, options, cwd),
  );
}

export function rebaseStatus(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const operation = readRebaseState(cwd);
  if (!operation) return { active: false, state: "idle" };
  const actualBranchRef = symbolicRef("HEAD", cwd);
  const actualHead = currentHead(cwd);
  return {
    active: true,
    operationId: operation.id,
    state: operation.state,
    worktree: operation.worktree,
    sourceRef: operation.sourceRef,
    sourceHead: operation.sourceHead,
    sourceBranchRef: operation.sourceBranchRef,
    ontoRef: operation.ontoRef,
    ontoHead: operation.ontoHead,
    forecastId: operation.forecastId ?? null,
    progress: {
      // Counted over the steps that run. A merge-preserving program also carries
      // the commits that collapse out, and reporting those as remaining work
      // would say there is more to do than there is.
      completed: operation.executedCount ?? operation.nextIndex,
      total: executableSteps(operation).length,
      remaining: executableSteps(operation).filter(
        (_, index) => index >= (operation.executedCount ?? operation.nextIndex),
      ).length,
    },
    current: operation.current
      ? {
          ...operation.current,
          gitCherryPickHead: cherryPickHead(cwd),
          unresolvedPaths: unmergedPaths(cwd),
        }
      : null,
    applied: operation.applied,
    // Joins, never applications: listed separately so a reader of a paused
    // operation can audit the topology without mistaking one for coverage
    // (ADR-0034).
    recreatedMerges: operation.recreatedMerges ?? [],
    recovery: {
      expectedBranchRef: operation.sourceBranchRef,
      actualBranchRef,
      actualHead,
      originalHead: operation.originalHead,
      branchMatches: actualBranchRef === operation.sourceBranchRef,
    },
    timings: operation.timings,
    startedAt: operation.startedAt,
    updatedAt: operation.updatedAt,
  };
}

function forkMergeMessage(operation, cwd) {
  const current = operation.current;
  if (!current.forkChangeId) current.forkChangeId = newId("ch");
  const filePath = mergeMessagePath(cwd);
  const original = fs.readFileSync(filePath, "utf8");
  const retained = original
    .split(/\r?\n/)
    .filter((line) => !/^Change-Id:\s*/i.test(line))
    .join("\n")
    .trimEnd();
  const trailers = [
    `Change-Id: ${current.forkChangeId}`,
    `Derived-From: ${current.sourceChangeId}`,
    `Origin-Commit: ${current.sourceCommit}`,
  ];
  fs.writeFileSync(filePath, `${retained}\n\n${trailers.join("\n")}\n`);
  writeRebaseState(operation, cwd);
}

function continueRebaseInSession(options, cwd) {
  const phaseStarted = performance.now();
  const operation = requirePendingRebase(cwd);
  assertCurrentSpecDecisions(operation);
  requireOperationBranch(operation, cwd);
  if (operation.state !== "conflicted" || !operation.current) {
    throw new CliError(
      `Rebase state '${operation.state}' cannot be continued.`,
      { code: "operation-state-invalid", details: "Only a resolved conflict can continue; abort other blocked states." },
    );
  }
  const unresolved = unmergedPaths(cwd);
  if (unresolved.length) {
    throw new CliError("Causal rebase still has unresolved paths.", {
      code: "conflict-blocked",
      details: unresolved.join("\n"),
    });
  }
  const recreatingMerge = operation.current.kind === "recreate-merge";
  if (recreatingMerge) {
    // A recreated merge is pending as a merge, and what identifies it is the
    // side it is joining — there is no `CHERRY_PICK_HEAD` naming a source
    // commit, because no commit is being applied (ADR-0034).
    const joined = pendingMergeHead(cwd);
    const expected = operation.current.mergeParents?.[1]?.commit;
    if (!joined || joined !== expected) {
      throw new CliError(
        "Git's pending merge does not match the causal rebase journal.",
        {
          code: "out-of-band-change",
          details: "Abort the VCS Lab rebase to restore the original branch tip.",
        },
      );
    }
  } else {
    const gitHead = cherryPickHead(cwd);
    if (!gitHead || gitHead !== operation.current.sourceCommit) {
      throw new CliError(
        "Git's pending cherry-pick does not match the causal rebase journal.",
        { code: "out-of-band-change", details: "Abort the VCS Lab rebase to restore the original branch tip." },
      );
    }
  }

  operation.current.semanticMerges = captureSpecMergeOutcomes(
    operation.current.semanticMerges ?? [],
    cwd,
  );
  const semanticallyResolved = new Set(
    operation.current.semanticMerges.flatMap(
      (merge) => merge.resolvedPaths ?? [],
    ),
  );
  operation.current.resolutionOutcomes = captureResolutionOutcomes(
    operation.current.conflicts.filter(
      (conflict) => !semanticallyResolved.has(conflict.path),
    ),
    cwd,
  );
  writeRebaseState(operation, cwd);
  if (recreatingMerge) {
    // A recreated merge already has a new identity by contract, so there is no
    // fork to declare: `--fork` is the answer to "this pick diverged from the
    // change it claims to be", and a join claims to be nothing.
    if (options.fork) {
      throw new CliError(
        "A recreated merge cannot be forked; it already takes a new identity.",
        {
          // The state, not the flag: `--fork` is a legal option of this command
          // and the pending step is what cannot take it.
          code: "operation-state-invalid",
          details: "Continue without --fork. See ADR-0034 for why a join claims nothing.",
        },
      );
    }
    const queued = operation.queue[operation.nextIndex];
    commitRecreatedMerge(operation, queued.change ?? queued, cwd);
    recordRecreatedMerge(
      operation,
      queued.change ?? queued,
      operation.current.mergeParents.map((parent) => ({
        commit: parent.commit,
        origin: parent.replaces,
        source: parent.source,
      })),
      false,
      cwd,
    );
    return runRebaseQueue(operation, cwd, phaseStarted);
  }
  if (options.fork || operation.current.forkChangeId) {
    forkMergeMessage(operation, cwd);
  }
  const result = runGit(
    [...GIT_NO_RERERE, "-c", "core.editor=true", "cherry-pick", "--continue"],
    { cwd, allowFailure: true },
  );
  if (!result.ok) {
    throw new CliError("Git could not continue the causal rebase.", {
      code: "conflict-blocked",
      details: result.output,
    });
  }
  const relation = operation.current.forkChangeId
    ? "contextual-fork"
    : "contextual-rebase";
  recordSuccessfulApplication(operation, relation, cwd);
  return runRebaseQueue(operation, cwd, phaseStarted);
}

export function continueRebase(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  return withGitObjectSession(cwd, () =>
    continueRebaseInSession(options, cwd),
  );
}

export function abortRebase(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const operation = requirePendingRebase(cwd);
  requireOperationBranch(operation, cwd);
  if (cherryPickHead(cwd)) {
    runGit(["cherry-pick", "--abort"], { cwd });
  } else if (pendingMergeHead(cwd)) {
    // A recreated merge is pending, so the dirt is this operation's own join.
    runGit(["merge", "--abort"], { cwd });
  } else if (!operation.overlayRematerialized) {
    // Skipped only once the journal says this operation put the overlay back
    // itself. The clean check exists to protect the user's own edits, and in
    // that one state the dirt is the merged draft this operation wrote — which
    // abort is about to replace with the captured version anyway.
    assertClean(cwd);
  }
  if (currentHead(cwd) !== operation.originalHead) {
    runGit(["reset", "--hard", operation.originalHead], { cwd });
  }
  const restoredHead = currentHead(cwd);
  if (restoredHead !== operation.originalHead) {
    throw new CliError("Causal rebase abort did not restore the original tip.",
      { code: "internal-invariant" });
  }
  // The committed tip is restored first and unconditionally; the overlay is put
  // back afterwards, so a draft that cannot be recovered never costs the tip
  // (ADR-0028).
  const overlay = operation.targetOverlay
    ? restoreOverlayAfterAbort(operation.targetOverlay, cwd)
    : null;
  // Released only once the tip is restored: until then these refs are the only
  // thing naming a partially rewritten line, and a person recovering by hand
  // needs them more than this operation does.
  releaseAnchors(operation, cwd);
  faultPoint("rebase:abort-before-clear");
  clearRebaseState(cwd);
  return {
    aborted: true,
    operationId: operation.id,
    sourceRef: operation.sourceRef,
    restoredHead,
    overlay,
  };
}
