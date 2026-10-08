# ADR-0008: Keep Markdown canonical and specification metadata sparse

- **Status:** Accepted
- **Date:** 2026-08-20
- **Owners:** Repository maintainers
- **Related requirements:** GP-08, FR-SPEC-01 through FR-SPEC-13

## Context

Specification-driven AI development can create thousands of semantic entities.
Replacing Markdown with an opaque structured database would damage editor and
Git compatibility. Persisting a fully expanded sidecar for every revision
duplicates titles, locations, content hashes, and deterministic IDs, producing
more metadata than source.

The v0.5 expanded representation demonstrated useful identity and merge
semantics but measured 655,545 bytes for a corpus whose sparse equivalent is
11,240 bytes.

## Decision

- Keep Markdown as canonical, directly editable source.
- Track one sparse manifest per indexed document.
- Persist artifact/source identity, normalized source hash, optional Git blob
  identity, entity count, parser/ID algorithms, and only exceptional legacy ID
  overrides.
- Derive titles, positions, content hashes, semantic keys, and ordinary entity
  IDs from Markdown on demand.
- Use Git blob identity to skip unchanged tracked documents without opening
  them.
- Version parser, identity, manifest, rendering, and merge algorithms.

## Consequences

### Positive

- Source remains readable in any editor and forge.
- Metadata is small and ordinary identity is reproducible.
- Old IDs can survive migration without retaining all expanded fields.
- Unchanged indexing can perform zero document reads.

### Negative

- Materialized queries must parse Markdown.
- Parser changes need explicit migration and compatibility logic.
- A tracked sidecar still creates an additional file and transfer concern.
- Markdown is not an ideal native representation for every structured artifact.

## Alternatives considered

- **Expanded JSON sidecar:** rejected as the default because measurements show
  unacceptable duplication.
- **Embed IDs into Markdown text:** rejected because it pollutes human source
  and generated content.
- **Native structured-object store now:** deferred until real corpus semantics
  and storage needs satisfy the native implementation gate.
- **No stable metadata:** rejected because entity history, review anchors, and
  deterministic block merge require persistent artifact identity.

**Amendment 2026-08-28:** the gate referenced above is Gate B of
[ADR-0014](0014-split-the-native-implementation-gate-into-engine-and-store-gates.md).

## Invariant

The sidecar must never become the only place from which canonical document
content can be recovered.
