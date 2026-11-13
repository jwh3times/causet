/**
 * The `vlab` executable the suites, demos, and measurement scripts drive.
 *
 * By default this is the checkout's JavaScript CLI, run under the current
 * Node. `VLAB_CLI=<path>` selects another implementation, such as a Rust
 * build of the CLI (ADR-0037, issue #140): a `.js` or `.mjs` path runs under
 * this Node; any other path is executed directly.
 *
 * This module has no `node:test` dependency, so scripts can import it. The
 * per-test report of tests that never invoke the selected CLI lives in
 * `git-environment.js`, which every suite file imports.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const defaultCli = fileURLToPath(new URL("../bin/vlab.js", import.meta.url));

/** The absolute path `VLAB_CLI` names, or null when the default CLI is used. */
export const selectedCli = process.env.VLAB_CLI ? path.resolve(process.env.VLAB_CLI) : null;
if (selectedCli && !fs.existsSync(selectedCli)) {
  throw new Error(`VLAB_CLI names ${selectedCli}, which does not exist`);
}

const target = selectedCli ?? defaultCli;
const runsUnderNode = /\.(?:c|m)?js$/.test(target);

/** The program to spawn for a `vlab` invocation. */
export const vlabCommand = runsUnderNode ? process.execPath : target;

let invocations = 0;

/**
 * The arguments that precede a `vlab` invocation's own arguments. Call it
 * once per invocation, as `spawnSync(vlabCommand, [...vlabPrefix(), ...args])`;
 * the call is how the suites count which tests exercised the CLI under test.
 */
export function vlabPrefix() {
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
