# Optional native resolution reads

The optional Rust/gitoxide binding implements `repoContext`, `listRefs`,
`inspectGitObjects`, `readGitObjects`, and `listNoteEntries`. JavaScript still
validates and selects resolution records. Git remains the default engine and
handles all mutations and every unsupported operation.

## Build and package

The reviewed toolchain is Rust 1.98.1, gix 0.87.1, napi 3.12.4,
napi-derive 3.6.5, and napi-build 2.4.2. `native/Cargo.lock` pins the transitive
graph. The binding uses Node-API 8, synchronous calls, and no networking features.
Build on Windows x64 with MSVC Build Tools or Ubuntu x64 with the GNU toolchain:

```sh
rustup toolchain install 1.98.1 --profile minimal
npm run build:native
node bin/vlab.js doctor --engine native
```

`CARGO` can name a Cargo executable outside PATH. The build copies the platform
library and dependency license texts into `native/prebuilds/<platform>-<arch>/`.
These generated artifacts are ignored by Git; `npm pack` includes an existing
prebuild and its notices. A package built without one still works through Git.
Installation never downloads a binding or runs a compiler automatically. There
is no npm publication or cross-platform prebuild download in this build command.

## Profile and failure boundary

The `files-sha1-resolution-v1` profile handles files-backend SHA-1 repositories,
including linked worktrees and loose or packed storage. It accepts full object
IDs, direct full refs, commit/tree peeling, and the retained `:result` path.
Other revision expressions use Git. Bare repositories, SHA-256, reftable,
replacement refs, grafts, and command-scope Git configuration also use Git.
Repository identity through aliased paths or Windows UNC paths uses Git.

Each operation opens current repository state. No resident worker or persistent
cache is introduced. Object content batches have a 64 MiB native acquisition
budget; note traversal has a 16 MiB/1,024-tree budget. Invalid inputs, duplicates,
unordered trees,
unsupported cases, and exhausted budgets fall back for the entire operation.
They never return a partial catalog. Git remains authoritative for the fallback
result or error. `nativeReads` metrics count successful operations; `fallbacks`
report operations delegated to Git.
An in-memory gix allocation limit also bounds packed delta bases and intermediate
buffers, so a small final object cannot bypass the content limit with a large base.

The core forbids unsafe Rust. Binding entry points catch unwinding panics and
convert errors before the engine seam falls back. This does not turn an abort or
out-of-memory condition into a recoverable JavaScript error.

## Qualification

The functional matrix builds a real binding and runs all six modes on Windows
and Ubuntu plus the Node 20 floor. `test/native-engine.test.js` checks Git oracle
equality and actual execution. The dependency-free mutation target exercises
tree, commit, tag, and object-ID parsers; failures reproduce with the same seed:

```sh
cargo +1.98.1 run --manifest-path native/Cargo.toml --locked --release --bin fuzz-parsers -- 200000 83
```

This bounded mutation run is not a coverage-guided fuzzing claim. Dependency
advisory checks and FFI review accompany qualification evidence on
[#83](https://github.com/jwh3times/vcs-lab/issues/83).

On a quiet matching `lab-windows-a` host, use an isolated Git configuration
without command-scope configuration overrides, leave the ordinary mode settings
at their recorded defaults, and run:

```sh
node scripts/qualify-native.mjs --host lab-windows-a /outside/repository/native-qualification.json
```

Each of three independent fixtures uses `reduced-local-v3`, nine fresh-process
samples per side, and alternating side order across checks. The native phase
includes binding initialization, discovery, conversion, and domain validation.
The existing raw Git acquisition floor is unchanged. Whole CLI times and oracle
equality are separate checks. The harness retains raw timings, medians, p95,
execution/fallback metrics, and host provenance outside the tracked tree.

[ADR-0027](adr/0027-bound-native-read-engine-entry-by-the-resolution-catalog-budget.md)
requires every native median to be at most 110% of its contemporaneous Git floor.
A miss ends the bounded attempt and keeps Git as the delivered engine; further
tuning requires a new decision. The committed regression baseline is unchanged.

The binding entered the tree in the `0.13.2` development snapshot and first
shipped in the `0.14.0` release; this records source delivery, not npm
publication. ADR-0014's two-minor-release sunset, counted from that snapshot,
fell due at `0.15.0` and **did not trigger**: the budget and identical-result
requirements were met and recorded on
[#83](https://github.com/jwh3times/vcs-lab/issues/83) on 2026-09-14 — all three
Windows latency checks passed with identical catalogs, no fallback in the native
phase, and zero Git processes. ADR-0027 required them before the initial
delivery as well, and its 110% bound continues to apply to every later change;
a miss still ends the bounded attempt and keeps Git as the delivered engine.
