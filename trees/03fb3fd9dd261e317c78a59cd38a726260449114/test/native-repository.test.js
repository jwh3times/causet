/**
 * A native repository (N1, ADR-0045, #301 and #302): `cst import` copies
 * every object a Git repository's refs reach into one, and its refs into a
 * snapshot; there `cst cat-file` answers as `git cat-file` does on the
 * original, byte for byte once IDs are translated through the alias map,
 * without running Git. A source Git reads differently from its stored
 * objects (shallow, partial or grafted) is refused. Both commands are
 * experimental and refused without `CAUSET_EXPERIMENTAL=native`.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { pathToFileURL } from "node:url";
import { testEnv } from "../test-support/git-environment.js";
import { cstCommand, cstPrefix } from "../test-support/cst-command.js";
import { aliases } from "../test-support/native-store.js";

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
 * a tree that is not canonical, and tags on a blob and a tree. Its commits
 * and tags carry what a payload must keep byte for byte: a signature, a
 * message that is not UTF-8 with its encoding header, an extra header, a
 * mergetag, a message naming a commit by its full ID, a tag with an inline
 * signature, and a tag of a tag.
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
  const three = commit([["100644", zz, "top"]], "three", second);
  git(["update-ref", "refs/heads/odd", three]);
  git(["tag", "tree-tag", parent]);
  git(["tag", "-a", "-m", "a blob", "blob-tag", zz]);

  const literally = (kind, bytes) => git(["hash-object", "-t", kind, "-w", "--literally", "--stdin"], bytes).toString().trim();
  const people = [`author ${IDENTITY.GIT_AUTHOR_NAME} <${IDENTITY.GIT_AUTHOR_EMAIL}> ${IDENTITY.GIT_AUTHOR_DATE}`,
    `committer ${IDENTITY.GIT_COMMITTER_NAME} <${IDENTITY.GIT_COMMITTER_EMAIL}> ${IDENTITY.GIT_COMMITTER_DATE}`];
  const tagger = `tagger ${IDENTITY.GIT_COMMITTER_NAME} <${IDENTITY.GIT_COMMITTER_EMAIL}> ${IDENTITY.GIT_COMMITTER_DATE}`;
  const tree2 = git(["rev-parse", `${second}^{tree}`]).toString().trim();
  const signed = literally("commit", Buffer.concat([
    Buffer.from([`tree ${tree2}`, `parent ${second}`, ...people, "encoding ISO-8859-1", "change-id zxyw",
      "gpgsig -----BEGIN PGP SIGNATURE-----", " ", " iQEzBAABCAAdFiEEexample", " =abcd", " -----END PGP SIGNATURE-----",
      "", ""].join("\n")),
    Buffer.from([0x63, 0x61, 0x66, 0xe9]), Buffer.from(` reverts ${first}\n`),
  ]));
  const merge = literally("commit", Buffer.from([`tree ${tree2}`, `parent ${signed}`, `parent ${three}`, ...people,
    `mergetag object ${three}`, " type commit", " tag v-three", ` ${tagger}`, " ", " the third", "", "merge, no newline"].join("\n")));
  git(["update-ref", "refs/heads/signed", merge]);
  const signedTag = literally("tag", Buffer.from([`object ${signed}`, "type commit", "tag signed-tag", tagger, "",
    "a signed tag", "-----BEGIN PGP SIGNATURE-----", "", "iQEzexample", "-----END PGP SIGNATURE-----", ""].join("\n")));
  git(["update-ref", "refs/tags/signed-tag", signedTag]);
  const chain = literally("tag", Buffer.from([`object ${signedTag}`, "type tag", "tag chain", tagger, "", "on a tag", ""].join("\n")));
  git(["update-ref", "refs/tags/chain", chain]);
  return { root, repo, git, odd, parent, first, second, signed, merge, chain };
}

/**
 * `cat-file -p` of a commit or tag as a native repository prints it: Git's
 * payload with the IDs of the header lines Git's parser follows translated:
 * the first line (a commit's tree, a tag's object) and a commit's parent
 * lines straight after it.
 */
