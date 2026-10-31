#!/usr/bin/env node
/**
 * Whole-command performance checkpoint for the Rust CLI program (ADR-0037,
 * issue #151). Times complete `vlab` invocations, per implementation, against
 * a plain-Git floor, on pinned fixtures, and records every sample.
 *
 * Results are information, never a gate: the script exits non-zero only when
 * it could not measure (a failed command, a mismatched output, a noisy host
 * without --allow-noisy), never because something was slow.
 *
 * Procedure: https://github.com/jwh3times/vcs-lab/wiki/Performance-testing
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { hostProvenance } from "./benchmark-host.mjs";

const FORMAT = "perf-checkpoint-v1";
const script = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(script), "..");

const USAGE = `Usage: node scripts/perf-checkpoint.mjs --host <label> --checkpoint <n> --output <file.json>
  [--markdown <file.md>]        also write the wiki summary
  [--impl <name>=<executable>]  add an implementation (repeatable); "js" is always included
  [--samples <n>]               timed samples per measurement (default 21)
  [--warmup <n>]                untimed warm-up runs per measurement (default 3)
  [--suites <list>]             startup,reads,writes (default all)
  [--engines <list>]            read engines: git,native (default both; native skipped without a binding)
  [--real-rev <rev>]            real-clone revision (default v0.18.0)
  [--real-notes <commit>]       real-clone notes commit (default 4089785)
  [--max-cpu <percent>]         abort if host CPU load starts above this (default 30)
  [--allow-noisy]               record a noisy host instead of aborting
  [--note <text>]               free-text load note recorded with the run
  [--keep]                      keep the fixtures directory for inspection`;

// ---------------------------------------------------------------- arguments

function parseArgs(argv) {
  const options = {
    impls: [], samples: 21, warmup: 3, suites: ["startup", "reads", "writes"],
    engines: ["git", "native"], realRev: "v0.18.0", realNotes: "4089785",
    maxCpu: 30, allowNoisy: false, keep: false, note: null, markdown: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = () => {
      const next = argv[++index];
      if (next === undefined) throw new Error(`${flag} needs a value\n${USAGE}`);
      return next;
    };
    if (flag === "--host") options.host = value();
    else if (flag === "--checkpoint") options.checkpoint = value();
    else if (flag === "--output") options.output = path.resolve(value());
    else if (flag === "--markdown") options.markdown = path.resolve(value());
    else if (flag === "--impl") {
      const [name, ...rest] = value().split("=");
      const executable = rest.join("=");
      if (!name || !executable || name === "js") throw new Error(`--impl expects <name>=<executable> (not js)\n${USAGE}`);
      options.impls.push({ name, command: [path.resolve(executable)] });
    } else if (flag === "--samples") options.samples = Number(value());
    else if (flag === "--warmup") options.warmup = Number(value());
    else if (flag === "--suites") options.suites = value().split(",");
    else if (flag === "--engines") options.engines = value().split(",");
    else if (flag === "--real-rev") options.realRev = value();
    else if (flag === "--real-notes") options.realNotes = value();
    else if (flag === "--max-cpu") options.maxCpu = Number(value());
    else if (flag === "--allow-noisy") options.allowNoisy = true;
    else if (flag === "--keep") options.keep = true;
    else if (flag === "--note") options.note = value();
    else if (flag === "--help") { console.log(USAGE); process.exit(0); }
    else throw new Error(`Unknown argument ${flag}\n${USAGE}`);
  }
  if (!options.host || options.checkpoint === undefined || !options.output) throw new Error(USAGE);
  if (fs.existsSync(options.output)) throw new Error(`${options.output} exists; choose a new output file`);
  assert.ok(options.samples >= 5, "--samples must be at least 5");
  options.impls.unshift({ name: "js", command: [process.execPath, path.join(root, "bin/vlab.js")] });
  return options;
}

// -------------------------------------------------------------- environment

const perfGitConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "vlab-perf-gitconfig-"));
const perfGitConfig = path.join(perfGitConfigDir, "gitconfig");
// Removed on every exit path, including an argument or load-guard failure.
process.on("exit", () => fs.rmSync(perfGitConfigDir, { recursive: true, force: true }));
fs.writeFileSync(perfGitConfig, [
  "[user]", "\tname = Perf Bench", "\temail = perf@example.invalid",
  "[core]", "\tautocrlf = false",
  "[init]", "\tdefaultBranch = main",
  "[advice]", "\tdetachedHead = false", "",
].join("\n"));

/** One controlled environment for every child: isolated Git config, no launcher overrides. */
function childEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+|PARAMETERS)$/.test(key) || key.startsWith("VLAB_")) delete env[key];
  }
  return {
    ...env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: perfGitConfig,
    GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z", ...extra,
  };
}

