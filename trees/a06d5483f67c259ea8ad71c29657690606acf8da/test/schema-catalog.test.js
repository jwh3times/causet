import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { RECORD_FAMILIES, schemaClassification, validateNoteRecord } from "../src/schemas.js";
import { testEnv } from "../test-support/git-environment.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schemasDir = path.join(projectRoot, "docs", "schemas");
const cli = path.join(projectRoot, "bin", "vlab.js");

// vcs-lab.forecast/v1 is accepted when reading stored forecasts but never
// written; the catalog lists it as superseded without a document.
const SUPERSEDED_WITHOUT_DOCUMENT = new Set(["vcs-lab.forecast/v1"]);

// Profile identifiers name contracts documented elsewhere -- the serialization
// profile in docs/canonical-json/, the identifier protocol in docs/identity/ --
// rather than record families, so they carry no schema document.
const PROFILE_IDENTIFIERS = new Set([
  "vcs-lab.canonical-json/v1",
  "vcs-lab.logical-id/v1",
]);

// ---------------------------------------------------------------------------
// Catalog loading
// ---------------------------------------------------------------------------

const documents = new Map();
for (const file of fs.readdirSync(schemasDir).filter((name) => name.endsWith(".schema.json")).sort()) {
  const document = JSON.parse(fs.readFileSync(path.join(schemasDir, file), "utf8"));
  assert.equal(typeof document.$id, "string", `${file} has no $id`);
  assert.ok(!documents.has(document.$id), `duplicate $id '${document.$id}'`);
  documents.set(document.$id, { file, document });
}

// ---------------------------------------------------------------------------
// Minimal JSON Schema validator for the keyword subset the catalog uses.
// Unknown keywords are an error so a document cannot silently rely on a
// constraint this validator would ignore.
// ---------------------------------------------------------------------------

const ANNOTATION_KEYWORDS = new Set([
  "$schema", "$id", "title", "description", "format", "examples", "deprecated",
  "x-vcs-lab-scope", "default",
]);
const SCHEMA_KEYWORDS = new Set([
  "$defs", "$ref", "type", "const", "enum", "pattern", "required",
  "properties", "items", "minLength", "minimum", "maximum",
]);

function assertKnownKeywords(node, where) {
  for (const key of Object.keys(node)) {
    assert.ok(
      ANNOTATION_KEYWORDS.has(key) || SCHEMA_KEYWORDS.has(key),
      `unsupported JSON Schema keyword '${key}' at ${where}`,
    );
  }
}

function walkSchema(node, where) {
  if (typeof node !== "object" || node === null || Array.isArray(node)) return;
  assertKnownKeywords(node, where);
  for (const [name, child] of Object.entries(node.$defs ?? {})) {
    walkSchema(child, `${where}/$defs/${name}`);
  }
  for (const [name, child] of Object.entries(node.properties ?? {})) {
    walkSchema(child, `${where}/properties/${name}`);
  }
  if (node.items) walkSchema(node.items, `${where}/items`);
}

function resolveRef(ref, currentDocument) {
  let target = currentDocument;
  let fragment = ref;
  if (!ref.startsWith("#")) {
    const [id, rest] = ref.split("#");
    const entry = documents.get(id);
    assert.ok(entry, `$ref to unknown catalog document '${id}'`);
    target = entry.document;
    fragment = rest ?? "";
  } else {
    fragment = ref.slice(1);
  }
  let node = target;
  for (const rawSegment of fragment.split("/").filter(Boolean)) {
    const segment = rawSegment.replace(/~1/g, "/").replace(/~0/g, "~");
    node = node?.[segment];
  }
  assert.ok(node, `$ref '${ref}' did not resolve`);
  return { schema: node, document: target };
}

function jsonType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function typeMatches(value, type) {
  const actual = jsonType(value);
  if (type === "integer") return actual === "number" && Number.isInteger(value);
  return actual === type;
}

