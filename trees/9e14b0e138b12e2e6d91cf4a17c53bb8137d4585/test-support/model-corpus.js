/**
 * The inputs `test/rust-model.test.js` puts to the Rust record model. They are
 * deterministic, and the JavaScript oracle's answers to exactly these inputs
 * are frozen in `test/fixtures/oracle/model.json` (#243), so any change here
 * invalidates those answers.
 */
import fs from "node:fs";

/** A deterministic generator, so a failure names a reproducible case. */
export function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

// Member names that need escaping are left out of the generated documents:
// V8 14.6 (Node 26.4) can hand a later JSON.parse the wrong escaped name once
// an earlier object primed the same member-name path, which made the oracle
// itself wrong. They are checked against fixed expectations instead.
const KEYS = ["", "a", "A", "b", "aa", "a a", "~", "_", "é", "É", "😀", "ﬁ", "0", "1", "2", "10", "01", "-1",
  "4294967294", "4294967295", "1.5", "integrity", "signatures", "__proto__", "constructor"];
const STRINGS = ["", "plain", "é😀ﬁ", "\u0000\u0001\b\t\n\f\r\u001f", "  ", "\"\\/", "\ud800", "\udfff",
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

/** 1,500 generated documents, then spellings JSON.stringify never writes. */
export function generatedTexts() {
  const next = random(142);
  const texts = Array.from({ length: 1500 }, () => JSON.stringify(generate(next, 0)));
  texts.push("-0", "[-0]", "{\"a\":-0.0}", "1.0", "1e2", "1E+2", "10e-1", "0.1e1", "1e400", "-1e400",
    "123456789012345678901234567890", "{\"b\":1,\"a\":2,\"b\":3}", "{\"10\":1,\"2\":2,\"a\":3,\"1\":4}",
    " \t\n\r{ \"a\" : [ 1 , 2 ] } ", "\"\\u00e9\\ud83d\\ude00\\/\"", "{\"integrity\":1,\"signatures\":2,\"x\":3}");
  return texts;
}

/**
 * Every family's registered versions, version 0 and the next version, in both
 * spellings, after identifiers that are no schema at all. `registry` is the
 * model's `registry` reply.
 */
export function schemaCorpus(registry) {
  const corpus = [null, 7, "", "causet", "causet.landing", "causet.landing/v", "causet.landing/v1x", "/v1",
    "causet.nope/v1", "vcs-lab.nope/v1", "vcs-lab.", "causet.landing/v01", "causet.landing/v1/v2",
    "causet.lan\nding/v1", "causet.landing/v99999999999999999999", "VCS-LAB.landing/v1", "vcs-labs.landing/v1"];
  for (const { name, registered } of registry.families) {
    const bare = name.slice(registry.schemaNamespace.length);
    for (const version of [...registered, 0, Math.max(...registered) + 1]) {
      corpus.push(`${name}/v${version}`, `${registry.legacyNamespace}${bare}/v${version}`);
    }
  }
  return corpus;
}

/** Each schema in the corpus under three expected families and two recoveries. */
export function readableCases(registry) {
  const cases = [];
  for (const schema of schemaCorpus(registry)) {
    for (const family of [null, "causet.forecast", "causet.landing"]) {
      for (const recovery of ["", "Read it with the causet build that wrote it."]) {
        cases.push({ schema, family, recovery, subject: "The record at 'x'" });
      }
    }
  }
  return cases;
}

const OID = "a".repeat(40);
const OID2 = "b".repeat(40);
const TREE = "c".repeat(40);

/** Real records of eight families, and templates for the three the fixture lacks. */
export function baseRecords() {
  const fixture = JSON.parse(fs.readFileSync(new URL("../test/fixtures/legacy-0.19.1/fixture.json", import.meta.url), "utf8"));
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

/** Each record, and every record one member away from it, as JSON text. */
export function recordCorpus() {
  const corpus = [];
  for (const record of baseRecords()) {
    corpus.push(record, { ...record, attachedTo: record.commit ?? OID }, { ...record, attachedTo: "nope" });
    for (const field of Object.keys(record)) {
      if (field === "schema") continue;
      const { [field]: _removed, ...without } = record;
      corpus.push(without);
      for (const value of REPLACEMENTS) {
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
  return corpus.map((record) => JSON.stringify(record));
}

/** Resolution stages, malformed ones first, then the real resolution records. */
export function signatureStages() {
  const stages = [{}, { base: null, ours: null, theirs: null }, { base: { blob: OID, mode: "100644" } },
    { ours: { mode: "100644", blob: OID }, theirs: [1, "2"], extra: true }, [], "text", 5];
  for (const record of baseRecords().filter((record) => record.schema.endsWith(".resolution/v1"))) stages.push(record);
  return stages.map((value) => JSON.stringify(value));
}

/** Logical identifiers the parser must judge, valid and not. */
export const LOGICAL_ID_VALUES = [undefined, null, 5, "", "git:abc", "ch_0mulzqqkl9a8129884dd6",
  "reconcile_op_0mulzqqkl9a8129884dd6", "zzz_0mulzqqkl9a8129884dd6", "Ch_0mulzqqkl9a8129884dd6",
  "ch_0mulzqqkl9a8129884dd", "ch_0mulzqqkl9a8129884ddG", "_ch_0mulzqqkl9a8129884dd6", "ch__0mulzqqkl9a8129884dd6",
  "ch_0MULZQQKL9A8129884DD6", "ché_0mulzqqkl9a8129884dd6"];

/** What V8's Date.parse fallback accepts and the format does not, then 3,000 generated values. */
export function dateValues() {
  const next = random(173);
  const two = (limit) => String(Math.floor(next() * limit)).padStart(2, "0");
  const values = ["1", "March 7, 2006", "2020/01/02", "2020-01-01 10:00", "2020-1-1", "+2020-01-01", "20201-01",
    "-000000-01-01", "+000002-13", "+000000-01-01", "-271821-04-19T23:00-01:00", "-271821-04-19T23:59:59.999Z",
    "+275760-09-13T00:00:00.000Z", "+275760-09-13T00:00:00.001Z", "2020-01-01T10:00:00.000Z ", ""];
  for (let index = 0; index < 3000; index += 1) {
    const year = next() < 0.2
      ? `${next() < 0.5 ? "+" : "-"}${String(Math.floor(next() * (next() < 0.3 ? 3 : 300000))).padStart(6, "0")}`
      : String(Math.floor(next() * 10000)).padStart(next() < 0.05 ? 5 : 4, "0");
    let value = year;
    if (next() < 0.9) value += `-${two(14)}`;
    if (next() < 0.8) value += `-${two(33)}`;
    if (next() < 0.7) {
      value += `${next() < 0.05 ? " " : "T"}${two(26)}:${two(62)}`;
      if (next() < 0.8) value += `:${two(62)}`;
      if (next() < 0.5) value += `.${String(Math.floor(next() * 10000)).slice(0, 1 + Math.floor(next() * 4))}`;
      const zone = next();
      if (zone < 0.4) value += "Z";
      else if (zone < 0.6) value += `${next() < 0.5 ? "+" : "-"}${two(26)}:${two(62)}`;
    }
    values.push(value);
  }
  return values;
}
