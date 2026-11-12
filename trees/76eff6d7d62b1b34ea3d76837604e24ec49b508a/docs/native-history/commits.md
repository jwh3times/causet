# Commits, tags and actors

The first half of the [native history contract](README.md). It defines the
native commit and the native tag, the actors they carry, how import derives
them from Git's commits and tags, which commits get one, and what the Git
bridge needs from them. Its decisions come from
[ADR-0047](../adr/0047-build-n2-as-native-history-with-a-fact-log-and-an-operation-log.md)
decisions 1–4, 8, 9 and 11–13, and its Constraints. No format compatibility
is promised ([README](README.md)).

The worked examples extend the
[native store contract's](../native-store/objects.md) example history: a
file `hello.txt` holding `hello\n`, committed once on `main` in a SHA-1
repository, as the Git commit `2425d53ec1283e808c60bcaea110ba01aca5a887`.
Every ID can be checked with `sha256sum`, and every Git ID with
`git hash-object --literally`. The
[reference vectors](history-vectors.json) hold every example whole (§8).

## 1. Object types

Native history adds two object types to the store's identity input
([objects.md §2](../native-store/objects.md#2-identity-input)):

| Type | Object | Section |
| --- | --- | --- |
| `06` | native commit | §3 |
| `07` | native tag | §4 |

- **They are metadata**
  ([objects.md §8](../native-store/objects.md#8-object-states)): every clone
  holds them, and either one absent is corrupt.
- **They share the store's containers, alias map and content-ID rule**
  (ADR-0047, decision 13). A writer stores them in form `00`, their body, and
  import places them as
  [storage.md §3.2](../native-store/storage.md#32-imports-walk) says.
- **They reach the alias map through their preserved object.** They are not
  Git objects, so they have no alias row of their own. An imported one names
  the preserved Git object it was derived from, and that object holds the
  row ([objects.md §9](../native-store/objects.md#9-the-alias-map)).

## 2. Shared parts

### 2.1 Signatures

A **signature** is who made a commit or tag, and when: what Git's `%an`,
`%ae`, `%ad`, `%cn` and `%cd` print (ADR-0047, decision 2). It has one of
three forms:

```
form       u8       00: fields; 01: verbatim; 02: none
form 00:
  name     bytes    the name
  email    bytes    the email, without its angle brackets
  time     varint   seconds since 1970-01-01T00:00:00Z
  offset   i16      the UTC offset, in minutes east of UTC
form 01:
  line     bytes    the identity line's value, exactly
form 02:            nothing
```

**Form `00`** holds an identity line as fields. Its **line** is the name, a
space, `<`, the email, `>`, a space, the time in decimal, a space, and the
offset as a sign, two digits of hours and two of minutes: `-` for a negative
offset and `+` otherwise. In the example,
`A U Thor <author@example.com> 1112911993 -0700`. The rules:

- the name is not empty, and neither begins nor ends with whitespace (`09`
  to `0d`, `20`);
- neither the name nor the email contains `<`, `>`, `0a` or `00`;
- the offset is from −5999 to 5999: at most 99 hours and 59 minutes.

**Form `01`** keeps every other line, byte for byte. Its line contains no
`0a`, and is never one that form `00` writes: such a line is corrupt in form
`01`. So each identity line has exactly one encoding. A line is in form `00`
only when writing its fields back gives the line exactly, and an encoder must
check that, not only that the line parses. Each of these parses into fields
but is form `01`:

- `A U Thor <author@example.com> 0123 +0000`, whose time would be written
  `123`;
- `C O Mitter <committer@example.com> 1112911993 +0060`, whose offset would
  be written `+0100`;
- `C O Mitter <committer@example.com> 1112911993 -0000`, whose offset would
  be written `+0000`.

**Form `02`** is a line that is missing, as on a tag Git wrote before 0.99.

Forms `01` and `02` occur only on an imported object (§3.2, §4.2). A commit or
tag made natively has form `00` signatures.

The name and email are bytes in the commit's encoding (§3), not necessarily
UTF-8. A reader prints them as Git does, re-encoded by the same rules.

### 2.2 Actors

An **actor** is `causet.provenance/v1`'s `{role, actor}` with two optional
members, `kind` and `for` (ADR-0047, decision 3):

```
role     u8                  01: authored; 02: generated
actor    bytes               who: UTF-8, not empty
kind     optional u8         01: human; 02: agent
for      optional bytes      who an agent acts for: UTF-8, not empty
```

In JSON the same actor is
`{"role": "authored", "actor": "…", "kind": "human"}`, with `kind` and `for`
left out when absent, as
[#414](https://github.com/jwh3times/causet/issues/414) adds them to
`causet.provenance/v1`.

**The rules:**

- **Roles.** A commit's or tag's actors are its commit-time claim, so they
  take `authored` and `generated` only. `reviewed` is never one of them: a
  review arrives later, as a provenance fact (decision 3). `00` and `03`–`ff`
  are corrupt here.
- **Kinds.** `00` and `03`–`ff` are corrupt. An absent kind is unstated,
  never a claim of either. Policy may treat it as an unverified human
  (decision 4).
- **`for`** is present only with kind agent (`02`).
- **A list of actors** is a `varint` count and that many actors, at most 64
  (the `provenanceActors` bound), in order of role, then of actor in byte
  order. No two entries share both role and actor.

## 3. Native commits

### 3.1 Encoding

A **native commit** is a point in history (ADR-0047, decisions 1 and 2). Its
body:

```
tree          33 B             a tree, or a preserved Git tree
parents       varint           the number of parents
parents ×     33 B             each a native commit, in order
author        signature        §2.1
committer     signature        §2.1
encoding      optional bytes   the message's encoding, when it names one
actors        actors           §2.2
changeId      optional bytes   the change it records
derivedFrom   optional bytes   the change it was derived from
originCommit  optional bytes   the commit it was derived from
preserved     optional 33 B    the preserved Git commit it was imported from
message                        the rest of the body, byte for byte
```

- **`changeId`, `derivedFrom` and `originCommit`** are the change's identity
  and lineage, as the `Change-Id`, `Derived-From` and `Origin-Commit` trailers
  carry them today ([identity contract](../identity/README.md)). They are
  UTF-8 text, and may be empty. On an imported commit, `originCommit` is the
  trailer's text, usually a Git ID, which no reader trusts unresolved.
- **`preserved`** is present exactly when the commit was imported.
- **The message** is bytes in `encoding` when one is named, and otherwise
  usually UTF-8; it is never re-encoded. It keeps an imported commit's
  trailers verbatim.

### 3.2 Rules

- `tree` is the ID of a tree (type `02`) or of a preserved Git object of Git
  kind tree. Each parent is a native commit. Parents keep their order, and
  repeat when the Git commit repeats them, as Git's parser keeps them.
- `encoding`, when present, is not empty and contains no `0a` or `00`.
- **An imported commit's** `preserved` is a preserved Git object of Git kind
  commit, and its body is exactly what import derives from that object
  (§5.2). Any other body is corrupt, so each Git commit has exactly one
  native commit.
- **A commit made natively** (from N3) has both signatures in form `00`, and
  at least one actor.

The preserved object is what keeps the mapping one-to-one: two Git commits
that differ only in what a native commit has no field for, such as a
signature or an extra header, still have different native commits.

### 3.3 Example

The example commit, as import derives it (193 bytes):

```
01754a90b4c821bcf47f6441bdbed3bfe8eae725f9f72f50beafebf4c2b603680a  tree: the tree holding hello.txt
00                                                                  parents: 0
00                                                                  author: fields
084120552054686f72                                                  name "A U Thor"
12617574686f72406578616d706c652e636f6d                              email "author@example.com"
f9e0d69204                                                          time 1112911993
fe5c                                                                offset −420 (−0700)
00                                                                  committer: fields
0a43204f204d6974746572                                              name "C O Mitter"
15636f6d6d6974746572406578616d706c652e636f6d                        email "committer@example.com"
f9e0d69204                                                          time 1112911993
fe5c                                                                offset −420
00                                                                  encoding: none
01                                                                  actors: 1
01                                                                  role: authored
1d4120552054686f72203c617574686f72406578616d706c652e636f6d3e        actor "A U Thor <author@example.com>"
00                                                                  kind: unstated
00                                                                  for: none
00                                                                  changeId: none
00                                                                  derivedFrom: none
00                                                                  originCommit: none
01011ba8e668bdf6a1eb2a9393f5f658625f1f3ca733b6dc6648df2d62977c32ef96  preserved: the preserved commit
4164642068656c6c6f0a                                                message "Add hello\n"
```

Its ID is `d3c30235e65ae09ed09eb0c36e8b171e33b5b318c346beaa8adbdd49e1296565`.
Its preserved object is `1ba8e668…ef96` of
[objects.md §5](../native-store/objects.md#5-preserved-git-objects).

## 4. Native tags

### 4.1 Encoding

A **native tag** is an annotated tag (ADR-0047, decision 1). Its body:

```
target     33 B            what it tags
name       bytes           the tag's name
tagger     signature       §2.1
actors     actors          §2.2
preserved  optional 33 B   the preserved Git tag it was imported from
message                    the rest of the body, byte for byte
```

The message includes an inline signature after the text, as Git's tag object
holds it. A reader separates the two as Git does.

### 4.2 Rules

- `target` is a native commit, a native tag, a tree, a preserved Git tree, or
  content. It is never a preserved commit or tag: those have native forms.
- **An imported tag's** `preserved` is a preserved Git object of Git kind
  tag, and its body is exactly what import derives from that object (§5.4).
  Any other body is corrupt.
- **A tag made natively** has a name that is not empty, a tagger in form
  `00`, and at least one actor.

### 4.3 Example

An annotated tag `v1` of the example commit, tagged by
`T A Gger <tagger@example.com> 1112912053 -0700` with the message
`Version 1\n`, is the Git tag `094a6f468a87206fa2af59eb3b2392afcd08c2c7`. Its
native tag (150 bytes):

```
01d3c30235e65ae09ed09eb0c36e8b171e33b5b318c346beaa8adbdd49e1296565  target: the example's native commit
027631                                                              name "v1"
00                                                                  tagger: fields
085420412047676572                                                  name "T A Gger"
12746167676572406578616d706c652e636f6d                              email "tagger@example.com"
b5e1d69204                                                          time 1112912053
fe5c                                                                offset −420
01                                                                  actors: 1
01                                                                  role: authored
1d5420412047676572203c746167676572406578616d706c652e636f6d3e        actor "T A Gger <tagger@example.com>"
00                                                                  kind: unstated
00                                                                  for: none
01019e715b7a1cf2941e8fc99f4306ab9115e0af0f0d85041f4a6ce73cbf173f3a00  preserved: the preserved tag
56657273696f6e20310a                                                message "Version 1\n"
```

Its ID is `1d742c3ccb83c886824c7fcf70bfc01719a2c3c2aed3081a56923a50b7d14a67`.

## 5. Import

### 5.1 Which commits and tags

Import derives a native commit for every commit a reader can reach, and a
native tag for every Git tag on the way (ADR-0047, decisions 1 and 9). It
starts from these **roots**:

- every object a direct ref of the snapshot names under `refs/heads/`,
  `refs/tags/` or `refs/remotes/`: the refs that become names;
- every commit and tag a fact names that the store holds. Which record
  fields name an object is the second half's.

From a root, a Git tag leads to its object and a commit to its parents, as
Git parses them (the lines Git follows,
[objects.md §9.2](../native-store/objects.md#92-the-reconstruction-check)).
Every commit reached gets a native commit, and every Git tag reached a native
tag. A tree or content reached is already in the store.

Nothing else is a root, so what only these reach stays a preserved Git object
alone, kept for the bridge and read by no reader of native history:

- **carrier commits:** the history of `refs/notes/causet` and of every other
  ref under `refs/notes/`, and the commits under `refs/causet/` and
  `refs/vcs-lab/`, such as retention carriers and resolution refs. They only
  carry records, which become facts (ADR-0047, decisions 8 and 11);
- `HEAD`, which is not a name, so a detached `HEAD`'s commit gets a native
  commit only when a root reaches it;
- `refs/stash`, `refs/replace/`, `refs/bisect/`, `refs/worktree/` and every
  other ref, and other worktrees' `HEAD`.

Reachability decides, not the ref: a commit a carrier reaches gets a native
commit when a root reaches it too.

### 5.2 Deriving a native commit

Import derives a native commit from its preserved Git commit alone (ADR-0047,
decision 4). Its **header** is the payload up to the first empty line, the
first `0a 0a`; its **message** is everything after it, and is empty when the
payload has none. A **header line** is a line of the header that does not
begin with a space; a line that does is a continuation of the one before.

| Field | Derived from |
| --- | --- |
| tree | the first line, `tree` and a Git ID, read in either case of hex, as Git's parser reads it |
| parents | the `parent` lines straight after it, in order |
| author, committer | the value of the **last** header line beginning `author ` or `committer `, after that word and its space, since Git's `--format` prints the last of repeated lines; form `00` or `01` by §2.1, and `02` when there is no such line |
| encoding | the value of the first header line beginning `encoding `, when there is one |
| actors | one actor, `authored`, with no `kind` or `for`, whose actor is the author's line (the one the author field takes) up to and including its last `>`, or all of it when it has none, decoded as UTF-8 with replacement (§5.3); no actor when that is empty or there is no author line |
| changeId, derivedFrom, originCommit | the lift (§5.3) of `Change-Id`, `Derived-From` and `Origin-Commit` from the message, each absent when the lift finds none |
| preserved | the preserved commit's native ID |
| message | the message, byte for byte |

Each Git ID becomes the native ID of what it names: the tree's native tree or
preserved tree, and each parent's native commit.

- **Nothing outside the Git object is read.** A provenance record, even one
  declared when the commit was made, becomes a provenance fact, never part of
  the commit (decision 4). So a `cst provenance declare` made on the original
  after a first import changes no native commit's ID, and an incremental
  import equals a full one.
- **What import refuses.** A reachable commit whose first line does not name
  a tree, or whose `parent` lines name something other than commits, is one
  Git's `log` cannot read either. Import refuses the repository, naming the
  commit, and writes nothing, as it refuses other sources it cannot copy
  exactly.

The reference vectors include:

- a commit whose author is `<author@example.com> 1112911993 +0000`, with no
  name, and whose committer's offset is `-0000`. Both are in form `01`. Its
  author line gives the actor `<author@example.com>`;
- a commit with two `author` lines, whose author is the second, and whose
  lines parse into fields but are form `01` (§2.1);
- a commit whose author name and message are ISO-8859-1, with
  `encoding ISO-8859-1`. The name and message stay bytes; the actor, decoded
  as UTF-8 with replacement, is `Ren\u{FFFD} Author <rene@example.com>`.

### 5.3 The lift

Import reads a change's identity as Git-backed cst reads it from a commit
object, so a native repository and its Git-backed original agree on every
commit's identity:

1. **Decode** the message as UTF-8, replacing each invalid sequence with
   U+FFFD as the Unicode Standard's recommended practice does (Rust's
   `String::from_utf8_lossy`).
2. **Trim** whitespace from both ends, as ECMAScript's
   `String.prototype.trim` does: its WhiteSpace and LineTerminator
   characters.
3. **Match** the first match of the ECMAScript expression
   `^<name>:\s*(.+?)\s*$`, with the flags `i` and `m`, where `<name>` is
   `Change-Id`, `Derived-From` or `Origin-Commit`. The value is the match's
   group, trimmed as in step 2.

The authority is the engine's text module: `extract_trailer`, which evaluates
the expression as JavaScript backtracks it, over the text `commit_message`
reads through an object session. Without a session, `commit_message` reads
Git's `%B` instead, which Git re-encodes and does not trim, and can lift a
different value
([#429](https://github.com/jwh3times/causet/issues/429)); this contract
follows the session's reading.

Two consequences surprise: `\s*` crosses a line end, so an empty trailer
takes the next line's text, and the name may appear on any line of the
message, not only in its final paragraph. The reference vectors hold cases of
both.

| Message | `changeId` |
| --- | --- |
| `subject\n\nChange-Id: ch_1\n` | `ch_1` |
| `subject\n\nchange-id:ch_2␠␠` | `ch_2` |
| `Change-Id:\nnext line` | `next line` |
| `␠␠Change-Id: ch_3\n` | `ch_3` |
| `x Change-Id: a` | absent |

### 5.4 Deriving a native tag

As for a commit, from the preserved Git tag alone, with the header and
message split the same way:

| Field | Derived from |
| --- | --- |
| target | the first line, `object` and a Git ID: the native form of what it names |
| name | the value of the first header line beginning `tag `, or empty when there is none |
| tagger | the first header line beginning `tagger `, as `for-each-ref` reads it, by §2.1's forms |
| actors | one `authored` actor from the tagger's line, by §5.2's rule for the author's line |
| preserved | the preserved tag's native ID |
| message | the message, byte for byte, an inline signature included |

The `type` line is not read: the target's own type is the store's. A
reachable tag whose first line is not `object` and a Git ID is refused, as
§5.2 refuses a commit.

The reference vectors include a tag Git wrote before 0.99, with no tagger
(form `02`) and an ISO-8859-1 message.

## 6. Naming commits

Where a native repository holds native history, a commit's ID is its native
commit's, and a tag object's is its native tag's: in every command's output
and argument, in names, and in facts. The preserved object is the bridge's,
and no command names it. `--git-id` prints the Git ID its preserved object's
alias row holds (ADR-0046, decision 5). A Git ID given to a command resolves
through the alias map to the preserved object, then to the native commit or
tag imported from it.

## 7. The Git encoding

The **Git encoding** of a native commit or tag is the Git object the bridge
emits for it (ADR-0047, Constraints; ADR-0041, decision 9), as a native
tree's is
([objects.md §4.2](../native-store/objects.md#42-git-encoding-of-a-tree)).

- **An imported one's** is its preserved object's: that payload exactly,
  whose Git ID its alias row holds. The bridge never rebuilds an imported
  commit or tag.
- **One made natively** has its Git encoding derived from its fields:
  - **a commit:** `tree` and the tree's Git ID, a `parent` line for each
    parent's Git ID, `author` and `committer` with their signatures' lines
    (§2.1), `encoding` when there is one, an empty line, and the message;
  - **a tag:** `object` and its target's Git ID, `type` and the target's Git
    kind, `tag` and the name, `tagger` and its signature's line, an empty
    line, and the message.

  Each Git ID is the ID of the named object's Git encoding, recursively.
  Every field a Git commit needs is in the native commit: tree, parents,
  both signatures, encoding and message.
- **The Git algorithm.** A commit's Git encoding exists in a Git algorithm
  when its tree's and every parent's do; a tag's, when its target's does. An
  imported object's exists only in its preserved object's algorithm. A
  commit made natively over objects that fix none, such as a root commit
  over a tree that names no Git object, has a Git encoding in each, as such a
  tree does.
- **Change identity crosses as trailers** (ADR-0047, Constraints). An
  imported message carries them already. How a natively made commit's
  message carries them is N3's, which writes it; if one does not, N6
  publishes how the bridge adds them.

The reference vectors hold a commit made natively by Ada Lovelace with an
agent acting for her, on the example commit, and a tag `v2` she made of it.
The commit's Git encoding is the Git commit
`0e120e67fc807013ca819c4a10c0248c48ff2f8b`:

```
tree aaa96ced2d9a1c8e72c56b253a0e2fe78393feb7
parent 2425d53ec1283e808c60bcaea110ba01aca5a887
author Ada Lovelace <ada@example.com> 1762732800 +0100
committer Ada Lovelace <ada@example.com> 1762732800 +0100

Greet in full

Change-Id: ch_0native
```

Its actors are `authored` `Ada Lovelace <ada@example.com>` of kind human,
and `generated` `claude-opus-5-5` of kind agent for
`Ada Lovelace <ada@example.com>`. They cross as cst's records cross today,
not in the Git object. Its native ID is
`36ed38eb3ac4beb9513896a23becb6a197364390e245514082875e5f041c51fa`.

### 7.1 What native history does not carry

- **Git signatures.** `gpgsig`, `gpgsig-sha256` and `mergetag` headers, and
  every other header without a field, are kept in the preserved bytes only.
  They cross back to Git through the preserved object. A commit made natively
  has none; signing native history is N5's (FR-TRUST-02). A `log`
  placeholder that reads a Git signature, such as `%G?`, has nothing to read
  in native history; how `log` answers it is
  [#417](https://github.com/jwh3times/causet/issues/417)'s.
- **Replacement and grafts.** A native commit's parents are those its Git
  object names. Git's `log` follows `refs/replace/` unless told not to, so
  the equality tests compare with Git's `--no-replace-objects`. Import
  already refuses a repository with grafts.

## 8. Reference vectors

[history-vectors.json](history-vectors.json) holds every example above
whole. Each entry of `vectors` has:

- `name`, and `object`: `native commit` or `native tag`;
- `body` and `id`: the native object's body in hex, and its native ID;
- for an imported one, `gitPayload`, `gitId` and `preservedId`: the Git
  object's payload in hex, its Git ID, and its preserved object's native ID;
  for a commit, `lifted`, its `changeId`, `derivedFrom` and `originCommit`,
  each `null` when absent;
- for one made natively, `gitEncoding` and `gitId`: its Git encoding (§7) in
  hex, and that encoding's Git ID.

`lift` holds messages and the `changeId` the lift gives each, `null` for
none. Every Git ID was checked with `git hash-object --literally`.

## 9. Verification

`cst fsck` checks every native commit and tag against these rules. For an
imported one, it derives the object again from its preserved object and
compares the bytes, so a native commit that disagrees with its Git commit is
reported as corrupt. The reconstruction check rebuilds alias rows, and
native commits and tags have none; it rebuilds their preserved objects.
