import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MERGE_TREE_ENGINE_MIN_GIT } from "../src/git.js";
import { VERSION } from "../src/version.js";
import { pseudoRefTarget, reachableCommits } from "../src/engine.js";
import { recordsReachableFrom } from "../src/notes.js";
import { testEnv } from "../test-support/git-environment.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(projectRoot, "bin", "vlab.js");

test("CLI reports the package version", () => {
  assert.equal(
    exec(process.execPath, [cli, "--version"], projectRoot),
    `vcs-lab ${VERSION}`,
  );
});

function exec(command, args, cwd, options = {}) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    env: testEnv(),
    ...options,
  }).trim();
}

function git(cwd, ...args) {
  return exec("git", args, cwd);
}

/**
 * The merge-tree forecast engine needs Git 2.49 (`git merge-tree --stdin`
 * flushes each record only from there; bare tree operands from 2.45 and
 * `GIT_ATTR_SOURCE` from 2.43 are older). The supported baseline is 2.40, so
 * the differential tests skip rather than fail on older Git, where the engine
 * falls back to the worktree simulator with `git-too-old`.
 */
function hostGitVersion() {
  return exec("git", ["--version"], projectRoot);
}

function mergeTreeEngineSupported() {
  const match = hostGitVersion().match(/(\d+)\.(\d+)/);
  if (!match) return true;
  const [major, minor] = [Number(match[1]), Number(match[2])];
  const [wantMajor, wantMinor] = MERGE_TREE_ENGINE_MIN_GIT.split(".").map(Number);
  return major > wantMajor || (major === wantMajor && minor >= wantMinor);
}

function skipWithoutMergeTreeEngine(t) {
  if (mergeTreeEngineSupported()) return false;
  t.skip(`the merge-tree forecast engine needs Git ${MERGE_TREE_ENGINE_MIN_GIT} or newer; older Git falls back to the worktree simulator`);
  return true;
}

function vlab(cwd, ...args) {
  return exec(process.execPath, [cli, ...args], cwd);
}

function vlabResult(cwd, ...args) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8",
    env: testEnv(),
  });
}

function write(repo, relative, content) {
  const target = path.join(repo, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function readText(repo, relative) {
  return fs
    .readFileSync(path.join(repo, relative), "utf8")
    .replace(/\r\n/g, "\n");
}

function makeRepo(t) {
  const parent = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "vcs-lab-test-")));
  const repo = path.join(parent, "repo");
  fs.mkdirSync(repo);
  git(repo, "init", "-b", "main");
  git(repo, "config", "core.autocrlf", "false");
  git(repo, "config", "core.eol", "lf");
  git(repo, "config", "user.name", "VCS Lab Test");
  git(repo, "config", "user.email", "vcs-lab@example.test");
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  return { repo, parent };
}

function writeBlob(repo, content) {
  return exec("git", ["hash-object", "-w", "--stdin"], repo, { input: content });
}

function resolutionSignature(stages) {
  const canonical = JSON.stringify({
    algorithm: "ordered-three-way-blobs/v1",
    base: stages.base ?? null,
    ours: stages.ours ?? null,
    theirs: stages.theirs ?? null,
  });
  return `rsig_${createHash("sha256").update(canonical).digest("hex")}`;
}

function writeVlabNote(repo, commit, note) {
  exec(
    "git",
    ["notes", "--ref=vcs-lab", "add", "-f", "-F", "-", commit],
    repo,
    { input: typeof note === "string" ? note : `${JSON.stringify(note, null, 2)}\n` },
  );
}

/**
 * Publish a resolution record with Git plumbing exactly the way
 * src/resolutions.js publishResolution does: a retention commit whose tree
 * holds `result` (or is empty for a deleted result), a retention ref under
 * refs/vcs-lab/resolutions/<signature>/<resultBlob|deleted>, and a note record
 * attached to that commit. `treeBlob`, `ref`, `record`, and `note` let a test
 * corrupt exactly one aspect of an otherwise valid publication.
 */
function publishRetainedResolution(repo, options) {
  const {
    id,
    stages,
    createdAt,
    originalPath = "shared.txt",
    originatingCommit,
    resultBlob = null,
    resultMode = resultBlob ? "100644" : null,
    treeBlob = resultBlob,
    record: recordOverrides = {},
    note,
  } = options;
  const signature = recordOverrides.signature ?? resolutionSignature(stages);
  const ref = options.ref ??
    `refs/vcs-lab/resolutions/${signature}/${resultBlob ?? "deleted"}`;
  const tree = exec("git", ["mktree"], repo, {
    input: treeBlob ? `${resultMode ?? "100644"} blob ${treeBlob}\tresult\n` : "",
  });
  const commit = exec("git", ["commit-tree", tree, "-F", "-"], repo, {
    input: [
      `Conflict resolution ${signature.slice(0, 20)}`,
      "",
      `Resolution-Signature: ${signature}`,
      `Result-Blob: ${resultBlob ?? "deleted"}`,
      "",
    ].join("\n"),
  });
  git(repo, "update-ref", ref, commit);
  const record = {
    schema: "vcs-lab.resolution/v1",
    type: "resolution",
    id,
    signature,
    algorithm: "ordered-three-way-blobs/v1",
    base: stages.base ?? null,
    ours: stages.ours ?? null,
    theirs: stages.theirs ?? null,
    resultBlob,
    resultMode,
    originalPath,
    originatingApplication: `app_${id}`,
    originatingCommit,
    originatingChangeId: `change_${id}`,
    decision: "created",
    ref,
    resolutionCommit: commit,
    createdAt,
    ...recordOverrides,
  };
  writeVlabNote(
    repo,
    commit,
    note ? note(record) : { schema: "vcs-lab.note/v1", records: [record] },
  );
  return { record, ref, commit, tree };
}

function tracedGitCommands(cwd, ...args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8",
    env: testEnv({ VLAB_TRACE: "1" }),
  });
  assert.equal(result.status, 0, result.stderr);
  const commands = [];
  // A traced line is an operation, not necessarily a process: an object session
  // serves many reads from one persistent process. `processes` counts only the
  // lines that actually started one, which is what a process budget is about.
  const processes = [];
  for (const line of result.stderr.split(/\r?\n/)) {
    const match = line.match(/^\[vlab trace\] [\d.]+ms git (\S+) \(([^)]+)\)/);
    if (!match) continue;
    commands.push(match[1]);
    if (match[2] === "new process" || match[2] === "new persistent process") {
      processes.push(match[1]);
    }
  }
  return { stdout: result.stdout, commands, processes };
}

function createIndexedSpecDivergence(repo, options = {}) {
  write(
    repo,
    "docs/spec.md",
    "# Alpha\n\nbase alpha\n\n# Beta\n\nbase beta\n",
  );
  vlab(repo, "spec", "index", "docs/spec.md", "--json");
  git(repo, "add", ".");
  const base = JSON.parse(vlab(repo, "commit", "-m", "base specification"));
  vlab(repo, "init");

  git(repo, "switch", "-c", "feature", base.commit);
  write(
    repo,
    "docs/spec.md",
    "# Alpha\n\nsource alpha\n\n# Beta\n\nbase beta\n",
  );
  vlab(repo, "spec", "index", "docs/spec.md", "--json");
  git(repo, "add", ".");
  const source = JSON.parse(vlab(repo, "commit", "-m", "source edits alpha"));

  git(repo, "switch", "main");
  write(
    repo,
    "docs/spec.md",
    options.sameBlock
      ? "# Alpha\n\ntarget alpha\n\n# Beta\n\nbase beta\n"
      : "# Alpha\n\nbase alpha\n\n# Beta\n\ntarget beta\n",
  );
  vlab(repo, "spec", "index", "docs/spec.md", "--json");
  git(repo, "add", ".");
  const target = JSON.parse(vlab(repo, "commit", "-m", "target edits specification"));
  return { base, source, target };
}

