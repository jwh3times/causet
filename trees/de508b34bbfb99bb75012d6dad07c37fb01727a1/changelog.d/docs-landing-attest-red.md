### Changed

- **The landing guide names a release red that is not the code.** A new "Reds that are not the
  code" section in `docs/agents/landing.md` records the attestation failure that held up 0.32.13's
  prerelease: Sigstore's transparency log answering `error fetching tlog entry - (404) Not Found`
  in `release.yml`'s "Attest what a user downloads" step. Re-running the failed job once cleared
  it, and nothing is published before that step. `release.yml` is a deploy, which the `land` skill
  never re-runs, so it now reports this red with the owner's command, `gh run rerun <run id>
  --failed`. Nothing changes for `cst` or its packages.
