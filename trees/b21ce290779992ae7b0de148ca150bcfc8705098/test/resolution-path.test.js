import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { testEnv } from "../test-support/git-environment.js";

const cli = fileURLToPath(new URL("../bin/vlab.js", import.meta.url));
const publisher = new URL("../src/resolutions.js", import.meta.url).href;
const errors = new URL("../src/errors.js", import.meta.url).href;

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

function publish(repo, overrides = {}) {
  const script = `
    import { publishResolution } from ${JSON.stringify(publisher)};
    import { errorEnvelope } from ${JSON.stringify(errors)};
    const outcome = JSON.parse(process.argv[1]);
    try { console.log(JSON.stringify(publishResolution(outcome, { id: "application", appliedCommit: process.argv[2] }))); }
    catch (error) { console.log(JSON.stringify(errorEnvelope(error))); process.exitCode = 1; }
  `;
  const outcome = {
    signature: `rsig_${"a".repeat(64)}`,
    resultBlob: git(repo, "rev-parse", "HEAD:a.txt"),
    resultMode: "100644",
    ...overrides,
  };
  const result = spawnSync(process.execPath,
    ["--input-type=module", "-e", script, JSON.stringify(outcome), git(repo, "rev-parse", "HEAD")],
    { cwd: repo, env: testEnv(), encoding: "utf8" });
  return { ...result, value: JSON.parse(result.stdout) };
}

test("resolution retention diagnoses the Windows lock-path boundary and supports long paths", (t) => {
  const short = fixture(t, 113).repo;
  assert.equal(publish(short).status, 0);
  const { repo, parent } = fixture(t, 114);
  const linked = path.join(parent, "linked");
  git(repo, "worktree", "add", "-b", "linked", linked);
  // A short linked worktree still stores shared refs in the long common dir.
  const failed = publish(linked);
  if (process.platform !== "win32") {
    assert.equal(failed.status, 0, failed.stdout + failed.stderr);
    return;
  }
  assert.equal(failed.status, 1);
  assert.equal(failed.value.code, "path-length-exceeded");
  assert.match(failed.value.message, /260 characters.*259/);
  assert.match(failed.value.details, /at least 1 characters/);
  assert.ok(failed.value.details.includes(path.join(repo, ".git", "refs")));
  assert.equal(git(repo, "for-each-ref", "refs/vcs-lab/resolutions"), "");
  // A deletion has a shorter ref suffix and must not be rejected by root length.
  assert.equal(publish(linked, { resultBlob: null, resultMode: null }).status, 0);
  git(repo, "config", "core.longpaths", "true");
  assert.equal(publish(linked).status, 0);
});

test("SHA-256 resolution failures measure the longer object ID in the ref path", (t) => {
  const { repo } = fixture(t, 114, "sha256");
  const failed = publish(repo);
  if (process.platform !== "win32") {
    assert.equal(failed.status, 0, failed.stdout + failed.stderr);
    assert.equal(failed.value.resultBlob.length, 64);
    return;
  }
  assert.equal(failed.status, 1);
  assert.equal(failed.value.code, "path-length-exceeded");
  assert.match(failed.value.message, /284 characters/);
  assert.match(failed.value.details, /at least 25 characters/);
});

test("an existing resolution lock retains the Git error classification", (t) => {
  const { repo } = fixture(t, process.platform === "win32" ? 114 : 160);
  git(repo, "config", "core.longpaths", "true");
  const blob = git(repo, "rev-parse", "HEAD:a.txt");
  const lock = path.join(repo, ".git", "refs", "vcs-lab", "resolutions", `rsig_${"a".repeat(64)}`, `${blob}.lock`);
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, "");
  const failed = publish(repo);
  assert.equal(failed.status, 1);
  assert.equal(failed.value.code, "git-command-failed");
  assert.ok(fs.existsSync(lock));
});

test("CLI resolution publication reports a path error and reconciliation remains abortable", (t) => {
  const { repo } = fixture(t, 114);
  const start = git(repo, "rev-parse", "HEAD");
  git(repo, "switch", "-c", "source");
  fs.writeFileSync(path.join(repo, "a.txt"), "source\n");
  git(repo, "commit", "-am", "source");
  git(repo, "switch", "main");
  fs.writeFileSync(path.join(repo, "a.txt"), "target\n");
  git(repo, "commit", "-am", "target");
  const target = git(repo, "rev-parse", "HEAD");
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], {
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
