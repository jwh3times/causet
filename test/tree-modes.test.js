/**
 * Tree entry modes at the Git-side tree readers (#332) and the note writer
 * (#370), held to real Git on trees written literally. Equality alone cannot
 * tell these readers from their fallback, which also answers with Git, so each
 * reader test also holds what the read cost: no `git notes` process, no
 * fallback recorded.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { cstCommand, cstPrefix } from "../test-support/cst-command.js";
import { available, probe, unavailableReason } from "../test-support/engine-probe.js";
import { testEnv } from "../test-support/git-environment.js";

const skip = available ? false : unavailableReason;

const READABLE_MODES = {
  "an overlong": { file: "10000000000000000000000000100644", directory: "10000000000000000000000000040000" },
  "a zero-padded": { file: "0100644", directory: "040000" },
};
const REFUSED_MODES = ["+100644", "-100644", "100648"];

function fixture(t) {
  const cwd = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "causet-tree-modes-")));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const env = testEnv({ CAUSET_GIT_SESSION: "1" });
  const run = (args, input, encoding = "utf8") => spawnSync("git", args, {
    cwd, env, input, encoding, windowsHide: true,
  });
  const git = (args, input) => {
    const result = run(args, input);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(["init", "-q", "--object-format=sha1"]);
  git(["config", "user.name", "Tree modes fixture"]);
  git(["config", "user.email", "modes@example.invalid"]);
  const blob = git(["hash-object", "-w", "--stdin"], "note\n");
  /** A tree of `[mode, name, oid]` entries, exactly as given. */
  const literal = (entries) => git(["hash-object", "--literally", "-w", "-t", "tree", "--stdin"],
    Buffer.concat(entries.flatMap(([mode, name, oid]) => [
      Buffer.from(`${mode} ${name}\0`), Buffer.from(oid, "hex"),
    ])));
  const publish = (tree) => git(["update-ref", "refs/notes/causet",
    git(["commit-tree", tree, "-m", "Notes fixture"])]);
  const oracle = () => {
    const output = git(["notes", "--ref=causet", "list"]);
    return output.split(/\r?\n/).filter(Boolean).map((line) => {
      const [note, target] = line.split(" ");
      return { note, target };
    });
  };
  // The native backend refuses a repository opened under injected config.
  const probeEnv = { ...env };
  delete probeEnv.GIT_CONFIG_COUNT;
  const call = (engine, op, args, session = false) =>
    probe([{ cwd, engine, session, calls: [{ op, args }] }], probeEnv)[0].results[0];
  return { cwd, env, blob, git, run, literal, publish, oracle, call };
}

const answer = ({ value, error }) => (error ? { code: error.code, message: error.message } : { value });
const ranGitNotes = ({ metrics }) => metrics.commands.some((entry) => entry.command === "notes");

function assertNative(reply, operation) {
  assert.deepEqual(reply.metrics.fallbacks, []);
  assert.deepEqual(reply.metrics.nativeReads, { [operation]: 1 });
  assert.equal(reply.metrics.processes, 0);
}

for (const [name, modes] of Object.entries(READABLE_MODES)) {
  test(`${name} mode lists notes as Git does, without running git notes`, { skip }, (t) => {
    const f = fixture(t);
    const flat = "a".repeat(40);
    const deep = "b".repeat(40);
    f.publish(f.literal([
      [modes.file, flat, f.blob],
      [modes.directory, deep.slice(0, 2), f.literal([[modes.file, deep.slice(2), f.blob]])],
    ]));
    const expected = f.oracle();
    assert.deepEqual(expected, [{ note: f.blob, target: flat }, { note: f.blob, target: deep }]);

    const session = f.call("git", "listNoteEntries", ["causet"], true);
    assert.deepEqual(session.value, expected);
    assert.equal(ranGitNotes(session), false);

    const native = f.call("native", "listNoteEntries", ["causet"]);
    assert.deepEqual(native.value, expected);
    assertNative(native, "listNoteEntries");
  });

  test(`${name} mode peels to a tree's result as Git does, without a fallback`, { skip }, (t) => {
    const f = fixture(t);
    const tree = f.literal([[modes.file, "result", f.blob]]);
    const expression = `${tree}:result`;
    assert.equal(f.git(["rev-parse", expression]), f.blob);

    const native = f.call("native", "readGitObjects", [[expression]]);
    assert.equal(native.value[0].oid, f.blob);
    assert.deepEqual(native.value, f.call("git", "readGitObjects", [[expression]]).value);
    assertNative(native, "readGitObjects");
  });
}

