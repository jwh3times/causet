---
# GENERATED — do not edit. Source: .agents/skills/handoff/SKILL.md — regenerate with 'npm run sync:agents'.
name: handoff
description: Hand the session off to the other machine — alert on work not merged to main, publish a handoff document to Proton Drive, mark it active in the handoff map, then run end-session.
argument-hint: "What will the next session be used for?"
disable-model-invocation: true
---

# Handoff

The owner alternates between a Windows PC and a Fedora PC. A handoff turns this
session into the next session on the other machine: a document in the synced
Proton Drive folder `My files/Documents/Handoffs`, recorded as this
repository's active handoff in that folder's `handoff_map.json`, which
`/lets-go` consumes. `scripts/handoff-map.mjs` finds the folder and owns every
map read and write; change the map only through it.

## 1. Inventory unlanded work

The other machine sees only what reached `origin/main`. Fetch, then list
everything that has not:

```bash
git fetch origin --prune
git status --porcelain --untracked-files=all   # uncommitted or untracked changes
git stash list
git worktree list                              # run git status --porcelain in each extra worktree
git log --oneline origin/main..main            # local main not pushed
git log --oneline origin/main..HEAD            # current branch commits main lacks
git branch -vv --no-merged origin/main         # local branches main lacks
git branch -r --no-merged origin/main          # pushed branches main lacks
gh pr list --repo jwh3times/vcs-lab --state open --author @me
git rev-parse --verify --quiet refs/notes/vcs-lab; git ls-remote origin refs/notes/vcs-lab
```

A branch landed with `vlab merge --compact` and never reset onto `main` still
lists as unmerged; list it anyway with what you observed, and let the owner
judge.

**Alert the owner as soon as the inventory finds anything**, before writing the
document: a block headed `⚠️ Work not merged to main` naming each item — file,
stash, branch with its ahead count, open PR, unpushed notes ref — and the
checkout or worktree holding it. Leave that work as it is unless the owner
directs otherwise, and carry on with the handoff. When the inventory is empty,
say "All work is on origin/main."

## 2. Write the document

Write it to the session scratchpad (or the OS temporary directory), outside the
checkout. It briefs a fresh agent on the other machine:

- **State**: current branch, `origin/main` commit, latest release, and a
  `Not merged to main` section listing step 1's findings (or "None").
- **What this session did and what comes next.** When the owner passed
  arguments, they describe what the next session is for; shape the document
  around it.
- **Machine-local knowledge, summarized.** Agent memory and the scratchpad stay
  on this machine, so write out the memory facts and gotchas the next task
  needs. Reference everything durable — repository files, issues, PRs, ADRs,
  commits — by path or URL.
- **Suggested skills**: which skills the next agent should call the Skill tool
  for.
- **Redaction**: no secrets, tokens, or personal data; write home directories
  as `<home>`.

## 3. Publish it

```bash
node scripts/handoff-map.mjs publish <path-to-document.md>
```

The script copies the document into the Handoffs folder as
`<repo>-handoff-<date>.md` (suffixed when the name is taken), sets this
repository's entry in `handoff_map.json`, and prints JSON with the published
`path` and the `previous` active handoff, which the report names as superseded
(its file stays in the folder). If the script cannot find the folder, ask the
owner where Proton Drive keeps `Documents/Handoffs` on this machine and rerun
with `PROTON_HANDOFFS_DIR` set to it.

Complete when `node scripts/handoff-map.mjs get` reports the new file as
`active` with `"exists": true`.

## 4. Close the session

Invoke the `end-session` skill with the Skill tool and complete it. When it
changes something the document states — lands a branch, closes an issue,
removes a stray — edit the published file at step 3's `path` so the handoff
matches the end state.

## 5. Report

Rerun step 1's inventory. If anything is still unlanded, lead the report with
the `⚠️ Work not merged to main` block. Then give the published path, any
superseded handoff, and end-session's report.
