# Prior art for a standalone version control system

Research for [#285](https://github.com/jwh3times/causet/issues/285), feeding
[ADR-0041](../docs/adr/0041-make-cst-a-standalone-distributed-version-control-system.md)
decisions 2–9. Gathered 2026-10-17.

**Question.** What did Jujutsu, Sapling (with Mononoke), Pijul, Fossil,
Mercurial, Perforce, Plastic SCM (now Unity Version Control) and Xet decide
about content storage and chunking, the history model and operation logs, the
working copy and staging, branches and workspaces, locks and permissions, large
files, and Git interop? And what went wrong for them?

**Method.** Every claim cites a source the project owns: its documentation,
source code, design documents, specification, or a paper or book by its
authors. Where a project's own text was not reachable, or did not settle the
point, the claim is marked **(unverified)** or left out. Nothing here
recommends a design. The last section maps the facts to ADR-0041.

Source code was read from these snapshots: Mercurial 7.2.4 and hg-git 1.2.0
(the PyPI source distributions; repo.mercurial-scm.org refuses automated
readers), Sapling/Mononoke `main` on GitHub, and the Plastic SCM book PDF
(v1.24, 2022). Documentation is as published on 2026-10-17.

---

## 1. Jujutsu (jj)

**Storage.** jj separates its user interface and algorithms from a pluggable
storage *backend*. "The Git backend is the only production-ready builtin commit
backend" ([glossary](https://docs.jj-vcs.dev/latest/glossary/)), and the README
says "only the Git backend is production-ready"
([README](https://github.com/jj-vcs/jj/blob/main/README.md)). File content is
Git blobs, so there is no chunking of its own. jj says it "is an experimental
version control system" and that "There *will* be ... backward-incompatible
changes to the on-disk formats before version 1.0.0" (README).

**Its own metadata in Git.** Every commit jj creates gets a ref under
`refs/jj/` so Git's GC keeps it. The change ID goes in a non-standard Git commit
header, written by default since 0.30.0. Conflicted commits are stored as trees
with `.jjconflict-base-*/` and `.jjconflict-side-*/` directories, and the
authoritative data is in a non-standard `jj:trees` header
([Git compatibility](https://docs.jj-vcs.dev/latest/git-compatibility/)).

**History model.** A *change* is "a commit as it evolves over time". Changes are
not objects in the data model: the change ID, typically 16 bytes, is what
identifies one. A *divergent change* is one with more than one visible commit.
Rewritten commits become hidden, but stay reachable by commit ID
([glossary](https://docs.jj-vcs.dev/latest/glossary/)). Conflicts are
first-class. A conflicted commit links an odd number of trees, and a 3-way
conflict is written A+(C−B). Nested conflicts simplify algebraically, so a
conflict can be rebased onward and later resolve
([conflicts](https://docs.jj-vcs.dev/latest/technical/conflicts/)).

**Operation log.** Each operation stores a *view*: the bookmark, tag and Git ref
positions, the heads, and every workspace's working-copy commit. It also stores
its parent operation(s) and metadata (user, host, time). `jj undo`,
`jj op revert`, `jj op restore` and `--at-op` operate on it
([operation log](https://docs.jj-vcs.dev/latest/operation-log/)). The log is
lock-free. Operations and views live in content-addressed storage. When an
operation forks (two concurrent commands, or two machines synced by a file sync
tool), jj does "a 3-way merge of the view objects", and a bookmark moved two
ways becomes a conflicted bookmark ("moved from A to B or C"). Because of the
Git backend, though, "repository corruption is possible because the backend is
not entirely lock-free", and the documented recovery is `jj debug reindex`
([concurrency](https://docs.jj-vcs.dev/latest/technical/concurrency/)).

**Working copy and staging.** "Jujutsu uses a real commit to represent the
working copy" (README). Most commands snapshot the working copy automatically,
and new files are tracked by default (`snapshot.auto-track`)
([working copy](https://docs.jj-vcs.dev/latest/working-copy/)). "There's no
index (staging area)". Partial commits are made with `jj split` and
`jj squash -i`, and jj says Git's exposed index "makes the CLI unnecessarily
complicated" ([Git comparison](https://docs.jj-vcs.dev/latest/git-comparison/)).
If a command fails after recording its operation but before updating the files,
the working copy is left *stale*, and `jj workspace update-stale` repairs it
(working copy).

**Branches and workspaces.** Bookmarks are named pointers that do not advance
on a new commit but follow rewrites. There is no "current bookmark"
([Git comparison](https://docs.jj-vcs.dev/latest/git-comparison/)). Several
workspaces can share one repository, each with its own working-copy commit
recorded in the view ([glossary](https://docs.jj-vcs.dev/latest/glossary/),
[working copy](https://docs.jj-vcs.dev/latest/working-copy/)).

**Locks and permissions.** The pages consulted describe neither.

**Large files.** Git LFS is not supported (issue #80), and neither are partial
clones. Shallow clones are partial, with no deepening
([Git compatibility](https://docs.jj-vcs.dev/latest/git-compatibility/)).

**Git interop.** In a colocated repository jj imports from and exports to Git
"on every `jj` command automatically", and Git-side changes show up in the
operation log as "import git refs". Not supported: submodules (kept, not shown),
`.gitattributes`, hooks, annotated tag creation, and Git's staging area.

**What went wrong (documented).** These are the problems jj itself lists for
colocation (Git compatibility):

- Mixing jj and git commands "can cause confusing branch conflicts or divergent
  change IDs", and "there may still be bugs when interleaving mutating `jj` and
  `git` commands".
- Many refs slow every command, because each one runs an import.
- The change-ID header "is not preserved through a rebase operation" done by
  Git.
- Git tools see conflicted commits as unreadable `.jjconflict-*` trees.
- Paths are assumed to be UTF-8.

## 2. Sapling and Mononoke (Meta)

**Scope and availability.** Sapling began as a Mercurial extension. Meta
released the client in 2022 and said it hoped to release the server and the
virtual filesystem later
([Meta engineering, 2022](https://engineering.fb.com/2022/11/15/open-source/sapling-source-control-scalable/)).
The current introduction says the server and virtual filesystem are "not yet
available publicly", and that "Git support may have some remaining kinks"
([introduction](https://sapling-scm.com/docs/introduction/)). The Mononoke
README says it "is still in development" and that the GitHub build "omits some
functions": the Thrift APIs, MySQL failover and CacheLib
([README](https://github.com/facebook/sapling/blob/main/eden/mononoke/README.md)).

**Content storage (Mononoke "Bonsai").** One canonical model serves Git,
Mercurial and Sapling clients
([Bonsai data model](https://github.com/facebook/sapling/blob/main/eden/mononoke/docs/2.1-bonsai-data-model.md)):

- *Inherent* data is the Bonsai changesets, the file content blobs, and the
  "Original VCS bytes (for Git and Mercurial commits, preserved for
  compatibility)". *Derived* data (Git trees and commits, Mercurial manifests,
  blame, history indexes) is computed asynchronously, off the write path.
- A changeset is a flat list of path→change entries, not nested trees. Copies
  and renames are recorded explicitly (copy-from), not detected by heuristic.
  There are fields for `hg_extra`, `git_extra_headers` and annotated tags.
- Identity is Blake2b-256 over the Thrift-serialised changeset (`ChangesetId`)
  and over the content (`ContentId`). The `bonsai_git_mapping` and
  `bonsai_hg_mapping` tables map those to Git SHA-1 and Mercurial hashes in
  both directions.
- Large file content is chunked by the filestore (`ChunkedFileContents`). The
  docs do not say whether the boundaries are fixed or content-defined
  (unverified).
- The storage stack is layered. `packblob` packs related blobs and applies
  Zstd delta compression against a dictionary blob. `multiplexedblob` writes to
  several backends and reads from any one, with a WAL and a healer job
  ([storage architecture](https://github.com/facebook/sapling/blob/main/eden/mononoke/docs/2.4-storage-architecture.md)).

**History model.** Sapling keeps a mutation record each time a commit is
amended, rebased, folded or split. Commits are hidden and unhidden rather than
deleted, and there are `undo`, `unamend` and `uncommit`
([differences from Git](https://sapling-scm.com/docs/introduction/differences-git)).
How mutation and visibility are stored internally was not verified. Segmented
Changelog downloads "the high-level shape of the commit graph ... taking just a
few megabytes" and fetches the rest of the history on demand
([Meta engineering, 2022](https://engineering.fb.com/2022/11/15/open-source/sapling-source-control-scalable/)).

**Server-side landing (pushrebase).** When the target bookmark has moved since
the client's base, Mononoke rebases the pushed commits on the server
([pushrebase](https://github.com/facebook/sapling/blob/main/eden/mononoke/docs/4.1-pushrebase.md)):

- It detects conflicts *per path*: two commits that touch the same file
  conflict even if they change different lines, and the push is rejected.
- Rebased commits get new identities. Sapling clients get obsmarkers that map
  the original commits to the rebased ones; Git clients "receive the new commit
  hashes".
- If the bookmark moves during the operation, the server retries, typically up
  to 100 times.

**Working copy and staging.** "In Sapling, there is no staging area". Partial
commits use `commit -i` and `amend -i`, or a temporary commit plus `fold`
([differences from Git](https://sapling-scm.com/docs/introduction/differences-git)).
EdenFS, a virtual filesystem, makes a checkout "look and act as if you have the
entire repository", fetching each file on its first access
([Meta engineering, 2022](https://engineering.fb.com/2022/11/15/open-source/sapling-source-control-scalable/)).

**Branches.** Local bookmarks "are completely optional and generally not even
used". Remote bookmarks are locally immutable. A stack is restacked
automatically when a commit in the middle of it is edited
([differences from Git](https://sapling-scm.com/docs/introduction/differences-git)).

**Permissions.** Policy is enforced by server-side hooks "on every push",
unlike client hooks, which "can be bypassed" (examples: `deny_files` by path
pattern, file size limits, bookmark-creation limits). An admin group or the
`write_no_hooks` permission can bypass hooks, and every bypass is logged for
audit. Hooks can also be bypassed for pushes by named services
([hooks](https://github.com/facebook/sapling/blob/main/eden/mononoke/docs/4.3-hooks.md)).
*Redaction* makes a blob unreadable at the blobstore layer, in every protocol,
without rewriting history. It has enforce and log-only modes and an audit log
([redaction](https://github.com/facebook/sapling/blob/main/eden/mononoke/docs/4.4-redaction.md)).
No file locking was found in the documents consulted.

**Large files.** Mononoke runs a Git LFS-compatible server. With pointer
interpretation on, a pushed LFS file is stored as its *full content* in Bonsai,
with a `git_lfs` flag, and turned back into a pointer only when served to Git.
Mononoke does this so that size statistics, integrity checks and cross-repo
sync see the real content
([Git support](https://github.com/facebook/sapling/blob/main/eden/mononoke/docs/5.1-git-support.md)).

**Git interop.** There are two separate mechanisms:

- **The Sapling client on a Git repository.** In `.git` mode Sapling keeps
  Git's file formats and puts what Git lacks (mutation) in `.git/sl`. LFS
  support is partial, submodules are "not fully supported", there are no local
  tags, and changes made with `sl add` may not show in `git status`. In `.sl`
  mode, git commands do not work and LFS is unsupported
  ([Git support modes](https://sapling-scm.com/docs/git/git_support_modes)).
- **The Mononoke Git server** speaks smart HTTP, converts each pushed Git
  commit to Bonsai, and serves Git commits as derived data
  ([Git support](https://github.com/facebook/sapling/blob/main/eden/mononoke/docs/5.1-git-support.md)).
  A Git commit derived from a Bonsai changeset is built with
  `extra_headers: Vec::new()` and `encoding: None`. Its code comments say this
  path is "only ... invoked for commits that originate within Mononoke", and
  that its test is "shielded from non-roundtripping behaviours coming from
  original uses of Git". For commits that came from Git, exactness rests on the
  preserved original bytes (inherent data) and the SHA mapping
  ([derive_commit.rs](https://github.com/facebook/sapling/blob/main/eden/mononoke/git/git_types/src/derive_commit.rs)).
  Copy and rename information is "not included in Git commits but is preserved
  in the Bonsai representation". A `GitSourceOfTruthConfig` records whether
  Mononoke or an external Git server is authoritative during a migration.

**What went wrong (documented).** The server and virtual filesystem are still
not public, four years after the client. Some of Sapling's scale optimisations
"will not apply" on Git repositories (Meta engineering, 2022). Mixing `sl` and
`git` in one checkout has the caveats above.

## 3. Pijul

**History model.** Pijul stores changes (patches), not snapshots. Independent
changes commute: they "can be applied in any order, without changing the
result". Conflicts are "a regular thing in the internal representation", and
both sides are kept, so "no information ever gets lost"
([why Pijul](https://pijul.org/manual/why_pijul.html)). The repository is a
graph of byte ranges (vertices). Each vertex is named by the hash of the change
that introduced it plus a position in that change. A change must depend on the
changes whose context it edits. Pijul calls itself a CRDT. A line that is both
deleted and given new context becomes a "zombie" vertex
([theory](https://pijul.org/manual/theory.html)).

**Content and large files.** A change is split into an operations section and a
contents section, and its hash covers the operations. A client can therefore
download a change's operations without its contents and verify the contents
later. Pijul's author says this also means a missing-content mismatch "may only
surface" at a later unrecord
([partials, 2020](https://pijul.org/posts/2020-12-19-partials)). Because changes
to separate files commute, one file's history can be pulled on its own
(partial clone by path; same post). Binary files are diffed with an
rsync-style rolling checksum over blocks. Both versions of the file must fit in
memory, and the file is assembled in one contiguous buffer
([binary diffs, 2021](https://pijul.org/posts/2021-07-11-binary-diffs)).

**Branches.** "Channels are a way to maintain two related versions of a
repository in the same place (a bit like branches in Git)"
([README, 1.0.0-beta](https://docs.rs/crate/pijul/1.0.0-beta.21/source/README.md)).

**Working copy, locks, permissions.** The sources consulted do not cover them.

**Git interop.** One-way only. `pijul git` imports by "replaying the repository
history, and is not particularly optimised". Symbolic links "are treated as
regular files" (README). There is no export to Git.

**What went wrong (documented).** Scalability was "one of the biggest
challenge[s]": even modest repositories "would use a lot of disk space", and
cloning a long history means applying every change in turn
([partials, 2020](https://pijul.org/posts/2020-12-19-partials)). The CLI is
still published as 1.0.0-beta (docs.rs).

## 4. Fossil

**Storage.** A repository is one SQLite database file ("ACID transactions and a
high-level query language"), normally kept outside the checkout
([Fossil vs Git](https://fossil-scm.org/home/doc/trunk/www/fossil-v-git.wiki)).
Each artifact is named by the hash of its content. Fossil 2.0 added SHA3-256
alongside SHA1 ("The key innovation in Fossil 2.0 was adding support for
alternative hash algorithms"). Delta and zlib compression in the database "is
an implementation detail and might change"; "It is the artifact format that is
intended to be enduring"
([file format](https://fossil-scm.org/home/doc/trunk/www/fileformat.wiki)).
There is no chunking.

**History model.** A check-in is a *manifest* artifact made of cards: C for the
comment, D for the date, F for the files, P for the parents, U for the user and
Z for the checksum. Tags and properties are *control* artifacts. Artifacts "may
be PGP clearsigned". Wiki pages, ticket changes, technotes, forum posts and
attachments are artifacts of the same store, named by hash like check-ins; an
edited forum post is a new artifact, and "the historical post is retained"
(file format). "There is no rebasing mechanism in Fossil, on purpose".
Corrections are added as new records (Fossil vs Git).

**Removing content.** *Shunning* is the one escape from keep-everything history.
Shunned artifact hashes are refused on push and pull, and the content is
physically removed at the next rebuild. The shun list is local, does not travel
with normal sync, and can be pushed only with Admin rights. Fossil presents
this as a security property: a malicious shun cannot spread across the network
and destroy data
([shunning](https://fossil-scm.org/home/doc/trunk/www/shunning.wiki)).

**Working copy.** "You can open a Fossil repository any number of times into any
number of working directories." Autosync is the default: "each commit syncs
immediately to its parent repository" (Fossil vs Git). The consulted pages do
not describe a staging area. Nothing contradicts file-level partial commits,
but this was not verified.

**Branches.** A branch is a *propagating tag*: it applies to a check-in and its
direct descendants, and "Tag propagation does not cross merges". Branch names
are not unique. Fossil tries to prevent forks through autosync and aborts with
"would fork"; it treats forks as accidents and branches as intent
([branching](https://fossil-scm.org/home/doc/trunk/www/branching.wiki)).
Branch names sync, and "it syncs the entire DAG or nothing" (Fossil vs Git).
*Private branches* never autosync. Merging one into a public branch does not
record the merge parent, and older private branches cannot be made public
([private branches](https://fossil-scm.org/home/doc/trunk/www/private.wiki)).

**Permissions.** Capabilities are letters assigned per user or category, and
they "only affect accesses over `http[s]://` URLs". With a local repository
"The only checks made ... are the operating system's file system permissions".
Anyone who can read the repository file can grant themselves Setup. User caps
"do not affect cloning and syncing over SSH". No per-path or per-branch
capabilities are described
([capabilities](https://fossil-scm.org/home/doc/trunk/www/caps/)). No file
locking was found.

**Large files.** No dedicated mechanism was found. *Unversioned files* keep only
the newest version, sync only with `-u`, and are sent whole with no delta
compression ([unversioned](https://fossil-scm.org/home/doc/trunk/www/unvers.wiki)).

**Git interop.** `fossil import --git` and `fossil export --git` use the
git-fast-export format, with marks files for incremental runs. Export "only
exports the versioned files", without tickets, wiki or events
([import/export](https://fossil-scm.org/home/doc/trunk/www/inout.wiki)). The
built-in Git mirror "is one-way": "you cannot accept pull requests on GitHub".
"Only check-ins and simple tags are translated", tag and branch names are
mangled to fit Git's rules, and a tag on several check-ins keeps only the
newest ([mirror to GitHub](https://fossil-scm.org/home/doc/trunk/www/mirrortogithub.md)).
"Many things are lost in making a Git mirror" (Fossil vs Git).

**What went wrong (documented).**

- Forks on long-lived shared branches happen, and "Given enough time, they're
  all but inevitable" (branching).
- Private-branch merges lose their merge parent (private branches).
- Access control does not protect a local repository file (capabilities).

## 5. Mercurial

**Storage.** A revlog is "an append only data structure". Each revision is
stored as a delta in a chain whose length is bounded, so reads stay bounded.
*generaldelta* allows deltas against any revision, not only the previous one,
and zstd is one of the compression engines
([revlogs internals](https://repo.mercurial-scm.org/hg/file/tip/mercurial/helptext/internals/revlogs.txt);
read from the 7.2.4 sdist). There is no content-defined chunking.

**History model.** *Phases*: public (immutable), draft, secret. "No changeset
can be in a lower phase than its ancestors", and phases move only toward
public. Rewriting tools "refuse to operate" on public changesets
([phases help](https://repo.mercurial-scm.org/hg/file/tip/mercurial/helptext/phases.txt)).
Any changeset seen in a remote repository becomes public, and repositories
publish by default ([Phases wiki](https://wiki.mercurial-scm.org/Phases)).
*Obsolescence markers* record a predecessor, its successors, and when and by
whom it was rewritten. They "can be exchanged without any of the precursor
changesets". Orphan, phase-divergent and content-divergent changesets block a
push ([Changeset Evolution](https://wiki.mercurial-scm.org/ChangesetEvolution)).
Obsmarkers and phase heads travel as bundle2 parts (`bundle2.txt`).

**Working copy and staging.** There is no index. `hg commit` commits "the
specified files or all outstanding changes", and `-i/--interactive` selects
hunks ([commands.py](https://repo.mercurial-scm.org/hg/file/tip/mercurial/commands.py)).

**Branches.** A named branch is "an attribute associated with a changeset",
recorded in every changeset (defaulting to `default`). The wiki advises using
named branches "sparingly", for long-lived lines such as releases, and "rather
not for short lived work" ([Branch wiki](https://wiki.mercurial-scm.org/Branch)).
Bookmarks are the lightweight alternative.

**Permissions.** The `acl` hook allows or denies *writes* by branch, bookmark
and path glob, for users and groups, in a fixed order: deny branches, allow
branches, deny paths, allow paths. "The authorization is matched based on the
local user name on the system where the hook runs, and not the committer of
the original changeset (since the latter is merely informative)". It "is not
safe to use if users have interactive shell access, as they can then disable
the hook", nor if remote users share an account
([acl.py](https://repo.mercurial-scm.org/hg/file/tip/hgext/acl.py)). Read
restriction is narrow clones: "Only the server holds the full store" (narrow
extension, "EXPERIMENTAL"). No file locking was found.

**Large files.** There have been two generations:

- **`largefiles`** keeps a 41-byte *standin* (a SHA-1 and a newline) in `.hglf/`
  and the content in a central store. It exists because revlog's binary deltas
  waste "bandwidth and disk space" on files that are "not very compressible,
  not very diffable, and not at all mergeable"
  ([largefiles](https://repo.mercurial-scm.org/hg/file/tip/hgext/largefiles/__init__.py)).
  Its wiki page calls it "a feature of last resort"
  ([wiki](https://wiki.mercurial-scm.org/LargefilesExtension)).
- **`lfs`** is still "(EXPERIMENTAL)". It speaks the git-lfs protocol, chooses
  files by a versioned `.hglfs` pattern file, and downloads content "on demand".
  The docstring says this "changes fundamental workflows in a DVCS, so careful
  thought should be given before deploying it". Because hashes are of the real
  content, `hg convert` can move a repository in or out of LFS "without
  changing the commit hashes"; but repositories converted that way "will not be
  able to communicate with each other unless the extension is enabled on both"
  ([lfs](https://repo.mercurial-scm.org/hg/file/tip/hgext/lfs/__init__.py)).

**Git interop.** These facts are from hg-git 1.2.0's README and
`hggit/git_handler.py`:

- hg-git claims lossless conversion in both directions, "since version 0.5.0,
  released in 2013".
- **Git → Mercurial.** Git fields Mercurial lacks go into changeset *extras*:
  the committer, `encoding` and `gpgsig`. Where Mercurial normalises a commit
  message or author string, hg-git stores a binary *delta* back to the original
  bytes (`extra[b'message']`, `extra[b'author']`), so the original Git commit
  can be rebuilt exactly.
- **Mercurial → Git.** Mercurial-only data goes into Git extra headers
  (`HG:rename`, `HG:extra`, `HG:rename-source`) or a `--HG--` trailer in the
  message.
- Mercurial's built-in `git` extension stores one ID per commit (the Git hash),
  but "cannot handle ... octopus merges" and fails on any history that has one
  ([hg-git 1.2.0 on PyPI](https://pypi.org/project/hg-git/1.2.0/), whose
source distribution holds the README and code quoted here; the
[repository](https://foss.heptapod.net/mercurial/hg-git) refuses automated
readers)).

**What went wrong (documented).**

- Evolution has been "experimental" for years. Marker discovery "can be very
  slow in some case", and "we need more scaling work" (Changeset Evolution;
  archived wiki, status dated 2017).
- Named branches turned out to be the wrong default for short-lived work
  (Branch wiki).
- Large files needed two out-of-band extensions, both centralised. The current
  one is still experimental.
- Write ACLs are a hook that a user with a shell can disable.

## 6. Perforce (Helix Core / P4)

**Storage.** Each file type chooses how the server stores revisions
([file type modifiers](https://help.perforce.com/helix-core/server-apps/cmdref/current/Content/CmdRef/file.types.synopsis.modifiers.html)):

- `+C` full compressed copies (the default for binaries, and for new text files
  over 10 MB);
- `+D` RCS deltas;
- `+F` full uncompressed files;
- `+S`/`+Sn`, which keep only the head or the last *n* revisions and purge
  older ones;
- `+X`, which reads the content through an archive trigger.

Branching by `p4 integrate` makes a *lazy copy*: "The contents of the file
are not duplicated on the server because the integration record contains
sufficient information" to reproduce it
([p4 integrate, 2021.1](https://legacy-docs.perforce.com/doc.current/manuals/v21.1/cmdref/Content/CmdRef/p4_integrate.html);
the [current page](https://help.perforce.com/helix-core/server-apps/cmdref/current/Content/CmdRef/p4_integrate.html)
says the same in other words). Older pages say `+S` files are not lazily
copied (unverified: seen only in search excerpts).
There is no chunking.

**History, working copy, staging.** `p4 edit` "opens files for editing" and
turns on OS write permission. Nothing changes in the depot "until the
changelist is committed" with `p4 submit`, and a file can be put in a named
changelist with `-c`
([p4 edit](https://help.perforce.com/helix-core/server-apps/cmdref/current/Content/CmdRef/p4_edit.html)).
The *have list* is "the list of file revisions that are most recently synced
from the depot" to a workspace
([p4 have](https://help.perforce.com/helix-core/server-apps/cmdref/current/Content/CmdRef/p4_have.html)).
The have list's location is not stated there; that it is server-side is
(unverified). Pending changelists act as the staging step: the user picks which
opened files go into which changelist. That reading is inferred from the
`p4 edit` text, not stated by it.

**Permissions.** The protections table grants an access level to a user or
group, from a host (IP/CIDR), on a depot path pattern. The levels are `list`
(metadata only), `read`, `open`, `write` (submit and lock), `review`, `admin`,
`super` and `owner`. Rights can be denied (`=read`, `=open`, `=write`,
`=branch`), and a leading `-` excludes a path. With `=read` denied, users
"cannot use `p4 print`, `p4 diff`, or `p4 sync`", and an excluded depot drops
out of `p4 depots`
([p4 protect](https://help.perforce.com/helix-core/server-apps/cmdref/current/Content/CmdRef/p4_protect.html)).
All of this rests on the central server, which mediates every read.

**Locks.** `+l` is exclusive open: "prevents more than one user from opening
the file". `p4 lock` "allows anyone to open a file for edit, but only the person
who locked the file can submit it"
([preventing multiple checkouts](https://help.perforce.com/helix-core/server-apps/p4guide/current/Content/P4Guide/resolve.lock.exclusive.html)).
A typemap such as `+l //depot/...` locks files site-wide, but it "applies only
to new additions to the depot", so existing files must be reopened with
`-t+l` and resubmitted
([typemap locking](https://help.perforce.com/helix-core/server-apps/p4sag/current/Content/P4SAG/superuser.basic.typemap_locking.html)).

**Distributed mode.** `p4 init` creates a personal server; `p4 fetch` and
`p4 push` exchange changes with a shared one, and can fetch any subset of paths
or only the last *n* revisions
([DVCS guide](https://www.perforce.com/perforce/r15.2/manuals/dvcs/chapter.initialize.html),
[p4 fetch](https://perforce.com/manuals/cmdref/Content/CmdRef/p4_fetch.html)).
For a `+l` file a personal server takes "a global exclusive lock", which "is
held in the shared server", and "the shared server must be configured as a
commit server"
([exclusive locking in personal servers](https://legacy-docs.perforce.com/doc.current/manuals/v16.1/dvcs/fetching.exclusive.html)).
Behaviour when offline is not documented there.

**Git interop.** *Graph depots* store Git repositories inside P4. The Git
Connector "acts as a Git server to Git clients". A classic workspace can sync
and view graph-depot content, but editing it needs a Git client
([Git Connector architecture](https://help.perforce.com/helix-core/server-apps/p4sag/current/Content/P4SAG/overview.architecture.html)).
So Git content and classic depot content sit side by side; neither is
converted into the other.

**What went wrong (documented).** The typemap does not lock files that already
exist (typemap locking). Exclusive locks in distributed mode need a reachable
commit server. That is, Perforce's lock is a central lock even in its DVCS
mode. Perforce's Git story is a second, separate store, not a translation.

## 7. Plastic SCM (Unity Version Control)

**Storage.** Plastic is "not built on top of Git. It is a full stack", with its
own Git compatibility. The repository backend is pluggable: Jet (Plastic's own
store, the default since late 2016), SQL Server, MySQL or SQLite
([Plastic SCM book](https://www.plasticscm.com/downloads/plasticscm-book.pdf),
"Plastic is not built on top of Git" and the repository storage section). No
chunking is documented.

**History model and branches.**

- "In Plastic, branches are changeset containers, while in Git, they are just
  pointers". Every changeset belongs to exactly one branch, and Plastic does not
  let you delete branches (book, "Every changeset belongs to a branch" and
  "Why we don't delete branches").
- Changesets have GUIDs and also local sequential numbers. Plastic kept the
  numbers for backward compatibility and because "many teams were not using
  distributed daily" (book, "Note for Git users on GUIDs vs. SHAs").

**Distributed operation.**

- Servers replicate by push and pull, and "All replicas in Plastic are partial":
  you replicate one branch, not the repository.
- A merge in a partial replica can pick a different common ancestor than the
  central site would, because merge history is missing. The authors therefore
  "prefer to do the merges on the central site". They considered replicating
  the whole changeset graph without its data, but had not done it (book,
  "Merge history and partial replicas").

**Working copy and staging.** There is no index. *Pending Changes* lists
changed, deleted, moved and added files, and the check-in is made from that
selection (book, "Pending Changes"). *Gluon* partial workspaces let artists
"pick the files you want to work on and check them back in without updating
your whole workspace"
([Unity plugin manual, creating projects](https://docs.unity3d.com/Packages/com.unity.collab-proxy@2.9/manual/CreateProjects.html)).

**Locks.** There are two generations:

- **The 2022 book.** Locks are server lock-list entries, taken on checkout for
  configured extensions. Only the latest revision can be locked. If a user
  forgets to check out, no lock is taken. "If you need to enforce non-concurrent
  operation on certain files (locking), you need to stick to centralized".
  "The Plastic locking system only works well if you work on a single branch"
  (book, "Locking: avoiding merges for unmergeable files"; "proxies" section).
- **Smart Locks, current.** Lock rules are set per organisation or per
  repository. A *destination branch* (default `/main`) is "the source of truth
  when creating a new lock". Checking a locked file in on another branch sets it
  to *Retained*, and the lock clears only when the change is merged to the
  destination. "Smart locks don't travel across replica repositories", and
  "The merge-to function doesn't support locks"
  ([smart locks](https://docs.unity.com/en-us/unity-version-control/smart-locks)).

**Permissions.** "every object has an associated Access Control List". Secured
paths can deny read or write on a path, and a rename that would escape a path's
rule is refused. The documented limits are these
([security](https://docs.unity.com/en-us/unity-version-control/security)):

- "If you restrict read access to certain paths, it can cause some incomplete
  changesets ... important if you work in distributed scenarios".
- A server setting can reject operations "when the path permissions of a
  revision can't be checked because a changeset wasn't replicated".
- Read rules reach existing workspaces only on their next clean update.
- "GitSync and GitServer ignore any path-based security."

**Git interop (GitSync).** Plastic speaks the Git protocol to any Git server,
in both directions. The mapping is one Git commit to one changeset; branch
hierarchy is flattened by turning `/` into `-` and rebuilt on the way back;
submodules map to Xlinks through `gitsync.conf`; email mapping is configured
there too. The limits: Git rebase and fast-forward merge are "restricted" ("We
don't handle rebases in Git fashion"), and you should not use commands "that
rewrite the history". The page does not say whether hashes survive a round trip
([migrating from Git / GitSync](https://docs.unity.com/en-us/unity-version-control/migrating-from-git)).

**What went wrong (documented).**

- For years, locks worked only on a single branch and only when centralised
  (book). Smart Locks fixed the branch case, but still not the replica case.
- Read restrictions produce incomplete changesets in distributed use, and the
  Git bridge bypasses path security entirely (security).
- GitSync cannot follow Git history rewriting (GitSync).

## 8. Xet (XetHub, now Hugging Face)

**Origin.** The CIDR 2023 paper "Git is for Data" (Low et al.) describes
XetHub's design ([paper](https://www.cidrdb.org/cidr2023/papers/p43-low.pdf)):

- It is built "entirely on the Git Clean/Smudge Filter", with Git storing
  pointer files, and "it is insufficient to merely look like Git; we must
  embrace Git in its entirety".
- Chunks average 16 KB. The paper calls its *low-variance* chunking a
  "different method" from FastCDC's normalisation (four rolling hashes, each
  aiming at about 4 KB), which avoids tiny and huge chunks.
- A Content-Defined Merkle Tree is kept per repository as a grow-only set
  (presented as a CRDT) and stored incrementally in Git notes, so
  deduplication spans all branches and forks.
- New chunks are concatenated into CAS objects of up to 16 MB.

Hugging Face acquired XetHub in August 2024 "to replace Git LFS on the Hub"
([Xet history](https://huggingface.co/docs/hub/xet/overview)).

**Current protocol (spec v1.1.0).** The specification is normative (RFC 2119
terms), so that "independent implementations MUST produce the same hashes,
objects, and API behavior" ([Xet spec](https://huggingface.co/docs/xet/index)):

- **Chunking.** Gearhash CDC with a 64 KiB target, 8 KiB minimum and 128 KiB
  maximum, and a 16-bit mask. A boundary is forced at the maximum size. Shipped
  reference files let other implementations check their boundaries
  ([chunking](https://huggingface.co/docs/xet/chunking)).
- **Hashing.** Keyed BLAKE3. A chunk hash uses a DATA_KEY. Xorb and file hashes
  are Merkle roots over `{hash} : {size}\n` lines under an INTERNAL_NODE_KEY,
  and the file hash is then re-keyed with a zero key. A file's Xet hash is
  therefore *not* the SHA-256 of its bytes, and it depends on the chunking
  ([hashing](https://huggingface.co/docs/xet/hashing)).
- **Objects.** *Xorbs* group up to 8,192 chunks, at most 64 MB. *Shards* list
  xorbs and file reconstructions. A file is reconstructed from terms, each an
  xorb plus a chunk range.
- **Global deduplication.** It queries only some chunks: the first chunk of each
  file, and chunks whose hash satisfies `% 1024 == 0`. Answers are protected by
  HMAC, so a client learns of a stored chunk only if it already has the chunk.
- **Fragmentation.** Implementations "SHOULD keep long, continuous runs
  together", even if a few chunks then go undeduplicated (example threshold: 8
  chunks, or a run of 1 MB or more)
  ([deduplication](https://huggingface.co/docs/xet/deduplication)).

**History, working copy, branches, locks, permissions.** Xet has none of its
own. It is a content layer under Git: "Xet-backed repositories continue to use
the Git LFS pointer file format". Older clients upload through LFS, and a
background job migrates the file into Xet. On download, older clients get "a
Git LFS bridge" that reconstructs the file behind a single URL
([legacy LFS](https://huggingface.co/docs/hub/xet/legacy-git-lfs)). `git-xet`
is "a git lfs custom transfer agent" (Xet spec index). Access control comes
from Hub tokens ([Xet spec, auth](https://huggingface.co/docs/xet/auth); not
read in detail).

**What went wrong (documented).**

- *Too many objects.* Storing chunks one per key "would require billions of
  entries", and per-chunk transfer generates "millions of requests". Hence the
  rule: "Avoid communication or storage strategies that scale 1:1 with the
  number of chunks"
  ([From Chunks to Blocks](https://huggingface.co/blog/from-chunks-to-blocks)).
- *Metadata growth and deletion* (the paper's own future work). The MerkleDAG
  "gets too large to download when the repository approaches the 10-100TB
  range". Because it "is append only and grows monotonically", data deletion,
  garbage collection, removed branches and "legal deletion requirements" are "a
  challenge".
- *Living inside Git.* The filter-based design kept Git's own limits, and the
  paper looked to a mounted filesystem as "the more scalable solution".
- The chunk target moved from the paper's 16 KB average to the spec's 64 KiB.
  No primary source consulted states why (unverified).

---

## Cross-cutting facts

| Dimension | What the systems did |
| --- | --- |
| Content-defined chunking | Only Xet specifies it. Mononoke chunks large files (boundary rule not verified). Pijul uses rsync-style block matching for binary diffs. Fossil, Mercurial and Perforce store whole files or deltas. |
| Identity hash | Mononoke: Blake2b-256. Xet: keyed BLAKE3 Merkle roots. Fossil: SHA1 → SHA3-256 (since 2.0). Mercurial: SHA-1. Plastic: GUIDs plus local sequence numbers. |
| Logical change identity | jj: change ID (a Git header, lost on a Git rebase). Mercurial: obsmarkers. Sapling: mutation records. Pijul: the change itself. Mononoke: an obsmarker-style mapping for each pushrebase. |
| Operation log | jj: a content-addressed, lock-free log of views; concurrent forks are merged 3-way. Sapling: `undo` over its operations (storage not verified). The others: none found. |
| Staging index | None of the eight has a Git-style index. They commit by files or interactive hunks (Mercurial, Sapling), by split or squash (jj), or by changelist (Perforce) or Pending Changes (Plastic). |
| Several working copies | jj workspaces; Fossil (any number of checkouts); Perforce and Plastic (one workspace per client, many per machine). |
| Branch as | a moving pointer (jj and Sapling bookmarks); a changeset attribute (Mercurial named branches, Fossil propagating tags); a changeset container (Plastic); a channel (Pijul); a depot path (Perforce, with streams not researched). |
| Enforced permissions | Always at a server: Mononoke hooks, the Mercurial acl hook, Fossil capabilities over HTTP(S), the Perforce protections table, Plastic ACLs. Fossil, Mercurial and Plastic each document that local or bridged access bypasses them. |
| Read restriction | Perforce `=read` (central). Plastic secured paths (incomplete changesets when distributed). Mercurial narrow (experimental). Mononoke redaction (content-level, all protocols). |
| Locks | Perforce `+l` and `p4 lock` (central; DVCS mode needs a commit server). Plastic (central; Smart Locks per destination branch; not across replicas). The others: none found. |
| Large files | Pointer-plus-central-store (Mercurial largefiles and lfs, Git LFS). Full content kept internally and pointers made only at the Git edge (Mononoke). Chunked CAS behind LFS-format pointers (Xet). Retention-limited file types (Perforce `+S`). |
| Git bridge exactness | hg-git: exact both ways, using extras plus binary deltas for normalised bytes. Mononoke: preserves the original Git bytes and maps SHAs; derives Git commits only for native ones. jj: native, so exact, but its own metadata is fragile under Git tools. Fossil: one-way mirror, lossy. Plastic GitSync: two-way, but no history rewriting, and path security bypassed. Pijul: import only. |

## Unverified or not found

- Sapling's internal storage of mutation and visibility, and Segmented
  Changelog internals: the docs pages were not reachable.
- Mononoke filestore chunk boundaries (fixed or content-defined) and chunk
  size.
- Where the Perforce have list lives, and Perforce Streams (not researched).
- Fossil: a staging area, partial commits, file locking, any large-file limit.
- Pijul and jj: locks and permissions (no documentation found either way).
- Why Xet moved from a 16 KB average chunk (paper) to 64 KiB (spec).
- Perforce Git Fusion and the Git Connector's lifecycle (only third-party
  sources found).
- Whether Plastic GitSync preserves Git commit IDs on a round trip (not
  documented).

## Bearing on ADR-0041

Facts and implications only. None of this chooses a design.

- **Decision 2 (distributed; acceptance points).**
  - Every system that *enforces* policy does it at a server: Mononoke, the
    Mercurial acl hook, Fossil over HTTP(S), Perforce, Plastic. The local copy
    is open to its holder (Fossil, Mercurial acl).
  - Mononoke's pushrebase shows an acceptance point that *rewrites* incoming
    commits. Git clients receive new hashes, and Sapling clients receive
    predecessor→successor markers.
  - Mercurial phases show acceptance as a state: a changeset "seen in a remote"
    becomes public and immutable.
  - Implication: an acceptance point that rebases, as compact landing does,
    has to answer for logical change identity and for a pushed Git commit's
    SHA. Mononoke answers both with a mapping and markers.
- **Decision 3 (workspace as unit; cheap movable names; a staging index).**
  - None of the eight systems has a Git-style index. jj, Sapling and Mercurial
    each chose against one and use interactive or split commits; Plastic and
    Perforce select files or changelists. ADR-0041's index is therefore
    Git-only precedent.
  - jj's view records every workspace's working-copy commit, so workspaces are
    part of the logged state. jj's *stale working copy* is the failure mode
    between recording an operation and updating files.
  - Mercurial's named branches, recorded in every changeset, are documented as
    unsuitable for short work. Fossil's propagating branch tags stop at merges.
    Plastic's branch-as-container cannot delete branches. These support
    "cheap, movable names" over names stored in the history.
- **Decision 4 (causal layer as data model).**
  - jj, Mercurial and Sapling all carry logical change identity outside the
    content hash: a change ID, obsmarkers, mutation records.
  - jj's change ID lives in a Git header that Git's rebase drops. Mercurial's
    markers needed years of scaling work and are still marked experimental.
  - Mononoke separates *inherent* data (hashed, minimal, on the write path)
    from *derived* data (asynchronous, rebuildable). This is a published split
    between facts and indexes.
  - Fossil keeps wiki, tickets and forum posts as hashed artifacts in the same
    store as check-ins. That is prior art for non-code records as native
    objects.
- **Decision 5 (typed actors).** No system types actors as human or agent.
  Mercurial's acl matches "the local user name on the system where the hook
  runs, and not the committer ... (since the latter is merely informative)".
  Fossil records a U-card user and allows PGP clearsigning. Mononoke bypasses
  hooks for named services and audits every bypass. The nearest precedent for
  *verified* identity is the authenticated server session, not the commit.
- **Decision 6 (actor-aware permissions; locks; reads).**
  - Perforce's protections table is the most complete grant/deny-by-path model
    found: actor, group, host, path, level, and an explicit `=read`. It depends
    on a server that mediates every read.
  - Plastic documents the cost of distributing read restriction: incomplete
    changesets, unverifiable permissions on unreplicated changesets, and a Git
    bridge that ignores path security.
  - Locks are central in every system that has them. Perforce DVCS locks live
    on a commit server. Plastic locks do not cross replicas and were for years
    single-branch; Smart Locks tie a lock to a destination branch and keep it
    *Retained* until the change merges there.
  - Perforce's typemap does not lock files that already exist.
  - Implication: "the acceptance point honours the lock" matches every
    precedent. A lock that holds offline has none.
- **Decision 7 (first-class large files; CDC; lazy fetch; no pointers).**
  - Xet is the one fully specified CDC design: Gearhash at 64 KiB
    (8–128 KiB), keyed BLAKE3 Merkle hashes, 64 MB xorbs, sampled global
    dedupe, and anti-fragmentation runs.
  - Xet learned not to scale 1:1 with chunks, and found that an append-only
    chunk index makes deletion (GC, removed branches, legal deletion) hard.
  - Pijul and the Mononoke filestore show lazy content behind hashed metadata:
    Pijul hashes a change's operations, not its contents. Pijul also documents
    that verification of missing content is deferred.
  - Mercurial's two pointer-based generations (largefiles, lfs) are documented
    as last-resort or experimental, and both are centralised. Mononoke instead
    keeps full content inside and makes pointers only at the Git edge.
  - A Xet file hash is not the SHA-256 of the file. A chunked native store
    still needs a whole-content hash wherever an external format such as LFS
    pointers, or decision 9's aliases, names files by SHA-256.
  - Content removal also has precedent: Fossil shunning (local, never
    propagated) and Mononoke redaction (blocked on read, history unchanged).
- **Decision 8 (documentation as first-class content).**
  - No system has section-level identity for documents.
  - Pijul's model, where content vertices are named by (change, position), is
    the closest precedent for stable sub-file identity, and its conflict
    representation never discards a side.
  - Xet's paper adds file-type-aware chunking (line breaks for CSV), a
    precedent for content-aware boundaries.
- **Decision 9 (permanent two-way bridge; exact round trips; aliases).**
  - Two systems claim exact two-way conversion, and both do it by storing
    Git's bytes:
    - hg-git keeps committer, encoding and gpgsig as extras, plus binary
      deltas for every message or author it normalises.
    - Mononoke keeps "Original VCS bytes" as inherent data and a SHA mapping
      table. It *derives* Git commits only for native changesets, with empty
      extra headers.
  - Both carry native-only metadata to Git in extra headers or message
    trailers (`HG:*`, `--HG--`, jj's change-ID header). jj's header shows that
    such metadata does not survive Git-side rewriting.
  - Plastic's two-way GitSync forbids Git rebase and fast-forward merge, and
    ignores path security.
  - Fossil's mirror is one-way and lossy. Mercurial's own `git` extension fails
    on octopus merges. Mononoke records which side is the source of truth during
    a migration.
  - Implication: ADR-0041's "imported Git object ID kept as an alias" and "the
    store keeps what Git's IDs depend on" match the two exact precedents. Its
    "changes from Git arrive without a verified actor" matches every precedent:
    none can verify a Git-side author.
