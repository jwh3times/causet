import assert from "node:assert/strict";
import test from "node:test";
import { formatGitEquivalents, GIT_EQUIVALENT_TARGET_RATIO } from "../scripts/benchmark-regression.mjs";
import "../test-support/git-environment.js";

// The scale benchmark's analysis (`buildAnalysis` until #243) is tested where
// it is implemented, in `native/cli/src/scale_benchmark.rs`. What remains here
// is the regression script's report.

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
