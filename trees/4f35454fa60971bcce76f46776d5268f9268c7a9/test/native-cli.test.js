/**
 * The Rust CLI's native answers against the JavaScript oracle (ADR-0037, #141).
 *
 * While the port is under way the Rust `cst` answers help, version, and every
 * usage failure that `src/cli.js` raises from the arguments alone, and
 * delegates everything else to the JavaScript CLI. This suite runs each such
 * invocation through both, with the Rust CLI forbidden to delegate
 * (`VLAB_DELEGATE=never`), and requires byte-identical stdout, stderr and exit
 * status. It then checks the delegation path itself.
 *
 * This is the one suite that launches the JavaScript CLI directly rather than
 * through `test-support/vlab-command.js`: the JavaScript CLI is the oracle here,
 * whichever implementation `VLAB_CLI` selects. The Rust CLI is `VLAB_CLI` when
 * that names an executable, else the workspace's release build. Without one,
 * the suite is skipped; `node scripts/build-native.mjs` builds it.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { testEnv } from "../test-support/git-environment.js";
import { selectedCli, vlabPrefix } from "../test-support/vlab-command.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const oracle = path.join(projectRoot, "bin/vlab.js");
const built = path.join(projectRoot, "native/target/release",
  process.platform === "win32" ? "cst.exe" : "cst");
const rust = selectedCli && !/\.(?:c|m)?js$/.test(selectedCli)
  ? selectedCli
  : fs.existsSync(built) ? built : null;
const skip = rust ? false : "no Rust CLI build; run node scripts/build-native.mjs";

// Outside any repository, so a delegated command cannot touch one.
const outside = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "vcs-lab-native-cli-")));
after(() => fs.rmSync(outside, { recursive: true, force: true }));

// The suite's mode variables would otherwise decide these cases for both sides.
const neutral = { VLAB_ENGINE: "", VLAB_FORECAST_ENGINE: "", VLAB_DELEGATE: "" };

function runOracle(args, env = {}) {
  return spawnSync(process.execPath, [oracle, ...args], {
    cwd: outside, encoding: "utf8", env: testEnv({ ...neutral, ...env }),
  });
}

function runRust(args, env = {}) {
  // Counts the invocation when the Rust CLI is the one under test (#140).
  if (rust === selectedCli) vlabPrefix();
  return spawnSync(rust, args, {
    cwd: outside, encoding: "utf8", env: testEnv({ ...neutral, ...env }),
  });
}

// Trace timings are the one volatile part of a delegated command's output.
const withoutTimings = (text) => text.replace(/^(\[vlab trace\]) [\d.]+ms /gm, "$1 <ms> ");

function assertSame(args, env = {}, rustEnv = { VLAB_DELEGATE: "never" }) {
  const expected = runOracle(args, env);
  const actual = runRust(args, { ...env, ...rustEnv });
  const label = `${JSON.stringify(args)} ${JSON.stringify(env)}`;
  assert.equal(actual.error, undefined, label);
  assert.equal(actual.stdout, expected.stdout, `stdout of ${label}`);
  assert.equal(withoutTimings(actual.stderr), withoutTimings(expected.stderr), `stderr of ${label}`);
  assert.equal(actual.status, expected.status, `status of ${label}`);
  return expected;
}

const valueFlags = [
  "--message", "-m", "--from", "--path", "--owner", "--focus", "--cone", "--against",
  "--anchors-from", "--label", "--reason", "--resolution", "--use-forecast", "--samples",
  "--warmup", "--documents", "--blocks", "--history", "--workspaces", "--notes",
  "--resolutions", "--budget-ms", "--areas", "--files-per-area",
  "--authored-by", "--generated-by", "--reviewed-by", "--reword", "--edit", "--squash", "--fixup",
];

// Each command's argument-only refusals, in the order src/cli.js checks them.
const usageFailures = [
  ["commit"], ["commit", "-m", ""], ["commit", "--all"],
  ["branch"], ["branch", ""],
  ["merge"], ["merge", "--compact"], ["compact-merge"], ["hard-squash", "-m", "x"],
  ["proof-bundle"], ["verify-proof", "--offline"], ["merge-plan"],
  ["rebase-plan"], ["rebase-plan", "a", "b", "c"], ["rebase-plan", "", "b", "c"],
  ["rebase-forecast"], ["rebase-forecast", "a", "b", "c"],
  ["rebase"], ["rebase", "a", "b"], ["rebase", "--status", "--continue"],
  ["rebase", "--continue", "--abort", "--status", "x"],
  ["forecast"], ["reconcile"], ["reconcile", "--status", "--abort"],
  ["resolve", "bogus"], ["resolve", ""],
  ["cherry-pick"], ["cherry-pick", "--fork"],
  ["audit"], ["audit", "bogus"],
  ["metadata"], ["metadata", "bogus"], ["metadata", "export"], ["metadata", "import", "--apply"],
  ["metadata", "dispose"], ["metadata", "dispose", "r"],
  ["metadata", "dispose", "r", "--keep-local", "--replace-local"],
  ["workspace"], ["workspace", "bogus"], ["workspace", "create"], ["workspace", "move"],
  ["workspace", "move", "n"], ["workspace", "archive"], ["workspace", "restore"],
  ["workspace", "repair"], ["workspace", "repair", "n"], ["workspace", "repair", "n", "--path", ""],
  ["workspace", "forecast"], ["workspace", "forecast", "t"],
  ["spec"], ["spec", "bogus"], ["spec", "index"], ["spec", "show"],
  ["spec", "merge-plan", "f", "b", "o"],
  ["no-such-command"], ["--json"], ["x", "-m", "--json"],
  ["unknown \"quoted\" \\ — command"], ["UPPER"], ["Commit"],
];

test("help and version are answered natively, byte for byte", { skip }, () => {
  for (const args of [
    [], [""], ["help"], ["--help"], ["-h"], ["help", "extra"], ["--trace-git"],
    ["--engine=native", "help"], ["--git-session", "--help"],
    ["version"], ["--version"], ["-V"], ["--no-git-session", "version", "--json"],
    ["--forecast-engine", "worktree", "-V"],
  ]) {
    assertSame(args);
  }
});

test("global flag and environment failures are answered natively as prose", { skip }, () => {
  for (const args of [
    ["--git-session", "--no-git-session"], ["--git-session", "commit", "--no-git-session", "--json"],
    ["--engine"], ["--engine="], ["--engine", "bogus", "commit", "--json"],
    ["--engine", "--trace-git"], ["--forecast-engine=x"], ["--forecast-engine"],
    ["commit", "-m", "--git-session", "--no-git-session"],
  ]) {
    assertSame(args);
  }
  assertSame(["version"], { VLAB_ENGINE: "bogus" });
  assertSame(["help"], { VLAB_FORECAST_ENGINE: "bogus", VLAB_ENGINE: "bogus" });
  assertSame(["--engine=git", "version"], { VLAB_ENGINE: "bogus" });
  assertSame(["--forecast-engine=merge-tree", "x"], { VLAB_FORECAST_ENGINE: "bogus" });
});

test("a flag without its value is answered natively, as prose even with --json", { skip }, () => {
  for (const flag of valueFlags) {
    assertSame(["commit", "--json", flag]);
  }
  assertSame(["no-such-command", "-m"]);
});

test("every argument-only usage failure is answered natively, human and JSON", { skip }, () => {
  for (const args of usageFailures) {
    const human = assertSame(args);
    assert.notEqual(human.status, 0, JSON.stringify(args));
    assertSame([...args, "--json"]);
  }
});

test("a repository command is delegated with its output and exit status intact", { skip }, () => {
  // Outside a repository these succeed or fail exactly as the JavaScript CLI
  // does, which is all a delegation has to show: it ran with these arguments here.
  for (const args of [["receipts", "--json"], ["cherry-pick", "x"], ["resolve"], ["--trace-git", "provenance"]]) {
    assertSame(args, {}, {});
  }
  // Git's own exit status, passed through the JavaScript CLI and then this one.
  assert.equal(assertSame(["doctor"], {}, {}).status, 128);
});

test("VLAB_DELEGATE=always sends even native answers to the JavaScript CLI", { skip }, () => {
  // VLAB_JS_CLI naming a missing file proves the route: a native answer would
  // not look for it.
  const missing = path.join(outside, "missing.js");
  const forced = runRust(["--version"], { VLAB_DELEGATE: "always", VLAB_JS_CLI: missing });
  assert.notEqual(forced.status, 0);
  assert.equal(forced.stdout, "");
  const native = runRust(["--version"], { VLAB_JS_CLI: missing });
  assert.equal(native.status, 0);
  assertSame(["--version"], {}, { VLAB_DELEGATE: "always" });
  assertSame(["no-such-command", "--json"], {}, { VLAB_DELEGATE: "always" });
});

test("VLAB_DELEGATE=never refuses a command that is not ported", { skip }, () => {
  const result = runRust(["doctor"], { VLAB_DELEGATE: "never" });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^cst: 'doctor' is not ported to the Rust CLI yet/);
  const invalid = runRust(["--version"], { VLAB_DELEGATE: "sometimes" });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /^cst: Unknown delegation mode 'sometimes'/);
});
