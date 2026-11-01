import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import "../test-support/git-environment.js";
import { moduleTable, recordFamilies, replaceTable, schemaTable, syncArchitecture } from "../scripts/sync-architecture.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

const REGISTRY = `//! The registries.
pub const RECORD_FAMILIES: &[Family] = &[
  Family {
    name: "causet.example",
    scope: "worktree-private",
    registered: &[1, 2],
    readable: &[1, 2],
    written: &[2],
    unknown_version: "refuse",
    store: "<git dir>/example.json",
  },
];
`;

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vcs-lab-architecture-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const subdirectory of ["native/cli/src", "native/model/src", "docs"]) {
    fs.mkdirSync(path.join(directory, subdirectory), { recursive: true });
  }
  fs.writeFileSync(path.join(directory, "native/cli/src/example.rs"),
    "//! Example behavior, said once. Then more.\nuse crate::store;\nuse causet_model::json;\n");
  fs.writeFileSync(path.join(directory, "native/model/src/registry.rs"), REGISTRY);
  fs.writeFileSync(path.join(directory, "docs/architecture.md"),
    "Before\n<!-- generated:modules:start -->\nstale\n<!-- generated:modules:end -->\nBetween\n"
    + "<!-- generated:schemas:start -->\nstale\n<!-- generated:schemas:end -->\nAfter\n");
  return directory;
}

test("architecture tables agree with every source module and registered persisted family", () => {
  assert.equal(syncArchitecture(root, true), false);
});

test("regeneration repairs drift without changing prose and check mode never writes", (t) => {
  const directory = fixture(t);
  const file = path.join(directory, "docs/architecture.md");
  const original = fs.readFileSync(file, "utf8").replaceAll("\n", "\r\n");
  fs.writeFileSync(file, original);
  assert.throws(() => syncArchitecture(directory, true), /tables are stale/);
  assert.equal(fs.readFileSync(file, "utf8"), original);
  assert.equal(syncArchitecture(directory), true);
  const updated = fs.readFileSync(file, "utf8");
  assert.ok(updated.startsWith("Before\r\n"));
  assert.ok(updated.includes("\r\nBetween\r\n"));
  assert.ok(updated.endsWith("\r\nAfter\r\n"));
  assert.doesNotMatch(updated, /(?<!\r)\n/);
  assert.equal(syncArchitecture(directory, true), false);
  assert.equal(syncArchitecture(directory), false);
});

test("every module is described by its own header, with what it uses", (t) => {
  const directory = fixture(t);
  assert.ok(moduleTable(directory).includes(
    "| `native/cli/src/example.rs` | Example behavior, said once. | `store`, causet-model |"));
  // A nested module appears, and one without a header refuses the table.
  fs.mkdirSync(path.join(directory, "native/cli/src/bin"));
  fs.writeFileSync(path.join(directory, "native/cli/src/bin/probe.rs"), "fn main() {}\n");
  assert.throws(() => moduleTable(directory), /native\/cli\/src\/bin\/probe.rs has no header comment/);
});

test("schema table exposes readable legacy versions separately from writer versions", (t) => {
  const families = recordFamilies(fixture(t));
  assert.deepEqual([...families.keys()], ["causet.example"]);
  const table = schemaTable(families);
  assert.ok(table.includes("| `causet.example` | v1, v2 | v2 | `<git dir>/example.json` | `worktree-private` |"));
});

test("missing, duplicate, or reversed markers refuse regeneration before writing", (t) => {
  const directory = fixture(t);
  const file = path.join(directory, "docs/architecture.md");
  const original = fs.readFileSync(file, "utf8").replace("<!-- generated:schemas:end -->", "");
  fs.writeFileSync(file, original);
  assert.throws(() => syncArchitecture(directory), /marker pair/);
  assert.equal(fs.readFileSync(file, "utf8"), original);
  for (const document of [
    "<!-- generated:modules:start --><!-- generated:modules:start --><!-- generated:modules:end -->",
    "<!-- generated:modules:end --><!-- generated:modules:start -->",
  ]) assert.throws(() => replaceTable(document, "modules", "replacement"), /marker pair/);
});
