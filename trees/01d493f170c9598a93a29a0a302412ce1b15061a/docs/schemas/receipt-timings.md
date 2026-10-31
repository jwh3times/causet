# Receipt timing scope

`vcs-lab.reconciliation/v6` and `vcs-lab.rebase/v1` retain their existing
`timings` meaning: measurements accumulated before the receipt is published.
They do not report the cost of the entire command. This clarifies the existing
records without changing accepted values, writer behavior, or schema versions.

| Member | Measurement boundary |
| --- | --- |
| `activeApplicationMs` | Sum of recorded active application spans. An initial span starts at queue entry; a successful continuation span starts in the continuation handler, before its checks and resolved pick. Spans end when the queue pauses or finishes, before finalization. User time between invocations is excluded. |
| `elapsedWallMs` | Wall-clock difference between the operation's persisted `startedAt` and receipt construction. Includes time paused for human resolution and work before receipt construction; excludes subsequent publication and cleanup. It is neither active CPU time nor full command latency. |
| `git` | Accumulated metrics from the Git measurement scopes opened inside application-queue calls and closed when those calls pause or finish. Includes only work observed inside those scopes. A null value means unavailable metrics, not a zero-cost operation. |

The active-duration and Git scopes are different. On `--continue`, checks,
resolution capture, `git cherry-pick --continue`, and recording that resolved
application happen before queue entry. A successful continuation includes that
time in `activeApplicationMs`, but its pre-queue Git work is absent from
`timings.git`. Failed continuation attempts that never reach the queue do not
record an active span through that queue.

Planning precedes application measurement. Final result-object lookup and
forecast verification happen after the queue's metric scope closes. Receipt
construction then snapshots the accumulated values before resolution and
application records, carried provenance, and the receipt itself are published.
Clearing the operation journal happens later as well. Those costs must not be
inferred from `timings.git` or `activeApplicationMs`.

For example, the receipt for a six-change reconciliation can report the
queue's Git processes while a full invocation trace counts additional processes
for planning and publication. This difference is expected; the receipt's
`timings.git.processes` is not a full-command regression budget. Resuming in another
invocation accumulates recorded queue metrics across the operation, while a
trace measures the invocation that produced it.

Use `VLAB_TRACE=1` to observe whole-invocation Git process starts, and an external
elapsed-time measurement for end-to-end latency. The
[benchmark publication phase](../testing.md#benchmark-regression-check) uses
the trace and checks published record counts. Trace process counts do not
themselves provide a whole-command logical-query breakdown.

The boundaries are implemented by `runReconciliationQueue` and
`finalizeReconciliation` in [operations.js](../../src/operations.js), and
`runRebaseQueue` and `finalizeRebase` in
[rebase-operations.js](../../src/rebase-operations.js). Any future expansion to
full-command receipt metrics needs an explicit versioned contract rather than
silently changing these fields' meaning.
