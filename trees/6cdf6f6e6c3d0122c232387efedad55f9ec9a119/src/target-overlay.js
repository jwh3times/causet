import fs from "node:fs";
import path from "node:path";
import { GIT_NO_RERERE, runGit } from "./git.js";
import {
  inspectGitObjects,
  repoContext,
  resolveObjectIds,
  treeId,
  treePaths,
} from "./engine.js";
import { CliError } from "./errors.js";
import { temporaryDirectory } from "./store.js";
import { latestWorkspaceCheckpoint, listWorkspaces } from "./workspaces.js";

/**
 * A target overlay is the uncommitted work a target workspace has captured in a
 * checkpoint, carried through an application and put back afterwards
 * (ADR-0028).
 *
 * The distinction the whole contract rests on: an overlay is *context*, never a
 * committed draft. It is not a plan entry, not a coverage input, and not a
 * receipt subject, so nothing an overlay contains can change what a plan
 * concludes or what a receipt claims. It is identified by its checkpoint commit
 * OID rather than by the checkpoint ref, because the ref moves when the next
 * checkpoint is captured and the forecast must keep pointing at what was
 * approved.
 *
 * Live bytes are never read as causal state. Everything here works from the
 * checkpoint's tree; the live worktree is compared against it and otherwise left
 * alone.
 */

/**
 * The overlay a `--target-checkpoint` forecast is about, or a refusal saying
 * why there is none. Nothing is captured on the user's behalf: uncommitted work
 * with no checkpoint is not an overlay, because capturing it silently would make
 * live bytes into approved state.
 */
export function resolveTargetOverlay(cwd = process.cwd()) {
  const context = repoContext(cwd);
  const here = path.resolve(cwd);
  const workspace = listWorkspaces(context.root).find(
    (candidate) => path.resolve(candidate.path ?? "") === here,
  );
  if (!workspace) {
    throw new CliError(
      "A target checkpoint needs a registered workspace, and this worktree is not one.",
      {
        code: "precondition-not-met",
        details:
          "Create one with 'vlab workspace create', or forecast without " +
          "--target-checkpoint to ignore uncommitted work as before.",
      },
    );
  }
  const checkpoint = latestWorkspaceCheckpoint(workspace, context.root);
  if (!checkpoint) {
    throw new CliError(
      `Workspace '${workspace.name}' has no checkpoint to carry as a target overlay.`,
      {
        code: "precondition-not-met",
        details:
          "Capture one with 'vlab workspace checkpoint'. Uncommitted work is never " +
          "captured on your behalf, because an overlay is state you approved.",
      },
    );
  }
  const [head] = resolveObjectIds(["HEAD^{commit}"], cwd);
  if (checkpoint.baseHead !== head) {
    throw new CliError(
      `Checkpoint '${checkpoint.id.slice(0, 12)}' was captured on ${checkpoint.baseHead.slice(0, 12)}, but this worktree is on ${head.slice(0, 12)}.`,
      {
        code: "stale-input",
        details: "Capture a new checkpoint before forecasting it as a target overlay.",
      },
    );
  }
  if (checkpoint.tree === treeId(head, cwd)) {
    throw new CliError(
      `Checkpoint '${checkpoint.id.slice(0, 12)}' holds no draft beyond the committed head, so there is no overlay to carry.`,
      { code: "precondition-not-met" },
    );
  }
  return {
    checkpoint: checkpoint.id,
    tree: checkpoint.tree,
    baseHead: checkpoint.baseHead,
    draftChangeId: checkpoint.draftChangeId,
    workspaceId: workspace.id,
    workspaceName: workspace.name,
  };
}

/**
 * The tree the worktree will hold after the overlay is put back: a three-way
 * merge of the target tree before application (base), the committed result tree
 * (ours), and the overlay tree (theirs).
 *
 * Returns `{ tree }` on a clean merge and `{ conflict }` otherwise. A conflict is
 * the forecast's own blocking reason rather than something to resolve: ADR-0028
 * decision 2 keeps resolution memory out of this version, because a resolution
 * recorded against an uncommitted overlay would be a causal fact about something
 * that was never committed.
 */
