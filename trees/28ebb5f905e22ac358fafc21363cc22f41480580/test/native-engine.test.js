import { testEnv } from "../test-support/git-environment.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as engine from "../src/engine.js";
import * as git from "../src/git.js";
import { loadNativeEngine } from "../src/native-engine.js";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";

Object.assign(process.env, testEnv());
// The supported profile deliberately excludes command-scope configuration.
delete process.env.GIT_CONFIG_COUNT;
const available = engine.nativeEngine().available;
if (process.env.VLAB_REQUIRE_NATIVE === "1") assert.equal(available, true, "native prebuild required");

function fixture(t, options = []) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "vlab-native-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const run = (...args) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8", env: testEnv() });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  run("init", "-q", "-b", "main", ...options);
  run("config", "user.name", "Native Test");
  run("config", "user.email", "native@example.invalid");
  fs.writeFileSync(path.join(root, "result"), "retained result\n");
  run("add", ".");
  run("commit", "-qm", "base");
  const head = run("rev-parse", "HEAD");
  run("update-ref", "refs/vcs-lab/resolutions/a", head);
  run("notes", "--ref=vcs-lab", "add", "-m", "note", head);
  return { root, run, head };
}

function compare(operation, args, native = true) {
  const expected = git.withReadEngine("git", () => git[operation](...args));
  const collector = git.beginGitMetrics(operation);
  let actual;
  let metrics;
  git.withReadEngine("native", () => {
    actual = engine[operation](...args);
    metrics = git.endGitMetrics(collector);
  });
  assert.deepEqual(actual, expected, operation);
  if (native) {
    assert.equal(metrics.processes, 0, JSON.stringify(metrics));
    assert.deepEqual(metrics.fallbacks, []);
    assert.equal(metrics.nativeReads[operation], 1);
  } else {
    assert.ok(metrics.fallbacks.length > 0, JSON.stringify(metrics));
    assert.deepEqual(metrics.nativeReads, {});
  }
}

test("native reads match Git for loose and packed objects, refs, notes, and linked worktrees", { skip: !available }, (t) => {
  const { root, run, head } = fixture(t);
  const linked = path.join(root, "linked");
  run("worktree", "add", "--detach", linked, head);
  run("tag", "-a", "tag", "-m", "tag");
  const tag = run("rev-parse", "tag");
  const expressions = [head, `${head}^{commit}`, `${head}^{tree}`, `${head}:result`, `${tag}^{commit}`, "0".repeat(40)];
  for (const packed of [false, true]) {
    if (packed) { run("pack-refs", "--all"); run("gc", "--quiet"); }
    const before = [run("for-each-ref", "--format=%(refname) %(objectname)"),
      run("status", "--porcelain"), run("worktree", "list", "--porcelain")];
    for (const cwd of [root, linked]) {
      compare("repoContext", [cwd]);
      compare("listRefs", ["refs/vcs-lab/resolutions", cwd]);
      compare("inspectGitObjects", [expressions, cwd]);
      compare("readGitObjects", [expressions, cwd]);
      compare("listNoteEntries", ["vcs-lab", cwd]);
    }
    assert.deepEqual([run("for-each-ref", "--format=%(refname) %(objectname)"),
      run("status", "--porcelain"), run("worktree", "list", "--porcelain")], before);
  }
  run("update-ref", "refs/vcs-lab/resolutions/b", tag);
  run("update-ref", "-d", "refs/vcs-lab/resolutions/a");
  compare("listRefs", ["refs/vcs-lab/resolutions", root]);
  run("fsck", "--no-dangling");
});

test("unsupported expressions and repository profiles fall back as complete operations", { skip: !available }, (t) => {
  const { root, head } = fixture(t);
  compare("readGitObjects", [[head, "HEAD~0"], root], false);
  compare("listRefs", ["refs/heads/*", root], false);
  const sha256 = fixture(t, ["--object-format=sha256"]);
  compare("repoContext", [sha256.root], false);
  compare("listNoteEntries", ["vcs-lab", sha256.root], false);
  const version = spawnSync("git", ["--version"], { encoding: "utf8" }).stdout.match(/(\d+)\.(\d+)/);
  if (Number(version[1]) > 2 || Number(version[2]) >= 45) {
    const reftable = fixture(t, ["--ref-format=reftable"]);
    compare("listRefs", ["refs/heads", reftable.root], false);
  } else assert.notEqual(process.env.VLAB_REQUIRE_NATIVE, "1", "qualification requires a reftable-capable Git");
});

function rawObject(root, type, data) {
  const result = spawnSync("git", ["hash-object", "-w", "--literally", "-t", type, "--stdin"], {
    cwd: root, input: data, env: testEnv(),
  });
  assert.equal(result.status, 0, result.stderr.toString());
  return result.stdout.toString().trim();
}

