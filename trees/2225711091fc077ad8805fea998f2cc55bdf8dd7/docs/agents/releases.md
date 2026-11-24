# Releases

## Scheme

stamp-on-tag — `.github/workflows/version.yml` tags every landing `v<major>.<minor>.<build>` as it
lands. Each branch's entries live in its own `changelog.d/<branch-slug>.md` fragment; the workflow
stamps them into the landing's dated section and tags the landing commit (`changelog.d/README.md`,
ADR-0049). `Unreleased` stays an empty placeholder. `.github/workflows/release.yml` then builds,
installs and publishes that version as a GitHub prerelease once `ci.yml` passes on the landing
(ADR-0048).

## Ask before bumping

always
