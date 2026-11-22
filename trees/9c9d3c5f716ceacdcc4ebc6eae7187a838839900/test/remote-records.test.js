/**
 * Records over Git remotes (ADR-0040, issue #255): `cst fetch`, `cst pull`,
 * `cst push` and `cst clone` do what Git's commands do and also carry
 * `refs/notes/causet`, `refs/causet/retention` and
 * `refs/causet/resolutions/*`, validated as an envelope import in ADR-0030
 * park mode. Every case uses a bare hub and clones of it in a disposable
 * directory.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

const identity = {
  GIT_AUTHOR_NAME: "Causet Remote Test",
  GIT_AUTHOR_EMAIL: "causet-remote@example.invalid",
  GIT_COMMITTER_NAME: "Causet Remote Test",
  GIT_COMMITTER_EMAIL: "causet-remote@example.invalid",
};

function run(program, args, cwd) {
  const result = spawnSync(program, args, { cwd, encoding: "utf8", env: testEnv(identity) });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const cst = (cwd, ...args) => run(cstCommand, [...cstPrefix(), ...args], cwd);
const git = (cwd, ...args) => run("git", args, cwd);

function ok(result, label) {
  assert.equal(result.status, 0, `${label}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

const json = (result, label) => JSON.parse(ok(result, label));
const refs = (cwd) => ok(git(cwd, "for-each-ref", "--format=%(refname)"), "for-each-ref").split("\n").filter(Boolean);
const target = (cwd, name) => ok(git(cwd, "rev-parse", name), name).trim();

/** A bare hub, and clone `a` of it with a base commit pushed by plain Git. */
function hubWithClone() {
  const parent = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "causet-remote-records-")));
  created.push(parent);
  const hub = path.join(parent, "hub.git");
  ok(git(parent, "init", "-q", "--bare", "-b", "main", hub), "init hub");
  const a = path.join(parent, "a");
  ok(git(parent, "clone", "-q", hub, a), "clone a");
  ok(git(a, "config", "core.autocrlf", "false"), "autocrlf");
  fs.writeFileSync(path.join(a, "base.txt"), "base\n");
  ok(git(a, "add", "-A"), "add");
  ok(cst(a, "commit", "-m", "base"), "base");
  ok(cst(a, "init"), "init a");
  ok(git(a, "push", "-q", "-u", "origin", "main"), "push base");
  return { parent, hub, a };
}

/** Land a feature compactly in `repo` with declared provenance. */
function land(repo, name, actor) {
  ok(cst(repo, "branch", name), `branch ${name}`);
  fs.writeFileSync(path.join(repo, `${name}.txt`), `${name}\n`);
  ok(git(repo, "add", "-A"), "add");
  ok(cst(repo, "commit", "-m", name, "--generated-by", actor), `commit ${name}`);
  ok(git(repo, "switch", "-q", "main"), "switch");
  ok(cst(repo, "merge", name, "--compact", "-m", `land ${name}`), `land ${name}`);
}

/** Every declared actor in the clone's records, wherever they attach. */
const actors = (repo) =>
  json(cst(repo, "receipts", "--json"), "receipts")
    .filter((record) => record.type === "provenance")
    .flatMap((record) => record.actors.map((actor) => actor.actor)).sort();

test("a clone reproduces coverage, provenance and the resolution catalog without refspecs", () => {
  const { parent, a } = hubWithClone();
  land(a, "feature", "agent-a");
  // A resolution: the same line changed on both sides, resolved by hand.
  ok(cst(a, "branch", "side"), "branch side");
  fs.writeFileSync(path.join(a, "base.txt"), "side\n");
  ok(cst(a, "commit", "--all", "-m", "side"), "side");
  ok(git(a, "switch", "-q", "main"), "switch");
  fs.writeFileSync(path.join(a, "base.txt"), "main\n");
  ok(cst(a, "commit", "--all", "-m", "main change"), "main change");
  assert.notEqual(cst(a, "reconcile", "side").status, 0, "the reconcile pauses on the conflict");
  fs.writeFileSync(path.join(a, "base.txt"), "resolved\n");
  ok(git(a, "add", "base.txt"), "add resolution");
  ok(cst(a, "reconcile", "--continue"), "continue");
  assert.ok(refs(a).some((name) => name.startsWith("refs/causet/resolutions/")), "a resolution ref exists");

  const pushed = json(cst(a, "push", "-q", "--json", "origin", "main", "feature"), "push");
  assert.equal(pushed.gitStatus, 0);
  assert.deepEqual(pushed.records[0].pushed.slice(0, 2), ["refs/notes/causet", "refs/causet/retention"]);

  const b = path.join(parent, "b");
  const cloned = json(cst(parent, "clone", "-q", "--json", path.join(parent, "hub.git"), b), "clone");
  assert.equal(cloned.records[0].upToDate, false);
  assert.equal(cloned.records[0].import.summary.parkRecords, 0);
  assert.equal(json(cst(b, "metadata", "validate", "--json"), "validate").summary.errors, 0);
  const plan = json(cst(b, "merge-plan", "origin/feature", "--json"), "plan");
  assert.match(plan.effectiveBase.reason, /^causal-receipt:land_/, "the landing receipt covers the feature in the clone");
  assert.deepEqual(plan.changes, []);
  assert.deepEqual(actors(b), actors(a));
  assert.equal(json(cst(b, "resolve", "list", "--json"), "resolve list").length,
    json(cst(a, "resolve", "list", "--json"), "resolve list").length);
  assert.ok(refs(b).some((name) => name.startsWith("refs/causet/resolutions/")));
});

