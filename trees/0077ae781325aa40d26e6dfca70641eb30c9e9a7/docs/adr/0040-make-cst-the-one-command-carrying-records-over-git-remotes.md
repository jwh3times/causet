# ADR-0040: Make `cst` the one command, carrying records over ordinary Git remotes

- **Status:** Accepted; implementation notes 2026-10-15 (#255)
- **Decided:** 2026-10-15
- **Date:** 2026-10-15
- **Owners:** Repository maintainers
- **Implementation:** remote commands [#255](https://github.com/jwh3times/causet/issues/255),
  passthrough [#256](https://github.com/jwh3times/causet/issues/256)
- **Related:** [#37](https://github.com/jwh3times/causet/issues/37),
  [#40](https://github.com/jwh3times/causet/issues/40),
  [#257](https://github.com/jwh3times/causet/issues/257),
  [#258](https://github.com/jwh3times/causet/issues/258),
  [ADR-0001](0001-use-git-as-the-compatibility-and-storage-substrate.md),
  [ADR-0010](0010-add-a-validated-metadata-envelope-before-a-server.md),
  [ADR-0020](0020-freeze-per-family-compatibility-and-resource-bounds.md),
  [ADR-0025](0025-retain-the-object-closure-of-published-causal-facts.md),
  [ADR-0030](0030-define-conflict-policy-for-competing-causal-facts.md),
  [product requirements](../product.md) §5, FR-GIT-04, FR-GIT-08, FR-PROTO-04

## Context and decision

A user of `cst` today runs two tools. `cst commit`, `cst merge` and the other
causal commands write records, but the day's other work is Git's: `git fetch`,
`git pull`, `git push`, `git status`, `git log`. The split costs more than
convenience. Git's default refspecs carry branches only, so a user who runs
plain `git push` and `git clone` publishes none of the records `cst` wrote, and
nothing says so. The records reach another clone only through a metadata
envelope (`cst metadata export` and `import`, ADR-0010) or through refspecs the
user must know and type by hand, and the refspec the documentation gives today
carries more than it should (evidence below).

Product §5 lists "automatic remote synchronization of all causal metadata" as
a non-goal of the prototype. ADR-0030 settled the policy that made it unsafe:
what happens when two clones hold competing facts. Its owner decision says park
mode is "the only mode an automatic transport may use", and product §17
question 2 records that "what remains open is the transport that would run in
park mode". This ADR is that transport, and the command surface around it.

Decide two things:

1. **`cst fetch`, `cst pull`, `cst push` and `cst clone` carry the records.**
   Each does what Git's command of the same name does, and also moves the
   shared-portable records between the clone and an ordinary Git remote,
   through the same validation as an envelope import, in park mode only.
2. **Every command `cst` does not define passes through to Git.** `cst status`,
   `cst log`, `cst diff`, `cst add`, `cst switch` and the rest run `git` with
   the same arguments, standard streams and exit status, so `cst` is the only
   command a user needs.

Neither part adds a record family, a store, or a server. The remote is any Git
remote; `cst` runs Git for the network, so authentication, credential helpers,
SSH and hosting behave exactly as they do for Git.

## Evidence

Disposable repositories, Fedora Linux, Git 2.56.0, `cst` 0.24.0 at `6da365d`,
on 2026-10-15. A bare hub, clone A, then clone B.

| Case | Commands | Observed |
| --- | --- | --- |
| Records written in A | `cst init`; `cst commit --generated-by agent` on a branch; `cst merge --compact`; `cst workspace checkpoint` | A holds `refs/notes/causet`, `refs/causet/retention`, `refs/causet/checkpoints/main` |
| Plain Git publishes none of them | `git push origin main` in A; `git clone` as B | B has no `refs/notes/causet` and no `refs/causet/*` ref; `cst receipts --json` is `[]` and `cst provenance` of the landed commit has no entries. Neither command fails or warns |
| The documented refspec over-carries | `git push origin 'refs/notes/causet:refs/notes/causet' 'refs/causet/*:refs/causet/*'` in A; the fetch from `docs/architecture.md` in B | B receives the records, and also A's `refs/causet/checkpoints/main`. Checkpoints are shared-local (ADR-0010); the same glob would carry `refs/causet/quarantine/**`, which `docs/architecture.md` says nothing fetches or pushes (#258) |
| This repository works around it by hand | every landing; "Repository rules" in `docs/testing.md` | each landing is pushed as `git push --atomic origin main refs/notes/causet refs/causet/retention`, typed by hand, because the causal refs "rely on being pushed fast-forward, and atomically with `main`" |
| Git habits in a colliding name | `cst commit --amend -m x` | A new commit, not an amend; the unknown option is ignored without a message (#257) |

## The contract

### What moves, and what never does

The remote commands move exactly the shared-portable refs an envelope carries:

| Ref | Carried | Merge rule on fetch |
| --- | --- | --- |
| `refs/notes/causet` | yes | record by record under ADR-0030; never `git notes merge` |
| `refs/causet/retention` | yes | always merged; monotonic (ADR-0025) |
| `refs/causet/resolutions/<signature>/<result-blob>` | yes | same name and target: no-op; same name, different target: the incoming ref is refused (ADR-0030) |
| `refs/causet/checkpoints/**`, `refs/causet/checkpoint-history/**` | never | shared-local |
| `refs/causet/quarantine/**` | never | local by ADR-0030 |
| registries, journals, forecasts | never | local or worktree-private |

Every refspec the commands pass to Git names these refs exactly. No command
uses a `refs/causet/*` glob, so a family added to the namespace later is local
until a decision says otherwise.

### `cst fetch [<remote>] [<git fetch arguments>]`

1. Run `git fetch` with the user's arguments, and in the same invocation fetch
   the remote's carried refs into a staging namespace,
   `refs/causet-remote/<remote>/…`, that no refspec pushes.
2. Treat the staged refs as an envelope built locally: inventory the records
   from the staged notes ref, then run the import's validation and its
   `--park-conflicts` apply. Schema and version checks, resource bounds
   (ADR-0020), referenced-object checks, lineage and the conflict set are the
   import's own; nothing about a remote is trusted more than an envelope is.
3. Write the merged notes commit with two parents, the local notes commit and
   the remote's, so the next push is a fast-forward. The tree holds the local
   copy of any parked record. The retention ref is merged the same way.
4. Report what an import reports: records added, no-ops, parked conflicts,
   quarantined records, and the refs refused. A parked or quarantined record
   never fails the fetch.

### `cst push [<remote>] [<git push arguments>]`

1. Refuse before anything moves while a record parked from that remote has no
   disposition. Pushing then would replace the remote's copy with the local one
   without anyone deciding it; the refusal names `cst metadata dispose`.
2. Push the user's refs and the carried refs in one `git push --atomic`. A
   resolution ref the remote holds with a different target is left out, never
   overwritten.
3. If the push is rejected because the remote's carried refs moved, fetch and
   merge as `cst fetch` does, then retry, a bounded number of times. A rejected
   branch is reported as Git reports it; `cst push` never merges or rebases the
   user's branches and never forces any carried ref.

### `cst pull` and `cst clone`

`cst pull` is `cst fetch` followed by the integration `git pull` would perform
under the user's own `pull.*` configuration: Git's merge or rebase, not a
causal landing. `cst clone` is `git clone`, then `cst init`, then `cst fetch`.

### Passthrough

1. A command `cst` defines is `cst`'s. Any other first word runs
   `git <arguments>` unchanged, inheriting the standard streams, returning
   Git's exit status, and printing nothing of its own. Global `cst` flags
   (`--json`, `--engine`, …) are not consumed from a passthrough command.
2. The colliding names are `init`, `commit`, `branch`, `merge`, `rebase`,
   `cherry-pick`, `fetch`, `pull`, `push`, `clone`, `version` and `help`. Each
   keeps its `cst` meaning, and an option it does not define is refused with
   `usage-unknown-option`, naming `cst git <command>`, never ignored (#257).
3. `cst git <arguments>` runs Git directly, whatever the first word, for the
   forms `cst`'s own commands do not offer, such as `git commit --amend`.
4. `cst help` marks which commands are `cst`'s own and says that everything
   else is Git.

## Rejected alternatives

- **Configure the refspecs at `cst init`** (`remote.<name>.fetch` and `push`
  entries for the carried refs). Plain `git fetch` would then move the notes
  ref by Git's rules: a diverged notes ref is a non-fast-forward the user must
  force, and a forced update replaces local records wholesale with the
  remote's, unvalidated. That is the last-writer-wins outcome ADR-0030
  rejects.
- **Git hooks.** No client hook can add refs to a push or validate a fetch.
- **Transport-specific envelope exchange** (export to a branch on the remote,
  import from it). It adds a second carrier of the same records and still
  needs the commands above to drive it.
- **Passthrough by allowlist.** Every Git command a user reaches for and the
  list misses would send them back to `git`, which is the split this ADR
  removes.
- **Let a colliding command pass unknown options to Git.** `cst commit --amend`
  would then amend without the Change-Id handling `cst commit` exists for;
  half of one command running as `cst` and half as Git is worse than either.
- **Wait for Gate B's Git-carried fact transport (#40).** That is the transport
  of a canonical fact log that does not exist yet. These commands carry the
  records as they are stored today and change no semantics, so they are
  outside the gate; #40 keeps the log's transport.

## Consequences

- One command covers the daily loop, and records reach every clone that uses
  it, which is the thing FR-GIT-08 and FR-PROTO-04 ask for.
- Product §5's non-goal becomes "synchronization through anything but `cst`'s
  remote commands"; a plain `git fetch` still carries no records, and the
  documentation must keep saying so.
- A remote becomes a meeting point for records written by many clones. A
  forged or altered record pushed by one clone is parked by the next clone
  that fetches it; nothing here authenticates a claim (#38).
- A keep-local disposition followed by `cst push` replaces the remote's copy.
  Other clones then park the disagreement in turn and decide for themselves.
  That is ADR-0030's local disposition working as written, now across a hub.
- `usage-unknown-command` no longer reaches a user for an unknown first word:
  Git's own message and status come back instead. Whether the code is retired
  or kept for another refusal is settled in #256.
- New error codes (`usage-unknown-option`, a push refused for an undisposed
  parked conflict) join `docs/schemas/errors.md` and the conformance fixtures.
- Pushing a branch with `cst push` now also pushes records. A user who wants
  Git's behaviour runs `cst git push`, or the flag decision 3 below may add.

## What the owner must decide

1. Reverse product §5's non-goal for synchronization through `cst`'s remote
   commands, run only in ADR-0030's park mode.
2. Accept the carried set and its exact refspecs, with checkpoints, quarantine
   and every future `refs/causet/*` family local by default.
3. Whether `cst push` carries the records by default (recommended) or only
   with a flag, and whether `--no-records` exists.
4. Accept that `cst push` refuses while a conflict parked from that remote is
   undisposed, rather than pushing the local copy over it.
5. Accept passthrough for every command `cst` does not define (recommended)
   rather than an allowlist, with `cst git` as the explicit escape.
6. Accept that colliding commands refuse options they do not define, which
   changes frozen oracle answers that today ignore them (#257).
7. The order: passthrough (#256) and #257 can ship first; the remote commands
   (#255) follow.

## Owner decision (2026-10-15)

Accepted as proposed.

1. Product §5's non-goal is reversed for synchronization through `cst`'s
   remote commands, which run only in ADR-0030's park mode. The §5 text changes
   when those commands ship (#255).
2. The carried set and its exact refspecs are accepted; checkpoints,
   quarantine and every future `refs/causet/*` family are local by default.
3. `cst push` carries the records by default, and `--no-records` pushes only
   what `git push` would.
4. `cst push` refuses while a conflict parked from that remote is undisposed.
5. Every command `cst` does not define passes through to Git, with `cst git`
   as the explicit escape.
6. Colliding commands refuse options they do not define with
   `usage-unknown-option`; the frozen oracle answers that change are
   re-recorded, each with the reason in the change (#257).
7. Order, not put separately and taken as proposed: #257 and passthrough (#256)
   first, then the remote commands (#255).

## Implementation notes (2026-10-15, #255)

Built as decided, with three refinements the contract above did not settle.
None changes a decision; each is recorded here rather than rewriting the
text the owner accepted.

1. **Records first, then Git's push, not one atomic push.** One atomic push
   needs the caller's refspecs on the command line, and naming any refspec
   turns off what `git push` would otherwise choose (`push.default`, the
   upstream, `--all`), while `--force` and `--force-with-lease` would apply to
   the carried refs too. So `cst push` pushes the carried refs in one atomic,
   never-forced push, and only after it succeeds runs `git push` with the
   caller's arguments untouched. The property atomicity was for still holds:
   a branch never reaches the remote before the records about it. Records
   that arrive for a branch Git then refuses are harmless, since their
   objects travel in the retention ref. `--delete` pushes no records. The
   records push skips client hooks (`--no-verify`), so a `pre-push` hook runs
   once, on the caller's own push.
2. **A push refuses while any parked conflict lacks a disposition**, not only
   one parked from that remote. A parked record carries the lineage of its
   source, which every clone of one repository shares, so the remote it came
   from is not recorded; and pushing over any undisposed conflict would
   spread one side of it.
3. **The fetch of the carried refs is a second `git fetch`** after the
   caller's, in the same `cst` invocation, so the caller's arguments and the
   remote's configured refspecs behave exactly as under Git. A remote named
   only by URL or path is staged under `refs/causet-remote/url-<digest>`.
   `cst pull` has no `--json`, because Git's merge output already uses
   standard output.
