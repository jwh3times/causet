# Testing and qualification

This document defines the maintained validation contract. Tests create
disposable repositories and exercise the real CLI and Git executable; do not
run history-changing manual experiments in a valuable repository.

## Requirements

- Node.js 24 or newer, which runs the suites; the installed `cst` itself needs none
- Rust (the toolchain `native/rust-toolchain.toml` pins), to build the `cst` the suites run with `npm run build:native`
- Git 2.40 or newer (Git 2.49 or newer to exercise the merge-tree forecast
  engine; the merge-tree scenarios skip on older Git, where one scenario
  verifies the immediate `git-too-old` fallback instead; Git 2.46 or newer
  for the generated-history corpus's reftable histories, which skip on older
  Git)
- a clean source checkout for release qualification
- enough system temporary space for disposable repositories

The package has no runtime dependencies and no build step.

### Published-object retention

`test/retention.test.js` deletes source branches, expires reflogs, runs
`git gc --prune=now`, and checks `git fsck` only in disposable fixtures. It
verifies hard-squash, cherry-pick, rebase, provenance, and raw resolution-stage
dependencies across local GC and envelope round trips, for SHA-1 and SHA-256.
Interrupted publication followed by abort must preserve valid facts while
granting no target coverage. Hard-exit and competing-writer tests exercise the
checked notes/retention/resolution transaction, through a conflicted
`cst reconcile --continue` that publishes a resolution and a gated
`cst commit`; a locked retention ref must leave import destinations unchanged.
The notes-tree cases (a fanned leaf, mixed flat and fanned notes, opaque
hexadecimal directories, an opaque tree on the attachment path) let a
post-commit hook lay out the tree `cst commit` then appends its provenance to.

Backfill tests cover read-only preview, quarantine, idempotence, and shared
retention from a linked worktree. Carrier tests bound parent fan-in at 64 and
exercise publication into imported fanned notes. Release qualification also
checks old-reader/new-writer and new-reader/old-writer envelope compatibility,
records publication process/storage costs on the issue or PR, and runs the full
platform matrix required by [ADR-0025](adr/0025-retain-the-object-closure-of-published-causal-facts.md).

The six-change publication fixture still produces 19 records. Atomic retention
raises its identified-host process expectation from 42 to 140; only that
deterministic expectation changes in `hosts.lab-windows-a`. Existing latency
measurements, tolerances, and historical OS-only entries remain unchanged. The
old and new process/storage measurements belong on #49 and its PR. OS-only
publication counts predate retention and are historical comparisons, not a
qualification of the new publication mechanism.

### Windows resolution retention paths

With Git long paths disabled, a resolution ref's absolute `.lock` path must
fit within 259 characters. For an ordinary SHA-1 repository with a `.git`
directory, a blob-result resolution consumes 145 characters below the root
(`refs/causet/resolutions/…`): a 114-character root fits, and a 115-character
root fails. SHA-256 object IDs consume another 24 characters; deletion results use the shorter `deleted`
suffix. Linked worktrees store these refs in the common Git directory, so
shortening only the linked worktree path does not solve this limit.

When Git fails to create that path at or above 260 characters, publication
reports `path-length-exceeded`, the measured lock-path length, and the required
reduction. Use a shorter Git directory path or enable long paths locally with
`git config core.longpaths true`. causet does not change this setting for you.
A failed publication can leave an operation journal; use the operation's
`--abort` to restore its starting commit, then retry after addressing the path.
Existing lock files and permission failures retain `git-command-failed`.

`test/resolution-path.test.js` exercises the Windows boundary, shared refs from
a linked worktree, successful publication with long paths enabled, existing
locks, and CLI JSON failure followed by reconciliation abort. On other hosts,
the same long paths must publish successfully; no synced folder or special
hardware is required.

## Development validation

`node --test test/semantic-conformance.test.js` runs the shared semantic-merge
[fixtures](semantic-conformance/README.md) through the real CLI. The suite checks
exact classifications, entities, rendered bytes, stable identity, and read-only
repeatability. Parser v2 cases assert corrected fence behavior; historical v1
views remain characterized and affected legacy plans must block migration.
The adapter launches the CLI through `test-support/cst-command.js`, so with
`CAUSET_CLI` set the same fixtures drive that implementation's Markdown adapter;
only the two catalog-validation tests stay module-level.
`node --test test/spec-fences.test.js` covers migration identity, unknown-version
refusal, syntax edges, old forecast rejection, and pending-operation recovery.

`npm run sync:architecture -- --check` checks the generated architecture tables
against the source inventory and persisted-schema registry. The focused
`test/architecture-tables.test.js` suite also exercises drift detection and
safe regeneration; CI runs it even for documentation-only changes.

Run the complete integration suite in ordinary mode:

```bash
npm test
```

Every suite file spawns Git and the CLI through `testEnv` from
`test-support/git-environment.js`, which sets `GIT_CONFIG_NOSYSTEM=1` and
points `GIT_CONFIG_GLOBAL` at a file created for the run, so a host's
global `commit.gpgsign`, `core.hooksPath`, `init.defaultBranch`, or
`core.autocrlf` cannot reach a fixture; fixtures set their own identity and
line-ending settings. That file sets only `maintenance.auto=false`, so no
detached `git maintenance` process is still removing its lock from a
fixture's `objects` directory while a suite copies it (#203). The CLI itself still reads the
user's real configuration. The helper lives beside `test/` rather than inside it because
`node --test` runs every JavaScript file under a directory named `test` as a
test file, so a shared module there would be executed as one.

Run it again with the invocation-scoped Git object session forced:

```powershell
$env:CAUSET_GIT_SESSION = "1"
npm test
Remove-Item Env:CAUSET_GIT_SESSION -ErrorAction SilentlyContinue
```

On POSIX shells:

```bash
CAUSET_GIT_SESSION=1 npm test
```

Run it with the session forced off as well. "Ordinary mode" is not one mode:
the session is the default on Windows and off elsewhere, so an ordinary run
on a Windows host never exercises the one-process fallback that every POSIX
user runs by default. v0.13.0 shipped with two tests red in exactly that
path because the gate ran where the session is on. Forcing both settings on
every host closes the gap:

```powershell
$env:CAUSET_GIT_SESSION = "0"
npm test
Remove-Item Env:CAUSET_GIT_SESSION -ErrorAction SilentlyContinue
```

```bash
CAUSET_GIT_SESSION=0 npm test
```

