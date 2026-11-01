# Required human follow-ups

Every required human action left by agent-completed work must have a follow-up
record and executable instructions. For ordinary work, use a **public issue and
public wiki in `jwh3times/vcs-lab`**, with tracking on the **private
[vcs-lab project board](https://github.com/users/jwh3times/projects/7)**. Sensitive
vulnerability details belong in a **draft repository security advisory** until
publication is authorized. A final-answer reminder, label, local draft, or
board card alone does not fulfill the handoff.

Apply this when completing implementation, shipping changes, updating docs, or
ending a session. Examples include an owner decision, access to a real host,
manual setup, credential configuration, validation on unavailable hardware, or
user/workflow evidence required to qualify the delivered work. Do not invent
human approval gates for work the agent can complete under existing authority.

## Use the established destinations

The configured destinations are:

| Record | Destination and visibility |
| --- | --- |
| Ordinary follow-up | [Repository issues](https://github.com/jwh3times/vcs-lab/issues), public |
| Execution instructions | [Repository wiki](https://github.com/jwh3times/vcs-lab/wiki), public; indexed on `human-todo` |
| Planning and tracking | [Project 7](https://github.com/users/jwh3times/projects/7), private |
| Sensitive vulnerability discussion and instructions | Draft advisory under [repository security advisories](https://github.com/jwh3times/vcs-lab/security/advisories), restricted to authorized collaborators |

This configuration is intentional: public issues and wiki do not need a separate
private repository. Use explicit `gh --repo jwh3times/vcs-lab` arguments and
project owner `jwh3times` / number `7`. Verify the destinations and keep the board
private; do not change visibility merely to perform a handoff. A private board
does not make linked public issues or wiki pages private.

For a sensitive vulnerability, create or update a draft security advisory and
put the detailed human action, prerequisites, steps, verification, and recovery
instructions there. Use an access-appropriate private board draft item to track
it, containing only information suitable for everyone who can read that board.
Keep sensitive details and restricted links out of public issues, wiki pages,
PRs, and CI logs. Public wiki/issue publication is not required while disclosure
is restricted. Creating a draft does not authorize publishing the advisory or
requesting a CVE. Ordinary maintenance tasks do not need security advisories.
See [GitHub's advisory workflow](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/fix-reported-vulnerabilities/create-repository-advisory).

If an established destination is inaccessible, prepare the complete record and
procedure in a local scratchpad outside the tracked tree. Report the concrete
access obstacle and request only the missing access; reuse an already-pending
question. Continue independent authorized work, but report that handoff as
incomplete until publication and verification succeed. Do not ask for a private
repository for ordinary follow-ups: the destination is already settled.
Never record secret values in drafts or published procedures; name the required
input and its approved source. If non-security confidential material needs a
separate destination, resolve that specific case without moving routine work.

## Create or update the follow-up issue

Search the public repository first. Reuse an issue covering the same action;
otherwise create one issue per independently completable human action. Link the
completed source issue, PR, commit, or release. Do not duplicate existing human-action issues merely because the destination policy changed.
For security-sensitive actions, use the advisory route above instead of creating
a public issue containing the details.

The issue must include:

- the concrete human action, why it remains necessary, and the completed work
  that produced it (source issue, PR, commit, or release);
- the responsible person if known, otherwise the required role, without guessing
  an assignee;
- prerequisites, access/environment needs, dependencies, and when it must happen
  (for example, before release qualification);
- acceptance criteria, expected evidence, and where to retain that evidence;
- a link to the wiki procedure.

Apply `human-action-required` (create it if absent) and add the issue to the
verified private board. Set Status, Gate, and Area where those fields exist,
reflecting the actual dependency rather than closing or activating work merely
because its documentation exists. Preserve other labels and fields.

## Write the wiki procedure

For ordinary work, create or update a procedure page and link it from the wiki's
`Human TODO` page (use `human-todo` when creating that page). An existing
`Human TODO` page may hold the steps directly when the action is short. Link each
entry to its canonical issue; the issue remains the source of status,
ownership, and completion evidence rather than a second independent backlog.

Each procedure must provide:

1. **Purpose and owner role:** the outcome and who has the necessary access.
2. **Prerequisites:** machines, accounts, versions, access, inputs, and any work
   that must finish first.
3. **Numbered execution steps:** exact commands or UI paths, the directory/host
   where they run, clearly marked values to substitute, and the expected result
   of each meaningful step. "Ask the owner" or "run the benchmark" alone is not
   a procedure.
4. **Verification:** explicit pass/fail conditions and evidence to attach to the
   issue. Distinguish partial or skipped validation from qualification.
5. **Failure handling and cleanup:** when to stop, what to preserve, and how to
   recover or remove disposable resources where applicable.
6. **Completion:** record evidence and the decision on the issue, resolve the
   human-action label when satisfied, and update the board and wiki index to
   point to the completed outcome. Do not close the follow-up merely because
   the agent's implementation merged.

If a step needs a human decision, document the concrete options and their
consequences, what input is needed, and how to record the choice. For repeated
runs, update the existing procedure instead of creating session-specific copies.

## Verify and report the handoff

Read back the public issue, its label and private board membership/fields, and
the published wiki procedure and index link. Confirm the issue and procedure
link to each other, the public pages are accessible, and the board remains
private. For a sensitive action, verify the draft advisory and access-appropriate
board tracking instead; do not publish its details to satisfy the ordinary wiki
check.
A local wiki commit without a successful push is not publication. Update an
existing issue/page pair instead of creating duplicates on a partial retry.

Report the issue, board, and wiki links (or restricted advisory link) to the
authorized user with the remaining human action and timing. Keep restricted
advisory details and links out of public records until disclosure is authorized. Source implementation may be complete while its human follow-up
remains open; state both accurately. If no human action remains, say so without
creating filler issues or wiki pages.
