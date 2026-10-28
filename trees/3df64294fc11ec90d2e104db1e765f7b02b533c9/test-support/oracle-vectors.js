/**
 * The JavaScript oracle's answers, frozen (#243). Until the JavaScript CLI
 * was retired, several suites put the Rust implementation and `src/` on the
 * same inputs and required the same answers. Those answers were recorded once
 * from `src/` and committed under `test/fixtures/oracle/`, so the Rust side is
 * still held to what the oracle said.
 *
 * A group is either a list of values, compared whole, or a string of case
 * hashes: for each case, in the order the suite builds them, the first 8 hex
 * digits of the SHA-256 of the expected answer's stable serialization. That
 * is enough to tell a changed answer from an unchanged one, which is all a
 * hash is asked here; it is not a defense against a crafted answer.
 * A mismatch names the case and prints the Rust answer, so it can be read
 * without the oracle.
 *
 * There is no oracle to re-record from. Changing a corpus, or an answer, means
 * deciding that the Rust answer is right and saying so in the change.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";

/** JSON with every object's members sorted, and `undefined` members left out. */
export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item ?? null)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const HASH_DIGITS = 8;

/** The hash a frozen case is compared by. */
export function caseHash(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex").slice(0, HASH_DIGITS);
}

/** The frozen vectors in `test/fixtures/oracle/<name>.json`. */
export function loadVectors(name) {
  return JSON.parse(fs.readFileSync(new URL(`../test/fixtures/oracle/${name}.json`, import.meta.url), "utf8"));
}

/**
 * Hold `actual[index]` to the frozen hash of case `index` in `packed`, for
 * every case. `label(index)` names a case in the failure.
 */
export function assertFrozenHashes(packed, actual, label, group) {
  const hashes = packed.match(new RegExp(`.{${HASH_DIGITS}}`, "g")) ?? [];
  assert.equal(actual.length, hashes.length,
    `${group}: ${actual.length} cases against ${hashes.length} frozen answers; the corpus changed`);
  const mismatches = [];
  for (const [index, value] of actual.entries()) {
    if (caseHash(value) !== hashes[index]) {
      mismatches.push(`${label(index)}\n  Rust: ${stableStringify(value)}`);
      if (mismatches.length === 10) break;
    }
  }
  assert.deepEqual(mismatches, [], `${group}: answers that differ from the frozen oracle`);
}
