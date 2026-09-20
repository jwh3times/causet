import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { testEnv } from "../test-support/git-environment.js";

const cli = fileURLToPath(new URL("../bin/vlab.js", import.meta.url));

function exec(command, args, cwd, options = {}) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    env: testEnv(),
    ...options,
  }).trim();
}

const git = (cwd, ...args) => exec("git", args, cwd);

function run(cwd, ...args) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8",
    env: testEnv(),
  });
}

function vlab(cwd, ...args) {
  const result = run(cwd, ...args);
  assert.equal(result.status, 0, `${args.join(" ")}\n${result.stdout}${result.stderr}`);
  return result.stdout.trim();
}

const vlabJson = (cwd, ...args) => JSON.parse(vlab(cwd, ...args, "--json"));

function refusal(cwd, ...args) {
  const result = run(cwd, ...args, "--json");
  assert.notEqual(result.status, 0, `expected a refusal from: ${args.join(" ")}\n${result.stdout}`);
  return JSON.parse(result.stdout);
}

function write(repo, relative, content) {
  const target = path.join(repo, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function readText(repo, relative) {
  return fs.readFileSync(path.join(repo, relative), "utf8").replace(/\r\n/g, "\n");
}

/**
 * A repository with a `feature` branch to reconcile and a registered target
 * workspace holding uncommitted work. The overlay is the thing under test, so
 * the draft deliberately touches a file the incoming change does not, plus one
 * untracked file, which is the case an abort has to restore.
 */
function overlaid(t) {
  const parent = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), "vcs-lab-overlay-")),
  );
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const repo = path.join(parent, "repo");
  fs.mkdirSync(repo);
  git(repo, "init", "-b", "main");
  git(repo, "config", "core.autocrlf", "false");
  git(repo, "config", "core.eol", "lf");
  git(repo, "config", "user.name", "VCS Lab Overlay Test");
  git(repo, "config", "user.email", "vcs-lab-overlay@example.invalid");
  vlab(repo, "init");
  write(repo, "shared.txt", "base\n");
  write(repo, "target-only.txt", "base\n");
  git(repo, "add", "-A");
  vlab(repo, "commit", "-m", "base");

  git(repo, "switch", "-c", "feature");
  write(repo, "shared.txt", "from feature\n");
  git(repo, "add", "-A");
  vlab(repo, "commit", "-m", "feature change");
  git(repo, "switch", "main");

  // A registered workspace for the target, which is what a checkpoint belongs to.
  const workspace = path.join(parent, "target-ws");
  vlab(repo, "workspace", "create", "target", "--from", "main", "--path", workspace);
  return { parent, repo, workspace };
}

/** Uncommitted work in the workspace, then a checkpoint of it. */
function draftAndCheckpoint(workspace, { tracked = "draft in progress\n", untracked = true } = {}) {
  write(workspace, "target-only.txt", tracked);
  if (untracked) write(workspace, "scratch.txt", "scratch\n");
  return JSON.parse(
    exec(process.execPath, [cli, "workspace", "checkpoint", "--label", "draft", "--json"], workspace),
  );
}

// ---------------------------------------------------------------------------
// Selecting an overlay
// ---------------------------------------------------------------------------

test("an overlay is never captured on the user's behalf", (t) => {
  const { workspace } = overlaid(t);
  write(workspace, "target-only.txt", "uncaptured work\n");

  // Uncommitted work with no checkpoint is not an overlay: asking for one
  // refuses rather than quietly capturing the live bytes.
  const refused = refusal(workspace, "forecast", "feature", "--target-checkpoint");
  assert.equal(refused.code, "precondition-not-met");
  assert.match(refused.message, /checkpoint/i);
  assert.equal(readText(workspace, "target-only.txt"), "uncaptured work\n",
    "the refusal leaves the worktree exactly as it was");

  // And without the option, the live bytes are ignored as they always were.
  const plain = vlabJson(workspace, "forecast", "feature");
  assert.equal(plain.scope, "committed-heads");
  assert.equal(plain.targetOverlay ?? null, null);
  assert.ok(plain.ignoredTargetDirtyFiles >= 1);
});

test("an overlay whose base moved, or that holds no draft, is refused", (t) => {
  const { repo, workspace } = overlaid(t);
  const checkpoint = draftAndCheckpoint(workspace);
  assert.match(checkpoint.draftChangeId, /^draft_[0-9a-f]{64}$/);

  // The committed target moves out from under the checkpoint.
  write(repo, "unrelated.txt", "moved on\n");
  git(repo, "add", "-A");
  vlab(repo, "commit", "-m", "target moves on");
  git(workspace, "fetch", "--all", "--quiet");
  git(workspace, "reset", "--hard", "main", "--quiet");

  const moved = refusal(workspace, "forecast", "feature", "--target-checkpoint");
  assert.ok(["stale-input", "precondition-not-met"].includes(moved.code), moved.code);
  assert.match(moved.message, /checkpoint/i);
});

