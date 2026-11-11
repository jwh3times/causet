# Triage labels

The labels and what they mean are in `.agents/skills/ship/settings/triage-labels.md`. A skill's role name is the GitHub label to apply.

## Extra labels

- `blocked`: the issue can't move until a named blocker clears: another issue, an upstream
  project, or an outside event. It sits beside the state label and replaces none of them. The
  state label says who acts once the blocker clears (`ready-for-agent`, `ready-for-human`,
  or `needs-info` when what it waits for is evidence). Name the blocker: as a GitHub
  dependency (`--add-blocked-by`) when it is an issue here, and in a comment with its link
  otherwise. Remove the label when the last blocker clears, and set the board's `Status` to
  match. A decision only the owner can make is not a blocker: that is `ready-for-human`.

For required human follow-ups, apply
[the human follow-up settings](human-follow-up.md), including its
`human-action-required` label and tracking requirements.
