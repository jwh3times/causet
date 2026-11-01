import fs from "node:fs";
import { performance } from "node:perf_hooks";
import {
  beginGitMetrics,
  endGitMetrics,
  extractTrailer,
  GIT_NO_RERERE,
  runGit,
  withGitObjectSession,
} from "./git.js";
import {
  assertClean,
  changeIdForCommit,
  commitHistory,
  commitMessage,
  commitSubject,
  currentHead,
  findCommitsByChangeId,
  repoContext,
  resolveObjectIds,
  resolveRevision,
  symbolicRef,
} from "./engine.js";
import { newId } from "./ids.js";
import {
  appendNote, listNoteRecords, recordsReachableFrom, withNotesLock,
} from "./notes.js";
import { acceptedCausalRecords } from "./metadata.js";
import { identityPreservingEdges } from "./identity-audit.js";
import { faultPoint } from "./faults.js";
import {
  carryProvenanceForApplications,
  carryProvenanceSafely,
  declareProvenance,
} from "./provenance.js";
import { buildMergePlan } from "./merge-plan.js";
import { CliError } from "./errors.js";
import {
  cherryPickHead,
  clearReconciliationState,
  mergeMessagePath,
  readReconciliationState,
  unmergedPaths,
  writeReconciliationState,
} from "./reconcile-state.js";
import { readRebaseState } from "./rebase-state.js";
import {
  captureConflictDescriptors,
  captureResolutionOutcomes,
  materializeResolutionCandidate,
  publishResolution,
} from "./resolutions.js";
import { forecastForPlan } from "./forecasts.js";
import {
  captureSpecMergeOutcomes,
  compactSpecMerge,
  materializeSpecMerge,
  specMergePlansForOperation,
} from "./specs.js";

function resolveChangeOrCommit(value, cwd) {
  if (!value.startsWith("ch_")) return resolveRevision(value, cwd);
  const bearers = findCommitsByChangeId(value, cwd);
  if (bearers.length === 0) {
    throw new CliError(`No commit with Change-Id '${value}' was found.`,
      { code: "revision-not-resolved" });
  }
  return originOfChange(bearers, cwd);
}

/**
 * The commit a `ch_*` argument names when several commits carry the id: the
 * logical change's origin under the identity model FR-ID-06 audits, which is
 * the bearer no identity-preserving application record names as its applied
 * commit. When the records single out no bearer, because none exist or the
 * origin is no longer reachable, the earliest bearer stands in, in the order
 * `findCommitsByChangeId` states. Every bearer is an exact copy under
 * FR-ID-02, so the tree applied is the same whichever is named; what this
 * fixes is the `originCommit` a record carries, and the provenance carried
 * from it, which used to be whichever bearer `git log` listed first
 * (docs/identity/README.md §5).
 */
function originOfChange(bearers, cwd) {
  if (bearers.length === 1) return bearers[0];
  const applied = new Set(
    identityPreservingEdges(listNoteRecords(cwd)).map((edge) => edge.applied),
  );
  const origins = bearers.filter((commit) => !applied.has(commit));
  return (origins.length > 0 ? origins : bearers)[0];
}

function targetCoversChange(originCommit, originChangeId, targetHead, cwd) {
  const history = commitHistory([targetHead], cwd);
  for (const { commit, message } of history) {
    if (commit === originCommit || extractTrailer(message, "Change-Id") === originChangeId) {
      return true;
    }
    for (const match of message.matchAll(/^Absorbs:\s*(\S+)/gim)) {
      if (match[1] === originChangeId) return true;
    }
  }

  // A stock Git commit has no stable trailer to copy. Its exact application
  // still records continuity, but only a validated record attached to the
  // target's reachable history can establish it. Reuse the identity model's
  // same-ID edges; forks and unknown relations cannot prove coverage.
  const relations = new Set([
    "same-logical-change", "causal-reconciliation", "contextual-application",
    "causal-rebase", "contextual-rebase",
  ]);
  const applications = recordsReachableFrom(targetHead, cwd, history.map((item) => item.commit))
    .filter((record) => record.originCommit === originCommit
      && record.originChangeId === originChangeId
      && relations.has(record.relation));
  return applications.length > 0
    && identityPreservingEdges(acceptedCausalRecords(applications, cwd)).length > 0;
}

