# vcs-lab architecture reference

## Document status

| Field | Value |
| --- | --- |
| Architecture baseline | v0.15.0 release |
| Status | Current implementation reference |
| Last updated | 2026-09-19 |
| Runtime | Node.js 20+ (ES modules), Git 2.40+ (merge-tree forecast engine: Git 2.49+) |
| External runtime dependencies | None beyond Node.js and Git |

This document explains the system that exists. [product.md](product.md) defines
the desired product and its requirements. [adr](adr/README.md) records decisions
and their consequences. Delivered behavior and historical corrections are
summarized in the repository [changelog](../CHANGELOG.md).

When implementation and this document differ, implementation plus tests are
the current fact, but the discrepancy is a documentation defect. When an
implementation change would violate an accepted ADR, the ADR must be
superseded explicitly rather than silently ignored.

## 1. Architectural intent

`vcs-lab` is a compatibility-layer experiment, not an independent object
database. Git is responsible for content-addressed storage, snapshots,
ordinary ancestry, refs, worktrees, staging, merges, cherry-picks, and recovery
mechanics. `vcs-lab` adds:

- stable logical change identity;
- causal landing and application records;
- declared authorship provenance carried across rewrites;
- proof-aware planning, portable coverage proof bundles, and a
  repository-wide identity audit;
- isolated forecast and resumable reconciliation orchestration;
- exact conflict-resolution provenance;
- workspace/checkpoint metadata for linked worktrees;
- stable semantic identity and deterministic merge for Markdown specs;
- repository-wide metadata inventory, validation, and quarantine;
- deterministic Git-bundle metadata export and atomic/idempotent import;
- measurement and an optional persistent Git object-query path.

The architecture deliberately separates **exact state** from **causal claims**.
Git OIDs remain the oracle for bytes and parentage. A receipt can explain why
one line of development covers another even when physical ancestry was lost,
but a receipt does not rewrite a commit or tree ID.

[ADR-0023](adr/0023-locate-the-model-substrate-mismatch-in-facts-not-content.md)
locates the model/substrate mismatch on the causal-fact side: every distortion
a native store would remove is in how facts are represented — an edge with no
representation, a fact whose identity is its attachment point, validity
inherited from an unrelated object's reachability — and none is in Git's
content model, which also carries the correctness oracle. Only the fact
substrate is therefore a candidate for native replacement; Git's content
substrate stays, and ADR-0001 is refined rather than superseded.

## 2. System context

```text
             humans, AI agents, CI, scripts
                         |
                         v
                  +--------------+
                  |  vlab CLI    |
                  | src/cli.js   |
                  +------+-------+
                         |
          +--------------+----------------+
          |              |                |
          v              v                v
  causal workflows   spec workflows   workspace workflows
  plan/forecast/     index/merge/      worktree/checkpoint/
  reconcile/resolve  benchmark         comparison
          |              |                |
          +--------------+----------------+
                         |
                         v
                  +--------------+
                  | Git adapter  |
                  |  src/git.js  |
                  +------+-------+
                         |
              +----------+-----------+
              |                      |
              v                      v
      ordinary Git processes   optional invocation-scoped
                               cat-file session worker
              |                      |
              +----------+-----------+
                         v
             Git objects, refs, notes,
             worktrees, index, files
```

### 2.1 Inside the boundary

- CLI parsing and human/JSON formatting.
- Git command orchestration and metrics.
- Causal plan construction.
- Temporary-worktree simulation, with a merge-tree session for clean
  forecast steps (the default on Windows, opt-in elsewhere).
- Worktree-local operation journals and forecasts.
- Receipt creation and storage through Git notes.
- Resolution signature/catalog management.
- Workspace registry and checkpoint creation.
- Markdown parsing, sparse manifest materialization, and deterministic merge.
- Disposable repository/shared-metadata scale measurement and decision gates.

### 2.2 Outside the boundary

- Git implementation and filesystem behavior.
- Remote hosting, authentication, authorization, and policy.
- Cryptographic signing and trusted attestation.
- Editor integrations and code review UI.
- Network synchronization beyond normal Git/ref commands.
- Language-model judgment.

## 3. Source layout and component responsibilities

<!-- generated:modules:start -->
| File | Responsibility | Important dependencies |
| --- | --- | --- |
| `bin/vlab.js` | Minimal executable entry point and error/exit boundary | `src/cli.js` |
| `src/canonical-json.js` | The frozen `vcs-lab.canonical-json/v1` profile: RFC 8785 restricted to UTF-16-code-unit-sorted members and safe integers, refusing what it cannot serialize byte-identically | None |
| `src/capabilities.js` | The `vcs-lab.capabilities/v1` document projected from the runtime registries, and negotiation as a pure function of two such documents (ADR-0033) | `src/schemas.js`, `src/metadata.js`, `src/metadata-envelope.js`, `src/canonical-json.js` |
| `src/cli.js` | Argument parsing, command dispatch, human and JSON presentation, benchmarks | All domain modules |
| `src/dispositions.js` | Resolving one parked conflict: keep-local or replace-local, the note rewrite it implies, and the recorded decision that stops the same disagreement being reported twice (ADR-0030) | `src/quarantine.js`, `src/metadata.js`, `src/notes.js` |
| `src/engine.js` | The read-side engine seam: the catalog of 43 read operations, the read-engine selector, per-operation native execution and fallback, composites, and the differential comparison | `src/git.js`, `src/native-engine.js` |
| `src/errors.js` | Expected CLI error type carrying a classification code from the closed `ERROR_CODES` vocabulary of the `vcs-lab.error/v1` failure envelope (ADR-0021) | None |
| `src/faults.js` | Test-only deterministic fault injection: `VLAB_TEST_FAULT` turns one named point on a mutating path into a hard `process.exit`; `VLAB_TEST_GATE` holds a process at a named point until a test releases it | None |
| `src/forecasts.js` | Plan fingerprint, merge-tree and temporary-worktree simulation engines with recorded fallback, decision pinning, saved forecasts | Plan, operations helpers, specs, resolutions, Git |
| `src/git-carriers.js` | Copy-on-write notes trees, typed dependency closure, bounded carrier parents, and checked ref commands | Engine, Git writes, schemas |
| `src/git-session-worker.js` | Owns asynchronous `git cat-file --batch-command` stream for a synchronous caller | Worker threads, Git |
| `src/git.js` | The Git engine: safe synchronous Git adapter, the Git implementation of every read operation, repository context, object and merge-tree sessions, engine selectors, the read-bypass rule, metrics | Git executable, workers |
| `src/identity-audit.js` | Repository-wide logical identity audit (`vcs-lab.identity-audit/v1`): union-find over identity-preserving application edges, multi-trailer, multi-origin, and invariant findings, plus the near-duplicate provenance actor warning | Engine, notes |
| `src/ids.js` | Unique protocol IDs, SHA-256, Git blob hashing, slugs | Node crypto |
| `src/landings.js` | Compact and hard-squash landing mechanics and receipts | Git adapter, notes |
| `src/merge-plan.js` | Coverage proof lattice, effective base, patch candidates, plan formatting | Git adapter, notes |
| `src/merge-tree-session-worker.js` | Owns one asynchronous `git merge-tree --stdin` stream for the synchronous merge-tree forecast engine | Worker threads, Git |
| `src/metadata-envelope.js` | Canonical envelope manifest, integrity hash, payload bounds, and parser | Metadata, schemas |
| `src/metadata-transfer.js` | Sanitized bundle export, dry-run inspection, conflict planning, staging, and atomic ref import | Metadata, envelope, Git |
| `src/metadata.js` | Deterministic inventory, scope classification, integrity diagnostics, lineage, and accepted-record filtering | Git, schemas, specs |
| `src/native-engine.js` | Optional in-process Node-API binding loader and conversion for the five bounded resolution-catalog read operations | Optional `native/prebuilds` binding, Node module and path utilities |
| `src/notes.js` | Append/list/read causal records in `refs/notes/vcs-lab`, including one batched read for many targets; every writer of the ref is serialized on the notes lock in the shared runtime directory | `src/git.js`, `src/store.js` |
| `src/operations.js` | Commit/cherry-pick and reconciliation start/queue/continue/abort/finalize | Plan, forecast, notes, resolution/spec modules |
| `src/pending-operation.js` | Safe reconciliation/rebase journal routing for shared conflict tools | Reconciliation and rebase state |
| `src/proof-binding.js` | The Git bindings a proof bundle carries so a verifier without the repository can check it: the bound source inventory, reachability paths, receipt inclusion proofs, and the object-id recomputation that makes them proofs (ADR-0031) | `src/engine.js`, `src/git.js`, `src/schemas.js` |
| `src/proof-bundle.js` | Portable coverage proof bundles and their independent verifier, which applies its own copy of the lattice (`PROOF_RULES`) and compares the evidence with the repository | Merge plan, canonical JSON, metadata, engine |
| `src/provenance.js` | Declared authorship provenance (`vcs-lab.provenance/v1`): the closed role vocabulary, `VLAB_AGENT`, declaration at commit time, and exact carry onto rewritten commits | Notes, IDs, schemas |
| `src/quarantine.js` | The conflict policy's two local stores: parked conflicting records as one blob-bearing ref each under `refs/vcs-lab/quarantine/<lineage>/<record id>`, and the shared-local disposition registry (ADR-0030) | `src/engine.js`, `src/git.js`, `src/store.js`, `src/schemas.js` |
| `src/rebase-forecast.js` | Rebase simulation orchestration, caller invariants, candidate pinning, the carried caller overlay and its second predicted tree, and private forecast presentation | Rebase plan, forecast simulator, target overlays, semantic version guards, Git adapter |
| `src/rebase-operations.js` | Current-branch rebase replay, forecast enforcement, overlay reduction and re-materialization, conflict recovery, identity, and final receipts | Rebase plan/forecast, target overlays, Git, notes, specs, resolutions |
| `src/rebase-plan.js` | Read-only rebase selection, actions, linear-history constraints, and deterministic fingerprint | Merge plan, Git adapter, IDs |
| `src/rebase-state.js` | Worktree-private rebase journal path and atomic persistence | Git context, store |
| `src/reconcile-state.js` | Worktree-private reconciliation journal and Git in-progress state probes | Repo context, filesystem |
| `src/resolutions.js` | Exact three-way conflict signatures, candidate selection, result retention, outcome audit | Git adapter, notes, reconciliation state |
| `src/retention.js` | Read-only retention preview and checked, idempotent historical backfill | Metadata, carriers, notes lock |
| `src/scale-benchmark.js` | Bounded synthetic repository fixture, scan measurements, raw-Git floors for the phases with a plain-Git equivalent, semantic equality checks, and evidence-based optimization recommendations | Git, notes, metadata, resolutions, workspaces |
| `src/schemas.js` | Supported schema registry, structural record validation, object-reference and resolution-signature rules | IDs |
| `src/specs.js` | Markdown parsing, sparse manifest migration/indexing, deterministic merge, semantic resolution, benchmark | Git adapter, IDs, reconciliation state |
| `src/store.js` | Common runtime directory and atomic JSON read/write | `src/git.js` |
| `src/target-overlay.js` | Target overlays: resolving the checkpoint a `--target-checkpoint` forecast is about, predicting the tree the worktree holds after one is put back, and reducing, re-materializing, and restoring it without ever committing it (ADR-0028) | `src/engine.js`, `src/git.js`, `src/workspaces.js`, `src/store.js` |
| `src/version.js` | Runtime version constant | None |
| `src/workspace-lock.js` | Exclusive shared-local registry transaction lock, bounded refusal, and ownership-checked release | Store, errors, fault gates |
| `src/workspaces.js` | Workspace registry/lifecycle, linked-worktree materialization, temporary-index checkpoints/history | Git adapter, store, workspace lock |
<!-- generated:modules:end -->

