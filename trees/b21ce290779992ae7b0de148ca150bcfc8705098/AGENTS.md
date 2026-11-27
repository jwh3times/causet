# Repository Guidelines

## Project Structure & Module Organization

`src/` contains the ES-module implementation. Keep domain behavior in focused
modules such as `merge-plan.js`, `workspaces.js`, and `metadata.js`; `src/cli.js`
owns command parsing and presentation. `bin/vlab.js` is the executable entry
point. `test/integration.test.js` exercises the real CLI against disposable Git
repositories, `test/schema-catalog.test.js` keeps the published JSON
Schema catalog in `docs/schemas/` in agreement with the runtime validators in
`src/schemas.js` (which remain the authority), and
`test/schema-compatibility.test.js` keeps the published compatibility contract
in `docs/schemas/compatibility.md` in agreement with the `RECORD_FAMILIES` and
`RESOURCE_BOUNDS` registries in the same module, and
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

The project requires Node.js 20+ and Git 2.40+. It has no runtime dependencies
or build step.

- `npm test` runs the complete Node integration suite.
- `npm run test:docs` checks local Markdown link targets.
- `.github/workflows/ci.yml` runs static checks on every PR and push to `main`.
  Code PRs add the default suite on Ubuntu and Windows; main adds Ubuntu only.
  Known documentation-only changes omit suites. Manual dispatch runs every
  mode on both platforms plus the Node 20 floor; use it for release and
  high-risk platform qualification as described in `docs/testing.md`.
  The per-host benchmark remains local.
- `npm run test:benchmark` compares bounded benchmarks against the committed
  per-host baseline in `benchmarks/baseline.json`; `npm run benchmark:record -- --host <label>`
  refreshes an explicitly identified machine's entry on a quiet machine. Use the
  same `-- --host <label>` for checks, or set `VLAB_BENCHMARK_HOST`; otherwise
  latency comparison is skipped.
- `npm run sync:agents` regenerates `.claude/skills/` from `.agents/skills/`;
  `npm run sync:agents -- --check` reports drift without writing.
- `npm run demo` runs the primary workflow demonstration; the other `demo:*`
  scripts exercise conflicts, resolutions, forecasts, specs, and Git sessions.
  Each deliberately leaves its repository in the OS temporary directory for
  inspection, so they accumulate; `npm run demo:clean` lists those fixtures and
  `npm run demo:clean -- --apply` removes them (`-- --all` also sweeps fixtures
  an interrupted test or benchmark run left behind).
- `node ./bin/vlab.js --help` runs the CLI directly without installing it.
- `npm link` optionally exposes `vlab` in the local shell.

## Coding Style & Naming Conventions

Use ESM imports, two-space indentation, double quotes, and semicolons, matching
the existing source. Prefer `camelCase` for functions and variables,
`PascalCase` for classes, `UPPER_SNAKE_CASE` for constants, and descriptive
kebab-case module names. Keep synchronous Git orchestration explicit and avoid
adding dependencies without a demonstrated need. There is no configured
formatter or linter; run `git diff --check` and `node --check <file>`.

## Testing Guidelines

Tests use `node:test` and descriptive behavior names such as
`test("stale forecasts fail before starting a reconciliation", ...)`. Add
regression coverage for observable changes and use temporary repositories for
history-changing cases. For Git-session, forecast, read-path, or cross-cutting
changes, run `npm test`, `VLAB_GIT_SESSION=1 npm test`, `VLAB_GIT_SESSION=0 npm test`
(the session default differs by platform, so both are forced on every host),
`VLAB_FORECAST_ENGINE=worktree npm test`, `VLAB_FORECAST_ENGINE=merge-tree npm test`
(the default forecast engine differs by platform), and `VLAB_ENGINE=native npm test`
(every read must pass through `src/engine.js`; never call `runGit` for a read
in a domain module). No numeric coverage threshold is
defined; preserve the behavioral and failure-safety guarantees in
`docs/testing.md`.

## Commit & Pull Request Guidelines

Recent history uses concise imperative subjects with conventional prefixes:
`feat:`, `fix:`, `docs:`, and `chore:`. Keep each commit scoped to one coherent
change. Pull requests should explain intent and compatibility impact, link the
relevant issue or ADR, list validation commands and results, and update the
README, changelog, or durable docs when contracts change. Screenshots are
normally unnecessary for this CLI; include focused terminal output when it
clarifies behavior.

## Work Tracking

GitHub is the only tracker. Future work is issues on the
[vcs-lab project board](https://github.com/users/jwh3times/projects/7), each
carrying the gate that must clear before it can start; dated progress on an
item belongs on its issue, and `CHANGELOG.md` is the one dated narrative of
what shipped. Do not add a Markdown backlog, roadmap, continuation brief, or
TODO file beside the tracker — a second list is a list that will disagree.

What stays in the tree is what has no "done": product intent and the investment
gates (`docs/product.md`), decisions (`docs/adr/`), the implemented system
(`docs/architecture.md`), the published contracts (`docs/schemas/`,
`docs/conformance/`, `docs/identity/`, `docs/canonical-json/`), and how to
validate (`docs/testing.md`).

## Required Human Follow-ups

Every required human action left by agent-completed work must have a public
follow-up issue in `jwh3times/vcs-lab`, the `human-action-required` label, a card
on the private project board, and linked step-by-step instructions in the public
wiki's `human-todo` page or a procedure linked from it. Sensitive vulnerability
actions use a draft repository security advisory with detailed instructions and
access-appropriate private board tracking; do not expose those details publicly.
Apply [the human follow-up policy](docs/human-followups.md) before reporting a
task or session complete; it defines prerequisites, commands/UI steps, expected
results, verification, recovery, ownership, and completion evidence.

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