export function cherryPick(value, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  assertClean(cwd);
  const originCommit = resolveChangeOrCommit(value, cwd);
  const originChangeId = changeIdForCommit(originCommit, cwd);
  const targetBefore = currentHead(cwd);
  if (!options.repeat && targetCoversChange(originCommit, originChangeId, targetBefore, cwd)) {
    return {
      noOp: true,
      reason: "target-already-covers-change-id",
      originCommit,
      originChangeId,
      targetBefore,
    };
  }

  let appliedCommit;
  let appliedChangeId = originChangeId;
  if (options.fork) {
    const picked = runGit(
      [...GIT_NO_RERERE, "cherry-pick", "--no-commit", originCommit],
      { cwd, allowFailure: true },
    );
    if (!picked.ok) {
      throw new CliError("Cherry-pick produced conflicts.", { code: "conflict-blocked", details: picked.output });
    }
    appliedChangeId = newId("ch");
    const originalSubject = commitSubject(originCommit, cwd);
    const message = [
      originalSubject,
      "",
      `Change-Id: ${appliedChangeId}`,
      `Derived-From: ${originChangeId}`,
      `Origin-Commit: ${originCommit}`,
    ].join("\n");
    runGit(["commit", "-m", message], { cwd });
    appliedCommit = currentHead(cwd);
  } else {
    const picked = runGit([...GIT_NO_RERERE, "cherry-pick", "-x", originCommit], {
      cwd,
      allowFailure: true,
    });
    if (!picked.ok) {
      throw new CliError("Cherry-pick produced conflicts.", { code: "conflict-blocked", details: picked.output });
    }
    appliedCommit = currentHead(cwd);
  }

  const application = {
    schema: "vcs-lab.application/v1",
    type: "application",
    id: newId("apply"),
    originCommit,
    originChangeId,
    appliedCommit,
    appliedChangeId,
    targetBefore,
    relation: options.fork ? "derived-fork" : "same-logical-change",
    createdAt: new Date().toISOString(),
  };
  appendNote(appliedCommit, application, cwd);
  // A cherry-pick is a rewrite that produces new content from a known origin,
  // so the origin's declared provenance carries onto the result. The recorded
  // origin/applied correspondence is what makes this exact rather than a diff
  // heuristic (FR-ID-08).
  // Side effect only: `application` is a `vcs-lab.application/v1` document and
  // the carried provenance is a separate record on the same commit.
  carryProvenanceSafely([originCommit], appliedCommit, appliedChangeId, cwd);
  return application;
}

function requirePendingReconciliation(cwd) {
  const operation = readReconciliationState(cwd);
  if (!operation) {
    throw new CliError("No reconciliation is in progress in this worktree.",
      { code: "no-operation-pending" });
  }
  return operation;
}

function branchLabel(ref) {
  if (!ref) return "a detached HEAD";
  return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
}

/**
 * Refuse to continue or abort a reconciliation from a worktree that is no
 * longer on the branch the operation started on. Abort restores
 * `targetBefore` with `reset --hard`, which moves whatever branch HEAD points
 * at; without this guard a `git checkout -f other` between the pause and the
 * abort would reset `other` to the target's old tip and strand its commits in
 * the reflog. The rebase path has had the same guard from the start.
 *
 * A journal written before `targetBranchRef` existed cannot answer the
 * question, so it is trusted only while Git's own sequencer still holds the
 * pick the journal is paused on: a checkout that discarded the conflict also
 * removed `CHERRY_PICK_HEAD`, so that shape is the one to refuse.
 */
