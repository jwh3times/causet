# ADR-0034: Recreate merges as joins that claim nothing, carrying only their resolutions

- **Status:** Accepted
- **Decided:** 2026-09-20
- **Date:** 2026-09-20
- **Owners:** Repository maintainers
- **Implementation:** [#29](https://github.com/jwh3times/vcs-lab/issues/29)
- **Related:** [ADR-0004](0004-use-an-explicit-coverage-proof-lattice.md),
  [ADR-0007](0007-keep-resolution-automation-exact-or-deterministic.md),
  [ADR-0011](0011-model-causal-rebase-as-a-forecasted-application-sequence.md),
  [ADR-0032](0032-generalize-causal-rebase-to-explicit-linear-ranges.md),
  [#30](https://github.com/jwh3times/vcs-lab/issues/30)

## Context and decision

Causal rebase is linear and current-branch-only. `buildRebasePlan` refuses any
source history containing a merge commit with `merge-topology-unsupported`, and
ADR-0011 accepted that refusal rather than guessing. #29 asks what a
merge-preserving form would have to decide first.

The difficulty is not the replay. It is that every causal claim this repository
makes rests on an origin-to-result correspondence: an application record names
one `originCommit` and one `appliedCommit`, and a receipt is believable because
that correspondence is exact. A recreated merge has no single origin. It is a
new object joining two rewritten parents, and its tree is a function of those
parents rather than of any one change.

Decide that a **recreated merge is a join, not a contribution**. It claims
nothing about the changes beneath it, takes a new logical identity that records
the merge it was recreated from, and carries forward exactly one thing: the
conflict resolutions that made the join possible. Coverage continues to come
only from the per-change applications on the rewritten lines, exactly as it does
today.

## Why a merge contributes nothing of its own

A clean merge commit's tree is fully determined by its parents; it adds no
content. A conflicted merge commit adds exactly the resolution decisions that
reconciled the two sides — nothing else. That is the whole of a merge's causal
content, and this repository already models it as a first-class fact:
`vcs-lab.resolution/v1`, keyed by ordered base/target/source blob identities,
retained against garbage collection, and reusable only through the exact rules
ADR-0007 froze.

So the question "what does a receipt for a recreated merge claim?" has a
narrower answer than it first appears. It claims what was joined and how the
join was resolved. It does not claim that any change was applied, because the
merge did not apply one.

## The contract

### Identity

A recreated merge takes a **new** `ch_` identity and records `Derived-From` the
original merge commit's identity, or its commit id when the original carried no
`Change-Id`. This is uniform and has no exception.

A rebase replaces the parents by construction, so a recreated merge is a
different join even when its resolution is byte-identical. Preserving the
original identity would assert sameness the operation cannot support, which
FR-ID-03 already forbids for intentional divergence. Because a merge claims
nothing, a new identity costs nothing: no coverage conclusion depends on being
able to match a merge by `Change-Id`.

### What the receipt records, and what a plan may conclude

The rebase summary receipt gains a `recreatedMerges` member. Each entry names:

- `originCommit` — the merge that was recreated, and `originChangeId` when it
  had one;
- `resultCommit` and `changeId` — the new join and its new identity;
- `parents` — the rewritten parents, in order, each mapped to the original
  parent it replaces;
- `resolutions` — the resolution outcomes the join required, each marked
  `exact-reused` when a recorded signature supplied it or `decided` when a
  person resolved it during the operation;
- `cleanJoin` — true when the merge required no resolution at all.

A plan may conclude **nothing** from this entry. It is not exact evidence under
ADR-0004, it contributes to no coverage class, and `vlab merge-plan` must not
count a recreated merge as covering anything. The entry exists so a reader can
audit what the rewrite did to the topology, and so provenance can be carried
onto the new object.

This is the decision that keeps the model sound. A merge-preserving rebase that
let a recreated merge vouch for the work beneath it would let one rewrite
manufacture coverage for changes nobody re-proved.

### Resolutions are what travel

Each conflicted join is resolved through the existing path: an exact signature
match reuses the recorded result and records `exact-reused`; no match blocks for
review exactly as a conflicted pick does today. A resolution decided during a
recreated merge publishes an ordinary `vcs-lab.resolution/v1` record, because it
is an ordinary resolution — the fact that a merge rather than a pick produced
the conflict changes nothing about its signature.

Deterministic semantic merge (ADR-0007 tier 2) applies unchanged where the
paths are indexed specifications.

### Supported topology in v1

Preserve **two-parent merges whose both parents lie inside the rebased range or
are ancestors of the new base.** Everything else refuses before any mutation,
with a named code rather than a guess:

| Shape | Refusal |
| --- | --- |
| More than two parents (octopus) | `unsupported-repository-shape` — the order in which an octopus resolves is not recoverable from the result, so its recreation cannot be forecast |
| A parent outside the range and not an ancestor of the new base | `unsupported-range` — the join would reference a line the rebase is not rewriting and cannot map |
| A merge whose recreation would be empty because both parents became identical | `unexpected-empty` — the existing rule; the operator decides, the machinery does not drop it |

The first two are deliberate scope, not defects. They can be revisited with
their own decision once the two-parent form has been exercised.

### Forecast

A merge-preserving forecast predicts the recreated merge's tree with the same
engines a pick uses, and pins it with the rest. The plan fingerprint covers the
preserved topology — which merges are recreated, and the parent mapping — so an
approval for one topology cannot authorize another. A merge whose join cannot be
predicted blocks the forecast with its own reason, in the same way a conflicting
overlay does under ADR-0028.

## Rejected alternatives

- **Preserve the original merge's `Change-Id` on the recreated merge.**
  Rejected. It asserts that two joins of different parents are the same logical
  change, and it would make a merge matchable by identity — which is precisely
  the route by which a recreated merge could inflate coverage.
- **Flatten merges into a linear replay, as ordinary `git rebase` does.**
  Rejected as the *preserving* form's answer, though it remains what a caller
  gets today. Flattening discards the fact that two lines were joined and, with
  it, the resolution that made them join. It is a different operation and should
  keep its own name.
- **Let a recreated merge carry coverage for the changes reachable from its
  parents.** Rejected. Reachability from a merge is not evidence that a change
  was applied to the rewritten line; it is evidence about the old topology. This
  is the specific unsound step the decision above exists to forbid.
- **Give a merge a resolution-derived identity** — a `ch_` computed from its
  resolution signatures — so an identical join recreated twice matches.
  Rejected for this version. It is an appealing property, but it makes identity
  depend on conflict content, which no other identity in the model does, and a
  clean join would have no identity at all under it.
- **Support octopus merges by recording the observed parent order.** Deferred.
  The result does not record the order its conflicts were resolved in, so the
  recreation cannot be forecast from the original; inferring it would be a
  heuristic in a place the model keeps exact.

## Consequences

- `vcs-lab.rebase-plan/v1`, `vcs-lab.rebase-forecast/v1`, and
  `vcs-lab.rebase/v1` need new versions carrying the preserved topology, the
  parent mapping, and `recreatedMerges`. Each is a strict superset.
- `constraints.supported` stops meaning "linear" and starts meaning "every merge
  in range is a supported shape". `linearHistory` remains reported separately,
  because a caller may still want to know.
- One new relation joins `causal-rebase`, `contextual-rebase`, and
  `contextual-fork`: `recreated-merge`. It is not an application relation and
  must not be counted as one.
- The coverage lattice and every proof rule are unchanged. That is the point.
- `vlab verify-proof` needs no change: a recreated merge produces no coverage
  claim to verify.

## What the owner must decide

1. Accept that a recreated merge claims nothing about the changes beneath it,
   and that coverage continues to come only from per-change applications.
2. Accept a new identity with `Derived-From` for every recreated merge, rather
   than preserving the original merge's identity.
3. Confirm that carrying resolutions forward through the existing exact rules —
   with no new tier and no merge-specific reuse — is the whole of what a
   recreated merge carries.
4. Confirm the v1 topology scope: two parents, both in range or ancestors of the
   new base, with octopus and out-of-range parents refused by name.
5. Decide whether the flattening form available today should keep its current
   name once a preserving form exists, or whether the preserving form should be
   the default for a source containing merges.

## Owner decision (2026-09-20)

Accepted. A recreated merge is a join that claims nothing about the changes
beneath it; it takes a new identity recording the merge it came from, and
carries forward only its resolutions through the existing exact rules. Coverage
continues to come from per-change applications alone. The v1 topology scope —
two parents, both in range or ancestors of the new base, with octopus merges and
out-of-range parents refused by name — is accepted as written.

Decision 5, whether the flattening form available today keeps its current name
once a preserving form exists, is deliberately left to implementation. It is a
naming choice with no effect on the contract above, and it is better made
against a working preserving form than in advance.
