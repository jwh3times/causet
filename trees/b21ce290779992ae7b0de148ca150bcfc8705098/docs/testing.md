# Testing and qualification

This document defines the maintained validation contract. Tests create
disposable repositories and exercise the real CLI and Git executable; do not
run history-changing manual experiments in a valuable repository.

## Requirements

- Node.js 20 or newer
- Git 2.40 or newer (Git 2.49 or newer to exercise the merge-tree forecast
  engine; the merge-tree scenarios skip on older Git, where one scenario
  verifies the immediate `git-too-old` fallback instead)
- a clean source checkout for release qualification
- enough system temporary space for disposable repositories

The package has no runtime dependencies and no build step.

### Windows resolution retention paths

With Git long paths disabled, a resolution ref's absolute `.lock` path must
fit within 259 characters. For an ordinary SHA-1 repository with a `.git`
directory, a blob-result resolution consumes 146 characters below the root:
a 113-character root fits, and a 114-character root fails. SHA-256 object IDs
consume another 24 characters; deletion results use the shorter `deleted`
suffix. Linked worktrees store these refs in the common Git directory, so
shortening only the linked worktree path does not solve this limit.

When Git fails to create that path at or above 260 characters, publication
reports `path-length-exceeded`, the measured lock-path length, and the required
reduction. Use a shorter Git directory path or enable long paths locally with
`git config core.longpaths true`. VLab does not change this setting for you.
A failed publication can leave an operation journal; use the operation's
`--abort` to restore its starting commit, then retry after addressing the path.
Existing lock files and permission failures retain `git-command-failed`.

`test/resolution-path.test.js` exercises the Windows boundary, shared refs from
a linked worktree, successful publication with long paths enabled, existing
locks, and CLI JSON failure followed by reconciliation abort. On other hosts,
the same long paths must publish successfully; no synced folder or special
hardware is required.

## Development validation

Run the complete integration suite in ordinary mode:

```bash
npm test
```

Every suite file spawns Git and the CLI through `testEnv` from
`test-support/git-environment.js`, which sets `GIT_CONFIG_NOSYSTEM=1` and
points `GIT_CONFIG_GLOBAL` at an empty file created for the run, so a host's
global `commit.gpgsign`, `core.hooksPath`, `init.defaultBranch`, or
`core.autocrlf` cannot reach a fixture; fixtures set their own identity and
line-ending settings. The CLI itself still reads the user's real
configuration. The helper lives beside `test/` rather than inside it because
`node --test` runs every JavaScript file under a directory named `test` as a
test file, so a shared module there would be executed as one.

Run it again with the invocation-scoped Git object session forced:

```powershell
$env:VLAB_GIT_SESSION = "1"
npm test
Remove-Item Env:VLAB_GIT_SESSION -ErrorAction SilentlyContinue
```

On POSIX shells:

```bash
VLAB_GIT_SESSION=1 npm test
```

Run it with the session forced off as well. "Ordinary mode" is not one mode:
the session is the default on Windows and off elsewhere, so an ordinary run
on a Windows host never exercises the one-process fallback that every POSIX
user runs by default. v0.13.0 shipped with two tests red in exactly that
path because the gate ran where the session is on. Forcing both settings on
every host closes the gap:

```powershell
$env:VLAB_GIT_SESSION = "0"
npm test
Remove-Item Env:VLAB_GIT_SESSION -ErrorAction SilentlyContinue
```

```bash
VLAB_GIT_SESSION=0 npm test
```

Run it with each forecast engine forced. The default engine differs by
platform (`merge-tree` on Windows, `worktree` elsewhere), so both runs are
needed on every host: the merge-tree run simulates every clean forecast step
through `git merge-tree` and falls back to the worktree simulator where it
must, and the worktree run exercises the oracle throughout:

```powershell
$env:VLAB_FORECAST_ENGINE = "merge-tree"
npm test
$env:VLAB_FORECAST_ENGINE = "worktree"
npm test
Remove-Item Env:VLAB_FORECAST_ENGINE -ErrorAction SilentlyContinue
```

