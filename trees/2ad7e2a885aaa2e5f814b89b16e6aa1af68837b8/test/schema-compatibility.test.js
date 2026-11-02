import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  RECORD_FAMILIES,
  RESOURCE_BOUNDS,
  schemaCompatibility,
  withinBound,
} from "../src/schemas.js";
import { appendNote, readNote } from "../src/notes.js";
import { forecastForPlan } from "../src/forecasts.js";
import { testEnv } from "../test-support/git-environment.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(projectRoot, "bin", "vlab.js");

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
  for (const schema of ["vcs-lab.not-a-family/v1", "vcs-lab.landing", "", null, undefined, 7]) {
    const compatibility = schemaCompatibility(schema);
    assert.equal(compatibility.readable, false, `'${String(schema)}' must not be readable`);
    assert.equal(compatibility.disposition, "unknown-family", `'${String(schema)}' disposition`);
  }
});

test("bounds are checked at the boundary and an unknown bound name throws", () => {
  assert.equal(withinBound("noteContainerRecords", RESOURCE_BOUNDS.noteContainerRecords), true);
  assert.equal(withinBound("noteContainerRecords", RESOURCE_BOUNDS.noteContainerRecords + 1), false);
  assert.throws(() => withinBound("noSuchBound", 0), /Unknown resource bound/);
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
  return spawnSync(process.execPath, [cli, ...args], {
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
  exec(process.execPath, [cli, "init"], repo);
  git(repo, "add", "-A");
  exec(process.execPath, [cli, "commit", "-m", "base"], repo);
  return repo;
}

function labDir(repo) {
  return path.join(repo, ".git", "vcs-lab");
}

test("a journal this build cannot read is refused rather than resumed", (t) => {
  const repo = repository(t);
  fs.mkdirSync(labDir(repo), { recursive: true });
  const journal = path.join(labDir(repo), "reconciliation.json");
  fs.writeFileSync(journal, `${JSON.stringify({
    schema: "vcs-lab.reconciliation-operation/v99",
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
  assert.match(refusedJournal.message, /unsupported schema "vcs-lab\.reconciliation-operation\/v99"/);
  assert.match(refusedJournal.details, /reads v4 of that family/);

  // Refusing must not consume or rewrite the journal.
  assert.equal(
    fs.readFileSync(journal, "utf8"),
    `${JSON.stringify({
      schema: "vcs-lab.reconciliation-operation/v99",
      id: "op_future",
      state: "conflicted",
      queue: [],
      nextIndex: 0,
    }, null, 2)}\n`,
    "the refused journal must be left byte-for-byte intact",
  );

  // A journal of the wrong family in the right file is refused too.
  fs.writeFileSync(journal, `${JSON.stringify({
    schema: "vcs-lab.rebase-operation/v1",
    id: "op_wrong",
  }, null, 2)}\n`);
  const crossed = vlabResult(repo, "reconcile", "--status", "--json");
  assert.notEqual(crossed.status, 0);
  const crossedRefusal = JSON.parse(crossed.stdout);
  assert.equal(crossedRefusal.code, "wrong-record-family");
  assert.match(crossedRefusal.message, /not a vcs-lab\.reconciliation-operation record/);
});

test("a workspace registry this build cannot read is refused rather than rewritten", (t) => {
  const repo = repository(t);
  const registry = path.join(labDir(repo), "workspaces.json");
  const body = `${JSON.stringify({
    schema: "vcs-lab.workspaces/v2",
    workspaces: [{ schema: "vcs-lab.workspace/v2", id: "ws_future", name: "future" }],
  }, null, 2)}\n`;
  fs.mkdirSync(path.dirname(registry), { recursive: true });
  fs.writeFileSync(registry, body);

  const list = vlabResult(repo, "workspace", "list", "--json");
  assert.notEqual(list.status, 0, "a future registry version must not be consumed");
  const refusedRegistry = JSON.parse(list.stdout);
  assert.equal(refusedRegistry.code, "unknown-schema-version");
  assert.match(refusedRegistry.message, /unsupported schema "vcs-lab\.workspaces\/v2"/);
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
    `${JSON.stringify({ schema: "vcs-lab.forecast/v9", id }, null, 2)}\n`,
  );
  assert.throws(
    () => forecastForPlan(id, {}, repo),
    (error) => {
      assert.match(error.message, /unsupported schema "vcs-lab\.forecast\/v9"/);
      assert.match(error.details, /reads v1, v2 of that family/);
      return true;
    },
  );

  // The superseded but still readable v1 passes the schema gate and fails
  // later, on the staleness check, rather than on its version.
  const legacy = "forecast_legacy1";
  fs.writeFileSync(
    path.join(forecasts, `${legacy}.json`),
    `${JSON.stringify({ schema: "vcs-lab.forecast/v1", id: legacy }, null, 2)}\n`,
  );
  assert.throws(
    () => forecastForPlan(legacy, { targetHead: "x", sourceHead: "y", changes: [] }, repo),
    (error) => {
      assert.doesNotMatch(error.message, /unsupported schema/);
      return true;
    },
  );
});

test("publishing a receipt never overwrites a note container this build cannot read", (t) => {
  const repo = repository(t);
  const head = git(repo, "rev-parse", "HEAD");
  const foreign = `${JSON.stringify({
    schema: "vcs-lab.note/v2",
    records: [{ schema: "vcs-lab.landing/v9", type: "landing", id: "rec_future" }],
  }, null, 2)}\n`;
  execFileSync("git", ["notes", "--ref=vcs-lab", "add", "-f", "-F", "-", head], {
    cwd: repo,
    input: foreign,
    encoding: "utf8",
    env: testEnv(),
  });

  // The container yields no records, and its bytes survive a refused append.
  assert.deepEqual(readNote(head, repo).records, [], "a foreign container must yield no records");
  assert.throws(
    () => appendNote(head, { schema: "vcs-lab.landing/v1", type: "landing", id: "rec_new" }, repo),
    /is not a vcs-lab\.note\/v1 container/,
  );
  assert.equal(
    git(repo, "notes", "--ref=vcs-lab", "show", head),
    foreign.trim(),
    "the peer's note must be byte-for-byte intact after the refusal",
  );
});

test("an oversize note is quarantined unparsed and reported by metadata status", (t) => {
  const repo = repository(t);
  const head = git(repo, "rev-parse", "HEAD");
  const filler = "x".repeat(RESOURCE_BOUNDS.noteContainerBytes);
  execFileSync("git", ["notes", "--ref=vcs-lab", "add", "-f", "-F", "-", head], {
    cwd: repo,
    input: `${JSON.stringify({ schema: "vcs-lab.note/v1", records: [], filler })}\n`,
    encoding: "utf8",
    env: testEnv(),
  });

  assert.deepEqual(readNote(head, repo).records, [], "an oversize note must not be parsed");

  const status = vlabResult(repo, "metadata", "status", "--json");
  assert.equal(status.status, 0, "an oversize peer note must not fail the command");
  const report = JSON.parse(status.stdout);
  const oversize = report.diagnostics.filter((entry) => entry.code === "oversize-record");
  assert.equal(oversize.length, 1, "metadata status must report the oversize note once");
  assert.equal(oversize[0].severity, "warning");
  assert.equal(oversize[0].scope, "shared-portable");
  assert.match(oversize[0].message, /noteContainerBytes/);

  assert.throws(
    () => appendNote(head, { schema: "vcs-lab.landing/v1", type: "landing", id: "rec_new" }, repo),
    /exceeds a published note-container resource bound/,
  );
});
