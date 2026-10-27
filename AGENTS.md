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
- `npm run test:docs` checks local Markdown link targets.
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
  today the generated-history corpus (`test/generated-histories.test.js` with
  `CAUSET_GENERATED_HISTORIES=1000`), on hosted Windows and Ubuntu runners:
  weekly on `main`, on manual dispatch, as release gate 11 from
  `release-gates.yml`, and for PRs touching the corpus.
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
[the development flow](docs/agents/dev-flow.md#linking-work-to-its-issue)
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

The engineering skills' flow is the binding development process. Read
[the development flow](docs/agents/dev-flow.md) for the routing, which paths
count as code, the exemptions, and the branch and pull request linking rules.

- **Gate.** Every code change starts from a ready issue: a `ready-for-agent`
  issue carrying a `/to-spec` spec, a `/to-tickets` ticket or a `/triage`
  brief, or a `bug` issue worked through `/diagnosing-bugs`. With none, stop
  before the first edit and route the user to the command that produces one.
  Reading code, running tests and answering questions need no issue.
- **The human starts every phase.** `/wayfinder`, `/grill-with-docs`,
  `/to-spec`, `/to-tickets`, `/implement` and `/triage` stay user-invoked. At
  a phase boundary, name the next command, say in one line why, and wait.
  Inside a phase, use `/tdd`, `/code-review`, `/diagnosing-bugs`,
  `/domain-modeling`, `/codebase-design`, `/prototype` and `/research`
  whenever they fit.
- **Exempt:** dependency bumps, changes touching only docs and agent config,
  release preparation, and an explicit user waiver recorded in the pull
  request body as `Flow waived by the user: <reason>`.

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

`end-session`, `handoff`, `lets-go`, `ship` and `docs-updater` install from
`jwh3times/skills`; never edit them here, since reinstalling overwrites local
edits. What they need to know about this repository is in the settings files
under `docs/agents/` (`workspace.md`, `issue-tracker.md`, `human-follow-up.md`,
`docs.md`, `releases.md`, `ship.md`, `handoffs.md`), which each skill proposes on
first run. Install and update with the same command, then regenerate the mirror;
never run `npx skills update`:

```bash
npx skills add jwh3times/skills -s end-session -s handoff -s lets-go -s ship -s docs-updater -a codex --copy -y
npm run sync:agents
```

`scripts/sync-agents.mjs` and `scripts/lint-agent-neutrality.mjs` (and their
tests) are canonical in `jwh3times/skills`: fix them there, then copy them here.

### Domain docs

Use a single context. Before exploring domain behavior or recording
terms and decisions, read [the domain documentation rules](docs/agents/domain.md).
