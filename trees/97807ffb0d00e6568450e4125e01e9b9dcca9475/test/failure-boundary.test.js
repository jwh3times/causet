import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { FAULT_EXIT_CODE } from "../src/faults.js";
import { testEnv } from "../test-support/git-environment.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(projectRoot, "bin", "vlab.js");

const created = [];
after(() => {
  for (const directory of created) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function exec(command, args, cwd, options = {}) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    env: testEnv(),
    ...options,
  }).trim();
}

const git = (cwd, ...args) => exec("git", args, cwd);
const vlab = (cwd, ...args) => exec(process.execPath, [cli, ...args], cwd);

function vlabResult(cwd, args, env = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8",
    env: testEnv({ ...env }),
  });
}

/**
 * The failure envelope of a `--json` run (ADR-0021). Since the envelope
 * landed, a refusal under `--json` is a document on stdout rather than prose
 * on stderr, which lets these tests assert the classification instead of
 * matching English.
 */
function refusal(result) {
  assert.notEqual(result.status, 0, "the command must refuse");
  assert.equal(result.stderr, "", "a --json refusal writes one stream");
  return JSON.parse(result.stdout);
}

function write(repo, relative, content) {
  const target = path.join(repo, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

/**
 * A repository whose reconciliation runs to completion without conflicting:
 * the source and target touch different files, so the operation reaches the
 * publication path, which is the stretch these tests interrupt.
 */
function makeReconcilable() {
  const parent = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "vcs-lab-fault-")));
  created.push(parent);
  const repo = path.join(parent, "repo");
  fs.mkdirSync(repo);
  git(repo, "init", "-b", "main");
  git(repo, "config", "core.autocrlf", "false");
  git(repo, "config", "core.eol", "lf");
  git(repo, "config", "user.name", "VCS Lab Fault Test");
  git(repo, "config", "user.email", "vcs-lab-fault@example.invalid");
  write(repo, "a.txt", "base\n");
  git(repo, "add", "-A");
  vlab(repo, "commit", "-m", "base");
  vlab(repo, "init");
  git(repo, "switch", "-c", "feature");
  write(repo, "f.txt", "feature\n");
  git(repo, "add", "-A");
  vlab(repo, "commit", "-m", "feature one");
  git(repo, "switch", "main");
  write(repo, "m.txt", "main\n");
  git(repo, "add", "-A");
  vlab(repo, "commit", "-m", "main moves");
  return repo;
}

const receipts = (repo) => JSON.parse(vlab(repo, "receipts", "--json"));
const journalPath = (repo) => path.join(repo, ".git", "vcs-lab", "reconciliation.json");
const notesRef = (repo) =>
  spawnSync("git", ["rev-parse", "refs/notes/vcs-lab"], { cwd: repo, encoding: "utf8", env: testEnv() })
    .stdout.trim();

test("an interrupted publication leaves a recoverable journal and no duplicate records", () => {
  for (const point of [
    "reconcile:before-publish",
    "reconcile:before-receipt",
    "reconcile:before-clear",
  ]) {
    const repo = makeReconcilable();
    const interrupted = vlabResult(repo, ["reconcile", "feature", "--json"], {
      VLAB_TEST_FAULT: point,
    });
    assert.equal(
      interrupted.status,
      FAULT_EXIT_CODE,
      `${point}: the fault must stop the process, not fail normally`,
    );

    // The journal always survives, which is what makes the operation
    // recoverable at all rather than merely broken.
    assert.ok(fs.existsSync(journalPath(repo)), `${point}: the journal must survive`);
    const status = JSON.parse(vlab(repo, "reconcile", "--status", "--json"));
    assert.equal(status.active, true, `${point}: the operation is still reported as pending`);

    const published = receipts(repo);
    const ids = published.map((record) => record.id);
    assert.equal(
      new Set(ids).size,
      ids.length,
      `${point}: an interruption must never duplicate a record`,
    );
    if (point === "reconcile:before-publish") {
      assert.equal(published.length, 0, "nothing is published before the publication loop");
    }
    if (point === "reconcile:before-clear") {
      assert.ok(
        published.some((record) => record.type === "reconciliation"),
        "the reconciliation receipt is published before the journal is cleared",
      );
    }

    // Continuing must not re-run publication over records that already exist.
    const resumed = vlabResult(repo, ["reconcile", "--continue", "--json"]);
    const afterResume = receipts(repo).map((record) => record.id);
    assert.equal(
      new Set(afterResume).size,
      afterResume.length,
      `${point}: --continue must not duplicate published records`,
    );
    if (resumed.status !== 0) {
      assert.ok(
        refusal(resumed).code,
        `${point}: a refused continue must carry a published error code`,
      );
    }
  }
});

test("aborting an interrupted publication restores the head and leaves no effective coverage", () => {
  // The damaging case: the process died after both receipts were published but
  // before the journal was cleared, so an abort rolls the target back out from
  // under records that already exist.
  const repo = makeReconcilable();
  const before = git(repo, "rev-parse", "HEAD");
  const interrupted = vlabResult(repo, ["reconcile", "feature", "--json"], {
    VLAB_TEST_FAULT: "reconcile:before-clear",
  });
  assert.equal(interrupted.status, FAULT_EXIT_CODE);
  assert.equal(receipts(repo).length, 2, "both receipts were published before the fault");

  const aborted = JSON.parse(vlab(repo, "reconcile", "--abort", "--json"));
  assert.equal(aborted.aborted, true);
  assert.equal(git(repo, "rev-parse", "HEAD"), before, "abort restores the starting commit");
  assert.equal(fs.existsSync(journalPath(repo)), false, "abort clears the journal");

  // The receipts survive on the notes ref: nothing rewrites a peer-visible ref
  // to erase history. What matters is that they carry no weight, because the
  // commits they are attached to are no longer reachable from the target and
  // FR-PLAN-05 admits only reachable receipts as evidence.
  const survivors = receipts(repo);
  assert.equal(survivors.length, 2, "published records are not rewritten away by an abort");
  for (const record of survivors) {
    const reachable = spawnSync(
      "git",
      ["merge-base", "--is-ancestor", record.attachedTo, "HEAD"],
      { cwd: repo, encoding: "utf8", env: testEnv() },
    );
    assert.notEqual(
      reachable.status,
      0,
      "the surviving records hang off commits the abort made unreachable",
    );
  }

  // The property that actually matters: no false coverage survives.
  const plan = JSON.parse(vlab(repo, "merge-plan", "feature", "--json"));
  assert.equal(plan.counts.covered, 0, "an orphaned receipt must not cover anything");
  assert.equal(plan.counts.new, 1);
  assert.equal(plan.changes[0].proof, null);
  assert.deepEqual(plan.reachableReceipts, [], "no receipt is admitted as reachable");

  // And the proof bundle a third party would verify says the same, from
  // evidence rather than from the planner's word.
  const bundle = JSON.parse(vlab(repo, "proof-bundle", "feature"));
  assert.equal(bundle.evidence.receipts.length, 0, "orphaned receipts are not evidence");
  assert.equal(bundle.changes[0].status, "new");
});

test("out-of-band Git actions during a paused operation fail closed", () => {
  // A conflicted reconciliation leaves real cherry-pick state. A user who
  // reaches past vlab and drives Git directly must not be able to make vlab
  // publish a receipt for work it never verified.
  const repo = conflictOnSharedFile(makeReconcilable());

  const conflicted = vlabResult(repo, ["reconcile", "feature", "--json"]);
  assert.notEqual(conflicted.status, 0, "the fixture must pause on a conflict");
  assert.ok(fs.existsSync(journalPath(repo)), "a paused operation keeps its journal");
  const notesBefore = notesRef(repo);

  // Abort the cherry-pick behind vlab's back, leaving the journal claiming a
  // conflict that Git no longer has.
  const outOfBand = spawnSync("git", ["cherry-pick", "--abort"], { cwd: repo, encoding: "utf8", env: testEnv() });
  assert.equal(outOfBand.status, 0, "the out-of-band abort itself succeeds");

  const resumed = vlabResult(repo, ["reconcile", "--continue", "--json"]);
  assert.ok(refusal(resumed).code, "the refusal carries a published error code");
  assert.equal(
    notesRef(repo),
    notesBefore,
    "no receipt is published while recovering from an out-of-band action",
  );

  // The operation stays recoverable through vlab's own abort.
  const aborted = JSON.parse(vlab(repo, "reconcile", "--abort", "--json"));
  assert.equal(aborted.aborted, true);
  assert.equal(fs.existsSync(journalPath(repo)), false);
  assert.equal(notesRef(repo), notesBefore, "aborting publishes nothing");
});

