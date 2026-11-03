# ADR-0043: Order the native transition by dependency, starting with N1

- **Status:** Accepted (owner, 2026-10-17)
- **Date:** 2026-10-17
- **Owners:** Repository maintainers
- **Related requirements:** GP-12, FR-TRUST-02, FR-SPEC-*
- **Builds on:** [ADR-0041](0041-make-cst-a-standalone-distributed-version-control-system.md),
  [ADR-0042](0042-grow-the-native-system-as-a-shadow-with-one-kind-per-repository.md)
- **Amends:** [ADR-0015](0015-adopt-a-phased-native-core-program-with-rust.md),
  [ADR-0023](0023-locate-the-model-substrate-mismatch-in-facts-not-content.md)
- **Decided on:** [#283](https://github.com/jwh3times/causet/issues/283), under the
  [transition map](https://github.com/jwh3times/causet/issues/281)

## Context

ADR-0041's phase map names the scope of N1–N6 and puts the Git bridge (N6) last.
It leaves the order of N1–N5 a proposal, and ADR-0041 allowed one alternative
start: native facts over Git content, ADR-0023's path. ADR-0042 then made every
repository wholly native or wholly Git-backed, and limited cst over Git (N0) to
what the transition needs.

The phases have no dates (owner, 2026-10-17). What limits them is what each one
reads and writes, and how much the owner can review at once.

## Decision

1. **N1 comes first.** A canonical fact log over Git content would be a
   Git-backed repository with a native part, which ADR-0042 rejects, and a new
   N0 contract that produces no design evidence. Inside the native system, data
   fixes the order anyway: history objects point at snapshots, and facts point
   at history.
2. **The phases depend on each other as follows:**

   ```
   N1 content store + import
    └─► N2 history, fact log, branches, declared actors
         ├─► N3 working copy, workspaces, index ─► N4 merge, forecast, section identity
         └─► N5 transport, then acceptance points
                             (N1–N5 all exited) ─► switch-over allowed (ADR-0042)
                                                ─► N6 Git bridge
   ```

   - N2 needs N1: history points at snapshots.
   - N3 needs N2: a working copy commits into history.
   - N4 needs N3: conflicts are resolved in a working copy.
   - N5 needs only N2: it exchanges objects and history, so it runs beside the
     N3 → N4 chain.
   - Switch-over, and then N6, follow only once N1–N5 have all exited.
3. **N5 is one phase with two ADRs,** in order: transport between peers (with
   lazy fetch), then acceptance points (verified identity, policy and locks).
   Switch-over needs both, as ADR-0042 already requires.
4. **Entry and exit:**
   - **Entry:** a phase may write its ADR and begin building once every
     predecessor's ADR is accepted. That is when the formats it builds on are
     fixed.
   - **Exit:** a phase may exit only after every predecessor has exited, by the
     exit criteria every phase ADR cites
     ([#284](https://github.com/jwh3times/causet/issues/284)).
   - **Reopening:** if a predecessor's format changes during its build, the
     dependent phase reopens to match. With no format promise yet (ADR-0042,
     decision 5), that costs a re-import, not a migration.
5. **At most two phases are in build at once.** The owner may lower the limit
   at any time.
6. **Typed actors enter with N2.** N2's history and fact objects carry each
   action's typed actor as a declared claim, the same shape as today's
   `causet.provenance/v1`. N5 adds verification. Adding the actor later would
   mean a format change, and decision 9 of ADR-0041 requires it to cross the
   bridge.
7. **Section identity is built with N4.** N1's ADR must show that its object
   model leaves room for stable section identity (ADR-0041, decision 8).
   Section identity and deterministic section merge are built in N4, with the
   merge that uses them.
8. **ADR-0015's remaining phases stop or move.** All of them speed up or extend
   Git-backed repositories, which ADR-0042 decision 7 does not admit.
   - The wider phase-1 exit, and phases 2–4 (native planning and status, the
     derived catalog, in-memory forecasts and native mutation), stop.
   - Phase 5's scope (a canonical fact log, fact transport, private draft
     stacks) moves into N2, and its transport into N5.
   - Phase 6's remote program (portable verification, capability negotiation,
     actor trust, landing policy) moves into N5.
   - The bounded native read engine that shipped (ADR-0027) stays as it is.

## Constraints

- **The bridge still constrains every phase.** "Bridgeable from the start"
  (ADR-0041) applies to each phase ADR, whatever its place in the order.
- **Design evidence feeds the phase that uses it.** Gate B's conditions, restated
  as design evidence, inform the matching phase ADR:
  - conditions 1 and 2 (compact landing, stable logical IDs) inform N2;
  - condition 4 (workspaces and checkpoints) informs N3;
  - conditions 3, 5 and 6 (forecasts, resolution reuse, specification merge)
    inform N4;
  - condition 9 (real agent workloads) informs every phase.
- **N2–N6 ADRs are written when their phases enter,** not ahead of time.

## Consequences

### Positive

- The first native work has a single, small entry: N1, with nothing else in
  flight until its ADR is accepted.
- N5 can proceed beside N3 and N4, so the longest chain is N1 → N2 → N3 → N4.
- Actor identity is in the data model from the first native history, so typed
  actors never require a format migration.
- Work on Git-backed performance stops competing with the native phases.

### Negative

- **Nothing native ships to users before switch-over,** which needs all of
  N1–N5 (ADR-0042). The order shortens that wait but does not remove it.
- **Entering on predecessors' accepted ADRs risks rework** when a format proves
  wrong during its build. The reopening rule accepts that cost in exchange for
  overlap.
- **ADR-0015's planned performance work for Git-backed repositories won't be
  done.** Users who stay on Git until N6 keep today's performance.
- **N5 carries two designs** in one phase, and it is the last phase before
  switch-over.

## Alternatives considered

- **Native facts over Git content first (N2 first).** Rejected: ADR-0042 rules
  out a repository with native and Git-backed parts.
- **Strictly one phase at a time.** Rejected: agents would sit idle while the
  owner reviews.
- **No limit on phases in build.** Rejected: review bandwidth is the real limit,
  and the owner names it.
- **N4 straight after N2, as a virtual merge with no working copy.** Rejected:
  it splits N4 in two for little gain.
- **N5 split into two phases, with switch-over after transport.** Rejected:
  ADR-0042 ties switch-over to acceptance points existing, and ADR-0041 already
  allows two ADRs in one phase.
- **Typed actors arriving whole in N5.** Rejected: it means a format change in
  N2's objects.
- **Section identity built in N1.** Rejected: it enlarges N1 before there is a
  merge to use it. The room-for-it constraint keeps the option open.
- **ADR-0015's phases continuing beside N1–N6.** Rejected: ADR-0042 limits N0
  to what the transition needs.
