# Docs

## Doc map

- `README.md` — the user-facing entry point: install, usage and the command overview. **When:** a
  command, flag, install step or supported platform changes.
- `CHANGELOG.md` — the versioned record of delivered behavior: `Unreleased` collects entries, and a
  deliberate release cuts a bare `## x.y.z` section. `ship-owned`. **When:** a user-visible behavior
  or contract changes.
- `AGENTS.md` — durable rules for working in this repository: structure, commands, style, testing,
  commits, tracking, the development flow. **When:** one of those rules, or a command it quotes,
  changes.
- `docs/README.md` — the documentation index and where future work lives. **When:** a document is
  added, moved or removed.
- `docs/product.md` — product intent, requirements, quality and investment gates, and the trace
  from every incomplete requirement to its issue. **When:** a capability is added or cancelled, a
  gate's evidence changes, or a requirement's issue changes.
- `docs/architecture.md` — implemented components, persisted state, runtime flows, invariants,
  failure handling and known debt. **When:** a component, flow, persisted record or invariant
  changes (`bin/`, `native/`, `scripts/`); its tables are checked by
  `test/architecture-tables.test.js`.
- `docs/testing.md` — supported validation commands, release gates and evidence policy, and the
  repository rules record. **When:** a test command, suite mode, CI job, release gate or ruleset
  changes (`package.json`, `.github/workflows/`).
- `docs/native-engine.md`, `docs/structured-document-adapters.md` — the optional native reads and
  the structured-document adapter contract. **When:** the native engine's build, fallback or
  qualification changes; an adapter's format or acceptance requirements change.
- `docs/CONTEXT.md`, `docs/adr/*.md` — the domain glossary and decisions, written by the
  `domain-modeling` skill. `frozen` for this skill: point at them, and report a contradiction
  between an accepted ADR and the code instead of editing either.
- `docs/schemas/`, `docs/conformance/`, `docs/canonical-json/`, `docs/identity/`,
  `docs/semantic-conformance/`, `docs/native-store/` — published contracts the suites check, which
  the development flow counts as code. `owner-only`: report drift; a change goes through an issue.
- `docs/agents/*.md` — conventions and settings the installed skills read. **When:** a convention or
  setting changes.
- `docs/agents/mirrors.md` — how agent and skill sources are mirrored and linted. **When:**
  `scripts/sync-agents.mjs` or `scripts/lint-agent-neutrality.mjs` changes.
- `docs/agents/dev-flow.md` — the development flow, the code / docs-and-agent-config split and issue
  linking. **When:** a path's classification, an exemption or the linking rule changes.
- The public wiki's usage pages (`https://github.com/jwh3times/causet.wiki.git`) — operational
  walkthroughs such as benchmark host baselines and the landing procedure. **When:** the command or
  procedure they walk through changes. Dated audit findings there stay historical; link them to the
  current instructions.
- `.agents/skills/*/**` — skills, mirrored to `.claude/skills/`. Every skill `skills-lock.json`
  lists is installed (`end-session`, `handoff`, `lets-go`, `ship` and `docs-updater` from
  `jwh3times/skills`, the rest from `mattpocock/skills`): `frozen` here, since a reinstall overwrites
  local edits; fix them upstream.

**Never in public docs:** sensitive vulnerability details (they stay in the draft advisory), secret
values, and run-specific evidence or session handoffs (they belong in issues, PRs or CI artifacts).

## Drift probes

- Commands and flags: `bin/` and the `native/cli/` crate's command definitions, and
  `native/target/release/cst --help` when built
- npm scripts: `scripts` in `package.json`
- CI jobs and release gates: `.github/workflows/*.yml` (jobs by their top-level keys)
- Required status checks: `gh api repos/jwh3times/causet/rules/branches/main`
- Architecture tables: `node --test test/architecture-tables.test.js`

## Docs validation

- `npm run test:docs`
- `node --test test/architecture-tables.test.js`
- `git diff --check`
