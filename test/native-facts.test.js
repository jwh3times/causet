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
import { TYPES, addContainer, containers, heldBodies, names, readContainer } from "../test-support/native-store.js";

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

/**
 * A Git-backed repository with disputes (ADR-0030): a peer clone altered two
 * provenance records under their IDs and exported them, this repository
 * imported the envelope with `--park-conflicts`, which parked both copies
 * under `refs/causet/quarantine/`, and settled the first with `--keep-local`,
 * which removed its parked copy and recorded a disposition. One dispute stays
 * open, so its record and the parked copy are both unused.
 */
function makeDisputes(format = "sha1") {
  const root = scratch();
  const peer = path.join(root, "peer");
  const repo = path.join(root, "source");
  fs.mkdirSync(peer);
  const runIn = (cwd, command, args, input) => {
    const result = spawnSync(command, args, { cwd, env: testEnv({}), encoding: "utf8", input });
    assert.equal(result.status, 0, `${command} ${args.join(" ")}: ${result.stderr}${result.stdout}`);
    return result.stdout.trim();
  };
  const gitIn = (cwd, ...args) => runIn(cwd, "git", args);
  const cstIn = (cwd, ...args) => runIn(cwd, cstCommand, [...cstPrefix(), ...args]);
  const configure = (cwd) => {
    gitIn(cwd, "config", "user.name", "C O Mitter");
    gitIn(cwd, "config", "user.email", "committer@example.com");
  };
  gitIn(peer, "init", "-q", "-b", "main", `--object-format=${format}`);
  configure(peer);
  cstIn(peer, "init");
  for (const name of ["a", "b"]) {
    fs.writeFileSync(path.join(peer, `${name}.txt`), `${name}\n`);
    gitIn(peer, "add", "-A");
    cstIn(peer, "commit", "-m", `add ${name}`, "--authored-by", "A U Thor <author@example.com>");
  }
  gitIn(root, "clone", "--no-local", "--quiet", peer, repo);
  configure(repo);
  gitIn(repo, "fetch", "-q", "origin", "refs/notes/causet:refs/notes/causet");
  cstIn(repo, "init");
  // The peer's copies now say something else under the same IDs.
  const ids = [];
  for (const commit of [gitIn(peer, "rev-parse", "HEAD~1"), gitIn(peer, "rev-parse", "HEAD")]) {
    const container = JSON.parse(gitIn(peer, "notes", "--ref=causet", "show", commit));
    container.records = container.records.map((record) => ({ ...record, createdAt: "2001-01-01T00:00:00.000Z" }));
    ids.push(container.records[0].id);
    runIn(peer, "git", ["notes", "--ref=causet", "add", "-f", "-F", "-", commit], `${JSON.stringify(container, null, 2)}\n`);
  }
  const envelope = path.join(root, "envelope");
  cstIn(peer, "metadata", "export", envelope);
  cstIn(repo, "metadata", "import", envelope, "--apply", "--park-conflicts");
  cstIn(repo, "metadata", "dispose", ids[0], "--keep-local", "--reason", "the peer altered our record");
  // A checkpoint ref, which the inventory reads from the snapshot.
  gitIn(repo, "update-ref", "refs/causet/checkpoints/ws_one", gitIn(repo, "rev-parse", "HEAD"));
  const imported = cst(root, ["import", "source", "native"]);
  assert.equal(imported.status, 0, imported.stderr);
  return {
    root, repo, native: path.join(root, "native"), format, ids,
    git: (...args) => gitIn(repo, ...args), original: (...args) => cstIn(repo, ...args),
  };
}

/** A fact's body, read as facts.md §3.1 lays it out, enough to tell its kind. */
function factOf(body) {
  const bytesAt = (at) => {
    let length = 0;
    let shift = 0;
    for (;;) {
      const byte = body[at++];
      length += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (byte < 0x80) break;
    }
    return [body.subarray(at, at + length), at + length];
  };
  if (body[0] === 0x00) return { state: 0, schema: bytesAt(1)[0].toString() };
  const [place, next] = bytesAt(2);
  return { state: 1, reason: body[1], place: place.toString(), id: body[next] === 1 ? bytesAt(next + 1)[0].toString() : null };
}

