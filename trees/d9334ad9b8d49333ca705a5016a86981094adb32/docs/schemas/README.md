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
The [receipt timing contract](receipt-timings.md) defines what reconciliation
and rebase timing snapshots include and exclude.

## Conventions

- `$id` is the schema identifier exactly as records carry it in their
  `schema` field (for example `causet.landing/v1`). Documents reference each
  other by `$id` (`{"$ref": "causet.merge-plan/v1"}`), so a resolver must
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
  consumed (`cst metadata status` reports them), and unsupported private,
  shared-local, tracked, or envelope schemas are refused with an error.
- `x-causet-scope` annotates each document with its persistence scope and
  must agree with `schemaClassification` in `src/schemas.js`; `cli-output`
  marks a family that exists only as command output.

## Record families

### Shared-portable (Git notes under `refs/notes/causet`)

| Schema | Document | Purpose |
| --- | --- | --- |
| `causet.note/v1` | [note.v1.schema.json](note.v1.schema.json) | Container for the records attached to one Git object |
| `causet.landing/v1` | [landing.v1.schema.json](landing.v1.schema.json) | Compact or hard-squash landing receipt |
| `causet.application/v1` | [application.v1.schema.json](application.v1.schema.json) | Direct cherry-pick application receipt |
| `causet.application/v4` | [application.v4.schema.json](application.v4.schema.json) | Reconciliation application receipt with conflict decisions |
| `causet.reconciliation/v6` | [reconciliation.v6.schema.json](reconciliation.v6.schema.json) | Final reconciliation summary receipt |
| `causet.rebase-application/v1` | [rebase-application.v1.schema.json](rebase-application.v1.schema.json) | Origin-to-rewritten-commit mapping receipt |
| `causet.amendment/v1` | [amendment.v1.schema.json](amendment.v1.schema.json) | Divergence an interactive `edit` recorded under a retained identity |
| `causet.interactive-absorption/v1` | [interactive-absorption.v1.schema.json](interactive-absorption.v1.schema.json) | Identities a surviving commit absorbed through `squash` or `fixup` |
| `causet.rebase/v3` | [rebase.v3.schema.json](rebase.v3.schema.json) | Completed causal rebase receipt |
| `causet.rebase/v2` | [rebase.v2.schema.json](rebase.v2.schema.json) | Superseded; still read, and always a rewrite that declared no interactive action |
| `causet.rebase/v1` | [rebase.v1.schema.json](rebase.v1.schema.json) | Superseded; still read, and always a rewrite with no merge in range |
| `causet.resolution/v1` | [resolution.v1.schema.json](resolution.v1.schema.json) | Exact resolution result and provenance |
| `causet.provenance/v1` | [provenance.v1.schema.json](provenance.v1.schema.json) | Declared authorship provenance, carried across rewrites |

### Worktree-private (`.git/causet/` of one worktree)

| Schema | Document | Store |
| --- | --- | --- |
| `causet.reconciliation-operation/v4` | [reconciliation-operation.v4.schema.json](reconciliation-operation.v4.schema.json) | `reconciliation.json` journal |
| `causet.rebase-operation/v3` | [rebase-operation.v3.schema.json](rebase-operation.v3.schema.json) | `rebase.json` journal |
| `causet.forecast/v2` | [forecast.v2.schema.json](forecast.v2.schema.json) | `forecasts/<id>.json` |
| `causet.rebase-forecast/v3` | [rebase-forecast.v3.schema.json](rebase-forecast.v3.schema.json) | `forecasts/<id>.json` |

### Shared-local (common Git dir, not exported)

| Schema | Document | Store |
| --- | --- | --- |
| `causet.workspaces/v1` | [workspaces.v1.schema.json](workspaces.v1.schema.json) | `<common dir>/causet/workspaces.json` |
| `causet.workspace/v1` | [workspace.v1.schema.json](workspace.v1.schema.json) | Entries of the registry |
| `causet.quarantined-record/v1` | [quarantined-record.v1.schema.json](quarantined-record.v1.schema.json) | Blob of a `refs/causet/quarantine/<lineage>/<record id>` ref |
| `causet.dispositions/v1` | [dispositions.v1.schema.json](dispositions.v1.schema.json) | `<common dir>/causet/dispositions.json` |
| `causet.disposition/v1` | [disposition.v1.schema.json](disposition.v1.schema.json) | Entries of the disposition registry |

