/**
 * The Rust Git engine (`native/engine`, issue #143) against the JavaScript
 * engine it ports (`src/git.js` and `src/engine.js`): every cataloged read
 * operation, the object session and its cache, the merge-tree session, the
 * bypass rule, and the engine differential.
 *
 * Each call runs through `src/engine.js` in this process and through the
 * `engine-probe` executable, and both must return the same canonical value (or
 * the same error) and the same metrics: processes, session queries, cache
 * hits, fallbacks, native reads and direct reads, operation for operation.
 *
 * The JavaScript side runs every request before the probe replays them, so a
 * request that mutates a repository restores it before it ends.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { available, probe, run, unavailableReason } from "../test-support/engine-probe.js";
import { testEnv } from "../test-support/git-environment.js";
import { READ_OPERATIONS, nativeEngine } from "../src/engine.js";

const skip = available ? false : unavailableReason;
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Both engines read the same variables: sessions are allowed (each request
// decides whether it opens one), the default engine is Git (each request
// names its engine), and nothing the native backend refuses is set.
const overrides = { CAUSET_GIT_SESSION: "1", CAUSET_ENGINE: "" };
Object.assign(process.env, testEnv(overrides));
delete process.env.GIT_CONFIG_COUNT;
const probeEnv = () => {
  const env = { ...process.env };
  delete env.GIT_CONFIG_COUNT;
  return env;
};

const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "vlab-rust-engine-")));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: testEnv(overrides) });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function write(cwd, relative, content) {
  fs.mkdirSync(path.dirname(path.join(cwd, relative)), { recursive: true });
  fs.writeFileSync(path.join(cwd, relative), content);
}

function initialize(name, ...options) {
  const cwd = path.join(scratch, name);
  fs.mkdirSync(cwd);
  git(cwd, "init", "-q", "-b", "main", ...options);
  git(cwd, "config", "user.name", "Engine Test");
  git(cwd, "config", "user.email", "engine@example.invalid");
  git(cwd, "config", "core.autocrlf", "false");
  return cwd;
}

/**
 * History with everything the catalog reads: trailers, a cherry-picked copy,
 * a merge, both kinds of tag, notes, a resolution ref, specs, a linked and
 * locked worktree, and a dirty, untracked and ignored working tree.
 */
function historyRepository() {
  const cwd = initialize("history");
  write(cwd, "result", "retained result\n");
  write(cwd, "README.md", "# readme\n");
  write(cwd, "docs/ümlaut file.md", "unicode path\n");
  write(cwd, ".gitignore", "*.log\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-q", "-m", "base");
  const root = git(cwd, "rev-parse", "HEAD");
  git(cwd, "switch", "-q", "-c", "feature");
  write(cwd, "feature.txt", "feature\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-q", "-m", "feature work\n\nChange-Id: ch_feature");
  const feature = git(cwd, "rev-parse", "HEAD");
  git(cwd, "switch", "-q", "main");
  write(cwd, "main.txt", "main\n");
  write(cwd, ".causet/specs/spec.md", "# spec\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-q", "-m", "main work\n\nChange-Id: ch_main");
  git(cwd, "cherry-pick", "-x", feature);
  git(cwd, "merge", "-q", "--no-ff", "-m", "merge feature\n\nChange-Id: ch_merge", "feature");
  const head = git(cwd, "rev-parse", "HEAD");
  git(cwd, "tag", "v1", root);
  git(cwd, "tag", "-a", "v2", "-m", "annotated", head);
  git(cwd, "notes", "--ref=causet", "add", "-m", "{\"schema\":\"causet.note/v1\",\"records\":[]}", head);
  git(cwd, "notes", "--ref=causet", "add", "-m", "root note", root);
  git(cwd, "update-ref", "refs/causet/resolutions/a", head);
  const linked = path.join(scratch, "history-linked");
  git(cwd, "worktree", "add", "-q", "-b", "linked", linked, root);
  git(cwd, "worktree", "lock", "--reason", "kept for the test", linked);
  write(cwd, "README.md", "# readme, edited\n");
  write(cwd, "untracked file.txt", "untracked\n");
  write(cwd, "debug.log", "ignored\n");
  return { cwd, root, head, feature, linked };
}