test("import writes the local chain: a parked fact for each disputed copy, a fact for each disposition, and one entry with no parents", () => {
  const history = makeDisputes();
  const facts = [...heldBodies(history.native, TYPES.fact).values()].map(factOf);
  const disputed = facts.filter((fact) => fact.state === 1 && fact.reason === 0x04);
  // The open dispute's copy, parked under the peer's lineage; the settled
  // one's copy was removed when it was disposed of.
  assert.equal(disputed.length, 1);
  assert.equal(disputed[0].id, history.ids[1]);
  assert.match(disputed[0].place, new RegExp(`^lineage_[0-9a-f]{64}/${history.ids[1]}$`));
  assert.equal(facts.filter((fact) => fact.state === 0 && fact.schema === "causet.disposition/v1").length, 1);
  const local = [...heldBodies(history.native, TYPES.factLogEntry).values()].filter((body) => body[0] === 0x02);
  assert.equal(local.length, 1);
  assert.equal(local[0][1], 0x00, "the local entry has no parents");
  for (const args of [["fsck"], ["import", "--verify"]]) {
    const answered = cst(history.native, args);
    assert.equal(answered.status, 0, `${args.join(" ")}: ${answered.stderr}${answered.stdout}`);
  }
});

/**
 * Moves a repository's records to the names used before causet: its notes
 * ref, the refs under `refs/causet/`, and its shared-local directory, as a
 * build older than causet kept them, so the Git-backed cst refuses it until
 * `cst migrate`.
 */
