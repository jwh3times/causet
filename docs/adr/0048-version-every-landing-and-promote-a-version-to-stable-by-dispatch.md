# ADR-0048: Version every landing, and promote a version to stable by dispatch

- **Status:** Proposed
- **Date:** 2026-11-12
- **Owners:** Repository maintainers
- **Amends:** [ADR-0038](0038-deliver-the-rust-cli-through-per-platform-npm-packages-linked-without-node.md)
  §6 (versioning) and §7 (GitHub releases)
- **Decided on:** [#440](https://github.com/jwh3times/causet/issues/440); the owner chose the
  direction on 2026-11-12

## Context

Until this decision a version existed only when the maintainer cut one. The release scheme was
`cut-on-line`: each change wrote its entry under `## [Unreleased]`, and a release was a deliberate
"prepare vX" pull request, three hand dispatches on the same candidate commit (`ci.yml`,
`release-gates.yml`, `release.yml`), an admin pushing the `v*` tag past the ruleset that restricts
tag creation, and a hand publish of the draft GitHub release the tag's run left. Nothing prompted
the cut, so it stopped happening: v0.25.1, on 2026-10-16, was the last release, and about a hundred
landings then accumulated with no version, no GitHub release and no npm package.

The shared tooling this repository installs from `jwh3times/skills` already supports a scheme where
every merge is a version: `scripts/next-version.mjs` computes the next one, the `per-merge` mode of
`scripts/check-changelog.mjs` holds a pull request's changelog to it, and `ship` writes each
branch's section for the version its merge will mint. Nothing here ran it.

Two constraints shape the answer:

- **The release gate is long.** `docs/testing.md` requires eleven gates on the release commit, among
  them a 20-job suite matrix and corpora that run for hours. Running them for every landing would
  make each landing wait hours to be installable.
- **A landing is a local compact merge** (`cst merge --compact`, then `cst push`), pushed by an
  admin past the pull-request rule. `main`'s own CI run is the first run on that exact commit.

## Decision

1. **Every landing is a version.** `docs/agents/releases.md` sets `Scheme: per-merge`. When `ci.yml`
   passes on a push to `main`, `release.yml` tags the landing commit with the version its newest
   changelog section names, builds and smoke-tests that version's release set, and publishes it as
   a GitHub *prerelease* with every asset and, when `NPM_PUBLISH` is `true`, on npm under the
   `next` dist-tag.
2. **The changelog names the version; the tag job does not compute it again.** The per-merge
   changelog check held the newest section to `next-version.mjs`'s answer when the pull request
   ran. Reading it back cannot race a second landing whose release runs beside the first. A
   landing with no section of its own (a Dependabot pull request's, or one whose number another
   landing took first) gets the next version `next-version.mjs` gives, and the next pull
   request's changelog check requires a section for it (`Skipped tags: backfill`). A section off
   the declared release line is refused, and a landing already tagged keeps its version on a
   re-run (`scripts/release-plan.mjs`).
3. **`package.json` on `main` names the release line, not the build.** Its major and minor are the
   line and its build is the floor, as `next-version.mjs` reads them. A release build writes its
   version into the manifests before compiling, so the executable, the archives and the npm
   packages carry it. Starting a new minor or major line stays a deliberate `ship` step the owner
   approves (`Ask before bumping: always`).
4. **A tag is pushed only after its set built and installed.** A landing whose build fails is never
   tagged; re-running the failed jobs retries it, and each step after the tag skips what an
   earlier attempt did.
5. **npm `latest` and the GitHub latest release move only by promotion.** `promote.yml`, dispatched
   with a version, refuses one that has no tag, no published GitHub release or no npm package, and
   one older than the stable release unless `allow-older` is set. It runs the whole release gate
   against that version's tag by calling `ci.yml`, `release-gates.yml` (which calls `corpora.yml`)
   and `release.yml` as reusable workflows. Only when all of them pass does it move `latest` for
   every package and make the GitHub release the latest. Promoting the stable release again does
   nothing.
6. **The release gate's list does not change; how it runs does.** The eleven items stay. The
   promotion runs them all against one commit, so the candidate branch, the hand dispatches and
   the hand-placed tag go.
7. **Only release automation and admins create release tags.** The ruleset that restricts `v*` tag
   creation adds GitHub Actions as a bypass actor; tags stay immutable for everyone.
8. **Moving a dist-tag uses a token; publishing does not.** npm's trusted publishing covers
   `npm publish` and not `npm dist-tag`. Promotion uses a granular token limited to the
   `@holland-vip` packages, held as the `NPM_TOKEN` secret of an `npm-promote` environment only
   `promote.yml` uses. Publishing stays on trusted publishing.

### Amendment to ADR-0038

- **§6, lockstep:** every package of a version is published from one run at that version, which is
  now the tag's version written into the manifests by the build, not the committed
  `package.json`'s.
- **§7, GitHub releases:** each landing's version gets a GitHub prerelease with the archives,
  `SHA256SUMS`, the install scripts and the npm tarballs. A promotion makes one of them the latest
  release, which is what the install scripts install by default.

## Constraints

- A version is never re-tagged and a published npm version is never replaced; a retry completes
  what a failed run left.
- A failed promotion changes nothing public.
- `next` does not move to an older build: a build that finishes after a newer one is published
  publishes under `superseded` instead, decided just before each publish. Two releases publishing
  within the same seconds can still leave `next` on the older one until the next landing.
- Only versions from 0.26.0, the first a landing released, can be promoted; the workflows a
  promotion runs postdate the earlier tags.

## Consequences

### Positive

- Landing a change releases it. Users who want it install `@next` or `--version <x.y.z>` within
  minutes; everyone else keeps the last promoted release.
- Cutting a stable release is one dispatch, and its run is the release's evidence.
- The changelog becomes one dated section per version, which `ship` already writes.

### Negative

- Every pull request, a documentation-only one included, needs a changelog section, and two branches
  in flight claim the same number until the second renumbers on its next `ship`. One that lands
  without renumbering is released as the next version, and its section is corrected afterwards.
- npm and GitHub accumulate a prerelease per landing. Pruning them is not decided here.
- A landing whose `main` CI fails for real is never tagged and its section names a version that was
  not released. The landing that fixes it takes the next number.
- Promotion needs a stored npm token, which publishing avoided.

## Rejected alternatives

- **Keep `cut-on-line` and script the cut.** It removes steps but not the decision to cut, which is
  the step that stopped happening.
- **Run the whole release gate on every landing and publish to `latest`.** The gate takes hours;
  landings would queue behind it, and a failure would block every later landing.
- **A separate tag workflow that calls `release.yml`.** npm's trusted publisher names one workflow
  file, and a tag pushed with the workflow token starts no other workflow. Tagging inside
  `release.yml` keeps one publishing workflow.
- **Compute the version again after the landing.** Two landings released side by side would both
  compute the same number.
- **Versions from commit messages (conventional-commit release tooling).** The release level is a
  judgment `ship` records with the owner's approval, not a prefix.
