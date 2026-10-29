# Development flow

The engineering skills' flow is this repository's binding development process.
The "Development flow" section of [AGENTS.md](../../AGENTS.md) states the
gate, who starts each phase, and the exemptions; this page holds the detail.
The full map of the flow, its on-ramps and its phase boundaries is the
`ask-matt` router,
[`.agents/skills/ask-matt/SKILL.md`](../../.agents/skills/ask-matt/SKILL.md).

## The gate

A ready issue lives in `jwh3times/causet`. Before the first edit to code, read
it with `gh issue view <N> --repo jwh3times/causet --comments`: `/to-spec` and
`/to-tickets` write the issue body, but `/triage` posts its agent brief as a
comment. A `bug` issue worked through `/diagnosing-bugs` needs its number, not
a spec or a `ready-for-agent` label.

### What counts as code

Code is anything the build, the suites, CI or the package reads:

- `native/`, `bin/`, `scripts/`, `test/`, `test-support/` and `benchmarks/`;
- `.github/`, `package.json`, `package-lock.json`, `.gitattributes` and
  `.npmignore`;
- the published contracts the suites check, which live under `docs/`:
  `docs/schemas/`, `docs/conformance/`, `docs/canonical-json/`,
  `docs/identity/`, `docs/semantic-conformance/` and `docs/native-store/`.

Everything else is docs or agent config: `README.md`, `CHANGELOG.md`, the rest
of `docs/` (including the ADRs, `product.md`, `architecture.md` and
`testing.md`), `AGENTS.md`, `CLAUDE.md`, `.agents/`, `.claude/`,
`docs/agents/` and `skills-lock.json`. `scripts/sync-agents.mjs` and
`scripts/lint-agent-neutrality.mjs` are code even though they serve the agent
config.

## Routing without a ready issue

| Situation | Route |
| --- | --- |
| An idea one session can hold | `/grill-with-docs`, then `/to-spec`, plus `/to-tickets` if the build spans sessions |
| A huge, foggy, multi-session effort | `/wayfinder`, then `/to-spec` once the map clears |
| A raw issue someone else filed | `/triage` |
| A ready issue nobody has started | `/implement`, in a fresh context (`/clear` first) |
| Something broken | File a `bug` issue (filing needs the user's go-ahead), then `/diagnosing-bugs` |

`/to-spec` and `/to-tickets` apply `ready-for-agent` themselves; tickets they
produce skip `/triage`.

## Exemptions

These changes need no ready issue:

- **Dependency bumps**: Dependabot pull requests and `chore(deps):` commits.
  Today the dependencies are the Rust crates in `native/Cargo.toml` and
  `native/Cargo.lock` and the toolchain pin in `native/rust-toolchain.toml`;
  there are no npm dependencies.
- **Docs and agent config only**: a change that touches no code path above.
- **Release preparation**: the `chore: prepare vX.Y.Z` commit that sets the
  version in `package.json` and `package-lock.json` and writes the release's
  changelog entry.
- **A user waiver**: the user says, in their own words, to skip the flow for
  this change. Record it in the pull request body as
  `Flow waived by the user: <reason>`.

## Linking work to its issue

- **Branch**: `<type>/<issue#>-<slug>`, with the conventional prefixes of
  AGENTS.md as the type, for example `fix/262-camel-value-options` or
  `feat/255-carry-records`. Exempt work with no issue drops the number:
  `chore/prepare-v0.25.1`.
- **Pull request body**: the first line is `Closes #N` when the pull request
  finishes ticket `N`, or `Part of #N` when it is one slice of spec `N`, which
  stays open. A ticket's pull request may carry both, `Closes` first:

  ```text
  Closes #308.
  Part of #297.
  ```

- **Title**: a number in the title alone does not link the issue; the body
  line does.