function run(command, args, cwd, env = childEnv(), { allowFailure = false } = {}) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, windowsHide: true });
  if (!allowFailure && (result.error || result.status !== 0)) {
    throw new Error(`${command} ${args.join(" ")} (in ${cwd}) failed with ${result.status}: ${result.error?.message ?? result.stderr}`);
  }
  return result;
}
const git = (cwd, ...args) => run("git", args, cwd).stdout.trim();

function removeTree(target) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try { fs.rmSync(target, { recursive: true, force: true, maxRetries: 3 }); return; } catch (error) {
      if (attempt === 4) throw error;
      // Git marks object files read-only; make the tree writable and retry.
      spawnSync(process.platform === "win32" ? "attrib" : "chmod",
        process.platform === "win32" ? ["-R", `${target}\\*`, "/S", "/D"] : ["-R", "u+w", target]);
    }
  }
}

// ------------------------------------------------------------------ host load

/**
 * Busy percentage of all CPUs over one second, from the kernel's per-CPU
 * counters. Spawning a probe (PowerShell, typeperf) would itself load the
 * host it is measuring, so nothing is spawned.
 */
function cpuLoadPercent() {
  const totals = () => os.cpus().reduce((sum, cpu) => {
    const time = cpu.times;
    return { idle: sum.idle + time.idle, all: sum.all + time.user + time.nice + time.sys + time.idle + time.irq };
  }, { idle: 0, all: 0 });
  const before = totals();
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  const after = totals();
  const all = after.all - before.all;
  return all > 0 ? Math.round((1 - (after.idle - before.idle) / all) * 100) : null;
}
function loadSample(label) {
  // Sustained load, not a momentary spike, decides whether a host is quiet:
  // the median of five readings is the figure; the maximum is recorded too.
  const samples = [];
  for (let index = 0; index < 5; index += 1) samples.push(cpuLoadPercent());
  const valid = samples.filter((value) => value !== null).sort((a, b) => a - b);
  return {
    label, at: new Date().toISOString(),
    cpuPercent: valid.length ? valid[Math.floor(valid.length / 2)] : null,
    cpuMaxPercent: valid.length ? valid.at(-1) : null, cpuSamples: samples,
    freeMemoryBytes: os.freemem(),
  };
}

// ---------------------------------------------------------------- statistics

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (fraction) => {
    const position = (sorted.length - 1) * fraction;
    const low = Math.floor(position);
    const high = Math.ceil(position);
    return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
  };
  const round = (value) => Math.round(value * 100) / 100;
  return {
    n: sorted.length, medianMs: round(at(0.5)), p10Ms: round(at(0.1)), p90Ms: round(at(0.9)),
    minMs: round(sorted[0]), maxMs: round(sorted.at(-1)), iqrMs: round(at(0.75) - at(0.25)),
    meanMs: round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length),
  };
}
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
// `[vlab trace]` is the prefix before #159, so earlier builds stay measurable (ADR-0039 §1).
const traceProcesses = (stderr) => stderr.split(/\r?\n/)
  .filter((line) => /^\[(?:cst|vlab) trace\] .* \((new process|new persistent process)\)$/.test(line)).length;

// ------------------------------------------------------------------ fixtures

