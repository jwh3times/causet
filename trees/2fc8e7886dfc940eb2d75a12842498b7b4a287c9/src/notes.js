import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runGit } from "./git.js";
import {
  listNoteEntries as listNotes,
  reachableCommits,
  readGitObjects,
  readNoteText,
} from "./engine.js";
import { CliError } from "./errors.js";
import { gatePoint } from "./faults.js";
import { RESOURCE_BOUNDS, withinBound } from "./schemas.js";
import { ensureLabRuntime } from "./store.js";

export const NOTES_REF = "vcs-lab";

const NOTE_SCHEMA = "vcs-lab.note/v1";

const NOTES_LOCK_NAME = "notes.lock";
/** How long a writer waits for another's turn on the notes ref before refusing. */
const NOTES_LOCK_WAIT_MS = 5_000;
/**
 * A lock at least this old whose holder cannot be checked, because it is on
 * another host or the file is unreadable, is abandoned. A holder on this host
 * is checked directly and abandoned only once it is no longer running.
 */
const NOTES_LOCK_STALE_MS = 60_000;
const NOTES_LOCK_POLL_MS = 15;
/**
 * Besides the expected `EEXIST`, Windows reports these while another process
 * still has the lock file open as it is being removed or renamed; each is a
 * moment to wait through, not a failure.
 */
const TRANSIENT_LOCK_CODES = new Set(["EEXIST", "EPERM", "EACCES", "EBUSY"]);

const heldNotesLocks = new Set();

function emptyNote() {
  return { schema: NOTE_SCHEMA, records: [] };
}

/**
 * Classify one note's text. This is the single note parser shared by
 * `readNote`, `readNotes`, `listNoteRecords`, and `appendNote` so the
 * resolution catalog, receipts, and note rewriting cannot disagree about a
 * note's shape. Notes are shared-portable and arrive by fetch from clones that
 * may run another vcs-lab build, so every disposition here is non-fatal on read
 * (ADR-0020):
 *
 * - `accept`: a versioned `vcs-lab.note/v1` container within its bounds.
 * - `legacy`: unparsable text, preserved as one opaque record so a rewrite
 *   cannot lose it.
 * - `foreign`: valid JSON that is not a `vcs-lab.note/v1` container (a future
 *   container version, or a bare array of records, which `metadata validate`
 *   rejects as malformed). It yields no records and must not be rewritten.
 * - `oversize`: over `noteContainerBytes` or `noteContainerRecords`. It is
 *   quarantined unparsed rather than loaded, so an untrusted note cannot force
 *   unbounded work.
 */
function classifyNoteText(text) {
  if (!text) return { note: emptyNote(), disposition: "empty" };
  if (!withinBound("noteContainerBytes", Buffer.byteLength(text, "utf8"))) {
    return { note: emptyNote(), disposition: "oversize" };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Preserve an existing non-vlab note as an opaque legacy record.
    return {
      note: { schema: NOTE_SCHEMA, records: [{ type: "legacy-note", text }] },
      disposition: "legacy",
    };
  }
  if (parsed?.schema !== NOTE_SCHEMA || !Array.isArray(parsed.records)) {
    return { note: emptyNote(), disposition: "foreign" };
  }
  if (!withinBound("noteContainerRecords", parsed.records.length)) {
    return { note: emptyNote(), disposition: "oversize" };
  }
  return { note: parsed, disposition: "accept" };
}

function parseNoteText(text) {
  return classifyNoteText(text).note;
}

export function readNote(commit, cwd = process.cwd()) {
  const text = readNoteText(NOTES_REF, commit, cwd);
  if (text === null) return emptyNote();
  return parseNoteText(text);
}

/**
 * Read the notes attached to several objects with two bounded Git queries
 * (one note listing plus one batched object read) instead of one
 * `git notes show` process per object. Every requested object maps to a note
 * container; objects without a readable note map to an empty container,
 * matching `readNote`.
 */
export function readNotes(objects, cwd = process.cwd()) {
  const notes = new Map();
  for (const object of objects) notes.set(object, emptyNote());
  if (notes.size === 0) return notes;
  const entries = listNoteEntries(cwd).filter((entry) => notes.has(entry.target));
  if (entries.length === 0) return notes;
  const blobs = readGitObjects(entries.map((entry) => entry.note), cwd);
  for (let index = 0; index < entries.length; index += 1) {
    const blob = blobs[index];
    if (!blob.exists || blob.type !== "blob") continue;
    notes.set(
      entries[index].target,
      parseNoteText(blob.content.toString("utf8").trim()),
    );
  }
  return notes;
}

