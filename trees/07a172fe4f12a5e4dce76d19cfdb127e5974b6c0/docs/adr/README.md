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
| [0024](0024-close-the-native-read-engine-program-at-phase-0b.md) | Superseded in part by ADR-0027 | Historical closure proposal; wider phases remain gated |
| [0025](0025-retain-the-object-closure-of-published-causal-facts.md) | Accepted | Retain published facts' required Git objects under a shared root without granting target coverage |
| [0026](0026-version-fence-aware-markdown-boundaries.md) | Accepted | Version corrected fenced-code boundaries and preserve verified entity correspondence during migration |
| [0027](0027-bound-native-read-engine-entry-by-the-resolution-catalog-budget.md) | Accepted | Bound native read-engine entry by an explicit resolution-catalog budget and preserved gates |
| [0028](0028-define-target-checkpoint-forecast-semantics.md) | Accepted | Carry a target checkpoint through forecasts and applications as pinned uncommitted context, never as a causal change |
| [0029](0029-require-a-declared-lineage-bridge-for-imports-without-a-shared-root.md) | Accepted | Establish lineage without a shared root only through a declared, locally accepted lineage bridge; content never infers it |
| [0030](0030-define-conflict-policy-for-competing-causal-facts.md) | Accepted | Quarantine identity-conflicted causal facts on both sides, park rather than refuse or overwrite, and resolve only by a declared local disposition |
| [0031](0031-carry-a-bound-source-inventory-for-portable-verification.md) | Accepted | Carry a bound source inventory, compact Git-native proofs, and named anchors so a verifier without the repository reports tiered conclusions and never passes an absence claim |
| [0032](0032-generalize-causal-rebase-to-explicit-linear-ranges.md) | Accepted | Name an explicit rebase range by its base on the current branch; excluded commits are listed and recorded, never proven or dropped silently |
| [0033](0033-advertise-capabilities-as-a-document-negotiated-offline.md) | Accepted | Advertise capabilities as a registry-projected document and negotiate as a pure function of two documents, so every gateway conclusion is reproducible offline |

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
