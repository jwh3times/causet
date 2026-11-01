import assert from "node:assert/strict";
import { execFileSync, spawnSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { testEnv } from "../test-support/git-environment.js";
import { resolutionSignatureFor } from "../src/schemas.js";

const cli = fileURLToPath(new URL("../bin/vlab.js", import.meta.url));
const notesModule = new URL("../src/notes.js", import.meta.url).href;
const resolutionsModule = new URL("../src/resolutions.js", import.meta.url).href;
const RETENTION = "refs/vcs-lab/retention";
const NOTES = "refs/notes/vcs-lab";
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: testEnv(), stdio: ["pipe", "pipe", "pipe"] }).trim();
const gitInput = (cwd, args, input) => execFileSync("git", args, { cwd, input, encoding: "utf8", env: testEnv() }).trim();
const run = (cwd, args, env = {}) => spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8", env: testEnv(env) });
function vlab(cwd, ...args) {
  const result = run(cwd, args);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return JSON.parse(result.stdout);
}
function fixture(t, format = "sha1") {
  const parent = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "vlab-retain-")));
  t.after(() => {
    assert.ok(parent.startsWith(fs.realpathSync.native(os.tmpdir()) + path.sep));
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

function resolutionScript(repo) {
  const stage = name => ({ mode: "100644", blob: gitInput(repo, ["hash-object", "-w", "--stdin"], `${name} standalone blob\n`) });
  const outcome = {
    algorithm: "ordered-three-way-blobs/v1", base: stage("base"), ours: stage("ours"), theirs: stage("theirs"),
    resultBlob: git(repo, "rev-parse", "HEAD:base.txt"), resultMode: "100644", path: "base.txt", decision: "created",
  };
  outcome.signature = resolutionSignatureFor(outcome);
  return `import { publishResolution } from ${JSON.stringify(resolutionsModule)};
    publishResolution(${JSON.stringify(outcome)}, { id: "test_application", appliedCommit: ${JSON.stringify(git(repo, "rev-parse", "HEAD"))} });`;
}
function scriptRun(repo, script, env = {}) {
  return spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: repo, encoding: "utf8", env: testEnv(env) });
}

test("retained interrupted receipts survive abort and GC without covering the restored target", (t) => {
  const { repo, parent } = fixture(t);
  git(repo, "switch", "-c", "source");
  generatedChange(repo, "source");
  git(repo, "switch", "main");
  generatedChange(repo, "target");
  assert.equal(run(repo, ["reconcile", "source", "--json"], { VLAB_TEST_FAULT: "reconcile:before-clear" }).status, 70);
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
  const record = { schema: "vcs-lab.provenance/v1", type: "provenance", id: "prov_many", commit: head,
    changeId: null, actors: [{ role: "generated", actor: "test" }], origin: "carried", carriedFrom };
  const result = scriptRun(repo, `import { appendNote } from ${JSON.stringify(notesModule)}; appendNote(${JSON.stringify(head)}, ${JSON.stringify(record)});`);
  assert.equal(result.status, 0, result.stderr);
  gc(repo, parent);
  for (const line of git(repo, "rev-list", "--parents", RETENTION).split("\n")) assert.ok(line.split(" ").length <= 65);
  for (const oid of carriedFrom) assert.equal(git(repo, "cat-file", "-t", oid), "commit");
  assert.equal(vlab(repo, "metadata", "validate", "--json").summary.acceptedPortableRecords, 1);
});

