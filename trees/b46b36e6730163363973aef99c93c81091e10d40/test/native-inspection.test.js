/**
 * N1's inspection commands in a native repository (#304, ADR-0046 decisions
 * 3 and 9): `cst ls-tree`, `cst rev-parse` and `cst for-each-ref` answer as
 * Git does on the original, byte for byte once Git's IDs are translated
 * through the alias map, and `cst fsck` verifies every copy of every object
 * and tells content absent by promise or by policy from corruption.
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { testEnv } from "../test-support/git-environment.js";
import { cstCommand, cstPrefix } from "../test-support/cst-command.js";
import {
  TYPES, addAbsent, addContainer, aliases, annotation, containers, markAbsent, nativeId, removeEntry, setVersion, sharingShort,
} from "../test-support/native-store.js";

const created = [];

after(() => {
  for (const directory of created) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function scratch() {
  const parent = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "causet-native-inspection-")));
  created.push(parent);
  return parent;
}

const OPT_IN = { CAUSET_EXPERIMENTAL: "native" };

function cst(cwd, args) {
  return spawnSync(cstCommand, [...cstPrefix(), ...args], { cwd, env: testEnv(OPT_IN), encoding: "buffer" });
}

const IDENTITY = {
  GIT_AUTHOR_NAME: "A U Thor", GIT_AUTHOR_EMAIL: "author@example.com", GIT_AUTHOR_DATE: "1112911993 -0700",
  GIT_COMMITTER_NAME: "C O Mitter", GIT_COMMITTER_EMAIL: "committer@example.com", GIT_COMMITTER_DATE: "1112911993 -0700",
};

/**
 * A history built from Git's plumbing alone, so any name works on every
 * platform: names that need quoting, an executable, a symlink, a submodule
 * link, a tree Git would not write, a merge, tags of every kind, and refs
 * whose short names are ambiguous or symbolic.
 */