Run it with each forecast engine forced. The default engine differs by
platform (`merge-tree` on Windows, `worktree` elsewhere, because merge-tree
needs Git 2.49 and POSIX baselines lag it), so both runs are needed on every
host. Flipping the default to `merge-tree` everywhere, once that version is the
baseline or common on POSIX, is
[issue #8](https://github.com/jwh3times/causet/issues/8); until it closes, the
split default is deliberate and the two runs are not redundant. The merge-tree
run simulates every clean forecast step through `git merge-tree` and falls back
to the worktree simulator where it must; the worktree run exercises the oracle
throughout:

```powershell
$env:CAUSET_FORECAST_ENGINE = "merge-tree"
npm test
$env:CAUSET_FORECAST_ENGINE = "worktree"
npm test
Remove-Item Env:CAUSET_FORECAST_ENGINE -ErrorAction SilentlyContinue
```

```bash
CAUSET_FORECAST_ENGINE=merge-tree npm test
CAUSET_FORECAST_ENGINE=worktree npm test
```

Run it with the native read engine selected, which exercises the gitoxide
backend's five supported operations; the backend is linked into `cst`, so there
is nothing extra to build. Every read must go through the engine seam
(`native/engine/src/engine.rs`), because a read that bypasses the seam is refused
in this mode (ADR-0019):

```powershell
$env:CAUSET_ENGINE = "native"
npm test
Remove-Item Env:CAUSET_ENGINE -ErrorAction SilentlyContinue
```

```bash
CAUSET_ENGINE=native npm test
```

See [native build and qualification](native-engine.md) for the toolchain,
supported profile, parser fuzz target, optional packaging, and ADR-0027's separate
latency gate. Git transport tests explicitly select Git; native oracle tests
assert executed operations and zero Git processes for supported inputs.

**The native-kind mode** (ADR-0044 item 1, #307) runs every suite as usual,
then imports each Git repository a test leaves into a native repository and
holds N1's commands on the copy to Git's answers on the original:

```bash
CAUSET_KIND=native npm test
```

```powershell
$env:CAUSET_KIND = "native"
npm test
Remove-Item Env:CAUSET_KIND -ErrorAction SilentlyContinue
```

`test-support/native-kind.js` does it, through hooks that
`test-support/git-environment.js` installs in every suite file:
- **Finding a test's repositories.** Each test gets its own temporary
  directory: `TMPDIR`, `TEMP` and `TMP` name it while the test runs, so
  `os.tmpdir()` and every process the test starts write there. It sits
  directly in the host's temporary directory as `ck` and six characters,
  because some suites already come within a dozen characters of Windows'
  259-character path limit; the run removes them as it exits, and an
  interrupted one leaves them behind. After the test,
  every Git repository under it is found: a working tree's, a linked
  worktree's or a bare one, by its common directory. After the file's last
  test, everything the file made, in a test or outside one, is looked at
  again. A repository is compared whenever its refs or `HEAD` differ from when
  it was last compared, so a fixture one test makes and later tests change is
  compared as they leave it. A repository a test removes before it ends is not
  seen. The mode relies on `afterEach` running before a
  test's own `t.after` cleanup. By then `os.tmpdir()` names the directory
  outside the test again, so a cleanup that checks a fixture's path reads
  the temporary directory when it makes the fixture, not when it removes it.
- **What is compared,** once Git's IDs are translated through the alias map,
  a commit's to its native commit where it has one
  ([commits.md §6](native-history/commits.md#6-naming-commits)):
  - `cst import --verify` first, so a store problem fails as such rather than
    as a mismatch in some command's output;
  - `cst for-each-ref`, `cst rev-parse HEAD`, `--symbolic-full-name HEAD` and
    `--all`;
  - `cst cat-file --batch` for every imported object: its type, size and Git
    bytes against `git cat-file --batch` (#346);
  - `cst ls-tree -r -t -l` for everything a ref names.

  Only the IDs an answer names objects by are translated: a blob's bytes, a
  commit's message and a tree entry's name stay Git's. A commit or tag
  translates only the header lines Git's parser follows. Git answers as import
  reads, with replacement refs off, and for the common directory, so `HEAD` is
  the main worktree's. Every `cst` the comparison starts runs with a `PATH`
  that holds no Git, so a native read that started a Git process would fail
  (ADR-0044 item 2). The objects are read a group at a time, at most 64 MiB
  of them unless one object alone is larger: one `git cat-file --batch` and
  one `cst cat-file --batch` per group, compared object by object. A `cst` or
  Git process the comparison starts is stopped after 5 minutes
  (`test-support/bounded-process.js`), which fails it: a `cst` that never
  ends fails its test rather than holding the run. A caller may give the
  processes that read every object, the reconstruction check and each
  group's `cst cat-file --batch`, a longer limit, as the real repositories
  do.
- **Refusals.** A repository that import refuses fails its test, unless
  `REFUSALS` in `test-support/native-kind.js` lists it with the suite file, the
  test, a part of the refusal and the reason. The list holds the suites'
  shallow and partial clones, sources that name objects they do not hold,
  sources with a symbolic ref whose name is not UTF-8 (#398), and the shallow
  clone of this checkout that CI's one-commit fetch makes.
- **Cost.** Each `cst` invocation opens the store again, so the comparisons
  run as many at a time as the host has cores. On a 16-core Linux host the
  whole suite took 150 to 240 s in this mode against 45 s without it, most of
  it for `test/rust-engine.test.js`'s clone of this checkout, about 7,000
  objects. That was measured while every object still cost three `cst`
  processes, before `cst cat-file --batch` (#346).
  CI's one-commit checkout makes that clone shallow, so there import refuses
  it, as listed.

The conformance fixtures and the frozen oracle corpora name no N1 command, so
in N1 they take part only through the repositories their suites make, which
this mode imports like any other. `test/native-kind.test.js` checks the mode
itself: a copy that answers otherwise, and a refusal it does not list, each
fail the test that left the repository.

**The reftable mode** (#277) runs every suite with the repositories Git
creates kept in reftable storage, which Git 3.0 is planned to make the
default. It needs Git 2.45 or later; an older Git ignores the variable and the
run proves nothing:

```bash
GIT_DEFAULT_REF_FORMAT=reftable npm test
```

```powershell
$env:GIT_DEFAULT_REF_FORMAT = "reftable"
npm test
Remove-Item Env:GIT_DEFAULT_REF_FORMAT -ErrorAction SilentlyContinue
```

A reftable repository keeps no file per ref, so a test that needs a held ref
or a missing object makes it through Git, whatever the storage:
`holdRefLock` in `test-support/git-environment.js` leaves an
`update-ref --stdin` transaction prepared, and a dangling ref points at a loose
object that is then deleted. A reftable lock holds every ref, not one, so the
post-commit notes failure is staged with a `reference-transaction` hook
instead. Fixtures whose subject only files storage has pass `FILES_REFS` to
`git init`, and keep it in this mode too: the Windows lock-path boundary of a
loose ref and a lock that holds one ref (`test/resolution-path.test.js`;
Git's own continuation fails first on a reftable lock), the native read engine's supported
profile (`test/tree-modes.test.js`), and the answers frozen on files storage
(the engine corpus and the benchmark counts). `test/reftable.test.js` and the
last case of `test/resolution-path.test.js` create reftable repositories
themselves, so every run on Git 2.45 or later covers reftable once; an older
Git skips them. `test/reftable.test.js` holds the decision of which names a
repository uses (ADR-0039 §1, §3) to one `git for-each-ref` for both sets of
names, to refusing a repository whose only former-name evidence is a ref, and
to ignoring a ref that only shares a prefix with a former name.

**The SHA-256 mode** (#278) runs every suite with the repositories Git creates
kept in SHA-256 objects, which Git 3.0 is also reported to make the default.
The native read engine refuses that format, so every read goes to Git, and this
mode is what shows the Git fallback answers there:

```bash
GIT_DEFAULT_HASH=sha256 npm test
```

```powershell
$env:GIT_DEFAULT_HASH = "sha256"
npm test
Remove-Item Env:GIT_DEFAULT_HASH -ErrorAction SilentlyContinue
```

A test that reads object IDs from a repository it made accepts either length
(`OBJECT_ID` in `test-support/git-environment.js`) and judges records in that
repository's format. Fixtures whose objects or answers were recorded under
SHA-1 keep SHA-1 in this mode, with `SHA1_OBJECTS` or `--object-format=sha1`:
the v0.19.1 legacy bundle, the manifest-hash envelope vector, the engine corpus
(`FROZEN_STORAGE` is both pins at once), and the native store's cases other
than those that run in both formats. `cst metadata
benchmark` and `cst spec benchmark` build SHA-1 fixtures whatever the default,
because their baselines were recorded on SHA-1.

**The generated-history corpus** (ADR-0044 item 1, ADR-0045 decision 13,
#308) is Git repositories generated from a seed, each run through every N1
check. `test/generated-histories.test.js` runs it: one history per case by
default, as part of `npm test`, and 1,000 in `.github/workflows/corpora.yml`:

```bash
CAUSET_GENERATED_HISTORIES=1000 node --test test/generated-histories.test.js
```

- **What a history holds.** `test-support/generated-histories.js` writes each
  one as a bare repository of loose objects and ref files, without Git, so a
  seed gives the same objects and refs whatever Git version is installed. Git
  runs only to pack a history or prune it. A reftable history is the
  exception: `git init --ref-format=reftable` makes it, and `git update-ref
  --stdin` writes its refs, symbolic ones included, which needs Git 2.46 or
  later. On an older Git each reftable history is skipped with that reason,
  never passed (#334). Its `CASES` are ADR-0045's list, then the refs':
  - merges and octopus merges;
  - renames, mode changes, symbolic links and submodule links;
  - empty trees, as a subtree and as a commit's root, and empty files;
  - signed commits and tags, commits in ISO-8859-1 with an `encoding` header,
    and extra headers: `mergetag`, and headers no Git writes, one of them
    spanning lines;
  - one case for each kind of malformed object (`MALFORMED`): bytes no Git
    writes and every Git reads. `git fsck` reports all but the overlong and
    group-writable modes, the uppercase IDs and the two message kinds:
    - an unsorted tree;
    - a tree repeating a name: an entry listed twice, and a blob and a tree
      of one name;
    - zero-padded, overlong and group-writable modes;
    - entries named `.`, `..` and `.git`;
    - uppercase IDs in a commit;
    - a commit with no message, and one with no final line feed;
    - identities without a name, without the email's `<`, without a date, or
      (an author's only, and always in the history that must hold a bad
      identity) with a date that overflows: a committer's would make the
      commit-graph `git gc` writes compute generation numbers forever;
    - a tag without a tagger;
  - versions of a binary of at least the 1 MiB delta threshold, which import
    stores as deltas;
  - refs stored in the reftable format (#334);
  - refs named in UTF-8, in either storage: branches with a multi-byte
    character and with a combining sequence (`e` and U+0301), a lightweight
    tag and an annotated one;
  - refs named in bytes that are not UTF-8, in reftable histories only: a
    branch, a lightweight and an annotated tag, a symbolic ref so named that
    points at a branch, an ASCII symbolic ref that points at the branch so
    named, and a chain, a symbolic ref so named that points at another
    symbolic ref. Import refuses a symbolic ref whose name is not UTF-8
    (#398), so those two are each written only into their own copy of the
    final stage, whose import must be refused by that name, with nothing
    written. Such a name reaches Git only on standard input: Windows argv
    cannot carry its bytes, and Git for Windows stores it as a loose file
    under another name, so a files history never holds one.

  As each stage ends, after any pack or prune, every ref named outside ASCII
  and every ref of a reftable history is read back from `git for-each-ref`,
  byte for byte, so a name Git stored as another fails the history, as does
  a ref a write left dangling. Signatures are random bytes in the shape of PGP and SSH
  signatures: Git parses them as signatures, and none verifies.

  History *n* always holds case *n* of the list, counting round it, so any
  corpus of at least one history per case holds every case. The rest is
  chosen from the seed: tags of commits, trees, blobs and tags, notes,
  replacement and remote-tracking refs, a symbolic ref, a detached or unborn
  `HEAD`, packed objects and refs, file names in Latin-1, and SHA-256 for
  about a quarter. Beyond the first history per case, about a tenth are
  reftable; refs named in UTF-8 come in about one history in seven, and half
  the reftable histories have names that are not UTF-8. How a history stores
  and names its refs is drawn from a stream of its own, so the rest of the
  history is what it would be without them. Each history has two stages. The
  second adds commits and rewrites a branch from an earlier commit, so what
  its old tip reached may be reached no more; it may also delete a ref, add a
  tag, move a branch or delete a tag named outside ASCII, and prune what no
  ref reaches.
- **What is checked** (`test-support/generated-history-check.js`), for each
  history:
  - Git reads it whole: `git rev-list --objects --all`;
  - fresh imports of the first stage, one from the history and one from a
    copy of it with packed objects and refs, write byte-identical stores;
  - `cst fsck` on the first stage's import;
  - the native-kind mode's comparison (`compareCopy`), `cst import --verify`
    and every N1 command against Git: on the first stage's import, and on a
    full import of the final history;
  - after the second stage, an import into the first stage's copy holds what
    a full import of the final history holds: the same ref snapshot, its own
    and the full import's alias rows, and its own and the full import's
    objects, each stored once; then `cst fsck` and `cst import --verify` pass
    on it.

  The objects compared are those the history names: everything but content
  that no alias row names. That content is a chunk of a large file, and which
  chunks a store holds depends on the forms import chose. Each form depends
  on what the store held when the version was written (storage.md §5.1): a
  delta needs its base present, and a chunk list wins when the store holds
  more of its chunks. An incremental import's store held other things than a
  full import's at each version, so a large version may be a delta in one and
  a chunk list in the other, in either direction, and its chunks with it. The
  check holds every other form equal, and each object the first stage wrote
  to its first form. Unless a version new in the second stage is a chunk list
  in the incremental import and a delta in the full one, every chunk the
  incremental import holds must also be one its earlier store or the full
  import holds. This is ADR-0045's decision 3 as amended on 2026-10-26.

  A version both imports store as a delta must have the same record in both,
  byte for byte (#338). Its base is fixed by history: the content its path
  held in the first parent of the commit that introduced it (storage.md
  §5.1). Its data is fixed by the contract's parameters and the pinned zstd
  (§7). A delta is alone in a stored frame (§5), so the check reads both
  records from the containers with no decompression, on every Node the
  suites support, and never skips. It fails on a delta in any other frame. It
  fails on a difference too, naming the version and both bases when they
  differ, or its base and the first byte where the records differ. The corpus
  test's diagnostics, and each real repository's job summary, say how many
  deltas it compared.

  No check here sees a symbolic ref's one-step target: `for-each-ref`'s
  `%(symref)`, Git's and cst's, gives where a chain ends, and no N1 command
  answers the step. Import asks Git for it by the ref's name, and refuses a
  symbolic ref whose name it cannot pass to Git, one that is not UTF-8
  (#398). The native-repository suite reads the recorded steps from the
  snapshot itself.

  The suite also generates the first histories of `causet-n1`, one per case,
  and compares a digest of their refs, `HEAD` and objects after each stage
  with one pinned in the test: one digest for the files histories, one for
  the reftable histories, which an older Git skips without changing the
  other. Each runner thus shows that it generates the corpus every other
  runner does, and a change to the generator that changes the corpus updates
  the digests deliberately.
- **Shards.** One Node process starts only about a thousand processes a
  second, so the suite checks the histories in shards, one Node process per
  core, each running `generated-history-check.js` as a script on every
  history whose index is its own modulo the shard count.
- **Reproducing a failure.** Each history is a subtest named with its index,
  format, ref storage and cases, and a skipped one with the reason.
  `CAUSET_GENERATED_ONLY=<index>` checks that one, and
  `CAUSET_GENERATED_SEED` chooses the seed (by default `causet-n1`, the one
  CI runs). Any Git or `cst` process the generator or a check starts, the
  comparison's included, is stopped after 5 minutes
  (`test-support/bounded-process.js`), which fails its history rather than
  holding the corpus. The suite removes every repository it makes before its test ends, so the
  native-kind mode has none of them to import again.
- **The rotating seed** (#336). `corpora.yml` checks only `causet-n1`, and
  that seed stays fixed so the gate fails the same way twice; once it passes,
  it finds nothing new. `.github/workflows/rotating-corpus.yml` checks 1,000
  histories of another seed each week, on Ubuntu and Windows, on Thursdays
  and on manual dispatch. It gates nothing, and `release-gates.yml` never
  calls it.
  - Its seed is the ISO week's, `weekly-<year>-W<week>` (for example
    `weekly-2026-W46`), so every run in one week checks the same histories.
    A dispatch may name another seed: letters, digits, `.`, `_` and `-`.
    A dispatch with a seed shows it in the run's name; every run shows it in
    its job names and summaries.
  - With `CAUSET_GENERATED_REPORT=<file>`, the corpus test writes what it
    found there as JSON (`corpusReport` in
    `test-support/generated-histories.js`): the seed, the histories checked
    and skipped, and each failing history with its problems.
  - A failure turns the run red, and its last job
    (`scripts/rotating-corpus.mjs`, the only one allowed to write issues)
    opens one issue titled `Generated-history corpus fails on seed <seed>`,
    labeled `needs-triage`. It lists each failing host and history, with
    the problems, the run's link and the command that reproduces it:

    ```bash
    CAUSET_GENERATED_SEED=<seed> CAUSET_GENERATED_ONLY=<index> node --test test/generated-histories.test.js
    ```

    A host that failed without a failing history, from the build, a crashed
    shard or the timeout, is listed with that reason. A later failure of the
    same seed comments on that seed's issue instead of opening another, and
    reopens it if triage had closed it. A pass files and comments nothing.
    The board's auto-add puts a new issue on project 7, and triage gives it
    its fields. `test/rotating-corpus.test.js`, in the default suite, holds
    the seed choice, the report and the issue's opening, commenting and
    reopening, with `gh` replaced by a stub.
  - Through normal triage, a failing seed's histories become either a fix
    or a fixed regression case. The rotating seed is never the regression
    case itself: next week's run checks another.
- **Cost.** On a 16-core Linux host, 1,000 histories took 4 to 6 minutes, and
  the default set, then 24 histories, about 10 seconds. On GitHub's hosted
  runners, 1,000 took 22 minutes on Ubuntu and 44 on Windows (#333).

**The real repositories** (ADR-0044 items 1 and 2, ADR-0045 decision 13,
#309) are three Git repositories imported and checked whole, each with the
storage gate. `test/real-repositories.test.js` runs them; it has a test for
each one only when `CAUSET_REAL_REPOSITORIES` names it (comma separated, or
`all`), because they fetch from the network and take minutes to hours. It
adds no skipped test to `npm test`, whose CI jobs expect only the skips they
know.
`.github/workflows/corpora.yml` runs each in a job of its own on Ubuntu and
Windows:

```bash
CAUSET_REAL_REPOSITORIES=causet node --test test/real-repositories.test.js
```

- **What each holds** (`test-support/real-repositories.js`). Each is made in
  a bare repository in two stages, so that both import checks run on it:
  - `causet`: this repository at the commit under test, as `main`, with the
    `v*` tags, fetched from the checkout. It needs the whole history, so CI
    checks out with `fetch-depth: 0`; `CAUSET_REAL_CAUSET` names another
    checkout. The first stage is the history at `v0.25.0`.
  - `git`: git/git at the tag `v2.56.0`, fetched from GitHub, with that tag
    and `main` at it. The first stage is `v2.55.0`. Tags never move, so the
    history is the same every week. `CAUSET_REAL_GIT_URL` names another copy.
  - `large-files`: six successive Node.js releases, `v24.18.0` to `v24.22.0`,
    each archive pinned by the SHA-256 its release publishes. Every host
    commits the Linux x64 `bin/node`, about 125 MB, whatever it runs on. Beside it
    are three generated assets, edited at every commit: a 16 MiB image painted
    over in places, a scene file with records inserted and removed, and an
    audio file that grows at its end. `git fast-import` writes the 18 commits
    with fixed dates, and each release's first commit is tagged. The first
    stage is the first nine commits. The archives are downloaded once into
    `CAUSET_LARGE_FILE_CACHE` (by default under the system's temporary
    directory), which CI caches.
- **What is checked** (`test-support/real-repository-check.js`):
  - the import checks of the generated corpus (`test-support/import-checks.js`):
    the first stage imported and then the second into the same copy holds
    what a full import of the second holds, and a fresh import of a copy
    with every object and ref packed is byte-identical to the full import;
  - `cst fsck` and `cst import --verify` on both copies, and the native-kind
    mode's comparison (`compareCopy`) on the full import, every object of
    every repository, git/git's included, through one `cst cat-file
    --batch` per group (#346);
  - zero Git processes: every native read runs with no Git on its `PATH`;
  - **the storage gate:** N1's objects against what `git gc --aggressive
    --prune=now` leaves in `objects/pack/` of the bare repository, that is,
    its pack, index, reverse index and bitmap. N1's objects are every file of
    the `.cst/` of a full import with no native history, which the test hook
    `CAUSET_TEST_IMPORT_WITHOUT_HISTORY=1` asks for (#437). A phase's gate
    counts its own objects and its predecessors'
    ([ADR-0044's amendment of 2026-11-11](adr/0044-define-the-exit-regime-every-native-phase-must-meet.md#amendment-2026-11-11-which-bytes-a-phases-storage-gate-counts)).
    What native history adds, the full import's store less that one, is
    reported, never checked.
    `objects/info/commit-graph` is left out, as the early estimate in
    storage.md §6 left it out.
    Stored bytes must be at most Git's, and on the large-file corpus strictly
    fewer. No repository is listed against the gate since #357, so every
    job holds it. A known storage gap may be listed instead of failing the
    job, on the repository in `real-repositories.js` and against the issue
    that closes it (`test-support/storage-gate.js`, #343 decision 1), but
    N1 cannot exit while any entry is listed. A gap entry passes up to its
    ceiling and fails once the store meets the gate, so that it is removed.
    A margin entry is for a store near Git's bytes that crosses them as the
    history grows: it passes either side up to its ceiling and is removed by
    hand once the store is clearly under them. `test/storage-gate.test.js`
    holds these rules in `npm test`.

  Each job's summary reports the gate's verdict and ratio, both byte counts
  with their parts, the bytes native history adds, the number of Git
  objects, how many shared deltas the
  incremental import check compared (#338), and what each import cost
  (#347). Import reports these numbers itself (`CAUSET_TEST_IMPORT_REPORT`):
  - its time, in all and by phase;
  - the peak size of the metadata it held on disk until its container
    closed (`import.metadata`, storage.md §3.2);
  - the peak size of the Git bytes of the commits, tags and trees it held
    on disk until it stored them (`import.objects`, #405);
  - the `cst import` process's peak memory, in all and as each phase ended.
    This is Linux's high-water mark, and unavailable on Windows, where a
    process cannot read its own without unsafe code.

  After every check, one more commit, a new file at the top of the tree, is
  imported into the full import's copy, and `cst fsck` checks the copy
  again. The summary therefore also shows what a small incremental import
  costs a store that size (#324). These numbers are reported, never checked.
  An import, `cst fsck`, the reconstruction check or a group's `cst
  cat-file --batch` here may run for 3 hours, not the 5 minutes the
  generated corpus allows; the comparison's other processes keep the 5
  minutes.
- **Cost.** On a 16-core Linux host, causet took about 90 seconds, the
  large-file corpus 16 minutes (each full import about 3.5 minutes) and
  git/git 36 minutes (each full import about 8 minutes, in one thread and up
  to 6.3 GB of memory). These were measured while the comparison still
  started a `cst` for each answer on each object, and git/git's was a
  sample of 512 objects. #347 brought a full import of git/git on format
  version 1 down from 6.3 GB to about 3.1 GB of memory on Linux. #405 then
  moved the Git bytes of the commits, tags and trees import reads, 2.6 GB
  of that peak, to disk. Since #405, on the hosted Ubuntu runner, that import
  takes about 8.5 minutes and peaks at about 480 MB. While it runs it holds
  about 4.2 GB on disk: 1.58 GB of metadata and 2.6 GB of objects. The
  comments on #347 and #405 break down where its time and memory go.

**The CLI the suites run.** Every CLI launch in the suites, the demos,
`scripts/benchmark-regression.mjs`, and the whole-command part of
`scripts/measure-real-repository.mjs` goes through `test-support/cst-command.js`.
Since #243 that is this checkout's Rust build, `native/target/release/cst`
(`cst.exe` on Windows), which `npm run build:native` produces; without it the
first test that runs the CLI fails and names the command. CI's suite jobs build
it before `npm test`. `CAUSET_CLI=<path>` selects another implementation
(ADR-0037, #140):
- a `.js`, `.mjs` or `.cjs` path runs under the current Node;
- any other path is executed directly;
- a path that does not exist stops the run.

```bash
CAUSET_CLI=path/to/cst npm test
CAUSET_CLI=path/to/cst CAUSET_ENGINE=native npm test   # combines with every mode
```

Some tests check a module or a probe and never launch the CLI; they say nothing
about a selected implementation. Rather than a hand-maintained list, the suite
counts CLI invocations per test. When `CAUSET_CLI` is set, each test that made
none is reported with a diagnostic line, `did not invoke the CLI under test (…);
module-level test`. With `CAUSET_CLI_REPORT=<file>` set as well, it also appends
one JSON line per such test to that file, so a whole run can be counted.

**The JavaScript oracle, frozen.** Until #243 three suites put the Rust
implementation and the JavaScript one in `src/` on the same inputs and required
the same answers. ADR-0037's oracle period ended with v0.23.0, so those answers
were recorded once from `src/` and committed under `test/fixtures/oracle/`; the
suites now hold the Rust side to them. A frozen group is either the values
themselves or, for a large corpus, a string of 8-digit SHA-256 prefixes of each
case's expected answer (`test-support/oracle-vectors.js`); a mismatch names the
case and prints the Rust answer. The inputs live beside the suites, in
`test-support/model-corpus.js`, `engine-corpus.js` and `cli-corpus.js`, and a
change to one invalidates its frozen answers unless it alters only what the
masks hide. There is no oracle to re-record from: changing a corpus or an answer
means deciding that the Rust answer is right, and saying so in the change.

- `test/native-cli.test.js` runs the Rust CLI on every invocation the two CLIs
  were compared on outside a repository: help and version, the global flag and
  environment failures, each flag without its value, every argument-only usage
  failure human and JSON, the camel-case input the JavaScript parser failed on
  by accident (refused by name since #262, its answers re-recorded then),
  `doctor` and the record readers outside a repository, the
  build-scoped capability document, and the benchmarks. The version, the
  directory the cases run in, trace timings, the benchmark's environment and
  timings, and the capability document's hashes are masked. The benchmark's
  over-budget verdict is not, so a `metadata benchmark` case that measures must
  pass `--budget-ms 60000`, the most the flag allows (#375). It also checks that
  the runtime describes itself as the Rust CLI (ADR-0037 §5) and that the
  former delegation variables, `CAUSET_DELEGATE` and `CAUSET_JS_CLI`, are
  ignored. The comparisons inside repositories, including that a journal or a
  forecast one CLI wrote was finished or consumed by the other, ended with the
  oracle; the integration, conformance, schema and failure-boundary suites
  hold the Rust CLI to the same behavior in every mode.
- `test/rust-model.test.js` runs the Rust record model (`native/model`, #142)
  through the `model-probe` executable (`test-support/model-probe.js`) and
  holds it to the oracle's answers for:
  - the canonical-JSON vectors, and 1,500 generated documents through the
    canonical, hashed-payload and legacy serializers (compact and pretty are
    checked against `JSON.stringify` itself);
  - the registries, every family, bound, error code and namespace, in order;
  - classification, compatibility and readability for every family, version
    and spelling;
  - the validators and referenced objects over every real record of the
    v0.19.1 fixture and every one-member mutation of each, in both object
    formats, where a malformed member must be a field error, never a throw
    (#172);
  - resolution signatures, logical identifiers, and `createdAt` timestamps,
    judged by the ECMAScript date-time format alone, including strings V8's
    non-ISO `Date.parse` fallback would read (#173); SHA-256 is checked
    against `node:crypto`. Generated member names avoid escapes, because Node
    26.4's `JSON.parse` could mis-name an escaped member after an earlier
    object primed the same member path; fixed cases cover those names.
- `test/rust-engine.test.js` runs the Rust Git engine (`native/engine`, #143)
  through the `engine-probe` executable (`test-support/engine-probe.js`). The
  repositories are dated, so object IDs are stable, and the scratch directory
  and the host's Git version are masked. For every call the value or the error
  (code, message, details and exit code) and every count must be the oracle's:
  processes, session queries and cache hits; fallbacks, native reads and direct
  reads; the per-command counts. Timings are not compared. The requests cover
  every catalog operation and its failure paths, with and without an object
  session, on a history with trailers, a merge, tags, notes, specs and a locked
  linked worktree, a stopped cherry-pick, an empty repository and a SHA-256
  repository; the native engine's answers and each fallback reason; the session
  cache and its invalidation by a mutation; the bypass rule; the merge-tree
  session's clean, conflicted and refused steps and the four session failure
  hooks (skipped on a Git older than the merge-tree engine needs); and the
  engine differential, whose Git column must match the oracle's operation for
  operation. A clone of this repository, whose history changes with every
  commit, is held to the Rust engine itself: its differential must be equal,
  and every catalog call must answer alike with and without a session.
  `listRefs` over several patterns, which the oracle never asked, must answer
  alike on both engines with no fallback, each ref once and sorted by name,
  and no pattern lists nothing (#277).

A new engine operation needs its Git implementation in
`native/engine/src/git.rs`, its catalog line in `native/engine/src/engine.rs`,
its probe in `native/engine/src/differential.rs` and its arm in
`native/engine/src/bin/engine-probe.rs`. It changes the catalog the frozen
differentials list, so their answers are re-recorded from the Rust engine, as
above. The suites skip when a probe is not built. Mutation fuzz targets,
`fuzz-parsers`, `fuzz-model` and `fuzz-engine`, run in CI.

CI's suite jobs also run the Rust crates' unit tests:
`cargo test --workspace`. The scale benchmark's analysis is
one of them (`native/cli/src/scale_benchmark.rs`, until #243
`test/scale-benchmark-analysis.test.js`).

The suite includes `test/schema-catalog.test.js`, which keeps the published
JSON Schema catalog in `docs/schemas/` in agreement with the executable
validators of the Rust record model (`native/model`, the authority since #243),
through its probe: every schema identifier the Rust CLI uses (`native/cli`,
`native/engine` and `native/model`, outside their unit tests) must have a
catalog document, records produced by the real CLI must satisfy their documents
and the model's validator, and a note record the validator rejects for a
missing field must be rejected by its document too. A new or changed record
family is not complete until its catalog document passes these checks.
`test/canonical-json.test.js` verifies the frozen canonical-JSON profile
against the shared vectors in `docs/canonical-json/vectors.json`; a future
native implementation must pass the same vector file byte for byte.
`test/conformance.test.js` runs the human/JSON parity fixtures in
`docs/conformance/fixtures.json` against the real CLI: every member a fixture
marks required must appear in the command's text output, every member it marks
JSON-only must not, and the commands declared JSON-only or text-only must stay
that way. Adding a line to a human renderer that surfaces a JSON-only member,
or removing one that surfaces a required member, fails the suite; update the
fixture file in the same commit.
The standalone cherry-pick fixtures in `test/integration.test.js` use stock
Git commits without Change-Id trailers to pin ancestry and application-backed
no-ops, byte-preserved index/worktree state, explicit repeats and forks, and
refusal to infer coverage from unrelated branches, invalid records, or patch
similarity. Application-evidence cases include unknown schemas/relations,
missing or wrong-type objects, mismatched attachments and identities, and forks.
`test/hostile-input.test.js` drives malformed notes, envelopes, tracked
manifests, identifiers, and object expressions through the real CLI and holds
each to one property: a non-zero exit, a `cst:` domain diagnostic rather than
a leaked JavaScript runtime error, and **no ref moved**. The runtime-error
check matters because the error boundary prints any failure as `cst: <message>`,
so an exit code alone cannot tell a refusal from a crash.
`test/failure-boundary.test.js` interrupts the mutating paths of both
reconciliation and causal rebase at named fault points with `CAUSET_TEST_FAULT`
and asserts what survives: the journal is always recoverable, no record is
ever duplicated, `--continue` refuses rather than republishing, and an abort
restores the head — or, for a rebase, the branch ref that had already moved —
leaving no *effective* coverage even when records were already published. It
covers three stretches. **Publication**, where shared records reach the notes
ref. **The journal advance**, the one point where Git is knowingly ahead of the
journal: the pick is committed before the journal records it, so an
interruption there leaves a journal that under-reports, which is the safe
direction and is pinned as such. **Abort cleanup**, where the history has been
restored but the journal has not yet been cleared, so abort must be idempotent
or the operation could neither continue nor be abandoned. The same file also
covers out-of-band Git: a `cherry-pick --continue`, `--skip`, or `--abort`
driven behind causet's back during a paused operation must leave the resume
refusing, publishing nothing, and still recoverable through causet's own abort.
The same file proves the notes lock closes the publication race:
`CAUSET_TEST_GATE=notes:after-read` parks one publisher between reading a
commit's note container and writing it back (the gated process creates
`<CAUSET_TEST_GATE_FILE>.reached` on arrival and proceeds once
`<CAUSET_TEST_GATE_FILE>` exists), a second publisher must wait rather than
complete, and both records are present afterwards; with the lock removed the
same test shows the second record lost. A lock left by a process that is gone,
or a minute-old lock from a host that cannot be checked, is abandoned, while a
lock a running process holds makes the next publisher wait and then refuse
with `notes-locked`.

Attributed-commit lock refusal also pins HEAD, raw index bytes, worktree content,
and existing notes. Retrying after release must create one commit and one
provenance record. Additional fixtures cover `CAUSET_AGENT` and `--all` from a linked
worktree, an unborn HEAD, undeclared commits bypassing a held notes lock, and a
Git hook requiring that the lock already be held. A failing hook must release
the lock. A separate Git notes-ref lock forces failure after commit creation:
the diagnostic must name the retained commit, and the documented repair must
attach its declaration without moving HEAD or duplicating existing provenance.

Workspace registry concurrency uses `workspaces:after-read` to hold one
writer's snapshot and `workspaces:lock-contended` to prove another process
attempted acquisition before the first was released. Two creates from
different linked worktrees must retain both descriptors and ordinary Git
worktrees; overlapping move/archive operations must retain both updates.
All six registry writers are also refused under a held lock without changing
registry bytes, refs, or worktree administration, while listing and prune
previews remain available. The `workspaces:after-read` fault leaves a real
interrupted holder for explicit recovery. Old foreign and malformed claims
are never stolen, release preserves a replacement token, and failed create
and restore materialization retain the old registry and partial Git work.

The lifecycle/journal regressions interrupt clean reconciliation and rebase
publication and force clean forecast-result mismatches. Archive must refuse while
preserving journal bytes, registry bytes, refs, HEAD, and worktree status; abort
must still restore the original head, after which archive/restore succeeds.
Move and repair must preserve both families' journals and abort behavior. Missing
worktree journals must survive applying prune and remain recoverable after repair;
prune previews stay available. The repository-wide guard also covers unregistered
missing and live worktrees. Malformed, null, and unknown-version journals refuse
by presence, while a caller's journal does not block archiving a different target.

`test/notes-session.test.js` compares the Rust engine's notes listings, through
its probe, directly with Git for
SHA-1 and SHA-256, mixed flat and deepest legal fanout trees, executable notes,
uppercase hexadecimal paths, opaque entries, moved refs, and duplicate
attachments. It checks complete fallback on session failures and traversal
budgets, and proves that a listing plus its note blobs uses one Git process.
`test/tree-modes.test.js` holds both Git-side tree readers to Git's rule for
entry modes on trees written literally. Overlong and zero-padded modes answer
without a `git notes` process or a recorded fallback, since a fallback would also
give Git's answer; signed and non-octal modes are still refused and answered by
Git. The same suite holds the note writer to that rule (#370): a note or fan-out
directory with such a mode stays listed or takes the new note, an entry at the
attachment path that Git does not read as a note is refused and left in place,
and a mode Git refuses stops the writer with the notes where they were. It also
holds the writer to Git's reading of a note path's hex in either case (#381): a
note under an uppercase or mixed-case path, or in an uppercase fan-out
directory, takes the new record and stays one note; a commit noted under two
spellings keeps both notes' text in that one note, as a `legacy-note` record;
a fan-out directory a spelling leaves keeps its other notes, and one spelled in
uppercase is never renamed onto an entry of its lowercase name; and a directory
at an uppercase spelling of the attachment path stays beside the new note.

`test/integration.test.js` also pins the object session's response-buffer bound. Overflowing
the real 64 MiB content buffer needs a blob of roughly 48 MiB, far too large to
build on every suite run, so `CAUSET_TEST_SESSION_BUFFER_BYTES` shrinks the
buffer to meet a small fixture. What is asserted is not the threshold but the
behaviour at it: an overflowing response is replaced by a `response-too-large`
envelope, the session is disabled for the rest of the invocation — hence
exactly one fallback per command, not one per request — and the read falls
through to an ordinary Git process. **The answer must be byte-identical across
all three transports**, session, fallback, and no session at all, because a
fallback that returned different data would be worse than one that failed. The
override is inert unless it parses as a positive integer, which is itself
asserted, since it shrinks a safety bound.
Two more test-only switches in the Rust engine force the fallback paths without
a broken Git. `CAUSET_TEST_GIT_SESSION_FAILURE=1` makes the object session spawn a
nonexistent Git command, so its process fails to start and the command completes
through ordinary processes; the suite asserts that the plan is identical and
that the trace announces the fallback. `CAUSET_TEST_MERGE_TREE_SESSION_FAILURE=1`
does the same to the merge-tree session, so a forecast records one merge-tree
fallback and reruns the whole queue in the worktree simulator with identical
trees. `CAUSET_TEST_MERGE_TREE_GIT_VERSION=<version>` makes the merge-tree
session report that Git version instead of the one its trace2 event names,
which is how the `git-too-old` fallback is exercised on a host whose Git is new
enough. `CAUSET_TEST_SCALE_FIXTURE=<directory>` makes `cst metadata benchmark`
build its fixture in that directory, answer with the fixture's description, and
leave it there instead of measuring, which is how `scripts/perf-checkpoint.mjs`
gets its scale fixture. Like `CAUSET_TEST_FAULT` and `CAUSET_TEST_GATE`, each is
inert unless it is set exactly.
`CAUSET_TEST_IMPORT_REPORT=<file>`, inert when unset or empty, makes a
successful `cst import` write what it cost to that file as JSON, which is how
the real-repository check reports each import's cost (#347):

- `seconds`, and `phases`: for each phase in order, its `seconds` and the
  process's `peakMemory` as it ended. The phases are:
  - `source`: opening the source and checking its refs;
  - `open`: opening or creating the store, and asking Git which history it
    holds already;
  - `reach` and `walk`;
  - `content`: writing the blobs;
  - `metadata`: encoding trees, commits and tags into the held file;
  - `finish`: writing the held records into the container in path order,
    then the snapshot, the alias file and the index, and putting the store
    in place.
- `peakMemory`: the process's peak in bytes. It and each phase's figure are
  `null` off Linux.
- `heldMetadata`: the held metadata file's peak size in bytes.
- `heldObjects`: the peak size in bytes of the file holding the Git bytes of
  the commits, tags and trees import read, until it stored them
  (`import.objects`, #405).

`CAUSET_TEST_IMPORT_WITHOUT_HISTORY=1`, inert unless it is set exactly, makes
`cst import` write no native history: no native commit, and no later N2
object either. The store holds N1's objects alone, which is what the
real-repository check gates (#437).

`test/error-envelope.test.js` covers the failure contract (ADR-0021). Two of
its checks are **static**: they scan the Rust CLI, engine and model for every
`GitError::new` and front-end failure, and fail if one names a code outside
`ERROR_CODES` or forwards anything but a code it was handed, and fail in the
other direction if a published code is raised nowhere. That is deliberate. The
property worth guaranteeing is "every raise site is classified", and no amount
of exercising the CLI proves anything about the sites no test reaches — there
are nearly 300 of them, and the suite reaches a fraction. A third check keeps
`docs/schemas/errors.md` and the runtime map in agreement, the same relation
`docs/schemas/` and the Rust model hold for record families (until #243 the
scan read `src/`).

The behavioural checks pin what changed for callers: a `--json` failure is an
envelope on stdout with stderr empty, the human path's prose and every exit
code are unchanged, and the ADR-0020 refusals report the code that names their
disposition rather than requiring a caller to match English. One test pins the
boundary: a global flag consumed before the argument parse keeps prose, because
no output mode is known yet, while an unknown command is enveloped.

`test/target-overlay.test.js` covers target-checkpoint forecasts
([ADR-0028](adr/0028-define-target-checkpoint-forecast-semantics.md)) on both the
reconciliation and the causal-rebase path. Two of its twenty cases carry the
contract's central claim, that an overlay is context rather than a draft commit:
one compares an overlaid forecast with a bare one and
requires the plan, the fingerprint, and the committed predicted tree to be
identical, and one requires the draft identity to appear in no plan entry and no
receipt. If either fails, an overlay has become a causal fact, which is the thing
the ADR exists to prevent.

The suite is also where the second predicted tree earns its place. A checkpoint
captures the *whole* worktree at its base, so re-materializing by writing that
tree back would restore the pre-application version of every path the application
touched — and during development it did exactly that, caught immediately by the
prediction check rather than by a reader noticing lost work later. The test that
applies an overlay asserts both trees: the committed history is what a
committed-heads application would produce, and the worktree afterwards holds the
draft, untracked file included.

Reaching an abortable state with an overlay needs the repository's own fault
injection. Without an approved overlay a dirty worktree is refused as it always
was, so the only way in is a complete forecast — which would otherwise finish.
`reconcile:before-journal-advance` stops it with a pick committed and the overlay
still reduced away; `before-publish` would be too late, because the contract puts
the overlay back before publishing. The last case deletes the checkpoint and
garbage-collects underneath a paused operation, because "the tip is restored, the
draft is reported lost, and the worktree is clean" is a promise worth testing
rather than assuming.

Five rebase cases repeat that structure against `cst rebase-forecast` and
`cst rebase`, with `rebase:before-journal-advance` as the interruption, and add
the one property a rebase has that a reconciliation does not. The scenario is
built so that all four trees differ — the source tree before the rebase, the
rewritten result, the overlay, and the re-materialized worktree — and asserts it.
That is what keeps the case honest: with equal trees `predictOverlayTree` takes
its identical-tree shortcut and the merge under test never runs. Re-materializing
by writing the checkpoint tree back was confirmed to fail this suite, refused by
the prediction check before anything was published.

Two further cases cover both applications together. The first is the human
result: `cst reconcile` and `cst rebase` must state what became of a carried
overlay, and must say nothing about overlays when there was none. An overlay is
reported and never published, so that line is the only place a reader learns the
draft is back.

The second is the recovery ADR-0028 names, and it was written because that
recovery did not work. A re-materialization mismatch leaves the merged draft in
the worktree with no pending cherry-pick, which is exactly where abort's clean
check runs — so both `cst reconcile --abort` and `cst rebase --abort` refused
with `dirty-worktree` the recovery their own refusal had just told the user to
run. Reaching that state needs the stored forecast's pinned overlay tree to be
corrupted, because every input a real mismatch could come from is refused before
the application starts. The case asserts both recoveries restore the tip and the
captured worktree, and, in the same breath, that a pending operation with a
hand-edited worktree still refuses — the clean check is skipped in one journaled
state, not weakened.

`test/rebase-ranges.test.js` covers explicit linear rebase ranges
([ADR-0032](adr/0032-generalize-causal-rebase-to-explicit-linear-ranges.md)). Its
first test is the one the rest depends on: a plan built with `--from` at the
physical merge base must equal the plan built without `--from`, fingerprint
included. If that ever diverges, the generalization has changed v1, and the issue
named v1's two safe properties — exact origin/result mappings and
unexpected-empty blocking — as non-negotiable.

The remaining cases are about what a range excludes and what it refuses. An
excluded commit must be absent from `changes`, `omitted`, and `candidates`, not
merely flagged: the suite asserts the absence rather than the flag, because a
commit that lingered in any of those could still be classified or claimed. The
three `unsupported-range` shapes each have a case, including the tip that is not a
branch tip, which is the one that would silently need re-parenting. And a forecast
approved for one range must refuse another, which works because the base is inside
the plan fingerprint rather than beside it.

One test exists only to pin what did *not* change: abort restores the exact
original tip whether or not a range was named.

`test/rebase-merge-topology.test.js` covers merge-preserving causal rebase
([ADR-0034](adr/0034-recreate-merges-as-joins-that-claim-nothing.md)). Every
case in it looks like it is about topology and is really about one sentence: a
recreated merge claims nothing. The shape is only interesting because a rewrite
that preserved it *and* let it vouch for the work beneath it would manufacture
coverage nobody re-proved, so the central case asserts the four absences
together — the join is in no `absorbedCommits`, no `absorbedChanges`, no
`applications` entry, and its `recreated-merge` relation is in no application —
beside the one presence that matters, a new identity that is not the original's.

Two cases pin the boundary the ADR drew rather than the behavior inside it. The
octopus and out-of-range refusals each assert that the refusal names its own
commit and that nothing moved, because "this repository has merges" is not
something a person can act on. One case builds a flattened history with the
*same replay queue* as a preserved one and asserts the fingerprints differ:
a merge never reaches `changes`, so without the topology in the hash an approval
for one shape would authorize the other.

The spec case is the subtle one. A pick's three-way endpoints are the change
against its parent; a join's are its two parents against their own merge base.
Asking the wrong pair plans a merge of a different thing than the one being
performed, and it fails quietly — both sides' edits would not survive. The test
asserts they do.

`test/rebase-interactive.test.js` covers declared interactive actions
([ADR-0035](adr/0035-make-interactive-rewrites-declare-what-they-do-to-identity.md)).
It is organized by the claim each action makes about identity rather than by the
mechanic each uses, because the mechanics are nearly the same and the claims are
not. Two cases carry most of the weight.

The first is the coverage downgrade, which is the only change this repository
has ever made to ADR-0004's exact-evidence list. The fixture builds the exact
shape the bare-identity rule used to call `covered` — a commit carrying an
amended identity with different content — and asserts it now lands in
`candidate-equivalent` with proof `amended-change-id`. Its twin asserts the
other half: replanning the branch that was actually landed leaves every change
`covered`, because a receipt naming a specific commit does not reason from the
name and an amendment cannot touch it. A rule that weakened both would be a
defect, not a stricter rule.

The second is the trailer. `squash` and `fixup` are asserted to leave **exactly
one** `Change-Id` on the survivor, counted on the real commit rather than read
from the receipt, because the commit is what a peer reads and Git's own
sequencer would have concatenated several. `reword` is asserted to refuse a
message that declares a different identity rather than stripping it silently —
rewording must not be a way to get a new identity by accident, and it must not
be a way to fail to get one and not be told.

The refusal case is a table, one row per shape ADR-0035 does not admit, each
asserting the refusal names the shape rather than the command.

Three later cases cover a conflicted absorption (issue #122), and their fixture
is doing deliberate work: the survivor touches a file the target never saw and
the absorbed change edits the one the target moved, so *only* the absorption
conflicts. A fixture where the survivor's own pick conflicts would pass while
testing nothing about absorption, which is exactly the shape the first draft
had. The second branch is built from the shared base rather than from the moved
target, because reuse is only reuse if the base/ours/theirs blobs — and so the
signature — actually match; branching from the target changes the base and the
test would silently prove nothing.

The abort case earns its place separately. `cherry-pick --no-commit` leaves no
`CHERRY_PICK_HEAD` and no sequencer directory when it conflicts, so the recovery
path could not see the state it was in and refused on the operation's own dirt.
That was reachable from the moment `--squash` shipped.

`test/portable-verification.test.js` covers the Git bindings a proof bundle
carries ([ADR-0031](adr/0031-carry-a-bound-source-inventory-for-portable-verification.md)).
Its fixture is the one the ADR's evidence table was measured on: a source branch
whose changes land on one of each lattice outcome, so every adversarial shape has
something real to attack. The suite is written from the forger's side — each case
mutates an honest bundle **and recomputes the bundle hash**, because a forger who
could not do that was already caught by v1, and the interesting question is what
survives a restated hash.

The property the suite establishes is that it is Git's hashes, not the tool's
prose, that catch these. Every carried object is re-hashed with `git hash-object`
in the test itself rather than through causet, so a bug in the producer and a
matching bug in the verifier cannot agree with each other. Each of ADR-0031's
adversarial shapes then has its own case, and the two the ADR did not list but the
implementation makes possible — rewriting a carried object and forging a receipt
blob — have one too. A merge inside the source range is covered because it is the
case that makes the "every parent is carried or is the base" rule necessary, and
the whole binding is run again under sha256, where object ids are a different
length and a verifier that assumed sha1 would silently accept anything.

Three tests guard the honesty of the report rather than the mechanism: a v1
bundle must still verify at the self-consistent tier and say which conclusions
that leaves unavailable; an unconfirmed anchor must lower the tier without
failing the bundle, because a remote that has not seen a branch yet is not
evidence of forgery; and `new` must stay unproven at every tier, since absence is
the one claim no bounded bundle can carry.

`test/capabilities.test.js` covers capability advertisement and negotiation
([ADR-0033](adr/0033-advertise-capabilities-as-a-document-negotiated-offline.md)).
Because negotiation is a pure function of two documents, every case is this
build's own document with exactly one part changed — a family a peer never
learned, a peer that reads only the older of two current versions, a different
canonical-JSON profile, a different lineage — so what the report says can only
have been caused by that one difference. Two properties carry the requirement.
The document is a **projection**: the suite compares it field by field with
`RECORD_FAMILIES` and `RESOURCE_BOUNDS` and asserts that no private,
shared-local, or tracked family appears, so a build cannot advertise a contract
it does not enforce or leak the existence of state a peer never receives. And
the command **changes nothing**: it is run against a repository whose Git
configuration and runtime directory are checked afterwards, because a command
that states what a build can do has no business calling `initLab`.

The negotiation cases pin the line between an exchange that is smaller and one
that is impossible. A version gap reduces or blocks one family and leaves the
rest compatible; a profile, algorithm, object-format, or lineage disagreement
refuses outright, as does a peer that reads no capability version this build
writes, because there would be no document to negotiate with. An unknown feature
token must be ignored rather than refused, since tokens are opaque by contract.
Negotiating against a real exported envelope covers the case that is easiest to
get wrong: a manifest states no families at all, and the report has to say *not
stated* rather than *unreadable*, or every exchange with an ordinary envelope
would look catastrophically incompatible.

`test/conflict-policy.test.js` covers the conflict policy of
[ADR-0030](adr/0030-define-conflict-policy-for-competing-causal-facts.md), one
test per row of its per-family table. Its fixture lands a branch with a hard
squash, so the landing receipt is the *only* thing that proves the branch's
change is covered: every case then disturbs that one receipt and reads what the
planner concludes. Two clones of that repository, with the source's copy of the
receipt altered in place, produce the envelope that carries one identifier with
two contents.

What the suite pins is that the reduction is visible and bounded. A conflicted
receipt drops the change to `candidate-equivalent`, never out of the plan and
never up the lattice, and the plan names the excluded identifier in
`quarantinedFacts` in both renderings. The default import still refuses the
whole envelope and moves no ref; `--park-conflicts` applies the rest, and the
parked blob is read back with plain `git cat-file` to prove the store is
inspectable without causet. After parking, the *local* copy stops proving
coverage too and leaves the export, which is the half of "contributes nothing on
both sides" that is easy to implement in only one direction. A disposition
returns the record to service with no code change in between, and re-importing
the same envelope afterwards reports `disposed` rather than parking a second
time. The last test is the amendment the owner made: two reconciliation receipts
on one commit, from an ordinary no-op re-run, must produce no conflict
diagnostic at all.

`test/provenance.test.js` covers declared authorship provenance (FR-ID-08).
The tests that carry the requirement are the ones that follow a declaration
through a rewrite and then check what stock Git has left: after a hard squash,
`git blame` attributes every absorbed line to the landing author and the
landing commit's author is whoever ran the landing, while the carried record
still names the actors of both absorbed commits. Cherry-pick, reconciliation,
and causal rebase are covered the same way, each asserting that the record
landed on the *new* commit and names the origin it came from. The rewrites
carry the claim exactly rather than heuristically because every application and
landing path already records which origin commits produced which result; that
recorded correspondence is the mechanism, not a diff.

Three properties guard the discipline rather than the feature. **Silence stays
silence**: an undeclared commit carries no record, because an empty one would
turn "nobody said" into a claim. **Provenance is declared, never inferred**
(FR-TRUST-04): a commit carrying an ordinary `Co-Authored-By` trailer produces
no record, since reading the ecosystem's existing agent trailer as a
`generated` role would be the most tempting available inference and is still a
guess; nor does the command fall back to the Git author, because "who committed
this" and "who produced this" are different claims. And **a carried record says
that it is carried**, never presenting itself as a fresh declaration.

The proof-verification integration fixtures rehash bundles after omitting,
duplicating, injecting, reordering, or misidentifying source changes and after
altering subjects, counts, lineage fields, and physical/effective bases. Each
must fail repository verification in both human and JSON modes. Ordinary Git
fallback IDs, receipt-advanced bases, legitimate empty ranges, offline count
and duplicate checks, and explicit offline completeness limits are covered.
The conformance fixtures also pin honest and offline verification output.

`test/object-format.test.js` runs the same workflows in a SHA-256 repository,
where every object id is 64 characters instead of 40, so any comparison that
assumed a fixed width fails. It also pins the proof bundle's sharpest
adversarial case: a bundle from an unrelated repository is intact and
internally consistent, so only the lineage comparison can catch it, and it must
be reported as `different-repository` rather than as a stale `target-moved`,
while a fork of the bundle's repository (a shared root plus a further root)
verifies and reports `lineageRelation: fork` (issue #89).
The test skips itself if the host Git cannot create a SHA-256 repository.
`test/schema-compatibility.test.js` keeps the published compatibility contract
in `docs/schemas/compatibility.md` in agreement with `RECORD_FAMILIES` and
`RESOURCE_BOUNDS` in the Rust model, through its probe, and exercises each
disposition against the real CLI: an unreadable journal, registry, or forecast
is refused without being rewritten, a note container from another build
survives a refused receipt publication byte for byte, and an oversize note is
quarantined with a diagnostic rather than failing the command. A post-commit
hook puts the foreign or oversize note on the commit `cst commit` is about to
declare provenance for, which is how the receipt writer meets it. A new record family, a new version,
or a changed bound is not complete until these checks pass.

Run the maintained demonstrations when changing their workflows:

```bash
npm run demo
npm run demo:conflict
npm run demo:resolution
npm run demo:forecast
npm run demo:spec
npm run demo:git-session
```

Use targeted Node test-name patterns during development, but complete the
ordinary, both forced-session, both forced-forecast-engine, and native-engine runs
before treating a cross-cutting, forecast, or read-path change as qualified.
`npm run demo:git-session` additionally compares the three forecast modes on
one queue, and `cst doctor --differential` compares the read engines
operation by operation in any repository.

## Benchmark regression check

`npm run test:benchmark -- --host <label>` builds a reduced scale fixture and a 12-change
forecast fixture in disposable repositories and compares their Git process
counts and medians against this host's entry in `benchmarks/baseline.json`
(ADR-0017). Since the `reduced-local-v2` profile the scale fixture has a real
working tree, so it also measures workspace creation with and without a sparse
cone and records the files and bytes each materializes; those counts are held
to the process rule, not the latency rule, because the fixture is
deterministic and any growth is a real change in what a workspace writes.

Since the `reduced-local-v3` profile it also measures the **publication loop**
(issue #15): a six-change reconciliation with declared provenance, recording
every Git process the whole `cst reconcile` invocation starts and how many
records it publishes. That is the one stretch whose work scales with the number
of changes, and until v3 nothing covered it — a per-application `git notes list`
was added there and passed the entire suite, every suite mode, and this
check. The count comes from the `CAUSET_TRACE=1` trace rather than from the
receipt, because the receipt's `timings.git` block covers the application phase
only: the receipt is built before publication runs, so it cannot report its own
publication cost. The [receipt timing contract](schemas/receipt-timings.md)
specifies the exact active-duration, wall-clock, and Git-scope boundaries,
including continuation work. Provenance is declared on the fixture so the carry path
actually runs; with none in the repository that path returns before its loop,
which is exactly how the original regression hid. Both figures are held to the
process rule, and `records` is a semantic guard: if it moves, the phase has
stopped measuring what it claims to.

Each scale phase also measures a **raw-Git floor**: the plain-Git commands a
reader would run to obtain the corresponding Git data, timed in the same process
and the same way as the phase itself (issue #42). Both sides therefore exclude Node
start-up and module load, which is what makes the ratio between them the
maintainer's stated criterion -- `cst` no worse than 110% of the equivalent
plain-Git work -- rather than an approximation of it. Each floor publishes the
commands it ran, because which commands count as "equivalent" is a judgement
rather than a fact and belongs in review. `workspaceRegistry` reports no floor:
Git has no workspace registry, and an invented denominator would be worse than
none. A floor does not reproduce causet's domain validation or registry/checkpoint
work. Native-versus-Git-engine semantic equality must be tested separately from
the latency ratio; [ADR-0027](adr/0027-bound-native-read-engine-entry-by-the-resolution-catalog-budget.md)
defines the accepted bounded rule without adding an implicit allowance.

The floors run after every phase on the same fixture, so no phase measurement
moves and the committed deterministic baseline stays comparable; the phases that
create worktrees would otherwise change what a later floor sees, so the status
floor is given the worktree set its phase actually measured.

The ratio is **reported, not enforced**. The 110% criterion was never ratified
(ADR-0043 stopped the performance program for Git-backed repositories, and
issue #42 closed on 2026-11-06) and several phases exceed it today, so `compare()` is unchanged and
no run fails on a ratio. The report exists so the decision has numbers.

A process count above the baseline, a median above twice the
baseline (or the baseline plus 5 ms, whichever is larger), or a forecast whose
modes disagree fails the check. A forecast mode the host cannot run
(merge-tree below Git 2.49) is reported as skipped.

Latency selection uses an explicit, stable operator-assigned machine label:
`--host <label>` takes precedence over `CAUSET_BENCHMARK_HOST`. Labels use 1–64
lowercase ASCII letters, digits, dots, underscores, or hyphens, starting with a
letter or digit. Choose a public-safe label such as `lab-linux-a`, retain it
across toolchain upgrades, and use a different label for a different machine.
The recorder never derives a label from the hostname or a private machine ID.
Recording requires a label and refuses before measurement if it is missing.

Schema v3 stores identified entries in `hosts`. Each entry includes its label,
platform, architecture, CPU models, logical CPU count, memory capacity, OS
release, and `CAUSET_ENGINE`, `CAUSET_GIT_SESSION`, and `CAUSET_FORECAST_ENGINE`
overrides in `host`, alongside `recordedAt`, `git`, and `node`. Hardware and
overrides must match for latency comparison; OS, Git, and Node versions remain
provenance for interpreting upgrades rather than creating new identities.
A reused label with different hardware or settings skips latency until an
intentional re-record. Review provenance before committing an entry.

The previous Linux and Windows entries are preserved unchanged in `legacyHosts`;
their original machines cannot be identified from the old data. Those entries
never supply latency limits.

On an unknown or unselected host, deterministic process, record, and
materialization counts still compare, because those are properties of the code
rather than of the machine. The reference is the most recently recorded
identified entry for the same platform, and only a `legacyHosts` entry when no
identified entry shares it. That order matters: a `legacyHosts` entry is frozen
at whatever the code did when it was captured and is never refreshed, so a later
deliberate change makes it report a regression that is not one — on Windows it
recorded 41 publication processes against a current ~139, and every unidentified
run failed on it ([issue #100](https://github.com/jwh3times/causet/issues/100)).
An identified entry moves with the code, because every re-record commits its
reason. Either way latency stays skipped, since latency cannot travel between
machines. Both paths require that no benchmark overrides are set.

Forecast semantic equality checks always run. With no compatible reference, all
baseline comparisons are skipped.
Human output explains the scope; JSON reports `latencySkipped` and `reference`,
and skipped latency findings have no baseline or limit. `passed: true` on a
deterministic-only check is what release gate 10 asks for. It says nothing
about latency on any machine.

The baseline is the one committed measurement artifact, permitted because the
check consumes it. Reading v2 data migrates its shape in memory only; recording
preserves those historical measurements and every other identified entry.
Unsupported schemas or changed profiles/tolerances require an explicit migration;
recording never silently discards old measurements or relaxes the limits.
An interrupted run removes its `causet-benchmark-check-*` fixtures on SIGINT.
Record or refresh an identified host deliberately on a quiet machine in a clean
checkout, review the diff, and commit it with the reason the numbers changed:

```bash
npm run benchmark:record -- --host lab-linux-a
npm run test:benchmark -- --host lab-linux-a
```

The baseline holds two kinds of identified entry:

- **`github-<runner label>`** (`github-ubuntu-latest`, `github-windows-latest`),
  recorded on a GitHub-hosted runner by `.github/workflows/release-gates.yml`.
  Release gate 10 compares deterministic counts with these. Their latency
  figures are never used: nothing selects such a host by label.
  - To refresh one after a reviewed change, delete its entry in a pull
    request. The workflow then records a new one on that runner and uploads
    `benchmarks/baseline.json` as an artifact; review the diff and commit it
    with the reason the counts changed.
- **A machine someone owns,** such as `hosts.lab-windows-a`
  ([issue #22](https://github.com/jwh3times/causet/issues/22)). Its latency
  limits apply only to matching hardware and settings, and only when that
  label is passed. This is evidence for performance work, not a release gate.

Real-repository evidence now comes from the native corpora, which
`corpora.yml` runs on hosted Linux and Windows runners. Budget ratification
for Git-backed repositories stopped with ADR-0043, and
[issue #42](https://github.com/jwh3times/causet/issues/42) closed on
2026-11-06.

## Release gate

**Every gate runs on GitHub-hosted runners, against the release commit.**
Nothing that can only run on a maintainer's own machine gates a release (owner
decision, 2026-10-09): a gate has to be something anyone can re-run and audit
from the repository. The gate decides which version becomes the stable
release: every landing is already a version (ADR-0048, "Releases" below), and
`promote.yml` makes one of them stable only after running the whole list
against that version's tag. It calls three workflows, and a routine PR or
`main` run does not stand in for them:

| Workflow `promote.yml` calls | Gates |
| --- | --- |
| `ci.yml`, with the full dispatch matrix | 1, 2, 3, 6, 7, 8 |
| `release-gates.yml` | 4, 5, 10, and 11 through `corpora.yml` |
| `release.yml`, building and installing the version's set without publishing | 8 and 9 |

A version is eligible to become the stable release only when:

1. every run below is on the version's tag, checked out clean by the runner;
2. every file in the checkout is text Git will diff — no file contains a NUL
   byte and none is hidden from review by a `binary` attribute;
3. the integration suite passes in ordinary, session-on, session-off, both
   forced forecast-engine, and native read-engine modes, on a Windows and a
   Linux runner;
4. all maintained demos complete, against the `cst` being released, on both
   runners;
5. `cst metadata validate` of this repository, with its causal refs fetched,
   reports no errors;
6. expected-failure cases leave protected refs and worktrees unchanged;
7. no causet Node or Git process remains after completion;
8. the tag, the executable's `--version`, the package metadata and the
   changelog's section for the version agree;
9. both ways of installing work outside the source checkout: the package set
   of ADR-0038 and the install scripts each install on a Windows and a Linux
   runner, and the installed `cst` runs with Node absent from `PATH`;
10. the deterministic benchmark check passes on both runners:
    `npm run test:benchmark`, with no host named, against the committed
    `github-<runner>` baseline entry. It compares process, record and
    materialization counts, which are properties of the code, and the
    forecast engines' semantic equality; and
11. the generated-history corpus passes every N1 check on both runners: 1,000
    histories of the seed `causet-n1` (ADR-0044 item 7, #308); and so do the
    real repositories, causet, git/git and the large-file corpus, each also
    with zero Git processes in native reads and within the storage gate
    (#309).

**Latency is evidence, not a gate.** Absolute timings cannot travel between
machines and a shared runner cannot measure them, so no gate depends on them.
`npm run test:benchmark -- --host <label>` on a quiet, identified machine still
compares latency with that machine's entry, and a regression there is worth an
issue. It no longer blocks a release, and
[issue #68](https://github.com/jwh3times/causet/issues/68)'s Windows-only
latency qualification is superseded as a gate. The separate multi-host workload
evidence and budget ratification that
[issue #42](https://github.com/jwh3times/causet/issues/42) held were investment
gates, not release gates; ADR-0043 stopped them for Git-backed repositories,
and #42 closed on 2026-11-06.

Item 2 is enforced by `test/repository-hygiene.test.js`, so item 3 already
covers it; it is named separately because it is a property of the checkout
rather than of the tool, and because nothing else in this list can see it. A
NUL byte inside a JavaScript string literal is valid JavaScript and harmless at
run time: `node --check`, the whole suite in every mode, the demos, and the
benchmark all pass. What it destroys is review — Git classifies the file as
binary, so it has no diff, no blame, and no `git grep` from the moment it
lands. One was shipped that way, and this is the control that was missing.

The scan covers untracked files as well as tracked ones, so a new file is
checked before its first commit rather than one commit afterwards.

New schemas, migration behavior, replay algorithms, or performance decisions
require focused disposable-repository coverage in addition to this general
gate. Release qualification does not establish production readiness, security
review, service-level objectives, or broad platform performance.

## Repository rules

`jwh3times/causet` carries three rulesets and one merge setting, set on
2026-10-09 (a fourth was removed on 2026-11-12, below). They live in the repository's settings, not in the tree, so this
is the record of what they are and why:

| Ruleset | Applies to | Rule | Bypass |
| --- | --- | --- | --- |
| main: history is never rewritten or deleted | `main` | No force push, no deletion | None |
| main: changes arrive by pull request with static checks | `main` | A pull request, and a passing `static checks` job | Repository admins |
| release tags are immutable | `v*` tags | No deletion, no update | None |

- **Admins bypass the pull-request rule because of how this project lands.**
  `cst merge --compact` makes a new two-parent landing commit locally and
  pushes it to `main`. No CI run has seen that commit, so a rule without the
  bypass would reject every landing. Its tree is checked against the reviewed
  branch's before the push instead (see the landing procedure on the wiki).
- **Only `static checks` is required.** The suite jobs do not run for a
  documentation-only pull request, and a required check that never runs
  blocks forever.
- **Linear history is not required:** a compact landing is a merge commit.
- **Who may create a release tag is not restricted** (ADR-0048, #441). A
  fourth ruleset, "release tags are created by maintainers", let only
  admins create a `v*` tag, because a pushed tag started a publish. Since
  #440 a pushed tag starts nothing: `release.yml` tags each landing itself,
  with the workflow's token, and GitHub does not accept the GitHub Actions
  integration as a bypass actor on a repository a personal account owns. The
  ruleset was removed on 2026-11-12; the owner is the only collaborator.
  Every tag, the workflow's included, is still immutable.
- **A release tag cannot be moved or deleted, by anyone.** To correct a tag
  placed on the wrong commit before anything was published, an admin
  disables "release tags are immutable" in the repository settings, fixes the
  tag, and enables it again.
- **Squash and rebase merging are turned off.** Either, from the GitHub UI,
  would put a commit on `main` with no landing receipt and no carried
  provenance. Merge commits stay enabled because GitHub requires one method.
- **The causal refs are not covered.** Rulesets apply to branches and tags
  only, so `refs/notes/causet` and `refs/causet/retention` rely on being
  pushed fast-forward, never forced, and no later than the commits they
  describe. `cst push` does exactly that (ADR-0040): it pushes them in one
  atomic push, merging the remote's first when it has moved, and only then
  pushes the branch or `main` (#269). This repository pushes every work
  branch and every landing with `cst push` and reconciles with `cst fetch`;
  the landing procedure on the wiki has the commands.

To read them: `gh api repos/jwh3times/causet/rulesets`, and
`gh api repos/jwh3times/causet/rules/branches/main` for what applies to
`main`.

## Release packaging

`scripts/pack-release.mjs` assembles what a release publishes (ADR-0038): one
package per platform holding a prebuilt `cst`, and the main package whose
`cst` command is that executable. It publishes nothing.

```bash
node scripts/build-native.mjs
node scripts/pack-release.mjs --out dist --executable linux-x64-gnu=native/target/release/cst
```

The main package it writes differs from this checkout's `package.json` in
`bin`, `scripts.preinstall` and `optionalDependencies`, and adds
`bin/native/checksums.json`. The checkout's own manifest names no command (#243):
a release is what this script packs, never a plain `npm pack` of the
checkout.

How the installed command reaches the executable:

- **With install scripts,** `bin/native/preinstall.js` copies the platform
  package's executable over `bin/native/cst.exe` before npm links the command,
  so `cst` is the executable and no Node process starts.
- **Without them,** `bin/native/cst.exe` stays the Node launcher. It runs the
  executable itself, and `cst doctor` reports `"launcher": "node"`.
- **npm 12 runs no install script unless told to.** `npm install -g
  --allow-scripts=@holland-vip/causet @holland-vip/causet` allows this one.
  Without the flag the install succeeds and `cst` starts through Node.
- **A mismatch is refused.** The launcher and the copy both check the
  executable's SHA-256 against `checksums.json` and its `--version` against
  the main package's version.
- **Without a platform package,** or on a platform with none published, the
  launcher says what is missing and where `cst` is published, and exits 1; the
  install itself succeeds. There is no JavaScript CLI to fall back to since
  #243. The main package carries only `bin/native/`.

`test/release-packaging.test.js` packs this host's set from the workspace's
release build, installs it globally under a scratch prefix in each of those
ways, and runs the release gate's smoke sequence through the installed
command with only Git on `PATH`. With `CAUSET_RELEASE_SET=<directory>` it
installs tarballs already packed there instead.

The primary way to install is not npm but an install script over the same
release's assets (ADR-0038, amendment of 2026-10-08): `scripts/install.sh`
and `scripts/install.ps1`. Each reads `SHA256SUMS`, picks the host's archive,
refuses one whose digest is not the listed one, checks that the executable
reports the release's version, and copies `cst` into a user-writable prefix,
removing a `vlab` alias an install before v0.23.0 left there (only one that
points at `cst`). `--from <directory>` points a script at assets on disk
instead of a release URL, which is how `test/install-script.test.js` runs it:
with the script's own tools and Git on `PATH` and no Node.js, followed by the
same smoke sequence through the installed executable
(`test-support/installed-smoke.js`).

`.github/workflows/release.yml` builds the executable on a Windows and a Linux
runner, packs the npm set, adds the two install scripts to the assets and to
`SHA256SUMS`, and runs both tests against that set on each runner, with
`CAUSET_RELEASE_VERSION` naming the version the set was built for. Every job
first writes that version into `package.json` and `package-lock.json`
(`npm version <v> --no-git-tag-version`), because the executable takes its
version from the manifest when it is built and `main`'s manifest names only
the release line. A pull request that touches the packaging and a manual
dispatch build the version the merge would mint and stop there; so does
`promote.yml`'s call, on the tag it promotes. A landing also tags the
commit, attests the archives and the scripts
(`gh attestation verify <file> --repo jwh3times/causet`), publishes a GitHub
prerelease with them, the npm tarballs and `SHA256SUMS`, and publishes to npm
under the `next` dist-tag through trusted publishing when the repository
variable `NPM_PUBLISH` is `true` ("Releases" below). Each package's first
publish was manual, from a run's artifacts (#139).

## Releases

Every landing on `main` is a version, and one dispatch makes a version the
stable release (ADR-0048, #440).

**A landing releases itself.** `docs/agents/releases.md` sets
`Scheme: per-merge`: `ship` writes each branch's changelog as a dated
`## [x.y.z]` section for the version its landing will mint, which
`node scripts/next-version.mjs` computes, and `ci.yml`'s `changelog` job fails
a pull request whose newest section names another. When `ci.yml` passes on
the push of a landing to `main`, `release.yml`:

1. reads the version from the landing's newest changelog section
   (`node scripts/release-plan.mjs landing`), refusing one off the release
   line `package.json` declares. A landing with no section of its own (a
   Dependabot pull request's, or one whose number another landing took
   first) gets the next version instead, and the next pull request's
   `changelog` job then requires a section for it (`Skipped tags: backfill`);
2. builds and installs that version's set on both runners;
3. only then tags the landing `v<version>`, attests the assets, and
   publishes a GitHub prerelease whose notes are the changelog section;
4. publishes every npm package under `next`, or under `superseded` when a
   newer landing's build is already `next`, decided just before each
   publish. Two releases publishing in the same seconds can still leave
   `next` on the older build until the next landing moves it.

`npm install @holland-vip/causet` and the install scripts' default keep
installing the stable release; `npm install @holland-vip/causet@next` and
`install.sh --version <x.y.z>` reach any landing's build.

**Making a version stable** is one dispatch:

```sh
gh workflow run promote.yml -f version=<x.y.z>
```

`promote.yml` refuses a version with no tag, no published GitHub release or
no npm package, and one older than the stable release unless
`-f allow-older=true` (a rollback); the stable release itself is a no-op. It
then runs the whole release gate against the tag ("Release gate" above),
which takes as long as the corpora do. Only when every gate passed does it
move npm's `latest` for every package and make the GitHub release the latest
one. A failed gate changes nothing public: fix forward, and promote a later
version.

**Starting a release line.** `package.json`'s major and minor on `main` are
the release line and its build is the floor; landings advance the build. A
branch that adds capability or breaks a contract moves the line through
`ship`, with the owner's approval (`Ask before bumping: always`), and its
landing releases `x.y.0`.

**When a landing is not released:**

- **`main`'s CI failed.** Nothing runs. A flaky failure is re-run, and the
  release follows the passing run. A real one is fixed forward: the fix's
  landing takes the next number, and the failed landing's section names a
  version that was never released.
- **The release run failed after CI passed.** Re-run its failed jobs. The tag
  is pushed only after the set installs, and every step from the tag on
  skips what an earlier attempt finished: a tag already on this landing is
  kept, an existing GitHub release gets its assets re-uploaded, and a version
  npm already has is not published again. When the tag step reports the
  version is another commit's (two landings without sections of their own
  released at once), re-run all jobs instead, which plans the landing again.
- **The plan refused the landing.** Its newest section is off the release
  line, which the `changelog` job should have caught. Correct the section in
  a new pull request; that landing releases the corrected number.

`promote.yml` calls the workflows as they are on `main`, against the tag's
code, so a gate added since the version landed applies to it too. Versions
before 0.26.0, the first a landing released, cannot be promoted: their tags
predate those workflows, and a rollback that far is `npm dist-tag add` by
hand.

**npm takes part only when the repository variable `NPM_PUBLISH` is
`true`.** Trusted publishing from this repository has failed on every tag
run since v0.23.0, on [npm/cli#9969](https://github.com/npm/cli/issues/9969)
([#139](https://github.com/jwh3times/causet/issues/139)), so until that is
fixed `NPM_PUBLISH` is `false`: a landing publishes its GitHub prerelease
only, `promote.yml` judges a version and makes it stable by its GitHub
release alone (`release-plan.mjs promote --github-only`), and npm is
published and tagged by hand. Setting `NPM_PUBLISH` to `true` turns the npm
half of both on again, with no code change.

**Publishing to npm by hand** is `scripts/publish-npm.ps1`, run after
`npm login` for the version `promote.yml` made stable:

```sh
pwsh -File scripts/publish-npm.ps1 -Version <x.y.z> -DryRun
pwsh -File scripts/publish-npm.ps1 -Version <x.y.z>
```

It downloads the version's three tarballs and `SHA256SUMS` from its GitHub
release, refuses a tarball whose digest is not the listed one and a main
package that does not pin both platform packages at the version, and then
publishes the platform packages before the main package, skipping any
version npm already has. Publishing under the default dist-tag moves
`latest`. **Never run `npm publish` in a checkout**: its `package.json` pins
no platform package and has no launcher checksums (`pack-release.mjs` adds
both), so the package it publishes installs without `cst`.
`test/publish-npm-script.test.js` runs the script with `-From` on a set
packed by `pack-release.mjs` and a stub `npm`, so it never reaches the
registry.

**What the automation needs** (one-time human steps, #440): the
"release tags are created by maintainers" ruleset is removed, so the
workflow's token can create a `v*` tag, and `NPM_PUBLISH` is `false` while
npm/cli#9969 is open. Before
`NPM_PUBLISH` goes back to `true`, the `npm-promote` environment needs an
`NPM_TOKEN` secret, a granular npm token with read and write access to the
`@holland-vip` packages, because npm's trusted publishing does not cover
moving a dist-tag; the packages' "disallow tokens" publishing setting must
let it move one.

## Continuous integration

`.github/workflows/ci.yml` keeps automatic runs bounded. The repository is
public, so its standard GitHub-hosted runner execution is free; the reduced
routine matrix still applies. Every run performs syntax, documentation-link,
agent-mirror, agent tool-neutrality, whitespace, CI-policy, and benchmark-analysis checks first. Suite jobs only
start after those checks pass.

| Trigger | Suite jobs after static checks | Purpose |
| --- | --- | --- |
| Code pull request | Default mode on Ubuntu and Windows, Node 26, and the native-kind mode beside each when native code or a suite changes | Routine behavior and both platform defaults; ADR-0044 item 7 |
| Code push to `main` | Default mode on Ubuntu, Node 26, and the native-kind mode when native code or a suite changes | Integration check without repeating the Windows matrix |
| Known documentation-only PR or main push | None | Static checks still run |
| Manual `workflow_dispatch`, or `promote.yml`'s call on a tag | All nine modes, the reftable and SHA-256 modes among them, on Ubuntu and Windows, Node 26; default and session-on on Ubuntu, Node 24, the floor | Full platform and minimum-Node qualification |

The selector in `scripts/ci-plan.mjs` compares the checked-out PR merge commit
with its base, or the pushed commit with the event's previous main commit.
Only root guides, Markdown under `docs/`, and Markdown agent skills qualify as
documentation-only. Schemas, conformance fixtures, scripts, tests, workflows,
and unknown paths still run suites. Renames consider both paths; a missing
comparison commit or empty diff conservatively runs the routine suites. The
native-kind mode runs for anything under `native/`, and under `test/` and
`test-support/`, because the suites and their harness decide which
repositories it imports; an unknown change set counts too.
`.github/workflows/corpora.yml` runs the heavy corpora of ADR-0044 item 7,
the generated-history corpus and the real repositories, on Ubuntu and
Windows: weekly on `main`, on manual dispatch, from `release-gates.yml` when a
version is promoted to stable, and for a pull request that changes a corpus, the
workflow, or the native import, store or history crates, since only the
corpora measure what a store holds (#437).
Its jobs have a 90-minute timeout, about twice the slowest run
measured, except git/git's, which has 300 minutes.
`.github/workflows/rotating-corpus.yml` runs the generated-history corpus on
the ISO week's seed every Thursday and on manual dispatch, with the same
build and timeout. It gates nothing. Its only write is a `needs-triage` issue
per failing seed, or a comment on that issue (reopening it if closed), from
its last job, which is the only job given `issues: write`. See "The generated-history corpus".
`ci.yml` has no automatic full-matrix schedule. Superseded runs cancel within
the same event and ref, except a push to `main`: each landing's run is what
releases it, so each push to `main` has a group of its own. Manual
qualification is independent of automatic runs.
For a pull request, a `changelog` job runs `node scripts/check-changelog.mjs`:
the newest `## [x.y.z]` section must name the version the merge will mint,
and every released version must have a section ("Releases"). Dependabot's
pull requests are exempt, since a bot writes no entry; the next human pull
request backfills their sections.
Static jobs have a five-minute timeout and suites a 50-minute timeout.

`promote.yml` runs full qualification on every version it makes stable. Run
it by hand before merging changes to Git
session transports, forecast engines, native read routing, platform-specific
process/filesystem behavior, or the supported Node/Git floor, unless the PR
already records equivalent checks on both platforms for the candidate. Use:

```sh
gh workflow run ci.yml --ref <candidate-branch-or-tag>
```

Record the tested SHA and results in the PR or release evidence. Local six-mode
validation remains required for cross-cutting changes, and the native-kind
mode for changes to native code. Routine defaults cover
the normal POSIX session-off and Windows session-on paths, but alternate modes
and the Node 24 floor can otherwise regress until explicit qualification. Code changes
should go through a PR; an exceptional direct main push requires equivalent
Windows evidence before pushing. A failed check is investigated before retrying.
The `static checks` job runs for every change; matrix checks are conditional,
so do not require every full-matrix job for ordinary PRs in branch protection.

Each suite job fails unless exactly one test self-skipped — the too-old-Git
case, which is covered with a spoofed version — so unsupported runner
capabilities cannot silently pass. Linux jobs also fail if an object-session
(`cat-file --batch`) or merge-tree-session (`merge-tree --stdin`) process
survives the suite (release-gate item 7).

The workflow does not run `npm run test:benchmark`: its baseline is per-host.
The ordinary suite's repository-scale benchmark checks report consistency,
process counts, privacy, and cleanup without assuming shared runners meet a
latency budget. Controlled analysis tests cover below/at/above-budget decisions
and process-amplification precedence. Demos, metadata validation, and the
packed-install smoke test stay release-time steps.

[Issue #58](https://github.com/jwh3times/causet/issues/58) records the CI
reduction, measured runner usage, publication review, and decision to make the
repository public. Job-duration estimates are not billing totals. Standard
hosted execution in this public repository is free under
[GitHub's Actions billing policy](https://docs.github.com/en/billing/concepts/product-billing/github-actions).
Recheck billing treatment before changing repository visibility or runner
classes; larger runners are charged even in public repositories.

## Evidence retention

### Performance checkpoints for the Rust CLI

`scripts/perf-checkpoint.mjs` is Part A of the performance checkpoints of the
Rust CLI program (#136, #151; ADR-0037 decision 7). It times whole `cst`
processes, including startup, per implementation, against a plain-Git floor,
on three fixtures it builds and removes itself:
- a real clone pinned to a release, its notes and its retained objects;
- the synthetic scale fixture with a populated resolution catalog;
- a deterministic template repository, of which each write sample gets a fresh
  copy.

It checks that deterministic reads print identical bytes across samples,
engines and implementations, and counts Git processes from `CAUSET_TRACE`
lines. It emits JSON evidence and a Markdown summary:

```sh
node scripts/perf-checkpoint.mjs --host lab-windows-a --checkpoint <n>   --output <new-file.json> --markdown <new-file.md> [--impl rust=<cst-executable>]
```

`.github/workflows/perf.yml` runs the same harness on GitHub-hosted Windows
and Ubuntu runners: on manual dispatch (samples and suites are inputs), weekly
on `main`, and for pull requests touching `native/`, the harness, or the
workflow. Hosted runners are shared, so absolute milliseconds are not
comparable between runs. The job contributes what survives that: byte
equality, exit status, Git process counts, and comparisons made within one
run (native against the Git engine, and each command against its Git floor;
until #243 also the Rust CLI against the JavaScript CLI). It posts the summary to the job page
and keeps the JSON as an artifact for 90 days. It fails only when the harness
cannot measure, never on a timing.

Results never gate anything. The full procedure (host preparation, Parts B and
C, validity checks, recording, and optimization issues) is the wiki's
[Performance testing](https://github.com/jwh3times/causet/wiki/Performance-testing)
page, and each checkpoint is recorded there.

### Measuring a real repository

Use `scripts/measure-real-repository.mjs` for a read-only measurement of a
real repository, as [#42](https://github.com/jwh3times/causet/issues/42) did
(closed 2026-11-06). From a checkout with
`cst` built (`npm run build:native`), run:

```sh
node scripts/measure-real-repository.mjs --repo <clean-disposable-clone> --host <stable-label> --output <new-file-outside-clone.json>
```

Clone without local object sharing (`git clone --no-local <source> <clone>`),
then fetch the source's notes and cst refs into the clone before measuring:
`git -C <clone> fetch origin 'refs/notes/causet:refs/notes/causet' 'refs/causet/retention:refs/causet/retention' 'refs/causet/resolutions/*:refs/causet/resolutions/*'`
(each ref by name: a `refs/causet/*` glob would also copy the source's
checkpoints and parked conflicts).
Use public-safe repository content for public evidence. A clone carries history
and these refs, but not the source's workspace registry, private forecasts, or
dirty files; actual workspace behavior needs separate pilot observations.

The script runs `cst receipts`, `cst resolve list` and `cst metadata status`
under the Git and native engines, with nine fresh processes per engine,
alternating order. It checks complete CLI JSON equality, retains the
whole-command raw samples, and checks that HEAD, refs, and worktree status
stayed unchanged. `git fsck` must also pass. A failed run leaves
`complete: false` in its output; preserve it when investigating. Whole-command
timing includes process start, command parsing, and JSON output. With nine
samples, the reported p95 is the maximum sample; this is not a population
estimate. Its format is `real-repository-measurement-v2`: v1, until #243, also
timed the JavaScript modules in-process and a raw-Git floor for the resolution
phase. An empty resolution catalog measures its fast path, not
populated-catalog performance.
Do not infer a metadata-validation budget from a cheaper command doing less
work. No baseline is rewritten and no representative budget is ratified by
this script. A matching host reference also does not prove the machine was
quiet; record load conditions and run the ordinary identified benchmark check
separately before claiming qualification.

The harness preserves its Git environment. Command-scope Git configuration
can cause the native backend to fall back, including configuration injected
by an agent launcher. Record that result. A separately identified controlled
run may omit inspected credential-prompt-only overrides for these local reads;
never silently discard repository-affecting configuration to obtain native
execution. Keep real-environment and controlled-profile results separate.

Retain outputs on the issue or as CI artifacts after checking paths and other
private data. Choose another output filename for another run. This measures
one host/repository snapshot; wider workload selection, user consequences,
budgets, and POSIX participation were explicit decisions on #42 and #19, both
closed on 2026-11-06. Workload evidence a native phase needs goes on that
phase's issue.

Record the tested commit, platform and tool versions, command outcome, and any
material exception in the pull request or release summary. Store raw logs and
generated repositories as CI artifacts with an explicit retention period; do
not commit timestamped result reports or machine-local temporary paths.

If a failure produces a lasting design constraint, add or supersede an ADR. If
it produces a product correction, add a regression test and changelog entry.
Git history remains the record of prior one-off qualification documents.
