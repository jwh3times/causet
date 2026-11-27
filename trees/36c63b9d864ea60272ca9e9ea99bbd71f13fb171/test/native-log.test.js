/**
 * Native history's tracer bullet (#416, ADR-0047 decisions 1, 2, 4 and 13):
 * import derives a native commit for every commit a branch, a tag or a
 * remote-tracking ref reaches, and none for a carrier commit, and `cst log
 * <rev> --format=…` on the native copy prints what `git log` prints on the
 * original, byte for byte once Git's IDs are translated to native ones
 * (ADR-0046, decision 2), without running Git.
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { testEnv } from "../test-support/git-environment.js";
import { cstCommand, cstPrefix } from "../test-support/cst-command.js";
import { TYPES, addContainer, aliases, names, nativeCommits } from "../test-support/native-store.js";

const created = [];

after(() => {
  for (const directory of created) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function scratch() {
  const parent = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "causet-native-log-")));
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

/** Every placeholder #416 implements, and the ones it adds for free. */
const EVERY = "tformat:[%H][%h][%T][%t][%P][%p][%an][%ae][%ad][%cn][%ce][%cd][%s]%n[%b]%%";

/**
 * A history whose commit dates are out of step with its shape, so the order
 * `log` prints in is Git's date order, not the walk's: a merge, a side
 * branch, an annotated tag, a remote-tracking ref, a commit in ISO-8859-1,
 * trailers, and a notes commit, which carries records and is no point in
 * history.
 */
function makeHistory(format) {
  const root = scratch();
  const repo = path.join(root, "source");
  fs.mkdirSync(repo);
  const at = (author, committer = author) => ({
    GIT_AUTHOR_NAME: "A U Thor", GIT_AUTHOR_EMAIL: "author@example.com", GIT_AUTHOR_DATE: `${author} -0700`,
    GIT_COMMITTER_NAME: "C O Mitter", GIT_COMMITTER_EMAIL: "committer@example.com", GIT_COMMITTER_DATE: `${committer} +0200`,
  });
  const run = (args, input, env = at(1112911993)) => execFileSync("git", args, { cwd: repo, env: testEnv(env), input });
  const git = (args, input, env) => run(args, input, env).toString().trim();
  git(["init", "-q", "-b", "main", `--object-format=${format}`]);
  const blob = (text) => git(["hash-object", "-w", "--stdin"], text);
  const tree = (name, text) => git(["mktree"], `100644 blob ${blob(text)}\t${name}\n`);
  const commit = (when, message, ...parents) => git(
    ["commit-tree", tree("f", message), "-F", "-", ...parents.flatMap((parent) => ["-p", parent])],
    message,
    at(when, when + 30),
  );
  const one = commit(1112900000, "one\n\nChange-Id: ch_0one\nDerived-From: ch_0zero\nOrigin-Commit: abc123\n");
  const side = commit(1112950000, "  side  \nwraps\n\n\n\nits body\n\nsecond paragraph\n", one);
  const two = commit(1112920000, "two\n", one);
  // A commit in ISO-8859-1, with no `-F`: its bytes are exactly these.
  const treeId = tree("f", "latin1");
  const latin1 = git(["hash-object", "-t", "commit", "-w", "--stdin"], Buffer.concat([
    Buffer.from(`tree ${treeId}\nparent ${two}\nauthor Ren`), Buffer.from([0xe9]),
    Buffer.from(" Author <rene@example.com> 1112930000 +0100\ncommitter C O Mitter <committer@example.com> 1112930000 +0100\nencoding ISO-8859-1\n\nCaf"),
    Buffer.from([0xe9]), Buffer.from("\n\nChange-Id: ch_0latin\n"),
  ]));
  const merge = commit(1112940000, "merge\n", latin1, side);
  git(["update-ref", "refs/heads/main", merge]);
  git(["update-ref", "refs/heads/side", side]);
  git(["update-ref", "refs/remotes/origin/main", two]);
  git(["tag", "-a", "-m", "v1", "v1", two]);
  git(["symbolic-ref", "HEAD", "refs/heads/main"]);
  git(["notes", "--ref=causet", "add", "-m", "a record", one]);
  const imported = cst(root, ["import", "source", "native"]);
  assert.equal(imported.status, 0, imported.stderr.toString());
  const native = path.join(root, "native");
  return { repo, native, format, git, one, two, side, latin1, merge };
}

/**
 * Git's IDs in `log` output, as the native copy prints them: a commit as its
 * native commit (commits.md §6), anything else as its alias row's object,
 * and each abbreviated to 7 digits as Git abbreviates in a history this
 * small.
 */
function translator(history) {
  const full = names(history.native, history.format);
  const short = new Map([...full].map(([git, native]) => [git.slice(0, 7), native.slice(0, 7)]));
  const width = history.format === "sha1" ? 40 : 64;
  return (text) => text
    .replace(new RegExp(`\\b[0-9a-f]{${width}}\\b`, "g"), (id) => full.get(id) ?? id)
    .replace(/\b[0-9a-f]{7}\b/g, (id) => short.get(id) ?? id);
}

function same(history, translate, args) {
  const expected = spawnSync("git", ["log", ...args], { cwd: history.repo, env: testEnv({}), encoding: "buffer" });
  assert.equal(expected.status, 0, expected.stderr.toString());
  const answered = cstWithoutGit(history.native, ["log", ...args]);
  assert.equal(answered.status, 0, `cst log ${args.join(" ")}: ${answered.stderr}`);
  assert.equal(answered.stdout.toString("latin1"), translate(expected.stdout.toString("latin1")), args.join(" "));
}