test("init keeps an existing worktree clean", (t) => {
  const { repo } = makeRepo(t);
  write(repo, "base.txt", "base\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "base");
  vlab(repo, "init");
  assert.equal(git(repo, "status", "--porcelain=v1"), "");
  assert.equal(
    JSON.parse(vlab(repo, "reconcile", "--status", "--json")).active,
    false,
  );
});

test("doctor diagnoses a repository without initializing it", (t) => {
  // A diagnostic must not change what it diagnoses. Before this was pinned,
  // `vlab doctor` ran `initLab()`, so asking a repository what state it was in
  // wrote `notes.displayRef` and `notes.rewriteRef` into its config and
  // created `.git/vcs-lab/`.
  const { repo } = makeRepo(t);
  write(repo, "base.txt", "base\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "base");
  const configBefore = readText(repo, ".git/config");

  const doctor = JSON.parse(vlab(repo, "doctor"));
  assert.equal(doctor.ok, true);
  assert.equal(doctor.version, VERSION);
  assert.equal(path.resolve(doctor.repository), repo);

  for (const key of ["notes.displayRef", "notes.rewriteRef"]) {
    const lookup = spawnSync("git", ["config", "--get", key], {
      cwd: repo,
      encoding: "utf8",
      env: testEnv(),
    });
    assert.equal(lookup.status, 1, `${key} must stay unset, got '${lookup.stdout.trim()}'`);
  }
  assert.equal(readText(repo, ".git/config"), configBefore);
  assert.equal(fs.existsSync(path.join(repo, ".git", "vcs-lab")), false);
  assert.equal(git(repo, "status", "--porcelain=v1"), "");
});

test("hard squash receipts suppress absorbed changes during reconciliation", (t) => {
  const { repo } = makeRepo(t);
  write(repo, "app.txt", "base\n");
  git(repo, "add", ".");
  vlab(repo, "commit", "-m", "base");
  vlab(repo, "init");

  vlab(repo, "branch", "feature");
  write(repo, "feature.txt", "one\n");
  git(repo, "add", ".");
  const first = JSON.parse(vlab(repo, "commit", "-m", "feature one"));
  write(repo, "feature.txt", "one\ntwo\n");
  git(repo, "add", ".");
  const second = JSON.parse(vlab(repo, "commit", "-m", "feature two"));

  git(repo, "switch", "main");
  const landing = JSON.parse(vlab(repo, "hard-squash", "feature", "--json"));
  assert.equal(landing.mode, "hard-squash");
  assert.deepEqual(landing.absorbedChanges, [first.changeId, second.changeId]);

  git(repo, "switch", "feature");
  write(repo, "continuation.txt", "three\n");
  git(repo, "add", ".");
  const third = JSON.parse(vlab(repo, "commit", "-m", "feature three"));
  git(repo, "switch", "main");

  const plan = JSON.parse(vlab(repo, "merge-plan", "feature", "--json"));
  assert.equal(plan.counts.covered, 2);
  assert.equal(plan.counts.new, 1);
  assert.equal(plan.changes.find((item) => item.changeId === third.changeId).status, "new");

  const reconciled = JSON.parse(vlab(repo, "reconcile", "feature", "--json"));
  assert.equal(reconciled.receipt.applied.length, 1);
  assert.equal(reconciled.receipt.exactStateEqualityBefore, false);
  assert.equal(reconciled.receipt.exactStateEqualityAfter, true);
  assert.equal(readText(repo, "continuation.txt"), "three\n");

  const after = JSON.parse(vlab(repo, "merge-plan", "feature", "--json"));
  assert.equal(after.counts.new, 0);
  assert.equal(after.counts.covered, 3);

  const graph = vlab(repo, "graph");
  assert.match(graph, /Project history/);
  assert.match(graph, /Causal edges/);
  assert.match(graph, /hard-squash; 2 changes absorbed/);
  assert.doesNotMatch(graph, /Notes added by/);

  const readableReceipts = vlab(repo, "receipts");
  assert.match(readableReceipts, /3 causal records/);
  assert.match(readableReceipts, /LANDING land_/);
  assert.match(readableReceipts, /same after\s+yes/);
  assert.doesNotMatch(readableReceipts, /^\s*\[/);

  const jsonReceipts = JSON.parse(vlab(repo, "receipts", "--json"));
  assert.equal(jsonReceipts.length, 3);
});

test("causal rebase planning is deterministic and replays only hard-squash continuation", (t) => {
  const { repo } = makeRepo(t);
  write(repo, "base.txt", "base\n");
  git(repo, "add", ".");
  const base = JSON.parse(vlab(repo, "commit", "-m", "base"));
  vlab(repo, "init");

  git(repo, "switch", "-c", "feature", base.commit);
  write(repo, "feature.txt", "one\n");
  git(repo, "add", ".");
  const first = JSON.parse(vlab(repo, "commit", "-m", "feature one"));
  write(repo, "feature.txt", "one\ntwo\n");
  git(repo, "add", ".");
  const second = JSON.parse(vlab(repo, "commit", "-m", "feature two"));

  git(repo, "switch", "main");
  vlab(repo, "hard-squash", "feature", "--json");
  git(repo, "switch", "feature");
  write(repo, "continuation.txt", "three\n");
  git(repo, "add", ".");
  const continuation = JSON.parse(
    vlab(repo, "commit", "-m", "feature continuation"),
  );
  write(repo, "caller-draft.txt", "uncommitted caller bytes\n");

  const callerBefore = {
    head: git(repo, "rev-parse", "HEAD"),
    branch: git(repo, "branch", "--show-current"),
    tree: git(repo, "rev-parse", "HEAD^{tree}"),
    status: git(repo, "status", "--porcelain=v1"),
    notes: git(repo, "rev-parse", "refs/notes/vcs-lab"),
    worktrees: git(repo, "worktree", "list", "--porcelain"),
  };
  assert.match(callerBefore.status, /\?\? caller-draft\.txt/);
  const plan = JSON.parse(vlab(repo, "rebase-plan", "main", "--json"));
  const repeated = JSON.parse(vlab(repo, "rebase-plan", "main", "--json"));

  assert.equal(plan.schema, "vcs-lab.rebase-plan/v1");
  assert.equal(plan.mode, "linear");
  assert.equal(plan.ontoRef, "main");
  assert.equal(plan.sourceRef, "feature");
  assert.equal(plan.sourceHead, continuation.commit);
  assert.deepEqual(plan.counts, {
    covered: 2,
    "candidate-equivalent": 0,
    new: 1,
  });
  assert.deepEqual(
    plan.omitted.map((item) => item.changeId),
    [first.changeId, second.changeId],
  );
  assert.ok(
    plan.omitted.every((item) =>
      ["receipt-commit", "receipt-change-id"].includes(item.proof),
    ),
  );
  assert.deepEqual(
    plan.replayQueue.map((item) => item.changeId),
    [continuation.changeId],
  );
  assert.equal(plan.constraints.supported, true);
  assert.equal(plan.candidateDecisionRequired, false);
  assert.equal(plan.executableWithoutReview, true);
  assert.match(plan.fingerprint, /^[0-9a-f]{64}$/);
  assert.deepEqual(repeated, plan);
  assert.match(vlab(repo, "rebase-plan", "main"), /1 replay/);

  const callerAfter = {
    head: git(repo, "rev-parse", "HEAD"),
    branch: git(repo, "branch", "--show-current"),
    tree: git(repo, "rev-parse", "HEAD^{tree}"),
    status: git(repo, "status", "--porcelain=v1"),
    notes: git(repo, "rev-parse", "refs/notes/vcs-lab"),
    worktrees: git(repo, "worktree", "list", "--porcelain"),
  };
  assert.deepEqual(callerAfter, callerBefore);
});

test("causal rebase planning keeps heuristic candidates in review", (t) => {
  const { repo } = makeRepo(t);
  write(repo, "base.txt", "base\n");
  git(repo, "add", ".");
  const base = JSON.parse(vlab(repo, "commit", "-m", "base"));

  git(repo, "switch", "-c", "feature", base.commit);
  write(repo, "equivalent.txt", "same patch\n");
  git(repo, "add", ".");
  const source = JSON.parse(vlab(repo, "commit", "-m", "source patch"));

  git(repo, "switch", "main");
  write(repo, "equivalent.txt", "same patch\n");
  git(repo, "add", ".");
  vlab(repo, "commit", "-m", "independent target patch");

  const plan = JSON.parse(
    vlab(repo, "rebase-plan", "main", "feature", "--json"),
  );
  assert.equal(plan.counts["candidate-equivalent"], 1);
  assert.deepEqual(plan.replayQueue, []);
  assert.equal(plan.candidates[0].changeId, source.changeId);
  assert.equal(plan.candidates[0].proof, "git-patch-id-heuristic");
  assert.equal(plan.changes[0].action, "review");
  assert.equal(plan.candidateDecisionRequired, true);
  assert.equal(plan.executableWithoutReview, false);
  assert.equal(git(repo, "branch", "--show-current"), "main");
  assert.equal(git(repo, "status", "--porcelain=v1"), "");
});

test("causal rebase planning marks merge topology unsupported in linear v1", (t) => {
  const { repo } = makeRepo(t);
  write(repo, "base.txt", "base\n");
  git(repo, "add", ".");
  const base = JSON.parse(vlab(repo, "commit", "-m", "base"));

  git(repo, "switch", "-c", "feature", base.commit);
  write(repo, "feature.txt", "feature\n");
  git(repo, "add", ".");
  vlab(repo, "commit", "-m", "feature work");

  git(repo, "switch", "-c", "side", base.commit);
  write(repo, "side.txt", "side\n");
  git(repo, "add", ".");
  vlab(repo, "commit", "-m", "side work");
  git(repo, "switch", "feature");
  git(repo, "merge", "--no-ff", "side", "-m", "merge side");
  const mergeCommit = git(repo, "rev-parse", "HEAD");

  git(repo, "switch", "main");
  const plan = JSON.parse(
    vlab(repo, "rebase-plan", "main", "feature", "--json"),
  );
  assert.equal(plan.constraints.supported, false);
  assert.equal(plan.constraints.linearHistory, false);
  assert.deepEqual(plan.constraints.mergeCommits, [mergeCommit]);
  assert.equal(plan.executableWithoutReview, false);
  assert.match(vlab(repo, "rebase-plan", "main", "feature"), /unsupported/i);
  const worktreesBefore = git(repo, "worktree", "list", "--porcelain");
  const forecast = JSON.parse(
    vlab(repo, "rebase-forecast", "main", "feature", "--json"),
  );
  assert.equal(forecast.status, "unsupported");
  assert.equal(forecast.blockedReason, "merge-topology-unsupported");
  assert.equal(forecast.predictedResultTree, null);
  assert.deepEqual(forecast.steps, []);
  assert.equal(forecast.remainingChanges, forecast.plan.replayQueue.length);
  assert.match(
    vlab(repo, "rebase-forecast", "main", "feature"),
    /Linear v1 cannot forecast source history containing merge commits/,
  );
  assert.equal(git(repo, "worktree", "list", "--porcelain"), worktreesBefore);
  assert.equal(git(repo, "branch", "--show-current"), "main");
  assert.equal(git(repo, "status", "--porcelain=v1"), "");
});

test("causal rebase forecasts are deterministic and preserve a dirty caller", (t) => {
  const { repo } = makeRepo(t);
  write(repo, "base.txt", "base\n");
  git(repo, "add", ".");
  const base = JSON.parse(vlab(repo, "commit", "-m", "base"));
  vlab(repo, "init");

  git(repo, "switch", "-c", "feature", base.commit);
  write(repo, "feature.txt", "one\n");
  git(repo, "add", ".");
  vlab(repo, "commit", "-m", "feature one");
  write(repo, "feature.txt", "one\ntwo\n");
  git(repo, "add", ".");
  vlab(repo, "commit", "-m", "feature two");

  git(repo, "switch", "main");
  vlab(repo, "hard-squash", "feature", "--json");
  git(repo, "switch", "feature");
  write(repo, "continuation.txt", "three\n");
  git(repo, "add", ".");
  const continuation = JSON.parse(
    vlab(repo, "commit", "-m", "feature continuation"),
  );
  git(repo, "mv", "base.txt", "caller-base-draft.txt");
  write(repo, "caller-draft.txt", "uncommitted caller bytes\n");

  const callerBefore = {
    head: git(repo, "rev-parse", "HEAD"),
    branch: git(repo, "branch", "--show-current"),
    status: git(repo, "status", "--porcelain=v1"),
    renamedBase: readText(repo, "caller-base-draft.txt"),
    draft: readText(repo, "caller-draft.txt"),
    worktrees: git(repo, "worktree", "list", "--porcelain"),
  };
  const first = JSON.parse(
    vlab(repo, "rebase-forecast", "main", "--json"),
  );
  const repeated = JSON.parse(
    vlab(repo, "rebase-forecast", "main", "--json"),
  );

  assert.equal(first.schema, "vcs-lab.rebase-forecast/v1");
  assert.equal(first.status, "complete");
  assert.equal(first.sourceRef, "feature");
  assert.equal(first.scope, "committed-heads");
  assert.equal(first.ignoredCallerDirtyFiles, 2);
  assert.equal(first.candidatePolicy, "none");
  assert.equal(first.callerInvariants.preserved, true);
  assert.equal(first.planFingerprint, first.plan.fingerprint);
  assert.deepEqual(
    first.plan.replayQueue.map((item) => item.changeId),
    [continuation.changeId],
  );
  assert.equal(first.steps.length, 1);
  assert.equal(first.steps[0].relation, "causal-rebase");
  assert.equal(first.steps[0].targetBeforeTree, first.ontoTree);
  assert.equal(first.steps[0].resultTree, first.sourceTree);
  assert.equal(first.predictedResultTree, first.sourceTree);
  assert.equal(first.exactStateEqualityAfter, true);
  assert.notEqual(first.id, repeated.id);
  assert.equal(first.planFingerprint, repeated.planFingerprint);
  assert.deepEqual(first.steps, repeated.steps);
  assert.equal(first.predictedResultTree, repeated.predictedResultTree);
  assert.match(vlab(repo, "rebase-forecast", "main"), /status\s+complete/);

  const metadata = JSON.parse(vlab(repo, "metadata", "status", "--json"));
  assert.equal(metadata.scopes.worktreePrivate.forecastCount, 3);
  const callerAfter = {
    head: git(repo, "rev-parse", "HEAD"),
    branch: git(repo, "branch", "--show-current"),
    status: git(repo, "status", "--porcelain=v1"),
    renamedBase: readText(repo, "caller-base-draft.txt"),
    draft: readText(repo, "caller-draft.txt"),
    worktrees: git(repo, "worktree", "list", "--porcelain"),
  };
  assert.deepEqual(callerAfter, callerBefore);
});

test("causal rebase forecasts require and pin candidate acceptance", (t) => {
  const { repo } = makeRepo(t);
  write(repo, "base.txt", "base\n");
  git(repo, "add", ".");
  const base = JSON.parse(vlab(repo, "commit", "-m", "base"));

  git(repo, "switch", "-c", "feature", base.commit);
  write(repo, "equivalent.txt", "same patch\n");
  git(repo, "add", ".");
  const source = JSON.parse(vlab(repo, "commit", "-m", "source patch"));

  git(repo, "switch", "main");
  write(repo, "equivalent.txt", "same patch\n");
  git(repo, "add", ".");
  vlab(repo, "commit", "-m", "independent target patch");
  const callerBefore = {
    head: git(repo, "rev-parse", "HEAD"),
    branch: git(repo, "branch", "--show-current"),
    status: git(repo, "status", "--porcelain=v1"),
    worktrees: git(repo, "worktree", "list", "--porcelain"),
  };

  const review = JSON.parse(
    vlab(repo, "rebase-forecast", "main", "feature", "--json"),
  );
  assert.equal(review.status, "review-required");
  assert.equal(review.candidateDecisionRequired, true);
  assert.equal(review.candidatePolicy, "review-required");
  assert.equal(review.blockedReason, "heuristic-candidate-decision-required");
  assert.equal(review.predictedResultTree, null);
  assert.deepEqual(review.acceptedCandidates, []);

  const accepted = JSON.parse(
    vlab(
      repo,
      "rebase-forecast",
      "main",
      "feature",
      "--accept-candidates",
      "--json",
    ),
  );
  assert.equal(accepted.status, "complete");
  assert.equal(accepted.candidateDecisionRequired, false);
  assert.equal(accepted.candidatePolicy, "accepted");
  assert.equal(accepted.acceptedCandidates.length, 1);
  assert.equal(accepted.acceptedCandidates[0].changeId, source.changeId);
  assert.equal(accepted.acceptedCandidates[0].decision, "omit");
  assert.equal(accepted.steps.length, 0);
  assert.equal(accepted.predictedResultTree, accepted.ontoTree);
  assert.equal(accepted.exactStateEqualityAfter, true);
  assert.equal(accepted.planFingerprint, review.planFingerprint);
  assert.deepEqual(
    {
      head: git(repo, "rev-parse", "HEAD"),
      branch: git(repo, "branch", "--show-current"),
      status: git(repo, "status", "--porcelain=v1"),
      worktrees: git(repo, "worktree", "list", "--porcelain"),
    },
    callerBefore,
  );
});

test("causal rebase forecasts expose conflicts without mutating the caller", (t) => {
  const { repo } = makeRepo(t);
  write(repo, "shared.txt", "base\n");
  git(repo, "add", ".");
  const base = JSON.parse(vlab(repo, "commit", "-m", "base"));

  git(repo, "switch", "-c", "feature", base.commit);
  write(repo, "shared.txt", "source\n");
  git(repo, "add", ".");
  vlab(repo, "commit", "-m", "source changes shared file");

  git(repo, "switch", "main");
  write(repo, "shared.txt", "target\n");
  git(repo, "add", ".");
  vlab(repo, "commit", "-m", "target changes shared file");
  const callerBefore = {
    head: git(repo, "rev-parse", "HEAD"),
    status: git(repo, "status", "--porcelain=v1"),
    content: readText(repo, "shared.txt"),
    worktrees: git(repo, "worktree", "list", "--porcelain"),
  };

  const forecast = JSON.parse(
    vlab(repo, "rebase-forecast", "main", "feature", "--json"),
  );
  assert.equal(forecast.status, "blocked");
  assert.equal(forecast.blockedReason, "missing-exact-resolution");
  assert.equal(forecast.predictedResultTree, null);
  assert.equal(forecast.steps.length, 1);
  assert.equal(forecast.steps[0].outcome, "blocked-conflict");
  assert.equal(forecast.steps[0].targetBeforeTree, forecast.ontoTree);
  assert.deepEqual(
    forecast.steps[0].conflicts.map((item) => item.path),
    ["shared.txt"],
  );
  assert.equal(forecast.steps[0].conflicts[0].candidates.length, 0);
  assert.deepEqual(
    {
      head: git(repo, "rev-parse", "HEAD"),
      status: git(repo, "status", "--porcelain=v1"),
      content: readText(repo, "shared.txt"),
      worktrees: git(repo, "worktree", "list", "--porcelain"),
    },
    callerBefore,
  );
});

test("causal rebase applies a reviewed continuation and ports unreachable origins", (t) => {
  const { repo, parent } = makeRepo(t);
  write(repo, "base.txt", "base\n");
  git(repo, "add", ".");
  const base = JSON.parse(vlab(repo, "commit", "-m", "base"));
  vlab(repo, "init");

  git(repo, "switch", "-c", "feature", base.commit);
  write(repo, "feature.txt", "one\n");
  git(repo, "add", ".");
  const first = JSON.parse(vlab(repo, "commit", "-m", "feature one"));
  write(repo, "feature.txt", "one\ntwo\n");
  git(repo, "add", ".");
  const second = JSON.parse(vlab(repo, "commit", "-m", "feature two"));

  git(repo, "switch", "main");
  const landing = JSON.parse(vlab(repo, "hard-squash", "feature", "--json"));
  git(repo, "switch", "feature");
  write(repo, "continuation.txt", "three\n");
  git(repo, "add", ".");
  const continuation = JSON.parse(
    vlab(repo, "commit", "-m", "feature continuation"),
  );
  const originalTree = git(repo, "rev-parse", "HEAD^{tree}");

  const forecast = JSON.parse(
    vlab(repo, "rebase-forecast", "main", "--json"),
  );
  const result = JSON.parse(
    vlab(
      repo,
      "rebase",
      "main",
      "--use-forecast",
      forecast.id,
      "--json",
    ),
  );
  assert.equal(result.receipt.schema, "vcs-lab.rebase/v1");
  assert.equal(result.receipt.forecastId, forecast.id);
  assert.equal(result.receipt.sourceHead, continuation.commit);
  assert.equal(result.receipt.resultTree, forecast.predictedResultTree);
  assert.equal(result.receipt.resultTree, originalTree);
  assert.equal(result.receipt.exactStateEqualityAfter, true);
  assert.deepEqual(result.receipt.absorbedChanges, [
    first.changeId,
    second.changeId,
    continuation.changeId,
  ]);
  assert.equal(result.receipt.applications.length, 1);
  assert.equal(
    result.receipt.applications[0].sourceChangeId,
    continuation.changeId,
  );
  assert.equal(
    result.receipt.applications[0].appliedChangeId,
    continuation.changeId,
  );
  assert.equal(git(repo, "branch", "--show-current"), "feature");
  assert.equal(git(repo, "show", "-s", "--format=%P", "HEAD"), landing.landingCommit);
  assert.doesNotThrow(() =>
    git(repo, "merge-base", "--is-ancestor", "main", "feature"),
  );
  assert.equal(git(repo, "status", "--porcelain=v1"), "");
  assert.equal(
    JSON.parse(vlab(repo, "rebase", "--status", "--json")).active,
    false,
  );
  const validation = JSON.parse(vlab(repo, "metadata", "validate", "--json"));
  assert.equal(validation.summary.valid, true);
  assert.equal(validation.summary.acceptedPortableRecords, 3);
  assert.match(vlab(repo, "receipts"), /REBASE rebase_/);
  assert.match(vlab(repo, "graph"), /rebase onto/);

  const envelopeA = path.join(parent, "rebase-envelope-a");
  const envelopeB = path.join(parent, "rebase-envelope-b");
  vlab(repo, "metadata", "export", envelopeA, "--json");
  vlab(repo, "metadata", "export", envelopeB, "--json");
  assert.deepEqual(
    fs.readFileSync(path.join(envelopeA, "manifest.json")),
    fs.readFileSync(path.join(envelopeB, "manifest.json")),
  );
  assert.deepEqual(
    fs.readFileSync(path.join(envelopeA, "objects.bundle")),
    fs.readFileSync(path.join(envelopeB, "objects.bundle")),
  );

  const destination = path.join(parent, "rebase-destination");
  git(parent, "clone", "--no-local", repo, destination);
  git(destination, "config", "user.name", "VCS Lab Test");
  git(destination, "config", "user.email", "vcs-lab@example.test");
  const missingOrigin = spawnSync(
    "git",
    ["cat-file", "-e", `${continuation.commit}^{commit}`],
    { cwd: destination, encoding: "utf8", env: testEnv() },
  );
  assert.notEqual(missingOrigin.status, 0);
  const preview = JSON.parse(
    vlab(destination, "metadata", "import", envelopeA, "--dry-run", "--json"),
  );
  assert.equal(preview.summary.applicable, true);
  assert.equal(preview.summary.addRecords, 3);
  vlab(destination, "metadata", "import", envelopeA, "--apply", "--json");
  assert.doesNotThrow(() =>
    git(destination, "cat-file", "-e", `${continuation.commit}^{commit}`),
  );
  const importedValidation = JSON.parse(
    vlab(destination, "metadata", "validate", "--json"),
  );
  assert.equal(importedValidation.summary.valid, true);
  assert.equal(importedValidation.summary.acceptedPortableRecords, 3);
});

test("causal rebase rejects a stale forecast before moving the source branch", (t) => {
  const { repo } = makeRepo(t);
  write(repo, "base.txt", "base\n");
  git(repo, "add", ".");
  const base = JSON.parse(vlab(repo, "commit", "-m", "base"));

  git(repo, "switch", "-c", "feature", base.commit);
  write(repo, "feature.txt", "feature\n");
  git(repo, "add", ".");
  const source = JSON.parse(vlab(repo, "commit", "-m", "feature"));
  const forecast = JSON.parse(
    vlab(repo, "rebase-forecast", "main", "--json"),
  );

  git(repo, "switch", "main");
  write(repo, "target.txt", "target moved\n");
  git(repo, "add", ".");
  vlab(repo, "commit", "-m", "move target");
  git(repo, "switch", "feature");
  const attempt = vlabResult(
    repo,
    "rebase",
    "main",
    "--use-forecast",
    forecast.id,
  );
  assert.notEqual(attempt.status, 0);
  assert.match(attempt.stderr, /forecast .* is stale/i);
  assert.equal(git(repo, "rev-parse", "HEAD"), source.commit);
  assert.equal(git(repo, "status", "--porcelain=v1"), "");
  assert.equal(
    JSON.parse(vlab(repo, "rebase", "--status", "--json")).active,
    false,
  );
});

test("causal rebase pauses privately and can continue as an explicit fork", (t) => {
  const { repo, parent } = makeRepo(t);
  write(repo, "shared.txt", "base\n");
  git(repo, "add", ".");
  const base = JSON.parse(vlab(repo, "commit", "-m", "base"));
  vlab(repo, "init");

  git(repo, "switch", "-c", "feature", base.commit);
  write(repo, "shared.txt", "source\n");
  git(repo, "add", ".");
  const source = JSON.parse(vlab(repo, "commit", "-m", "source change"));
  git(repo, "switch", "main");
  write(repo, "shared.txt", "target\n");
  git(repo, "add", ".");
  vlab(repo, "commit", "-m", "target change");
  git(repo, "switch", "feature");

  const observer = path.join(parent, "rebase-observer");
  git(repo, "worktree", "add", observer, "main");
  const attempt = vlabResult(repo, "rebase", "main");
  assert.notEqual(attempt.status, 0);
  assert.match(attempt.stderr, /causal rebase paused/i);
  const status = JSON.parse(vlab(repo, "rebase", "--status", "--json"));
  assert.equal(status.active, true);
  assert.equal(status.state, "conflicted");
  assert.equal(status.progress.completed, 0);
  assert.deepEqual(status.current.unresolvedPaths, ["shared.txt"]);
  assert.equal(
    JSON.parse(vlab(observer, "rebase", "--status", "--json")).active,
    false,
  );
  const metadata = JSON.parse(vlab(repo, "metadata", "status", "--json"));
  assert.equal(metadata.scopes.worktreePrivate.pendingOperationCount, 1);
  const privateEntry = metadata.scopes.worktreePrivate.worktrees.find(
    (entry) => entry.path === path.resolve(repo),
  );
  assert.deepEqual(privateEntry.pendingOperationKinds, ["rebase"]);
  assert.equal(
    JSON.parse(vlab(repo, "resolve", "status", "--json")).conflicts.length,
    1,
  );

  write(repo, "shared.txt", "forked resolution\n");
  git(repo, "add", "shared.txt");
  const completed = JSON.parse(
    vlab(repo, "rebase", "--continue", "--fork", "--json"),
  );
  const application = completed.receipt.applications[0];
  assert.equal(application.relation, "contextual-fork");
  assert.equal(application.sourceChangeId, source.changeId);
  assert.notEqual(application.appliedChangeId, source.changeId);
  assert.deepEqual(completed.receipt.forkedSourceCommits, [source.commit]);
  assert.deepEqual(completed.receipt.absorbedCommits, []);
  assert.match(git(repo, "show", "-s", "--format=%B", "HEAD"), /Derived-From:/);
  assert.equal(git(repo, "status", "--porcelain=v1"), "");
  assert.equal(
    JSON.parse(vlab(repo, "metadata", "validate", "--json")).summary.valid,
    true,
  );
});

test("causal rebase abort restores the exact source after a partial replay", (t) => {
  const { repo } = makeRepo(t);
  write(repo, "shared.txt", "base\n");
  git(repo, "add", ".");
  const base = JSON.parse(vlab(repo, "commit", "-m", "base"));
  vlab(repo, "init");

  git(repo, "switch", "-c", "feature", base.commit);
  write(repo, "clean.txt", "clean replay\n");
  git(repo, "add", ".");
  vlab(repo, "commit", "-m", "clean first change");
  write(repo, "shared.txt", "source\n");
  git(repo, "add", ".");
  const original = JSON.parse(vlab(repo, "commit", "-m", "conflicting second change"));
  const originalTree = git(repo, "rev-parse", "HEAD^{tree}");

  git(repo, "switch", "main");
  write(repo, "shared.txt", "target\n");
  git(repo, "add", ".");
  vlab(repo, "commit", "-m", "target change");
  git(repo, "switch", "feature");
  const notesBefore = git(
    repo,
    "for-each-ref",
    "--format=%(refname) %(objectname)",
    "refs/notes/vcs-lab",
  );

  const attempt = vlabResult(repo, "rebase", "main");
  assert.notEqual(attempt.status, 0);
  const paused = JSON.parse(vlab(repo, "rebase", "--status", "--json"));
  assert.equal(paused.state, "conflicted");
  assert.equal(paused.progress.completed, 1);
  assert.equal(paused.applied.length, 1);
  assert.equal(
    git(repo, "for-each-ref", "--format=%(refname) %(objectname)", "refs/notes/vcs-lab"),
    notesBefore,
  );

  const aborted = JSON.parse(vlab(repo, "rebase", "--abort", "--json"));
  assert.equal(aborted.restoredHead, original.commit);
  assert.equal(git(repo, "rev-parse", "HEAD"), original.commit);
  assert.equal(git(repo, "rev-parse", "HEAD^{tree}"), originalTree);
  assert.equal(git(repo, "status", "--porcelain=v1"), "");
  assert.equal(
    JSON.parse(vlab(repo, "rebase", "--status", "--json")).active,
    false,
  );
  assert.equal(
    git(repo, "for-each-ref", "--format=%(refname) %(objectname)", "refs/notes/vcs-lab"),
    notesBefore,
  );
});

test("causal rebase blocks an unexpectedly empty replay instead of skipping it", (t) => {
  const { repo } = makeRepo(t);
  write(repo, "base.txt", "base\n");
  git(repo, "add", ".");
  const base = JSON.parse(vlab(repo, "commit", "-m", "base"));
  vlab(repo, "init");

  git(repo, "switch", "-c", "feature", base.commit);
  const empty = JSON.parse(
    vlab(repo, "commit", "-m", "intentional empty change", "--allow-empty"),
  );
  const plan = JSON.parse(vlab(repo, "rebase-plan", "main", "--json"));
  assert.equal(plan.replayQueue.length, 1);
  assert.equal(plan.replayQueue[0].commit, empty.commit);

  const attempt = vlabResult(repo, "rebase", "main");
  assert.notEqual(attempt.status, 0);
  assert.match(attempt.stderr, /unexpectedly empty|blocked/i);
  const status = JSON.parse(vlab(repo, "rebase", "--status", "--json"));
  assert.equal(status.active, true);
  assert.equal(status.state, "blocked");
  assert.equal(status.progress.completed, 0);
  assert.equal(
    git(repo, "for-each-ref", "--format=%(refname)", "refs/notes/vcs-lab"),
    "",
  );
  const aborted = JSON.parse(vlab(repo, "rebase", "--abort", "--json"));
  assert.equal(aborted.restoredHead, empty.commit);
  assert.equal(git(repo, "rev-parse", "HEAD"), empty.commit);
  assert.equal(git(repo, "status", "--porcelain=v1"), "");
});

test("causal rebase batch-applies a pinned exact resolution", (t) => {
  const { repo } = makeRepo(t);
  write(repo, "shared.txt", "base\n");
  git(repo, "add", ".");
  const base = JSON.parse(vlab(repo, "commit", "-m", "base"));
  vlab(repo, "init");

  git(repo, "switch", "-c", "source-one", base.commit);
  write(repo, "shared.txt", "source\n");
  git(repo, "add", ".");
  vlab(repo, "commit", "-m", "source one");
  git(repo, "switch", "-c", "target-one", base.commit);
  write(repo, "shared.txt", "target\n");
  git(repo, "add", ".");
  vlab(repo, "commit", "-m", "target one");
  assert.notEqual(vlabResult(repo, "reconcile", "source-one").status, 0);
  write(repo, "shared.txt", "remembered\n");
  git(repo, "add", ".");
  vlab(repo, "reconcile", "--continue", "--json");

  git(repo, "switch", "-c", "source-two", base.commit);
  write(repo, "shared.txt", "source\n");
  git(repo, "add", ".");
  const source = JSON.parse(vlab(repo, "commit", "-m", "source two"));
  git(repo, "switch", "-c", "target-two", base.commit);
  write(repo, "shared.txt", "target\n");
  git(repo, "add", ".");
  vlab(repo, "commit", "-m", "target two");
  git(repo, "switch", "source-two");

  const forecast = JSON.parse(
    vlab(repo, "rebase-forecast", "target-two", "--json"),
  );
  assert.equal(forecast.status, "complete");
  assert.equal(forecast.steps[0].outcome, "exact-resolution");
  assert.equal(forecast.approvedResolutions.length, 1);
  const result = JSON.parse(
    vlab(
      repo,
      "rebase",
      "target-two",
      "--use-forecast",
      forecast.id,
      "--json",
    ),
  );
  assert.equal(result.receipt.forecastId, forecast.id);
  assert.equal(result.receipt.resultTree, forecast.predictedResultTree);
  assert.equal(result.receipt.applications[0].relation, "contextual-rebase");
  assert.equal(result.receipt.applications[0].sourceChangeId, source.changeId);
  assert.equal(result.receipt.applications[0].appliedChangeId, source.changeId);
  assert.equal(
    result.receipt.applications[0].resolutions[0].selectionMethod,
    "rebase-forecast-batch",
  );
  assert.equal(
    result.receipt.applications[0].resolutions[0].decision,
    "accepted",
  );
  assert.equal(readText(repo, "shared.txt"), "remembered\n");
  assert.equal(git(repo, "status", "--porcelain=v1"), "");
});

test("compact landing is one first-parent unit with a real causal parent", (t) => {
  const { repo } = makeRepo(t);
  write(repo, "base.txt", "base\n");
  git(repo, "add", ".");
  vlab(repo, "commit", "-m", "base");
  vlab(repo, "init");

  vlab(repo, "branch", "feature");
  write(repo, "feature.txt", "feature\n");
  git(repo, "add", ".");
  vlab(repo, "commit", "-m", "feature");
  const featureHead = git(repo, "rev-parse", "HEAD");
  git(repo, "switch", "main");
  const receipt = JSON.parse(vlab(repo, "compact-merge", "feature", "--json"));

  const parents = git(repo, "show", "-s", "--format=%P", "HEAD").split(/\s+/);
  assert.equal(parents.length, 2);
  assert.equal(parents[1], featureHead);
  assert.equal(receipt.mode, "compact");
  assert.doesNotThrow(() => git(repo, "merge-base", "--is-ancestor", "feature", "main"));
});

test("vlab merge lands compact by default, hard-squash on request, and compact when both flags are given", (t) => {
  const { repo } = makeRepo(t);
  write(repo, "base.txt", "base\n");
  git(repo, "add", ".");
  vlab(repo, "commit", "-m", "base");
  vlab(repo, "init");

  // Three sources from the same base, one per landing, so every landing has
  // real work to absorb and none is already up to date.
  const sources = {};
  for (const name of ["default", "squash", "both"]) {
    git(repo, "switch", "-c", `feature-${name}`, "main");
    write(repo, `${name}.txt`, `${name}\n`);
    git(repo, "add", ".");
    sources[name] = JSON.parse(vlab(repo, "commit", "-m", `feature ${name}`));
  }
  git(repo, "switch", "main");

  const landingMode = () =>
    git(repo, "show", "-s", "--format=%B", "HEAD").match(/^Landing-Mode: (.+)$/m)[1];
  const parentCount = () =>
    git(repo, "show", "-s", "--format=%P", "HEAD").split(/\s+/).filter(Boolean).length;
  const isAncestor = (source) =>
    spawnSync("git", ["merge-base", "--is-ancestor", source, "main"], {
      cwd: repo,
      encoding: "utf8",
      env: testEnv(),
    }).status === 0;

  // No flag: a compact merge, one first-parent unit whose second parent is
  // the source head, so the source becomes an ancestor.
  const compact = JSON.parse(vlab(repo, "merge", "feature-default", "--json"));
  assert.equal(compact.mode, "compact");
  assert.equal(compact.sourceHead, sources.default.commit);
  assert.deepEqual(compact.absorbedChanges, [sources.default.changeId]);
  assert.equal(compact.landingCommit, git(repo, "rev-parse", "HEAD"));
  assert.equal(parentCount(), 2);
  assert.equal(git(repo, "rev-parse", "HEAD^2"), sources.default.commit);
  assert.equal(landingMode(), "compact");
  assert.equal(isAncestor("feature-default"), true);

  // --hard-squash: a single-parent commit that absorbs the source without
  // making it an ancestor.
  const squash = JSON.parse(
    vlab(repo, "merge", "feature-squash", "--hard-squash", "--json"),
  );
  assert.equal(squash.mode, "hard-squash");
  assert.equal(squash.sourceHead, sources.squash.commit);
  assert.deepEqual(squash.absorbedChanges, [sources.squash.changeId]);
  assert.equal(squash.landingCommit, git(repo, "rev-parse", "HEAD"));
  assert.equal(parentCount(), 1);
  assert.equal(landingMode(), "hard-squash");
  assert.equal(isAncestor("feature-squash"), false);
  assert.equal(readText(repo, "squash.txt"), "squash\n");

  // Both flags: the handler lets --compact win rather than refusing, and the
  // receipt and the commit agree on the mode it chose.
  const both = JSON.parse(
    vlab(repo, "merge", "feature-both", "--compact", "--hard-squash", "--json"),
  );
  assert.equal(both.mode, "compact");
  assert.equal(parentCount(), 2);
  assert.equal(git(repo, "rev-parse", "HEAD^2"), sources.both.commit);
  assert.equal(landingMode(), "compact");

  // Every landing left a receipt naming its mode, and the tree holds all
  // three sources' work.
  const landings = JSON.parse(vlab(repo, "receipts", "--json"))
    .filter((record) => record.type === "landing");
  assert.deepEqual(
    landings.map((record) => record.mode).sort(),
    ["compact", "compact", "hard-squash"],
  );
  assert.deepEqual(
    landings.map((record) => record.landingCommit).sort(),
    [compact.landingCommit, squash.landingCommit, both.landingCommit].sort(),
  );
  for (const name of ["default", "squash", "both"]) {
    assert.equal(readText(repo, `${name}.txt`), `${name}\n`);
  }
  assert.equal(git(repo, "status", "--porcelain=v1"), "");
});

test("cherry-pick preserves logical identity and fork makes divergence explicit", (t) => {
  const { repo } = makeRepo(t);
  write(repo, "base.txt", "base\n");
  git(repo, "add", ".");
  const base = JSON.parse(vlab(repo, "commit", "-m", "base"));
  vlab(repo, "init");

  vlab(repo, "branch", "feature");
  write(repo, "picked.txt", "portable change\n");
  git(repo, "add", ".");
  const origin = JSON.parse(vlab(repo, "commit", "-m", "portable change"));

  git(repo, "switch", "main");
  const application = JSON.parse(vlab(repo, "cherry-pick", origin.changeId, "--json"));
  assert.equal(application.originChangeId, origin.changeId);
  assert.equal(application.appliedChangeId, origin.changeId);
  const duplicate = JSON.parse(vlab(repo, "cherry-pick", origin.changeId, "--json"));
  assert.equal(duplicate.noOp, true);

  git(repo, "switch", "-c", "forked-backport", base.commit);
  const fork = JSON.parse(
    vlab(repo, "cherry-pick", origin.changeId, "--fork", "--json"),
  );
  assert.equal(fork.originChangeId, origin.changeId);
  assert.notEqual(fork.appliedChangeId, origin.changeId);
  assert.equal(fork.relation, "derived-fork");
});

function ordinaryGitPickFixture(t) {
  const { repo } = makeRepo(t);
  write(repo, "base.txt", "base\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "ordinary base");
  const base = git(repo, "rev-parse", "HEAD");
  git(repo, "switch", "-c", "feature");
  write(repo, "picked.txt", "portable change\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "ordinary origin");
  const origin = git(repo, "rev-parse", "HEAD");
  git(repo, "switch", "main");
  write(repo, "target.txt", "target context\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "ordinary target");
  return { repo, base, origin, target: git(repo, "rev-parse", "HEAD") };
}

function pickState(repo) {
  const status = git(repo, "status", "--porcelain=v1");
  const gitPath = (name) => path.resolve(repo, git(repo, "rev-parse", "--git-path", name));
  return {
    head: git(repo, "rev-parse", "HEAD"),
    refs: git(repo, "show-ref"),
    index: fs.readFileSync(gitPath("index")),
    files: git(repo, "ls-files").split("\n").map((file) => [file, fs.readFileSync(path.join(repo, file))]),
    status,
    pending: ["CHERRY_PICK_HEAD", "MERGE_MSG", "sequencer"].map((name) => fs.existsSync(gitPath(name))),
  };
}

function assertOrdinaryPickNoOp(repo, origin) {
  const before = pickState(repo);
  const result = JSON.parse(vlab(repo, "cherry-pick", origin, "--json"));
  assert.deepEqual(result, {
    noOp: true,
    reason: "target-already-covers-change-id",
    originCommit: origin,
    originChangeId: `git:${origin}`,
    targetBefore: before.head,
  });
  assert.deepEqual(pickState(repo), before);
}

test("cherry-pick suppresses an ordinary Git origin already in target ancestry", (t) => {
  const { repo, origin } = ordinaryGitPickFixture(t);
  git(repo, "merge", "--no-ff", "feature", "-m", "ordinary merge");
  assertOrdinaryPickNoOp(repo, origin);
});

test("cherry-pick suppresses an ordinary Git application and still honors repeat", (t) => {
  const { repo, origin } = ordinaryGitPickFixture(t);
  const first = JSON.parse(vlab(repo, "cherry-pick", origin, "--json"));
  assert.equal(first.originChangeId, `git:${origin}`);
  assert.equal(first.appliedChangeId, `git:${origin}`);
  assertOrdinaryPickNoOp(repo, origin);

  // Removing the content does not remove the reachable application evidence.
  git(repo, "revert", "--no-edit", first.appliedCommit);
  assertOrdinaryPickNoOp(repo, origin);
  const repeated = JSON.parse(vlab(repo, "cherry-pick", origin, "--repeat", "--json"));
  assert.equal(repeated.relation, "same-logical-change");
  assert.equal(repeated.originCommit, origin);
  assert.equal(repeated.appliedChangeId, `git:${origin}`);
  assert.equal(readText(repo, "picked.txt"), "portable change\n");

  git(repo, "revert", "--no-edit", repeated.appliedCommit);
  const fork = JSON.parse(vlab(repo, "cherry-pick", origin, "--repeat", "--fork", "--json"));
  assert.equal(fork.relation, "derived-fork");
  assert.notEqual(fork.appliedChangeId, `git:${origin}`);
});

test("cherry-pick does not infer ordinary Git coverage from other branches or forks", (t) => {
  const { repo, origin, target } = ordinaryGitPickFixture(t);
  git(repo, "switch", "-c", "other-target");
  vlab(repo, "cherry-pick", origin, "--json");
  git(repo, "switch", "main");
  const fork = JSON.parse(vlab(repo, "cherry-pick", origin, "--fork", "--json"));
  assert.equal(fork.targetBefore, target);
  assert.equal(fork.relation, "derived-fork");
  git(repo, "revert", "--no-edit", fork.appliedCommit);
  const applied = JSON.parse(vlab(repo, "cherry-pick", origin, "--json"));
  assert.equal(applied.relation, "same-logical-change");
  assert.equal(applied.originChangeId, `git:${origin}`);
  assert.equal(readText(repo, "picked.txt"), "portable change\n");
});

test("cherry-pick rejects invalid or non-preserving ordinary Git application evidence", (t) => {
  const { repo, origin, target, base } = ordinaryGitPickFixture(t);
  const record = {
    schema: "vcs-lab.application/v1", type: "application", id: "apply_coverage_test",
    originCommit: origin, originChangeId: `git:${origin}`,
    appliedCommit: target, appliedChangeId: `git:${origin}`, targetBefore: base,
    relation: "same-logical-change", createdAt: new Date(0).toISOString(),
  };
  const cases = [
    { schema: "vcs-lab.application/v99" },
    { id: null },
    { targetBefore: "f".repeat(origin.length) },
    { targetBefore: git(repo, "rev-parse", "HEAD^{tree}") },
    { appliedCommit: base },
    { originChangeId: "git:" + base, appliedChangeId: "git:" + base },
    { appliedChangeId: "ch_different_identity" },
    { relation: "derived-fork" },
    { relation: "contextual-fork" },
    { relation: "unknown-relation" },
  ];
  for (const corruption of cases) {
    // Every reset is inside this disposable fixture. Keep the source and the
    // previous application's notes to exercise target reachability as well.
    git(repo, "reset", "--hard", target);
    writeVlabNote(repo, target, { schema: "vcs-lab.note/v1", records: [{ ...record, ...corruption }] });
    const result = JSON.parse(vlab(repo, "cherry-pick", origin, "--json"));
    assert.equal(result.relation, "same-logical-change", JSON.stringify(corruption));
    assert.equal(result.targetBefore, target);
  }
});

test("cherry-pick keeps patch-equivalent ordinary Git changes advisory", (t) => {
  const { repo, origin } = ordinaryGitPickFixture(t);
  git(repo, "cherry-pick", origin);
  const equivalent = git(repo, "rev-parse", "HEAD");
  git(repo, "revert", "--no-edit", equivalent);
  const application = JSON.parse(vlab(repo, "cherry-pick", origin, "--json"));
  assert.equal(application.relation, "same-logical-change");
  assert.equal(application.originCommit, origin);
  assert.equal(readText(repo, "picked.txt"), "portable change\n");
});

test("cherry-pick --repeat re-applies a change the target's history already covers", (t) => {
  const { repo } = makeRepo(t);
  write(repo, "base.txt", "base\n");
  git(repo, "add", ".");
  vlab(repo, "commit", "-m", "base");
  vlab(repo, "init");

  vlab(repo, "branch", "feature");
  write(repo, "picked.txt", "portable change\n");
  git(repo, "add", ".");
  const origin = JSON.parse(vlab(repo, "commit", "-m", "portable change"));
  git(repo, "switch", "main");
  const first = JSON.parse(vlab(repo, "cherry-pick", origin.changeId, "--json"));
  assert.equal(first.appliedChangeId, origin.changeId);

  // The change is then backed out, so its Change-Id stays in history while
  // its content is gone: the case in which repeating it is a real request.
  git(repo, "rm", "-q", "picked.txt");
  vlab(repo, "commit", "-m", "back out the portable change");
  const headBefore = git(repo, "rev-parse", "HEAD");
  assert.equal(fs.existsSync(path.join(repo, "picked.txt")), false);

  // Without --repeat, coverage by Change-Id makes this a no-op that moves
  // nothing.
  const covered = JSON.parse(vlab(repo, "cherry-pick", origin.changeId, "--json"));
  assert.equal(covered.noOp, true);
  assert.equal(covered.reason, "target-already-covers-change-id");
  assert.equal(covered.targetBefore, headBefore);
  assert.equal(git(repo, "rev-parse", "HEAD"), headBefore);
  assert.equal(fs.existsSync(path.join(repo, "picked.txt")), false);

  // With --repeat, the same logical change is applied again as itself: no
  // fork, the origin's Change-Id, and a fresh application record.
  const repeated = JSON.parse(
    vlab(repo, "cherry-pick", origin.changeId, "--repeat", "--json"),
  );
  assert.equal(repeated.noOp, undefined);
  assert.equal(repeated.schema, "vcs-lab.application/v1");
  // A Change-Id names a logical change, and by now two commits carry this
  // one: the original and its first pick. The argument resolves to the
  // change's origin, the bearer no application record names as its applied
  // commit (identity protocol §5), so the record names the original.
  assert.equal(repeated.originCommit, origin.commit);
  assert.equal(repeated.originChangeId, origin.changeId);
  assert.equal(repeated.appliedChangeId, origin.changeId);
  assert.equal(repeated.relation, "same-logical-change");
  assert.equal(repeated.targetBefore, headBefore);
  const head = git(repo, "rev-parse", "HEAD");
  assert.equal(repeated.appliedCommit, head);
  assert.notEqual(head, headBefore);
  assert.equal(git(repo, "rev-parse", "HEAD~1"), headBefore);
  assert.equal(readText(repo, "picked.txt"), "portable change\n");
  assert.match(
    git(repo, "show", "-s", "--format=%B", "HEAD"),
    new RegExp(`^Change-Id: ${origin.changeId}$`, "m"),
  );
  assert.equal(git(repo, "status", "--porcelain=v1"), "");

  // Both applications are on record against the same origin.
  const applications = JSON.parse(vlab(repo, "receipts", "--json")).filter(
    (record) =>
      record.type === "application" && record.originChangeId === origin.changeId,
  );
  assert.deepEqual(
    applications.map((record) => record.appliedCommit).sort(),
    [first.appliedCommit, head].sort(),
  );
});

test("a Change-Id argument names the change's origin, then the earliest bearer", (t) => {
  const { repo } = makeRepo(t);
  write(repo, "base.txt", "base\n");
  git(repo, "add", ".");
  vlab(repo, "commit", "-m", "base");
  vlab(repo, "init");
  const dated = (date) => ({
    env: testEnv({ GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }),
  });
  // main covers the change throughout, so the pick is the no-op projection:
  // it reports what the argument resolved to and moves nothing.
  const resolved = (changeId) => {
    const projection = JSON.parse(vlab(repo, "cherry-pick", changeId, "--json"));
    assert.equal(projection.noOp, true);
    assert.equal(projection.reason, "target-already-covers-change-id");
    return projection.originCommit;
  };

  // The origin is committed at T+10 and its identity-preserving pick at T+0,
  // so date order alone would name the pick.
  vlab(repo, "branch", "feature");
  write(repo, "picked.txt", "portable change\n");
  git(repo, "add", ".");
  const origin = JSON.parse(exec(
    process.execPath, [cli, "commit", "-m", "portable change"], repo,
    dated("2026-01-01T00:00:10Z"),
  ));
  git(repo, "switch", "main");
  const picked = JSON.parse(exec(
    process.execPath, [cli, "cherry-pick", origin.changeId, "--json"], repo,
    dated("2026-01-01T00:00:00Z"),
  ));
  assert.equal(picked.appliedChangeId, origin.changeId);
  // The pick is on record as applied from the origin, so the origin is named
  // whatever the dates say.
  assert.equal(resolved(origin.changeId), origin.commit);

  // A plain `git cherry-pick` copies the trailer and leaves no record, so
  // nothing says which of the origin and the copy came first except their
  // dates: the earliest bearer is named, here the copy.
  git(repo, "switch", "-c", "copy-one", "main~1");
  exec("git", ["cherry-pick", origin.commit], repo, dated("2025-12-31T23:59:50Z"));
  const copyOne = git(repo, "rev-parse", "HEAD");
  git(repo, "switch", "main");
  assert.equal(resolved(origin.changeId), copyOne);

  // Two bearers with the same date are ordered by commit id. The second copy
  // sits on a different parent so it is a different commit.
  git(repo, "switch", "-c", "copy-two", "main~1");
  write(repo, "other.txt", "other\n");
  git(repo, "add", ".");
  exec("git", ["commit", "-m", "other"], repo, dated("2025-12-31T23:59:40Z"));
  exec("git", ["cherry-pick", origin.commit], repo, dated("2025-12-31T23:59:50Z"));
  const copyTwo = git(repo, "rev-parse", "HEAD");
  git(repo, "switch", "main");
  assert.notEqual(copyOne, copyTwo);
  assert.equal(resolved(origin.changeId), [copyOne, copyTwo].sort()[0]);
});

test("a sparse cone materializes only its directories and survives archive and restore", (t) => {
  // Measured on this host, a cone over one of twenty directories cut a
  // 3000-file checkout from 1529 ms to 191 ms (issue #10). What this test
  // pins is the semantics, not the speed: the cone must change which files
  // are present and nothing else about the workspace.
  const { repo } = makeRepo(t);
  for (const area of ["alpha", "beta", "gamma"]) {
    for (let i = 0; i < 3; i += 1) {
      write(repo, `${area}/file${i}.txt`, `${area} ${i}\n`);
    }
  }
  write(repo, "root.txt", "root\n");
  git(repo, "add", ".");
  vlab(repo, "commit", "-m", "fixture");
  vlab(repo, "init");

  const full = JSON.parse(vlab(repo, "workspace", "create", "full-ws"));
  const coned = JSON.parse(
    vlab(repo, "workspace", "create", "coned-ws", "--cone", "alpha,gamma"),
  );

  assert.equal(full.cone, null, "a workspace without --cone records no cone");
  assert.deepEqual(coned.cone, ["alpha", "gamma"], "cone is normalized and sorted");

  const present = (workspacePath, relative) =>
    fs.existsSync(path.join(workspacePath, relative));

  // The full workspace has every area; the coned one has only its own.
  for (const area of ["alpha", "beta", "gamma"]) {
    assert.equal(present(full.path, `${area}/file0.txt`), true, `full has ${area}`);
  }
  assert.equal(present(coned.path, "alpha/file0.txt"), true, "cone has alpha");
  assert.equal(present(coned.path, "gamma/file0.txt"), true, "cone has gamma");
  assert.equal(present(coned.path, "beta/file0.txt"), false, "cone excludes beta");
  assert.equal(present(coned.path, "root.txt"), true, "cone mode keeps root files");

  // Identity, branch, base, and lifecycle are unaffected by the cone: Git
  // still has the whole tree, only the working tree is narrowed.
  assert.equal(coned.baseSnapshot, full.baseSnapshot);
  assert.equal(coned.compatibilityBranch, "vlab/ws/coned-ws");
  assert.equal(coned.lifecycle, "active");
  assert.equal(
    git(repo, "rev-parse", `${coned.compatibilityBranch}^{tree}`),
    git(repo, "rev-parse", `${full.compatibilityBranch}^{tree}`),
    "both branches point at the same complete tree",
  );

  // A checkpoint of a coned workspace still captures the whole tree, not just
  // the materialized part; the cone is a working-tree view, not a truncation.
  const checkpoint = JSON.parse(
    vlab(coned.path, "workspace", "checkpoint", "--label", "coned"),
  );
  assert.equal(checkpoint.workspaceName, "coned-ws");
  assert.equal(
    checkpoint.tree,
    git(repo, "rev-parse", "HEAD^{tree}"),
    "the checkpoint tree is the full tree",
  );

  // Archive and restore must reapply the cone rather than silently writing
  // every file back.
  vlab(repo, "workspace", "archive", "coned-ws");
  const restored = JSON.parse(vlab(repo, "workspace", "restore", "coned-ws"));
  assert.deepEqual(restored.cone, ["alpha", "gamma"], "restore keeps the cone");
  assert.equal(present(restored.path, "alpha/file0.txt"), true, "restored has alpha");
  assert.equal(present(restored.path, "beta/file0.txt"), false, "restored still excludes beta");

  // The cone is reversible in place with stock Git, leaving a full checkout.
  git(restored.path, "sparse-checkout", "disable");
  assert.equal(present(restored.path, "beta/file0.txt"), true, "disable restores the full tree");

  // A cone that escapes the repository is refused rather than handed to Git.
  const escaping = vlabResult(repo, "workspace", "create", "bad-ws", "--cone", "../outside");
  assert.notEqual(escaping.status, 0);
  assert.match(escaping.stderr, /must stay inside the repository/);
});

test("workspace create records the declared owner and focus", (t) => {
  const { repo } = makeRepo(t);
  write(repo, "base.txt", "base\n");
  git(repo, "add", ".");
  vlab(repo, "commit", "-m", "base");
  vlab(repo, "init");
  const head = git(repo, "rev-parse", "HEAD");

  const declared = JSON.parse(
    vlab(
      repo,
      "workspace",
      "create",
      "agent-seven",
      "--owner",
      "agent-seven@example.test",
      "--focus",
      "spec merge for checkout",
      "--json",
    ),
  );
  assert.equal(declared.schema, "vcs-lab.workspace/v1");
  assert.equal(declared.owner, "agent-seven@example.test");
  assert.equal(declared.focus, "spec merge for checkout");
  assert.equal(declared.compatibilityBranch, "vlab/ws/agent-seven");
  assert.equal(declared.baseSnapshot, head);
  assert.equal(declared.lifecycle, "active");

  // Neither flag is required, and an undeclared value is null rather than
  // absent or guessed.
  const anonymous = JSON.parse(vlab(repo, "workspace", "create", "unowned", "--json"));
  assert.equal(anonymous.owner, null);
  assert.equal(anonymous.focus, null);

  // The declarations are persisted in the registry and reported by the
  // listing exactly as given.
  const listed = new Map(
    JSON.parse(vlab(repo, "workspace", "list", "--json"))
      .map((workspace) => [workspace.name, workspace]),
  );
  assert.equal(listed.get("agent-seven").owner, "agent-seven@example.test");
  assert.equal(listed.get("agent-seven").focus, "spec merge for checkout");
  assert.equal(listed.get("agent-seven").status, "active");
  assert.equal(listed.get("unowned").owner, null);
  assert.equal(listed.get("unowned").focus, null);
  const registry = JSON.parse(readText(repo, ".git/vcs-lab/workspaces.json"));
  const stored = registry.workspaces.find((workspace) => workspace.name === "agent-seven");
  assert.equal(stored.owner, "agent-seven@example.test");
  assert.equal(stored.focus, "spec merge for checkout");

  // Git sees the same worktree and branch whether or not an owner was named:
  // owner and focus are vcs-lab facts, not Git ones.
  const worktreePaths = git(repo, "worktree", "list", "--porcelain")
    .split(/\r?\n/)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => path.resolve(line.slice("worktree ".length)));
  for (const workspace of [declared, anonymous]) {
    assert.ok(
      worktreePaths.includes(path.resolve(workspace.path)),
      `${workspace.name} is a registered worktree`,
    );
    assert.equal(git(repo, "rev-parse", workspace.compatibilityBranch), head);
    assert.equal(git(workspace.path, "status", "--porcelain=v1"), "");
  }
  assert.equal(git(repo, "status", "--porcelain=v1"), "");
});

test("workspace lifecycle preserves identity and checkpoints across move, archive, repair, and prune", (t) => {
  const { repo, parent } = makeRepo(t);
  write(repo, "base.txt", "base\n");
  git(repo, "add", ".");
  vlab(repo, "commit", "-m", "base");
  vlab(repo, "init");

  const workspacePath = path.join(parent, "agent-workspace");
  const workspace = JSON.parse(
    vlab(repo, "workspace", "create", "agent-one", "--path", workspacePath, "--json"),
  );
  write(workspacePath, "draft.txt", "unpublished\n");
  const before = git(workspacePath, "status", "--porcelain=v1");
  const checkpoint = JSON.parse(
    vlab(workspacePath, "workspace", "checkpoint", "--label", "agent handoff", "--json"),
  );
  const after = git(workspacePath, "status", "--porcelain=v1");
  const firstCheckpointRef = git(repo, "rev-parse", checkpoint.ref);

  assert.equal(workspace.name, "agent-one");
  assert.equal(before, after);
  assert.match(after, /\?\? draft\.txt/);
  const captured = git(workspacePath, "ls-tree", "-r", "--name-only", checkpoint.id);
  assert.match(captured, /draft\.txt/);
  assert.equal(checkpoint.baseHead, git(workspacePath, "rev-parse", "HEAD"));
  assert.match(checkpoint.draftChangeId, /^draft_[0-9a-f]{64}$/);
  assert.match(
    git(repo, "show", "-s", "--format=%B", checkpoint.id),
    /^agent handoff\r?\n\r?\nChange-Id:/,
  );

  const movedPath = path.join(parent, "agent-workspace-moved");
  const moved = JSON.parse(
    vlab(repo, "workspace", "move", "agent-one", movedPath, "--json"),
  );
  assert.equal(moved.id, workspace.id);
  assert.equal(moved.path, movedPath);
  assert.equal(moved.status, "active");
  assert.equal(readText(movedPath, "draft.txt"), "unpublished\n");
  assert.equal(git(movedPath, "status", "--porcelain=v1"), before);
  assert.equal(git(repo, "rev-parse", checkpoint.ref), firstCheckpointRef);

  const dirtyArchive = vlabResult(repo, "workspace", "archive", "agent-one");
  assert.notEqual(dirtyArchive.status, 0);
  assert.match(dirtyArchive.stderr, /tracked or untracked changes/i);
  assert.equal(fs.existsSync(movedPath), true);

  git(movedPath, "add", "draft.txt");
  vlab(movedPath, "commit", "-m", "publish draft", "--json");
  write(movedPath, ".gitignore", "ignored.log\n");
  git(movedPath, "add", ".gitignore");
  vlab(movedPath, "commit", "-m", "ignore local log", "--json");
  write(movedPath, "ignored.log", "local only\n");

  const ignoredArchive = vlabResult(repo, "workspace", "archive", "agent-one");
  assert.notEqual(ignoredArchive.status, 0);
  assert.match(ignoredArchive.stderr, /contains ignored files/i);
  fs.rmSync(path.join(movedPath, "ignored.log"));

  const secondCheckpoint = JSON.parse(
    vlab(movedPath, "workspace", "checkpoint", "--label", "published state", "--json"),
  );
  assert.equal(secondCheckpoint.previousCheckpoint, checkpoint.id);
  assert.equal(git(repo, "rev-parse", secondCheckpoint.historyRef), checkpoint.id);
  assert.equal(git(repo, "rev-parse", secondCheckpoint.ref), secondCheckpoint.id);

  const archived = JSON.parse(
    vlab(repo, "workspace", "archive", "agent-one", "--json"),
  );
  assert.equal(archived.id, workspace.id);
  assert.equal(archived.lifecycle, "archived");
  assert.equal(archived.status, "archived");
  assert.equal(fs.existsSync(movedPath), false);
  assert.equal(git(repo, "rev-parse", checkpoint.ref), secondCheckpoint.id);
  assert.equal(git(repo, "rev-parse", secondCheckpoint.historyRef), checkpoint.id);
  assert.equal(
    git(repo, "rev-parse", `refs/heads/${workspace.compatibilityBranch}`),
    archived.lastHead,
  );
  const archivedValidation = JSON.parse(
    vlab(repo, "metadata", "validate", "--json"),
  );
  assert.equal(archivedValidation.summary.valid, true);
  assert.equal(archivedValidation.summary.warnings, 0);

  const restoredPath = path.join(parent, "agent-workspace-restored");
  const restored = JSON.parse(
    vlab(
      repo,
      "workspace",
      "restore",
      "agent-one",
      "--path",
      restoredPath,
      "--json",
    ),
  );
  assert.equal(restored.id, workspace.id);
  assert.equal(restored.lifecycle, "active");
  assert.equal(restored.path, restoredPath);
  assert.equal(restored.compatibilityBranch, workspace.compatibilityBranch);
  assert.equal(git(repo, "rev-parse", checkpoint.ref), secondCheckpoint.id);

  const repairedPath = path.join(parent, "agent-workspace-repaired");
  fs.renameSync(restoredPath, repairedPath);
  assert.equal(
    JSON.parse(vlab(repo, "workspace", "list", "--json"))[0].status,
    "missing",
  );
  const repaired = JSON.parse(
    vlab(
      repo,
      "workspace",
      "repair",
      "agent-one",
      "--path",
      repairedPath,
      "--json",
    ),
  );
  assert.equal(repaired.id, workspace.id);
  assert.equal(repaired.status, "active");
  assert.equal(repaired.path, repairedPath);
  assert.equal(git(repairedPath, "branch", "--show-current"), workspace.compatibilityBranch);

  git(repo, "worktree", "remove", repairedPath);
  const preview = JSON.parse(
    vlab(repo, "workspace", "prune", "--dry-run", "--json"),
  );
  assert.equal(preview.dryRun, true);
  assert.equal(preview.count, 1);
  assert.equal(
    JSON.parse(vlab(repo, "workspace", "list", "--json"))[0].lifecycle,
    "active",
  );
  const pruned = JSON.parse(
    vlab(repo, "workspace", "prune", "--apply", "--json"),
  );
  assert.equal(pruned.changed, true);
  assert.equal(pruned.count, 1);
  const prunedWorkspace = JSON.parse(
    vlab(repo, "workspace", "list", "--json"),
  )[0];
  assert.equal(prunedWorkspace.lifecycle, "archived");
  assert.equal(
    prunedWorkspace.lastHead,
    git(repo, "rev-parse", `refs/heads/${workspace.compatibilityBranch}`),
  );
  assert.equal(git(repo, "rev-parse", checkpoint.ref), secondCheckpoint.id);

  const finalPath = path.join(parent, "agent-workspace-final");
  const finalRestore = JSON.parse(
    vlab(repo, "workspace", "restore", "agent-one", "--path", finalPath, "--json"),
  );
  assert.equal(finalRestore.id, workspace.id);
  assert.equal(finalRestore.status, "active");
  assert.equal(git(finalPath, "branch", "--show-current"), workspace.compatibilityBranch);
});

test("annotated Markdown keeps stable block IDs across edits and moves", (t) => {
  const { repo } = makeRepo(t);
  write(repo, "README.md", "base\n");
  git(repo, "add", ".");
  vlab(repo, "commit", "-m", "base");
  vlab(repo, "init");

  write(
    repo,
    "docs/spec.md",
    "# Checkout\n\nREQ-CHECKOUT-1: Orders must be idempotent.\n\n## Errors\n\nReturn a typed error.\n",
  );
  const first = JSON.parse(vlab(repo, "spec", "index", "docs/spec.md", "--json"));
  const ids = new Map(first.manifest.blocks.map((block) => [block.semanticKey, block.id]));

  write(
    repo,
    "docs/spec.md",
    "Intro text.\n\n# Checkout\n\nREQ-CHECKOUT-1: Orders must remain idempotent across retries.\n\n## Errors\n\nReturn a typed error.\n",
  );
  const second = JSON.parse(vlab(repo, "spec", "index", "docs/spec.md", "--json"));
  for (const block of second.manifest.blocks) {
    if (ids.has(block.semanticKey)) {
      assert.equal(block.id, ids.get(block.semanticKey));
    }
  }
  assert.equal(second.manifest.schema, "vcs-lab.spec-manifest/v3");
  assert.equal(second.cacheHit, false);
  assert.ok(second.changes.changed.length >= 1);
  assert.ok(second.changes.moved.length >= 1);

  const manifestBefore = fs.readFileSync(second.manifestPath, "utf8");
  const stored = JSON.parse(manifestBefore);
  assert.equal(stored.schema, "vcs-lab.spec-manifest/v3");
  assert.equal(Object.hasOwn(stored, "blocks"), false);
  assert.equal(stored.entityCount, second.manifest.blocks.length);
  const third = JSON.parse(vlab(repo, "spec", "index", "docs/spec.md", "--json"));
  assert.equal(third.cacheHit, true);
  assert.equal(third.written, false);
  assert.equal(fs.readFileSync(second.manifestPath, "utf8"), manifestBefore);
});

test("spec index --force rebuilds a manifest the caches would have kept", (t) => {
  const { repo } = makeRepo(t);
  write(repo, "base.txt", "base\n");
  git(repo, "add", ".");
  vlab(repo, "commit", "-m", "base");
  vlab(repo, "init");
  write(
    repo,
    "docs/spec.md",
    "# Checkout\n\nREQ-CHECKOUT-1: Orders must be idempotent.\n\n## Errors\n\nReturn a typed error.\n",
  );

  const first = JSON.parse(vlab(repo, "spec", "index", "docs/spec.md", "--json"));
  assert.equal(first.cacheHit, false);
  assert.equal(first.written, true);
  const manifestBefore = fs.readFileSync(first.manifestPath, "utf8");
  const blockIds = first.manifest.blocks.map((block) => block.id);
  assert.ok(blockIds.length >= 2);
  assert.doesNotThrow(() => git(repo, "cat-file", "-e", first.manifest.sourceBlob));

  // Unchanged Markdown is a cache hit that writes nothing.
  const cached = JSON.parse(vlab(repo, "spec", "index", "docs/spec.md", "--json"));
  assert.equal(cached.cacheHit, true);
  assert.equal(cached.written, false);

  // --force reads and rebuilds anyway, and because the content is the same
  // the rebuilt manifest is byte-identical: the same IDs, the same blob, and
  // every block reported unchanged.
  const forced = JSON.parse(
    vlab(repo, "spec", "index", "docs/spec.md", "--force", "--json"),
  );
  assert.equal(forced.cacheHit, false);
  assert.equal(forced.cacheMode, null);
  assert.equal(forced.contentRead, true);
  assert.equal(forced.written, true);
  assert.deepEqual(forced.manifest.blocks.map((block) => block.id), blockIds);
  assert.deepEqual(forced.changes, {
    added: [],
    removed: [],
    changed: [],
    moved: [],
    unchanged: blockIds,
  });
  assert.equal(forced.manifest.sourceBlob, first.manifest.sourceBlob);
  assert.equal(fs.readFileSync(forced.manifestPath, "utf8"), manifestBefore);

  // The batch form behaves the same: nothing served from the blob or hash
  // caches, every manifest rewritten, and a committed tree left clean.
  git(repo, "add", ".");
  vlab(repo, "commit", "-m", "spec and manifest");
  const batchCached = JSON.parse(vlab(repo, "spec", "index", "--all", "--json"));
  assert.equal(batchCached.files, 1);
  assert.equal(batchCached.cacheHits, 1);
  assert.equal(batchCached.manifestsWritten, 0);
  const batchForced = JSON.parse(
    vlab(repo, "spec", "index", "--all", "--force", "--json"),
  );
  assert.equal(batchForced.files, 1);
  assert.equal(batchForced.cacheHits, 0);
  assert.equal(batchForced.blobCacheHits, 0);
  assert.equal(batchForced.contentReads, 1);
  assert.equal(batchForced.manifestsWritten, 1);
  assert.deepEqual(batchForced.changes, {
    added: 0,
    removed: 0,
    changed: 0,
    moved: 0,
    unchanged: blockIds.length,
  });
  assert.equal(git(repo, "status", "--porcelain=v1"), "");
});

test("v2 manifests migrate to sparse v3 without changing logical IDs", (t) => {
  const { repo } = makeRepo(t);
  write(repo, "docs/legacy.md", "# Legacy\n\nREQ-LEGACY-1: Preserve this identity.\n");
  const indexed = JSON.parse(
    vlab(repo, "spec", "index", "docs/legacy.md", "--json"),
  );
  const legacyBlocks = indexed.manifest.blocks.map((block, index) => ({
    ...block,
    id: index === 0 ? "ent_legacy_preserved_identity" : block.id,
  }));
  const legacy = {
    schema: "vcs-lab.spec-manifest/v2",
    artifactId: indexed.manifest.artifactId,
    source: indexed.manifest.source,
    sourceHash: indexed.manifest.sourceHash,
    sourceBytes: indexed.manifest.sourceBytes,
    sourceLines: indexed.manifest.sourceLines,
    representation: indexed.manifest.representation,
    parser: indexed.manifest.parser,
    blocks: legacyBlocks,
  };
  fs.writeFileSync(indexed.manifestPath, `${JSON.stringify(legacy, null, 2)}\n`);

  const migrated = JSON.parse(
    vlab(repo, "spec", "index", "docs/legacy.md", "--json"),
  );
  assert.equal(migrated.migratedFrom, "vcs-lab.spec-manifest/v2");
  assert.deepEqual(
    migrated.manifest.blocks.map((block) => block.id),
    legacyBlocks.map((block) => block.id),
  );
  const stored = JSON.parse(fs.readFileSync(indexed.manifestPath, "utf8"));
  assert.equal(stored.schema, "vcs-lab.spec-manifest/v3");
  assert.equal(Object.hasOwn(stored, "blocks"), false);
  assert.equal(
    stored.idOverrides[legacyBlocks[0].semanticKey],
    "ent_legacy_preserved_identity",
  );
});

test("forecast deterministically merges independent specification blocks", (t) => {
  const { repo } = makeRepo(t);
  createIndexedSpecDivergence(repo);
  const before = {
    head: git(repo, "rev-parse", "HEAD"),
    status: git(repo, "status", "--porcelain=v1"),
  };
  const idsBefore = new Map(
    JSON.parse(vlab(repo, "spec", "show", "docs/spec.md", "--json"))
      .manifest.blocks.map((block) => [block.semanticKey, block.id]),
  );

  // This scenario compares the object session with ordinary Git, so the
  // forecast engine is pinned to the worktree simulator in both runs.
  const forecast = JSON.parse(
    vlab(repo, "forecast", "feature", "--git-session", "--forecast-engine", "worktree", "--json"),
  );
  assert.equal(forecast.schema, "vcs-lab.forecast/v2");
  assert.equal(forecast.status, "complete");
  assert.equal(forecast.counts.semanticSpec, 1);
  assert.equal(forecast.counts.exactResolution, 0);
  assert.equal(forecast.steps[0].outcome, "semantic-spec-merge");
  assert.equal(forecast.approvedSpecMerges.length, 1);
  assert.deepEqual(forecast.steps[0].semanticMerges[0].counts, {
    "theirs-edit": 1,
    "ours-edit": 1,
  });
  assert.ok(forecast.timings.phases.planningMs >= 0);
  assert.ok(forecast.timings.worktree.applicationMs >= 0);
  assert.ok(forecast.timings.git.count > 0);
  assert.ok(forecast.timings.git.sessionQueries > 0);
  assert.ok(forecast.timings.git.processes < forecast.timings.git.count);
  assert.equal(git(repo, "rev-parse", "HEAD"), before.head);
  assert.equal(git(repo, "status", "--porcelain=v1"), before.status);

  const fallback = JSON.parse(
    vlab(repo, "forecast", "feature", "--no-git-session", "--forecast-engine", "worktree", "--json"),
  );
  assert.equal(fallback.predictedResultTree, forecast.predictedResultTree);
  assert.deepEqual(fallback.plan.changes, forecast.plan.changes);
  assert.equal(fallback.timings.git.sessionQueries, 0);
  assert.equal(fallback.timings.git.processes, fallback.timings.git.count);
  assert.ok(forecast.timings.git.processes < fallback.timings.git.processes);

  const result = JSON.parse(
    vlab(
      repo,
      "reconcile",
      "feature",
      "--use-forecast",
      forecast.id,
      "--git-session",
      "--json",
    ),
  );
  assert.equal(result.receipt.schema, "vcs-lab.reconciliation/v6");
  assert.equal(result.receipt.resultTree, forecast.predictedResultTree);
  assert.equal(result.receipt.applied[0].semanticMerges.length, 1);
  assert.equal(
    result.receipt.applied[0].semanticMerges[0].selectionMethod,
    "forecast-batch",
  );
  assert.equal(result.receipt.applied[0].semanticMerges[0].decision, "accepted");
  assert.ok(
    result.receipt.timings.git.count <= 10,
    JSON.stringify(result.receipt.timings.git, null, 2),
  );
  assert.ok(
    result.receipt.timings.git.processes < result.receipt.timings.git.count,
    JSON.stringify(result.receipt.timings.git, null, 2),
  );
  assert.equal(
    readText(repo, "docs/spec.md"),
    "# Alpha\n\nsource alpha\n\n# Beta\n\ntarget beta\n",
  );
  const storedResultManifest = JSON.parse(
    fs.readFileSync(path.join(repo, ".vcs-lab/specs/docs/spec.md.json"), "utf8"),
  );
  assert.equal(
    storedResultManifest.sourceBlob,
    git(repo, "rev-parse", "HEAD:docs/spec.md"),
  );
  const indexedBatch = JSON.parse(
    vlab(repo, "spec", "index", "--all", "--json"),
  );
  assert.equal(indexedBatch.blobCacheHits, 1);
  assert.equal(indexedBatch.contentReads, 0);
  const indexed = JSON.parse(vlab(repo, "spec", "show", "docs/spec.md", "--json"));
  for (const block of indexed.manifest.blocks) {
    assert.equal(block.id, idsBefore.get(block.semanticKey));
  }
  assert.equal(git(repo, "status", "--porcelain=v1"), "");
});

test("same-block specification edits remain an explicit forecast blocker", (t) => {
  const { repo } = makeRepo(t);
  const { base, source, target } = createIndexedSpecDivergence(repo, {
    sameBlock: true,
  });
  const forecast = JSON.parse(vlab(repo, "forecast", "feature", "--json"));
  assert.equal(forecast.status, "blocked");
  assert.equal(forecast.blockedReason, "semantic-spec-conflict");
  const semantic = forecast.steps[0].conflicts.find(
    (conflict) => conflict.semanticSpec,
  ).semanticSpec;
  assert.equal(semantic.status, "blocked");
  assert.equal(semantic.conflicts[0].type, "same-block-edit");
  assert.equal(git(repo, "status", "--porcelain=v1"), "");

  const direct = JSON.parse(
    vlab(
      repo,
      "spec",
      "merge-plan",
      "docs/spec.md",
      base.commit,
      target.commit,
      source.commit,
      "--json",
    ),
  );
  assert.equal(direct.status, "blocked");
  assert.equal(direct.conflicts[0].type, "same-block-edit");
});

test("spec merge combines a block move with an edit but blocks delete versus edit", (t) => {
  const { repo } = makeRepo(t);
  write(
    repo,
    "docs/spec.md",
    "# Alpha\n\nbase alpha\n\n# Beta\n\nbase beta\n\n# Gamma\n\nbase gamma\n",
  );
  vlab(repo, "spec", "index", "docs/spec.md");
  git(repo, "add", ".");
  const base = JSON.parse(vlab(repo, "commit", "-m", "base blocks"));

  git(repo, "switch", "-c", "feature", base.commit);
  write(
    repo,
    "docs/spec.md",
    "# Alpha\n\nbase alpha\n\n# Beta\n\nsource beta\n\n# Gamma\n\nbase gamma\n",
  );
  vlab(repo, "spec", "index", "docs/spec.md");
  git(repo, "add", ".");
  const source = JSON.parse(vlab(repo, "commit", "-m", "edit beta"));

  git(repo, "switch", "-c", "target-move", base.commit);
  write(
    repo,
    "docs/spec.md",
    "# Beta\n\nbase beta\n\n# Alpha\n\nbase alpha\n\n# Gamma\n\nbase gamma\n",
  );
  vlab(repo, "spec", "index", "docs/spec.md");
  git(repo, "add", ".");
  const moved = JSON.parse(vlab(repo, "commit", "-m", "move beta"));
  const movePlan = JSON.parse(
    vlab(
      repo,
      "spec",
      "merge-plan",
      "docs/spec.md",
      base.commit,
      moved.commit,
      source.commit,
      "--json",
    ),
  );
  assert.equal(movePlan.status, "clean");
  assert.equal(movePlan.ordering.decision, "ours-move");
  assert.match(movePlan.result.markdown, /^# Beta\n\nsource beta/);

  git(repo, "switch", "-c", "target-delete", base.commit);
  write(
    repo,
    "docs/spec.md",
    "# Alpha\n\nbase alpha\n\n# Gamma\n\nbase gamma\n",
  );
  vlab(repo, "spec", "index", "docs/spec.md");
  git(repo, "add", ".");
  const deleted = JSON.parse(vlab(repo, "commit", "-m", "delete beta"));
  const deletePlan = JSON.parse(
    vlab(
      repo,
      "spec",
      "merge-plan",
      "docs/spec.md",
      base.commit,
      deleted.commit,
      source.commit,
      "--json",
    ),
  );
  assert.equal(deletePlan.status, "blocked");
  assert.equal(deletePlan.conflicts[0].type, "delete-vs-edit");
});

test("ordinary unindexed Markdown conflicts still produce a conservative forecast", (t) => {
  const { repo } = makeRepo(t);
  write(repo, "docs.md", "base\n");
  git(repo, "add", "docs.md");
  const base = JSON.parse(vlab(repo, "commit", "-m", "base markdown"));
  vlab(repo, "init");
  git(repo, "switch", "-c", "feature", base.commit);
  write(repo, "docs.md", "source\n");
  git(repo, "add", "docs.md");
  vlab(repo, "commit", "-m", "source markdown");
  git(repo, "switch", "main");
  write(repo, "docs.md", "target\n");
  git(repo, "add", "docs.md");
  vlab(repo, "commit", "-m", "target markdown");

  const forecast = JSON.parse(vlab(repo, "forecast", "feature", "--json"));
  assert.equal(forecast.status, "blocked");
  assert.equal(
    forecast.blockedReason,
    "semantic-spec-metadata-unavailable",
  );
  const semantic = forecast.steps[0].conflicts.find(
    (conflict) => conflict.path === "docs.md",
  ).semanticSpec;
  assert.equal(semantic.conflicts[0].type, "semantic-metadata-unavailable");
  assert.equal(git(repo, "status", "--porcelain=v1"), "");
});

test("a paused reconciliation can explicitly apply a deterministic spec merge", (t) => {
  const { repo } = makeRepo(t);
  createIndexedSpecDivergence(repo);
  const attempt = vlabResult(repo, "reconcile", "feature");
  assert.notEqual(attempt.status, 0);
  assert.match(attempt.stderr, /deterministic spec merge/i);

  const status = JSON.parse(vlab(repo, "spec", "status", "--json"));
  assert.equal(status.active, true);
  assert.equal(status.plans[0].status, "clean");
  assert.deepEqual(status.plans[0].counts, {
    "theirs-edit": 1,
    "ours-edit": 1,
  });
  const applied = JSON.parse(
    vlab(repo, "spec", "resolve", "--all", "--json"),
  );
  assert.equal(applied.applied.length, 1);
  assert.doesNotMatch(git(repo, "status", "--porcelain=v1"), /^UU|^AA|^DU|^UD/m);

  const result = JSON.parse(vlab(repo, "reconcile", "--continue", "--json"));
  assert.equal(result.receipt.applied[0].resolutions.length, 0);
  assert.equal(
    result.receipt.applied[0].semanticMerges[0].selectionMethod,
    "explicit-spec-merge",
  );
  assert.equal(result.receipt.applied[0].semanticMerges[0].decision, "accepted");
  assert.equal(JSON.parse(vlab(repo, "resolve", "list", "--json")).length, 0);
  assert.equal(git(repo, "status", "--porcelain=v1"), "");
});

test("an edited semantic suggestion requires reindexing and is audited as modified", (t) => {
  const { repo } = makeRepo(t);
  createIndexedSpecDivergence(repo);
  assert.notEqual(vlabResult(repo, "reconcile", "feature").status, 0);
  vlab(repo, "spec", "resolve", "--all", "--json");
  write(
    repo,
    "docs/spec.md",
    "# Alpha\n\nsource alpha\n\n# Beta\n\nhuman-adjusted beta\n",
  );
  git(repo, "add", "docs/spec.md");
  const stale = vlabResult(repo, "reconcile", "--continue");
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /manifest.*stale/i);

  vlab(repo, "spec", "index", "docs/spec.md", "--json");
  git(repo, "add", "docs/spec.md", ".vcs-lab/specs/docs/spec.md.json");
  const result = JSON.parse(vlab(repo, "reconcile", "--continue", "--json"));
  const merge = result.receipt.applied[0].semanticMerges[0];
  assert.equal(merge.decision, "modified");
  assert.notEqual(merge.actualMarkdownHash, merge.resultMarkdownHash);
  assert.notEqual(merge.actualManifestHash, merge.resultManifestHash);
  assert.equal(git(repo, "status", "--porcelain=v1"), "");
});

test("semantic spec forecasts are stable with checkout-time CRLF conversion", (t) => {
  const { repo } = makeRepo(t);
  git(repo, "config", "core.autocrlf", "true");
  createIndexedSpecDivergence(repo);
  const forecast = JSON.parse(vlab(repo, "forecast", "feature", "--json"));
  assert.equal(forecast.status, "complete");
  assert.equal(forecast.counts.semanticSpec, 1);
  const result = JSON.parse(
    vlab(
      repo,
      "reconcile",
      "feature",
      "--use-forecast",
      forecast.id,
      "--json",
    ),
  );
  assert.equal(result.receipt.resultTree, forecast.predictedResultTree);
  assert.equal(git(repo, "status", "--porcelain=v1"), "");
});

test("batch spec indexing skips unchanged manifests and measures generated corpora", (t) => {
  const { repo } = makeRepo(t);
  write(repo, "docs/one.md", "# One\n\nFirst body.\n");
  write(repo, "docs/two.md", "# Two\n\nSecond body.\n");
  const cold = JSON.parse(vlab(repo, "spec", "index", "--all", "--json"));
  assert.equal(cold.files, 2);
  assert.equal(cold.cacheHits, 0);
  assert.equal(cold.manifestsWritten, 2);
  const unchanged = JSON.parse(
    vlab(repo, "spec", "index", "--all", "--json"),
  );
  assert.equal(unchanged.cacheHits, 2);
  assert.equal(unchanged.manifestsWritten, 0);
  assert.equal(unchanged.contentReads, 0);
  assert.equal(unchanged.blobCacheHits, 2);

  write(repo, "docs/two.md", "# Two\n\nSecond body changed.\n");
  const incremental = JSON.parse(
    vlab(repo, "spec", "index", "--all", "--json"),
  );
  assert.equal(incremental.cacheHits, 1);
  assert.equal(incremental.manifestsWritten, 1);
  assert.equal(incremental.contentReads, 1);
  assert.equal(incremental.blobCacheHits, 1);
  assert.equal(incremental.changes.changed, 1);

  const benchmark = JSON.parse(
    vlab(
      repo,
      "spec",
      "benchmark",
      "--documents",
      "2",
      "--blocks",
      "3",
      "--json",
    ),
  );
  assert.equal(benchmark.documents, 2);
  assert.equal(benchmark.blocksPerDocument, 3);
  assert.equal(benchmark.unchanged.cacheHits, 2);
  assert.equal(benchmark.unchanged.manifestsWritten, 0);
  assert.equal(benchmark.oneBlockChanged.manifestsWritten, 1);
  assert.equal(benchmark.schema, "vcs-lab.spec-benchmark/v2");
  assert.equal(benchmark.manifestSchema, "vcs-lab.spec-manifest/v3");
  assert.equal(benchmark.unchanged.contentReads, 0);
  assert.equal(benchmark.unchanged.blobCacheHits, 2);
  assert.ok(benchmark.manifestBytes < benchmark.legacyV2EquivalentBytes);
  assert.ok(benchmark.metadataReductionPercent > 80);
});

test("heuristic candidates require explicit acceptance", (t) => {
  const { repo } = makeRepo(t);
  vlab(repo, "init");
  write(repo, "base.txt", "base\n");
  git(repo, "add", ".");
  vlab(repo, "commit", "-m", "base");
  git(repo, "switch", "-c", "left");
  write(repo, "same.txt", "same\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "left change");
  git(repo, "switch", "main");
  git(repo, "switch", "-c", "right");
  write(repo, "same.txt", "same\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "independent equivalent change");

  const plan = JSON.parse(vlab(repo, "merge-plan", "left", "--json"));
  assert.equal(
    plan.counts["candidate-equivalent"],
    1,
    JSON.stringify(plan, null, 2),
  );
  const attempt = spawnSync(process.execPath, [cli, "reconcile", "left"], {
    cwd: repo,
    encoding: "utf8",
    env: testEnv(),
  });
  assert.notEqual(attempt.status, 0);
  assert.match(attempt.stderr, /heuristic patch-equivalence candidates/i);

  const forecast = JSON.parse(vlab(repo, "forecast", "left", "--json"));
  assert.equal(forecast.status, "review-required");
  assert.equal(forecast.candidateDecisionRequired, true);
  assert.equal(forecast.predictedResultTree, null);
  const acceptedForecast = JSON.parse(
    vlab(repo, "forecast", "left", "--accept-candidates", "--json"),
  );
  assert.equal(acceptedForecast.status, "complete");
  assert.equal(acceptedForecast.candidateDecisionRequired, false);
});

test("conflicted reconciliation resumes across processes and records contextual application", (t) => {
  const { repo } = makeRepo(t);
  write(repo, "shared.txt", "base\n");
  git(repo, "add", ".");
  vlab(repo, "commit", "-m", "base");
  vlab(repo, "init");

  vlab(repo, "branch", "feature");
  write(repo, "shared.txt", "feature\n");
  git(repo, "add", "shared.txt");
  const source = JSON.parse(vlab(repo, "commit", "-m", "feature intent"));
  write(repo, "after.txt", "after conflict\n");
  git(repo, "add", "after.txt");
  const afterConflict = JSON.parse(
    vlab(repo, "commit", "-m", "feature follow-up"),
  );

  git(repo, "switch", "main");
  write(repo, "shared.txt", "main\n");
  git(repo, "add", "shared.txt");
  const target = JSON.parse(vlab(repo, "commit", "-m", "main intent"));

  const attempt = vlabResult(repo, "reconcile", "feature");
  assert.notEqual(attempt.status, 0);
  assert.match(attempt.stderr, /reconciliation paused/i);
  assert.match(attempt.stderr, /vlab reconcile --continue/);

  const status = JSON.parse(vlab(repo, "reconcile", "--status", "--json"));
  assert.equal(status.active, true);
  assert.equal(status.state, "conflicted");
  assert.equal(status.targetBefore, target.commit);
  assert.deepEqual(status.current.unresolvedPaths, ["shared.txt"]);
  assert.deepEqual(JSON.parse(vlab(repo, "receipts", "--json")), []);

  const premature = vlabResult(repo, "reconcile", "--continue");
  assert.notEqual(premature.status, 0);
  assert.match(premature.stderr, /unresolved paths/i);

  write(repo, "shared.txt", "contextual result\n");
  git(repo, "add", "shared.txt");
  const result = JSON.parse(vlab(repo, "reconcile", "--continue", "--json"));
  assert.equal(result.receipt.applied.length, 2);
  assert.equal(result.receipt.applied[0].sourceCommit, source.commit);
  assert.equal(result.receipt.applied[0].relation, "contextual-application");
  assert.deepEqual(result.receipt.applied[0].conflictedPaths, ["shared.txt"]);
  assert.equal(result.receipt.applied[1].sourceCommit, afterConflict.commit);
  assert.equal(result.receipt.applied[1].relation, "causal-reconciliation");
  assert.equal(result.receipt.exactStateEqualityAfter, false);
  assert.equal(readText(repo, "shared.txt"), "contextual result\n");
  assert.equal(readText(repo, "after.txt"), "after conflict\n");

  const idle = JSON.parse(vlab(repo, "reconcile", "--status", "--json"));
  assert.equal(idle.active, false);
  const plan = JSON.parse(vlab(repo, "merge-plan", "feature", "--json"));
  assert.equal(plan.counts.new, 0);
  assert.equal(plan.counts.covered, 2);

  const records = JSON.parse(vlab(repo, "receipts", "--json"));
  assert.equal(records.length, 4);
  const contextual = records.find(
    (record) => record.relation === "contextual-application",
  );
  assert.equal(contextual.originChangeId, source.changeId);
  assert.deepEqual(contextual.conflictedPaths, ["shared.txt"]);
  assert.equal(
    records.find((record) => record.type === "resolution").originalPath,
    "shared.txt",
  );
  assert.match(vlab(repo, "graph"), /contextual-application/);
});

test("aborting a mid-queue conflict restores the starting commit without receipts", (t) => {
  const { repo } = makeRepo(t);
  write(repo, "shared.txt", "base\n");
  git(repo, "add", ".");
  const base = JSON.parse(vlab(repo, "commit", "-m", "base"));
  vlab(repo, "init");

  vlab(repo, "branch", "feature");
  write(repo, "clean.txt", "first change\n");
  git(repo, "add", "clean.txt");
  vlab(repo, "commit", "-m", "clean first change");
  write(repo, "shared.txt", "feature\n");
  git(repo, "add", "shared.txt");
  vlab(repo, "commit", "-m", "conflicting second change");

  git(repo, "switch", "main");
  write(repo, "shared.txt", "main\n");
  git(repo, "add", "shared.txt");
  const target = JSON.parse(vlab(repo, "commit", "-m", "main conflict"));
  assert.notEqual(target.commit, base.commit);

  const attempt = vlabResult(repo, "reconcile", "feature");
  assert.notEqual(attempt.status, 0);
  const pending = JSON.parse(vlab(repo, "reconcile", "--status", "--json"));
  assert.equal(pending.progress.completed, 1);
  assert.equal(pending.progress.total, 2);
  assert.equal(fs.existsSync(path.join(repo, "clean.txt")), true);

  const aborted = JSON.parse(vlab(repo, "reconcile", "--abort", "--json"));
  assert.equal(aborted.aborted, true);
  assert.equal(aborted.restoredHead, target.commit);
  assert.equal(git(repo, "rev-parse", "HEAD"), target.commit);
  assert.equal(fs.existsSync(path.join(repo, "clean.txt")), false);
  assert.equal(git(repo, "status", "--porcelain=v1"), "");
  assert.deepEqual(JSON.parse(vlab(repo, "receipts", "--json")), []);
  assert.equal(
    JSON.parse(vlab(repo, "reconcile", "--status", "--json")).active,
    false,
  );
});

test("conflict continuation can explicitly fork logical identity", (t) => {
  const { repo } = makeRepo(t);
  write(repo, "shared.txt", "base\n");
  git(repo, "add", ".");
  vlab(repo, "commit", "-m", "base");
  vlab(repo, "init");

  vlab(repo, "branch", "feature");
  write(repo, "shared.txt", "feature\n");
  git(repo, "add", "shared.txt");
  const source = JSON.parse(vlab(repo, "commit", "-m", "source intent"));
  git(repo, "switch", "main");
  write(repo, "shared.txt", "main\n");
  git(repo, "add", "shared.txt");
  vlab(repo, "commit", "-m", "target intent");

  assert.notEqual(vlabResult(repo, "reconcile", "feature").status, 0);
  write(repo, "shared.txt", "materially different intent\n");
  git(repo, "add", "shared.txt");
  const result = JSON.parse(
    vlab(repo, "reconcile", "--continue", "--fork", "--json"),
  );
  const application = JSON.parse(vlab(repo, "receipts", "--json")).find(
    (record) => record.type === "application",
  );
  assert.equal(application.relation, "contextual-fork");
  assert.equal(application.originChangeId, source.changeId);
  assert.notEqual(application.appliedChangeId, source.changeId);
  assert.match(
    git(repo, "show", "-s", "--format=%B", result.receipt.resultCommit),
    new RegExp(`Derived-From: ${source.changeId}`),
  );

  const plan = JSON.parse(vlab(repo, "merge-plan", "feature", "--json"));
  assert.equal(plan.counts.new, 1);
  assert.equal(plan.counts.covered, 0);
});

test("pending reconciliations are isolated between linked worktrees", (t) => {
  const { repo, parent } = makeRepo(t);
  write(repo, "a.txt", "base a\n");
  write(repo, "b.txt", "base b\n");
  git(repo, "add", ".");
  vlab(repo, "commit", "-m", "base");
  vlab(repo, "init");

  git(repo, "switch", "-c", "feature-a");
  write(repo, "a.txt", "feature a\n");
  git(repo, "add", "a.txt");
  vlab(repo, "commit", "-m", "feature a");
  git(repo, "switch", "main");
  git(repo, "switch", "-c", "feature-b");
  write(repo, "b.txt", "feature b\n");
  git(repo, "add", "b.txt");
  vlab(repo, "commit", "-m", "feature b");
  git(repo, "switch", "main");
  write(repo, "a.txt", "main a\n");
  write(repo, "b.txt", "main b\n");
  git(repo, "add", ".");
  const target = JSON.parse(vlab(repo, "commit", "-m", "main changes"));

  const pathA = path.join(parent, "workspace-a");
  const pathB = path.join(parent, "workspace-b");
  vlab(repo, "workspace", "create", "agent-a", "--from", "main", "--path", pathA, "--json");
  vlab(repo, "workspace", "create", "agent-b", "--from", "main", "--path", pathB, "--json");

  assert.notEqual(vlabResult(pathA, "reconcile", "feature-a").status, 0);
  assert.notEqual(vlabResult(pathB, "reconcile", "feature-b").status, 0);
  const statusA = JSON.parse(vlab(pathA, "reconcile", "--status", "--json"));
  const statusB = JSON.parse(vlab(pathB, "reconcile", "--status", "--json"));
  assert.notEqual(statusA.operationId, statusB.operationId);
  assert.deepEqual(statusA.current.unresolvedPaths, ["a.txt"]);
  assert.deepEqual(statusB.current.unresolvedPaths, ["b.txt"]);

  write(pathA, "a.txt", "contextual a\n");
  git(pathA, "add", "a.txt");
  const completedA = JSON.parse(
    vlab(pathA, "reconcile", "--continue", "--json"),
  );
  assert.equal(completedA.receipt.applied[0].relation, "contextual-application");
  assert.equal(
    JSON.parse(vlab(pathA, "reconcile", "--status", "--json")).active,
    false,
  );
  assert.equal(
    JSON.parse(vlab(pathB, "reconcile", "--status", "--json")).active,
    true,
  );
  assert.match(vlab(pathB, "receipts"), /contextual-application/);
  assert.equal(JSON.parse(vlab(pathB, "reconcile", "--abort", "--json")).restoredHead, target.commit);
});

test("exact conflict resolutions are suggested and reused across worktrees", (t) => {
  const { repo, parent } = makeRepo(t);
  write(repo, "shared.txt", "base\n");
  git(repo, "add", "shared.txt");
  const base = JSON.parse(vlab(repo, "commit", "-m", "base"));
  vlab(repo, "init");

  git(repo, "switch", "-c", "source-one", base.commit);
  write(repo, "shared.txt", "source\n");
  git(repo, "add", "shared.txt");
  vlab(repo, "commit", "-m", "source one");
  git(repo, "switch", "-c", "target-one", base.commit);
  write(repo, "shared.txt", "target\n");
  git(repo, "add", "shared.txt");
  vlab(repo, "commit", "-m", "target one");

  assert.notEqual(vlabResult(repo, "reconcile", "source-one").status, 0);
  const firstStatus = JSON.parse(
    vlab(repo, "resolve", "status", "--json"),
  );
  assert.equal(firstStatus.conflicts[0].candidates.length, 0);
  const signature = firstStatus.conflicts[0].signature;
  write(repo, "shared.txt", "remembered resolution\n");
  git(repo, "add", "shared.txt");
  const firstResult = JSON.parse(
    vlab(repo, "reconcile", "--continue", "--json"),
  );
  assert.equal(
    firstResult.receipt.applied[0].resolutions[0].decision,
    "created",
  );
  const catalog = JSON.parse(vlab(repo, "resolve", "list", "--json"));
  assert.equal(catalog.length, 1);
  assert.equal(catalog[0].signature, signature);

  git(repo, "switch", "-c", "renamed-base", base.commit);
  git(repo, "mv", "shared.txt", "renamed.txt");
  const renamedBase = JSON.parse(
    vlab(repo, "commit", "-m", "rename shared file"),
  );
  git(repo, "switch", "-c", "source-two", renamedBase.commit);
  write(repo, "renamed.txt", "source\n");
  git(repo, "add", "renamed.txt");
  const sourceTwo = JSON.parse(vlab(repo, "commit", "-m", "source two"));
  git(repo, "switch", "-c", "target-two", renamedBase.commit);
  write(repo, "renamed.txt", "target\n");
  git(repo, "add", "renamed.txt");
  vlab(repo, "commit", "-m", "target two");

  const workspacePath = path.join(parent, "reuse-workspace");
  vlab(
    repo,
    "workspace",
    "create",
    "reuse-agent",
    "--from",
    "target-two",
    "--path",
    workspacePath,
    "--json",
  );
  assert.notEqual(
    vlabResult(workspacePath, "reconcile", "source-two").status,
    0,
  );
  const secondStatus = JSON.parse(
    vlab(workspacePath, "resolve", "status", "--json"),
  );
  assert.equal(secondStatus.conflicts[0].signature, signature);
  assert.equal(secondStatus.conflicts[0].path, "renamed.txt");
  assert.equal(secondStatus.conflicts[0].candidates.length, 1);
  assert.match(readText(workspacePath, "renamed.txt"), /<<<<<<< HEAD/);
  assert.match(vlab(workspacePath, "resolve", "status"), /candidates\s+1/);

  const applied = vlab(workspacePath, "resolve", "apply", "--all");
  assert.match(applied, /Applied 1 resolution suggestion/);
  assert.equal(readText(workspacePath, "renamed.txt"), "remembered resolution\n");
  assert.doesNotMatch(git(workspacePath, "status", "--porcelain=v1"), /^UU/);
  const summary = vlab(workspacePath, "reconcile", "--continue");
  assert.match(summary, /Reconciliation complete/);
  assert.match(summary, /1 accepted/);

  const records = JSON.parse(vlab(workspacePath, "receipts", "--json"));
  const reused = records.find(
    (record) =>
      record.type === "application" &&
      record.originChangeId === sourceTwo.changeId,
  );
  assert.equal(reused.resolutions[0].decision, "accepted");
  assert.equal(reused.resolutions[0].reusedResolutionId, catalog[0].id);
  assert.equal(
    JSON.parse(vlab(workspacePath, "resolve", "list", "--json")).length,
    1,
  );
  const graph = vlab(workspacePath, "graph");
  assert.match(graph, /contextual-application.*reconciliation 1 covered/);
  assert.doesNotMatch(graph, /reconcile; 1 covered/);
});

test("Git rerere never resolves or records a conflict inside vlab operations", (t) => {
  const { repo } = makeRepo(t);
  write(repo, "shared.txt", "one\ntwo\nthree\n");
  git(repo, "add", "shared.txt");
  const base = JSON.parse(vlab(repo, "commit", "-m", "base"));
  vlab(repo, "init");

  write(repo, "shared.txt", "one\nmain\nthree\n");
  git(repo, "add", "shared.txt");
  vlab(repo, "commit", "-m", "target edits line two");
  const mainHead = git(repo, "rev-parse", "HEAD");
  git(repo, "switch", "-c", "feature", base.commit);
  write(repo, "shared.txt", "one\nfeature\nthree\n");
  git(repo, "add", "shared.txt");
  const source = JSON.parse(vlab(repo, "commit", "-m", "source edits line two"));
  git(repo, "switch", "main");

  // Seed Git's own rerere cache with a resolution vlab never approved, then
  // put the target back so the same conflict replays.
  git(repo, "config", "rerere.enabled", "true");
  const seeded = spawnSync("git", ["cherry-pick", "-x", source.commit], {
    cwd: repo,
    encoding: "utf8",
    env: testEnv(),
  });
  assert.notEqual(seeded.status, 0);
  write(repo, "shared.txt", "one\nrerere\nthree\n");
  git(repo, "add", "shared.txt");
  git(repo, "-c", "core.editor=true", "cherry-pick", "--continue");
  git(repo, "reset", "--hard", mainHead);
  git(repo, "config", "--unset", "rerere.enabled");
  git(repo, "config", "rerere.autoUpdate", "true");
  const rrCache = path.join(repo, ".git", "rr-cache");
  const rrEntries = () => fs.readdirSync(rrCache);
  assert.equal(rrEntries().length, 1);
  const postimage = path.join(rrCache, rrEntries()[0], "postimage");
  assert.equal(fs.readFileSync(postimage, "utf8"), "one\nrerere\nthree\n");
  const rrState = () => ({
    entries: rrEntries().length,
    postimage: fs.readFileSync(postimage, "utf8"),
    mergeRr: fs.existsSync(path.join(repo, ".git", "MERGE_RR")),
    status: git(repo, "rerere", "status"),
  });
  const untouched = { entries: 1, postimage: "one\nrerere\nthree\n", mergeRr: false, status: "" };

  // Forecasts see the conflict itself, not Git's staged resolution, under
  // both engines.
  for (const engine of ["worktree", "merge-tree"]) {
    const forecast = forecastWithEngine(repo, engine, "forecast", "feature");
    assert.equal(forecast.status, "blocked", engine);
    assert.equal(forecast.blockedReason, "missing-exact-resolution", engine);
    assert.equal(forecast.steps[0].outcome, "blocked-conflict", engine);
    assert.equal(forecast.steps[0].conflicts[0].path, "shared.txt");
    assert.deepEqual(forecast.steps[0].conflicts[0].candidates, []);
    assert.equal(git(repo, "status", "--porcelain=v1"), "");
    assert.deepEqual(rrState(), untouched);
  }
  git(repo, "switch", "feature");
  const rebaseForecast = forecastWithEngine(repo, "worktree", "rebase-forecast", "main");
  assert.equal(rebaseForecast.status, "blocked");
  assert.equal(rebaseForecast.steps[0].outcome, "blocked-conflict");
  git(repo, "switch", "main");

  // A landing merge conflicts instead of committing Git's resolution.
  const landing = vlabResult(repo, "compact-merge", "feature");
  assert.notEqual(landing.status, 0);
  assert.match(landing.stderr, /produced conflicts/);
  assert.match(readText(repo, "shared.txt"), /<<<<<<< HEAD/);
  assert.doesNotMatch(readText(repo, "shared.txt"), /rerere/);
  git(repo, "merge", "--abort");
  assert.equal(git(repo, "rev-parse", "HEAD"), mainHead);
  assert.equal(git(repo, "status", "--porcelain=v1"), "");
  assert.deepEqual(rrState(), untouched);
  const squash = vlabResult(repo, "hard-squash", "feature");
  assert.notEqual(squash.status, 0);
  assert.match(squash.stderr, /produced conflicts/);
  assert.match(readText(repo, "shared.txt"), /<<<<<<< HEAD/);
  assert.doesNotMatch(readText(repo, "shared.txt"), /rerere/);
  git(repo, "reset", "--hard", mainHead);
  assert.equal(git(repo, "status", "--porcelain=v1"), "");
  assert.deepEqual(rrState(), untouched);

  // Direct cherry-picks, plain and forked, stop on the conflict too.
  for (const flags of [[], ["--fork"]]) {
    const picked = vlabResult(repo, "cherry-pick", source.commit, ...flags);
    assert.notEqual(picked.status, 0, flags.join(" "));
    assert.match(picked.stderr, /produced conflicts/);
    assert.match(git(repo, "status", "--porcelain=v1"), /^UU shared.txt/m);
    assert.match(readText(repo, "shared.txt"), /<<<<<<< HEAD/);
    assert.doesNotMatch(readText(repo, "shared.txt"), /rerere/);
    assert.deepEqual(rrState(), untouched);
    // A forked pick runs with --no-commit and leaves no pick in progress.
    if (fs.existsSync(path.join(repo, ".git", "CHERRY_PICK_HEAD"))) {
      git(repo, "cherry-pick", "--abort");
    } else {
      git(repo, "reset", "--hard", mainHead);
    }
    assert.equal(git(repo, "rev-parse", "HEAD"), mainHead);
    assert.equal(git(repo, "status", "--porcelain=v1"), "");
  }

  // The supervised rebase pauses on the conflict as well.
  git(repo, "switch", "feature");
  assert.notEqual(vlabResult(repo, "rebase", "main").status, 0);
  const pausedRebase = JSON.parse(vlab(repo, "rebase", "--status", "--json"));
  assert.equal(pausedRebase.state, "conflicted");
  assert.match(git(repo, "status", "--porcelain=v1"), /^UU shared.txt/m);
  assert.match(readText(repo, "shared.txt"), /<<<<<<< HEAD/);
  assert.doesNotMatch(readText(repo, "shared.txt"), /rerere/);
  assert.deepEqual(rrState(), untouched);
  vlab(repo, "rebase", "--abort", "--json");
  assert.equal(git(repo, "rev-parse", "HEAD"), source.commit);
  assert.equal(git(repo, "status", "--porcelain=v1"), "");
  git(repo, "switch", "main");

  // Reconciliation pauses on a real conflict with markers, not on a
  // pre-filled file, and leaves no rerere bookkeeping behind.
  assert.notEqual(vlabResult(repo, "reconcile", "feature").status, 0);
  const status = JSON.parse(vlab(repo, "resolve", "status", "--json"));
  assert.equal(status.conflicts.length, 1);
  assert.equal(status.conflicts[0].path, "shared.txt");
  assert.equal(status.conflicts[0].candidates.length, 0);
  assert.match(git(repo, "status", "--porcelain=v1"), /^UU shared.txt/m);
  assert.match(readText(repo, "shared.txt"), /<<<<<<< HEAD/);
  assert.doesNotMatch(readText(repo, "shared.txt"), /rerere/);
  assert.deepEqual(rrState(), untouched);

  // The user's resolution is recorded by vlab only; rr-cache is unchanged.
  write(repo, "shared.txt", "one\nvlab\nthree\n");
  git(repo, "add", "shared.txt");
  const result = JSON.parse(vlab(repo, "reconcile", "--continue", "--json"));
  assert.equal(result.receipt.applied[0].resolutions[0].decision, "created");
  assert.equal(readText(repo, "shared.txt"), "one\nvlab\nthree\n");
  assert.equal(JSON.parse(vlab(repo, "resolve", "list", "--json")).length, 1);
  assert.deepEqual(rrState(), untouched);

  // Replaying the conflict, vlab's own memory is the candidate and its
  // result, not Git's, is the forecast.
  git(repo, "reset", "--hard", mainHead);
  for (const engine of ["worktree", "merge-tree"]) {
    const forecast = forecastWithEngine(repo, engine, "forecast", "feature");
    assert.equal(forecast.status, "complete", engine);
    assert.equal(forecast.counts.exactResolution, 1, engine);
    assert.equal(
      git(repo, "show", `${forecast.predictedResultTree}:shared.txt`),
      "one\nvlab\nthree",
      engine,
    );
    assert.deepEqual(rrState(), untouched);
  }
  assert.equal(git(repo, "status", "--porcelain=v1"), "");
});

test("modified and rejected suggestions create auditable resolution variants", (t) => {
  const { repo } = makeRepo(t);
  write(repo, "shared.txt", "base\n");
  git(repo, "add", "shared.txt");
  const base = JSON.parse(vlab(repo, "commit", "-m", "base"));
  vlab(repo, "init");

  const createPair = (suffix) => {
    const source = `source-${suffix}`;
    const target = `target-${suffix}`;
    git(repo, "switch", "-c", source, base.commit);
    write(repo, "shared.txt", "source\n");
    git(repo, "add", "shared.txt");
    const sourceCommit = JSON.parse(
      vlab(repo, "commit", "-m", `source ${suffix}`),
    );
    git(repo, "switch", "-c", target, base.commit);
    write(repo, "shared.txt", "target\n");
    git(repo, "add", "shared.txt");
    vlab(repo, "commit", "-m", `target ${suffix}`);
    return { source, sourceCommit };
  };

  const first = createPair("first");
  assert.notEqual(vlabResult(repo, "reconcile", first.source).status, 0);
  write(repo, "shared.txt", "resolution one\n");
  git(repo, "add", "shared.txt");
  vlab(repo, "reconcile", "--continue", "--json");

  const second = createPair("second");
  assert.notEqual(vlabResult(repo, "reconcile", second.source).status, 0);
  vlab(repo, "resolve", "apply", "--all");
  write(repo, "shared.txt", "resolution two\n");
  git(repo, "add", "shared.txt");
  const modified = JSON.parse(
    vlab(repo, "reconcile", "--continue", "--json"),
  );
  assert.equal(modified.receipt.applied[0].resolutions[0].decision, "modified");
  assert.equal(JSON.parse(vlab(repo, "resolve", "list", "--json")).length, 2);

  const third = createPair("third");
  assert.notEqual(vlabResult(repo, "reconcile", third.source).status, 0);
  const ambiguous = vlabResult(repo, "resolve", "apply", "--all");
  assert.notEqual(ambiguous.status, 0);
  assert.match(ambiguous.stderr, /multiple resolutions match/i);
  assert.match(vlab(repo, "resolve", "reject", "--all"), /Rejected 1/);
  write(repo, "shared.txt", "resolution three\n");
  git(repo, "add", "shared.txt");
  const rejected = JSON.parse(
    vlab(repo, "reconcile", "--continue", "--json"),
  );
  assert.equal(rejected.receipt.applied[0].resolutions[0].decision, "rejected");
  assert.equal(JSON.parse(vlab(repo, "resolve", "list", "--json")).length, 3);
});

test("resolve reject records an explicit rejection without touching the conflicted worktree", (t) => {
  const { repo } = makeRepo(t);
  write(repo, "shared.txt", "base\n");
  git(repo, "add", "shared.txt");
  const base = JSON.parse(vlab(repo, "commit", "-m", "base"));
  vlab(repo, "init");

  const createPair = (suffix) => {
    const source = `source-${suffix}`;
    git(repo, "switch", "-c", source, base.commit);
    write(repo, "shared.txt", "source\n");
    git(repo, "add", "shared.txt");
    vlab(repo, "commit", "-m", `source ${suffix}`);
    git(repo, "switch", "-c", `target-${suffix}`, base.commit);
    write(repo, "shared.txt", "target\n");
    git(repo, "add", "shared.txt");
    vlab(repo, "commit", "-m", `target ${suffix}`);
    return source;
  };

  // One remembered resolution, so the next conflict has a candidate to
  // reject.
  assert.notEqual(vlabResult(repo, "reconcile", createPair("first")).status, 0);
  write(repo, "shared.txt", "remembered\n");
  git(repo, "add", "shared.txt");
  vlab(repo, "reconcile", "--continue", "--json");
  const [remembered] = JSON.parse(vlab(repo, "resolve", "list", "--json"));

  const secondSource = createPair("second");
  const targetHead = git(repo, "rev-parse", "HEAD");
  assert.notEqual(vlabResult(repo, "reconcile", secondSource).status, 0);
  const before = JSON.parse(vlab(repo, "resolve", "status", "--json"));
  assert.equal(before.conflicts.length, 1);
  assert.deepEqual(
    before.conflicts[0].candidates.map((candidate) => candidate.id),
    [remembered.id],
  );
  assert.equal(before.conflicts[0].decisionOverride, null);
  const conflictedText = readText(repo, "shared.txt");
  assert.match(conflictedText, /<<<<<<< HEAD/);

  // Rejecting by path names the conflict and counts its candidates, and it
  // changes only the journal: markers, index, and HEAD are untouched.
  const rejected = JSON.parse(vlab(repo, "resolve", "reject", "shared.txt", "--json"));
  assert.equal(rejected.operationId, before.operationId);
  assert.deepEqual(rejected.rejected, [{ path: "shared.txt", candidates: 1 }]);
  const after = JSON.parse(vlab(repo, "resolve", "status", "--json"));
  assert.equal(after.active, true);
  assert.equal(after.conflicts[0].decisionOverride, "rejected");
  assert.equal(after.conflicts[0].selectionMethod, "explicit");
  assert.equal(after.conflicts[0].selectedResolutionId, null);
  assert.equal(readText(repo, "shared.txt"), conflictedText);
  assert.match(git(repo, "status", "--porcelain=v1"), /^UU shared\.txt$/m);
  assert.equal(git(repo, "rev-parse", "HEAD"), targetHead);

  // Rejecting a named candidate records which one was declined; naming one
  // that is not a candidate is refused and leaves the journal as it was.
  const named = JSON.parse(
    vlab(repo, "resolve", "reject", "--all", "--resolution", remembered.id, "--json"),
  );
  assert.deepEqual(named.rejected, [{ path: "shared.txt", candidates: 1 }]);
  assert.equal(
    JSON.parse(vlab(repo, "resolve", "status", "--json")).conflicts[0].selectedResolutionId,
    remembered.id,
  );
  const unknown = vlabResult(
    repo,
    "resolve",
    "reject",
    "--all",
    "--resolution",
    "res_not_a_candidate",
    "--json",
  );
  assert.notEqual(unknown.status, 0);
  assert.equal(JSON.parse(unknown.stdout).code, "no-match");
  assert.equal(
    JSON.parse(vlab(repo, "resolve", "status", "--json")).conflicts[0].selectedResolutionId,
    remembered.id,
  );
  assert.equal(readText(repo, "shared.txt"), conflictedText);

  // The continuation audits the hand-written result as a rejection of the
  // named candidate rather than a creation, and retains it as its own
  // variant.
  write(repo, "shared.txt", "hand-written\n");
  git(repo, "add", "shared.txt");
  const result = JSON.parse(vlab(repo, "reconcile", "--continue", "--json"));
  const [outcome] = result.receipt.applied[0].resolutions;
  assert.equal(outcome.path, "shared.txt");
  assert.equal(outcome.decision, "rejected");
  assert.equal(outcome.selectionMethod, "explicit");
  assert.equal(outcome.selectedResolutionId, remembered.id);
  assert.equal(outcome.reusedResolutionId, null);
  assert.equal(readText(repo, "shared.txt"), "hand-written\n");
  assert.equal(JSON.parse(vlab(repo, "resolve", "list", "--json")).length, 2);
  assert.equal(git(repo, "status", "--porcelain=v1"), "");
});

// CLI fixtures validate the report against the measured host, which may be
// slow. Controlled boundary and precedence cases live in the analysis tests.
function assertBenchmarkLatencyAnalysis(report) {
  const overBudget = Object.entries(report.measurements)
    .filter(([, measurement]) => measurement.medianMs > report.analysis.interactiveBudgetMs)
    .map(([name]) => name).sort();
  assert.deepEqual(report.analysis.phasesOverBudget, overBudget);
  assert.equal(report.analysis.nextAction, overBudget.length
    ? "evaluate-incremental-catalogs" : "increase-fixture-volume-and-collect-more-hosts");
  assert.equal(report.analysis.persistentIndex.recommendedNow, overBudget.length > 0);
}

test("doctor and repository-scale benchmarks expose process costs without repository content", (t) => {
  const { repo, parent } = makeRepo(t);
  write(repo, "base.txt", "base\n");
  git(repo, "add", "base.txt");
  git(repo, "commit", "-m", "base");
  const doctor = JSON.parse(
    vlab(
      repo,
      "doctor",
      "--benchmark",
      "--samples",
      "5",
      "--warmup",
      "2",
      "--git-session",
    ),
  );
  assert.equal(doctor.ok, true);
  assert.equal(doctor.benchmark.length, 4);
  assert.ok(doctor.benchmark.every((probe) => probe.samplesMs.length === 5));
  assert.ok(doctor.benchmark.every((probe) => probe.warmup === 2));
  assert.ok(doctor.benchmark.every((probe) => probe.p95Ms >= probe.medianMs));
  assert.equal(doctor.objectSession.enabled, true);
  assert.equal(doctor.objectSession.logicalReads, 15);
  assert.equal(doctor.objectSession.git.processes, 1);
  assert.ok(doctor.objectSession.git.sessionQueries >= 3);
  assert.ok(doctor.objectSession.git.cacheHits >= 8);

  const scaleCallerBefore = {
    head: git(repo, "rev-parse", "HEAD"),
    status: git(repo, "status", "--porcelain=v1"),
    worktrees: git(repo, "worktree", "list", "--porcelain"),
  };
  const scaleFixtureDirectoriesBefore = fs.readdirSync(os.tmpdir())
    .filter((entry) => entry.startsWith("vcs-lab-scale-benchmark-"))
    .sort();
  const scale = JSON.parse(
    vlab(
      repo,
      "metadata",
      "benchmark",
      "--history",
      "4",
      "--workspaces",
      "2",
      "--notes",
      "3",
      "--resolutions",
      "8",
      "--samples",
      "2",
      "--budget-ms",
      "5000",
      // A tiny working tree: this test is about the report's shape and its
      // privacy guarantees, not about scale, and the default fixture would
      // write 600 files it never looks at.
      "--areas",
      "2",
      "--files-per-area",
      "3",
      "--json",
    ),
  );
  assert.equal(scale.schema, "vcs-lab.repository-scale-benchmark/v1");
  assert.deepEqual(scale.fixture, {
    profile: "custom-v1",
    historyDepth: 4,
    workspaces: 2,
    causalNotes: 3,
    resolutions: 8,
    totalNoteTargets: 11,
    totalNoteRecords: 11,
    areas: 2,
    filesPerArea: 3,
    treeFiles: 6,
  });
  assert.equal(scale.coverage.documentationVolume.companionSchema, "vcs-lab.spec-benchmark/v2");
  assert.equal(scale.setup.expectedAbsentProbeFailures, 21);
  assert.equal(scale.setup.unexpectedGitFailures, 0);
  assert.equal(scale.measurements.history.result.commits, 4);
  assert.equal(scale.measurements.gitWorktrees.result.worktrees, 3);
  assert.equal(scale.measurements.workspaceRegistry.result.workspaces, 2);
  assert.deepEqual(scale.measurements.workspaceStatus.result, {
    workspaces: 2,
    active: 2,
    dirty: 0,
  });
  assert.equal(scale.measurements.noteCatalog.result.records, 11);
  assert.equal(scale.measurements.resolutionCatalog.result.resolutions, 8);
  assert.deepEqual(scale.measurements.metadataStatus.result, {
    valid: true,
    acceptedPortableRecords: 11,
    noteTargets: 11,
    resolutionRefs: 8,
    registeredWorkspaces: 2,
    materializedWorktrees: 3,
  });
  assert.ok(
    Object.values(scale.measurements).every(
      (measurement) => measurement.samples.length === 2,
    ),
  );
  // Batched scans: one worktree-scoped status query per materialized
  // workspace, and a bounded number of processes for the whole resolution
  // catalog regardless of how many retention refs exist.
  assert.equal(scale.measurements.workspaceStatus.medianProcesses, 2);
  assert.equal(
    scale.analysis.processAmplification.workspaceStatusProcessesPerWorkspace,
    1,
  );
  assert.ok(
    scale.analysis.processAmplification.noteCatalogProcessesPerTarget < 1,
  );
  assert.ok(scale.measurements.resolutionCatalog.medianProcesses <= 6);
  assert.ok(
    scale.analysis.processAmplification.resolutionCatalogProcessesPerResolution < 1,
  );
  assert.equal(scale.analysis.processAmplification.minimumEntitiesForDecision, 10);
  assert.deepEqual(scale.analysis.processAmplification.decidable, {
    workspaceStatus: false,
    resolutionCatalog: false,
  });
  assertBenchmarkLatencyAnalysis(scale);
  assert.equal(scale.analysis.residentService.recommendedNow, false);
  assert.deepEqual(
    scale.analysis.recommendations.map((item) => item.area),
    ["note-catalog"],
  );
  assert.deepEqual(scale.privacy, {
    repositoryPathsIncluded: false,
    objectIdsIncluded: false,
    fileContentsIncluded: false,
    commitMessagesIncluded: false,
  });
  assert.equal(scale.cleanup.temporaryFixtureRemoved, true);
  assert.doesNotMatch(JSON.stringify(scale), /vcs-lab-scale-benchmark-/);

  // A tiny custom fixture cannot dilute the catalog's fixed batch cost, so
  // the analysis asks for more volume instead of misreporting that cost as
  // per-entity amplification.
  const tiny = JSON.parse(
    vlab(
      repo,
      "metadata",
      "benchmark",
      "--history",
      "2",
      "--workspaces",
      "0",
      "--notes",
      "0",
      "--resolutions",
      "2",
      "--samples",
      "1",
      "--budget-ms",
      "5000",
      "--areas",
      "2",
      "--files-per-area",
      "3",
      "--json",
    ),
  );
  assert.equal(tiny.measurements.resolutionCatalog.result.resolutions, 2);
  assert.equal(
    tiny.measurements.resolutionCatalog.medianProcesses,
    scale.measurements.resolutionCatalog.medianProcesses,
  );
  assert.ok(
    tiny.analysis.processAmplification.resolutionCatalogProcessesPerResolution > 1,
  );
  assert.equal(tiny.analysis.processAmplification.decidable.resolutionCatalog, false);
  assert.deepEqual(
    tiny.analysis.recommendations.map((item) => [item.area, item.priority]),
    [
      ["resolution-catalog", "increase-fixture-volume"],
      ["note-catalog", tiny.measurements.noteCatalog.medianMs > 5000
        ? "measure-index-after-batching" : "retain-batched-scan"],
    ],
  );
  assertBenchmarkLatencyAnalysis(tiny);
  assert.deepEqual(
    fs.readdirSync(os.tmpdir())
      .filter((entry) => entry.startsWith("vcs-lab-scale-benchmark-"))
      .sort(),
    scaleFixtureDirectoriesBefore,
  );
  assert.deepEqual({
    head: git(repo, "rev-parse", "HEAD"),
    status: git(repo, "status", "--porcelain=v1"),
    worktrees: git(repo, "worktree", "list", "--porcelain"),
  }, scaleCallerBefore);

  const traced = spawnSync(process.execPath, [cli, "doctor"], {
    cwd: repo,
    encoding: "utf8",
    env: testEnv({ VLAB_TRACE: "1" }),
  });
  assert.equal(traced.status, 0);
  assert.match(traced.stderr, /\[vlab trace\].*git --version/);

  const tracedOption = spawnSync(
    process.execPath,
    [cli, "--trace-git", "--git-session", "merge-plan", "HEAD", "--json"],
    {
      cwd: repo,
      encoding: "utf8",
      env: testEnv(),
    },
  );
  assert.equal(tracedOption.status, 0);
  assert.match(tracedOption.stderr, /persistent process|cache hit/);

  const readDiagnostics = (filePath) => fs
    .readFileSync(filePath, "utf8")
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line.slice(line.indexOf("{"))));

  const shutdownDiagnosticsPath = path.join(parent, "shutdown-diagnostics.log");
  const planned = spawnSync(
    process.execPath,
    [cli, "merge-plan", "HEAD", "--git-session", "--json"],
    {
      cwd: repo,
      encoding: "utf8",
      env: testEnv({
        VLAB_GIT_SESSION_DIAGNOSTICS: "1",
        VLAB_GIT_SESSION_DIAGNOSTICS_FILE: shutdownDiagnosticsPath,
      }),
    },
  );
  assert.equal(planned.status, 0);
  const shutdownDiagnostics = readDiagnostics(shutdownDiagnosticsPath);
  const gitClose = shutdownDiagnostics.findIndex(
    (event) => event.event === "git-close",
  );
  const closeFinish = shutdownDiagnostics.findIndex(
    (event) => event.event === "close-finish",
  );
  assert.ok(gitClose >= 0);
  assert.ok(closeFinish > gitClose);
  assert.equal(
    shutdownDiagnostics.some((event) => event.event === "close-git-kill"),
    false,
  );

  const diagnosticsPath = path.join(parent, "lazy-session-diagnostics.log");
  write(repo, "dirty.txt", "dirty\n");
  const rejected = spawnSync(
    process.execPath,
    [cli, "reconcile", "HEAD", "--git-session"],
    {
      cwd: repo,
      encoding: "utf8",
      env: testEnv({
        VLAB_GIT_SESSION_DIAGNOSTICS: "1",
        VLAB_GIT_SESSION_DIAGNOSTICS_FILE: diagnosticsPath,
      }),
    },
  );
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /worktree must be clean/i);

  const diagnostics = readDiagnostics(diagnosticsPath);
  const statusStart = diagnostics.findIndex(
    (event) => event.event === "git-spawn-start" && event.command === "status",
  );
  const statusEnd = diagnostics.findIndex(
    (event) => event.event === "git-spawn-end" && event.command === "status",
  );
  const closedWithoutWorker = diagnostics.findIndex(
    (event) => event.event === "session-close-no-worker",
  );
  assert.ok(statusStart >= 0);
  assert.ok(statusEnd > statusStart);
  assert.ok(closedWithoutWorker > statusEnd);
  assert.equal(
    diagnostics.some((event) => event.event === "worker-create-start"),
    false,
  );
});

test("merge planning batches commit metadata instead of spawning per commit", (t) => {
  const { repo } = makeRepo(t);
  write(repo, "history.txt", "base\n");
  git(repo, "add", "history.txt");
  git(repo, "commit", "-m", "base");
  git(repo, "switch", "-c", "feature");
  for (let index = 1; index <= 12; index += 1) {
    write(repo, "history.txt", `${index}\n`);
    git(repo, "add", "history.txt");
    git(
      repo,
      "commit",
      "-m",
      `feature ${index}\n\nChange-Id: ch_bulk_${index}`,
    );
  }
  git(repo, "switch", "main");

  const planned = spawnSync(
    process.execPath,
    [cli, "merge-plan", "feature", "--git-session", "--trace-git", "--json"],
    {
      cwd: repo,
      encoding: "utf8",
      env: testEnv(),
    },
  );
  assert.equal(planned.status, 0);
  const plan = JSON.parse(planned.stdout);
  assert.equal(plan.changes.length, 12);
  assert.equal(plan.counts.new, 12);
  assert.equal((planned.stderr.match(/git log /g) ?? []).length, 2);
  assert.equal((planned.stderr.match(/git show /g) ?? []).length, 0);

  const fallback = JSON.parse(
    vlab(repo, "merge-plan", "feature", "--no-git-session", "--json"),
  );
  assert.deepEqual(fallback, plan);

  // The forced-session suite modes are self-checking here. With the session
  // chosen by the environment alone, `VLAB_GIT_SESSION=1` must show the
  // persistent process answering reads and `VLAB_GIT_SESSION=0` must show no
  // session at all; unset, the default is platform-specific and not claimed.
  const inherited = spawnSync(
    process.execPath,
    [cli, "merge-plan", "feature", "--trace-git", "--json"],
    { cwd: repo, encoding: "utf8", env: testEnv() },
  );
  assert.equal(inherited.status, 0, inherited.stderr);
  assert.deepEqual(JSON.parse(inherited.stdout), plan);
  const sessionTraces =
    (inherited.stderr.match(/persistent process|cache hit/g) ?? []).length;
  if (process.env.VLAB_GIT_SESSION === "1") {
    assert.ok(
      sessionTraces > 0,
      `VLAB_GIT_SESSION=1 must answer reads through the object session:\n${inherited.stderr}`,
    );
  } else if (process.env.VLAB_GIT_SESSION === "0") {
    assert.equal(
      sessionTraces,
      0,
      `VLAB_GIT_SESSION=0 must not open an object session:\n${inherited.stderr}`,
    );
  }

  const failedSession = spawnSync(
    process.execPath,
    [cli, "merge-plan", "feature", "--git-session", "--trace-git", "--json"],
    {
      cwd: repo,
      encoding: "utf8",
      env: testEnv({
        VLAB_TEST_GIT_SESSION_FAILURE: "1",
      }),
    },
  );
  assert.equal(failedSession.status, 0);
  assert.deepEqual(JSON.parse(failedSession.stdout), plan);
  assert.match(failedSession.stderr, /using ordinary processes/i);
});

test("forecast previews and batch-applies pinned exact resolutions without mutation", (t) => {
  const { repo } = makeRepo(t);
  write(repo, "shared.txt", "base\n");
  git(repo, "add", "shared.txt");
  const base = JSON.parse(vlab(repo, "commit", "-m", "base"));
  vlab(repo, "init");

  git(repo, "switch", "-c", "source-one", base.commit);
  write(repo, "shared.txt", "source\n");
  git(repo, "add", "shared.txt");
  vlab(repo, "commit", "-m", "source one");
  git(repo, "switch", "-c", "target-one", base.commit);
  write(repo, "shared.txt", "target\n");
  git(repo, "add", "shared.txt");
  vlab(repo, "commit", "-m", "target one");
  assert.notEqual(vlabResult(repo, "reconcile", "source-one").status, 0);
  write(repo, "shared.txt", "remembered\n");
  git(repo, "add", "shared.txt");
  vlab(repo, "reconcile", "--continue", "--json");

  git(repo, "switch", "-c", "source-two", base.commit);
  write(repo, "shared.txt", "source\n");
  git(repo, "add", "shared.txt");
  vlab(repo, "commit", "-m", "source two");
  git(repo, "switch", "-c", "target-two", base.commit);
  write(repo, "shared.txt", "target\n");
  git(repo, "add", "shared.txt");
  vlab(repo, "commit", "-m", "target two");

  const before = {
    head: git(repo, "rev-parse", "HEAD"),
    status: git(repo, "status", "--porcelain=v1"),
    worktrees: git(repo, "worktree", "list", "--porcelain"),
  };
  const forecast = JSON.parse(vlab(repo, "forecast", "source-two", "--json"));
  assert.equal(forecast.status, "complete");
  assert.equal(forecast.counts.exactResolution, 1);
  assert.equal(forecast.approvedResolutions.length, 1);
  assert.equal(forecast.steps[0].outcome, "exact-resolution");
  assert.equal(forecast.steps[0].resolutions[0].decision, "accepted");
  assert.equal(
    forecast.steps[0].resolutions[0].selectionMethod,
    "forecast-batch",
  );
  assert.ok(forecast.predictedResultTree);
  assert.ok(forecast.timings.forecastMs > 0);
  assert.equal(git(repo, "rev-parse", "HEAD"), before.head);
  assert.equal(git(repo, "status", "--porcelain=v1"), before.status);
  assert.equal(git(repo, "worktree", "list", "--porcelain"), before.worktrees);

  const reconciled = JSON.parse(
    vlab(
      repo,
      "reconcile",
      "source-two",
      "--use-forecast",
      forecast.id,
      "--json",
    ),
  );
  assert.equal(reconciled.receipt.forecastId, forecast.id);
  assert.equal(reconciled.receipt.resultTree, forecast.predictedResultTree);
  assert.equal(
    reconciled.receipt.applied[0].resolutions[0].selectionMethod,
    "forecast-batch",
  );
  assert.equal(
    reconciled.receipt.applied[0].resolutions[0].decision,
    "accepted",
  );
  assert.ok(reconciled.receipt.timings.activeApplicationMs > 0);
  assert.ok(reconciled.receipt.timings.elapsedWallMs >= 0);
  assert.equal(git(repo, "status", "--porcelain=v1"), "");
  assert.equal(
    JSON.parse(vlab(repo, "reconcile", "--status", "--json")).active,
    false,
  );
});

test("stale forecasts fail before starting a reconciliation", (t) => {
  const { repo } = makeRepo(t);
  write(repo, "base.txt", "base\n");
  git(repo, "add", "base.txt");
  const base = JSON.parse(vlab(repo, "commit", "-m", "base"));
  vlab(repo, "init");

  git(repo, "switch", "-c", "feature", base.commit);
  write(repo, "feature.txt", "feature\n");
  git(repo, "add", "feature.txt");
  vlab(repo, "commit", "-m", "feature");
  git(repo, "switch", "main");
  const forecast = JSON.parse(vlab(repo, "forecast", "feature", "--json"));
  assert.equal(forecast.status, "complete");

  write(repo, "target.txt", "target moved\n");
  git(repo, "add", "target.txt");
  const moved = JSON.parse(vlab(repo, "commit", "-m", "move target"));
  const attempt = vlabResult(
    repo,
    "reconcile",
    "feature",
    "--use-forecast",
    forecast.id,
  );
  assert.notEqual(attempt.status, 0);
  assert.match(attempt.stderr, /no longer matches this reconciliation/i);
  assert.equal(git(repo, "rev-parse", "HEAD"), moved.commit);
  assert.equal(
    JSON.parse(vlab(repo, "reconcile", "--status", "--json")).active,
    false,
  );
});

test("forecast result mismatch blocks receipts and remains abortable", (t) => {
  const { repo } = makeRepo(t);
  write(repo, "base.txt", "base\n");
  git(repo, "add", "base.txt");
  const base = JSON.parse(vlab(repo, "commit", "-m", "base"));
  vlab(repo, "init");

  git(repo, "switch", "-c", "feature", base.commit);
  write(repo, "feature.txt", "feature\n");
  git(repo, "add", "feature.txt");
  vlab(repo, "commit", "-m", "feature");
  git(repo, "switch", "main");
  const forecast = JSON.parse(vlab(repo, "forecast", "feature", "--json"));
  const relativeForecastPath = git(
    repo,
    "rev-parse",
    "--git-path",
    `vcs-lab/forecasts/${forecast.id}.json`,
  );
  const savedPath = path.resolve(repo, relativeForecastPath);
  const saved = JSON.parse(fs.readFileSync(savedPath, "utf8"));
  saved.predictedResultTree = saved.plan.targetTree;
  fs.writeFileSync(savedPath, `${JSON.stringify(saved, null, 2)}\n`);

  const attempt = vlabResult(
    repo,
    "reconcile",
    "feature",
    "--use-forecast",
    forecast.id,
  );
  assert.notEqual(attempt.status, 0);
  assert.match(attempt.stderr, /result does not match forecast/i);
  const status = JSON.parse(vlab(repo, "reconcile", "--status", "--json"));
  assert.equal(status.active, true);
  assert.equal(status.state, "forecast-mismatch");
  assert.deepEqual(JSON.parse(vlab(repo, "receipts", "--json")), []);
  const aborted = JSON.parse(vlab(repo, "reconcile", "--abort", "--json"));
  assert.equal(aborted.restoredHead, base.commit);
  assert.equal(fs.existsSync(path.join(repo, "feature.txt")), false);
});

test("workspace forecasts keep live drafts isolated and can pin an immutable source checkpoint", (t) => {
  const { repo, parent } = makeRepo(t);
  write(repo, "shared.txt", "base\n");
  git(repo, "add", "shared.txt");
  vlab(repo, "commit", "-m", "base");
  vlab(repo, "init");

  const targetPath = path.join(parent, "target-agent");
  const sourcePath = path.join(parent, "source-agent");
  vlab(
    repo,
    "workspace",
    "create",
    "target-agent",
    "--path",
    targetPath,
    "--json",
  );
  vlab(
    repo,
    "workspace",
    "create",
    "source-agent",
    "--path",
    sourcePath,
    "--json",
  );
  write(targetPath, "shared.txt", "target\n");
  git(targetPath, "add", "shared.txt");
  vlab(targetPath, "commit", "-m", "target edit");
  write(sourcePath, "shared.txt", "source\n");
  git(sourcePath, "add", "shared.txt");
  vlab(sourcePath, "commit", "-m", "source edit");
  write(sourcePath, "draft.txt", "uncommitted agent draft\n");

  const targetHead = git(targetPath, "rev-parse", "HEAD");
  const sourceHead = git(sourcePath, "rev-parse", "HEAD");
  const sourceStatus = git(sourcePath, "status", "--porcelain=v1");
  const forecast = JSON.parse(
    vlab(
      repo,
      "workspace",
      "forecast",
      "target-agent",
      "source-agent",
      "--git-session",
      "--json",
    ),
  );
  assert.equal(forecast.status, "blocked");
  assert.equal(forecast.blockedReason, "missing-exact-resolution");
  assert.equal(forecast.steps[0].outcome, "blocked-conflict");
  assert.deepEqual(
    forecast.steps[0].conflicts.map((conflict) => conflict.path),
    ["shared.txt"],
  );
  assert.equal(forecast.workspaceComparison.scope, "committed-heads");
  assert.equal(
    forecast.workspaceComparison.source.ignoredDirtyFiles,
    1,
  );
  assert.equal(forecast.targetWorktree, targetPath);
  assert.ok(forecast.timings.git.sessionQueries > 0);
  assert.ok(forecast.timings.git.processes < forecast.timings.git.count);
  assert.equal(git(targetPath, "rev-parse", "HEAD"), targetHead);
  assert.equal(git(sourcePath, "rev-parse", "HEAD"), sourceHead);
  assert.equal(git(sourcePath, "status", "--porcelain=v1"), sourceStatus);
  assert.equal(
    JSON.parse(
      vlab(
        targetPath,
        "reconcile",
        "--status",
        "--json",
      ),
    ).active,
    false,
  );

  const overlayTargetPath = path.join(parent, "overlay-target");
  const overlaySourcePath = path.join(parent, "overlay-source");
  vlab(
    repo,
    "workspace",
    "create",
    "overlay-target",
    "--path",
    overlayTargetPath,
    "--json",
  );
  vlab(
    repo,
    "workspace",
    "create",
    "overlay-source",
    "--path",
    overlaySourcePath,
    "--json",
  );
  write(overlayTargetPath, "target.txt", "target committed\n");
  git(overlayTargetPath, "add", "target.txt");
  vlab(overlayTargetPath, "commit", "-m", "target committed change", "--json");
  write(overlaySourcePath, "source.txt", "source committed\n");
  git(overlaySourcePath, "add", "source.txt");
  vlab(overlaySourcePath, "commit", "-m", "source committed change", "--json");
  const overlaySourceHead = git(overlaySourcePath, "rev-parse", "HEAD");
  write(overlaySourcePath, "draft.txt", "captured draft\n");
  const checkpoint = JSON.parse(
    vlab(
      overlaySourcePath,
      "workspace",
      "checkpoint",
      "--label",
      "reviewable draft",
      "--json",
    ),
  );
  write(overlaySourcePath, "draft.txt", "new live draft\n");
  write(overlaySourcePath, "live-only.txt", "not captured\n");

  const overlayTargetHead = git(overlayTargetPath, "rev-parse", "HEAD");
  const overlaySourceStatus = git(
    overlaySourcePath,
    "status",
    "--porcelain=v1",
  );
  const overlayForecast = JSON.parse(
    vlab(
      repo,
      "workspace",
      "forecast",
      "overlay-target",
      "overlay-source",
      "--source-checkpoint",
      "--json",
    ),
  );
  assert.equal(overlayForecast.status, "complete");
  assert.equal(overlayForecast.scope, "source-checkpoint");
  assert.equal(overlayForecast.sourceHead, checkpoint.id);
  assert.equal(overlayForecast.workspaceComparison.scope, "source-checkpoint");
  assert.equal(
    overlayForecast.workspaceComparison.source.checkpoint.id,
    checkpoint.id,
  );
  assert.equal(
    overlayForecast.workspaceComparison.source.checkpoint.baseHead,
    overlaySourceHead,
  );
  assert.equal(
    overlayForecast.workspaceComparison.source.ignoredDirtyFiles,
    2,
  );
  assert.ok(
    overlayForecast.plan.changes.some(
      (change) => change.changeId === checkpoint.draftChangeId,
    ),
  );
  assert.equal(
    git(repo, "show", `${overlayForecast.predictedResultTree}:draft.txt`),
    "captured draft",
  );
  assert.doesNotMatch(
    git(repo, "ls-tree", "-r", "--name-only", overlayForecast.predictedResultTree),
    /live-only\.txt/,
  );
  assert.equal(git(overlayTargetPath, "rev-parse", "HEAD"), overlayTargetHead);
  assert.equal(git(overlaySourcePath, "rev-parse", "HEAD"), overlaySourceHead);
  assert.equal(
    git(overlaySourcePath, "status", "--porcelain=v1"),
    overlaySourceStatus,
  );
  assert.match(
    vlab(
      repo,
      "workspace",
      "forecast",
      "overlay-target",
      "overlay-source",
      "--source-checkpoint",
    ),
    /scope\s+immutable source checkpoint/,
  );

  const applied = JSON.parse(
    vlab(
      overlayTargetPath,
      "reconcile",
      checkpoint.id,
      "--use-forecast",
      overlayForecast.id,
      "--json",
    ),
  );
  assert.equal(applied.receipt.forecastId, overlayForecast.id);
  assert.equal(readText(overlayTargetPath, "draft.txt"), "captured draft\n");
  assert.equal(fs.existsSync(path.join(overlayTargetPath, "live-only.txt")), false);
  assert.equal(git(overlayTargetPath, "status", "--porcelain=v1"), "");
  assert.equal(
    git(overlaySourcePath, "status", "--porcelain=v1"),
    overlaySourceStatus,
  );

  const reviewedAfterApply = JSON.parse(
    vlab(
      repo,
      "workspace",
      "forecast",
      "overlay-target",
      "overlay-source",
      "--source-checkpoint",
      "--json",
    ),
  );

  git(overlaySourcePath, "add", "draft.txt", "live-only.txt");
  vlab(overlaySourcePath, "commit", "-m", "advance after checkpoint", "--json");
  const staleApproval = vlabResult(
    overlayTargetPath,
    "reconcile",
    checkpoint.id,
    "--use-forecast",
    reviewedAfterApply.id,
    "--json",
  );
  assert.notEqual(staleApproval.status, 0);
  // A --json failure is the ADR-0021 envelope on stdout, so staleness is now
  // readable as a code as well as prose.
  const staleEnvelope = JSON.parse(staleApproval.stdout);
  assert.equal(staleEnvelope.code, "stale-forecast");
  assert.match(staleEnvelope.message, /source workspace head/i);
  assert.equal(git(overlayTargetPath, "status", "--porcelain=v1"), "");
  const staleCheckpoint = vlabResult(
    repo,
    "workspace",
    "forecast",
    "overlay-target",
    "overlay-source",
    "--source-checkpoint",
  );
  assert.notEqual(staleCheckpoint.status, 0);
  assert.match(staleCheckpoint.stderr, /moved after checkpoint/i);
});

test("metadata validation quarantines invalid causal claims from coverage", (t) => {
  const { repo } = makeRepo(t);
  write(repo, "base.txt", "base\n");
  git(repo, "add", ".");
  const base = JSON.parse(vlab(repo, "commit", "-m", "base"));
  vlab(repo, "init");

  git(repo, "switch", "-c", "feature", base.commit);
  write(repo, "feature.txt", "portable\n");
  git(repo, "add", ".");
  const feature = JSON.parse(vlab(repo, "commit", "-m", "feature"));
  git(repo, "switch", "main");
  const target = git(repo, "rev-parse", "HEAD");
  const targetTree = git(repo, "rev-parse", "HEAD^{tree}");
  const missing = "f".repeat(40);
  const invalid = {
    schema: "vcs-lab.note/v1",
    records: [
      {
        schema: "vcs-lab.landing/v99",
        type: "landing",
        id: "land_unknown_schema",
        absorbedCommits: [feature.commit],
        absorbedChanges: [feature.changeId],
      },
      {
        schema: "vcs-lab.landing/v1",
        type: "landing",
        id: "land_dangling_reference",
        mode: "hard-squash",
        sourceRef: "feature",
        sourceHead: missing,
        targetBefore: target,
        landingCommit: target,
        base: base.commit,
        absorbedCommits: [feature.commit],
        absorbedChanges: [feature.changeId],
        resultTree: targetTree,
        createdAt: new Date(0).toISOString(),
      },
    ],
  };
  exec(
    "git",
    ["notes", "--ref=vcs-lab", "add", "-f", "-F", "-", target],
    repo,
    { input: `${JSON.stringify(invalid, null, 2)}\n` },
  );

  const status = JSON.parse(vlab(repo, "metadata", "status", "--json"));
  assert.equal(status.scopes.sharedPortable.notes.quarantinedCount, 2);
  assert.ok(status.diagnostics.some((item) => item.code === "unknown-schema"));
  assert.ok(status.diagnostics.some((item) => item.code === "missing-referenced-object"));
  assert.equal(status.trust.cryptographicallyTrusted, false);

  const validation = vlabResult(repo, "metadata", "validate", "--json");
  assert.notEqual(validation.status, 0);
  assert.equal(JSON.parse(validation.stdout).summary.valid, false);

  const plan = JSON.parse(vlab(repo, "merge-plan", "feature", "--json"));
  assert.equal(plan.counts.covered, 0);
  assert.equal(plan.counts.new, 1);
  assert.equal(plan.changes[0].changeId, feature.changeId);
});

test("metadata envelope round-trips accepted facts between clones idempotently", (t) => {
  const { repo, parent } = makeRepo(t);
  write(repo, "shared.txt", "base\n");
  git(repo, "add", ".");
  const base = JSON.parse(vlab(repo, "commit", "-m", "base"));
  vlab(repo, "init");

  git(repo, "switch", "-c", "feature", base.commit);
  write(repo, "feature.txt", "one\n");
  git(repo, "add", ".");
  vlab(repo, "commit", "-m", "feature one");
  write(repo, "feature.txt", "one\ntwo\n");
  git(repo, "add", ".");
  vlab(repo, "commit", "-m", "feature two");
  git(repo, "switch", "main");
  vlab(repo, "hard-squash", "feature", "--json");
  git(repo, "switch", "feature");
  write(repo, "continuation.txt", "three\n");
  git(repo, "add", ".");
  const continuation = JSON.parse(vlab(repo, "commit", "-m", "feature continuation"));

  git(repo, "switch", "-c", "conflict-source", base.commit);
  write(repo, "shared.txt", "source\n");
  git(repo, "add", "shared.txt");
  vlab(repo, "commit", "-m", "source conflict");
  git(repo, "switch", "main");
  write(repo, "shared.txt", "target\n");
  git(repo, "add", "shared.txt");
  vlab(repo, "commit", "-m", "target conflict");
  assert.notEqual(vlabResult(repo, "reconcile", "conflict-source").status, 0);
  write(repo, "shared.txt", "resolved\n");
  git(repo, "add", "shared.txt");
  vlab(repo, "reconcile", "--continue", "--json");
  const sourceCatalog = JSON.parse(vlab(repo, "resolve", "list", "--json"));
  assert.equal(sourceCatalog.length, 1);

  write(repo, "docs/spec.md", "# Portable\n\nREQ-PORTABLE-1: Keep identity.\n");
  vlab(repo, "spec", "index", "docs/spec.md", "--json");
  git(repo, "add", ".");
  vlab(repo, "commit", "-m", "portable specification");
  const sourceSpec = JSON.parse(vlab(repo, "spec", "show", "docs/spec.md", "--json"));

  const workspacePath = path.join(parent, "metadata-workspace");
  vlab(repo, "workspace", "create", "metadata-agent", "--path", workspacePath, "--json");
  write(workspacePath, "private-draft.txt", "private\n");
  vlab(workspacePath, "workspace", "checkpoint", "--label", "excluded", "--json");
  vlab(repo, "forecast", "feature", "--json");

  const attachment = git(repo, "rev-parse", "HEAD");
  const unknown = {
    schema: "vcs-lab.note/v1",
    records: [{
      schema: "vcs-lab.future-proof/v9",
      type: "landing",
      id: "future_quarantined",
      absorbedCommits: [continuation.commit],
    }],
  };
  exec(
    "git",
    ["notes", "--ref=vcs-lab", "add", "-f", "-F", "-", attachment],
    repo,
    { input: `${JSON.stringify(unknown, null, 2)}\n` },
  );
  const sourceStatus = JSON.parse(vlab(repo, "metadata", "status", "--json"));
  assert.equal(sourceStatus.scopes.sharedPortable.notes.quarantinedCount, 1);

  const beforePlan = JSON.parse(vlab(repo, "merge-plan", "feature", "--json"));
  assert.equal(
    beforePlan.changes.find((item) => item.changeId === continuation.changeId).status,
    "new",
  );

  const envelopePath = path.join(parent, "portable-metadata");
  const exported = JSON.parse(
    vlab(repo, "metadata", "export", envelopePath, "--json"),
  );
  assert.equal(exported.quarantinedRecords, 1);
  assert.ok(exported.bytes > 0);

  const envelopeManifest = JSON.parse(
    fs.readFileSync(path.join(envelopePath, "manifest.json"), "utf8"),
  );
  const secondEnvelopePath = path.join(parent, "portable-metadata-repeat");
  vlab(repo, "metadata", "export", secondEnvelopePath, "--json");
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(secondEnvelopePath, "manifest.json"), "utf8")),
    envelopeManifest,
  );
  assert.deepEqual(
    fs.readFileSync(path.join(secondEnvelopePath, "objects.bundle")),
    fs.readFileSync(path.join(envelopePath, "objects.bundle")),
  );
  const incomingId = envelopeManifest.records.find(
    (record) => record.type === "landing",
  ).id;
  const conflictDestination = path.join(parent, "conflict-destination");
  git(parent, "clone", "--no-local", repo, conflictDestination);
  git(conflictDestination, "config", "user.name", "VCS Lab Test");
  git(conflictDestination, "config", "user.email", "vcs-lab@example.test");
  const conflictHead = git(conflictDestination, "rev-parse", "HEAD");
  const conflictingRecord = {
    schema: "vcs-lab.note/v1",
    records: [{
      schema: "vcs-lab.application/v1",
      type: "application",
      id: incomingId,
      originCommit: base.commit,
      originChangeId: "ch_conflicting_import",
      appliedCommit: conflictHead,
      appliedChangeId: "ch_conflicting_import",
      targetBefore: base.commit,
      relation: "same-logical-change",
      createdAt: new Date(0).toISOString(),
    }],
  };
  exec(
    "git",
    ["notes", "--ref=vcs-lab", "add", "-f", "-F", "-", conflictHead],
    conflictDestination,
    { input: `${JSON.stringify(conflictingRecord, null, 2)}\n` },
  );
  const conflictNotesBefore = git(
    conflictDestination,
    "rev-parse",
    "refs/notes/vcs-lab",
  );
  const conflictPreview = vlabResult(
    conflictDestination,
    "metadata",
    "import",
    envelopePath,
    "--dry-run",
    "--json",
  );
  assert.notEqual(conflictPreview.status, 0);
  assert.ok(conflictPreview.stdout, conflictPreview.stderr);
  assert.ok(JSON.parse(conflictPreview.stdout).summary.conflicts > 0);
  assert.equal(
    git(conflictDestination, "rev-parse", "refs/notes/vcs-lab"),
    conflictNotesBefore,
  );
  assert.equal(
    git(conflictDestination, "for-each-ref", "--format=%(refname)", "refs/vcs-lab/resolutions"),
    "",
  );

  const tamperedEnvelope = path.join(parent, "tampered-metadata");
  fs.cpSync(envelopePath, tamperedEnvelope, { recursive: true });
  fs.appendFileSync(path.join(tamperedEnvelope, "objects.bundle"), "tampered");
  const tampered = vlabResult(
    conflictDestination,
    "metadata",
    "import",
    tamperedEnvelope,
    "--dry-run",
    "--json",
  );
  assert.notEqual(tampered.status, 0);
  const tamperedRefusal = JSON.parse(tampered.stdout);
  assert.equal(
    tamperedRefusal.code,
    "integrity-check-failed",
    "a tampered payload is classified as an integrity failure, not a parse error",
  );
  assert.match(tamperedRefusal.message, /payload integrity check failed/i);

  const unrelated = path.join(parent, "unrelated");
  fs.mkdirSync(unrelated);
  git(unrelated, "init", "-b", "main");
  git(unrelated, "config", "user.name", "VCS Lab Test");
  git(unrelated, "config", "user.email", "vcs-lab@example.test");
  write(unrelated, "unrelated.txt", "unrelated\n");
  git(unrelated, "add", ".");
  git(unrelated, "commit", "-m", "unrelated root");
  const unrelatedPreview = vlabResult(
    unrelated,
    "metadata",
    "import",
    envelopePath,
    "--dry-run",
    "--json",
  );
  assert.notEqual(unrelatedPreview.status, 0);
  const unrelatedRefusal = JSON.parse(unrelatedPreview.stdout);
  assert.equal(
    unrelatedRefusal.code,
    "unsupported-repository-shape",
    "an unrelated lineage is refused as a shape this import does not support",
  );
  assert.match(unrelatedRefusal.message, /requires a shared root commit/i);

  const destination = path.join(parent, "destination");
  git(parent, "clone", "--no-local", repo, destination);
  git(destination, "config", "core.autocrlf", "false");
  git(destination, "config", "user.name", "VCS Lab Test");
  git(destination, "config", "user.email", "vcs-lab@example.test");
  const preview = JSON.parse(
    vlab(destination, "metadata", "import", envelopePath, "--dry-run", "--json"),
  );
  assert.equal(preview.summary.applicable, true);
  assert.ok(preview.summary.addRecords > 0);
  assert.ok(["same", "fork"].includes(preview.repository.lineageRelation));

  const imported = JSON.parse(
    vlab(destination, "metadata", "import", envelopePath, "--apply", "--json"),
  );
  assert.equal(imported.applied, true);
  const repeated = JSON.parse(
    vlab(destination, "metadata", "import", envelopePath, "--apply", "--json"),
  );
  assert.equal(repeated.summary.addRecords, 0);
  assert.equal(repeated.summary.conflicts, 0);
  assert.equal(repeated.changed, false);

  const afterPlan = JSON.parse(
    vlab(destination, "merge-plan", "origin/feature", "--json"),
  );
  assert.deepEqual(afterPlan.counts, beforePlan.counts);
  assert.deepEqual(
    afterPlan.changes.map(({ changeId, status, proof }) => ({ changeId, status, proof })),
    beforePlan.changes.map(({ changeId, status, proof }) => ({ changeId, status, proof })),
  );
  const destinationCatalog = JSON.parse(vlab(destination, "resolve", "list", "--json"));
  assert.equal(destinationCatalog.length, 1);
  assert.equal(destinationCatalog[0].resultBlob, sourceCatalog[0].resultBlob);
  const destinationSpec = JSON.parse(vlab(destination, "spec", "show", "docs/spec.md", "--json"));
  assert.equal(destinationSpec.manifest.artifactId, sourceSpec.manifest.artifactId);
  assert.deepEqual(
    destinationSpec.manifest.blocks.map((block) => block.id),
    sourceSpec.manifest.blocks.map((block) => block.id),
  );

  const destinationStatus = JSON.parse(vlab(destination, "metadata", "status", "--json"));
  assert.equal(destinationStatus.scopes.sharedPortable.notes.quarantinedCount, 0);
  assert.equal(destinationStatus.scopes.sharedLocal.checkpoints.refCount, 0);
  assert.equal(destinationStatus.scopes.sharedLocal.workspaceRegistry.present, false);
  assert.equal(destinationStatus.scopes.worktreePrivate.pendingOperationCount, 0);
  assert.equal(destinationStatus.scopes.worktreePrivate.forecastCount, 0);
});

test("workspace listing batches one status query per existing path and preserves status contracts", (t) => {
  const { repo, parent } = makeRepo(t);
  write(repo, "base.txt", "base\n");
  write(repo, "rename-me.txt", "rename me\n");
  write(repo, "shared.txt", "shared base\n");
  git(repo, "add", ".");
  const first = JSON.parse(vlab(repo, "commit", "-m", "base", "--json")).commit;
  vlab(repo, "init");
  git(repo, "switch", "-c", "conflicting", first);
  write(repo, "shared.txt", "theirs\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "conflicting edit");
  git(repo, "switch", "main");
  write(repo, "base.txt", "base\nsecond\n");
  git(repo, "add", ".");
  const second = JSON.parse(vlab(repo, "commit", "-m", "second", "--json")).commit;
  assert.notEqual(first, second);

  const traceCommands = (stderr) => stderr
    .split(/\r?\n/)
    .map((line) => line.match(/^\[vlab trace\] [\d.]+ms git (\S+) /)?.[1])
    .filter(Boolean);
  const listTraced = (...args) => spawnSync(
    process.execPath,
    [cli, "workspace", "list", ...args],
    {
      cwd: repo,
      encoding: "utf8",
      env: testEnv({ VLAB_TRACE: "1" }),
    },
  );

  // Baseline: with no workspaces the listing only needs its own repository
  // context (one rev-parse); every additional process below must be one
  // worktree-scoped status query for an existing workspace path.
  const emptyListing = listTraced();
  assert.equal(emptyListing.status, 0, emptyListing.stderr);
  assert.deepEqual(JSON.parse(emptyListing.stdout), []);
  const baselineCommands = traceCommands(emptyListing.stderr);
  assert.deepEqual(baselineCommands, ["rev-parse"]);

  const names = ["clean", "dirty", "detached", "unborn", "archived", "missing", "invalid", "file"];
  const paths = {};
  const created = {};
  for (const name of names) {
    paths[name] = path.join(parent, `ws-${name}`);
    created[name] = JSON.parse(
      vlab(repo, "workspace", "create", name, "--path", paths[name], "--json"),
    );
    assert.equal(created[name].path, paths[name]);
    assert.equal(created[name].compatibilityBranch, `vlab/ws/${name}`);
  }

  // Dirty: a real merge conflict first, then a staged rename, a modified
  // tracked file, an untracked file, and an untracked directory.
  write(paths.dirty, "shared.txt", "ours\n");
  git(paths.dirty, "add", "shared.txt");
  git(paths.dirty, "commit", "-m", "our edit");
  const conflicted = spawnSync("git", ["merge", "conflicting"], {
    cwd: paths.dirty,
    encoding: "utf8",
    env: testEnv(),
  });
  assert.notEqual(conflicted.status, 0);
  assert.equal(fs.existsSync(path.join(paths.dirty, ".git")), true);
  git(paths.dirty, "mv", "rename-me.txt", "renamed.txt");
  write(paths.dirty, "base.txt", "base\nsecond\nlocal edit\n");
  write(paths.dirty, "untracked.txt", "untracked\n");
  write(paths.dirty, "newdir/inner.txt", "inside\n");
  // Untracked names shaped like porcelain v2 header and rename tokens must
  // still count as ordinary entries.
  write(paths.dirty, "# branch.oid 0000", "lookalike header\n");
  write(paths.dirty, "2 lookalike-rename", "lookalike rename\n");
  // Untrimmed porcelain output: a leading-space marker such as " M" must
  // survive so every line, including the first, is counted exactly.
  const porcelainStatus = (cwd) => execFileSync(
    "git",
    ["status", "--porcelain=v1"],
    { cwd, encoding: "utf8", env: testEnv() },
  ).replace(/\r?\n$/, "");
  const dirtyStatusBefore = porcelainStatus(paths.dirty);
  assert.match(dirtyStatusBefore, /^UU shared\.txt$/m);
  assert.match(dirtyStatusBefore, /^R  rename-me\.txt -> renamed\.txt$/m);
  assert.match(dirtyStatusBefore, /^ M base\.txt$/m);
  assert.match(dirtyStatusBefore, /^\?\? untracked\.txt$/m);
  assert.match(dirtyStatusBefore, /^\?\? newdir\/$/m);
  assert.match(dirtyStatusBefore, /^\?\? "# branch\.oid 0000"$/m);
  assert.match(dirtyStatusBefore, /^\?\? "2 lookalike-rename"$/m);
  const dirtyLines = dirtyStatusBefore.split("\n");
  assert.equal(dirtyLines.length, 7);
  const dirtyHead = git(paths.dirty, "rev-parse", "HEAD");
  assert.notEqual(dirtyHead, second);

  // Detached: HEAD at a commit that is not the compatibility branch tip.
  git(paths.detached, "checkout", "--detach", first);
  assert.equal(git(paths.detached, "rev-parse", "HEAD"), first);
  assert.equal(git(paths.detached, "rev-parse", "vlab/ws/detached"), second);

  // Unborn: an orphan branch has no HEAD commit yet, so the exact head is
  // null while the path stays an active worktree and its staged files count.
  git(paths.unborn, "checkout", "--orphan", "fresh-start");
  assert.notEqual(spawnSync("git", ["rev-parse", "--verify", "HEAD"], { cwd: paths.unborn, env: testEnv() }).status, 0);
  const unbornStatus = porcelainStatus(paths.unborn);
  assert.match(unbornStatus, /^A  base\.txt$/m);
  const unbornLines = unbornStatus.split("\n");

  // Archived: clean, no ignored files, removed by the archive command.
  const archived = JSON.parse(
    vlab(repo, "workspace", "archive", "archived", "--json"),
  );
  assert.equal(archived.lifecycle, "archived");
  assert.equal(fs.existsSync(paths.archived), false);

  // Missing: the directory is gone. Invalid: the directory exists but is a
  // plain non-Git directory.
  fs.rmSync(paths.missing, { recursive: true, force: true });
  fs.rmSync(paths.invalid, { recursive: true, force: true });
  fs.mkdirSync(paths.invalid);
  write(paths.invalid, "not-a-worktree.txt", "plain directory\n");
  assert.equal(fs.existsSync(path.join(paths.invalid, ".git")), false);
  // File: the registered path exists but is a regular file, which Git
  // cannot even be started in.
  fs.rmSync(paths.file, { recursive: true, force: true });
  fs.writeFileSync(paths.file, "not a directory\n");
  assert.equal(fs.statSync(paths.file).isDirectory(), false);

  const callerBefore = {
    head: git(repo, "rev-parse", "HEAD"),
    status: git(repo, "status", "--porcelain=v1"),
    worktrees: git(repo, "worktree", "list", "--porcelain"),
  };
  assert.equal(callerBefore.status, "");

  const traced = listTraced();
  assert.equal(traced.status, 0, traced.stderr);
  const listing = JSON.parse(traced.stdout);
  assert.deepEqual(listing.map((workspace) => workspace.name), names);
  const byName = Object.fromEntries(
    listing.map((workspace) => [workspace.name, workspace]),
  );
  for (const name of names) {
    assert.equal(byName[name].id, created[name].id);
    assert.equal(byName[name].name, name);
    assert.equal(byName[name].path, paths[name]);
    assert.equal(byName[name].compatibilityBranch, `vlab/ws/${name}`);
    assert.equal(byName[name].lifecycle, name === "archived" ? "archived" : "active");
  }

  assert.equal(byName.clean.status, "active");
  assert.equal(byName.clean.pathStatus, "active");
  assert.equal(byName.clean.head, second);
  assert.equal(byName.clean.head, git(paths.clean, "rev-parse", "HEAD"));
  assert.equal(byName.clean.dirtyFiles, 0);

  assert.equal(byName.dirty.status, "active");
  assert.equal(byName.dirty.pathStatus, "active");
  assert.equal(byName.dirty.head, dirtyHead);
  assert.equal(byName.dirty.dirtyFiles, dirtyLines.length);

  assert.equal(byName.detached.status, "active");
  assert.equal(byName.detached.pathStatus, "active");
  assert.equal(byName.detached.head, first);
  assert.equal(byName.detached.head, git(paths.detached, "rev-parse", "HEAD"));
  assert.equal(byName.detached.dirtyFiles, 0);

  assert.equal(byName.unborn.status, "active");
  assert.equal(byName.unborn.pathStatus, "active");
  assert.equal(byName.unborn.head, null);
  assert.equal(byName.unborn.dirtyFiles, unbornLines.length);

  assert.equal(byName.archived.status, "archived");
  assert.equal(byName.archived.pathStatus, "missing");
  assert.equal(byName.archived.head, null);
  assert.equal(byName.archived.dirtyFiles, null);

  assert.equal(byName.missing.status, "missing");
  assert.equal(byName.missing.pathStatus, "missing");
  assert.equal(byName.missing.head, null);
  assert.equal(byName.missing.dirtyFiles, null);

  assert.equal(byName.invalid.status, "invalid");
  assert.equal(byName.invalid.pathStatus, "invalid");
  assert.equal(byName.invalid.head, null);
  assert.equal(byName.invalid.dirtyFiles, null);

  assert.equal(byName.file.status, "invalid");
  assert.equal(byName.file.pathStatus, "invalid");
  assert.equal(byName.file.head, null);
  assert.equal(byName.file.dirtyFiles, null);

  // Process bound: exactly one `git status` per existing directory (the
  // active clean, dirty, detached, and unborn worktrees plus the invalid
  // plain directory; the archived and missing paths do not exist and the
  // file path is classified without Git). Only a directory whose status
  // query fails pays one extra rev-parse probe to tell "not a work tree"
  // from "unreadable work tree"; healthy workspaces need no per-workspace
  // rev-parse or HEAD resolution beyond the baseline context probe.
  const existingPaths = names.filter((name) =>
    fs.existsSync(paths[name]) && fs.statSync(paths[name]).isDirectory(),
  );
  assert.deepEqual(existingPaths, ["clean", "dirty", "detached", "unborn", "invalid"]);
  const invalidDirectories = existingPaths.filter((name) => byName[name].pathStatus === "invalid");
  assert.deepEqual(invalidDirectories, ["invalid"]);
  const commands = traceCommands(traced.stderr);
  assert.equal(
    traced.stderr.split(/\r?\n/).filter((line) => /git status/.test(line)).length,
    existingPaths.length,
  );
  assert.equal(commands.filter((command) => command === "status").length, existingPaths.length);
  assert.deepEqual(
    commands.filter((command) => command !== "status"),
    [...baselineCommands, ...invalidDirectories.map(() => "rev-parse")],
  );
  assert.equal(
    commands.length,
    baselineCommands.length + existingPaths.length + invalidDirectories.length,
  );

  // Forced Git-session mode is observably identical.
  const tracedSession = listTraced("--git-session");
  assert.equal(tracedSession.status, 0, tracedSession.stderr);
  assert.deepEqual(JSON.parse(tracedSession.stdout), listing);
  assert.deepEqual(traceCommands(tracedSession.stderr), commands);

  assert.deepEqual({
    head: git(repo, "rev-parse", "HEAD"),
    status: git(repo, "status", "--porcelain=v1"),
    worktrees: git(repo, "worktree", "list", "--porcelain"),
  }, callerBefore);
  assert.equal(porcelainStatus(paths.dirty), dirtyStatusBefore);
  assert.equal(git(paths.dirty, "rev-parse", "HEAD"), dirtyHead);
  assert.equal(git(paths.dirty, "rev-parse", "MERGE_HEAD"), git(repo, "rev-parse", "conflicting"));

  // A recognized work tree whose status cannot be read is an error, not a
  // silently "invalid" entry: corrupt the clean workspace's private index.
  const cleanGitDir = path.resolve(paths.clean, git(paths.clean, "rev-parse", "--git-dir"));
  fs.writeFileSync(path.join(cleanGitDir, "index"), "GARBAGE");
  const corrupt = vlabResult(repo, "workspace", "list");
  assert.notEqual(corrupt.status, 0);
  assert.match(corrupt.stderr, /git status --porcelain=v2 --branch -z failed in workspace 'clean'/);
  assert.match(corrupt.stderr, /index/i);
});

test("batched resolution catalog lists retained records newest-first and quarantines mismatched retention state", (t) => {
  const { repo } = makeRepo(t);
  write(repo, "shared.txt", "base\n");
  git(repo, "add", ".");
  const base = JSON.parse(vlab(repo, "commit", "-m", "base"));
  vlab(repo, "init");
  const headBefore = git(repo, "rev-parse", "HEAD");

  const baseBlob = writeBlob(repo, "base\n");
  const oursBlob = writeBlob(repo, "ours\n");
  const resultBlob = writeBlob(repo, "resolved\n");
  const otherResultBlob = writeBlob(repo, "a different resolution\n");
  const stagesFor = (theirs) => ({
    base: { mode: "100644", blob: baseBlob },
    ours: { mode: "100644", blob: oursBlob },
    theirs: { mode: "100644", blob: writeBlob(repo, theirs) },
  });
  const publish = (options) =>
    publishRetainedResolution(repo, { originatingCommit: base.commit, ...options });

  // (a) Three valid records. Retention refs are discovered in signature
  // order, so createdAt is assigned in that order and the records are
  // inserted in yet another order: neither discovery order nor insertion
  // order is newest-first.
  const validStages = ["theirs one\n", "theirs two\n", "theirs three\n"]
    .map(stagesFor)
    .sort((left, right) =>
      resolutionSignature(left).localeCompare(resolutionSignature(right)),
    );
  const valid = [];
  for (const index of [1, 2, 0]) {
    valid[index] = publish({
      id: `res_valid_${index}`,
      stages: validStages[index],
      createdAt: `2026-03-0${index + 1}T00:00:00.000Z`,
      originalPath: `path-${index}.txt`,
      resultBlob,
    });
  }
  assert.equal(new Set(valid.map((entry) => entry.record.signature)).size, 3);

  // (b) A deleted result: no result blob, an empty retention tree, and a ref
  // ending in /deleted.
  const deleted = publish({
    id: "res_deleted",
    stages: stagesFor("theirs deleted\n"),
    createdAt: "2026-03-02T12:00:00.000Z",
  });
  assert.ok(deleted.ref.endsWith("/deleted"));
  assert.equal(git(repo, "ls-tree", deleted.commit), "");

  // (c) The stored ref differs from the ref the record is discovered under.
  const refMismatchSignature = resolutionSignature(stagesFor("theirs ref\n"));
  const refMismatch = publish({
    id: "res_ref_mismatch",
    stages: stagesFor("theirs ref mismatch\n"),
    createdAt: "2026-05-01T00:00:00.000Z",
    resultBlob,
    record: { ref: `refs/vcs-lab/resolutions/${refMismatchSignature}/${resultBlob}` },
  });
  assert.notEqual(refMismatch.record.ref, refMismatch.ref);

  // (d) The stored resolutionCommit is a real commit but not the discovered
  // retention commit.
  publish({
    id: "res_commit_mismatch",
    stages: stagesFor("theirs commit mismatch\n"),
    createdAt: "2026-05-02T00:00:00.000Z",
    resultBlob,
    record: { resolutionCommit: base.commit },
  });

  // (e) A well-formed signature that does not match the ordered stages.
  publish({
    id: "res_signature_mismatch",
    stages: stagesFor("theirs signature mismatch\n"),
    createdAt: "2026-05-03T00:00:00.000Z",
    resultBlob,
    record: { signature: resolutionSignature(stagesFor("unrelated stages\n")) },
  });

  // (f) The retention tree holds a different blob than the declared result.
  publish({
    id: "res_missing_blob",
    stages: stagesFor("theirs missing blob\n"),
    createdAt: "2026-05-04T00:00:00.000Z",
    resultBlob,
    treeBlob: otherResultBlob,
  });

  // (g) A retention ref that names a tree instead of a commit.
  const treeRef = `refs/vcs-lab/resolutions/${resolutionSignature(stagesFor("theirs tree\n"))}/${resultBlob}`;
  git(repo, "update-ref", treeRef, git(repo, "rev-parse", "HEAD^{tree}"));

  // (g2) A dangling retention ref whose object does not exist at all; the
  // files ref backend is written directly because update-ref refuses it.
  // The scan must neither abort nor truncate the rest of the catalog.
  const danglingRef = `refs/vcs-lab/resolutions/${resolutionSignature(stagesFor("theirs dangling\n"))}/${resultBlob}`;
  const danglingOid = "1".repeat(resultBlob.length);
  fs.mkdirSync(path.join(repo, ".git", path.dirname(danglingRef)), { recursive: true });
  fs.writeFileSync(path.join(repo, ".git", danglingRef), `${danglingOid}\n`);
  assert.equal(
    git(repo, "for-each-ref", "--format=%(objectname)", danglingRef),
    danglingOid,
  );

  // (h) A retention ref that names an annotated tag of a valid retention
  // commit; it must peel exactly like <ref>^{commit}.
  const tagged = publish({
    id: "res_tagged",
    stages: stagesFor("theirs tagged\n"),
    createdAt: "2026-02-01T00:00:00.000Z",
    resultBlob,
  });
  git(repo, "tag", "-a", "-m", "retention tag", "retention-tag", tagged.commit);
  const tagObject = git(repo, "rev-parse", "refs/tags/retention-tag");
  git(repo, "update-ref", tagged.ref, tagObject);
  git(repo, "tag", "-d", "retention-tag");
  assert.notEqual(git(repo, "rev-parse", tagged.ref), tagged.commit);
  assert.equal(git(repo, "rev-parse", `${tagged.ref}^{commit}`), tagged.commit);

  // (i) A retention commit whose note is not JSON at all.
  const legacy = publish({
    id: "res_legacy",
    stages: stagesFor("theirs legacy\n"),
    createdAt: "2026-05-05T00:00:00.000Z",
    resultBlob,
    note: () => "legacy free-form note\n",
  });

  // (j) A note stored as a bare JSON array of records. vlab never wrote this
  // shape; it is not a versioned record container, so the catalog ignores it
  // exactly as `metadata validate` quarantines it.
  const bareArray = publish({
    id: "res_bare_array",
    stages: stagesFor("theirs bare array\n"),
    createdAt: "2026-04-01T00:00:00.000Z",
    resultBlob,
    note: (record) => [record],
  });

  const listed = (entry) => ({
    ...entry.record,
    attachedTo: entry.commit,
    discoveredRef: entry.ref,
    commit: entry.commit,
  });
  const expected = [
    listed(valid[2]),
    listed(deleted),
    listed(valid[1]),
    listed(valid[0]),
    listed(tagged),
  ];
  const catalog = JSON.parse(vlab(repo, "resolve", "list", "--json"));
  assert.deepEqual(catalog, expected);
  assert.deepEqual(
    catalog.map((record) => record.createdAt),
    [...catalog.map((record) => record.createdAt)].sort().reverse(),
  );
  for (const record of catalog) {
    assert.equal(record.ref, record.discoveredRef);
    assert.equal(record.resolutionCommit, record.commit);
    assert.equal(record.attachedTo, record.commit);
    assert.equal(resolutionSignature(record), record.signature);
  }
  assert.equal(catalog.find((record) => record.id === "res_deleted").resultBlob, null);
  assert.equal(catalog.find((record) => record.id === "res_deleted").resultMode, null);
  assert.equal(catalog.find((record) => record.id === "res_tagged").commit, tagged.commit);
  const plain = vlabResult(repo, "resolve", "list");
  assert.equal(plain.status, 0, plain.stderr);
  assert.match(plain.stdout, /res_valid_2/);

  // Ordinary and forced Git-session modes agree, whether forced by flag or
  // by environment.
  assert.deepEqual(
    JSON.parse(vlab(repo, "resolve", "list", "--json", "--git-session")),
    catalog,
  );
  for (const VLAB_GIT_SESSION of ["0", "1"]) {
    const result = spawnSync(process.execPath, [cli, "resolve", "list", "--json"], {
      cwd: repo,
      encoding: "utf8",
      env: testEnv({ VLAB_GIT_SESSION }),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), catalog);
  }

  // Listing never touches the caller's HEAD, index, or files.
  assert.equal(git(repo, "rev-parse", "HEAD"), headBefore);
  assert.equal(git(repo, "status", "--porcelain=v1"), "");
  assert.equal(readText(repo, "shared.txt"), "base\n");

  // Metadata validation reports the quarantined records as errors.
  const validation = vlabResult(repo, "metadata", "validate", "--json");
  assert.notEqual(validation.status, 0);
  const report = JSON.parse(validation.stdout);
  assert.equal(report.summary.valid, false);
  assert.ok(report.summary.errors > 0);
  const errorCodesFor = (subject) =>
    report.diagnostics
      .filter((item) => item.subject === subject && item.severity === "error")
      .map((item) => item.code);
  assert.ok(errorCodesFor("res_ref_mismatch").includes("missing-resolution-ref"));
  assert.ok(errorCodesFor("res_commit_mismatch").includes("malformed-record"));
  assert.ok(errorCodesFor("res_signature_mismatch").includes("resolution-signature-mismatch"));
  assert.ok(errorCodesFor("res_missing_blob").includes("missing-resolution-blob"));
  assert.ok(errorCodesFor(treeRef).includes("missing-resolution-record"));
  assert.ok(errorCodesFor(danglingRef).includes("missing-resolution-record"));
  assert.ok(errorCodesFor(legacy.commit).includes("malformed-record"));
  assert.ok(errorCodesFor(bareArray.commit).includes("malformed-record"));
  assert.ok(errorCodesFor(bareArray.ref).includes("missing-resolution-record"));
  assert.ok(!catalog.some((record) => record.id === "res_bare_array"));
  // Validation peels the tag-pointing retention ref exactly as the catalog
  // does, so the tagged record and its ref are accepted without diagnostics
  // while the reported ref target stays raw.
  for (const id of ["res_valid_0", "res_valid_1", "res_valid_2", "res_deleted", "res_tagged"]) {
    assert.deepEqual(errorCodesFor(id), []);
  }
  assert.deepEqual(errorCodesFor(tagged.ref), []);
  const resolutions = report.scopes.sharedPortable.resolutions;
  assert.equal(resolutions.acceptedRefCount, 5);
  assert.deepEqual(
    resolutions.refs.find((entry) => entry.ref === tagged.ref),
    { ref: tagged.ref, oid: tagObject },
  );
});

test("batched resolution catalog scans use a bounded number of Git processes as refs grow", (t) => {
  const { repo } = makeRepo(t);
  write(repo, "shared.txt", "base\n");
  git(repo, "add", ".");
  const base = JSON.parse(vlab(repo, "commit", "-m", "base"));
  vlab(repo, "init");

  // Empirical baseline: an empty catalog traces exactly one Git process, the
  // for-each-ref discovery scan, and no repository-context probe, so the CLI
  // itself adds no context calls before dispatching `resolve list`. The only
  // context call on the populated path is the single rev-parse that
  // acceptedCausalRecords performs (once, cached) to learn the object format
  // before structural validation. The batched scan is therefore bounded by
  // for-each-ref + cat-file (peel ref targets) + notes list + cat-file (note
  // blobs) + cat-file (referenced objects) + cat-file (retained results) = 6
  // processes plus that one context probe, independent of how many retention
  // refs exist. Since issue #42 those four object reads are served by one
  // object session, so the same six operations cost three processes where
  // sessions are enabled; without one they still cost six, which is the shape
  // asserted separately below.
  const empty = tracedGitCommands(repo, "resolve", "list", "--json");
  assert.deepEqual(JSON.parse(empty.stdout), []);
  assert.deepEqual(empty.commands, ["for-each-ref"]);
  // Asking for a session must not open one here: the ref scan answers that the
  // catalog is empty before any object read is needed, so a repository with no
  // retention refs never pays for a persistent process (issue #42).
  const emptySession = tracedGitCommands(repo, "resolve", "list", "--json", "--git-session");
  assert.deepEqual(JSON.parse(emptySession.stdout), []);
  assert.deepEqual(emptySession.processes, ["for-each-ref"]);
  const repositoryContextCalls = 1;
  const processBound = 6 + repositoryContextCalls;

  const baseBlob = writeBlob(repo, "base\n");
  const oursBlob = writeBlob(repo, "ours\n");
  const resultBlob = writeBlob(repo, "resolved\n");
  let published = 0;
  const publishMany = (count) => {
    for (let index = 0; index < count; index += 1) {
      const ordinal = published++;
      publishRetainedResolution(repo, {
        id: `res_scale_${String(ordinal).padStart(3, "0")}`,
        stages: {
          base: { mode: "100644", blob: baseBlob },
          ours: { mode: "100644", blob: oursBlob },
          theirs: { mode: "100644", blob: writeBlob(repo, `theirs ${ordinal}\n`) },
        },
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, ordinal)).toISOString(),
        originalPath: `scale-${ordinal}.txt`,
        originatingCommit: base.commit,
        // Mix retained and deleted results so both batched lookups run.
        resultBlob: ordinal % 4 === 3 ? null : resultBlob,
      });
    }
  };

  publishMany(4);
  const small = tracedGitCommands(repo, "resolve", "list", "--json");
  assert.equal(JSON.parse(small.stdout).length, 4);
  assert.ok(
    small.commands.length <= processBound,
    `expected at most ${processBound} Git processes, traced: ${small.commands.join(", ")}`,
  );
  assert.equal(small.commands.filter((command) => command === "notes").length, 1);
  assert.equal(
    small.commands.filter((command) => command === "rev-parse").length,
    repositoryContextCalls,
  );

  publishMany(12);
  const large = tracedGitCommands(repo, "resolve", "list", "--json");
  const catalog = JSON.parse(large.stdout);
  assert.equal(catalog.length, 16);
  assert.deepEqual(large.commands, small.commands);
  assert.deepEqual(
    catalog.map((record) => record.id),
    Array.from({ length: 16 }, (_, index) => `res_scale_${String(15 - index).padStart(3, "0")}`),
  );
  assert.equal(catalog.filter((record) => record.resultBlob === null).length, 4);

  const session = tracedGitCommands(repo, "resolve", "list", "--json", "--git-session");
  assert.deepEqual(JSON.parse(session.stdout), catalog);
  assert.ok(session.commands.length <= processBound, session.commands.join(", "));

  // The catalog costs the same operations either way; what a session changes is
  // how many of them start a process (issue #42). Without one, every batched
  // object read is its own process; with one, a single persistent `cat-file`
  // serves the ref peel, the note blobs, the referenced-object validation, and
  // the retained-result inspection.
  const withoutSession = tracedGitCommands(repo, "resolve", "list", "--json", "--no-git-session");
  assert.deepEqual(JSON.parse(withoutSession.stdout), catalog);
  assert.equal(
    withoutSession.processes.filter((command) => command === "cat-file").length,
    4,
    `expected four unsessioned object reads, traced: ${withoutSession.processes.join(", ")}`,
  );
  assert.ok(
    session.processes.length < withoutSession.processes.length,
    `a session must start fewer processes: ${session.processes.join(", ")} vs ${withoutSession.processes.join(", ")}`,
  );
  assert.equal(
    session.processes.filter((command) => command.startsWith("cat-file")).length,
    1,
    `expected one persistent object process, traced: ${session.processes.join(", ")}`,
  );
});