Supporting test and maintenance tools:

| File | Responsibility | Important dependencies |
| --- | --- | --- |
| `test/*.test.js` | Disposable-repository end-to-end contract suite (`integration.test.js`) and the focused suites [testing.md](testing.md) describes: schema catalog, canonical JSON, conformance, compatibility, hostile input, failure boundary, error envelope, provenance, object format, and repository hygiene | CLI and Git |
| `test-support/git-environment.js` | The isolated Git environment every suite file imports: no system configuration and an empty global one; outside `test/` because `node --test` would run it as a test file | `node:test` |
| `scripts/*.mjs` | Reproducible user experiments and performance comparisons | Published CLI behavior |

The code is intentionally dependency-free. Domain modules use synchronous APIs
so a CLI command has a linear, auditable control flow. The Git session worker
contains the asynchronous streaming boundary without converting the domain
layer to promises. Domain modules read the repository only through
`src/engine.js` and mutate it only through `runGit` from `src/git.js`; the
"Git adapter" dependency named below means that pair (§14.4).

## 4. State and identity model

### 4.1 Identity layers

```text
logical change ch_*             stable intent
        |
        | applied in a target context
        v
application apply_* ----------> result Git commit OID
        |                              |
        | grouped/finalized            | exact bytes
        v                              v
reconciliation reconcile_*      Git tree OID

source commits --absorbed by--> landing land_* --attached to--> landing commit

workspace ws_* --materialized as--> Git linked worktree
spec artifact artifact_* --contains--> deterministic/overridden entity IDs
```

- A **Git commit OID** changes when content, metadata, or parents change.
- A **Git tree OID** identifies exact repository file state independent of
  commit message and parents.
- A **Change ID** is a logical continuity claim embedded in a commit trailer.
- An **application record** links one source logical change to a target-specific
  result commit.
- A **landing record** states that one integration commit absorbed exact source
  revisions and logical IDs.
- A **reconciliation record** summarizes the reviewed plan and all applications
  after the complete operation succeeds.

No layer substitutes for another. For example, equal Change IDs do not imply
equal trees, and equal trees do not imply the same intent or review event.

### 4.2 Change ID generation and propagation

`vlab commit` appends a generated `Change-Id: ch_*` trailer unless an identity
is already deliberately supplied by the workflow. Ordinary commits without a
trailer are assigned an ephemeral planning identity `git:<commit-oid>`; this
does not pretend they will survive rewriting.

`vlab cherry-pick` defaults to the same logical ID. `--fork` creates a new
Change ID and adds origin trailers. During conflict continuation, `--fork`
likewise marks the target result as changed intent rather than a contextual
adaptation of the same intent.

Standalone cherry-pick suppresses an ordinary Git origin when the exact commit
is already in target ancestry or a validated, reachable application records
that origin under the same logical identity. Application records must pass the
same schema, attachment, and referenced-object checks used by causal planning;
only recognized identity-preserving relations count. Other branches' records,
explicit forks, unknown relations, and patch similarity cannot establish that
coverage. The `git:<oid>` fallback remains an exact origin reference, not a new
stable trailer. Existing Change-Id and Absorbs trailer coverage is retained;
`--repeat` bypasses duplicate suppression, including with `--fork`.

A `ch_*` argument names one commit even when several carry the trailer: the
change's origin, which is the bearer no identity-preserving application
record names as its applied commit, and otherwise the earliest bearer by
committer date, equal dates by commit id. The rule is stated in the
[identity protocol](identity/README.md) §5 and depends only on the commits,
so the `originCommit` an application record carries, and the provenance
carried from it, do not depend on the order `git log` happens to walk.

## 5. Persistence topology

The placement rule is: mutable, in-progress choices belong to one worktree;
completed reusable facts belong to the shared repository; portable document
identity belongs in tracked files.

| Data | Scope | Location | Lifecycle |
| --- | --- | --- | --- |
| Git source/history state | Shared repository | Git objects and ordinary refs | Normal Git lifecycle |
| Causal notes | Shared repository | `refs/notes/vcs-lab` | Portable through a validated metadata envelope |
| Published object retention | Shared repository | `refs/vcs-lab/retention` | Monotonic derived carrier; envelopes rebuild from selected accepted facts |
| Resolution result objects | Shared repository | `refs/vcs-lab/resolutions/<signature>/<result-blob>` | Hidden ref prevents GC; envelope transports accepted refs |
| Workspace registry | Shared repository installation | `<common-git-dir>/vcs-lab/workspaces.json` | Local; not automatically remote-portable |
| Parked conflicting records | Shared repository installation | `refs/vcs-lab/quarantine/<source-lineage>/<record-id>`, one blob per dispute | Local; nothing fetches or pushes the namespace. Removed by a disposition (ADR-0030) |
| Conflict dispositions | Shared repository installation | `<common-git-dir>/vcs-lab/dispositions.json` | Local on purpose: two clones may dispose the same conflict differently, and the disagreement is real |
| Checkpoints | Shared repository | Latest under `refs/vcs-lab/checkpoints/<workspace-id>`; prior snapshots under `refs/vcs-lab/checkpoint-history/<workspace-id>/<oid>` | Local immutable snapshots retained across materialization changes |
| Pending reconciliation | One linked worktree | `<worktree-git-dir>/vcs-lab/reconciliation.json` | Cleared on complete/abort |
| Pending causal rebase | One linked worktree | `<worktree-git-dir>/vcs-lab/rebase.json` | Cleared on complete/abort |
| Saved forecasts | One linked worktree | `<worktree-git-dir>/vcs-lab/forecasts/<id>.json` | Private approval artifact |
| Notes lock | Shared repository installation | `<common-git-dir>/vcs-lab/notes.lock` | Held for one append or one import; abandoned when its holder is gone (§15.4) |
| Workspace registry lock | Shared repository installation | `<common-git-dir>/vcs-lab/workspaces.lock` | Held across one registry mutation and its Git operations; abandoned claims require recovery with all writers stopped (§12) |
| Spec identity manifest | Tracked/repository portable | `.vcs-lab/specs/<source>.json` | Versioned with Markdown |
| Persistent object session | One CLI invocation and worktree | Memory plus worker process | Closed at invocation end |

`src/store.js` writes JSON through a temporary file and same-directory rename.
Worktree-private paths are derived from `git rev-parse --git-dir`; shared paths
are derived from `--git-common-dir`. This distinction is required for linked
worktree correctness.

## 6. Persisted schemas

Schemas are namespaced and versioned in a `schema` field. The following are in
use at the current development baseline:

<!-- generated:schemas:start -->
| Family | Readable versions | Written versions | Store | Scope |
| --- | --- | --- | --- | --- |
| `vcs-lab.application` | v1, v4 | v1, v4 | `refs/notes/vcs-lab note containers` | `note-record` |
| `vcs-lab.capabilities` | v1 | v1 | `produced on demand by vlab capabilities; served by a gateway` | `advertisement` |
| `vcs-lab.disposition` | v1 | v1 | `entries of <common dir>/vcs-lab/dispositions.json` | `shared-local` |
| `vcs-lab.dispositions` | v1 | v1 | `<common dir>/vcs-lab/dispositions.json` | `shared-local` |
| `vcs-lab.forecast` | v1, v2 | v2 | `<git dir>/vcs-lab/forecasts/<id>.json` | `private` |
| `vcs-lab.landing` | v1 | v1 | `refs/notes/vcs-lab note containers` | `note-record` |
| `vcs-lab.metadata-envelope` | v1 | v1 | `manifest.json of a metadata export directory` | `envelope` |
| `vcs-lab.note` | v1 | v1 | `refs/notes/vcs-lab note blobs` | `note-container` |
| `vcs-lab.proof-bundle` | v1, v2 | v2 | `a file handed to vlab verify-proof` | `envelope` |
| `vcs-lab.provenance` | v1 | v1 | `refs/notes/vcs-lab note containers` | `note-record` |
| `vcs-lab.quarantined-record` | v1 | v1 | `refs/vcs-lab/quarantine/<lineage>/<record id> blobs` | `shared-local` |
| `vcs-lab.rebase` | v1 | v1 | `refs/notes/vcs-lab note containers` | `note-record` |
| `vcs-lab.rebase-application` | v1 | v1 | `refs/notes/vcs-lab note containers` | `note-record` |
| `vcs-lab.rebase-forecast` | v1 | v1 | `<git dir>/vcs-lab/forecasts/<id>.json` | `private` |
| `vcs-lab.rebase-operation` | v1 | v1 | `<git dir>/vcs-lab/rebase.json` | `private` |
| `vcs-lab.reconciliation` | v6 | v6 | `refs/notes/vcs-lab note containers` | `note-record` |
| `vcs-lab.reconciliation-operation` | v4 | v4 | `<git dir>/vcs-lab/reconciliation.json` | `private` |
| `vcs-lab.resolution` | v1 | v1 | `refs/notes/vcs-lab note containers` | `note-record` |
| `vcs-lab.spec-manifest` | v1, v2, v3, v4 | v4 | `.vcs-lab/specs/**` | `tracked` |
| `vcs-lab.workspace` | v1 | v1 | `entries of <common dir>/vcs-lab/workspaces.json` | `shared-local` |
| `vcs-lab.workspaces` | v1 | v1 | `<common dir>/vcs-lab/workspaces.json` | `shared-local` |
<!-- generated:schemas:end -->

Command and automation output shapes (outside the persisted-family registry):

| Schema | Purpose | Primary owner |
| --- | --- | --- |
| `vcs-lab.merge-plan/v1` | Source/target coverage plan | `merge-plan.js` |
| `vcs-lab.proof-bundle/v1` | Merge plan plus the evidence its classification rests on, for an independent verifier | `proof-bundle.js` |
| `vcs-lab.proof-verification/v1` | Integrity, classification, and repository verification result of a proof bundle | `proof-bundle.js` |
| `vcs-lab.rebase-plan/v1` | Read-only causal rebase selection and constraints | `rebase-plan.js` |
| `vcs-lab.checkpoint/v1` | Checkpoint command result | `workspaces.js` |
| `vcs-lab.workspace-prune/v1` | Preview/apply stale-path prune result | `workspaces.js` |
| `vcs-lab.spec-merge-plan/v2` | Deterministic three-way semantic plan | `specs.js` |
| `vcs-lab.spec-benchmark/v3` | Generated corpus measurements | `specs.js` |
| `vcs-lab.repository-scale-benchmark/v1` | Disposable repository/shared-metadata volume, scan, raw-Git floor, process-amplification, and decision measurements | `scale-benchmark.js` |
| `vcs-lab.metadata-status/v1` | Deterministic repository metadata inventory | `metadata.js` |
| `vcs-lab.metadata-validation/v1` | Inventory plus strict/non-strict validity result | `metadata.js` |
| `vcs-lab.metadata-export/v1` | Export result and process/storage metrics | `metadata-transfer.js` |
| `vcs-lab.metadata-import-preview/v1` | Exact dry-run record/ref/object actions | `metadata-transfer.js` |
| `vcs-lab.metadata-import/v1` | Applied/idempotent import result | `metadata-transfer.js` |
| `vcs-lab.metadata-retention/v1` | Historical retention preview/apply counts, refs, and diagnostics | `retention.js` |
| `vcs-lab.engine-differential/v1` | Operation-by-operation read-engine comparison | `engine.js` |
| `vcs-lab.identity-audit/v1` | Repository-wide identity collision and duplicate-origin audit | `identity-audit.js` |
| `vcs-lab.error/v1` | Failure envelope printed on stdout under `--json`, with a code from the closed vocabulary in `docs/schemas/errors.md` (ADR-0021) | `errors.js` |

