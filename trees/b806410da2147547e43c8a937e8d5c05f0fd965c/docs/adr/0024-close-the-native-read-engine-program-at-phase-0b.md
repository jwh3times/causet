# ADR-0024: Close the native read-engine program at phase 0b with a complete outcome

- **Status:** Proposed
- **Date:** 2026-09-02
- **Owners:** Repository maintainers
- **Related requirements:** GP-09, GP-12, FR-PERF-02 through FR-PERF-09,
  NFR-PERF-01 through NFR-PERF-07, NFR-PORT-05
- **Related decisions:**
  [ADR-0013](0013-measure-scan-amplification-before-adding-indexes-or-a-service.md),
  [ADR-0014](0014-split-the-native-implementation-gate-into-engine-and-store-gates.md),
  [ADR-0015](0015-adopt-a-phased-native-core-program-with-rust.md),
  [ADR-0019](0019-route-every-git-read-through-one-engine-seam.md),
  [ADR-0022](0022-reject-git-read-side-maintenance-caches-on-measured-evidence.md),
  [ADR-0023](0023-locate-the-model-substrate-mismatch-in-facts-not-content.md)

## Context

ADR-0015 sequenced a phased native-core program and fixed how its phase 0b
ends: "The phase 1 ADR names the Gate A item 3 budget from the phase 0a runs
before any phase 1 code, or the program stops here with a complete outcome."
Phase 0a (roadmap Horizon 1.5) and phase 0b (Horizon 2 item 1) are delivered
and released, in v0.10.0 and v0.11.0. ADR-0014 Gate A items 1 and 2 are
satisfied. Item 3 asks for "a named per-command budget on a representative
Windows or OneDrive host that the batched Git path measurably misses".

This is that decision. It is written from the committed evidence rather than
from a new run, because every run the program has made says the same thing,
and because the roadmap should not keep saying "the phase 1 ADR is the next
decision" while it does.

### The evidence

