/**
 * The real repositories (#309, ADR-0044 items 1 and 2, ADR-0045 decision 13):
 * causet's own history, git/git and the large-file corpus
 * (`test-support/real-repositories.js`), each through every N1 check and the
 * storage gate (`test-support/real-repository-check.js`).
 *
 * They fetch from the network and take minutes to an hour each, so the
 * suite has a test for each only when `CAUSET_REAL_REPOSITORIES` names it,
 * comma separated or `all`, as `.github/workflows/corpora.yml` does. A test
 * that skipped itself would count against the suite jobs, which expect only
 * the skips they know (`ci.yml`, "Nothing self-skipped unexpectedly").
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { testEnv } from "../test-support/git-environment.js";
import { cstPrefix } from "../test-support/cst-command.js";
import { REAL_REPOSITORIES } from "../test-support/real-repositories.js";
import { checkRepository } from "../test-support/real-repository-check.js";

const named = (process.env.CAUSET_REAL_REPOSITORIES ?? "").split(",").map((name) => name.trim()).filter(Boolean);
const chosen = named.includes("all") ? Object.keys(REAL_REPOSITORIES) : named;
for (const name of chosen) {
  if (!REAL_REPOSITORIES[name]) {
    throw new Error(`CAUSET_REAL_REPOSITORIES names ${name}; the real repositories are ${Object.keys(REAL_REPOSITORIES).join(", ")} and all`);
  }
}

const megabytes = (bytes) => `${(bytes / 1e6).toFixed(2)} MB`;

/**
 * What each import cost, as Markdown table rows: reported, never checked
 * (#347). Peak memory is unavailable where the system does not tell a
 * process its own without unsafe code; where it does, each phase shows the
 * peak as it ended, so the first to reach the import's peak set it.
 */
function costs(imports) {
  const size = (bytes) => (bytes < 1e3 ? `${bytes} B` : bytes < 1e6 ? `${(bytes / 1e3).toFixed(1)} kB` : megabytes(bytes));
  return Object.entries(imports).map(([label, cost]) => {
    const memory = cost.peakMemory === null ? "unavailable" : size(cost.peakMemory);
    const phases = Object.entries(cost.phases).map(([name, phase]) =>
      `${name} ${phase.seconds.toFixed(1)}${phase.peakMemory === null ? "" : ` (${size(phase.peakMemory)})`}`).join(", ");
    return `| ${label} | ${cost.seconds.toFixed(1)} s | ${memory} | ${size(cost.heldMetadata)} | ${phases} |`;
  });
}

/** The report of one repository as Markdown, for the workflow's summary. */
function summary(report) {
  const parts = (side) => Object.entries(side.parts).sort().map(([part, bytes]) => `${part} ${bytes}`).join(", ");
  const lines = [
    `### ${report.name}: storage gate ${report.gate}, ${(report.native.total / report.git.total).toFixed(3)} times Git's bytes`,
    "",
    "| | Bytes | Parts |",
    "| --- | ---: | --- |",
    `| cst store | ${report.native.total} (${megabytes(report.native.total)}) | ${parts(report.native)} |`,
    `| git gc --aggressive | ${report.git.total} (${megabytes(report.git.total)}) | ${parts(report.git)} |`,
    "",
    `${report.objects} Git objects. What each import cost, never checked:`,
    "",
    "| Import | Time | Peak memory | Held metadata | Seconds by phase (peak memory as it ended) |",
    "| --- | ---: | ---: | ---: | --- |",
    ...costs(report.imports),
    "",
  ];
  return `${lines.join("\n")}\n`;
}

for (const name of chosen) {
  test(`the real repository ${name} passes every N1 check and the storage gate`, async (t) => {
    const report = await checkRepository({ name, env: testEnv });
    // The check ran the CLI: counted here for the report of tests that never
    // invoke a selected CLI (`git-environment.js`).
    cstPrefix();
    if (report.native && report.git) {
      t.diagnostic(`${name}: cst store ${report.native.total} bytes, git gc --aggressive ${report.git.total} bytes, storage gate ${report.gate}`);
      if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary(report));
    }
    t.diagnostic(`${name}: import costs ${JSON.stringify(report.imports)}`);
    assert.deepEqual(report.problems, []);
  });
}
