import assert from "node:assert/strict";
import test from "node:test";
import { buildAnalysis } from "../src/scale-benchmark.js";
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
