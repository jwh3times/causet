# Schema catalog

This directory is the published, versioned contract catalog for every
persisted and automation-facing vcs-lab record family and for the CLI's JSON
outputs (FR-GIT-06; ADR-0015 phase 0b, tracked by issue #11). Each
`*.schema.json` file is a standalone JSON Schema (draft 2020-12) document for
one `family/version`.

**Authority.** The executable validators and the schema registry in
`src/schemas.js` remain the runtime authority: they decide what the CLI
accepts, quarantines, and publishes. These documents are the published
description of those contracts. `test/schema-catalog.test.js` fails the suite
when the two disagree: every schema identifier used in `src/` must have a
document (or be listed as superseded below), records produced by the real CLI
must satisfy their documents, and a note record the runtime validator rejects
for a missing field must be rejected by its document too.

**Companion documents.** [compatibility.md](compatibility.md) freezes the
compatibility, migration, unknown-version, and resource-bound rules per family;
the [canonical JSON profile](../canonical-json/README.md) freezes the
byte-exact serialization used for hashing; the
[human/JSON conformance contract](../conformance/README.md) pins which command
output is text, which is JSON, and which members the two must agree on.

## Conventions

- `$id` is the schema identifier exactly as records carry it in their
  `schema` field (for example `vcs-lab.landing/v1`). Documents reference each
  other by `$id` (`{"$ref": "vcs-lab.merge-plan/v1"}`), so a resolver must
  preload the catalog; identifiers are not resolvable URLs.
- File names are `<family>.v<N>.schema.json` with the `vcs-lab.` prefix
  dropped.
- Object IDs are Git OIDs of the repository's object format: 40 hex
  characters for SHA-1, 64 for SHA-256. The documents accept either length;
  the runtime validators enforce the repository's actual format.
- Documents are open: unknown members are tolerated, and `required` lists
  only what the current writer always emits. What may change inside one
  version, which versions each family reads and writes, what a reader does
  with a version it does not know, and how large a record may be are frozen
  per family in [compatibility.md](compatibility.md) (ADR-0020), whose runtime
  authority is `RECORD_FAMILIES` and `RESOURCE_BOUNDS` in `src/schemas.js`.
  In short: unknown portable record schemas are quarantined rather than
  consumed (`vlab metadata status` reports them), and unsupported private,
  shared-local, tracked, or envelope schemas are refused with an error.
- `x-vcs-lab-scope` annotates each document with its persistence scope and
  must agree with `schemaClassification` in `src/schemas.js`; `cli-output`
  marks a family that exists only as command output.

## Record families

### Shared-portable (Git notes under `refs/notes/vcs-lab`)

| Schema | Document | Purpose |
| --- | --- | --- |
| `vcs-lab.note/v1` | [note.v1.schema.json](note.v1.schema.json) | Container for the records attached to one Git object |
| `vcs-lab.landing/v1` | [landing.v1.schema.json](landing.v1.schema.json) | Compact or hard-squash landing receipt |
| `vcs-lab.application/v1` | [application.v1.schema.json](application.v1.schema.json) | Direct cherry-pick application receipt |
| `vcs-lab.application/v4` | [application.v4.schema.json](application.v4.schema.json) | Reconciliation application receipt with conflict decisions |
| `vcs-lab.reconciliation/v6` | [reconciliation.v6.schema.json](reconciliation.v6.schema.json) | Final reconciliation summary receipt |
| `vcs-lab.rebase-application/v1` | [rebase-application.v1.schema.json](rebase-application.v1.schema.json) | Origin-to-rewritten-commit mapping receipt |
| `vcs-lab.rebase/v1` | [rebase.v1.schema.json](rebase.v1.schema.json) | Completed causal rebase receipt |
| `vcs-lab.resolution/v1` | [resolution.v1.schema.json](resolution.v1.schema.json) | Exact resolution result and provenance |
| `vcs-lab.provenance/v1` | [provenance.v1.schema.json](provenance.v1.schema.json) | Declared authorship provenance, carried across rewrites |

### Worktree-private (`.git/vcs-lab/` of one worktree)

| Schema | Document | Store |
| --- | --- | --- |
| `vcs-lab.reconciliation-operation/v4` | [reconciliation-operation.v4.schema.json](reconciliation-operation.v4.schema.json) | `reconciliation.json` journal |
| `vcs-lab.rebase-operation/v1` | [rebase-operation.v1.schema.json](rebase-operation.v1.schema.json) | `rebase.json` journal |
| `vcs-lab.forecast/v2` | [forecast.v2.schema.json](forecast.v2.schema.json) | `forecasts/<id>.json` |
| `vcs-lab.rebase-forecast/v1` | [rebase-forecast.v1.schema.json](rebase-forecast.v1.schema.json) | `forecasts/<id>.json` |

### Shared-local (common Git dir, not exported)

| Schema | Document | Store |
| --- | --- | --- |
| `vcs-lab.workspaces/v1` | [workspaces.v1.schema.json](workspaces.v1.schema.json) | `<common dir>/vcs-lab/workspaces.json` |
| `vcs-lab.workspace/v1` | [workspace.v1.schema.json](workspace.v1.schema.json) | Entries of the registry |

### Tracked-portable (committed beside the working tree)

| Schema | Document | Store |
| --- | --- | --- |
| `vcs-lab.spec-manifest/v3` | [spec-manifest.v3.schema.json](spec-manifest.v3.schema.json) | `.vcs-lab/specs/**` |
| `vcs-lab.spec-manifest/v2` | [spec-manifest.v2.schema.json](spec-manifest.v2.schema.json) | Superseded; read and migrated forward |
| `vcs-lab.spec-manifest/v1` | [spec-manifest.v1.schema.json](spec-manifest.v1.schema.json) | Superseded; read and migrated forward |

### Envelope (metadata export directory)

| Schema | Document | Store |
| --- | --- | --- |
| `vcs-lab.metadata-envelope/v1` | [metadata-envelope.v1.schema.json](metadata-envelope.v1.schema.json) | `manifest.json` beside `objects.bundle` |

### CLI-output families

These families exist only as command output; they carry a `schema` field so
automation can dispatch on them, but they are not persisted by vcs-lab.

`vcs-lab.error/v1` is the failure envelope of
[ADR-0021](../adr/0021-give-failures-a-versioned-machine-readable-envelope.md).
Unlike the others it is printed *instead of* a command's success output, on
stdout, when the invocation asked for `--json`; its closed error-code
vocabulary is published in [errors.md](errors.md).

| Schema | Document |
| --- | --- |
| `vcs-lab.merge-plan/v1` | [merge-plan.v1.schema.json](merge-plan.v1.schema.json) |
| `vcs-lab.identity-audit/v1` | [identity-audit.v1.schema.json](identity-audit.v1.schema.json) |
| `vcs-lab.proof-bundle/v1` | [proof-bundle.v1.schema.json](proof-bundle.v1.schema.json) |
| `vcs-lab.proof-verification/v1` | [proof-verification.v1.schema.json](proof-verification.v1.schema.json) |
| `vcs-lab.rebase-plan/v1` | [rebase-plan.v1.schema.json](rebase-plan.v1.schema.json) |
| `vcs-lab.checkpoint/v1` | [checkpoint.v1.schema.json](checkpoint.v1.schema.json) |
| `vcs-lab.workspace-prune/v1` | [workspace-prune.v1.schema.json](workspace-prune.v1.schema.json) |
| `vcs-lab.spec-merge-plan/v1` | [spec-merge-plan.v1.schema.json](spec-merge-plan.v1.schema.json) |
| `vcs-lab.spec-benchmark/v2` | [spec-benchmark.v2.schema.json](spec-benchmark.v2.schema.json) |
| `vcs-lab.repository-scale-benchmark/v1` | [repository-scale-benchmark.v1.schema.json](repository-scale-benchmark.v1.schema.json) |
| `vcs-lab.metadata-status/v1` | [metadata-status.v1.schema.json](metadata-status.v1.schema.json) |
| `vcs-lab.metadata-validation/v1` | [metadata-validation.v1.schema.json](metadata-validation.v1.schema.json) |
| `vcs-lab.metadata-export/v1` | [metadata-export.v1.schema.json](metadata-export.v1.schema.json) |
| `vcs-lab.metadata-import-preview/v1` | [metadata-import-preview.v1.schema.json](metadata-import-preview.v1.schema.json) |
| `vcs-lab.metadata-import/v1` | [metadata-import.v1.schema.json](metadata-import.v1.schema.json) |
| `vcs-lab.engine-differential/v1` | [engine-differential.v1.schema.json](engine-differential.v1.schema.json) |
| `vcs-lab.error/v1` | [error.v1.schema.json](error.v1.schema.json) |

### Superseded identifiers without documents

| Schema | Status |
| --- | --- |
| `vcs-lab.forecast/v1` | Superseded by `vcs-lab.forecast/v2`; still accepted when reading stored forecasts, never written. |

## CLI JSON output catalog

Every command below accepts `--json` (or always prints JSON) and its output
is versioned as follows. "Projection" means a stable unversioned wrapper
whose members are listed here; the schema-bearing families inside it are
documented above. Human-readable output of the same commands presents the
same state (FR-GIT-06); [`docs/conformance/`](../conformance/README.md) pins
that parity field by field and records which commands have no human
rendering at all.

| Command | JSON output |
| --- | --- |
| `vlab commit` | Projection `{commit, changeId, message}` |
| `vlab merge-plan` | `vcs-lab.merge-plan/v1` |
| `vlab audit identity` | `vcs-lab.identity-audit/v1`; exits non-zero when findings are reported |
| `vlab proof-bundle` | `vcs-lab.proof-bundle/v1`; always JSON, since the bundle exists to be handed to another tool |
| `vlab verify-proof` | `vcs-lab.proof-verification/v1`; exits non-zero when the bundle does not verify |
| `vlab rebase-plan` | `vcs-lab.rebase-plan/v1` |
| `vlab rebase-forecast` | `vcs-lab.rebase-forecast/v1` |
| `vlab rebase`, `vlab rebase --continue` | Projection `{operationId, plan, receipt}` with `plan` a `vcs-lab.rebase-plan/v1` and `receipt` a `vcs-lab.rebase/v1` |
| `vlab rebase --status` | Projection: `{active: false, state: "idle"}`, or `{active, operationId, state, worktree, sourceRef, sourceHead, sourceBranchRef, ontoRef, ontoHead, forecastId, progress, current, applied, recovery, timings, startedAt, updatedAt}` with `applied` an array of `vcs-lab.rebase-application/v1` |
| `vlab rebase --abort` | Projection `{aborted, operationId, sourceRef, restoredHead}` |
| `vlab forecast` | `vcs-lab.forecast/v2` |
| `vlab reconcile`, `vlab reconcile --continue` | Projection `{operationId, plan, receipt}` with `plan` a `vcs-lab.merge-plan/v1` and `receipt` a `vcs-lab.reconciliation/v6` |
| `vlab reconcile --status` | Projection like `rebase --status` (with `targetBranchRef` in place of `sourceBranchRef`, without `ontoRef`/`ontoHead`; `recovery` names the expected and actual branch, with `branchMatches` null for a journal written before the branch was recorded) with `applied` an array of `vcs-lab.application/v4` |
| `vlab reconcile --abort` | Projection `{aborted, operationId, restoredHead}` |
| `vlab resolve status` | Projection `{active, operationId, conflicts}` |
| `vlab resolve apply` | Projection `{operationId, applied: [{path, resolution}]}` |
| `vlab resolve reject` | Projection `{operationId, rejected: [{path, candidates}]}` |
| `vlab resolve list` | Array of `vcs-lab.resolution/v1` with `attachedTo`, `discoveredRef`, and `commit` projections added |
| `vlab provenance [<rev>] [--all]` | `{ revision, inspected, entries[] }`; each entry projects one `vcs-lab.provenance/v1` record with the commit subject added |
| `vlab cherry-pick` | `vcs-lab.application/v1`, or the no-op projection `{noOp, reason, originCommit, originChangeId, targetBefore}` |
| `vlab receipts` | Array of note records (any note-record family above) with `attachedTo` added |
| `vlab metadata status` | `vcs-lab.metadata-status/v1` |
| `vlab metadata validate` | `vcs-lab.metadata-validation/v1` |
| `vlab metadata export` | `vcs-lab.metadata-export/v1` (writes a `vcs-lab.metadata-envelope/v1` manifest) |
| `vlab metadata import --dry-run` | `vcs-lab.metadata-import-preview/v1` |
| `vlab metadata import --apply` | `vcs-lab.metadata-import/v1` |
| `vlab metadata benchmark` | `vcs-lab.repository-scale-benchmark/v1` |
| `vlab workspace create/move/archive/restore/repair` | `vcs-lab.workspace/v1` plus inspection projections (`lifecycle` default, `status`, `pathStatus`, `head`, `dirtyFiles`; mutations add `changed`) |
| `vlab workspace list` | Array of inspected `vcs-lab.workspace/v1` |
| `vlab workspace checkpoint` | `vcs-lab.checkpoint/v1` |
| `vlab workspace prune` | `vcs-lab.workspace-prune/v1` |
| `vlab workspace forecast` | `vcs-lab.forecast/v2` (with `workspaceComparison` populated) |
| `vlab spec index` | Projection `{manifestPath, manifest, changes, entityCount, cacheHit, cacheMode, contentRead, written, ...}`; `--all` wraps per-file results in a summary projection |
| `vlab spec show` | Projection `{manifestPath, manifest}` with `manifest` the materialized `vcs-lab.spec-manifest/v3` view (adds `sourceBytes`, `sourceLines`, `blocks`) |
| `vlab spec merge-plan` | `vcs-lab.spec-merge-plan/v1` |
| `vlab spec status` | Projection `{active, operationId, plans}` |
| `vlab spec resolve` | Projection `{operationId, applied}` |
| `vlab spec benchmark` | `vcs-lab.spec-benchmark/v2` |
| `vlab doctor` | Projection `{ok, version, git, node, repository, notesRef, engine, forecastEngine, differential?, benchmark?, objectSession?}`; `version` is the vcs-lab build identity and `differential` is a `vcs-lab.engine-differential/v1` |

`vlab merge`, `vlab compact-merge`, and `vlab hard-squash` print their
`vcs-lab.landing/v1` receipt as JSON whatever the flags: like every command
whose handler has no text renderer, `--json` is a no-op for them. `vlab init`,
`vlab branch`, `vlab graph`, `vlab version`, and `vlab help` print text and
have no JSON form. The [conformance contract](../conformance/README.md) lists
which commands are which and pins the parity of those that have both.
