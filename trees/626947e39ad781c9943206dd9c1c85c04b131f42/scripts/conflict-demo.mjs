import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(projectRoot, "bin", "vlab.js");
const repo = fs.mkdtempSync(path.join(os.tmpdir(), "vcs-lab-conflict-demo-"));

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
  fs.writeFileSync(path.join(repo, relative), content);
}

console.log(`Creating resumable-conflict demo at ${repo}\n`);
git("init", "-b", "main");
git("config", "core.autocrlf", "false");
git("config", "core.eol", "lf");
git("config", "user.name", "VCS Lab Demo");
git("config", "user.email", "vcs-lab@example.test");
vlab("init");

write("shared.txt", "base\n");
git("add", "shared.txt");
vlab("commit", "-m", "base");

vlab("branch", "feature");
write("shared.txt", "feature policy: retries = 5\n");
git("add", "shared.txt");
vlab("commit", "-m", "feature changes retry policy");

git("switch", "main");
write("shared.txt", "main policy: retries = 3\n");
git("add", "shared.txt");
vlab("commit", "-m", "main changes retry policy");

console.log("\nStarting reconciliation; this conflict is intentional...");
const attempt = spawnSync(process.execPath, [cli, "reconcile", "feature"], {
  cwd: repo,
  encoding: "utf8",
  env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
});
if (attempt.status === 0) {
  throw new Error("Expected the conflict demo to pause, but reconciliation completed.");
}
if (attempt.stderr) console.log(attempt.stderr.trim());

console.log("\nPending operation:");
vlab("reconcile", "--status");
console.log(
  `\nContinue the experiment with:\n  cd ${repo}\n  node -e "require('fs').writeFileSync('shared.txt', 'contextual policy: retries = 4\\n')"\n  git add shared.txt\n  vlab reconcile --continue\n  vlab graph\n  vlab receipts`,
);