// ---------------------------------------------------------------------------
// What an overlay does and does not change
// ---------------------------------------------------------------------------

test("the plan and the committed prediction are computed as if there were no overlay", (t) => {
  const { workspace } = overlaid(t);
  // A forecast with no draft at all, for comparison.
  const bare = vlabJson(workspace, "forecast", "feature");
  draftAndCheckpoint(workspace);
  const overlaidForecast = vlabJson(workspace, "forecast", "feature", "--target-checkpoint");

  assert.equal(overlaidForecast.scope, "target-checkpoint");
  assert.equal(overlaidForecast.planFingerprint, bare.planFingerprint,
    "an overlay is uncommitted context and changes no coverage decision");
  assert.deepEqual(
    overlaidForecast.plan.changes.map((change) => [change.commit, change.status, change.proof]),
    bare.plan.changes.map((change) => [change.commit, change.status, change.proof]),
  );
  assert.equal(overlaidForecast.predictedResultTree, bare.predictedResultTree,
    "the committed predicted tree is the committed one, overlay or not");

  // The overlay is pinned by the checkpoint commit, not by its ref.
  const overlay = overlaidForecast.targetOverlay;
  assert.match(overlay.checkpoint, /^[0-9a-f]{40}$/);
  assert.match(overlay.tree, /^[0-9a-f]{40}$/);
  assert.equal(overlay.baseHead, git(workspace, "rev-parse", "HEAD"));
  assert.match(overlay.draftChangeId, /^draft_[0-9a-f]{64}$/);

  // And a second prediction exists: the worktree after re-materialization.
  assert.match(overlaidForecast.predictedOverlayTree, /^[0-9a-f]{40}$/);
  assert.notEqual(overlaidForecast.predictedOverlayTree, overlaidForecast.predictedResultTree,
    "the draft is still in the worktree afterwards, so the trees differ");
});

test("the draft identity is display and audit only", (t) => {
  const { workspace } = overlaid(t);
  const checkpoint = draftAndCheckpoint(workspace);
  const forecast = vlabJson(workspace, "forecast", "feature", "--target-checkpoint");

  // It is not a plan entry and not a coverage input.
  const planText = JSON.stringify(forecast.plan);
  assert.equal(planText.includes(checkpoint.draftChangeId), false,
    "the draft identity is not part of the plan");
  assert.equal(
    forecast.plan.changes.some((change) => change.changeId === checkpoint.draftChangeId),
    false,
  );

  // The human forecast states the overlay, its tree, and what will happen to it,
  // so the approval that follows is informed.
  const text = vlab(workspace, "forecast", "feature", "--target-checkpoint");
  assert.match(text, /overlay/i);
  assert.match(text, new RegExp(forecast.targetOverlay.tree.slice(0, 12)));
  assert.match(text, /uncommitted/i);
});

test("an overlay that does not merge with the incoming change blocks the forecast", (t) => {
  const { workspace } = overlaid(t);
  // The draft edits the same file the feature change does, in the same place.
  draftAndCheckpoint(workspace, { tracked: undefined, untracked: false });
  write(workspace, "shared.txt", "draft edits the shared file\n");
  const checkpoint = JSON.parse(
    exec(process.execPath, [cli, "workspace", "checkpoint", "--label", "conflicting", "--json"], workspace),
  );
  assert.ok(checkpoint.id);

  const blocked = run(workspace, "forecast", "feature", "--target-checkpoint", "--json");
  const forecast = JSON.parse(blocked.stdout);
  assert.notEqual(forecast.status, "complete",
    "an overlay that cannot be re-materialized is not a complete approval");
  assert.match(JSON.stringify(forecast), /overlay/i);
  assert.equal(forecast.predictedOverlayTree ?? null, null);
  // Live bytes are never merged: the worktree is untouched by forecasting.
  assert.equal(readText(workspace, "shared.txt"), "draft edits the shared file\n");
});

// ---------------------------------------------------------------------------
// Applying with an overlay
// ---------------------------------------------------------------------------

