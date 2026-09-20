import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { testEnv } from "../test-support/git-environment.js";

const cli = fileURLToPath(new URL("../bin/vlab.js", import.meta.url));

function exec(command, args, cwd, options = {}) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    env: testEnv(),
    ...options,
  }).trim();
}

const git = (cwd, ...args) => exec("git", args, cwd);

function run(cwd, ...args) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8",
    env: testEnv(),
  });
}

function vlab(cwd, ...args) {
  const result = run(cwd, ...args);
  assert.equal(result.status, 0, `${args.join(" ")}\n${result.stdout}${result.stderr}`);
  return result.stdout.trim();
}

const vlabJson = (cwd, ...args) => JSON.parse(vlab(cwd, ...args, "--json"));

function refusal(cwd, ...args) {
  const result = run(cwd, ...args, "--json");
  assert.notEqual(result.status, 0, `expected a refusal from: ${args.join(" ")}\n${result.stdout}`);
  return JSON.parse(result.stdout);
}

function write(repo, relative, content) {
  const target = path.join(repo, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function commit(repo, name) {
  write(repo, `${name}.txt`, `${name}\n`);
  git(repo, "add", "-A");
  return JSON.parse(vlab(repo, "commit", "-m", name, "--json"));
}

/**
 * `main` with two commits of its own, and a `feature` branch of four, so a range
 * can start in the middle of the feature and leave a declared remainder behind.
 */
function ranged(t) {
  const parent = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), "vcs-lab-ranges-")),
  );
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const repo = path.join(parent, "repo");
  fs.mkdirSync(repo);
  git(repo, "init", "-b", "main");
  git(repo, "config", "core.autocrlf", "false");
  git(repo, "config", "core.eol", "lf");
  git(repo, "config", "user.name", "VCS Lab Ranges Test");
  git(repo, "config", "user.email", "vcs-lab-ranges@example.invalid");
  vlab(repo, "init");
  commit(repo, "base");
  const base = git(repo, "rev-parse", "HEAD");

  git(repo, "switch", "-c", "feature");
  const first = commit(repo, "first");
  const second = commit(repo, "second");
  const third = commit(repo, "third");
  const fourth = commit(repo, "fourth");

  git(repo, "switch", "main");
  commit(repo, "main-moves");
  git(repo, "switch", "feature");
  return { parent, repo, base, first, second, third, fourth };
}

// ---------------------------------------------------------------------------
// The constraint everything else rests on
// ---------------------------------------------------------------------------

test("naming the physical merge base explicitly changes nothing but the declaration", (t) => {
  const { repo } = ranged(t);
  const implicit = vlabJson(repo, "rebase-plan", "main");
  const mergeBase = git(repo, "merge-base", "main", "feature");
  const explicit = vlabJson(repo, "rebase-plan", "main", "--from", mergeBase);

  // Without --from the base is the physical merge base, so the two plans must be
  // the same plan. If this ever diverges, the generalization has changed v1.
  assert.equal(implicit.range.base, mergeBase);
  assert.equal(implicit.range.explicit, false);
  assert.equal(explicit.range.explicit, true);
  assert.deepEqual(explicit.excludedByRange, []);
  assert.deepEqual(implicit.excludedByRange, []);

  const comparable = (plan) => ({ ...plan, range: { ...plan.range, explicit: null, baseRef: null } });
  assert.deepEqual(comparable(explicit), comparable(implicit),
    "an explicit base equal to the merge base yields an identical plan");
  assert.equal(explicit.fingerprint, implicit.fingerprint,
    "the fingerprint covers the base, not whether it was typed out");
});

// ---------------------------------------------------------------------------
// What a range excludes
// ---------------------------------------------------------------------------

test("commits before the range base are listed, and never replayed or claimed", (t) => {
  const { repo, second, third, fourth, first } = ranged(t);
  const plan = vlabJson(repo, "rebase-plan", "main", "--from", second.commit);

  assert.equal(plan.range.explicit, true);
  assert.equal(plan.range.base, second.commit);
  assert.equal(plan.range.tip, git(repo, "rev-parse", "feature"));

  // The range is second..feature, so only the two commits after it replay.
  assert.deepEqual(
    plan.replayQueue.map((item) => item.commit),
    [third.commit, fourth.commit],
  );
  // Everything before the base is declared, with enough to recognise it.
  assert.deepEqual(
    plan.excludedByRange.map((item) => item.commit),
    [first.commit, second.commit],
  );
  for (const excluded of plan.excludedByRange) {
    assert.match(excluded.changeId, /^ch_/);
    assert.ok(excluded.subject.length > 0);
  }
  // And they are absent from every member that would give them standing.
  const claimed = new Set([
    ...plan.changes.map((change) => change.commit),
    ...plan.omitted.map((item) => item.commit),
    ...plan.candidates.map((item) => item.commit),
  ]);
  for (const excluded of plan.excludedByRange) {
    assert.equal(claimed.has(excluded.commit), false,
      `${excluded.commit} is excluded by range and must not be classified`);
  }

  // The human summary says how many stay behind, so the omission is visible
  // without reading JSON.
  const text = vlab(repo, "rebase-plan", "main", "--from", second.commit);
  assert.match(text, /excluded/i);
  assert.match(text, /2/);
});

