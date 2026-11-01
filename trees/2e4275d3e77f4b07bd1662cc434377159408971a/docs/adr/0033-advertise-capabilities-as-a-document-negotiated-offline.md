# ADR-0033: Advertise capabilities as a document that negotiates offline

- **Status:** Accepted
- **Decided:** 2026-09-17
- **Date:** 2026-09-16
- **Owners:** Repository maintainers
- **Implementation:** [#37](https://github.com/jwh3times/vcs-lab/issues/37)
  (FR-PROTO-06)
- **Related:** [#36](https://github.com/jwh3times/vcs-lab/issues/36),
  [#38](https://github.com/jwh3times/vcs-lab/issues/38),
  [#39](https://github.com/jwh3times/vcs-lab/issues/39),
  [#40](https://github.com/jwh3times/vcs-lab/issues/40),
  [ADR-0010](0010-add-a-validated-metadata-envelope-before-a-server.md),
  [ADR-0020](0020-freeze-per-family-compatibility-and-resource-bounds.md),
  [ADR-0021](0021-give-failures-a-versioned-machine-readable-envelope.md),
  [ADR-0029](0029-require-a-declared-lineage-bridge-for-imports-without-a-shared-root.md),
  [ADR-0031](0031-carry-a-bound-source-inventory-for-portable-verification.md),
  [compatibility contract](../schemas/compatibility.md),
  [canonical JSON profile](../canonical-json/README.md),
  [identity protocol](../identity/README.md)

## Context and decision

FR-PROTO-06 asks remote synchronization to advertise capabilities and negotiate
schema versions. ADR-0010 deferred a protocol gateway because negotiation,
remote trust, policy, and service lifecycle were outside the envelope
increment, and product §15 places the gateway in phase 6 under Gate B with one
exit criterion: no local planning, forecasting, or landing depends on it.
Issue #37 adds a second constraint: offline envelope inspection is retained,
not a fallback to drop once a gateway exists.

Everything a peer would need to advertise is already frozen as runtime
registries: `RECORD_FAMILIES` and `RESOURCE_BOUNDS` in `src/schemas.js`
(ADR-0020), the error-code vocabulary in `src/errors.js` (ADR-0021), and the
profile and algorithm identifiers `vcs-lab.canonical-json/v1`,
`vcs-lab.logical-id/v1`, `git-root-commits-sha256/v1`, and
`ordered-three-way-blobs/v1`. What does not exist is a document that states
them to another party, or a rule for what two parties do with each other's.

Decide that capability negotiation is a **pure function of two capability
documents**. A build states what it reads and writes in a
`vcs-lab.capabilities/v1` document projected from the registries; a client
decides what can be exchanged by comparing its own document with the peer's.
Where the peer's document came from (a gateway, a file, an envelope, a
colleague) does not change the result, so every decision a gateway enables can
also be made offline. The gateway is narrow: it serves the document. It
plans nothing, stores nothing, and authenticates nothing.

## Evidence

Disposable repository under the session scratchpad, 2026-09-16, Windows,
Git 2.55.0, Node v26.4.0, vcs-lab 0.14.0 at `dbaf132`.

**The registries already hold the advertisement.** Importing them directly:
16 record families (1 note-container, 7 note-record, 4 private, 2 shared-local,
1 tracked, 1 envelope), 3 of which read more than one version
(`vcs-lab.application` writes and reads v1 and v4, `vcs-lab.forecast` writes v2
and reads v1 and v2, `vcs-lab.spec-manifest` writes v4 and reads v1 to v4);
9 resource bounds; 45 error codes; 2 algorithm identifiers.

**The envelope already advertises, and nothing reads it.** `vlab metadata
export` wrote a `vcs-lab.metadata-envelope/v1` manifest carrying
`producer: {name: "causal-vcs-lab", version: "0.14.0"}` and
`capabilities: ["causal-notes/v1", "causal-rebase/v1", "exact-resolutions/v1",
"metadata-integrity/v1"]`. The list is a literal in
`src/metadata-envelope.js`; a search of `src/`, `test/`, `bin/`, and
`scripts/` finds no reader, and the catalog document types it as an open
`string[]`. The offline half of negotiation is therefore already in the
artifact, unenforced.

**`vlab doctor --json` states the build, not its contracts.** It reports
`version`, `git`, `node`, `engine`, and `forecastEngine`, and no family,
profile, or bound.

**A future proof-bundle version would be misreported.** `assertProofBundleDocument`
in `src/proof-bundle.js` refuses any `schema` other than
`vcs-lab.proof-bundle/v1` with `wrong-record-family`, whose published response
is "stop and surface to a human". A `vcs-lab.proof-bundle/v2` document is the
right family at an unknown version, whose response is
`unknown-schema-version`: "read it with the build that wrote it". The proof
bundle is also absent from `RECORD_FAMILIES`, although it is exchanged between
hosts and bound by `proofBundleBytes`, while compatibility contract §2 exempts
CLI-output families on the ground that a consumer sees exactly the version of
the build it ran. That ground does not hold for a document handed to another
host.

## Contract

### The capability document

`vcs-lab.capabilities/v1` is a canonical-profile JSON document with these
members. Every member except `repository` and `integrity` is a projection of a
runtime registry, generated rather than maintained, so the document cannot
disagree with the build that emits it.

| Member | Content | Source |
| --- | --- | --- |
| `schema` | `vcs-lab.capabilities/v1` | constant |
| `producer` | `{name, version}`, the same shape the envelope carries | `src/version.js` |
| `families` | For each **exchanged** family: `{family, scope, written, readable, unknownVersion}` | `RECORD_FAMILIES` |
| `profiles` | `{canonicalJson, logicalId, errorEnvelope}`: `vcs-lab.canonical-json/v1`, `vcs-lab.logical-id/v1`, `vcs-lab.error/v1` | profile constants |
| `algorithms` | `{lineage, resolutionSignature, integrity}`: `git-root-commits-sha256/v1`, `ordered-three-way-blobs/v1`, `sha256` | `src/schemas.js`, envelope and bundle writers |
| `objectFormats` | Object formats the build reads and writes: `["sha1", "sha256"]` | engine |
| `features` | Sorted `name/vN` tokens for behaviors that are not a record version | writer constants |
| `bounds` | The `RESOURCE_BOUNDS` entries that apply to exchanged families, by name | `RESOURCE_BOUNDS` |
| `repository` | Optional. `{objectFormat, lineage}` when produced inside a repository, in the shape the envelope manifest carries | `repositoryLineage` |
| `integrity` | `{algorithm: "sha256", documentHash}` over the document without `integrity` and `signatures`, as the canonical profile reserves | canonical profile |

**Exchanged** families are those whose records cross a repository boundary: the
`note-container`, `note-record`, and `envelope` scopes, plus exchange documents
such as the proof bundle once they are registered (see the dependency section).
Private, shared-local, and tracked families are never advertised: a peer never
receives a journal, a forecast, or a workspace registry, and tracked manifests
move with ordinary Git content.

`features` gives the envelope's existing tokens a published meaning. A token is
advertised only when the build both produces and consumes the behavior it
names, which today makes the four envelope tokens eligible, and ADR-0029's
`lineage-bridge/v1` the first addition if it is accepted. Tokens are opaque:
a reader ignores a token it does not know.

A document is **build-scoped** without `repository` and **repository-scoped**
with it. A gateway serves the repository-scoped form for the repository it
fronts.

### Negotiation

Negotiation takes two documents, `local` and `peer`, and produces a
compatibility report. It reads no network, no repository, and no clock.

1. **Repository.** When both documents are repository-scoped, compare
   `objectFormat` and lineage with `lineageRelation` in `src/metadata.js`,
   which `vlab verify-proof` already uses (`same`, `fork`, `unrelated`,
   `incompatible` for a different algorithm or object format, and `bridged`
   if ADR-0029 is accepted). A different object format, or a relation the operation does not
   admit, fails with the existing code `repository-mismatch` before any
   transfer.
2. **Stored records are filtered, never re-encoded.** A note record's version
   is fixed by whoever wrote it, and compatibility contract §3 forbids
   migrating a shared-portable record implicitly. For each record the sender
   would transfer, the report states whether its version is in the receiver's
   `readable` set. A record outside it is reported as `unreadable-by-peer` with
   the family's `unknownVersion` disposition on the receiving side
   (`quarantine` for note records), so the sender learns before transfer what
   `vlab metadata status` would report after it. `vcs-lab.application` shows
   why this is a per-record rule and not a per-family choice: v1 and v4 are
   both current, written by different commands.
3. **Freshly produced documents select a version.** For a document produced for
   this exchange (an envelope, a proof bundle, the capability document itself),
   the producer selects the highest version in
   `local.written ∩ peer.readable` for that family. An empty intersection fails
   with a new code, `no-common-version`, naming the family and both sets; the
   caller's remedy is to upgrade one side, which is neither
   `unknown-schema-version` (a record already written) nor
   `wrong-record-family` (a different family).
4. **Features are used only when both sides advertise them.** A record that
   depends on a feature the peer does not advertise (a bridged fact under
   ADR-0029) is withheld and reported, so the peer stays fail-closed by
   construction rather than by its own quarantine.
5. **Bounds are the receiver's.** A document or record over the receiver's
   advertised bound is withheld and reported, not sent to be refused.

Profiles and algorithms negotiate like families with one version each: a
mismatch in `canonicalJson`, `logicalId`, `lineage`, or `integrity` fails with
`no-common-version`, because every hash and identifier in an exchange is read
under them.

### Offline first, gateway second

The same report is available with no gateway:

- `vlab capabilities [--json]` prints the build-scoped document outside a
  repository and the repository-scoped document inside one. It mutates
  nothing: in particular it must not call `initLab`, which writes repository
  configuration.
- `vlab capabilities --against <document|envelope-directory> [--json]` runs
  negotiation against a peer document read from a file, or against the
  `producer`, `repository`, and `capabilities` members of an envelope
  manifest, which a v1 envelope already carries.
- A later envelope or proof-bundle version may embed the producer's full
  capability document. That is a new version of those families and is decided
  with them (#40, ADR-0031), not here.

A gateway adds exactly one thing an offline reader cannot have: the **current**
document of a party that is not in the room. It serves the repository-scoped
document at a stable location. It does not change what negotiation concludes
from that document.

### What "narrow" excludes

- **Planning, forecasting, and landing.** No plan, forecast, receipt, or
  landing decision is computed remotely (product §15 phase 6 exit criterion).
- **A remote fact store or catalog.** Notes and resolution refs stay canonical
  in the repository and move by Git and envelopes; a fact log is Gate B
  phase 5 (#40).
- **Object transport.** Git fetch and push remain the object transport.
- **Authentication, signatures, and authorization.** A capability document is
  an unauthenticated claim by whoever served it, with the trust of the channel
  that delivered it and no more. Signing it, issuer identity, and actor
  authorization are #38. `integrity` detects alteration of a copy, not a
  dishonest producer.
- **Policy.** Whether a landing may rely on a peer is #39.
- **Sessions and service lifecycle.** The gateway holds no per-client state;
  product §15's service row governs any resident process.

### Governing the document itself

`vcs-lab.capabilities` joins `RECORD_FAMILIES` as a family of a new scope,
`advertisement`, with `unknownVersion: refuse`: a client cannot negotiate from
a document it does not understand, and refusing costs one exchange. It is
bound by a new `capabilityDocumentBytes` entry in `RESOURCE_BOUNDS`, checked
before parsing. Compatibility contract §1 applies unchanged:

- adding a family entry, a feature token, a bound, or an optional member is
  additive inside `v1`;
- removing a member, changing the selection rule of step 3, or changing what a
  disposition means is `v2`.

A gateway serves every capability version it writes, and a client asks for the
highest it reads, so a `v2` gateway still answers a `v1` client.
`test/schema-compatibility.test.js` gains the projection check: the emitted
document equals the registries, so a registry change that is not advertised
fails the suite.

### What depends on #36 (ADR-0031)

**Independent of ADR-0031's outcome:** the document and its members; step-by-step
negotiation for note records, envelopes, profiles, and algorithms; the
`no-common-version` code; `vlab capabilities` and `--against`; the exclusions;
the governance above.

**If ADR-0031 is accepted:**

- `vcs-lab.proof-bundle` is registered in `RECORD_FAMILIES` as an exchanged
  family, readable v1 and v2 and written v2, and a verifier selects its version
  by step 3.
- `bound-source-inventory/v1` is advertised as a feature.
- If the owner answers ADR-0031 decision 5 with "defer to #37", the gateway
  also serves **anchors**: the target head, the source head where named, the
  notes tip, and the lineage root commits. Unauthenticated anchors from a
  gateway are exactly as trustworthy as `git ls-remote` against the same host,
  and they promote ADR-0031 conclusions to the anchored tier only for a
  verifier that already trusts that host. Authenticated anchors are #38.

**If ADR-0031 is rejected:** the proof bundle stays v1, is still registered so
its version is advertised and a future version is refused with the right code,
and the gateway serves the capability document only.

## Rejected alternatives

- **A service that answers "can you read this?" per record.** Makes offline
  inspection depend on the server, the outcome #37 rules out.
- **Negotiating a single version per family.** `vcs-lab.application` writes two
  current versions, and stored records cannot be re-encoded without the
  implicit migration compatibility §3 forbids.
- **Inferring capabilities from `producer.version`.** A version string maps to
  contracts only through a release table every reader would have to carry, and
  it says nothing about a build with a feature disabled.
- **Advertising through a Git ref in the repository.** A ref states what the
  last pusher's build could do, not what the reader's peer can do now, and it
  turns a build property into repository content that goes stale on upgrade.
- **Folding the error vocabulary into the document.** `vcs-lab.error/v1` already
  governs additions; advertising its version is enough for a client to parse
  failures.
- **Sign the document now.** A signature without #38's issuer identity,
  rotation, and revocation authenticates nothing a reader can act on.

## Consequences

- One new family, one new scope, one new bound, one new error code, and one new
  command. No persisted repository state changes: the document is produced on
  demand.
- `assertProofBundleDocument` must distinguish a wrong family from an unknown
  proof-bundle version, reporting `unknown-schema-version` for the latter. That
  is a correction worth making whatever is decided here, because ADR-0031's own
  versioning section relies on a v1 verifier refusing v2 by version.
- The envelope's `capabilities` tokens gain a published meaning without a
  version change; import may begin checking them under step 4 as an additive
  refusal of records it cannot interpret.
- Conformance fixtures gain negotiation cases: identical builds, a peer lacking
  a version the local build writes, disjoint versions (`no-common-version`),
  different object formats and lineages (`repository-mismatch`), an unknown
  feature token, and an over-bound record.
- The gateway itself remains unscheduled. This contract is useful before it
  exists, through `--against`.

## What the owner must decide

1. Accept that negotiation is a pure function of two capability documents, so
   every gateway conclusion is reproducible offline.
2. Accept per-record filtering for stored records and highest-common-version
   selection only for freshly produced documents.
3. Accept `no-common-version` as a new error code rather than reusing
   `unknown-schema-version` or `unsupported-feature`.
4. Accept the `advertisement` scope with `unknownVersion: refuse` and a
   `capabilityDocumentBytes` bound for the document itself.
5. Whether `vlab capabilities` and `--against` ship before any gateway, as the
   offline half of FR-PROTO-06.
6. Whether a gateway serves ADR-0031 anchors, which depends on the answer to
   ADR-0031 decision 5.

## Owner decision (2026-09-17)

Accepted. ADR-0031 was accepted on the same day, so its dependent branch above
applies: the proof bundle is registered as an exchanged family and
`bound-source-inventory/v1` is advertised when v2 ships.

1. Negotiation is a pure function of two capability documents.
2. Stored records are filtered per record; freshly produced documents select
   the highest common version.
3. `no-common-version` is a new error code.
4. The `advertisement` scope with `unknownVersion: refuse` and a
   `capabilityDocumentBytes` bound is accepted.
5. `vlab capabilities` and `--against` **ship before any gateway**, as the
   offline half of FR-PROTO-06.
6. The gateway **does not serve anchors** in this contract. ADR-0031 decision 5
   chose `git ls-remote` against a verifier-chosen remote as the first anchor
   channel, so the "defer to #37" branch above does not apply. A gateway may
   later be added as one more anchor channel, trusted no further than
   `git ls-remote` against the same host.