function validate(value, schema, document, errors, at) {
  if (schema.$ref) {
    const resolved = resolveRef(schema.$ref, document);
    validate(value, resolved.schema, resolved.document, errors, at);
    return;
  }
  assertKnownKeywords(schema, at);
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => typeMatches(value, type))) {
      errors.push(`${at}: expected ${types.join("|")}, got ${jsonType(value)}`);
      return;
    }
  }
  if (schema.const !== undefined && JSON.stringify(value) !== JSON.stringify(schema.const)) {
    errors.push(`${at}: expected constant ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
  }
  if (schema.enum !== undefined && !schema.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))) {
    errors.push(`${at}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
  }
  if (typeof value === "string") {
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${at}: '${value.slice(0, 80)}' does not match ${schema.pattern}`);
    }
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${at}: shorter than minLength ${schema.minLength}`);
    }
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${at}: ${value} below minimum ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`${at}: ${value} above maximum ${schema.maximum}`);
    }
  }
  if (jsonType(value) === "object") {
    for (const name of schema.required ?? []) {
      if (!(name in value)) errors.push(`${at}: missing required member '${name}'`);
    }
    for (const [name, child] of Object.entries(schema.properties ?? {})) {
      if (name in value) validate(value[name], child, document, errors, `${at}/${name}`);
    }
  }
  if (Array.isArray(value) && schema.items) {
    for (let index = 0; index < value.length; index += 1) {
      validate(value[index], schema.items, document, errors, `${at}[${index}]`);
    }
  }
}

function validateAgainst(schemaId, value) {
  const entry = documents.get(schemaId);
  assert.ok(entry, `no catalog document for '${schemaId}'`);
  const errors = [];
  validate(value, entry.document, entry.document, errors, schemaId);
  return errors;
}

function assertValid(schemaId, value, label) {
  const errors = validateAgainst(schemaId, value);
  assert.deepEqual(errors, [], `${label ?? schemaId} does not match its document:\n${errors.join("\n")}`);
}

// ---------------------------------------------------------------------------
// Static catalog checks
// ---------------------------------------------------------------------------

test("every schema identifier used in src has exactly one catalog document", () => {
  const used = new Set();
  for (const file of fs.readdirSync(path.join(projectRoot, "src"))) {
    const content = fs.readFileSync(path.join(projectRoot, "src", file), "utf8");
    for (const match of content.matchAll(/vcs-lab\.[a-z-]+\/v\d+/g)) used.add(match[0]);
  }
  // The compatibility registry holds versions as data rather than as literal
  // identifiers, so a family's registered, readable, and written versions are
  // part of what src/ uses even when no literal string names them.
  for (const [family, policy] of RECORD_FAMILIES) {
    for (const version of [...policy.registered, ...policy.readable, ...policy.written]) {
      used.add(`${family}/v${version}`);
    }
  }
  for (const id of used) {
    if (SUPERSEDED_WITHOUT_DOCUMENT.has(id) || PROFILE_IDENTIFIERS.has(id)) continue;
    assert.ok(documents.has(id), `schema '${id}' is used in src/ but has no document in docs/schemas/`);
  }
  for (const id of PROFILE_IDENTIFIERS) {
    assert.ok(used.has(id), `profile identifier '${id}' is no longer referenced; drop it from the allowlist`);
    assert.ok(!documents.has(id), `profile identifier '${id}' unexpectedly has a schema document`);
  }
  for (const id of documents.keys()) {
    assert.ok(used.has(id), `document '${id}' names a schema no src/ module uses`);
  }
  for (const id of SUPERSEDED_WITHOUT_DOCUMENT) {
    assert.ok(used.has(id), `superseded schema '${id}' is no longer referenced; drop it from the allowlist`);
    assert.ok(!documents.has(id), `superseded schema '${id}' unexpectedly has a document`);
  }
});

test("document identity, file naming, and scope agree with the runtime registry", () => {
  const scopeToClassification = new Map([
    ["note-container", "note-container"],
    ["note-record", "note-record"],
    ["worktree-private", "private"],
    ["shared-local", "shared-local"],
    ["tracked", "tracked"],
    ["envelope", "envelope"],
  ]);
  for (const [id, { file, document }] of documents) {
    const match = id.match(/^vcs-lab\.(.+)\/v(\d+)$/);
    assert.ok(match, `$id '${id}' is not a versioned vcs-lab schema identifier`);
    assert.equal(file, `${match[1]}.v${match[2]}.schema.json`, `file name for '${id}'`);
    assert.equal(document.$schema, "https://json-schema.org/draft/2020-12/schema", `$schema of '${id}'`);
    assert.equal(document.properties?.schema?.const, id, `properties.schema.const of '${id}'`);
    walkSchema(document, id);

    const scope = document["x-vcs-lab-scope"];
    const classification = schemaClassification(id);
    if (scope === "cli-output") {
      assert.equal(classification.known, false,
        `'${id}' is registered in src/schemas.js but its document claims cli-output scope`);
    } else {
      assert.ok(scopeToClassification.has(scope), `'${id}' has unsupported scope '${scope}'`);
      assert.equal(classification.known, true, `'${id}' is not registered in src/schemas.js`);
      assert.equal(classification.scope, scopeToClassification.get(scope),
        `scope of '${id}' disagrees with src/schemas.js`);
    }
  }
});

