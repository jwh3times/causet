# Architecture decision records

Architecture decision records (ADRs) capture decisions whose constraints should
survive refactoring and session boundaries. They complement the
[product requirements](../product.md) and the implemented
[architecture](../architecture.md).

**Reading ADRs written before 2026-09-04.** Several cite `docs/roadmap.md` and
locate their scope by horizon — "Horizon 1.5", "Horizon 2 item 1", "Horizon 5".
That document was replaced by the
[project board](https://github.com/users/jwh3times/projects/7) on 2026-09-04,
and its durable content moved to [product.md](../product.md) §15: the native
implementation gates, the evidence rows that permit a next step, the native-core
phase sequence, and the incomplete-requirement trace. The horizon names are left
in place because an ADR's historical rationale is not rewritten; read Horizon 1.5
as program phase 0a, Horizon 2 item 1 as phase 0b, and Horizon 5 as the phase
sequence in §15.

## Status vocabulary

- **Proposed:** under consideration; implementation must not rely on it as an
  accepted constraint.
- **Accepted:** normative until superseded.
- **Deprecated:** still present but should not be used for new work.
- **Superseded:** replaced by a named later ADR; retained for history.
- **Rejected:** considered and deliberately not selected.

## Index

| ADR | Status | Decision |
| --- | --- | --- |
| [0001](0001-use-git-as-the-compatibility-and-storage-substrate.md) | Accepted | Use Git as the compatibility and storage substrate during the laboratory phase |
| [0002](0002-separate-state-change-application-and-landing-identity.md) | Accepted | Separate state, logical change, application, and landing identity |
| [0003](0003-prefer-causal-compact-landings-and-receipt-backed-hard-squash.md) | Accepted | Prefer causal compact landings and require receipts for hard squash |
| [0004](0004-use-an-explicit-coverage-proof-lattice.md) | Accepted | Use an explicit coverage proof lattice and never silently accept heuristics |
| [0005](0005-scope-private-operation-state-to-a-worktree.md) | Accepted | Scope private operation state to a worktree and completed facts to the repository |
| [0006](0006-forecast-and-pin-automated-reconciliation-decisions.md) | Accepted | Forecast and pin automated reconciliation decisions before application |
| [0007](0007-keep-resolution-automation-exact-or-deterministic.md) | Accepted | Keep resolution automation exact or deterministic and expose ambiguity |
| [0008](0008-keep-markdown-canonical-and-spec-metadata-sparse.md) | Accepted | Keep Markdown canonical and specification metadata sparse and derived |
| [0009](0009-use-an-invocation-scoped-git-object-session.md) | Accepted | Use an invocation-scoped, worktree-isolated Git object session |
| [0010](0010-add-a-validated-metadata-envelope-before-a-server.md) | Accepted | Add a validated metadata envelope before a native server or store |
| [0011](0011-model-causal-rebase-as-a-forecasted-application-sequence.md) | Accepted | Model causal rebase as a forecasted application sequence |
| [0012](0012-treat-workspace-lifecycle-as-reversible-materialization-and-drafts-as-checkpoint-inputs.md) | Accepted | Treat workspace lifecycle as reversible materialization and drafts as checkpoint inputs |
| [0013](0013-measure-scan-amplification-before-adding-indexes-or-a-service.md) | Accepted | Measure scan amplification before adding indexes or a service |
| [0014](0014-split-the-native-implementation-gate-into-engine-and-store-gates.md) | Accepted | Split the native implementation gate into engine and store gates |
| [0015](0015-adopt-a-phased-native-core-program-with-rust.md) | Accepted | Adopt a phased native-core program with Rust as the core language |
| [0016](0016-simulate-clean-forecast-steps-with-a-merge-tree-session.md) | Accepted | Simulate clean forecast steps with a merge-tree session behind a flag |
| [0017](0017-commit-a-per-host-benchmark-baseline-with-an-automated-regression-check.md) | Accepted | Commit a per-host benchmark baseline with an automated regression check |
| [0018](0018-disable-git-rerere-inside-vlab-picks-and-landing-merges.md) | Accepted | Disable Git rerere inside vlab's cherry-picks and landing merges |
| [0019](0019-route-every-git-read-through-one-engine-seam.md) | Accepted | Route every Git read through one engine seam with per-operation fallback |
| [0020](0020-freeze-per-family-compatibility-and-resource-bounds.md) | Accepted | Freeze per-family compatibility, migration, and resource bounds |
| [0021](0021-give-failures-a-versioned-machine-readable-envelope.md) | Accepted | Give failures a versioned, machine-readable envelope |
| [0022](0022-reject-git-read-side-maintenance-caches-on-measured-evidence.md) | Accepted | Reject Git's read-side maintenance caches on measured evidence |
| [0023](0023-locate-the-model-substrate-mismatch-in-facts-not-content.md) | Accepted | Locate the model/substrate mismatch in causal facts, not content |
| [0024](0024-close-the-native-read-engine-program-at-phase-0b.md) | Proposed | Close the native read-engine program at phase 0b with a complete outcome |

## Creating or changing an ADR

1. Copy the structure used by an existing ADR.
2. Assign the next four-digit number; never reuse a number.
3. State the context, decision, constraints, consequences, and rejected
   alternatives. Avoid restating an entire implementation plan.
4. Link requirements and code areas affected.
5. If changing an accepted decision, add a new ADR and mark the old one
   `Superseded by ADR-NNNN`; do not rewrite its historical rationale.
6. Add or update tests for any observable invariant.
7. Update this index, `../architecture.md`, and affected product or testing
   documentation when the current system changes. Track active implementation
   instructions in an issue rather than a session handoff document.

An ADR can be accepted in the same commit as its initial implementation when the
decision is already established by tested repository behavior. Speculative
future designs should remain Proposed.
