# ADR-0023: Locate the model/substrate mismatch in causal facts, not content

- **Status:** Accepted
- **Date:** 2026-09-01
- **Owners:** Repository maintainers
- **Related requirements:** GP-01, GP-12, FR-ID-02, FR-ID-06, FR-ID-07,
  FR-PLAN-05, FR-WS-08, FR-PROTO-04, FR-TRUST-02

## Context

[ADR-0001](0001-use-git-as-the-compatibility-and-storage-substrate.md) chose
Git as the storage and compatibility substrate for the laboratory phase and
listed the price in its own Consequences: *"some desired workspace and causal
concepts are awkward compatibility shapes"* and *"Git's topology remains
visible even when a causal plan has a better model."* That price was accepted
without being itemized. This ADR itemizes it, because the question "should
vcs-lab replace Git rather than sit on it" cannot be answered without knowing
which parts of the model Git actually distorts.

The question is being asked now for a reason that turns out not to support it.
The benchmark evidence shows Windows charging roughly 40 ms per Git process
regardless of what that process does, so `metadata status` at 510 ms is about
57 ms of Git work — the Linux figure for identical process counts — inside
450 ms of process creation. That is a large, real cost, and it is the argument
for the in-process read engine of ADR-0015 phase 1. It is **not** an argument
about Git's storage design:
[ADR-0022](0022-reject-git-read-side-maintenance-caches-on-measured-evidence.md)
quadrupled history depth and every phase was flat or marginally faster, so the
object format was never what the clock was measuring. A native *format* would
recover close to nothing beyond what a native *engine* over the existing
format already recovers.

So performance does not decide this. Expressiveness might. The rest of this
ADR asks, per model concept, whether Git's representation distorts it, and
whether a native store would remove the distortion or merely relocate it.

## Analysis: the distortion inventory

The concepts are those of the PRD §8 identity model. "Removes" means the
distortion disappears; "relocates" means the same problem reappears elsewhere
and must still be solved.

| Model concept | Git representation | Distortion | Native fact store |
| --- | --- | --- | --- |
| Causal edge | No representation | The model's own term for a first-class relation has no storage. `src/identity-audit.js` reconstructs the edge set by union-find over application records scattered across note containers to tell preserved identity (FR-ID-02) from collision. | **Removes.** An edge is a stored edge; the audit becomes a graph query. |
| Application / landing receipt | A JSON record inside a note blob attached to a commit | A fact has no identity of its own. `attachedTo` is synthesized at read time in `src/notes.js`, so a record's location *is* its meaning; it cannot be moved, superseded, or referenced. | **Removes.** A fact gets an identifier and a lifecycle. |
| Receipt validity | Reachability of the commit its note hangs on (FR-PLAN-05) | Validity is inherited from an unrelated object's graph position. This is why an aborted operation strands live-looking receipts that are inert only because the abort made their commits unreachable. The model wants *superseded*; the substrate offers only *unreachable*. | **Removes**, and introduces fact garbage collection as a new obligation Git currently discharges for free. |
| Publishing a fact | `git notes add -f`, whole-blob read-modify-write | Appending one record rewrites the entire container, which forces the ADR-0020 fail-closed rule (a *write* blocked by a *read* incompatibility), the `noteContainerBytes` and `noteContainerRecords` bounds, and the absence of concurrent append. | **Removes.** An append-only log appends. |
| Logical change | `Change-Id:` commit-message trailer | Identity is a convention in prose. `changeIdTrailers` finds commits claiming several; the planner takes the first. `docs/identity/` concedes deliberate collision is trivial. | **Relocates.** Moving the field into the object makes it structural, not unforgeable. Forgery is a trust problem answered by signatures (FR-TRUST-02), not by storage. |
| Workspace | Registry file plus compatibility branch plus worktree | `workspaces.json` is rewritten wholesale on every change, and FR-WS-08 (private draft stacks) is **Deferred** precisely because a public branch is mandatory. | **Removes** for the registry and the draft stack. |
| Checkpoint | Hidden ref `refs/vcs-lab/checkpoints/<id>` | Works, but the ref namespace is doing duty as a keyed store, and nothing fetches it. | **Removes**, marginally. |
| Specification artifact identity | Minted `artifactId` in a path-addressed sidecar under `.vcs-lab/specs/` | Git has no stable file identity, so vcs-lab mints one — then stores it in a file whose *path* is derived from the document's path, the very thing the identity exists to survive. ADR-0008 lists the sidecar as a cost. | **Partly removes.** A native store can record a move explicitly at commit time instead of inferring a rename. The sidecar's other duties remain. |
| Metadata portability | Envelope export/import (`src/metadata-transfer.js`, `src/metadata-envelope.js`, ~780 lines) | Notes and hidden refs are not moved by ordinary fetch — a named PRD risk — so an entire subsystem exists to carry records a native store would simply contain. | **Relocates.** A native store still needs a transfer protocol; you trade "notes are not fetched" for "you must implement fetch." Horizon 4 work either way. |
| Content: blobs, trees, commits, ancestry | Git objects | None found. | **No gain.** |

### The finding

Every distortion in the "removes" column is about **causal facts**. Not one is
about **content**. The mismatch between the model and the substrate is real,
it is substantial, and it is confined to one side of the repository — the side
holding receipts, edges, resolutions, workspaces, and identity, none of which
Git was designed to hold and all of which currently live in trailers, note
blobs, hidden refs, and sidecars.

Git's content model, by contrast, is not distorting anything the PRD asks for,
and it carries weight beyond storage: it is the correctness oracle. Every
forecast is equality-checked against `git merge-tree`
([ADR-0016](0016-simulate-clean-forecast-steps-with-a-merge-tree-session.md)),
`git fsck` is a release-gate check, and stock Git is the documented recovery
path when an operation is interrupted (FR-GIT-03). Replacing it removes the
independent check that every semantics claim in this repository currently
rests on, at the same moment as introducing the code that most needs checking.