/**
 * A repository positioned on `feature` for a causal rebase that runs to
 * completion, so the operation reaches the publication path these tests
 * interrupt. A rebase has strictly more at stake than a reconciliation: by the
 * time publication starts, the branch ref has already moved.
 */
function makeRebasable() {
  const repo = makeReconcilable();
  git(repo, "switch", "feature");
  return repo;
}

/**
 * Make the source and target edit the same file, so the next operation pauses
 * on a real conflict with real cherry-pick state for an out-of-band actor to
 * reach past vlab and drive directly.
 */
function conflictOnSharedFile(repo) {
  git(repo, "switch", "feature");
  write(repo, "a.txt", "feature edits the shared file\n");
  git(repo, "add", "-A");
  vlab(repo, "commit", "-m", "feature touches a.txt");
  git(repo, "switch", "main");
  write(repo, "a.txt", "main edits the shared file\n");
  git(repo, "add", "-A");
  vlab(repo, "commit", "-m", "main touches a.txt");
  return repo;
}

const rebaseJournalPath = (repo) => path.join(repo, ".git", "vcs-lab", "rebase.json");

test("an interrupted rebase publication is recoverable and never duplicates a record", () => {
  for (const point of [
    "rebase:before-publish",
    "rebase:before-receipt",
    "rebase:before-clear",
  ]) {
    const repo = makeRebasable();
    const before = git(repo, "rev-parse", "feature");
    const interrupted = vlabResult(repo, ["rebase", "main", "--json"], {
      VLAB_TEST_FAULT: point,
    });
    assert.equal(
      interrupted.status,
      FAULT_EXIT_CODE,
      `${point}: the fault must stop the process, not fail normally`,
    );

    // What distinguishes this from the reconciliation case: the branch has
    // already been moved to the rewritten history before any record exists to
    // explain it. The journal is the only thing that can account for the move.
    assert.notEqual(
      git(repo, "rev-parse", "feature"),
      before,
      `${point}: the fixture must interrupt after the branch ref moved`,
    );
    assert.ok(fs.existsSync(rebaseJournalPath(repo)), `${point}: the journal must survive`);
    const status = JSON.parse(vlab(repo, "rebase", "--status", "--json"));
    assert.equal(status.active, true, `${point}: the operation is still reported as pending`);

    const published = receipts(repo);
    const ids = published.map((record) => record.id);
    assert.equal(
      new Set(ids).size,
      ids.length,
      `${point}: an interruption must never duplicate a record`,
    );
    if (point === "rebase:before-publish") {
      assert.equal(published.length, 0, "nothing is published before the publication loop");
    }
    if (point === "rebase:before-receipt") {
      assert.deepEqual(
        published.map((record) => record.type),
        ["rebase-application"],
        "application records land before the operation receipt",
      );
    }
    if (point === "rebase:before-clear") {
      assert.ok(
        published.some((record) => record.type === "rebase"),
        "the rebase receipt is published before the journal is cleared",
      );
    }

    const resumed = vlabResult(repo, ["rebase", "--continue", "--json"]);
    const afterResume = receipts(repo).map((record) => record.id);
    assert.equal(
      new Set(afterResume).size,
      afterResume.length,
      `${point}: --continue must not duplicate published records`,
    );
    if (resumed.status !== 0) {
      assert.ok(
        refusal(resumed).code,
        `${point}: a refused continue must carry a published error code`,
      );
    }
  }
});

test("aborting an interrupted rebase restores the branch and leaves no effective coverage", () => {
  // The worst case for a rebase: the process died after both records were
  // published but before the journal was cleared, so an abort has to roll a
  // moved branch ref back out from under records that already exist.
  const repo = makeRebasable();
  const before = git(repo, "rev-parse", "feature");
  const interrupted = vlabResult(repo, ["rebase", "main", "--json"], {
    VLAB_TEST_FAULT: "rebase:before-clear",
  });
  assert.equal(interrupted.status, FAULT_EXIT_CODE);
  assert.equal(receipts(repo).length, 2, "both records were published before the fault");
  assert.notEqual(git(repo, "rev-parse", "feature"), before, "the branch had already moved");

  const aborted = JSON.parse(vlab(repo, "rebase", "--abort", "--json"));
  assert.equal(aborted.aborted, true);
  assert.equal(
    git(repo, "rev-parse", "feature"),
    before,
    "abort restores the branch to its pre-rebase tip",
  );
  assert.equal(fs.existsSync(rebaseJournalPath(repo)), false, "abort clears the journal");

  // As with reconciliation, the records survive on the notes ref rather than
  // being rewritten away, and carry no weight because the commits they are
  // attached to are no longer reachable.
  const survivors = receipts(repo);
  assert.equal(survivors.length, 2, "published records are not rewritten away by an abort");
  for (const record of survivors) {
    const reachable = spawnSync(
      "git",
      ["merge-base", "--is-ancestor", record.attachedTo, "feature"],
      { cwd: repo, encoding: "utf8", env: testEnv() },
    );
    assert.notEqual(
      reachable.status,
      0,
      "the surviving records hang off commits the abort made unreachable",
    );
  }

  git(repo, "switch", "main");
  const plan = JSON.parse(vlab(repo, "merge-plan", "feature", "--json"));
  assert.equal(plan.counts.covered, 0, "an orphaned rebase record must not cover anything");
  assert.equal(plan.counts.new, 1);
  assert.deepEqual(plan.reachableReceipts, [], "no receipt is admitted as reachable");
});

test("out-of-band continue and skip during a paused reconciliation fail closed", () => {
  // The dangerous shape is not the out-of-band abort already covered above but
  // an out-of-band *advance*: Git commits the resolution itself, so the work
  // looks finished. vlab must refuse to certify a commit it never saw resolved,
  // because a receipt is a claim about how the content was reached.
  for (const action of ["continue", "skip"]) {
    const repo = conflictOnSharedFile(makeReconcilable());
    const conflicted = vlabResult(repo, ["reconcile", "feature", "--json"]);
    assert.notEqual(conflicted.status, 0, "the fixture must pause on a conflict");
    const notesBefore = notesRef(repo);

    if (action === "continue") {
      write(repo, "a.txt", "resolved out of band\n");
      git(repo, "add", "a.txt");
      const advanced = spawnSync("git", ["cherry-pick", "--continue"], {
        cwd: repo,
        encoding: "utf8",
        env: testEnv({ GIT_EDITOR: "true" }),
      });
      assert.equal(advanced.status, 0, "the out-of-band continue itself succeeds");
    } else {
      assert.equal(
        spawnSync("git", ["cherry-pick", "--skip"], { cwd: repo, encoding: "utf8", env: testEnv() }).status,
        0,
        "the out-of-band skip itself succeeds",
      );
    }

    const resumed = vlabResult(repo, ["reconcile", "--continue", "--json"]);
    assert.ok(
      refusal(resumed).code,
      `the refusal after an out-of-band ${action} carries a published error code`,
    );
    assert.equal(
      notesRef(repo),
      notesBefore,
      `no receipt is published after an out-of-band ${action}`,
    );
    assert.equal(receipts(repo).length, 0, "nothing was certified");
  }
});

