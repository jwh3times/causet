# ADR-0021: Give failures a versioned, machine-readable envelope

- **Status:** Accepted
- **Date:** 2026-08-31
- **Owners:** Repository maintainers
- **Related requirements:** FR-GIT-06, NFR-SEC-03, NFR-TEST-03
- **Tracked by:** [issue #12](https://github.com/jwh3times/vcs-lab/issues/12)

## Context

`--json` has no effect on the failure path. Every error leaves through one
boundary in `bin/vlab.js`, which prints `vlab: <message>` and an optional
detail line to stderr and sets an exit code. stdout stays empty. A caller that
asked for JSON gets JSON on success and prose on failure, and the only
machine-readable signal is an exit code that is `1` for nearly everything,
because `CliError` defaults to it.

This was tolerable while failures were mostly "you did something wrong."
[ADR-0020](0020-freeze-per-family-compatibility-and-resource-bounds.md)
changed that: refusal is now a *contractual* outcome with a specified cause.
An unreadable schema version, a record of the wrong family in a store, and an
exceeded resource bound are each a deliberate, documented behavior, and each
implies a different response:

| Cause | What a caller should do |
| --- | --- |
| Unknown schema version | Retry with the build that wrote the record |
| Wrong-family record in a store | Stop and surface to a human |
| Resource bound exceeded | Reduce the input, or raise the bound deliberately |
| Stale forecast or plan | Regenerate and re-approve |
| Anything else | Treat as a defect |

The compatibility contract specifies precisely which refusal happens, and
automation cannot read it. `docs/conformance/` pins the success path field by
field; the failure path has no contract at all. That asymmetry is the gap.

This ADR records the decision to close it and the shape of the contract. It is
**Proposed**: no implementation exists, and none should begin until it is
accepted, because it publishes a vocabulary that then has to be maintained.

## Decision

Failures gain a versioned envelope, `vcs-lab.error/v1`, and every raised error
carries a stable classification code.

1. **`CliError` carries a `code`** — a kebab-case slug from a published,
   closed vocabulary — alongside its existing `message`, `details`, and
   `exitCode`. A raise site without a code is a defect the suite catches;
   `unknown` is not a permitted value.
2. **The vocabulary is a published contract**, catalogued beside the record
   families in `docs/schemas/` and versioned with the envelope. Adding a code
   is an additive change inside `v1`; removing one, or changing what a code
   means, is a version bump. This mirrors the compatibility rules ADR-0020
   fixed for record families.
3. **The envelope prints on stdout when the invocation requested `--json`**,
   as `{schema, code, message, details, exitCode}`, and stderr stays empty in
   that mode. Without `--json`, today's stderr prose is unchanged. Automation
   parses one stream; humans keep the stream they read.
4. **Exit codes stay coarse.** The `code` field carries the classification;
   exit codes remain "0 success, non-zero failure" plus the few distinct
   values that already exist. Encoding a growing vocabulary into an 8-bit
   exit status is not worth the compatibility cost.
5. **The conformance fixtures extend to the failure path**, so a raise site
   that loses its code, or a code that stops appearing, fails the suite the
   way a dropped output member already does.

### Deliberately unresolved here

- **Pre-dispatch failures stay text.** `--json` is parsed per command, after
  the command word, so an unknown command or a malformed global flag fails
  before any `--json` is in scope. Those keep prose on stderr; the envelope
  covers failures from dispatch onward. Making the flag global would change
  argument parsing for every command and is a larger change than this buys.
- **Whether codes are namespaced per record family** (matching
  `RECORD_FAMILIES`) or live in one flat namespace. The flat namespace is
  simpler and probably right, but the question should be settled against a
  real enumeration of raise sites, not in advance.
- **Whether `details` stays free text** or gains structured members for the
  cases that have them (the bound that was exceeded, the versions a build
  reads). Structured detail is more useful and more expensive to freeze.

## Amendment 2026-09-01: what implementing it settled

Implemented across 232 raise sites in 20 modules, with 41 codes. The three
questions this ADR deliberately left open are answered by the enumeration it
asked for rather than in advance:

- **The namespace is flat.** Codes cluster by *cause* — usage, repository
  state, Git transport, schema, staleness — and one cause routinely spans
  several record families: `resource-bound-exceeded` covers notes, envelopes,
  and manifests alike. A per-family namespace would split a single caller
  response across several names while adding nothing the family-carrying
  `message` does not already say.
- **`details` stays free text.** No structured member earned its place: the
  cases that have structure (the bound that was exceeded, the versions a build
  reads) already state it in prose the human path prints, and freezing a shape
  for them would be a contract to maintain before anything consumes it.
- **The pre-dispatch boundary is narrower than this ADR expected.** It is not
  "before the command word": `parseArgs` runs on the remaining arguments
  whether or not the command name is known, so `--json` is in scope by the
  time dispatch rejects an unknown command, and that failure *is* enveloped.
  What stays prose is only the global flags consumed before that parse —
  a `--git-session`/`--no-git-session` conflict, a bad `--forecast-engine` or
  `--engine` value. The boundary is therefore the argument parse, not the
  command word.

One correction came out of running it rather than reading it. A caller naming a
reference that does not exist was first classified `git-response-malformed`,
whose published advice is to report a Git bug. The raise site is shared between
"an expression did not resolve" and "Git returned an unparsable line", and only
the second deserves that code; the first is `revision-not-resolved`. A
vocabulary is only as good as the classification behind it, and that one was
found by reading the envelope of an ordinary typo.

## Constraints

- The vocabulary is closed and published; a code that is not in the catalog is
  a defect, not an escape hatch.
- Human output does not change. This adds a mode; it does not reword prose
  people already read.
- No code may leak repository content, file contents, or commit messages
  (NFR-SEC-02); a code plus already-shown identifiers only.
- Adding the envelope must not change any exit code that exists today.

## Consequences

### Positive

- The refusals ADR-0020 made contractual become machine-readable, so a caller
  can distinguish "your build is too old" from "your input is too big" without
  matching English.
- The failure path gains the same kind of pinned contract the success path got
  in phase 0b, closing the FR-GIT-06 asymmetry.
- A native or gateway implementation has one error contract to reproduce
  rather than a set of message strings.

### Negative

- A published vocabulary is a maintenance obligation: every new raise site
  needs a code, and codes cannot be renamed casually.
- Every `CliError` raise site is touched, which is broad if shallow.
- Two output modes on the failure path is more surface than one.

## Alternatives considered

- **Leave it.** Exit code plus prose is what most CLIs do, and FR-GIT-06 is
  arguably satisfied because the requirement speaks to state, not failure.
  Rejected because ADR-0020 made the *cause* of a refusal part of the
  contract, and a contract that cannot be read is not much of one.
- **Distinct exit codes per cause.** Conventional and needs no envelope, but
  256 values, no room for detail, and every new cause is a compatibility
  event.
- **Structured errors on stderr.** Conventional for diagnostics, but a caller
  parsing stdout for success and stderr for failure has to handle two streams
  and two formats; and stderr is where Git's own noise already goes.
- **Reuse an existing convention (RFC 9457 problem details).** Designed for
  HTTP, carries URI-shaped type fields this project has no use for, and would
  import a vocabulary rather than publish one that matches the record
  families.

## Implementation map

- Decision and open questions: this ADR, issue #12
- Error boundary: `bin/vlab.js`, `src/errors.js`
- Raise sites: every `CliError` in `src/`
- Published vocabulary: `docs/schemas/` beside the record families
- Coverage: `docs/conformance/` extended to the failure path
