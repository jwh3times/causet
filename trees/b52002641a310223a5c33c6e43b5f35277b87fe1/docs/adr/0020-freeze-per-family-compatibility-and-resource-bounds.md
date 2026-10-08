# ADR-0020: Freeze per-family compatibility, migration, and resource bounds

- **Status:** Accepted
- **Date:** 2026-08-30
- **Owners:** Repository maintainers
- **Related requirements:** GP-01, GP-12, FR-GIT-06, FR-SPEC-04, NFR-SEC-03,
  NFR-TEST-03

## Context

[ADR-0015](0015-adopt-a-phased-native-core-program-with-rust.md) phase 0b freezes
the local contracts before any native code is written. Two of its three
contract items are delivered: the schema catalog in `docs/schemas/` publishes a
JSON Schema document per record family, and `docs/canonical-json/` freezes the
byte-exact serialization. Both describe what a *valid current* record looks
like. Neither says what happens to a record this build did not write — an older
version, a newer version from a peer running a later vcs-lab, or one large
enough to be a denial-of-service vector.

A survey of the implementation on 2026-08-30 found that the answer was decided
independently at each store, and in several places not decided at all:

- `schemaClassification` never compared versions. Every store carried its own
  exact-string allow-list, so `vcs-lab.forecast/v9` and
  `vcs-lab.made-up/v1` were indistinguishable.
- The reconciliation and rebase journals were read with **no schema check of any
  kind** and resumed as if current — the single largest unguarded read in the
  repository. The workspace registry, the only record of which worktrees exist,
  was likewise consumed and rewritten whatever version it declared.
- `appendNote` read a note container, dropped it when it was not
  `vcs-lab.note/v1`, and then rewrote the whole blob with `git notes add -f`.
  Publishing one receipt onto a commit whose note came from a newer vcs-lab
  would have **destroyed that note**.
- `vcs-lab.forecast/v1` was accepted on read but absent from the registry, so
  the catalog needed a hand-maintained "superseded without a document" allowlist.
- Resource bounds existed only for Git transport (process and session buffers)
  and for the metadata envelope. Note size, note record count, and the size of
  every worktree-private and shared-local JSON file were unbounded, which
  `docs/architecture.md` §17.3 already listed as a missing control.

Records reach this repository across a trust boundary. Notes and envelopes
arrive by fetch and import from clones that may run a different build, so
"unknown version" is an ordinary event on those paths and a fault on none of
them.

## Decision

Compatibility, migration, unknown-version behavior, and resource bounds are one
frozen contract per record family, expressed once as data.

### One registry is the runtime authority

`RECORD_FAMILIES` in `src/schemas.js` holds, per family, its persistence
`scope`, the versions it has `registered`, the versions it can read
(`readable`), the versions it writes (`written`), its `unknownVersion` rule, and
its `store`. The runtime schema registry is derived from it rather than listed
separately, so a version cannot be readable in one module and unknown in
another. `docs/schemas/compatibility.md` publishes the same table and
`test/schema-compatibility.test.js` fails the suite when the two disagree.

### Compatibility inside a version is additive only

Catalog documents stay open. Within `family/vN` a writer may add an optional
member, extend an opaque vocabulary, widen an accepted value, or relax a bound
upward. Removing or renaming a member, making one required, changing a type,
cardinality, unit, or meaning, narrowing a value set, or changing any hashed
byte layout requires `vN+1`. Readers ignore unknown members and never rewrite a
record to drop them.

### The unknown-version rule follows the scope, not the caller

| Scope | Rule | Because |
| --- | --- | --- |
| Shared-portable note records | Quarantine | They arrive by fetch from peers; one unreadable record must never stop local work, and untrusted input must never be interpreted (NFR-SEC-03) |
| Note containers | Ignore, and refuse to rewrite | A rewrite replaces the whole blob, so publishing into an unreadable container would destroy a peer's data |
| Worktree-private journals and forecasts | Refuse | Resuming means acting on a queue and cursor; the state is local and disposable, so refusing costs only the operation |
| Shared-local workspace registry | Refuse | Every mutation rewrites the whole file, so consuming an unknown version would silently drop its members |
| Tracked spec manifests | Refuse forward, migrate backward | They are committed and derived, so an unreadable one is repaired by re-indexing |
| Metadata envelope | Refuse | Import is an explicit, auditable act on untrusted input |

Unparsable note *text* keeps its existing treatment: it is preserved as one
opaque `legacy-note` record so a rewrite cannot lose it.

### Migration stays explicit and never touches a peer's record

