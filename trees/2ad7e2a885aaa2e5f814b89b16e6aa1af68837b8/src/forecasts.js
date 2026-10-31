import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  beginGitMetrics,
  endGitMetrics,
  forecastEngine,
  GIT_NO_RERERE,
  MERGE_TREE_ENGINE_MIN_GIT,
  MergeTreeSession,
  runGit,
  withGitObjectSession,
} from "./git.js";
import {
  currentHead,
  gitAtLeast,
  gitVersion,
  inspectGitObjects,
  porcelainStatus,
  repoContext,
  resolveObjectIds,
  resolveRevision,
  treeId,
} from "./engine.js";
import { newId, sha256 } from "./ids.js";
import { buildMergePlan } from "./merge-plan.js";
import {
  captureConflictDescriptors,
  captureResolutionOutcomes,
  materializeResolutionCandidate,
} from "./resolutions.js";
import { readReconciliationState, unmergedPaths } from "./reconcile-state.js";
import { readRebaseState } from "./rebase-state.js";
import { readJson, temporaryDirectory, writeJson } from "./store.js";
import {
  latestWorkspaceCheckpoint,
  listWorkspaces,
} from "./workspaces.js";
import { CliError } from "./errors.js";
import { assertReadableSchema } from "./schemas.js";
import {
  compactSpecMerge,
  materializeSpecMerge,
  planSpecMerge,
  specFilesForConflictPaths,
} from "./specs.js";

function forecastDirectory(cwd) {
  return path.join(repoContext(cwd).gitDir, "vcs-lab", "forecasts");
}

function assertForecastId(id) {
  if (!/^forecast_[a-z0-9]+$/.test(String(id ?? ""))) {
    throw new CliError(`Invalid forecast ID '${id}'.`, { code: "invalid-identifier" });
  }
  return id;
}

function forecastPath(id, cwd) {
  return path.join(forecastDirectory(cwd), `${assertForecastId(id)}.json`);
}

export function planFingerprint(plan) {
  return sha256(JSON.stringify({
    targetHead: plan.targetHead,
    sourceHead: plan.sourceHead,
    targetTree: plan.targetTree,
    sourceTree: plan.sourceTree,
    physicalBase: plan.physicalBase,
    effectiveBase: plan.effectiveBase,
    reachableReceipts: plan.reachableReceipts,
    changes: plan.changes.map((change) => ({
      commit: change.commit,
      changeId: change.changeId,
      status: change.status,
      proof: change.proof,
    })),
  }));
}

export function readForecast(id, cwd = process.cwd()) {
  const forecast = readJson(forecastPath(id, cwd), null);
  if (!forecast) {
    throw new CliError(`Forecast '${id}' was not found in this worktree.`,
      { code: "not-found" });
  }
  return forecast;
}

function saveForecast(forecast, cwd) {
  writeJson(forecastPath(forecast.id, cwd), forecast);
  return forecast;
}

function withTemporaryWorktree(targetHead, cwd, callback) {
  const totalStarted = performance.now();
  const temporaryRoot = temporaryDirectory("vcs-lab-forecast-");
  const temporaryWorktree = path.join(temporaryRoot, "worktree");
  let added = false;
  let pruneAfterRemoval = false;
  let value;
  let callbackError;
  let setupMs = 0;
  let callbackMs = 0;
  let cleanupMs = 0;
  try {
    const setupStarted = performance.now();
    runGit(
      ["worktree", "add", "--detach", temporaryWorktree, targetHead],
      { cwd },
    );
    added = true;
    setupMs = performance.now() - setupStarted;
    const callbackStarted = performance.now();
    value = withGitObjectSession(temporaryWorktree, () =>
      callback(temporaryWorktree),
    );
    callbackMs = performance.now() - callbackStarted;
  } catch (error) {
    callbackError = error;
  } finally {
    const cleanupStarted = performance.now();
    if (added) {
      // A run that completed left no pick pending: every step either applied
      // cleanly or was continued. Only a blocked run, or one that threw and
      // so never assigned `value`, can leave one; the abort is harmless when
      // nothing is pending, so it is simply attempted then, and a clean
      // forecast's process count is unchanged. (The callback is the forecast
      // loop, whose result carries `status`.)
      if (value?.status !== "complete" && fs.existsSync(temporaryWorktree)) {
        runGit(["cherry-pick", "--abort"], {
          cwd: temporaryWorktree,
          allowFailure: true,
        });
      }
      const removed = runGit(
        ["worktree", "remove", "--force", temporaryWorktree],
        { cwd, allowFailure: true },
      );
      pruneAfterRemoval = !removed.ok;
    }
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    if (pruneAfterRemoval) runGit(["worktree", "prune"], { cwd });
    cleanupMs = performance.now() - cleanupStarted;
  }
  if (callbackError) throw callbackError;
  return {
    value,
    timings: {
      setupMs: Number(setupMs.toFixed(2)),
      applicationMs: Number(callbackMs.toFixed(2)),
      cleanupMs: Number(cleanupMs.toFixed(2)),
      totalMs: Number((performance.now() - totalStarted).toFixed(2)),
    },
  };
}

