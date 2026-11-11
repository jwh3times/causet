# Native history contract

This is the byte-level format of a native repository's history, its facts
and its names: N2
([ADR-0047](../adr/0047-build-n2-as-native-history-with-a-fact-log-and-an-operation-log.md)).
It was published before any history code existed, as ADR-0047 decision 13
requires; `native/history` is built to it. It sits beside the
[native store contract](../native-store/README.md), whose store holds every
object it defines.

**No format compatibility is promised yet**
([ADR-0042](../adr/0042-grow-the-native-system-as-a-shadow-with-one-kind-per-repository.md),
decision 5). A native repository written by an earlier build may have to be
imported again, and these formats may change while N2 is built, at the cost
of a re-import (ADR-0047, Constraints).

## Parts

- [Commits, tags and actors](commits.md): the native commit and the native
  tag, the actors they carry, how import derives them from Git's commits and
  tags, which commits get one, and what the Git bridge needs from them.
- [Facts and the fact log](facts.md): the fact, a thin envelope around one
  of cst's records, the fact-log entry, which facts a reader uses, and how
  import builds them from the notes and disputed copies.
- [Names and operations](operations.md): branches, tags and remote-tracking
  names, conflicted names, the operation log and its 3-way merge, which refs
  import makes names, and reachability.
- Reference vectors: [history-vectors.json](history-vectors.json), native
  commits and tags with their bodies and IDs, the Git objects the imported
  ones derive from, the Git encodings of those made natively, and the trailer
  lift, as [commits.md §8](commits.md#8-reference-vectors) describes them;
  and [facts-vectors.json](facts-vectors.json), facts, entries, operations
  and a merged view, as [facts.md §7](facts.md#7-reference-vectors) describes
  them.

## Authority

Until `native/history` exists, this text is the authority. Once it exists, its
encoders must reproduce every reference vector here byte for byte. When the
code and the text disagree, one of them is fixed in the same change, and a
change to the text says in that change why the code's answer is right. Neither
may drift silently.

## Conventions

The [native store contract's conventions](../native-store/README.md#conventions)
hold here: bytes, `u8` to `u64`, `varint`, `bytes`, byte order, canonical and
corrupt. This contract adds two:

- **`i16`** is a signed 16-bit integer in two's complement, big-endian. For
  example, −420 is `fe5c`, and 60 is `003c`.
- **`optional X`** is a `u8` presence flag, then X when it is `01`: `00` means
  absent, and `01` present. Any other flag is corrupt. For example, an absent
  `optional bytes` is `00`, and the byte string `v1` present is `01 02 7631`.
