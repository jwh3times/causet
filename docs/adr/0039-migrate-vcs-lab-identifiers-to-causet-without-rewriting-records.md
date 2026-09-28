# ADR-0039: Migrate `vcs-lab` identifiers to `causet` without rewriting any record

- **Status:** Proposed
- **Date:** 2026-09-28
- **Owners:** Repository maintainers
- **Implementation:** [#159](https://github.com/jwh3times/vcs-lab/issues/159)
- **Related:** [ADR-0020](0020-freeze-per-family-compatibility-and-resource-bounds.md),
  [ADR-0023](0023-locate-the-model-substrate-mismatch-in-facts-not-content.md),
  [ADR-0025](0025-retain-the-object-closure-of-published-causal-facts.md),
  [ADR-0030](0030-define-conflict-policy-for-competing-causal-facts.md),
  [ADR-0033](0033-advertise-capabilities-as-a-document-negotiated-offline.md),
  [ADR-0037](0037-reimplement-the-cli-in-rust-as-a-semantics-preserving-port.md),
  [ADR-0038](0038-deliver-the-rust-cli-through-per-platform-npm-packages-linked-without-node.md)

## Context

ADR-0038 named the package `causet` and the command `cst` (#158), and left every persisted
identifier named `vcs-lab`. On 2026-09-27 the owner directed that those identifiers, and the
repository itself, move to `causet` as well (#159). ADR-0038 §4 said such a rename is a
migration and needs its own ADR. This is it.

### What is persisted, and where

Built from the code at `b66d755`, not from text counts:

| Identifier | Defined at | Lives in | Written by | Read by |
| --- | --- | --- | --- | --- |
| Record family ids `vcs-lab.<family>/vN`: `note`, `landing`, `application`, `reconciliation`, `rebase`, `amendment`, `provenance`, `resolution`, `forecast`, `workspaces`, `workspace`, `dispositions`, `disposition`, `spec-manifest`, `capabilities` and more | `RECORD_FAMILIES`, `src/schemas.js:71` onward; one `*_SCHEMA` constant per module | **Inside the stored record's own bytes**: note blobs, receipts, envelopes, proof bundles, local state files, tracked manifests | Every writer | `schemaClassification` and `schemaCompatibility`, `src/schemas.js:376` |
| Output and document ids: `vcs-lab.error/v1`, `vcs-lab.metadata-status/v1`, `vcs-lab.capability-report/v1`, `vcs-lab.proof-bundle/v1` and `v2`, `vcs-lab.engine-differential/v1`, … | `src/errors.js:1`, `src/schemas.js:12-16`, `src/proof-bundle.js:23-25` | CLI output, exchanged proof bundles and capability documents | CLI | Automation, `verify-proof`, `capabilities --against` |
| Protocol profile ids `vcs-lab.canonical-json/v1`, `vcs-lab.logical-id/v1` | `src/canonical-json.js:14`, `src/ids.js:3` | Capability documents, hashed payloads | CLI | Peers negotiating |
| `refs/notes/vcs-lab` (the note container; short form `vcs-lab`) | `src/notes.js:18`; repeated in `metadata.js:37`, `metadata-transfer.js:36`, `proof-binding.js:12`, `retention.js:9` | **Repository, published to origin** | `commit`, landings, import | Every metadata read; `verify-proof` |
| `refs/vcs-lab/resolutions/*` | `metadata.js:38`, `resolutions.js:26` | Repository, published | Resolution capture | Resolution memory, forecasts |
| `refs/vcs-lab/retention` | `git-carriers.js:6` | Repository, published (the ADR-0025 carrier) | Publication | Retention checks |
| `refs/vcs-lab/quarantine/*` | `quarantine.js:8` | Repository (parked disputes, ADR-0030) | Import `--park-conflicts` | `metadata status`, `dispose` |
| `refs/vcs-lab/checkpoints/*`, `refs/vcs-lab/checkpoint-history/*` | `metadata.js:39-40` | Repository | `workspace checkpoint` | Overlays, forecasts |
| `refs/vcs-lab/rebase/<op>/*` | `rebase-operations.js:308` | Repository, transient during an operation | Causal rebase | Rebase resume and abort |
| `refs/vcs-lab/exports/<key>/notes`, `refs/vcs-lab/import-staging/*` | `metadata-transfer.js:205`, `:515` | Repository, transient | Export, import | Same command |
| Envelope manifest `refs[].ref` and `refs[].bundleRef` (for example `ref: "refs/notes/vcs-lab"`) | `metadata-transfer.js:223-227` | **Exchanged envelopes** | Export | Import |
| `producer.name = "causal-vcs-lab"` | `capabilities.js:65`, `metadata-envelope.js:71` | Exchanged envelopes and capability documents. It is also inside a hashed example in `docs/canonical-json/vectors.json` | Export, `capabilities` | `capabilities --against` (reported, never compared for compatibility) |
| Workspace branches `vlab/ws/<name>` | `workspaces.js:261` | **User-visible branches**, checked out in linked worktrees; the registry records each name | `workspace create` | Registry lookups by recorded name |
| Runtime directory `<commonDir>/vcs-lab/` (registry, dispositions) and `<gitDir>/vcs-lab/` (journals, forecasts) | `store.js:21-23`, `reconcile-state.js:11`, `metadata.js:569-760` | Worktree-private and shared-local state | Most commands | Most commands |
| Tracked spec manifests `.vcs-lab/specs/**` | `specs.js:328`, `:352`; `schemas.js:245` | **Committed files** in the user's tree | `spec index` | `spec` commands, `metadata status` |
| Git config `notes.displayRef` and `notes.rewriteRef` = `refs/notes/vcs-lab` | `store.js:36-39` | Repository `.git/config` | `init` | Git itself (`git log --notes`, rebase and amend note copying) |
| User-facing environment variables `VLAB_ENGINE`, `VLAB_FORECAST_ENGINE`, `VLAB_GIT_SESSION`, `VLAB_TRACE`, `VLAB_AGENT`, `VLAB_GIT_SESSION_DIAGNOSTICS[_FILE]`, `VLAB_CLI`, `VLAB_CLI_REPORT`, `VLAB_BENCHMARK_HOST`, `VLAB_REQUIRE_NATIVE` | read in `src/git.js`, `src/provenance.js`, `test-support/`, `scripts/` | Process environment, users' shells and CI | — | CLI, suites, scripts |
| Test-only environment variables `VLAB_TEST_*` (fault, gate, session and merge-tree failure injection, native binding stub) | `src/faults.js`, `src/git.js`, `src/native-engine.js` | Suite processes only | — | Suites |
| Diagnostic prefixes `[vlab trace]`, `[vlab session]`, `[vlab session-worker]` | `git.js:91,154,188,747`, `git-session-worker.js:7` | stderr | CLI | `scripts/perf-checkpoint.mjs:181`, the git-session demo, #141's parity requirement |

**What carries no brand, and so does not move.**
- The commit trailers the CLI writes: `Change-Id`, `Landing-Mode`, `Source-Revision`, `Absorbs`,
  `Origin-Commit`, `Derived-From`.
- The record id prefixes (`land_`, `prov_`, `ch_`, `rsig_`, …).
- The resolution-signature algorithm names.

None contains `vcs-lab`, so published commits need no change.

### The constraint that shapes everything

A record's family id is part of the record's bytes. It sits inside the note blob, and inside what
proof bundles, envelope manifests and retention checks hash. ADR-0020 forbids rewriting a record
another party may hold ("Migration stays explicit and never touches a peer's record"). This
repository's own `refs/notes/vcs-lab` on origin already carries about 150 records with
`vcs-lab.*` ids (146 accepted at the v0.18.0 release notes, `4089785`). The retention carrier (ADR-0025) keeps their objects alive, and published proof
bundles cite them by content.

So **existing records keep their `vcs-lab.*` ids forever.** A migration can rename *where*
records live (refs, directories, configuration), and change what *new* records say. It cannot
change what old records say.

## Decision

### 1. New names

| From | To | Moves? |
| --- | --- | --- |
| `vcs-lab.<family>/vN` in **new** records and outputs | `causet.<family>/vN` | Yes, for writes only (§2) |
| `vcs-lab.canonical-json/v1`, `vcs-lab.logical-id/v1` | `causet.canonical-json/v1`, `causet.logical-id/v1` | Yes: same algorithms, new labels |
| `refs/notes/vcs-lab` | `refs/notes/causet` | Yes, by `cst migrate` (§3) |
| `refs/vcs-lab/<family>/…` (all nine families) | `refs/causet/<family>/…` | Yes, by `cst migrate`. Transient families (`rebase`, `exports`, `import-staging`) are only created under the new name, and migration refuses while one exists |
| `<commonDir>/vcs-lab/`, `<gitDir>/vcs-lab/` | `<commonDir>/causet/`, `<gitDir>/causet/` | Yes, by `cst migrate`, only when no operation is in progress |
| `.vcs-lab/specs/**` (tracked) | `.causet/specs/**` | Yes, **as a staged `git mv` the user commits**. The tool never commits on the user's behalf |
| `notes.displayRef`, `notes.rewriteRef` | point at `refs/notes/causet` | Yes, by `cst migrate` |
| `vlab/ws/<name>` branches | New workspaces use `causet/ws/<name>`. **Existing branches keep their names** | No. They are the user's working branches, possibly checked out elsewhere, and the registry records the actual name, so nothing needs them renamed |
| `VLAB_*` (user-facing) | `CAUSET_*` | Yes, with a window (§5) |
| `VLAB_TEST_*` | `CAUSET_TEST_*` | Yes, immediately, with no window (suite-internal) |
| `[vlab trace]` and siblings | `[cst trace]` and siblings | Yes, immediately. `perf-checkpoint.mjs` accepts both prefixes, so older builds remain measurable |
| `producer.name` `causal-vcs-lab` | `causet` | Yes, for new documents. It is informational, and negotiation never compares it |
| Commit trailers, record id prefixes | — | No: they carry no brand |
| `docs/canonical-json/vectors.json` | — | No. A vector is a sample input, and its hash does not depend on which name the sample contains |

**`CAUSET_*`, not `CST_*`.** `CST` is a common abbreviation (Central Standard Time), and some
environments set `CST`-prefixed variables. The package name is unambiguous.

### 2. Reading both, writing one: an alias in classification, not a new family

Duplicating every family in `RECORD_FAMILIES` would double the registry and the compatibility
tables. Instead, **classification treats `vcs-lab.` as a read-only alias of `causet.`**:

- `schemaClassification` maps `vcs-lab.<family>/vN` to the family `causet.<family>` at version
  `N`, and marks it `legacyName: true`. Readability, scope, the unknown-version rule and
  quarantine are then exactly those of `causet.<family>/vN`. Nothing else in the registry
  changes.
- **Writers emit only `causet.*`.** A record read under the old name is never rewritten into
  the new one, because that would change its bytes and its hashes.
- **The alias is permanent**, because the records are permanent (see *The constraint*). Unlike
  refs, paths and variables, which have a window (§8), reading `vcs-lab.*` record ids never
  ends. The cost is one prefix rule in one function.
- `docs/schemas/compatibility.md` gains a row saying so. The schema catalog publishes `causet.*`
  `$id`s and lists the `vcs-lab.*` spelling of each as an accepted alias.
  `test/schema-compatibility.test.js` checks that the alias applies to every family, and that no
  writer emits it.
- Quarantine is unchanged. A legacy-named record in an unreadable *version* is quarantined as
  its `causet.*` equivalent would be. A legacy-named record is never quarantined *for being
  legacy*.

### 3. Migrating a repository in place: `cst migrate`

```text
cst migrate [--dry-run] [--json]
```

- **What it does:**
  - creates each `refs/causet/…` ref at the same object as its `refs/vcs-lab/…` source, and
    `refs/notes/causet` at the same commit as `refs/notes/vcs-lab`;
  - repoints the two notes configuration keys;
  - moves the runtime directories;
  - stages `git mv .vcs-lab/specs .causet/specs` without committing;
  - writes a migration marker (`causet.migration/v1`, shared-local) recording each source ref's
    migrated-from object.
- **Atomic and resumable.** Refs are created in one `git update-ref --stdin` transaction. Each
  step checks its postcondition first, so a rerun after an interruption completes what is
  missing and repeats nothing.
- **It never deletes anything.** The old refs stay, pinned at their migrated-from objects.
  Deleting them is a separate, explicit step at the end of the window (§8), and never
  automatic.
- **It refuses while an operation is in progress** (a reconciliation or rebase journal, a
  pending import), and names the command that finishes it.
- **Dry run** prints every ref it would create, the configuration it would change, the paths it
  would move and the manifest `git mv`, and changes nothing.
- **Precedence during the window:**
  - reads use the new name when it exists, and fall back to the old;
  - writes go to the new name only after migration, and to the old name before it, so an
    unmigrated repository keeps working unchanged until the user runs `cst migrate`.
- **Mixed state:** an old ref has advanced since migration, for example because a peer running
  an old build pushed to it and it was fetched. That is not guessed at:
  - `metadata status` reports `legacy-ref-advanced` as a warning, naming the ref and both
    objects;
  - `cst migrate` rerun fast-forwards the new ref when only the old side moved;
  - when both moved, it refuses and points to importing the old side as an envelope. That
    path already carries ADR-0030's conflict policy.
- **Reporting:**
  - `doctor` gains a `migration` member: `unmigrated`, `migrated`, or `mixed`;
  - `metadata status` reports an unmigrated repository with the info-level diagnostic
    `unmigrated-repository`. It is not an error during the window.

### 4. Exchanging with clones that have not migrated

- **Envelopes.**
  - Import accepts manifest refs under either name and translates `refs/notes/vcs-lab` and
    `refs/vcs-lab/*` into the local repository's current names.
  - Export writes new names once the exporting repository has migrated.
  - An unmigrated importer running an older build rejects a `refs/causet/*` manifest ref as
    unknown. That is ADR-0033's "smaller, not impossible": `capabilities --against` reports it
    before the exchange.
- **Records.**
  - An old build reads a `causet.*` record as an unknown family. For shared-portable notes
    that means quarantine (ADR-0020): safe, never destructive, and reversed by upgrading.
  - There is **no downgrade writer**: a migrated repository never writes `vcs-lab.*` to suit an
    old peer.
- **Proof bundles.** `verify-proof` accepts bundles under either document id, and evaluates a
  bundle's evidence records by their own ids, whichever spelling they carry.
- **Capability documents.**
  - Families are advertised under `causet.*`, with an additive `aliases` member listing
    `vcs-lab.*` as read-only alternate spellings.
  - A peer that does not understand `aliases` ignores it (ADR-0020 additive rule). It then sees
    families it does not know and reports a smaller exchange, which is accurate.
- **Fetch refspecs.** The README currently tells users to fetch `refs/notes/vcs-lab` and
  `refs/vcs-lab/*`. After this ships it says `refs/notes/causet` and `refs/causet/*`, and during
  the window it also gives the old refspec for fetching from unmigrated publishers.
  - A publisher that has migrated keeps its old refs **frozen** at the migrated-from objects
    until the window ends.
  - A fetcher using the old refspec therefore gets a consistent but stale view, and
    `legacy-ref-advanced` never fires from a frozen ref.

### 5. Environment variables

During the window, every user-facing `VLAB_X` is read as a fallback for `CAUSET_X`:
- **When both are set, `CAUSET_X` wins.**
- `cst doctor` lists each legacy variable in use.
- Nothing is printed to stderr for this. Stderr stays empty in `--json` mode, per ADR-0021.

`VLAB_TEST_*` are renamed outright, since only the suites set them.

### 6. This repository's own migration on origin

- **It runs from a fresh clone of origin,** never from the Windows checkout. That checkout's
  local `refs/vcs-lab/retention` diverged from origin's and must never be pushed or
  force-pushed. Its fate is decided separately, by the rule already recorded for it.
- **In that clone:**
  1. run `cst migrate`;
  2. push the new refs as **creations** (`refs/notes/causet`, `refs/causet/*`);
  3. verify that each new ref's object equals origin's old ref.

  Nothing on origin is force-updated or deleted.
- **The old refs on origin stay frozen until the window ends.** Deleting
  `refs/vcs-lab/retention` then is allowed only if `git rev-list <old> --not <new>` is empty, so
  the ADR-0025 closure is still retained.
- **Published history is not rewritten.** Past commits, tags, releases, changelog history and
  ADR rationale keep saying `vcs-lab`.

### 7. Sequencing

1. **This ADR** is accepted before #145, the port of metadata writes. The Rust CLI then writes
   `causet.*` ids, refs and paths from its first write, and carries only the compatibility
   readers.
2. **Text-only changes,** in any order:
   - the product name in documentation;
   - the crate names (`vlab-core` → `causet-core`, `vlab-binding` → `causet-binding`, and the
     prebuild file name);
   - the diagnostic prefixes;
   - `VLAB_TEST_*`.
3. **Compatibility readers, new writers and `cst migrate`,** in the JavaScript CLI first
   (ADR-0037), with the six qualification modes and `VLAB_CLI` parity once the port exists.
4. **This repository's origin migration** (§6).
5. **The owner renames the GitHub repository** to `jwh3times/causet` and project 7 to "causet".
   GitHub redirects web, Git and API URLs, and the issues and wiki move with the repository. The
   in-repository links update afterwards.
6. **The window ends** (§8).

### 8. The end of the window

- **When:** no earlier than two minor releases after the release that ships `cst migrate`, and
  after this repository's origin has migrated. The end is announced one release ahead in the
  changelog, as ADR-0038 did for the `vlab` alias.
- **What goes:**
  - the fallback reads of old refs, runtime paths and `VLAB_*` variables;
  - the envelope import translation of old manifest ref names;
  - the frozen old refs on this repository's origin, under §6's retention check.
- **What stays:**
  - the permanent `vcs-lab.*` record-id alias (§2);
  - `cst migrate` itself.
- **An unmigrated repository after the window** is refused by every command except `migrate`,
  `doctor` and `--version`, with the error `unmigrated-repository` and the instruction to run
  `cst migrate`. No fact is lost, because migration never deleted anything; the user is one
  command from a working repository.

## Constraints

- No existing record, receipt, envelope or proof bundle is rewritten. New names apply to new
  writes and to locations (refs, paths, configuration).
- No command deletes an old ref automatically. Deletion happens only at the end of the window,
  as an explicit step guarded by the retention check.
- `cst migrate` never commits on the user's behalf. The manifest move is left staged.
- A migrated repository never writes a `vcs-lab.*` id.

## Consequences

### Positive

- Every new artefact carries the product's name, and old artefacts stay verifiable forever.
- Migration is one command, reversible up to the end of the window: the old refs are untouched
  and still point where they did.
- The Rust port writes the final names from the start, if this ADR lands before #145.

### Negative

- The `vcs-lab.` record-id alias is permanent code, and every implementation carries it,
  including the Rust CLI.
- During the window, repositories exist in three states: unmigrated, migrated and mixed. Status
  and `doctor` must report which, and the suites must cover all three.
- Peers on old builds quarantine new-named records until they upgrade. That is safe, but it is
  visible.

## Rejected alternatives

- **Rewrite every record to the new ids during migration.** This changes record bytes and
  hashes, breaks published proof bundles and envelope digests, and contradicts ADR-0020's rule
  against rewriting a peer's record.
- **Duplicate every family under both names in `RECORD_FAMILIES`.** It doubles the registry and
  the published tables for no behavioral difference. An alias in classification is one rule.
- **Keep the persisted identifiers as `vcs-lab` forever** (ADR-0038 §4's original position).
  The owner directed the full rename on 2026-09-27.
- **`CST_*` environment variables.** Rejected for the collision risk in §1.
- **Rename existing workspace branches.** They are the user's branches, possibly checked out, and
  the registry records their actual names. Only new workspaces use `causet/ws/`.

## What the owner must decide

1. **The name table in §1,** in particular `CAUSET_*` for variables and `causet/ws/` for new
   workspace branches.
2. **A permanent read alias** for `vcs-lab.*` record ids, rather than rewriting records.
3. **`cst migrate` as specified in §3:** no deletions, a staged manifest move, a refusal during
   operations, and the mixed-state rule.
4. **The exchange rules in §4:** no downgrade writer, and `aliases` in the capability document.
5. **The variable window in §5,** with the new name winning.
6. **The origin migration in §6:** a fresh clone, creations only, and frozen old refs.
7. **The sequencing in §7:** accepted before #145, and the owner renames the repository after the
   code migration.
8. **The window end in §8:** at least two minor releases after `cst migrate` ships.

## Implementation map

- **Classification alias, catalog ids, `compatibility.md`:** `src/schemas.js`, `docs/schemas/`,
  `test/schema-compatibility.test.js`, `test/schema-catalog.test.js`.
- **Ref and path constants:**
  - `src/notes.js`, `metadata.js`, `metadata-transfer.js`, `proof-binding.js`, `retention.js`,
    `resolutions.js`, `quarantine.js`, `git-carriers.js`, `rebase-operations.js`;
  - `store.js` and `reconcile-state.js`, for runtime paths and configuration;
  - `specs.js`, for manifests;
  - `workspaces.js`, for the new branch prefix.
- **`cst migrate`:** a new module and command. The `migration` member of `doctor`, and the
  `unmigrated-repository` and `legacy-ref-advanced` diagnostics.
- **Exchange:** envelope import translation in `metadata-transfer.js`, `aliases` in
  `capabilities.js`, and document ids in `proof-bundle.js`.
- **Environment:** a single lookup helper for `CAUSET_*` falling back to `VLAB_*`.
- **Documentation:**
  - README (fetch refspecs, migration), `docs/architecture.md`, `docs/testing.md`, `AGENTS.md`;
  - `docs/identity/` and `docs/canonical-json/`, for profile labels;
  - the wiki procedure for the origin migration and the repository rename, which are owner
    steps.
