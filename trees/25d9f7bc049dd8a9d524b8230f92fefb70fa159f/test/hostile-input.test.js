import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { RESOURCE_BOUNDS } from "../src/schemas.js";
import { testEnv } from "../test-support/git-environment.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(projectRoot, "bin", "vlab.js");

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

function exec(command, args, cwd, options = {}) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    env: testEnv(),
    ...options,
  }).trim();
}

const git = (cwd, ...args) => exec("git", args, cwd);
const vlab = (cwd, ...args) => exec(process.execPath, [cli, ...args], cwd);

function vlabResult(cwd, ...args) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8",
    env: testEnv(),
  });
}

function write(repo, relative, content) {
  const target = path.join(repo, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

let scenarioState = null;
let scenarioParent = null;
after(() => {
  if (scenarioParent) fs.rmSync(scenarioParent, { recursive: true, force: true });
});

/**
 * One disposable repository with a published landing receipt, an indexed
 * specification, and an exported metadata envelope, so every hostile input
 * below has real state to be hostile towards.
 */
function scenario() {
  if (scenarioState) return scenarioState;
  const parent = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "vcs-lab-hostile-")));
  scenarioParent = parent;
  const repo = path.join(parent, "repo");
  fs.mkdirSync(repo);
  git(repo, "init", "-b", "main");
  git(repo, "config", "core.autocrlf", "false");
  git(repo, "config", "core.eol", "lf");
  git(repo, "config", "user.name", "VCS Lab Hostile Input Test");
  git(repo, "config", "user.email", "vcs-lab-hostile@example.invalid");
  write(repo, "a.txt", "base\n");
  git(repo, "add", "-A");
  vlab(repo, "commit", "-m", "base");
  vlab(repo, "init");
  write(repo, "spec.md", "# Spec\n\nPreamble.\n\nREQ-H-01: Hostile input fails closed.\n");
  vlab(repo, "spec", "index", "spec.md", "--json");
  git(repo, "add", "-A");
  vlab(repo, "commit", "-m", "spec");

  git(repo, "switch", "-c", "feature");
  write(repo, "f.txt", "feature\n");
  git(repo, "add", "-A");
  vlab(repo, "commit", "-m", "feature");
  git(repo, "switch", "main");
  vlab(repo, "hard-squash", "feature", "-m", "land feature");

  const envelope = path.join(parent, "envelope");
  vlab(repo, "metadata", "export", envelope, "--json");

  scenarioState = { repo, parent, envelope };
  return scenarioState;
}

// ---------------------------------------------------------------------------
// The property every hostile input must satisfy
// ---------------------------------------------------------------------------

function refSnapshot(repo) {
  return git(repo, "for-each-ref", "--format=%(refname) %(objectname)");
}

/**
 * A JS runtime error that escapes to the boundary is printed as
 * `vlab: <message>` exactly like a domain error, so it is not enough to check
 * the exit code. These fragments are what a leaked TypeError or ReferenceError
 * reads like, and none of them should ever reach a user.
 */
const RUNTIME_ERROR_FRAGMENTS = [
  "Cannot read properties",
  "is not a function",
  "is not defined",
  "undefined is not",
  "null is not",
  "Assignment to constant",
  "Maximum call stack",
  "Converting circular structure",
];

/**
 * Every hostile input must be refused the same way: a non-zero exit, a domain
 * diagnostic rather than a leaked runtime error, and no ref moved. The last is
 * the horizon's exit criterion — malformed input must not leave an unsafe ref
 * behind.
 */
function assertRefusedCleanly(repo, label, args, expected) {
  const before = refSnapshot(repo);
  const result = vlabResult(repo, ...args);
  const output = `${result.stdout}${result.stderr}`;
  assert.notEqual(result.status, 0, `${label}: expected a non-zero exit`);
  assert.match(result.stderr, /^vlab: /m, `${label}: expected a vlab diagnostic`);
  for (const fragment of RUNTIME_ERROR_FRAGMENTS) {
    assert.ok(
      !output.includes(fragment),
      `${label}: leaked a runtime error rather than a domain diagnostic (${fragment})`,
    );
  }
  if (expected) {
    assert.match(result.stderr, expected, `${label}: unexpected diagnostic`);
  }
  assert.equal(refSnapshot(repo), before, `${label}: refs moved despite the refusal`);
  return result;
}

