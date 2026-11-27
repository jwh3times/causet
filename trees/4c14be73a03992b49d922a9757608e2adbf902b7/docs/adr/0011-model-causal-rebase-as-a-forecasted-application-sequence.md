# ADR-0011: Model causal rebase as a forecasted application sequence

- **Status:** Accepted
- **Date:** 2026-08-21
- **Owners:** Repository maintainers
- **Related requirements:** FR-ID-02 through FR-ID-05, FR-LAND-09, FR-PLAN-01 through FR-PLAN-06, FR-REC-02 through FR-REC-10

## Context

The prototype preserves a logical `Change-Id` through direct cherry-pick and
uses receipt-backed planning to avoid replaying work already absorbed by a hard
squash. Reconciliation can preview and apply a reviewed queue with pinned
inputs, exact resolution decisions, durable conflict recovery, and delayed
receipt publication.

Rebase does not yet have that product model. Users may run ordinary Git rebase,
and a retained `Change-Id` can make the rewritten commit recognizable later,
but there is no operation that:

- explains which source changes will be omitted, replayed, or require review;
- records the exact origin-to-rewritten-commit mapping;
- predicts and pins the final tree before branch mutation;
- prevents Git's patch heuristics from silently dropping uncertain work;
- distinguishes a target-context adaptation from an intentional fork; or
- recovers a multi-step rewrite without publishing partial causal claims.

Calling the existing reconciliation operation “rebase” would also be
misleading. Reconciliation integrates a source into the current target. Rebase
replaces the current branch's base and rewrites that branch's selected changes.
They can share mechanics without collapsing those user-visible meanings.

## Decision

Model a causal rebase as an ordered sequence of target-context applications
whose result replaces the source branch tip. Reuse the accepted coverage proof
lattice, forecast guarantees, exact-resolution rules, and worktree-private
recovery model. Give rebase its own versioned plan, forecast, operation, and
summary schemas; version the application schema rather than silently extending
an existing record shape.

### User-facing flow

The proposed commands are:

```text
vlab rebase-plan <onto> [<source>] [--json]
vlab rebase-forecast <onto> [<source>] [--accept-candidates] [--json]
vlab rebase <onto> [--accept-candidates] [--use-forecast <id>] [--json]
vlab rebase --status [--json]
vlab rebase --continue [--fork] [--json]
vlab rebase --abort [--json]
```

`source` defaults to the current branch for planning and forecasting. Rebase
execution operates only on the current local branch in v1. It requires a clean
worktree, a named branch, and no other VCS Lab or Git replay operation in that
worktree. Planning and forecasting may inspect another source without switching
the caller.

The v1 sequence is deliberately non-interactive and linear. Merge commits,
`--rebase-merges`, arbitrary `--onto <newbase> <upstream>` ranges, edit/reword,
squash/fixup, and dirty-worktree overlays remain ordinary Git workflows until
they receive separate causal semantics.

### Plan and replay selection

Resolve the exact source tip and `onto` commit, then classify the chronological
source range against receipts reachable from `onto`:

- **covered:** omit from replay only with an accepted exact proof;
- **candidate-equivalent:** block by default; omit only through the explicit
  `--accept-candidates` decision recorded in the forecast/operation;
- **new:** replay in source order.

The plan reports the physical merge base, effective causal base, source and
target trees, proof for every change, the selected replay queue, and a stable
fingerprint. A moved source or target makes a saved forecast stale.

An application that unexpectedly becomes empty is not silently skipped. It is
a blocked decision unless the plan already classified it as covered or the
user explicitly accepts equivalence through a future named skip/accept action.
That action must be recorded; Git's patch-already-upstream heuristic alone is
not an exact coverage proof.

### Identity and completed receipts

For every replayed commit:

- a clean same-intent rewrite preserves its `Change-Id`;
- a conflict adaptation preserves the ID and records contextual application;
- `vlab rebase --continue --fork` creates a new `Change-Id`, adds
  `Derived-From` and exact origin trailers, and records changed intent;
- a commit without a `Change-Id` remains an exact `git:<oid>` fallback. Rebase
  does not invent a stable identity for it; its application receipt maps the
  exact old and new commit OIDs.

After complete success, publish one application receipt per replayed change and
one rebase summary receipt attached to the final tip. The summary includes:

- operation and optional forecast ID;
- source branch, exact source tip before rewrite, exact `onto`, physical base,
  and effective causal base;
- plan fingerprint and candidate policy;
- exact covered omissions and their proofs;
- explicitly accepted candidates;
- ordered origin/result application mappings and any forks;
- source, target, per-step, and final tree OIDs; and
- active and elapsed timing plus Git metrics.

Explicit forks do not establish coverage for the original logical change.
Completed rebase/application records are repository-shared causal facts and
must participate in metadata validation and validated envelope portability.
No application or summary receipt is published until the entire operation and
any predicted final tree have been verified.

### Forecast and approval

`rebase-forecast` uses a disposable detached worktree and the exact replay
queue. It pins:

- source tip, `onto` commit, and their trees;
- full classified plan, fingerprint, and candidate decisions;
- each source commit, target-before tree, exact conflict signature, selected
  resolution record/result blob, and deterministic spec result;
