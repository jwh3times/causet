import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
/**
 * The Windows MAX_PATH boundary for retained resolution refs, whose lock path
 * is `<common git dir>/refs/causet/resolutions/rsig_<64>/<blob>.lock`. The
 * fixtures put that path at 259 or 260 characters. Until #243 the first three
 * cases called the JavaScript publisher directly; they now publish through a
 * conflicted `cst reconcile --continue`, which measures the same path.
 */
import { testEnv } from "../test-support/git-environment.js";
import { cstCommand, cstPrefix } from "../test-support/cst-command.js";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, env: testEnv(), encoding: "utf8" }).trim();
}

function fixture(t, rootLength, objectFormat = "sha1") {
  const parent = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "vlab-path-")));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  assert.ok(parent.length + 2 <= rootLength, "TEMP must leave space for the measured path fixture");
  const repo = path.join(parent, "r".repeat(rootLength - parent.length - 1));
  fs.mkdirSync(repo);
  git(repo, "init", "-b", "main", `--object-format=${objectFormat}`);
  git(repo, "config", "core.longpaths", "false");
  git(repo, "config", "core.autocrlf", "false");
  git(repo, "config", "user.name", "Path Test");
  git(repo, "config", "user.email", "path@example.invalid");
  fs.writeFileSync(path.join(repo, "a.txt"), "base\n");
  git(repo, "add", "a.txt");
  git(repo, "commit", "-m", "base");
  return { repo, parent };
}

const cst = (cwd, ...args) => spawnSync(cstCommand, [...cstPrefix(), ...args], { cwd, env: testEnv(), encoding: "utf8" });

/**
 * In `cwd`, conflict `a.txt` between a new branch `name` and the checked-out
 * branch, pause a reconciliation on it, and stage a resolution: new content,
 * or the file's deletion. Returns the result of `reconcile --continue`, which
 * publishes the resolution, with its parsed stdout.
 */
function publish(cwd, name, { remove = false } = {}) {
  const start = git(cwd, "rev-parse", "HEAD");
  git(cwd, "switch", "-c", name);
  fs.writeFileSync(path.join(cwd, "a.txt"), `${name} source\n`);
  git(cwd, "commit", "-am", `${name} source`);
  git(cwd, "switch", "-");
  fs.writeFileSync(path.join(cwd, "a.txt"), `${name} target\n`);
  git(cwd, "commit", "-am", `${name} target`);
  assert.notEqual(git(cwd, "rev-parse", "HEAD"), start);
  assert.equal(JSON.parse(cst(cwd, "reconcile", name, "--json").stdout).code, "conflict-paused");
  if (remove) git(cwd, "rm", "-q", "a.txt");
  else {
    fs.writeFileSync(path.join(cwd, "a.txt"), `${name} resolved\n`);
    git(cwd, "add", "a.txt");
  }
  const result = cst(cwd, "reconcile", "--continue", "--json");
  return { ...result, value: JSON.parse(result.stdout) };
}

/** Give up a reconciliation `publish` left paused, and put `a.txt` back. */
function abandon(cwd) {
  assert.equal(cst(cwd, "reconcile", "--abort", "--json").status, 0);
  if (!fs.existsSync(path.join(cwd, "a.txt"))) git(cwd, "checkout", "--", "a.txt");
}

test("resolution retention diagnoses the Windows lock-path boundary and supports long paths", (t) => {
  const short = fixture(t, 114).repo;
  assert.equal(publish(short, "short").status, 0);
  const { repo, parent } = fixture(t, 115);
  const linked = path.join(parent, "linked");
  git(repo, "worktree", "add", "-b", "linked", linked);
  // A short linked worktree still stores shared refs in the long common dir.
  const failed = publish(linked, "long");
  if (process.platform !== "win32") {
    assert.equal(failed.status, 0, failed.stdout + failed.stderr);
    return;
  }
  assert.equal(failed.status, 1);
  assert.equal(failed.value.code, "path-length-exceeded");
  assert.match(failed.value.message, /260 characters.*259/);
  assert.match(failed.value.details, /at least 1 characters/);
  assert.ok(failed.value.details.includes(path.join(repo, ".git", "refs")));
  assert.equal(git(repo, "for-each-ref", "refs/causet/resolutions"), "");
  abandon(linked);
  // A deletion has a shorter ref suffix and must not be rejected by root length.
  assert.equal(publish(linked, "deletion", { remove: true }).status, 0);
  git(repo, "config", "core.longpaths", "true");
  fs.writeFileSync(path.join(linked, "a.txt"), "restored\n");
  git(linked, "add", "a.txt");
  git(linked, "commit", "-m", "restore a.txt");
  assert.equal(publish(linked, "longpaths").status, 0);
});

