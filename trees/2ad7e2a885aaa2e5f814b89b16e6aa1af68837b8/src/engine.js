/**
 * The read-side engine seam (ADR-0019).
 *
 * Every Git read a domain module needs is one operation of the catalog
 * below. `src/git.js` is the Git engine: it implements each operation with
 * one process or the invocation-scoped object session. A second engine
 * (`native`, the phase 1 Rust core of ADR-0015) may answer any subset of the
 * catalog; an operation it cannot answer, or fails, falls back to Git and the
 * fallback is recorded per operation in the active Git metrics. Mutations
 * never pass through here: they remain explicit `runGit` calls.
 */
import * as git from "./git.js";
import { CliError } from "./errors.js";
import { sha256 } from "./ids.js";

export { READ_ENGINES, defaultReadEngine, readEngine, withReadEngine } from "./git.js";

/**
 * The catalog: operation name to Git implementation. The phase 1 backend
 * matrix of ADR-0015 is written against these names.
 */
const GIT_OPERATIONS = Object.freeze({
  // Repository and host
  repoContext: git.repoContext,
  gitVersion: git.gitVersion,
  isInsideWorkTree: git.isInsideWorkTree,
  gitPath: git.gitPath,
  // Objects
  resolveRevision: git.resolveRevision,
  resolveObjectIds: git.resolveObjectIds,
  revisionResolves: git.revisionResolves,
  treeId: git.treeId,
  readGitBlob: git.readGitBlob,
  readGitObjects: git.readGitObjects,
  inspectGitObjects: git.inspectGitObjects,
  // History
  mergeBase: git.mergeBase,
  isAncestor: git.isAncestor,
  listCommits: git.listCommits,
  reachableCommits: git.reachableCommits,
  countCommits: git.countCommits,
  mergeCommitsBetween: git.mergeCommitsBetween,
  rootCommits: git.rootCommits,
  commitHistory: git.commitHistory,
  commitMessage: git.commitMessage,
  commitSubject: git.commitSubject,
  findCommitsByChangeId: git.findCommitsByChangeId,
  patchEquivalentCommits: git.patchEquivalentCommits,
  historyGraph: git.historyGraph,
  // Refs and notes
  refExists: git.refExists,
  refTarget: git.refTarget,
  listRefs: git.listRefs,
  symbolicRef: git.symbolicRef,
  pseudoRefTarget: git.pseudoRefTarget,
  listNoteEntries: git.listNoteEntries,
  readNoteText: git.readNoteText,
  // Worktree, index, and status
  workspaceStatus: git.workspaceStatus,
  porcelainStatus: git.porcelainStatus,
  unmergedPaths: git.unmergedPaths,
  indexEntries: git.indexEntries,
  listTrackedPaths: git.listTrackedPaths,
  pathInventory: git.pathInventory,
  ignoredPaths: git.ignoredPaths,
  listWorktrees: git.listWorktrees,
  listWorktreeGitDirs: git.listWorktreeGitDirs,
});

/** The names of every cataloged read operation. */
export const READ_OPERATIONS = Object.freeze(Object.keys(GIT_OPERATIONS));

let nativeEngineCache = null;

/**
 * Load the native engine. Phase 1 of ADR-0015 binds `vlab-core` here and
 * advertises its supported profile; until it exists the engine is
 * unavailable with the reason `binding-missing`, and selecting it passes
 * every operation through to Git.
 */
function loadNativeEngine() {
  return Object.freeze({
    available: false,
    reason: "binding-missing",
    profile: null,
    operations: Object.freeze({}),
  });
}

export function nativeEngine() {
  if (!nativeEngineCache) nativeEngineCache = loadNativeEngine();
  return nativeEngineCache;
}

/** The selection and availability of every read engine, for `vlab doctor`. */
export function describeReadEngines() {
  const native = nativeEngine();
  return {
    selected: git.readEngine(),
    default: git.defaultReadEngine(),
    available: [...git.READ_ENGINES],
    native: {
      available: native.available,
      reason: native.available ? null : native.reason,
      profile: native.profile,
      operations: native.available ? Object.keys(native.operations).sort() : [],
    },
  };
}

