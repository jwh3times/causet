# Identity and objects

The first half of the [native store contract](README.md). It defines how a
native object is named, how every N1 object type is encoded, the states an
object can be in, the alias map that ties native objects to Git's, and the
`.cst/` directory that marks a native repository. Its decisions come from
[ADR-0045](../adr/0045-build-n1-as-a-whole-content-store-with-lossless-git-import.md)
decisions 2, 4, 5, 8, 9 and 12. Format version 0 promises no compatibility
([README](README.md)).

The worked examples form one small history: a file `hello.txt` holding
`hello\n`, committed once on `main` in a SHA-1 repository. Every ID below can
be checked with `sha256sum`, and every Git ID with `git hash-object`. The tree
that is not canonical (§5) needs `git hash-object --literally`, because Git
refuses to create it otherwise.

## 1. IDs

### 1.1 Native IDs

A **native ID** names one object. In binary it is 33 bytes:

| Field | Size | Value |
| --- | --- | --- |
| algorithm | `u8` | `01`: SHA-256 |
| digest | 32 | SHA-256 of the object's identity input (§2) |

- **The algorithm tag** lets the hash change later without ambiguity
  (decision 4). `00` and `02`–`ff` are reserved. A reader refuses a tag it does
  not know.
- **The text form** is the 64 lowercase hex digits of the digest, with no tag
  ([ADR-0046](../adr/0046-give-a-native-repository-gits-everyday-verbs-and-cst-s-own-commands.md),
  decision 5). The tag stays in the binary encodings.
- **Every ID covers the whole object.** Chunking, compression and containers
  never change an ID.

### 1.2 Git IDs

A **Git ID** appears where a native object must name a Git object: in the
alias map, and in a submodule link (§4). In binary:

| Field | Size | Value |
| --- | --- | --- |
| Git algorithm | `u8` | `01`: SHA-1; `02`: SHA-256 |
| digest | 20 or 32 | the Git object ID, 20 bytes for SHA-1 and 32 for SHA-256 |

The other Git algorithm codes are reserved, and a reader refuses them.

## 2. Identity input

An object's **identity input** is the byte string its digest is computed over:

```
"cst" (63 73 74)   type (u8)   body
```

| Type | Object | Section |
| --- | --- | --- |
| `01` | content, which is also every chunk | §3 |
| `02` | tree | §4 |
| `03` | preserved Git object | §5 |
| `04` | ref snapshot | §6 |
| `05` | annotation | §7 |

- **Codes `00` and `06`–`ff` are reserved.** A reader refuses an object of a
  type it does not know, because the store came from a build that writes a
  format it cannot read. Annotations (§7) are the extension point that a reader
  may ignore.
- **A body's encoding never changes within a type.** A new encoding of an
  object takes a new type code.
- **The prefix is not stored.** A store keeps an object's body, and the
  container index records its type and stored form beside it (the second
  half). A reader rebuilds the identity input to verify the body. The index
  entry is also how a reader learns an object's type without reading it, for
  example to check a tree entry's target while that target is absent.
- **Domain separation.** The type code keeps a tree from ever having the ID of
  a content object with the same bytes.
- **No Git shape.** Git hashes `<type> <size>` and a NUL before the content.
  This input has no size, and its prefix is cst's own (ADR-0045 rejects a native
  ID equal to Git's SHA-256 blob ID).

## 3. Content and chunks

### 3.1 Content

A **content object** is a file's bytes, or a symbolic link's target. Its body
is those bytes, exactly. It has no name, mode or size field, because those
belong to the tree that names it.

| Example | Identity input | Native ID |
| --- | --- | --- |
| empty content | `63737401` | `47db763a1ed5dfde5b8218a3ee71dcdd2eed02f49702781ab7ea1927b053060a` |
| `hello\n` | `6373740168656c6c6f0a` | `c32f27e6a5e1d06a6c75540b1410f868f228ace6b7dcc3b3f1834c6dce1b1988` |

```sh
printf 'cst\001hello\n' | sha256sum
# c32f27e6a5e1d06a6c75540b1410f868f228ace6b7dcc3b3f1834c6dce1b1988  -
```

`hello\n` is the Git blob `ce013625030ba8dba906f756967f9e9ca394464a` in a SHA-1
repository.

