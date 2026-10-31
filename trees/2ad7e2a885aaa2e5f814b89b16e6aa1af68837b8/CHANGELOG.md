# Changelog

## Unreleased

- Record the first identified-host benchmark baseline, `lab-windows-a`
  (issues #22, #52). Until now `hosts` was empty, so every latency comparison
  was skipped on every machine and release-gate item 10 could not pass
  anywhere; this host is now qualified, with 30 comparisons passing and none
  skipped. Recorded on a quiet machine at platform defaults, with hardware and
  environment provenance. Historical `legacyHosts` measurements are untouched
  and no tolerance changed.

  Four deterministic counts differ from the preserved `win32` entry, each
  explained: `publication` 41 to 42, the reconcile abort guard's one
  `git symbolic-ref` per reconciliation; `resolutionCatalog` 6 to 3 and
  `metadataStatus` 12 to 8, the object sessions above; and both worktree
  forecast modes one process lower, 63 to 62 and 24 to 23, because the
  fixture's conflicted steps no longer run the per-path resolution-catalog
  scan. No phase grew.

- Take the whole metadata inventory under one object session (issue #42). The
  inventory reads objects from four independent validators -- portable notes,
  tracked specifications, shared-local registries, and worktree-private state --
  and each batched read cost a Git process. `metadata status` and
  `metadata validate` now cost eight Git processes rather than twelve where
  object sessions are enabled, with byte-identical output. A repository with no
  metadata to read still starts no persistent process, because the session
  starts its worker on first use rather than on entry.

- Serve the retained resolution catalog from one object session instead of a
  process per batched read (issue #42). The scan made four separate batched
  object reads -- the ref peel, the note blobs, the referenced-object
  validation, and the retained-result inspection -- and each cost a process,
  which made `resolutionCatalog` the phase furthest from its plain-Git
  equivalent at three times the floor. It now costs three Git processes rather
  than six where object sessions are enabled, with identical records. The
  session opens after the ref scan, so a repository with no resolution refs
  still pays nothing, and it is re-entrant, so a reconciliation that already
  holds one reuses it.

- Measure a raw-Git floor for every repository-scale benchmark phase (issue
  #42): the plain-Git commands a reader would run for the same result, timed in
  the same process and the same way as the phase, so neither side includes Node
  start-up. Each floor publishes the commands it ran, because which commands
  count as equivalent is a judgement; `workspaceRegistry` reports none, since
  Git has no workspace registry. Floors run after every phase on the same
  fixture, so no phase measurement moves and committed baselines stay
  comparable. The check and the record path report the ratio against a stated
  110% target; it is reported, never enforced, and the comparator is unchanged.
  The floors are `rawProbe` reads, joining the doctor's process-cost probes as
  the second deliberate exemption from the read-side engine seam: measuring what
  one Git process costs is the question the seam cannot answer about itself.
  `vcs-lab.repository-scale-benchmark/v1` gains an optional nullable `floor`
  member, which is an additive change within the version.

- Require explicit machine identities for benchmark latency comparisons (issue
  #52), with hardware and environment provenance. Preserve old OS measurements
  as historical deterministic references; unknown hosts report skipped latency
  without borrowing another machine's limits. Recording requires a host label
  and preserves other entries. No measurements or tolerances were refreshed.

- Suppress repeated cherry-picks of ordinary Git commits (issue #50) using
  exact target ancestry and validated, reachable identity-preserving application
  records. Covered picks preserve HEAD, refs, index, worktree, and operation
  state. Forks, invalid or unreachable records, and patch similarity do not
  grant coverage; explicit `--repeat` and `--repeat --fork` remain available.

- Reduce private-repository Actions consumption (issue #58): code PRs run one
  Linux and one Windows suite, main runs Linux only, and known documentation
  changes run static checks. Retain the full platform/Node-floor matrix for
  explicit qualification, with conservative path selection and job timeouts.
  Replace benchmark tests' shared-runner latency assumptions with measured
  report consistency and deterministic budget-boundary coverage.
  Following the publication review and owner approval, make the repository
  public so standard hosted Actions execution is free; retain the reduced
  routine CI policy.

- Acquire the notes lock before creating an attributed commit (issue #24),
  holding it through provenance publication. Lock refusal preserves HEAD, staged
  and unstaged content, including `--all` and `VLAB_AGENT` declarations; commits
  without declared actors do not contend. A later note-write failure identifies
  the retained commit and points to repair guidance without rewriting history.

- Preserve unfinished reconciliation and rebase journals during workspace lifecycle
  changes (issue #48). Archive refuses even clean worktrees with either journal;
  applying prune with missing candidates refuses if any linked worktree has one,
  including unregistered worktrees. Both use `operation-in-progress` and preserve
  malformed or unsupported state. Move and repair retain journals and recovery;
  documented recovery uses status and continuation/abort before removal.

- Serialize every workspace registry writer across linked worktrees on
  `vcs-lab/workspaces.lock` (issue #47), covering the full read, Git mutation,
  and registry publication. Concurrent creates and lifecycle changes preserve
  each other's entries. Contenders wait five seconds before the additive
  `workspace-registry-locked` error; readers remain available. Abandoned locks
  require explicit recovery with all writers stopped, and a failed
  materialization preserves the registry and any partial Git work for inspection.

- Reject correctly rehashed proof bundles that omit, duplicate, inject, reorder,
  or misidentify source changes (issue #46). Repository verification independently
  checks source history, commit identities and subjects, summary counts, lineage
  fields, and physical/effective bases as well as coverage evidence. Offline
  verification rejects inconsistent counts and duplicate commits and explicitly
  states that source completeness, identities, and bases remain unchecked.
  Human and JSON reports identify failed checks; bundle v1 bytes are unchanged.

- Replace `docs/roadmap.md` with the
  [vcs-lab project board](https://github.com/users/jwh3times/projects/7), one
  issue per future increment, each carrying a `Status`, the `Gate` that must
  clear before it can start, and an `Area` (issue #25). The roadmap, the
  changelog, and the ADR amendments each narrated the same events, so every
  release had to be rewritten in three or four places and was not: the
  2026-09-02 audit found v0.11 and v0.12 work still marked "implemented,
  unreleased" or "planned". Dated progress now lives on the issue for the item
  it belongs to, and the changelog is the one dated narrative.
  - Nineteen issues (#26 through #44) carry what was Horizons 3, 4, and 5,
    each with the exit criteria, ordering constraint, and open question the
    roadmap stated for it. The eight already-open issues joined the board.
  - The roadmap's durable content moved into `docs/product.md` rather than
    onto the board: §15 gains the native-core phase sequence with its per-phase
    exit criteria and reversibility, the evidence rows that permit a next step,
    and the incomplete-requirement trace, now pointing at issues instead of
    horizons; §7 states the invariants every increment inherits; §17's open
    questions each cite the issue that will settle them. Section 15 is renamed
    "Investment themes and gates".
  - `docs/handoff.md` is deleted with it. Its three remaining items were
    already issues #14/#18, #22, and #19; the two procedures it alone carried —
    the synced-OneDrive probe recipe and what to expect from the `win32`
    baseline re-record — are now comments on #14 and #22.
  - `docs/adr/README.md` explains how to read the ADRs that locate their scope
    by horizon: their historical rationale is not rewritten, so Horizon 1.5
    reads as program phase 0a, Horizon 2 item 1 as phase 0b, and Horizon 5 as
    the phase sequence in §15.
  - `AGENTS.md` gains a "Work Tracking" section stating that GitHub is the only
    tracker, that dated progress belongs on an item's issue, and that no
    Markdown backlog, roadmap, continuation brief, or TODO file may sit beside
    it; it also names what stays in the tree, which is everything that has no
    "done". The `end-session` skill points at the board and at §15 rather than
    the roadmap, adds a check that no second tracker has reappeared in the
    tree, and tells the agent to write issue bodies to a file and pass
    `--body-file` instead of a heredoc, which mangles long Markdown.

- Propose
  [ADR-0024](docs/adr/0024-close-the-native-read-engine-program-at-phase-0b.md),
  the decision ADR-0015 left for the end of phase 0b: the native read-engine
  program stops there with a complete outcome. The committed Git-best-mode
  baseline misses the 1,000 ms interactive budget in no phase on either host,
  so ADR-0014 Gate A item 3 has no budget to name. The ADR records the
  overhead an engine would have removed (process launch, roughly 35 to 45 ms
  per Git process on Windows, about 2.5 times raw Git on the one command
  measured against it) and names the conditions that reopen it, the first
  being a measurement inside a synced OneDrive folder, which no run has made.
  The seam, the native suite mode, the schemas, and the baselines stay.
  - The roadmap, product requirements, architecture reference, README, and
    testing guide are reconciled with the changelog at the same time: work
    released in v0.11.0 and v0.12.0 was still marked "implemented,
    unreleased" or "planned", the schema and module tables lacked the
    identity-audit, proof-bundle, proof-verification, provenance, and error
    families and their modules, six commands and nine flags were undocumented
    in the README, four environment variables were documented nowhere, the
    Change-ID scope question was still open after the identity protocol
    answered it, and issue #17 was mentioned in no document.

- Serialize every writer of the causal notes ref on one lock file,
  `<common-git-dir>/vcs-lab/notes.lock`. `appendNote` read a commit's note
  container, appended, and wrote the whole blob back with `git notes add -f`,
  and `git notes add` itself builds its tree from the ref as it stood when
  the command started and updates the ref unconditionally, so two publishers
  running at once in two worktrees of one repository could each lose the
  other's record. The lock is created exclusively the way Git creates its own
  `.lock` files and costs no Git process. A lock whose holder is on this host
  and no longer running, or a minute-old lock whose holder is on another
  host, is abandoned; a lock a running process holds is waited for five
  seconds and then refused with the new code `notes-locked`, additive within
  `vcs-lab.error/v1`. The metadata import holds the same lock around its
  notes transaction. `test/failure-boundary.test.js` proves the window is
  closed with a new test-only switch, `VLAB_TEST_GATE`, which parks one
  process at a named point (`notes:after-read`) until the test releases it;
  with the lock removed the same test shows the lost record.

- Resolve a `ch_*` argument to one commit deterministically. When several
  commits carry a `Change-Id`, as after a pick or a `cherry-pick --repeat`,
  `vlab cherry-pick <change-id>` named whichever bearer `git log --all`
  listed first, so the `originCommit` its record carried, and the provenance
  carried from it, could differ between runs. The argument now names the
  change's origin, the bearer no identity-preserving application record names
  as its applied commit, and otherwise the earliest bearer by committer date,
  equal dates by commit id; the rule is stated in the identity protocol (§5)
  and pinned by tests. The read operation `findCommitByChangeId` is replaced
  by `findCommitsByChangeId`, which returns every bearer in that order; the
  catalog still has 39 operations.

- Share the suites' isolated Git environment through
  `test-support/git-environment.js` instead of a block pasted into nine
  files. It lives outside `test/` because `node --test` runs every
  JavaScript file under a directory named `test` as a test file, in Node 20
  by the directory's name and in Node 22 and later by its glob.

- Fix `vlab verify-proof` failing with a runtime `TypeError` instead of a
  refusal on a bundle whose members have the wrong shape (an
  `evidence.receipts` object rather than an array, a float in the evidence,
  a document that is an array), and reading the file with no size bound. The
  bundle's shape, including the members the published schema requires, is
  checked before any member is dereferenced and refused as
  `malformed-input`, and its size is checked against a new published bound,
  `proofBundleBytes` (16 MiB), before the file is read.
  `test/hostile-input.test.js` covers each case.

- Fix `vlab doctor` writing configuration. It initialized the lab as a side
  effect, which set `notes.displayRef` and `notes.rewriteRef` in
  `.git/config` and created `.git/vcs-lab/`. A diagnostic now reads the
  repository context and changes nothing.

- Classify three refusals under their own codes (ADR-0021):
  - a landing (`merge`, `compact-merge`, `hard-squash`) whose merge
    conflicts reports `conflict-blocked`; it threw a bare `Error`, so the
    `--json` envelope carried `code: null`;
  - the four "already exists" refusals of `workspace create`, `move`, and
    `restore` report `already-exists` instead of `not-found`;
  - a specification manifest that no longer matches its Markdown reports the
    new code `stale-manifest` instead of `stale-forecast`.

  Adding `stale-manifest` is additive within `vcs-lab.error/v1`; a caller
  that branched on the old codes for the other two refusals now sees the
  right ones.

- Read the pending cherry-pick through the engine seam. `cherryPickHead` read
  `CHERRY_PICK_HEAD` from the Git directory directly, so a native engine
  would never have been asked the question, and the reftable backend does not
  keep that ref as a file at all. It is now the cataloged read operation
  `pseudoRefTarget` (the thirty-ninth), answered by a fresh `rev-parse`
  because the sequencer creates and removes the ref within one invocation,
  and guarded against a branch that carries the pseudo-ref's name, which
  `rev-parse` would otherwise resolve when nothing is pending.
  `reconcile` and `rebase` `--continue`, `--abort`, and `--status`
  each spend one more Git process; a clean forecast's count is unchanged,
  because its cleanup no longer asks at all and simply attempts the abort
  when a run ended blocked or threw.

- Scan the resolution catalog once per conflict capture rather than once per
  conflicted path, and inspect retained results instead of reading their
  contents, since only their existence, type, and identity are checked.

- Fix the two-argument form of `recordsReachableFrom`, whose parameter
  shadowed the imported `reachableCommits` so the documented form threw.

- Show `--json` in the help text only where a handler honours it: removed
  from `workspace list`, `spec show`, and `spec benchmark`, which print
  JSON whatever the flags, and added to `workspace create`.

- Close the test-suite gaps the v0.13.1 evaluation listed.
  - Every suite file spawns Git and the CLI with `GIT_CONFIG_NOSYSTEM=1` and
    `GIT_CONFIG_GLOBAL` pointing at an empty file, so a host's global
    `commit.gpgsign`, `core.hooksPath`, or `core.autocrlf` cannot break a
    fixture; the isolation was checked against a hostile global config that
    does break an unisolated commit.
  - The CLI version test derives its expectation from `src/version.js`, and
    a hygiene test asserts that file agrees with `package.json`.
  - The forced-session suite mode is self-checking: one test asserts the
    object session was used under `VLAB_GIT_SESSION=1` and not used under
    `VLAB_GIT_SESSION=0`.
  - Behavior tests reach `vlab merge` mode selection, `cherry-pick
    --repeat`, `resolve reject`, `workspace create --owner` and `--focus`,
    `spec index --force`, a `vlab doctor` run that must leave `.git/config`
    byte-identical, the two-argument form of `recordsReachableFrom`, and
    the three refusal codes above.
  - `scripts/check-doc-links.mjs` resolves `#anchor` targets against the
    target file's headings using GitHub's slug rules.
  - `test/schema-catalog.test.js` registers its fixture cleanup at module
    scope, as `test/conformance.test.js` already explained it must.

## 0.13.2

- Record one more Git process in the benchmark's `publication` phase for the
  `linux` baseline entry (56 to 57). The reconcile abort guard above reads
  `HEAD`'s symbolic ref once when an operation starts, so the journal can
  name its branch; the object session cannot answer that read, so it is one
  process per reconciliation on either transport. The regression check
  caught it during the release gate, as ADR-0017 intends, and the count is
  re-recorded deliberately rather than avoided: a branch record is what the
  guard rests on. Only the one deterministic value changed, so the `linux`
  latency figures still describe the host that recorded them. The `win32`
  entry will report the same +1 until it is re-recorded on that host.

- Fix path checks failing when a Windows process starts inside an 8.3 alias
  of its directory. The first CI run on a GitHub Windows runner, whose
  temporary directory is `C:\Users\RUNNER~1\...`, failed 26 tests in every
  mode: `process.cwd()` kept the alias while Git reported the long form, so
  `vlab spec index` refused a specification inside the repository as
  `path-outside-repository` and workspace paths compared unequal. The
  maintainer's host has no 8.3 component in its temporary path, which is why
  the hand-run gate never saw it.
  - The CLI canonicalizes its working directory once at entry with
    `fs.realpathSync.native`, so the rest of the process shares Git's view of
    the directory. On POSIX the working directory is already physical and
    nothing changes.
  - The temporary repositories, worktrees, and corpora vlab creates itself —
    forecast worktrees, spec and scale benchmarks, envelope inspection, the
    workspace index scratch — come from one `temporaryDirectory` helper that
    returns the canonical path, since the entry-point fix cannot reach a
    directory created after entry. Eight tests stayed red on the runner until
    it did.
  - The test fixtures canonicalize their temporary directories the same way,
    so expectations built from the fixture path agree with what the CLI
    reports.

- Add a GitHub Actions workflow (`.github/workflows/ci.yml`) and a sixth
  suite mode, `VLAB_GIT_SESSION=0`. The release gate had run by hand on one
  host, and "ordinary mode" on that host is not ordinary mode on the other
  platform: the Git object session is the default on Windows and off
  elsewhere, so a Windows gate never exercised the one-process fallback that
  every POSIX user runs by default, which is how v0.13.0 shipped with two
  tests red there.
  - The workflow runs the static checks and one job per suite mode per
    platform (Ubuntu and Windows on Node 24, plus the Node 20 floor in both
    session modes), fails a suite job unless exactly one test self-skipped —
    so a runner whose Git cannot run the merge-tree engine is reported rather
    than silently green — and fails the Linux jobs if a session worker or
    `cat-file` process survives the suite (release-gate item 7).
  - The benchmark is deliberately not in it: its baseline is per-host and the
    latency rule compares against the maintainer's machines.
  - `docs/testing.md`, `AGENTS.md`, the README, and the end-session skill list
    the new mode; release-gate item 3 now names both session settings and both
    platforms, and says a green run on the release commit satisfies it.

- Fix `vlab reconcile --abort` and `--continue` acting on whichever branch is
  checked out. Abort restores the target's original tip with a hard reset of
  whatever HEAD points at, and the reconciliation journal never recorded which
  branch that was. Pause on a conflict on `main`, `git checkout -f other`, run
  the abort, and `other` was reset to `main`'s old tip with its own commits
  left only in the reflog. The rebase path has guarded against this from the
  start; the reconciliation path did not.
  - `vcs-lab.reconciliation-operation/v4` gains an optional `targetBranchRef`
    (the symbolic ref of HEAD at start, null when detached), an additive
    change inside the version under `docs/schemas/compatibility.md` §1.
    Continue and abort refuse a worktree on any other branch with
    `out-of-band-change`, and `reconcile --status` gains a `recovery` block
    naming the expected and actual branch, as the rebase status already did.
  - A journal written before the member existed cannot answer the question, so
    it is trusted only while Git's own sequencer still holds the pick the
    journal is paused on. A forced checkout removes `CHERRY_PICK_HEAD`, so that
    is exactly the shape that is refused, with the tip to restore by hand
    named in the details. An in-flight operation across the upgrade is
    therefore still abortable from its own branch.
  - Abort now also verifies that the restored head is `targetBefore` before
    clearing the journal, as the rebase abort does.

- Fix the error code for a missing revision depending on the Git transport.
  The object session path classified `vlab merge-plan no-such-ref` as
  `revision-not-resolved`; the one-process fallback let `git rev-parse` fail
  and reported `git-command-failed`. The session is the default on Windows
  only, so the same command published different codes on the two platforms,
  against the ADR-0021 contract, and `test/error-envelope.test.js` and the
  `unresolved-revision` conformance fixture failed in every session-off mode
  on POSIX from v0.13.0 on. The release gate ran where the session is on and
  could not see it.
  - `resolveRevision`, `resolveObjectIds`, `treeId`, `commitMessage`, and
    `readGitBlob` now classify the process path the way the session path does,
    carrying Git's stderr in `details`. A new test runs the failure on both
    transports and requires the same code and message.

- Accept
  [ADR-0023](docs/adr/0023-locate-the-model-substrate-mismatch-in-facts-not-content.md)
  (issue #16). The causal fact substrate is the only part a native store is
  justified in replacing; Git's content substrate stays. ADR-0001 is refined
  rather than superseded and gains an amendment saying so.
  - The finding the decision rests on: going concept by concept through the PRD
    identity model against the implementation, every distortion a native store
    would remove is on the **fact** side — a causal edge with no representation,
    facts whose identity is their attachment point, validity inherited from an
    unrelated object's reachability — and **none** on the content side. Git's
    content model additionally carries the correctness oracle every semantics
    claim rests on.
  - Performance is explicitly not the argument. It measures process creation,
    which an in-process engine addresses and a native format does not.
  - The acceptance amendment records one correction. This ADR named sub-commit
    provenance as the trigger for revisiting the content half, and proposed
    dogfooding commit-level provenance to find out. **That cannot produce the
    evidence here**: this repository has 71 commits, 67 single-parent, zero
    squash landings and zero `Change-Id` trailers, so provenance is only ever
    declared and never carried — and the carry is the part Git cannot do. The
    prerequisite is a branch-and-land workflow, not a configuration change.

## 0.13.1

- Make every text file LF in the working tree as well as in the index.
  `.gitattributes` set `text=auto`, which normalises what Git stores but leaves
  the checkout to the platform, and then pinned `eol=lf` for three extensions.
  Everything else was missed: `scripts/*.mjs` were CRLF on Windows while
  `src/*.js` were LF, `LICENSE` and `.gitattributes` itself were CRLF, and
  `.gitignore` had drifted to mixed endings.
  - The rule is now `* text=auto eol=lf`, and the per-extension lines are gone.
    They were the defect: an enumeration silently stops covering the file type
    nobody added to it, which is how `.mjs` — every script in this repository —
    ended up on the other convention from every source file.
  - No committed content changes. All 139 tracked files were already LF in the
    index, so this alters what a checkout produces, not what Git stores;
    `git add --renormalize .` stages nothing but `.gitattributes`.
  - Not cosmetic: a patch script written for one convention corrupts a file
    written in the other, which cost real time while editing the benchmark
    script during this release.

- Add `npm run demo:clean`, which removes the demonstration fixtures the
  `demo:*` scripts leave in the OS temporary directory. Each demo ends by
  printing `Inspect it with: cd <path>` and nothing ever removed them, so they
  accumulated one per demo per run — three release-gate runs leave eighteen.
  - Listing is the default and `--apply` removes, matching `vlab workspace
    prune` and `vlab metadata import`: a command that deletes directories
    should say what it would delete first. `--all` widens the sweep to any
    `vcs-lab-` fixture, which picks up what an interrupted test or benchmark
    run left behind.
  - The prefixes are **derived from the demo scripts** rather than listed,
    because a hardcoded list stops covering a demo the day someone adds one and
    fails invisibly — fixtures simply keep accumulating.
    `test/repository-hygiene.test.js` asserts the derivation still finds every
    demo, and is mutation-verified against both drift shapes: a prefix outside
    the `vcs-lab-` namespace, and one built from a variable the scan cannot
    read.

## 0.13.0

- Add a checkout-hygiene check to the suite and the release gate:
  `test/repository-hygiene.test.js` fails when any file contains a NUL byte, or
  when Git would not treat a file as text.
  - A NUL byte was shipped inside a JavaScript string literal. It is valid
    JavaScript and harmless at run time, so `node --check`, the whole suite in
    all five modes, the demos, the benchmark, and the release gate all passed.
    What it destroys is **review**: Git classifies the file as binary, so it has
    no diff, no blame, and no `git grep` from the moment it lands.
  - The scan covers untracked files as well as tracked ones, so a new file is
    checked before its first commit rather than one commit afterwards. That is
    not hypothetical — the first version of this test embedded a literal NUL in
    the regex meant to render one, and did not catch itself because it was not
    yet tracked. It builds the byte with `String.fromCharCode(0)` now.
  - A second check asks Git directly, via `git grep -I`, which catches
    something the byte scan cannot: a `binary` attribute in `.gitattributes`
    hides a file from review with no NUL in it at all.

- Measure the publication loop in the benchmark (issue #15; ADR-0017 profile
  `reduced-local-v3`). Every existing phase measured a read, and the forecast
  phases simulate without publishing, so nothing covered the one stretch whose
  work scales with the number of changes — each application publishes its own
  record, its resolutions, and the provenance carried onto it.
  - **The gap was found the expensive way.** A per-application `git notes list`
    was added there with authorship provenance and passed the entire suite, all
    five suite modes, and this very check; a six-change reconciliation went from
    15 Git processes to 21. It was caught by reading a `VLAB_TRACE=1` trace by
    hand, which is not a control.
  - The new `publication` block records the processes a whole `vlab reconcile`
    invocation starts over a fixed six-change queue, and the records it
    publishes. Both are held to the process rule, since the fixture is
    deterministic; `records` is a semantic guard rather than a performance one.
  - Counted from the trace, not the receipt, because **the receipt cannot see
    its own publication cost**: `timings.git` covers the application phase only,
    since the receipt is built before publication runs. Worth knowing on its own
    — a caller reading those metrics is not being told the whole story.
  - Provenance is declared on the fixture so the carry path actually runs. With
    none in the repository that path returns before its loop, which is exactly
    how the original regression hid.
  - Verified by mutation: restoring the per-application read takes the phase
    from 41 processes to 47 and the check reports a regression, while `records`
    stays at 19 — a cost change, not a behavioural one.
  - **The first phase whose process count differs between hosts**: 41 on
    Windows, 56 on Linux, with identical records. The publication phase runs
    each host's *default* transport, and under FR-PERF-08 Windows defaults to
    the batched object session while POSIX does not. Forcing the session on
    Linux gives exactly 41 — measured, not assumed. Measuring the default is
    deliberate: the figure worth defending is what the command costs a user on
    that host.
  - Per ADR-0017 the profile change forces a re-record on every host; both
    `win32` and `linux` are recorded.

- Give failures a versioned, machine-readable envelope
  ([ADR-0021](docs/adr/0021-give-failures-a-versioned-machine-readable-envelope.md),
  issue #12), completing the failure half of FR-GIT-06. `--json` previously had
  no effect on the failure path: JSON on success, prose on failure, and an exit
  code that is 1 for nearly everything.
  - **Behaviour change for `--json` callers.** A failing command now prints
    `vcs-lab.error/v1` on **stdout** — `{schema, code, message, details,
    exitCode}` — and leaves stderr empty. Without `--json` the stderr prose is
    byte-for-byte what it was. **No exit code changes**, in either mode: the
    classification lives in `code`, never in the exit status, so a caller that
    only checks success or failure is unaffected. A caller that parsed stderr
    prose under `--json` must read stdout instead.
  - 41 codes across 232 raise sites, published as a closed vocabulary in
    `docs/schemas/errors.md`, with `docs/schemas/error.v1.schema.json` for the
    envelope. Adding a code is additive inside `v1`; removing one, or changing
    what it means, is a version bump — the rule ADR-0020 fixed for record
    families.
  - The ADR-0020 refusals are the point: an unreadable schema version, a
    wrong-family record, and an exceeded bound each imply a different response,
    and a caller could previously only tell them apart by matching English.
    They now report `unknown-schema-version`, `wrong-record-family`, and
    `resource-bound-exceeded`.
  - Two suite checks are **static**, scanning the source rather than running
    it: a raise site with no code, or with a code outside the vocabulary, fails
    the suite, as does a published code that nothing raises. Exercising the CLI
    could never establish that about the sites no test reaches.
  - The namespace is flat, and the enumeration is what settled it: codes
    cluster by cause, and one cause spans several record families.
  - Found while implementing: a reference that does not exist was classified as
    a malformed Git response, whose published advice is to report a Git bug.
    The raise site is shared between "an expression did not resolve" and "Git
    returned an unparsable line"; only the second deserves that code.

## 0.12.0

- Record authorship provenance as a causal fact and carry it across the
  rewrites that destroy ordinary Git attribution (FR-ID-08, FR-TRUST-04;
  [ADR-0023](docs/adr/0023-locate-the-model-substrate-mismatch-in-facts-not-content.md)).
  `vlab commit` gains repeatable `--authored-by`, `--generated-by`, and
  `--reviewed-by` flags, and reads `VLAB_AGENT` so an agent harness declares
  once instead of per commit. `vlab provenance [<rev>] [--all]` reads the
  records back. The new family is `vcs-lab.provenance/v1`, published in
  `docs/schemas/` with a `provenanceActors` bound of 64.
  - **The point is what survives a squash.** After a hard squash `git blame`
    attributes every absorbed line to the landing commit and the landing
    author is whoever ran the landing, so the original attribution is gone.
    The landing receipt already names the absorbed commits, so their declared
    provenance is carried onto the landing as the union of their actors,
    marked `carried` and naming its sources. Cherry-pick, reconciliation, and
    causal rebase carry it the same way.
  - The carry is **exact rather than heuristic**: every application and landing
    path already records which origin commits produced which result, so the
    claim follows a recorded correspondence instead of a recomputed diff. The
    machinery that makes coverage provable is what makes attribution portable.
  - **Declared, never inferred.** Nothing examines content to decide who
    produced it, and no existing trailer is read as a role — mapping
    `Co-Authored-By` onto the vocabulary would be the most tempting available
    inference and is still a guess, since a co-author is not necessarily a
    machine. A commit with no declaration reports nothing rather than falling
    back to the Git author, because "who committed this" and "who produced
    this" are different claims. The record is an unauthenticated claim by
    whoever ran the command; signing it is FR-TRUST-02 and does not exist.
  - Carrying is bounded by the invocation, not by the queue (ADR-0013): one
    read of the notes ref serves a whole publication loop rather than one per
    application. A six-change reconciliation costs four notes processes per
    application, not five, and a repository that has never declared provenance
    pays one bounded read for the operation. `test/provenance.test.js` measures
    the growth rather than an absolute count and fails if the read goes back
    inside the loop.
  - Silence stays silence: nothing declared writes no record, because an empty
    one would turn "nobody said" into a claim. The role vocabulary is closed
    (`authored`, `generated`, `reviewed`) so a consumer never has to guess what
    a role meant, and the role carries the human/machine distinction rather
    than a `kind` field inferred from an actor's name.

- Pin the object session's response-buffer bound with a regression test, adding
  a test-only `VLAB_TEST_SESSION_BUFFER_BYTES` override to `src/git.js`.
  Overflowing the real 64 MiB content buffer needs a blob of roughly 48 MiB,
  far too large to build on every suite run, and the behaviour worth pinning is
  the fallback rather than the threshold. The override is inert unless it parses
  as a positive integer, which the suite asserts, since it shrinks a safety
  bound.
  - What is now guaranteed: an oversized response is replaced by a
    `response-too-large` envelope, the session is disabled, the read falls
    through to an ordinary Git process, and **the answer is byte-identical
    across the session, the fallback, and no session at all**. A fallback that
    returned different data would be worse than one that failed, because the
    plan would be wrong rather than absent.
  - The fallback disables the session for the rest of the invocation, so there
    is exactly one fallback per command rather than one per request. That was
    already true; it is now asserted rather than assumed.

- Re-record the `linux` benchmark baseline under the `reduced-local-v2`
  profile, restoring both hosts to `benchmarks/baseline.json`. The entry was
  dropped when the profile changed, per ADR-0017. Recorded in an Ubuntu 24.04
  container on Git 2.55.0 and Node v22.23.2, matching the toolchain of the
  previous Linux entry.
  - **Every process and query count matches the Windows entry exactly**, and
    the materialization figures are identical, so the platform-independent
    part of the contract holds across hosts while the wall-clock figures
    differ by 5-15x. That gap is the clearest confirmation yet that these
    commands are dominated by process-launch and filesystem cost rather than
    by anything algorithmic: identical work, identical process counts, an
    order of magnitude apart.
  - Every Linux phase is far under the profile's 1000 ms interactive budget,
    the slowest being the ordinary worktree forecast at 183 ms, so ADR-0014
    Gate A item 3 is unmet on Linux by a wider margin than on Windows.

- Complete the failure and hostile-input boundaries of roadmap Horizon 2
  item 3 with three new suites and a deterministic fault-injection hook.
  - `test/hostile-input.test.js` drives malformed notes, tampered metadata
    envelopes, unreadable tracked manifests, traversing identifiers, and
    newline-bearing object expressions through the real CLI, holding each to
    one property: a non-zero exit, a `vlab:` domain diagnostic rather than a
    leaked JavaScript runtime error, and **no ref moved**. The runtime-error
    check earns its place because the error boundary prints every failure as
    `vlab: <message>`, so an exit code alone cannot distinguish a considered
    refusal from a crash.
  - `src/faults.js` adds `VLAB_TEST_FAULT`, which turns named points on the
    mutating paths of reconciliation and causal rebase into a hard
    `process.exit`, across three stretches: publication, the journal advance,
    and abort cleanup. It is inert
    unless the variable names a point exactly, and it exits rather than throws
    on purpose: throwing would run the cleanup a real interruption never gets
    to run, and the whole question is what the repository looks like when
    cleanup did not happen.
  - `test/failure-boundary.test.js` interrupts publication at each point and
    pins what survives. The journal is always recoverable, **no record is ever
    duplicated**, and `--continue` refuses rather than replaying publication
    over records that already exist.
  - It also pins the case worth knowing about: interrupting after the receipts
    are published and then aborting restores the starting commit but leaves
    those receipts on the notes ref, attached to commits the abort made
    unreachable. They carry no weight — the plan reports the change as new and
    a proof bundle admits zero receipts as evidence — because the reachability
    rule admits only receipts reachable from the target. Inert records are
    left behind rather than collected, which is now documented rather than
    discovered.
  - Causal rebase gets the same treatment, with more at stake: the branch ref
    has already moved by the time publication starts. An abort restores it, and
    the records published before the interruption are left inert on the notes
    ref exactly as a reconciliation's are.
  - **The journal never claims more progress than Git made.** The pick is
    committed before the journal records it, so an interruption between them
    leaves a journal that under-reports. That asymmetry is the safe direction
    and is now pinned as such: a journal that over-reported would resume past a
    commit that does not exist, while one that under-reports only causes an
    abort to roll back work nobody recorded. The write is atomic, so no torn
    journal or temporary-file debris survives either.
  - **Abort is idempotent.** It restores the history before it clears the
    journal, so an abort interrupted between the two is completed by running it
    again, rather than leaving an operation that can neither be continued nor
    abandoned.
  - Out-of-band Git during a paused operation is covered for `cherry-pick
    --continue`, `--skip`, and `--abort`, on both reconciliation and rebase.
    The dangerous shape is not the abort but an out-of-band *advance*: Git
    commits the resolution itself, so the work looks finished. vlab refuses to
    certify a commit it never saw resolved, publishes nothing, and stays
    recoverable through its own abort.
  - `test/object-format.test.js` runs the workflows in a SHA-256 repository,
    where every object id is 64 characters instead of 40, so any comparison
    that assumed a fixed width fails. It skips itself if the host Git cannot
    create one.

- Fix proof-bundle verification reporting a bundle from an unrelated repository
  as a stale one. The bundle stated a repository lineage and
  `verifyAgainstRepository` never read it, so an unrelated bundle — intact, and
  internally consistent, so no other check could catch it — came back as
  `target-moved`: advice to fetch and retry, for a bundle that will never be
  about this repository. Lineage is now compared first, and a mismatch reports
  `different-repository` along with the claimed and actual lineage and object
  format. This is a diagnostic fix rather than a soundness one — verification
  never confirmed anything it should not have — but a verifier that acts on the
  wrong reason reaches the wrong conclusion about why it could not confirm the
  evidence.

- Freeze the logical identity protocol `vcs-lab.logical-id/v1` (FR-ID-07,
  roadmap Horizon 2 item 2) in `docs/identity/`, with `ID_NAMESPACES`,
  `ID_ENTROPY_BITS`, and `parseLogicalId` in `src/ids.js` as the executable
  authority. The specification covers the identifier form
  (`<namespace>_<9-character base36 clock><12 hex digits>`), the closed
  namespace set, the 48 bits of entropy, and the cross-repository import rule.
  - **Entropy is specified together with what it does not buy.** The clock
    partitions the random space rather than ordering identifiers, and must
    never be read as a timestamp for a decision. Accidental collision needs
    roughly 2^24 identifiers minted inside one millisecond; deliberate
    collision is trivial at any entropy, because a `Change-Id` is a line of
    text anyone with repository access can write. Identifiers coordinate work;
    they do not authenticate it, and `vlab audit identity` is the defence.
  - **Cross-repository import behaviour is now stated rather than implied.**
    Identifiers are globally scoped and are never rewritten on import. A
    record whose identifier already exists locally with an equal digest is a
    no-op, and one with a differing digest is a conflict that refuses the
    whole import rather than merging or picking a winner — the one situation
    no automatic rule can resolve without destroying a claim.
  - `parseLogicalId` reports the `git:<oid>` fallback of FR-ID-05 as a commit
    fallback identity rather than as malformed, keeping the minted and derived
    identity forms distinguishable.

- Add `vlab audit identity`, a repository-wide logical identity audit
  (FR-ID-06, roadmap Horizon 2 item 2), emitting
  `vcs-lab.identity-audit/v1` and exiting non-zero when it finds anything. It
  scans every commit reachable from any ref and every causal record, rather
  than one plan's reachable set: a collision a given plan cannot see is still
  a collision.
  - **Distinguishing a collision from preserved identity is the substance.**
    Commits legitimately share a `Change-Id` when a cherry-pick or rebase
    preserved it (FR-ID-02), so the audit unions commits over
    *identity-preserving* application edges only — a `contextual-fork`
    deliberately changes the identity and therefore does not link its
    endpoints. Commits sharing an ID across unlinked groups are reported, and
    the finding names the groups so the stray one is visible.
  - Also reported: a commit message carrying several different `Change-Id`
    trailers, where planning silently reads only the first; an applied commit
    claimed by application records naming different origins; a fork that kept
    its origin identity (FR-ID-03); and a non-fork application that changed
    it (FR-ID-02).

- Add portable coverage proof bundles and an independent verifier
  (FR-PLAN-08, roadmap Horizon 2 item 2). `vlab proof-bundle <source>` emits
  `vcs-lab.proof-bundle/v1`: the merge plan together with the evidence its
  classification rests on — the target's commits and change IDs, the reachable
  accepted receipts with what each absorbs, and the advisory patch-equivalent
  set — hashed under the canonical JSON profile frozen in v0.11.0. A covered
  change is now traceable to the receipt that covered it, which the plan's
  bare `proof` string could never express.
  - `vlab verify-proof <file>` re-derives every change with its own copy of
    the proof lattice and compares the result with what the bundle claims,
    then checks that evidence against the repository unless `--offline` is
    passed. It exits non-zero when the bundle does not verify.
  - The three checks establish different things and are reported separately.
    Integrity catches editing. Classification catches a doctored `status` or
    `proof` **even when the bundle hash has been restated**, because the
    verdict must follow from the stated evidence. Only the repository
    comparison catches fabricated evidence — a bundle can state receipts that
    never existed — so offline verification says exactly that rather than
    implying more than it proved.
  - The verifier deliberately does not import the planner's classification
    branch. A verifier sharing the planner's code would prove only that the
    code is self-consistent.

- Rename the `signed-shaped-landing-receipt` coverage proof to
  `receipt-commit` (roadmap Horizon 2 item 2; FR-PLAN-05). The old label
  printed the word *signed* in every plan for a record that nothing
  cryptographically signs, which is exactly the confusion the architecture's
  trust-limitation section warns against. The new name says what the evidence
  is — a reachable landing or reconciliation receipt lists the exact commit —
  and pairs with the existing `receipt-change-id`, where a receipt absorbed
  the logical ID instead.
  - This is an additive change inside each version, not a bump. Nothing in
    the tool branches on a proof value; it is carried and displayed. Plans and
    receipts written by earlier builds keep `signed-shaped-landing-receipt`,
    readers pass it through unchanged, and no record changes meaning. The
    compatibility contract gains a section recording retired values and the
    rule that retiring a value a reader *does* branch on would need a version
    bump.

- Measure workspace materialization in the benchmark, completing roadmap
  Horizon 1.5 item 3 and with it ADR-0015 program phase 0a (issue #10;
  ADR-0017 amended). The scale fixture committed the empty tree at every
  history commit, so a materialized workspace held no files and workspace
  creation could not be timed at all. The `reduced-local-v2` profile gives it
  a real working tree of ten areas of sixty 1 KiB files, adds
  `workspaceCreate` and `workspaceCreateCone` phases, and records
  `materialization` files and bytes for a full and a coned workspace. Those
  counts are compared under the process rule rather than the latency rule:
  the fixture is deterministic, so growth in what a workspace writes is a real
  change, not host noise. `vlab metadata benchmark` gains `--areas` and
  `--files-per-area`.
  - Per ADR-0017 a profile change forces every host to re-record. The `win32`
    entry is re-recorded under `vcs-lab.benchmark-baseline/v2`; the `linux`
    entry is dropped and the check reports it as skipped until it is
    re-recorded there.
  - `npm run benchmark:record` previously refused to run against a baseline
    written under an older schema, leaving a schema bump with no supported
    migration path. It now starts a fresh baseline and names the host entries
    it drops, as it already did for a profile change; a check still refuses on
    a schema mismatch.

- Add opt-in sparse-checkout cones to workspaces (issue #10, roadmap Horizon
  1.5 item 3): `vlab workspace create <name> --cone <dir,dir>` materializes
  only the named directory prefixes. Measured on the Windows host with 3000
  files across 20 directories, this took `vlab workspace create` from 1804 ms
  to 467 ms and from 3000 files to 150 — the full checkout was the first phase
  in this program measured over the benchmark profile's 1000 ms interactive
  budget, and the cone brings it back under.
  - The cone narrows the working tree and nothing else. Workspace ID,
    compatibility branch, pinned base, checkpoints, and lifecycle are
    unchanged, Git still holds the whole tree, and a checkpoint of a coned
    workspace still captures the full tree. Restore reapplies the cone so an
    archive/restore cycle does not silently write every file back, and
    `git sparse-checkout disable` reverses it in place.
  - Recorded as a new optional `cone` member on `vcs-lab.workspace/v1`.
    Adding an optional member inside a version is permitted by the
    compatibility contract; the free-text `focus` label is unchanged, since
    redefining it to carry paths would have forced a schema version bump.
- Spend two fewer Git processes on `vlab workspace create`. Resolving the base
  revision and checking the compatibility branch for a collision were a
  `rev-parse` process and a `show-ref` process; they are now one batched
  object inspection, which also rides the object session when one is open. The
  separate `git sparse-checkout init` is dropped because `set --cone`
  establishes cone mode itself. Seven Git processes become five, and a coned
  `workspace create` fell from 457 ms to 379 ms on the Windows host.

## 0.11.0

- Close the merge-tree engine's nested `.gitattributes` equivalence gap
  (issue #9; ADR-0016). The engine falls back to the worktree oracle when a
  queued change other than the last touches `.gitattributes`, because the
  remaining steps would otherwise merge under attributes it cannot see: it
  fixes `GIT_ATTR_SOURCE` to the original target tree, while the worktree
  simulator checks out the accumulated tree and reads what earlier steps
  introduced. Only the root file was detected, so a queue whose earlier step
  added `docs/.gitattributes` predicted a different tree in the two engines;
  FR-REC-06 caught it at application time, but the forecast was wrong.
  Detection now covers any `.gitattributes`, at the root or nested, and the
  `attributes-changed` fallback names the triggering `path`.
  - The paths come from `changedPaths`, a new member of each plan change in
    `vcs-lab.merge-plan/v1` and `vcs-lab.rebase-plan/v1`, read by the same
    single `git log` process that already builds the queue: `--name-only`
    plus a leading `%x00` in the format, which gives the `-z` name list the
    record boundary it otherwise lacks. No extra Git process, so every
    committed benchmark process count is unchanged. Adding an optional member
    inside a version is permitted by the compatibility contract.

- Pin human/JSON output parity with conformance fixtures (issue #11 item 5;
  ADR-0015 phase 0b), completing the phase 0b contract freeze. The new
  `docs/conformance/` names, per command, the JSON members its human rendering
  must present and the members it deliberately does not, and
  `test/conformance.test.js` runs every fixture against the real CLI in a
  disposable repository, failing in both directions: a required member that
  stops appearing in the text, and a member declared JSON-only that starts
  appearing.
  - **The commands that never had a human rendering are now named.** A command
    renders text only when its handler builds it with a formatter, so
    `commit`, the three landing commands, `cherry-pick`, both `--abort`s,
    every `workspace` subcommand except `workspace forecast`, `spec show`,
    `spec benchmark`, and `doctor` print JSON whatever the flags — `--json` is a no-op for them. The schema
    catalog previously implied the landing commands printed text without
    `--json`; that is corrected, and the whole set is enumerated in the
    conformance contract rather than left to be discovered.
  - **Four renderers no longer assert state they did not read.** The rebase
    forecast printed `scope        committed heads only` unconditionally while
    `scope` is a real member, and claimed the caller worktree was unchanged
    without consulting `callerInvariants.preserved`; the scale benchmark
    printed `service now  no` instead of
    `analysis.residentService.recommendedNow`; and the metadata status and
    transfer renderers printed a fixed trust sentence instead of reading
    `trust`. Each now reads the record, so the text cannot contradict the JSON
    beside it.
  - The rebase forecast gained the `same state` line its reconciliation
    counterpart already had, and `vlab doctor` now reports `version`: `vlab
    version` is text-only, so the build identity a peer needs to apply the
    per-family compatibility rules of ADR-0020 had no machine-readable home.
- Freeze the per-family compatibility, migration, unknown-version, and
  resource-bound contract (issue #11 item 4; ADR-0020; ADR-0015 phase 0b) in
  `docs/schemas/compatibility.md`, with `RECORD_FAMILIES` and
  `RESOURCE_BOUNDS` in `src/schemas.js` as the runtime authority and
  `test/schema-compatibility.test.js` failing the suite when the two
  disagree. One registry now states each family's written versions,
  additionally readable versions, store, and unknown-version rule, and the
  rule follows the persistence scope: an unknown shared-portable note record
  is quarantined and reported, while an unreadable worktree-private,
  shared-local, tracked, or envelope record refuses the command. Nothing that
  is quarantined or refused is ever rewritten, truncated, or deleted.
  - **Two safety fixes.** Publishing a receipt onto a commit whose note came
    from a newer vcs-lab no longer destroys that note: `git notes add -f`
    replaces the whole blob, so `vlab` now refuses to append to a container it
    cannot read and leaves it byte for byte intact. A reconciliation or rebase
    journal, and the workspace registry, were previously read and resumed
    whatever schema they declared; an unreadable version is now refused with a
    message naming the file, the versions this build reads, and how to
    recover.
  - **Resource bounds.** Every persisted family now has a published bound that
    is checked before the record is parsed: `noteContainerBytes` (8 MiB) and
    `noteContainerRecords` (4096) quarantine an oversize note with an
    `oversize-record` diagnostic instead of failing the command,
    `localStateBytes` (64 MiB) is enforced once in `readJson` for both
    journals, every stored forecast, and the workspace registry,
    `specManifestBytes` (8 MiB) covers tracked manifests, and the metadata
    envelope's previously ad-hoc limits are published as
    `envelopeManifestBytes`, `envelopeBundleBytes`, and `envelopeRecords`.
    Malformed local state is now a domain error naming the file rather than a
    bare `SyntaxError`. Growth limits that need a retention design instead of
    a constant are documented as deliberately absent.
  - `vcs-lab.forecast/v1` is now expressed as a readable version of its family
    in the registry rather than as an exception in a test allowlist, and the
    rebase-forecast reader no longer reports an unreadable version and a
    non-approving forecast with the same message.
- Freeze the canonical JSON profile `vcs-lab.canonical-json/v1` (issue #11
  item 3; ADR-0015 phase 0b): RFC 8785 restricted to
  UTF-16-code-unit-sorted members and safe integers — non-integer numbers,
  negative zero, unsafe integers, and non-JSON values are refused rather
  than approximated. The profile specification, the encoder registry, and
  the shared cross-implementation test vectors (which reserve the
  `integrity` and `signatures` members and the repository-identity lineage
  fields) live in `docs/canonical-json/`; `src/canonical-json.js` implements
  the profile and `test/canonical-json.test.js` verifies every vector. The
  repository-lineage ID and the metadata-envelope `manifestHash` now compute
  through the profile with byte-identical results, so existing lineage IDs,
  digests, and envelopes remain valid; the manifest hash additionally
  excludes the reserved `signatures` member, and an envelope manifest the
  profile cannot represent (for example one carrying non-integer numbers) is
  now refused instead of being hashed approximately. Record digests,
  record-equality comparison, and export keys keep their frozen legacy
  serialization because envelopes persist those digests.
- Publish the versioned CLI output/schema catalog in `docs/schemas/`
  (issue #11 item 2; ADR-0015 phase 0b), completing FR-GIT-06: one standalone
  JSON Schema (draft 2020-12) document per persisted and automation-facing
  record family — the note container, the seven note-record receipt families,
  the four worktree-private journals and forecasts, the shared-local
  workspace registry, the tracked spec manifests (v1–v3), the metadata
  envelope, and the thirteen schema-bearing CLI output families — plus a
  catalog README that maps every `--json` command to its output contract.
  The executable validators in `src/schemas.js` remain the runtime
  authority; the new `test/schema-catalog.test.js` fails the suite when the
  catalog and the runtime disagree: every schema identifier used in `src/`
  needs a document, records produced by the real CLI must satisfy their
  documents, and a note record the runtime validator rejects for a missing
  field must be rejected by its document too.
- Route every repository read through one engine seam, `src/engine.js`
  (ADR-0019, issue #11; ADR-0015 phase 0b and ADR-0014 Gate A item 1). The
  seam catalogs 38 read operations; `src/git.js` implements each with the
  plumbing it ran before, so process counts are unchanged, and domain
  modules no longer call `runGit` for reads. A read engine is selected with
  `VLAB_ENGINE` or `--engine <git|native>`: `git` (the default and the
  oracle) or `native`, the phase 1 core, which passes every operation
  through to Git with the reason `binding-missing` until its binding exists.
  Every Git metrics block (forecast and receipt timings, benchmarks, the
  doctor) now reports `engine`, the per-operation `fallbacks` with counts,
  and `directReads`, the number of reads that bypassed the seam; a bypass is
  refused outright in native mode. `vlab doctor` reports the selected read
  and forecast engines and, with `--differential`, runs every cataloged
  operation through both engines and compares the results
  (`vcs-lab.engine-differential/v1`). The suite gains a third mode,
  `VLAB_ENGINE=native npm test`, which proves that every read it exercises
  goes through the seam.

## 0.10.0

- Make `merge-tree` the default forecast engine on Windows and keep
  `worktree` the default on other platforms, mirroring the object session's
  platform default; `VLAB_FORECAST_ENGINE` and `--forecast-engine` override
  either, and the suite is now qualified with each engine forced on every
  host. The decision follows the POSIX evidence below: on Linux the engine
  saves about a third of a quarter-second forecast while distribution Git is
  often below 2.49, on Windows it saves 2.5× over the session path and Git
  for Windows is current (ADR-0016 amendment, issue #7).
- Commit the `linux` entry of `benchmarks/baseline.json` (Ubuntu 24.04,
  Git 2.55.0, Node 22.23.2: 63, 24, and 9 forecast processes in the
  worktree-ordinary, worktree-session, and merge-tree-session modes, as on
  `win32`), so `npm run test:benchmark` is active on Linux hosts, and record
  the POSIX evidence for ADR-0016 in its 2026-08-30 amendment: byte-identical
  trees in every suite mode on Ubuntu 24.04 (Git 2.55.0), Alpine 3.22
  (Git 2.49.1, the floor), and Debian 13 (Git 2.47.3, exercising the
  fallback), and 64, 25, and 10 Git processes for the 12-change demo forecast
  in ordinary, session, and merge-tree modes on Linux, as on Windows
  (issue #7).
- Raise the merge-tree forecast engine's Git floor from 2.45 to 2.49 and
  detect an older Git before the first merge instead of after the session
  timeout. The first POSIX run (Debian 13, Git 2.47.3) showed that
  `git merge-tree --stdin` flushes each record only from Git 2.49 (commit
  `344a107b`, "merge-tree --stdin: flush stdout to avoid deadlock"); on
  2.45–2.48 every merge-tree forecast waited out the 60 s session timeout
  before falling back. The session process now runs with `GIT_TRACE2_EVENT=2`
  and the worker reads its trace2 `version` event from stderr before writing
  any request, so an older Git yields an immediate `git-too-old` fallback
  that names the version, with no extra process on any path; Git's own
  stderr messages stay separate from the trace2 lines. The differential
  tests, the demo, and the benchmark's merge-tree mode skip below 2.49, and a
  new scenario verifies the immediate fallback with a spoofed version
  (`VLAB_TEST_MERGE_TREE_GIT_VERSION`) and, on hosts below the floor, with
  the real one (ADR-0016 amendment, issue #7).
- Disable Git `rerere` inside every vlab `cherry-pick` (forecast simulation,
  `reconcile`, `rebase`, `vlab cherry-pick`, and their `--continue` paths)
  and every landing merge with `-c rerere.enabled=false`, so a resolution
  recorded in `.git/rr-cache` can no longer be replayed into a forecast, an
  application, or a landing unapproved, nor recorded from vlab's picks. A
  conflict that Git used to auto-stage is now reported as the conflict it is,
  with its signature and candidates, under both forecast engines and both Git
  session modes (ADR-0018, issue #6).
- Make `vlab metadata validate` and `vlab resolve list` agree on retention
  state (issue #4): validation now peels each `refs/vcs-lab/resolutions/*`
  target exactly as the catalog does, so a ref that names an annotated tag of
  its retention commit is accepted (and `metadata export`/`import` carry the
  raw tag target through), and the catalog no longer reads a note stored as a
  bare JSON array of records, which validation already quarantined as a
  malformed container. Migration: `vlab` never wrote either shape; a bare-array
  note must be rewritten as `{"schema":"vcs-lab.note/v1","records":[...]}` or
  its conflict re-resolved once (`vlab resolve` republishes over such a ref).
  The peel costs complete metadata status one additional bounded Git process
  outside the object session (12 rather than 11 in the ADR-0013 fixture).
- Record the Windows post-batching rerun of
  `vcs-lab.repository-scale-benchmark/v1` in ADR-0013: workspace status fell
  from 1,598 ms to 410 ms (36 to 12 processes) and the resolution catalog from
  5,504 ms to 254 ms (103 to 6 processes) with identical results in both
  Git-session modes and no phase over budget, completing the Windows half of
  ADR-0014 Gate A item 2 and ending Horizon 1 optimization.
- Add an opt-in merge-tree forecast engine (`VLAB_FORECAST_ENGINE=merge-tree`,
  `--forecast-engine`) that simulates clean reconciliation, workspace, and
  rebase forecast steps through one persistent `git merge-tree --stdin`
  process with no temporary worktree, pins the same per-step and predicted
  trees as the worktree simulator, falls back to the worktree simulator with a
  recorded reason for any conflicted, empty, merge-commit, root-commit, or
  attribute-changing step or session failure, and reports `engine`,
  `fallbacks`, and `timings.mergeTree` in both forecast schemas without a
  version change. The engine needs Git 2.49 (see the next entry) and records
  a `git-too-old` fallback on older Git, where the
  merge-tree suite scenarios skip. Extend `demo:git-session` to compare
  ordinary, session, and merge-tree modes (64, 25, and 10 Git processes for
  the 12-change forecast on
  the Windows development host), add a third suite mode, and accept ADR-0016.
- Add `npm run test:benchmark`, an automated regression check that measures a
  reduced scale fixture and a 12-change forecast in ordinary, session, and
  merge-tree modes and compares process counts (exact) and medians (within
  twice the baseline plus a 5 ms floor) against the committed per-host
  `benchmarks/baseline.json`, skipping hosts without an entry;
  `npm run benchmark:record` refreshes an entry. Release gate item 9 is now
  active on hosts with a baseline; accept ADR-0017.
- Raise the supported Git baseline from 2.38 to 2.40 (`git merge-tree
  --merge-base`; ADR-0015). Update README, AGENTS.md, testing, and
  architecture requirements accordingly.
- Accept ADR-0014: split the native implementation gate into a
  semantics-preserving engine gate (Gate A, equality-tested seam with a
  two-release sunset) and a semantics-changing store gate (Gate B, the
  original eight conditions plus dogfooded agent-workload evidence), and
  define "more efficient than Git" as elapsed time and bytes stored and
  transferred against Git and any named alternative.
- Accept ADR-0015: a phased native-core program with Rust as the core
  language, entering behind existing CLI contracts only after a Git-native
  first increment, with funded toolchain, packaging, and backend costs.
- Add roadmap Horizon 1.5, the phased Horizon 5, NFR-PERF-06/07, a
  benchmark-regression release-gate item, and dogfooding metrics in PRD §13.
- Add the `end-session` agent skill (memory, GitHub issues, durable records
  and evidence, local-checkout cleanup) as the canonical `.agents/skills/`
  copy with a generated `.claude/skills/` mirror, `npm run sync:agents` with a
  `--check` mode, and a thin `CLAUDE.md` that imports `AGENTS.md`.

## 0.9.0

- Consolidate maintained product, architecture, testing, and decision records
  under `docs/`; move active implementation briefs to issue tracking and stop
  committing session handoffs or timestamped test-result reports.

- Batch the two scan hot paths selected by ADR-0013: inspect each materialized
  workspace with one worktree-scoped `git status --porcelain=v2 --branch -z`
  query that answers usability, exact head, and dirty count together, and
  discover retained resolution refs with one `for-each-ref` scan, peel their
  targets with one batched object check, and read their records with one
  batched note read instead of per-ref revision resolution and
  `git notes show`.
- Keep workspace and resolution JSON semantically unchanged, including
  missing-versus-invalid paths, archived lifecycle, ref/commit/signature
  agreement, retained result-blob checks, deleted results, and newest-first
  ordering. Retention refs that are dangling or do not name a commit are now
  quarantined from the catalog instead of failing the whole listing, and a
  failed ref scan is an error rather than an empty catalog. A registered
  workspace path that is not a directory is reported as `invalid` instead of
  aborting the listing, an unborn workspace `HEAD` reports a `null` head, and
  a recognized worktree whose status cannot be read still fails loudly.
- Make the repository-scale analysis require at least ten measured entities
  before treating a processes-per-entity ratio as amplification, so tiny
  custom fixtures ask for more volume instead of misreporting a bounded batch
  cost as per-entity process launches.
- Rerun `vcs-lab.repository-scale-benchmark/v1` without changing the fixture:
  the representative profile now uses one Git process per workspace (12 rather
  than 36) and six processes for the 50-resolution catalog (rather than 103),
  and the decision output selects larger fixtures and more hosts instead of an
  index or service.

- Add bounded `vlab metadata benchmark` fixtures for history, linked worktrees,
  workspace registry/status, causal notes, retained resolutions, and complete
  metadata inventory, with semantic equality across samples and trendable
  `vcs-lab.repository-scale-benchmark/v1` JSON.
- Separate fixture setup from cold/warm scan measurements, report logical and
  actual Git-process costs, omit repository content and identities, and remove
  the disposable repository after every run.
- Accept ADR-0013's evidence gate: batch the measured workspace-status and
  resolution-catalog process amplification first, rerun the same schema, and
  add neither persistent indexes nor a resident service without post-batching
  representative evidence.

- Add conservative workspace move, archive, restore, stale-path repair, and
  preview/apply prune commands while retaining workspace, branch, and checkpoint
  identity.
- Give checkpoints stable `draft_` identity plus retained history refs, and add
  `workspace forecast --source-checkpoint` for immutable source-draft
  forecasting without reading live dirty bytes.
- Accept ADR-0012's reversible-materialization and checkpoint-input model.

- Fix the intermittent Windows forced-session hang by starting the persistent
  object worker lazily, after synchronous Git preflight commands complete,
  instead of racing worker startup with `git status`.
- Reject pending object requests on any unexpected worker-Git exit, add opt-in
  session lifecycle diagnostics, and cover the no-worker preflight path in the
  integration suite.
- Wait for the worker Git child's stdio-drained `close` event during shutdown
  and retain a bounded Windows process-tree termination fallback.

- Accept ADR-0011's bounded model of causal rebase as a forecasted sequence of
  target-context applications with linear-v1 scope and fail-closed recovery.
- Add read-only `vlab rebase-plan <onto> [<source>]` using the existing exact
  coverage lattice to classify changes as omit, review, or replay without
  switching the caller.
- Add deterministic rebase-plan fingerprints, explicit heuristic-review state,
  ordered replay queues, and unsupported merge-topology diagnostics.
- Add non-mutating `vlab rebase-forecast <onto> [<source>]` with an isolated
  replay worktree, exact target-before/result trees, predicted-tree pinning,
  caller-state digests, and worktree-private `vcs-lab.rebase-forecast/v1`
  artifacts.
- Keep patch-equivalent candidates fail-closed until `--accept-candidates`
  records an explicit omission decision; expose conflicts and unsupported
  merge topology without changing the caller.
- Add supervised `vlab rebase <onto>` application for the current named branch,
  with saved-forecast staleness checks, exact per-step tree enforcement, stable
  Change IDs, explicit contextual forks, and blocked unexpected empty commits.
- Add worktree-private `vcs-lab.rebase-operation/v1` journals plus process-safe
  status/continue/abort recovery; exact abort restores the original source tip
  and no application or summary facts publish before complete success.
- Add validated shared `vcs-lab.rebase-application/v1` and
  `vcs-lab.rebase/v1` records, causal coverage/graph/receipt integration, and
  deterministic envelopes that retain referenced history made unreachable by
  the branch rewrite.
- Add disposable-repository tests for hard-squash continuation selection,
  repeatable caller non-mutation, advisory patch equivalence, and the linear-v1
  merge boundary, plus deterministic rebase forecasts, candidate pinning, and
  conflict cleanup in ordinary and persistent Git-session modes. Add supervised
  application tests for clean forecast reproduction, stale rejection,
  exact-resolution reuse, conflict fork, unexpected empty blocking, partial
  abort, linked-worktree isolation, and fresh-clone metadata portability.
- Harden persistent Git-session shutdown by closing the batch-command input,
  waiting for the underlying Git process to exit, and retaining bounded
  terminate/fallback paths so Windows invocations do not leave worker or Git
  processes behind.

## 0.8.0

- Add deterministic `metadata status` and `metadata validate` inventory across
  shared-portable notes/resolutions, tracked spec manifests, shared-local
  workspaces/checkpoints, and worktree-private operations/forecasts.
- Validate supported causal record shapes, attachments, referenced Git
  objects, resolution signatures, retention refs/result blobs, record-ID
  conflicts, spec/source consistency, and local workspace health with stable
  diagnostic codes.
- Quarantine unknown, malformed, dangling, and conflicting records from causal
  coverage, exact-resolution lookup, and portable export without rewriting the
  source notes.
- Add deterministic `vcs-lab.metadata-envelope/v1` directories containing a
  hashed manifest and a sanitized Git bundle for notes and exact-resolution
  refs; tracked specs continue to travel with ordinary project content.
- Define clone/fork lineage with Git object format plus sorted root-commit
  anchors. Exact lineage or a shared root is import-compatible; unrelated and
  history-filtered lineages fail closed in envelope v1.
- Add import dry-run/apply with payload verification, exact record/ref/object
  previews, conflict refusal, staged refs, atomic final ref transactions, and
  idempotent repeated import.
- Explicitly exclude workspace paths, checkpoint refs, active reconciliation
  journals, and saved forecasts from portable envelopes and retain the
  distinction between integrity, cryptographic trust, and authorization.
- Add two disposable-repository integration scenarios covering damaged record
  quarantine, coverage safety, deterministic export, tamper rejection,
  unrelated-lineage rejection, conflict-safe dry runs, two-clone round trips,
  causal-plan/resolution/spec parity, idempotence, and local/private exclusion.

## 0.7.1

- Add a full product requirements document with predecessor lessons, AI-agent
  and specification use cases, guiding principles, identified functional and
  non-functional requirements, acceptance signals, success metrics, release
  gates, roadmap criteria, risks, and open questions.
- Add a current architecture reference covering components, identity and
  persistence models, versioned schemas, causal planning, landing, forecast,
  reconciliation, resolution, workspace, specification, Git-session, failure,
  trust, performance, and extension boundaries.
- Add an architecture decision record process and ten initial ADRs: nine
  accepted decisions for the v0.7 implementation and one proposed metadata
  integrity/portability direction.
- Add a self-contained new-session handoff with the preserved product intent,
  Windows repository path, release history, source/runtime maps, invariant
  checklist, baseline commands, known risks, a detailed candidate v0.8 track,
  release discipline, and a copy/paste continuation prompt.
- Add an explicit documentation authority/navigation map and clarify that the
  earlier design notes are historical rationale rather than the sole current
  product contract.

## 0.7.0

- Add a worktree-scoped persistent `git cat-file --batch-command` session for
  immutable object reads during planning, forecasting, and reconciliation.
- Enable the session automatically on Windows, where measured Git process
  startup dominates latency; retain explicit `--git-session` and
  `--no-git-session` controls on every command.
- Cache only full object-ID expressions, invalidate session state after
  mutations, isolate sessions by worktree path, and fall back to ordinary Git
  processes if the persistent worker becomes unavailable.
- Batch target and source commit metadata into two `git log` operations instead
  of spawning `git show` once per commit, keeping planning process count
  independent of branch length.
- Batch note-object reads and use one reachability walk rather than one ancestry
  and note process per causal record.
- Resolve related head/tree probes together and read cherry-pick state directly
  from each worktree's private Git directory.
- Distinguish logical Git queries, actual process launches, persistent-session
  queries, and immutable-object cache hits in forecasts, receipts, doctor
  output, and `--trace-git` diagnostics.
- Extend `vlab doctor --benchmark` with an object-session probe and add
  `npm run demo:git-session`, which verifies identical forecasts while
  comparing persistent and ordinary process counts.
- Reduce the 12-change forecast demo from 52 ordinary Git processes to 25
  processes (51.9% fewer on the release test host), while the deterministic
  spec reconciliation application uses 6 processes for 10 logical queries.
- Expand the integration suite to 29 tests and run it in both persistent and
  ordinary plumbing modes, including forced worker-failure fallback and
  multi-worktree forecast isolation.

## 0.6.0

- Replace expanded v2 specification sidecars with sparse v3 manifests that
  persist only artifact/source identity, entity count, parser identity, Git
  blob identity when available, and exceptional stable-ID overrides.
- Derive titles, positions, content hashes, and ordinary entity IDs directly
  from canonical Markdown while keeping `vlab spec show` fully materialized.
- Migrate v1/v2 manifests on the next index without changing their logical
  entity IDs; only non-derived legacy IDs remain as compact overrides.
- Use Git index blob identities for repository-wide incremental indexing, so
  unchanged tracked documents need no filesystem read or content hash.
- Batch all base/target/source Markdown and manifest reads through one
  `git cat-file --batch` process and batch staged-result verification the same
  way.
- Batch applied commit/tree identity probes and raise the Git output ceiling for
  large documentation objects.
- Upgrade the corpus benchmark to compare sparse v3 metadata against an
  equivalent v2 representation and report blob-cache hits, content reads,
  bytes per entity, and raw/compressed reduction percentages.
- Reduce the representative 25-document, 2,025-entity corpus from 655,545
  equivalent v2 metadata bytes to 11,240 v3 bytes (98.29% less), while the
  semantic reconciliation integration path uses at most 10 Git subprocesses.
- Expand the integration suite to 28 tests, including v2 migration, sparse
  persistence, zero-read unchanged indexing, and subprocess-count regression
  coverage.

## 0.5.0

- Add deterministic three-way reconciliation for indexed Markdown using stable
  preamble and heading-block identities.
- Combine independent block edits and move-plus-edit cases while keeping
  divergent same-block edits, delete-versus-edit, and incompatible ordering as
  explicit blockers.
- Integrate semantic decisions into disposable forecasts, pin their exact input
  signatures and output hashes, and batch-apply them only through a reviewed
  forecast.
- Add `vlab spec status` and `vlab spec resolve` for explicit application during
  a paused non-forecast reconciliation, with semantic decisions preserved in
  application and reconciliation receipts.
- Upgrade spec manifests to deterministic v2 metadata with cross-branch entity
  IDs, canonical LF rendering, and no generation timestamp.
- Make unchanged source hashes true cache hits and add `vlab spec index --all`
  for incremental repository-wide indexing.
- Add `vlab spec merge-plan` for direct three-revision inspection and
  `vlab spec benchmark` for generated-corpus latency and storage measurements.
- Add forecast phase timings and Git subprocess counts grouped by command.
- Add configurable benchmark warmup/sample counts plus min, median, p95,
  average, and max latency.
- Add a deterministic spec-merge demo and expand the integration suite to 27
  tests.

## 0.4.0

- Add `vlab forecast <source>` to simulate proven-new changes in a disposable
  detached worktree without changing the caller's HEAD, index, or files.
- Predict clean applications, exact reusable resolutions, blocking conflicts,
  partial trees, complete result trees, and final state equality.
- Persist forecasts privately per worktree and pin them to source and target
  heads plus a complete causal merge-plan fingerprint.
- Add `vlab reconcile --use-forecast <id>` to batch-apply only the exact
  resolution IDs reviewed in that forecast.
- Recheck conflict signatures during application and verify a complete
  reconciliation's final tree against its forecast before publishing receipts.
- Add `vlab workspace forecast <target> <source>` for committed-head comparison
  between agent worktrees while explicitly reporting ignored dirty drafts.
- Record forecast IDs, exact-selection method, active application time, and
  elapsed wall time in reconciliation metadata.
- Add a proactive forecast demo and expand the integration suite to 19 tests.

## 0.3.0

- Fingerprint conflicts with an exact, path-independent three-way signature
  derived from Git's base, ours, and theirs blob identities.
- Store completed conflict resolutions in repository-shared, garbage-collection
  safe refs and suggest them when the same conflict recurs in another worktree.
- Add `vlab resolve status`, `apply`, `reject`, and `list` with explicit handling
  for ambiguous resolution variants.
- Record whether a suggestion was created, accepted unchanged, modified, or
  rejected in application and reconciliation receipts.
- Keep resolution reuse conservative: suggestions are visible but never applied
  until the user asks.
- Make reconciliation output concise by default while retaining complete JSON
  through `--json`.
- Consolidate matching application and reconciliation edges in `vlab graph`.
- Add opt-in Git subprocess timings with `VLAB_TRACE=1` and repeatable local
  probes through `vlab doctor --benchmark`.
- Add a reusable-resolution/worktree demo and expand the integration suite to
  15 tests.

## 0.2.1

- Make disposable test and demo repositories deterministic on Windows by
  disabling checkout-time CRLF conversion locally.
- Normalize line endings in assertions where exact newline bytes are not part
  of the behavior under test.
- Add repository line-ending policy through `.gitattributes`.

## 0.2.0

- Add worktree-local, durable reconciliation operations.
- Add `vlab reconcile --status`, `--continue`, and `--abort`.
- Record contextual applications after user-resolved conflicts.
- Allow `--continue --fork` when a resolution changes logical intent.
- Keep partial application records private until reconciliation completes.
- Restore the original target and discard pending receipts on abort.
- Distinguish state equality before and after reconciliation.
- Hide Git notes history in `vlab graph` and improve causal edge output.
- Leave the standard demo worktree clean and add `npm run demo:conflict`.

## 0.1.0

- Initial Git-backed causal source-control laboratory.
- Stable Change IDs, compact and hard-squash landings, causal merge planning,
  worktree-backed workspaces, checkpoints, and annotated Markdown specs.