function makeHistory(format) {
  const root = scratch();
  const repo = path.join(root, "source");
  fs.mkdirSync(repo);
  const run = (args, input) => execFileSync("git", args, { cwd: repo, env: testEnv(IDENTITY), input });
  const git = (args, input) => run(args, input).toString().trim();
  git(["init", "-q", "-b", "main", `--object-format=${format}`]);
  const blob = (text) => git(["hash-object", "-w", "--stdin"], text);
  const tree = (entries) => git(["mktree", "-z"], Buffer.from(entries.map(([mode, type, id, name]) => `${mode} ${type} ${id}\t${name}\0`).join("")));
  const commit = (id, message, ...parents) => git(["commit-tree", id, "-m", message, ...parents.flatMap((parent) => ["-p", parent])]);
  const width = format === "sha1" ? 40 : 64;
  const file = blob("a file\n");
  const sub = tree([["100644", "blob", blob("deep\n"), "file"], ["100755", "blob", blob("#!/bin/sh\n"), "run"]]);
  const dir = tree([["040000", "tree", sub, "sub"], ["100644", "blob", blob("g\n"), "g"], ["100644", "blob", blob("dir\n"), "dir.txt"]]);
  const first = tree([
    ["100644", "blob", file, "top"], ["040000", "tree", dir, "dir"], ["120000", "blob", blob("top"), "link"],
    ["100644", "blob", blob("quoted\n"), "sp ace"], ["100644", "blob", blob("tab\n"), "tab\tname"],
    ["100644", "blob", blob("accent\n"), "é"], ["100644", "blob", blob("q\n"), 'q"x'],
    ["160000", "commit", "1".repeat(width), "module"],
  ]);
  const one = commit(first, "one");
  const second = tree([["100644", "blob", blob("top two\n"), "top"], ["040000", "tree", dir, "dir"]]);
  const two = commit(second, "two", one);
  const side = commit(tree([["100644", "blob", blob("side\n"), "side"]]), "side", one);
  const merge = commit(second, "merge", two, side);
  // A tree Git accepts but would not write: a zero-padded mode, kept in
  // Git's encoding.
  const literal = Buffer.concat([Buffer.from("040000 sub\0"), Buffer.from(sub, "hex"), Buffer.from("100644 top\0"), Buffer.from(file, "hex")]);
  const odd = git(["hash-object", "-t", "tree", "-w", "--literally", "--stdin"], literal);
  const ref = (name, id) => git(["update-ref", name, id]);
  ref("refs/heads/main", merge);
  ref("refs/heads/side", side);
  ref("refs/heads/v1", one);
  ref("refs/remotes/origin/main", two);
  git(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
  git(["symbolic-ref", "refs/heads/sym", "refs/heads/main"]);
  git(["symbolic-ref", "refs/heads/sym2", "refs/heads/sym"]);
  git(["tag", "-a", "-m", "v1", "v1", merge]);
  git(["-c", "advice.nestedTag=false", "tag", "-a", "-m", "a tag of a tag", "chain", "refs/tags/v1"]);
  git(["tag", "-a", "-m", "a tree", "tree-tag", dir]);
  git(["tag", "-a", "-m", "a blob", "blob-tag", file]);
  git(["tag", "light", two]);
  ref("refs/tags/odd", odd);
  ref("refs/tags/raw-blob", file);
  git(["symbolic-ref", "HEAD", "refs/heads/main"]);
  assert.equal(execFileSync(cstCommand, [...cstPrefix(), "import", "source", "native"], { cwd: root, env: testEnv(OPT_IN) }).length > 0, true);
  const native = path.join(root, "native");
  const rows = aliases(native, format);
  const translate = (text) => text.replace(new RegExp(`\\b[0-9a-f]{${width}}\\b`, "g"), (id) => rows.get(id) ?? id);
  return { repo, native, rows, translate, one, file, merge };
}

/** Runs Git on the original and cst on the native copy, and compares them. */
function same(history, gitArgs, cstArgs = gitArgs) {
  const expected = spawnSync("git", gitArgs, { cwd: history.repo, env: testEnv(IDENTITY), encoding: "buffer" });
  const answered = cst(history.native, cstArgs);
  const shown = gitArgs.join(" ");
  assert.equal(answered.status === 0, expected.status === 0, `${shown}: git ${expected.status}, cst ${answered.status}: ${answered.stderr}${expected.stderr}`);
  assert.equal(answered.stdout.toString("latin1"), history.translate(expected.stdout.toString("latin1")), shown);
}

for (const format of ["sha1", "sha256"]) {
  test(`ls-tree lists a tree as git ls-tree does, every flag and path spec (${format})`, () => {
    const history = makeHistory(format);
    const flags = [[], ["-r"], ["-t"], ["-d"], ["-r", "-t"], ["-rt"], ["-d", "-r"], ["-l"], ["-r", "-l"], ["--long", "-t"],
      ["--name-only"], ["-r", "--name-status"], ["--object-only", "-r"], ["-z"], ["-r", "-z", "--name-only"], ["--full-tree", "--full-name"],
      ["--format=%(objectmode) %(objecttype) %(objectname) %(objectsize) %(objectsize:padded)|%(path)%x41%%%n"], ["-z", "--format=[%(path)]"],
      // The formats Git prints by its modes, which quote no path under -z.
      ["-z", "--format=%(path)"], ["-z", "--format=%(objectname)"], ["-z", "-r", "--format=%(objectmode) %(objecttype) %(objectname)%x09%(path)"],
      ["-z", "--format=%(objectmode) %(objecttype) %(objectname) %(objectsize:padded)%x09%(path)"]];
    const paths = [[], ["dir"], ["dir/"], ["dir/sub/file"], ["dir/sub/file/"], ["nope"], [".", "top"], ["dir//sub"], ["./dir/../top"],
      ["link/x"], ["module"], ["module/"], ["dir/s"], ["top", "dir/sub/"], ["é", "sp ace"]];
    for (const flag of flags) {
      for (const spec of paths) same(history, ["ls-tree", ...flag, "HEAD", ...spec]);
    }
    for (const treeish of ["main", "v1", "chain", "v1^{tree}", "HEAD~1", "HEAD^2", "HEAD:dir", "HEAD:dir/sub", "tree-tag", "odd", "blob-tag", "nope", "HEAD:top"]) {
      same(history, ["ls-tree", treeish]);
      same(history, ["ls-tree", "-r", "-l", treeish]);
    }
    same(history, ["ls-tree", history.one], ["ls-tree", history.rows.get(history.one)]);
    for (const refused of [["-l", "--name-only", "HEAD"], ["--format=%(path)", "-l", "HEAD"], ["--format=%(nope)", "HEAD"], ["--format=%Z", "HEAD"], ["HEAD", ".."], ["HEAD", ""], []]) {
      same(history, ["ls-tree", ...refused]);
    }
  });

  test(`rev-parse names objects as git rev-parse does (${format})`, () => {
    const history = makeHistory(format);
    const cases = [
      ["HEAD"], ["main", "side", "v1", "refs/heads/v1", "heads/v1", "origin/main", "origin", "@"],
      ["HEAD~1", "HEAD~", "HEAD^", "HEAD^2", "HEAD^0", "HEAD~2", "HEAD^2~1", "v1~0", "v1^0", "chain~1"],
      ["v1^{}", "v1^{commit}", "v1^{tree}", "v1^{object}", "v1^{tag}", "chain^{}", "chain^{commit}", "chain^{tag}", "tree-tag^{tree}", "blob-tag^{blob}", "HEAD^{}^{tree}"],
      ["HEAD:dir/sub/file", "HEAD:dir", "HEAD:", "v1:dir/g", "HEAD~1:top"],
      ["HEAD~1..HEAD", "..HEAD", "HEAD~1..", "side..v1", "HEAD~1..HEAD:top", "HEAD:dir..HEAD"], ["nope", "--", "main"],
      ["main^{commit}}", "main^{tree}x}", "HEAD^-+1"], ["HEAD^@", "HEAD^!", "HEAD^-", "HEAD^-2", "v1^!"], ["^HEAD~1", "HEAD"],
      ["--verify", "HEAD"], ["--verify", "v1^{tree}"], ["--verify", "HEAD", "main"], ["--verify", "-q", "nope"], ["--verify", "nope"], ["--verify", "--quiet", "HEAD~1..HEAD"],
      ["HEAD", "--", "x", "--verify"], ["--end-of-options", "HEAD"],
      ["--symbolic-full-name", "HEAD", "main", "v1", "sym2", "origin", "HEAD~1", "^main", "@", "refs/heads/v1"],
      ["--abbrev-ref", "HEAD", "refs/heads/v1", "sym2", "origin", "refs/remotes/origin/main", "refs/tags/chain"], ["--abbrev-ref=loose", "refs/heads/v1", "HEAD"],
      ["--symbolic", "HEAD~", "main", "HEAD^!"], ["--all"], ["--branches"], ["--tags"], ["--remotes"], ["--symbolic", "--all"], ["--symbolic-full-name", "--tags"],
      ["--symbolic", "--branches", "--remotes"], ["--abbrev-ref", "--all"],
      ["nope"], ["HEAD", "nope"], ["HEAD:nope"], ["v1^{blob}"], ["HEAD^3"], ["HEAD~9"], ["side^2"], ["blob-tag^0"], ["HEAD^{nope}"],
    ];
    for (const args of cases) same(history, ["rev-parse", ...args]);
    const native = history.rows.get(history.one);
    same(history, ["rev-parse", history.one, `${history.one}^{tree}`, `${history.one}:top`], ["rev-parse", native, `${native}^{tree}`, `${native}:top`]);
    // A name `git describe` prints: what follows `-g` is a prefix of a commit.
    const merge = history.rows.get(history.merge);
    for (const shape of ["v1-1-g%", "a--12-g%~1"]) {
      same(history, ["rev-parse", shape.replace("%", history.merge.slice(0, 12))], ["rev-parse", shape.replace("%", merge.slice(0, 12))]);
    }
    // Not the shape `git describe` prints, so no name, there as here.
    for (const shape of ["x-g%", "-1-g%", "a-g1-g%"]) {
      const name = (prefix) => shape.replace("%", prefix);
      assert.notEqual(spawnSync("git", ["rev-parse", "--verify", "-q", name(history.merge.slice(0, 12))], { cwd: history.repo, env: testEnv() }).status, 0, shape);
      assert.notEqual(cst(history.native, ["rev-parse", "--verify", "-q", name(merge.slice(0, 12))]).status, 0, shape);
    }
  });

  test(`for-each-ref lists the refs as git for-each-ref does (${format})`, () => {
    const history = makeHistory(format);
    const cases = [
      [], ["--format=%(refname) %(objectname) %(objecttype) %(objectsize)"],
      ["--format=%(refname:short) %(refname:lstrip=1) %(refname:rstrip=-2) %(refname:strip=-1) %(refname:lstrip=-9)|%(symref)|%(symref:short)|%(HEAD)"],
      ["--format=%(*objectname) %(*objecttype) %(*objectsize)|%(tree)|%(parent)|%(numparent)|%(object)|%(*tree)|%(*parent)"],
      ["--format=%%%41%(refname)%zz%"], ["--format", "%(refname)", "refs/tags"],
      ["refs/heads"], ["refs/heads/"], ["refs/heads/*"], ["refs/t*"], ["refs/**/main"], ["refs/tags/v?", "refs/remotes/"], ["refs/heads/s[iy]*"], ["heads"], ["refs/**/*n"], ["refs/**/*1", "**/v*"], ["refs/**/*/main"],
      ["--sort=-refname", "--count=3"], ["--count=0"], ["--sort=refname", "refs/tags"],
      ["--format=%(nope)"], ["--format=%(refname"], ["--format=%(refname:lstrip=x)"], ["--count=-1"],
    ];
    for (const args of cases) same(history, ["for-each-ref", ...args]);
  });
}

test("what Git's commands do beyond N1's part of them is refused, naming it", () => {
  const history = makeHistory("sha1");
  for (const [args, pattern] of [
    [["rev-parse", "--short", "HEAD"], /cst rev-parse --short is not implemented in a native repository yet/],
    [["rev-parse", "--git-dir"], /--git-dir is not implemented/],
    [["rev-parse", "HEAD...side"], /merge bases/],
    [["rev-parse", "HEAD@{1}"], /reflog/],
    [["rev-parse", ":top"], /index/],
    [["rev-parse", "HEAD~2:module"], /submodule link/],
    [["ls-tree", "--abbrev", "HEAD"], /--abbrev/],
    [["ls-tree", "HEAD", ":(top)dir"], /magic/],
    [["for-each-ref", "--format=%(subject)"], /%\(subject\)/],
    [["for-each-ref", "--sort=objectname"], /--sort=objectname/],
    [["for-each-ref", "--points-at", "HEAD"], /--points-at/],
  ]) {
    const result = cst(history.native, args);
    assert.notEqual(result.status, 0, args.join(" "));
    assert.equal(result.stdout.length, 0, args.join(" "));
    assert.match(result.stderr.toString(), pattern, args.join(" "));
  }
});

/** The native ID of an imported blob, and its bytes. */
function blobOf(history) {
  return { id: history.rows.get(history.file), bytes: Buffer.from("a file\n") };
}

test("fsck verifies an imported store, every object present", () => {
  const history = makeHistory("sha1");
  const result = cst(history.native, ["fsck"]);
  assert.equal(result.status, 0, result.stderr.toString());
  assert.match(result.stdout.toString(), /^Verified .*: \d+ objects in 1 container, each present copy checked\. \d+ present, 0 absent by promise, 0 absent by policy\.\n$/);
});

test("a store of format version 0 is refused by every native command, which says to import again", () => {
  const history = makeHistory("sha1");
  const { id } = blobOf(history);
  setVersion(history.native, 0);
  const refusal = /\.cst[\\/]format says the store is format version 0, and this build reads only version 1\. To use it with this build, import the repository again into a new directory/;
  for (const args of [
    ["cat-file", "-p", id], ["ls-tree", "HEAD"], ["rev-parse", "HEAD"], ["for-each-ref"], ["fsck"], ["import", "--verify"],
    ["import", history.repo, history.native],
  ]) {
    const result = cst(history.native, args);
    assert.notEqual(result.status, 0, args.join(" "));
    assert.match(result.stderr.toString(), refusal, args.join(" "));
  }
  // The refusal is the format's, not damage: the store was otherwise whole.
  setVersion(history.native, 1);
  const checked = cst(history.native, ["fsck"]);
  assert.equal(checked.status, 0, checked.stderr.toString());
});

test("a damaged copy is reported, though another container holds a good copy that reads use", () => {
  const history = makeHistory("sha1");
  const { id, bytes } = blobOf(history);
  const [original] = containers(history.native);
  const copy = addContainer(history.native, [{ type: TYPES.content, body: bytes }], { after: original, damage: true });
  // Reads, and so the reconstruction check, take the first container's copy.
  assert.deepEqual(cst(history.native, ["cat-file", "-p", id]).stdout, bytes);
  const verified = cst(history.native, ["import", "--verify"]);
  assert.equal(verified.status, 0, verified.stderr.toString());
  const checked = cst(history.native, ["fsck"]);
  assert.notEqual(checked.status, 0);
  const report = checked.stderr.toString();
  assert.match(report, /the native store is corrupt: verification found 2 problems/);
  assert.match(report, new RegExp(`${id}, its copy in ${path.basename(copy)}: its bytes do not hash to its ID`));
  assert.match(report, /its trailer is not the SHA-256 of its bytes/);
});

test("content absent by promise or by policy is reported by its state, not as corruption", () => {
  for (const [state, name] of [[1, "promise"], [2, "policy"]]) {
    const history = makeHistory("sha1");
    const { id } = blobOf(history);
    markAbsent(history.native, id, state);
    const checked = cst(history.native, ["fsck"]);
    assert.equal(checked.status, 0, checked.stderr.toString());
    assert.match(checked.stdout.toString(), new RegExp(`^absent by ${name}: ${id}\n`));
    assert.match(checked.stdout.toString(), new RegExp(`${state === 1 ? "1 absent by promise, 0" : "0 absent by promise, 1"} absent by policy\\.\n$`));
    const read = cst(history.native, ["cat-file", "-p", id]);
    assert.notEqual(read.status, 0);
    assert.match(read.stderr.toString(), new RegExp(`${id} is absent by ${name}`));
    assert.doesNotMatch(read.stderr.toString(), /corrupt/);
    // A ref may name it still: every command reads around it.
    assert.equal(cst(history.native, ["rev-parse", "raw-blob"]).stdout.toString(), `${id}\n`);
    const refs = cst(history.native, ["for-each-ref"]);
    assert.equal(refs.status, 0, refs.stderr.toString());
    assert.match(refs.stdout.toString(), new RegExp(`^${id} blob\trefs/tags/raw-blob$`, "m"));
  }
});

/** The native ID of the tree a revision names in the original. */
function treeOf(history, revision) {
  return history.rows.get(execFileSync("git", ["rev-parse", revision], { cwd: history.repo, env: testEnv() }).toString().trim());
}

test("the same content removed and not marked is reported as corruption", () => {
  const history = makeHistory("sha1");
  const { id } = blobOf(history);
  removeEntry(history.native, id);
  const checked = cst(history.native, ["fsck"]);
  assert.notEqual(checked.status, 0);
  const report = checked.stderr.toString();
  assert.match(report, /the native store is corrupt/);
  // The tree names it by its short reference, which no index entry now has.
  assert.match(report, new RegExp(`${treeOf(history, "refs/heads/v1^{tree}")}, its copy in [0-9a-f]{64}\\.cstc: its entry top names ${id.slice(0, 16)}, a short reference no index entry's name begins with`));
  assert.match(report, new RegExp(`the sha1 alias row of ${history.file} names ${id}, which has no index entry`));
});

test("an absent index entry sharing a tree target's short reference changes no read and no verdict", () => {
  const history = makeHistory("sha1");
  const { id } = blobOf(history);
  const shared = sharingShort(id);
  addAbsent(history.native, [shared]);
  // The trees naming the content now have two candidates for it, and keep
  // the one whose rebuilt body verifies.
  for (const args of [["ls-tree", "-r", "-l", "refs/heads/v1"], ["ls-tree", "refs/heads/v1"], ["ls-tree", "-r", "HEAD"], ["cat-file", "-p", "refs/heads/v1^{tree}"]]) {
    same(history, args);
  }
  const checked = cst(history.native, ["fsck"]);
  assert.equal(checked.status, 0, checked.stderr.toString());
  assert.match(checked.stdout.toString(), new RegExp(`^absent by promise: ${shared}\n`));
  const verified = cst(history.native, ["import", "--verify"]);
  assert.equal(verified.status, 0, verified.stderr.toString());
});

test("a tree whose short reference no candidate verifies is corrupt, named by its ID", () => {
  const history = makeHistory("sha1");
  const { id } = blobOf(history);
  const tree = treeOf(history, "refs/heads/v1^{tree}");
  // The content is gone, and the one object left sharing its 8 bytes is not it.
  removeEntry(history.native, id);
  addAbsent(history.native, [sharingShort(id)]);
  const checked = cst(history.native, ["fsck"]);
  assert.notEqual(checked.status, 0);
  // A candidate that does not verify could stand for any entry, so the tree
  // is named; a reference with no candidate names its entry (above).
  assert.match(checked.stderr.toString(), new RegExp(`${tree}, its copy in [0-9a-f]{64}\\.cstc: no choice of its short references' candidates hashes to its ID`));
});

test("metadata is never absent: a tree marked absent is corruption", () => {
  const history = makeHistory("sha1");
  const tree = treeOf(history, "HEAD:dir");
  markAbsent(history.native, tree, 1);
  const checked = cst(history.native, ["fsck"]);
  assert.notEqual(checked.status, 0);
  assert.match(checked.stderr.toString(), new RegExp(`${tree} is metadata, and metadata is never absent`));
});

test("an annotation of an unknown type changes no content ID and no command's answer", () => {
  const history = makeHistory("sha1");
  const { id } = blobOf(history);
  const commands = [
    ["cat-file", "-p", id], ["cat-file", "-t", id], ["cat-file", "-s", id], ["cat-file", "-p", "HEAD:top"],
    ["ls-tree", "-r", "-t", "-l", "HEAD"], ["rev-parse", "HEAD", "HEAD:top", "--all"], ["for-each-ref"], ["import", "--verify"],
  ];
  const before = commands.map((args) => cst(history.native, args));
  const rows = [...aliases(history.native, "sha1")];
  // An annotation whose ID begins as HEAD's does, at the shortest prefix
  // that names HEAD alone: it is no object Git has, so it shares no prefix.
  const head = cst(history.native, ["rev-parse", "HEAD"]).stdout.toString().trim();
  const prefix = [4, 5].map((length) => head.slice(0, length))
    .find((short) => cst(history.native, ["rev-parse", short]).stdout.toString() === `${head}\n`);
  assert.ok(prefix, "a prefix of 4 or 5 digits names HEAD");
  commands.push(["rev-parse", prefix, `${prefix}~1`], ["ls-tree", prefix]);
  before.push(...commands.slice(-2).map((args) => cst(history.native, args)));
  let body;
  for (let pad = 0; ; pad++) {
    body = annotation(Buffer.from(id, "hex"), "example", Buffer.from(String(pad)));
    if (nativeId(TYPES.annotation, body).toString("hex").startsWith(prefix)) break;
  }
  addContainer(history.native, [{ type: TYPES.annotation, body }]);
  commands.forEach((args, at) => {
    const now = cst(history.native, args);
    assert.equal(now.status, before[at].status, args.join(" "));
    assert.deepEqual(now.stdout, before[at].stdout, args.join(" "));
  });
  assert.deepEqual([...aliases(history.native, "sha1")], rows);
  assert.equal(history.rows.get(history.file), id);
  const checked = cst(history.native, ["fsck"]);
  assert.equal(checked.status, 0, checked.stderr.toString());
  assert.match(checked.stdout.toString(), /in 2 containers/);
  // The annotation is an object of the store, by its own ID.
  const own = nativeId(TYPES.annotation, body).toString("hex");
  assert.equal(cst(history.native, ["cat-file", "-t", own]).stdout.toString(), "annotation\n");
});
