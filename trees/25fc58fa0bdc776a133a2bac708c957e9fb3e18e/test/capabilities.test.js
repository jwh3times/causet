import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { RECORD_FAMILIES, RESOURCE_BOUNDS } from "../src/schemas.js";
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

function vlabJson(cwd, ...args) {
  return JSON.parse(vlab(cwd, ...args, "--json"));
}

function refusal(cwd, ...args) {
  const result = run(cwd, ...args, "--json");
  assert.notEqual(result.status, 0, `expected a refusal from: ${args.join(" ")}\n${result.stdout}`);
  return JSON.parse(result.stdout);
}

/** A bare temporary directory that is deliberately not a Git repository. */
function outsideRepository(t) {
  const parent = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), "vcs-lab-capabilities-")),
  );
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  return parent;
}

function repository(t, { objectFormat = "sha1" } = {}) {
  const parent = outsideRepository(t);
  const repo = path.join(parent, "repo");
  fs.mkdirSync(repo);
  git(repo, "init", "-b", "main", `--object-format=${objectFormat}`);
  git(repo, "config", "core.autocrlf", "false");
  git(repo, "config", "core.eol", "lf");
  git(repo, "config", "user.name", "VCS Lab Capabilities Test");
  git(repo, "config", "user.email", "vcs-lab-capabilities@example.invalid");
  fs.writeFileSync(path.join(repo, "a.txt"), "base\n");
  git(repo, "add", "-A");
  vlab(repo, "commit", "-m", "base");
  return { parent, repo };
}

/** Write a peer document beside the repository and return its path. */
function peerFile(parent, document, name = "peer.json") {
  const target = path.join(parent, name);
  fs.writeFileSync(target, `${JSON.stringify(document, null, 2)}\n`);
  return target;
}

/**
 * A peer document derived from this build's own, with one part changed. Every
 * negotiation case below is exactly one difference from "identical builds", so
 * what the report says can only be caused by that difference.
 */
function peerLike(own, mutate) {
  const copy = structuredClone(own);
  delete copy.integrity;
  mutate(copy);
  return copy;
}

function familyOf(report, family) {
  const entry = report.families.find((item) => item.family === family);
  assert.ok(entry, `the report has no '${family}' family`);
  return entry;
}

// ---------------------------------------------------------------------------
// The document is a projection, not a maintained list
// ---------------------------------------------------------------------------

test("the document states what the registries hold, and nothing about local state", (t) => {
  const parent = outsideRepository(t);
  const document = vlabJson(parent, "capabilities");

  assert.equal(document.schema, "vcs-lab.capabilities/v1");
  assert.equal(document.producer.name, "causal-vcs-lab");
  assert.match(document.producer.version, /^\d+\.\d+\.\d+/);

  // Exactly the exchanged families: every record that crosses a repository
  // boundary, and nothing that does not. A peer never receives a journal, a
  // forecast, a workspace registry, or a tracked manifest.
  const advertised = document.families.map((entry) => entry.family).sort();
  const expected = [...RECORD_FAMILIES]
    .filter(([, policy]) =>
      ["note-container", "note-record", "envelope", "advertisement"].includes(policy.scope))
    .map(([family]) => family)
    .sort();
  assert.deepEqual(advertised, expected);
  for (const scope of ["private", "shared-local", "tracked"]) {
    assert.equal(
      document.families.some((entry) => entry.scope === scope),
      false,
      `${scope} families are never advertised`,
    );
  }

  // The capability family advertises itself, or a client cannot ask for a
  // version this build writes.
  const own = familyOf(document, "vcs-lab.capabilities");
  assert.deepEqual(own.written, [1]);
  assert.equal(own.scope, "advertisement");

  // Every advertised family matches its registry entry field for field.
  for (const entry of document.families) {
    const policy = RECORD_FAMILIES.get(entry.family);
    assert.ok(policy, `${entry.family} is advertised but not registered`);
    assert.equal(entry.scope, policy.scope);
    assert.equal(entry.unknownVersion, policy.unknownVersion);
    assert.deepEqual(entry.written, [...policy.written].sort((a, b) => a - b));
    assert.deepEqual(entry.readable, [...policy.readable].sort((a, b) => a - b));
  }

  // A multi-version family is advertised as such, which is why filtering is
  // per record rather than per family.
  const application = familyOf(document, "vcs-lab.application");
  assert.deepEqual(application.written, [1, 4]);

  assert.equal(document.profiles.canonicalJson, "vcs-lab.canonical-json/v1");
  assert.equal(document.profiles.logicalId, "vcs-lab.logical-id/v1");
  assert.equal(document.profiles.errorEnvelope, "vcs-lab.error/v1");
  assert.equal(document.algorithms.lineage, "git-root-commits-sha256/v1");
  assert.equal(document.algorithms.resolutionSignature, "ordered-three-way-blobs/v1");
  assert.equal(document.algorithms.integrity, "sha256");
  assert.deepEqual(document.objectFormats, ["sha1", "sha256"]);
  assert.ok(document.features.includes("causal-notes/v1"));
  assert.deepEqual([...document.features].sort(), document.features,
    "feature tokens are sorted, so two builds produce comparable documents");

  // Bounds are advertised for the exchanged families only, and every bound is
  // either advertised or deliberately not.
  for (const [name, value] of Object.entries(document.bounds)) {
    assert.equal(value, RESOURCE_BOUNDS[name], `bound '${name}'`);
  }
  assert.ok(document.bounds.noteContainerBytes > 0);
  assert.ok(document.bounds.capabilityDocumentBytes > 0);
  assert.equal(document.bounds.localStateBytes, undefined,
    "a bound on worktree-private state is not a peer's business");

  assert.equal(document.integrity.algorithm, "sha256");
  assert.match(document.integrity.documentHash, /^[0-9a-f]{64}$/);

  // Build-scoped outside a repository: there is no repository to describe.
  assert.equal(document.repository, undefined);
});

