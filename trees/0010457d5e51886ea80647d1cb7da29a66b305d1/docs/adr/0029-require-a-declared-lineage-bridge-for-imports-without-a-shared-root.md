# ADR-0029: Require a declared lineage bridge for imports without a shared root

- **Status:** Accepted
- **Decided:** 2026-09-17
- **Date:** 2026-09-14
- **Owners:** Repository maintainers
- **Implementation:** [#43](https://github.com/jwh3times/vcs-lab/issues/43)
  (open product question 1)
- **Related:** [#36](https://github.com/jwh3times/vcs-lab/issues/36),
  [#37](https://github.com/jwh3times/vcs-lab/issues/37),
  [#40](https://github.com/jwh3times/vcs-lab/issues/40),
  [ADR-0010](0010-add-a-validated-metadata-envelope-before-a-server.md),
  [ADR-0020](0020-freeze-per-family-compatibility-and-resource-bounds.md),
  [ADR-0025](0025-retain-the-object-closure-of-published-causal-facts.md)

## Context and decision

Envelope v1 identifies a repository's lineage as the sorted root commits
reachable from branches, tags, and remote-tracking refs
(`git-root-commits-sha256/v1`). An import whose lineage shares no root with the
destination is refused, and a proof bundle whose lineage differs is reported as
`different-repository`. ADR-0010 chose that rule over "an override with unclear
trust semantics". A history-filtered clone is the legitimate case the rule
excludes: after `git filter-repo` or an equivalent rewrite, every commit has a
new identity and there is no shared root by construction.

The decision proposed here answers question 1 in `docs/product.md` §17:

1. **The shared-root rule stays, and stays fail-closed.** Nothing inferred
   from content ever establishes lineage: not matching trees, not matching
   `Change-Id` trailers, not overlapping objects, not a replacement ref.
2. **The only additional evidence is a declared lineage bridge:** a record,
   declared by an identified actor, that names the pre-image lineage and the
   image lineage and carries the complete pre-image-to-image commit map as a
   retained Git object. The bridge is a claim in the sense of ADR-0010 and the
   identity protocol: it coordinates, it does not authenticate.
3. **A bridge is honored only where it has been accepted.** Declaring a
   bridge is portable; accepting one is a local, explicit act recorded in the
   repository's shared-local state. A clone that receives a declaration and
   has not accepted it treats the foreign lineage as unrelated, exactly as
   today.
4. **A bridge admits facts; it does not upgrade them.** Facts admitted through
   a bridge attach to pre-image commits. They become usable for planning only
   when carried onto image commits under the map as new records with
   `origin: carried`, the mechanism provenance already uses, and every claim a
   carried record makes is re-derived on the image side. What the map cannot
   re-establish is not carried.

The same mechanism serves a rewrite inside one repository, which the evidence
below shows strands every fact just as an import refusal does. This ADR settles
the rule; it selects no schema, command, or release. Implementation, if the
owner wants one, is an issue under Gate B alongside envelope v2 in #40.

## Evidence

Disposable repositories on the Windows host at source `b4200f8`, 2026-09-14.
`A` holds a compact landing and four provenance records; `B` is a clone of `A`
whose every branch commit was rebuilt with one file removed and parents remapped
through an old-to-new commit map, then reflog-expired and pruned; `C` is a
clone of `A` with an unrelated orphan root merged in; `D` is a clone of `B`
with `git replace --graft` pointing `B`'s root at `A`'s root. Transcripts are
retained on #43.

| Case | Command | Observed |
| --- | --- | --- |
| A imports B, B imports A | `vlab metadata import <env> --dry-run` | `unsupported-repository-shape`: "lineage is unrelated; v1 import requires a shared root commit", both directions |
| A verifies B's bundle, B verifies A's | `vlab verify-proof <bundle>` | `repository.reason: different-repository`, integrity intact, classification agrees, `ok: true` with the trust statement that evidence was not checked |
| B after the rewrite | `vlab metadata validate` | 5 of 5 records accepted, 0 quarantined: the retention root of ADR-0025 keeps every pre-image commit alive |
| B after the rewrite | `vlab provenance --all` | 4 commits inspected, 0 entries: every declared and carried record is attached to a pre-image commit no branch reaches |
| B after the rewrite | `vlab metadata export` | 5 records exported, all naming pre-image commits, under a lineage no clone of A shares |
| C imports A | `vlab metadata import --dry-run` | `lineageRelation: fork`, applicable |
| C verifies A's bundle | `vlab verify-proof` | `different-repository`: verification requires an identical lineage id, import accepts a shared root |
| D imports A | `vlab metadata import --dry-run` | `lineageRelation: same`, 5 records addable, no object problems |
| D roots | `git rev-list --max-parents=0 ...` with and without `--no-replace-objects` | A's root with replacements honored, B's root without |

Three findings follow. A history rewrite strands facts inside the repository
that performed it, before any import is attempted, so the problem is a
rewrite-mapping problem first and a transport problem second. A local
replacement ref, which is never pushed by default and authenticates nothing,
already satisfies the shared-root rule silently. And the two lineage checks
disagree about forks.

## What a lineage bridge is

A bridge names, at minimum:

- the pre-image lineage and the image lineage, each as the full identity
  (`algorithm`, `objectFormat`, `rootCommits`, `id`), never the id alone;
- the commit map from every pre-image commit to its image commit, stored as a
  blob under the retention root so the map is object-addressed, digest-checked
  by the envelope, and cannot drift from the record that names it;
- the declaring actor and a free-text reason, as `vcs-lab.provenance/v1`
  already carries for authorship.

A bridge is refused, not quarantined, when the map is incomplete for the
commits a fact names, when an image commit does not exist locally, or when
either lineage identity does not match what the repository computes. Refusal
is the envelope disposition ADR-0020 already fixes for untrusted input.

Acceptance is a separate act. `vlab metadata import` and `vlab verify-proof`
honor a bridge only when the destination repository has recorded acceptance of
that bridge's digest; the relation is then reported as `bridged`, a new value
that is never collapsed into `same` or `fork`. Without acceptance the relation
is `unrelated` and the outcome is the refusal observed above.

Carrying a fact through a bridge produces a new record on the image commit,
with `origin: carried`, naming the pre-image record id, its digest, and the
pre-image lineage. Identifiers are not rewritten and digests are not restated:
the pre-image record stays what it was, quarantined or unreachable, and the
image record is a distinct fact. A landing receipt whose reviewed-tree equality
no longer holds on the image side, because the rewrite changed the trees, is
carried without that claim and therefore proves nothing under the ADR-0004
lattice; an exact resolution whose three stages survive the rewrite unchanged
keeps its signature and stays exact.

Envelope v2, which #40 requires to be a strict superset of v1, adds the bridges
an exporter holds to `manifest.repository.lineage`. The capability negotiation
of #37 advertises `lineage-bridge/v1`; a peer that does not advertise it never
sees a bridged relation and stays fail-closed by construction.

## Rejected alternatives

- **Matching tree or blob hashes.** Two unrelated repositories can share
  trees legitimately (vendored code, templates), and a filter that removes a
  file changes every tree, so this proves the wrong thing in both directions.
- **Matching `Change-Id` trailers.** A trailer is a line of text anyone can
  write; the identity protocol says identifiers coordinate and do not
  authenticate. Lineage inferred from them would let a copied trailer inject
  foreign facts.
- **Trusting `git replace` or grafts.** Case D shows this is what happens
  today by accident. A replacement ref is local, unsigned, and invisible to the
  envelope; honoring it makes the fail-closed rule a fiction.
- **Majority or threshold object overlap.** A threshold converts a refusal
  into a probability, and every fact admitted below certainty would need a
  lattice tier that ADR-0004 and ADR-0007 deliberately do not have.
- **An `--allow-unrelated` import flag.** This is the override ADR-0010
  declined: it admits facts that name commits the destination does not hold,
  and it records nothing a later reader could audit.
- **Rewriting attachments on import.** Silently retargeting a record to an
  image commit changes its digest while keeping its id, which is the exact
  shape the import rule refuses as a conflict.

## Consequences

- Envelope v1 is unchanged. No fact admitted today changes disposition.
- Two hardenings are independent of the bridge and are filed as defects:
  compute lineage with replacement objects disabled
  ([#88](https://github.com/jwh3times/vcs-lab/issues/88)), and let
  `verify-proof` report `fork` distinctly from `different-repository` so a
  legitimate fork receives accurate advice
  ([#89](https://github.com/jwh3times/vcs-lab/issues/89)).
- A bridge adds one shared-portable declaration family and one shared-local
  acceptance record to the compatibility table, both with the refuse
  disposition; the identity protocol gains no namespace until a family exists.
- Carried-through-rewrite records make the `carried` origin, today specific to
  provenance, a general concept; ADR-0004's lattice needs no new tier because
  a carried claim is re-derived and classified on the image side like any
  other.
- Filtered repositories that never declare a bridge keep working exactly as
  now, with an empty usable fact history and the pre-image repository as the
  archive. That is the zero-cost answer and remains available.

## What the owner must decide

1. Whether question 1 is answered as proposed, "yes, only through a declared
   and locally accepted bridge", or as "no, filtered histories start fresh",
   which needs no work and remains the default until a bridge exists.
2. Whether bridge acceptance is local-only, as recommended, or may travel with
   the declaration.
3. Whether carried-through-rewrite records may contribute coverage once
   re-derived on the image side, or are admitted for audit and history only.
4. Whether implementation waits for envelope v2 under #40, as recommended,
   or is scoped as its own Gate B increment.

## Owner decision (2026-09-17)

Accepted with the recommended answer to each question:

1. Question 1 is answered **yes, only through a declared and locally accepted
   lineage bridge**. Nothing inferred from content establishes lineage.
2. Acceptance is **local-only**: each clone records acceptance of a bridge's
   digest, and a received declaration alone changes nothing.
3. Carried-through-rewrite records **may contribute coverage** once every
   claim is re-derived on the image side; a claim that does not re-derive
   proves nothing.
4. Implementation **waits for envelope v2** under #40.
