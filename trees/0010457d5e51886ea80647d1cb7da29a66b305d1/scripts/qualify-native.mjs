import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { beginGitMetrics, endGitMetrics, withReadEngine } from "../src/git.js";
import { describeReadEngines } from "../src/engine.js";
import { listResolutionRecords } from "../src/resolutions.js";
import { resolutionCatalogFloor, withScaleFixture } from "../src/scale-benchmark.js";
import { hostProvenance, selectBaseline } from "./benchmark-host.mjs";

const script = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(script), "..");
const [mode, ...args] = process.argv.slice(2);

if (mode === "--sample") {
  const [side, repo] = args;
  const collector = beginGitMetrics("native-qualification");
  const start = performance.now();
  const result = withReadEngine(side === "floor" ? "git" : side, () => side === "floor"
    ? resolutionCatalogFloor(repo) ?? null : listResolutionRecords(repo));
  const durationMs = performance.now() - start;
  const metrics = withReadEngine(side === "native" ? "native" : "git", () => endGitMetrics(collector));
  console.log(JSON.stringify({ durationMs, metrics, result,
    engine: side === "native" ? describeReadEngines().native : null }));
} else {
  assert.equal(mode, "--host", "Use --host <label> <output.json> on a quiet qualification host.");
  const [label, output] = args;
  assert.ok(output, "An evidence output path is required.");
  const baseline = JSON.parse(fs.readFileSync(path.join(root, "benchmarks/baseline.json"), "utf8"));
  const host = hostProvenance(label);
  assert.equal(selectBaseline(baseline, host).latencySkipped, false, "Host must match its committed baseline.");
  const execute = (argv, cwd = root) => {
    const started = performance.now();
    const child = spawnSync(process.execPath, argv, { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    const wholeMs = performance.now() - started;
    assert.equal(child.status, 0, child.stderr);
    return { ...JSON.parse(child.stdout), wholeMs };
  };
  const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
  const stats = (samples, member) => ({
    medianMs: percentile(samples.map((s) => s[member]), 0.5),
    p95Ms: percentile(samples.map((s) => s[member]), 0.95),
  });
  const checks = [];
  for (let check = 0; check < 3; check += 1) {
    const result = withScaleFixture(baseline.profile, (repo, fixture) => {
      const oracle = execute([script, "--sample", "git", repo]).result;
      assert.equal(oracle.length, baseline.profile.resolutions);
      const samples = { native: [], floor: [] };
      const order = check % 2 === 0 ? ["native", "floor"] : ["floor", "native"];
      for (let index = 0; index < 9; index += 1) {
        for (const side of order) {
          const sample = execute([script, "--sample", side, repo]);
          if (side === "native") {
            assert.deepEqual(sample.result, oracle);
            assert.equal(sample.engine.available, true);
            assert.equal(sample.metrics.processes, 0);
            assert.deepEqual(sample.metrics.fallbacks, []);
            for (const operation of ["repoContext", "listRefs", "inspectGitObjects", "readGitObjects", "listNoteEntries"]) {
              assert.ok(sample.metrics.nativeReads[operation] > 0, operation);
            }
          }
          delete sample.result;
          samples[side].push(sample);
        }
      }
      const cli = [];
      for (let index = 0; index < 9; index += 1) {
        const native = execute([path.join(root, "bin/vlab.js"), "resolve", "list", "--json", "--engine", "native"], repo);
        const git = execute([path.join(root, "bin/vlab.js"), "resolve", "list", "--json", "--engine", "git"], repo);
        const { wholeMs: nativeMs, ...nativeResult } = native;
        const { wholeMs: gitMs, ...gitResult } = git;
        assert.deepEqual(nativeResult, gitResult);
        cli.push({ nativeMs, gitMs });
      }
      const native = stats(samples.native, "durationMs");
      const floor = stats(samples.floor, "durationMs");
      const fsck = spawnSync("git", ["fsck", "--no-dangling"], { cwd: repo, encoding: "utf8" });
      assert.equal(fsck.status, 0, fsck.stderr);
      return { fixture, order, samples, native, floor, ratio: native.medianMs / floor.medianMs,
        pass: native.medianMs <= 1.10 * floor.medianMs, cli,
        wholeCli: { native: stats(cli, "nativeMs"), git: stats(cli, "gitMs") } };
    });
    checks.push(result);
    fs.writeFileSync(output, `${JSON.stringify({ host, profile: baseline.profile, node: process.version,
      checks, pass: checks.length === 3 && checks.every((c) => c.pass) }, null, 2)}\n`);
    console.error(`check ${check + 1}: native ${result.native.medianMs.toFixed(2)} ms / Git ${result.floor.medianMs.toFixed(2)} ms (${(result.ratio * 100).toFixed(1)}%)`);
    // ADR-0027: a miss ends the bounded attempt; do not tune against the target.
    if (!result.pass) break;
  }
  if (checks.length !== 3 || checks.some((check) => !check.pass)) process.exitCode = 1;
}