function requireReconciliationBranch(operation, cwd) {
  const actualRef = symbolicRef("HEAD", cwd);
  if (Object.hasOwn(operation, "targetBranchRef")) {
    if (actualRef === operation.targetBranchRef) return actualRef;
    throw new CliError(
      `The reconciliation journal belongs to ${
        operation.targetBranchRef ? `branch '${branchLabel(operation.targetBranchRef)}'` : "a detached HEAD"
      }, not ${operation.targetBranchRef && actualRef ? `'${branchLabel(actualRef)}'` : branchLabel(actualRef)}.`,
      {
        code: "out-of-band-change",
        details: `Switch back to ${
          operation.targetBranchRef ? `'${branchLabel(operation.targetBranchRef)}'` : "the detached HEAD the operation started on"
        } before continuing or aborting the reconciliation.`,
      },
    );
  }
  const pending = cherryPickHead(cwd);
  if (pending && pending === operation.current?.sourceCommit) return actualRef;
  throw new CliError(
    "The reconciliation journal does not record its branch, and Git holds no matching cherry-pick.",
    {
      code: "out-of-band-change",
      details: [
        "The journal predates the branch record, so vlab cannot prove this worktree is still on the branch the reconciliation started on.",
        `Restore it by hand if needed: git reset --hard ${operation.targetBefore} on that branch, then remove the journal file.`,
      ].join("\n"),
    },
  );
}

function applicationRecord(
  operation,
  change,
  appliedCommit,
  sourceTree,
  resultTree,
  relation,
  cwd,
) {
  return {
    schema: "vcs-lab.application/v4",
    type: "application",
    id: newId("apply"),
    reconciliationOperation: operation.id,
    originCommit: change.commit,
    originChangeId: change.changeId,
    appliedCommit,
    appliedChangeId:
      relation === "contextual-fork"
        ? changeIdForCommit(appliedCommit, cwd)
        : change.changeId,
    targetBefore: operation.current.targetBefore,
    sourceTree,
    resultTree,
    relation,
    forecastId: operation.forecastId ?? null,
    conflictedPaths: operation.current.conflictedPaths ?? [],
    resolutions: operation.current.resolutionOutcomes ?? [],
    semanticMerges: operation.current.semanticMerges ?? [],
    createdAt: new Date().toISOString(),
  };
}

function recordSuccessfulApplication(operation, relation, cwd) {
  const change = operation.queue[operation.nextIndex];
  const [appliedCommit, sourceTree, resultTree] = resolveObjectIds(
    ["HEAD", `${change.commit}^{tree}`, "HEAD^{tree}"],
    cwd,
  );
  const application = applicationRecord(
    operation,
    change,
    appliedCommit,
    sourceTree,
    resultTree,
    relation,
    cwd,
  );
  operation.applied.push(application);
  operation.nextIndex += 1;
  operation.current = null;
  operation.state = "running";
  faultPoint("reconcile:before-journal-advance");
  writeReconciliationState(operation, cwd);
  return application;
}

