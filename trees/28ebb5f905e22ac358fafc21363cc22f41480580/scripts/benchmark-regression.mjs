import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MERGE_TREE_ENGINE_MIN_GIT } from "../src/git.js";
import { BASELINE_SCHEMA, parseOptions, hostProvenance, migrateBaseline, selectBaseline, recordBaseline } from "./benchmark-host.mjs";

/**
 * Compare the bounded benchmarks against the committed per-host baseline
 * (ADR-0017). Process counts must not grow; medians must stay within the
 * documented latency ratio, with an absolute floor so sub-millisecond phases
 * do not fail on scheduler noise. A host without a baseline is skipped with a
 * warning for latency; deterministic comparisons can use legacy OS entries.
 * `--record --host <label>` rewrites an identified host entry from a fresh run.
 *
 * The comparator and the constants are exported so the integration suite can
 * exercise them without measuring anything; the measurement flow runs only
 * when this file is executed directly.
 */
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(projectRoot, "bin", "vlab.js");
export const baselinePath = path.join(projectRoot, "benchmarks", "baseline.json");

export { BASELINE_SCHEMA };
export const PROFILE = {
  name: "reduced-local-v3",
  history: 100,
  workspaces: 4,
  notes: 60,
  resolutions: 12,
  // The fixture's working tree. v1 committed the empty tree everywhere, so a
  // workspace materialized nothing and creation could not be measured at all;
  // v2 gives it a real tree a sparse cone can narrow (issue #10).
  areas: 10,
  filesPerArea: 60,
  samples: 3,
  budgetMs: 1000,
  forecastChanges: 12,
  // The publication queue (issue #15). Publication is the one stretch where
  // work scales with the number of changes — each application publishes its
  // own record, its resolutions, and the provenance carried onto it — and
  // until v3 no phase covered it, so a per-change Git process could be added
  // with nothing to notice. Six is enough for per-change growth to show
  // against the fixed cost around it.
  publishChanges: 6,
};
export const TOLERANCE = { latencyRatio: 2, latencyFloorMs: 5, processes: 0 };
/**
 * The maintainer's stated performance criterion (issue #42): `vlab` must not be
 * worse than 110% of the equivalent plain-Git work, with Node start-up excluded
 * until a native CLI exists.
 *
 * Both sides of this ratio are timed in-process inside one `vlab metadata
 * benchmark` run, so neither includes Node boot or module load: the exclusion
 * is a property of the measurement rather than a correction applied afterwards.
 *
 * **Reported, not enforced.** The criterion is not ratified yet and several
 * phases exceed it today; making it a gate before that decision would turn one
 * stated intent into a failing build. `compare()` is unchanged.
 */
export const GIT_EQUIVALENT_TARGET_RATIO = 1.1;
/** The merge-tree engine floor is the CLI's (`src/git.js`): `merge-tree --stdin` flushes records only from Git 2.49. */
export { MERGE_TREE_ENGINE_MIN_GIT };
export const FORECAST_MODES = {
  "worktree-ordinary": ["--no-git-session", "--forecast-engine", "worktree"],
  "worktree-session": ["--git-session", "--forecast-engine", "worktree"],
  "merge-tree-session": ["--git-session", "--forecast-engine", "merge-tree"],
};
export const SCALE_PHASES = [
  "history",
  "gitWorktrees",
  "workspaceRegistry",
  "workspaceStatus",
  "noteCatalog",
  "resolutionCatalog",
  "metadataStatus",
  "workspaceCreate",
  "workspaceCreateCone",
];
const FIXTURE_PREFIX = "vcs-lab-benchmark-check-";
const activeFixtures = new Set();

function run(command, commandArgs, cwd, env = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${commandArgs.join(" ")} failed with status ${result.status}\n${result.stderr || result.stdout}`,
    );
  }
  return result.stdout;
}

/** Like `run`, but keeps stderr, where the Git trace is written. */
function runCapture(command, commandArgs, cwd, env = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${commandArgs.join(" ")} failed with status ${result.status}`,
    );
  }
  return result;
}

function vlabJson(cwd, commandArgs, env = {}) {
  return JSON.parse(run(process.execPath, [cli, ...commandArgs, "--json"], cwd, env));
}

function gitVersion() {
  const result = spawnSync("git", ["--version"], { encoding: "utf8" });
  return (result.stdout ?? "").trim();
}

