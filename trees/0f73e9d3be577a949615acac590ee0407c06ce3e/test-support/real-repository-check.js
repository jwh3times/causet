/**
 * Every N1 check on one real repository of `real-repositories.js` (#309,
 * ADR-0044 items 1, 2, 4 and 5), in a new directory removed when it ends:
 *
 * - the import checks: an import of the first stage, then of the second into
 *   the same copy, holds what a full import of the second holds; and a fresh
 *   import of a copy with every object and ref packed writes a store
 *   byte-identical to the full import's;
 * - `cst fsck` on both copies, the reconstruction check (`cst import
 *   --verify`) on both (the full import's as `compareCopy` begins), and
 *   equality: N1's commands on the full import answer as Git does on the
 *   repository (`compareCopy`);
 * - zero Git processes: every native read runs with no Git on its `PATH`;
 * - the storage gate: the full import's store against what `git gc
 *   --aggressive` leaves in `objects/pack/` of the repository, the pack, its
 *   index, reverse index and bitmap. Stored bytes must be at most Git's, and
 *   on the large-file corpus strictly fewer, unless the repository carries a
 *   known-gap entry (`storage-gate.js`).
 *
 * What each import cost is reported, never checked (#347), from import's own
 * report (`CAUSET_TEST_IMPORT_REPORT`): its time, in all and by phase, the
 * `cst import` process's peak memory where the system reports it (Linux),
 * in all and as each phase ended, and the peak size of the metadata it held
 * on disk until its container closed. After every check, one more commit is
 * imported into the full import's copy, which `cst fsck` then checks: what a
 * small incremental import costs a store that size (#324).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cstCommand, cstPrefix } from "./cst-command.js";
import { sameAsFull, sameStores, storeState } from "./import-checks.js";
import { compareCopy, withoutGit } from "./native-kind.js";
import { aliasRows } from "./native-store.js";
import { REAL_REPOSITORIES } from "./real-repositories.js";
import { storageGate } from "./storage-gate.js";

const OPT_IN = { CAUSET_EXPERIMENTAL: "native" };

/**
 * How long an import, `cst fsck` or the reconstruction check may run here.
 * On git/git each takes minutes, not the seconds `bounded-process.js` allows
 * the generated histories.
 */
const LIMIT = 3 * 60 * 60 * 1000;

/** The bytes of every file under `directory`, and of each by `name(file)`. */
function bytesUnder(directory, name) {
  const parts = {};
  let total = 0;
  const visit = (at) => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const file = path.join(at, entry.name);
      if (entry.isDirectory()) {
        visit(file);
        continue;
      }
      const size = fs.statSync(file).size;
      const part = name(path.relative(directory, file));
      parts[part] = (parts[part] ?? 0) + size;
      total += size;
    }
  };
  visit(directory);
  return { total, parts };
}

/** The identity and date of the one commit added after the checks. */
const ONE_COMMIT = {
  GIT_AUTHOR_NAME: "A U Thor", GIT_AUTHOR_EMAIL: "author@example.com", GIT_AUTHOR_DATE: "1112911993 -0700",
  GIT_COMMITTER_NAME: "C O Mitter", GIT_COMMITTER_EMAIL: "committer@example.com", GIT_COMMITTER_DATE: "1112911993 -0700",
};

/**
 * Checks the real repository `name`, in a new directory under `base`. `env`
 * makes the environment of each process. Resolves to its report: the
 * repository's object count, both byte counts with their parts, the storage
 * gate's verdict, what each import cost by its label (the report import
 * wrote), and the problems found.
 */
