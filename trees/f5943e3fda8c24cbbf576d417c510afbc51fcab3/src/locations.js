import fs from "node:fs";
import path from "node:path";
import { listRefs, repoContext } from "./engine.js";
import { CliError } from "./errors.js";

/**
 * Where causet keeps what it stores (ADR-0039 §1, §3). Every ref, runtime
 * directory, manifest directory, and workspace branch prefix is read from here,
 * never spelled out in a domain module.
 *
 * A repository is in one of three states:
 * - `unmigrated`: it holds metadata under the names used before issue #159 and
 *   has not run `cst migrate`. The migration window has ended (ADR-0039 §8), so
 *   nothing reads those names any more: every command except `migrate`,
 *   `doctor` and `version` refuses it with `unmigrated-repository`.
 * - `migrated`: `cst migrate` has run (its marker exists).
 * - `fresh`: it holds nothing under either name, or already holds metadata under
 *   the current names.
 *
 * The state is decided from files alone, so no command pays a Git process for
 * it: the runtime directories, loose refs, and `packed-refs`. Only a reftable
 * repository, whose refs are not files, costs one ref listing.
 */
export const CURRENT_NAMES = Object.freeze({
  notesName: "causet",
  notesRef: "refs/notes/causet",
  refsRoot: "refs/causet",
  runtime: "causet",
  specsDir: ".causet/specs",
  workspaceBranchPrefix: "causet/ws/",
});

export const LEGACY_NAMES = Object.freeze({
  notesName: "vcs-lab",
  notesRef: "refs/notes/vcs-lab",
  refsRoot: "refs/vcs-lab",
  runtime: "vcs-lab",
  specsDir: ".vcs-lab/specs",
  workspaceBranchPrefix: "vlab/ws/",
});

export const MIGRATION_SCHEMA = "causet.migration/v1";
export const MIGRATION_MARKER = "migration.json";

const cache = new Map();

/** Forget cached states, after `cst migrate` changes one. */
export function forgetRepositoryNames() {
  cache.clear();
}

export function migrationMarkerPath(context) {
  return path.join(context.commonDir, CURRENT_NAMES.runtime, MIGRATION_MARKER);
}

/**
 * The state of the repository at `cwd`. `evidence` says which set of names
 * holds anything, which `doctor` reports and `cst migrate` acts on.
 */
export function repositoryNames(cwd = process.cwd()) {
  const context = repoContext(cwd);
  const cached = cache.get(context.commonDir);
  if (cached) return cached;
  const evidence = {
    marker: fs.existsSync(migrationMarkerPath(context)),
    current: holdsAny(context, CURRENT_NAMES),
    legacy: holdsAny(context, LEGACY_NAMES),
  };
  const state = evidence.marker ? "migrated" : evidence.legacy && !evidence.current ? "unmigrated" : "fresh";
  const result = Object.freeze({ state, evidence: Object.freeze(evidence) });
  cache.set(context.commonDir, result);
  return result;
}

/** Refuse a repository that still keeps its metadata under the former names. */
export function assertMigrated(cwd = process.cwd()) {
  if (repositoryNames(cwd).state !== "unmigrated") return;
  throw new CliError(
    `This repository keeps its metadata under the names used before causet (${LEGACY_NAMES.notesRef}, ${LEGACY_NAMES.refsRoot}/*), which this build no longer reads.`,
    {
      code: "unmigrated-repository",
      details: "Run cst migrate --dry-run to see the move, then cst migrate. It deletes nothing.",
    },
  );
}

/**
 * The names everything that persists is kept under. An unmigrated repository
 * has none this build can use, so asking for them refuses it.
 */
export function names(cwd = process.cwd()) {
  assertMigrated(cwd);
  return CURRENT_NAMES;
}

/**
 * Names for transient state (a rebase's refs, an export's or import's staging
 * refs): only ever created under the current names, because `cst migrate`
 * refuses while any exists (ADR-0039 §1).
 */
export function transientNames() {
  return CURRENT_NAMES;
}

function holdsAny(context, set) {
  if (fs.existsSync(path.join(context.commonDir, set.runtime))) return true;
  if (context.gitDir && fs.existsSync(path.join(context.gitDir, set.runtime))) return true;
  if (context.root && fs.existsSync(path.join(context.root, ...set.specsDir.split("/")))) return true;
  if (fs.existsSync(path.join(context.commonDir, "reftable"))) {
    return [set.notesRef, `${set.refsRoot}/`].some((pattern) => listRefs(pattern, context.root).length > 0);
  }
  const loose = [set.notesRef, set.refsRoot].some((ref) =>
    holdsLooseRef(path.join(context.commonDir, ...ref.split("/"))));
  if (loose) return true;
  let packed;
  try {
    packed = fs.readFileSync(path.join(context.commonDir, "packed-refs"), "utf8");
  } catch {
    return false;
  }
  return packed.split("\n").some((line) => {
    const ref = line.split(" ")[1];
    return ref === set.notesRef || ref?.startsWith(`${set.refsRoot}/`);
  });
}

/**
 * Whether `location` is a loose ref or a directory holding one. Git deletes a
 * loose ref but leaves its now-empty directories behind, so an empty directory
 * is not evidence (#191). A `.lock` file is never a ref.
 */
function holdsLooseRef(location) {
  let entries;
  try {
    entries = fs.readdirSync(location, { withFileTypes: true });
  } catch (error) {
    return error.code === "ENOTDIR";
  }
  return entries.some((entry) => entry.isDirectory()
    ? holdsLooseRef(path.join(location, entry.name))
    : !entry.name.endsWith(".lock"));
}

/** `<refs root>/<family>` for one of the ref families under the names in use. */
export function refFamily(family, cwd = process.cwd()) {
  return `${names(cwd).refsRoot}/${family}`;
}

/** A transient ref family, only ever under the current names (ADR-0039 §1). */
export function transientRefFamily(family) {
  return `${CURRENT_NAMES.refsRoot}/${family}`;
}

/** The runtime directory under a Git directory (`<common dir>` or `<git dir>`). */
export function runtimeDirectory(gitDirectory, cwd = process.cwd()) {
  return path.join(gitDirectory, names(cwd).runtime);
}

/** `rest` of `ref` below `<root>/<family>/` under either set of names, or null. */
export function familyRemainder(ref, family) {
  if (typeof ref !== "string") return null;
  for (const set of [CURRENT_NAMES, LEGACY_NAMES]) {
    const prefix = `${set.refsRoot}/${family}/`;
    if (ref.startsWith(prefix)) return ref.slice(prefix.length);
  }
  return null;
}

/**
 * `ref` under the current names. A record written before a migration names its
 * ref as it was then (`refs/vcs-lab/resolutions/…`), inside its own bytes, and
 * records are permanent, so every join between a record and the refs listed
 * today translates the record's side rather than rewriting it (ADR-0039 §2, §8).
 */
export function localRef(ref, cwd = process.cwd()) {
  if (typeof ref !== "string") return ref;
  const local = names(cwd);
  if (ref === CURRENT_NAMES.notesRef || ref === LEGACY_NAMES.notesRef) return local.notesRef;
  for (const set of [CURRENT_NAMES, LEGACY_NAMES]) {
    if (ref.startsWith(`${set.refsRoot}/`)) return `${local.refsRoot}/${ref.slice(set.refsRoot.length + 1)}`;
  }
  return ref;
}