function finalizeReconciliation(operation, cwd) {
  const [attachedTo, resultTree] = resolveObjectIds(
    ["HEAD^{commit}", "HEAD^{tree}"],
    cwd,
  );
  const predictedTree = operation.forecastApproval?.predictedResultTree;
  if (predictedTree && predictedTree !== resultTree) {
    operation.state = "forecast-mismatch";
    writeReconciliationState(operation, cwd);
    throw new CliError(
      `Reconciliation result does not match forecast '${operation.forecastId}'.`,
      {
        code: "stale-forecast",
        details: [
          `Forecast tree: ${predictedTree}`,
          `Actual tree:   ${resultTree}`,
          "Run 'vlab reconcile --abort' and generate a new forecast.",
        ].join("\n"),
      },
    );
  }
  const forkedOrigins = new Set(
    operation.applied
      .filter((application) => application.relation === "contextual-fork")
      .map((application) => application.originCommit),
  );
  const covered = operation.plan.changes.filter(
    (change) =>
      !forkedOrigins.has(change.commit) &&
      (change.status !== "candidate-equivalent" || operation.acceptCandidates),
  );
  const applied = operation.applied.map((application) => ({
    sourceCommit: application.originCommit,
    appliedCommit: application.appliedCommit,
    changeId: application.appliedChangeId,
    relation: application.relation,
    conflictedPaths: application.conflictedPaths,
    resolutions: application.resolutions,
    semanticMerges: application.semanticMerges,
  }));
  const receipt = {
    schema: "vcs-lab.reconciliation/v6",
    type: "reconciliation",
    id: newId("reconcile"),
    operationId: operation.id,
    forecastId: operation.forecastId ?? null,
    sourceRef: operation.sourceRef,
    sourceHead: operation.sourceHead,
    targetBefore: operation.targetBefore,
    resultCommit: attachedTo,
    absorbedCommits: covered.map((change) => change.commit),
    absorbedChanges: covered.map((change) => change.changeId),
    applied,
    forkedSourceCommits: [...forkedOrigins],
    targetTreeBefore: operation.plan.targetTree,
    sourceTree: operation.plan.sourceTree,
    resultTree,
    exactStateEqualityBefore: operation.plan.exactStateEquality,
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

  // Publication is the one stretch that is not a single atomic act: several
  // notes and refs move in sequence. These are the points where an
  // interruption would be most damaging, named so the failure-boundary tests
  // can stop the process at each and inspect what survived (Horizon 2 item 3).
  faultPoint("reconcile:before-publish");
  for (const application of operation.applied) {
    for (const outcome of application.resolutions ?? []) {
      publishResolution(outcome, application, cwd);
    }
    appendNote(application.appliedCommit, application, cwd);
    faultPoint("reconcile:mid-publish");
  }
  // One read of the notes ref for the whole queue rather than one per
  // application (ADR-0013). Carried after the loop, so an interruption inside
  // it leaves the same journal state the failure-boundary tests already pin.
  carryProvenanceForApplications(operation.applied, cwd);
  faultPoint("reconcile:before-receipt");
  appendNote(attachedTo, receipt, cwd);
  faultPoint("reconcile:before-clear");
  clearReconciliationState(cwd);
  return { operationId: operation.id, plan: operation.plan, receipt };
}

function conflictError(operation, result, cwd) {
  const change = operation.queue[operation.nextIndex];
  const paths = operation.current.conflictedPaths;
  const pathSummary = paths.length
    ? `\nConflicted paths: ${paths.join(", ")}`
    : "";
  const suggestionCount = (operation.current.conflicts ?? []).reduce(
    (count, conflict) => count + conflict.candidates.length,
    0,
  );
  const suggestion = suggestionCount
    ? `${suggestionCount} prior resolution candidate${suggestionCount === 1 ? "" : "s"} found. Run 'vlab resolve status'.`
    : "No exact prior resolution was found.";
  let specSuggestion = null;
  try {
    const semantic = specMergePlansForOperation(operation, cwd).filter(
      (plan) => plan.status === "clean",
    );
    if (semantic.length) {
      specSuggestion = `${semantic.length} deterministic spec merge${semantic.length === 1 ? "" : "s"} available. Run 'vlab spec status'.`;
    }
  } catch {
    // An ordinary conflict remains actionable even if semantic metadata is stale.
  }
  return new CliError(
    `Reconciliation paused while applying ${change.shortCommit}.`,
    {
      code: "conflict-paused",
      details: [
        result.output,
        pathSummary,
        suggestion,
        specSuggestion,
        "Resolve and stage the files, then run 'vlab reconcile --continue'.",
        "Run 'vlab reconcile --status' for details or 'vlab reconcile --abort' to restore the starting state.",
      ]
        .filter(Boolean)
        .join("\n"),
    },
  );
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
      .sort((left, right) => right.totalMs - left.totalMs),
  };
}

function forecastResolutionChoices(operation, change, conflicts) {
  if (!operation.forecastApproval) return null;
  const approvals = operation.forecastApproval.approvedResolutions.filter(
    (approval) => approval.sourceCommit === change.commit,
  );
  if (approvals.length === 0) return null;
  if (approvals.length !== conflicts.length) {
    throw new CliError(
      `Forecast '${operation.forecastId}' no longer matches the current conflicts.`,
      { code: "stale-forecast", details: "Abort and generate a new forecast before batch application." },
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
        `Forecast '${operation.forecastId}' no longer matches '${conflict.path}'.`,
        { code: "stale-forecast", details: "Abort and generate a new forecast before batch application." },
      );
    }
    return { conflict, candidate };
  });
}