export async function checkRepository({ name, env, base = os.tmpdir() }) {
  const repository = REAL_REPOSITORIES[name];
  assert.ok(repository, `no real repository is named ${name}`);
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(base, "cr")));
  const where = `the real repository ${name}`;
  const report = { name, objects: 0, native: null, git: null, gate: null, imports: {}, problems: [] };
  const run = (command, args, cwd, environment, input = undefined) => {
    const result = spawnSync(command, args, { cwd, env: environment, input, encoding: "buffer", timeout: LIMIT, maxBuffer: 64 * 1024 * 1024 });
    assert.equal(result.status, 0, `${path.basename(command)} ${args.join(" ")}: ${result.error ?? result.stderr}`);
    return result.stdout.toString();
  };
  const git = (cwd, args, more = {}, input = undefined) => run("git", args, cwd, env({ GIT_NO_REPLACE_OBJECTS: "1", ...more }), input);
  const read = (cwd, args) => run(cstCommand, [...cstPrefix(), ...args], cwd, withoutGit(env(OPT_IN)));
  const cost = path.join(root, "cost.json");
  const imported = (label, from, into) => {
    fs.rmSync(cost, { force: true });
    run(cstCommand, [...cstPrefix(), "import", from, into], root, env({ ...OPT_IN, CAUSET_TEST_IMPORT_REPORT: cost }));
    report.imports[label] = JSON.parse(fs.readFileSync(cost, "utf8"));
  };
  try {
    const source = path.join(root, "source");
    git(root, ["init", "--quiet", "--bare", source]);
    await repository.stage(source, 1, env());
    const format = git(source, ["rev-parse", "--show-object-format"]).trim();
    imported("first stage", "source", "incremental");
    const incremental = path.join(root, "incremental");
    read(incremental, ["fsck"]);
    const before = storeState(incremental, format);

    await repository.stage(source, 2, env());
    imported("second stage, incrementally", "source", "incremental");
    imported("second stage, in full", "source", "full");
    const full = path.join(root, "full");

    // The storage gate first, so that its byte counts are reported whatever
    // the checks after it find. The packed copy is then imported again: a
    // store is the same whatever Git repository holds the history
    // (storage.md §7), and this one has every object in one pack.
    const packed = path.join(root, "packed");
    fs.cpSync(source, packed, { recursive: true });
    git(packed, ["gc", "--aggressive", "--prune=now", "--quiet"]);
    report.native = bytesUnder(path.join(full, ".cst"), (file) => file.split(path.sep)[0]);
    report.git = bytesUnder(path.join(packed, "objects", "pack"), (file) => path.extname(file).slice(1));
    const verdict = storageGate(repository, report.native.total, report.git.total, where);
    report.gate = verdict.gate;
    if (verdict.problem) report.problems.push(verdict.problem);

    sameAsFull({ before, incremental, full, format });
    read(incremental, ["fsck"]);
    read(incremental, ["import", "--verify"]);
    fs.rmSync(incremental, { recursive: true, force: true });
    imported("second stage, from a packed copy", "packed", "again");
    sameStores(full, path.join(root, "again"), "the fresh imports of the repository and its packed copy");
    fs.rmSync(path.join(root, "again"), { recursive: true, force: true });

    read(full, ["fsck"]);
    report.objects = aliasRows(full, format).size;
    report.problems.push(...await compareCopy({ path: source, common: source }, full, {
      env, where, limit: LIMIT,
    }));

    // One more commit, a new file at the top, on the history the full import
    // holds: what a small incremental import costs a store this size (#324).
    const index = { ...ONE_COMMIT, GIT_INDEX_FILE: path.join(root, "one-commit-index") };
    git(source, ["read-tree", "refs/heads/main"], index);
    const blob = git(source, ["hash-object", "-w", "--stdin"], index, Buffer.from("one more commit\n")).trim();
    git(source, ["update-index", "--add", "--cacheinfo", `100644,${blob},causet-one-more-commit.txt`], index);
    const tree = git(source, ["write-tree"], index).trim();
    const commit = git(source, ["commit-tree", tree, "-p", "refs/heads/main", "-m", "One more commit"], index).trim();
    git(source, ["update-ref", "refs/heads/main", commit]);
    imported("one more commit, incrementally", "source", "full");
    read(full, ["fsck"]);
  } catch (error) {
    report.problems.push(`${where}: ${error.message}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
  return report;
}
