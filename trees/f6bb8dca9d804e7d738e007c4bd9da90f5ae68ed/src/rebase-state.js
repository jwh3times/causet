import fs from "node:fs";
import path from "node:path";
import { repoContext } from "./engine.js";
import { readJson, writeJson } from "./store.js";
import { assertReadableSchema } from "./schemas.js";

export function rebaseStatePath(cwd = process.cwd()) {
  return path.join(repoContext(cwd).gitDir, "vcs-lab", "rebase.json");
}

/**
 * Read this worktree's rebase journal. As with the reconciliation journal, a
 * schema this build does not read is refused rather than resumed (ADR-0020).
 */
export function readRebaseState(cwd = process.cwd()) {
  const statePath = rebaseStatePath(cwd);
  const state = readJson(statePath, null);
  if (state === null) return null;
  assertReadableSchema(state?.schema, `The rebase journal at '${statePath}'`, {
    family: "vcs-lab.rebase-operation",
    recovery:
      "Recover it with the vcs-lab build that wrote it, or remove the file to discard the operation.",
  });
  return state;
}

export function writeRebaseState(state, cwd = process.cwd()) {
  const updated = {
    ...state,
    updatedAt: new Date().toISOString(),
  };
  writeJson(rebaseStatePath(cwd), updated);
  return updated;
}

export function clearRebaseState(cwd = process.cwd()) {
  fs.rmSync(rebaseStatePath(cwd), { force: true });
}
