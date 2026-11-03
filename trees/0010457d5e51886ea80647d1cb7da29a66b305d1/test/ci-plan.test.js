import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { changedPaths, planCi } from "../scripts/ci-plan.mjs";
import { testEnv } from "../test-support/git-environment.js";

const planner = fileURLToPath(new URL("../scripts/ci-plan.mjs", import.meta.url));

test("routine code changes use two PR suites and one main suite", () => {
  assert.deepEqual(planCi("pull_request", ["src/git.js"]).include, [
    { os: "ubuntu-latest", node: 24, mode: "default" },
    { os: "windows-latest", node: 24, mode: "default" },
  ]);
  assert.deepEqual(planCi("push", ["src/git.js"]).include, [
    { os: "ubuntu-latest", node: 24, mode: "default" },
  ]);
});

test("only known documentation paths omit automatic suites", () => {
  for (const event of ["push", "pull_request"]) {
    assert.equal(planCi(event, ["README.md", "AGENTS.md", "CLAUDE.md", "CHANGELOG.md",
      "docs/testing.md", "docs/adr/example.md", ".agents/skills/end-session/SKILL.md",
      ".claude/skills/end-session/SKILL.md"]).include.length, 0);
    for (const files of [null, [], ["README.md", "src/cli.js"], ["docs/conformance/fixtures.json"],
      ["docs/schemas/new.schema.json"], ["package.json"], ["test/fixture.md"], ["unknown.md"],
      [".github/workflows/ci.yml"], [".agents/skills/example/script.mjs"], ["scripts/ci-plan.mjs"]]) {
      assert.ok(planCi(event, files).include.length > 0, JSON.stringify({ event, files }));
    }
  }
});

test("manual qualification always retains all platform modes and the Node floor", () => {
  const jobs = planCi("workflow_dispatch", ["README.md"]).include;
  assert.equal(jobs.length, 14);
  assert.equal(new Set(jobs.map((job) => JSON.stringify(job))).size, 14);
  for (const os of ["ubuntu-latest", "windows-latest"]) {
    assert.deepEqual(jobs.filter((job) => job.os === os && job.node === 24).map((job) => job.mode),
      ["default", "session-on", "session-off", "forecast-worktree", "forecast-merge-tree", "engine-native"]);
  }
  assert.deepEqual(jobs.filter((job) => job.node === 20), [
    { os: "ubuntu-latest", node: 20, mode: "default" },
    { os: "ubuntu-latest", node: 20, mode: "session-on" },
  ]);
  assert.throws(() => planCi("unknown", []), /Unsupported CI event/);
});

function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "vcs-lab-ci-plan-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd, env: testEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init");
  git("config", "user.name", "CI Test");
  git("config", "user.email", "ci@example.test");
  return { cwd, git };
}

test("PR and multi-commit push comparisons include removed code when renamed to docs", (t) => {
  const { cwd, git } = fixture(t);
  fs.writeFileSync(path.join(cwd, "code.js"), "// same content\n");
  git("add", ".");
  git("commit", "-m", "base");
  const base = git("rev-parse", "HEAD");
  git("mv", "code.js", "README.md");
  git("commit", "-m", "rename code to docs");
  fs.writeFileSync(path.join(cwd, "CHANGELOG.md"), "change\n");
  git("add", ".");
  git("commit", "-m", "last commit is only docs");
  for (const [eventName, event] of [["push", { before: base }],
    ["pull_request", { pull_request: { base: { sha: base } } }]]) {
    const files = changedPaths(eventName, event, cwd);
    assert.deepEqual(files.sort(), ["CHANGELOG.md", "README.md", "code.js"]);
    assert.ok(planCi(eventName, files).include.length > 0);
  }
});

test("missing or invalid comparison commits conservatively retain routine suites", (t) => {
  const { cwd } = fixture(t);
  for (const before of [undefined, "0".repeat(40), "a".repeat(40), "--output=README.md", 123]) {
    const files = changedPaths("push", { before }, cwd);
    assert.equal(files, null);
    assert.equal(planCi("push", files).include.length, 1);
  }
});

test("the CLI writes usable Actions outputs for documentation, code and manual runs", (t) => {
  const { cwd, git } = fixture(t);
  fs.writeFileSync(path.join(cwd, "README.md"), "base\n");
  git("add", ".");
  git("commit", "-m", "base");
  const before = git("rev-parse", "HEAD");
  fs.appendFileSync(path.join(cwd, "README.md"), "docs\n");
  git("add", ".");
  git("commit", "-m", "docs");
  for (const [eventName, event, count] of [["push", { before }, 0],
    ["pull_request", { pull_request: { base: { sha: before } } }, 0],
    ["pull_request", {}, 2], ["workflow_dispatch", {}, 14]]) {
    const eventPath = path.join(cwd, "event.json");
    const outputPath = path.join(cwd, "output.txt");
    const summaryPath = path.join(cwd, "summary.md");
    fs.writeFileSync(eventPath, JSON.stringify(event));
    fs.writeFileSync(outputPath, "");
    execFileSync(process.execPath, [planner], { cwd, env: testEnv({
      GITHUB_EVENT_NAME: eventName, GITHUB_EVENT_PATH: eventPath,
      GITHUB_OUTPUT: outputPath, GITHUB_STEP_SUMMARY: summaryPath,
    }) });
    const [run, matrix] = fs.readFileSync(outputPath, "utf8").trim().split("\n");
    assert.equal(run, `run-suite=${count > 0}`);
    assert.equal(JSON.parse(matrix.slice("matrix=".length)).include.length, count);
    assert.match(fs.readFileSync(summaryPath, "utf8"), /CI selection:/);
  }
});