function simulationCounts(steps) {
  return steps.reduce(
    (counts, step) => {
      if (step.outcome === "clean") counts.clean += 1;
      if (step.resolutions?.length) {
        counts.exactResolution += 1;
        counts.exactResolutionPaths += step.resolutions.length;
      }
      if (step.semanticMerges?.length) {
        counts.semanticSpec += 1;
        counts.semanticSpecPaths += step.semanticMerges.length;
      }
      if (step.outcome.startsWith("blocked")) counts.blocked += 1;
      return counts;
    },
    {
      clean: 0,
      exactResolution: 0,
      exactResolutionPaths: 0,
      semanticSpec: 0,
      semanticSpecPaths: 0,
      blocked: 0,
    },
  );
}

function blockedReason(conflicts) {
  const missing = conflicts.filter((conflict) => conflict.candidates.length === 0);
  const ambiguous = conflicts.filter((conflict) => conflict.candidates.length > 1);
  if (missing.length && ambiguous.length) return "missing-and-ambiguous-resolutions";
  if (
    missing.some((conflict) =>
      conflict.semanticSpec?.conflicts?.some(
        (item) => item.type === "semantic-metadata-unavailable",
      ),
    )
  ) {
    return "semantic-spec-metadata-unavailable";
  }
  if (
    missing.some((conflict) =>
      conflict.semanticSpec?.conflicts?.length,
    )
  ) {
    return "semantic-spec-conflict";
  }
  if (missing.length) return "missing-exact-resolution";
  if (ambiguous.length) return "ambiguous-exact-resolution";
  return "unresolved-conflict";
}

function zeroTimings() {
  return { setupMs: 0, applicationMs: 0, cleanupMs: 0, totalMs: 0 };
}

function roundTimings(timings) {
  return Object.fromEntries(
    Object.entries(timings).map(([name, value]) => [name, Number(value.toFixed(2))]),
  );
}

/**
 * Simulate a queue of clean steps with one `git merge-tree --stdin` process
 * and no temporary worktree. Each step merges the change's tree onto the
 * accumulated target tree relative to the change's parent tree, which is the
 * three-way merge `git cherry-pick` performs. The engine reproduces only the
 * cases whose result the worktree simulator would also label `clean`; the
 * first conflicted step, a step whose result tree equals its input (which
 * `cherry-pick` reports as an empty pick and the worktree simulator blocks),
 * a merge or root commit, a change that edits the root `.gitattributes` (a
 * later step would then merge under attributes the session cannot see), or
 * any session failure hands the whole forecast to the worktree simulator,
 * which remains the oracle. Attributes are read from the target tree through
 * `GIT_ATTR_SOURCE`, matching the worktree simulator's checkout. The engine
 * needs Git 2.49 (`merge-tree --stdin` flushes each record only from there);
 * the session reads the version from its own process's trace2 event and
 * refuses the first step on older Git, which is reported as `git-too-old`,
 * so the version check costs no process on any path. A session that exits on
 * its first step on a Git the event did not identify is checked once more
 * with `git --version` before it is reported as unavailable.
 */
