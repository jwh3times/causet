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
  for (const args of [["workspace", "list", "--json"], ["cherry-pick", "x"], ["reconcile", "--continue"], ["--trace-git", "workspace", "list"]]) {
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

test("metadata import previews and applies an envelope as the JavaScript CLI does (#145)", { skip }, () => {
  // A source with notes, its envelope, and a clone to import into; each
  // implementation imports into its own byte copy of the clone.
  const root = path.join(outside, "import-twin");
  const source = path.join(root, "source");
  fs.mkdirSync(source, { recursive: true });
  const git = (cwd, ...args) => spawnSync("git", args, { cwd, encoding: "utf8", env: testEnv() });
  const oracleIn = (cwd, args) => spawnSync(process.execPath, [oracle, ...args], {
    cwd, encoding: "utf8", env: testEnv(neutral),
  });
  git(source, "init", "-q", "-b", "main");
  git(source, "config", "user.name", "Import twin");
  git(source, "config", "user.email", "import-twin@example.invalid");
  fs.writeFileSync(path.join(source, "a.txt"), "a\n");
  git(source, "add", "a.txt");
  assert.equal(oracleIn(source, ["commit", "-m", "add a", "--generated-by", "agent"]).status, 0);
  assert.equal(oracleIn(source, ["metadata", "export", path.join(root, "envelope")]).status, 0);
  const clone = path.join(root, "clone-js");
  git(root, "clone", "-q", "--no-local", source, clone);
  git(clone, "config", "user.name", "Import twin");
  git(clone, "config", "user.email", "import-twin@example.invalid");
  const copy = path.join(root, "clone-rust");
  fs.cpSync(clone, copy, { recursive: true });
  for (const args of [["metadata", "import", "../envelope", "--dry-run"], ["metadata", "import", "../envelope", "--apply"], ["metadata", "import", "../envelope", "--apply"]]) {
    const expected = oracleIn(clone, args);
    if (rust === selectedCli) vlabPrefix();
    const actual = spawnSync(rust, args, {
      cwd: copy, encoding: "utf8", env: testEnv({ ...neutral, CAUSET_DELEGATE: "never" }),
    });
    const label = JSON.stringify(args);
    assert.equal(actual.status, expected.status, "status of " + label);
    assert.equal(actual.stderr, expected.stderr, "stderr of " + label);
    assert.equal(actual.stdout, expected.stdout, "stdout of " + label);
  }
  assert.equal(git(copy, "notes", "--ref=causet", "show", "HEAD").stdout, git(clone, "notes", "--ref=causet", "show", "HEAD").stdout);
  assert.equal(git(copy, "rev-parse", "refs/notes/causet").stdout, git(clone, "rev-parse", "refs/notes/causet").stdout);
});

test("metadata dispose resolves a parked conflict as the JavaScript CLI does (#145)", { skip }, () => {
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
  // A destination holding a parked copy of the source's record, made by the
  // JavaScript CLI; each implementation disposes of it in its own byte copy.
  const root = path.join(outside, "dispose-twin");
  const source = path.join(root, "source");
  fs.mkdirSync(source, { recursive: true });
  const git = (cwd, ...args) => spawnSync("git", args, { cwd, encoding: "utf8", env: testEnv() });
  const oracleIn = (cwd, args) => spawnSync(process.execPath, [oracle, ...args], {
    cwd, encoding: "utf8", env: testEnv(neutral),
  });
  git(source, "init", "-q", "-b", "main");
  git(source, "config", "user.name", "Dispose twin");
  git(source, "config", "user.email", "dispose-twin@example.invalid");
  fs.writeFileSync(path.join(source, "a.txt"), "a\n");
  git(source, "add", "a.txt");
  assert.equal(oracleIn(source, ["commit", "-m", "add a", "--generated-by", "agent"]).status, 0);
  assert.equal(oracleIn(source, ["metadata", "export", path.join(root, "envelope")]).status, 0);
  const parked = path.join(root, "parked");
  git(root, "clone", "-q", "--no-local", source, parked);
  git(parked, "config", "user.name", "Dispose twin");
  git(parked, "config", "user.email", "dispose-twin@example.invalid");
  const note = JSON.parse(git(source, "notes", "--ref=causet", "show", "HEAD").stdout);
  const local = { schema: "causet.note/v1", records: [{ ...note.records[0], actors: [{ role: "authored", actor: "Local author" }] }] };
  fs.writeFileSync(path.join(root, "local.json"), JSON.stringify(local));
  git(parked, "notes", "--ref=causet", "add", "-F", path.join(root, "local.json"), "HEAD");
  assert.equal(oracleIn(parked, ["metadata", "import", "../envelope", "--apply", "--park-conflicts"]).status, 0);
  const recordId = note.records[0].id;
  for (const flags of [["--keep-local"], ["--replace-local", "--reason", "the peer is right", "--json"]]) {
    const name = flags[0].slice(2);
    const oracleSide = path.join(root, name + "-js");
    const rustSide = path.join(root, name + "-rust");
    fs.cpSync(parked, oracleSide, { recursive: true });
    fs.cpSync(parked, rustSide, { recursive: true });
    const args = ["metadata", "dispose", recordId, ...flags];
    const expected = oracleIn(oracleSide, args);
    if (rust === selectedCli) vlabPrefix();
    const actual = spawnSync(rust, args, {
      cwd: rustSide, encoding: "utf8", env: testEnv({ ...neutral, CAUSET_DELEGATE: "never" }),
    });
    const label = JSON.stringify(args);
    assert.equal(actual.status, expected.status, "status of " + label);
    assert.equal(rename(actual.stdout + actual.stderr), rename(expected.stdout + expected.stderr), "output of " + label);
    assert.equal(git(rustSide, "notes", "--ref=causet", "show", "HEAD").stdout, git(oracleSide, "notes", "--ref=causet", "show", "HEAD").stdout);
    assert.equal(git(rustSide, "for-each-ref", "refs/causet/quarantine/").stdout, "");
  }
});

test("branch and the landings publish the same commits, receipts and carried provenance natively (#146)", { skip }, () => {
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
  // Fixed dates make both sides' Git commits identical; only record ids and
  // times differ, and those are renamed.
  const dated = {
    ...neutral,
    GIT_AUTHOR_DATE: "2026-01-02T03:04:05Z",
    GIT_COMMITTER_DATE: "2026-01-02T03:04:05Z",
  };
  const base = path.join(outside, "landing-base");
  fs.mkdirSync(base);
  const git = (cwd, ...args) => spawnSync("git", args, { cwd, encoding: "utf8", env: testEnv(dated) });
  const cst = (cwd, ...args) => {
    const made = spawnSync(process.execPath, [oracle, ...args], { cwd, encoding: "utf8", env: testEnv(dated) });
    assert.equal(made.status, 0, made.stderr);
  };
  const write = (name, text) => fs.writeFileSync(path.join(base, name), text);
  git(base, "init", "-q", "-b", "main");
  git(base, "config", "user.name", "Landing twin");
  git(base, "config", "user.email", "landing-twin@example.invalid");
  write("a.txt", "a\n");
  git(base, "add", "a.txt");
  cst(base, "commit", "-m", "add a");
  git(base, "switch", "-q", "-c", "feature");
  write("b.txt", "b\n");
  git(base, "add", "b.txt");
  cst(base, "commit", "-m", "add b", "--authored-by", "Ada", "--generated-by", "model-b");
  write("c.txt", "c\n");
  git(base, "add", "c.txt");
  git(base, "commit", "-q", "-m", "add c without causet");
  write("d.txt", "d\n");
  git(base, "add", "d.txt");
  cst(base, "commit", "-m", "add d", "--generated-by", "model-b", "--reviewed-by", "Émile");
  git(base, "switch", "-q", "-c", "conflicting", "main");
  write("a.txt", "theirs\n");
  git(base, "commit", "-q", "-am", "change a there");
  git(base, "switch", "-q", "main");
  write("a.txt", "ours\n");
  git(base, "commit", "-q", "-am", "change a here");

  const cases = [
    [["merge", "feature"]],
    [["merge", "feature", "--hard-squash", "-m", "Squash the feature", "--json"]],
    [["merge", "feature", "--hard-squash", "--compact"]],
    [["compact-merge", "feature", "--hard-squash"]],
    [["hard-squash", "feature", "--json"]],
    [["merge", "main"]],
    [["merge", "no-such-branch", "--json"]],
    [["merge", "conflicting"]],
    [["hard-squash", "conflicting", "--json"]],
    [["merge", "feature"], (repo) => fs.writeFileSync(path.join(repo, "a.txt"), "dirty\n")],
    [["branch", "topic"]],
    [["branch", "topic", "feature", "--json"]],
    [["branch", "feature"]],
    [["branch", "topic", "no-such-revision"]],
  ];
  for (const [index, [args, prepare]] of cases.entries()) {
    const sides = ["js", "rust"].map((name) => {
      const repo = path.join(outside, `landing-${name}-${index}`);
      fs.cpSync(base, repo, { recursive: true });
      prepare?.(repo);
      return repo;
    });
    const expected = spawnSync(process.execPath, [oracle, ...args], {
      cwd: sides[0], encoding: "utf8", env: testEnv(dated),
    });
    if (rust === selectedCli) vlabPrefix();
    const actual = spawnSync(rust, args, {
      cwd: sides[1], encoding: "utf8", env: testEnv({ ...dated, CAUSET_DELEGATE: "never" }),
    });
    const label = JSON.stringify(args);
    assert.equal(actual.status, expected.status, "status of " + label);
    assert.equal(rename(actual.stderr), rename(expected.stderr), "stderr of " + label);
    assert.equal(rename(actual.stdout), rename(expected.stdout), "stdout of " + label);
    const snapshot = (repo) => rename([
      git(repo, "branch", "--show-current").stdout,
      git(repo, "status", "--porcelain").stdout,
      git(repo, "log", "-1", "--format=%H %P%n%B", "HEAD").stdout,
      git(repo, "notes", "--ref=causet", "show", "HEAD").stdout,
      git(repo, "log", "-1", "--format=%B", "refs/notes/causet").stdout,
      spawnSync(process.execPath, [oracle, "provenance", "HEAD", "--json"], {
        cwd: repo, encoding: "utf8", env: testEnv(dated),
      }).stdout,
    ].join("\n--\n"));
    assert.equal(snapshot(sides[1]), snapshot(sides[0]), "repository after " + label);
  }
});

test("cherry-pick applies, forks and recognizes covered changes natively (#146)", { skip }, () => {
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
  // Fixed dates make both sides' Git commits identical; only record ids and
  // times differ, and those are renamed.
  const dated = {
    ...neutral,
    GIT_AUTHOR_DATE: "2026-01-02T03:04:05Z",
    GIT_COMMITTER_DATE: "2026-01-02T03:04:05Z",
  };
  const base = path.join(outside, "cherry-base");
  fs.mkdirSync(base);
  const git = (cwd, ...args) => spawnSync("git", args, { cwd, encoding: "utf8", env: testEnv(dated) });
  const cst = (cwd, ...args) => {
    const made = spawnSync(process.execPath, [oracle, ...args], { cwd, encoding: "utf8", env: testEnv(dated) });
    assert.equal(made.status, 0, `${args.join(" ")}\n${made.stderr}`);
  };
  const write = (name, text) => fs.writeFileSync(path.join(base, name), text);
  git(base, "init", "-q", "-b", "main");
  git(base, "config", "user.name", "Cherry twin");
  git(base, "config", "user.email", "cherry-twin@example.invalid");
  write("a.txt", "a\n");
  git(base, "add", "a.txt");
  cst(base, "commit", "-m", "add a");
  git(base, "switch", "-q", "-c", "feature");
  write("b.txt", "b\n");
  git(base, "add", "b.txt");
  cst(base, "commit", "-m", "add b", "--authored-by", "Ada", "--generated-by", "model-b");
  write("c.txt", "c\n");
  git(base, "add", "c.txt");
  git(base, "commit", "-q", "-m", "add c without causet");
  write("d.txt", "d\n");
  git(base, "add", "d.txt");
  cst(base, "commit", "-m", "add d", "--generated-by", "model-b");
  git(base, "switch", "-q", "-c", "conflicting", "main");
  write("a.txt", "theirs\n");
  git(base, "commit", "-q", "-am", "change a there");
  git(base, "switch", "-q", "main");
  write("a.txt", "ours\n");
  git(base, "commit", "-q", "-am", "change a here");
  const changeB = git(base, "log", "-1", "--format=%(trailers:key=Change-Id,valueonly)", "feature~2").stdout.trim();
  assert.match(changeB, /^ch_/);

  const cases = [
    [["cherry-pick", "feature~2"]],
    [["cherry-pick", changeB, "--json"]],
    [["cherry-pick", "feature~1", "--fork", "--json"]],
    [["cherry-pick", "feature", "--fork"]],
    // Covered through the applied commit's Change-Id trailer, then repeated.
    [["cherry-pick", "feature~2"], (repo) => cst(repo, "cherry-pick", "feature~2")],
    [["cherry-pick", "feature~2", "--repeat"], (repo) => cst(repo, "cherry-pick", "feature~2")],
    // Covered through a landing's Absorbs trailer.
    [["cherry-pick", changeB], (repo) => cst(repo, "hard-squash", "feature")],
    // A stock commit is covered only through its validated application record.
    [["cherry-pick", "feature~1", "--json"], (repo) => cst(repo, "cherry-pick", "feature~1")],
    // Two bearers of one change id: the origin is the one no record applied.
    [["cherry-pick", changeB], (repo) => {
      git(repo, "switch", "-q", "-c", "other", "feature~3");
      cst(repo, "cherry-pick", "feature~2");
      git(repo, "switch", "-q", "main");
    }],
    [["cherry-pick", "conflicting"]],
    [["cherry-pick", "conflicting", "--fork", "--json"]],
    [["cherry-pick", "ch_missing", "--json"]],
    [["cherry-pick", "no-such-revision"]],
    [["cherry-pick", "feature"], (repo) => fs.writeFileSync(path.join(repo, "a.txt"), "dirty\n")],
  ];
  for (const [index, [args, prepare]] of cases.entries()) {
    const sides = ["js", "rust"].map((name) => {
      const repo = path.join(outside, `cherry-${name}-${index}`);
      fs.cpSync(base, repo, { recursive: true });
      prepare?.(repo);
      return repo;
    });
    const expected = spawnSync(process.execPath, [oracle, ...args], {
      cwd: sides[0], encoding: "utf8", env: testEnv(dated),
    });
    if (rust === selectedCli) vlabPrefix();
    const actual = spawnSync(rust, args, {
      cwd: sides[1], encoding: "utf8", env: testEnv({ ...dated, CAUSET_DELEGATE: "never" }),
    });
    const label = JSON.stringify(args) + " #" + index;
    assert.equal(actual.status, expected.status, "status of " + label);
    assert.equal(rename(actual.stderr), rename(expected.stderr), "stderr of " + label);
    assert.equal(rename(actual.stdout), rename(expected.stdout), "stdout of " + label);
    const snapshot = (repo) => rename([
      git(repo, "status", "--porcelain").stdout,
      git(repo, "log", "-1", "--format=%H %P%n%B", "HEAD").stdout,
      git(repo, "notes", "--ref=causet", "show", "HEAD").stdout,
      git(repo, "log", "-1", "--format=%B", "refs/notes/causet").stdout,
      spawnSync(process.execPath, [oracle, "provenance", "HEAD", "--json"], {
        cwd: repo, encoding: "utf8", env: testEnv(dated),
      }).stdout,
    ].join("\n--\n"));
    assert.equal(snapshot(sides[1]), snapshot(sides[0]), "repository after " + label);
  }
});

test("workspace list, checkpoint and prune answer natively as the JavaScript CLI does (#149)", { skip }, () => {
  const rename = (text, side) => {
    const seen = new Map();
    const swap = (kind) => (match) => {
      if (!seen.has(match)) seen.set(match, "<" + kind + seen.size + ">");
      return seen.get(match);
    };
    return text
      .split(side).join("<side>")
      // A registered workspace id is random and enters the checkpoint commit.
      .replace(/"shortId": "[0-9a-f]{12}"/g, "\"shortId\": \"<short>\"")
      .replace(/\b[0-9a-f]{40}\b/g, swap("oid"))
      .replace(/\b[a-z]+_[0-9a-z]{9}[0-9a-f]{12}\b/g, swap("id"))
      .replace(/\b(?:draft|lock)_[0-9a-z]+\b/g, swap("draft"))
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, swap("time"))
      .replace(/process \d+ on [^\n]+/g, "process <pid> on <host>");
  };
  const dated = {
    ...neutral,
    GIT_AUTHOR_DATE: "2026-01-02T03:04:05Z",
    GIT_COMMITTER_DATE: "2026-01-02T03:04:05Z",
  };
  const git = (cwd, ...args) => spawnSync("git", args, { cwd, encoding: "utf8", env: testEnv(dated) });
  const cst = (cwd, ...args) => {
    const made = spawnSync(process.execPath, [oracle, ...args], { cwd, encoding: "utf8", env: testEnv(dated) });
    assert.equal(made.status, 0, `${args.join(" ")}\n${made.stderr}`);
  };
  // Both sides build the same repository; only the directory naming the side differs.
  const build = (side) => {
    const repo = path.join(outside, side, "repo");
    fs.mkdirSync(repo, { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.name", "Workspace twin");
    git(repo, "config", "user.email", "workspace-twin@example.invalid");
    fs.mkdirSync(path.join(repo, "src"));
    fs.writeFileSync(path.join(repo, "src", "a.txt"), "a\n");
    fs.writeFileSync(path.join(repo, "top.txt"), "top\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "base");
    cst(repo, "workspace", "create", "alpha");
    cst(repo, "workspace", "create", "beta", "--cone", "src", "--owner", "Ada");
    return { repo, alpha: path.join(outside, side, "repo.workspaces", "alpha"), beta: path.join(outside, side, "repo.workspaces", "beta") };
  };
  const runtime = (repo) => path.join(repo, ".git", "causet");
  const editRegistry = (repo, change) => {
    const file = path.join(runtime(repo), "workspaces.json");
    const registry = JSON.parse(fs.readFileSync(file, "utf8"));
    change(registry);
    fs.writeFileSync(file, `${JSON.stringify(registry, null, 2)}\n`);
  };
  const cases = [
    [["workspace", "list"]],
    [["workspace", "list", "--json"], ({ alpha, beta }) => {
      fs.writeFileSync(path.join(alpha, "dirty.txt"), "dirty\n");
      fs.rmSync(beta, { recursive: true, force: true });
    }],
    [["workspace", "list"], ({ repo, beta }) => {
      fs.rmSync(beta, { recursive: true, force: true });
      fs.writeFileSync(beta, "not a directory\n");
      editRegistry(repo, (registry) => {
        registry.workspaces[0].lifecycle = "archived";
        registry.workspaces.push({ schema: "causet.workspace/v1", id: "ws_custom", name: "gamma", path: 42 });
      });
    }],
    [["workspace", "checkpoint"]],
    [["workspace", "checkpoint", "--label", "Second", "--json"], ({ repo }) => {
      fs.writeFileSync(path.join(repo, "untracked.txt"), "new\n");
      cst(repo, "workspace", "checkpoint", "--label", "First");
    }],
    [["workspace", "checkpoint", "--label", "In alpha"], null, "alpha"],
    [["workspace", "checkpoint"], ({ repo }) => editRegistry(repo, (registry) => {
      registry.workspaces[0].lifecycle = "archived";
    }), "alpha"],
    [["workspace", "checkpoint"], ({ repo }) => editRegistry(repo, (registry) => {
      registry.workspaces.unshift({ schema: "causet.workspace/v1", id: "ws_bad", name: "bad", path: null });
    })],
    [["workspace", "prune"], ({ beta }) => fs.rmSync(beta, { recursive: true, force: true })],
    [["workspace", "prune", "--apply", "--json"], ({ beta }) => fs.rmSync(beta, { recursive: true, force: true })],
    [["workspace", "prune", "--apply"]],
    [["workspace", "prune", "--apply", "--dry-run"]],
    [["workspace", "prune", "--apply"], ({ repo, beta }) => {
      fs.rmSync(beta, { recursive: true, force: true });
      fs.mkdirSync(path.join(repo, ".git", "worktrees", "alpha", "vcs-lab"), { recursive: true });
      fs.writeFileSync(path.join(repo, ".git", "worktrees", "alpha", "vcs-lab", "rebase.json"), "{}\n");
    }],
    [["workspace", "list"], ({ repo }) => fs.writeFileSync(path.join(runtime(repo), "workspaces.json"), "{ not json")],
    [["workspace", "list", "--json"], ({ repo }) => editRegistry(repo, (registry) => { registry.schema = "causet.workspaces/v9"; })],
    [["workspace", "prune"], ({ repo }) => editRegistry(repo, (registry) => { registry.workspaces = {}; })],
    [["workspace", "list"], ({ repo }) => editRegistry(repo, (registry) => { registry.workspaces[1].schema = "causet.note/v1"; })],
  ];
  for (const [index, [args, prepare, where]] of cases.entries()) {
    const sides = ["js", "rust"].map((name) => {
      const side = `ws-${name}-${index}`;
      const fixture = build(side);
      prepare?.(fixture);
      return { side, ...fixture, cwd: where ? fixture[where] : fixture.repo };
    });
    const expected = spawnSync(process.execPath, [oracle, ...args], {
      cwd: sides[0].cwd, encoding: "utf8", env: testEnv(dated),
    });
    if (rust === selectedCli) vlabPrefix();
    const actual = spawnSync(rust, args, {
      cwd: sides[1].cwd, encoding: "utf8", env: testEnv({ ...dated, CAUSET_DELEGATE: "never" }),
    });
    const label = JSON.stringify(args) + " #" + index;
    const [js, rs] = sides;
    assert.equal(actual.status, expected.status, "status of " + label + "\n" + actual.stderr + expected.stderr);
    assert.equal(rename(actual.stderr, rs.side), rename(expected.stderr, js.side), "stderr of " + label);
    assert.equal(rename(actual.stdout, rs.side), rename(expected.stdout, js.side), "stdout of " + label);
    const snapshot = ({ repo, side }) => rename([
      git(repo, "for-each-ref", "--format=%(refname) %(objectname)").stdout,
      git(repo, "worktree", "list", "--porcelain").stdout,
      fs.readFileSync(path.join(runtime(repo), "workspaces.json"), "utf8"),
      fs.readdirSync(runtime(repo)).sort().join(","),
    ].join("\n--\n"), side);
    assert.equal(snapshot(rs), snapshot(js), "repository after " + label);
  }
});

test("workspace create, move, archive, restore and repair answer natively as the JavaScript CLI does (#149)", { skip }, () => {
  const rename = (text, side) => {
    const seen = new Map();
    const swap = (kind) => (match) => {
      if (!seen.has(match)) seen.set(match, "<" + kind + seen.size + ">");
      return seen.get(match);
    };
    return text
      .split(side).join("<side>")
      .replace(/\b[0-9a-f]{40}\b/g, swap("oid"))
      .replace(/\b[a-z]+_[0-9a-z]{9}[0-9a-f]{12}\b/g, swap("id"))
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, swap("time"));
  };
  const dated = {
    ...neutral,
    GIT_AUTHOR_DATE: "2026-01-02T03:04:05Z",
    GIT_COMMITTER_DATE: "2026-01-02T03:04:05Z",
  };
  const git = (cwd, ...args) => spawnSync("git", args, { cwd, encoding: "utf8", env: testEnv(dated) });
  const cst = (cwd, ...args) => {
    const made = spawnSync(process.execPath, [oracle, ...args], { cwd, encoding: "utf8", env: testEnv(dated) });
    assert.equal(made.status, 0, `${args.join(" ")}\n${made.stderr}`);
  };
  const build = (side) => {
    const base = path.join(outside, side);
    const repo = path.join(base, "repo");
    fs.mkdirSync(repo, { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.name", "Workspace twin");
    git(repo, "config", "user.email", "workspace-twin@example.invalid");
    for (const directory of ["src", "lib", "docs"]) {
      fs.mkdirSync(path.join(repo, directory));
      fs.writeFileSync(path.join(repo, directory, "file.txt"), `${directory}\n`);
    }
    fs.writeFileSync(path.join(repo, ".gitignore"), "*.log\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "base");
    cst(repo, "workspace", "create", "alpha");
    cst(repo, "workspace", "create", "beta", "--cone", "src");
    const workspaces = path.join(base, "repo.workspaces");
    return { base, repo, alpha: path.join(workspaces, "alpha"), beta: path.join(workspaces, "beta") };
  };
  const editRegistry = (repo, change) => {
    const file = path.join(repo, ".git", "causet", "workspaces.json");
    const registry = JSON.parse(fs.readFileSync(file, "utf8"));
    change(registry);
    fs.writeFileSync(file, `${JSON.stringify(registry, null, 2)}\n`);
  };
  // [args (from the fixture), prepare, where to run]
  const cases = [
    [() => ["workspace", "create", "gamma"]],
    [() => ["workspace", "create", "Delta Docs", "--cone", " docs/ ,./lib,src\\,docs", "--owner", "Ada", "--focus", "docs", "--json"]],
    [(f) => ["workspace", "create", "custom", "--path", path.join(f.base, "elsewhere", "custom"), "--from", "HEAD~0"]],
    [() => ["workspace", "create", "alpha"]],
    [() => ["workspace", "create", "Alpha!"]],
    [() => ["workspace", "create", "epsilon", "--from", "no-such-revision"]],
    [() => ["workspace", "create", "zeta", "--cone", "../outside"]],
    [() => ["workspace", "create", "eta", "--cone", "C:relative"]],
    [() => ["workspace", "create", "theta", "--cone", " , "]],
    [(f) => ["workspace", "move", "alpha", path.join(f.base, "moved", "alpha")]],
    [(f) => ["workspace", "move", "alpha", f.alpha]],
    [(f) => ["workspace", "move", "alpha", f.beta]],
    [(f) => ["workspace", "move", "nobody", path.join(f.base, "x")]],
    [(f) => ["workspace", "move", "alpha", path.join(f.base, "x")], null, "alpha"],
    [(f) => ["workspace", "move", "alpha", path.join(f.base, "moved")], (f) => editRegistry(f.repo, (registry) => {
      registry.workspaces[0].previousPaths = 5;
    })],
    [(f) => ["workspace", "move", "beta", path.join(f.base, "moved")], (f) => editRegistry(f.repo, (registry) => {
      registry.workspaces[1].previousPaths = ["../relative", f.beta, "../relative"];
    })],
    [() => ["workspace", "archive", "alpha", "--json"]],
    [() => ["workspace", "archive", "alpha"], (f) => fs.writeFileSync(path.join(f.alpha, "src", "file.txt"), "changed\n")],
    [() => ["workspace", "archive", "alpha"], (f) => fs.writeFileSync(path.join(f.alpha, "debug.log"), "noise\n")],
    [() => ["workspace", "archive", "alpha"], (f) => {
      const journal = path.join(f.repo, ".git", "worktrees", "alpha", "causet");
      fs.mkdirSync(journal, { recursive: true });
      fs.writeFileSync(path.join(journal, "reconciliation.json"), "{}\n");
    }],
    [() => ["workspace", "archive", "alpha"], (f) => cst(f.repo, "workspace", "archive", "alpha")],
    [() => ["workspace", "restore", "beta"], (f) => cst(f.repo, "workspace", "archive", "beta")],
    [(f) => ["workspace", "restore", "beta", "--path", path.join(f.base, "restored")], (f) => cst(f.repo, "workspace", "archive", "beta")],
    [() => ["workspace", "restore", "alpha"]],
    [() => ["workspace", "restore", "beta"], (f) => {
      cst(f.repo, "workspace", "archive", "beta");
      git(f.repo, "branch", "-D", "causet/ws/beta");
    }],
    [() => ["workspace", "restore", "beta"], (f) => {
      cst(f.repo, "workspace", "archive", "beta");
      fs.mkdirSync(f.beta, { recursive: true });
    }],
    [(f) => ["workspace", "repair", "alpha", "--path", path.join(f.base, "relocated")], (f) => {
      fs.renameSync(f.alpha, path.join(f.base, "relocated"));
    }],
    [(f) => ["workspace", "repair", "alpha", "--path", path.join(f.base, "missing")]],
    [(f) => ["workspace", "repair", "alpha", "--path", f.beta]],
    [(f) => ["workspace", "repair", "alpha", "--path", path.join(f.base, "plain")], (f) => {
      fs.rmSync(f.alpha, { recursive: true, force: true });
      fs.mkdirSync(path.join(f.base, "plain"));
    }],
    [(f) => ["workspace", "repair", "alpha", "--path", path.join(f.base, "relocated")], (f) => {
      fs.renameSync(f.alpha, path.join(f.base, "relocated"));
      git(path.join(f.base, "relocated"), "checkout", "-q", "--detach");
    }],
  ];
  for (const [index, [argsOf, prepare, where]] of cases.entries()) {
    const sides = ["js", "rust"].map((name) => {
      const side = `wl-${name}-${index}`;
      const fixture = build(side);
      prepare?.(fixture);
      return { side, ...fixture, args: argsOf(fixture), cwd: where ? fixture[where] : fixture.repo };
    });
    const [js, rs] = sides;
    const expected = spawnSync(process.execPath, [oracle, ...js.args], {
      cwd: js.cwd, encoding: "utf8", env: testEnv(dated),
    });
    if (rust === selectedCli) vlabPrefix();
    const actual = spawnSync(rust, rs.args, {
      cwd: rs.cwd, encoding: "utf8", env: testEnv({ ...dated, CAUSET_DELEGATE: "never" }),
    });
    const label = JSON.stringify(js.args) + " #" + index;
    assert.equal(actual.status, expected.status, "status of " + label + "\n" + actual.stderr + expected.stderr);
    assert.equal(rename(actual.stderr, rs.side), rename(expected.stderr, js.side), "stderr of " + label);
    assert.equal(rename(actual.stdout, rs.side), rename(expected.stdout, js.side), "stdout of " + label);
    const snapshot = ({ repo, side, base }) => rename([
      git(repo, "for-each-ref", "--format=%(refname) %(objectname)").stdout,
      git(repo, "worktree", "list", "--porcelain").stdout,
      fs.readFileSync(path.join(repo, ".git", "causet", "workspaces.json"), "utf8"),
      fs.readdirSync(path.join(repo, ".git", "causet")).sort().join(","),
      fs.readdirSync(base, { recursive: true }).filter((entry) => !/[\\/]\.git|^repo[\\/]|^\.git/.test(entry)).sort().join(","),
    ].join("\n--\n"), side);
    assert.equal(snapshot(rs), snapshot(js), "repository after " + label);
  }
});

test("spec merge-plan answers natively, byte for byte (#149)", { skip }, () => {
  const repo = path.join(outside, "spec-plan-repo");
  fs.mkdirSync(path.join(repo, "specs"), { recursive: true });
  const git = (...args) => spawnSync("git", args, { cwd: repo, encoding: "utf8", env: testEnv() });
  const cst = (...args) => {
    const made = spawnSync(process.execPath, [oracle, ...args], { cwd: repo, encoding: "utf8", env: testEnv(neutral) });
    assert.equal(made.status, 0, `${args.join(" ")}\n${made.stderr}`);
  };
  const write = (name, text) => fs.writeFileSync(path.join(repo, name), text);
  const commitSpec = (message, ...files) => {
    for (const file of files) cst("spec", "index", file);
    git("add", "-A");
    git("commit", "-q", "-m", message);
  };
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Spec twin");
  git("config", "user.email", "spec-twin@example.invalid");
  git("config", "core.autocrlf", "false");
  const design = (intro, alpha, beta) => [
    "# Design", "", intro, "",
    "## Alpha", "", alpha, "",
    "```md", "# Not a heading inside a fence", "```", "",
    "## Beta", "", beta, "",
    "- REQ-1: The system shall stay deterministic.", "",
  ].join("\n");
  write("specs/design.md", design("Intro.", "Alpha text.", "Beta text."));
  write("notes.txt", "plain\n");
  commitSpec("base", "specs/design.md");
  git("switch", "-q", "-c", "ours");
  write("specs/design.md", design("Intro.", "Alpha text, ours.", "Beta text."));
  write("specs/added.md", "# Added\n\nOnly ours has it.\n");
  commitSpec("ours", "specs/design.md", "specs/added.md");
  git("switch", "-q", "-c", "theirs", "main");
  write("specs/design.md", design("Intro.", "Alpha text.", "Beta text, theirs."));
  commitSpec("theirs", "specs/design.md");
  git("switch", "-q", "-c", "rival", "main");
  write("specs/design.md", design("Intro.", "Alpha text, rival.", "Beta text."));
  commitSpec("rival", "specs/design.md");
  git("switch", "-q", "-c", "unindexed", "main");
  write("specs/design.md", design("Intro, unindexed.", "Alpha text.", "Beta text."));
  git("commit", "-q", "-am", "edit without indexing");
  git("switch", "-q", "main");

  const inRepo = (command, args, env) => spawnSync(command, args, {
    cwd: repo, encoding: "utf8", env: testEnv({ ...neutral, ...env }),
  });
  for (const args of [
    ["spec", "merge-plan", "specs/design.md", "main", "ours", "theirs"],
    ["spec", "merge-plan", "specs/design.md", "main", "ours", "theirs", "--json"],
    ["spec", "merge-plan", "specs/design.md", "main", "ours", "rival"],
    ["spec", "merge-plan", "specs/design.md", "main", "ours", "rival", "--json"],
    ["spec", "merge-plan", "specs/design.md", "main", "main", "theirs"],
    ["spec", "merge-plan", "specs/added.md", "main", "ours", "theirs", "--json"],
    ["spec", "merge-plan", "specs/design.md", "main", "unindexed", "theirs"],
    ["spec", "merge-plan", "specs/design.md", "main", "unindexed", "theirs", "--json"],
    ["spec", "merge-plan", "notes.txt", "main", "ours", "theirs"],
    ["spec", "merge-plan", "specs/design.md", "main", "no-such-revision", "theirs", "--json"],
    ["spec", "merge-plan", "../outside.md", "main", "ours", "theirs"],
    ["spec", "merge-plan", "specs/missing.md", "main", "ours", "theirs"],
  ]) {
    const expected = inRepo(process.execPath, [oracle, ...args], {});
    if (rust === selectedCli) vlabPrefix();
    const actual = inRepo(rust, args, { CAUSET_DELEGATE: "never" });
    const label = JSON.stringify(args);
    assert.equal(actual.status, expected.status, `status of ${label}\n${actual.stderr}`);
    assert.equal(actual.stdout, expected.stdout, `stdout of ${label}`);
    assert.equal(actual.stderr, expected.stderr, `stderr of ${label}`);
  }
});

test("spec index writes the same manifests natively, single and --all (#149)", { skip }, () => {
  const rename = (text) => {
    const seen = new Map();
    const swap = (kind) => (match) => {
      if (!seen.has(match)) seen.set(match, "<" + kind + seen.size + ">");
      return seen.get(match);
    };
    return text
      .replace(/\b[a-z]+_[0-9a-z]{9}[0-9a-f]{12}\b/g, swap("id"))
      // Entity ids derive from the random artifact id.
      .replace(/\bent_[0-9a-f]{24}\b/g, swap("entity"))
      .replace(/("(?:durationMs|preparationMs|totalDurationMs)": )[\d.]+/g, "$1<ms>")
      .replace(/duration {5}[\d.]+ ms \([\d.]+ ms/g, "duration     <ms> ms (<ms> ms");
  };
  const base = path.join(outside, "spec-index-base");
  fs.mkdirSync(path.join(base, "specs"), { recursive: true });
  const git = (cwd, ...args) => spawnSync("git", args, { cwd, encoding: "utf8", env: testEnv() });
  const cst = (cwd, ...args) => {
    const made = spawnSync(process.execPath, [oracle, ...args], { cwd, encoding: "utf8", env: testEnv(neutral) });
    assert.equal(made.status, 0, `${args.join(" ")}\n${made.stderr}`);
  };
  const design = (alpha, extra = "") => [
    "# Design", "", "Intro.", "",
    "## Alpha", "", alpha, "",
    "```md", "# Fenced, not a heading", "```", "",
    extra,
    "## Beta", "", "Beta text.", "",
    "- REQ-1: The system shall stay deterministic.", "",
  ].join("\n");
  git(base, "init", "-q", "-b", "main");
  git(base, "config", "user.name", "Spec twin");
  git(base, "config", "user.email", "spec-twin@example.invalid");
  git(base, "config", "core.autocrlf", "false");
  fs.writeFileSync(path.join(base, "specs", "design.md"), design("Alpha text."));
  fs.writeFileSync(path.join(base, "specs", "other.md"), "# Other\n\nText.\n");
  fs.writeFileSync(path.join(base, "README.md"), "# Readme\n");
  git(base, "add", "-A");
  git(base, "commit", "-q", "-m", "base");
  const manifestFile = (repo, name) => path.join(repo, ".causet", "specs", "specs", `${name}.json`);
  const indexed = (repo) => {
    cst(repo, "spec", "index", "specs/design.md");
    cst(repo, "spec", "index", "specs/other.md");
  };
  const legacy = (repo, verifiable) => {
    cst(repo, "spec", "index", "specs/design.md");
    const file = manifestFile(repo, "design.md");
    const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
    manifest.schema = "causet.spec-manifest/v2";
    manifest.parser = "stable-markdown-blocks/v1";
    if (!verifiable) {
      manifest.sourceHash = "0".repeat(64);
      delete manifest.sourceBlob;
    }
    fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  };
  const cases = [
    [["spec", "index", "specs/design.md"]],
    [["spec", "index", "specs/design.md", "--json"]],
    [["spec", "index", "specs/design.md"], indexed],
    [["spec", "index", "specs/design.md", "--json"], (repo) => {
      indexed(repo);
      fs.writeFileSync(path.join(repo, "specs", "design.md"), design("Alpha text, edited.", "## Gamma\n\nNew.\n\n"));
    }],
    [["spec", "index", "specs/design.md", "--force"], indexed],
    [["spec", "index", "specs/design.md", "--json"], (repo) => legacy(repo, true)],
    [["spec", "index", "specs/design.md"], (repo) => legacy(repo, false)],
    [["spec", "index", "specs/design.md"], (repo) => {
      fs.mkdirSync(path.join(repo, ".causet", "specs", "specs"), { recursive: true });
      fs.writeFileSync(manifestFile(repo, "design.md"), "{\"schema\":\"causet.spec-manifest/v9\",\"artifactId\":\"a\",\"source\":\"s\"}\n");
    }],
    [["spec", "index", "specs/missing.md"]],
    [["spec", "index", "../outside.md"]],
    [["spec", "index", "specs"]],
    [["spec", "index", "--all"]],
    [["spec", "index", "--all", "--json"], (repo) => {
      indexed(repo);
      fs.writeFileSync(path.join(repo, "specs", "design.md"), design("Alpha text, dirty."));
      fs.writeFileSync(path.join(repo, "specs", "untracked.md"), "# Untracked\n");
    }],
    [["spec", "index", "--all", "--force", "--json"], indexed],
  ];
  for (const [index, [args, prepare]] of cases.entries()) {
    const sides = ["js", "rust"].map((name) => {
      const repo = path.join(outside, `spec-index-${name}-${index}`);
      fs.cpSync(base, repo, { recursive: true });
      prepare?.(repo);
      return repo;
    });
    const expected = spawnSync(process.execPath, [oracle, ...args], {
      cwd: sides[0], encoding: "utf8", env: testEnv(neutral),
    });
    if (rust === selectedCli) vlabPrefix();
    const actual = spawnSync(rust, args, {
      cwd: sides[1], encoding: "utf8", env: testEnv({ ...neutral, CAUSET_DELEGATE: "never" }),
    });
    const label = JSON.stringify(args) + " #" + index;
    const local = (text, repo) => rename(text.split(JSON.stringify(repo).slice(1, -1)).join("<repo>").split(repo).join("<repo>"));
    assert.equal(actual.status, expected.status, "status of " + label + "\n" + actual.stderr + expected.stderr);
    assert.equal(local(actual.stderr, sides[1]), local(expected.stderr, sides[0]), "stderr of " + label);
    assert.equal(local(actual.stdout, sides[1]), local(expected.stdout, sides[0]), "stdout of " + label);
    const snapshot = (repo) => {
      const directory = path.join(repo, ".causet", "specs", "specs");
      const manifests = fs.existsSync(directory)
        ? fs.readdirSync(directory).sort().map((name) => `${name}\n${fs.readFileSync(path.join(directory, name), "utf8")}`)
        : [];
      return rename([...manifests, git(repo, "count-objects", "-v").stdout.split("\n")[0]].join("\n--\n"));
    };
    assert.equal(snapshot(sides[1]), snapshot(sides[0]), "manifests after " + label);
  }
});

test("spec resolve applies a paused step's deterministic merges natively (#149)", { skip }, () => {
  const rename = (text) => {
    const seen = new Map();
    const swap = (kind) => (match) => {
      if (!seen.has(match)) seen.set(match, "<" + kind + seen.size + ">");
      return seen.get(match);
    };
    return text
      .replace(/\b[a-z]+_[0-9a-z]{9}[0-9a-f]{12}\b/g, swap("id"))
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, swap("time"));
  };
  const dated = {
    ...neutral,
    GIT_AUTHOR_DATE: "2026-01-02T03:04:05Z",
    GIT_COMMITTER_DATE: "2026-01-02T03:04:05Z",
  };
  const git = (cwd, ...args) => spawnSync("git", args, { cwd, encoding: "utf8", env: testEnv(dated) });
  const cst = (cwd, ...args) => spawnSync(process.execPath, [oracle, ...args], { cwd, encoding: "utf8", env: testEnv(dated) });
  const must = (cwd, ...args) => {
    const made = cst(cwd, ...args);
    assert.equal(made.status, 0, `${args.join(" ")}\n${made.stderr}`);
  };
  const spec = (alpha, beta) => `# Alpha\n\n${alpha}\n\n# Beta\n\n${beta}\n`;
  // A paused reconciliation of `feature` onto `main`, its spec conflicts
  // given by `targetAlpha`: the same block as the source for a blocked plan.
  const build = (name, { targetAlpha = "base alpha", second = false } = {}) => {
    const repo = path.join(outside, name);
    fs.mkdirSync(path.join(repo, "docs"), { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.name", "Resolve twin");
    git(repo, "config", "user.email", "resolve-twin@example.invalid");
    git(repo, "config", "core.autocrlf", "false");
    const files = second ? ["docs/spec.md", "docs/two.md"] : ["docs/spec.md"];
    const stage = (alpha, beta, message) => {
      for (const file of files) {
        fs.writeFileSync(path.join(repo, file), spec(alpha, beta));
        must(repo, "spec", "index", file);
      }
      git(repo, "add", ".");
      must(repo, "commit", "-m", message);
    };
    stage("base alpha", "base beta", "base specification");
    must(repo, "init");
    git(repo, "switch", "-q", "-c", "feature");
    stage("source alpha", "base beta", "source edits alpha");
    git(repo, "switch", "-q", "main");
    stage(targetAlpha, "target beta", "target edits");
    assert.notEqual(cst(repo, "reconcile", "feature").status, 0);
    return repo;
  };
  const journal = (repo) => path.join(repo, ".git", "causet", "reconciliation.json");
  const editJournal = (repo, change) => {
    const state = JSON.parse(fs.readFileSync(journal(repo), "utf8"));
    change(state);
    fs.writeFileSync(journal(repo), `${JSON.stringify(state, null, 2)}\n`);
  };
  const cases = [
    [["spec", "resolve"]],
    [["spec", "resolve", "--all", "--json"]],
    [["spec", "resolve", "docs/spec.md"]],
    [["spec", "resolve", "docs/other.md"], {}, null, /No semantic specification merge is pending/],
    [["spec", "resolve", "--json"], { targetAlpha: "target alpha" }, null, /manual-review-required/],
    [["spec", "resolve"], { second: true }, null, /Choose a spec path or pass --all/],
    [["spec", "resolve", "--all"], { second: true }],
    [["spec", "resolve", "docs/two.md", "--json"], { second: true }],
    [["spec", "resolve", "--all"], {}, (repo) => editJournal(repo, (state) => { state.current.semanticMerges = 5; }), /\(\(intermediate value\) \?\? \[\]\) is not iterable/],
    [["spec", "resolve", "--all"], {}, (repo) => editJournal(repo, (state) => {
      state.current.semanticMerges = [{ path: "docs/spec.md", algorithm: "stable-markdown-three-way/v2" }, { path: "keep.md", algorithm: "stable-markdown-three-way/v2" }];
    })],
    [["spec", "resolve", "--all"], {}, (repo) => editJournal(repo, (state) => { state.approvedSpecMerges = [null]; }), /reading 'algorithm'/],
    [["spec", "resolve", "--all"], {}, (repo) => editJournal(repo, (state) => { state.steps = [{ semanticMerges: [{ algorithm: "stable-markdown-three-way/v1" }] }]; }), /unsupported merge algorithm/],
    [["spec", "resolve", "--all"], {}, (repo) => editJournal(repo, (state) => { state.forecastApproval = { applied: "x" }; }), /flatMap is not a function/],
    [["spec", "resolve", "--all"], {}, (repo) => editJournal(repo, (state) => { delete state.id; })],
    [["spec", "resolve", "--all"], {}, (repo) => fs.rmSync(journal(repo)), /No VCS Lab conflict is pending/],
  ];
  const fixtures = new Map();
  for (const [index, [args, options = {}, prepare, outcome]] of cases.entries()) {
    const key = JSON.stringify(options);
    if (!fixtures.has(key)) fixtures.set(key, build(`resolve-base-${fixtures.size}`, options));
    const sides = ["js", "rust"].map((name) => {
      const repo = path.join(outside, `resolve-${name}-${index}`);
      fs.cpSync(fixtures.get(key), repo, { recursive: true });
      prepare?.(repo);
      return repo;
    });
    const expected = spawnSync(process.execPath, [oracle, ...args], {
      cwd: sides[0], encoding: "utf8", env: testEnv(dated),
    });
    if (rust === selectedCli) vlabPrefix();
    const actual = spawnSync(rust, args, {
      cwd: sides[1], encoding: "utf8", env: testEnv({ ...dated, CAUSET_DELEGATE: "never" }),
    });
    const label = JSON.stringify(args) + " #" + index;
    // Each case must reach the path it is named for, not fail alike for another reason.
    if (outcome) assert.match(expected.stdout + expected.stderr, outcome, label);
    else assert.equal(expected.status, 0, `${label}\n${expected.stderr}`);
    assert.equal(actual.status, expected.status, "status of " + label + "\n" + actual.stderr + expected.stderr);
    assert.equal(rename(actual.stderr), rename(expected.stderr), "stderr of " + label);
    assert.equal(rename(actual.stdout), rename(expected.stdout), "stdout of " + label);
    const snapshot = (repo) => rename([
      git(repo, "status", "--porcelain=v1").stdout,
      git(repo, "diff", "--cached").stdout,
      fs.existsSync(journal(repo)) ? fs.readFileSync(journal(repo), "utf8") : "(no journal)",
    ].join("\n--\n"));
    assert.equal(snapshot(sides[1]), snapshot(sides[0]), "repository after " + label);
  }
});

test("resolve apply and reject record decisions on a paused step natively (#147)", { skip }, () => {
  const rename = (text) => {
    const seen = new Map();
    const swap = (kind) => (match) => {
      if (!seen.has(match)) seen.set(match, "<" + kind + seen.size + ">");
      return seen.get(match);
    };
    return text
      .replace(/\b[a-z]+_[0-9a-z]{9}[0-9a-f]{12}\b/g, swap("id"))
      // Two writes in one millisecond share a time in one CLI and not the other.
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, "<time>");
  };
  const dated = {
    ...neutral,
    GIT_AUTHOR_DATE: "2026-01-02T03:04:05Z",
    GIT_COMMITTER_DATE: "2026-01-02T03:04:05Z",
  };
  const git = (cwd, ...args) => spawnSync("git", args, { cwd, encoding: "utf8", env: testEnv(dated) });
  const cst = (cwd, ...args) => spawnSync(process.execPath, [oracle, ...args], { cwd, encoding: "utf8", env: testEnv(dated) });
  const must = (cwd, ...args) => {
    const made = cst(cwd, ...args);
    assert.equal(made.status, 0, `${args.join(" ")}\n${made.stderr}`);
  };
  const write =(repo, file, text) => fs.writeFileSync(path.join(repo, file), text);
  // A step paused on conflicts whose signatures match retained resolutions:
  // each pair edits the same files the same way from the same base, so every
  // pair's conflict has one signature, and resolving the first retains it.
  const build = (name, { files = ["shared.txt"], result = "text", ambiguous = false, rebase = false } = {}) => {
    const repo = path.join(outside, name);
    fs.mkdirSync(repo, { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.name", "Resolve twin");
    git(repo, "config", "user.email", "resolve-twin@example.invalid");
    git(repo, "config", "core.autocrlf", "false");
    for (const file of files) write(repo, file, "base\n");
    git(repo, "add", ".");
    must(repo, "commit", "-m", "base");
    must(repo, "init");
    const base = git(repo, "rev-parse", "HEAD").stdout.trim();
    const pair = (suffix) => {
      git(repo, "switch", "-q", "-c", `source-${suffix}`, base);
      for (const file of files) write(repo, file, "source\n");
      git(repo, "add", ".");
      must(repo, "commit", "-m", `source ${suffix}`);
      git(repo, "switch", "-q", "-c", `target-${suffix}`, base);
      for (const file of files) write(repo, file, "target\n");
      git(repo, "add", ".");
      must(repo, "commit", "-m", `target ${suffix}`);
      return `source-${suffix}`;
    };
    const remember = (suffix, text) => {
      assert.notEqual(cst(repo, "reconcile", pair(suffix)).status, 0);
      for (const file of files) {
        if (result === "delete") {
          git(repo, "rm", "-q", file);
          continue;
        }
        write(repo, file, text);
        // The worktree file is made executable too: where Git tracks file
        // modes, a mode only the index holds is a change that blocks the next
        // reconciliation.
        if (result === "exec") fs.chmodSync(path.join(repo, file), 0o755);
        git(repo, "add", file);
        if (result === "exec") git(repo, "update-index", "--chmod=+x", file);
      }
      must(repo, "reconcile", "--continue");
    };
    remember("one", "remembered\n");
    if (ambiguous) remember("two", "other\n");
    const last = pair("last");
    if (rebase) git(repo, "switch", "-q", last);
    const paused = rebase ? cst(repo, "rebase", "target-last") : cst(repo, "reconcile", last);
    assert.match(paused.stderr, /paused/i, `${name} must pause on a conflict\n${paused.stderr}`);
    return repo;
  };
  const journalOf = (repo) => ["reconciliation.json", "rebase.json"]
    .map((file) => path.join(repo, ".git", "causet", file))
    .find((file) => fs.existsSync(file));
  const editJournal = (change) => (repo) => {
    const file = journalOf(repo);
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    change(state);
    fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
  };
  const two = { files: ["shared.txt", "other.txt"] };
  const cases = [
    [["resolve", "apply"]],
    [["resolve", "apply", "--json"]],
    [["resolve", "apply", "shared.txt", "--json"]],
    [["resolve", "apply", "missing.txt"], {}, null, /'missing\.txt' is not a current conflict path/],
    [["resolve", "apply", "--all", "--resolution", "resolution_nope"], {}, null, /is not a candidate for 'shared\.txt'/],
    [["resolve", "apply", "--all", "--resolution", "<candidate>", "--json"]],
    [["resolve", "apply", "--all"], { ambiguous: true }, null, /Multiple resolutions match 'shared\.txt'/],
    [["resolve", "apply", "--all", "--resolution", "<candidate>"], { ambiguous: true }],
    [["resolve", "apply"], two, null, /Choose a conflict path or pass --all/],
    [["resolve", "apply", "--all", "--json"], two],
    [["resolve", "apply", "other.txt"], two],
    [["resolve", "apply", "--all"], { result: "delete" }],
    [["resolve", "apply", "--all", "--json"], { result: "exec" }],
    [["resolve", "apply", "--all", "--json"], { rebase: true }],
    [["resolve", "reject"]],
    [["resolve", "reject", "shared.txt", "--json"]],
    [["resolve", "reject", "--all", "--resolution", "<candidate>", "--json"]],
    [["resolve", "reject", "--all", "--resolution", "resolution_nope"], {}, null, /is not a candidate/],
    [["resolve", "reject", "--all"], two],
    [["resolve", "reject", "--all", "--json"], { rebase: true }],
    [["resolve", "apply", "--all"], {}, (repo) => fs.rmSync(journalOf(repo)), /No reusable conflict resolutions are pending/],
    [["resolve", "reject"], {}, editJournal((state) => { state.current.conflicts = []; }), /No reusable conflict resolutions are pending/],
    [["resolve", "apply"], {}, editJournal((state) => { state.current.conflicts = "x"; }), /reading 'length'/],
    [["resolve", "apply", "--all"], {}, editJournal((state) => { state.current.conflicts = { length: 1, 0: state.current.conflicts[0] }; }), /selected\.map is not a function/],
    [["resolve", "apply", "--json"], {}, editJournal((state) => { state.current.conflicts = { length: 1, 0: state.current.conflicts[0] }; })],
    [["resolve", "apply", "shared.txt"], {}, editJournal((state) => { state.current.conflicts = [null]; }), /reading 'path'/],
    [["resolve", "apply", "shared.txt"], {}, editJournal((state) => { state.current.conflicts = { length: 1 }; }), /conflicts\.find is not a function/],
    [["resolve", "apply", "--all", "--resolution", "x"], {}, editJournal((state) => { state.current.conflicts[0].candidates = [null]; }), /reading 'id'/],
    [["resolve", "apply", "--all"], {}, editJournal((state) => { state.current.conflicts[0].candidates = 5; }), /reading 'resultBlob'/],
    [["resolve", "apply", "--all"], {}, editJournal((state) => { state.current.conflicts[0].candidates = "ab"; }), /Multiple resolutions match/],
    [["resolve", "apply", "--all"], {}, editJournal((state) => { state.current.conflicts[0].candidates[0].resultMode = "120000"; }), /Resolution mode '120000' is not supported/],
    [["resolve", "apply", "--all"], {}, editJournal((state) => { state.current.conflicts[0].path = 5; }), /"paths\[1\]" argument must be of type string\. Received type number \(5\)/],
    [["resolve", "reject", "--all"], {}, editJournal((state) => { state.current.conflicts[0].candidates = []; }), /No prior resolution matches 'shared\.txt'/],
    [["resolve", "reject", "--all", "--json"], {}, editJournal((state) => { delete state.id; })],
    [["resolve", "reject", "--all"], two, editJournal((state) => { state.current.conflicts[1].candidates = null; }), /reading 'length'/],
  ];
  const fixtures = new Map();
  for (const [index, [template, options = {}, prepare, outcome]] of cases.entries()) {
    const key = JSON.stringify(options);
    if (!fixtures.has(key)) fixtures.set(key, build(`resolution-base-${fixtures.size}`, options));
    const fixture = fixtures.get(key);
    const candidate = JSON.parse(cst(fixture, "resolve", "status", "--json").stdout)
      .conflicts[0].candidates.at(-1)?.id;
    const args = template.map((arg) => arg === "<candidate>" ? candidate : arg);
    const sides = ["js", "rust"].map((name) => {
      const repo = path.join(outside, `resolution-${name}-${index}`);
      fs.cpSync(fixture, repo, { recursive: true });
      prepare?.(repo);
      return repo;
    });
    const expected = spawnSync(process.execPath, [oracle, ...args], {
      cwd: sides[0], encoding: "utf8", env: testEnv(dated),
    });
    if (rust === selectedCli) vlabPrefix();
    const actual = spawnSync(rust, args, {
      cwd: sides[1], encoding: "utf8", env: testEnv({ ...dated, CAUSET_DELEGATE: "never" }),
    });
    const label = JSON.stringify(template) + " #" + index;
    // Each case must reach the path it is named for, not fail alike for another reason.
    if (outcome) assert.match(expected.stdout + expected.stderr, outcome, label);
    else assert.equal(expected.status, 0, `${label}\n${expected.stderr}`);
    assert.equal(actual.status, expected.status, "status of " + label + "\n" + actual.stderr + expected.stderr);
    assert.equal(rename(actual.stderr), rename(expected.stderr), "stderr of " + label);
    assert.equal(rename(actual.stdout), rename(expected.stdout), "stdout of " + label);
    const snapshot = (repo) => {
      const journal = journalOf(repo);
      return rename([
        git(repo, "status", "--porcelain=v1").stdout,
        git(repo, "ls-files", "--stage").stdout,
        git(repo, "diff").stdout,
        journal ? fs.readFileSync(journal, "utf8") : "(no journal)",
      ].join("\n--\n"));
    };
    assert.equal(snapshot(sides[1]), snapshot(sides[0]), "repository after " + label);
  }
});

// A forecast's Git activity lists commands by elapsed time, which differs run
// to run; ordered by name, the counts themselves must still agree.
const steadyMetrics = (text) => {
  let document;
  try {
    document = JSON.parse(text);
  } catch {
    return text;
  }
  const byCommand = document?.timings?.git?.byCommand;
  if (!Array.isArray(byCommand)) return text;
  byCommand.sort((left, right) => left.command.localeCompare(right.command));
  return `${JSON.stringify(document, null, 2)}\n`;
};

test("forecast simulates the same reconciliation natively under both engines (#147)", { skip }, () => {
  const rename = (text, repo) => {
    const seen = new Map();
    const swap = (kind) => (match) => {
      if (!seen.has(match)) seen.set(match, "<" + kind + seen.size + ">");
      return seen.get(match);
    };
    return steadyMetrics(text)
      .split(JSON.stringify(repo).slice(1, -1)).join("<repo>")
      .split(repo).join("<repo>")
      .split(repo.replaceAll("\\", "/")).join("<repo>")
      .replace(/\b[a-z]+_[0-9a-z]{9}[0-9a-f]{12}\b/g, swap("id"))
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, "<time>")
      // Durations differ run to run; Git process and query counts must not.
      .replace(/("[A-Za-z]*Ms": )-?[\d.e+-]+/g, "$1<ms>")
      .replace(/forecast time [\d.]+ ms/g, "forecast time <ms> ms")
      .replace(/queries \([\d.]+ ms\)/g, "queries (<ms> ms)");
  };
  const dated = {
    ...neutral,
    GIT_AUTHOR_DATE: "2026-01-02T03:04:05Z",
    GIT_COMMITTER_DATE: "2026-01-02T03:04:05Z",
  };
  const git = (cwd, ...args) => spawnSync("git", args, { cwd, encoding: "utf8", env: testEnv(dated) });
  const cst = (cwd, ...args) => spawnSync(process.execPath, [oracle, ...args], { cwd, encoding: "utf8", env: testEnv(dated) });
  const must = (cwd, ...args) => {
    const made = cst(cwd, ...args);
    assert.equal(made.status, 0, `${args.join(" ")}\n${made.stderr}`);
  };
  const write = (repo, file, text) => {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), text);
  };
  const commit = (repo, message, files) => {
    for (const [file, text] of Object.entries(files)) write(repo, file, text);
    git(repo, "add", "-A");
    must(repo, "commit", "-m", message);
  };
  const spec = (alpha, beta) => `# Alpha\n\n${alpha}\n\n# Beta\n\n${beta}\n`;
  // Every fixture reconciles `feature` into `main`, which is checked out.
  const build = (kind) => {
    const repo = path.join(outside, `forecast-base-${kind}`);
    fs.mkdirSync(repo, { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.name", "Forecast twin");
    git(repo, "config", "user.email", "forecast-twin@example.invalid");
    git(repo, "config", "core.autocrlf", "false");
    const specs = kind.startsWith("spec");
    if (specs) {
      write(repo, "docs/spec.md", spec("base alpha", "base beta"));
      must(repo, "spec", "index", "docs/spec.md");
    }
    commit(repo, "base", { "shared.txt": "base\n", "a.txt": "1\n" });
    must(repo, "init");
    const base = git(repo, "rev-parse", "HEAD").stdout.trim();
    const conflictPair = (suffix) => {
      git(repo, "switch", "-q", "-c", `source-${suffix}`, base);
      commit(repo, `source ${suffix}`, { "shared.txt": "source\n" });
      git(repo, "switch", "-q", "-c", `target-${suffix}`, base);
      commit(repo, `target ${suffix}`, { "shared.txt": "target\n" });
    };
    const remember = (suffix, text) => {
      conflictPair(suffix);
      assert.notEqual(cst(repo, "reconcile", `source-${suffix}`).status, 0);
      write(repo, "shared.txt", text);
      git(repo, "add", "shared.txt");
      must(repo, "reconcile", "--continue");
    };
    if (kind === "exact" || kind === "ambiguous") {
      remember("one", "remembered\n");
      if (kind === "ambiguous") remember("two", "other\n");
      conflictPair("last");
      git(repo, "branch", "-q", "-f", "feature", "source-last");
      git(repo, "branch", "-q", "-f", "main", "target-last");
      git(repo, "switch", "-q", "main");
      return repo;
    }
    git(repo, "switch", "-q", "-c", "feature");
    if (kind === "clean" || kind === "dirty" || kind === "paused") {
      commit(repo, "feature adds b", { "b.txt": "b\n" });
      commit(repo, "feature edits a", { "a.txt": "2\n" });
    } else if (kind === "conflict") {
      commit(repo, "feature edits shared", { "shared.txt": "source\n" });
    } else if (kind === "spec-clean" || kind === "spec-blocked") {
      write(repo, "docs/spec.md", spec("source alpha", "base beta"));
      must(repo, "spec", "index", "docs/spec.md");
      commit(repo, "feature edits alpha", {});
    } else if (kind === "candidate") {
      commit(repo, "feature edits a", { "a.txt": "2\n" });
      commit(repo, "feature adds b", { "b.txt": "b\n" });
    } else if (kind === "merge") {
      commit(repo, "feature adds b", { "b.txt": "b\n" });
      git(repo, "switch", "-q", "-c", "side", base);
      commit(repo, "side adds c", { "c.txt": "c\n" });
      git(repo, "switch", "-q", "feature");
      git(repo, "merge", "-q", "--no-ff", "-m", "merge side", "side");
    } else if (kind === "attributes") {
      commit(repo, "feature adds attributes", { ".gitattributes": "*.txt text eol=lf\n" });
      commit(repo, "feature adds b", { "b.txt": "b\n" });
    } else if (kind === "empty") {
      commit(repo, "feature edits a", { "a.txt": "2\n" });
    }
    git(repo, "switch", "-q", "main");
    if (kind === "conflict" || kind === "paused") {
      commit(repo, "main edits shared", { "shared.txt": "target\n" });
      if (kind === "paused") {
        commit(repo, "main edits a", { "a.txt": "3\n" });
        assert.notEqual(cst(repo, "reconcile", "feature").status, 0);
      }
    } else if (kind === "spec-clean" || kind === "spec-blocked") {
      write(repo, "docs/spec.md", spec(kind === "spec-clean" ? "base alpha" : "target alpha", "target beta"));
      must(repo, "spec", "index", "docs/spec.md");
      commit(repo, "main edits the spec", {});
    } else if (kind === "candidate") {
      // The same patch as `feature edits a`, under another message: a
      // patch-id candidate, not a proven one.
      write(repo, "a.txt", "2\n");
      git(repo, "commit", "-q", "-am", "main makes the same edit");
    } else if (kind === "empty") {
      // The feature's edit is already here, inside a larger commit, so the
      // pick applies nothing.
      commit(repo, "main edits a and adds d", { "a.txt": "2\n", "d.txt": "d\n" });
    } else {
      commit(repo, "main adds c", { "z.txt": "z\n" });
    }
    if (kind === "dirty") write(repo, "untracked.txt", "dirty\n");
    return repo;
  };
  const by = (engines) => (engine) => engines[engine];
  const cases = [
    [["forecast", "feature"], "clean", /status {7}complete/],
    [["forecast", "feature", "--json"], "clean", /"status": "complete"/],
    [["forecast", "main"], "clean", /No new source changes require simulation/],
    [["forecast", "feature"], "dirty", /target dirty 1 files ignored/],
    [["forecast", "feature", "--json"], "conflict", /missing-exact-resolution/],
    [["forecast", "feature"], "conflict", by({ worktree: /blocked by {3}missing-exact-resolution/, "merge-tree": /conflicted-step/ })],
    [["forecast", "feature"], "exact", /1 exact resolution/],
    [["forecast", "feature", "--json"], "exact", /"selectionMethod": "forecast-batch"/],
    [["forecast", "feature"], "ambiguous", /ambiguous-exact-resolution/],
    [["forecast", "feature", "--json"], "spec-clean", /"outcome": "semantic-spec-merge"/],
    [["forecast", "feature"], "spec-clean", /deterministic spec merge/],
    [["forecast", "feature", "--json"], "spec-blocked", /semantic-spec-conflict/],
    [["forecast", "feature"], "candidate", /status {7}review-required/],
    [["forecast", "feature", "--accept-candidates", "--json"], "candidate", /"acceptCandidates": true/],
    [["forecast", "feature", "--json"], "merge", by({ worktree: /git-application-error/, "merge-tree": /"reason": "merge-commit"/ })],
    [["forecast", "feature"], "attributes", by({ worktree: /status {7}complete/, "merge-tree": /attributes-changed at step 1/ })],
    [["forecast", "feature", "--json"], "empty", by({ worktree: /git-application-error/, "merge-tree": /"reason": "empty-step"/ })],
    [["forecast", "feature"], "paused", /Finish or abort the current VCS Lab operation/],
    [["forecast", "no-such-branch"], "clean", /did not resolve every requested object expression/],
    [["forecast", "feature", "--target-checkpoint", "--json"], "clean", /needs a registered workspace/],
  ];
  const fixtures = new Map();
  const forecasts = (repo) => {
    const directory = path.join(repo, ".git", "causet", "forecasts");
    return fs.existsSync(directory)
      ? fs.readdirSync(directory).sort().map((file) => steadyMetrics(fs.readFileSync(path.join(directory, file), "utf8"))).join("\n--\n")
      : "(none)";
  };
  for (const engine of ["worktree", "merge-tree"]) {
    for (const [index, [args, kind, outcome]] of cases.entries()) {
      if (!fixtures.has(kind)) fixtures.set(kind, build(kind));
      const sides = ["js", "rust"].map((name) => {
        const repo = path.join(outside, `forecast-${name}-${engine}-${index}`);
        fs.cpSync(fixtures.get(kind), repo, { recursive: true });
        return repo;
      });
      const env = { ...dated, CAUSET_FORECAST_ENGINE: engine };
      const expected = spawnSync(process.execPath, [oracle, ...args], {
        cwd: sides[0], encoding: "utf8", env: testEnv(env),
      });
      if (rust === selectedCli) vlabPrefix();
      const actual = spawnSync(rust, args, {
        cwd: sides[1], encoding: "utf8", env: testEnv({ ...env, CAUSET_DELEGATE: "never" }),
      });
      const label = `${engine} ${JSON.stringify(args)} on ${kind} #${index}`;
      // Each case must reach the path it is named for, not fail alike for another reason.
      const pinned = typeof outcome === "function" ? outcome(engine) : outcome;
      assert.match(expected.stdout + expected.stderr, pinned, label);
      assert.equal(actual.status, expected.status, "status of " + label + "\n" + actual.stderr + expected.stderr);
      assert.equal(rename(actual.stderr, sides[1]), rename(expected.stderr, sides[0]), "stderr of " + label);
      assert.equal(rename(actual.stdout, sides[1]), rename(expected.stdout, sides[0]), "stdout of " + label);
      const snapshot = (repo) => rename([
        git(repo, "rev-parse", "HEAD").stdout,
        git(repo, "status", "--porcelain=v1").stdout,
        git(repo, "worktree", "list", "--porcelain").stdout,
        git(repo, "for-each-ref").stdout,
        forecasts(repo),
      ].join("\n--\n"), repo);
      assert.equal(snapshot(sides[1]), snapshot(sides[0]), "repository after " + label);
    }
  }
});

test("forecast --target-checkpoint carries the same overlay natively (#147)", { skip }, () => {
  const rename = (text, side) => {
    const seen = new Map();
    const swap = (kind) => (match) => {
      if (!seen.has(match)) seen.set(match, "<" + kind + seen.size + ">");
      return seen.get(match);
    };
    return steadyMetrics(text)
      .split(side).join("<side>")
      .replace(/\b[0-9a-f]{40}\b/g, swap("oid"))
      .replace(/\b[a-z]+_[0-9a-z]{9}[0-9a-f]{12}\b/g, swap("id"))
      .replace(/\bdraft_[0-9a-f]{64}\b/g, swap("draft"))
      // Each side commits with its own Change-Id, so the plan fingerprint and
      // short hashes differ too.
      .replace(/\b[0-9a-f]{64}\b/g, swap("digest"))
      .replace(/\bdraft_[0-9a-f]{12}\b/g, swap("draft"))
      .replace(/\b[0-9a-f]{12}\b/g, swap("short"))
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, "<time>")
      .replace(/("[A-Za-z]*Ms": )-?[\d.e+-]+/g, "$1<ms>")
      .replace(/forecast time [\d.]+ ms/g, "forecast time <ms> ms")
      .replace(/queries \([\d.]+ ms\)/g, "queries (<ms> ms)");
  };
  const dated = {
    ...neutral,
    GIT_AUTHOR_DATE: "2026-01-02T03:04:05Z",
    GIT_COMMITTER_DATE: "2026-01-02T03:04:05Z",
  };
  const git = (cwd, ...args) => spawnSync("git", args, { cwd, encoding: "utf8", env: testEnv(dated) });
  const cst = (cwd, ...args) => {
    const made = spawnSync(process.execPath, [oracle, ...args], { cwd, encoding: "utf8", env: testEnv(dated) });
    assert.equal(made.status, 0, `${args.join(" ")}\n${made.stderr}`);
  };
  // A workspace `alpha` on `main`, with `feature` to reconcile into it and a
  // draft in its worktree; `overlay` names what the checkpoint holds.
  const build = (side, { overlay = "draft", checkpoint = true, moved = false } = {}) => {
    const base = path.join(outside, side);
    const repo = path.join(base, "repo");
    fs.mkdirSync(repo, { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.name", "Overlay twin");
    git(repo, "config", "user.email", "overlay-twin@example.invalid");
    git(repo, "config", "core.autocrlf", "false");
    fs.writeFileSync(path.join(repo, "a.txt"), "1\n");
    fs.writeFileSync(path.join(repo, "notes.txt"), "base\n");
    git(repo, "add", "-A");
    cst(repo, "commit", "-m", "base");
    cst(repo, "init");
    git(repo, "switch", "-q", "-c", "feature");
    fs.writeFileSync(path.join(repo, "a.txt"), "2\n");
    git(repo, "add", "-A");
    cst(repo, "commit", "-m", "feature edits a");
    git(repo, "switch", "-q", "main");
    cst(repo, "workspace", "create", "alpha", "--from", "main");
    const alpha = path.join(base, "repo.workspaces", "alpha");
    if (overlay === "draft") fs.writeFileSync(path.join(alpha, "notes.txt"), "draft\n");
    if (overlay === "conflict") fs.writeFileSync(path.join(alpha, "a.txt"), "draft\n");
    if (checkpoint) cst(alpha, "workspace", "checkpoint", "--label", "before");
    if (moved) {
      fs.writeFileSync(path.join(alpha, "later.txt"), "later\n");
      git(alpha, "add", "later.txt");
      git(alpha, "commit", "-q", "-m", "moved on");
    }
    return alpha;
  };
  const cases = [
    [["forecast", "feature", "--target-checkpoint"], {}, /overlay after [0-9a-f]{40}/],
    [["forecast", "feature", "--target-checkpoint", "--json"], {}, /"rematerialized": "uncommitted"/],
    [["forecast", "feature", "--target-checkpoint", "--json"], { overlay: "conflict" }, /blocked-target-overlay/],
    [["forecast", "feature", "--target-checkpoint"], { overlay: "none" }, /holds no draft beyond the committed head/],
    [["forecast", "feature", "--target-checkpoint"], { checkpoint: false }, /has no checkpoint to carry/],
    [["forecast", "feature", "--target-checkpoint", "--json"], { moved: true }, /stale-input/],
  ];
  for (const [index, [args, options, outcome]] of cases.entries()) {
    const sides = ["js", "rust"].map((name) => build(`overlay-${name}-${index}`, options));
    const expected = spawnSync(process.execPath, [oracle, ...args], {
      cwd: sides[0], encoding: "utf8", env: testEnv(dated),
    });
    if (rust === selectedCli) vlabPrefix();
    const actual = spawnSync(rust, args, {
      cwd: sides[1], encoding: "utf8", env: testEnv({ ...dated, CAUSET_DELEGATE: "never" }),
    });
    const label = JSON.stringify(args) + " #" + index;
    assert.match(expected.stdout + expected.stderr, outcome, label);
    assert.equal(actual.status, expected.status, "status of " + label + "\n" + actual.stderr + expected.stderr);
    assert.equal(rename(actual.stderr, `overlay-rust-${index}`), rename(expected.stderr, `overlay-js-${index}`), "stderr of " + label);
    assert.equal(rename(actual.stdout, `overlay-rust-${index}`), rename(expected.stdout, `overlay-js-${index}`), "stdout of " + label);
    const state = (alpha) => [
      git(alpha, "status", "--porcelain=v1").stdout,
      fs.readFileSync(path.join(alpha, "notes.txt"), "utf8"),
    ].join("\n--\n");
    assert.equal(state(sides[1]), state(sides[0]), "workspace after " + label);
  }
});

// A reconciliation's journal and receipt list Git activity by elapsed time at
// any depth; ordered by name, the counts themselves must still agree.
const steadyActivity = (text) => {
  let document;
  try {
    document = JSON.parse(text);
  } catch {
    return text;
  }
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node.byCommand)) {
      node.byCommand.sort((left, right) => String(left.command).localeCompare(String(right.command)));
    }
    for (const value of Object.values(node)) visit(value);
  };
  visit(document);
  return `${JSON.stringify(document, null, 2)}\n`;
};

// Who runs a step: `A` and `B` are the JavaScript CLI on the expected side and
// each take either CLI on the others, so a case naming both also proves that
// what one CLI wrote the other reads.
const A = "a";
const B = "b";

/**
 * Run each case's steps with the JavaScript CLI and again with the Rust CLI in
 * every role the case names, and require the same output and the same
 * repository afterwards. A step is `[who, ...args]` for a CLI (`A`, `B`, or
 * `"js"`), `["git", ...args]`, or a function of the side's context.
 */
function reconcileTwins(label, cases, build, { perSide = false, journalOf, extra = () => "", env = {} } = {}) {
  const dated = {
    ...neutral,
    ...env,
    GIT_AUTHOR_DATE: "2026-01-02T03:04:05Z",
    GIT_COMMITTER_DATE: "2026-01-02T03:04:05Z",
  };
  const git = (cwd, ...args) => spawnSync("git", args, { cwd, encoding: "utf8", env: testEnv(dated) });
  const launch = (who, cwd, args) => {
    if (who === "js") {
      return spawnSync(process.execPath, [oracle, ...args], { cwd, encoding: "utf8", env: testEnv(dated) });
    }
    if (rust === selectedCli) vlabPrefix();
    return spawnSync(rust, args, { cwd, encoding: "utf8", env: testEnv({ ...dated, CAUSET_DELEGATE: "never" }) });
  };
  const rename = (text, repo, side) => {
    const seen = new Map();
    const swap = (kind) => (match) => {
      if (!seen.has(match)) seen.set(match, "<" + kind + seen.size + ">");
      return seen.get(match);
    };
    let renamed = text
      .split(JSON.stringify(repo).slice(1, -1)).join("<repo>")
      .split(repo).join("<repo>")
      .split(repo.replaceAll("\\", "/")).join("<repo>")
      .split(side).join("<side>")
      .replace(/\b[a-z]+(?:_[a-z]+)*_[0-9a-z]{9}[0-9a-f]{12}\b/g, swap("id"))
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, "<time>")
      // Durations differ run to run; Git process and query counts must not.
      .replace(/("[A-Za-z]*Ms": )-?[\d.e+-]+/g, "$1<ms>")
      .replace(/(forecast time|active time {2}) ?[\d.]+ ms/g, "$1 <ms> ms")
      .replace(/queries \([\d.]+ ms\)/g, "queries (<ms> ms)");
    if (perSide) {
      // Each side commits with its own Change-Id, so every hash differs too.
      renamed = renamed
        .replace(/\b[0-9a-f]{40}\b/g, swap("oid"))
        .replace(/\bdraft_[0-9a-f]{64}\b/g, swap("draft"))
        .replace(/\b[0-9a-f]{64}\b/g, swap("digest"))
        .replace(/\bdraft_[0-9a-f]{12}\b/g, swap("draft"))
        .replace(/\b[0-9a-f]{12}\b/g, swap("short"))
        .replace(/\b[0-9a-f]{7}\b/g, swap("abbrev"));
    }
    return renamed;
  };
  const fixtures = new Map();
  for (const [index, { kind, steps, outcome }] of cases.entries()) {
    const crossed = steps.some((step) => Array.isArray(step) && step[0] === B);
    const variants = [{ a: "js", b: "js" }, { a: "rust", b: "rust" }];
    if (crossed) variants.push({ a: "js", b: "rust" }, { a: "rust", b: "js" });
    const key = JSON.stringify(kind);
    if (!perSide && !fixtures.has(key)) {
      fixtures.set(key, build(`${label}-base-${fixtures.size}`, kind, { git, launch }));
    }
    const results = variants.map((variant, number) => {
      const side = `${label}-${index}-${number}`;
      let repo;
      if (perSide) {
        repo = build(side, kind, { git, launch });
      } else {
        repo = path.join(outside, side);
        fs.cpSync(fixtures.get(key), repo, { recursive: true });
      }
      const context = { repo, git, forecast: null };
      const transcript = [];
      for (const step of steps) {
        if (typeof step === "function") {
          step(context);
          continue;
        }
        const [who, ...template] = step;
        const args = template.map((arg) => arg === "<forecast>" ? context.forecast : arg);
        if (who === "git") {
          git(repo, ...args);
          continue;
        }
        const ran = launch(variant[who] ?? who, repo, args);
        assert.equal(ran.error, undefined, `${side} ${args.join(" ")}`);
        if (args[0] === "forecast") context.forecast = /forecast_[0-9a-z]+/.exec(ran.stdout)?.[0] ?? null;
        transcript.push(`$ ${template.join(" ")} -> ${ran.status}\n${steadyActivity(ran.stdout)}\n${ran.stderr}`);
      }
      const journal = journalOf ? journalOf(repo, git) : path.join(repo, ".git", "causet", "reconciliation.json");
      const state = [
        git(repo, "rev-parse", "HEAD").stdout,
        git(repo, "status", "--porcelain=v1").stdout,
        git(repo, "ls-files", "--stage").stdout,
        git(repo, "for-each-ref", "--format=%(refname)").stdout,
        steadyActivity(launch("js", repo, ["receipts", "--json"]).stdout),
        fs.existsSync(journal) ? steadyActivity(fs.readFileSync(journal, "utf8")) : "(no journal)",
        extra(repo),
      ].join("\n--\n");
      return {
        variant,
        transcript: rename(transcript.join("\n"), repo, side),
        state: rename(state, repo, side),
      };
    });
    const [expected, ...others] = results;
    const commands = steps.filter(Array.isArray).map((step) => step.slice(1).join(" ")).join("; ");
    const name = `${JSON.stringify(kind)} ${commands} #${index}`;
    // Each case must reach the path it is named for, not fail alike for another reason.
    assert.match(expected.transcript, outcome, name);
    for (const actual of others) {
      const who = `${name} with ${JSON.stringify(actual.variant)}`;
      assert.equal(actual.transcript, expected.transcript, "output of " + who);
      assert.equal(actual.state, expected.state, "repository after " + who);
    }
  }
}

test("reconcile starts, reports and aborts natively, and shares its journal and forecasts with the JavaScript CLI (#147)", { skip }, () => {
  const spec = (alpha, beta) => `# Alpha\n\n${alpha}\n\n# Beta\n\n${beta}\n`;
  // Every fixture reconciles `feature` into `main`, which is checked out.
  const build = (name, kind, { git, launch }) => {
    const repo = path.join(outside, name);
    const must = (...args) => {
      const made = launch("js", repo, args);
      assert.equal(made.status, 0, `${args.join(" ")}\n${made.stderr}`);
    };
    const write = (file, text) => {
      fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
      fs.writeFileSync(path.join(repo, file), text);
    };
    const commit = (message, files) => {
      for (const [file, text] of Object.entries(files)) write(file, text);
      git(repo, "add", "-A");
      must("commit", "-m", message);
    };
    fs.mkdirSync(repo, { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.name", "Reconcile twin");
    git(repo, "config", "user.email", "reconcile-twin@example.invalid");
    git(repo, "config", "core.autocrlf", "false");
    if (kind === "spec") {
      write("docs/spec.md", spec("base alpha", "base beta"));
      must("spec", "index", "docs/spec.md");
    }
    commit("base", { "shared.txt": "base\n", "a.txt": "1\n" });
    must("init");
    const base = git(repo, "rev-parse", "HEAD").stdout.trim();
    if (kind === "exact") {
      // Two pairs that conflict alike, the first resolved and so remembered.
      const pair = (suffix) => {
        git(repo, "switch", "-q", "-c", `source-${suffix}`, base);
        commit(`source ${suffix}`, { "shared.txt": "source\n" });
        git(repo, "switch", "-q", "-c", `target-${suffix}`, base);
        commit(`target ${suffix}`, { "shared.txt": "target\n" });
      };
      pair("one");
      assert.notEqual(launch("js", repo, ["reconcile", "source-one"]).status, 0);
      write("shared.txt", "remembered\n");
      git(repo, "add", "shared.txt");
      must("reconcile", "--continue");
      pair("last");
      git(repo, "branch", "-q", "-f", "feature", "source-last");
      git(repo, "branch", "-q", "-f", "main", "target-last");
      git(repo, "switch", "-q", "main");
      return repo;
    }
    git(repo, "switch", "-q", "-c", "feature");
    if (kind === "clean" || kind === "dirty") {
      commit("feature adds b", { "b.txt": "b\n" });
      commit("feature edits a", { "a.txt": "2\n" });
    } else if (kind === "conflict" || kind === "paused") {
      commit("feature adds b", { "b.txt": "b\n" });
      commit("feature edits a", { "a.txt": "2\n" });
      commit("feature edits shared", { "shared.txt": "source\n" });
    } else if (kind === "spec") {
      write("docs/spec.md", spec("source alpha", "base beta"));
      must("spec", "index", "docs/spec.md");
      commit("feature edits alpha", {});
    } else if (kind === "candidate") {
      commit("feature edits a", { "a.txt": "2\n" });
      commit("feature adds b", { "b.txt": "b\n" });
    } else if (kind === "merge") {
      commit("feature adds b", { "b.txt": "b\n" });
      git(repo, "switch", "-q", "-c", "side", base);
      commit("side adds c", { "c.txt": "c\n" });
      git(repo, "switch", "-q", "feature");
      git(repo, "merge", "-q", "--no-ff", "-m", "merge side", "side");
    } else if (kind === "empty") {
      commit("feature edits a", { "a.txt": "2\n" });
    }
    git(repo, "switch", "-q", "main");
    if (kind === "conflict" || kind === "paused") {
      commit("main edits shared", { "shared.txt": "target\n" });
      if (kind === "paused") {
        const paused = launch("js", repo, ["reconcile", "feature"]);
        assert.match(paused.stderr, /paused/i, `the paused fixture must pause\n${paused.stderr}`);
      }
    } else if (kind === "spec") {
      write("docs/spec.md", spec("base alpha", "target beta"));
      must("spec", "index", "docs/spec.md");
      commit("main edits the spec", {});
    } else if (kind === "candidate") {
      // The same patch as `feature edits a`, under another message.
      write("a.txt", "2\n");
      git(repo, "commit", "-q", "-am", "main makes the same edit");
    } else if (kind === "empty") {
      commit("main edits a and adds d", { "a.txt": "2\n", "d.txt": "d\n" });
    } else {
      commit("main adds z", { "z.txt": "z\n" });
    }
    if (kind === "dirty") write("untracked.txt", "dirty\n");
    return repo;
  };
  const journalFile = (repo) => path.join(repo, ".git", "causet", "reconciliation.json");
  const editJournal = (change) => ({ repo }) => {
    const state = JSON.parse(fs.readFileSync(journalFile(repo), "utf8"));
    change(state);
    fs.writeFileSync(journalFile(repo), `${JSON.stringify(state, null, 2)}\n`);
  };
  const editForecast = (change) => ({ repo, forecast }) => {
    const file = path.join(repo, ".git", "causet", "forecasts", `${forecast}.json`);
    const document = JSON.parse(fs.readFileSync(file, "utf8"));
    change(document);
    fs.writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`);
  };
  const write = (file, text) => ({ repo }) => fs.writeFileSync(path.join(repo, file), text);
  const start = [A, "reconcile", "feature"];
  const status = [A, "reconcile", "--status"];
  const abort = [A, "reconcile", "--abort"];
  const approved = [B, "reconcile", "feature", "--use-forecast", "<forecast>"];
  // A refusal does not depend on who wrote the forecast, so it runs one role.
  const unpaired = [A, "reconcile", "feature", "--use-forecast", "<forecast>"];
  const cases = [
    { kind: "clean", steps: [start], outcome: /Reconciliation complete\./ },
    { kind: "clean", steps: [[...start, "--json"]], outcome: /"schema": "causet\.reconciliation\/v6"/ },
    { kind: "clean", steps: [[A, "reconcile", "main", "--json"]], outcome: /"applied": \[\]/ },
    { kind: "conflict", steps: [start], outcome: /Reconciliation paused while applying/ },
    { kind: "conflict", steps: [[...start, "--json"]], outcome: /"code": "conflict-paused"/ },
    { kind: "dirty", steps: [start], outcome: /The worktree must be clean/ },
    { kind: "exact", steps: [start], outcome: /1 prior resolution candidate found/ },
    { kind: "spec", steps: [start], outcome: /1 deterministic spec merge available/ },
    { kind: "candidate", steps: [[...start, "--json"]], outcome: /"code": "approval-required"/ },
    { kind: "candidate", steps: [[...start, "--accept-candidates"]], outcome: /Reconciliation complete\./ },
    { kind: "paused", steps: [start], outcome: /already in progress in this worktree/ },
    { kind: "clean", steps: [[A, "reconcile", "no-such-branch"]], outcome: /did not resolve every requested object expression/ },
    { kind: "merge", steps: [[...start, "--json"], status], outcome: /state {8}blocked/ },
    { kind: "empty", steps: [start, [...status, "--json"]], outcome: /"state": "blocked"/ },
    // Status and abort.
    { kind: "clean", steps: [status], outcome: /No reconciliation is in progress/ },
    { kind: "clean", steps: [[...status, "--json"]], outcome: /"state": "idle"/ },
    { kind: "paused", steps: [status], outcome: /progress {5}2\/3 applied/ },
    { kind: "paused", steps: [[...status, "--json"]], outcome: /"gitCherryPickHead": "[0-9a-f]{40}"/ },
    { kind: "paused", steps: [abort], outcome: /"aborted": true/ },
    { kind: "clean", steps: [[...abort, "--json"]], outcome: /"code": "no-operation-pending"/ },
    { kind: "paused", steps: [["git", "checkout", "-q", "-f", "feature"], [...status, "--json"], abort], outcome: /belongs to branch 'main', not 'feature'/ },
    { kind: "paused", steps: [["git", "checkout", "-q", "-f", "--detach"], abort], outcome: /belongs to branch 'main', not a detached HEAD/ },
    { kind: "paused", steps: [editJournal((state) => { state.targetBranchRef = null; }), abort], outcome: /belongs to a detached HEAD, not main\./ },
    { kind: "paused", steps: [editJournal((state) => { delete state.targetBranchRef; }), [...status, "--json"], abort], outcome: /"branchMatches": null[^]*"aborted": true/ },
    { kind: "paused", steps: [editJournal((state) => { delete state.targetBranchRef; }), ["git", "cherry-pick", "--abort"], abort], outcome: /does not record its branch/ },
    { kind: "paused", steps: [["git", "cherry-pick", "--abort"], status, abort], outcome: /"aborted": true/ },
    { kind: "paused", steps: [["git", "cherry-pick", "--abort"], write("stray.txt", "stray\n"), abort], outcome: /The worktree must be clean/ },
    { kind: "paused", steps: [editJournal((state) => { state.schema = "causet.reconciliation-operation/v99"; }), status, [...abort, "--json"]], outcome: /reconciliation journal at/ },
    { kind: "paused", steps: [editJournal((state) => { delete state.queue; }), status], outcome: /reading 'length'/ },
    { kind: "paused", steps: [editJournal((state) => { delete state.id; state.current = null; delete state.timings; }), [...status, "--json"], status], outcome: /"timings": null/ },
    // A journal one CLI starts, the other reports on, aborts or continues.
    { kind: "conflict", steps: [start, [B, "reconcile", "--status", "--json"], [B, "reconcile", "--abort"]], outcome: /"aborted": true/ },
    { kind: "conflict", steps: [start, write("shared.txt", "settled\n"), ["git", "add", "shared.txt"], ["js", "reconcile", "--continue", "--json"]], outcome: /"decision": "created"/ },
    { kind: "exact", steps: [start, ["js", "resolve", "apply", "--all"], ["js", "reconcile", "--continue"]], outcome: /resolutions {2}1 accepted/ },
    // A forecast one CLI writes, the other consumes.
    { bothEngines: true, kind: "clean", steps: [[A, "forecast", "feature", "--json"], approved], outcome: /forecast {5}<id\d+>/ },
    { kind: "clean", steps: [[A, "forecast", "feature"], [...approved, "--json"]], outcome: /"forecastId": "<id\d+>"/ },
    { bothEngines: true, kind: "exact", steps: [[A, "forecast", "feature", "--json"], [...approved, "--json"]], outcome: /"selectionMethod": "forecast-batch"[^]*"schema": "causet\.reconciliation\/v6"/ },
    { kind: "exact", steps: [[A, "forecast", "feature"], approved], outcome: /resolutions {2}1 accepted/ },
    { bothEngines: true, kind: "spec", steps: [[A, "forecast", "feature"], approved], outcome: /spec merges {2}1 deterministic/ },
    { kind: "spec", steps: [[A, "forecast", "feature", "--json"], [...approved, "--json"]], outcome: /"actualMarkdownHash"/ },
    { bothEngines: true, kind: "conflict", steps: [[A, "forecast", "feature"], approved, [B, "reconcile", "--status"]], outcome: /Reconciliation paused while applying/ },
    { kind: "candidate", steps: [[A, "forecast", "feature", "--accept-candidates"], approved], outcome: /Reconciliation complete\./ },
    { kind: "candidate", steps: [[A, "forecast", "feature"], approved], outcome: /heuristic patch-equivalence candidates/ },
    { kind: "clean", steps: [[A, "forecast", "feature"], ["git", "commit", "-q", "--allow-empty", "-m", "main moves"], unpaired], outcome: /no longer matches this reconciliation/ },
    { kind: "clean", steps: [[A, "reconcile", "feature", "--use-forecast", "forecast_missing"]], outcome: /Forecast 'forecast_missing' was not found/ },
    { kind: "clean", steps: [[A, "reconcile", "feature", "--use-forecast", "Forecast_1", "--json"]], outcome: /"code": "invalid-identifier"/ },
    { kind: "clean", steps: [[A, "forecast", "feature"], editForecast((document) => { document.schema = "causet.forecast/v99"; }), unpaired], outcome: /Forecast '<id\d+>' carries unsupported schema "causet\.forecast\/v99"/ },
    { kind: "clean", steps: [[A, "forecast", "feature"], editForecast((document) => { document.id = "forecast_other"; }), [...unpaired, "--json"]], outcome: /has invalid metadata/ },
    { kind: "clean", steps: [[A, "forecast", "feature"], editForecast((document) => { document.predictedResultTree = "0".repeat(40); }), unpaired, [A, "reconcile", "--status"], [A, "reconcile", "--abort"]], outcome: /does not match forecast[^]*cannot be published[^]*"aborted": true/ },
    { kind: "exact", steps: [[A, "forecast", "feature"], editForecast((document) => { document.approvedResolutions[0].resultBlob = "0".repeat(40); }), unpaired, [A, "reconcile", "--status", "--json"], [A, "reconcile", "--abort"]], outcome: /no longer matches 'shared\.txt'[^]*"aborted": true/ },
    { kind: "exact", steps: [[A, "forecast", "feature"], editForecast((document) => { document.approvedResolutions.push({ ...document.approvedResolutions[0], path: "other.txt" }); }), unpaired], outcome: /no longer matches the current conflicts/ },
    { kind: "spec", steps: [[A, "forecast", "feature"], editForecast((document) => { document.approvedSpecMerges[0].resultMarkdownHash = "0".repeat(64); }), unpaired], outcome: /no longer matches 'docs\/spec\.md'/ },
    { kind: "spec", steps: [[A, "forecast", "feature"], editForecast((document) => { document.approvedSpecMerges[0].algorithm = "other/v1"; }), unpaired], outcome: /unsupported merge algorithm/ },
  ];
  const forecasts = (repo) => {
    const directory = path.join(repo, ".git", "causet", "forecasts");
    return fs.existsSync(directory) ? `${fs.readdirSync(directory).length} forecasts` : "no forecasts";
  };
  reconcileTwins("reconcile", cases, build, { extra: forecasts });
  // A forecast from either engine is consumed alike (ADR-0016). The cases above
  // ran under this platform's default engine; these run under the other one.
  const other = process.platform === "win32" ? "worktree" : "merge-tree";
  reconcileTwins(`reconcile-${other}`, cases.filter((item) => item.bothEngines), build, {
    extra: forecasts,
    env: { CAUSET_FORECAST_ENGINE: other },
  });
});

test("reconcile carries a target overlay through and back natively (#147)", { skip }, () => {
  // A workspace `alpha` on `main` holding a checkpointed draft, with `feature`
  // to reconcile into it.
  const build = (side, { overlay = "draft" }, { git, launch }) => {
    const base = path.join(outside, side);
    const repo = path.join(base, "repo");
    const must = (cwd, ...args) => {
      const made = launch("js", cwd, args);
      assert.equal(made.status, 0, `${args.join(" ")}\n${made.stderr}`);
    };
    fs.mkdirSync(repo, { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.name", "Overlay twin");
    git(repo, "config", "user.email", "overlay-twin@example.invalid");
    git(repo, "config", "core.autocrlf", "false");
    fs.writeFileSync(path.join(repo, "a.txt"), "1\n");
    fs.writeFileSync(path.join(repo, "notes.txt"), "base\n");
    git(repo, "add", "-A");
    must(repo, "commit", "-m", "base");
    must(repo, "init");
    git(repo, "switch", "-q", "-c", "feature");
    fs.writeFileSync(path.join(repo, "a.txt"), "2\n");
    git(repo, "add", "-A");
    must(repo, "commit", "-m", "feature edits a");
    git(repo, "switch", "-q", "main");
    must(repo, "workspace", "create", "alpha", "--from", "main");
    const alpha = path.join(base, "repo.workspaces", "alpha");
    if (overlay === "draft") {
      fs.writeFileSync(path.join(alpha, "notes.txt"), "draft\n");
      fs.writeFileSync(path.join(alpha, "new.txt"), "new\n");
    }
    if (overlay === "conflict") fs.writeFileSync(path.join(alpha, "a.txt"), "draft\n");
    must(alpha, "workspace", "checkpoint", "--label", "before");
    return alpha;
  };
  const forecast = [A, "forecast", "feature", "--target-checkpoint"];
  const approved = [B, "reconcile", "feature", "--use-forecast", "<forecast>"];
  // A refusal does not depend on who wrote the forecast, so it runs one role.
  const unpaired = [A, "reconcile", "feature", "--use-forecast", "<forecast>"];
  const write = (file, text) => ({ repo }) => fs.writeFileSync(path.join(repo, file), text);
  const cases = [
    { kind: {}, steps: [forecast, approved], outcome: /re-materialized uncommitted as/ },
    { kind: {}, steps: [[...forecast, "--json"], [...unpaired, "--json"]], outcome: /"rematerialized": true/ },
    { kind: {}, steps: [forecast, write("notes.txt", "drifted\n"), unpaired], outcome: /The worktree has changed since the target overlay was captured/ },
    { kind: {}, steps: [forecast, ["git", "commit", "-q", "--allow-empty", "-m", "alpha moves"], [...unpaired, "--json"]], outcome: /"code": "stale-forecast"/ },
    { kind: { overlay: "conflict" }, steps: [forecast, approved, [B, "reconcile", "--status"], [B, "reconcile", "--abort"]], outcome: /no longer merges with the committed result[^]*"restored": true/ },
  ];
  const journalOf = (repo, git) =>
    path.join(git(repo, "rev-parse", "--absolute-git-dir").stdout.trim(), "causet", "reconciliation.json");
  const files = (repo) => ["a.txt", "notes.txt", "new.txt"]
    .map((file) => fs.existsSync(path.join(repo, file)) ? fs.readFileSync(path.join(repo, file), "utf8") : "(absent)")
    .join("|");
  reconcileTwins("overlay-reconcile", cases, build, { perSide: true, journalOf, extra: files });
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
  const result = runRust(["workspace", "forecast", "a", "b"], { CAUSET_DELEGATE: "never" });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^cst: 'workspace' is not ported to the Rust CLI yet/);
  const invalid = runRust(["--version"], { CAUSET_DELEGATE: "sometimes" });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /^cst: Unknown delegation mode 'sometimes'/);
});
