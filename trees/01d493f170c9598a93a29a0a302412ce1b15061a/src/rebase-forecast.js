import path from "node:path";
import { performance } from "node:perf_hooks";
import { CliError } from "./errors.js";
import { assertReadableSchema } from "./schemas.js";
import {
  beginGitMetrics,
  endGitMetrics,
  withGitObjectSession,
} from "./git.js";
import {
  indexEntries,
  listWorktrees,
  porcelainStatus,
  repoContext,
  resolveObjectIds,
  symbolicRef,
} from "./engine.js";
import { simulateCausalRebasePlan } from "./forecasts.js";
import { newId, sha256 } from "./ids.js";
import { readReconciliationState } from "./reconcile-state.js";
import { readRebaseState } from "./rebase-state.js";
import { buildRebasePlan } from "./rebase-plan.js";
import { readJson, writeJson } from "./store.js";
import { assertCurrentSpecDecisions } from "./specs.js";
import { predictOverlayTree, resolveTargetOverlay } from "./target-overlay.js";

function rebaseForecastPath(id, cwd) {
  if (!/^rebase_forecast_[a-z0-9]+$/.test(String(id ?? ""))) {
    throw new CliError(`Invalid rebase forecast ID '${id}'.`,
      { code: "invalid-identifier" });
  }
  return path.join(
    repoContext(cwd).gitDir,
    "vcs-lab",
    "forecasts",
    `${id}.json`,
  );
}

export function readRebaseForecast(id, cwd = process.cwd()) {
  const forecast = readJson(rebaseForecastPath(id, cwd), null);
  if (!forecast) {
    throw new CliError(`Rebase forecast '${id}' was not found in this worktree.`,
      { code: "not-found" });
  }
  return forecast;
}

export function rebaseForecastForPlan(id, plan, cwd = process.cwd()) {
  const forecast = readRebaseForecast(id, cwd);
  // Separate "this build cannot read that version" from "this forecast is not
  // an approval" so the two failures do not share one message (ADR-0020).
  assertReadableSchema(forecast?.schema, `Rebase forecast '${id}'`, {
    family: "vcs-lab.rebase-forecast",
    recovery: "Generate a new rebase forecast with: vlab rebase-forecast",
  });
  assertCurrentSpecDecisions(forecast);
  if (
    forecast.id !== id ||
    forecast.status !== "complete" ||
    !forecast.predictedResultTree
  ) {
    // `edit` exists to let a person change content, so a program containing one
    // has no predictable result tree and cannot be pre-approved. Saying that,
    // rather than "not complete", is the difference between a reason a caller
    // can act on and one they cannot (ADR-0035).
    throw new CliError(
      `Rebase forecast '${id}' is not a complete application approval.`,
      {
        code: "operation-state-invalid",
        details:
          forecast.status === "pauses-for-content"
            ? "The program declares an --edit, whose result a forecast cannot predict. Run the rebase without --use-forecast; it will pause for the content and verify the rest of the queue as it goes."
            : "",
      },
    );
  }
  if (
    forecast.sourceHead !== plan.sourceHead ||
    forecast.sourceTree !== plan.sourceTree ||
    forecast.ontoHead !== plan.ontoHead ||
    forecast.ontoTree !== plan.ontoTree ||
    forecast.planFingerprint !== plan.fingerprint ||
    forecast.plan?.fingerprint !== plan.fingerprint ||
    (forecast.range?.base ?? null) !== (plan.range?.base ?? null)
  ) {
    throw new CliError(`Rebase forecast '${id}' is stale.`, {
      code: "stale-forecast",
      details:
        (forecast.range?.base ?? null) !== (plan.range?.base ?? null)
          ? `The forecast approved the range from ${forecast.range?.base ?? "the merge base"}, not ${plan.range?.base ?? "the merge base"}. Generate and review a new rebase forecast.`
          : "The source, onto target, or causal metadata changed. Generate and review a new rebase forecast.",
    });
  }
  const expectedCandidates = plan.candidates.map((candidate) => ({
    commit: candidate.commit,
    changeId: candidate.changeId,
    proof: candidate.proof,
  }));
  const approvedCandidates = (forecast.acceptedCandidates ?? []).map(
    (candidate) => ({
      commit: candidate.commit,
      changeId: candidate.changeId,
      proof: candidate.proof,
    }),
  );
  if (
    plan.candidates.length > 0 &&
    (!forecast.acceptCandidates ||
      JSON.stringify(approvedCandidates) !== JSON.stringify(expectedCandidates))
  ) {
    throw new CliError(
      `Rebase forecast '${id}' does not approve the current heuristic candidates.`,
        { code: "stale-forecast" },
    );
  }
  return forecast;
}

