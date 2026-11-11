# ADR-0013: Measure scan amplification before adding indexes or a service

- **Status:** Accepted
- **Date:** 2026-08-24
- **Owners:** Repository maintainers
- **Related requirements:** FR-WS-09, FR-SPEC-12, FR-PERF-03, FR-PERF-07, FR-PERF-09, FR-PERF-10, NFR-PERF-03 through NFR-PERF-05, NFR-SEC-02

## Context

The laboratory has bounded functional contracts for causal metadata,
resolutions, specifications, linked-worktree workspaces, and invocation-scoped
Git object sessions. It did not have one repeatable fixture that varied history,
worktree, note, and resolution volume together. Without that evidence, adding a
persisted catalog or resident repository service would confuse three different
costs:

- reading already-compact local registry data;
- launching one or more Git processes per entity; and
- scanning an already-batched object namespace whose latency grows with data.

The existing `vcs-lab.spec-benchmark/v2` already covers documentation volume,
content reads, cache hits, and metadata size. The missing experiment is the
repository and shared-metadata side of FR-PERF-10.

## Decision

Add `vlab metadata benchmark` and schema
`vcs-lab.repository-scale-benchmark/v1`. The command creates a disposable Git
repository, measures it, and removes it without reading or changing the caller
repository.

### Fixture

The representative-local v1 profile contains:

- 250 commits of reachable linear history;
- 12 active linked-worktree workspaces plus the main worktree;
- 250 valid causal note records on distinct commit targets;
- 50 valid retained resolution records and refs; and
- three measurement samples.

The caller can override `--history`, `--workspaces`, `--notes`, `--resolutions`,
`--samples`, and `--budget-ms` within explicit bounds. Generated identities and
content are synthetic. Setup duration and Git metrics are reported separately
from scan measurements.

### Measurements

Every phase verifies the same semantic result across samples and records cold,
warm-median, median, and p95 latency plus logical queries, Git processes,
session queries, cache hits, failures, and per-command totals. The phases are:

- reachable history count;
- stock Git worktree discovery;
- workspace registry JSON read;
- complete workspace status inspection;
- batched causal note catalog;
- reusable resolution catalog; and
- complete validated metadata status.

The JSON never includes fixture paths, object IDs, file contents, or commit
messages. Documentation volume remains covered by the companion
`vcs-lab.spec-benchmark/v2` schema rather than duplicating that corpus.

### Decision policy

The default interactive budget is 1,000 ms and may be overridden. A phase that
launches more than one Git process per measured entity is a batching candidate
before it is an indexing candidate. An already-batched phase that still exceeds
the budget at representative volume becomes an incremental-catalog candidate.

A resident service is never recommended from one local synthetic run. It may
be reconsidered only after invocation-local batching and any justified
incremental catalogs are measured on representative Windows and non-Windows
repositories and cross-command cost remains material.

## Initial evidence

The representative profile from clean commit
`fd8ade038995df36c98f992e051c8a4cf5d93065` on the 2026-08-24 Windows
development host produced:

| Phase | Median | Git processes | Interpretation |
| --- | ---: | ---: | --- |
| History, 250 commits | 72.74 ms | 1 | Bounded streaming scan |
| Git worktree list, 13 worktrees | 59.29 ms | 1 | Bounded stock Git scan |
| Registry read, 12 workspaces | 0.31 ms | 0 | No registry index indicated |
| Workspace status, 12 workspaces | 1,597.78 ms | 36 | Three processes per workspace; batch first |
| Note catalog, 300 targets | 172.67 ms | 2 | Existing batch path is effective |
| Resolution catalog, 50 records | 5,503.66 ms | 103 | Per-ref traversal dominates; batch first |
| Complete metadata status | 780.25 ms | 11 | Within the default median budget |

The evidence selects one bounded next optimization: batch workspace status and
resolution catalog scans, then rerun the same schema. It does not justify a new
persisted index or resident service.

## Post-batching evidence

The selected batching is implemented: workspace status uses one worktree-scoped
`git status --porcelain=v2 --branch -z` query per materialized path, and the
resolution catalog discovers refs with one `for-each-ref` scan, peels their
targets with one batched object check, and reads records with one note listing
plus batched object reads. The same schema, profile,
and measurement meaning were rerun on a 2026-08-27 Linux development host
(Git 2.55, Node 26) before and after the change:

| Phase | Before | After | Git processes |
| --- | ---: | ---: | --- |
| Workspace status, 12 workspaces | 93.63 ms | 35.53 ms | 36 → 12 |
| Resolution catalog, 50 records | 342.56 ms | 30.67 ms | 103 → 6 |
| Complete metadata status | 81.20 ms | 80.52 ms | 11 → 11 |

Semantic results were identical across samples and between ordinary and forced
Git-session modes. The decision output moved from
`batch-process-amplified-scans` to
`increase-fixture-volume-and-collect-more-hosts`; no phase exceeded the default
budget on this host. One `git status` process per materialized worktree is the
floor Git offers, and the resolution catalog's six processes are fixed rather
than per-record, so the per-entity ratio is meaningful only at representative
volume. The decision policy is therefore refined: a processes-per-entity ratio
above one is a batching candidate only when the phase measured at least ten
entities; below that the analysis reports `increase-fixture-volume` for the
phase and never recommends batching, an index, or a service from it. The
representative profile stays well above that minimum. The Windows rerun
below completes the two-host post-batching comparison; larger fixtures and
real repositories are the next evidence, not an index or service.

