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
import {
  TYPES, aliases, containers, nativeId, readContainer, storeFiles as files, storeObjects as objects,
} from "../test-support/native-store.js";

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
  return spawnSync(cstCommand, [...cstPrefix(), ...args], { cwd, env: testEnv(OPT_IN), encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
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

test("every object Git reaches is imported and read, though its header names it in uppercase hex", () => {
  const root = scratch();
  const { git, commit } = makeRepository(root);
  const parent = commit([["a.txt", "parent\n"]], "parent");
  const tree = git(["rev-parse", `${commit([["a.txt", "child\n"]], "tree only")}^{tree}`]).toString().trim();
  const write = (type, lines) => git(["hash-object", "-t", type, "-w", "--literally", "--stdin"],
    Buffer.from(lines.join("\n"))).toString().trim();
  const child = write("commit", [
    `tree ${tree.toUpperCase()}`, `parent ${parent.toUpperCase()}`,
    `author ${IDENTITY.GIT_AUTHOR_NAME} <${IDENTITY.GIT_AUTHOR_EMAIL}> ${IDENTITY.GIT_AUTHOR_DATE}`,
    `committer ${IDENTITY.GIT_COMMITTER_NAME} <${IDENTITY.GIT_COMMITTER_EMAIL}> ${IDENTITY.GIT_COMMITTER_DATE}`,
    "", "child", ""]);
  const tag = write("tag", [
    `object ${child.toUpperCase()}`, "type commit", "tag upper",
    `tagger ${IDENTITY.GIT_COMMITTER_NAME} <${IDENTITY.GIT_COMMITTER_EMAIL}> ${IDENTITY.GIT_COMMITTER_DATE}`,
    "", "upper", ""]);
  git(["update-ref", "refs/heads/main", child]);
  git(["update-ref", "refs/tags/upper", tag]);
  assert.equal(git(["rev-parse", "upper^{tree}"]).toString().trim(), tree, "Git follows both lines");
  assert.match(git(["rev-list", "main"]).toString(), new RegExp(parent));

  const stdout = imports(root, "source", "native");
  assert.match(stdout, /: 2 blobs, 2 trees, 2 commits, 1 tag,/);
  const native = path.join(root, "native");
  const rows = aliases(native, "sha1");
  for (const id of [parent, tree, child, tag]) assert.ok(rows.has(id), id);
  for (const check of [["fsck"], ["import", "--verify"]]) {
    const result = cst(native, check);
    assert.equal(result.status, 0, result.stderr.toString());
  }
  const read = (args) => {
    const result = cst(native, args);
    assert.equal(result.status, 0, result.stderr.toString());
    return result.stdout.toString();
  };
  assert.match(read(["cat-file", "-p", rows.get(child)]),
    new RegExp(`^tree ${rows.get(tree)}\nparent ${rows.get(parent)}\n`), "the header lines name native IDs");
  assert.match(read(["cat-file", "-p", rows.get(tag)]), new RegExp(`^object ${rows.get(child)}\n`));
  assert.equal(read(["rev-parse", "upper^{tree}"]).trim(), rows.get(tree));
  assert.equal(read(["rev-parse", "main^"]).trim(), rows.get(parent));
});

/** `count` versions of a file over 1 MiB, each a small edit of the one before. */
function largeVersions(count, label = "large") {
  let current = Buffer.from(varied(1_100_000, label));
  return Array.from({ length: count }, (_, n) => {
    current = Buffer.from(current);
    varied(16, `${label} edit ${n}`).copy(current, (n * 97_000) % 1_000_000);
    return current;
  });
}

/** The length of the first chunk storage.md §2.3 cuts from `data`. */
function cutFirst(data) {
  const gear = Array.from({ length: 256 }, (_, i) =>
    createHash("sha256").update(Buffer.concat([Buffer.from("cst fastcdc gear"), Buffer.from([i])])).digest().readBigUInt64BE(0));
  const [MIN, NORMAL, MAX] = [2048, 8192, 65536];
  const [MASK_S, MASK_L, WRAP] = [0x0000d90f03530000n, 0x0000d90003530000n, (1n << 64n) - 1n];
  const n = data.length;
  if (n <= MIN) return n;
  const limit = Math.min(n, MAX);
  const normal = Math.min(limit, NORMAL);
  let fp = 0n;
  for (let i = MIN; i < limit;) {
    fp = ((fp << 1n) + gear[data[i]]) & WRAP;
    i += 1;
    if ((fp & (i <= normal ? MASK_S : MASK_L)) === 0n) return i;
  }
  return limit;
}

/** Each content object's stored form and, for a delta, its depth. */
function forms(store) {
  const found = new Map();
  for (const file of containers(store)) {
    const { frames, objects } = readContainer(file);
    for (const object of objects) {
      if (object.type !== TYPES.content || object.state !== 0) continue;
      const record = frames[object.frame].bytes.subarray(object.offset, object.offset + object.length);
      found.set(object.name.toString("hex"), {
        form: object.form,
        codec: frames[object.frame].codec,
        base: object.form === 2 ? record.subarray(1, 33).toString("hex") : undefined,
      });
    }
  }
  const depth = (id) => (found.get(id).form === 2 ? 1 + depth(found.get(id).base) : 0);
  for (const [id, entry] of found) entry.depth = depth(id);
  return found;
}

test("versions of a large file are stored as deltas no more than 8 deep, read back byte for byte, and import the same every time", () => {
  const root = scratch();
  const { git, commit } = makeRepository(root);
  const versions = largeVersions(11);
  let parent;
  const commits = versions.map((bytes, n) => (parent = commit([["big.bin", bytes], ["note", `${n}\n`]], `v${n}`, ...(parent ? [parent] : []))));
  // Renamed with an edit: the new path is in no parent, so there is no base.
  const renamed = Buffer.from(versions[10]);
  renamed[5] ^= 1;
  const moved = commit([["moved.bin", renamed]], "moved", parent);
  git(["update-ref", "refs/heads/main", moved]);
  execFileSync("git", ["clone", "-q", "--mirror", "source", "mirror"], { cwd: root, env: testEnv() });
  gitIn(path.join(root, "mirror"))(["gc", "-q", "--aggressive"]);
  imports(root, "source", "native");
  imports(root, "mirror", "again");
  const native = path.join(root, "native");
  const first = files(native);
  const second = files(path.join(root, "again"));
  assert.deepEqual([...second.keys()], [...first.keys()]);
  for (const [name, bytes] of first) assert.ok(second.get(name).equals(bytes), `${name} differs`);

  const rows = aliases(native, "sha1");
  const stored = forms(native);
  const blobOf = (rev) => git(["rev-parse", rev]).toString().trim();
  const depths = commits.map((id) => {
    const native = rows.get(blobOf(`${id}:big.bin`));
    return stored.get(native).depth;
  });
  // The ninth delta would be 9 deep, so that version starts a new chain.
  assert.deepEqual(depths, [0, 1, 2, 3, 4, 5, 6, 7, 8, 0, 1]);
  for (const entry of stored.values()) {
    assert.ok(entry.depth <= 8);
    if (entry.form === 2) assert.equal(entry.codec, 0, "a delta is in a stored frame");
  }
  assert.equal(stored.get(rows.get(blobOf(`${moved}:moved.bin`))).form, 1, "a renamed file has no base");

  // Content IDs are those of the bytes, delta or not, and each version reads
  // back as Git holds it.
  for (const [n, id] of commits.entries()) {
    assert.equal(rows.get(blobOf(`${id}:big.bin`)), nativeId(TYPES.content, versions[n]).toString("hex"));
    const read = cst(native, ["cat-file", "-p", `${rows.get(id)}:big.bin`]);
    assert.equal(read.status, 0, read.stderr.toString());
    assert.ok(read.stdout.equals(versions[n]), `version ${n} reads back`);
  }
  const size = cst(native, ["cat-file", "-s", `${rows.get(commits[5])}:big.bin`]);
  assert.equal(size.stdout.toString().trim(), String(versions[5].length));
  for (const check of [["fsck"], ["import", "--verify"]]) {
    const result = cst(native, check);
    assert.equal(result.status, 0, `${check.join(" ")}: ${result.stderr}`);
  }

  // An import into the repository stores the next versions against the one
  // it holds.
  const later = largeVersions(13).slice(11);
  for (const [n, bytes] of later.entries()) parent = commit([["big.bin", bytes], ["note", `later ${n}\n`]], `later ${n}`, parent);
  git(["update-ref", "refs/heads/main", parent]);
  imports(root, "source", "native");
  const added = forms(native);
  const laterDepths = later.map((bytes) => added.get(nativeId(TYPES.content, bytes).toString("hex")).depth);
  assert.deepEqual(laterDepths, [2, 3]);
  const read = cst(native, ["cat-file", "-p", "main:big.bin"]);
  assert.ok(read.stdout.equals(later[1]));
  for (const check of [["fsck"], ["import", "--verify"]]) {
    const result = cst(native, check);
    assert.equal(result.status, 0, `${check.join(" ")}: ${result.stderr}`);
  }
});

test("a large version whose base is stored after it, or whose chunks are held already, is stored as chunks", () => {
  const root = scratch();
  const { git, commit } = makeRepository(root);
  const [shared, edited] = largeVersions(2, "shared");
  // `y`'s first version is the base of `x`'s third, but import's walk stores
  // `x`'s versions first, so the base is not in the store when it is needed.
  const one = commit([["x", "small\n"], ["y", shared]], "one");
  const two = commit([["x", shared], ["y", shared]], "two", one);
  const three = commit([["x", edited], ["y", shared]], "three", two);
  // Against an unlike base, a delta is about as large as the content, but
  // smaller than the content's chunk list and a frame of its new chunks...
  const unlike = Buffer.from(varied(1_100_000, "unlike"));
  const four = commit([["x", unlike], ["y", shared]], "four", three);
  // ...while nearly every chunk of this version is held already.
  const back = Buffer.from(edited);
  back[0] ^= 1;
  const five = commit([["x", back], ["y", shared]], "five", four);
  git(["update-ref", "refs/heads/main", five]);
  imports(root, "source", "native");
  const native = path.join(root, "native");
  const stored = forms(native);
  const form = (bytes) => stored.get(nativeId(TYPES.content, bytes).toString("hex")).form;
  assert.equal(form(edited), 1);
  assert.equal(form(unlike), 2);
  assert.equal(form(back), 1);
  for (const check of [["fsck"], ["import", "--verify"]]) {
    const result = cst(native, check);
    assert.equal(result.status, 0, `${check.join(" ")}: ${result.stderr}`);
  }
});

test("a merge's version is stored against its first parent's, and a base held only as a chunk is a base", () => {
  const root = scratch();
  const { git, commit } = makeRepository(root);
  const [v0, v1, merged] = largeVersions(3, "merge");
  const other = Buffer.from(varied(1_100_000, "other side"));
  const one = commit([["big.bin", v0]], "one");
  const two = commit([["big.bin", v1]], "two", one);
  const side = commit([["big.bin", other]], "side", one);
  // Against `other`, `merged` is a delta as large as itself, larger than its
  // chunks, nearly all held from `v1`; against `v1` it is a small delta.
  const sideFirst = commit([["big.bin", merged]], "side first", side, two);
  const mergedAgain = Buffer.from(merged);
  mergedAgain[3] ^= 1;
  const mainFirst = commit([["big.bin", mergedAgain]], "main first", two, side);
  // `chunk` is the first chunk of `large`, so the store holds it once `large`
  // is stored, though its blob comes later in import's walk.
  const large = Buffer.from(varied(1_500_000, "holds a chunk"));
  const firstCut = cutFirst(large);
  const chunk = large.subarray(0, firstCut);
  const rewrite = Buffer.from(varied(1_200_000, "rewrite"));
  const c1 = commit([["a", large], ["p", "small\n"]], "c1");
  const c2 = commit([["a", large], ["m", chunk], ["p", chunk]], "c2", c1);
  const c3 = commit([["a", large], ["m", chunk], ["p", rewrite]], "c3", c2);
  git(["update-ref", "refs/heads/side-first", sideFirst]);
  git(["update-ref", "refs/heads/main-first", mainFirst]);
  git(["update-ref", "refs/heads/chunk", c3]);
  imports(root, "source", "native");
  const native = path.join(root, "native");
  const stored = forms(native);
  const entry = (bytes) => stored.get(nativeId(TYPES.content, bytes).toString("hex"));
  assert.equal(entry(merged).form, 1, "against the first parent's version, the chunks are smaller");
  assert.equal(entry(mergedAgain).form, 2);
  assert.equal(entry(mergedAgain).base, nativeId(TYPES.content, v1).toString("hex"));
  assert.equal(entry(rewrite).form, 2, "its base is held as a chunk of `a`");
  assert.equal(entry(rewrite).base, nativeId(TYPES.content, chunk).toString("hex"));
  for (const check of [["fsck"], ["import", "--verify"]]) {
    const result = cst(native, check);
    assert.equal(result.status, 0, `${check.join(" ")}: ${result.stderr}`);
  }
});

test("a base is looked up by the first entry of its name, whatever that entry's mode", () => {
  const root = scratch();
  const { git, commit, blob } = makeRepository(root);
  const [first, second] = largeVersions(2, "modes");
  const [a, b] = [blob(first), blob(Buffer.concat([first, Buffer.from("x")]))];
  // A tree Git would refuse: `f` twice, the first with a mode that is not octal.
  const entry = (mode, name, id) => Buffer.concat([Buffer.from(`${mode} ${name}\0`), Buffer.from(id, "hex")]);
  const tree = git(["hash-object", "-t", "tree", "-w", "--literally", "--stdin"],
    Buffer.concat([entry("1x0644", "f", a), entry("100644", "f", b)])).toString().trim();
  const parent = git(["commit-tree", tree, "-m", "hostile"]).toString().trim();
  const child = commit([["f", second]], "child", parent);
  git(["update-ref", "refs/heads/main", child]);
  imports(root, "source", "native");
  const stored = forms(path.join(root, "native"));
  assert.equal(stored.get(nativeId(TYPES.content, second).toString("hex")).form, 1);
});
