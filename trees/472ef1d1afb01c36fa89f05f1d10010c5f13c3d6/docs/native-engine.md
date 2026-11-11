# Native resolution reads

`--engine native` (or `CAUSET_ENGINE=native`) selects the gitoxide backend of
the Rust Git engine, `native/engine/src/native.rs`, for the read operations of
the engine seam (`native/engine/src/engine.rs`, ADR-0019). The backend
implements the five resolution-catalog operations of
[ADR-0027](adr/0027-bound-native-read-engine-entry-by-the-resolution-catalog-budget.md)
(`OPERATIONS` in `native.rs`): `inspectGitObjects`, `listNoteEntries`,
`listRefs`, `readGitObjects`, and `repoContext`. It answers them in process
through `causet-core` (`native/core`), the bounded, read-only object
acquisition crate built on gitoxide, without launching Git. The command
modules still validate and select resolution records. Git remains the default
engine and handles all mutations and every other operation.

## Build

The backend is compiled into `cst`: `native/engine` links `causet-core`
directly, so there is no separate library, prebuild, or loader, and no build
step beyond the executable itself. The reviewed toolchain is Rust 1.98.1
(`native/rust-toolchain.toml`) and gix 0.87.1 with default features off and
only `sha1` and `revision` enabled; `native/Cargo.lock` pins the transitive
graph. Build on Windows x64 with MSVC Build Tools or Ubuntu x64 with the GNU
toolchain:

```sh
rustup toolchain install 1.98.1 --profile minimal
npm run build:native
native/target/release/cst --engine native doctor
```

`cst doctor` reports the backend under `engine.native`: whether it is
available, its profile (`files-sha1-resolution-v1`), and the operations it
answers. The build command publishes nothing; the released `cst` executable
and its per-platform packages are assembled by `scripts/pack-release.mjs`
(ADR-0038, "Release packaging" in `docs/testing.md`).

## Profile and failure boundary

The `files-sha1-resolution-v1` profile handles files-backend SHA-1 repositories
with a work tree, including linked worktrees and loose or packed storage. It
accepts full object IDs, direct full refs, commit/tree peeling, and the
retained `:result` path. Other revision expressions use Git. Bare
repositories, SHA-256, reftable, partial clones, replacement refs, grafts, and
command-scope Git configuration (and the other `GIT_*` variables that
relocate or reconfigure a repository) also use Git. Repository identity
through aliased paths or Windows UNC paths uses Git.

Each operation opens current repository state. No resident process or
persistent cache is introduced. Object content batches have a 64 MiB native
acquisition budget and at most 65,536 expressions; note traversal has a
16 MiB/1,024-tree budget. Invalid inputs, duplicates, unordered trees,
unsupported cases, and exhausted budgets fall back for the entire operation.
They never return a partial catalog. Git remains authoritative for the
fallback result or error. `nativeReads` metrics count successful operations;
`fallbacks` report operations delegated to Git, with one of these reasons:

| Reason | When |
| --- | --- |
| `unsupported` | The operation is not one of the five the backend implements. |
| `unsupported-input` | The backend refused the input by design: its message starts with `unsupported ` (object name, ref pattern, peel, notes ref, repository profile or extension, UNC or aliased path, relative Git directory, environment). |
| `native-error` | Anything else: an exhausted budget, a malformed or duplicate tree, a dangling or symbolic reference, or another failure. |
| `binding-missing` | The backend is unavailable. Because it is compiled in, only the `CAUSET_TEST_NATIVE_BINDING=missing` test hook produces this; the name is kept because it is published output. |

An in-memory gix allocation limit (`gitoxide.objects.allocLimit`, 64 MiB) also
bounds packed delta bases and intermediate buffers, so a small final object
cannot bypass the content limit with a large base.

Every crate in the workspace forbids unsafe Rust.

## Equality and latency

Equality with the Git engine is checked three ways:

- `cst doctor --differential` runs every cataloged operation through each
  engine against the current repository and compares result digests, process
  counts, and fallbacks operation by operation
  (`causet.engine-differential/v1`, `native/engine/src/differential.rs`).
  Each probe uses only input shapes the backend implements, so every operation
  it implements is compared natively.
- `test/rust-engine.test.js` drives the engine through the `engine-probe`
  executable and holds every cataloged operation, under both engines, to the
  frozen answers of the retired JavaScript engine
  (`test/fixtures/oracle/engine.json`, `test-support/oracle-vectors.js`). It
  also asserts actual execution: on a supported repository each of the five
  operations is answered natively with no Git process. On this repository's
  own clone, which cannot be frozen, it requires the differential to report
  every operation equal.
- The suite's `CAUSET_ENGINE=native` mode, one of the six modes in
  [testing.md](testing.md), runs the whole suite with the backend selected and
  refuses any read outside the seam.

Fallback-only results do not qualify native performance.

The dependency-free mutation target `fuzz-parsers`
(`native/core/src/bin/fuzz-parsers.rs`) exercises the backend's tree, commit,
tag, and object-ID parsers; failures reproduce with the same seed. CI runs it
with the other two targets:

```sh
cargo +1.98.1 run --manifest-path native/Cargo.toml --locked --release --bin fuzz-parsers -- 200000 83
cargo +1.98.1 run --manifest-path native/Cargo.toml --locked --release --bin fuzz-model -- 200000 83
cargo +1.98.1 run --manifest-path native/Cargo.toml --locked --release --bin fuzz-engine -- 200000 83
```

The second target covers the record model (`native/model`, #142): its JSON
parser and every function that reads a parsed note, envelope or journal. The
third covers the Git engine (`native/engine`, #143). It exercises every parser
of Git output: batch and batch-check records, log and status output, index and
worktree listings, raw notes trees, and the session and merge-tree record
readers.

This bounded mutation run is not a coverage-guided fuzzing claim. Dependency
advisory checks accompany the qualification evidence on
[#83](https://github.com/jwh3times/causet/issues/83).

[ADR-0027](adr/0027-bound-native-read-engine-entry-by-the-resolution-catalog-budget.md)
requires every native median to be at most 110% of its contemporaneous Git
floor. A miss ends the bounded attempt and keeps Git as the delivered engine;
further tuning requires a new decision. The perf checkpoint
(`scripts/perf-checkpoint.mjs`, run by `.github/workflows/perf.yml`) measures
every read scenario under both the `git` and `native` engines and reports
their medians, Git process counts, and output equality across engines; on a
shared runner the timings are informational and never fail it, and the
absolute reference stays the local procedure on the wiki's Performance testing
page.

The native read engine entered the tree in the `0.13.2` development snapshot
and first shipped in the `0.14.0` release, then as an N-API binding the
JavaScript CLI loaded; since #243 it is the backend above, linked into the
Rust executable. ADR-0014's two-minor-release sunset, counted from that
snapshot, fell due at `0.15.0` and **did not trigger**: the budget and
identical-result requirements were met and recorded on
[#83](https://github.com/jwh3times/causet/issues/83) on 2026-09-14 — all three
Windows latency checks passed with identical catalogs, no fallback in the
native phase, and zero Git processes. ADR-0027's 110% bound continues to apply
to every later change.
