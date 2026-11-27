# ADR-0030: Define the conflict policy for competing causal facts

- **Status:** Accepted
- **Decided:** 2026-09-17
- **Date:** 2026-09-14
- **Owners:** Repository maintainers
- **Implementation:** [#44](https://github.com/jwh3times/vcs-lab/issues/44)
- **Related:** [#37](https://github.com/jwh3times/vcs-lab/issues/37),
  [#38](https://github.com/jwh3times/vcs-lab/issues/38),
  [#40](https://github.com/jwh3times/vcs-lab/issues/40),
  [#43](https://github.com/jwh3times/vcs-lab/issues/43),
  [ADR-0004](0004-use-an-explicit-coverage-proof-lattice.md),
  [ADR-0007](0007-keep-resolution-automation-exact-or-deterministic.md),
  [ADR-0010](0010-add-a-validated-metadata-envelope-before-a-server.md),
  [ADR-0020](0020-freeze-per-family-compatibility-and-resource-bounds.md),
  [ADR-0025](0025-retain-the-object-closure-of-published-causal-facts.md)

## Context and decision

Two repositories can hold competing causal facts about the same change: a
receipt here and a different receipt there, or a resolution retained in one
clone that the other never saw. The current rule, "remote metadata conflicts
must never overwrite local facts silently", is a floor. It says what may not
happen and is enough while a person runs every `vlab metadata import`. It does
not say what does happen, which any automatic synchronization (#37, #40) needs
before it can exist. Open product question 2 asks which claims are safe to
merge automatically when two sources disagree.

Decide the policy now, before transport moves:

1. **Identity is the only conflict key.** A conflict is the same identity
   naming different content: a record identifier with a different digest, or a
   resolution ref with a different target. Two records with distinct
   identifiers never conflict, whatever they claim; they are duplicates,
   ambiguities, or independent claims, and the existing rules for each apply.
2. **A conflicted fact contributes nothing, on both sides.** Neither copy
   proves coverage, serves as a resolution candidate, is displayed as
   provenance, or is exported, until a person disposes of it. Every reader
   must agree on this; today the planner does not (see the evidence).
3. **Conflicts park; they never block local work and never overwrite.** The
   explicit import keeps its refuse-whole-envelope default and gains an
   explicit park mode; any automatic transport may use only the park mode.
4. **A person resolves a conflict with a declared local disposition**, which
   is itself a fact, so the same disagreement is reported once, not on every
   exchange.

## Evidence

Disposable repositories, Windows, Git 2.55.0, Node v26.4.0, on 2026-09-14.
Two clones A and B of one hub diverged in their facts; envelopes moved facts
between them. Raw transcripts are retained with the issue, not in the tree.

| Case | Commands | Observed |
| --- | --- | --- |
| Same conflict resolved differently in A and B | `vlab reconcile feature` in each, hand edit, `vlab reconcile --continue`; `vlab metadata export` in A, `vlab metadata import --apply` in B | Two resolution refs under one signature; import adds A's (`createRefs: 1`, `conflicts: 0`); `vlab resolve list` shows both |
| Third occurrence of that conflict in B | `vlab reconcile feature`, `vlab resolve apply --all` | "2 prior resolution candidates found"; apply refuses with `ambiguous-match` until `--resolution <id>` names one |
| Both candidates rejected, resolved by hand | `vlab resolve reject --all`, edit, `vlab reconcile --continue` | Receipt records `decision: "rejected"`; both candidates remain in the catalog and the hand result becomes a third |
| Same change hard-squashed independently in A and B | `vlab merge feat-land --hard-squash` in each; export B, import into A | Two landing receipts with distinct ids; `addRecords: 8, conflicts: 0`; from a branch reaching both, `merge-plan` reports `covered` with `receipt-commit` and lists both receipts |
| Same receipt id, different content, inside A's notes | Rewrite A's landing note to hold the record twice with one field changed | `vlab metadata status`: `record-id-conflict`, both copies quarantined (`quarantinedPortableRecords: 2`); `vlab merge-plan feat-land` still reports the change `covered` by that receipt |
| Same receipt id, different content, arriving from a peer | Alter A's copy, export, `vlab metadata import --dry-run` then `--apply` in B | Dry run: `conflicts: 1, applicable: false`, exit 1, the record listed with `action: "conflict"`; apply refuses with `conflict-blocked`; B's notes ref unchanged |
| Git's own notes merge on that disagreement | `git notes --ref=refs/notes/vcs-lab merge refs/notes/peer`, then `-s union` | Manual strategy stops with an add/add conflict worktree; union concatenates the containers, which `vlab metadata status` reports as `malformed-record`, dropping every record on that attachment |

Two findings shape the decision. Competing resolutions and duplicate landings
are already handled without a merge rule: distinct identities stay side by
side, and ADR-0007's ambiguity rule forces the choice. The one thing that
needs a policy is identity conflict, and there the validator and the planner
disagree: `metadataSnapshot` quarantines both copies, while
`acceptedCausalRecords` in `src/metadata.js`, which `src/merge-plan.js` and
`src/resolutions.js` use, checks structure and referenced objects only. The
same conflicted receipt is both quarantined and proving coverage.

## The policy

### Per family

| Family | Identity | Duplicate | Conflict | On conflict |
| --- | --- | --- | --- | --- |
| `landing`, `reconciliation`, `rebase`, `application`, `rebase-application` | record id | same id, same digest: `noop`. Distinct ids on distinct commits claiming the same change: independent facts, all accepted | same id, different digest | park both copies; neither proves coverage |
| `provenance` | record id | same id, same digest | same id, different digest | park both; the commit shows no provenance from either |
| `resolution` | record id and ref name | same id, same digest; same ref, same target | same id, different digest; same ref, different target | park the record, refuse the ref; the candidate leaves the catalog |
| retention ref | derived | always merged (ADR-0025) | never | not applicable |
| `note` container | attachment | rewritten only by vlab under the notes lock | any Git-level merge strategy | forbidden: no `git notes merge` on `refs/notes/vcs-lab` |
| `logical-id` (`ch_*`) | trailer text | exact copies (FR-ID-02) | not a record; competing bearers are an identity collision | reported by `vlab audit identity`, unchanged here |
| private, shared-local, tracked, envelope scopes | not portable | not merged | not merged | ADR-0020 refusal stands |

Same signature with a different result is not a conflict. It is the
ambiguity ADR-0007 already defines, and a rejection in one operation is that
operation's outcome, not a fact about the candidate. Retiring a candidate from
the catalog is a separate catalog decision, not part of this policy.

### What a plan concludes while a conflict is unresolved

A conflicted fact is quarantined: it contributes no `receipt-commit`,
`receipt-change-id`, or resolution candidate. The affected change is
classified from the evidence that remains, so it moves down the ADR-0004
lattice to `candidate-equivalent` or `new`, never up. The plan, forecast, and
receipt carry a `quarantinedFacts` list naming the ids reachable from the
target that were excluded, so a reviewer can see that coverage was computed
on reduced evidence. Nothing blocks: a single bad or disputed record from a
peer must never stop local work (NFR-SEC-03), and replaying a change that was
in fact landed is recoverable, while omitting one that was not is data loss.

`acceptedCausalRecords` must apply the same identity checks as the snapshot,
so the planner, the resolution catalog, and `vlab metadata status` cannot
disagree about which facts exist. That correction is filed as
[#87](https://github.com/jwh3times/vcs-lab/issues/87) and does not wait for
this decision, because it restores the quarantine ADR-0010 already promises.

### Parking

`vlab metadata import` keeps its default: one conflict makes the envelope
inapplicable and no ref moves. It gains `--park-conflicts`, which applies the
non-conflicting records and refs atomically and writes each conflicting
incoming record, with its envelope hash and source lineage, under
`refs/vcs-lab/quarantine/<lineage>/<record id>`. Parked records are
inspectable, are excluded from every reader and from export, and are listed by
`vlab metadata status` beside the local copy they dispute. An automatic
transport (#37, #40) may run only in this mode: it never refuses a whole
exchange because of one record, and it never overwrites.

### Disposition

A person resolves a parked conflict with an explicit command that records a
`vcs-lab.disposition/v1` entry in a shared-local registry (a new row in
ADR-0020's table when implemented): the record id, the kept digest, the
rejected digests, and a free-text reason. Two outcomes exist:

- **keep local**: the parked copy is deleted, the local copy returns to
  service, and later arrivals of a rejected digest are reported as already
  disposed rather than parked again;
- **replace local**: the local note record is rewritten to the parked
  content under the notes lock, the previous digest is recorded as rejected,
  and the fact returns to service with the peer's content.

The registry is local on purpose. Two clones may dispose the same conflict
differently, and that disagreement is real; each exchange then reports it as a
known, disposed conflict instead of hiding it or re-parking it.

### Composition with ADR-0020

Unknown-version shared-portable records stay quarantined as today. A record
whose id matches a local one under a different schema version is a conflict:
migration by rewriting a peer's note is already forbidden, so the pair cannot
both be legitimate. Refuse-scoped families never merge, so no conflict policy
applies to them; the disposition registry itself is shared-local and is
refused on an unknown version like the workspace registry.

## Rejected alternatives

- **Last writer wins.** A later writer overwrites an earlier claim; this is
  exactly the outcome the floor forbids.
- **Newest timestamp wins.** Record clocks partition identifier space and are
  never sort keys for decisions (`docs/identity/`); a peer's clock proves
  nothing.
- **Majority of clones.** Clones are not independent witnesses, and a forged
  fact copied to two clones would outvote the original.
- **Union.** Git's union strategy produces a malformed container, and a
  semantic union of absorbed sets would let one altered receipt inject
  coverage for changes that never landed.
- **Refuse the whole exchange, always.** Correct for a manual import, and it
  stays the default there, but as the only mode it lets one disputed record
  from one peer stop every fact from that peer.
- **Local always wins silently.** Keeps local facts but hides that a peer
  disagrees; parking keeps the same facts and shows the disagreement.

## Consequences

- Automatic synchronization has a defined behaviour and can be designed.
- The planner and the catalog change: id-conflicted facts stop proving
  coverage, which can move a change from `covered` to `new` in a repository
  that holds an altered receipt. That is the correct direction.
- A new ref namespace, a new shared-local family, one import flag, and a
  disposition command are required; `docs/schemas/compatibility.md` and
  `RECORD_FAMILIES` change in the same commit as the registry.
- Nothing here authenticates a claim. Which copy is true remains a trust
  question (#38); this policy only guarantees that neither copy is used until
  someone decides.

## What the owner must decide

1. Identity as the sole conflict key, including the new one-record-per
   attachment rule for receipt families.
2. Park-and-report as the explicit import mode and the only automatic mode.
3. A local disposition registry with keep-local and replace-local outcomes,
   versus no memory and a re-reported conflict on every exchange.
4. That conflicted facts reduce evidence but never block a mutation.

## Owner decision (2026-09-17)

Accepted with one amendment to decision 1.

1. **Identity is the sole conflict key; the one-record-per-attachment rule is
   dropped.** The proposal also treated two receipts of one family on one
   attachment commit as a conflict, on the premise that every receipt family
   writes exactly one record onto the commit it creates. That premise is false:
   in a disposable repository on 2026-09-17, `vlab reconcile feature` run a
   second time with every change already covered attached a second
   `reconciliation` receipt to the same result commit, so the rule would have
   quarantined a legitimate receipt on an ordinary re-run. The per-family table
   and the policy text above reflect the amendment. A forged receipt under a
   new identifier is an identity question for `vlab audit identity`, not a
   conflict.
2. Park-and-report is accepted: the explicit import keeps its refuse default
   and gains `--park-conflicts`, the only mode automatic transport may use.
3. The local disposition registry with keep-local and replace-local outcomes
   is accepted.
4. Conflicted facts reduce evidence and never block a mutation.
