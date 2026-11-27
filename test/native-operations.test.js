/**
 * The operation log (#423; ADR-0047 decisions 10 and 12,
 * docs/native-history/operations.md §3 and §4.2): import writes a native
 * repository's first operation, each `cst branch` write adds exactly one,
 * naming its actor and command, and `cst op log` and `cst op show` list and
 * show them. Every read takes the names and the fact log's heads from the
 * current view, the one operation head. Writers take no lock, so two that
 * ran at once leave two heads, which are refused until #424 merges them.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { testEnv } from "../test-support/git-environment.js";
import { cstCommand, cstPrefix } from "../test-support/cst-command.js";
import { TYPES, heldBodies, names } from "../test-support/native-store.js";

const created = [];

after(() => {
  for (const directory of created) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function scratch() {
  const parent = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "causet-native-operations-")));
  created.push(parent);
  return parent;
}

const OPT_IN = { CAUSET_EXPERIMENTAL: "native" };
const ADA = ["--actor", "Ada Lovelace <ada@example.com>", "--kind", "human"];

function cst(cwd, args, env = {}) {
  return spawnSync(cstCommand, [...cstPrefix(), ...args], { cwd, env: testEnv({ ...OPT_IN, ...env }), encoding: "utf8" });
}

/** `cst` with no Git on `PATH`, so any Git process it started would fail. */
function cstWithoutGit(cwd, args) {
  const noGit = fs.mkdtempSync(path.join(scratch(), "no-git-"));
  const env = Object.fromEntries(Object.entries(testEnv(OPT_IN)).filter(([name]) => name.toUpperCase() !== "PATH"));
  env.PATH = noGit;
  return spawnSync(cstCommand, [...cstPrefix(), ...args], { cwd, env, encoding: "utf8" });
}

function ok(answered, what) {
  assert.equal(answered.status, 0, `${what}: ${answered.stderr}${answered.stdout}`);
  return answered.stdout;
}

/**
 * A repository with cst's records on `main`, a second branch `side`, a tag,
 * and a remote-tracking `origin/main` with a symbolic `origin/HEAD`, and its
 * native copy.
 */
