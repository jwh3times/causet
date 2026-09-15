import fs from "node:fs";
import path from "node:path";
import { extractTrailer, gitText, runGit } from "./git.js";
import {
  commitMessage,
  currentHead,
  ignoredPaths,
  inspectGitObjects,
  isInsideWorkTree,
  listWorktreeGitDirs,
  porcelainStatus,
  refExists,
  repoContext,
  resolveRevision,
  symbolicRef,
  treeId,
  workspaceStatus,
} from "./engine.js";
import { newId, sha256, slug } from "./ids.js";
import { ensureLabRuntime, readJson, temporaryDirectory, writeJson } from "./store.js";
import { CliError } from "./errors.js";
import { assertReadableSchema } from "./schemas.js";
import { faultPoint, gatePoint } from "./faults.js";
import { assertWorkspaceRegistryLock, withWorkspaceRegistryLock } from "./workspace-lock.js";

const ACTIVE = "active";
const ARCHIVED = "archived";

function workspaceLifecycle(workspace) {
  return workspace.lifecycle ?? ACTIVE;
}

function workspaceCheckpointRef(workspace) {
  return `refs/vcs-lab/checkpoints/${workspace.id}`;
}

function workspaceCheckpointHistoryRef(workspace, checkpoint) {
  return `refs/vcs-lab/checkpoint-history/${workspace.id}/${checkpoint}`;
}

function workspaceFile(cwd) {
  return path.join(ensureLabRuntime(cwd), "workspaces.json");
}

/**
 * Read the shared-local workspace registry. A registry whose schema this build
 * does not read is refused rather than used (ADR-0020): the registry is the
 * only record of which worktrees vcs-lab materialized, and `saveWorkspaces`
 * rewrites the whole file, so consuming a version we do not understand would
 * silently drop its members.
 */
export function readWorkspaces(cwd = process.cwd()) {
  const registryPath = workspaceFile(cwd);
  const registry = readJson(registryPath, {
    schema: "vcs-lab.workspaces/v1",
    workspaces: [],
  });
  assertReadableSchema(registry?.schema, `The workspace registry at '${registryPath}'`, {
    family: "vcs-lab.workspaces",
    recovery: "Read it with the vcs-lab build that wrote it.",
  });
  if (!Array.isArray(registry.workspaces)) {
    throw new CliError(`The workspace registry at '${registryPath}' has no workspace list.`,
      { code: "malformed-input" });
  }
  for (const workspace of registry.workspaces) {
    assertReadableSchema(workspace?.schema, `A workspace entry in '${registryPath}'`, {
      family: "vcs-lab.workspace",
      recovery: "Read it with the vcs-lab build that wrote it.",
    });
  }
  return registry;
}

function saveWorkspaces(value, cwd) {
  assertWorkspaceRegistryLock(cwd);
  writeJson(workspaceFile(cwd), value);
}

function readWorkspaceMutationState(cwd) {
  const state = readWorkspaces(cwd);
  gatePoint("workspaces:after-read");
  faultPoint("workspaces:after-read");
  return state;
}

function findWorkspace(state, value) {
  const index = state.workspaces.findIndex(
    (workspace) => workspace.name === value || workspace.id === value,
  );
  if (index < 0) throw new CliError(`Workspace '${value}' was not found.`,
    { code: "not-found" });
  return { index, workspace: state.workspaces[index] };
}

function workspacePathKind(workspacePath) {
  let stat;
  try {
    stat = fs.statSync(workspacePath, { throwIfNoEntry: false });
  } catch {
    stat = null;
  }
  if (!stat) return "missing";
  return stat.isDirectory() ? "directory" : "other";
}

