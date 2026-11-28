/**
 * Native names (#418; ADR-0047 decision 9, docs/native-history/operations.md
 * §2.3 and §4.1): import turns `refs/heads/*` into branches, `refs/tags/*`
 * into tags and `refs/remotes/*` into read-only remote-tracking names, and no
 * other ref, cst's records included, is ever shown as a name. On the native copy,
 * `cst branch` and `cst tag` list them: with `--format`, byte for byte as
 * `git branch --format` and `git tag --format` print the original once Git's
 * IDs are translated to native ones (ADR-0046, decision 2), without running
 * Git; without it, cst's own human output, and with `--json` the
 * `causet.names/v2` document.
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { testEnv } from "../test-support/git-environment.js";
import { cstCommand, cstPrefix } from "../test-support/cst-command.js";
import { names } from "../test-support/native-store.js";

const created = [];

after(() => {
  for (const directory of created) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function scratch() {
  const parent = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "causet-native-names-")));
  created.push(parent);
  return parent;
}

const OPT_IN = { CAUSET_EXPERIMENTAL: "native" };

function cst(cwd, args, env = OPT_IN) {
  return spawnSync(cstCommand, [...cstPrefix(), ...args], { cwd, env: testEnv(env), encoding: "buffer" });
}

/** `cst` with no Git on `PATH`, so any Git process it started would fail. */
function cstWithoutGit(cwd, args) {
  const noGit = fs.mkdtempSync(path.join(scratch(), "no-git-"));
  const env = Object.fromEntries(Object.entries(testEnv(OPT_IN)).filter(([name]) => name.toUpperCase() !== "PATH"));
  env.PATH = noGit;
  return spawnSync(cstCommand, [...cstPrefix(), ...args], { cwd, env, encoding: "buffer" });
}

/**
 * A repository with every kind of ref: branches, one symbolic to a branch,
 * one to a tag and one to nothing; lightweight and annotated tags, a tag of
 * a tag and one of a tree; remote-tracking refs with a symbolic `HEAD`; and
 * the refs that are never names: cst's records under `refs/notes/causet`,
 * `refs/causet/*` and `refs/vcs-lab/*`, another notes ref, `refs/stash` and
 * `refs/replace/*`.
 */
