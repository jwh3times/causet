/**
 * Reftable repositories, built as such whatever `GIT_DEFAULT_REF_FORMAT` says,
 * so that every run of the suite covers them (#277). Git reads reftable from
 * 2.45; an older Git skips this file.
 *
 * Where causet keeps its metadata (ADR-0039 §1, §3) is decided from files in a
 * files repository. A reftable repository keeps no ref files, so the decision
 * lists its refs, once for both sets of names.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { reftableUnsupported, testEnv } from "../test-support/git-environment.js";
import { cstCommand, cstPrefix } from "../test-support/cst-command.js";

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: testEnv() });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

const skip = reftableUnsupported();

function repository(t, format) {
  const parent = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "vcs-lab-test-reftable-")));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const repo = path.join(parent, "repo");
  git(parent, "init", "-q", "-b", "main", `--ref-format=${format}`, repo);
  git(repo, "config", "user.name", "Reftable Test");
  git(repo, "config", "user.email", "reftable@example.invalid");
  git(repo, "config", "core.autocrlf", "false");
  git(repo, "commit", "-q", "--allow-empty", "-m", "base");
  assert.equal(git(repo, "rev-parse", "--show-ref-format"), format);
  return repo;
}

function cst(repo, args, overrides = {}) {
  return spawnSync(cstCommand, [...cstPrefix(), ...args], {
    cwd: repo,
    encoding: "utf8",
    env: testEnv(overrides),
  });
}

/**
 * The Git subcommands a command traces, with the Git engine and no object
 * session, so that the answer does not depend on the suite's mode: the native
 * engine answers a files repository's ref listing in process, and a reftable
 * one's through Git.
 */
function traced(repo, args) {
  const result = cst(repo, args, { CAUSET_TRACE: "1", CAUSET_ENGINE: "git", CAUSET_GIT_SESSION: "0" });
  assert.equal(result.status, 0, result.stderr);
  return result.stderr
    .split(/\r?\n/)
    .map((line) => line.match(/^\[cst trace\] [\d.]+ms git (\S+) \(new process\)/)?.[1])
    .filter(Boolean)
    .sort();
}

test("deciding where a reftable repository keeps its metadata costs one ref listing", { skip }, (t) => {
  const files = repository(t, "files");
  const reftable = repository(t, "reftable");
  const command = ["resolve", "list", "--json"];
  // Before cst init the repository holds neither set of names, so the one
  // listing asks about both.
  assert.deepEqual(traced(reftable, command), [...traced(files, command), "for-each-ref"].sort());
  for (const repo of [files, reftable]) assert.equal(cst(repo, ["init"]).status, 0);
  // After it the runtime directory answers for the current names, and the
  // listing asks only about the former ones.
  assert.deepEqual(traced(reftable, command), [...traced(files, command), "for-each-ref"].sort());
});

test("a reftable repository whose only former-name evidence is a ref is refused until migrated", { skip }, (t) => {
  const unmigrated = /^cst: This repository keeps its metadata under the names used before causet/;
  for (const setup of [
    (repo) => git(repo, "update-ref", "refs/vcs-lab/resolutions/held", "HEAD"),
    (repo) => git(repo, "notes", "--ref=vcs-lab", "add", "-m", "former note", "HEAD"),
  ]) {
    const repo = repository(t, "reftable");
    setup(repo);
    const refused = cst(repo, ["resolve", "list"]);
    assert.equal(refused.status, 1, refused.stderr);
    assert.match(refused.stderr, unmigrated);
    // A ref under the current names as well makes it a repository that has
    // both, which this build reads.
    git(repo, "update-ref", "refs/causet/resolutions/held", "HEAD");
    const read = cst(repo, ["resolve", "list", "--json"]);
    assert.equal(read.status, 0, read.stderr);
  }
});

test("a reftable ref that only shares a prefix with a former name is not evidence of it", { skip }, (t) => {
  const repo = repository(t, "reftable");
  git(repo, "update-ref", "refs/notes/vcs-lab-archive", "HEAD");
  git(repo, "update-ref", "refs/vcs-lab-archive/held", "HEAD");
  const read = cst(repo, ["resolve", "list", "--json"]);
  assert.equal(read.status, 0, read.stderr);
  assert.deepEqual(JSON.parse(read.stdout), []);
});
