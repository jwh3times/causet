/**
 * Authorship provenance (FR-ID-08, FR-TRUST-04).
 *
 * The requirement exists because Git records authorship at commit granularity
 * and reconstructs line attribution heuristically, so attribution degrades
 * through exactly the operations this tool performs: cherry-pick, causal
 * rebase, reconciliation, and squash landing. The tests that matter here are
 * the ones that follow a declaration through a rewrite and then check that
 * stock Git has lost what vcs-lab kept.
 *
 * The second half of the requirement is a discipline rather than a feature:
 * provenance is *declared, never inferred*. A test asserts that a commit
 * carrying an ordinary `Co-Authored-By` trailer produces no provenance record,
 * because reading that trailer as a role would be a guess wearing the costume
 * of a reading.
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { testEnv } from "../test-support/git-environment.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(projectRoot, "bin", "vlab.js");

const created = [];
after(() => {
  for (const directory of created) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function exec(command, args, cwd, env = {}) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    env: testEnv({ ...env }),
  }).trim();
}

const git = (cwd, ...args) => exec("git", args, cwd);
const vlab = (cwd, ...args) => exec(process.execPath, [cli, ...args], cwd);
const vlabEnv = (cwd, env, ...args) => exec(process.execPath, [cli, ...args], cwd, env);

function vlabResult(cwd, args, env = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8",
    env: testEnv({ ...env }),
  });
}

function write(repo, relative, content) {
  const target = path.join(repo, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function makeRepo() {
  const parent = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "vcs-lab-prov-")));
  created.push(parent);
  const repo = path.join(parent, "repo");
  fs.mkdirSync(repo);
  git(repo, "init", "-b", "main");
  git(repo, "config", "core.autocrlf", "false");
  git(repo, "config", "core.eol", "lf");
  git(repo, "config", "user.name", "VCS Lab Provenance Test");
  git(repo, "config", "user.email", "vcs-lab-prov@example.invalid");
  write(repo, "a.txt", "base\n");
  git(repo, "add", "-A");
  vlab(repo, "commit", "-m", "base");
  vlab(repo, "init");
  return repo;
}

/** Every provenance entry `vlab provenance` reports for a revision. */
function provenance(repo, revision = "HEAD", ...flags) {
  return JSON.parse(vlab(repo, "provenance", revision, ...flags, "--json")).entries;
}

const actorsOf = (entry) => entry.actors.map((actor) => `${actor.role}:${actor.actor}`).sort();

test("a declaration is recorded, and silence stays silence", () => {
  const repo = makeRepo();

  // Nothing declared: no record. An empty record would turn "nobody said"
  // into a claim, which is the one thing this must never do.
  write(repo, "quiet.txt", "quiet\n");
  git(repo, "add", "-A");
  vlab(repo, "commit", "-m", "undeclared");
  assert.deepEqual(provenance(repo), [], "an undeclared commit carries no record");

  write(repo, "loud.txt", "loud\n");
  git(repo, "add", "-A");
  vlab(
    repo, "commit", "-m", "declared",
    "--generated-by", "claude-opus-5",
    "--reviewed-by", "Jerry Holland",
  );
  const [entry] = provenance(repo);
  assert.equal(entry.origin, "declared");
  assert.deepEqual(entry.carriedFrom, [], "a declaration has no sources");
  assert.deepEqual(actorsOf(entry), ["generated:claude-opus-5", "reviewed:Jerry Holland"]);
  assert.equal(entry.commit, git(repo, "rev-parse", "HEAD"));
});

test("the agent environment variable declares, and merges with explicit flags", () => {
  // This is the capture mechanism the requirement turns on: an agent harness
  // sets one variable and every commit it makes is attributed, without the
  // agent having to remember a flag on each one.
  const repo = makeRepo();
  write(repo, "f.txt", "one\n");
  git(repo, "add", "-A");
  vlabEnv(
    repo, { VLAB_AGENT: "claude-opus-5" },
    "commit", "-m", "agent work",
    // The same actor named twice, once by flag and once by environment, is one
    // actor; a human reviewing the agent's work is a second.
    "--generated-by", "claude-opus-5",
    "--reviewed-by", "Jerry Holland",
  );
  const [entry] = provenance(repo);
  assert.deepEqual(
    actorsOf(entry),
    ["generated:claude-opus-5", "reviewed:Jerry Holland"],
    "the duplicate collapses and both roles survive",
  );
});

