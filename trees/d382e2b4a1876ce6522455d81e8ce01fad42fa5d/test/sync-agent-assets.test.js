import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { syncMirrors } from "../scripts/sync-agent-assets.mjs";
import "../test-support/git-environment.js";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vlab-mirrors-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    write(file, content) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), content);
    },
    read: (file) => fs.readFileSync(path.join(root, file)),
  };
}

test("empty repositories and skills without agent definitions can synchronize", (t) => {
  const f = fixture(t);
  assert.deepEqual(syncMirrors(f.root), { stale: [], count: 0 });
  f.write(".agents/skills/demo/SKILL.md", "---\r\nname: demo\r\n---\r\nInstructions\r\n");
  const asset = Buffer.from([0, 255, 13, 10, 128]);
  f.write(".agents/skills/demo/assets/data.bin", asset);
  const before = syncMirrors(f.root, { check: true });
  assert.equal(before.stale.length, 2);
  assert.equal(fs.existsSync(path.join(f.root, ".claude/skills")), false);
  syncMirrors(f.root);
  assert.match(f.read(".claude/skills/demo/SKILL.md").toString(), /^---\n# GENERATED.*\nname: demo\n/);
  assert.deepEqual(f.read(".claude/skills/demo/assets/data.bin"), asset);
  assert.deepEqual(syncMirrors(f.root, { check: true }).stale, []);
});

test("agent conversion preserves literal instructions and omits harness-specific fields", (t) => {
  const f = fixture(t);
  const body = 'Use C:\\work and """raw strings""".\nFinish with an apostrophe: \' ';
  f.write(".claude/agents/reviewer.md", `---\nname: "reviewer"\ndescription: 'Review developers'' code'\nmodel: opus\ntools: Read, Bash\n---\n${body}`);
  syncMirrors(f.root);
  const generated = f.read(".codex/agents/reviewer.toml").toString();
  assert.match(generated, /name = "reviewer"/);
  assert.match(generated, /description = "Review developers' code"/);
  assert.ok(generated.includes(`developer_instructions = '''\n${body.trim()}\n'''`));
  assert.doesNotMatch(generated, /^(model|tools) =/m);
  assert.deepEqual(syncMirrors(f.root, { check: true }).stale, []);
});

test("checks report edits and nested orphans without writing, then regeneration repairs them", (t) => {
  const f = fixture(t);
  f.write(".agents/skills/demo/SKILL.md", "---\nname: demo\n---\nRead this.\n");
  syncMirrors(f.root);
  f.write(".claude/skills/demo/SKILL.md", "edited");
  f.write(".claude/skills/removed/nested/asset.txt", "orphan");
  f.write(".codex/agents/removed.toml", "orphan");
  const { stale } = syncMirrors(f.root, { check: true });
  assert.equal(stale.length, 3);
  assert.equal(stale.filter((file) => file.endsWith("(orphaned)")).length, 2);
  assert.equal(f.read(".claude/skills/demo/SKILL.md").toString(), "edited");
  syncMirrors(f.root);
  assert.equal(fs.existsSync(path.join(f.root, ".codex/agents/removed.toml")), false);
  assert.equal(fs.existsSync(path.join(f.root, ".claude/skills/removed/nested/asset.txt")), false);
  assert.deepEqual(syncMirrors(f.root, { check: true }).stale, []);
});

test("invalid agents fail before generated files are changed", (t) => {
  const f = fixture(t);
  f.write(".claude/skills/keep.txt", "preserve");
  f.write(".claude/agents/a-valid.md", "---\nname: valid\ndescription: Valid agent\n---\nRead files.");
  for (const raw of [
    "missing frontmatter",
    "---\nname: bad\n---\nBody",
    "---\nname: bad\ndescription: |\n  Multiline\n---\nBody",
    "---\nname: bad\ndescription: Bad agent\n---\n",
    "---\nname: bad\ndescription: Bad agent\n---\nContains ''' delimiter",
  ]) {
    f.write(".claude/agents/z-invalid.md", raw);
    assert.throws(() => syncMirrors(f.root), /z-invalid.md/);
    assert.equal(fs.existsSync(path.join(f.root, ".codex/agents/a-valid.toml")), false);
    assert.equal(f.read(".claude/skills/keep.txt").toString(), "preserve");
  }
});

test("linked target parents are rejected before writing outside the mirror tree", (t) => {
  const f = fixture(t);
  const outside = fixture(t);
  f.write(".agents/skills/demo/SKILL.md", "---\nname: demo\n---\nRead this.");
  fs.symlinkSync(outside.root, path.join(f.root, ".claude"), "junction");
  assert.throws(() => syncMirrors(f.root), /mirror parents must not be symlinks/);
  assert.deepEqual(fs.readdirSync(outside.root), []);
});
