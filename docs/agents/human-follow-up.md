# Human follow-up

Every required human action left by agent-completed work gets a follow-up record and executable
instructions, by the procedure in the installed skills' `human-follow-up` settings definition (for
example `.agents/skills/end-session/settings/human-follow-up.md`). A final-answer reminder, label,
local draft or board card alone does not fulfill it. Do not invent approval gates for work the agent
can complete under existing authority.

A release gate is never a follow-up: every release gate runs on GitHub-hosted runners
(`docs/testing.md`, "Release gate"). What a release still needs from a person is an account or a
decision, such as an npm publish.

The public destinations are intentional: ordinary follow-ups need no private repository, and the
private board does not make the issues or wiki pages it links private. Do not change visibility to
perform a handoff. A sensitive vulnerability follows `Security findings` in `issue-tracker.md`: the
detailed instructions live in the draft advisory, and only an access-appropriate draft item goes on
the board. Creating a draft advisory does not authorize publishing it or requesting a CVE.

Beyond the shared procedure:

- Name the responsible role; never guess an assignee.
- For a decision, record the options and the consequences of each.
- State the acceptance criteria and where the completion evidence is kept.
- A local wiki commit without a successful push is not publication.
- A merged implementation does not close its follow-up; only evidence the human action was done
  does.
- Keep the board private; check it before adding an item.

## Follow-up destination

Issues in jwh3times/causet (public), selected explicitly with `--repo jwh3times/causet`.

## Follow-up label

`human-action-required`

## Follow-up board

same as Board — set `Status`, `Gate` and `Area`.

## Follow-up wiki

The public repository wiki (`https://github.com/jwh3times/causet.wiki.git`), index page
`human-todo`. Push without asking: publishing the instructions is part of the follow-up.
