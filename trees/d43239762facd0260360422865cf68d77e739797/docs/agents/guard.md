# Guard

The commands and paths `scripts/guard.mjs` stops in this repository, on top of the rules it applies
everywhere; the format is defined in `.agents/skills/open-pr/settings/guard.md`. The command rules hold
the table in [landing.md](landing.md#all-source-control-goes-through-cst): read-only Git (`git diff`,
`git log`, `git status`, `git show`, `git merge-base`, `git ls-remote`, `git rev-parse`,
`git branch --show-current`) stays allowed.

## Deny commands

- `^git commit\b` — records no provenance; commit with
  `cst commit -m "<subject>" --generated-by <model id>` (a throwaway branch uses `cst git commit`).
- `^git push\b` — carries no records; push with `cst push -u origin <branch>`, or on the Windows
  checkout `cst push --no-records -u origin <branch>` and then the notes.
- `^git fetch\b` — brings no records; run `cst fetch origin`.
- `^git pull\b` — brings no records; run `cst pull --ff-only`.
- `^git merge(\s|$)` — lands without records; land with `cst merge <branch> --compact -m "<PR title> (#<N>)"`
  on `main`, and catch a branch up with `cst git merge --ff-only origin/main`.
- `^git (switch|checkout)\b(?=.*\s(-c|-C|-b|-B|--create|--force-create)(\s|$))` — starts a branch
  outside `cst`; run `cst fetch origin`, then `cst branch <branch> origin/main`.
- `^git branch(\s+(-f|--force|-t|--track|--no-track)(?=\s))*\s+[^-\s]` — creates a branch outside
  `cst`; run `cst fetch origin`, then `cst branch <branch> origin/main`.
- `^git clone\b` — clones without records; run `cst clone <url>`.
- `^git rebase\b` — rewrites history outside `cst`; run `cst rebase`.
- `^git cherry-pick(\s|$)` — copies a commit outside `cst`; run `cst cherry-pick`.
- `^cst commit\b(?!.*\s--generated-by(\s|=|$))` — provenance is recorded only when the commit is
  written; add `--generated-by <your exact model id>`.
- `^gh pr merge\b` — GitHub's merge records no landing; the owner's landing is
  `cst merge <branch> --compact -m "<PR title> (#<N>)"` on `main`.
- `^npm publish\b(?!.*\s--dry-run(\s|$))` — a checkout's manifest pins no platform package; the
  owner publishes with `scripts/publish-npm.ps1` after `npm login`.

## Ask commands

- `^cst (git )?push\b(?=.*\s(\S*:)?(refs/heads/)?main(\s|$))` — a push to `main` is a landing, and
  landing is the owner's call; check `git ls-remote origin refs/heads/main` first.
- `^cst git reset\b(?=.*\s--hard(\s|$))` — only for a stale landing, on the clean `main` checkout,
  after its note is removed.
- `^cst git notes\b(?=.*\sremove(\s|$))` — removes a landing's record; only a stale landing's, before
  it reaches origin.
- `^cst git branch\b(?=.*\s(-d|-D|--delete)(\s|$))` — deleting a branch needs the owner's own words,
  after `git ls-remote origin 'refs/heads/<branch>'`.

## Protected paths

- `^node_modules/` — ignored, but the user may be keeping it.
- `(^|/)[^/]*\.log$` — ignored logs the user may be keeping.
- `^(causet|causal-vcs-lab)-[^/]*\.(bundle|zip|tgz)$` — packed artifacts, ignored, but the user may
  be keeping them.
