/**
 * Interactive identity decisions (ADR-0035, issue #30).
 *
 * The four actions are not variations of one operation, and the suite is
 * organized by the claim each makes about identity rather than by the mechanic
 * each uses:
 *
 * - `reword` keeps the identity and proves it by composing the trailer itself.
 * - `squash`/`fixup` keep exactly one identity on the commit and put the rest
 *   in a record, because several trailers would make the survivor depend on
 *   parse order.
 * - `edit` keeps the identity while changing what it contains, which is the one
 *   local operation that can make a proof in another clone wrong — so the
 *   amendment it publishes, and the coverage downgrade that follows, are the
 *   most important assertions in this file.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { testEnv } from "../test-support/git-environment.js";

const cli = fileURLToPath(new URL("../bin/vlab.js", import.meta.url));

const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: testEnv() }).trim();

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

function commit(repo, name, file = `${name}.txt`, content = `${name}\n`) {
  write(repo, file, content);
  git(repo, "add", "-A");
  return JSON.parse(vlab(repo, "commit", "-m", name, "--json"));
}

const changeIdOf = (repo, commitish) =>
  git(repo, "log", "-1", "--format=%B", commitish).match(/^Change-Id:\s*(.+)$/m)?.[1]?.trim() ?? null;

const trailerCount = (repo, commitish) =>
  git(repo, "log", "-1", "--format=%B", commitish).split(/\r?\n/)
    .filter((line) => /^Change-Id:/i.test(line)).length;

/** `main` with a commit of its own, and a `feature` branch of three. */
function fixture(t, label = "interactive") {
  const parent = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), `vcs-lab-${label}-`)),
  );
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const repo = path.join(parent, "repo");
  fs.mkdirSync(repo);
  git(repo, "init", "-b", "main");
  git(repo, "config", "core.autocrlf", "false");
  git(repo, "config", "core.eol", "lf");
  git(repo, "config", "user.name", "VCS Lab Interactive Test");
  git(repo, "config", "user.email", "vcs-lab-interactive@example.invalid");
  vlab(repo, "init");
  commit(repo, "base");

  git(repo, "switch", "-c", "feature");
  const first = commit(repo, "first");
  const second = commit(repo, "second");
  const third = commit(repo, "third");

  git(repo, "switch", "main");
  commit(repo, "main-moves");
  git(repo, "switch", "feature");
  return { parent, repo, first, second, third };
}

// ---------------------------------------------------------------------------
// Declaration: the program is stated, never inherited
// ---------------------------------------------------------------------------

test("a declared action replaces replay for its commit and nothing else", (t) => {
  const { repo, first, second, third } = fixture(t);
  const plan = vlabJson(
    repo, "rebase-plan", "main",
    "--reword", first.commit,
    "--fixup", `${second.commit}=${first.commit}`,
  );

  assert.equal(plan.schema, "vcs-lab.rebase-plan/v3");
  assert.deepEqual(
    plan.changes.map((change) => [change.commit, change.action]),
    [[first.commit, "reword"], [second.commit, "fixup"], [third.commit, "replay"]],
  );
  // `reword` still produces a commit, so it stays queued; `fixup` lands inside
  // its survivor, so it does not.
  assert.deepEqual(
    plan.replayQueue.map((item) => item.commit),
    [first.commit, third.commit],
  );
  assert.deepEqual(plan.interactive, [
    { action: "reword", commit: first.commit, target: null },
    { action: "fixup", commit: second.commit, target: first.commit },
  ]);
  // The classification is untouched: an action says what the rewrite does with
  // a change, never whether it is covered.
  assert.ok(plan.changes.every((change) => change.status === "new"));
});

test("the plan fingerprint covers the declared program", (t) => {
  const { repo, first, second } = fixture(t);
  const plain = vlabJson(repo, "rebase-plan", "main");
  const reworded = vlabJson(repo, "rebase-plan", "main", "--reword", first.commit);
  const fixed = vlabJson(repo, "rebase-plan", "main", "--fixup", `${second.commit}=${first.commit}`);

  assert.notEqual(reworded.fingerprint, plain.fingerprint);
  assert.notEqual(fixed.fingerprint, plain.fingerprint);
  assert.notEqual(reworded.fingerprint, fixed.fingerprint,
    "two different programs must not share an approval");
});