### Advertisement (produced on demand, never stored)

| Schema | Document | Store |
| --- | --- | --- |
| `causet.capabilities/v1` | [capabilities.v1.schema.json](capabilities.v1.schema.json) | None: projected from the registries by `cst capabilities`, and served by a gateway when one exists |

### Tracked-portable (committed beside the working tree)

| Schema | Document | Store |
| --- | --- | --- |
| `causet.spec-manifest/v4` | [spec-manifest.v4.schema.json](spec-manifest.v4.schema.json) | `.causet/specs/**` |
| `causet.spec-manifest/v3` | [spec-manifest.v3.schema.json](spec-manifest.v3.schema.json) | Superseded; historical v1 parser view, migrated on indexing |
| `causet.spec-manifest/v2` | [spec-manifest.v2.schema.json](spec-manifest.v2.schema.json) | Superseded; read and migrated forward |
| `causet.spec-manifest/v1` | [spec-manifest.v1.schema.json](spec-manifest.v1.schema.json) | Superseded; read and migrated forward |

### Envelope (metadata export directory)

| Schema | Document | Store |
| --- | --- | --- |
| `causet.metadata-envelope/v1` | [metadata-envelope.v1.schema.json](metadata-envelope.v1.schema.json) | `manifest.json` beside `objects.bundle` |
| `causet.proof-bundle/v2` | [proof-bundle.v2.schema.json](proof-bundle.v2.schema.json) | A file handed to `cst verify-proof`; carries the Git bindings of ADR-0031 |
| `causet.proof-bundle/v1` | [proof-bundle.v1.schema.json](proof-bundle.v1.schema.json) | Superseded; still read, and reaches only the self-consistent tier |

### CLI-output families

These families exist only as command output; they carry a `schema` field so
automation can dispatch on them, but they are not persisted by vcs-lab.

`causet.error/v1` is the failure envelope of
[ADR-0021](../adr/0021-give-failures-a-versioned-machine-readable-envelope.md).
Unlike the others it is printed *instead of* a command's success output, on
stdout, when the invocation asked for `--json`; its closed error-code
vocabulary is published in [errors.md](errors.md).

| Schema | Document |
| --- | --- |
| `causet.merge-plan/v1` | [merge-plan.v1.schema.json](merge-plan.v1.schema.json) |
| `causet.identity-audit/v1` | [identity-audit.v1.schema.json](identity-audit.v1.schema.json) |
| `causet.proof-bundle/v1` | [proof-bundle.v1.schema.json](proof-bundle.v1.schema.json) |
| `causet.proof-verification/v1` | [proof-verification.v1.schema.json](proof-verification.v1.schema.json) |
| `causet.rebase-plan/v3` | [rebase-plan.v3.schema.json](rebase-plan.v3.schema.json) |
| `causet.checkpoint/v1` | [checkpoint.v1.schema.json](checkpoint.v1.schema.json) |
| `causet.workspace-prune/v1` | [workspace-prune.v1.schema.json](workspace-prune.v1.schema.json) |
| `causet.spec-merge-plan/v1` | [spec-merge-plan.v1.schema.json](spec-merge-plan.v1.schema.json) |
| `causet.spec-merge-plan/v2` | [spec-merge-plan.v2.schema.json](spec-merge-plan.v2.schema.json) |
| `causet.spec-benchmark/v2` | [spec-benchmark.v2.schema.json](spec-benchmark.v2.schema.json) |
| `causet.spec-benchmark/v3` | [spec-benchmark.v3.schema.json](spec-benchmark.v3.schema.json) |
| `causet.repository-scale-benchmark/v1` | [repository-scale-benchmark.v1.schema.json](repository-scale-benchmark.v1.schema.json) |
| `causet.metadata-status/v1` | [metadata-status.v1.schema.json](metadata-status.v1.schema.json) |
| `causet.metadata-validation/v1` | [metadata-validation.v1.schema.json](metadata-validation.v1.schema.json) |
| `causet.metadata-retention/v1` | [metadata-retention.v1.schema.json](metadata-retention.v1.schema.json) |
| `causet.metadata-export/v1` | [metadata-export.v1.schema.json](metadata-export.v1.schema.json) |
| `causet.metadata-import-preview/v1` | [metadata-import-preview.v1.schema.json](metadata-import-preview.v1.schema.json) |
| `causet.metadata-import/v1` | [metadata-import.v1.schema.json](metadata-import.v1.schema.json) |
| `causet.metadata-disposition/v1` | [metadata-disposition.v1.schema.json](metadata-disposition.v1.schema.json) |
| `causet.capability-report/v1` | [capability-report.v1.schema.json](capability-report.v1.schema.json) |
| `causet.engine-differential/v1` | [engine-differential.v1.schema.json](engine-differential.v1.schema.json) |
| `causet.error/v1` | [error.v1.schema.json](error.v1.schema.json) |

