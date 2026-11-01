# vcs-lab architecture reference

## Document status

| Field | Value |
| --- | --- |
| Architecture baseline | v0.13.2 release |
| Status | Current implementation reference |
| Last updated | 2026-09-03 |
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

| File | Responsibility | Important dependencies |
| --- | --- | --- |
| `bin/vlab.js` | Minimal executable entry point and error/exit boundary | `src/cli.js` |
| `src/cli.js` | Argument parsing, command dispatch, human and JSON presentation, benchmarks | All domain modules |
| `src/errors.js` | Expected CLI error type carrying a classification code from the closed `ERROR_CODES` vocabulary of the `vcs-lab.error/v1` failure envelope (ADR-0021) | None |
| `src/ids.js` | Unique protocol IDs, SHA-256, Git blob hashing, slugs | Node crypto |
| `src/canonical-json.js` | The frozen `vcs-lab.canonical-json/v1` profile: RFC 8785 restricted to UTF-16-code-unit-sorted members and safe integers, refusing what it cannot serialize byte-identically | None |
| `src/engine.js` | The read-side engine seam: the catalog of 40 read operations, the read-engine selector and native-engine stub, per-operation fallback, composites, and the differential comparison | `src/git.js` |
| `src/git.js` | The Git engine: safe synchronous Git adapter, the Git implementation of every read operation, repository context, object and merge-tree sessions, engine selectors, the read-bypass rule, metrics | Git executable, workers |
| `src/git-session-worker.js` | Owns asynchronous `git cat-file --batch-command` stream for a synchronous caller | Worker threads, Git |
| `src/merge-tree-session-worker.js` | Owns one asynchronous `git merge-tree --stdin` stream for the synchronous merge-tree forecast engine | Worker threads, Git |
| `src/store.js` | Common runtime directory and atomic JSON read/write | `src/git.js` |
| `src/notes.js` | Append/list/read causal records in `refs/notes/vcs-lab`, including one batched read for many targets; every writer of the ref is serialized on the notes lock in the shared runtime directory | `src/git.js`, `src/store.js` |
| `src/provenance.js` | Declared authorship provenance (`vcs-lab.provenance/v1`): the closed role vocabulary, `VLAB_AGENT`, declaration at commit time, and exact carry onto rewritten commits | Notes, IDs, schemas |
| `src/schemas.js` | Supported schema registry, structural record validation, object-reference and resolution-signature rules | IDs |
| `src/metadata.js` | Deterministic inventory, scope classification, integrity diagnostics, lineage, and accepted-record filtering | Git, schemas, specs |
| `src/identity-audit.js` | Repository-wide logical identity audit (`vcs-lab.identity-audit/v1`): union-find over identity-preserving application edges, multi-trailer, multi-origin, and invariant findings | Engine, notes |
| `src/metadata-envelope.js` | Canonical envelope manifest, integrity hash, payload bounds, and parser | Metadata, schemas |
| `src/metadata-transfer.js` | Sanitized bundle export, dry-run inspection, conflict planning, staging, and atomic ref import | Metadata, envelope, Git |
| `src/git-carriers.js` | Copy-on-write notes trees, typed dependency closure, bounded carrier parents, and checked ref commands | Engine, Git writes, schemas |
| `src/retention.js` | Read-only retention preview and checked, idempotent historical backfill | Metadata, carriers, notes lock |
| `src/scale-benchmark.js` | Bounded synthetic repository fixture, scan measurements, raw-Git floors for the phases with a plain-Git equivalent, semantic equality checks, and evidence-based optimization recommendations | Git, notes, metadata, resolutions, workspaces |
| `src/landings.js` | Compact and hard-squash landing mechanics and receipts | Git adapter, notes |
| `src/merge-plan.js` | Coverage proof lattice, effective base, patch candidates, plan formatting | Git adapter, notes |
| `src/proof-bundle.js` | Portable coverage proof bundles and their independent verifier, which applies its own copy of the lattice (`PROOF_RULES`) and compares the evidence with the repository | Merge plan, canonical JSON, metadata, engine |
| `src/rebase-plan.js` | Read-only rebase selection, actions, linear-history constraints, and deterministic fingerprint | Merge plan, Git adapter, IDs |
| `src/rebase-forecast.js` | Rebase simulation orchestration, caller invariants, candidate pinning, and private forecast presentation | Rebase plan, forecast simulator, Git adapter |
| `src/rebase-operations.js` | Current-branch rebase replay, forecast enforcement, conflict recovery, identity, and final receipts | Rebase plan/forecast, Git, notes, specs, resolutions |
| `src/rebase-state.js` | Worktree-private rebase journal path and atomic persistence | Git context, store |
| `src/pending-operation.js` | Safe reconciliation/rebase journal routing for shared conflict tools | Reconciliation and rebase state |
| `src/faults.js` | Test-only deterministic fault injection: `VLAB_TEST_FAULT` turns one named point on a mutating path into a hard `process.exit`; `VLAB_TEST_GATE` holds a process at a named point until a test releases it | None |
| `src/forecasts.js` | Plan fingerprint, merge-tree and temporary-worktree simulation engines with recorded fallback, decision pinning, saved forecasts | Plan, operations helpers, specs, resolutions, Git |
| `src/operations.js` | Commit/cherry-pick and reconciliation start/queue/continue/abort/finalize | Plan, forecast, notes, resolution/spec modules |
| `src/reconcile-state.js` | Worktree-private reconciliation journal and Git in-progress state probes | Repo context, filesystem |
| `src/resolutions.js` | Exact three-way conflict signatures, candidate selection, result retention, outcome audit | Git adapter, notes, reconciliation state |
| `src/workspaces.js` | Workspace registry/lifecycle, linked-worktree materialization, temporary-index checkpoints/history | Git adapter, store, workspace lock |
| `src/workspace-lock.js` | Exclusive shared-local registry transaction lock, bounded refusal, and ownership-checked release | Store, errors, fault gates |
| `src/specs.js` | Markdown parsing, sparse manifest migration/indexing, deterministic merge, semantic resolution, benchmark | Git adapter, IDs, reconciliation state |
| `src/version.js` | Runtime version constant | None |
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

