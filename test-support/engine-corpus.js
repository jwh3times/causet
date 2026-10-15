/**
 * The repositories and requests `test/rust-engine.test.js` puts to the Rust
 * Git engine. Every commit, tag and note is dated, so object IDs are the same
 * on every run and every host; the JavaScript engine's answers to exactly
 * these requests are frozen in `test/fixtures/oracle/engine.json` (#243).
 * Changing a fixture or a call list invalidates those answers.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { testEnv } from "./git-environment.js";

const DATE = "2026-01-01T00:00:00Z";

/**
 * The variables both engines read: sessions are allowed (each request decides
 * whether it opens one), the default engine is Git (each request names its
 * engine), nothing the native backend refuses is set, and Git dates every
 * object it writes.
 */
export const overrides = {
  CAUSET_GIT_SESSION: "1",
  CAUSET_ENGINE: "",
  GIT_AUTHOR_DATE: DATE,
  GIT_COMMITTER_DATE: DATE,
};

export function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: testEnv(overrides) });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function write(cwd, relative, content) {
  fs.mkdirSync(path.dirname(path.join(cwd, relative)), { recursive: true });
  fs.writeFileSync(path.join(cwd, relative), content);
}

function initialize(scratch, name, ...options) {
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
function historyRepository(scratch) {
  const cwd = initialize(scratch, "history");
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
function conflictRepository(scratch) {
  const cwd = initialize(scratch, "conflict");
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
function sha256Repository(scratch) {
  const cwd = initialize(scratch, "sha256", "--object-format=sha256");
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
function danglingRepository(scratch) {
  const cwd = initialize(scratch, "dangling");
  git(cwd, "commit", "-q", "--allow-empty", "-m", "base");
  fs.writeFileSync(path.join(cwd, ".git/refs/heads/dangling"), `${"1".repeat(40)}\n`);
  return cwd;
}

/** No commit at all: every operation that needs one fails the same way. */
function emptyRepository(scratch) {
  return { cwd: initialize(scratch, "empty"), root: null, head: null, feature: null };
}

/** The frozen repositories, built in `scratch` in a fixed order. */
export function buildRepositories(scratch) {
  return {
    history: historyRepository(scratch),
    conflict: conflictRepository(scratch),
    empty: emptyRepository(scratch),
    sha256: sha256Repository(scratch),
    dangling: danglingRepository(scratch),
  };
}

/** Every catalog operation, with the inputs that reach its failure paths. */
export function catalogCalls({ root, head, feature }, scratch) {
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
export function sessionCalls({ head }) {
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

/**
 * The catalog requests, in order: per repository the differential (so both
 * engines meet it cold), the catalog in a session, and the session calls;
 * then the catalog without a session; then the native backend on what it
 * supports and on a broken ref; and last the bypass rule.
 */
export function catalogRequests(repositories, scratch) {
  const { history, conflict, empty, sha256, dangling } = repositories;
  const requests = [];
  for (const facts of [history, conflict, empty, sha256]) {
    requests.push({ differential: facts.cwd });
    requests.push({ cwd: facts.cwd, engine: "git", warm: true, session: true, calls: catalogCalls(facts, scratch) });
    if (facts.head) {
      requests.push({ cwd: facts.cwd, engine: "git", warm: true, session: true, calls: sessionCalls(facts) });
    }
  }
  for (const facts of [history, conflict, empty, sha256]) {
    requests.push({ cwd: facts.cwd, engine: "git", warm: true, calls: catalogCalls(facts, scratch) });
  }
  for (const facts of [history, sha256]) {
    requests.push({ cwd: facts.cwd, engine: "native", warm: true, calls: catalogCalls(facts, scratch) });
  }
  requests.push({
    cwd: dangling,
    engine: "native",
    warm: true,
    calls: [{ op: "listRefs", args: ["refs/heads/"] }, { op: "repoContext" }],
  });
  requests.push({
    cwd: history.cwd,
    engine: "native",
    warm: true,
    calls: [{ op: "$run", args: [["rev-parse", "HEAD"]] }, { op: "$run", args: [["status"]] }],
  });
  return requests;
}

/** Clean and conflicted merge-tree steps, and one the session cannot parse. */
export function mergeTreeRequests({ history, conflict }) {
  const tree = (cwd, revision) => git(cwd, "rev-parse", `${revision}^{tree}`);
  const cleanBase = tree(history.cwd, history.root);
  const cleanOurs = tree(history.cwd, "main~1");
  const cleanTheirs = tree(history.cwd, history.feature);
  const conflictBase = tree(conflict.cwd, conflict.root);
  const conflictOurs = tree(conflict.cwd, conflict.head);
  const conflictTheirs = tree(conflict.cwd, "side");
  return [
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
  ];
}

/** Each injected session failure, and the request every one is replayed with. */
export const FAILURE_HOOKS = [
  ["CAUSET_TEST_GIT_SESSION_FAILURE", "1"],
  ["CAUSET_TEST_SESSION_BUFFER_BYTES", "64"],
  ["CAUSET_TEST_MERGE_TREE_GIT_VERSION", "2.40.0"],
  ["CAUSET_TEST_MERGE_TREE_SESSION_FAILURE", "1"],
];

export function failureRequest({ history }) {
  const head = history.head;
  const tree = git(history.cwd, "rev-parse", `${head}^{tree}`);
  return {
    cwd: history.cwd,
    warm: true,
    session: true,
    calls: [
      { op: "readGitObjects", args: [[`${head}^{tree}`, `${head}:result`]] },
      { op: "resolveRevision", args: ["HEAD"] },
      { op: "listNoteEntries", args: ["causet"] },
      { op: "$mergeTree", args: [[tree, tree, tree]] },
    ],
  };
}

/**
 * An answer as it is frozen: the scratch directory, which differs per run and
 * per host, becomes `<scratch>` in either separator, and the host's Git
 * version becomes `<git version>`.
 */
export function normalize(value, scratch, op) {
  if (op === "gitVersion" && value && "value" in value) return { ...value, value: "<git version>" };
  const forms = [scratch, scratch.replaceAll("\\", "/")];
  const walk = (item) => {
    if (typeof item === "string") return forms.reduce((text, form) => text.replaceAll(form, "<scratch>"), item);
    if (Array.isArray(item)) return item.map(walk);
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([key, member]) => [key, walk(member)]));
    return item;
  };
  return walk(value);
}