function buildTemplate(dir, js) {
  // A small deterministic repository: history, a compact landing with
  // receipts and carried provenance, a diverged feature branch of vlab
  // commits, and a Markdown spec. Built once per run; write scenarios copy it.
  fs.mkdirSync(dir, { recursive: true });
  const vlab = (...args) => run(js.command[0], [...js.command.slice(1), ...args], dir);
  git(dir, "init", "-q", "-b", "main");
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  };
  const areas = ["core", "cli", "docs", "engine", "store"];
  const commitMain = (index) => {
    const area = areas[index % areas.length];
    write(`src/${area}/file-${index % 7}.txt`, `${area} revision ${index}\n`.repeat(20));
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", `main change ${index}`);
  };
  write("specs/design.md", ["# Design", "", ...Array.from({ length: 12 }, (_, i) =>
    `## Section ${i + 1}\n\nRequirement ${i + 1} describes behaviour ${i + 1}.\n`)].join("\n"));
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "initial layout");
  for (let index = 1; index <= 20; index += 1) commitMain(index);
  vlab("init");
  git(dir, "switch", "-q", "-c", "topic");
  for (let index = 1; index <= 2; index += 1) {
    write(`topic/part-${index}.txt`, `topic ${index}\n`);
    git(dir, "add", "-A");
    vlab("commit", "-m", `topic change ${index}`, "--generated-by", "perf-bench");
  }
  git(dir, "switch", "-q", "main");
  vlab("merge", "topic", "--compact", "-m", "land topic");
  for (let index = 21; index <= 25; index += 1) commitMain(index);
  git(dir, "switch", "-q", "-c", "feature");
  for (let index = 1; index <= 4; index += 1) {
    write(`feature/part-${index}.txt`, `feature ${index}\n`.repeat(10));
    git(dir, "add", "-A");
    vlab("commit", "-m", `feature change ${index}`, "--generated-by", "perf-bench");
  }
  git(dir, "switch", "-q", "main");
  for (let index = 26; index <= 28; index += 1) commitMain(index);
  const commits = Number(git(dir, "rev-list", "--count", "--all"));
  const mainCommits = Number(git(dir, "rev-list", "--count", "main"));
  return {
    name: "template", path: dir,
    description: `deterministic repository: ${mainCommits} commits on main (${commits} across all refs, including notes), one compact landing with receipts and carried provenance, a feature branch of 4 vlab commits diverged by 3, a 12-section Markdown spec`,
    head: git(dir, "rev-parse", "HEAD"), featureTip: git(dir, "rev-parse", "feature"),
    commits, mainCommits, trackedFiles: git(dir, "ls-files").split("\n").length,
  };
}

function buildReal(dir, options) {
  const source = git(root, "rev-parse", "--show-toplevel");
  run("git", ["clone", "-q", "--no-local", source, dir], os.tmpdir());
  git(dir, "fetch", "-q", "origin", "refs/notes/vcs-lab:refs/notes/vcs-lab", "+refs/vcs-lab/*:refs/vcs-lab/*");
  git(dir, "switch", "-q", "--detach", options.realRev);
  git(dir, "update-ref", "refs/notes/vcs-lab", options.realNotes);
  git(dir, "remote", "remove", "origin");
  return {
    name: "real", path: dir,
    description: `--no-local clone of this repository at ${options.realRev} with refs/notes/vcs-lab pinned to ${options.realNotes} and refs/vcs-lab/* from the source`,
    head: git(dir, "rev-parse", "HEAD"), notes: git(dir, "rev-parse", "refs/notes/vcs-lab"),
    vlabRefs: git(dir, "for-each-ref", "--format=%(refname) %(objectname)", "refs/vcs-lab/"),
    commits: Number(git(dir, "rev-list", "--count", "HEAD")),
    trackedFiles: git(dir, "ls-files").split("\n").length,
  };
}

// ----------------------------------------------------------------- scenarios

