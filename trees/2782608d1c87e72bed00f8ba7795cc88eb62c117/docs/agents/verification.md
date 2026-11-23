# Verification

How to check that a claim about this code, or about a measurement, is true before reporting it.
Each rule here comes from a wrong report that reached the owner.

## Run the control

A reproduction's number means nothing without a control that differs in only the one thing under
test. A count of 0 once "showed" that a note under an uppercase path hides `cst provenance`, but
the fixture's note held no provenance record, so the count was 0 before the write too. The
lowercase control showed the real effect. Read the state before the write as well as after it, and
run the control before stating a consequence.

## Check generated work with a broader pattern

When a script generates many artifacts, validate them with a pattern broader than the one that
produced them, then read back one published copy. A `\{([A-Z]+)\}` substitution skipped keys with
digits such as `{A1}`, and the validation reused the same pattern, so it passed while 16
placeholders shipped across 7 issues. `\{[A-Z][A-Z0-9]*\}` would have caught them.

## Read the issue's comments, not its body

An issue's checkboxes go stale. Before claiming work is still open, read the comments
(`gh issue view <n> --comments`): #14's body listed three items that its comments showed had been
done for two weeks.

## Judge performance against the floor

An absolute budget ("no phase over 1,000 ms") can't see overhead. On Windows each Git process costs
about 35-45 ms whatever it does, against 3-9 ms on Linux, so a 510 ms command can be 88% process
start-up and still pass. Report the ratio to the raw-Git floor that `npm run test:benchmark`
prints, not only the absolute figure.

ADR-0022 found that quadrupling history depth changed nothing, so process launch, not traversal,
dominates the cost. Cite it as evidence about what dominates, never as evidence against native
work.

## Whole-store cost needs the corpora

The suites' repositories are too small for a cost proportional to the number of objects to show. A
change once tripled git/git's corpus job and timed it out on Windows while PR CI stayed green.

`corpora.yml` runs for a PR touching `native/import`, `native/store` or `native/history`, but not
`native/engine`, `cli`, `core` or `model`. For a change in those that can affect whole-store cost,
before landing either time `cst import --verify` and `cst fsck` on an import of this repository
against the previous build, or dispatch `gh workflow run corpora.yml --ref <branch>`.

Reading a corpora run: each real-repository job logs `<name>: import costs {...}` and
`<name>: cst store <n> bytes, ...`. Grep the job log for `import costs` and
`': (cst store|native history) '`. Windows reports `peakMemory: null`.

## A port is shaped by its first caller

Code built for one caller can be silently incomplete for the next. The Rust spec planner built only
result hashes, because `spec status` compacts the rest away, and `spec merge-plan` was the first
caller to need more. When a second caller starts using existing code, test what that caller needs,
not what the first one tested.
