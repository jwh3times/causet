import assert from "node:assert/strict";
import { execFileSync, spawnSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { testEnv } from "../test-support/git-environment.js";
import { cstCommand, cstPrefix } from "../test-support/cst-command.js";

// Until #243 the writer cases below called src/notes.js and src/resolutions.js
// directly. They now reach the Rust writer through the CLI: `cst commit
// --authored-by` appends provenance to a commit a post-commit hook has already
// given a notes tree of the shape under test, and a conflicted `cst reconcile`
// publishes a resolution.
const RETENTION = "refs/causet/retention";
const NOTES = "refs/notes/causet";
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: testEnv(), stdio: ["pipe", "pipe", "pipe"] }).trim();
const gitInput = (cwd, args, input) => execFileSync("git", args, { cwd, input, encoding: "utf8", env: testEnv() }).trim();
const run = (cwd, args, env = {}) => spawnSync(cstCommand, [...cstPrefix(), ...args], { cwd, encoding: "utf8", env: testEnv(env) });
function vlab(cwd, ...args) {
  const result = run(cwd, args);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return JSON.parse(result.stdout);
}
function fixture(t, format = "sha1") {
  // The temporary directory is read once: a suite mode may point it
  // elsewhere by the time cleanup runs (test-support/native-kind.js).
  const temporary = fs.realpathSync.native(os.tmpdir());
  const parent = fs.realpathSync.native(fs.mkdtempSync(path.join(temporary, "vlab-retain-")));
  t.after(() => {
    assert.ok(parent.startsWith(temporary + path.sep));
    fs.rmSync(parent, { recursive: true, force: true });
  });
  const repo = path.join(parent, "repo");
  fs.mkdirSync(repo);
  git(repo, "init", "-b", "main", `--object-format=${format}`);
  configure(repo);
  fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "base");
  return { repo, parent };
}
function configure(repo) {
  git(repo, "config", "core.longpaths", "true");
  git(repo, "config", "core.autocrlf", "false");
  git(repo, "config", "user.name", "Retention test");
  git(repo, "config", "user.email", "retention@example.invalid");
}
function gc(repo, parent) {
  assert.ok(fs.realpathSync.native(repo).startsWith(parent + path.sep));
  git(repo, "reflog", "expire", "--expire=now", "--all");
  git(repo, "gc", "--prune=now");
  git(repo, "fsck", "--no-reflogs");
}
function refs(repo) { return git(repo, "for-each-ref", "--format=%(refname) %(objectname)"); }
function generatedChange(repo, name) {
  fs.writeFileSync(path.join(repo, `${name}.txt`), `${name}\n`);
  git(repo, "add", ".");
  return vlab(repo, "commit", "-m", name, "--generated-by", "retention test").commit;
}
function roundTrip(repo, parent, expected) {
  const envelope = path.join(parent, "envelope");
  vlab(repo, "metadata", "export", envelope, "--json");
  const clone = path.join(parent, "clone");
  git(parent, "clone", "--no-local", "--single-branch", "--branch", "main", repo, clone);
  configure(clone);
  assert.equal(vlab(clone, "metadata", "import", envelope, "--apply", "--json").changed, true);
  const before = refs(clone);
  assert.equal(vlab(clone, "metadata", "import", envelope, "--apply", "--json").changed, false);
  assert.equal(refs(clone), before);
  gc(clone, parent);
  const validation = vlab(clone, "metadata", "validate", "--json");
  assert.equal(validation.summary.acceptedPortableRecords, expected);
  assert.equal(validation.summary.errors, 0);
}

for (const format of ["sha1", "sha256"]) {
  for (const mode of ["hard-squash", "cherry-pick", "rebase"]) {
    test(`${format} ${mode} facts survive source deletion and GC without granting coverage elsewhere`, (t) => {
      const { repo, parent } = fixture(t, format);
      const base = git(repo, "rev-parse", "HEAD");
      git(repo, "switch", "-c", "source");
      const source = generatedChange(repo, "source");
      git(repo, "switch", "main");
      fs.writeFileSync(path.join(repo, "target.txt"), "target\n");
      git(repo, "add", ".");
      git(repo, "commit", "-m", "target");
      if (mode === "hard-squash") vlab(repo, "hard-squash", "source");
      if (mode === "cherry-pick") vlab(repo, "cherry-pick", source, "--json");
      if (mode === "rebase") {
        git(repo, "switch", "source");
        vlab(repo, "rebase", "main", "--json");
        git(repo, "switch", "main");
        git(repo, "merge", "--ff-only", "source");
      }
      const expected = vlab(repo, "metadata", "validate", "--json").summary.acceptedPortableRecords;
      git(repo, "branch", "-D", "source");
      gc(repo, parent);
      assert.equal(vlab(repo, "metadata", "validate", "--json").summary.acceptedPortableRecords, expected);
      roundTrip(repo, parent, expected);
      git(repo, "switch", "-c", "uncovered", base);
      git(repo, "branch", "source", source);
      assert.deepEqual(vlab(repo, "merge-plan", "source", "--json").changes.map(change => change.status), ["new"]);
    });
  }
}