function scenarios(fixtures) {
  const t = fixtures.template;
  const list = [
    // Startup: cost before any work.
    { suite: "startup", fixture: "template", name: "--version", args: ["--version"], floor: ["git", ["--version"]], deterministic: true },
    { suite: "startup", fixture: "template", name: "--help", args: ["--help"], floor: null, deterministic: true },
  ];
  const reads = [
    ["receipts --json", ["receipts", "--json"], ["git", ["notes", "--ref=vcs-lab", "list"]]],
    ["provenance --all --json", ["provenance", "--all", "--json"], ["git", ["notes", "--ref=vcs-lab", "list"]]],
    ["resolve list --json", ["resolve", "list", "--json"], ["git", ["for-each-ref", "refs/vcs-lab/resolutions/"]]],
    ["metadata status --json", ["metadata", "status", "--json"], null],
    ["metadata validate --json", ["metadata", "validate", "--json"], null],
    ["audit identity --json", ["audit", "identity", "--json"], null],
    ["graph", ["graph"], ["git", ["log", "--graph", "--oneline", "--all"]]],
  ];
  for (const fixture of ["real", "scale"]) {
    for (const [name, args, floor] of reads) list.push({ suite: "reads", fixture, name, args, floor, deterministic: true });
  }
  list.push(
    { suite: "reads", fixture: "real", name: "capabilities --json", args: ["capabilities", "--json"], floor: null, deterministic: true },
    { suite: "reads", fixture: "real", name: "doctor --json", args: ["doctor", "--json"], floor: null, deterministic: false },
    { suite: "reads", fixture: "scale", name: "workspace list", args: ["workspace", "list"], floor: ["git", ["worktree", "list", "--porcelain"]], deterministic: true },
    { suite: "reads", fixture: "template", name: "merge-plan feature --json", args: ["merge-plan", "feature", "--json"], floor: ["git", ["log", "--oneline", "main..feature"]], deterministic: true },
    { suite: "reads", fixture: "template", name: "rebase-plan main feature --json", args: ["rebase-plan", "main", "feature", "--json"], floor: ["git", ["log", "--oneline", "feature..main"]], deterministic: true },
    { suite: "reads", fixture: "template", name: "proof-bundle feature", args: ["proof-bundle", "feature"], floor: null, deterministic: true },
  );
  const onFeature = (dir) => git(dir, "switch", "-q", "feature");
  const staged = (dir) => { fs.writeFileSync(path.join(dir, "bench.txt"), "benchmark change\n"); git(dir, "add", "bench.txt"); };
  list.push(
    { suite: "writes", fixture: "template", name: "commit", setup: staged, args: ["commit", "-m", "bench commit", "--generated-by", "perf-bench"], floor: ["git", ["commit", "-q", "-m", "bench commit"]] },
    { suite: "writes", fixture: "template", name: "merge --compact feature", args: ["merge", "feature", "--compact", "-m", "bench landing"], floor: ["git", ["merge", "-q", "--no-ff", "-m", "bench landing", "feature"]] },
    { suite: "writes", fixture: "template", name: "cherry-pick <feature tip>", args: ["cherry-pick", t.featureTip], floor: ["git", ["cherry-pick", t.featureTip]] },
    { suite: "writes", fixture: "template", name: "forecast feature (worktree engine)", args: ["forecast", "feature", "--json"], env: { VLAB_FORECAST_ENGINE: "worktree" }, floor: ["git", ["merge-tree", "--write-tree", "main", "feature"]] },
    { suite: "writes", fixture: "template", name: "forecast feature (merge-tree engine)", args: ["forecast", "feature", "--json"], env: { VLAB_FORECAST_ENGINE: "merge-tree" }, floor: ["git", ["merge-tree", "--write-tree", "main", "feature"]] },
    { suite: "writes", fixture: "template", name: "reconcile feature", args: ["reconcile", "feature", "--json"], floor: ["git", ["merge", "-q", "--no-ff", "-m", "bench reconcile", "feature"]] },
    { suite: "writes", fixture: "template", name: "rebase main (from feature)", setup: onFeature, args: ["rebase", "main", "--json"], floor: ["git", ["rebase", "-q", "main"]] },
    { suite: "writes", fixture: "template", name: "workspace create", args: ["workspace", "create", "bench-ws", "--json"], floor: ["git", ["worktree", "add", "-q", "-b", "bench-ws", "../bench-ws-git"]] },
    { suite: "writes", fixture: "template", name: "metadata export", args: ["metadata", "export", "../bench-export", "--json"], floor: null },
    { suite: "writes", fixture: "template", name: "spec index specs/design.md", args: ["spec", "index", "specs/design.md", "--json"], floor: null },
  );
  return list;
}

