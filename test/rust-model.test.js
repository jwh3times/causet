/**
 * The Rust record model (`native/model`, issue #142) against the JavaScript
 * authority it ports: canonical JSON and the legacy digest serializer, JSON
 * serialization and ECMAScript number formatting, the record-family and
 * resource-bound registries, classification, compatibility and readability,
 * the note-record validators and referenced objects, resolution signatures,
 * logical identifiers, SHA-256, and `createdAt` timestamps.
 *
 * Every case runs through `src/` and through `model-probe` and must agree
 * exactly, including where the JavaScript throws (#172). The one deliberate
 * exclusion is V8's non-ISO date fallback (#173): timestamps here are all in
 * the ECMAScript date-time format.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CANONICAL_JSON_PROFILE, canonicalJson, hashedPayload } from "../src/canonical-json.js";
import { ERROR_CODES, ERROR_ENVELOPE_SCHEMA } from "../src/errors.js";
import { ID_ENTROPY_BITS, ID_NAMESPACES, LOGICAL_ID_PROFILE, newId, parseLogicalId } from "../src/ids.js";
import { canonicalJson as legacyCanonicalJson } from "../src/metadata.js";
import {
  EXCHANGED_SCOPES,
  EXCHANGE_FEATURES,
  LEGACY_SCHEMA_NAMESPACE,
  METADATA_LINEAGE_ALGORITHM,
  PROVENANCE_ROLE_NAMES,
  RECORD_FAMILIES,
  RESOLUTION_SIGNATURE_ALGORITHM,
  RESOURCE_BOUNDS,
  SCHEMA_NAMESPACE,
  assertReadableSchema,
  referencedObjectsForRecord,
  resolutionSignatureFor,
  schemaClassification,
  schemaCompatibility,
  validateNoteRecord,
} from "../src/schemas.js";
import { available, jsReferences, jsValidation, probe, unavailableReason } from "../test-support/model-probe.js";

const skip = available ? false : unavailableReason;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vectors = JSON.parse(fs.readFileSync(path.join(root, "docs/canonical-json/vectors.json"), "utf8"));
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const ZERO = "0".repeat(40);

/** A deterministic generator, so a failure names a reproducible case. */
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

// ---------------------------------------------------------------------------
// Canonical JSON and serialization
// ---------------------------------------------------------------------------

function jsSerialization(text) {
  const value = JSON.parse(text);
  let canonical;
  try {
    const bytes = canonicalJson(value);
    canonical = { canonical: bytes, sha256: sha256(bytes) };
  } catch (error) {
    canonical = { error: error.message };
  }
  let hashed;
  try {
    const bytes = hashedPayload(value);
    hashed = { canonical: bytes, sha256: sha256(bytes) };
  } catch (error) {
    hashed = { error: error.message };
  }
  return {
    canonical,
    hashed,
    serialize: {
      compact: JSON.stringify(value),
      pretty: JSON.stringify(value, null, 2),
      legacy: legacyCanonicalJson(value),
      digest: sha256(legacyCanonicalJson({ attachment: ZERO, record: value })),
    },
  };
}

function rustSerialization(texts) {
  const replies = probe(texts.flatMap((text) => [
    { op: "canonical", text }, { op: "hashed", text }, { op: "serialize", text },
  ]));
  return texts.map((_, index) => ({
    canonical: replies[index * 3],
    hashed: replies[index * 3 + 1],
    serialize: replies[index * 3 + 2],
  }));
}

// Member names that need escaping are left out of the generated documents:
// V8 14.6 (Node 26.4) can hand a later JSON.parse the wrong escaped name once
// an earlier object primed the same member-name path, which would make the
// oracle itself wrong. They are checked against fixed expectations below.
const KEYS = ["", "a", "A", "b", "aa", "a a", "~", "_", "é", "É", "😀", "ﬁ", "0", "1", "2", "10", "01", "-1",
  "4294967294", "4294967295", "1.5", "integrity", "signatures", "__proto__", "constructor"];
const STRINGS = ["", "plain", "é😀ﬁ", "\u0000\u0001\b\t\n\f\r\u001f", "  ", "\"\\/", "\ud800", "\udfff",
  "a\ud83d", "\ude00b", "😀"];
const NUMBERS = [0, 1, -1, 42, -42, 0.1, 1.5, -2.5, 1e21, 1e20, 1.5e-7, 1e-6, 123456789.123, 5e-324,
  9007199254740991, -9007199254740991, 9007199254740992, 1.7976931348623157e308, 2 ** 53 + 2, 0.30000000000000004];

