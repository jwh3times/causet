# ADR-0036: Keep suggested resolutions outside the resolution family entirely

- **Status:** Proposed
- **Date:** 2026-09-20
- **Owners:** Repository maintainers
- **Implementation:** [#35](https://github.com/jwh3times/vcs-lab/issues/35)
- **Related:** [ADR-0004](0004-use-an-explicit-coverage-proof-lattice.md),
  [ADR-0006](0006-forecast-and-pin-automated-reconciliation-decisions.md),
  [ADR-0007](0007-keep-resolution-automation-exact-or-deterministic.md),
  [ADR-0020](0020-freeze-per-family-compatibility-and-resource-bounds.md),
  [ADR-0023](0023-locate-the-model-substrate-mismatch-in-facts-not-content.md)

## Context and decision

ADR-0007 froze two resolution tiers — exact signature reuse and deterministic
semantic merge — and closed with a constraint rather than a design: any future
learned or model-assisted candidate must be a separate lower-confidence tier
with provenance and explicit review, and it cannot masquerade as exact or
deterministic. FR-RES-07 carries that as a Planned requirement and #35 states
the conditions under which it may be explored at all.

Turning that constraint into a contract needs one decision, and the rest
follows: **how is "cannot masquerade" enforced?**

Decide that it is enforced **structurally, not by a flag**. A suggested
resolution is not a `vcs-lab.resolution/v1` record with a confidence field. It
is a different record family, in a different store, that the exact-reuse code
path cannot read at all. A reader that ignored a flag would apply a model's
guess as though a person had decided it; a reader that never receives the record
cannot.

## What a suggestion is, and is not

A suggestion is **proposed text for a conflicted path, addressed to a person**.
It is not a decision, not evidence, and not an input to any automated step.

The distinction that makes this safe is one the repository already relies on:
the thing that becomes reusable evidence is not what a tool proposed, it is what
a person left in the file. The existing capture path takes the resolved content
out of the worktree after a person resolves, keys it by the real ordered
base/target/source signature, and publishes it. A suggestion that a person
accepts is therefore captured as an ordinary exact resolution — because by then
it *is* one, decided by a human against pinned inputs.

So a suggestion never needs to become evidence. It only needs to save typing,
and then get out of the way.

## The contract

### Family and store

A suggestion is `vcs-lab.resolution-suggestion/v1`, written to
`<git dir>/vcs-lab/suggestions/`, which is **worktree-private** under ADR-0020.
It is not a note record, it does not publish to `refs/notes/vcs-lab`, and it
does not enter a metadata envelope. `RECORD_FAMILIES` registers it with
`unknownVersion: refuse`, matching every other worktree-private family.

Private and local is the point, not a limitation. Travelling is how a guess
would acquire the appearance of corroboration; a suggestion that reaches a peer
looks like something the peer's repository vouches for.

### What it must carry

Every suggestion records, or it is not written:

- **Pinned inputs.** The ordered base, target, and source blob ids — the same
  three that key an exact signature — plus the path and the operation id.
- **Provenance.** The producing model's identity and version, the prompt or
  template identifier, and a digest of the exact inputs it was given. Enough
  that someone can ask the same question again and compare.
- **The proposal itself**, as content, never as a blob written into the object
  store. A suggestion that is not an object cannot be referenced by a record
  that expects one.
- **`tier: "suggested"`**, which is advisory labelling for display. It is not
  what makes the contract hold; the family and the store are.

### What may consume it

`vlab resolve status` may display it beside the exact candidates for the same
conflict, clearly separated and clearly labelled. That is the whole of the
consumption surface.

Nothing else may read the family. In particular:

- `materializeResolutionCandidate` must not accept a suggestion id;
- a forecast's `approvedResolutions` must not reference one, so
  `--use-forecast` can never carry one into an application;
- `publishResolution` must not accept one;
- the resolution catalog, proof bundles, and coverage classification must not
  see the family at all.

Applying a suggestion is a person editing the file. There is no
`--apply-suggestion`, because an option that writes a model's output into a
conflicted worktree on request is the automated application this tier exists to
forbid — and the person can copy the text themselves, which keeps the act
unambiguous.

### Relationship to the tiers that exist

The tier ordering is exact, then deterministic semantic, then suggested. But the
ordering is almost beside the point: a suggestion is not a lower rung of the
same ladder, because the other two produce decisions and this one produces
prose. It sits outside the ladder, and the ladder cannot see it.

It is likewise not part of ADR-0004's change lattice. That lattice classifies
*changes* by proof; a suggestion is about a *conflict*. It contributes to no
coverage class and appears in no plan.

### Ambiguity and blocking are unchanged

Every rule ADR-0007 froze stands. Multiple exact results remain ambiguous and
require an explicit resolution id. Divergent same-entity edits, delete-versus-
edit, and incompatible ordering remain blocked. A suggestion never unblocks
anything, and a blocked conflict with a suggestion attached is still blocked.

## Rejected alternatives

- **A confidence field on `vcs-lab.resolution/v1`.** Rejected, and this is the
  central rejection. Every reader of that family — the catalog, the forecast,
  the materializer, the publisher, `verify-proof` — would have to honour the
  field, and one that forgot would apply a guess as an exact result. The
  guarantee would rest on the discipline of every future reader rather than on
  the shape of the data.
- **Publish suggestions to the notes ref so a team shares them.** Rejected. A
  suggestion arriving through the same channel as receipts and resolutions
  borrows their credibility, and ADR-0030's conflict policy would then have to
  arbitrate between two machines' guesses — a dispute with no fact underneath
  it.
- **Write the proposed content as a Git blob and reference it by id.**
  Rejected. An id is exactly what the exact path consumes; making a suggestion
  addressable in the object store is one careless join away from it being
  applied as a result.
- **Offer `--apply-suggestion` for convenience.** Rejected. The four conditions
  in #35 include explicit review before anything is applied, and a flag that
  writes model output into the worktree is an application by any reading.
- **Defer the tier entirely.** Reasonable, and it remains the status quo until
  the owner decides otherwise. This ADR does not argue that the tier is
  valuable; it states the only shape in which it would be safe, so the question
  can be decided on its merits rather than on its risk.

## Consequences

- One new worktree-private family, its schema document, and its registry entry
  with a resource bound. No existing record version changes.
- `vlab resolve status` gains a display section. No other command changes.
- A negative test is required for each reader that must not accept the family —
  materializer, forecast approval, publisher, catalog — because "cannot read
  it" is the contract, and only a test states it.
- No change to coverage, proofs, envelopes, or the failure envelope.
- If the tier is ever built and later removed, nothing published depends on it,
  because nothing it produces is published.

## What the owner must decide

1. Accept that the guarantee is structural — a separate private family the
   exact path cannot read — rather than a confidence field on the existing
   record.
2. Accept that suggestions are worktree-private and never travel between
   clones.
3. Accept that acceptance is a person editing the file, with no apply option,
   and that the resulting exact record is captured by the existing path.
4. Confirm that a suggestion contributes to no coverage class and appears in no
   plan or proof bundle.
5. Decide whether to build the tier at all. FR-RES-07 is P2 and Planned; this
   ADR makes it safe to build, not urgent.
