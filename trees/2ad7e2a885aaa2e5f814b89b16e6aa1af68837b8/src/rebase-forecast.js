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
  if (
    forecast.id !== id ||
    forecast.status !== "complete" ||
    !forecast.predictedResultTree
  ) {
    throw new CliError(
      `Rebase forecast '${id}' is not a complete application approval.`,
        { code: "operation-state-invalid" },
    );
  }
  if (
    forecast.sourceHead !== plan.sourceHead ||
    forecast.sourceTree !== plan.sourceTree ||
    forecast.ontoHead !== plan.ontoHead ||
    forecast.ontoTree !== plan.ontoTree ||
    forecast.planFingerprint !== plan.fingerprint ||
    forecast.plan?.fingerprint !== plan.fingerprint
  ) {
    throw new CliError(`Rebase forecast '${id}' is stale.`, {
      code: "stale-forecast",
      details:
        "The source, onto target, or causal metadata changed. Generate and review a new rebase forecast.",
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

  const startedAt = new Date().toISOString();
  const started = performance.now();
  const gitMetrics = beginGitMetrics("rebase-forecast");
  const phases = {};

  const preflightStarted = performance.now();
  const before = captureCaller(cwd);
  phases.preflightMs = performance.now() - preflightStarted;

  const planningStarted = performance.now();
  const plan = buildRebasePlan(ontoRef, sourceRef, cwd);
  phases.planningMs = performance.now() - planningStarted;

  const simulationStarted = performance.now();
  const simulation = plan.constraints.supported
    ? simulateCausalRebasePlan(plan, cwd)
    : emptySimulation(
        "unsupported",
        "merge-topology-unsupported",
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
    schema: "vcs-lab.rebase-forecast/v1",
    id: newId("rebase_forecast"),
    mode: plan.mode,
    sourceRef: plan.sourceRef,
    sourceHead: plan.sourceHead,
    sourceTree: plan.sourceTree,
    ontoRef: plan.ontoRef,
    ontoHead: plan.ontoHead,
    ontoTree: plan.ontoTree,
    targetWorktree: context.root,
    scope: "committed-heads",
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
  const lines = [
    "Causal rebase forecast",
    `forecast     ${forecast.id}`,
    `status       ${forecast.status}`,
    `onto         ${forecast.ontoRef} @ ${short(forecast.ontoHead)}`,
    `source       ${forecast.sourceRef} @ ${short(forecast.sourceHead)}`,
    `scope        ${forecast.scope === "source-checkpoint" ? "immutable source checkpoint" : "committed heads only"}`,
    `plan         ${forecast.plan.counts.covered} omit, ${forecast.plan.counts["candidate-equivalent"]} review, ${forecast.plan.counts.new} replay`,
    `simulation   ${forecast.counts.clean} clean, ${forecast.counts.exactResolution} exact-resolved, ${forecast.counts.semanticSpec} spec-merged, ${forecast.counts.blocked} blocked`,
    `predicted    ${short(forecast.predictedResultTree)}`,
    `partial      ${short(forecast.partialResultTree)}`,
    `same state   ${forecast.exactStateEqualityAfter === null || forecast.exactStateEqualityAfter === undefined ? "unknown" : forecast.exactStateEqualityAfter ? "yes" : "no"}`,
    `fingerprint  ${forecast.planFingerprint}`,
    ...formatForecastEngine(forecast),
  ];

  if (forecast.ignoredCallerDirtyFiles) {
    lines.push(
      `caller dirty ${forecast.ignoredCallerDirtyFiles} file${forecast.ignoredCallerDirtyFiles === 1 ? "" : "s"} ignored`,
    );
  }
  lines.push("");

  if (forecast.steps.length === 0) {
    lines.push("No new source changes required simulation.");
  }
  for (const step of forecast.steps) {
    const marker = step.outcome.startsWith("blocked") ? "!" : "C";
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
    lines.push("Linear v1 cannot forecast source history containing merge commits.");
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
