import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(projectRoot, "bin", "vlab.js");
const parent = fs.mkdtempSync(path.join(os.tmpdir(), "vcs-lab-resolution-demo-"));
const repo = path.join(parent, "repo");
const workspace = path.join(parent, "reuse-worktree");
fs.mkdirSync(repo);

function run(command, args, cwd = repo, { quiet = false } = {}) {
  const output = execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  }).trim();
  if (!quiet && output) console.log(output);
  return output;
}

function git(cwd, ...args) {
  return run("git", args, cwd, { quiet: true });
}

function vlab(cwd, ...args) {
  return run(process.execPath, [cli, ...args], cwd);
}

function expectConflict(cwd, source) {
  const attempt = spawnSync(process.execPath, [cli, "reconcile", source], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (attempt.status === 0) {
    throw new Error(`Expected reconciliation from ${source} to conflict.`);
  }
  if (attempt.stderr) console.log(attempt.stderr.trim());
}

function write(cwd, relative, content) {
  fs.writeFileSync(path.join(cwd, relative), content);
}

console.log(`Creating reusable-resolution demo at ${repo}\n`);
git(repo, "init", "-b", "main");
git(repo, "config", "core.autocrlf", "false");
git(repo, "config", "core.eol", "lf");
git(repo, "config", "user.name", "VCS Lab Demo");
git(repo, "config", "user.email", "vcs-lab@example.test");
vlab(repo, "init");

write(repo, "shared.txt", "base policy\n");
git(repo, "add", "shared.txt");
const base = JSON.parse(vlab(repo, "commit", "-m", "base policy", "--json"));

git(repo, "switch", "-c", "source-one", base.commit);
write(repo, "shared.txt", "source policy: retries = 5\n");
git(repo, "add", "shared.txt");
vlab(repo, "commit", "-m", "source policy one", "--json");
git(repo, "switch", "-c", "target-one", base.commit);
write(repo, "shared.txt", "target policy: retries = 3\n");
git(repo, "add", "shared.txt");
vlab(repo, "commit", "-m", "target policy one", "--json");

console.log("\nFirst occurrence: resolve the conflict manually and remember it.");
expectConflict(repo, "source-one");
write(repo, "shared.txt", "combined policy: retries = 4\n");
git(repo, "add", "shared.txt");
vlab(repo, "reconcile", "--continue");

git(repo, "switch", "-c", "renamed-base", base.commit);
git(repo, "mv", "shared.txt", "renamed-policy.txt");
const renamedBase = JSON.parse(
  vlab(repo, "commit", "-m", "rename policy file", "--json"),
);
git(repo, "switch", "-c", "source-two", renamedBase.commit);
write(repo, "renamed-policy.txt", "source policy: retries = 5\n");
git(repo, "add", "renamed-policy.txt");
vlab(repo, "commit", "-m", "source policy two", "--json");
git(repo, "switch", "-c", "target-two", renamedBase.commit);
write(repo, "renamed-policy.txt", "target policy: retries = 3\n");
git(repo, "add", "renamed-policy.txt");
vlab(repo, "commit", "-m", "target policy two", "--json");
vlab(
  repo,
  "workspace",
  "create",
  "reuse-agent",
  "--from",
  "target-two",
  "--path",
  workspace,
  "--json",
);

console.log("\nSecond occurrence: the identical conflict is in a linked worktree.");
expectConflict(workspace, "source-two");
console.log("\nExact candidate discovered:");
vlab(workspace, "resolve", "status");

console.log(
  `\nContinue the experiment with:\n  cd ${workspace}\n  vlab resolve apply --all\n  git diff --cached -- renamed-policy.txt\n  vlab reconcile --continue\n  vlab graph\n  vlab receipts`,
);