function gitAtLeast(required, raw = gitVersion()) {
  const match = raw.match(/(\d+)\.(\d+)/);
  if (!match) return true;
  const [major, minor] = [Number(match[1]), Number(match[2])];
  const [wantMajor, wantMinor] = required.split(".").map(Number);
  return major > wantMajor || (major === wantMajor && minor >= wantMinor);
}

/**
 * The forecast modes this host can measure: the merge-tree mode is left out
 * (and reported as skipped) when Git is older than the engine needs, because
 * every merge-tree forecast would fall back to the worktree simulator there.
 */
export function availableForecastModes(gitVersionText = gitVersion()) {
  const mergeTree = gitAtLeast(MERGE_TREE_ENGINE_MIN_GIT, gitVersionText);
  return Object.fromEntries(
    Object.entries(FORECAST_MODES).filter(
      ([mode]) => mergeTree || !mode.startsWith("merge-tree"),
    ),
  );
}

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), FIXTURE_PREFIX));
  activeFixtures.add(root);
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  run("git", ["init", "-q", "-b", "main"], repo);
  run("git", ["config", "core.autocrlf", "false"], repo);
  run("git", ["config", "core.eol", "lf"], repo);
  run("git", ["config", "user.name", "VCS Lab Benchmark"], repo);
  run("git", ["config", "user.email", "vcs-lab-benchmark@example.invalid"], repo);
  return { root, repo };
}

function removeFixture(root) {
  fs.rmSync(root, { recursive: true, force: true });
  activeFixtures.delete(root);
}

function removeAllFixtures() {
  for (const root of activeFixtures) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // Best effort on the way out.
    }
  }
  activeFixtures.clear();
}

function measureScale() {
  const { root, repo } = makeRepo();
  try {
    const report = vlabJson(repo, [
      "metadata", "benchmark",
      "--history", String(PROFILE.history),
      "--workspaces", String(PROFILE.workspaces),
      "--notes", String(PROFILE.notes),
      "--resolutions", String(PROFILE.resolutions),
      "--areas", String(PROFILE.areas),
      "--files-per-area", String(PROFILE.filesPerArea),
      "--samples", String(PROFILE.samples),
      "--budget-ms", String(PROFILE.budgetMs),
    ]);
    const phases = {};
    for (const name of SCALE_PHASES) {
      const measurement = report.measurements[name];
      if (!measurement) throw new Error(`The scale benchmark reported no '${name}' phase.`);
      phases[name] = {
        medianMs: measurement.medianMs,
        p95Ms: measurement.p95Ms,
        medianProcesses: measurement.medianProcesses,
        floor: measurement.floor ?? null,
      };
    }
    return {
      environment: report.environment,
      phases,
      materialization: report.materialization,
    };
  } finally {
    removeFixture(root);
  }
}

function measureForecasts(modes) {
  const { root, repo } = makeRepo();
  try {
    const historyFile = path.join(repo, "history.txt");
    fs.writeFileSync(historyFile, "base\n");
    run("git", ["add", "history.txt"], repo);
    run("git", ["commit", "-q", "-m", "base"], repo);
    run(process.execPath, [cli, "init"], repo);
    run("git", ["switch", "-q", "-c", "feature"], repo);
    for (let index = 1; index <= PROFILE.forecastChanges; index += 1) {
      fs.writeFileSync(historyFile, `${index}\n`);
      run("git", ["add", "history.txt"], repo);
      run(
        "git",
        ["commit", "-q", "-m", `feature ${index}\n\nChange-Id: ch_benchmark_${index}`],
        repo,
      );
    }
    run("git", ["switch", "-q", "main"], repo);

    const measured = {};
    const projections = new Map();
    for (const [mode, flags] of Object.entries(modes)) {
      const forecast = vlabJson(repo, ["forecast", "feature", ...flags]);
      if (forecast.status !== "complete") {
        throw new Error(`The ${mode} forecast did not complete: ${forecast.blockedReason}`);
      }
      measured[mode] = {
        engine: forecast.engine,
        fallbacks: forecast.fallbacks.length,
        processes: forecast.timings.git.processes,
        queries: forecast.timings.git.count,
        forecastMs: forecast.timings.forecastMs,
      };
      projections.set(mode, JSON.stringify({
        changes: forecast.plan.changes,
        predictedResultTree: forecast.predictedResultTree,
        steps: forecast.steps.map((step) => [
          step.outcome,
          step.targetBeforeTree,
          step.resultTree,
        ]),
      }));
    }
    const reference = projections.get("worktree-ordinary");
    for (const [mode, projection] of projections) {
      if (projection !== reference) {
        throw new Error(
          `Forecast mode '${mode}' produced different plans or trees than worktree-ordinary; this is a correctness regression, not a performance one.`,
        );
      }
    }
    if (measured["merge-tree-session"] && measured["merge-tree-session"].engine !== "merge-tree") {
      throw new Error("The merge-tree forecast mode fell back to the worktree simulator on a clean queue.");
    }
    return measured;
  } finally {
    removeFixture(root);
  }
}

