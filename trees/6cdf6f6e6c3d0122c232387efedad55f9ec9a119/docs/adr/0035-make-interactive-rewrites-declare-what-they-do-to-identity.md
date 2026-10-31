# ADR-0035: Make interactive rewrites declare what they do to identity

- **Status:** Proposed
- **Date:** 2026-09-20
- **Owners:** Repository maintainers
- **Implementation:** [#30](https://github.com/jwh3times/vcs-lab/issues/30)
- **Related:** [ADR-0002](0002-separate-state-change-application-and-landing-identity.md),
  [ADR-0003](0003-prefer-causal-compact-landings-and-receipt-backed-hard-squash.md),
  [ADR-0004](0004-use-an-explicit-coverage-proof-lattice.md),
  [ADR-0011](0011-model-causal-rebase-as-a-forecasted-application-sequence.md),
  [#29](https://github.com/jwh3times/vcs-lab/issues/29)

## Context and decision

Git's interactive sequencer offers `reword`, `edit`, `squash`, and `fixup`.
Causal rebase supports none of them, and ADR-0011 was explicit that the point of
a causal rebase is to stop Git's heuristics deciding things the model should
state. Adding the four by handing them to the sequencer would reintroduce
exactly that: whatever happens to identity would be whatever Git happened to do.

The four are not variations of one operation. Each makes a different claim about
logical identity, and one of them can silently invalidate a claim made in
another clone.

Decide that each of the four is a **distinct, declared plan action with its own
identity rule**, that the `Change-Id` trailer is never left to a text editor,
and that an operation which changes what a logical change *contains* records
that fact so coverage cannot keep vouching for content nobody reviewed.

## The hazard that shapes the rest

ADR-0004 accepts "a target-history stable Change ID" as exact evidence: if a
commit carrying `Change-Id: X` is reachable from the target, change X is
covered. That rule is sound only while an identity names the same work
everywhere it appears.

`edit` breaks that assumption. It changes content while keeping the identity, so
a peer that already landed X — and recorded a receipt naming X — goes on
reporting X as covered while the branch now holds different content under the
same name. Nothing in the current model would notice.

This is not hypothetical bookkeeping: metadata envelopes, proof bundles, and the
lineage rules exist precisely so identities can be believed across clones. An
interactive rewrite that quietly re-points an identity is the one local
operation that can make a remote proof wrong.

## The contract

### reword — identity preserved by construction

`reword` changes a message and nothing else. The tree is unchanged, so the
change is the same change and the identity is preserved.

The trailer is **reapplied by the operation**, not left in the buffer for a
person to edit around. The rewritten message is composed as the caller's new
text with the original `Change-Id` trailer appended, and the result is checked:
exactly one `Change-Id`, equal to the original. A message that would lose or
duplicate it is refused with `identity-mismatch` before the commit is created.

Someone who wants a different identity uses `--fork`, which already exists and
already records `Derived-From`. Rewording is not a way to get one by accident.

### edit — identity retained, divergence recorded

`edit` pauses so the caller can change content, then continues under the same
identity. That is what makes it useful and it is what the issue asks for.

Because it changes what the identity contains, the operation publishes an
**amendment fact** attached to the rewritten commit: the identity, the tree
before the edit, the tree after it, and the rebase operation that produced it.

Coverage then degrades honestly. For an identity with a reachable amendment
fact, a bare Change-Id match is reported as `candidate-equivalent` rather than
`covered`; a receipt naming the specific commit still proves that commit, and
ancestry still proves what ancestry proves. The planner already knows how to
report a class that needs an explicit decision, and this reuses it rather than
inventing a new one.

An amendment whose before and after trees are equal publishes nothing, because
nothing diverged.

### squash and fixup — one surviving identity, the rest absorbed

Both absorb one commit into another. The repository already models absorption:
a compact landing keeps a real causal parent and names what it absorbed
(ADR-0003), and `vcs-lab.landing/v1` carries `absorbedCommits` and
`absorbedChanges` so coverage can still prove the absorbed work.

Interactive absorption follows that model. The surviving commit keeps the
identity of the commit being squashed **into**; each absorbed identity is named
in an absorption record published against the surviving commit; coverage for an
absorbed change comes from that record, exactly as it does from a landing.

The mechanical trap is the message. Git's sequencer concatenates the messages it
squashes, which would place several `Change-Id` trailers in one commit — and
this repository's reader takes one trailer, so the surviving commit's identity
would depend on parse order. The result therefore carries **exactly one**
`Change-Id` trailer, the survivor's, and the absorbed identities appear only in
the record. The difference between the two actions is only what happens to the
absorbed prose: `squash` offers it to the caller for editing into the surviving
message, `fixup` discards it. Neither changes identity handling.

### All four are plan actions, and all four are forecast

`vlab rebase-plan` gains `reword`, `edit`, `squash`, and `fixup` alongside
`replay`, `omit`, and `review`, each naming its subject commit and, for the
absorbing pair, its target. The plan fingerprint covers the action list, so an
approval for one interactive program cannot authorize another.

The forecast predicts what it can and says what it cannot. `reword`, `squash`,
and `fixup` have predictable result trees. `edit` does not, by definition: its
whole purpose is to let a person change the content. An `edit` step is forecast
as `pauses-for-content` with no predicted tree, and the operation verifies the
rest of the queue against the forecast after the caller continues — the same
shape a conflicted pick already uses.

## Rejected alternatives

- **Hand the four to `git rebase -i` and read the result afterwards.**
  Rejected. It is the implicit outcome the issue exists to replace, and the
  squash-message trap shows why: the sequencer's behavior would silently decide
  which identity survives.
- **Make `edit` fork, taking a new identity with `Derived-From`.** Rejected,
  though it is the safest option and worth recording. It would make every typo
  fix a new logical change, break the property that a change keeps one name
  across a branch's life, and push callers back to plain Git for ordinary work.
  The amendment fact keeps the useful property and pays for it with a coverage
  downgrade that is narrow and visible.
- **Let `edit` retain identity with no record.** Rejected. It is the status quo
  a naive implementation would produce, and it is the one option that can make a
  proof in another clone wrong without any local signal.
- **Concatenate messages on `squash` and let the last trailer win.** Rejected.
  A deterministic rule would still make identity depend on message layout, which
  is the kind of implicit behavior ADR-0011 set out to remove.
- **Keep the absorbed identities as extra trailers on the surviving commit.**
  Rejected. The record is the right carrier: it is versioned, it is what landing
  already uses, and trailers are not a list structure.

## Consequences

- `vcs-lab.rebase-plan/v1`, `vcs-lab.rebase-forecast/v1`,
  `vcs-lab.rebase-operation/v1`, and `vcs-lab.rebase/v1` need new versions for
  the action vocabulary and the per-action outcomes.
- Two new note record families: an amendment fact and an interactive absorption
  record. Both are note records under the existing conflict and bounds rules of
  ADR-0020 and ADR-0030.
- `src/merge-plan.js` gains one rule: an identity with a reachable amendment is
  not proved by a bare Change-Id match. This is the only change to the coverage
  lattice, and it only ever weakens a conclusion.
- `docs/identity/README.md` needs the statement that an identity names the same
  work everywhere **unless** an amendment says otherwise, which is a weaker
  claim than it makes today and should be published as such.
- Interactive rebase and merge preservation (#29) are independent; either can
  land first. A recreated merge is never a subject of these four actions.

## What the owner must decide

1. Accept that `edit` retains identity and publishes an amendment fact, rather
   than forking or recording nothing.
2. Accept the consequent weakening of Change-Id coverage for amended
   identities, from `covered` to `candidate-equivalent`.
3. Confirm that `squash` and `fixup` reuse the landing absorption model, with
   exactly one surviving trailer.
4. Confirm that `reword` composes the trailer itself and refuses a message that
   would lose or duplicate it, rather than trusting the caller's editor.
5. Decide whether `edit` should be offered at all in a first version, given that
   it is the only one of the four whose result a forecast cannot predict.
