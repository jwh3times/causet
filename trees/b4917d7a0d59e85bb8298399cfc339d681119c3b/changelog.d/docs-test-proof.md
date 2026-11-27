### Added

- **How `test-prover` runs this repository's tests.** `docs/agents/test-proof.md` gives the shared
  `test-prover` skill the single-test commands for the Node suites (rebuilding the release `cst`
  first) and the Rust tests (`cargo test` by crate and target), what a scratch worktree needs, and
  the network-only suite it leaves alone. `docs/agents/issue-tracker.md` documents the board's new
  `Due` date field. Nothing changes for `cst` or its packages.
