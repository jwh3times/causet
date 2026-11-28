### Added

- **Experimental: concurrent operations merge, and a name two writers moved apart is a conflicted
  name until `cst branch` chooses (#424, ADR-0047 decision 10).** In a native repository, behind
  `CAUSET_EXPERIMENTAL=native`:
  - **Merging.** Two writers that ran at once leave two operation heads, and every read now takes
    their merge as the current view: each name merged 3-way from their latest common ancestors, and
    each fact-log chain's heads joined. The next operation, a `cst branch` write or an import, names
    both heads as its parents. Before, a clone with several heads was refused.
  - **Conflicted names.** A name one writer moved takes that move, and one both moved to different
    places names both sides. `cst branch` and `cst tag` list it with its sides, as
    `main (conflicted: 0136ed38eb3a, absent)`, where `absent` is a side that deleted it.
    `--format` and `cst for-each-ref` leave it out and say so on stderr. A revision that names it,
    such as `cst log main`, is refused (`ambiguous-match`), naming its sides and how to choose one.
  - **Choosing a side.** `cst branch -f <name> <start-point>` resolves a conflicted branch, and
    `-d` deletes it, each in one operation that follows both writers.
  - **`cst op log`** walks from every current head and marks each `(current)`. With several heads,
    **`cst op show`** without an operation names them and asks for one.

### Changed

- **`cst branch --json` and `cst tag --json` print `causet.names/v2`** in a native repository, whose
  name holds a `target` or, for a conflicted name, `conflicted` with its `adds` and `removes`.
  `causet.names/v1` required a target, which a conflicted name has none of.