function translateHeaders(kind, text, rows) {
  const lines = text.split("\n");
  let followed = true;
  return lines.map((line, index) => {
    const name = index === 0 ? (kind === "commit" ? "tree" : "object") : kind === "commit" ? "parent" : null;
    const id = line.slice(`${name} `.length);
    followed &&= name !== null && line.startsWith(`${name} `);
    return followed && rows.has(id) ? `${name} ${rows.get(id)}` : line;
  }).join("\n");
}

/** `cst` with no Git on `PATH`, so any Git process it started would fail. */
function cstWithoutGit(cwd, args) {
  const noGit = fs.mkdtempSync(path.join(scratch(), "no-git-"));
  const env = Object.fromEntries(Object.entries(testEnv(OPT_IN)).filter(([name]) => name.toUpperCase() !== "PATH"));
  env.PATH = noGit;
  return spawnSync(cstCommand, [...cstPrefix(), ...args], { cwd, env, encoding: "buffer" });
}

function count(number, noun) {
  return `${number} ${noun}${number === 1 ? "" : "s"}`;
}

/** What `cst import --verify` prints for a store of these Git objects. */
function verifiedAs(kinds) {
  return `: ${count(kinds.blob ?? 0, "blob")}, ${count(kinds.tree ?? 0, "tree")}, ${count(kinds.commit ?? 0, "commit")} and ${count(kinds.tag ?? 0, "tag")}, each rebuilt to its Git ID.\n`;
}

/**
 * Flips a byte in the middle of each content frame (storage.md §4.1) of the
 * store's one container. Its index still checks; the objects in those frames
 * no longer read.
 */
function damageContent(store) {
  const objects = path.join(store, ".cst", "objects");
  const [name] = fs.readdirSync(objects).filter((entry) => entry.endsWith(".cstc"));
  const file = path.join(objects, name);
  const bytes = fs.readFileSync(file);
  const index = Number(bytes.readBigUInt64BE(bytes.length - 72));
  for (let frame = 0; frame < bytes.readUInt32BE(index + 8); frame++) {
    const at = index + 24 + 24 * frame;
    if (bytes[at + 21] === 1) {
      bytes[Number(bytes.readBigUInt64BE(at)) + Math.floor(Number(bytes.readBigUInt64BE(at + 8)) / 2)] ^= 0x01;
    }
  }
  fs.writeFileSync(file, bytes);
}

function imported(format) {
  const source = makeSource(format);
  const destination = path.join(source.root, "native");
  const result = cst(source.root, ["import", "source", "native"]);
  assert.equal(result.status, 0, result.stderr.toString());
  return { ...source, destination, aliases: aliases(destination, format), stdout: result.stdout.toString() };
}

for (const format of ["sha1", "sha256"]) {
  test(`every object the refs reach is imported and prints as git cat-file prints it (${format})`, () => {
    const { git, destination, aliases: rows } = imported(format);
    const objects = git(["rev-list", "--objects", "--no-object-names", "--all"]).toString().trim().split("\n");
    const kinds = new Map(objects.map((id) => [id, git(["cat-file", "-t", id]).toString().trim()]));
    assert.deepEqual(new Set(kinds.values()), new Set(["blob", "tree", "commit", "tag"]));
    assert.equal(rows.size, objects.length, "one alias row per object rev-list --objects --all reports, and no others");
    const translate = (text) => text.replace(new RegExp(`\\b[0-9a-f]{${format === "sha1" ? 40 : 64}}\\b`, "g"),
      (id) => rows.get(id) ?? id);
    for (const id of objects) {
      const native = rows.get(id);
      assert.ok(native, `${id} has an alias row`);
      const kind = kinds.get(id);
      for (const flag of ["-p", "-t", "-s"]) {
        const expected = git(["cat-file", flag, id]);
        const answered = cst(destination, ["cat-file", flag, native]);
        assert.equal(answered.status, 0, answered.stderr.toString());
        let wanted = expected;
        if (flag === "-p" && kind === "tree") {
          wanted = Buffer.from(translate(expected.toString("latin1")), "latin1");
        } else if (flag === "-p" && kind !== "blob") {
          wanted = Buffer.from(translateHeaders(kind, expected.toString("latin1"), rows), "latin1");
        }
        assert.deepEqual(answered.stdout, wanted, `cat-file ${flag} ${id} (${kind})`);
      }
    }
  });
}

