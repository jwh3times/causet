# ADR-0004: Use an explicit coverage proof lattice

- **Status:** Accepted
- **Date:** 2026-08-20
- **Owners:** Repository maintainers
- **Related requirements:** GP-03, GP-04, FR-PLAN-01 through FR-PLAN-08

## Context

After rewrite or squash, physical ancestry alone under-reports prior work.
Patch equivalence can find likely matches but may normalize away meaningful
context and cannot prove two commits share intent. A planner that presents a
single undifferentiated “already merged” answer would conceal why it made that
decision.

## Decision

Classify every relevant source change as one of:

- **covered:** supported by an exact accepted proof;
- **candidate-equivalent:** similar according to a named heuristic and awaiting
  explicit acceptance;
- **new:** not covered by available evidence.

Current exact evidence includes commit ancestry, a reachable receipt listing
the commit, a target-history stable Change ID, or a reachable receipt listing
the Change ID. `git cherry` patch equivalence remains a named advisory proof.

The plan must show physical and effective causal bases, each change's proof,
and summary counts. Only receipts reachable from the target may contribute
coverage. Candidate equivalence may enter a queue only through an explicit
`--accept-candidates` decision recorded in the operation/forecast.

## Consequences

### Positive

- Users can audit why work is suppressed.
- New exact proof types can be added without pretending all evidence is equal.
- Heuristics remain useful without becoming a data-loss mechanism.

### Negative

- Plans are more verbose than a binary merged/not-merged result.
- Stable IDs and receipts can still be false claims until a trust layer exists.
- Proof precedence and schema compatibility require governance.

## Alternatives considered

- **Git ancestry only:** rejected because it recreates the squash/rewrite
  failure the product is meant to address.
- **Patch ID as automatic coverage:** rejected because similarity is not causal
  proof.
- **Tree equality as coverage for every source change:** rejected because equal
  final state does not identify which intents or intermediate effects were
  incorporated.

## Invariant

No heuristic or probabilistic result may silently move a change from “new” to
“covered.”
