# Ship

## Fast checks

The required `static checks` job's steps, all from the repository root:

- `node --test test/ci-plan.test.js test/scale-benchmark-analysis.test.js`
- `for file in bin/native/*.js scripts/*.mjs test/*.js test-support/*.js; do node --check "$file"; done`
- `npm run test:docs`
- `node --test test/architecture-tables.test.js`
- `npm run sync:agents:check`, fixed by `npm run sync:agents`, committing both sides
- `npm run lint:agents`
- `git diff --check "$(git mktree </dev/null)" HEAD`

The suite jobs (`npm test` under each engine and session mode, on Linux and Windows) and the
release gates run only in CI.

## Issue link

- **Branch pattern:** `<type>/<issue#>-<slug>`, with the conventional prefixes `feat`, `fix`,
  `docs`, `chore`. Exempt work drops the number (`chore/prepare-v0.25.1`).
- **Link line:** `Closes #N.` when the PR finishes ticket `N`; `Part of #N.` for one slice of spec
  `N`, which stays open. A ticket's PR may carry both, `Closes` first, each on its own line.
- **Waiver line:** `Flow waived by the user: <reason>`.
- **Exempt:**
  - dependency bumps
  - changes touching only docs and agent config
  - release preparation (the `chore: prepare vX.Y.Z` commit)
- **Defined in:** `docs/agents/dev-flow.md`.