test("out-of-band Git actions during a paused rebase fail closed and stay recoverable", () => {
  // A paused rebase is the worst place to reach past vlab: the branch ref is
  // mid-move, so an out-of-band action can leave Git's idea of the sequence and
  // the journal's idea of it disagreeing about which commit is being applied.
  for (const action of ["continue", "skip", "abort"]) {
    const repo = conflictOnSharedFile(makeReconcilable());
    git(repo, "switch", "feature");
    const original = git(repo, "rev-parse", "feature");
    const conflicted = vlabResult(repo, ["rebase", "main", "--json"]);
    assert.notEqual(conflicted.status, 0, "the fixture must pause on a conflict");
    assert.ok(fs.existsSync(rebaseJournalPath(repo)), "a paused rebase keeps its journal");
    const notesBefore = notesRef(repo);

    if (action === "continue") {
      write(repo, "a.txt", "resolved out of band\n");
      git(repo, "add", "a.txt");
      assert.equal(
        spawnSync("git", ["cherry-pick", "--continue"], {
          cwd: repo,
          encoding: "utf8",
          env: testEnv({ GIT_EDITOR: "true" }),
        }).status,
        0,
        "the out-of-band continue itself succeeds",
      );
    } else {
      assert.equal(
        spawnSync("git", ["cherry-pick", `--${action}`], { cwd: repo, encoding: "utf8", env: testEnv() }).status,
        0,
        `the out-of-band ${action} itself succeeds`,
      );
    }

    const resumed = vlabResult(repo, ["rebase", "--continue", "--json"]);
    const refused = refusal(resumed);
    assert.equal(
      refused.code,
      "out-of-band-change",
      `an out-of-band ${action} is classified as exactly that, not as a generic failure`,
    );
    assert.match(
      refused.message,
      /does not match the causal rebase journal/,
      "and the message still names the disagreement for a person",
    );
    assert.equal(notesRef(repo), notesBefore, "no receipt is published while recovering");

    // Refusing is only half of failing closed: the operation must still be
    // recoverable afterwards, or an out-of-band action would strand the branch
    // partway through a rewrite.
    const aborted = JSON.parse(vlab(repo, "rebase", "--abort", "--json"));
    assert.equal(aborted.aborted, true);
    assert.equal(
      git(repo, "rev-parse", "feature"),
      original,
      `vlab's own abort recovers the branch after an out-of-band ${action}`,
    );
    assert.equal(fs.existsSync(rebaseJournalPath(repo)), false);
    assert.equal(notesRef(repo), notesBefore, "aborting publishes nothing");
  }
});

test("a journal never claims more progress than Git actually made", () => {
  // The journal is written after Git has already committed the pick, so an
  // interruption in between leaves Git one commit ahead of the journal. That
  // asymmetry is deliberate and it is the safe direction: a journal that
  // under-reports causes an abort to roll back work nobody recorded, while a
  // journal that over-reported would have the operation resume past a commit
  // that does not exist. This pins the direction.
  for (const [command, point, journal, ref] of [
    ["reconcile", "reconcile:before-journal-advance", journalPath, "HEAD"],
    ["rebase", "rebase:before-journal-advance", rebaseJournalPath, "feature"],
  ]) {
    const repo = command === "rebase" ? makeRebasable() : makeReconcilable();
    const target = command === "rebase" ? "main" : "feature";
    const before = git(repo, "rev-parse", ref);

    const interrupted = vlabResult(repo, [command, target, "--json"], {
      VLAB_TEST_FAULT: point,
    });
    assert.equal(interrupted.status, FAULT_EXIT_CODE);

    // Git moved: the pick was committed before the fault.
    assert.notEqual(
      git(repo, "rev-parse", ref),
      before,
      `${command}: the fixture must interrupt after Git committed the pick`,
    );

    // The journal did not. It still describes an application in flight rather
    // than a completed one, which is the honest reading of what happened.
    const state = JSON.parse(fs.readFileSync(journal(repo), "utf8"));
    assert.equal(state.state, "applying", `${command}: the journal says it was mid-application`);
    assert.equal(state.nextIndex, 0, `${command}: no application was recorded`);
    assert.equal(state.applied.length, 0);
    assert.notEqual(state.current, null, "the in-flight change is still named");

    // The atomic write leaves no torn file and no debris behind it.
    const strays = fs
      .readdirSync(path.join(repo, ".git", "vcs-lab"))
      .filter((entry) => entry.includes(".tmp-"));
    assert.deepEqual(strays, [], `${command}: the journal write leaves no temporary file`);

    // Continuing is refused rather than guessed at, and nothing is certified.
    const resumed = vlabResult(repo, [command, "--continue", "--json"]);
    assert.ok(
      refusal(resumed).code,
      `${command}: a torn journal must be refused with a published error code`,
    );
    assert.equal(receipts(repo).length, 0, `${command}: nothing was published`);

    // And the state is not a trap: abort still recovers it completely.
    assert.equal(JSON.parse(vlab(repo, command, "--abort", "--json")).aborted, true);
    assert.equal(git(repo, "rev-parse", ref), before, `${command}: abort restores the tip`);
    assert.equal(fs.existsSync(journal(repo)), false);
    assert.equal(git(repo, "status", "--porcelain"), "", "the worktree is left clean");
  }
});

test("an interrupted abort can be completed by running it again", () => {
  // The cleanup edge. Abort restores the history first and clears the journal
  // second, so an interruption between them leaves a repository that is
  // already rolled back while still advertising a pending operation. If abort
  // were not idempotent across that point the operation could neither be
  // continued nor abandoned.
  for (const [command, journal, ref] of [
    ["reconcile", journalPath, "HEAD"],
    ["rebase", rebaseJournalPath, "feature"],
  ]) {
    const repo = command === "rebase" ? makeRebasable() : makeReconcilable();
    const target = command === "rebase" ? "main" : "feature";
    const before = git(repo, "rev-parse", ref);

    // Get into the worst state first: everything published, journal uncleared.
    vlabResult(repo, [command, target, "--json"], {
      VLAB_TEST_FAULT: `${command}:before-clear`,
    });
    assert.equal(receipts(repo).length, 2, "both records were published");

    const interruptedAbort = vlabResult(repo, [command, "--abort", "--json"], {
      VLAB_TEST_FAULT: `${command}:abort-before-clear`,
    });
    assert.equal(interruptedAbort.status, FAULT_EXIT_CODE);
    assert.equal(
      git(repo, "rev-parse", ref),
      before,
      `${command}: the history was restored before the fault`,
    );
    assert.ok(
      fs.existsSync(journal(repo)),
      `${command}: the journal is what the interrupted abort had left to clear`,
    );
    assert.equal(
      JSON.parse(vlab(repo, command, "--status", "--json")).active,
      true,
      "the operation still advertises itself as pending",
    );

    // Running abort again finishes the job rather than failing on a repository
    // that no longer needs the part that already succeeded.
    const retried = JSON.parse(vlab(repo, command, "--abort", "--json"));
    assert.equal(retried.aborted, true, `${command}: abort is idempotent`);
    assert.equal(git(repo, "rev-parse", ref), before);
    assert.equal(fs.existsSync(journal(repo)), false, "the retry clears the journal");
    assert.equal(git(repo, "status", "--porcelain"), "", "the worktree is left clean");
    assert.equal(
      JSON.parse(vlab(repo, command, "--status", "--json")).active,
      false,
      "no operation is pending afterwards",
    );
  }
});

/**
 * A reconciled repository, so a receipt exists on the notes ref and the plan
 * has to read note blobs through the object session to classify the change.
 * That read is the one carrying object *contents*, which is what the large
 * response buffer exists for.
 */
function makeReconciled() {
  const repo = makeReconcilable();
  vlab(repo, "reconcile", "feature", "--json");
  return repo;
}

