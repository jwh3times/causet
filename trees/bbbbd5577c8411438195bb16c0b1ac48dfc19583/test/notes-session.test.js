import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { beginGitMetrics, endGitMetrics, withGitObjectSession } from "../src/git.js";
import { listNoteEntries, readGitObjects } from "../src/engine.js";
import { testEnv } from "../test-support/git-environment.js";

function fixture(t, format = "sha1") {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "vcs-lab-notes-session-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const env = testEnv({ VLAB_GIT_SESSION: "1" });
  const previous = new Map(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const git = (args, input) => {
    const result = spawnSync("git", args, {
      cwd, env, input, encoding: "utf8", windowsHide: true, maxBuffer: 128 * 1024 * 1024,
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(["init", "-q", `--object-format=${format}`]);
  git(["config", "user.name", "Notes fixture"]);
  git(["config", "user.email", "notes@example.invalid"]);
  const blob = git(["hash-object", "-w", "--stdin"], "note\n");
  const tree = entries => git(["mktree", "--missing"], entries.map(entry =>
    `${entry.mode ?? "100644"} ${entry.type ?? "blob"} ${entry.oid ?? blob}\t${entry.name}\n`,
  ).join(""));
  const publish = oid => git(["update-ref", "refs/notes/vcs-lab",
    git(["commit-tree", oid, "-m", "Notes fixture"])]);
  const oracle = (ref = "vcs-lab") => {
    const output = git(["notes", `--ref=${ref}`, "list"]);
    return output ? output.split(/\r?\n/).map(line => {
      const [note, target] = line.split(" ");
      return { note, target };
    }) : [];
  };
  const listing = (ref = "vcs-lab") => withGitObjectSession(cwd, () => {
    const collector = beginGitMetrics("notes-listing");
    try {
      return { entries: listNoteEntries(ref, cwd), metrics: endGitMetrics(collector) };
    } catch (error) {
      endGitMetrics(collector);
      throw error;
    }
  });
  return { cwd, git, blob, tree, publish, oracle, listing, width: blob.length };
}

for (const format of ["sha1", "sha256"]) {
  test(`session notes match Git for flat, mixed, opaque and deepest fanout trees (${format})`, t => {
    const f = fixture(t, format);
    const target = "ab".repeat(f.width / 2);
    let subtree = f.tree([{ name: "ab", mode: "100755" }]);
    for (let depth = 2; depth < f.width / 2; depth += 1) {
      subtree = f.tree([{ name: "ab", mode: "040000", type: "tree", oid: subtree }]);
    }
    const ignored = f.tree([{ name: "c".repeat(f.width - 4) }]);
    const root = f.tree([
      { name: "0".repeat(f.width) },
      { name: "D".repeat(f.width) },
      { name: "ab", mode: "040000", type: "tree", oid: subtree },
      { name: "abcd", mode: "040000", type: "tree", oid: ignored },
      { name: "e".repeat(f.width), mode: "120000" },
      { name: "ff", mode: "040000", type: "tree", oid: f.tree([
        { name: "E".repeat(f.width - 2) }, { name: "opaque" },
      ]) },
      { name: "not-a-note" },
    ]);
    f.publish(root);
    for (const ref of ["vcs-lab", "notes/vcs-lab", "refs/notes/vcs-lab"]) {
      const actual = f.listing(ref);
      assert.deepEqual(actual.entries, f.oracle(ref));
      assert.equal(actual.entries.length, 4);
      assert.ok(actual.entries.some(entry => entry.target === target));
      assert.equal(actual.metrics.processes, 1);
      assert.ok(actual.metrics.byCommand.every(entry => entry.command !== "notes"));
    }
  });
}

test("duplicate attachments delegate the whole listing to Git's combined blob", t => {
  const f = fixture(t);
  const other = f.git(["hash-object", "-w", "--stdin"], "other\n");
  const target = "ab" + "1".repeat(f.width - 2);
  f.publish(f.tree([
    { name: target },
    { name: "ab", mode: "040000", type: "tree", oid: f.tree([
      { name: target.slice(2), oid: other },
    ]) },
  ]));
  const actual = f.listing();
  assert.deepEqual(actual.entries, f.oracle());
  assert.equal(actual.entries.length, 1);
  assert.notEqual(actual.entries[0].note, f.blob);
  assert.notEqual(actual.entries[0].note, other);
  assert.ok(actual.metrics.byCommand.some(entry => entry.command === "notes"));
});

test("notes sessions reread moved refs and retain ordinary listing when disabled", t => {
  const f = fixture(t);
  f.publish(f.tree([{ name: "1".repeat(f.width) }]));
  withGitObjectSession(f.cwd, () => {
    assert.equal(listNoteEntries("vcs-lab", f.cwd)[0].target, "1".repeat(f.width));
    f.publish(f.tree([{ name: "2".repeat(f.width) }]));
    assert.equal(listNoteEntries("vcs-lab", f.cwd)[0].target, "2".repeat(f.width));
  });
  process.env.VLAB_GIT_SESSION = "0";
  const actual = f.listing();
  assert.deepEqual(actual.entries, f.oracle());
  assert.equal(actual.metrics.processes, 1);
  assert.equal(actual.metrics.sessionQueries, 0);
});

test("missing notes refs and unavailable session responses retain Git behavior", t => {
  const f = fixture(t);
  const missing = f.listing();
  assert.deepEqual(missing.entries, []);
  assert.equal(missing.metrics.processes, 1);
  assert.ok(missing.metrics.byCommand.every(entry => entry.command !== "notes"));
  f.publish(f.tree([]));
  assert.deepEqual(f.listing().entries, []);
  f.publish(f.tree([{ name: "a".repeat(f.width) }, { name: "opaque".repeat(100) }]));
  const previous = process.env.VLAB_TEST_SESSION_BUFFER_BYTES;
  process.env.VLAB_TEST_SESSION_BUFFER_BYTES = "512";
  t.after(() => {
    if (previous === undefined) delete process.env.VLAB_TEST_SESSION_BUFFER_BYTES;
    else process.env.VLAB_TEST_SESSION_BUFFER_BYTES = previous;
  });
  const actual = f.listing();
  assert.deepEqual(actual.entries, f.oracle());
  assert.ok(actual.metrics.byCommand.some(entry => entry.command === "notes"));
});

test("notes tree traversal budget falls back without dropping attachments", t => {
  const f = fixture(t);
  const names = Array.from({ length: 33 }, (_, index) => index.toString(16).padStart(2, "0"));
  const leaf = f.tree([{ name: "a".repeat(f.width - 4) }]);
  const middle = f.tree(names.map(name => ({ name, mode: "040000", type: "tree", oid: leaf })));
  f.publish(f.tree(names.map(name => ({ name, mode: "040000", type: "tree", oid: middle }))));
  const actual = f.listing();
  assert.deepEqual(actual.entries, f.oracle());
  assert.equal(actual.entries.length, 1089);
  assert.ok(actual.metrics.byCommand.some(entry => entry.command === "notes"));
});

test("a missing notes subtree preserves Git's failure result instead of a partial catalog", t => {
  const f = fixture(t);
  f.publish(f.tree([
    { name: "1".repeat(f.width) },
    { name: "ab", mode: "040000", type: "tree", oid: "f".repeat(f.width) },
  ]));
  const oracle = spawnSync("git", ["notes", "--ref=vcs-lab", "list"], {
    cwd: f.cwd, env: testEnv(), encoding: "utf8", windowsHide: true,
  });
  assert.notEqual(oracle.status, 0);
  const actual = f.listing();
  assert.deepEqual(actual.entries, []);
  assert.ok(actual.metrics.byCommand.some(entry => entry.command === "notes"));
});

test("oversized notes trees fall back to Git rather than publishing a partial listing", t => {
  const f = fixture(t);
  const raw = Buffer.alloc(65537 * 256);
  for (let index = 0; index < 65537; index += 1) {
    const offset = index * 256;
    raw.write(`100644 ${String(index).padStart(8, "0")}${"x".repeat(220)}`, offset);
    Buffer.from(f.blob, "hex").copy(raw, offset + 236);
  }
  const root = f.git(["hash-object", "-w", "-t", "tree", "--stdin"], raw);
  f.publish(root);
  const actual = f.listing();
  assert.deepEqual(actual.entries, f.oracle());
  assert.ok(actual.metrics.byCommand.some(entry => entry.command === "notes"));
});

test("listing notes and reading their blobs share one Git process", t => {
  const f = fixture(t);
  f.publish(f.tree([{ name: "a".repeat(f.width) }]));
  const collector = beginGitMetrics("notes-with-blobs");
  withGitObjectSession(f.cwd, () => {
    const entries = listNoteEntries("vcs-lab", f.cwd);
    const [blob] = readGitObjects(entries.map(entry => entry.note), f.cwd);
    assert.equal(blob.content.toString(), "note\n");
  });
  const metrics = endGitMetrics(collector);
  assert.equal(metrics.processes, 1);
  assert.equal(metrics.directReads, 0);
});

test("noncanonical tree modes delegate to Git instead of losing numeric precision", t => {
  const f = fixture(t);
  const target = "a".repeat(f.width);
  const raw = Buffer.concat([
    Buffer.from(`10000000000000000000000000100644 ${target}\0`),
    Buffer.from(f.blob, "hex"),
  ]);
  f.publish(f.git(["hash-object", "--literally", "-w", "-t", "tree", "--stdin"], raw));
  const expected = f.oracle();
  assert.deepEqual(expected, [{ note: f.blob, target }]);
  const actual = f.listing();
  assert.deepEqual(actual.entries, expected);
  assert.ok(actual.metrics.byCommand.some(entry => entry.command === "notes"));
});