The executable JavaScript validators and named object shapes in
`src/schemas.js` are the runtime authority. Every family above, and the CLI's
JSON output contracts, are additionally published as standalone JSON Schema
documents in the [schema catalog](schemas/README.md);
`test/schema-catalog.test.js` fails the suite when a document and its
validator disagree. Repository-lineage IDs and the envelope manifest hash
are computed under the frozen canonical JSON profile
`vcs-lab.canonical-json/v1` (`src/canonical-json.js`, specified with shared
test vectors in the [canonical JSON profile](canonical-json/README.md));
record digests keep their frozen legacy serialization for byte stability.
Human-readable and `--json` output of the same command are held to the
per-command parity contract in [`docs/conformance/`](conformance/README.md),
which also records which commands print JSON whatever the flags and which
state is deliberately text-only.
Compatibility, migration, unknown-version, and resource-bound rules are frozen
per family in the [compatibility contract](schemas/compatibility.md)
([ADR-0020](adr/0020-freeze-per-family-compatibility-and-resource-bounds.md)),
whose runtime authority is `RECORD_FAMILIES` and `RESOURCE_BOUNDS` in
`src/schemas.js`: unknown portable record schemas are quarantined rather than
consumed and their notes are never rewritten, while an unreadable private,
shared-local, tracked, or envelope record refuses the command instead of being
interpreted. Schema-version changes still require migration/compatibility
tests.

## 7. Causal planning architecture

Completed reconciliation and rebase receipts contain
[pre-publication timing snapshots](schemas/receipt-timings.md). Their Git
metrics cover application-queue scopes, excluding planning, finalization,
publication, and cleanup; they are not whole-command telemetry.

`buildMergePlan(sourceRef)` performs these steps inside an optional Git object
session:

1. Resolve exact target and source commits.
2. Compute their physical merge base.
3. Resolve target/source tree IDs and report exact state equality.
4. Read target history and collect commit IDs and Change IDs.
5. read causal records attached to commits reachable from the target and keep
   only records whose registered schema, attachment, and referenced Git objects
   validate.
6. Collect absorbed commit and Change IDs from landing/reconciliation records.
7. Use `git cherry` to identify advisory patch-equivalent candidates.
8. Read source commits outside the physical merge base in chronological order.
9. Choose the furthest receipt-backed source head that is an ancestor of the
   source tip as the effective causal base.
10. Classify each source change by the proof lattice.

### 7.1 Coverage proof lattice

The current precedence is:

1. `commit-ancestry`: exact source commit is directly reachable from target.
2. `receipt-commit`: a reachable landing or reconciliation record lists the
   exact source commit.
3. `stable-change-id`: target history contains the same logical ID.
4. `receipt-change-id`: a reachable receipt absorbed the logical ID.
5. `git-patch-id-heuristic`: advisory candidate only.
6. no proof: new work.

`receipt-commit` replaced `signed-shaped-landing-receipt` in v0.12.0. The old
label meant a record shaped for future signed proof, but it printed the word
*signed* in every plan for a record that nothing signs, inviting exactly the
confusion section 15.3 warns against. Nothing in the tool branches on a proof
value -- it is carried and displayed -- so the old value stays legal wherever a
record written by an earlier build still holds it, and readers pass it through
unchanged (see the [compatibility contract](schemas/compatibility.md)).

### 7.1.1 Portable proof bundles

`vlab proof-bundle <source>` emits `vcs-lab.proof-bundle/v1`: the plan plus the
evidence the lattice was evaluated against, so a third party can recompute the
classification rather than trust it (FR-PLAN-08). Each covered change becomes
traceable to the receipt that covered it, which the plan's bare `proof` string
cannot express.

`vlab verify-proof <file>` runs three checks and reports them separately,
because they establish different things:

| Check | Catches | Needs a repository |
| --- | --- | --- |
| `integrity` | editing after production | no |
| `classification` | a `status` or `proof` that does not follow from the stated evidence, inconsistent summary counts, or duplicate commits, even when the hash was restated | no |
| `repository` | fabricated evidence, incomplete or misidentified source history, and false counts or physical/effective bases | yes |

The verifier applies its own copy of the lattice (`PROOF_RULES` in
`src/proof-bundle.js`) rather than importing the planner's branch: a verifier
sharing the planner's code would prove only that the code is self-consistent.
It independently reads the ordered physical-base-to-source commit range through
the engine seam, checks every commit's logical ID (including `git:<oid>` fallback)
and subject, and derives the physical base and the effective base/reason from
Git ancestry and accepted target-reachable receipts. Summary counts must agree
both with the supplied changes and with classifications of the repository's
complete range. It does not invoke the planner to verify its output.

Offline verification checks internal classification, counts, and commit
uniqueness only. It cannot establish evidence truth, source completeness,
commit identity, or either base; `ok: true` with `repository.checked: false`
does not assert those properties. Proof-bundle v1 carries no authenticated
source inventory or receipt source-head evidence for offline base verification.
The correction adds verification-result diagnostics without changing bundle
bytes, persisted evidence, or schema versions.
A repository that has moved on is reported as skipped rather than failed,
since different heads legitimately produce different evidence.
Once a repository has been found, a failed verification read is an error, not
an automatic downgrade to offline success.

### 7.2 Reachability rule

Only receipts attached to commits reachable from the target participate in
coverage. A receipt elsewhere in the repository cannot suppress work on an
unrelated target. Note contents are read in a batch after the reachability walk.

### 7.3 Read-only causal rebase plan

`buildMergePlanBetween(ontoRef, sourceRef)` exposes the same proof lattice for
an explicit target without switching `HEAD`. `buildRebasePlan` wraps that
classification as `vcs-lab.rebase-plan/v1`:

- covered changes become `omit` actions with exact proofs;
- candidate-equivalent changes become `review` and cannot enter the replay
  queue silently;
- new changes become ordered `replay` entries;
- merge commits in the physical source range make the plan unsupported by the
  accepted linear-v1 scope; and
- exact heads, trees, bases, receipts, classifications, actions, and merge
  constraints feed a deterministic SHA-256 fingerprint.

The command performs only Git/object/metadata reads. Integration tests compare
the caller branch, HEAD, tree, porcelain status, notes ref, and worktree list
before and after repeated planning.

### 7.4 Causal rebase forecast

`forecastRebase` builds the exact rebase plan, refuses merge topology outside
linear v1, and adapts the shared forecast simulator to start at `ontoHead` and
apply only `action: replay` entries. Clean steps are labeled `causal-rebase`;
conflict adaptations retain the exact/spec-aware simulation logic and are
labeled `contextual-rebase`. Each attempted step records its target-before
tree, conflict evidence when present, and result tree when complete.

`vcs-lab.rebase-forecast/v1` pins source/onto heads and trees, the full plan and
fingerprint, explicit candidate policy/omissions, automated resolution/spec
decisions, step trees, and the predicted final tree. Caller evidence includes
the exact branch, HEAD/tree, plus SHA-256 digests of index entries, porcelain
status, and the worktree list. Forecasting compares the complete snapshots
before saving under the caller's worktree Git directory. Dirty bytes are
reported but deliberately excluded because the scope is committed heads.

Unaccepted heuristic candidates convert an otherwise complete simulation to
`review-required` and remove its predicted-tree claim. A Git application error
without conflict paths—including an unexpected empty replay—blocks instead of
being silently skipped.

### 7.5 Supervised causal rebase application

`startRebase` operates only on the current named branch with a clean worktree.
It rebuilds the exact plan, rejects stale or incomplete forecast approval before
mutation, writes `vcs-lab.rebase-operation/v1`, resets the branch to `ontoHead`,
and cherry-picks only the ordered replay queue. Every forecasted step must
reproduce its target-before tree, decision kind, result tree, and final predicted
tree. Heuristic candidates require an explicit accepted policy.

Clean and contextual same-intent applications preserve `Change-Id`. A conflict
remains visible as ordinary Git cherry-pick state while exact resolution and
spec tools route through the owning rebase journal. `--continue --fork` rewrites
the merge message with a new Change ID plus `Derived-From`/origin evidence.
Unexpected empty applications and out-of-band Git-state mismatches fail closed.

Provisional applications stay only in the worktree journal. After the complete
queue and predicted tree verify, finalization publishes one
`vcs-lab.rebase-application/v1` record per replay and one `vcs-lab.rebase/v1`
summary at the new tip. Abort delegates active cherry-pick cleanup to Git, then
hard-resets the exact original source tip and clears the journal without shared
receipts. Linked worktrees therefore share completed facts but cannot overwrite
or continue one another's active operation.

Metadata export builds a deterministic carrier from accepted facts: attachment
and referenced commits become parents, while required trees and blobs become
real entries under `trees` and `blobs`. Parent fan-in is bounded at 64. The
sanitized notes commit parents this carrier, so pre-rewrite origins and raw
conflict-stage blobs travel in `objects.bundle`. Import preview accepts required
objects present in the destination or verified bundle. The local retention
chain is excluded from export; manifest v1 destination refs remain unchanged.

## 8. Landing flows

### 8.1 Compact landing

```text
target-before ----- landing-commit
                      /
source-head ---------
```

1. Require a clean target worktree.
2. Resolve target, source, base, source range, and Change IDs.
3. Run `git merge --no-ff --no-commit <source-head>` with Git's rerere
   disabled (`-c rerere.enabled=false`), so a recorded Git resolution cannot
   be staged into the landing; a conflict fails the landing without a receipt
   (ADR-0018).
4. Commit with landing trailers.
5. Attach a landing receipt.

This is the preferred shape because stock Git retains the causal parent.

### 8.2 Hard-squash landing

```text
target-before ----- squash-commit       source-head
                         :                  |
                         : receipt edge     |
                         +------------------+
```

The flow uses `git merge --squash` (with rerere disabled, as in the compact
landing), commits one parent, and attaches the exact absorbed range as a
receipt. If the merge conflicts before commit, the command
publishes no receipt. Stock Git cannot infer the sideband edge; `vlab` can.

## 9. Forecast architecture

A forecast is a simulation artifact, not a promise based on branch names.

```text
caller worktree (captured invariants)
        |
        +--> build exact causal plan
        |
        +--> merge-tree engine (default on Windows): one batched object inspection, then
        |    one persistent git merge-tree --stdin process merges each queued
        |    change onto the accumulated tree
        |           |
        |           +--> every step clean: record step/result trees
        |           +--> any step conflicted, empty, or unsupported:
        |                discard the attempt, record the reason, fall back
        |
        +--> worktree simulator (the oracle; default on POSIX):
             create detached temporary worktree at target OID
                    |
                    +--> apply each reviewed-new change
                    +--> inspect exact conflicts
                    +--> apply one exact known result if unambiguous
                    +--> compute deterministic spec merge if clean
                    +--> record step/result trees or blocker
        |
        +--> remove temporary worktree
        +--> verify caller HEAD/tree/status unchanged
        +--> save pinned forecast in caller's private Git dir
```

