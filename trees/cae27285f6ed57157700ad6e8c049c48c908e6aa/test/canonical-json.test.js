import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CANONICAL_JSON_PROFILE, canonicalJson } from "../src/canonical-json.js";
import { canonicalJson as legacyCanonicalJson } from "../src/metadata.js";
import { readEnvelope } from "../src/metadata-envelope.js";
import { METADATA_LINEAGE_ALGORITHM } from "../src/schemas.js";
import { sha256 } from "../src/ids.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vectors = JSON.parse(
  fs.readFileSync(path.join(projectRoot, "docs", "canonical-json", "vectors.json"), "utf8"),
);

test("the shared vector file names the frozen profile", () => {
  assert.equal(vectors.schema, "vcs-lab.canonical-json-vectors/v1");
  assert.equal(vectors.profile, CANONICAL_JSON_PROFILE);
  assert.equal(vectors.hashAlgorithm, "sha256");
  assert.ok(vectors.vectors.length > 0);
  assert.ok(vectors.encoders.length > 0);
  assert.ok(vectors.rejects.length > 0);
});

test("every shared vector serializes and hashes to its frozen bytes", () => {
  for (const vector of vectors.vectors) {
    const canonical = canonicalJson(vector.input);
    assert.equal(canonical, vector.canonical, `vector '${vector.name}'`);
    assert.equal(sha256(canonical), vector.sha256, `vector '${vector.name}' hash`);
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
      legacyCanonicalJson(vector.input),
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
  const legacy = legacyCanonicalJson(vector.input);
  assert.notEqual(
    legacy,
    vector.canonical,
    "the legacy serializer enumerates integer-like member names first; this divergence is why new hashes must use the profile",
  );
  assert.deepEqual(JSON.parse(legacy), vector.input);
});

test("every reject in the vector file is refused", () => {
  for (const reject of vectors.rejects) {
    assert.throws(
      () => canonicalJson(reject.input),
      TypeError,
      `reject '${reject.name}' must throw`,
    );
  }
});

test("values JSON cannot represent faithfully are refused", () => {
  const rejects = [
    ["NaN", Number.NaN],
    ["positive infinity", Number.POSITIVE_INFINITY],
    ["negative infinity", Number.NEGATIVE_INFINITY],
    ["negative zero", -0],
    ["2^53", 2 ** 53],
    ["non-integer", 1.0000001],
    ["undefined member", { present: 1, missing: undefined }],
    ["undefined array element", [undefined]],
    ["bigint", 10n],
    ["date", new Date(0)],
    ["buffer", Buffer.from("bytes")],
    ["map", new Map()],
    ["set", new Set()],
    ["function", () => {}],
    ["symbol member", { key: Symbol("value") }],
  ];
  for (const [name, value] of rejects) {
    assert.throws(() => canonicalJson(value), TypeError, `${name} must throw`);
  }
  assert.equal(canonicalJson(2 ** 53 - 1), "9007199254740991");
  assert.equal(canonicalJson(0), "0");
});

test("the repository-lineage encoder vector matches the runtime identity algorithm", () => {
  const encoder = vectors.encoders.find((entry) =>
    entry.name.startsWith("repository-lineage/"),
  );
  assert.ok(encoder, "lineage encoder vector present");
  assert.equal(encoder.input.algorithm, METADATA_LINEAGE_ALGORITHM);
  assert.equal(canonicalJson(encoder.input), encoder.canonical);
  assert.equal(sha256(encoder.canonical), encoder.sha256);
  assert.equal(encoder.id, `lineage_${encoder.sha256}`);
});

test("the manifest-hash encoder vector is accepted by the shipped envelope reader", (t) => {
  const encoder = vectors.encoders.find(
    (entry) => entry.name === "metadata-envelope-manifest-hash/v1",
  );
  assert.ok(encoder, "manifest-hash encoder vector present");

  const payload = structuredClone(encoder.manifest);
  delete payload.integrity;
  delete payload.signatures;
  assert.equal(canonicalJson(payload), encoder.hashedPayloadCanonical);
  assert.equal(sha256(encoder.hashedPayloadCanonical), encoder.manifestHash);
  assert.equal(encoder.manifest.integrity.manifestHash, encoder.manifestHash);

  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "vcs-lab-canonical-vector-")));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const manifestPath = path.join(directory, "manifest.json");

  fs.writeFileSync(manifestPath, `${JSON.stringify(encoder.manifest, null, 2)}\n`);
  const envelope = readEnvelope(directory);
  assert.equal(envelope.manifest.integrity.manifestHash, encoder.manifestHash);

  const tampered = structuredClone(encoder.manifest);
  tampered.excludedScopes = ["tampered"];
  fs.writeFileSync(manifestPath, `${JSON.stringify(tampered, null, 2)}\n`);
  assert.throws(() => readEnvelope(directory), /integrity check failed/);

  const unrepresentable = structuredClone(encoder.manifest);
  unrepresentable.ratio = 1.5;
  fs.writeFileSync(manifestPath, `${JSON.stringify(unrepresentable, null, 2)}\n`);
  assert.throws(
    () => readEnvelope(directory),
    /not representable in the canonical JSON profile/,
  );
});