/** A cherry-pick stopped on a conflict: unmerged stages and CHERRY_PICK_HEAD. */
function conflictRepository() {
  const cwd = initialize("conflict");
  write(cwd, "x.txt", "1\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-q", "-m", "base");
  const root = git(cwd, "rev-parse", "HEAD");
  git(cwd, "switch", "-q", "-c", "side");
  write(cwd, "x.txt", "2\n");
  git(cwd, "commit", "-q", "-am", "side");
  const side = git(cwd, "rev-parse", "HEAD");
  git(cwd, "switch", "-q", "main");
  write(cwd, "x.txt", "3\n");
  git(cwd, "commit", "-q", "-am", "main");
  const head = git(cwd, "rev-parse", "HEAD");
  const picked = spawnSync("git", ["cherry-pick", side], { cwd, encoding: "utf8", env: testEnv(overrides) });
  assert.notEqual(picked.status, 0, "the cherry-pick stops on its conflict");
  return { cwd, root, head, feature: side };
}

/**
 * A SHA-256 repository: 64-digit object IDs through every parser and the
 * session's notes walk, and a profile the native backend refuses.
 */
function sha256Repository() {
  const cwd = initialize("sha256", "--object-format=sha256");
  write(cwd, "result", "retained result\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-q", "-m", "base\n\nChange-Id: ch_sha256");
  const root = git(cwd, "rev-parse", "HEAD");
  write(cwd, "next.txt", "next\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-q", "-m", "next");
  const head = git(cwd, "rev-parse", "HEAD");
  git(cwd, "notes", "--ref=causet", "add", "-m", "note", head);
  git(cwd, "update-ref", "refs/causet/resolutions/a", head);
  return { cwd, root, head, feature: root };
}

/** A branch naming a missing object, which the native backend fails on. */
function danglingRepository() {
  const cwd = initialize("dangling");
  git(cwd, "commit", "-q", "--allow-empty", "-m", "base");
  fs.writeFileSync(path.join(cwd, ".git/refs/heads/dangling"), `${"1".repeat(40)}\n`);
  return cwd;
}

/** No commit at all: every operation that needs one fails the same way. */
function emptyRepository() {
  return { cwd: initialize("empty"), root: null, head: null, feature: null };
}

/** This repository, cloned with its notes: real history at real scale. */
function realClone() {
  const cwd = path.join(scratch, "clone");
  git(scratch, "clone", "-q", "--no-hardlinks", repository, cwd);
  spawnSync("git", ["fetch", "-q", "origin", "refs/notes/*:refs/notes/*"], { cwd, env: testEnv(overrides) });
  const head = git(cwd, "rev-parse", "HEAD");
  const root = git(cwd, "rev-list", "--max-parents=0", "HEAD").split("\n")[0];
  const feature = git(cwd, "rev-parse", "HEAD~3");
  return { cwd, root, head, feature };
}