test("applying re-materializes the overlay and verifies it against the prediction", (t) => {
  const { workspace } = overlaid(t);
  draftAndCheckpoint(workspace);
  const forecast = vlabJson(workspace, "forecast", "feature", "--target-checkpoint");
  assert.equal(forecast.status, "complete");

  const result = vlabJson(workspace, "reconcile", "feature", "--use-forecast", forecast.id);

  // The committed history is exactly what a committed-heads application would
  // produce: the overlay never enters it.
  assert.equal(git(workspace, "rev-parse", "HEAD^{tree}"), forecast.predictedResultTree);
  assert.equal(readText(workspace, "shared.txt"), "from feature\n");

  // The draft is back in the worktree, uncommitted, including its untracked file.
  assert.equal(readText(workspace, "target-only.txt"), "draft in progress\n");
  assert.equal(fs.existsSync(path.join(workspace, "scratch.txt")), true);
  const status = git(workspace, "status", "--porcelain");
  assert.match(status, /target-only\.txt/);
  assert.match(status, /scratch\.txt/);

  // No receipt claims the overlay.
  const receipts = JSON.stringify(vlabJson(workspace, "receipts"));
  assert.equal(receipts.includes(forecast.targetOverlay.draftChangeId), false,
    "a receipt claims nothing about an uncommitted state");
  assert.equal(receipts.includes(forecast.targetOverlay.checkpoint), false);
  void result;
});

test("a live tree that no longer matches the overlay refuses before any mutation", (t) => {
  const { workspace } = overlaid(t);
  draftAndCheckpoint(workspace);
  const forecast = vlabJson(workspace, "forecast", "feature", "--target-checkpoint");
  const before = git(workspace, "rev-parse", "HEAD");

  // The user keeps typing after capturing the checkpoint.
  write(workspace, "target-only.txt", "draft in progress, and more\n");

  const refused = refusal(workspace, "reconcile", "feature", "--use-forecast", forecast.id);
  assert.equal(refused.code, "stale-overlay");
  assert.match(refused.details ?? "", /checkpoint/i);
  assert.equal(git(workspace, "rev-parse", "HEAD"), before, "nothing moved");
  assert.equal(readText(workspace, "target-only.txt"), "draft in progress, and more\n",
    "and the newer work is still there, uncaptured but intact");
  assert.equal(run(workspace, "reconcile", "--status", "--json").status, 0);
  assert.equal(vlabJson(workspace, "reconcile", "--status").active, false,
    "the refusal starts no operation");
});

test("an overlay whose base head moved is refused as a stale forecast", (t) => {
  const { repo, workspace } = overlaid(t);
  draftAndCheckpoint(workspace);
  const forecast = vlabJson(workspace, "forecast", "feature", "--target-checkpoint");

  // The committed target moves after the forecast was approved.
  write(repo, "later.txt", "later\n");
  git(repo, "add", "-A");
  vlab(repo, "commit", "-m", "target moves on");
  git(workspace, "fetch", "--all", "--quiet");
  git(workspace, "merge", "--ff-only", "main", "--quiet");

  const refused = refusal(workspace, "reconcile", "feature", "--use-forecast", forecast.id);
  assert.equal(refused.code, "stale-forecast");
});

// ---------------------------------------------------------------------------
// Abort
// ---------------------------------------------------------------------------

/**
 * Reach a pending operation that has an overlay in play.
 *
 * Without an approved overlay a dirty worktree is refused as it always was, so
 * the only way in is a complete forecast — and a complete forecast means the
 * application would otherwise finish. The repository's own fault injection is
 * what stops it partway: `reconcile:before-journal-advance` leaves a pick
 * committed, the overlay still reduced away, and the journal pending, which is
 * exactly the state an abort has to recover from. A later point would not do: by
 * `before-publish` the overlay has already been put back, which is the
 * contract's own ordering, so nothing would be left to restore.
 */
function pausedWithOverlay(workspace, forecastId) {
  const interrupted = spawnSync(
    process.execPath,
    [cli, "reconcile", "feature", "--use-forecast", forecastId, "--json"],
    {
      cwd: workspace,
      encoding: "utf8",
      env: testEnv({ VLAB_TEST_FAULT: "reconcile:before-journal-advance" }),
    },
  );
  assert.notEqual(interrupted.status, 0, "the fault must stop the operation");
  assert.match(interrupted.stderr, /fault injected at reconcile:before-journal-advance/);
  const status = JSON.parse(
    exec(process.execPath, [cli, "reconcile", "--status", "--json"], workspace),
  );
  assert.equal(status.active, true, "the journal still advertises the operation");
  return status;
}

