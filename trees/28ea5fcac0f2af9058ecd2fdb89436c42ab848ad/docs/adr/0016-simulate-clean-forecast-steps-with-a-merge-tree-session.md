# ADR-0016: Simulate clean forecast steps with a merge-tree session behind a flag

- **Status:** Accepted
- **Date:** 2026-08-29
- **Owners:** Repository maintainers
- **Related requirements:** GP-09, FR-GIT-07, FR-PERF-01, FR-PERF-02,
  FR-PERF-08, FR-REC-01, FR-REC-02, FR-REC-06, NFR-COR-02, NFR-COR-05,
  NFR-PERF-03, NFR-PORT-01, NFR-TEST-02

## Context

[ADR-0015](0015-adopt-a-phased-native-core-program-with-rust.md) makes
"Git-native wins" the first, Rust-free increment of the native-core program
(phase 0a), and roadmap Horizon 1.5 item 1 names the increment: simulate clean
forecast steps with `git merge-tree` behind a flag, fall back to the
temporary-worktree simulator otherwise, and pin the same trees. The
implementation brief is
[GitHub issue #3](https://github.com/jwh3times/vcs-lab/issues/3).

The worktree simulator of `vcs-lab.forecast/v2` and
`vcs-lab.rebase-forecast/v1` creates a detached linked worktree at the target,
runs `git cherry-pick -x` per queued change, reads the resulting tree, and
removes the worktree. On the 2026-08-24 Windows development host that costs
25 Git processes for the 12-change `demo:git-session` forecast with the object
session and 64 without it, at roughly 35 ms per process launch
(ADR-0013 Windows evidence). The material win ADR-0015 names for Windows and
OneDrive hosts is forecasts without temporary worktrees.

Facts verified on this host on 2026-08-29 (Git 2.55.0.windows.3), in
disposable repositories:

- `git merge-tree --write-tree --merge-base=<base> <ours> <theirs>` accepts
  tree object IDs for all three arguments from Git 2.45 (2.40 through 2.44
  resolve them as commits and die), never touches HEAD, the index, or
  the working tree, runs no hooks, and writes the result tree (and any
  synthesized conflict blobs) into the object database.
- `git merge-tree --stdin` reads `<base> -- <ours> <theirs>` lines from one
  process and streams one record per line: `1\0<tree>\0\0` for a clean merge
  and `0\0<tree>\0<stage entries>…\0\0<messages>…\0\0` for a conflicted one.
  Each record is flushed before the next line is read, so one process can
  serve a sequence whose inputs depend on earlier outputs. An unreadable
  object ends the process with exit 128.
- For every clean case probed (disjoint files, non-overlapping hunks in one
  file, a rename on the target with an edit in the change, executable-bit
  changes, binary files, directory add/delete, a merge commit relative to
  its first parent) the merge-tree result tree equals the tree that
  `git cherry-pick` produces in a worktree at the same target. On conflicts
  the index stage entries match but the conflict-marker blobs and
  file/directory placeholder names differ.
- A change already contained in the target yields the target's own tree from
  merge-tree, while `git cherry-pick` stops with "The previous cherry-pick is
  now empty" (exit 1, no unmerged paths), which the worktree simulator
  reports as `blocked-git-error`.
- Attributes (`merge` drivers, `text`, `eol`, `renormalize`) are read from
  the checkout Git runs in, never from the trees being merged, by both
  merge-tree and cherry-pick. `GIT_ATTR_SOURCE=<tree>` (Git 2.43+) makes
  merge-tree read them from a tree instead; older Git ignores the variable.
- `git cherry-pick` and `git merge` apply recorded `rerere` resolutions
  (also when `rerere.enabled` is unset but `.git/rr-cache` exists); with
  `rerere.autoUpdate` the index is resolved and no unmerged path remains.
  `git merge-tree` and `git replay` never consult rerere.
- `git replay` (experimental, 2.44+) replays a contiguous commit range with
  merge-ort in one process and writes real commits whose IDs depend on the
  committer environment; on conflict it exits 1 with no output and no
  indication of the failing step; it silently drops an already-applied
  commit; it refuses merge commits; and `--onto <tree>` crashes on this
  version.

## Decision

### Flag

`VLAB_FORECAST_ENGINE=worktree|merge-tree` selects the forecast simulation
engine, default `worktree`, mirroring the `VLAB_GIT_SESSION` pattern. The CLI
accepts `--forecast-engine <worktree|merge-tree>` on every command and sets the
variable for that invocation. Any other value is an error, never a silent
default. The default stays `worktree` for this release; flipping it is a
release decision that needs the differential evidence below from a Windows
host and a POSIX host. (Amended 2026-08-30 once both hosts had reported:
`merge-tree` is the default on Windows and `worktree` elsewhere; see the
amendment below.)

### Algorithm

With the merge-tree engine selected, `simulatePlan` first attempts the whole
queue without a worktree:

1. One batched object inspection resolves the target tree and, per queued
   change, its tree, its first-parent tree, whether a second parent exists,
   and the root `.gitattributes` blob before and after the change. The paths
   each change touched come from the plan, which reads them in the same
   single `git log` process that already builds the queue, so the attribute
   check below costs no extra Git invocation.
2. One `git merge-tree --stdin` process is started lazily by a worker thread
   and driven synchronously through a shared buffer, exactly as the object
   session of
   [ADR-0009](0009-use-an-invocation-scoped-git-object-session.md) drives
   `cat-file --batch-command`. The process runs in the caller worktree with
   `GIT_ATTR_SOURCE` set to the target tree, so attribute lookup matches the
   worktree simulator's checkout rather than the caller's checkout.
3. Each step merges `<first-parent tree> -- <accumulated tree> <change tree>`,
   which is the three-way merge `git cherry-pick` performs. A clean step pins
   `targetBeforeTree` (the accumulated tree) and `resultTree` (the merge
   result) with `outcome: "clean"`, and the result becomes the next
   accumulated tree. The predicted tree is the final accumulated tree, and
   every other forecast field is produced as before.

### Fallback rule

The merge-tree engine reproduces only steps the worktree simulator would also
label `clean`. The entire forecast is handed to the worktree simulator, which
remains the semantic oracle, whenever:

- a step conflicts (`conflicted-step`), because resolution memory and the
  Markdown driver run only inside the worktree simulator;
- a step's result tree equals its input tree (`empty-step`), which the
  worktree simulator blocks as an empty pick;
- a queued change is a merge commit (`merge-commit`) or a root commit
  (`root-commit`);
- a queued change other than the last adds, removes, or edits any
  `.gitattributes`, at the root or nested (`attributes-changed`, which names
  the triggering `path`), because a later step would merge under attributes
  the session cannot see; or
- the batched inspection or the session fails (`target-tree-unavailable`,
  `change-tree-unavailable`, `merge-tree-unavailable`, and `git-too-old` when
  the session process reports a Git older than 2.49, before any merge is
  requested).

The clean prefix is discarded rather than resumed; re-running the whole queue
in the worktree simulator keeps one implementation of every non-clean step
and makes equality trivially provable.

### Reporting

Both forecast schemas keep their version and every existing field, and add:
`engine` (`"merge-tree"` or `"worktree"`; `null` when no simulation ran),
`fallbacks` (an array of `{ engine, reason, step?, sourceCommit?, detail? }`),
and `timings.mergeTree` beside `timings.worktree`, each all zeros when that
engine did not run. Merges are recorded in `timings.git` under the synthetic
command `merge-tree-session` with one process per session, and `--trace-git`
prints them as persistent-process queries. The human output prints the
engine and each fallback.

### Equality discipline

The integration suite passes in ordinary, forced-session, and merge-tree
engine modes, and differential tests run the same scenarios under both
engines and compare per-step and predicted trees, outcomes, approvals, and
blocked reasons. Forecasts from either engine are accepted by
`--use-forecast`; application still runs the real `git cherry-pick`, and the
FR-REC-06 apply-time check (predicted tree versus actual tree before any
receipt is published) is retained unchanged, so a divergence the tests did
not anticipate surfaces as `forecast-mismatch`, never as a wrong receipt.

### Git constraints

The following are Git behaviors, not engine defects; the engine falls back
or the documentation records them:

- `.gitattributes` edits by a queued change are detected at the root and in
  any subdirectory, from the changed-path list the plan already reads, so a
  later step never merges under attributes the engine cannot see. This
  closed a documented equivalence gap on 2026-08-31 (issue #9); before it,
  only the root file was checked and FR-REC-06 was the sole guard.
- The engine needs Git 2.49 (corrected from 2.45 by the 2026-08-30
  amendment below): `merge-tree --stdin` flushes each record before reading
  the next request only from 2.49, `merge-tree` accepts bare tree operands
  from 2.45, and `GIT_ATTR_SOURCE` exists from 2.43 (older Git ignores it and
  reads attributes from the caller's checkout). vlab's supported floor stays
  2.40; on older Git the session worker reads the version from its own
  process's trace2 `version` event, refuses the first merge, and the forecast
  records `git-too-old` while the whole queue runs in the worktree simulator.
  The differential tests, the demo's merge-tree assertions, and the
  benchmark's merge-tree mode skip there. The engine is verified on 2.49,
  2.55, and 2.55.0.windows.3.
- External merge drivers named in attributes run under both engines.
- `rerere` was applied by the worktree simulator's cherry-pick and by real
  application, never by merge-tree, so a user with `rerere.autoUpdate` saw a
  recorded resolution staged by Git and the step reported as
  `blocked-git-error` rather than as a conflict vlab can resolve from its
  own memory. [ADR-0018](0018-disable-git-rerere-inside-vlab-picks-and-landing-merges.md) closes this: every vlab cherry-pick and
  landing merge now runs with rerere disabled, so both engines report the
  conflict itself.
- Result trees written by merge-tree remain as unreferenced objects until
  Git garbage-collects them, as the worktree simulator's commits already do.

### git replay

`git replay` is not adopted, as an engine or as an oracle: it is
experimental, above the 2.40 floor, limited to contiguous ranges while vlab
replays a filtered queue, gives no diagnostics on conflict, silently drops an
already-applied commit that vlab must block, and produces committer-dependent
commit IDs. The worktree simulator is the oracle.

## Evidence

The `demo:git-session` forecast (12 clean changes, one file) on the Windows
development host on 2026-08-29 (Windows 11, Git 2.55.0.windows.3,
Node 26.4.0):

| Mode | Git processes | Logical queries | Wall time |
| --- | ---: | ---: | ---: |
| Worktree simulator, ordinary Git | 64 | 64 | 2,318 ms |
| Worktree simulator, object session | 25 | 64 | 1,234 ms |
| Merge-tree engine, object session | 10 | 25 | 496 ms |

The merge-tree run performs its 12 merges through one persistent process and
creates no temporary worktree; nine of its ten processes are inside the
forecast (`timings.git.processes`), the tenth is the CLI's repository-context
query before the forecast starts. Predicted and per-step trees are identical
in all three modes. A forecast that falls back pays for the failed attempt:
the one-change exact-resolution forecast of `demo:forecast` uses 21 processes
with the merge-tree engine against 20 with the worktree engine. Wall time is
machine-specific; process count and tree equality are the acceptance
invariants. The POSIX host measurements are in the 2026-08-30 amendment
below.

## Amendment 2026-08-30

### Git floor corrected to 2.49

The first POSIX run of the differential suite (Debian 13, Git 2.47.3,
Node 22.23.2, a Linux container on the Windows workstation;
[GitHub issue #7](https://github.com/jwh3times/vcs-lab/issues/7)) failed
every merge-tree scenario: each forecast waited out the 60 s session timeout
and fell back with `merge-tree-unavailable`, and every other forecast
scenario under `VLAB_FORECAST_ENGINE=merge-tree` paid the same minute. The
cause is a Git behavior the Context above verified only on 2.55:
`git merge-tree --stdin` flushes each record before reading the next request
only from Git 2.49 (Git commit `344a107b`, "merge-tree --stdin: flush stdout
to avoid deadlock", first released in 2.49.0). On 2.38 through 2.48 the
records sit in the process's stdio buffer until it exits, so a session that
feeds each step's result into the next never sees its first answer. The
engine's floor is therefore 2.49, not 2.45; bare tree operands (2.45) and
`GIT_ATTR_SOURCE` (2.43) are older requirements that remain satisfied.

The `git-too-old` detection moves before the first request. The session
process runs with `GIT_TRACE2_EVENT=2` and `GIT_TRACE2_EVENT_BRIEF=1`, and
the worker reads the trace2 `version` event Git writes to stderr as it
starts (Git 2.22+, before it reads any input; about 2 ms on both hosts) and
refuses the first merge when that version is below the floor. The forecast
records `git-too-old` with the reported version and the whole queue runs in
the worktree simulator; no request is written, nothing waits, and no
`git --version` process is spawned, so process counts are unchanged on every
path. A session that exits on its first request without having reported a
version is still checked once with `git --version`, as before. Git's own
stderr messages are kept apart from the trace2 lines for error reporting,
and a caller's `GIT_TRACE2_EVENT` setting is overridden for that one
process.

Rejected for this correction: a `git --version` process before every
merge-tree forecast (one more process on the supported path, breaking the
single-digit criterion of Horizon 1.5); a bounded wait for the first record
before checking the version (timing-dependent process counts); `stdbuf` or
pseudo-terminal tricks (POSIX-only, and a clean record carries no newline to
line-buffer on); and raising vlab's supported Git baseline to 2.49 (Debian 13
ships 2.47 and Ubuntu 24.04 LTS ships 2.43).

### POSIX evidence

With the floor corrected, the differential suite and the demonstrations were
run on 2026-08-30 on three Linux hosts, each a Docker container on the
Windows workstation (WSL2 kernel, 16 vCPUs) holding a fresh clone of
`a624534` plus the correction, as an unprivileged user:

- Ubuntu 24.04.4 LTS, Git 2.55.0 from the git-core PPA, Node 22.23.2: the
  suite passes in all four modes (`VLAB_FORECAST_ENGINE=merge-tree` with
  `VLAB_GIT_SESSION=0` and with `VLAB_GIT_SESSION=1`, the default mode, and
  `VLAB_GIT_SESSION=1`; 62 tests, 61 passed, 1 skipped in each), every demo
  completes, `npm run benchmark:record` produced the committed `linux`
  baseline entry, and `npm run test:benchmark` passes against it.
- Alpine 3.22, Git 2.49.1 (the floor), Node 22.22.3: the same four suite
  modes pass with the same counts and every demo completes.
- Debian 13, Git 2.47.3 (below the floor), Node 22.23.2: the suite passes in
  all four modes with the differential scenarios skipped and the real
  `git-too-old` scenario exercised; the demo's merge-tree mode falls back
  immediately with `git-too-old` naming 2.47.3 at 26 processes and 66
  queries against 25 and 64 for the session path (66 against 64 without the
  object session), and the benchmark's merge-tree mode is reported as
  skipped.

The `demo:git-session` forecast on the Ubuntu host (the median of three
consecutive runs):

| Mode | Git processes | Logical queries | Wall time |
| --- | ---: | ---: | ---: |
| Worktree simulator, ordinary Git | 64 | 64 | 236 ms |
| Worktree simulator, object session | 25 | 64 | 243 ms |
| Merge-tree engine, object session | 10 | 25 | 160 ms |

Process counts and logical queries equal the Windows figures above,
predicted and per-step trees are identical in all three modes, and the
merge-tree engine without the object session uses 25 processes for its 25
queries. The wall-time deltas are platform-specific: a Linux process launch
costs a few milliseconds, so the object session saves no time there and the
merge-tree engine saves about a third of a quarter-second forecast, against
the 738 ms (2.5×) it saves over the session path on Windows. The `linux`
entry of `benchmarks/baseline.json` (ADR-0017) records 63, 24, and 9
forecast processes in the three benchmark modes, matching `win32`, at 189,
175, and 100 ms, with every scale phase under 60 ms. The raw JSON, logs, and
the too-old-host figures are attached to
[GitHub issue #7](https://github.com/jwh3times/vcs-lab/issues/7) and are not
committed.

### Default engine

With both hosts reported, the default forecast engine becomes `merge-tree`
on Windows (`process.platform === "win32"`) and stays `worktree` on every
other platform; `VLAB_FORECAST_ENGINE` and `--forecast-engine` override
either, and `--forecast-engine worktree` selects the oracle anywhere.

- Windows is where ADR-0015 named the material cost (about 35 ms per process
  launch, OneDrive-hosted checkouts) and where the engine cuts the 12-change
  forecast from 25 to 10 processes and from 1,234 ms to 496 ms. Git for
  Windows has shipped 2.49 or newer since March 2025, and a host below the
  floor pays one short-lived process per forecast with the object session
  (two without it, as measured on the Debian host above) and reports
  `git-too-old`.
- On POSIX hosts the engine saves about a third of a forecast that already
  completes in a quarter of a second, while distribution Git is frequently
  below 2.49 (Debian 13 ships 2.47, Ubuntu 24.04 LTS 2.43, RHEL 9 and 10
  2.43 and 2.47): a merge-tree default there would report a fallback on every
  forecast for many users for little gain. Hosts with a newer Git opt in.
- The rule mirrors `VLAB_GIT_SESSION`, whose default is also Windows-only,
  so one sentence describes both performance controls: Windows enables the
  object session and the merge-tree engine automatically; POSIX hosts opt
  in.
- Both engines stay qualified everywhere: the suite must pass with each
  engine forced on every host (`docs/testing.md`, NFR-TEST-02), and the
  benchmark modes select their engine explicitly, so no baseline entry moves.

The default becomes `merge-tree` on every platform when vlab's supported Git
baseline rises to 2.49 or the common POSIX distributions ship it; that is a
release decision to record here or in a superseding ADR. Rejected now:
`merge-tree` everywhere (fallback noise on distribution Git) and `worktree`
everywhere until the baseline rises (forgoes the measured Windows win for
years).

## Constraints

- No receipt-publishing path moves engines: application runs the real
  sequencer, forecasts are validated by pinned trees, and FR-REC-06 stays.
- Every forecast reports `engine` and `fallbacks`; a fallback is never
  silent.
- The worktree simulator remains fully functional and is the oracle for every
  non-clean step; the engine is reversible by flag.
- A divergence found by the differential tests is recorded here as a Git
  constraint with the flag off or falling back for that case, never patched
  forward.

## Consequences

### Positive

- Clean forecasts need no temporary worktree, no checkout I/O, and one
  process for all merges, which is the first measured Git-best-mode baseline
  ADR-0014 Gate A item 2 asks for.
- Two implementations of the clean step exist behind one flag with an
  automated equality discipline, which is the shape phase 1 of ADR-0015 will
  reuse.
- Every attribute-dependent and rerere-dependent behavior of the worktree
  simulator is now written down.

### Negative

- A forecast that conflicts pays for the failed merge-tree attempt.
- Git older than 2.49 gets no engine at all.
- A third suite mode lengthens qualification.

## Rejected alternatives

- **One merge-tree process per step:** simplest, but 12 processes for the
  demo forecast cannot meet the single-digit exit criterion.
- **`git replay` as the batched engine:** rejected for the reasons above.
- **Resume the worktree simulator from the last clean tree after a
  conflict:** saves the clean prefix but needs a synthetic commit and a second
  code path for the transition; equality would be harder to prove.
- **An in-memory three-way merge in JavaScript:** re-implements merge-ort,
  which is Horizon 5 phase 4 territory and may be dropped entirely on this
  evidence.
- **Flip the default to merge-tree now:** rejected until the differential
  suite has run on both hosts.
- **Disable rerere inside vlab's cherry-pick calls in this change:** a
  behavior change to the application path outside this brief; deferred to
  its own issue and decided by [ADR-0018](0018-disable-git-rerere-inside-vlab-picks-and-landing-merges.md).

## Implementation map

- Engine selection and the persistent merge-tree session: `src/git.js`
  (`forecastEngine`, `MergeTreeSession`), `src/merge-tree-session-worker.js`
- Simulation, fallback rule, and reporting: `src/forecasts.js`
  (`simulatePlanWithMergeTree`, `simulatePlan`), `src/rebase-forecast.js`
  (`engine`, `fallbacks`, `timings.mergeTree`, `formatForecastEngine`),
  `src/cli.js` (`--forecast-engine`)
- Differential coverage: `test/integration.test.js` merge-tree engine tests;
  `scripts/git-session-demo.mjs` three-mode comparison
- Documentation: `docs/architecture.md` §9 and §14, `docs/testing.md`
  validation modes, `README.md`, `docs/product.md` FR-GIT-07, NFR-TEST-02, NFR-PORT-01, and §13 evidence,
  `docs/roadmap.md` Horizon 1.5
- Implementation brief and host evidence:
  [GitHub issue #3](https://github.com/jwh3times/vcs-lab/issues/3)
