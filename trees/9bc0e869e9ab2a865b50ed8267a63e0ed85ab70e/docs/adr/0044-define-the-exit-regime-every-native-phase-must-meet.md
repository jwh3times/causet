# ADR-0044: Define the exit regime every native phase must meet

- **Status:** Accepted (owner, 2026-10-17)
- **Date:** 2026-10-17
- **Owners:** Repository maintainers
- **Related requirements:** GP-12, NFR-PERF-03, NFR-PERF-06, NFR-PERF-07,
  NFR-PORT-01
- **Builds on:** [ADR-0041](0041-make-cst-a-standalone-distributed-version-control-system.md),
  [ADR-0042](0042-grow-the-native-system-as-a-shadow-with-one-kind-per-repository.md),
  [ADR-0043](0043-order-the-native-transition-by-dependency-starting-with-n1.md)
- **Amends:** [ADR-0014](0014-split-the-native-implementation-gate-into-engine-and-store-gates.md)
  (Gate B, as ADR-0041 restates it)
- **Decided on:** [#284](https://github.com/jwh3times/causet/issues/284), under the
  [transition map](https://github.com/jwh3times/causet/issues/281)

## Context

ADR-0041 restated Gate B. Each native subsystem now enters through its own ADR,
and none waits on evidence that a native store is necessary. ADR-0043 made a
phase's exit what every later phase's exit waits on. Nothing yet says what an
exit requires.

The regime has to respect several earlier decisions:
- **Release gates run in CI** (owner, 2026-10-09): no gate or acceptance
  criterion may need the owner's own machines.
- **Shared runners can't measure time fairly.** `perf.yml` already reports
  timings on them and never fails on one.
- **Exits are judged on copies.** Every repository is one kind, and before N5
  every phase exit is judged on imported copies (ADR-0042).
- **The owner's standing preference:** each phase's exit includes running
  causet's own repository on that phase, on a copy first.

## Decision

Every phase ADR cites this regime. A phase exits only when it meets all of the
following, limited to the commands and objects that phase implements.

1. **Equality across kinds.** Each command answers as the Git-backed command
   does on the same history. Object IDs are translated through the import's
   alias map, and nothing else may differ. Every phase runs all four corpora:
   - **a native-kind suite mode:** each integration test's repository is
     imported, and the phase's commands answer from the native copy;
   - **the conformance fixtures** (`docs/conformance/`) **and the frozen oracle
     corpora** (`test/fixtures/oracle/`);
   - **a generated-history corpus** of at least 1,000 histories: merges,
     rewrites, renames, and large and binary files. The phase ADR names the
     cases it adds;
   - **real repositories imported in CI:** causet's own, and public
     repositories the phase ADR names.
2. **Deterministic performance gates.** Timings are reported, never gated.
   - A native repository runs **zero Git processes**.
   - **Stored bytes** are at most Git's fully packed size (`git gc --aggressive`)
     on each real repository in item 1. On a large-file corpus, which the phase
     ADR names, they are **strictly smaller**.
   - From N5, **transferred bytes** for a fetch are at most Git's for the same
     fetch.
3. **History replay.** CI imports causet's own repository, replays its history
   through the phase's native commands, and compares each result with what Git
   recorded:
   - N2: the imported facts;
   - N3: checkouts and commits reproduce each tree;
   - N4: each recorded merge, re-merged, gives the recorded result;
   - N5: a clone between two runners is complete.

   Agent sessions on a copy are recorded as evidence on the phase's issue and do
   not gate.
4. **The reconstruction check.** From N1, every imported Git object is rebuilt
   in Git's encoding from the native store and the alias map, and must hash to
   its original object ID. It runs on every corpus in item 1, and each phase
   extends it to the objects it adds. It verifies only: it never writes a Git
   repository. This is how "Bridgeable from the start" (ADR-0041) is proven
   before N6 exists.
5. **Import checks.** Each runs on the corpora of item 1.
   - From N1, re-importing the same history yields byte-identical native
     objects.
   - From N1, an incremental import after new commits equals a full import of
     the final history.
   - From N2, every record of the Git-backed repository (notes, refs, retained
     resolutions) is present natively, and quarantined or parked records stay
     so.
6. **Platforms.** Every criterion passes on GitHub-hosted Linux and Windows
   runners, and on macOS once releases include it. No criterion needs a
   maintainer's own machine.
7. **Permanence.** Once a phase exits, every criterion of that phase stays a CI
   check on each pull request that touches native code, so a later phase cannot
   break an earlier exit. The heavy corpora (generated histories and real
   repositories) run weekly and on release dispatch, as `perf.yml` does.
8. **Declaration.** The owner declares an exit on the phase's issue, against a
   named CI run on the candidate commit that passes every criterion. Nothing
   exits automatically.
9. **Waivers.** Only the owner may waive a named criterion, for one phase,
   through an amendment to that phase's ADR. The amendment states why the
   criterion is waived and when the waiver ends. Nothing is waived silently.

## Constraints

- **The regime adds to a phase ADR and never replaces it.** A phase ADR may add
  criteria of its own, but it may not drop one of these without a waiver
  (item 9).
- **N1 builds the machinery first.** The reconstruction check, the import
  checks and the native-kind suite mode are N1 deliverables, because every
  later phase runs them.

## Consequences

### Positive

- An exit means the same thing for every phase, and anyone can re-run it from
  the repository.
- The bridge's encoding half is built and tested from N1, five phases before
  the bridge.
- The large-file gate makes one of the owner's two differentiators measurable
  from the first phase.
- Permanence turns each exit into a regression suite for the phases after it.

### Negative

- **CI cost grows with every phase.** Each exit adds permanent checks, and the
  heavy corpora need weekly scheduled runs.
- **The storage gate binds N1's format choices early.** A format that can't
  match Git's packs on real repositories doesn't exit without a waiver.
- **Time is never gated.** A native command could be slower than Git and still
  exit. Whether time becomes a gate at switch-over is left to a later decision.
- **History replay covers only causet's own history,** which has few rewrites
  and little conflict (ADR-0023's amendment). The generated corpus has to
  supply what it lacks.

## Alternatives considered

- **Report performance only.** Rejected: bytes are deterministic, and storage
  is one of the product's claims.
- **Gate a same-run timing ratio.** Rejected for now: too noisy on shared
  runners.
- **A 110% storage tolerance.** Rejected: the content-store research reached
  less than Git's pack on causet's history, and large files should win
  outright.
- **Agent sessions as the dogfood gate.** Rejected: they run on the owner's
  machines.
- **A phase-specific corpus choice.** Rejected: every phase runs all four
  corpora, so no phase skips scale or edge cases.
- **Exit without the owner's declaration.** Rejected: agents build, and the
  owner decides.
- **No waivers.** Rejected: a waiver would happen anyway, informally. ADR-0037's
  recorded waiver is the precedent.
