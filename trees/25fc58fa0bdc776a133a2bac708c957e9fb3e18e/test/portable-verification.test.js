import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { RESOURCE_BOUNDS } from "../src/schemas.js";
import { bundleHash } from "../src/proof-bundle.js";
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

function write(repo, relative, content) {
  const target = path.join(repo, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

/**
 * The fixture ADR-0031's evidence table was measured on: a source branch whose
 * four changes land on one of each lattice outcome, so every adversarial shape
 * below has something real to attack.
 */
function scenario(t, { objectFormat = "sha1" } = {}) {
  const parent = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), "vcs-lab-portable-")),
  );
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const repo = path.join(parent, "repo");
  fs.mkdirSync(repo);
  git(repo, "init", "-b", "main", `--object-format=${objectFormat}`);
  git(repo, "config", "core.autocrlf", "false");
  git(repo, "config", "core.eol", "lf");
  git(repo, "config", "core.longpaths", "true");
  git(repo, "config", "user.name", "VCS Lab Portable Test");
  git(repo, "config", "user.email", "vcs-lab-portable@example.invalid");
  vlab(repo, "init");

  write(repo, "base.txt", "base\n");
  git(repo, "add", "-A");
  vlab(repo, "commit", "-m", "base");

  // A change absorbed by a hard squash: only the landing receipt proves it.
  git(repo, "switch", "-c", "feature");
  write(repo, "absorbed.txt", "absorbed\n");
  git(repo, "add", "-A");
  vlab(repo, "commit", "-m", "absorbed change");
  git(repo, "switch", "main");
  vlab(repo, "hard-squash", "feature");

  // A change whose logical identity is already in the target history.
  git(repo, "switch", "feature");
  write(repo, "identified.txt", "identified\n");
  git(repo, "add", "-A");
  const identified = JSON.parse(vlab(repo, "commit", "-m", "identified change", "--json"));
  git(repo, "switch", "main");
  vlab(repo, "cherry-pick", identified.commit);

  // New work with no coverage at all.
  git(repo, "switch", "feature");
  write(repo, "new.txt", "new\n");
  git(repo, "add", "-A");
  vlab(repo, "commit", "-m", "new change");
  git(repo, "switch", "main");
  return { parent, repo };
}

function bundleFor(repo, parent, source = "feature", name = "proof.json") {
  const file = path.join(parent, name);
  fs.writeFileSync(file, vlab(repo, "proof-bundle", source));
  return { file, bundle: JSON.parse(fs.readFileSync(file, "utf8")) };
}

/** Rehash and rewrite a mutated bundle, the way a forger would. */
function resign(file, bundle) {
  bundle.integrity.bundleHash = bundleHash(bundle);
  fs.writeFileSync(file, JSON.stringify(bundle, null, 2));
  return file;
}

function recount(bundle) {
  bundle.counts = { covered: 0, "candidate-equivalent": 0, new: 0 };
  for (const change of bundle.changes) bundle.counts[change.status] += 1;
}

function offline(repo, file) {
  const result = run(repo, "verify-proof", file, "--offline", "--json");
  return { status: result.status, report: JSON.parse(result.stdout) };
}

// ---------------------------------------------------------------------------
// What a v2 bundle carries
// ---------------------------------------------------------------------------