/**
 * The notes ref is shared by every worktree of a repository, and every
 * receipt reaches it through a read-modify-write: read a commit's container,
 * append, write the whole blob back with `git notes add -f`. Git serializes
 * the ref update but not the read-modify-write, and `git notes add` itself
 * builds its tree from the ref as it stood when the command started and then
 * updates the ref unconditionally, so two publishers running at once could
 * each lose the other's record: on the same commit the later blob lacks the
 * earlier record, on different commits the later tree lacks the earlier note.
 * `withNotesLock` serializes every vcs-lab writer of the ref on one lock file
 * in the shared runtime directory, created exclusively the way Git creates
 * its own `.lock` files. It costs no Git process.
 *
 * A lock a crashed writer left behind must not block the repository forever,
 * and a live writer's lock must never be taken from it: a slow publisher is
 * not a dead one. The claim records who holds the lock, and a waiter abandons
 * it only when the holder is on this host and no longer running, or when the
 * lock is older than `NOTES_LOCK_STALE_MS` and its holder cannot be checked.
 * Otherwise the waiter waits `NOTES_LOCK_WAIT_MS` and then refuses with
 * `notes-locked`, naming the holder and the file. The lock is reentrant
 * within one process, so a writer that already holds it may append.
 */
export function withNotesLock(cwd, action) {
  const lockPath = path.join(ensureLabRuntime(cwd), NOTES_LOCK_NAME);
  if (heldNotesLocks.has(lockPath)) return action();
  acquireNotesLock(lockPath);
  heldNotesLocks.add(lockPath);
  try {
    return action();
  } finally {
    heldNotesLocks.delete(lockPath);
    releaseNotesLock(lockPath);
  }
}

function pauseSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function processIsRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // A process this one may not signal is still a process.
    return error?.code === "EPERM";
  }
}

function inspectNotesLock(lockPath) {
  let stat;
  try {
    stat = fs.statSync(lockPath);
  } catch (error) {
    if (error?.code === "ENOENT") return { present: false };
    throw error;
  }
  let holder = null;
  try {
    holder = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  } catch {
    // Unreadable, or still being written by its creator: judged by age alone.
  }
  const ageMs = Math.max(0, Date.now() - stat.mtimeMs);
  const local = holder?.hostname === os.hostname() && Number.isInteger(holder?.pid);
  // A claim of this very process is a leftover of an earlier append whose
  // release failed, never a live holder.
  const own = local && holder.pid === process.pid;
  const stale = own || (local ? !processIsRunning(holder.pid) : ageMs >= NOTES_LOCK_STALE_MS);
  return { present: true, holder, ageMs, stale };
}

function abandonNotesLock(lockPath) {
  // Rename before removing, so two waiters that both judged the lock stale
  // cannot remove each other's fresh claim: only one rename succeeds, and the
  // other finds the name gone and claims it.
  const abandoned = `${lockPath}.abandoned-${process.pid}-${Date.now()}`;
  try {
    fs.renameSync(lockPath, abandoned);
  } catch (error) {
    if (error?.code === "ENOENT" || TRANSIENT_LOCK_CODES.has(error?.code)) return;
    throw error;
  }
  try {
    fs.rmSync(abandoned, { force: true });
  } catch {
    // A leftover `.abandoned-*` file locks nothing.
  }
}

function acquireNotesLock(lockPath) {
  const claim = `${JSON.stringify({
    pid: process.pid,
    hostname: os.hostname(),
    createdAt: new Date().toISOString(),
  })}\n`;
  const deadline = Date.now() + NOTES_LOCK_WAIT_MS;
  let lastError = null;
  for (;;) {
    try {
      fs.writeFileSync(lockPath, claim, { flag: "wx" });
      return;
    } catch (error) {
      if (!TRANSIENT_LOCK_CODES.has(error?.code)) throw error;
      lastError = error;
    }
    const lock = inspectNotesLock(lockPath);
    if (lock.present && lock.stale) {
      abandonNotesLock(lockPath);
      continue;
    }
    if (Date.now() >= deadline) {
      if (!lock.present) throw lastError;
      const holder = lock.holder?.pid
        ? `process ${lock.holder.pid} on ${lock.holder.hostname}`
        : "another process";
      throw new CliError(
        `The causal notes are locked by ${holder}; the lock is ` +
        `${Math.round(lock.ageMs / 1000)} s old.`,
        {
          code: "notes-locked",
          details:
            "Wait for that publication to finish and retry. If the process is gone, " +
            `remove ${lockPath}.`,
        },
      );
    }
    pauseSync(NOTES_LOCK_POLL_MS);
  }
}

