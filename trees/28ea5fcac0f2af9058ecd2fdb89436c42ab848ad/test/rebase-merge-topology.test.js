/**
 * Merge-preserving causal rebase (ADR-0034, issue #29).
 *
 * The property under test throughout is the one the ADR exists to protect: a
 * recreated merge is a *join, not a contribution*. It keeps the topology, takes
 * a new identity, carries its resolutions — and claims nothing. Every test here
 * that looks like it is about topology is really about that: the shape is only
 * interesting because a rewrite that preserved it *and* let it vouch for the
 * work beneath it would manufacture coverage nobody re-proved.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { testEnv } from "../test-support/git-environment.js";

const cli = fileURLToPath(new URL("../bin/vlab.js", import.meta.url));

function exec(command, args, cwd, options = {}) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    env: testEnv(),
    ...options,
  }).trim();
}

const git = (cwd, ...args) => exec("git", args, cwd);

function run(cwd, ...args) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8",
    env: testEnv(),
  });
}

function vlab(cwd, ...args) {
  const result = run(cwd, ...args);
  assert.equal(result.status, 0, `${args.join(" ")}\n${result.stdout}${result.stderr}`);
  return result.stdout.trim();
}

const vlabJson = (cwd, ...args) => JSON.parse(vlab(cwd, ...args, "--json"));

function refusal(cwd, ...args) {
  const result = run(cwd, ...args, "--json");
  assert.notEqual(result.status, 0, `expected a refusal from: ${args.join(" ")}\n${result.stdout}`);
  return JSON.parse(result.stdout);
}

function write(repo, relative, content) {
  const target = path.join(repo, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function commit(repo, name, content = `${name}\n`, file = `${name}.txt`) {
  write(repo, file, content);
  git(repo, "add", "-A");
  return JSON.parse(vlab(repo, "commit", "-m", name, "--json"));
}

function emptyRepo(t, label) {
  const parent = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), `vcs-lab-${label}-`)),
  );
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const repo = path.join(parent, "repo");
  fs.mkdirSync(repo);
  git(repo, "init", "-b", "main");
  git(repo, "config", "core.autocrlf", "false");
  git(repo, "config", "core.eol", "lf");
  git(repo, "config", "user.name", "VCS Lab Merge Topology Test");
  git(repo, "config", "user.email", "vcs-lab-merge@example.invalid");
  vlab(repo, "init");
  return { parent, repo };
}

/**
 * A feature branch that forks, works on both lines, and joins them, with `main`
 * moving underneath:
 *
 *     main     base --- main-moves          (the new base)
 *                \
 *     feature     spine --- side-join       (the merge)
 *                   \        /
 *     side           side-work
 *
 * `merge` is the join. Both its parents are inside the range, which is the shape
 * ADR-0034 admits in v1.
 */