/** Every catalog operation, with the inputs that reach its failure paths. */
function catalogCalls({ root, head, feature }) {
  const tip = head ?? "HEAD";
  const base = root ?? "HEAD";
  const other = feature ?? "HEAD";
  const zero = "0".repeat(40);
  return [
    { op: "repoContext" },
    { op: "gitVersion" },
    { op: "isInsideWorkTree" },
    { op: "gitPath", args: ["sequencer"] },
    { op: "resolveRevision", args: ["HEAD"] },
    { op: "resolveRevision", args: ["no-such-revision"] },
    { op: "resolveObjectIds", args: [["HEAD^{commit}", "HEAD^{tree}"]] },
    { op: "resolveObjectIds", args: [["HEAD", "no-such-revision"]] },
    { op: "resolveObjectIds", args: [[]] },
    { op: "revisionResolves", args: ["CHERRY_PICK_HEAD"] },
    { op: "revisionResolves", args: ["HEAD"] },
    { op: "treeId", args: ["HEAD"] },
    { op: "treeId", args: [zero] },
    { op: "readGitBlob", args: [`${tip}:result`] },
    { op: "readGitBlob", args: [`${tip}^{tree}`] },
    { op: "readGitObjects", args: [[`${tip}^{tree}`, `${tip}:result`, `${tip}:README.md`, zero, "HEAD:missing"]] },
    { op: "readGitObjects", args: [[`${tip}^{tree}`, `${tip}:result`]] },
    { op: "readGitObjects", args: [["a\nb"]] },
    { op: "inspectGitObjects", args: [[`${tip}^{commit}`, `${tip}^{tree}`, `${tip}:result`, zero, "refs/causet/resolutions/a"]] },
    { op: "inspectGitObjects", args: [[]] },
    { op: "mergeBase", args: [tip, other] },
    { op: "mergeBase", args: [tip, zero] },
    { op: "isAncestor", args: [base, tip] },
    { op: "isAncestor", args: [tip, base] },
    { op: "listCommits", args: [base, tip] },
    { op: "reachableCommits", args: [tip] },
    { op: "countCommits", args: [tip] },
    { op: "mergeCommitsBetween", args: [base, tip] },
    { op: "commitTopology", args: [base, tip] },
    { op: "rootCommits" },
    { op: "commitHistory", args: [[tip]], options: { reverse: true } },
    { op: "commitHistory", args: [[`${base}..${tip}`]], options: { paths: true } },
    { op: "commitMessage", args: [tip] },
    { op: "commitMessage", args: [zero] },
    { op: "commitSubject", args: [tip] },
    { op: "findCommitsByChangeId", args: ["ch_feature"] },
    { op: "findCommitsByChangeId", args: ["ch_missing"] },
    { op: "patchEquivalentCommits", args: [tip, other, base] },
    { op: "historyGraph" },
    { op: "ancestryPath", args: [tip, base] },
    { op: "treePaths", args: [`${tip}^{tree}`] },
    { op: "treePaths", args: [zero] },
    { op: "remoteRefs", args: [path.join(scratch, "no-such-remote")] },
    { op: "refExists", args: ["refs/notes/causet"] },
    { op: "refTarget", args: ["refs/notes/causet"] },
    { op: "refTarget", args: ["refs/heads/no-such-branch"] },
    { op: "listRefs", args: ["refs/heads/"] },
    { op: "listRefs", args: ["refs/tags"] },
    { op: "symbolicRef", args: ["HEAD"], options: { short: true } },
    { op: "symbolicRef", args: ["HEAD"] },
    { op: "pseudoRefTarget", args: ["CHERRY_PICK_HEAD"] },
    { op: "listNoteEntries", args: ["causet"] },
    { op: "listNoteEntries", args: ["refs/notes/no-such-notes"] },
    { op: "readNoteText", args: ["causet", tip] },
    { op: "readNoteText", args: ["causet", base] },
    { op: "workspaceStatus" },
    { op: "porcelainStatus" },
    { op: "porcelainStatus", options: { nulTerminated: true } },
    { op: "unmergedPaths" },
    { op: "indexEntries" },
    { op: "indexEntries", options: { unmergedOnly: true } },
    { op: "indexEntries", options: { paths: ["docs"] } },
    { op: "listTrackedPaths", args: [[".causet/specs"]] },
    { op: "pathInventory", args: [["*.md"]] },
    { op: "ignoredPaths" },
    { op: "listWorktrees" },
    { op: "listWorktreeGitDirs" },
    // Last: an unsafe expression disables an open session for the rest of it.
    { op: "resolveRevision", args: ["HEAD\nx"] },
  ];
}

