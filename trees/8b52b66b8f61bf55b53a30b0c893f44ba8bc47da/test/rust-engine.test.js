/**
 * The Rust Git engine (`native/engine`, issue #143) against the answers of the
 * JavaScript engine it ported (`src/git.js` and `src/engine.js`): every
 * cataloged read operation, the object session and its cache, the merge-tree
 * session, the bypass rule, and the engine differential.
 *
 * Until #243 each call ran through `src/engine.js` and through the
 * `engine-probe` executable, and both had to return the same canonical value
 * (or the same error) and the same metrics: processes, session queries, cache
 * hits, fallbacks, native reads and direct reads, operation for operation.
 * The JavaScript answers to the same dated repositories and requests
 * (`test-support/engine-corpus.js`) are now frozen in
 * `test/fixtures/oracle/engine.json`; see `test-support/oracle-vectors.js`.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { available, probe, unavailableReason } from "../test-support/engine-probe.js";
import { testEnv } from "../test-support/git-environment.js";
import {
  FAILURE_HOOKS,
  buildRepositories,
  catalogCalls,
  catalogRequests,
  failureRequest,
  git,
  mergeTreeRequests,
  normalize,
  overrides,
} from "../test-support/engine-corpus.js";
import { assertFrozenHashes, caseHash, loadVectors } from "../test-support/oracle-vectors.js";
import { MERGE_TREE_ENGINE_MIN_GIT } from "../test-support/merge-tree-floor.js";

const skip = available ? false : unavailableReason;
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const frozen = loadVectors("engine");

Object.assign(process.env, testEnv(overrides));
delete process.env.GIT_CONFIG_COUNT;
const probeEnv = () => {
  const env = { ...process.env };
  delete env.GIT_CONFIG_COUNT;
  return env;
};

const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "vlab-rust-engine-")));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

/** This repository, cloned with its notes: real history at real scale. */
function realClone() {
  const cwd = path.join(scratch, "clone");
  git(scratch, "clone", "-q", "--no-hardlinks", repository, cwd);
  spawnSync("git", ["fetch", "-q", "origin", "refs/notes/*:refs/notes/*"], { cwd, env: testEnv(overrides) });
  const head = git(cwd, "rev-parse", "HEAD");
  const root = git(cwd, "rev-list", "--max-parents=0", "HEAD").split("\n")[0];
  // CI checks out one commit, so the clone may be shallow: take the oldest of
  // the few commits there are.
  const feature = git(cwd, "rev-list", "--max-count=4", "HEAD").split("\n").at(-1);
  return { cwd, root, head, feature };
}

// Built once; a failure is kept, so every test reports it rather than
// tripping over the directories the first attempt left.
let fixtures = null;
function repositories() {
  if (!fixtures) {
    try {
      fixtures = { value: buildRepositories(scratch) };
    } catch (error) {
      fixtures = { error };
    }
  }
  if (fixtures.error) throw fixtures.error;
  return fixtures.value;
}

/** Each probe reply against its frozen answers, request by request. */
function compareFrozen(requests, answers, group) {
  assert.equal(requests.length, answers.length, `${group}: the request list changed`);
  const replies = probe(requests, probeEnv());
  for (const [index, request] of requests.entries()) {
    const label = request.differential ? `${group} differential ${request.differential}` : `${group} ${request.cwd}`;
    if (request.differential) {
      compareDifferential(replies[index], answers[index].differential, label);
      continue;
    }
    const results = replies[index].results ?? [];
    assert.equal(results.length, request.calls.length, `${label}: one reply per call`);
    const where = (position) => {
      const { op, args } = request.calls[position];
      return `${label} ${request.engine ?? "git"}${request.session ? " session" : ""}: ${op} ${JSON.stringify(args ?? [])}`;
    };
    assertFrozenHashes(answers[index],
      results.map((result, position) => normalize(result, scratch, request.calls[position].op)), where, label);
  }
  return replies;
}

/**
 * The Git column of the differential as the oracle's, and the Rust one
 * agreeing with itself. Each column's digest covers values that carry the
 * scratch directory, so it is left out; the catalog requests hold the values
 * themselves.
 */
