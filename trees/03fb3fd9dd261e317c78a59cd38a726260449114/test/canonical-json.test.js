/**
 * The shared canonical-JSON vectors (`docs/canonical-json/vectors.json`)
 * against the Rust model that serializes and hashes every record
 * (`native/model`, the authority since #243), through its probe, and the
 * manifest-hash vector against the shipped envelope reader, through the CLI.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { testEnv } from "../test-support/git-environment.js";
import { cstCommand, cstPrefix } from "../test-support/cst-command.js";
import { probe, registry } from "../test-support/model-probe.js";

const canonicalOf = (value) => probe([{ op: "canonical", text: JSON.stringify(value) }])[0];
const legacyOf = (value) => probe([{ op: "serialize", text: JSON.stringify(value) }])[0].legacy;
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vectors = JSON.parse(
  fs.readFileSync(path.join(projectRoot, "docs", "canonical-json", "vectors.json"), "utf8"),
);

test("the shared vector file names the frozen profile", () => {
  assert.equal(vectors.schema, "vcs-lab.canonical-json-vectors/v1");
  // The vectors are frozen and name the profile by its label before issue #159:
  // the same algorithm (ADR-0039 §1).
  assert.equal(vectors.profile, "vcs-lab.canonical-json/v1");
  const { canonicalProfile, legacyNamespace, schemaNamespace } = registry();
  assert.equal(vectors.profile.replace(legacyNamespace, schemaNamespace), canonicalProfile);
  assert.equal(vectors.hashAlgorithm, "sha256");
  assert.ok(vectors.vectors.length > 0);
  assert.ok(vectors.encoders.length > 0);
  assert.ok(vectors.rejects.length > 0);
});

test("every shared vector serializes and hashes to its frozen bytes", () => {
  for (const vector of vectors.vectors) {
    const { canonical, sha256 } = canonicalOf(vector.input);
    assert.equal(canonical, vector.canonical, `vector '${vector.name}'`);
    assert.equal(sha256, vector.sha256, `vector '${vector.name}' hash`);
    assert.deepEqual(
      JSON.parse(canonical),
      vector.input,
      `vector '${vector.name}' must round-trip through JSON.parse`,
    );
  }
});

function hasIntegerLikeMemberName(value) {
  if (Array.isArray(value)) return value.some(hasIntegerLikeMemberName);
  if (value && typeof value === "object") {
    return Object.entries(value).some(
      ([key, member]) =>
        /^(?:0|[1-9][0-9]*)$/.test(key) || hasIntegerLikeMemberName(member),
    );
  }
  return false;
}

test("the legacy digest serializer agrees on data without integer-like member names", () => {
  let compared = 0;
  for (const vector of vectors.vectors) {
    // ECMAScript property enumeration places integer-like member names
    // first, so the legacy serializer is not code-unit sorted for such
    // names; its divergence is pinned separately below.
    if (hasIntegerLikeMemberName(vector.input)) continue;
    compared += 1;
    assert.equal(
      legacyOf(vector.input),
      vector.canonical,
      `vector '${vector.name}': the byte-identical-migration claim for lineage and manifest hashes rests on this`,
    );
  }
  assert.ok(compared >= 8, "most vectors must exercise the parity claim");
});

test("the legacy digest serializer diverges on integer-like member names", () => {
  const vector = vectors.vectors.find(
    (entry) => entry.name === "key-sort-utf16-code-units",
  );
  assert.ok(vector, "the member-sorting vector must exist");
  assert.ok(hasIntegerLikeMemberName(vector.input));
  const legacy = legacyOf(vector.input);
  assert.notEqual(
    legacy,
    vector.canonical,
    "the legacy serializer enumerates integer-like member names first; this divergence is why new hashes must use the profile",
  );
  assert.deepEqual(JSON.parse(legacy), vector.input);
});

test("every reject in the vector file is refused", () => {
  for (const reject of vectors.rejects) {
    const reply = probe([{ op: "canonical", text: JSON.stringify(reject.input) }])[0];
    assert.equal(typeof reply.error, "string", `reject '${reject.name}' must be refused`);
  }
});

test("numbers the profile cannot represent faithfully are refused", () => {
  // JSON text can spell these; the profile still refuses them. Values JSON
  // text cannot spell at all (NaN, undefined, a BigInt) never reach the model.
  for (const [name, text] of [
    ["negative zero", "-0"],
    ["2^53", "9007199254740992"],
    ["non-integer", "1.0000001"],
    ["nested non-integer", '{"ratio":[1.5]}'],
  ]) {
    const reply = probe([{ op: "canonical", text }])[0];
    assert.equal(typeof reply.error, "string", `${name} must be refused`);
  }
  assert.equal(probe([{ op: "canonical", text: "9007199254740991" }])[0].canonical, "9007199254740991");
  assert.equal(probe([{ op: "canonical", text: "0" }])[0].canonical, "0");
});

test("the repository-lineage encoder vector matches the runtime identity algorithm", () => {
  const encoder = vectors.encoders.find((entry) =>
    entry.name.startsWith("repository-lineage/"),
  );
  assert.ok(encoder, "lineage encoder vector present");
  assert.equal(encoder.input.algorithm, registry().lineageAlgorithm);
  const { canonical, sha256 } = canonicalOf(encoder.input);
  assert.equal(canonical, encoder.canonical);
  assert.equal(sha256, encoder.sha256);
  assert.equal(encoder.id, `lineage_${encoder.sha256}`);
});

test("the manifest-hash encoder vector is accepted by the shipped envelope reader", (t) => {
  const encoder = vectors.encoders.find(
    (entry) => entry.name === "metadata-envelope-manifest-hash/v1",
  );
  assert.ok(encoder, "manifest-hash encoder vector present");

  const [hashed] = probe([{ op: "hashed", text: JSON.stringify(encoder.manifest) }]);
  assert.equal(hashed.canonical, encoder.hashedPayloadCanonical);
  assert.equal(hashed.sha256, encoder.manifestHash);
  assert.equal(encoder.manifest.integrity.manifestHash, encoder.manifestHash);

  // The envelope reader runs in `metadata import`. This repository shares no
  // root with the vector's lineage, so an intact manifest passes the integrity
  // check and is refused at the next one, the lineage.
  const parent = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "vcs-lab-canonical-vector-")));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const repo = path.join(parent, "repo");
  const directory = path.join(parent, "envelope");
  fs.mkdirSync(repo);
  fs.mkdirSync(directory);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo, env: testEnv() });
  execFileSync("git", ["-c", "user.name=Vector", "-c", "user.email=vector@example.invalid",
    "commit", "-q", "--allow-empty", "-m", "root"], { cwd: repo, env: testEnv() });
  const manifestPath = path.join(directory, "manifest.json");
  const importing = (manifest) => {
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const result = spawnSync(cstCommand, [...cstPrefix(), "metadata", "import", directory, "--dry-run", "--json"],
      { cwd: repo, encoding: "utf8", env: testEnv() });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    return JSON.parse(result.stdout);
  };

  const intact = importing(encoder.manifest);
  assert.equal(intact.code, "unsupported-repository-shape");
  assert.match(intact.message, /lineage is unrelated/);

  const tampered = structuredClone(encoder.manifest);
  tampered.excludedScopes = ["tampered"];
  assert.equal(importing(tampered).code, "integrity-check-failed");

  const unrepresentable = structuredClone(encoder.manifest);
  unrepresentable.ratio = 1.5;
  const refused = importing(unrepresentable);
  assert.equal(refused.code, "malformed-input");
  assert.match(refused.message, /not representable in the canonical JSON profile/);
});
