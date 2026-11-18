# Committing and landing

This repository lands its own work with `cst`, so a commit or a push done the Git way loses records
that cannot be made again. The wiki's landing procedure
([Human-action-19](https://github.com/jwh3times/causet/wiki/Human-action-19)) is the full sequence.
This file holds what agents have got wrong running it.

## Every commit is `cst commit`

Every commit on a ticket branch is
`cst commit -m "<subject>" --generated-by <your exact model id>`. That includes the docs and
changelog commit `ship` makes, and docs-only tickets. A skill that says "commit" means `cst commit`
here.

- Provenance is recorded when the commit is written. It cannot honestly be added later, so a landing
  made from plain `git commit`s carries none: `cst provenance <landing>` shows `entries: []`. More than
  ten landings went out that way before the rule stuck.
- Give the model id exactly, with no context-window suffix such as `[1m]`.
- `cst commit` takes only `-m`. Pass a message file as `-m "$(cat <file>)"`.
- Never declare `--reviewed-by` as yourself. A provenance entry is a claim by whoever runs the
  command, and at commit time no review has happened.
- A throwaway branch that will never be merged, such as one exercising a workflow, uses plain
  `git commit` (see "Exercising a new workflow").

## Branch before the first commit

After a landing the checkout is on `main`. Before the next change's first commit, create its branch
and check `git branch --show-current` is not `main`.

When a push fails, investigate with read-only commands (`git status -sb`,
`git branch --show-current`, `git ls-remote origin`). Never retry with another refspec, and never
push `HEAD` without knowing which branch it is: `git push -u origin HEAD` from `main` once
fast-forwarded `origin/main` with no PR, no CI and no landing receipt. Admins bypass the
pull-request rule ("Repository rules" in `docs/testing.md`), so nothing on GitHub stops it.

## Landing

Landing is the owner's call ([dev-flow.md](dev-flow.md#the-owners-steps-per-ticket)). When the
owner says to land:

- **Use the build that has the fix.** The `cst` on `PATH` is an installed release and can be many
  versions behind. Land with `native/target/release/cst` (`cst.exe` on Windows) built from the
  branch.
- **Check `main` right before merging.** Run `git ls-remote origin refs/heads/main`. If it moved
  since review, stop and ask, even after "land it": approval to land covers the reviewed state.
- **Check the tree after merging.** `git diff --quiet <branch> HEAD` must succeed before anything is
  pushed, and `cst provenance HEAD` must show a `carried` entry.
- **Diverged notes.** When the local `refs/notes/causet` and origin's have both moved,
  `cst fetch origin` imports origin's records and writes a merge, after which the push is a fast
  forward. Fast-forward local `main` to `origin/main` before `cst merge`.
- **Another landing got there first.** If another session lands while yours is unpushed, both
  pushes are rejected. Remove your stale landing's note (`git notes --ref=causet remove <landing>`)
  so its record doesn't reach origin, reset `main` to `origin/main`, pull, and merge again. The tree
  no longer equals the branch's, so check instead that `git diff origin/main HEAD` equals the
  branch's own diff from its base.
- **The main checkout is busy.** When the main checkout holds a branch with someone's work in it,
  don't stash or switch it. `main` is checked out nowhere else, so a clean linked worktree can check
  out `main` and run the whole procedure. Remove that worktree afterwards.
- **Stacked pull requests.** Land the base, retarget the child with `gh pr edit --base main`, then
  land the child. Its earlier CI result still holds when the landing tree equals the reviewed tree.
- **Pushing from the Windows checkout.** Its `refs/causet/retention` diverged from origin's, so
  until the owner decides, push the notes with `git push origin refs/notes/causet`, then
  `cst push --no-records origin main`. A plain `cst push` there would publish that history, which
  can't cleanly be taken back. The wiki's step 3 has the details. `cst metadata validate` there
  reports two `workspace-path-missing` warnings for old `vlab-evidence` paths: they come from that
  machine's local registry, not the landing.

## After a landing

- The working branch is not advanced: GitHub marks the PR merged because the landing keeps the
  branch head as a parent, but the branch still points at the absorbed commit. Start the next change
  from `origin/main`.
- A landing that moved `package.json`'s release line leaves the local `cst` reporting the old
  version, and a full `npm test` then fails in install-script, integration, native-cli and
  release-packaging. Run `npm run build:native` before the next full run.
- `Closes #N` closes the issue when the landing reaches `main`, before a closing comment can be
  posted. Use `Part of #N` unless the PR really finishes the issue, and post the closing comment
  separately when it does.
- Never delete the branch as part of a landing or of the bookkeeping after it: deleting it is a
  separate step that needs the owner's own words. GitHub already deletes a merged PR's remote
  branch, so check `git ls-remote origin 'refs/heads/<branch>'` first; usually only
  `git branch -d <branch>` is left.

## Promotion and npm

A landing releases a prerelease by itself ("Releases" in `docs/testing.md`). Choosing which version
becomes stable (`promote.yml`) and publishing npm by hand are the owner's decisions, not follow-ups.
When asked for the npm publish command, give `scripts/publish-npm.ps1` after `npm login`, never
`npm publish` in a checkout.

- The sha256 and reftable suite modes run only on manual dispatch and in `promote.yml`, never in
  PR CI, so a test added since the last full run can fail a promotion. For a change that adds tests
  touching object ids or refs, run those modes locally or dispatch `ci.yml` before landing.
- `gh run view --log-failed` refuses while a run is still in progress. Read a finished job's log
  with `gh api repos/jwh3times/causet/actions/jobs/<job id>/logs`.
- A Windows corpus job can hit its 90-minute timeout on a slow runner even when nothing hangs.
  Compare its duration with the same job on the PR run before treating it as a regression.

## Exercising a new workflow

A workflow's `workflow_dispatch` can't be started until the file is on `main`. Exercise a new one
from a throwaway branch off `main` with a temporary `push:` trigger:

- Commit there with plain `git commit`: it is never merged, so it gets no records.
- Pin its inputs in the branch (a fixed seed, a small count), so it can't collide with a real run,
  and force any failure you need in `test-support/`.
- Exercise a second path, such as a comment on an existing issue or reopening a closed one, by
  re-running the same run (`gh run rerun <id>`) instead of pushing again.
- Never add the temporary trigger to the real workflow on the ticket branch.
- Afterwards close what it filed as not planned, record the evidence on the issue, and ask the owner
  before deleting the branch.
