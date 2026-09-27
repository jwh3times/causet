import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(projectRoot, "bin", "vlab.js");
const repo = fs.mkdtempSync(path.join(os.tmpdir(), "vcs-lab-forecast-demo-"));

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

function expectConflict(source) {
  const attempt = spawnSync(process.execPath, [cli, "reconcile", source], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (attempt.status === 0) {
    throw new Error(`Expected reconciliation from ${source} to conflict.`);
  }
}

console.log(`Creating forecast demo at ${repo}\n`);
git("init", "-b", "main");
git("config", "core.autocrlf", "false");
git("config", "core.eol", "lf");
git("config", "user.name", "VCS Lab Demo");
git("config", "user.email", "vcs-lab@example.test");
vlab("init");

write("shared.txt", "base policy\n");
git("add", "shared.txt");
const base = JSON.parse(vlab("commit", "-m", "base policy", "--json"));

git("switch", "-c", "source-one", base.commit);
write("shared.txt", "source policy: retries = 5\n");
git("add", "shared.txt");
vlab("commit", "-m", "source policy one", "--json");
git("switch", "-c", "target-one", base.commit);
write("shared.txt", "target policy: retries = 3\n");
git("add", "shared.txt");
vlab("commit", "-m", "target policy one", "--json");
expectConflict("source-one");
write("shared.txt", "combined policy: retries = 4\n");
git("add", "shared.txt");
vlab("reconcile", "--continue");

git("switch", "-c", "renamed-base", base.commit);
git("mv", "shared.txt", "renamed-policy.txt");
const renamedBase = JSON.parse(
  vlab("commit", "-m", "rename policy file", "--json"),
);
git("switch", "-c", "source-two", renamedBase.commit);
write("renamed-policy.txt", "source policy: retries = 5\n");
git("add", "renamed-policy.txt");
vlab("commit", "-m", "source policy two", "--json");
git("switch", "-c", "target-two", renamedBase.commit);
write("renamed-policy.txt", "target policy: retries = 3\n");
git("add", "renamed-policy.txt");
vlab("commit", "-m", "target policy two", "--json");

console.log("\nForecasting without changing target-two...");
const forecastOutput = vlab("forecast", "source-two");
const forecastId = forecastOutput.match(/^forecast\s+(forecast_[a-z0-9]+)/m)?.[1];
if (!forecastId) throw new Error("Could not read the generated forecast ID.");

console.log(
  `\nThe repository is still clean. Apply the reviewed forecast with:\n  cd ${repo}\n  git status --short\n  vlab reconcile source-two --use-forecast ${forecastId}\n  vlab graph\n  vlab receipts`,
);
