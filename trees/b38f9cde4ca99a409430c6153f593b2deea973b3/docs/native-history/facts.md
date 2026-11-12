# Facts and the fact log

The second half of the [native history contract](README.md), with
[names and operations](operations.md). It defines the fact, the fact-log
entry, how a reader decides which facts it uses, and how import builds both
from cst's records in a Git repository. Its decisions come from
[ADR-0047](../adr/0047-build-n2-as-native-history-with-a-fact-log-and-an-operation-log.md)
decisions 5–8, 11, 13 and 14, and from
[ADR-0030](../adr/0030-define-conflict-policy-for-competing-causal-facts.md) for
disputes. No format compatibility is promised ([README](README.md)).

The examples extend the history of [commits.md](commits.md): a provenance
record on the example commit, replaced by a reviewed copy as
`cst metadata dispose --replace-local` replaces one, with the disposition
that settled it. The [reference vectors](facts-vectors.json) hold every
example whole (§7).

## 1. Object types

| Type | Object | Section |
| --- | --- | --- |
| `08` | fact | §3 |
| `09` | fact-log entry | §4 |

[operations.md §1](operations.md#1-object-type) adds `0a`, the operation.
The store holds all three as metadata objects, as it holds native commits
([commits.md §1](commits.md#1-object-types)): either one absent is corrupt,
and a writer stores them in form `00`. They are not Git objects, and have no
alias row. The shared chain's facts and entries go to every clone from N5
on; the local chain's, and operations, stay in the clone that wrote them
(§3.4).

## 2. Shared parts

### 2.1 An action's actor

An **action's actor** is who did something: who recorded a fact, wrote an
entry or ran an operation. It is
[commits.md §2.2](commits.md#22-actors)'s actor without its role, since an
action has no role to take:

```
actor    bytes            who: UTF-8, not empty
kind     optional u8      01: human; 02: agent
for      optional bytes   who an agent acts for: UTF-8, not empty
```

The rules of commits.md §2.2 hold: `00` and `03`–`ff` are corrupt kinds, an
absent kind is unstated, and `for` is present only with kind agent.

### 2.2 Times

A **time** is when an action happened: a form `00` signature's last two
fields ([commits.md §2.1](commits.md#21-signatures)), under its rules.

```
time     varint   seconds since 1970-01-01T00:00:00Z
offset   i16      the UTC offset, in minutes east of UTC
```

## 3. Facts

### 3.1 Encoding

A **fact** is a claim that arrives after the commits it names (ADR-0047,
decision 5). Its body begins with a state:

```
state     u8                00: a fact; 01: a parked fact
state 00:
  schema    bytes           the record's schema member, exactly
  actor     optional actor  who recorded it: an action's actor (§2.1)
  subject   optional 33 B   the object the record's note is attached to
  names     varint          the number of objects it names
  names ×   33 B            each object the record names, in byte order
  record                    the rest of the body: the record in canonical JSON
state 01:
  reason    u8              §3.3
  place     bytes           where the original held it (§3.3)
  id        optional bytes  the logical ID it carries
  bytes                     the rest of the body, byte for byte
```

A fact of state `00` is a record of one of
[`native/model`'s record families](../schemas/compatibility.md) with
native IDs where Git IDs stand in Git. A **parked fact**, of state `01`, is
what import could not take as a record, or a disputed copy. It is kept for
the bridge, and no reader uses it (ADR-0047, decision 8).

### 3.2 The record

- **`record`** is the record in the canonical JSON profile
  ([`causet.canonical-json/v1`](../canonical-json/README.md)), UTF-8, with no
  line feed after it. It is the record a note holds, member for member, with
  each object ID translated; nothing is added, so a listing's `attachedTo`
  is not in it.
- **Translation.** A string member is an **object ID** when the family's
  published schema gives it the object-ID pattern,
  `^[0-9a-fA-F]{40}$|^[0-9a-fA-F]{64}$`, directly or through its `oid` or
  `oidOrNull` definitions. In a fact it is the text form of the native ID of
  what it names:
  - the native commit or native tag imported from a Git commit or tag, when
    there is one;
  - otherwise the store's object for that Git ID: a tree, content or a
    preserved Git object.

  A reader validates a fact through its Git record (§4.2), so
  `native/model`'s validators serve facts and Git records alike (decision
  5).
- **What is not translated.** Every other member stays as the record holds
  it, though it may look like an ID: a change's identity, including the
  `git:<commit>` form a commit with no `Change-Id` gets
  ([identity contract](../identity/README.md)); a logical ID; a digest, such as
  a disposition's `keptDigest`, a resolution's `signature` or a rebase's
  `planFingerprint`; and a ref name, such as a resolution's `ref`.
- **`schema`** equals the record's `schema` member, a current name or its
  legacy `vcs-lab.` alias.
- **`subject`** is the native form of the object whose note held the record,
  and absent for a record no note holds, such as a disposition.
- **`names`** lists every object ID the record holds and the subject, each
  once. It is what reachability follows (operations.md §5), and readers find
  a fact's objects without parsing its JSON.
- **`actor`** is absent on an imported fact. A record's ID depends on the
  record alone, so two clones that import it, from different notes commits,
  hold the same fact. The entry that adds it says who recorded it (§4). A
  fact recorded natively has an actor.

A record the profile refuses, such as one holding a fraction, cannot be a
fact; import parks it (§3.3).

### 3.3 Parked facts

| Reason | What it holds | `place` | `id` | The bytes |
| --- | --- | --- | --- | --- |
| `01` | a note import cannot read: not content, over the note container bounds, not JSON, or not a `causet.note/v1` container | the attachment's Git ID | absent | the note, whole, or nothing when it is not content |
| `02` | a record import cannot take: of a family or version it does not know, invalid by its schema, outside the canonical profile, or naming an object the store does not hold | the attachment's Git ID | the record's `id`, when it is a string | the record's JSON text, as the note holds it |
| `03` | a repeated copy: a record that gives a fact an earlier record of the same notes tree gave | the attachment's Git ID | the record's `id` | the record's JSON text, as the note holds it |
| `04` | a disputed copy, under `refs/causet/quarantine/` | the ref's name after `refs/causet/quarantine/`: the source lineage, `/`, and the record ID | the record ID in the ref's name | the ref's blob, whole |

`00` and `05`–`ff` are corrupt. The attachment's Git ID is the note's path
with its fan-out removed, in lowercase hex. A record's JSON text is the bytes
of its element of the container's `records` array, from its first byte to
its last. A parked fact is never translated, names nothing, and has no
actor.

### 3.4 Scope

A fact's scope is its family's, as the registry in `native/model` defines it
(ADR-0047, decision 6), and it decides which chain of the fact log records
the fact (§4):

| Facts | Chain |
| --- | --- |
| records of the note-record families, and parked facts of reasons `01`–`03` | **shared**: exchanged with other clones from N5 on |
| dispositions (`causet.disposition/v1`), and parked facts of reason `04` | **local**: the clone's own, never exchanged |

No other family is a fact in N2. The worktree-private journals and forecasts
stay files of their working copy, and workspaces wait for N3.

### 3.5 Example

The provenance record that declares A U Thor the author of the example
commit, imported from its note (417 bytes):

```
00                                                                  state: a fact
146361757365742e70726f76656e616e63652f7631                          schema "causet.provenance/v1"
00                                                                  actor: none
0101d3c30235e65ae09ed09eb0c36e8b171e33b5b318c346beaa8adbdd49e1296565  subject: the example's native commit
01                                                                  names: 1
01d3c30235e65ae09ed09eb0c36e8b171e33b5b318c346beaa8adbdd49e1296565    the example's native commit
7b226163746f7273223a5b…7d                                           the record, 326 bytes
```

The record, whose `commit` held the Git ID `2425d53e…a887`:

```json
{"actors":[{"actor":"A U Thor <author@example.com>","role":"authored"}],"carriedFrom":[],"changeId":null,"commit":"d3c30235e65ae09ed09eb0c36e8b171e33b5b318c346beaa8adbdd49e1296565","createdAt":"2005-04-07T22:13:13.000Z","id":"prov_0e79j2dns3a1b2c3d4e5f","origin":"declared","schema":"causet.provenance/v1","type":"provenance"}
```

Its ID is `bce55fc72f7ff26d687608081068f4b9a8ca558b0fef1dcec89a7d2cf70937e2`.

## 4. The fact log

### 4.1 Entries

The **fact log** is two chains of entries, one per scope (§3.4), each joined
by union (ADR-0047, decision 7). An entry's body:

```
scope      u8               01: shared; 02: local
parents    varint           the number of parent entries
parents ×  33 B             each an entry of the same scope, in byte order
adds       varint           the number of facts it adds
adds ×     33 B             each a fact, in byte order
retires    varint           the number of facts it retires
retires ×  33 B             each a fact, in byte order
actor      optional actor   who wrote it: an action's actor (§2.1)
time       optional time    when (§2.2)
```

A fact is **current** at one or more heads when some entry A that the heads
reach adds it, and no entry that the heads reach retires it with A among its
ancestors. An entry reaches itself and is its own ancestor. So a retire
removes only the adds it has seen, and an add made on a fork concurrent with
the retire survives the join, as an observed-remove set keeps it. A join
never brings back a fact that one side retired and the other merely kept.

Current is not held. The store **holds** every fact an entry has added, and
a retired fact stays held and reachable (operations.md §5); it is only no
longer current.

**The rules:**

- Lists are in byte order with nothing repeated, and every fact an entry adds
  or retires has the entry's scope.
- An entry adds no fact current at its parents, and retires only facts
  current there.
- An entry written natively has an actor and a time, and adds or retires at
  least one fact. An imported entry may have neither, and may change nothing
  (§5.1).

**Why entries retire.** ADR-0047 decision 7 has entries only add. But the
Git-backed reader reads the tip of `refs/notes/causet` alone, and a note can
lose a record: `cst metadata dispose --replace-local` replaces one, and a
duplicated ID is repaired by editing the note. A log that only grew would
keep every replaced record, and disagree with the original about every
dispute it settled. A retired fact stays held and reachable, though no longer
current, so the log still records what a clone learned, and when.

**Why two chains.** ADR-0047 decisions 7, 10 and 11 speak of one chain and
its head. But decision 6 gives each fact its family's scope, and a
clone-local disposition must never travel with the shared facts N5 sends.
In one chain, an entry that names a local fact, or has a local entry among
its ancestors, could not be sent whole. Two chains keep what is exchanged
closed under parents.

### 4.2 Which facts a reader uses

A reader reads the facts current at both chains' heads in the current view
(operations.md §3). A current fact of state `00` is **used** when the
record is valid and its logical ID is not conflicted:

- **Valid** means `native/model`'s validators accept the fact's Git record
  (§6), with its attachment, in the Git algorithm of the import's snapshot,
  as the Git-backed reader runs them over the original's records. They
  check an object ID's length and the kind of object it names, so they read
  Git IDs, never native ones. A check that reads a ref or a retention
  commit, such as a resolution's, reads the snapshot and the objects it
  names.
- **A logical ID is conflicted** when, among the facts current in the
  shared chain, two of state `00` carry it, or one does and a parked fact of
  reason `02` or `03` does; or when a parked fact of reason `04` current in
  the local chain carries it (ADR-0047, decision 7; ADR-0030). Every copy is
  then unused until the dispute is settled. A logical ID is the record's
  `id` member, across the note-record families; dispositions are not
  checked against them.

These are the Git-backed reader's rules, `record-id-conflict` and
`parked-record-conflict`, restated over facts. A parked fact of reason `03`
keeps a record that a notes tree holds twice conflicted, as the Git-backed
reader counts every copy, though both give one fact.

**Dispositions** name records by their **Git digest**: the SHA-256 of the
record and its attachment as `native/model`'s `record_digest` writes it,
with Git IDs. A reader computes a fact's Git digest from its Git record
(§6). A disposition settles nothing by being current; as in Git, settling a
dispute changes the shared chain, and the disposition records what was
decided, so a later import or exchange does not raise it again.

### 4.3 Example

The entry imported from the second notes commit, which replaced the record of
§3.5 by its reviewed copy (149 bytes):

```
01                                                                  scope: shared
01                                                                  parents: 1
0148485d721abf632766e5c4085e6fd4282f2cc9aebee4f3acceb2c7bf1f08fa5e    the first notes commit's entry
01                                                                  adds: 1
01ca02fe39fb7ee0c598c1fa9ce10caf584de19a00ea71568dd2f9f5f3d7da8ed5    the reviewed copy
01                                                                  retires: 1
01bce55fc72f7ff26d687608081068f4b9a8ca558b0fef1dcec89a7d2cf70937e2    the record of §3.5
01                                                                  actor: present
2243204f204d6974746572203c636f6d6d6974746572406578616d706c652e636f6d3e  actor "C O Mitter <committer@example.com>"
00                                                                  kind: unstated
00                                                                  for: none
01                                                                  time: present
c8e2d69204                                                          time 1112912200
fe5c                                                                offset −420
```

Its ID is `39deba682a85f74b9faafec22565ab90c4355eb7493f25d436cf990141a10409`.
At it, the reviewed copy and the parked fact of an unknown version that the
first entry added are current. The record of §3.5 is retired: still held,
and no longer current.

## 5. Import

### 5.1 The notes

Import builds the shared chain from the notes history (ADR-0047, decision 8):

- **The notes ref** is `refs/notes/causet`, or `refs/notes/vcs-lab` in a
  repository that uses the **legacy names**: one whose snapshot holds neither
  `refs/notes/causet` nor a ref under `refs/causet/`, which the Git-backed
  cst refuses until it is migrated. A migrated repository holds both names, and
  import reads only the current ones, as the Git-backed reader does
  (decision 8). When the snapshot has no notes ref, the shared chain is
  empty.
- **One entry per commit** of its history: every commit the notes ref
  reaches through parents, as Git parses them. Its parents are its notes
  commit's parents' entries.
- **Its facts** are the notes commit's tree, read as §5.2 says. The entry
  adds the facts the tree gives that are not current at its parents, and
  retires those current there that the tree does not give. So the facts
  current at each entry are exactly what the Git-backed reader would read
  at that commit.
- **Its actor** comes from the notes commit's committer line, as
  [commits.md §5.2](commits.md#52-deriving-a-native-commit) derives an
  author's actor: no kind, and no actor when that is empty or there is no
  line. **Its time** is the line's time and offset when the line is in form
  `00`, and absent otherwise.
- **The head** of the shared chain is the notes ref's commit's entry.

A notes commit is a carrier commit: it gets an entry, and no native commit
unless a root reaches it too
([commits.md §5.1](commits.md#51-which-commits-and-tags)).

### 5.2 Reading a note

A notes tree is read as the Git-backed reader reads it: a note's path is its
attachment's Git ID, in 2-digit fan-out directories, in either case. Each
note gives facts:

1. **A note that is not a readable container** is one parked fact of reason
   `01`.
2. **Each record** in its `records` array, in order, is a fact when import
   can take it: of a note-record family, in a version this build knows,
   valid by its schema, inside the
   canonical profile, and every object ID it holds, and its attachment,
   naming an object the store holds. Otherwise it is a parked fact of reason
   `02`.
3. **A record that gives a fact an earlier record of the tree gave,** in
   the same text or not, also gives a parked fact of reason `03`, so its
   logical ID stays conflicted. Notes are read in byte order of path, and a
   note's records in order.

A record that is valid by its schema but not by the checks across records,
such as a resolution whose ref is missing, is still a fact: the reader's
validators reject it, as the Git-backed reader's do (§4.2).

### 5.3 Local facts

Import writes the local chain as **one entry with no parents**, no actor and
no time, holding:

- a parked fact of reason `04` for each ref under `refs/causet/quarantine/`,
  or `refs/vcs-lab/quarantine/` with the legacy names (§5.1), whose
  remainder is a source lineage and a record ID. Its bytes
  are the content the ref names, and empty when it names anything else: the
  Git-backed reader parks a record by the ref's name alone. Other refs there
  are snapshot only;
- a fact for each disposition in `causet/dispositions.json` under the
  original's common directory (decision 8), so the copy settles what its
  original settled. A file import cannot read, and a disposition it cannot
  take by §5.2's tests, give nothing: the Git-backed reader reports and
  ignores them, and no reader's answer depends on a disposition (§4.2).

The entry depends on the original's state alone, so an incremental import
writes the same entry as a full one. With no local facts there is no entry,
and the local chain is empty.

### 5.4 What is not imported

- **`workspaces.json`** waits for N3, and `migration.json` is not read: a
  native repository has no migration window, and import reads current and
  legacy names alike (decision 8).
- **Refs that carry no record** give no fact: `refs/causet/retention` and
  `refs/causet/resolutions/*`, whose commits the facts that name them keep
  reachable (operations.md §5), and every other ref under `refs/causet/` and
  `refs/vcs-lab/`. [operations.md §4.1](operations.md#41-which-refs-become-names)
  assigns every ref.
- **Worktree-private records,** under the original's Git directory, are never
  read.

### 5.5 Which commits facts reach

Every commit and Git tag a fact's object IDs name is a root of import's walk
([commits.md §5.1](commits.md#51-which-commits-and-tags)), and so gets a
native commit or tag, except a **resolution's** `resolutionCommit`, which is
also its subject. That commit is a carrier, made only to keep a resolution's
blobs, so it stays a preserved Git object, which the fact names, unless
another root reaches it.

Import therefore reads the records before it derives commits: the object IDs
in the records it can take are roots, and each record is translated once the
roots' native commits exist.

## 6. The bridge

A fact's **Git record** is its record with every object ID translated back
to the Git ID of what it names
([commits.md §7](commits.md#7-the-git-encoding)), and its subject's Git ID is
its attachment. It has the original record's Git digest (§4.2), though not
its note's bytes: the canonical profile reorders members, and the bridge
writes the note container (N6). A parked fact crosses back as its bytes, at
its place. So a fact crosses as its record in a note, IDs translated
(ADR-0047, Constraints).

## 7. Reference vectors

[facts-vectors.json](facts-vectors.json) holds this half's examples whole,
with [operations.md](operations.md)'s. Its `notes` hold the note on the
example commit at each of two notes commits, as cst writes a note. Each entry
of `vectors` has `name`, `object` and `body` in hex, and:

- for an object, its `id`;
- for a fact of state `00`, its `record` as the original holds it, its
  `names` and, for one a note holds, its `attachment` and `gitDigest`;
- for a merged view, the `sides` and `base` operations it merges, and no
  `id`, since a view is part of an operation.

The facts are the record of §3.5, a record of an unknown version beside it in
the first note, parked by reason `02`, the reviewed copy, and the
disposition, whose digests are those of the two copies. The entries are the
two notes commits', each committed by
`C O Mitter <committer@example.com>` at −0700, at 1112912100 and
1112912200, and the local chain's.

## 8. Verification

`cst fsck` checks every fact and entry against these rules. A fresh import
derives them again, byte for byte
([storage.md §7](../native-store/storage.md#7-determinism)). A fact whose record its validators refuse is not corrupt: it is
unused, as a Git record is. Whether a reader uses a fact is never stored; the
derived catalogs that answer it quickly are rebuilt from the log (ADR-0047,
decision 14).
