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
 * checks one history, to reproduce a failure. `CAUSET_GENERATED_REPORT=<file>`
 * writes what the corpus test found to that file as JSON, which the weekly
 * run on a rotating seed files an issue from (`scripts/rotating-corpus.mjs`,
 * #336). A reftable history needs Git 2.46 or later; on an older Git it is
 * skipped with that reason (#334).
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
import {
  CASES, MALFORMED, REF_CASES, REFTABLE_CASES, corpusReport, history, reftableReason, reftableUnsupported, refStorageOf,
  skipReason,
} from "../test-support/generated-histories.js";

const SEED = process.env.CAUSET_GENERATED_SEED || "causet-n1";
const COUNT = Number(process.env.CAUSET_GENERATED_HISTORIES || CASES.length);
const ONLY = process.env.CAUSET_GENERATED_ONLY;
if (!Number.isSafeInteger(COUNT) || COUNT < 1) {
  throw new Error(`CAUSET_GENERATED_HISTORIES must be a positive integer, not ${process.env.CAUSET_GENERATED_HISTORIES}`);
}

/** Why this host skips the reftable histories, or null when it makes them. */
const REFTABLE_SKIP = await reftableUnsupported(testEnv);

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

/**
 * What a history is, as Git reads it: its refs, HEAD and objects. HEAD is
 * Git's answer, since a reftable repository's HEAD file is only a stub.
 */
function shape(repository) {
  const read = (args) => {
    const result = git(repository, args);
    assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.toString("latin1");
  };
  const symbolic = git(repository, ["symbolic-ref", "--quiet", "HEAD"]);
  return {
    refs: read(["for-each-ref", "--format=%(refname) %(objectname) %(symref)"]),
    head: symbolic.status === 0 ? `ref: ${symbolic.stdout.toString("latin1")}` : read(["rev-parse", "--verify", "HEAD"]),
    objects: read(["cat-file", "--batch-all-objects", "--batch-check"]),
  };
}

test("a reftable history needs Git 2.46 or later, and an older Git says why it skips one", () => {
  for (const answer of ["git version 2.46.0", "git version 2.55.0.windows.3\n", "git version 3.0.0"]) {
    assert.equal(reftableReason(answer), null, answer);
  }
  assert.equal(reftableReason("git version 2.45.2\n"),
    "the reftable histories need Git 2.46 or later, and this is git version 2.45.2");
  assert.equal(reftableReason("git version 2.40.1"),
    "the reftable histories need Git 2.46 or later, and this is git version 2.40.1");
  assert.equal(reftableReason("git: command not found"),
    "the reftable histories need Git 2.46 or later, and `git version` answered \"git: command not found\"");
});

test("a seed generates the same histories every time, and another seed others", (t) => inScratch(async (root) => {
  const generated = async (seed, index, name) => {
    const made = history({ directory: path.join(root, name), seed, index, env: testEnv });
    await made.generate();
    const first = shape(made.path);
    await made.advance();
    return { first, second: shape(made.path) };
  };
  // A few histories, and those of the cases of refs: the digests below hold
  // the corpus to every host's.
  for (const index of [0, 1, 2, 3, 4, 5, ...REF_CASES.map((each) => CASES.indexOf(each))]) {
    const skip = await skipReason({ seed: SEED, index, env: testEnv });
    await t.test(`history ${index}`, { skip: skip ?? false }, async () => {
      const one = await generated(SEED, index, `${index}-one`);
      const again = await generated(SEED, index, `${index}-again`);
      const other = await generated(`${SEED}-other`, index, `${index}-other`);
      assert.deepEqual(again, one, `history ${index} of ${SEED}`);
      assert.notDeepEqual(other.first.objects, one.first.objects, `history ${index} of another seed`);
    });
  }
}));

/**
 * The digests of what the first `CASES.length` histories of `causet-n1`, the
 * corpus CI checks, are after each stage: their refs, HEAD and objects as
 * Git lists them, one digest for the files histories and one for the
 * reftable ones. Every host must generate the same corpus, so a change to
 * the generator that changes it changes these, deliberately. A host whose
 * Git skips the reftable histories still checks the files histories' digest.
 */
const CORPUS_DIGESTS = {
  files: "c37b6e2bbb5ab010c4b01ad36080b40557e639aad016ef44630f932b5728c917",
  reftable: "623398907eed384b1bd717aa5b1086e5f10abb11318b081a13bb7c6ffec3bdb5",
};

for (const refStorage of ["files", "reftable"]) {
  const skip = refStorage === "reftable" ? REFTABLE_SKIP ?? false : false;
  test(`the corpus CI checks is the same on every host (its ${refStorage} histories)`, { skip }, () => inScratch(async (root) => {
    const digest = crypto.createHash("sha256");
    let histories = 0;
    for (let index = 0; index < CASES.length; index++) {
      if (refStorageOf({ seed: "causet-n1", index }) !== refStorage) continue;
      const made = history({ directory: path.join(root, String(index)), seed: "causet-n1", index, env: testEnv });
      histories++;
      await made.generate();
      digest.update(JSON.stringify(shape(made.path)));
      await made.advance();
      digest.update(JSON.stringify(shape(made.path)));
    }
    assert.ok(histories > 0, `the corpus has no ${refStorage} history`);
    assert.equal(digest.digest("hex"), CORPUS_DIGESTS[refStorage]);
  }));
}

test("history n holds case n of the list, so a corpus of one history per case holds them all", (t) => inScratch(async (root) => {
  const held = new Set();
  const unmade = [];
  for (let index = 0; index < CASES.length; index++) {
    if (await skipReason({ seed: SEED, index, env: testEnv })) {
      unmade.push(CASES[index]);
      continue;
    }
    const made = history({ directory: path.join(root, String(index)), seed: SEED, index, env: testEnv });
    await made.generate();
    assert.ok(made.cases.has(CASES[index]), `history ${index} lacks ${CASES[index]}: ${[...made.cases]}`);
    for (const each of made.cases) held.add(each);
  }
  // Only a case's own reftable history goes unmade, and only on an older Git.
  if (unmade.length > 0) t.diagnostic(`not made, as ${REFTABLE_SKIP}: ${unmade.join(", ")}`);
  assert.deepEqual(unmade, REFTABLE_SKIP ? REFTABLE_CASES : []);
  if (!REFTABLE_SKIP) {
    for (const each of ["non-utf8-symbolic-ref", "non-utf8-symbolic-chain"]) assert.ok(held.has(each), `no history holds ${each}`);
  }
  assert.deepEqual(CASES.filter((each) => !held.has(each) && !unmade.includes(each)), []);
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
  if (process.env.CAUSET_GENERATED_REPORT) {
    fs.writeFileSync(process.env.CAUSET_GENERATED_REPORT,
      `${JSON.stringify(corpusReport(results, { seed: SEED, histories: ONLY !== undefined ? 1 : COUNT }), null, 2)}\n`);
  }
  assert.deepEqual(results.map((result) => result.index), expected, "every history is checked once");
  for (const { index, format, refStorage, cases, problems, skipped } of results) {
    if (skipped) {
      await t.test(`history ${index} (${format}, ${refStorage})`, { skip: skipped }, () => {});
      continue;
    }
    await t.test(`history ${index} (${format}, ${refStorage}: ${cases.join(", ")})`, () => {
      // The history's shard ran the CLI on it: counted here for the report
      // of tests that never invoke a selected CLI (`git-environment.js`).
      cstPrefix();
      assert.deepEqual(problems, [], `reproduce with CAUSET_GENERATED_SEED=${SEED} CAUSET_GENERATED_ONLY=${index}`);
    });
  }
  // How many versions the incremental import check found stored as a delta
  // by both imports, and compared.
  t.diagnostic(`deltas both imports store, compared: ${results.reduce((sum, result) => sum + (result.deltas ?? 0), 0)}`);
  // Each subtest's count is reset as it ends, and the shards ran the CLI for
  // this test too.
  cstPrefix();
});