// ---------------------------------------------------------------- execution

function measure(options, fixtures, engines, results) {
  const all = scenarios(fixtures).filter((scenario) => options.suites.includes(scenario.suite));
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "vlab-perf-w-"));
  let copyIndex = 0;
  const freshCopy = (fixture) => {
    const target = path.join(workDir, `c${copyIndex++}`, "repo");
    fs.cpSync(fixture.path, target, { recursive: true });
    return target;
  };
  try {
    for (const scenario of all) {
      const fixture = fixtures[scenario.fixture];
      const runEngines = scenario.suite === "reads" ? engines : ["default"];
      for (const engine of runEngines) {
        const engineEnv = engine === "default" ? {} : { VLAB_ENGINE: engine };
        const env = childEnv({ ...engineEnv, ...(scenario.env ?? {}) });
        const sides = [...options.impls.map((impl) => ({ kind: "impl", name: impl.name, command: impl.command })),
          ...(scenario.floor ? [{ kind: "floor", name: "git-floor", command: [scenario.floor[0]], floorArgs: scenario.floor[1] }] : []),
          ...(scenario.name === "--version" ? [{ kind: "floor", name: "bare-node", command: [process.execPath], floorArgs: ["-e", "0"] }] : [])];
        const invoke = (side) => {
          const cwd = scenario.suite === "writes" ? freshCopy(fixture) : fixture.path;
          if (scenario.suite === "writes" && scenario.setup) scenario.setup(cwd);
          const args = side.kind === "impl" ? [...side.command.slice(1), ...scenario.args] : side.floorArgs;
          const started = performance.now();
          const result = run(side.command[0], args, cwd, env, { allowFailure: true });
          const durationMs = performance.now() - started;
          // A read may legitimately exit non-zero to report findings (for
          // example `audit identity` on a fixture with near-duplicate actors),
          // so the requirement is a consistent status, not zero. A floor must
          // succeed. A changing status (a crash, a lock timeout) stops the run.
          const entry = perSide[side.name];
          if (result.error || result.status === null) {
            throw new Error(`${scenario.name} [${side.name}, ${engine}] did not exit normally: ${result.error?.message ?? result.signal}`);
          }
          if (side.kind === "floor" && result.status !== 0) {
            throw new Error(`floor for ${scenario.name} exited ${result.status}: ${result.stderr.slice(0, 400)}`);
          }
          if (entry.status === undefined) entry.status = result.status;
          if (result.status !== entry.status) {
            throw new Error(`${scenario.name} [${side.name}, ${engine}] exited ${result.status} after ${entry.status}: ${result.stderr.slice(0, 400)}`);
          }
          if (scenario.suite === "writes" && result.status !== 0) {
            throw new Error(`${scenario.name} [${side.name}] exited ${result.status}: ${result.stderr.slice(0, 400)}`);
          }
          if (scenario.suite === "writes") removeTree(path.dirname(cwd));
          return { durationMs, stdout: result.stdout };
        };
        const perSide = Object.fromEntries(sides.map((side) => [side.name, { samples: [], digests: new Set(), status: undefined }]));
        for (let index = 0; index < options.warmup; index += 1) for (const side of sides) invoke(side);
        for (let index = 0; index < options.samples; index += 1) {
          // Rotate the starting side so no implementation always runs first.
          for (let offset = 0; offset < sides.length; offset += 1) {
            const side = sides[(index + offset) % sides.length];
            const { durationMs, stdout } = invoke(side);
            perSide[side.name].samples.push(Math.round(durationMs * 1000) / 1000);
            if (side.kind === "impl" && scenario.deterministic) perSide[side.name].digests.add(sha256(stdout));
          }
        }
        for (const side of sides) {
          const entry = perSide[side.name];
          let processes = side.kind === "floor" ? 1 : null;
          if (side.kind === "impl") {
            const cwd = scenario.suite === "writes" ? freshCopy(fixture) : fixture.path;
            if (scenario.suite === "writes" && scenario.setup) scenario.setup(cwd);
            const traced = run(side.command[0], [...side.command.slice(1), ...scenario.args], cwd, { ...env, VLAB_TRACE: "1" }, { allowFailure: true });
            processes = traced.status === entry.status ? traceProcesses(traced.stderr) : null;
            if (scenario.suite === "writes") removeTree(path.dirname(cwd));
          }
          results.push({
            suite: scenario.suite, fixture: scenario.fixture, scenario: scenario.name, engine,
            forecastEngine: scenario.env?.VLAB_FORECAST_ENGINE ?? null,
            side: side.name, kind: side.kind,
            command: side.kind === "impl" ? ["vlab", ...scenario.args].join(" ") : [side.command[0] === process.execPath ? "node" : side.command[0], ...side.floorArgs].join(" "),
            processes, exitStatus: entry.status,
            stableOutput: side.kind === "impl" && scenario.deterministic ? entry.digests.size === 1 : null,
            outputSha256: side.kind === "impl" && scenario.deterministic && entry.digests.size === 1 ? [...entry.digests][0] : null,
            stats: stats(entry.samples), samplesMs: entry.samples,
          });
        }
        const js = results.at(-sides.length);
        process.stderr.write(`  ${scenario.suite}/${scenario.fixture} ${scenario.name} [${engine}] js median ${js.stats.medianMs} ms\n`);
      }
    }
  } finally {
    removeTree(workDir);
  }
}

