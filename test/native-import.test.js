/**
 * Deterministic and incremental import (#305, ADR-0045 decision 3, storage.md
 * §3.2 and §4.2): a fresh import of the same history writes a byte-identical
 * store, whatever Git repository holds it, and an import into a native
 * repository adds one container of what it does not hold, after which it
 * holds what a full import of the final history holds, its own earlier
 * objects and alias rows kept, with the same ref snapshot.
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
import { TYPES, aliases, containers, nativeId, readContainer } from "../test-support/native-store.js";

const created = [];

after(() => {
  for (const directory of created) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function scratch() {
  const parent = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "causet-native-import-")));
  created.push(parent);
  return parent;
}

const OPT_IN = { CAUSET_EXPERIMENTAL: "native" };

function cst(cwd, args) {
  return spawnSync(cstCommand, [...cstPrefix(), ...args], { cwd, env: testEnv(OPT_IN), encoding: "buffer" });
}

function imports(cwd, source, destination) {
  const result = cst(cwd, ["import", source, destination]);
  assert.equal(result.status, 0, result.stderr.toString());
  return result.stdout.toString();
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

/** A Git repository written with plumbing, and a way to add commits to it. */
function makeRepository(root, format = "sha1") {
  const repo = path.join(root, "source");
  fs.mkdirSync(repo);
  const git = gitIn(repo);
  git(["init", "-q", "-b", "main", `--object-format=${format}`]);
  const blob = (bytes) => git(["hash-object", "-w", "--stdin"], bytes).toString().trim();
  let indexes = 0;
  /** A commit of these files, each `[name, bytes]` or `[name, bytes, mode]`. */
  const commit = (files, message, ...parents) => {
    const indexed = gitIn(repo, { GIT_INDEX_FILE: path.join(root, `index-${indexes++}`) });
    indexed(["update-index", "--add", "-z", "--index-info"],
      Buffer.from(files.map(([name, bytes, mode = "100644"]) => `${mode} ${blob(bytes)}\t${name}\0`).join("")));
    const tree = indexed(["write-tree"]).toString().trim();
    return git(["commit-tree", tree, "-m", message, ...parents.flatMap((parent) => ["-p", parent])]).toString().trim();
  };
  return { repo, git, commit, blob };
}

/**
 * A history with what import's walk orders: a file the chunker cuts and a
 * second version sharing its chunks, a merge, an annotated tag, tags of a
 * tree and a blob, a symbolic ref, and a branch the others do not reach.
 */
function makeHistory(format = "sha1") {
  const root = scratch();
  const source = makeRepository(root, format);
  const { git, commit } = source;
  const big = varied(150_000, "big");
  const one = commit([["a.txt", "a1\n"], ["big.bin", big], ["dir/x", "x\n"], ["run", "#!/bin/sh\n", "100755"]], "one");
  const edited = Buffer.concat([big.subarray(0, 70_000), Buffer.from("an insertion"), big.subarray(70_000)]);
  const two = commit([["a.txt", "a2\n"], ["big.bin", edited], ["dir/x", "x\n"]], "two", one);
  const side = commit([["a.txt", "side\n"], ["b.txt", "b\n"]], "side", one);
  const merged = commit([["a.txt", "merged\n"], ["b.txt", "b\n"], ["big.bin", edited]], "merge", two, side);
  const lone = commit([["lone", "only here\n"]], "lone");
  git(["update-ref", "refs/heads/main", merged]);
  git(["update-ref", "refs/heads/side", side]);
  git(["update-ref", "refs/heads/lone", lone]);
  git(["tag", "-a", "-m", "the first", "v1", one]);
  git(["tag", "tree-tag", `${two}^{tree}`]);
  git(["tag", "-a", "-m", "a blob", "blob-tag", `${one}:a.txt`]);
  git(["symbolic-ref", "refs/heads/current", "refs/heads/main"]);
  return { root, ...source, one, two, side, merged, lone };
}

