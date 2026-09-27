# ADR-0037: Reimplement the vlab CLI in Rust as a semantics-preserving port

- **Status:** Proposed
- **Date:** 2026-09-27
- **Owners:** Repository maintainers
- **Implementation:** [#136](https://github.com/jwh3times/vcs-lab/issues/136) (program map),
  decided in [#137](https://github.com/jwh3times/vcs-lab/issues/137)
- **Amends:** [ADR-0015](0015-adopt-a-phased-native-core-program-with-rust.md) (phase order and
  the rejected "Rust-first CLI rewrite"), when accepted
- **Related:** [ADR-0001](0001-use-git-as-the-compatibility-and-storage-substrate.md),
  [ADR-0009](0009-use-an-invocation-scoped-git-object-session.md),
  [ADR-0014](0014-split-the-native-implementation-gate-into-engine-and-store-gates.md),
  [ADR-0019](0019-route-every-git-read-through-one-engine-seam.md),
  [ADR-0020](0020-freeze-per-family-compatibility-and-resource-bounds.md),
  [ADR-0021](0021-give-failures-a-versioned-machine-readable-envelope.md),
  [ADR-0023](0023-locate-the-model-substrate-mismatch-in-facts-not-content.md),
  [ADR-0027](0027-bound-native-read-engine-entry-by-the-resolution-catalog-budget.md)
- **Related requirements:** GP-01, GP-09, GP-12, NFR-PORT-01, NFR-PORT-02, FR-PERF-09

## Context

On 2026-09-27 the owner directed that `vlab` become a fully standalone CLI: installed with
`npm install -g`, and implemented in Rust, so that running it needs no Node.js runtime.

ADR-0015 considered this and rejected it on 2026-08-28:

> **A Rust-first CLI rewrite:** violates GP-12 and the PRD §16 risk "native rewrite begins too
> early".

It put an "optional thin Rust CLI with byte-identical JSON" in phase 5, behind Gate B. Yet the
same ADR expected the destination: "The Node.js CLI remains the command surface … until a Rust
CLI passes the same suite." ADR-0015 rejected *starting* with a CLI rewrite, not arriving at one.
This ADR has to say what changed, and under which gate a CLI port belongs.

### What changed since 2026-08-28

1. **A second implementation now has a fixed bar.**
   - When ADR-0015 was written, no contract existed that a second implementation could be
     held to.
   - Since then, phase 0b froze the schema catalog, the canonical JSON profile and its
     vectors, and the per-family compatibility contract with resource bounds (ADR-0020).
   - It also froze the human/JSON conformance fixtures, the error envelope (ADR-0021), and
     the 44-operation read catalog behind one seam (ADR-0019).
   - "Native rewrite begins too early" was a risk about building without an oracle. The
     oracle now exists, and every command's observable behavior is pinned by a suite that
     drives the real CLI.
2. **The measured cost is the runtime, not the reads.** Phase 1 put Rust behind the seam
   and proved it equal. It also showed how little that buys end to end, because the Node
   process dominates:

   | Evidence | Domain read | Whole command |
   | --- | --- | --- |
   | POSIX, note catalog, #42 (2026-09-22) | 15.2 → 9.7 ms native | 75.8 → 70.3 ms |
   | Windows, resolution catalog, #42 (2026-09-27) | 36.9 ms native | 148.7 ms |
   | Windows, note catalog, #42 (2026-09-27) | 61.2 ms native | 196.4 ms |

   ADR-0015 already said the Node-only path "cannot remove Node startup". Neither can a
   binding loaded by Node. The 110%-of-Git criterion excludes Node startup "until a native
   CLI exists" for the same reason.
3. **The in-process boundary has a cost of its own.** #130 was a Windows abort at process
   exit caused by N-API external buffers whose Rust finalizers ran during Node's environment
   teardown. A Rust process has no such boundary.
4. **Distribution is now a product requirement.** The package is not published anywhere,
   and the only install route is `npm link` from a clone. A standalone binary is what makes
   an npm install both self-contained and fast.

## Decision

### 1. Reimplement the whole CLI in Rust, as a port

The command surface of `vlab` is reimplemented in Rust as a standalone executable. The
target (#152) is that the installed `vlab` is that executable.

It is a **port**:
- the same commands, flags, and messages;
- the same records, byte for byte;
- the same Git operations in the same order.

It is not a redesign. A behavior change found necessary during the port is made first in
the JavaScript CLI, released, and then ported. It is never introduced by the port.

### 2. It is Gate A work, not Gate B

Gate B governs semantics-changing work: a canonical store, a protocol, draft stacks. A port
changes none of those, so the "thin Rust CLI" line leaves phase 5, and the port runs as its
own track beside ADR-0015's phases. It keeps every Gate A discipline:

- identical output in every engine mode;
- reversibility;
- no receipt-publishing path moves before an equality test exists for it;
- no canonical store or persisted-contract change.

Two Gate A rules are **waived for this program only**, on the owner's direction:

- **Item 3 (a named budget miss before beginning).**
  - The program is justified by distribution and by the whole-command cost above, not by a
    per-command budget miss.
  - Broad budget ratification stays open on #42, and #151 supplies the evidence.
- **The two-release sunset.**
  - A sunset exists to remove an engine that failed its named budget. With no named budget,
    there is nothing for it to measure.
  - The parity-only stop rule and the checkpoint report in decision 7 replace it.

Phases 1 to 4 are unchanged. The port neither requires nor authorizes a native catalog
(phase 3) or native mutation and in-memory merge (phase 4); each still needs its own
decision.

### 3. Git stays; the port changes the language, not the backend

The Git executable remains a runtime requirement (ADR-0001, ADR-0023, GP-01):
- Every mutation is the same explicit `git` invocation the JavaScript CLI makes today.
- Every read goes through the same cataloged operations (ADR-0019), under the ADR-0009
  object-session contract.
- gitoxide answers only the operations it is already qualified for (ADR-0027) and whatever
  later Gate A decisions add.

This ADR adds no libgit2 and no new backend. "Standalone" means no Node.js, not no Git.

### 4. The transition is a hybrid binary that delegates whole commands

Until the port is complete, the Rust `vlab` does two things:
- It answers each **ported** command natively.
- It **delegates** each unported command to the JavaScript CLI (`node bin/vlab.js`),
  passing the same arguments, environment, working directory and standard streams, and
  returning its exit code.

Rules:

- **Delegation is per command, never per operation.** One invocation runs entirely in one
  implementation, so a journal, forecast, or receipt is never half-written by each.
- **What makes a command native.** Every CLI-level test that exercises it must pass under
  the `VLAB_CLI` mode (#140), in all six engine and session modes. Until then it is
  delegated.
- **A forced-delegation switch** runs any command through the JavaScript CLI, so ported
  commands can be compared against the oracle on demand.
- **Node stays a runtime requirement until #152.** Up to then, "standalone" describes the
  destination, not the state.

### 5. The JavaScript CLI is the oracle, and parity means bytes

Until cutover, the JavaScript CLI is the oracle for the command surface. Git remains the
oracle for reads.

Parity means **byte-identical standard output, standard error and exit code**, human and
`--json` alike, with two exceptions:
- the volatile fields the conformance fixtures already normalize (timings and generated
  identifiers);
- **runtime self-description**: `vlab doctor` reports the Node.js version today (`node`).
  The port adds an implementation and runtime description to `doctor` in both
  implementations first, as an additive change. No other field may differ.

Records must be **interchangeable across implementations**. Anything one writes, the other
reads with the same result. This covers:
- notes records, receipts, and envelopes;
- forecasts and journals;
- the workspace registry and the resolution memory.

A mixed repository, touched by both during the transition, stays valid.

### 6. After cutover, the JavaScript CLI stays as an oracle for two minor releases

The `VLAB_CLI` mode keeps running both implementations in CI. After those two releases:
- the JavaScript implementation and the N-API binding (`native/binding`) are removed;
- the conformance fixtures, canonical JSON vectors, and schema catalog remain the contract.

### 7. The stop rule, and performance as a running report

The program stops, with the hybrid binary removed and the JavaScript CLI kept as the
product, **only if parity fails**: a command cannot reach byte-identical parity without
changing a published contract, and the owner declines to change that contract through the
JavaScript CLI first.

**No benchmark result stops the program, and none blocks a command from going native or the
cutover.** The owner's direction on 2026-09-27 is that Rust is the right implementation
whatever the interim numbers show. Performance is measured and reported, and a regression
becomes optimization work:

- **Checkpoints.** Benchmarks run at defined points (#151):
  - checkpoint 0: the JavaScript CLI's baseline;
  - after the skeleton with every command delegated, which measures the delegation cost;
  - after each port;
  - after the packaged install;
  - at cutover.

  Each checkpoint runs on `lab-windows-a`. POSIX figures are added where a host is
  available.
- **What each checkpoint records.** Whole-command and phase timings for the Rust CLI, the
  JavaScript CLI, and the raw-Git floor, together with Git process counts, host load
  conditions, and the exact commits measured.
- **Where it is recorded.** The running report is the public wiki page
  [Performance testing](https://github.com/jwh3times/vcs-lab/wiki/Performance-testing),
  one section per checkpoint, newest first, with raw samples retained on #151.
- **What a slower result produces.** An optimization issue linked from the report,
  carrying the measurement and the suspected cause. It never produces a stop, a revert, or
  a hold on the port.

The whole-command numbers also feed #42, where any budget decision lives.

### 8. Layout and discipline

- A binary crate (`vlab`) joins the `native/` workspace beside `vlab-core`.
- `vlab-core` stays the home of Git acquisition. Domain logic lives in crates the CLI owns,
  and every crate except the retiring N-API binding uses `#![forbid(unsafe_code)]`.
- The pinned toolchain, `--locked` builds, and fuzzing of every parser of untrusted input
  carry over from ADR-0015.
- Each new dependency is reviewed before use, as ADR-0027 required. An argument-parsing
  dependency is acceptable only if it can reproduce the current help and error text
  exactly.
- Distribution (npm package layout, platforms, signing) is decided separately, in #138.

## Constraints

- No published contract changes as part of the port: schemas, canonical JSON, the error
  envelope, and compatibility. A contract change goes through the JavaScript CLI first,
  with its own decision.
- Every ported command passes its CLI-level tests under `VLAB_CLI` in all six modes before
  it stops delegating.
- Git process counts are **reported, not part of parity**. Each checkpoint compares them
  with the JavaScript CLI's. A ported command that launches more is an optimization
  finding filed as an issue, never a parity failure.
- Nothing under Gate B begins because of this program.

## Consequences

### Positive

- Every command runs without Node startup, which #42 identifies as the dominant cost.
- One process per command removes the N-API boundary and its teardown hazards.
- `npm install -g` can deliver a self-contained executable (#138, #150).
- The frozen contracts are exercised by a second implementation, which is the strongest
  test of whether they are really specifications.

### Negative

- About 21,600 lines of JavaScript are reimplemented. For the length of the program there
  are two implementations of every command, and each behavior change is made twice.
- Contributors need Rust to work on the command surface after cutover.
- The phase 1 N-API work becomes transitional and is removed after the oracle period.
- Until #152, users of the hybrid still need Node, so the standalone benefit arrives only
  at the end.

## Rejected alternatives

- **Keep the Node CLI and extend the N-API binding.** This is ADR-0015's current path. It
  cannot remove Node startup, and #42 shows startup dominates whole-command time. It also
  keeps the in-process boundary that produced #130.
- **Big-bang cutover.**
  - Port everything, then switch.
  - Nothing ships natively until the last command is done, and a long-lived branch diverges
    from `main`.
  - The hybrid delivers each command as it passes, and keeps one `vlab` throughout.
- **A separate `vlab-rs` command beside `vlab`.**
  - Users would have to choose an implementation, and scripts would diverge.
  - Parity would be checked by convention rather than by one command running both.
- **Package Node with the JavaScript CLI (a single-executable application).**
  - This makes it installable without a system Node, but keeps Node's startup inside the
    executable and does nothing for the measured cost.
  - It also ships a full runtime per platform.
- **Port under Gate B, as phase 5 placed it.** Gate B's nine conditions concern
  semantic change and user evidence. None of them bears on a port that changes no
  semantics, and waiting on them would tie a distribution goal to unrelated product
  evidence.

## What the owner must decide

1. **Classification:** the port is Gate A work, and the "thin Rust CLI" leaves phase 5.
2. **The two waivers:** Gate A item 3 and the two-release sunset, for this program only,
   replaced by the stop rule in decision 7.
3. **The transition:** the hybrid binary delegating whole commands, with Node required
   until #152.
4. **Parity:** byte-identical output with the two named exceptions, and records
   interchangeable across implementations.
5. **After cutover:** the JavaScript CLI retained as an oracle for two minor releases,
   then removed together with the N-API binding.
6. **The stop rule:** parity only. Performance never stops the program, as the owner
   directed on 2026-09-27; it is reported at checkpoints on the Performance testing wiki
   page, and a regression becomes an optimization issue.

On acceptance, the same change amends ADR-0015 (status `Accepted, amended by ADR-0037`) and
updates `docs/product.md` §15: the phase table and GP-12's note. The phase table is not
changed while this ADR is Proposed.

## Implementation map

- **Program and order:** #136. Enablers #140 (suites against any executable) and #141
  (skeleton and delegation), then #142 and #143, the ports #144–#149, then #150, #151, #152.
- **Distribution:** #138 (ADR), #139 (npm publishing setup, human), #150 (CI).
- **Performance:** #151 runs the checkpoints and maintains the running report on the
  [Performance testing](https://github.com/jwh3times/vcs-lab/wiki/Performance-testing)
  wiki page. Optimization findings become their own issues.
- **On acceptance:** `docs/adr/0015-…` status line; `docs/product.md` §15 (phase table and
  gate text) and GP-12's row; `docs/architecture.md` once the first native command ships.
- **At cutover:** NFR-PORT-01 (the Node.js requirement), `README.md` install, `AGENTS.md`,
  `docs/testing.md`, and `docs/native-engine.md`.
