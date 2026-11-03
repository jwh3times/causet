---
# GENERATED — do not edit. Source: .agents/skills/end-session/SKILL.md — regenerate with 'npm run sync:agents'.
name: end-session
description: End a vcs-lab work session cleanly — capture what was learned into memory, record required human follow-ups in public issues/wiki and the private board, with sensitive vulnerabilities in draft advisories; bring GitHub issues and durable records (ADRs, product gates, changelog debt, retained evidence) up to date, and clean the local checkout of disposable fixtures, stray worktrees, and runtime state. Use when the user says "end session", "wrap up", "done for the day", or asks to clean things up before stopping.
---

# End session

The charter, verbatim:

> clean up the local workspace, and update memory, GitHub issues, and any
> durable records that need it from this session.

**Announce at start:** "I'm using the end-session skill to close out this
session."

## Why this exists

A session's durable output is not just the diff. It also produces things that
live outside the tracked tree, each of which rots silently if nobody writes to
it: **memory** (what the agent now knows about this project that the docs do
not say), **GitHub issues and their project board** (the only tracker, for
active work, implementation briefs, handoffs, and deferred follow-ups),
**durable records** (ADRs, `docs/product.md` §15, the changelog's `Unreleased`
section, and evidence retained where `docs/README.md` says it belongs), and the
**local checkout** (disposable Git fixtures in the OS temp directory, worktrees
or `vlab/ws/*` branches that an agent created by mistake, runtime state under
`.git/vcs-lab/`, lingering Git session processes, and static-check drift that
fails the next session for unrelated reasons).

This skill is a sweep over those four, in that order, at the end of a work
session. It applies equally when Claude Code or Codex ran the session; the
memory lane applies only to an agent that has a persistent memory directory.

## Ground rules

- **Nothing invented.** If a lane has nothing to record, say "nothing to
  record" for that lane and move on. A speculative memory or a filler issue
  comment is worse than silence.
- **Nothing destroyed without a yes.** Every deletion, branch removal, worktree
  removal, or discard is shown as a list first.
- **Respect existing shipping authority.** Session cleanup alone does not
  authorize source commits, releases, or unrelated publication; honor the user's
  existing instructions when those actions are already authorized. Required
  human follow-up issues, board updates, and wiki commits/pushes are part
  of the requested handoff under `docs/human-followups.md`. Verify destinations
  before publishing. Source documentation changes normally belong to the work
  commits; record outstanding debt when they are outside the authorized scope.
- **Never run destructive experiments in this checkout.** `vlab` commands
  mutate the refs, notes, and workspace registry of whatever repository is the
  working directory. Experiments belong in disposable repositories under the
  session scratchpad or `os.tmpdir()`, never in the checkout itself.

## Steps

### 1. Scope the session

Establish what actually happened before writing anything. Read the
conversation, then confirm it against the repository:

```bash
git status --porcelain
git branch --show-current
git log --oneline --since=midnight        # anything landed today
git tag --contains HEAD~5 2>/dev/null     # releases cut recently
gh issue list --state open --limit 20
gh pr list --author @me --state all --limit 5
```

Then name, out loud, the session's four buckets: what was **learned**, what
**issue** work it touched, what **durable records or evidence** it produced or
made stale, and what **files, fixtures, refs, or processes** it left behind.
The rest of the skill works that list.

### 2. Update memory (agents with a memory directory)

Memory lives outside the repository in the agent's project memory directory
(for Claude Code, `~/.claude/projects/<project-slug>/memory/`, where the slug
encodes the checkout path), one fact per file with `name` / `description` /
`metadata.type` (`user`, `feedback`, `project`, `reference`) frontmatter and a
one-line pointer in `MEMORY.md`. Codex sessions skip this lane and say so.

- **Prefer updating an existing file to creating a new one.** This project's
  standing memories are the usual landing spots: the agent-hygiene note (why
  subagents must use disposable repositories), the release and scan-batching
  state note, and the native-substrate decisions note. Read `MEMORY.md` first.
- **Do not save what the repository already records.** `AGENTS.md`,
  `docs/product.md`, `docs/architecture.md`, `docs/adr/`, the project board,
  the changelog, and Git history are durable. Memory is for what is not written
  down: a trap that cost an hour, a preference the user stated, a host-specific
  measurement that shaped a decision, the state of uncommitted or half-decided
  work.
- Convert relative dates to absolute (`today` becomes `2026-08-28`) and link
  related memories with `[[slug]]`.
- **Delete or correct memories this session falsified.** A memory that is now
  wrong is worse than a missing one; a note that says work is uncommitted after
  it was pushed is the standing example.

### 3. Update GitHub issues

Issues are the tracker for active work, bugs, implementation briefs, and
session handoffs (`docs/README.md`). Use explicit `gh --repo owner/repo`
arguments for follow-ups in `jwh3times/vcs-lab`; ordinary issues and wiki pages
are public, project 7 is private, and sensitive vulnerabilities use draft advisories. Preserve existing labels and use
`human-action-required` for required human dependencies.

