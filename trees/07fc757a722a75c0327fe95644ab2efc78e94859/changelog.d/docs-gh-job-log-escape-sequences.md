### Fixed

- **The landing guide's command for reading a finished job's log works again.**
  `docs/agents/landing.md` now gives
  `gh api --allow-escape-sequences repos/jwh3times/causet/actions/jobs/<job id>/logs`. Without
  the flag, `gh` prints only a refusal when the log contains terminal escape sequences, which
  Actions logs do. Nothing changes for `cst` or its packages.
