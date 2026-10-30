# Releases

## Scheme

cut-on-line — `Unreleased` collects each change's entries. A release is prepared deliberately: a
`chore: prepare vX.Y.Z` pull request sets the version and cuts the release's section, and a
maintainer tags `v*`. Releases use bare `## x.y.z` headings, unlike `ship`'s cut, so a major or
minor evaluation is answered "build" and the release is prepared by hand.

## Skipped tags

none

## Version file

`package.json` (with `package-lock.json` beside it)

## Bump command

`npm version <version> --no-git-tag-version`

## Ask before bumping

always

## Next-version command

none

## Unreleased placeholder

empty

## Changelog check

none

## Release commit message

`<type>: <summary>` — a conventional-commit subject (`feat:`, `fix:`, `docs:`, `chore:`); a
release's own is `chore: prepare v<version>`.
