/**
 * The Rust record model (`native/model`, issue #142) against the answers of
 * the JavaScript authority it ported: canonical JSON and the legacy digest
 * serializer, JSON serialization and ECMAScript number formatting, the
 * record-family and resource-bound registries, classification, compatibility
 * and readability, the note-record validators and referenced objects,
 * resolution signatures, logical identifiers, SHA-256, and `createdAt`
 * timestamps.
 *
 * Until #243 every case ran through `src/` and through `model-probe` and had
 * to agree exactly. The JavaScript answers to the same deterministic inputs
 * (`test-support/model-corpus.js`) are now frozen in
 * `test/fixtures/oracle/model.json`; see `test-support/oracle-vectors.js`.
 * A malformed member is a field error, never a throw (#172). Timestamps are
 * judged by the ECMAScript date-time format alone, never by V8's non-ISO
 * `Date.parse` fallback (#173).
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { available, probe, unavailableReason } from "../test-support/model-probe.js";
import {
  LOGICAL_ID_VALUES,
  dateValues,
  generatedTexts,
  random,
  readableCases,
  recordCorpus,
  schemaCorpus,
  signatureStages,
} from "../test-support/model-corpus.js";
import { assertFrozenHashes, loadVectors } from "../test-support/oracle-vectors.js";

const skip = available ? false : unavailableReason;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vectors = JSON.parse(fs.readFileSync(path.join(root, "docs/canonical-json/vectors.json"), "utf8"));
const frozen = loadVectors("model");
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

// ---------------------------------------------------------------------------
// Canonical JSON and serialization
// ---------------------------------------------------------------------------

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
  assert.equal(frozen.rejects.length, vectors.rejects.length, "a reject was added after the oracle was frozen");
  for (const [offset, vector] of vectors.rejects.entries()) {
    const reply = replies[vectors.vectors.length + 1 + offset];
    assert.deepEqual(reply.canonical, frozen.rejects[offset], vector.name);
    assert.ok(reply.canonical.error, vector.name);
  }
  assert.equal(vectors.profile, "vcs-lab.canonical-json/v1");
});

test("canonical, hashed, compact, pretty and legacy serializations agree on generated documents", { skip }, () => {
  const texts = generatedTexts();
  const rust = rustSerialization(texts);
  // Compact and pretty are JSON.stringify's own forms.
  for (const [index, text] of texts.entries()) {
    const value = JSON.parse(text);
    assert.equal(rust[index].serialize.compact, JSON.stringify(value), text);
    assert.equal(rust[index].serialize.pretty, JSON.stringify(value, null, 2), text);
  }
  assertFrozenHashes(frozen.hashes.generated, rust.map(({ canonical, hashed, serialize }) =>
    ({ canonical, hashed, legacy: serialize.legacy, digest: serialize.digest })),
  (index) => texts[index], "generated serializations");
});

test("member names that need escaping round-trip exactly, in any order", { skip }, () => {
  // Fixed expectations rather than JSON.parse: see the note on KEYS in
  // test-support/model-corpus.js. Each text is already in JSON.stringify's own
  // form, so it must come back unchanged.
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

test("the Rust registries equal those of src/schemas.js, src/errors.js and src/ids.js", { skip }, () => {
  const [rust] = probe([{ op: "registry" }]);
  assert.deepEqual(rust, frozen.registry);
  // Order is part of the registries: tables and listings follow it.
  for (const member of ["bounds", "errorCodes", "idNamespaces"]) {
    assert.deepEqual(Object.keys(rust[member]), Object.keys(frozen.registry[member]), member);
  }
});

test("classification and compatibility agree for every family, version and spelling", { skip }, () => {
  const corpus = schemaCorpus(frozen.registry);
  const replies = probe(corpus.map((schema) => ({ op: "classify", schema })));
  assertFrozenHashes(frozen.hashes.classify, replies, (index) => JSON.stringify(corpus[index]), "classification");
});

test("readability refusals carry the same code, message and details", { skip }, () => {
  const cases = readableCases(frozen.registry);
  const replies = probe(cases.map((entry) => ({ op: "readable", ...entry, family: entry.family ?? undefined })));
  assertFrozenHashes(frozen.hashes.readable, replies, (index) => JSON.stringify(cases[index]), "readability");
});

// ---------------------------------------------------------------------------
// Note-record validators and referenced objects
// ---------------------------------------------------------------------------

test("the validators and referenced objects agree on every record and every one-member mutation", { skip }, () => {
  const corpus = recordCorpus();
  assert.ok(corpus.length > 3000, `corpus of ${corpus.length}`);
  for (const [format, group] of [["sha1", "validateSha1"], ["sha256", "validateSha256"]]) {
    const replies = probe(corpus.map((text) => ({ op: "validate", text, format })));
    assert.equal(replies.filter((reply) => reply.thrown).length, 0,
      "a malformed member is a field error, never a throw (#172)");
    assertFrozenHashes(frozen.hashes[group], replies, (index) => `${format} validate ${corpus[index]}`, group);
  }
  const references = probe(corpus.map((text) => ({ op: "refs", text })));
  assertFrozenHashes(frozen.hashes.references, references, (index) => `refs ${corpus[index]}`, "references");
});

test("resolution signatures agree", { skip }, () => {
  const stages = signatureStages();
  const replies = probe(stages.map((text) => ({ op: "signature", text })));
  assert.deepEqual(replies, frozen.signatures);
});

// ---------------------------------------------------------------------------
// Identifiers, digests and dates
// ---------------------------------------------------------------------------

test("logical identifiers parse as the oracle parsed them, and minted ones are valid", { skip }, () => {
  const replies = probe(LOGICAL_ID_VALUES.map((value) => ({ op: "logical-id", value })));
  for (const [index, value] of LOGICAL_ID_VALUES.entries()) {
    assert.deepEqual(replies[index], frozen.logicalIds[index], JSON.stringify(value));
  }
  const minted = probe(Object.keys(frozen.registry.idNamespaces).map((prefix) => ({ op: "new-id", prefix })));
  const parsed = probe(minted.map((reply) => ({ op: "logical-id", value: reply.id })));
  for (const [index, reply] of parsed.entries()) assert.equal(reply.valid, true, minted[index].id);
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

test("createdAt timestamps are judged by the ECMAScript format alone (#173)", { skip }, () => {
  const values = dateValues();
  const replies = probe(values.map((value) => ({ op: "date", value })));
  const verdicts = replies.map((reply) => (reply.valid ? "1" : "0")).join("");
  const disagreements = values.filter((_, index) => verdicts[index] !== frozen.dates[index]);
  assert.equal(values.length, frozen.dates.length, "the date corpus changed");
  assert.deepEqual(disagreements, []);
  // The format is a subset of what Date.parse reads: nothing it refuses is accepted here.
  assert.deepEqual(values.filter((value, index) => replies[index].valid && Number.isNaN(Date.parse(value))), []);
  for (const value of ["1", "March 7, 2006", "2020/01/02", "2020-01-01 10:00"]) {
    assert.equal(replies[values.indexOf(value)].valid, false, value);
    assert.equal(Number.isNaN(Date.parse(value)), false, `${value}: expected V8's fallback to read it`);
  }
});