test("import refuses a locked retention ref without publishing notes or resolution refs", (t) => {
  const { repo, parent } = fixture(t);
  assert.equal(scriptRun(repo, resolutionScript(repo)).status, 0);
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

test("publication after importing fanned notes replaces the existing leaf", (t) => {
  const { repo, parent } = fixture(t);
  const head = generatedChange(repo, "original");
  roundTrip(repo, parent, 1);
  const clone = path.join(parent, "clone");
  const record = { schema: "vcs-lab.provenance/v1", type: "provenance", id: "prov_added", commit: head,
    changeId: null, actors: [{ role: "generated", actor: "test" }], origin: "declared", carriedFrom: [] };
  const result = scriptRun(clone, `import { appendNote } from ${JSON.stringify(notesModule)}; appendNote(${JSON.stringify(head)}, ${JSON.stringify(record)});`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(git(clone, "notes", "--ref=vcs-lab", "list").split("\n").length, 1);
  assert.equal(JSON.parse(git(clone, "notes", "--ref=vcs-lab", "show", head)).records.length, 2);
  gc(clone, parent);
  assert.equal(vlab(clone, "metadata", "validate", "--json").summary.acceptedPortableRecords, 2);
});

test("mixed flat and fanned notes preserve unrelated notes and opaque entries", (t) => {
  const { repo } = fixture(t);
  const head = generatedChange(repo, "mixed");
  const base = git(repo, "rev-parse", "HEAD^");
  const previous = git(repo, "rev-parse", NOTES);
  const noteBlob = git(repo, "notes", "--ref=vcs-lab", "list", head);
  const opaque = gitInput(repo, ["hash-object", "-w", "--stdin"], "opaque notes tree content\n");
  const fanned = gitInput(repo, ["mktree"], `100644 blob ${opaque}\t${base.slice(2)}\n`);
  const root = gitInput(repo, ["mktree"], `100644 blob ${noteBlob}\t${head}\n040000 tree ${fanned}\t${base.slice(0, 2)}\n100644 blob ${opaque}\topaque.txt\n`);
  const mixed = gitInput(repo, ["commit-tree", root, "-p", previous], "mixed notes\n");
  git(repo, "update-ref", NOTES, mixed, previous);
  const record = { schema: "vcs-lab.provenance/v1", type: "provenance", id: "prov_mixed", commit: head,
    changeId: null, actors: [{ role: "generated", actor: "test" }], origin: "declared", carriedFrom: [] };
  const result = scriptRun(repo, `import { appendNote } from ${JSON.stringify(notesModule)}; appendNote(${JSON.stringify(head)}, ${JSON.stringify(record)});`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(git(repo, "notes", "--ref=vcs-lab", "list").split("\n").length, 2);
  assert.equal(JSON.parse(git(repo, "notes", "--ref=vcs-lab", "show", head)).records.length, 2);
  assert.equal(git(repo, "notes", "--ref=vcs-lab", "list", base), opaque);
  assert.equal(git(repo, "rev-parse", `${NOTES}:opaque.txt`), opaque);
});

test("independent resolution stage blobs survive GC and envelope transfer", (t) => {
  const { repo, parent } = fixture(t);
  const published = scriptRun(repo, resolutionScript(repo));
  assert.equal(published.status, 0, published.stderr);
  gc(repo, parent);
  assert.equal(vlab(repo, "metadata", "validate", "--json").summary.acceptedPortableRecords, 1);
  roundTrip(repo, parent, 1);
});

test("a resolution, its note, and object retention publish together across hard exits", (t) => {
  for (const point of ["retention:before-publish", "retention:after-publish"]) {
    const { repo, parent } = fixture(t);
    const script = resolutionScript(repo);
    const before = refs(repo);
    assert.equal(scriptRun(repo, script, { VLAB_TEST_FAULT: point }).status, 70);
    if (point.endsWith("before-publish")) {
      assert.equal(refs(repo), before);
      assert.equal(scriptRun(repo, script).status, 0, "a new writer abandons the exited writer's lock");
    }
    gc(repo, parent);
    assert.equal(vlab(repo, "metadata", "validate", "--json").summary.acceptedPortableRecords, 1);
    assert.equal(git(repo, "for-each-ref", "--format=%(refname)", "refs/vcs-lab/resolutions").split("\n").length, 1);
    assert.ok(git(repo, "rev-parse", RETENTION));
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
  const note = JSON.parse(git(repo, "notes", "--ref=vcs-lab", "show", head));
  note.records.push({ schema: "vcs-lab.provenance/v1", type: "provenance", id: "prov_missing", commit: head,
    changeId: null, actors: [{ role: "generated", actor: "test" }], origin: "carried", carriedFrom: ["f".repeat(head.length)] });
  gitInput(repo, ["notes", "--ref=vcs-lab", "add", "-f", "-F", "-", head], JSON.stringify(note));
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
  const head = generatedChange(repo, "concurrent");
  const retention = git(repo, "rev-parse", RETENTION);
  const gate = path.join(parent, "gate");
  const record = { schema: "vcs-lab.provenance/v1", type: "provenance", id: "prov_concurrent", commit: head,
    changeId: null, actors: [{ role: "generated", actor: "test" }], origin: "declared", carriedFrom: [] };
  const script = `import { appendNote } from ${JSON.stringify(notesModule)}; appendNote(${JSON.stringify(head)}, ${JSON.stringify(record)});`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    cwd: repo, env: testEnv({ VLAB_TEST_GATE: "notes:after-read", VLAB_TEST_GATE_FILE: gate }), stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  const exited = new Promise(resolve => child.on("close", resolve));
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const deadline = Date.now() + 20000;
  while (!fs.existsSync(`${gate}.reached`) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(fs.existsSync(`${gate}.reached`), stderr);
  git(repo, "notes", "--ref=vcs-lab", "add", "-f", "-m", "foreign writer", head);
  const foreign = git(repo, "rev-parse", NOTES);
  fs.writeFileSync(gate, "release");
  assert.notEqual(await exited, 0);
  assert.equal(git(repo, "rev-parse", NOTES), foreign);
  assert.equal(git(repo, "rev-parse", RETENTION), retention);
  assert.match(stderr, /cannot lock ref|is at .* but expected/);
});
