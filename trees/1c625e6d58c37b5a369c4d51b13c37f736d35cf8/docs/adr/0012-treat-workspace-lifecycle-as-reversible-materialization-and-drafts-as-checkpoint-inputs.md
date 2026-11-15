# ADR-0012: Treat workspace lifecycle as reversible materialization and drafts as checkpoint inputs

- **Status:** Accepted
- **Date:** 2026-08-24
- **Owners:** Repository maintainers
- **Related requirements:** FR-REC-01, FR-REC-02, FR-REC-04, FR-REC-12, FR-WS-01 through FR-WS-07

## Context

The laboratory already records logical workspaces, materializes them as linked
Git worktrees, captures non-disruptive checkpoints, and forecasts committed
workspace heads. Two gaps prevent a safe handoff lifecycle:

- a registry entry cannot be moved, archived, restored, or repaired after its
  machine-local path changes; and
- a forecast can report dirty files only as ignored mutable state, even after a
  user explicitly captures those bytes in an immutable checkpoint.

Reading a live dirty worktree directly into reconciliation would weaken the
existing pinning and stale-input guarantees. Treating every checkpoint as an
ordinary branch head would also hide the distinction between committed causal
history and a private draft snapshot.

## Decision

Model workspace lifecycle as reversible materialization of one stable logical
workspace descriptor. Model a forecastable draft as an explicitly selected,
immutable source checkpoint rather than live working-tree bytes.

### Lifecycle

Workspace schema v1 retains the stable workspace ID and compatibility branch
while allowing these lifecycle operations:

- `move` delegates to `git worktree move` and updates the machine-local path;
- `archive` removes only a clean materialization and retains the descriptor,
  compatibility branch, checkpoint refs, and last head;
- `restore` recreates an archived materialization from the retained branch;
- `repair` validates repository and branch identity, runs `git worktree repair`,
  and updates a path changed outside VCS Lab; and
- `prune` previews missing active paths by default. `--apply` prunes stale Git
  administration and marks those descriptors archived without deleting their
  branches or checkpoints.

Archive refuses tracked, untracked, or ignored files. Move may preserve a dirty
worktree because Git moves the materialization rather than deleting it. Commands
that remove or relocate a worktree must run from another linked worktree.

### Checkpoint identity and retention

Each new checkpoint is a full immutable snapshot whose commit parent is the
captured workspace `HEAD`. It records:

- workspace ID;
- captured base commit;
- captured tree;
- a deterministic `draft_` logical change ID derived from workspace, base, and
  tree; and
- the previous checkpoint ID, when present.

The latest snapshot remains at `refs/vcs-lab/checkpoints/<workspace-id>`.
Replacing that ref first retains the prior snapshot under
`refs/vcs-lab/checkpoint-history/<workspace-id>/<checkpoint-oid>`. These refs
remain shared-local and excluded from metadata envelopes.

### Checkpoint forecast

`vlab workspace forecast <target> <source> --source-checkpoint` selects the
source workspace's latest checkpoint. The command verifies that:

- the ref resolves to a commit with the expected workspace ID and tree;
- its recorded base equals the current source workspace head; and
- its tree differs from that committed head.

The forecast remains worktree-private in the target workspace and explicitly
uses scope `source-checkpoint`. It pins the checkpoint commit, tree, base,
`draft_` identity, ordinary committed plan, resolutions, steps, and predicted
tree. Live source and target dirty bytes remain ignored and unchanged. A moved
source head makes the checkpoint stale and requires a new capture.

The existing reviewed `reconcile --use-forecast` path may apply the immutable
checkpoint input. It still rebuilds the exact plan and revalidates every pinned
decision before mutation.

## Constraints

- Workspace IDs, compatibility branches, and checkpoint refs survive move,
  archive, restore, repair, and prune.
- No lifecycle command silently deletes dirty or ignored files.
- Prune is non-mutating unless `--apply` is explicit.
- A checkpoint forecast never reads live dirty file contents.
- Checkpoints and workspace paths remain local metadata and do not enter the
  portable envelope.
- Existing committed-head forecasts retain their behavior and schema.

## Consequences

### Positive

- Workspaces can be handed off, relocated, and temporarily dematerialized
  without losing logical or checkpoint identity.
- A reviewer can forecast a stable private draft without requiring the agent to
  publish it on the compatibility branch.
- Forecast staleness remains an exact object-identity decision.
- Stock Git continues to inspect every checkpoint and perform every worktree
  transition.

### Negative

- Checkpoint history adds shared-local refs and remains machine-local.
- Registry updates and Git worktree mutations cannot be one atomic transaction;
  explicit repair/prune commands are the recovery path.
- Workspace list still probes materialized worktrees serially.

## Rejected alternatives

- **Forecast live dirty bytes:** rejected because mutable input cannot be pinned
  or safely approved across processes.
- **Treat the compatibility branch as the draft:** rejected because it erases
  the committed/private distinction.
- **Force archive after checkpointing:** rejected because ignored files are not
  captured and could be destroyed.
- **Delete branches/checkpoints during prune:** rejected because a stale path is
  not proof that retained work is disposable.
- **Support target and source overlays together in v1:** deferred to keep this
  increment bounded; the target remains a committed workspace head.

## Implementation map

- Lifecycle and checkpoint identity: `src/workspaces.js`
- Checkpoint-input simulation and pinning: `src/forecasts.js`
- CLI surface: `src/cli.js`
- Shared-local validation: `src/metadata.js`
- Acceptance coverage: `test/integration.test.js`
