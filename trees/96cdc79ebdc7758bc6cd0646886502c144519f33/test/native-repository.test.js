/**
 * A native repository (N1, ADR-0045, #301): `cst import` copies a Git
 * repository's blobs and trees into one, and there `cst cat-file` answers as
 * `git cat-file` does on the original, byte for byte once IDs are translated
 * through the alias map, without running Git. Both are experimental and
 * refused without `CAUSET_EXPERIMENTAL=native`.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { testEnv } from "../test-support/git-environment.js";
import { cstCommand, cstPrefix } from "../test-support/cst-command.js";

const created = [];

after(() => {
  for (const directory of created) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function scratch() {
  const parent = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "causet-native-repository-")));
  created.push(parent);
  return parent;
}

const OPT_IN = { CAUSET_EXPERIMENTAL: "native" };

function cst(cwd, args, env = OPT_IN) {
  return spawnSync(cstCommand, [...cstPrefix(), ...args], { cwd, env: testEnv(env), encoding: "buffer" });
}

const IDENTITY = {
  GIT_AUTHOR_NAME: "A U Thor", GIT_AUTHOR_EMAIL: "author@example.com", GIT_AUTHOR_DATE: "1112911993 -0700",
  GIT_COMMITTER_NAME: "C O Mitter", GIT_COMMITTER_EMAIL: "committer@example.com", GIT_COMMITTER_DATE: "1112911993 -0700",
};

function gitIn(repo, env = {}) {
  return (args, input) => execFileSync("git", args, {
    cwd: repo, env: testEnv({ ...IDENTITY, ...env }), input, maxBuffer: 64 * 1024 * 1024,
  });
}

/** Deterministic bytes the chunker cuts into several chunks. */
function varied(length, label) {
  const parts = [];
  for (let k = 0; parts.length * 32 < length; k++) {
    parts.push(createHash("sha256").update(`${label} ${k}`).digest());
  }
  return Buffer.concat(parts).subarray(0, length);
}

/**
 * A history built with plumbing only, so names and modes no file system
 * allows still occur: an executable, a symbolic link, a submodule link, an
 * empty file, names that need quoting, a directory beside a name it
 * prefixes, a file the chunker cuts and a second version sharing its chunks,
 * a tree that is not canonical, and tags on a blob and a tree.
 */
function makeSource(format) {
  const root = scratch();
  const repo = path.join(root, "source");
  fs.mkdirSync(repo);
  const git = gitIn(repo);
  git(["init", "-q", "-b", "main", `--object-format=${format}`]);
  const blob = (bytes) => git(["hash-object", "-w", "--stdin"], bytes).toString().trim();
  const width = format === "sha1" ? 40 : 64;
  const big = varied(150_000, format);
  const entries = [
    ["100644", blob("hello\n"), "hello.txt"],
    ["100644", blob(""), "empty"],
    ["100755", blob("#!/bin/sh\necho run\n"), "run.sh"],
    ["120000", blob("hello.txt"), "link"],
    ["160000", "a".repeat(width), "module"],
    ["100644", blob("z\n"), "a/f"],
    ["100644", blob("w\n"), "a.b"],
    ["100644", blob("x\n"), "tab\tname"],
    ["100644", blob("y\n"), "é"],
    ["100644", blob("q\n"), 'quo"te'],
    ["100644", blob(big), "big.bin"],
  ];
  const commit = (list, message, parent) => {
    const index = path.join(root, `index-${message}`);
    const indexed = gitIn(repo, { GIT_INDEX_FILE: index });
    indexed(["update-index", "--add", "-z", "--index-info"],
      Buffer.from(list.map(([mode, id, name]) => `${mode} ${id}\t${name}\0`).join("")));
    const tree = indexed(["write-tree"]).toString().trim();
    return git(["commit-tree", tree, "-m", message, ...(parent ? ["-p", parent] : [])]).toString().trim();
  };
  const first = commit(entries, "one");
  const edited = Buffer.concat([big.subarray(0, 70_000), Buffer.from("an insertion"), big.subarray(70_000)]);
  const second = commit([...entries.filter(([, , name]) => name !== "big.bin" && name !== "empty"),
    ["100644", blob(edited), "big.bin"]], "two", first);
  git(["update-ref", "refs/heads/main", second]);

  // A tree Git accepts but would not write: a zero-padded mode and a mode
  // outside the five, named from a canonical tree.
  const emptyTree = git(["hash-object", "-t", "tree", "-w", "--stdin"], Buffer.alloc(0)).toString().trim();
  const zz = blob("zz\n");
  const literal = Buffer.concat([
    Buffer.from("040000 sub\0"), Buffer.from(emptyTree, "hex"),
    Buffer.from("100664 zz\0"), Buffer.from(zz, "hex"),
  ]);
  const odd = git(["hash-object", "-t", "tree", "-w", "--literally", "--stdin"], literal).toString().trim();
  const parent = git(["mktree"], Buffer.from(`040000 tree ${odd}\tweird\n100644 blob ${zz}\tzz\n`)).toString().trim();
  git(["update-ref", "refs/heads/odd", commit([["100644", zz, "top"]], "three", second)]);
  git(["tag", "tree-tag", parent]);
  git(["tag", "-a", "-m", "a blob", "blob-tag", zz]);
  return { root, repo, git, odd, parent };
}