// ---------------------------------------------------------------------------
// Live agreement: records produced by the real CLI must satisfy both the
// runtime validators and the catalog documents.
// ---------------------------------------------------------------------------

function exec(command, args, cwd, options = {}) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    env: testEnv(),
    ...options,
  }).trim();
}

function git(cwd, ...args) {
  return exec("git", args, cwd);
}

function vlab(cwd, ...args) {
  return exec(process.execPath, [cli, ...args], cwd);
}

function vlabJson(cwd, ...args) {
  return JSON.parse(vlab(cwd, ...args));
}

function vlabResult(cwd, ...args) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8",
    env: testEnv(),
  });
}

function write(repo, relative, content) {
  const target = path.join(repo, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function commit(repo, message) {
  git(repo, "add", "-A");
  return vlabJson(repo, "commit", "-m", message, "--json");
}

let scenarioState = null;
let scenarioParent = null;

// Registered at module scope, not from inside a test: the scenario is built
// once and shared by every test below, so a hook registered while the first
// one runs would delete the repository the rest still need.
after(() => {
  if (scenarioParent) fs.rmSync(scenarioParent, { recursive: true, force: true });
});

/**
 * One disposable repository exercised through the real CLI so that every
 * persisted family and every schema-bearing CLI output exists as a genuine
 * record. Built once and shared by the agreement tests below.
 */
function scenario() {
  if (scenarioState) return scenarioState;
  const parent = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "vcs-lab-schema-catalog-")));
  scenarioParent = parent;
  const repo = path.join(parent, "repo");
  fs.mkdirSync(repo);
  git(repo, "init", "-b", "main");
  git(repo, "config", "core.autocrlf", "false");
  git(repo, "config", "core.eol", "lf");
  git(repo, "config", "user.name", "VCS Lab Schema Catalog Test");
  git(repo, "config", "user.email", "vcs-lab-schema@example.invalid");

  const captured = {
    repo,
    parent,
    outputs: new Map(),
    noteRecords: [],
  };
  const keep = (name, value) => {
    captured.outputs.set(name, value);
    return value;
  };

  // Base history and a conflicting feature branch.
  write(repo, "a.txt", "alpha\n");
  commit(repo, "Base");
  const baseCommit = git(repo, "rev-parse", "HEAD");
  git(repo, "switch", "-c", "feature");
  write(repo, "a.txt", "feature\n");
  commit(repo, "Feature change");
  write(repo, "b.txt", "beta\n");
  commit(repo, "Feature companion");
  git(repo, "switch", "main");
  write(repo, "a.txt", "main\n");
  commit(repo, "Main change");

  keep("merge-plan", vlabJson(repo, "merge-plan", "feature", "--json"));
  keep("forecast", vlabJson(repo, "forecast", "feature", "--json"));

  // A conflicted reconciliation exposes the private journal, then continues
  // to publish reconciliation, application, and resolution records.
  const conflicted = vlabResult(repo, "reconcile", "feature", "--json");
  assert.notEqual(conflicted.status, 0, "the reconcile fixture must pause on a conflict");
  keep("reconciliation-journal", JSON.parse(
    fs.readFileSync(path.join(repo, ".git", "vcs-lab", "reconciliation.json"), "utf8"),
  ));
  write(repo, "a.txt", "resolved\n");
  git(repo, "add", "a.txt");
  keep("reconcile-result", vlabJson(repo, "reconcile", "--continue", "--json"));

  // Landing receipt.
  git(repo, "switch", "-c", "topic");
  write(repo, "c.txt", "topic\n");
  commit(repo, "Topic change");
  git(repo, "switch", "main");
  keep("landing", vlabJson(repo, "compact-merge", "topic", "--json"));

  // Direct cherry-pick application receipt.
  git(repo, "switch", "-c", "pick-source", baseCommit);
  write(repo, "d.txt", "delta\n");
  commit(repo, "Pick source change");
  const pickCommit = git(repo, "rev-parse", "HEAD");
  git(repo, "switch", "main");
  keep("cherry-pick", vlabJson(repo, "cherry-pick", pickCommit, "--json"));

  // Specs: current manifest plus a trivially clean semantic merge plan.
  write(repo, "spec.md", "# Spec title\n\nPreamble text.\n\nREQ-CAT-01: The catalog is versioned.\n");
  vlab(repo, "spec", "index", "spec.md", "--json");
  commit(repo, "Add spec and manifest");
  keep("spec-manifest", JSON.parse(
    fs.readFileSync(path.join(repo, ".vcs-lab", "specs", "spec.md.json"), "utf8"),
  ));
  keep("spec-merge-plan", vlabJson(repo, "spec", "merge-plan", "spec.md", "HEAD", "HEAD", "HEAD", "--json"));

  // Causal rebase: a conflicting branch exposes the private journal, a clean
  // branch produces the forecast and receipts.
  git(repo, "switch", "-c", "rebase-conflict", baseCommit);
  write(repo, "a.txt", "rebase conflict\n");
  commit(repo, "Conflicting rebase change");
  const rebaseBlocked = vlabResult(repo, "rebase", "main", "--json");
  assert.notEqual(rebaseBlocked.status, 0, "the rebase fixture must pause on a conflict");
  keep("rebase-journal", JSON.parse(
    fs.readFileSync(path.join(repo, ".git", "vcs-lab", "rebase.json"), "utf8"),
  ));
  keep("rebase-abort", vlabJson(repo, "rebase", "--abort", "--json"));

  git(repo, "switch", "-c", "rebase-clean", baseCommit);
  write(repo, "e.txt", "epsilon\n");
  commit(repo, "Clean rebase change");
  keep("rebase-plan", vlabJson(repo, "rebase-plan", "main", "--json"));
  keep("rebase-forecast", vlabJson(repo, "rebase-forecast", "main", "--json"));
  keep("rebase-result", vlabJson(repo, "rebase", "main", "--json"));
  git(repo, "switch", "main");

  // Workspaces, checkpoint, prune, and the shared-local registry.
  const workspacePath = path.join(parent, "workspaces", "ws1");
  keep("workspace", vlabJson(repo, "workspace", "create", "ws1", "--from", "main", "--path", workspacePath, "--json"));
  keep("workspace-list", vlabJson(repo, "workspace", "list", "--json"));
  write(workspacePath, "draft.txt", "draft\n");
  keep("checkpoint", vlabJson(workspacePath, "workspace", "checkpoint", "--label", "schema catalog", "--json"));
  keep("workspace-prune", vlabJson(repo, "workspace", "prune", "--dry-run", "--json"));
  keep("workspace-registry", JSON.parse(
    fs.readFileSync(path.join(repo, ".git", "vcs-lab", "workspaces.json"), "utf8"),
  ));

  // Metadata inventory, envelope round trip, and the engine differential.
  keep("metadata-status", vlabJson(repo, "metadata", "status", "--json"));
  const validation = vlabResult(repo, "metadata", "validate", "--json");
  keep("metadata-validation", JSON.parse(validation.stdout));
  const envelopeDir = path.join(parent, "envelope");
  keep("metadata-export", vlabJson(repo, "metadata", "export", envelopeDir, "--json"));
  keep("metadata-envelope", JSON.parse(
    fs.readFileSync(path.join(envelopeDir, "manifest.json"), "utf8"),
  ));
  keep("metadata-import-preview", vlabJson(repo, "metadata", "import", envelopeDir, "--dry-run", "--json"));
  keep("metadata-import", vlabJson(repo, "metadata", "import", envelopeDir, "--apply", "--json"));
  keep("doctor", vlabJson(repo, "doctor", "--differential"));

  // Small bounded benchmarks for the two benchmark families.
  keep("scale-benchmark", vlabJson(
    repo, "metadata", "benchmark",
    "--history", "5", "--workspaces", "1", "--notes", "2",
    "--resolutions", "1", "--samples", "1", "--json",
  ));
  keep("spec-benchmark", vlabJson(repo, "spec", "benchmark", "--documents", "1", "--blocks", "2", "--json"));

  // Every published note record, and one raw note container.
  captured.noteRecords = vlabJson(repo, "receipts", "--json");
  const noteList = git(repo, "notes", "--ref=vcs-lab", "list").split(/\r?\n/)[0];
  keep("note-container", JSON.parse(git(repo, "cat-file", "blob", noteList.split(" ")[0])));

  scenarioState = captured;
  return captured;
}

