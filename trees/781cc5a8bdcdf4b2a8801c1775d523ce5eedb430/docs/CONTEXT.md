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

**Verification tier**:
How far a verifier's conclusion reaches: self-consistent with the bundle, bound
to its stated anchors, anchored to independently obtained anchors, or
unavailable from the carried material.
_Avoid_: confidence level
