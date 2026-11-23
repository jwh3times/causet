# Merging

The settings the `land` skill reads to merge a pull request here. This repository lands its own
work with `cst merge --compact`, never GitHub's merge button, so the procedure itself lives in
[committing and landing](landing.md), which `land` reads in full every run.

The settings left out take their defaults: `Catch-up` is `none`, because `main`'s required check
(`static checks`) does not require a branch to be up to date and `landing.md` catches a branch up
locally; `Dependabot catch-up` follows it, as no Dependabot configuration exists; and the
`Release workflow` is `version.yml`, which stamps and tags each landing (`releases.md`).

## Guide

`docs/agents/landing.md`

## Merge command

none

## Deploys

- `release.yml`, which runs when `ci.yml` passes on the landing and publishes its GitHub
  prerelease (and npm under `next` while `NPM_PUBLISH` is `true`).
