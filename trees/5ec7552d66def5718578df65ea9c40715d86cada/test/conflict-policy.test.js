import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { testEnv } from "../test-support/git-environment.js";

const cli = fileURLToPath(new URL("../bin/vlab.js", import.meta.url));
const NOTES = "refs/notes/vcs-lab";

function exec(command, args, cwd, options = {}) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    env: testEnv(),
    ...options,
  }).trim();
}

const git = (cwd, ...args) => exec("git", args, cwd);

function vlabResult(cwd, ...args) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8",
    env: testEnv(),
  });
}

function vlab(cwd, ...args) {
  const result = vlabResult(cwd, ...args);
  assert.equal(result.status, 0, `${args.join(" ")}\n${result.stdout}${result.stderr}`);
  return result.stdout.trim();
}

function vlabJson(cwd, ...args) {
  return JSON.parse(vlab(cwd, ...args, "--json"));
}

function configure(repo) {
  git(repo, "config", "core.autocrlf", "false");
  git(repo, "config", "core.eol", "lf");
  git(repo, "config", "core.longpaths", "true");
  git(repo, "config", "user.name", "VCS Lab Conflict Policy Test");
  git(repo, "config", "user.email", "vcs-lab-conflict@example.invalid");
}

function write(repo, relative, content) {
  const target = path.join(repo, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

/**
 * A repository whose `main` has landed `feature` with a hard squash, so the
 * feature commit is outside `main`'s ancestry and the landing receipt on the
 * landing commit is the only thing that proves the feature's change is
 * covered. Re-planning `feature` against `main` therefore has to read the
 * receipt, which is what every case below disturbs.
 */
function landedRepository(t, name = "conflict") {
  const parent = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), `vcs-lab-${name}-`)),
  );
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const repo = path.join(parent, "repo");
  fs.mkdirSync(repo);
  git(repo, "init", "-b", "main");
  configure(repo);
  vlab(repo, "init");
  write(repo, "a.txt", "base\n");
  git(repo, "add", "-A");
  vlab(repo, "commit", "-m", "base");
  const base = git(repo, "rev-parse", "HEAD");

  git(repo, "switch", "-c", "feature");
  write(repo, "b.txt", "feature\n");
  git(repo, "add", "-A");
  vlab(repo, "commit", "-m", "feature change");
  git(repo, "switch", "main");
  const landing = vlabJson(repo, "hard-squash", "feature");
  return { parent, repo, base, landing };
}

/** The raw note container on `commit`, as vcs-lab wrote it. */
function readContainer(repo, commit) {
  return JSON.parse(git(repo, "notes", "--ref=vcs-lab", "show", commit));
}

function writeContainer(repo, commit, container) {
  exec("git", ["notes", "--ref=vcs-lab", "add", "-f", "-F", "-", commit], repo, {
    input: `${JSON.stringify(container, null, 2)}\n`,
  });
}

/** Replace one record of `commit`'s container, keeping its identifier. */
function alterRecord(repo, commit, id, change) {
  const container = readContainer(repo, commit);
  const records = container.records.map((record) =>
    record.id === id ? { ...record, ...change } : record,
  );
  assert.notDeepEqual(records, container.records, `no record '${id}' on ${commit}`);
  writeContainer(repo, commit, { ...container, records });
}

// ---------------------------------------------------------------------------
// Reduced evidence: a quarantined fact proves nothing and says so
// ---------------------------------------------------------------------------

test("a plan reports the reachable facts it had to exclude", (t) => {
  const { repo, landing } = landedRepository(t, "reduced");

  const clean = vlabJson(repo, "merge-plan", "feature");
  assert.deepEqual(clean.quarantinedFacts, [],
    "a plan with no excluded fact reports an empty list, not an absent member");
  assert.equal(clean.counts.covered, 1);
  assert.equal(clean.changes[0].proof, "receipt-commit");

  // The same identifier naming different content: both copies are quarantined,
  // the change loses its only proof, and the plan names what it lost.
  const container = readContainer(repo, landing.landingCommit);
  const receipt = container.records.find((record) => record.id === landing.id);
  writeContainer(repo, landing.landingCommit, {
    ...container,
    records: [...container.records, { ...receipt, sourceSubject: "altered copy" }],
  });

  const reduced = vlabJson(repo, "merge-plan", "feature");
  assert.deepEqual(reduced.quarantinedFacts, [landing.id],
    "the conflicted receipt is named as excluded evidence");
  assert.equal(reduced.counts.covered, 0,
    "a conflicted receipt proves no coverage");
  // Down the ADR-0004 lattice, never up: the squashed commit is still patch
  // equivalent, so what remains is the advisory heuristic, not a proof.
  assert.equal(reduced.changes[0].status, "candidate-equivalent");
  assert.equal(reduced.changes[0].proof, "git-patch-id-heuristic");

  // Nothing blocks: the plan is still produced and the command still succeeds.
  assert.match(vlab(repo, "merge-plan", "feature"), /quarantined/,
    "the human report names the reduced evidence too");
});

