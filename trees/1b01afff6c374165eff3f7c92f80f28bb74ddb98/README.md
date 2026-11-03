# vcs-lab

`vcs-lab` is a local prototype with a dependency-free Git engine for experimenting with the source-control ideas discussed in this project:

- Git remains a real compatibility and storage layer.
- logical changes keep a stable `Change-Id` across rebase and cherry-pick;
- compact merges retain a real causal parent while displaying as one first-parent landing;
- hard squashes record exactly what they absorbed in a causal landing receipt;
- a merge planner subtracts proven prior work instead of relying only on Git topology;
- causal rebase plans and forecasts preview exact omissions, heuristic reviews,
  replay steps, conflicts, and the predicted tree before a supervised rewrite;
- supervised causal rebase preserves stable intent, pauses and recovers through
  a worktree-private journal, and publishes exact mappings only after success;
- Windows planning and forecasting reuse a worktree-scoped Git object process instead of spawning once per read;
- reconciliation can be forecast in an isolated worktree and pinned before application;
- indexed Markdown can be merged deterministically by stable block identity;
- conflicted reconciliation can pause, survive process exit, continue, or abort safely;
- exact conflict resolutions can be suggested across branches and worktrees with explicit provenance;
- workspaces use real Git worktrees but add path-independent logical metadata and non-disruptive checkpoints;
- Markdown remains canonical while a sidecar gives sections and requirements stable entity IDs.
- repository metadata can be inventoried, validated, quarantined, and moved
  between related clones in an integrity-checked Git-bundle envelope.
- repository and shared-metadata scan costs can be measured in a disposable
  scale fixture before choosing batching, indexes, or a resident service.

This is a laboratory, not a production VCS. Its purpose is to make the semantics observable and falsifiable before designing a native object store or network protocol.

## Documentation map

- [docs](docs/README.md) indexes the maintained product, architecture, testing,
  and decision records and explains where transient evidence belongs.
- [Product requirements](docs/product.md) defines product intent, requirements,
  success metrics, release gates, the investment themes and native
  implementation gates, and the trace from every incomplete requirement to the
  issue that carries it.
