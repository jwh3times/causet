# ADR-0028: Define target-checkpoint forecast semantics

- **Status:** Accepted
- **Decided:** 2026-09-17
- **Date:** 2026-09-14
- **Owners:** Repository maintainers
- **Implementation:** [#26](https://github.com/jwh3times/vcs-lab/issues/26)
- **Related:** [#28](https://github.com/jwh3times/vcs-lab/issues/28),
  [ADR-0006](0006-forecast-and-pin-automated-reconciliation-decisions.md),
  [ADR-0011](0011-model-causal-rebase-as-a-forecasted-application-sequence.md),
  [ADR-0012](0012-treat-workspace-lifecycle-as-reversible-materialization-and-drafts-as-checkpoint-inputs.md)

## Context and decision

ADR-0012 shipped immutable source-checkpoint forecasts and deferred the target
side: a forecast's target is always a committed workspace head, and the target
worktree's own uncommitted draft is reported only as an ignored dirty-file
count. Open product question 6 asks whether that model should extend to a
captured target overlay, and #28 may not start until the target contract is
settled in writing. The five questions #26 names are answered below.

Decide that a **target overlay** is one immutable target checkpoint, pinned
by commit identity, that a forecast carries through an application as
**uncommitted context** and never as a causal change. The committed
prediction stays exactly what a committed-heads forecast predicts today; the
overlay adds a second pinned prediction, the target worktree after the overlay
is re-materialized onto the new committed head. Application may mutate the
committed target only with the source changes it forecast. It never commits
the overlay, and no receipt ever names an overlay.

## Evidence

Observed on 2026-09-14 in a disposable repository with two workspaces,
`target` and `source`, using the current tree. Transcripts are retained with
the session evidence, not committed.

| Situation | Command | Observed |
| --- | --- | --- |
| Clean target, source checkpoint | `vlab workspace forecast target source --source-checkpoint` | Scope `source-checkpoint`; `sourceHead` is the checkpoint commit; `targetHead` is the committed head; complete |
| Target worktree dirty (one modified, one untracked file) | Same | `ignoredTargetDirtyFiles` is 2; fingerprint and predicted tree identical to the clean run; target status unchanged afterwards |
| Target holds its own checkpoint | Same | Forecast identical again; the target checkpoint is never read and the comparison record has no target checkpoint field |
| Apply while the target is dirty | `vlab reconcile <checkpoint> --use-forecast <id>` | Refused with `dirty-worktree` before any mutation |
| Apply after cleaning the target | Same | The source draft lands as a commit carrying its `draft_` Change-Id; the target's own checkpoint is now behind the moved head and forecasting it reports `stale-input` |
| Source checkpoint ref replaced after the forecast | Apply with the earlier checkpoint commit | Accepted; the forecast pins the checkpoint commit and the history ref retains it |
| Source head moves after the checkpoint | Apply, then forecast again | `stale-forecast`, then `stale-input` |
| Target head moves after the forecast | Apply | `stale-forecast` |
| Paused application | `vlab reconcile --abort` | Restores the exact committed tip; checkpoint refs untouched; no receipts published |

Two facts shape the contract. Staleness is already an exact object-identity
decision on both sides, and a replaced ref does not invalidate a forecast that
pinned the commit behind it. A checkpoint enters committed history today in
exactly one way: as a source change another workspace reviewed and applied.

## The contract

### Target overlay identity

A target overlay is one `vcs-lab.checkpoint/v1` commit of the target
workspace whose recorded base equals the target's committed head. It is
identified by that checkpoint commit OID, never by the checkpoint ref, which
may be replaced. The overlay's `draft_` identity is recorded for display and
audit only; it is not a plan entry, not a coverage input, and not a receipt
subject. The plan, its fingerprint, and the committed predicted tree are
computed against the committed target head exactly as without an overlay.

The forecast gains a distinct scope for each overlay combination, a pinned
`targetOverlay` block (checkpoint commit, tree, base head, draft identity),
and a second predicted tree: the worktree tree after the overlay is
re-materialized by a three-way merge of the target tree before application,
the committed result tree, and the overlay tree. An overlay that does not merge
cleanly blocks the forecast with its own reason; live bytes are never merged.

### Approval

A target overlay is selected only explicitly, by a `--target-checkpoint`
option on `vlab forecast` and `vlab workspace forecast`, mirroring
`--source-checkpoint`. `--use-forecast <id>` remains the single approval
event and approves both predictions at once. Approval is recorded against the
overlay checkpoint commit OID inside the forecast. The human-readable forecast
must state the overlay, its tree, and that it will be re-materialized
uncommitted, so the approval is informed. Nothing captures a checkpoint
implicitly on the user's behalf.

### Staleness

Everything a forecast pins today stays pinned. In addition the overlay
checkpoint commit, its tree, its base head, and the predicted
re-materialized tree are pinned. Application refuses before mutation, with
the existing `stale-forecast` code, when the overlay base differs from the
current target head or the checkpoint object is unavailable. It refuses with
a new `stale-overlay` code when the target worktree's live tree, written
through the same temporary index that captures a checkpoint, is not
byte-identical to the overlay tree. Ignored files are outside both trees and
do not participate. A newer target checkpoint does not by itself stale the
forecast; the live-tree check decides. The remedy is always the same: capture
a new checkpoint and forecast again.

### Abort

The reconciliation journal records the overlay checkpoint commit. Abort
restores the exact committed tip as today, then re-materializes the overlay
tree onto the worktree, including its untracked files, so the worktree
returns to the state the user captured. Abort never deletes a path absent
from both the overlay tree and the committed tree, and never touches ignored
files. If the journal names an overlay whose object is unavailable, abort
restores the tip, reports the overlay as unrecoverable, and leaves the
worktree clean rather than inventing bytes.

### Whether application may mutate the committed target

Application mutates the committed target exactly as a committed-heads
application does: the forecast source changes land as commits and receipts.
The overlay never enters committed history through this path. Before the
first cherry-pick the worktree is reduced to the committed head, with the
overlay already safe in its checkpoint; after the committed result tree
verifies, the overlay is re-materialized and its tree verified against the
pinned prediction; only then are receipts published and the journal cleared.
A re-materialization mismatch leaves the operation in the existing
`forecast-mismatch` state with abort as the recovery, and publishes nothing.

### What #28 may assume once this is accepted

A draft rides along a causal rebase the same way: pinned as an overlay, kept
uncommitted, re-materialized onto the rewritten tip with a predicted tree,
and absent from every application and summary receipt. A checkpoint becomes
a commit only as a reviewed source change, never as an overlay, so #28 does
not need to define what a receipt claims about an uncommitted state. It
claims nothing.

## Rejected alternatives

- **Commit the target checkpoint first, then apply the source.** Rejected.
  It turns the owner's private draft into a `draft_` commit on their own
  compatibility branch without their commit decision, which ADR-0012 already
  rejected as erasing the committed/private distinction, and it makes the plan
  fingerprint depend on the draft.
- **Simulate the source onto the overlay tree and commit the results.**
  Rejected. The resulting commits would carry draft bytes inside causal
  changes, and receipts would attest trees containing unreviewed content.
- **Autostash the live worktree.** Rejected by ADR-0012; restated here
  because it is the obvious shape. Live bytes cannot be pinned or approved.
- **Apply an exact resolution to an overlay conflict.** Deferred. Resolution
  memory attests conflicts between committed changes; extending it to
  uncommitted context needs its own signature evidence. A conflicting overlay
  blocks in this version.
- **Keep refusing dirty targets forever.** Not selected as the answer, but it
  remains the default: without `--target-checkpoint`, nothing changes.

## Consequences

- Forecast, reconciliation-operation, and rebase-operation schemas need new
  versions registered under ADR-0020, each a strict superset of the current
  one. Old forecasts keep their scope and stay readable.
- One new error code (`stale-overlay`) and one new blocked reason for a
  conflicting overlay enter the failure envelope of ADR-0021.
- Application gains two worktree phases, reduction and re-materialization,
  that must be journaled and covered by fault-point tests like the existing
  phases.
- Acceptance evidence, when implemented: a repeated overlay forecast yields
  the same fingerprint, committed tree, and re-materialized tree; application
  reproduces both; a moved head, a moved draft, and a missing object each
  refuse before mutation; abort restores committed tip and overlay bytes;
  receipts and envelopes are byte-identical with and without an overlay.

## What the owner must decide

1. Accept the overlay-as-uncommitted-context model over committing the draft
   first.
2. Confirm that an overlay conflict blocks in this version rather than
   consulting resolution memory.
3. Confirm the apply-time live-tree equality rule and its refusal, instead of
   an implicit re-capture.
4. Confirm that both `vlab forecast` and `vlab workspace forecast` carry the
   option with identical semantics.
5. Confirm that #28 inherits this contract unchanged for the rebase journal.

## Owner decision (2026-09-17)

Accepted as written. The owner accepted all five decisions above: the overlay
is uncommitted context rather than a committed draft; an overlay conflict
blocks in this version; application requires the live tree to equal the
overlay tree and refuses with `stale-overlay` rather than re-capturing;
`vlab forecast` and `vlab workspace forecast` carry `--target-checkpoint`
with identical semantics; and #28 inherits this contract unchanged.