test("every shape the contract does not admit is refused by name", (t) => {
  const { repo, first, second, third } = fixture(t);
  const cases = [
    [["--reword", `${first.commit}=text`], /names one commit, not a pair/],
    [["--fixup", first.commit], /needs both a subject and a target/],
    [["--fixup", `${first.commit}=${first.commit}`], /into itself/],
    [["--fixup", `${first.commit}=${second.commit}`], /target that comes after its subject/],
    [["--reword", first.commit, "--edit", first.commit], /named by both/],
    [
      ["--fixup", `${third.commit}=${second.commit}`, "--squash", `${second.commit}=${first.commit}`],
      /which is itself absorbed into/,
    ],
  ];
  for (const [args, pattern] of cases) {
    const envelope = refusal(repo, "rebase-plan", "main", ...args);
    assert.match(envelope.message + envelope.details, pattern, args.join(" "));
  }
});

// ---------------------------------------------------------------------------
// reword: identity preserved by construction
// ---------------------------------------------------------------------------

test("reword pauses, composes its own trailer, and keeps the identity", (t) => {
  const { repo, first } = fixture(t);
  const originalId = changeIdOf(repo, first.commit);

  const paused = run(repo, "rebase", "main", "--reword", first.commit, "--json");
  assert.notEqual(paused.status, 0);
  const envelope = JSON.parse(paused.stdout);
  assert.equal(envelope.code, "interactive-paused");

  const status = vlabJson(repo, "rebase", "--status");
  assert.equal(status.state, "awaiting-message");
  // The pause happens after the change is applied, so this is the tree the
  // replay produced — the thing a reword must leave alone. It is not the
  // original commit's tree: the change has been replayed onto the new base.
  const replayedTree = git(repo, "rev-parse", "HEAD^{tree}");

  // A message carrying its own trailer is refused rather than committed and
  // corrected: the commit is the thing a peer reads.
  const conflicting = run(
    repo, "rebase", "--continue", "-m", "new subject\n\nChange-Id: ch_somethingelse", "--json",
  );
  assert.notEqual(conflicting.status, 0);

  const result = vlabJson(repo, "rebase", "--continue", "-m", "feat: a clearer subject");
  assert.equal(result.receipt.schema, "vcs-lab.rebase/v3");

  const rewritten = git(repo, "rev-list", "main..HEAD").split(/\s+/).at(-1);
  assert.equal(trailerCount(repo, rewritten), 1, "exactly one identity survives");
  assert.equal(changeIdOf(repo, rewritten), originalId, "and it is the original");
  assert.match(git(repo, "log", "-1", "--format=%s", rewritten), /a clearer subject/);
  // A reword changes a message and nothing else.
  assert.equal(git(repo, "rev-parse", `${rewritten}^{tree}`), replayedTree);
  assert.deepEqual(result.receipt.amendments, []);
});

test("continuing a reword without a message says so", (t) => {
  const { repo, first } = fixture(t);
  assert.notEqual(run(repo, "rebase", "main", "--reword", first.commit, "--json").status, 0);
  const envelope = refusal(repo, "rebase", "--continue");
  assert.equal(envelope.code, "usage-missing-argument");
  assert.match(envelope.details, /--continue -m/);
});

// ---------------------------------------------------------------------------
// squash and fixup: one surviving identity, the rest in a record
// ---------------------------------------------------------------------------

