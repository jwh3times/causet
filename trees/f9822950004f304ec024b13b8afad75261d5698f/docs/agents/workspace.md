# Workspace

## Private companion

none

## Workspace status command

`git status --short --branch` and `git worktree list`

## Companion commit policy

none

## Sync with main

`cst pull --ff-only`

## Safe-to-remove paths

- in the OS temp directory, fixtures an interrupted run left behind: `causet-forecast-*`,
  `causet-scale-benchmark-*`, `causet-spec-benchmark-*`, `causet-benchmark-check-*`,
  `vcs-lab-test-*`, `vcs-lab-gate-*` (a leftover `causet-scale-benchmark-*` fails the benchmark
  test's cleanup assertion next session)
- untracked strays in the checkout, listed with `git clean -nd` first

## Never-remove paths

- `refs/notes/causet` and `refs/causet/retention` — this repository dogfoods `cst`; its notes and
  retention refs are real published data
- `causet-*demo-*` repositories in the OS temp directory — the demos keep them for inspection
- `node_modules/`, `*.log`, and packed `causet-*` / `causal-vcs-lab-*` `.bundle`, `.zip` and
  `.tgz` artifacts — ignored, but the user may be keeping them
- never `git clean -x`

## Dev stack

none

## Generated-config check

`npm run sync:agents:check`, regenerated with `npm run sync:agents` — always.

## Final portability check

none

## Hook: end-session cleanup

1. List `cst` state an agent may have left in this checkout: `git worktree list`,
   `git branch --list 'causet/ws/*' 'vlab/ws/*'`, `ls -la .git/causet .git/vcs-lab`, and
   `ls -d "$(dirname "$PWD")"/*.workspaces`. Remove what an agent created by running `cst` in the
   wrong directory only after a yes; anything the user created stays.
2. Check for lingering processes, which the release gate forbids:
   `ps -eo pid,etimes,args | grep -E 'bin/vlab\.js|git-session-worker|cat-file --batch' | grep -v grep`.
3. Run the `Fast checks` in `docs/agents/ship.md`: they are the required `static checks` job's
   steps, kept in one list.
4. When source changed and was not qualified, remind the user of the qualification commands in
   `docs/testing.md` (`npm test` under each engine and session mode).
