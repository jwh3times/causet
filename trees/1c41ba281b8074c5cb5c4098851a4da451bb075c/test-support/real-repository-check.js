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
 * Each import's time is reported, never checked.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
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

/**
 * Checks the real repository `name`, in a new directory under `base`. `env`
 * makes the environment of each process. Resolves to its report: the
 * repository's object count, both byte counts with their parts, the storage
 * gate's verdict, each import's time, and the problems found.
 */
export async function checkRepository({ name, env, base = os.tmpdir() }) {
  const repository = REAL_REPOSITORIES[name];
  assert.ok(repository, `no real repository is named ${name}`);
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(base, "cr")));
  const where = `the real repository ${name}`;
  const report = { name, objects: 0, native: null, git: null, gate: null, seconds: {}, problems: [] };
  const run = (command, args, cwd, environment) => {
    const result = spawnSync(command, args, { cwd, env: environment, encoding: "buffer", timeout: LIMIT, maxBuffer: 64 * 1024 * 1024 });
    assert.equal(result.status, 0, `${path.basename(command)} ${args.join(" ")}: ${result.error ?? result.stderr}`);
    return result.stdout.toString();
  };
  const git = (cwd, args) => run("git", args, cwd, env({ GIT_NO_REPLACE_OBJECTS: "1" }));
  const cst = (cwd, args) => run(cstCommand, [...cstPrefix(), ...args], cwd, env(OPT_IN));
  const read = (cwd, args) => run(cstCommand, [...cstPrefix(), ...args], cwd, withoutGit(env(OPT_IN)));
  const imported = (label, from, into) => {
    const started = performance.now();
    cst(root, ["import", from, into]);
    report.seconds[label] = Math.round((performance.now() - started) / 100) / 10;
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
      env, where, select: repository.select, limit: LIMIT,
    }));
  } catch (error) {
    report.problems.push(`${where}: ${error.message}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
  return report;
}