function simulatePlanWithMergeTree(cwd, options) {
  const { targetHead, expectedResultTree, cleanRelation, queue } = options;
  const totalStarted = performance.now();
  const setupStarted = totalStarted;
  let setupMs = null;
  let applicationStarted = null;
  const fallback = (reason, extra = {}) => {
    const now = performance.now();
    return {
      fallback: { engine: "merge-tree", reason, ...extra },
      timings: roundTimings({
        setupMs: setupMs ?? now - setupStarted,
        applicationMs: applicationStarted === null ? 0 : now - applicationStarted,
        cleanupMs: 0,
        totalMs: now - totalStarted,
      }),
    };
  };
  const expressions = [`${targetHead}^{tree}`];
  const perChange = 5;
  for (const change of queue) {
    expressions.push(
      `${change.commit}^{tree}`,
      `${change.commit}^^{tree}`,
      `${change.commit}^2^{commit}`,
      `${change.commit}:.gitattributes`,
      `${change.commit}^:.gitattributes`,
    );
  }
  const objects = inspectGitObjects(expressions, cwd);
  const targetTree = objects[0];
  if (!targetTree.exists || targetTree.type !== "tree") {
    return fallback("target-tree-unavailable");
  }
  const inputs = [];
  for (const [index, change] of queue.entries()) {
    const changeTree = objects[1 + index * perChange];
    const parentTree = objects[2 + index * perChange];
    const secondParent = objects[3 + index * perChange];
    const attributesAfter = objects[4 + index * perChange];
    const attributesBefore = objects[5 + index * perChange];
    if (secondParent.exists) {
      return fallback("merge-commit", { step: index, sourceCommit: change.commit });
    }
    if (!changeTree.exists || changeTree.type !== "tree") {
      return fallback("change-tree-unavailable", {
        step: index,
        sourceCommit: change.commit,
      });
    }
    if (!parentTree.exists || parentTree.type !== "tree") {
      return fallback("root-commit", { step: index, sourceCommit: change.commit });
    }
    // A change before the last one that touches any `.gitattributes` makes the
    // remaining steps merge under attributes this engine cannot see: it fixes
    // GIT_ATTR_SOURCE to the original target tree, while the worktree
    // simulator checks out the accumulated tree and reads the attributes the
    // earlier steps introduced. `changedPaths` catches a nested file such as
    // `docs/.gitattributes`; the object comparison below still covers the root
    // file for a queue supplied without paths (ADR-0016).
    if (index < queue.length - 1) {
      const attributePath = (change.changedPaths ?? []).find(
        (path) => path === ".gitattributes" || path.endsWith("/.gitattributes"),
      );
      if (attributePath) {
        return fallback("attributes-changed", {
          step: index,
          sourceCommit: change.commit,
          path: attributePath,
        });
      }
    }
    if (
      index < queue.length - 1 &&
      (attributesAfter.exists !== attributesBefore.exists ||
        attributesAfter.oid !== attributesBefore.oid)
    ) {
      return fallback("attributes-changed", {
        step: index,
        sourceCommit: change.commit,
        path: ".gitattributes",
      });
    }
    inputs.push({ change, changeTree: changeTree.oid, parentTree: parentTree.oid });
  }
  setupMs = performance.now() - setupStarted;

  const steps = [];
  let accumulated = targetTree.oid;
  const session = new MergeTreeSession(cwd, { attrSource: targetTree.oid });
  let applicationMs = 0;
  let cleanupMs = 0;
  try {
    applicationStarted = performance.now();
    for (const [index, input] of inputs.entries()) {
      let merged;
      try {
        merged = session.merge(input.parentTree, accumulated, input.changeTree);
      } catch (error) {
        if (error.sessionFailure === "too-old") {
          return fallback("git-too-old", {
            step: index,
            sourceCommit: input.change.commit,
            requiredGit: MERGE_TREE_ENGINE_MIN_GIT,
            git: error.gitVersion,
            detail: error.message,
          });
        }
        if (
          index === 0 &&
          error.sessionFailure === "exited" &&
          !gitAtLeast(MERGE_TREE_ENGINE_MIN_GIT, cwd)
        ) {
          return fallback("git-too-old", {
            step: index,
            sourceCommit: input.change.commit,
            requiredGit: MERGE_TREE_ENGINE_MIN_GIT,
            git: gitVersion(cwd).raw,
            detail: error.message,
          });
        }
        return fallback("merge-tree-unavailable", {
          step: index,
          sourceCommit: input.change.commit,
          detail: error.message,
        });
      }
      if (!merged.clean) {
        return fallback("conflicted-step", {
          step: index,
          sourceCommit: input.change.commit,
        });
      }
      if (merged.tree === accumulated) {
        return fallback("empty-step", {
          step: index,
          sourceCommit: input.change.commit,
        });
      }
      steps.push({
        sourceCommit: input.change.commit,
        changeId: input.change.changeId,
        subject: input.change.subject,
        outcome: "clean",
        relation: cleanRelation,
        targetBeforeTree: accumulated,
        resultTree: merged.tree,
      });
      accumulated = merged.tree;
    }
    applicationMs = performance.now() - applicationStarted;
  } finally {
    const cleanupStarted = performance.now();
    session.close();
    cleanupMs = performance.now() - cleanupStarted;
  }
  return {
    result: {
      status: "complete",
      blockedReason: null,
      steps,
      approvedResolutions: [],
      approvedSpecMerges: [],
      counts: simulationCounts(steps),
      simulatedChanges: steps.length,
      remainingChanges: 0,
      partialResultTree: accumulated,
      predictedResultTree: accumulated,
      exactStateEqualityAfter: accumulated === expectedResultTree,
    },
    timings: roundTimings({
      setupMs,
      applicationMs,
      cleanupMs,
      totalMs: performance.now() - totalStarted,
    }),
  };
}

