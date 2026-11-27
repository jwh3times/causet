import fs from "node:fs";
import path from "node:path";
import { runGit } from "./git.js";
import { isAncestor, listRefs, listTrackedPaths, listWorktreeGitDirs, repoContext } from "./engine.js";
import { CliError } from "./errors.js";
import {
  CURRENT_NAMES,
  forgetRepositoryNames,
  LEGACY_NAMES,
  MIGRATION_SCHEMA,
  migrationMarkerPath,
  repositoryNames,
} from "./locations.js";
import { assertReadableSchema } from "./schemas.js";
import { readJson, writeJson } from "./store.js";

export const MIGRATION_REPORT_SCHEMA = "causet.migration-report/v1";

/** Ref families that exist only while an operation runs (ADR-0039 §1). */
const TRANSIENT_FAMILIES = ["rebase", "exports", "import-staging"];

/**
 * `cst migrate` (ADR-0039 §3): move a repository's metadata from the names used
 * before issue #159 to the current ones.
 *
 * - Refs are **created** at the objects their former names hold, in one
 *   `update-ref --stdin` transaction; the former refs stay where they are.
 * - The notes configuration is repointed, the runtime directories move, and the
 *   tracked manifest directory is moved with a staged `git mv` the user commits.
 * - A marker records each former ref's object, so a later run can tell a former
 *   ref that advanced (a peer on an older build pushed to it) from one that
 *   did not.
 *
 * Every step checks its postcondition first, so a run after an interruption
 * completes what is missing and repeats nothing. Nothing is ever deleted.
 */
export function migrateRepository(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const plan = migrationPlan(cwd);
  if (options.dryRun || plan.refusal) {
    if (plan.refusal && !options.dryRun) throw plan.refusal;
    return report(plan, "dry-run");
  }
  const { context } = plan;
  const commands = plan.refs.flatMap((entry) => {
    if (entry.action === "create") return [`create ${entry.to} ${entry.oid}`];
    if (entry.action === "fast-forward") return [`update ${entry.to} ${entry.oid} ${entry.current}`];
    return [];
  });
  if (commands.length) {
    runGit(["update-ref", "--stdin"], {
      cwd: context.root,
      input: ["start", ...commands, "prepare", "commit", ""].join("\n"),
    });
  }
  for (const entry of plan.config.filter((item) => item.action === "repoint")) {
    runGit(["config", entry.key, entry.to], { cwd: context.root });
  }
  for (const entry of plan.paths.filter((item) => item.action === "move")) {
    fs.mkdirSync(path.dirname(entry.to), { recursive: true });
    fs.renameSync(entry.from, entry.to);
  }
  if (plan.specs.action === "move") {
    fs.mkdirSync(path.join(context.root, ".causet"), { recursive: true });
    runGit(["mv", "-k", LEGACY_NAMES.specsDir, CURRENT_NAMES.specsDir], { cwd: context.root });
  }
  writeJson(migrationMarkerPath(context), {
    schema: MIGRATION_SCHEMA,
    migratedAt: plan.marker?.migratedAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    refs: Object.fromEntries(plan.refs.map((entry) => [entry.from, entry.oid])),
  });
  forgetRepositoryNames();
  return report(plan, "apply");
}

/** The state `doctor` reports: `unmigrated`, `migrated`, or `mixed`. */
export function migrationState(cwd = process.cwd()) {
  const { state, evidence } = repositoryNames(cwd);
  if (state === "unmigrated") return "unmigrated";
  if (!evidence.legacy) return "migrated";
  return advancedLegacyRefs(cwd).length ? "mixed" : "migrated";
}

/**
 * Former refs that moved since `cst migrate` recorded them, or that appeared in
 * a repository already using the current names. Each is a `legacy-ref-advanced`
 * warning in `metadata status`. Costs Git processes only when legacy evidence
 * exists in a repository that no longer uses those names.
 */
export function advancedLegacyRefs(cwd = process.cwd()) {
  const { state, evidence } = repositoryNames(cwd);
  if (state === "unmigrated" || !evidence.legacy) return [];
  const context = repoContext(cwd);
  const recorded = readMarker(context)?.refs ?? {};
  return legacyRefs(context).filter((entry) => recorded[entry.ref] !== entry.oid);
}

function readMarker(context) {
  const marker = readJson(migrationMarkerPath(context), null);
  if (marker === null) return null;
  assertReadableSchema(marker?.schema, `The migration marker at '${migrationMarkerPath(context)}'`, {
    family: "causet.migration",
    recovery: "Read it with the causet build that wrote it.",
  });
  return marker;
}

function legacyRefs(context) {
  return [
    ...listRefs(LEGACY_NAMES.notesRef, context.root),
    ...listRefs(`${LEGACY_NAMES.refsRoot}/`, context.root),
  ];
}

function currentName(ref) {
  return ref === LEGACY_NAMES.notesRef
    ? CURRENT_NAMES.notesRef
    : `${CURRENT_NAMES.refsRoot}/${ref.slice(LEGACY_NAMES.refsRoot.length + 1)}`;
}

