# ADR-0046: Give a native repository Git's everyday verbs and cst's own commands

- **Status:** Accepted (owner, 2026-10-17)
- **Date:** 2026-10-17
- **Owners:** Repository maintainers
- **Related requirements:** GP-01, FR-GIT-01
- **Builds on:** [ADR-0041](0041-make-cst-a-standalone-distributed-version-control-system.md),
  [ADR-0042](0042-grow-the-native-system-as-a-shadow-with-one-kind-per-repository.md),
  [ADR-0045](0045-build-n1-as-a-whole-content-store-with-lossless-git-import.md)
- **Bounds:** [ADR-0040](0040-make-cst-the-one-command-carrying-records-over-git-remotes.md),
  whose passthrough to Git applies to Git-backed repositories only
- **Decided on:** [#288](https://github.com/jwh3times/causet/issues/288), under the
  [transition map](https://github.com/jwh3times/causet/issues/281)

## Context

One `cst` executable serves both kinds of repository, split at the command level
(ADR-0042). In a Git-backed repository, cst answers about 60 command forms of
its own, and every other word passes through to Git (ADR-0040). Users and agents
already type `cst status`, `cst log` and `cst add`, and get Git's answers.

A native repository has no Git to pass to. ADR-0042 left three things to this
decision: its command surface, what replaces the passthrough, and what it prints
as an object ID.

Two facts about the published contracts bear on the ID question:
- **The schemas constrain object IDs to hex.** About 80 patterns accept
  40 or 64 hex characters.
- **Changing them means new versions.** Under the compatibility contract
  (`docs/schemas/compatibility.md`), narrowing or changing a member's accepted
  values requires a new schema version.

## Decision

1. **The vocabulary is Git's everyday verbs plus all of cst's own commands,**
   under the same names in both kinds.
   - **Git's verbs:** init, clone, status, add, restore, commit, log, show,
     diff, branch, switch, merge, rebase, cherry-pick, tag, fetch, pull, push,
     reset, rm, mv.
   - **cst's own commands:** workspace, reconcile, forecast, resolve, spec,
     provenance, metadata and the rest, with their names and contracts.

   The words a user types in a Git-backed repository keep working after
   switch-over.
2. **Output is cst's own, except where scripts parse it.** Each command has
   cst's own human output, a `--json` form, and Git's common flags wherever
   their meaning carries over. Git's script-facing machine formats are
   reproduced byte for byte:
   - `status --porcelain`, v1 and v2;
   - the `--format` placeholders of `log` and `show`;
   - `-z`;
   - `diff --name-only`, `--name-status` and `--stat`.

   Their equality test (ADR-0044) is byte-identical against Git's output on the
   Git-backed original, with IDs translated through the alias map.
3. **Plumbing is a minimal set:**
   - `rev-parse`;
   - `cat-file` (`-p`, `-t`, `-s`, `--batch`);
   - `ls-tree`;
   - `for-each-ref --format`.

   Each is byte-identical to Git's output, IDs translated. Every other plumbing
   command is refused.
4. **A native repository has no passthrough.** `cst git …`, and any word cst
   does not implement, is refused with a new error code. Where a native command
   does the job, the error names it. ADR-0040's passthrough stays, unchanged,
   for Git-backed repositories. Commands about Git itself, such as pushing to a
   Git forge, get their own words with the bridge in N6.
5. **Object IDs print as plain hex.** A native repository prints the
   64-character lowercase hex of the SHA-256 digest, abbreviated by unique
   prefix. The algorithm tag stays in the binary encoding (ADR-0045). Every
   existing schema validates unchanged, so "Contracts outlive the substrate"
   (ADR-0041) holds literally.
   - **Git IDs appear only where asked for:** as an optional `gitId` member on
     bridged objects (an addition the compatibility contract allows within a
     version), or through a `--git-id` flag.
6. **One error registry serves both kinds.** Native-only failures (for example,
   no Git here, or content absent by policy) get new codes in the same
   catalogue, `docs/schemas/errors.md`. Each is added when the phase that raises
   it is built. Every existing code keeps its meaning wherever its situation
   recurs in a native repository.
7. **Each phase owns its commands,** and its phase ADR specifies their flags and
   output within these rules:
   - **N2 (history):** log, show, branch, tag, provenance, receipts, metadata.
   - **N3 (working copy):** init, status, add, restore, rm, mv, commit, switch,
     reset, workspace.
   - **N4 (merge):** merge, rebase, cherry-pick, reconcile, forecast, resolve,
     merge-plan, spec.
   - **N5 (transport):** clone, fetch, pull, push, plus the commands for
     acceptance and policy.
   - **N6 (bridge):** the commands that face Git.
8. **Help follows the repository's kind.** In a native repository, `cst --help`
   lists that kind's surface. In a Git-backed one it stays as it is, ending with
   "every other command is Git's". Outside any repository it shows both.
9. **N1's experimental commands take their final names** (ADR-0045 decision 11).
   All stay behind the experimental opt-in:
   - `cst cat-file` and `cst ls-tree` read a file and list a tree;
   - `cst rev-parse` and `cst for-each-ref` read the ref snapshot;
   - `cst fsck` verifies the store and reports the three object states;
   - `cst import --verify` runs the reconstruction check.

## Constraints

- **A machine format is either byte-identical or absent.** A native command
  never prints a near-copy of one of Git's script-facing formats.
- **Byte-identical commands answer as Git does.** Wherever this ADR names Git's
  output as the contract, the oracle is Git's output on the Git-backed original.
- **The `gitId` member stays optional.** No consumer can rely on it existing for
  objects that were never bridged.

## Consequences

### Positive

- At switch-over, people, agents and scripts keep their words and their parsed
  formats.
- No record family needs a new schema version, and the equality comparator
  translates IDs only.
- Git's machine formats give the equality test a byte-exact oracle for the core
  verbs.

### Negative

- **Reproducing Git's machine formats is exacting work,** and N2–N4 must each
  match them exactly.
- **A native ID and a Git SHA-256 ID look the same.** Output that shows both
  relies on the `gitId` member to tell them apart.
- **Scripts that parse Git's human output will break at switch-over.** Only the
  machine formats are kept.
- **Everything Git offers beyond this set is refused** in a native repository.

## Alternatives considered

- **cst's own vocabulary only,** as Jujutsu chose. Rejected: it breaks habits
  and scripts at switch-over.
- **A new vocabulary designed for the native model.** Rejected for the same
  reason.
- **Full Git flag and output fidelity.** Rejected: it would make Git's whole
  interface a contract.
- **cst's own output only, with no machine formats.** Rejected: scripts and
  agents parse those formats, and they give the strongest oracle.
- **Emulating Git through an exported view** after N6. Rejected: it makes Git's
  whole command set an implicit contract.
- **A distinct textual form for native IDs.** Rejected: about 30 record families
  would need a new major schema version, for a display concern.