test("abort restores the committed tip and the captured worktree", (t) => {
  const { workspace } = overlaid(t);
  draftAndCheckpoint(workspace);
  const forecast = vlabJson(workspace, "forecast", "feature", "--target-checkpoint");
  assert.equal(forecast.status, "complete");
  const tip = git(workspace, "rev-parse", "HEAD");

  pausedWithOverlay(workspace, forecast.id);
  // The overlay was reduced away before the picks, so the draft is not on disk
  // while the operation is pending; that is what makes the abort meaningful.
  assert.equal(fs.existsSync(path.join(workspace, "scratch.txt")), false);

  const aborted = vlabJson(workspace, "reconcile", "--abort");
  assert.equal(aborted.aborted, true);
  assert.equal(git(workspace, "rev-parse", "HEAD"), tip, "the exact committed tip returns");
  assert.equal(aborted.overlay.restored, true);
  assert.equal(aborted.overlay.checkpoint, forecast.targetOverlay.checkpoint);

  // The captured draft returns, untracked file included, because that is the
  // state the user asked to keep.
  assert.equal(readText(workspace, "target-only.txt"), "draft in progress\n");
  assert.equal(fs.existsSync(path.join(workspace, "scratch.txt")), true);
  const status = git(workspace, "status", "--porcelain");
  assert.match(status, /target-only\.txt/);
  assert.match(status, /scratch\.txt/);

  // Nothing was published: an interrupted operation leaves no receipt behind.
  assert.deepEqual(vlabJson(workspace, "receipts"), []);
});

test("abort never invents bytes for an overlay it cannot read", (t) => {
  const { workspace } = overlaid(t);
  const checkpoint = draftAndCheckpoint(workspace);
  const forecast = vlabJson(workspace, "forecast", "feature", "--target-checkpoint");
  const tip = git(workspace, "rev-parse", "HEAD");
  pausedWithOverlay(workspace, forecast.id);

  // The checkpoint and its history go away underneath the paused operation, so
  // the overlay tree is unreachable by the time abort runs.
  git(workspace, "update-ref", "-d", checkpoint.ref);
  for (const ref of git(workspace, "for-each-ref", "--format=%(refname)", "refs/vcs-lab/checkpoint-history/")
    .split(/\r?\n/).filter(Boolean)) {
    git(workspace, "update-ref", "-d", ref);
  }
  git(workspace, "reflog", "expire", "--expire=now", "--all");
  git(workspace, "gc", "--prune=now", "--quiet");

  const aborted = vlabJson(workspace, "reconcile", "--abort");
  assert.equal(aborted.aborted, true);
  assert.equal(git(workspace, "rev-parse", "HEAD"), tip,
    "abort's first duty is the committed tip, and it is unconditional");
  assert.equal(aborted.overlay.restored, false);
  assert.match(aborted.overlay.reason, /unavailable/i);
  // Left clean rather than half-written: no bytes were invented for a tree that
  // could not be read.
  assert.equal(git(workspace, "status", "--porcelain"), "");
});

// ---------------------------------------------------------------------------
// Carrying an overlay through a causal rebase (ADR-0028 decision 5)
// ---------------------------------------------------------------------------

/**
 * A repository whose `main` has moved on, and a registered workspace holding one
 * commit of its own to rebase onto it.
 *
 * The onto side deliberately edits a file the workspace's commit does not touch,
 * so the rebase changes the committed tree. That is what makes re-materialization
 * observable: writing the checkpoint tree back over the rewritten tip would
 * restore the pre-rebase content of exactly that file.
 */
function rebasable(t) {
  const parent = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), "vcs-lab-overlay-rb-")),
  );
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const repo = path.join(parent, "repo");
  fs.mkdirSync(repo);
  git(repo, "init", "-b", "main");
  git(repo, "config", "core.autocrlf", "false");
  git(repo, "config", "core.eol", "lf");
  git(repo, "config", "user.name", "VCS Lab Overlay Test");
  git(repo, "config", "user.email", "vcs-lab-overlay@example.invalid");
  vlab(repo, "init");
  write(repo, "shared.txt", "base\n");
  git(repo, "add", "-A");
  vlab(repo, "commit", "-m", "base");

  // The branch to be rebased, in its own registered workspace.
  const workspace = path.join(parent, "feature-ws");
  vlab(repo, "workspace", "create", "feature", "--from", "main", "--path", workspace);
  write(workspace, "feature-only.txt", "feature work\n");
  git(workspace, "add", "-A");
  vlab(workspace, "commit", "-m", "feature work");

  // `main` moves on, touching a file the feature commit leaves alone.
  write(repo, "shared.txt", "advanced by main\n");
  git(repo, "add", "-A");
  vlab(repo, "commit", "-m", "main advances");
  return { parent, repo, workspace };
}