function simulatePlan(plan, cwd, options = {}) {
  const targetHead = options.targetHead ?? plan.targetHead;
  const expectedResultTree = options.expectedResultTree ?? plan.sourceTree;
  const cleanRelation = options.cleanRelation ?? "causal-reconciliation";
  const contextualRelation =
    options.contextualRelation ?? "contextual-application";
  const queue =
    options.queue ?? plan.changes.filter((change) => change.status === "new");
  const fallbacks = [];
  let mergeTreeTimings = zeroTimings();
  if (forecastEngine() === "merge-tree") {
    const attempt = simulatePlanWithMergeTree(cwd, {
      targetHead,
      expectedResultTree,
      cleanRelation,
      queue,
    });
    mergeTreeTimings = attempt.timings;
    if (attempt.result) {
      return {
        ...attempt.result,
        engine: "merge-tree",
        fallbacks,
        worktreeTimings: zeroTimings(),
        mergeTreeTimings,
      };
    }
    fallbacks.push(attempt.fallback);
  }
  const simulated = withTemporaryWorktree(targetHead, cwd, (temporaryWorktree) => {
    const steps = [];
    const approvedResolutions = [];
    const approvedSpecMerges = [];
    let status = "complete";
    let reason = null;

    for (const change of queue) {
      const targetBefore = currentHead(temporaryWorktree);
      const targetBeforeTree = treeId(targetBefore, temporaryWorktree);
      const picked = runGit([...GIT_NO_RERERE, "cherry-pick", "-x", change.commit], {
        cwd: temporaryWorktree,
        allowFailure: true,
      });
      if (picked.ok) {
        steps.push({
          sourceCommit: change.commit,
          changeId: change.changeId,
          subject: change.subject,
          outcome: "clean",
          relation: cleanRelation,
          targetBeforeTree,
          resultTree: treeId("HEAD", temporaryWorktree),
        });
        continue;
      }

      const paths = unmergedPaths(temporaryWorktree);
      if (paths.length === 0) {
        status = "blocked";
        reason = "git-application-error";
        steps.push({
          sourceCommit: change.commit,
          changeId: change.changeId,
          subject: change.subject,
          outcome: "blocked-git-error",
          targetBeforeTree,
          gitOutput: picked.output,
        });
        break;
      }

      const conflicts = captureConflictDescriptors(paths, temporaryWorktree);
      const semanticPlans = specFilesForConflictPaths(paths)
        .map((file) =>
          planSpecMerge(
            file,
            `${change.commit}^`,
            targetBefore,
            change.commit,
            temporaryWorktree,
          ),
        );
      for (const semanticPlan of semanticPlans) {
        const descriptor = conflicts.find(
          (conflict) =>
            conflict.path === semanticPlan.file ||
            conflict.path === semanticPlan.manifestFile,
        );
        if (descriptor) descriptor.semanticSpec = compactSpecMerge(semanticPlan);
      }

      const semanticMerges = [];
      const semanticallyResolved = new Set();
      for (const semanticPlan of semanticPlans.filter(
        (candidate) => candidate.status === "clean",
      )) {
        materializeSpecMerge(semanticPlan, temporaryWorktree);
        const outcome = compactSpecMerge(semanticPlan, "forecast-batch");
        semanticMerges.push(outcome);
        for (const resolvedPath of outcome.resolvedPaths) {
          if (paths.includes(resolvedPath)) semanticallyResolved.add(resolvedPath);
        }
        approvedSpecMerges.push({
          sourceCommit: change.commit,
          path: outcome.path,
          signature: outcome.signature,
          resultMarkdownHash: outcome.resultMarkdownHash,
          resultManifestHash: outcome.resultManifestHash,
        });
      }
      const exactConflicts = conflicts.filter(
        (conflict) => !semanticallyResolved.has(conflict.path),
      );
      if (!exactConflicts.every((conflict) => conflict.candidates.length === 1)) {
        status = "blocked";
        reason = blockedReason(exactConflicts);
        steps.push({
          sourceCommit: change.commit,
          changeId: change.changeId,
          subject: change.subject,
          outcome: "blocked-conflict",
          targetBeforeTree,
          conflicts,
          semanticMerges,
        });
        break;
      }

      for (const conflict of exactConflicts) {
        const candidate = conflict.candidates[0];
        materializeResolutionCandidate(conflict, candidate, temporaryWorktree);
        conflict.selectedResolutionId = candidate.id;
        conflict.selectionMethod = "forecast-batch";
      }
      const resolutions = captureResolutionOutcomes(
        exactConflicts,
        temporaryWorktree,
      );
      const continued = runGit(
        [...GIT_NO_RERERE, "-c", "core.editor=true", "cherry-pick", "--continue"],
        { cwd: temporaryWorktree, allowFailure: true },
      );
      if (!continued.ok) {
        status = "blocked";
        reason = "exact-resolution-application-error";
        steps.push({
          sourceCommit: change.commit,
          changeId: change.changeId,
          subject: change.subject,
          outcome: "blocked-resolution-application",
          targetBeforeTree,
          conflicts,
          semanticMerges,
          resolutions,
          gitOutput: continued.output,
        });
        break;
      }

      for (const resolution of resolutions) {
        approvedResolutions.push({
          sourceCommit: change.commit,
          path: resolution.path,
          signature: resolution.signature,
          resolutionId: resolution.selectedResolutionId,
          resultBlob: resolution.resultBlob,
        });
      }
      steps.push({
        sourceCommit: change.commit,
        changeId: change.changeId,
        subject: change.subject,
        outcome:
          semanticMerges.length && resolutions.length
            ? "semantic-spec-and-exact-resolution"
            : semanticMerges.length
              ? "semantic-spec-merge"
              : "exact-resolution",
        relation: contextualRelation,
        targetBeforeTree,
        conflicts,
        resolutions,
        semanticMerges,
        resultTree: treeId("HEAD", temporaryWorktree),
      });
    }

    const partialResultTree = treeId("HEAD", temporaryWorktree);
    return {
      status,
      blockedReason: reason,
      steps,
      approvedResolutions,
      approvedSpecMerges,
      counts: simulationCounts(steps),
      simulatedChanges: steps.length,
      remainingChanges: queue.length - steps.length,
      partialResultTree,
      predictedResultTree: status === "complete" ? partialResultTree : null,
      exactStateEqualityAfter:
        status === "complete" ? partialResultTree === expectedResultTree : null,
    };
  });
  return {
    ...simulated.value,
    engine: "worktree",
    fallbacks,
    worktreeTimings: simulated.timings,
    mergeTreeTimings,
  };
}