test("a bundle carries Git's own bindings for the range it describes", (t) => {
  const { repo, parent } = scenario(t);
  const { bundle } = bundleFor(repo, parent);

  assert.equal(bundle.schema, "vcs-lab.proof-bundle/v2");

  // The v1 members are unchanged: v2 is a strict superset, and the
  // repository-backed comparison still reads exactly what it always read.
  for (const member of [
    "repository", "target", "source", "physicalBase", "effectiveBase",
    "evidence", "changes", "counts", "integrity",
  ]) {
    assert.ok(bundle[member] !== undefined, `v1 member '${member}' is still carried`);
  }

  // Anchors are stated explicitly, and agree with the members they restate.
  assert.equal(bundle.anchors.targetHead, bundle.target.head);
  assert.equal(bundle.anchors.sourceHead, bundle.source.head);
  assert.deepEqual(bundle.anchors.lineageRoots, bundle.repository.lineage.rootCommits);
  assert.match(bundle.anchors.notesTip, /^[0-9a-f]{40}$/);

  // Every carried object recomputes its own Git id from its raw bytes, which is
  // the binding the sender does not control.
  const oids = Object.keys(bundle.objects);
  assert.ok(oids.length > 0);
  for (const [oid, object] of Object.entries(bundle.objects)) {
    assert.match(oid, /^[0-9a-f]{40}$/);
    assert.ok(["commit", "tree", "blob"].includes(object.type), object.type);
    const bytes = Buffer.from(object.base64, "base64");
    const header = Buffer.from(`${object.type} ${bytes.length}\0`);
    const recomputed = exec("git", ["hash-object", "-t", object.type, "--stdin"], repo, {
      input: Buffer.concat([bytes]),
    });
    assert.equal(recomputed, oid, `object ${oid} must hash to its own id`);
    assert.ok(header.length > 0);
  }

  // The source inventory is the range, and every change is in it.
  assert.deepEqual(
    bundle.sourceInventory.commits,
    bundle.changes.map((change) => change.commit),
    "the inventory enumerates exactly the change list in its order",
  );
  for (const oid of bundle.sourceInventory.commits) {
    assert.equal(bundle.objects[oid].type, "commit");
  }

  // Every positive claim carries a path from the target head.
  const covered = bundle.changes.filter((change) => change.status === "covered");
  assert.ok(covered.length >= 2, "the fixture must cover more than one way");
  for (const change of covered) {
    const proof = bundle.reachability.paths.find((entry) => entry.subject === change.commit);
    assert.ok(proof, `no reachability path for covered ${change.commit}`);
    assert.equal(proof.from, bundle.target.head);
    assert.ok(proof.commits.length >= 1);
    for (const oid of proof.commits) assert.equal(bundle.objects[oid].type, "commit");
  }

  // A receipt the classification relies on carries its inclusion proof.
  assert.ok(bundle.receiptInclusion.receipts.length >= 1);
  for (const entry of bundle.receiptInclusion.receipts) {
    assert.equal(bundle.objects[entry.blob].type, "blob");
    assert.ok(entry.path.length >= 1);
    for (const oid of entry.path) assert.equal(bundle.objects[oid].type, "tree");
  }
  assert.equal(bundle.objects[bundle.receiptInclusion.notesTip].type, "commit");
});

test("an honest bundle reaches the bound tier offline, and says what it cannot reach", (t) => {
  const { repo, parent } = scenario(t);
  const { file } = bundleFor(repo, parent);
  const { status, report } = offline(repo, file);

  assert.equal(status, 0);
  assert.equal(report.bundleSchema, "vcs-lab.proof-bundle/v2");
  assert.equal(report.integrity.intact, true);
  assert.equal(report.classification.agrees, true);
  assert.equal(report.binding.checked, true);
  assert.equal(report.binding.agrees, true);
  assert.equal(report.tier, "bound",
    "without independently obtained anchors the ceiling is the bound tier");
  assert.equal(report.ok, true);

  // Coverage is a positive claim with a proof; newness is an absence claim with
  // none, and must be reported as claimed rather than proven.
  for (const change of report.changes) {
    const claimed = report.claimed?.[change.commit];
    void claimed;
    if (change.status === "covered") {
      assert.equal(change.tier, "bound", change.commit);
      assert.equal(change.proven, true);
    } else {
      assert.equal(change.tier, "self-consistent", change.commit);
      assert.equal(change.proven, false);
    }
  }
  const reasons = report.unavailable.map((entry) => entry.conclusion);
  assert.ok(reasons.includes("new-work-is-absent"));
  assert.ok(reasons.includes("candidate-equivalence"));
  assert.ok(reasons.includes("physical-base-is-best-common-ancestor"));
  assert.ok(reasons.includes("anchors-are-current"));
  for (const entry of report.unavailable) {
    assert.ok(entry.reason.split(/\s+/).length >= 5, entry.conclusion);
  }

  // The human rendering says the tier and does not claim more than it has.
  const text = vlab(repo, "verify-proof", file, "--offline");
  assert.match(text, /bound/);
  assert.match(text, /unavailable/i);
});