function dispatch(operation, args) {
  if (git.readEngine() === "native") {
    const native = nativeEngine();
    const implementation = native.available ? native.operations[operation] : null;
    if (!implementation) {
      git.recordEngineFallback({
        operation,
        reason: native.available ? "unsupported" : native.reason,
      });
    } else {
      try {
        return implementation(...args);
      } catch (error) {
        git.recordEngineFallback({
          operation,
          reason: "native-error",
          detail: error?.message ?? String(error),
        });
      }
    }
  }
  return GIT_OPERATIONS[operation](...args);
}

// Repository and host
export function repoContext(...args) { return dispatch("repoContext", args); }
export function gitVersion(...args) { return dispatch("gitVersion", args); }
export function isInsideWorkTree(...args) { return dispatch("isInsideWorkTree", args); }
export function gitPath(...args) { return dispatch("gitPath", args); }
// Objects
export function resolveRevision(...args) { return dispatch("resolveRevision", args); }
export function resolveObjectIds(...args) { return dispatch("resolveObjectIds", args); }
export function revisionResolves(...args) { return dispatch("revisionResolves", args); }
export function treeId(...args) { return dispatch("treeId", args); }
export function readGitBlob(...args) { return dispatch("readGitBlob", args); }
export function readGitObjects(...args) { return dispatch("readGitObjects", args); }
export function inspectGitObjects(...args) { return dispatch("inspectGitObjects", args); }
// History
export function mergeBase(...args) { return dispatch("mergeBase", args); }
export function isAncestor(...args) { return dispatch("isAncestor", args); }
export function listCommits(...args) { return dispatch("listCommits", args); }
export function reachableCommits(...args) { return dispatch("reachableCommits", args); }
export function countCommits(...args) { return dispatch("countCommits", args); }
export function mergeCommitsBetween(...args) { return dispatch("mergeCommitsBetween", args); }
export function rootCommits(...args) { return dispatch("rootCommits", args); }
export function commitHistory(...args) { return dispatch("commitHistory", args); }
export function commitMessage(...args) { return dispatch("commitMessage", args); }
export function commitSubject(...args) { return dispatch("commitSubject", args); }
export function findCommitsByChangeId(...args) { return dispatch("findCommitsByChangeId", args); }
export function patchEquivalentCommits(...args) { return dispatch("patchEquivalentCommits", args); }
export function historyGraph(...args) { return dispatch("historyGraph", args); }
// Refs and notes
export function refExists(...args) { return dispatch("refExists", args); }
export function refTarget(...args) { return dispatch("refTarget", args); }
export function listRefs(...args) { return dispatch("listRefs", args); }
export function symbolicRef(...args) { return dispatch("symbolicRef", args); }
export function pseudoRefTarget(...args) { return dispatch("pseudoRefTarget", args); }
export function listNoteEntries(...args) { return dispatch("listNoteEntries", args); }
export function readNoteText(...args) { return dispatch("readNoteText", args); }
// Worktree, index, and status
export function workspaceStatus(...args) { return dispatch("workspaceStatus", args); }
export function porcelainStatus(...args) { return dispatch("porcelainStatus", args); }
export function unmergedPaths(...args) { return dispatch("unmergedPaths", args); }
export function indexEntries(...args) { return dispatch("indexEntries", args); }
export function listTrackedPaths(...args) { return dispatch("listTrackedPaths", args); }
export function pathInventory(...args) { return dispatch("pathInventory", args); }
export function ignoredPaths(...args) { return dispatch("ignoredPaths", args); }
export function listWorktrees(...args) { return dispatch("listWorktrees", args); }
export function listWorktreeGitDirs(...args) { return dispatch("listWorktreeGitDirs", args); }

// Composites: derived from cataloged operations, never from Git directly.

export function currentHead(cwd = process.cwd()) {
  return resolveRevision("HEAD", cwd);
}

export function changeIdForCommit(commit, cwd = process.cwd()) {
  return git.extractTrailer(commitMessage(commit, cwd), "Change-Id") ?? `git:${commit}`;
}