| Schema | Purpose | Primary owner |
| --- | --- | --- |
| `vcs-lab.note/v1` | Container for records attached to one Git object | `notes.js` |
| `vcs-lab.landing/v1` | Compact or hard-squash causal receipt | `landings.js` |
| `vcs-lab.application/v1` | Direct cherry-pick application record | `operations.js` |
| `vcs-lab.application/v4` | Reconciliation application with conflict/spec decisions | `operations.js` |
| `vcs-lab.reconciliation/v6` | Final operation summary, coverage, trees, timing | `operations.js` |
| `vcs-lab.reconciliation-operation/v4` | Private resumable operation journal | `operations.js` |
| `vcs-lab.merge-plan/v1` | Source/target coverage plan | `merge-plan.js` |
| `vcs-lab.proof-bundle/v1` | Merge plan plus the evidence its classification rests on, for an independent verifier | `proof-bundle.js` |
| `vcs-lab.proof-verification/v1` | Integrity, classification, and repository verification result of a proof bundle | `proof-bundle.js` |
| `vcs-lab.rebase-plan/v1` | Read-only causal rebase selection and constraints | `rebase-plan.js` |
| `vcs-lab.rebase-forecast/v1` | Private pinned causal-rebase simulation and caller invariants | `rebase-forecast.js` |
| `vcs-lab.rebase-operation/v1` | Worktree-private supervised replay and recovery journal | `rebase-operations.js` |
| `vcs-lab.rebase-application/v1` | Exact origin-to-rewritten-commit mapping and contextual decisions | `rebase-operations.js` |
| `vcs-lab.rebase/v1` | Completed plan, omissions, applications, trees, and timing summary | `rebase-operations.js` |
| `vcs-lab.forecast/v2` | Pinned simulation and approvals | `forecasts.js` |
| `vcs-lab.resolution/v1` | Exact resolution result and provenance | `resolutions.js` |
| `vcs-lab.provenance/v1` | Declared authorship provenance, attached to a commit and carried across rewrites | `provenance.js` |
| `vcs-lab.workspaces/v1` | Workspace registry container | `workspaces.js` |
| `vcs-lab.workspace/v1` | Workspace descriptor | `workspaces.js` |
| `vcs-lab.checkpoint/v1` | Checkpoint command result | `workspaces.js` |
| `vcs-lab.workspace-prune/v1` | Preview/apply stale-path prune result | `workspaces.js` |
| `vcs-lab.spec-manifest/v3` | Sparse Markdown identity manifest | `specs.js` |
| `vcs-lab.spec-merge-plan/v1` | Deterministic three-way semantic plan | `specs.js` |
| `vcs-lab.spec-benchmark/v2` | Generated corpus measurements | `specs.js` |
| `vcs-lab.repository-scale-benchmark/v1` | Disposable repository/shared-metadata volume, scan, raw-Git floor, process-amplification, and decision measurements | `scale-benchmark.js` |
| `vcs-lab.metadata-status/v1` | Deterministic repository metadata inventory | `metadata.js` |
| `vcs-lab.metadata-validation/v1` | Inventory plus strict/non-strict validity result | `metadata.js` |
| `vcs-lab.metadata-envelope/v1` | Portable manifest for sanitized notes and resolution refs | `metadata-envelope.js` |
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