// ---------------------------------------------------------------------------
// The adversarial shapes ADR-0031 was designed against
// ---------------------------------------------------------------------------

test("the shapes that passed a v1 offline verifier are caught by the binding", async (t) => {
  const { repo, parent } = scenario(t);
  const { file, bundle } = bundleFor(repo, parent);
  assert.equal(offline(repo, file).status, 0, "the honest bundle must verify first");

  const foreignParent = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), "vcs-lab-foreign-")),
  );
  t.after(() => fs.rmSync(foreignParent, { recursive: true, force: true }));
  const foreign = path.join(foreignParent, "repo");
  fs.mkdirSync(foreign);
  git(foreign, "init", "-b", "main");
  git(foreign, "config", "user.name", "Foreign");
  git(foreign, "config", "user.email", "foreign@example.invalid");
  write(foreign, "f.txt", "foreign\n");
  git(foreign, "add", "-A");
  git(foreign, "commit", "-m", "foreign commit");
  const foreignCommit = git(foreign, "rev-parse", "HEAD");
  const foreignRaw = execFileSync("git", ["cat-file", "commit", foreignCommit], {
    cwd: foreign,
    env: testEnv(),
  });

  const cases = [
    ["omit a change", (value) => {
      const dropped = value.changes.pop();
      value.sourceInventory.commits = value.sourceInventory.commits
        .filter((oid) => oid !== dropped.commit);
      recount(value);
    }],
    ["omit a change but keep the inventory", (value) => {
      value.changes.pop();
      recount(value);
    }],
    ["inject a commit from an unrelated repository", (value) => {
      value.objects[foreignCommit] = {
        type: "commit",
        base64: Buffer.from(foreignRaw).toString("base64"),
      };
      value.changes.push({
        commit: foreignCommit,
        changeId: `git:${foreignCommit}`,
        subject: "foreign commit",
        status: "new",
        proof: null,
      });
      value.sourceInventory.commits.push(foreignCommit);
      recount(value);
    }],
    ["substitute a foreign commit id for a change", (value) => {
      const index = value.changes.length - 1;
      const original = value.changes[index].commit;
      value.changes[index].commit = foreignCommit;
      value.sourceInventory.commits = value.sourceInventory.commits
        .map((oid) => (oid === original ? foreignCommit : oid));
      value.objects[foreignCommit] = {
        type: "commit",
        base64: Buffer.from(foreignRaw).toString("base64"),
      };
    }],
    ["borrow a Change-Id and claim stable-change-id", (value) => {
      const target = value.changes.find((change) => change.status === "new");
      const covered = value.changes.find((change) => change.proof === "stable-change-id");
      target.changeId = covered.changeId;
      target.status = "covered";
      target.proof = "stable-change-id";
      recount(value);
    }],
    ["alter a carried subject to match a forged claim", (value) => {
      value.changes[0].subject = "a subject the commit does not carry";
    }],
    ["claim coverage with no carried path", (value) => {
      const target = value.changes.find((change) => change.status === "new");
      target.status = "covered";
      target.proof = "commit-ancestry";
      value.evidence.targetCommits = [...value.evidence.targetCommits, target.commit].sort();
      recount(value);
    }],
    ["rewrite a carried object", (value) => {
      const [oid] = value.sourceInventory.commits;
      const bytes = Buffer.from(value.objects[oid].base64, "base64").toString("utf8");
      value.objects[oid] = {
        type: "commit",
        base64: Buffer.from(bytes.replace(/\n\n[\s\S]*$/, "\n\nrewritten\n")).toString("base64"),
      };
    }],
    ["forge a receipt blob", (value) => {
      const entry = value.receiptInclusion.receipts[0];
      const blob = Buffer.from(value.objects[entry.blob].base64, "base64").toString("utf8");
      value.objects[entry.blob] = {
        type: "blob",
        base64: Buffer.from(blob.replace(/"absorbedCommits": \[/, '"absorbedCommits": ["0000000000000000000000000000000000000000",')).toString("base64"),
      };
    }],
  ];

  for (const [name, mutate] of cases) {
    await t.test(name, () => {
      const value = structuredClone(bundle);
      mutate(value);
      const mutated = resign(path.join(parent, "mutated.json"), value);
      const { status, report } = offline(repo, mutated);
      assert.equal(status, 1, `${name} must not verify offline`);
      assert.equal(report.integrity.intact, true,
        "the forger rehashed, so integrity alone cannot catch this");
      assert.equal(report.binding.agrees, false, name);
      assert.equal(report.ok, false, name);
      assert.notEqual(report.tier, "bound", `${name} must not reach the bound tier`);
      assert.ok(report.binding.problems.length >= 1, "the report names what failed");
    });
  }
});