function generate(next, depth) {
  const pick = (list) => list[Math.floor(next() * list.length)];
  const kind = depth > 3 ? Math.floor(next() * 4) : Math.floor(next() * 6);
  if (kind === 0) return pick([null, true, false]);
  if (kind === 1) return pick(NUMBERS);
  if (kind === 2 || kind === 3) return pick(STRINGS);
  if (kind === 4) return Array.from({ length: Math.floor(next() * 4) }, () => generate(next, depth + 1));
  const object = {};
  for (let index = Math.floor(next() * 6); index > 0; index -= 1) object[pick(KEYS)] = generate(next, depth + 1);
  return object;
}

test("the canonical JSON vectors, rejects and encoders pass byte for byte", { skip }, () => {
  const lineage = vectors.encoders.find((encoder) => encoder.input);
  const manifest = vectors.encoders.find((encoder) => encoder.manifest);
  const texts = [...vectors.vectors, lineage, ...vectors.rejects].map((vector) => JSON.stringify(vector.input));
  const replies = rustSerialization(texts);
  for (const [index, vector] of [...vectors.vectors, lineage].entries()) {
    assert.deepEqual(replies[index].canonical, { canonical: vector.canonical, sha256: vector.sha256 }, vector.name);
  }
  assert.equal(`lineage_${replies[vectors.vectors.length].canonical.sha256}`, lineage.id);
  // The manifest encoder is the hashed-payload rule: integrity and signatures left out.
  const [hashed] = rustSerialization([JSON.stringify(manifest.manifest)]);
  assert.deepEqual(hashed.hashed, { canonical: manifest.hashedPayloadCanonical, sha256: manifest.manifestHash });
  for (const [offset, vector] of vectors.rejects.entries()) {
    const reply = replies[vectors.vectors.length + 1 + offset];
    assert.deepEqual(reply.canonical, jsSerialization(JSON.stringify(vector.input)).canonical, vector.name);
    assert.ok(reply.canonical.error, vector.name);
  }
  assert.equal(vectors.profile, "vcs-lab.canonical-json/v1");
});

test("canonical, hashed, compact, pretty and legacy serializations agree on generated documents", { skip }, () => {
  const next = random(142);
  const texts = Array.from({ length: 1500 }, () => JSON.stringify(generate(next, 0)));
  // Spellings JSON.stringify never writes, which JSON.parse must still read identically.
  texts.push("-0", "[-0]", "{\"a\":-0.0}", "1.0", "1e2", "1E+2", "10e-1", "0.1e1", "1e400", "-1e400",
    "123456789012345678901234567890", "{\"b\":1,\"a\":2,\"b\":3}", "{\"10\":1,\"2\":2,\"a\":3,\"1\":4}",
    " \t\n\r{ \"a\" : [ 1 , 2 ] } ", "\"\\u00e9\\ud83d\\ude00\\/\"", "{\"integrity\":1,\"signatures\":2,\"x\":3}");
  const rust = rustSerialization(texts);
  for (const [index, text] of texts.entries()) {
    assert.deepEqual(rust[index], jsSerialization(text), text);
  }
});

test("member names that need escaping round-trip exactly, in any order", { skip }, () => {
  // Fixed expectations rather than JSON.parse: see the note on KEYS. Each text
  // is already in JSON.stringify's own form, so it must come back unchanged.
  const texts = [
    String.raw`{"-1":"x","\\":"","a a":null}`,
    String.raw`["\ud800",[{"1":-42,"-1":false,"\"":{},"4294967295":[]},false]]`,
    String.raw`{"\u0000":1,"\"":2,"\\":3,"\n":4}`,
    String.raw`[{"\\":1},{"\"":2},{"\\":3,"\"":4}]`,
  ];
  const replies = probe(texts.map((text) => ({ op: "serialize", text })));
  for (const [index, text] of texts.entries()) assert.equal(replies[index].compact, text);
});

// ---------------------------------------------------------------------------
// Registries, classification and readability
// ---------------------------------------------------------------------------

