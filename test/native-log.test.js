/**
 * Native history's `log` and `show` (#416, #417; ADR-0047 decisions 1, 2,
 * 4, 12 and 13): import derives a native commit for every commit a branch, a
 * tag or a remote-tracking ref reaches, and a native tag for every annotated
 * tag one reaches, and none for a carrier commit. On the native copy, `cst
 * log --format=…` and `cst show -s --format=…` print what Git prints on the
 * original, byte for byte once Git's IDs are translated to native ones
 * (ADR-0046, decision 2), every placeholder and option they implement,
 * without running Git. Without `--format` they print cst's own human output,
 * and with `--json` the `causet.log/v1` and `causet.show/v1` documents.
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { testEnv } from "../test-support/git-environment.js";
import { cstCommand, cstPrefix } from "../test-support/cst-command.js";
import { TYPES, addContainer, aliases, names, nativeCommits, nativeTags, removeEntry } from "../test-support/native-store.js";

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
  // A tag of a tag, and one of a tree.
  git(["tag", "-a", "-m", "the chain\n\nwith a body", "chain", "v1"]);
  git(["tag", "-a", "-m", "a tree", "tree-tag", `${two}^{tree}`]);
  git(["symbolic-ref", "HEAD", "refs/heads/main"]);
  git(["notes", "--ref=causet", "add", "-m", "a record", one]);
  const imported = cst(root, ["import", "source", "native"]);
  assert.equal(imported.status, 0, imported.stderr.toString());
  const native = path.join(root, "native");
  return { repo, native, format, git, one, two, side, latin1, merge };
}

/**
 * A history of the commits Git reads that no Git writes, one after another
 * on `main`: odd identities, dates that overflow or reach past the year
 * 3000, a commit with no message and one with no final line feed, messages
 * in ISO-8859-1 and in bytes no encoding gives, and trailers. `ascii` is the
 * commit before the first whose text is not ASCII.
 */
