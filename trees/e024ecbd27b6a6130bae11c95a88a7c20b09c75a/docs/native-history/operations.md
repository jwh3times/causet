# Names and operations

The last part of the [native history contract](README.md). It defines names,
the operation log that moves them, how concurrent operations merge, how
import turns a Git repository's refs into names, and what keeps an object
reachable. Its decisions come from
[ADR-0047](../adr/0047-build-n2-as-native-history-with-a-fact-log-and-an-operation-log.md)
decisions 9–11, 13 and 16. No format compatibility is promised
([README](README.md)).

The examples continue [facts.md](facts.md)'s: the example repository is
imported with a branch `main`, the tag `v1` and a remote-tracking `origin`.
Then Ada Lovelace moves `main` to the commit she made in
[commits.md §7](commits.md#7-the-git-encoding) while an agent acting for her
deletes it, and she chooses her side. The
[reference vectors](facts-vectors.json) hold every example whole (§6).

## 1. Object type

| Type | Object | Section |
| --- | --- | --- |
| `0a` | operation | §3 |

The store holds it as a metadata object, as
[facts.md §1](facts.md#1-object-types) says of facts. An operation belongs
to its clone, and is never exchanged (decision 10).

## 2. Names

### 2.1 What a name is

A **name** is a kind and a name within it, and a value:

| Kind | Code | Example | Written by |
| --- | --- | --- | --- |
| branch | `01` | `main` | `cst branch`, and import |
| tag | `02` | `v1` | `cst tag`, and import |
| remote-tracking | `03` | `origin/main` | import only, until N5 defines remotes |

A branch may be **local**: N5 never sends a local branch unless asked
(decision 9). Only a branch is local.

A name's **value** is resolved, naming one target, or conflicted. A
**target** is what a name names:

- **an object:** a native commit, a native tag, a tree, a preserved Git tree
  or content. It is never a preserved commit or tag, which have native forms;
- **a name,** of any kind, which makes the name **symbolic**, as
  `origin/HEAD` names `origin/main`. The target need not exist, and is one
  step, not where a chain of symbolic names ends;
- **absent:** only inside a conflicted value, for a side that deleted the
  name.

A **conflicted name** is one two operations moved apart: it names every side
until someone chooses (decision 10). Its value is a list of **adds**, the
sides, and one fewer **removes**, the bases they moved from, as jj records
one. `main`, moved from the example commit to Ada's on one side and deleted
on the other, adds Ada's commit and absent, and removes the example commit.

### 2.2 Encoding

A name:

```
kind      u8        01: branch; 02: tag; 03: remote-tracking
name      bytes     the name, without its kind's namespace
local     u8        00: not local; 01: local
count     varint    n, the number of adds, at least 1
adds ×    target    n targets
removes × target    n − 1 targets
```

A target:

```
form      u8        00: absent; 01: an object; 02: a name
form 01:  33 B      the object's native ID
form 02:  kind u8, then name bytes, as above
```

**The rules:**

- A name is not empty and contains no `00`; its bytes need not be UTF-8, as
  a Git ref's need not.
- `local` is `01` only on a branch.
- A **resolved** value has one add, which is not absent. A deleted name is
  not held at all, so a single absent add is corrupt.
- A **conflicted** value has two adds or more and is **simplified**: no
  remove equals an add, and not every add is the same target. One that is
  not is corrupt.

**Simplifying** a value repeats one step while it can: take the first remove
that equals some add, and drop it and the first add equal to it. Then, when
every add left is the same target, the value resolves to it, and to no name
at all when that target is absent.

## 3. Operations

### 3.1 Encoding

An **operation** records one change to a clone's names or facts, with
everything it leaves (decision 10). Its body:

```
parents    varint           the number of parent operations
parents ×  33 B             each an operation, in byte order
actor      optional actor   who ran it: an action's actor (facts.md §2.1)
time       optional time    when it ran (facts.md §2.2)
command    varint           the number of arguments
command ×  bytes            the command's arguments, after the program's name
view                        what it leaves
```

A **view** is every name and the heads of both chains of the fact log:

```
shared     varint, then 33 B ×   the shared chain's heads, in byte order
local      varint, then 33 B ×   the local chain's heads, in byte order
names      varint                the number of names
names ×    name                  §2.2, in order of kind, then of name in byte order
```

**The rules:**

- Lists hold nothing twice. No head is an ancestor of another head of its
  chain, and each is an entry of that chain's scope.
- No two names share a kind and a name.
- An operation has at least one parent, except import's into a new store
  (§4.2).
- An operation that a command runs has an actor and a time. Import's has
  neither, so a fresh import is byte-identical
  ([storage.md §7](../native-store/storage.md#7-determinism)).
- **A body's encoding never changes within a type**
  ([objects.md §2](../native-store/objects.md#2-identity-input)). N3, which
  adds workspaces to the view (decision 10), defines a new type for it.

### 3.2 The operation heads

The clone's current state is held in one directory, `.cst/op-heads/`. It
holds one empty file for each **operation head**, named by the operation's
ID in 64 lowercase hex digits. It is the only mutable thing native history
has. A writer never takes a lock (decision 10):

1. **Write** the operation and every object it names, in a new container
   ([storage.md §4.2](../native-store/storage.md#42-several-containers)).
2. **Add** the operation's head file, created exclusively.
3. **Remove** the head file of each of its parents. One already gone is not
   an error.

Two writers that start from the same head therefore both add theirs, and
neither loses the other's: the clone has two heads until the next operation
merges them. A crash before step 2 leaves objects nothing names. A crash
between 2 and 3 leaves a head that is an ancestor of another, which every
reader skips.

**Reading.** The **current heads** are the clone's heads, less any that is an
ancestor of another. With one, its view is the **current view**. With
several, the current view is their merge (§3.3), which a reader computes
without writing anything. The next operation has all of them as parents, and
its view is that merge with its own change.

This differs from ADR-0047's words, "the one mutable pointer: the current
operation". A pointer replaced by renaming loses one of two concurrent
writes: each writer reads the same operation, and the second rename wins.
A set of heads is jj's answer to the same problem, and keeps every write an
addition but for removing a head that another operation has superseded.

Other names under `.cst/` stay reserved
([objects.md §10](../native-store/objects.md#10-the-cst-directory)).

### 3.3 Merging concurrent operations

The **merge** of several operations, the **sides**, is a view:

- **The base** is the sides' latest common ancestors: the operations that
  are ancestors of every side, an operation counting as its own ancestor,
  and that are not ancestors of another such operation. With one, its view
  is the base. With none, the base is the empty view. With several, the
  base is their merge, by this rule, which ends because each step merges
  older operations.
- **Each name** is merged 3-way. Order the sides by byte order of their IDs,
  and take each name's value on each side and in the base, a missing name
  being one absent add. The merged value's adds are the first side's adds,
  then for each later side its adds and the base's removes. Its removes are
  the first side's removes, then for each later side its removes and the
  base's adds. That value is then simplified (§2.2), and a name that resolves
  to absent is left out.
- **A branch's local mark** is the base's, `00` when the base has no such
  branch, unless a side that holds the branch marks it otherwise; then it is
  that side's. A mark has two values, so every side that differs from the
  base agrees.
- **The fact log's heads** are the union of every side's, for each chain,
  less any that is an ancestor of another. Facts are never merged 3-way:
  their log is joined by union (facts.md §4.1).

So a name only one side moved takes that move, one both sides moved to the
same target takes it, and one they moved apart is conflicted. A later
operation resolves it by setting a resolved value.

### 3.4 Example

The operation import writes into a new store (240 bytes):

```
00                                                                  parents: 0
00                                                                  actor: none
00                                                                  time: none
01                                                                  command: 1
06696d706f7274                                                      "import"
01                                                                  shared heads: 1
0139deba682a85f74b9faafec22565ab90c4355eb7493f25d436cf990141a10409    the second notes commit's entry
01                                                                  local heads: 1
014ffcff81a6811eedbb80b62aef35a11eed15b5c8f5109c13f4bfc01f6c947a90    the local entry
04                                                                  names: 4
01 046d61696e 00                                                    branch "main", not local
01                                                                  adds: 1
01 01d3c30235e65ae09ed09eb0c36e8b171e33b5b318c346beaa8adbdd49e1296565  the example's native commit
02 027631 00                                                        tag "v1"
01                                                                  adds: 1
01 011d742c3ccb83c886824c7fcf70bfc01719a2c3c2aed3081a56923a50b7d14a67  the native tag
03 0b6f726967696e2f48454144 00                                      remote-tracking "origin/HEAD"
01                                                                  adds: 1
02 03 0b6f726967696e2f6d61696e                                      the name: remote-tracking "origin/main"
03 0b6f726967696e2f6d61696e 00                                      remote-tracking "origin/main"
01                                                                  adds: 1
01 01d3c30235e65ae09ed09eb0c36e8b171e33b5b318c346beaa8adbdd49e1296565  the example's native commit
```

Its ID is `f49d099ac0f5e00492724c8609ce1b5d955ee94233509392a943700322555726`.

Two operations follow it at once. Ada's, `666ae48c…b0b5`, moves `main` to
her commit. The agent's, `49a1a11f…f547`, deletes `main`. Their base is the
import's operation, and their merge holds `main` conflicted:

```
01 046d61696e 00                                                    branch "main", not local
02                                                                  adds: 2
00                                                                  absent: the agent's side, first by ID
01 0136ed38eb3ac4beb9513896a23becb6a197364390e245514082875e5f041c51fa  Ada's commit: her side
01 01d3c30235e65ae09ed09eb0c36e8b171e33b5b318c346beaa8adbdd49e1296565  removes: the example commit, the base
```

Every other name, which neither side moved, is as the import left it. Ada
then chooses her side, in an operation whose parents are both.

## 4. Import

### 4.1 Which refs become names

Every ref of the imported snapshot
([objects.md §6](../native-store/objects.md#6-ref-snapshots)) has exactly
one outcome (decision 9):

| Ref | Outcome |
| --- | --- |
| `refs/heads/<name>` | a branch `<name>`, not local; workspace branches such as `causet/ws/<slug>` included |
| `refs/tags/<name>` | a tag `<name>` |
| `refs/remotes/<name>` | a remote-tracking name `<name>`, such as `origin/main` |
| `refs/notes/causet` | facts: the shared chain ([facts.md §5.1](facts.md#51-the-notes)) |
| `refs/notes/vcs-lab` | facts with the legacy names ([facts.md §5.1](facts.md#51-the-notes)); otherwise snapshot only |
| `refs/causet/quarantine/*` | facts: parked disputed copies in the local chain ([facts.md §5.3](facts.md#53-local-facts)) |
| `refs/vcs-lab/quarantine/*` | as `refs/causet/quarantine/*` with the legacy names; otherwise snapshot only |
| `refs/causet/retention`, `refs/causet/resolutions/*`, every other ref under `refs/causet/` or `refs/vcs-lab/` such as checkpoints and rebase anchors | snapshot only; the facts keep what retention kept (§5) |
| `HEAD`, every other `refs/notes/*` ref, `refs/causet-remote/*`, `refs/stash`, `refs/replace/*`, `refs/bisect/*`, `refs/worktree/*`, and every other ref | snapshot only |

**Snapshot only** means the ref stays in the snapshot for the bridge, and is
never shown as a name. No outcome but a name is ever shown as one.

- **A direct ref** that becomes a name targets the native form of its
  object: the native commit or tag imported from a preserved one, and
  otherwise the object itself.
- **A symbolic ref** that becomes a name targets a name when its target ref
  is in one of the three namespaces, such as `refs/remotes/origin/HEAD`
  naming `refs/remotes/origin/main`. When it is not, the ref is snapshot
  only.
- `HEAD` is not a name: N2 has no working copy, and N3 defines what a
  workspace points at.

### 4.2 The import operation

Each import writes one operation, after its objects and its snapshot:

- **Its view's names** are the snapshot's, by §4.1. They replace the names
  the clone had: a branch moved natively since the last import is moved back
  to the original's, as a re-import of a shadow should.
- **Its shared heads** are the current view's shared heads with the notes
  ref's entry, less any that is an ancestor of another, so facts recorded
  natively stay.
  **Its local heads** are the local entry alone
  ([facts.md §5.3](facts.md#53-local-facts)), or none.
- **It has no actor and no time**, and its command is `import`, whatever
  arguments it was given.
- **Its parents** are the current operation heads. Import into a new store
  has none,
  so a fresh import writes the same operation every time.

Adding its head file is import's last step: for an existing store it follows
the replacement of `snapshot`
([objects.md §10](../native-store/objects.md#10-the-cst-directory)), and for
a new store it precedes the rename of `.cst-import/`. An incremental import
equals a full one in every object but its operation, whose parents record the
clone's own history.

## 5. Reachability

An object is **reachable** when one of three roots reaches it (decision 11):

- **the names:** every target of every name in the current view, a
  conflicted name's adds and removes included;
- **the fact log:** both chains' heads in the current view, each entry's
  parents, and the facts it adds and retires;
- **the operation log:** every operation reached from the heads through
  parents, and everything its view reaches.

The current view is a head's view or the merge of the heads' views, so the
operation heads reach all three.
Everything a reachable fact names is reachable (facts.md §3.2), as is
everything a reachable object names by the store's rules: a native commit's
tree and parents, a native tag's target, a tree's entries. The ref snapshot
stays a root of its own for the bridge
([objects.md §6](../native-store/objects.md#6-ref-snapshots)).

So `refs/causet/retention` has nothing left to do in a native repository
(ADR-0025): a resolution's carrier commit and the blobs a record names are
reachable through the facts that name them. Import reads it, derives
nothing, and keeps it in the snapshot. N2 prunes nothing; garbage collection
is #326's (decision 16).

## 6. Reference vectors

[facts-vectors.json](facts-vectors.json) holds this part's examples with
[facts.md](facts.md#7-reference-vectors)'s: the four operations above, and
the merged view of Ada's and the agent's, with the operations it merges and
their base. Their inputs:

| Operation | Actor | Time | Command |
| --- | --- | --- | --- |
| import | none | none | `import` |
| Ada moves `main` | `Ada Lovelace <ada@example.com>`, human | 1762732900 +0100 | `branch --force main <her commit>` |
| the agent deletes `main` | `claude-opus-5-5`, agent, for `Ada Lovelace <ada@example.com>` | 1762732950 +0100 | `branch --delete main` |
| Ada chooses her side | Ada, human | 1762733000 +0100 | `branch --force main <her commit>` |

A commit's ID in a command is its native ID in full. The commands show the
shape of the field; `cst branch`'s options are N2's to define.

## 7. Verification

`cst fsck` checks every operation against these rules, every head file for
an operation the store holds, and that every target, head and parent is
held. A conflicted name is not corrupt: it is a state that `cst branch`
resolves.