test("the Rust registries equal src/schemas.js, src/errors.js and src/ids.js", { skip }, () => {
  const [rust] = probe([{ op: "registry" }]);
  assert.deepEqual(rust.families, [...RECORD_FAMILIES].map(([name, policy]) => ({
    name,
    scope: policy.scope,
    registered: policy.registered,
    readable: policy.readable,
    written: policy.written,
    unknownVersion: policy.unknownVersion,
    store: policy.store,
  })));
  assert.deepEqual(rust.bounds, { ...RESOURCE_BOUNDS });
  assert.deepEqual(Object.keys(rust.bounds), Object.keys(RESOURCE_BOUNDS));
  assert.deepEqual(rust.exchangedScopes, [...EXCHANGED_SCOPES]);
  assert.deepEqual(rust.exchangeFeatures, [...EXCHANGE_FEATURES]);
  assert.deepEqual(rust.provenanceRoles, [...PROVENANCE_ROLE_NAMES]);
  assert.equal(rust.resolutionAlgorithm, RESOLUTION_SIGNATURE_ALGORITHM);
  assert.equal(rust.lineageAlgorithm, METADATA_LINEAGE_ALGORITHM);
  assert.equal(rust.errorEnvelopeSchema, ERROR_ENVELOPE_SCHEMA);
  assert.deepEqual(rust.errorCodes, { ...ERROR_CODES });
  assert.deepEqual(Object.keys(rust.errorCodes), Object.keys(ERROR_CODES));
  assert.deepEqual(rust.idNamespaces, { ...ID_NAMESPACES });
  assert.equal(rust.idEntropyBits, ID_ENTROPY_BITS);
  assert.equal(rust.canonicalProfile, CANONICAL_JSON_PROFILE);
  assert.equal(rust.logicalIdProfile, LOGICAL_ID_PROFILE);
  assert.equal(rust.schemaNamespace, SCHEMA_NAMESPACE);
  assert.equal(rust.legacyNamespace, LEGACY_SCHEMA_NAMESPACE);
});

function schemaCorpus() {
  const corpus = [null, 7, "", "causet", "causet.landing", "causet.landing/v", "causet.landing/v1x", "/v1",
    "causet.nope/v1", "vcs-lab.nope/v1", "vcs-lab.", "causet.landing/v01", "causet.landing/v1/v2",
    "causet.lan\nding/v1", "causet.landing/v99999999999999999999", "VCS-LAB.landing/v1", "vcs-labs.landing/v1"];
  for (const [family, policy] of RECORD_FAMILIES) {
    const bare = family.slice(SCHEMA_NAMESPACE.length);
    for (const version of [...policy.registered, 0, Math.max(...policy.registered) + 1]) {
      corpus.push(`${family}/v${version}`, `${LEGACY_SCHEMA_NAMESPACE}${bare}/v${version}`);
    }
  }
  return corpus;
}

test("classification and compatibility agree for every family, version and spelling", { skip }, () => {
  const corpus = schemaCorpus();
  const replies = probe(corpus.map((schema) => ({ op: "classify", schema })));
  for (const [index, schema] of corpus.entries()) {
    const compatibility = schemaCompatibility(schema);
    assert.deepEqual(replies[index], {
      classification: schemaClassification(schema),
      compatibility: {
        family: compatibility.family,
        version: compatibility.version,
        policy: compatibility.policy ? compatibility.family : null,
        scope: compatibility.scope,
        readable: compatibility.readable,
        migrated: compatibility.migrated,
        disposition: compatibility.disposition,
      },
    }, JSON.stringify(schema));
  }
});

test("readability refusals carry the same code, message and details", { skip }, () => {
  const cases = [];
  for (const schema of schemaCorpus()) {
    for (const family of [null, "causet.forecast", "causet.landing"]) {
      for (const recovery of ["", "Read it with the causet build that wrote it."]) {
        cases.push({ schema, family, recovery, subject: "The record at 'x'" });
      }
    }
  }
  const replies = probe(cases.map((entry) => ({ op: "readable", ...entry, family: entry.family ?? undefined })));
  for (const [index, entry] of cases.entries()) {
    let expected;
    try {
      assertReadableSchema(entry.schema, entry.subject, { family: entry.family, recovery: entry.recovery });
      expected = { readable: true };
    } catch (error) {
      expected = { code: error.code, message: error.message, details: error.details };
    }
    assert.deepEqual(replies[index], expected, JSON.stringify(entry));
  }
});

// ---------------------------------------------------------------------------
// Note-record validators and referenced objects
// ---------------------------------------------------------------------------

const fixture = JSON.parse(fs.readFileSync(path.join(root, "test/fixtures/legacy-0.19.1/fixture.json"), "utf8"));
const OID = "a".repeat(40);
const OID2 = "b".repeat(40);
const TREE = "c".repeat(40);

