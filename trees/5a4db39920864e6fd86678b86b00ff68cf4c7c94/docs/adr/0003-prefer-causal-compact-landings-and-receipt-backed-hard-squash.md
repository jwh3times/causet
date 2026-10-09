# ADR-0003: Prefer causal compact landings and receipt-backed hard squash

- **Status:** Accepted
- **Date:** 2026-08-20
- **Owners:** Repository maintainers
- **Related requirements:** FR-LAND-01 through FR-LAND-10

## Context

Teams value a compact target history, but a strict squash removes the source
parent. Continued work on that source then appears unrelated to stock Git and
can be replayed during a later back-merge even when most content is already
present.

A conventional merge preserves causality but can make first-parent review noisy
if every feature commit is treated as a landing unit.

## Decision

The recommended landing is **compact merge**: create one conventional
two-parent merge commit and treat it as the single first-parent landing unit.
The source parent remains real Git ancestry.

Support **hard squash** as an explicit compatibility mode. It creates a normal
one-parent squash commit and must attach a landing receipt containing the exact
source head, base, source commits, Change IDs, target-before commit, and result
tree. No receipt is published when the merge does not complete.

Both modes include useful commit trailers, but sideband receipts carry the full
causal record.

## Consequences

### Positive

- Compact history and stock-Git causal correctness coexist in the default.
- Teams that require one-parent squash can recover lost causality in `vlab`.
- Later reconciliation can subtract the absorbed source range.

### Negative

- Hard-squash safety depends on transferring and trusting sideband metadata.
- Stock Git alone cannot interpret the receipt edge.
- Two landing modes increase user choice and documentation surface.

## Alternatives considered

- **Always hard squash:** rejected because it destroys causality unnecessarily.
- **Always expose the full feature topology on first parent:** rejected because
  the product explicitly values compact landing units.
- **Infer absorption from tree/patch similarity later:** rejected because it is
  not an exact intent proof.

## Invariant

A hard-squash receipt describes only an integration that actually completed;
conflict setup or a manually altered unrecorded commit cannot receive one
retroactively without a separately validated operation.
