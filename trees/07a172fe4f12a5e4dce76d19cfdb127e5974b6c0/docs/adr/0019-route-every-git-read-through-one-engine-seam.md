# ADR-0019: Route every Git read through one engine seam with per-operation fallback

- **Status:** Accepted
- **Date:** 2026-08-30
- **Owners:** Repository maintainers
- **Related requirements:** GP-09, GP-12, FR-GIT-06, FR-GIT-07, FR-PERF-09,
  NFR-COR-02, NFR-PERF-03, NFR-TEST-02

## Context

[ADR-0014](0014-split-the-native-implementation-gate-into-engine-and-store-gates.md)
Gate A item 1 requires "a single read-side engine seam in the JavaScript
implementation (`src/engine.js`) with an engine selector, a third
integration-suite mode, and per-operation fallback recorded in metrics", and
[ADR-0015](0015-adopt-a-phased-native-core-program-with-rust.md) makes that
seam phase 0b of the native-core program, to be written before any phase 1
code. Roadmap Horizon 2 item 1 names the increment; the implementation brief
is [GitHub issue #11](https://github.com/jwh3times/vcs-lab/issues/11).

Before this decision, repository reads had no single owner. `src/git.js`
offered shared helpers (`resolveRevision`, `treeId`, `commitMessage`, the
batched object reads of ADR-0009 and ADR-0013), but fourteen domain modules
also called `runGit` directly for about twenty-five further read shapes:
`status` in three forms, `log` in three formats, `for-each-ref`, `notes
list`/`show`, `ls-files` in five forms, `worktree list`, `symbolic-ref`,
`rev-list` in four forms, `cherry`, `show-ref`, `rev-parse --git-path`,
`diff --diff-filter=U`, `branch --show-current`, and `--version`. Nothing at a
call site distinguished a read from a mutation, so a native engine could not
be placed behind the implementation without editing every module, and no
measurement could show that a "native mode" run had answered a read without a
Git process.

Facts verified on the Windows development host on 2026-08-30 (Git
2.55.0.windows.3, Node 26.4.0), in disposable repositories:

- the catalog below has 38 operations; `vlab doctor --differential` reports
  38 equal, 0 different, and 0 skipped operations between the two engines;
- a one-change reconciliation forecast uses nine Git processes under either
  engine and pins the same predicted tree; in native mode the result lists
  the nine passthrough operations under `fallbacks` and `directReads: 0`;
- the 12-change `demo:git-session` forecast and the benchmark regression
  check keep their process counts, so the baseline of ADR-0017 is unchanged.

## Decision

1. **One seam.** `src/engine.js` is the only path for repository reads. It
   exports one function per cataloged operation and a few composites
   (`currentHead`, `changeIdForCommit`, `assertClean`, `gitAtLeast`) that are
   derived from cataloged operations alone. Domain modules import reads from
   `./engine.js`; from `./git.js` they may import only mutation and transport
   names: `runGit`, `gitText`, `GIT_NO_RERERE`, the metrics collectors,
   `withGitObjectSession`, the forecast-engine selectors, `MergeTreeSession`,
   and the pure `extractTrailer`.
2. **The catalog.** Thirty-eight operations in five groups: repository and
   host (`repoContext`, `gitVersion`, `isInsideWorkTree`, `gitPath`); objects
   (`resolveRevision`, `resolveObjectIds`, `revisionResolves`, `treeId`,
   `readGitBlob`, `readGitObjects`, `inspectGitObjects`); history
   (`mergeBase`, `isAncestor`, `listCommits`, `reachableCommits`,
   `countCommits`, `mergeCommitsBetween`, `rootCommits`, `commitHistory`,
   `commitMessage`, `commitSubject`, `findCommitByChangeId`,
   `patchEquivalentCommits`, `historyGraph`); refs and notes (`refExists`,
   `refTarget`, `listRefs`, `symbolicRef`, `listNoteEntries`,
   `readNoteText`); worktree, index, and status (`workspaceStatus`,
   `porcelainStatus`, `unmergedPaths`, `indexEntries`, `listTrackedPaths`,
   `pathInventory`, `ignoredPaths`, `listWorktrees`). Each operation's
   arguments and result shape are part of the contract; the phase 1 backend
   matrix of ADR-0015 is written against these names.
3. **The Git engine.** `src/git.js` implements every operation with exactly
   the plumbing the modules ran before: one process per operation, or one
   object-session query where ADR-0009 already used one. Process counts are
   therefore unchanged one-for-one. Its read implementations mark their
   `runGit` calls with a private symbol.
4. **Selector.** `VLAB_ENGINE` and `--engine <git|native>`, mirroring the
   forecast-engine selector; `git` is the default on every platform and
   remains the oracle. `native` is the phase 1 core; until its binding exists
   it is reported as `available: false` with the reason `binding-missing`,
   and every operation passes through to Git.
5. **Per-operation fallback in metrics.** When the selected engine lacks an
   operation or throws, the seam answers with Git and records `{ operation,
   reason }` with the reason `binding-missing`, `unsupported`, or
   `native-error`. `endGitMetrics` reports `engine`, `fallbacks` (aggregated
   per operation and reason, with counts), and `directReads` in every Git
   metrics block: forecast and receipt timings, benchmarks, and the doctor.
6. **Bypass rule.** A read-only Git command that reaches `runGit` without the
   mark is a direct read. It is counted in `directReads`, traced under
   `--trace-git`, and in native mode refused with an error that names the
   command. The doctor's process-cost probes are the only exemption
   (`rawProbe`), because a raw process is what they measure. The read-only
   classification (`gitCommandMutates`) is the one that already governs
   object-session invalidation; `worktree list`, `symbolic-ref` with one
   name, `branch --show-current`, and `ls-tree` are read-only.
7. **Third suite mode.** `VLAB_ENGINE=native npm test` (passthrough-native)
   joins the ordinary, forced-session, and forced-forecast-engine runs.
   Because bypasses are refused in that mode, a green run proves that every
   read the suite exercises goes through the seam and that the fallback path
   preserves results. The suite also checks statically that no module other
   than the seam imports read names from `./git.js` and that `rawProbe`
   appears only in `src/cli.js`.
8. **Differential doctor.** `vlab doctor --differential` runs every cataloged
   operation through each engine against the current repository, with the
   Git engine as oracle, and reports per-operation result digests, equality,
   process counts, and fallbacks as `vcs-lab.engine-differential/v1`. An
   operation whose input the repository cannot supply (no commit on HEAD, no
   blob in the index) is listed as skipped with the reason, and the doctor
   refuses a catalog its probes do not cover exactly. This report is what
   phase 1 must show equal for an operation before that operation moves to
   the native engine.

## Constraints

- Mutations never pass through the seam; a native engine that writes (phase
  4 of ADR-0015) needs its own ADR and its own equality test.
- Adding an operation adds its Git implementation, its seam export, and its
  differential probe together.
- Domain JSON is unchanged except for the three metrics fields; the metrics
  fields appear where a Git metrics block already existed. The envelope for
  every JSON result, including where `engine` and `fallbacks` sit at the top
  level, is decided by the schema catalog of the next increment.
- The Git engine stays the fallback and semantic oracle for the life of the
  program (ADR-0015); the seam never changes which engine publishes a
  receipt.

## Consequences

### Positive

- A native engine can now be introduced one operation at a time, and every
  result says which engine answered and which operations fell back.
- A zero-process claim for a read path is checkable from the same metrics
  (`processes`, `fallbacks`, `directReads`) on any host.
- Domain modules read a smaller, semantic Git surface (parsed work trees,
  index entries, and status) instead of parsing plumbing output in place.

### Negative

- Thirty-eight wrapper functions and one dispatch per read; the cost is a
  function call, and measured process counts and medians are unchanged.
- Two selectors are both called "engine": the forecast engine of ADR-0016 and
  the read engine of this ADR. The doctor reports them under distinct keys
  (`engine`, `forecastEngine`), and each flag names its own values.
- Native mode fails loudly on any future bypass. That is the intent, and the
  third suite mode is where it is caught.

## Rejected alternatives

- **A proxy around `runGit` that classifies commands at runtime and routes
  reads to the native engine by command name:** keeps Git's argument vector
  and output format as the contract, so a native engine would have to emulate
  Git's command syntax. Rejected; the contract must be the operation.
- **Per-module adapters:** multiplies seams and leaves no single catalog for
  the backend matrix.
- **Refusing a bypass in the ordinary `git` mode too:** an unexercised path
  would fail users for no benefit; counting in `git` mode and refusing in
  `native` mode gives the same development-time signal through the third
  suite mode.
- **Owning the object session in the seam:** the session is the Git engine's
  transport; the native engine will hold its own repository handle.
- **Reporting `engine` and `fallbacks` at the top level of every JSON result
  now:** collides with the forecast's `engine` field and pre-empts the schema
  catalog. Deferred to that increment.

## Implementation map

- Seam, catalog, native stub, and differential: `src/engine.js`
- Git engine, selector, metrics fields, bypass rule, read-only
  classification: `src/git.js`
- CLI: `--engine`, `vlab doctor` (`engine`, `forecastEngine`,
  `--differential`), the `rawProbe` benchmark probes: `src/cli.js`
- Suite: the seam tests in `test/integration.test.js`; the third mode in
  `docs/testing.md` and `AGENTS.md`
- Documents: `docs/architecture.md` §3, §14, §18, §19; `README.md`;
  `docs/roadmap.md` Horizon 2 item 1; `docs/product.md` FR-GIT-07 and §14