function checkEquality(results) {
  // A deterministic read must print the same bytes on every sample, under
  // every engine, and in every implementation.
  const problems = [];
  const groups = new Map();
  for (const result of results.filter((item) => item.kind === "impl" && item.stableOutput !== null)) {
    if (!result.stableOutput) problems.push(`${result.fixture} ${result.scenario} [${result.side}, ${result.engine}]: output differs between samples`);
    const key = `${result.fixture}\0${result.scenario}`;
    groups.set(key, [...(groups.get(key) ?? []), result]);
  }
  for (const group of groups.values()) {
    const digests = new Set(group.map((item) => item.outputSha256));
    if (digests.size > 1) problems.push(`${group[0].fixture} ${group[0].scenario}: output differs across ${group.map((item) => `${item.side}/${item.engine}`).join(", ")}`);
  }
  return problems;
}

// ------------------------------------------------------------------ report

function markdown(evidence) {
  const impls = evidence.implementations.map((impl) => impl.name);
  const lines = [];
  lines.push(`## Checkpoint ${evidence.checkpoint}: ${evidence.startedAt.slice(0, 10)}`, "");
  lines.push(`- **Host:** \`${evidence.host.id}\`, ${evidence.host.cpuModels.join(", ").trim()}, ${evidence.host.logicalCpus} logical CPUs, ${Math.round(evidence.host.memoryBytes / 2 ** 30)} GiB, ${evidence.platform}`);
  lines.push(`- **Versions:** Node ${evidence.node}, ${evidence.git}. Source \`${evidence.sourceCommit.slice(0, 7)}\`, harness \`${evidence.scriptSha256.slice(0, 12)}\``);
  lines.push(`- **Implementations:** ${evidence.implementations.map((impl) => `\`${impl.name}\` (${impl.version})`).join(", ")}`);
  lines.push(`- **Native binding:** ${evidence.nativeBinding.available ? `available (\`${evidence.nativeBinding.sha256?.slice(0, 12)}\`)` : `unavailable (${evidence.nativeBinding.reason})`}`);
  lines.push(`- **Sampling:** ${evidence.settings.samples} timed samples after ${evidence.settings.warmup} warm-ups, interleaved across sides. Whole-process wall time`);
  lines.push(`- **Load:** ${evidence.load.map((item) => `${item.label} ${item.cpuPercent ?? "?"}% CPU (max ${item.cpuMaxPercent ?? "?"}%) / ${(item.freeMemoryBytes / 2 ** 30).toFixed(1)} GiB free`).join("; ")}${evidence.noisy ? " — **noisy host**" : ""}${evidence.note ? `. Note: ${evidence.note}` : ""}`);
  lines.push(`- **Fixtures:** ${Object.values(evidence.fixtures).map((fixture) => `\`${fixture.name}\`: ${fixture.description}${fixture.commits ? ` (${fixture.commits} commits)` : ""}`).join("; ")}`);
  lines.push(`- **Equality:** ${evidence.equalityProblems.length === 0 ? "every deterministic read printed identical bytes across samples, engines and implementations" : evidence.equalityProblems.join("; ")}`);
  lines.push(`- **Duration:** ${Math.round(evidence.durationMs / 1000)} s`, "");
  const bySuite = ["startup", "reads", "writes"];
  for (const suite of bySuite) {
    const rows = evidence.results.filter((item) => item.suite === suite);
    if (rows.length === 0) continue;
    lines.push(`### ${suite[0].toUpperCase()}${suite.slice(1)}`, "");
    const header = ["Fixture", "Command", "Engine", ...impls.map((name) => `${name} median (p90)`), "Git floor", ...impls.map((name) => `${name} / floor`), ...impls.map((name) => `${name} Git processes`)];
    lines.push(`| ${header.join(" | ")} |`, `| ${header.map((_, index) => (index < 3 ? "---" : "---:")).join(" | ")} |`);
    const keys = [...new Set(rows.map((item) => `${item.fixture}\0${item.scenario}\0${item.engine}`))];
    for (const key of keys) {
      const [fixture, scenario, engine] = key.split("\0");
      const group = rows.filter((item) => item.fixture === fixture && item.scenario === scenario && item.engine === engine);
      const floor = group.find((item) => item.side === "git-floor");
      const bare = group.find((item) => item.side === "bare-node");
      const cell = (name) => { const item = group.find((entry) => entry.side === name); return item ? `${item.stats.medianMs.toFixed(1)} (${item.stats.p90Ms.toFixed(1)})` : "—"; };
      const ratio = (name) => { const item = group.find((entry) => entry.side === name); return item && floor ? `${Math.round((item.stats.medianMs / floor.stats.medianMs) * 100)}%` : "—"; };
      const procs = (name) => { const item = group.find((entry) => entry.side === name); return item?.processes ?? "—"; };
      const floorCell = floor ? `${floor.stats.medianMs.toFixed(1)}${bare ? `; bare Node ${bare.stats.medianMs.toFixed(1)}` : ""}` : "—";
      const status = group.find((entry) => entry.side === "js")?.exitStatus;
      lines.push(`| ${fixture} | \`${scenario}\`${status ? ` (exits ${status})` : ""} | ${engine} | ${impls.map(cell).join(" | ")} | ${floorCell} | ${impls.map(ratio).join(" | ")} | ${impls.map(procs).join(" | ")} |`);
    }
    lines.push("");
  }
  if (evidence.slowerThanJs.length) {
    lines.push("### Slower than the JavaScript CLI (optimization candidates, not gates)", "");
    for (const item of evidence.slowerThanJs) lines.push(`- ${item}`);
    lines.push("");
  }
  return lines.join("\n");
}