function inspectWorkspace(workspace) {
  const lifecycle = workspaceLifecycle(workspace);
  let pathStatus = "missing";
  let head = null;
  let dirtyFiles = null;
  const kind = workspacePathKind(workspace.path);
  if (kind === "other") {
    pathStatus = "invalid";
  } else if (kind === "directory") {
    // One worktree-scoped query answers usability, exact HEAD, and dirty
    // count together. When it fails, a directory Git does not recognize as a
    // work tree is invalid; a recognized work tree whose status cannot be
    // read is an error rather than a silently degraded entry.
    const status = workspaceStatus(workspace.path);
    if (status.ok) {
      pathStatus = "active";
      ({ head, dirtyFiles } = status);
    } else if (isInsideWorkTree(workspace.path)) {
      throw new CliError(
        `git status --porcelain=v2 --branch -z failed in workspace '${workspace.name}'`,
        { code: "git-command-failed", details: status.error, exitCode: status.exitCode },
      );
    } else {
      pathStatus = "invalid";
    }
  }
  return {
    ...workspace,
    lifecycle,
    status: lifecycle === ARCHIVED ? ARCHIVED : pathStatus,
    pathStatus,
    head,
    dirtyFiles,
  };
}

function updateWorkspace(state, index, updates, cwd) {
  state.workspaces[index] = {
    ...state.workspaces[index],
    ...updates,
  };
  saveWorkspaces(state, cwd);
  return state.workspaces[index];
}

function requireLifecycle(workspace, lifecycle, action) {
  const actual = workspaceLifecycle(workspace);
  if (actual !== lifecycle) {
    throw new CliError(
      `Workspace '${workspace.name}' must be ${lifecycle} before it can be ${action}.`,
        { code: "precondition-not-met" },
    );
  }
}

function requireMaterialized(workspace, action) {
  const inspected = inspectWorkspace(workspace);
  if (inspected.pathStatus !== ACTIVE) {
    throw new CliError(
      `Workspace '${workspace.name}' is not a usable linked worktree. Repair or prune its stale path before ${action}.`,
        { code: "precondition-not-met" },
    );
  }
  return inspected;
}

function assertCallerOutsideWorkspace(cwd, workspace, action) {
  if (path.resolve(repoContext(cwd).root) === path.resolve(workspace.path)) {
    throw new CliError(
      `Run workspace ${action} from another linked worktree; the command changes '${workspace.path}'.`,
        { code: "precondition-not-met" },
    );
  }
}

function appendPreviousPath(workspace, previousPath) {
  return [
    ...new Set([
      ...(workspace.previousPaths ?? []),
      previousPath,
    ].map((item) => path.resolve(item))),
  ];
}

/**
 * Normalize and validate a sparse-checkout cone. Cone mode takes directory
 * prefixes relative to the repository root; anything absolute, empty, or
 * climbing out of the tree is refused rather than passed to Git, because a
 * cone that escapes the worktree is a request nobody can mean.
 */
