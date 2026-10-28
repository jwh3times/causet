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
import { testEnv } from "../test-support/git-environment.js";
import { cstCommand, cstPrefix } from "../test-support/cst-command.js";

const repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "vcs-lab-environment-")));
after(() => fs.rmSync(repo, { recursive: true, force: true }));
execFileSync("git", ["init", "-q", repo], { env: testEnv() });

// The published variables, as the Rust engine lists them.
const listing = fs.readFileSync(new URL("../native/engine/src/environment.rs", import.meta.url), "utf8");
const ENVIRONMENT_VARIABLES = [.../ENVIRONMENT_VARIABLES: \[&str; \d+\] = \[([^\]]*)\]/.exec(listing)[1]
  .matchAll(/"([A-Z_]+)"/g)].map((match) => match[1]);
assert.ok(ENVIRONMENT_VARIABLES.includes("ENGINE"), "the variable listing was read");

// Unset every selector the suite's mode may carry, under both names, so each
// case states exactly what it sets. `undefined` removes a variable from a spawn.
const clean = Object.fromEntries(ENVIRONMENT_VARIABLES.flatMap((name) =>
  [[`CAUSET_${name}`, undefined], [`VLAB_${name}`, undefined]]));

function cst(args, env) {
  return spawnSync(cstCommand, [...cstPrefix(), ...args], {
    cwd: repo, encoding: "utf8", env: testEnv({ ...clean, ...env }),
  });
}

test("only the CAUSET_ name is read, even when empty", () => {
  // An empty CAUSET_ENGINE selects the default engine; the former name is not
  // consulted in its place, so its invalid value goes unread.
  for (const env of [{ CAUSET_ENGINE: "", VLAB_ENGINE: "bogus" }, { CAUSET_ENGINE: "git", VLAB_ENGINE: "bogus" }]) {
    const result = cst(["version"], env);
    assert.equal(result.status, 0, `${JSON.stringify(env)}: ${result.stderr}`);
  }
  const traced = cst(["doctor"], { CAUSET_TRACE: "1", VLAB_TRACE: "0" });
  assert.match(traced.stderr, /^\[cst trace\] /m);
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