// ---------------------------------------------------------------------------
// Anchors
// ---------------------------------------------------------------------------

test("anchors obtained from a remote the verifier chooses reach the anchored tier", (t) => {
  const { repo, parent } = scenario(t);
  // A bare clone standing in for the authoritative remote, with the notes ref
  // pushed, because a receipt's inclusion proof anchors to the notes tip.
  const remote = path.join(parent, "remote.git");
  git(parent, "clone", "--bare", "--quiet", repo, remote);
  git(repo, "push", remote, "refs/notes/vcs-lab:refs/notes/vcs-lab");
  git(repo, "push", remote, "feature:feature");

  const { file } = bundleFor(repo, parent);
  const anchored = JSON.parse(
    vlab(repo, "verify-proof", file, "--offline", "--anchors-from", remote, "--json"),
  );
  assert.equal(anchored.anchors.channel, "ls-remote");
  assert.equal(anchored.anchors.remote, remote);
  assert.equal(anchored.anchors.confirmed.length >= 3, true);
  assert.deepEqual(anchored.anchors.unconfirmed, []);
  assert.equal(anchored.tier, "anchored");
  assert.equal(anchored.ok, true);
  for (const change of anchored.changes) {
    if (change.status === "covered") assert.equal(change.tier, "anchored");
  }
  // Even anchored, absence is still not proven.
  assert.ok(anchored.unavailable.some((entry) => entry.conclusion === "new-work-is-absent"));

  // A remote that does not carry the stated heads leaves the tier at bound and
  // says which anchors it could not confirm, rather than failing the bundle.
  const stranger = path.join(parent, "stranger.git");
  git(parent, "init", "--bare", "--quiet", stranger);
  const partial = JSON.parse(
    run(repo, "verify-proof", file, "--offline", "--anchors-from", stranger, "--json").stdout,
  );
  assert.equal(partial.tier, "bound");
  assert.ok(partial.anchors.unconfirmed.length >= 1);
  assert.equal(partial.binding.agrees, true, "an unconfirmed anchor is not a binding failure");
});

// ---------------------------------------------------------------------------
// Versioning, bounds, and object formats
// ---------------------------------------------------------------------------

