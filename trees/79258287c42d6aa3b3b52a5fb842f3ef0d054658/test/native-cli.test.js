/**
 * The Rust CLI's answers against the JavaScript oracle's (ADR-0037, #141).
 *
 * The Rust `cst` answers every command itself (#212) and no longer delegates
 * to the JavaScript CLI (#243). Until #243 this suite ran each invocation
 * through both CLIs and required byte-identical stdout, stderr and exit
 * status, apart from what ADR-0037 §5 names. Outside any repository, the
 * JavaScript CLI's results are frozen in `test/fixtures/oracle/native-cli.json`
 * (`test-support/cli-corpus.js` lists the cases); see
 * `test-support/oracle-vectors.js`. The comparisons inside repositories,
 * including that either CLI could finish a journal or consume a forecast the
 * other wrote, ended with the oracle; the integration, conformance and schema
 * suites hold the Rust CLI to the same behavior in every mode.
 *
 * The Rust CLI is `CAUSET_CLI` when that names an executable, else the
 * workspace's release build. Without one, the suite is skipped;
 * `node scripts/build-native.mjs` builds it.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { testEnv } from "../test-support/git-environment.js";
import { selectedCli, cstPrefix } from "../test-support/cst-command.js";
import { cliGroups, frozenForm } from "../test-support/cli-corpus.js";
import { assertFrozenHashes, loadVectors } from "../test-support/oracle-vectors.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const built = path.join(projectRoot, "native/target/release",
  process.platform === "win32" ? "cst.exe" : "cst");
const rust = selectedCli && !/\.(?:c|m)?js$/.test(selectedCli)
  ? selectedCli
  : fs.existsSync(built) ? built : null;
const skip = rust ? false : "no Rust CLI build; run node scripts/build-native.mjs";
const { version } = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));
const frozen = loadVectors("native-cli");

// Outside any repository, so a command cannot touch one.
const outside = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "vcs-lab-native-cli-")));
after(() => fs.rmSync(outside, { recursive: true, force: true }));

// The suite's mode variables would otherwise decide these cases.
const neutral = { CAUSET_ENGINE: "", CAUSET_FORECAST_ENGINE: "" };

function runRust(args, env = {}, cwd = outside) {
  // Counts the invocation when the Rust CLI is the one under test (#140).
  if (rust === selectedCli) cstPrefix();
  return spawnSync(rust, args, {
    cwd, encoding: "utf8", env: testEnv({ ...neutral, ...env }),
  });
}

const groups = cliGroups(outside);

test("the frozen groups cover every case the corpus lists", () => {
  assert.deepEqual(Object.keys(groups).sort(), Object.keys(frozen.groups).sort());
});

for (const [group, title] of [
  ["help", "help and version are answered as the JavaScript CLI answered them"],
  ["globalFailures", "global flag and environment failures are answered as prose, as the JavaScript CLI answered them"],
  ["valueFlags", "a flag without its value is answered as prose even with --json"],
  ["usage", "every argument-only usage failure is answered as the JavaScript CLI answered it, human and JSON"],
  ["accident", "the input the JavaScript parser failed on by accident fails the same way"],
  ["outsideRepository", "doctor and the record readers refuse outside a repository as the JavaScript CLI did"],
  ["capabilities", "the build-scoped capability document is the JavaScript CLI's"],
  ["benchmarks", "the benchmarks report the JavaScript CLI's counts, timings and the named estimates aside (#212)"],
]) {
  test(title, { skip }, () => {
    const cases = groups[group];
    const results = cases.map(({ args, env }) => frozenForm(runRust(args, env), { group, outside, version }));
    assertFrozenHashes(frozen.groups[group], results,
      (index) => `${JSON.stringify(cases[index].args)} ${JSON.stringify(cases[index].env)}`, group);
  });
}

test("every usage failure fails, and the camel-case accident is prose even with --json", { skip }, () => {
  for (const { args } of groups.usage.filter(({ args }) => !args.includes("--json"))) {
    assert.notEqual(runRust(args).status, 0, JSON.stringify(args));
  }
  for (const { args } of groups.accident) {
    const result = runRust(args);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "cst: (options[key] ?? []) is not iterable\n");
  }
});

test("the runtime describes itself as the Rust CLI (ADR-0037 §5)", { skip }, () => {
  const repo = path.join(outside, "doctor-repo");
  fs.mkdirSync(repo);
  const git = (...args) => spawnSync("git", args, { cwd: repo, encoding: "utf8", env: testEnv() });
  git("init", "-q", "-b", "main");
  git("-c", "user.name=Doctor", "-c", "user.email=doctor@example.invalid", "commit", "-q", "--allow-empty", "-m", "base");
  for (const args of [["doctor"], ["doctor", "--differential"], ["--engine", "native", "doctor"]]) {
    const result = runRust(args, {}, repo);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.implementation, "rust", JSON.stringify(args));
    assert.equal(report.node, null, JSON.stringify(args));
  }
  const small = ["--history", "6", "--workspaces", "2", "--notes", "8", "--resolutions", "3", "--samples", "2",
    "--areas", "2", "--files-per-area", "3"];
  const described = JSON.parse(runRust(["metadata", "benchmark", ...small, "--json"]).stdout).environment;
  assert.equal(described.implementation, "rust");
  assert.equal(described.node, null);
});

test("the former delegation variables no longer reach the JavaScript CLI", { skip }, () => {
  // A delegated answer would need CAUSET_JS_CLI, which names a missing file,
  // and an unknown CAUSET_DELEGATE mode was refused; both are ignored now.
  const missing = path.join(outside, "missing.js");
  for (const mode of ["always", "never", "sometimes"]) {
    const result = runRust(["--version"], { CAUSET_DELEGATE: mode, CAUSET_JS_CLI: missing });
    assert.equal(result.status, 0, mode);
    assert.equal(result.stderr, "", mode);
    assert.match(result.stdout, /^causet \d/, mode);
  }
});
