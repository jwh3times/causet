import { withGitObjectSession } from "./git.js";
import {
  commitHistory,
  isAncestor,
  mergeBase,
  patchEquivalentCommits,
  resolveObjectIds,
} from "./engine.js";
import { recordsReachableFrom } from "./notes.js";
import { acceptedCausalRecords } from "./metadata.js";

function directChangeCoverage(ref, cwd) {
  const history = commitHistory([ref], cwd);
  return {
    commits: new Set(history.map((item) => item.commit)),
    changeIds: new Set(
      history.map((item) =>
        extractChangeId(item.commit, item.message),
      ),
    ),
  };
}

function extractChangeId(commit, message) {
  const match = message.match(/^Change-Id:\s*(.+?)\s*$/im);
  return match?.[1]?.trim() ?? `git:${commit}`;
}

function receiptCoverage(ref, directCommits, cwd) {
  const receipts = acceptedCausalRecords(
    recordsReachableFrom(ref, cwd, directCommits).filter((record) =>
      ["landing", "reconciliation", "rebase"].includes(record.type),
    ),
    cwd,
  );
  const commits = new Set();
  const changeIds = new Set();
  for (const receipt of receipts) {
    for (const commit of receipt.absorbedCommits ?? []) commits.add(commit);
    for (const changeId of receipt.absorbedChanges ?? []) changeIds.add(changeId);
  }
  return { receipts, commits, changeIds };
}

/**
 * The queued source changes, each carrying the paths it touched. The paths
 * come from the same single `git log` process that already reads this range,
 * so they cost no extra Git invocation, and the merge-tree forecast engine
 * uses them to detect a nested `.gitattributes` edit it would otherwise
 * simulate under the wrong attributes (ADR-0016).
 */
function sourceChanges(base, source, cwd) {
  return commitHistory([`${base}..${source}`], cwd, {
    reverse: true,
    paths: true,
  }).map((item) => ({
    ...item,
    changeId: extractChangeId(item.commit, item.message),
  }));
}

function patchCandidates(target, source, base, cwd) {
  return new Set(patchEquivalentCommits(target, source, base, cwd));
}

function chooseEffectiveBase(physicalBase, receipts, sourceHead, cwd) {
  let effective = physicalBase;
  let reason = "physical-ancestry";
  for (const receipt of receipts) {
    const candidate = receipt.sourceHead;
    if (!candidate || !isAncestor(candidate, sourceHead, cwd)) continue;
    if (isAncestor(effective, candidate, cwd)) {
      effective = candidate;
      reason = `causal-receipt:${receipt.id}`;
    }
  }
  return { commit: effective, reason };
}

function buildMergePlanInSession(targetRef, sourceRef, cwd) {
  const [targetHead, sourceHead] = resolveObjectIds(
    [`${targetRef}^{commit}`, `${sourceRef}^{commit}`],
    cwd,
  );
  const physicalBase = mergeBase(targetHead, sourceHead, cwd);
  const [targetTree, sourceTree] = resolveObjectIds(
    [`${targetHead}^{tree}`, `${sourceHead}^{tree}`],
    cwd,
  );
  const exactStateEquality = targetTree === sourceTree;

  const direct = directChangeCoverage(targetHead, cwd);
  const receipt = receiptCoverage(targetHead, direct.commits, cwd);
  const candidates = patchCandidates(targetHead, sourceHead, physicalBase, cwd);
  const sourceHistory = sourceChanges(physicalBase, sourceHead, cwd);
  const effectiveBase = chooseEffectiveBase(
    physicalBase,
    receipt.receipts,
    sourceHead,
    cwd,
  );

  const changes = sourceHistory.map(({ commit, changeId, subject, changedPaths }) => {
    let status = "new";
    let proof = null;
    if (direct.commits.has(commit)) {
      status = "covered";
      proof = "commit-ancestry";
    } else if (receipt.commits.has(commit)) {
      status = "covered";
      // Pairs with `receipt-change-id` below: this proof is a reachable
      // receipt listing the exact commit, that one is a receipt absorbing the
      // logical ID. It replaces `signed-shaped-landing-receipt`, which said
      // "signed" about a record nothing signs; that value remains legal in
      // records written before v0.12.0 (docs/schemas/compatibility.md).
      proof = "receipt-commit";
    } else if (direct.changeIds.has(changeId)) {
      status = "covered";
      proof = "stable-change-id";
    } else if (receipt.changeIds.has(changeId)) {
      status = "covered";
      proof = "receipt-change-id";
    } else if (candidates.has(commit)) {
      status = "candidate-equivalent";
      proof = "git-patch-id-heuristic";
    }
    return {
      commit,
      shortCommit: commit.slice(0, 12),
      changeId,
      subject,
      status,
      proof,
      changedPaths: changedPaths ?? [],
    };
  });

  const counts = changes.reduce(
    (summary, change) => {
      summary[change.status] = (summary[change.status] ?? 0) + 1;
      return summary;
    },
    { covered: 0, "candidate-equivalent": 0, new: 0 },
  );

  return {
    schema: "vcs-lab.merge-plan/v1",
    targetHead,
    sourceRef,
    sourceHead,
    targetTree,
    sourceTree,
    exactStateEquality,
    physicalBase,
    effectiveBase,
    reachableReceipts: receipt.receipts.map((item) => item.id),
    counts,
    changes,
  };
}