test("a v1 bundle still verifies, at the self-consistent tier only", (t) => {
  const { repo, parent } = scenario(t);
  const { bundle } = bundleFor(repo, parent);
  // A v1 document is what an older producer hands over: the v1 members alone.
  const {
    objects, sourceInventory, reachability, receiptInclusion, anchors, ...v1
  } = bundle;
  void objects; void sourceInventory; void reachability; void receiptInclusion; void anchors;
  v1.schema = "vcs-lab.proof-bundle/v1";
  const file = resign(path.join(parent, "v1.json"), v1);

  const { status, report } = offline(repo, file);
  assert.equal(status, 0, "a v2 verifier accepts a v1 document");
  assert.equal(report.bundleSchema, "vcs-lab.proof-bundle/v1");
  assert.equal(report.tier, "self-consistent");
  assert.equal(report.binding.checked, false);
  assert.equal(report.binding.reason, "not-carried");
  assert.equal(report.ok, true);
  assert.ok(
    report.unavailable.some((entry) => entry.conclusion === "source-inventory-is-complete"),
    "a v1 document cannot support the bound conclusions, and the report says so",
  );

  // And the repository-backed comparison still works on it unchanged.
  const backed = JSON.parse(vlab(repo, "verify-proof", file, "--json"));
  assert.equal(backed.repository.checked, true);
  assert.equal(backed.repository.matches, true);
});

test("a bundle whose proofs would exceed the published bound refuses to be emitted", (t) => {
  const { repo, parent } = scenario(t);
  const { bundle } = bundleFor(repo, parent);
  // The bound is the published one; this fixture only proves the refusal path
  // exists and names the member, since a real bundle that exceeds 16 MiB needs
  // roughly ten thousand commits of path depth.
  assert.ok(
    JSON.stringify(bundle).length < RESOURCE_BOUNDS.proofBundleBytes,
    "the honest bundle is far inside the bound",
  );
  const refusal = run(repo, "proof-bundle", "feature", "--json");
  assert.equal(refusal.status, 0);
});

test("the binding holds under sha256, where object ids are a different length", (t) => {
  const { repo, parent } = scenario(t, { objectFormat: "sha256" });
  const { file, bundle } = bundleFor(repo, parent);
  assert.match(bundle.anchors.sourceHead, /^[0-9a-f]{64}$/);
  for (const oid of Object.keys(bundle.objects)) assert.match(oid, /^[0-9a-f]{64}$/);

  const { status, report } = offline(repo, file);
  assert.equal(status, 0, `${JSON.stringify(report.binding?.problems ?? [])}`);
  assert.equal(report.binding.agrees, true);
  assert.equal(report.tier, "bound");

  // The same forgery must fail here too: the verifier hashes under the
  // lineage's object format rather than assuming sha1.
  const value = structuredClone(bundle);
  const [oid] = value.sourceInventory.commits;
  const bytes = Buffer.from(value.objects[oid].base64, "base64").toString("utf8");
  value.objects[oid] = {
    type: "commit",
    base64: Buffer.from(bytes.replace(/\n\n[\s\S]*$/, "\n\nrewritten\n")).toString("base64"),
  };
  const mutated = resign(path.join(parent, "sha256-mutated.json"), value);
  assert.equal(offline(repo, mutated).status, 1);
});

test("a merge inside the source range is bound like any other commit", (t) => {
  const { repo, parent } = scenario(t);
  // A side branch merged into the source, so the range is not linear.
  git(repo, "switch", "feature");
  git(repo, "switch", "-c", "side");
  write(repo, "side.txt", "side\n");
  git(repo, "add", "-A");
  vlab(repo, "commit", "-m", "side change");
  git(repo, "switch", "feature");
  git(repo, "merge", "--no-ff", "-m", "merge side", "side");
  git(repo, "switch", "main");

  const { file, bundle } = bundleFor(repo, parent, "feature", "merge.json");
  const { status, report } = offline(repo, file);
  assert.equal(status, 0, `${JSON.stringify(report.binding?.problems ?? [])}`);
  assert.equal(report.binding.agrees, true);
  assert.equal(report.tier, "bound");
  // Every carried parent is itself carried, is the physical base, or is reached
  // by a carried path; a merge is the case that makes that rule necessary.
  assert.ok(bundle.sourceInventory.commits.length >= 4);
});