/**
 * Measure a whole `vlab reconcile` invocation over a fixed queue (issue #15).
 *
 * This is the gap the other phases leave. Every scale phase is a read, and the
 * forecast phases simulate without publishing, so nothing measured the
 * publication loop — the one stretch whose work scales with the number of
 * changes, since each application publishes its own record, its resolutions,
 * and the provenance carried onto it. A per-change Git process was added there
 * and passed the whole suite, all five suite modes, and this very check.
 *
 * Counted from the trace rather than from the receipt on purpose: the receipt's
 * `timings.git` block covers the application phase only, because the receipt is
 * built before publication runs. The trace is the only place the whole cost of
 * the command appears, and FR-PERF-07 makes its shape a contract.
 *
 * Provenance is declared on the source commits so the carry path actually runs.
 * With none in the repository it returns before its loop, and a regression
 * inside it would be invisible — which is exactly how the original one hid.
 */
function measurePublication() {
  const { root, repo } = makeRepo();
  try {
    fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
    run("git", ["add", "-A"], repo);
    run("git", ["commit", "-q", "-m", "base"], repo);
    run(process.execPath, [cli, "init"], repo);

    run("git", ["switch", "-q", "-c", "feature"], repo);
    for (let index = 1; index <= PROFILE.publishChanges; index += 1) {
      // Distinct files, so the queue applies cleanly and the phase measures
      // publication rather than conflict handling.
      fs.writeFileSync(path.join(repo, `change-${index}.txt`), `${index}\n`);
      run("git", ["add", "-A"], repo);
      run(
        process.execPath,
        [cli, "commit", "-m", `publish ${index}`],
        repo,
        { VLAB_AGENT: "benchmark-agent" },
      );
    }
    run("git", ["switch", "-q", "main"], repo);
    fs.writeFileSync(path.join(repo, "target.txt"), "target\n");
    run("git", ["add", "-A"], repo);
    run("git", ["commit", "-q", "-m", "target moves"], repo);

    const reconciled = runCapture(
      process.execPath,
      [cli, "reconcile", "feature", "--json"],
      repo,
      { VLAB_TRACE: "1" },
    );
    const receipt = JSON.parse(reconciled.stdout).receipt;
    const applied = receipt.applied?.length ?? 0;
    if (applied !== PROFILE.publishChanges) {
      throw new Error(
        `The publication phase applied ${applied} changes, not ${PROFILE.publishChanges}; `
        + "the fixture is not measuring what it claims to.",
      );
    }

    // Every process the invocation started, persistent sessions included.
    const processes =
      (reconciled.stderr.match(/\(new (?:persistent )?process\)/g) ?? []).length;
    const records = JSON.parse(
      run(process.execPath, [cli, "receipts", "--json"], repo),
    ).length;

    return {
      changes: PROFILE.publishChanges,
      processes,
      records,
      elapsedMs: round(receipt.timings?.elapsedWallMs ?? 0),
    };
  } finally {
    removeFixture(root);
  }
}

/** Read-only normalization preserves v2 measurements as unidentified history. */
function readBaseline() {
  if (!fs.existsSync(baselinePath)) return null;
  return migrateBaseline(JSON.parse(fs.readFileSync(baselinePath, "utf8")));
}

