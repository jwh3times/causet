### Changed

- **The `land` skill has its settings here.** The skills sync in 0.32.12 installed `land`, which
  takes an approved pull request through its checks, its merge and its release. The new
  `docs/agents/merging.md` points it at `docs/agents/landing.md` as its guide, gives it no merge
  command of its own, since this repository lands with `cst merge --compact` rather than GitHub's
  merge button, and names `release.yml` as the deploy to watch. `docs/agents/landing.md`,
  `docs/agents/docs.md` and `THIRD_PARTY_NOTICES.md` now name `land` among the skills from
  `jwh3times/skills`. Nothing changes for `cst` or its packages.
