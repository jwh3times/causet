/**
 * Every N1 check on the generated histories of `generated-histories.js`
 * (#308, ADR-0044 items 1, 4 and 5), on one history each:
 *
 * - Git reads what was generated, malformed objects included;
 * - equality: N1's commands on the copy answer as Git does on the original
 *   (`compareCopy`, the comparison of the native-kind mode), after each
 *   stage;
 * - the reconstruction check, `cst import --verify`, and `cst fsck`;
 * - both import checks: two fresh imports write byte-identical stores, one
 *   from the history and one from a packed copy of it, and an import of the
 *   second stage into the first stage's copy holds what a full import of the
 *   final history holds, with its own earlier objects and alias rows.
 *
 * Run as a script, it checks a shard of a corpus and prints one JSON line per
 * history: `--seed <seed> --count <n> --shard <k> --of <shards>` checks the
 * histories whose index is `k` modulo `shards`. Each `cst` and `git` a check
 * starts is a process, and one Node process starts only about a thousand a
 * second whatever its concurrency, so a corpus is checked by several. The
 * environment it is given is the one every process it starts runs in.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { cstCommand, cstPrefix } from "./cst-command.js";
import { PROCESS_LIMIT, bounded } from "./bounded-process.js";
import { history } from "./generated-histories.js";
import { compareCopy, withoutGit } from "./native-kind.js";
import { sameAsFull, sameStores, storeState } from "./import-checks.js";

const OPT_IN = { CAUSET_EXPERIMENTAL: "native" };

/** A process's status and output, without holding the event loop. */
function run(command, args, { cwd, env }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], timeout: PROCESS_LIMIT });
    const ending = bounded(child);
    const [stdout, stderr] = [[], []];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => resolve({ status: null, stdout: Buffer.alloc(0), stderr: String(error) }));
    child.on("close", (status, signal) => resolve({
      status, stdout: Buffer.concat(stdout), stderr: `${Buffer.concat(stderr)}${ending(signal)}`,
    }));
  });
}

/**
 * Checks history `index` of corpus `seed` in a new directory under `base`,
 * removed when it ends. `env` makes the environment of each process.
 * Resolves to the history's cases and format and the problems found.
 */
export async function checkHistory({ seed, index, env, base = os.tmpdir() }) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(base, "cg")));
  const made = history({ directory: path.join(root, "source"), seed, index, env });
  const problems = [];
  const where = (stage) => `history ${index} of seed ${seed} (${stage})`;
  // Import reads Git; every other `cst` here reads the store, without Git.
  const cst = async (cwd, args) => {
    const environment = args[0] === "import" && args[1] !== "--verify" ? env(OPT_IN) : withoutGit(env(OPT_IN));
    const result = await run(cstCommand, [...cstPrefix(), ...args], { cwd, env: environment });
    assert.equal(result.status, 0, `cst ${args.join(" ")}: ${result.stderr}`);
  };
  try {
    const repository = { path: made.path, common: made.path };
    await made.generate();
    const walked = await run("git", ["rev-list", "--objects", "--all"], { cwd: made.path, env: env({ GIT_NO_REPLACE_OBJECTS: "1" }) });
    assert.equal(walked.status, 0, `git rev-list --objects --all: ${walked.stderr}`);

    // The second fresh import reads a copy whose objects and refs are packed:
    // a store is the same whatever Git repository holds the history
    // (storage.md §7).
    const packed = path.join(root, "packed");
    fs.cpSync(made.path, packed, { recursive: true });
    for (const args of [["repack", "-adq"], ["pack-refs", "--all"]]) {
      const result = await run("git", args, { cwd: packed, env: env({ GIT_NO_REPLACE_OBJECTS: "1" }) });
      assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
    }
    await cst(root, ["import", made.path, "first"]);
    await cst(root, ["import", packed, "second"]);
    const [first, second, full] = ["first", "second", "full"].map((name) => path.join(root, name));
    sameStores(first, second, "the fresh imports of the history and its packed copy");
    await cst(first, ["fsck"]);
    problems.push(...await compareCopy(repository, first, { env, where: where("stage 1"), width: 4 }));
    const before = storeState(first, made.format);

    await made.advance();
    await cst(root, ["import", made.path, "first"]);
    await cst(root, ["import", made.path, "full"]);
    sameAsFull({ before, incremental: first, full, format: made.format });
    await cst(first, ["fsck"]);
    await cst(first, ["import", "--verify"]);
    problems.push(...await compareCopy(repository, full, { env, where: where("stage 2"), width: 4 }));
  } catch (error) {
    problems.push(`${where("checks")}: ${error.message}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
  return { index, format: made.format, cases: [...made.cases], problems };
}

/** The script: a shard of a corpus, one JSON line per history. */
async function main(argv) {
  const options = {};
  for (let at = 0; at < argv.length; at += 2) {
    if (!argv[at].startsWith("--") || argv[at + 1] === undefined) throw new Error(`unexpected argument ${argv[at]}`);
    options[argv[at].slice(2)] = argv[at + 1];
  }
  const { seed, count, shard = "0", of = "1", only } = options;
  if (!seed || (!count && only === undefined)) throw new Error("--seed and --count (or --only) are required");
  const indexes = only !== undefined ? [Number(only)]
    : Array.from({ length: Number(count) }, (_, index) => index).filter((index) => index % Number(of) === Number(shard));
  const env = (overrides = {}) => ({ ...process.env, ...overrides });
  // Two histories at a time: while one waits on Git or a container read,
  // the other starts processes.
  let next = 0;
  await Promise.all([0, 1].map(async () => {
    while (next < indexes.length) {
      const result = await checkHistory({ seed, index: indexes[next++], env });
      process.stdout.write(`${JSON.stringify(result)}\n`);
    }
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
  });
}