/** The same object read twice (a cache hit), then after a mutation (a miss). */
function sessionCalls({ head }) {
  const expressions = [`${head}^{commit}`, `${head}^{tree}`, `${head}:result`];
  return [
    { op: "inspectGitObjects", args: [expressions] },
    { op: "inspectGitObjects", args: [expressions] },
    { op: "readGitObjects", args: [expressions] },
    { op: "readGitObjects", args: [expressions] },
    { op: "commitSubject", args: [head] },
    { op: "listNoteEntries", args: ["causet"] },
    { op: "$run", args: [["update-ref", "refs/heads/probe-scratch", head]] },
    { op: "inspectGitObjects", args: [expressions] },
    { op: "$run", args: [["update-ref", "-d", "refs/heads/probe-scratch"]] },
    // A read outside the seam is counted as a direct read.
    { op: "$run", args: [["rev-parse", "HEAD"]] },
  ];
}

function compare(requests) {
  const expected = requests.map(run);
  const actual = probe(requests, probeEnv());
  for (const [index, request] of requests.entries()) {
    const label = request.differential ? `differential ${request.differential}` : `${request.cwd}`;
    if (request.differential) {
      compareDifferential(actual[index], expected[index], label);
      continue;
    }
    assert.equal(actual[index].results?.length, request.calls.length, `${label}: one reply per call`);
    for (const [position, reply] of actual[index].results.entries()) {
      const { op, args } = request.calls[position];
      const want = JSON.parse(JSON.stringify(expected[index].results[position]));
      const where = `${label} ${request.engine ?? "git"}${request.session ? " session" : ""}: ${op} ${JSON.stringify(args ?? [])}`;
      assert.deepEqual(reply, want, where);
      if ("value" in reply) {
        assert.equal(JSON.stringify(reply.value), JSON.stringify(want.value), `${where} (bytes)`);
      }
    }
  }
  return actual;
}

/** The Git column of both differentials, and the Rust one agreeing with itself. */
function compareDifferential(actual, expected, label) {
  assert.equal(actual.schema, "causet.engine-differential/v1", label);
  assert.equal(actual.equal, true, `${label}: ${JSON.stringify(actual.operations.filter((item) => item.status === "different"))}`);
  assert.deepEqual(actual.operations.map((item) => item.operation), [...READ_OPERATIONS], label);
  for (const [index, operation] of actual.operations.entries()) {
    const reference = expected.operations[index];
    assert.equal(operation.status === "skipped", reference.status === "skipped", `${label} ${operation.operation}`);
    if (operation.status === "skipped") {
      assert.equal(operation.reason, reference.reason, `${label} ${operation.operation}`);
      continue;
    }
    assert.deepEqual(operation.results.git, reference.results.git, `${label} ${operation.operation}`);
  }
}

let fixtures = null;
function repositories() {
  fixtures ??= [
    historyRepository(),
    conflictRepository(),
    emptyRepository(),
    sha256Repository(),
    realClone(),
  ];
  return fixtures;
}

test("every catalog operation answers as the JavaScript engine does, value and processes", { skip }, () => {
  const requests = [];
  const [history, conflict, empty, sha256, clone] = repositories();
  for (const facts of [history, conflict, empty, sha256, clone]) {
    // The differential first, so both processes meet each repository cold.
    requests.push({ differential: facts.cwd });
    requests.push({ cwd: facts.cwd, engine: "git", warm: true, session: true, calls: catalogCalls(facts) });
    if (facts.head) {
      requests.push({ cwd: facts.cwd, engine: "git", warm: true, session: true, calls: sessionCalls(facts) });
    }
  }
  // Without a session.
  for (const facts of [history, conflict, empty, sha256]) {
    requests.push({ cwd: facts.cwd, engine: "git", warm: true, calls: catalogCalls(facts) });
  }
  // The JavaScript side of a native request is the N-API binding over the
  // same core; without its prebuild it would fall back for another reason.
  if (nativeEngine().available) {
    for (const facts of [history, sha256]) {
      requests.push({ cwd: facts.cwd, engine: "native", warm: true, calls: catalogCalls(facts) });
    }
    const broken = danglingRepository();
    requests.push({
      cwd: broken,
      engine: "native",
      warm: true,
      calls: [{ op: "listRefs", args: ["refs/heads/"] }, { op: "repoContext" }],
    });
  }
  // The bypass rule: a read outside the seam is refused in native mode.
  requests.push({
    cwd: history.cwd,
    engine: "native",
    warm: true,
    calls: [{ op: "$run", args: [["rev-parse", "HEAD"]] }, { op: "$run", args: [["status"]] }],
  });
  const replies = compare(requests);
  const bypass = replies.at(-1).results[0];
  assert.equal(bypass.error.code, "internal-invariant");
  assert.match(bypass.error.message, /read outside the engine seam/);
  assert.equal(bypass.metrics.directReads, 1);
});

