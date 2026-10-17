# Design inputs for the native content store (N1)

Research for [#287](https://github.com/jwh3times/causet/issues/287), under the
map [#281](https://github.com/jwh3times/causet/issues/281). It gathers the facts
N1's ADR needs, as ADR-0041 decisions 7 and 9 and its open question on the
native hash frame them:

- **Decision 7.** Large files are first-class: chunking by content, lazy fetch,
  no pointer files and no separate server.
- **Decision 9.** A permanent two-way Git bridge with exact round trips, so each
  imported Git object ID is kept as an alias.
- **Open question.** The native hash.

This note makes no recommendation. The last section, "Bearing on N1", lists the
decisions the ADR has to make and the facts that bear on each.

**How claims are sourced.** Every claim cites a primary source: a paper, the
owning project's documentation or source code, or the owning project's own
published benchmark.

- **Unverified** marks a claim this research could not trace to a primary
  source.
- **Local measurement** marks numbers this research measured itself on one
  machine, 2026-10-17. Each is a single run on one host (the best of five for
  throughput), so the numbers are informational. Under the owner's rule, local
  measurements are never gate evidence.

Measurement host for every local measurement:

- AMD Ryzen 7 5800X3D (Zen 3, 8 cores and 16 threads), with SHA-NI and AVX2 but
  no AVX-512.
- Fedora, Linux 7.2, Rust 1.98.1 (`--release`, thin LTO), Git 2.56.0,
  zstd 1.5.7.

The harness was a throwaway Cargo crate outside the tree and is not committed.
Its method is given with each table.

## 1. Content-defined chunking

### 1.1 Algorithms

| Algorithm | Rolling function and cut test | Source |
| --- | --- | --- |
| **Rabin** (LBFS-style) | A Rabin fingerprint over a sliding window, computed byte by byte. Cut when the low bits match. Effective, but the hashing is the bottleneck. | FastCDC 2016 §2 and §5.2 |
| **Buzhash** | A cyclic-polynomial rolling hash over a window. Used by borg (window 4095 B), casync (window 48 B) and Kopia (window 64 B). | borg data-structures doc; casync `src/cachunker.h`; Kopia `repo/splitter/splitter.go` |
| **rsync rollsum** | The librsync checksum over the last 64 bytes. Cut when the low 13 bits are all 1s. | bup `DESIGN.md` |
| **Gear** | `fp = (fp << 1) + G[b]`, with a table of 256 random 64-bit values. Its effective window is only as wide as the mask bits, so FastCDC widens the mask with zero padding. | FastCDC 2016 §3–4; 2020 §3 |
| **FastCDC** | Gear plus four techniques: a simplified and widened hash judgment, skipping cut points below the minimum, *normalized chunking* (a harder mask before the target size and an easier one after), and, in 2020, rolling two bytes per step. | FastCDC 2016; 2020 |
| **AE** (asymmetric extremum) | A local-extremum test with no rolling hash. Its deduplication is close to Rabin's. | FastCDC 2016 §5.2 (cited there as [38]) |

Measured results from the FastCDC papers (Xia et al.):

- **2016** ([USENIX ATC '16](https://www.usenix.org/conference/atc16/technical-sessions/presentation/xia)).
  Seven datasets of about 5 TB in total (TAR, LNX, WEB, VMA, VMB, RDB, SYN), with
  deduplication ratios from 40% to 97%. Hardware: Intel i7-930 and i7-4770.
  - **Speed.** FastCDC chunks "about 10× faster than the Rabin-based CDC, and 3×
    faster than the state-of-the-art Gear- and AE-based CDC". Gear and AE are
    "about 3× faster than Rabin". With the hash judgment optimized alone,
    FastCDC is "about 5× faster than Rabin and 1.5× faster than Gear" (§5.2).
  - **Instruction counts.** To chunk 1 MB on the i7-4770 (Table 6):
    - Rabin with a 2 KB minimum: 38.8 M instructions and 16.5 M cycles.
    - FastCDC with normalized chunking and an 8 KB minimum: 7.75 M instructions
      and 1.61 M cycles.
  - **Deduplication.** FastCDC is within "about ±0.1∼1.4%" of Rabin across 4,
    8 and 16 KB targets (Table 3). Plain Gear loses up to 7.7% on TAR, because
    its window is short.
  - **Normalized chunking.** Level 2, with mask bits (15, 11) around the target,
    is the "sweet spot". It reaches the highest deduplication with a 4 KB
    minimum and the highest speed with an 8 KB minimum (§5.4, Tables 4–5).
  - **Fixed-size chunking.** At 10 KB it falls to 12.21% on TAR (Rabin: 47.58%),
    18.26% on VMA (Rabin: 38.23%) and 9.80% on RDB (Rabin: 95.53%) (Table 4).
- **2020** ([IEEE TPDS 31(9)](https://ranger.uta.edu/~jiang/publication/Journals/2020/2020-IEEE-TPDS(Wen%20Xia).pdf)).
  Seven datasets of about 6 TB, on an Intel Xeon Gold 6130.
  - **Speed.** "FastCDC is 3-12X faster than the state-of-the-art CDC
    approaches."
  - **Rolling two bytes per step.** It produces "exactly the same chunking
    results" and is "about 30-40 percent faster" (§3.7). The evaluation reports
    40–50% (§4.2).
  - **Configuration.** The final configuration (normalized chunking, an 8 KB
    minimum, rolling two bytes) is "about 12× faster than the Rabin-based
    approach".
  - **Deduplication.** It stays within about 1 point of Rabin (Table 4). For
    example, on RDB: Rabin 92.57%, FastCDC v2 92.97%, v3 92.23%.
  - **System throughput.** In the Destor deduplication system, with SHA-1 from
    ISA-L at "about 3-4 GB/s", FastCDC gives "1.2-3.0X higher overall system
    throughput" (§4.6).

### 1.2 Parameters in production systems

| System | Chunker | Min / target / max | Notes | Source |
| --- | --- | --- | --- | --- |
| **restic** | Rabin, 64-byte window | 512 KiB / 1 MiB / 8 MiB | The polynomial is chosen at random at `init` and stored in `config`. Files under 512 KiB are not split. | [restic references](https://restic.readthedocs.io/en/latest/100_references.html) |
| **borg** | buzhash (or fixed) | 2^19 (512 KiB) / 2^21 (2 MiB) / 2^23 (8 MiB) | Window 4095 B. The table is XORed with a per-repository secret seed "to prevent chunk-size-based fingerprinting". | [borg data structures](https://borgbackup.readthedocs.io/en/stable/internals/data-structures.html) |
| **casync** | buzhash, 48-byte window | avg/4 / 64 KiB / avg×4 (16 / 64 / 256 KiB) | Its discriminator is derived from the average by a fitted formula. | casync [`src/cachunker.h`](https://github.com/systemd/casync/blob/main/src/cachunker.h) |
| **Kopia** | buzhash32 (default) or Rabin-Karp, 64-byte window; or fixed | avg/2 / avg / avg×2 | The default is `DYNAMIC-4M-BUZHASH` (2 / 4 / 8 MiB). | Kopia [`repo/splitter`](https://github.com/kopia/kopia/tree/master/repo/splitter) |
| **bup** | rsync rollsum, 64-byte window | – / 8 KiB / 32 KiB | Chunks are grouped into Git trees by extra checksum bits (fan-out), so an edit changes O(log n) objects. | bup [`DESIGN.md`](https://github.com/bup/bup/blob/main/DESIGN.md) |
| **Xet** (Hugging Face) | Gear, with no normalization | 8 KiB / 64 KiB / 128 KiB | The mask is `0xFFFF000000000000` (16 bits). The gear table is pinned to `rust-gearhash`. The spec allows skipping cut points. | [Xet chunking spec](https://huggingface.co/docs/xet/chunking) |
| **Mononoke** (Sapling server) | **Fixed-size** chunks | configured `chunk_size` | A file's `ContentId` is independent of its chunking: `rechunk` can re-chunk a stored file without changing its ID. | Sapling `eden/mononoke/repo_attributes/filestore/src/{lib,chunk,rechunk}.rs` |

The backup tools target chunks of 1–4 MiB, a choice that favours fewer chunks
and index entries over fine-grained deduplication. Xet targets 64 KiB for model
and data files, and FastCDC's evaluation used targets of 4–16 KB. None of the
backup tools publishes a deduplication measurement for its own parameters
(**unverified**: no such page found for restic, borg, casync or Kopia).

**Xet's published deduplication results** ([Hugging Face blog](https://huggingface.co/blog/from-files-to-chunks)):

- **CORD-19, 50 incremental updates.** Storage fell from 8.9 GB with Git LFS to
  3.52 GB with Xet. The average upload took 24 minutes instead of 47, and the
  average download 19 minutes instead of 51.
- **gpt2 `model.safetensors`, two versions.** The total was 1.2 GB with LFS and
  645 MB with Xet. The post says "53%", but the totals it lists imply about 47%.
- **Fine-tuned models and checkpoints on the Hub.** It estimates deduplication
  "in the range of 30-85%".

### 1.3 Design details that matter for a VCS store

- **Stable cut points belong to the format.** The `fastcdc` crate's README says
  the `v2016` and `v2020` implementations "*will* produce different results"
  from `ronomon`, and the crate's major versions have changed which algorithm a
  name selects. A store keyed by chunks must therefore specify:
  - the gear table;
  - the masks;
  - the normalization level;
  - the minimum, target and maximum sizes;
  - the cut-point-skipping rule.

  Xet does so in its spec and publishes reference chunk boundaries for a sample
  file ([Xet chunking](https://huggingface.co/docs/xet/chunking), "Sample
  Reference"). A crate is then an implementation to test against that spec, not
  the definition.
- **Keyed or seeded chunkers** resist the fingerprinting of content through
  chunk sizes:
  - borg XORs its buzhash table with a secret seed;
  - restic chooses a random polynomial per repository;
  - the `fastcdc` crate offers `with_level_and_seed`.

  A per-repository seed defeats deduplication *between* repositories, and with
  it cross-fork sharing at an acceptance point. Xet deliberately uses one global
  table and protects its global deduplication query with HMAC instead
  ([Xet deduplication](https://huggingface.co/docs/xet/deduplication)).
- **Fragmentation is a cost.** Xet's spec recommends keeping "long, continuous
  runs of chunks together", for example a minimum run of 8 chunks or an average
  contiguous run of 1 MB or more. Even so, it sometimes skips deduplicating a few
  chunks so that a file's data stays in one xorb.
- **Whose ID depends on the chunking.**
  - In Xet, a file's hash is a Merkle root over its chunk hashes and sizes
    ([Xet hashing](https://huggingface.co/docs/xet/hashing)), so changing the
    chunker changes every file ID.
  - In Mononoke, a file's ID is the hash of the whole content, and chunks are a
    storage detail that can be re-chunked.

### 1.4 Local measurement: chunking throughput

Method: 256 MiB of pseudo-random data, single thread, best of five runs.

| Chunker | Min / target / max | GiB/s | Mean chunk |
| --- | --- | --- | --- |
| `fastcdc` 5.0.0 `v2020`, normalization level 1 | 2 / 8 / 32 KiB | 3.23 | 9,966 B |
| `fastcdc` 5.0.0 `v2020` | 4 / 16 / 64 KiB | 3.18 | 20,057 B |
| `fastcdc` 5.0.0 `v2020` | 16 / 64 / 256 KiB | 3.17 | 79,962 B |
| Xet spec Gear, written from the spec (scalar, with cut-point skipping) | 8 / 64 / 128 KiB | 1.12 | 63,974 B |
| `gearhash` 0.1.4 `next_match`, SIMD (boundary search only, no min or max) | – / 64 / – KiB | 3.08 | 60,911 B |

Chunking at about 3 GiB/s is in the same range as hashing (§2.4). A pipelined
store is bound by whichever of the two is slower.

## 2. Hash candidates

### 2.1 Security

- **SHA-256.**
  - It is standardized in FIPS 180-4.
  - NIST lists only FIPS 180-4 (SHA-1 and SHA-2) and FIPS 202 (SHA-3) as
    approved hash algorithms. NIST deprecated SHA-1 in 2011 and disallowed it
    for signatures after 2013 ([NIST CSRC](https://csrc.nist.gov/projects/hash-functions)).
  - Like any 256-bit hash, it gives 128-bit collision resistance by the generic
    birthday bound.
  - It is subject to length extension.
- **BLAKE3.**
  - It "targets 128-bit security for all of its security goals", meaning
    (second-)preimage, collision and differentiability.
  - Its compression function uses 7 rounds rather than BLAKE2s's 10, which the
    designers justify from existing cryptanalysis ([BLAKE3 spec](https://github.com/BLAKE3-team/BLAKE3-specs/blob/master/blake3.pdf), §4).
  - It resists length extension, and it provides keyed hashing, a KDF and an
    XOF as modes of one function ([README](https://github.com/BLAKE3-team/BLAKE3)).
  - It is **not** a NIST-approved algorithm, since it is absent from the NIST
    list above. That matters only if a user needs FIPS-validated cryptography.
- **What Git requires** is "collision and 2nd preimage resistance", and it "does
  not require length extension resistance". Git's selection criteria were:
  - 256 bits;
  - "wide availability of high quality implementations (e.g., OpenSSL and Apple
    CommonCrypto)";
  - speed only as a tiebreaker.

  Git picked SHA-256 in 2018 over SHA-512/256, SHA-256x16, K12 and BLAKE2bp-256
  ([hash-function-transition](https://git-scm.com/docs/hash-function-transition)).

### 2.2 Speed: published by the owners

- **The BLAKE3 spec** (§3) measures on an AWS c5.metal (Intel Cascade Lake-SP,
  with AVX-512 but **no SHA-NI**).
  - Peak single-thread throughput is "4× that of BLAKE2b, 8× that of SHA-512,
    and 12× that of SHA-256".
  - On a 32-bit ARM1176 (Raspberry Pi Zero) it is "1.3× that of SHA-256".
  - Multithreaded throughput "scales almost linearly with the number of threads,
    up to 16 threads" for inputs above 128 KiB.
  - SIMD parallelism starts only at 2 KiB of input (more than one 1 KiB chunk).
    "For a single chunk of input, up to 1 KiB, BLAKE3 closely mirrors BLAKE2s."
- **No primary source compares the two with SHA-NI or the ARMv8 SHA-2
  extensions.** That is the case on every current x86 and Apple Silicon client
  (§2.3). The local measurement below fills the gap for one x86 host.

### 2.3 Hardware acceleration and platform support

- **SHA-256 in hardware.** borg's documentation dates the extensions as follows
  ([borg init](https://borgbackup.readthedocs.io/en/stable/usage/init.html)):
  - ARM: "since ARMv7 with NEON (around 2011), or ARMv8 (around 2013)";
  - AMD: "since Zen 1 (around 2017), i.e. all AMD Ryzen CPUs";
  - Intel: Ice Lake on mobile and Rocket Lake on desktop (around 2021).
- **The `sha2` crate** (RustCrypto) detects SHA-NI (`x86-sha`) and the AArch64
  `sha2` extension at run time and falls back to a portable backend. It is pure
  Rust with intrinsics ([sha2 README](https://github.com/RustCrypto/hashes/tree/master/sha2), "Backends").
- **The `blake3` crate** has these implementations:
  - Rust intrinsics for SSE2, SSE4.1 and AVX2;
  - hand-written assembly by default on x86_64 (SSE4.1, AVX2, AVX-512);
  - C intrinsics for NEON, enabled by default on little-endian AArch64;
  - C for AVX-512 on 32-bit x86.

  If no C compiler is found, `build.rs` "automatically falls back to a pure Rust
  build". Run-time feature detection covers x86 only, and NEON is assumed on
  AArch64 ([`Cargo.toml` features](https://github.com/BLAKE3-team/BLAKE3/blob/master/Cargo.toml), `build.rs`).
- **Tooling outside cst.**
  - SHA-256 is built into every target OS. On Windows, PowerShell's
    `Get-FileHash` defaults to SHA256 and accepts SHA1, SHA256, SHA384, SHA512
    and MD5, with no BLAKE3 ([Microsoft Learn](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.utility/get-filehash)).
  - Linux has `sha256sum` (coreutils) and macOS `shasum -a 256`. These are
    **unverified** against vendor documentation, but both are ubiquitous.
  - BLAKE3 needs `b3sum` or a library.
- **Use in comparable systems.**
  - **Xet** uses keyed BLAKE3 for chunk, xorb and file hashes.
  - **Kopia** offers BLAKE3-256, but its default is `BLAKE2B-256-128`
    (`repo/hashing/hashing.go`).
  - **Mononoke** keys content by Blake2b and keeps a `SeededBlake3` alias.
  - **Jujutsu's** proof-of-concept `SimpleBackend` uses BLAKE2b-512.
  - **Fossil** uses SHA1 or SHA3-256.
  - **restic** and **casync** use SHA-256 (casync's default is SHA-512/256).

### 2.4 Local measurement: hash throughput

Method: 256 MiB of pseudo-random data, split into inputs of the size shown and
hashed one input at a time. Values are GiB/s, best of five runs.

| Input size | BLAKE3 1.8.7, 1 thread | BLAKE3 `update_rayon`, 16 threads | SHA-256 (`sha2` 0.11.1, SHA-NI) | SHA-1 (`sha1` 0.11.0) | SHA-1 with collision detection (`sha1-checked` 0.10.0) |
| --- | --- | --- | --- | --- | --- |
| 1 KiB | 1.12 | – | **1.89** | 2.04 | 0.43 |
| 16 KiB | **3.94** | – | 2.02 | 2.16 | 0.45 |
| 64 KiB | **4.75** | – | 2.04 | 2.18 | 0.47 |
| 1 MiB | 4.65 | 14.52 | 2.04 | 2.17 | 0.46 |
| 256 MiB | 4.79 | **33.23** | 2.04 | 2.17 | 0.45 |

What the table shows, on this one Zen 3 host:

- **Large inputs.** BLAKE3 is about 2.3× SHA-256 from 16 KiB up, on one core
  without AVX-512, and it scales further with threads.
- **Small inputs.** At 1 KiB, SHA-256 with SHA-NI is about 1.7× *faster* than
  BLAKE3. Trees, commits, records and most source files are small objects,
  which is exactly this case. A store that hashes only content chunks of
  8–64 KiB sits in BLAKE3's favourable range.
- **The Git bridge's own cost.** Git's collision-detecting SHA-1, which cst's
  workspace already ships through gix as `sha1-checked`, runs at about
  0.45 GiB/s. That is slower than either native candidate, and the bridge pays
  it for every exported object whatever the native hash is.

## 3. Object and pack formats of comparable systems

| System | Object identity | Physical container | Delta / dedup | Compression | Source |
| --- | --- | --- | --- | --- | --- |
| **Git** | SHA-1 (or SHA-256) of `type SP size NUL content` | Pack `PACK` v2: a 4-byte object count, then entries with a 3-bit type and a varint size. `.idx` v2 has a 256-entry fan-out, sorted names, CRC32s, 4-byte offsets and an 8-byte table for packs over 2 GiB. There are also `.rev`, `.mtimes` and multi-pack-index (`MIDX`, with a `BTMP` chunk for multi-pack bitmaps). | `OFS_DELTA` / `REF_DELTA`, with copy (offset and size) and insert (1–127 bytes) instructions. Window 10 and depth 50 by default (maximum depth 4095). Files above `core.bigFileThreshold` (512 MiB) are stored deflated, "without attempting delta compression". | zlib | [gitformat-pack](https://git-scm.com/docs/gitformat-pack); `git-config(1)` from Git 2.56.0 |
| **Git SHA-256 transition** | Both names | Pack index **v3** stores the names of both formats. `loose-object-idx` maps `sha256-name SP sha1-name`. | Conversion "retains any brokenness in the original object … to allow the conversion to round-trip". It adds `gpgsig-sha256` for dual signatures. | – | [hash-function-transition](https://git-scm.com/docs/hash-function-transition) |
| **Mercurial revlog** | SHA-1 of the sorted parent nodes plus the full text. The field is 32 bytes, of which 20 are used. | `.i` index with 64-byte entries (6-byte offset, flags, compressed and uncompressed lengths, base and link revisions, two parents, node). Data is inline until a size limit is reached, then moves to `.d`. | Delta chains "limited to ~2x the length of the revision's data"; generaldelta (deltas against a parent) is the default since 3.7. | A per-entry header byte: `x` zlib, `(` zstd, `u` raw, `\0` | Mercurial `helptext/internals/revlogs.txt` |
| **Fossil** | SHA1 or SHA3-256 of the raw artifact | An SQLite database. The artifact *format* is the durable contract and the storage an implementation detail. | Delta and zlib compression of blobs | zlib | [Fossil file format](https://fossil-scm.org/home/doc/trunk/www/fileformat.wiki) |
| **Jujutsu** | `GitBackend`: Git IDs. `SimpleBackend` ("just a proof of concept"): BLAKE2b-512, one file per object. | `GitBackend` uses gitoxide. jj-only data (change ID, predecessors) goes in a `StackedTable` under `.jj/repo/store/extra/`; an optional `change-id` commit header carries the change ID. | That of the backend | That of the backend | jj [`docs/technical/architecture.md`](https://github.com/jj-vcs/jj/blob/main/docs/technical/architecture.md); `lib/src/{git_backend,simple_backend}.rs` |
| **Mononoke** | Blake2b `ContentId` over the whole file. The **aliases** SHA-1, SHA-256, Git SHA-1 and SeededBlake3 are each a fetch key. | A pluggable blobstore. `bonsai_git_mapping` is a bidirectional changeset-to-Git-SHA-1 map. | Fixed-size chunks in the filestore. **Packblob** packs related blobs and compresses them with zstd, "one blob serves as a dictionary, and other blobs in the pack are compressed using deltas against that dictionary". | zstd | Sapling `eden/mononoke/docs/2.4-storage-architecture.md`; `filestore/src/fetch_key.rs` |
| **restic** | SHA-256 of the plaintext blob | Packs: `EncryptedBlob… EncryptedHeader Header_Length`, with the header at the **end** so blobs can stream. Blob types are data, tree, and compressed data or tree. Index files are JSON, each under 8 MiB. | CDC (Rabin) dedup, no deltas | zstd (repository v2); AES-256-CTR with Poly1305-AES | [restic references](https://restic.readthedocs.io/en/latest/100_references.html) |
| **borg** | HMAC-SHA256 or keyed BLAKE2b-256, by mode. The unencrypted mode uses SHA256. | Append-only segments of about 500 MB (`BORG_SEG`, under 4 GiB because offsets are 32-bit). Entries are `CRC32 size tag key data`, with tags PUT, DELETE and COMMIT. | buzhash CDC dedup, no deltas | A 2-byte header: none, lz4, zstd (1–22), zlib, lzma | borg data-structures and `init` docs |
| **casync** | SHA-512/256 (default) or SHA-256 per chunk | `.castr` chunk store of `.cacnk` files named by hash; `.caibx` and `.caidx` indexes of chunk hash and size | buzhash CDC | zstd (default), xz, gzip per chunk | casync README |
| **Kopia** | `BLAKE2B-256-128` by default; HMAC-SHA256 and BLAKE3-256 are options | Packs of 20–40 MB (`p` data, `q` metadata), each with a local index at its end; index blobs `x` | buzhash CDC (default 4 MiB) | Several options, including zstd, lz4, s2, gzip and deflate | [Kopia architecture](https://kopia.io/docs/advanced/architecture/); `repo/compression` |
| **Xet** | Keyed BLAKE3. A chunk hash uses `DATA_KEY`. A xorb hash is a Merkle root over `"{hash} : {size}\n"` lines with `INTERNAL_NODE_KEY`. A file hash is the Merkle root re-hashed with a zero key. | **Xorb**: chunks of up to 128 KiB, each with an 8-byte header (version, 3-byte compressed size, scheme, 3-byte uncompressed size), up to 64 MiB serialized and about 1,024 chunks. **Shard**: file reconstructions (terms of `xorb hash + [start, end)` chunk ranges) and CAS info, as 48-byte entries. | Gear CDC dedup at three levels: session, a local shard cache, and a global HMAC-protected query for "eligible" chunks (a file's first chunk, or hash mod 1024 == 0) | Per chunk: none, LZ4, or byte-grouped LZ4 (`BG4`, for floating-point data) | [Xet spec](https://huggingface.co/docs/xet): chunking, hashing, xorb, shard, deduplication |

Patterns that recur across these systems:

1. **Small objects, then a container.** Every system batches its objects into
   containers of megabytes, from Git's packs, restic's packs and borg's
   segments to Kopia's packs and Xet's xorbs. Each container has an index that
   maps an ID to a container and an offset.
2. **Placing the index at the end** (restic, Kopia) lets a container be written
   in one pass.
3. **Two-name maps already exist** in Git's own SHA-256 transition (idx v3 and
   the loose object index), in Mononoke (aliases and `bonsai_git_mapping`) and
   in Jujutsu (the extra-metadata table and the `change-id` header). Each is a
   precedent for decision 9's alias table.

## 4. Compression: zstd, dictionaries, and deltas against chunk deduplication

### 4.1 zstd facts from its owner

- **Benchmarks** ([facebook.github.io/zstd](https://facebook.github.io/zstd/)),
  lzbench on the Silesia corpus with an i7-9700K:

  | Codec | Ratio | Compression | Decompression |
  | --- | --- | --- | --- |
  | zstd 1.5.7 `-1` | 2.896 | 510 MB/s | 1550 MB/s |
  | zlib 1.3.1 `-1` | 2.743 | 105 MB/s | 390 MB/s |
  | lz4 1.10.0 | 2.101 | 675 MB/s | 3850 MB/s |

  zstd is an IETF standard, [RFC 8878](https://www.rfc-editor.org/rfc/rfc8878).
- **Dictionaries** improve small data "dramatically", but "gains are mostly
  effective in the first few KB", and "there is no universal dictionary"
  ([zstd README](https://github.com/facebook/zstd/blob/dev/README.md), "The case
  for Small Data compression").
  - ruzstd's README measures on the `github-users` sample (about 10K JSON
    records of about 1 KB each).
  - Without a dictionary, the output was 34.99% of the original. With the
    reference zstd dictionary it was 16.16% of the no-dictionary output, about
    6× smaller.
- **`--patch-from`** is "effectively dictionary compression" with the old
  version as the dictionary ([`zstd.1.md`](https://github.com/facebook/zstd/blob/dev/programs/zstd.1.md)).
  - v1.4.5 raised the dictionary limit from 32 MB to 2 GB for it.
  - On tarballs of zstd, WordPress and LLVM it is "comparable with bsdiff" in
    patch size at level 19, "~7X" faster at level 19, and ">200X faster on level
    1", with "patch sizes less than 0.5% of the original file size"
    ([v1.4.5 release notes](https://github.com/facebook/zstd/releases/tag/v1.4.5)).
  - Window sizes reach `windowLog` 31 (2 GiB) on 64-bit systems. Above 27, the
    decoder must be told the window size.
- **The seekable format** splits data into independently compressed frames and
  adds a seek table in a skippable frame, "so that subranges of the data can be
  efficiently decompressed" ([`zstd_seekable_compression_format.md`](https://github.com/facebook/zstd/blob/dev/contrib/seekable_format/zstd_seekable_compression_format.md)).
  That is the trade-off between random access and ratio that a lazily fetched
  pack has to make.
- **Mononoke's packblob** applies the same idea inside a VCS server: zstd with
  one blob of a pack as the dictionary for the others (§3).

### 4.2 Local measurement: deltas against chunk deduplication on causet's own history

The corpus is every blob reachable from all refs of this repository, exported
read-only with `git rev-list --objects --all` and `git cat-file --batch`:

- 3,414 blobs, 104,734,531 bytes raw;
- median size 11,359 B, 90th percentile 87,406 B, largest 389,740 B;
- 22.5% of blobs under 2 KiB, 42.2% under 8 KiB, and 85.1% under 64 KiB.

For the path-chained delta row, each blob's version chain is the order
`rev-list` met that path, oldest first. That is an approximation of history
order.

| Layout | Bytes | % of raw |
| --- | --- | --- |
| Raw | 104,734,531 | 100% |
| **Git pack**, defaults (window 10, depth 50, zlib), blobs only | **3,668,866** | 3.50% |
| **Git pack**, `--window=250 --depth=50` | **2,837,315** | 2.71% |
| Each blob compressed alone: zstd-3 / zstd-19 / lz4 | 33,450,787 / 29,660,948 / 51,369,519 | 31.9% / 28.3% / 49.0% |
| Each blob alone, zstd-3 with a trained 110 KiB dictionary | 27,491,378 | 26.2% |
| Each blob delta-compressed against the previous version of its path (zstd raw-content dictionary, as `--patch-from`), zstd-3 / zstd-19 | 8,318,553 / 7,399,256 | 7.9% / 7.1% |
| FastCDC 2 KiB: unique chunks (20.0% of raw), each compressed alone with zstd-3, plus 36 B per chunk reference | 10,544,982 | 10.1% |
| FastCDC 8 KiB: unique 36.7%, the same treatment | 14,541,443 | 13.9% |
| FastCDC 16 KiB: unique 48.0% | 17,813,955 | 17.0% |
| FastCDC 64 KiB: unique 77.0% | 26,544,471 | 25.3% |
| Xet Gear 8 / 64 / 128 KiB: unique 68.3%, each chunk compressed with LZ4 | 36,070,771 | 34.4% |
| **FastCDC 8 KiB unique chunks in path order, zstd-19 in 1 MiB frames** (references not included) | **2,808,053** | 2.68% |
| The same in 4 MiB frames | 2,131,796 | 2.04% |
| The same in one 64 MiB long-window frame | 1,419,255 | 1.36% |
| FastCDC 64 KiB unique chunks in path order, zstd-19 in 1 / 4 / 64 MiB frames | 5,045,838 / 3,043,159 / 1,902,779 | 4.8% / 2.9% / 1.8% |

Reading the table:

- **For source and documentation history, chunk deduplication alone is far
  worse than Git's delta packs.** With each chunk compressed alone, the best
  configuration (2 KiB chunks) is 10.5 MB against Git's 3.7 MB. Most blobs are
  smaller than one chunk, and a small edit rewrites the whole chunk it falls in.
  Lowering the chunk target trades deduplication for many more references.
- **Most of what deltas gain comes back if unique chunks are stored together in
  path (version) order and compressed as a group.** zstd's window then finds
  the cross-version redundancy that deltas would. With 1 MiB frames, 8 KiB
  chunks reach 2.81 MB, below Git's aggressive pack before chunk references
  (about 0.44 MB for 12,160 references at 36 B each).
- **The cost is random access.** Reading one chunk means decompressing its
  frame from the start. The frame size is the knob between ratio and read cost,
  the same trade-off zstd's seekable format exposes.
- **Per-chunk compression wastes ratio on small text.** Xet's per-chunk LZ4 is
  built for large binary model files.

### 4.3 Local measurement: large binaries

The question is how much of version B is already stored once version A is.
Each row chunks both files and counts B's bytes whose chunk also occurs in A.

| Pair | FastCDC 8 / 16 / 64 KiB | Xet 64 KiB | Fixed 64 KiB | zstd-3 of B alone | zstd-3 `--long=28 --patch-from=A` |
| --- | --- | --- | --- | --- | --- |
| `node` 26.7.0 → 26.8.1 (147.9 → 150.4 MB executable) | 45.5% / 43.6% / 39.3% shared | 39.1% | 1.3% | 44,952,436 B (29.9%) | **14,415,346 B (9.6%)** |
| `librustc_driver` 1.98.1 → 1.99.0 (150.8 → 158.3 MB shared library) | 3.7% / 3.5% / 2.7% | 2.8% | 2.2% | 60,381,060 B (38.1%) | 55,585,383 B (35.1%) |

What these two pairs show:

- **CDC beats fixed-size blocks** by a factor of 30 on the `node` pair, as the
  FastCDC papers' fixed-size baselines predict.
- **A delta against the previous version still stores less than chunk
  deduplication does.** On the `node` pair the delta keeps 9.6% of B. CDC alone
  leaves 54.5% of B's bytes new before compression, roughly 16% of raw after it,
  by an estimate that was not separately measured.
- **Some binaries share almost nothing between releases.** Neither technique
  helps the `rustc` pair much.
- **Xet's model checkpoints are the favourable case.** There, layers are
  byte-identical between versions.

## 5. Lazy fetching of content

| System | Mechanism | Measured or stated behaviour | Source |
| --- | --- | --- | --- |
| **Git partial clone** | A filtered clone (`--filter=…`), with *promisor* remotes and promisor packfiles (a `.promisor` file beside `.pack` and `.idx`). A missing object that is a promisor object is fetched instead of being reported as corrupt. | "Dynamic object fetching tends to be slow as objects are fetched one at a time". It runs a `git fetch` subprocess per item over protocol v0, which can mean "multiple authentication requests". `checkout` pre-fetches missing blobs "in a single batch". `repack` keeps promisor and non-promisor packs as "2 distinct partitions". Pushing to a promisor remote is unsupported. | [partial-clone](https://git-scm.com/docs/partial-clone) |
| **Scalar** | A partial clone plus sparse checkout plus background maintenance | "By default, only commit and tree objects are cloned". Sparse checkout starts with the top-level directory only. Maintenance tasks are `commit-graph`, `prefetch`, `loose-objects` and `incremental-repack`. | [scalar](https://git-scm.com/docs/scalar) |
| **Sapling** | Server-assisted laziness for history and files | "Cloning the repository downloads almost no history". The *segmented changelog* downloads the graph's shape in "a few megabytes" and fills in commit data lazily. Files and trees are fetched as needed. Most of this needs the Sapling server, not a Git remote. | [Meta engineering, 2022](https://engineering.fb.com/2022/11/15/open-source/sapling-source-control-scalable/) |
| **EdenFS** | A virtual filesystem that fetches file data on first access. It returns content hashes without reading files. | It uses FUSE on Linux, an NFSv3 server on macOS (formerly macFUSE) and **ProjFS** on Windows. | Sapling `eden/fs/docs/{Overview,macOS,Windows}.md` |
| **Xet** | Reconstruction API → terms → signed multi-range HTTP `GET` on xorbs | A client may request a file's reconstruction for a byte range (`Range` header), with `offset_into_first_range` for the first chunk. All the ranges of one xorb come in one request (`multipart/byteranges`). The spec recommends batching large files, for example 10 GB at a time, and caching chunks "by range, not just individually". | [Xet download protocol](https://huggingface.co/docs/xet/download-protocol) |

What carries over to a native cst:

- **An object can be absent by design.** The store must tell "absent by
  promise" from "corrupt", as Git's promisor objects do. For a policy-filtered
  clone (ADR-0041 decision 6, read permissions), "absent by policy" is a third
  state, which N5 may need. N1's format can reserve it.
- **Batch, never one object at a time.** Git's own documentation names
  per-object fetch as its main weakness. Xet batches by container and byte
  range.
- **Container layout decides what a lazy read costs.** It is the same knob as
  the frame size in §4.2.
- **Verified partial reads.** BLAKE3's internal tree, of fixed 1 KiB leaves,
  supports "verified streaming" of byte ranges (spec §6.4; the Bao tool). A
  content-defined Merkle structure like Xet's verifies at chunk granularity
  instead. Either lets a client check a lazily fetched piece without fetching
  the whole file. A flat whole-file SHA-256 does not, unless each chunk also
  carries its own hash.

## 6. Rust crates for each primitive

The policy is that small, established crates for primitives are allowed, and
nothing that implements a version-control format or protocol. Crate data comes
from the crates.io API and each repository, read 2026-10-17. "Pure Rust" means
it builds with no C compiler.

| Primitive | Crate (latest) | Maintainer (crates.io owners) | Since | Downloads | License | Implementation | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| BLAKE3 | `blake3` 1.8.7 | oconnor663 (BLAKE3 team) | 2019 | 204 M | CC0-1.0 OR Apache-2.0 (OR Apache-2.0 WITH LLVM-exception) | Rust plus asm and C intrinsics. A pure-Rust fallback is automatic, or forced with `pure`. | Optional `rayon` and `mmap` features. The official implementation. |
| SHA-256 | `sha2` 0.11.1 | RustCrypto (tarcieri, newpavlov) | 2016 | 1,074 M | MIT OR Apache-2.0 | Pure Rust with intrinsics; SHA-NI and AArch64 `sha2` detected at run time | |
| SHA-1 (bridge) | `sha1-checked` 0.10.0 | RustCrypto | 2024 | 37 M | MIT OR Apache-2.0 | Pure Rust | Collision detection, as Git uses. **Already in cst's `Cargo.lock`** through gix, along with `sha1` 0.10.7. |
| SHA-1 (plain) | `sha1` 0.11.0 | RustCrypto | 2014 | 593 M | MIT OR Apache-2.0 | Pure Rust | |
| BLAKE2 | `blake2` 0.11.0 | RustCrypto | 2016 | 183 M | MIT OR Apache-2.0 | Pure Rust | For comparison, as used by jj, Mononoke and Kopia |
| FastCDC | `fastcdc` 5.0.0 | nlfiedler (a single maintainer) | 2019 | 2.3 M | MIT | Pure Rust | `v2016`, `v2020` and `ronomon` implementations; normalization levels 0–3; seeds; streaming and async. The README warns that the implementations cut differently. Its average size is limited to 256 B–4 MiB and its maximum to 16 MiB (`v2020` constants). |
| Gear hash | `gearhash` 0.1.4 | srijs | 2019 | 2.1 M | MIT OR Apache-2.0 | Pure Rust, SIMD | The table Xet's spec pins |
| zstd (binding) | `zstd` 0.14.3 / `zstd-safe` 8.2.0 / `zstd-sys` 2.1.2+zstd.1.5.7 | gyscos | 2016 | 429 M | BSD-3-Clause | **C bindings.** It builds the bundled libzstd 1.5.7 with `cc` (or `pkg-config`) and needs a C compiler on every target. | Features for dictionary building (`zdict_builder`), multithreading (`zstdmt`) and the `seekable` format |
| zstd (pure) | `ruzstd` 0.9.1 | KillingSpark | 2019 | 72 M | MIT | Pure Rust | A complete decoder, "about 3.5 times slower" than C on enwik9 by its own measure. The encoder has only "Uncompressed" and "Fastest (roughly level 1)", with no dictionaries. |
| LZ4 | `lz4_flex` 0.14.0 | PSeitz | 2020 | 154 M | MIT | Pure Rust | |
| CRC32 | `crc32fast` 1.5.2 | srijs | 2018 | 769 M | MIT OR Apache-2.0 | Pure Rust, SIMD | Already in cst's `Cargo.lock` |
| zlib (bridge) | `zlib-rs` 0.6.8 (cst pins 0.6.7) | rnijveld, folkertdev (Trifecta Tech Foundation) | 2024 | 185 M | Zlib | Pure Rust | Already a direct dependency of `native/cli`. Git packs need zlib. |
| Memory map | `memmap2` 0.9.11 | RazrFalcon | 2020 | 381 M | MIT OR Apache-2.0 | Pure Rust (OS calls) | |
| Parallelism | `rayon` 1.12.0 | rayon-rs | 2015 | 604 M | MIT OR Apache-2.0 | Pure Rust | |

Notes on the crates:

- **cst pins every dependency exactly** (for example `gix = "=0.87.1"` and
  `zlib-rs = "=0.6.7"`) and records why. New primitives would follow the same
  convention.
- **zstd is the only primitive above with no pure-Rust encoder of production
  quality.** Choosing zstd for writes therefore adds a C compiler to the build
  of each release target, Windows MSVC included.
- **Chunkers need about 100 lines of code.** Their cut points define the
  format. Owning the chunker against a published spec and reference vectors, as
  Xet does, is an option the policy allows, and so is using the `fastcdc` crate
  under the pins above.

## Bearing on N1

The decisions N1's ADR must make, and the facts above that bear on each:

1. **The native hash** (ADR-0041's open question).
   - **Security.** Both target 128-bit security, and both exceed what Git
     requires (§2.1).
   - **Standing.** SHA-256 is NIST-approved and built into every operating
     system's tools. BLAKE3 is neither (§2.1, §2.3).
   - **Speed.** It depends on input size and hardware:
     - On SHA-NI hardware, SHA-256 is faster for objects of about 1 KiB
       (trees, commits, records, small files).
     - BLAKE3 is about 2.3× faster on one core from 16 KiB up, and scales with
       threads (§2.4).
     - BLAKE3's published 12× advantage was measured on a CPU **without**
       SHA-NI (§2.2).
   - **Modes.** BLAKE3 adds keyed and derived-key modes and verified streaming
     (§2.1, §5).
   - **Git.** Git chose SHA-256 for availability. If a native *file content* ID
     were defined as Git's SHA-256 blob hash (`blob <size>\0content`), it would
     equal a Git SHA-256 repository's blob ID. That only works if content IDs
     are whole-file hashes rather than Merkle roots.
   - **The bridge pays for SHA-1 in any case.** Collision-detecting SHA-1 runs
     at about 0.45 GiB/s here, whatever the native hash is (§2.4).
   - **The choice need not be one hash.** Xet and Kopia key with BLAKE3 or
     BLAKE2. Mononoke keeps one canonical hash plus aliases.
2. **What an ID covers.** The choice is between a whole-content hash, with
   chunks as storage (Mononoke: re-chunkable with no ID change), and a Merkle
   root over chunks (Xet: verifiable per chunk, but every ID depends on the
   chunker) (§1.3, §5).
   - Decision 9 needs each Git blob's SHA-1 computed over the whole content
     anyway.
   - A whole-content ID keeps the chunking parameters out of identity, so they
     can be changed later.
3. **The chunker and its parameters.**
   - **Algorithm.** FastCDC is about 10–12× Rabin's speed with equal
     deduplication. Gear alone loses deduplication unless the mask is widened
     (§1.1).
   - **Target size.** Backup tools use 1–4 MiB and Xet 64 KiB. Below one chunk,
     a file is one chunk.
   - **Definition.** The cut points must be specified in cst's own format (gear
     table, masks, normalization, sizes) with reference vectors (§1.3).
   - **Seed.** The question is whether the chunker is seeded per repository:
     privacy against cross-repository deduplication, as at an acceptance point
     serving forks (§1.3).
   - **Scope.** A size threshold below which a file is not chunked at all.
     restic does not split files under 512 KiB, and 42% of causet's blobs are
     under 8 KiB (§4.2).
4. **Containers and their index.**
   - **Packing.** Every comparable system packs objects into containers of
     megabytes with an index from ID to (container, offset), sometimes with the
     index at the end so a container is written in one pass (§3).
   - **Size and layout.** N1 decides the container size, the index format (its
     fan-out, as Git's idx and MIDX have, sorted names, offsets wider than
     32 bits), and whether the index is per container or global.
   - **Platforms.** Linux, Windows and macOS file semantics constrain the
     layout. That is the separate "native repository layout" item on the map.
5. **Compression and deltas.**
   - **For text history, chunk deduplication alone loses to Git's deltas by
     about 3×** (§4.2).
   - **Per-chunk compression gives most of the ratio away.** Grouping unique
     chunks in version order and compressing frames of 1–4 MiB with zstd
     matches or beats Git's packs.
   - **The frame size trades ratio for lazy-read cost.** zstd's seekable format
     is the established form of that trade.
   - **For large binaries,** a zstd `--patch-from` delta against the previous
     version stored less than chunk deduplication did on the one pair where
     either helped (§4.3).
   - **Dictionaries** help small objects (§4.1). Mononoke uses one blob as the
     dictionary for its pack.
   - **The codec.**
     - zstd for writes means C bindings, since `ruzstd` encodes only at about
       level 1 (§6).
     - LZ4 (as in Xet) is pure Rust and faster to decode, at a lower ratio.
     - Git's zlib is needed only by the bridge.
6. **Lazy fetch in the format.**
   - **A third object state.** Objects can be absent by promise, and later by
     policy. The format must tell both from corruption (Git promisor objects,
     §5).
   - **Batched fetch.** It is by container and byte range, never one object at
     a time; Git documents that weakness of its own partial clone.
   - **Verification granularity.** The choice is per chunk (Merkle, as Xet)
     or per file (§5).
   - **What every clone holds.** The question is whether every clone holds all
     history metadata (commits, trees and records) while file content is lazy,
     as Scalar's "commit and tree objects" default does. Or is metadata lazy
     too, as Sapling's segmented changelog makes it?
   - **Ordering.** Read permissions (N5) build on whatever N1 chooses here.
7. **Aliases for the Git bridge** (decision 9).
   - **Precedents.** Git's own SHA-256 transition, Mononoke and Jujutsu all
     keep a two-way map from native name to Git name (§3).
   - **What the store must preserve.** It must keep everything Git's IDs hash:
     - commit headers byte for byte, including `gpgsig` and `gpgsig-sha256`,
       `mergetag`, encodings and extra headers such as jj's `change-id`;
     - tree entry modes and order;
     - "any brokenness in the original object", which Git's own design keeps in
       order to round-trip.
   - **Where the map lives.** N1 decides whether it is a sorted index beside
     the containers (like idx v3) or a separate table (like
     `loose-object-idx`), and whether it holds SHA-1 only or both SHA-1 and
     SHA-256 for Git 3.0 repositories.
8. **Dependencies under the policy.**
   - **Already in the lock file:** `sha1-checked`, `crc32fast`, `zlib-rs`.
   - **Candidates:** `blake3`, `sha2`, `fastcdc` or an owned chunker,
     `lz4_flex`, `memmap2`, `rayon`.
   - **The open question is zstd:** `zstd` (C bindings, the full feature set)
     or `ruzstd` (pure Rust, decoder only in practice).
   - **Forbidden by the policy:** any crate that implements a VCS format or
     protocol. Xet's `xet-core` and gitoxide are examples.

Clear trade-offs:

- **Hash: speed on large inputs against ubiquity.** BLAKE3 is faster on large
  inputs and gives verified streaming. SHA-256 is standardized, everywhere, and
  faster on small objects with SHA-NI.
- **Chunking: deduplication against index cost.** Small chunks deduplicate
  better but multiply references and index size.
- **Compression: ratio against random access.** Solid, grouped compression
  approaches Git's ratios but makes lazy reads and repacks more expensive.
- **zstd: capability against a pure-Rust build.**
