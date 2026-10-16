# ADR-0007: Keep resolution automation exact or deterministic

- **Status:** Accepted
- **Date:** 2026-08-20
- **Owners:** Repository maintainers
- **Related requirements:** GP-07, FR-RES-01 through FR-RES-08, FR-SPEC-07 through FR-SPEC-13

## Context

The product aims to reduce conflict work without hiding uncertainty. Textual
conflicts sometimes repeat with byte-identical inputs, and structured Markdown
often has independent edits that line merge cannot understand. Both cases can
be resolved without a language model, but they require different evidence.

## Decision

The highest automation tiers are:

1. **Exact resolution reuse:** ordered base/target/source blob identities match
   a recorded result exactly. Path is excluded; order is not.
2. **Deterministic semantic merge:** a versioned parser and merge algorithm
   produce one result from exact base/target/source document and manifest
   fingerprints.

Neither tier selects a result invisibly. A user applies a suggestion explicitly
or authorizes exact IDs and hashes through a pinned forecast. Multiple exact
results are ambiguous. Divergent same-entity edits, delete-versus-edit, and
incompatible ordering remain blocked.

Any future learned/model-assisted candidate must be a separate lower-confidence
tier with provenance and explicit review; it cannot masquerade as exact or
deterministic.

## Consequences

### Positive

- Repeated conflicts can be eliminated without fuzzy matching.
- Independent spec changes combine reproducibly.
- Audit records can distinguish created, accepted, modified, and rejected
  decisions.
- Model assistance can be added later without weakening established tiers.

### Negative

- Many real conflicts remain manual.
- Exact signatures do not generalize across changed context.
- Deterministic parsers and algorithms require versioning and migration.

## Alternatives considered

- **Always apply Git rerere automatically:** rejected because selection and
  provenance are insufficiently explicit for the product's trust model.
  Amended by [ADR-0018](0018-disable-git-rerere-inside-vlab-picks-and-landing-merges.md) on 2026-08-30: Git's own rerere is
  disabled inside every vlab cherry-pick and landing merge, so a resolution
  recorded in `.git/rr-cache` can neither enter a forecast, an application,
  or a landing nor be recorded by vlab's picks.
- **Use an LLM for every conflict:** rejected because nondeterminism and hidden
  judgment undermine reproducibility and safety.
- **Treat all Markdown lines independently:** rejected because semantic section
  identity and ordering matter.

## Invariant

Ambiguity is a first-class result, not an error to be papered over by an
arbitrary candidate.