function captureCaller(cwd) {
  const [head, tree] = resolveObjectIds(["HEAD^{commit}", "HEAD^{tree}"], cwd);
  return {
    head,
    tree,
    branch: symbolicRef("HEAD", cwd, { short: true }),
    index: JSON.stringify(indexEntries(cwd)),
    status: porcelainStatus(cwd, { nulTerminated: true }),
    worktrees: JSON.stringify(listWorktrees(cwd)),
  };
}

function callerEvidence(snapshot) {
  return {
    head: snapshot.head,
    tree: snapshot.tree,
    branch: snapshot.branch,
    indexDigest: sha256(snapshot.index),
    statusDigest: sha256(snapshot.status),
    worktreeListDigest: sha256(snapshot.worktrees),
  };
}

function callerEqual(before, after) {
  return Object.keys(before).every((key) => before[key] === after[key]);
}

function ignoredDirtyFiles(status) {
  const fields = status.split("\0").filter(Boolean);
  let count = 0;
  for (let index = 0; index < fields.length; index += 1) {
    count += 1;
    const code = fields[index].slice(0, 2);
    if (/[RC]/.test(code)) index += 1;
  }
  return count;
}

function emptySimulation(status, blockedReason = null, remainingChanges = 0) {
  return {
    status,
    blockedReason,
    steps: [],
    approvedResolutions: [],
    approvedSpecMerges: [],
    counts: {
      clean: 0,
      exactResolution: 0,
      exactResolutionPaths: 0,
      semanticSpec: 0,
      semanticSpecPaths: 0,
      blocked: 0,
    },
    simulatedChanges: 0,
    remainingChanges,
    partialResultTree: null,
    predictedResultTree: null,
    exactStateEqualityAfter: null,
    engine: null,
    fallbacks: [],
    worktreeTimings: {
      setupMs: 0,
      applicationMs: 0,
      cleanupMs: 0,
      totalMs: 0,
    },
    mergeTreeTimings: {
      setupMs: 0,
      applicationMs: 0,
      cleanupMs: 0,
      totalMs: 0,
    },
  };
}

