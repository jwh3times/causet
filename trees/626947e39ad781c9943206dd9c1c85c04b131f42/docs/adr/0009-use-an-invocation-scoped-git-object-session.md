# ADR-0009: Use an invocation-scoped Git object session

- **Status:** Accepted
- **Date:** 2026-08-20
- **Clarified:** 2026-08-24
- **Owners:** Repository maintainers
- **Related requirements:** GP-09, GP-12, FR-PERF-01 through FR-PERF-10

## Context

On the measured Windows environment, starting a Git process often costs
80–130 ms. Planning and forecasting perform many immutable object queries, so
process startup can dominate wall time. Converting all synchronous domain code
to asynchronous streaming or introducing a resident daemon would add broad
complexity before the remaining need is measured.

Linked worktrees also make a repository-global cache unsafe for expressions
that depend on private `HEAD`, index, or in-progress state.

## Decision

Use an optional, invocation-scoped `git cat-file --batch-command` process:

- enabled by default on Windows and explicitly selectable elsewhere;
- owned by a worker thread so the domain API remains synchronous;
- started lazily at the first uncached object request, after ordinary preflight
  Git commands complete;
- keyed to the exact resolved worktree path;
- used for immutable object `info` and `contents` queries;
- caching only expressions rooted at a complete SHA-1/SHA-256 OID;
- invalidated after successful mutation;
- closed at invocation end after the Git child's stdio-drained `close` event,
  with bounded exact-tree termination on Windows;
- required to fall back to ordinary Git after failure.

Also reduce query structure independently: batch histories, note-object reads,
and related revision/tree lookups.

## Consequences

### Positive

- Large reductions in Windows process launches without changing domain APIs.
- No resident background lifecycle, cross-command lock, or service security
  boundary.
- Ordinary Git remains fallback and comparison oracle.
- Metrics can distinguish logical work from process creation.
- Synchronous preflight and asynchronous worker startup do not overlap.

### Negative

- Worker/shared-memory protocol adds complexity and bounded buffer limits.
- Each object-reading CLI invocation still pays one worker/process startup.
- Non-Windows environments may see little or negative wall-time benefit.
- Mutable symbolic queries cannot safely use the immutable cache.

## Alternatives considered

- **One Git process per query:** retained as fallback but too expensive on the
  measured Windows path.
- **Make the entire CLI asynchronous:** rejected as unnecessary churn for this
  experiment.
- **Resident repository daemon:** deferred until measurements show material
  cross-command benefit after batching and its lifecycle/security model is
  specified.
- **Repository-global session across worktrees:** rejected because symbolic and
  index state is worktree-private.

## Invariant

Enabling or disabling the session may change metrics and duration, but must not
change the plan, decision set, predicted tree, result tree, or receipts.
