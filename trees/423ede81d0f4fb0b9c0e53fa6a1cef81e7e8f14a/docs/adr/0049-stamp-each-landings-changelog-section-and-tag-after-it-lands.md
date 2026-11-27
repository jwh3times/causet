# ADR-0049: Stamp each landing's changelog section and tag after it lands

- **Status:** Accepted (owner, 2026-11-20)
- **Date:** 2026-11-20
- **Owners:** Repository maintainers
- **Amends:** [ADR-0048](0048-version-every-landing-and-promote-a-version-to-stable-by-dispatch.md)
  decisions 1, 2 and 4
- **Decided on:** [#469](https://github.com/jwh3times/causet/issues/469); the owner chose each
  decision below on 2026-11-20

## Context

Under ADR-0048 every branch wrote the dated changelog section for the version its landing would
mint, predicted by `scripts/next-version.mjs`, and `release.yml` tagged the landing with the
version its newest section named once its set built and installed. The prediction held only for
the branch that landed next. Two branches in flight claimed the same number, so every landing sent
the others back to renumber, and one that landed without renumbering was released as the next
version with a section that named another. A Dependabot landing wrote no section, and the next
pull request had to backfill one before its own check passed (`Skipped tags: backfill`).

The repositories that share the `jwh3times/skills` development flow are moving to a scheme where
no branch names a version (`Scheme: stamp-on-tag`, that repository's `docs/design.md` decision 9).
Its scripts are canonical copies this repository carries. The scheme writes each landing's
section, and tags the landing, in one push right after it lands; this repository built its
release around tagging only after the build.

## Decision

1. **A branch writes a fragment, and `version.yml` stamps it.** Each branch adds
   `changelog.d/<branch-slug>.md`, holding only category headings and bullets, and never edits
   `CHANGELOG.md`; `ship` writes it, and `changelog.d/README.md` gives the format. On every push to
   `main`, the new `version.yml` runs `scripts/stamp-changelog.mjs`. It walks `main`'s first-parent
   history back to the newest three-part tag and, for each untagged landing, writes a dated
   section from the fragments that landing added, or one `### Changed` bullet from its title when
   it added none. The version is `next-version.mjs`'s computation over `package.json` at that
   landing, so the release line and `Ask before bumping: always` are unchanged.
2. **The landing is tagged when its section is stamped, before it is built** (amends ADR-0048
   decision 4). One `chore(release): v<x.y.z> [skip ci]` commit adds the sections and deletes the
   fragments, and it and each landing's tag go out in one atomic push. The tags are how the stamp
   knows which landings it has already written, so the tag cannot wait for the build. A landing
   whose CI or build fails therefore keeps its tag and section but gets no GitHub release, and
   `promote.yml` already refuses a version with no release.
3. **`release.yml` reads the version from the tag** (amends ADR-0048 decisions 1 and 2). When
   `ci.yml` passes on a landing, `scripts/release-plan.mjs landing` takes the version from the tag
   on that commit, waiting up to ten minutes for `version.yml` to push it, and refuses a landing
   that has none. `release.yml` never pushes a tag. Its prerelease notes, and release gate 8, read
   the section from `main`, since the landing commit predates its own section.
4. **The push bypasses the ruleset as the release GitHub App.** `GITHUB_TOKEN` cannot bypass a
   repository ruleset, so the push uses a token from the release GitHub App, added to "main:
   changes arrive by pull request with static checks" beside repository admins. Its client ID is
   the `RELEASE_APP_CLIENT_ID` variable and its key the `RELEASE_APP_PRIVATE_KEY` secret.
5. **The stamp commit is Git's own commit, with no cst provenance.** It only writes the changelog,
   so `cst provenance` shows no entries for it. Release gate 5 is unaffected: in a scratch clone of
   this repository with such a commit on `main`, `cst metadata validate` reported no errors and no
   warnings.
6. **Nothing else acts on the stamp commit.** `[skip ci]` skips `ci.yml`, so `release.yml`, which
   follows it, never runs for the stamp commit; no workflow starts on a tag push. CodeQL's default
   setup still analyzes it.
7. **Stamps take turns.** The `version-main` concurrency group never cancels a running stamp. A
   push rejected because `main` moved is not a failure: the run behind it stamps both landings.
8. **The gate.** `node scripts/check-changelog.mjs` now fails a pull request that adds, removes or
   renumbers a version section, adds entries to `[Unreleased]`, edits or deletes a fragment already
   on `main`, or adds one that does not parse. It never requires a fragment, and Dependabot's pull
   requests are no longer exempt.
9. **The switch.** `v0.32.3` is on the last landing before the move, and every tag before it has a
   section, so nothing is backfilled and the move's own landing is the first one stamped.

## Consequences

### Positive

- Pull requests land in any order with no renumbering, and a Dependabot landing gets a section of
  its own instead of leaving one for the next pull request.
- The version a landing releases is decided once, by the stamp, and every later step reads it.

### Negative

- A tag no longer proves a version built and installed; a published GitHub prerelease does, as it
  already did for promotion.
- `main` moves twice per landing: the landing, then the stamp commit about a minute later. The
  next landing waits for that run (`docs/agents/landing.md`).
- A repository secret, a GitHub App installation and a second bypass actor on the pull-request
  ruleset that did not exist before.
- Sections stamped from fragments carry category headings (`### Added`, `### Fixed`); earlier
  sections list their bullets directly under the version.

## Rejected alternatives

- **Stamp inside `release.yml` once CI passes,** so a landing whose CI fails is never tagged.
  GitHub keeps one waiting run per concurrency group, so two landings close together could cancel
  one landing's whole build and publish while the stamp waited its turn.
- **Keep tagging after the build** by teaching the shared stamp script to find stamped landings
  without tags. It changes the script every repository carries for one repository's ordering.
- **Record provenance for the stamp commit** by building `cst` in `version.yml`. It adds a Rust
  build to every landing's stamp for a commit that only writes the changelog.