test("diverged clones converge through push and fetch with no forced update", () => {
  const { parent, hub, a } = hubWithClone();
  ok(cst(parent, "clone", "-q", hub, path.join(parent, "b")), "clone b");
  const b = path.join(parent, "b");
  land(a, "from-a", "agent-a");
  land(b, "from-b", "agent-b");
  ok(cst(a, "push", "-q", "origin", "main"), "a pushes");
  const before = target(hub, "refs/notes/causet");

  // B pushes its records without fetching first: the remote moved, so B
  // fetches and merges, then pushes a fast-forward.
  const raced = json(cst(b, "push", "-q", "--json", "origin", "from-b"), "b pushes");
  assert.equal(raced.records[0].fetched.length, 1, "the moved records were fetched first");
  assert.ok(raced.records[0].pushed.includes("refs/notes/causet"));
  assert.equal(git(hub, "merge-base", "--is-ancestor", before, "refs/notes/causet").status, 0,
    "the hub's notes advanced by fast-forward");

  ok(cst(a, "fetch", "-q"), "a fetches");
  // A pull has no JSON form: cst refuses before Git runs, in JSON, rather
  // than handing Git an option it answers with its usage text.
  const head = target(b, "HEAD");
  const refused = cst(b, "pull", "--json", "--no-rebase", "origin", "main");
  assert.equal(refused.status, 1);
  const error = JSON.parse(refused.stdout);
  assert.equal(error.code, "usage-unknown-option");
  assert.match(error.message, /'cst fetch --json'/);
  assert.equal(target(b, "HEAD"), head, "the refused pull changed nothing");
  ok(cst(b, "pull", "-q", "--no-rebase", "origin", "main"), "b pulls");
  assert.deepEqual(actors(a), ["agent-a", "agent-a", "agent-b", "agent-b"]);
  assert.deepEqual(actors(b), actors(a));
  const again = json(cst(a, "fetch", "-q", "--json"), "fetch again");
  assert.equal(again.records[0].upToDate, true);
});

test("a conflicting record parks on fetch and blocks the push until it is disposed", () => {
  const { parent, hub, a } = hubWithClone();
  land(a, "feature", "agent-a");
  ok(cst(a, "push", "-q", "origin", "main"), "push");
  const b = path.join(parent, "b");
  ok(cst(parent, "clone", "-q", hub, b), "clone b");

  // Clone A rewrites the provenance record in place: same id, new content.
  const commit = target(a, "feature");
  const note = JSON.parse(ok(git(a, "notes", "--ref=refs/notes/causet", "show", commit), "note"));
  const record = note.records.find((item) => item.type === "provenance");
  record.actors[0].actor = "someone-else";
  const file = path.join(parent, "note.json");
  fs.writeFileSync(file, JSON.stringify(note));
  ok(git(a, "notes", "--ref=refs/notes/causet", "add", "-f", "-F", file, commit), "rewrite note");
  ok(cst(a, "push", "-q", "origin", "main"), "a pushes the rewritten record");

  const fetched = json(cst(b, "fetch", "-q", "--json"), "b fetches");
  assert.equal(fetched.records[0].import.summary.parkRecords, 1);
  assert.ok(refs(b).some((name) => name.startsWith("refs/causet/quarantine/")));

  const head = target(hub, "refs/heads/main");
  fs.writeFileSync(path.join(b, "more.txt"), "more\n");
  ok(git(b, "add", "-A"), "add");
  ok(cst(b, "commit", "-m", "more"), "commit");
  const refused = cst(b, "push", "-q", "--json", "origin", "main");
  assert.equal(refused.status, 1);
  assert.equal(JSON.parse(refused.stdout).error.code, "conflict-blocked");
  assert.equal(target(hub, "refs/heads/main"), head, "the branch is not pushed without its records");

  ok(cst(b, "push", "-q", "--no-records", "origin", "main"), "--no-records pushes what git push would");
  ok(cst(b, "metadata", "dispose", record.id, "--keep-local", "--reason", "test"), "dispose");
  ok(cst(b, "push", "-q", "origin", "main"), "the push goes once the conflict is disposed");
});