The engine is selected by `VLAB_FORECAST_ENGINE` or `--forecast-engine`;
without either, Windows uses `merge-tree` and other platforms `worktree`,
mirroring the object session's platform default (ADR-0016, amendment of
2026-08-30). Both engines pin the same per-step and predicted
tree IDs; [ADR-0016](adr/0016-simulate-clean-forecast-steps-with-a-merge-tree-session.md)
records the algorithm, the fallback rule, and the Git constraints.

### 9.1 Forecast contents

- source/target commit and tree IDs;
- physical/effective bases and reachable receipts;
- full classified plan and its SHA-256 fingerprint;
- candidate-equivalence acceptance setting;
- each simulated step and result tree;
- exact conflict signatures and chosen resolution record/result blobs;
- deterministic spec signatures and result hashes;
- partial tree for a blocker;
- predicted final tree for a complete simulation;
- the engine that produced the simulation and every recorded fallback;
- phase, worktree, and merge-tree timings and Git logical/process metrics.

### 9.2 Isolation mechanics

The worktree simulator creates a temporary detached Git worktree, performs
the simulation there with Git's rerere disabled on every cherry-pick (the
temporary worktree shares the repository's `rr-cache`; ADR-0018), aborts any
in-progress cherry-pick, and removes/prunes the temporary worktree in cleanup. The caller's head, tree, and porcelain
status are captured before and after. A difference is an invariant violation.