test("live CLI records and outputs match their catalog documents", { timeout: 600_000 }, () => {
  const state = scenario();
  const cases = [
    ["vcs-lab.note/v1", "note-container"],
    ["vcs-lab.merge-plan/v1", "merge-plan"],
    ["vcs-lab.forecast/v2", "forecast"],
    ["vcs-lab.reconciliation-operation/v4", "reconciliation-journal"],
    ["vcs-lab.spec-merge-plan/v1", "spec-merge-plan"],
    ["vcs-lab.spec-manifest/v3", "spec-manifest"],
    ["vcs-lab.rebase-operation/v1", "rebase-journal"],
    ["vcs-lab.rebase-plan/v1", "rebase-plan"],
    ["vcs-lab.rebase-forecast/v1", "rebase-forecast"],
    ["vcs-lab.workspace/v1", "workspace"],
    ["vcs-lab.checkpoint/v1", "checkpoint"],
    ["vcs-lab.workspace-prune/v1", "workspace-prune"],
    ["vcs-lab.workspaces/v1", "workspace-registry"],
    ["vcs-lab.metadata-status/v1", "metadata-status"],
    ["vcs-lab.metadata-validation/v1", "metadata-validation"],
    ["vcs-lab.metadata-export/v1", "metadata-export"],
    ["vcs-lab.metadata-envelope/v1", "metadata-envelope"],
    ["vcs-lab.metadata-import-preview/v1", "metadata-import-preview"],
    ["vcs-lab.metadata-import/v1", "metadata-import"],
    ["vcs-lab.repository-scale-benchmark/v1", "scale-benchmark"],
    ["vcs-lab.spec-benchmark/v2", "spec-benchmark"],
  ];
  for (const [schemaId, outputName] of cases) {
    const value = state.outputs.get(outputName);
    assert.ok(value, `scenario did not capture '${outputName}'`);
    assert.equal(value.schema, schemaId, `'${outputName}' does not carry schema '${schemaId}'`);
    assertValid(schemaId, value, outputName);
  }

  assertValid("vcs-lab.landing/v1", state.outputs.get("landing"), "landing");
  assertValid("vcs-lab.application/v1", state.outputs.get("cherry-pick"), "cherry-pick");
  assertValid("vcs-lab.reconciliation/v6", state.outputs.get("reconcile-result").receipt, "reconcile receipt");
  assertValid("vcs-lab.merge-plan/v1", state.outputs.get("reconcile-result").plan, "reconcile plan");
  assertValid("vcs-lab.rebase/v1", state.outputs.get("rebase-result").receipt, "rebase receipt");
  assertValid("vcs-lab.rebase-plan/v1", state.outputs.get("rebase-result").plan, "rebase plan");
  assertValid("vcs-lab.engine-differential/v1", state.outputs.get("doctor").differential, "doctor differential");
  for (const workspace of state.outputs.get("workspace-list")) {
    assertValid("vcs-lab.workspace/v1", workspace, `workspace listing '${workspace.name}'`);
  }
});

