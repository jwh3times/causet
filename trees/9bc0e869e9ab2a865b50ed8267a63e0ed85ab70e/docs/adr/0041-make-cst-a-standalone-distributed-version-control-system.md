# ADR-0041: Make cst a standalone distributed version control system

- **Status:** Accepted (owner, 2026-10-17; see "Owner decision"); coexistence decided by [ADR-0042](0042-grow-the-native-system-as-a-shadow-with-one-kind-per-repository.md), phase order by [ADR-0043](0043-order-the-native-transition-by-dependency-starting-with-n1.md)
- **Date:** 2026-10-17
- **Owners:** Repository maintainers
- **Related requirements:** GP-01, GP-12, product thesis (§3), non-goals (§5),
  Gate B (§15), FR-WS-08, FR-TRUST-02, FR-TRUST-03, FR-LAND-10
- **Revisits:** [ADR-0001](0001-use-git-as-the-compatibility-and-storage-substrate.md),
  [ADR-0014](0014-split-the-native-implementation-gate-into-engine-and-store-gates.md),
  [ADR-0015](0015-adopt-a-phased-native-core-program-with-rust.md),
  [ADR-0023](0023-locate-the-model-substrate-mismatch-in-facts-not-content.md)

## Context

**The owner's intent.** On 2026-10-17 the owner stated what cst is for:

- **A standalone product.** cst is to be its own version control system. It does not use Git at all, and it replaces Git.
- **What it combines:** the best of Git, the best of Subversion, and what software development with AI agents needs. That includes declared and verified provenance, parallel agent work, and the large volume of instructions and documentation an AI-driven process produces.
- **Git was the first step.** Building cst over Git was always meant to evaluate the design, its performance and its benefit, before building the system itself.

**The tree says something narrower,** and an agent reading it alone would conclude the opposite:

- **Product thesis.** [product.md](../product.md) §1 calls causet "a Git-compatible laboratory", and the §3 thesis is to "first prove a causal compatibility layer over Git", in which "Git remains the exact state store and universal escape hatch". §5 lists "a production-ready replacement for Git" as a non-goal. None of these names replacing Git as the destination.
- **ADR-0001** rejected "build a native VCS immediately" for the laboratory phase. That was right for its question, but it states no end state.
- **ADR-0023, decision 2,** found that "replacing Git's object store, merge machinery, or working-copy model is **not** justified by anything in this analysis". Its amendment to ADR-0001 says Git "stays the substrate for blobs, trees, commits and ancestry indefinitely".
- **Gate B** (product.md §15; ADR-0014) admits a native store only when trials show it is *necessary*:
  - condition 7 asks for a portability requirement Git refs and notes "cannot meet", and the evidence table records it as **evidenced against**;
  - condition 8 asks for overhead "material enough to justify a new subsystem".

  Read literally, the better cst works on Git, the less the gate can open.

These decisions answered "is Git insufficient for the causal layer?", and on that question they still stand. ADR-0023 is still right that nothing *measured* so far requires replacing Git's content store. What changes is the question. The owner has decided the product is a replacement, so the evaluation now has to show what the native system's semantics should be, not whether to build one. **This ADR rests on product intent, not on performance evidence,** and it does not cite any measurement as a reason to replace Git.

**Capabilities the owner named that a layer over Git cannot provide well:**

- **Permissions that tell humans from AI agents.** For example, a repository admin locks files against agents. Git has no actor model. Its forges enforce branch rules and code owners on push, by account, with no notion of an agent acting for a person, and no lock.
- **First-class large-file handling.** Git stores every version of every file in every clone. Large files need Git LFS, which keeps a pointer file in the repository, runs a separate server, and offers locking as an add-on.
- **Freedom from third-party Git implementations.** cst currently runs the `git` executable for every write and most reads. Its native engine depends on gitoxide, which does not read reftable or SHA-256 repositories, so Git 3.0's expected defaults would fall outside it (#277, #278). The owner does not want the product's capabilities bounded by another project's coverage.

**What carries over.** The program so far built most of the semantic layer the standalone system needs, and the transition can test against it:

