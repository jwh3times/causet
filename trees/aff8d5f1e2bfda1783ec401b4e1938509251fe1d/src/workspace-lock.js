import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { CliError } from "./errors.js";
import { gatePoint } from "./faults.js";
import { ensureLabRuntime } from "./store.js";

const WAIT_MS = 5_000;
const POLL_MS = 20;
const TRANSIENT_CODES = new Set(["EEXIST", "EPERM", "EACCES", "EBUSY"]);
const heldLocks = new Set();

function lockPath(cwd) {
  return path.join(fs.realpathSync.native(ensureLabRuntime(cwd)), "workspaces.lock");
}

function readClaim(file) {
  try {
    // Claims are diagnostic, untrusted local input. An incomplete or oversized
    // claim still locks the registry; it is never evidence of abandonment.
    if (fs.statSync(file).size > 4_096) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Serialize synchronous registry transactions across every linked worktree.
 * No waiter ever removes a claim, including a dead, foreign, or malformed
 * holder's. A stat/read followed by rename/unlink cannot conditionally remove
 * the file that was inspected: a replacement writer could now own that path.
 * Recover stale claims explicitly with all writers stopped instead.
 */
export function withWorkspaceRegistryLock(cwd, action) {
  const file = lockPath(cwd);
  if (heldLocks.has(file)) return action();
  const token = randomUUID();
  const claim = `${JSON.stringify({ token, pid: process.pid, hostname: os.hostname(), createdAt: new Date().toISOString() })}\n`;
  const deadline = performance.now() + WAIT_MS;
  const cell = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try {
      fs.writeFileSync(file, claim, { flag: "wx" });
      break;
    } catch (error) {
      if (!TRANSIENT_CODES.has(error?.code)) throw error;
      gatePoint("workspaces:lock-contended");
      if (performance.now() >= deadline) {
        const holder = readClaim(file);
        const pid = Number.isSafeInteger(holder?.pid) && holder.pid > 0 ? holder.pid : "unknown";
        const hostname = typeof holder?.hostname === "string" ? holder.hostname.slice(0, 255) : "unknown";
        throw new CliError("The workspace registry lock could not be acquired.", {
          code: "workspace-registry-locked",
          details: `${file}\nHolder: process ${pid} on ${hostname}\n` +
            "Wait for the operation to finish and retry. For an abandoned lock, stop all workspace " +
            "writers on every host sharing this repository, inspect the registry and Git worktrees " +
            "for partial changes, then remove only this lock file before restarting writers. " +
            "Age or a missing PID alone does not authorize removing a lock while writers can run.",
        });
      }
      Atomics.wait(cell, 0, 0, POLL_MS);
    }
  }
  heldLocks.add(file);
  try {
    return action();
  } finally {
    heldLocks.delete(file);
    // Cooperating writers never replace a held claim. Also preserve a claim
    // replaced out of band instead of deleting an operator's or another holder's.
    if (readClaim(file)?.token === token) fs.rmSync(file);
  }
}

export function assertWorkspaceRegistryLock(cwd) {
  if (!heldLocks.has(lockPath(cwd))) {
    throw new CliError("A workspace registry write requires its transaction lock.", {
      code: "internal-invariant",
    });
  }
}