export function buildMergePlan(sourceRef, cwd = process.cwd()) {
  return buildMergePlanBetween("HEAD", sourceRef, cwd);
}

/**
 * The raw evidence a coverage classification rests on, for the portable proof
 * bundle (FR-PLAN-08). The planner reduces these sets to one `proof` string
 * per change; a remote verifier needs the sets themselves, so it can re-derive
 * the classification instead of trusting the string.
 *
 * Receipts are reported with their identity and the claims that matter, so a
 * covered change is traceable to the receipt that covered it rather than only
 * to the kind of evidence involved.
 */
export function coverageEvidence(sourceRef, cwd = process.cwd()) {
  return withGitObjectSession(cwd, () => {
    const [targetHead, sourceHead] = resolveObjectIds(
      ["HEAD^{commit}", `${sourceRef}^{commit}`],
      cwd,
    );
    const physicalBase = mergeBase(targetHead, sourceHead, cwd);
    const direct = directChangeCoverage(targetHead, cwd);
    const receipt = receiptCoverage(targetHead, direct.commits, cwd);
    const candidates = patchCandidates(targetHead, sourceHead, physicalBase, cwd);
    return {
      targetCommits: [...direct.commits].sort(),
      targetChangeIds: [...direct.changeIds].sort(),
      receipts: receipt.receipts
        .map((record) => ({
          id: record.id,
          schema: record.schema,
          type: record.type,
          attachedTo: record.attachedTo ?? null,
          absorbedCommits: [...(record.absorbedCommits ?? [])].sort(),
          absorbedChanges: [...(record.absorbedChanges ?? [])].sort(),
        }))
        .sort((left, right) => String(left.id).localeCompare(String(right.id))),
      patchEquivalentCommits: [...candidates].sort(),
    };
  });
}

export function buildMergePlanBetween(targetRef, sourceRef, cwd = process.cwd()) {
  return withGitObjectSession(cwd, () =>
    buildMergePlanInSession(targetRef, sourceRef, cwd),
  );
}

export function formatMergePlan(plan) {
  const lines = [
    `target       ${plan.targetHead.slice(0, 12)}`,
    `source       ${plan.sourceRef} (${plan.sourceHead.slice(0, 12)})`,
    `physical base ${plan.physicalBase.slice(0, 12)}`,
    `effective base ${plan.effectiveBase.commit.slice(0, 12)} (${plan.effectiveBase.reason})`,
    `same state   ${plan.exactStateEquality ? "yes" : "no"}`,
    "",
  ];

  if (plan.changes.length === 0) {
    lines.push("No source changes are outside the physical ancestry.");
  } else {
    for (const change of plan.changes) {
      const marker =
        change.status === "covered"
          ? "="
          : change.status === "candidate-equivalent"
            ? "?"
            : "+";
      const proof = change.proof ? ` [${change.proof}]` : "";
      lines.push(
        `${marker} ${change.shortCommit} ${change.changeId} ${change.subject}${proof}`,
      );
    }
  }

  lines.push(
    "",
    `summary      ${plan.counts.covered} covered, ${plan.counts["candidate-equivalent"]} candidate, ${plan.counts.new} new`,
  );
  if (plan.counts["candidate-equivalent"] > 0) {
    lines.push("Candidates are advisory and are never silently suppressed.");
  }
  return lines.join("\n");
}