/**
 * Pause a reconciliation on a conflict in `base.txt` and stage its resolution,
 * so that `reconcile --continue` publishes a resolution: a `source` branch and
 * the target each changed the line.
 */
function stageResolution(repo) {
  git(repo, "switch", "-c", "source");
  fs.writeFileSync(path.join(repo, "base.txt"), "source\n");
  git(repo, "commit", "-am", "source");
  git(repo, "switch", "main");
  fs.writeFileSync(path.join(repo, "base.txt"), "target\n");
  git(repo, "commit", "-am", "target");
  assert.equal(JSON.parse(run(repo, ["reconcile", "source", "--json"]).stdout).code, "conflict-paused");
  fs.writeFileSync(path.join(repo, "base.txt"), "resolved\n");
  git(repo, "add", "base.txt");
}
function publishResolution(repo) {
  stageResolution(repo);
  vlab(repo, "reconcile", "--continue", "--json");
  return git(repo, "for-each-ref", "--format=%(refname)", "refs/causet/resolutions");
}

/**
 * Commit `name` with declared provenance after a post-commit hook has run
 * `script`, an ES module given the new commit as `head` and the helpers `git`
 * and `gitInput`; the provenance is then appended to the notes tree it left.
 * Returns the CLI's result and the commit.
 */
function commitOntoNotesTree(repo, parent, name, script, env = {}) {
  const module = path.join(parent, `${name}-hook.mjs`);
  fs.writeFileSync(module, `import { execFileSync } from "node:child_process";
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const gitInput = (args, input) => execFileSync("git", args, { input, encoding: "utf8" }).trim();
const head = git("rev-parse", "HEAD");
${script}
`);
  const hook = path.join(repo, ".git", "hooks", "post-commit");
  fs.mkdirSync(path.dirname(hook), { recursive: true });
  const slash = (file) => file.replaceAll("\\", "/");
  fs.writeFileSync(hook, `#!/bin/sh\nexec "${slash(process.execPath)}" "${slash(module)}"\n`);
  fs.chmodSync(hook, 0o755);
  fs.writeFileSync(path.join(repo, `${name}.txt`), `${name}\n`);
  git(repo, "add", ".");
  const result = run(repo, ["commit", "-m", name, "--authored-by", "retention test", "--json"], env);
  fs.rmSync(hook);
  return { result, head: git(repo, "rev-parse", "HEAD") };
}
const recordCount = (repo, head) => JSON.parse(git(repo, "notes", "--ref=causet", "show", head)).records.length;
const portableRefs = (repo) => git(repo, "for-each-ref", "--format=%(refname) %(objectname)",
  NOTES, RETENTION, "refs/causet/resolutions");

test("retained interrupted receipts survive abort and GC without covering the restored target", (t) => {
  const { repo, parent } = fixture(t);
  git(repo, "switch", "-c", "source");
  generatedChange(repo, "source");
  git(repo, "switch", "main");
  generatedChange(repo, "target");
  assert.equal(run(repo, ["reconcile", "source", "--json"], { CAUSET_TEST_FAULT: "reconcile:before-clear" }).status, 70);
  const accepted = vlab(repo, "metadata", "validate", "--json").summary.acceptedPortableRecords;
  vlab(repo, "reconcile", "--abort", "--json");
  gc(repo, parent);
  assert.equal(vlab(repo, "metadata", "validate", "--json").summary.acceptedPortableRecords, accepted);
  const plan = vlab(repo, "merge-plan", "source", "--json");
  assert.equal(plan.counts.covered, 0);
  assert.equal(plan.counts.new, 1);
});