The merge-tree engine never creates a worktree. It runs one
`git merge-tree --stdin` process in the caller worktree with
`GIT_ATTR_SOURCE` set to the target tree, so attribute lookup matches the
worktree simulator's checkout rather than the caller's checkout; the process
reads and writes objects only and never touches HEAD, the index, or working
files. Both engines leave unreferenced objects (result trees, or the
simulator's commits) for Git to garbage-collect. A conflicted, empty,
merge-commit, root-commit, or attribute-changing step, or a session failure,
discards the merge-tree attempt and reruns the whole queue in the worktree
simulator with the reason recorded in the forecast. The engine needs Git
2.49, the first version whose `merge-tree --stdin` flushes each record
before reading the next request (bare tree operands date from 2.45 and
`GIT_ATTR_SOURCE` from 2.43). The session process runs with
`GIT_TRACE2_EVENT=2`, so its trace2 `version` event reaches the worker on
stderr before Git reads any input; on older Git the worker refuses the first
request and the forecast records a `git-too-old` fallback naming that
version, so the check costs no Git process on any path and never waits for
the session timeout. Git's own stderr messages are kept apart from the
trace2 lines for error reporting.

Forecasts use committed heads by default. A workspace forecast may explicitly
select one immutable source checkpoint and records that distinct scope. Dirty
file counts may be reported, but live uncommitted bytes are never silently
treated as stable causal inputs.

## 10. Reconciliation state machine

```text
                   conflict
new -> running ----------------> paused
         |                         |
         | queue complete          | continue
         v                         v
     finalizing <-------------- running
         |
         +--> completed (journal removed, records published)

paused/running/forecast-mismatch --abort--> starting commit restored
```

### 10.1 Start

1. Require a clean worktree and no existing operation.
2. Build and optionally compare the plan with a named saved forecast.
3. Reject unaccepted candidates or stale forecast inputs before mutation.
4. Create a private journal containing the complete queue, starting commit,
   exact plan, approvals, timing accumulator, and current index.
5. Cherry-pick queue entries one at a time with Git's rerere disabled
   (`-c rerere.enabled=false`): a conflict is resolved only by vlab's approved
   memory, a deterministic spec merge, or the user, never by `.git/rr-cache`
   (ADR-0018).

### 10.2 Clean application

After Git creates the applied commit, the tool resolves source and result trees,
creates an application record in the private journal, and advances. Records are
not published to notes yet because a later queue item may fail or be aborted.

### 10.3 Conflict pause

The tool records:

- current source change and target-before commit;
- Git-reported conflicted paths;
- ordered three-way conflict descriptors;
- exact resolution candidates;
- deterministic spec plans when indexed Markdown is involved;
- forecast approvals, if any.

It leaves Git's cherry-pick state intact and exits with recovery instructions.

### 10.4 Continue

The user or forecast stages a resolution. Continue verifies the operation and
staged semantic manifests, invokes `git cherry-pick --continue` (again with
rerere disabled, so the resolution is recorded in vlab's catalog and never in
`.git/rr-cache`), classifies the relation as contextual application or
contextual fork, records exact outcomes, and resumes the remaining queue.

### 10.5 Finalize

Before publication, finalization:

1. resolves result commit/tree;
2. compares a pinned predicted tree, if present;
3. excludes explicit forks from absorbed-source coverage;
4. constructs application and reconciliation records;
5. publishes retained resolution results;
6. appends application notes to applied commits;
7. appends the final reconciliation note;
8. removes the private journal.

If the predicted tree differs, the state becomes `forecast-mismatch`; receipts
are not published and abort remains available.

### 10.6 Abort

Abort delegates in-progress cherry-pick cleanup to Git as applicable, restores
the exact `targetBefore` commit recorded at operation start, and clears private
state. Since application records were not published early, an aborted queue
leaves no causal claim for partial work.

## 11. Exact resolution architecture

For each unmerged path, Git index stages provide:

- stage 1: merge base blob;
- stage 2: target/ours blob;
- stage 3: source/theirs blob.

The ordered blob identities form `ordered-three-way-blobs/v1`. The file path is
not part of the signature, enabling exact reuse after a rename. A candidate
record points to a result blob retained in a small commit under:

```text
refs/vcs-lab/resolutions/<signature>/<result-blob>
```

On Windows, the absolute ref path plus `.lock` must fit within 259 characters
when Git long paths are disabled. After a failed directory/path creation,
publication resolves the actual ref location through the engine's `gitPath`
operation and reports `path-length-exceeded` if the lock path reaches 260
characters. Successful publication incurs no extra reads. Existing-lock and
permission errors keep their Git classification; no ref layout or Git setting
is changed. See [Windows resolution retention paths](testing.md#windows-resolution-retention-paths)
for path budgets, linked-worktree behavior, and recovery.

Selection rules:

- zero candidates: resolve manually; successful continuation can create one;
- one candidate: show it, but require `resolve apply` or forecast approval;
- multiple result blobs: require an explicit resolution record ID;
- user edits an applied candidate: record `modified`;
- user rejects candidates and resolves differently: record `rejected`.

This is exact resolution memory with explicit provenance, not a learned merge
engine. Future learned candidates must be a visibly lower confidence tier.

The catalog is discovered with a bounded number of Git processes regardless of
record count: one `for-each-ref` scan returns every retention ref and object
ID without touching objects (so a dangling ref cannot abort it), one batched
object check peels each ID exactly as `<ref>^{commit}` would, one notes listing
plus one batched object read loads the attached records, and batched object
checks validate referenced blobs and the retained `result` entry. A record is
quarantined when its stored ref, retention commit, ordered signature, or
retained result blob disagrees with the discovered state; a retention ref that
is dangling or does not name a commit is ignored, and a failed scan is an error
rather than an empty catalog. `vlab metadata validate` peels retention refs
exactly as the catalog does, so the two never disagree about whether a
retention ref accepts its record. Accepted records are ordered newest-first by
creation time.

## 12. Workspace and checkpoint architecture

`vlab workspace create` records a logical descriptor and creates a normal
linked worktree on `vlab/ws/<slug>`. The compatibility branch is necessary for
Git's current worktree retention semantics, not the desired final workspace
model. [ADR-0012](adr/0012-treat-workspace-lifecycle-as-reversible-materialization-and-drafts-as-checkpoint-inputs.md)
defines `active` and `archived` as materialization states of that stable logical
descriptor.

The registry resides in the common Git directory so every linked worktree can
discover it. A descriptor includes logical ID, name, path, branch, pinned base,
target label, optional owner/focus, creation time, lifecycle, and an optional
sparse-checkout `cone`.

`workspace create --cone <dir,dir>` materializes only the named directory
prefixes, through `git worktree add --no-checkout` followed by
`git sparse-checkout set --cone` and a checkout. The cone narrows the working
tree and nothing else: the workspace ID, compatibility branch, pinned base,
checkpoints, and lifecycle are identical with it and without it, Git still
holds the whole tree, and a checkpoint of a coned workspace captures the full
tree rather than the materialized subset. Restoring an archived workspace
reapplies its cone, so an archive/restore cycle does not silently write every
file back, and `git sparse-checkout disable` inside the worktree reverses it.
Cone paths are validated as relative and inside the repository before they
reach Git. Measured on the Windows host with 3000 files across 20
directories, a cone over one directory took `vlab workspace create` from
1804 ms to 467 ms; the full checkout was the first phase in the program
measured over the 1000 ms interactive budget (issue #10).

`workspace list` inspects each descriptor whose path exists with one
worktree-scoped `git status --porcelain=v2 --branch -z` query. Its header
yields the exact `HEAD` commit and its NUL-separated entries yield the dirty
count (rename and copy entries count once), so usability, head, and dirtiness
cost one process per materialized workspace. A nonexistent path is `missing`;
a path that is not a directory, or a directory Git does not recognize as a
work tree, is `invalid`; an unborn `HEAD` reports a `null` head; and archived
descriptors report `archived` without probing. A recognized work tree whose
status cannot be read (for example a corrupt private index) fails the listing
loudly rather than degrading to `invalid`. Nothing is read from or written to
another worktree's private index or symbolic refs.

Lifecycle commands preserve workspace ID, compatibility branch, and checkpoint
identity:

- move delegates to `git worktree move` and preserves dirty bytes in place;
- archive removes only a clean worktree with no ignored files or reconciliation/rebase journal;
- restore materializes the retained branch at the recorded or requested path;
- repair validates common-repository and branch identity before delegating to
  `git worktree repair`; and
- prune previews missing active paths, then requires `--apply` to clean stale
  Git administration and mark their descriptors archived.

Archive checks the target worktree's private journal paths by presence, without
parsing: malformed, null, or unsupported-version state also refuses with
`operation-in-progress`. A refusal preserves the registry, refs, materialization,
and journal bytes. Move and repair retain the private Git directory and pending
operation recovery state. An applying prune with missing candidates checks all
linked administrative directories via the `listWorktreeGitDirs` engine operation,
including missing and unregistered worktrees. Git prune acts repository-wide, so
this check conservatively refuses even a journal belonging to a live linked
worktree. Preview and an apply with no candidates remain nonmutating.

Recovery starts with restoring/repairing any missing worktree path and inspecting
`reconcile --status` or `rebase --status` there. Continue resolved conflicts, or
abort blocked operations; clean interrupted publication and forecast mismatches
use abort to restore the starting head. Unreadable journals must be preserved and
recovered with a compatible build. These preflights protect already-present
journals; they do not serialize lifecycle removal against concurrently starting
operations or protect against external Git removal/pruning.

Registry writers (create, move, archive, restore, repair, and prune with
`--apply`) take one shared lock **before reading registry or branch state**
and retain it through validation, materialization, and the atomic JSON rename.
`saveWorkspaces` requires that lock. Thus a contender always reads the latest
published registry after the preceding writer finishes. Listing, checkpoint
lookup, and prune previews read an atomic registry snapshot without locking.
The lock serializes cooperating vlab registry writers; older builds without
this lock, ordinary Git commands, and workspace content edits do not participate.

The claim is created exclusively, carries a random ownership token plus
diagnostic PID/hostname/time, and adds no Git process. Contenders wait up to
five seconds before `workspace-registry-locked`. Release removes only the
current claim's token. No waiter automatically renames or deletes a stale,
foreign, or malformed claim: inspection followed by unlink/rename cannot
conditionally remove the inspected file, so a replacement holder could lose
its lock. Recovery therefore requires stopping all workspace writers on every
host sharing the repository, inspecting the registry and Git worktrees for
partial changes, and removing only the lock before restarting writers.

An ordinary materialization failure publishes no registry change and releases
the lock. Git may already have created a worktree or branch; these remain for
inspection, and the error names the path and recovery action. The lock is
serialization, not a cross-file transaction: a process exit leaves its claim
for explicit recovery, and a Git mutation followed by failed registry
publication may require manual reconciliation of the retained registry with
Git. No registry schema or lifecycle identity changes.

### 12.1 Non-disruptive checkpoint

1. Create a disposable directory and temporary index.
2. Read `HEAD` into that index.
3. Add the current working tree through the temporary index.
4. Write a tree.
5. Create a commit whose parent is the captured `HEAD` and whose trailers pin
   workspace, base, tree, and deterministic `draft_` identity.
6. Retain the prior latest snapshot under
   `refs/vcs-lab/checkpoint-history/<workspace-id>/<checkpoint-oid>`.
7. Update `refs/vcs-lab/checkpoints/<workspace-id>`.
8. Remove the temporary index directory.

The real index, `HEAD`, and working files never change. Ignored files remain
excluded by normal Git rules.

### 12.2 Immutable source-checkpoint forecast

`workspace forecast <target> <source> --source-checkpoint` verifies that the
source's latest checkpoint belongs to that workspace, pins its commit/tree/base,
and rejects it if the source branch moved or the checkpoint has no overlay. The
target remains its committed workspace head. Forecast simulation and reviewed
application reuse the existing reconciliation path, while current live dirty
files in both worktrees remain unread and unchanged. Forecast scope explicitly
states `source-checkpoint`; it is never presented as a committed-head comparison.

## 13. Specification architecture

The [adapter contract](structured-document-adapters.md) specifies the required
format acceptance evidence and documents Markdown's current bytes, entities,
identity, merge rules, blockers, migrations, and sparse storage limitations.

### 13.1 Canonical and derived data

Markdown is canonical. A v4 manifest persists only:

- schema;
- artifact ID;
- normalized source path and source hash;
- optional tracked Git source blob OID;
- entity count;
- representation, parser, and ID algorithm identifiers;
- exceptional ID overrides needed to preserve legacy identities.

Titles, line positions, content hashes, semantic keys, and ordinary IDs are
reconstructed from the Markdown on demand.

### 13.2 Parser and entity identity

The parser `stable-markdown-blocks/v2` identifies:

- an optional preamble;
- heading-delimited sections;
- explicit `REQ-*:` records as nested addressable entities.

Backtick and tilde fences suppress heading and requirement recognition under
the explicit grammar in [ADR-0026](adr/0026-version-fence-aware-markdown-boundaries.md).
Historical v1/v2/v3 manifests retain their v1 parsing on read. Indexing writes
v4 after verifying the old source and matching surviving declarations by
location. Ordinary IDs still use `artifact-semantic-key-sha256/v1`; shifted
occurrence keys retain their real entity IDs through sparse `idOverrides`.
Unknown versions and unavailable migration source refuse indexing, including
`--force`. Older manifests bypass every unchanged-source/blob cache.

### 13.3 Incremental indexing

For repository-wide indexing:

1. inventory tracked and non-ignored Markdown;
2. resolve repository context once;
3. compare the manifest's `sourceBlob` with the Git index blob;
4. return a zero-content-read cache hit when equal;
5. batch-hash/read only new or changed sources;
6. avoid rewriting an unchanged manifest.

### 13.4 Deterministic three-way merge

Merge units are non-overlapping preamble and heading sections. Requirements are
nested identity/review entities, not a competing byte-merge layer.
The v2 planner blocks legacy inputs whose corrected boundaries differ with
`parser-migration-required`, including an affected historical base. Compatible
legacy stages may participate without rewriting history. V1 semantic approvals
cannot authorize v2 output; regenerate forecasts or abort pending operations
before retrying. Raw exact-resolution records retain their byte-based rules.
The [requirement-level evaluation](structured-document-adapters.md#requirement-level-merge-evaluation)
explains why promoting indexed declaration lines is insufficient and what a
future version must settle about byte ownership, context, identity, and migration.

For each stable primary block, the algorithm compares base, target, and source
presence, content, and placement:

- one-sided edit/add/delete/move: select changed side;
- identical concurrent result: select it;
- target edit plus source move (or reverse): combine if ordering is compatible;
- divergent same-block edits: block;
- delete versus edit: block;
- incompatible moves or add placement: block.

A clean result is rendered with LF line endings, one blank line between blocks,
and one final newline. The sparse sidecar is regenerated with the same IDs. The
plan pins all input stage fingerprints and output Markdown/manifest hashes.

### 13.5 Integration with reconciliation

Git commonly reports a conflict in the tracked sidecar even when Markdown
blocks are independent. During forecast or a paused operation, `specs.js` reads
the base/target/source Markdown and manifests in batches, builds a semantic
plan, and exposes it as a deterministic decision. A forecast can pin and later
authorize it. Without a forecast, `vlab spec resolve` stages the explicit
suggestion. Continue validates that the sidecar still describes staged
Markdown and records `accepted` or `modified`.

## 14. Git adapter and persistent object session

### 14.1 Ordinary adapter

`runGit(args, options)` uses argument arrays, controlled environment merging,
bounded buffers, explicit binary/text handling, and optional expected failure.
Successful mutation commands invalidate any active object session. Active
metric collectors record logical query count, process launches, duration,
failure, and command group. Trace mode emits metadata only.

Repository context is resolved as a tuple:

```text
{ root, gitDir, commonDir, objectFormat }
```

This supports SHA-1/SHA-256 and prevents the common error of treating the shared
Git directory as the current linked worktree's private Git directory.

### 14.2 Invocation-scoped session

On Windows by default, or with `--git-session`/`VLAB_GIT_SESSION=1`, a domain
operation may open one `GitObjectSession` keyed by resolved worktree path. The
session is initially only a scope and cache; its worker starts lazily when the
first uncached object request is ready, after synchronous preflight commands
have completed. The worker thread owns:

```text
git cat-file --batch-command
```

The synchronous main thread submits `info` or `contents` queries through a
bounded shared-memory channel. The worker serializes requests and parses the
streaming response. An unexpected Git exit rejects every pending request so the
caller can fall back. Shutdown closes the batch-command input and waits for the
child `close` event—after stdio drains—before acknowledging the caller. Bounded
Windows process-tree termination and worker acknowledgement fallbacks prevent a
failed close from retaining the CLI or leaving a session worker behind.

Within an active object session, `listNoteEntries` reads the notes ref's tree
and its two-hex-digit fanout directories through the same process used for
note blobs. It recognizes regular-file attachments at the repository's full
SHA-1 or SHA-256 width, preserves Git's target ordering, and ignores opaque
non-note entries. The mutable root expression is resolved on every listing;
only trees addressed by immutable OID can use the session cache.
An absent notes ref returns an empty listing directly; resolving its absence
replaces the ordinary listing process instead of adding a second process.

The traversal reads at most 64 trees per request and delegates the entire
listing to `git notes list` if it encounters duplicate attachments, an
unavailable or malformed object, or exceeds 1,024 trees or 16 MiB of tree
content. These are optimization budgets, not repository input limits. Git
remains responsible for its duplicate-note concatenation behavior, which can
create a combined blob even during listing. No partial catalog is returned.
Without an active session the ordinary listing command is used directly.

Opt-in lifecycle diagnostics record session/worker creation, request posting,
shared-memory waits, Git request/response events, fallback, and shutdown.
`VLAB_GIT_SESSION_DIAGNOSTICS=1` writes one JSON line per event to stderr from
the main thread (`[vlab session]`, which also covers the merge-tree session
below) and from the object-session worker (`[vlab session-worker]`), and
`VLAB_GIT_SESSION_DIAGNOSTICS_FILE=<path>` additionally appends the same lines
to that file, with a failed append ignored so diagnostics can never change
session behaviour. They are disabled during normal operation and are intended
for bounded process-tree investigation.

The merge-tree forecast engine reuses the same shape: a `MergeTreeSession`
whose worker owns one `git merge-tree --stdin` process for the forecast,
answers each merge through the shared-memory channel, records merges as the
synthetic `merge-tree-session` command with one counted process, and is
closed within the same bounds when the simulation ends.

### 14.3 Cache and safety rules

- Only expressions rooted at a complete SHA-1 or SHA-256 OID are immutable
  cache candidates.
- `HEAD`, branch/tag names, revision walks rooted at symbolic refs, and index
  expressions are not cached.
- A successful mutation invalidates the worktree session.
- A failed/closed/timed-out session marks itself unusable and callers fall back
  to ordinary Git.
- Each linked worktree receives a distinct session.
- The session ends with the enclosing invocation; there is no background daemon
  or cross-command lock.
- Closing or disabling a session waits only within fixed bounds and always
  terminates the worker afterward.

The ordinary path remains both fallback and semantic oracle. Equality matters
more than raw wall time.

### 14.4 Read-side engine seam

Every repository read a domain module performs is one of the 39 operations
cataloged in `src/engine.js`
([ADR-0019](adr/0019-route-every-git-read-through-one-engine-seam.md)):
repository and host context, object resolution and batched reads, history
walks and commit metadata, refs and notes, and worktree, index, and status
queries. `src/git.js` is the Git engine that implements each operation using
ordinary Git processes or object-session queries. Introducing the seam
preserved process counts; the session notes traversal described above removes
the separate listing process for supported trees. Composites such as
`currentHead`, `changeIdForCommit`, and `assertClean` are derived from
cataloged operations only. Mutations do not pass through the seam; they stay
explicit `runGit` calls.

`VLAB_ENGINE` or `--engine <git|native>` selects the read engine. `git` is
the default everywhere and the oracle. `native` loads the optional Rust binding
for the five resolution-catalog operations in ADR-0027. A missing prebuild reports
`binding-missing` and every operation passes through to Git. When the
selected engine lacks an operation or throws, the seam answers with Git and
records the fallback; `endGitMetrics` reports `engine`, the `fallbacks`
aggregated per operation and reason, `nativeReads` counts, and `directReads`.

The bounded first native read increment is accepted in
[ADR-0027](adr/0027-bound-native-read-engine-entry-by-the-resolution-catalog-budget.md)
under the owner decision in #18, with dependency review recorded on #83 before
code. [Native qualification](native-engine.md) requires available-binding tests
to assert actual execution; fallback-only results do not qualify native performance.

A read-only Git command that reaches `runGit` without the seam's private mark
is a direct read: counted in `directReads`, traced, and refused in native
mode. Two deliberate measurements are exempt, both marked `rawProbe`: the
doctor's process-cost probes, and the scale benchmark's raw-Git floors
(issue #42). Both exist to measure what one Git process costs on this host,
which is the one question the seam cannot answer about itself — routing them
through it would measure the seam. Their results are timings and never reach
domain logic. The read-only classification is the same one that decides
object-session invalidation.

`vlab doctor` reports both selectors (`engine`, `forecastEngine`), and
`vlab doctor --differential` runs every cataloged operation through each
engine against the current repository, comparing result digests, process
counts, and fallbacks operation by operation
(`vcs-lab.engine-differential/v1`). The suite's `VLAB_ENGINE=native` mode, one
of the six modes [testing.md](testing.md) lists, proves that every read it
exercises goes through the seam.

## 15. Consistency model and invariants

### 15.1 Strong local invariants

- Git OIDs exactly identify state.
- A named forecast applies only to its exact target/source/plan.
- A forecasted complete reconciliation must reproduce its predicted tree.
- No partial application receipts are shared before whole-operation success.
- A worktree has at most one pending reconciliation or rebase journal.
- Resolution reuse requires the exact ordered blob signature.
- A semantic sidecar must match its Markdown at continue time.
- Candidate equivalence is never silently accepted.

### 15.2 Explicit cross-clone consistency

Causal notes and resolution refs still do not follow normal branch fetches
automatically. `metadata export` creates a deterministic manifest and sanitized
Git bundle; `metadata import --dry-run` verifies it in a disposable repository,
then `--apply` stages and atomically publishes non-conflicting refs. Tracked
spec manifests move with ordinary project content. Workspace registries,
checkpoints, reconciliation/rebase journals, and forecasts remain deliberately
local. The envelope carries accepted records plus referenced commits that may no
longer be reachable from an ordinary branch after a rebase.

Envelope v1 lineage uses Git object format plus sorted root commits, read with
replacement objects disabled so a local `git replace` graft cannot change the
identity (issue #88), reachable
from branches, tags, and remote-tracking refs. Equal roots identify the same
lineage; any shared root identifies an ordinary fork. Unrelated and
history-filtered histories fail closed.

### 15.2.0 Competing causal facts

Two clones can hold different content under one record identifier. The policy is
[ADR-0030](adr/0030-define-conflict-policy-for-competing-causal-facts.md), and
identity is its only conflict key: a record id with a different digest, or a
resolution ref with a different target. Two records with distinct identifiers
never conflict, whatever they claim — two receipts of one family on one
attachment commit are independent facts, because an ordinary re-run of
`vlab reconcile` with everything already covered legitimately writes a second
one.

Four behaviours follow, and every reader implements the same one rule so the
planner, the resolution catalog, and `vlab metadata status` cannot disagree
about which facts exist:

1. **A conflicted fact contributes nothing, on both sides.** Neither copy proves
   coverage, serves as a resolution candidate, is displayed as provenance, or is
   exported. `readCausalRecordCatalog` builds one conflict set from two sources:
   an identifier duplicated inside the notes tree, and an identifier a parked
   incoming copy disputes.
2. **Evidence reduces; nothing blocks.** The affected change is classified from
   what remains, so it moves down the ADR-0004 lattice to
   `candidate-equivalent` or `new`, never up, and the plan, the forecast, and the
   receipt carry a `quarantinedFacts` list naming what was excluded. A single
   disputed record from a peer must never stop local work (NFR-SEC-03), and
   replaying a change that was in fact landed is recoverable while omitting one
   that was not is data loss.
3. **Conflicts park.** `vlab metadata import` keeps its refuse-whole-envelope
   default; `--park-conflicts` applies the non-conflicting records and refs
   atomically and writes each conflicting incoming record, with its envelope hash
   and source lineage, as the blob of one ref under
   `refs/vcs-lab/quarantine/<lineage>/<record id>`. Park mode is the only mode an
   automatic transport may use. Git's own `git notes merge` stays forbidden on
   `refs/notes/vcs-lab`: the manual strategy stops in a conflicted worktree and
   `-s union` concatenates the containers into something
   `vlab metadata status` reads as `malformed-record`, dropping every record on
   that attachment.
4. **A person disposes, once.** `vlab metadata dispose <record id>
   --keep-local|--replace-local` removes the parked copy and records a
   `vcs-lab.disposition/v1` entry naming the digest kept and the digests
   rejected, so a later exchange carrying a rejected digest is reported as
   already disposed rather than parked again. The registry is shared-local and
   never travels, because two clones may decide differently and that
   disagreement is real.

The parked blob's referenced objects are retained by the ordinary import
retention commit, so a later `--replace-local` still has the objects its record
names. Nothing here authenticates a claim: which copy is true remains the trust
question of §15.3, and this policy only guarantees that neither copy is used
until someone decides.

### 15.2.5 A target overlay is context, not a draft commit

[ADR-0028](adr/0028-define-target-checkpoint-forecast-semantics.md) settles what
a target checkpoint contributes to a forecast. The answer that shapes everything
else: an overlay is **uncommitted context**. It is not a plan entry, not a
coverage input, and not a receipt subject, so nothing it contains can change what
a plan concludes or what a receipt claims — the plan, its fingerprint, and the
committed predicted tree are computed against the committed target head exactly
as without one.

An overlay is one checkpoint commit whose recorded base equals the committed
head, identified by that commit rather than by the checkpoint ref, which moves
when the next checkpoint is captured. Nothing is ever captured on a user's
behalf: `--target-checkpoint` on `vlab forecast`, `vlab workspace forecast`, and
`vlab rebase-forecast` selects an existing checkpoint, and uncommitted work
without one is refused rather than quietly promoted into approved state.

The forecast carries a **second** predicted tree: the worktree after the overlay
is put back, computed as a three-way merge of the target tree before application,
the committed result tree, and the overlay tree. That merge is not an
implementation detail but the definition of re-materialization. A checkpoint
captures the *whole* worktree at its base, so writing that tree back over an
applied result would restore the pre-application version of every path the
application touched and silently undo the work; the merge keeps the applied
changes and re-applies only the draft. An overlay that does not merge blocks the
forecast, and live bytes are never merged.

Application is ordered so that nothing is published on a guess:

1. the live tree must equal the overlay tree exactly, or the run refuses with
   `stale-overlay` before anything moves — a drifted worktree means the *capture*
   is behind, and the remedy is a new checkpoint, never a silent re-capture;
2. the worktree is reduced to the committed head, the overlay already safe in its
   checkpoint;
3. the picks run and the committed result tree is verified as usual;
4. the overlay is re-materialized and its tree verified against the prediction;
5. only then are receipts published.

A mismatch at step 4 leaves the operation in `forecast-mismatch` with abort as the
recovery and publishes nothing. Abort restores the committed tip first and
unconditionally, then puts the captured worktree back — including its untracked
files, since that is the state the user asked to keep. An overlay whose object is
gone is reported as unrecoverable and the worktree left clean, because the tip is
already correct and inventing bytes for a draft would be worse than saying it was
lost.

A causal rebase carries an overlay by the same contract and the same module
(issue #28). The worktree it overlays is the source branch's own, because a rebase
rewrites the branch the caller is standing on, and two consequences follow. The
merge's `ours` side is the rewritten tip and its base is the tree the branch held
before the rebase started, so the prediction is pinned once per run rather than
once per pick. And the reduction at step 2 must precede the reset onto the new
base: that reset would discard the overlay's tracked edits and strand its
untracked files in a worktree they no longer belong to. Everything else —
selection, staleness, the second predicted tree, the mismatch state, abort — is
the reconciliation contract unchanged.

### 15.2.4 A rebase range is a declaration, not a discovery

[ADR-0032](adr/0032-generalize-causal-rebase-to-explicit-linear-ranges.md)
generalizes causal rebase from the current branch's whole divergence to an
explicit linear range. `--from <base>` names the exclusive lower bound; without
it the base is the physical merge base, so a v1 plan is unchanged byte for byte,
which `test/rebase-ranges.test.js` pins by building the same plan both ways.

The range moves only the *enumeration* of source changes. `physicalBase` keeps
its meaning as the real merge base, and the effective-base and candidate logic
still read it; what changes is where the change list starts. That is deliberate:
a commit below the range base is absent from `changes` rather than filtered out
of it later, so there is no member for it to linger in and nothing that could
accidentally classify, absorb, or cover it.

What the caller leaves behind is declared instead. The plan and the summary
receipt both carry `excludedByRange` — commit, `Change-Id`, and subject for every
commit between the physical merge base and the range base — so a person sees
exactly what will not travel. Nothing is dropped silently; equally, nothing is
proven about it, because a receipt that claimed work which stayed behind would be
false.

Three shapes are refused with `unsupported-range` rather than guessed at: a base
that is not an ancestor of the tip, a base that *is* the tip (an empty range), and
a tip that is not a branch tip. The last is the interesting one — the commits
after a mid-branch tip would need re-parenting, which is the interactive editing
of #30 and not something a linear range should do quietly.

The forecast pins `range.base` beside the heads and trees it already pins, and the
plan fingerprint covers the base, so an approval for one range cannot authorize
another. `range.explicit` is deliberately outside the fingerprint: naming the same
base is the same range, whether or not the caller typed it. Abort is unchanged —
the range decides what is replayed, never what is restored.

### 15.2.3 Portable verification is bound to Git objects

[ADR-0031](adr/0031-carry-a-bound-source-inventory-for-portable-verification.md)
answers what a proof bundle must carry for a party that does not share the
repository. v1 carried the classification and the evidence it was derived from,
which lets a verifier recompute the classification — but `changes` was the
sender's word, and #46 showed that a bundle could omit, inject, or misidentify
source changes, restate its hash, and still report `ok` offline.

`vcs-lab.proof-bundle/v2` is a strict superset of v1 that carries Git's own
bindings: the raw commit objects of `physicalBase..sourceHead`, a commit path
from the target head for every positive coverage claim, an inclusion proof from
the notes tip to each receipt's note blob, and the anchors those proofs terminate
at. Objects are carried once in a map keyed by id, because every path shares its
first commits with every other; that is what keeps a bundle proportional to
history *depth* rather than to the number of claims.

The mechanism is that a verifier recomputes each object id from the carried
bytes. A sender chooses what to put in a bundle, but it cannot choose the id of a
commit whose message it altered, so the claims either reproduce Git's hashes or
do not.

Conclusions are placed in tiers, which are different statements rather than
degrees of confidence in one:

| Tier | Says |
| --- | --- |
| self-consistent | the classification follows from the evidence the bundle states |
| bound | the stated evidence is tied to Git objects between the heads the bundle *states* |
| anchored | those heads are the real ones, confirmed from a channel the verifier chose |

A third party may act on the anchored tier. `vlab verify-proof --anchors-from
<remote>` reads anchors with `git ls-remote` from a remote **the verifier**
names; a remote named inside the bundle is only ever a hint, because its producer
controls that name. Root commits are not ref tips, so that channel cannot supply
them, and the report says so rather than treating them as confirmed.

Absence stays unprovable without objects. `new` is a claim about the whole target
history and `candidate-equivalent` is a claim about trees, so both are reported as
claimed rather than proven, and `ok` never asserts a conclusion the carried
material cannot support. The repository-backed comparison is unchanged and
remains the only check that establishes absence.

### 15.2.2 Capabilities are a document, not a conversation

[ADR-0033](adr/0033-advertise-capabilities-as-a-document-negotiated-offline.md)
settles how two builds decide what they may exchange. A build states what it
reads and writes in a `vcs-lab.capabilities/v1` document projected from
`RECORD_FAMILIES`, `RESOURCE_BOUNDS`, and the profile and algorithm constants,
so the document cannot disagree with the build that emits it; the projection is
checked against the registries by `test/schema-compatibility.test.js`, which
fails when a registry change is not advertised.

Negotiation is then a **pure function of two documents**. It reads no network,
no repository, and no clock, so where the peer's document came from — a gateway,
a file, an envelope, a colleague — cannot change what it concludes. That is what
keeps offline envelope inspection a first-class path rather than a fallback: a
gateway adds exactly one thing an offline reader cannot have, the *current*
document of a party that is not in the room.

The comparison distinguishes an exchange that is **smaller** from one that is
**impossible**.

- Smaller: a family version gap. A stored record's version is fixed by whoever
  wrote it and compatibility §3 forbids re-encoding it, so records the peer
  cannot read are filtered out and named in `unreadableByPeer` with the
  disposition the peer's own document states. Everything else still moves.
  `vcs-lab.application` is why this is per record and not per family: v1 and v4
  are both current, written by different commands.
- Impossible: a profile, algorithm, object-format, or lineage disagreement, or a
  peer that reads no capability version this build writes. There is no set of
  bytes both sides would read the same way, so there is nothing to report per
  record. These refuse with `no-common-version`, or `repository-mismatch` for
  the repository cases, before any transfer.

For a document produced fresh for the exchange — an envelope, a proof bundle,
the capability document itself — the producer selects the highest version in
`local.written ∩ peer.readable`. Features are used only when both sides
advertise them, and tokens are opaque, so one a reader does not know is ignored
rather than refused. Bounds are the receiver's.

`vlab capabilities` prints the document and `vlab capabilities --against` the
report. Neither writes anything: in particular `capabilities` must not call
`initLab`, because a command that states what a build can do has no business
writing repository configuration.

### 15.2.1 Logical identity is not authentication

Logical identifiers are specified by `vcs-lab.logical-id/v1`
([docs/identity](identity/README.md)): a closed namespace set, a millisecond
clock that partitions rather than orders, and 48 random bits. Accidental
collision is negligible at that entropy; deliberate collision is trivial and
would remain so at any entropy, because a `Change-Id` is a line of text in a
commit message. Identifiers coordinate work across clones; they do not
authenticate it, and `vlab audit identity` (FR-ID-06) is what detects a copied
or forged one.

### 15.3 Trust limitation

Current receipts are integrity-linked to Git object IDs but locally writable by
any actor with repository access. They are evidence consumed under local trust,
not signatures or authorization. The proof label `receipt-commit` names what
that evidence is; the historical `signed-shaped-landing-receipt` it replaced
never denoted a verified signature and did not change this boundary.

### 15.4 What survives an interrupted publication

Publication is the one stretch of a reconciliation that is not a single atomic
act: several notes and refs move in sequence. `src/faults.js` names the points
where an interruption would be most damaging, and
`test/failure-boundary.test.js` stops the process at each. What survives:

| Interrupted at | Published | Journal | Recovery |
| --- | --- | --- | --- |
| before publication | nothing | present | `--continue` or `--abort` |
| mid publication | some application receipts | present | `--continue` refuses; `--abort` |
| before the reconciliation receipt | all application receipts | present | as above |
| before clearing the journal | every receipt | present | as above |

Two properties hold at every point. **No record is ever duplicated**: a
`--continue` after an interrupted publication refuses rather than replaying
the loop over records that already exist. And **no unsafe coverage survives an
abort**: the abort restores the starting commit but does not rewrite the notes
ref, so receipts published before the interruption remain on disk, attached to
commits the abort made unreachable. They carry no weight, because the
reachability rule of §7.2 admits only receipts reachable from the target, so
the plan reports the change as new and a proof bundle admits zero receipts as
evidence.

The consequence worth knowing is that an interrupted-then-aborted operation
leaves inert records behind. They are not a correctness problem and
`metadata validate` does not report them, which is consistent with how any
history rewrite orphans records; they are also not collected.

Publication is also the one stretch two worktrees can enter at once. Every
record reaches the notes ref through a read-modify-write. `appendNote` builds
a candidate notes tree, preserving flat, fanned, and mixed layouts, and publishes
notes and retention in one transaction that checks both previous tips. A new
resolution ref participates in the same transaction. Foreign ref changes cause
the transaction to refuse. `appendNote` and metadata import also hold
one lock file, `<common-git-dir>/vcs-lab/notes.lock`, created exclusively
the way Git creates its own lock files and costing no Git process. A lock
whose holder is on this host and no longer running, or a minute-old lock
whose holder cannot be checked, is abandoned; a running holder's lock is
waited for five seconds and then refused with `notes-locked`. The
failure-boundary suite proves the window is closed by parking one publisher
inside it with `VLAB_TEST_GATE` while another runs.

`refs/vcs-lab/retention` retains each published attachment and the typed closure
specified by `referencedObjectsForRecord`. Its previous tip remains an ancestor
of every new carrier. Objects survive branch deletion, reflog expiry, GC, note
deletion, and operation abort; retention never substitutes for target ancestry.
Before the checked transaction an interruption leaves only collectible candidate
objects; afterward each published fact has its closure retained. This does not
make an entire multi-record finalization atomic.

`metadata retain --dry-run|--apply` backfills accepted historical facts. It reports
eligible/quarantined records and dependency counts, verifies the inspected tips,
and applies under the notes lock. A notes-tip marker makes repeated backfill
idempotent. Missing objects remain quarantined and cause exit status 1, including
when valid facts were retained successfully. No automatic expiry or selective
pruning is implemented; see [ADR-0025](adr/0025-retain-the-object-closure-of-published-causal-facts.md).

`createCommit` acquires the same reentrant notes lock before `git commit` when
actors are declared, retaining it through the provenance append. A refused lock
therefore cannot create a commit or stage `--all` content. Commits with no actors
skip the notes lock. Git failures release the claim without publishing a
provenance record; successful nested appends reuse the outer claim.

This ordering closes the lock-refusal window, not the gap between two durable
writes. A caught provenance-publication failure reports that the commit already
exists, names it, preserves the original failure classification, and directs the
caller to [manual provenance repair](identity/README.md#7-repairing-a-declared-provenance-publication).
An abrupt process exit can still leave a commit without provenance and without
that diagnostic. There is no commit-publication journal or automatic rollback;
recovery attaches the original declaration to the retained commit under the notes
lock without rewriting history.

## 16. Failure handling

| Failure | Behavior |
| --- | --- |
| Dirty worktree before a mutating operation | Stop and print porcelain paths. |
| Landing merge conflict | Leave Git conflict for manual recovery; publish no landing receipt. |
| Reconciliation conflict | Persist journal and exact descriptors; leave cherry-pick paused. |
| CLI process exits during pause | Next process reads worktree-private journal and continues/status/aborts. |
| Forecast input is stale | Stop before starting reconciliation. |
| Forecast result tree differs | Do not publish receipts; preserve abort path. |
| Exact resolution is ambiguous | Require explicit record ID. |
| Spec merge is ambiguous or metadata stale | Leave blocked; require manual edit/reindex. |
| Persistent object worker fails | Mark session failed and use ordinary Git. |
| Merge-tree session fails or a forecast step is not clean | Discard the merge-tree attempt, rerun the whole queue in the worktree simulator, and record the reason in the forecast. |
| Unknown/malformed/dangling causal record | Diagnose and quarantine it from coverage, resolution lookup, and export. |
| A record identifier names more than one fact | Report `record-id-conflict` and exclude every copy from coverage, the resolution catalog, proof evidence, and export; the planner reads the whole notes tree so it applies the same rule as the validator (issue #87). |
| Envelope payload or inventory mismatch | Reject before destination mutation. |
| Import ID/ref conflict | Report exact conflict during dry-run; never overwrite silently. |
| A peer reads no version of a family this build writes | Filter those records out of the exchange and name them; the rest still moves (ADR-0033). |
| A peer disagrees about a profile, algorithm, object format, or lineage | Refuse with `no-common-version` or `repository-mismatch` before any transfer; there is nothing both sides would read alike. |
| A capability document of an unknown version, or over its bound | Refuse with `unknown-schema-version` or `resource-bound-exceeded`; the bound is checked before the document is parsed. |
| A target overlay whose live tree drifted from its checkpoint | Refuse with `stale-overlay` before any mutation; the capture is behind, so the remedy is a new checkpoint and nothing is re-captured automatically (ADR-0028). |
| A target overlay whose base head moved, or whose checkpoint object is gone | Refuse with `stale-forecast` before any mutation. |
| A re-materialized overlay that does not match its prediction | Leave the operation in `forecast-mismatch`, publish nothing, and recover by abort. The draft is already back in the worktree by then, so the journal records `overlayRematerialized` and abort skips its clean check in exactly that state; a pending operation the user has edited by hand still refuses. |
| An overlay an abort cannot read | Restore the committed tip anyway, report the overlay unrecoverable, and leave the worktree clean rather than inventing bytes. |
| A rebase range whose base is not an ancestor of the tip, is the tip, or whose tip is not a branch tip | Refuse with `unsupported-range` before anything moves; re-parenting the commits after a mid-branch tip is interactive editing, not a linear range (ADR-0032). |
| A rebase forecast approved for a different range base | Refuse as `stale-forecast`, naming both ranges; the fingerprint covers the base, so the refusal cannot be bypassed. |
| A proof bundle whose carried objects do not hash to the ids they claim | Fail verification and name each object; the bundle does not reach the bound tier (ADR-0031). |
| A proof bundle whose proofs would exceed `proofBundleBytes` | Refuse to emit and name the member that did not fit; a truncated proof cannot be told apart from an omission. |
| An anchor a verifier's chosen channel cannot confirm | Report it unconfirmed and stay at the bound tier; it is not a binding failure. |
| Import ID conflict under `--park-conflicts` | Apply the rest atomically; write the incoming copy under `refs/vcs-lab/quarantine/<lineage>/<record id>`; report `parked-record-conflict` against the local copy so neither side proves coverage (ADR-0030). |
| Import resolution-ref conflict under `--park-conflicts` | Leave the destination ref exactly where it pointed, park the incoming records that name it, and keep the rest of the exchange applicable. |
| An arriving digest a disposition already rejected | Report it as `disposed` and neither apply nor park it again. |
| A parked record this build cannot read | `vlab metadata status` reports it and keeps scanning; `vlab metadata dispose` refuses with the code its reason names. |
| Import publication race/failure | Checked atomic ref transaction fails; existing destination facts remain intact. |
| Two publishers write the notes ref at once | Serialized on the notes lock (§15.4); a lock whose holder is gone is abandoned, a running holder's is waited for and then refused with `notes-locked`. |
| Temporary forecast worktree cleanup encounters in-progress Git state | Abort it best-effort, remove worktree, prune metadata. |
| JSON state write is interrupted | Temporary file avoids replacing last complete record. |
| Any failure under `--json` | Print a `vcs-lab.error/v1` envelope on stdout with a code from the closed vocabulary in `docs/schemas/errors.md`; stderr stays empty and the exit code is unchanged (ADR-0021). |

Crash consistency between a successful Git mutation and a journal write is
fault-injected at the named points of §15.4 (`src/faults.js`,
`test/failure-boundary.test.js`): publication, the journal advance, and abort
cleanup, for both reconciliation and causal rebase. Every other boundary is
uncovered; production hardening must model and test process termination at
each of them.

## 17. Security boundaries

### 17.1 Inputs treated as untrusted

- CLI arguments and ref names;
- paths discovered from Git and the working tree;
- note/manifest JSON;
- commit messages and trailers;
- imported/fetched Git objects and refs;
- saved forecast and operation files if edited outside the tool.

### 17.2 Existing controls

- Git is invoked without shell interpolation.
- Object expressions reject newlines and protocol-breaking forms.
- Output buffers and session shared-memory buffers are bounded.
- Every persisted record family has a published resource bound that is checked
  before the record is parsed and fails closed
  ([compatibility contract](schemas/compatibility.md) §4): an oversize
  shared-portable note is quarantined, and an oversize local, tracked, or
  imported record refuses the command.
- A record whose schema version this build cannot read is quarantined or
  refused by its scope's rule, and is never rewritten in place.
- IDs used in paths are validated/slugged.
- Trace output excludes object contents and messages.
- Exact inputs are re-resolved before approved decisions are applied.

### 17.3 Missing controls

- repository-wide retention and pagination: nothing caps the number of notes,
  stored forecasts, journal queue entries, registered workspaces, or retained
  checkpoint and resolution refs, so those reads grow with the repository
  ([compatibility contract](schemas/compatibility.md) §4);
- cryptographic signatures and actor identity;
- authorization/policy evaluation;
- metadata quarantine and conflict resolution across remotes;
- malicious repository fuzzing beyond the malformed-input battery in
  `test/hostile-input.test.js` and the SHA-256 and unrelated-bundle cases in
  `test/object-format.test.js` (adversarial object graphs, hostile
  `.gitattributes`, symlink and case-folding path edges);
- a security model for any future resident service.

## 18. Observability and benchmarks

`beginGitMetrics`/`endGitMetrics` can nest around a domain phase. Reports include:

- logical command count;
- actual process launches;
- session queries and immutable cache hits;
- failures;
- the selected read engine, the per-operation fallbacks it recorded, and the
  number of reads that bypassed the engine seam;
- aggregate/maximum duration by Git subcommand.

Forecasts separate preflight, planning, simulation, invariant, temporary
worktree, and merge-tree session phases, and name the engine that produced the
pinned trees. Reconciliation accumulates active time across start/continue
processes and separately records elapsed wall time.

`vlab doctor --benchmark` measures ordinary repository probes and the object
session, and `vlab doctor --differential` compares the read engines operation
by operation. `vlab spec benchmark` measures cold, unchanged, and one-change corpus
paths plus metadata size. `vlab metadata benchmark` creates a bounded
disposable repository and measures history, stock worktree discovery, registry
reads, complete workspace status, notes, retained resolutions, and complete
metadata status. Every phase checks semantic equality across samples and
reports cold/median/p95 latency plus Git metrics; setup is reported separately.
`npm run demo:git-session` compares ordinary, object-session, and merge-tree
forecasts of one 12-change queue for plan, per-step tree, and predicted-tree
equality and process count; on the 2026-08-29 Windows development host the
three modes used 64, 25, and 10 Git processes (ADR-0016).

The initial representative Windows profile contains 250 commits, 12 registered
linked worktrees, 250 causal notes, and 50 retained resolutions. It measured
three Git processes per workspace status and 103 processes for the 50-item
resolution catalog, while the registry read used none and the 300-target note
catalog used two. ADR-0013 therefore selects invocation-local batching for
workspace status and resolution traversal before persistent indexes. One local
synthetic run cannot recommend a resident service. ADR-0013 records the
representative baseline and the resulting decision.

That batching is implemented. Rerunning the same schema on a Linux development
host moved workspace status from 36 to 12 processes (one per materialized
worktree) and the 50-resolution catalog from 103 to six, with identical
semantic results in ordinary and forced-session modes; ADR-0013 records the
before/after figures. The decision output now asks for larger fixtures and more
hosts rather than an index or service.

## 19. Testing architecture

The integration suite creates disposable Git repositories and invokes the real
CLI and Git executable. This tests filesystem state, refs, notes, worktrees,
process boundaries, line endings, and recovery behavior that unit mocks would
hide.

The current development baseline covers:

- initialization and versioning;
- compact/hard-squash landing and causal suppression;
- cherry-pick continuity and explicit fork;
- checkpoints and linked-worktree isolation;
- spec identity, migration, indexing, deterministic/blocked merges;
- forecast non-mutation, staleness, result mismatch, and batch approval;
- merge-tree forecast engine equality with the worktree simulator for clean
  reconciliation, rebase, workspace, and attribute-dependent queues, recorded
  fallbacks for conflicted, empty, attribute-changing, and unavailable-session
  cases, engine selection errors, and application of merge-tree forecasts;
- resumable conflicts, continue, abort, and contextual fork;
- exact resolution reuse, ambiguity, modification, and rejection;
- query batching, metrics, session equality, fallback, and worktree scoping.
- metadata scope inventory, stable diagnostics, invalid-record quarantine,
  deterministic envelopes, tamper/lineage/conflict rejection, and idempotent
  two-clone causal/resolution/spec parity.
- causal rebase plan determinism/non-mutation, hard-squash continuation
  selection, heuristic review, and linear-history enforcement.
- causal rebase forecast determinism, caller/worktree preservation, private
  persistence, explicit candidate acceptance, predicted trees, and conflict
  blocking/cleanup.
- supervised causal rebase stable identity, forecast reproduction/staleness,
  exact-resolution batching, contextual fork, unexpected-empty blocking,
  partial abort, linked-worktree isolation, validated records, and fresh-clone
  portability of unreachable origins.
- bounded repository-scale fixture construction, semantic equality across scan
  samples, process-amplification decisions, caller non-mutation, privacy, and
  exact disposable cleanup.
- batched workspace status across active, dirty, detached, unborn, archived,
  missing, invalid, non-directory, and unreadable-index paths, and batched
  resolution catalog discovery across valid, deleted, mismatched, malformed,
  dangling, tag-peeled, non-JSON, and bare-array notes (the last two are
  ignored, not listed), each with bounded process counts, ordinary/forced-
  session equality, and a volume-aware amplification decision.
- metadata validation and the resolution catalog agreeing on tag-pointing
  retention refs and bare-array notes, with an export/import round trip that
  carries a tag-pointing retention ref between clones.
- the engine seam: no module other than the seam imports read operations
  from the Git engine, unsupported or unavailable native operations pass through
  with recorded fallbacks and identical results, supported native operations
  assert actual execution, and a read outside the seam is
  refused in native mode unless it is one of the two `rawProbe` measurements, the differential doctor reports every cataloged
  operation equal, and invalid engine selections fail before any work.
- the focused suites [testing.md](testing.md) describes: schema-catalog and
  compatibility agreement, canonical-JSON vectors, human/JSON conformance,
  hostile input, failure boundaries at named fault points, the error
  envelope's static raise-site scan, declared provenance, SHA-256
  repositories, and checkout hygiene.

The same suite is run with the session forced on and forced off, with each
forecast engine selected, and with the native read engine selected — the six
modes of [testing.md](testing.md). Demos complement tests by providing
user-inspectable repositories and commands.

## 20. Extension rules

New capabilities should enter through versioned contracts:

- A new proof type must define evidence, reachability, precedence, and whether
  it can suppress work automatically.
- A new semantic format must define canonical bytes, entity boundaries, stable
  identity, deterministic rules, blockers, and migrations.
- A new automatic resolution tier must expose confidence/provenance and cannot
  weaken the exact tier.
- A new persistence location must state worktree/shared/portable scope,
  lifecycle, GC behavior, migration, and sync.
- A performance optimization must be equality-tested against ordinary Git and
  preserve failure recovery.
- A resident service must define ownership, locking, crash recovery, security,
  upgrade, shutdown, and fallback before implementation.
- A remote protocol must distinguish object integrity, causal evidence,
  signature trust, and policy authorization.

## 21. Known limitations and architectural debt

- Envelopes are explicit offline artifacts; automatic remote capability
  negotiation and synchronization are not implemented.
- Records written before v0.12.0 may still carry the historical
  `signed-shaped-landing-receipt` proof label, which readers pass through
  unchanged (§7.1).
- Workspace registry stores local absolute paths, and status still costs one
  `git status` process per materialized worktree because Git has no
  cross-worktree status query.
- Forecasts can consume one immutable source checkpoint and one immutable target
  checkpoint, but never live dirty bytes or a native private draft stack.
- Causal rebase v1 is deliberately linear and current-branch-only; it does not
  preserve merge topology or provide interactive edit/reword/squash. Explicit
  linear ranges and checkpoint overlays are supported; live dirty overlays are
  not, and a range whose tip is mid-branch is refused.
- Notes lookup still scales with the notes namespace and reachable history, but
  the note, resolution, and metadata catalog scans are batched into a bounded
  number of processes. Large-repository indexes are not implemented because no
  already-batched scan has exceeded a representative budget, and Git's own
  read-side maintenance caches are rejected on measured evidence
  ([ADR-0022](adr/0022-reject-git-read-side-maintenance-caches-on-measured-evidence.md)):
  the commit-graph and multi-pack index moved no phase beyond run-to-run
  variance, and `core.fsmonitor` starts a daemon the release gate forbids.
- Repository-scale evidence is synthetic, with post-batching figures from one
  Linux host and one Windows host (ADR-0013); real repositories must be
  measured before setting fixed targets or changing the service gate.
- Crash boundaries have fault injection at the named points of §15.4 and
  integration coverage for process-separated pauses, but not systematic
  kill/fault injection at every mutation/journal edge.
- Persistent session buffers are intentionally bounded and invocation-scoped;
  very large objects or workloads may fall back or require redesign.
- Markdown merge units are heading sections; nested requirement text does not
  merge independently.
- There is no cryptographic trust, server policy, or negotiated protocol.

## 22. Candidate next architectural increment

Metadata portability is implemented without a server. [ADR-0011](adr/0011-model-causal-rebase-as-a-forecasted-application-sequence.md)
is Accepted, and its linear plan, isolated forecast, supervised application,
recovery journal, and portable completed-receipt slices are implemented.

Workspace lifecycle and immutable source-checkpoint forecasting now have a
bounded worktree-backed implementation. ADR-0013's repository-scale fixture and
the batching it selected are both implemented, and the rerun shows no remaining
per-entity process amplification.

[ADR-0014](adr/0014-split-the-native-implementation-gate-into-engine-and-store-gates.md)
and [ADR-0015](adr/0015-adopt-a-phased-native-core-program-with-rust.md) set
the next increments: first Git-native wins with no new language, then a schema
catalog and a read-side engine seam, then a Rust `vlab-core` behind that seam
under Gate A with a kill switch and sunset. The first increment is delivered
on both platforms: [ADR-0016](adr/0016-simulate-clean-forecast-steps-with-a-merge-tree-session.md)
simulates clean forecast steps through one `git merge-tree` session (the
default on Windows since 2026-08-30, opt-in elsewhere) with Windows and Linux
differential evidence, the Windows post-batching rerun is recorded in
ADR-0013, and the Linux benchmark baseline is committed; sparse cones are
delivered as `workspace create --cone` (§12), and
[ADR-0022](adr/0022-reject-git-read-side-maintenance-caches-on-measured-evidence.md)
closed phase 0a by measuring and rejecting Git's read-side maintenance
caches. The read-side engine seam of phase 0b is implemented
([ADR-0019](adr/0019-route-every-git-read-through-one-engine-seam.md), §14.4):
every repository read is one of 43 cataloged operations, the native engine
is selectable with per-operation Git fallback, and the suite's `VLAB_ENGINE=native`
mode refuses any read outside the seam.
The schema catalog, canonical-JSON profile, compatibility contract
([ADR-0020](adr/0020-freeze-per-family-compatibility-and-resource-bounds.md)),
and conformance fixtures that complete phase 0b are delivered in v0.11.0.
The five-operation optional binding is the bounded ADR-0027 increment;
the wider phase-1 exit criteria remain unmet. A canonical fact log with
Git notes and refs as projections, private draft stacks, and any gateway
remain behind Gate B, and
[ADR-0023](adr/0023-locate-the-model-substrate-mismatch-in-facts-not-content.md)
confines any such replacement to the causal-fact substrate (§1). Git stays
the exact-state store and escape hatch in
every phase; a server or resident service still requires ADR-0013's row to
fire on representative Windows and POSIX hosts.