/**
 * The draft a rebase carries: a tracked edit to the branch's own file plus one
 * untracked file, captured as a checkpoint. `shared.txt` is deliberately left
 * alone, so the draft and the incoming base do not contend for it.
 */
function rebaseDraft(workspace, tracked = "feature work, still drafting\n") {
  write(workspace, "feature-only.txt", tracked);
  write(workspace, "scratch.txt", "scratch\n");
  return JSON.parse(
    exec(process.execPath, [cli, "workspace", "checkpoint", "--label", "draft", "--json"], workspace),
  );
}

test("a rebase forecast carries a caller checkpoint as an overlay", (t) => {
  const { workspace } = rebasable(t);
  // No draft at all, for comparison.
  const bare = vlabJson(workspace, "rebase-forecast", "main");
  assert.equal(bare.scope, "committed-heads");
  assert.equal(bare.targetOverlay ?? null, null);

  const checkpoint = rebaseDraft(workspace);
  const forecast = vlabJson(workspace, "rebase-forecast", "main", "--target-checkpoint");
  assert.equal(forecast.status, "complete");
  assert.equal(forecast.scope, "target-checkpoint");

  // An overlay is uncommitted context: it changes no coverage decision, and the
  // committed prediction is the committed one.
  assert.equal(forecast.planFingerprint, bare.planFingerprint,
    "an overlay changes no coverage decision");
  assert.equal(forecast.predictedResultTree, bare.predictedResultTree);
  assert.deepEqual(forecast.plan.changes, bare.plan.changes);

  // The overlay is pinned by the checkpoint commit, and a second tree is
  // predicted: the worktree after the draft is put back on the rewritten tip.
  assert.equal(forecast.targetOverlay.checkpoint, checkpoint.id);
  assert.equal(forecast.targetOverlay.tree, checkpoint.tree);
  assert.equal(forecast.targetOverlay.baseHead, git(workspace, "rev-parse", "HEAD"));
  assert.equal(forecast.targetOverlay.rematerialized, "uncommitted");
  assert.match(forecast.predictedOverlayTree, /^[0-9a-f]{40}$/);
  assert.notEqual(forecast.predictedOverlayTree, forecast.predictedResultTree,
    "the draft is still in the worktree afterwards, so the trees differ");
  // Four distinct trees, which is what keeps this scenario honest: the rebase
  // moves the committed tree, so the identical-tree shortcut cannot fire and the
  // predicted overlay really is the product of a three-way merge.
  assert.equal(
    new Set([
      forecast.sourceTree,
      forecast.predictedResultTree,
      forecast.targetOverlay.tree,
      forecast.predictedOverlayTree,
    ]).size,
    4,
  );

  // Repeating the forecast reproduces both predictions and the fingerprint,
  // which is what makes an approval about the repository rather than about the
  // moment it was taken (ADR-0028 acceptance evidence).
  const again = vlabJson(workspace, "rebase-forecast", "main", "--target-checkpoint");
  assert.equal(again.planFingerprint, forecast.planFingerprint);
  assert.equal(again.predictedResultTree, forecast.predictedResultTree);
  assert.equal(again.predictedOverlayTree, forecast.predictedOverlayTree);
  assert.equal(again.targetOverlay.checkpoint, forecast.targetOverlay.checkpoint);

  // The draft identity is display and audit only.
  assert.equal(JSON.stringify(forecast.plan).includes(checkpoint.draftChangeId), false,
    "the draft identity is not part of the plan");

  // And the human forecast states the overlay, its tree, and what becomes of it,
  // so the approval that follows is informed.
  const text = vlab(workspace, "rebase-forecast", "main", "--target-checkpoint");
  assert.match(text, /overlay/i);
  assert.match(text, new RegExp(forecast.targetOverlay.tree.slice(0, 12)));
  assert.match(text, /uncommitted/i);
  assert.match(text, /carried as the overlay/,
    "with an overlay the dirty files are the pinned draft, not ignored bytes");

  // Forecasting changed nothing on disk.
  assert.equal(readText(workspace, "feature-only.txt"), "feature work, still drafting\n");
  assert.equal(fs.existsSync(path.join(workspace, "scratch.txt")), true);
});

