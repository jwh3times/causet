# ADR-0005: Scope private operation state to a worktree

- **Status:** Accepted
- **Date:** 2026-08-20
- **Owners:** Repository maintainers
- **Related requirements:** GP-06, FR-REC-07 through FR-REC-10, FR-WS-01 through FR-WS-06

## Context

Git linked worktrees share objects and most refs, but each has its own `HEAD`,
index, and in-progress merge/cherry-pick files. AI-agent workflows commonly run
several linked worktrees concurrently. Storing one reconciliation journal in
the common Git directory would allow one agent to overwrite or continue
another agent's operation.

Completed causal facts and reusable resolutions, however, should be visible to
all worktrees in the repository.

## Decision

Use the following scope rule:

- **worktree-private:** pending reconciliation journals, saved forecasts,
  current resolution selections, and any state whose meaning depends on that
  worktree's `HEAD` or index;
- **repository-shared:** completed landing/application/reconciliation records,
  retained exact resolution results, workspace registry, and checkpoint refs;
- **tracked/portable:** specification manifests that must travel with source.

Derive worktree-private storage from `git rev-parse --git-dir` and shared local
storage from `--git-common-dir`. Do not infer one from the other.

## Consequences

### Positive

- Two agents can pause independent operations safely.
- Reusable facts are available immediately across linked worktrees.
- Operation recovery aligns with Git's own worktree-private state.

### Negative

- Private forecasts/journals do not automatically move with a worktree path or
  clone.
- The workspace registry contains machine-local paths and needs lifecycle
  repair features.
- Backup and metadata inventory must explain multiple scopes.

## Alternatives considered

- **One repository-global operation file:** rejected due to concurrent
  worktree collisions.
- **Track operation journals in the project tree:** rejected because transient
  operations would create commits/conflicts and expose private drafts.
- **Keep everything private:** rejected because exact resolutions and completed
  causal facts should be reusable.

## Invariant

Any cache or journal whose interpretation can change with a linked worktree's
private state must be keyed or stored by that exact worktree.
