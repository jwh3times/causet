### Changed

- **The landing guide now warns that a closing keyword anywhere in a PR body closes the issue.**
  `docs/agents/landing.md` says never to write `close`, `fix` or `resolve` directly before `#N`
  in a pull request body unless the PR finishes that issue. GitHub closed #469 when #470 landed
  because a decision's heading read "Close #469 by hand", even though the body opened with
  `Part of #469`. Nothing changes for `cst` or its packages.