/** Every file under a store's `.cst/`, by its path there, with its bytes. */
function files(store) {
  const found = new Map();
  const visit = (directory, prefix) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const at = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(at, `${prefix}${entry.name}/`);
      else found.set(`${prefix}${entry.name}`, fs.readFileSync(at));
    }
  };
  visit(path.join(store, ".cst"), "");
  return found;
}

/** Every object the store's containers list, as hex. */
function objects(store) {
  const found = new Set();
  for (const file of containers(store)) {
    for (const object of readContainer(file).objects) found.add(object.name.toString("hex"));
  }
  return found;
}

const sorted = (items) => [...items].sort();

for (const format of ["sha1", "sha256"]) {
  test(`two fresh imports of one history write byte-identical stores, from the repository or a mirror of it (${format})`, () => {
    const { root } = makeHistory(format);
    // A mirror holds the same objects and refs in other files: packed, with
    // packed refs. A clone copies a symbolic ref other than HEAD as the ref
    // it names, so it is made symbolic again.
    execFileSync("git", ["clone", "-q", "--mirror", "source", "mirror"], { cwd: root, env: testEnv() });
    const mirror = gitIn(path.join(root, "mirror"));
    mirror(["symbolic-ref", "refs/heads/current", "refs/heads/main"]);
    mirror(["gc", "-q", "--aggressive"]);
    imports(root, "source", "first");
    imports(root, "source", "second");
    imports(root, "mirror", "third");
    const first = files(path.join(root, "first"));
    assert.deepEqual([...first.keys()].filter((name) => !name.startsWith("objects/")),
      ["aliases/" + format, "format", "snapshot"]);
    for (const other of ["second", "third"]) {
      const written = files(path.join(root, other));
      assert.deepEqual([...written.keys()], [...first.keys()], other);
      for (const [name, bytes] of first) {
        assert.ok(written.get(name).equals(bytes), `${other}: ${name} differs`);
      }
    }
  });
}

test("a path's versions are stored together, oldest first, the paths in the order the walk reaches them", () => {
  const root = scratch();
  const { git, commit } = makeRepository(root);
  let parent;
  const versions = { "a.txt": [], "b.txt": [] };
  for (let n = 1; n <= 3; n++) {
    const files = [["a.txt", `a version ${n}\n`], ["b.txt", `b version ${n}\n`]];
    versions["a.txt"].push(files[0][1]);
    versions["b.txt"].push(files[1][1]);
    parent = commit(files, `commit ${n}`, ...(parent ? [parent] : []));
  }
  git(["update-ref", "refs/heads/main", parent]);
  imports(root, "source", "native");
  const [file] = containers(path.join(root, "native"));
  const at = new Map(readContainer(file).objects
    .filter((object) => object.type === TYPES.content)
    .map((object) => [object.name.toString("hex"), object.frame * 2 ** 32 + object.offset]));
  const order = [...versions["a.txt"], ...versions["b.txt"]]
    .map((bytes) => at.get(nativeId(TYPES.content, Buffer.from(bytes)).toString("hex")));
  assert.ok(order.every((position) => position !== undefined), "every version is stored");
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
});