export function predictOverlayTree({ baseTree, resultTree, overlayTree }, cwd = process.cwd()) {
  if (resultTree === baseTree) return { tree: overlayTree, conflict: null };
  const merged = runGit(["merge-tree", "--write-tree", "--merge-base", baseTree, resultTree, overlayTree], {
    cwd,
    allowFailure: true,
  });
  if (!merged.ok) {
    return {
      tree: null,
      conflict: {
        reason: "target-overlay-conflict",
        details: merged.output?.trim() || merged.stderr?.trim() || "The overlay does not merge with the committed result.",
      },
    };
  }
  const [tree] = merged.stdout.split(/\r?\n/).filter(Boolean);
  if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(tree ?? "")) {
    return {
      tree: null,
      conflict: { reason: "target-overlay-conflict", details: merged.stdout.trim() },
    };
  }
  return { tree, conflict: null };
}

/**
 * The tree the live worktree currently holds, written through the same temporary
 * index a checkpoint capture uses, so the comparison with an overlay tree is
 * like for like. Ignored files are outside both trees and do not participate.
 */
export function liveWorktreeTree(cwd = process.cwd()) {
  const scratch = temporaryDirectory("vlab-overlay-index-");
  const env = { GIT_INDEX_FILE: path.join(scratch, "index") };
  try {
    runGit(["read-tree", "HEAD"], { cwd, env });
    runGit(["add", "--all", "."], { cwd, env });
    return runGit(["write-tree"], { cwd, env }).stdout;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Refuse to act on a forecast whose overlay no longer describes this worktree.
 *
 * Two different refusals, because they have different remedies. A moved base
 * head or an unreadable checkpoint is `stale-forecast`: the approved plan is
 * about a repository state that is gone. A live tree that drifted from the
 * overlay is `stale-overlay`: the plan is fine and the *capture* is behind, so
 * the fix is a new checkpoint. Neither re-captures anything, because an
 * approval must cover the bytes that will actually be put back.
 */
export function assertOverlayCurrent(overlay, cwd = process.cwd()) {
  const [head] = resolveObjectIds(["HEAD^{commit}"], cwd);
  if (overlay.baseHead !== head) {
    throw new CliError(
      `The approved target overlay was captured on ${overlay.baseHead.slice(0, 12)}, but this worktree is on ${head.slice(0, 12)}.`,
      {
        code: "stale-forecast",
        details: "Capture a new checkpoint and forecast again.",
      },
    );
  }
  // `inspectGitObjects` tolerates absence; `resolveObjectIds` would throw a bare
  // resolution error, and an overlay that has been garbage collected is a
  // staleness answer rather than a malformed expression.
  const [object] = inspectGitObjects([`${overlay.checkpoint}^{commit}`], cwd);
  if (!object?.exists || object.type !== "commit") {
    throw new CliError(
      `The approved target overlay checkpoint ${overlay.checkpoint.slice(0, 12)} is no longer in this repository.`,
      {
        code: "stale-forecast",
        details: "Capture a new checkpoint and forecast again.",
      },
    );
  }
  const live = liveWorktreeTree(cwd);
  if (live !== overlay.tree) {
    throw new CliError(
      "The worktree has changed since the target overlay was captured.",
      {
        code: "stale-overlay",
        details: [
          `Overlay checkpoint tree: ${overlay.tree}`,
          `Live worktree tree:      ${live}`,
          "Capture a new checkpoint with 'vlab workspace checkpoint' and forecast again.",
          "Nothing was changed, and no work was re-captured on your behalf.",
        ].join("\n"),
      },
    );
  }
}

/**
 * Put the overlay back into the worktree without committing it.
 *
 * What goes back is **not** the overlay tree. A checkpoint captures the whole
 * worktree at its base, so writing that tree over the applied result would
 * restore the pre-application version of every path the application touched and
 * quietly undo the work. What goes back is the three-way merge the forecast
 * predicted — base the target tree before application, ours the committed
 * result, theirs the overlay — which keeps the applied changes and re-applies
 * only the draft on top.
 *
 * The files are written through a temporary index, so the real index stays at the
 * committed head and the draft reads as uncommitted work exactly as it did when
 * the user captured it. A path in neither the merged tree nor the committed tree
 * is never touched, and ignored files are in neither.
 */
export function materializeOverlay(overlay, { baseTree, resultTree }, cwd = process.cwd()) {
  const merged = predictOverlayTree(
    { baseTree, resultTree, overlayTree: overlay.tree },
    cwd,
  );
  if (merged.conflict) return { tree: null, conflict: merged.conflict };
  const scratch = temporaryDirectory("vlab-overlay-restore-");
  const env = { GIT_INDEX_FILE: path.join(scratch, "index") };
  try {
    runGit(["read-tree", merged.tree], { cwd, env });
    runGit([...GIT_NO_RERERE, "checkout-index", "--all", "--force"], { cwd, env });
    return { tree: liveWorktreeTree(cwd), conflict: null };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Reduce the worktree to the committed head so the application runs on the same
 * tree a committed-heads application would, with the overlay already safe in its
 * checkpoint (ADR-0028).
 *
 * The reset handles tracked modifications. The overlay's untracked files are
 * removed individually, and only those: a path is deleted here exactly when the
 * overlay tree holds it and the committed tree does not, which is the same rule
 * abort uses in reverse. A file in neither tree is the user's own, which is why
 * this does not reach for `git clean`.
 */
export function reduceToCommittedHead(overlay, cwd = process.cwd()) {
  const [head] = resolveObjectIds(["HEAD^{commit}"], cwd);
  const committed = new Set(treePaths(treeId(head, cwd), cwd));
  const removed = [];
  for (const relative of treePaths(overlay.tree, cwd)) {
    if (committed.has(relative)) continue;
    const target = path.join(cwd, relative);
    if (fs.existsSync(target)) {
      fs.rmSync(target, { force: true });
      removed.push(relative);
    }
  }
  runGit(["reset", "--hard", head], { cwd });
  return { head, removedOverlayOnlyPaths: removed };
}

/**
 * Put a captured overlay back after an abort, which is a different job from
 * re-materializing one after an application: the committed tip has been restored
 * to exactly what it was, so the overlay tree *is* the state the user asked to
 * keep and no merge is involved.
 *
 * An overlay whose object is gone is reported rather than guessed at. Abort's
 * first duty is the committed tip, which is already restored by the time this
 * runs, so a missing checkpoint costs the draft and nothing else — and inventing
 * bytes for it would be worse than saying so.
 */
export function restoreOverlayAfterAbort(overlay, cwd = process.cwd()) {
  if (!overlay?.checkpoint || !overlay?.tree) {
    return { restored: false, reason: "no overlay was recorded for this operation" };
  }
  const [object] = inspectGitObjects([overlay.tree], cwd);
  if (!object?.exists || object.type !== "tree") {
    return {
      restored: false,
      checkpoint: overlay.checkpoint,
      reason:
        `the overlay tree ${overlay.tree.slice(0, 12)} is unavailable, so the captured ` +
        "draft could not be restored; the committed tip is correct and the worktree is clean",
    };
  }
  const scratch = temporaryDirectory("vlab-overlay-abort-");
  const env = { GIT_INDEX_FILE: path.join(scratch, "index") };
  try {
    runGit(["read-tree", overlay.tree], { cwd, env });
    runGit([...GIT_NO_RERERE, "checkout-index", "--all", "--force"], { cwd, env });
    return { restored: true, checkpoint: overlay.checkpoint, tree: liveWorktreeTree(cwd) };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