function forecastSpecMergeChoices(operation, change, cwd) {
  if (!operation.forecastApproval) return [];
  const approvals = (operation.forecastApproval.approvedSpecMerges ?? []).filter(
    (approval) => approval.sourceCommit === change.commit,
  );
  if (approvals.length === 0) return [];
  const plans = specMergePlansForOperation(operation, cwd).filter(
    (plan) => plan.status === "clean",
  );
  if (plans.length !== approvals.length) {
    throw new CliError(
      `Forecast '${operation.forecastId}' no longer matches the semantic spec conflicts.`,
      { code: "stale-forecast", details: "Abort and generate a new forecast before batch application." },
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
        `Forecast '${operation.forecastId}' no longer matches '${approval.path}'.`,
        { code: "stale-forecast", details: "Abort and generate a new forecast before batch application." },
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
  const exactConflicts = (operation.current.conflicts ?? []).filter(
    (conflict) => !semanticallyResolved.has(conflict.path),
  );
  const choices = forecastResolutionChoices(
    operation,
    change,
    exactConflicts,
  );
  if (!choices && specChoices.length === 0) return false;
  if (!choices && exactConflicts.length > 0) return false;

  const semanticMerges = specChoices.map((plan) => {
    materializeSpecMerge(plan, cwd);
    return compactSpecMerge(plan, "forecast-batch");
  });
  operation.current.semanticMerges = captureSpecMergeOutcomes(
    semanticMerges,
    cwd,
  );
  if (operation.current.semanticMerges.some((merge) => merge.decision !== "accepted")) {
    throw new CliError("A forecasted semantic spec result changed while staging.",
      { code: "stale-input" });
  }
  for (const { conflict, candidate } of choices ?? []) {
    materializeResolutionCandidate(conflict, candidate, cwd);
    conflict.selectedResolutionId = candidate.id;
    conflict.decisionOverride = null;
    conflict.selectionMethod = "forecast-batch";
    conflict.suggestionAppliedAt = new Date().toISOString();
  }
  operation.current.resolutionOutcomes = captureResolutionOutcomes(
    exactConflicts,
    cwd,
  );
  writeReconciliationState(operation, cwd);
  const continued = runGit(
    [...GIT_NO_RERERE, "-c", "core.editor=true", "cherry-pick", "--continue"],
    { cwd, allowFailure: true },
  );
  if (!continued.ok) {
    throw new CliError("Git could not apply the forecasted resolutions.", {
      code: "conflict-blocked",
      details: continued.output,
    });
  }
  recordSuccessfulApplication(operation, "contextual-application", cwd);
  return true;
}

function runReconciliationQueue(operation, cwd, phaseStarted = performance.now()) {
  const gitMetrics = beginGitMetrics("reconciliation-application");
  let phaseRecorded = false;
  const finishPhase = (persist) => {
    if (phaseRecorded) return;
    addActiveDuration(operation, phaseStarted);
    accumulateGitMetrics(operation, endGitMetrics(gitMetrics));
    phaseRecorded = true;
    if (persist) writeReconciliationState(operation, cwd);
  };
  try {
    while (operation.nextIndex < operation.queue.length) {
      const change = operation.queue[operation.nextIndex];
      operation.state = "applying";
      operation.current = {
        sourceCommit: change.commit,
        sourceChangeId: change.changeId,
        targetBefore: currentHead(cwd),
        conflictedPaths: [],
        startedAt: new Date().toISOString(),
      };
      writeReconciliationState(operation, cwd);

      const result = runGit([...GIT_NO_RERERE, "cherry-pick", "-x", change.commit], {
        cwd,
        allowFailure: true,
      });
      if (!result.ok) {
        operation.current.conflictedPaths = unmergedPaths(cwd);
        operation.current.conflicts = captureConflictDescriptors(
          operation.current.conflictedPaths,
          cwd,
        );
        operation.current.gitOutput = result.output;
        operation.state = operation.current.conflictedPaths.length
          ? "conflicted"
          : "blocked";
        if (
          operation.current.conflictedPaths.length &&
          applyForecastResolutions(operation, change, cwd)
        ) {
          continue;
        }
        finishPhase(false);
        writeReconciliationState(operation, cwd);
        throw conflictError(operation, result, cwd);
      }
      recordSuccessfulApplication(operation, "causal-reconciliation", cwd);
    }
    finishPhase(false);
    return finalizeReconciliation(operation, cwd);
  } catch (error) {
    finishPhase(true);
    throw error;
  }
}

function startOperation(sourceRef, plan, options, cwd) {
  const context = repoContext(cwd);
  return {
    schema: "vcs-lab.reconciliation-operation/v4",
    id: newId("reconcile_op"),
    state: "running",
    worktree: context.root,
    sourceRef,
    sourceHead: plan.sourceHead,
    targetBefore: plan.targetHead,
    targetBranchRef: symbolicRef("HEAD", cwd),
    acceptCandidates: Boolean(options.acceptCandidates),
    forecastId: options.forecast?.id ?? null,
    forecastApproval: options.forecast
      ? {
          id: options.forecast.id,
          planFingerprint: options.forecast.planFingerprint,
          approvedResolutions: options.forecast.approvedResolutions ?? [],
          approvedSpecMerges: options.forecast.approvedSpecMerges ?? [],
          status: options.forecast.status,
          predictedResultTree: options.forecast.predictedResultTree,
        }
      : null,
    plan,
    queue: plan.changes.filter((change) => change.status === "new"),
    nextIndex: 0,
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

function reconcileInSession(sourceRef, options, cwd) {
  if (readReconciliationState(cwd) || readRebaseState(cwd)) {
    throw new CliError(
      "A VCS Lab operation is already in progress in this worktree.",
      { code: "operation-in-progress", details: "Inspect the active reconciliation or rebase before starting another operation." },
    );
  }
  assertClean(cwd);
  const plan = buildMergePlan(sourceRef, cwd);
  const forecast = options.forecastId
    ? forecastForPlan(options.forecastId, plan, cwd)
    : null;
  const acceptCandidates = Boolean(
    options.acceptCandidates || forecast?.acceptCandidates,
  );
  const candidates = plan.changes.filter(
    (change) => change.status === "candidate-equivalent",
  );
  if (candidates.length && !acceptCandidates) {
    throw new CliError(
      "The plan contains heuristic patch-equivalence candidates.",
      {
        code: "approval-required",
        details:
          "Review 'vlab merge-plan' and rerun with --accept-candidates to treat them as already applied.",
      },
    );
  }

  const operation = startOperation(
    sourceRef,
    plan,
    { ...options, acceptCandidates, forecast },
    cwd,
  );
  writeReconciliationState(operation, cwd);
  return runReconciliationQueue(operation, cwd, performance.now());
}

export function reconcile(sourceRef, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  return withGitObjectSession(cwd, () =>
    reconcileInSession(sourceRef, options, cwd),
  );
}

export function reconciliationStatus(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const operation = readReconciliationState(cwd);
  if (!operation) return { active: false, state: "idle" };
  const actualBranchRef = symbolicRef("HEAD", cwd);
  return {
    active: true,
    operationId: operation.id,
    state: operation.state,
    worktree: operation.worktree,
    sourceRef: operation.sourceRef,
    sourceHead: operation.sourceHead,
    targetBefore: operation.targetBefore,
    targetBranchRef: operation.targetBranchRef ?? null,
    forecastId: operation.forecastId ?? null,
    recovery: {
      expectedBranchRef: operation.targetBranchRef ?? null,
      actualBranchRef,
      actualHead: currentHead(cwd),
      targetBefore: operation.targetBefore,
      branchMatches: Object.hasOwn(operation, "targetBranchRef")
        ? actualBranchRef === operation.targetBranchRef
        : null,
    },
    progress: {
      completed: operation.nextIndex,
      total: operation.queue.length,
      remaining: operation.queue.length - operation.nextIndex,
    },
    current: operation.current
      ? {
          ...operation.current,
          gitCherryPickHead: cherryPickHead(cwd),
          unresolvedPaths: unmergedPaths(cwd),
        }
      : null,
    applied: operation.applied,
    timings: operation.timings ?? null,
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
  writeReconciliationState(operation, cwd);
}

function continueReconciliationInSession(options, cwd) {
  const phaseStarted = performance.now();
  const operation = requirePendingReconciliation(cwd);
  requireReconciliationBranch(operation, cwd);
  if (!operation.current) {
    throw new CliError("The pending reconciliation has no current change.",
      { code: "no-operation-pending" });
  }
  const unresolved = unmergedPaths(cwd);
  if (unresolved.length) {
    throw new CliError("Reconciliation still has unresolved paths.", {
      code: "conflict-blocked",
      details: unresolved.join("\n"),
    });
  }
  const gitHead = cherryPickHead(cwd);
  if (!gitHead) {
    throw new CliError(
      "Git no longer has a cherry-pick to continue.",
      {
        code: "out-of-band-change",
        details:
          "If Git was continued manually, abort this pending vlab operation and start a new reconciliation plan.",
      },
    );
  }
  if (gitHead !== operation.current.sourceCommit) {
    throw new CliError("Git's pending cherry-pick does not match the vlab operation.",
      { code: "out-of-band-change" });
  }

  operation.current.semanticMerges = captureSpecMergeOutcomes(
    operation.current.semanticMerges ?? [],
    cwd,
  );
  const semanticallyResolved = new Set(
    (operation.current.semanticMerges ?? []).flatMap(
      (merge) => merge.resolvedPaths ?? [],
    ),
  );
  operation.current.resolutionOutcomes = captureResolutionOutcomes(
    (operation.current.conflicts ?? []).filter(
      (conflict) => !semanticallyResolved.has(conflict.path),
    ),
    cwd,
  );
  writeReconciliationState(operation, cwd);

  if (options.fork || operation.current.forkChangeId) {
    forkMergeMessage(operation, cwd);
  }
  const result = runGit(
    [...GIT_NO_RERERE, "-c", "core.editor=true", "cherry-pick", "--continue"],
    { cwd, allowFailure: true },
  );
  if (!result.ok) {
    throw new CliError("Git could not continue the reconciliation.", {
      code: "conflict-blocked",
      details: result.output,
    });
  }

  const relation = operation.current.forkChangeId
    ? "contextual-fork"
    : "contextual-application";
  recordSuccessfulApplication(operation, relation, cwd);
  return runReconciliationQueue(operation, cwd, phaseStarted);
}

export function continueReconciliation(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  return withGitObjectSession(cwd, () =>
    continueReconciliationInSession(options, cwd),
  );
}

export function abortReconciliation(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const operation = requirePendingReconciliation(cwd);
  requireReconciliationBranch(operation, cwd);
  if (cherryPickHead(cwd)) {
    runGit(["cherry-pick", "--abort"], { cwd });
  } else {
    assertClean(cwd);
  }
  if (currentHead(cwd) !== operation.targetBefore) {
    runGit(["reset", "--hard", operation.targetBefore], { cwd });
  }
  if (currentHead(cwd) !== operation.targetBefore) {
    throw new CliError("Reconciliation abort did not restore the target's original tip.",
      { code: "internal-invariant" });
  }
  faultPoint("reconcile:abort-before-clear");
  clearReconciliationState(cwd);
  return {
    aborted: true,
    operationId: operation.id,
    restoredHead: currentHead(cwd),
  };
}

export function createCommit(message, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const create = () => createCommitWithProvenance(message, options, cwd);
  // Acquire before Git can change HEAD or stage --all content. appendNote
  // reuses this claim, so no second acquisition can refuse after the commit.
  return options.actors?.length ? withNotesLock(cwd, create) : create();
}

function createCommitWithProvenance(message, options, cwd) {
  const changeId = options.changeId ?? newId("ch");
  const args = ["commit"];
  if (options.all) args.push("--all");
  if (options.allowEmpty) args.push("--allow-empty");
  args.push("-m", `${message}\n\nChange-Id: ${changeId}`);
  runGit(args, { cwd });
  const commit = currentHead(cwd);
  // Declared provenance is attached after the commit exists, because the
  // record names the commit it describes. Nothing is written when nothing was
  // declared (FR-ID-08).
  let provenance;
  try {
    provenance = declareProvenance(commit, changeId, options.actors ?? [], cwd);
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    failure.details = [
      failure.message,
      failure.details,
      `Keep this commit and inspect it with 'git show ${commit}' and 'vlab provenance ${commit}'.`,
      "Do not retry commit as though it failed before creation. After fixing the notes write failure, use the provenance repair procedure in docs/identity/README.md to attach the original declaration to this exact commit.",
    ].filter(Boolean).join("\n");
    failure.message = `Commit '${commit}' was created, but declared provenance could not be published.`;
    throw failure;
  }
  return {
    commit,
    changeId,
    message: commitMessage(commit, cwd),
    ...(provenance ? { provenance } : {}),
  };
}