- each step result tree and the final predicted tree when complete; and
- caller HEAD, index, status, and worktree-list invariants.

The forecast is worktree-private. `--use-forecast` is the approval event.
Execution rebuilds the plan, rejects stale inputs before mutation, revalidates
every automated decision, and refuses receipt publication if the final tree
differs. A forecast remains optional for a manually supervised rebase, as it is
for reconciliation; using automated batch resolutions requires their exact
pinned approval.

### Execution and recovery mapping

Implement v1 as an explicit replay queue using ordinary Git cherry-pick
plumbing, because it provides exact per-step origin/result mapping and permits
covered commits to be excluded before mutation. The resulting branch shape is
the ordinary linear shape produced by rebase even though the controlled
sequencer is owned by VCS Lab.

The worktree-private rebase journal records the original branch name and tip,
exact `onto`, queue, current step, approvals, provisional application records,
and expected Git state. During a conflict, ordinary `git status`, file edits,
`git add`, and resolution inspection remain usable. Continuation and abort go
through `vlab rebase` so the causal journal and Git state advance together.

Abort first delegates active cherry-pick cleanup to Git, then verifies and
restores the exact original branch tip, clears private state, and publishes no
receipts. If a user runs an out-of-band Git continue/skip/abort, the next VCS
Lab command must detect the journal/Git mismatch and fail closed. It may offer
explicit abort/recovery, but it may not infer or publish an application record
from ambiguous state.

This provides ordinary Git observability and an escape hatch without claiming
full interoperability with Git's native rebase sequencer in v1.

## Expected consequences

### Positive

- Users can review why each change is omitted or replayed before rewriting.
- Hard-squash history does not force already absorbed work through rebase.
- Rewritten commits gain exact origin/application provenance beyond trailers.
- Forecast, resolution, spec, staleness, and abort invariants stay consistent
  with reconciliation.
- Stock Git still sees ordinary commits, trees, branches, and conflict files.

### Negative

- The first implementation is not interactive rebase and does not preserve
  merge topology.
- A custom replay queue differs operationally from Git's native rebase
  sequencer, especially for out-of-band continue/skip commands.
- Per-step and summary receipts increase shared metadata volume.
- Replaying commits twice for forecast and application costs time and disk I/O.
- A branch mutates step by step during supervised execution; safety is
  recoverable through the journal and exact abort, not whole-operation Git ref
  atomicity.

## Alternatives considered

- **Treat ordinary Git rebase plus preserved trailers as sufficient:** rejected
  because it cannot explain omissions, pin a forecast, or publish exact
  application provenance.
- **Alias rebase to reconciliation:** rejected because integration into a
  target and replacement of a source branch are different user operations.
- **Drive Git's native interactive rebase sequencer in v1:** deferred because
  todo editing, autoskip behavior, merge preservation, and per-step result
  capture expand the contract before the causal user model is proven.
- **Build the rewritten chain in a temporary worktree and atomically update the
  branch:** attractive for complete automated forecasts, but insufficient for
  a supervised conflict workflow where the user must resolve in the owning
  worktree. It may become an optimized mode later.
- **Automatically drop patch-equivalent or empty commits:** rejected because a
  heuristic must not silently become causal coverage.

## Acceptance evidence

The user accepted this model and bounded scope on 2026-08-21. The first
read-only vertical slice implements deterministic `rebase-plan` classification,
receipt-backed omission, heuristic review, linear-history diagnostics, and
caller non-mutation. The second vertical slice implements
`vcs-lab.rebase-forecast/v1`: it reuses isolated exact/spec-aware replay,
persists private plan/candidate approval evidence, pins target-before and result
trees, verifies caller branch/HEAD/index/status/worktree-list invariants, and
fails closed on unaccepted candidates, conflicts, and unsupported topology.
Repeated integration forecasts produce the same fingerprint, step trees, and
predicted tree. The supervised application slice now proves:

1. clean replay preserves stable IDs and publishes exact application/summary
   mappings only after complete success;
2. unexpected empty applications block rather than disappear;
3. application rejects moved source/target inputs before mutation and exactly
   reproduces an approved forecast tree;
4. conflict continuation distinguishes contextual application from explicit
   fork and revalidates exact/deterministic resolutions;
5. mid-queue abort restores the exact original branch tip and publishes no
   partial records;
6. linked worktrees cannot continue or overwrite each other's rebase journals;
7. stock Git can inspect the resulting history and in-progress conflicts; and
8. new accepted record schemas validate and round-trip through a deterministic
   metadata envelope, including original commits made unreachable by rewrite.

The implementation uses `vcs-lab.rebase-operation/v1` for worktree-private
state and publishes `vcs-lab.rebase-application/v1` plus `vcs-lab.rebase/v1`
only after the queue and any forecasted final tree verify. The expanded
integration suite exercises clean reviewed replay, stale rejection, exact
resolution batch use, contextual fork, unexpected empty blocking, partial
abort, linked-worktree isolation, stock Git state, and fresh-clone portability.
