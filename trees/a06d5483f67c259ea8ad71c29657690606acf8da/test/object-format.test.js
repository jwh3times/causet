/**
 * vcs-lab reads and writes object identifiers everywhere: receipts name the
 * commit they attach to, proof bundles state a target head, lineage is derived
 * from root commits. Any of that could quietly assume a 40-character SHA-1.
 *
 * Git's SHA-256 object format makes every identifier 64 characters, so a
 * repository initialised with it is the cheapest available test of whether the
 * tool treats an object id as an opaque token or as a fixed-width string. It
 * also gives the proof bundle its sharpest adversarial case: a bundle from one
 * repository presented to a repository it has nothing to do with.
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

function exec(command, args, cwd) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    env: testEnv(),
  }).trim();
}

const git = (cwd, ...args) => exec("git", args, cwd);
const vlab = (cwd, ...args) => exec(process.execPath, [cli, ...args], cwd);

function write(repo, relative, content) {
  const target = path.join(repo, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

/**
 * A two-branch repository in the requested object format, ready to reconcile:
 * `feature` and `main` have each moved since diverging, touching different
 * files so the operation completes.
 */
function makeRepository(objectFormat) {
  const parent = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "vcs-lab-objfmt-")));
  created.push(parent);
  const repo = path.join(parent, "repo");
  fs.mkdirSync(repo);
  git(repo, "init", "-b", "main", `--object-format=${objectFormat}`);
  git(repo, "config", "core.autocrlf", "false");
  git(repo, "config", "core.eol", "lf");
  git(repo, "config", "user.name", "VCS Lab Object Format Test");
  git(repo, "config", "user.email", "vcs-lab-objfmt@example.invalid");
  write(repo, "a.txt", "base\n");
  git(repo, "add", "-A");
  vlab(repo, "commit", "-m", "base");
  vlab(repo, "init");
  git(repo, "switch", "-c", "feature");
  write(repo, "f.txt", "feature\n");
  git(repo, "add", "-A");
  vlab(repo, "commit", "-m", "feature one");
  git(repo, "switch", "main");
  write(repo, "m.txt", "main\n");
  git(repo, "add", "-A");
  vlab(repo, "commit", "-m", "main moves");
  return repo;
}

const supportsSha256 = (() => {
  const probe = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "vcs-lab-objfmt-probe-")));
  try {
    const attempt = spawnSync(
      "git",
      ["init", "-b", "main", "--object-format=sha256", probe],
      { encoding: "utf8", env: testEnv() },
    );
    return attempt.status === 0;
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }
})();

test("a SHA-256 repository reconciles and produces coherent records", { skip: !supportsSha256 }, () => {
  const repo = makeRepository("sha256");
  assert.equal(git(repo, "rev-parse", "--show-object-format"), "sha256");
  assert.equal(git(repo, "rev-parse", "HEAD").length, 64, "the fixture must really be SHA-256");

  const plan = JSON.parse(vlab(repo, "merge-plan", "feature", "--json"));
  assert.equal(plan.counts.new, 1);
  assert.equal(plan.sourceHead.length, 64, "the plan carries full-width object ids");

  vlab(repo, "reconcile", "feature", "--json");
  const receipts = JSON.parse(vlab(repo, "receipts", "--json"));
  assert.deepEqual(
    receipts.map((record) => record.type).sort(),
    ["application", "reconciliation"],
    "the operation publishes the same records it would under SHA-1",
  );
  for (const record of receipts) {
    assert.equal(record.attachedTo.length, 64, "records name full-width commits");
    // The record must actually resolve: a truncated or re-hashed id would
    // still be a plausible-looking string.
    assert.equal(git(repo, "rev-parse", `${record.attachedTo}^{commit}`), record.attachedTo);
  }

  // Coverage must now be recognised, which is the property that would break if
  // any comparison had normalised an id by width.
  const after = JSON.parse(vlab(repo, "merge-plan", "feature", "--json"));
  assert.equal(after.counts.new, 0, "the reconciled change is no longer new");
  assert.equal(after.counts.covered, 1);

  const audit = JSON.parse(vlab(repo, "audit", "identity", "--json"));
  assert.equal(audit.repository.objectFormat, "sha256");
  assert.equal(audit.summary.errors, 0, "a clean SHA-256 history raises no identity finding");
});

test("lineage identity is object-format specific and stated in the proof bundle", { skip: !supportsSha256 }, () => {
  const sha256Repo = makeRepository("sha256");
  const sha1Repo = makeRepository("sha1");

  const bundle256 = JSON.parse(vlab(sha256Repo, "proof-bundle", "feature"));
  const bundle1 = JSON.parse(vlab(sha1Repo, "proof-bundle", "feature"));

  assert.equal(bundle256.repository.lineage.objectFormat, "sha256");
  assert.equal(bundle1.repository.lineage.objectFormat, "sha1");
  assert.notEqual(
    bundle256.repository.lineage.id,
    bundle1.repository.lineage.id,
    "two repositories built from the same content must not share a lineage",
  );
  assert.match(bundle256.repository.lineage.algorithm, /sha256/);

  // Each bundle verifies fully against its own repository.
  for (const [repo, bundle] of [
    [sha256Repo, bundle256],
    [sha1Repo, bundle1],
  ]) {
    const file = path.join(repo, "..", "bundle.json");
    fs.writeFileSync(file, JSON.stringify(bundle));
    const verified = JSON.parse(vlab(repo, "verify-proof", file, "--json"));
    assert.equal(verified.integrity.intact, true);
    assert.equal(verified.classification.agrees, true);
    assert.equal(verified.repository.checked, true, "the bundle verifies against its own repository");
    assert.equal(verified.repository.matches, true);
  }
});

test("a proof bundle from another repository is rejected as such, not as a stale one", { skip: !supportsSha256 }, () => {
  // The failure this pins is a diagnostic one with real consequences. Before
  // the lineage check, a bundle about a completely different repository came
  // back as `target-moved` — advice to fetch and retry, for a bundle that will
  // never be about this repository. A verifier acting on the wrong reason
  // reaches the wrong conclusion about why it could not confirm the evidence.
  const foreign = makeRepository("sha256");
  const local = makeRepository("sha1");
  const file = path.join(local, "..", "foreign-bundle.json");
  fs.writeFileSync(file, vlab(foreign, "proof-bundle", "feature"));

  const verified = JSON.parse(vlab(local, "verify-proof", file, "--json"));

  // The bundle is internally sound: it was not tampered with, and its
  // classification still follows from its own evidence. That is precisely why
  // the repository check has to be the thing that catches it.
  assert.equal(verified.integrity.intact, true, "an unrelated bundle is still intact");
  assert.equal(verified.classification.agrees, true, "and still internally consistent");

  assert.equal(verified.repository.checked, false, "nothing is confirmed against this repository");
  assert.equal(verified.repository.matches, null);
  assert.equal(verified.repository.reason, "different-repository");
  assert.equal(verified.repository.claimedObjectFormat, "sha256");
  assert.equal(verified.repository.repositoryObjectFormat, "sha1");
  assert.notEqual(verified.repository.claimedLineage, verified.repository.repositoryLineage);

  // The human rendering must carry the same reason, because that is the form a
  // person actually reads before deciding whether to trust the bundle.
  const human = vlab(local, "verify-proof", file);
  assert.match(human, /different-repository/);
  assert.doesNotMatch(human, /target-moved/);
});
