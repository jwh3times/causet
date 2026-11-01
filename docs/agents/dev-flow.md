# Development flow

The flow itself is `.agents/skills/ship/settings/dev-flow.md`, and `AGENTS.md` summarizes it. This file
holds what this repository adds.

## Reading a ready issue

A ready issue lives in `jwh3times/causet`. Read it with
`gh issue view <N> --repo jwh3times/causet --comments`. Filing a `bug` issue
needs the user's go-ahead.

## Published contracts are code

The published contracts the suites check are code, Markdown included:
`docs/schemas/`, `docs/conformance/`, `docs/canonical-json/`,
`docs/identity/`, `docs/semantic-conformance/` and `docs/native-store/`.

## Exemption details

- **Dependency bumps** are Dependabot pull requests and `chore(deps):` commits.
  Today the dependencies are the Rust crates in `native/Cargo.toml` and
  `native/Cargo.lock` and the toolchain pin in `native/rust-toolchain.toml`;
  there are no npm dependencies.
- **Release preparation** is the `chore: prepare vX.Y.Z` commit that sets the
  version in `package.json` and `package-lock.json` and writes the release's
  changelog entry. Its branch is, for example, `chore/prepare-v0.25.1`.

## Linking

A ticket's pull request may carry both lines, `Closes` first:

```text
Closes #308.
Part of #297.
```