export function simulateCausalRebasePlan(plan, cwd = process.cwd()) {
  return simulatePlan(plan, cwd, {
    targetHead: plan.ontoHead,
    expectedResultTree: plan.sourceTree,
    queue: plan.changes.filter((change) => change.action === "replay"),
    cleanRelation: "causal-rebase",
    contextualRelation: "contextual-rebase",
  });
}

function forecastReconciliationInSession(sourceRef, options, cwd) {
  if (readReconciliationState(cwd) || readRebaseState(cwd)) {
    throw new CliError(
      "Finish or abort the current VCS Lab operation before forecasting another.",
        { code: "operation-in-progress" },
    );
  }
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const gitMetrics = beginGitMetrics("forecast");
  const phases = {};
  const preflightStarted = performance.now();
  const [beforeHead, beforeTree] = resolveObjectIds(
    ["HEAD^{commit}", "HEAD^{tree}"],
    cwd,
  );
  const before = {
    head: beforeHead,
    tree: beforeTree,
    status: porcelainStatus(cwd),
  };
  phases.preflightMs = performance.now() - preflightStarted;
  const planningStarted = performance.now();
  const plan = buildMergePlan(sourceRef, cwd);
  phases.planningMs = performance.now() - planningStarted;
  const simulationStarted = performance.now();
  const simulation = simulatePlan(plan, cwd);
  phases.simulationMs = performance.now() - simulationStarted;
  const candidateDecisionRequired =
    plan.counts["candidate-equivalent"] > 0 && !options.acceptCandidates;
  if (candidateDecisionRequired && simulation.status === "complete") {
    simulation.status = "review-required";
    simulation.blockedReason = "heuristic-candidate-decision-required";
    simulation.predictedResultTree = null;
    simulation.exactStateEqualityAfter = null;
  }
  const invariantStarted = performance.now();
  const [afterHead, afterTree] = resolveObjectIds(
    ["HEAD^{commit}", "HEAD^{tree}"],
    cwd,
  );
  const after = {
    head: afterHead,
    tree: afterTree,
    status: porcelainStatus(cwd),
  };
  if (
    before.head !== after.head ||
    before.tree !== after.tree ||
    before.status !== after.status
  ) {
    endGitMetrics(gitMetrics);
    throw new CliError("Forecasting unexpectedly changed the current worktree.",
      { code: "internal-invariant" });
  }
  phases.invariantCheckMs = performance.now() - invariantStarted;

  const context = repoContext(cwd);
  const git = endGitMetrics(gitMetrics);
  const {
    worktreeTimings,
    mergeTreeTimings,
    engine,
    fallbacks,
    ...simulationResult
  } = simulation;
  const forecast = {
    schema: "vcs-lab.forecast/v2",
    id: newId("forecast"),
    sourceRef,
    sourceHead: plan.sourceHead,
    targetHead: plan.targetHead,
    targetWorktree: context.root,
    scope: options.scope ?? "committed-heads",
    ignoredTargetDirtyFiles: before.status
      ? before.status.split(/\r?\n/).filter(Boolean).length
      : 0,
    acceptCandidates: Boolean(options.acceptCandidates),
    candidateDecisionRequired,
    planFingerprint: planFingerprint(plan),
    plan,
    ...simulationResult,
    engine,
    fallbacks,
    workspaceComparison: options.workspaceComparison ?? null,
    timings: {
      forecastMs: Number((performance.now() - started).toFixed(2)),
      phases: Object.fromEntries(
        Object.entries(phases).map(([name, value]) => [name, Number(value.toFixed(2))]),
      ),
      worktree: worktreeTimings,
      mergeTree: mergeTreeTimings,
      git,
    },
    startedAt,
    createdAt: new Date().toISOString(),
  };
  return saveForecast(forecast, cwd);
}

