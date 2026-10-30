---
name: docs-updater
description: Update vcs-lab README, durable documentation, and wiki guidance after implemented changes; capture required human actions as public issue/wiki follow-ups on the private board, with sensitive vulnerabilities in draft security advisories. Use when asked to update docs or reconcile documentation with completed work.
---

# Docs updater

Announce that you are using this skill. Read `AGENTS.md` and
`docs/README.md` before editing, and inspect the implemented behavior and relevant
issues/PRs so the documentation describes the delivered contract.

## Update the relevant surfaces

- Update README usage and the authoritative testing, architecture, product,
  schema, or ADR documents affected by the change. Update navigation so the
  instructions are discoverable; avoid copying the full contract into every page.
- Inspect the corresponding wiki pages and update current usage guidance. Keep
  dated audit findings historical and link them to current instructions.
- Record shipped behavior in the changelog when appropriate. Keep run-specific
  evidence and future implementation work on issues or CI artifacts.

## Required human actions

Before reporting documentation complete, apply
[the required human follow-up policy](../../../docs/human-followups.md) to every
human action left by the completed work. Create or reuse a public follow-up
issue in `jwh3times/vcs-lab`, label it `human-action-required`, track it on private
project 7, and publish a linked numbered procedure in the public wiki with an
entry on `human-todo`. Sensitive vulnerability details and procedures belong in
a draft repository security advisory with access-appropriate private board
tracking, not public pages.

The policy defines record contents, execution/verification/recovery steps,
deduplication, publication checks, and the advisory exception. These destinations
are already established; do not ask for a separate private repository. If access
is unavailable, finish the reviewable draft outside the tree and report the
specific pending handoff while continuing independent documentation work.
Do not manufacture approval requirements or duplicate already-tracked actions.

## Validate and report

Run `npm run test:docs` and `git diff --check`; check wiki navigation and links
against their intended repositories. When skills change, run
`npm run sync:agents` followed by `npm run sync:agents -- --check`; never edit
`.claude/skills/` directly. Use the user's existing shipping authorization.
Verify published docs and the issue/private-board/wiki records (or restricted
advisory) before claiming completion. Report changed pages, validation, and any
remaining human actions. Share restricted advisory links only with authorized
users; drafting an advisory does not authorize its public disclosure.