test("a rebase re-materializes the overlay without undoing the rebase", (t) => {
  const { workspace } = rebasable(t);
  rebaseDraft(workspace);
  const forecast = vlabJson(workspace, "rebase-forecast", "main", "--target-checkpoint");
  assert.equal(forecast.status, "complete");
  const mainHead = git(workspace, "rev-parse", "main");

  const result = vlabJson(workspace, "rebase", "main", "--use-forecast", forecast.id);

  // The committed history is exactly what a committed-heads rebase would
  // produce: the branch sits on the new base and the overlay is not in it.
  assert.equal(git(workspace, "rev-parse", "HEAD^"), mainHead);
  assert.equal(git(workspace, "rev-parse", "HEAD^{tree}"), forecast.predictedResultTree);
  assert.equal(git(workspace, "show", "HEAD:shared.txt"), "advanced by main");

  // This is the assertion the whole contract turns on. A checkpoint captures the
  // *whole* worktree at its base, so writing that tree back would restore the
  // pre-rebase `shared.txt` and silently undo what the rebase replayed onto.
  assert.equal(readText(workspace, "shared.txt"), "advanced by main\n",
    "re-materialization is a three-way merge, not a tree write");

  // The draft is back, uncommitted, untracked file included.
  assert.equal(readText(workspace, "feature-only.txt"), "feature work, still drafting\n");
  assert.equal(fs.existsSync(path.join(workspace, "scratch.txt")), true);
  const status = git(workspace, "status", "--porcelain");
  assert.match(status, /feature-only\.txt/);
  assert.match(status, /scratch\.txt/);

  // The command reports what became of the overlay, and verified it against the
  // prediction before publishing anything.
  assert.equal(result.targetOverlay.checkpoint, forecast.targetOverlay.checkpoint);
  assert.equal(result.targetOverlay.rematerialized, true);
  assert.equal(result.targetOverlay.tree, forecast.predictedOverlayTree);

  // No receipt claims the overlay.
  const receipts = JSON.stringify(vlabJson(workspace, "receipts"));
  assert.equal(receipts.includes(forecast.targetOverlay.draftChangeId), false,
    "a receipt claims nothing about an uncommitted state");
  assert.equal(receipts.includes(forecast.targetOverlay.checkpoint), false);
  assert.equal(vlabJson(workspace, "rebase", "--status").active, false);
});

test("a rebase refuses a drifted overlay before any mutation", (t) => {
  const { workspace } = rebasable(t);
  rebaseDraft(workspace);
  const forecast = vlabJson(workspace, "rebase-forecast", "main", "--target-checkpoint");
  const before = git(workspace, "rev-parse", "HEAD");

  // The user keeps typing after capturing the checkpoint.
  write(workspace, "feature-only.txt", "feature work, still drafting, and more\n");

  const refused = refusal(workspace, "rebase", "main", "--use-forecast", forecast.id);
  assert.equal(refused.code, "stale-overlay");
  assert.equal(git(workspace, "rev-parse", "HEAD"), before, "nothing moved");
  assert.equal(readText(workspace, "feature-only.txt"),
    "feature work, still drafting, and more\n",
    "and the newer work is still there, uncaptured but intact");
  assert.equal(vlabJson(workspace, "rebase", "--status").active, false,
    "the refusal starts no operation");

  // A dirty caller with no approved overlay is refused exactly as it always was.
  const plain = refusal(workspace, "rebase", "main");
  assert.equal(plain.code, "dirty-worktree");
});

test("aborting a rebase restores the original tip and the captured worktree", (t) => {
  const { workspace } = rebasable(t);
  rebaseDraft(workspace);
  const forecast = vlabJson(workspace, "rebase-forecast", "main", "--target-checkpoint");
  assert.equal(forecast.status, "complete");
  const tip = git(workspace, "rev-parse", "HEAD");

  // A complete forecast means the rebase would otherwise finish, so the only way
  // to a pending operation with the overlay still reduced away is the
  // repository's own fault injection. A later point would not do: by
  // `before-publish` the overlay has already been put back, which is the
  // contract's own ordering, so nothing would be left to restore.
  const interrupted = spawnSync(
    process.execPath,
    [cli, "rebase", "main", "--use-forecast", forecast.id, "--json"],
    {
      cwd: workspace,
      encoding: "utf8",
      env: testEnv({ VLAB_TEST_FAULT: "rebase:before-journal-advance" }),
    },
  );
  assert.notEqual(interrupted.status, 0, "the fault must stop the operation");
  assert.match(interrupted.stderr, /fault injected at rebase:before-journal-advance/);
  assert.equal(vlabJson(workspace, "rebase", "--status").active, true);
  assert.equal(fs.existsSync(path.join(workspace, "scratch.txt")), false,
    "the overlay was reduced away before the picks, which is what makes the abort meaningful");

  const aborted = vlabJson(workspace, "rebase", "--abort");
  assert.equal(aborted.aborted, true);
  assert.equal(aborted.restoredHead, tip, "the exact original tip returns");
  assert.equal(git(workspace, "rev-parse", "HEAD"), tip);
  assert.equal(aborted.overlay.restored, true);
  assert.equal(aborted.overlay.checkpoint, forecast.targetOverlay.checkpoint);

  // The captured draft returns, untracked file included, and nothing was
  // published.
  assert.equal(readText(workspace, "feature-only.txt"), "feature work, still drafting\n");
  assert.equal(fs.existsSync(path.join(workspace, "scratch.txt")), true);
  assert.match(git(workspace, "status", "--porcelain"), /scratch\.txt/);
  assert.equal(
    vlabJson(workspace, "receipts").some((receipt) => receipt.type === "rebase"),
    false,
    "an interrupted rebase leaves no summary receipt behind",
  );
});