export function forecastReconciliation(sourceRef, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  return withGitObjectSession(cwd, () =>
    forecastReconciliationInSession(sourceRef, options, cwd),
  );
}

export function forecastForPlan(id, plan, cwd = process.cwd()) {
  const forecast = readForecast(id, cwd);
  // The registry, not a local allow-list, decides which forecast versions this
  // build reads: v1 is superseded but still accepted, and any other version is
  // refused rather than interpreted (ADR-0020).
  assertReadableSchema(forecast?.schema, `Forecast '${id}'`, {
    family: "vcs-lab.forecast",
    recovery: "Generate a new forecast with: vlab forecast",
  });
  if (forecast.id !== id) {
    throw new CliError(`Forecast '${id}' has invalid metadata.`,
      { code: "malformed-input" });
  }
  const currentFingerprint = planFingerprint(plan);
  if (
    forecast.targetHead !== plan.targetHead ||
    forecast.sourceHead !== plan.sourceHead ||
    forecast.planFingerprint !== currentFingerprint
  ) {
    throw new CliError(`Forecast '${id}' no longer matches this reconciliation.`, {
      code: "stale-forecast",
      details:
        "A branch head or causal record changed. Generate and review a new forecast.",
    });
  }
  if (forecast.scope === "source-checkpoint") {
    const comparison = forecast.workspaceComparison;
    const checkpoint = comparison?.source?.checkpoint;
    if (
      comparison?.scope !== "source-checkpoint" ||
      !comparison.source?.id ||
      checkpoint?.id !== forecast.sourceHead ||
      !checkpoint.baseHead
    ) {
      throw new CliError(`Forecast '${id}' has invalid checkpoint metadata.`,
        { code: "malformed-input" });
    }
    const sourceWorkspace = listWorkspaces(cwd).find(
      (workspace) => workspace.id === comparison.source.id,
    );
    if (!sourceWorkspace) {
      throw new CliError(
        `Forecast '${id}' no longer matches its source workspace.`,
          { code: "stale-forecast" },
      );
    }
    let sourceWorkspaceHead;
    try {
      sourceWorkspaceHead = resolveRevision(
        `refs/heads/${sourceWorkspace.compatibilityBranch}`,
        cwd,
      );
    } catch {
      throw new CliError(
        `Forecast '${id}' no longer matches its source workspace branch.`,
          { code: "stale-forecast" },
      );
    }
    if (
      sourceWorkspaceHead !== comparison.source.head ||
      sourceWorkspaceHead !== checkpoint.baseHead
    ) {
      throw new CliError(
        `Forecast '${id}' no longer matches its source workspace head.`,
        {
          code: "stale-forecast",
          details:
            "The source branch moved after its checkpoint was reviewed. Capture a new checkpoint and forecast.",
        },
      );
    }
  }
  return forecast;
}