function releaseNotesLock(lockPath) {
  // Remove only this process's claim: a lock that was abandoned as stale and
  // claimed by another writer meanwhile is that writer's now.
  let holder;
  try {
    holder = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  } catch {
    return;
  }
  if (holder?.pid !== process.pid || holder?.hostname !== os.hostname()) return;
  try {
    fs.rmSync(lockPath, { force: true });
  } catch {
    // Left behind, it names a process that will have exited, and the next
    // writer abandons it.
  }
}

/**
 * Append one record to a commit's note container, under the notes lock so a
 * second publisher's append between the read and the write cannot be lost.
 * `git notes add -f` replaces the whole blob, so this refuses to rewrite a
 * note it could not fully read: a container of another version, or one over
 * a published resource bound, would otherwise be destroyed by the rewrite
 * (ADR-0020). Publishing a receipt fails closed instead, leaving the existing
 * note byte-for-byte intact.
 */
export function appendNote(commit, record, cwd = process.cwd()) {
  return withNotesLock(cwd, () => {
    const text = readNoteText(NOTES_REF, commit, cwd);
    const { note, disposition } = classifyNoteText(text === null ? "" : text);
    if (disposition === "foreign") {
      throw new CliError(
        `The note on '${commit}' is not a ${NOTE_SCHEMA} container.`,
        {
          code: "wrong-record-family",
          details:
            "vcs-lab will not overwrite a note container it cannot read. Inspect it " +
            `with: git notes --ref=${NOTES_REF} show ${commit}`,
        },
      );
    }
    if (disposition === "oversize") {
      throw new CliError(
        `The note on '${commit}' exceeds a published note-container resource bound.`,
        {
          code: "resource-bound-exceeded",
          details:
            `Notes are limited to ${RESOURCE_BOUNDS.noteContainerBytes} bytes and ` +
            `${RESOURCE_BOUNDS.noteContainerRecords} records; see docs/schemas/compatibility.md.`,
        },
      );
    }
    note.records.push(record);
    if (!withinBound("noteContainerRecords", note.records.length)) {
      throw new CliError(
        `The note on '${commit}' would exceed the noteContainerRecords bound of ` +
        `${RESOURCE_BOUNDS.noteContainerRecords}.`, { code: "resource-bound-exceeded" },
      );
    }
    // The window between the read and the write, where a second publisher's
    // append would be lost without the lock; the failure-boundary suite parks
    // a process here to prove the lock closes it.
    gatePoint("notes:after-read");
    runGit(
      ["notes", `--ref=${NOTES_REF}`, "add", "-f", "-F", "-", commit],
      { cwd, input: `${JSON.stringify(note, null, 2)}\n` },
    );
    return note;
  });
}

export function listNoteTargets(cwd = process.cwd()) {
  return listNoteEntries(cwd).map((entry) => entry.target);
}

function listNoteEntries(cwd = process.cwd()) {
  return listNotes(NOTES_REF, cwd);
}

function recordsForEntries(entries, cwd) {
  if (entries.length === 0) return [];
  const objects = readGitObjects(entries.map((entry) => entry.note), cwd);
  const records = [];
  for (let index = 0; index < entries.length; index += 1) {
    const object = objects[index];
    if (!object.exists || object.type !== "blob") continue;
    const note = parseNoteText(object.content.toString("utf8").trim());
    for (const record of note.records) {
      records.push({ ...record, attachedTo: entries[index].target });
    }
  }
  return records;
}

export function listNoteRecords(cwd = process.cwd()) {
  return recordsForEntries(listNoteEntries(cwd), cwd).sort((left, right) =>
    String(left.createdAt ?? "").localeCompare(String(right.createdAt ?? "")),
  );
}

/**
 * Records attached to commits reachable from `ref`. A caller that already
 * holds the reachable set passes it as `reachable` (a Set or an array of
 * commits); the two-argument form derives it here.
 */
export function recordsReachableFrom(
  ref,
  cwd = process.cwd(),
  reachable = null,
) {
  const commits = reachable instanceof Set
    ? reachable
    : new Set(reachable ?? reachableCommits(ref, cwd));
  const entries = listNoteEntries(cwd).filter((entry) =>
    commits.has(entry.target),
  );
  return recordsForEntries(entries, cwd);
}