function compareDifferential(actual, expected, label) {
  assert.equal(actual.schema, "causet.engine-differential/v1", label);
  assert.equal(actual.equal, true, `${label}: ${JSON.stringify(actual.operations.filter((item) => item.status === "different"))}`);
  assert.deepEqual(actual.operations.map((item) => item.operation), frozen.readOperations, label);
  for (const [index, operation] of actual.operations.entries()) {
    const reference = expected[index];
    assert.equal(operation.status === "skipped", reference.skipped, `${label} ${operation.operation}`);
    if (reference.skipped) {
      assert.equal(operation.reason, reference.reason, `${label} ${operation.operation}`);
      continue;
    }
    assert.equal(caseHash(normalize({ ...operation.results.git, digest: undefined }, scratch)), reference.git,
      `${label} ${operation.operation}: ${JSON.stringify(operation.results.git)}`);
  }
}

test("every catalog operation answers as the JavaScript engine did, value and processes", { skip }, () => {
  const requests = catalogRequests(repositories(), scratch);
  const replies = compareFrozen(requests, frozen.catalog, "catalog");
  const bypass = replies.at(-1).results[0];
  assert.equal(bypass.error.code, "internal-invariant");
  assert.match(bypass.error.message, /read outside the engine seam/);
  assert.equal(bypass.metrics.directReads, 1);
});

test("on real history the engines agree with each other, with and without a session", { skip }, () => {
  // This repository's own history changes with every commit, so its answers
  // cannot be frozen: the Rust engine is held to itself instead.
  const clone = realClone();
  const calls = catalogCalls(clone, scratch).filter(({ op }) => op !== "remoteRefs");
  const [differential, withSession, without] = probe([
    { differential: clone.cwd },
    { cwd: clone.cwd, engine: "git", warm: true, session: true, calls },
    { cwd: clone.cwd, engine: "git", warm: true, calls },
  ], probeEnv());
  assert.equal(differential.equal, true,
    JSON.stringify(differential.operations.filter((item) => item.status === "different")));
  // A session reports a failure without Git's own stderr, so errors agree on
  // their code and message.
  const answer = ({ value, error }) => (error ? { code: error.code, message: error.message } : { value });
  for (const [index, { op }] of calls.entries()) {
    assert.deepEqual(answer(withSession.results[index]), answer(without.results[index]),
      `${op} with and without a session`);
  }
});

test("every native operation answers natively on a supported repository", { skip }, () => {
  const { history } = repositories();
  const calls = catalogCalls(history, scratch);
  const [reply] = probe([{ cwd: history.cwd, engine: "native", warm: true, calls }], probeEnv());
  const answered = new Set();
  for (const [index, result] of reply.results.entries()) {
    for (const operation of Object.keys(result.metrics.nativeReads)) answered.add(operation);
    if (Object.keys(result.metrics.nativeReads).length) {
      assert.equal(result.metrics.processes, 0, `${calls[index].op} launched Git`);
    }
  }
  assert.deepEqual([...answered].sort(), frozen.nativeOperations);
});

const gitVersion = /(\d+)\.(\d+)/.exec(spawnSync("git", ["--version"], { encoding: "utf8" }).stdout ?? "") ?? [];
const [floorMajor, floorMinor] = MERGE_TREE_ENGINE_MIN_GIT.split(".").map(Number);
const mergeTreeSkip = skip || (Number(gitVersion[1]) > floorMajor
  || (Number(gitVersion[1]) === floorMajor && Number(gitVersion[2]) >= floorMinor)
  ? false
  : `the frozen merge-tree answers were recorded with Git ${MERGE_TREE_ENGINE_MIN_GIT} or newer`);

test("the merge-tree session answers clean and conflicted steps as the JavaScript session did", { skip: mergeTreeSkip }, () => {
  compareFrozen(mergeTreeRequests(repositories()), frozen.mergeTree, "merge-tree");
});

test("session failures fall back to ordinary processes as the JavaScript session did", { skip: mergeTreeSkip }, (t) => {
  const repositoriesBuilt = repositories();
  assert.equal(FAILURE_HOOKS.length, frozen.failures.length, "the failure hooks changed");
  for (const [index, [name, value]] of FAILURE_HOOKS.entries()) {
    process.env[name] = value;
    t.after(() => delete process.env[name]);
    compareFrozen([failureRequest(repositoriesBuilt)], [frozen.failures[index]], `${name}=${value}`);
    delete process.env[name];
  }
});