/** Real records of eight families, and templates for the three the fixture lacks. */
function baseRecords() {
  const real = JSON.parse(fixture.expected.find((entry) => entry.args[0] === "receipts").stdout);
  const rebase = real.find((record) => record.schema.endsWith(".rebase/v3"));
  const synthetic = [
    { schema: "causet.amendment/v1", type: "amendment", id: "amend_0mulzqqkl9a8129884dd6", commit: OID,
      originCommit: OID2, treeBefore: TREE, treeAfter: OID, changeId: "ch_0mulzqqkl9a8129884dd6",
      rebaseOperation: "rebase_op_0mulzqqkl9a8129884dd6", createdAt: "2026-09-30T12:00:00.000Z" },
    { schema: "causet.interactive-absorption/v1", type: "interactive-absorption", id: "absorb_0mulzqqkl9a8129884dd6",
      survivingCommit: OID, absorbedCommits: [OID2], absorbedChanges: ["ch_1"], survivingChangeId: "ch_0",
      action: "squash", rebaseOperation: "rebase_op_0mulzqqkl9a8129884dd6", createdAt: "2026-09-30T12:00:00Z" },
    { ...rebase, schema: "vcs-lab.rebase/v1", recreatedMerges: undefined },
    { ...rebase, schema: "causet.rebase/v2", recreatedMerges: [{ originCommit: OID, resultCommit: OID2,
      originChangeId: "ch_a", changeId: "ch_b", relation: "recreated-merge", cleanJoin: true, resolutions: [],
      parents: [{ commit: OID }, { commit: TREE }] }] },
  ].map((record) => JSON.parse(JSON.stringify(record)));
  return [...real, ...synthetic];
}

const REPLACEMENTS = [null, "", "x", "abcd", 0, 1.5, -0, true, false, [], {}, [null], ["x"], [{}], [OID], OID,
  OID.toUpperCase(), "a".repeat(64), "rsig_" + "0".repeat(64), "2026-09-30T12:00:00.000Z", "2021-02-30",
  "2020-13-01", "2020-01-01T24:00", "1", "compact", "carried", "declared", "recreated-merge", "squash",
  "causal-rebase", "refs/causet/resolutions/x", "refs/vcs-lab/resolutions/x", "ordered-three-way-blobs/v1",
  [OID, OID2], ["a", ""], [{ role: "generated", actor: "x" }], [{ role: "owner", actor: "x" }], [["generated"]],
  { commit: OID }, { blob: OID }];

