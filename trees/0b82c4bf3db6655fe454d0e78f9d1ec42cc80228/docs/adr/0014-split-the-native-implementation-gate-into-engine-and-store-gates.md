# ADR-0014: Split the native implementation gate into engine and store gates

- **Status:** Accepted
- **Date:** 2026-08-28
- **Owners:** Repository maintainers
- **Related requirements:** GP-01, GP-02, GP-09, GP-12, FR-PERF-09, FR-WS-08,
  FR-WS-09, NFR-PERF-03, NFR-PERF-04, NFR-PERF-06, NFR-PERF-07, NFR-PORT-05

## Context

The product's stated destination is a source-control protocol that natively
supports agentic workflows and is more efficient than Git. Everything
delivered through v0.9.0 is a causal compatibility layer over Git, as
[ADR-0001](0001-use-git-as-the-compatibility-and-storage-substrate.md)
requires during the laboratory phase, and PRD §15 listed eight conditions that
trials must demonstrate before a native store or protocol prototype begins.

On 2026-08-28, with v0.9.0 released, none of the eight conditions was fully
met and two were partially met. Six are user-value conditions (users prefer
compact landing, IDs improve rewrites, forecasts reproduce predicted trees,
workspaces improve parallel agents, resolution reuse avoids work, spec
identity helps real corpora) that a laboratory without external users cannot
satisfy from synthetic fixtures. The portability condition is contradicted by
envelope v1, which round-trips idempotently. After
[ADR-0013](0013-measure-scan-amplification-before-adding-indexes-or-a-service.md)'s
batching, the overhead condition is met only on the pre-batching Windows run;
Linux medians are between roughly twelve and thirty-three times under the
1,000 ms interactive budget (ADR-0013 post-batching table), and roadmap
Horizon 1 says to stop optimizing paths that are under budget. The gate
therefore cannot select the engine work that PRD §18's "credible, measured
contract for a later native protocol" requires.

The gate also conflates two kinds of native work:

- a **semantics-preserving engine** that produces identical plans, decisions,
  trees, receipts, and diagnostics through a different implementation, which
  GP-09 and ADR-0001's "optimized paths must be equality-tested" clause already
  govern; and
- a **semantics-changing store or protocol** (a canonical native record store,
  a wire protocol, private draft stacks without a compatibility branch), which
  is what the eight conditions were written to protect.

The owner decided on 2026-08-28 to amend the gate rather than either abandon
it or treat native work as an unmeasured bet.

## Decision

PRD §15's single gate becomes two gates. GP-01 and GP-09 are unchanged. GP-02
and GP-12 keep their principles; this ADR adds one consequence sentence to
each in PRD §7 (a content-addressed record identity identifies a claim, never
a tree, commit, or intent; a semantics-preserving engine may exist behind an
equality-tested seam before any replacement decision). The split never
permits a semantics change under Gate A.

### Gate A: semantics-preserving native engine

A native engine that implements existing `vcs-lab.*` contracts a second time
may begin when all of the following exist:

1. a published schema and conformance-fixture catalog for every persisted and
   automation-facing record family (roadmap Horizon 2 item 1), and a single
   read-side engine seam in the JavaScript implementation (`src/engine.js`)
   with an engine selector, a third integration-suite mode, and
   per-operation fallback recorded in metrics;
2. the Windows post-batching rerun of `vcs-lab.repository-scale-benchmark/v1`
   and a Git-best-mode baseline (clean forecast steps simulated with
   `git merge-tree`, sparse-cone workspaces where applicable), so every native
   claim is measured against Git's best mode rather than against the current
   `vlab` path; and
3. a named per-command budget on a representative Windows or OneDrive host
   that the batched Git path measurably misses, recorded in the ADR that
   introduces the engine.

Gate A work passes the complete integration suite in every engine mode with
byte-identical domain JSON; is reversible by flag, cache deletion, or
uninstalling a binding; never moves a receipt-publishing path between engines
before an equality test exists for it; and adds only derived, deletable
caches, never a canonical record store or a persisted-contract change.

**Sunset.** If, within two minor releases after the engine first ships, the
native engine has not met the named budget from item 3 on that host with
identical results, the binding is removed from the package. The seam, the
schemas, and the Git-best-mode baseline remain.

### Gate B: semantics-changing native store, protocol, or draft stacks

The original eight conditions remain in force, and a ninth is added:

9. real agent-workload evidence from at least two hosts (one Windows or
   OneDrive, one POSIX) and at least one real repository, showing the PRD
   §13.3 metrics for actual agent sessions rather than synthetic fixtures.

Nothing under Gate B (canonical fact store, wire protocol, gateway, private
draft stacks without a compatibility branch, virtual materialization) may begin
until all nine conditions have an evidence table naming schemas, hosts, and
runs.

### Evidence plan: dogfooding

The ninth condition and the user-value conditions are satisfied by dogfooding:
the maintainer's own coding agents use `vlab` on this repository and on other
real repositories, with telemetry retained per `docs/README.md` and
summarized in an ADR when it supports a decision. The metrics are listed in
PRD §13.3; raw runs are never committed.

### Efficiency definition

"More efficient than Git" (PRD §18) means lower elapsed time per operation and
fewer bytes stored and transferred than plain Git and any named alternative on
the same workload and host, with identical semantic results (NFR-PERF-06,
NFR-PERF-07). Process launches, content reads, and semantic equality remain
the diagnostic units (NFR-PERF-03).

## Constraints

- Git remains the canonical store for bytes, trees, commits, refs, and linked
  worktrees, and the escape hatch, under both gates (ADR-0001 constraints
  unchanged).
- Every efficiency claim reports host, Git version, engine mode, process count,
  bytes, and semantic equality, and is baselined against Git's best mode.
- One synthetic host never satisfies a Gate B condition.

## Consequences

### Positive

- Native engine work can start on measured grounds without pretending the
  user-value conditions are met.
- The conflict between Horizon 1's "stop optimizing" rule and PRD §18 is
  resolved explicitly rather than by exception.
- The sunset makes a failed engine bet cheap and visible.
- Dogfooding gives the laboratory a real workload for the ninth condition.

### Negative

- Two implementations of every read contract exist during Gate A work; the
  equality discipline and its CI cost are mandatory.
- Dogfooding evidence comes from one maintainer's repositories and agents; it
  is real but not representative of other teams.
- The sunset may remove work that was close to its budget.

## Rejected alternatives

- **Keep the single gate as written:** rejected because it cannot be met by a
  laboratory without users and selects no work once batched paths are under
  budget.
- **Drop the user-value conditions:** rejected because they are the product's
  evidence that the semantics matter; performance alone is insufficient
  (roadmap Horizon 5).
- **Begin native work as an unmeasured bet:** rejected because "native rewrite
  begins too early" is a named PRD §16 risk and GP-12 requires evidence from
  the compatibility layer.
- **A kill switch without a sunset:** rejected because a switch that is never
  pulled leaves a permanent second implementation.

## Implementation map

- Gate text, metrics, and efficiency definition: `docs/product.md` §13.3,
  §15, §18
- Phased program that uses these gates:
  [ADR-0015](0015-adopt-a-phased-native-core-program-with-rust.md)
- Roadmap sequencing: `docs/roadmap.md` Horizons 1.5 and 5
- Dated amendment notes: ADR-0001 and ADR-0008 "gate" references now mean
  Gate B
- Engine seam, schema catalog, and Git-best-mode baseline: separate ADRs at
  their phases