```bash
VLAB_FORECAST_ENGINE=merge-tree npm test
VLAB_FORECAST_ENGINE=worktree npm test
```

Run it with the native read engine selected. No native binding exists yet,
so every read operation passes through to Git and is recorded as a fallback;
what the run proves is that every read the suite exercises goes through the
engine seam (`src/engine.js`), because a read that bypasses the seam is
refused in this mode (ADR-0019):

```powershell
$env:VLAB_ENGINE = "native"
npm test
Remove-Item Env:VLAB_ENGINE -ErrorAction SilentlyContinue
```

```bash
VLAB_ENGINE=native npm test
```

The suite includes `test/schema-catalog.test.js`, which keeps the published
JSON Schema catalog in `docs/schemas/` in agreement with the executable
validators in `src/schemas.js`: every schema identifier used in `src/` must
have a catalog document, records produced by the real CLI must satisfy their
documents, and a note record the runtime validator rejects for a missing
field must be rejected by its document too. A new or changed record family is
not complete until its catalog document passes these checks.
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
each to one property: a non-zero exit, a `vlab:` domain diagnostic rather than
a leaked JavaScript runtime error, and **no ref moved**. The runtime-error
check matters because the error boundary prints any failure as `vlab: <message>`,
so an exit code alone cannot tell a refusal from a crash.
`test/failure-boundary.test.js` interrupts the mutating paths of both
reconciliation and causal rebase at named fault points with `VLAB_TEST_FAULT`
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
driven behind vlab's back during a paused operation must leave the resume
refusing, publishing nothing, and still recoverable through vlab's own abort.
The same file proves the notes lock closes the publication race:
`VLAB_TEST_GATE=notes:after-read` parks one publisher between reading a
commit's note container and writing it back (the gated process creates
`<VLAB_TEST_GATE_FILE>.reached` on arrival and proceeds once
`<VLAB_TEST_GATE_FILE>` exists), a second publisher must wait rather than
complete, and both records are present afterwards; with the lock removed the
same test shows the second record lost. A lock left by a process that is gone,
or a minute-old lock from a host that cannot be checked, is abandoned, while a
lock a running process holds makes the next publisher wait and then refuse
with `notes-locked`.

Attributed-commit lock refusal also pins HEAD, raw index bytes, worktree content,
and existing notes. Retrying after release must create one commit and one
provenance record. Additional fixtures cover `VLAB_AGENT` and `--all` from a linked
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

The same file pins the object session's response-buffer bound. Overflowing
the real 64 MiB content buffer needs a blob of roughly 48 MiB, far too large to
build on every suite run, so `VLAB_TEST_SESSION_BUFFER_BYTES` shrinks the
buffer to meet a small fixture. What is asserted is not the threshold but the
behaviour at it: an overflowing response is replaced by a `response-too-large`
envelope, the session is disabled for the rest of the invocation — hence
exactly one fallback per command, not one per request — and the read falls
through to an ordinary Git process. **The answer must be byte-identical across
all three transports**, session, fallback, and no session at all, because a
fallback that returned different data would be worse than one that failed. The
override is inert unless it parses as a positive integer, which is itself
asserted, since it shrinks a safety bound.
Two more test-only switches in `src/git.js` force the fallback paths without a
broken Git. `VLAB_TEST_GIT_SESSION_FAILURE=1` makes the object session spawn a
nonexistent Git command, so its worker fails to start and the command completes
through ordinary processes; the suite asserts that the plan is identical and
that the trace announces the fallback. `VLAB_TEST_MERGE_TREE_SESSION_FAILURE=1`
does the same to the merge-tree session, so a forecast records one merge-tree
fallback and reruns the whole queue in the worktree simulator with identical
trees. `VLAB_TEST_MERGE_TREE_GIT_VERSION=<version>` makes the merge-tree
session report that Git version instead of the one its trace2 event names,
which is how the `git-too-old` fallback is exercised on a host whose Git is new
enough. Like `VLAB_TEST_FAULT` and `VLAB_TEST_GATE`, each is inert unless it is
set exactly.
`test/error-envelope.test.js` covers the failure contract (ADR-0021). Two of
its checks are **static**: they scan `src/` for every `new CliError` and fail
if one carries no code or a code outside `ERROR_CODES`, and fail in the other
direction if a published code is raised nowhere. That is deliberate. The
property worth guaranteeing is "every raise site is classified", and no amount
of exercising the CLI proves anything about the sites no test reaches — there
are 232 of them, and the suite reaches a fraction. A third check keeps
`docs/schemas/errors.md` and the runtime map in agreement, the same relation
`docs/schemas/` and `src/schemas.js` hold for record families.