test("every native operation answers natively on a supported repository", { skip }, () => {
  const [history] = repositories();
  const calls = catalogCalls(history);
  const [reply] = probe([{ cwd: history.cwd, engine: "native", warm: true, calls }], probeEnv());
  const answered = new Set();
  for (const [index, result] of reply.results.entries()) {
    for (const operation of Object.keys(result.metrics.nativeReads)) answered.add(operation);
    if (Object.keys(result.metrics.nativeReads).length) {
      assert.equal(result.metrics.processes, 0, `${calls[index].op} launched Git`);
    }
  }
  assert.deepEqual([...answered].sort(),
    ["inspectGitObjects", "listNoteEntries", "listRefs", "readGitObjects", "repoContext"]);
  if (nativeEngine().available) {
    assert.deepEqual([...answered].sort(), Object.keys(nativeEngine().operations).sort());
  }
});

test("the merge-tree session answers clean and conflicted steps as the JavaScript session does", { skip }, () => {
  const [history, conflict] = repositories();
  const tree = (cwd, revision) => git(cwd, "rev-parse", `${revision}^{tree}`);
  const cleanBase = tree(history.cwd, history.root);
  const cleanOurs = tree(history.cwd, "main~1");
  const cleanTheirs = tree(history.cwd, history.feature);
  const conflictBase = tree(conflict.cwd, conflict.root);
  const conflictOurs = tree(conflict.cwd, conflict.head);
  const conflictTheirs = tree(conflict.cwd, "side");
  compare([
    {
      cwd: history.cwd,
      warm: true,
      calls: [{ op: "$mergeTree", args: [[cleanBase, cleanOurs, cleanTheirs], [cleanBase, cleanTheirs, cleanOurs]] }],
    },
    {
      cwd: conflict.cwd,
      warm: true,
      calls: [{
        op: "$mergeTree",
        args: [[conflictBase, conflictOurs, conflictTheirs], [conflictBase, conflictOurs, conflictOurs], ["x", "y", "z"]],
      }],
    },
  ]);
});

test("session failures fall back to ordinary processes as the JavaScript session does", { skip }, (t) => {
  const [history] = repositories();
  for (const [name, value] of [
    ["CAUSET_TEST_GIT_SESSION_FAILURE", "1"],
    ["CAUSET_TEST_SESSION_BUFFER_BYTES", "64"],
    ["CAUSET_TEST_MERGE_TREE_GIT_VERSION", "2.40.0"],
    ["CAUSET_TEST_MERGE_TREE_SESSION_FAILURE", "1"],
  ]) {
    process.env[name] = value;
    t.after(() => delete process.env[name]);
    const head = history.head;
    const tree = git(history.cwd, "rev-parse", `${head}^{tree}`);
    compare([{
      cwd: history.cwd,
      warm: true,
      session: true,
      calls: [
        { op: "readGitObjects", args: [[`${head}^{tree}`, `${head}:result`]] },
        { op: "resolveRevision", args: ["HEAD"] },
        { op: "listNoteEntries", args: ["causet"] },
        { op: "$mergeTree", args: [[tree, tree, tree]] },
      ],
    }]);
    delete process.env[name];
  }
});