test("large dependency sets bound carrier parent fan-in and retain every commit", (t) => {
  const { repo, parent } = fixture(t);
  const head = git(repo, "rev-parse", "HEAD");
  const tree = git(repo, "rev-parse", "HEAD^{tree}");
  const carriedFrom = Array.from({ length: 80 }, (_, index) => gitInput(repo, ["commit-tree", tree], `origin ${index}\n`));
  const record = { schema: "causet.provenance/v1", type: "provenance", id: "prov_many", commit: head,
    changeId: null, actors: [{ role: "generated", actor: "test" }], origin: "carried", carriedFrom };
  // An old writer's note: the record without its retention, which backfill builds.
  gitInput(repo, ["notes", "--ref=causet", "add", "-f", "-F", "-", head],
    JSON.stringify({ schema: "causet.note/v1", records: [record] }));
  assert.equal(vlab(repo, "metadata", "retain", "--apply", "--json").changed, true);
  gc(repo, parent);
  for (const line of git(repo, "rev-list", "--parents", RETENTION).split("\n")) assert.ok(line.split(" ").length <= 65);
  for (const oid of carriedFrom) assert.equal(git(repo, "cat-file", "-t", oid), "commit");
  assert.equal(vlab(repo, "metadata", "validate", "--json").summary.acceptedPortableRecords, 1);
});

test("import refuses a locked retention ref without publishing notes or resolution refs", (t) => {
  const { repo, parent } = fixture(t);
  assert.notEqual(publishResolution(repo), "");
  const envelope = path.join(parent, "envelope");
  vlab(repo, "metadata", "export", envelope, "--json");
  const clone = path.join(parent, "clone");
  git(parent, "clone", "--no-local", "--single-branch", "--branch", "main", repo, clone);
  configure(clone);
  const before = refs(clone);
  const lock = path.resolve(clone, git(clone, "rev-parse", "--git-path", `${RETENTION}.lock`));
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, "held");
  assert.notEqual(run(clone, ["metadata", "import", envelope, "--apply", "--json"]).status, 0);
  assert.equal(refs(clone), before);
  fs.unlinkSync(lock);
  assert.equal(vlab(clone, "metadata", "import", envelope, "--apply", "--json").changed, true);
});

test("publication onto a fanned note replaces the existing leaf", (t) => {
  const { repo, parent } = fixture(t);
  // The new commit's note, as an earlier writer left it, under a fanned path.
  const { result, head } = commitOntoNotesTree(repo, parent, "fanned", `
const record = { schema: "causet.provenance/v1", type: "provenance", id: "prov_existing", commit: head,
  changeId: null, actors: [{ role: "generated", actor: "test" }], origin: "declared", carriedFrom: [] };
const note = gitInput(["hash-object", "-w", "--stdin"], JSON.stringify({ schema: "causet.note/v1", records: [record] }));
const fan = gitInput(["mktree"], "100644 blob " + note + "\\t" + head.slice(2) + "\\n");
const root = gitInput(["mktree"], "040000 tree " + fan + "\\t" + head.slice(0, 2) + "\\n");
git("update-ref", "refs/notes/causet", gitInput(["commit-tree", root], "fanned notes\\n"));
`);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(git(repo, "notes", "--ref=causet", "list").split("\n").length, 1);
  assert.equal(recordCount(repo, head), 2);
  gc(repo, parent);
  assert.equal(vlab(repo, "metadata", "validate", "--json").summary.acceptedPortableRecords, 2);
});

test("mixed flat and fanned notes preserve unrelated notes and opaque entries", (t) => {
  const { repo, parent } = fixture(t);
  const base = git(repo, "rev-parse", "HEAD");
  const { result, head } = commitOntoNotesTree(repo, parent, "mixed", `
const record = { schema: "causet.provenance/v1", type: "provenance", id: "prov_existing", commit: head,
  changeId: null, actors: [{ role: "generated", actor: "test" }], origin: "declared", carriedFrom: [] };
const note = gitInput(["hash-object", "-w", "--stdin"], JSON.stringify({ schema: "causet.note/v1", records: [record] }));
const opaque = gitInput(["hash-object", "-w", "--stdin"], "opaque notes tree content\\n");
const base = ${JSON.stringify(base)};
const fanned = gitInput(["mktree"], "100644 blob " + opaque + "\\t" + base.slice(2) + "\\n");
const root = gitInput(["mktree"], "100644 blob " + note + "\\t" + head + "\\n040000 tree " + fanned + "\\t"
  + base.slice(0, 2) + "\\n100644 blob " + opaque + "\\topaque.txt\\n");
git("update-ref", "refs/notes/causet", gitInput(["commit-tree", root], "mixed notes\\n"));
`);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const opaque = git(repo, "rev-parse", `${NOTES}:opaque.txt`);
  assert.equal(git(repo, "notes", "--ref=causet", "list").split("\n").length, 2);
  assert.equal(recordCount(repo, head), 2);
  assert.equal(git(repo, "notes", "--ref=causet", "list", base), opaque);
  assert.equal(git(repo, "cat-file", "-p", opaque), "opaque notes tree content");
});