function makeHistory() {
  const root = scratch();
  const repo = path.join(root, "source");
  fs.mkdirSync(repo);
  const run = (command, args) => {
    const result = spawnSync(command, args, { cwd: repo, env: testEnv({}), encoding: "utf8" });
    assert.equal(result.status, 0, `${command} ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  };
  const git = (...args) => run("git", args);
  const original = (...args) => run(cstCommand, [...cstPrefix(), ...args]);
  const write = (name, text) => fs.writeFileSync(path.join(repo, name), text);
  git("init", "-q", "-b", "main");
  git("config", "user.name", "C O Mitter");
  git("config", "user.email", "committer@example.com");
  write("a.txt", "base\n");
  git("add", "-A");
  original("commit", "-m", "base", "--authored-by", "A U Thor <author@example.com>");
  original("init");
  write("b.txt", "more\n");
  git("add", "-A");
  original("commit", "-m", "more", "--generated-by", "claude-opus-5-5");
  git("branch", "side", "HEAD~1");
  git("tag", "v1", "HEAD~1");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  ok(cst(root, ["import", "source", "native"]), "import");
  const native = path.join(root, "native");
  const translate = names(native, git("rev-parse", "--show-object-format"));
  const nativeOf = (revision) => translate.get(git("rev-parse", `${revision}^{commit}`));
  return { root, repo, native, git, original, nativeOf };
}

function opLog(native) {
  return JSON.parse(ok(cst(native, ["op", "log", "--json"]), "op log")).operations;
}

function opShow(native, ...args) {
  return JSON.parse(ok(cst(native, ["op", "show", ...args, "--json"]), "op show"));
}

function headFiles(native) {
  return fs.readdirSync(path.join(native, ".cst", "op-heads")).sort();
}

/** A fact-log entry's scope and parents (facts.md §4.1): its first bytes. */
function entryOf(body) {
  let at = 1;
  const varint = () => {
    let value = 0;
    for (let shift = 0; ; shift += 7) {
      const byte = body[at++];
      value += (byte & 0x7f) * 2 ** shift;
      if (byte < 0x80) return value;
    }
  };
  const parents = [];
  for (let count = varint(); count > 0; count--) {
    parents.push(body.subarray(at + 1, at + 33).toString("hex"));
    at += 33;
  }
  return { scope: body[0] === 1 ? "shared" : "local", parents };
}

test("import writes one operation: no parents, actor or time, the command import, the snapshot's names, and the notes ref's entry as the shared head", () => {
  const history = makeHistory();
  const [listed] = opLog(history.native);
  assert.equal(opLog(history.native).length, 1);
  assert.deepEqual(headFiles(history.native), [listed.id]);
  const operation = opShow(history.native);
  assert.equal(operation.schema, "causet.operation/v1");
  assert.equal(operation.id, listed.id);
  assert.deepEqual(operation.parents, []);
  assert.equal(operation.actor, null);
  assert.equal(operation.time, null);
  assert.deepEqual(operation.command, ["import"]);
  // The names are the snapshot's, as cst branch and cst tag list them.
  const listedNames = [
    ...JSON.parse(ok(cst(history.native, ["branch", "-a", "--json"]), "branch -a")).names,
    ...JSON.parse(ok(cst(history.native, ["tag", "--json"]), "tag")).names,
  ];
  const key = (name) => `${name.kind} ${name.name}`;
  assert.deepEqual(operation.view.names.map(key).sort(), listedNames.map(key).sort());
  assert.deepEqual(operation.view.names.map(key), ["branch main", "branch side", "tag v1", "remote-tracking origin/HEAD", "remote-tracking origin/main"]);
  const main = operation.view.names.find((name) => key(name) === "branch main");
  assert.deepEqual(main.target, { object: history.nativeOf("main"), type: "commit" });
  const originHead = operation.view.names.find((name) => key(name) === "remote-tracking origin/HEAD");
  assert.deepEqual(originHead.target, { kind: "remote-tracking", name: "origin/main" });
  // The shared head is the entry of the notes ref's commit: the one shared
  // entry no other names as a parent.
  const entries = [...heldBodies(history.native, TYPES.factLogEntry)].map(([id, body]) => ({ id, ...entryOf(body) }));
  const shared = entries.filter((entry) => entry.scope === "shared");
  assert.ok(shared.length >= 2, "the history has several notes commits");
  const named = new Set(shared.flatMap((entry) => entry.parents));
  assert.deepEqual(operation.view.shared, shared.filter((entry) => !named.has(entry.id)).map((entry) => entry.id));
  assert.deepEqual(operation.view.local, []);
  const human = ok(cst(history.native, ["op", "log"]), "op log");
  assert.equal(human, `operation ${listed.id} (current)\nCommand: import\n`);
});

test("every branch write adds exactly one operation, and cst op log lists it with its actor and command", () => {
  const history = makeHistory();
  const side = history.nativeOf("side");
  const main = history.nativeOf("main");
  const short = (id) => id.slice(0, 12);
  const steps = [
    {
      args: ["branch", ...ADA, "topic", "side"],
      said: [`Created branch topic at ${short(side)}.`],
      actor: { actor: "Ada Lovelace <ada@example.com>", kind: "human" },
    },
    {
      args: ["branch", "--for", "Ada Lovelace <ada@example.com>", "-f", "topic", "main"],
      env: { CAUSET_AGENT: "claude-opus-5-5" },
      said: [`Moved branch topic from ${short(side)} to ${short(main)}.`],
      actor: { actor: "claude-opus-5-5", kind: "agent", for: "Ada Lovelace <ada@example.com>" },
    },
    {
      args: ["branch", "--actor", "Ada Lovelace <ada@example.com>", "--local", "topic"],
      said: ["Branch topic is local."],
      actor: { actor: "Ada Lovelace <ada@example.com>" },
    },
    {
      args: ["branch", ...ADA, "-d", "topic", "side"],
      said: [`Deleted branch topic (was ${short(main)}).`, `Deleted branch side (was ${short(side)}).`],
      actor: { actor: "Ada Lovelace <ada@example.com>", kind: "human" },
    },
  ];
  let count = 1;
  for (const step of steps) {
    const out = ok(cst(history.native, step.args, step.env), step.args.join(" "));
    const log = opLog(history.native);
    count += 1;
    assert.equal(log.length, count, `${step.args.join(" ")} adds one operation`);
    const [newest, previous] = log;
    assert.deepEqual(newest.actor, step.actor);
    assert.deepEqual(newest.command, step.args);
    assert.deepEqual(newest.parents, [previous.id]);
    assert.match(newest.time, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    assert.deepEqual(headFiles(history.native), [newest.id], "the operation replaces its parent as the head");
    assert.equal(out, `${step.said.join("\n")}\nOperation ${short(newest.id)}.\n`);
  }
  const shown = opShow(history.native);
  assert.deepEqual(shown.view.names.filter((name) => name.kind === "branch").map((name) => name.name), ["main"]);
  // The local mark the third write set is in the view it left.
  const marked = opShow(history.native, opLog(history.native)[1].id.slice(0, 8));
  assert.equal(marked.view.names.find((name) => name.name === "topic").local, true);
  const human = ok(cst(history.native, ["op", "log", "-n", "2"]), "op log -n 2");
  const [first, second] = opLog(history.native);
  assert.match(human, new RegExp(`^operation ${first.id} \\(current\\)\nActor:   Ada Lovelace <ada@example\\.com> \\(human\\)\nDate:    \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d:\\d\\d \\+0000\nCommand: branch --actor 'Ada Lovelace <ada@example\\.com>' --kind human -d topic side\n\noperation ${second.id}\nActor:   Ada Lovelace <ada@example\\.com>\n`));
  // A name given twice is deleted, and said, once.
  ok(cst(history.native, ["branch", ...ADA, "twice", "main"]), "create twice");
  const deleted = ok(cst(history.native, ["branch", ...ADA, "-d", "twice", "twice"]), "delete twice");
  assert.equal(deleted.split("\n").filter((line) => line.startsWith("Deleted branch twice")).length, 1);
  // -n<n>, attached, as Git takes it, beside -<n> and --max-count.
  for (const limit of [["-n1"], ["-1"], ["--max-count=1"], ["-n", "1"]]) {
    assert.equal(JSON.parse(ok(cst(history.native, ["op", "log", ...limit, "--json"]), limit.join(" "))).operations.length, 1);
  }
  assert.equal(ok(cst(history.native, ["fsck"]), "fsck").includes("Verified"), true);
});

test("reads take names from the current view, HEAD following main, with no Git process", () => {
  const history = makeHistory();
  const side = history.nativeOf("side");
  ok(cst(history.native, ["branch", ...ADA, "-f", "main", "side"]), "move main");
  assert.equal(ok(cstWithoutGit(history.native, ["rev-parse", "main", "HEAD"]), "rev-parse"), `${side}\n${side}\n`);
  assert.equal(ok(cstWithoutGit(history.native, ["log", "--format=%H", "main"]), "log").split("\n")[0], side);
  assert.match(ok(cstWithoutGit(history.native, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/"]), "for-each-ref"),
    new RegExp(`^refs/heads/main ${side}\nrefs/heads/side ${side}\n$`));
  assert.equal(ok(cstWithoutGit(history.native, ["branch", "--format=%(refname:short) %(objectname)"]), "branch"), `main ${side}\nside ${side}\n`);
  assert.equal(ok(cstWithoutGit(history.native, ["provenance", "side", "--json"]), "provenance").includes("A U Thor"), true);
  // A branch the view no longer holds resolves to nothing, though the
  // snapshot still holds its ref for the bridge.
  ok(cst(history.native, ["branch", ...ADA, "-d", "side"]), "delete side");
  const gone = cstWithoutGit(history.native, ["rev-parse", "--verify", "-q", "side"]);
  assert.equal(gone.status, 1);
  assert.equal(ok(cstWithoutGit(history.native, ["for-each-ref", "--format=%(refname)", "refs/heads/"]), "for-each-ref"), "refs/heads/main\n");
  ok(cstWithoutGit(history.native, ["fsck"]), "fsck");
});

test("a re-import moves every name back to the original's, and its operation follows the clone's own", () => {
  const history = makeHistory();
  const before = ok(cst(history.native, ["branch", "-a", "--json"]), "branch");
  ok(cst(history.native, ["branch", ...ADA, "-f", "main", "side"]), "move main");
  ok(cst(history.native, ["branch", ...ADA, "extra", "side"]), "create extra");
  ok(cst(history.root, ["import", "source", "native"]), "re-import");
  assert.equal(ok(cst(history.native, ["branch", "-a", "--json"]), "branch"), before);
  const log = opLog(history.native);
  assert.deepEqual(log.map((operation) => operation.command[0]), ["import", "branch", "branch", "import"]);
  assert.deepEqual(log[0].parents, [log[1].id]);
  assert.deepEqual(headFiles(history.native), [log[0].id]);
  // A fresh import of the same original writes the first import's
  // operation again: it has no parents, actor or time.
  ok(cst(history.root, ["import", "source", "again"]), "fresh import");
  assert.deepEqual(opLog(path.join(history.root, "again")).map((operation) => operation.id), [log[3].id]);
});

test("a re-import that writes no local entry keeps the view's local head, and one that changes nothing writes no operation", () => {
  const history = makeHistory();
  // A disputed copy under refs/causet/quarantine/ is a local fact (facts.md
  // §5.3), so the next import writes the local chain's one entry.
  const parked = history.git("hash-object", "-w", "--stdin");
  history.git("update-ref", "refs/causet/quarantine/lineage_b183eccbc21dfd55133700cdcf2a300b222f9fa23f082e29aab07c17d1312934/prov_0e79j2dns3a1b2c3d4e5f", parked);
  ok(cst(history.root, ["import", "source", "native"]), "import the dispute");
  const local = heldBodies(history.native, TYPES.factLogEntry);
  const [entry] = [...local].filter(([, body]) => entryOf(body).scope === "local").map(([id]) => id);
  assert.ok(entry, "the import wrote a local entry");
  assert.deepEqual(opShow(history.native).view.local, [entry]);
  // A new branch on the original, and the local facts unchanged: no local
  // entry, and the view's local head carried into the new operation.
  history.git("branch", "later", "main");
  ok(cst(history.root, ["import", "source", "native"]), "import the branch");
  const operation = opShow(history.native);
  assert.ok(operation.view.names.some((name) => name.name === "later"));
  assert.deepEqual(operation.view.local, [entry]);
  assert.equal(opLog(history.native).length, 3);
  // Nothing new: no operation, and no container.
  const containersBefore = fs.readdirSync(path.join(history.native, ".cst", "objects")).sort();
  ok(cst(history.root, ["import", "source", "native"]), "import nothing new");
  assert.equal(opLog(history.native).length, 3);
  assert.deepEqual(fs.readdirSync(path.join(history.native, ".cst", "objects")).sort(), containersBefore);
});

test("a write is refused before it writes anything, each refusal with a registered code", () => {
  const history = makeHistory();
  const refused = (args, code, pattern, env) => {
    const answered = cst(history.native, args, env);
    assert.equal(answered.status, 1, args.join(" "));
    assert.match(answered.stderr, pattern, args.join(" "));
    // After the options: one after `--` would be a branch name.
    const ended = args.indexOf("--");
    const withJson = ended === -1 ? [...args, "--json"] : [...args.slice(0, ended), "--json", ...args.slice(ended)];
    const enveloped = JSON.parse(cst(history.native, withJson, env).stdout);
    assert.equal(enveloped.code, code, args.join(" "));
  };
  refused(["branch", "topic", "main"], "usage-missing-argument", /no actor was declared/);
  refused(["branch", ...ADA, "main", "side"], "already-exists", /already exists; move it with -f/);
  refused(["branch", ...ADA, "-d", "side", "gone"], "not-found", /No branch named 'gone'/);
  refused(["branch", ...ADA, "--local", "gone"], "not-found", /No branch named 'gone'/);
  refused(["branch", ...ADA, "topic"], "usage-missing-argument", /needs a start point/);
  refused(["branch", ...ADA, "-f", "main"], "usage-missing-argument", /needs a start point/);
  refused(["branch", ...ADA, "-d"], "usage-missing-argument", /takes the branches to delete/);
  refused(["branch", ...ADA, "a", "b", "c"], "usage-conflicting-options", /a branch name and a start point/);
  for (const name of ["-x", "a..b", "a b", "a/", "a.lock", ".a", "HEAD", "a@{b", "a:b"]) {
    refused(["branch", ...ADA, "--", name, "main"], "invalid-identifier", /is not a valid branch name/);
  }
  refused(["branch", ...ADA, "topic", "main^{tree}"], "no-match", /is not a commit/);
  // Git cannot hold both refs/heads/a and refs/heads/a/b.
  refused(["branch", ...ADA, "main/x", "main"], "already-exists", /cannot be created beside the branch 'main'/);
  ok(cst(history.native, ["branch", ...ADA, "dir/leaf", "main"]), "a branch under a directory");
  refused(["branch", ...ADA, "dir", "main"], "already-exists", /cannot be created beside the branch 'dir\/leaf'/);
  ok(cst(history.native, ["branch", ...ADA, "-d", "dir/leaf"]), "delete it again");
  // A name that only begins with another is no directory of it.
  ok(cst(history.native, ["branch", ...ADA, "mainline", "main"]), "a branch beside main");
  ok(cst(history.native, ["branch", ...ADA, "-d", "mainline"]), "delete mainline");
  refused(["branch", ...ADA, "topic", "nothing"], "not-found", /nothing/);
  refused(["branch", "--actor", "Ada", "--for", "Babbage", "topic", "main"], "usage-conflicting-options", /--for names who an agent acts for/);
  refused(["branch", "--actor", "Ada", "--kind", "robot", "topic", "main"], "usage-invalid-option-value", /human or agent/);
  refused(["branch", "--kind", "human", "topic", "main"], "usage-conflicting-options", /CAUSET_AGENT always names an agent/, { CAUSET_AGENT: "claude-opus-5-5" });
  refused(["branch", "--actor", " ", "topic", "main"], "usage-invalid-option-value", /--actor takes a name/);
  refused(["branch", ...ADA, "-r", "-d", "origin/main"], "unsupported-feature", /written by import only/);
  refused(["branch", ...ADA, "-d", "-f", "side"], "usage-conflicting-options", /takes neither -f nor --local/);
  refused(["branch", ...ADA, "-l"], "usage-conflicting-options", /takes no option that writes/);
  refused(["branch", ...ADA, "--format=%(refname)", "topic", "main"], "usage-conflicting-options", /--format formats a listing/);
  refused(["op"], "usage-missing-argument", /takes log or show/);
  refused(["op", "undo"], "usage-unknown-command", /no subcommand 'undo'/);
  refused(["op", "log", "--bogus"], "usage-unknown-option", /Unknown option '--bogus' for 'cst op log'/);
  refused(["op", "log", "-n", "x"], "usage-invalid-option-value", /takes a number/);
  refused(["op", "show", "ab"], "invalid-identifier", /at least 4 of its hex digits/);
  refused(["op", "show", "0000000"], "not-found", /No operation's ID begins with 0000000/);
  assert.equal(opLog(history.native).length, 5, "no refused write added an operation: only the four that ran");
  assert.deepEqual(JSON.parse(ok(cst(history.native, ["branch", "--json"]), "branch")).names.map((name) => name.name), ["main", "side"]);
  const withoutOptIn = spawnSync(cstCommand, [...cstPrefix(), "op", "log"], { cwd: history.native, env: testEnv({}), encoding: "utf8" });
  assert.equal(withoutOptIn.status, 1);
  assert.match(withoutOptIn.stderr, /CAUSET_EXPERIMENTAL=native/);
});

test("two writers that ran at once leave two heads, which are refused until #424 merges them, and both operations are kept", () => {
  const history = makeHistory();
  const heads = path.join(history.native, ".cst", "op-heads");
  const [imported] = headFiles(history.native);
  // The first writer adds its head and removes the import's; the second,
  // which read the import's head as current before the first finished,
  // does the same.
  ok(cst(history.native, ["branch", ...ADA, "one", "main"]), "first writer");
  const [first] = headFiles(history.native);
  fs.rmSync(path.join(heads, first));
  fs.writeFileSync(path.join(heads, imported), "");
  ok(cst(history.native, ["branch", ...ADA, "two", "side"]), "second writer");
  fs.writeFileSync(path.join(heads, first), "");
  assert.equal(headFiles(history.native).length, 2);
  for (const args of [["branch"], ["op", "log"], ["log", "main"], ["branch", ...ADA, "three", "main"]]) {
    const answered = cst(history.native, args);
    assert.equal(answered.status, 1, args.join(" "));
    assert.match(answered.stderr, /has 2 operation heads, .* merging them is not implemented yet \(#424\)\. Both operations are kept\./, args.join(" "));
    assert.equal(JSON.parse(cst(history.native, [...args, "--json"]).stdout).code, "unsupported-feature");
  }
  assert.equal(headFiles(history.native).length, 2, "the refused write added no head");
  ok(cst(history.native, ["fsck"]), "fsck");
});

test("a head left by a writer that stopped before removing its parent's is not current", () => {
  const history = makeHistory();
  const [imported] = headFiles(history.native);
  ok(cst(history.native, ["branch", ...ADA, "one", "main"]), "write");
  fs.writeFileSync(path.join(history.native, ".cst", "op-heads", imported), "");
  assert.equal(headFiles(history.native).length, 2);
  assert.deepEqual(JSON.parse(ok(cst(history.native, ["branch", "--json"]), "branch")).names.map((name) => name.name), ["main", "one", "side"]);
});

test("a store with no operation heads, as an earlier build imported, is refused with the way forward", () => {
  const history = makeHistory();
  fs.rmSync(path.join(history.native, ".cst", "op-heads"), { recursive: true });
  for (const [cwd, args] of [[history.native, ["branch"]], [history.native, ["op", "log"]], [history.root, ["import", "source", "native"]]]) {
    const answered = cst(cwd, args);
    assert.equal(answered.status, 1, args.join(" "));
    assert.match(answered.stderr, /before native repositories kept an operation log.*Import the Git repository again into a new directory/s, args.join(" "));
  }
  assert.equal(JSON.parse(cst(history.native, ["branch", "--json"]).stdout).code, "precondition-not-met");
});
