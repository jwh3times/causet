# ADR-0027: Bound native read-engine entry by the resolution-catalog budget

- **Status:** Accepted
- **Date:** 2026-09-14
- **Owners:** Repository maintainers
- **Implementation:** [#83](https://github.com/jwh3times/vcs-lab/issues/83)
- **Related:** [#18](https://github.com/jwh3times/vcs-lab/issues/18),
  [#42](https://github.com/jwh3times/vcs-lab/issues/42),
  [ADR-0014](0014-split-the-native-implementation-gate-into-engine-and-store-gates.md),
  [ADR-0015](0015-adopt-a-phased-native-core-program-with-rust.md),
  [ADR-0019](0019-route-every-git-read-through-one-engine-seam.md),
  [ADR-0024](0024-close-the-native-read-engine-program-at-phase-0b.md)

## Context and decision

The maintainer named a target of no worse than 110% of equivalent Git work,
excluding Node startup until a native CLI exists. This changes the premise of
ADR-0024's proposed closure, which assessed an absolute 1,000 ms budget. The
identified Windows baseline and post-#73 measurements supply a candidate miss;
the decision no longer depends on a OneDrive experiment.

Accept a bounded first increment of phase 1: native reads serving
the resolution catalog, with all validation and selection still performed by
the existing JavaScript domain code. The maintainer accepted this scope for #18.
This replaces ADR-0024's closure proposal for this increment only and permits
implementation after the dependency review below. Phase 1's wider exit criteria
remain unmet, and phases 2–6 retain their own gates.

## Evidence supporting the decision

The [post-#73 measurement](https://github.com/jwh3times/vcs-lab/issues/73#issuecomment-5657461091)
used the quiet identified `lab-windows-a` host, Node v26.4.0, Git
2.55.0.windows.3, platform defaults, and `reduced-local-v3` with three samples.
Source candidate `7bfe84e` subsequently passed full Windows/Ubuntu qualification.
These figures explain the decision; the issue retains run evidence and the
committed baseline remains the automated regression reference.

| Phase | vlab median | Git reference median | Ratio | Git processes, vlab/reference |
| --- | ---: | ---: | ---: | ---: |
| History | 47.33 ms | 45.83 ms | 103% | 1 / 1 |
| Git worktree list | 45.53 ms | 46.10 ms | 99% | 1 / 1 |
| Workspace status | 169.50 ms | 187.83 ms | 90% | 4 / 4 |
| Note catalog | 85.70 ms | 85.77 ms | 100% | 2 / 2 |
| Resolution catalog | 123.10 ms | 75.84 ms | 162% | 2 / 2 |
| Metadata status | 504.43 ms | 400.33 ms | 126% | 7 / 6 |
| Workspace creation | 501.48 ms | 359.78 ms | 139% | 2 / 1 |
| Sparse workspace creation | 252.65 ms | 191.03 ms | 132% | 4 / 3 |

At the measured resolution-catalog floor, 110% is 83.424 ms: a 39.676 ms
reduction, about 32% of current vlab time, would be required. This is the selected
budget, not a prediction of native performance. Process equality after #73 does
not explain the remaining latency or prove that a binding will remove it.

The reduced synthetic fixture establishes a miss on the named host; it does not
establish representative real-repository workload performance. The maintainer
accepted this bounded workload for the Gate A experiment. #42 retains
the broader workload and budget-ratification work. Earlier 189% workspace-create
arithmetic is historical corroboration, not the current acceptance benchmark.

## Comparison and allowance policy

The numerator is the complete in-process phase, including binding initialization,
repository discovery, validation, and conversion back to JavaScript. Do not
subtract Node startup again: both existing phase and floor timers already exclude
it. Also report whole CLI time to expose costs that the phase timer cannot see.

The resolution-catalog denominator stays the published `for-each-ref` plus
batched object-read floor in `src/scale-benchmark.js`. It is a Git data-acquisition
reference, not an implementation of vlab's validation semantics. The numerator
continues to pay for identity, signature, dependency, quarantine, and retained
result checks. Native-versus-Git-engine output equality is a separate obligation;
matching the raw floor's object count cannot satisfy it.

No additional allowance is granted. Metadata inventory and workspace creation
also do work their raw Git references omit, including validation, registries,
identity, and checkpoints. Their ratios stay visible, but they are not additional
phase-1 exit targets. Any future allowance needs an explicit owner decision naming
the operation, mandatory extra work, units, evidence, and limit; it cannot be
retroactively inferred from a miss. The registry-only phase still has no Git
equivalent. The existing 2x regression tolerance is not the 110% target.

## First increment and backend boundary

Retain ADR-0015's Rust core and optional in-process napi-rs binding choice.
This matrix names candidate implementations, not verified crate capabilities:

| Existing engine operation | Candidate backend | Required boundary |
| --- | --- | --- |
| `repoContext` | Rust/gitoxide | Correct worktree/common-dir identity and paths; unsupported layouts fall back |
| `listRefs` | Rust/gitoxide | Files-backend loose/packed refs, stable ordering, dangling-ref behavior |
| `inspectGitObjects` | Rust/gitoxide | Batched existence/type/size, commit peeling and tree-path expressions |
| `readGitObjects` | Rust/gitoxide | Batched bytes, order and missing-object behavior, existing resource bounds |
| `listNoteEntries` | Rust/gitoxide | Git-equivalent fanout/order and complete fallback for unsupported notes trees |
| Every other cataloged read operation | Existing Git engine | Explicit per-operation fallback; no second domain implementation |
| All mutations and publication | Existing Git executable path | No native writes, receipt publication, or ref transactions |

Start with files-backend SHA-1 repositories; unsupported ref/object formats,
layouts, expressions, or native failures route through existing Git fallback.
SHA-256 and reftable remain supported by that fallback, without native coverage
claims. Do not load libgit2 for this read-only increment. No native CLI, persistent
catalog, resident service, new store, or jj-lib integration is needed to answer
this bounded performance question. The wider ADR-0015 investigation stays gated.

Before implementation, pin and review candidate dependency versions, supported
operations, licenses/attribution, and the Windows/Ubuntu prebuild/toolchain matrix
on #18 or its implementation issue. Reuse ADR-0015's safe-core/FFI boundary and
native-parser fuzzing requirements. A missing prebuild must leave the package
fully usable through Git; packaging costs cannot be hidden from the decision.

## Acceptance, stop rule, and sunset

The maintainer accepted the host, workload, denominator, 110% limit,
first-increment scope, and retained gates together. The implementation issue must
record the dependency matrix and bounded work before native code starts.

Before shipping the first increment:

- Show a genuinely available backend and executed native operations. Today's
  `native` mode always reports `binding-missing`; green suites qualify only the
  seam and fallback until this changes.
- Preserve byte-identical domain JSON, errors, ordering, quarantine, and missing
  object behavior against the Git engine. Include linked worktrees, ref movement,
  packed/loose objects and refs, duplicate notes, malformed/oversized inputs,
  unsupported-profile fallback, and binding failure. No partial catalogs.
- Pass all six functional modes on Windows and Ubuntu, plus the Node 20 floor;
  supported-profile tests must assert native execution rather than pass entirely
  through fallback. Assert zero Git child processes in the supported catalog
  phase, and retain fallback tests that deliberately use Git.
- On the quiet matching `lab-windows-a` host, run three independent checks with
  at least nine samples per phase/reference. Alternate which side is timed first
  across checks to expose ordering/cache bias. Each check must meet
  `median(native phase) <= 1.10 * median(Git reference)` with identical catalog
  results. Retain raw samples, p95, profile, build/toolchain, execution/fallback
  metrics, and whole CLI times on the issue. Do not replace the denominator with
  the historical 75.84 ms constant or re-record the regression baseline to pass.
- Verify no writes to protected refs/worktrees, `git fsck`, no lingering workers,
  and full functionality with the binding removed. Any derived cache must be
  invocation-scoped and keyed by immutable identity; deleting it changes no result.

If the bounded attempt misses the target, record the result and keep Git as the
delivered engine. Further tuning or scope expansion requires a new explicit
decision; a miss does not automatically authorize phases 2–4. Passing this
increment does not claim completion of ADR-0015's broader phase-1 exit criteria.

ADR-0014's sunset remains: if the shipped engine has not met its named budget
with identical results within two minor releases after first shipping, remove
the binding from the package. Record that first version and deadline when it
ships; removing the binding preserves the seam, schemas, and Git baseline.
The pre-shipment check above is stricter than relying on the sunset alone.

## Alternatives and retained gates

Keeping ADR-0024's no-budget-miss conclusion ignores the newly named ratio target.
Opening the entire native program now assumes an unmeasured benefit and broadens
the commitment beyond the evidence. Waiting for OneDrive would not resolve the
already observed miss. The bounded catalog increment is the smallest read-only
test of the proposed in-process benefit, with an explicit failure outcome.

#14 still owns synced-folder behavior. #19/#41 still require real workflow and
POSIX participation. #42 still owns wider representative budgets. #68's
Windows-only release-latency scope does not waive functional POSIX support or
any Gate B evidence requirement. All canonical storage, protocol, gateway,
private draft-stack, and native mutation decisions remain gated.
