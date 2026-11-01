import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { hostProvenance, selectBaseline } from "./benchmark-host.mjs";
import { cstCommand, cstPrefix } from "../test-support/cst-command.js";

const script = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(script), "..");
// Each phase is one read-only command, run whole by the CLI under each engine.
// Until #243 this also timed the JavaScript modules in-process; the Rust CLI's
// whole-command time is the measurement now.
const phases = {
  noteCatalog: { cli: ["receipts", "--json"] },
  resolutionCatalog: { cli: ["resolve", "list", "--json"] },
  metadataStatus: { cli: ["metadata", "status", "--json"] },
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

{
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
  const native = JSON.parse(execute(cstCommand, [...cstPrefix(), "doctor", "--json"], repo).stdout).engine.native;
  assert.equal(native.available, true, "The CLI under measurement must have its native backend.");
  const evidence = {
    format: "real-repository-measurement-v2",
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
      "Nine fresh processes per engine; operating-system caches are not flushed. p95 is the maximum of nine samples.",
      "Whole-command times include process start; no raw-Git floor is measured (v1 timed the JavaScript modules and a floor in-process).",
      "Clones omit source worktree registries, private forecasts, and dirty drafts; these require separate workflow evidence.",
      "Whole receipts CLI reads are compared between engines separately; receipts are a subset of the note catalog.",
    ],
  };
  const save = () => fs.writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`);
  save();
  for (const [name, phase] of Object.entries(phases)) {
    const cli = { git: [], native: [] };
    let oracle;
    for (let index = 0; index < 9; index += 1) {
      for (const engine of index % 2 === 0 ? ["git", "native"] : ["native", "git"]) {
        const child = execute(cstCommand, [...cstPrefix(), ...phase.cli, "--engine", engine], repo);
        const value = JSON.parse(child.stdout);
        if (oracle === undefined) oracle = value;
        assert.deepEqual(value, oracle, `${name}/${engine}: CLI result changed`);
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
      cliSamplesMs: cli,
      wholeCli: Object.fromEntries(Object.entries(cli).map(([engine, values]) => [engine, stats(values)])),
    };
    save();
    console.error(`${name}: identical CLI results across engines`);
  }
  assert.deepEqual(snapshot(repo), before, "Measured repository changed during the run.");
  execute("git", ["fsck", "--no-dangling"], repo);
  evidence.complete = true;
  evidence.repositoryUnchanged = true;
  evidence.freeMemoryBytesAtEnd = os.freemem();
  save();
}