## Decision

**The causal fact substrate is where the model is distorted, and is the only
part a native store is justified in replacing. Git's content substrate stays.**

1. A native causal fact store is the correct long-term target and is worth
   designing. This is the existing Horizon 5 phase 5 scope — canonical fact
   log, notes and refs regenerated at finalization, private draft stacks — and
   it remains behind Gate B, which is unmet.
2. Replacing Git's object store, merge machinery, or working-copy model is
   **not** justified by anything in this analysis, and specifically is not
   justified by the performance evidence, which points at process creation
   rather than at storage.
3. ADR-0001 stays in force for content. The phase 5 ADR partially supersedes
   it for facts only, as Horizon 5 already anticipates.
4. The trust distortion is not a storage problem. `Change-Id` forgery is
   answered by FR-TRUST-02 signatures whatever the substrate, and moving
   identity into an object must not be presented as making it authentic.

## Constraints

- This analysis is about expressiveness, not speed. No performance claim may
  cite it, and the phase 1 engine decision is independent of it.
- The fact store must keep Git as oracle and escape hatch while it exists:
  facts regenerate into notes and refs at finalization, `git fsck` stays clean,
  and deleting the native store must leave a working repository.
- Gate B's nine conditions remain the entry test. Condition 7 — *metadata
  portability requirements cannot be met cleanly with Git refs and notes* — is
  the one this analysis speaks to, and it argues that condition is closer to
  met than the current status implies. Conditions 1 through 6 and 9 are
  user-value evidence this ADR does not supply.

## Consequences

### Positive

- The question "replace Git?" is decomposed into two questions with different
  answers, instead of one question with no evidence.
- The distortion inventory is written down and citable, rather than living as
  one accepted sentence in ADR-0001.
- Phase 5's scope gains a rationale about the model rather than about process
  counts, which is the kind of argument that survives a faster host.
- It marks where a native store would *not* help, which is where effort would
  otherwise be wasted.

### Negative

- Two substrates coexist for as long as phase 5 lasts, with facts canonical in
  one and regenerated into the other.
- Fact garbage collection becomes vcs-lab's problem; reachability does that
  work for free today.
- The inventory is derived from the current implementation, so a concept the
  PRD has not yet exercised could add a distortion this table misses.
- Weighing interop against expressiveness is a product judgment, not a
  technical finding. A maintainer who values the model more than adoption
  could read the same table and reach a broader decision.

## Alternatives considered

- **Replace Git entirely — own object store, working copy, merge, and
  transport.** Rejected on this evidence, not on principle. The analysis found
  no content-model distortion to fix, so the work would be justified by the
  fact-side gains alone, which the narrower option already delivers. It would
  additionally forfeit the correctness oracle, stock recovery, and the
  no-migration adoption path ADR-0001 was written to preserve, and it puts the
  interop network effect at risk — the variable that decided the outcome for
  jj, which kept a Git backend, Sapling, which kept interop, and Pijul, which
  did not. **What would change this:** a model concept Git's content objects
  cannot express at all, sustained evidence that the oracle no longer catches
  anything once forecast equality is proven over a large generated corpus, or a
  product decision that adoption without migration no longer matters.
- **Keep Git for everything and accept the shapes.** Rejected because the
  inventory shows the cost is not cosmetic: a first-class relation with no
  representation, facts whose validity is an accident of another object's
  reachability, and a P2 requirement (FR-WS-08) deferred outright by the
  substrate.
- **Decide it on the benchmark numbers.** Rejected because they measure process
  creation, which a native format does not address and a native engine does.
- **Defer the question until Gate B.** Rejected because the analysis needs no
  measurement, and phase 5's scope should be justified before it is built
  rather than after.

## Implementation map

- Substrate decision this refines:
  [ADR-0001](0001-use-git-as-the-compatibility-and-storage-substrate.md)
- Gates:
  [ADR-0014](0014-split-the-native-implementation-gate-into-engine-and-store-gates.md)
  Gate B; `docs/product.md` §15
- Phased program and phase 5 scope:
  [ADR-0015](0015-adopt-a-phased-native-core-program-with-rust.md);
  `docs/roadmap.md` Horizon 5
- Performance evidence cited:
  [ADR-0022](0022-reject-git-read-side-maintenance-caches-on-measured-evidence.md);
  `benchmarks/baseline.json`
- Distortions inventoried in code: `src/notes.js`, `src/identity-audit.js`,
  `src/workspaces.js`, `src/specs.js`, `src/metadata-transfer.js`

## Amendment 2026-09-02: accepted, and one correction

Accepted after the decision was tracked on
[issue #16](https://github.com/jwh3times/vcs-lab/issues/16). Nothing in the
analysis changed; one thing said about *how to test it* did, and it matters
enough to record here rather than only on the issue.

This ADR names sub-commit authorship provenance as the first serious candidate
for a model concept the content substrate cannot express, and the proposed way
to find out was to ship commit-level provenance and dogfood it. Commit-level
provenance shipped in v0.12.0. **Dogfooding it in this repository cannot
produce the evidence**: the repository has 71 commits, 67 of them
single-parent, zero squash landings and zero `Change-Id` trailers. It never
rewrites, so provenance is only ever *declared* here and never *carried* — and
the carry is the whole point, the part Git cannot do. Neither signal the
question turns on can appear.

The prerequisite is therefore a branch-and-land workflow, here or on another
repository, not the `vlab init` that was first proposed as a small step. Until
that exists, the content half of this decision stands unchallenged by evidence
rather than confirmed by it, which is the honest description of its status.