- The [project board](https://github.com/users/jwh3times/projects/7) tracks
  future work, one issue per increment, with the gate each is waiting on. It
  replaced `docs/roadmap.md` on 2026-09-04.
- [Architecture](docs/architecture.md) maps the current implementation, schemas,
  runtime flows, safety boundaries, and known debt.
- [Schema catalog](docs/schemas/README.md) publishes one JSON Schema document
  per persisted and automation-facing record family and maps every `--json`
  command to its output contract.
- [Compatibility contract](docs/schemas/compatibility.md) freezes what may
  change inside a schema version, which versions each family reads and writes,
  what happens to a version this build does not know, and the resource bound on
  every record.
- [Human/JSON conformance](docs/conformance/README.md) pins which command
  output is text, which is JSON, and which members the two renderings must
  agree on.
- [Logical identity protocol](docs/identity/README.md) freezes the identifier
  form, namespace set, and entropy, and states plainly that identifiers
  coordinate work rather than authenticate it.
- [Canonical JSON profile](docs/canonical-json/README.md) freezes the
  byte-exact serialization and hashing rules (an RFC 8785 profile) with
  shared cross-implementation test vectors.
- [Architecture decisions](docs/adr/README.md) records constraints that should
  not be casually reversed; [CHANGELOG.md](CHANGELOG.md) records delivered
  behavior by version.

## Requirements

- Node.js 20 or newer
- Git 2.40 or newer (the merge-tree forecast engine, the default on Windows,
  needs Git 2.49 and falls back to the worktree simulator below it)

It has no npm dependencies and does not need a build step.

## Install locally

From this directory:

```bash
npm link
vlab --help
```

Alternatively, run it without installing:

```bash
node /path/to/vcs-lab/bin/vlab.js --help
```

On Windows, use PowerShell, Git Bash, or a terminal where `git` and `node` are on `PATH`.

This project now has its own Git history and should live in a normal development repository. The portable repository bundle retains the release commits and tags:

```bash
git clone /path/to/causal-vcs-lab-0.17.0.bundle vcs-lab
cd vcs-lab
git remote remove origin
npm link
npm test
```

If you instead use the source ZIP, initialize its extracted directory with:

```bash
git init -b main
git add .
git commit -m "Bootstrap causal-vcs-lab 0.17.0"
npm link
npm test
```

## Five-minute experiment

Create a disposable repository:

```bash
mkdir vlab-playground
cd vlab-playground
git init -b main
git config user.name "Local Tester"
git config user.email "tester@example.test"
vlab init
```

Create a base and a feature with stable change identities:

```bash
echo base > app.txt
git add app.txt
vlab commit -m "base"

vlab branch feature
echo feature > feature.txt
git add feature.txt
vlab commit -m "feature part one"
echo more >> feature.txt
git add feature.txt
vlab commit -m "feature part two"
```

`vlab commit` passes `--all` and `--allow-empty` through to `git commit`:
`--all` stages every tracked change first and `--allow-empty` records a
commit whose tree is unchanged. Either way the commit receives its
`Change-Id` trailer.

### Recommended compact landing

```bash
git switch main
vlab merge feature --compact
git log --first-parent --oneline
git show -s --format=%P HEAD
```

The first-parent log contains one landing unit, while the commit has a real second parent. Stock Git can safely merge the branches later.

`vlab compact-merge <source>` is the same landing as `vlab merge <source> --compact`, and `vlab hard-squash <source>` the same as `vlab merge <source> --hard-squash`; `vlab merge` without a mode flag lands compactly. All three print their `vcs-lab.landing/v1` receipt as JSON whatever the flags.

### Strict hard squash and causal reconciliation

Repeat the experiment with another feature:

```bash
git switch -c hard-feature main
echo first > hard.txt
git add hard.txt
vlab commit -m "hard feature one"
echo second >> hard.txt
git add hard.txt
vlab commit -m "hard feature two"

git switch main
vlab merge hard-feature --hard-squash

git switch hard-feature
echo continuation > continuation.txt
git add continuation.txt
vlab commit -m "hard feature continuation"

git switch main
vlab merge-plan hard-feature
vlab reconcile hard-feature
```

The planner should report the first two changes as `covered` by the landing receipt and only the continuation as `new`. `reconcile` cherry-picks only the proven-new change and records another causal receipt.

Inspect the ordinary branch graph together with the causal relationships:

```bash
vlab graph
vlab receipts
```

`vlab graph` deliberately hides internal Git notes and checkpoint refs. Raw `git log --all` includes the history of `refs/notes/vcs-lab`, which can appear as unrelated commits titled `Notes added by 'git notes add'`. For a clean stock-Git view, use:

```bash
git log --graph --oneline --decorate --branches --tags --remotes
```

`vlab receipts` is human-readable by default; use `vlab receipts --json` for the complete machine-readable records.

### Failure output

Every command's failure has a machine-readable form. Without `--json` a failure prints `vlab: <message>` on stderr, as it always has. With `--json` it prints a `vcs-lab.error/v1` envelope on stdout instead, and leaves stderr empty:

```json
{
  "schema": "vcs-lab.error/v1",
  "code": "unknown-schema-version",
  "message": "The reconciliation journal carries unsupported schema \"vcs-lab.reconciliation-operation/v99\".",
  "details": "This build reads v4 of that family.",
  "exitCode": 1
}
```

`code` comes from a closed vocabulary published in [docs/schemas/errors.md](docs/schemas/errors.md), so automation can tell "your build is too old" from "your input is too big" without matching English. Exit codes are unchanged and identical in both modes.

### Authorship provenance

`vlab commit` can declare who produced a change, and the declaration survives the rewrites that destroy ordinary Git attribution:

```bash
vlab commit -m "Add the parser" --generated-by claude-opus-5 --reviewed-by "Jerry Holland"
VLAB_AGENT=claude-opus-5 vlab commit -m "Add the tests"   # an agent harness sets this once
vlab provenance HEAD            # or: vlab provenance main --all
```

When actors are declared by flags or `VLAB_AGENT`, commit takes the shared notes
lock before invoking Git and holds it through provenance publication. A
`notes-locked` refusal leaves HEAD, the index, and worktree content unchanged,
including with `--all`; retry after the holder releases the lock. Commits with no
declared actors do not acquire this lock.

Git commit and note publication are still separate writes. If the note write
fails after commit creation, the error names the retained commit and reports
partial completion. Keep that commit and follow the
[provenance repair procedure](docs/identity/README.md#7-repairing-a-declared-provenance-publication)
instead of blindly repeating the commit.

After a hard squash, `git blame` attributes every absorbed line to the landing commit and the original authorship is gone. The landing receipt already names the absorbed commits, so vcs-lab carries their declared provenance onto the landing as the union of their actors, marked `carried` and naming its sources.

Provenance is **declared, never inferred**. Nothing examines content to guess who produced it, no existing trailer is read as a role, and a commit with no declaration reports nothing rather than falling back to the Git author. The record is an unauthenticated claim by whoever ran the command, not detection and not proof; signing it is a separate, unimplemented layer (FR-TRUST-02).

The planner uses three statuses:

- `=` proven covered by ancestry, stable identity, or a receipt;
- `?` likely patch-equivalent, requiring explicit confirmation;
- `+` new work.

Similarity is deliberately advisory. Run `vlab reconcile <branch> --accept-candidates` only after reviewing candidate equivalence.

### Proof bundles and the identity audit

A plan's verdict can be handed to another party together with the evidence it rests on:

```bash
vlab proof-bundle hard-feature > proof.json
vlab verify-proof proof.json
vlab verify-proof proof.json --offline
```

`vlab proof-bundle` always prints JSON (`vcs-lab.proof-bundle/v1`): the merge plan with the target commits and change IDs, the reachable accepted receipts and what each absorbs, and the advisory patch-equivalent set, hashed under the canonical JSON profile. `vlab verify-proof` re-derives every classification from that evidence with its own copy of the proof lattice and reports three checks separately: `integrity` catches editing, `classification` catches a claim that does not follow from the stated evidence even when the hash was restated, and `repository` checks evidence, the complete ordered source inventory, commit identities and subjects, counts, lineage, and physical/effective bases against the current repository. Duplicate commits and inconsistent counts also fail offline checks. `--offline` skips the repository check: success establishes internal consistency, while evidence truth, source completeness, commit identities, and bases remain unchecked; a bundle from an unrelated repository is reported as `different-repository`. The command exits non-zero when the bundle does not verify.

`vlab audit identity` scans every commit reachable from any ref and every causal record. It reports commits carrying more than one `Change-Id` trailer, commits sharing a `Change-Id` with no identity-preserving application record linking them, applied commits with more than one claimed origin, and records that break the identity invariants, and it exits non-zero when it reports errors (`--json` emits `vcs-lab.identity-audit/v1`). It also warns, without failing, when provenance actor names look like one actor spelled two ways, such as `codex` and `OpenAI Codex`; the [actor naming convention](docs/identity/README.md#8-naming-a-provenance-actor) says how to spell them. A `Change-Id` is a line of text anyone with repository access can write, so identifiers coordinate work rather than authenticate it and the audit is the defence ([docs/identity](docs/identity/README.md)).

## Planning and forecasting a causal rebase

Preview how a linear source branch would be rewritten onto another commit or
branch without switching or modifying the caller:

```bash
git switch hard-feature
vlab rebase-plan main
vlab rebase-plan main hard-feature --json
vlab rebase-forecast main
vlab rebase-forecast main hard-feature --json
git status --short
```

The plan uses the same exact coverage proofs as reconciliation. Covered changes
are marked `omit`, heuristic patch candidates remain `review`, and new changes
enter the ordered `replay` queue. It also emits a deterministic fingerprint.

A merge in the range is preserved rather than refused. The rewrite recreates it
as a join of its rewritten parents, and the recreated merge **claims nothing**
about the changes beneath it: it takes a new identity recording the merge it
came from, carries forward only the resolutions the join needed, and
contributes to no coverage class. Coverage keeps coming from the per-change
applications alone ([ADR-0034](docs/adr/0034-recreate-merges-as-joins-that-claim-nothing.md)).
Two shapes are still refused by name, before anything moves: an octopus merge,
whose resolution order is not recoverable from its result, and a merge with a
parent that is neither in the range nor an ancestor of the new base.

An interactive program is **declared**, never inherited from Git's sequencer.
`--reword <commit>`, `--edit <commit>`, `--squash <subject>=<target>`, and
`--fixup <subject>=<target>` are plan actions, each with its own rule about
logical identity ([ADR-0035](docs/adr/0035-make-interactive-rewrites-declare-what-they-do-to-identity.md)):

- `reword` composes the `Change-Id` trailer itself and refuses a message that
  would declare a different one — `--fork` is how you ask for a new identity.
- `squash` and `fixup` leave **exactly one** trailer on the surviving commit and
  name the absorbed identities in a record, because several trailers would make
  the survivor depend on parse order. They differ only in whether the absorbed
  prose is kept.
- `edit` keeps the identity while changing what it contains, so it publishes an
  **amendment**. That is the one local operation that can make a proof in
  another clone wrong, and the amendment is what stops it being silent: a bare
  `Change-Id` match for an amended identity degrades from `covered` to
  `candidate-equivalent`. A receipt naming the specific commit still proves that
  commit, and ancestry still proves what ancestry proves.

`reword` and `edit` pause for the caller — `vlab rebase --continue -m "..."` for
a message, `vlab rebase --continue` after staging content. An `edit` is the only
action whose result a forecast cannot predict, so a forecast containing one
reports `pauses-for-content` and says it cannot be used as an approval.

`rebase-forecast` saves a worktree-private
`vcs-lab.rebase-forecast/v3` artifact. It simulates only the ordered replay
queue in a disposable detached worktree, records every target-before and
result tree, pins the plan fingerprint and candidate policy, and reports a
complete predicted tree or a fail-closed conflict/unsupported reason. Dirty
caller files are counted but excluded from the committed-head simulation;
caller branch, `HEAD`, index, status, file bytes, and worktree list remain
unchanged.

Heuristic candidates still block a final prediction until explicitly accepted:

```bash
vlab rebase-forecast main hard-feature --accept-candidates
```

Apply the current named branch after reviewing the plan or a complete forecast:

```bash
vlab rebase main --use-forecast rebase_forecast_...
```

Execution rebuilds the plan and rejects a stale forecast before moving the
branch. It resets the current branch to the exact `onto` commit and replays only
the selected changes in source order. Clean and contextual same-intent rewrites
preserve `Change-Id`; an unexpectedly empty replay blocks instead of silently
disappearing.

If a conflict pauses the queue, ordinary editing and `git add` remain usable:

```bash
vlab rebase --status
# resolve and stage files
vlab rebase --continue
```

Use `vlab rebase --continue --fork` when the resolution deliberately changes
intent. That creates a new Change ID with `Derived-From` provenance. Use
`vlab rebase --abort` to restore the exact original branch tip, including after
earlier queue entries replayed cleanly. Application and summary receipts remain
private until the complete queue and any predicted final tree are verified.

### Naming an explicit range

By default the source set is everything the branch has that `onto` does not.
`--from <base>` names the exclusive lower bound instead:

```bash
vlab rebase-plan main --from HEAD~2
vlab rebase-forecast main --from HEAD~2
vlab rebase main --from HEAD~2
```

Without `--from` nothing changes: the base is the physical merge base and the
plan is the one earlier versions produced. With it, only the commits above the
base are replayed, and the ones below it are **declared rather than dropped** —
the plan and the summary receipt both list them under `excludedByRange` with
commit, `Change-Id`, and subject, so you can see exactly what will not travel. No
receipt ever claims them; the omission is stated, not proven.

When the base is already reachable from `onto`, nothing is excluded and the range
is an ordinary rebase.

Three ranges are refused with `unsupported-range` rather than guessed at: a base
that is not an ancestor of the tip, a base that *is* the tip, and a tip that is
not a branch tip. The last is the one worth knowing — the commits after a
mid-branch tip would need new parents, which is interactive editing rather than a
linear range.

A forecast pins the range base, so an approval for one range refuses to authorize
another with `stale-forecast`. Abort is unaffected: the range decides what is
replayed, never what is restored. See
[ADR-0032](docs/adr/0032-generalize-causal-rebase-to-explicit-linear-ranges.md).

### Carrying your own uncommitted work through the rebase

A rebase rewrites the branch you are standing on, so the draft in that worktree is
normally in the way: `vlab rebase` refuses a dirty worktree. `--target-checkpoint`
on the forecast carries it instead:

```bash
vlab workspace checkpoint --label "mid-refactor"
vlab rebase-forecast main --target-checkpoint
vlab rebase main --use-forecast <id>
```

This is the same overlay contract the reconciliation side uses, applied to the
rebase journal, so [carrying the target's own uncommitted
work](#carrying-the-targets-own-uncommitted-work) is the full description and
nothing about it differs here. Two details are specific to a rebase. The
re-materialization merges the draft onto the *rewritten tip*, with the tree the
branch held before the rebase as the base, and that prediction is pinned once per
run rather than once per pick. And the merge is what keeps the new base: writing
the checkpoint's tree back would restore the pre-rebase content of every file the
new base changed, silently undoing what you rebased onto.

The worktree must be a registered workspace, because a checkpoint belongs to one.
Everything else is unchanged — a drifted worktree refuses with `stale-overlay`
before anything moves, no receipt mentions the draft, and abort restores the
original tip first and the captured worktree second.

Linear rebase operates only on the current named branch. Merge-preserving and
interactive edit/reword/squash rebases remain ordinary Git workflows.

## Forecasting reconciliation

The lab can simulate the complete proven-new queue before touching the
current worktree:

```bash
vlab forecast feature
git status --short
```

The command creates a disposable detached Git worktree, applies clean changes,
uses any single exact-resolution candidates in the simulation, and removes the
temporary worktree. It reports each predicted causal decision, the partial or
complete result tree, blocking conflicts, and forecast duration. The caller's
HEAD, index, and working files are checked before and after and must be
unchanged.

With the merge-tree engine (`--forecast-engine merge-tree` or
`VLAB_FORECAST_ENGINE=merge-tree`; the default on Windows) clean steps are
simulated instead through one persistent `git merge-tree`
process with no temporary worktree, pinning the same per-step and predicted
trees. Any conflicted, empty, or otherwise unsupported step hands the whole
forecast back to the worktree simulator, and the forecast reports which
engine produced it and every fallback reason. The engine needs Git 2.49,
the first version whose `git merge-tree --stdin` flushes each answer before
reading the next request; on older Git the session process reports its
version as it starts and the forecast records a `git-too-old` fallback
without waiting or spawning another process. The worktree simulator remains
the oracle and the default on POSIX hosts, where distribution Git is often
older than 2.49; `--forecast-engine worktree` selects it anywhere.

Each forecast is pinned to exact source and target heads and a fingerprint of
the causal merge plan. After reviewing it, explicitly authorize its exact
resolution IDs as a batch:

```bash
vlab reconcile feature --use-forecast forecast_...
```

Heuristic patch-equivalence remains a separate trust decision. A forecast with
unaccepted `?` candidates reports `review-required` and does not claim a final
tree; review them and regenerate with `--accept-candidates` if appropriate.

Application rechecks every conflict signature and resolution ID. If branch or
causal metadata changed, the command stops before starting. A complete forecast
also pins the predicted result tree; a mismatch prevents receipt publication
and can be safely rolled back with `vlab reconcile --abort`.

Forecasts operate on committed heads. Dirty files are left untouched and their
count is reported rather than silently included. Run the prepared experiment
with:

```bash
npm run demo:forecast
```

## Resumable conflict reconciliation

When a proven-new change conflicts, `vlab reconcile` leaves a durable operation in the current worktree instead of losing causal context:

```bash
vlab reconcile feature
vlab reconcile --status

# Resolve and stage conflicted files.
git add <resolved-files>
vlab reconcile --continue
```

The completed application receipt links the source commit and Change ID to the context-specific result commit and records the conflicted paths. If the resolution changes the logical intent rather than adapting it to the target context, fork the identity explicitly:

```bash
vlab reconcile --continue --fork
```

Abort restores the exact target commit from which the complete reconciliation began, including when earlier changes in the queue applied cleanly:

```bash
vlab reconcile --abort
```

Pending state is stored under the current worktree's private Git directory. Two agents can therefore pause independent reconciliations in separate worktrees without overwriting each other's operation state. Completed receipts remain shared repository metadata.

Run the prepared conflict experiment with:

```bash
npm run demo:conflict
```

## Reusing an exact conflict resolution

Each conflict is recorded under an exact signature of the ordered base, target,
and source blobs involved. The signature excludes the path, so a prior
resolution can be found on another branch or in another linked worktree when
all three inputs are identical.

When reconciliation pauses, inspect any matches:

```bash
vlab resolve status
```

No suggestion is applied automatically. Choose one explicitly, inspect the
staged result, and continue:

```bash
vlab resolve apply shared.txt
git diff --cached -- shared.txt
vlab reconcile --continue
```

For several unambiguous conflicts, use `vlab resolve apply --all`. If the same
signature has more than one known result, select one with
`--resolution <id>`. To decline prior results while keeping the decision in the
receipt, run:

```bash
vlab resolve reject shared.txt
# Resolve shared.txt manually, then:
git add shared.txt
vlab reconcile --continue
```

The application receipt distinguishes `created`, `accepted`, `modified`, and
`rejected` outcomes. `vlab resolve list` shows the repository-shared catalog.
An exact result is still never selected implicitly: it is batch-applied only
when `--use-forecast` names the reviewed, pinned forecast.
Run the prepared two-conflict experiment, whose second occurrence is in a
linked worktree, with:

```bash
npm run demo:resolution
```

## AI-oriented workspaces

```bash
vlab workspace create agent-auth --from main --owner agent-7 --focus service:auth
vlab workspace list
cd ../vlab-playground.workspaces/agent-auth
echo draft > agent-plan.md
vlab workspace checkpoint --label "agent handoff"
```

`--owner` and `--focus` are free-text labels recorded on the workspace
descriptor. On a large tree, `--cone <dir,dir>` materializes only the named
directory prefixes through Git's cone-mode sparse checkout: the workspace ID,
compatibility branch, pinned base, checkpoints, and lifecycle are the same with
or without it, a checkpoint still captures the full tree, restore reapplies the
cone, and `git sparse-checkout disable` inside the worktree reverses it. Cone
paths must be relative and inside the repository.

From the original or another linked worktree, move or temporarily dematerialize
a workspace without changing its identity:

```bash
vlab workspace move agent-auth ../vlab-playground.workspaces/agent-auth-2
vlab workspace archive agent-auth
vlab workspace restore agent-auth --path ../vlab-playground.workspaces/agent-auth-3
vlab workspace repair agent-auth --path ../vlab-playground.workspaces/agent-auth-3
vlab workspace prune --dry-run
```

Archive refuses tracked or untracked changes, ignored files, and unfinished
reconciliation or rebase journals, even when the worktree is clean. A journal's
presence produces `operation-in-progress`; malformed and newer-version journals
are preserved too. In that workspace, inspect `vlab reconcile --status` or
`vlab rebase --status`, then continue a resolved conflict or abort the operation.
Clean interrupted publication and forecast mismatches require abort before retrying.
If this build cannot read a journal, preserve it and recover with the writing build.

Prune previews missing registry paths and only changes them with `--apply`.
Because Git pruning acts across the repository, an applying prune with candidates
refuses while **any linked worktree** has either journal, including unregistered
or currently materialized worktrees. Restore missing paths and repair their Git
links before recovering those operations. Move and repair preserve private journals
and recovery state. Branch and checkpoint refs remain available while a workspace
is archived.

Create, move, archive, restore, repair, and prune with `--apply` serialize their
registry reads, Git operations, and registry writes on
`<common-git-dir>/vcs-lab/workspaces.lock`. Contenders wait up to five seconds
and then refuse with `workspace-registry-locked`; listing and prune previews
remain available. A crashed holder leaves its lock in place. To recover,
stop workspace writers on every host sharing the repository, inspect the
registry and `git worktree list` for partial changes, then remove only
`workspaces.lock` before restarting writers. The tool never steals a lock
based on its age, an unreadable claim, or a missing PID.

A materialization failure leaves the registry unchanged and preserves any
partially created worktree or branch for inspection. Repair or remove that
partial materialization deliberately with Git before retrying. The registry
lock does not make Git mutations and registry publication one atomic operation.

Compare two workspace branches without disturbing either worktree:

```bash
vlab workspace forecast agent-auth agent-payments
vlab workspace forecast agent-auth agent-payments --source-checkpoint
vlab workspace forecast agent-auth agent-payments --target-checkpoint
```

The ordering is `target <= source`: this previews applying the committed head
of `agent-payments` onto `agent-auth`. With `--source-checkpoint`, the source is
the latest immutable checkpoint whose base still matches the source head. Live
dirty bytes after that checkpoint remain excluded. The target is always its
committed head. The forecast is stored privately in the target worktree, where
its printed reconciliation command should be run.

### Carrying the target's own uncommitted work

`--target-checkpoint` carries the *target's* draft through the application and
puts it back afterwards. It is available on `vlab forecast` too, with identical
semantics, and on [`vlab rebase-forecast`](#carrying-your-own-uncommitted-work-through-the-rebase),
where the overlaid worktree is the branch being rewritten.

An overlay is uncommitted context, never a committed draft. It changes no
coverage decision: the plan, its fingerprint, and the committed predicted tree
are exactly what they would be without it, and no receipt mentions it. What the
forecast adds is a second prediction — the worktree after the draft is put back —
which the application verifies before publishing anything.

Nothing is ever captured for you. Uncommitted work with no checkpoint is refused,
because an overlay is state you approved. Once approved, the live tree must still
match the checkpoint exactly; if you kept typing, the run refuses with
`stale-overlay` before touching anything, and the remedy is a new checkpoint.
Your newer work is left exactly where it is.

Applying reduces the worktree to the committed head, replays the changes, and then
re-materializes the draft by merging it onto the result — not by writing the
checkpoint's tree back, which would undo the very changes that were just applied.
If the re-materialized tree does not match the prediction, nothing is published
and abort is the recovery. Abort restores the committed tip first and
unconditionally, then the captured worktree including its untracked files; an
overlay it cannot read is reported as unrecoverable rather than guessed at. See
[ADR-0028](docs/adr/0028-define-target-checkpoint-forecast-semantics.md).

The checkpoint captures tracked, modified, and untracked non-ignored files in
an immutable Git commit referenced under `refs/vcs-lab/checkpoints/...`. When a
new checkpoint replaces it, a history ref retains the previous checkpoint. The
operation does not alter `HEAD`, the index, or the working directory.

This approximates the proposed distinction:

- **Workspace:** pinned base, private draft state, ownership/focus metadata, and checkpoint history.
- **Worktree:** one ordinary filesystem materialization of that workspace.

The prototype still creates a `vlab/ws/<name>` compatibility branch because Git requires one to retain normal linked-worktree behavior. A native implementation would use a workspace ref and private draft stack instead.

## Annotated Markdown

Create a specification:

```markdown
# Checkout

REQ-CHECKOUT-1: Order submission must be idempotent.

## Failure behavior

Return a typed error when authorization fails.
```

Then index it:

```bash
vlab spec index docs/checkout.md
vlab spec show docs/checkout.md
```

The exact Markdown remains canonical. The tracked
`.vcs-lab/specs/docs/checkout.md.json` sidecar assigns stable IDs to the
preamble, headings, and explicit `REQ-*:` entries. Manifests are
sparse and deterministic: titles, positions, content hashes, and ordinary IDs
are derived from Markdown rather than duplicated. The sidecar retains
artifact/source identity, entity count, an optional Git blob identity, and only
exceptional legacy ID overrides.

The v4 writer excludes headings and `REQ-*:` declarations inside supported
backtick and tilde fences. Historical v1/v2/v3 manifests retain their old view
until `vlab spec index` migrates them, preserving verified real entity IDs.
Indexing refuses migration if the original source cannot be recovered. The
[fence and migration contract](docs/adr/0026-version-fence-aware-markdown-boundaries.md)
specifies the supported syntax and recovery.

Migrate and commit the common baseline before starting new branches. If an
existing merge's legacy base has affected boundaries, migrating only the tips
is insufficient: review an ordinary Git merge and reindex its result. Old
semantic forecasts must be regenerated; pending operations with old semantic
decisions must be aborted and restarted.

An unchanged source hash is an incremental-index cache hit and does not rewrite
the sidecar. Repository-wide indexing additionally compares tracked Git blob
IDs first; unchanged documents are neither opened nor hashed. Index every
tracked or non-ignored Markdown document in one pass:

```bash
vlab spec index --all
```

`--force`, on either form, re-parses the Markdown and re-derives the manifest
even when the tracked blob or source hash reports it unchanged, which is how a
sidecar is refreshed deliberately.

### Deterministic block reconciliation

Heading-delimited sections are the disjoint merge units. `REQ-*`
records remain independently addressable entities, but their text is merged as
part of the containing section so overlapping units cannot produce inconsistent
bytes.

The three-way merge is deliberately conservative:

- edits to different blocks combine;
- a block move on one side combines with a content edit on the other;
- identical concurrent edits or additions combine;
- same-block divergent edits remain blocked;
- delete-versus-edit and incompatible ordering remain blocked.

The result is rendered with LF endings, one blank line between blocks, and one
final newline. No language model judgment is involved. The normal forecast
automatically discovers these decisions, records their exact input signature
and result hashes, and can apply them only through the reviewed forecast:

```bash
vlab forecast feature
vlab reconcile feature --use-forecast forecast_...
```

To inspect the semantic merge independently of reconciliation:

```bash
vlab spec merge-plan docs/checkout.md <base> <target> <source>
```

Without a forecast, reconciliation pauses before changing conflicted spec
bytes. Inspect and explicitly stage a clean deterministic suggestion:

```bash
vlab spec status
vlab spec resolve --all
git diff --cached -- docs/checkout.md .vcs-lab/specs/docs/checkout.md.json
vlab reconcile --continue
```

If you edit the staged suggestion, re-run `vlab spec index`, stage both the
Markdown and sidecar, and continue. The application receipt records the
semantic decision as `accepted` or `modified`; a stale sidecar cannot be
committed through reconciliation.

Run the prepared experiment with:

```bash
npm run demo:spec
```

## Commands

Run `vlab --help` for the current command list. The most useful commands are:

| Command | Experiment |
| --- | --- |
| `vlab commit` | Stable logical change identity |
| `vlab merge --compact` | First-parent compression without causal loss |
| `vlab merge --hard-squash` | Git-compatible strict squash plus sideband receipt |
| `vlab compact-merge`, `vlab hard-squash` | The same two landings as standalone commands |
| `vlab merge-plan` | Proven coverage versus heuristic similarity |
| `vlab proof-bundle`, `vlab verify-proof` | Portable coverage evidence and its independent verification |
| `vlab rebase-plan` | Read-only causal omission/review/replay planning for a linear rebase |
| `vlab rebase-forecast` | Non-mutating simulation and private pinning of a causal rebase plan |
| `vlab rebase` | Supervised current-branch replay with stale checks, continue/fork/abort recovery, and completed receipts |
| `vlab forecast` | Non-mutating reconciliation simulation and pinned approval |
| `vlab reconcile` | Apply only proven-new changes with resumable conflicts |
| `vlab resolve ...` | Inspect, apply, reject, and audit exact resolution suggestions |
| `vlab cherry-pick` | Preserve or deliberately fork a Change ID; a change the target already covers is a no-op unless `--repeat` is given |
| `vlab graph` | Branch history plus causal relationships, without metadata-ref noise |
| `vlab workspace ...` | Worktree-backed lifecycle, checkpoints, and committed/checkpoint forecasts |
| `vlab spec ...` | Incremental indexing, block merge planning, explicit resolution, and corpus benchmarks |
| `vlab receipts` | Inspect causal records as text or JSON |
| `vlab provenance` | Read declared authorship provenance, carried across rewrites |
| `vlab audit identity` | Repository-wide Change-ID collision and duplicate-origin audit |
| `vlab metadata ...` | Inventory, validate, transfer, and benchmark accepted metadata facts and scan paths |
| `vlab doctor --benchmark` | Sample ordinary Git latency and persistent object-session reuse |

For ordinary Git commits without a `Change-Id`, `vlab cherry-pick` recognizes
exact target ancestry and validated, reachable identity-preserving application
records. A covered pick returns a no-op without starting Git's sequencer;
`--repeat` explicitly reapplies it. Forks and patch similarity alone do not
establish coverage for the original change.

## Metadata integrity and portability

Inspect every metadata scope without changing the repository:

```bash
vlab metadata status
vlab metadata validate --json
vlab metadata validate --strict
```

The inventory covers causal note attachments and record schemas, referenced
commits/trees/blobs, exact-resolution signatures and retention refs, tracked
spec/source consistency, workspace/checkpoint health, and counts of
worktree-private operations and forecasts. JSON diagnostics use stable codes.
Unknown, malformed, dangling, signature-mismatched, or ID-conflicting records
remain inspectable but cannot prove coverage, appear as exact resolutions, or
enter an export. Strict validation additionally fails on warnings such as a
missing workspace path or active private operation.

Newly published facts retain their required commits, trees, and blobs under
`refs/vcs-lab/retention`, so deleting a rewritten source branch and running Git
GC does not invalidate its receipts. Retention is monotonic: aborting an operation
or deleting a note does not release objects. Retained receipts still prove
coverage only when their attachments are reachable from the selected target.
See [ADR-0025](docs/adr/0025-retain-the-object-closure-of-published-causal-facts.md).

An ordinary clone fetches branch refs, not causal notes or their shared vlab
refs. A clone that fetches `refs/notes/vcs-lab` without `refs/vcs-lab/*` can
therefore see a valid record but not the retention carrier that keeps its
attachment readable; `metadata validate` then reports `missing-attachment`
even though the origin is healthy. Fetch both namespaces as shown under
[Metadata locations](#metadata-locations) before interpreting validation from
a low-level same-origin read.

For notes created by an older version, preview and apply an explicit backfill:

```bash
vlab metadata retain --dry-run --json
vlab metadata retain --apply --json
```

Backfill retains still-valid facts and reports quarantined records, including
already missing objects. It cannot restore missing history. A partial backfill
with quarantined records returns exit status 1; repeating an unchanged backfill
does not move any refs.

Create an offline envelope, clone the ordinary project content, preview the
exact destination actions, then apply them:

```bash
vlab metadata export ../project-metadata
git clone /path/to/project ../project-copy
cd ../project-copy
vlab metadata import ../project-metadata --dry-run
vlab metadata import ../project-metadata --apply
```

An envelope directory contains `manifest.json` and, when portable facts exist,
`objects.bundle`. Export is deterministic for fixed accepted facts. It carries
sanitized `refs/notes/vcs-lab` data, the commit history required by accepted
causal records (including rewritten rebase origins), and accepted
`refs/vcs-lab/resolutions/*` commits/blobs, including independent conflict-stage
blobs. The envelope builds a carrier for its accepted facts and excludes the
local retention chain. Tracked spec manifests already move
with ordinary Git content. Workspace registries, checkpoint refs, active
reconciliation/rebase journals, and saved forecasts are excluded.

Import requires the same Git object format and at least one shared root commit,
which supports ordinary clones and forks while unrelated and history-filtered
histories fail closed in envelope v1. Dry-run verifies the manifest, bundle,
records, refs, and required content objects without changing destination refs.
Apply uses staging refs and one checked ref transaction; repeated import is a
no-op, and a conflicting record ID or resolution ref is never overwritten.

These checks establish internal integrity, not cryptographic signature trust,
actor identity, landing authorization, or permission to execute content.

### Competing facts: parking and disposition

A conflict is one record identifier naming different content — nothing else.
Two records with distinct identifiers are independent facts even when they claim
the same thing, so an ordinary re-run that writes a second receipt onto one
commit is not a conflict.

While a conflict is unresolved, neither copy is used: it proves no coverage,
serves as no resolution candidate, shows no provenance, and is not exported. The
change it would have covered is classified from the evidence that remains, so it
moves to `candidate-equivalent` or `new` and never the other way, and the plan,
the forecast, and the receipt carry a `quarantinedFacts` list naming what was
excluded. Nothing blocks: one disputed record from one peer must never stop local
work.

The default import still refuses a whole envelope over one conflict. Park mode
applies the rest instead and sets the conflict aside:

```bash
vlab metadata import ../project-metadata --apply --park-conflicts
```

Each conflicting incoming record becomes the blob of one ref under
`refs/vcs-lab/quarantine/<source-lineage>/<record-id>`, inspectable with
`git cat-file -p`, listed by `vlab metadata status` beside the local digests it
disputes, and excluded from every reader and from export. The namespace is local:
nothing fetches or pushes it.

A successful park exits 0, and the report names what was parked. Park mode exists
so one disputed record cannot stop an exchange, so it does not signal failure for
having done its job; read `summary.parkRecords` and the `parked` list, or
`vlab metadata status`, to act on a dispute.

A person then decides, once:

```bash
vlab metadata dispose <record-id> --keep-local --reason "the peer altered it"
vlab metadata dispose <record-id> --replace-local
```

`--keep-local` removes the parked copy and returns the local record to service.
`--replace-local` rewrites the local record to the parked content under the notes
lock and returns that instead. Either way the decision is recorded in
`<common-git-dir>/vcs-lab/dispositions.json` with the digest kept and the digests
rejected, so the same disagreement arriving again is reported as already disposed
rather than parked a second time. That registry is deliberately local: two clones
may decide differently, and the disagreement between them is real.

Git's own `git notes merge` is not a supported way to combine causal notes on
either side of this: the manual strategy stops in a conflicted worktree, and
`-s union` concatenates the containers into something vcs-lab reads as malformed,
dropping every record on that attachment. See
[ADR-0030](docs/adr/0030-define-conflict-policy-for-competing-causal-facts.md).

## Verifying a plan without the repository

`vlab proof-bundle <source>` emits a `vcs-lab.proof-bundle/v2` document and
`vlab verify-proof <file>` checks it. The bundle carries the classification, the
evidence it was derived from, and — since v2 — Git's own bindings for what it
claims: the raw commit objects of the source range, a commit path from the target
head for every covered change, an inclusion proof from the notes tip to each
receipt it relies on, and the anchors those proofs terminate at.

```bash
vlab proof-bundle feature > proof.json
vlab verify-proof proof.json --offline
vlab verify-proof proof.json --offline --anchors-from https://github.com/you/project.git
```

The verifier recomputes every carried object's id from its bytes. That is the
whole mechanism: a sender chooses what to put in a bundle, but it cannot choose
the id of a commit whose message it altered. So a bundle that omits a change,
injects a commit from an unrelated repository, substitutes a foreign commit id, or
borrows a Change-Id fails offline — even after the forger recomputes the bundle
hash, which before v2 was enough to pass.

A conclusion is reported at one of three tiers, and they are different statements
rather than degrees of confidence:

| Tier | What it says |
| --- | --- |
| self-consistent | the classification follows from the evidence the bundle states |
| bound | that evidence is tied to Git objects, between the heads the bundle *states* |
| anchored | those heads are the real ones, confirmed from a channel you chose |

`--anchors-from <remote>` is that channel: it reads `git ls-remote` from a remote
**you** name. A remote named inside the bundle is only a hint, because the
bundle's producer controls it. Root commits are not ref tips, so that channel
cannot confirm them and the report says so instead of pretending otherwise.

What stays out of reach without the repository is absence. That a change is
genuinely `new` is a claim about the whole target history, and
`candidate-equivalent` is a claim about trees, which the bundle deliberately does
not carry. Both are reported as *claimed*, never proven, and `ok` never asserts a
conclusion the carried material cannot support; the report lists each one with
its reason. Running `verify-proof` inside the repository still adds the
comparison that catches fabricated evidence, and it is the only check that
establishes absence.

A v1 bundle from an older producer still verifies, at the self-consistent tier
only. See
[ADR-0031](docs/adr/0031-carry-a-bound-source-inventory-for-portable-verification.md).

## What this build can exchange

Two builds decide what they may exchange by comparing documents, not by asking a
server. `vlab capabilities` prints what this build reads and writes, projected
from the same registries the rest of the tool enforces, so the statement cannot
drift from the behavior:

```bash
vlab capabilities
vlab capabilities --json
```

Outside a repository the document is build-scoped; inside one it adds the object
format and lineage, which makes it repository-scoped. It writes nothing.

Negotiation is a pure function of two such documents, so every conclusion a
gateway would enable is already available offline:

```bash
vlab capabilities --against ../peer-capabilities.json
vlab capabilities --against ../project-metadata      # an envelope directory
```

The report separates an exchange that is *smaller* from one that is
*impossible*. A version gap in a family is smaller: a stored record's version is
fixed by whoever wrote it and is never re-encoded, so records the peer cannot
read are filtered out and named, together with what the peer's own document says
it would do with them, and everything else still moves. The command exits
non-zero so a script notices, while the exchange remains possible.

A disagreement about a profile, an algorithm, the object format, or the lineage
is impossible: there is no set of bytes both sides would read the same way, so it
refuses with `no-common-version`, or `repository-mismatch` for the repository
cases, before anything is transferred. A feature token a reader does not know is
opaque and is ignored rather than refused, and bounds are the receiver's — a
record over the peer's advertised bound is withheld and reported rather than sent
to be refused.

An envelope manifest states a producer, a repository, and feature tokens and
nothing else, so negotiating against one reports the families as *not stated*
rather than as unreadable. That distinction is the point: a document says what it
says, and a report that filled in the rest would be inventing a peer.

The gateway itself is not built. It would add exactly one thing an offline reader
cannot have — the current document of a party that is not in the room — and would
change nothing about what negotiation concludes. See
[ADR-0033](docs/adr/0033-advertise-capabilities-as-a-document-negotiated-offline.md).

## Metadata locations

- Git notes: `refs/notes/vcs-lab`
- Required objects of published facts: `refs/vcs-lab/retention`
- Pending reconciliation: the current worktree Git directory under `vcs-lab/reconciliation.json`
- Pending causal rebase: the current worktree Git directory under `vcs-lab/rebase.json`
- Saved forecasts: the current worktree Git directory under `vcs-lab/forecasts/<forecast-id>.json`
- Workspace registry: the common Git directory under `vcs-lab/workspaces.json`
- Checkpoints: `refs/vcs-lab/checkpoints/<workspace-id>`
- Parked conflicting records: `refs/vcs-lab/quarantine/<source-lineage>/<record-id>`
- Conflict dispositions: the common Git directory under `vcs-lab/dispositions.json`
- Reusable resolution blobs: `refs/vcs-lab/resolutions/<signature>/<result-blob>`
- Portable spec manifests: `.vcs-lab/specs/**/*.json`

The supported transfer path is `vlab metadata export/import`. For a low-level
same-origin read, fetch the notes and shared vlab namespaces together:

```bash
git fetch origin 'refs/notes/vcs-lab:refs/notes/vcs-lab' 'refs/vcs-lab/*:refs/vcs-lab/*'
```

Both namespaces are required for a complete causal read: notes carry the
records, while the retention root keeps their attachments and dependencies
readable and resolution refs retain reusable result blobs. Direct ref fetching
does not provide envelope validation, conflict preview, or quarantine. Use the
envelope for supported transfers.

## Measuring the compatibility layer

Mutation commands stay ordinary Git processes, while repeated immutable object
queries can be routed through one worktree-scoped
`git cat-file --batch-command` process. It is enabled automatically on Windows,
where the observed 80–130 ms process startup cost dominates these operations.
On other platforms it remains opt-in because a local Git process may take only
a few milliseconds.

The worker starts lazily at the first uncached object request. This keeps worker
startup from overlapping synchronous preflight commands such as `git status`.
Shutdown waits for the child `close` event so its stdio has drained, with bounded
Git-tree and worker fallbacks if graceful EOF does not complete.

Get both the ordinary-process baseline and the persistent-session probe with:

```bash
vlab doctor --benchmark --samples 10 --warmup 2
```

Measure repository/shared-metadata volume without reading or changing the
caller repository:

```bash
vlab metadata benchmark --json
vlab metadata benchmark --history 500 --workspaces 20 --notes 500 --resolutions 100 --samples 5 --budget-ms 1500 --json
```

The default disposable profile contains 250 reachable commits, 12 registered
linked-worktree workspaces, 250 causal notes, and 50 retained resolutions. It
measures history, stock Git worktree discovery, the registry, complete
workspace status, notes, resolutions, and complete metadata status. Setup cost
is separate, every sample must return the same semantic result, and JSON omits
fixture paths, object IDs, file content, and commit messages. Documentation
volume is covered by `vlab spec benchmark`.

On the clean-commit Windows host run, registry parsing took a 0.31 ms median
with no Git processes and the 300-target note catalog took 172.67 ms with two.
Status for 12 workspaces took 1,597.78 ms and 36 processes; 50 resolutions took
5,503.66 ms and 103 processes. This synthetic observation selects batching for
workspace status and resolution traversal. It does not justify an incremental
index, a resident service, or a production scale claim. See
[ADR-0013](docs/adr/0013-measure-scan-amplification-before-adding-indexes-or-a-service.md).

Both paths are now batched: each materialized workspace costs one
worktree-scoped `git status --porcelain=v2 --branch -z` query, and the
resolution catalog uses one `for-each-ref` scan plus batched object and note
reads. Rerunning the same profile on a Linux development host moved workspace
status from 36 to 12 processes and the 50-resolution catalog from 103 to six,
with identical results, so the benchmark's next action is larger fixtures and
more hosts rather than an index.

For command-by-command timings, enable tracing directly on one invocation:

```bash
vlab forecast feature --trace-git
```

`--git-session` forces the persistent path and `--no-git-session` forces the
ordinary compatibility path. If a session fails, the command continues through
ordinary Git. Notes listings share the object session with note-blob reads;
duplicate attachments and oversized or unreadable trees use the ordinary Git
listing command. See [session safety rules](docs/architecture.md#142-invocation-scoped-session).
`--forecast-engine merge-tree` selects the merge-tree forecast
engine for one invocation and `--forecast-engine worktree` the worktree
simulator; without either, Windows uses the merge-tree engine and POSIX hosts
the worktree simulator. `--engine native` (or `VLAB_ENGINE=native`) selects
the optional [native resolution-read binding](docs/native-engine.md) for one
invocation. Its five supported operations report successful execution under
`nativeReads`; unsupported operations and unavailable bindings use Git and appear
under `fallbacks`. A missing prebuild reports `binding-missing`; an input the
binding refuses by design, such as a SHA-256 repository or command-scope Git
configuration, reports `unsupported-input`; `native-error` is reserved for
anything else. Metrics also
include `engine` and `directReads`, the number of reads
that bypassed the engine seam (always zero; such a read is refused in native
mode). Trace output contains command names, durations, and whether a query
started a process, reused a persistent process, or hit the immutable object
cache; it never includes file content or commit messages. For a hang or a
leftover process, `VLAB_GIT_SESSION_DIAGNOSTICS=1` prints one JSON line per
object-session and merge-tree-session lifecycle event (worker creation,
request posting, shared-memory waits, Git responses, fallback, shutdown) to
stderr, and `VLAB_GIT_SESSION_DIAGNOSTICS_FILE=<path>` appends the same lines
to a file; both are off by default and never change session behaviour.

Compare the read engines operation by operation in any repository with:

```bash
vlab doctor --differential
```

The report runs each of the 39 cataloged read operations of `src/engine.js`
through the Git engine and the native engine against the current repository
and lists per-operation result digests, process counts, and fallbacks
(ADR-0019); the plain `vlab doctor` output names the selected read and
forecast engines.

Run an equality-checked comparison over a 12-change forecast with:

```bash
npm run demo:git-session
```

The demo runs the same 12-change forecast through ordinary Git, the persistent
object session, and the merge-tree engine, and asserts identical plans,
per-step trees, and predicted trees. On the 2026-08-29 Windows development
host the three modes used 64, 25, and 10 Git processes, the last with no
temporary worktree (ADR-0016). Wall time remains a machine-specific
measurement; process count and result-tree equality are the portable
acceptance invariants.

Forecast output separately reports preflight, planning, simulation, invariant,
temporary-worktree, merge-tree session, logical-query, and actual-process
totals, plus the engine that produced the pinned trees and any fallback. Completed
reconciliation receipts report active application time, excluding time spent
waiting for a person between a conflict and `--continue`, plus total elapsed
wall time.

Check benchmark regressions against this machine's identified baseline:

```bash
npm run test:benchmark -- --host lab-linux-a
```

Use the stable label assigned to the actual machine, not just its operating
system. `--host` takes precedence over `VLAB_BENCHMARK_HOST`, which can select
the same label for checks and recording. Labels remain stable across toolchain
upgrades; different machines need different labels.

The check compares reduced scale, three-mode forecast, and six-change
publication fixtures against `benchmarks/baseline.json`. Process counts must
not grow; latency must stay within `max(2 × baseline, baseline + 5 ms)`.
Unsupported forecast modes are reported as skipped.

Unknown, unselected, or hardware/settings-mismatched hosts **skip latency**.
Compatible historical OS entries can still check deterministic counts when no
engine/session overrides are set; forecast semantic checks always run. JSON
reports `latencySkipped` and `reference`: `passed: true` with
`latencySkipped: true` is only a deterministic pass and **does not qualify host
latency for release**.

To establish a baseline, or refresh it after a reviewed performance change, run
these commands deliberately on the actual quiet qualification machine:

```bash
npm run benchmark:record -- --host lab-linux-a
npm run test:benchmark -- --host lab-linux-a
```

Recording requires a label and captures hardware and environment provenance.
Review and commit the baseline diff with the reason for recording; do not
re-record just to clear a regression. Schema v3 preserves the old Linux/Windows
measurements unchanged in `legacyHosts`, without using their latency limits for
unidentified machines. Existing historical entries do not establish identified
qualification baselines.

See the [benchmark testing guide](docs/testing.md#benchmark-regression-check)
for label syntax, provenance matching, and migration rules, or the
[wiki walkthrough](https://github.com/jwh3times/vcs-lab/wiki/Benchmark-host-baselines).
The identified Windows baseline is `hosts.lab-windows-a`, established in
[issue #22](https://github.com/jwh3times/vcs-lab/issues/22). Use that label only
on its matching machine. Current releases qualify latency on this Windows
machine only, as selected for
[issue #68](https://github.com/jwh3times/vcs-lab/issues/68). Linux latency remains
unqualified; functional support and Windows/POSIX release testing continue.
Real-repository, multi-host evidence and budget ratification remain in
[issue #42](https://github.com/jwh3times/vcs-lab/issues/42).

Measure indexing and raw/estimated-compressed metadata size without changing the
current repository:

```bash
vlab spec benchmark --documents 25 --blocks 40
```

The benchmark creates and removes a disposable repository. It reports cold,
unchanged, and one-block-change indexing; Git-blob cache hits and actual content
reads; semantic entity counts; sparse v4 bytes versus an equivalent expanded v2
representation; and a deflate-based approximation of Git object compression.
For reference, the historical v3 measurement on the default 25-document,
2,025-entity corpus occupies 11,240 bytes against 655,545 equivalent expanded v2 bytes.

## What this prototype intentionally does not solve

- cryptographic signing or a trusted landing server;
- a native content-addressed object database;
- content-defined chunking;
- semantic merge drivers for formats other than heading-oriented Markdown;
- nested requirement-level byte merging within a section;
- a binary or content-addressed native structured-document object store;
- server-side branch policy and atomic multi-ref landing;
- virtual/lazy filesystem materialization;
- target-checkpoint overlays or forecasts over uncaptured live workspace bytes;
- a complete Git protocol gateway;
- persistent repository indexes or a cross-command resident service before
  representative post-batching evidence justifies them;
- safe automatic equivalence inference for independently created near-identical code.

Those should be built only after these local semantics prove useful.

## Run the tests

```bash
npm test
```

The integration suite creates disposable Git repositories and exercises
hard-squash reconciliation, compact ancestry, resumable conflicts, mid-queue
abort, contextual identity forks, exact resolution reuse and provenance,
non-mutating and stale-safe forecasts, merge-tree forecast-engine equality and
fallback, pinned batch application, committed-head
and immutable source-checkpoint workspace comparison, reversible workspace
lifecycle, independent worktree operations, checkpoint history, annotated
Markdown stability, sparse-manifest migration, zero-read incremental indexing,
clean and blocked deterministic block merges, forecasted and explicit semantic
application, conservative patch-equivalence handling, corpus measurements,
batched history planning, persistent-session fallback, worktree isolation, Git
timing probes, damaged metadata quarantine, deterministic envelope export,
tamper/lineage/conflict rejection, idempotent two-clone parity, and read-only
causal rebase planning plus deterministic/non-mutating rebase forecasts with
explicit candidate decisions, predicted trees, private persistence, and
conflict blockers; and supervised rebase application with stable identity,
stale rejection, exact-resolution batching, contextual forks, empty-step
blocking, exact abort, linked-worktree isolation, completed-record validation,
portable unreachable origins, plus a caller-isolated repository-scale fixture
that verifies semantic scan results, process-amplification decisions, privacy,
and cleanup, and the engine seam's import discipline, passthrough equality,
bypass refusal, and differential report. The complete suite is also run with
`VLAB_GIT_SESSION=1` and `VLAB_GIT_SESSION=0` to exercise the Windows-default
session path and the POSIX-default one-process path on every host, with each
forecast engine forced (`VLAB_FORECAST_ENGINE=worktree` and
`VLAB_FORECAST_ENGINE=merge-tree`) because the default engine differs by
platform, and with `VLAB_ENGINE=native`, which refuses any repository read
that does not pass through `src/engine.js`. The GitHub Actions workflow in
`.github/workflows/ci.yml` runs static checks for every PR and main push,
with the default suite on Ubuntu and Windows for code PRs and on Ubuntu
for main. Known documentation-only changes run static checks. The full matrix
remains available by manual dispatch for release and high-risk platform
qualification; see [Continuous integration](docs/testing.md#continuous-integration).
