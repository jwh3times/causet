# ADR-0010: Add a validated metadata envelope before a server

- **Status:** Accepted
- **Date:** 2026-08-21
- **Owners:** Repository maintainers
- **Related requirements:** FR-GIT-08, FR-PROTO-01 through FR-PROTO-06, FR-TRUST-01 through FR-TRUST-03

## Context

The local prototype stores causal records in Git notes, exact result objects
under hidden refs, workspace metadata in a common-directory JSON file, private
operations in worktree directories, and spec identity in tracked sidecars.
Normal Git branch fetches do not transfer every shared namespace. Users must
currently know two refspecs to move notes and resolution objects, and there is
no single integrity inventory or schema compatibility report.

Building a server now would mix transport, validation, trust, policy, and
storage decisions before the portable unit is defined.

## Decision

Before a native store, long-lived service, or hosted protocol, define and
implement a versioned metadata envelope/inventory that can:

- identify repository/object-format context and supported capabilities;
- enumerate causal note records and their attachment OIDs;
- enumerate resolution refs and verify retained result blobs;
- describe tracked spec manifest schemas without duplicating their content;
- distinguish shared portable facts from machine-local/worktree-private state;
- validate schema versions, required fields, referenced object existence,
  reachability assumptions, and ID conflicts;
- export/import shared facts idempotently between two Git clones;
- quarantine unknown or invalid records so they cannot prove coverage;
- report integrity separately from cryptographic trust and authorization.

Use Git objects/refs as the first transport implementation. Do not make a
daemon or remote service a prerequisite.

The v1 contract is concrete as follows:

- **Scope:** causal notes and accepted exact-resolution refs are
  shared-portable. Tracked specification manifests continue to move with
  ordinary Git content. Workspace registries and checkpoint refs are
  shared-local, while reconciliation journals and forecasts are
  worktree-private; none of those local/private scopes is exported.
- **Repository lineage:** `git-root-commits-sha256/v1` binds the Git object
  format and the sorted root commits reachable from ordinary branches, tags,
  and remote-tracking refs. Equal identities are the same lineage. A non-empty
  root intersection is an ordinary fork and may import. An unrelated or
  history-filtered repository fails closed in v1 rather than relying on an
  override with unclear trust semantics.
- **Compatibility and quarantine:** only explicitly registered record schemas
  participate in causal coverage, exact-resolution lookup, or export. Unknown,
  malformed, dangling, signature-mismatched, retention-mismatched, or
  ID-conflicting facts remain physically inspectable but are quarantined.
  `--strict` also treats compatibility/local-health warnings as validation
  failure.
- **Envelope:** `vcs-lab.metadata-envelope/v1` is a directory containing a
  canonical hashed `manifest.json` and, when facts exist, an `objects.bundle`.
  Export builds a sanitized deterministic note ref so quarantined facts are not
  carried. The manifest inventories logical destination refs, bundle refs,
  attachments, record IDs/digests, capabilities, exclusions, object format,
  lineage, and payload hash/size.
- **Import:** dry-run verifies manifest and payload integrity in a disposable
  repository, compares exact records/refs/objects, and mutates no destination
  refs. Apply fetches to unique staging refs, merges non-conflicting note
  records, and publishes the notes/ref-resolution updates with one checked
  `git update-ref --stdin` transaction. Equal IDs/digests and equal ref targets
  are no-ops; different values are conflicts and never overwrite silently.
- **Trust:** hashes, Git OIDs, schemas, and reachability checks establish
  internal integrity only. They do not identify an actor, verify a signature,
  authorize a landing, or grant execution authority.

## Expected consequences

### Positive

- Multi-clone experiments become reproducible without internal ref knowledge.
- The product gains a clear boundary for later signing and capability
  negotiation.
- Corrupt or partial metadata can be diagnosed before planning consumes it.
- The need for a native server can be measured against a working portable form.

### Negative

- Schema validation and conflict policy add substantial design work.
- Repository identity across clones/forks is not yet settled.
- An envelope may duplicate some Git transport concepts.
- Signing must remain separate; integrity validation alone does not establish
  actor trust.

## Alternatives considered

- **Git bundle plus a small deterministic manifest:** selected because it is
  self-contained, uses current Git objects, works offline, and permits an
  inspection repository before destination mutation.
- **Manifest plus ordinary remote refspec orchestration:** rejected for v1
  because transfer would depend on remote configuration and availability and
  would not itself be a portable artifact.
- **One append-only namespaced metadata tree/ref:** deferred because it would
  introduce a second canonical persistence layout before existing note and
  resolution semantics have been exercised across clones.
- **Protocol gateway:** deferred because capability negotiation, remote trust,
  policy, and service lifecycle remain deliberately outside this increment.

## Acceptance evidence

The v0.8 integration fixtures exercise damaged-record quarantine and coverage
safety, deterministic export, tamper and unrelated-lineage rejection,
conflict-safe dry-run, atomic/idempotent two-clone import, causal-plan and exact
resolution parity, stable spec IDs, and exclusion of workspace/checkpoint and
worktree-private state. The commands are:

```text
vlab metadata status [--json]
vlab metadata validate [--strict] [--json]
vlab metadata export <directory> [--json]
vlab metadata import <directory> --dry-run [--json]
vlab metadata import <directory> --apply [--json]
```

The user independently verified the Windows flow against a clean clone of a
real repository and a disposable metadata-bearing fork. The checks covered
read-only zero-state inventory, deterministic empty and non-empty envelopes,
non-mutating preview, same-lineage import, repeated-import no-op behavior, a
causal plan changing from two new changes to two receipt-covered changes, and
fail-closed payload-tamper rejection with unchanged refs and worktree.