### 3.2 Chunks

A **chunk** is a run of a content object's bytes, cut by the
[chunker](storage.md#2-the-chunker). **A chunk is identified exactly as a
content object of its bytes**, with type `01`. So:

- a file that is one chunk has one ID, both as content and as chunk;
- a chunk that equals a whole file elsewhere is stored once;
- every chunk still has its own SHA-256, so a chunk fetched alone can be
  verified alone (decision 4).

### 3.3 Chunk lists

A content object the store keeps in pieces is stored as a **chunk list**. A
chunk list is a stored form, not an object: it has no ID of its own and is kept
under the ID of the content it lists. The container index says whether a
content object is stored as its bytes or as a chunk list. Its encoding:

```
chunker  u8       how the content was cut: 01, cst's FastCDC (the second half)
seed     u64      the chunker's seed: 0, no seed
size     varint   the content's length in bytes
count    varint   the number of chunks, at least 2
count × (
  id     33 B     the chunk's native ID
  length varint   the chunk's length in bytes
)
```

- **The rules:** every length is at least 1 and less than `size`, and the
  lengths sum to `size`. The same chunk may appear more than once, as in
  `abcabc` cut into `abc` and `abc`.
- **The chunker and seed** record how the cuts were made, so that a writer
  storing the next version can cut it the same way and share its chunks. A
  reader never re-cuts, so it needs neither to read the content. Chunker `00`
  and `02`–`ff` are reserved, and so is every seed but 0, for N5's acceptance
  points (ADR-0045, decision 6). Version 0 writes chunker `01` and seed 0, and
  anything else is corrupt.
- **The content is the chunks concatenated in order.** It must hash to the
  content ID the list is stored under.
- **Byte ranges.** The lengths let a reader find the chunks that hold a byte
  range without reading the others.
- **Resolution terminates.** A chunk's own ID may itself be stored as a chunk
  list, when its bytes equal a content object stored in pieces. A reader then
  resolves it the same way. Each element is strictly shorter than its list, so
  resolution always ends.
- **When content is stored as a chunk list** is decided by the
  [stored forms](storage.md#1-stored-forms), along with the chunker and the
  delta form. Under version 0's chunker, a chunk is never itself stored as a
  chunk list, but a reader must not assume so. A chunk is never stored as a
  delta either, and that a reader checks: a chunk list naming content stored
  as a delta is corrupt (storage.md §5.2).

Worked example, for illustration only (the real chunker never cuts a file this
small): `hello\n` stored as `hel` and `lo\n`.

| Chunk | Native ID |
| --- | --- |
| `hel` | `a77ca2722fdec8942eb8d8f2440b5dbe6dc40a52625103a896356aa1c169e639` |
| `lo\n` | `36b41755fab71e5114ddd9a148ea92e47e16c5d5c68c7a725e70d8e1b2a6b80f` |

```
01                                                                  chunker: cst's FastCDC
0000000000000000                                                    seed 0
06                                                                  size 6
02                                                                  count 2
01a77ca2722fdec8942eb8d8f2440b5dbe6dc40a52625103a896356aa1c169e639  "hel"
03                                                                  length 3
0136b41755fab71e5114ddd9a148ea92e47e16c5d5c68c7a725e70d8e1b2a6b80f  "lo\n"
03                                                                  length 3
```

It is stored under `c32f27e6…1988`, the ID of `hello\n`.

## 4. Trees

### 4.1 Encoding

A **tree** lists named entries. Its body:

```
count    varint   the number of entries
count × (
  name   bytes    the entry's name
  kind   u8       what the entry is
  target          what it names: a native ID, or a Git ID for kind 05
)
```

| Kind | Entry | Target | Git mode |
| --- | --- | --- | --- |
| `01` | file | native ID of content | `100644` |
| `02` | executable file | native ID of content | `100755` |
| `03` | symbolic link | native ID of content: the link's target | `120000` |
| `04` | tree | native ID of a tree, or of a preserved Git tree (§5) | `40000` |
| `05` | submodule link | Git ID (§1.2) of a commit in another repository | `160000` |

The other kind codes are reserved.

**The rules:**

- Entries are in byte order of their names, with no two names equal.
- A name is not empty, contains neither `00` nor `/`, and is neither `.` nor
  `..`.
- A target of kind `01`–`03` is a content object, and a target of kind `04` is
  a tree or a preserved Git tree.
- **One Git algorithm at most.** Every kind `05` target, and every preserved
  tree reached through kind `04` entries, has the same Git algorithm. That is
  the tree's Git algorithm, and its Git encoding (§4.2) exists only in it. A
  tree that names neither has no Git algorithm of its own, and its Git encoding
  exists in each.

The empty tree:

```
00                                                                  count 0
```

Its identity input is `6373740200`, and its ID is
`da296d2ac403c5b842b5ad9b5a423dc035e0f13bdfe464b6108e18f1ca6c78f1`. It is the
Git tree `4b825dc642cb6eb9a060e54bf8d69288fbee4904`.

The tree holding `hello.txt` (45 bytes):

```
01                                                                  count 1
0968656c6c6f2e747874                                                name "hello.txt"
01                                                                  kind: file
01c32f27e6a5e1d06a6c75540b1410f868f228ace6b7dcc3b3f1834c6dce1b1988  target: "hello\n"
```

Its ID is `754a90b4c821bcf47f6441bdbed3bfe8eae725f9f72f50beafebf4c2b603680a`.

### 4.2 Git encoding of a tree

The **Git encoding** of a native tree is what the reconstruction check rebuilds
(ADR-0044, item 4). It is a Git tree, in the Git algorithm of the alias file
being checked:

- **One record per entry:** the Git mode of its kind (the table above), a space
  (`20`), the name, a NUL (`00`), and the target's Git ID digest, with no
  algorithm byte:
  - for content, the Git blob ID of its bytes;
  - for a tree, its own Git encoding's ID, recursively;
  - for a preserved Git tree, the ID of its payload (§5);
  - for a submodule link, the Git ID it stores.
- **Git's order:** records sort by name in byte order, where a kind `04` entry
  compares as its name followed by `/`. Every other kind, submodule links
  included, compares as its name alone.

The tree holding `hello.txt` is, in Git's encoding,
`100644 hello.txt` `00` `ce013625030ba8dba906f756967f9e9ca394464a` (as 20
bytes). That is the Git tree `aaa96ced2d9a1c8e72c56b253a0e2fe78393feb7`.

### 4.3 Which Git trees become native trees

Import parses each Git tree into entries, sorts them into native byte order,
and builds a native tree from them. **The Git tree is canonical** when:

- every entry's mode is one of the five Git modes above, exactly as written
  there;
- the sorted entries form a valid native tree (§4.1);
- the Git encoding of that native tree is the Git tree's exact bytes.

Native and Git order differ for ordinary trees. A directory `a` beside a file
`a.b` is `a`, `a.b` in native order, and `a.b`, `a` in Git's, since `a` compares
as `a/`. That tree is still canonical: the third condition checks Git's order.

**A canonical Git tree becomes a native tree.** Any other Git tree is
preserved whole, as a preserved Git object of kind tree (§5). Git accepts some
trees that are not canonical, for example:

- a zero-padded mode, `040000`;
- a mode such as `100664`;
- entries out of Git's order, or with duplicate names;
- a mode that disagrees with its target's type.

Keeping such a tree whole, rather than normalizing it, is what lets it
reconstruct to its original ID (ADR-0041, decision 9). A native tree that names
it uses its preserved ID as a kind `04` target.

## 5. Preserved Git objects

A **preserved Git object** keeps a Git object's exact bytes for the bridge.
Commits and tags are always preserved, and N2 reinterprets them as native
history (decision 2). Trees that are not canonical are preserved too (§4.3).
Its body:

```
Git algorithm   u8      01: SHA-1; 02: SHA-256
Git kind        u8      01: commit; 02: tag; 03: tree
payload                 the rest of the body
```

- **The payload** is the Git object's bytes after Git's header, exactly as
  `git cat-file <kind> <id>` prints them.
- **Its Git ID** is the Git algorithm's hash of `<kind> <size>`, a NUL, and
  the payload. `<kind>` is `commit`, `tag` or `tree`, and `<size>` is the
  payload's length in decimal. That is the encoding the reconstruction check
  rebuilds.
- **The Git algorithm is in the body,** because the payload names other
  objects by Git IDs of that algorithm. Identical payloads from a SHA-1 and a
  SHA-256 repository are therefore different preserved objects.
- **The other kind codes are reserved.** A Git blob is never preserved, because
  it is content (§3).
- **A preserved tree is never canonical.** A kind `03` payload that §4.3 would
  have made a native tree is corrupt, so each Git tree has exactly one native
  form.

### What a preserved object keeps

The reconstruction check needs everything Git's ID depends on (ADR-0045
decision 2; ADR-0041 decision 9). Because the payload is kept byte for byte,
every byte of it is kept, including:

- **every header, in its original order:** `tree`, `parent`, `author`,
  `committer`, `encoding`, `mergetag`, `gpgsig`, `gpgsig-sha256`, and any
  other header, such as `change-id`;
- **for a tag:** `object`, `type`, `tag` and `tagger`, and an inline
  signature after the message;
- **identities and dates as written:** names, emails, timestamps and time-zone
  offsets, including malformed ones that Git accepted;
- **the message:** bytes in any encoding, non-UTF-8 included, with its
  whitespace, its trailing newline or the lack of one;
- **multi-line headers:** signature and `mergetag` continuation lines, with
  their leading spaces;
- **any brokenness Git accepted,** as Git's own SHA-256 transition keeps it,
  for the same reason: the round trip must be exact.

A payload is not parsed in N1, and its validity is Git's to judge. Two more
things are needed besides the payload:

- the object's Git kind and Git algorithm, which the body holds;
- every object the payload names (a tree, parents, a tag's target), each
  imported and itself rebuilt by the check. A submodule link is the exception:
  it names a commit outside the repository.

### Examples

The commit of the example history, as its payload's text:

```
tree aaa96ced2d9a1c8e72c56b253a0e2fe78393feb7
author A U Thor <author@example.com> 1112911993 -0700
committer C O Mitter <committer@example.com> 1112911993 -0700

Add hello
```

Its body is `01 01` (SHA-1, commit) followed by those 173 bytes, 175 bytes in
all. It is the Git commit `2425d53ec1283e808c60bcaea110ba01aca5a887`, and its
native ID is
`1ba8e668bdf6a1eb2a9393f5f658625f1f3ca733b6dc6648df2d62977c32ef96`.

A tree that is not canonical: one entry `sub`, the empty tree, under the
zero-padded mode `040000`. Its body (33 bytes):

```
01                                         Git algorithm: SHA-1
03                                         Git kind: tree
3034303030302073756200                     "040000 sub", NUL
4b825dc642cb6eb9a060e54bf8d69288fbee4904   the empty tree's Git ID
```

As one string, the body is
`010330343030303020737562004b825dc642cb6eb9a060e54bf8d69288fbee4904`. It is
the Git tree `afb19c0150a0f1e01b31820315244a610b2d1026`, and its native ID is
`676df8b76c086c6d81d5c237307e5c9d39425ede8923bacbe34e0e92b78eed09`.

## 6. Ref snapshots

A **ref snapshot** records a repository's refs at one import, verbatim, as
names and what they point to (decision 2). Its body:

```
Git algorithm   u8       the imported repository's: 01 SHA-1; 02 SHA-256
count           varint   the number of entries
count × (
  name          bytes    the ref's full name, such as refs/heads/main
  kind          u8       01: direct; 02: symbolic
  target                 kind 01: a native ID; kind 02: bytes, a ref name
)
```

- **What it holds:** every ref `git for-each-ref` lists in the imported
  repository's main worktree, and that worktree's `HEAD`. That includes
  remote-tracking refs, `refs/replace/*`, `refs/stash`, the main worktree's own
  `refs/bisect/*` and `refs/worktree/*`, and cst's notes and causet refs. These
  are not recorded:
  - pseudorefs such as `FETCH_HEAD` and `ORIG_HEAD`;
  - other worktrees' `HEAD` and per-worktree refs;
  - reflogs.
- **Each ref keeps its own kind.** A ref that is symbolic in the repository,
  such as `refs/remotes/origin/HEAD`, is recorded as symbolic, though
  `for-each-ref` prints the object it resolves to.
- **A direct ref** targets the native ID of the object it pointed to: content,
  a tree, or a preserved Git object. The Git ID comes back through the alias
  file of the snapshot's Git algorithm (§9).
- **A symbolic ref** targets a ref name. That ref need not exist, as with
  `HEAD` on an unborn branch.

**The rules:**

- Entries are in byte order of their names, with no two names equal.
- A name, and a symbolic target, is not empty and contains no `00`.
- A direct target is held by the store, and is a Git-imported object of the
  snapshot's Git algorithm: it has a row in that algorithm's alias file. It is
  present, unless it is content absent by promise or by policy (§8).

The snapshot of the example history (74 bytes):

```
01                                                                  Git algorithm: SHA-1
02                                                                  count 2
0448454144                                                          name "HEAD"
02                                                                  kind: symbolic
0f726566732f68656164732f6d61696e                                    target "refs/heads/main"
0f726566732f68656164732f6d61696e                                    name "refs/heads/main"
01                                                                  kind: direct
011ba8e668bdf6a1eb2a9393f5f658625f1f3ca733b6dc6648df2d62977c32ef96  target: the commit
```

Its ID is `78c68444e6ea2ca3d6da20db3e36bdf71ff3da61a55a3c47c5200fbdada776b5`.

## 7. Annotations

An **annotation** attaches derived data to an object without changing that
object's ID (decision 9). N4's section map is the first planned type. Its body:

```
subject   33 B    the native ID of the annotated object
type      bytes   the annotation type's name
payload           the rest of the body, interpreted by the type
```

- **The type name** is ASCII from `a`–`z`, `0`–`9`, `.` and `-`, starting with
  a letter or digit, at most 64 bytes.
- **An annotation never changes its subject.** The subject's ID does not depend
  on it, and an object may have any number of annotations, or none.
- **Unknown types are ignorable.** A reader that does not know an annotation's
  type does not decode its payload, does not report it as corrupt, and does not
  let it change any answer. It still checks what every type shares: the ID,
  that the subject's tag is known and the subject has an index entry, and that
  the type name is well formed.
- **Any object may be a subject,** including another annotation.
- **Registered types.** None are defined in N1. `section-map` is reserved for
  N4. A type is registered by adding it to this contract.
- **Finding annotations.** How a reader finds the annotations of a subject is
  part of the [container index](storage.md#41-the-index).

An annotation of type `example` on `hello\n`, with the payload `x` (42 bytes):

```
01c32f27e6a5e1d06a6c75540b1410f868f228ace6b7dcc3b3f1834c6dce1b1988  subject: "hello\n"
076578616d706c65                                                    type "example"
78                                                                  payload "x"
```

Its ID is `dc1e9fcb5149da8887cbc87733281a38cfee0a1cb79a288ecd9b45635f403bea`.
No build knows the type `example`, so every reader ignores it.

## 8. Object states

Every clone holds all metadata, and content may be absent (decision 8).

- **Metadata** is trees, preserved Git objects, ref snapshots and annotations
  (types `02`–`05`).
- **Content** is type `01`, chunk lists included.

An ID is **known** to a store when a present object, a stored chunk list or a
stored delta (as its base) names it, the current ref snapshot names it, or an alias file lists it. A Git
ID in a submodule link is not a native ID, and is never known. A known ID is in exactly one
state:

| Code | State | Meaning | Who writes it |
| --- | --- | --- | --- |
| `00` | present | The store holds its bytes, and they hash to its ID. | import |
| `01` | absent by promise | A remote is expected to supply it on request. | reserved for a partial clone |
| `02` | absent by policy | It is withheld from this clone by read permissions. | reserved for N5 |

The container index records each object's state by these codes. The second
half defines where they sit.

### Telling an absent object from corruption

- **Present** needs an index entry with a location, and bytes there that decode
  and hash to the ID.
- **Absent by promise** and **absent by policy** need an index entry carrying
  that state. A read reports the state by name. It is not an error of the
  store, and it is not corruption. A chunked content object whose list is
  present can still be read in the byte ranges of its present chunks.
- **Only content may be absent.** A tree, preserved object, snapshot or
  annotation in either absent state is corrupt.

**Everything else is corrupt:**

- a known ID with no index entry;
- bytes that do not hash to their ID, or that break the rules of their type;
- a chunk list whose lengths do not add up, or whose chunks do not hash to the
  content's ID.

`cst fsck` reports each absent object by its state, and each case of
corruption by the object and the container it is in. In N1 nothing is ever
absent: import writes every object, and no transport exists. The states are in the format now so that lazy fetch and read
permissions need no change to it later.

## 9. The alias map

The **alias map** is two-way: it maps (Git algorithm, Git ID) to native ID,
and back (decision 5). It covers every imported Git object, which is every
object reachable from what Git's `--all` starts from, and no other: the refs
the snapshot records (§6), and other worktrees' `HEAD`, which it does not
record. What only another worktree's own refs reach, such as its
`refs/worktree/*`, is not imported: `--all` does not start from them, and
`git fsck` counts it unreachable. An object the alias map holds is present and valid
whether or not the snapshot reaches it; verification must not report it as
corrupt. An unreachable object in the Git repository is not imported. The map has a row
for each object:

- each blob, to its content;
- each canonical tree, to its native tree;
- each commit, tag and other tree, to its preserved object.

**Within one Git algorithm it is one-to-one.** Equal native objects come from
equal Git objects, so no two rows share a Git ID, and no two share a native ID.
A repeated key in either direction is corrupt.

### 9.1 Alias files

The map is one **alias file per Git algorithm**: `.cst/aliases/sha1` and
`.cst/aliases/sha256`. An N1 import writes one, the file of the imported
repository's algorithm. Each file is two sorted tables over the same rows:

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 8 | magic `CSTALIAS` (`435354414c494153`) |
| 8 | 1 | file version, `00` |
| 9 | 1 | Git algorithm: `01` SHA-1 (G = 20); `02` SHA-256 (G = 32) |
| 10 | 1 | native algorithm: `01` SHA-256 |
| 11 | 1 | reserved, `00` |
| 12 | 4 | row count N, `u32` |
| 16 | 1024 | Git fan-out: 256 × `u32` |
| 1040 | N × (G + 32) | rows by Git ID: Git digest, then native digest |
| … | 1024 | native fan-out: 256 × `u32` |
| … | N × 4 | the native order: row numbers as `u32` |
| … | 32 | trailer: SHA-256 of every byte before it |

- **The rows** are in byte order of Git digest. Entry `i` of the Git fan-out is
  the number of rows whose Git digest's first byte is at most `i`, so entry 255
  is N. A Git ID is found by a binary search within its fan-out bucket.
- **The native order** lists every row number from 0 to N − 1 once, in byte
  order of the rows' native digests. The native fan-out counts them by the
  native digest's first byte in the same way. A native ID is found by a binary
  search over this order. This is the direction a native repository uses to
  print an optional `gitId` (ADR-0046, decision 5).
- **Digests carry no tags in the file,** since the header names both
  algorithms.
- **What a row costs.** A row takes G + 32 + 4 bytes: 56 for SHA-1 and 68 for
  SHA-256. The file can be rewritten whole on each import, so a fresh import
  of the same history writes the same bytes (decision 3).

A reader checks the magic, version, algorithms, trailer, fan-outs and both
orders, and reports any disagreement as corruption.

The alias file of the example history (SHA-1, 3 rows, 2,264 bytes):

| Row | Git ID | Native ID |
| --- | --- | --- |
| 0 | `2425d53ec1283e808c60bcaea110ba01aca5a887` (commit) | `1ba8e668bdf6a1eb2a9393f5f658625f1f3ca733b6dc6648df2d62977c32ef96` |
| 1 | `aaa96ced2d9a1c8e72c56b253a0e2fe78393feb7` (tree) | `754a90b4c821bcf47f6441bdbed3bfe8eae725f9f72f50beafebf4c2b603680a` |
| 2 | `ce013625030ba8dba906f756967f9e9ca394464a` (blob) | `c32f27e6a5e1d06a6c75540b1410f868f228ace6b7dcc3b3f1834c6dce1b1988` |

- **The header** is `435354414c494153 00 01 01 00 00000003`.
- **The Git fan-out** is 0 for entries `00`–`23`, 1 for `24`–`a9`, 2 for
  `aa`–`cd`, and 3 for `ce`–`ff`.
- **The native order** is rows 0, 1, 2, since `1b…` < `75…` < `c3…`. Its
  fan-out is 0 for `00`–`1a`, 1 for `1b`–`74`, 2 for `75`–`c2`, and 3 for
  `c3`–`ff`.
- **The trailer** is
  `62f89a20ce576032d48bb7f8e7ef7679f0ed664be4709f2f48c25049e146ffb9`.

### 9.2 The reconstruction check

The alias map is what the reconstruction check verifies (ADR-0044, item 4).
For every row of every alias file, the check:

1. rebuilds the native object in Git's encoding for that file's algorithm:
   - content as `blob <size>`, a NUL and its bytes;
   - a native tree by §4.2;
   - a preserved object as `<kind> <size>`, a NUL and its payload;
2. hashes it with the Git algorithm;
3. compares the result with the row's Git ID.

Every row must match. In N1, where import is the only writer, every object
the store holds came from Git and must have a row; a phase that writes
objects of its own changes this rule (ADR-0044, item 4). The check shows it
from the store alone:

- each tree and preserved object has a row, and so does all content but the
  chunks of other content (§3.3);
- so does each object a native tree names, and each direct ref of the
  snapshot (§6);
- so does each object a preserved object names where Git's parser follows it:
  a commit's first line, `tree`, and the `parent` lines straight after it; a
  tag's first line, `object`; and a preserved tree's entries other than
  submodule links. Each such ID is read in either case of hex, as Git's
  parser reads it. A later line of those names is not followed, by Git, by
  import, or by `cst cat-file`, which prints it as stored.

SHA-1 is computed as Git computes it, with collision detection: an encoding
that shows a known collision attack fails the check, as Git refuses such an
object. The check reads each object as a reader does, from one present copy;
that every present copy verifies (storage.md §4.2) is the store
verification's, `cst fsck`. The
check only verifies: it never writes a Git repository. `cst import --verify`
runs it (ADR-0046, decision 9).

## 10. The `.cst/` directory

A directory is a **native repository's root** when it holds `.cst/format`.
That file is the root marker ADR-0042's kind detection reads (decision 12).

```
.cst/
  format          the marker
  snapshot        the current ref snapshot's ID
  aliases/sha1    the SHA-1 alias file, when there is one
  aliases/sha256  the SHA-256 alias file, when there is one
  objects/        containers, each with its index ([storage.md](storage.md#4-containers))
```

- **`format`** holds exactly `causet-native-store 0` and a line feed. A reader
  refuses any other content, naming the version it reads. A directory holding
  both `.cst/` and `.git` is refused as ambiguous, since every repository is
  one kind (ADR-0042, decision 1).
- **`snapshot`** holds the current ref snapshot's ID, as 64 lowercase hex
  digits and a line feed. For the example history it is
  `78c68444e6ea2ca3d6da20db3e36bdf71ff3da61a55a3c47c5200fbdada776b5`.
- **The commit point.** Import writes its objects and alias files first and
  replaces `snapshot` last. A reader therefore sees one import whole or not at
  all. A `snapshot` naming an object the store does not hold is corrupt.
  - **A new store** is written in `.cst-import/` beside it, which is renamed to
    `.cst/` once whole.
  - **An import into an existing store** writes its container under a name
    readers ignore, then names it by its trailer (storage.md §4). It then
    replaces the alias file, and last `snapshot`, each by writing and syncing
    `<name>.tmp` and renaming it over the file. The alias file it writes keeps
    every row the store had (storage.md §4.2), so it is right for the
    snapshot before as well as after. A file it would write unchanged is left
    as it is.
  - **A reader reads `snapshot` first,** then the alias files, then the list
    of containers. Whatever an import has replaced by then, the reader has
    every row and container its snapshot needs.
  - **An import that fails** before replacing `snapshot` takes back what it
    put in place: the earlier alias file, then its container.
  - **`import.lock`** is created exclusively before an import reads the store
    it adds to, and removed when it ends, so only one import adds at a time.
    It holds the importing process's ID. One left by an import that was
    killed is removed by hand. A reader ignores it.
- **Other names under `.cst/` are reserved** for later parts of the contract
  and later phases. A version 0 reader ignores the names it does not know.
- **`.cst/` holds only the store.** There is no working copy in N1: a native
  repository is written only by import (decision 11).
