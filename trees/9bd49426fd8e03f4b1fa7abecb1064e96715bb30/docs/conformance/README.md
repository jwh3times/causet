# Human/JSON conformance

FR-GIT-06 requires that "human-readable output shall have a JSON equivalent
for state needed by automation". This directory pins that requirement instead
of asserting it: [`fixtures.json`](fixtures.json) declares, per command, which
JSON members the human rendering must present and which it deliberately does
not, and `test/conformance.test.js` runs every fixture against the real CLI in
a disposable repository (ADR-0015 phase 0b, issue #11 item 5).

**Authority.** The CLI is the authority; these fixtures describe it. The test
fails in both directions — a required member that stops appearing in the human
text, and a member declared JSON-only that starts appearing — so neither the
renderers nor this file can drift silently. A future Rust CLI must satisfy the
same file.

## How output modes work

`print(value, json)` in `src/cli.js` emits JSON when `--json` is passed **or
when the value is not a string**. A command therefore has a human rendering
exactly when its handler builds one with a `format*` function. That splits
every command into three kinds, and only the first can have a parity contract
at all.

| Kind | Meaning | Conformance |
| --- | --- | --- |
| `paired` | Prints text by default and a record with `--json` | Checked field by field |
| `json-only` | Prints JSON whatever the flags; `--json` is a no-op | Vacuous: there is no human text to fall short of the JSON |
| `text-only` | Has no `--json` output at all | Checked for the reverse violation: no state automation needs may be text-only |

`--json` is parsed per command, not globally, so it must follow the command
word: `vlab receipts --json`, never `vlab --json receipts`.

## Match rules

The human text abbreviates. Each required member declares how its JSON value
must appear:

| Rule | Meaning |
| --- | --- |
| `exact` | The value's string form appears verbatim |
| `prefix` | A leading substring of at least `minPrefix` characters appears; this covers the 12-character short OIDs of `short()` and the truncated lineage id |
| `mapped` | The value is looked up in the entry's `render` table first, so `false` can be checked as `no` and `"source-checkpoint"` as `immutable source checkpoint` |
| `count` | The member is an array and the human text presents its length rather than its items |
| `present` | The member's own label appears; used where the value is prose the renderer rewords |

`jsonOnly` members carry a `reason` and are asserted **absent** from the human
text, which is what stops the declaration from rotting into a list of things
that quietly became visible.

## Running a command twice

Parity needs both renderings of the same state. Fixtures declare how to get
them:

- `reread` — the command is a pure read, so the test runs it twice in one
  repository, once plain and once with `--json`.
- `readback` — the command mutates, so the test runs it once in human mode and
  then re-derives the same record from the same repository with a read command
  (`vlab receipts --json`, for instance). Values stay comparable because both
  come from one repository; identity values are random per repository, so
  comparing across two repositories would not work.

## Deliberate gaps

These are not defects to be fixed silently; they are the current contract, and
each is recorded in `fixtures.json` so a change to any of them is visible.

### Commands with no human rendering

`commit`, `merge`, `compact-merge`, `hard-squash`, `cherry-pick`,
`reconcile --abort`, `rebase --abort`, `workspace create`, `workspace list`,
`workspace checkpoint`, `workspace move`, `workspace archive`,
`workspace restore`, `workspace repair`, `workspace prune`, `proof-bundle`,
`spec show`,
`spec benchmark`, and `doctor` print their record as JSON whatever the flags.
FR-GIT-06 is satisfied trivially — the JSON *is* the output — but the
[schema catalog](../schemas/README.md) should not be read as promising text
from them.

### State that is text-only

- `vlab graph` renders an ASCII history graph and a folded view of causal
  edges. The graph is a presentation of Git history that `git log --graph`
  already provides, and every causal edge it draws comes from records
  `vlab receipts --json` returns in full. What has no JSON form is the folding
  itself — the correlation of a reconciliation record with the application
  that consumed it — which is presentation, not state.
- `vlab init` and `vlab branch` print an acknowledgement. The state they
  create is a Git ref, readable with Git.
- `vlab help` prints the command inventory. Automation cannot enumerate
  commands from JSON; this is a known limitation, not a state gap.

### Fixed rather than declared

Four renderers asserted a value as fixed prose instead of reading the record,
so the human text could contradict the JSON beside it. They now read the
record, and the fixtures pin them:

- `formatRebaseForecast` printed `scope        committed heads only`
  unconditionally while `scope` is a real member, and claimed the caller
  worktree was unchanged without consulting `callerInvariants.preserved`.
- `formatScaleBenchmark` printed `service now  no` instead of
  `analysis.residentService.recommendedNow`.
- `formatMetadataStatus` and `formatMetadataTransfer` printed
  `not signed or authorized` instead of reading `trust`.

`formatRebaseForecast` also gained the `same state` line its reconciliation
counterpart already had, and `vlab doctor` gained `version`: `vlab version` is
text-only, so the build identity a peer needs to apply the compatibility rules
of [ADR-0020](../adr/0020-freeze-per-family-compatibility-and-resource-bounds.md)
had no machine-readable home.

## Changing a renderer

Adding a line to a human renderer that surfaces a `jsonOnly` member, or
removing one that surfaces a required member, fails the suite. Update
`fixtures.json` in the same commit and say which way the contract moved.