test("SHA-256 resolution failures measure the longer object ID in the ref path", (t) => {
  const { repo } = fixture(t, 115, "sha256");
  const failed = publish(repo, "sha256");
  if (process.platform !== "win32") {
    assert.equal(failed.status, 0, failed.stdout + failed.stderr);
    const [ref] = git(repo, "for-each-ref", "--format=%(refname)", "refs/causet/resolutions").split("\n");
    assert.equal(ref.split("/").at(-1).length, 64);
    return;
  }
  assert.equal(failed.status, 1);
  assert.equal(failed.value.code, "path-length-exceeded");
  assert.match(failed.value.message, /284 characters/);
  assert.match(failed.value.details, /at least 25 characters/);
});

test("an existing resolution lock retains the Git error classification", (t) => {
  const length = process.platform === "win32" ? 114 : 160;
  // Identical content gives a twin the same blobs, and so the same resolution
  // ref, which names the lock to hold in the repository under test.
  const twin = fixture(t, length).repo;
  git(twin, "config", "core.longpaths", "true");
  assert.equal(publish(twin, "locked").status, 0);
  const [ref] = git(twin, "for-each-ref", "--format=%(refname)", "refs/causet/resolutions").split("\n");
  const { repo } = fixture(t, length);
  git(repo, "config", "core.longpaths", "true");
  const lock = path.join(repo, ".git", ...ref.split("/")) + ".lock";
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, "");
  const failed = publish(repo, "locked");
  assert.notEqual(failed.status, 0);
  assert.equal(failed.status, failed.value.exitCode, "the exit status is the envelope's");
  assert.equal(failed.value.code, "git-command-failed");
  assert.match(failed.value.details, /cannot lock ref/);
  assert.ok(fs.existsSync(lock));
});

test("CLI resolution publication reports a path error and reconciliation remains abortable", (t) => {
  const { repo } = fixture(t, 115);
  const start = git(repo, "rev-parse", "HEAD");
  git(repo, "switch", "-c", "source");
  fs.writeFileSync(path.join(repo, "a.txt"), "source\n");
  git(repo, "commit", "-am", "source");
  git(repo, "switch", "main");
  fs.writeFileSync(path.join(repo, "a.txt"), "target\n");
  git(repo, "commit", "-am", "target");
  const target = git(repo, "rev-parse", "HEAD");
  const run = (...args) => spawnSync(cstCommand, [...cstPrefix(), ...args], {
    cwd: repo, env: testEnv(), encoding: "utf8",
  });
  assert.notEqual(start, target);
  assert.equal(JSON.parse(run("reconcile", "source", "--json").stdout).code, "conflict-paused");
  fs.writeFileSync(path.join(repo, "a.txt"), "resolved\n");
  git(repo, "add", "a.txt");
  const failed = run("reconcile", "--continue", "--json");
  if (process.platform !== "win32") {
    assert.equal(failed.status, 0, failed.stdout + failed.stderr);
    assert.notEqual(git(repo, "rev-parse", "HEAD"), target);
    assert.equal(git(repo, "status", "--porcelain"), "");
    assert.equal(fs.readFileSync(path.join(repo, "a.txt"), "utf8"), "resolved\n");
    return;
  }
  assert.equal(failed.status, 1);
  assert.equal(failed.stderr, "");
  assert.equal(JSON.parse(failed.stdout).code, "path-length-exceeded");
  const aborted = run("reconcile", "--abort", "--json");
  assert.equal(aborted.status, 0, aborted.stdout + aborted.stderr);
  assert.equal(git(repo, "rev-parse", "HEAD"), target);
  assert.equal(git(repo, "status", "--porcelain"), "");
});