- the record model and its validators (`native/model`, the authority since #243);
- the published schema catalog and compatibility contract (`docs/schemas/`);
- the human/JSON conformance fixtures;
- the frozen corpora under `test/fixtures/oracle/`;
- the read-side engine seam (ADR-0019), whose equality-tested discipline is how a native subsystem replaces a Git-backed one without changing answers;
- a Rust CLI with no Node or Git library inside it.

## Decision

1. **The end state is a standalone, distributed version control system.** It has its own:
   - object and content store;
   - history model;
   - fact log;
   - names for lines of work;
   - working copy;
   - merge;
   - transport.

   In the end state, cst neither runs Git nor links a Git implementation. Git's role is decision 9.
2. **It is distributed:**
   - every clone is a full peer and works offline;
   - no server is mandatory;
   - a repository may designate **acceptance points** (remotes whose accepted state others treat as authoritative), and policy is enforced there (decision 6).

   Subversion's central server is not adopted; ADR-0001 rejected it on the same grounds.
3. **The workspace is the unit of work.** A line of history is a cheap, movable name, as a Git branch is, not a directory in the tree as in Subversion. A **workspace** joins one line, one working copy, its owning actor and its checkpoints. `cst workspace` already has that shape over Git (ADR-0005, ADR-0012). Several working copies of one repository are first-class, as Git worktrees are. This takes Subversion's "a branch is where you work" without its costs:
   - mixing branch names into content paths;
   - merge tracking kept as properties (`svn:mergeinfo`);
   - a branch model that assumes a server.

   **Staging is an index, as in Git.** A commit records what was staged, not the whole working copy, so a person or an agent can commit part of what they changed. Jujutsu's working copy as a commit was considered and not adopted (owner, 2026-10-17).
4. **The causal layer is the data model, not sideband metadata.** These are native objects of the history, not notes attached to commits:
   - logical change identity, applications, landings, provenance and resolutions (ADR-0002, ADR-0023's fact side);
   - stable specification entities (ADR-0008).

   The coverage proof lattice (ADR-0004) and forecast-before-mutation (ADR-0006) are properties of the system's own operations.
5. **Actors are typed.** Every recorded action names an actor, and every actor is a **human** or an **agent**. An agent acts for a named human or organisation. This extends declared provenance (`causet.provenance/v1`), which today records `--generated-by` and `--reviewed-by` as unverified claims, into identities that can be verified (FR-TRUST-02, #38).
6. **Permissions are actor-aware, and enforced in two layers.** A policy grants or denies an action (write, land, lock, administer) on a path pattern to an actor kind, a role or a named actor. For example: agents may not write `migrations/**`, and only humans may land to the accepted line.
   - **Cooperative, in the client.** cst refuses an action its policy denies the current actor, before anything is written, and says which rule denies it. Agents run cst itself, so this catches nearly every case, and it is cheap.
   - **Authoritative, at acceptance.** An acceptance point verifies each incoming change against the policy and refuses violations, whatever the sending client did. In a distributed system this is the only enforcement that holds, because anyone can write anything in their own clone. It needs verifiable actor identity (decision 5) and a landing coordinator that evaluates policy (FR-LAND-10, FR-TRUST-03, #39).

   **Reading** is in scope for investigation, not yet decided (owner, 2026-10-17). Restricting reads in a distributed system means a clone holds only what its actor may read, which needs partial clones and filtering at the acceptance point; lazy content fetch (decision 7) is the mechanism it would build on. N5's ADR decides whether, and how.

   **Locks** are part of the same policy. A repository admin may lock a path against agents. Any actor may take an exclusive lock on a file that cannot be merged, as Subversion's `svn lock` does, and the acceptance point honours the lock.
7. **Large files are first-class.** The content store:
   - splits files into chunks by their content, so versions that differ in part share storage;
   - fetches content lazily, so a clone needs history without every version of every file;
   - handles large files with no pointer files and no separate server.

   File locks (decision 6) cover files that cannot be merged.
8. **Development's documentation is first-class content.** Instructions, specifications and agent-generated documentation are expected to outnumber code changes. Stable section identity and deterministic section merge (FR-SPEC-*) become operations of the native content store. They stop being a manifest derived beside the files. Markdown stays the canonical form a person edits, as ADR-0008 decided.
9. **Git is the evaluation substrate now, and a permanent two-way bridge in the end state.** Until the native phases replace each part, cst keeps working over Git exactly as today: ADR-0001's constraints stay in force for any repository cst runs over Git. In the end state a cst repository can be hosted on a Git forge, and Git users and cst users work on it together through a bridge that converts in both directions, for as long as the repository wants it, not only once at import (owner, 2026-10-17). Three things follow:
   - **Round trips are exact.** A Git commit imported and exported again has its original object ID. The native store therefore keeps what Git's IDs depend on (author and committer lines, timestamps, signatures, encodings, tree entry modes), and keeps each imported Git object ID as an alias of the native object.
   - **Native facts cross as cst's records do today.** What Git has no place for (change identity, landings, provenance, typed actors, resolutions) crosses the bridge as the notes and refs cst writes over Git now. The current layer becomes the bridge's format, so its contracts keep their value past the transition.
   - **Changes from Git arrive without a verified actor.** A commit a Git user pushes names no actor cst can verify, so the acceptance point treats it as an unverified human's, and policy decides whether it may land (decision 6). How large files cross (whole, or as Git LFS objects on the Git side) is the bridge's ADR to decide.
10. **Gate B is restated, on acceptance of this ADR** (confirmed by the owner, 2026-10-17). Its user-value conditions (1–6 and 9) become **design evidence**: they decide what each native subsystem's semantics are. For example, if compact landing is not preferred in practice, the native history does not make it the default. Conditions 7 and 8 asked whether a native store is necessary; this decision answers that, so they are retired as entry conditions. Each native subsystem still enters through its own ADR, which names:
    - its contract, published before code;
    - its equality test against the Git-backed answer while one exists;
    - how a Git-hosted cst repository migrates to it, records included.

## Constraints

- **No repository becomes unreadable in transition.** Until the import and any bridge exist, every repository cst creates stays a valid Git repository, and stock Git stays its escape hatch (ADR-0001).
- **Contracts outlive the substrate.** The published record schemas, error vocabulary, JSON shapes and conformance fixtures are the product's contracts. A native subsystem answers them identically, or a decision says why not and the corpus re-records by decision, as since #243.
- **One subsystem at a time, each with its own ADR.** Nothing in this ADR approves a native subsystem's design. It approves the direction, and the restated gate the designs pass through.
- **Bridgeable from the start.** The bridge is built last (the phase map), but every native subsystem's ADR shows that its objects round-trip through it exactly (decision 9), so no earlier format can make the bridge impossible.
- **Permissions are never presented as security they do not provide.** Client-side refusal is a guard against accidents. Only acceptance-point enforcement with verified identity is enforcement, and the product says which one applies.

## Proposed phase map

The order, entry and exit of these phases are decided by [ADR-0043](0043-order-the-native-transition-by-dependency-starting-with-n1.md): N1 first, then N2; N3 then N4 beside N5; switch-over and N6 after N1–N5. The table's scope column stands.

The Git bridge comes last (owner, 2026-10-17): the native system is made to stand on its own first, and N6 then connects it to Git hosting. The bridge still constrains every earlier phase ("Bridgeable from the start"). Each phase is one or more ADRs, and each keeps the equality discipline of Gate A while a Git-backed answer exists to compare against.

| Phase | Scope | Proves |
| --- | --- | --- |
| N0 (now) | cst over Git: the evaluation, and the Gate B design evidence (#19, #42, #151) | Which causal semantics earn a native home |
| N1 | Native content store: chunked blobs, trees, snapshots; import of a Git repository with its cst records; read-only first | The content model, and lossless import |
| N2 | Native history and fact log: changes, applications, landings, provenance as native objects; names for lines of work | The causal layer as the data model (decision 4) |
| N3 | Working copy and workspaces: checkout, status, a staging index, several working copies per repository | Decision 3 |
| N4 | Native merge and forecast, including the structured-document merge | ADR-0006 and ADR-0008 natively |
| N5 | Transport between peers, and acceptance points: typed actors, verified identity, policy, locks | Decisions 2, 5 and 6 |
| N6 | The Git bridge: permanent and two-way, with Git hosting | Decision 9 |

## Consequences

### Positive

- The product's purpose is stated where every reader looks. Recommendations stop treating Git-specific gaps (reftable, gitoxide coverage, Git remotes) as product work, and weigh them as transition work.
- The two differentiators the owner named, actor-aware permissions and native large files, get a design home. Neither fits a layer over Git.
- The contracts and corpora already built become the test suite of the native system rather than a description of a layer.

### Negative

- **The scope is that of a version control system.** Git's object store, packfiles, transport, merge and working-copy machinery took years to build; gitoxide, which rebuilds them in Rust, is still pre-1.0. The end state is years of work.
- **Git's ecosystem has to be reached through the bridge:** forges, CI, editors, hosting and every user's habits. Adoption depends on the bridge being very good. With the bridge last, a native release before N6 serves only users willing to leave Git hosting; until then cst over Git (N0) stays the way to use cst with a forge.
- **Exact round trips cost the data model.** The native store carries Git's commit encoding details for every bridged object, for as long as the repository bridges.
- **Some recorded decisions lose their footing:** ADR-0023's decision 2, ADR-0001's "Git stays the substrate … indefinitely" amendment, and Gate B's conditions 7 and 8. On acceptance each needs an amendment that names this ADR.
- Work on the Git layer continues to have value only for the transition. #278 (native engine coverage of reftable and SHA-256 through gitoxide) would be closed or recast. #277 stays useful while users run cst over Git.

## Alternatives considered

- **Stay a layer over Git** (the status quo, ADR-0001 and ADR-0023). Jujutsu shows that a new model over a Git backend can be adopted widely. Rejected because it cannot deliver the owner's product: permissions that tell humans from agents and enforce locks, large files without LFS, and freedom from Git's implementations.
- **Native facts over Git content** (ADR-0023's path: phase 5's canonical fact log, Git keeping blobs, trees and commits). It removes the causal distortions but keeps Git's content model, its large-file limits and its executable. It remains a reasonable intermediate step, and phase N2 can begin with it.
- **Build the native store on gitoxide.** Rejected for the same reason as above: the product's capabilities would be bounded by another project's format coverage, which is what #278 exposed.
- **Subversion-style branches as paths.** Rejected in decision 3. They make a branch a working copy for free, but mix branch names into content paths and assume a central server.
- **A one-time importer only.** Rejected: it would make adopting cst a migration every collaborator must make at once.
- **The Git bridge early.** Rejected: it would tie the first native formats to Git's before the native system stands on its own. The constraint "Bridgeable from the start" keeps the bridge possible instead.
- **The working copy as a commit, as in Jujutsu.** Rejected in decision 3 in favour of Git's index.
- **A central server, as Subversion has.** Rejected in decision 2. Policy is enforced at acceptance points, which a repository may choose to have, not by requiring a server.

## Owner decision

**Accepted by the owner on 2026-10-17**, on
[#279](https://github.com/jwh3times/causet/issues/279), as it stood after the
owner's answers were recorded in
[#280](https://github.com/jwh3times/causet/pull/280):

- **Git in the end state:** a permanent two-way bridge (decision 9).
- **Phase order:** the bridge last, under the constraint "Bridgeable from the
  start".
- **Read permissions:** in scope for investigation; N5's ADR decides
  (decision 6).
- **Staging:** a Git-style index (decision 3).
- **Gate B:** restated as decision 10.
- **The native hash** (the native store's own hash function and object format,
  for example SHA-256 or BLAKE3) is not decided here. N1's ADR decides it.
  Imported Git object IDs are kept as aliases whatever it chooses (decision 9).

Acceptance approves the direction and the restated gate. It approves no native
subsystem's design: each still enters through its own ADR. The phase map above
stays a proposal: the order of N1–N6, their exit criteria, and how native and
Git-backed parts coexist meanwhile are decided separately, under the
[transition map](https://github.com/jwh3times/causet/issues/281). Coexistence
is [ADR-0042](0042-grow-the-native-system-as-a-shadow-with-one-kind-per-repository.md): every repository is wholly native or wholly Git-backed, and the native
system grows as a shadow of the Git-backed one.

On acceptance:

- [ADR-0001](0001-use-git-as-the-compatibility-and-storage-substrate.md),
  [ADR-0014](0014-split-the-native-implementation-gate-into-engine-and-store-gates.md),
  [ADR-0015](0015-adopt-a-phased-native-core-program-with-rust.md) and
  [ADR-0023](0023-locate-the-model-substrate-mismatch-in-facts-not-content.md)
  each carry an amendment naming this ADR;
- [product.md](../product.md) §1, §3, §5 and §15 state the end state and the
  restated Gate B;
- [#278](https://github.com/jwh3times/causet/issues/278) no longer tracks
  gitoxide's coverage. It is recast as testing cst over Git on SHA-256
  repositories through the Git fallback, as #277 does for reftable, because
  that coverage keeps its value for users who run cst over Git.
