import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { MERGE_TREE_ENGINE_MIN_GIT } from "../src/git.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(projectRoot, "bin", "vlab.js");
const repo = fs.mkdtempSync(path.join(os.tmpdir(), "vcs-lab-git-session-demo-"));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(result.stderr || result.stdout || `${command} failed`);
  }
  return result;
}

function git(...args) {
  return run("git", args).stdout.trim();
}

function write(content) {
  fs.writeFileSync(path.join(repo, "history.txt"), content);
}

function measure(...flags) {
  const started = performance.now();
  const result = run(process.execPath, [
    cli,
    "forecast",
    "feature",
    ...flags,
    "--trace-git",
    "--json",
  ]);
  const trace = result.stderr
    .split(/\r?\n/)
    .filter((line) => line.startsWith("[vlab trace]"));
  return {
    forecast: JSON.parse(result.stdout),
    wallMs: Number((performance.now() - started).toFixed(2)),
    queries: trace.length,
    processes: trace.filter((line) =>
      /\((?:new|new persistent) process\)$/.test(line),
    ).length,
    sessionQueries: trace.filter((line) =>
      /persistent process\)$/.test(line),
    ).length,
    cacheHits: trace.filter((line) => /\(cache hit\)$/.test(line)).length,
  };
}

console.log(`Creating Git-session comparison at ${repo}\n`);
git("init", "-q", "-b", "main");
git("config", "core.autocrlf", "false");
git("config", "core.eol", "lf");
git("config", "user.name", "VCS Lab Demo");
git("config", "user.email", "vcs-lab@example.test");
write("base\n");
git("add", "history.txt");
git("commit", "-q", "-m", "base");
run(process.execPath, [cli, "init"]);
git("switch", "-q", "-c", "feature");
for (let index = 1; index <= 12; index += 1) {
  write(`${index}\n`);
  git("add", "history.txt");
  git(
    "commit",
    "-q",
    "-m",
    `feature ${index}\n\nChange-Id: ch_demo_${index}`,
  );
}
git("switch", "-q", "main");

// The merge-tree engine needs Git 2.49 (`merge-tree --stdin` flushes each record only from there);
// older Git records a git-too-old fallback and the worktree simulator answers.
const mergeTreeSupported = (() => {
  const match = git("--version").match(/(\d+)\.(\d+)/);
  if (!match) return true;
  const [major, minor] = [Number(match[1]), Number(match[2])];
  const [wantMajor, wantMinor] = MERGE_TREE_ENGINE_MIN_GIT.split(".").map(Number);
  return major > wantMajor || (major === wantMajor && minor >= wantMinor);
})();

const session = measure("--git-session", "--forecast-engine", "worktree");
const ordinary = measure("--no-git-session", "--forecast-engine", "worktree");
const mergeTree = measure("--git-session", "--forecast-engine", "merge-tree");
const projection = (forecast) => ({
  changes: forecast.plan.changes,
  predictedResultTree: forecast.predictedResultTree,
  steps: forecast.steps.map((step) => [
    step.outcome,
    step.targetBeforeTree,
    step.resultTree,
  ]),
});
assert.deepEqual(projection(ordinary.forecast), projection(session.forecast));
assert.deepEqual(projection(mergeTree.forecast), projection(session.forecast));
assert.equal(session.forecast.engine, "worktree");
if (mergeTreeSupported) {
  assert.equal(mergeTree.forecast.engine, "merge-tree");
  assert.deepEqual(mergeTree.forecast.fallbacks, []);
  assert.equal(mergeTree.forecast.timings.worktree.totalMs, 0);
} else {
  assert.equal(mergeTree.forecast.engine, "worktree");
  assert.equal(mergeTree.forecast.fallbacks[0]?.reason, "git-too-old");
}
const cut = (measured) =>
  ordinary.processes
    ? Number(((1 - measured.processes / ordinary.processes) * 100).toFixed(1))
    : 0;
const merges =
  mergeTree.forecast.timings.git.byCommand.find(
    (item) => item.command === "merge-tree-session",
  )?.count ?? 0;

console.log("Equivalent forecasts produced without changing the target.");
console.log(`changes      ${session.forecast.plan.changes.length}`);
console.log(
  `ordinary     ${ordinary.processes} processes; ${ordinary.queries} queries; ${ordinary.wallMs.toFixed(2)} ms (worktree simulator, one process per query)`,
);
console.log(
  `session      ${session.processes} processes; ${session.queries} queries; ${session.wallMs.toFixed(2)} ms (worktree simulator, object session; cut ${cut(session).toFixed(1)}%)`,
);
console.log(
  `merge-tree   ${mergeTree.processes} processes; ${mergeTree.queries} queries; ${mergeTree.wallMs.toFixed(2)} ms (merge-tree engine, object session; cut ${cut(mergeTree).toFixed(1)}%)`,
);
console.log(
  `session I/O  ${session.sessionQueries} persistent queries; ${session.cacheHits} immutable cache hits`,
);
if (mergeTree.forecast.engine === "merge-tree") {
  console.log(
    `merge-tree   ${merges} merges through one persistent process; ${mergeTree.forecast.timings.git.processes} processes inside the forecast itself; no temporary worktree`,
  );
} else {
  console.log(
    `merge-tree   engine unavailable (${mergeTree.forecast.fallbacks.map((item) => item.reason).join(", ")}; ${git("--version")}; the engine needs Git ${MERGE_TREE_ENGINE_MIN_GIT}): the mode above fell back to the worktree simulator`,
  );
}
console.log(
  "Windows enables the session and the merge-tree engine automatically (Git 2.49 or newer); POSIX hosts opt in with --forecast-engine merge-tree. Wall time is machine-specific; plan, per-step tree, and predicted-tree equality plus process reduction are the acceptance invariants.",
);
console.log(
  `\nInspect the repository with:\n  cd ${repo}\n  vlab forecast feature --trace-git\n  vlab forecast feature --trace-git --forecast-engine merge-tree`,
);
