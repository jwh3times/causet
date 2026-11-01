import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { testEnv } from "../test-support/git-environment.js";
import { BASELINE_SCHEMA, hostProvenance, migrateBaseline, parseOptions, recordBaseline, selectBaseline } from "../scripts/benchmark-host.mjs";
import { compare, PROFILE, TOLERANCE } from "../scripts/benchmark-regression.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const committed = JSON.parse(fs.readFileSync(path.join(root, "benchmarks/baseline.json"), "utf8"));
const legacy = committed.legacyHosts.linux;
const host = (id) => ({ id, platform: "linux", arch: "x64", cpuModels: ["Example CPU"], logicalCpus: 8, memoryBytes: 16000000000, osRelease: "example", overrides: {} });
const entry = (id) => ({ ...structuredClone(legacy), host: host(id) });
const baseline = () => ({ schema: BASELINE_SCHEMA, profile: PROFILE, tolerance: TOLERANCE, hosts: { alpha: entry("alpha"), beta: entry("beta") }, legacyHosts: { linux: structuredClone(legacy) } });

test("host labels select two independent latency baselines on the same operating system", () => {
  const saved = baseline();
  saved.hosts.beta.phases.history.medianMs = 1000;
  const current = entry("alpha");
  current.phases.history.medianMs = 100;
  const alpha = selectBaseline(saved, host("alpha"));
  const beta = selectBaseline(saved, host("beta"));
  assert.equal(alpha.reference, "hosts.alpha");
  assert.equal(beta.reference, "hosts.beta");
  assert.equal(alpha.latencySkipped, false);
  assert.equal(beta.latencySkipped, false);
  assert.ok(compare(alpha.entry, current).some((finding) => finding.status === "regressed"));
  assert.ok(compare(beta.entry, current).every((finding) => finding.status !== "regressed"));
});

test("unknown and unselected hosts skip latency while retaining deterministic regression checks", () => {
  for (const id of [null, "unknown", "linux", "constructor"]) {
    const selected = selectBaseline(baseline(), host(id));
    assert.equal(selected.reference, "legacyHosts.linux");
    assert.equal(selected.latencySkipped, true);
    const current = entry(id);
    current.phases.history.medianMs = 1000000;
    let findings = compare(selected.entry, current, TOLERANCE, { latency: false });
    assert.ok(findings.every((finding) => finding.status !== "regressed"));
    assert.ok(findings.filter((finding) => ["medianMs", "forecastMs"].includes(finding.metric)).every((finding) => finding.status === "skipped" && finding.baseline === null && finding.limit === null));
    current.publication.processes += 1;
    current.materialization.cone.bytes += 1;
    findings = compare(selected.entry, current, TOLERANCE, { latency: false });
    assert.equal(findings.filter((finding) => finding.status === "regressed").length, 2);
  }
  assert.equal(selectBaseline(baseline(), { ...host("unknown"), platform: "darwin" }).entry, null);
  assert.equal(selectBaseline(null, host("alpha")).entry, null);
});

test("reused labels cannot borrow latency after hardware or benchmark settings change", () => {
  for (const change of [{ platform: "win32" }, { arch: "arm64" }, { cpuModels: ["Different CPU"] }, { logicalCpus: 16 }, { memoryBytes: 32000000000 }, { overrides: { VLAB_GIT_SESSION: "1" } }]) {
    const selected = selectBaseline(baseline(), { ...host("alpha"), ...change });
    assert.equal(selected.latencySkipped, true);
    assert.match(selected.reason, /does not match/);
    if (change.overrides) assert.equal(selected.entry, null, "default-mode process counts cannot qualify a transport override");
  }
  const saved = baseline();
  saved.hosts.alpha.host.id = "beta";
  assert.equal(selectBaseline(saved, host("alpha")).latencySkipped, true);
});