function migrationPlan(cwd) {
  const context = repoContext(cwd);
  const before = repositoryNames(cwd).state;
  const marker = readMarker(context);
  let refusal = null;
  // The first refusal wins; the plan is still built, so a dry run can show it all.
  const refuse = (error) => {
    refusal ??= error;
  };

  // Nothing moves while an operation holds state under either set of names.
  const gitDirs = [context.commonDir, ...listWorktreeGitDirs(context.root)];
  for (const gitDir of gitDirs) {
    for (const set of [LEGACY_NAMES, CURRENT_NAMES]) {
      for (const [file, command] of [["reconciliation.json", "reconcile"], ["rebase.json", "rebase"]]) {
        const journal = path.join(gitDir, set.runtime, file);
        if (fs.existsSync(journal)) {
          // A journal under the former names belongs to a build that still
          // read them; this one refuses the repository until it is migrated.
          const former = set === LEGACY_NAMES && before === "unmigrated";
          refuse(new CliError(`A ${command} operation is in progress ('${journal}'); cst migrate moves nothing while one is.`, {
            code: "operation-in-progress",
            details: former
              ? `Finish it with cst ${command} --continue, or discard it with cst ${command} --abort, using the build that started it (causet 0.21 or earlier), then run cst migrate again.`
              : `Finish it with cst ${command} --continue, or discard it with cst ${command} --abort, then run cst migrate again.`,
          }));
        }
      }
    }
  }
  const legacy = legacyRefs(context);
  for (const entry of legacy) {
    const family = entry.ref.slice(LEGACY_NAMES.refsRoot.length + 1).split("/")[0];
    if (entry.ref !== LEGACY_NAMES.notesRef && TRANSIENT_FAMILIES.includes(family)) {
      refuse(new CliError(`The transient ref '${entry.ref}' belongs to an unfinished operation; cst migrate moves nothing while one exists.`, {
        code: "operation-in-progress",
        details: "Finish or abort the operation that owns it (a causal rebase, a metadata export, or a metadata import), then run cst migrate again.",
      }));
    }
  }

  const current = new Map([
    ...listRefs(CURRENT_NAMES.notesRef, context.root),
    ...listRefs(`${CURRENT_NAMES.refsRoot}/`, context.root),
  ].map((entry) => [entry.ref, entry.oid]));
  const refs = legacy.map((entry) => {
    const to = currentName(entry.ref);
    const existing = current.get(to) ?? null;
    const base = { from: entry.ref, to, oid: entry.oid, current: existing };
    if (existing === null) return { ...base, action: "create" };
    if (existing === entry.oid) return { ...base, action: "present" };
    // The former ref moved after an earlier migration. Only a fast-forward of a
    // new ref that did not move itself is taken; anything else is a real
    // disagreement, which the envelope import resolves under ADR-0030.
    const recorded = marker?.refs?.[entry.ref] ?? null;
    if (recorded === existing && isAncestor(existing, entry.oid, context.root)) {
      return { ...base, action: "fast-forward" };
    }
    refuse(new CliError(`Both '${entry.ref}' and '${to}' moved since the migration; cst migrate will not choose between them.`, {
      code: "precondition-not-met",
      details: "Export the former side with an older build (cst metadata export) and import it here with cst metadata import --dry-run, then --apply; the import applies ADR-0030's conflict policy.",
    }));
    return { ...base, action: "conflict" };
  });

  const config = ["notes.displayRef", "notes.rewriteRef"].map((key) => {
    const value = runGit(["config", "--get", key], { cwd: context.root, allowFailure: true }).stdout.trim() || null;
    return {
      key,
      from: value,
      to: CURRENT_NAMES.notesRef,
      action: value === LEGACY_NAMES.notesRef ? "repoint" : "keep",
    };
  });

  const paths = [];
  for (const gitDir of gitDirs) {
    const from = path.join(gitDir, LEGACY_NAMES.runtime);
    if (!fs.existsSync(from)) continue;
    for (const entry of fs.readdirSync(from)) {
      if (entry.endsWith(".lock")) continue;
      const source = path.join(from, entry);
      const target = path.join(gitDir, CURRENT_NAMES.runtime, entry);
      if (fs.existsSync(target)) {
        paths.push({ from: source, to: target, action: "present" });
      } else {
        paths.push({ from: source, to: target, action: "move" });
      }
    }
  }

  const trackedLegacy = listTrackedPaths([LEGACY_NAMES.specsDir], context.root);
  const trackedCurrent = listTrackedPaths([CURRENT_NAMES.specsDir], context.root);
  const specs = {
    from: LEGACY_NAMES.specsDir,
    to: CURRENT_NAMES.specsDir,
    files: trackedLegacy.length,
    action: trackedLegacy.length === 0 ? "none" : trackedCurrent.length ? "present" : "move",
  };
  if (specs.action === "present") {
    refuse(new CliError(`Both ${LEGACY_NAMES.specsDir} and ${CURRENT_NAMES.specsDir} hold tracked manifests; cst migrate will not merge them.`, {
      code: "precondition-not-met",
      details: "Keep one directory: remove or move the other with git, commit, and run cst migrate again.",
    }));
  }
  return { context, before, marker, refusal, refs, config, paths, specs };
}

function report(plan, mode) {
  const changed = (items) => items.filter((item) => !["present", "keep", "none"].includes(item.action)).length;
  return {
    schema: MIGRATION_REPORT_SCHEMA,
    mode,
    stateBefore: plan.before,
    stateAfter: mode === "apply" ? migrationState(plan.context.root) : plan.before,
    refused: plan.refusal ? { code: plan.refusal.code, message: plan.refusal.message, details: plan.refusal.details } : null,
    refs: plan.refs.map(({ from, to, oid, action }) => ({ from, to, oid, action })),
    config: plan.config,
    paths: plan.paths.map((entry) => ({
      from: path.relative(plan.context.commonDir, entry.from).split(path.sep).join("/"),
      to: path.relative(plan.context.commonDir, entry.to).split(path.sep).join("/"),
      action: entry.action,
    })),
    specs: plan.specs,
    summary: {
      refs: changed(plan.refs),
      config: changed(plan.config),
      paths: changed(plan.paths),
      specs: plan.specs.action === "move" ? plan.specs.files : 0,
      commitRequired: plan.specs.action === "move",
    },
  };
}
