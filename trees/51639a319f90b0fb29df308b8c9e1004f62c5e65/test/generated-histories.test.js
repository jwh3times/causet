/**
 * The generated-history corpus (#308, ADR-0044 item 1, ADR-0045 decision 13):
 * histories generated from a seed (`test-support/generated-histories.js`),
 * history n holding case n of N1's list, and every N1 check on each
 * (`test-support/generated-history-check.js`): equality, the reconstruction
 * check, and both import checks. The histories are checked by shards, Node
 * processes of their own, as many as the host has cores.
 *
 * By default the suite checks one history per case. `CAUSET_GENERATED_HISTORIES=<n>`
 * checks `n`, as the weekly run does with 1,000 (`.github/workflows/corpora.yml`);
 * `CAUSET_GENERATED_SEED` chooses another seed, and `CAUSET_GENERATED_ONLY=<index>`
 * checks one history, to reproduce a failure.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { testEnv } from "../test-support/git-environment.js";
import { cstPrefix } from "../test-support/cst-command.js";
import { CASES, MALFORMED, history } from "../test-support/generated-histories.js";

const SEED = process.env.CAUSET_GENERATED_SEED || "causet-n1";
const COUNT = Number(process.env.CAUSET_GENERATED_HISTORIES || CASES.length);
const ONLY = process.env.CAUSET_GENERATED_ONLY;
if (!Number.isSafeInteger(COUNT) || COUNT < 1) {
  throw new Error(`CAUSET_GENERATED_HISTORIES must be a positive integer, not ${process.env.CAUSET_GENERATED_HISTORIES}`);
}

// Every repository here, and every one a shard makes, is removed before its
// test ends: the checks here already include the native-kind mode's
// comparison, so that mode has nothing of this suite's to import again.
const BASE = os.tmpdir();

/** Runs `body` with a new directory, removed when it ends. */
async function inScratch(body) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(BASE, "cg")));
  try {
    return await body(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
}

/** Git as import reads a repository: every object as stored. */
function git(cwd, args) {
  return spawnSync("git", args, {
    cwd, env: testEnv({ GIT_NO_REPLACE_OBJECTS: "1" }), encoding: "buffer", maxBuffer: 256 * 1024 * 1024,
  });
}

/** What a history is, as Git reads it: its refs, HEAD and objects. */
function shape(repository) {
  const read = (args) => {
    const result = git(repository, args);
    assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.toString("latin1");
  };
  return {
    refs: read(["for-each-ref", "--format=%(refname) %(objectname) %(symref)"]),
    head: fs.readFileSync(path.join(repository, "HEAD"), "latin1"),
    objects: read(["cat-file", "--batch-all-objects", "--batch-check"]),
  };
}

test("a seed generates the same histories every time, and another seed others", () => inScratch(async (root) => {
  const generated = async (seed, index, name) => {
    const made = history({ directory: path.join(root, name), seed, index, env: testEnv });
    await made.generate();
    const first = shape(made.path);
    await made.advance();
    return { first, second: shape(made.path) };
  };
  // A few histories: the digest below holds the corpus to every host's.
  for (let index = 0; index < 6; index++) {
    const one = await generated(SEED, index, `${index}-one`);
    const again = await generated(SEED, index, `${index}-again`);
    const other = await generated(`${SEED}-other`, index, `${index}-other`);
    assert.deepEqual(again, one, `history ${index} of ${SEED}`);
    assert.notDeepEqual(other.first.objects, one.first.objects, `history ${index} of another seed`);
  }
}));

/**
 * The digest of what the first `CASES.length` histories of `causet-n1`, the
 * corpus CI checks, are after each stage: their refs, HEAD and objects as
 * Git lists them. Every host must generate the same corpus, so a change to
 * the generator that changes it changes this, deliberately.
 */
const CORPUS_DIGEST = "721f766a1fc72d416d8fa49e6295459888afd0ee5b072654e52b921ce0b10ece";

test("the corpus CI checks is the same on every host", () => inScratch(async (root) => {
  const digest = crypto.createHash("sha256");
  for (let index = 0; index < CASES.length; index++) {
    const made = history({ directory: path.join(root, String(index)), seed: "causet-n1", index, env: testEnv });
    await made.generate();
    digest.update(JSON.stringify(shape(made.path)));
    await made.advance();
    digest.update(JSON.stringify(shape(made.path)));
  }
  assert.equal(digest.digest("hex"), CORPUS_DIGEST);
}));

test("history n holds case n of the list, so a corpus of one history per case holds them all", () => inScratch(async (root) => {
  const held = new Set();
  for (let index = 0; index < CASES.length; index++) {
    const made = history({ directory: path.join(root, String(index)), seed: SEED, index, env: testEnv });
    await made.generate();
    assert.ok(made.cases.has(CASES[index]), `history ${index} lacks ${CASES[index]}: ${[...made.cases]}`);
    for (const each of made.cases) held.add(each);
  }
  assert.deepEqual(CASES.filter((each) => !held.has(each)), []);
  assert.ok(MALFORMED.every((kind) => held.has(`malformed:${kind}`)));
}));

const CHECK = fileURLToPath(new URL("../test-support/generated-history-check.js", import.meta.url));

/**
 * The results of a shard of the corpus, checked by a Node process of its
 * own: one Node process starts only about a thousand processes a second.
 */
function shard(args) {
  return new Promise((resolve, reject) => {
    // The shard's processes run in the suite's Git environment. It is a
    // script, not one of this runner's tests.
    const env = testEnv();
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, [CHECK, "--seed", SEED, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    const [stdout, stderr] = [[], []];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (status) => {
      const output = Buffer.concat(stdout).toString();
      if (status !== 0) reject(new Error(`the shard ${args.join(" ")} exited ${status}: ${Buffer.concat(stderr)}`));
      else resolve(output.split("\n").filter(Boolean).map((line) => JSON.parse(line)));
    });
  });
}

test(`every generated history passes every N1 check (seed ${SEED})`, async (t) => {
  const shards = ONLY !== undefined ? 1 : Math.max(1, Math.min(COUNT, os.availableParallelism()));
  const results = (await Promise.all(Array.from({ length: shards }, (_, k) => shard(ONLY !== undefined
    ? ["--only", ONLY]
    : ["--count", String(COUNT), "--shard", String(k), "--of", String(shards)])))).flat();
  results.sort((a, b) => a.index - b.index);
  const expected = ONLY !== undefined ? [Number(ONLY)] : Array.from({ length: COUNT }, (_, index) => index);
  assert.deepEqual(results.map((result) => result.index), expected, "every history is checked once");
  for (const { index, format, cases, problems } of results) {
    await t.test(`history ${index} (${format}: ${cases.join(", ")})`, () => {
      // The history's shard ran the CLI on it: counted here for the report
      // of tests that never invoke a selected CLI (`git-environment.js`).
      cstPrefix();
      assert.deepEqual(problems, [], `reproduce with CAUSET_GENERATED_SEED=${SEED} CAUSET_GENERATED_ONLY=${index}`);
    });
  }
  // Each subtest's count is reset as it ends, and the shards ran the CLI for
  // this test too.
  cstPrefix();
});
