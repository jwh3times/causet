# ADR-0022: Reject Git's read-side maintenance caches on measured evidence

- **Status:** Accepted
- **Date:** 2026-08-31
- **Owners:** Repository maintainers
- **Related requirements:** GP-12, NFR-PERF-01 through NFR-PERF-07
- **Tracked by:** [issue #10](https://github.com/jwh3times/vcs-lab/issues/10)
  (roadmap Horizon 1.5 item 3, ADR-0015 program phase 0a)

## Context

Phase 0a's purpose is to exhaust what stock Git offers before any native code
is written, so that a later native claim is measured against Git's best mode
rather than against an unoptimized `vlab`. Roadmap Horizon 1.5 item 3 named
three Git features to try: the commit-graph, the multi-pack index, and
`core.fsmonitor`, enabled from `vlab init`.

The first two were implemented behind an opt-in `vlab init --optimize` with a
`--no-optimize` reversal, then measured. One fixture was built once and every
phase measured with the caches off and on, alternating off/on/off/on so that
OS cache warming and background load bias both arms equally. Medians, not
means: this host has a roughly 35 ms Git process floor and occasional
multi-hundred-millisecond stalls. Nothing else ran during the measurements.
Windows, Git 2.55.0.windows.3, Node v26.4.0. Full figures are recorded on
issue #10.

**At 400 trunk commits, run twice**, the deltas were between −1.4% and +2.5%,
and three of five phases reversed sign between two identical runs. The effect
is smaller than run-to-run variance.

**At 1500 trunk commits** — nearly four times the depth, chosen because the
commit-graph's benefit should grow with history — the picture was unchanged:
−1.3% to +4.5%, no phase consistently improved.

The measurements also produced a result that was not the question asked.
Comparing the two fixtures directly, at 3.75× the history:

| Phase | 400 commits | 1500 commits |
| --- | --- | --- |
| `merge-plan` | 383.1 ms | 375.8 ms |
| `forecast` (merge-tree) | 585.6 ms | 579.2 ms |
| `forecast` (worktree) | 1416.9 ms | 1377.0 ms |
| `metadata status` | 361.0 ms | 357.4 ms |
| `receipts` | 118.2 ms | 116.4 ms |

Quadrupling history depth changed nothing measurable; every phase is flat or
marginally faster. **These commands are dominated by fixed costs — Node
startup, then a handful of Git process launches at the host's floor — not by
history traversal.**

## Decision

**The commit-graph and multi-pack index are not adopted, and the
implementation is reverted rather than shipped disabled.** The measurement is
the deliverable; the code was not. Shipping an opt-in flag that provably moves
nothing at either scale would add CLI surface, documentation, tests, and a
permanent maintenance obligation for no demonstrated benefit, which is exactly
the speculative optimization
[ADR-0013](0013-measure-scan-amplification-before-adding-indexes-or-a-service.md)
and GP-12 exist to prevent.

**`core.fsmonitor` is rejected without implementation.** Unlike the other two
it is not a passive cache: the builtin FSMonitor starts a per-repository
background daemon that outlives the command, which `docs/testing.md`'s release
gate forbids ("no VCS Lab Node or Git process remains after completion"), and
its behavior over a OneDrive-synced working tree is unmeasured. Against those
costs stands the evidence above that the read side is not the bottleneck, and
the fact that `git status` is already batched into one worktree-scoped query
per workspace (issue #1). Implementing it to measure it is not warranted.

**Git's best mode is Git's current mode.** ADR-0014 Gate A item 2 requires
that native claims be measured against Git's best mode. This ADR establishes
that, for the read paths vcs-lab exercises, no further stock-Git configuration
improves on what the tool already does. The existing per-host baseline in
`benchmarks/baseline.json` is that best mode, and no baseline entry changes.

## Constraints

- A future adopter of any of these features must bring measurements that
  clear the noise floor on a named host, not reasoning about what the feature
  is designed to do.
- This decision is scoped to the read paths measured. It says nothing about
  workspace materialization, which is a different cost centre and remains
  open (issue #10 sub-items 2 and 3).

## Consequences

### Positive

- Phase 0a's question is answered with evidence rather than left open: stock
  Git's read-side tuning offers this workload nothing.
- No inert configuration surface is added to `vlab init`.
- Gate A item 2 is satisfied without further work, and the existing baseline
  stands as the Git-best-mode reference.
- The depth-insensitivity result is a better characterization of where time
  goes than the question that produced it, and it narrows where any future
  optimization — native or otherwise — could pay.

### Negative

- A repository far larger than anything measured here might benefit, and
  vcs-lab now offers no supported way to enable these caches. Users may set
  the same Git configuration themselves; nothing in vcs-lab prevents it, and
  `git` remains the authority over its own caches (ADR-0001).
- The measurement cost is spent and produced no shipped feature. That is the
  intended outcome of a measurement gate when the answer is no.

## Alternatives considered

- **Ship it opt-in, documented as having no measured effect.** Rejected: an
  option nobody has a reason to turn on is surface without benefit, and the
  documentation would have to talk a reader out of using it.
- **Ship it enabled by default.** Rejected more firmly: it would add a
  build step to `vlab init` for no measured gain, and the caches go stale
  without `git maintenance`, so the default would degrade over time.
- **Implement fsmonitor and measure it.** Rejected: the daemon conflicts with
  a release-gate criterion, so the implementation would have to solve a
  lifecycle problem before producing a single number, and the read-side
  evidence predicts the number would be uninteresting.
- **Test on a far larger fixture (10k+ commits).** Deferred rather than
  rejected. Depth-insensitivity between 400 and 1500 commits makes a large
  effect at 10k unlikely for these fixed-cost-dominated commands, and the
  fixture build cost is significant. A real repository would be better
  evidence than a larger synthetic one if this is ever revisited.

## Implementation map

- Measurements and full figures: issue #10
- Git-best-mode baseline: `benchmarks/baseline.json`, ADR-0017
- Remaining phase 0a work: issue #10 sub-items 2 and 3 (sparse cones from
  workspace focus, v2 benchmark profile with materialized-bytes phases)
- Gate definitions: ADR-0014 Gate A items 2 and 3
