/**
 * Tree entry modes at the Git-side tree readers (#332), held to real Git on
 * trees written literally. Equality alone cannot tell these readers from their
 * fallback, which also answers with Git, so each test also holds what the read
 * cost: no `git notes` process, no fallback recorded.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
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
  const run = (args, input) => spawnSync("git", args, {
    cwd, env, input, encoding: "utf8", windowsHide: true,
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
  return { blob, git, run, literal, publish, oracle, call };
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
