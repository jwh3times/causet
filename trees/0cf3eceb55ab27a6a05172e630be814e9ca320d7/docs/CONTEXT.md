# vcs-lab

vcs-lab records causal facts about how changes move between Git histories and
uses them to plan, forecast, land, and verify that movement. This glossary holds
the terms accepted decisions have settled; it grows as terms are resolved.

## Forecasting and application

**Target overlay**:
An immutable checkpoint of the target workspace's uncommitted work, pinned by
commit identity and carried through an application as uncommitted context,
never as a causal change.
_Avoid_: target draft commit, autostash

**Excluded-by-range commit**:
A commit between a branch's physical merge base and an explicitly named range
base; it is listed and recorded but neither replayed, absorbed, nor covered.
_Avoid_: skipped commit, dropped commit

## Rebase and rewriting

**Recreated merge**:
A merge commit a merge-preserving rebase creates to join rewritten parents. It
claims nothing about the changes beneath it and carries only the resolutions
that made the join.
_Avoid_: replayed merge, preserved merge

**Amendment**:
A recorded divergence between what a logical change contained before an
interactive edit and what it contains after, under the same identity. It is what
stops a bare identity match proving content nobody reviewed.
_Avoid_: rewrite, fixup

**Interactive absorption**:
A squash or fixup that folds one change into another, leaving one surviving
identity and naming the absorbed ones in a record, as a landing does.
_Avoid_: merge, collapse

## Lineage and exchange

**Lineage bridge**:
A declared record mapping every commit of a rewritten history to its image,
which lets facts cross between two lineages that share no root once a clone has
accepted it.
_Avoid_: graft, replacement, lineage override

**Carried record**:
A new fact on a destination commit that restates a fact from its source commit
through an exact mapping, with every claim re-derived on the destination side.
_Avoid_: migrated record, rewritten record

**Conflicted fact**:
A fact whose identity names different content in two places; neither copy
contributes evidence until a disposition exists.
_Avoid_: duplicate, competing receipt

**Parked conflict**:
An incoming conflicted fact held aside, inspectable but used by no reader,
instead of refusing the exchange or overwriting the local copy.
_Avoid_: rejected record, overwritten record

**Disposition**:
A person's recorded, local decision on a conflicted fact: keep the local copy or
replace it with the parked one.
_Avoid_: resolution (that word names conflict-resolution memory)

**Reduced evidence**:
The state of a conclusion reached while a reachable fact was excluded; the
conclusion names what it could not use, and can only be weaker than one reached
with the whole record.
_Avoid_: partial proof, degraded coverage

**Capability document**:
A build's statement of the record versions, profiles, algorithms, features, and
bounds it reads and writes; two documents alone decide what an exchange may
carry.
_Avoid_: handshake, server capabilities

## Verification

**Bound source inventory**:
The raw commit objects of a proof bundle's source range, which bind its change
list to Git object identities a verifier recomputes.
_Avoid_: change list digest

**Anchor**:
An identity a proof bundle's carried proofs end at (target head, source head,
notes tip, lineage roots), which the bundle states but cannot prove.
_Avoid_: trust root, checkpoint

**Suggested resolution**:
Proposed text for a conflicted path, addressed to a person and produced with
lower confidence than an exact or deterministic result. It is never a decision:
it lives outside the resolution family, never travels between clones, and
becomes evidence only once a person has resolved and the ordinary capture path
records what they left.
_Avoid_: resolution candidate, inferred resolution

**Verification tier**:
How far a verifier's conclusion reaches: self-consistent with the bundle, bound
to its stated anchors, anchored to independently obtained anchors, or
unavailable from the carried material.
_Avoid_: confidence level
