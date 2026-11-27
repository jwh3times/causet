### Added

- **Experimental: a native repository keeps an operation log, and `cst branch` writes through it
  (#423, ADR-0047 decisions 9, 10 and 12).** In a native repository, behind
  `CAUSET_EXPERIMENTAL=native`:
  - **Operations.** Each change to names or facts is an operation (store type `0a`) naming its
    parent operations, its actor, its time, its command and the view it leaves: every name and
    both fact-log chains' heads. The clone's state is `.cst/op-heads/`, one file per head. A writer
    adds its own head and removes its parent's without taking a lock, so two writers that run at
    once both keep theirs. Operations belong to the clone and are never exchanged, and `cst fsck`
    refuses a fact that names one.
  - **Import** writes the first operation, with no actor or time, holding the snapshot's names, the
    notes ref's entry as the shared chain's head and the local chain's head. A re-import moves every
    name back to the original's, and its operation follows the clone's own. An import that would
    leave the view as it is writes no operation.
  - **`cst branch` writes:** `cst branch <name> <start-point>` creates a branch, `-f` moves one,
    `-d` deletes several at once and `--local` and `--no-local` mark one. Each run writes exactly
    one operation, and prints a line for each change and the operation's ID, or the operation with
    `--json`. Its actor is declared, never inferred: `--actor <name>`, with `--kind human|agent`
    and `--for <name>`, or `CAUSET_AGENT`. A new name keeps Git's rules for a branch ref, and
    names that would clash as directories, as `a` and `a/b` do, are refused. The branch `HEAD`
    names is not deleted, as Git keeps the branch it has checked out.
  - **`cst op log`** lists the operations newest first, with `-<n>`, `-n <n>` and `--max-count`,
    and **`cst op show [<operation>]`** shows one and its view, the current one by default. Their
    `--json` documents are `causet.operations/v1` and `causet.operation/v1`.

### Changed

- **Native reads take names and the fact log's heads from the current view (#423).** `cst log`,
  `cst show`, `cst rev-parse`, `cst for-each-ref`, `cst branch`, `cst tag` and the fact-log readers
  follow a branch moved natively, and `HEAD`, symbolic to `refs/heads/main`, follows the view's
  `main`. `HEAD` and the refs that are no name, such as `refs/notes/causet`, still come from the
  import's snapshot, which the bridge keeps. A notes ref rewritten between two imports no longer
  leaves its earlier tip's facts current. The catalogs of current facts are fingerprinted by the
  view's heads, so a catalog written under one view is rebuilt under another.
- **A native store imported before this build is refused, and is imported again (#423).** It has no
  operation log, so every command in it, an import into it included, says so and names the way
  forward: native formats promise no compatibility yet (ADR-0042). Two operation heads, which two
  writers running at once leave, are refused until merging them is built (#424); both operations
  are kept, and `cst fsck` still runs.