function makeOddHistory(format) {
  const root = scratch();
  const repo = path.join(root, "source");
  fs.mkdirSync(repo);
  const git = (args, input) => execFileSync("git", args, { cwd: repo, env: testEnv({}), input }).toString().trim();
  git(["init", "-q", "-b", "main", `--object-format=${format}`]);
  const tree = git(["mktree"], `100644 blob ${git(["hash-object", "-w", "--stdin"], "x")}\tf\n`);
  let parent = null;
  const commit = (headers, message) => {
    const lines = [`tree ${tree}`, ...(parent ? [`parent ${parent}`] : []), ...headers];
    const tail = message === null ? Buffer.alloc(0) : Buffer.concat([Buffer.from("\n"), Buffer.from(message, "latin1")]);
    parent = git(["hash-object", "-t", "commit", "-w", "--literally", "--stdin"], Buffer.concat([Buffer.from(`${lines.join("\n")}\n`, "latin1"), tail]));
    return parent;
  };
  const who = (name, when) => `${name} <${name.toLowerCase().replace(/ /g, ".")}@example.com> ${when}`;
  const plain = [`author ${who("A U Thor", "1112911993 -0700")}`, `committer ${who("C O Mitter", "1112912053 +0530")}`];
  commit(plain, "Fix the frobnicator: handle  odd...cases!\nsecond line\n\nBody paragraph that is long enough to wrap around a narrow width, with several words in it.\n\nChange-Id: ch_0abc\nSigned-off-by: A U Thor <a@example.com>\nReviewed-by: Someone\n  continued here\n");
  commit([`author ${who("Zed", "1700000000 +0000")}`, `committer ${who("Zed", "1700000000 -0001")}`], "tiny\n");
  commit(["author <noname@example.com> 1112911993 +0000", `committer ${who("C", "1112912053 +1234")}`], "no name\n\nbody\n");
  commit(["author Bad Identity", "committer No Date <nd@example.com>"], "bad identity\n");
  commit([`author ${who("Over", "99999999999999999999 +0000")}`, plain[1]], "overflow\n");
  commit([`author ${who("Future", "40000000000 +0100")}`, plain[1]], "far future\n");
  commit(plain, null);
  commit(plain, "\n\n  leading blanks\n\n\n# comment\nTrailer-Only: yes\n");
  commit(plain, "subject\n\nprose\nKey: v\nOther: w\n");
  commit(plain, "unterminated subject");
  const ascii = parent;
  commit(["author Ren\u00e9 <rene@example.com> 1112911993 +0100", plain[1], "encoding ISO-8859-1"], "Caf\u00e9 cr\u00e8me\n\nKey: v\n");
  commit(plain, "s\n\nnot utf8 \xff\xfe here and more words to wrap\n\nKey: \xff\n");
  git(["update-ref", "refs/heads/main", parent]);
  git(["update-ref", "refs/heads/ascii", ascii]);
  git(["symbolic-ref", "HEAD", "refs/heads/main"]);
  const imported = cst(root, ["import", "source", "native"]);
  assert.equal(imported.status, 0, imported.stderr.toString());
  return { repo, native: path.join(root, "native"), format, git };
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

function same(history, translate, args, command = "log") {
  const expected = spawnSync("git", [command, ...args], { cwd: history.repo, env: testEnv({}), encoding: "buffer" });
  assert.equal(expected.status, 0, expected.stderr.toString());
  const answered = cstWithoutGit(history.native, [command, ...args]);
  assert.equal(answered.status, 0, `cst ${command} ${args.join(" ")}: ${answered.stderr}`);
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

test("cst log and cst show refuse what they do not implement with a registered code, and need the opt-in", () => {
  const history = makeHistory("sha1");
  const refused = (args, code, pattern, command = "log") => {
    const answered = cst(history.native, [command, ...args]);
    assert.equal(answered.status, 1, args.join(" "));
    assert.match(answered.stderr.toString(), pattern, args.join(" "));
    // The same refusal under --json is the failure envelope, its code
    // registered (docs/schemas/errors.md).
    const enveloped = cst(history.native, [command, "--json", ...args]);
    if (!args.includes("--json") && !args.some((arg) => arg.startsWith("--format"))) {
      assert.equal(JSON.parse(enveloped.stdout.toString()).code, code, args.join(" "));
    }
  };
  for (const placeholder of ["%G?", "%GS", "%d", "%D", "%S", "%N", "%gd", "%aN", "%cE", "%ah", "%(describe)", "%(decorate)", "%C(always,red)"]) {
    refused(["main", `--format=${placeholder}`], "unsupported-feature", /is not implemented in a native repository yet/);
  }
  refused(["main", "--format=oneline"], "unsupported-feature", /named formats/);
  refused(["main", "--oneline"], "unsupported-feature", /named formats/);
  refused(["main", "--pretty"], "unsupported-feature", /named formats/);
  refused(["main", "--stat"], "unsupported-feature", /--stat, which prints a patch/);
  refused(["main", "--graph"], "usage-unknown-option", /--graph/);
  refused(["main", "--date=local"], "unsupported-feature", /--date=local/);
  refused(["main", "--date=human"], "unsupported-feature", /--date=human/);
  refused(["main", "-n", "x"], "usage-invalid-option-value", /takes a count/);
  refused(["main...side"], "unsupported-feature", /symmetric difference/);
  refused(["--", "f"], "unsupported-feature", /paths/);
  refused(["nothing"], "not-found", /nothing/);
  const conflicting = JSON.parse(cst(history.native, ["log", "main", "--json", "--format=%H"]).stdout.toString());
  assert.equal(conflicting.code, "usage-conflicting-options");
  assert.match(conflicting.message, /--json or --format/);
  refused(["--format=%H", "main"], "unsupported-feature", /without -s/, "show");
  refused(["-p", "main"], "unsupported-feature", /-p, which prints a patch/, "show");
  refused(["-s", "--format=%H", "tree-tag"], "unsupported-feature", /a tree/, "show");
  refused(["-s", "--format=%H", "main:f"], "unsupported-feature", /a blob/, "show");
  const withoutOptIn = cst(history.native, ["log", "main", "--format=%H"], {});
  assert.equal(withoutOptIn.status, 1);
  assert.match(withoutOptIn.stderr.toString(), /CAUSET_EXPERIMENTAL=native/);
});

/** Every `--format` template the odd history is printed with. */
const TEMPLATES = [
  "[%H][%h][%T][%t][%P][%p]",
  "[%an][%ae][%al][%ad][%aD][%ar][%at][%ai][%aI][%as]",
  "[%cn][%ce][%cl][%cd][%cD][%cr][%ct][%ci][%cI][%cs]",
  "[%s][%f][%e]",
  "[%b]",
  "%m %x41%x0a%x7%xZZ %q %y %% %",
  "%Cred%h%Creset %C(yellow)%s%C(reset) %C(auto)%an %Cblue%Cgreen%Cfoo",
  "format:%h%n%s",
  "tformat:%h",
  "",
  "format:",
  "%-b|%+b|% b|%+s|%-s|% s",
  "%n%-b%n",
  "a%+q b%-q c% q",
  "%(trailers)",
  "%(trailers:only)",
  "%(trailers:only=no)",
  "%(trailers:unfold)",
  "%(trailers:key=Change-Id)",
  "%(trailers:key=change-id:,valueonly)",
  "%(trailers:key=Signed-off-by,keyonly)",
  "%(trailers:separator=%x2C )",
  "%(trailers:only,separator=|,key_value_separator==)",
  "%(trailers:valueonly,separator=%n)",
  "%(trailers:only=1k,unfold=0)",
  "%(trailers:bogus)",
  "%(trailersX)",
  "%(trailers:key)",
  "%x00%s%x00",
];

/** Templates that pad or wrap, printed for commits whose text is ASCII or not UTF-8. */
const LAID_OUT = [
  "[%<(12)%an][%>(12)%an][%><(12)%an][%<(4,trunc)%s][%<(8,ltrunc)%s][%<(9,mtrunc)%s]",
  "[%<|(30)%h][%>|(40)%s][%>>(20)%an]",
  "  [%>>(25)%an]",
  "[%<(5)%C(red)%h%Creset]",
  "[%<(5,junk)%h][%<(0)x][%<(-3)y][%<(abc)z][%<()w]",
  "%w(20,2,4)%s%n%b%w(0)tail",
  "%w(10,3)%an %ae",
  "%+w(5)x",
  "%w(x)y %w(5",
  "%<(10)%x00x",
];

// Each format states itself, so the test does not follow `GIT_DEFAULT_HASH`
// (#462).
for (const format of ["sha1", "sha256"]) {
  test(`every placeholder prints what Git prints, on commits Git reads that no Git writes, without Git (${format})`, () => {
    const history = makeOddHistory(format);
    const translate = translator(history);
    // Git's `%B` of a commit with no message reads past the end of its buffer
    // and prints what follows it, so it is printed for the other commits.
    for (const template of TEMPLATES) same(history, translate, ["main", `--format=${template}`]);
    same(history, translate, ["main~3..main", "--format=[%B]"]);
    for (const template of LAID_OUT) {
      same(history, translate, ["ascii", `--format=${template}`]);
      same(history, translate, ["main~1..main", `--format=${template}`]);
    }
    for (const mode of ["default", "relative", "short", "iso", "iso8601", "iso-strict", "iso8601-strict", "rfc", "rfc2822", "raw", "unix"]) {
      same(history, translate, ["main", `--date=${mode}`, "--format=[%ad][%cd]"]);
    }
    same(history, translate, ["main", "--date", "short", "--format=%ad"]);
    same(history, translate, ["main", "--relative-date", "--format=%ad"]);
    same(history, translate, ["main", "--pretty=tformat:%h %s"]);
  });
}

test("cst log walks as Git walks: ranges, exclusions, counts, skips, reversal, first parents and merges", () => {
  const history = makeHistory("sha1");
  const translate = translator(history);
  const cases = [
    ["main", "side"], ["side", "main"], ["main", "^side"], ["^side", "main"], ["side..main"], ["main..side"],
    ["origin/main..main"], ["..main"], ["main.."], ["v1..main"], ["main", "^v1", "side"],
    ["-2", "main"], ["-n", "3", "main"], ["-n2", "main"], ["--max-count=1", "main"], ["--max-count", "0", "main"],
    ["--skip=2", "main"], ["--skip", "1", "-n", "2", "main"], ["--reverse", "main"], ["--reverse", "-n", "2", "--skip=1", "main"],
    ["--first-parent", "main"], ["--first-parent", "side..main"], ["--merges", "main"], ["--no-merges", "main"],
    ["--merges", "--no-merges", "main"], ["-s", "main"], ["--no-patch", "main"],
    // A negative count is no limit, as Git's `atoi` reads it.
    ["-n", "-1", "main"], ["--max-count=-3", "main"], ["-n-2", "main"],
  ];
  for (const args of cases) same(history, translate, [...args, "--format=%H %s"]);
  same(history, translate, ["--reverse", "main", "--format=format:%h"]);
});

test("cst show -s --format prints commits and annotated tags as Git shows them", () => {
  for (const format of ["sha1", "sha256"]) {
    const history = makeHistory(format);
    const translate = translator(history);
    for (const args of [
      // Git shows a commit once, though a tag and a name both reach it.
      ["main"], ["v1"], ["chain"], ["v1", "main"], ["main", "v1"], ["chain", "side", "v1"], ["HEAD~1"], [],
      ["main", "main"], ["v1", history.git(["rev-parse", "v1^{}"]), "chain"],
    ]) {
      for (const template of [`--format=${EVERY}`, "--format=format:%h %s", "--format=%h"]) {
        same(history, translate, ["-s", template, ...args], "show");
      }
    }
    same(history, translate, ["--no-patch", "--date=iso", "--format=%ad", "v1"], "show");
  }
});

test("a store imported before native tags gets them from a later import, and show refuses a tag without one", () => {
  const history = makeHistory("sha1");
  for (const id of nativeTags(history.native).keys()) removeEntry(history.native, id);
  assert.equal(nativeTags(history.native).size, 0);
  // By its Git ID: the current view names v1's native tag (#423), which is
  // gone, while the Git ID names the preserved tag that has none.
  const refused = cst(history.native, ["show", "-s", "--format=%H", history.git(["rev-parse", "v1"])]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr.toString(), /holds no native tag for.*Import the Git repository into it again/);
  const again = cst(path.dirname(history.native), ["import", "source", "native"]);
  assert.equal(again.status, 0, again.stderr.toString());
  assert.equal(nativeTags(history.native).size, 3);
  same(history, translator(history), ["-s", `--format=${EVERY}`, "chain", "v1"], "show");
  const checked = cst(history.native, ["fsck"]);
  assert.equal(checked.status, 0, checked.stderr.toString());
});

test("fsck finds a native tag that is not what its preserved tag derives", () => {
  const history = makeHistory("sha1");
  const [[, tag]] = [...nativeTags(history.native)].filter(([, found]) => found.name.toString() === "v1");
  // The same tag with another message: a body import would not derive.
  const body = Buffer.concat([tag.body.subarray(0, tag.body.length - tag.message.length), Buffer.from("not v1\n")]);
  addContainer(history.native, [{ type: TYPES.nativeTag, body }]);
  const found = cst(history.native, ["fsck"]);
  assert.equal(found.status, 1);
  assert.match(found.stderr.toString(), /the native tag [0-9a-f]{64}: it is not what import derives from its preserved tag/);
});

test("cst log and cst show print cst's own human output and their JSON documents", () => {
  const history = makeHistory("sha1");
  const full = names(history.native, "sha1");
  const id = (git) => full.get(git);
  const human = cst(history.native, ["log", "-n", "1", "main"]);
  assert.equal(human.status, 0, human.stderr.toString());
  const text = human.stdout.toString();
  assert.match(text, new RegExp(`^commit ${id(history.merge)}\nMerge:   [0-9a-f]{7,} [0-9a-f]{7,}\nAuthor:  A U Thor <author@example.com>\nDate:    `));
  assert.match(text, /\nCommit:  C O Mitter <committer@example.com>, /);
  assert.match(text, /\nActors:  authored by A U Thor <author@example.com>\n\n    merge\n$/);
  const latin1 = cst(history.native, ["show", history.git(["rev-parse", history.latin1])]).stdout.toString();
  assert.match(latin1, /Author:  René Author <rene@example.com>/);
  assert.match(latin1, /Change:  ch_0latin\n/);
  assert.match(latin1, /\n    Café\n/);
  const tagged = cst(history.native, ["show", "chain"]).stdout.toString();
  assert.match(tagged, /^tag chain [0-9a-f]{64}\nTagger:  /);
  assert.match(tagged, /\n    the chain\n\n    with a body\n\ntag v1 /);
  assert.match(tagged, new RegExp(`\n\ncommit ${id(history.two)}\n`));

  const logged = JSON.parse(cst(history.native, ["log", "--json", "-n", "2", "--date=iso", "main"]).stdout.toString());
  assert.equal(logged.schema, "causet.log/v1");
  assert.deepEqual(logged.commits.map((commit) => commit.id), [id(history.merge), id(history.side)]);
  const [merge] = logged.commits;
  assert.deepEqual(merge.parents, [id(history.latin1), id(history.side)]);
  assert.deepEqual(merge.author, {
    line: "A U Thor <author@example.com> 1112940000 -0700", name: "A U Thor", email: "author@example.com", date: "2005-04-07T23:00:00-07:00",
  });
  assert.deepEqual(merge.actors, [{ role: "authored", actor: "A U Thor <author@example.com>" }]);
  assert.equal(merge.message, "merge\n");
  assert.equal(merge.messageHex, undefined);
  const latinJson = JSON.parse(cst(history.native, ["log", "--json", "-n", "1", history.git(["rev-parse", history.latin1])]).stdout.toString()).commits[0];
  assert.equal(latinJson.encoding, "ISO-8859-1");
  assert.equal(latinJson.changeId, "ch_0latin");
  assert.equal(latinJson.message, "Café\n\nChange-Id: ch_0latin\n");
  assert.equal(latinJson.messageHex, Buffer.from("Caf\xe9\n\nChange-Id: ch_0latin\n", "latin1").toString("hex"));
  assert.equal(latinJson.author.name, "René Author");
  assert.equal(latinJson.author.lineHex, Buffer.from("Ren\xe9 Author <rene@example.com> 1112930000 +0100", "latin1").toString("hex"));

  const shown = JSON.parse(cst(history.native, ["show", "--json", "chain"]).stdout.toString());
  assert.equal(shown.schema, "causet.show/v1");
  assert.deepEqual(shown.objects.map((object) => [object.type, object.name ?? object.id]), [
    ["tag", "chain"], ["tag", "v1"], ["commit", id(history.two)],
  ]);
  assert.equal(shown.objects[0].target, shown.objects[1].id);
  assert.equal(shown.objects[0].targetType, "tag");
  assert.equal(shown.objects[1].targetType, "commit");
  assert.equal(shown.objects[0].message, "the chain\n\nwith a body\n");
  assert.equal(shown.objects[0].tagger.name, "C O Mitter");
});