test("a session response too large for its buffer falls back without changing the answer", () => {
  // Overflowing the real 64 MiB content buffer needs a blob of roughly 48 MiB,
  // which is far too large to build on every suite run. The behaviour worth
  // pinning is not the threshold but what happens at it, so
  // VLAB_TEST_SESSION_BUFFER_BYTES shrinks the buffer to meet a small fixture.
  const repo = makeReconciled();

  const plan = (env) => {
    const result = vlabResult(repo, ["merge-plan", "feature", "--json"], {
      VLAB_GIT_SESSION: "1",
      VLAB_TRACE: "1",
      ...env,
    });
    assert.equal(result.status, 0, "an overflowing response is a transport event, not an error");
    return { json: result.stdout, trace: result.stderr };
  };

  const fallbacks = (trace) =>
    trace.split("\n").filter((line) => line.includes("session unavailable")).length;

  const served = plan({});
  const overflowed = plan({ VLAB_TEST_SESSION_BUFFER_BYTES: "2048" });

  // The fixture must actually exercise both sides, or the comparison below
  // proves nothing.
  assert.equal(fallbacks(served.trace), 0, "the default buffer serves the response");
  assert.match(
    served.trace,
    /cat-file-session/,
    "the fixture must really use the session when the buffer is large enough",
  );
  assert.equal(
    fallbacks(overflowed.trace),
    1,
    "the shrunken buffer overflows, and does so exactly once: the first failure " +
      "disables the session for the rest of the invocation",
  );
  assert.match(
    overflowed.trace,
    /Git object-session response exceeded its shared buffer/,
    "the fallback names its cause rather than failing silently",
  );

  // The property that actually matters. A fallback that returned different
  // data would be far worse than one that failed, because the plan would be
  // wrong rather than absent.
  assert.equal(
    overflowed.json,
    served.json,
    "the fallback answer is byte-identical to the session answer",
  );

  // And identical to the answer with no session at all, so neither transport
  // is quietly authoritative.
  const withoutSession = vlabResult(repo, ["merge-plan", "feature", "--json"], {
    VLAB_GIT_SESSION: "0",
  });
  assert.equal(withoutSession.status, 0);
  assert.equal(
    withoutSession.stdout,
    served.json,
    "session and process transports agree on the plan",
  );

  // The plan is a real one, not an empty answer that would match trivially.
  const parsed = JSON.parse(served.json);
  assert.equal(parsed.counts.covered, 1);
  assert.equal(parsed.changes[0].proof, "receipt-commit");
});

test("the session buffer override is inert unless it names a positive integer", () => {
  // The override shrinks a safety bound, so it must be impossible to trip
  // accidentally: an empty, malformed, zero, or negative value has to leave the
  // real buffer in place rather than fall back to something small.
  const repo = makeReconciled();
  for (const value of ["", "0", "-1", "not-a-number", "1e6", "2048.5"]) {
    const result = vlabResult(repo, ["merge-plan", "feature", "--json"], {
      VLAB_GIT_SESSION: "1",
      VLAB_TRACE: "1",
      VLAB_TEST_SESSION_BUFFER_BYTES: value,
    });
    assert.equal(result.status, 0, `${JSON.stringify(value)}: the command still succeeds`);
    assert.doesNotMatch(
      result.stderr,
      /session unavailable/,
      `${JSON.stringify(value)} must not shrink the buffer`,
    );
  }
});

test("reconciliation continue and abort refuse a worktree that has moved to another branch", () => {
  // Abort restores `targetBefore` with a hard reset of whatever HEAD points
  // at. Before the journal recorded its branch, a `git checkout -f other`
  // between the pause and the abort reset `other` to main's old tip and left
  // its commits reachable only from the reflog — the one shape the abort
  // invariant exists to rule out.
  const repo = conflictOnSharedFile(makeReconcilable());
  git(repo, "switch", "-c", "other", "main");
  write(repo, "o.txt", "other work\n");
  git(repo, "add", "-A");
  vlab(repo, "commit", "-m", "other work");
  const otherTip = git(repo, "rev-parse", "other");
  git(repo, "switch", "main");
  const mainTip = git(repo, "rev-parse", "main");

  const paused = vlabResult(repo, ["reconcile", "feature", "--json"]);
  assert.notEqual(paused.status, 0, "the fixture must pause on a conflict");
  // The fixture applies one clean change before the conflict, so the paused
  // tip is ahead of `targetBefore`; a refusal must leave it exactly there.
  const pausedTip = git(repo, "rev-parse", "main");
  assert.notEqual(pausedTip, mainTip);
  const status = JSON.parse(vlab(repo, "reconcile", "--status", "--json"));
  assert.equal(status.targetBranchRef, "refs/heads/main", "the journal records its branch");
  assert.equal(status.recovery.branchMatches, true);

  git(repo, "checkout", "-f", "other");
  const movedStatus = JSON.parse(vlab(repo, "reconcile", "--status", "--json"));
  assert.equal(movedStatus.recovery.actualBranchRef, "refs/heads/other");
  assert.equal(movedStatus.recovery.branchMatches, false, "status names the disagreement");

  for (const verb of ["--abort", "--continue"]) {
    const refused = refusal(vlabResult(repo, ["reconcile", verb, "--json"]));
    assert.equal(refused.code, "out-of-band-change", `${verb} from the wrong branch is refused`);
    assert.match(refused.message, /belongs to branch 'main', not 'other'/);
    assert.equal(git(repo, "rev-parse", "other"), otherTip, `${verb} left 'other' where it was`);
    assert.equal(git(repo, "rev-parse", "main"), pausedTip, `${verb} left 'main' where it was`);
    assert.ok(fs.existsSync(journalPath(repo)), `${verb} kept the journal for recovery`);
  }

  // Back on the operation's branch the abort completes, and only that branch moves.
  git(repo, "switch", "main");
  const aborted = JSON.parse(vlab(repo, "reconcile", "--abort", "--json"));
  assert.equal(aborted.aborted, true);
  assert.equal(aborted.restoredHead, mainTip);
  assert.equal(git(repo, "rev-parse", "other"), otherTip);
  assert.ok(!fs.existsSync(journalPath(repo)), "the journal is cleared after a real abort");
});

test("a journal without a branch record is trusted only while Git still holds its pick", () => {
  // Journals written before `targetBranchRef` existed cannot say which branch
  // they belong to. While Git's sequencer still holds the exact pick the
  // journal is paused on, the worktree is provably in the operation's state and
  // the abort is safe; once a forced checkout has discarded that pick, nothing
  // proves it, and the abort must refuse rather than guess.
  const repo = conflictOnSharedFile(makeReconcilable());
  git(repo, "switch", "-c", "other", "main");
  write(repo, "o.txt", "other work\n");
  git(repo, "add", "-A");
  vlab(repo, "commit", "-m", "other work");
  const otherTip = git(repo, "rev-parse", "other");
  git(repo, "switch", "main");
  const mainTip = git(repo, "rev-parse", "main");

  const pauseWithLegacyJournal = () => {
    assert.notEqual(vlabResult(repo, ["reconcile", "feature", "--json"]).status, 0);
    const journal = JSON.parse(fs.readFileSync(journalPath(repo), "utf8"));
    assert.ok(Object.hasOwn(journal, "targetBranchRef"), "a current journal records its branch");
    delete journal.targetBranchRef;
    fs.writeFileSync(journalPath(repo), JSON.stringify(journal, null, 2));
  };

  // With the pick still pending on the operation's branch, the legacy journal
  // is abortable: an upgrade must not strand an in-flight operation.
  pauseWithLegacyJournal();
  const status = JSON.parse(vlab(repo, "reconcile", "--status", "--json"));
  assert.equal(status.targetBranchRef, null);
  assert.equal(status.recovery.branchMatches, null, "status does not pretend to know");
  const aborted = JSON.parse(vlab(repo, "reconcile", "--abort", "--json"));
  assert.equal(aborted.aborted, true);
  assert.equal(git(repo, "rev-parse", "main"), mainTip);

  // Once a forced checkout has discarded the pick, nothing proves which branch
  // the journal belongs to, and the abort refuses instead of resetting `other`.
  pauseWithLegacyJournal();
  git(repo, "checkout", "-f", "other");
  const refused = refusal(vlabResult(repo, ["reconcile", "--abort", "--json"]));
  assert.equal(refused.code, "out-of-band-change");
  assert.match(refused.message, /does not record its branch/);
  assert.match(refused.details, new RegExp(mainTip), "the details name the tip to restore by hand");
  assert.equal(git(repo, "rev-parse", "other"), otherTip, "the unrelated branch is untouched");
  assert.ok(fs.existsSync(journalPath(repo)), "the journal is kept for hand recovery");
});

/**
 * A publisher: one process appending one record to `commit` through the real
 * `appendNote`, the path every receipt takes. No command appends to a commit
 * its caller names, so the publisher is a script rather than the CLI; the
 * race under test is between processes, so it is a process.
 */