test("provenance is declared, never inferred", () => {
  // FR-TRUST-04. `Co-Authored-By` is the trailer the ecosystem already uses for
  // agent attribution, and reading it as a `generated` role would be the
  // single most tempting inference available. vcs-lab does not make it: a
  // co-author is not necessarily a machine, and guessing which is exactly the
  // claim the requirement forbids.
  const repo = makeRepo();
  write(repo, "f.txt", "one\n");
  git(repo, "add", "-A");
  git(
    repo, "commit", "-m",
    "trailered work\n\nChange-Id: ch_000000000000000000000\n" +
    "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>",
  );
  assert.deepEqual(
    provenance(repo),
    [],
    "an ecosystem trailer is not a provenance declaration",
  );

  const human = vlab(repo, "provenance");
  assert.match(human, /declared, never inferred/, "the rendering says so plainly");

  // Nor does it fall back to the Git author: "who committed this" and "who
  // produced this" are different claims.
  assert.doesNotMatch(human, /VCS Lab Provenance Test/);
});

test("a declared role outside the closed vocabulary is refused", () => {
  const repo = makeRepo();
  write(repo, "f.txt", "one\n");
  git(repo, "add", "-A");
  // The flag itself is unknown, so it parses as a boolean and declares nothing
  // rather than inventing a role.
  vlab(repo, "commit", "-m", "one", "--assisted-by", "somebody");
  assert.deepEqual(provenance(repo), [], "an unknown role flag declares nothing");

  // An empty actor is refused rather than recorded as an anonymous claim.
  write(repo, "g.txt", "two\n");
  git(repo, "add", "-A");
  const empty = vlabResult(repo, ["commit", "-m", "two", "--generated-by", ""]);
  assert.notEqual(empty.status, 0, "an empty actor name is refused");
  assert.match(empty.stderr, /^vlab: /m, "the refusal is a domain diagnostic");
});

test("provenance survives a hard squash, which is where Git loses it", () => {
  // The headline case. A hard squash collapses many commits into one, and from
  // that point Git attributes every absorbed line to the landing commit. The
  // landing receipt already names the absorbed commits, so the declared
  // provenance carries onto the landing as the union of their actors.
  const repo = makeRepo();
  git(repo, "switch", "-c", "feature");
  write(repo, "f.txt", "one\n");
  git(repo, "add", "-A");
  vlabEnv(repo, { VLAB_AGENT: "claude-opus-5" }, "commit", "-m", "feature one");
  write(repo, "g.txt", "two\n");
  git(repo, "add", "-A");
  vlabEnv(
    repo, { VLAB_AGENT: "claude-opus-5" },
    "commit", "-m", "feature two", "--reviewed-by", "Jerry Holland",
  );
  const absorbed = [
    git(repo, "rev-parse", "feature~1"),
    git(repo, "rev-parse", "feature"),
  ].sort();

  git(repo, "switch", "main");
  const receipt = JSON.parse(vlab(repo, "hard-squash", "feature", "--json"));
  const landing = receipt.landingCommit;

  const [entry] = provenance(repo);
  assert.equal(entry.commit, landing, "the carried record is on the landing commit");
  assert.equal(entry.origin, "carried", "it is never presented as a fresh declaration");
  assert.deepEqual(entry.carriedFrom, absorbed, "it names the commits it came from");
  assert.deepEqual(
    actorsOf(entry),
    ["generated:claude-opus-5", "reviewed:Jerry Holland"],
    "the union of the absorbed commits' actors survives the squash",
  );

  // And the comparison that gives the test its point: Git alone cannot answer
  // the question after the squash. The landing commit's author is the person
  // who ran the landing, and blame attributes the absorbed content to it.
  assert.equal(git(repo, "log", "-1", "--format=%an", landing), "VCS Lab Provenance Test");
  const blamed = git(repo, "blame", "--line-porcelain", "g.txt");
  assert.match(blamed, /^author VCS Lab Provenance Test$/m);
  assert.doesNotMatch(blamed, /claude-opus-5/, "Git has no record of who produced it");

  // The receipt itself stays exactly a landing document: the carried record is
  // its own note record, not a member smuggled into another family's schema.
  assert.equal(receipt.schema, "vcs-lab.landing/v1");
  assert.equal(receipt.provenance, undefined);
});

test("provenance carries through a cherry-pick to the applied commit", () => {
  const repo = makeRepo();
  git(repo, "switch", "-c", "donor");
  write(repo, "d.txt", "donor\n");
  git(repo, "add", "-A");
  vlabEnv(repo, { VLAB_AGENT: "agent-7" }, "commit", "-m", "donor work");
  const origin = git(repo, "rev-parse", "HEAD");

  git(repo, "switch", "-c", "taker", "main");
  vlab(repo, "cherry-pick", origin, "--json");

  const [entry] = provenance(repo);
  assert.equal(entry.origin, "carried");
  assert.deepEqual(entry.carriedFrom, [origin]);
  assert.deepEqual(actorsOf(entry), ["generated:agent-7"]);
  assert.notEqual(entry.commit, origin, "the record is on the new commit, not the old one");
});