test("opaque hexadecimal directories are not mistaken for Git notes fan-out", (t) => {
  const { repo, parent } = fixture(t);
  const { result, head } = commitOntoNotesTree(repo, parent, "hexadecimal", `
const opaque = gitInput(["hash-object", "-w", "--stdin"], "opaque content\\n");
const directory = gitInput(["mktree"], "100644 blob " + opaque + "\\topaque.txt\\n");
const tree = gitInput(["mktree"], "040000 tree " + directory + "\\t" + head.slice(0, 4) + "\\n");
git("update-ref", "refs/notes/causet", gitInput(["commit-tree", tree], "opaque notes tree\\n"));
`);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(recordCount(repo, head), 1);
  const opaque = git(repo, "rev-parse", `${NOTES}:${head.slice(0, 4)}/opaque.txt`);
  assert.equal(git(repo, "cat-file", "-p", opaque), "opaque content");
});

test("an opaque tree occupying an attachment path is never overwritten", (t) => {
  const { repo, parent } = fixture(t);
  let before;
  const { result, head } = commitOntoNotesTree(repo, parent, "collision", `
const opaque = gitInput(["hash-object", "-w", "--stdin"], "opaque content\\n");
const directory = gitInput(["mktree"], "100644 blob " + opaque + "\\topaque.txt\\n");
const tree = gitInput(["mktree"], "040000 tree " + directory + "\\t" + head + "\\n");
git("update-ref", "refs/notes/causet", gitInput(["commit-tree", tree], "opaque notes tree\\n"));
`);
  // The commit stands; its provenance is refused, and nothing causet publishes moved.
  assert.notEqual(result.status, 0);
  assert.match(JSON.parse(result.stdout).details, /non-note object occupies/);
  before = git(repo, "rev-parse", NOTES);
  assert.equal(git(repo, "cat-file", "-p", git(repo, "rev-parse", `${NOTES}:${head}/opaque.txt`)), "opaque content");
  assert.equal(git(repo, "rev-parse", NOTES), before);
  assert.equal(spawnSync("git", ["rev-parse", "--verify", "--quiet", RETENTION], { cwd: repo, env: testEnv() }).status, 1,
    "no retention was published for the refused record");
});

test("independent resolution stage blobs survive GC and envelope transfer", (t) => {
  const { repo, parent } = fixture(t);
  assert.notEqual(publishResolution(repo), "");
  // The source's side of the conflict is reachable only through retention once
  // its branch is gone.
  const theirs = git(repo, "rev-parse", "source:base.txt");
  git(repo, "branch", "-D", "source");
  gc(repo, parent);
  assert.equal(git(repo, "cat-file", "-t", theirs), "blob");
  const validation = vlab(repo, "metadata", "validate", "--json").summary;
  assert.equal(validation.errors, 0);
  roundTrip(repo, parent, validation.acceptedPortableRecords);
});

test("a resolution, its note, and object retention publish together across hard exits", (t) => {
  for (const point of ["retention:before-publish", "retention:after-publish"]) {
    const { repo, parent } = fixture(t);
    stageResolution(repo);
    const before = portableRefs(repo);
    assert.equal(run(repo, ["reconcile", "--continue", "--json"], { CAUSET_TEST_FAULT: point }).status, 70);
    const resolutions = git(repo, "for-each-ref", "--format=%(refname)", "refs/causet/resolutions");
    if (point.endsWith("before-publish")) {
      assert.equal(portableRefs(repo), before, "nothing is published before the transaction");
      assert.equal(resolutions, "");
    } else {
      assert.equal(resolutions.split("\n").length, 1, "the resolution ref moved with its note");
      assert.notEqual(git(repo, "rev-parse", NOTES), before.match(/refs\/notes\/causet (\S+)/)?.[1]);
      assert.ok(git(repo, "rev-parse", RETENTION));
    }
    // The interrupted reconciliation is still abortable, and what was
    // published survives collection.
    vlab(repo, "reconcile", "--abort", "--json");
    gc(repo, parent);
    assert.equal(vlab(repo, "metadata", "validate", "--json").summary.errors, 0);
  }
});

