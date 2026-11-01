# Native store contract

This is the byte-level format of a native repository's store, the content
store and lossless Git import of N1
([ADR-0045](../adr/0045-build-n1-as-a-whole-content-store-with-lossless-git-import.md)).
It is published before any store code exists, as ADR-0045 decision 10 and the
restated Gate B
([ADR-0041](../adr/0041-make-cst-a-standalone-distributed-version-control-system.md),
decision 10) require.

**No format compatibility is promised yet**
([ADR-0042](../adr/0042-grow-the-native-system-as-a-shadow-with-one-kind-per-repository.md),
decision 5). This is format version 1, which replaced version 0 by
ADR-0045's
[amendment of 2026-10-28](../adr/0045-build-n1-as-a-whole-content-store-with-lossless-git-import.md#amendment-2026-10-28-n1-storage-against-gitgit).
A store written by an earlier build may have to be imported again, and a build
reads only the version it writes, refusing any other by name. The promise
starts when a later ADR makes it.

**Version 1 was published ahead of its code** (see Authority). `native/store`
now writes all of it: version 1's version marks, content under 32 KiB whole,
trees in short references, the 32-byte alias row and metadata in path order.
It reproduces version 1's container header, root marker, short-reference tree
and alias file, and the worked examples version 1 kept from version 0. On version 1
every real repository meets the storage gate with no known-gap entry,
git/git at 0.974 times Git's bytes
([storage.md §6.1](storage.md#61-the-real-repositories),
[#357](https://github.com/jwh3times/causet/issues/357)).

## Parts

- [Identity and objects](objects.md): native IDs, the encoding of every N1
  object type, the three object states, the alias map, and the `.cst/` root
  marker.
- [Chunking and containers](storage.md): FastCDC as cst specifies it, the
  stored forms, compressed frames, containers and their index, deltas, and
  what the format costs against the storage gate.
- [Chunker reference vectors](chunker-vectors.json): inputs with their cut
  points and chunk IDs, described in [storage.md §2.5](storage.md#25-reference-vectors).

## Authority

Until `native/store` exists, this text is the authority. Once it exists, its
encoders must reproduce every worked example here byte for byte. When the code
and the text disagree, one of them is fixed in the same change, and a change to
the text says in that change why the code's answer is right. Neither may drift
silently.

The one exception is a new format version, which this text publishes before
the code writes it (ADR-0045, decision 10). Until the code writes the new
version, it reproduces the previous version's worked examples, as this text's
history holds them, and the issue that builds the version tracks the gap.

## Conventions

These hold in every part of the contract.

- **Bytes** are octets. Hex is lowercase, two digits per byte.
- **`u8`, `u16`, `u32`, `u64`** are unsigned integers of that many bits. The
  wider ones are big-endian.
- **`varint`** is an unsigned integer in LEB128: 7 bits per byte, the least
  significant group first, with the high bit set on every byte but the last.
  - It is **minimal**: the last byte is nonzero unless the value is 0, which is
    the single byte `00`.
  - It fits in 64 bits: at most 10 bytes, and a 10th byte can only be `01`.
  - For example, 0 is `00`, 127 is `7f`, 128 is `80 01`, and 300 is `ac 02`.
- **`bytes`** is a byte string: a `varint` length, then that many bytes.
- **Byte order** compares two byte strings as unsigned bytes, from the first.
  A string that is a prefix of a longer one sorts first.
- **Canonical.** Every object has exactly one valid identity input: minimal
  varints, and where an order is stated, entries in that order with no
  duplicates. Equal objects therefore get equal IDs, which is what makes import
  deterministic (ADR-0045, decision 3). A *stored form*, such as a chunk list,
  is not an object: one object may be stored in several valid forms, all
  verified by hashing back to the one ID.
- **Corrupt** means the store violates this contract. Each part states the
  rules a reader checks. A reader that finds a violation reports the store as
  corrupt, naming the object or file, and never repairs or guesses.
