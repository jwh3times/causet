import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { testEnv } from "./git-environment.js";

const cli = fileURLToPath(new URL("../bin/vlab.js", import.meta.url));

export function runMarkdownCase(t, entry, profile) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "vcs-lab-semantic-"));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const execute = (command, args) => execFileSync(command, args, {
    cwd: repo, env: testEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000,
  }).trim();
  const git = (...args) => execute("git", args);
  const vlab = (...args) => JSON.parse(execute(process.execPath, [cli, ...args, "--json"]));
  git("init", "-b", "main");
  git("config", "user.name", "Semantic fixture");
  git("config", "user.email", "semantic@example.invalid");
  git("config", "core.autocrlf", "false");
  fs.writeFileSync(path.join(repo, "anchor.txt"), "fixture\n");

  const source = "spec.md";
  const sourcePath = path.join(repo, source);
  const manifestPath = path.join(repo, ".vcs-lab/specs/spec.md.json");
  const views = {};
  const revisions = {};
  for (const stage of ["base", "ours", "theirs"]) {
    if (stage !== "base") git("switch", "-C", stage, revisions.base);
    const input = entry.stages[stage];
    if (input.text === null) {
      fs.rmSync(sourcePath, { force: true });
      fs.rmSync(manifestPath, { force: true });
      views[stage] = null;
    } else {
      fs.writeFileSync(sourcePath, input.text);
      vlab("spec", "index", source, "--force");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      manifest.schema = profile.manifest;
      manifest.parser = profile.parser;
      // A fixed artifact identity makes independent branch additions comparable.
      // This is input construction; entity IDs are observed through spec show.
      manifest.artifactId = input.artifactId ?? "artifact_conformance";
      if (input.idOverrides) manifest.idOverrides = input.idOverrides;
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
      views[stage] = vlab("spec", "show", source).manifest;
      assert.equal(views[stage].parser, profile.parser);
      assert.equal(views[stage].schema, profile.manifest);
      assert.equal(fs.readFileSync(sourcePath, "utf8"), input.text, "indexing must preserve source bytes");
      const stored = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      assert.equal(Object.hasOwn(stored, "blocks"), false, "ordinary manifests stay sparse");

      if (input.metadata === "missing") fs.unlinkSync(manifestPath);
      else if (input.metadata === "malformed") fs.writeFileSync(manifestPath, "{broken");
      else if (input.metadata) {
        if (input.metadata === "stale") stored.sourceHash = "0".repeat(64);
        else if (input.metadata === "future-parser") stored.parser = "stable-markdown-blocks/v999";
        else if (input.metadata === "future-manifest") stored.schema = "vcs-lab.spec-manifest/v999";
        else if (input.metadata === "legacy-v2") {
          stored.schema = "vcs-lab.spec-manifest/v2";
          stored.parser = "stable-markdown-blocks/v1";
          stored.blocks = views[stage].blocks;
          delete stored.idOverrides;
        } else throw new Error(`Unknown metadata fixture: ${input.metadata}`);
        fs.writeFileSync(manifestPath, `${JSON.stringify(stored)}\n`);
      }
    }
    git("add", "-A");
    git("commit", "--allow-empty", "-m", stage);
    revisions[stage] = git("rev-parse", "HEAD");
  }

  const before = { head: git("rev-parse", "HEAD"), status: git("status", "--porcelain=v1") };
  const plan = vlab("spec", "merge-plan", source, revisions.base, revisions.ours, revisions.theirs);
  assert.equal(plan.schema, "vcs-lab.spec-merge-plan/v2");
  assert.equal(plan.algorithm, profile.merge);
  assert.deepEqual(vlab("spec", "merge-plan", source, revisions.base, revisions.ours, revisions.theirs), plan,
    "repeated planning of identical ordered inputs is deterministic");
  assert.deepEqual({ head: git("rev-parse", "HEAD"), status: git("status", "--porcelain=v1") }, before,
    "planning preserves HEAD and the worktree");

  const knownIds = new Map();
  for (const stage of ["base", "ours", "theirs"]) {
    for (const block of views[stage]?.blocks ?? []) {
      const key = `${views[stage].artifactId}\0${block.semanticKey}`;
      // Overrides deliberately introduce another identity; compare ordinary IDs
      // and equal overrides, leaving conflicting overrides to explicit fixtures.
      const override = entry.stages[stage].idOverrides?.[block.semanticKey];
      if (!override && knownIds.has(key)) assert.equal(block.id, knownIds.get(key), "stable entity identity");
      if (!override) knownIds.set(key, block.id);
    }
  }
  if (plan.result && !plan.result.deleted) {
    for (const block of plan.result.manifest.blocks) {
      const candidates = Object.values(views).flatMap((view) => view?.blocks ?? [])
        .filter((prior) => prior.semanticKey === block.semanticKey);
      assert.ok(candidates.some((prior) => prior.id === block.id), `result preserves identity: ${block.semanticKey}`);
    }
    assert.equal(plan.result.manifest.schema, "vcs-lab.spec-manifest/v4");
  }
  return {
    entities: Object.fromEntries(Object.entries(views).map(([stage, view]) =>
      [stage, view?.blocks.map((block) => block.semanticKey) ?? []])),
    plan: {
      status: plan.status,
      decisions: plan.decisions.map((decision) => {
        const block = Object.values(views).flatMap((view) => view?.blocks ?? [])
          .find((candidate) => candidate.id === decision.id);
        assert.ok(block, `decision names an input entity: ${decision.id}`);
        return [block.semanticKey, decision.outcome, decision.conflict ?? null];
      }).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0),
      counts: plan.counts,
      ordering: plan.ordering.decision,
      conflicts: plan.conflicts.map((conflict) => conflict.type).sort(),
      result: plan.result ? {
        deleted: plan.result.deleted,
        text: plan.result.markdown,
        entities: plan.result.manifest?.blocks.map((block) => block.semanticKey) ?? [],
      } : null,
    },
  };
}