/** Restore the note ref to its pre-tampering state. */
function withTamperedNote(repo, body, run) {
  const target = git(repo, "rev-parse", "HEAD");
  const notesBefore = git(repo, "rev-parse", "refs/notes/vcs-lab");
  execFileSync("git", ["notes", "--ref=vcs-lab", "add", "-f", "-F", "-", target], {
    cwd: repo,
    input: body,
    encoding: "utf8",
    env: testEnv(),
  });
  try {
    run();
  } finally {
    git(repo, "update-ref", "refs/notes/vcs-lab", notesBefore);
  }
}

/** A copy of the exported envelope with `mutate` applied to its manifest. */
function tamperedEnvelope(state, name, mutate) {
  const target = path.join(state.parent, name);
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(state.envelope, target, { recursive: true });
  const manifestPath = path.join(target, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const mutated = mutate(manifest) ?? manifest;
  fs.writeFileSync(manifestPath, `${JSON.stringify(mutated, null, 2)}\n`);
  return target;
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

test("malformed causal notes are quarantined without moving a ref", () => {
  const state = scenario();
  const { repo } = state;

  // Text that is not JSON at all is preserved as an opaque legacy record
  // rather than consumed, so validation reports it and nothing is destroyed.
  withTamperedNote(repo, "this is not json at all\n", () => {
    const before = refSnapshot(repo);
    const result = vlabResult(repo, "metadata", "validate", "--json");
    assert.notEqual(result.status, 0, "an unparsable note fails validation");
    const report = JSON.parse(result.stdout);
    assert.ok(
      report.diagnostics.some((item) => item.code === "malformed-record"),
      "an unparsable note is reported as a malformed record",
    );
    assert.equal(refSnapshot(repo), before, "validation moves no ref");
  });

  // A bare array is valid JSON but not a versioned container.
  withTamperedNote(repo, `${JSON.stringify([{ schema: "vcs-lab.landing/v1" }])}\n`, () => {
    const result = vlabResult(repo, "metadata", "validate", "--json");
    assert.notEqual(result.status, 0);
    const report = JSON.parse(result.stdout);
    assert.ok(report.diagnostics.some((item) => item.code === "malformed-record"));
  });

  // A container whose record is missing required fields is quarantined, not
  // consumed: it must not reach the coverage planner.
  const incomplete = {
    schema: "vcs-lab.note/v1",
    records: [{ schema: "vcs-lab.landing/v1", type: "landing", id: "land_incomplete0000000" }],
  };
  withTamperedNote(repo, `${JSON.stringify(incomplete, null, 2)}\n`, () => {
    const result = vlabResult(repo, "metadata", "validate", "--json");
    assert.notEqual(result.status, 0);
    const report = JSON.parse(result.stdout);
    assert.ok(
      report.diagnostics.some((item) => item.code === "malformed-record"),
      "an incomplete record is malformed, not accepted",
    );
    assert.equal(
      report.summary.acceptedPortableRecords,
      0,
      "a malformed record is never accepted",
    );
  });

  // A container from a future build yields no records and is left intact, so a
  // peer's data survives contact with this one.
  const future = { schema: "vcs-lab.note/v2", records: [{ type: "landing", id: "x" }] };
  withTamperedNote(repo, `${JSON.stringify(future, null, 2)}\n`, () => {
    const report = JSON.parse(vlabResult(repo, "metadata", "validate", "--json").stdout);
    assert.ok(
      report.diagnostics.some((item) => item.code === "unknown-schema"),
      "a future container version is reported rather than consumed",
    );
    assert.deepEqual(JSON.parse(vlab(repo, "receipts", "--json")), [], "no records are yielded");
  });
});

// ---------------------------------------------------------------------------
// Envelopes
// ---------------------------------------------------------------------------

test("hostile metadata envelopes are refused before any ref moves", () => {
  const state = scenario();
  const { repo } = state;

  assertRefusedCleanly(
    repo,
    "missing envelope",
    ["metadata", "import", path.join(state.parent, "no-such-envelope"), "--dry-run"],
    /Metadata envelope not found/,
  );

  const notJson = tamperedEnvelope(state, "env-not-json", () => ({}));
  fs.writeFileSync(path.join(notJson, "manifest.json"), "definitely not json\n");
  assertRefusedCleanly(
    repo,
    "manifest is not JSON",
    ["metadata", "import", notJson, "--dry-run"],
    /manifest is not valid JSON/,
  );

  const futureSchema = tamperedEnvelope(state, "env-future", (manifest) => {
    manifest.schema = "vcs-lab.metadata-envelope/v99";
  });
  assertRefusedCleanly(
    repo,
    "future envelope schema",
    ["metadata", "import", futureSchema, "--dry-run"],
    /Unsupported metadata envelope schema/,
  );

  // The integrity hash covers the record inventory, so both altering a digest
  // and dropping an entry are caught rather than silently importing less.
  const tamperedDigest = tamperedEnvelope(state, "env-digest", (manifest) => {
    assert.ok(manifest.records.length > 0, "the fixture must export a record to tamper with");
    manifest.records[0].digest = "0".repeat(64);
  });
  assertRefusedCleanly(
    repo,
    "record digest altered",
    ["metadata", "import", tamperedDigest, "--dry-run"],
    /integrity check failed/,
  );

  const droppedRecord = tamperedEnvelope(state, "env-dropped", (manifest) => {
    manifest.records.pop();
  });
  assertRefusedCleanly(
    repo,
    "record dropped from inventory",
    ["metadata", "import", droppedRecord, "--dry-run"],
    /integrity check failed/,
  );

  // A ref name that climbs out of the namespace must never reach git.
  const escapingRef = tamperedEnvelope(state, "env-ref", (manifest) => {
    manifest.refs = [{
      ref: "refs/../../evil",
      bundleRef: "refs/vcs-lab/import/evil",
      oid: "0".repeat(40),
    }];
  });
  assertRefusedCleanly(
    repo,
    "ref name traversal",
    ["metadata", "import", escapingRef, "--dry-run"],
    /invalid or unsupported ref entry/,
  );

  const absurdPayload = tamperedEnvelope(state, "env-payload", (manifest) => {
    if (manifest.payload) manifest.payload.bytes = Number.MAX_SAFE_INTEGER;
  });
  const payloadResult = vlabResult(repo, "metadata", "import", absurdPayload, "--dry-run");
  assert.notEqual(payloadResult.status, 0, "an absurd payload declaration is refused");
});

// ---------------------------------------------------------------------------
// Tracked manifests, identifiers, and object expressions
// ---------------------------------------------------------------------------

test("hostile manifests, identifiers, and object expressions fail closed", () => {
  const state = scenario();
  const { repo } = state;
  const manifestPath = path.join(repo, ".vcs-lab", "specs", "spec.md.json");
  const original = fs.readFileSync(manifestPath, "utf8");

  try {
    fs.writeFileSync(manifestPath, "not json\n");
    assertRefusedCleanly(
      repo,
      "spec manifest is not JSON",
      ["spec", "show", "spec.md"],
      /is not valid JSON/,
    );

    // Only the schema is changed, so the source hash still matches and the
    // version refusal is reached rather than being masked by a staleness
    // check. Getting this wrong reports "stale" for an unreadable version.
    const manifest = JSON.parse(original);
    manifest.schema = "vcs-lab.spec-manifest/v99";
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    assertRefusedCleanly(
      repo,
      "spec manifest from a future build",
      ["spec", "show", "spec.md"],
      /Unsupported specification manifest/,
    );
  } finally {
    fs.writeFileSync(manifestPath, original);
  }

  // Identifiers that index a file on disk must not escape their directory.
  for (const id of ["../../etc/passwd", "..", "forecast_../../x", "a/b"]) {
    assertRefusedCleanly(
      repo,
      `forecast id ${JSON.stringify(id)}`,
      ["reconcile", "main", "--use-forecast", id],
      /Invalid forecast ID/,
    );
  }

  // Object expressions carry into Git argument vectors, so the newline guard
  // matters even though arguments are passed as an array.
  assertRefusedCleanly(
    repo,
    "object expression with a newline",
    ["merge-plan", "main\nrefs/heads/main"],
    /newline|did not resolve|unknown revision|ambiguous argument/i,
  );

  // A cone must stay inside the repository.
  assertRefusedCleanly(
    repo,
    "workspace cone escaping the repository",
    ["workspace", "create", "escaping", "--cone", "../outside"],
    /must stay inside the repository/,
  );
});

// ---------------------------------------------------------------------------
// Proof bundles
// ---------------------------------------------------------------------------

test("hostile proof bundles fail closed before any member is dereferenced", () => {
  const { repo } = scenario();
  const genuine = JSON.parse(vlab(repo, "proof-bundle", "feature"));
  const bundles = path.join(scenarioParent, "bundles");
  fs.mkdirSync(bundles, { recursive: true });
  const written = (name, mutate) => {
    const bundle = JSON.parse(JSON.stringify(genuine));
    const value = mutate(bundle) ?? bundle;
    const file = path.join(bundles, `${name}.json`);
    fs.writeFileSync(file, `${JSON.stringify(value)}\n`);
    return file;
  };

  // The untouched bundle verifies, so every refusal below is the tampering.
  const genuineResult = vlabResult(repo, "verify-proof", written("genuine", (b) => b), "--offline");
  assert.equal(genuineResult.status, 0, genuineResult.stderr);

  // A member of the wrong shape used to surface as a TypeError from inside
  // the classification ("receipts.flatMap is not a function").
  const receiptsObject = written("receipts-object", (b) => {
    b.evidence.receipts = { absorbedCommits: [] };
  });
  assertRefusedCleanly(
    repo,
    "receipts is not an array",
    ["verify-proof", receiptsObject, "--offline"],
    /not structurally valid/,
  );
  const envelope = JSON.parse(
    vlabResult(repo, "verify-proof", receiptsObject, "--offline", "--json").stdout,
  );
  assert.equal(envelope.code, "malformed-input");
  assert.match(envelope.details, /evidence\.receipts must be an array/);

  assertRefusedCleanly(
    repo,
    "evidence is not an object",
    ["verify-proof", written("evidence-string", (b) => { b.evidence = "trust me"; })],
    /not structurally valid/,
  );
  assertRefusedCleanly(
    repo,
    "changes is not an array",
    ["verify-proof", written("changes-object", (b) => { b.changes = {}; })],
    /not structurally valid/,
  );
  assertRefusedCleanly(
    repo,
    "a receipt is not an object",
    ["verify-proof", written("receipt-string", (b) => { b.evidence.receipts = ["rcpt"]; })],
    /not structurally valid/,
  );
  assertRefusedCleanly(
    repo,
    "the document is an array",
    ["verify-proof", written("array", () => [])],
    /not a JSON object/,
  );
  assertRefusedCleanly(
    repo,
    "a bundle from another family",
    ["verify-proof", written("family", (b) => { b.schema = "vcs-lab.proof-bundle/v99"; })],
    /Not a vcs-lab\.proof-bundle\/v1 document/,
  );

  // The canonical profile refuses floats; the refusal is a domain diagnostic,
  // not the profile's TypeError.
  assertRefusedCleanly(
    repo,
    "a float in the evidence",
    ["verify-proof", written("float", (b) => { b.evidence.targetCommits = [0.5]; }), "--offline"],
    /cannot be hashed under the canonical JSON profile/,
  );

  // A document that names the family but carries none of the members the
  // published schema requires is malformed, not a bundle whose integrity
  // check happens to fail.
  const bare = vlabResult(
    repo,
    "verify-proof",
    written("bare", () => ({ schema: "vcs-lab.proof-bundle/v1" })),
    "--offline",
    "--json",
  );
  assert.notEqual(bare.status, 0);
  const bareEnvelope = JSON.parse(bare.stdout);
  assert.equal(bareEnvelope.code, "malformed-input");
  assert.match(bareEnvelope.details, /evidence is required/);
  assert.match(bareEnvelope.details, /integrity is required/);

  // Size is checked against the published bound before the file is read.
  const oversize = path.join(bundles, "oversize.json");
  fs.writeFileSync(oversize, Buffer.alloc(RESOURCE_BOUNDS.proofBundleBytes + 1, 0x20));
  assertRefusedCleanly(
    repo,
    "an oversize bundle",
    ["verify-proof", oversize, "--offline"],
    /exceeds the proofBundleBytes resource bound/,
  );
});
