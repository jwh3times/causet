# Issue tracker: GitHub

Issues and implementation specs live in GitHub Issues in
`jwh3times/vcs-lab`. Use the `gh` CLI with explicit
`--repo jwh3times/vcs-lab` arguments.

Follow the Work Tracking rules in [AGENTS.md](../../AGENTS.md).
Track future work on project 7, owned by `jwh3times`, with its
prerequisite gate recorded. Dated progress belongs on the issue.

## Operations

- Create: `gh issue create --repo jwh3times/vcs-lab --title "..." --body-file <path>`
- Read: `gh issue view <number> --repo jwh3times/vcs-lab --comments`
- List: `gh issue list --repo jwh3times/vcs-lab --state open --json number,title,body,labels`
- Comment: `gh issue comment <number> --repo jwh3times/vcs-lab --body-file <path>`
- Label: `gh issue edit <number> --repo jwh3times/vcs-lab --add-label "..."`
- Remove label: `gh issue edit <number> --repo jwh3times/vcs-lab --remove-label "..."`
- Close: `gh issue close <number> --repo jwh3times/vcs-lab`

Use a temporary UTF-8 file for multiline bodies.
Run authenticated GitHub commands and remote Git operations outside
the Windows sandbox. Keep authentication tokens out of output,
workspace files, and environment variables.

When a skill says "publish to the issue tracker," create an issue.
When it says "fetch the relevant ticket," read the issue and comments.
Publishing and commenting require authorization from the active task.

## Pull requests as a triage surface

**PRs as a request surface: no.**

## Wayfinding

Use one `wayfinder:map` issue with child issues labeled
`wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`,
or `wayfinder:task`.

Link children using GitHub sub-issues. If unavailable, use a task
list in the map and `Part of #<map>` in each child.

Record blockers using native GitHub issue dependencies. If unavailable,
write `Blocked by: #<number>` in the child. Select the first open,
unassigned child in map order whose blockers are all closed.

Claim the child by assigning the driving developer. Record the result
on the child, close it when complete, and add a concise result and link
to the map's Decisions-so-far.

## Human follow-ups

Apply [the human follow-up policy](../human-followups.md) when completed
work leaves required human actions.
