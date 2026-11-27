### Changed

- **Each landing's changelog section is now stamped after it lands** (#469). A branch writes its
  entries to its own `changelog.d/<branch-slug>.md` fragment and never edits `CHANGELOG.md`. On
  each push to `main`, the new `version.yml` turns the landing's fragment, or its title when it
  has none, into the dated section, tags the landing, and pushes both with the release GitHub
  App's token. `release.yml` then reads the version from that tag once `ci.yml` passes, builds and
  installs the set, and publishes the GitHub prerelease with the stamped section as its notes; it
  no longer pushes a tag. Pull requests no longer renumber their sections after each other's
  landings, and a Dependabot landing gets a section of its own. A landing whose build fails now
  keeps its tag but gets no release, which `promote.yml` already refuses. ADR-0049 records the move
  and amends ADR-0048; `docs/agents/releases.md`, `landing.md`, `dev-flow.md`, the docs map,
  `docs/testing.md` and `AGENTS.md` describe it. A `changelog.d/` fragment counts as
  documentation, so a documentation-only pull request still skips the suites. Nothing changes for
  `cst` or its packages.
