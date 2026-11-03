/**
 * A repository written by a released build reads identically in this one
 * (issue #159, ADR-0039 §2).
 *
 * `test/fixtures/legacy-0.19.1/` was produced by `scripts/make-legacy-fixture.mjs`
 * with v0.19.1, whose records all carry `vcs-lab.*` identifiers: every ref in a
 * base64 bundle, the shared-local and private state a bundle cannot carry, an exported
 * envelope, a proof bundle, and that build's own read outputs. Records keep
 * those identifiers forever, so this build must read them as the `causet.*`
 * families they alias. The comparison ignores only what cannot be the same: the
 * spelling of the identifiers, the fixture's location, and path separators.
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { testEnv } from "../test-support/git-environment.js";
import { vlabCommand, vlabPrefix } from "../test-support/vlab-command.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.join(here, "fixtures", "legacy-0.19.1");
const fixture = JSON.parse(fs.readFileSync(path.join(source, "fixture.json"), "utf8"));

const created = [];
after(() => {
  for (const directory of created) fs.rmSync(directory, { recursive: true, force: true });
});

// Every string under <ROOT> becomes a path under `root`, with this platform's separators.
function rooted(value, root) {
  if (typeof value === "string" && value.startsWith("<ROOT>")) {
    return path.join(root, ...value.slice("<ROOT>".length).split(/[\\/]/).filter(Boolean));
  }
  if (Array.isArray(value)) return value.map((item) => rooted(item, root));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rooted(item, root)]));
  }
  return value;
}

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, env: testEnv(), encoding: "utf8" }).trim();
}

/** Restore the fixture into a fresh directory and return its root. */
function restore() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "vcs-lab-legacy-test-")));
  created.push(root);
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "Legacy Fixture");
  git(repo, "config", "user.email", "legacy@example.invalid");
  git(repo, "config", "core.autocrlf", "false");
  const bundle = path.join(root, "repo.bundle");
  fs.writeFileSync(bundle, Buffer.from(fixture.bundle, "base64"));
  git(repo, "fetch", "-q", "--update-head-ok", bundle, "+refs/*:refs/*");
  git(repo, "reset", "-q", "--hard", fixture.head);
  // What `cst init` configured in the fixture's repository.
  git(repo, "config", "notes.displayRef", "refs/notes/vcs-lab");
  git(repo, "config", "notes.rewriteRef", "refs/notes/vcs-lab");
  const workspacePath = rooted(fixture.workspace.path, root);
  git(repo, "worktree", "add", "-q", workspacePath, fixture.workspace.branch);
  fs.writeFileSync(path.join(workspacePath, "work.txt"), "workspace work\n");
  for (const [relative, text] of Object.entries(fixture.state)) {
    const file = path.join(repo, ".git", "vcs-lab", ...relative.split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(rooted(JSON.parse(text), root), null, 2)}\n`);
  }
  for (const [relative, base64] of Object.entries(fixture.envelope)) {
    const file = path.join(root, "envelope", ...relative.split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(base64, "base64"));
  }
  fs.writeFileSync(path.join(root, "proof-bundle.json"), fixture.proofBundle);
  return root;
}

function cst(cwd, args, env = {}) {
  return spawnSync(vlabCommand, [...vlabPrefix(), ...args], { cwd, encoding: "utf8", env: testEnv(env) });
}

/** What may differ between the old build's output and this build's. */
/**
 * What may differ between the old build's output and this build's. After
 * `cst migrate`, where things live differs too, so the former locations are
 * mapped to the current ones on both sides.
 */
function normalize(text, root, { migrated = false } = {}) {
  let result = text
    .split(JSON.stringify(root).slice(1, -1)).join("<ROOT>")
    .split(root).join("<ROOT>")
    .replaceAll("\\\\", "/")
    .replaceAll("\\", "/")
    .replace(/\bvcs-lab\.(?=[a-z][a-z-]*(?:\/v\d+)?\b)/g, "causet.")
    .replaceAll("causal-vcs-lab", "causet");
  if (migrated) {
    result = result
      .replaceAll("refs/notes/vcs-lab", "refs/notes/causet")
      .replaceAll("refs/vcs-lab/", "refs/causet/")
      .replaceAll("--ref=vcs-lab", "--ref=causet")
      .replaceAll("/.git/vcs-lab", "/.git/causet")
      .replaceAll(".vcs-lab/specs", ".causet/specs");
  }
  return result;
}

/**
 * `metadata status` and `validate` report the repository's migration state,
 * which v0.19.1 had no notion of: an unmigrated repository carries exactly one
 * `unmigrated-repository` info diagnostic, a migrated one none. That entry is
 * checked and then set aside, so everything else still compares byte for byte.
 */
function withoutMigrationDiagnostic(args, stdout, migrated) {
  if (args[0] !== "metadata" || !["status", "validate"].includes(args[1])) return stdout;
  const report = JSON.parse(stdout);
  const notices = report.diagnostics.filter((entry) => entry.code === "unmigrated-repository");
  assert.equal(notices.length, migrated ? 0 : 1, `unmigrated-repository in ${args.join(" ")}`);
  assert.ok(notices.every((entry) => entry.severity === "info"));
  report.diagnostics = report.diagnostics.filter((entry) => entry.code !== "unmigrated-repository");
  return `${JSON.stringify(report, null, 2)}\n`;
}

function assertReadsMatch(root, { migrated = false } = {}) {
  const repo = path.join(root, "repo");
  for (const expected of fixture.expected) {
    const args = rooted(expected.args, root);
    const actual = cst(repo, args);
    const label = expected.args.join(" ");
    assert.equal(actual.status, expected.status, `status of ${label}\n${actual.stderr}`);
    const stdout = withoutMigrationDiagnostic(expected.args, actual.stdout, migrated);
    assert.equal(normalize(stdout, root, { migrated }), normalize(expected.stdout, root, { migrated }),
      `stdout of ${label}`);
    assert.equal(normalize(actual.stderr, root, { migrated }), normalize(expected.stderr, root, { migrated }),
      `stderr of ${label}`);
  }
}

test("a repository written by v0.19.1 reads identically, apart from identifier spellings", () => {
  assert.match(fixture.generatedBy, /^causet 0\.19\.1$/);
  assertReadsMatch(restore());
});

test("cst migrate moves a v0.19.1 repository to the causet names, and every read stays the same", () => {
  const root = restore();
  const repo = path.join(root, "repo");
  const refsBefore = git(repo, "for-each-ref", "--format=%(refname) %(objectname)");
  const doctorBefore = JSON.parse(cst(repo, ["doctor"]).stdout);
  assert.equal(doctorBefore.migration, "unmigrated");
  assert.equal(doctorBefore.notesRef, "refs/notes/vcs-lab");

  // A dry run reports the whole move and changes nothing.
  const preview = JSON.parse(cst(repo, ["migrate", "--dry-run", "--json"]).stdout);
  assert.equal(preview.schema, "causet.migration-report/v1");
  assert.equal(preview.mode, "dry-run");
  assert.equal(preview.refused, null);
  assert.ok(preview.refs.some((entry) => entry.from === "refs/notes/vcs-lab" && entry.to === "refs/notes/causet"));
  assert.ok(preview.refs.every((entry) => entry.action === "create"));
  assert.equal(preview.specs.action, "move");
  assert.equal(git(repo, "for-each-ref", "--format=%(refname) %(objectname)"), refsBefore);

  const applied = cst(repo, ["migrate", "--json"]);
  assert.equal(applied.status, 0, applied.stderr);
  const report = JSON.parse(applied.stdout);
  assert.equal(report.stateAfter, "migrated");
  assert.equal(report.summary.commitRequired, true);
  // Every former ref is kept where it was, and each new one names the same object.
  const refs = new Map(git(repo, "for-each-ref", "--format=%(refname) %(objectname)").split("\n")
    .map((line) => line.split(" ")));
  for (const line of refsBefore.split("\n")) {
    const [ref, oid] = line.split(" ");
    assert.equal(refs.get(ref), oid, `${ref} must stay where it was`);
    if (ref === "refs/notes/vcs-lab") assert.equal(refs.get("refs/notes/causet"), oid);
    if (ref.startsWith("refs/vcs-lab/")) assert.equal(refs.get(`refs/causet/${ref.slice(13)}`), oid);
  }
  assert.equal(git(repo, "config", "notes.displayRef"), "refs/notes/causet");
  assert.ok(fs.existsSync(path.join(repo, ".git", "causet", "workspaces.json")));
  assert.equal(fs.existsSync(path.join(repo, ".git", "vcs-lab", "workspaces.json")), false);
  // The manifest move is staged for the user to commit, never committed for them.
  assert.match(git(repo, "status", "--porcelain"), /^R {2}\.vcs-lab\/specs\/specs\/design\.md\.json -> \.causet\/specs\/specs\/design\.md\.json$/m);

  // Compared before the user commits the move, so history is what v0.19.1 saw.
  const doctorAfter = JSON.parse(cst(repo, ["doctor"]).stdout);
  assert.equal(doctorAfter.migration, "migrated");
  assert.equal(doctorAfter.notesRef, "refs/notes/causet");
  assertReadsMatch(root, { migrated: true });
  git(repo, "commit", "-q", "-m", "Move specification manifests to .causet/specs");

  // Running it again finds nothing left to do.
  const again = JSON.parse(cst(repo, ["migrate", "--json"]).stdout);
  assert.deepEqual(again.summary, { refs: 0, config: 0, paths: 0, specs: 0, commitRequired: false });
});

test("a former ref that advances after migration is reported, then fast-forwarded or refused", () => {
  const root = restore();
  const repo = path.join(root, "repo");
  assert.equal(cst(repo, ["migrate"]).status, 0);
  git(repo, "commit", "-q", "-m", "Move specification manifests to .causet/specs");
  // A peer on an older build publishes to the former notes ref.
  const oldTip = git(repo, "rev-parse", "refs/notes/vcs-lab");
  const advanced = git(repo, "commit-tree", `${oldTip}^{tree}`, "-p", oldTip, "-m", "Notes added by an older build");
  git(repo, "update-ref", "refs/notes/vcs-lab", advanced, oldTip);
  const status = JSON.parse(cst(repo, ["metadata", "status", "--json"]).stdout);
  const warnings = status.diagnostics.filter((entry) => entry.code === "legacy-ref-advanced");
  assert.deepEqual(warnings.map((entry) => [entry.severity, entry.subject, entry.oid]),
    [["warning", "refs/notes/vcs-lab", advanced]]);
  assert.equal(JSON.parse(cst(repo, ["doctor"]).stdout).migration, "mixed");

  // Only the former side moved: a rerun fast-forwards the new ref.
  const forward = JSON.parse(cst(repo, ["migrate", "--json"]).stdout);
  assert.deepEqual(forward.refs.filter((entry) => entry.action !== "present").map((entry) => entry.action), ["fast-forward"]);
  assert.equal(git(repo, "rev-parse", "refs/notes/causet"), advanced);
  assert.equal(JSON.parse(cst(repo, ["doctor"]).stdout).migration, "migrated");

  // Both sides moved: cst migrate will not choose.
  const theirs = git(repo, "commit-tree", `${advanced}^{tree}`, "-p", advanced, "-m", "Older build again");
  const ours = git(repo, "commit-tree", `${advanced}^{tree}`, "-p", advanced, "-m", "This build");
  git(repo, "update-ref", "refs/notes/vcs-lab", theirs, advanced);
  git(repo, "update-ref", "refs/notes/causet", ours, advanced);
  const refused = cst(repo, ["migrate", "--json"]);
  assert.equal(refused.status, 1);
  assert.equal(JSON.parse(refused.stdout).code, "precondition-not-met");
  assert.equal(git(repo, "rev-parse", "refs/notes/causet"), ours);
});

test("cst migrate refuses while an operation is in progress", () => {
  const root = restore();
  const repo = path.join(root, "repo");
  const journal = path.join(repo, ".git", "vcs-lab", "reconciliation.json");
  fs.writeFileSync(journal, "{}\n");
  const refused = cst(repo, ["migrate", "--json"]);
  assert.equal(refused.status, 1);
  const envelope = JSON.parse(refused.stdout);
  assert.equal(envelope.code, "operation-in-progress");
  assert.match(envelope.details, /cst reconcile --continue/);
  assert.equal(git(repo, "for-each-ref", "refs/notes/causet"), "");
});

test("the legacy fixture really carries only vcs-lab identifiers", () => {
  // Guards the fixture itself: if it were regenerated with a build that writes
  // causet.* ids, the test above would stop proving anything about the alias.
  const receipts = fixture.expected.find((entry) => entry.args.join(" ") === "receipts --json");
  const schemas = new Set(JSON.parse(receipts.stdout).map((record) => record.schema));
  assert.ok(schemas.size >= 5, [...schemas].join(", "));
  for (const schema of schemas) assert.match(schema, /^vcs-lab\./);
});

test("a peer's capability document from v0.19.1 negotiates a full exchange", () => {
  const root = restore();
  const document = path.join(root, "old-capabilities.json");
  fs.writeFileSync(document, fixture.capabilities);
  const result = cst(path.join(root, "repo"), ["capabilities", "--against", document, "--json"]);
  assert.equal(result.status, 0, result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.summary.fullyCompatible, true, JSON.stringify(report.summary));
});

test("a pending operation journal under a legacy identifier is still resumable", () => {
  // A journal is private and carries no hash, so the only thing an older build
  // writes differently is the schema string; this rewrites exactly that.
  const root = restore();
  const repo = path.join(root, "repo");
  git(repo, "switch", "-q", "-c", "clash", fixture.head);
  fs.writeFileSync(path.join(repo, "work-clash.txt"), "clash source\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "clash source");
  git(repo, "switch", "-q", "main");
  fs.writeFileSync(path.join(repo, "work-clash.txt"), "clash target\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "clash target");
  const paused = cst(repo, ["reconcile", "clash", "--json"]);
  assert.notEqual(paused.status, 0, "the reconciliation should pause on the conflict");
  const journal = path.join(repo, ".git", "vcs-lab", "reconciliation.json");
  const state = JSON.parse(fs.readFileSync(journal, "utf8"));
  assert.match(state.schema, /^causet\.reconciliation-operation\//);
  fs.writeFileSync(journal, `${JSON.stringify({ ...state, schema: state.schema.replace(/^causet\./, "vcs-lab.") }, null, 2)}\n`);
  const status = cst(repo, ["reconcile", "--status", "--json"]);
  assert.equal(status.status, 0, status.stderr);
  const aborted = cst(repo, ["reconcile", "--abort", "--json"]);
  assert.equal(aborted.status, 0, aborted.stderr);
  assert.equal(fs.existsSync(journal), false);
});