test("a forecast and the receipt it authorizes carry the same exclusions", (t) => {
  const { repo, base, landing } = landedRepository(t, "forecast");

  // A second, independent branch to reconcile, so the operation has work to do
  // while the landing receipt on main is quarantined.
  git(repo, "switch", "-c", "other", base);
  write(repo, "c.txt", "other\n");
  git(repo, "add", "-A");
  vlab(repo, "commit", "-m", "other change");
  git(repo, "switch", "main");

  const container = readContainer(repo, landing.landingCommit);
  const receipt = container.records.find((record) => record.id === landing.id);
  writeContainer(repo, landing.landingCommit, {
    ...container,
    records: [...container.records, { ...receipt, sourceSubject: "altered copy" }],
  });

  const forecast = vlabJson(repo, "forecast", "other");
  assert.deepEqual(forecast.quarantinedFacts, [landing.id],
    "a stored forecast records the evidence its plan could not use");
  assert.deepEqual(forecast.plan.quarantinedFacts, [landing.id]);

  const reconciled = vlabJson(repo, "reconcile", "other");
  assert.deepEqual(reconciled.receipt.quarantinedFacts, [landing.id],
    "the receipt published for the operation carries the same exclusions");
});

// ---------------------------------------------------------------------------
// Parking: a conflict never blocks and never overwrites
// ---------------------------------------------------------------------------

/**
 * Two clones that share a lineage, where the source's copy of the landing
 * receipt has been altered so an envelope carries the same identifier with
 * different content. This is the shape ADR-0030's evidence table calls "same
 * receipt id, different content, arriving from a peer".
 */
function divergedPair(t, name) {
  const fixture = landedRepository(t, name);
  const clone = path.join(fixture.parent, "clone");
  git(fixture.parent, "clone", "--no-local", "--quiet", fixture.repo, clone);
  configure(clone);
  git(clone, "fetch", "origin", `${NOTES}:${NOTES}`);
  git(clone, "fetch", "origin", "feature:feature");
  vlab(clone, "init");

  // The peer's copy of the receipt now says something different under the same
  // identifier. The clone keeps the original.
  alterRecord(fixture.repo, fixture.landing.landingCommit, fixture.landing.id, {
    sourceSubject: "a subject the peer never wrote",
  });
  const envelope = path.join(fixture.parent, "envelope");
  vlab(fixture.repo, "metadata", "export", envelope);
  return { ...fixture, clone, envelope };
}

test("the default import still refuses the whole envelope on one conflict", (t) => {
  const { clone, envelope, landing } = divergedPair(t, "refuse");
  const notesBefore = git(clone, "rev-parse", NOTES);

  const preview = vlabResult(clone, "metadata", "import", envelope, "--dry-run", "--json");
  assert.notEqual(preview.status, 0, "a conflict makes the envelope inapplicable");
  const report = JSON.parse(preview.stdout);
  assert.equal(report.mode, "refuse-conflicts");
  assert.equal(report.summary.conflicts, 1);
  assert.equal(report.summary.applicable, false);
  assert.equal(
    report.records.find((entry) => entry.id === landing.id).action,
    "conflict",
  );

  const applied = vlabResult(clone, "metadata", "import", envelope, "--apply", "--json");
  assert.notEqual(applied.status, 0);
  assert.equal(JSON.parse(applied.stdout).code, "conflict-blocked");
  assert.equal(git(clone, "rev-parse", NOTES), notesBefore,
    "a refused import moves no destination ref");
  assert.equal(git(clone, "for-each-ref", "refs/vcs-lab/quarantine"), "",
    "the refusing default parks nothing");
});