test("an overlay that does not merge with the rewritten tip blocks the rebase forecast", (t) => {
  const { workspace } = rebasable(t);
  // The draft edits the same file `main` advanced, in the same place.
  write(workspace, "shared.txt", "the draft edits the shared file\n");
  exec(process.execPath, [cli, "workspace", "checkpoint", "--label", "conflicting", "--json"], workspace);

  const blocked = run(workspace, "rebase-forecast", "main", "--target-checkpoint", "--json");
  const forecast = JSON.parse(blocked.stdout);
  assert.equal(forecast.status, "blocked-target-overlay",
    "an overlay that cannot be re-materialized is not a complete approval");
  assert.equal(forecast.blockedReason, "target-overlay-conflict");
  assert.equal(forecast.predictedOverlayTree ?? null, null);
  assert.equal(forecast.predictedResultTree ?? null, null);
  assert.ok(forecast.targetOverlayConflict);

  // Live bytes are never merged: the worktree is untouched by forecasting.
  assert.equal(readText(workspace, "shared.txt"), "the draft edits the shared file\n");

  // And an incomplete forecast is not an approval.
  const refused = refusal(workspace, "rebase", "main", "--use-forecast", forecast.id);
  assert.equal(refused.code, "operation-state-invalid");
  assert.equal(vlabJson(workspace, "rebase", "--status").active, false);
});

test("the human result of an application states what became of the overlay", (t) => {
  // An overlay is reported and never published, so the command's own answer is
  // the only place a reader learns the draft is back. Both applications that can
  // carry one say it, in the same words.
  const reconciled = overlaid(t);
  draftAndCheckpoint(reconciled.workspace);
  const reconcileForecast = vlabJson(
    reconciled.workspace, "forecast", "feature", "--target-checkpoint",
  );
  const reconcileText = vlab(
    reconciled.workspace, "reconcile", "feature", "--use-forecast", reconcileForecast.id,
  );
  assert.match(
    reconcileText,
    new RegExp(`overlay\\s+checkpoint ${reconcileForecast.targetOverlay.checkpoint.slice(0, 12)} re-materialized uncommitted`),
  );

  const rebased = rebasable(t);
  rebaseDraft(rebased.workspace);
  const rebaseForecast = vlabJson(
    rebased.workspace, "rebase-forecast", "main", "--target-checkpoint",
  );
  const rebaseText = vlab(
    rebased.workspace, "rebase", "main", "--use-forecast", rebaseForecast.id,
  );
  assert.match(
    rebaseText,
    new RegExp(`overlay\\s+checkpoint ${rebaseForecast.targetOverlay.checkpoint.slice(0, 12)} re-materialized uncommitted`),
  );

  // And an application without one says nothing about overlays at all.
  const plain = overlaid(t);
  const plainForecast = vlabJson(plain.workspace, "forecast", "feature");
  const plainText = vlab(
    plain.workspace, "reconcile", "feature", "--use-forecast", plainForecast.id,
  );
  assert.equal(/overlay/i.test(plainText), false);
});

// ---------------------------------------------------------------------------
// Abort is reachable from a re-materialization mismatch
// ---------------------------------------------------------------------------

/**
 * Break the overlay tree a stored forecast pins, so re-materialization cannot
 * match it.
 *
 * Every input the mismatch could otherwise come from — a moved head, a moved
 * draft, a missing checkpoint — is refused by `assertOverlayCurrent` before the
 * application starts, which is the contract working. Corrupting the pinned
 * prediction is therefore the one way left to reach the state ADR-0028 names,
 * and it exercises exactly the comparison under test.
 */
function breakPredictedOverlayTree(worktree, forecastId) {
  const gitDir = git(worktree, "rev-parse", "--git-dir");
  const root = path.isAbsolute(gitDir) ? gitDir : path.join(worktree, gitDir);
  const file = path.join(root, "vcs-lab", "forecasts", `${forecastId}.json`);
  const stored = JSON.parse(fs.readFileSync(file, "utf8"));
  stored.predictedOverlayTree = "0".repeat(40);
  fs.writeFileSync(file, JSON.stringify(stored, null, 2));
}