function forecastRebaseInSession(ontoRef, sourceRef, options, cwd) {
  if (readReconciliationState(cwd) || readRebaseState(cwd)) {
    throw new CliError(
      "Finish or abort the current VCS Lab operation before forecasting a rebase.",
        { code: "operation-in-progress" },
    );
  }

  // Resolved before any planning, so a worktree that cannot supply an overlay
  // refuses without having simulated anything. The overlaid worktree here is the
  // source branch's own, because a rebase rewrites the branch you are standing
  // on; ADR-0028's `targetOverlay` vocabulary is kept because the contract is
  // the same one, and "target" in it means the worktree the command mutates.
  const targetOverlay = options.targetCheckpoint ? resolveTargetOverlay(cwd) : null;
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const gitMetrics = beginGitMetrics("rebase-forecast");
  const phases = {};

  const preflightStarted = performance.now();
  const before = captureCaller(cwd);
  phases.preflightMs = performance.now() - preflightStarted;

  const planningStarted = performance.now();
  const plan = buildRebasePlan(ontoRef, sourceRef, cwd, {
    from: options.from,
    interactive: options.interactive,
  });
  phases.planningMs = performance.now() - planningStarted;

  const simulationStarted = performance.now();
  const simulation = plan.constraints.supported
    ? simulateCausalRebasePlan(plan, cwd)
    : emptySimulation(
        "unsupported",
        // Which shape, not merely "there are merges": the plan recreates merges
        // now, so the only unsupported ranges are the ones ADR-0034 names.
        plan.constraints.unsupportedMerges[0]?.reason ?? "merge-topology-unsupported",
        plan.replayQueue.length,
      );
  phases.simulationMs = performance.now() - simulationStarted;

  const acceptCandidates = Boolean(options.acceptCandidates);
  const candidateDecisionRequired =
    plan.candidates.length > 0 && !acceptCandidates;
  if (candidateDecisionRequired && simulation.status === "complete") {
    simulation.status = "review-required";
    simulation.blockedReason = "heuristic-candidate-decision-required";
    simulation.predictedResultTree = null;
    simulation.exactStateEqualityAfter = null;
  }

  // The overlay prediction runs on trees, never on live bytes, so it cannot
  // disturb the caller worktree the invariant check below is about to compare.
  //
  // The base is the tree the source branch held before the rebase started, and
  // `ours` is the rewritten tip: a rebase moves the branch you are standing on,
  // so the prediction is pinned once per run rather than once per pick.
  let overlayPrediction = null;
  if (targetOverlay) {
    overlayPrediction = simulation.predictedResultTree
      ? predictOverlayTree({
          baseTree: plan.sourceTree,
          resultTree: simulation.predictedResultTree,
          overlayTree: targetOverlay.tree,
        }, cwd)
      : { tree: null, conflict: null };
    if (overlayPrediction.conflict) {
      // An overlay that cannot be re-materialized is not an approval. The plan
      // itself is untouched and still readable; what is withheld is the
      // prediction an application would verify against.
      simulation.status = "blocked-target-overlay";
      simulation.blockedReason = overlayPrediction.conflict.reason;
      simulation.predictedResultTree = null;
      simulation.exactStateEqualityAfter = null;
    }
  }

  const invariantStarted = performance.now();
  const after = captureCaller(cwd);
  if (!callerEqual(before, after)) {
    endGitMetrics(gitMetrics);
    throw new CliError(
      "Rebase forecasting unexpectedly changed the caller worktree.",
        { code: "internal-invariant" },
    );
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
    schema: "vcs-lab.rebase-forecast/v3",
    id: newId("rebase_forecast"),
    mode: plan.mode,
    sourceRef: plan.sourceRef,
    sourceHead: plan.sourceHead,
    sourceTree: plan.sourceTree,
    ontoRef: plan.ontoRef,
    ontoHead: plan.ontoHead,
    ontoTree: plan.ontoTree,
    quarantinedFacts: plan.quarantinedFacts ?? [],
    // Pinned beside the heads and trees: a forecast approves one range, and
    // application refuses it for another (ADR-0032).
    range: plan.range,
    excludedByRange: plan.excludedByRange,
    targetWorktree: context.root,
    // A distinct scope per overlay combination, so an approval cannot be read as
    // covering a combination it was not made for (ADR-0028).
    scope: targetOverlay ? "target-checkpoint" : "committed-heads",
    targetOverlay: targetOverlay
      ? { ...targetOverlay, rematerialized: "uncommitted" }
      : null,
    predictedOverlayTree: overlayPrediction?.tree ?? null,
    targetOverlayConflict: overlayPrediction?.conflict ?? null,
    ignoredCallerDirtyFiles: ignoredDirtyFiles(before.status),
    acceptCandidates,
    candidateDecisionRequired,
    candidatePolicy:
      plan.candidates.length === 0
        ? "none"
        : acceptCandidates
          ? "accepted"
          : "review-required",
    acceptedCandidates: acceptCandidates
      ? plan.candidates.map((candidate) => ({
          ...candidate,
          decision: "omit",
        }))
      : [],
    planFingerprint: plan.fingerprint,
    // Lifted out of `plan` so a reader of the forecast sees the preserved
    // topology without reading the plan it pins (ADR-0034).
    recreatedMerges: plan.recreatedMerges ?? [],
    // The declared program, beside the topology, for the same reason: a reader
    // sees what the rewrite will do without reading the plan it pins.
    interactive: plan.interactive ?? [],
    plan,
    ...simulationResult,
    engine,
    fallbacks,
    callerInvariants: {
      preserved: true,
      ...callerEvidence(before),
    },
    timings: {
      forecastMs: Number((performance.now() - started).toFixed(2)),
      phases: Object.fromEntries(
        Object.entries(phases).map(([name, value]) => [
          name,
          Number(value.toFixed(2)),
        ]),
      ),
      worktree: worktreeTimings,
      mergeTree: mergeTreeTimings,
      git,
    },
    startedAt,
    createdAt: new Date().toISOString(),
  };
  writeJson(rebaseForecastPath(forecast.id, cwd), forecast);
  return forecast;
}

export function forecastRebase(ontoRef, sourceRef = null, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  return withGitObjectSession(cwd, () =>
    forecastRebaseInSession(ontoRef, sourceRef, options, cwd),
  );
}

function short(value) {
  return value ? value.slice(0, 12) : "-";
}

export function formatForecastEngine(forecast) {
  const lines = [];
  if (forecast.engine) lines.push(`engine       ${forecast.engine}`);
  for (const fallback of forecast.fallbacks ?? []) {
    const where = fallback.step === undefined
      ? ""
      : ` at step ${fallback.step + 1}${fallback.sourceCommit ? ` (${short(fallback.sourceCommit)})` : ""}`;
    lines.push(
      `fallback     ${fallback.engine} -> ${forecast.engine}: ${fallback.reason}${where}`,
    );
  }
  return lines;
}