test("inside a repository the document is repository-scoped and changes nothing", (t) => {
  const { repo } = repository(t);
  const before = git(repo, "config", "--local", "--list");
  const runtimeDir = path.join(repo, ".git", "vcs-lab");
  fs.rmSync(runtimeDir, { recursive: true, force: true });

  const document = vlabJson(repo, "capabilities");
  assert.equal(document.repository.objectFormat, "sha1");
  assert.match(document.repository.lineage.id, /^lineage_[0-9a-f]{64}$/);
  assert.equal(document.repository.lineage.algorithm, "git-root-commits-sha256/v1");
  assert.equal(document.repository.lineage.rootCommits.length, 1);

  // It must not call initLab: a command that advertises what a build can do has
  // no business writing repository configuration or runtime state.
  assert.equal(git(repo, "config", "--local", "--list"), before,
    "advertising capabilities writes no Git configuration");
  assert.equal(fs.existsSync(runtimeDir), false,
    "advertising capabilities creates no runtime directory");
  assert.equal(git(repo, "status", "--porcelain"), "");

  // The human rendering presents the same state.
  const text = vlab(repo, "capabilities");
  assert.match(text, /vcs-lab\.capabilities\/v1/);
  assert.match(text, /families/);
  assert.match(text, new RegExp(document.repository.lineage.id.slice(0, 12)));
});

// ---------------------------------------------------------------------------
// Negotiation is a pure function of two documents
// ---------------------------------------------------------------------------

test("two identical builds can exchange everything", (t) => {
  const { repo, parent } = repository(t);
  const own = vlabJson(repo, "capabilities");
  const report = vlabJson(repo, "capabilities", "--against", peerFile(parent, own));

  assert.equal(report.schema, "vcs-lab.capability-report/v1");
  assert.equal(report.peer.source, "document");
  assert.equal(report.summary.exchangeable, true);
  assert.deepEqual(report.summary.blockers, []);
  assert.equal(report.summary.reducedFamilies, 0);
  assert.equal(report.summary.blockedFamilies, 0);
  for (const entry of report.families) {
    assert.equal(entry.status, "compatible", entry.family);
    assert.deepEqual(entry.unreadableByPeer, []);
  }
  assert.equal(report.repository.lineageRelation, "same");
  assert.deepEqual(report.features.localOnly, []);
  assert.deepEqual(report.features.peerOnly, []);
  for (const entry of report.profiles) assert.equal(entry.agreed, true);
  for (const entry of report.algorithms) assert.equal(entry.agreed, true);
});

