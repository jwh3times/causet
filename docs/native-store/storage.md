# Chunking and containers

The second half of the [native store contract](README.md). It defines how
content is cut into chunks, how stored forms are grouped into compressed
frames, how frames go into containers with a trailing index, and when a large
file is stored as a delta. Its decisions come from
[ADR-0045](../adr/0045-build-n1-as-a-whole-content-store-with-lossless-git-import.md)
decisions 6, 7 and 10. The objects, IDs and object states it stores are in
[the first half](objects.md). Format version 0 promises no compatibility
([README](README.md)).

None of this changes an ID. Chunking, frames, containers and deltas are how a
store keeps its objects; every stored form is verified by hashing back to the
object's ID (objects.md §1.1).

## 1. Stored forms

Every object is kept as one **record**, in one of three stored forms:

| Form | Record | Used for |
| --- | --- | --- |
| `00` | the body | every type: for content, its bytes; for types `02`–`05`, the body of objects.md |
| `01` | a chunk list (objects.md §3.3) | content stored in pieces |
| `02` | a delta (§5) | content of a large file, stored against a previous version |

The other form codes are reserved. Only content (type `01`) takes forms `01`
and `02`.

A version 0 writer chooses a content object's form by these rules, in order:

1. **A delta,** when §5 allows one and it is smaller.
2. **Its bytes,** when the content is at most 2 KiB, or when the chunker (§2)
   cuts it as one chunk.
3. **A chunk list** otherwise. Each chunk the store does not hold yet is then
   stored as content of its own, in form `00`.

The rules are part of the format, not a writer's preference: a fresh import
must produce a byte-identical store (ADR-0045, decision 3).

## 2. The chunker

