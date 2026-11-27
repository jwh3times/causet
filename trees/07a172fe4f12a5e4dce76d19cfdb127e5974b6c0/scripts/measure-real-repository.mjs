import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { beginGitMetrics, endGitMetrics, withReadEngine } from "../src/git.js";
import { describeReadEngines } from "../src/engine.js";
import { metadataStatus } from "../src/metadata.js";
import { listNoteRecords } from "../src/notes.js";
import { listResolutionRecords } from "../src/resolutions.js";
import { resolutionCatalogFloor } from "../src/scale-benchmark.js";
import { hostProvenance, selectBaseline } from "./benchmark-host.mjs";

const script = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(script), "..");
const phases = {
  noteCatalog: { read: listNoteRecords, cli: ["receipts", "--json"] },
  resolutionCatalog: { read: listResolutionRecords, cli: ["resolve", "list", "--json"] },
  metadataStatus: { read: (repo) => metadataStatus({ cwd: repo }), cli: ["metadata", "status", "--json"] },
};
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
const stats = (values) => ({ medianMs: percentile(values, 0.5), p95Ms: percentile(values, 0.95) });

function execute(command, args, cwd) {
  const start = performance.now();
  const child = spawnSync(command, args, { cwd, encoding: "utf8", timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
  assert.equal(child.status, 0, child.error?.message ?? child.stderr);
  return { stdout: child.stdout, wholeMs: performance.now() - start };
}

function snapshot(repo) {
  const git = (args) => execute("git", args, repo).stdout;
  return {
    head: git(["rev-parse", "HEAD"]).trim(),
    refs: git(["for-each-ref", "--format=%(refname) %(objectname)"]),
    status: git(["status", "--porcelain=v1", "--untracked-files=all"]),
  };
}

// Each phase gets a fresh process, including native binding initialization.
if (process.argv[2] === "--sample") {
  const [, , , repo, phase, engine] = process.argv;
  assert.ok(Object.hasOwn(phases, phase));
  assert.ok(["git", "native", "floor"].includes(engine));
  assert.ok(engine !== "floor" || phase === "resolutionCatalog");
  const result = withReadEngine(engine === "floor" ? "git" : engine, () => {
    const collector = beginGitMetrics(phase);
    const start = performance.now();
    const value = engine === "floor" ? resolutionCatalogFloor(repo) ?? null : phases[phase].read(repo);
    const durationMs = performance.now() - start;
    const metrics = endGitMetrics(collector);
    return { value, durationMs, metrics, native: engine === "native" ? describeReadEngines().native : null };
  });
  console.log(JSON.stringify(result));
} else {
  const args = process.argv.slice(2);
  assert.equal(args.length, 6, "Use --repo <disposable-clone> --host <stable-label> --output <new-file.json>.");
  assert.equal(args[0], "--repo");
  assert.equal(args[2], "--host");
  assert.equal(args[4], "--output");
  const repo = fs.realpathSync.native(args[1]);
  const label = args[3];
  assert.match(label, /^[a-z0-9][a-z0-9._-]{0,63}$/);
  const output = path.resolve(args[5]);
  const outputParent = fs.realpathSync.native(path.dirname(output));
  const relative = path.relative(repo, outputParent);
  assert.ok(relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative), "Evidence output must be outside the measured clone.");
  assert.equal(fs.existsSync(output), false, "Preserve previous evidence; choose a new output file.");
  const before = snapshot(repo);
  assert.equal(before.status, "", "Use a clean disposable clone.");
  const host = hostProvenance(label);
  const baseline = JSON.parse(fs.readFileSync(path.join(root, "benchmarks/baseline.json"), "utf8"));
  const selected = selectBaseline(baseline, host);
  const native = describeReadEngines().native;
  assert.equal(native.available, true, "Build the optional binding before comparing native execution.");
  const evidence = {
    format: "real-repository-measurement-v1",
    sourceCommit: execute("git", ["rev-parse", "HEAD"], root).stdout.trim(),
    scriptSha256: createHash("sha256").update(fs.readFileSync(script)).digest("hex"),
    repositoryCommit: before.head,
    refsSha256: digest(before.refs),
    host, node: process.version, git: execute("git", ["--version"], repo).stdout.trim(),
    commandScopeGitConfigPresent: process.env.GIT_CONFIG_COUNT !== undefined || process.env.GIT_CONFIG_PARAMETERS !== undefined,
    baseline: { reference: selected.reference, latencySkipped: selected.latencySkipped, reason: selected.reason },
    freeMemoryBytesAtStart: os.freemem(),
    trackedFiles: execute("git", ["ls-files", "-z"], repo).stdout.split("\0").filter(Boolean).length,
    reachableCommits: Number(execute("git", ["rev-list", "--count", "HEAD"], repo).stdout),
    objectStorage: execute("git", ["count-objects", "-v"], repo).stdout,
    native, measurements: {}, complete: false,
    limitations: [
      "One repository snapshot and one host; no representative-budget ratification or quiet-host claim.",
      "Nine fresh processes per side; operating-system caches are not flushed. p95 is the maximum of nine samples.",
      "The resolution raw-Git floor acquires retained objects; it does not validate domain records.",
      "No floor is asserted for metadata validation or notes parsing. Native fallback is measured and retained.",
      "Clones omit source worktree registries, private forecasts, and dirty drafts; these require separate workflow evidence.",
      "Whole receipts CLI reads are compared between engines separately; receipts are a subset of the note catalog.",
    ],
  };
  const save = () => fs.writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`);
  save();
  for (const [name, phase] of Object.entries(phases)) {
    const samples = { git: [], native: [], ...(name === "resolutionCatalog" ? { floor: [] } : {}) };
    const cli = { git: [], native: [] };
    let oracle;
    let cliOracle;
    for (let index = 0; index < 9; index += 1) {
      const order = index % 2 === 0 ? Object.keys(samples) : Object.keys(samples).reverse();
      for (const engine of order) {
        const child = execute(process.execPath, [script, "--sample", repo, name, engine], root);
        const sample = JSON.parse(child.stdout);
        if (engine !== "floor") {
          if (oracle === undefined) oracle = sample.value;
          assert.deepEqual(sample.value, oracle, `${name}/${engine}: domain result changed`);
          if (engine === "native") assert.equal(sample.native.available, true);
        }
        delete sample.value;
        samples[engine].push({ ...sample, wholeProcessMs: child.wholeMs });
      }
      for (const engine of index % 2 === 0 ? ["git", "native"] : ["native", "git"]) {
        const child = execute(process.execPath, [path.join(root, "bin/vlab.js"), ...phase.cli, "--engine", engine], repo);
        const value = JSON.parse(child.stdout);
        if (cliOracle === undefined) cliOracle = value;
        assert.deepEqual(value, cliOracle, `${name}/${engine}: CLI result changed`);
        cli[engine].push(child.wholeMs);
      }
    }
    evidence.measurements[name] = {
      resultSha256: digest(oracle),
      resultCount: Array.isArray(oracle) ? oracle.length : null,
      summary: name === "metadataStatus" ? oracle.summary : null,
      scopes: name === "metadataStatus" ? {
        noteRecords: oracle.scopes.sharedPortable.notes,
        resolutions: oracle.scopes.sharedPortable.resolutions,
      } : null,
      samples,
      phase: Object.fromEntries(Object.entries(samples).map(([engine, values]) => [engine, stats(values.map((value) => value.durationMs))])),
      cliSamplesMs: cli,
      wholeCli: Object.fromEntries(Object.entries(cli).map(([engine, values]) => [engine, stats(values)])),
    };
    save();
    console.error(`${name}: identical domain and CLI results across engines`);
  }
  assert.deepEqual(snapshot(repo), before, "Measured repository changed during the run.");
  execute("git", ["fsck", "--no-dangling"], repo);
  evidence.complete = true;
  evidence.repositoryUnchanged = true;
  evidence.freeMemoryBytesAtEnd = os.freemem();
  save();
}
