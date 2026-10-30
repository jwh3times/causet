/**
 * Git passthrough (ADR-0040, issue #256): a first word `cst` does not answer
 * itself is Git's, and `cst git <arguments>` is Git's whatever follows. Either
 * way `cst` adds nothing: the same standard output, standard error and exit
 * status as `git` with the same arguments, in the same directory, with the
 * same environment.
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { testEnv } from "../test-support/git-environment.js";
import { cstCommand, cstPrefix } from "../test-support/cst-command.js";

const created = [];

after(() => {
  for (const directory of created) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function scratch() {
  const parent = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "causet-passthrough-")));
  created.push(parent);
  return parent;
}

function makeRepo() {
  const repo = path.join(scratch(), "repo");
  fs.mkdirSync(repo);
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", env: testEnv() });
  git("init", "-q", "-b", "main");
  git("config", "core.autocrlf", "false");
  git("config", "user.name", "Causet Passthrough Test");
  git("config", "user.email", "causet-passthrough@example.invalid");
  fs.writeFileSync(path.join(repo, "a.txt"), "base\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  return { repo, git };
}

const cst = (cwd, args, input) =>
  spawnSync(cstCommand, [...cstPrefix(), ...args], { cwd, encoding: "utf8", env: testEnv(), input });

const git = (cwd, args, input) =>
  spawnSync("git", args, { cwd, encoding: "utf8", env: testEnv(), input });

function assertSameAsGit(cwd, args, gitArgs = args, input = undefined) {
  const ours = cst(cwd, args, input);
  const theirs = git(cwd, gitArgs, input);
  assert.deepEqual(
    { status: ours.status, stdout: ours.stdout, stderr: ours.stderr },
    { status: theirs.status, stdout: theirs.stdout, stderr: theirs.stderr },
    `cst ${JSON.stringify(args)} against git ${JSON.stringify(gitArgs)}`,
  );
}

test("a command cst does not define answers exactly as Git does", () => {
  const { repo } = makeRepo();
  fs.writeFileSync(path.join(repo, "a.txt"), "changed\n");
  fs.writeFileSync(path.join(repo, "new.txt"), "new\n");
  for (const args of [
    ["status"],
    ["status", "--short"],
    ["log", "--oneline", "-1"],
    ["diff"],
    ["diff", "--exit-code"],
    ["rev-parse", "--abbrev-ref", "HEAD"],
    ["show", "no-such-revision"],
    ["no-such-command"],
    ["no-such-command", "--json"],
    ["UPPER"],
    ["Commit"],
    ["x", "-m", "--json"],
    ["unknown \"quoted\" \\ — command"],
  ]) {
    assertSameAsGit(repo, args);
  }
});

test("the standard input reaches Git", () => {
  const { repo } = makeRepo();
  assertSameAsGit(repo, ["hash-object", "--stdin"], ["hash-object", "--stdin"], "some content\n");
});

test("outside a repository Git's own refusal and status come back", () => {
  const outside = scratch();
  assertSameAsGit(outside, ["status"]);
  assert.equal(cst(outside, ["status"]).status, 128);
});

test("a passthrough command's flags are Git's, global cst flags included", () => {
  // `--json` and `--engine` are cst's global flags only for cst's commands.
  const { repo } = makeRepo();
  assertSameAsGit(repo, ["status", "--json"]);
  assertSameAsGit(repo, ["log", "--engine=native", "-1"]);
});

test("a passthrough command changes the repository as Git does", () => {
  const { repo, git: run } = makeRepo();
  const switched = cst(repo, ["switch", "-q", "-c", "topic"]);
  assert.equal(switched.status, 0, switched.stderr);
  assert.equal(run("branch", "--show-current").trim(), "topic");
  fs.writeFileSync(path.join(repo, "b.txt"), "b\n");
  assert.equal(cst(repo, ["add", "b.txt"]).status, 0);
  assert.equal(run("diff", "--cached", "--name-only").trim(), "b.txt");
});

test("cst git reaches Git even for a name cst defines", () => {
  const { repo, git: run } = makeRepo();
  const head = run("rev-parse", "HEAD").trim();
  // `cst commit --amend` is refused (#257); `cst git commit --amend` is Git's.
  assert.equal(JSON.parse(cst(repo, ["commit", "--amend", "-m", "x", "--json"]).stdout).code, "usage-unknown-option");
  const amended = cst(repo, ["git", "commit", "-q", "--amend", "-m", "reworded"]);
  assert.equal(amended.status, 0, amended.stderr);
  assert.notEqual(run("rev-parse", "HEAD").trim(), head);
  assert.equal(run("rev-list", "--count", "HEAD").trim(), "1", "amended, not added");
  assert.equal(run("log", "-1", "--format=%B").trim(), "reworded", "Git's commit adds no Change-Id");

  assertSameAsGit(repo, ["git", "status", "--short"], ["status", "--short"]);
  assertSameAsGit(repo, ["git", "merge", "--no-such-option"], ["merge", "--no-such-option"]);
  assertSameAsGit(repo, ["git"], []);
});

test("cst's own commands, help and version are not passed through", () => {
  const { repo } = makeRepo();
  const help = cst(repo, ["help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^causet — Git-backed causal source control/);
  assert.match(help.stdout, /cst git <arguments>/);
  assert.match(cst(repo, ["version"]).stdout, /^causet /);
  const unknown = cst(repo, ["metadata", "no-such-subcommand", "--json"]);
  assert.equal(JSON.parse(unknown.stdout).code, "usage-unknown-command");
  const receipts = cst(repo, ["receipts", "--json"]);
  assert.equal(receipts.status, 0, receipts.stderr);
  assert.deepEqual(JSON.parse(receipts.stdout), []);
});
