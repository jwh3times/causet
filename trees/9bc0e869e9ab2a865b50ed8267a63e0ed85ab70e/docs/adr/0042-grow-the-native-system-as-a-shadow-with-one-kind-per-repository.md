# ADR-0042: Grow the native system as a shadow, with one kind per repository

- **Status:** Accepted (owner, 2026-10-17)
- **Date:** 2026-10-17
- **Owners:** Repository maintainers
- **Related requirements:** GP-01, GP-12, FR-GIT-01
- **Builds on:** [ADR-0041](0041-make-cst-a-standalone-distributed-version-control-system.md)
- **Decided on:** [#282](https://github.com/jwh3times/causet/issues/282), under the
  [transition map](https://github.com/jwh3times/causet/issues/281)

## Context

[ADR-0041](0041-make-cst-a-standalone-distributed-version-control-system.md)
makes cst a standalone, distributed version control system, reached through
phases N1–N6 with the Git bridge last. It leaves open how the native system and
cst over Git (N0) coexist while the phases run. There were two candidates:

- **A hybrid repository:** one repository runs some subsystems native and the
  rest on Git, for example a native content store under a Git working copy.
- **A native shadow:** the native system grows as a separate implementation,
  checked against the Git-backed one, until a repository switches over whole.

Some facts about the current implementation bear on the choice:

- **Only reads have a seam.** The engine seam (ADR-0019,
  `native/engine/src/engine.rs`) selects between two backends, Git and gitoxide,
  for about 45 read operations. Those operations are Git-shaped: refs, notes and
  Git object IDs.
- **Writes have none.** Every write is a direct `git` process, called from about
  ten CLI modules (commits, notes, workspaces, landing, rebase and others).
- **Nothing decides behavior by repository kind.** The native profile check only
  decides whether a read falls back to Git.

## Decision

1. **Every repository is one kind:** wholly native or wholly Git-backed, never a
   mix. The native system is built as a separate implementation that shadows
   the Git-backed one.
2. **Equality holds across kinds.** A contract run against a Git-backed original
   and against its imported native copy gives the same answer. Object IDs are
   translated through the import's alias map (ADR-0041, decision 9), and nothing
   else may differ. Which corpora the comparison runs on, and what a native
   repository prints as an ID, are decided with the phase exit criteria
   ([#284](https://github.com/jwh3times/causet/issues/284)) and the native
   command surface ([#288](https://github.com/jwh3times/causet/issues/288)).
3. **Import is deterministic, repeatable and incremental, from Git to native
   only.** Importing the same history again yields the same native objects, and
   a re-import brings in only what is new, so a native copy can follow an
   original that keeps changing on Git. Nothing is converted from native to Git
   before N6. Until switch-over, rolling back means discarding the copy.
4. **One `cst` executable serves both kinds.** It detects a repository's kind at
   its root and dispatches each command to that kind's implementation. The split
   is at the command level. Both kinds share the contracts:
   - the record model (`native/model`);
   - the JSON and human rendering;
   - the error vocabulary.

   They do not share the Git-shaped read seam. The engine seam and gitoxide stay
   machinery of Git-backed repositories.
5. **Releases carry native support from N1, behind an explicit experimental
   opt-in, with no format compatibility promise.** A native repository made by
   an earlier build may have to be re-imported. The promise starts when a phase
   ADR makes it.
6. **Switch-over waits for N5.** A user's repository may switch once N5 exists:
   peers, transport and acceptance points. causet's own original stays on Git
   until N6, because it is hosted on GitHub. Before N5, every phase exit is
   judged on imported copies only.
7. **N0 is limited to what the transition needs.** cst over Git takes:
   - fixes;
   - the coverage its users need (for example #277 and #278);
   - the work import needs;
   - work that produces Gate B's design evidence (conditions 1–6 and 9, as
     ADR-0041 restates them).

   Any other new contract waits for the native design it would belong to,
   because every contract N0 adds is one the native system must also answer.

## Constraints

- **ADR-0041's constraints hold unchanged.** "No repository becomes unreadable in
  transition" is met by construction: a Git-backed repository never gains native
  parts.
- **The equality discipline of Gate A carries over.** A native command is
  trusted when it answers as the Git-backed one does on the same history, not
  before.
- **A native format may not borrow a Git shape** to fit shared code. What the
  kinds share is a contract, never a Git structure.

## Consequences

### Positive

- Each kind stays testable on its own. The suite covers two kinds, not every
  mix of native and Git subsystems.
- Import, the first half of migration, is exercised from N1 on, by every
  equality test and by every dogfood copy.
- Native formats can follow from the native design, since nothing has to fit
  under Git's working copy or index.
- Conformance fixtures run the same executable against both kinds.

### Negative

- **Native work pays users nothing before switch-over.** Until N5, the native
  system is visible only through imported copies and the experimental opt-in.
- **Commands are implemented twice** while both kinds exist: once over Git and
  once natively. Only the contracts and the record model are shared.
- **A repository that switches at N5 cannot return to Git hosting** until the N6
  bridge exists. Before N5 nothing switches, so nothing is stranded.
- **N0's scope narrows.** Features that produce no design evidence wait for a
  native design.

## Alternatives considered

- **A hybrid repository.** Rejected because:
  - writes have no seam, so one would have to be built over Git first;
  - native formats would be bound to Git's working copy and index. ADR-0041
    rejected building the bridge early for the same reason;
  - stock Git could no longer read the repository unless every object were
    written twice;
  - the suite would have to cover every mix of subsystems.
- **A native repository as a third backend behind the read seam.** Rejected: the
  native store would have to impersonate refs, notes and Git objects, which binds
  its formats to Git's.
- **A separate native executable until switch-over.** Rejected: import and the
  equality test both need both kinds in one process, and two executables would
  defer a choice about which one users install.
- **Native support only in development builds.** Rejected: CI release gates and
  the dogfood copies run the released packaging.
- **Stable native formats from N1.** Rejected: it would freeze N1 before N2 and
  N3 have shown what they need.
- **A one-shot import.** Rejected: a dogfood copy of a repository that keeps
  moving would have to be rebuilt from scratch each time.
- **Switch-over for local-only work at N3.** Rejected: it would put live native
  repositories in users' hands with no merge (N4), no exchange of work (N5), and
  formats still moving.
- **N0 features continue freely.** Rejected: each new contract becomes a native
  obligation that no evidence asked for. Freezing N0 to fixes was also rejected,
  because N0 stays the way to use cst with a forge until N6.