test("native notes reject duplicate, malformed, and oversized trees without partial results", { skip: !available }, (t) => {
  const { root, run, head } = fixture(t);
  const note = rawObject(root, "blob", Buffer.from("duplicate\n"));
  const entry = (name) => Buffer.concat([Buffer.from(`100644 ${name}\0`), Buffer.from(note, "hex")]);
  const duplicate = rawObject(root, "tree", Buffer.concat([entry(head.toUpperCase()), entry(head)]));
  run("update-ref", "refs/notes/vcs-lab", duplicate);
  compare("listNoteEntries", ["vcs-lab", root], false);
  const malformed = rawObject(root, "tree", Buffer.from("100644 truncated\0x"));
  run("update-ref", "refs/notes/vcs-lab", malformed);
  compare("listNoteEntries", ["vcs-lab", root], false);
  const oversized = rawObject(root, "blob", Buffer.alloc(64 * 1024 * 1024 + 1, 97));
  compare("inspectGitObjects", [[oversized], root]);
  compare("readGitObjects", [[head, oversized], root], false);
});

test("missing and broken optional bindings preserve Git functionality", (t) => {
  assert.equal(loadNativeEngine(() => { throw new Error("invalid binary"); }).reason, "binding-load-error");
  assert.equal(loadNativeEngine(() => ({})).reason, "binding-incompatible");
  const { root } = fixture(t);
  const moduleUrl = new URL("../src/engine.js", import.meta.url).href;
  const script = `import { describeReadEngines, repoContext } from ${JSON.stringify(moduleUrl)};
    console.log(JSON.stringify({ engine: describeReadEngines(), context: repoContext() }));`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root, encoding: "utf8", env: testEnv({ VLAB_ENGINE: "native", VLAB_TEST_NATIVE_BINDING: "missing" }),
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.engine.native.available, false);
  assert.equal(parsed.engine.native.reason, "binding-missing");
  assert.equal(parsed.context.root, root);
});

test("unordered trees and aliased worktree paths delegate to Git", { skip: !available }, (t) => {
  const { root } = fixture(t);
  const blob = rawObject(root, "blob", Buffer.from("retained\n"));
  const entry = (name) => Buffer.concat([Buffer.from(`100644 ${name}\0`), Buffer.from(blob, "hex")]);
  const tree = rawObject(root, "tree", Buffer.concat([entry("z"), entry("result")]));
  compare("inspectGitObjects", [[`${tree}:result`], root], false);
  const alias = `${root}-alias`;
  fs.symlinkSync(root, alias, process.platform === "win32" ? "junction" : "dir");
  t.after(() => fs.unlinkSync(alias));
  compare("repoContext", [alias], false);
  if (process.platform === "win32") {
    assert.throws(() => engine.nativeEngine().operations.repoContext("\\\\server\\share\\repo"), /unsupported aliased/);
  }
});

test("a small packed delta cannot bypass the native allocation limit with a large base", { skip: !available }, (t) => {
  const { root } = fixture(t);
  const base = Buffer.alloc(64 * 1024 * 1024 + 1, 90);
  const baseId = createHash("sha1").update(`blob ${base.length}\0`).update(base).digest();
  const integer = (value) => {
    const bytes = [];
    do { const byte = value & 127; value = Math.floor(value / 128); bytes.push(byte | (value ? 128 : 0)); } while (value);
    return Buffer.from(bytes);
  };
  const header = (type, size) => {
    const first = (type << 4) | (size & 15);
    size = Math.floor(size / 16);
    return Buffer.concat([Buffer.from([first | (size ? 128 : 0)]), size ? integer(size) : Buffer.alloc(0)]);
  };
  const delta = Buffer.concat([integer(base.length), integer(1), Buffer.from([1, 90])]);
  const body = Buffer.concat([Buffer.from("5041434b0000000200000002", "hex"),
    header(3, base.length), deflateSync(base), header(7, delta.length), baseId, deflateSync(delta)]);
  const pack = Buffer.concat([body, createHash("sha1").update(body).digest()]);
  const indexed = spawnSync("git", ["index-pack", "--stdin"], { cwd: root, input: pack, env: testEnv() });
  assert.equal(indexed.status, 0, indexed.stderr.toString());
  const resultId = createHash("sha1").update("blob 1\0Z").digest("hex");
  compare("readGitObjects", [[resultId], root], false);
});

test("absent empty-tree objects retain Git existence semantics", { skip: !available }, (t) => {
  const { root } = fixture(t);
  compare("readGitObjects", [["4b825dc642cb6eb9a060e54bf8d69288fbee4904"], root]);
});