test("v2 migration preserves every measurement without assigning an OS entry to a machine", () => {
  const old = { schema: "vcs-lab.benchmark-baseline/v2", profile: PROFILE, tolerance: TOLERANCE, hosts: structuredClone(committed.legacyHosts) };
  const snapshot = structuredClone(old);
  const migrated = migrateBaseline(old);
  assert.deepEqual(old, snapshot);
  assert.equal(migrated.schema, BASELINE_SCHEMA);
  assert.deepEqual(migrated.hosts, {});
  assert.deepEqual(migrated.legacyHosts, old.hosts);
  assert.deepEqual(migrated.profile, old.profile);
  assert.deepEqual(migrated.tolerance, old.tolerance);
  assert.equal(selectBaseline(migrated, host("linux")).latencySkipped, true);
  assert.throws(() => migrateBaseline({ schema: "vcs-lab.benchmark-baseline/v99" }), /migrate it explicitly/);
});

test("recording a labeled host preserves other hosts and all legacy measurements", () => {
  const saved = baseline();
  const snapshot = structuredClone(saved);
  const current = entry("gamma");
  const recorded = recordBaseline(saved, current, PROFILE, TOLERANCE);
  assert.deepEqual(saved, snapshot);
  assert.deepEqual(recorded.hosts.alpha, saved.hosts.alpha);
  assert.deepEqual(recorded.hosts.beta, saved.hosts.beta);
  assert.deepEqual(recorded.hosts.gamma, current);
  assert.deepEqual(recorded.legacyHosts, saved.legacyHosts);
  const legacyBaseline = { schema: "vcs-lab.benchmark-baseline/v2", profile: PROFILE, tolerance: TOLERANCE, hosts: saved.legacyHosts };
  assert.deepEqual(recordBaseline(legacyBaseline, current, PROFILE, TOLERANCE).legacyHosts, saved.legacyHosts);
  assert.equal(recordBaseline(null, current, PROFILE, TOLERANCE).hosts.gamma.host.id, "gamma");
  assert.throws(() => recordBaseline(saved, current, { ...PROFILE, samples: 9 }, TOLERANCE), /preserved/);
  assert.throws(() => recordBaseline(saved, current, PROFILE, { ...TOLERANCE, latencyRatio: 4 }), /preserved/);
  assert.deepEqual(saved, snapshot);
});

test("host options require a safe explicit recording identity and allow CLI precedence", () => {
  assert.equal(parseOptions([], {}).host, null);
  assert.equal(parseOptions([], { VLAB_BENCHMARK_HOST: "alpha" }).host, "alpha");
  assert.deepEqual(parseOptions(["--record", "--json", "--host", "beta"], { VLAB_BENCHMARK_HOST: "alpha" }), { record: true, json: true, host: "beta" });
  for (const args of [["--record"], ["--host"], ["--host", "--json"], ["--host", "../host"], ["--host", "a".repeat(65)], ["--host", "alpha", "--host", "beta"], ["--unknown"]]) {
    assert.throws(() => parseOptions(args, {}));
  }
});

test("record without identity fails before measuring or modifying the committed baseline", () => {
  const baselineFile = path.join(root, "benchmarks/baseline.json");
  const before = fs.readFileSync(baselineFile, "utf8");
  const result = spawnSync(process.execPath, [path.join(root, "scripts/benchmark-regression.mjs"), "--record"], { cwd: root, encoding: "utf8", timeout: 5000, env: testEnv({ VLAB_BENCHMARK_HOST: "", PATH: "" }) });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /Recording requires --host/);
  assert.equal(result.stdout, "");
  assert.equal(fs.readFileSync(baselineFile, "utf8"), before);
});

test("provenance records hardware and execution settings without machine identifiers", () => {
  const provenance = hostProvenance("alpha", { VLAB_GIT_SESSION: "0" });
  assert.deepEqual(Object.keys(provenance).sort(), ["id", "platform", "arch", "cpuModels", "logicalCpus", "memoryBytes", "osRelease", "overrides"].sort());
  assert.equal(provenance.id, "alpha");
  assert.equal(provenance.platform, process.platform);
  assert.equal(provenance.arch, process.arch);
  assert.ok(provenance.logicalCpus > 0);
  assert.ok(provenance.memoryBytes > 0);
  assert.equal(provenance.overrides.VLAB_GIT_SESSION, "0");
});
