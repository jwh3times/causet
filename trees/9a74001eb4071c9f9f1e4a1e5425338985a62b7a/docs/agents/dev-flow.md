# Development flow

The flow itself is `.agents/skills/ship/settings/dev-flow.md`, and `AGENTS.md` summarizes it. This file
holds what this repository adds.

## Reading a ready issue

A ready issue lives in `jwh3times/causet`. Read it with
`gh issue view <N> --repo jwh3times/causet --comments`. Filing a `bug` issue
needs the user's go-ahead.

An issue labelled `blocked` is not ready, even with `ready-for-agent`: its blocker hasn't
cleared ([triage labels](triage-labels.md)). With several ready issues, take them in the
board's order, which is priority order ([board fields](issue-tracker.md#board-fields)).

## The owner's steps per ticket

The owner moves every ticket on by hand, one step at a time. Each step waits for the owner's own
words, and approving one step never covers the next.

1. `/implement <n>`, or `/diagnosing-bugs <n>` for a bug.
2. Build, then an independent review, in disposable repositories only
   ([local runs](local-runs.md)).
3. `/ship`. The PR body carries a "Decisions for the owner" section, each decision with a
   recommendation.
4. CI green. Wait for it and report it without being asked.
5. "grill me": a round on those decisions, with recommendations, plus anything CI raised.
6. "confirmed": add a "Decided" section to the PR body, keeping "Decisions for the owner", and do
   what it records (a dispatch, a comment). Record CI and dispatch results there too.
7. "land it": [landing](landing.md).
8. "delete the branch".

At each boundary, stop and name the words that move it on.

- The owner often skips the grill round and says "land it" straight after the CI report. If the PR
  body still has open decisions, ask them in the same question as the landing, record the answers as
  "Decided", then land.
- If "land it" arrives when `main` has moved or a check failed, offer the routes instead of landing:
  update and re-check, update and land after the suites, or land as is. The answer covers only that
  movement.
- Ask the scope, seam and output-shape decisions up front, each with a recommendation, before the
  first test. The owner usually answers "all as recommended", and asking first saves rework.
- Find the facts before a grilling round, not during it. Checking what a refusal really prints has
  changed a PR body and two questions.

## Presenting a decision

When the owner decides an ADR or a contract, take one decision at a time: a plain summary, the edge
cases as concrete scenarios, and a recommendation. Up to four related decisions can go in one round.
Verify the ADR's premises in a disposable repository before presenting it: that is how a flaw in
ADR-0030 surfaced.

The owner pushes back when a conclusion feels too narrow, and has usually been right about the
framing. Argue the strongest version of the owner's position rather than restating your own.

## Published contracts are code

The published contracts the suites check are code, Markdown included:
`docs/schemas/`, `docs/conformance/`, `docs/canonical-json/`,
`docs/identity/`, `docs/semantic-conformance/`, `docs/native-store/` and
`docs/native-history/`.

## Exemption details

- **Dependency bumps** are Dependabot pull requests and `chore(deps):` commits.
  Today the dependencies are the Rust crates in `native/Cargo.toml` and
  `native/Cargo.lock` and the toolchain pin in `native/rust-toolchain.toml`;
  there are no npm dependencies.
- **Release prep** is what `ship` writes on each branch under
  `Scheme: stamp-on-tag` (ADR-0049): the branch's `changelog.d/` fragment,
  which version.yml stamps into the landing's dated section, and, on a branch
  that starts a new release line with the owner's approval, the version bump
  in `package.json` and `package-lock.json`. There is no release-preparation branch: every landing
  is a version, and making one stable is a dispatch of `promote.yml` that
  needs no branch, issue or pull request.

## Linking

A ticket's pull request may carry both lines, `Closes` first:

```text
Closes #308.
Part of #297.
```
