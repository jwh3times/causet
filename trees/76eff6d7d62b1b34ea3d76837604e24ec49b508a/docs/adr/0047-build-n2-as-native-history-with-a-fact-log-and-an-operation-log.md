# ADR-0047: Build N2 as native history with a fact log and an operation log

- **Status:** Accepted (owner, 2026-11-09)
- **Date:** 2026-11-09
- **Owners:** Repository maintainers
- **Related requirements:** GP-12, FR-ID-07, FR-WS-08, FR-TRUST-02
- **Builds on:** [ADR-0041](0041-make-cst-a-standalone-distributed-version-control-system.md)
  (decisions 4, 5 and 9),
  [ADR-0042](0042-grow-the-native-system-as-a-shadow-with-one-kind-per-repository.md),
  [ADR-0043](0043-order-the-native-transition-by-dependency-starting-with-n1.md)
  (decisions 6 and 8),
  [ADR-0044](0044-define-the-exit-regime-every-native-phase-must-meet.md),
  [ADR-0045](0045-build-n1-as-a-whole-content-store-with-lossless-git-import.md),
  [ADR-0046](0046-give-a-native-repository-gits-everyday-verbs-and-cst-s-own-commands.md)
  (decisions 2 and 7)
- **Decided on:** [#311](https://github.com/jwh3times/causet/issues/311), grilled
  with the owner on 2026-11-09

## Context

N2 is the second native phase (ADR-0043). It gives a native repository its own
history, the causal facts about that history, and names for lines of work.
N1 (ADR-0045) left it three things:

- **Preserved commits and tags.** N1 imports every Git commit and tag as its
  exact Git bytes, for the bridge's reconstruction check. ADR-0042 forbids a
  native format borrowing a Git shape, so these bytes cannot be native history.
- **cst's records as raw objects.** The notes on `refs/notes/causet`, the refs
  under `refs/causet/*` and their legacy `vcs-lab` names arrive as blobs and
  commits that nothing interprets yet.
- **A verbatim ref snapshot,** with every ref the source had, remote-tracking
  refs, `refs/replace/*` and `refs/stash` included.

Earlier decisions constrain the answer:

- **ADR-0041, decision 4:** change identity, applications, landings,
  provenance and resolutions are native objects of the history, "not notes
  attached to commits".
- **ADR-0041, decision 9, and "Bridgeable from the start":** every N2 object
  must cross the Git bridge of N6 exactly, and what Git has no place for crosses
  as cst's records do today.
- **ADR-0043, decision 6:** every history and fact object carries its action's
  typed actor as a declared claim, in the shape of today's
  `causet.provenance/v1`. N5 adds verification.
- **ADR-0043, decision 8:** N2 takes over phase 5's canonical fact log and
  private draft stacks (formerly #40). Fact *transport* goes to N5.
- **ADR-0046, decisions 2 and 7:** N2 owns `log`, `show`, `branch`, `tag`,
  `provenance`, `receipts` and `metadata`. `log` and `show` reproduce Git's
  `--format` placeholders byte for byte.

Today's record model, which N2 interprets (`RECORD_FAMILIES` in
`native/model/src/registry.rs`):

- **A change's identity lives only in its commit message,** as a `Change-Id`
  trailer, with `Derived-From` and `Origin-Commit` on forks. Landings add
  `Landing-Mode`, `Source-Revision` and `Absorbs`.
- **Every other fact is a record in a note.** That includes landings,
  applications, rebases, reconciliations, amendments, absorptions, provenance
  and resolutions.
- **A provenance actor is `{role, actor}`:** the role is `authored`,
  `generated` or `reviewed`, and the actor a free string. Nothing records
  whether an actor is a human or an agent, and the role can't tell, because
  agents both author and review.
- **A record's scope belongs to its family:** shared-portable (notes),
  shared-local (quarantine, dispositions, workspaces) or worktree-private
  (operation journals).
- **`refs/causet/retention` exists only to keep objects alive,** because a note
  naming an object does not keep it from Git's garbage collection (ADR-0025).
- **cst has no operation log.** product.md left open whether FR-ID-07 needs
  one, as a question for #40.

The prior-art research for #285 bears on the fact side:

- jj, Mercurial and Sapling all carry logical change identity outside the
  content hash.
- jj's change-ID header does not survive a Git-side rebase.
- jj's operation log, a content-addressed log of views whose concurrent forks
  merge 3-way, is the one lock-free precedent.
- Mononoke separates inherent data from derived data that can be rebuilt.

## Decision

### History

1. **Every commit a reader can reach gets a native commit.**
   - **Which commits:** import derives one for every commit reachable from a
     branch, a tag or a remote-tracking name, or named by any fact, together with
     their ancestors.
   - **Carrier commits:** notes commits, retention carriers and resolution refs
     only carry records. They stay preserved Git objects, and no native commit is
     derived for them.
   - **Tags:** an annotated tag gets a native tag on the same terms.
   - **The preserved bytes** are the bridge's exact copy, linked through the
     alias map. No reader of native history reads them.

   A native commit made in N3 has the same shape as an imported one.
2. **A native commit holds:**
   - its tree;
   - its parents;
   - its message, byte for byte;
   - an author and a committer signature (name, email, time, UTC offset);
   - its actors;
   - the identity and lineage of the change it records: `changeId`,
     `derivedFrom` and `originCommit`.

   The signatures are what Git's `%an`, `%ae`, `%ad`, `%cn` and `%cd` print
   (ADR-0046, decision 2). On import:
   - the signatures come from the Git commit's lines;
   - the change's identity and lineage are lifted from its trailers;
   - the message keeps those trailers verbatim.

   A landing's trailers stay message text: its landing fact is the authority on
   what it absorbed. In N3, a commit's committer signature comes from the actor
   who makes it.
3. **An actor is `causet.provenance/v1`'s `{role, actor}` with two optional
   members:**
   - `kind`, `human` or `agent`;
   - `for`, the human or organisation an agent acts for.

   The compatibility contract allows the addition within the version
   (`docs/schemas/compatibility.md`). A commit's actors take the roles
   `authored` and `generated` only. They are its commit-time provenance claim,
   and no separate provenance fact is written when a commit is made. A review
   always arrives later, so it is a provenance fact.
4. **Import derives a native commit from its Git object alone.**
   - **Actors:** an imported commit's actors are one `authored` entry naming its
     author line, with no `kind`: nothing in a Git commit says whether a human
     or an agent made it.
   - **Policy:** may treat a missing kind as an unverified human, as ADR-0041
     decision 9 does, without the record claiming it.
   - **Provenance records:** every imported provenance record becomes a
     provenance fact, including those declared at commit time.

   So a `cst provenance declare` made on the original after a first import
   never changes a native commit's ID, and an incremental import still equals
   a full one.

### Facts

5. **A fact is its own content-addressed object, never a field of a commit.**
   - **What it is:** a claim that arrives after the commits it names: an
     application, a landing, a rebase, a reconciliation, a review, a resolution
     or a disposition.
   - **Its body** is the canonical JSON of an existing record family in
     `native/model`, with native IDs where Git IDs stand today.
   - **Its envelope** adds the object kind, the fact's own actor and the IDs of
     the objects it names.

   Recording a fact changes no commit's ID. No record family needs a new schema
   version, `native/model`'s validators serve both kinds, and the bridge turns a
   fact into a Git record by translating IDs alone.
6. **A fact's scope is its family's,** as the registry in `native/model`
   already defines it: shared-portable, local to a clone, or private to a
   working copy. A fact never sets its own.
7. **The fact log is a chain of entries joined by union.**
   - **An entry** names its parent entries, the facts it adds, its actor and its
     time.
   - **Joining:** two writers, or two clones, fork the chain, and an entry with
     two parents joins them as the union of both.
   - **Disputes:** a fact still carries its record's logical ID (`land_…`,
     `prov_…`). One logical ID naming two contents is a conflicted fact, parked
     as ADR-0030 decides.

   The chain records when a clone learned each fact, and it is what N5 will
   exchange incrementally.