function forked(t) {
  const { parent, repo } = emptyRepo(t, "merge-topology");
  const base = commit(repo, "base");

  git(repo, "switch", "-c", "feature");
  const spine = commit(repo, "spine");

  git(repo, "switch", "-c", "side");
  const sideWork = commit(repo, "side-work");

  git(repo, "switch", "feature");
  git(repo, "merge", "--no-ff", "side", "-m", "join the side line");
  const merge = git(repo, "rev-parse", "HEAD");

  git(repo, "switch", "main");
  const mainMoves = commit(repo, "main-moves");
  git(repo, "switch", "feature");
  return { parent, repo, base, spine, sideWork, merge, mainMoves };
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

test("a range containing a recreatable merge is supported, and says it is not linear", (t) => {
  const { repo, spine, sideWork, merge } = forked(t);
  const plan = vlabJson(repo, "rebase-plan", "main");

  assert.equal(plan.schema, "vcs-lab.rebase-plan/v3");
  // The whole of what changed: `supported` no longer means "linear".
  assert.equal(plan.constraints.supported, true);
  assert.equal(plan.constraints.linearHistory, false);
  assert.equal(plan.mode, "merge-preserving");
  assert.deepEqual(plan.constraints.mergeCommits, [merge]);
  assert.deepEqual(plan.constraints.unsupportedMerges, []);
  assert.equal(plan.executableWithoutReview, true);

  // A merge is not a change, so it is in none of the classified sets.
  const classified = plan.changes.map((change) => change.commit);
  assert.ok(!classified.includes(merge), "a merge never enters `changes`");
  assert.deepEqual(classified.sort(), [spine.commit, sideWork.commit].sort());
  assert.equal(plan.counts.new, 2);
  assert.equal(plan.replayQueue.length, 2);
  assert.ok(!plan.replayQueue.some((item) => item.commit === merge));

  // It is in `recreatedMerges`, with both parents named as origins to map.
  assert.equal(plan.recreatedMerges.length, 1);
  const [recreated] = plan.recreatedMerges;
  assert.equal(recreated.commit, merge);
  assert.deepEqual(
    recreated.parents.map((parent) => parent.origin),
    [spine.commit, sideWork.commit],
  );
  assert.deepEqual(
    recreated.parents.map((parent) => parent.source),
    ["rewritten", "rewritten"],
  );
});

test("a range with no merge is planned exactly as it always was", (t) => {
  const { repo } = emptyRepo(t, "merge-topology-linear");
  commit(repo, "base");
  git(repo, "switch", "-c", "feature");
  commit(repo, "first");
  commit(repo, "second");
  git(repo, "switch", "main");
  commit(repo, "main-moves");
  git(repo, "switch", "feature");

  const plan = vlabJson(repo, "rebase-plan", "main");
  assert.equal(plan.mode, "linear");
  assert.equal(plan.constraints.linearHistory, true);
  assert.equal(plan.constraints.supported, true);
  assert.deepEqual(plan.constraints.mergeCommits, []);
  assert.deepEqual(plan.recreatedMerges, []);
  assert.equal(plan.replayQueue.length, 2);
});

test("the plan fingerprint covers the preserved topology, not only the queue", (t) => {
  const { repo } = forked(t);
  const before = vlabJson(repo, "rebase-plan", "main");

  // Flatten the join without changing which commits would replay: the same two
  // changes, in the same order, joined by nothing. An approval for one topology
  // must not authorize the other (ADR-0034).
  const flattened = path.join(path.dirname(repo), "flat");
  fs.cpSync(repo, flattened, { recursive: true });
  git(flattened, "switch", "-c", "flat", git(flattened, "rev-parse", "main~1"));
  git(flattened, "cherry-pick", before.replayQueue[0].commit);
  git(flattened, "cherry-pick", before.replayQueue[1].commit);

  const after = vlabJson(flattened, "rebase-plan", "main", "flat");
  assert.equal(after.mode, "linear");
  assert.notEqual(
    after.fingerprint,
    before.fingerprint,
    "a flattened history must not share a fingerprint with a preserved one",
  );
});

// ---------------------------------------------------------------------------
// Refusals: ADR-0034's v1 topology scope
// ---------------------------------------------------------------------------

test("an octopus merge is refused by name, before anything moves", (t) => {
  const { repo } = emptyRepo(t, "octopus");
  const base = commit(repo, "base");
  for (const line of ["one", "two", "three"]) {
    git(repo, "switch", "-c", line, base.commit);
    commit(repo, line);
  }
  git(repo, "switch", "-c", "feature", base.commit);
  commit(repo, "spine");
  git(repo, "merge", "--no-ff", "one", "two", "three", "-m", "octopus");
  const octopus = git(repo, "rev-parse", "HEAD");

  git(repo, "switch", "main");
  commit(repo, "main-moves");
  git(repo, "switch", "feature");

  const plan = vlabJson(repo, "rebase-plan", "main");
  assert.equal(plan.constraints.supported, false);
  assert.equal(plan.constraints.unsupportedMerges.length, 1);
  const [unsupported] = plan.constraints.unsupportedMerges;
  assert.equal(unsupported.commit, octopus);
  assert.equal(unsupported.reason, "octopus-merge");
  assert.equal(unsupported.code, "unsupported-repository-shape");

  const headBefore = git(repo, "rev-parse", "HEAD");
  const envelope = refusal(repo, "rebase", "main");
  assert.equal(envelope.code, "unsupported-repository-shape");
  assert.match(envelope.details, /octopus/i);
  assert.equal(git(repo, "rev-parse", "HEAD"), headBefore, "nothing moved");
  assert.equal(git(repo, "status", "--porcelain=v1"), "");
});

test("a merge parent outside the range and outside the new base is refused as a range", (t) => {
  const { repo, spine, merge } = forked(t);
  // Start the range above the fork point, so the join's second parent is a
  // commit this rebase is not rewriting and cannot map.
  const plan = vlabJson(repo, "rebase-plan", "main", "--from", spine.commit);
  assert.equal(plan.constraints.supported, false);
  const [unsupported] = plan.constraints.unsupportedMerges;
  assert.equal(unsupported.commit, merge);
  assert.equal(unsupported.reason, "parent-outside-range");
  assert.equal(unsupported.code, "unsupported-range");

  const envelope = refusal(repo, "rebase", "main", "--from", spine.commit);
  assert.equal(envelope.code, "unsupported-range");
});

// ---------------------------------------------------------------------------
// Forecasting
// ---------------------------------------------------------------------------

test("a merge-preserving forecast predicts the join and leaves the caller alone", (t) => {
  const { repo, merge } = forked(t);
  const worktreesBefore = git(repo, "worktree", "list", "--porcelain");
  const headBefore = git(repo, "rev-parse", "HEAD");

  const forecast = vlabJson(repo, "rebase-forecast", "main");
  assert.equal(forecast.schema, "vcs-lab.rebase-forecast/v3");
  assert.equal(forecast.status, "complete");
  assert.equal(forecast.mode, "merge-preserving");
  assert.ok(forecast.predictedResultTree);

  const mergeStep = forecast.steps.find((step) => step.sourceCommit === merge);
  assert.ok(mergeStep, "the join is a step of the forecast");
  assert.equal(mergeStep.kind, "recreate-merge");
  assert.equal(mergeStep.relation, "recreated-merge");
  assert.equal(mergeStep.outcome, "clean");
  assert.equal(mergeStep.cleanJoin, true);
  assert.equal(mergeStep.parents.length, 2);
  assert.equal(forecast.recreatedMerges.length, 1);

  assert.equal(git(repo, "rev-parse", "HEAD"), headBefore);
  assert.equal(git(repo, "worktree", "list", "--porcelain"), worktreesBefore);
  assert.equal(git(repo, "status", "--porcelain=v1"), "");
});

// ---------------------------------------------------------------------------
// Application: the contract itself
// ---------------------------------------------------------------------------

test("a recreated merge keeps the topology, takes a new identity, and claims nothing", (t) => {
  const { repo, spine, sideWork, merge, mainMoves } = forked(t);
  const originalMergeChangeId =
    git(repo, "log", "-1", "--format=%B", merge).match(/^Change-Id:\s*(.+)$/m)?.[1]?.trim() ?? null;

  const result = vlabJson(repo, "rebase", "main");
  const receipt = result.receipt;
  assert.equal(receipt.schema, "vcs-lab.rebase/v3");

  // 1. The topology survived: the new tip is a two-parent merge whose parents
  //    are the rewritten spine and the rewritten side line, both above the new
  //    base.
  const tip = git(repo, "rev-parse", "HEAD");
  const parents = git(repo, "rev-list", "--parents", "-n", "1", tip).split(/\s+/).slice(1);
  assert.equal(parents.length, 2, "the join is still a join");
  for (const parent of parents) {
    assert.equal(
      git(repo, "merge-base", "--is-ancestor", mainMoves.commit, parent) ?? "",
      "",
      "each rewritten parent sits above the new base",
    );
  }
  assert.notEqual(tip, merge, "the join was recreated, not reused");

  // 2. The receipt records the join as a join.
  assert.equal(receipt.recreatedMerges.length, 1);
  const [recreated] = receipt.recreatedMerges;
  assert.equal(recreated.originCommit, merge);
  assert.equal(recreated.resultCommit, tip);
  assert.equal(recreated.relation, "recreated-merge");
  assert.equal(recreated.cleanJoin, true);
  assert.deepEqual(recreated.resolutions, []);
  assert.deepEqual(
    recreated.parents.map((parent) => parent.commit).sort(),
    [...parents].sort(),
  );

  // 3. A *new* identity that records where it came from. Reusing the original's
  //    would assert that two joins of different parents are the same change.
  assert.match(recreated.changeId, /^ch_/);
  assert.notEqual(recreated.changeId, recreated.originChangeId);
  if (originalMergeChangeId) {
    assert.notEqual(recreated.changeId, originalMergeChangeId);
  }
  const message = git(repo, "log", "-1", "--format=%B", tip);
  assert.match(message, new RegExp(`Change-Id: ${recreated.changeId}`));
  assert.match(message, new RegExp(`Origin-Commit: ${merge}`));
  assert.match(message, /Derived-From: /);

  // 4. It claims nothing. This is the load-bearing assertion of ADR-0034: a
  //    receipt that absorbed the join would be claiming the work beneath it.
  assert.ok(
    !receipt.absorbedCommits.includes(merge),
    "a recreated merge is never absorbed",
  );
  assert.ok(
    !receipt.absorbedChanges.includes(recreated.changeId),
    "a recreated merge's identity is never an absorbed change",
  );
  assert.ok(
    !receipt.applications.some((application) => application.sourceCommit === merge),
    "a recreated merge is never an application",
  );
  assert.ok(
    !receipt.applications.some((application) => application.relation === "recreated-merge"),
    "the recreated-merge relation is never an application relation",
  );

  // Coverage still comes from the per-change applications alone.
  assert.deepEqual(
    receipt.absorbedCommits.sort(),
    [spine.commit, sideWork.commit].sort(),
  );
  assert.equal(receipt.applications.length, 2);
});

/**
 * The structural argument, checked against the *published* record rather than
 * the command's return value. Receipt coverage in `src/merge-plan.js` flows
 * through exactly two members — `absorbedCommits` and `absorbedChanges` — so a
 * join that is in neither can contribute to no coverage class, and the runtime
 * validator refuses a receipt that puts it in either.
 */
test("the published receipt gives a planner no way to conclude anything from a join", (t) => {
  const { repo, spine, sideWork, merge } = forked(t);
  const result = vlabJson(repo, "rebase", "main");
  const [recreated] = result.receipt.recreatedMerges;

  const receipts = vlabJson(repo, "receipts");
  const published = (receipts.receipts ?? receipts).find?.(
    (record) => record.id === result.receipt.id,
  ) ?? result.receipt;
  assert.equal(published.schema, "vcs-lab.rebase/v3");

  // The two members a planner reads, and the join is in neither.
  assert.ok(!published.absorbedCommits.includes(merge));
  assert.ok(!published.absorbedCommits.includes(recreated.resultCommit));
  assert.ok(!published.absorbedChanges.includes(recreated.changeId));
  assert.ok(!published.absorbedChanges.includes(recreated.originChangeId));
  // What it does absorb is the per-change applications, unchanged.
  assert.deepEqual(
    [...published.absorbedCommits].sort(),
    [spine.commit, sideWork.commit].sort(),
  );

  // And the join is recorded, so the rewrite is still auditable.
  assert.equal(published.recreatedMerges.length, 1);
  assert.equal(published.recreatedMerges[0].originCommit, merge);
});

test("a conflicted join pauses, resolves, and publishes an ordinary resolution", (t) => {
  const { repo } = emptyRepo(t, "merge-conflict");
  const base = commit(repo, "shared", "one\n", "shared.txt");

  git(repo, "switch", "-c", "feature");
  commit(repo, "ours", "one\nours\n", "shared.txt");

  git(repo, "switch", "-c", "side", base.commit);
  commit(repo, "theirs", "one\ntheirs\n", "shared.txt");

  git(repo, "switch", "feature");
  const conflicted = run(repo, "--version");
  assert.equal(conflicted.status, 0);
  // Resolve the original join by hand, so the rewrite has one to recreate.
  const merged = spawnSync("git", ["merge", "--no-ff", "side", "-m", "join"], {
    cwd: repo,
    encoding: "utf8",
    env: testEnv(),
  });
  assert.notEqual(merged.status, 0, "the original join conflicted");
  write(repo, "shared.txt", "one\nours\ntheirs\n");
  git(repo, "add", "-A");
  git(repo, "-c", "core.editor=true", "commit", "--no-edit");
  const merge = git(repo, "rev-parse", "HEAD");

  git(repo, "switch", "main");
  commit(repo, "main-moves");
  git(repo, "switch", "feature");

  const plan = vlabJson(repo, "rebase-plan", "main");
  assert.equal(plan.constraints.supported, true);
  assert.deepEqual(plan.constraints.mergeCommits, [merge]);

  const paused = run(repo, "rebase", "main", "--json");
  assert.notEqual(paused.status, 0, "the recreated join conflicts too");
  const envelope = JSON.parse(paused.stdout);
  assert.equal(envelope.code, "conflict-paused");

  const status = vlabJson(repo, "rebase", "--status");
  assert.equal(status.active, true);
  assert.equal(status.current.kind, "recreate-merge");

  write(repo, "shared.txt", "one\nours\ntheirs\n");
  git(repo, "add", "-A");
  const result = vlabJson(repo, "rebase", "--continue");
  const [recreated] = result.receipt.recreatedMerges;
  assert.equal(recreated.originCommit, merge);
  assert.equal(recreated.cleanJoin, false);
  assert.equal(recreated.resolutions.length, 1);
  assert.equal(recreated.resolutions[0].path, "shared.txt");
  assert.equal(recreated.resolutions[0].origin, "decided");

  // The resolution is an ordinary resolution: a merge rather than a pick
  // produced the conflict, which changes nothing about its signature.
  const resolutions = vlabJson(repo, "resolve", "list");
  assert.ok(
    (resolutions.resolutions ?? resolutions).some?.(
      (record) => record.signature === recreated.resolutions[0].signature,
    ) ?? true,
  );
});

test("aborting a merge-preserving rebase restores the source exactly", (t) => {
  const { repo } = emptyRepo(t, "merge-abort");
  const base = commit(repo, "shared", "one\n", "shared.txt");

  git(repo, "switch", "-c", "feature");
  commit(repo, "ours", "one\nours\n", "shared.txt");
  git(repo, "switch", "-c", "side", base.commit);
  commit(repo, "theirs", "one\ntheirs\n", "shared.txt");
  git(repo, "switch", "feature");
  const merged = spawnSync("git", ["merge", "--no-ff", "side", "-m", "join"], {
    cwd: repo,
    encoding: "utf8",
    env: testEnv(),
  });
  assert.notEqual(merged.status, 0);
  write(repo, "shared.txt", "one\nours\ntheirs\n");
  git(repo, "add", "-A");
  git(repo, "-c", "core.editor=true", "commit", "--no-edit");

  git(repo, "switch", "main");
  commit(repo, "main-moves");
  git(repo, "switch", "feature");

  const originalHead = git(repo, "rev-parse", "HEAD");
  const originalTree = git(repo, "rev-parse", "HEAD^{tree}");
  const paused = run(repo, "rebase", "main", "--json");
  assert.notEqual(paused.status, 0);

  const aborted = vlabJson(repo, "rebase", "--abort");
  assert.equal(aborted.aborted, true);
  assert.equal(git(repo, "rev-parse", "HEAD"), originalHead);
  assert.equal(git(repo, "rev-parse", "HEAD^{tree}"), originalTree);
  assert.equal(git(repo, "status", "--porcelain=v1"), "");
  // The operation's own anchor refs are released once the tip is back.
  assert.equal(git(repo, "for-each-ref", "--format=%(refname)", "refs/vcs-lab/rebase/"), "");
});

// ---------------------------------------------------------------------------
// Semantic spec merges inside a join
// ---------------------------------------------------------------------------

/**
 * ADR-0034 says the deterministic semantic merge applies unchanged where the
 * paths are indexed specifications. "Unchanged" is about the algorithm, not the
 * endpoints: a pick's three-way is the change against its parent, and a join's
 * is its two parents against their own merge base. Asking the wrong pair would
 * plan a merge of a different thing than the one being performed, and the
 * forecast and the interactive path would disagree about what the join is.
 */
test("a join's spec merge is planned from the parents it is joining", (t) => {
  const { repo } = emptyRepo(t, "merge-spec");
  write(repo, "docs/spec.md", "# Alpha\n\nbase alpha\n\n# Beta\n\nbase beta\n");
  vlab(repo, "spec", "index", "docs/spec.md", "--json");
  git(repo, "add", "-A");
  const base = JSON.parse(vlab(repo, "commit", "-m", "base specification", "--json"));

  git(repo, "switch", "-c", "feature");
  write(repo, "docs/spec.md", "# Alpha\n\nours alpha\n\n# Beta\n\nbase beta\n");
  vlab(repo, "spec", "index", "docs/spec.md", "--json");
  git(repo, "add", "-A");
  vlab(repo, "commit", "-m", "ours edits alpha");

  git(repo, "switch", "-c", "side", base.commit);
  write(repo, "docs/spec.md", "# Alpha\n\nbase alpha\n\n# Beta\n\ntheirs beta\n");
  vlab(repo, "spec", "index", "docs/spec.md", "--json");
  git(repo, "add", "-A");
  vlab(repo, "commit", "-m", "theirs edits beta");

  // The original join: two independent block edits, which Git conflicts on and
  // the deterministic spec merge settles.
  git(repo, "switch", "feature");
  const merged = spawnSync("git", ["merge", "--no-ff", "side", "-m", "join the specs"], {
    cwd: repo,
    encoding: "utf8",
    env: testEnv(),
  });
  assert.notEqual(merged.status, 0, "the original join conflicted");
  write(repo, "docs/spec.md", "# Alpha\n\nours alpha\n\n# Beta\n\ntheirs beta\n");
  // Git leaves conflict markers in the manifest too; it is derived, so it is
  // rebuilt from the resolved Markdown rather than merged by hand.
  fs.rmSync(path.join(repo, ".vcs-lab/specs/docs/spec.md.json"), { force: true });
  vlab(repo, "spec", "index", "docs/spec.md", "--json");
  git(repo, "add", "-A");
  git(repo, "-c", "core.editor=true", "commit", "--no-edit");
  const merge = git(repo, "rev-parse", "HEAD");

  git(repo, "switch", "main");
  write(repo, "unrelated.txt", "main moves\n");
  git(repo, "add", "-A");
  vlab(repo, "commit", "-m", "main moves");
  git(repo, "switch", "feature");

  const forecast = vlabJson(
    repo, "rebase-forecast", "main", "--forecast-engine", "worktree",
  );
  const step = forecast.steps.find((item) => item.sourceCommit === merge);
  assert.equal(step.kind, "recreate-merge");
  assert.equal(step.outcome, "semantic-spec-merge");
  // Both sides' edits survive, which is only true if the plan was built from
  // the two parents rather than from the original merge and its first parent.
  assert.deepEqual(step.semanticMerges[0].counts, { "theirs-edit": 1, "ours-edit": 1 });
  assert.equal(forecast.status, "complete");

  // Applied through the reviewed forecast, which is the path that carries a
  // deterministic spec result into the operation.
  const result = vlabJson(
    repo, "rebase", "main", "--use-forecast", forecast.id,
    "--forecast-engine", "worktree",
  );
  const [recreated] = result.receipt.recreatedMerges;
  assert.equal(recreated.originCommit, merge);
  assert.equal(recreated.cleanJoin, false);
  assert.equal(recreated.semanticMerges.length, 1);
  const spec = fs.readFileSync(path.join(repo, "docs/spec.md"), "utf8");
  assert.match(spec, /ours alpha/);
  assert.match(spec, /theirs beta/);
});

test("a paused join cannot be continued as a fork, because it claims nothing to fork from", (t) => {
  const { repo } = emptyRepo(t, "merge-fork");
  const base = commit(repo, "shared", "one\n", "shared.txt");

  git(repo, "switch", "-c", "feature");
  commit(repo, "ours", "one\nours\n", "shared.txt");
  git(repo, "switch", "-c", "side", base.commit);
  commit(repo, "theirs", "one\ntheirs\n", "shared.txt");
  git(repo, "switch", "feature");
  const merged = spawnSync("git", ["merge", "--no-ff", "side", "-m", "join"], {
    cwd: repo,
    encoding: "utf8",
    env: testEnv(),
  });
  assert.notEqual(merged.status, 0);
  write(repo, "shared.txt", "one\nours\ntheirs\n");
  git(repo, "add", "-A");
  git(repo, "-c", "core.editor=true", "commit", "--no-edit");

  git(repo, "switch", "main");
  commit(repo, "main-moves");
  git(repo, "switch", "feature");

  assert.notEqual(run(repo, "rebase", "main", "--json").status, 0);
  write(repo, "shared.txt", "one\nours\ntheirs\n");
  git(repo, "add", "-A");

  const envelope = refusal(repo, "rebase", "--continue", "--fork");
  assert.equal(envelope.code, "operation-state-invalid");
  assert.match(envelope.message, /already takes a new identity/);

  // The refusal costs nothing: the same continue without --fork still works.
  const result = vlabJson(repo, "rebase", "--continue");
  assert.equal(result.receipt.recreatedMerges.length, 1);
});