function toLegacyNames(history) {
  const listed = history.git("for-each-ref", "--format=%(refname) %(objectname)", "refs/notes/causet", "refs/causet/");
  for (const line of listed.split("\n").filter(Boolean)) {
    const [name, id] = line.split(" ");
    const legacy = name.replace(/^refs\/notes\/causet$/, "refs/notes/vcs-lab").replace(/^refs\/causet\//, "refs/vcs-lab/");
    history.git("update-ref", legacy, id);
    history.git("update-ref", "-d", name);
  }
  const common = path.join(history.repo, ".git");
  fs.renameSync(path.join(common, "causet"), path.join(common, "vcs-lab"));
}

/** Every fact and fact-log entry a store holds, by ID. */
function factLog(store) {
  return {
    facts: [...heldBodies(store, TYPES.fact).keys()].sort(),
    entries: [...heldBodies(store, TYPES.factLogEntry).keys()].sort(),
  };
}

test("a repository with the legacy names gives the facts and fact log its current names give", () => {
  const history = makeDisputes();
  const current = factLog(history.native);
  assert.ok(current.facts.length > 3 && current.entries.length > 3);
  toLegacyNames(history);
  const refused = cst(history.repo, ["receipts"], {});
  assert.equal(refused.status, 1, "the Git-backed cst refuses the legacy names");
  const imported = cst(history.root, ["import", "source", "legacy"]);
  assert.equal(imported.status, 0, imported.stderr);
  assert.deepEqual(factLog(path.join(history.root, "legacy")), current);
});

test("refs/causet/retention stays in the snapshot, and nothing is derived from it", () => {
  const history = makeDisputes();
  const before = factLog(history.native);
  // It updates the ref, and exits 1 for the open dispute's diagnostics.
  cst(history.repo, ["metadata", "retain", "--apply"], {});
  const retained = history.git("rev-parse", "refs/causet/retention");
  const again = cst(history.root, ["import", "source", "native"]);
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual(factLog(history.native), before);
  const listed = cstWithoutGit(history.native, ["rev-parse", "--git-id", "refs/causet/retention"]);
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(listed.stdout.trim(), retained);
});

/** What the original answers and its exit status, translated, and what the copy answers without Git. */
function bothWithStatus(history, translate, args) {
  const expected = cst(history.repo, args, {});
  const answered = cstWithoutGit(history.native, args);
  assert.equal(answered.status, expected.status, `${args.join(" ")}: ${answered.stderr}${answered.stdout}`);
  return { expected: translate(expected.stdout), answered: answered.stdout };
}

/**
 * The original's report as the copy gives it: the copy's root, and no
 * worktree-private state, since a native repository has no working copy
 * until N3 (facts.md §5.4).
 */
function asCopy(report, history) {
  report.repository.root = history.native;
  report.scopes.worktreePrivate = { worktreeCount: 0, pendingOperationCount: 0, forecastCount: 0, worktrees: [] };
  return report;
}

for (const format of ["sha1", "sha256"]) {
  test(`cst metadata status and validate on the native copy answer as on the original, IDs translated, without Git (${format})`, () => {
    const history = makeDisputes(format);
    const translate = translator(history);
    for (const args of [["metadata", "status", "--json"], ["metadata", "validate", "--json"], ["metadata", "validate", "--strict", "--json"]]) {
      const { expected, answered } = bothWithStatus(history, translate, args);
      assert.deepEqual(JSON.parse(answered), asCopy(JSON.parse(expected), history), args.join(" "));
    }
    for (const args of [["metadata", "status"], ["metadata", "validate"]]) {
      const { expected, answered } = bothWithStatus(history, translate, args);
      assert.equal(answered, expected.replace(`repository   ${history.repo}`, `repository   ${history.native}`), args.join(" "));
    }
  });
}

/** Adds a note holding `text` to `commit` of the original, and imports the original again. */
function noteAndImport(history, commit, text) {
  const added = spawnSync("git", ["notes", "--ref=causet", "add", "-f", "-F", "-", commit], { cwd: history.repo, env: testEnv({}), input: text });
  assert.equal(added.status, 0, String(added.stderr));
  const again = cst(history.root, ["import", "source", "native"]);
  assert.equal(again.status, 0, again.stderr);
}

test("parked notes and records are reported on the native copy as the original reports them", () => {
  const history = makeHistory();
  // A note that is not JSON, and one holding a record of an unknown version.
  noteAndImport(history, history.git("rev-parse", "HEAD"), "not json\n");
  const unknown = {
    schema: "causet.note/v1",
    records: [{ schema: "causet.provenance/v9", type: "provenance", id: "prov_unknown", commit: history.git("rev-parse", "HEAD~1"), createdAt: "2026-01-01T00:00:00.000Z" }],
  };
  noteAndImport(history, history.git("rev-parse", "HEAD~1"), `${JSON.stringify(unknown)}\n`);
  // A note holding the same record twice: one fact, and a repeated copy that
  // keeps its ID conflicted, as the original counts both.
  const twice = JSON.parse(history.git("notes", "--ref=causet", "show", "HEAD~2"));
  const repeated = { ...twice, records: [twice.records[0], twice.records[0]] };
  noteAndImport(history, history.git("rev-parse", "HEAD~2"), `${JSON.stringify(repeated)}\n`);
  const translate = translator(history);
  for (const args of [["metadata", "status", "--json"], ["metadata", "validate", "--strict", "--json"]]) {
    const { expected, answered } = bothWithStatus(history, translate, args);
    const report = JSON.parse(answered);
    assert.deepEqual(report, asCopy(JSON.parse(expected), history), args.join(" "));
    assert.ok(report.diagnostics.some((item) => item.code === "malformed-record"));
    assert.ok(report.diagnostics.some((item) => item.code === "unknown-schema"));
    assert.ok(report.diagnostics.some((item) => item.code === "record-id-conflict"));
  }
});

test("a record the validators accept but import parks, such as one holding a fraction, is reported and used by no reader", () => {
  const history = makeHistory();
  const head = history.git("rev-parse", "HEAD");
  const record = {
    schema: "causet.provenance/v1", type: "provenance", id: "prov_fraction0001", commit: head, changeId: null,
    origin: "declared", carriedFrom: [], actors: [{ role: "authored", actor: "A U Thor <author@example.com>" }],
    createdAt: "2026-01-01T00:00:00.000Z", weight: 0.5,
  };
  noteAndImport(history, head, `${JSON.stringify({ schema: "causet.note/v1", records: [record] })}\n`);
  const original = JSON.parse(history.original("metadata", "status", "--json"));
  const copy = JSON.parse(cstWithoutGit(history.native, ["metadata", "status", "--json"]).stdout);
  const summary = (report) => report.scopes.sharedPortable.notes.records.find((item) => item.id === "prov_fraction0001");
  assert.equal(summary(original).valid, true, "the original accepts it");
  assert.equal(summary(copy).valid, false);
  assert.deepEqual(summary(copy).diagnostics, ["parked-fact"]);
  assert.equal(summary(copy).digest, summary(original).digest, "its digest is its Git record's");
  assert.equal(copy.summary.acceptedPortableRecords, original.summary.acceptedPortableRecords - 1);
  const parked = copy.diagnostics.filter((item) => item.code === "parked-fact");
  assert.equal(parked.length, 1);
  assert.equal(parked[0].severity, "warning");
  assert.equal(parked[0].subject, "prov_fraction0001");
  assert.match(parked[0].message, /reason 02/);
  // A warning: validate passes, and --strict refuses it.
  assert.equal(cstWithoutGit(history.native, ["metadata", "validate"]).status, 0);
  assert.equal(cstWithoutGit(history.native, ["metadata", "validate", "--strict"]).status, 1);
  assert.equal(cstWithoutGit(history.native, ["provenance", "HEAD", "--json"]).status, 0);
  assert.deepEqual(JSON.parse(cstWithoutGit(history.native, ["provenance", "HEAD", "--json"]).stdout).entries, []);
});

test("the copy of a repository with the legacy names reports what the original reports once migrated", () => {
  const history = makeDisputes();
  toLegacyNames(history);
  const imported = cst(history.root, ["import", "source", "legacy"]);
  assert.equal(imported.status, 0, imported.stderr);
  history.original("migrate");
  const copy = { ...history, native: path.join(history.root, "legacy") };
  const translate = translator(copy);
  for (const args of [["metadata", "status", "--json"], ["metadata", "validate", "--json"]]) {
    const { expected, answered } = bothWithStatus(copy, translate, args);
    assert.deepEqual(JSON.parse(answered), asCopy(JSON.parse(expected), copy), args.join(" "));
  }
});

test("cst metadata in a native repository refuses what it does not implement", () => {
  const history = makeHistory();
  for (const subcommand of [["export", "envelope"], ["retain", "--apply"], ["dispose", "prov_x", "--keep-local"]]) {
    const refused = cst(history.native, ["metadata", ...subcommand, "--json"]);
    assert.equal(refused.status, 1, subcommand.join(" "));
    assert.equal(JSON.parse(refused.stdout).code, "unsupported-feature", subcommand.join(" "));
  }
  const withoutOptIn = cst(history.native, ["metadata", "status"], {});
  assert.equal(withoutOptIn.status, 1);
  assert.match(withoutOptIn.stderr, /CAUSET_EXPERIMENTAL=native/);
});

test("workspaces.json and migration.json are not imported", () => {
  const history = makeDisputes();
  const before = factLog(history.native);
  const runtime = path.join(history.repo, ".git", "causet");
  fs.writeFileSync(path.join(runtime, "workspaces.json"), `${JSON.stringify({ schema: "causet.workspaces/v1", workspaces: [{ id: "ws_1", name: "one", path: history.repo }] })}\n`);
  const original = JSON.parse(history.original("metadata", "status", "--json"));
  assert.equal(original.scopes.sharedLocal.workspaceRegistry.count, 1);
  // The marker `cst migrate` leaves: a native repository has no migration window.
  fs.writeFileSync(path.join(runtime, "migration.json"), `${JSON.stringify({ schema: "causet.migration/v1", migratedAt: "2026-01-01T00:00:00.000Z" })}\n`);
  const again = cst(history.root, ["import", "source", "native"]);
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual(factLog(history.native), before);
  const copy = JSON.parse(cstWithoutGit(history.native, ["metadata", "status", "--json"]).stdout);
  assert.deepEqual(copy.scopes.sharedLocal.workspaceRegistry, { present: false, schema: null, count: 0, workspaces: [] });
});

test("a dispute settled on the original after an import is settled on the copy by the next import", () => {
  const history = makeDisputes();
  const before = JSON.parse(cstWithoutGit(history.native, ["metadata", "status", "--json"]).stdout);
  assert.equal(before.scopes.sharedLocal.quarantine.refCount, 1);
  history.original("metadata", "dispose", history.ids[1], "--replace-local", "--reason", "the peer was right");
  const again = cst(history.root, ["import", "source", "native"]);
  assert.equal(again.status, 0, again.stderr);
  const translate = translator(history);
  for (const args of [["metadata", "status", "--json"], ["metadata", "validate", "--strict", "--json"]]) {
    const { expected, answered } = bothWithStatus(history, translate, args);
    const report = JSON.parse(answered);
    assert.deepEqual(report, asCopy(JSON.parse(expected), history), args.join(" "));
    assert.equal(report.scopes.sharedLocal.quarantine.refCount, 0);
    assert.equal(report.scopes.sharedLocal.dispositions.count, 2);
  }
  // An import that finds nothing new writes no local entry.
  const entries = factLog(history.native).entries;
  const third = cst(history.root, ["import", "source", "native"]);
  assert.equal(third.status, 0, third.stderr);
  assert.deepEqual(factLog(history.native).entries, entries);
});