8. **Import builds the fact log from the original's records:**
   - **Entries:** one entry for each commit of `refs/notes/causet`'s history, in
     order. Its actor comes from that commit's committer line, with no `kind`.
   - **Validation:** import runs `native/model`'s validators as the Git-backed
     reader does. A record that reader quarantines becomes a parked fact that no
     reader uses. That covers records that are invalid, of an unknown version,
     or a disputed copy under `refs/causet/quarantine/*`.
   - **Dispositions:** `dispositions.json` is read into clone-local disposition
     facts, so the native copy settles the disputes its original settled.
   - **Not imported:** `workspaces.json` waits for N3. `migration.json` is not
     imported: a native repository has no migration window, and import reads
     legacy and current names alike.

### Names and the operation log

9. **The imported ref snapshot becomes names as follows:**
   - `refs/heads/*` become branches, and `refs/tags/*` become tags;
   - `refs/remotes/*` stay read-only remote-tracking names until N5 defines
     remotes;
   - `refs/notes/causet`, `refs/causet/*` and the legacy `refs/vcs-lab/*` are
     interpreted into facts and never shown as names;
   - every other ref stays in the snapshot for the bridge, and is never shown
     as a name.

   A branch may be marked **local**, and N5 never sends a local branch unless
   asked.
10. **A clone keeps an operation log of what N2 makes mutable.**
    - **What an operation records:** every operation that moves a name or adds
      facts writes an operation object holding:
      - its parent operations;
      - its actor and the command it ran;
      - a view: every name and its target, and the fact-log head.
    - **The one mutable pointer:** the current operation. Replacing it
      atomically is the only write that is not an addition, so concurrent
      writers never take a lock.
    - **Concurrent operations** merge 3-way. A name two operations moved to
      different places becomes a **conflicted name**, which names both until
      someone chooses.
    - **Scope:** the log belongs to its clone and is never exchanged. N3 adds
      workspaces to the view.

    This answers product.md's open FR-ID-07 question: an operation log is
    needed, and the second carrier of `ch_*` is the native commit's
    `changeId`.
