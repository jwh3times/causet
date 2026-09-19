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