test("an import into a native repository adds what is new, and then holds what a full import of the final history holds", () => {
  const history = makeHistory();
  const { root, git, commit, merged, one, lone } = history;
  imports(root, "source", "native");
  const native = path.join(root, "native");
  const before = { files: files(native), objects: objects(native), aliases: aliases(native, "sha1") };

  // New commits on main, side moved off its history, lone deleted and its
  // commit pruned from the source, a new tag and a new branch.
  const three = commit([["a.txt", "a3\n"], ["b.txt", "b\n"], ["big.bin", varied(150_000, "three")]], "three", merged);
  git(["update-ref", "refs/heads/main", three]);
  const rewritten = commit([["a.txt", "rewritten\n"]], "rewritten", one);
  git(["update-ref", "refs/heads/side", rewritten]);
  git(["update-ref", "-d", "refs/heads/lone"]);
  git(["reflog", "expire", "--expire=now", "--all"]);
  git(["gc", "-q", "--prune=now"]);
  assert.throws(() => git(["cat-file", "-e", lone], undefined), "the deleted branch's commit is gone from the source");
  git(["tag", "-a", "-m", "the third", "v3", three]);
  git(["branch", "fresh", merged]);

  const stdout = imports(root, "source", "native");
  assert.match(stdout, /^Imported source into native, adding \d+ blobs?, \d+ trees?, 2 commits, 1 tag to what it held, from a sha1 repository\.$/m);
  imports(root, "source", "full");
  const full = path.join(root, "full");

  // The same ref snapshot, and so the same refs.
  assert.ok(fs.readFileSync(path.join(native, ".cst", "snapshot")).equals(fs.readFileSync(path.join(full, ".cst", "snapshot"))));
  const refs = (store) => cst(store, ["for-each-ref", "--format=%(objectname) %(refname) %(symref)"]).stdout.toString();
  assert.equal(refs(native), refs(full));
  assert.match(refs(native), /refs\/heads\/fresh/);
  assert.doesNotMatch(refs(native), /refs\/heads\/lone/);

  // Every object and alias row of the full import, and the store's own.
  const after = { objects: objects(native), aliases: aliases(native, "sha1") };
  assert.deepEqual(sorted(after.objects), sorted(new Set([...before.objects, ...objects(full)])));
  const fullRows = aliases(full, "sha1");
  assert.deepEqual(sorted(after.aliases), sorted(new Map([...before.aliases, ...fullRows])));
  for (const [git, id] of fullRows) assert.equal(after.aliases.get(git), id, git);

  // The earlier container is as it was; the one added holds nothing the
  // store held before.
  const [kept] = [...before.files.keys()].filter((name) => name.startsWith("objects/"));
  assert.ok(fs.readFileSync(path.join(native, ".cst", kept)).equals(before.files.get(kept)));
  const added = containers(native).filter((file) => !file.endsWith(path.basename(kept)));
  assert.equal(added.length, 1);
  for (const object of readContainer(added[0]).objects) {
    assert.equal(before.objects.has(object.name.toString("hex")), false, object.name.toString("hex"));
  }
  assert.deepEqual(fs.readdirSync(path.join(native, ".cst")).sort(), ["aliases", "format", "objects", "snapshot"]);

  for (const check of [["fsck"], ["import", "--verify"]]) {
    const result = cst(native, check);
    assert.equal(result.status, 0, `${check.join(" ")}: ${result.stderr}`);
  }
});

test("an import that finds nothing new adds no container, and one that finds only new refs adds just their snapshot", () => {
  const { root, git, two } = makeHistory();
  imports(root, "source", "native");
  const native = path.join(root, "native");
  const before = files(native);
  const again = imports(root, "source", "native");
  assert.match(again, /, adding 0 blobs, 0 trees, 0 commits, 0 tags to what it held,/);
  const unchanged = files(native);
  assert.deepEqual([...unchanged.keys()], [...before.keys()]);
  for (const [name, bytes] of before) assert.ok(unchanged.get(name).equals(bytes), name);

  git(["branch", "another", two]);
  imports(root, "source", "native");
  const added = containers(native).filter((file) => !before.has(`objects/${path.basename(file)}`));
  assert.equal(added.length, 1);
  assert.deepEqual(readContainer(added[0]).objects.map((object) => object.type), [TYPES.snapshot]);
  const head = cst(native, ["rev-parse", "another"]).stdout.toString().trim();
  assert.equal(head, aliases(native, "sha1").get(two));
});