test("--park-conflicts applies the rest and parks the conflicting record", (t) => {
  const { clone, envelope, landing, repo } = divergedPair(t, "park");

  const result = vlabJson(clone, "metadata", "import", envelope, "--apply", "--park-conflicts");
  assert.equal(result.mode, "park-conflicts");
  assert.equal(result.summary.applicable, true, "one disputed record stops nothing");
  assert.equal(result.summary.parkRecords, 1);
  assert.equal(result.summary.conflicts, 0);
  assert.equal(result.parked.length, 1);
  assert.equal(result.parked[0].recordId, landing.id);

  // The parked ref names a blob holding the incoming record and where it came
  // from, inspectable with ordinary Git.
  const sourceLineage = result.repository.sourceLineage;
  const ref = `refs/vcs-lab/quarantine/${sourceLineage}/${landing.id}`;
  assert.equal(result.parked[0].ref, ref);
  assert.equal(git(clone, "cat-file", "-t", ref), "blob");
  const payload = JSON.parse(git(clone, "cat-file", "-p", ref));
  assert.equal(payload.schema, "vcs-lab.quarantined-record/v1");
  assert.equal(payload.recordId, landing.id);
  assert.equal(payload.sourceLineage, sourceLineage);
  assert.equal(payload.record.sourceSubject, "a subject the peer never wrote");
  assert.ok(payload.envelopeHash, "the payload names the envelope it arrived in");

  // The local note is byte-for-byte what it was: parking never overwrites.
  assert.equal(
    readContainer(clone, landing.landingCommit).records.find((r) => r.id === landing.id)
      .sourceSubject,
    readContainer(repo, landing.landingCommit).records.length > 0 ? "feature change" : null,
    "the local record keeps its own content",
  );

  // Both sides now contribute nothing, and every reader agrees.
  const status = JSON.parse(vlabResult(clone, "metadata", "status", "--json").stdout);
  assert.equal(status.scopes.sharedLocal.quarantine.refCount, 1);
  const parkedEntry = status.scopes.sharedLocal.quarantine.records[0];
  assert.equal(parkedEntry.recordId, landing.id);
  assert.equal(parkedEntry.readable, true);
  assert.equal(parkedEntry.localDigests.length, 1,
    "the parked record is listed beside the local copy it disputes");
  assert.notEqual(parkedEntry.digest, parkedEntry.localDigests[0]);
  assert.ok(
    status.diagnostics.some(
      (entry) => entry.code === "parked-record-conflict" && entry.subject === landing.id,
    ),
    "status reports the dispute against the local record",
  );

  assert.deepEqual(
    vlabJson(clone, "merge-plan", "feature").quarantinedFacts,
    [landing.id],
    "the planner excludes the local copy too, and says so",
  );

  // Excluded from export: a fact nobody may use is not handed on.
  const reExport = path.join(path.dirname(clone), "re-export");
  const exported = vlabJson(clone, "metadata", "export", reExport);
  assert.equal(exported.quarantinedRecords >= 1, true);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(reExport, "manifest.json"), "utf8"),
  );
  assert.equal(
    manifest.records.some((entry) => entry.id === landing.id),
    false,
    "a disputed record is not exported from either side",
  );
});

// ---------------------------------------------------------------------------
// Disposition: a person decides, once
// ---------------------------------------------------------------------------

