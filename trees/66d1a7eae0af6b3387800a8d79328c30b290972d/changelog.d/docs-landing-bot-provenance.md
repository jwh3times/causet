### Changed

- **The landing guide now names each landing after its pull request.** `docs/agents/landing.md`
  gives `cst merge <branch> --compact -m "<PR title> (#<N>)"`: for a branch with no
  `changelog.d/` fragment, `version.yml` makes the landing's subject its changelog entry, so
  without `-m` the section reads "Compact merge <branch>", as 0.32.9's does. The guide also says
  a landing of a `chore/take-skills` branch from the `jwh3times/skills` Consumers workflow is
  expected to show no provenance, because that workflow commits with plain Git. Nothing changes
  for `cst` or its packages.
