import { withGitObjectSession } from "./git.js";
import {
  commitHistory,
  isAncestor,
  listRefs,
  mergeCommitsBetween,
  resolveObjectIds,
  symbolicRef,
} from "./engine.js";
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

/**
 * The plan identity a forecast approval is pinned to. `range.base` is covered
 * because it decides what would be replayed, so a forecast for one range is
 * stale for another. `range.explicit` is deliberately *not* covered: an
 * approval made without `--from` authorizes a run that names the same base,
 * because it is the same range either way (ADR-0032).
 */
function fingerprint(plan) {
  return sha256(JSON.stringify({
    schema: plan.schema,
    mode: plan.mode,
    ontoHead: plan.ontoHead,
    sourceHead: plan.sourceHead,
    rangeBase: plan.range.base,
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

/**
 * Resolve `--from` into the exclusive lower bound of the source set, refusing
 * every shape ADR-0032 does not admit.
 *
 * The tip check is the one worth stating: a range whose tip is in the middle of
 * a branch would leave the commits after it needing new parents, which is the
 * interactive editing #30 owns rather than something this range form can do
 * quietly.
 */
function resolveRange(ontoRef, sourceRef, requestedBase, cwd) {
  const [tip] = resolveObjectIds([`${sourceRef}^{commit}`], cwd);
  if (requestedBase === undefined || requestedBase === null) {
    return { baseRef: null, base: null, tip, explicit: false };
  }
  const [base] = resolveObjectIds([`${requestedBase}^{commit}`], cwd);
  if (base === tip) {
    throw new CliError(
      `--from ${requestedBase} names the source tip, so the range would be empty.`,
      {
        code: "unsupported-range",
        details: "Name a commit below the tip; the base is the exclusive lower bound.",
      },
    );
  }
  if (!isAncestor(base, tip, cwd)) {
    throw new CliError(
      `--from ${requestedBase} is not an ancestor of ${sourceRef}.`,
      {
        code: "unsupported-range",
        details: "A range runs from an ancestor up to a branch tip.",
      },
    );
  }
  const branchTips = new Set(listRefs("refs/heads/", cwd).map((entry) => entry.oid));
  if (!branchTips.has(tip)) {
    throw new CliError(
      `${sourceRef} resolves to ${tip.slice(0, 12)}, which is not a branch tip.`,
      {
        code: "unsupported-range",
        details:
          "The commits after it would need re-parenting, which linear ranges do not do. " +
          "Name a branch, or use interactive editing when it exists.",
      },
    );
  }
  void ontoRef;
  return { baseRef: String(requestedBase), base, tip, explicit: true };
}

/**
 * The commits the caller declared out of the source set: those between the
 * physical merge base and the range base. They are listed so a person sees
 * exactly what will not travel, and they are listed *only* — never replayed,
 * classified, absorbed, or covered, because no receipt may claim work that
 * stayed behind (ADR-0032).
 */
function excludedByRange(physicalBase, rangeBase, cwd) {
  if (!rangeBase || rangeBase === physicalBase) return [];
  return commitHistory([`${physicalBase}..${rangeBase}`], cwd, { reverse: true })
    .map((item) => ({
      commit: item.commit,
      changeId: item.message.match(/^Change-Id:\s*(.+?)\s*$/im)?.[1]?.trim() ?? `git:${item.commit}`,
      subject: item.subject,
    }));
}

function buildRebasePlanInSession(ontoRef, requestedSourceRef, cwd, options = {}) {
  const sourceRef = requestedSourceRef ?? currentBranch(cwd);
  const range = resolveRange(ontoRef, sourceRef, options.from, cwd);
  const causal = buildMergePlanBetween(ontoRef, sourceRef, cwd, {
    rangeBase: range.base ?? undefined,
  });
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
    // Carried from the causal plan and deliberately outside `fingerprint`,
    // for the reason src/merge-plan.js gives (ADR-0030).
    quarantinedFacts: causal.quarantinedFacts,
    range: { ...range, base: causal.rangeBase },
    excludedByRange: excludedByRange(causal.physicalBase, range.base, cwd),
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
  options = {},
) {
  return withGitObjectSession(cwd, () =>
    buildRebasePlanInSession(ontoRef, sourceRef, cwd, options),
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
  if (plan.range.explicit) {
    lines.push(`range         ${plan.range.baseRef} (${plan.range.base.slice(0, 12)})..${plan.range.tip.slice(0, 12)}`);
  }
  if (plan.excludedByRange.length) {
    lines.push(
      `excluded      ${plan.excludedByRange.length} commit${plan.excludedByRange.length === 1 ? "" : "s"} below the range base stay behind`,
    );
    for (const excluded of plan.excludedByRange) {
      lines.push(`  - ${excluded.commit.slice(0, 12)} ${excluded.changeId} ${excluded.subject}`);
    }
  }
  if (plan.quarantinedFacts?.length) {
    lines.push(
      `quarantined   ${plan.quarantinedFacts.length} reachable fact${plan.quarantinedFacts.length === 1 ? "" : "s"} excluded: ${plan.quarantinedFacts.join(", ")}`,
    );
  }
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
