# Documentation

The repository keeps current product, architecture, testing, and decision
records here. The root README is the user-facing entry point; the changelog is
the versioned record of delivered behavior.

## Current references

- [Product requirements](product.md) — product intent, requirements, priorities,
  success metrics, quality gates, investment themes, the native implementation
  gates, and the trace from every incomplete requirement to its issue.
- [Architecture](architecture.md) — implemented components, persisted state,
  runtime flows, invariants, failure handling, and known debt.
- [Schema catalog](schemas/README.md) — one JSON Schema document per persisted
  and automation-facing record family, and the CLI JSON output contracts.
- [Compatibility contract](schemas/compatibility.md) — what may change inside a
  version, which versions each family reads and writes, what happens to a
  version this build does not know, and the resource bounds on every record.
- [Human/JSON conformance](conformance/README.md) — which command output is
  text, which is JSON, and which members the two renderings must agree on.
- [Logical identity protocol](identity/README.md) — the identifier form,
  namespace set, entropy, and cross-repository import rule.
- [Canonical JSON profile](canonical-json/README.md) — the frozen RFC 8785
  serialization profile, encoder registry, and shared test vectors.
- [Testing](testing.md) — supported validation commands and release evidence
  policy.
- [Benchmark host baselines](testing.md#benchmark-regression-check) — machine
  labels, recording, skipped latency, and qualification requirements; the
  [wiki walkthrough](https://github.com/jwh3times/vcs-lab/wiki/Benchmark-host-baselines)
  provides a quick operational guide.
- [Required human follow-ups](human-followups.md) — agent completion policy for
  public follow-up issues/wiki, private board tracking, and restricted security advisories.
- [Architecture decision records](adr/README.md) — decisions whose constraints
  should survive refactoring.

## Where future work lives

Future work is tracked on the
[vcs-lab project board](https://github.com/users/jwh3times/projects/7), one
issue per increment, each with a Status, the Gate that must clear before it can
start, and an Area. The board replaced `docs/roadmap.md` on 2026-09-04 and the
continuation brief `docs/handoff.md` with it, so there is no Markdown backlog to
keep in sync with the tracker.

What did *not* move: the investment criteria the board's gates refer to. The two
native implementation gates, the evidence rows that permit a next step, the
native-core phase sequence, and the incomplete-requirement trace are in
[product.md §15](product.md); the inherited invariants are §7; the open product
questions are §17, each citing the issue that will settle it.

## Documentation lifecycle

Commit documentation when it describes a current contract, a durable decision,
or maintained user behavior. Keep it independent of a particular workstation,
temporary directory, session, commit under test, or fixed test count.

Use the project issue tracker for active work, bugs, implementation briefs, and
session handoffs, and for dated progress on a maintained document's subject —
what landed when belongs on the issue, not restated in the document. Use pull
requests for implementation rationale and test summaries. Use CI job summaries
and retained CI artifacts for individual test runs, logs, hashes, and
host-specific evidence. Use GitHub Releases and the changelog for release
history; the changelog is the one dated narrative.

Do not add an archive directory for superseded session or test documents. Git
history already preserves deleted versions. Add a dated incident document only
when an event has durable operational lessons not captured by an ADR,
regression test, or changelog entry.

Performance results belong in an ADR when they support a decision. Commit a
machine-readable benchmark baseline only when an automated regression check
consumes it; otherwise retain the result with the relevant issue, pull request,
or CI run.

Required human actions left by agent-completed work follow
[the handoff policy](human-followups.md): a labeled public issue, membership on
the private project board, and a linked public wiki procedure with step-by-step
execution and verification. The wiki's `human-todo` page indexes those issues and
instructions; it is not an in-tree backlog or a replacement for issue status.
Sensitive vulnerability actions use draft repository security advisories with
restricted instructions and access-appropriate private board tracking until
public disclosure is authorized.