function normalizeCone(cone) {
  if (cone === undefined || cone === null) return null;
  const entries = (Array.isArray(cone) ? cone : String(cone).split(","))
    .map((entry) => String(entry).trim().split("\\").join("/").replace(/^\.\//, ""))
    .filter(Boolean)
    .map((entry) => entry.replace(/\/+$/, ""));
  if (entries.length === 0) return null;
  for (const entry of entries) {
    if (path.isAbsolute(entry) || /^[a-zA-Z]:/.test(entry)) {
      throw new CliError(`Cone path must be relative to the repository root: '${entry}'`,
        { code: "path-outside-repository" });
    }
    if (entry === ".." || entry.startsWith("../") || entry.includes("/../")) {
      throw new CliError(`Cone path must stay inside the repository: '${entry}'`,
        { code: "path-outside-repository" });
    }
  }
  return [...new Set(entries)].sort();
}

/**
 * Materialize a linked worktree, optionally restricted to a sparse-checkout
 * cone so the workspace writes only the directories it owns. Measured on this
 * host, a cone over one of twenty directories cut a 3000-file checkout from
 * 1529 ms to 191 ms and from 2946 KiB to 147 KiB (issue #10).
 *
 * The cone changes only which files are present in the working tree: the
 * workspace ID, compatibility branch, base snapshot, checkpoints, and
 * lifecycle are identical with it and without it, and Git still has the whole
 * tree. It is opt-in, and reversible in place with
 * `git sparse-checkout disable` inside the worktree.
 */
function addWorktree(context, worktreePath, addArgs, cone) {
  try {
    if (!cone?.length) {
      runGit(["worktree", "add", ...addArgs], { cwd: context.root });
      return;
    }
    runGit(["worktree", "add", "--no-checkout", ...addArgs], { cwd: context.root });
    // `set --cone` establishes cone mode itself, so a separate
    // `sparse-checkout init` is a process spent on nothing (Git 2.37+; the
    // supported floor is 2.40).
    runGit(["sparse-checkout", "set", "--cone", ...cone], { cwd: worktreePath });
    runGit(["checkout"], { cwd: worktreePath });
  } catch (error) {
    if (error instanceof CliError) {
      error.details += `\nWorkspace materialization failed at '${worktreePath}'. ` +
        "The workspace registry was not updated. Git may have created a worktree or branch; " +
        "inspect them with git worktree list before repairing or removing partial materialization and retrying.";
    }
    throw error;
  }
}

export function createWorkspace(name, options = {}) {
  return withWorkspaceRegistryLock(options.cwd ?? process.cwd(), () =>
    createWorkspaceLocked(name, options));
}

function createWorkspaceLocked(name, options) {
  const cwd = options.cwd ?? process.cwd();
  const context = repoContext(cwd);
  const target = options.from ?? "HEAD";
  const safeName = slug(name);
  const branch = `vlab/ws/${safeName}`;

  // Resolving the base and checking the branch for a collision are two
  // questions about objects, so they go through one batched inspection rather
  // than a rev-parse process and a show-ref process. On this Windows host each
  // avoided process is about 35 ms of a command that measured 457 ms, and the
  // batch also rides the object session when one is open (ADR-0009, ADR-0019).
  const [baseObject, branchObject] = inspectGitObjects(
    [`${target}^{commit}`, `refs/heads/${branch}`],
    cwd,
  );
  if (!baseObject.exists || baseObject.type !== "commit") {
    throw new CliError(`Git revision '${target}' did not resolve to a commit.`,
      { code: "revision-not-resolved" });
  }
  const baseSnapshot = baseObject.oid;

  const state = readWorkspaceMutationState(cwd);
  if (state.workspaces.some((workspace) => workspace.name === name)) {
    throw new CliError(`Workspace '${name}' already exists.`, { code: "already-exists" });
  }

  const parent = path.dirname(context.root);
  const repoName = path.basename(context.root);
  const workspacePath = path.resolve(
    options.path ?? path.join(parent, `${repoName}.workspaces`, safeName),
  );
  if (branchObject.exists) {
    throw new CliError(`The compatibility branch '${branch}' already exists.`,
      { code: "already-exists" });
  }
  const cone = normalizeCone(options.cone);
  fs.mkdirSync(path.dirname(workspacePath), { recursive: true });
  addWorktree(context, workspacePath, ["-b", branch, workspacePath, baseSnapshot], cone);

  const workspace = {
    schema: "vcs-lab.workspace/v1",
    id: newId("ws"),
    name,
    path: workspacePath,
    compatibilityBranch: branch,
    target,
    baseSnapshot,
    createdAt: new Date().toISOString(),
    owner: options.owner ?? null,
    focus: options.focus ?? null,
    cone,
    lifecycle: "active",
  };
  state.workspaces.push(workspace);
  saveWorkspaces(state, cwd);
  return workspace;
}

export function listWorkspaces(cwd = process.cwd()) {
  const state = readWorkspaces(cwd);
  return state.workspaces.map(inspectWorkspace);
}

function currentWorkspace(cwd) {
  const context = repoContext(cwd);
  const state = readWorkspaces(cwd);
  const match = state.workspaces.find(
    (workspace) => path.resolve(workspace.path) === path.resolve(context.root),
  );
  if (match) {
    requireLifecycle(match, ACTIVE, "checkpointed");
    return match;
  }
  return {
    id: "main",
    name: path.basename(context.root),
    path: context.root,
    target: "HEAD",
    baseSnapshot: currentHead(cwd),
  };
}

export function checkpointWorkspace(label, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const context = repoContext(cwd);
  const workspace = currentWorkspace(cwd);
  const scratchDirectory = temporaryDirectory("vlab-index-");
  const indexPath = path.join(scratchDirectory, "index");
  const env = { GIT_INDEX_FILE: indexPath };
  const ref = workspaceCheckpointRef(workspace);

  try {
    runGit(["read-tree", "HEAD"], { cwd: context.root, env });
    runGit(["add", "-A"], { cwd: context.root, env });
    const tree = gitText(["write-tree"], { cwd: context.root, env });
    const baseHead = currentHead(context.root);
    const previousCheckpoint = refExists(ref, context.root)
      ? resolveRevision(ref, context.root)
      : null;
    const draftChangeId = `draft_${sha256(JSON.stringify({
      workspaceId: workspace.id,
      baseHead,
      tree,
    }))}`;
    const trailers = [
      `Change-Id: ${draftChangeId}`,
      `Workspace-Id: ${workspace.id}`,
      `Workspace-Base: ${baseHead}`,
      `Workspace-Tree: ${tree}`,
      previousCheckpoint
        ? `Workspace-Previous-Checkpoint: ${previousCheckpoint}`
        : null,
    ].filter(Boolean);
    const message = [
      label || `Checkpoint ${workspace.name}`,
      "",
      ...trailers,
    ].join("\n");
    const checkpoint = gitText(
      ["commit-tree", tree, "-p", baseHead, "-F", "-"],
      { cwd: context.root, env, input: `${message}\n` },
    );
    let historyRef = null;
    if (previousCheckpoint) {
      historyRef = workspaceCheckpointHistoryRef(
        workspace,
        previousCheckpoint,
      );
      runGit(["update-ref", historyRef, previousCheckpoint], {
        cwd: context.root,
      });
    }
    runGit(["update-ref", ref, checkpoint], { cwd: context.root });
    return {
      schema: "vcs-lab.checkpoint/v1",
      id: checkpoint,
      shortId: checkpoint.slice(0, 12),
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      tree,
      parent: baseHead,
      baseHead,
      previousCheckpoint,
      historyRef,
      draftChangeId,
      ref,
      label: label || null,
      createdAt: new Date().toISOString(),
    };
  } finally {
    fs.rmSync(scratchDirectory, { recursive: true, force: true });
  }
}

export function latestWorkspaceCheckpoint(workspace, cwd = process.cwd()) {
  const ref = workspaceCheckpointRef(workspace);
  if (!refExists(ref, cwd)) return null;
  const id = resolveRevision(ref, cwd);
  const message = commitMessage(id, cwd);
  const workspaceId = extractTrailer(message, "Workspace-Id");
  const baseHead = extractTrailer(message, "Workspace-Base");
  const recordedTree = extractTrailer(message, "Workspace-Tree");
  const draftChangeId = extractTrailer(message, "Change-Id");
  const checkpointTree = treeId(id, cwd);
  if (workspaceId !== workspace.id) {
    throw new CliError(
      `Checkpoint '${id}' does not belong to workspace '${workspace.name}'.`,
        { code: "repository-mismatch" },
    );
  }
  if (!baseHead) {
    throw new CliError(`Checkpoint '${id}' has no Workspace-Base identity.`,
      { code: "precondition-not-met" });
  }
  if (!recordedTree) {
    throw new CliError(
      `Checkpoint '${id}' predates checkpoint tree identity. Capture a new checkpoint before forecasting it.`,
        { code: "unknown-schema-version" },
    );
  }
  if (recordedTree !== checkpointTree) {
    throw new CliError(`Checkpoint '${id}' has inconsistent tree metadata.`,
      { code: "malformed-input" });
  }
  if (!/^draft_[0-9a-f]{64}$/.test(draftChangeId ?? "")) {
    throw new CliError(
      `Checkpoint '${id}' has no valid draft Change-Id. Capture a new checkpoint before forecasting it.`,
        { code: "precondition-not-met" },
    );
  }
  return {
    id,
    ref,
    tree: checkpointTree,
    workspaceId,
    baseHead,
    draftChangeId,
    previousCheckpoint: extractTrailer(
      message,
      "Workspace-Previous-Checkpoint",
    ),
  };
}

export function moveWorkspace(value, destination, options = {}) {
  return withWorkspaceRegistryLock(options.cwd ?? process.cwd(), () =>
    moveWorkspaceLocked(value, destination, options));
}

function moveWorkspaceLocked(value, destination, options) {
  const cwd = options.cwd ?? process.cwd();
  const context = repoContext(cwd);
  const state = readWorkspaceMutationState(cwd);
  const { index, workspace } = findWorkspace(state, value);
  requireLifecycle(workspace, ACTIVE, "moved");
  requireMaterialized(workspace, "moving it");
  assertCallerOutsideWorkspace(cwd, workspace, "move");

  const nextPath = path.resolve(destination);
  if (nextPath === path.resolve(workspace.path)) {
    return { ...inspectWorkspace(workspace), changed: false };
  }
  if (fs.existsSync(nextPath)) {
    throw new CliError(`Workspace destination already exists: ${nextPath}`,
      { code: "already-exists" });
  }
  fs.mkdirSync(path.dirname(nextPath), { recursive: true });
  runGit(["worktree", "move", workspace.path, nextPath], {
    cwd: context.root,
  });
  const now = new Date().toISOString();
  const updated = updateWorkspace(state, index, {
    path: nextPath,
    previousPaths: appendPreviousPath(workspace, workspace.path),
    movedAt: now,
    updatedAt: now,
  }, cwd);
  return { ...inspectWorkspace(updated), changed: true };
}

export function archiveWorkspace(value, options = {}) {
  return withWorkspaceRegistryLock(options.cwd ?? process.cwd(), () =>
    archiveWorkspaceLocked(value, options));
}

function assertNoOperationJournal(gitDir, action, recovery) {
  for (const [filename, command] of [["reconciliation.json", "reconcile"], ["rebase.json", "rebase"]]) {
    const journal = path.join(gitDir, "vcs-lab", filename);
    // Presence is sufficient: null, malformed, newer-version, and dangling
    // symlink journals must not be treated as permission to delete private state.
    if (fs.lstatSync(journal, { throwIfNoEntry: false })) {
      throw new CliError(`Cannot ${action}: a ${command} operation journal exists at '${journal}'.`, {
        code: "operation-in-progress",
        details: `${recovery} Run 'vlab ${command} --status', then continue a resolved conflict or abort the operation in that worktree before retrying. If this build cannot read the journal, preserve it and recover with the build that wrote it.`,
      });
    }
  }
}

function archiveWorkspaceLocked(value, options) {
  const cwd = options.cwd ?? process.cwd();
  const context = repoContext(cwd);
  const state = readWorkspaceMutationState(cwd);
  const { index, workspace } = findWorkspace(state, value);
  requireLifecycle(workspace, ACTIVE, "archived");
  requireMaterialized(workspace, "archiving it");
  assertCallerOutsideWorkspace(cwd, workspace, "archive");
  assertNoOperationJournal(repoContext(workspace.path).gitDir,
    `archive workspace '${workspace.name}'`, `Recover the operation in '${workspace.path}'.`);

  const status = porcelainStatus(workspace.path);
  if (status) {
    throw new CliError(
      `Workspace '${workspace.name}' has tracked or untracked changes. Commit or remove them before archiving.`,
      { code: "precondition-not-met", details: status },
    );
  }
  const ignored = ignoredPaths(workspace.path);
  if (ignored.length) {
    throw new CliError(
      `Workspace '${workspace.name}' contains ignored files. Move or remove them before archiving.`,
      { code: "precondition-not-met", details: ignored.join("\n") },
    );
  }

  const lastHead = currentHead(workspace.path);
  runGit(["worktree", "remove", workspace.path], { cwd: context.root });
  const now = new Date().toISOString();
  const updated = updateWorkspace(state, index, {
    lifecycle: ARCHIVED,
    archivedAt: now,
    archiveReason: "user",
    lastHead,
    updatedAt: now,
  }, cwd);
  return { ...inspectWorkspace(updated), changed: true };
}

export function restoreWorkspace(value, options = {}) {
  return withWorkspaceRegistryLock(options.cwd ?? process.cwd(), () =>
    restoreWorkspaceLocked(value, options));
}

function restoreWorkspaceLocked(value, options) {
  const cwd = options.cwd ?? process.cwd();
  const context = repoContext(cwd);
  const state = readWorkspaceMutationState(cwd);
  const { index, workspace } = findWorkspace(state, value);
  requireLifecycle(workspace, ARCHIVED, "restored");
  if (!refExists(`refs/heads/${workspace.compatibilityBranch}`, cwd)) {
    throw new CliError(
      `Workspace branch '${workspace.compatibilityBranch}' no longer exists.`,
        { code: "not-found" },
    );
  }
  const restoredPath = path.resolve(options.path ?? workspace.path);
  if (fs.existsSync(restoredPath)) {
    throw new CliError(`Workspace restore path already exists: ${restoredPath}`,
      { code: "already-exists" });
  }
  fs.mkdirSync(path.dirname(restoredPath), { recursive: true });
  // Restoring re-materializes the worktree, so it must reapply the cone the
  // workspace was created with; otherwise an archive/restore cycle would
  // silently write the whole tree.
  addWorktree(
    context,
    restoredPath,
    [restoredPath, workspace.compatibilityBranch],
    normalizeCone(workspace.cone),
  );
  const now = new Date().toISOString();
  const updates = {
    path: restoredPath,
    lifecycle: ACTIVE,
    archivedAt: null,
    archiveReason: null,
    restoredAt: now,
    updatedAt: now,
  };
  if (restoredPath !== path.resolve(workspace.path)) {
    updates.previousPaths = appendPreviousPath(workspace, workspace.path);
  }
  const updated = updateWorkspace(state, index, updates, cwd);
  return { ...inspectWorkspace(updated), changed: true };
}

export function repairWorkspace(value, destination, options = {}) {
  return withWorkspaceRegistryLock(options.cwd ?? process.cwd(), () =>
    repairWorkspaceLocked(value, destination, options));
}

function repairWorkspaceLocked(value, destination, options) {
  const cwd = options.cwd ?? process.cwd();
  const context = repoContext(cwd);
  const state = readWorkspaceMutationState(cwd);
  const { index, workspace } = findWorkspace(state, value);
  const repairedPath = path.resolve(destination);
  if (!fs.existsSync(repairedPath)) {
    throw new CliError(`Workspace repair path does not exist: ${repairedPath}`,
      { code: "not-found" });
  }
  if (
    path.resolve(workspace.path) !== repairedPath &&
    fs.existsSync(workspace.path)
  ) {
    throw new CliError(
      `Recorded workspace path still exists: ${workspace.path}. Use workspace move instead.`,
        { code: "precondition-not-met" },
    );
  }

  let repairedContext;
  try {
    repairedContext = repoContext(repairedPath);
  } catch {
    throw new CliError(`Repair path is not a linked Git worktree: ${repairedPath}`,
      { code: "precondition-not-met" });
  }
  if (path.resolve(repairedContext.commonDir) !== path.resolve(context.commonDir)) {
    throw new CliError("Repair path belongs to a different Git repository.",
      { code: "repository-mismatch" });
  }
  // The branch name exactly as `git branch --show-current` reports it: the
  // symbolic HEAD without its `refs/heads/` prefix, or empty when detached.
  const headRef = symbolicRef("HEAD", repairedPath);
  const branch = headRef?.startsWith("refs/heads/")
    ? headRef.slice("refs/heads/".length)
    : "";
  if (branch !== workspace.compatibilityBranch) {
    throw new CliError(
      `Repair path has branch '${branch || "(detached)"}', expected '${workspace.compatibilityBranch}'.`,
        { code: "precondition-not-met" },
    );
  }

  runGit(["worktree", "repair", repairedPath], { cwd: context.root });
  const now = new Date().toISOString();
  const updates = {
    path: repairedPath,
    lifecycle: ACTIVE,
    archivedAt: null,
    archiveReason: null,
    repairedAt: now,
    updatedAt: now,
  };
  if (repairedPath !== path.resolve(workspace.path)) {
    updates.previousPaths = appendPreviousPath(workspace, workspace.path);
  }
  const updated = updateWorkspace(state, index, updates, cwd);
  return { ...inspectWorkspace(updated), changed: true };
}

export function pruneWorkspaces(options = {}) {
  if (!options.apply) return pruneWorkspacesLocked(options);
  return withWorkspaceRegistryLock(options.cwd ?? process.cwd(), () =>
    pruneWorkspacesLocked(options));
}

function pruneWorkspacesLocked(options) {
  const cwd = options.cwd ?? process.cwd();
  if (options.apply && options.dryRun) {
    throw new CliError("Choose either --dry-run or --apply for workspace prune.",
      { code: "usage-conflicting-options" });
  }
  const context = repoContext(cwd);
  const state = options.apply ? readWorkspaceMutationState(cwd) : readWorkspaces(cwd);
  const candidates = state.workspaces
    .map((workspace, index) => ({ workspace, index }))
    .filter(({ workspace }) =>
      workspaceLifecycle(workspace) === ACTIVE &&
      !fs.existsSync(workspace.path),
    );
  const result = {
    schema: "vcs-lab.workspace-prune/v1",
    dryRun: !options.apply,
    applied: Boolean(options.apply),
    changed: false,
    count: candidates.length,
    candidates: candidates.map(({ workspace }) => ({
      id: workspace.id,
      name: workspace.name,
      path: workspace.path,
      compatibilityBranch: workspace.compatibilityBranch,
    })),
  };
  if (!options.apply || candidates.length === 0) return result;

  // Git prune is repository-wide, including unregistered and missing worktrees.
  // Conservatively require every linked journal to be recovered first; the
  // registry alone cannot identify all private administrative state at risk.
  for (const gitDir of listWorktreeGitDirs(cwd)) {
    assertNoOperationJournal(gitDir, "prune workspaces",
      "Restore any missing worktree path and repair its Git links before recovery.");
  }
  runGit(["worktree", "prune"], { cwd: context.root });
  const now = new Date().toISOString();
  for (const { index } of candidates) {
    const workspace = state.workspaces[index];
    const branchRef = `refs/heads/${workspace.compatibilityBranch}`;
    state.workspaces[index] = {
      ...workspace,
      lifecycle: ARCHIVED,
      archivedAt: now,
      archiveReason: "missing-path-pruned",
      lastHead: refExists(branchRef, cwd)
        ? resolveRevision(branchRef, cwd)
        : workspace.lastHead ?? null,
      updatedAt: now,
    };
  }
  saveWorkspaces(state, cwd);
  result.changed = true;
  return result;
}
