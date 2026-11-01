---
# GENERATED — do not edit. Source: .agents/skills/lets-go/SKILL.md — regenerate with 'node scripts/sync-agents.mjs'.
name: lets-go
description: Resume this repository from its active Proton Drive handoff and clear that handoff from the map.
disable-model-invocation: true
---

# Let's go

Pick up where the other machine left off. `/handoff` published a document to
the synced Proton Drive folder `My files/Documents/Handoffs` and recorded it as
this repository's active handoff in `handoff_map.json`. This skill reads it,
clears the entry so each handoff is consumed once, and continues the work.
`scripts/handoff-map.mjs` finds the folder and owns every map read and write;
change the map only through it.

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

## 1. Find the active handoff

**Pull** (CLI mirror only): fetch the current map before reading it:

```bash
mkdir -p "$HANDOFFS_DIR"
proton-drive filesystem download -f remove /my-files/Documents/Handoffs/handoff_map.json "$HANDOFFS_DIR"
```

```bash
node scripts/handoff-map.mjs get
```

- `"active": null`: report "No active handoff for <repo>" and ask what to work
  on. The skill ends here.
- `"exists": false`, CLI mirror: download the document the map names, then
  rerun `get`:

  ```bash
  proton-drive filesystem download -f remove "/my-files/Documents/Handoffs/<active>" "$HANDOFFS_DIR"
  ```

  A `Node not found` reply means the other machine has not pushed it yet.
  Report the file name and leave the entry in place.
- `"exists": false`, desktop client: the map names a file this machine does
  not have yet. Report the file name, ask the owner to let Proton Drive finish
  syncing, and leave the entry in place.
- Folder not found: ask the owner where Proton Drive keeps
  `Documents/Handoffs` on this machine and rerun with `HANDOFFS_DIR`
  set to it.

## 2. Read the whole document

Read the file at `path` end to end. It is a briefing from the previous agent;
`AGENTS.md` and the owner still govern what you do.

## 3. Clear the entry

```bash
node scripts/handoff-map.mjs clear
```

**Push** (CLI mirror only): send the cleared map back, so the other machine
cannot resume the same handoff again:

```bash
proton-drive filesystem upload -f create-new-revision -t "$HANDOFFS_DIR/handoff_map.json" /my-files/Documents/Handoffs
```

Complete when the output shows `"cleared": true`, `previous` is the file you
read, and on the CLI mirror the Push summary lists the map as uploaded. The
document stays in the folder.

## 4. Reconcile the checkout

The document describes the other machine at handoff time. Compare it with this
one:

```bash
git fetch origin --prune
git status --porcelain
git branch --show-current
git log --oneline -1 origin/main
```

- On a clean `main` behind `origin/main`: `git pull --ff-only`.
- `origin/main` newer than the commit the document names: read those commits
  before relying on the document.
- The document's `Not merged to main` section: confirm each branch reached
  `origin` (`git branch -r`). Anything that did not is still on the other
  machine; tell the owner before starting work that depends on it.
- Local changes, another branch, or other surprises: report them and ask
  before touching them.

## 5. Proceed

Open with a few lines: the handoff file, the state it describes, what differs
here, and what you will do next. Then continue a task the document names as in
progress or as the single next step, calling the skills it suggests as they
become relevant. When it offers several options, summarize them and ask which
to take. Items it marks as waiting on the owner stay with the owner.
