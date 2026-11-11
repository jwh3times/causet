# Ship

## Fast checks

The required `static checks` job's steps, all from the repository root:

- `node --test test/ci-plan.test.js test/scale-benchmark-analysis.test.js`
- `for file in bin/native/*.js scripts/*.mjs test/*.js test-support/*.js; do node --check "$file"; done`
- `npm run test:docs`
- `node --test test/architecture-tables.test.js`
- `npm run sync:agents:check`, fixed by `npm run sync:agents`, committing both sides
- `node scripts/check-skills.mjs`
- `npm run lint:agents`
- `git diff --check "$(git mktree </dev/null)" HEAD`

CI-only, since each needs a native build or a multi-engine, multi-OS matrix: the `suite` jobs
(the native build, parser fuzzing, the Rust unit tests and `npm test` under each engine and session
mode, on Linux and Windows) and the release gates.