for (const format of ["sha1", "sha256"]) {
  test(`every imported object rebuilds to its Git ID, and the check runs no Git (${format})`, () => {
    const { git, destination } = imported(format);
    const objects = git(["rev-list", "--objects", "--no-object-names", "--all"]);
    const kinds = {};
    for (const kind of git(["cat-file", "--batch-check=%(objecttype)"], objects).toString().trim().split("\n")) {
      kinds[kind] = (kinds[kind] ?? 0) + 1;
    }
    assert.deepEqual(Object.keys(kinds).sort(), ["blob", "commit", "tag", "tree"]);
    const verified = cstWithoutGit(destination, ["import", "--verify"]);
    assert.equal(verified.status, 0, verified.stderr.toString());
    assert.ok(verified.stdout.toString().startsWith("Verified "), verified.stdout.toString());
    assert.ok(verified.stdout.toString().endsWith(verifiedAs(kinds)), verified.stdout.toString());
  });
}

test("a damaged native object fails the check, which names it and checks the rest", () => {
  const root = scratch();
  const repo = path.join(root, "source");
  fs.mkdirSync(repo);
  const git = gitIn(repo);
  git(["init", "-q", "-b", "main"]);
  fs.writeFileSync(path.join(repo, "only.txt"), "the only file\n");
  git(["add", "only.txt"]);
  git(["commit", "-q", "-m", "one"]);
  const result = cst(root, ["import", "source", "native"]);
  assert.equal(result.status, 0, result.stderr.toString());
  const destination = path.join(root, "native");
  const blob = git(["rev-parse", "HEAD:only.txt"]).toString().trim();
  const rows = aliases(destination, "sha1");
  damageContent(destination);
  const refused = cst(destination, ["import", "--verify"]);
  assert.equal(refused.status, 1);
  const lines = refused.stderr.toString().trim().split("\n");
  assert.equal(lines[0], "cst: the native store is corrupt: 1 object fails the reconstruction check (objects.md §9.2):");
  assert.equal(lines.length, 2, refused.stderr.toString());
  assert.ok(lines[1].startsWith(`  sha1 ${blob} (native ${rows.get(blob)}): `), lines[1]);
});

test("the check needs a native repository, at most one, and the opt-in", () => {
  const { root, repo, destination } = imported("sha1");
  const outside = cst(repo, ["import", "--verify"]);
  assert.equal(outside.status, 1);
  assert.match(outside.stderr.toString(), /is not in a native repository, so there is nothing to verify/);
  const two = cst(root, ["import", "--verify", "native", "source"]);
  assert.equal(two.status, 1);
  assert.match(two.stderr.toString(), /takes at most one native repository/);
  // A named repository is named by its root, so a mistyped path within one
  // cannot verify it.
  for (const named of ["native/.cst", "native/no/such/path", "source", ""]) {
    const refused = cst(root, ["import", "--verify", named]);
    assert.equal(refused.status, 1, named);
    assert.match(refused.stderr.toString(), /is not a native repository: it has no \.cst\/format/, named);
  }
  for (const [cwd, args] of [[root, ["import", "--verify", "native"]], [path.join(destination, ".cst"), ["import", "--verify"]]]) {
    const verified = cst(cwd, args);
    assert.equal(verified.status, 0, verified.stderr.toString());
  }
  const refused = cst(destination, ["import", "--verify"], {});
  assert.equal(refused.status, 1);
  assert.match(refused.stderr.toString(), /CAUSET_EXPERIMENTAL=native/);
});

