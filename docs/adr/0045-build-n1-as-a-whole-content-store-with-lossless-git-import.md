# ADR-0045: Build N1 as a whole-content store with lossless Git import

- **Status:** Accepted (owner, 2026-10-17); command names in [ADR-0046](0046-give-a-native-repository-gits-everyday-verbs-and-cst-s-own-commands.md)
- **Date:** 2026-10-17
- **Owners:** Repository maintainers
- **Related requirements:** GP-12, NFR-PERF-06, NFR-PERF-07, NFR-PORT-01
- **Builds on:** [ADR-0041](0041-make-cst-a-standalone-distributed-version-control-system.md)
  (decisions 7 and 9, and its open question on the native hash),
  [ADR-0042](0042-grow-the-native-system-as-a-shadow-with-one-kind-per-repository.md),
  [ADR-0043](0043-order-the-native-transition-by-dependency-starting-with-n1.md),
  [ADR-0044](0044-define-the-exit-regime-every-native-phase-must-meet.md)
- **Decided on:** [#290](https://github.com/jwh3times/causet/issues/290), under the
  [transition map](https://github.com/jwh3times/causet/issues/281)
- **Evidence:** the research for
  [#285](https://github.com/jwh3times/causet/issues/285),
  [#286](https://github.com/jwh3times/causet/issues/286) and
  [#287](https://github.com/jwh3times/causet/issues/287), on the branches
  `research/prior-art`, `research/git-bridge-cost` and
  `research/content-store-inputs`

## Context

N1 is the first native phase (ADR-0043): the native content store and a lossless
import of a Git-backed repository. Several earlier decisions shape it:

- **ADR-0041:** large files are first-class (decision 7); every Git object must
  round-trip exactly through the bridge (decision 9); and the native hash was
  left to this ADR.
- **ADR-0042:** a native repository is wholly native, and its formats may not
  borrow a Git shape.
- **ADR-0043:** N1 leaves room for section identity.
- **ADR-0044:** N1 builds the reconstruction check, the import checks and the
  native-kind suite mode. On real repositories its stored bytes must be no more
  than Git's fully packed size, and strictly smaller on a large-file corpus.

The content-store research measured causet's own history and two pairs of large
binaries:

- **Compressing each chunk alone loses.** Unique chunks compressed one by one
  lose to Git's delta packs by about 3×: 10.5 MB at best, against 3.7 MB.
- **Grouping wins.** Unique 8 KiB chunks grouped in version order and compressed
  with zstd in 1 MiB frames take 2.81 MB, against 2.84 MB for Git's aggressive
  pack, before about 0.44 MB of chunk references.
- **Deltas win on large binaries.** On the `node` executables, a zstd delta
  against the previous version kept 9.6% of the new version, where chunk
  deduplication kept about 16%.
- **The hash trade-off.** SHA-256 with SHA-NI is faster on objects of about
  1 KiB. BLAKE3 is about 2.3× faster from 16 KiB up.

## Decision

### What N1 imports

1. **Import reads Git through the `git` executable** (`cat-file --batch`,
   `for-each-ref`), so it reads every format Git does, including SHA-256 and
   reftable. cst's own readers of Git's pack, loose-object and ref formats come
   with N6. Import reads with replacement disabled (`--no-replace-objects`), so
   every object is imported as stored. It refuses, naming the reason:
   - shallow clones;
   - partial clones;
   - repositories with grafts.
2. **Everything reachable from every ref is imported.**
   - **Blobs and trees** become native content.
   - **Commits and tags** are kept as preserved Git-encoded objects. N2
     reinterprets them as native history.
   - **Every ref** is recorded verbatim, as a name → ID snapshot. That includes
     remote-tracking refs, `refs/replace/*`, and cst's notes and causet refs.
   - **cst's records** therefore come along as raw objects, which N2
     interprets.
3. **Import is deterministic at two levels.** This makes ADR-0044's import
   checks precise:
   - **A fresh import of the same history yields a byte-identical store:**
     containers, indexes and the alias map. Packing order is deterministic.
   - **An incremental import yields the same native objects** (IDs and
     content), the same alias map and the same ref snapshot as a full import of
     the final history. Container layout may differ. An import removes
     nothing the store held: what only a deleted or moved ref reached stays,
     with its alias rows. The store then holds the full import's objects and
     rows, and its own earlier ones.

### Identity

4. **A content ID is a SHA-256 hash of the whole content,** in cst's own
   encoding, carrying an algorithm tag so the hash can change later without
   ambiguity.
   - Chunks are a storage detail, each with its own SHA-256 hash for
     verification.
   - Chunking never changes an ID, so its parameters can be retuned without a
     migration.
   - This answers ADR-0041's open question. SHA-256 is standardized and on every
     platform, and it is faster on the small objects that are most objects.
     BLAKE3's advantage applies only to large files, whose cost is dominated by
     I/O and compression.
5. **A two-way alias map** maps (Git hash algorithm, Git ID) to native ID, for
   both SHA-1 and SHA-256. It covers blobs, trees and the preserved commits and
   tags. It is a sorted index beside the containers.

### Storage

6. **Chunking uses FastCDC, implemented by cst against a published spec** with
   reference vectors: the gear table, masks, normalization level 2, and the
   cut-point rules.
   - **Sizes:** an 8 KiB average, a 2 KiB minimum and a 64 KiB maximum. A file
     smaller than the minimum is one chunk.
   - **Seed:** none, though the format reserves a seed field for N5's
     acceptance points.
   - **The `fastcdc` crate** is a test oracle only, because its implementations
     cut differently between versions.
7. **Unique chunks are stored together and compressed as groups.**
   - **Frames:** chunks are stored in version order and compressed in seekable
     zstd frames of 1–4 MiB.
   - **Containers:** frames go into containers, each with a trailing index.
   - **Deltas:** files over a threshold of about 1 MiB may also store each new
     version as a zstd `--patch-from` delta against the previous version,
     whenever that is smaller. Delta chains have a depth limit.
   - **The codec:** zstd comes through the `zstd` crate's C bindings, pinned
     exactly with its reason. The storage gate is not reachable without zstd's
     grouped frames and deltas. A C compiler at build time is a build cost, not
     a dependency on another version-control implementation.
8. **Every clone holds all metadata, and content may be absent.**
   - **Metadata** means snapshots, trees, preserved commits and records.
   - **Three object states** are distinguished from corruption: present, absent
     by promise, and absent by policy. The last is reserved for N5's read
     permissions.
   - **Fetches are batched** by container and byte range, never one object at a
     time. N1 builds no transport. The format only makes this possible.
9. **A typed annotation object is reserved.** It attaches derived data, such as
   a section map, to a content ID without changing that ID. N4 defines the
   section-map type. Code that doesn't know an annotation's type ignores it.

### Contract, commands and code

10. **The byte-level format is a published contract,** `docs/native-store/`, with
    reference vectors. It is written as N1's first build ticket and before any
    store code (the restated Gate B), and it fixes:
    - container size and index fan-out;
    - the frame bounds;
    - the delta threshold and depth limit;
    - the encoding of every object type.
11. **N1's commands are experimental, behind the opt-in of ADR-0042, and not
    contracts.**
    - **The commands:** `cst import <git-repo> <dest>`, and inspection commands
      that read a file at a snapshot, list a tree and verify the store.
    - **Read-only:** in N1 a native repository is written only by import.
    - **Their equality oracle** is Git's own answer on the original:
      `cat-file` and `ls-tree`.
    - **Their names** are set by [ADR-0046](0046-give-a-native-repository-gits-everyday-verbs-and-cst-s-own-commands.md): `cst cat-file`, `cst ls-tree`,
      `cst rev-parse`, `cst for-each-ref`, `cst fsck` and `cst import --verify`.
    - **What they take:** each takes the part of its Git command that its
      native help lists, and refuses the rest by name with
      `unsupported-feature`. `cst fsck` has cst's own report and, while it is
      experimental, no `--json` form.
12. **Layout and crates.**
    - **The marker:** a native repository is a directory with `.cst/` at its
      root, holding the store. That is the root marker ADR-0042's kind
      detection reads.
    - **`native/store`:** the format, the chunker, containers, the alias map and
      reconstruction. It depends on neither `core`, `engine` nor gitoxide.
    - **`native/import`:** it drives `git` through the engine's process module.

### Exit

13. **The corpora** of ADR-0044 for N1:
    - **Generated histories:**
      - merges, including octopus merges;
      - renames, mode changes, symlinks and submodule links;
      - empty trees and empty files;
      - signed commits and tags, non-UTF-8 encodings and extra headers;
      - malformed objects that Git accepts;
      - versioned large binaries.
    - **Real repositories:** causet's own and git/git.
    - **The large-file corpus:** a repository built in CI from successive
      Node.js release executables, pinned by checksum, plus generated
      asset-edit histories.
14. **N1 builds the exit machinery** that every later phase runs:
    - the reconstruction check;
    - both import checks (decision 3);
    - the native-kind suite mode.

## Constraints

- **Bridgeable from the start.** The reconstruction check proves that every
  imported object rebuilds, in Git's encoding, to its original ID.
- **A native format borrows no Git shape.** Preserved commits and tags are kept
  in Git's encoding only because the bridge needs their exact bytes. Native
  history (N2) has its own objects.
- **Dependencies:** `sha2`, `zstd` and `crc32fast` as needed, each pinned
  exactly. No crate that implements a version-control format or protocol.
- **No format promise** until a later ADR makes one (ADR-0042): a native
  repository from an earlier build may have to be re-imported.

## Consequences

### Positive

- The storage gate looks reachable on real history (2.81 MB against 2.84 MB on
  causet's) and on large files (deltas). The contract's reference vectors make
  every number reproducible.
- Retuning chunk sizes, frames or containers never changes an ID.
- The alias map and the reconstruction check exercise the bridge's encoding
  half from the first phase.
- Lazy fetch and read permissions have their object states before any transport
  exists.

### Negative

- **zstd adds a C compiler** to every release target's build, Windows MSVC
  included.
- **Large files are hashed twice,** whole and by chunk.
- **Grouped frames make a single read costlier:** a read decompresses its frame
  from the start. The frame bounds cap that cost.
- **Preserved commits are kept twice** (as Git bytes, and later as N2's native
  history) for as long as a repository bridges. ADR-0041 already accepted this
  cost of exact round trips.
- **Import depends on the `git` executable** until N6.

## Alternatives considered

- **Import only blobs and trees.** Rejected: the reconstruction check would not
  cover commits or records until N2.
- **A Merkle root over chunks as the ID** (Xet). Rejected: every ID would depend
  on the chunker.
- **BLAKE3, or SHA-256 for IDs with BLAKE3 for chunks.** Rejected: one standard
  hash is simpler to specify and verify, and BLAKE3's speed matters only on
  large files.
- **Defining a native blob ID as Git's SHA-256 blob ID.** Rejected: it borrows
  Git's encoding.
- **Compressing each chunk alone, or grouped frames with no deltas.** Rejected:
  the first loses to Git's packs by about 3×, and without deltas the large-file
  gate is unlikely to pass.
- **LZ4, or pure-Rust zstd.** Rejected: LZ4's ratio is far lower, and `ruzstd`
  encodes only at about level 1.
- **cst's own Git readers in N1.** Rejected: they belong to N6, and Git is
  present wherever import runs.
- **Lazy metadata** (Sapling's segmented changelog). Rejected: it needs a
  server-assisted history protocol.
- **Byte-identical stores for incremental import.** Rejected: it would force a
  full repack on every import.
- **The `fastcdc` crate as the definition of cut points.** Rejected: its
  implementations cut differently between versions.