test("fixup leaves one trailer on the commit and the absorbed identity in a record", (t) => {
  const { repo, first, second, third } = fixture(t);
  const survivorId = changeIdOf(repo, first.commit);
  const absorbedId = changeIdOf(repo, second.commit);

  const result = vlabJson(repo, "rebase", "main", "--fixup", `${second.commit}=${first.commit}`);
  const [absorption] = result.receipt.absorptions;

  assert.equal(absorption.action, "fixup");
  assert.equal(absorption.survivingChangeId, survivorId);
  assert.deepEqual(absorption.absorbedCommits, [second.commit]);
  assert.deepEqual(absorption.absorbedChanges, [absorbedId]);
  assert.ok(!absorption.absorbedChanges.includes(survivorId));

  // Three commits became two, and the survivor carries exactly one identity.
  const rewritten = git(repo, "rev-list", "main..HEAD").split(/\s+/);
  assert.equal(rewritten.length, 2);
  const survivor = rewritten.at(-1);
  assert.equal(trailerCount(repo, survivor), 1);
  assert.equal(changeIdOf(repo, survivor), survivorId);
  // `fixup` discards the absorbed prose.
  assert.doesNotMatch(git(repo, "log", "-1", "--format=%B", survivor), /^second$/m);
  // The absorbed content is there, inside the survivor.
  assert.ok(fs.existsSync(path.join(repo, "second.txt")));
  assert.ok(fs.existsSync(path.join(repo, "third.txt")));

  // Coverage for an absorbed change comes from the record, exactly as it does
  // from a landing, so the receipt still absorbs all three.
  assert.deepEqual(
    [...result.receipt.absorbedCommits].sort(),
    [first.commit, second.commit, third.commit].sort(),
  );
});

test("squash keeps the absorbed prose, still under one identity", (t) => {
  const { repo, first, second } = fixture(t);
  const survivorId = changeIdOf(repo, first.commit);
  const result = vlabJson(repo, "rebase", "main", "--squash", `${second.commit}=${first.commit}`);

  const survivor = git(repo, "rev-list", "main..HEAD").split(/\s+/).at(-1);
  const message = git(repo, "log", "-1", "--format=%B", survivor);
  assert.match(message, /^first$/m, "the surviving prose is kept");
  assert.match(message, /^second$/m, "and so is the absorbed prose");
  assert.equal(trailerCount(repo, survivor), 1, "but only one identity");
  assert.equal(changeIdOf(repo, survivor), survivorId);
  assert.equal(result.receipt.absorptions[0].action, "squash");
});

// ---------------------------------------------------------------------------
// edit: identity retained, divergence recorded
// ---------------------------------------------------------------------------

test("a forecast says it cannot predict an edit, and refuses to approve one", (t) => {
  const { repo, first } = fixture(t);
  const forecast = vlabJson(repo, "rebase-forecast", "main", "--edit", first.commit);

  assert.equal(forecast.status, "pauses-for-content");
  assert.equal(forecast.blockedReason, "interactive-edit-pauses");
  assert.equal(forecast.predictedResultTree, null);
  assert.equal(forecast.steps.at(-1).outcome, "pauses-for-content");

  const envelope = refusal(
    repo, "rebase", "main", "--edit", first.commit, "--use-forecast", forecast.id,
  );
  assert.equal(envelope.code, "operation-state-invalid");
  assert.match(envelope.details, /cannot predict/);
});

test("an edit that changes content keeps the identity and publishes an amendment", (t) => {
  const { repo, first } = fixture(t);
  const originalId = changeIdOf(repo, first.commit);

  assert.notEqual(run(repo, "rebase", "main", "--edit", first.commit, "--json").status, 0);
  assert.equal(vlabJson(repo, "rebase", "--status").state, "awaiting-content");

  write(repo, "first.txt", "first, edited\n");
  git(repo, "add", "-A");
  const result = vlabJson(repo, "rebase", "--continue");

  assert.equal(result.receipt.amendments.length, 1);
  const [amendment] = result.receipt.amendments;
  assert.equal(amendment.changeId, originalId, "the identity is retained, not forked");
  assert.equal(amendment.originCommit, first.commit);
  assert.notEqual(amendment.treeBefore, amendment.treeAfter);
  assert.equal(changeIdOf(repo, amendment.commit), originalId);
  assert.equal(trailerCount(repo, amendment.commit), 1);
});

