import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import "../test-support/git-environment.js";
import { runMarkdownCase } from "../test-support/semantic-conformance.js";

const fixtureFile = fileURLToPath(new URL("../docs/semantic-conformance/fixtures.json", import.meta.url));
const catalog = JSON.parse(fs.readFileSync(fixtureFile, "utf8"));
const adapters = { "markdown-v1": runMarkdownCase, "markdown-v2": runMarkdownCase };

function expectation(entry) {
  return {
    entities: Object.fromEntries(["base", "ours", "theirs"].map((stage) => [stage, entry.stages[stage].entities])),
    plan: entry.expected,
  };
}

function validateCatalog(value) {
  assert.equal(value.schema, "vcs-lab.semantic-conformance-fixtures/v1");
  assert.ok(value.cases.length > 0);
  assert.deepEqual(Object.keys(value.profiles).sort(), Object.keys(adapters).sort(), "every profile has a runner and vice versa");
  assert.equal(new Set(value.cases.map((entry) => entry.id)).size, value.cases.length);
  assert.equal(new Set(value.coverage).size, value.coverage.length);
  for (const profile of Object.keys(value.profiles)) {
    assert.deepEqual([...new Set(value.cases.filter((entry) => entry.profile === profile).map((entry) => entry.rule))].sort(),
      [...value.coverage, ...value.profiles[profile].coverage].sort(),
      `${profile}: every declared rule has fixtures, with no undeclared rules`);
  }
  for (const entry of value.cases) {
    assert.ok(adapters[entry.profile], `${entry.id}: unknown profile`);
    assert.match(entry.id, /^[a-z0-9-]+$/);
    assert.deepEqual(Object.keys(entry.stages).sort(), ["base", "ours", "theirs"]);
    for (const input of Object.values(entry.stages)) {
      assert.ok(typeof input.text === "string" || input.text === null);
      assert.ok(Array.isArray(input.entities));
      assert.ok(input.entities.every((key) => typeof key === "string"));
    }
    assert.deepEqual(Object.keys(entry.expected).sort(), ["conflicts", "counts", "decisions", "ordering", "result", "status"]);
    assert.ok(["clean", "blocked"].includes(entry.expected.status));
    assert.equal(entry.expected.result === null, entry.expected.status === "blocked");
    assert.ok(entry.rule.length > 0);
    if (entry.knownFailure) {
      assert.equal(entry.knownFailure.issue, "https://github.com/jwh3times/vcs-lab/issues/51");
      assert.ok(entry.knownFailure.reason.length > 0);
      assert.deepEqual(Object.keys(entry.knownFailure.desired).sort(), ["entities", "plan"]);
      assert.notDeepEqual(expectation(entry), entry.knownFailure.desired,
        `${entry.id}: a resolved defect must leave the known-failure list`);
    }
  }
}

test("semantic conformance has a versioned fixture catalog with unique cases", () => {
  validateCatalog(catalog);
});

test("fixture omissions, orphan profiles, and resolved known failures cannot silently pass", () => {
  const missing = structuredClone(catalog);
  missing.cases = missing.cases.filter((entry) => entry.rule !== "identical edits");
  assert.throws(() => validateCatalog(missing), /every declared rule/);
  const orphan = structuredClone(catalog);
  orphan.profiles.orphan = orphan.profiles["markdown-v1"];
  assert.throws(() => validateCatalog(orphan), /every profile has a runner/);
  const resolved = structuredClone(catalog);
  const defect = resolved.cases.find((entry) => entry.knownFailure);
  defect.knownFailure.desired = expectation(defect);
  assert.throws(() => validateCatalog(resolved), /resolved defect/);
});

for (const entry of catalog.cases) {
  test(`${entry.profile}: ${entry.id}${entry.knownFailure ? " (historical boundaries; migration required)" : ""}`, (t) => {
    const actual = adapters[entry.profile](t, entry, catalog.profiles[entry.profile]);
    assert.deepEqual(actual, expectation(entry));
    if (entry.knownFailure) {
      assert.notDeepEqual(actual, entry.knownFailure.desired, "a fix requires an explicit fixture/version update");
    }
  });
}