function round(value) {
  return Number(value.toFixed(2));
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Compare one host's baseline entry with a fresh measurement. A process count
 * above the baseline plus `tolerance.processes` regresses; a median above
 * `max(baseline * latencyRatio, baseline + latencyFloorMs)` regresses. A
 * phase or forecast mode missing from either side is reported as `skipped`,
 * never as a regression, so a host whose Git cannot run the merge-tree engine
 * still checks everything else.
 */
export function compare(entry, current, tolerance = TOLERANCE, { latency = true } = {}) {
  const findings = [];
  const check = (subject, metric, before, after, kind) => {
    if (kind === "latency" && !latency) {
      findings.push({ subject, metric, baseline: null, current: after, limit: null, status: "skipped", reason: "No matching identified host baseline." });
      return;
    }
    const limit = kind === "processes"
      ? before + tolerance.processes
      : round(Math.max(before * tolerance.latencyRatio, before + tolerance.latencyFloorMs));
    const regressed = after > limit;
    findings.push({
      subject,
      metric,
      baseline: before,
      current: after,
      limit,
      status: regressed
        ? "regressed"
        : after < before
          ? "improved"
          : after > before
            ? "tolerated"
            : "unchanged",
    });
  };
  const skip = (subject, metric) => {
    findings.push({ subject, metric, baseline: null, current: null, limit: null, status: "skipped" });
  };
  for (const name of SCALE_PHASES) {
    const before = entry.phases?.[name];
    const after = current.phases?.[name];
    if (!before || !after) {
      skip(`scale:${name}`, "medianProcesses");
      skip(`scale:${name}`, "medianMs");
      continue;
    }
    check(`scale:${name}`, "medianProcesses", before.medianProcesses, after.medianProcesses, "processes");
    check(`scale:${name}`, "medianMs", before.medianMs, after.medianMs, "latency");
  }
  for (const mode of Object.keys(FORECAST_MODES)) {
    const before = entry.forecast?.[mode];
    const after = current.forecast?.[mode];
    if (!before || !after) {
      skip(`forecast:${mode}`, "processes");
      skip(`forecast:${mode}`, "forecastMs");
      continue;
    }
    check(`forecast:${mode}`, "processes", before.processes, after.processes, "processes");
    check(`forecast:${mode}`, "forecastMs", before.forecastMs, after.forecastMs, "latency");
  }
  // The publication loop (issue #15). Held to the process rule: the fixture
  // is deterministic and the queue is fixed, so any growth is a real change in
  // what publishing a change costs, not host noise. `records` is a semantic
  // guard rather than a performance one — if it moves, the phase stopped
  // measuring what it claims to.
  if (!entry.publication || !current.publication) {
    skip("publication", "processes");
    skip("publication", "records");
  } else {
    check("publication", "processes", entry.publication.processes, current.publication.processes, "processes");
    check("publication", "records", entry.publication.records, current.publication.records, "processes");
  }
  // Materialized bytes are what a sparse cone exists to reduce, and the
  // fixture is deterministic, so growth is a real change in what a workspace
  // writes rather than host noise. Held to the process rule: no growth at all.
  for (const arm of ["full", "cone"]) {
    const before = entry.materialization?.[arm];
    const after = current.materialization?.[arm];
    if (!before || !after) {
      skip(`materialization:${arm}`, "files");
      skip(`materialization:${arm}`, "bytes");
      continue;
    }
    check(`materialization:${arm}`, "files", before.files, after.files, "processes");
    check(`materialization:${arm}`, "bytes", before.bytes, after.bytes, "processes");
  }
  return findings;
}

function formatFindings(findings) {
  const width = Math.max(...findings.map((item) => `${item.subject} ${item.metric}`.length));
  return findings.map((item) => {
    const label = `${item.subject} ${item.metric}`.padEnd(width);
    if (item.status === "skipped") return `${label}  skipped (${item.reason ?? "not measured on this host or absent from the baseline"})`;
    return `${label}  ${String(item.baseline).padStart(9)} -> ${String(item.current).padStart(9)}  (limit ${item.limit})  ${item.status}`;
  }).join("\n");
}

export function formatGitEquivalents(phases) {
  const rows = [];
  for (const name of SCALE_PHASES) {
    const phase = phases?.[name];
    if (phase) rows.push({ name, phase, floor: phase.floor });
  }
  if (!rows.length || rows.every((row) => !row.floor)) return null;
  const width = Math.max(...rows.map((row) => row.name.length));
  const lines = rows.map(({ name, phase, floor }) => {
    const label = name.padEnd(width);
    if (!floor) return `${label}  ${String(phase.medianMs).padStart(9)} ms  no plain-Git equivalent`;
    const ratio = floor.medianMs ? phase.medianMs / floor.medianMs : null;
    const verdict = ratio === null
      ? "floor too small to divide"
      : `${(ratio * 100).toFixed(0)}%${ratio > GIT_EQUIVALENT_TARGET_RATIO ? "  over" : ""}`;
    return `${label}  ${String(phase.medianMs).padStart(9)} ms vs ${String(floor.medianMs).padStart(9)} ms `
      + `(${String(phase.medianProcesses).padStart(2)} vs ${String(floor.medianProcesses).padStart(2)} processes)  ${verdict}`;
  });
  return [
    `\nWork against the plain-Git equivalent (Node start-up excluded from both sides; target ${(GIT_EQUIVALENT_TARGET_RATIO * 100).toFixed(0)}%, reported not enforced)`,
    ...lines,
  ].join("\n");
}

function main() {
  // Refuse invalid recording requests before building any benchmark fixtures.
  const { record, json, host: hostKey } = parseOptions(process.argv.slice(2));
  const host = hostProvenance(hostKey);
  const baseline = readBaseline();
  if (baseline && (!sameJson(baseline.profile, PROFILE) || !sameJson(baseline.tolerance, TOLERANCE))) {
    throw new Error("The baseline profile or tolerance differs; migrate it explicitly before checking or recording.");
  }
  process.on("SIGINT", () => {
    removeAllFixtures();
    process.exit(130);
  });

  const gitVersionText = gitVersion();
  const modes = availableForecastModes(gitVersionText);
  const skippedModes = Object.keys(FORECAST_MODES).filter((mode) => !(mode in modes));
  const notes = skippedModes.map(
    (mode) => `Forecast mode '${mode}' was not measured: the merge-tree engine needs Git ${MERGE_TREE_ENGINE_MIN_GIT} or newer (host has ${gitVersionText || "an unknown Git"}).`,
  );

  let scale;
  let forecast;
  let publication;
  try {
    scale = measureScale();
    forecast = measureForecasts(modes);
    publication = measurePublication();
  } finally {
    removeAllFixtures();
  }
  const current = {
    host,
    recordedAt: new Date().toISOString().slice(0, 10),
    git: scale.environment.git,
    node: scale.environment.node,
    phases: scale.phases,
    materialization: scale.materialization,
    forecast,
    publication,
  };

  if (record) {
    const next = recordBaseline(baseline, current, PROFILE, TOLERANCE);
    fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
    fs.writeFileSync(baselinePath, `${JSON.stringify(next, null, 2)}\n`);
    const message = `Recorded host '${hostKey}' in ${path.relative(projectRoot, baselinePath)}; other entries and historical measurements were preserved.`;
    const recordedEquivalents = formatGitEquivalents(current.phases);
    console.log(json
      ? JSON.stringify({ recorded: hostKey, baseline: current, notes }, null, 2)
      : [message, ...notes, ...(recordedEquivalents ? [recordedEquivalents] : [])].join("\n"));
    process.exit(0);
  }

  const selection = selectBaseline(baseline, host);
  const { entry, reference, latencySkipped, reason } = selection;
  if (latencySkipped) notes.push(`Latency comparison skipped: ${reason} Record deliberately on a quiet host with npm run benchmark:record -- --host <label>. This run does not qualify host latency.`);
  if (!entry) {
    notes.push("No compatible deterministic reference; forecast semantic checks ran, but baseline comparisons were skipped.");
    console.log(json ? JSON.stringify({ host: hostKey, reference, skipped: true, latencySkipped, current, notes }, null, 2) : notes.join("\n"));
    process.exit(0);
  }
  const findings = compare(entry, current, baseline.tolerance, { latency: !latencySkipped });
  const regressions = findings.filter((item) => item.status === "regressed");
  if (json) {
    console.log(JSON.stringify({
      host: hostKey,
      reference,
      latencySkipped,
      baseline: entry,
      current,
      tolerance: baseline.tolerance,
      findings,
      notes,
      passed: regressions.length === 0,
    }, null, 2));
  } else {
    console.log(`Benchmark ${latencySkipped ? "deterministic-only" : "regression"} check using ${reference} against the ${entry.recordedAt} baseline (${entry.git}, Node ${entry.node})`);
    console.log(formatFindings(findings));
    const equivalents = formatGitEquivalents(current.phases);
    if (equivalents) console.log(equivalents);
    for (const note of notes) console.log(note);
    console.log(
      regressions.length === 0
        ? latencySkipped
          ? "\nNo deterministic regression; latency comparison was skipped."
          : "\nNo regression: process counts did not grow and medians stayed within the tolerated ratio."
        : `\n${regressions.length} regression${regressions.length === 1 ? "" : "s"}: fix the cause or re-record the baseline deliberately with npm run benchmark:record and explain the change in the changelog.`,
    );
  }
  process.exit(regressions.length === 0 ? 0 : 1);
}

const invokedDirectly = process.argv[1] &&
  path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (invokedDirectly) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
