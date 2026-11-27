/**
 * Native facts and the fact log (#419; ADR-0047 decisions 5-8,
 * docs/native-history/facts.md): import reads the history of
 * `refs/notes/causet` into the fact log, one entry per notes commit, each
 * record a fact with its object IDs translated to native ones. On the native
 * copy, `cst provenance` and `cst receipts` read those facts through the
 * record source and answer as they answer on the Git-backed original, IDs
 * translated, without running Git; and recording a fact changes no native
 * commit's ID.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { testEnv } from "../test-support/git-environment.js";
import { cstCommand, cstPrefix } from "../test-support/cst-command.js";
import { TYPES, addContainer, containers, names, readContainer } from "../test-support/native-store.js";

const created = [];

after(() => {
  for (const directory of created) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function scratch() {
  const parent = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "causet-native-facts-")));
  created.push(parent);
  return parent;
}

const OPT_IN = { CAUSET_EXPERIMENTAL: "native" };

function cst(cwd, args, env = OPT_IN) {
  return spawnSync(cstCommand, [...cstPrefix(), ...args], { cwd, env: testEnv(env), encoding: "utf8" });
}

/** `cst` with no Git on `PATH`, so any Git process it started would fail. */
function cstWithoutGit(cwd, args) {
  const noGit = fs.mkdtempSync(path.join(scratch(), "no-git-"));
  const env = Object.fromEntries(Object.entries(testEnv(OPT_IN)).filter(([name]) => name.toUpperCase() !== "PATH"));
  env.PATH = noGit;
  return spawnSync(cstCommand, [...cstPrefix(), ...args], { cwd, env, encoding: "utf8" });
}

/**
 * A Git-backed repository whose records the Git-backed cst wrote: commits
 * with declared actors, a compact landing that carries its source's
 * provenance, a declaration made after its commit, a note removed, and a
 * plain commit with no record. Each write is a notes
 * commit, so `refs/notes/causet` has a history.
 */