function requireWorkspace(workspaces, value, role) {
  const workspace = workspaces.find(
    (item) => item.name === value || item.id === value,
  );
  if (!workspace) throw new CliError(`${role} workspace '${value}' was not found.`,
    { code: "not-found" });
  if (workspace.status !== "active") {
    throw new CliError(`${role} workspace '${value}' is not active.`,
      { code: "precondition-not-met" });
  }
  return workspace;
}

export function forecastWorkspaces(targetName, sourceName, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const workspaces = listWorkspaces(cwd);
  const target = requireWorkspace(workspaces, targetName, "Target");
  const source = requireWorkspace(workspaces, sourceName, "Source");
  if (target.id === source.id) {
    throw new CliError("Choose two different workspaces to compare.",
      { code: "usage-conflicting-options" });
  }
  const checkpoint = options.sourceCheckpoint
    ? latestWorkspaceCheckpoint(source, cwd)
    : null;
  if (options.sourceCheckpoint && !checkpoint) {
    throw new CliError(
      `Source workspace '${source.name}' has no checkpoint. Capture one before requesting a checkpoint forecast.`,
        { code: "precondition-not-met" },
    );
  }
  if (checkpoint && checkpoint.baseHead !== source.head) {
    throw new CliError(
      `Source workspace '${source.name}' moved after checkpoint '${checkpoint.id}'. Capture a new checkpoint before forecasting its draft.`,
        { code: "stale-input" },
    );
  }
  if (checkpoint && checkpoint.tree === treeId(source.head, source.path)) {
    throw new CliError(
      `Source checkpoint '${checkpoint.id}' contains no draft overlay beyond the committed workspace head.`,
        { code: "precondition-not-met" },
    );
  }

  const sourceRef = checkpoint?.id ?? source.compatibilityBranch;
  return forecastReconciliation(sourceRef, {
    cwd: target.path,
    acceptCandidates: options.acceptCandidates,
    scope: checkpoint ? "source-checkpoint" : "committed-heads",
    workspaceComparison: {
      target: {
        id: target.id,
        name: target.name,
        path: target.path,
        head: target.head,
        ignoredDirtyFiles: target.dirtyFiles,
      },
      source: {
        id: source.id,
        name: source.name,
        path: source.path,
        head: source.head,
        ignoredDirtyFiles: source.dirtyFiles,
        checkpoint,
      },
      scope: checkpoint ? "source-checkpoint" : "committed-heads",
    },
  });
}