Ordinary source work sits on the
[vcs-lab project board](https://github.com/users/jwh3times/projects/7). Its
`Status`, `Gate`, and `Area` fields are a cheap view; the issue body and its
comments remain the record, so never let a fact live only on a card. Two things
are worth doing at session end: put any issue this session opened onto the board
with a Status and a Gate, and move any item whose gate this session cleared.
`gh` needs the `project` scope for either to work — check with `gh auth status`
and look for `project`, not `read:project`, because it fails silently without
it.

For each issue this session touched:

- **Record decisions where the docs cite the issue.** ADRs and `docs/product.md`
  cite issue numbers as the durable record of an implementation brief (ADR-0013
  cites issue #1); the project board is a view over those issues, never the
  record itself. A decision reached in conversation and never commented onto
  its issue is effectively lost: `gh issue comment <n> --body "..."`.
- **Close what shipped**, naming the commit or tag that delivered it:
  `gh issue close <n> --comment "..."`. If the work merged but a follow-up
  remains, close the issue and open or reuse the follow-up rather than leaving
  a half-done issue open. Human follow-ups must use the established destinations in
  the policy below; do not close them with the implementation issue.
- **Open issues for deferred work discovered this session**: the divergence
  you noticed and chose not to fix, the ADR a conversation decision still
  needs, the evidence rerun another host must produce. Write the body to a file
  in the scratchpad and pass `--body-file`; a heredoc through this shell
  mangles long Markdown. Say which document, ADR, or issue the new issue serves,
  and put it on the appropriate board; human follow-ups use the issue/wiki or advisory route below.
- **Attach evidence to issues rather than the tree.** Benchmark JSON, gate
  logs, and review outputs from the scratchpad belong in an issue comment, a
  pull request, or a CI artifact, never as a committed timestamped report.

### 3a. Complete every required human handoff

Read and apply [the required human follow-up policy](../../../docs/human-followups.md).
Inventory every human action left by completed work, including setup, owner
choices, real-host measurements, manual validation, and user evidence. For each,
create or reuse a public follow-up issue, apply `human-action-required`, add it
to the private board, and publish the linked public wiki procedure
with numbered execution steps, prerequisites, expected results, verification,
cleanup/recovery, and completion evidence. Link it from `Human TODO`.

This is required even when implementation and public documentation have shipped.
A reminder in the final response or an issue without its procedure does not
fulfill the handoff. Sensitive vulnerability actions use a draft security
advisory for the detailed instructions and access-appropriate private board
tracking, without public wiki disclosure. Verify the published records. The
public issue/wiki and private board destinations are settled; do not request a
separate private repository. If access is unavailable, prepare the complete local
draft, report that handoff as pending, and continue other session work. Do not
invent blockers for work the agent remains authorized and able to perform.

### 4. Update durable records and retained evidence

Keep the durable records described by `docs/README.md` and the evidence policy
in `docs/testing.md` current. Required human execution instructions also live in
the public repository wiki under the policy above, except restricted security
procedures that remain in draft advisories until disclosure is authorized.

- **Decisions without a record.** If the session reached a decision that
  changes a durable contract (a schema, an algorithm, a persistence scope, a
  gate, a supported baseline) and no ADR or issue records it, do not
  write the ADR here; open an issue that names the decision and the ADR it
  needs, and say so in the report.
- **Dated progress belongs on the issue.** What landed when, on which host,
  with which numbers, goes in an issue comment — never restated into a
  maintained document. The documents describe what is true now; only the
  changelog carries dates.
- **Changelog debt.** Every behavior change committed this session should
  already have a bullet under `CHANGELOG.md` `Unreleased` from its own commit.
  If one is missing, note it as debt in the report; do not edit the changelog
  in this pass.
- **Evidence retention.** Performance results go into an ADR only when they
  support a decision; machine-readable baselines are committed only when an
  automated check consumes them; individual runs, logs, hashes, and
  host-specific figures stay with the issue, pull request, or CI run. Nothing
  timestamped, workstation-specific, or tied to a commit under test is
  committed, and no archive directory is added for superseded session
  documents.
- **Published pages.** If the session published or updated a shareable page
  (a strategy exploration, a review summary) and later decisions made it
  stale, update it or note the staleness; do not let a page contradict the
  ADRs.
- **Sweep the tracked tree.** Scratch files, session handoffs, result reports,
  packed tarballs, and benchmark output must not be sitting in the checkout
  waiting to be committed. Move them to the scratchpad or an issue, or delete
  them after showing the list.
- **No second tracker.** A `roadmap.md`, `backlog.md`, `handoff.md`, `TODO.md`,
  `plan.md`, or `next-steps.md` anywhere in the tree is a regression: GitHub is
  the only tracker, and a parallel Markdown list drifts from it silently. If one
  appeared this session, move its content onto issues and say so in the report.

  ```bash
  git ls-files | grep -Ei '(roadmap|backlog|handoff|todo|next.?steps|plan)\.md$'
  ```

### 5. Clean the local checkout

Show findings before acting. Work through:

- **Uncommitted work**: `git status --porcelain`. Ask what to do with it;
  never commit silently and never discard. If it is mid-flight work the user is
  returning to, leaving it dirty is a valid answer, but say so in the report.
- **Untracked strays**: `git status --porcelain --untracked-files=all` and
  `git clean -nd` (dry run). Show the list and get a yes before `git clean -fd`.
  Never `git clean -x`: the ignored set includes `node_modules/`, `*.log`, and
  packed `causal-vcs-lab-*.bundle` / `.zip` artifacts the user may be keeping.
- **Repository state that `vlab` or an agent left in this checkout.** The real
  checkout should normally have one worktree, no `vlab/ws/*` branches, no
  `.git/vcs-lab/` runtime directory, and no `refs/vcs-lab/*` or
  `refs/notes/vcs-lab` unless the user deliberately dogfoods `vlab` here.
  Inspect before touching anything:

  ```bash
  git worktree list
  git branch --list 'vlab/ws/*'
  ls -la .git/vcs-lab 2>/dev/null
  git for-each-ref refs/vcs-lab refs/notes/vcs-lab
  ls -d "$(dirname "$PWD")"/*.workspaces 2>/dev/null
  ```

  Anything an agent created by running `vlab` with the wrong working directory
  is listed with its timestamp and removed only after a yes
  (`git worktree remove --force <path>`, `git branch -D <branch>`,
  `git worktree prune`, deleting `.git/vcs-lab/`). Anything the user created on
  purpose stays.
- **Disposable fixtures in the OS temp directory.** Tests, forecasts, and the
  benchmarks remove their own `vcs-lab-test-*`, `vcs-lab-forecast-*`,
  `vcs-lab-scale-benchmark-*`, `vcs-lab-spec-benchmark-*`, and
  `vcs-lab-benchmark-check-*` repositories, so
  any of those left behind mark an interrupted run; the demos keep
  `vcs-lab-*demo-*` repositories by design for inspection; gate or experiment
  scripts may leave `vcs-lab-gate-*` and similar. List them and remove after a
  yes; a leftover `vcs-lab-scale-benchmark-*` directory makes the benchmark
  test's cleanup assertion fail in the next session.

  ```bash
  ls -d "$(node -e 'console.log(require("os").tmpdir())')"/vcs-lab-* 2>/dev/null
  ```

- **Lingering processes.** The release gate requires that no VCS Lab Node or
  Git process survives a run:

  ```bash
  ps -eo pid,etimes,args | grep -E 'bin/vlab\.js|git-session-worker|cat-file --batch' | grep -v grep
  ```

- **Session scratchpad.** Keep evidence an open issue still references; clear
  finished experiment repositories, review outputs, and packed tarballs.
- **Static checks.** Leaving these red fails the next session for unrelated
  reasons:

  ```bash
  git diff --check
  npm run test:docs
  npm run sync:agents -- --check      # .claude/skills mirrors .agents/skills
  for f in $(git ls-files 'src/*.js' 'bin/*.js' 'scripts/*.mjs' 'test/*.js'); do node --check "$f"; done
  ```

  Fix skill drift with `npm run sync:agents`; never hand-edit
  `.claude/skills/`, it is generated from `.agents/skills/`. If source changed
  and was not qualified, remind the user that `npm test`,
  `VLAB_GIT_SESSION=1 npm test`, `VLAB_GIT_SESSION=0 npm test`,
  `VLAB_FORECAST_ENGINE=worktree npm test`,
  `VLAB_FORECAST_ENGINE=merge-tree npm test`, and `VLAB_ENGINE=native npm test`
  are the qualification commands (about 60 seconds each on Linux, five
  minutes on Windows); run them only if asked. Routine CI runs default-mode
  suites (Ubuntu and Windows for code PRs, Ubuntu for main); the full matrix
  requires manual dispatch of `.github/workflows/ci.yml`. See
  `docs/testing.md` for release and high-risk qualification requirements.
- **Nothing staged that must never be committed**: `git diff --cached
  --name-only` must contain no benchmark JSON, gate or review logs, packed
  tarballs, bundles, scratch scripts, or files with machine-local paths.

### 6. Report

One short paragraph per lane — memory, issues, durable records, checkout —
naming what changed and what was deliberately left alone. End with **what is
still open**: the uncommitted work, the issue awaiting a reply, the evidence
another host still has to produce, the next increment on the board. That
paragraph is what makes the next session cheap to start. Include verified
follow-up issue, private board, and wiki links (or restricted advisory links) for the authorized user; report
any unpublished handoff and its concrete obstacle separately. Do not claim all
follow-ups are documented when only local drafts exist.

## Do not

- Infer authority for source commits, releases, or unrelated publication from
  cleanup alone. Existing user shipping instructions and the required issue/wiki or draft-advisory
  follow-up documentation remain applicable.
- Run `vlab` or any state-changing Git command against this checkout as an
  experiment; use disposable repositories.
- Delete uncommitted or untracked files, branches, worktrees, or temp
  fixtures without showing the list first.
- Rewrite `README.md`, `AGENTS.md`, `CHANGELOG.md`, or `docs/` outside the
  authorized work; record remaining debt as an issue instead.
- Invent memories, issue comments, or evidence to make a lane look productive.