test("keep-local returns the local record to service and remembers the rejection", (t) => {
  const { clone, envelope, landing } = divergedPair(t, "keep");
  const parked = vlabJson(clone, "metadata", "import", envelope, "--apply", "--park-conflicts");
  const rejectedDigest = parked.parked[0].digest;

  const disposed = vlabJson(
    clone, "metadata", "dispose", landing.id, "--keep-local",
    "--reason", "the peer altered a receipt we published",
  );
  assert.equal(disposed.schema, "vcs-lab.metadata-disposition/v1");
  assert.equal(disposed.disposition.schema, "vcs-lab.disposition/v1");
  assert.equal(disposed.disposition.outcome, "keep-local");
  assert.deepEqual(disposed.disposition.rejectedDigests, [rejectedDigest]);
  assert.equal(disposed.disposition.reason, "the peer altered a receipt we published");
  assert.equal(disposed.parkedRemoved, true);
  // Observed, not asserted by the command: the record is read back after the
  // decision, so a record still quarantined for an unrelated reason would report
  // inService false rather than claiming it returned to service.
  assert.equal(disposed.record.inService, true);
  assert.deepEqual(disposed.record.diagnostics, []);
  assert.equal(git(clone, "for-each-ref", "refs/vcs-lab/quarantine"), "",
    "disposing of the dispute removes the parked copy");

  // The local fact proves coverage again, with no code change in between.
  const plan = vlabJson(clone, "merge-plan", "feature");
  assert.deepEqual(plan.quarantinedFacts, []);
  assert.equal(plan.counts.covered, 1);
  assert.equal(plan.changes[0].proof, "receipt-commit");

  // The registry is shared-local and is listed by status.
  const registry = JSON.parse(
    fs.readFileSync(path.join(clone, ".git", "vcs-lab", "dispositions.json"), "utf8"),
  );
  assert.equal(registry.schema, "vcs-lab.dispositions/v1");
  assert.equal(registry.dispositions.length, 1);
  const status = vlabJson(clone, "metadata", "status");
  assert.equal(status.scopes.sharedLocal.dispositions.count, 1);
  assert.equal(status.scopes.sharedLocal.dispositions.dispositions[0].outcome, "keep-local");

  // The same disagreement arriving again is reported once, not parked twice.
  const again = vlabJson(clone, "metadata", "import", envelope, "--apply", "--park-conflicts");
  assert.equal(again.summary.disposedRecords, 1);
  assert.equal(again.summary.parkRecords, 0);
  assert.equal(
    again.records.find((entry) => entry.id === landing.id).action,
    "disposed",
  );
  assert.equal(git(clone, "for-each-ref", "refs/vcs-lab/quarantine"), "",
    "an already-disposed digest is not parked a second time");
  assert.equal(vlabJson(clone, "merge-plan", "feature").counts.covered, 1,
    "and the local fact stays in service");
});

test("replace-local rewrites the local record to the peer's content", (t) => {
  const { clone, envelope, landing } = divergedPair(t, "replace");
  const parked = vlabJson(clone, "metadata", "import", envelope, "--apply", "--park-conflicts");
  const localBefore = readContainer(clone, landing.landingCommit)
    .records.find((record) => record.id === landing.id);

  const disposed = vlabJson(clone, "metadata", "dispose", landing.id, "--replace-local");
  assert.equal(disposed.disposition.outcome, "replace-local");
  assert.equal(disposed.disposition.keptDigest, parked.parked[0].digest);
  assert.equal(disposed.parkedRemoved, true);

  const localAfter = readContainer(clone, landing.landingCommit)
    .records.find((record) => record.id === landing.id);
  assert.equal(localAfter.sourceSubject, "a subject the peer never wrote",
    "the local record now carries the peer's content");
  assert.notDeepEqual(localAfter, localBefore);
  assert.equal(
    readContainer(clone, landing.landingCommit).records.length,
    readContainer(clone, landing.landingCommit).records.length,
  );

  // In service again, and the digest that was replaced is recorded as rejected
  // so it is not re-applied by a later exchange.
  const plan = vlabJson(clone, "merge-plan", "feature");
  assert.deepEqual(plan.quarantinedFacts, []);
  assert.equal(plan.counts.covered, 1);
  assert.equal(disposed.disposition.rejectedDigests.length, 1);
});

test("a disposition is refused when nothing is parked under that identifier", (t) => {
  const { clone } = divergedPair(t, "absent");
  const refused = vlabResult(clone, "metadata", "dispose", "land_000000000000000000000", "--keep-local", "--json");
  assert.notEqual(refused.status, 0);
  assert.equal(JSON.parse(refused.stdout).code, "not-found");

  const ambiguous = vlabResult(clone, "metadata", "dispose", "land_000000000000000000000", "--keep-local", "--replace-local", "--json");
  assert.notEqual(ambiguous.status, 0);
  assert.equal(JSON.parse(ambiguous.stdout).code, "usage-conflicting-options");
});

// ---------------------------------------------------------------------------
// The rules the policy leaves alone
// ---------------------------------------------------------------------------

