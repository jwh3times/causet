import fs from "node:fs";
import path from "node:path";
import { pseudoRefTarget, repoContext } from "./engine.js";

export { unmergedPaths } from "./engine.js";
import { readJson, writeJson } from "./store.js";
import { assertReadableSchema } from "./schemas.js";

export function reconciliationStatePath(cwd = process.cwd()) {
  const { gitDir } = repoContext(cwd);
  return path.join(gitDir, "vcs-lab", "reconciliation.json");
}

/**
 * Read this worktree's reconciliation journal. A journal whose schema this
 * build does not read is refused rather than resumed (ADR-0020): the queue,
 * cursor, and recovery fields of a version we do not understand cannot be
 * interpreted safely, and resuming or aborting from them could move refs the
 * writer never intended.
 */
export function readReconciliationState(cwd = process.cwd()) {
  const statePath = reconciliationStatePath(cwd);
  const state = readJson(statePath, null);
  if (state === null) return null;
  assertReadableSchema(state?.schema, `The reconciliation journal at '${statePath}'`, {
    family: "vcs-lab.reconciliation-operation",
    recovery:
      "Recover it with the vcs-lab build that wrote it, or remove the file to discard the operation.",
  });
  return state;
}

export function writeReconciliationState(state, cwd = process.cwd()) {
  const updated = {
    ...state,
    updatedAt: new Date().toISOString(),
  };
  writeJson(reconciliationStatePath(cwd), updated);
  return updated;
}

export function clearReconciliationState(cwd = process.cwd()) {
  fs.rmSync(reconciliationStatePath(cwd), { force: true });
}

/**
 * The commit of Git's pending cherry-pick, or null when none is pending.
 * Read through the engine seam like every other repository fact, so a
 * native engine answers it too and so it is correct on every ref backend.
 */
export function cherryPickHead(cwd = process.cwd()) {
  return pseudoRefTarget("CHERRY_PICK_HEAD", cwd);
}

/**
 * Where the sequencer keeps the message of the pending pick. This is a path
 * into the sequencer's own state, which a contextual fork rewrites before
 * `cherry-pick --continue` reads it; the Git directory it hangs off is the
 * engine's `repoContext` fact, and the sequencer itself stays with the Git
 * executable under ADR-0015.
 */
export function mergeMessagePath(cwd = process.cwd()) {
  return path.join(repoContext(cwd).gitDir, "MERGE_MSG");
}
