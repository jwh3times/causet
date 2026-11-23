### Added

- **This repository's guard rules.** `docs/agents/guard.md` lists the commands and paths the shared
  `scripts/guard.mjs` guard stops here on top of its shared rules: the bare `git` forms of the
  commands `cst` defines, `cst commit` without `--generated-by`, GitHub's merge and `npm publish`
  are denied; a push to `main`, a hard reset, removing a landing's note and deleting a branch ask
  first; ignored logs, packed artifacts and `node_modules/` are protected. The doc map names it.
  Nothing changes for `cst` or its packages.