for (const format of ["sha1", "sha256"]) {
  test(`cst log prints what git log prints, in Git's order, IDs translated, without Git (${format})`, () => {
    const history = makeHistory(format);
    const translate = translator(history);
    for (const rev of ["main", "side", "v1", "origin/main", "HEAD", "refs/heads/main"]) {
      same(history, translate, [rev, `--format=${EVERY}`]);
    }
    same(history, translate, ["main", "--format=format:%H %s"]);
    same(history, translate, ["main", "--format=%h|%p|%t"]);
    same(history, translate, ["--format=%H"]);
    // An empty `tformat:` prints nothing; an empty `format:` still separates.
    same(history, translate, ["main", "--format=tformat:"]);
    same(history, translate, ["main", "--format=format:"]);
  });

  test(`a commit a name reaches only after a later import gets its native commit then (${format})`, () => {
    const history = makeHistory(format);
    // The notes' carrier commit has none; a branch to it, and a commit on top
    // of it, make it a point in history (commits.md §5.1).
    const notes = history.git(["rev-parse", "refs/notes/causet"]);
    history.git(["branch", "fromnotes", notes]);
    const tree = history.git(["rev-parse", `${notes}^{tree}`]);
    const carried = history.git(["commit-tree", tree, "-p", notes, "-m", "on the notes"]);
    history.git(["update-ref", "refs/heads/carried", carried]);
    const again = cst(path.dirname(history.native), ["import", "source", "native"]);
    assert.equal(again.status, 0, again.stderr.toString());
    const translate = translator(history);
    for (const rev of ["fromnotes", "carried", "main"]) {
      same(history, translate, [rev, `--format=${EVERY}`]);
    }
    const checked = cst(history.native, ["fsck"]);
    assert.equal(checked.status, 0, checked.stderr.toString());
  });

  test(`fsck finds a native commit that does not decode, or is not what its preserved commit derives (${format})`, () => {
    const history = makeHistory(format);
    const checked = cst(history.native, ["fsck"]);
    assert.equal(checked.status, 0, checked.stderr.toString());
    // A native commit of the first commit, which has no parents, made here
    // by commits.md §3.1: its tree and its preserved commit, no signatures,
    // encoding, actors or lifted identity, and a message import would not
    // derive. A native ID is its algorithm tag, 01, and its digest.
    const native = (id) => Buffer.from(`01${id}`, "hex");
    const rows = aliases(history.native, format);
    const tree = names(history.native, format).get(history.git(["rev-parse", `${history.one}^{tree}`]));
    const made = Buffer.concat([
      native(tree), Buffer.from([0x00, 0x02, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01]), native(rows.get(history.one)),
      Buffer.from("a message import would not derive\n"),
    ]);
    addContainer(history.native, [
      { type: TYPES.nativeCommit, body: made },
      { type: TYPES.nativeCommit, body: Buffer.from([0x01]) },
    ]);
    const found = cst(history.native, ["fsck"]);
    assert.equal(found.status, 1);
    const report = found.stderr.toString();
    assert.match(report, /is not what import derives from its preserved commit/);
    assert.match(report, /it ends 32 bytes early/);
  });

  test(`import derives a native commit for each commit a name reaches, and none for a carrier (${format})`, () => {
    const history = makeHistory(format);
    const commits = nativeCommits(history.native);
    const reached = history.git(["rev-list", "--branches", "--tags", "--remotes"]).split("\n").sort();
    const rows = aliases(history.native, format);
    assert.deepEqual([...commits.values()].map((commit) => commit.preserved).sort(), reached.map((id) => rows.get(id)).sort());
    const notes = history.git(["rev-parse", "refs/notes/causet"]);
    assert.ok(rows.has(notes), "the notes commit is imported, as a preserved Git object");
    // What import derived, read from the commits' bodies.
    const byPreserved = new Map([...commits.values()].map((commit) => [commit.preserved, commit]));
    const one = byPreserved.get(rows.get(history.one));
    assert.deepEqual([one.changeId, one.derivedFrom, one.originCommit], ["ch_0one", "ch_0zero", "abc123"]);
    assert.match(one.message.toString(), /Change-Id: ch_0one\nDerived-From: ch_0zero\nOrigin-Commit: abc123\n$/);
    const latin1 = byPreserved.get(rows.get(history.latin1));
    assert.equal(latin1.encoding.toString(), "ISO-8859-1");
    assert.equal(latin1.changeId, "ch_0latin");
    assert.deepEqual(latin1.message, Buffer.from([0x43, 0x61, 0x66, 0xe9, 0x0a, 0x0a, ...Buffer.from("Change-Id: ch_0latin\n")]));
    const merge = byPreserved.get(rows.get(history.merge));
    const nativeOf = (git) => [...commits].find(([, commit]) => commit.preserved === rows.get(git))[0];
    assert.deepEqual(merge.parents, [nativeOf(history.latin1), nativeOf(history.side)]);
  });
}

test("cst log refuses what it does not implement, and needs the opt-in", () => {
  const history = makeHistory("sha1");
  const refused = (args, pattern) => {
    const answered = cst(history.native, ["log", ...args]);
    assert.equal(answered.status, 1, args.join(" "));
    assert.match(answered.stderr.toString(), pattern, args.join(" "));
  };
  refused(["main", "--format=%G?"], /%G\?/);
  refused(["main", "--format=oneline"], /oneline/);
  refused(["main"], /--format/);
  refused(["main", "--stat", "--format=%H"], /--stat/);
  refused(["main", "side", "--format=%H"], /one revision/);
  refused(["--format=%H", "--", "f"], /paths/);
  refused(["nothing", "--format=%H"], /nothing/);
  const withoutOptIn = cst(history.native, ["log", "main", "--format=%H"], {});
  assert.equal(withoutOptIn.status, 1);
  assert.match(withoutOptIn.stderr.toString(), /CAUSET_EXPERIMENTAL=native/);
});