export function formatRebaseForecast(forecast) {
  const scope = {
    "target-checkpoint": "committed heads plus a caller overlay",
  }[forecast.scope] ?? "committed heads only";
  const lines = [
    forecast.mode === "merge-preserving"
      ? "Causal rebase forecast (merge-preserving)"
      : "Causal rebase forecast",
    `forecast     ${forecast.id}`,
    `status       ${forecast.status}`,
    `onto         ${forecast.ontoRef} @ ${short(forecast.ontoHead)}`,
    `source       ${forecast.sourceRef} @ ${short(forecast.sourceHead)}`,
    `scope        ${scope}`,
    `plan         ${forecast.plan.counts.covered} omit, ${forecast.plan.counts["candidate-equivalent"]} review, ${forecast.plan.counts.new} replay`,
    `simulation   ${forecast.counts.clean} clean, ${forecast.counts.exactResolution} exact-resolved, ${forecast.counts.semanticSpec} spec-merged, ${forecast.counts.blocked} blocked`,
    ...(forecast.recreatedMerges?.length
      ? [`recreated    ${forecast.recreatedMerges.length} merge${forecast.recreatedMerges.length === 1 ? "" : "s"} preserved as joins`]
      : []),
    `predicted    ${short(forecast.predictedResultTree)}`,
    `partial      ${short(forecast.partialResultTree)}`,
    `same state   ${forecast.exactStateEqualityAfter === null || forecast.exactStateEqualityAfter === undefined ? "unknown" : forecast.exactStateEqualityAfter ? "yes" : "no"}`,
    `fingerprint  ${forecast.planFingerprint}`,
    ...formatForecastEngine(forecast),
  ];

  if (forecast.targetOverlay) {
    const overlay = forecast.targetOverlay;
    lines.push(
      `overlay      checkpoint ${short(overlay.checkpoint)} of workspace ${overlay.workspaceName}`,
      `overlay tree ${overlay.tree}`,
      `overlay base ${short(overlay.baseHead)}; draft ${overlay.draftChangeId.slice(0, 18)}`,
      forecast.predictedOverlayTree
        ? `overlay after ${forecast.predictedOverlayTree} (re-materialized uncommitted; never committed)`
        : "overlay after BLOCKED: the overlay does not merge with the rewritten tip",
    );
    if (forecast.targetOverlayConflict) {
      lines.push(`  ! ${forecast.targetOverlayConflict.reason}`);
    }
  }
  // With an overlay the caller's dirty files *are* the pinned draft, so calling
  // them ignored would say the opposite of what happens to them.
  if (forecast.ignoredCallerDirtyFiles) {
    const plural = forecast.ignoredCallerDirtyFiles === 1 ? "" : "s";
    lines.push(
      forecast.targetOverlay
        ? `caller draft ${forecast.ignoredCallerDirtyFiles} file${plural} carried as the overlay`
        : `caller dirty ${forecast.ignoredCallerDirtyFiles} file${plural} ignored`,
    );
  }
  lines.push("");

  if (forecast.steps.length === 0) {
    lines.push("No new source changes required simulation.");
  }
  for (const step of forecast.steps) {
    const marker = step.outcome.startsWith("blocked")
      ? "!"
      : step.kind === "recreate-merge"
        ? "M"
        : "C";
    lines.push(
      `${marker} ${short(step.sourceCommit)} ${step.subject} [${step.outcome}] ${short(step.targetBeforeTree)} -> ${short(step.resultTree)}`,
    );
    for (const conflict of step.conflicts ?? []) {
      lines.push(
        `  ${conflict.path}: ${conflict.candidates.length} exact candidate${conflict.candidates.length === 1 ? "" : "s"}`,
      );
    }
  }
  if (forecast.blockedReason) {
    lines.push("", `blocked by   ${forecast.blockedReason}`);
  }
  if (forecast.acceptedCandidates.length) {
    lines.push(
      "",
      `accepted     ${forecast.acceptedCandidates.length} heuristic candidate${forecast.acceptedCandidates.length === 1 ? "" : "s"} as explicit omissions`,
    );
  }
  lines.push(
    "",
    forecast.callerInvariants?.preserved === false
      ? "The caller worktree changed during forecasting; this forecast is not usable."
      : "The caller HEAD, branch, index, status, files, and worktree list were not changed.",
  );
  if (forecast.status === "unsupported") {
    for (const merge of forecast.plan.constraints.unsupportedMerges ?? []) {
      lines.push(`unsupported  ${merge.commit.slice(0, 12)} ${merge.reason}: ${merge.details}`);
    }
  } else if (forecast.candidateDecisionRequired) {
    lines.push(
      "Review the heuristic candidates, then regenerate with:",
      `  vlab rebase-forecast ${forecast.ontoRef} ${forecast.sourceRef} --accept-candidates`,
    );
  } else {
    lines.push("The forecast is pinned for the future rebase application slice.");
  }
  return lines.join("\n");
}