test("backfill previews without mutations, retains historical facts, and is idempotent", (t) => {
  const { repo, parent } = fixture(t);
  generatedChange(repo, "historical");
  // Model an old writer: keep the notes, remove only the new retention root in this disposable repo.
  git(repo, "update-ref", "-d", RETENTION);
  const before = refs(repo);
  const preview = vlab(repo, "metadata", "retain", "--dry-run", "--json");
  assert.equal(preview.eligibleRecords, 1);
  assert.equal(preview.wouldChange, true);
  assert.equal(preview.changed, false);
  assert.equal(refs(repo), before);
  const linked = path.join(parent, "linked");
  git(repo, "worktree", "add", "--detach", linked, "HEAD");
  assert.equal(vlab(linked, "metadata", "retain", "--apply", "--json").changed, true);
  const retained = refs(repo);
  assert.equal(vlab(repo, "metadata", "retain", "--apply", "--json").changed, false);
  assert.equal(refs(repo), retained);
  git(repo, "reset", "--hard", "HEAD^");
  git(repo, "worktree", "remove", linked);
  gc(repo, parent);
  assert.equal(vlab(repo, "metadata", "validate", "--json").summary.acceptedPortableRecords, 1);
});

test("backfill reports missing historical objects instead of certifying them", (t) => {
  const { repo } = fixture(t);
  generatedChange(repo, "accepted");
  const head = git(repo, "rev-parse", "HEAD");
  const note = JSON.parse(git(repo, "notes", "--ref=causet", "show", head));
  note.records.push({ schema: "causet.provenance/v1", type: "provenance", id: "prov_missing", commit: head,
    changeId: null, actors: [{ role: "generated", actor: "test" }], origin: "carried", carriedFrom: ["f".repeat(head.length)] });
  gitInput(repo, ["notes", "--ref=causet", "add", "-f", "-F", "-", head], JSON.stringify(note));
  const result = run(repo, ["metadata", "retain", "--apply", "--json"]);
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.changed, true);
  assert.equal(report.eligibleRecords, 1);
  assert.equal(report.quarantinedRecords, 1);
  assert.ok(report.diagnostics.some(entry => entry.code === "missing-referenced-object"));
});

test("empty retention preview and apply leave refs and object storage unchanged", (t) => {
  const { repo } = fixture(t);
  const before = refs(repo);
  const objects = git(repo, "count-objects", "-v");
  for (const flag of ["--dry-run", "--apply"]) {
    const result = vlab(repo, "metadata", "retain", flag, "--json");
    assert.equal(result.eligibleRecords, 0);
    assert.equal(result.wouldChange, false);
    assert.equal(result.changed, false);
    assert.equal(refs(repo), before);
    assert.equal(git(repo, "count-objects", "-v"), objects);
  }
});

test("a foreign notes writer causes atomic publication to refuse without moving retention", async (t) => {
  const { repo, parent } = fixture(t);
  generatedChange(repo, "concurrent");
  const retention = git(repo, "rev-parse", RETENTION);
  const gate = path.join(parent, "gate");
  fs.writeFileSync(path.join(repo, "next.txt"), "next\n");
  git(repo, "add", ".");
  const child = spawn(cstCommand, [...cstPrefix(), "commit", "-m", "next", "--generated-by", "retention test", "--json"], {
    cwd: repo, env: testEnv({ CAUSET_TEST_GATE: "notes:after-read", CAUSET_TEST_GATE_FILE: gate }), stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  const exited = new Promise(resolve => child.on("close", resolve));
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const deadline = Date.now() + 20000;
  while (!fs.existsSync(`${gate}.reached`) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(fs.existsSync(`${gate}.reached`), output);
  // The writer has read the notes; another writer moves them under it.
  git(repo, "notes", "--ref=causet", "add", "-f", "-m", "foreign writer", "HEAD~1");
  const foreign = git(repo, "rev-parse", NOTES);
  fs.writeFileSync(gate, "release");
  assert.notEqual(await exited, 0);
  assert.equal(git(repo, "rev-parse", NOTES), foreign);
  assert.equal(git(repo, "rev-parse", RETENTION), retention);
  assert.match(output, /cannot lock ref|is at .* but expected/);
});
