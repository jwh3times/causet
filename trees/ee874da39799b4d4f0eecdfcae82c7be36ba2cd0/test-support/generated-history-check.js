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
import { compareCopy } from "./native-kind.js";
import { TYPES, aliases, containers, readContainer, storeFiles } from "./native-store.js";

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

const sorted = (items) => [...items].sort();

/**
 * A store's objects, as hex: `named`, those the history names, with each
 * one's stored form, and `chunks`, content no alias row names. That content
 * is a chunk of a larger file, a storage detail (ADR-0045, decision 4) whose
 * presence depends on the forms import chose. A store holds each object
 * once (storage.md §4.2).
 */
function objects(store, format) {
  const rows = new Set(aliases(store, format).values());
  const found = { named: new Map(), chunks: new Set() };
  for (const file of containers(store)) {
    for (const object of readContainer(file).objects) {
      const id = object.name.toString("hex");
      assert.ok(!found.named.has(id) && !found.chunks.has(id), `${store} holds ${id} twice`);
      if (object.type !== TYPES.content || rows.has(id)) found.named.set(id, object.form);
      else found.chunks.add(id);
    }
  }
  return found;
}

// A chunk list and a delta (objects.md §3), the forms one large version may
// take in one store and not another.
const CHUNKED = 1;
const DELTA = 2;

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
  const cst = async (cwd, args) => {
    const result = await run(cstCommand, [...cstPrefix(), ...args], { cwd, env: env(OPT_IN) });
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
    const [first, second] = [path.join(root, "first"), path.join(root, "second")];
    const written = storeFiles(first);
    const again = storeFiles(second);
    assert.deepEqual([...again.keys()], [...written.keys()], "the fresh imports of the history and its packed copy hold other files");
    for (const [name, bytes] of written) {
      assert.ok(again.get(name).equals(bytes), `the fresh imports of the history and its packed copy differ in ${name}`);
    }
    await cst(first, ["fsck"]);
    problems.push(...await compareCopy(repository, first, { env, where: where("stage 1"), width: 4 }));
    const before = { objects: objects(first, made.format), aliases: aliases(first, made.format) };

    await made.advance();
    await cst(root, ["import", made.path, "first"]);
    await cst(root, ["import", made.path, "full"]);
    const full = path.join(root, "full");
    assert.ok(fs.readFileSync(path.join(first, ".cst", "snapshot")).equals(fs.readFileSync(path.join(full, ".cst", "snapshot"))),
      "the incremental import's ref snapshot differs from the full import's");
    const after = objects(first, made.format);
    const whole = objects(full, made.format);
    assert.deepEqual(sorted(after.named.keys()), sorted(new Set([...before.objects.named.keys(), ...whole.named.keys()])),
      "the incremental import's objects are not its own and the full import's");
    for (const [id, form] of before.objects.named) {
      assert.equal(after.named.get(id), form, `the incremental import changed the form of ${id}, which it held already`);
    }
    // Each form is what the store held when it was written (storage.md §5.1):
    // a delta needs its base present, and chunks win when the store holds
    // more of them. An incremental import's store holds other things than a
    // full import's at each version, so a large version may be a chunk list
    // in one and a delta in the other, and nothing else may differ.
    let chunkedHere = false;
    for (const [id, form] of whole.named) {
      const other = after.named.get(id);
      assert.ok(other === form || (Math.min(form, other) === CHUNKED && Math.max(form, other) === DELTA),
        `${id} is stored in form ${other} by the incremental import and ${form} by the full import`);
      if (other === CHUNKED && form === DELTA && !before.objects.named.has(id)) chunkedHere = true;
    }
    // Only a new version the incremental import chunked and the full import
    // did not brings chunks the full import lacks. Otherwise every chunk is
    // one of the two.
    if (!chunkedHere) {
      const known = new Set([...before.objects.chunks, ...whole.chunks]);
      assert.deepEqual([...after.chunks].filter((id) => !known.has(id)), [],
        "the incremental import holds chunks that neither its earlier store nor the full import holds");
    }
    const rows = aliases(first, made.format);
    const fullRows = aliases(full, made.format);
    assert.deepEqual(sorted(rows.keys()), sorted(new Set([...before.aliases.keys(), ...fullRows.keys()])),
      "the incremental import's alias rows are not its own and the full import's");
    for (const [gitId, id] of [...before.aliases, ...fullRows]) {
      assert.equal(rows.get(gitId), id, `the incremental import's alias for ${gitId}`);
    }
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
