# ADR-0026: Version fence-aware Markdown boundaries

- **Status:** Accepted
- **Owners:** Repository maintainers
- **Related requirements:** FR-SPEC-01, FR-SPEC-02, FR-SPEC-04, FR-SPEC-08, FR-SPEC-13
- **Issue:** [#51](https://github.com/jwh3times/vcs-lab/issues/51)

## Context

The v1 parser recognizes headings and requirement declarations inside
fenced examples. A comment can become a separate merge unit, allowing divergent
edits in one real section to merge automatically and inserting whitespace into
an example. The shared semantic fixtures demonstrate both failures.

Manifest v3 fixes `stable-markdown-blocks/v1`. Correcting its interpretation in
place would change historical entities, occurrence-based IDs, semantic
signatures, and forecast results without changing their version. This decision
applies ADR-0008's versioning requirement and ADR-0020's compatibility rules;
neither decision is superseded. The new writer and planner use the versioned
contracts below; historical reads retain their stored parser semantics.

## Decision

### Supported fence syntax

`stable-markdown-blocks/v2` retains v1's heading and requirement syntax outside
the following literal regions. Preambles and heading sections remain the only
primary merge units; requirements remain query-only entities.

1. An opening fence starts after zero to three ASCII spaces, with a maximal run
   of at least three backticks or at least three tildes. A backtick opener's
   remaining text must contain no backtick. A tilde opener permits arbitrary
   remaining text. The remaining text is opaque information, not entities.
2. A closing fence starts after zero to three ASCII spaces, uses the same
   character with a run at least as long as the opener, and has only ASCII
   spaces or tabs after that run. A shorter run, other character, or nonblank
   suffix does not close the fence.
3. Opening and closing lines and every intervening line are excluded from both
   heading recognition and requirement recognition. Within a fence, only its
   closing rule is evaluated; fences do not nest. An unclosed fence extends to
   end of document.
4. Four leading spaces or a leading tab do not open or close a fence in this
   grammar. No list or blockquote prefixes are stripped. Indented code, HTML
   blocks, inline code, and container-aware Markdown parsing are outside this
   correction. This is an explicitly limited lexical grammar, not a claim of
   complete Markdown conformance.

Line numbers refer to the original document after existing CRLF/bare-CR to LF
normalization. Fence detection must not strip indentation, normalize information
text, or remove delimiters from source. A literal region belongs to its existing
preamble or heading section, so divergent edits to that section still produce
`same-block-edit`.

### Rendering

`stable-markdown-three-way/v2` retains section-level content selection and order
rules. It retains the documented rendering normalization: normalize newlines,
trim trailing whitespace at primary-block boundaries, join selected blocks with
two LF characters, and terminate the document with one LF. Interior fence bytes
remain intact; no artificial heading boundary may insert a separator inside a
fence. An unclosed fence at a block's end is subject to the same documented tail
trimming. This contract does not promise a byte-exact round trip at block ends.

### Version and reader contract

| Surface | Behavior |
| --- | --- |
| Manifest v1, v2, v3 reads | Keep historical v1 parsing and stored schema; reading never migrates or writes source/metadata |
| Manifest v4 | Sparse `vcs-lab.spec-manifest/v4`, fixing parser v2 and the existing `artifact-semantic-key-sha256/v1` ID algorithm |
| Index writes | Write v4; old manifests bypass every unchanged-input cache, even with identical source/blob hashes |
| Semantic plans | Write `vcs-lab.spec-merge-plan/v2` with merge algorithm v2; preserve the published v1 schema document unchanged |
| Spec benchmark output | Write `vcs-lab.spec-benchmark/v3`, because benchmark v2 fixes the writer manifest to v3 |
| Old readers | Refuse v4 manifests and unsupported plan versions; never label corrected boundaries as v1 |
| Unknown parser/ID versions | Refuse before cache reuse, migration, or mutation; `--force` does not authorize reinterpretation |

The manifest byte bound remains unchanged. Runtime family registries, published
schemas, compatibility tables, embedded plan consumers, and generated
architecture tables must agree in the implementation. New version values must
not be added to an old schema's fixed value merely to make new output validate.

### Identity-preserving migration

Indexing is the explicit migration operation. Preserve artifact identity and
canonical source bytes. Derive ordinary entity IDs with the existing algorithm
and persist exceptional correspondence only in `idOverrides`.

Migration must first recover the exact source associated with the old manifest,
checking its source hash with the existing v1 newline compatibility rule. Parse
that same source under both versions. Match surviving declarations by kind and
source declaration location, with the same heading level/title or requirement
name. Body equality is not required: removing a false heading necessarily
extends its containing section. A preamble matches only a surviving preamble.
Do not use the new occurrence key alone as proof of correspondence.

Retain each matched entity's old ID, including exceptional legacy IDs, under its
corrected key. Drop literal-only entities. Reserve every old entity ID during
migration so that a removed example entity cannot silently become an unrelated
real entity. If a default ID would reuse a reserved ID without correspondence,
allocate a deterministic exceptional ID and persist it. Derive candidates as
`ent_` plus the first 24 hex characters of SHA-256 over artifact ID, NUL,
`fence-migration/v2`, NUL, corrected key, NUL, and a decimal counter starting at
zero; increment until the candidate is not reserved or already assigned.
Conflicting old overrides or duplicate assigned IDs refuse migration.

For example, an example containing `# Topic` followed by a real `# Topic` has
v1 occurrences 1 and 2. Under v2 the real heading becomes occurrence 1 but keeps
the old real heading's occurrence-2 ID through an override. The example's ID
disappears. Apply the same rule to duplicate requirement names.

After establishing the corrected prior view, apply existing edit/reindex rules
to current source. This separates parser migration from simultaneous user
edits. If the old source cannot be verified, refuse before writing either file;
do not guess a correspondence from current dirty bytes or a matching title.
Recovery means restoring the missing original source object from Git history or
another clone and retrying indexing. Repeated indexing of a migrated manifest
must preserve its IDs and sparse bytes and regain the unchanged-input fast path.

### Historical and mixed-version merges

New automatic planning uses v2 semantics. For each existing input stage carrying
an old manifest, compare its historical and corrected entity views on that
stage's exact source. Compare kinds, keys, declaration positions, primary spans,
content hashes, and ID correspondence. If they agree, the stage is compatible
with v2 without rewriting the committed manifest. A deleted stage has no parser
version and does not create a version mismatch.

If any legacy stage's boundaries or identities differ, return a blocked v2 plan
with `parser-migration-required`, identifying affected stages. Publish no result
or reusable semantic signature. This applies even when all stages are legacy:
preserving historical queries must not preserve unsafe automatic merging.
Never silently reparse an affected base and then match its IDs to new heads.

For ongoing work, migrate and commit the common baseline before creating new
branches. Existing divergent branches with an affected historical base require
an ordinary reviewed Git merge and reindexing of the result, or a separately
reviewed history reconstruction. Migrating the two tips alone does not clear an
affected-base blocker. No automatic history rewrite is part of this correction.

### Forecast and resolution reuse

V2 semantic signatures include algorithm v2 and the exact ordered input
fingerprints, retaining source and manifest hashes. V1 signatures cannot
authorize v2 results. Recompute semantic decisions on forecast application and
refuse a stored v1 semantic approval before mutation; regenerate the forecast
under the new build. Forecasts with no semantic decisions continue under their
existing compatibility and staleness rules.

Preserve old forecast and completed-resolution records for inspection; do not
rewrite them into new meanings. Raw exact-resolution reuse remains governed by
the exact ordered Git conflict stages and existing approval rules. If applying
an exact resolution restores old manifest bytes, those bytes remain old and
still face the migration gate on subsequent semantic planning. Exact byte reuse
does not certify v2 entity correspondence. Pending operations containing old
semantic decisions must fail before advancing and remain exactly abortable.

## Acceptance evidence

The implementation must keep the v1 historical observations while adding a v2
profile to the [shared fixtures](../semantic-conformance/README.md). The v2
profile must cover all shared rules, not only the fence cases. Existing desired
#51 observations supply authored regression targets; they must not be replaced
with generated current output.

Additional fixtures must cover invalid backtick information text, closers with
nonblank suffixes, trailing tabs, tab/four-space indentation boundaries, multiple
fences and a real heading after closure, duplicate heading/requirement migration,
legacy ID overrides, missing prior source, unchanged-blob migration, unknown
versions under `--force`, compatible mixed versions, affected legacy bases,
old semantic forecasts, exact-resolution reuse, and pending-operation recovery.
Indexing must leave canonical bytes untouched, migration must remain sparse,
and clean rendering must retain interior literal bytes after documented
normalization. Use disposable repositories for all history-changing evidence.

Run the complete suite and all forced Git-session, forecast-engine, and native
read-engine modes required by AGENTS.md, plus schema/catalog compatibility,
documentation links, generated-table checks, and static checks. Implementation
evidence belongs on #51 or its PR. The current v2 fixtures demonstrate corrected
behavior; historical v1 views remain explicitly characterized.

## Alternatives and consequences

- Patching v1 in place is smaller but silently changes frozen historical
  semantics and can recycle an example's ID into a real declaration.
- Giving every document a new artifact identity avoids correspondence work but
  discards valid anchors and makes otherwise compatible branches disagree.
- Automatically converting affected merge bases avoids a migration barrier but
  introduces unreviewed correspondence into the very merge being authorized.
- Keeping v1 automatic merging indefinitely preserves replay but continues the
  false-clean behavior. Historical inspection is retained instead.

The decision adds a version transition and a visible barrier for some
in-flight branches. It preserves unaffected identities and ordinary sparse
storage, and makes the correction reviewable without extending merge granularity
or introducing a full Markdown dependency.
