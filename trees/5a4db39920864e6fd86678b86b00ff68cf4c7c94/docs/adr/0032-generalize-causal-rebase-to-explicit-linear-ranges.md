# ADR-0032: Generalize causal rebase to explicit linear ranges

- **Status:** Accepted
- **Decided:** 2026-09-17
- **Date:** 2026-09-15
- **Owners:** Repository maintainers
- **Implementation:** [#27](https://github.com/jwh3times/vcs-lab/issues/27)
  (open product question 5)
- **Related:** [#28](https://github.com/jwh3times/vcs-lab/issues/28),
  [#29](https://github.com/jwh3times/vcs-lab/issues/29),
  [#30](https://github.com/jwh3times/vcs-lab/issues/30),
  [ADR-0011](0011-model-causal-rebase-as-a-forecasted-application-sequence.md),
  [ADR-0012](0012-treat-workspace-lifecycle-as-reversible-materialization-and-drafts-as-checkpoint-inputs.md),
  [ADR-0028](0028-define-target-checkpoint-forecast-semantics.md)

## Context and decision

Linear v1 (ADR-0011) rebases the checked-out named branch: the source set is
everything between the physical merge base with `onto` and the branch tip,
classified by the coverage lattice into omit, review, and replay. Git's
`rebase --onto <newbase> <upstream> [<branch>]` lets a user name the range
`<upstream>..<branch>` instead, which is how a topic branch moves off an old
integration branch or how a sub-range is carried elsewhere. #27 asks whether
that form can be added while keeping the two properties that make v1 safe:
an exact origin/result mapping for every replayed commit, and a blocked
rather than skipped outcome for a replay that unexpectedly becomes empty.
Question 5 asks first whether the v1 model is understandable at all.

Decide that an explicit range is a **restriction of the current branch's
source set, named by its base**: `vlab rebase <onto> --from <base>` (and the
same option on `rebase-plan` and `rebase-forecast`) replays `<base>..<tip>`,
where `<tip>` is the branch being rebased. The commits between the physical
merge base and `<base>` are **excluded by range**: they are listed in the
plan with their identities, recorded in the summary receipt, and neither
replayed nor claimed as absorbed or covered. Execution still requires the
checked-out named branch and a clean worktree; planning and forecasting may
name any branch. Ranges that do not end at a branch tip, ranges containing
merge commits, and dirty overlays remain refused.

## Evidence

The evaluation kit for the human action on #27,
`rebase-walkthrough.sh`, was run on 2026-09-15 at `468cd06` in a disposable
repository. Every scenario behaved as README.md and ADR-0011 document.

| Scenario | Command | Observed |
| --- | --- | --- |
| Clean replay of two changes onto a moved `main` | `rebase-plan`, `rebase-forecast`, `rebase --use-forecast` | Two `replay` entries, forecast `complete` with both steps `clean`, caller unchanged after forecasting; both `Change-Id`s preserved, `relation: causal-rebase`, result tree equal to the predicted tree, declared provenance carried onto the rewritten commits, one application record per commit plus a summary receipt |
| One source change already on `main` by `vlab cherry-pick` | `rebase-plan`, `rebase` | The change is `omit [stable-change-id]`, listed under `omitted` with its proof; the other change replays; both are `absorbedChanges` |
| Replay that becomes empty (content already on `main` inside a larger plain-Git commit) | `rebase`, `--status`, `--continue`, `--abort` | `conflict-blocked`, state `blocked`, 0 of 1 replayed, no receipt; `--continue` refused with `operation-state-invalid`; abort restores the exact original tip and a clean worktree |
| Content conflict, manual resolution | `rebase`, `--status`, `--continue` | `conflict-paused`, `UU shared.txt` visible to plain Git, `relation: contextual-rebase`, same `Change-Id`, conflicted path recorded |
| Same conflict resolved as a fork | `--continue --fork` | New `Change-Id`, `Derived-From` and `Origin-Commit` trailers, `relation: contextual-fork`, source listed under `forkedSourceCommits` and absent from `absorbedChanges`; metadata validates and the identity audit reports no error |

One usability finding, not a defect: the blocked message for an empty replay
quotes Git's own advice, including `git cherry-pick --skip`, before vlab's
instruction to abort. An evaluator who follows the first advice takes the
out-of-band path that ADR-0011 says the next command must refuse. The
contract below keeps the block; the message should lead with vlab's
instruction. The empty case also shows why an explicit range matters: the
user's only remedy today is abort, because there is no way to say "replay
only from here".

## Contract

### Naming a range

`--from <base>` names the exclusive lower bound of the source set. `<base>`
is any revision that is an ancestor of the branch tip and is not the tip.
Without `--from`, the base is the physical merge base as today, so v1 plans
are unchanged byte for byte. `<onto>` keeps its meaning. The plan gains a
`range` block: `{ baseRef, base, tip, explicit }`, and its fingerprint covers
`base`, so a forecast made for one range is stale for another.

### Which branch moves

Execution operates on the checked-out named branch only, as in v1, because a
conflict is resolved in the owning worktree. `rebase-plan` and
`rebase-forecast` accept `[<source>]` with `--from` for any named branch and
never switch the caller. A range whose tip is not a branch tip (a commit in
the middle of a branch) is refused with `unsupported-range`: the commits
after it would need re-parenting, which is the interactive editing #30 owns.

### Excluded-by-range commits

Commits in `physicalBase..base` are outside the source set by the user's
declaration. The plan lists them as `excludedByRange` with commit, `Change-Id`,
and subject, so the person sees exactly what will not travel; the summary
receipt records the same list and the `range` block. They are not replayed,
not classified, not absorbed, and not covered: no receipt ever claims them.
If `<base>` is reachable from `<onto>`, the list is empty and the range is a
plain rebase. If it is not, the plan reports the count in its human summary
and the evaluator's prediction question is "which commits stay behind and
why". Nothing is dropped silently; the omission is declared, not proven.

### Per-commit mapping and blocking

Unchanged. Every replayed commit yields one application record with source
and applied commit, source and applied `Change-Id`, relation, target-before
and result trees. A replay that becomes empty blocks with the existing
`conflict-blocked` outcome and no receipt; covered commits inside the range
are omitted with their proof; heuristic candidates still require explicit
acceptance.

### Forecast pinning and abort

The forecast pins `range.base` beside the heads, trees, fingerprint, and
candidate policy it pins today; application refuses a forecast for a
different base as `stale-forecast`. Abort restores the exact original tip,
as today; the range changes what is replayed, never what is restored.

### Composition with ADR-0028 and what stays out

A target overlay (ADR-0028) is uncommitted context carried through the
rewrite; the range decides the committed source set. The two are orthogonal
and #28 may combine them without new semantics. Merge commits inside the
range stay refused until #29 defines the mapping for a recreated merge.
Edit, reword, squash, and fixup stay with #30. Ranges are still linear.

## Rejected alternatives

- **Mirror `git rebase --onto <newbase> <upstream> <branch>` positionally.**
  Three positionals whose order most users look up is the opposite of
  explainable; one named option on the existing command keeps every v1
  invocation valid and reads as the sentence it is.
- **Prove or acknowledge every excluded commit.** Requiring coverage for
  `physicalBase..base` would refuse the common case, moving a topic off an
  old integration branch whose own commits were never the topic's work.
  Listing them in plan and receipt makes the exclusion visible and exact
  without inventing a coverage claim.
- **Treat excluded commits as covered.** They are not; a receipt that said
  so would let a later plan omit work that never landed.
- **Linearize ranges that contain merges.** A heuristic flattening produces
  commits with no single origin, which is exactly the mapping problem #29
  exists to design.
- **Rewrite a branch that is not checked out, without a worktree.** Possible
  only for a complete forecast with no conflict; ADR-0011 already names it as
  a later optimized mode, and it must not be the model.

## Consequences

- `vcs-lab.rebase-plan/v1`, `vcs-lab.rebase-forecast/v1`,
  `vcs-lab.rebase-operation/v1`, and `vcs-lab.rebase/v1` each gain optional
  members (`range`, `excludedByRange`) under the ADR-0020 additive rule; a
  plan without `--from` emits `range.explicit: false` and an empty list.
- One new refusal code, `unsupported-range`, joins the ADR-0021 envelope.
- Acceptance evidence, when implemented: a range plan is byte-identical to
  the v1 plan when `base` equals the physical base; a topic moved off an old
  integration branch replays only its own commits and records the excluded
  ones; a forecast for one base is stale for another; abort after a partial
  range replay restores the original tip; a mid-branch tip is refused.
- The kit's finding about the blocked message is a one-line wording change
  independent of this decision.

## What the owner must decide

1. Question 5: run the kit (`bash rebase-walkthrough.sh`, three scenarios,
   a `PREDICT` line before each command) with the intended users and record
   whether the v1 model is understandable; if it is not, this contract waits.
2. Accept `--from <base>` on the current branch as the range form, rather
   than a positional upstream or a branch argument.
3. Accept that excluded-by-range commits are listed and recorded but neither
   proven nor acknowledged.
4. Confirm that a range not ending at a branch tip is refused in this version.
5. Confirm that the forecast pins the range base and that abort semantics are
   unchanged.

## Owner decision (2026-09-17)

Accepted. For decision 1, the owner ran the question-5 kit
(`rebase-walkthrough.sh` from #27, with a pause after each `PREDICT` prompt)
against `main` at `bd92f0b` and reports that the tool matched every
prediction: the linear v1 model is understandable, so the range contract
proceeds. Decisions 2 through 5 are accepted as written: `--from <base>` on
the current branch; excluded-by-range commits listed and recorded but neither
proven nor acknowledged; a range not ending at a branch tip refused; the
forecast pins the range base and abort is unchanged.