test("checkpoints, quarantine and staging refs never leave the clone", () => {
  const { parent, hub, a } = hubWithClone();
  land(a, "feature", "agent-a");
  ok(cst(a, "workspace", "checkpoint", "--label", "x"), "checkpoint");
  ok(cst(a, "fetch", "-q"), "fetch stages the hub's records");
  ok(git(a, "update-ref", "refs/causet/quarantine/lineage_x/rec_x", target(a, "HEAD^{tree}")), "a parked stand-in");
  const pushed = cst(a, "push", "-q", "--no-records", "origin", "main");
  ok(pushed, "plain push");
  ok(git(a, "update-ref", "-d", "refs/causet/quarantine/lineage_x/rec_x"), "remove the stand-in");
  ok(cst(a, "push", "-q", "origin", "main"), "push with records");
  const remote = refs(hub);
  assert.deepEqual(remote.filter((name) => !name.startsWith("refs/heads/")).sort(),
    ["refs/causet/retention", "refs/notes/causet"]);
  assert.ok(refs(a).some((name) => name.startsWith("refs/causet/checkpoints/")));
  const refused = cst(a, "push", "--mirror", path.join(parent, "hub.git"));
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /--mirror would also push/);
});

test("a record the remote holds that this build cannot read is never imported", () => {
  const { parent, hub, a } = hubWithClone();
  land(a, "feature", "agent-a");
  const commit = target(a, "feature");
  const note = JSON.parse(ok(git(a, "notes", "--ref=refs/notes/causet", "show", commit), "note"));
  note.records.push({ ...note.records[0], id: "prov_future", schema: "causet.provenance/v99" });
  const file = path.join(parent, "note.json");
  fs.writeFileSync(file, JSON.stringify(note));
  ok(git(a, "notes", "--ref=refs/notes/causet", "add", "-f", "-F", file, commit), "add future record");
  ok(cst(a, "push", "-q", "origin", "main"), "push");

  const b = path.join(parent, "b");
  const cloned = json(cst(parent, "clone", "-q", "--json", hub, b), "clone");
  assert.ok(cloned.records[0].excluded >= 1, "the unreadable record is excluded");
  const ids = json(cst(b, "receipts", "--json"), "receipts").map((record) => record.id);
  assert.ok(!ids.includes("prov_future"));
});

test("Git's own outcome comes back, and a failed Git command carries nothing", () => {
  const { a } = hubWithClone();
  const missing = cst(a, "fetch", "no-such-remote");
  const plain = git(a, "fetch", "no-such-remote");
  assert.equal(missing.status, plain.status);
  assert.equal(missing.stderr, plain.stderr);
  const deleted = cst(a, "push", "-q", "--json", "origin", "--delete", "no-such-branch");
  assert.notEqual(deleted.status, 0);
  assert.deepEqual(JSON.parse(deleted.stdout).records, [], "a delete carries no records");
});

test("a remote named by a relative path means what it means to Git", () => {
  const { parent, a } = hubWithClone();
  land(a, "feature", "agent-a");
  ok(cst(a, "push", "-q", "origin", "main"), "push");
  const c = path.join(parent, "c");
  ok(git(parent, "init", "-q", "-b", "main", c), "init c");
  ok(cst(c, "init"), "cst init");
  const below = path.join(c, "sub");
  fs.mkdirSync(below);
  // Git resolves the path from the top of the worktree, wherever it is run.
  assert.equal(cst(below, "fetch", "-q", "../../hub.git", "main").status, git(below, "fetch", "-q", "../../hub.git", "main").status);
  const fetched = json(cst(below, "fetch", "-q", "--json", "../hub.git", "main"), "fetch by path");
  assert.equal(fetched.gitStatus, 0);
  assert.equal(fetched.records[0].import.summary.parkRecords, 0);
  assert.ok(refs(c).some((name) => name.startsWith("refs/causet-remote/url-")), "staged under the URL digest");
  assert.deepEqual(actors(c), actors(a));
});