/** The alias file's rows, Git ID → native ID, both as hex. */
function aliases(store, format) {
  const file = fs.readFileSync(path.join(store, ".cst", "aliases", format));
  const width = format === "sha1" ? 20 : 32;
  const count = file.readUInt32BE(12);
  const rows = new Map();
  for (let row = 0; row < count; row++) {
    const at = 16 + 1024 + row * (width + 32);
    rows.set(file.subarray(at, at + width).toString("hex"), file.subarray(at + width, at + width + 32).toString("hex"));
  }
  return rows;
}

function imported(format) {
  const source = makeSource(format);
  const destination = path.join(source.root, "native");
  const result = cst(source.root, ["import", "source", "native"]);
  assert.equal(result.status, 0, result.stderr.toString());
  return { ...source, destination, aliases: aliases(destination, format), stdout: result.stdout.toString() };
}

for (const format of ["sha1", "sha256"]) {
  test(`every imported blob and tree prints as git cat-file prints it (${format})`, () => {
    const { git, destination, aliases: rows } = imported(format);
    const objects = git(["rev-list", "--objects", "--no-object-names", "--all"]).toString().trim().split("\n");
    const kinds = new Map(objects.map((id) => [id, git(["cat-file", "-t", id]).toString().trim()]));
    const contentAndTrees = objects.filter((id) => ["blob", "tree"].includes(kinds.get(id)));
    assert.equal(rows.size, contentAndTrees.length, "one alias row per imported blob and tree");
    const translate = (text) => text.replace(new RegExp(`\\b[0-9a-f]{${format === "sha1" ? 40 : 64}}\\b`, "g"),
      (id) => rows.get(id) ?? id);
    for (const id of contentAndTrees) {
      const native = rows.get(id);
      assert.ok(native, `${id} has an alias row`);
      for (const flag of ["-p", "-t", "-s"]) {
        const expected = git(["cat-file", flag, id]);
        const answered = cst(destination, ["cat-file", flag, native]);
        assert.equal(answered.status, 0, answered.stderr.toString());
        const wanted = kinds.get(id) === "tree" && flag === "-p"
          ? Buffer.from(translate(expected.toString("latin1")), "latin1")
          : expected;
        assert.deepEqual(answered.stdout, wanted, `cat-file ${flag} ${id} (${kinds.get(id)})`);
      }
    }
  });
}

test("a path through trees, and an unambiguous prefix, name the object Git names", () => {
  const { git, destination, aliases: rows, parent } = imported("sha1");
  const root = rows.get(git(["rev-parse", "main^{tree}"]).toString().trim());
  for (const [native, revision] of [[`${root}:a/f`, "main:a/f"], [`${root.slice(0, 10)}:big.bin`, "main:big.bin"],
    [`${rows.get(parent)}:weird/zz`, `${parent}:weird/zz`]]) {
    const answered = cst(destination, ["cat-file", "-p", native]);
    assert.equal(answered.status, 0, answered.stderr.toString());
    assert.deepEqual(answered.stdout, git(["cat-file", "-p", revision]));
  }
  const missing = cst(destination, ["cat-file", "-p", `${root}:no/such/path`]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr.toString(), /path 'no\/such\/path' does not exist/);
});

