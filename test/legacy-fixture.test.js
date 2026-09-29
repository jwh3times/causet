/**
 * A repository written by a released build reads identically in this one
 * (issue #159, ADR-0039 §2).
 *
 * `test/fixtures/legacy-0.19.1/` was produced by `scripts/make-legacy-fixture.mjs`
 * with v0.19.1, whose records all carry `vcs-lab.*` identifiers: every ref in a
 * bundle, the shared-local and private state a bundle cannot carry, an exported
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
  git(repo, "fetch", "-q", "--update-head-ok", path.join(source, "repo.bundle"), "+refs/*:refs/*");
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
function normalize(text, root) {
  return text
    .split(JSON.stringify(root).slice(1, -1)).join("<ROOT>")
    .split(root).join("<ROOT>")
    .replaceAll("\\\\", "/")
    .replaceAll("\\", "/")
    .replace(/\bvcs-lab\.(?=[a-z][a-z-]*(?:\/v\d+)?\b)/g, "causet.")
    .replaceAll("causal-vcs-lab", "causet");
}

test("a repository written by v0.19.1 reads identically, apart from identifier spellings", () => {
  const root = restore();
  const repo = path.join(root, "repo");
  assert.match(fixture.generatedBy, /^causet 0\.19\.1$/);
  for (const expected of fixture.expected) {
    const args = rooted(expected.args, root);
    const actual = cst(repo, args);
    const label = expected.args.join(" ");
    assert.equal(actual.status, expected.status, `status of ${label}\n${actual.stderr}`);
    assert.equal(normalize(actual.stdout, root), normalize(expected.stdout, root), `stdout of ${label}`);
    assert.equal(normalize(actual.stderr, root), normalize(expected.stderr, root), `stderr of ${label}`);
  }
});

test("the legacy fixture really carries only vcs-lab identifiers", () => {
  // Guards the fixture itself: if it were regenerated with a build that writes
  // causet.* ids, the test above would stop proving anything about the alias.
  const receipts = fixture.expected.find((entry) => entry.args.join(" ") === "receipts --json");
  const schemas = new Set(JSON.parse(receipts.stdout).map((record) => record.schema));
  assert.ok(schemas.size >= 5, [...schemas].join(", "));
  for (const schema of schemas) assert.match(schema, /^vcs-lab\./);
});