test("a peer that cannot read a version we write reduces the exchange, and says which", (t) => {
  const { repo, parent } = repository(t);
  const own = vlabJson(repo, "capabilities");
  // The peer is an older build that never learned reconciliation v6.
  const peer = peerLike(own, (copy) => {
    const entry = copy.families.find((item) => item.family === "vcs-lab.reconciliation");
    entry.written = [];
    entry.readable = [];
  });
  const result = run(repo, "capabilities", "--against", peerFile(parent, peer), "--json");
  assert.notEqual(result.status, 0, "a reduced exchange is reported as not fully compatible");
  const report = JSON.parse(result.stdout);

  const reconciliation = familyOf(report, "vcs-lab.reconciliation");
  assert.equal(reconciliation.status, "blocked");
  assert.deepEqual(reconciliation.unreadableByPeer, [6]);
  assert.equal(reconciliation.selectedForSend, null);
  // The sender learns before transfer what the receiver would report after it.
  assert.equal(reconciliation.peerDisposition, "quarantine");

  // Nothing else is affected: the rest of the exchange still proceeds, which is
  // the point of filtering per record rather than refusing the exchange.
  assert.equal(familyOf(report, "vcs-lab.landing").status, "compatible");
  assert.equal(report.summary.blockedFamilies, 1);
  assert.equal(report.summary.exchangeable, true,
    "one family a peer cannot read does not make the exchange impossible");
});

test("a peer reading only an older version of a multi-version family is reduced, not blocked", (t) => {
  const { repo, parent } = repository(t);
  const own = vlabJson(repo, "capabilities");
  // `vcs-lab.application` writes v1 and v4; this peer reads only v1.
  const peer = peerLike(own, (copy) => {
    const entry = copy.families.find((item) => item.family === "vcs-lab.application");
    entry.written = [1];
    entry.readable = [1];
  });
  const report = JSON.parse(
    run(repo, "capabilities", "--against", peerFile(parent, peer), "--json").stdout,
  );
  const application = familyOf(report, "vcs-lab.application");
  assert.equal(application.status, "reduced");
  assert.deepEqual(application.unreadableByPeer, [4]);
  assert.equal(application.selectedForSend, 1,
    "a freshly produced document picks the highest version both sides admit");
  assert.equal(report.summary.reducedFamilies, 1);
  assert.equal(report.summary.exchangeable, true);
});

test("a profile or algorithm mismatch refuses the exchange with no-common-version", (t) => {
  const { repo, parent } = repository(t);
  const own = vlabJson(repo, "capabilities");

  const profile = peerLike(own, (copy) => {
    copy.profiles.canonicalJson = "vcs-lab.canonical-json/v2";
  });
  const first = refusal(repo, "capabilities", "--against", peerFile(parent, profile, "profile.json"));
  assert.equal(first.code, "no-common-version");
  assert.match(first.message, /canonicalJson/);

  const algorithm = peerLike(own, (copy) => {
    copy.algorithms.lineage = "git-root-commits-sha512/v1";
  });
  const second = refusal(repo, "capabilities", "--against", peerFile(parent, algorithm, "algorithm.json"));
  assert.equal(second.code, "no-common-version");
  assert.match(second.message, /lineage/);
});

test("a peer that reads no capability version we write refuses before any report", (t) => {
  const { repo, parent } = repository(t);
  const own = vlabJson(repo, "capabilities");
  const peer = peerLike(own, (copy) => {
    const entry = copy.families.find((item) => item.family === "vcs-lab.capabilities");
    entry.written = [2];
    entry.readable = [2];
  });
  const envelope = refusal(repo, "capabilities", "--against", peerFile(parent, peer));
  assert.equal(envelope.code, "no-common-version");
  assert.match(envelope.message, /vcs-lab\.capabilities/);
});

test("a different object format or an unrelated lineage is a repository mismatch", (t) => {
  const { repo, parent } = repository(t);
  const own = vlabJson(repo, "capabilities");

  const format = peerLike(own, (copy) => {
    copy.repository.objectFormat = "sha256";
    copy.repository.lineage.objectFormat = "sha256";
  });
  const first = refusal(repo, "capabilities", "--against", peerFile(parent, format, "format.json"));
  assert.equal(first.code, "repository-mismatch");

  const unrelated = peerLike(own, (copy) => {
    copy.repository.lineage.rootCommits = ["0".repeat(40)];
    copy.repository.lineage.id = `lineage_${"0".repeat(64)}`;
  });
  const second = refusal(repo, "capabilities", "--against", peerFile(parent, unrelated, "unrelated.json"));
  assert.equal(second.code, "repository-mismatch");
  assert.match(second.message, /unrelated/);
});

