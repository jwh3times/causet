/**
 * The topology a causal rebase rewrites, and the program that rewrites it
 * (ADR-0034).
 *
 * A linear range needs none of this: every commit has one parent, the parent
 * of the first is the range base, and replaying them in order onto the new
 * base reproduces the line. A range containing merges needs a *mapping* —
 * which rewritten commit replaces which original — because a recreated merge
 * has to name two parents that do not exist until the rewrite makes them.
 *
 * This module answers three questions and nothing else:
 *
 *   1. Which commits in the range are merges, and are their shapes ones this
 *      version recreates (ADR-0034's v1 topology scope)?
 *   2. In what order must the range be rewritten so that every parent is
 *      rewritten before the commit naming it?
 *   3. For each step, which *original* commits do its new parents come from?
 *
 * It resolves no parent to a concrete commit, because none exist yet. The
 * concrete mapping is built by whoever runs the program — the forecast in a
 * temporary worktree, the application in the caller's — and both build it the
 * same way, which is what lets a forecast be an approval of the real run.
 */
import { CliError } from "./errors.js";
import { commitTopology, isAncestor } from "./engine.js";

/**
 * Where a step's new parent comes from.
 *
 * - `rewritten`: the parent is inside the range, so the new parent is whatever
 *   this rewrite produced for it. Every such parent is produced earlier in the
 *   program, because the program is in topological order.
 * - `new-base`: the parent is outside the range, so the new base replaces it.
 *   This is the whole of what a rebase does, and for a linear range it happens
 *   exactly once — for the parent of the first commit.
 *
 * There is deliberately no third source. A merge parent that would need one is
 * refused by `unsupportedShape` before any program is built.
 */
const REWRITTEN = "rewritten";
const NEW_BASE = "new-base";

function parentOrigin(parent, inRange) {
  return inRange.has(parent)
    ? { source: REWRITTEN, origin: parent }
    : { source: NEW_BASE, origin: parent };
}

/**
 * ADR-0034's v1 topology scope, checked before anything is planned so an
 * unsupported shape costs no work and names itself.
 *
 * Both refusals are deliberate scope rather than defects, and each says which
 * commit it is about: "this repository has merges" is not something a person
 * can act on, where "this merge has three parents" is.
 */
function unsupportedShape(node, ontoHead, inRange, cwd) {
  if (node.parents.length > 2) {
    return {
      commit: node.commit,
      parents: node.parents,
      reason: "octopus-merge",
      code: "unsupported-repository-shape",
      // The order an octopus resolved in is not recorded in its result, so a
      // recreation cannot be forecast from the original without guessing it.
      details:
        `${node.commit.slice(0, 12)} joins ${node.parents.length} parents. ` +
        "The order an octopus merge resolved in is not recoverable from the result, " +
        "so its recreation cannot be forecast.",
    };
  }
  for (const parent of node.parents) {
    if (inRange.has(parent)) continue;
    if (isAncestor(parent, ontoHead, cwd)) continue;
    return {
      commit: node.commit,
      parents: node.parents,
      reason: "parent-outside-range",
      code: "unsupported-range",
      details:
        `${node.commit.slice(0, 12)} joins ${parent.slice(0, 12)}, which is neither in the ` +
        "rebased range nor an ancestor of the new base. The join would reference a line " +
        "this rebase is not rewriting and cannot map.",
    };
  }
  return null;
}

/**
 * The rewrite program for `rangeBase..sourceHead`, onto `ontoHead`.
 *
 * `steps` is the whole of it, in the order they must run. A `pick` step
 * replays one non-merge commit onto its one mapped parent; a `recreate-merge`
 * step joins two mapped parents. `unsupportedMerges` is non-empty exactly when
 * the range cannot be rewritten, and `steps` is then not to be trusted — the
 * caller refuses on the list rather than running a partial program.
 */
