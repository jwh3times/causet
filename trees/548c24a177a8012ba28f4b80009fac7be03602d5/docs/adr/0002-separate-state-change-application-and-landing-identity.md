# ADR-0002: Separate state, change, application, and landing identity

- **Status:** Accepted
- **Date:** 2026-08-20
- **Owners:** Repository maintainers
- **Related requirements:** GP-02, FR-ID-01 through FR-ID-07

## Context

A Git commit identifies exact content, metadata, and parents. Rebase, amend,
cherry-pick, contextual conflict resolution, and squash legitimately produce a
new commit ID. Treating the commit as the only identity makes equivalent intent
look unrelated and makes different target-specific realizations look
indistinguishable at the workflow level.

Conversely, treating a stable logical ID as state identity would hide real byte
or parent differences.

## Decision

Maintain distinct identities for:

1. **state:** Git tree OID;
2. **revision:** Git commit OID;
3. **logical change:** stable `Change-Id` trailer;
4. **application:** target-context realization record;
5. **landing:** integration event and absorbed source set;
6. **reconciliation:** reviewed multi-change operation;
7. **workspace/checkpoint:** private development context and immutable draft
   capture;
8. **spec artifact/entity:** durable document and semantic anchor identity.

Same-intent rewriting preserves `Change-Id`. A semantic divergence uses an
explicit fork with a new ID and origin reference. Commits without a Change ID
use `git:<oid>` as an exact but rewrite-unstable fallback.

## Consequences

### Positive

- Rebase and cherry-pick continuity can be recognized.
- One logical change can have contextual applications without claiming equal
  commits or trees.
- Squash landings can retain an auditable absorbed set.
- Review and specification anchors can survive moves and rewrites.

### Negative

- Users and tooling must understand more than one identifier.
- Copied Change IDs can create false continuity if users fail to fork changed
  intent.
- Records need schemas, migration, collision diagnostics, and future trust.

## Alternatives considered

- **Commit ID only:** rejected because rewriting and squash erase continuity.
- **Patch ID as logical identity:** rejected because normalization is heuristic
  and does not establish intent.
- **Tree ID as change identity:** rejected because equal final states can arise
  from different intent and omit transition context.
- **One universal UUID for every layer:** rejected because it collapses
  different equality questions into one answer.

## Invariant

No proof or UI may imply that equality in one identity layer establishes
equality in every other layer.