function publisher(repo, commit, recordId, env = {}) {
  const notes = pathToFileURL(path.join(projectRoot, "src", "notes.js")).href;
  const script = [
    `import { appendNote } from ${JSON.stringify(notes)};`,
    `appendNote(${JSON.stringify(commit)}, {`,
    `  schema: "vcs-lab.provenance/v1", type: "provenance", id: ${JSON.stringify(recordId)},`,
    `  commit: ${JSON.stringify(commit)}, changeId: null, origin: "declared", carriedFrom: [],`,
    '  actors: [{ role: "generated", actor: "concurrent test" }],',
    "  createdAt: new Date().toISOString(),",
    "});",
  ].join("\n");
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    cwd: repo,
    env: testEnv(env),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const done = new Promise((resolve) => {
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
  return { child, done };
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the condition");
    await pause(20);
  }
}

const noteRecordIds = (repo, commit) =>
  JSON.parse(git(repo, "notes", "--ref=vcs-lab", "show", commit)).records
    .map((record) => record.id);

test("two publishers appending to one commit at once lose no record", async () => {
  const repo = makeReconcilable();
  const commit = git(repo, "rev-parse", "HEAD");
  const gate = path.join(path.dirname(repo), "gate");
  const first = publisher(repo, commit, "first", {
    VLAB_TEST_GATE: "notes:after-read",
    VLAB_TEST_GATE_FILE: gate,
  });
  await until(() => fs.existsSync(`${gate}.reached`));

  // The first publisher has read the container and is about to write it
  // back. Without the lock the second would run to completion here, and the
  // first's write would then replace the container the second appended to.
  const second = publisher(repo, commit, "second");
  const early = await Promise.race([second.done, pause(1_500).then(() => null)]);
  assert.equal(
    early,
    null,
    `the second publisher completed inside the first's critical section: ${JSON.stringify(early)}`,
  );

  fs.writeFileSync(gate, "");
  const [firstResult, secondResult] = await Promise.all([first.done, second.done]);
  assert.equal(firstResult.status, 0, firstResult.stderr);
  assert.equal(secondResult.status, 0, secondResult.stderr);
  assert.deepEqual(noteRecordIds(repo, commit).sort(), ["first", "second"]);
  assert.equal(fs.existsSync(path.join(repo, ".git", "vcs-lab", "notes.lock")), false);
});

test("a lock whose holder is gone is abandoned, and a live holder's is respected", async () => {
  const repo = makeReconcilable();
  const commit = git(repo, "rev-parse", "HEAD");
  const lockPath = path.join(repo, ".git", "vcs-lab", "notes.lock");
  const claim = (pid, hostname) =>
    `${JSON.stringify({ pid, hostname, createdAt: new Date().toISOString() })}\n`;

  // Linux caps pids at 2^22 and Windows allots multiples of four, so this pid
  // belongs to no process on any supported host: a publisher that crashed.
  fs.writeFileSync(lockPath, claim(4_194_305, os.hostname()));
  const afterCrash = await publisher(repo, commit, "after-crash").done;
  assert.equal(afterCrash.status, 0, afterCrash.stderr);
  assert.equal(fs.existsSync(lockPath), false);

  // A holder on another host cannot be checked, so its lock stands until it
  // is old enough to be judged abandoned.
  fs.writeFileSync(lockPath, claim(1, "elsewhere.invalid"));
  const old = new Date(Date.now() - 120_000);
  fs.utimesSync(lockPath, old, old);
  const afterRemote = await publisher(repo, commit, "after-remote").done;
  assert.equal(afterRemote.status, 0, afterRemote.stderr);
  assert.equal(fs.existsSync(lockPath), false);

  // This test process holds the lock and is running, so a publisher waits its
  // budget and refuses rather than taking the lock from it. Through the CLI,
  // the refusal is the envelope's own code.
  fs.writeFileSync(lockPath, claim(process.pid, os.hostname()));
  write(repo, "held.txt", "held\n");
  git(repo, "add", "-A");
  const status = git(repo, "status", "--porcelain");
  const staged = fs.readFileSync(path.join(repo, ".git", "index"));
  const notesBefore = git(repo, "rev-parse", "refs/notes/vcs-lab");
  const refused = refusal(vlabResult(
    repo,
    ["commit", "-m", "held", "--generated-by", "agent:test", "--json"],
  ));
  assert.equal(refused.code, "notes-locked");
  assert.match(refused.message, new RegExp(`locked by process ${process.pid} on `));
  assert.equal(git(repo, "rev-parse", "HEAD"), commit, "lock refusal must precede commit creation");
  assert.deepEqual(fs.readFileSync(path.join(repo, ".git", "index")), staged);
  assert.equal(git(repo, "status", "--porcelain"), status);
  assert.equal(fs.readFileSync(path.join(repo, "held.txt"), "utf8"), "held\n");
  assert.equal(git(repo, "rev-parse", "refs/notes/vcs-lab"), notesBefore);
  assert.equal(fs.existsSync(lockPath), true);
  fs.rmSync(lockPath);

  assert.deepEqual(noteRecordIds(repo, commit), ["after-crash", "after-remote"]);
  const retried = JSON.parse(vlab(repo, "commit", "-m", "held", "--generated-by", "agent:test", "--json"));
  assert.equal(git(repo, "rev-parse", "HEAD^"), commit);
  assert.deepEqual(retried.provenance.actors, [{ role: "generated", actor: "agent:test" }]);
  assert.deepEqual(noteRecordIds(repo, retried.commit), [retried.provenance.id]);
  assert.equal(fs.existsSync(lockPath), false);
});

function workspaceWriter(repo, args, env = {}) {
  const child = spawn(process.execPath, [cli, "workspace", ...args, "--json"], {
    cwd: repo,
    env: testEnv(env),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const done = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
  return { child, done };
}

function workspaceRuntime(repo, name) {
  return path.join(repo, ".git", "vcs-lab", name);
}

async function competingWorkspaceWriters(repo, firstArgs, secondArgs, secondCwd = repo) {
  const firstGate = path.join(path.dirname(repo), "workspace-first-gate");
  const secondGate = path.join(path.dirname(repo), "workspace-second-gate");
  const first = workspaceWriter(repo, firstArgs, {
    VLAB_TEST_GATE: "workspaces:after-read", VLAB_TEST_GATE_FILE: firstGate,
  });
  let second;
  try {
    await until(() => fs.existsSync(`${firstGate}.reached`));
    second = workspaceWriter(secondCwd, secondArgs, {
      VLAB_TEST_GATE: "workspaces:lock-contended", VLAB_TEST_GATE_FILE: secondGate,
    });
    // This signal proves the second process actually attempted acquisition
    // while the first held its old registry snapshot. No scheduling sleep is
    // used to guess whether the commands overlapped.
    await until(() => fs.existsSync(`${secondGate}.reached`));
    assert.equal(second.child.exitCode, null);
    fs.writeFileSync(secondGate, "");
    fs.writeFileSync(firstGate, "");
    const results = await Promise.all([first.done, second.done]);
    for (const result of results) assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(fs.existsSync(workspaceRuntime(repo, "workspaces.lock")), false);
    return results.map((result) => JSON.parse(result.stdout));
  } finally {
    fs.writeFileSync(firstGate, "");
    fs.writeFileSync(secondGate, "");
    await Promise.all([first.done, second?.done]);
  }
}

test("concurrent workspace creates preserve both registrations across linked worktrees", async () => {
  const repo = makeReconcilable();
  const parent = path.dirname(repo);
  const caller = path.join(parent, "caller");
  git(repo, "worktree", "add", "--detach", caller, "HEAD");
  const a = path.join(parent, "workspace-a");
  const b = path.join(parent, "workspace-b");
  const results = await competingWorkspaceWriters(repo,
    ["create", "a", "--path", a, "--owner", "first-owner"],
    ["create", "b", "--path", b, "--owner", "second-owner"], caller);
  const registry = JSON.parse(fs.readFileSync(workspaceRuntime(repo, "workspaces.json"), "utf8"));
  assert.deepEqual(registry.workspaces.map((item) => [item.id, item.name, item.owner]),
    results.map((item) => [item.id, item.name, item.owner]));
  const listing = JSON.parse(vlab(repo, "workspace", "list", "--json"));
  assert.deepEqual(listing.map((item) => item.pathStatus), ["active", "active"]);
  assert.equal(git(a, "branch", "--show-current"), results[0].compatibilityBranch);
  assert.equal(git(b, "branch", "--show-current"), results[1].compatibilityBranch);
});

test("concurrent lifecycle changes preserve updates to different workspace entries", async () => {
  const repo = makeReconcilable();
  const parent = path.dirname(repo);
  const a = path.join(parent, "a");
  const b = path.join(parent, "b");
  const moved = path.join(parent, "a-moved");
  const first = JSON.parse(vlab(repo, "workspace", "create", "a", "--path", a, "--json"));
  const second = JSON.parse(vlab(repo, "workspace", "create", "b", "--path", b, "--json"));
  await competingWorkspaceWriters(repo, ["move", "a", moved], ["archive", "b"]);
  const registry = JSON.parse(vlab(repo, "workspace", "list", "--json"));
  assert.equal(registry[0].id, first.id);
  assert.equal(registry[0].path, moved);
  assert.equal(registry[0].status, "active");
  assert.deepEqual(registry[0].previousPaths, [a]);
  assert.equal(registry[1].id, second.id);
  assert.equal(registry[1].status, "archived");
  assert.equal(fs.existsSync(a), false);
  assert.equal(fs.existsSync(b), false);
  assert.equal(git(moved, "branch", "--show-current"), first.compatibilityBranch);
});

test("every workspace registry writer refuses a held lock without mutating registry or worktrees", async () => {
  const repo = makeReconcilable();
  const parent = path.dirname(repo);
  const paths = Object.fromEntries(["a", "b", "c", "d"].map((name) => [name, path.join(parent, name)]));
  for (const [name, destination] of Object.entries(paths)) {
    vlab(repo, "workspace", "create", name, "--path", destination, "--json");
  }
  vlab(repo, "workspace", "archive", "b", "--json");
  const repaired = path.join(parent, "c-moved");
  fs.renameSync(paths.c, repaired);
  fs.rmSync(paths.d, { recursive: true });
  const registryFile = workspaceRuntime(repo, "workspaces.json");
  const lock = workspaceRuntime(repo, "workspaces.lock");
  const registry = fs.readFileSync(registryFile);
  const worktrees = git(repo, "worktree", "list", "--porcelain");
  const refs = git(repo, "for-each-ref", "--format=%(refname) %(objectname)");
  const claim = JSON.stringify({ pid: process.pid, hostname: os.hostname(), token: "live-test-holder" });
  fs.writeFileSync(lock, claim);
  const commands = [
    ["create", "new", "--path", path.join(parent, "new")],
    ["move", "a", path.join(parent, "a-moved")],
    ["archive", "a"],
    ["restore", "b"],
    ["repair", "c", "--path", repaired],
    ["prune", "--apply"],
  ];
  const writers = commands.map((args) => workspaceWriter(repo, args));
  // Read-only registry operations remain available while a writer holds it.
  assert.equal(JSON.parse(vlab(repo, "workspace", "list", "--json")).length, 4);
  assert.equal(JSON.parse(vlab(repo, "workspace", "prune", "--dry-run", "--json")).dryRun, true);
  for (const result of await Promise.all(writers.map((writer) => writer.done))) {
    const error = refusal(result);
    assert.equal(error.code, "workspace-registry-locked");
    assert.match(error.details, /stop all workspace writers on every host/);
  }
  assert.deepEqual(fs.readFileSync(registryFile), registry);
  assert.equal(fs.readFileSync(lock, "utf8"), claim);
  assert.equal(git(repo, "worktree", "list", "--porcelain"), worktrees);
  assert.equal(git(repo, "for-each-ref", "--format=%(refname) %(objectname)"), refs);
});

test("interrupted workspace holders require explicit recovery without stale-lock stealing", () => {
  const repo = makeReconcilable();
  const lock = workspaceRuntime(repo, "workspaces.lock");
  const destination = path.join(path.dirname(repo), "after-crash");
  const args = ["workspace", "create", "after-crash", "--path", destination, "--json"];
  const stopped = vlabResult(repo, args, { VLAB_TEST_FAULT: "workspaces:after-read" });
  assert.equal(stopped.status, FAULT_EXIT_CODE);
  assert.equal(fs.existsSync(destination), false);
  const abandoned = fs.readFileSync(lock);
  assert.equal(refusal(vlabResult(repo, args)).code, "workspace-registry-locked");
  assert.deepEqual(fs.readFileSync(lock), abandoned);
  assert.equal(fs.existsSync(workspaceRuntime(repo, "workspaces.json")), false);
  // The holder has exited and all contenders have finished. Preserve its
  // claim for inspection while clearing the lock with no writers running.
  fs.renameSync(lock, `${lock}.recovered`);
  assert.equal(vlabResult(repo, args).status, 0);
  assert.equal(fs.existsSync(lock), false);
});

test("old foreign and malformed workspace lock claims are preserved", () => {
  const repo = makeReconcilable();
  const lock = workspaceRuntime(repo, "workspaces.lock");
  for (const claim of [JSON.stringify({ pid: 1, hostname: "elsewhere.invalid", token: "foreign" }), "partial {"]) {
    fs.writeFileSync(lock, claim);
    const old = new Date(Date.now() - 86_400_000);
    fs.utimesSync(lock, old, old);
    const result = vlabResult(repo, ["workspace", "create", "held", "--json"]);
    assert.equal(refusal(result).code, "workspace-registry-locked");
    assert.equal(fs.readFileSync(lock, "utf8"), claim);
    fs.rmSync(lock);
  }
});

test("workspace lock release preserves a replacement claim", async () => {
  const { withWorkspaceRegistryLock } = await import("../src/workspace-lock.js");
  const repo = makeReconcilable();
  const lock = workspaceRuntime(repo, "workspaces.lock");
  const replacement = JSON.stringify({ pid: process.pid, hostname: os.hostname(), token: "replacement" });
  withWorkspaceRegistryLock(repo, () => { fs.writeFileSync(lock, replacement); });
  assert.equal(fs.readFileSync(lock, "utf8"), replacement);
});

test("failed workspace materialization leaves the registry unchanged and releases its lock", () => {
  const repo = makeReconcilable();
  const parent = path.dirname(repo);
  vlab(repo, "workspace", "create", "existing", "--path", path.join(parent, "existing"), "--json");
  const registryFile = workspaceRuntime(repo, "workspaces.json");
  const before = fs.readFileSync(registryFile);
  const destination = path.join(parent, "partial");
  // Git has created the worktree and branch when its checkout hook fails.
  const hooks = path.join(parent, "hooks");
  fs.mkdirSync(hooks);
  const hook = path.join(hooks, "post-checkout");
  fs.writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  git(repo, "config", "core.hooksPath", hooks);
  const result = vlabResult(repo, ["workspace", "create", "partial", "--path", destination, "--json"]);
  const error = refusal(result);
  assert.match(error.details, /registry was not updated/);
  assert.deepEqual(fs.readFileSync(registryFile), before);
  assert.equal(fs.existsSync(workspaceRuntime(repo, "workspaces.lock")), false);
  assert.ok(fs.existsSync(destination), "partial materialization is retained for inspection");
  assert.equal(git(repo, "rev-parse", "vlab/ws/partial"), git(repo, "rev-parse", "HEAD"));
  git(repo, "config", "--unset", "core.hooksPath");
  assert.equal(vlabResult(repo, ["workspace", "create", "next", "--path", path.join(parent, "next"), "--json"]).status, 0);

  vlab(repo, "workspace", "archive", "existing", "--json");
  const archived = fs.readFileSync(registryFile);
  git(repo, "config", "core.hooksPath", hooks);
  const restore = refusal(vlabResult(repo, ["workspace", "restore", "existing", "--json"]));
  assert.match(restore.details, /registry was not updated/);
  assert.deepEqual(fs.readFileSync(registryFile), archived);
  assert.equal(fs.existsSync(workspaceRuntime(repo, "workspaces.lock")), false);
  assert.ok(fs.existsSync(path.join(parent, "existing")));
});

function pausedWorkspace(operation, pause = "publication") {
  const repo = makeReconcilable();
  const workspace = path.join(path.dirname(repo), "worker");
  const source = operation === "reconcile" ? "feature" : "main";
  vlab(repo, "workspace", "create", "worker", "--from",
    operation === "reconcile" ? "main" : "feature", "--path", workspace, "--json");
  const originalHead = git(workspace, "rev-parse", "HEAD");
  if (pause === "publication") {
    assert.equal(vlabResult(workspace, [operation, source, "--json"], {
      VLAB_TEST_FAULT: `${operation}:before-publish`,
    }).status, FAULT_EXIT_CODE);
  } else {
    const forecast = JSON.parse(vlab(workspace,
      operation === "reconcile" ? "forecast" : "rebase-forecast", source, "--json"));
    const savedPath = path.resolve(workspace, git(workspace, "rev-parse", "--git-path",
      `vcs-lab/forecasts/${forecast.id}.json`));
    const saved = JSON.parse(fs.readFileSync(savedPath, "utf8"));
    saved.predictedResultTree = git(workspace, "rev-parse", `${originalHead}^{tree}`);
    fs.writeFileSync(savedPath, `${JSON.stringify(saved, null, 2)}\n`);
    assert.equal(refusal(vlabResult(workspace,
      [operation, source, "--use-forecast", forecast.id, "--json"])).code, "stale-forecast");
    assert.equal(JSON.parse(vlab(workspace, operation, "--status", "--json")).state, "forecast-mismatch");
  }
  assert.equal(git(workspace, "status", "--porcelain"), "");
  assert.equal(JSON.parse(vlab(workspace, operation, "--status", "--json")).active, true);
  const gitDir = git(workspace, "rev-parse", "--absolute-git-dir");
  const journal = path.join(gitDir, "vcs-lab", operation === "reconcile" ? "reconciliation.json" : "rebase.json");
  return { repo, workspace, gitDir, journal, originalHead };
}

for (const operation of ["reconcile", "rebase"]) {
  for (const pause of ["publication", "forecast-mismatch"]) {
    test(`archive preserves a clean ${operation} ${pause} journal and recovery`, () => {
      const { repo, workspace, journal, originalHead } = pausedWorkspace(operation, pause);
      const bytes = fs.readFileSync(journal);
      const registry = fs.readFileSync(workspaceRuntime(repo, "workspaces.json"));
      const head = git(workspace, "rev-parse", "HEAD");
      const refs = git(repo, "for-each-ref", "--format=%(refname) %(objectname)");
      const error = refusal(vlabResult(repo, ["workspace", "archive", "worker", "--json"]));
      assert.equal(error.code, "operation-in-progress");
      assert.match(error.message, new RegExp(operation));
      assert.deepEqual(fs.readFileSync(journal), bytes);
      assert.deepEqual(fs.readFileSync(workspaceRuntime(repo, "workspaces.json")), registry);
      assert.equal(git(repo, "for-each-ref", "--format=%(refname) %(objectname)"), refs);
      assert.equal(git(workspace, "rev-parse", "HEAD"), head);
      assert.equal(git(workspace, "status", "--porcelain"), "");
      assert.equal(JSON.parse(vlab(workspace, operation, "--status", "--json")).active, true);
      const aborted = JSON.parse(vlab(workspace, operation, "--abort", "--json"));
      assert.equal(aborted.restoredHead, originalHead);
      assert.equal(fs.existsSync(journal), false);
      assert.equal(vlabResult(repo, ["workspace", "archive", "worker", "--json"]).status, 0);
      assert.equal(vlabResult(repo, ["workspace", "restore", "worker", "--json"]).status, 0);
      assert.equal(JSON.parse(vlab(workspace, operation, "--status", "--json")).active, false);
    });
  }

  test(`move and repair preserve a clean pending ${operation} and its recovery`, () => {
    const { repo, workspace, journal, originalHead } = pausedWorkspace(operation);
    const bytes = fs.readFileSync(journal);
    const moved = `${workspace}-moved`;
    vlab(repo, "workspace", "move", "worker", moved, "--json");
    assert.deepEqual(fs.readFileSync(journal), bytes);
    assert.equal(JSON.parse(vlab(moved, operation, "--status", "--json")).active, true);
    const repaired = `${workspace}-repaired`;
    fs.renameSync(moved, repaired);
    vlab(repo, "workspace", "repair", "worker", "--path", repaired, "--json");
    assert.deepEqual(fs.readFileSync(journal), bytes);
    assert.equal(JSON.parse(vlab(repaired, operation, "--status", "--json")).active, true);
    assert.equal(JSON.parse(vlab(repaired, operation, "--abort", "--json")).restoredHead, originalHead);
  });

  test(`prune preserves a missing workspace's pending ${operation} until repair and recovery`, () => {
    const { repo, workspace, gitDir, journal, originalHead } = pausedWorkspace(operation);
    const bytes = fs.readFileSync(journal);
    const registry = fs.readFileSync(workspaceRuntime(repo, "workspaces.json"));
    const relocated = `${workspace}-relocated`;
    fs.renameSync(workspace, relocated);
    // Make the missing administrative entry eligible even with an expiry policy.
    const old = new Date(0);
    fs.utimesSync(path.join(gitDir, "gitdir"), old, old);
    const preview = JSON.parse(vlab(repo, "workspace", "prune", "--json"));
    assert.equal(preview.count, 1);
    assert.equal(preview.changed, false);
    assert.equal(refusal(vlabResult(repo, ["workspace", "prune", "--apply", "--json"])).code,
      "operation-in-progress");
    assert.deepEqual(fs.readFileSync(journal), bytes);
    assert.deepEqual(fs.readFileSync(workspaceRuntime(repo, "workspaces.json")), registry);
    vlab(repo, "workspace", "repair", "worker", "--path", relocated, "--json");
    assert.equal(JSON.parse(vlab(relocated, operation, "--abort", "--json")).restoredHead, originalHead);
    fs.rmSync(relocated, { recursive: true, force: true });
    assert.equal(JSON.parse(vlab(repo, "workspace", "prune", "--apply", "--json")).changed, true);
  });
}

test("archive refuses malformed and unknown journals by presence in the target worktree", () => {
  const repo = makeReconcilable();
  const workspace = path.join(path.dirname(repo), "worker");
  vlab(repo, "workspace", "create", "worker", "--path", workspace, "--json");
  const runtime = path.resolve(workspace, git(workspace, "rev-parse", "--git-path", "vcs-lab"));
  fs.mkdirSync(runtime, { recursive: true });
  for (const filename of ["reconciliation.json", "rebase.json"]) {
    const journal = path.join(runtime, filename);
    for (const bytes of ["null\n", "partial {", '{"schema":"vcs-lab.operation/v999"}\n']) {
      fs.writeFileSync(journal, bytes);
      assert.equal(refusal(vlabResult(repo, ["workspace", "archive", "worker", "--json"])).code,
        "operation-in-progress");
      assert.equal(fs.readFileSync(journal, "utf8"), bytes);
    }
    fs.rmSync(journal);
  }
  // A journal in the caller's private state must not prevent removing a different worktree.
  fs.writeFileSync(journalPath(repo), "partial {");
  assert.equal(vlabResult(repo, ["workspace", "archive", "worker", "--json"]).status, 0);
});

test("prune checks unregistered linked journals before any repository-wide deletion", () => {
  for (const missing of [false, true]) {
    const repo = makeReconcilable();
    const parent = path.dirname(repo);
    const registered = path.join(parent, "registered");
    vlab(repo, "workspace", "create", "registered", "--path", registered, "--json");
    const outside = path.join(parent, "outside");
    git(repo, "worktree", "add", "-b", "outside", outside);
    const gitDir = git(outside, "rev-parse", "--absolute-git-dir");
    const journal = path.join(gitDir, "vcs-lab", "rebase.json");
    fs.mkdirSync(path.dirname(journal), { recursive: true });
    fs.writeFileSync(journal, "partial {");
    fs.rmSync(registered, { recursive: true, force: true });
    if (missing) fs.renameSync(outside, `${outside}-relocated`);
    const before = fs.readFileSync(workspaceRuntime(repo, "workspaces.json"));
    const administration = fs.readdirSync(path.dirname(gitDir)).sort();
    const error = refusal(vlabResult(repo, ["workspace", "prune", "--apply", "--json"]));
    assert.equal(error.code, "operation-in-progress");
    assert.ok(error.message.includes(journal));
    assert.equal(fs.readFileSync(journal, "utf8"), "partial {");
    assert.deepEqual(fs.readFileSync(workspaceRuntime(repo, "workspaces.json")), before);
    assert.deepEqual(fs.readdirSync(path.dirname(gitDir)).sort(), administration);
  }
});

test("implicit provenance in a linked worktree refuses before commit --all stages content", () => {
  const repo = makeReconcilable();
  const linked = path.join(path.dirname(repo), "linked");
  git(repo, "worktree", "add", "-b", "linked", linked);
  write(linked, "a.txt", "unstaged change\n");
  const before = git(linked, "rev-parse", "HEAD");
  const status = git(linked, "status", "--porcelain");
  const indexPath = path.resolve(linked, git(linked, "rev-parse", "--git-path", "index"));
  const index = fs.readFileSync(indexPath);
  const lock = workspaceRuntime(repo, "notes.lock");
  const claim = JSON.stringify({ pid: process.pid, hostname: os.hostname() });
  fs.writeFileSync(lock, claim);
  const error = refusal(vlabResult(linked, ["commit", "--all", "-m", "implicit", "--json"],
    { VLAB_AGENT: "agent:implicit" }));
  assert.equal(error.code, "notes-locked");
  assert.equal(git(linked, "rev-parse", "HEAD"), before);
  assert.deepEqual(fs.readFileSync(indexPath), index);
  assert.equal(git(linked, "status", "--porcelain"), status);
  assert.equal(fs.readFileSync(path.join(linked, "a.txt"), "utf8"), "unstaged change\n");
  assert.equal(fs.readFileSync(lock, "utf8"), claim);
  assert.deepEqual(JSON.parse(vlab(linked, "provenance", "--json")).entries, []);
  // Undeclared commits have no notes publication and do not contend for this lock.
  const plain = JSON.parse(vlab(linked, "commit", "--all", "-m", "plain", "--json"));
  assert.equal(plain.provenance, undefined);
  assert.equal(fs.readFileSync(lock, "utf8"), claim);
});

test("an attributed initial commit refuses a held notes lock without creating HEAD", () => {
  const repo = makeReconcilable();
  git(repo, "switch", "--orphan", "unborn");
  write(repo, "initial.txt", "initial\n");
  git(repo, "add", "-A");
  const indexPath = path.join(repo, ".git", "index");
  const index = fs.readFileSync(indexPath);
  const lock = workspaceRuntime(repo, "notes.lock");
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, hostname: os.hostname() }));
  const args = ["commit", "-m", "initial", "--authored-by", "person:test", "--json"];
  assert.equal(refusal(vlabResult(repo, args)).code, "notes-locked");
  assert.notEqual(spawnSync("git", ["rev-parse", "--verify", "HEAD"],
    { cwd: repo, env: testEnv() }).status, 0);
  assert.deepEqual(fs.readFileSync(indexPath), index);
  assert.equal(fs.readFileSync(path.join(repo, "initial.txt"), "utf8"), "initial\n");
  fs.rmSync(lock);
  const retried = JSON.parse(vlab(repo, ...args));
  assert.equal(git(repo, "rev-list", "--count", "HEAD"), "1");
  assert.deepEqual(noteRecordIds(repo, retried.commit), [retried.provenance.id]);
});