test("an edit that changes nothing publishes no amendment", (t) => {
  const { repo, first } = fixture(t);
  assert.notEqual(run(repo, "rebase", "main", "--edit", first.commit, "--json").status, 0);
  // Continue without touching anything: nothing diverged, so there is nothing
  // to record and no conclusion to weaken.
  const result = vlabJson(repo, "rebase", "--continue");
  assert.deepEqual(result.receipt.amendments, []);
});

// ---------------------------------------------------------------------------
// The consequence that matters: ADR-0004's first narrowing
// ---------------------------------------------------------------------------

test("a reachable amendment degrades a bare Change-Id match, and nothing else", (t) => {
  const { repo, first } = fixture(t);
  const amendedId = changeIdOf(repo, first.commit);

  // The rewrite happens on `feature`; `main` then lands it, so the identity is
  // reachable from the target and the amendment travels with it.
  assert.notEqual(run(repo, "rebase", "main", "--edit", first.commit, "--json").status, 0);
  write(repo, "first.txt", "first, edited\n");
  git(repo, "add", "-A");
  vlabJson(repo, "rebase", "--continue");
  git(repo, "switch", "main");
  vlab(repo, "merge", "feature", "--compact");

  // A fresh branch whose commit carries the amended identity but different
  // content: the exact shape the bare-identity rule used to call `covered`.
  git(repo, "switch", "-c", "peer", git(repo, "rev-parse", "main~1"));
  write(repo, "first.txt", "a third version\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", `peer work\n\nChange-Id: ${amendedId}`);

  // Planned from `main`, which is the target: `merge-plan` classifies a source
  // against HEAD, and standing on the source would compare it with itself.
  git(repo, "switch", "main");
  const plan = vlabJson(repo, "merge-plan", "peer");
  const change = plan.changes.find((item) => item.changeId === amendedId);
  assert.ok(change, "the peer change is planned");
  assert.equal(change.status, "candidate-equivalent",
    "an amended identity is no longer exact evidence");
  assert.equal(change.proof, "amended-change-id");
  // It only ever weakens: the class it lands in is the one that already asks a
  // person, rather than a new one nobody reads.
  assert.ok(plan.counts["candidate-equivalent"] >= 1);
});

test("a commit-based proof survives an amendment untouched", (t) => {
  const { repo, first } = fixture(t);
  assert.notEqual(run(repo, "rebase", "main", "--edit", first.commit, "--json").status, 0);
  write(repo, "first.txt", "first, edited\n");
  git(repo, "add", "-A");
  vlabJson(repo, "rebase", "--continue");
  git(repo, "switch", "main");
  vlab(repo, "merge", "feature", "--compact");

  // Replanning the branch that was actually landed: every change is proved by
  // the receipt naming its commit, which an amendment does not touch, because
  // it does not reason from the name.
  const plan = vlabJson(repo, "merge-plan", "feature");
  assert.ok(
    plan.changes.every((change) => change.status === "covered"),
    `every landed change stays covered: ${JSON.stringify(plan.changes.map((c) => [c.shortCommit, c.status, c.proof]))}`,
  );
  assert.ok(
    plan.changes.every((change) => change.proof !== "amended-change-id"),
  );
});

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------

test("aborting from either pause restores the source exactly", (t) => {
  for (const [flag, label] of [["--reword", "reword"], ["--edit", "edit"]]) {
    const { repo, first } = fixture(t, `interactive-abort-${label}`);
    const originalHead = git(repo, "rev-parse", "HEAD");
    const originalTree = git(repo, "rev-parse", "HEAD^{tree}");

    assert.notEqual(run(repo, "rebase", "main", flag, first.commit, "--json").status, 0);
    const aborted = vlabJson(repo, "rebase", "--abort");

    assert.equal(aborted.aborted, true, label);
    assert.equal(git(repo, "rev-parse", "HEAD"), originalHead, label);
    assert.equal(git(repo, "rev-parse", "HEAD^{tree}"), originalTree, label);
    assert.equal(git(repo, "status", "--porcelain=v1"), "", label);
  }
});