## Windows post-batching evidence

The same schema, representative profile, default budget, and three samples
were rerun on the 2026-08-24 Windows development host on 2026-08-29 (Windows
11, Git 2.55.0.windows.3, Node 26.4.0, baseline commit `1ce7e15`, v0.9.0
code) in ordinary mode and with `VLAB_GIT_SESSION=1`. Medians and p95 are in
milliseconds; the initial column is the 2026-08-24 pre-batching run above.

| Phase | Initial median | Ordinary median (p95) | Forced-session median (p95) | Git processes |
| --- | ---: | ---: | ---: | ---: |
| History, 250 commits | 72.74 | 54.43 (59.04) | 51.57 (54.21) | 1 |
| Git worktree list, 13 worktrees | 59.29 | 39.79 (42.90) | 41.51 (44.11) | 1 |
| Registry read, 12 workspaces | 0.31 | 0.27 (0.41) | 0.25 (0.35) | 0 |
| Workspace status, 12 workspaces | 1,597.78 | 409.62 (445.03) | 397.72 (405.55) | 36 → 12 |
| Note catalog, 300 targets | 172.67 | 131.30 (146.60) | 136.53 (149.79) | 2 |
| Resolution catalog, 50 records | 5,503.66 | 253.93 (260.16) | 267.14 (267.84) | 103 → 6 |
| Complete metadata status | 780.25 | 585.84 (919.73) | 582.58 (917.32) | 11 |

Semantic results were identical across samples and between the two modes, no
phase exceeded the default budget, and the decision output was
`increase-fixture-volume-and-collect-more-hosts` in both runs. Fixture setup
took 40.6 s and 39.5 s for 1,148 Git processes (about 35 ms per process),
which is the Windows process floor this host imposes on every per-entity
scan: the 12 `git status` processes account for the whole workspace-status
median. The two modes measure the same path because the benchmark's phases
use batched `cat-file` processes and never open the invocation-scoped object
session, and `VLAB_GIT_SESSION` defaults to on for Windows; the
forced-session column is retained as the equality check the roadmap asked
for, not as a distinct engine result. The cold complete-metadata-status
sample (about 918 ms) is the closest any phase comes to the budget.

This rerun satisfies the Windows half of ADR-0014 Gate A item 2. Because
every batched path is under budget at representative volume, Horizon 1
optimization ends here and no per-command budget that the batched Git path
misses has been named; ADR-0014 Gate A item 3 remains open and can be
answered only by larger fixtures, real repositories, or the Git-best-mode
baseline of roadmap Horizon 1.5. The raw JSON for both runs is attached to
[GitHub issue #2](https://github.com/jwh3times/vcs-lab/issues/2) and is not
committed.

These figures are at `1ce7e15`. The issue #4 correction that followed adds
one bounded peel process to complete metadata status (12 rather than 11 at
this profile); the other phases are unaffected.

## Constraints

- The benchmark must not mutate or disclose data from the caller repository.
- Fixture setup cost cannot be presented as scan cost.
- Timing claims name the host/profile and remain non-production evidence.
- Process count and semantic equality remain acceptance signals alongside wall
  time.
- The benchmark does not retain its disposable repository.
- Schema changes that alter fixture shape or measurement meaning require a new
  schema version.

## Consequences

### Positive

- Performance work now has one trendable repository-scale JSON contract.
- Cheap registry reads are distinguished from expensive status probes.
- Batched note behavior is visible beside the serial resolution path.
- Service and index decisions have an explicit fail-closed evidence gate.

### Negative

- Representative setup takes roughly one minute on the current Windows host.
- Synthetic empty-tree history does not reproduce large source blobs, network
  filesystems, antivirus behavior, or every real notes-tree shape.
- Worktree status still needs one `git status` process per materialized
  worktree; Git offers no cross-worktree status query.

## Rejected alternatives

- **Add a registry database immediately:** rejected because registry parsing is
  not the measured bottleneck.
- **Add a resident daemon immediately:** rejected because both slow catalogs
  still have invocation-local process amplification.
- **Benchmark only wall time:** rejected because it would not distinguish Git
  process launches from data-volume cost.
- **Run against the caller repository:** rejected because benchmark safety and
  reproducibility require a disposable, content-independent fixture.
- **Duplicate the specification corpus:** rejected because
  `vcs-lab.spec-benchmark/v2` already measures documentation volume.

## Implementation map

- Fixture, measurements, and decision output: `src/scale-benchmark.js`
- CLI surface and human summary: `src/cli.js`
- Acceptance coverage: `test/integration.test.js`
- Companion documentation benchmark: `src/specs.js`
- Batched workspace status: `src/workspaces.js`
- Batched resolution discovery and note reads: `src/resolutions.js`,
  `src/notes.js`
- Representative measurements and the decisions they support: this ADR's
  Initial evidence, Post-batching evidence, and Windows post-batching
  evidence sections
- Batching implementation brief and acceptance checklist:
  [GitHub issue #1](https://github.com/jwh3times/vcs-lab/issues/1)
