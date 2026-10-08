import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import "../test-support/git-environment.js";
import { moduleTable, replaceTable, schemaTable, syncArchitecture } from "../scripts/sync-architecture.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vcs-lab-architecture-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const subdirectory of ["bin", "src", "docs"]) fs.mkdirSync(path.join(directory, subdirectory));
  fs.writeFileSync(path.join(directory, "src/example.js"), "");
  fs.writeFileSync(path.join(directory, "docs/architecture-modules.json"), JSON.stringify({
    "src/example.js": { responsibility: "Example behavior", dependencies: "None" },
  }));
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

test("added nested modules and removed modules require an updated description catalog", (t) => {
  const directory = fixture(t);
  fs.mkdirSync(path.join(directory, "src/nested"));
  const added = path.join(directory, "src/nested/new.js");
  fs.writeFileSync(added, "");
  assert.throws(() => moduleTable(directory), /missing: src\/nested\/new.js/);
  fs.unlinkSync(added);
  fs.unlinkSync(path.join(directory, "src/example.js"));
  assert.throws(() => moduleTable(directory), /stale: src\/example.js/);
});

test("schema table exposes readable legacy versions separately from writer versions", () => {
  const table = schemaTable(new Map([["example", {
    readable: [1, 2], written: [2], store: "<git dir>/example.json", scope: "private",
  }]]));
  assert.ok(table.includes("| `example` | v1, v2 | v2 | `<git dir>/example.json` | `private` |"));
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