for (const mode of REFUSED_MODES) {
  test(`mode ${mode}, which Git refuses, is refused natively and answered by Git`, { skip }, (t) => {
    const f = fixture(t);
    const tree = f.literal([[mode, "a".repeat(40), f.blob], [mode, "result", f.blob]]);
    f.publish(tree);
    assert.notEqual(f.run(["notes", "--ref=causet", "list"]).status, 0, "Git refuses the mode");
    assert.notEqual(f.run(["rev-parse", "--verify", `${tree}:result`]).status, 0, "Git refuses the mode");
    const refused = (operation) => [{ operation, reason: "native-error", count: 1 }];

    const session = f.call("git", "listNoteEntries", ["causet"], true);
    assert.equal(ranGitNotes(session), true);

    const notes = f.call("native", "listNoteEntries", ["causet"]);
    assert.deepEqual(notes.metrics.fallbacks, refused("listNoteEntries"));
    assert.deepEqual(answer(notes), answer(f.call("git", "listNoteEntries", ["causet"])));

    const objects = f.call("native", "readGitObjects", [[`${tree}:result`]]);
    assert.deepEqual(objects.metrics.fallbacks, refused("readGitObjects"));
    assert.deepEqual(answer(objects), answer(f.call("git", "readGitObjects", [[`${tree}:result`]])));
  });
}

// The note writer rebuilds the notes tree with `git mktree`, which does not read
// a mode as Git's tree reader does: an overlong one saturates rather than wraps,
// and a zero-padded directory had to be labelled a tree (#370). Each test starts
// from a commit causet has not attached to, so the note is the only change.
function noteWriter(t, accept = () => true) {
  const f = fixture(t);
  let head = "";
  for (let attempt = 0; !head || !accept(head); attempt += 1) {
    f.git(["commit", "-q", "--allow-empty", "-m", `Attachment ${attempt}`]);
    head = f.git(["rev-parse", "HEAD"]);
  }
  const cst = (args) => spawnSync(cstCommand, [...cstPrefix(), ...args], {
    cwd: f.cwd, env: testEnv(), encoding: "utf8", windowsHide: true,
  });
  const declare = () => cst(["provenance", "declare", head, "--authored-by", "human:modes", "--json"]);
  const notes = () => f.git(["rev-parse", "refs/notes/causet"]);
  const rawTree = () => f.run(["cat-file", "tree", "refs/notes/causet^{tree}"], undefined, "latin1").stdout;
  return { ...f, head, cst, declare, notes, rawTree };
}

function assertRefused(f, before) {
  const result = f.declare();
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.equal(f.notes(), before, "the notes did not move");
  return JSON.parse(result.stdout);
}

