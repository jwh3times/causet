# Semantic-merge conformance

[fixtures.json](fixtures.json) is the shared semantic-merge fixture catalog for
FR-SPEC-13. It exercises the [adapter contract](../structured-document-adapters.md)
against the real CLI. It is separate from
[human/JSON conformance](../conformance/README.md), which checks presentation.

Run `node --test test/semantic-conformance.test.js`, or `npm test` for the full
suite. Fixtures use disposable Git repositories and require no remote service.
The caller's selected Git session and read engine are honored. The ordinary CI
suite runs the fixtures on Windows and Ubuntu; manual qualification also runs
them in the forced modes described in [testing.md](../testing.md).

## Fixture contract

The catalog is versioned as `vcs-lab.semantic-conformance-fixtures/v1`. It is a
test artifact, not a new runtime record family. Each profile names its parser,
merge algorithm, and writer manifest version. Top-level `coverage` lists shared
rules; profile `coverage` adds format-specific cases such as Markdown heading
boundaries. Every profile must cover every shared rule and its own declared
rules. Missing rules, undeclared rules, duplicate case IDs, or profiles without
runners fail the suite.

Each case contains:

| Field | Meaning |
| --- | --- |
| `id`, `rule`, `profile` | Stable case name, coverage obligation, and adapter/version profile |
| `stages` | Ordered `base`, `ours` (target), and `theirs` (source) inputs |
| Stage `text` | Literal source text, with JSON escapes preserving CR, LF, tabs, and trailing spaces; null means absent |
| Stage `entities` | Exact ordered semantic keys expected from indexing, including query-only entities |
| Stage optional inputs | `artifactId`, `idOverrides`, and `metadata` construct identity and compatibility/refusal cases |
| `expected` | Exact observable plan: status, decision counts, ordering decision, sorted conflict types, and result |
| Result | Null for a blocked plan; otherwise deletion flag, literal rendered text, and ordered result entity keys |
| `knownFailure` | Historical v1 defect, prior plan, and desired observation exercised by the v2 profile |

Expected text and classifications are authored examples. They are not generated
from a run or recomputed with the parser/merge implementation. Comparing complete
projected observations catches both missing and extra decisions, blockers, and
entities, as well as any changed rendered byte. Variable diagnostics and random
IDs are not snapshots: IDs are checked for preservation across matching keys
and against the inputs selected into the result.

The Markdown runner in
[test-support/semantic-conformance.js](../../test-support/semantic-conformance.js)
creates committed stages through `vlab spec index` and observes materialized
entities through `vlab spec show`. It constructs malformed, stale, future-version,
and legacy metadata only as fixture inputs. It invokes `vlab spec merge-plan`
twice on identical ordered revisions, requiring identical output and unchanged
HEAD/worktree state. Indexing must preserve the original document bytes and
write sparse manifests. Production parser and merge internals are not imported.

The legacy-v2 case supplies a deliberately exceptional ID and checks that merge
preserves it in a v4 result. Broader migration, resource-bound, forecast,
application, and recovery coverage remains in the integration and hostile-input
suites. This fixture suite does not replace those workflow tests.

## Versioned fenced-code behavior

The `markdown-v2` profile exercises corrected parsing and all shared rules.
The `markdown-v1` profile constructs historical v3 metadata explicitly and
verifies that reads keep their old entity boundaries. Both use the current v2
planner: compatible old inputs merge; affected old inputs block with
`parser-migration-required` rather than reproduce the old false-clean result.

Historical entries retain `knownFailure` to identify the original #51 case.
Its `historicalPlan` documents the prior observation; it is not a runnable
legacy merge implementation. Its `desired` observation is exercised by the
corresponding v2 case. The v1 entity expectations and current migration blocker
are tested directly, with no skipped or expected-failure tests. Catalog checks
reject stale historical markers whose expected and desired observations agree.

Fixtures cover backticks and tildes, longer fences, three-space indentation,
shorter and mismatched closers, unclosed fences, same-section divergence, and
interior whitespace. Four-space indentation remains outside the supported
fence grammar. [ADR-0026](../adr/0026-version-fence-aware-markdown-boundaries.md)
is the syntax and compatibility authority. Additional real-CLI migration,
information-string, closing-suffix, cache, identity, forecast, and recovery
coverage lives in [spec-fences.test.js](../../test/spec-fences.test.js).

## Extending the suite

Add an independently worked input and literal expectation for a new behavior,
then run the focused suite. Update coverage deliberately; deleting its only case
must not silently remove an obligation. Do not record current output as an
oracle to make a failing case green.

For a new adapter, add a profile and runner that supplies the same observable
shape through its public interface. Supply native-format inputs for every shared
rule and declare its own format-specific rules. The runner mapping and profile
catalog must agree in both directions. Define entity keys, merge units, ordering,
rendering, and compatibility in that adapter's specification; the shared suite
does not require other formats to use Markdown headings. A second adapter still
needs the full acceptance evidence in the adapter contract, including resolution
of applicable known defects.