cst's chunker is **FastCDC** (Xia et al., USENIX ATC 2016) as specified here,
with normalization level 2 (ADR-0045, decision 6). This text defines the cut
points. No library does: the `fastcdc` crate's implementations cut differently
from each other, and its constructors take their masks from the crate's own
table. It could reproduce these cut points only through its low-level
`cut_gear` with cst's tables passed in, which would check that glue rather than
give an independent reading, so cst does not use it, even as a test oracle
(#300). The reference vectors (§2.5) were checked instead against a second
implementation written from this text.

### 2.1 Parameters

| Name | Value | Reason |
| --- | --- | --- |
| `MIN` | 2,048 (2 KiB) | No chunk is shorter, except a file's last. Bytes before it are not hashed, which is FastCDC's cut-point skipping. |
| `NORMAL` | 8,192 (8 KiB) | The size normalization aims at. Below it the strict mask applies, above it the loose one. The research measured 8 KiB chunks in grouped frames below Git's aggressive pack. |
| `MAX` | 65,536 (64 KiB) | No chunk is longer. It bounds a chunk-list element and a lazy fetch's smallest unit. |
| `MASK_S` | `0x0000d90f03530000` | 15 bits set: 13 for 8 KiB, plus 2 for level 2 |
| `MASK_L` | `0x0000d90003530000` | 11 bits set: 13 − 2. Its bits are a subset of `MASK_S`'s. |
| seed | none | The chunk list's seed field (objects.md §3.3) is 0. Seeded cutting is reserved for N5's acceptance points. |

Both masks set only bits 16 to 47. A 64-bit gear hash's bit `k` depends on the
last `k + 1` bytes hashed, so every cut decision depends on the last 48 bytes.
That is FastCDC's widened window.

Measured on data of different kinds, these parameters give mean chunks of
8.5–9.5 KiB. Cutting skips the first `MIN` bytes, so the mean is above
`NORMAL`. After a 3-byte insertion into a 4 MB executable, 411 of its 420 cut
points recurred, shifted by the insertion. Both are local measurements, and
informational only.

### 2.2 The gear table

`GEAR` holds 256 values, each a `u64`. Entry `i` is the first 8 bytes,
big-endian, of the SHA-256 of the 16 ASCII bytes `cst fastcdc gear` followed by
the byte `i`:

```sh
# GEAR[0]
printf 'cst fastcdc gear\000' | sha256sum | cut -c1-16
# 1d89f18e12396175
```

The table, in hex, four entries per row, each row labelled with its first
index:

```
  0  1d89f18e12396175 ddc9fdc8a6e6cdae 22b03f19f589663b 5ddbc9107320f682
  4  3fb0a3a659a6ad90 e635904fef46d9ff a1f268bd8afce34a e03549cfdb727f85
  8  724c54c51b6f26f5 9277508393a5681d 79032fa1a340501b 4c43a0f150031c10
 12  750aad9805dd52a8 cd4618cde3bd3f94 1202d429a9c391ee 2046f5b6b3a827fc
 16  3a0b9e31d06debcf 60508a62a0e1bf29 3c42e3ab309f03b3 552ee8ef50c9e3cf
 20  0a950b1c207f8669 cc74954308fc4967 3d788787575c3816 bab26bd03d7bfda6
 24  7875c894911cda1f 0fe2baa344f21ff0 84db2f60f2350c67 527976eaeb6c0670
 28  496d4f13bc99a5ec 9e037562aa9961f6 77a361725f85a66c 9992269f6a32121f
 32  209dc2f6ba48f8fd d6a9fdc431a67f0e f6aefcfaccbf986b 1c5d160e3ff7802b
 36  b81404c5680eed51 620243dc77860c3e 67941490feafbc92 75a60631ddefc5ba
 40  33ecc077808a16ef 36b9302ea4574afe 6c7770bcbf082b6f 6d3a942f85829548
 44  9ed7dc78125b10de 17a40669e6b1dc7a 3e6ced1c3183cf50 301c79db311c7c3a
 48  22daa127e3be295f a53f3cc69dadb646 54320d12c4fc7a2a 5ddf1415ad059014
 52  23ae41fd258ab367 b69d9bd3f0ea3d6a 1b03e9e8f2b0679b e87002bc230c68a3
 56  983ea419862dbb37 ec1926d91e76134a 7f01a57c939d7333 52498e9c436a7119
 60  6accc68615194a2d 23f33d8af18fb786 286dd4517875e2cf 9e8e549cea587a91
 64  2226a20c7be46215 f54e096d2ba68760 b8e805626b5d8ebc dbaac61baa661026
 68  d2e57588f32e0d1e 823ebbb9b1a4469e 8a513197bf39cf0a 9f88e26e5359b2fc
 72  3894214aca2ad446 abdee53efa329563 fc2e0ead7104c5c6 333ad23e59d61310
 76  455c5f256125f1b4 d147ead522a1e732 50bc1bba3c2dc0b1 5a079ede9eac5bb3
 80  189b88eaf2dac6ba 40a3f8b990679a3e 06d91d01898a5a5a 8ed48a40aafaab66
 84  12292f748d144743 8b332dcc18036c5c ab0976a88664994e 9d9dc86cdc7a43d4
 88  aa349f629c735a4e bdf8292b08599440 eb4f9f71299ffb8d e205873c38ba6398
 92  e0fe47b47f43b864 ed8ba500ba04892e a9a98aedf5ace88c e0b7b032e69b6f7f
 96  869b30f39435344f 6efba7916e28e798 322eaa793e30855b 01d5832ad598620b
100  7335efc7e1f5eb89 2b8dfc9b6f44bad2 8000c57ccb68835f 7c8605c5ec05c3ae
104  932e25cea0fef569 6903df3fa3b6acaf f2102940dca5e422 a277625d215ad6bd
108  fba26790a1c5c8f6 c03545def3842f4a 68446d49f829dd1a f521cccbc7bc39d9
112  e842a73db160e699 c3caab0bff36c673 ead756c34f39d2d7 09ab9a91bf26de28
116  024a9f5c927dedf8 d4986cd2a62350d3 508e9654044ed10a 6aca3ee43696c404
120  4326ff6b1d76d8a9 fddc2a06b11f4d89 4d4ac68a6f08d428 5890803fef50493f
124  2f0767ea19cfda3b 9a692be66397aea2 ad078f1e869f05bb da33e8d77e9eb07b
128  4d059ca47316813e 10c6445cc72cb6cc 77c7c615a81b37ec dfa782c286bf2677
132  fa45cdf0ca0f68e8 8121ceeefd78cfbb 80fa771e821f58ea ef96e8d7a54cb775
136  9b67dcbfc5acfda3 b3a1609441ca3f4c 974bcf2b0836fe14 3bbd1b5f7368aa20
140  521c7f3466ef57fa fbd8735ec5837145 fe4eafe248d9aa83 0848254c836acebe
144  4228c077e1765ee5 01dcca310ceebcec f8230a185927af8d b3e5948da5758346
148  1a25e8c60c1c84d8 5a9403255399f142 e9687d53ce29ccb4 66ec9cb64d6df6f2
152  4c804720f6b44f18 7718e90b067adb8f 130ca4cc7fe73cb7 e7ffb21d945e1db4
156  e54a22b5d9079a29 e5e974ca54c7c08d 4073d53d14685bd7 de3c9179a09db448
160  4614b7f72ceea410 6eb8b93a52bf2dfc 3edb99f4527623e4 9b969fcb6c244ff1
164  a9e8add845fa84a1 a6e35b6d4296b819 feb2e347d96fcebe 45af9eb48ba190ab
168  8f91067a031fb396 d9ab83f3fb46d3b3 c0e241d352fb8a80 9a61f6f4a0c4a45c
172  bda43a64be3b68c0 83ea09039df6fabd e444daf5cc6923e6 8a6dbc8f55163c7b
176  31ab9deb6e4fa268 e439f6a8acbf1c1b b0e60de84f58b4fd 5cc1af0cfd04623e
180  bf07d3f073a28db6 347d7e64f7761d73 506846b312bddafb 999931dfc96ba10e
184  328ef718391371f2 1e90a0b0104a911c 20e0d733deb5eef4 5fc80ae9fb9e5545
188  ec1a11879c94b99b 057d9293950ffeec 27935a20370929ae af2e520470d31bd0
192  dd0af96d6d3c24f5 2bb1f3f898f26910 e7ab67378a47785e 7cd4d1222fd86091
196  76ca09a6ad5b7d50 521a2e2e50a684e0 d6507347d15eec6e fb50beb537ee6ec9
200  7d65c56cc675fab3 492c97227e9a9ee1 48e5566c0f1be91c 672ba33b9a23e527
204  2fa567de2d6c23f0 ff4c877cd794d131 4f913c532e1b7a18 5ee5c00f8fc375d3
208  ae3830e2ce2300b9 f63c986b4054cfa2 0c80564e27209df1 5ff92575b2d63ae6
212  59bd1053f1b1c61c 10a46fe719d6fb85 68a804534f9c71e5 133107bd47b56acc
216  746d50d9cc307061 703f25861fe8b106 d8bf4d6ba5bb69ac 3b9a5b7e2d3be137
220  d2dfc757b0221650 6db9204dd0d8c587 db341b4ef7632c6f 2d8621c8b2a73e02
224  21aabbb5b362b266 c6245d05f21aeb64 e155346c3a52cf58 d78359fa449258ce
228  7908bf9d8ec9a8c9 2a702ff0fb674a78 0325c376684ac194 3dc9efb32d31edd8
232  f117607b21f2bbe2 33e749a9b23ad8d7 721cc1db2414e085 a411ccd31bf22e79
236  9235b2ef1dcb3551 05aa6af7b57553b3 143b074c8c3c0950 c9069885adcc710e
240  7ecf1e7663ebfe1e e00463ddf3ba29ee db87b49d5b8e7a6c a2326e69269ad445
244  4e73773c86f0d93d 8783e5d38fbaa473 bc098dc0273a2116 5b5a63c46ff84689
248  f4284c3963738fb3 976771be461eded2 ca6cd4b8593429e5 2c8cdf6196ae19ce
252  19ccf1dfc9647cd5 c7641930e4e87947 bdfb9eccdd12099b 413d4c27ec8bff09
```

### 2.3 Cutting

All arithmetic is on unsigned 64-bit integers, wrapping modulo 2^64. `cut`
returns the length of the chunk that starts at the front of `data`:

```
cut(data):
  n = length(data)
  if n <= MIN: return n
  limit  = min(n, MAX)
  normal = min(limit, NORMAL)
  fp = 0
  i  = MIN
  while i < normal:
    fp = (fp << 1) + GEAR[data[i]]
    i  = i + 1
    if fp & MASK_S == 0: return i
  while i < limit:
    fp = (fp << 1) + GEAR[data[i]]
    i  = i + 1
    if fp & MASK_L == 0: return i
  return limit
```

- **The chunk includes the byte that triggers the cut.** Its length is the
  number of bytes up to and including that byte, so the shortest chunk that
  ends at a cut is `MIN + 1` bytes.
- **A content object is cut from its first byte:** each chunk is `cut` of what
  remains after the chunks before it, until nothing remains.
- **The hash restarts at 0** for every chunk.
- **Input that never meets a mask,** such as a run of zero bytes, is cut every
  `MAX` bytes.

### 2.4 Example

The input is 262,144 bytes: the 8,192 SHA-256 digests of the 19 ASCII bytes
`cst fastcdc example` followed by `k` as a `u32`, for `k` from 0 to 8,191,
concatenated in order. Its SHA-256 is
`81c40deae96f6f8c8faadd70b318d4392516523f2e775c8c213750f65edf4133`. It cuts
into 30 chunks of these lengths:

```
11318 4210 10947 9261 9732 2151 11627 15880 11874 8318
13374 9082 10352 8469 4043 8632 6804 6780 8916 11886
2923 3427 13349 8786 11405 11698 8368 9033 8955 544
```

200,000 zero bytes cut into 65,536, 65,536, 65,536 and 3,392.

### 2.5 Reference vectors

[`chunker-vectors.json`](chunker-vectors.json) is part of this contract. Its
`chunker` and `seed` are the chunk list's fields (objects.md §3.3), `01` and 0.
Each of its `vectors` gives:

- `name`;
- `input`, the generator of the input bytes;
- `length`, the input's length in bytes;
- `sha256`, the input's SHA-256;
- `lengths`, the chunk lengths in order;
- `chunks`, each chunk's ID in text form, which is that of content with the
  same bytes (objects.md §3).

An `input` has a `kind`:

| `kind` | Bytes |
| --- | --- |
| `zeros` | `length` zero bytes |
| `example` | the SHA-256 digests of `cst fastcdc example` followed by `k` as a `u32`, for `k` from 0 to `count − 1`, concatenated in order; §2.4's input has `count` 8,192 |
| `periodic` | `length` bytes, byte `i` being `i mod 251` |
| `insert` | the bytes of `base`, another input, with the bytes `bytes` (hex) inserted before offset `offset` |

The vectors cover:
- inputs at and just past `MIN` and `MAX`, and empty input, which has no chunks;
- both masks: a cut in the first loop and one in the second;
- input that never meets a mask;
- an insertion of 3 bytes into §2.4's input, after which 29 of its 30 chunks
  recur.

`native/store` checks every vector, and checks the gear table and the
parameters against this text.

## 3. Frames

A **frame** is a run of records, compressed together.

- **One class per frame.** Class `00`, metadata, holds records of types
  `02`–`05`. Class `01`, content, holds type `01` records. Every clone holds
  all metadata, and content may be absent (ADR-0045, decision 8), so a clone
  that fetches metadata never needs a content frame. The other class codes are
  reserved.
- **The codec:**
  - `01`, zstd: the records concatenated, compressed as exactly one zstd frame
    (RFC 8878), with nothing before or after it;
  - `00`, stored: the record, uncompressed. In version 0 it holds exactly one
    delta (§5), which is already compressed, and its compressed and
    uncompressed lengths are equal.

  The other codec codes are reserved.
- **A zstd frame** is written at level 19, single-threaded, with the content
  size recorded, no checksum (every record is verified by its ID instead) and
  no dictionary. It is independent of every other frame, so a reader
  decompresses one frame without the rest, from its start.
- **Record order.** Content records go in **version order:** the versions of
  one path, oldest first, are adjacent, so zstd finds what successive versions
  share. Metadata records go in the order of the same walk, import's (§3.2).

### 3.1 Frame bounds

A writer keeps one open zstd frame per class. It adds each record to the open
frame of its class, unless the record would take that frame's uncompressed
size past **4 MiB (4,194,304 bytes)**. It then closes the frame and opens the
next one.

- **A record of more than 4 MiB** gets a zstd frame of its own: the writer
  closes the open frame of its class, writes the record's frame, and opens a
  new frame for the records after it. A large tree or chunk list can be that
  size.
- **A frame under 1 MiB** occurs only as the last frame of its class in a
  container, as the frame closed before a record of more than 4 MiB, or as a
  delta's stored frame.
- **The reason for 4 MiB.** The content-store research of
  [#287](https://github.com/jwh3times/causet/issues/287) put causet's unique
  8 KiB chunks in zstd-19 frames:
  - in 1 MiB frames they took 2.81 MB, against Git's aggressive pack of
    2.84 MB for the same blobs;
  - in 4 MiB frames they took 2.13 MB.

  The storage gate counts every byte the store keeps (ADR-0044, item 2). At
  1 MiB, content alone uses the whole margin before chunk lists and the index
  are added (§6).
- **The cost is a single read's:** it decompresses its frame, which is 4 MiB
  at most unless it holds one larger record. That is about 3 ms at zstd's
  published 1.5 GB/s.

### 3.2 Import's walk

Import orders the records it writes by one walk of the history it imports. The
order therefore depends on the history alone, not on how Git stores it, packed
or loose.

- **The tips** are the objects the direct refs name, in byte order of ref
  name, each once. A symbolic ref adds none: what it names is the target ref's.
  Then come the objects only other worktrees' `HEAD` names, which the snapshot
  does not record (objects.md §6), in byte order of Git ID.
- **The walk** is depth first, from each tip in turn. It leaves each object
  after everything the object names, and reaches each object once:
  - a commit names its parents, in order, as Git parses them, then its tree;
  - a tag names its object;
  - a tree names its entries in their stored order, except those whose mode
    Git does not follow: submodule links, and modes of no file, symbolic
    link or tree.

  A mode is read as Git reads it: one or more octal digits, in an unsigned
  32-bit number that wraps, so `10000000000000000000000000100644` is a file's
  `100644`. A mode Git cannot read, with a sign or no digits, is not followed.

  An object the store holds already is not entered (§4.2).
- **An object's path** is where the walk first reaches it. A tip, a commit's
  tree and a tag's object are at the root, the empty path. A tree's entry is at
  the tree's path, then `/` (unless that is the root) and the entry's name.
- **Metadata records** go in the order the walk leaves their objects, so each
  tree comes after every tree it names. The ref snapshot goes last.
- **Content records** are grouped by their blob's path. The groups go in the
  order the walk leaves the first blob at each path. Within a group, blobs go
  in the order the walk leaves them, so a path's versions are oldest first.
  A content object's new chunks go just before its chunk list, in the order of
  the content.
- **The commit that introduces a version** (§5.1) is the one through whose
  tree the walk first reaches its blob. The path it introduces it at is the
  blob's path. A blob the walk first reaches from a tag of it, or of a tree,
  has no introducing commit.

For example, a history of three commits, each changing `a.txt` and `b.txt`,
stores `a.txt`'s three versions, oldest first, then `b.txt`'s.

## 4. Containers

A **container** is one file holding frames and the index of the records in
them. Its name is `.cst/objects/<hex>.cstc`, where `<hex>` is its trailer, as
64 lowercase hex digits. A reader ignores files under `.cst/objects/` with any
other name, so a writer can write a container under a temporary name and then
rename it. A container named otherwise than by its trailer is corrupt.

| Part | Size | Content |
| --- | --- | --- |
| header | 16 | the magic, version `00`, native algorithm `01` (SHA-256), 6 reserved `00` bytes |
| frames | … | every frame, back to back from offset 16, in the order the writer closed them |
| index | … | §4.1 |
| footer | 72 | the index's offset as `u64`, the index's SHA-256, then the trailer |

- **The magic** is the 8 ASCII bytes `CSTCNTNR`, `435354434e544e52`.
- **Every offset in a container is from the start of the file.**
- **The index's SHA-256** covers the index alone, so a lazy reader that
  fetches only the index can verify it.
- **The trailer** is the SHA-256 of every byte before it. A reader that reads
  the whole container checks it. A reader that reads only some frames
  verifies each record by its ID.
- **Widths.** File offsets and compressed frame lengths are `u64`, so a
  container may pass 4 GiB. Within a frame, offsets and lengths are `u32`, so
  a record or a frame's uncompressed bytes are at most 4 GiB − 1. Import
  refuses content whose chunk list, or a tree whose body, would be larger, and
  names it. A chunk list reaches that size only for a file of about 900 GB.

### 4.1 The index

The index sits at the end of the container, so a container is written in one
pass:

| Part | Size | Content |
| --- | --- | --- |
| magic | 8 | `CSTINDEX`, `435354494e444558` |
| counts | 16 | frames F, objects N and annotations A, each `u32`, then a reserved `u32` of 0 |
| frame table | F × 24 | per frame, in file order: offset `u64`, compressed length `u64`, uncompressed length `u32`, codec `u8`, class `u8`, 2 reserved `00` bytes |
| fan-out | 1024 | 256 × `u32`: entry `i` is the number of objects whose digest's first byte is at most `i` |
| names | N × 32 | the objects' digests, in byte order, each once |
| records | N × 16 | per object, in the order of the names: type `u8`, form `u8`, state `u8`, a reserved `00` byte, frame `u32`, offset `u32`, length `u32` |
| annotations | A × 36 | per annotation object: its subject's digest, then the annotation's own position in the names as `u32`. They are in byte order of subject, then by position. |

The index is therefore 1,048 + 24F + 48N + 36A bytes, and it ends where the
footer begins.

- **Frame** is a position in the frame table, from 0. **Offset and length**
  locate the record in that frame's uncompressed bytes.
- **The state** is objects.md §8's: `00` present, `01` absent by promise, `02`
  absent by policy. An absent object keeps its type, has form `00`, and its
  frame is `ffffffff`, with offset and length 0.
- **The annotation table** is how a reader finds an object's annotations
  (objects.md §7). It lists every type `05` object in the container.
- **What an object costs.** The index takes 48 bytes per object: 32 in the
  names and 16 in the records.

A reader treats any of these as corruption:

- a wrong magic, version or algorithm, or an index whose size or SHA-256 does
  not match;
- frames that leave a gap, overlap, or do not end where the index begins;
- a frame whose bytes are not exactly one zstd frame, for codec `01`, or whose
  lengths differ, for codec `00`;
- a fan-out or an order that does not hold;
- a present record outside its frame, or in a frame of the wrong class;
- a form or state that its type does not take (§1; objects.md §8).

The writer's rules of §1, §3.1 and §5.1 are not checked by readers. A store
that breaks one, say a chunk list for a 1 KiB file, still reads correctly; only
a fresh import compared byte for byte (§7) shows it.

### 4.2 Several containers

A store is every container in `.cst/objects/`. A container never changes once
written.

- **An incremental import**, into a store that exists, adds one container,
  holding only objects the store does not hold present already. An import
  that finds nothing new adds none. It keeps every object and alias row the
  store had, so an object only a deleted or moved ref reached stays.
- **An object may be in more than one container.** Every present copy must
  verify, and its type must agree in every container. A present copy is
  preferred to an absent one, and among present copies any one will do.
- **Within one container,** an object appears once.
- **An object's annotations** are those of every container's annotation
  table.

### 4.3 Container size

A writer closes a container before a frame that would take its frames past
**1 GiB** of compressed bytes. It closes every open frame first, then opens a
new container.

- **A frame of more than 1 GiB,** which only a delta can be, gets a container
  of its own.
- **The reason.** Lazy fetches are by byte range within a container (ADR-0045,
  decision 8), so container size does not set what a fetch moves. It sets how
  many files a store has, and how much one rewrite costs. At 1 GiB, causet and
  git/git are each one container, a 100 GB store is about 100 files, and one
  container's index stays a few megabytes.

## 5. Deltas

A **delta** stores a new version of a large file against its previous version
(ADR-0045, decision 7). It is zstd's patching, as `zstd --patch-from` does it,
with the parameters fixed here. Its record:

```
base   33 B     the native ID of the content it is against
size   varint   the length of the content it produces
data            one zstd frame, compressed with the base's bytes as its prefix
```

- **`data`** is zstd compression of the content with the base's bytes as a
  raw-content prefix, written:
  - at level 15, single-threaded, with long-distance matching;
  - with the content size recorded, no checksum and no dictionary ID;
  - with window log `w`, the smallest value from 20 to 31 for which 2^`w` is at
    least the base's size plus the content's size.

  Level 15, not the 19 of §3's frames: from level 16 zstd's match finders
  reach only about 2^chainLog bytes back, about 30 MB at level 19, so a large
  file's delta loses the base it is for. A 64-byte edit of a 70 MB file
  measured 29.9 MB at level 19 and 7.5 KB at levels 13 to 15 (zstd 1.5.7,
  random data); below 30 MB, level 19's deltas were about 20% smaller.
- **Reading a delta** resolves the base's bytes in full, decompresses `data`
  with them as the prefix, allowing a window log up to 31, and checks that the
  result has `size` bytes and hashes to the content's ID.
- **A delta's frame** is a stored frame (codec `00`) holding that one record,
  because `data` is already compressed. The writer leaves its class's open
  zstd frame open, so content records after the delta can join it.

### 5.1 When a delta is written

A version 0 writer writes a delta when all of these hold:

| Condition | Value | Reason |
| --- | --- | --- |
| the content's size | at least **1 MiB** (1,048,576 bytes) | Below it, version-ordered frames already find what versions share (§3). The deltas were measured on large binaries, where chunks share less: on the `node` executables, a delta kept 9.6% of the new version and chunking about 16% (ADR-0045, Context). |
| the base and content sizes | together at most **2 GiB** (2^31 bytes) | zstd's largest window, window log 31, must cover both. |
| the base | the content the same path held in the **first parent** of the commit that introduced this version | It is the previous version, and the first parent makes it one choice. A version with no such path, or whose base is the same content, gets no delta. Which commit introduces a version that first appears at several paths or commits is fixed by import's walk (§3.2). |
| the base's place | the store holds the base **present** when this version is written, however it holds it: written before it by the same import or held already, as a file's content or as a chunk of other content | A base is written before its delta (§5.2). Import's walk can store a base after a version it is the base of, when the base was first reached at another path; that version then gets no delta. |
| the chain | the base's depth is at most **7**, so the delta's is at most **8** | §5.2 |
| the saving | the delta's record is **strictly smaller** than the chunk list's record plus one zstd frame (§3's parameters) of the chunks the store does not hold yet, each once, in the order of the content | "Whenever that is smaller" (ADR-0045, decision 7), measured the same way on every host. A tie stores the chunks. When the store holds every chunk already, there is no frame, and it counts 0 bytes. |

When a delta is written, the content's new chunks are not stored.

**A form depends on what the store holds,** through the base's place and the
saving. An incremental import may therefore store a version as a delta where a
full import of the same history stores a chunk list, or the reverse, and hold
other chunks; every other object is the same in both ([ADR-0045](../adr/0045-build-n1-as-a-whole-content-store-with-lossless-git-import.md),
amendment of 2026-10-26).

**The path is looked up** in the first parent's tree by its parts, split at
`/`. Each part names an entry of the tree before it: the first entry of that
name in the tree's stored order. Every part but the last must name a tree, and
the last a blob with a file or symbolic link mode, each mode read as §3.2
reads it. Anything else, such as a submodule or a tree there, is no such path.

### 5.2 Depth

A record's **depth** is 0 for bytes and for a chunk list, and one more than
its base's for a delta. **The depth limit is 8.**

- **The reason.** A read of a version at depth `d` decompresses `d` deltas,
  each producing a whole version, after resolving the version at the chain's
  root. At 8, reading a 150 MB executable produces about 1.35 GB at most, under
  a second at zstd's published rate. Git's default depth of 50 suits its small
  objects; for a large file it would mean 50 decompressions per read.
- **Chains end.** A base is written before the delta that names it, and its
  depth is smaller, so a chain never loops.
- **A base must be present** whenever the delta is present. A delta whose base
  is absent, or that is deeper than 8, is corrupt. A base that is present but
  stored as a chunk list naming absent content leaves the delta unverified, not
  corrupt, as such a chunk list is (objects.md §8).
- **A chunk is never a delta.** A chunk is at most 64 KiB, and a delta's content
  at least 1 MiB. A chunk list that names content stored as a delta is corrupt
  (objects.md §3.3), so resolving a delta's base never leads back through the
  delta.

## 6. Costs and the storage gate

ADR-0044 item 2 limits stored bytes to Git's fully packed size. The table
shows what the format spends on causet's history at commit `1680ea7`. These
are local measurements with a throwaway chunker written from §2, and Node's
zstd at level 19. They are informational, never gate evidence.

| Part | Per item | On causet's history |
| --- | --- | --- |
| content: unique chunks, single-chunk files included, in 4 MiB frames | – | 2.79 MB (3,460 reachable blobs; 5,459 unique chunks) |
| chunk lists, compressed in frames | about 35 B per chunk reference before compression | 0.14 MB (1,932 lists; 11,997 references) |
| index | 48 B per object | 0.35 MB for content (7,391 records); 0.17 MB more for 3,623 trees, commits and tags |
| alias map | 56 B per Git object (SHA-1) | 0.40 MB (7,083 reachable objects) |
| trees and preserved commits | compressed in metadata frames | not measured |

This measurement put content in 4 MiB frames at 2.79 MB, where the research
put it at 2.13 MB. The two used different chunkers and orders, and the
difference is not explained.

Git's aggressive pack of the same repository, with its index, reverse index
and bitmap, takes 3.40 MB in all. **On causet's history, this format is
therefore likely to fail the storage gate.** Content is about level with Git's
blobs, 2.13–2.79 MB against 2.84 MB. But the index and the alias map add about
0.9 MB, where Git's index is 0.2 MB. A 32-byte native ID is 12 bytes wider than
Git's, and every chunk is an object of its own.

The levers are format decisions for the owner, not this contract's to take
alone:

- **Share the native digests** between the index and the alias map, so each is
  stored once. That would save 32 bytes per Git object (about 0.23 MB here),
  but the alias map would then depend on container layout, which ADR-0045
  decision 3 keeps it independent of.
- **Larger frames:** 8 MiB or more, outside ADR-0045's 1–4 MiB.
- **Fewer chunk objects:** for example, not chunking contents below some size.
  Storing every blob whole raised content from 2.79 MB to 4.33 MB in the same
  measurement, so any threshold has to be found by measuring.

Whichever is taken, [#309](https://github.com/jwh3times/causet/issues/309)
imports causet and git/git in CI, and its numbers, not these, decide the gate.

### 6.1 The real repositories

`.github/workflows/corpora.yml` now imports the real repositories with this
build and reports both byte counts in each job's summary (docs/testing.md,
"The real repositories"). A local run on a 16-core Linux host, on 2026-10-27,
measured:

| Repository | cst store | `git gc --aggressive` | Gate |
| --- | ---: | ---: | --- |
| causet, at `08c4365` | 3,196,745 B | 3,196,013 B | fails, by 732 bytes |
| git/git, at `v2.56.0` | 226,243,470 B | 113,490,152 B | fails, at 1.99× |
| the large-file corpus | 104,623,402 B | 116,323,992 B | passes, 10% smaller |

On git/git the store's parts against Git's pack, split by object type with
`git verify-pack` on a clone with every ref:

- **content** compresses to about what Git's blobs take, 52.6 MB against
  52.5 MB;
- **trees, preserved commits and tags** take 129.6 MB in metadata frames,
  where Git's trees, commits and tags take 54.3 MB. A native tree names its
  entries by 32-byte native IDs, which do not compress, and no tree is stored
  against another version of itself;
- **per-object metadata**, the container's index (about 29 MB for 610,625
  objects, chunks included) and the alias map (22.9 MB), against 15.4 MB for
  Git's index, reverse index and bitmap.

So the gate's gap on git/git is in metadata, not in content: §6's levers
apply, and trees need one of their own.

## 7. Determinism

A fresh import of the same history must write a byte-identical store
(ADR-0045, decision 3). The rules of §1, §3, §4 and §5 fix every choice,
import's walk (§3.2) included, from the history alone. A fresh import of the
same history therefore writes the same bytes, whatever Git repository holds
it. One more thing must be fixed:

- **zstd's output** at a given level is not part of RFC 8878 and changes
  between zstd releases. The store is byte-identical for one build, whose
  `zstd` crate and libzstd versions are pinned exactly (ADR-0045 Constraints).
  A build with another libzstd may write different frames. Those frames hold
  the same objects and still read correctly, but they fail the byte comparison
  until the store is imported again. A delta's existence (§5.1) compares
  compressed sizes, so it too is fixed only within one build.