export function assertClean(cwd = process.cwd()) {
  const status = porcelainStatus(cwd);
  if (status) {
    throw new CliError("The worktree must be clean for this operation.", {
      code: "dirty-worktree",
      details: status,
    });
  }
}

/**
 * Whether the host Git is at least `required` (`"major.minor"`). Output that
 * cannot be parsed counts as new enough so that Git itself reports any
 * failure.
 */
export function gitAtLeast(required, cwd = process.cwd()) {
  const { parts } = gitVersion(cwd);
  if (!parts) return true;
  const wanted = required.split(".").map(Number);
  for (const [index, value] of wanted.entries()) {
    if (parts[index] !== value) return parts[index] > value;
  }
  return true;
}

// Differential comparison of the engines, for `vlab doctor --differential`.

function canonicalValue(value) {
  if (Buffer.isBuffer(value)) return { bytes: value.length, sha256: sha256(value) };
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value instanceof Set) return [...value].map(canonicalValue);
  if (value instanceof Map) return [...value.entries()].map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalValue(value[key])]),
    );
  }
  return value === undefined ? null : value;
}

function resultDigest(value) {
  return sha256(JSON.stringify(canonicalValue(value)));
}

/**
 * Probes over the repository at `cwd`, each naming one cataloged operation
 * with arguments derived from the repository itself. An operation whose
 * input the repository cannot supply is listed as skipped with the reason.
 */
function differentialProbes(cwd) {
  const notesRef = "vcs-lab";
  const specsPath = ".vcs-lab/specs";
  let head = null;
  try {
    head = git.withReadEngine("git", () => currentHead(cwd));
  } catch {
    head = null;
  }
  const roots = head ? git.withReadEngine("git", () => rootCommits(cwd)) : [];
  const root = roots[0] ?? head;
  const blob = git.withReadEngine("git", () =>
    indexEntries(cwd).find((entry) => entry.stage === 0)?.blob ?? null,
  );
  const needsHead = (run) =>
    head ? { run } : { skipped: "the repository has no commit on HEAD" };
  return [
    { operation: "repoContext", run: () => repoContext(cwd) },
    { operation: "gitVersion", run: () => gitVersion(cwd) },
    { operation: "isInsideWorkTree", run: () => isInsideWorkTree(cwd) },
    { operation: "gitPath", run: () => gitPath("sequencer", cwd) },
    { operation: "resolveRevision", ...needsHead(() => resolveRevision("HEAD", cwd)) },
    {
      operation: "resolveObjectIds",
      ...needsHead(() => resolveObjectIds(["HEAD^{commit}", "HEAD^{tree}"], cwd)),
    },
    { operation: "revisionResolves", run: () => revisionResolves("CHERRY_PICK_HEAD", cwd) },
    { operation: "treeId", ...needsHead(() => treeId("HEAD", cwd)) },
    {
      operation: "readGitBlob",
      ...(blob ? { run: () => readGitBlob(blob, cwd) } : { skipped: "the index has no blob" }),
    },
    { operation: "readGitObjects", ...needsHead(() => readGitObjects([`${head}^{tree}`], cwd)) },
    {
      operation: "inspectGitObjects",
      run: () => inspectGitObjects(["HEAD^{commit}", "HEAD^{tree}", "HEAD:.gitattributes"], cwd),
    },
    { operation: "mergeBase", ...needsHead(() => mergeBase(head, head, cwd)) },
    { operation: "isAncestor", ...needsHead(() => isAncestor(root, head, cwd)) },
    { operation: "listCommits", ...needsHead(() => listCommits(root, head, cwd)) },
    { operation: "reachableCommits", ...needsHead(() => reachableCommits(head, cwd)) },
    { operation: "countCommits", ...needsHead(() => countCommits(head, cwd)) },
    { operation: "mergeCommitsBetween", ...needsHead(() => mergeCommitsBetween(root, head, cwd)) },
    { operation: "rootCommits", run: () => rootCommits(cwd) },
    { operation: "commitHistory", ...needsHead(() => commitHistory([head], cwd, { reverse: true })) },
    { operation: "commitMessage", ...needsHead(() => commitMessage(head, cwd)) },
    { operation: "commitSubject", ...needsHead(() => commitSubject(head, cwd)) },
    {
      operation: "findCommitsByChangeId",
      ...needsHead(() => findCommitsByChangeId(changeIdForCommit(head, cwd), cwd)),
    },
    {
      operation: "patchEquivalentCommits",
      ...needsHead(() => patchEquivalentCommits(head, head, root, cwd)),
    },
    { operation: "historyGraph", ...needsHead(() => historyGraph(cwd)) },
    { operation: "refExists", run: () => refExists(`refs/notes/${notesRef}`, cwd) },
    { operation: "refTarget", run: () => refTarget(`refs/notes/${notesRef}`, cwd) },
    { operation: "listRefs", run: () => listRefs("refs/heads/", cwd) },
    { operation: "symbolicRef", run: () => symbolicRef("HEAD", cwd, { short: true }) },
    { operation: "pseudoRefTarget", run: () => pseudoRefTarget("CHERRY_PICK_HEAD", cwd) },
    { operation: "listNoteEntries", run: () => listNoteEntries(notesRef, cwd) },
    { operation: "readNoteText", ...needsHead(() => readNoteText(notesRef, head, cwd)) },
    { operation: "workspaceStatus", run: () => workspaceStatus(cwd) },
    { operation: "porcelainStatus", run: () => porcelainStatus(cwd, { nulTerminated: true }) },
    { operation: "unmergedPaths", run: () => unmergedPaths(cwd) },
    { operation: "indexEntries", run: () => indexEntries(cwd) },
    { operation: "listTrackedPaths", run: () => listTrackedPaths([specsPath], cwd) },
    { operation: "pathInventory", run: () => pathInventory(["*.md"], cwd) },
    { operation: "ignoredPaths", run: () => ignoredPaths(cwd) },
    { operation: "listWorktrees", run: () => listWorktrees(cwd) },
    { operation: "listWorktreeGitDirs", run: () => listWorktreeGitDirs(cwd) },
  ];
}

