#!/usr/bin/env node
/**
 * Build the legacy-identifier fixture (issue #159, ADR-0039 §2): a repository
 * written entirely by a released build whose records carry `vcs-lab.*` ids,
 * plus that build's own read outputs. `test/legacy-fixture.test.js` restores
 * it and requires the current build to read it identically, apart from the
 * spelling of the identifiers.
 *
 *   node scripts/make-legacy-fixture.mjs --cli <old checkout>/bin/vlab.js --out test/fixtures/legacy-<version>
 *
 * Extract the old checkout with `git archive <tag> | tar -x -C <dir>`; this
 * script never touches the repository it lives in. The output is deterministic
 * except for record ids and timestamps, which are fixed once generated.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  if (index === -1 || !args[index + 1]) throw new Error(`${name} <value> is required`);
  return path.resolve(args[index + 1]);
};
const cli = option("--cli");
const out = option("--out");

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "vcs-lab-legacy-")));
const repo = path.join(root, "repo");
const workspace = path.join(root, "ws-agent");
const gitConfig = path.join(root, "gitconfig");
fs.writeFileSync(gitConfig, "[user]\n\tname = Legacy Fixture\n\temail = legacy@example.invalid\n[core]\n\tautocrlf = false\n\teol = lf\n[init]\n\tdefaultBranch = main\n");
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(VLAB_|CAUSET_|GIT_CONFIG_(COUNT|KEY_|VALUE_|PARAMETERS))/.test(key))),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: gitConfig,
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_DATE: "2026-09-28T12:00:00Z",
  GIT_COMMITTER_DATE: "2026-09-28T12:00:00Z",
};

function git(cwd, ...rest) {
  return execFileSync("git", rest, { cwd, env, encoding: "utf8" }).trim();
}
function vlab(cwd, ...rest) {
  const result = spawnSync(process.execPath, [cli, ...rest], { cwd, env, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
function ok(cwd, ...rest) {
  const result = vlab(cwd, ...rest);
  if (result.status !== 0) throw new Error(`vlab ${rest.join(" ")} failed:\n${result.stderr}${result.stdout}`);
  return result.stdout;
}
function write(relative, text, cwd = repo) {
  fs.mkdirSync(path.dirname(path.join(cwd, relative)), { recursive: true });
  fs.writeFileSync(path.join(cwd, relative), text);
}
function commitFile(relative, text, message, ...flags) {
  write(relative, text);
  git(repo, "add", "-A");
  return JSON.parse(ok(repo, "commit", "-m", message, "--json", ...flags));
}

console.error(`building in ${root} with ${cli}`);
fs.mkdirSync(repo);
git(repo, "init", "-q", "-b", "main");
ok(repo, "init");

// Declared provenance on ordinary commits.
const base = commitFile("policy.txt", "base policy\n", "base policy", "--generated-by", "legacy-agent");
commitFile("docs/readme.txt", "readme\n", "add readme", "--authored-by", "Legacy Author", "--reviewed-by", "Legacy Reviewer");

// A compact landing.
git(repo, "switch", "-q", "-c", "feature");
commitFile("feature/a.txt", "feature a\n", "feature a", "--generated-by", "legacy-agent");
commitFile("feature/b.txt", "feature b\n", "feature b");
git(repo, "switch", "-q", "main");
ok(repo, "merge", "feature", "--compact", "-m", "land feature");

// An application receipt.
git(repo, "switch", "-q", "-c", "topic");
commitFile("topic/fix.txt", "topic fix\n", "topic fix", "--generated-by", "legacy-agent");
git(repo, "switch", "-q", "main");
ok(repo, "cherry-pick", "topic");

// A conflicted reconciliation, resolved by hand: a resolution record, its
// retention ref, and a reconciliation receipt.
git(repo, "switch", "-q", "-c", "source-one", base.commit);
commitFile("policy.txt", "source policy: retries = 5\n", "source policy");
git(repo, "switch", "-q", "main");
commitFile("policy.txt", "target policy: retries = 3\n", "target policy");
const paused = vlab(repo, "reconcile", "source-one");
if (paused.status === 0) throw new Error("expected the reconciliation to pause on a conflict");
write("policy.txt", "combined policy: retries = 4\n");
git(repo, "add", "policy.txt");
ok(repo, "reconcile", "--continue");

// A causal rebase: rebase and rebase-application receipts.
git(repo, "switch", "-q", "-c", "rebased", base.commit);
commitFile("rebased/one.txt", "rebased one\n", "rebased one", "--generated-by", "legacy-agent");
commitFile("rebased/two.txt", "rebased two\n", "rebased two");
ok(repo, "rebase", "main");
git(repo, "switch", "-q", "main");

// A tracked spec manifest.
write("specs/design.md", "# Design\n\n## Goals\n\nKeep history causal.\n\n## Limits\n\nNo rewrites.\n");
ok(repo, "spec", "index", "specs/design.md");
git(repo, "add", "-A");
ok(repo, "commit", "-m", "index the design spec");

// A stored forecast of a branch that is still pending.
git(repo, "switch", "-q", "-c", "pending", "main");
commitFile("pending/next.txt", "next\n", "pending next");
git(repo, "switch", "-q", "main");
const forecast = JSON.parse(ok(repo, "forecast", "pending", "--json"));

// A workspace with a checkpoint.
ok(repo, "workspace", "create", "agent", "--path", workspace, "--json");
write("work.txt", "workspace work\n", workspace);
ok(workspace, "workspace", "checkpoint", "--label", "first", "--json");

// Retention backfill, an exported envelope, and a proof bundle.
ok(repo, "metadata", "retain", "--apply");
ok(repo, "metadata", "export", path.join(root, "envelope"), "--json");
fs.writeFileSync(path.join(root, "proof-bundle.json"), ok(repo, "proof-bundle", "feature"));

// The old build's read outputs, the expectations the current build must meet.
const reads = [
  ["receipts", "--json"],
  ["provenance", "main", "--all", "--json"],
  ["metadata", "status", "--json"],
  ["metadata", "validate", "--json"],
  ["audit", "identity", "--json"],
  ["resolve", "list", "--json"],
  ["spec", "show", "specs/design.md"],
  ["spec", "status", "--json"],
  ["workspace", "list"],
  ["merge-plan", "pending", "--json"],
  ["verify-proof", path.join(root, "proof-bundle.json"), "--json"],
  ["capabilities", "--against", path.join(root, "envelope"), "--json"],
  ["graph"],
];
const expected = reads.map((read) => ({ args: read, ...vlab(repo, ...read) }));

// Write the fixture: every ref in one bundle, the shared-local and private
// state the bundle cannot carry, the exchanged artifacts, and expectations.
const placeholder = (text) => text
  .split(JSON.stringify(root).slice(1, -1)).join("<ROOT>")
  .split(root).join("<ROOT>")
  .split(root.replaceAll("\\", "/")).join("<ROOT>");
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
// Everything is text: the repository forbids binary files (test/repository-hygiene.test.js).
const bundleFile = path.join(root, "repo.bundle");
git(repo, "bundle", "create", bundleFile, "--all");
const state = path.join(repo, ".git", "vcs-lab");
const files = {};
for (const entry of fs.readdirSync(state, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile() || entry.name.endsWith(".lock")) continue;
  const full = path.join(entry.parentPath ?? entry.path, entry.name);
  files[path.relative(state, full).replaceAll("\\", "/")] = placeholder(fs.readFileSync(full, "utf8"));
}
const envelope = {};
for (const entry of fs.readdirSync(path.join(root, "envelope"), { recursive: true, withFileTypes: true })) {
  if (!entry.isFile()) continue;
  const full = path.join(entry.parentPath ?? entry.path, entry.name);
  envelope[path.relative(path.join(root, "envelope"), full).replaceAll("\\", "/")] =
    fs.readFileSync(full).toString("base64");
}
const version = ok(repo, "--version").trim();
const fixture = {
  generatedBy: version,
  head: git(repo, "rev-parse", "HEAD"),
  workspace: { name: "agent", branch: git(workspace, "branch", "--show-current"), path: "<ROOT>/ws-agent" },
  forecastId: forecast.id,
  bundle: fs.readFileSync(bundleFile).toString("base64"),
  state: files,
  envelope,
  proofBundle: fs.readFileSync(path.join(root, "proof-bundle.json"), "utf8"),
  expected: expected.map((entry) => ({
    args: entry.args.map(placeholder),
    status: entry.status,
    stdout: placeholder(entry.stdout),
    stderr: placeholder(entry.stderr),
  })),
};
fs.writeFileSync(path.join(out, "fixture.json"), `${JSON.stringify(fixture, null, 2)}\n`);
git(repo, "worktree", "remove", "--force", workspace);
fs.rmSync(root, { recursive: true, force: true });
console.error(`wrote ${out} (${version}, ${expected.length} expected reads)`);