test("abort recovers from a re-materialization mismatch on both applications", (t) => {
  // The worktree is dirty in this state, and it is dirty because the operation
  // itself put the merged draft back before comparing it. Abort is what the
  // contract and the refusal both name as the recovery, so the clean check must
  // not be what stops it.
  const reconciled = overlaid(t);
  draftAndCheckpoint(reconciled.workspace);
  const reconcileForecast = vlabJson(
    reconciled.workspace, "forecast", "feature", "--target-checkpoint",
  );
  const reconcileTip = git(reconciled.workspace, "rev-parse", "HEAD");
  breakPredictedOverlayTree(reconciled.workspace, reconcileForecast.id);

  const reconcileRefusal = refusal(
    reconciled.workspace, "reconcile", "feature", "--use-forecast", reconcileForecast.id,
  );
  assert.equal(reconcileRefusal.code, "stale-forecast");
  assert.match(reconcileRefusal.details, /Nothing was published/);
  assert.match(reconcileRefusal.details, /vlab reconcile --abort/);
  assert.equal(vlabJson(reconciled.workspace, "reconcile", "--status").state, "forecast-mismatch");
  assert.notEqual(git(reconciled.workspace, "status", "--porcelain"), "",
    "the operation left the merged draft on disk, which is what makes this the hard case");

  const reconcileAbort = vlabJson(reconciled.workspace, "reconcile", "--abort");
  assert.equal(reconcileAbort.aborted, true);
  assert.equal(git(reconciled.workspace, "rev-parse", "HEAD"), reconcileTip);
  assert.equal(reconcileAbort.overlay.restored, true);
  assert.equal(readText(reconciled.workspace, "target-only.txt"), "draft in progress\n");
  assert.equal(fs.existsSync(path.join(reconciled.workspace, "scratch.txt")), true);
  assert.deepEqual(vlabJson(reconciled.workspace, "receipts"), [],
    "a refused re-materialization publishes nothing");

  const rebased = rebasable(t);
  rebaseDraft(rebased.workspace);
  const rebaseForecast = vlabJson(
    rebased.workspace, "rebase-forecast", "main", "--target-checkpoint",
  );
  const rebaseTip = git(rebased.workspace, "rev-parse", "HEAD");
  breakPredictedOverlayTree(rebased.workspace, rebaseForecast.id);

  const rebaseRefusal = refusal(
    rebased.workspace, "rebase", "main", "--use-forecast", rebaseForecast.id,
  );
  assert.equal(rebaseRefusal.code, "stale-forecast");
  assert.match(rebaseRefusal.details, /Nothing was published/);
  assert.match(rebaseRefusal.details, /vlab rebase --abort/);
  assert.equal(vlabJson(rebased.workspace, "rebase", "--status").state, "forecast-mismatch");

  const rebaseAbort = vlabJson(rebased.workspace, "rebase", "--abort");
  assert.equal(rebaseAbort.aborted, true);
  assert.equal(rebaseAbort.restoredHead, rebaseTip);
  assert.equal(rebaseAbort.overlay.restored, true);
  assert.equal(readText(rebased.workspace, "feature-only.txt"), "feature work, still drafting\n");
  assert.equal(fs.existsSync(path.join(rebased.workspace, "scratch.txt")), true);
  assert.equal(
    vlabJson(rebased.workspace, "receipts").some((receipt) => receipt.type === "rebase"),
    false,
  );

  // The clean check is skipped only in that one journaled state. An ordinary
  // pending operation with a hand-edited worktree still refuses.
  const guarded = rebasable(t);
  rebaseDraft(guarded.workspace);
  const guardedForecast = vlabJson(
    guarded.workspace, "rebase-forecast", "main", "--target-checkpoint",
  );
  const interrupted = spawnSync(
    process.execPath,
    [cli, "rebase", "main", "--use-forecast", guardedForecast.id, "--json"],
    {
      cwd: guarded.workspace,
      encoding: "utf8",
      env: testEnv({ VLAB_TEST_FAULT: "rebase:before-journal-advance" }),
    },
  );
  assert.notEqual(interrupted.status, 0);
  write(guarded.workspace, "hand-edited.txt", "the user's own work\n");
  const guardedRefusal = refusal(guarded.workspace, "rebase", "--abort");
  assert.equal(guardedRefusal.code, "dirty-worktree");
  assert.equal(readText(guarded.workspace, "hand-edited.txt"), "the user's own work\n");
});
