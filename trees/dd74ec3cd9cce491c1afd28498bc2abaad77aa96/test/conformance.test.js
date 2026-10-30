import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { testEnv } from "../test-support/git-environment.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(projectRoot, "bin", "vlab.js");

const fixtures = JSON.parse(
  fs.readFileSync(path.join(projectRoot, "docs", "conformance", "fixtures.json"), "utf8"),
);

// ---------------------------------------------------------------------------
// Repository helpers
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
  vlab(repo, "commit", "-m", message);
}

/**
 * One disposable repository carried to two stages. `clean` has published
 * landing, application, reconciliation, and resolution records and no pending
 * operation, so the plan, receipt, and metadata renderers all have real
 * content. `paused` additionally holds a conflicted reconciliation, which is
 * the only state in which the status and resolve renderers print anything but
 * their empty-state prose.
 */
let scenarioState = null;
let scenarioParent = null;

// Registered at module scope, not from inside a test: the scenario is built
// once and shared by every test below, so a hook registered while the first
// one runs would delete the repository the rest still need.
after(() => {
  if (scenarioParent) fs.rmSync(scenarioParent, { recursive: true, force: true });
});

function scenario() {
  if (scenarioState) return scenarioState;
  const parent = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "vcs-lab-conformance-")));
  const repo = path.join(parent, "repo");
  fs.mkdirSync(repo);
  git(repo, "init", "-b", "main");
  git(repo, "config", "core.autocrlf", "false");
  git(repo, "config", "core.eol", "lf");
  git(repo, "config", "user.name", "VCS Lab Conformance Test");
  git(repo, "config", "user.email", "vcs-lab-conformance@example.invalid");
  scenarioParent = parent;

  write(repo, "a.txt", "alpha\n");
  commit(repo, "Base");
  const baseCommit = git(repo, "rev-parse", "HEAD");

  // A conflicting feature branch, reconciled with an exact resolution so that
  // a resolution record exists in the catalog.
  git(repo, "switch", "-c", "feature");
  write(repo, "a.txt", "feature\n");
  commit(repo, "Feature change");
  git(repo, "switch", "main");
  write(repo, "a.txt", "main\n");
  commit(repo, "Main change");
  const conflicted = vlabResult(repo, "reconcile", "feature", "--json");
  assert.notEqual(conflicted.status, 0, "the reconcile fixture must pause on a conflict");
  write(repo, "a.txt", "resolved\n");
  git(repo, "add", "a.txt");
  vlab(repo, "reconcile", "--continue", "--json");

  // A landing receipt and a direct cherry-pick application receipt.
  git(repo, "switch", "-c", "topic");
  write(repo, "c.txt", "topic\n");
  commit(repo, "Topic change");
  git(repo, "switch", "main");
  vlab(repo, "compact-merge", "topic", "-m", "Land topic");
  git(repo, "switch", "-c", "pick-source", baseCommit);
  write(repo, "d.txt", "delta\n");
  // Declared authorship provenance, so the conformance repository carries
  // both a declaration and the record the cherry-pick below carries from it
  // (FR-ID-08). Declared here rather than earlier so the record sorts after
  // the reconciliation application the receipts fixture indexes at /0.
  git(repo, "add", "-A");
  vlab(
    repo, "commit", "-m", "Pick source change",
    "--generated-by", "conformance-agent",
    "--reviewed-by", "Conformance Reviewer",
  );
  const pickCommit = git(repo, "rev-parse", "HEAD");
  git(repo, "switch", "main");
  vlab(repo, "cherry-pick", pickCommit);

  // A tracked spec manifest for the semantic merge renderer.
  write(repo, "spec.md", "# Spec title\n\nPreamble text.\n\nREQ-CON-01: Output modes agree.\n");
  vlab(repo, "spec", "index", "spec.md", "--json");
  commit(repo, "Add spec and manifest");

  // A branch to plan and rebase against, left unmerged.
  git(repo, "switch", "-c", "plan-source", "main");
  write(repo, "e.txt", "echo\n");
  commit(repo, "Plan source change");
  git(repo, "switch", "main");

  // An exported envelope for the import preview renderer.
  const envelope = path.join(parent, "envelope");
  vlab(repo, "metadata", "export", envelope, "--json");
  const proofBundle = path.join(parent, "proof.json");
  fs.writeFileSync(proofBundle, vlab(repo, "proof-bundle", "plan-source"));

  const clean = { repo, parent, envelope, proofBundle };

  // Stage two: a second conflicted reconciliation, left paused.
  git(repo, "switch", "-c", "second", baseCommit);
  write(repo, "a.txt", "second\n");
  commit(repo, "Second conflicting change");
  git(repo, "switch", "main");
  const paused = vlabResult(repo, "reconcile", "second", "--json");
  assert.notEqual(paused.status, 0, "the second reconcile must pause on a conflict");

  scenarioState = { clean, paused: clean, repo, parent, envelope, proofBundle };
  return scenarioState;
}