The catalog retains historical spec plan v1 and spec benchmark v2 documents.
Current commands emit plan v2 and benchmark v3; see the command table below.

### Superseded identifiers without documents

| Schema | Status |
| --- | --- |
| `causet.forecast/v1` | Superseded by `causet.forecast/v2`; still accepted when reading stored forecasts, never written. |
| `causet.rebase-plan/v1` | Superseded by `causet.rebase-plan/v2`, which adds the preserved topology and redefines `constraints.supported` (ADR-0034). Command output, never stored, so nothing holds a v1 plan except a v1 forecast or journal, both of which are refused. |
| `causet.rebase-forecast/v1` | Superseded by `causet.rebase-forecast/v2`. Refused rather than read: it pins a v1 plan fingerprint that no v2 plan can match. Regenerate with `cst rebase-forecast`. |
| `causet.rebase-operation/v1` | Superseded by `causet.rebase-operation/v2`. Refused rather than resumed: its queue cannot express a recreated merge. Finish or abort an in-flight v1 journal with the build that wrote it. |
| `causet.rebase-plan/v2` | Superseded by `causet.rebase-plan/v3`, which adds the declared interactive program (ADR-0035). Command output, never stored. |
| `causet.rebase-forecast/v2` | Superseded by `causet.rebase-forecast/v3`. Refused rather than read, for the same reason v1 is: it pins a plan fingerprint no v3 plan can match. |
| `causet.rebase-operation/v2` | Superseded by `causet.rebase-operation/v3`. Refused rather than resumed: its queue cannot express a declared interactive action or its pause. |

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
| `cst commit` | Projection `{commit, changeId, message}` |
| `cst merge-plan` | `causet.merge-plan/v1` |
| `cst audit identity` | `causet.identity-audit/v1`; exits non-zero when errors are reported, while warnings such as `near-duplicate-actor-names` leave the exit code at zero |
| `cst proof-bundle` | `causet.proof-bundle/v2`; always JSON, since the bundle exists to be handed to another tool. Refuses rather than truncating when its proofs would exceed `proofBundleBytes` |
| `cst verify-proof` | `causet.proof-verification/v1`; reports a tier and the conclusions the carried material cannot support, and exits non-zero when the bundle does not verify. `--anchors-from <remote>` reads anchors with `git ls-remote` from a remote the verifier names |
| `cst rebase-plan` | `causet.rebase-plan/v3` |
| `cst rebase-forecast` | `causet.rebase-forecast/v3` |
| `cst rebase`, `cst rebase --continue` | Projection `{operationId, plan, recreatedMerges, amendments, absorptions, receipt}` with `plan` a `causet.rebase-plan/v3`, `receipt` a `causet.rebase/v3`, and the three lists repeated from the receipt for convenience (each empty when the rewrite declared nothing of that kind) |
| `cst rebase --status` | Projection: `{active: false, state: "idle"}`, or `{active, operationId, state, worktree, sourceRef, sourceHead, sourceBranchRef, ontoRef, ontoHead, forecastId, progress, current, applied, recreatedMerges, recovery, timings, startedAt, updatedAt}` with `applied` an array of `causet.rebase-application/v1` and `recreatedMerges` the joins recreated so far, which are never applications. `progress` counts the steps that run, so a commit the plan omits is in neither `completed` nor `remaining` |
| `cst rebase --abort` | Projection `{aborted, operationId, sourceRef, restoredHead}` |
| `cst forecast` | `causet.forecast/v2` |
| `cst reconcile`, `cst reconcile --continue` | Projection `{operationId, plan, receipt}` with `plan` a `causet.merge-plan/v1` and `receipt` a `causet.reconciliation/v6` |
| `cst reconcile --status` | Projection like `rebase --status` (with `targetBranchRef` in place of `sourceBranchRef`, without `ontoRef`/`ontoHead`; `recovery` names the expected and actual branch, with `branchMatches` null for a journal written before the branch was recorded) with `applied` an array of `causet.application/v4` |
| `cst reconcile --abort` | Projection `{aborted, operationId, restoredHead}` |
| `cst resolve status` | Projection `{active, operationId, conflicts}` |
| `cst resolve apply` | Projection `{operationId, applied: [{path, resolution}]}` |
| `cst resolve reject` | Projection `{operationId, rejected: [{path, candidates}]}` |
| `cst resolve list` | Array of `causet.resolution/v1` with `attachedTo`, `discoveredRef`, and `commit` projections added |
| `cst provenance [<rev>] [--all]` | `{ revision, inspected, entries[] }`; each entry projects one `causet.provenance/v1` record with the commit subject added |
| `cst cherry-pick` | `causet.application/v1`, or the no-op projection `{noOp, reason, originCommit, originChangeId, targetBefore}` |
| `cst receipts` | Array of note records (any note-record family above) with `attachedTo` added |
| `cst metadata status` | `causet.metadata-status/v1` |
| `cst metadata validate` | `causet.metadata-validation/v1` |
| `cst metadata retain --dry-run/--apply` | `causet.metadata-retention/v1` |
| `cst metadata export` | `causet.metadata-export/v1` (writes a `causet.metadata-envelope/v1` manifest) |
| `cst metadata import --dry-run` | `causet.metadata-import-preview/v1` |
| `cst metadata import --apply` | `causet.metadata-import/v1` |
| `cst metadata dispose` | `causet.metadata-disposition/v1` (records a `causet.disposition/v1` entry) |
| `cst capabilities` | `causet.capabilities/v1`; repository-scoped inside a repository, build-scoped outside one |
| `cst capabilities --against` | `causet.capability-report/v1`; exits non-zero when a family is reduced or blocked, while the exchange itself remains possible |
| `cst metadata benchmark` | `causet.repository-scale-benchmark/v1` |
| `cst workspace create/move/archive/restore/repair` | `causet.workspace/v1` plus inspection projections (`lifecycle` default, `status`, `pathStatus`, `head`, `dirtyFiles`; mutations add `changed`) |
| `cst workspace list` | Array of inspected `causet.workspace/v1` |
| `cst workspace checkpoint` | `causet.checkpoint/v1` |
| `cst workspace prune` | `causet.workspace-prune/v1` |
| `cst workspace forecast` | `causet.forecast/v2` (with `workspaceComparison` populated) |
| `cst spec index` | Projection `{manifestPath, manifest, changes, entityCount, cacheHit, cacheMode, contentRead, written, ...}`; `--all` wraps per-file results in a summary projection |
| `cst spec show` | Projection `{manifestPath, manifest}` with a materialized manifest view (adds `sourceBytes`, `sourceLines`, `blocks`); stored v1/v2/v3/v4 schema and parser semantics are retained |
| `cst spec merge-plan` | `causet.spec-merge-plan/v2` |
| `cst spec status` | Projection `{active, operationId, plans}` |
| `cst spec resolve` | Projection `{operationId, applied}` |
| `cst spec benchmark` | `causet.spec-benchmark/v3` |
| `cst doctor` | Projection `{ok, version, implementation, git, node, launcher, repository, notesRef, engine, forecastEngine, migration, differential?, benchmark?, objectSession?}`; `version` is the causet build identity, `implementation` and `node` describe the runtime (ADR-0037 §5), `launcher` is `"node"` when the installed command is the Node launcher rather than the executable (ADR-0038 §2) and `null` otherwise, `migration` is `unmigrated`, `migrated` or `mixed` (ADR-0039 §3), and `differential` is a `causet.engine-differential/v1` |

`cst merge`, `cst compact-merge`, and `cst hard-squash` print their
`causet.landing/v1` receipt as JSON whatever the flags: like every command
whose handler has no text renderer, `--json` is a no-op for them. `cst init`,
`cst branch`, `cst graph`, `cst version`, and `cst help` print text and
have no JSON form. The [conformance contract](../conformance/README.md) lists
which commands are which and pins the parity of those that have both.
