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
  readReconciliationState,
  unmergedPaths,
} from "./reconcile-state.js";
import {
  clearRebaseState,
  readRebaseState,
  writeRebaseState,
} from "./rebase-state.js";
import { buildRebasePlan } from "./rebase-plan.js";
import { rebaseForecastForPlan } from "./rebase-forecast.js";
import {
  captureConflictDescriptors,
  captureResolutionOutcomes,
  materializeResolutionCandidate,
  publishResolution,
} from "./resolutions.js";
import {
  captureSpecMergeOutcomes,
  compactSpecMerge,
  materializeSpecMerge,
  specMergePlansForOperation,
} from "./specs.js";

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
  const step = operation.forecastApproval.steps[operation.nextIndex];
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

function recordSuccessfulApplication(operation, relation, cwd) {
  const change = operation.queue[operation.nextIndex];
  const application = applicationRecord(operation, change, relation, cwd);
  operation.applied.push(application);
  operation.nextIndex += 1;
  operation.current = null;
  operation.state = "running";
  faultPoint("rebase:before-journal-advance");
  writeRebaseState(operation, cwd);
  return application;
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
  const resultTree = treeId("HEAD", cwd);
  const actualOutcome =
    semanticMerges.length && (choices ?? []).length
      ? "semantic-spec-and-exact-resolution"
      : semanticMerges.length
        ? "semantic-spec-merge"
        : "exact-resolution";
  validateForecastAfter(operation, change, resultTree, actualOutcome, cwd);
  recordSuccessfulApplication(operation, "contextual-rebase", cwd);
  return true;
}

function conflictError(operation, result) {
  const change = operation.queue[operation.nextIndex];
  const paths = operation.current.conflictedPaths;
  if (paths.length === 0) {
    return new CliError(
      `Causal rebase blocked while applying ${change.shortCommit}.`,
      {
        code: "conflict-blocked",
        details: [
          result.output,
          "Git did not report conflict paths; the replay may have become unexpectedly empty.",
          "No change was silently skipped. Run 'vlab rebase --abort'.",
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

  const forkedOrigins = new Set(
    operation.applied
      .filter((application) => application.relation === "contextual-fork")
      .map((application) => application.originCommit),
  );
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
    schema: "vcs-lab.rebase/v1",
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
  faultPoint("rebase:before-receipt");
  appendNote(resultCommit, receipt, cwd);
  faultPoint("rebase:before-clear");
  clearRebaseState(cwd);
  return { operationId: operation.id, plan: operation.plan, receipt };
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
      const change = operation.queue[operation.nextIndex];
      const targetBefore = currentHead(cwd);
      const targetBeforeTree = treeId(targetBefore, cwd);
      operation.state = "applying";
      operation.current = {
        sourceCommit: change.commit,
        sourceChangeId: change.changeId,
        targetBefore,
        targetBeforeTree,
        conflictedPaths: [],
        startedAt: new Date().toISOString(),
      };
      writeRebaseState(operation, cwd);
      const expected = validateForecastBefore(
        operation,
        change,
        targetBeforeTree,
        cwd,
      );

      const result = runGit([...GIT_NO_RERERE, "cherry-pick", "-x", change.commit], {
        cwd,
        allowFailure: true,
      });
      if (result.ok) {
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
    schema: "vcs-lab.rebase-operation/v1",
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
        }
      : null,
    plan,
    queue: plan.changes.filter((change) => change.action === "replay"),
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

function startRebaseInSession(ontoRef, options, cwd) {
  if (readReconciliationState(cwd) || readRebaseState(cwd)) {
    throw new CliError(
      "A VCS Lab operation is already in progress in this worktree.",
        { code: "operation-in-progress" },
    );
  }
  assertClean(cwd);
  assertNoGitReplay(cwd);
  const branch = currentBranch(cwd);
  const plan = buildRebasePlan(ontoRef, branch.name, cwd);
  if (!plan.constraints.supported) {
    throw new CliError(
      "Linear causal rebase does not support source history containing merge commits.",
      { code: "unsupported-repository-shape", details: "Use ordinary Git for this topology." },
    );
  }
  const forecast = options.forecastId
    ? rebaseForecastForPlan(options.forecastId, plan, cwd)
    : null;
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
  const gitHead = cherryPickHead(cwd);
  if (!gitHead || gitHead !== operation.current.sourceCommit) {
    throw new CliError(
      "Git's pending cherry-pick does not match the causal rebase journal.",
      { code: "out-of-band-change", details: "Abort the VCS Lab rebase to restore the original branch tip." },
    );
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
  } else {
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
  faultPoint("rebase:abort-before-clear");
  clearRebaseState(cwd);
  return {
    aborted: true,
    operationId: operation.id,
    sourceRef: operation.sourceRef,
    restoredHead,
  };
}