### 13.1 Canonical and derived data

Markdown is canonical. A v3 manifest persists only:

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

The parser `stable-markdown-blocks/v1` identifies:

- an optional preamble;
- heading-delimited sections;
- explicit `REQ-*:` records as nested addressable entities.

Ordinary IDs are derived with
`artifact-semantic-key-sha256/v1`. A migration from expanded v1/v2 manifests
compares old identities and writes only non-derived values into `idOverrides`.

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
queries. `src/git.js` is the Git engine that implements each operation with
exactly the plumbing the module ran before, one process or one object-session
query, so the seam changed no process count. Composites such as
`currentHead`, `changeIdForCommit`, and `assertClean` are derived from
cataloged operations only. Mutations do not pass through the seam; they stay
explicit `runGit` calls.

`VLAB_ENGINE` or `--engine <git|native>` selects the read engine. `git` is
the default everywhere and the oracle. `native` is the phase 1 Rust core of
ADR-0015; until its binding exists the seam reports it as unavailable
(`binding-missing`) and every operation passes through to Git. When the
selected engine lacks an operation or throws, the seam answers with Git and
records the fallback; `endGitMetrics` reports `engine`, the `fallbacks`
aggregated per operation and reason, and `directReads`.

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

Envelope v1 lineage uses Git object format plus sorted root commits reachable
from branches, tags, and remote-tracking refs. Equal roots identify the same
lineage; any shared root identifies an ordinary fork. Unrelated and
history-filtered histories fail closed.

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
| Envelope payload or inventory mismatch | Reject before destination mutation. |
| Import ID/ref conflict | Report exact conflict during dry-run; never overwrite silently. |
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
  from the Git engine, the native engine passes every operation through with
  recorded fallbacks and identical results, a read outside the seam is
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
- Forecasts can consume one immutable source checkpoint, but not a target
  checkpoint, live dirty bytes, or a native private draft stack.
- Causal rebase v1 is deliberately linear and current-branch-only; it does not
  preserve merge topology or provide interactive edit/reword/squash, arbitrary
  range selection, or dirty/checkpoint overlays.
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
every repository read is one of 39 cataloged operations, the native engine
is selectable and passes through to Git with recorded fallbacks until its
binding exists, and the suite's `VLAB_ENGINE=native` mode refuses any read outside the seam.
The schema catalog, canonical-JSON profile, compatibility contract
([ADR-0020](adr/0020-freeze-per-family-compatibility-and-resource-bounds.md)),
and conformance fixtures that complete phase 0b are delivered in v0.11.0; no
phase 1 code exists. A canonical fact log with
Git notes and refs as projections, private draft stacks, and any gateway
remain behind Gate B, and
[ADR-0023](adr/0023-locate-the-model-substrate-mismatch-in-facts-not-content.md)
confines any such replacement to the causal-fact substrate (§1). Git stays
the exact-state store and escape hatch in
every phase; a server or resident service still requires ADR-0013's row to
fire on representative Windows and POSIX hosts.