test("metadata export and import carry a retention ref that names an annotated tag of its retention commit", (t) => {
  const { repo, parent } = makeRepo(t);
  // The stage blobs are committed so a fresh clone carries every object the
  // resolution record references; the retention commits travel in the bundle.
  write(repo, "shared.txt", "base\n");
  write(repo, "stages/ours.txt", "ours\n");
  write(repo, "stages/theirs-tagged.txt", "theirs tagged\n");
  write(repo, "stages/theirs-bare-array.txt", "theirs bare array\n");
  git(repo, "add", ".");
  const base = JSON.parse(vlab(repo, "commit", "-m", "base"));
  vlab(repo, "init");

  const baseBlob = writeBlob(repo, "base\n");
  const oursBlob = writeBlob(repo, "ours\n");
  const resultBlob = writeBlob(repo, "resolved\n");
  const stagesFor = (theirs) => ({
    base: { mode: "100644", blob: baseBlob },
    ours: { mode: "100644", blob: oursBlob },
    theirs: { mode: "100644", blob: writeBlob(repo, theirs) },
  });

  // A valid retention whose ref is then repointed at an annotated tag of the
  // retention commit.
  const tagged = publishRetainedResolution(repo, {
    id: "res_tagged",
    stages: stagesFor("theirs tagged\n"),
    createdAt: "2026-02-01T00:00:00.000Z",
    originatingCommit: base.commit,
    resultBlob,
  });
  git(repo, "tag", "-a", "-m", "retention tag", "retention-tag", tagged.commit);
  const tagObject = git(repo, "rev-parse", "refs/tags/retention-tag");
  git(repo, "update-ref", tagged.ref, tagObject);
  git(repo, "tag", "-d", "retention-tag");
  assert.notEqual(tagObject, tagged.commit);
  assert.equal(git(repo, "rev-parse", tagged.ref), tagObject);

  // A note stored as a bare JSON array is not a versioned record container:
  // receipts, the catalog, validation, and export all ignore it.
  const bareArray = publishRetainedResolution(repo, {
    id: "res_bare_array",
    stages: stagesFor("theirs bare array\n"),
    createdAt: "2026-03-01T00:00:00.000Z",
    originatingCommit: base.commit,
    resultBlob,
    note: (record) => [record],
  });
  const receipts = JSON.parse(vlab(repo, "receipts", "--json"));
  assert.ok(receipts.some((record) => record.id === "res_tagged"));
  assert.ok(!receipts.some((record) => record.id === "res_bare_array"));
  assert.deepEqual(
    JSON.parse(vlab(repo, "resolve", "list", "--json")).map((record) => record.id),
    ["res_tagged"],
  );

  const sourceStatus = JSON.parse(vlab(repo, "metadata", "status", "--json"));
  assert.equal(sourceStatus.scopes.sharedPortable.resolutions.acceptedRefCount, 1);
  assert.deepEqual(
    sourceStatus.scopes.sharedPortable.resolutions.refs.find((entry) => entry.ref === tagged.ref),
    { ref: tagged.ref, oid: tagObject },
  );
  assert.ok(
    sourceStatus.diagnostics.some((item) =>
      item.code === "missing-resolution-record" && item.subject === bareArray.ref,
    ),
  );

  const envelopePath = path.join(parent, "tagged-metadata");
  const exported = JSON.parse(vlab(repo, "metadata", "export", envelopePath, "--json"));
  assert.equal(exported.records, 1);
  assert.equal(exported.refs, 2);
  const manifest = JSON.parse(fs.readFileSync(path.join(envelopePath, "manifest.json"), "utf8"));
  assert.deepEqual(
    manifest.refs.filter((entry) => entry.ref.startsWith("refs/vcs-lab/resolutions/")),
    [{ ref: tagged.ref, bundleRef: tagged.ref, oid: tagObject }],
  );
  assert.deepEqual(manifest.records.map((record) => record.id), ["res_tagged"]);

  const destination = path.join(parent, "destination");
  git(parent, "clone", "--no-local", repo, destination);
  git(destination, "config", "core.autocrlf", "false");
  git(destination, "config", "user.name", "VCS Lab Test");
  git(destination, "config", "user.email", "vcs-lab@example.test");
  assert.equal(
    git(destination, "for-each-ref", "--format=%(refname)", "refs/vcs-lab/resolutions"),
    "",
  );

  const preview = JSON.parse(
    vlab(destination, "metadata", "import", envelopePath, "--dry-run", "--json"),
  );
  assert.equal(preview.summary.applicable, true);
  assert.equal(preview.summary.addRecords, 1);
  assert.deepEqual(
    preview.refs.find((entry) => entry.ref === tagged.ref),
    { ref: tagged.ref, incoming: tagObject, existing: null, action: "create" },
  );

  const imported = JSON.parse(
    vlab(destination, "metadata", "import", envelopePath, "--apply", "--json"),
  );
  assert.equal(imported.applied, true);
  assert.equal(imported.changed, true);
  assert.equal(git(destination, "rev-parse", tagged.ref), tagObject);
  assert.equal(git(destination, "rev-parse", `${tagged.ref}^{commit}`), tagged.commit);
  assert.equal(git(destination, "cat-file", "-t", tagObject), "tag");
  assert.equal(
    git(destination, "for-each-ref", "--format=%(refname)", "refs/vcs-lab/import-staging"),
    "",
  );
  const destinationCatalog = JSON.parse(vlab(destination, "resolve", "list", "--json"));
  assert.deepEqual(destinationCatalog.map((record) => record.id), ["res_tagged"]);
  assert.equal(destinationCatalog[0].commit, tagged.commit);
  assert.equal(destinationCatalog[0].discoveredRef, tagged.ref);
  const destinationValidation = vlabResult(destination, "metadata", "validate", "--json");
  assert.equal(destinationValidation.status, 0, destinationValidation.stderr);
  assert.equal(JSON.parse(destinationValidation.stdout).summary.valid, true);

  const repeated = JSON.parse(
    vlab(destination, "metadata", "import", envelopePath, "--apply", "--json"),
  );
  assert.equal(repeated.applied, true);
  assert.equal(repeated.changed, false);
  assert.equal(repeated.summary.conflicts, 0);
  assert.equal(repeated.summary.addRecords, 0);
  assert.equal(
    repeated.refs.find((entry) => entry.ref === tagged.ref).action,
    "noop",
  );
  assert.equal(git(destination, "rev-parse", tagged.ref), tagObject);

  // Ref targets are compared raw: a destination that already names the
  // retention commit directly conflicts with the tag-pointing source ref.
  const direct = path.join(parent, "direct");
  git(parent, "clone", "--no-local", repo, direct);
  git(direct, "config", "user.name", "VCS Lab Test");
  git(direct, "config", "user.email", "vcs-lab@example.test");
  git(direct, "fetch", "--no-tags", repo, `${tagged.ref}:${tagged.ref}`);
  git(direct, "update-ref", tagged.ref, tagged.commit);
  assert.equal(git(direct, "rev-parse", tagged.ref), tagged.commit);
  const directPreview = vlabResult(direct, "metadata", "import", envelopePath, "--dry-run", "--json");
  assert.notEqual(directPreview.status, 0);
  const directReport = JSON.parse(directPreview.stdout);
  assert.equal(directReport.summary.applicable, false);
  assert.deepEqual(
    directReport.refs.find((entry) => entry.ref === tagged.ref),
    { ref: tagged.ref, incoming: tagObject, existing: tagged.commit, action: "conflict" },
  );
  assert.equal(git(direct, "rev-parse", tagged.ref), tagged.commit);
});