test("attributed commits hold the notes lock through Git hooks and release it on Git failure", () => {
  const repo = makeReconcilable();
  const before = git(repo, "rev-parse", "HEAD");
  const lock = workspaceRuntime(repo, "notes.lock");
  const hooks = path.join(path.dirname(repo), "hooks");
  fs.mkdirSync(hooks);
  const hook = path.join(hooks, "pre-commit");
  fs.writeFileSync(hook, "#!/bin/sh\ntest -f \"$(git rev-parse --git-common-dir)/vcs-lab/notes.lock\" || exit 77\nexit 1\n", { mode: 0o755 });
  git(repo, "config", "core.hooksPath", hooks);
  write(repo, "hook.txt", "staged\n");
  git(repo, "add", "-A");
  const index = git(repo, "ls-files", "--stage");
  const args = ["commit", "-m", "hook", "--reviewed-by", "reviewer:test", "--json"];
  const error = refusal(vlabResult(repo, args));
  assert.equal(error.code, "git-command-failed");
  assert.doesNotMatch(error.message, /was created/);
  assert.equal(git(repo, "rev-parse", "HEAD"), before);
  assert.equal(git(repo, "ls-files", "--stage"), index);
  assert.equal(fs.existsSync(lock), false);
  // The hook now succeeds only if Git really runs under the outer notes lock.
  fs.writeFileSync(hook, "#!/bin/sh\ntest -f \"$(git rev-parse --git-common-dir)/vcs-lab/notes.lock\"\n", { mode: 0o755 });
  const committed = JSON.parse(vlab(repo, ...args));
  assert.deepEqual(noteRecordIds(repo, committed.commit), [committed.provenance.id]);
  assert.equal(fs.existsSync(lock), false, "nested append releases only after the whole commit finishes");
});