The behavioural checks pin what changed for callers: a `--json` failure is an
envelope on stdout with stderr empty, the human path's prose and every exit
code are unchanged, and the ADR-0020 refusals report the code that names their
disposition rather than requiring a caller to match English. One test pins the
boundary: a global flag consumed before the argument parse keeps prose, because
no output mode is known yet, while an unknown command is enveloped.

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
be reported as `different-repository` rather than as a stale `target-moved`.
The test skips itself if the host Git cannot create a SHA-256 repository.
`test/schema-compatibility.test.js` keeps the published compatibility contract
in `docs/schemas/compatibility.md` in agreement with `RECORD_FAMILIES` and
`RESOURCE_BOUNDS` in `src/schemas.js`, and exercises each disposition against
the real CLI: an unreadable journal, registry, or forecast is refused without
being rewritten, a note container from another build survives a refused
receipt publication byte for byte, and an oversize note is quarantined with a
diagnostic rather than failing the command. A new record family, a new version,
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
one queue, and `vlab doctor --differential` compares the read engines
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
every Git process the whole `vlab reconcile` invocation starts and how many
records it publishes. That is the one stretch whose work scales with the number
of changes, and until v3 nothing covered it — a per-application `git notes list`
was added there and passed the entire suite, every suite mode, and this
check. The count comes from the `VLAB_TRACE=1` trace rather than from the
receipt, because the receipt's `timings.git` block covers the application phase
only: the receipt is built before publication runs, so it cannot report its own
publication cost. Provenance is declared on the fixture so the carry path
actually runs; with none in the repository that path returns before its loop,
which is exactly how the original regression hid. Both figures are held to the
process rule, and `records` is a semantic guard: if it moves, the phase has
stopped measuring what it claims to.

