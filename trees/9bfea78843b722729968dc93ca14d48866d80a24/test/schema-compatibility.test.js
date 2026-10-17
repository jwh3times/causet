import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { testEnv } from "../test-support/git-environment.js";
import { cstCommand, cstPrefix } from "../test-support/cst-command.js";
import { probe as modelProbe, registry } from "../test-support/model-probe.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The registries are the Rust record model's (`native/model`, the authority
// since #243), reached through its probe.
const {
  bounds: RESOURCE_BOUNDS,
  exchangeFeatures: EXCHANGE_FEATURES,
  exchangedScopes: EXCHANGED_SCOPES,
  legacyNamespace: LEGACY_SCHEMA_NAMESPACE,
  schemaNamespace: SCHEMA_NAMESPACE,
} = registry();
const RECORD_FAMILIES = new Map(registry().families.map(({ name, ...policy }) => [name, policy]));
const classify = (schemas) => modelProbe(schemas.map((schema) => ({ op: "classify", schema })));
const schemaCompatibility = (schema) => classify([schema])[0].compatibility;

const compatibilityDoc = fs.readFileSync(
  path.join(projectRoot, "docs", "schemas", "compatibility.md"),
  "utf8",
);

// ---------------------------------------------------------------------------
// Published document versus runtime registry
// ---------------------------------------------------------------------------

/** Rows of the first Markdown table that follows the given heading. */
function tableRows(heading) {
  const start = compatibilityDoc.indexOf(heading);
  assert.ok(start >= 0, `compatibility.md has no heading '${heading}'`);
  const lines = compatibilityDoc.slice(start).split("\n");
  const rows = [];
  let started = false;
  for (const line of lines) {
    if (!line.startsWith("|")) {
      if (started) break;
      continue;
    }
    started = true;
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    if (cells.every((cell) => /^-+$/.test(cell))) continue;
    rows.push(cells);
  }
  assert.ok(rows.length > 1, `no table found under '${heading}'`);
  return rows.slice(1);
}

