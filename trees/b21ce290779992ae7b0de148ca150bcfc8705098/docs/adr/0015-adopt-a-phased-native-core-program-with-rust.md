# ADR-0015: Adopt a phased native-core program with Rust as the core language

- **Status:** Accepted
- **Date:** 2026-08-28
- **Owners:** Repository maintainers
- **Related requirements:** GP-01, GP-09, GP-12, FR-GIT-01 through FR-GIT-04,
  FR-PERF-02 through FR-PERF-09, FR-WS-08, FR-WS-09, NFR-PERF-01 through
  NFR-PERF-07, NFR-PORT-01, NFR-PORT-04, NFR-PORT-05, NFR-SEC-03

## Context

On 2026-08-28 the owner chose Rust as the language of any native core and
asked for a sequence that enters native code without a rewrite. Git stays the
exact-state store. In native engine mode a native core stands in for the
process-per-query orchestration in `src/git.js` and the invocation-scoped
`cat-file` worker of
[ADR-0009](0009-use-an-invocation-scoped-git-object-session.md); ADR-0009
remains the accepted contract for the Git engine and its fallback, and its
worktree-isolation and OID-rooted cache constraints bind the native engine
equally. Whether Git notes and hidden refs later become projections of a
native fact log is a Gate B question under
[ADR-0014](0014-split-the-native-implementation-gate-into-engine-and-store-gates.md)
and is not decided here. Comparable projects (Jujutsu, GitButler,
git-branchless, Sapling's Git mode) converged on Git as the exact-state store
with a native core and a separate metadata log, and each uses Rust for that
core (Sapling alongside Python); none projects its log into Git notes, so
that projection would be this project's own choice.

Facts that constrain the decision (verified 2026-08-27/28):

- gitoxide (`gix`) is the only mature pure-language implementation of Git's
  on-disk formats. Its crate status marks notes CRUD, status, merge-base,
  three-way blob and tree merge (tree merge is flagged by its author for a
  correctness rewrite), index, packs, multi-pack index, and commit-graph as
  done; reftable, SHA-256 parity, sequencer/cherry-pick, bundles, push,
  promisor fetch, and linked-worktree creation as absent. It is pre-1.0 with
  frequent breaking releases (three 0.x releases in August 2026 alone) and
  has had security advisories.
- libgit2 (via `git2`) covers worktree creation and in-index merges but has no
  reftable support and only experimental SHA-256; 1.9 is expected to be the
  final 1.x minor line, with SHA-256 graduating from experimental only in 2.0.
- `git merge-tree --write-tree` exists since Git 2.38; `--merge-base`, which a
  per-step cherry-pick simulation needs, arrived in 2.40. The project floor
  was 2.38.
- On the Linux development host (Git 2.55, Node 26) an ad-hoc, unrecorded
  observation put a Git process launch at roughly 1.5–2.5 ms and Node startup
  at roughly 22 ms; these are development-host observations, not benchmark
  results. ADR-0009 documents 80–130 ms per process on the Windows host. The
  material wins are therefore Windows/OneDrive latency, forecasts without
  temporary worktrees, catalog scaling, and many-agent concurrency, not raw
  speed on POSIX.

## Decision

### Sequence

The program runs in the following order. Each phase's exit criterion is the
next phase's precondition, each phase is reversible, and the program may stop
after any phase with a complete outcome. Scope and exit criteria live in
`docs/roadmap.md` Horizons 1.5, 2, and 5; every phase that changes a durable
decision receives its own ADR before code is written. This ADR fixes the
order, the gates, the language, and the funded costs.

1. **Phase 0a, Git-native wins** (no new language): clean forecast steps
   simulated with `git merge-tree` behind a flag, the Windows post-batching
   rerun, and the Git-best-mode baseline (Gate A item 2).
2. **Phase 0b, contract freeze and engine seam**: schema catalog, canonical
   JSON profile, and a single read-side engine seam (Gate A item 1). The phase
   1 ADR names the Gate A item 3 budget from the phase 0a runs before any
   phase 1 code, or the program stops here with a complete outcome.
3. **Phase 1, native read engine in Rust** behind the seam (Gate A; kill
   switch and the ADR-0014 sunset apply here).
4. **Phase 2, native planning and status** (Gate A; per-operation fallback).
5. **Phase 3, derived, deletable catalog** (Gate A; begins only when
   ADR-0013's incremental-catalog row fires).
6. **Phase 4, in-memory forecasts and native mutation** (Gate A; may be
   dropped entirely after phase 0a evidence).
7. **Phase 5, canonical fact log, transport, and draft stacks** (Gate B; the
   ADR partially superseding ADR-0001 is written here).
8. **Phase 6, gateway**; a resident service only if ADR-0013's row fires.

### Language and stack

Rust is the language of `vlab-core`. The Node.js CLI remains the command
surface, presentation layer, orchestration layer, test harness, and conformance
oracle until a Rust CLI passes the same suite; the JavaScript engine remains a
fully functional fallback for the life of the program.

- Exposure: napi-rs bindings consumed in-process by the CLI, with a
  standard-input/output sidecar as fallback for non-Node hosts. The core uses
  `#![forbid(unsafe_code)]`; unsafe code is confined to binding glue; panics
  are caught at the boundary so a native fault never aborts the CLI.
- Backends: gitoxide for object, ref, index, status, notes, and blob-merge
  reads; libgit2 for worktree creation and in-index merges; the Git executable
  for sequencer continue/skip/abort, bundles, push, and any repository whose
  ref backend or object format the native crates do not support. The
  supported native profile is files-backend refs with SHA-1 objects;
  reftable and SHA-256 repositories route to the Git executable until gitoxide
  supports them, and the engine advertises its supported profile. The phase 1
  ADR records a per-operation backend matrix before code is written.
- Encoding: RFC 8785 canonical JSON with a project profile (no floats, sorted
  keys, versioned encoders) computed identically by Node and Rust from shared
  test vectors. CBOR is rejected.
- The protocol work in phases 3 and 5 (segments, canonical JSON, catalog,
  projections, envelope v2, transport) is file and JSON work that does not
  itself require Rust; Rust pays for object reads, status, hashing, and
  in-memory merge.
- jj-lib is neither adopted nor rejected; a bounded spike in phase 1 decides
  borrow versus depend for phase 5.

### Costs accepted

The owner funds the following costs explicitly:

- toolchain ramp-up on a development host that has none today: Rust, a C
  compiler and CMake (libgit2 and bundled SQLite compile C), and MSVC or
  cross-linking for Windows prebuilds, with build caching in CI;
- the package promise changes from "no runtime dependencies, no build step" to
  "an optional prebuilt native binding with automatic fallback; the package
  must remain fully functional and pass the suite without it", which requires
  a publishing pipeline (the package is not published to npm today),
  per-platform prebuilds, provenance, and code signing;
- three moving backends (gitoxide, libgit2, Git executable) with an
  equality discipline among them and version pinning behind an internal trait;
- a velocity reduction for one maintainer during phases 1 and 2, mitigated by
  the seam-first order and automated multi-mode equality;
- licensing obligations recorded in the phase 1 ADR (libgit2 GPLv2 with
  linking exception; Apache-2.0 attribution if jj-lib code is borrowed);
- a review discipline for FFI and parsing code, and fuzz targets for every
  native parser of untrusted input.

### Git floor

The supported Git baseline is raised from 2.38 to 2.40 (NFR-PORT-01 release
decision) so that phase 0a can use `git merge-tree --merge-base`.

## Constraints

- No receipt-publishing path moves engines before an equality test exists for
  it; every JSON result reports `engine` and `fallbacks`.
- Every efficiency claim follows ADR-0014's definition: elapsed time and bytes
  per host against plain Git's best mode and any named alternative, with
  identical results.
- Phase 5 begins only under Gate B; phases 0 through 4 never add a canonical
  store.
- A phase that misses its exit criterion is reverted behind its flag, not
  patched forward.

## Consequences

### Positive

- The destination matches the PRD's stated intent and the shape used by
  comparable projects, without a rewrite.
- Rust is adopted where it pays (object reads, status, hashing, merge) and
  not where it does not (protocol records).
- The first increment is Rust-free, reversible, and produces the baseline
  every later claim must beat.

### Negative

- Two implementations of read contracts coexist for the length of the program.
- gitoxide churn and gaps keep the Git executable on the mutation path longer
  than a clean design would like. Git 3.0 is reported to make Rust a mandatory
  build dependency and to default new repositories to SHA-256 and reftable
  (target late 2026, unconfirmed); until gitoxide supports both, those
  repositories fall outside the native profile.
- Phase 4 re-implements merge semantics Git already exposes worktree-free; it
  may be dropped.

## Alternatives considered

- **Stay Node-only:** remains the correct phase 0 and the kill-switch outcome,
  but cannot remove Node startup or the Windows spawn floor for reads, cannot
  do in-process status and hashing at scale, and cannot become a core a
  gateway shares.
- **Go:** best for a standalone daemon; go-git lags on worktrees, status, and
  merge, and Go has no first-class in-process Node binding; consuming it
  requires cgo-built shared libraries and a C toolchain on every platform.
  Revisit only for a Horizon 4 gateway.
- **C or C++ on libgit2 directly:** manual memory safety on untrusted input
  becomes the project's problem; used only through `git2` from Rust.
- **Zig:** pre-1.0 with no Git library ecosystem; a semantics laboratory
  should not also carry a language-stability bet.
- **A Rust-first CLI rewrite:** violates GP-12 and the PRD §16 risk "native
  rewrite begins too early".
- **Protocol-first clean slate:** the most complete successor design, but it
  designs a wire protocol, attestations, and a landing transaction before
  Horizon 2 exists and before any cross-clone use; its verifier contract and
  landing-transaction shape are kept for phase 6.
- **Depend on jj-lib now:** deferred to the phase 1 spike. jj-lib already
  provides an operation log, views, change IDs, conflicts as values, and
  workspaces, but no receipts, proof lattice, resolution memory, forecasts, or
  spec merge, and its API is unstable.

## Implementation map

- Gates and efficiency definition: ADR-0014, `docs/product.md` §15 and §18
- Scope and exit criteria per phase: `docs/roadmap.md` Horizons 1.5, 2, and 5
- Git floor: `docs/product.md` NFR-PORT-01, `README.md`, `AGENTS.md`,
  `docs/testing.md`, `docs/architecture.md`
- Per-phase ADRs, written before each phase's code: merge-tree forecast
  simulator; engine seam and differential equality; Rust core backend matrix;
  derived catalog; virtual forecast merge; canonical fact log
