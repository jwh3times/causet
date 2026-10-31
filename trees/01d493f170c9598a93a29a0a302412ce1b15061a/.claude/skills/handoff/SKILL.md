---
# GENERATED — do not edit. Source: .agents/skills/handoff/SKILL.md — regenerate with 'node scripts/sync-agents.mjs'.
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

## Transport

How the Handoffs folder reaches this machine decides whether the **Pull** and
**Push** blocks below run:

- **Desktop client** (Windows): the Proton Drive client syncs the folder by
  itself. Skip every Pull and Push block.
- **CLI mirror** (Fedora, which has no client): `HANDOFFS_DIR` names a
  local mirror folder and the `proton-drive` CLI moves files to and from the
  cloud folder `/my-files/Documents/Handoffs`. Nothing syncs unless a Pull or
  Push runs.

Decide once, at the start: CLI mirror when `command -v proton-drive` succeeds
and `HANDOFFS_DIR` is set; otherwise desktop client. A `proton-drive`
CLI with `HANDOFFS_DIR` unset means the owner has not chosen a mirror
folder yet: ask for one. A CLI reply of `You need to login first` means the
owner runs `! proton-drive auth login`, then you retry the block.

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

**Pull** (CLI mirror only): refresh the map, so the entry the other machine
wrote is the one this handoff supersedes, and list the cloud folder:

```bash
mkdir -p "$HANDOFFS_DIR"
proton-drive filesystem download -f remove /my-files/Documents/Handoffs/handoff_map.json "$HANDOFFS_DIR"
proton-drive filesystem list /my-files/Documents/Handoffs
```

The script picks an unused name by looking only at the local folder. Download
each `<repo>-handoff-<today>*.md` the listing shows and the mirror lacks, the
same way as the map, so the new document cannot overwrite one of them.

```bash
node scripts/handoff-map.mjs publish <path-to-document.md>
```

The script copies the document into the Handoffs folder as
`<repo>-handoff-<date>.md` (suffixed when the name is taken), sets this
repository's entry in `handoff_map.json`, and prints JSON with the published
`path` and the `previous` active handoff, which the report names as superseded
(its file stays in the folder). If the script cannot find the folder, ask the
owner where Proton Drive keeps `Documents/Handoffs` on this machine and rerun
with `HANDOFFS_DIR` set to it.

**Push** (CLI mirror only): the document and the map leave this machine now:

```bash
proton-drive filesystem upload -f create-new-revision -t "<path>" "$HANDOFFS_DIR/handoff_map.json" /my-files/Documents/Handoffs
```

`create-new-revision` keeps the cloud's earlier map as a revision. An unchanged
file reports as skipped, which counts as uploaded.

Complete when `node scripts/handoff-map.mjs get` reports the new file as
`active` with `"exists": true`, and on the CLI mirror the Push summary lists
both files as uploaded.

## 4. Close the session

Invoke the `end-session` skill with the Skill tool and complete it. When it
changes something the document states — lands a branch, closes an issue,
removes a stray — edit the published file at step 3's `path` so the handoff
matches the end state. On the CLI mirror, rerun step 3's Push after the edit;
the cloud copy is the one `/lets-go` reads.

## 5. Report

Rerun step 1's inventory. If anything is still unlanded, lead the report with
the `⚠️ Work not merged to main` block. Then give the published path, any
superseded handoff, and end-session's report.
