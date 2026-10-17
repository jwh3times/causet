# The cost of a cst-owned Git bridge

Research for [#286](https://github.com/jwh3times/causet/issues/286), part of
the map [#281](https://github.com/jwh3times/causet/issues/281). The question:
what does it take for cst to implement Git's formats in its own code, as
[ADR-0041](../docs/adr/0041-make-cst-a-standalone-distributed-version-control-system.md)
decision 9 (the permanent two-way bridge with exact round trips) and the
constraint "Bridgeable from the start" require?

The dependency policy (map Notes, owner 2026-10-17): small, established crates
for primitives (hashing, compression, TLS, SSH, crypto) are allowed; nothing
may implement a version-control format or protocol.

## Sources and how sizes were measured

- **Git**: `git/git` at `master`, commit
  [`c51408889c3b`](https://github.com/git/git/tree/c51408889c3b372814bc20b9431c3b74d0d268eb)
  (`DEF_VER=v2.56.GIT`), fetched 2026-10-17 as a tarball. Spec sizes are line
  counts of the `.adoc` files under `Documentation/`; code sizes are `wc -l` of
  the named C files (comments and blank lines included).
- **gitoxide**: tag
  [`gix-v0.87.1`](https://github.com/GitoxideLabs/gitoxide/tree/gix-v0.87.1)
  (commit `3ebca8b66017`), the version `native/core` pins. Sizes are lines of
  `src/**/*.rs` per crate, given as *all lines / code lines* (code lines exclude
  blank lines and `//` and `///` comment lines). Feature coverage is quoted from
  its [`crate-status.md`](https://github.com/GitoxideLabs/gitoxide/blob/gix-v0.87.1/crate-status.md).
- **GitHub**: its documentation, plus the live capability advertisements of
  `https://github.com/jwh3times/causet.git` fetched with `curl` on 2026-10-17
  (reproduced below).
- **Crates**: the crates.io API on 2026-10-17 (latest stable version; "90-day
  downloads" is crates.io's `recent_downloads`).
- Line counts are size *indicators*, not estimates of cst's code. Where this
  note gives an estimate of cst's own code, it says so; those estimates are the
  author's judgment, not measurements.

## What cst has today

`native/core` is the only crate that links gitoxide
([`native/core/Cargo.toml`](../native/core/Cargo.toml)):

```toml
gix = { version = "=0.87.1", default-features = false, features = ["sha1", "revision"] }
```

- **Features used:** `sha1` (enables `gix-hash/sha1`, which hashes through the
  `sha1-checked` crate, a SHA-1 with collision detection) and `revision`
  (`gix-revision/describe`, `merge_base`, and `index`). No network feature
  (`blocking-network-client`, any `*-http-transport-*`), no `credentials`, no
  `sha256`.
- **What `native/core/src/lib.rs` (363 lines) does with it:** opens a
  repository (`gix::discover_opts`), refuses SHA-256, `extensions.refStorage`
  (reftable), partial clone, promisors, grafts and replace refs, lists refs,
  resolves `^{commit}`/`^{tree}` peels, reads object headers and contents from
  loose objects and packs, and walks notes trees. It parses tree entries
  itself (`tree_entries`, about 50 lines) and calls gix's `CommitRef` and
  `TagRef` parsers only to validate. It is read-only and bounded (64 MiB per
  batch).
- **What it does not do:** write anything, or talk to a remote. `cst fetch`
  and `cst push` run the `git` executable
  ([`native/cli/src/sync.rs`](../native/cli/src/sync.rs): `git fetch --quiet
  --no-tags …` and `git push --atomic --quiet --no-verify …`), as do all
  writes. The ADR records that cst "runs the `git` executable for every write
  and most reads".
- **What the lockfile shows:** 45 `gix*` crates are compiled in, including
  `gix-pack`, `gix-commitgraph`, `gix-ref`, `gix-protocol`, `gix-transport` and
  `gix-packetline` (pulled in transitively; `gix-protocol` is a non-optional
  dependency of `gix`). No TLS, HTTP or SSH crate is in
  [`native/Cargo.lock`](../native/Cargo.lock). The primitives already present
  are `sha1-checked 0.10.0`, `sha1 0.10.7`, `crc32fast 1.5.2` and
  `zlib-rs 0.6.7` (also a direct dependency of `causet-cli`).
- **So the bridge replaces two things:** gix's read path (on-disk formats) and
  the `git` executable (every write and all transport). Nothing in cst today
  covers the transport side even through gix.

## The pieces

Each piece below gives the primary specifications, cst's coverage today, size
indicators, the edge cases that make it expensive, and the primitive crates.

### 1. Object encoding and the SHA-1 object format

**Specs:** there is no single `gitformat-*` page for the canonical encoding of
commit, tree, tag and blob objects. It is spread over
[`gitformat-loose`](https://github.com/git/git/blob/c51408889c3b372814bc20b9431c3b74d0d268eb/Documentation/gitformat-loose.adoc)
(the `<type> <size>\0` header, 131 lines),
[`gitformat-signature`](https://github.com/git/git/blob/c51408889c3b372814bc20b9431c3b74d0d268eb/Documentation/gitformat-signature.adoc)
(`gpgsig`, `gpgsig-sha256`, `mergetag`; 229 lines), and in practice `commit.c`
(2,037), `tree.c` (220), `tag.c` (234), `object.c` (622) and `fsck.c` (1,488),
which defines what Git accepts. `fsck.h` lists 76 fsck message IDs; among the
ones that bear on exact round trips are `BAD_DATE`, `ZERO_PADDED_DATE`,
`BAD_EMAIL`, `MISSING_SPACE_BEFORE_DATE`, `BAD_GPGSIG`, `TREE_NOT_SORTED`,
`DUPLICATE_ENTRIES`, `ZERO_PADDED_FILEMODE` (a warning) and `BAD_FILEMODE`
(info).

**Why it matters most for cst:** decision 9 requires that an imported commit
re-exports with its original ID. The object ID is the hash of the exact bytes,
so the native store must keep, per bridged object, everything that is not
derivable: header order, extra and unknown headers, `encoding`, signatures,
non-UTF-8 names and messages, odd timezone strings, and tree entry modes as
written (fsck only *warns* on zero-padded modes such as `040000`, so such trees
exist on hosts and must round-trip byte for byte). The simplest form of
"exact" is to keep the original object bytes (or a lossless decomposition) as
the alias's source of truth. This is a native-store design choice for N1/N2,
not bridge code, but it is where most of the round-trip risk lives.

**gitoxide today:** `gix-object` 6,410 / 4,843 lines (parse and serialize all
four kinds, zero-copy), `gix-actor` 535 / 357, `gix-date` 1,205 / 783,
`gix-validate` 764 / 616.

**Hashing:** Git's default build uses its bundled `sha1collisiondetection`
(git `Makefile`: "If don't enable any of the *_SHA1 settings … Git will default
to its built-in sha1collisiondetection library"; `sha1dc/` is 2,445 lines of
C). The same Makefile now has `_UNSAFE` variants for "non-cryptographic
purposes" such as pack checksums. gitoxide uses
[`sha1-checked`](https://crates.io/crates/sha1-checked) ("SHA-1 hash function
with collision detection", RustCrypto; `gix-hash/src/hasher.rs`: "the same
collision detection algorithm as Git").

**Primitive crates:** `sha1-checked 0.10.0` (already in the lockfile), `sha1
0.11.0` for checksums where collision detection is unnecessary, `faster-hex`
or hand-written hex.

**cst estimate (judgment):** 1,500–3,000 lines for parse/serialize with exact
preservation and fsck-grade validation of untrusted input; SHA-1 is a wrapper.

### 2. SHA-256 and the hash transition

**Specs:**
[`technical/hash-function-transition`](https://github.com/git/git/blob/c51408889c3b372814bc20b9431c3b74d0d268eb/Documentation/technical/hash-function-transition.adoc)
(835 lines), `extensions.objectFormat` and `extensions.compatObjectFormat` in
`Documentation/config/extensions.adoc`, the loose object mapping in
`gitformat-loose` ("When the `compatObjectFormat` option is used, Git needs to
store a mapping…"), and the `object-format` capability in
`gitprotocol-capabilities` and `gitprotocol-v2`.

**State of Git:** `compatObjectFormat` (dual SHA-1/SHA-256 interoperation) is
documented as: "the functionality enabled by this extension is incomplete and
subject to change. It currently exists only to allow development and testing
of the underlying feature and is not designed to be enabled by end users." A
SHA-256 repository therefore cannot exchange objects with a SHA-1 one today.
[`BreakingChanges`](https://github.com/git/git/blob/c51408889c3b372814bc20b9431c3b74d0d268eb/Documentation/BreakingChanges.adoc)
plans Git 3.0 to default new repositories to `sha256`, conditional on "the
ecosystem [being] ready to support the 'sha256' object format … includ[ing]
popular Git libraries, applications and forges".

**GitHub:** **unverified** whether github.com hosts SHA-256 repositories; no
GitHub documentation or changelog entry announcing it was found on 2026-10-17
(only a secondary blog post saying it has not been announced). The causet
repository advertises `object-format=sha1`, which says nothing about SHA-256
support in general.

**gitoxide today:** `gix-hash` has a `sha256` feature (`dep:sha2`) and `gix`
has a `sha256` feature, but `crate-status.md` still lists "Git 3.0
compatibility (`SHA-256`, `reftable`)" as open. cst does not enable it and
refuses SHA-256 repositories (`native/core/src/lib.rs`).

**Cost:** for the bridge the format difference is small and mechanical:
32-byte IDs, 64-hex names, `gpgsig-sha256`, the hash in every pack and index
trailer. The cost is that every fixed-width parser must be parameterised by
hash, which is cheap if done from the start and expensive to retrofit (gix
spent years on it). Cross-hash conversion (`compatObjectFormat`) is not
needed for the bridge: cst's own aliasing (decision 9) plays that role.

**Primitive crates:** `sha2 0.11.1` (RustCrypto).

**cst estimate (judgment):** a few hundred lines if hash-generic from day one.
Low priority until a forge cst targets hosts SHA-256 repositories.

### 3. Pack files, deltas and pack indexes

**Specs:**
[`gitformat-pack`](https://github.com/git/git/blob/c51408889c3b372814bc20b9431c3b74d0d268eb/Documentation/gitformat-pack.adoc)
(704 lines: `.pack`, `.idx` v1 and v2, `.rev`, `.mtimes`, multi-pack-index,
cruft packs),
[`gitformat-chunk`](https://github.com/git/git/blob/c51408889c3b372814bc20b9431c3b74d0d268eb/Documentation/gitformat-chunk.adoc)
(133), `technical/pack-heuristics` (460, how delta bases are chosen),
`technical/multi-pack-index` (265), `technical/bitmap-format` (398).

Key facts from `gitformat-pack`: the header is `PACK`, a version that "Git
currently accepts … 2 or 3 but generates version 2 only", and an object count;
object types are commit (1), tree (2), blob (3), tag (4), `OBJ_OFS_DELTA` (6)
and `OBJ_REF_DELTA` (7); a delta is a sequence of copy-from-base and insert
instructions; `.idx` v2 is a fan-out table, sorted names, CRC32s, 4-byte
offsets with an 8-byte large-offset table for packs over 2 GiB, and both
checksums. "The pack format is also used over-the-wire" (it is the payload of
fetch and push).

**Git's code:** `packfile.c` 2,223, `builtin/index-pack.c` 2,157,
`builtin/pack-objects.c` 5,543, `pack-write.c` 615, `pack-revindex.c` 609,
`pack-check.c` 211, `diff-delta.c` 510 (delta *creation*), `patch-delta.c` 94
(delta *application*), `builtin/unpack-objects.c` 698; accelerators
`pack-bitmap.c` 3,433 + `pack-bitmap-write.c` 1,441, `midx.c` 1,069 +
`midx-write.c` 2,181.

**gitoxide today:** `gix-pack` 11,104 / 8,598 lines: `data/input` 860
(streaming decode of a received pack), `data/delta.rs` 125 (apply), `cache`
2,113 (delta-base caches), `index` 2,367 (read, verify, traverse; `index/write`
312), `data/output` 1,619 (pack generation), `multi_index` 1,281. Its
`crate-status.md` marks "resolve 'thin' packs" and "create 'thin' pack" done,
but **"delta compression" not done** (it writes packs of whole objects) and
"write index along with the new pack" not done. `gix-odb` (5,738 / 4,480) is
the object database over loose objects and packs.

**Edge cases:**
- *Delta chains:* `pack.depth` "Defaults to 50. Maximum value is 4095"
  (`Documentation/config/pack.adoc`); a reader must resolve chains of any
  depth a server sends, with a base cache to avoid quadratic re-inflation.
- *OFS vs REF deltas:* `ofs-delta` is a capability; REF deltas may name bases
  later in the pack or outside it.
- *Thin packs:* "A thin pack is one with deltas which reference base objects
  not contained within the pack … it requires the receiving end to know how to
  'thicken' these packs" (`gitprotocol-capabilities`). For fetch, a client
  "MUST NOT request the 'thin-pack' capability if it cannot turn a thin pack
  into a self-contained pack", so a first bridge can simply not request it. For
  push, "Receive-pack … is assumed by default to be able to handle thin packs",
  so a client may send thin packs to GitHub; it is an optimisation, not a
  requirement.
- *Untrusted input:* delta size headers, base references and object sizes come
  from the network. cst already treats Git metadata as untrusted and budgets
  object sizes; the pack reader must keep that (cycle-free REF bases, size
  caps before allocation, checksum and CRC verification).
- *Delta creation for push:* sending whole objects is correct but large;
  choosing good bases (window 10 by default, `pack.window`) is where
  `pack-objects` spends its 5,500 lines.

**Primitive crates:** zlib inflate/deflate — `zlib-rs 0.6.x` (already present;
"A memory-safe zlib implementation written in rust", Trifecta Tech Foundation),
optionally behind `flate2 1.1.10`; `miniz_oxide 0.9.1` is the other
established pure-Rust option. CRC32 — `crc32fast 1.5.2` (already present; the
spec says "The CRC32 algorithm used is that of zlib", i.e. IEEE). Memory
mapping — `memmap2` (already present).

**What the bridge actually needs:** to *decode* a received pack stream into
cst's native store (inflate, apply deltas, hash, verify the trailer) and to
*encode* a pack for push. It needs `.idx` files, `.rev`, MIDX and bitmaps only
if cst reads or writes Git repositories on disk (see piece 4).

**cst estimate (judgment):** decode with deltas, 1,500–3,000 lines; encode of
whole objects, 500–1,000; delta search for push, a further 1,500–3,000; `.idx`
v2 read/write, 500–800.

### 4. Loose objects, refs on disk, and the commit-graph

These are Git's *local* repository formats. The bridge, as ADR-0041 decision 9
describes it (a cst repository hosted on a Git forge, Git users working through
the forge), is a *wire* peer and needs none of them. They matter for two other
things: **N1's lossless import of an existing local Git repository**, and any
mode where cst and Git share one `.git` directory (today's N0). An import over
the wire from a forge avoids them; importing a local clone without running Git
needs at least the read side of loose objects, packs + `.idx`, loose refs and
`packed-refs` (and reftable, once Git 3.0 defaults to it).

**Loose objects:** `gitformat-loose` (131 lines): `objects/xx/yyyy…`, zlib of
`<type> <size>\0<content>`. Git `object-file.c` 1,523, `loose.c` 269.
gitoxide `gix-odb` `store_impls/loose` 798 lines. Small: a few hundred lines.

**Loose refs and `packed-refs`:** there is no `gitformat-*` page; the formats
are described in `git-pack-refs`, `gitrepository-layout` and `refs/*.c` (git
`refs/files-backend.c` 4,116, `refs/packed-backend.c` 2,183, `refs.c` 3,622).
gitoxide `gix-ref` 6,682 / 5,226 (`store/file` 3,621, `store/packed` 1,288).
Reading is small (hundreds of lines); writing with Git-compatible locking,
reflogs and atomic transactions is larger.

**Commit-graph:**
[`gitformat-commit-graph`](https://github.com/git/git/blob/c51408889c3b372814bc20b9431c3b74d0d268eb/Documentation/gitformat-commit-graph.adoc)
(186 lines) and `technical/commit-graph` (410). Git `commit-graph.c` 2,968,
`chunk-format.c` 215. gitoxide reads it (`gix-commitgraph` 1,207 / 907,
`gix-chunk` 378 / 251); writing and Bloom filters are open in its
`crate-status.md`. It is an accelerator: Git works without it, so neither the
bridge nor import needs it. Write it only if cst maintains a Git repository
that Git users will read locally.

### 5. Reftable

**Spec:**
[`technical/reftable`](https://github.com/git/git/blob/c51408889c3b372814bc20b9431c3b74d0d268eb/Documentation/technical/reftable.adoc)
(1,098 lines; block format with prefix compression, ref/obj/log/index blocks,
tables.list stack, compaction). Git `reftable/` 9,236 lines of C plus
`refs/reftable-backend.c` 2,892. `BreakingChanges` plans the Git 3.0 default
ref storage to change "from 'files' to 'reftable'", with the prerequisite that
"alternative implementations of Git like JGit, libgit2 and Gitoxide need to
support it".

**gitoxide today:** none. `crate-status.md` lists `gix-reftable` ("read and
write reftable stacks") unchecked, and cst refuses `extensions.refStorage`.

**For the bridge:** reftable is a local format and never crosses the wire, so a
wire-only bridge does not need it. Import of a local Git 3.0 repository would
need a reftable *reader* (estimate, judgment: 1,000–2,000 lines; a writer with
compaction is several times that).

### 6. pkt-line, sideband, and the protocol versions

**Specs:**
[`gitprotocol-common`](https://github.com/git/git/blob/c51408889c3b372814bc20b9431c3b74d0d268eb/Documentation/gitprotocol-common.adoc)
(120 lines, pkt-line),
[`gitprotocol-pack`](https://github.com/git/git/blob/c51408889c3b372814bc20b9431c3b74d0d268eb/Documentation/gitprotocol-pack.adoc)
(727; protocol v0/v1: reference discovery, packfile negotiation, push, report
status),
[`gitprotocol-capabilities`](https://github.com/git/git/blob/c51408889c3b372814bc20b9431c3b74d0d268eb/Documentation/gitprotocol-capabilities.adoc)
(396; 26 capability sections from `multi_ack` to `session-id`),
[`gitprotocol-v2`](https://github.com/git/git/blob/c51408889c3b372814bc20b9431c3b74d0d268eb/Documentation/gitprotocol-v2.adoc)
(904; commands `ls-refs`, `fetch`, `object-info`, `bundle-uri`, plus
`server-option`, `object-format`, `session-id`, `promisor-remote`).

Key facts:
- pkt-line packets are at most `LARGE_PACKET_MAX` 65,520 bytes (`pkt-line.h`).
  With `side-band-64k`, each data packet carries a band byte: "1 - pack data,
  2 - progress messages, 3 - fatal error message".
- **Protocol v2 has no push.** Its commands are `ls-refs`, `fetch`,
  `object-info` and `bundle-uri`, and Git's own client refuses v2 push:
  `transport.c` `git_transport_push` has `case protocol_v2: die(_("support for
  protocol v2 not implemented yet"));`. Push is always the v0 `receive-pack`
  exchange, so even a v2-only fetch client must implement v0's ref
  advertisement for push.
- v0 fetch negotiation (`multi_ack`, `multi_ack_detailed`, `no-done`, and the
  stateless-RPC variant over HTTP, where the client re-sends its state every
  round) is the most intricate part of the protocol. v2 fetch replaces it with
  stateless rounds of `want`/`have`/`done` and an `acknowledgments` section.

**What GitHub advertises** (fetched 2026-10-17 from
`https://github.com/jwh3times/causet.git/info/refs?service=git-upload-pack`):

- v2 (request header `Git-Protocol: version=2`): `agent=git/github-…`,
  `ls-refs=unborn`, `fetch=shallow wait-for-done filter`, `server-option`,
  `object-format=sha1`. No `bundle-uri`, `object-info` or `packfile-uris`.
- v0: `multi_ack thin-pack side-band side-band-64k ofs-delta shallow
  deepen-since deepen-not deepen-relative no-progress include-tag
  multi_ack_detailed allow-tip-sha1-in-want allow-reachable-sha1-in-want
  no-done symref=HEAD:refs/heads/main filter object-format=sha1`.
- `info/refs?service=git-receive-pack` without credentials returns `401` with
  `www-authenticate: Basic realm="GitHub"`, so the receive-pack capabilities
  were not observed here (**unverified** which push capabilities GitHub
  advertises; `report-status`, `side-band-64k`, `atomic`, `delete-refs`,
  `ofs-delta`, `push-options` and `quiet` are expected from stock receive-pack).

**Git's code:** `pkt-line.c` 711, `sideband.c` 474, `connect.c` 1,554,
`fetch-pack.c` 2,354, `send-pack.c` 782 (+ `builtin/send-pack.c` 357),
`transport.c` 1,784, `transport-helper.c` 1,707, `protocol.c` 99; negotiators
`negotiator/default.c` 209, `skipping.c` 280, `noop.c` 52; `shallow.c` 897; the
server side (`upload-pack.c` 1,827, `builtin/receive-pack.c` 2,688, `serve.c`
378, `ls-refs.c` 224) is not needed by a client-only bridge.

**gitoxide today:** `gix-packetline` 2,093 / 1,588; `gix-protocol` 3,847 /
2,911 (`fetch` 2,141, `handshake` 812, `ls_refs` 305); `gix-negotiate` 518 /
407 ("standard negotiation algorithms `consecutive`, `skipping` and `noop`").
`crate-status.md`: fetch, clone, ls-refs and shallow are done; **push is not**
("[ ] push … report-status, sideband, delete-refs, push-options and atomic
pushes"; "[ ] object-format negotiation"). So for push there is no gitoxide
code to take as a reference at all, and cst today relies on `git push
--atomic`.

**Edge cases:** v0 multi-ack state machines; stateless-RPC over HTTP;
`no-done`; shallow (`shallow`/`unshallow`/`deepen*` and the `shallow` file,
`technical/shallow` 60 lines); partial clone (`filter`, promisors,
`technical/partial-clone` 367 lines); `include-tag`; symrefs and `unborn` HEAD;
sideband progress and band-3 errors mid-stream; `report-status-v2`; atomic
pushes; push options; push certificates.

**cst estimate (judgment):** pkt-line + sideband 300–500 lines; v2 `ls-refs` +
`fetch` with a simple negotiator, no shallow or filter, 1,000–2,000; v0
receive-pack push with `report-status`, `atomic`, `side-band-64k`, 800–1,500;
v0 fetch negotiation (only for servers without v2), a further 1,000–2,000.

### 7. Smart HTTP transport

**Spec:**
[`gitprotocol-http`](https://github.com/git/git/blob/c51408889c3b372814bc20b9431c3b74d0d268eb/Documentation/gitprotocol-http.adoc)
(544 lines: discovery at `$GIT_URL/info/refs?service=…`, the
`application/x-git-upload-pack-advertisement` content type, the
`Git-Protocol` header for v2, smart services `git-upload-pack` and
`git-receive-pack`, authentication).

**Git's code:** `remote-curl.c` 1,668 and `http.c` 3,092 on top of libcurl.
`remote-curl.c` shows the details a client must reproduce: large request
bodies are sent with `Transfer-Encoding: chunked` after a probe request
(`probe_rpc`, `Expect: 100-continue`), smaller ones may use `Content-Encoding:
gzip`, and a `401` triggers re-authentication only when the body can be
re-sent (`err == HTTP_REAUTH && !large_request`). Redirects, proxies (and proxy
authentication), `http.extraHeader`, cookies and custom CAs are the long tail
in `http.c`.

**gitoxide today:** `gix-transport` 5,713 / 4,577 lines, of which
`blocking_io/http` 2,287, but only as an adapter over `curl` or `reqwest`
(features `http-client-curl*`, `http-client-reqwest*`); its own table marks
async HTTP and re-authentication after redirect as unsupported. cst enables
none of it.

**Primitive crates (all HTTP/TLS, none version-control):**
- TLS: [`rustls 0.23.46`](https://crates.io/crates/rustls) ("a modern TLS
  library written in Rust") with a crypto provider (`aws-lc-rs 1.18.2`, the
  default, or `ring 0.17.14`) and root verification by
  [`rustls-platform-verifier 0.7.1`](https://crates.io/crates/rustls-platform-verifier)
  (the OS verifier on Windows, macOS and Linux) or `webpki-roots 1.0.9`
  (Mozilla's roots, bundled). Alternatively `native-tls 0.2.18` (SChannel,
  Security.framework, OpenSSL).
- HTTP client: [`ureq 3.4.2`](https://crates.io/crates/ureq) ("Simple, safe
  HTTP client", blocking, rustls by default) fits cst's synchronous design;
  `hyper 1.12.0` is lower-level and async; `reqwest 0.13.5` is heavier.
  `httparse 1.10.1` exists for a hand-rolled HTTP/1.1 client.
- Compression for gzip request bodies: `flate2` or `zlib-rs` (piece 3).

**cst estimate (judgment):** with `ureq` + `rustls`, the smart-HTTP layer
(discovery, POST rounds, chunked push bodies, auth retry, redirect policy) is
500–1,000 lines. Proxy support and Git-config compatibility (`http.*`) add to
it.

### 8. SSH transport

**Spec:** `gitprotocol-pack` "SSH Transport" (the client runs `git-upload-pack
'<path>'` or `git-receive-pack '<path>'` as a remote command) and
`gitprotocol-v2` "SSH and File Transport" (v2 is requested through the
`GIT_PROTOCOL` environment variable). Git spawns an external `ssh` program
(`connect.c`, with `SendEnv=GIT_PROTOCOL` added for OpenSSH, and variants for
PuTTY/plink and TortoisePlink).

**GitHub:** host keys are RSA, ECDSA and Ed25519 (DSA "closing down"), with
published fingerprints
([GitHub docs](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints));
supported user keys are RSA, ECDSA and Ed25519, and DSA keys are "no longer
supported"
([GitHub docs](https://docs.github.com/en/authentication/connecting-to-github-with-ssh/checking-for-existing-ssh-keys)).
**Unverified:** that GitHub honours `GIT_PROTOCOL=version=2` over SSH (it is
expected; not tested here, as it needs a key).

**gitoxide today:** `gix-transport` `blocking_io/ssh` 659 lines, which
launches the external `ssh` binary; "ssh:// without an external `ssh` binary"
and "native SSH transport" (`gix-ssh`) are unchecked, as are "agent, key,
password and askpass authentication".

**Two options under the policy:**
1. **Spawn the system `ssh`** as Git does. OpenSSH is not a version-control
   implementation, it handles agents, keys, `~/.ssh/config`, known hosts and
   hardware keys, and Windows 10 1809+ ships it (**unverified** for every
   supported Windows image). Cost: about 300–500 lines (judgment), mostly
   command construction and quoting per client variant.
2. **Native SSH** with [`russh 0.64.1`](https://crates.io/crates/russh) ("A
   client and server SSH library"; async on tokio, per its docs; it has key and
   agent handling under `russh::keys`, and depends on `pageant` for Windows) or
   [`ssh2 0.9.6`](https://crates.io/crates/ssh2) (libssh2 bindings, C). Key
   files: [`ssh-key 0.6.7`](https://crates.io/crates/ssh-key) (RustCrypto,
   OpenSSH key formats). Agent protocol: `ssh-agent-lib 0.6.0` or russh's own
   client. Cost: the transport is small, but known-hosts verification,
   `~/.ssh/config` semantics, agent sockets (Unix socket, Windows named pipe,
   Pageant), passphrase prompting and hardware keys are each a body of work;
   russh would also bring an async runtime into a synchronous CLI.

Option 1 is the established route and the cheaper one; option 2 removes an
external program at a large compatibility cost. Neither is needed for the
first, HTTPS-only bridge.

### 9. GitHub authentication: tokens and credential helpers

**GitHub's rules:**
"Password-based authentication for Git has been removed in favor of more
secure authentication methods"; "When Git prompts you for your password, enter
your personal access token"; "you can use a credential helper like Git
Credential Manager"
([about remote repositories](https://docs.github.com/en/get-started/git-basics/about-remote-repositories)).
A GitHub App installation token is used "as the HTTP password" with username
`x-access-token`
([GitHub docs](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation)).
The live receive-pack endpoint answers `401` with `Basic realm="GitHub"`. So
HTTPS authentication to GitHub is HTTP Basic with a token as the password.

**Credential helper protocol:**
[`git-credential`](https://github.com/git/git/blob/c51408889c3b372814bc20b9431c3b74d0d268eb/Documentation/git-credential.adoc)
(294 lines; "INPUT/OUTPUT FORMAT": `protocol`, `host`, `path`, `username`,
`password`, `password_expiry_utc`, `oauth_refresh_token`, `url`, `authtype`,
`credential`, `ephemeral`, `state[]`, `continue`, `wwwauth[]`,
`capability[]`) and
[`gitcredentials`](https://github.com/git/git/blob/c51408889c3b372814bc20b9431c3b74d0d268eb/Documentation/gitcredentials.adoc)
(335 lines; helper configuration, `credential.<url>.*` matching, `useHttpPath`).
The actions are `get`, `store` and `erase`.

**The catch for a Git-free cst:** helper resolution goes through Git. Per
`gitcredentials`, if the helper string is not an absolute path or `!command`,
"the string 'git credential-' is prepended", so `credential.helper=manager`
runs `git credential-manager`. A Git-free cst must resolve `git-credential-<name>`
on `PATH` itself (Git Credential Manager installs such an executable;
**unverified** that every Git for Windows layout puts it on `PATH`), and the
two most common built-in helpers, `store` (`builtin/credential-store.c`, 222
lines, a plain-text file) and `cache` (`builtin/credential-cache.c` 207 +
daemon 354, a Unix-socket daemon), exist only inside the `git` binary, so cst
would reimplement `store` and either reimplement or decline `cache`. The OS
helpers `osxkeychain`, `wincred` and `libsecret` live in Git's
`contrib/credential/` and are separate executables. gitoxide's
`gix-credentials` (1,230 / 973) "run[s] `git credential` directly", i.e. it
depends on the Git executable for this.

**Primitive crates:** process spawning is `std`; an OS keychain, if cst stores
its own tokens, is [`keyring 4.2.0`](https://crates.io/crates/keyring).
Reading Git's configuration to find `credential.helper` and `url.*.insteadOf`
is a compatibility choice; gitoxide's `gix-config` is 10,202 / 7,345 lines,
and a reader for the subset the bridge needs is far smaller.

**cst estimate (judgment):** token from environment or cst's own store plus
the helper protocol (`get`/`store`/`erase`, URL matching), 400–800 lines; a
`store`-compatible file, about 200 more.

## Size summary

Primary-spec length (lines of `.adoc`) and the size of the equivalent code. The
cst column is the author's estimate for the subset named, not a measurement.

| Piece | Specs (lines) | Git C (lines) | gitoxide Rust (all / code) | Minimal cst subset (estimate) |
| --- | --- | --- | --- | --- |
| Object encoding, SHA-1 | loose 131, signature 229 (+ code as spec) | commit/tree/tag/object 3,113; fsck 1,488; sha1dc 2,445 | gix-object 6,410 / 4,843; gix-hash 1,829 / 1,363 | 1,500–3,000 |
| SHA-256 | hash-function-transition 835 | sha256/ 352 (+ hash.c 382) | `sha256` features exist; repo support open | few hundred if generic from day one |
| Pack decode, deltas | pack 704, chunk 133 | packfile 2,223; index-pack 2,157; patch-delta 94 | gix-pack 11,104 / 8,598 | 1,500–3,000 |
| Pack encode (push) | pack 704, pack-heuristics 460 | pack-objects 5,543; diff-delta 510; pack-write 615 | data/output 1,619 (no delta compression) | 500–1,000 whole objects; +1,500–3,000 deltas |
| `.idx` v2 | pack 704 (shared) | pack-write, pack-check | index 2,367 | 500–800 (local only) |
| Loose objects | loose 131 | object-file 1,523; loose 269 | odb loose 798 | 200–400 (local only) |
| Refs: files, packed | (no gitformat page) | files 4,116; packed 2,183 | gix-ref 6,682 / 5,226 | read 300–600 (local only) |
| Commit-graph | commit-graph 186 + 410 | commit-graph 2,968 | gix-commitgraph 1,207 / 907 (read) | not needed |
| Reftable | reftable 1,098 | reftable/ 9,236; backend 2,892 | none | reader 1,000–2,000 (local only) |
| pkt-line, sideband | common 120, capabilities 396 | pkt-line 711; sideband 474 | gix-packetline 2,093 / 1,588 | 300–500 |
| Fetch (v2) | v2 904 | fetch-pack 2,354; connect 1,554 | gix-protocol 3,847 / 2,911 | 1,000–2,000 |
| Negotiation | pack 727 | negotiator/ 541 | gix-negotiate 518 / 407 | inside fetch |
| Push (v0) | pack 727, capabilities 396 | send-pack 782 + 357; transport 1,784 | none | 800–1,500 |
| Fetch (v0) | pack 727 | fetch-pack (shared) | gix-protocol (shared) | 1,000–2,000 (later) |
| Smart HTTP | http 544 | remote-curl 1,668; http 3,092 | gix-transport 5,713 / 4,577 (over curl/reqwest) | 500–1,000 |
| SSH | pack 727 (SSH section) | connect.c (shared) | ssh 659 (spawns `ssh`) | 300–500 spawning `ssh` |
| Credentials | credential 294, gitcredentials 335 | credential 710; store/cache 783 | gix-credentials 1,230 / 973 (runs `git credential`) | 400–800 |

For scale: the gitoxide crates the bridge's subjects map to (object, hash,
pack, odb, ref, commitgraph, packetline, protocol, transport, negotiate,
credentials, url) total about 48,400 lines of `src` Rust. **The author's
estimate for a minimal cst bridge (the next section) is 7,000–14,000 lines of
Rust plus tests**, because it skips the local formats, v0 fetch, SSH, shallow,
partial clone and delta search, and leans on `rustls`/`ureq` for the network.
That figure is a judgment, not a measurement, and the test corpus (interop
against stock Git and GitHub, malformed-input fuzzing) is likely to be as large
as the code.

## Ordering

### Minimal bridge: fetch and push to GitHub over HTTPS

In dependency order:

1. **Object encoding with exact preservation and SHA-1 with collision
   detection.** Every later step produces or consumes object IDs. This is also
   the "Bridgeable from the start" obligation on N1/N2: the native store must
   keep what the IDs depend on.
2. **Pack decode** (inflate, OFS/REF deltas, trailer checksum) into the native
   store, with size budgets for untrusted input. Do not request `thin-pack`
   at first.
3. **pkt-line and `side-band-64k`.**
4. **Smart HTTP over `rustls` + `ureq`**, with Basic authentication from a
   token (environment or cst's own store) and the credential-helper protocol
   resolving `git-credential-<name>` on `PATH`.
5. **Protocol v2 `ls-refs` and `fetch`**, with a simple consecutive
   negotiator; no shallow, no filter. GitHub advertises v2 (`fetch=shallow
   wait-for-done filter`), so v0 fetch is not needed for GitHub.
6. **Push over v0 `receive-pack`**: ref advertisement, update commands,
   a pack of whole objects (deltas optional), `report-status`,
   `side-band-64k`, and `atomic` (cst pushes with `--atomic` today, and its
   records travel as refs and notes refs, which need nothing beyond ordinary
   ref updates).

### Later, roughly by value

- Delta compression and thin packs on push (bandwidth for large repositories).
- `thin-pack` on fetch (requires thickening against the native store).
- SSH, first by spawning the system `ssh`.
- Local formats for importing a local Git repository without the network:
  loose objects, packs + `.idx`, loose and packed refs; then a reftable reader
  once Git 3.0's default reaches users.
- v0 fetch negotiation (`multi_ack_detailed`, stateless RPC) for servers
  without v2.
- Shallow and partial clone (`deepen*`, `filter`), `include-tag`.
- SHA-256, once a target forge hosts SHA-256 repositories.
- Push options, push certificates, proxies, `http.*` and `url.*.insteadOf`
  configuration compatibility.
- Writing local Git repositories for Git users (`.idx`, refs, commit-graph,
  reftable writer), only if the bridge's ADR decides cst maintains on-disk Git
  repositories rather than speaking only the wire.

## Findings for the map

- The minimal bridge is a *wire* client, not a Git repository implementation.
  Loose objects, `.idx`, the commit-graph and reftable are local formats; the
  bridge needs them only if cst imports local Git repositories without the
  network or keeps a `.git` directory for Git users. That choice belongs to
  N1's import ADR and N6's bridge ADR, and it decides whether reftable
  (9,236 lines of C in Git, nothing in gitoxide) is in scope at all.
- Push has no reference implementation in gitoxide, and protocol v2 has no
  push in Git either: every Git push is a v0 `receive-pack` exchange. cst's
  current push depends on the `git` executable alone.
- The exact-round-trip requirement is cheapest in the object encoding, and it
  is an N1/N2 store obligation, not N6 code: keep each bridged object's bytes
  or a provably lossless decomposition.
- Primitives are available and established: `sha1-checked`, `sha2`,
  `crc32fast`, `zlib-rs` (three already in the lockfile), `rustls` with
  `rustls-platform-verifier`, `ureq`; for SSH, the system `ssh` or `russh`.
- Credential helpers assume a `git` binary (`credential.helper=manager` runs
  `git credential-manager`; `store` and `cache` are Git built-ins), so a
  Git-free cst must resolve helpers itself and reimplement `store`.