Only `vcs-lab.spec-manifest` (v1 and v2 to v3) and `vcs-lab.forecast` (v1 read,
v2 written) read a version they do not write. Spec manifests migrate on write,
not on read: a read materializes the older manifest in place, and the next
`vlab spec index` rebuilds it as v3 while preserving logical IDs through
`idOverrides` (FR-SPEC-04). No migration ever runs implicitly on a
shared-portable record; note records are migrated only by publishing a new
record.

### Resource bounds are frozen constants that fail closed

`RESOURCE_BOUNDS` in `src/schemas.js` names every bound on reading a persisted
record: `noteContainerBytes`, `noteContainerRecords`, `localStateBytes`,
`specManifestBytes`, and the three envelope bounds, which absorb the previously
ad-hoc literals in `src/metadata-envelope.js`. They are constants, not
configuration, so every implementation of the contract agrees. A bound is
checked **before** the record is interpreted, and it fails in the way its scope
requires: a shared-portable input over a bound is quarantined with an
`oversize-record` diagnostic, and a worktree-private, shared-local, tracked, or
imported input over a bound refuses the command.

`readJson` in `src/store.js` is the single reader for every worktree-private and
shared-local document, so `localStateBytes` is enforced once there and covers
both journals, every stored forecast, and the workspace registry. That reader
also turns malformed JSON into a domain error naming the file.

Growth limits that need a retention design rather than a constant — repository
note count, journal queue length, forecast directory size, retained checkpoint
and resolution refs — are named as deliberately absent in
`docs/schemas/compatibility.md` rather than left undocumented. ADR-0013's
incremental-catalog row remains the decision point for those.

## Constraints

- A store that must interpret a record refuses what it cannot read; a store that
  only reports on records quarantines instead. No store guesses.
- No refusal or quarantine ever rewrites, truncates, or deletes the record that
  caused it. The bytes on disk are left exactly as found.
- Bounds are checked before parsing, never after.
- Changing any row of the published tables is a contract change under
  NFR-TEST-03: it needs a version bump when it breaks a reader, a migration test
  when it changes what an older record means, and the registry updated in the
  same commit.

## Consequences

### Positive

- Two real data-loss and safety gaps are closed: a peer's note container can no
  longer be destroyed by publishing a receipt, and an operation journal from an
  unknown version can no longer be resumed.
- Version rules live in one table instead of nine allow-lists, so the phase 1
  Rust engine has a single contract to implement rather than a survey to repeat.
- `vcs-lab.forecast/v1` is now expressed as a readable version of its family
  rather than an exception in a test allowlist.
- `docs/architecture.md` §17.3's missing control for record-family resource
  bounds is satisfied for every persisted family.

### Negative

- A journal, registry, or forecast written by a future build now stops the
  command instead of being read optimistically; recovery is to use the build
  that wrote it or to delete the local file.
- Bounds add a `stat` before each local state read and a length check per note.
  Both are constant-time and the benchmark baseline is unchanged.
- The bounds are judgment calls. They are set far above any observed record and
  can be relaxed upward without a version bump, which is the direction that is
  safe.

## Alternatives considered

- **Compare versions numerically and accept anything lower.** Rejected: a lower
  version is not automatically readable — `vcs-lab.application/v1` and `v4` are
  both current and neither supersedes the other — and "read anything older"
  invites silently dropping members a v2 reader needs.
- **Quarantine everywhere, refuse nothing.** Rejected for private state:
  resuming an operation from a journal we cannot interpret can move refs, which
  is worse than stopping.
- **Refuse everywhere, quarantine nothing.** Rejected for notes: a single
  unreadable record fetched from a peer would block all local work, which
  contradicts GP-01.
- **Make bounds configurable by environment variable.** Rejected: a bound that
  differs between two implementations of the contract is not a contract. Bounds
  change by changing the published constant.
- **Annotate each catalog document with its own rules.** Rejected: thirty-three
  documents would each carry a fragment of one policy, and the policy is what
  needs to be read as a whole.

## Implementation map

- Registry, bounds, and helpers: `src/schemas.js`
- Enforcement: `src/store.js` (local state), `src/reconcile-state.js`,
  `src/rebase-state.js`, `src/workspaces.js`, `src/notes.js`, `src/metadata.js`,
  `src/forecasts.js`, `src/rebase-forecast.js`, `src/specs.js`,
  `src/metadata-envelope.js`
- Published contract: `docs/schemas/compatibility.md`
- Coverage: `test/schema-compatibility.test.js`
- Program context: ADR-0015 phase 0b, `docs/roadmap.md` Horizon 2 item 1