for (const [name, modes] of Object.entries(READABLE_MODES)) {
  test(`${name} mode on a note keeps that note listed when another is written`, (t) => {
    const f = noteWriter(t);
    const other = "a".repeat(40);
    f.publish(f.literal([[modes.file, other, f.blob]]));

    const result = f.declare();
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(f.oracle().map(({ target }) => target).sort(), [other, f.head].sort());
  });

  test(`${name} mode on a fan-out directory takes the new note inside it`, (t) => {
    const f = noteWriter(t);
    const other = `${f.head.slice(0, 2)}${"a".repeat(38)}`;
    f.publish(f.literal([[modes.directory, f.head.slice(0, 2), f.literal([[modes.file, other.slice(2), f.blob]])]]));

    const result = f.declare();
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(f.oracle().map(({ target }) => target).sort(), [other, f.head].sort());
    assert.ok(f.git(["rev-parse", `refs/notes/causet:${f.head.slice(0, 2)}/${f.head.slice(2)}`]));
  });

  test(`${name} mode on a directory at the attachment path is never overwritten`, (t) => {
    const f = noteWriter(t);
    const opaque = f.literal([["100644", "opaque.txt", f.blob]]);
    f.publish(f.literal([[modes.directory, f.head, opaque]]));

    assert.match(assertRefused(f, f.notes()).message, /non-note object occupies/);
    assert.equal(f.git(["rev-parse", `refs/notes/causet:${f.head}/opaque.txt`]), f.blob);
  });
}

test("an overlong gitlink mode at the attachment path is never overwritten", (t) => {
  const f = noteWriter(t);
  f.publish(f.literal([["10000000000000000000000000160000", f.head, f.head]]));

  assert.match(assertRefused(f, f.notes()).message, /non-note object occupies/);
});

// Git takes only a regular file for a note (`load_subtree` in its `notes.c`), so
// these don't list, and `37777777777` is what the writer left before #370 in
// place of an overlong note's mode: its records are still in the blob.
for (const mode of ["37777777777", "170000", "120000", "0"]) {
  test(`mode ${mode}, not a note to Git, at the attachment path is never overwritten`, (t) => {
    const f = noteWriter(t);
    f.publish(f.literal([[mode, f.head, f.blob]]));
    assert.deepEqual(f.oracle(), []);

    assert.match(assertRefused(f, f.notes()).message, /non-note object occupies/);
    assert.ok(f.rawTree().includes(`${mode} ${f.head}\0`), "the entry is untouched");
  });
}

test("a mode only Git's reader gives a meaning keeps its entry when a note is written", (t) => {
  const f = noteWriter(t);
  const damaged = "a".repeat(40);
  f.publish(f.literal([["37777777777", damaged, f.blob]]));

  const result = f.declare();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(f.oracle().map(({ target }) => target), [f.head]);
  assert.ok(f.rawTree().includes(`37777777777 ${damaged}\0`), "the entry is untouched");
});