// --------------------------------------------------------------------- main

const options = parseArgs(process.argv.slice(2));
const startedAt = new Date().toISOString();
const started = performance.now();
const load = [loadSample("start")];
const noisy = load[0].cpuPercent !== null && load[0].cpuPercent > options.maxCpu;
if (noisy && !options.allowNoisy) {
  throw new Error(`Host CPU load ${load[0].cpuPercent}% exceeds --max-cpu ${options.maxCpu}. Quiet the host, or pass --allow-noisy to record a noisy run.`);
}
for (const impl of options.impls) {
  impl.version = run(impl.command[0], [...impl.command.slice(1), "--version"], root, childEnv()).stdout.trim();
  impl.executableSha256 = impl.name === "js" ? null : sha256(fs.readFileSync(impl.command[0]));
}
const binding = path.join(root, "native/prebuilds", `${process.platform}-${process.arch}`, "causet-core.node");
// Ask the engine module directly: `doctor` needs a repository, and a silent
// "unavailable" here would skip every native-engine measurement.
const { describeReadEngines } = await import(pathToFileURL(path.join(root, "src/engine.js")).href);
const described = describeReadEngines().native;
const nativeBinding = {
  available: described.available, reason: described.reason, profile: described.profile,
  sha256: fs.existsSync(binding) ? sha256(fs.readFileSync(binding)) : null,
};
if (options.engines.includes("native") && !nativeBinding.available) {
  process.stderr.write(`native engine unavailable (${nativeBinding.reason}); reads run on the Git engine only. Build it with npm run build:native.\n`);
}
const engines = options.engines.filter((engine) => engine !== "native" || nativeBinding.available);
const fixturesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vlab-perf-"));
const results = [];
const fixtures = {};
let fixtureSetupMs = 0;
try {
  const setupStart = performance.now();
  fixtures.template = buildTemplate(path.join(fixturesRoot, "template"), options.impls[0]);
  fixtures.real = buildReal(path.join(fixturesRoot, "real"), options);
  const { withScaleFixture } = await import(pathToFileURL(path.join(root, "src/scale-benchmark.js")).href);
  const baseline = JSON.parse(fs.readFileSync(path.join(root, "benchmarks/baseline.json"), "utf8"));
  withScaleFixture({ ...baseline.profile, samples: 1 }, (repo, fixture) => {
    fixtures.scale = { name: "scale", path: repo, description: `synthetic scale fixture, profile ${baseline.profile.name}: ${fixture.historyDepth} commits, ${fixture.workspaces} workspaces, ${fixture.causalNotes} causal notes, ${fixture.resolutions} resolutions, ${fixture.treeFiles} files`, ...fixture };
    fixtureSetupMs = performance.now() - setupStart;
    load.push(loadSample("after fixtures"));
    measure(options, fixtures, engines, results);
  });
} finally {
  if (options.keep) process.stderr.write(`fixtures kept in ${fixturesRoot}\n`);
  else removeTree(fixturesRoot);
  removeTree(perfGitConfigDir);
}
load.push(loadSample("end"));
const equalityProblems = checkEquality(results);
const slowerThanJs = [];
for (const item of results.filter((entry) => entry.kind === "impl" && entry.side !== "js")) {
  const js = results.find((entry) => entry.side === "js" && entry.fixture === item.fixture && entry.scenario === item.scenario && entry.engine === item.engine);
  if (js && item.stats.medianMs > js.stats.medianMs) slowerThanJs.push(`${item.fixture} \`${item.scenario}\` [${item.engine}]: ${item.side} ${item.stats.medianMs} ms vs js ${js.stats.medianMs} ms`);
}
const evidence = {
  format: FORMAT, checkpoint: options.checkpoint, startedAt, durationMs: Math.round(performance.now() - started),
  fixtureSetupMs: Math.round(fixtureSetupMs),
  sourceCommit: git(root, "rev-parse", "HEAD"), sourceDirty: git(root, "status", "--porcelain") !== "",
  scriptSha256: sha256(fs.readFileSync(script)),
  host: hostProvenance(options.host), platform: `${os.type()} ${os.release()}`,
  node: process.version, git: git(root, "--version"),
  implementations: options.impls.map(({ name, command, version, executableSha256 }) => ({ name, command, version, executableSha256 })),
  nativeBinding, engines, settings: { samples: options.samples, warmup: options.warmup, suites: options.suites, maxCpu: options.maxCpu },
  noisy, note: options.note, load,
  fixtures: Object.fromEntries(Object.entries(fixtures).map(([key, { path: _path, ...rest }]) => [key, rest])),
  equalityProblems, slowerThanJs, results,
};
fs.writeFileSync(options.output, `${JSON.stringify(evidence, null, 1)}\n`);
if (options.markdown) fs.writeFileSync(options.markdown, `${markdown(evidence)}\n`);
console.log(`wrote ${options.output}${options.markdown ? ` and ${options.markdown}` : ""}; ${results.length} measurements in ${Math.round(evidence.durationMs / 1000)} s`);
if (equalityProblems.length) {
  console.error(`equality problems:\n${equalityProblems.join("\n")}`);
  process.exitCode = 1;
}
