# Test proof

How `test-prover` runs one test on its own in this repository, and how it tells a run that tested
nothing from a pass. Commands are for bash; [local runs](local-runs.md) has the machine's traps.

## Test commands

- **Node suites** (repository root): `test/*.test.js`, with their harness in `test-support/`. They
  run the release `cst` and probes in `native/target/release/`, so each command rebuilds them
  first (a no-op when `native/` is unchanged). One file:
  `cargo build --locked --release --manifest-path native/Cargo.toml -q && node --test <file>`; one
  test: the same with `node --test --test-name-pattern="<name>" <file>`. A test written for one
  mode runs with that mode's variable in front of `node` (`CAUSET_KIND=native`,
  `CAUSET_GIT_SESSION=0`; AGENTS.md § Testing Guidelines), and a native-mode run unsets
  `GIT_CONFIG_COUNT` and `GIT_CONFIG_PARAMETERS` first. Worktree: no links (there are no npm
  dependencies); run `cargo build --locked --release --manifest-path native/Cargo.toml` once, since
  a fresh worktree builds the whole workspace into its own `native/target`. Not run by
  `test-prover`: `test/real-repositories.test.js`, which fetches from the network and has tests
  only when `CAUSET_REAL_REPOSITORIES` names a repository.
- **Rust tests** (`native/`): `#[cfg(test)]` modules in `native/*/src/**/*.rs` and the files in
  `native/*/tests/*.rs`. Name the test target, so only that target builds and runs. A module
  test: `cargo test --locked --release -p <crate> --lib <name>` (`--bin cst` for
  `causet-cli`); a test file: `cargo test --locked --release -p <crate> --test <file stem> <name>`.
  `<crate>` is the package name in the crate's `Cargo.toml` (`causet-store`), and `<name>` is a
  substring of the test's path (`dates::tests::iso_shapes_follow_v8`; add `-- --exact` for the
  whole path). Count: cargo's `test result:` lines, summed over the targets, which `mutate.mjs`
  reads already. Worktree: none; the first run builds the workspace's tests into the worktree's
  `native/target`.
