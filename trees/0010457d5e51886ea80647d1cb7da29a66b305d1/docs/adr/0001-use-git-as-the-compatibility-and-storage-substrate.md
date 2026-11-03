# ADR-0001: Use Git as the compatibility and storage substrate

- **Status:** Accepted
- **Date:** 2026-08-20
- **Owners:** Repository maintainers
- **Related requirements:** GP-01, GP-12, FR-GIT-01 through FR-GIT-08

## Context

The product is exploring a successor source-control model, but Git is the
industry interoperability standard and already provides a mature
content-addressed store, snapshots, refs, worktrees, transfer protocols, merge
machinery, and recovery tools. Replacing all of those while the causal semantics
are still uncertain would combine product research with infrastructure risk and
make adoption depend on migration.

SVN's centralized model made some history and policy questions simpler, but a
mandatory server would discard Git's local autonomy and offline operation.

## Decision

During the laboratory phase, Git remains:

- the canonical store for file bytes, trees, commits, and physical ancestry;
- the compatibility representation for branches, merges, cherry-picks, and
  linked worktrees;
- the mechanism used for ordinary recovery and repository inspection;
- the initial carrier for causal records, retained resolution objects, and
  checkpoints.

`vcs-lab` may add sideband metadata and stronger orchestration, but every v0.x
mutation must leave valid Git objects and a usable repository. A native store,
daemon, gateway, or server requires measured exit criteria and a superseding
ADR.

## Constraints

- Stock Git must remain an escape hatch.
- Exact bytes and parentage are identified by Git OIDs, not receipt IDs.
- Missing `vlab` metadata may reduce causal intelligence but must not make Git
  content unreadable.
- Optimized paths must be equality-tested against ordinary Git behavior.

## Consequences

### Positive

- No repository-content migration is required to experiment.
- Existing editors, forges, hooks, and recovery knowledge remain useful.
- Git provides a correctness oracle while semantics evolve.
- Adoption can be incremental and reversible.

### Negative

- Notes and hidden refs are not transferred automatically by normal branch
  fetches.
- Some desired workspace and causal concepts are awkward compatibility shapes.
- Subprocess and filesystem overhead can dominate on Windows.
- Git's topology remains visible even when a causal plan has a better model.

## Alternatives considered

- **Build a native VCS immediately:** rejected because semantics and adoption
  value are not yet proven.
- **Require a central service:** rejected for the laboratory because it weakens
  offline/local experimentation and adds trust/policy scope prematurely.
- **Store all metadata in tracked files:** rejected because per-operation and
  attachment semantics would pollute project history and cause avoidable merge
  conflicts.

## Reconsider when

The PRD's native implementation gate is satisfied and measured Git constraints
cannot be addressed through batching, explicit metadata transport, or a narrow
gateway.

**Amendment 2026-09-02 (ADR-0023):** this decision is refined rather than
superseded. Going concept by concept through the PRD identity model against the
implementation,
[ADR-0023](0023-locate-the-model-substrate-mismatch-in-facts-not-content.md)
found that every distortion a native store would remove is on the **causal
fact** side — edges with no representation, facts whose identity is their
attachment point, validity inherited from an unrelated object's reachability —
and none on the **content** side. Git stays the substrate for blobs, trees,
commits and ancestry indefinitely, and additionally carries the correctness
oracle every semantics claim rests on. Only the fact substrate is a candidate
for replacement, and only under Gate B.

**Amendment 2026-08-28 (ADR-0014):** the gate named above is Gate B of
[ADR-0014](0014-split-the-native-implementation-gate-into-engine-and-store-gates.md).
A semantics-preserving native engine under Gate A does not reconsider this
decision; a canonical native store
([ADR-0015](0015-adopt-a-phased-native-core-program-with-rust.md) phase 5)
requires the partially superseding ADR named there.