11. **Reachability has three roots:** the names, the fact-log head and the
    operation log. Everything a reachable fact names is reachable too. So
    `refs/causet/retention` has nothing left to do in a native repository:
    import reads it, derives nothing from it, and keeps it in the snapshot for
    the bridge.

### Commands, contract and code

12. **N2's commands,** under ADR-0046's names and output rules, behind the
    experimental opt-in of ADR-0042:
    - **Reads:**
      - `log` and `show`, with cst's own human output, `--json`, and Git's
        `--format` placeholders byte for byte;
      - listing branches and tags;
      - `provenance`, `receipts`, `metadata status` and `metadata validate`.
    - **Writes:**
      - `branch`: create, move, delete, `--local`, and choosing a side of a
        conflicted name;
      - `tag`: lightweight and annotated;
      - `provenance declare` and `provenance review`.
    - **cst's own, new:** `cst op log`, `cst op show`, `cst op undo` and
      `cst op restore`, over the operation log.
    - **Waiting for N5:** `metadata export` and `metadata import`, whose
      envelopes carry a Git bundle today.

    `commit` waits for N3, and `merge` for N4.
13. **The new object types live in N1's store.** Native commits and tags, facts,
    fact-log entries and operations share its containers, alias map and
    content-ID rule.
    - **Encoding:** all but facts use the store's binary object encoding, as
      trees do, which also carries a non-UTF-8 message exactly. A fact is a
      thin binary envelope around its canonical-JSON body.
    - **Contract:** the encodings are a published contract,
      `docs/native-history/`, written with reference vectors as N2's first build
      ticket and before any code, beside `docs/native-store/`.
14. **Derived catalogs are rebuildable and stay home.** Indexes such as change
    ID to commits, facts by commit and logical ID to fact live under `.cst/`.
    They are derived from the objects alone and rebuilt when missing. They are
    never exchanged, and never kept in a synced folder.
15. **Layout and crates.**
    - **`native/history`:** native commits and tags, facts, the fact log, names
      and the operation log. It depends on `native/store` and `native/model`,
      never on `core`, `engine` or gitoxide.
    - **`native/import`:** grows the derivation of history and facts.

### Deferred

