# ADR-0006: Forecast and pin automated reconciliation decisions

- **Status:** Accepted
- **Date:** 2026-08-20
- **Owners:** Repository maintainers
- **Related requirements:** GP-05, FR-REC-01 through FR-REC-12

## Context

A reconciliation may contain many source changes and resolution decisions.
Discovering conflicts only after mutating the user's branch makes review and
automation difficult. Re-running a preview by branch name is unsafe because
heads, receipts, or resolution catalogs may change between review and apply.

## Decision

Provide a non-mutating forecast in a disposable detached worktree. Pin:

- exact source and target heads/trees;
- the complete causal plan and fingerprint;
- candidate-equivalence policy;
- every exact resolution signature, record ID, and result blob;
- every deterministic spec input signature and output hash;
- step trees and the final predicted result tree when complete.

The caller's `HEAD`, index, and working files are invariants checked before and
after simulation. `--use-forecast <id>` is the approval event. Application
rebuilds the plan, verifies every decision, and must reproduce a complete
forecast's final tree before publishing receipts.

## Consequences

### Positive

- Humans and agents can review a whole operation before mutation.
- A named approval cannot drift silently with a branch.
- Exact decisions can be batch-applied safely when inputs remain identical.
- Forecast output becomes a performance and correctness artifact.

### Negative

- Temporary worktree setup and duplicate application cost time and disk I/O.
- Forecasts are private local records and can become stale quickly.
- A blocked early step prevents prediction of later state without inventing a
  choice.

## Alternatives considered

- **Dry-run against the current index:** rejected because it risks caller state
  and cannot isolate a multi-step sequence cleanly.
- **Approve a branch name or conflict path:** rejected because neither pins
  content.
- **Automatically use any exact resolution at reconciliation time:** rejected
  because exact inputs do not imply the user wants that result in this run.

## Invariant

No forecast approval may authorize a decision whose source commit, target
context, signature, selected record, or predicted output differs at apply time.