test("a range whose base is already in the target excludes nothing", (t) => {
  const { repo, base } = ranged(t);
  const plan = vlabJson(repo, "rebase-plan", "main", "--from", base);
  assert.deepEqual(plan.excludedByRange, [],
    "a base reachable from onto makes the range a plain rebase");
  assert.equal(plan.range.explicit, true);
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

test("a base that is not an ancestor of the tip, or is the tip, is refused", (t) => {
  const { repo, base } = ranged(t);
  const tip = git(repo, "rev-parse", "feature");

  const notAncestor = refusal(repo, "rebase-plan", "main", "--from", git(repo, "rev-parse", "main"));
  assert.equal(notAncestor.code, "unsupported-range");
  assert.match(notAncestor.message, /ancestor/);

  const atTip = refusal(repo, "rebase-plan", "main", "--from", tip);
  assert.equal(atTip.code, "unsupported-range");

  const absent = refusal(repo, "rebase-plan", "main", "--from", "0".repeat(40));
  assert.ok(["revision-not-resolved", "unsupported-range"].includes(absent.code), absent.code);
  void base;
});

test("a range whose tip is not a branch tip is refused rather than re-parented", (t) => {
  const { repo, second, third } = ranged(t);
  // `third` is in the middle of `feature`: rebasing second..third would leave
  // `fourth` needing a new parent, which is the interactive editing of #30.
  const refused = refusal(repo, "rebase-plan", "main", third.commit, "--from", second.commit);
  assert.equal(refused.code, "unsupported-range");
  assert.match(refused.message, /branch tip/);
});

// ---------------------------------------------------------------------------
// The forecast pins the range
// ---------------------------------------------------------------------------

test("a forecast made for one range does not authorize another", (t) => {
  const { repo, second, first } = ranged(t);
  const wide = vlabJson(repo, "rebase-forecast", "main", "--from", first.commit);
  const narrow = vlabJson(repo, "rebase-forecast", "main", "--from", second.commit);
  assert.notEqual(wide.planFingerprint, narrow.planFingerprint,
    "the fingerprint covers the range base");
  assert.equal(wide.range.base, first.commit);
  assert.equal(narrow.range.base, second.commit);

  const stale = refusal(
    repo, "rebase", "main", "--from", second.commit, "--use-forecast", wide.id,
  );
  assert.equal(stale.code, "stale-forecast");
});

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

test("only the range replays, and the receipt records what stayed behind", (t) => {
  const { repo, second, third, fourth, first } = ranged(t);
  const before = git(repo, "rev-parse", "feature");
  const result = vlabJson(repo, "rebase", "main", "--from", second.commit);

  assert.equal(result.receipt.range.base, second.commit);
  assert.deepEqual(
    result.receipt.excludedByRange.map((item) => item.commit),
    [first.commit, second.commit],
  );
  // Exact origin-to-result mapping survives, which is the property the issue
  // names as non-negotiable.
  assert.deepEqual(
    result.receipt.applications.map((item) => item.sourceCommit),
    [third.commit, fourth.commit],
  );
  for (const application of result.receipt.applications) {
    assert.ok(application.appliedCommit, "every replayed commit names what it became");
    assert.ok(application.sourceChangeId && application.appliedChangeId);
  }
  // The declared omission really happened: the excluded work is not on the
  // rebased branch.
  const history = git(repo, "rev-list", "HEAD").split(/\r?\n/);
  assert.equal(history.includes(first.commit), false);
  assert.equal(history.includes(second.commit), false);
  assert.notEqual(git(repo, "rev-parse", "feature"), before);

  // Metadata stays valid and the identity audit sees derived work, not a
  // collision, exactly as the walkthrough recorded for v1.
  const validated = vlabJson(repo, "metadata", "validate");
  assert.equal(validated.summary.valid, true);
  const audit = vlabJson(repo, "audit", "identity");
  assert.equal(audit.summary.errors, 0);
});

test("abort restores the original tip, range or no range", (t) => {
  const { repo, second } = ranged(t);
  const before = git(repo, "rev-parse", "feature");
  // A conflicting target makes the rebase pause, so there is something to abort.
  git(repo, "switch", "main");
  write(repo, "third.txt", "conflicting\n");
  git(repo, "add", "-A");
  vlab(repo, "commit", "-m", "conflicting main change");
  git(repo, "switch", "feature");

  const paused = run(repo, "rebase", "main", "--from", second.commit, "--json");
  assert.notEqual(paused.status, 0, "the fixture must pause on a conflict");
  const aborted = vlabJson(repo, "rebase", "--abort");
  assert.equal(aborted.aborted, true);
  assert.equal(git(repo, "rev-parse", "feature"), before,
    "abort restores the exact original tip; the range changes what replays, not what is restored");
});