// Git reads a note path's hex in either case (`get_oid_hex_segment` in its
// `notes.c`) and concatenates every note it finds for one commit, so the writer
// finds a note under any spelling and leaves the commit one entry, in lowercase
// as Git writes it (#381). Each commit's hex opens with two letters, so its
// fan-out directory has spellings too.
function spelledWriter(t) {
  const f = noteWriter(t, (head) => /^[a-f]{2}/.test(head));
  const upper = (text) => text.toUpperCase();
  const fanOut = f.head.slice(0, 2);
  const leaf = f.head.slice(2);
  const note = (type) => f.git(["hash-object", "-w", "--stdin"],
    `{"schema":"causet.note/v1","records":[{"type":"${type}"}]}\n`);
  /** Every path in the notes tree that names this commit, in any spelling. */
  const paths = () => f.git(["ls-tree", "-r", "--name-only", "refs/notes/causet"])
    .split(/\r?\n/).filter((name) => name.replace("/", "").toLowerCase() === f.head);
  const shown = () => JSON.parse(f.git(["notes", "--ref=causet", "show", f.head]));
  const provenance = () => {
    const result = f.cst(["provenance", f.head, "--json"]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return JSON.parse(result.stdout).entries;
  };
  return { ...f, upper, fanOut, leaf, note, paths, shown, provenance };
}

function assertOneNote(f, result) {
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const paths = f.paths();
  assert.equal(paths.length, 1, `one entry for the commit: ${paths.join(", ")}`);
  assert.equal(paths[0], paths[0].toLowerCase(), "the entry is spelled in lowercase");
  assert.equal(f.provenance().length, 1, "the declared provenance is read back");
  return f.shown().records;
}

const ONE_SPELLING = {
  "a lowercase note path": (f, note) => [["100644", f.head, note]],
  "an uppercase note path": (f, note) => [["100644", f.upper(f.head), note]],
  "a mixed-case note path": (f, note) => [["100644", f.head.replace(/[a-f]/g, (c, at) => (at % 2 ? c : f.upper(c))), note]],
  "an uppercase fan-out directory": (f, note) => [["40000", f.upper(f.fanOut), f.literal([["100644", f.leaf, note]])]],
  "an uppercase note path in a fan-out directory": (f, note) => [["40000", f.fanOut, f.literal([["100644", f.upper(f.leaf), note]])]],
};

for (const [name, tree] of Object.entries(ONE_SPELLING)) {
  test(`a note under ${name} gets the new record, and stays one note`, (t) => {
    const f = spelledWriter(t);
    f.publish(f.literal(tree(f, f.note("keep-me"))));
    assert.equal(f.oracle().length, 1, "Git lists the note");

    const records = assertOneNote(f, f.declare());
    assert.deepEqual(records.map(({ type }) => type), ["keep-me", "provenance"]);
  });
}

// Git shows both notes, concatenated, which is no JSON document: the writer keeps
// that text as a legacy note, as it keeps any note it cannot parse, so no record
// is lost when the second spelling goes.
const TWO_SPELLINGS = {
  "two spellings of a note path": (f, upper, lower) => [
    ["100644", f.upper(f.head), upper],
    ["100644", f.head, lower],
  ],
  "a note path and an uppercase fan-out directory": (f, upper, lower) => [
    ["40000", f.upper(f.fanOut), f.literal([["100644", f.leaf, upper]])],
    ["100644", f.head, lower],
  ],
  "both spellings of a fan-out directory": (f, upper, lower) => [
    ["40000", f.upper(f.fanOut), f.literal([["100644", f.leaf, upper]])],
    ["40000", f.fanOut, f.literal([["100644", f.leaf, lower]])],
  ],
};

for (const [name, tree] of Object.entries(TWO_SPELLINGS)) {
  test(`a commit noted under ${name} keeps both notes' text in one note`, (t) => {
    const f = spelledWriter(t);
    f.publish(f.literal(tree(f, f.note("upper"), f.note("lower"))));
    assert.equal(f.oracle().length, 1, "Git lists one note for the commit");

    const records = assertOneNote(f, f.declare());
    assert.deepEqual(records.map(({ type }) => type), ["legacy-note", "provenance"]);
    assert.match(records[0].text, /"upper"[\s\S]*"lower"|"lower"[\s\S]*"upper"/);
  });
}

test("a fan-out directory keeps its other notes when a spelling of the commit's note leaves it", (t) => {
  const f = spelledWriter(t);
  const other = `${f.fanOut}${"0".repeat(38)}`;
  f.publish(f.literal([
    ["40000", f.upper(f.fanOut), f.literal([["100644", "0".repeat(38), f.blob], ["100644", f.leaf, f.note("upper")]]
      .sort(([, left], [, right]) => (left < right ? -1 : 1)))],
    ["100644", f.head, f.note("lower")],
  ]));

  assertOneNote(f, f.declare());
  assert.deepEqual(f.oracle().map(({ target }) => target).sort(), [other, f.head].sort());
});

test("a directory at an uppercase spelling of the attachment path is never overwritten", (t) => {
  const f = spelledWriter(t);
  const opaque = f.literal([["100644", "opaque.txt", f.blob]]);
  f.publish(f.literal([["40000", f.upper(f.head), opaque]]));

  assert.match(assertRefused(f, f.notes()).message, /non-note object occupies/);
});

for (const mode of REFUSED_MODES) {
  test(`mode ${mode}, which Git refuses, stops the note writer before it rewrites the tree`, (t) => {
    const f = noteWriter(t);
    f.publish(f.literal([[mode, "a".repeat(40), f.blob]]));

    assert.equal(assertRefused(f, f.notes()).code, "git-response-malformed");
  });
}