`benchmarks/baseline.json` (profile `reduced-local-v3`, both hosts recorded
on 2026-09-01 with Git 2.55) is the Git-best-mode baseline Gate A item 2
asked for: batched reads (ADR-0013), the object session (ADR-0009), the
merge-tree forecast engine (ADR-0016), and sparse cones (issue #10) all on.
Its medians against the profile's 1,000 ms interactive budget:

| Phase | Windows | Linux | Git processes |
| --- | --- | --- | --- |
| forecast, merge-tree session, 12 changes | 428 ms | 99 ms | 9 |
| `workspaceCreate` | 403 ms | 108 ms | 2 |
| `metadataStatus` | 398 ms (p95 536 ms) | 56 ms | 12 |
| publication, six changes | 332 ms | 59 ms | 41 on Windows, 57 on Linux |
| `workspaceCreateCone` | 225 ms | 29 ms | 4 |
| `resolutionCatalog` | 181 ms | 20 ms | 6 |
| `workspaceStatus` | 140 ms | 38 ms | 4 |
| `noteCatalog` | 68 ms | 13 ms | 2 |
| `history` | 40 ms | 4 ms | 1 |

Nothing misses. The only figure over the budget anywhere in the baseline is
the forecast through a temporary worktree without an object session (2,203 ms
on Windows), which is not Git's best mode; the merge-tree session is the
Windows default. The one miss the program ever found, `workspace create` at
1,804 ms on a 3,000-file tree, was closed by sparse cones, which is what
phase 0a was for. The publication phase differs in process count by host
only because each host runs its default transport (FR-PERF-08).

### What the evidence also says

The absolute figures are not the whole picture, and this ADR records the
rest so that it is not rediscovered:

- **The cost is process launch, not work.** Process counts, query counts, and
  materialized bytes are identical on the two hosts while wall-clock medians
  differ five- to fifteen-fold. Windows charges roughly 35 to 45 ms per Git
  process regardless of what the process does; `metadata status` at 398 ms is
  about 56 ms of Git work (the Linux figure for the same twelve processes)
  inside some 340 ms of process creation. ADR-0022 reached the same conclusion
  from the other direction: quadrupling history depth changed no phase
  measurably, so traversal is not the bottleneck and Git's own read-side
  caches have nothing to cache.
- **The overhead is `vlab`'s, and an in-process engine is the fix in kind.**
  On the 3,000-file `workspace create` measurement (issue #10) raw Git took
  154 ms and `vlab` 379 ms: 88 ms of Node start-up and module load, roughly
  70 ms of additional Git launches, and about 5 ms of `vlab`'s own
  JavaScript. A native read engine behind the seam removes the launches, not
  the Node start-up. It is the only proposal in the program that attacks the
  dominant cost, and ADR-0022's fixed-cost finding is the premise of its case,
  not evidence against it.
- **Gate A item 3 asks a different question.** It asks whether that overhead
  makes a command miss a budget someone has named, not whether the overhead
  exists. No budget is missed, and the ratio evidence names no consequence a
  user of the tool experiences today: a command that takes 0.4 s instead of
  0.1 s, inside a 1 s budget.

### What has not been measured

No run has placed a repository inside a synced OneDrive folder. The suites,
demos, and benchmarks build every fixture under the OS temporary directory,
which is not synced, and issue #14 keeps "OneDrive path edges" open for that
reason. A synced folder adds the cloud-files filter driver and the sync
client's own I/O to every file operation, and it is the host ADR-0014 item 3
names. That measurement is the first reopening condition below rather than a
precondition of this decision: the decision is reversible by writing the ADR
the measurement would call for, and the documents should say what the
evidence to hand says now.

## Decision

1. The ADR-0015 program stops after phase 0b with a complete outcome. Phases
   1 through 4 (the native read engine in Rust, native planning and status,
   the derived catalog, in-memory forecasts and native mutation) do not open.
   No phase 1 ADR is written, because there is no Gate A item 3 budget for it
   to name.
2. Everything phases 0a and 0b produced stays, and remains the contract a
   future engine would be measured against: the engine seam, its catalog of
   read operations, and the differential (ADR-0019); the `VLAB_ENGINE=native`
   suite mode as the proof that no read bypasses the seam; the schema catalog,
   canonical-JSON profile, compatibility contract, and conformance fixtures
   (ADR-0020); and the per-host Git-best-mode baselines (ADR-0017). None of it
   is removed because the program closed. It costs one refusal-mode suite run,
   and it is what makes the closure reversible.
3. ADR-0014 Gate A stays in force as written. This ADR is reopened, and the
   phase 1 ADR written, when any of the following produces a budget the
   batched Git path misses:
   - a measurement of the Git-best-mode baseline, or of the same commands on
     a real repository, inside a synced OneDrive folder on a Windows host,
     where a phase exceeds the 1,000 ms budget;
   - a real workload, produced under the dogfooding evidence plan of ADR-0014
     and the branch-and-land prerequisite of ADR-0023, whose owner names a
     per-command or per-step budget tighter than the profile's and that the
     measured path misses (an agent harness issuing many `vlab` commands per
     step is the expected shape);
   - a change in Git or in the hosts that raises the per-process floor, shown
     by the regression check of ADR-0017.
4. Gate B is unaffected. The native fact store ADR-0023 identified as the
   Gate B target, and its evidence plan, proceed on their own terms. If either
   gate opens, ADR-0015's language and stack decision (Rust, napi-rs,
   gitoxide and libgit2 behind the Git executable) stands and is not
   re-litigated here.

## Constraints

- The profile's budget stays at 1,000 ms. Lowering it to manufacture a miss
  would satisfy the letter of item 3 and nothing else; that is the "native
  rewrite begins too early" risk of PRD §16 in another form.
- The overhead figures above are cited as what an engine would remove, never
  as a reason one is unneeded.
- Every reopening measurement follows ADR-0014's efficiency definition and
  ADR-0017's method: Git's best mode, identical results, a quiet host,
  medians, process counts, and raw runs in issues rather than in the tree.

## Consequences

### Positive

- The package promise stays "no runtime dependencies, no build step". No
  Rust toolchain, prebuild pipeline, code signing, or three-backend equality
  discipline is taken on to save a few hundred milliseconds nobody has asked
  for.
- One implementation of every read contract; the seam's second implementation
  is a refusal stub, not a moving target.
- The roadmap stops carrying an implicit decision, and the reopening
  conditions are explicit enough that whoever meets one knows what to write.

### Negative

- The Windows process tax remains: interactive `vlab` commands cost roughly
  0.2 to 0.4 s on Windows against under 0.1 s for the same work on Linux, and
  about 2.5 times raw Git on the one command measured against it. Agents that
  issue many commands per step pay it in full.
- Reopening costs an ADR and the measurement it rests on; the program cannot
  resume quietly.

## Alternatives considered

- **Name a budget from the ratio evidence** (for instance "no command over
  twice raw Git's best mode"): rejected as the gate's criterion, because a
  ratio without a consequence is not a budget anyone misses; recorded above as
  the figure to cite when a workload does name one.
- **Open phase 1 as an investment:** rejected. ADR-0014's sunset would remove
  the engine two minor releases later for want of the same budget, at the
  full toolchain cost.
- **Remove the seam, the native mode, and the native stub now that the
  program is closed:** rejected; they are the reopening path and cost little.
- **Wait for the OneDrive measurement before deciding:** rejected as the
  default, because the decision is reversible and the documents should say
  what the evidence says now; recorded as the first reopening condition.

## Implementation map

- Product requirements §15: Gate A item 3 status and this ADR; phase-sequence
  rows 1 through 4 are closed by this ADR until a reopening condition fires.
  (Written against `docs/roadmap.md`, which carried the phase table and the
  decision backlog until the project board replaced it on 2026-09-04; the
  phase 1 backend-matrix question is now conditional on reopening inside
  [issue #18](https://github.com/jwh3times/vcs-lab/issues/18).)
- Issue #14: the synced-folder measurement stays its one open item and is
  also this ADR's first reopening condition.
- No code changes. The seam, the native suite mode, the schemas, and the
  baselines are kept as they are.
