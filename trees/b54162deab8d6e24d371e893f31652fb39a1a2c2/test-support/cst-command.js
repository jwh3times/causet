/**
 * The `cst` executable the suites, demos, and measurement scripts drive.
 *
 * By default this is the checkout's Rust build, `native/target/release/cst`
 * (#243), which `npm run build:native` produces; without it, the first
 * invocation fails and says so, while suites that never run the CLI still
 * load this module. `CAUSET_CLI=<path>` selects another
 * implementation (ADR-0037, issue #140): a `.js` or `.mjs` path runs under
 * this Node; any other path is executed directly.
 *
 * This module has no `node:test` dependency, so scripts can import it. The
 * per-test report of tests that never invoke the selected CLI lives in
 * `git-environment.js`, which every suite file imports.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The release build `npm run build:native` writes. */
export const builtCli = fileURLToPath(new URL(
  `../native/target/release/${process.platform === "win32" ? "cst.exe" : "cst"}`, import.meta.url));

const named = process.env.CAUSET_CLI;

/** The absolute path `CAUSET_CLI` names, or null when the default CLI is used. */
export const selectedCli = named ? path.resolve(named) : null;
if (selectedCli && !fs.existsSync(selectedCli)) {
  throw new Error(`CAUSET_CLI names ${selectedCli}, which does not exist`);
}

const target = selectedCli ?? builtCli;
const runsUnderNode = /\.(?:c|m)?js$/.test(target);

/** The program to spawn for a `cst` invocation. */
export const cstCommand = runsUnderNode ? process.execPath : target;

let invocations = 0;

/**
 * The arguments that precede a `cst` invocation's own arguments. Call it
 * once per invocation, as `spawnSync(cstCommand, [...cstPrefix(), ...args])`;
 * the call is how the suites count which tests exercised the CLI under test.
 */
export function cstPrefix() {
  if (!selectedCli && !fs.existsSync(builtCli)) {
    throw new Error(`no Rust CLI build at ${builtCli}; run npm run build:native, or name a CLI with CAUSET_CLI`);
  }
  invocations += 1;
  return runsUnderNode ? [target] : [];
}

/** CLI invocations since the last reset (see `git-environment.js`). */
export function cliInvocations() {
  return invocations;
}

export function resetCliInvocations() {
  invocations = 0;
}
