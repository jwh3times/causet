/**
 * The environment variable window (ADR-0039 §5, issue #159): every user-facing
 * `VLAB_X` is read as a fallback for `CAUSET_X`, the new name wins when both
 * are present, and `cst doctor` reports the legacy variables in use instead of
 * printing anything on stderr.
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import {
  ENVIRONMENT_VARIABLES,
  environmentValue,
  legacyVariablesInUse,
  setEnvironmentValue,
} from "../src/environment.js";
import { testEnv } from "../test-support/git-environment.js";
import { vlabCommand, vlabPrefix } from "../test-support/vlab-command.js";

const repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "vcs-lab-environment-")));
after(() => fs.rmSync(repo, { recursive: true, force: true }));
execFileSync("git", ["init", "-q", repo], { env: testEnv() });

// Unset every selector the suite's mode may carry, under both names, so each
// case states exactly what it sets. `undefined` removes a variable from a spawn.
const clean = Object.fromEntries(ENVIRONMENT_VARIABLES.flatMap((name) =>
  [[`CAUSET_${name}`, undefined], [`VLAB_${name}`, undefined]]));

function cst(args, env) {
  return spawnSync(vlabCommand, [...vlabPrefix(), ...args], {
    cwd: repo, encoding: "utf8", env: testEnv({ ...clean, ...env }),
  });
}

test("the new name wins, even empty, and the old name is the fallback", () => {
  assert.equal(environmentValue("ENGINE", {}), undefined);
  assert.equal(environmentValue("ENGINE", { VLAB_ENGINE: "native" }), "native");
  assert.equal(environmentValue("ENGINE", { CAUSET_ENGINE: "git", VLAB_ENGINE: "native" }), "git");
  assert.equal(environmentValue("ENGINE", { CAUSET_ENGINE: "", VLAB_ENGINE: "native" }), "");
  const env = { VLAB_TRACE: "0" };
  setEnvironmentValue("TRACE", "1", env);
  assert.deepEqual(env, { VLAB_TRACE: "0", CAUSET_TRACE: "1" });
  assert.throws(() => environmentValue("ENGINES", {}), /not a published causet environment variable/);
});

test("only legacy variables that are actually read are reported", () => {
  assert.deepEqual(legacyVariablesInUse({ VLAB_AGENT: "a", VLAB_ENGINE: "git", CAUSET_ENGINE: "native" }),
    ["VLAB_AGENT"]);
  assert.deepEqual(legacyVariablesInUse({ CAUSET_TRACE: "1" }), []);
});

test("a legacy selector still selects, and is still validated", () => {
  const legacy = cst(["version"], { VLAB_ENGINE: "bogus" });
  assert.equal(legacy.status, 1);
  assert.equal(legacy.stderr, "cst: Unknown engine 'bogus'. Use one of: git, native.\n");
  assert.equal(cst(["version"], { VLAB_ENGINE: "bogus", CAUSET_ENGINE: "git" }).status, 0);
  const traced = cst(["doctor"], { VLAB_TRACE: "1" });
  assert.equal(traced.status, 0);
  assert.match(traced.stderr, /^\[cst trace\] /m);
});

test("doctor lists the legacy variables in use and prints nothing on stderr for them", () => {
  const result = cst(["doctor"], { VLAB_AGENT: "agent-1", VLAB_ENGINE: "git", CAUSET_ENGINE: "git" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout).legacyEnvironment, ["VLAB_AGENT"]);
  const current = cst(["doctor"], { CAUSET_AGENT: "agent-1" });
  assert.deepEqual(JSON.parse(current.stdout).legacyEnvironment, []);
});
