/**
 * The Rust CLI's native answers against the JavaScript oracle (ADR-0037, #141).
 *
 * While the port is under way the Rust `cst` answers help, version, and every
 * usage failure that `src/cli.js` raises from the arguments alone, and
 * delegates everything else to the JavaScript CLI. This suite runs each such
 * invocation through both, with the Rust CLI forbidden to delegate
 * (`CAUSET_DELEGATE=never`), and requires byte-identical stdout, stderr and exit
 * status. It then checks the delegation path itself.
 *
 * This is the one suite that launches the JavaScript CLI directly rather than
 * through `test-support/vlab-command.js`: the JavaScript CLI is the oracle here,
 * whichever implementation `CAUSET_CLI` selects. The Rust CLI is `CAUSET_CLI` when
 * that names an executable, else the workspace's release build. Without one,
 * the suite is skipped; `node scripts/build-native.mjs` builds it.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { testEnv } from "../test-support/git-environment.js";
import { selectedCli, vlabPrefix } from "../test-support/vlab-command.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const oracle = path.join(projectRoot, "bin/vlab.js");
const built = path.join(projectRoot, "native/target/release",
  process.platform === "win32" ? "cst.exe" : "cst");
const rust = selectedCli && !/\.(?:c|m)?js$/.test(selectedCli)
  ? selectedCli
  : fs.existsSync(built) ? built : null;
const skip = rust ? false : "no Rust CLI build; run node scripts/build-native.mjs";

// Outside any repository, so a delegated command cannot touch one.
const outside = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "vcs-lab-native-cli-")));
after(() => fs.rmSync(outside, { recursive: true, force: true }));

// The suite's mode variables would otherwise decide these cases for both sides.
const neutral = { CAUSET_ENGINE: "", CAUSET_FORECAST_ENGINE: "", CAUSET_DELEGATE: "" };

function runOracle(args, env = {}) {
  return spawnSync(process.execPath, [oracle, ...args], {
    cwd: outside, encoding: "utf8", env: testEnv({ ...neutral, ...env }),
  });
}

function runRust(args, env = {}) {
  // Counts the invocation when the Rust CLI is the one under test (#140).
  if (rust === selectedCli) vlabPrefix();
  return spawnSync(rust, args, {
    cwd: outside, encoding: "utf8", env: testEnv({ ...neutral, ...env }),
  });
}

// Trace timings are the one volatile part of a delegated command's output.
const withoutTimings = (text) => text.replace(/^(\[cst trace\]) [\d.]+ms /gm, "$1 <ms> ");

function assertSame(args, env = {}, rustEnv = { CAUSET_DELEGATE: "never" }) {
  const expected = runOracle(args, env);
  const actual = runRust(args, { ...env, ...rustEnv });
  const label = `${JSON.stringify(args)} ${JSON.stringify(env)}`;
  assert.equal(actual.error, undefined, label);
  assert.equal(actual.stdout, expected.stdout, `stdout of ${label}`);
  assert.equal(withoutTimings(actual.stderr), withoutTimings(expected.stderr), `stderr of ${label}`);
  assert.equal(actual.status, expected.status, `status of ${label}`);
  return expected;
}

const valueFlags = [
  "--message", "-m", "--from", "--path", "--owner", "--focus", "--cone", "--against",
  "--anchors-from", "--label", "--reason", "--resolution", "--use-forecast", "--samples",
  "--warmup", "--documents", "--blocks", "--history", "--workspaces", "--notes",
  "--resolutions", "--budget-ms", "--areas", "--files-per-area",
  "--authored-by", "--generated-by", "--reviewed-by", "--reword", "--edit", "--squash", "--fixup",
];

// Each command's argument-only refusals, in the order src/cli.js checks them.
const usageFailures = [
  ["commit"], ["commit", "-m", ""], ["commit", "--all"],
  ["branch"], ["branch", ""],
  ["merge"], ["merge", "--compact"], ["compact-merge"], ["hard-squash", "-m", "x"],
  ["proof-bundle"], ["verify-proof", "--offline"], ["merge-plan"],
  ["rebase-plan"], ["rebase-plan", "a", "b", "c"], ["rebase-plan", "", "b", "c"],
  ["rebase-forecast"], ["rebase-forecast", "a", "b", "c"],
  ["rebase"], ["rebase", "a", "b"], ["rebase", "--status", "--continue"],
  ["rebase", "--continue", "--abort", "--status", "x"],
  ["forecast"], ["reconcile"], ["reconcile", "--status", "--abort"],
  ["resolve", "bogus"], ["resolve", ""],
  ["cherry-pick"], ["cherry-pick", "--fork"],
  ["audit"], ["audit", "bogus"],
  ["metadata"], ["metadata", "bogus"], ["metadata", "export"], ["metadata", "import", "--apply"],
  ["metadata", "dispose"], ["metadata", "dispose", "r"],
  ["metadata", "dispose", "r", "--keep-local", "--replace-local"],
  ["workspace"], ["workspace", "bogus"], ["workspace", "create"], ["workspace", "move"],
  ["workspace", "move", "n"], ["workspace", "archive"], ["workspace", "restore"],
  ["workspace", "repair"], ["workspace", "repair", "n"], ["workspace", "repair", "n", "--path", ""],
  ["workspace", "forecast"], ["workspace", "forecast", "t"],
  ["spec"], ["spec", "bogus"], ["spec", "index"], ["spec", "show"],
  ["spec", "merge-plan", "f", "b", "o"],
  ["no-such-command"], ["--json"], ["x", "-m", "--json"],
  ["unknown \"quoted\" \\ — command"], ["UPPER"], ["Commit"],
];

test("help and version are answered natively, byte for byte", { skip }, () => {
  for (const args of [
    [], [""], ["help"], ["--help"], ["-h"], ["help", "extra"], ["--trace-git"],
    ["--engine=native", "help"], ["--git-session", "--help"],
    ["version"], ["--version"], ["-V"], ["--no-git-session", "version", "--json"],
    ["--forecast-engine", "worktree", "-V"],
  ]) {
    assertSame(args);
  }
});

test("global flag and environment failures are answered natively as prose", { skip }, () => {
  for (const args of [
    ["--git-session", "--no-git-session"], ["--git-session", "commit", "--no-git-session", "--json"],
    ["--engine"], ["--engine="], ["--engine", "bogus", "commit", "--json"],
    ["--engine", "--trace-git"], ["--forecast-engine=x"], ["--forecast-engine"],
    ["commit", "-m", "--git-session", "--no-git-session"],
  ]) {
    assertSame(args);
  }
  assertSame(["version"], { CAUSET_ENGINE: "bogus" });
  assertSame(["help"], { CAUSET_FORECAST_ENGINE: "bogus", CAUSET_ENGINE: "bogus" });
  assertSame(["--engine=git", "version"], { CAUSET_ENGINE: "bogus" });
  assertSame(["--forecast-engine=merge-tree", "x"], { CAUSET_FORECAST_ENGINE: "bogus" });
  // The former names are read when the new ones are absent, and lose when both are set
  // (ADR-0039 §5). `undefined` removes the neutral value from the spawned environment.
  const unset = { CAUSET_ENGINE: undefined, CAUSET_FORECAST_ENGINE: undefined };
  assertSame(["version"], { ...unset, VLAB_ENGINE: "bogus" });
  assertSame(["version"], { ...unset, VLAB_FORECAST_ENGINE: "bogus" });
  assertSame(["version"], { ...unset, VLAB_ENGINE: "bogus", CAUSET_ENGINE: "git" });
  assertSame(["version"], { ...unset, VLAB_ENGINE: "native", CAUSET_ENGINE: "bogus" });
});

test("a flag without its value is answered natively, as prose even with --json", { skip }, () => {
  for (const flag of valueFlags) {
    assertSame(["commit", "--json", flag]);
  }
  assertSame(["no-such-command", "-m"]);
});

test("every argument-only usage failure is answered natively, human and JSON", { skip }, () => {
  for (const args of usageFailures) {
    const human = assertSame(args);
    assert.notEqual(human.status, 0, JSON.stringify(args));
    assertSame([...args, "--json"]);
  }
});

test("a repository command is delegated with its output and exit status intact", { skip }, () => {
  // Outside a repository these succeed or fail exactly as the JavaScript CLI
  // does, which is all a delegation has to show: it ran with these arguments here.
  for (const args of [["workspace", "list", "--json"], ["cherry-pick", "x"], ["resolve", "apply", "--all"], ["--trace-git", "workspace", "list"]]) {
    assertSame(args, {}, {});
  }
  // Git's own exit status, passed through the JavaScript CLI and then this one.
  assert.equal(assertSame(["workspace", "list"], {}, {}).status, 128);
});

test("doctor is answered natively, as the JavaScript CLI answers it", { skip }, () => {
  // Outside a repository both fail on Git's refusal, byte for byte.
  assertSame(["doctor"]);
  assertSame(["doctor", "--json"]);
  assertSame(["doctor", "--benchmark", "--samples", "0"]);

  const repo = path.join(outside, "doctor-repo");
  fs.mkdirSync(repo);
  const git = (...args) => spawnSync("git", args, { cwd: repo, encoding: "utf8", env: testEnv() });
  git("init", "-q", "-b", "main");
  git("-c", "user.name=Doctor", "-c", "user.email=doctor@example.invalid", "commit", "-q", "--allow-empty", "-m", "base");
  const inRepo = (command, args, env) => spawnSync(command, args, {
    cwd: repo, encoding: "utf8", env: testEnv({ ...neutral, ...env }),
  });
  for (const args of [["doctor"], ["doctor", "--differential"], ["--engine", "native", "doctor"]]) {
    const expected = inRepo(process.execPath, [oracle, ...args], {});
    if (rust === selectedCli) vlabPrefix();
    const actual = inRepo(rust, args, { CAUSET_DELEGATE: "never" });
    assert.equal(actual.status, 0, actual.stderr);
    assert.equal(actual.stderr, expected.stderr);
    const native = JSON.parse(actual.stdout);
    const oracleReport = JSON.parse(expected.stdout);
    // The runtime self-description is the one allowed difference (ADR-0037 §5).
    assert.equal(native.implementation, "rust");
    assert.equal(native.node, null);
    assert.equal(oracleReport.implementation, "javascript");
    for (const report of [native, oracleReport]) {
      delete report.implementation;
      delete report.node;
    }
    assert.deepEqual(native, oracleReport, JSON.stringify(args));
  }
});

test("capabilities is answered natively, byte for byte", { skip }, () => {
  // Outside a repository the document is build-scoped.
  assertSame(["capabilities"]);
  assertSame(["capabilities", "--json"]);
  assertSame(["capabilities", "--against", path.join(outside, "absent.json"), "--json"]);

  const repo = path.join(outside, "capabilities-repo");
  fs.mkdirSync(repo);
  const git = (...args) => spawnSync("git", args, { cwd: repo, encoding: "utf8", env: testEnv() });
  git("init", "-q", "-b", "main");
  git("-c", "user.name=Capabilities", "-c", "user.email=capabilities@example.invalid", "commit", "-q", "--allow-empty", "-m", "base");
  const inRepo = (command, args, env) => spawnSync(command, args, {
    cwd: repo, encoding: "utf8", env: testEnv({ ...neutral, ...env }),
  });
  const own = JSON.parse(inRepo(process.execPath, [oracle, "capabilities", "--json"], {}).stdout);
  const reduced = structuredClone(own);
  reduced.families.find((entry) => entry.family === "causet.rebase").readable = [1];
  delete reduced.repository.lineage;
  const peers = [["own.json", own], ["reduced.json", reduced]].map(([name, document]) => {
    const file = path.join(outside, name);
    fs.writeFileSync(file, JSON.stringify(document));
    return file;
  });
  for (const args of [
    ["capabilities"],
    ["capabilities", "--json"],
    ...peers.flatMap((file) => [["capabilities", "--against", file], ["capabilities", "--against", file, "--json"]]),
  ]) {
    const expected = inRepo(process.execPath, [oracle, ...args], {});
    if (rust === selectedCli) vlabPrefix();
    const actual = inRepo(rust, args, { CAUSET_DELEGATE: "never" });
    const label = JSON.stringify(args);
    assert.equal(actual.stdout, expected.stdout, `stdout of ${label}`);
    assert.equal(actual.stderr, expected.stderr, `stderr of ${label}`);
    assert.equal(actual.status, expected.status, `status of ${label}`);
  }
});

test("the record readers are answered natively, byte for byte", { skip }, () => {
  for (const args of [
    ["graph"], ["receipts", "--json"], ["provenance"], ["metadata", "status"], ["metadata", "validate", "--json"],
    ["audit", "identity"], ["resolve"], ["resolve", "list", "--json"], ["spec", "show", "x.md"], ["spec", "status"],
    ["merge-plan", "main"], ["rebase-plan", "main", "feature", "--json"],
    ["proof-bundle", "main"], ["verify-proof", "missing.json"],
  ]) assertSame(args);

  const repo = path.join(outside, "records-repo");
  fs.mkdirSync(repo);
  const git = (...args) => spawnSync("git", args, { cwd: repo, encoding: "utf8", env: testEnv() });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Records");
  git("config", "user.email", "records@example.invalid");
  git("commit", "-q", "--allow-empty", "-m", "base");
  const inRepo = (command, args, env) => spawnSync(command, args, {
    cwd: repo, encoding: "utf8", env: testEnv({ ...neutral, ...env }),
  });
  // Real records, written by the JavaScript CLI: a declared provenance and a
  // landing receipt.
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
  git("add", "a.txt");
  assert.equal(inRepo(process.execPath, [oracle, "commit", "-m", "add a", "--generated-by", "agent-1"], {}).status, 0);
  git("switch", "-q", "-c", "feature");
  fs.writeFileSync(path.join(repo, "b.txt"), "b\n");
  git("add", "b.txt");
  assert.equal(inRepo(process.execPath, [oracle, "commit", "-m", "add b"], {}).status, 0);
  git("switch", "-q", "main");
  assert.equal(inRepo(process.execPath, [oracle, "merge", "feature", "--compact", "-m", "land feature"], {}).status, 0);
  // A proof bundle written by the JavaScript CLI, as it is and with one
  // classification forged after the fact, for the verifier to read.
  const bundle = JSON.parse(inRepo(process.execPath, [oracle, "proof-bundle", "HEAD~1"], {}).stdout);
  const bundleFile = path.join(outside, "bundle.json");
  fs.writeFileSync(bundleFile, JSON.stringify(bundle));
  const forgedFile = path.join(outside, "forged.json");
  fs.writeFileSync(forgedFile, JSON.stringify({ ...bundle, counts: { ...bundle.counts, new: 9 } }));
  for (const args of [
    ["graph"], ["receipts"], ["receipts", "--json"], ["provenance"], ["provenance", "HEAD~1"],
    ["provenance", "--all"], ["provenance", "--all", "--json"], ["provenance", "missing"],
    ["metadata", "status"], ["metadata", "status", "--json"], ["metadata", "validate"],
    ["metadata", "validate", "--strict", "--json"], ["audit", "identity"], ["audit", "identity", "--json"],
    ["resolve"], ["resolve", "status", "--json"], ["resolve", "list"], ["resolve", "list", "--json"],
    ["spec", "status"], ["spec", "status", "--json"], ["spec", "show", "a.txt"], ["spec", "show", "missing.md"],
    ["merge-plan", "feature"], ["merge-plan", "feature", "--json"], ["merge-plan", "missing"],
    ["rebase-plan", "HEAD~1", "main"], ["rebase-plan", "HEAD~1", "main", "--json"],
    ["rebase-plan", "HEAD~1", "main", "--from", "main"], ["rebase-plan", "main", "feature", "--reword", "feature"],
    ["proof-bundle", "feature"], ["proof-bundle", "HEAD~1"], ["proof-bundle", "missing"],
    ["verify-proof", bundleFile], ["verify-proof", bundleFile, "--offline", "--json"], ["verify-proof", forgedFile],
    ["verify-proof", path.join(outside, "missing.json")],
    ["metadata", "retain", "--dry-run"], ["metadata", "retain", "--dry-run", "--json"], ["metadata", "retain"],
  ]) {
    const expected = inRepo(process.execPath, [oracle, ...args], {});
    if (rust === selectedCli) vlabPrefix();
    const actual = inRepo(rust, args, { CAUSET_DELEGATE: "never" });
    const label = JSON.stringify(args);
    assert.equal(actual.stdout, expected.stdout, `stdout of ${label}`);
    assert.equal(actual.stderr, expected.stderr, `stderr of ${label}`);
    assert.equal(actual.status, expected.status, `status of ${label}`);
  }
  // Each implementation writes the same bundle bytes and verifies the other's.
  const oracleBundle = inRepo(process.execPath, [oracle, "proof-bundle", "HEAD~1"], {});
  if (rust === selectedCli) vlabPrefix();
  const rustBundle = inRepo(rust, ["proof-bundle", "HEAD~1"], { CAUSET_DELEGATE: "never" });
  assert.equal(rustBundle.stdout, oracleBundle.stdout);
  const rustFile = path.join(outside, "rust-bundle.json");
  fs.writeFileSync(rustFile, rustBundle.stdout);
  assert.equal(inRepo(process.execPath, [oracle, "verify-proof", rustFile], {}).status, 0);
  assert.equal(inRepo(rust, ["verify-proof", bundleFile], { CAUSET_DELEGATE: "never" }).status, 0);
});

test("spec status plans a base whose manifest predates cst migrate, as the JavaScript CLI does (#183)", { skip }, () => {
  const repo = path.join(outside, "legacy-spec-repo");
  fs.mkdirSync(repo);
  const git = (...args) => spawnSync("git", args, { cwd: repo, encoding: "utf8", env: testEnv() });
  const oracleIn = (args) => spawnSync(process.execPath, [oracle, ...args], {
    cwd: repo, encoding: "utf8", env: testEnv(neutral),
  });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Legacy spec");
  git("config", "user.email", "legacy-spec@example.invalid");
  git("config", "core.autocrlf", "false");
  const text = "Intro\n\n# A\na\n\n# B\nb\n";
  fs.writeFileSync(path.join(repo, "s.md"), text);
  assert.equal(oracleIn(["spec", "index", "s.md"]).status, 0);
  // The base keeps its manifest under the former directory, as a commit made
  // before cst migrate does; each side moves it as cst migrate does.
  fs.mkdirSync(path.join(repo, ".vcs-lab", "specs"), { recursive: true });
  fs.renameSync(path.join(repo, ".causet", "specs", "s.md.json"), path.join(repo, ".vcs-lab", "specs", "s.md.json"));
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  const side = (name, edited) => {
    git("switch", "-q", "-c", name, "main");
    fs.writeFileSync(path.join(repo, "s.md"), edited);
    fs.mkdirSync(path.join(repo, ".causet", "specs"), { recursive: true });
    git("mv", ".vcs-lab/specs/s.md.json", ".causet/specs/s.md.json");
    assert.equal(oracleIn(["spec", "index", "s.md"]).status, 0);
    git("add", "-A");
    git("commit", "-q", "-m", name);
    return git("rev-parse", "HEAD").stdout.trim();
  };
  const ours = side("ours", text.replace("a\n", "a edited\n"));
  const theirs = side("theirs", text.replace("b\n", "b edited\n"));
  fs.mkdirSync(path.join(repo, ".git", "causet"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".git", "causet", "reconciliation.json"), JSON.stringify({
    schema: "causet.reconciliation-operation/v4",
    id: "op_legacy",
    current: { sourceCommit: theirs, targetBefore: ours, conflictedPaths: ["s.md"] },
  }));
  for (const args of [["spec", "status"], ["spec", "status", "--json"]]) {
    const expected = oracleIn(args);
    if (rust === selectedCli) vlabPrefix();
    const actual = spawnSync(rust, args, {
      cwd: repo, encoding: "utf8", env: testEnv({ ...neutral, CAUSET_DELEGATE: "never" }),
    });
    const label = JSON.stringify(args);
    assert.equal(actual.stdout, expected.stdout, `stdout of ${label}`);
    assert.equal(actual.stderr, expected.stderr, `stderr of ${label}`);
    assert.equal(actual.status, expected.status, `status of ${label}`);
  }
  assert.equal(JSON.parse(oracleIn(["spec", "status", "--json"]).stdout).plans[0].status, "clean");
});

test("init writes the same configuration and runtime directory natively (#145)", { skip }, () => {
  // Twin repositories, one per implementation, because init changes the one it runs in.
  const twin = (name, legacy) => {
    const repo = path.join(outside, name);
    fs.mkdirSync(repo);
    const git = (...args) => spawnSync("git", args, { cwd: repo, encoding: "utf8", env: testEnv() });
    git("init", "-q", "-b", "main");
    if (legacy) fs.mkdirSync(path.join(repo, ".git", "vcs-lab"));
    return { repo, git };
  };
  for (const [index, [args, legacy]] of [[["init"], false], [["init", "--json"], false], [["init"], true]].entries()) {
    const oracleSide = twin(`init-js-${index}`, legacy);
    const rustSide = twin(`init-rust-${index}`, legacy);
    const expected = spawnSync(process.execPath, [oracle, ...args], {
      cwd: oracleSide.repo, encoding: "utf8", env: testEnv(neutral),
    });
    if (rust === selectedCli) vlabPrefix();
    const actual = spawnSync(rust, args, {
      cwd: rustSide.repo, encoding: "utf8", env: testEnv({ ...neutral, CAUSET_DELEGATE: "never" }),
    });
    const label = JSON.stringify([args, legacy]);
    assert.equal(actual.status, expected.status, `status of ${label}`);
    assert.equal(actual.stderr, expected.stderr, `stderr of ${label}`);
    assert.equal(
      actual.stdout.replace(fs.realpathSync.native(rustSide.repo), "<repo>").replace(rustSide.repo, "<repo>"),
      expected.stdout.replace(fs.realpathSync.native(oracleSide.repo), "<repo>").replace(oracleSide.repo, "<repo>"),
      `stdout of ${label}`,
    );
    for (const key of ["notes.displayRef", "notes.rewriteRef"]) {
      assert.equal(rustSide.git("config", key).stdout, oracleSide.git("config", key).stdout, `${key} of ${label}`);
    }
    for (const name of ["causet", "vcs-lab"]) {
      assert.equal(
        fs.existsSync(path.join(rustSide.repo, ".git", name)),
        fs.existsSync(path.join(oracleSide.repo, ".git", name)),
        `.git/${name} of ${label}`,
      );
    }
  }
});

test("commit publishes the same commit and declared provenance natively (#145)", { skip }, () => {
  // Ids, object ids and times differ run to run, so each side is renamed by
  // first appearance before the two are compared.
  const rename = (text) => {
    const seen = new Map();
    const swap = (kind) => (match) => {
      if (!seen.has(match)) seen.set(match, "<" + kind + seen.size + ">");
      return seen.get(match);
    };
    return text
      .replace(/\b[0-9a-f]{40}\b/g, swap("oid"))
      .replace(/\b[a-z]+_[0-9a-z]{9}[0-9a-f]{12}\b/g, swap("id"))
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, swap("time"));
  };
  const twin = (name) => {
    const repo = path.join(outside, name);
    fs.mkdirSync(repo);
    const git = (...args) => spawnSync("git", args, { cwd: repo, encoding: "utf8", env: testEnv() });
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Commit twin");
    git("config", "user.email", "commit-twin@example.invalid");
    fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
    git("add", "a.txt");
    return { repo, git };
  };
  const cases = [
    ["commit", "-m", "plain"],
    ["commit", "-m", "declared", "--authored-by", "Ada", "--generated-by", "model-b", "--reviewed-by", "Émile", "--reviewed-by", "Eve", "--json"],
    ["commit", "-m", "blank", "--generated-by", "  "],
  ];
  for (const [index, args] of cases.entries()) {
    const oracleSide = twin("commit-js-" + index);
    const rustSide = twin("commit-rust-" + index);
    const expected = spawnSync(process.execPath, [oracle, ...args], {
      cwd: oracleSide.repo, encoding: "utf8", env: testEnv(neutral),
    });
    if (rust === selectedCli) vlabPrefix();
    const actual = spawnSync(rust, args, {
      cwd: rustSide.repo, encoding: "utf8", env: testEnv({ ...neutral, CAUSET_DELEGATE: "never" }),
    });
    const label = JSON.stringify(args);
    assert.equal(actual.status, expected.status, "status of " + label);
    assert.equal(rename(actual.stderr), rename(expected.stderr), "stderr of " + label);
    assert.equal(rename(actual.stdout), rename(expected.stdout), "stdout of " + label);
    const notes = (side) => rename(side.git("log", "-1", "--format=%B", "refs/notes/causet").stdout
      + side.git("notes", "--ref=causet", "show", "HEAD").stdout);
    assert.equal(notes(rustSide), notes(oracleSide), "notes of " + label);
  }
});

test("metadata retain --apply publishes the same backfill natively (#145)", { skip }, () => {
  const rename = (text) => {
    const seen = new Map();
    const swap = (kind) => (match) => {
      if (!seen.has(match)) seen.set(match, "<" + kind + seen.size + ">");
      return seen.get(match);
    };
    return text
      .replace(/\b[0-9a-f]{40}\b/g, swap("oid"))
      .replace(/\b[a-z]+_[0-9a-z]{9}[0-9a-f]{12}\b/g, swap("id"))
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, swap("time"));
  };
  const twin = (name) => {
    const repo = path.join(outside, name);
    fs.mkdirSync(repo);
    const git = (...args) => spawnSync("git", args, { cwd: repo, encoding: "utf8", env: testEnv() });
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Retain twin");
    git("config", "user.email", "retain-twin@example.invalid");
    fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
    git("add", "a.txt");
    const made = spawnSync(process.execPath, [oracle, "commit", "-m", "add a", "--generated-by", "agent"], {
      cwd: repo, encoding: "utf8", env: testEnv(neutral),
    });
    assert.equal(made.status, 0, made.stderr);
    return { repo, git };
  };
  for (const [index, args] of [["metadata", "retain", "--apply"], ["metadata", "retain", "--apply", "--json"]].entries()) {
    const oracleSide = twin("retain-js-" + index);
    const rustSide = twin("retain-rust-" + index);
    const expected = spawnSync(process.execPath, [oracle, ...args], {
      cwd: oracleSide.repo, encoding: "utf8", env: testEnv(neutral),
    });
    if (rust === selectedCli) vlabPrefix();
    const actual = spawnSync(rust, args, {
      cwd: rustSide.repo, encoding: "utf8", env: testEnv({ ...neutral, CAUSET_DELEGATE: "never" }),
    });
    const label = JSON.stringify(args);
    assert.equal(actual.status, expected.status, "status of " + label);
    assert.equal(rename(actual.stdout + actual.stderr), rename(expected.stdout + expected.stderr), "output of " + label);
    const retention = (side) => rename(side.git("log", "-1", "--format=%B%n%P", "refs/causet/retention").stdout);
    assert.equal(retention(rustSide), retention(oracleSide), "retention of " + label);
  }
});

test("metadata export writes the same envelope natively, byte for byte (#145)", { skip }, () => {
  // One repository and a byte-for-byte copy of it, one per implementation:
  // every envelope carrier is deterministic, so the files must be identical.
  const root = path.join(outside, "export-twin");
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo, { recursive: true });
  const git = (...args) => spawnSync("git", args, { cwd: repo, encoding: "utf8", env: testEnv() });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Export twin");
  git("config", "user.email", "export-twin@example.invalid");
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
  git("add", "a.txt");
  const made = spawnSync(process.execPath, [oracle, "commit", "-m", "add a", "--generated-by", "agent"], {
    cwd: repo, encoding: "utf8", env: testEnv(neutral),
  });
  assert.equal(made.status, 0, made.stderr);
  const copy = path.join(root, "copy");
  fs.cpSync(repo, copy, { recursive: true });
  const expected = spawnSync(process.execPath, [oracle, "metadata", "export", "../envelope-js"], {
    cwd: repo, encoding: "utf8", env: testEnv(neutral),
  });
  if (rust === selectedCli) vlabPrefix();
  const actual = spawnSync(rust, ["metadata", "export", "../envelope-rust"], {
    cwd: copy, encoding: "utf8", env: testEnv({ ...neutral, CAUSET_DELEGATE: "never" }),
  });
  assert.equal(actual.status, expected.status, actual.stderr);
  assert.equal(
    actual.stdout.replace(/envelope-rust/g, "<envelope>"),
    expected.stdout.replace(/envelope-js/g, "<envelope>"),
  );
  for (const file of ["manifest.json", "objects.bundle"]) {
    assert.ok(
      fs.readFileSync(path.join(root, "envelope-rust", file)).equals(fs.readFileSync(path.join(root, "envelope-js", file))),
      file + " must be byte-identical",
    );
  }
  // An existing destination is refused the same way.
  const refused = spawnSync(rust, ["metadata", "export", "../envelope-rust", "--json"], {
    cwd: copy, encoding: "utf8", env: testEnv({ ...neutral, CAUSET_DELEGATE: "never" }),
  });
  const oracleRefused = spawnSync(process.execPath, [oracle, "metadata", "export", "../envelope-js", "--json"], {
    cwd: repo, encoding: "utf8", env: testEnv(neutral),
  });
  assert.equal(refused.status, oracleRefused.status);
  assert.equal(JSON.parse(refused.stdout).code, JSON.parse(oracleRefused.stdout).code);
});

test("CAUSET_DELEGATE=always sends even native answers to the JavaScript CLI", { skip }, () => {
  // CAUSET_JS_CLI naming a missing file proves the route: a native answer would
  // not look for it.
  const missing = path.join(outside, "missing.js");
  const forced = runRust(["--version"], { CAUSET_DELEGATE: "always", CAUSET_JS_CLI: missing });
  assert.notEqual(forced.status, 0);
  assert.equal(forced.stdout, "");
  const native = runRust(["--version"], { CAUSET_JS_CLI: missing });
  assert.equal(native.status, 0);
  assertSame(["--version"], {}, { CAUSET_DELEGATE: "always" });
  assertSame(["no-such-command", "--json"], {}, { CAUSET_DELEGATE: "always" });
});

test("CAUSET_DELEGATE=never refuses a command that is not ported", { skip }, () => {
  const result = runRust(["workspace", "list"], { CAUSET_DELEGATE: "never" });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^cst: 'workspace' is not ported to the Rust CLI yet/);
  const invalid = runRust(["--version"], { CAUSET_DELEGATE: "sometimes" });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /^cst: Unknown delegation mode 'sometimes'/);
});