/**
 * Run every cataloged operation through each engine and compare the results
 * by digest. With the Git engine as oracle, a native engine is equal when
 * every probe it answers yields the same digest; a probe it falls back on is
 * reported with the fallback reason so the comparison never hides a
 * passthrough as native evidence.
 */
export function runDifferential(cwd = process.cwd()) {
  const probes = differentialProbes(cwd);
  const engines = [...git.READ_ENGINES];
  const operations = probes.map((probe) => {
    if (!probe.run) {
      return { operation: probe.operation, status: "skipped", reason: probe.skipped };
    }
    const results = {};
    for (const engine of engines) {
      const collector = git.beginGitMetrics(`differential-${engine}`);
      let value;
      let error = null;
      try {
        value = git.withReadEngine(engine, probe.run);
      } catch (caught) {
        error = caught?.message ?? String(caught);
      }
      const metrics = git.endGitMetrics(collector);
      results[engine] = {
        digest: error === null ? resultDigest(value) : null,
        error,
        processes: metrics.processes,
        fallbacks: metrics.fallbacks.filter(
          (item) => item.operation === probe.operation,
        ),
        directReads: metrics.directReads,
      };
    }
    const reference = results[engines[0]];
    const equal = engines.every(
      (engine) =>
        results[engine].digest === reference.digest &&
        results[engine].error === reference.error,
    );
    return {
      operation: probe.operation,
      status: equal ? "equal" : "different",
      results,
    };
  });
  const counts = { equal: 0, different: 0, skipped: 0 };
  for (const item of operations) counts[item.status] += 1;
  if (operations.length !== READ_OPERATIONS.length ||
      operations.some((item) => !READ_OPERATIONS.includes(item.operation))) {
    throw new CliError("The differential probes do not cover the operation catalog exactly.",
      { code: "internal-invariant" });
  }
  return {
    schema: "vcs-lab.engine-differential/v1",
    engines,
    oracle: engines[0],
    operations,
    counts,
    equal: counts.different === 0,
  };
}
