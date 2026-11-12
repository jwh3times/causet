import { withGitObjectSession } from "./git.js";
import { mergeCommitsBetween, symbolicRef } from "./engine.js";
import { sha256 } from "./ids.js";
import { buildMergePlanBetween } from "./merge-plan.js";
import { CliError } from "./errors.js";

function currentBranch(cwd) {
  const branch = symbolicRef("HEAD", cwd, { short: true });
  if (!branch) {
    throw new CliError(
      "HEAD is detached; provide an explicit source ref for rebase planning.",
        { code: "usage-missing-argument" },
    );
  }
  return branch;
}

function mergeCommits(base, sourceHead, cwd) {
  return mergeCommitsBetween(base, sourceHead, cwd);
}

function fingerprint(plan) {
  return sha256(JSON.stringify({
    schema: plan.schema,
    mode: plan.mode,
    ontoHead: plan.ontoHead,
    sourceHead: plan.sourceHead,
    ontoTree: plan.ontoTree,
    sourceTree: plan.sourceTree,
    physicalBase: plan.physicalBase,
    effectiveBase: plan.effectiveBase,
    reachableReceipts: plan.reachableReceipts,
    changes: plan.changes.map((change) => ({
      commit: change.commit,
      changeId: change.changeId,
      status: change.status,
      proof: change.proof,
      action: change.action,
    })),
    mergeCommits: plan.constraints.mergeCommits,
  }));
}

function buildRebasePlanInSession(ontoRef, requestedSourceRef, cwd) {
  const sourceRef = requestedSourceRef ?? currentBranch(cwd);
  const causal = buildMergePlanBetween(ontoRef, sourceRef, cwd);
  const unsupportedMerges = mergeCommits(
    causal.physicalBase,
    causal.sourceHead,
    cwd,
  );
  const changes = causal.changes.map((change) => ({
    ...change,
    action:
      change.status === "covered"
        ? "omit"
        : change.status === "candidate-equivalent"
          ? "review"
          : "replay",
  }));
  const replayQueue = changes
    .filter((change) => change.action === "replay")
    .map(({ commit, shortCommit, changeId, subject }) => ({
      commit,
      shortCommit,
      changeId,
      subject,
    }));
  const omitted = changes
    .filter((change) => change.action === "omit")
    .map(({ commit, changeId, proof }) => ({ commit, changeId, proof }));
  const candidates = changes
    .filter((change) => change.action === "review")
    .map(({ commit, changeId, proof, subject }) => ({
      commit,
      changeId,
      proof,
      subject,
    }));
  const supported = unsupportedMerges.length === 0;
  const plan = {
    schema: "vcs-lab.rebase-plan/v1",
    mode: "linear",
    ontoRef,
    ontoHead: causal.targetHead,
    sourceRef,
    sourceHead: causal.sourceHead,
    ontoTree: causal.targetTree,
    sourceTree: causal.sourceTree,
    exactStateEquality: causal.exactStateEquality,
    physicalBase: causal.physicalBase,
    effectiveBase: causal.effectiveBase,
    reachableReceipts: causal.reachableReceipts,
    constraints: {
      supported,
      linearHistory: supported,
      mergeCommits: unsupportedMerges,
    },
    counts: causal.counts,
    changes,
    replayQueue,
    omitted,
    candidates,
    candidateDecisionRequired: candidates.length > 0,
    executableWithoutReview: supported && candidates.length === 0,
  };
  return { ...plan, fingerprint: fingerprint(plan) };
}

export function buildRebasePlan(
  ontoRef,
  sourceRef = null,
  cwd = process.cwd(),
) {
  return withGitObjectSession(cwd, () =>
    buildRebasePlanInSession(ontoRef, sourceRef, cwd),
  );
}

export function formatRebasePlan(plan) {
  const lines = [
    "Causal rebase plan",
    `onto          ${plan.ontoRef} (${plan.ontoHead.slice(0, 12)})`,
    `source        ${plan.sourceRef} (${plan.sourceHead.slice(0, 12)})`,
    `physical base ${plan.physicalBase.slice(0, 12)}`,
    `effective base ${plan.effectiveBase.commit.slice(0, 12)} (${plan.effectiveBase.reason})`,
    `same state    ${plan.exactStateEquality ? "yes" : "no"}`,
    `fingerprint   ${plan.fingerprint}`,
    "",
  ];

  if (plan.changes.length === 0) {
    lines.push("No source changes are outside the physical ancestry.");
  } else {
    for (const change of plan.changes) {
      const marker =
        change.action === "omit" ? "=" : change.action === "review" ? "?" : "+";
      const proof = change.proof ? ` [${change.proof}]` : "";
      lines.push(
        `${marker} ${change.shortCommit} ${change.changeId} ${change.subject} -> ${change.action}${proof}`,
      );
    }
  }

  lines.push(
    "",
    `summary       ${plan.counts.covered} omitted, ${plan.counts["candidate-equivalent"]} review, ${plan.counts.new} replay`,
    `replay queue  ${plan.replayQueue.length}`,
  );
  if (!plan.constraints.supported) {
    lines.push(
      `unsupported  ${plan.constraints.mergeCommits.length} merge commit${plan.constraints.mergeCommits.length === 1 ? "" : "s"}; linear v1 cannot execute this plan`,
    );
  } else if (plan.candidateDecisionRequired) {
    lines.push("review        heuristic candidates require explicit acceptance");
  } else {
    lines.push("execution     no candidate decision is required");
  }
  lines.push("", "The current HEAD, index, and working files were not changed.");
  return lines.join("\n");
}
