# Repository Guidelines

## Project Structure & Module Organization

`native/` is the implementation, a Rust workspace: `core` (bounded read-only
Git object access), `model` (the record model, the authority for every record
family, bound and error code), `engine` (the Git engine; every repository read
is an operation of its seam, `engine/src/engine.rs`), `store` (N1's native
content store, built to `docs/native-store/`), `import` (Git import into a
native repository, reading Git through the engine's process module), and `cli`
(the `cst`
command, one module per command family, with `front.rs` deciding each
invocation). `bin/native/` is the npm launcher the main package ships. The
JavaScript CLI that was the oracle until #243 is gone; its answers are frozen
under `test/fixtures/oracle/`, and a change to one is a decision that the Rust
answer is right, said in the change. `test/integration.test.js` exercises the real CLI against disposable Git
repositories, `test/schema-catalog.test.js` keeps the published JSON
Schema catalog in `docs/schemas/` in agreement with the runtime validators of
the Rust record model in `native/model` (the authority since #243), and
`test/schema-compatibility.test.js` keeps the published compatibility contract
in `docs/schemas/compatibility.md` in agreement with its `RECORD_FAMILIES` and
`RESOURCE_BOUNDS` registries, and
`test/conformance.test.js` runs the human/JSON parity fixtures in
`docs/conformance/fixtures.json` against the real CLI.
`test-support/git-environment.js` is the isolated Git environment every suite
file imports; it lives outside `test/` because `node --test` runs every
JavaScript file there as a test. Maintained demonstrations and
repository utilities live in
`scripts/`; `benchmarks/baseline.json` is the per-host benchmark baseline that
`npm run test:benchmark` consumes. Product, architecture, testing, schema, and
ADR documentation lives under
`docs/`; keep only `README.md`, `CHANGELOG.md`, this guide, and the thin
`CLAUDE.md` that imports it at the root. Agent skills are canonical in
`.agents/skills/` and mirrored into `.claude/skills/` by `npm run sync:agents`
so Codex and Claude Code read the same instructions; never hand-edit the
mirror.

## Build, Test, and Development Commands

Developing and testing need Node.js 20+, Git 2.40+ and the Rust toolchain
`native/rust-toolchain.toml` pins. The released `cst` is the Rust executable
in `native/`, which needs Git only, and it is what the suites run (#243):
`npm run build:native` builds it, and `npm test` fails without it. There are
no npm dependencies.

- `npm test` runs the complete Node integration suite.
- `npm run test:docs` checks local Markdown links and anchors, and that the
  doc map in `docs/agents/docs.md` lists every document.
- `.github/workflows/ci.yml` runs static checks on every PR and push to `main`.
  Code PRs add the default suite on Ubuntu and Windows; main adds Ubuntu only.
  Known documentation-only changes omit suites. Manual dispatch runs every
  mode on both platforms plus the Node 20 floor; use it for release and
  high-risk platform qualification as described in `docs/testing.md`.
  The per-host benchmark remains local.
- `.github/workflows/perf.yml` runs `scripts/perf-checkpoint.mjs` on hosted
  Windows and Ubuntu runners: on manual dispatch, weekly on `main`, and for PRs
  touching `native/`, the harness, or the workflow. It reports only what a
  shared runner can measure fairly (equality, exit status, Git process counts,
  and comparisons within one run). Timings never fail it; the absolute
  reference stays the local procedure on the wiki's Performance testing page.
- `.github/workflows/corpora.yml` runs the heavy corpora of ADR-0044 item 7,
  the generated-history corpus (`test/generated-histories.test.js` with
  `CAUSET_GENERATED_HISTORIES=1000`) and the real repositories with the
  storage gate (`test/real-repositories.test.js` with
  `CAUSET_REAL_REPOSITORIES=<name>`), on hosted Windows and Ubuntu runners:
  weekly on `main`, on manual dispatch, as release gate 11 from
  `release-gates.yml`, and for PRs touching the corpora.
- `.github/workflows/release.yml` builds the `cst` executable per platform,
  packs the ADR-0038 package set with `scripts/pack-release.mjs`, and installs
  it on each runner, by npm and by `scripts/install.sh` or
  `scripts/install.ps1`. Pull requests touching the packaging and manual dispatch
  are dry runs; a `v*` tag drafts the GitHub release and, when the repository
  variable `NPM_PUBLISH` is `true`, publishes to npm. See "Release packaging"
  in `docs/testing.md`.
- `.github/workflows/release-gates.yml` runs the release gates that are not
  the suite or the package set (demos, this repository's metadata validation,
  the deterministic benchmark check) on hosted Windows and Ubuntu runners.
  Every release gate runs in GitHub Actions; never write one that needs a
  maintainer's own machine. See "Release gate" in `docs/testing.md`.
- `npm run test:benchmark` compares bounded benchmarks against the committed
  per-host baseline in `benchmarks/baseline.json`; `npm run benchmark:record -- --host <label>`
  refreshes an explicitly identified machine's entry on a quiet machine. Use the
  same `-- --host <label>` for checks, or set `CAUSET_BENCHMARK_HOST`; otherwise
  latency comparison is skipped and the deterministic counts compare against the
  most recent identified entry for the same platform.
- `npm run sync:agents` regenerates `.claude/skills/` from `.agents/skills/`;
  it also generates `.codex/agents/*.toml` from `.claude/agents/*.md`.
  `npm run sync:agents:check` reports drift without writing. The generator,
  `scripts/sync-agents.mjs`, and its test are copies of the canonical ones (see
  "Shared skills" below). Before adding or updating agent definitions, read
  [the mirror conventions](docs/agents/mirrors.md).
- `npm run lint:agents` checks that the authored agent and skill sources read
  correctly from both the source and the mirrored tree.
- `npm run demo` runs the primary workflow demonstration; the other `demo:*`
  scripts exercise conflicts, resolutions, forecasts, specs, and Git sessions.
  Each deliberately leaves its repository in the OS temporary directory for
  inspection, so they accumulate; `npm run demo:clean` lists those fixtures and
  `npm run demo:clean -- --apply` removes them (`-- --all` also sweeps fixtures
  an interrupted test or benchmark run left behind).
- `native/target/release/cst --help` runs the build directly. The old name,
  `vlab`, is no longer installed (removed in v0.23.0, ADR-0038 §4).

## Coding Style & Naming Conventions

Use ESM imports, two-space indentation, double quotes, and semicolons, matching
the existing source. Prefer `camelCase` for functions and variables,
`PascalCase` for classes, `UPPER_SNAKE_CASE` for constants, and descriptive
kebab-case module names. Keep synchronous Git orchestration explicit and avoid
adding dependencies without a demonstrated need. There is no configured
formatter or code linter (`npm run lint:agents` covers only agent and skill
sources); run `git diff --check` and `node --check <file>`.

## Testing Guidelines

Tests use `node:test` and descriptive behavior names such as
`test("stale forecasts fail before starting a reconciliation", ...)`. Add
regression coverage for observable changes and use temporary repositories for
history-changing cases. For Git-session, forecast, read-path, or cross-cutting
changes, run `npm test`, `CAUSET_GIT_SESSION=1 npm test`, `CAUSET_GIT_SESSION=0 npm test`
(the session default differs by platform, so both are forced on every host),
`CAUSET_FORECAST_ENGINE=worktree npm test`, `CAUSET_FORECAST_ENGINE=merge-tree npm test`
(the default forecast engine differs by platform), and `CAUSET_ENGINE=native npm test`
(every read must pass through the engine seam, `native/engine/src/engine.rs`).
For changes to native code, also run `CAUSET_KIND=native npm test`, which
imports every test's repositories and holds N1's commands on the copies to
Git's answers (`test-support/native-kind.js`, ADR-0044).
Every CLI launch in the suites goes through `test-support/cst-command.js`,
which runs the Rust build; never spawn a CLI directly, so that
`CAUSET_CLI=<executable> npm test` can run the same suites against another
implementation of the CLI (ADR-0037). No numeric coverage threshold is
defined; preserve the behavioral and failure-safety guarantees in
`docs/testing.md`.

## Commit & Pull Request Guidelines

Recent history uses concise imperative subjects with conventional prefixes:
`feat:`, `fix:`, `docs:`, and `chore:`. Keep each commit scoped to one coherent
change. Pull requests should explain intent and compatibility impact, link
their issue as
[the development flow](.agents/skills/ship/settings/dev-flow.md#linking-work-to-its-issue)
requires and any relevant ADR, list validation commands and results, and
update the README, changelog, or durable docs when contracts change. Screenshots are
normally unnecessary for this CLI; include focused terminal output when it
clarifies behavior.

`main` and the `v*` release tags are protected by repository rulesets, and
squash and rebase merging are off; land only with `cst merge --compact` and
never force-push `main` or move a release tag. See "Repository rules" in
`docs/testing.md`.

## Work Tracking

GitHub is the only tracker. Future work is issues on the
[causet project board](https://github.com/users/jwh3times/projects/7), each
carrying the gate that must clear before it can start; dated progress on an
item belongs on its issue, and `CHANGELOG.md` is the one dated narrative of
what shipped. Do not add a Markdown backlog, roadmap, continuation brief, or
TODO file beside the tracker — a second list is a list that will disagree.

What stays in the tree is what has no "done": product intent and the investment
gates (`docs/product.md`), decisions (`docs/adr/`), the implemented system
(`docs/architecture.md`), the published contracts (`docs/schemas/`,
`docs/conformance/`, `docs/identity/`, `docs/canonical-json/`), and how to
validate (`docs/testing.md`).

## Development flow

<!-- shared:development-flow -->

The flow skills are this repository's binding process for changing code. Read
`.agents/skills/ship/settings/dev-flow.md` (the routing, exemptions and issue linking) and
`docs/agents/dev-flow.md` (what this repository adds) before the first edit of a change, and whenever
no ready issue exists. `/ask-matt` maps the flow itself.

- **The gate.** Every code edit starts from a ready issue: an open `ready-for-agent` issue whose body
  is a `/to-spec` spec or a `/to-tickets` ticket or that carries a `/triage` brief, or a `bug` issue
  worked through `/diagnosing-bugs`, which needs the number and no spec. With none, stop before the
  first edit and route the user. Reading code, running tests and answering questions need no issue.
- **Private work.** A ready issue in the private tracker counts. Its number stays out of the branch,
  the PR, commits and public issues, and it is closed by hand after the merge.
- **The human starts every phase.** `/wayfinder`, `/grill-with-docs`, `/to-spec`, `/to-tickets`,
  `/implement` and `/triage` stay user-invoked. At a phase boundary, name the next command, say in
  one line why, and wait. Inside a phase, use `/tdd`, `/code-review`, `/diagnosing-bugs`,
  `/domain-modeling`, `/codebase-design`, `/prototype` and `/research` whenever they fit.
- **Exempt from the gate:** dependency bumps, changes touching only docs and agent config, release
  prep, and an explicit user waiver recorded in the PR body as `Flow waived by the user: <reason>`.
- **Linking.** Branches are `<type>/<issue#>-<slug>`; the PR body opens with `Closes #N` or
  `Part of #N`.
- **The flow ends at `/ship`.** `/implement` stops at a commit; `/ship` refreshes the docs, writes the
  changelog and the PR body, and opens the PR. `/ask-matt` also routes to `/pr`, `/retro` and
  `/implement-spec`, which are not installed here.
- **`/handoff` is the shared skill.** It parks the session for another machine or harness, closes it
  out with `/end-session`, and `/lets-go` resumes it. It does not write the portable file `/ask-matt`
  describes, so a `/prototype` detour stays in the session or uses a branch.
- **A wizard is not the record.** A step only a human can take follows the `## Procedure` in
  `.agents/skills/ship/settings/human-follow-up.md`, whose instructions stand without the script.
- **Research goes where it is safe to keep.** `/research` findings that would expose private material
  go to the private companion, where there is one, never to an ignored folder with no repository
  behind it. Details of an unpublished vulnerability are a draft advisory, never a research file.

<!-- /shared:development-flow -->

## Required Human Follow-ups

Every required human action left by agent-completed work must have a public
follow-up issue in `jwh3times/causet`, the `human-action-required` label, a card
on the private project board, and linked step-by-step instructions in the public
wiki's `human-todo` page or a procedure linked from it. Sensitive vulnerability
actions use a draft repository security advisory with detailed instructions and
access-appropriate private board tracking; do not expose those details publicly.
Apply [the human follow-up settings](docs/agents/human-follow-up.md) before
reporting a task or session complete; with the procedure the shared skills carry,
they define prerequisites, commands/UI steps, expected results, verification,
recovery, ownership, and completion evidence.

Reuse existing follow-ups. Public issues/wiki plus the private board are the
established destinations; no separate private repository is required. If access
is unavailable, prepare the complete draft outside the tracked tree and report
the handoff as pending while continuing independent authorized work. The issue
(or restricted advisory) is the record; wiki procedures provide ordinary human
execution instructions. Publishing a draft security advisory requires separate
disclosure authorization; do not treat routine documentation work as permission.
Use [docs-updater](.agents/skills/docs-updater/SKILL.md) for documentation updates
and [end-session](.agents/skills/end-session/SKILL.md) when closing a session;
both apply this same policy.

## Safety & Documentation

Never run destructive experiments in a valuable repository. Preserve dirty
worktrees and use bounded temporary fixtures. Treat Git metadata as untrusted
input. Track active implementation briefs and run-specific evidence in issues,
pull requests, or CI artifacts rather than committing session handoffs or
timestamped result reports.

## Agent skills

### Issue tracker

Use GitHub Issues in `jwh3times/causet`. Before ticket operations,
read [the issue tracker configuration](docs/agents/issue-tracker.md).

### Triage labels

Use the five default triage labels. Before triaging,
read [the label mapping](docs/agents/triage-labels.md).

### Shared skills

<!-- shared:shared-skills -->

`end-session`, `handoff`, `lets-go`, `ship` and `docs-updater` install from `jwh3times/skills`, and
are never edited here: reinstalling overwrites a local edit. A fix goes upstream, and what they need
to know about this repository goes in the settings files under `docs/agents/`, which each skill
proposes on first run.

The other shared skills come from one `mattpocock/skills` snapshot (v1.3.2, pinned by commit), the
same in every repository, and are never edited here either: what they need to know goes in this
file or `docs/agents/`. Moving to a newer snapshot is a change in `jwh3times/skills`. Keep
`.agents/skills/` out of every formatter: `scripts/check-skills.mjs` fails when an installed copy
differs from `skills-lock.json`, or the lock from these commands.

Re-running the install is the update; never run `npx skills update`, which leaves `.claude/skills/`
linked to its source instead of copied:

```bash
npx skills add jwh3times/skills -s end-session -s handoff -s lets-go -s ship -s docs-updater -a codex --copy -y
npx skills add mattpocock/skills#d1478fcb140db0b93c0c8df17bcfd311844749d0 \
  -s ask-matt -s code-review -s codebase-design -s diagnosing-bugs -s domain-modeling -s grill-me \
  -s grill-with-docs -s grilling -s implement -s improve-codebase-architecture -s prototype \
  -s research -s setup-matt-pocock-skills -s tdd -s teach -s to-questionnaire -s to-spec \
  -s to-tickets -s triage -s wait-what -s wayfinder -s wizard -s writing-for-agents \
  -a codex --copy -y
node scripts/sync-agents.mjs
```

`scripts/sync-agents.mjs`, `lint-agent-neutrality.mjs`, `check-docs.mjs`, `check-skills.mjs`, and
`sync-main.mjs`, `next-version.mjs` and `check-changelog.mjs` where this repository carries them, are
canonical in `jwh3times/skills` with their tests: fix them there, then copy them here.
`sync-agents.mjs` also writes the marked blocks in this file: change them in `jwh3times/skills`, not
here.

<!-- /shared:shared-skills -->

### Domain docs

Use a single context. Before exploring domain behavior or recording
terms and decisions, read [the domain documentation rules](docs/agents/domain.md).