test("import reports each ref and keeps a tree that is not canonical in Git's encoding", () => {
  const { stdout, aliases: rows, odd, git } = imported("sha1");
  assert.match(stdout, /1 kept in Git's encoding/);
  assert.match(stdout, /not imported yet \(#302\)/);
  const tree = rows.get(git(["rev-parse", "main^{tree}"]).toString().trim());
  assert.match(stdout, new RegExp(`^${tree} tree\\trefs/heads/main$`, "m"));
  assert.match(stdout, new RegExp(`^${rows.get(git(["rev-parse", "blob-tag^{}"]).toString().trim())} blob\\trefs/tags/blob-tag$`, "m"));
  assert.ok(rows.get(odd));
});

test("reading a native repository runs no Git", () => {
  const { destination, aliases: rows, git } = imported("sha1");
  const noGit = fs.mkdtempSync(path.join(scratch(), "no-git-"));
  const env = Object.fromEntries(Object.entries(testEnv(OPT_IN)).filter(([name]) => name.toUpperCase() !== "PATH"));
  env.PATH = noGit;
  const tree = rows.get(git(["rev-parse", "main^{tree}"]).toString().trim());
  const answered = spawnSync(cstCommand, [...cstPrefix(), "cat-file", "-p", `${tree}:hello.txt`], {
    cwd: destination, env, encoding: "buffer",
  });
  assert.equal(answered.status, 0, answered.stderr.toString());
  assert.equal(answered.stdout.toString(), "hello\n");
});

test("without the opt-in, import and a native repository's commands are refused, naming it", () => {
  const { root, destination, aliases: rows, git } = imported("sha1");
  const refused = cst(root, ["import", "source", "other"], {});
  assert.equal(refused.status, 1);
  assert.match(refused.stderr.toString(), /CAUSET_EXPERIMENTAL=native/);
  assert.equal(fs.existsSync(path.join(root, "other")), false);
  const tree = rows.get(git(["rev-parse", "main^{tree}"]).toString().trim());
  const read = cst(destination, ["cat-file", "-p", tree], {});
  assert.equal(read.status, 1);
  assert.match(read.stderr.toString(), /CAUSET_EXPERIMENTAL=native/);
});

test("a native repository refuses what it does not implement, and has no Git to pass it to", () => {
  const { destination } = imported("sha1");
  for (const args of [["status"], ["git", "status"], ["log"]]) {
    const refused = cst(destination, args);
    assert.equal(refused.status, 1, args.join(" "));
    assert.match(refused.stderr.toString(), /native repository/);
  }
  const help = cst(destination, ["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout.toString(), /experimental, not a contract/);
  assert.match(help.stdout.toString(), /cst cat-file \(-p \| -t \| -s\) <object>/);
});

test("the help of a Git-backed repository lists the experimental commands as such", () => {
  const { repo } = makeSource("sha1");
  const help = cst(repo, ["--help"]).stdout.toString();
  assert.match(help, /Experimental, and not contracts: they need CAUSET_EXPERIMENTAL=native/);
  assert.match(help, /cst import <git-repo> <dest>/);
});

test("import into a directory that is not empty is refused and leaves it as it was", () => {
  const { root } = makeSource("sha1");
  const occupied = path.join(root, "occupied");
  fs.mkdirSync(occupied);
  fs.writeFileSync(path.join(occupied, "keep"), "keep\n");
  const refused = cst(root, ["import", "source", "occupied"]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr.toString(), /exists and is not empty/);
  assert.deepEqual(fs.readdirSync(occupied), ["keep"]);
});

test("a directory that is both a native and a Git repository is refused as neither", () => {
  const { destination } = imported("sha1");
  fs.mkdirSync(path.join(destination, ".git"));
  const refused = cst(destination, ["cat-file", "-t", "0000"]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr.toString(), /holds both \.cst and \.git/);
});

/**
 * A tree named through a file entry, which `rev-list --objects` takes for a
 * blob, and named as a directory elsewhere, which makes `rev-list --objects`
 * fail; and a submodule link whose commit ID is an object the history
 * reaches, which Git resolves through.
 */
function makeMismatched() {
  const root = scratch();
  const repo = path.join(root, "source");
  fs.mkdirSync(repo);
  const git = gitIn(repo);
  git(["init", "-q", "-b", "main"]);
  const blob = (bytes) => git(["hash-object", "-w", "--stdin"], bytes).toString().trim();
  const tree = (records) => git(["hash-object", "-t", "tree", "-w", "--literally", "--stdin"],
    Buffer.concat(records.flatMap(([mode, name, id]) => [Buffer.from(`${mode} ${name}\0`), Buffer.from(id, "hex")])))
    .toString().trim();
  const inner = blob("only here\n");
  const local = blob("held locally\n");
  const hidden = tree([["100644", "inner", inner]]);
  const asFile = tree([["100644", "f", hidden]]);
  // The link's commit ID is a blob the history also reaches as a file.
  const asDirectory = tree([["40000", "d", hidden], ["160000", "g", local], ["100644", "l", local]]);
  const commit = (treeId, message, parents = []) =>
    git(["commit-tree", treeId, "-m", message, ...parents.flatMap((parent) => ["-p", parent])]).toString().trim();
  const first = commit(asFile, "file");
  git(["update-ref", "refs/heads/main", commit(asDirectory, "directory", [first])]);
  return { root, git, hidden, inner, asFile, asDirectory };
}

test("a tree Git would not walk is imported whole, in its one native form", () => {
  const source = makeMismatched();
  const walked = spawnSync("git", ["rev-list", "--objects", "--all"], { cwd: path.join(source.root, "source"), env: testEnv() });
  assert.notEqual(walked.status, 0, "rev-list --objects fails on this history, so import must not rely on it");
  const result = cst(source.root, ["import", "source", "native"]);
  assert.equal(result.status, 0, result.stderr.toString());
  const destination = path.join(source.root, "native");
  const rows = aliases(destination, "sha1");
  assert.ok(rows.get(source.inner), "the blob only the hidden tree names is imported");
  assert.equal(cst(destination, ["cat-file", "-t", rows.get(source.hidden)]).stdout.toString(), "tree\n");
  for (const id of [source.hidden, source.asFile, source.asDirectory]) {
    const expected = source.git(["cat-file", "-p", id]).toString("latin1").replace(/\b[0-9a-f]{40}\b/g, (git) => rows.get(git) ?? git);
    assert.equal(cst(destination, ["cat-file", "-p", rows.get(id)]).stdout.toString("latin1"), expected, id);
  }
  const through = cst(destination, ["cat-file", "-p", `${rows.get(source.asDirectory)}:g`]);
  assert.deepEqual(through.stdout, source.git(["cat-file", "-p", `${source.asDirectory}:g`]));
});

test("a path resolves, or fails, wherever Git's does", () => {
  const { git, destination, aliases: rows, parent } = imported("sha1");
  const main = git(["rev-parse", "main^{tree}"]).toString().trim();
  const cases = [
    [main, ["", "hello.txt", "hello.txt/", "/hello.txt", "a", "a/", "a/f", "a//f", "a/f/", "no", "module", "module/x", "big.bin"]],
    [parent, ["weird", "weird/", "weird/zz", "weird/sub", "weird/sub/", "weird/sub/x", "zz"]],
  ];
  for (const [tree, paths] of cases) {
    for (const name of paths) {
      const expected = spawnSync("git", ["cat-file", "-p", `${tree}:${name}`], { cwd: path.join(path.dirname(destination), "source"), env: testEnv() });
      const answered = cst(destination, ["cat-file", "-p", `${rows.get(tree)}:${name}`]);
      assert.equal(answered.status === 0, expected.status === 0, `${tree}:${name}: ${answered.stderr}`);
      if (expected.status === 0) {
        const translated = expected.stdout.toString("latin1").replace(/\b[0-9a-f]{40}\b/g, (id) => rows.get(id) ?? id);
        assert.equal(answered.stdout.toString("latin1"), translated, `${tree}:${name}`);
      }
    }
  }
});