test("every published note record satisfies its document and the runtime validator", { timeout: 600_000 }, () => {
  const state = scenario();
  const families = new Set();
  for (const record of state.noteRecords) {
    const classification = schemaClassification(record.schema);
    assert.equal(classification.scope, "note-record",
      `unexpected published record schema '${record.schema}'`);
    families.add(record.schema);
    assert.deepEqual(validateNoteRecord(record), [],
      `runtime validator rejects published record '${record.id}' (${record.schema})`);
    assertValid(record.schema, record, `published record '${record.id}'`);
  }
  assert.deepEqual(
    [...families].sort(),
    [
      "vcs-lab.application/v1",
      "vcs-lab.application/v4",
      "vcs-lab.landing/v1",
      "vcs-lab.rebase-application/v1",
      "vcs-lab.rebase/v1",
      "vcs-lab.reconciliation/v6",
      "vcs-lab.resolution/v1",
    ],
    "the scenario must publish every note-record family",
  );
});

test("documents are at least as strict as the runtime validator on missing fields", { timeout: 600_000 }, () => {
  const state = scenario();
  const sampleByFamily = new Map();
  for (const record of state.noteRecords) {
    if (!sampleByFamily.has(record.schema)) sampleByFamily.set(record.schema, record);
  }
  for (const [family, record] of sampleByFamily) {
    for (const field of Object.keys(record)) {
      const mutant = { ...record };
      delete mutant[field];
      const runtimeErrors = validateNoteRecord(mutant);
      if (runtimeErrors.length === 0) continue;
      const documentErrors = validateAgainst(family, mutant);
      assert.ok(
        documentErrors.length > 0,
        `removing '${field}' from a ${family} record fails the runtime validator ` +
        `(${runtimeErrors.map((error) => error.field).join(", ")}) but not the document`,
      );
    }
  }
});