test("an import into a native repository is refused while another is adding to it, or for a history of another algorithm, and changes nothing", () => {
  const { root } = makeHistory();
  imports(root, "source", "native");
  const native = path.join(root, "native");
  const before = files(native);
  const unchanged = () => {
    const now = files(native);
    assert.deepEqual([...now.keys()], [...before.keys()]);
    for (const [name, bytes] of before) assert.ok(now.get(name).equals(bytes), name);
  };

  const lock = path.join(native, ".cst", "import.lock");
  fs.writeFileSync(lock, "");
  const locked = cst(root, ["import", "source", "native"]);
  assert.equal(locked.status, 1);
  assert.match(locked.stderr.toString(), /import\.lock exists, so another import is adding to/);
  fs.rmSync(lock);
  unchanged();

  const other = makeHistory("sha256");
  const refused = cst(root, ["import", path.join(other.root, "source"), "native"]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr.toString(), /holds a sha1 history, so it cannot take a sha256 one/);
  unchanged();
});

test("an import into a native repository that fails leaves it as it was", () => {
  const { root, git, commit, merged } = makeHistory();
  imports(root, "source", "native");
  const native = path.join(root, "native");
  const before = files(native);
  // A new commit whose blob the source no longer holds.
  const broken = commit([["gone.txt", "about to go\n"]], "broken", merged);
  git(["update-ref", "refs/heads/main", broken]);
  const blob = git(["rev-parse", `${broken}:gone.txt`]).toString().trim();
  fs.rmSync(path.join(root, "source", ".git", "objects", blob.slice(0, 2), blob.slice(2)));
  const failed = cst(root, ["import", "source", "native"]);
  assert.equal(failed.status, 1);
  assert.match(failed.stderr.toString(), new RegExp(`names the object ${blob} but does not hold it`));
  const now = files(native);
  assert.deepEqual([...now.keys()], [...before.keys()]);
  for (const [name, bytes] of before) assert.ok(now.get(name).equals(bytes), name);
});

test("a failure after the container is in place takes it back, and the alias file with it", () => {
  const { root, git, commit, merged } = makeHistory();
  imports(root, "source", "native");
  const native = path.join(root, "native");
  const before = files(native);
  git(["update-ref", "refs/heads/main", commit([["late.txt", "late\n"]], "late", merged)]);
  // `snapshot` cannot be replaced: its temporary name is a directory. The
  // container and the alias file are in place by then.
  const blocker = path.join(native, ".cst", "snapshot.tmp");
  fs.mkdirSync(blocker);
  const failed = cst(root, ["import", "source", "native"]);
  assert.equal(failed.status, 1);
  assert.match(failed.stderr.toString(), /snapshot\.tmp/);
  fs.rmdirSync(blocker);
  const now = files(native);
  assert.deepEqual([...now.keys()], [...before.keys()]);
  for (const [name, bytes] of before) assert.ok(now.get(name).equals(bytes), name);
  const verified = cst(native, ["import", "--verify"]);
  assert.equal(verified.status, 0, verified.stderr.toString());
});

test("every commit Git reaches is imported, though its parent line is in uppercase hex", () => {
  const root = scratch();
  const { git, commit } = makeRepository(root);
  const parent = commit([["a.txt", "parent\n"]], "parent");
  const tree = git(["rev-parse", `${commit([["a.txt", "child\n"]], "tree only")}^{tree}`]).toString().trim();
  const child = git(["hash-object", "-t", "commit", "-w", "--literally", "--stdin"], Buffer.from([
    `tree ${tree}`, `parent ${parent.toUpperCase()}`,
    `author ${IDENTITY.GIT_AUTHOR_NAME} <${IDENTITY.GIT_AUTHOR_EMAIL}> ${IDENTITY.GIT_AUTHOR_DATE}`,
    `committer ${IDENTITY.GIT_COMMITTER_NAME} <${IDENTITY.GIT_COMMITTER_EMAIL}> ${IDENTITY.GIT_COMMITTER_DATE}`,
    "", "child", ""].join("\n"))).toString().trim();
  git(["update-ref", "refs/heads/main", child]);
  assert.match(git(["rev-list", "main"]).toString(), new RegExp(parent));
  const stdout = imports(root, "source", "native");
  assert.match(stdout, /: 2 blobs, 2 trees, 2 commits, 0 tags,/);
  assert.ok(aliases(path.join(root, "native"), "sha1").has(parent));
});
