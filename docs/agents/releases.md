# Releases

## Scheme

cut-on-line

## Ask before bumping

always

## Changelog check

`node scripts/check-changelog.mjs --source bin --source native`

## Release commit message

`docs: update docs and changelog` for a build, and `chore: prepare v<version>, <headline>` for a
cut: the development flow exempts that commit, and a maintainer tags `v*` after it merges.
