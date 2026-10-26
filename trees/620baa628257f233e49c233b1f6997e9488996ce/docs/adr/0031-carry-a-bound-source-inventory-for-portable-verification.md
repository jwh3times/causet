# ADR-0031: Carry a bound source inventory for portable verification

- **Status:** Accepted
- **Decided:** 2026-09-17
- **Date:** 2026-09-14
- **Owners:** Repository maintainers
- **Implementation:** [#36](https://github.com/jwh3times/vcs-lab/issues/36)
- **Related:** [#37](https://github.com/jwh3times/vcs-lab/issues/37),
  [#38](https://github.com/jwh3times/vcs-lab/issues/38),
  [#43](https://github.com/jwh3times/vcs-lab/issues/43),
  [#46](https://github.com/jwh3times/vcs-lab/issues/46),
  [ADR-0004](0004-use-an-explicit-coverage-proof-lattice.md),
  [ADR-0020](0020-freeze-per-family-compatibility-and-resource-bounds.md),
  [ADR-0025](0025-retain-the-object-closure-of-published-causal-facts.md),
  [canonical JSON profile](../canonical-json/README.md)

## Context and decision

`vlab proof-bundle` and `vlab verify-proof` deliver the local half of
FR-PLAN-08: a verifier with the repository recomputes the classification from
the bundle's stated evidence and compares the evidence, the complete ordered
source inventory, identities, subjects, counts, and both bases with Git
history. A verifier without the repository gets only the first two checks, and
#46 showed what that leaves open: a bundle can omit, inject, or misidentify
source changes, restate its hash, and still report `ok: true` offline. The
`changes` list is the sender's word; nothing in the bundle binds it to the
commits it names.

Decide that a remote verifier is served by carrying Git's own bindings rather
than by trusting the sender or by fetching the repository. A proof-bundle v2
adds, as a strict superset of v1, a **bound source inventory** (the raw commit
objects of the source range), **compact reachability and inclusion proofs** for
every positive coverage claim, and an explicit list of **anchors** the verifier
must obtain independently. Every conclusion a verifier reports is placed in a
named tier, and a conclusion the carried material cannot support is reported
as unavailable, never as a pass. Authentication of who produced a bundle is
#38 and is not a substitute for any of this.

## Evidence

Disposable repository, 2026-09-14, Windows, Git 2.55, source `b4200f8`. The
source branch carried four changes, one per lattice outcome: a hard-squash
absorbed change (`receipt-commit`), a cherry-picked change with its Change-Id
preserved (`stable-change-id`), a plain-Git change whose patch was landed by
hand (`git-patch-id-heuristic`), and new work. The honest bundle was 2,858
bytes. Each fixture below recomputed its counts and restated its hash.

| Fixture | Repository-backed verdict | Offline verdict today |
| --- | --- | --- |
| Honest bundle | `ok`, all six checks match | `ok` |
| Omit the new change | fails `sourceChanges`, `counts` | `ok` |
| Duplicate a change entry | fails `sourceChanges`, `counts` | fails `uniqueCommits` |
| Inject a commit from an unrelated repository | fails `sourceChanges`, `counts` | `ok` |
| Substitute a foreign commit id for the new change | fails `sourceChanges` | `ok` |
| Borrow a target Change-Id and claim `stable-change-id` | fails `sourceChanges`, `counts` | `ok` |

Four of the five adversarial fixtures pass offline. Only duplication is caught,
and only because it is visible inside the list itself. The binding that would
catch the rest already exists in Git: `git cat-file commit <oid> | git
hash-object -t commit --stdin` reproduced the source head's id from its raw
bytes, and those bytes carry the tree, the parents, the subject, and the
`Change-Id` trailer the classification depends on.

## Contract

### What a v2 bundle carries beyond v1

1. **Bound source inventory.** The raw commit object of every commit in
   `physicalBase..sourceHead`, keyed by object id and encoded as base64,
   because the canonical profile carries strings and commit messages need not
   be UTF-8. The verifier recomputes each id under the lineage's object format,
   walks parents from the source head, and requires the walk to reach the
   physical base and to enumerate exactly the `changes` list in its order.
   Every parent of a carried commit is carried, is the physical base, or is
   accompanied by a carried commit path from the physical base to it. The
   Change-Id and subject of a change are read from the carried message; the
   `changeId` and `subject` members of the change entry must agree with them.
2. **Reachability proofs for positive claims.** For every change classified
   `covered`, a path of raw commit objects from the target head to the commit
   that carries the coverage: the change's own commit for `commit-ancestry`,
   the target commit whose message carries the Change-Id for
   `stable-change-id`, and the receipt's attachment commit for
   `receipt-commit` and `receipt-change-id`. The effective base is proven the
   same way: the receipt's source head lies on a carried path from the source
   head, and the physical base on a carried path from that receipt source
   head.
3. **Receipt inclusion proofs.** For every receipt the classification relies
   on, the notes tip commit object, the tree objects along the fanout path,
   and the note blob. The verifier recomputes every id, reads the receipt from
   the blob, and validates it under its schema before applying the lattice to
   it. A receipt whose blob does not validate contributes nothing.
4. **Anchors.** The identities the carried proofs terminate at: the target
   head, the source head, the notes tip, and the lineage root commits. The
   bundle states them; it cannot prove them. A verifier that obtains the same
   values from a channel it trusts, such as `git ls-remote` against the
   authoritative remote, a #37 capability advertisement, or a #38 signed
   statement, promotes every bound conclusion to the anchored tier.

Hashes are Git object ids over raw object bytes in the lineage's object
format. The bundle hash stays the canonical-profile SHA-256 over everything
except `integrity` and `signatures`. The v1 `evidence` member is unchanged and
remains what the repository-backed comparison reads.

### Tiers of conclusion

| Tier | Relative to | Conclusions available |
| --- | --- | --- |
| 0 self-consistent | the bundle alone | the classification follows from the stated evidence; counts agree; no duplicate entries. This is v1 offline today |
| 1 bound | the anchors the bundle states | the inventory is complete and correctly identified between the stated source head and physical base; the physical base is a common ancestor; each receipt's content is what the stated notes tip holds; every `covered` claim rests on a commit reachable from the stated target head |
| 2 anchored | anchors obtained independently | the tier 1 conclusions, about the real repository at those heads. This is the tier a third party may act on |
| unavailable | requires objects the bundle does not carry | that a change is `new` (absence in the whole target history); that a `candidate-equivalent` patch really matches (trees); that the physical base is the best common ancestor; that an anchor is current |

Coverage is a positive claim with a compact proof; newness is an absence
claim with none. A remote verifier must report `new` and
`candidate-equivalent` as claimed rather than proven, and `ok` never asserts
an unavailable conclusion. The repository-backed check remains the only one
that establishes absence, and it is unchanged by this decision.

### Versioning

`vcs-lab.proof-bundle/v2` is a new schema, not an amendment: v1 bytes,
members, and the repository-backed comparison are unchanged. A v2 verifier
accepts a v1 document and reports tier 0 only; a v1 verifier refuses a v2
document as `unknown-schema-version`, as it refuses every newer proof-bundle
version since #98. The verification
result gains a per-change tier and an explicit list of unavailable conclusions
with reasons. The published bound `proofBundleBytes` (16 MiB) applies to v2; a
producer whose proofs would exceed it refuses to emit rather than truncating,
naming the member that did not fit.

### What this is not

Signing (#38) proves who produced a bundle and nothing about whether it is
complete; a signed omission is still an omission. Lineage (#43) stays an
anchor: a v2 bundle from a history-filtered repository has different roots and
is refused as `different-repository` exactly as today.

## Rejected alternatives

- **Ship the object closure inline.** Trees and blobs make the bundle
  unbounded, and the only conclusion they add is the advisory patch heuristic.
- **Trust the producing CLI's prose.** The prose is what a verifier exists to
  not trust.
- **Signature only.** Authenticates the sender; leaves every fixture above
  passing.
- **Re-run the plan against a mirror.** A mirror is the repository; this is
  repository-backed verification with fetch access, not portable
  verification.
- **A sender-computed digest over the change list.** Binds nothing the sender
  did not choose. Only Git object ids are anchored by something the sender does
  not control.

## Consequences

- Bundles grow by the range's commit objects plus proof paths bounded by
  history depth, not by history size. The 16 MiB bound is unchanged.
- The verifier must hash Git objects itself for both object formats;
  `test/object-format.test.js` and the canonical JSON vectors are the pattern
  for the conformance fixtures this needs, including the four adversarial
  shapes above and a merge inside the source range.
- Absence stays unprovable remotely. A landing policy (#39) that receives a
  bundle without objects cannot treat `new` as verified; it fetches or trusts.
- No persisted state changes: notes, refs, and the retention carrier of
  ADR-0025 are read, not written.

## What the owner must decide

1. Accept the tiered contract, including that `new` and
   `candidate-equivalent` are reported as claimed, never proven, without
   objects.
2. Accept v2 as a new schema version rather than an amendment of v1.
3. Whether reachability paths to the target head are carried by default or on
   request, given bundle size on deep histories.
4. Whether receipt inclusion proofs anchor to the notes tip alone or also to
   the retention ref of ADR-0025.
5. Which channel supplies anchors first: a remote named in the bundle and read
   with `git ls-remote`, or deferral to #37.

## Owner decision (2026-09-17)

Accepted, with decision 5 refined:

1. The tiered contract is accepted: `new` and `candidate-equivalent` are
   reported as claimed, never proven, without objects.
2. `vcs-lab.proof-bundle/v2` is a new schema version; v1 is unchanged.
3. Reachability paths are **carried by default**. The #36 measurement put a
   recent landing's v2 bundle at 35.6 KB and the size bound out of reach until
   about 9,800 commits of path depth; an omit option waits for a real bundle
   that hits the refuse rule.
4. Receipt inclusion proofs **anchor to the notes tip only**. Every receipt in
   this repository's history is reachable without the ADR-0025 retention ref,
   which matters only on the source side of a hard squash.
5. Anchors come first from **`git ls-remote` against a remote the verifier
   chooses**. A remote named inside the bundle is a hint the verifier may
   offer, never a channel it trusts automatically, because the bundle's
   producer controls that name. The #37 gateway (ADR-0033) is not the first
   anchor channel.
