import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(projectRoot, "bin", "vlab.js");
const repo = fs.mkdtempSync(path.join(os.tmpdir(), "vcs-lab-demo-"));

function run(command, args, { quiet = false } = {}) {
  const output = execFileSync(command, args, {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  }).trim();
  if (!quiet && output) console.log(output);
  return output;
}

function git(...args) {
  return run("git", args, { quiet: true });
}

function vlab(...args) {
  return run(process.execPath, [cli, ...args]);
}

function write(relative, content) {
  const target = path.join(repo, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

console.log(`Creating demo repository at ${repo}\n`);
git("init", "-b", "main");
git("config", "core.autocrlf", "false");
git("config", "core.eol", "lf");
git("config", "user.name", "VCS Lab Demo");
git("config", "user.email", "vcs-lab@example.test");
vlab("init");

write("app.txt", "base\n");
git("add", ".");
vlab("commit", "-m", "base");
vlab("branch", "feature");

write("feature.txt", "part one\n");
git("add", ".");
vlab("commit", "-m", "feature part one");
write("feature.txt", "part one\npart two\n");
git("add", ".");
vlab("commit", "-m", "feature part two");

git("switch", "main");
console.log("\nHard-squashing the first two feature changes...");
vlab("merge", "feature", "--hard-squash");

git("switch", "feature");
write("continuation.txt", "only this should be applied later\n");
git("add", ".");
vlab("commit", "-m", "feature continuation");

git("switch", "main");
console.log("\nCausal plan after the feature continues:");
vlab("merge-plan", "feature");

console.log("\nReconciling only proven-new work:");
vlab("reconcile", "feature");

console.log("\nPlan after reconciliation:");
vlab("merge-plan", "feature");

write(
  "docs/spec.md",
  "# Demo capability\n\nREQ-DEMO-1: The landing must preserve causal membership.\n",
);
console.log("\nIndexing an annotated Markdown spec:");
vlab("spec", "index", "docs/spec.md");
git("add", "docs/spec.md", ".vcs-lab/specs/docs/spec.md.json");
vlab("commit", "-m", "add indexed demo specification");

console.log(`\nDemo complete. Inspect it with:\n  cd ${repo}\n  vlab graph\n  vlab receipts\n  vlab receipts --json`);