Each scale phase also measures a **raw-Git floor**: the plain-Git commands a
reader would run to obtain the same result, timed in the same process and the
same way as the phase itself (issue #42). Both sides therefore exclude Node
start-up and module load, which is what makes the ratio between them the
maintainer's stated criterion -- `vlab` no worse than 110% of the equivalent
plain-Git work -- rather than an approximation of it. Each floor publishes the
commands it ran, because which commands count as "equivalent" is a judgement
rather than a fact and belongs in review. `workspaceRegistry` reports no floor:
Git has no workspace registry, and an invented denominator would be worse than
none.

The floors run after every phase on the same fixture, so no phase measurement
moves and the committed deterministic baseline stays comparable; the phases that
create worktrees would otherwise change what a later floor sees, so the status
floor is given the worktree set its phase actually measured.

The ratio is **reported, not enforced**. The 110% criterion is not ratified yet
(issue #42) and several phases exceed it today, so `compare()` is unchanged and
no run fails on a ratio. The report exists so the decision has numbers.

A process count above the baseline, a median above twice the
baseline (or the baseline plus 5 ms, whichever is larger), or a forecast whose
modes disagree fails the check. A forecast mode the host cannot run
(merge-tree below Git 2.49) is reported as skipped.

Latency selection uses an explicit, stable operator-assigned machine label:
`--host <label>` takes precedence over `VLAB_BENCHMARK_HOST`. Labels use 1–64
lowercase ASCII letters, digits, dots, underscores, or hyphens, starting with a
letter or digit. Choose a public-safe label such as `lab-linux-a`, retain it
across toolchain upgrades, and use a different label for a different machine.
The recorder never derives a label from the hostname or a private machine ID.
Recording requires a label and refuses before measurement if it is missing.

Schema v3 stores identified entries in `hosts`. Each entry includes its label,
platform, architecture, CPU models, logical CPU count, memory capacity, OS
release, and `VLAB_ENGINE`, `VLAB_GIT_SESSION`, and `VLAB_FORECAST_ENGINE`
overrides in `host`, alongside `recordedAt`, `git`, and `node`. Hardware and
overrides must match for latency comparison; OS, Git, and Node versions remain
provenance for interpreting upgrades rather than creating new identities.
A reused label with different hardware or settings skips latency until an
intentional re-record. Review provenance before committing an entry.

The previous Linux and Windows entries are preserved unchanged in `legacyHosts`;
their original machines cannot be identified from the old data. Those entries
never supply latency limits. On an unknown or unselected host, compatible
legacy OS entries still supply deterministic process, record, and materialization
counts when no benchmark overrides are set. Forecast semantic equality checks
always run. With no compatible reference, all baseline comparisons are skipped.
Human output explains the scope; JSON reports `latencySkipped` and `reference`,
and skipped latency findings have no baseline or limit. `passed: true` on a
deterministic-only check does **not** qualify host latency for release.

The baseline is the one committed measurement artifact, permitted because the
check consumes it. Reading v2 data migrates its shape in memory only; recording
preserves those historical measurements and every other identified entry.
Unsupported schemas or changed profiles/tolerances require an explicit migration;
recording never silently discards old measurements or relaxes the limits.
An interrupted run removes its `vcs-lab-benchmark-check-*` fixtures on SIGINT.
Record or refresh an identified host deliberately on a quiet machine in a clean
checkout, review the diff, and commit it with the reason the numbers changed:

```bash
npm run benchmark:record -- --host lab-linux-a
npm run test:benchmark -- --host lab-linux-a
```

Establish identified baselines on the actual qualification machines before using
latency evidence for release gates; historical entries alone are insufficient.
The Windows re-record remains tracked in
[issue #22](https://github.com/jwh3times/vcs-lab/issues/22), and multi-host evidence
in [issue #42](https://github.com/jwh3times/vcs-lab/issues/42).

## Static checks

Before merging a documentation or source change:

```bash
git diff --check
npm run test:docs
npm run sync:agents -- --check
node --check src/cli.js
node --test
```

For broad JavaScript changes, run `node --check` over every tracked JavaScript
file under `src`, `bin`, `scripts`, and `test`. `npm run test:docs` verifies
local Markdown link targets. New or changed formal requirement IDs must remain
unique and every reference must resolve to a definition.

## Release gate

A release candidate is eligible only when:

1. the source checkout begins and ends clean at the same candidate commit;
2. every file in the checkout is text Git will diff — no file contains a NUL
   byte and none is hidden from review by a `binary` attribute;
3. the integration suite passes in ordinary, session-on, session-off, both
   forced forecast-engine, and native read-engine modes, on a Windows host
   and a POSIX host — a green **manually dispatched full qualification** run
   of the workflow below on the release commit satisfies this item; a routine
   PR or main run does not;
4. all maintained demos complete;
5. metadata validation reports no unexpected errors;
6. expected-failure cases leave protected refs and worktrees unchanged;
7. no VCS Lab Node or Git process remains after completion;
8. version constants, package metadata, changelog, and release tag agree; and
9. the packed artifact passes an install and smoke test outside the source
   checkout; and
10. `npm run test:benchmark -- --host <label>` passes on each identified
    qualification machine in `benchmarks/baseline.json`. Unknown hosts report
    skipped latency; deterministic-only passes and historical OS entries do not
    satisfy host latency qualification.

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

## Continuous integration

`.github/workflows/ci.yml` keeps automatic runs bounded. The repository is
public, so its standard GitHub-hosted runner execution is free; the reduced
routine matrix still applies. Every run performs syntax, documentation-link,
agent-mirror, whitespace, CI-policy, and benchmark-analysis checks first. Suite jobs only
start after those checks pass.

| Trigger | Suite jobs after static checks | Purpose |
| --- | --- | --- |
| Code pull request | Default mode on Ubuntu and Windows, Node 24 | Routine behavior and both platform defaults |
| Code push to `main` | Default mode on Ubuntu, Node 24 | Integration check without repeating the Windows matrix |
| Known documentation-only PR or main push | None | Static checks still run |
| Manual `workflow_dispatch` | All six modes on Ubuntu and Windows, Node 24; default and session-on on Ubuntu, Node 20 | Full platform and minimum-Node qualification |

The selector in `scripts/ci-plan.mjs` compares the checked-out PR merge commit
with its base, or the pushed commit with the event's previous main commit.
Only root guides, Markdown under `docs/`, and Markdown agent skills qualify as
documentation-only. Schemas, conformance fixtures, scripts, tests, workflows,
and unknown paths still run suites. Renames consider both paths; a missing
comparison commit or empty diff conservatively runs the routine suites.
There is no automatic full-matrix schedule. Superseded runs cancel within
the same event and ref; manual qualification is independent of automatic runs.
Static jobs have a five-minute timeout and suites a 25-minute timeout.

Run full qualification before each release and before merging changes to Git
session transports, forecast engines, native read routing, platform-specific
process/filesystem behavior, or the supported Node/Git floor, unless the PR
already records equivalent checks on both platforms for the candidate. Use:

```sh
gh workflow run ci.yml --ref <candidate-branch-or-tag>
```

Record the tested SHA and results in the PR or release evidence. Local six-mode
validation remains required for cross-cutting changes. Routine defaults cover
the normal POSIX session-off and Windows session-on paths, but alternate modes
and Node 20 can otherwise regress until explicit qualification. Code changes
should go through a PR; an exceptional direct main push requires equivalent
Windows evidence before pushing. A failed check is investigated before retrying.
The `static checks` job runs for every change; matrix checks are conditional,
so do not require every full-matrix job for ordinary PRs in branch protection.

Each suite job fails unless exactly one test self-skipped — the too-old-Git
case, which is covered with a spoofed version — so unsupported runner
capabilities cannot silently pass. Linux jobs also fail if a session worker or
`cat-file` process survives the suite (release-gate item 7).

The workflow does not run `npm run test:benchmark`: its baseline is per-host.
The ordinary suite's repository-scale benchmark checks report consistency,
process counts, privacy, and cleanup without assuming shared runners meet a
latency budget. Controlled analysis tests cover below/at/above-budget decisions
and process-amplification precedence. Demos, metadata validation, and the
packed-install smoke test stay release-time steps.

[Issue #58](https://github.com/jwh3times/vcs-lab/issues/58) records the CI
reduction, measured runner usage, publication review, and decision to make the
repository public. Job-duration estimates are not billing totals. Standard
hosted execution in this public repository is free under
[GitHub's Actions billing policy](https://docs.github.com/en/billing/concepts/product-billing/github-actions).
Recheck billing treatment before changing repository visibility or runner
classes; larger runners are charged even in public repositories.

## Evidence retention

Record the tested commit, platform and tool versions, command outcome, and any
material exception in the pull request or release summary. Store raw logs and
generated repositories as CI artifacts with an explicit retention period; do
not commit timestamped result reports or machine-local temporary paths.

If a failure produces a lasting design constraint, add or supersede an ADR. If
it produces a product correction, add a regression test and changelog entry.
Git history remains the record of prior one-off qualification documents.