function plain(cell) {
  return cell.replace(/`/g, "").trim();
}

function versionList(cell) {
  const value = plain(cell);
  if (value === "—" || value === "") return [];
  return value.split(",").map((item) => {
    const match = item.trim().match(/^v(\d+)$/);
    assert.ok(match, `'${item.trim()}' is not a version like 'v3'`);
    return Number(match[1]);
  });
}

test("the published family table matches the runtime compatibility registry", () => {
  const rows = tableRows("## 2. Version rules per family");
  const documented = new Map();
  for (const row of rows) {
    assert.equal(row.length, 6, `family row has ${row.length} cells: ${row.join(" | ")}`);
    const [family, scope, written, alsoRead, unknownVersion, store] = row;
    const name = plain(family);
    assert.ok(!documented.has(name), `family '${name}' is documented twice`);
    documented.set(name, {
      scope: plain(scope),
      written: versionList(written),
      alsoRead: versionList(alsoRead),
      unknownVersion: plain(unknownVersion),
      store: plain(store),
    });
  }

  assert.deepEqual(
    [...documented.keys()].sort(),
    [...RECORD_FAMILIES.keys()].sort(),
    "compatibility.md and RECORD_FAMILIES do not describe the same families",
  );

  for (const [family, policy] of RECORD_FAMILIES) {
    const row = documented.get(family);
    assert.equal(row.scope, policy.scope, `scope of '${family}'`);
    assert.equal(row.unknownVersion, policy.unknownVersion, `unknown-version rule of '${family}'`);
    assert.equal(row.store, policy.store, `store of '${family}'`);
    assert.deepEqual([...row.written].sort(), [...policy.written].sort(), `written versions of '${family}'`);
    assert.deepEqual(
      [...row.written, ...row.alsoRead].sort(),
      [...policy.readable].sort(),
      `readable versions of '${family}'`,
    );
    for (const version of policy.written) {
      assert.ok(policy.readable.includes(version), `'${family}' writes v${version} but does not read it`);
      assert.ok(
        policy.registered.includes(version),
        `'${family}' writes v${version} but it is not in the runtime registry`,
      );
    }
    assert.ok(
      ["quarantine", "refuse", "ignore"].includes(policy.unknownVersion),
      `'${family}' has unsupported unknown-version rule '${policy.unknownVersion}'`,
    );
  }
});

test("the published bounds table matches the runtime resource bounds", () => {
  const rows = tableRows("| Bound | Bytes or count |");
  const documented = new Map();
  for (const row of rows) {
    assert.equal(row.length, 4, `bound row has ${row.length} cells: ${row.join(" | ")}`);
    documented.set(plain(row[0]), Number(plain(row[1])));
  }
  assert.deepEqual(
    [...documented.keys()].sort(),
    Object.keys(RESOURCE_BOUNDS).sort(),
    "compatibility.md and RESOURCE_BOUNDS do not describe the same bounds",
  );
  for (const [name, value] of documented) {
    assert.equal(value, RESOURCE_BOUNDS[name], `documented value of '${name}'`);
    assert.ok(Number.isSafeInteger(RESOURCE_BOUNDS[name]), `'${name}' must be a safe integer`);
    assert.ok(RESOURCE_BOUNDS[name] > 0, `'${name}' must be positive`);
  }
});

// ---------------------------------------------------------------------------
// The capability document is a projection, not a second list
// ---------------------------------------------------------------------------

test("the advertised document equals the registries it projects", () => {
  // ADR-0033 requires this direction specifically: a registry change that is
  // not advertised must fail the suite, because a peer negotiating from a stale
  // document would conclude something this build will not honour.
  const document = buildCapabilities();

  const advertised = new Map(document.families.map((entry) => [entry.family, entry]));
  const exchanged = [...RECORD_FAMILIES].filter(([, policy]) =>
    EXCHANGED_SCOPES.includes(policy.scope));
  assert.deepEqual(
    [...advertised.keys()].sort(),
    exchanged.map(([family]) => family).sort(),
    "every exchanged family is advertised, and nothing else is",
  );
  for (const [family, policy] of exchanged) {
    const entry = advertised.get(family);
    assert.equal(entry.scope, policy.scope, `scope of '${family}'`);
    assert.equal(entry.unknownVersion, policy.unknownVersion, `unknown-version rule of '${family}'`);
    assert.deepEqual(entry.written, [...policy.written].sort((a, b) => a - b), `written of '${family}'`);
    assert.deepEqual(entry.readable, [...policy.readable].sort((a, b) => a - b), `readable of '${family}'`);
  }

  // A family whose records never leave this machine is not a peer's business.
  for (const [family, policy] of RECORD_FAMILIES) {
    if (EXCHANGED_SCOPES.includes(policy.scope)) continue;
    assert.equal(advertised.has(family), false,
      `'${family}' is ${policy.scope} and must not be advertised`);
  }

  assert.deepEqual(document.features, [...EXCHANGE_FEATURES].sort());
  for (const [name, value] of Object.entries(document.bounds)) {
    assert.equal(value, RESOURCE_BOUNDS[name], `advertised value of '${name}'`);
  }
});

test("every resource bound is either advertised or deliberately not", () => {
  // The partition is what stops a new bound from being added without deciding
  // whether a peer needs it: the build advertises some, and compatibility.md
  // gives the reason for each of the others.
  const advertised = Object.keys(buildCapabilities().bounds);
  const unadvertised = new Map(tableRows("| Unadvertised bound | Why a peer does not need it |")
    .map(([name, reason]) => [plain(name), reason]));
  const decided = [...advertised, ...unadvertised.keys()].sort();
  assert.deepEqual(decided, Object.keys(RESOURCE_BOUNDS).sort(),
    "the advertised bounds and compatibility.md's unadvertised ones must together name every bound");
  assert.deepEqual(
    advertised.filter((name) => unadvertised.has(name)),
    [],
    "a bound cannot be both advertised and not",
  );
  for (const [name, reason] of unadvertised) {
    assert.ok(reason.split(/\s+/).length >= 6,
      `'${name}' must say why a peer does not need it`);
  }
});

// ---------------------------------------------------------------------------
// Disposition rules
// ---------------------------------------------------------------------------

test("every family resolves its own versions and disposes of the rest by scope", () => {
  for (const [family, policy] of RECORD_FAMILIES) {
    for (const version of policy.written) {
      assert.equal(
        schemaCompatibility(`${family}/v${version}`).disposition,
        "accept",
        `${family}/v${version} is written and must be accepted`,
      );
    }
    for (const version of policy.readable.filter((item) => !policy.written.includes(item))) {
      assert.equal(
        schemaCompatibility(`${family}/v${version}`).disposition,
        "migrate",
        `${family}/v${version} is read but not written, so it migrates forward`,
      );
    }
    const future = Math.max(...policy.readable) + 1;
    assert.equal(
      schemaCompatibility(`${family}/v${future}`).disposition,
      policy.unknownVersion,
      `an unread ${family}/v${future} follows the family rule`,
    );
  }
});

test("an unregistered family and a malformed identifier are never readable", () => {
  for (const schema of ["causet.not-a-family/v1", "causet.landing", "", null, 7]) {
    const compatibility = schemaCompatibility(schema);
    assert.equal(compatibility.readable, false, `'${String(schema)}' must not be readable`);
    assert.equal(compatibility.disposition, "unknown-family", `'${String(schema)}' disposition`);
  }
});

test("the legacy spelling of every family resolves exactly as the family does (ADR-0039 §2)", () => {
  for (const [family, policy] of RECORD_FAMILIES) {
    assert.ok(family.startsWith(SCHEMA_NAMESPACE), `${family} is not a causet.* family`);
    const legacyFamily = `${LEGACY_SCHEMA_NAMESPACE}${family.slice(SCHEMA_NAMESPACE.length)}`;
    for (const version of [...policy.registered, Math.max(...policy.registered) + 1]) {
      const current = `${family}/v${version}`;
      const legacy = `${legacyFamily}/v${version}`;
      const [legacyReply, currentReply] = classify([legacy, current]);
      assert.deepEqual(legacyReply.compatibility, currentReply.compatibility, legacy);
      assert.deepEqual(
        { ...legacyReply.classification, legacyName: false },
        currentReply.classification,
        legacy,
      );
      assert.equal(legacyReply.classification.legacyName, true);
    }
  }
  // Only the namespace is aliased: a near miss is no family at all.
  for (const [other, reply] of [["vcs-labs.landing/v1", "xvcs-lab.landing/v1", "causet"]]
    .flat().map((schema) => [schema, classify([schema])[0]])) {
    assert.equal(reply.classification.known, false, other);
    assert.equal(reply.classification.legacyName, false, other);
  }
});

test("no writer emits a legacy vcs-lab.* identifier (ADR-0039 §2)", () => {
  // The Rust sources outside their unit tests and the probe and fuzzing
  // executables under `src/bin`, which write nothing a repository keeps.
  const offenders = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) { if (entry.name !== "bin") walk(full); continue; }
      if (!entry.name.endsWith(".rs")) continue;
      const text = fs.readFileSync(full, "utf8").split("#[cfg(test)]")[0];
      for (const match of text.matchAll(/\bvcs-lab\.[a-z][a-z-]*/g)) {
        offenders.push(`${path.relative(projectRoot, full)}: ${match[0]}`);
      }
    }
  };
  for (const directory of ["native/cli/src", "native/engine/src", "native/model/src"]) {
    walk(path.join(projectRoot, directory));
  }
  assert.deepEqual(offenders, []);
});

// ---------------------------------------------------------------------------
// Live behavior against the real CLI
// ---------------------------------------------------------------------------

function exec(command, args, cwd) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    env: testEnv(),
  }).trim();
}

function git(cwd, ...args) {
  return exec("git", args, cwd);
}

function vlabResult(cwd, ...args) {
  return spawnSync(cstCommand, [...cstPrefix(), ...args], {
    cwd,
    encoding: "utf8",
    env: testEnv(),
  });
}

function repository(t) {
  const parent = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "vcs-lab-compatibility-")));
  const repo = path.join(parent, "repo");
  fs.mkdirSync(repo);
  git(repo, "init", "-b", "main");
  git(repo, "config", "core.autocrlf", "false");
  git(repo, "config", "core.eol", "lf");
  git(repo, "config", "user.name", "VCS Lab Compatibility Test");
  git(repo, "config", "user.email", "vcs-lab-compatibility@example.invalid");
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
  exec(cstCommand, [...cstPrefix(), "init"], repo);
  git(repo, "add", "-A");
  exec(cstCommand, [...cstPrefix(), "commit", "-m", "base"], repo);
  return repo;
}

/** The build-scoped capability document, outside any repository. */
function buildCapabilities() {
  const outside = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "vcs-lab-compatibility-outside-")));
  try {
    return JSON.parse(exec(cstCommand, [...cstPrefix(), "capabilities", "--json"], outside));
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
}

/**
 * Commit with declared provenance, after a `post-commit` hook has put `note`
 * on the new commit: the provenance record must then be appended to a
 * container causet did not write. Returns the commit and the CLI's result.
 */
function commitOnto(repo, note) {
  const noteFile = path.join(path.dirname(repo), "planted-note.json");
  fs.writeFileSync(noteFile, note);
  const hook = path.join(repo, ".git", "hooks", "post-commit");
  fs.mkdirSync(path.dirname(hook), { recursive: true });
  fs.writeFileSync(hook, `#!/bin/sh\ngit notes --ref=causet add -f -F "${noteFile.replaceAll("\\", "/")}" HEAD\n`);
  fs.chmodSync(hook, 0o755);
  fs.appendFileSync(path.join(repo, "a.txt"), "more\n");
  git(repo, "add", "-A");
  const result = vlabResult(repo, "commit", "-m", "planted", "--authored-by", "compatibility-test", "--json");
  fs.rmSync(hook);
  return { commit: git(repo, "rev-parse", "HEAD"), result };
}

function labDir(repo) {
  return path.join(repo, ".git", "causet");
}

test("a journal this build cannot read is refused rather than resumed", (t) => {
  const repo = repository(t);
  fs.mkdirSync(labDir(repo), { recursive: true });
  const journal = path.join(labDir(repo), "reconciliation.json");
  fs.writeFileSync(journal, `${JSON.stringify({
    schema: "causet.reconciliation-operation/v99",
    id: "op_future",
    state: "conflicted",
    queue: [],
    nextIndex: 0,
  }, null, 2)}\n`);

  const status = vlabResult(repo, "reconcile", "--status", "--json");
  assert.notEqual(status.status, 0, "a future journal version must not be resumed");
  // Under --json the refusal is the ADR-0021 envelope, so the disposition is
  // readable as a code rather than only as prose. Both are checked: the code is
  // what automation branches on, the message is what a person acts on.
  const refusedJournal = JSON.parse(status.stdout);
  assert.equal(refusedJournal.code, "unknown-schema-version");
  assert.match(refusedJournal.message, /unsupported schema "causet\.reconciliation-operation\/v99"/);
  assert.match(refusedJournal.details, /reads v4 of that family/);

  // Refusing must not consume or rewrite the journal.
  assert.equal(
    fs.readFileSync(journal, "utf8"),
    `${JSON.stringify({
      schema: "causet.reconciliation-operation/v99",
      id: "op_future",
      state: "conflicted",
      queue: [],
      nextIndex: 0,
    }, null, 2)}\n`,
    "the refused journal must be left byte-for-byte intact",
  );

  // A journal of the wrong family in the right file is refused too.
  fs.writeFileSync(journal, `${JSON.stringify({
    schema: "causet.rebase-operation/v1",
    id: "op_wrong",
  }, null, 2)}\n`);
  const crossed = vlabResult(repo, "reconcile", "--status", "--json");
  assert.notEqual(crossed.status, 0);
  const crossedRefusal = JSON.parse(crossed.stdout);
  assert.equal(crossedRefusal.code, "wrong-record-family");
  assert.match(crossedRefusal.message, /not a causet\.reconciliation-operation record/);
});

test("a workspace registry this build cannot read is refused rather than rewritten", (t) => {
  const repo = repository(t);
  const registry = path.join(labDir(repo), "workspaces.json");
  const body = `${JSON.stringify({
    schema: "causet.workspaces/v2",
    workspaces: [{ schema: "causet.workspace/v2", id: "ws_future", name: "future" }],
  }, null, 2)}\n`;
  fs.mkdirSync(path.dirname(registry), { recursive: true });
  fs.writeFileSync(registry, body);

  const list = vlabResult(repo, "workspace", "list", "--json");
  assert.notEqual(list.status, 0, "a future registry version must not be consumed");
  const refusedRegistry = JSON.parse(list.stdout);
  assert.equal(refusedRegistry.code, "unknown-schema-version");
  assert.match(refusedRegistry.message, /unsupported schema "causet\.workspaces\/v2"/);
  assert.equal(fs.readFileSync(registry, "utf8"), body, "the registry must be left intact");
});

test("a malformed local state file is refused as a domain error naming the file", (t) => {
  const repo = repository(t);
  const registry = path.join(labDir(repo), "workspaces.json");
  fs.mkdirSync(path.dirname(registry), { recursive: true });
  fs.writeFileSync(registry, "{ not json\n");
  const list = vlabResult(repo, "workspace", "list", "--json");
  assert.notEqual(list.status, 0);
  const malformed = JSON.parse(list.stdout);
  assert.equal(malformed.code, "malformed-input");
  assert.match(malformed.message, /is not valid JSON/);
  assert.match(malformed.message, /workspaces\.json/, "the message still names the file");
});

test("a forecast version this build cannot read is refused with a version-aware message", (t) => {
  const repo = repository(t);
  const forecasts = path.join(labDir(repo), "forecasts");
  fs.mkdirSync(forecasts, { recursive: true });
  const id = "forecast_future1";
  fs.writeFileSync(
    path.join(forecasts, `${id}.json`),
    `${JSON.stringify({ schema: "causet.forecast/v9", id, steps: 42 }, null, 2)}\n`,
  );
  git(repo, "switch", "-c", "source");
  fs.writeFileSync(path.join(repo, "source.txt"), "source\n");
  git(repo, "add", "-A");
  exec(cstCommand, [...cstPrefix(), "commit", "-m", "source"], repo);
  git(repo, "switch", "main");
  const future = vlabResult(repo, "reconcile", "source", "--use-forecast", id, "--json");
  assert.equal(future.status, 1);
  const refused = JSON.parse(future.stdout);
  assert.equal(refused.code, "unknown-schema-version");
  assert.match(refused.message, /unsupported schema "causet\.forecast\/v9"/);
  assert.match(refused.details, /reads v1, v2 of that family/);

  // The superseded but still readable v1 passes the schema gate and fails
  // later, on the staleness check, rather than on its version.
  const legacy = "forecast_legacy1";
  fs.writeFileSync(
    path.join(forecasts, `${legacy}.json`),
    `${JSON.stringify({ schema: "causet.forecast/v1", id: legacy }, null, 2)}\n`,
  );
  const superseded = vlabResult(repo, "reconcile", "source", "--use-forecast", legacy, "--json");
  assert.equal(superseded.status, 1);
  const stale = JSON.parse(superseded.stdout);
  assert.equal(stale.code, "stale-forecast");
  assert.doesNotMatch(stale.message, /unsupported schema/);
  assert.equal(git(repo, "status", "--porcelain"), "", "neither refusal starts a reconciliation");
});

test("publishing a receipt never overwrites a note container this build cannot read", (t) => {
  const repo = repository(t);
  const foreign = `${JSON.stringify({
    schema: "causet.note/v2",
    records: [{ schema: "causet.landing/v9", type: "landing", id: "rec_future" }],
  }, null, 2)}\n`;
  const { commit, result } = commitOnto(repo, foreign);

  // The commit stands, its provenance is refused, and the peer's bytes survive.
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const refusal = JSON.parse(result.stdout);
  assert.equal(refusal.code, "wrong-record-family");
  assert.match(refusal.details, /is not a causet\.note\/v1 container/);
  assert.equal(
    git(repo, "notes", "--ref=causet", "show", commit),
    foreign.trim(),
    "the peer's note must be byte-for-byte intact after the refusal",
  );
  // And it yields no records to a reader.
  const status = JSON.parse(vlabResult(repo, "metadata", "status", "--json").stdout);
  assert.equal(status.scopes.sharedPortable.notes.records.some((record) => record.commit === commit), false,
    "a foreign container must yield no records");
});

test("an oversize note is quarantined unparsed and reported by metadata status", (t) => {
  const repo = repository(t);
  const filler = "x".repeat(RESOURCE_BOUNDS.noteContainerBytes);
  const oversizeNote = `${JSON.stringify({ schema: "causet.note/v1", records: [], filler })}\n`;
  const { commit, result } = commitOnto(repo, oversizeNote);

  assert.equal(result.status, 1, result.stdout + result.stderr);
  const refusal = JSON.parse(result.stdout);
  assert.equal(refusal.code, "resource-bound-exceeded");
  assert.match(refusal.details, /exceeds a published note-container resource bound/);
  const noteBlob = git(repo, "notes", "--ref=causet", "list", commit);
  assert.equal(Number(git(repo, "cat-file", "-s", noteBlob)), oversizeNote.length,
    "the oversize note must be left as it was");

  const status = vlabResult(repo, "metadata", "status", "--json");
  assert.equal(status.status, 0, "an oversize peer note must not fail the command");
  const report = JSON.parse(status.stdout);
  const oversize = report.diagnostics.filter((entry) => entry.code === "oversize-record");
  assert.equal(oversize.length, 1, "metadata status must report the oversize note once");
  assert.equal(oversize[0].severity, "warning");
  assert.equal(oversize[0].scope, "shared-portable");
  assert.match(oversize[0].message, /noteContainerBytes/);
  assert.equal(report.scopes.sharedPortable.notes.records.some((record) => record.commit === commit), false,
    "an oversize note must not be parsed");
});
