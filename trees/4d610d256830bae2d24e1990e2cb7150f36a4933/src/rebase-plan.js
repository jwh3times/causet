import { withGitObjectSession } from "./git.js";
import {
  commitHistory,
  isAncestor,
  listRefs,
  resolveObjectIds,
  symbolicRef,
} from "./engine.js";
import { sha256 } from "./ids.js";
import { buildMergePlanBetween } from "./merge-plan.js";
import {
  analyzeRebaseTopology,
  topologyFingerprintInput,
} from "./rebase-topology.js";
import {
  declaredInteractiveActions,
  resolveInteractiveProgram,
  SURVIVING_ACTIONS,
} from "./rebase-interactive.js";
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

/**
 * The plan identity a forecast approval is pinned to. `range.base` is covered
 * because it decides what would be replayed, so a forecast for one range is
 * stale for another. `range.explicit` is deliberately *not* covered: an
 * approval made without `--from` authorizes a run that names the same base,
 * because it is the same range either way (ADR-0032).
 *
 * `topology` covers which merges are recreated and where each new parent comes
 * from, so an approval for one shape cannot authorize another (ADR-0034). It is
 * not implied by `changes`: a merge is not a change and never appears there, so
 * two ranges with identical replay queues can still join them differently.
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
    topology: topologyFingerprintInput(plan.topology),
    // The declared action list, so an approval for one interactive program
    // cannot authorize another (ADR-0035). The reworded *text* is deliberately
    // absent: it arrives at continue time, it changes no tree, and hashing it
    // would make an approval depend on prose nobody had written yet.
    interactive: plan.interactive.map((item) => [item.action, item.commit, item.target]),
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
  const topology = analyzeRebaseTopology(
    causal.rangeBase,
    causal.sourceHead,
    causal.targetHead,
    cwd,
  );
  const mergeCommits = new Set(topology.mergeCommits);
  // A merge is a join, not a contribution: it claims nothing about the changes
  // beneath it and applies none of them, so it is not a change to replay, omit,
  // or count as covered (ADR-0034). It leaves `changes` here and reappears in
  // `recreatedMerges`, where nothing concludes anything from it.
  const changes = causal.changes
    .filter((change) => !mergeCommits.has(change.commit))
    .map((change) => ({
      ...change,
      action:
        change.status === "covered"
          ? "omit"
          : change.status === "candidate-equivalent"
            ? "review"
            : "replay",
    }));
  const changeSubjects = new Map(
    causal.changes.map((change) => [change.commit, change]),
  );
  const recreatedMerges = topology.steps
    .filter((step) => step.kind === "recreate-merge")
    .map((step) => ({
      commit: step.commit,
      shortCommit: step.commit.slice(0, 12),
      originChangeId: changeSubjects.get(step.commit)?.changeId ?? `git:${step.commit}`,
      subject: changeSubjects.get(step.commit)?.subject ?? "",
      parents: step.parents.map((parent) => ({
        origin: parent.origin,
        source: parent.source,
      })),
    }));
  // Resolved against the plan's own changes, so every refusal can say which
  // change it is about, and through the session's own resolver so no extra
  // process is spent turning a revision expression into a commit (ADR-0035).
  const declared = declaredInteractiveActions(options.interactive ?? {});
  const interactive = resolveInteractiveProgram(
    declared,
    {
      changes,
      constraints: { mergeCommits: topology.mergeCommits },
    },
    (expression) => resolveObjectIds([`${expression}^{commit}`], cwd)[0],
  );
  // A declared action replaces `replay` for that commit. The classification is
  // untouched: an action says what the rewrite does with a change, never
  // whether the change is covered.
  for (const change of changes) {
    const action = interactive.byCommit.get(change.commit);
    if (action) change.action = action.action;
  }

  // `reword` and `edit` replay their change and then act on the result, so they
  // stay in the queue; `squash` and `fixup` land inside a surviving commit and
  // so have no entry of their own (ADR-0035).
  const replayQueue = changes
    .filter((change) => SURVIVING_ACTIONS.has(change.action))
    .map(({ commit, shortCommit, changeId, subject, action }) => ({
      commit,
      shortCommit,
      changeId,
      subject,
      action,
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
  const counts = changes.reduce(
    (summary, change) => {
      summary[change.status] = (summary[change.status] ?? 0) + 1;
      return summary;
    },
    { covered: 0, "candidate-equivalent": 0, new: 0 },
  );
  const supported = topology.supported;
  const plan = {
    schema: "vcs-lab.rebase-plan/v3",
    // A fact about the range, not a caller choice. ADR-0034 left the naming to
    // implementation: there is no flattening form to keep a name, because the
    // form this replaces refused merges rather than flattening them, so a range
    // without merges rewrites exactly as it always did and one with them gains
    // a behavior it never had.
    mode: topology.linearHistory ? "linear" : "merge-preserving",
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
      // "Every merge in range is a supported shape", not "the range is linear"
      // (ADR-0034). `linearHistory` keeps the older question answerable,
      // because a caller may still want to know.
      supported,
      linearHistory: topology.linearHistory,
      mergeCommits: topology.mergeCommits,
      unsupportedMerges: topology.unsupportedMerges,
    },
    counts,
    topology,
    recreatedMerges,
    // The declared interactive program, in the order the rewrite runs it.
    // Empty for an ordinary rebase, which is every rebase that declares none.
    interactive: interactive.actions,
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
    plan.mode === "merge-preserving"
      ? "Causal rebase plan (merge-preserving)"
      : "Causal rebase plan",
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
  if (plan.recreatedMerges?.length) {
    lines.push(
      `recreated     ${plan.recreatedMerges.length} merge${plan.recreatedMerges.length === 1 ? "" : "s"} preserved as joins; each takes a new identity and claims nothing`,
    );
    for (const merge of plan.recreatedMerges) {
      const parents = merge.parents
        .map((parent) =>
          parent.source === "new-base"
            ? "the new base"
            : parent.origin.slice(0, 12),
        )
        .join(" + ");
      lines.push(`  M ${merge.shortCommit} ${merge.subject} <- ${parents}`);
    }
  }
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
    const unsupported = plan.constraints.unsupportedMerges;
    lines.push(
      `unsupported   ${unsupported.length} merge commit${unsupported.length === 1 ? "" : "s"} of an unsupported shape; this plan cannot be executed`,
    );
    for (const merge of unsupported) {
      lines.push(`  ! ${merge.commit.slice(0, 12)} ${merge.reason}: ${merge.details}`);
    }
  } else if (plan.candidateDecisionRequired) {
    lines.push("review        heuristic candidates require explicit acceptance");
  } else {
    lines.push("execution     no candidate decision is required");
  }
  lines.push("", "The current HEAD, index, and working files were not changed.");
  return lines.join("\n");
}