const ISO_SHAPE = /^[+-]?\d{4,6}(-\d{2}(-\d{2})?)?(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/;

/** Each record, and every record one member away from it. */
function recordCorpus() {
  const corpus = [];
  for (const record of baseRecords()) {
    corpus.push(record, { ...record, attachedTo: record.commit ?? OID }, { ...record, attachedTo: "nope" });
    for (const field of Object.keys(record)) {
      if (field === "schema") continue;
      const { [field]: _removed, ...without } = record;
      corpus.push(without);
      for (const value of REPLACEMENTS) {
        // A string createdAt outside the ECMAScript format is V8's fallback (#173).
        if (field === "createdAt" && typeof value === "string" && !ISO_SHAPE.test(value)) continue;
        corpus.push({ ...record, [field]: value });
      }
    }
    for (const field of ["applications", "recreatedMerges"]) {
      const items = record[field];
      if (!Array.isArray(items) || !items.length) continue;
      for (const key of Object.keys(items[0])) {
        for (const value of REPLACEMENTS) corpus.push({ ...record, [field]: [{ ...items[0], [key]: value }] });
      }
    }
  }
  corpus.push({}, { schema: 5 }, { schema: "causet.forecast/v2" }, { schema: "causet.landing/v1" });
  return corpus;
}

test("the validators and referenced objects agree on every record and every one-member mutation", { skip }, () => {
  const corpus = recordCorpus();
  for (const format of ["sha1", "sha256"]) {
    const replies = probe(corpus.flatMap((record) => [
      { op: "validate", text: JSON.stringify(record), format },
      { op: "refs", text: JSON.stringify(record) },
    ]));
    let thrown = 0;
    for (const [index, record] of corpus.entries()) {
      const validation = jsValidation(validateNoteRecord, JSON.parse(JSON.stringify(record)), format);
      if (validation.thrown) thrown += 1;
      assert.deepEqual(replies[index * 2], validation, `${format} validate ${JSON.stringify(record)}`);
      assert.deepEqual(replies[index * 2 + 1], jsReferences(referencedObjectsForRecord, JSON.parse(JSON.stringify(record))),
        `refs ${JSON.stringify(record)}`);
    }
    assert.ok(corpus.length > 3000, `corpus of ${corpus.length}`);
    assert.ok(thrown > 0, "the corpus reaches the JavaScript throwing paths (#172)");
  }
});

test("resolution signatures agree", { skip }, () => {
  const stages = [{}, { base: null, ours: null, theirs: null }, { base: { blob: OID, mode: "100644" } },
    { ours: { mode: "100644", blob: OID }, theirs: [1, "2"], extra: true }, [], "text", 5];
  for (const record of baseRecords().filter((record) => record.schema.endsWith(".resolution/v1"))) stages.push(record);
  const replies = probe(stages.map((value) => ({ op: "signature", text: JSON.stringify(value) })));
  for (const [index, value] of stages.entries()) {
    assert.deepEqual(replies[index], { signature: resolutionSignatureFor(value) }, JSON.stringify(value));
  }
});

// ---------------------------------------------------------------------------
// Identifiers, digests and dates
// ---------------------------------------------------------------------------

test("logical identifiers parse identically, and minted ones are valid to both", { skip }, () => {
  const values = [undefined, null, 5, "", "git:abc", "ch_0mulzqqkl9a8129884dd6", "reconcile_op_0mulzqqkl9a8129884dd6",
    "zzz_0mulzqqkl9a8129884dd6", "Ch_0mulzqqkl9a8129884dd6", "ch_0mulzqqkl9a8129884dd", "ch_0mulzqqkl9a8129884ddG",
    "_ch_0mulzqqkl9a8129884dd6", "ch__0mulzqqkl9a8129884dd6", "ch_0MULZQQKL9A8129884DD6", "ché_0mulzqqkl9a8129884dd6",
    ...Object.keys(ID_NAMESPACES).map((namespace) => newId(namespace))];
  const minted = probe(Object.keys(ID_NAMESPACES).map((prefix) => ({ op: "new-id", prefix })));
  values.push(...minted.map((reply) => reply.id));
  const replies = probe(values.map((value) => ({ op: "logical-id", value })));
  for (const [index, value] of values.entries()) {
    const expected = parseLogicalId(value);
    const parsed = typeof value === "string" ? expected : parseLogicalId(value);
    assert.deepEqual(replies[index], parsed, JSON.stringify(value));
  }
  for (const reply of minted) assert.equal(parseLogicalId(reply.id).valid, true, reply.id);
});

test("SHA-256 agrees with node:crypto", { skip }, () => {
  const next = random(256);
  const inputs = ["", "abc", "é😀", "x".repeat(55), "x".repeat(56), "x".repeat(64), "x".repeat(1000)];
  for (let index = 0; index < 200; index += 1) {
    inputs.push(Array.from({ length: Math.floor(next() * 300) }, () => String.fromCodePoint(Math.floor(next() * 0x2ff) + 1)).join(""));
  }
  const replies = probe(inputs.map((data) => ({ op: "sha256", data })));
  for (const [index, data] of inputs.entries()) assert.equal(replies[index].hex, sha256(data), JSON.stringify(data));
});

test("createdAt timestamps in the ECMAScript format are judged as Date.parse judges them (#173 excluded)", { skip }, () => {
  const next = random(173);
  const two = (limit) => String(Math.floor(next() * limit)).padStart(2, "0");
  const values = [];
  for (let index = 0; index < 3000; index += 1) {
    const year = next() < 0.1 ? `${next() < 0.5 ? "+" : "-"}${String(Math.floor(next() * 300000)).padStart(6, "0")}`
      : String(Math.floor(next() * 10000)).padStart(4, "0");
    let value = year;
    if (next() < 0.9) value += `-${two(14)}`;
    if (next() < 0.8) value += `-${two(33)}`;
    if (next() < 0.7) {
      value += `T${two(26)}:${two(62)}`;
      if (next() < 0.8) value += `:${two(62)}`;
      if (next() < 0.5) value += `.${String(Math.floor(next() * 10000)).slice(0, 1 + Math.floor(next() * 4))}`;
      const zone = next();
      if (zone < 0.4) value += "Z";
      else if (zone < 0.6) value += `${next() < 0.5 ? "+" : "-"}${two(26)}:${two(62)}`;
    }
    // Only full ECMAScript shapes: a date-only value keeps month and day
    // together, since V8's fallback reads partial shapes its own way (#173).
    if (/^[+-]?\d{4,6}(-\d{2}(-\d{2})?)?(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/.test(value)) values.push(value);
  }
  const replies = probe(values.map((value) => ({ op: "date", value })));
  const disagreements = values.filter((value, index) => replies[index].valid !== !Number.isNaN(Date.parse(value)));
  assert.deepEqual(disagreements, []);
});
