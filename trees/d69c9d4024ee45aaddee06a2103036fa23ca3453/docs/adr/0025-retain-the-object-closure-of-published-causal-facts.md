# ADR-0025: Retain the object closure of published causal facts

- **Status:** Accepted
- **Date:** 2026-09-09
- **Owners:** Repository maintainers
- **Related issue:** [#49](https://github.com/jwh3times/vcs-lab/issues/49)
- **Related requirements:** FR-LAND-03/04, FR-PLAN-05, GP-01, GP-03, GP-06,
  GP-10, NFR-DUR-01
- **Related decisions:** [ADR-0001](0001-use-git-as-the-compatibility-and-storage-substrate.md),
  [ADR-0005](0005-scope-private-operation-state-to-a-worktree.md),
  [ADR-0010](0010-add-a-validated-metadata-envelope-before-a-server.md),
  [ADR-0020](0020-freeze-per-family-compatibility-and-resource-bounds.md)

## Context

A note's attachment name and JSON object IDs do not make those objects
reachable to Git garbage collection. After a hard squash, deleting the source
branch and expiring its reflog can therefore invalidate the receipt that was
supposed to preserve its causality. The same dependency exists in cherry-pick
applications, causal rebase records, and carried provenance. A resolution ref
retains its result commit, but that commit's tree does not necessarily contain
the base, ours, and theirs blobs used to validate the resolution signature.

The runtime authority for required dependencies already exists:
`referencedObjectsForRecord` in `src/schemas.js`. Metadata validation also
requires the attachment commit itself. Retention must cover both, including
trees and blobs that are not reachable from any listed commit.

Before this decision, the envelope exporter parented its sanitized notes commit with
referenced commits. That protects their commit ancestry, but does not carry
independent required trees or blobs. A locally valid resolution can consequently
export an envelope that its destination refuses for missing stage blobs.

Disposable reproduction and carrier experiments are recorded on #49. They
establish the Git reachability mechanism; they do not establish production
publication atomicity, migration, performance, or platform qualification.

## Decision

### One shared retention root, separate from causal evidence

Maintain `refs/vcs-lab/retention`, pointing to an ordinary Git carrier commit.
The carrier holds no canonical facts. Notes remain the source of facts, and
the existing resolution refs retain their published meaning.

For each publication, retain the attachment commit and every typed object
required by the accepted record schema:

- Commit dependencies become parents of the carrier, retaining their ordinary
  Git ancestry, trees, and blobs.
- Tree and blob dependencies become real entries in the carrier's tree, under
  separate `trees` and `blobs` directories with full OIDs as entry names.
  Commit dependencies must not be represented as gitlinks: a gitlink does not
  retain its target objects for this purpose.
- The previous carrier is an ancestor of the new carrier, preserving objects
  retained by earlier publications. Parent fan-in is bounded at 64, using
  intermediate carrier commits when necessary, as the envelope writer already
  does for large commit sets. OIDs are deduplicated and ordered; neither a
  user-controlled ref name nor an unbounded command line is constructed.

The fixed ref name avoids adding a per-record path with another signature/OID
pair, and therefore avoids repeating the resolution-ref amplification in #67.
It does not remove Git's underlying platform path limits.

Retention is repository-shared derived storage. It does not change a commit's
logical identity, authorize a fact, resolve an identity conflict, establish
repository lineage, or prove target coverage. Planning continues to admit
receipt evidence only from attachments reachable from the explicit target.
Neither the retention ref nor `git rev-list --all` may substitute for that
target walk. Ordinary Git can inspect the carrier with `git show` and
`git cat-file`, and can maintain its objects with normal GC.

### Publish evidence and its dependencies together

Validate record shape, typed dependencies, attachment, and note-container
bounds before publication. Build candidate Git objects without changing the
live notes ref. Publish the candidate notes commit and retention tip in one
checked `git update-ref --stdin` transaction, under the existing shared notes
lock. Check both previous ref values; a foreign writer or failed lock must
cause a refusal rather than overwrite a newer publication.

Where a publication also creates a resolution ref, include that ref in the
same publication transaction. Do not first publish a usable resolution ref
and leave its required dependencies for a later best-effort step.

Before the transaction, interruption may leave unreachable candidate objects,
which ordinary GC can remove. After it, every newly published fact has its
required object closure retained. This is a per-publication guarantee; it
does not claim that a whole reconciliation's existing multi-record publication
sequence has become atomic. Batching records from one finalization is allowed
when it preserves the existing operation failure contract.

### Conservative lifetime and abort behavior

The initial policy is monotonic retention with **no automatic expiration**.
Branch deletion, reflog expiration, workspace archival, and operation abort do
not release published dependencies. In particular, objects retained by an
interrupted publication remain retained after abort, even when the associated
receipt becomes irrelevant to the restored target. That receipt must remain
ineligible for coverage; object existence alone cannot make it relevant.

This deliberately retains orphaned published history. Deleting a note also
does not release objects already reachable through the retention chain.
Selective reclamation requires a separately reviewed rebuild/pruning contract;
it is not an implicit side effect of cleanup or `git gc`. Manually deleting
the retention root abandons the retention guarantee and can invalidate notes
after GC. It is not a recommended recovery procedure.

Unpublished worktree-private journals and forecasts are outside this contract.
The new root must not serialize their contents or advertise them as completed
facts. This decision does not claim GC safety for arbitrary unpublished drafts.

### Transport and existing repositories

Export constructs a fresh, deterministic object carrier from only the accepted
facts selected for that envelope and makes it reachable from the sanitized
notes commit. It includes required independent trees and blobs, as well as
attachments and referenced commits. Do not export the local retention chain:
it can contain objects from deleted, quarantined, or previously published facts
that are outside the selected envelope.

The envelope manifest and record schemas remain v1-compatible: existing Git
bundle traversal carries the additional objects. Verify that claim with old
reader/new writer and new reader/old writer fixtures before implementation is
accepted. No new logical destination ref is added to the v1 manifest.

Import validates the incoming dependency closure and builds local retention
before its existing checked publication transaction. Publish the retention
update alongside notes and resolution refs before deleting staging refs.
An idempotent no-op import must remain a no-op. Notes-only manual ref transfer
cannot claim the supported envelope's completeness guarantee.

Existing notes require an explicit, inspectable backfill operation. Its preview
reports accepted facts eligible for retention and facts whose objects are
already missing; apply pins only still-valid facts under the same checked
publication discipline. It cannot reconstruct missing objects or silently
accept quarantined records. The implementation exposes `metadata retain
--dry-run|--apply` and the `vcs-lab.metadata-retention/v1` JSON result. New
publication alone must not be described as
retroactively protecting every old fact.

## Consequences and alternatives

The benefit is durable, Git-inspectable evidence whose validity no longer
depends on users preserving rewritten branches indefinitely. The principal
cost is deliberate retention of source history and orphaned published objects,
plus extra publication work. A retention chain is simple to extend but cannot
reclaim selected objects without rebuilding its root.

Alternatives considered:

- **Rely on branches and reflogs:** rejected; both have independent lifetimes
  and the defect occurs during normal history cleanup.
- **Retain source tips only:** insufficient; attachments, independent stage
  blobs, and trees also participate in validation.
- **One ref per dependency or fact:** mechanically valid, but creates ref and
  path growth and a larger publication transaction. A fixed root has a bounded
  namespace and supports one shared update.
- **Make every notes-history commit carry source parents:** possible, and
  similar to the existing export mechanism, but couples notes history to
  source ancestry and still needs a tree/blob carrier. Keep those roles
  separate in live storage while retaining sanitized carriers in envelopes.
- **Weaken validation after GC:** rejected; loss of evidence must not silently
  become a different proof or an accepted incomplete resolution.
- **Native store or canonical fact log:** outside this Git-backed correctness
  decision and still subject to the native investment gates.

## Acceptance boundary

The maintainer accepted the fixed shared root, atomic publication, and
conservative lifetime on 2026-09-09. Implementation must prove:

- GC survival and post-GC export/import for hard squash, applications, causal
  rebase, carried provenance, and independent resolution stage blobs;
- no coverage from retained but target-unreachable receipts, including after
  interrupted publication and abort;
- interruption safety and concurrent-writer refusal for the notes/retention/
  resolution transaction, plus idempotent import and backfill;
- SHA-1/SHA-256, linked-worktree, Windows-path, and old-envelope compatibility;
- measured publication process/storage costs, with deliberate benchmark
  expectation changes and no unexplained baseline refresh;
- the repository's complete validation matrix on Windows and POSIX.

Acceptance establishes the contract. Implementation and qualification evidence
belongs on #49 and its pull request; the defect closes when both land.
