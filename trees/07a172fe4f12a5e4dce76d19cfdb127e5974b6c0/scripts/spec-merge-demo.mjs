import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(projectRoot, "bin", "vlab.js");
const repo = fs.mkdtempSync(path.join(os.tmpdir(), "vcs-lab-spec-demo-"));

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

function writeSpec(content) {
  fs.mkdirSync(path.join(repo, "docs"), { recursive: true });
  fs.writeFileSync(path.join(repo, "docs", "policy.md"), content);
}

console.log(`Creating deterministic specification-merge demo at ${repo}\n`);
git("init", "-b", "main");
git("config", "core.autocrlf", "false");
git("config", "core.eol", "lf");
git("config", "user.name", "VCS Lab Demo");
git("config", "user.email", "vcs-lab@example.test");
vlab("init");

writeSpec(
  "# Retry policy\n\nREQ-RETRY-1: Use three attempts.\n\n# Audit policy\n\nREQ-AUDIT-1: Retain events for 30 days.\n",
);
vlab("spec", "index", "docs/policy.md");
git("add", ".");
const base = JSON.parse(vlab("commit", "-m", "base indexed policy", "--json"));

git("switch", "-c", "agent-retries", base.commit);
writeSpec(
  "# Retry policy\n\nREQ-RETRY-1: Use five attempts with exponential backoff.\n\n# Audit policy\n\nREQ-AUDIT-1: Retain events for 30 days.\n",
);
vlab("spec", "index", "docs/policy.md");
git("add", ".");
vlab("commit", "-m", "agent expands retry policy", "--json");

git("switch", "main");
writeSpec(
  "# Retry policy\n\nREQ-RETRY-1: Use three attempts.\n\n# Audit policy\n\nREQ-AUDIT-1: Retain events for 90 days in immutable storage.\n",
);
vlab("spec", "index", "docs/policy.md");
git("add", ".");
vlab("commit", "-m", "main expands audit policy", "--json");

console.log("\nForecasting two independent block edits...");
const output = vlab("forecast", "agent-retries");
const forecastId = output.match(/^forecast\s+(forecast_[a-z0-9]+)/m)?.[1];
if (!forecastId) throw new Error("Could not read the generated forecast ID.");

console.log(
  `\nThe target remains clean. Apply the reviewed block merge with:\n  cd ${repo}\n  git status --short\n  vlab reconcile agent-retries --use-forecast ${forecastId}\n  Get-Content docs\\policy.md\n  vlab receipts\n\nMeasure a generated documentation corpus with:\n  vlab spec benchmark --documents 25 --blocks 40`,
);
