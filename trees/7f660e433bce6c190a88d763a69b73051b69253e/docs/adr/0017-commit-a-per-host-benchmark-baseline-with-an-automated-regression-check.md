# ADR-0017: Commit a per-host benchmark baseline with an automated regression check

- **Status:** Accepted
- **Date:** 2026-08-29
- **Owners:** Repository maintainers
- **Related requirements:** FR-PERF-01, FR-PERF-02, FR-PERF-10, NFR-PERF-03,
  NFR-PERF-06, NFR-TEST-01

## Context

NFR-PERF-06, added by
[ADR-0014](0014-split-the-native-implementation-gate-into-engine-and-store-gates.md),
says that per-invocation latency budgets are measured per host by the
benchmark suite and that, once a baseline is committed with the automated
regression check that consumes it, a regression blocks a release.
`docs/testing.md` release gate item 9 references that check, and
`docs/README.md` permits committing a machine-readable baseline only when an
automated check consumes it. Neither the baseline nor the check existed, so
the gate item was vacuous by design
([GitHub issue #5](https://github.com/jwh3times/vcs-lab/issues/5)).

Two evidence sources exist. `vcs-lab.repository-scale-benchmark/v1`
(ADR-0013) measures repository scans on a disposable fixture and reports
medians, p95, and Git process counts per phase; its representative profile
takes about 40 s of fixture setup on the Windows host, which is too slow for a
check that runs in every qualification. Forecast metrics report process
launches, logical queries, and elapsed time per forecast, and
[ADR-0016](0016-simulate-clean-forecast-steps-with-a-merge-tree-session.md)
now makes the engine and session mode part of what a number means.

Process counts on a fixed fixture are deterministic. Wall time on the
maintainer's Windows/OneDrive development host is not: the same phase varies
by tens of percent between runs with antivirus, sync, and cache effects.

## Decision

The original OS-keyed latency selection below is superseded by the
[identified-host amendment](#identified-host-amendment-2026-09-06).

### Baseline shape

`benchmarks/baseline.json` carries schema `vcs-lab.benchmark-baseline/v2`
(amended 2026-08-31; see below):

- `profile`: the fixed reduced volume the check runs (`reduced-local-v3`:
  100 commits, 4 workspaces, 60 notes, 12 resolutions, a working tree of
  10 areas of 60 files, 3 samples, the 1,000 ms budget, a 12-change forecast
  queue, and a 6-change publication queue);
- `tolerance`: the documented limits (below);
- `hosts.<platform>`: one entry per `process.platform` (`win32`, `linux`,
  `darwin`) with the recording date, Git and Node versions, per-phase
  `medianMs`, `p95Ms`, and `medianProcesses` for the nine scale phases,
  `materialization` files and bytes for a full and a coned workspace, and
  per-mode forecast `processes`, `queries`, and `forecastMs` for
  `worktree-ordinary`, `worktree-session`, and `merge-tree-session`.

Git and Node versions are recorded for interpretation, not as part of the
key: a toolchain upgrade that moves a number is a deliberate re-record, not a
silent new baseline.

### Check

`npm run test:benchmark` (`scripts/benchmark-regression.mjs`) builds the
reduced scale fixture and the forecast fixture in disposable repositories,
measures them, and compares against this host's entry:

- a phase or forecast mode whose median process count exceeds the baseline
  fails (tolerance 0; process launches are the deterministic guard);
- a median or forecast time above twice the baseline, or above the baseline
  plus 5 ms for phases too fast for a ratio to be meaningful, fails (ratio
  2.0 with a 5 ms floor; this is a coarse guard against order-of-magnitude
  regressions, not a wall-time contract);
- forecasts in the three modes must produce identical plans, per-step trees,
  and predicted trees, and the merge-tree mode must not fall back on the
  clean queue; a difference fails as a correctness regression;
- a forecast mode the host cannot run (the merge-tree mode below Git 2.45) is
  measured on neither side and reported as skipped, never as a regression;
- a host with no baseline entry skips with a warning and exit 0, so a new
  host is never blocked by evidence it cannot yet have;
- a baseline recorded with a different profile or tolerance is an error that
  asks for a re-record; the tolerance is committed in the file so the limits
  applied are the limits recorded.

`npm run benchmark:record` rewrites this host's entry from a fresh run. It is
run on a quiet host, in a clean checkout, and committed together with the
change that moved the numbers, with the reason in the changelog. When the
profile or tolerance has changed since the file was recorded, recording drops
the other hosts' entries, which are no longer comparable, and says so; each
host re-records its own. An interrupted run removes its
`vcs-lab-benchmark-check-*` fixtures.

### Gate

Release gate item 9 becomes active on every host that has an entry: the
check must pass there before a release. Hosts without an entry are reported
as skipped in the release summary.

## Amendment 2026-09-01: profile v3, the publication loop

Every phase in v2 measured a read, and the forecast phases simulate without
publishing, so the benchmark had no coverage of the **publication loop** — the
one stretch whose work scales with the number of changes, since each
application publishes its own record, its resolutions, and the provenance
carried onto it.

The gap was found the expensive way (issue #15). A per-application `git notes
list` was added there with authorship provenance and passed the entire suite,
all five suite modes, and this check; a six-change reconciliation went from 15
Git processes to 21, about 30 ms each on this host, and nothing noticed. It was
caught by reading a `VLAB_TRACE=1` trace by hand.

The profile becomes `reduced-local-v3` and gains `publishChanges: 6`. Each host
entry carries a `publication` block: the queue size, the **processes the whole
`vlab reconcile` invocation started**, the records it published, and its
elapsed time. Processes and records are compared under the **process rule**,
like `materialization`: the fixture is deterministic and the queue is fixed, so
any growth is a real change in what publishing a change costs. `records` is a
semantic guard rather than a performance one — if it moves, the phase has
stopped measuring what it claims to.

Two choices in that phase are deliberate.

**The count comes from the trace, not from the receipt.** The reconciliation
receipt's `timings.git` block covers the application phase only, because the
receipt is built before publication runs. The trace is the only place the whole
cost of the command appears, and FR-PERF-07 already makes its shape a contract.
That the receipt cannot see its own publication cost is worth stating plainly:
a caller reading metrics is not being told the whole story, and closing that
would mean a new version of the receipt family.

**Provenance is declared on the fixture's source commits**, so the carry path
actually runs. With no provenance in a repository that path returns before its
loop, and a regression inside it would be invisible — which is precisely how
the original one hid.

Verified by mutation: restoring the per-application read takes the phase from
41 processes to 47 and the check reports a regression, while `records` stays at
19, so the signal is a cost change rather than a behavioural one.

As this decision already requires, changing the profile forces every host to
re-record. The `win32` entry is re-recorded; the `linux` entry is dropped and
must be re-recorded on that host, until which time the check reports it as
skipped.

Recorded on win32 (Git 2.55.0.windows.3, Node v26.4.0): a six-change
reconciliation with declared provenance costs 41 Git processes and publishes 19
records — six applications, six declared and six carried provenance records,
and one reconciliation receipt. On linux (Git 2.55.0, Node v22.23.2, Ubuntu
24.04) the same fixture publishes the same 19 records in **56** processes.

**This is the first phase whose process count differs between hosts**, and the
difference is understood rather than tolerated. Every other phase runs an
identical transport on both, but the publication phase runs each host's
*default*: under FR-PERF-08 Windows defaults to the batched object session and
POSIX does not, so Windows serves many object reads through one persistent
process where Linux starts one per read. Forcing the session on Linux
(`VLAB_GIT_SESSION=1`) gives exactly 41, the Windows figure, which was measured
rather than assumed. The semantic figure — 19 records — matches on both, as the
cross-host equality of every other phase does.

Measuring the default rather than a pinned transport is deliberate: the number
worth defending against regression is what the command actually costs a user on
that host, and the equality check that matters is the one on records.

## Amendment 2026-08-31: profile v2, workspace materialization

Roadmap Horizon 1.5 item 3 (issue #10) needed the benchmark to measure what a
workspace writes to disk. It could not: every history commit in the v1 fixture
carried the empty tree, so a materialized workspace contained no files and
workspace creation had nothing to time.

The profile becomes `reduced-local-v2` and the baseline schema
`vcs-lab.benchmark-baseline/v2`. The fixture gains a real working tree of ten
directories holding sixty 1 KiB files each, and two phases are added:

- `workspaceCreate` — wall time and process count for `vlab workspace create`
  against that tree;
- `workspaceCreateCone` — the same restricted to one directory with a sparse
  cone.

The report and each host entry also carry `materialization`, the files and
bytes present in a full and in a coned workspace. Those are compared under the
**process rule rather than the latency rule**: the fixture is deterministic, so
any growth in what a workspace writes is a real change rather than host noise,
and no tolerance applies.

As this decision already requires, changing the profile forces every host to
re-record. The `win32` entry is re-recorded; the `linux` entry is dropped and
must be re-recorded on that host, until which time the check reports it as
skipped.

One gap in the tooling was fixed to make this possible. `--record` refused to
run against a baseline written under an older schema, so a schema bump had no
supported migration path and would have required hand-editing a committed
artifact. It now starts a fresh baseline for the new schema and names the host
entries it drops, exactly as it already did for a profile change. A check still
refuses on a schema mismatch, because comparing against a baseline of a
different shape is meaningless.

Recorded on win32 (Git 2.55.0.windows.3, Node v26.4.0): a full workspace
materializes 600 files and 615,000 bytes in a median 481 ms; a coned workspace
materializes 60 files and 61,500 bytes in a median 261 ms.

## Constraints

- The check consumes the committed baseline; nothing else may read it, and
  no timestamped run output is committed.
- The reduced profile is fixed by the script; changing it changes the schema
  or forces every host to re-record.
- Representative evidence for decisions still comes from the representative
  profile and is recorded in ADRs (ADR-0013, ADR-0016); the reduced profile
  guards regressions only.
- A regression is fixed or the baseline is re-recorded deliberately; the
  tolerance is never widened to make a run pass.

## Identified-host amendment (2026-09-06)

[Issue #52](https://github.com/jwh3times/vcs-lab/issues/52) demonstrated that
`process.platform` identifies an OS, not a machine: unrelated Linux hosts
inherited one latency baseline. The original rejection of machine-specific
keys is superseded for latency. Schema `vcs-lab.benchmark-baseline/v3` uses
explicit operator-assigned labels via `--host <label>` or `VLAB_BENCHMARK_HOST`
(command-line selection wins). Labels remain stable across toolchain upgrades;
no hostname or private machine identifier is collected.

Identified entries include platform, architecture, CPU models and count, memory
capacity, OS release, benchmark engine/session overrides, Git, and Node
provenance. Label, hardware, and overrides must match before comparing latency.
Version changes remain visible provenance for interpreting a result. Recording
requires a label before fixtures are created. Hardware changes or reused labels
require deliberate re-recording rather than silent baseline reassignment.

The v2 OS entries move intact to `legacyHosts`; `hosts` initially has no identified
machines. No historical measurement, date, profile, or tolerance changes. Legacy
latencies remain historical only. Their deterministic counts can still check
unknown machines using the same platform defaults; explicit engine/session
overrides cannot borrow those counts. Semantic forecast checks always run.
Unknown hosts report latency as skipped in human and JSON output, including when
deterministic counts pass. This does not satisfy release latency qualification.

Recording preserves all other identified and historical entries. Reading v2
normalizes its shape without writing. Unlike the earlier destructive recorder
migration, unsupported schemas and profile/tolerance changes now require an
explicit migration instead of silently dropping entries. The latency ratio and
process tolerances are unchanged. Establishing measured identities on the actual
qualification machines remains evidence work under issues #22 and #42; this
amendment does not infer which machine produced the old Linux or Windows data.

## Consequences

### Positive

- Process-count regressions in scans and forecasts block a release
  automatically on the hosts that qualify releases.
- Engine and session mode are part of every recorded forecast number.
- The check runs in well under a minute on the development host.

### Negative

- The latency guard is coarse; a 50% slowdown passes.
- Each qualifying host must record and maintain its own entry, and a
  toolchain upgrade may require a re-record.
- The reduced profile is below ADR-0013's ten-entity threshold for
  amplification decisions, so it never informs those decisions.

## Rejected alternatives

- **Compare against the representative profile:** the 40 s setup makes the
  check too slow to run in every qualification.
- **Wall time only:** contradicts NFR-PERF-03; process counts and semantic
  equality are the acceptance signals.
- **Key baselines by CPU or machine name:** would create one entry per
  workstation and no shared expectation per platform.
- **Fail on hosts without a baseline:** would block contributors on
  platforms the maintainer has not measured.

## Implementation map

- Check and recorder: `scripts/benchmark-regression.mjs`, `package.json`
  (`test:benchmark`, `benchmark:record`)
- Committed baseline: `benchmarks/baseline.json`
- Gate wording and command: `docs/testing.md`
- Evidence policy: `docs/README.md`, `docs/product.md` NFR-PERF-06
- Implementation brief: [GitHub issue #5](https://github.com/jwh3times/vcs-lab/issues/5)