function makeRefs(format) {
  const root = scratch();
  const repo = path.join(root, "source");
  fs.mkdirSync(repo);
  const identity = {
    GIT_AUTHOR_NAME: "A U Thor", GIT_AUTHOR_EMAIL: "author@example.com", GIT_AUTHOR_DATE: "1112911993 -0700",
    GIT_COMMITTER_NAME: "C O Mitter", GIT_COMMITTER_EMAIL: "committer@example.com", GIT_COMMITTER_DATE: "1112912053 +0200",
  };
  const git = (args, input) => execFileSync("git", args, { cwd: repo, env: testEnv(identity), input }).toString().trim();
  git(["init", "-q", "-b", "main", `--object-format=${format}`]);
  const tree = git(["mktree"], `100644 blob ${git(["hash-object", "-w", "--stdin"], "x")}\tf\n`);
  const one = git(["commit-tree", tree, "-m", "one"]);
  const two = git(["commit-tree", tree, "-p", one, "-m", "two"]);
  git(["update-ref", "refs/heads/main", two]);
  git(["update-ref", "refs/heads/side", one]);
  git(["update-ref", "refs/heads/Zed", one]);
  git(["update-ref", "refs/heads/causet/ws/topic", two]);
  git(["symbolic-ref", "refs/heads/alias", "refs/heads/main"]);
  git(["symbolic-ref", "refs/heads/to-tag", "refs/tags/v1"]);
  git(["symbolic-ref", "refs/heads/dangling", "refs/heads/gone"]);
  git(["tag", "v0", one]);
  git(["tag", "-a", "-m", "v1", "v1", two]);
  git(["tag", "-a", "-m", "the chain", "chain", "v1"]);
  git(["tag", "-a", "-m", "a tree", "tree-tag", tree]);
  git(["update-ref", "refs/remotes/origin/main", one]);
  git(["update-ref", "refs/remotes/origin/feature", two]);
  git(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
  git(["symbolic-ref", "HEAD", "refs/heads/main"]);
  git(["notes", "--ref=causet", "add", "-m", "a record", one]);
  git(["notes", "add", "-m", "a plain note", one]);
  const notes = git(["rev-parse", "refs/notes/causet"]);
  git(["update-ref", "refs/causet/retention", notes]);
  git(["update-ref", "refs/causet/quarantine/q1", notes]);
  git(["update-ref", "refs/vcs-lab/retention", notes]);
  git(["update-ref", "refs/stash", two]);
  git(["update-ref", `refs/replace/${one}`, two]);
  const imported = cst(root, ["import", "source", "native"]);
  assert.equal(imported.status, 0, imported.stderr.toString());
  return { repo, native: path.join(root, "native"), format, git, one, two, tree };
}

/** Git's full IDs in a listing, as the native copy names those objects (commits.md §6). */
function translator(history) {
  const full = names(history.native, history.format);
  const width = history.format === "sha1" ? 40 : 64;
  return (text) => text.replace(new RegExp(`\\b[0-9a-f]{${width}}\\b`, "g"), (id) => full.get(id) ?? id);
}

function same(history, translate, command, args) {
  // Git reads through refs/replace/ unless told not to; a native repository
  // never does (commits.md §7.1).
  const expected = spawnSync("git", [command, ...args], {
    cwd: history.repo, env: testEnv({ GIT_NO_REPLACE_OBJECTS: "1" }), encoding: "buffer",
  });
  assert.equal(expected.status, 0, expected.stderr.toString());
  const answered = cstWithoutGit(history.native, [command, ...args]);
  assert.equal(answered.status, 0, `cst ${command} ${args.join(" ")}: ${answered.stderr}`);
  assert.equal(answered.stdout.toString("latin1"), translate(expected.stdout.toString("latin1")), `${command} ${args.join(" ")}`);
}

/** Every field cst for-each-ref has but %(HEAD), which reads what is no name. */
const FIELDS = "[%(refname)][%(refname:short)][%(refname:lstrip=1)][%(refname:rstrip=-2)][%(symref)][%(symref:short)]"
  + "[%(objectname)][%(objecttype)][%(objectsize)][%(tree)][%(parent)][%(numparent)][%(object)]"
  + "[%(*objectname)][%(*objecttype)]%%%0a";

for (const format of ["sha1", "sha256"]) {
  test(`cst branch and cst tag --format list the names as git branch and git tag do, IDs translated, without Git (${format})`, () => {
    const history = makeRefs(format);
    const translate = translator(history);
    for (const listing of [[], ["-r"], ["--remotes"], ["-a"], ["--all"]]) {
      same(history, translate, "branch", [...listing, `--format=${FIELDS}`]);
    }
    same(history, translate, "branch", ["--format", "%(refname:short)"]);
    same(history, translate, "branch", ["--list", "--format=%(refname)", "s*", "Z*"]);
    same(history, translate, "branch", ["-a", "-l", "--format=%(refname)", "*main"]);
    same(history, translate, "branch", ["-a", "--list", "--format=%(refname)", "origin/*"]);
    same(history, translate, "branch", ["-l", "--format=%(refname)", "causet/*"]);
    same(history, translate, "tag", [`--format=${FIELDS}`]);
    same(history, translate, "tag", ["-l", `--format=${FIELDS}`]);
    same(history, translate, "tag", ["--list", "--format=%(refname:short)", "v*"]);
    same(history, translate, "tag", ["-l", "--format=%(refname)", "nothing*"]);
  });
}

test("cst branch and cst tag print cst's own listing: a name a line, a symbolic one with what it names", () => {
  const history = makeRefs("sha1");
  const listed = (command, ...args) => {
    const answered = cstWithoutGit(history.native, [command, ...args]);
    assert.equal(answered.status, 0, answered.stderr.toString());
    return answered.stdout.toString();
  };
  const branches = [
    "Zed",
    "alias -> main",
    "causet/ws/topic",
    // No `dangling`: a symbolic ref to nothing is no ref for-each-ref lists,
    // so the snapshot never holds it (objects.md §6).
    "main",
    "side",
    "to-tag -> tag v1",
  ];
  const remotes = ["origin/HEAD -> origin/main", "origin/feature", "origin/main"];
  const lines = (list) => list.map((line) => `${line}\n`).join("");
  assert.equal(listed("branch"), lines(branches));
  assert.equal(listed("branch", "--list"), lines(branches));
  assert.equal(listed("branch", "-r"), lines(remotes));
  assert.equal(listed("branch", "-a"), lines([...branches, ...remotes.map((line) => `remotes/${line}`)]));
  assert.equal(listed("branch", "-al", "*main"), lines(["main", "remotes/origin/main"]));
  assert.equal(listed("tag"), lines(["chain", "tree-tag", "v0", "v1"]));
  assert.equal(listed("tag", "-l", "v*", "c*"), lines(["chain", "v0", "v1"]));
  assert.equal(listed("tag", "-l", "nothing"), "");
});

test("cst branch --json and cst tag --json print the causet.names/v2 document", () => {
  const history = makeRefs("sha1");
  const native = names(history.native, history.format);
  const id = (gitId) => native.get(gitId);
  const tagged = (tag) => id(history.git(["rev-parse", `refs/tags/${tag}`]));
  const json = (command, ...args) => {
    const answered = cstWithoutGit(history.native, [command, "--json", ...args]);
    assert.equal(answered.status, 0, answered.stderr.toString());
    return JSON.parse(answered.stdout.toString());
  };
  const object = (gitId, type) => ({ object: gitId, type });
  const named = (kind, name, target) => ({ kind, name, local: false, target });
  const remotes = [
    named("remote-tracking", "origin/HEAD", { kind: "remote-tracking", name: "origin/main" }),
    named("remote-tracking", "origin/feature", object(id(history.two), "commit")),
    named("remote-tracking", "origin/main", object(id(history.one), "commit")),
  ];
  const branches = [
    named("branch", "Zed", object(id(history.one), "commit")),
    named("branch", "alias", { kind: "branch", name: "main" }),
    named("branch", "causet/ws/topic", object(id(history.two), "commit")),
    named("branch", "main", object(id(history.two), "commit")),
    named("branch", "side", object(id(history.one), "commit")),
    named("branch", "to-tag", { kind: "tag", name: "v1" }),
  ];
  assert.deepEqual(json("branch"), { schema: "causet.names/v2", names: branches });
  assert.deepEqual(json("branch", "-r"), { schema: "causet.names/v2", names: remotes });
  assert.deepEqual(json("branch", "-a"), { schema: "causet.names/v2", names: [...branches, ...remotes] });
  assert.deepEqual(json("branch", "-l", "s*"), { schema: "causet.names/v2", names: [branches[4]] });
  assert.deepEqual(json("tag"), {
    schema: "causet.names/v2",
    names: [
      named("tag", "chain", object(tagged("chain"), "tag")),
      named("tag", "tree-tag", object(tagged("tree-tag"), "tag")),
      named("tag", "v0", object(id(history.one), "commit")),
      named("tag", "v1", object(tagged("v1"), "tag")),
    ],
  });
});

test("no ref but a branch, a tag or a remote-tracking ref is a name, the snapshot keeps every one, and the reconstruction check passes", () => {
  const history = makeRefs("sha1");
  const lines = (command, ...args) => {
    const answered = cstWithoutGit(history.native, [command, ...args]);
    assert.equal(answered.status, 0, answered.stderr.toString());
    return answered.stdout.toString().trim().split("\n");
  };
  assert.deepEqual([...lines("branch", "-a", "--format=%(refname)"), ...lines("tag", "--format=%(refname)")], [
    "refs/heads/Zed", "refs/heads/alias", "refs/heads/causet/ws/topic", "refs/heads/main", "refs/heads/side",
    "refs/heads/to-tag", "refs/remotes/origin/HEAD", "refs/remotes/origin/feature", "refs/remotes/origin/main",
    "refs/tags/chain", "refs/tags/tree-tag", "refs/tags/v0", "refs/tags/v1",
  ]);
  const snapshot = lines("for-each-ref", "--format=%(refname)");
  for (const kept of ["refs/notes/causet", "refs/notes/commits", "refs/causet/retention", "refs/causet/quarantine/q1",
    "refs/vcs-lab/retention", "refs/stash", `refs/replace/${history.one}`]) {
    assert.ok(snapshot.includes(kept), `the snapshot keeps ${kept}`);
  }
  const verified = cst(history.native, ["import", "--verify"]);
  assert.equal(verified.status, 0, verified.stderr.toString());
});

test("cst branch and cst tag refuse what they do not implement with a registered code, and need the opt-in", () => {
  const history = makeRefs("sha1");
  const refused = (command, args, code, pattern) => {
    const answered = cst(history.native, [command, ...args]);
    assert.equal(answered.status, 1, `${command} ${args.join(" ")}`);
    assert.match(answered.stderr.toString(), pattern, `${command} ${args.join(" ")}`);
    // The same refusal under --json is the failure envelope, its code
    // registered (docs/schemas/errors.md).
    if (!args.some((arg) => arg.startsWith("--format"))) {
      const enveloped = JSON.parse(cst(history.native, [command, "--json", ...args]).stdout.toString());
      assert.equal(enveloped.code, code, `${command} --json ${args.join(" ")}`);
    }
  };
  const unimplemented = /is not implemented in a native repository yet/;
  // Writes are #423's (test/native-operations.test.js): without a start
  // point or an actor they are refused before anything is written.
  refused("branch", ["new"], "usage-missing-argument", /needs a start point/);
  refused("branch", ["new", "main"], "usage-missing-argument", /no actor was declared/);
  refused("branch", ["-d", "side"], "usage-missing-argument", /no actor was declared/);
  refused("branch", ["-f", "main"], "usage-missing-argument", /needs a start point/);
  for (const args of [["-m", "side", "other"], ["-v"], ["-vv"],
    ["--sort=refname"], ["--contains", "main"], ["--merged"], ["--points-at", "main"], ["--column"], ["-i"]]) {
    refused("branch", args, "unsupported-feature", unimplemented);
  }
  // Flags given together are each judged as alone.
  refused("branch", ["-lv"], "unsupported-feature", unimplemented);
  refused("branch", ["-rd", "x"], "unsupported-feature", /written by import only/);
  refused("branch", ["-r", "origin/main"], "usage-conflicting-options", /take no branch name/);
  refused("branch", ["--format=%(subject)"], "unsupported-feature", /%\(subject\) of cst branch/);
  refused("branch", ["--bogus"], "usage-unknown-option", /Unknown option '--bogus' for 'cst branch'/);
  refused("branch", ["-lz"], "usage-unknown-option", /Unknown option '-lz'/);
  refused("branch", ["--format=%(HEAD) %(refname)"], "unsupported-feature", /%\(HEAD\) of cst branch/);
  refused("branch", ["--format"], "usage-missing-argument", /requires a value/);
  refused("tag", ["v2"], "unsupported-feature", /Creating a tag/);
  for (const args of [["-a", "-m", "x", "v2"], ["-d", "v1"], ["-n"], ["-n3"], ["-s", "v2"], ["--sort=-refname"],
    ["--contains", "main"], ["-v", "v1"]]) {
    refused("tag", args, "unsupported-feature", unimplemented);
  }
  refused("tag", ["-r"], "usage-unknown-option", /Unknown option '-r' for 'cst tag'/);
  refused("tag", ["--format=%(HEAD)"], "unsupported-feature", /%\(HEAD\) of cst tag/);
  for (const command of ["branch", "tag"]) {
    const conflicting = JSON.parse(cst(history.native, [command, "--json", "--format=%(refname)"]).stdout.toString());
    assert.equal(conflicting.code, "usage-conflicting-options");
    assert.match(conflicting.message, /--json or --format/);
    const withoutOptIn = cst(history.native, [command], {});
    assert.equal(withoutOptIn.status, 1);
    assert.match(withoutOptIn.stderr.toString(), /CAUSET_EXPERIMENTAL=native/);
  }
});
