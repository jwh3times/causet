import assert from "node:assert/strict";
import test from "node:test";
import { buildAnalysis } from "../src/scale-benchmark.js";
import { formatGitEquivalents, GIT_EQUIVALENT_TARGET_RATIO } from "../scripts/benchmark-regression.mjs";
import "../test-support/git-environment.js";

const fixture = { workspaces: 2, totalNoteTargets: 11, resolutions: 8 };
function measurements(medianMs) {
  return {
    workspaceStatus: { medianMs, medianProcesses: 2 },
    noteCatalog: { medianMs, medianProcesses: 3 },
    resolutionCatalog: { medianMs, medianProcesses: 4 },
  };
}

test("batched scans below or exactly at the latency budget request more host evidence", () => {
  for (const time of [4999, 5000]) {
    const analysis = buildAnalysis(measurements(time), fixture, 5000);
    assert.deepEqual(analysis.phasesOverBudget, []);
    assert.equal(analysis.nextAction, "increase-fixture-volume-and-collect-more-hosts");
    assert.equal(analysis.persistentIndex.recommendedNow, false);
    assert.equal(analysis.recommendations[0].priority, "retain-batched-scan");
    assert.equal(analysis.residentService.recommendedNow, false);
  }
});

test("slow hosts legitimately recommend catalog evaluation without recommending a service", () => {
  const measured = measurements(5000);
  measured.noteCatalog.medianMs = 5001;
  const analysis = buildAnalysis(measured, fixture, 5000);
  assert.deepEqual(analysis.phasesOverBudget, ["noteCatalog"]);
  assert.equal(analysis.nextAction, "evaluate-incremental-catalogs");
  assert.equal(analysis.persistentIndex.recommendedNow, true);
  assert.equal(analysis.recommendations[0].priority, "measure-index-after-batching");
  assert.equal(analysis.residentService.recommendedNow, false);
});

test("tiny fixtures distinguish a fixed batch cost from latency on slow hosts", () => {
  const analysis = buildAnalysis(measurements(6000), { ...fixture, workspaces: 0, resolutions: 2 }, 5000);
  assert.equal(analysis.processAmplification.decidable.resolutionCatalog, false);
  assert.deepEqual(analysis.recommendations.map(({ area, priority }) => [area, priority]), [
    ["resolution-catalog", "increase-fixture-volume"],
    ["note-catalog", "measure-index-after-batching"],
  ]);
  assert.deepEqual(analysis.phasesOverBudget, ["noteCatalog", "resolutionCatalog", "workspaceStatus"]);
  assert.equal(analysis.nextAction, "evaluate-incremental-catalogs");
  assert.equal(analysis.persistentIndex.recommendedNow, true);
});

test("representative per-entity process amplification takes priority over indexing", () => {
  const measured = measurements(6000);
  measured.workspaceStatus.medianProcesses = 20;
  const analysis = buildAnalysis(measured, { ...fixture, workspaces: 10 }, 5000);
  assert.equal(analysis.processAmplification.decidable.workspaceStatus, true);
  assert.equal(analysis.recommendations[0].priority, "batch-first");
  assert.equal(analysis.nextAction, "batch-process-amplified-scans");
  assert.equal(analysis.persistentIndex.recommendedNow, false);
  assert.equal(analysis.residentService.recommendedNow, false);
});

// ---------------------------------------------------------------------------
// Raw-Git floors (issue #42). The ratio is reported, never enforced: these
// assert what the report says, and that `compare()` stays out of it.
// ---------------------------------------------------------------------------

function phase(medianMs, medianProcesses, floorMs, floorProcesses) {
  return {
    medianMs,
    p95Ms: medianMs,
    medianProcesses,
    floor: floorMs === null
      ? null
      : { equivalent: "git rev-list --count refs/heads/main", medianMs: floorMs, p95Ms: floorMs, medianProcesses: floorProcesses },
  };
}

test("a phase within the Git-equivalent target is reported without a verdict", () => {
  const report = formatGitEquivalents({ history: phase(103, 1, 100, 1) });
  assert.match(report, /history/);
  assert.match(report, /103%/);
  assert.doesNotMatch(report, /over/);
});

test("a phase past the Git-equivalent target is marked over and shows both process counts", () => {
  const report = formatGitEquivalents({ resolutionCatalog: phase(300, 6, 100, 2) });
  assert.match(report, /300%\s+over/);
  assert.match(report, /6 vs\s+2 processes/);
});

test("the target boundary is inclusive, so exactly 110% is not a miss", () => {
  assert.equal(GIT_EQUIVALENT_TARGET_RATIO, 1.1);
  assert.doesNotMatch(formatGitEquivalents({ history: phase(110, 1, 100, 1) }), /over/);
  assert.match(formatGitEquivalents({ history: phase(111, 1, 100, 1) }), /over/);
});

test("a phase Git cannot do is reported as having no equivalent rather than a ratio", () => {
  // Alongside a phase that does have one: a report of nothing but floorless
  // phases is the legacy case below, and renders nothing at all.
  const report = formatGitEquivalents({
    history: phase(103, 1, 100, 1),
    workspaceRegistry: phase(0.31, 0, null),
  });
  const registryLine = report.split("\n").find((line) => line.includes("workspaceRegistry"));
  assert.match(registryLine, /no plain-Git equivalent/);
  assert.doesNotMatch(registryLine, /%/);
});

test("a baseline recorded before floors existed reports nothing instead of failing", () => {
  const legacy = { history: { medianMs: 40, p95Ms: 41, medianProcesses: 1 } };
  assert.equal(formatGitEquivalents(legacy), null);
  assert.equal(formatGitEquivalents({}), null);
  assert.equal(formatGitEquivalents(undefined), null);
});