// ---------------------------------------------------------------------------
// JSON pointer resolution (RFC 6901, the subset the fixtures use)
// ---------------------------------------------------------------------------

const MISSING = Symbol("missing");

function resolvePointer(document, pointer) {
  if (pointer === "") return document;
  let node = document;
  for (const rawSegment of pointer.split("/").slice(1)) {
    const segment = rawSegment.replace(/~1/g, "/").replace(/~0/g, "~");
    if (node === null || typeof node !== "object") return MISSING;
    if (Array.isArray(node)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= node.length) return MISSING;
      node = node[index];
      continue;
    }
    if (!(segment in node)) return MISSING;
    node = node[segment];
  }
  return node;
}

/** Substitute the scenario's runtime values into a fixture argument. */
function materialize(argument, state) {
  return argument.replace(/\{envelope\}/g, state.envelope)
    .replace(/\{proofBundle\}/g, state.proofBundle);
}

// ---------------------------------------------------------------------------
// Match rules
// ---------------------------------------------------------------------------

function stringForm(value) {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/**
 * Does the human text present `value` under the entry's rule? Returns null on
 * success or an explanation of the mismatch.
 */
function presents(text, value, requirement) {
  const rule = requirement.rule ?? "exact";
  if (rule === "exact") {
    return text.includes(stringForm(value))
      ? null
      : `expected the text to contain ${JSON.stringify(stringForm(value))}`;
  }
  if (rule === "prefix") {
    const minPrefix = requirement.minPrefix ?? 7;
    const full = stringForm(value);
    assert.ok(
      full.length >= minPrefix,
      `${requirement.pointer}: value is shorter than minPrefix ${minPrefix}`,
    );
    return text.includes(full.slice(0, minPrefix))
      ? null
      : `expected the text to contain the ${minPrefix}-character prefix ` +
        `${JSON.stringify(full.slice(0, minPrefix))} of ${JSON.stringify(full)}`;
  }
  if (rule === "mapped") {
    const rendered = requirement.render?.[String(value)];
    assert.ok(
      rendered !== undefined,
      `${requirement.pointer}: no render entry for ${JSON.stringify(String(value))}`,
    );
    return text.includes(rendered)
      ? null
      : `expected the text to render ${JSON.stringify(String(value))} as ${JSON.stringify(rendered)}`;
  }
  if (rule === "count") {
    assert.ok(Array.isArray(value), `${requirement.pointer}: count rule needs an array`);
    return text.includes(String(value.length))
      ? null
      : `expected the text to contain the count ${value.length}`;
  }
  if (rule === "present") {
    assert.ok(requirement.label, `${requirement.pointer}: present rule needs a label`);
    return text.includes(requirement.label)
      ? null
      : `expected the text to contain the label ${JSON.stringify(requirement.label)}`;
  }
  throw new assert.AssertionError({ message: `unknown match rule '${rule}'` });
}

// ---------------------------------------------------------------------------
// Fixture-file shape
// ---------------------------------------------------------------------------

test("the fixture file declares a versioned, well-formed contract", () => {
  assert.equal(fixtures.schema, "vcs-lab.conformance-fixtures/v1");
  assert.ok(Array.isArray(fixtures.commands) && fixtures.commands.length > 0);
  const seen = new Set();
  for (const entry of fixtures.commands) {
    assert.ok(entry.name, "every command entry needs a name");
    assert.ok(!seen.has(entry.name), `duplicate fixture entry '${entry.name}'`);
    seen.add(entry.name);
    assert.ok(Array.isArray(entry.argv) && entry.argv.length > 0, `${entry.name}: argv`);
    assert.equal(entry.mode, "reread", `${entry.name}: only the reread mode is defined today`);
    assert.ok(Array.isArray(entry.required) && entry.required.length > 0, `${entry.name}: required`);
    assert.ok(Array.isArray(entry.jsonOnly), `${entry.name}: jsonOnly`);
    assert.ok(["clean", "paused"].includes(entry.stage), `${entry.name}: stage`);
    for (const requirement of entry.required) {
      assert.ok(requirement.pointer !== undefined, `${entry.name}: a requirement needs a pointer`);
    }
    for (const omission of entry.jsonOnly) {
      assert.ok(omission.pointer !== undefined, `${entry.name}: an omission needs a pointer`);
      assert.ok(omission.reason, `${entry.name} ${omission.pointer}: an omission needs a reason`);
    }
  }
  const failureNames = new Set();
  assert.ok(Array.isArray(fixtures.failureCommands) && fixtures.failureCommands.length > 0);
  for (const entry of fixtures.failureCommands) {
    assert.ok(entry.name && !failureNames.has(entry.name), `failure fixture name '${entry.name}'`);
    failureNames.add(entry.name);
    assert.ok(Array.isArray(entry.argv) && entry.argv.includes("--json"), `${entry.name}: argv`);
    assert.ok(["clean", "paused"].includes(entry.stage), `${entry.name}: stage`);
    assert.match(entry.code, /^[a-z][a-z-]*[a-z]$/, `${entry.name}: code`);
    assert.ok(entry.reason, `${entry.name}: a failure fixture needs a reason`);
  }
  for (const group of ["jsonOnlyCommands", "textOnlyCommands"]) {
    assert.ok(Array.isArray(fixtures[group]) && fixtures[group].length > 0, group);
    for (const entry of fixtures[group]) {
      assert.ok(Array.isArray(entry.argv) && entry.argv.length > 0, `${group}: argv`);
      assert.ok(entry.reason, `${group} ${entry.argv.join(" ")}: needs a reason`);
    }
  }
});

// ---------------------------------------------------------------------------
// Parity
// ---------------------------------------------------------------------------

test("human output presents every member the fixtures require", { timeout: 600_000 }, () => {
  const state = scenario();
  const failures = [];
  for (const entry of fixtures.commands) {
    const argv = entry.argv.map((argument) => materialize(argument, state));
    const humanRun = vlabResult(state.repo, ...argv);
    const jsonRun = vlabResult(state.repo, ...argv, "--json");
    assert.ok(
      humanRun.stdout.trim().length > 0,
      `${entry.name}: produced no human output (${humanRun.stderr.trim()})`,
    );
    assert.ok(
      jsonRun.stdout.trim().length > 0,
      `${entry.name}: produced no JSON output (${jsonRun.stderr.trim()})`,
    );
    const text = humanRun.stdout;
    assert.doesNotThrow(
      () => JSON.parse(jsonRun.stdout),
      `${entry.name}: --json output is not valid JSON`,
    );
    assert.throws(
      () => JSON.parse(text),
      `${entry.name}: default output parsed as JSON, so it has no human rendering`,
    );
    const document = JSON.parse(jsonRun.stdout);

    for (const requirement of entry.required) {
      const value = resolvePointer(document, requirement.pointer);
      if (value === MISSING) {
        failures.push(`${entry.name} ${requirement.pointer}: absent from the JSON output`);
        continue;
      }
      const problem = presents(text, value, requirement);
      if (problem) failures.push(`${entry.name} ${requirement.pointer}: ${problem}`);
    }

    for (const omission of entry.jsonOnly) {
      const value = resolvePointer(document, omission.pointer);
      // A pointer that does not resolve carries no value to leak; the
      // declaration still documents the intent.
      if (value === MISSING || value === null || typeof value === "object") continue;
      const rendered = stringForm(value);
      if (rendered.length < 8) continue; // too short to match without coincidence
      if (text.includes(rendered)) {
        failures.push(
          `${entry.name} ${omission.pointer}: declared JSON-only but the human text now shows ` +
          `${JSON.stringify(rendered)}. Update docs/conformance/fixtures.json.`,
        );
      }
    }
  }
  assert.deepEqual(failures, [], `human/JSON parity failures:\n${failures.join("\n")}`);
});

test("commands declared JSON-only print JSON in both modes", { timeout: 600_000 }, () => {
  const state = scenario();
  for (const entry of fixtures.jsonOnlyCommands) {
    const argv = entry.argv.map((argument) => materialize(argument, state));
    const plain = vlabResult(state.repo, ...argv);
    assert.equal(plain.status, 0, `${argv.join(" ")}: ${plain.stderr.trim()}`);
    assert.doesNotThrow(
      () => JSON.parse(plain.stdout),
      `${argv.join(" ")} is declared JSON-only but printed human text; ` +
      "it now has a renderer and needs a parity fixture instead.",
    );
  }
});

test("commands declared text-only have no JSON output", { timeout: 600_000 }, () => {
  const state = scenario();
  for (const entry of fixtures.textOnlyCommands) {
    const argv = entry.argv.map((argument) => materialize(argument, state));
    const withFlag = vlabResult(state.repo, ...argv, "--json");
    assert.equal(withFlag.status, 0, `${argv.join(" ")}: ${withFlag.stderr.trim()}`);
    assert.throws(
      () => JSON.parse(withFlag.stdout),
      `${argv.join(" ")} is declared text-only but --json produced JSON; ` +
      "it now has a JSON contract and needs a parity fixture instead.",
    );
  }
});

test("the build identity is reachable from JSON", { timeout: 600_000 }, () => {
  const state = scenario();
  // `vlab version` is text-only, so a peer applying the compatibility rules of
  // ADR-0020 needs the build identity somewhere machine-readable.
  const doctor = JSON.parse(vlab(state.repo, "doctor"));
  const humanVersion = vlab(state.repo, "version");
  assert.ok(doctor.version, "vlab doctor must report the vcs-lab version");
  assert.ok(
    humanVersion.includes(doctor.version),
    `'vlab version' (${humanVersion}) and doctor.version (${doctor.version}) disagree`,
  );
});

test("declared failures report their published code", { timeout: 600_000 }, () => {
  // The failure half of FR-GIT-06 (ADR-0021). The success path has been pinned
  // field by field since phase 0b; until now the failure path had no contract
  // at all, so a refusal could change classification silently. These fixtures
  // pin the classification a caller branches on, not the prose.
  const state = scenario();
  const failures = [];
  for (const entry of fixtures.failureCommands) {
    const argv = entry.argv.map((argument) => materialize(argument, state));
    const run = vlabResult(state.repo, ...argv);
    if (run.status === 0) {
      failures.push(`${entry.name}: expected a refusal, got success`);
      continue;
    }
    if (run.stderr !== "") {
      failures.push(`${entry.name}: a --json refusal must leave stderr empty`);
    }
    let envelope;
    try {
      envelope = JSON.parse(run.stdout);
    } catch {
      failures.push(`${entry.name}: stdout was not an envelope: ${run.stdout.slice(0, 120)}`);
      continue;
    }
    if (envelope.schema !== "vcs-lab.error/v1") {
      failures.push(`${entry.name}: schema ${envelope.schema}`);
    }
    if (envelope.code !== entry.code) {
      failures.push(
        `${entry.name}: expected code '${entry.code}', got '${envelope.code}'. ` +
        "Update docs/conformance/fixtures.json only if the new classification is the better one.",
      );
    }
  }
  assert.deepEqual(failures, [], `failure-path conformance:\n${failures.join("\n")}`);
});