function makeHistory(format = "sha1") {
  const root = scratch();
  const repo = path.join(root, "source");
  fs.mkdirSync(repo);
  const run = (command, args) => {
    const result = spawnSync(command, args, { cwd: repo, env: testEnv({}), encoding: "utf8" });
    assert.equal(result.status, 0, `${command} ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  };
  const git = (...args) => run("git", args);
  const original = (...args) => run(cstCommand, [...cstPrefix(), ...args]);
  const write = (name, text) => fs.writeFileSync(path.join(repo, name), text);
  git("init", "-q", "-b", "main", `--object-format=${format}`);
  git("config", "user.name", "C O Mitter");
  git("config", "user.email", "committer@example.com");
  write("a.txt", "base\n");
  git("add", "-A");
  original("commit", "-m", "base", "--authored-by", "A U Thor <author@example.com>");
  original("init");
  git("switch", "-q", "-c", "feature");
  write("b.txt", "feature\n");
  git("add", "-A");
  original("commit", "-m", "feature work", "--generated-by", "claude-opus-5-5");
  git("switch", "-q", "main");
  write("c.txt", "main\n");
  git("add", "-A");
  original("commit", "-m", "main work");
  original("merge", "feature", "--compact", "-m", "land feature");
  original("provenance", "declare", "HEAD~1", "--reviewed-by", "R E Viewer <reviewer@example.com>");
  // A notes commit that drops a note: its entry retires the record's fact.
  const base = git("rev-list", "--max-parents=0", "HEAD");
  git("notes", "--ref=causet", "remove", base);
  // A commit with no record, for a declaration after import.
  write("d.txt", "plain\n");
  git("add", "-A");
  git("commit", "-q", "-m", "plain");
  const imported = cst(root, ["import", "source", "native"]);
  assert.equal(imported.status, 0, imported.stderr);
  return { root, repo, native: path.join(root, "native"), format, git, original };
}

/** Git's IDs, whole and as the 12-digit prefixes cst prints, as the native copy names them. */
function translator(history) {
  const full = names(history.native, history.format);
  const short = new Map([...full].map(([git, native]) => [git.slice(0, 12), native.slice(0, 12)]));
  const width = history.format === "sha1" ? 40 : 64;
  return (text) => text
    .replace(new RegExp(`\\b[0-9a-f]{${width}}\\b`, "g"), (id) => full.get(id) ?? id)
    .replace(/\b[0-9a-f]{12}\b/g, (id) => short.get(id) ?? id);
}

/** What the original answers, translated, and what the copy answers without Git. */
function both(history, translate, args) {
  const expected = spawnSync(cstCommand, [...cstPrefix(), ...args], { cwd: history.repo, env: testEnv({}), encoding: "utf8" });
  assert.equal(expected.status, 0, `the original's ${args.join(" ")}: ${expected.stderr}`);
  const answered = cstWithoutGit(history.native, args);
  assert.equal(answered.status, 0, `the copy's ${args.join(" ")}: ${answered.stderr}`);
  return { expected: translate(expected.stdout), answered: answered.stdout };
}

for (const format of ["sha1", "sha256"]) {
  test(`cst provenance and cst receipts on the native copy answer as on the original, IDs translated, without Git (${format})`, () => {
    const history = makeHistory(format);
    const translate = translator(history);
    for (const args of [
      ["provenance", "--json"],
      ["provenance", "HEAD~1", "--json"],
      ["provenance", "HEAD~2", "--json"],
      ["provenance", "feature", "--json"],
      ["provenance", "main", "--all", "--json"],
      ["receipts", "--json"],
    ]) {
      const { expected, answered } = both(history, translate, args);
      assert.deepEqual(JSON.parse(answered), JSON.parse(expected), args.join(" "));
    }
    for (const args of [["provenance"], ["provenance", "--all"], ["provenance", "HEAD~2"], ["receipts"]]) {
      const { expected, answered } = both(history, translate, args);
      assert.equal(answered, expected, args.join(" "));
    }
  });
}

/** The distinct objects of one type a store holds, by their IDs in hex. */
function heldOfType(store, type) {
  const found = new Set();
  for (const file of containers(store)) {
    for (const object of readContainer(file).objects) {
      if (object.type === type) found.add(object.name.toString("hex"));
    }
  }
  return found;
}

test("import writes one fact-log entry for each notes commit, and a fact for each record any notes commit held", () => {
  const history = makeHistory();
  const notesCommits = Number(history.git("rev-list", "--count", "refs/notes/causet"));
  assert.ok(notesCommits >= 5, `the history has ${notesCommits} notes commits`);
  assert.equal(heldOfType(history.native, TYPES.factLogEntry).size, notesCommits);
  // The removed note's record stays held, retired, beside every current one.
  const records = JSON.parse(history.original("receipts", "--json"));
  assert.equal(heldOfType(history.native, TYPES.fact).size, records.length + 1);
  // The store with its facts verifies, and still rebuilds every Git object.
  for (const args of [["fsck"], ["import", "--verify"]]) {
    const answered = cst(history.native, args);
    assert.equal(answered.status, 0, `${args.join(" ")}: ${answered.stderr}${answered.stdout}`);
  }
});

test("cst provenance and cst receipts in a native repository refuse what they do not implement, and need the opt-in", () => {
  const history = makeHistory();
  const declared = cst(history.native, ["provenance", "declare", "HEAD", "--authored-by", "A U Thor <author@example.com>", "--json"]);
  assert.equal(declared.status, 1);
  assert.equal(JSON.parse(declared.stdout).code, "unsupported-feature");
  assert.match(JSON.parse(declared.stdout).message, /cst provenance declare, which records a fact,/);
  const unknown = cst(history.native, ["receipts", "--bogus"]);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /--bogus/);
  for (const command of ["provenance", "receipts"]) {
    const withoutOptIn = cst(history.native, [command], {});
    assert.equal(withoutOptIn.status, 1);
    assert.match(withoutOptIn.stderr, /CAUSET_EXPERIMENTAL=native/);
  }
});

test("recording a fact changes no native commit's ID, and the next import adds it to the fact log", () => {
  const history = makeHistory();
  const commits = () => {
    const answered = cstWithoutGit(history.native, ["log", "main", "feature", "--format=%H %s"]);
    assert.equal(answered.status, 0, answered.stderr);
    return answered.stdout;
  };
  const before = commits();
  const provenanceOf = (revision) => JSON.parse(cstWithoutGit(history.native, ["provenance", revision, "--json"]).stdout).entries;
  assert.equal(provenanceOf("HEAD").length, 0);
  history.original("provenance", "declare", "HEAD", "--authored-by", "A U Thor <author@example.com>");
  const again = cst(history.root, ["import", "source", "native"]);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(commits(), before);
  assert.equal(provenanceOf("HEAD").length, 1);
  const translate = translator(history);
  const { expected, answered } = both(history, translate, ["receipts", "--json"]);
  assert.deepEqual(JSON.parse(answered), JSON.parse(expected));
});

test("fsck finds a fact that names what the store does not hold, and an entry that retires a fact never current", () => {
  const history = makeHistory();
  const id = (byte) => Buffer.concat([Buffer.from([0x01]), Buffer.alloc(32, byte)]);
  const bytes = (text) => Buffer.concat([Buffer.from([text.length]), Buffer.from(text)]);
  // A fact of state 00 with no actor and no subject, whose record in
  // canonical JSON names one object no container holds.
  const fact = Buffer.concat([
    Buffer.from([0x00]), bytes("causet.provenance/v1"), Buffer.from([0x00, 0x00, 0x01]), id(0xab),
    Buffer.from(`{"commit":"${"ab".repeat(32)}","schema":"causet.provenance/v1"}`),
  ]);
  // A shared entry with no parents that retires a fact nothing added.
  const entry = Buffer.concat([Buffer.from([0x01, 0x00, 0x00, 0x01]), id(0xcd), Buffer.from([0x00, 0x00])]);
  addContainer(history.native, [{ type: TYPES.fact, body: fact }, { type: TYPES.factLogEntry, body: entry }]);
  const found = cst(history.native, ["fsck"]);
  assert.equal(found.status, 1);
  assert.match(found.stderr, /the fact [0-9a-f]{64}: it names (ab){32}, which the store does not hold/);
  assert.match(found.stderr, /the fact-log entry [0-9a-f]{64}: it retires (cd){32}, which is not current at its parents/);
});

test("a record import cannot take is a parked fact, held and handed to no reader", () => {
  const history = makeHistory();
  const heldFacts = heldOfType(history.native, TYPES.fact).size;
  const listed = () => JSON.parse(cstWithoutGit(history.native, ["receipts", "--json"]).stdout).length;
  const before = listed();
  // A record of a version this build does not know, on the plain commit.
  const head = history.git("rev-parse", "HEAD");
  const note = JSON.stringify({
    schema: "causet.note/v1",
    records: [{ schema: "causet.provenance/v9", type: "provenance", id: "prov_unknown", commit: head, createdAt: "2026-01-01T00:00:00.000Z" }],
  });
  history.git("notes", "--ref=causet", "add", "-m", note, head);
  const again = cst(history.root, ["import", "source", "native"]);
  assert.equal(again.status, 0, again.stderr);
  // The original lists it, as it lists every record a note holds; the copy
  // holds it as a parked fact, which no reader is handed.
  assert.equal(JSON.parse(history.original("receipts", "--json")).length, before + 1);
  assert.equal(listed(), before);
  assert.equal(heldOfType(history.native, TYPES.fact).size, heldFacts + 1);
});