16. **N2 leaves these to the phases that own them:**
    - **Compaction and pruning.** N2's fact log is append-only and N2 prunes
      nothing. Compaction, with its audit and old-plan compatibility story, and
      trimming a clone's operation log, are designed with garbage collection
      (#326), on decision 11's reachability rule.
    - **Declared lineage bridges** (ADR-0029, decision 4) become a fact family
      under decision 5 when they are built.
    - **Sub-commit provenance** (#34) becomes a fact family naming a section
      once N4's section identity exists. A fact can already name any object, so
      N2 reserves nothing for it.
    - **Private draft stacks** are checkpoints, so they move to N3 with
      workspaces.
    - **Advisory leases** go to N3 or N5. None exist today.

### Exit

17. **N2 exits by ADR-0044's regime,** limited to N2's commands and objects, and
    only after N1 has exited:
    - **Native-kind suite mode:** extended to N2's commands, reads and writes.
      Each test repository's imported copy answers as its Git-backed original
      does, IDs translated.
    - **Generated histories:** gain records: compact and hard-squash landings,
      rebases, reconciliations, provenance declared after its commit,
      quarantined and disputed records with dispositions, and legacy
      `refs/vcs-lab/*` names.
    - **Real repositories:** causet, with its own records, and git/git, for
      `log` at scale.
    - **Import checks:** a fresh re-import is byte-identical, and an incremental
      import equals a full one, for native commits, facts and the fact log too.
    - **New checks:**
      - catalogs deleted and rebuilt give the same answers;
      - two concurrent operations merge, and a name moved two ways becomes a
        conflicted name;
      - N2's reads start no Git process.
    - **Where:** all of it on GitHub-hosted Linux and Windows runners, as
      permanent CI checks.

    The owner declares the exit against a named CI run. A waiver needs an
    amendment to this ADR.

## Constraints

- **Bridgeable from the start.** Imported commits and tags round-trip through
  their preserved bytes. A native commit holds everything a Git commit needs for
  the bridge to derive one deterministically: signatures, message and parents.
  Its change identity and lineage cross as trailers. A fact crosses as its
  record in a note, IDs translated.
- **No format promise** (ADR-0042, decision 5). A native repository from an
  earlier build may have to be imported again, and N2's formats may change while
  it is built, at the cost of a re-import (ADR-0043, decision 4).
- **A native format borrows no Git shape.** Native commits carry the information
  in Git's author and committer lines, in native encoding, never Git's bytes.
- **Contracts outlive the substrate.** Every record family keeps its schema.
  N2 adds only optional members to `causet.provenance/v1`.

## Consequences

### Positive

- One history shape serves every commit, imported or native, and no reader of
  history parses Git's encoding.
- Change identity becomes part of the commit it names, so no Git-side rewrite
  can strip it from native history, as jj's header can be stripped.
- Recording a fact, a review included, never changes a commit's ID, and two
  clones join their facts without losing any.
- Concurrent agents move names and add facts without a lock, and every
  operation names its actor and can be undone.
- Retention, which exists only to work around Git's garbage collection, has no
  native counterpart.

### Negative

- **Commits are kept twice** while a repository bridges: preserved bytes and a
  native commit. ADR-0041 and ADR-0045 already accepted this.
- **An imported commit's actors are weaker than its facts.** A commit an agent
  made over Git shows a kind only in its provenance fact. Readers must combine
  the two.
- **The fact log only grows** until compaction is designed with #326.
- **The operation log is a third mutable concern** beside names and facts, with
  its own merge. Conflicted names are a new state that users must resolve.
- **Byte-identical `log --format` is exacting,** above all on non-UTF-8 and
  malformed commits the generated histories carry.

## Alternatives considered

- **The preserved Git commit as native history,** with a thin native index.
  Rejected: every reader parses Git's encoding forever, and native-born commits
  would have another shape.
- **Native objects for native-born commits only.** Rejected for the same
  reason.
- **Every fact outside the commit,** change identity included. Rejected: a commit
  without its fact has no identity, and two facts can give one commit two.
- **Every cst trailer as a commit field.** Rejected: a landing fact already says
  what a landing absorbed, and checkpoints belong to N3.
- **A new compact encoding per record family.** Rejected: a second schema per
  family and a translator per family in the bridge.
- **Facts as an unordered set, or grouped by commit as notes are.** Rejected:
  the set keeps no record of when a clone learned a fact, and a landing or a
  lineage bridge names several commits, so it has no one home.
- **No operation log, a reflog for each name.** Rejected: it needs locks for
  concurrent writers, and offers no undo across names.
- **Lifting provenance records into the commit at import.** Rejected: a
  declaration made after a first import would change an existing native
  commit's ID.
- **Recording an imported commit's author as a human.** Rejected: the Git commit
  does not say so, and policy can decide what an unstated kind means.
- **N2 read-only, as N1 is.** Rejected: N3 would be the first to exercise the
  name store and the fact log's writes, and their concurrency.
