### Changed

- **The shared guard hook reads `cst` as Git.** `docs/agents/guard.md` names `cst git` and `cst` as
  Git wrappers, so once this repository takes the guard from jwh3times/skills#92, its universal
  rules (force-pushes, pushes to `main`, branch and push deletes, discarding a dirty tree, `git rm`
  of a protected path) also stop `cst reset --hard`, `cst git push --force` and the like. Nothing
  changes for `cst` or its packages.
