# ADR-0018: Disable Git rerere inside vlab's cherry-picks and landing merges

- **Status:** Accepted
- **Date:** 2026-08-30
- **Owners:** Repository maintainers
- **Related requirements:** FR-RES-03, FR-RES-06, FR-REC-05, FR-REC-06, NFR-COR-02, NFR-COR-06
- **Amends:** [ADR-0007](0007-keep-resolution-automation-exact-or-deterministic.md)
  (alternatives), [ADR-0016](0016-simulate-clean-forecast-steps-with-a-merge-tree-session.md)
  (Git constraints)

## Context

ADR-0007 rejects Git's `rerere` as an automatic resolution source because its
selection and provenance are invisible to the product's trust model, and
FR-RES-03 says a prior result is applied only through an explicit action or a
pinned forecast. Until this decision, vlab nevertheless ran its `cherry-pick`
and landing `merge` invocations with whatever rerere state the repository
had, and ADR-0016 recorded the consequence while introducing the merge-tree
engine (which never consults rerere).

Facts established in disposable repositories on 2026-08-30 (Git
2.55.0.windows.3), tracked by
[GitHub issue #6](https://github.com/jwh3times/vcs-lab/issues/6):

- A `.git/rr-cache` entry alone activates rerere: with `rerere.enabled`
  unset, `git cherry-pick` and `git merge` (`--no-ff --no-commit`, `--squash`,
  and plain `--no-ff`) replay a recorded resolution and print
  `Resolved '<path>' using previous resolution.`
- Without `rerere.autoUpdate` the working file is rewritten to Git's
  resolution while the index keeps stages 1–3, so vlab still sees the
  conflict but the user is handed a pre-filled file without markers that vlab
  never approved and would record as a `created` resolution on `git add`.
- With `rerere.autoUpdate=true` the index is left at stage 0
  (`Staged '<path>' using previous resolution.`), `git diff --diff-filter=U`
  reports nothing, and the command still exits 1. vlab classified this as
  `blocked-git-error` (forecast, both engines and both session modes) or a
  paused reconciliation with no conflicted paths; a landing's follow-up
  `git commit` would have committed Git's resolution silently.
- The pick or merge is where rerere captures its preimage and writes
  `.git/MERGE_RR`; `--continue` and `git commit` only add the postimage.
  Disabling rerere on `--continue` alone leaves an orphan preimage entry and
  a stale `MERGE_RR` behind.
- `git -c rerere.enabled=false <command>` suppresses replay and recording
  completely, regardless of repository configuration (including an explicit
  `rerere.enabled=true` and `autoUpdate=true`): conflict markers and stages
  remain, no `MERGE_RR` is created, and `.git/rr-cache` is untouched.
  `git cherry-pick --abort` and `git merge --abort` restore the checkout in
  every state.
- vlab never reads `rr-cache`; its own exact-resolution catalog was empty in
  every probe, so a rerere resolution is invisible to vlab's candidate
  machinery and can only enter through Git's replay.

## Decision

Every `git cherry-pick` vlab runs — the worktree forecast simulator,
`reconcile`, `rebase`, `vlab cherry-pick`, and the `--continue` paths of the
forecast simulator, reconciliation, and rebase — and every landing merge
(`vlab merge`, `compact-merge`, `hard-squash`) is invoked with
`-c rerere.enabled=false` (`GIT_NO_RERERE` in `src/git.js`).

A conflict inside vlab is therefore resolved only by vlab's own approved
memory (an exact candidate applied explicitly or through a pinned forecast),
by a deterministic semantic merge, or by the user, and it is recorded only in
vlab's resolution catalog. Git's `rr-cache` is neither read nor written by
vlab; the user's rerere configuration continues to apply to their own Git
commands.

The `--abort` invocations are unchanged: with rerere disabled on the pick, no
`MERGE_RR` exists for abort to clear.

## Consequences

### Positive

- A conflict Git used to auto-stage is reported as the conflict it is, with
  its signature and candidates, under both forecast engines and both Git
  session modes; forecasts stay deterministic across hosts with different
  rerere caches (NFR-COR-02).
- No resolution enters a forecast, an application, or a landing without
  passing FR-RES-03; vlab's picks never pollute the user's `rr-cache` with
  resolutions vlab chose.
- Landings cannot commit a Git-replayed resolution: the merge conflicts and
  fails without a receipt, as the landing contract already states.

### Negative

- A user who relied on rerere to pre-fill repeated conflicts during
  `vlab reconcile` loses that convenience inside vlab; vlab's exact-resolution
  memory is the replacement and requires one explicit `resolve apply` or a
  pinned forecast per signature.
- One more `-c` argument on each invocation; no additional process.

## Alternatives considered

- **Leave rerere active and document it (status quo):** rejected; the
  `autoUpdate` case misclassifies a conflict as a Git error in every mode, and
  the plain case hands the user an unapproved resolution without markers.
- **Detect `rr-cache` and warn or refuse:** rejected; it makes vlab's
  behavior depend on repository state it does not own and still needs the
  guard for the cases it cannot detect (an entry created mid-operation).
- **Disable rerere only in forecasts:** rejected; real application and
  landings are where an unapproved resolution becomes a commit.
- **Import `rr-cache` entries into vlab's resolution catalog:** rejected;
  they carry no provenance or approval, which is exactly what ADR-0007
  requires of a candidate.

## Implementation map

- The invocation prefix: `src/git.js` (`GIT_NO_RERERE`)
- Forecast simulator pick and continue: `src/forecasts.js`
- Direct pick, reconciliation queue and continue: `src/operations.js`
- Rebase queue and continue: `src/rebase-operations.js`
- Landing merges: `src/landings.js`
- Regression coverage (forecasts under both engines, rebase forecast,
  compact and hard-squash landings, `vlab cherry-pick` plain and `--fork`,
  supervised rebase, paused and continued reconciliation, catalog replay,
  `rr-cache` untouched throughout): `test/integration.test.js` "Git rerere
  never resolves or records a conflict inside vlab operations"; the suite
  runs in both Git session modes, and removing the guard from any single
  invocation site fails the test
- Decision brief and probe evidence:
  [GitHub issue #6](https://github.com/jwh3times/vcs-lab/issues/6)
