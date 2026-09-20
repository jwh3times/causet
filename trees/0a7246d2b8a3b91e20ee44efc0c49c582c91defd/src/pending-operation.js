import { CliError } from "./errors.js";
import {
  readReconciliationState,
  writeReconciliationState,
} from "./reconcile-state.js";
import { readRebaseState, writeRebaseState } from "./rebase-state.js";

export function readPendingOperation(cwd = process.cwd()) {
  const reconciliation = readReconciliationState(cwd);
  const rebase = readRebaseState(cwd);
  if (reconciliation && rebase) {
    throw new CliError(
      "This worktree contains both reconciliation and rebase journals.",
      { code: "git-operation-active", details: "Do not mutate the worktree; inspect and recover one journal explicitly." },
    );
  }
  return reconciliation ?? rebase;
}

export function writePendingOperation(operation, cwd = process.cwd()) {
  if (operation?.schema === "vcs-lab.reconciliation-operation/v4") {
    return writeReconciliationState(operation, cwd);
  }
  if (operation?.schema === "vcs-lab.rebase-operation/v1") {
    return writeRebaseState(operation, cwd);
  }
  throw new CliError(
    `Cannot persist unknown pending operation schema '${operation?.schema ?? "(missing)"}'.`,
      { code: "unknown-schema-version" },
  );
}