test("a post-commit notes failure identifies the retained commit and permits provenance repair", () => {
  const repo = makeReconcilable();
  const before = git(repo, "rev-parse", "HEAD");
  const blockedRef = path.join(repo, ".git", "refs", "notes", "vcs-lab.lock");
  fs.mkdirSync(path.dirname(blockedRef), { recursive: true });
  fs.writeFileSync(blockedRef, "test-held Git ref lock\n");
  write(repo, "publication.txt", "committed bytes\n");
  git(repo, "add", "-A");
  const error = refusal(vlabResult(repo,
    ["commit", "-m", "publication", "--generated-by", "agent:test", "--json"]));
  const commit = git(repo, "rev-parse", "HEAD");
  assert.notEqual(commit, before);
  assert.equal(git(repo, "rev-parse", "HEAD^"), before);
  assert.equal(git(repo, "status", "--porcelain"), "");
  assert.equal(error.code, "git-command-failed");
  assert.ok(error.message.includes(commit));
  assert.match(error.message, /was created.*provenance could not be published/);
  assert.match(error.details, /Do not retry commit/);
  assert.match(error.details, /docs\/identity\/README.md/);
  assert.equal(fs.existsSync(workspaceRuntime(repo, "notes.lock")), false);
  assert.equal(fs.readFileSync(blockedRef, "utf8"), "test-held Git ref lock\n");
  assert.deepEqual(JSON.parse(vlab(repo, "provenance", commit, "--json")).entries, []);
  fs.rmSync(blockedRef);
  // The documented repair uses the existing declaration API, under its notes
  // lock, to add the original claim without creating or rewriting any commit.
  const repair = [
    "import { changeIdForCommit } from \"./src/engine.js\";",
    "import { declareProvenance, provenanceFor } from \"./src/provenance.js\";",
    "import { withNotesLock } from \"./src/notes.js\";",
    "const [repo, commit] = process.argv.slice(1);",
    "withNotesLock(repo, () => {",
    "  if ((provenanceFor([commit], repo).get(commit) ?? []).length) throw new Error(\"Inspect existing provenance before repairing.\");",
    "  declareProvenance(commit, changeIdForCommit(commit, repo), [{ role: \"generated\", actor: \"agent:test\" }], repo);",
    "});",
  ].join("\n");
  exec(process.execPath, ["--input-type=module", "-e", repair, repo, commit], projectRoot);
  assert.equal(git(repo, "rev-parse", "HEAD"), commit);
  const [record] = JSON.parse(vlab(repo, "provenance", commit, "--json")).entries;
  assert.deepEqual(record.actors, [{ role: "generated", actor: "agent:test" }]);
  assert.equal(record.origin, "declared");
  const repeated = spawnSync(process.execPath, ["--input-type=module", "-e", repair, repo, commit],
    { cwd: projectRoot, env: testEnv(), encoding: "utf8" });
  assert.notEqual(repeated.status, 0);
  assert.deepEqual(noteRecordIds(repo, commit), [record.id], "repair refuses to duplicate a declaration");
});