export function analyzeRebaseTopology(rangeBase, sourceHead, ontoHead, cwd = process.cwd()) {
  const nodes = commitTopology(rangeBase, sourceHead, cwd);
  const inRange = new Set(nodes.map((node) => node.commit));
  const unsupportedMerges = [];
  const steps = [];
  const mergeCommits = [];

  for (const node of nodes) {
    const isMerge = node.parents.length > 1;
    if (isMerge) {
      mergeCommits.push(node.commit);
      const unsupported = unsupportedShape(node, ontoHead, inRange, cwd);
      if (unsupported) {
        unsupportedMerges.push(unsupported);
        continue;
      }
    }
    steps.push({
      kind: isMerge ? "recreate-merge" : "pick",
      commit: node.commit,
      // A root commit inside the range has no parent at all; the new base
      // stands in for the absent one, exactly as it does for the range base.
      parents: (node.parents.length ? node.parents : [null]).map((parent) =>
        parent === null ? { source: NEW_BASE, origin: null } : parentOrigin(parent, inRange),
      ),
    });
  }

  return {
    rangeBase,
    sourceHead,
    ontoHead,
    // Reported in the order they appear in the range, which is the order a
    // reader meets them in `vlab rebase-plan`.
    mergeCommits,
    unsupportedMerges,
    steps,
    linearHistory: mergeCommits.length === 0,
    supported: unsupportedMerges.length === 0,
  };
}

/**
 * The part of the topology a plan fingerprint covers: which merges are
 * recreated, and the parent mapping each one carries.
 *
 * An approval for one topology must not authorize another (ADR-0034), and the
 * topology is not derivable from `changes` — a merge is not a change, so two
 * ranges with identical replay queues can join them differently. Only the
 * merge steps are hashed: the picks are already covered commit by commit, and
 * their parent mapping is a function of the range the fingerprint pins.
 */
export function topologyFingerprintInput(topology) {
  return topology.steps
    .filter((step) => step.kind === "recreate-merge")
    .map((step) => ({
      commit: step.commit,
      parents: step.parents.map((parent) => [parent.source, parent.origin]),
    }));
}

/**
 * Resolve a step's new parents against the mapping built so far.
 *
 * This is the one place the rewrite turns an original commit into the commit
 * that replaced it, and both the forecast and the application call it, so a
 * disagreement between them is impossible by construction rather than by
 * matching code.
 *
 * A `rewritten` origin missing from the mapping is a programming error, not a
 * repository condition: topological order guarantees it was produced earlier.
 */
export function resolveStepParents(step, ontoHead, rewritten) {
  return step.parents.map((parent) => {
    if (parent.source === NEW_BASE) return { ...parent, commit: ontoHead };
    const commit = rewritten.get(parent.origin);
    if (!commit) {
      throw new CliError(
        `Rebase topology named ${parent.origin.slice(0, 12)} as a parent before it was rewritten.`,
        { code: "internal-invariant" },
      );
    }
    return { ...parent, commit };
  });
}

/**
 * The refusal a caller raises for an unsupported range. Both codes come from
 * ADR-0034's table; when a range has several unsupported merges the first one
 * names the failure and the rest are listed, because fixing one rarely fixes
 * the others and a person reading this is deciding whether to reshape history.
 */
export function unsupportedTopologyError(topology) {
  const [first, ...rest] = topology.unsupportedMerges;
  const message = `Causal rebase cannot recreate the merge ${first.commit.slice(0, 12)}.`;
  const details = [
    first.details,
    ...rest.map((item) => `${item.commit.slice(0, 12)}: ${item.details}`),
    "Reshape the history, narrow the range with --from, or use ordinary Git for this topology.",
  ].join("\n");
  // Written out rather than carried in `first.code`, because ADR-0021 asks that
  // every raise site name its own code where a reader can see it.
  return first.reason === "octopus-merge"
    ? new CliError(message, { code: "unsupported-repository-shape", details })
    : new CliError(message, { code: "unsupported-range", details });
}

/**
 * The commit message of a recreated merge.
 *
 * A recreated merge takes a **new** identity and records `Derived-From` the
 * merge it came from, uniformly and with no exception (ADR-0034). A rebase
 * replaces the parents by construction, so it is a different join even when its
 * resolution is byte-identical; preserving the original identity would assert a
 * sameness the operation cannot support. That costs nothing, because a merge
 * claims nothing and no coverage conclusion depends on matching one by
 * `Change-Id`.
 *
 * `originChangeId` is the original merge's identity, or its commit id in the
 * `git:` form this repository uses for a commit that carried no `Change-Id`.
 */
export function recreatedMergeMessage({
  subject,
  changeId,
  originChangeId,
  originCommit,
}) {
  const heading = subject?.trim() || `Merge ${originCommit.slice(0, 12)}`;
  return [
    heading,
    "",
    `Change-Id: ${changeId}`,
    `Derived-From: ${originChangeId ?? `git:${originCommit}`}`,
    `Origin-Commit: ${originCommit}`,
    "",
  ].join("\n");
}
