/**
 * The environment variables after the migration window (ADR-0039 §5, §8; issues
 * #159 and #170): every user-facing variable is `CAUSET_X`, and the former
 * `VLAB_X` is ignored, not read as a fallback and not reported.
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { ENVIRONMENT_VARIABLES, environmentValue, setEnvironmentValue } from "../src/environment.js";
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

test("only the CAUSET_ name is read, even when empty", () => {
  assert.equal(environmentValue("ENGINE", {}), undefined);
  assert.equal(environmentValue("ENGINE", { VLAB_ENGINE: "native" }), undefined);
  assert.equal(environmentValue("ENGINE", { CAUSET_ENGINE: "git", VLAB_ENGINE: "native" }), "git");
  assert.equal(environmentValue("ENGINE", { CAUSET_ENGINE: "", VLAB_ENGINE: "native" }), "");
  const env = { VLAB_TRACE: "0" };
  setEnvironmentValue("TRACE", "1", env);
  assert.deepEqual(env, { VLAB_TRACE: "0", CAUSET_TRACE: "1" });
  assert.throws(() => environmentValue("ENGINES", {}), /not a published causet environment variable/);
});

test("a former selector no longer selects, and is no longer validated", () => {
  assert.equal(cst(["version"], { VLAB_ENGINE: "bogus" }).status, 0);
  const current = cst(["version"], { CAUSET_ENGINE: "bogus" });
  assert.equal(current.status, 1);
  assert.equal(current.stderr, "cst: Unknown engine 'bogus'. Use one of: git, native.\n");
  const untraced = cst(["doctor"], { VLAB_TRACE: "1" });
  assert.equal(untraced.status, 0);
  assert.equal(untraced.stderr, "");
  assert.match(cst(["doctor"], { CAUSET_TRACE: "1" }).stderr, /^\[cst trace\] /m);
});

test("doctor no longer reports former variables", () => {
  const result = cst(["doctor"], { VLAB_AGENT: "agent-1", VLAB_ENGINE: "git" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(Object.hasOwn(JSON.parse(result.stdout), "legacyEnvironment"), false);
});