test("a path through trees, commits and tags, and an unambiguous prefix, name the object Git names", () => {
  const { git, destination, aliases: rows, parent, second, chain } = imported("sha1");
  const root = rows.get(git(["rev-parse", "main^{tree}"]).toString().trim());
  for (const [native, revision] of [[`${root}:a/f`, "main:a/f"], [`${root.slice(0, 10)}:big.bin`, "main:big.bin"],
    [`${rows.get(parent)}:weird/zz`, `${parent}:weird/zz`], [`${rows.get(second)}:a/f`, `${second}:a/f`],
    [`${rows.get(chain)}:hello.txt`, `${chain}:hello.txt`]]) {
    const answered = cst(destination, ["cat-file", "-p", native]);
    assert.equal(answered.status, 0, answered.stderr.toString());
    assert.deepEqual(answered.stdout, git(["cat-file", "-p", revision]));
  }
  const missing = cst(destination, ["cat-file", "-p", `${root}:no/such/path`]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr.toString(), /path 'no\/such\/path' does not exist/);
});

test("import reports what it wrote and keeps a tree that is not canonical in Git's encoding", () => {
  const { stdout, aliases: rows, odd, second, destination } = imported("sha1");
  assert.match(stdout, /^Imported source into native: \d+ blobs, \d+ trees, 1 kept in Git's encoding, 5 commits, 3 tags, from a sha1 repository\.$/m);
  assert.match(stdout, new RegExp(`^Its ref snapshot records 8 refs, 1 symbolic\\. HEAD is at ${rows.get(second)}\\.$`, "m"));
  assert.ok(rows.get(odd));
  const snapshot = fs.readFileSync(path.join(destination, ".cst", "snapshot"), "latin1");
  assert.match(snapshot, /^[0-9a-f]{64}\n$/);
  assert.equal(cst(destination, ["cat-file", "-t", snapshot.trim()]).stdout.toString(), "snapshot\n");
});

test("reading a native repository runs no Git", () => {
  const { destination, aliases: rows, git } = imported("sha1");
  const tree = rows.get(git(["rev-parse", "main^{tree}"]).toString().trim());
  const answered = cstWithoutGit(destination, ["cat-file", "-p", `${tree}:hello.txt`]);
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
  assert.match(help.stdout.toString(), /cst import --verify \[<native-repo>\]/);
});

test("the help of a Git-backed repository lists the experimental commands as such", () => {
  const { repo } = makeSource("sha1");
  const help = cst(repo, ["--help"]).stdout.toString();
  assert.match(help, /Experimental, and not contracts: they need CAUSET_EXPERIMENTAL=native/);
  assert.match(help, /cst import <git-repo> <dest>/);
  assert.match(help, /cst import --verify \[<native-repo>\]/);
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
  const verified = cst(destination, ["import", "--verify"]);
  assert.equal(verified.status, 0, verified.stderr.toString());
  assert.ok(verified.stdout.toString().endsWith(verifiedAs({ blob: 2, tree: 3, commit: 2 })), verified.stdout.toString());
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

test("a replacement ref is recorded, and the object it replaces imports as stored", () => {
  const root = scratch();
  const repo = path.join(root, "source");
  fs.mkdirSync(repo);
  const git = gitIn(repo);
  git(["init", "-q", "-b", "main"]);
  const tree = git(["write-tree"]).toString().trim();
  const stored = git(["commit-tree", tree, "-m", "as stored"]).toString().trim();
  const replacement = git(["commit-tree", tree, "-m", "the replacement"]).toString().trim();
  git(["update-ref", "refs/heads/main", stored]);
  git(["replace", stored, replacement]);
  assert.match(git(["cat-file", "-p", stored]).toString(), /the replacement/, "Git itself reads the replacement");
  const result = cst(root, ["import", "source", "native"]);
  assert.equal(result.status, 0, result.stderr.toString());
  assert.match(result.stdout.toString(), /records 3 refs, 1 symbolic/);
  const destination = path.join(root, "native");
  const rows = aliases(destination, "sha1");
  const printed = cst(destination, ["cat-file", "-p", rows.get(stored)]).stdout.toString();
  assert.equal(printed, translateHeaders("commit", git(["--no-replace-objects", "cat-file", "-p", stored]).toString(), rows));
  assert.match(printed, /as stored/);
  assert.ok(rows.get(replacement), "the replacement, which its ref reaches, is imported too");
});

test("only the header lines Git's parser follows are translated, and a path is looked up through the first", () => {
  const root = scratch();
  const repo = path.join(root, "source");
  fs.mkdirSync(repo);
  const git = gitIn(repo);
  git(["init", "-q", "-b", "main"]);
  const tree = (name) => git(["mktree"], Buffer.from(`100644 blob ${git(["hash-object", "-w", "--stdin"], `${name}\n`).toString().trim()}\t${name}\n`)).toString().trim();
  const [here, there] = [tree("here"), tree("there")];
  const base = git(["commit-tree", here, "-m", "base"]).toString().trim();
  const other = git(["commit-tree", there, "-m", "other"]).toString().trim();
  const literally = (kind, text) => git(["hash-object", "-t", kind, "-w", "--literally", "--stdin"], Buffer.from(text)).toString().trim();
  // A later `parent`, `tree` or `object` line is one Git's parser does not
  // follow, though each names an object the refs reach.
  const late = literally("commit", [`tree ${here}`, `parent ${base}`, "author A <a@e> 1 +0000", `parent ${other}`,
    "committer C <c@e> 1 +0000", `tree ${there}`, "", "late lines", ""].join("\n"));
  const tag = literally("tag", [`object ${late}`, "type commit", "tag late", "tagger T <t@e> 1 +0000", `object ${other}`,
    "", "a late object line", ""].join("\n"));
  git(["update-ref", "refs/heads/main", late]);
  git(["update-ref", "refs/heads/other", other]);
  git(["update-ref", "refs/tags/late", tag]);
  assert.equal(cst(root, ["import", "source", "native"]).status, 0);
  const destination = path.join(root, "native");
  const rows = aliases(destination, "sha1");

  for (const [id, kind] of [[late, "commit"], [tag, "tag"]]) {
    const printed = cst(destination, ["cat-file", "-p", rows.get(id)]).stdout.toString();
    assert.equal(printed, translateHeaders(kind, git(["cat-file", "-p", id]).toString(), rows));
    assert.match(printed, new RegExp(`^(parent|object) ${other}$`, "m"), "the late line prints as stored");
  }
  for (const [id, name] of [[late, "here"], [late, "there"], [tag, "here"], [tag, "there"]]) {
    const expected = spawnSync("git", ["cat-file", "-p", `${id}:${name}`], { cwd: repo, env: testEnv() });
    const answered = cst(destination, ["cat-file", "-p", `${rows.get(id)}:${name}`]);
    assert.equal(answered.status === 0, expected.status === 0, `${id}:${name}: ${answered.stderr}`);
    assert.equal(answered.stdout.toString(), expected.stdout.toString(), `${id}:${name}`);
  }
  const verified = cst(destination, ["import", "--verify"]);
  assert.equal(verified.status, 0, verified.stderr.toString());
});

test("shallow, partial and grafted sources are refused before anything is written, each naming why", () => {
  const { root, repo, git, first } = makeSource("sha1");
  git(["config", "uploadpack.allowFilter", "true"]);
  const url = pathToFileURL(repo).href;
  const clone = (name, args) => {
    execFileSync("git", ["clone", "-q", "--no-checkout", ...args, url, name], { cwd: root, env: testEnv(IDENTITY) });
    return name;
  };
  const grafted = clone("grafted", []);
  // A promisor remote whose name holds a space, and one whose value is true
  // in a spelling Git accepts, each the only sign of a partial clone (older
  // Git also writes extensions.partialClone, which goes).
  const spaced = clone("spaced", ["--filter=blob:none"]);
  execFileSync("git", ["config", "--rename-section", "remote.origin", "remote.a b"], { cwd: path.join(root, spaced), env: testEnv() });
  spawnSync("git", ["config", "--unset", "extensions.partialClone"], { cwd: path.join(root, spaced), env: testEnv() });
  const spelled = clone("spelled", ["--filter=blob:none"]);
  execFileSync("git", ["config", "remote.origin.promisor", "1k"], { cwd: path.join(root, spelled), env: testEnv() });
  spawnSync("git", ["config", "--unset", "extensions.partialClone"], { cwd: path.join(root, spelled), env: testEnv() });
  fs.writeFileSync(path.join(root, grafted, ".git", "info", "grafts"), `# a comment\n${first}\n`);
  for (const [source, reason] of [
    [clone("shallow", ["--depth", "1"]), /is a shallow clone/],
    [clone("partial", ["--filter=blob:none"]), /is a partial clone \(\S+\)/],
    [grafted, /has grafts/],
    [spaced, /is a partial clone \(remote\.a b\.promisor\)/],
    [spelled, /is a partial clone \(remote\.origin\.promisor\)/],
  ]) {
    const refused = cst(root, ["import", source, `${source}-native`]);
    assert.equal(refused.status, 1, source);
    assert.match(refused.stderr.toString(), reason, source);
    assert.match(refused.stderr.toString(), /cannot be imported exactly/, source);
    assert.equal(fs.existsSync(path.join(root, `${source}-native`)), false, `${source}: nothing is written`);
  }
  fs.writeFileSync(path.join(root, grafted, ".git", "info", "grafts"), "# only a comment\n\n");
  const commented = cst(root, ["import", grafted, "commented-native"]);
  assert.equal(commented.status, 0, commented.stderr.toString());
});

test("import reads the repository it names: a linked worktree's main refs, whatever Git variables the caller set", () => {
  const { root, repo, git, first, second } = makeSource("sha1");
  git(["worktree", "add", "-q", "--no-checkout", "-b", "elsewhere", path.join(root, "linked"), first]);
  // A commit only a detached worktree's HEAD reaches: imported, not recorded.
  git(["worktree", "add", "-q", "--no-checkout", "--detach", path.join(root, "detached"), first]);
  const alone = gitIn(path.join(root, "detached"));
  const blob = alone(["hash-object", "-w", "--stdin"], "only in a worktree\n").toString().trim();
  const tree = alone(["mktree"], `100644 blob ${blob}\tlone\n`).toString().trim();
  alone(["update-ref", "--no-deref", "HEAD", alone(["commit-tree", tree, "-m", "lone"]).toString().trim()]);
  const other = path.join(root, "other");
  fs.mkdirSync(other);
  gitIn(other)(["init", "-q"]);
  const grafts = path.join(root, "grafts");
  fs.writeFileSync(grafts, `${second}\n`);
  const result = cst(root, ["import", "linked", "native"], {
    ...OPT_IN, GIT_DIR: path.join(other, ".git"), GIT_NAMESPACE: "hidden", GIT_GRAFT_FILE: grafts,
  });
  assert.equal(result.status, 0, result.stderr.toString());
  const rows = aliases(path.join(root, "native"), "sha1");
  assert.match(result.stdout.toString(), new RegExp(`HEAD is at ${rows.get(second)}\\.`), "the main worktree's HEAD");
  assert.match(result.stdout.toString(), /records 9 refs/, "the main worktree's refs, and the new branch");
  const objects = git(["rev-list", "--objects", "--no-object-names", "--all"]).toString().trim().split("\n");
  assert.equal(rows.size, objects.length, "the grafted-away history, and what only a worktree reaches, are imported too");
  assert.ok(rows.get(blob));
});
