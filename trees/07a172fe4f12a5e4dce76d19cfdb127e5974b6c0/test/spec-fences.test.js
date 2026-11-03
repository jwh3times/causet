import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { testEnv } from "../test-support/git-environment.js";
import { materializeResolutionCandidate } from "../src/resolutions.js";

const cli = fileURLToPath(new URL("../bin/vlab.js", import.meta.url));

function assertRefusal(action, code) {
  assert.throws(action, (error) => {
    assert.equal(JSON.parse(error.stdout).code, code);
    return true;
  });
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vcs-lab-fences-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const run = (command, args) => execFileSync(command, args, {
    cwd: root, env: testEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  const git = (...args) => run("git", args);
  const vlab = (...args) => {
    const output = run(process.execPath, [cli, ...args, "--json"]);
    return args[0] === "init" ? output : JSON.parse(output);
  };
  git("init", "-b", "main");
  git("config", "user.name", "Fence fixture");
  git("config", "user.email", "fences@example.invalid");
  git("config", "core.autocrlf", "false");
  const source = path.join(root, "spec.md");
  const manifestFile = path.join(root, ".vcs-lab/specs/spec.md.json");
  const stored = () => JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  const save = (value) => fs.writeFileSync(manifestFile, `${JSON.stringify(value)}\n`);
  const index = (text) => {
    if (text !== undefined) fs.writeFileSync(source, text);
    return vlab("spec", "index", "spec.md");
  };
  const legacy = () => {
    const value = stored();
    value.schema = "vcs-lab.spec-manifest/v3";
    value.parser = "stable-markdown-blocks/v1";
    value.idOverrides = {};
    save(value);
    return vlab("spec", "show", "spec.md").manifest;
  };
  const commit = () => {
    git("add", "-A");
    git("commit", "--allow-empty", "-m", "fixture");
    return git("rev-parse", "HEAD");
  };
  const human = (...args) => run(process.execPath, [cli, ...args]);
  return { root, git, vlab, human, source, manifestFile, stored, save, index, legacy, commit };
}

test("fenced headings and declarations are literal in newly indexed documents", (t) => {
  const f = fixture(t);
  const text = "# Real\r\n\r\n```python\r\n# Example\r\nREQ-X: example\r\n```\r\n";
  const result = f.index(text);
  assert.equal(result.manifest.schema, "vcs-lab.spec-manifest/v4");
  assert.deepEqual(result.manifest.blocks.map((block) => block.semanticKey), ["section:1:real:1"]);
  assert.equal(fs.readFileSync(f.source, "utf8"), text);
});

test("migration preserves real duplicate identities instead of recycling example IDs", (t) => {
  const f = fixture(t);
  f.index("```\n# Topic\nREQ-X: example\n```\n# Topic\nREQ-X: real\n");
  const old = f.legacy();
  const before = fs.readFileSync(f.source, "utf8");
  const result = f.index();
  assert.equal(result.migratedFrom, "vcs-lab.spec-manifest/v3");
  for (const kind of ["section", "requirement"]) {
    const previous = old.blocks.filter((block) => block.kind === kind);
    const current = result.manifest.blocks.find((block) => block.kind === kind);
    assert.equal(current.id, previous[1].id);
    assert.notEqual(current.id, previous[0].id);
  }
  assert.equal(fs.readFileSync(f.source, "utf8"), before);
  assert.equal(Object.hasOwn(f.stored(), "blocks"), false);
  const bytes = fs.readFileSync(f.manifestFile, "utf8");
  assert.equal(f.index().cacheHit, true);
  assert.equal(fs.readFileSync(f.manifestFile, "utf8"), bytes);
});

test("unknown versions cannot be overwritten by forced indexing", (t) => {
  const f = fixture(t);
  f.index("# Real\n");
  for (const mutation of [{ schema: "vcs-lab.spec-manifest/v999" }, { parser: "future/v1" }, { idAlgorithm: "future/v1" }]) {
    const value = f.stored();
    f.save({ ...value, ...mutation });
    const bytes = fs.readFileSync(f.manifestFile, "utf8");
    assertRefusal(() => f.vlab("spec", "index", "spec.md", "--force"), "unknown-schema-version");
    assert.equal(fs.readFileSync(f.manifestFile, "utf8"), bytes);
    f.save(value);
  }
});

test("an affected historical base blocks even when both tips have migrated", (t) => {
  const f = fixture(t);
  f.index("# Real\n\n```\n# Example\n```\n");
  f.legacy();
  const base = f.commit();
  f.index();
  const tip = f.commit();
  const before = f.git("status", "--porcelain");
  const plan = f.vlab("spec", "merge-plan", "spec.md", base, tip, tip);
  assert.equal(plan.schema, "vcs-lab.spec-merge-plan/v2");
  assert.equal(plan.status, "blocked");
  assert.deepEqual(plan.conflicts.map((item) => item.type), ["parser-migration-required"]);
  assert.deepEqual(plan.conflicts[0].stages, ["base"]);
  assert.equal(plan.signature, null);
  assert.equal(plan.result, null);
  assert.match(f.human("spec", "merge-plan", "spec.md", base, tip, tip), /legacy base[\s\S]*re-index its result/);
  assert.equal(f.git("status", "--porcelain"), before);
});

test("migration refuses unavailable prior source without overwriting metadata", (t) => {
  const f = fixture(t);
  f.index("# Real\n");
  f.legacy();
  const value = f.stored();
  delete value.sourceBlob;
  f.save(value);
  fs.writeFileSync(f.source, "# Changed\n");
  const bytes = fs.readFileSync(f.manifestFile, "utf8");
  assertRefusal(() => f.index(), "precondition-not-met");
  assert.equal(fs.readFileSync(f.manifestFile, "utf8"), bytes);
});

test("fence grammar distinguishes information strings, indentation, and closing suffixes", (t) => {
  const f = fixture(t);
  const cases = [
    ["```bad`info\n# Visible\n", ["preamble:1", "section:1:visible:1"]],
    ["~~~info`ok\n# Hidden\n~~~ trailing\n# Hidden too\n~~~\t \n# Visible\n", ["preamble:1", "section:1:visible:1"]],
    ["~~~info\u2028tail\n# Hidden\n~~~\n# Visible\n", ["preamble:1", "section:1:visible:1"]],
    ["```\n# Hidden\n\t```\n# Still hidden\n    ```\n# Also hidden\n```\n# Visible\n", ["preamble:1", "section:1:visible:1"]],
    ["\t```\n# Visible\n", ["preamble:1", "section:1:visible:1"]],
    ["   ````lang\n# Hidden\n```\nREQ-X: hidden\n  `````\t\n# Visible\n~~~\n# Hidden again\n~~~\nREQ-X: visible\n", ["preamble:1", "section:1:visible:1", "requirement:REQ-X:1"]],
  ];
  for (const [text, keys] of cases) {
    const result = f.index(text);
    assert.deepEqual(result.manifest.blocks.map((block) => block.semanticKey), keys, text);
    assert.equal(fs.readFileSync(f.source, "utf8"), text);
  }
});

test("unchanged batch indexing migrates legacy blobs and allows compatible mixed stages", (t) => {
  const f = fixture(t);
  f.index("# Real\nREQ-X: real\n");
  const old = f.legacy();
  const base = f.commit();
  const result = f.vlab("spec", "index", "--all");
  assert.equal(result.manifestsWritten, 1);
  assert.equal(result.cacheHits, 0);
  const tip = f.commit();
  const plan = f.vlab("spec", "merge-plan", "spec.md", base, tip, tip);
  assert.equal(plan.status, "clean");
  assert.deepEqual(plan.result.manifest.blocks.map((block) => block.id), old.blocks.map((block) => block.id));
  const cached = f.vlab("spec", "index", "--all");
  assert.equal(cached.blobCacheHits, 1);
  assert.equal(cached.contentReads, 0);
});

test("migration reserves removed example IDs during simultaneous edits", (t) => {
  const f = fixture(t);
  f.index("# Real\n```\n# New\n```\n");
  const old = f.legacy();
  const removed = old.blocks.find((block) => block.title === "New").id;
  const result = f.index("# Real\n```\n# New\n```\n# New\nnew real heading\n");
  const added = result.manifest.blocks.find((block) => block.title === "New");
  assert.notEqual(added.id, removed);
  assert.equal(f.stored().idOverrides[added.semanticKey], added.id);
  assert.equal(f.index().manifest.blocks.find((block) => block.title === "New").id, added.id);
});

test("legacy overrides survive verified migration but conflicting IDs refuse", (t) => {
  const f = fixture(t);
  f.index("# Real\nREQ-X: real\n");
  const old = f.legacy();
  const value = f.stored();
  value.idOverrides = { [old.blocks[0].semanticKey]: "ent_preserved" };
  f.save(value);
  assert.equal(f.index().manifest.blocks[0].id, "ent_preserved");
  f.legacy();
  const conflict = f.stored();
  conflict.idOverrides = Object.fromEntries(old.blocks.map((block) => [block.semanticKey, "ent_collision"]));
  f.save(conflict);
  const bytes = fs.readFileSync(f.manifestFile, "utf8");
  assertRefusal(() => f.index(), "malformed-input");
  assert.equal(fs.readFileSync(f.manifestFile, "utf8"), bytes);
});

test("v1 CRLF hashes migrate from verified source and retain expanded legacy IDs", (t) => {
  const f = fixture(t);
  const source = "# Real\r\nREQ-X: real\r\n";
  f.index(source);
  const old = f.legacy();
  const value = f.stored();
  value.schema = "vcs-lab.spec-manifest/v1";
  value.sourceHash = createHash("sha256").update(source).digest("hex");
  value.blocks = old.blocks.map((block, index) => ({ ...block, id: `ent_legacy_${index}` }));
  delete value.sourceBlob;
  delete value.idOverrides;
  f.save(value);
  const result = f.index();
  assert.equal(result.migratedFrom, "vcs-lab.spec-manifest/v1");
  assert.deepEqual(result.manifest.blocks.map((block) => block.id), value.blocks.map((block) => block.id));
  assert.equal(fs.readFileSync(f.source, "utf8"), source);
});

function divergence(f) {
  const commit = () => {
    f.git("add", "-A");
    return f.vlab("commit", "-m", "spec change").commit;
  };
  f.index("# Alpha\n\nbase alpha\n\n# Beta\n\nbase beta\n");
  const base = commit();
  f.vlab("init");
  f.git("switch", "-c", "feature", base);
  f.index("# Alpha\n\nsource alpha\n\n# Beta\n\nbase beta\n");
  commit();
  f.git("switch", "main");
  f.index("# Alpha\n\nbase alpha\n\n# Beta\n\ntarget beta\n");
  commit();
}

test("exact resolution materialization preserves legacy bytes without certifying corrected entities", (t) => {
  const f = fixture(t);
  f.index("# Real\n```\n# Example\n```\n");
  f.legacy();
  const old = f.commit();
  const bytes = fs.readFileSync(f.manifestFile, "utf8");
  const blob = f.git("rev-parse", `${old}:.vcs-lab/specs/spec.md.json`);
  f.index();
  f.commit();
  materializeResolutionCandidate({ path: ".vcs-lab/specs/spec.md.json" }, {
    resultBlob: blob, resultMode: "100644",
  }, f.root);
  assert.equal(fs.readFileSync(f.manifestFile, "utf8"), bytes);
  const restored = f.commit();
  const plan = f.vlab("spec", "merge-plan", "spec.md", old, restored, restored);
  assert.equal(plan.status, "blocked");
  assert.deepEqual(plan.conflicts[0].stages, ["base", "ours", "theirs"]);
  assert.equal(plan.signature, null);
});

for (const mode of ["reconcile", "rebase"]) {
  test(`${mode} refuses old semantic forecasts before mutation and old journals remain abortable`, (t) => {
    const f = fixture(t);
    divergence(f);
    const target = mode === "reconcile" ? "feature" : "main";
    if (mode === "rebase") f.git("switch", "feature");
    const forecast = f.vlab(mode === "reconcile" ? "forecast" : "rebase-forecast", target);
    assert.equal(forecast.status, "complete");
    assert.equal(forecast.approvedSpecMerges.length, 1);
    const forecastFile = path.join(f.root, ".git/vcs-lab/forecasts", `${forecast.id}.json`);
    const old = JSON.parse(fs.readFileSync(forecastFile, "utf8"));
    const before = f.git("rev-parse", "HEAD");
    fs.writeFileSync(forecastFile, JSON.stringify({
      ...old,
      schema: mode === "reconcile" ? "vcs-lab.forecast/v999" : "vcs-lab.rebase-forecast/v999",
      steps: 42,
    }));
    assertRefusal(() => f.vlab(mode, target, "--use-forecast", forecast.id), "unknown-schema-version");
    delete old.approvedSpecMerges[0].algorithm;
    old.steps[0].semanticMerges[0].algorithm = "stable-markdown-three-way/v1";
    fs.writeFileSync(forecastFile, JSON.stringify(old));
    const journal = path.join(f.root, ".git/vcs-lab", mode === "reconcile" ? "reconciliation.json" : "rebase.json");
    assertRefusal(() => f.vlab(mode, target, "--use-forecast", forecast.id), "precondition-not-met");
    assert.equal(f.git("rev-parse", "HEAD"), before);
    assert.equal(f.git("status", "--porcelain"), "");
    assert.equal(fs.existsSync(journal), false);
    assert.throws(() => f.vlab(mode, target));
    f.vlab("spec", "resolve", "--all");
    const operation = JSON.parse(fs.readFileSync(journal, "utf8"));
    assert.equal(operation.current.semanticMerges.length, 1);
    operation.current.semanticMerges[0].algorithm = "stable-markdown-three-way/v1";
    fs.writeFileSync(journal, JSON.stringify(operation));
    const staged = f.git("write-tree");
    const pendingHead = f.git("rev-parse", "HEAD");
    assertRefusal(() => f.vlab(mode, "--continue"), "precondition-not-met");
    assert.equal(f.git("write-tree"), staged);
    assert.equal(f.git("rev-parse", "HEAD"), pendingHead);
    f.vlab(mode, "--abort");
    assert.equal(f.git("rev-parse", "HEAD"), before);
    assert.equal(f.git("status", "--porcelain"), "");
    assert.equal(fs.existsSync(journal), false);
  });
}