test("a build-scoped peer document compares everything except the repository", (t) => {
  const { repo, parent } = repository(t);
  const own = vlabJson(repo, "capabilities");
  const peer = peerLike(own, (copy) => {
    delete copy.repository;
  });
  const report = vlabJson(repo, "capabilities", "--against", peerFile(parent, peer));
  assert.equal(report.repository, null,
    "a repository comparison needs both sides to be repository-scoped");
  assert.equal(report.summary.exchangeable, true);
  assert.equal(report.families.every((entry) => entry.status === "compatible"), true);
});

test("an unknown feature token is ignored rather than refused", (t) => {
  const { repo, parent } = repository(t);
  const own = vlabJson(repo, "capabilities");
  const peer = peerLike(own, (copy) => {
    copy.features = [...copy.features, "something-we-have-never-heard-of/v3"].sort();
  });
  const report = vlabJson(repo, "capabilities", "--against", peerFile(parent, peer));
  assert.deepEqual(report.features.peerOnly, ["something-we-have-never-heard-of/v3"]);
  assert.equal(report.summary.exchangeable, true,
    "a token a reader does not know is opaque, not a failure");
});

// ---------------------------------------------------------------------------
// Against an envelope, which states less
// ---------------------------------------------------------------------------

test("an envelope states its repository and features, and the report says what it did not state", (t) => {
  const { repo, parent } = repository(t);
  const envelopeDir = path.join(parent, "envelope");
  vlab(repo, "metadata", "export", envelopeDir);

  const report = vlabJson(repo, "capabilities", "--against", envelopeDir);
  assert.equal(report.peer.source, "envelope");
  assert.equal(report.peer.producer.name, "causal-vcs-lab");
  assert.equal(report.repository.lineageRelation, "same");
  assert.deepEqual(report.features.peerOnly, []);
  assert.deepEqual(report.features.localOnly, []);

  // An envelope manifest carries no family, profile, algorithm, or bound, so the
  // report must say those were not stated rather than that the peer cannot read
  // them.
  assert.equal(report.peer.statedFamilies, false);
  for (const entry of report.families) {
    assert.equal(entry.status, "peer-not-stated", entry.family);
    assert.equal(entry.selectedForSend, null);
  }
  assert.equal(report.summary.blockedFamilies, 0);
  assert.equal(report.summary.exchangeable, true);
  assert.match(vlab(repo, "capabilities", "--against", envelopeDir), /not stated/);
});

// ---------------------------------------------------------------------------
// The document governs itself
// ---------------------------------------------------------------------------

test("a capability document this build cannot read is refused, not guessed at", (t) => {
  const { repo, parent } = repository(t);
  const own = vlabJson(repo, "capabilities");

  const future = peerLike(own, (copy) => {
    copy.schema = "vcs-lab.capabilities/v2";
  });
  const version = refusal(repo, "capabilities", "--against", peerFile(parent, future, "future.json"));
  assert.equal(version.code, "unknown-schema-version");
  assert.match(version.message, /vcs-lab\.capabilities\/v2/);

  const foreign = peerLike(own, (copy) => {
    copy.schema = "vcs-lab.metadata-envelope/v1";
  });
  const family = refusal(repo, "capabilities", "--against", peerFile(parent, foreign, "foreign.json"));
  assert.equal(family.code, "wrong-record-family");

  const malformed = path.join(parent, "malformed.json");
  fs.writeFileSync(malformed, "{ not json\n");
  assert.equal(refusal(repo, "capabilities", "--against", malformed).code, "malformed-input");

  const oversize = path.join(parent, "oversize.json");
  fs.writeFileSync(oversize, `${JSON.stringify({
    ...own,
    filler: "x".repeat(RESOURCE_BOUNDS.capabilityDocumentBytes),
  })}\n`);
  assert.equal(
    refusal(repo, "capabilities", "--against", oversize).code,
    "resource-bound-exceeded",
    "the bound is checked before the document is parsed",
  );

  assert.equal(
    refusal(repo, "capabilities", "--against", path.join(parent, "absent.json")).code,
    "not-found",
  );
});
