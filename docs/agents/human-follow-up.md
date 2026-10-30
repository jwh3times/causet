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
perform a handoff. A sensitive vulnerability follows the default `Security findings` route: the
detailed instructions live in the draft advisory, and only an access-appropriate draft item goes on
the board. Keep the board private; check it before adding an item.

## Follow-up label

`human-action-required`

## Follow-up board

same as Board — set `Status`, `Gate` and `Area`.
