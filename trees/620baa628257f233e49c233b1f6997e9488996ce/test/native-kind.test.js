/**
 * The native-kind suite mode itself (#307, `test-support/native-kind.js`):
 * a suite run with `CAUSET_KIND=native` imports each repository a test
 * leaves and fails the test when N1's commands on the copy answer otherwise
 * than Git on the original, or when import refuses a repository the mode
 * does not list. Each case runs a small suite in a child `node --test`.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { testEnv } from "../test-support/git-environment.js";
import { builtCli, selectedCli } from "../test-support/cst-command.js";

const created = [];

after(() => {
  for (const directory of created) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function scratch() {
  const parent = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "causet-native-kind-")));
  created.push(parent);
  return parent;
}

const environment = new URL("../test-support/git-environment.js", import.meta.url).href;

/** Runs `body`, the tests of a suite, in a child `node --test`. */
function child(body, env = {}) {
  const root = scratch();
  const suite = path.join(root, "kind.test.mjs");
  fs.writeFileSync(suite, `
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { testEnv } from ${JSON.stringify(environment)};

const git = (cwd, ...args) => execFileSync("git", args, { cwd, env: testEnv({
  GIT_AUTHOR_NAME: "A", GIT_AUTHOR_EMAIL: "a@e", GIT_COMMITTER_NAME: "C", GIT_COMMITTER_EMAIL: "c@e",
}) });
const commit = (repo, text) => {
  fs.writeFileSync(path.join(repo, "file.txt"), text);
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", text);
};
${body}`);
  // The child is a run of its own, not one of this runner's subtests.
  const childEnv = testEnv({ CAUSET_KIND: "native", ...env });
  delete childEnv.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, ["--test", suite], { cwd: root, env: childEnv, encoding: "utf8" });
}

/**
 * A suite whose one test makes a repository in `os.tmpdir()` with `shape`
 * (`plain` or `shallow`).
 */
function runSuite(shape, env = {}) {
  return child(`
test("a test that leaves a repository", (t) => {
  // Removed when the test ends, after the mode has checked it.
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "kind-"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const repo = path.join(parent, "repo");
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  commit(repo, "version 1\\n");
  commit(repo, "version 2\\n");
  git(repo, "tag", "-a", "-m", "a tag", "v1");
  if (${JSON.stringify(shape)} === "shallow") {
    git(parent, "clone", "-q", "--depth", "1", pathToFileURL(repo).href, "shallow");
  }
});
`, env);
}

/** A CLI that is the real one except that it adds a byte to every blob `cat-file -p` prints. */
function alteredCli() {
  const wrapper = path.join(scratch(), "altered-cst.mjs");
  const real = JSON.stringify(selectedCli ?? builtCli);
  fs.writeFileSync(wrapper, `
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
const real = spawnSync(${real}, args, { encoding: "buffer" });
let out = real.stdout;
if (args[0] === "cat-file" && args[1] === "-p"
  && spawnSync(${real}, ["cat-file", "-t", args[2]], { encoding: "utf8" }).stdout === "blob\\n") {
  out = Buffer.concat([out, Buffer.from("!")]);
}
process.stdout.write(out);
process.stderr.write(real.stderr);
process.exitCode = real.status;
`);
  return wrapper;
}

test("a repository a test leaves is imported, and N1's commands on the copy answer as Git does", () => {
  const run = runSuite("plain");
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /pass 1/);
});

test("a native copy that answers otherwise than Git fails the test that left the repository", () => {
  const run = runSuite("plain", { CAUSET_CLI: alteredCli() });
  assert.notEqual(run.status, 0, run.stdout);
  assert.match(run.stdout, /the native copy answers differently from Git/);
  assert.match(run.stdout, /git cat-file -p [0-9a-f]{40}: git answers "version 2\\n", cst "version 2\\n!"/);
});

test("a repository import refuses fails its test unless the mode lists the refusal with its reason", () => {
  const run = runSuite("shallow");
  assert.notEqual(run.status, 0, run.stdout);
  assert.match(run.stdout, /import refused, and REFUSALS does not list it: cst: .* is a shallow clone/);
});

test("outside the mode nothing is imported, so the same refusal fails nothing", () => {
  const run = runSuite("shallow", { CAUSET_KIND: "" });
  assert.equal(run.status, 0, run.stdout + run.stderr);
});

test("a repository a later test changes is compared as it was left, through subtests and outside any test", () => {
  // Both repositories are still empty when a test first looks at them: one
  // made outside any test, one made by a test after its subtest. Only the
  // next test commits to them.
  const run = child(`
const outside = fs.mkdtempSync(path.join(os.tmpdir(), "outside-"));
git(outside, "init", "-q", "-b", "main");
const ready = fs.mkdtempSync(path.join(os.tmpdir(), "ready-"));
git(ready, "init", "-q", "-b", "main");
commit(ready, "ready before any test\\n");
let fixture;

test("a test with a subtest, which then makes a fixture", async (t) => {
  await t.test("the subtest", () => {});
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), "fixture-"));
  git(fixture, "init", "-q", "-b", "main");
});

test("a later test commits to both", () => {
  commit(outside, "made outside any test\\n");
  commit(fixture, "made by an earlier test\\n");
});
`, { CAUSET_CLI: alteredCli() });
  assert.notEqual(run.status, 0, run.stdout);
  for (const text of ["made outside any test", "made by an earlier test"]) {
    assert.ok(run.stdout.includes(`git answers "${text}\\n", cst "${text}\\n!"`), `${text}: ${run.stdout}`);
  }
  // A test's subtest does not leave the test looking at the suite's own
  // directory: what was made outside any test is reported as such.
  assert.match(run.stdout, /kind\.test\.mjs › \(outside any test\) › [^\n]*ready-[^\n]*: git answers "ready before any test\\n"/);
});