test("provenance carries through a reconciliation and a causal rebase", () => {
  for (const operation of ["reconcile", "rebase"]) {
    const repo = makeRepo();
    git(repo, "switch", "-c", "feature");
    write(repo, "f.txt", "feature\n");
    git(repo, "add", "-A");
    vlabEnv(repo, { VLAB_AGENT: "agent-9" }, "commit", "-m", "feature one");
    const origin = git(repo, "rev-parse", "feature");
    git(repo, "switch", "main");
    write(repo, "m.txt", "main\n");
    git(repo, "add", "-A");
    vlab(repo, "commit", "-m", "main moves");

    if (operation === "reconcile") {
      vlab(repo, "reconcile", "feature", "--json");
    } else {
      git(repo, "switch", "feature");
      vlab(repo, "rebase", "main", "--json");
    }

    // The applied commit is a different commit from the origin, and it is the
    // one that carries the claim forward.
    const carried = provenance(repo, "HEAD", "--all").filter(
      (entry) => entry.origin === "carried",
    );
    assert.equal(carried.length, 1, `${operation}: exactly one carried record`);
    assert.deepEqual(carried[0].carriedFrom, [origin], `${operation}: names its origin`);
    assert.deepEqual(actorsOf(carried[0]), ["generated:agent-9"]);
    assert.notEqual(
      carried[0].commit,
      origin,
      `${operation}: the rewrite produced a new commit and the claim followed it`,
    );
  }
});

test("a carried record is a valid note record and passes strict metadata validation", () => {
  // The record has to be a first-class member of the note contract, not a
  // convenient blob: unknown-version handling, resource bounds, and the
  // strict validator all have to accept it (ADR-0020).
  const repo = makeRepo();
  git(repo, "switch", "-c", "feature");
  write(repo, "f.txt", "one\n");
  git(repo, "add", "-A");
  vlabEnv(repo, { VLAB_AGENT: "claude-opus-5" }, "commit", "-m", "feature one");
  git(repo, "switch", "main");
  vlab(repo, "hard-squash", "feature", "--json");

  const validation = JSON.parse(vlab(repo, "metadata", "validate", "--strict", "--json"));
  assert.equal(validation.summary.valid, true, "the provenance record validates strictly");
  assert.equal(validation.summary.errors, 0);
  assert.equal(
    validation.summary.quarantinedPortableRecords,
    0,
    "it is accepted by the note contract rather than quarantined",
  );
  assert.equal(
    validation.scopes.sharedPortable.notes.bySchema["vcs-lab.provenance/v1"],
    2,
    "the validator counts both the declaration and the record carried onto the landing",
  );

  const records = JSON.parse(vlab(repo, "receipts", "--json"));
  const provenanceRecords = records.filter(
    (record) => record.schema === "vcs-lab.provenance/v1",
  );
  assert.deepEqual(
    provenanceRecords.map((record) => record.origin).sort(),
    ["carried", "declared"],
    "both records appear in the receipt catalog, and each says which it is",
  );
  assert.ok(provenanceRecords.every((record) => record.type === "provenance"));
});

test("carrying provenance does not scale the notes ref reads with the queue", () => {
  // ADR-0013's rule: a path must not launch one Git process per entity. The
  // first version of this feature read the notes ref once per application to
  // discover whether there was anything to carry, which cost one extra process
  // per change — about 30 ms each on Windows — even in a repository where no
  // provenance had ever been declared. The read is now done once for the whole
  // queue.
  //
  // Measured as growth rather than as an absolute count, so the test pins the
  // shape of the cost rather than a number that legitimately moves. Each extra
  // application costs exactly four notes processes: the read-modify-write of
  // its own application record, and the same for the provenance record carried
  // onto it. A fifth means the notes ref is being listed once per application
  // again instead of once for the queue.
  //
  // Provenance must actually be declared for this to discriminate. With none in
  // the repository the batched path returns before the loop, so batched and
  // unbatched cost the same and the test would pass either way. Verified by
  // mutation: reading per application gives five, not four.
  const notesProcesses = (changes) => {
    const repo = makeRepo();
    git(repo, "switch", "-c", "feature");
    for (let index = 1; index <= changes; index += 1) {
      write(repo, `f${index}.txt`, `feature ${index}\n`);
      git(repo, "add", "-A");
      vlabEnv(repo, { VLAB_AGENT: "agent-x" }, "commit", "-m", `feature ${index}`);
    }
    git(repo, "switch", "main");
    write(repo, "m.txt", "main\n");
    git(repo, "add", "-A");
    vlab(repo, "commit", "-m", "main moves");

    const run = vlabResult(repo, ["reconcile", "feature", "--json"], { VLAB_TRACE: "1" });
    assert.equal(run.status, 0, "the fixture must reconcile cleanly");
    return run.stderr.split("\n").filter((line) => line.includes("git notes")).length;
  };

  const small = notesProcesses(2);
  const large = notesProcesses(6);
  assert.equal(
    (large - small) / 4,
    4,
    `${small} notes processes for 2 changes and ${large} for 6: each extra ` +
      "application must cost four, not five. A fifth means the provenance read " +
      "is per application again instead of once for the queue.",
  );
});