// ---------------------------------------------------------------------------
// Merge-tree forecast engine
// ---------------------------------------------------------------------------

function vlabWithEngine(cwd, engine, ...args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8",
    env: testEnv({
      VLAB_FORECAST_ENGINE: engine,
    }),
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function forecastWithEngine(cwd, engine, ...args) {
  return JSON.parse(vlabWithEngine(cwd, engine, ...args, "--json"));
}

/**
 * Project a forecast onto the fields both engines must agree on, dropping
 * identifiers, timings, and engine bookkeeping that legitimately differ
 * between runs.
 */
function normalizeForecast(forecast) {
  return {
    status: forecast.status,
    blockedReason: forecast.blockedReason,
    predictedResultTree: forecast.predictedResultTree,
    partialResultTree: forecast.partialResultTree,
    exactStateEqualityAfter: forecast.exactStateEqualityAfter,
    counts: forecast.counts,
    simulatedChanges: forecast.simulatedChanges,
    remainingChanges: forecast.remainingChanges,
    planFingerprint: forecast.planFingerprint,
    planChanges: forecast.plan.changes,
    approvedResolutions: forecast.approvedResolutions,
    approvedSpecMerges: forecast.approvedSpecMerges,
    steps: forecast.steps.map((step) => ({
      sourceCommit: step.sourceCommit,
      changeId: step.changeId,
      outcome: step.outcome,
      relation: step.relation ?? null,
      targetBeforeTree: step.targetBeforeTree,
      resultTree: step.resultTree ?? null,
      conflicts: (step.conflicts ?? []).map((conflict) => ({
        path: conflict.path,
        candidates: conflict.candidates.length,
      })),
      resolutions: (step.resolutions ?? []).map((resolution) => ({
        path: resolution.path,
        resultBlob: resolution.resultBlob,
      })),
      semanticMerges: (step.semanticMerges ?? []).map((merge) => ({
        path: merge.path,
        resultMarkdownHash: merge.resultMarkdownHash,
        resultManifestHash: merge.resultManifestHash,
      })),
    })),
  };
}

function forecastFileCount(repo) {
  const directory = path.resolve(
    repo,
    git(repo, "rev-parse", "--git-path", "vcs-lab/forecasts"),
  );
  return fs.existsSync(directory) ? fs.readdirSync(directory).length : 0;
}

function numberedLines(prefix, count = 12) {
  return `${Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`).join("\n")}\n`;
}

function replaceLine(repo, relative, lineNumber, content) {
  const lines = readText(repo, relative).split("\n");
  lines[lineNumber - 1] = content;
  write(repo, relative, lines.join("\n"));
}

test("merge-tree forecasts of a clean queue match the worktree oracle without a temporary worktree", (t) => {
  if (skipWithoutMergeTreeEngine(t)) return;
  const { repo } = makeRepo(t);
  write(repo, "shared.txt", numberedLines("shared"));
  write(repo, "old-name.txt", numberedLines("renamed"));
  write(repo, "app.txt", numberedLines("app"));
  write(repo, "mode.sh", "#!/bin/sh\necho hello\n");
  fs.writeFileSync(
    path.join(repo, "blob.bin"),
    Buffer.from([0, 1, 2, 3, 255, 254, 0, 10, 13, 0]),
  );
  git(repo, "add", ".");
  const base = JSON.parse(vlab(repo, "commit", "-m", "base"));
  vlab(repo, "init");

  // The target renames a file the source later edits and touches the top of
  // a file the source edits at the bottom.
  git(repo, "mv", "old-name.txt", "new-name.txt");
  vlab(repo, "commit", "-m", "target renames old-name");
  replaceLine(repo, "shared.txt", 1, "shared 1 (target)");
  git(repo, "add", ".");
  vlab(repo, "commit", "-m", "target edits shared top");

  git(repo, "switch", "-c", "feature", base.commit);
  const sourceCommits = [];
  const commitSource = (subject) => {
    git(repo, "add", "-A");
    sourceCommits.push(JSON.parse(vlab(repo, "commit", "-m", subject)));
  };
  write(repo, "source/one.txt", "one\n");
  commitSource("source adds one");
  replaceLine(repo, "shared.txt", 12, "shared 12 (source)");
  commitSource("source edits shared bottom");
  replaceLine(repo, "old-name.txt", 6, "renamed 6 (source)");
  commitSource("source edits the renamed file");
  // On POSIX `git add -A` re-reads the mode from disk, so the executable bit
  // must be set on the file as well as in the index for the step to commit.
  fs.chmodSync(path.join(repo, "mode.sh"), 0o755);
  git(repo, "update-index", "--chmod=+x", "mode.sh");
  commitSource("source marks mode.sh executable");
  fs.writeFileSync(
    path.join(repo, "blob.bin"),
    Buffer.from([0, 9, 8, 7, 255, 0, 1, 10, 13, 0, 42]),
  );
  commitSource("source rewrites the binary");
  write(repo, "source/two.txt", "two\n");
  commitSource("source adds two");
  replaceLine(repo, "app.txt", 1, "app 1 (source)");
  commitSource("source edits app top");
  git(repo, "rm", "-q", "source/one.txt");
  commitSource("source removes one");
  replaceLine(repo, "shared.txt", 11, "shared 11 (source)");
  commitSource("source edits shared again");
  write(repo, "docs/notes.md", "# Notes\n");
  commitSource("source adds notes");
  replaceLine(repo, "app.txt", 12, "app 12 (source)");
  commitSource("source edits app bottom");
  write(repo, "source/three.txt", "three\n");
  commitSource("source adds three");
  assert.equal(sourceCommits.length, 12);
  git(repo, "switch", "main");

  const before = {
    head: git(repo, "rev-parse", "HEAD"),
    status: git(repo, "status", "--porcelain=v1"),
    worktrees: git(repo, "worktree", "list", "--porcelain"),
  };
  const worktree = forecastWithEngine(repo, "worktree", "forecast", "feature");
  const mergeTree = forecastWithEngine(repo, "merge-tree", "forecast", "feature");
  const flagged = JSON.parse(
    vlab(repo, "forecast", "feature", "--forecast-engine", "merge-tree", "--json"),
  );
  const inlineFlag = JSON.parse(
    vlab(repo, "forecast", "feature", "--forecast-engine=merge-tree", "--json"),
  );

  assert.equal(worktree.engine, "worktree");
  assert.equal(worktree.status, "complete");
  assert.equal(worktree.steps.length, 12);
  assert.ok(worktree.steps.every((step) => step.outcome === "clean"));
  assert.ok(worktree.timings.worktree.totalMs > 0);
  assert.deepEqual(normalizeForecast(mergeTree), normalizeForecast(worktree));
  assert.deepEqual(normalizeForecast(flagged), normalizeForecast(worktree));
  assert.deepEqual(normalizeForecast(inlineFlag), normalizeForecast(worktree));
  assert.equal(flagged.engine, "merge-tree");
  assert.equal(inlineFlag.engine, "merge-tree");
  assert.equal(mergeTree.engine, "merge-tree");
  assert.deepEqual(mergeTree.fallbacks, []);
  assert.equal(mergeTree.schema, "vcs-lab.forecast/v2");
  assert.equal(mergeTree.predictedResultTree, worktree.predictedResultTree);
  assert.deepEqual(mergeTree.timings.worktree, {
    setupMs: 0,
    applicationMs: 0,
    cleanupMs: 0,
    totalMs: 0,
  });
  for (const phase of ["setupMs", "applicationMs", "cleanupMs", "totalMs"]) {
    assert.ok(mergeTree.timings.mergeTree[phase] >= 0, phase);
  }
  assert.ok(
    mergeTree.timings.mergeTree.totalMs >= mergeTree.timings.mergeTree.applicationMs,
  );
  const commands = mergeTree.timings.git.byCommand.map((item) => item.command);
  const session = mergeTree.timings.git.byCommand.find(
    (item) => item.command === "merge-tree-session",
  );
  assert.ok(session, commands.join(", "));
  assert.equal(session.processes, 1);
  assert.equal(session.count, mergeTree.steps.length);
  assert.equal(session.sessionQueries, mergeTree.steps.length);
  assert.ok(!commands.includes("worktree"), commands.join(", "));
  assert.ok(!commands.includes("cherry-pick"), commands.join(", "));
  const worktreeCommands = worktree.timings.git.byCommand.map((item) => item.command);
  assert.ok(worktreeCommands.includes("cherry-pick"), worktreeCommands.join(", "));
  assert.ok(
    !worktreeCommands.includes("merge-tree-session"),
    worktreeCommands.join(", "),
  );

  const sessionRun = forecastWithEngine(
    repo,
    "merge-tree",
    "forecast",
    "feature",
    "--git-session",
  );
  assert.deepEqual(normalizeForecast(sessionRun), normalizeForecast(worktree));
  assert.equal(sessionRun.engine, "merge-tree");
  assert.ok(
    sessionRun.timings.git.processes < sessionRun.steps.length,
    `expected fewer than ${sessionRun.steps.length} Git processes, saw ${sessionRun.timings.git.processes}`,
  );
  assert.ok(
    sessionRun.timings.git.processes < worktree.timings.git.processes,
    `merge-tree ${sessionRun.timings.git.processes} vs worktree ${worktree.timings.git.processes}`,
  );
  const text = vlabWithEngine(repo, "merge-tree", "forecast", "feature");
  assert.match(text, /engine {7}merge-tree/);
  assert.doesNotMatch(text, /fallback/);
  assert.match(text, /status {7}complete/);

  assert.equal(git(repo, "rev-parse", "HEAD"), before.head);
  assert.equal(git(repo, "status", "--porcelain=v1"), before.status);
  assert.equal(git(repo, "worktree", "list", "--porcelain"), before.worktrees);

  const reconciled = JSON.parse(
    vlab(repo, "reconcile", "feature", "--use-forecast", mergeTree.id, "--json"),
  );
  assert.equal(reconciled.receipt.forecastId, mergeTree.id);
  assert.equal(reconciled.receipt.resultTree, mergeTree.predictedResultTree);
  assert.equal(reconciled.receipt.applied.length, 12);
  assert.equal(git(repo, "rev-parse", "HEAD^{tree}"), mergeTree.predictedResultTree);
  assert.equal(git(repo, "status", "--porcelain=v1"), "");
  assert.equal(readText(repo, "new-name.txt").split("\n")[5], "renamed 6 (source)");
  assert.equal(readText(repo, "shared.txt").split("\n")[0], "shared 1 (target)");
  assert.equal(readText(repo, "shared.txt").split("\n")[11], "shared 12 (source)");
  assert.equal(git(repo, "ls-files", "--stage", "mode.sh").split(" ")[0], "100755");
  assert.equal(fs.existsSync(path.join(repo, "source/one.txt")), false);
  assert.equal(
    JSON.parse(vlab(repo, "reconcile", "--status", "--json")).active,
    false,
  );
});

test("merge-tree forecasts fall back to the worktree oracle on a conflicted step", (t) => {
  if (skipWithoutMergeTreeEngine(t)) return;
  const { repo } = makeRepo(t);
  write(repo, "shared.txt", "base\n");
  git(repo, "add", ".");
  const base = JSON.parse(vlab(repo, "commit", "-m", "base"));
  vlab(repo, "init");

  git(repo, "switch", "-c", "feature", base.commit);
  write(repo, "shared.txt", "source\n");
  git(repo, "add", ".");
  const source = JSON.parse(vlab(repo, "commit", "-m", "source edit"));
  git(repo, "switch", "main");
  write(repo, "shared.txt", "target\n");
  git(repo, "add", ".");
  vlab(repo, "commit", "-m", "target edit");
  const worktreesBefore = git(repo, "worktree", "list", "--porcelain");

  const worktree = forecastWithEngine(repo, "worktree", "forecast", "feature");
  const mergeTree = forecastWithEngine(repo, "merge-tree", "forecast", "feature");
  assert.equal(worktree.status, "blocked");
  assert.equal(worktree.blockedReason, "missing-exact-resolution");
  assert.equal(worktree.steps[0].outcome, "blocked-conflict");
  assert.deepEqual(worktree.fallbacks, []);
  assert.deepEqual(normalizeForecast(mergeTree), normalizeForecast(worktree));
  assert.equal(mergeTree.status, "blocked");
  assert.equal(mergeTree.blockedReason, "missing-exact-resolution");
  assert.equal(mergeTree.engine, "worktree");
  assert.deepEqual(mergeTree.fallbacks, [
    {
      engine: "merge-tree",
      reason: "conflicted-step",
      step: 0,
      sourceCommit: source.commit,
    },
  ]);
  assert.ok(mergeTree.timings.mergeTree.totalMs >= 0);
  assert.ok(mergeTree.timings.worktree.totalMs > 0);
  assert.equal(
    mergeTree.timings.git.byCommand.find(
      (item) => item.command === "merge-tree-session",
    ).processes,
    1,
  );

  const text = vlabWithEngine(repo, "merge-tree", "forecast", "feature");
  assert.match(text, /engine {7}worktree/);
  assert.ok(
    text.includes(
      `fallback     merge-tree -> worktree: conflicted-step at step 1 (${source.commit.slice(0, 12)})`,
    ),
    text,
  );
  assert.equal(git(repo, "status", "--porcelain=v1"), "");
  assert.equal(git(repo, "worktree", "list", "--porcelain"), worktreesBefore);
});

test("merge-tree forecasts reuse pinned exact resolutions through the worktree fallback", (t) => {
  if (skipWithoutMergeTreeEngine(t)) return;
  const { repo } = makeRepo(t);
  write(repo, "shared.txt", "base\n");
  git(repo, "add", "shared.txt");
  const base = JSON.parse(vlab(repo, "commit", "-m", "base"));
  vlab(repo, "init");

  git(repo, "switch", "-c", "source-one", base.commit);
  write(repo, "shared.txt", "source\n");
  git(repo, "add", "shared.txt");
  vlab(repo, "commit", "-m", "source one");
  git(repo, "switch", "-c", "target-one", base.commit);
  write(repo, "shared.txt", "target\n");
  git(repo, "add", "shared.txt");
  vlab(repo, "commit", "-m", "target one");
  assert.notEqual(vlabResult(repo, "reconcile", "source-one").status, 0);
  write(repo, "shared.txt", "remembered\n");
  git(repo, "add", "shared.txt");
  vlab(repo, "reconcile", "--continue", "--json");

  git(repo, "switch", "-c", "source-two", base.commit);
  write(repo, "shared.txt", "source\n");
  git(repo, "add", "shared.txt");
  const sourceTwo = JSON.parse(vlab(repo, "commit", "-m", "source two"));
  git(repo, "switch", "-c", "target-two", base.commit);
  write(repo, "shared.txt", "target\n");
  git(repo, "add", "shared.txt");
  vlab(repo, "commit", "-m", "target two");

  const worktree = forecastWithEngine(repo, "worktree", "forecast", "source-two");
  const mergeTree = forecastWithEngine(repo, "merge-tree", "forecast", "source-two");
  assert.equal(worktree.status, "complete");
  assert.equal(worktree.steps[0].outcome, "exact-resolution");
  assert.deepEqual(normalizeForecast(mergeTree), normalizeForecast(worktree));
  assert.equal(mergeTree.status, "complete");
  assert.equal(mergeTree.engine, "worktree");
  assert.equal(mergeTree.steps[0].outcome, "exact-resolution");
  assert.equal(mergeTree.counts.exactResolution, 1);
  assert.equal(mergeTree.approvedResolutions.length, 1);
  assert.deepEqual(mergeTree.fallbacks, [
    {
      engine: "merge-tree",
      reason: "conflicted-step",
      step: 0,
      sourceCommit: sourceTwo.commit,
    },
  ]);
  assert.ok(mergeTree.predictedResultTree);

  const reconciled = JSON.parse(
    vlab(repo, "reconcile", "source-two", "--use-forecast", mergeTree.id, "--json"),
  );
  assert.equal(reconciled.receipt.forecastId, mergeTree.id);
  assert.equal(reconciled.receipt.resultTree, mergeTree.predictedResultTree);
  assert.equal(
    reconciled.receipt.applied[0].resolutions[0].selectionMethod,
    "forecast-batch",
  );
  assert.equal(readText(repo, "shared.txt"), "remembered\n");
  assert.equal(git(repo, "status", "--porcelain=v1"), "");
});

test("merge-tree forecasts fall back on an empty step that the worktree oracle blocks", (t) => {
  if (skipWithoutMergeTreeEngine(t)) return;
  const { repo } = makeRepo(t);
  write(repo, "base.txt", "base\n");
  git(repo, "add", ".");
  const base = JSON.parse(vlab(repo, "commit", "-m", "base"));
  vlab(repo, "init");

  // The target reaches the source's exact content through two different
  // patches, so the plan still classifies the source change as new.
  write(repo, "dup.txt", "one\ntwo\n");
  git(repo, "add", ".");
  vlab(repo, "commit", "-m", "target adds dup with an extra line");
  write(repo, "dup.txt", "one\n");
  git(repo, "add", ".");
  vlab(repo, "commit", "-m", "target trims dup");

  git(repo, "switch", "-c", "feature", base.commit);
  write(repo, "dup.txt", "one\n");
  git(repo, "add", ".");
  const source = JSON.parse(vlab(repo, "commit", "-m", "source adds dup"));
  git(repo, "switch", "main");

  const worktree = forecastWithEngine(repo, "worktree", "forecast", "feature");
  const mergeTree = forecastWithEngine(repo, "merge-tree", "forecast", "feature");
  assert.equal(worktree.plan.changes[0].status, "new");
  assert.equal(worktree.status, "blocked");
  assert.equal(worktree.blockedReason, "git-application-error");
  assert.equal(worktree.steps[0].outcome, "blocked-git-error");
  assert.equal(worktree.steps[0].targetBeforeTree, worktree.plan.targetTree);
  assert.deepEqual(normalizeForecast(mergeTree), normalizeForecast(worktree));
  assert.equal(mergeTree.engine, "worktree");
  assert.deepEqual(mergeTree.fallbacks, [
    {
      engine: "merge-tree",
      reason: "empty-step",
      step: 0,
      sourceCommit: source.commit,
    },
  ]);
  assert.equal(mergeTree.status, worktree.status);
  assert.equal(mergeTree.blockedReason, worktree.blockedReason);
  assert.equal(mergeTree.steps[0].outcome, worktree.steps[0].outcome);
  assert.equal(
    mergeTree.steps[0].targetBeforeTree,
    worktree.steps[0].targetBeforeTree,
  );
  assert.match(
    vlabWithEngine(repo, "merge-tree", "forecast", "feature"),
    /fallback {5}merge-tree -> worktree: empty-step at step 1/,
  );
});

test("merge-tree forecasts fall back when a non-final change edits the root .gitattributes", (t) => {
  if (skipWithoutMergeTreeEngine(t)) return;
  const { repo } = makeRepo(t);
  write(repo, "shared.txt", "base\n");
  git(repo, "add", ".");
  const base = JSON.parse(vlab(repo, "commit", "-m", "base"));
  vlab(repo, "init");

  write(repo, "target.txt", "target\n");
  git(repo, "add", ".");
  vlab(repo, "commit", "-m", "target adds target");

  git(repo, "switch", "-c", "feature", base.commit);
  write(repo, ".gitattributes", "*.txt text\n");
  git(repo, "add", ".");
  const attributes = JSON.parse(vlab(repo, "commit", "-m", "source adds attributes"));
  write(repo, "other.txt", "other\n");
  git(repo, "add", ".");
  vlab(repo, "commit", "-m", "source adds other");
  git(repo, "switch", "main");

  const worktree = forecastWithEngine(repo, "worktree", "forecast", "feature");
  const mergeTree = forecastWithEngine(repo, "merge-tree", "forecast", "feature");
  assert.equal(worktree.status, "complete");
  assert.equal(worktree.steps.length, 2);
  assert.deepEqual(normalizeForecast(mergeTree), normalizeForecast(worktree));
  assert.equal(mergeTree.engine, "worktree");
  assert.deepEqual(mergeTree.fallbacks, [
    {
      engine: "merge-tree",
      reason: "attributes-changed",
      step: 0,
      sourceCommit: attributes.commit,
      path: ".gitattributes",
    },
  ]);
  assert.equal(
    mergeTree.timings.git.byCommand.find(
      (item) => item.command === "merge-tree-session",
    ),
    undefined,
  );
  assert.equal(mergeTree.predictedResultTree, worktree.predictedResultTree);

  // A final change editing attributes needs no fallback: nothing merges
  // after it under the changed attributes.
  git(repo, "switch", "-c", "attributes-last", base.commit);
  write(repo, "other.txt", "other\n");
  git(repo, "add", ".");
  vlab(repo, "commit", "-m", "source adds other first");
  write(repo, ".gitattributes", "*.txt text\n");
  git(repo, "add", ".");
  vlab(repo, "commit", "-m", "source adds attributes last");
  git(repo, "switch", "main");
  const worktreeLast = forecastWithEngine(
    repo,
    "worktree",
    "forecast",
    "attributes-last",
  );
  const mergeTreeLast = forecastWithEngine(
    repo,
    "merge-tree",
    "forecast",
    "attributes-last",
  );
  assert.deepEqual(normalizeForecast(mergeTreeLast), normalizeForecast(worktreeLast));
  assert.equal(mergeTreeLast.engine, "merge-tree");
  assert.deepEqual(mergeTreeLast.fallbacks, []);
});

test("merge-tree forecasts fall back when a non-final change edits a nested .gitattributes", (t) => {
  if (skipWithoutMergeTreeEngine(t)) return;
  // The engine fixes GIT_ATTR_SOURCE to the original target tree, while the
  // worktree simulator checks out the accumulated tree before each pick and so
  // reads the attributes an earlier step introduced. Detecting only the root
  // file left a queue whose earlier step adds docs/.gitattributes predicting a
  // different tree in the two engines (ADR-0016, issue #9).
  const { repo } = makeRepo(t);
  write(repo, "docs/note.md", "base\n");
  git(repo, "add", ".");
  const base = JSON.parse(vlab(repo, "commit", "-m", "base"));
  vlab(repo, "init");

  write(repo, "target.txt", "target\n");
  git(repo, "add", ".");
  vlab(repo, "commit", "-m", "target moves");

  git(repo, "switch", "-c", "feature", base.commit);
  write(repo, "docs/.gitattributes", "*.md merge=union\n");
  git(repo, "add", ".");
  const attributes = JSON.parse(
    vlab(repo, "commit", "-m", "source adds nested attributes"),
  );
  write(repo, "docs/note.md", "source\n");
  git(repo, "add", ".");
  vlab(repo, "commit", "-m", "source edits under those attributes");
  git(repo, "switch", "main");

  const worktree = forecastWithEngine(repo, "worktree", "forecast", "feature");
  const mergeTree = forecastWithEngine(repo, "merge-tree", "forecast", "feature");
  assert.equal(worktree.status, "complete");
  assert.equal(worktree.steps.length, 2);
  assert.deepEqual(normalizeForecast(mergeTree), normalizeForecast(worktree));
  assert.equal(mergeTree.engine, "worktree");
  assert.deepEqual(mergeTree.fallbacks, [
    {
      engine: "merge-tree",
      reason: "attributes-changed",
      step: 0,
      sourceCommit: attributes.commit,
      path: "docs/.gitattributes",
    },
  ]);
  assert.equal(mergeTree.predictedResultTree, worktree.predictedResultTree);

  // The plan carries the paths the detection reads, from the same single
  // git log process that already builds the queue.
  const plan = JSON.parse(vlab(repo, "merge-plan", "feature", "--json"));
  assert.deepEqual(
    plan.changes.map((change) => change.changedPaths),
    [["docs/.gitattributes"], ["docs/note.md"]],
  );

  // A nested edit in the final change needs no fallback: nothing merges after it.
  git(repo, "switch", "-c", "nested-last", base.commit);
  write(repo, "docs/note.md", "other\n");
  git(repo, "add", ".");
  vlab(repo, "commit", "-m", "source edits note first");
  write(repo, "docs/.gitattributes", "*.md merge=union\n");
  git(repo, "add", ".");
  vlab(repo, "commit", "-m", "source adds nested attributes last");
  git(repo, "switch", "main");
  const mergeTreeLast = forecastWithEngine(
    repo,
    "merge-tree",
    "forecast",
    "nested-last",
  );
  assert.equal(mergeTreeLast.engine, "merge-tree");
  assert.deepEqual(mergeTreeLast.fallbacks, []);
});

test("merge-tree forecasts fall back with a reason when the merge-tree session is unavailable", (t) => {
  const { repo } = makeRepo(t);
  write(repo, "base.txt", "base\n");
  git(repo, "add", ".");
  const base = JSON.parse(vlab(repo, "commit", "-m", "base"));
  vlab(repo, "init");

  git(repo, "switch", "-c", "feature", base.commit);
  write(repo, "feature.txt", "feature\n");
  git(repo, "add", ".");
  const source = JSON.parse(vlab(repo, "commit", "-m", "feature"));
  git(repo, "switch", "main");
  write(repo, "target.txt", "target\n");
  git(repo, "add", ".");
  vlab(repo, "commit", "-m", "target");

  const worktree = forecastWithEngine(repo, "worktree", "forecast", "feature");
  const failed = spawnSync(process.execPath, [cli, "forecast", "feature", "--json"], {
    cwd: repo,
    encoding: "utf8",
    env: testEnv({
      VLAB_FORECAST_ENGINE: "merge-tree",
      VLAB_TEST_MERGE_TREE_SESSION_FAILURE: "1",
    }),
  });
  assert.equal(failed.status, 0, failed.stderr);
  const mergeTree = JSON.parse(failed.stdout);
  assert.equal(worktree.status, "complete");
  assert.deepEqual(normalizeForecast(mergeTree), normalizeForecast(worktree));
  assert.equal(mergeTree.engine, "worktree");
  assert.equal(mergeTree.status, "complete");
  assert.equal(mergeTree.fallbacks.length, 1);
  const [fallback] = mergeTree.fallbacks;
  assert.equal(fallback.engine, "merge-tree");
  assert.equal(fallback.reason, "merge-tree-unavailable");
  assert.equal(fallback.step, 0);
  assert.equal(fallback.sourceCommit, source.commit);
  assert.equal(typeof fallback.detail, "string");
  assert.ok(fallback.detail.length > 0, "fallback detail should explain the failure");
  assert.ok(mergeTree.timings.worktree.totalMs > 0);

  const reconciled = JSON.parse(
    vlab(repo, "reconcile", "feature", "--use-forecast", mergeTree.id, "--json"),
  );
  assert.equal(reconciled.receipt.resultTree, mergeTree.predictedResultTree);
  assert.equal(git(repo, "status", "--porcelain=v1"), "");
});

function tooOldFixture(t) {
  const { repo } = makeRepo(t);
  write(repo, "base.txt", "base\n");
  git(repo, "add", ".");
  const base = JSON.parse(vlab(repo, "commit", "-m", "base"));
  vlab(repo, "init");
  git(repo, "switch", "-c", "feature", base.commit);
  write(repo, "feature.txt", "feature\n");
  git(repo, "add", ".");
  const source = JSON.parse(vlab(repo, "commit", "-m", "feature"));
  git(repo, "switch", "main");
  write(repo, "target.txt", "target\n");
  git(repo, "add", ".");
  vlab(repo, "commit", "-m", "target");
  return { repo, source };
}

function mergeTreeForecastWithEnv(repo, env) {
  const started = Date.now();
  const result = spawnSync(
    process.execPath,
    [cli, "forecast", "feature", "--forecast-engine", "merge-tree", "--json"],
    {
      cwd: repo,
      encoding: "utf8",
      env: testEnv({ ...env }),
    },
  );
  const elapsedMs = Date.now() - started;
  assert.equal(result.status, 0, result.stderr);
  return { forecast: JSON.parse(result.stdout), elapsedMs };
}

function assertImmediateTooOldFallback({ forecast, elapsedMs }, worktree, source, gitVersionText) {
  assert.deepEqual(normalizeForecast(forecast), normalizeForecast(worktree));
  assert.equal(forecast.engine, "worktree");
  assert.equal(forecast.status, "complete");
  assert.equal(forecast.fallbacks.length, 1);
  const [fallback] = forecast.fallbacks;
  assert.equal(fallback.engine, "merge-tree");
  assert.equal(fallback.reason, "git-too-old");
  assert.equal(fallback.step, 0);
  assert.equal(fallback.sourceCommit, source.commit);
  assert.equal(fallback.requiredGit, MERGE_TREE_ENGINE_MIN_GIT);
  assert.equal(fallback.git, gitVersionText);
  assert.match(fallback.detail, new RegExp(`older than the ${MERGE_TREE_ENGINE_MIN_GIT.replace(".", "\\.")}`));
  // The session refuses the first request as soon as its process reports
  // its version: nothing is written, nothing waits for the session timeout,
  // and no `git --version` process is spawned.
  assert.ok(elapsedMs < 20_000, `the fallback took ${elapsedMs} ms`);
  const commands = forecast.timings.git.byCommand;
  const session = commands.find((item) => item.command === "merge-tree-session");
  assert.ok(session, commands.map((item) => item.command).join(", "));
  assert.equal(session.processes, 1);
  assert.equal(session.count, 1);
  assert.ok(
    !commands.some((item) => item.command === "--version"),
    commands.map((item) => item.command).join(", "),
  );
  assert.ok(forecast.timings.worktree.totalMs > 0);
  assert.equal(forecast.timings.mergeTree.totalMs >= 0, true);
}

test("merge-tree forecasts fall back to git-too-old before the first request on Git older than the engine needs", (t) => {
  const { repo, source } = tooOldFixture(t);
  const worktree = forecastWithEngine(repo, "worktree", "forecast", "feature");
  const spoofed = mergeTreeForecastWithEnv(repo, {
    VLAB_TEST_MERGE_TREE_GIT_VERSION: "2.48.1.windows.1",
  });
  assertImmediateTooOldFallback(spoofed, worktree, source, "2.48.1.windows.1");
  assert.equal(forecastFileCount(repo), 2);

  if (mergeTreeEngineSupported()) {
    // A version at the floor is accepted and the engine runs.
    const accepted = mergeTreeForecastWithEnv(repo, {
      VLAB_TEST_MERGE_TREE_GIT_VERSION: `${MERGE_TREE_ENGINE_MIN_GIT}.0`,
    });
    assert.equal(accepted.forecast.engine, "merge-tree");
    assert.deepEqual(accepted.forecast.fallbacks, []);
    assert.deepEqual(normalizeForecast(accepted.forecast), normalizeForecast(worktree));
  }
  assert.equal(git(repo, "status", "--porcelain=v1"), "");
  assert.equal(git(repo, "worktree", "list", "--porcelain").split("\n").filter((line) => line.startsWith("worktree ")).length, 1);
});

test("the default forecast engine is merge-tree on Windows and the worktree simulator elsewhere", (t) => {
  const { repo } = tooOldFixture(t);
  const env = testEnv();
  delete env.VLAB_FORECAST_ENGINE;
  const result = spawnSync(process.execPath, [cli, "forecast", "feature", "--json"], {
    cwd: repo,
    encoding: "utf8",
    env,
  });
  assert.equal(result.status, 0, result.stderr);
  const forecast = JSON.parse(result.stdout);
  const worktree = forecastWithEngine(repo, "worktree", "forecast", "feature");
  assert.deepEqual(normalizeForecast(forecast), normalizeForecast(worktree));
  if (process.platform !== "win32") {
    assert.equal(forecast.engine, "worktree");
    assert.deepEqual(forecast.fallbacks, []);
  } else if (mergeTreeEngineSupported()) {
    assert.equal(forecast.engine, "merge-tree");
    assert.deepEqual(forecast.fallbacks, []);
  } else {
    assert.equal(forecast.engine, "worktree");
    assert.equal(forecast.fallbacks[0]?.reason, "git-too-old");
  }
  assert.equal(git(repo, "status", "--porcelain=v1"), "");
});

test("on a host Git older than the merge-tree engine needs the fallback is immediate and names that version", (t) => {
  if (mergeTreeEngineSupported()) {
    t.skip(`${hostGitVersion()} runs the merge-tree engine; the too-old path is covered with a spoofed version`);
    return;
  }
  const { repo, source } = tooOldFixture(t);
  const worktree = forecastWithEngine(repo, "worktree", "forecast", "feature");
  const real = mergeTreeForecastWithEnv(repo, {});
  assertImmediateTooOldFallback(
    real,
    worktree,
    source,
    hostGitVersion().replace(/^git version /, ""),
  );
  assert.equal(git(repo, "status", "--porcelain=v1"), "");
});

test("unknown merge-tree or worktree engine selections fail before any forecast is written", (t) => {
  const { repo } = makeRepo(t);
  write(repo, "base.txt", "base\n");
  git(repo, "add", ".");
  const base = JSON.parse(vlab(repo, "commit", "-m", "base"));
  vlab(repo, "init");

  git(repo, "switch", "-c", "feature", base.commit);
  write(repo, "feature.txt", "feature\n");
  git(repo, "add", ".");
  vlab(repo, "commit", "-m", "feature");
  git(repo, "switch", "main");
  assert.equal(forecastFileCount(repo), 0);

  const viaEnvironment = spawnSync(
    process.execPath,
    [cli, "forecast", "feature", "--json"],
    {
      cwd: repo,
      encoding: "utf8",
      env: testEnv({
        VLAB_FORECAST_ENGINE: "bogus",
      }),
    },
  );
  assert.notEqual(viaEnvironment.status, 0);
  assert.ok(
    viaEnvironment.stderr.includes(
      "Unknown forecast engine 'bogus'. Use one of: worktree, merge-tree.",
    ),
    viaEnvironment.stderr,
  );
  assert.equal(forecastFileCount(repo), 0);

  for (const args of [
    ["forecast", "feature", "--forecast-engine", "bogus", "--json"],
    ["forecast", "feature", "--forecast-engine=bogus", "--json"],
    ["forecast", "feature", "--json", "--forecast-engine"],
  ]) {
    const viaFlag = vlabResult(repo, ...args);
    assert.notEqual(viaFlag.status, 0, args.join(" "));
    assert.ok(
      viaFlag.stderr.includes(
        "--forecast-engine requires one of: worktree, merge-tree.",
      ),
      viaFlag.stderr,
    );
  }
  assert.equal(forecastFileCount(repo), 0);
  assert.equal(git(repo, "status", "--porcelain=v1"), "");
  assert.equal(git(repo, "rev-parse", "HEAD"), git(repo, "rev-parse", "main"));

  // The flag overrides an unusable environment selection.
  const overridden = spawnSync(
    process.execPath,
    [cli, "forecast", "feature", "--forecast-engine", "merge-tree", "--json"],
    {
      cwd: repo,
      encoding: "utf8",
      env: testEnv({
        VLAB_FORECAST_ENGINE: "bogus",
      }),
    },
  );
  assert.equal(overridden.status, 0, overridden.stderr);
  assert.equal(
    JSON.parse(overridden.stdout).engine,
    mergeTreeEngineSupported() ? "merge-tree" : "worktree",
  );
  assert.equal(forecastFileCount(repo), 1);
});

test("merge-tree forecasts fall back when a queued change is a merge commit", (t) => {
  if (skipWithoutMergeTreeEngine(t)) return;
  const { repo } = makeRepo(t);
  write(repo, "base.txt", "base\n");
  git(repo, "add", ".");
  const base = JSON.parse(vlab(repo, "commit", "-m", "base"));
  vlab(repo, "init");

  write(repo, "target.txt", "target\n");
  git(repo, "add", ".");
  vlab(repo, "commit", "-m", "target adds target");

  git(repo, "switch", "-c", "feature", base.commit);
  write(repo, "a.txt", "a\n");
  git(repo, "add", ".");
  vlab(repo, "commit", "-m", "source adds a");
  git(repo, "switch", "-c", "side", base.commit);
  write(repo, "side.txt", "side\n");
  git(repo, "add", ".");
  vlab(repo, "commit", "-m", "side adds side");
  git(repo, "switch", "feature");
  git(repo, "merge", "--no-ff", "--no-edit", "-q", "side");
  const merge = git(repo, "rev-parse", "HEAD");
  write(repo, "b.txt", "b\n");
  git(repo, "add", ".");
  vlab(repo, "commit", "-m", "source adds b");
  git(repo, "switch", "main");

  const worktree = forecastWithEngine(repo, "worktree", "forecast", "feature");
  const mergeTree = forecastWithEngine(repo, "merge-tree", "forecast", "feature");
  assert.deepEqual(normalizeForecast(mergeTree), normalizeForecast(worktree));
  assert.equal(mergeTree.engine, "worktree");
  const queue = mergeTree.plan.changes.filter((change) => change.status === "new");
  const step = queue.findIndex((change) => change.commit === merge);
  assert.ok(step >= 0, "the merge commit should be queued for replay");
  assert.deepEqual(mergeTree.fallbacks, [
    { engine: "merge-tree", reason: "merge-commit", step, sourceCommit: merge },
  ]);
  assert.equal(
    mergeTree.timings.git.byCommand.find(
      (item) => item.command === "merge-tree-session",
    ),
    undefined,
  );
  assert.equal(git(repo, "status", "--porcelain=v1"), "");
  assert.equal(git(repo, "rev-parse", "HEAD"), git(repo, "rev-parse", "main"));
});

test("logical identifiers follow the versioned protocol and do not collide", async () => {
  const ids = await import(
    pathToFileURL(path.join(projectRoot, "src", "ids.js")).href
  );
  const {
    ID_ENTROPY_BITS,
    ID_NAMESPACES,
    LOGICAL_ID_PROFILE,
    isLogicalId,
    newId,
    parseLogicalId,
  } = ids;

  assert.equal(LOGICAL_ID_PROFILE, "vcs-lab.logical-id/v1");
  assert.equal(ID_ENTROPY_BITS, 48);

  // Form: every namespace mints something the parser accepts and splits the
  // same way, including the namespaces that contain underscores, which a
  // split-on-first-underscore parser would get wrong.
  for (const namespace of Object.keys(ID_NAMESPACES)) {
    const id = newId(namespace);
    const parsed = parseLogicalId(id);
    assert.equal(parsed.valid, true, `${namespace} must mint a valid identifier`);
    assert.equal(parsed.namespace, namespace, `${namespace} must round-trip`);
    assert.equal(parsed.minted.length, 9);
    assert.equal(parsed.random.length, 12);
    assert.match(parsed.random, /^[0-9a-f]{12}$/);
    assert.equal(isLogicalId(id, namespace), true);
    assert.equal(isLogicalId(id, "ch"), namespace === "ch");
  }
  assert.ok(
    Object.keys(ID_NAMESPACES).some((namespace) => namespace.includes("_")),
    "the underscore case must actually be exercised",
  );

  // The namespace set is closed, and the derived identity forms are reported
  // as what they are rather than as malformed.
  assert.deepEqual(parseLogicalId("git:0123456789abcdef"), {
    valid: false,
    reason: "commit-fallback-identity",
  });
  assert.equal(parseLogicalId("bogus_0mthy2bwb66595f2dcc62").reason, "unknown-namespace");
  assert.equal(parseLogicalId("ch_short").reason, "malformed");
  assert.equal(parseLogicalId("ch_0mthy2bwb66595f2dcc6Z").reason, "malformed");
  assert.equal(parseLogicalId("").reason, "not-a-string");
  assert.equal(parseLogicalId(null).reason, "not-a-string");
  assert.equal(isLogicalId(`rsig_${"a".repeat(64)}`), false, "signatures are derived, not minted");

  // Collision behaviour. Minting many identifiers as fast as possible puts a
  // large share of them inside the same millisecond, which is the only window
  // in which two can collide at all.
  const COUNT = 20_000;
  const minted = new Set();
  const randoms = new Set();
  const clocks = new Set();
  for (let index = 0; index < COUNT; index += 1) {
    const id = newId("ch");
    minted.add(id);
    const parsed = parseLogicalId(id);
    randoms.add(parsed.random);
    clocks.add(parsed.minted);
  }
  assert.equal(minted.size, COUNT, "no two minted identifiers may be equal");
  assert.equal(randoms.size, COUNT, "the random half alone must not repeat at this scale");
  assert.ok(
    clocks.size < COUNT,
    "the test must actually exercise same-millisecond minting, or it proves nothing",
  );

  // The clock partitions but does not order: it is not a sort key, and the
  // protocol says so. What must hold is that it is a plausible base36 clock.
  const now = Date.now();
  const sample = parseLogicalId(newId("ch"));
  const decoded = parseInt(sample.minted, 36);
  assert.ok(
    Math.abs(decoded - now) < 60_000,
    "the minted half decodes to the current millisecond clock",
  );
});

test("the identity audit separates preserved identity from a real collision", (t) => {
  const { repo } = makeRepo(t);
  write(repo, "a.txt", "base\n");
  git(repo, "add", ".");
  const base = JSON.parse(vlab(repo, "commit", "-m", "base"));
  vlab(repo, "init");

  git(repo, "switch", "-c", "feature", base.commit);
  write(repo, "f.txt", "feature\n");
  git(repo, "add", ".");
  const feature = JSON.parse(vlab(repo, "commit", "-m", "feature"));
  git(repo, "switch", "main");
  // A cherry-pick preserves the logical ID (FR-ID-02), so two commits now
  // carry one Change-Id legitimately. The audit must not call that a collision.
  vlab(repo, "cherry-pick", feature.commit);

  const clean = JSON.parse(vlab(repo, "audit", "identity", "--json"));
  assert.equal(clean.schema, "vcs-lab.identity-audit/v1");
  assert.equal(clean.summary.clean, true, "preserved identity is not a collision");
  assert.equal(clean.summary.collisions, 0);
  assert.ok(clean.scanned.commits >= 3);
  assert.equal(clean.scanned.applicationRecords, 1);

  // A commit that copies an existing Change-Id with no derivation recorded is
  // a genuine collision: the sharing is not backed by an application record.
  git(repo, "switch", "-c", "stray", base.commit);
  write(repo, "stray.txt", "stray\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", `stray work\n\nChange-Id: ${feature.changeId}`);
  // And a commit claiming two identities at once, where planning silently
  // reads only the first.
  write(repo, "two.txt", "two\n");
  git(repo, "add", ".");
  git(
    repo,
    "commit",
    "-q",
    "-m",
    "two identities\n\nChange-Id: ch_first0000000000000000\nChange-Id: ch_second000000000000000",
  );
  git(repo, "switch", "main");

  const dirty = vlabResult(repo, "audit", "identity", "--json");
  assert.notEqual(dirty.status, 0, "findings set a non-zero exit code");
  const report = JSON.parse(dirty.stdout);
  assert.equal(report.summary.clean, false);

  const collision = report.findings.find((item) => item.code === "change-id-collision");
  assert.ok(collision, "the copied Change-Id is reported");
  assert.equal(collision.changeId, feature.changeId);
  assert.equal(
    collision.unlinkedGroups.length,
    2,
    "the linked pair and the stray commit are separate groups",
  );
  assert.equal(collision.commits.length, 3);

  const trailer = report.findings.find(
    (item) => item.code === "conflicting-change-id-trailer",
  );
  assert.ok(trailer, "the double trailer is reported");
  assert.deepEqual(trailer.changeIds.sort(), [
    "ch_first0000000000000000",
    "ch_second000000000000000",
  ]);

  // An applied commit claimed by two application records with different
  // origins leaves its provenance ambiguous.
  const noteList = git(repo, "notes", "--ref=vcs-lab", "list").split(/\r?\n/).filter(Boolean);
  let injected = false;
  for (const line of noteList) {
    const [noteOid, target] = line.split(" ");
    const note = JSON.parse(git(repo, "cat-file", "blob", noteOid));
    const application = note.records.find((record) => record.type === "application");
    if (!application) continue;
    // A different origin commit *and* a different origin identity, while the
    // applied identity stays as it was. That is ambiguous provenance and, for
    // a non-fork application, an FR-ID-02 violation: identity must be
    // preserved unless the relation says the change deliberately diverged.
    note.records.push({
      ...application,
      id: "apply_conflicting000000",
      originCommit: base.commit,
      originChangeId: "ch_other0000000000000000",
    });
    execFileSync("git", ["notes", "--ref=vcs-lab", "add", "-f", "-F", "-", target], {
      cwd: repo,
      input: `${JSON.stringify(note, null, 2)}\n`,
      encoding: "utf8",
      env: testEnv(),
    });
    injected = true;
    break;
  }
  assert.ok(injected, "the fixture must contain an application record to conflict with");

  const ambiguous = JSON.parse(vlabResult(repo, "audit", "identity", "--json").stdout);
  const origin = ambiguous.findings.find((item) => item.code === "ambiguous-origin");
  assert.ok(origin, "two origins for one applied commit are reported");
  assert.equal(origin.origins.length, 2);
  assert.equal(ambiguous.summary.ambiguousOrigins, 1);

  // The injected record also violates FR-ID-02: it is not a fork, yet it
  // changes the Change-Id. The audit checks that invariant too.
  assert.ok(
    ambiguous.findings.some((item) => item.code === "identity-not-preserved"),
    "a non-fork application that changes the identity is reported",
  );
});

test("a proof bundle lets a verifier recompute coverage instead of trusting it", async (t) => {
  const { canonicalJson } = await import(
    pathToFileURL(path.join(projectRoot, "src", "canonical-json.js")).href
  );
  const { repo } = makeRepo(t);
  write(repo, "a.txt", "base\n");
  git(repo, "add", ".");
  vlab(repo, "commit", "-m", "base");
  vlab(repo, "init");

  git(repo, "switch", "-c", "feature");
  write(repo, "f1.txt", "one\n");
  git(repo, "add", ".");
  vlab(repo, "commit", "-m", "feature one");
  git(repo, "switch", "main");
  // A hard squash absorbs the feature commit by receipt rather than ancestry,
  // so coverage rests on evidence a verifier has to be given.
  vlab(repo, "hard-squash", "feature", "-m", "land feature");
  git(repo, "switch", "feature");
  write(repo, "f2.txt", "two\n");
  git(repo, "add", ".");
  vlab(repo, "commit", "-m", "feature two");
  git(repo, "switch", "main");

  const bundlePath = path.join(repo, "bundle.json");
  fs.writeFileSync(bundlePath, vlab(repo, "proof-bundle", "feature"));
  const bundle = JSON.parse(fs.readFileSync(bundlePath, "utf8"));

  assert.equal(bundle.schema, "vcs-lab.proof-bundle/v1");
  assert.match(bundle.repository.lineage.id, /^lineage_[0-9a-f]{64}$/);
  const covered = bundle.changes.filter((change) => change.status === "covered");
  const fresh = bundle.changes.filter((change) => change.status === "new");
  assert.equal(covered.length, 1, "the squashed change is covered by receipt");
  assert.equal(covered[0].proof, "receipt-commit");
  assert.equal(fresh.length, 1, "the later change is new");
  assert.ok(
    bundle.evidence.receipts.some((receipt) =>
      receipt.absorbedCommits.includes(covered[0].commit),
    ),
    "the bundle names the receipt that covers the covered change",
  );

  // 1. An untouched bundle verifies, and the evidence matches the repository.
  const honest = JSON.parse(vlab(repo, "verify-proof", bundlePath, "--json"));
  assert.equal(honest.ok, true);
  assert.equal(honest.integrity.intact, true);
  assert.equal(honest.classification.agrees, true);
  assert.equal(honest.repository.checked, true);
  assert.equal(honest.repository.matches, true);

  const rehash = (value) => {
    const { integrity, signatures, ...payload } = value;
    return createHash("sha256").update(canonicalJson(payload)).digest("hex");
  };

  // 2. A doctored claim with a stale hash fails both checks.
  const doctored = JSON.parse(JSON.stringify(bundle));
  const target = doctored.changes.find((change) => change.status === "new");
  target.status = "covered";
  target.proof = "receipt-commit";
  const doctoredPath = path.join(repo, "doctored.json");
  fs.writeFileSync(doctoredPath, JSON.stringify(doctored));
  const doctoredResult = vlabResult(repo, "verify-proof", doctoredPath, "--json");
  assert.notEqual(doctoredResult.status, 0);
  const doctoredReport = JSON.parse(doctoredResult.stdout);
  assert.equal(doctoredReport.integrity.intact, false);
  assert.equal(doctoredReport.classification.agrees, false);
  assert.equal(doctoredReport.classification.disagreements[0].recomputed.status, "new");

  // 3. The same doctored claim with the hash restated still fails, because the
  //    verifier recomputes the classification rather than trusting it. This is
  //    the property FR-PLAN-08 asks for.
  const resigned = JSON.parse(JSON.stringify(doctored));
  resigned.integrity = { algorithm: "sha256", bundleHash: rehash(resigned) };
  const resignedPath = path.join(repo, "resigned.json");
  fs.writeFileSync(resignedPath, JSON.stringify(resigned));
  const resignedResult = vlabResult(repo, "verify-proof", resignedPath, "--json");
  assert.notEqual(resignedResult.status, 0);
  const resignedReport = JSON.parse(resignedResult.stdout);
  assert.equal(resignedReport.integrity.intact, true, "the restated hash looks intact");
  assert.equal(resignedReport.classification.agrees, false, "but the claim is still caught");

  // 4. Fabricated evidence is self-consistent, so only the repository catches
  //    it. Offline verification must not claim more than it proved.
  const fabricated = JSON.parse(JSON.stringify(bundle));
  const victim = fabricated.changes.find((change) => change.status === "new");
  fabricated.evidence.receipts.push({
    id: "land_fabricated",
    schema: "vcs-lab.landing/v1",
    type: "landing",
    attachedTo: fabricated.target.head,
    absorbedCommits: [victim.commit],
    absorbedChanges: [victim.changeId],
  });
  victim.status = "covered";
  victim.proof = "receipt-commit";
  fabricated.counts = { covered: 2, "candidate-equivalent": 0, new: 0 };
  fabricated.integrity = { algorithm: "sha256", bundleHash: rehash(fabricated) };
  const fabricatedPath = path.join(repo, "fabricated.json");
  fs.writeFileSync(fabricatedPath, JSON.stringify(fabricated));

  const offline = JSON.parse(vlab(repo, "verify-proof", fabricatedPath, "--offline", "--json"));
  assert.equal(offline.ok, true, "offline verification cannot detect fabricated evidence");
  assert.equal(offline.repository.checked, false);
  assert.equal(offline.trust.evidenceCheckedAgainstRepository, false);
  assert.match(offline.trust.statement, /not that the evidence is true/);

  const backed = vlabResult(repo, "verify-proof", fabricatedPath, "--json");
  assert.notEqual(backed.status, 0, "the repository comparison catches it");
  const backedReport = JSON.parse(backed.stdout);
  assert.equal(backedReport.repository.checked, true);
  assert.equal(backedReport.repository.matches, false);
  assert.equal(backedReport.ok, false);

  // 5. A repository that has moved on is skipped, not failed: different heads
  //    legitimately produce different evidence.
  write(repo, "later.txt", "later\n");
  git(repo, "add", ".");
  vlab(repo, "commit", "-m", "target moves on");
  const moved = JSON.parse(vlab(repo, "verify-proof", bundlePath, "--json"));
  assert.equal(moved.repository.checked, false);
  assert.equal(moved.repository.reason, "target-moved");
  assert.equal(moved.ok, true, "a moved repository does not invalidate the bundle");
});

test("proof verification binds rehashed claims to the complete source history and bases", async (t) => {
  const { bundleHash } = await import("../src/proof-bundle.js");
  const { repo, parent } = makeRepo(t);
  write(repo, "base.txt", "base\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "ordinary Git base");
  git(repo, "switch", "-c", "feature");
  write(repo, "one.txt", "one\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "ordinary Git source");
  git(repo, "switch", "main");
  vlab(repo, "hard-squash", "feature");
  git(repo, "switch", "feature");
  write(repo, "two.txt", "two\n");
  git(repo, "add", ".");
  vlab(repo, "commit", "-m", "identified source");
  git(repo, "switch", "main");
  const bundle = JSON.parse(vlab(repo, "proof-bundle", "feature"));
  assert.equal(bundle.changes[0].changeId, `git:${bundle.changes[0].commit}`);
  assert.notEqual(bundle.effectiveBase.commit, bundle.physicalBase);
  const file = path.join(parent, "proof.json");
  const verify = (value, ...args) => {
    value.integrity.bundleHash = bundleHash(value);
    fs.writeFileSync(file, JSON.stringify(value));
    return vlabResult(repo, "verify-proof", file, ...args);
  };
  const recount = (value) => {
    value.counts = { covered: 0, "candidate-equivalent": 0, new: 0 };
    for (const change of value.changes) value.counts[change.status]++;
  };
  assert.equal(verify(bundle, "--json").status, 0);
  const cases = [
    ["omitted inventory", "sourceChanges", (b) => { b.changes = []; recount(b); }],
    ["omitted one change", "sourceChanges", (b) => { b.changes.pop(); recount(b); }],
    ["duplicate change", "sourceChanges", (b) => { b.changes.push(b.changes[0]); recount(b); }],
    ["injected target commit", "sourceChanges", (b) => {
      b.changes.push({ commit: b.target.head, changeId: `git:${b.target.head}`, subject: "injected", status: "covered", proof: "commit-ancestry" });
      recount(b);
    }],
    ["misidentified change", "sourceChanges", (b) => { b.changes[1].changeId = b.changes[0].changeId; b.changes[1].status = "covered"; b.changes[1].proof = "receipt-change-id"; recount(b); }],
    ["altered subject", "sourceChanges", (b) => { b.changes[0].subject = "forged"; }],
    ["reordered changes", "sourceChanges", (b) => { b.changes.reverse(); }],
    ["false counts", "counts", (b) => { b.counts.new = 0; }],
    ["false physical base", "physicalBase", (b) => { b.physicalBase = b.source.head; }],
    ["false effective base", "effectiveBase", (b) => { b.effectiveBase.commit = b.physicalBase; }],
    ["false effective reason", "effectiveBase", (b) => { b.effectiveBase.reason = "physical-ancestry"; }],
    ["false lineage fields", "lineage", (b) => { b.repository.lineage.rootCommits = []; }],
  ];
  for (const [name, check, mutate] of cases) {
    await t.test(name, () => {
      const value = structuredClone(bundle);
      mutate(value);
      const result = verify(value, "--json");
      assert.equal(result.status, 1, name);
      const report = JSON.parse(result.stdout);
      assert.equal(report.integrity.intact, true);
      assert.equal(report.repository.checked, true);
      assert.equal(report.repository.checks[check], false);
      assert.equal(report.repository.matches, false);
      assert.equal(report.ok, false);
      const human = verify(value);
      assert.equal(human.status, 1);
      assert.match(human.stdout, /The bundle does not verify/);
      assert.ok(human.stdout.includes(check), "human output identifies the failed repository check");
    });
  }
  const omitted = structuredClone(bundle);
  omitted.changes = [];
  recount(omitted);
  const offline = JSON.parse(verify(omitted, "--offline", "--json").stdout);
  assert.equal(offline.ok, true, "an offline verifier cannot discover omitted history");
  assert.equal(offline.repository.checked, false);
  assert.match(offline.trust.statement, /source completeness.*not checked/);
  const duplicate = structuredClone(bundle);
  duplicate.changes.push(duplicate.changes[0]);
  recount(duplicate);
  assert.equal(verify(duplicate, "--offline", "--json").status, 1);
  const counts = structuredClone(bundle);
  counts.counts.new++;
  assert.equal(verify(counts, "--offline", "--json").status, 1);

  // An empty range is legitimate when the source is already an ancestor.
  git(repo, "switch", "feature");
  const ancestor = JSON.parse(vlab(repo, "proof-bundle", bundle.physicalBase));
  assert.equal(ancestor.changes.length, 0);
  assert.equal(verify(ancestor, "--json").status, 0);

  // A matching lineage can contain disconnected roots. Failure to read a
  // common base must not be swallowed as "not-a-repository" and pass offline.
  git(repo, "switch", "main");
  const disconnected = git(repo, "commit-tree", `${bundle.physicalBase}^{tree}`, "-m", "Disconnected root");
  git(repo, "update-ref", "refs/heads/disconnected", disconnected);
  const { repositoryLineage } = await import("../src/metadata.js");
  const unreadable = structuredClone(bundle);
  unreadable.repository.lineage = repositoryLineage(repo);
  unreadable.source = { ref: "disconnected", head: disconnected };
  const refused = verify(unreadable, "--json");
  assert.notEqual(refused.status, 0);
  assert.equal(JSON.parse(refused.stdout).schema, "vcs-lab.error/v1");

  // Outside a repository the command still supports its documented local
  // consistency checks, with the completeness limitation made explicit.
  fs.writeFileSync(file, JSON.stringify(bundle));
  const outside = JSON.parse(vlab(parent, "verify-proof", file, "--json"));
  assert.equal(outside.ok, true);
  assert.equal(outside.repository.reason, "not-a-repository");
  assert.match(outside.trust.statement, /source completeness.*not checked/);
});

test("the benchmark regression comparator flags process growth and slow medians but tolerates noise on fast phases", async () => {
  const { compare, SCALE_PHASES, FORECAST_MODES } = await import(
    pathToFileURL(path.join(projectRoot, "scripts", "benchmark-regression.mjs")).href
  );
  const phases = Object.fromEntries(
    SCALE_PHASES.map((name, index) => [
      name,
      { medianMs: index === 0 ? 0.3 : 100, p95Ms: 120, medianProcesses: 2 },
    ]),
  );
  const forecast = Object.fromEntries(
    Object.keys(FORECAST_MODES).map((mode) => [
      mode,
      { engine: "worktree", fallbacks: 0, processes: 10, queries: 10, forecastMs: 500 },
    ]),
  );
  const materialization = {
    full: { files: 600, bytes: 615000 },
    cone: { files: 60, bytes: 61500 },
  };
  // The publication loop (issue #15), held to the process rule like
  // materialization: a fixed queue in a deterministic fixture, so growth in
  // what publishing a change costs is a regression rather than host noise.
  const publication = { changes: 6, processes: 41, records: 19, elapsedMs: 300 };
  const entry = { phases, forecast, materialization, publication };

  const same = compare(entry, structuredClone(entry));
  assert.ok(same.length > 0);
  assert.deepEqual(same.map((item) => item.status), same.map(() => "unchanged"));

  const noisy = structuredClone(entry);
  noisy.phases[SCALE_PHASES[0]].medianMs = 4; // within the absolute floor
  noisy.phases[SCALE_PHASES[1]].medianMs = 201; // above twice the baseline
  noisy.phases[SCALE_PHASES[2]].medianMs = 50; // faster
  noisy.forecast["worktree-session"].processes = 11; // one more process
  // Materialized bytes are held to the process rule: the fixture is
  // deterministic, so any growth in what a workspace writes is a regression
  // and a reduction is an improvement, with no tolerance band either way.
  noisy.materialization.full.bytes = 615001; // one byte more
  noisy.materialization.cone.bytes = 61499; // one byte fewer
  noisy.publication.processes = 47; // the per-application read, restored
  const findings = compare(entry, noisy);
  const byKey = Object.fromEntries(findings.map((item) => [`${item.subject} ${item.metric}`, item]));
  assert.equal(byKey[`scale:${SCALE_PHASES[0]} medianMs`].status, "tolerated");
  assert.equal(byKey[`scale:${SCALE_PHASES[1]} medianMs`].status, "regressed");
  assert.equal(byKey[`scale:${SCALE_PHASES[2]} medianMs`].status, "improved");
  assert.equal(byKey["forecast:worktree-session processes"].status, "regressed");
  assert.equal(byKey["materialization:full bytes"].status, "regressed");
  assert.equal(byKey["materialization:cone bytes"].status, "improved");
  assert.equal(byKey["materialization:full files"].status, "unchanged");
  assert.equal(byKey["publication processes"].status, "regressed");
  assert.equal(
    byKey["publication records"].status,
    "unchanged",
    "a cost regression must not look like a change in what was published",
  );
  assert.deepEqual(
    findings.filter((item) => item.status === "regressed").map((item) => `${item.subject} ${item.metric}`),
    [
      `scale:${SCALE_PHASES[1]} medianMs`,
      "forecast:worktree-session processes",
      "publication processes",
      "materialization:full bytes",
    ],
  );

  const partial = structuredClone(entry);
  delete partial.forecast["merge-tree-session"];
  const skipped = compare(entry, partial).filter((item) => item.status === "skipped");
  assert.deepEqual([...new Set(skipped.map((item) => item.subject))], ["forecast:merge-tree-session"]);
  assert.deepEqual(skipped.map((item) => item.metric), ["processes", "forecastMs"]);
  assert.deepEqual(
    compare(entry, partial).filter((item) => item.status === "regressed"),
    [],
  );
});

test("merge-tree rebase forecasts match the worktree oracle and apply through --use-forecast", (t) => {
  if (skipWithoutMergeTreeEngine(t)) return;
  const { repo } = makeRepo(t);
  write(repo, "base.txt", "base\n");
  git(repo, "add", ".");
  const base = JSON.parse(vlab(repo, "commit", "-m", "base"));
  vlab(repo, "init");

  git(repo, "switch", "-c", "feature", base.commit);
  write(repo, "feature.txt", "one\n");
  git(repo, "add", ".");
  vlab(repo, "commit", "-m", "feature one");
  write(repo, "feature.txt", "one\ntwo\n");
  git(repo, "add", ".");
  vlab(repo, "commit", "-m", "feature two");

  git(repo, "switch", "main");
  const landing = JSON.parse(vlab(repo, "hard-squash", "feature", "--json"));
  git(repo, "switch", "feature");
  write(repo, "continuation.txt", "three\n");
  git(repo, "add", ".");
  const continuation = JSON.parse(vlab(repo, "commit", "-m", "feature continuation"));
  write(repo, "more.txt", "four\n");
  git(repo, "add", ".");
  const more = JSON.parse(vlab(repo, "commit", "-m", "feature more"));
  const originalTree = git(repo, "rev-parse", "HEAD^{tree}");

  const worktree = forecastWithEngine(repo, "worktree", "rebase-forecast", "main");
  const mergeTree = forecastWithEngine(repo, "merge-tree", "rebase-forecast", "main");
  assert.equal(worktree.schema, "vcs-lab.rebase-forecast/v1");
  assert.equal(worktree.status, "complete");
  assert.equal(worktree.engine, "worktree");
  assert.deepEqual(
    worktree.steps.map((step) => step.changeId),
    [continuation.changeId, more.changeId],
  );
  assert.deepEqual(normalizeForecast(mergeTree), normalizeForecast(worktree));
  assert.equal(mergeTree.schema, "vcs-lab.rebase-forecast/v1");
  assert.equal(mergeTree.engine, "merge-tree");
  assert.deepEqual(mergeTree.fallbacks, []);
  assert.equal(mergeTree.steps[0].relation, "causal-rebase");
  assert.equal(mergeTree.predictedResultTree, originalTree);
  assert.equal(mergeTree.exactStateEqualityAfter, true);
  assert.equal(mergeTree.callerInvariants.preserved, true);
  assert.deepEqual(mergeTree.timings.worktree, {
    setupMs: 0,
    applicationMs: 0,
    cleanupMs: 0,
    totalMs: 0,
  });
  assert.equal(
    mergeTree.timings.git.byCommand.find(
      (item) => item.command === "merge-tree-session",
    ).count,
    2,
  );
  assert.match(
    vlabWithEngine(repo, "merge-tree", "rebase-forecast", "main"),
    /engine {7}merge-tree/,
  );
  assert.equal(git(repo, "branch", "--show-current"), "feature");
  assert.equal(git(repo, "status", "--porcelain=v1"), "");

  const result = JSON.parse(
    vlab(repo, "rebase", "main", "--use-forecast", mergeTree.id, "--json"),
  );
  assert.equal(result.receipt.forecastId, mergeTree.id);
  assert.equal(result.receipt.resultTree, mergeTree.predictedResultTree);
  assert.equal(result.receipt.exactStateEqualityAfter, true);
  assert.equal(result.receipt.applications.length, 2);
  assert.equal(git(repo, "branch", "--show-current"), "feature");
  assert.equal(git(repo, "show", "-s", "--format=%P", "HEAD~1"), landing.landingCommit);
  assert.equal(git(repo, "status", "--porcelain=v1"), "");
});

test("merge-tree rebase forecasts read merge attributes from the onto tree rather than the caller checkout", (t) => {
  if (skipWithoutMergeTreeEngine(t)) return;
  const { repo } = makeRepo(t);
  write(repo, "shared.txt", "one\nbase\nthree\n");
  git(repo, "add", ".");
  const base = JSON.parse(vlab(repo, "commit", "-m", "base"));
  vlab(repo, "init");

  // Only the onto branch declares the union driver; the caller checkout
  // (the source branch) never carries a .gitattributes file.
  write(repo, ".gitattributes", "shared.txt merge=union\n");
  write(repo, "shared.txt", "one\ntarget\nthree\n");
  git(repo, "add", ".");
  vlab(repo, "commit", "-m", "onto declares union and edits shared");

  git(repo, "switch", "-c", "feature", base.commit);
  write(repo, "shared.txt", "one\nsource\nthree\n");
  git(repo, "add", ".");
  const source = JSON.parse(vlab(repo, "commit", "-m", "source edits shared"));
  assert.equal(fs.existsSync(path.join(repo, ".gitattributes")), false);

  const worktree = forecastWithEngine(repo, "worktree", "rebase-forecast", "main");
  const mergeTree = forecastWithEngine(repo, "merge-tree", "rebase-forecast", "main");
  assert.equal(worktree.status, "complete");
  assert.equal(worktree.engine, "worktree");
  assert.deepEqual(worktree.steps.map((step) => step.outcome), ["clean"]);
  assert.deepEqual(normalizeForecast(mergeTree), normalizeForecast(worktree));
  assert.equal(mergeTree.status, "complete");
  assert.equal(mergeTree.engine, "merge-tree");
  assert.deepEqual(mergeTree.fallbacks, []);
  assert.equal(mergeTree.steps[0].sourceCommit, source.commit);
  assert.equal(mergeTree.predictedResultTree, worktree.predictedResultTree);
  const merged = git(repo, "show", `${mergeTree.predictedResultTree}:shared.txt`);
  assert.match(merged, /target/);
  assert.match(merged, /source/);
  assert.doesNotMatch(merged, /<<<<<<<|>>>>>>>/);
  assert.equal(fs.existsSync(path.join(repo, ".gitattributes")), false);
  assert.equal(git(repo, "status", "--porcelain=v1"), "");

  const result = JSON.parse(
    vlab(repo, "rebase", "main", "--use-forecast", mergeTree.id, "--json"),
  );
  assert.equal(result.receipt.forecastId, mergeTree.id);
  assert.equal(result.receipt.resultTree, mergeTree.predictedResultTree);
  assert.equal(git(repo, "rev-parse", "HEAD^{tree}"), mergeTree.predictedResultTree);
  assert.equal(readText(repo, "shared.txt"), `${merged.replace(/\r\n/g, "\n")}\n`);
  assert.equal(git(repo, "status", "--porcelain=v1"), "");
});

test("merge-tree workspace forecasts match the worktree oracle for committed heads", (t) => {
  if (skipWithoutMergeTreeEngine(t)) return;
  const { repo, parent } = makeRepo(t);
  write(repo, "shared.txt", "base\n");
  git(repo, "add", ".");
  vlab(repo, "commit", "-m", "base");
  vlab(repo, "init");

  const targetPath = path.join(parent, "target-agent");
  const sourcePath = path.join(parent, "source-agent");
  vlab(repo, "workspace", "create", "target-agent", "--path", targetPath, "--json");
  vlab(repo, "workspace", "create", "source-agent", "--path", sourcePath, "--json");
  write(targetPath, "target.txt", "target\n");
  git(targetPath, "add", ".");
  vlab(targetPath, "commit", "-m", "target edit");
  write(sourcePath, "source.txt", "source\n");
  git(sourcePath, "add", ".");
  const source = JSON.parse(vlab(sourcePath, "commit", "-m", "source edit"));
  write(sourcePath, "draft.txt", "uncommitted agent draft\n");

  const targetHead = git(targetPath, "rev-parse", "HEAD");
  const sourceStatus = git(sourcePath, "status", "--porcelain=v1");
  const worktree = forecastWithEngine(
    repo,
    "worktree",
    "workspace",
    "forecast",
    "target-agent",
    "source-agent",
  );
  const mergeTree = forecastWithEngine(
    repo,
    "merge-tree",
    "workspace",
    "forecast",
    "target-agent",
    "source-agent",
  );
  assert.equal(worktree.status, "complete");
  assert.equal(worktree.engine, "worktree");
  assert.deepEqual(normalizeForecast(mergeTree), normalizeForecast(worktree));
  assert.equal(mergeTree.status, "complete");
  assert.equal(mergeTree.engine, "merge-tree");
  assert.deepEqual(mergeTree.fallbacks, []);
  assert.equal(mergeTree.steps[0].sourceCommit, source.commit);
  assert.equal(mergeTree.workspaceComparison.scope, "committed-heads");
  assert.equal(mergeTree.workspaceComparison.source.ignoredDirtyFiles, 1);
  assert.equal(mergeTree.targetWorktree, targetPath);
  assert.equal(mergeTree.predictedResultTree, worktree.predictedResultTree);
  assert.equal(git(targetPath, "rev-parse", "HEAD"), targetHead);
  assert.equal(git(sourcePath, "status", "--porcelain=v1"), sourceStatus);
  assert.equal(readText(sourcePath, "draft.txt"), "uncommitted agent draft\n");
});

/**
 * The names a domain module may import from the Git engine: mutations,
 * transports, selectors, metrics, and pure helpers. Every read comes from
 * `src/engine.js` (ADR-0019).
 */
const GIT_ENGINE_NON_READ_EXPORTS = new Set([
  "runGit",
  "gitText",
  "GIT_NO_RERERE",
  "beginGitMetrics",
  "endGitMetrics",
  "withGitObjectSession",
  "gitObjectSessionEnabled",
  "FORECAST_ENGINES",
  "forecastEngine",
  "defaultForecastEngine",
  "MERGE_TREE_ENGINE_MIN_GIT",
  "MergeTreeSession",
  "READ_ENGINES",
  "readEngine",
  "withReadEngine",
  "extractTrailer",
]);

function stripVolatile(value) {
  return JSON.parse(JSON.stringify(value, (key, item) =>
    ["timings", "metrics", "id", "forecastId", "createdAt"].includes(key) ? undefined : item,
  ));
}

test("every repository read passes through the engine seam and the native engine passes through to Git", async (t) => {
  // Import discipline: only the seam reads from the Git engine, and only a
  // deliberate raw-Git measurement may bypass it -- the doctor's process-cost
  // probes, and the scale benchmark's raw-Git floors (issue #42). Both exist to
  // measure what one Git process costs on this host, which is the one question
  // the seam cannot answer about itself.
  const RAW_PROBE_MODULES = new Set(["cli.js", "scale-benchmark.js"]);
  const srcDir = path.join(projectRoot, "src");
  const engineModules = new Set([
    "git.js",
    "engine.js",
    "git-session-worker.js",
    "merge-tree-session-worker.js",
  ]);
  for (const file of fs.readdirSync(srcDir).filter((name) => name.endsWith(".js"))) {
    const source = fs.readFileSync(path.join(srcDir, file), "utf8");
    if (engineModules.has(file)) continue;
    if (!RAW_PROBE_MODULES.has(file)) {
      assert.ok(!source.includes("rawProbe"), `${file} must not bypass the engine seam with rawProbe`);
    }
    for (const block of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*"\.\/git\.js";/g)) {
      const names = block[1]
        .split(",")
        .map((item) => item.trim().split(/\s+as\s+/)[0])
        .filter(Boolean);
      for (const name of names) {
        assert.ok(
          GIT_ENGINE_NON_READ_EXPORTS.has(name),
          `${file} imports ${name} from ./git.js; reads must come from ./engine.js`,
        );
      }
    }
  }
  const engine = await import(pathToFileURL(path.join(srcDir, "engine.js")).href);
  const gitEngine = await import(pathToFileURL(path.join(srcDir, "git.js")).href);
  assert.ok(engine.READ_OPERATIONS.length >= 38);
  for (const operation of engine.READ_OPERATIONS) {
    assert.equal(typeof engine[operation], "function", `${operation} is exported by the seam`);
  }
  assert.deepEqual(engine.READ_ENGINES, ["git", "native"]);

  const { repo } = makeRepo(t);
  write(repo, "shared.txt", "base\n");
  git(repo, "add", "shared.txt");
  vlab(repo, "init");
  vlab(repo, "commit", "-m", "base");
  const head = git(repo, "rev-parse", "HEAD");
  git(repo, "switch", "-c", "feature");
  write(repo, "feature.txt", "feature\n");
  git(repo, "add", "feature.txt");
  vlab(repo, "commit", "-m", "feature");
  git(repo, "switch", "main");
  vlab(repo, "workspace", "create", "agent-a");

  // The same commands answer identically under each engine, and the metrics
  // of every result name the engine and its fallbacks.
  const runWithEngine = (engineName, ...args) => {
    const result = spawnSync(process.execPath, [cli, ...args], {
      cwd: repo,
      encoding: "utf8",
      env: testEnv({ VLAB_ENGINE: engineName }),
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  for (const args of [
    ["merge-plan", "feature", "--json"],
    ["rebase-plan", "main", "feature", "--json"],
    ["workspace", "list", "--json"],
    ["resolve", "list", "--json"],
    ["metadata", "status", "--json"],
  ]) {
    assert.deepEqual(
      stripVolatile(runWithEngine("native", ...args)),
      stripVolatile(runWithEngine("git", ...args)),
      `${args.join(" ")} differs between engines`,
    );
  }
  const gitForecast = JSON.parse(vlab(repo, "forecast", "feature", "--json", "--engine", "git"));
  const nativeForecast = JSON.parse(vlab(repo, "forecast", "feature", "--json", "--engine=native"));
  assert.deepEqual(normalizeForecast(nativeForecast), normalizeForecast(gitForecast));
  assert.equal(gitForecast.status, "complete");
  assert.equal(gitForecast.timings.git.engine, "git");
  assert.deepEqual(gitForecast.timings.git.fallbacks, []);
  assert.equal(gitForecast.timings.git.directReads, 0);
  assert.equal(nativeForecast.timings.git.engine, "native");
  assert.equal(nativeForecast.timings.git.directReads, 0);
  assert.equal(nativeForecast.timings.git.processes, gitForecast.timings.git.processes);
  assert.ok(nativeForecast.timings.git.fallbacks.length > 0);
  for (const fallback of nativeForecast.timings.git.fallbacks) {
    assert.equal(fallback.reason, "binding-missing");
    assert.ok(fallback.count >= 1);
    assert.ok(engine.READ_OPERATIONS.includes(fallback.operation), fallback.operation);
  }

  // The doctor names both selectors and compares the engines operation by
  // operation with the Git engine as oracle.
  const doctor = JSON.parse(vlab(repo, "doctor", "--differential", "--engine", "native"));
  assert.equal(doctor.engine.selected, "native");
  assert.equal(doctor.engine.default, "git");
  assert.deepEqual(doctor.engine.available, ["git", "native"]);
  assert.deepEqual(doctor.engine.native, {
    available: false,
    reason: "binding-missing",
    profile: null,
    operations: [],
  });
  assert.ok(["worktree", "merge-tree"].includes(doctor.forecastEngine));
  const differential = doctor.differential;
  assert.equal(differential.schema, "vcs-lab.engine-differential/v1");
  assert.deepEqual(differential.engines, ["git", "native"]);
  assert.equal(differential.oracle, "git");
  assert.equal(differential.equal, true);
  assert.deepEqual(differential.counts, {
    equal: engine.READ_OPERATIONS.length,
    different: 0,
    skipped: 0,
  });
  assert.deepEqual(
    differential.operations.map((item) => item.operation).sort(),
    [...engine.READ_OPERATIONS].sort(),
  );
  for (const item of differential.operations) {
    assert.equal(item.status, "equal", item.operation);
    assert.equal(item.results.git.error, null, item.operation);
    assert.equal(item.results.git.digest, item.results.native.digest, item.operation);
    assert.deepEqual(item.results.git.fallbacks, [], item.operation);
    assert.deepEqual(
      item.results.native.fallbacks,
      [{ operation: item.operation, reason: "binding-missing", count: 1 }],
      item.operation,
    );
    assert.equal(item.results.git.directReads, 0, item.operation);
    assert.equal(item.results.native.directReads, 0, item.operation);
  }
  assert.equal(JSON.parse(vlab(repo, "doctor", "--engine", "git")).engine.selected, "git");
  assert.equal(
    JSON.parse(vlab(repo, "doctor", "--engine", "git")).engine.default,
    "git",
  );

  // A read that bypasses the seam is counted in git mode and refused in
  // native mode; the doctor's raw probes are the one exemption.
  const previousEngine = process.env.VLAB_ENGINE;
  try {
    process.env.VLAB_ENGINE = "git";
    const counted = gitEngine.beginGitMetrics("bypass");
    assert.equal(gitEngine.runGit(["rev-parse", "HEAD"], { cwd: repo }).stdout, head);
    const countedMetrics = gitEngine.endGitMetrics(counted);
    assert.equal(countedMetrics.engine, "git");
    assert.equal(countedMetrics.directReads, 1);
    assert.deepEqual(countedMetrics.fallbacks, []);

    process.env.VLAB_ENGINE = "native";
    assert.throws(
      () => gitEngine.runGit(["rev-parse", "HEAD"], { cwd: repo }),
      /git rev-parse was read outside the engine seam/,
    );
    assert.throws(
      () => gitEngine.runGit(["worktree", "list", "--porcelain"], { cwd: repo }),
      /git worktree was read outside the engine seam/,
    );
    assert.equal(
      gitEngine.runGit(["rev-parse", "HEAD"], { cwd: repo, rawProbe: true }).stdout,
      head,
    );
    const seam = gitEngine.beginGitMetrics("seam");
    assert.equal(engine.currentHead(repo), head);
    assert.equal(engine.treeId(head, repo), git(repo, "rev-parse", `${head}^{tree}`));
    const seamMetrics = gitEngine.endGitMetrics(seam);
    assert.equal(seamMetrics.engine, "native");
    assert.equal(seamMetrics.directReads, 0);
    assert.deepEqual(seamMetrics.fallbacks, [
      { operation: "resolveRevision", reason: "binding-missing", count: 1 },
      { operation: "treeId", reason: "binding-missing", count: 1 },
    ]);
    // A mutation is never a bypass, whichever engine is selected.
    gitEngine.runGit(["update-ref", "refs/vcs-lab-test/probe", head], { cwd: repo });
    assert.equal(git(repo, "rev-parse", "refs/vcs-lab-test/probe"), head);
    assert.equal(
      gitEngine.withReadEngine("git", () => gitEngine.readEngine()),
      "git",
    );
    assert.equal(gitEngine.readEngine(), "native");
  } finally {
    if (previousEngine === undefined) delete process.env.VLAB_ENGINE;
    else process.env.VLAB_ENGINE = previousEngine;
  }

  // Invalid selections fail before any work, by flag or by environment.
  const badFlag = vlabResult(repo, "doctor", "--engine", "bogus");
  assert.notEqual(badFlag.status, 0);
  assert.match(badFlag.stderr, /--engine requires one of: git, native/);
  const badEnv = spawnSync(process.execPath, [cli, "doctor"], {
    cwd: repo,
    encoding: "utf8",
    env: testEnv({ VLAB_ENGINE: "bogus" }),
  });
  assert.notEqual(badEnv.status, 0);
  assert.match(badEnv.stderr, /Unknown engine 'bogus'\. Use one of: git, native/);
  assert.equal(git(repo, "rev-parse", "HEAD"), head);
  assert.equal(git(repo, "status", "--porcelain=v1"), "");
});

test("recordsReachableFrom derives the reachable set when a caller does not pass one", (t) => {
  const { repo } = makeRepo(t);
  write(repo, "app.txt", "base\n");
  git(repo, "add", ".");
  vlab(repo, "commit", "-m", "base");
  vlab(repo, "init");
  vlab(repo, "branch", "feature");
  write(repo, "feature.txt", "one\n");
  git(repo, "add", ".");
  vlab(repo, "commit", "-m", "feature one");
  git(repo, "switch", "main");
  const landing = JSON.parse(vlab(repo, "hard-squash", "feature", "--json"));

  // The two-argument form used to throw: its third parameter shadowed the
  // imported reachableCommits it needed to derive the set from, so only the
  // one caller that passed a set ever worked.
  const derived = recordsReachableFrom("HEAD", repo);
  const commits = reachableCommits("HEAD", repo);
  const fromSet = recordsReachableFrom("HEAD", repo, new Set(commits));
  const fromArray = recordsReachableFrom("HEAD", repo, commits);
  assert.deepEqual(derived, fromSet);
  assert.deepEqual(derived, fromArray);
  assert.ok(
    derived.some((record) => record.id === landing.id),
    "the landing receipt is reachable from the target",
  );
  assert.ok(
    !recordsReachableFrom("feature", repo).some((record) => record.id === landing.id),
    "the receipt sits on the landing commit, which the source does not reach",
  );
});

test("a branch named CHERRY_PICK_HEAD does not pass for a pending cherry-pick", (t) => {
  // Git metadata is untrusted input. `rev-parse CHERRY_PICK_HEAD` resolves a
  // branch of that name when no pick is pending, which the sequencer-state
  // reads must not mistake for one; and when a pick is pending the branch
  // must not hide it.
  const { repo } = makeRepo(t);
  write(repo, "a.txt", "base\n");
  git(repo, "add", ".");
  vlab(repo, "commit", "-m", "base");
  vlab(repo, "init");
  git(repo, "branch", "CHERRY_PICK_HEAD");
  assert.equal(pseudoRefTarget("CHERRY_PICK_HEAD", repo), null);

  git(repo, "switch", "-c", "side");
  write(repo, "a.txt", "side\n");
  git(repo, "add", ".");
  const side = JSON.parse(vlab(repo, "commit", "-m", "side"));
  git(repo, "switch", "main");
  write(repo, "a.txt", "main\n");
  git(repo, "add", ".");
  vlab(repo, "commit", "-m", "main");
  const picked = spawnSync("git", ["cherry-pick", side.commit], {
    cwd: repo,
    encoding: "utf8",
    env: testEnv(),
  });
  assert.notEqual(picked.status, 0, "the pick must conflict so it stays pending");
  assert.equal(pseudoRefTarget("CHERRY_PICK_HEAD", repo), side.commit);
  git(repo, "cherry-pick", "--abort");
  assert.equal(pseudoRefTarget("CHERRY_PICK_HEAD", repo), null);
});