test("a second receipt of one family on one commit is not a conflict", (t) => {
  const { repo, base } = landedRepository(t, "rerun");
  git(repo, "switch", "-c", "again", base);
  write(repo, "d.txt", "again\n");
  git(repo, "add", "-A");
  vlab(repo, "commit", "-m", "again change");
  git(repo, "switch", "main");

  const first = vlabJson(repo, "reconcile", "again");
  const attachment = first.receipt.resultCommit;
  // Re-running with every change already covered legitimately attaches a
  // second reconciliation receipt to the same commit. The rule that would have
  // called that a conflict was dropped when the owner decided ADR-0030.
  const second = vlabJson(repo, "reconcile", "again");
  const records = readContainer(repo, attachment).records
    .filter((record) => record.type === "reconciliation");
  assert.equal(records.length >= 2, true,
    "the re-run attached a second receipt to the same commit");
  assert.notEqual(first.receipt.id, second.receipt.id);

  const status = vlabJson(repo, "metadata", "status");
  assert.equal(
    status.diagnostics.filter((entry) =>
      ["record-id-conflict", "parked-record-conflict"].includes(entry.code)).length,
    0,
    "two receipts of one family on one commit are independent facts",
  );
  assert.equal(status.summary.quarantinedPortableRecords, 0);
});

test("a resolution ref the destination points elsewhere is refused, not merged", (t) => {
  // A recorded resolution, so the envelope carries both a resolution record and
  // the retention ref that holds its result.
  const fixture = landedRepository(t, "resolution");
  const { repo, parent, base } = fixture;
  git(repo, "switch", "-c", "theirs", base);
  write(repo, "a.txt", "theirs\n");
  git(repo, "add", "-A");
  vlab(repo, "commit", "-m", "their change");
  git(repo, "switch", "-c", "ours", base);
  write(repo, "a.txt", "ours\n");
  git(repo, "add", "-A");
  vlab(repo, "commit", "-m", "our change");
  assert.notEqual(vlabResult(repo, "reconcile", "theirs").status, 0,
    "the fixture must pause on a conflict");
  write(repo, "a.txt", "resolved\n");
  git(repo, "add", "a.txt");
  vlab(repo, "reconcile", "--continue");

  const catalog = vlabJson(repo, "resolve", "list");
  assert.equal(catalog.length, 1);
  const resolutionRef = catalog[0].discoveredRef ?? catalog[0].ref;
  assert.ok(resolutionRef?.startsWith("refs/vcs-lab/resolutions/"), resolutionRef);

  const envelope = path.join(parent, "resolution-envelope");
  vlab(repo, "metadata", "export", envelope);

  // Point the local ref at a different commit while keeping its name. The
  // envelope now claims the same ref name with a different target, which is the
  // ref half of ADR-0030's resolution identity.
  const before = git(repo, "rev-parse", resolutionRef);
  git(repo, "update-ref", resolutionRef, git(repo, "rev-parse", "HEAD"));
  assert.notEqual(git(repo, "rev-parse", resolutionRef), before);

  // Without park mode the whole envelope is inapplicable, as it always was.
  const refused = vlabResult(repo, "metadata", "import", envelope, "--dry-run", "--json");
  assert.notEqual(refused.status, 0);
  const strict = JSON.parse(refused.stdout);
  assert.equal(strict.refs.find((entry) => entry.ref === resolutionRef).action, "conflict");
  assert.equal(strict.summary.applicable, false);

  // Park mode refuses the one ref and parks the records that name it, and the
  // rest of the exchange proceeds.
  const parked = vlabJson(repo, "metadata", "import", envelope, "--apply", "--park-conflicts");
  assert.equal(parked.summary.applicable, true, "one disputed ref refuses nothing else");
  assert.equal(parked.summary.refusedRefs, 1);
  assert.equal(parked.refs.find((entry) => entry.ref === resolutionRef).action, "refuse");
  assert.equal(
    git(repo, "rev-parse", resolutionRef),
    git(repo, "rev-parse", "HEAD"),
    "the destination ref is left exactly where it pointed",
  );
  assert.equal(
    parked.records.filter((entry) => entry.schema === "vcs-lab.resolution/v1")
      .every((entry) => entry.action === "park"),
    true,
    "the records that name the refused ref are parked with it",
  );
  assert.ok(parked.parked.length >= 1);
});
