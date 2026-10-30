# Compatibility, migration, and resource bounds

This document is the published contract for how vcs-lab treats a stored record
it did not write: what may change inside one schema version, which versions each
family reads and writes, what a reader does with a version it does not know, and
how large a record may be before it is refused or quarantined. It extends the
[schema catalog](README.md) (ADR-0015 phase 0b, issue #11 item 4) and is decided
by [ADR-0020](../adr/0020-freeze-per-family-compatibility-and-resource-bounds.md).

**Authority.** `RECORD_FAMILIES` and `RESOURCE_BOUNDS` in `src/schemas.js` are
the runtime authority; the tables below are their published description.
`test/schema-compatibility.test.js` fails the suite when this document and the
runtime registry disagree, and exercises each disposition against the real CLI.

## 1. What may change inside one version

Catalog documents are open: a reader tolerates unknown members and must never
rewrite a record to drop them. Within one `family/vN`, a writer may:

- add an optional member;
- add a value to a member whose vocabulary readers already treat as opaque;
- widen an accepted value (a nullable member that was never null before);
- relax a resource bound upward.

A change that is none of these requires a new version `vN+1`:

- removing or renaming a member, or making an optional member required;
- changing a member's type, cardinality, or unit;
- changing the meaning of an existing value, or narrowing an accepted set;
- changing any byte layout a hash or signature covers.

Two consequences follow. A reader must not treat "member absent" as an error
unless the catalog document lists it in `required`, and a writer must not emit a
member whose meaning an older reader would get wrong — that is a version bump,
not an addition.

## 2. Version rules per family

`Written` is what this build emits, `also read` is what it additionally accepts,
and `unknown version` is what it does with anything else in that family. A
version in `also read` is migrated forward as section 3 describes.

| Family | Scope | Written | Also read | Unknown version | Store |
| --- | --- | --- | --- | --- | --- |
| `vcs-lab.note` | note-container | v1 | — | ignore | refs/notes/vcs-lab note blobs |
| `vcs-lab.landing` | note-record | v1 | — | quarantine | refs/notes/vcs-lab note containers |
| `vcs-lab.application` | note-record | v1, v4 | — | quarantine | refs/notes/vcs-lab note containers |
| `vcs-lab.reconciliation` | note-record | v6 | — | quarantine | refs/notes/vcs-lab note containers |
| `vcs-lab.rebase-application` | note-record | v1 | — | quarantine | refs/notes/vcs-lab note containers |
| `vcs-lab.rebase` | note-record | v2 | v1 | quarantine | refs/notes/vcs-lab note containers |
| `vcs-lab.provenance` | note-record | v1 | — | quarantine | refs/notes/vcs-lab note containers |
| `vcs-lab.resolution` | note-record | v1 | — | quarantine | refs/notes/vcs-lab note containers |
| `vcs-lab.reconciliation-operation` | private | v4 | — | refuse | `<git dir>/vcs-lab/reconciliation.json` |
| `vcs-lab.rebase-operation` | private | v2 | — | refuse | `<git dir>/vcs-lab/rebase.json` |
| `vcs-lab.forecast` | private | v2 | v1 | refuse | `<git dir>/vcs-lab/forecasts/<id>.json` |
| `vcs-lab.rebase-forecast` | private | v2 | — | refuse | `<git dir>/vcs-lab/forecasts/<id>.json` |
| `vcs-lab.workspaces` | shared-local | v1 | — | refuse | `<common dir>/vcs-lab/workspaces.json` |
| `vcs-lab.workspace` | shared-local | v1 | — | refuse | entries of `<common dir>/vcs-lab/workspaces.json` |
| `vcs-lab.quarantined-record` | shared-local | v1 | — | refuse | refs/vcs-lab/quarantine/<lineage>/<record id> blobs |
| `vcs-lab.dispositions` | shared-local | v1 | — | refuse | `<common dir>/vcs-lab/dispositions.json` |
| `vcs-lab.disposition` | shared-local | v1 | — | refuse | entries of `<common dir>/vcs-lab/dispositions.json` |
| `vcs-lab.spec-manifest` | tracked | v4 | v1, v2, v3 | refuse | `.vcs-lab/specs/**` |
| `vcs-lab.metadata-envelope` | envelope | v1 | — | refuse | `manifest.json` of a metadata export directory |
| `vcs-lab.proof-bundle` | envelope | v2 | v1 | refuse | a file handed to vlab verify-proof |
| `vcs-lab.capabilities` | advertisement | v1 | — | refuse | produced on demand by vlab capabilities; served by a gateway |

`vcs-lab.application` writes two versions on purpose: `vlab cherry-pick`
publishes `v1` and reconciliation publishes the richer `v4`. Both are current;
neither supersedes the other.

CLI-output families (`vcs-lab.merge-plan/v1` and the rest of the catalog's
CLI-output table) are not persisted and carry no compatibility rule. They are
produced fresh by the command that prints them, so a consumer sees exactly the
version of the build it ran.

### Why the dispositions differ by scope

The rule follows from who wrote the record and what is lost by guessing.

- **Shared-portable notes are quarantined, never refused.** They arrive by
  `git fetch` from clones that may run a newer vcs-lab, so an unknown version is
  an ordinary event, not a fault. An unknown record is reported by
  `vlab metadata status`, excluded from coverage proof and planning, and left on
  disk untouched. A single bad record from a peer must never stop local work,
  and untrusted input must never be interpreted (NFR-SEC-03).
- **Note containers are ignored and protected.** A container of another version
  yields no records, and `appendNote` refuses to rewrite it: `git notes add -f`
  replaces the whole blob, so publishing a receipt into a container this build
  cannot read would destroy the peer's data. Publishing fails closed instead.
  Unparsable note text is different — it is preserved as one opaque
  `legacy-note` record so a rewrite keeps it.
- **Worktree-private journals and forecasts are refused.** Resuming an
  operation means acting on a queue, a cursor, and recovery fields; interpreting
  those from a version we do not understand could move refs the writer never
  intended. The state is local and disposable, so refusing costs only the
  operation: recover with the build that wrote it, or delete the file.
- **The shared-local workspace registry is refused.** It is the only record of
  which worktrees vcs-lab materialized, and every mutation rewrites the whole
  file, so consuming a version we do not understand would silently drop its
  members.
- **The disposition registry is refused, and so is a parked record.** Both are
  shared-local, both are written only by this build, and both carry a decision a
  person made: the registry says which digest of a disputed fact was kept, and a
  parked record is the copy that lost. Interpreting either from a version we do
  not understand could return the wrong copy of a causal fact to service, so the
  command refuses and says which build to read it with. `vlab metadata status`
  is the exception its scope already allows: it reports an unreadable parked
  record as a diagnostic and keeps scanning, exactly as it does for a
  workspace registry it cannot parse (ADR-0030).
- **Tracked spec manifests are refused forward and migrated backward.** They are
  committed, derived, and rebuildable, so an unreadable one is repaired by
  re-indexing rather than guessed at.
- **Envelopes and proof bundles are refused.** Both are documents handed
  between hosts and read before anything in them is trusted. Import is an
  explicit, auditable act on untrusted input, and verification exists precisely
  to not trust the sender, so a version mismatch is reported rather than
  partially applied. A v1 proof bundle is still read: it carries no Git
  bindings, so a verifier reports only the self-consistent tier for it and says
  which conclusions that leaves unavailable (ADR-0031).
- **Capability documents are refused.** A client cannot negotiate from a
  document it does not understand: every conclusion it would draw — which
  versions to send, which records to withhold, which bound applies — would be
  drawn from members it could not read. Refusing costs exactly one exchange and
  names the version, so the remedy is obvious (ADR-0033). The document is also
  the one input a client reads *before* it has decided anything about the peer,
  which is why `capabilityDocumentBytes` is checked before it is parsed.

## 2.1 Superseded values inside a version

A value can be retired without retiring its family, when nothing branches on
it. The `proof` member of a coverage classification is the current case.

| Member | Retired value | Replaced by | Since |
| --- | --- | --- | --- |
| `proof` (`vcs-lab.merge-plan/v1`, `vcs-lab.rebase-plan/v1` and `/v2`, `vcs-lab.rebase/v1` and `/v2`, `vcs-lab.rebase-forecast/v1` and `/v2`) | `signed-shaped-landing-receipt` | `receipt-commit` | v0.12.0 |

The old label printed the word *signed* in every plan for a record that nothing
signs. Renaming it is permitted inside the version because the value is opaque
to every reader: `proof` is carried and displayed, never branched on. Writers
emit `receipt-commit`; a record written by an earlier build keeps
`signed-shaped-landing-receipt` and is passed through unchanged, so no record
changes meaning and nothing is narrowed.

Retiring a value that a reader **does** branch on is a different change and
needs a version bump, because it narrows an accepted set.

## 3. Migration

Only two families read a version they do not write.

**`vcs-lab.spec-manifest` v1, v2, and v3 migrate to v4 on indexing,
not on read.** Historical reads retain parser v1 and the stored schema. The
new writer uses fence-aware parser v2; every older manifest bypasses unchanged
source/blob caches. Migration verifies the old source, matches surviving real
declarations by location, and retains their IDs through sparse overrides when
occurrence keys shift. Missing prior source or conflicting IDs refuse migration
before writing metadata. Unknown parser/ID versions refuse even with
`--force`. The v1 CRLF source-hash compatibility rule is retained.

[ADR-0026](../adr/0026-version-fence-aware-markdown-boundaries.md) specifies the
fence grammar, correspondence rules, and recovery. A legacy merge input whose
boundaries change blocks new automatic planning with
`parser-migration-required`; unaffected legacy inputs may participate without
rewriting history. Old semantic forecast approvals and pending semantic
decisions cannot authorize v2 results. Regenerate the forecast, or abort and
restart the pending operation. Raw exact-resolution records retain their
existing byte-based approval rules.

**`vcs-lab.proof-bundle` v1 is read but never written.** A v2 bundle is a
strict superset: the v1 members and the repository-backed comparison are
unchanged, and v2 adds the bound source inventory, reachability and inclusion
proofs, and the anchors. Nothing migrates a v1 bundle forward — it is a document
someone already produced, not a store — so a v1 bundle simply reaches a lower
tier of conclusion, which the verification result states.

**`vcs-lab.rebase` v1 is read but never written and never rewritten.** A v2
receipt is a strict superset: every v1 member means what it always did, and v2
adds `recreatedMerges`. A v1 receipt was necessarily written by a rewrite with
no merge in range, because no earlier build could execute one, so reading it as
a rewrite that recreated nothing is exact rather than an assumption
(ADR-0034).

**The rebase journal and rebase forecast are refused at v1 rather than
migrated.** Both are worktree-private and both describe *a rewrite in flight*.
A v1 journal's queue cannot express a recreated merge or the parent mapping one
needs, so resuming from it would mean guessing a shape and moving refs from the
guess. A v1 forecast pins a v1 plan fingerprint, and a v2 plan hashes the
preserved topology, so no v1 forecast can approve a v2 plan — refusing it by
version says *regenerate*, where accepting it would say *stale* for a reason the
reader could not act on. A forecast costs one command to regenerate; a journal
in flight is finished or aborted with the build that wrote it (ADR-0020,
ADR-0034).

**`vcs-lab.forecast` v1 is read but never written and never rewritten.** A v1
forecast is accepted by `forecastForPlan` and read field by field; it is not
back-filled, and the staleness and fingerprint checks apply to it unchanged. It
has no catalog document; the catalog lists it as superseded.

No migration ever runs implicitly on a shared-portable record. Note records are
migrated only by publishing a new record, never by rewriting a peer's note.

## 4. Resource bounds

Every bound is a constant in `RESOURCE_BOUNDS` (`src/schemas.js`), not
configuration, so every implementation of this contract agrees. Bounds are
checked before a record is interpreted — a note over `noteContainerBytes` is
never parsed — and each fails closed in the way its scope requires: a
shared-portable input is quarantined, and a worktree-private, shared-local,
tracked, or imported input refuses the command.

| Bound | Bytes or count | Applies to | On excess |
| --- | --- | --- | --- |
| `noteContainerBytes` | 8388608 | One `refs/notes/vcs-lab` note blob, and one `refs/vcs-lab/quarantine/**` parked-record blob | Quarantine: no records, `oversize-record` warning from `vlab metadata status`, and `appendNote` refuses to rewrite it. A parked blob over the bound is reported by `vlab metadata status` and refused by `vlab metadata dispose`; parking a record that would cross it is refused |
| `noteContainerRecords` | 4096 | Records in one note container | Quarantine, as above; an append that would cross the bound is refused |
| `localStateBytes` | 67108864 | One `vcs-lab/**` JSON file in the git or common directory | Refuse before reading the file |
| `specManifestBytes` | 8388608 | One `.vcs-lab/specs/**` manifest, in the working tree or at a revision | Refuse |
| `envelopeManifestBytes` | 16777216 | `manifest.json` of a metadata envelope | Refuse |
| `envelopeBundleBytes` | 2147483648 | The `objects.bundle` size an envelope declares | Refuse |
| `envelopeRecords` | 1000000 | Records one envelope declares | Refuse |
| `provenanceActors` | 64 | Actors in one `vcs-lab.provenance/v1` record | Refuse the write; a landing's provenance is the union of every absorbed commit's actors, so this bounds what one branch can accumulate before the claim stops being reviewable by a person |
| `proofBundleBytes` | 16777216 | One `vcs-lab.proof-bundle/v1` or `/v2` document handed to `vlab verify-proof` | Refuse before reading the file. A producer whose proofs would exceed it refuses to emit and names the member that did not fit, rather than truncating: a truncated proof cannot be told apart from an omission, which is the attack the bound inventory exists to catch |
| `capabilityDocumentBytes` | 1048576 | One `vcs-lab.capabilities/v1` document read by `vlab capabilities --against` or from a gateway | Refuse before parsing the document |

Bounds divide in one more way once a peer is involved. **Bounds are the
receiver's**: the bound that governs what this build may send is the peer's, and
the bound that governs what it may be sent is its own. A capability document
advertises the bounds that apply to exchanged families, so a sender withholds an
over-bound record and reports it rather than sending it to be refused
(ADR-0033). `ADVERTISED_BOUNDS` and `UNADVERTISED_BOUNDS` in
`src/capabilities.js` must together name every bound in the table above, each
unadvertised one carrying its reason, so a new bound cannot be added without
deciding whether a peer needs it.

`readJson` in `src/store.js` is the single reader for every worktree-private and
shared-local document, which is why `localStateBytes` is enforced there and
covers the reconciliation journal, the rebase journal, every stored forecast, and
the workspace registry at once. The same reader refuses malformed JSON as a
domain error naming the file rather than surfacing a bare `SyntaxError`.

### Transport bounds

These bound the Git plumbing rather than a record family, and are enforced in
`src/git.js` and its workers. They are listed here so the complete set of limits
is in one place.

| Bound | Value | On excess |
| --- | --- | --- |
| `maxBuffer` for every Git process | 256 MiB | The command fails with the Git invocation error |
| `SESSION_TIMEOUT_MS` | 60000 ms | Object session: disabled, reads fall back to one process per query. Merge-tree session: the forecast fails |
| `SESSION_INFO_BUFFER_BYTES` | 1 MiB | Object session reports `response-too-large`, is disabled, and falls back |
| `SESSION_CONTENT_BUFFER_BYTES` | 64 MiB | As above; contents are base64 in the response, so the effective object ceiling per batch is lower |
| `MERGE_TREE_RESPONSE_BYTES` | 64 KiB | The merge-tree session fails; there is no fallback for it |
| Worker stderr capture | 64 KiB | Silently truncated, keeping the tail |

### Bounds that deliberately do not exist yet

Naming these is part of the contract; they are growth limits, not safety limits,
and each needs a retention design rather than a constant.

- No cap on the number of notes, note targets, or causal records in a
  repository. `vlab metadata status` reads every note in one batch and holds the
  whole inventory in memory.
- No cap on operation-journal queue length, on the number of stored forecasts
  (nothing prunes `<git dir>/vcs-lab/forecasts/`), on registered workspaces, or
  on retained checkpoint-history and resolution refs.
- No cap on tracked path count, spec file size, or blocks per document outside
  the benchmark commands.

The per-file `localStateBytes` bound is what keeps each of these from becoming
an unbounded single read today. ADR-0013's incremental-catalog row is the
decision point at which repository-wide retention and pagination get designed.

## 5. Changing this contract

A change to any table here changes a published contract, so it needs the same
treatment as a schema change (NFR-TEST-03): a new ADR when it reverses a
durable decision, a version bump when it breaks a reader, a migration test when
it changes what an older record means, and an update to `RECORD_FAMILIES` or
`RESOURCE_BOUNDS` in the same commit — the suite fails if the runtime and this
document disagree.

## 6. Known inconsistency

`vlab metadata validate` reports an unsupported `vcs-lab.spec-manifest` version
as a warning and keeps scanning, while `materializeManifest` refuses the same
manifest with an error. This is deliberate — validation is a report over
everything present, and only a command that must interpret a manifest fails —
but the two severities are worth knowing about when reading a validation report.
