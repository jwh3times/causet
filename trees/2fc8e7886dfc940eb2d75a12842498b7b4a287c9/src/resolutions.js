import fs from "node:fs";
import path from "node:path";
import { runGit } from "./git.js";
import {
  indexEntries,
  inspectGitObjects,
  listRefs,
  readGitBlob,
  refExists,
  resolveRevision,
} from "./engine.js";
import { newId } from "./ids.js";
import { appendNote, readNote, readNotes } from "./notes.js";
import { acceptedCausalRecords } from "./metadata.js";
import {
  RESOLUTION_SIGNATURE_ALGORITHM,
  resolutionSignatureFor,
} from "./schemas.js";
import {
  readPendingOperation,
  writePendingOperation,
} from "./pending-operation.js";
import { CliError } from "./errors.js";

const RESOLUTION_REFS = "refs/vcs-lab/resolutions";

function conflictStages(filePath, cwd) {
  const byStage = new Map(
    indexEntries(cwd, { paths: [filePath], unmergedOnly: true }).map(
      (entry) => [entry.stage, entry],
    ),
  );
  const compact = (stage) => {
    const entry = byStage.get(stage);
    return entry ? { mode: entry.mode, blob: entry.blob } : null;
  };
  return {
    base: compact(1),
    ours: compact(2),
    theirs: compact(3),
  };
}

function compactResolution(record) {
  return {
    id: record.id,
    signature: record.signature,
    resultBlob: record.resultBlob ?? null,
    resultMode: record.resultMode ?? null,
    ref: record.ref,
    originalPath: record.originalPath ?? null,
    createdAt: record.createdAt ?? null,
  };
}

/**
 * Discover every retention ref and the commit it names with two bounded
 * queries: one `for-each-ref` scan that reads only ref names and object IDs
 * (so a dangling ref cannot abort the scan), then one batched object check
 * that peels each ID exactly as `<ref>^{commit}` would. A ref that names a
 * missing object or anything other than a commit cannot carry an accepted
 * resolution record and is quarantined from the catalog; a failed scan is an
 * error rather than an empty catalog.
 */
function listResolutionRefs(cwd) {
  let entries;
  try {
    entries = listRefs(RESOLUTION_REFS, cwd);
  } catch (error) {
    throw new CliError("Could not scan resolution retention refs.", {
      code: "git-command-failed",
      details: error.details,
    });
  }
  if (entries.length === 0) return [];
  const objects = inspectGitObjects(
    entries.map((entry) => `${entry.oid}^{commit}`),
    cwd,
  );
  const refs = [];
  for (let index = 0; index < entries.length; index += 1) {
    const object = objects[index];
    if (object.exists && object.type === "commit") {
      refs.push({ ref: entries[index].ref, commit: object.oid });
    }
  }
  return refs;
}

export function listResolutionRecords(cwd = process.cwd()) {
  const refs = listResolutionRefs(cwd);
  if (refs.length === 0) return [];
  const notes = readNotes(refs.map((entry) => entry.commit), cwd);
  const records = [];
  for (const { ref, commit } of refs) {
    for (const record of notes.get(commit).records) {
      if (record.type === "resolution") {
        records.push({ ...record, attachedTo: commit, discoveredRef: ref, commit });
      }
    }
  }
  const accepted = acceptedCausalRecords(records, cwd).filter((record) =>
    record.ref === record.discoveredRef &&
    record.resolutionCommit === record.commit &&
    resolutionSignatureFor(record) === record.signature,
  );
  // Only existence, type, and identity are checked, so the retained results
  // are inspected rather than read: their contents are never needed here.
  const retained = inspectGitObjects(
    accepted.filter((record) => record.resultBlob).map((record) => `${record.commit}:result`),
    cwd,
  );
  let retainedIndex = 0;
  return accepted.filter((record) => {
    if (!record.resultBlob) return true;
    const object = retained[retainedIndex++];
    return object?.exists && object.type === "blob" && object.oid === record.resultBlob;
  }).sort((left, right) =>
    String(right.createdAt ?? "").localeCompare(String(left.createdAt ?? "")),
  );
}

export function captureConflictDescriptors(paths, cwd = process.cwd()) {
  if (paths.length === 0) return [];
  // The catalog is a property of the repository, not of the path, so it is
  // scanned once per capture; scanning it per conflicted path repeated the
  // ref scan, the note reads, and the retained-result checks for each one.
  const catalog = listResolutionRecords(cwd);
  const candidatesFor = (signature) =>
    catalog.filter((record) => record.signature === signature).map(compactResolution);
  return paths.map((filePath) => {
    const stages = conflictStages(filePath, cwd);
    const signature = resolutionSignatureFor(stages);
    return {
      path: filePath,
      signature,
      algorithm: RESOLUTION_SIGNATURE_ALGORITHM,
      ...stages,
      candidates: candidatesFor(signature),
      selectedResolutionId: null,
      decisionOverride: null,
    };
  });
}

function stagedResult(filePath, cwd) {
  const entry = indexEntries(cwd, { paths: [filePath] }).find(
    (item) => item.stage === 0,
  );
  return entry ? { resultMode: entry.mode, resultBlob: entry.blob } : {
    resultMode: null,
    resultBlob: null,
  };
}

export function captureResolutionOutcomes(conflicts, cwd = process.cwd()) {
  return conflicts.map((conflict) => {
    const result = stagedResult(conflict.path, cwd);
    const matching = conflict.candidates.find(
      (candidate) => candidate.resultBlob === result.resultBlob,
    );
    const selected = conflict.candidates.find(
      (candidate) => candidate.id === conflict.selectedResolutionId,
    );
    let decision = "created";
    if (conflict.candidates.length) {
      if (conflict.decisionOverride === "rejected") {
        decision = "rejected";
      } else if (selected) {
        decision = selected.resultBlob === result.resultBlob
          ? "accepted"
          : "modified";
      } else {
        decision = matching ? "accepted" : "rejected";
      }
    }
    return {
      path: conflict.path,
      signature: conflict.signature,
      algorithm: conflict.algorithm,
      base: conflict.base,
      ours: conflict.ours,
      theirs: conflict.theirs,
      ...result,
      decision,
      selectionMethod: conflict.selectionMethod ?? null,
      selectedResolutionId: selected?.id ?? null,
      reusedResolutionId: matching?.id ?? null,
    };
  });
}

function resolutionRef(outcome) {
  return `${RESOLUTION_REFS}/${outcome.signature}/${outcome.resultBlob ?? "deleted"}`;
}

function treeForResolution(outcome, cwd) {
  if (!outcome.resultBlob) {
    return runGit(["mktree"], { cwd, input: "" }).stdout;
  }
  const mode = ["100644", "100755"].includes(outcome.resultMode)
    ? outcome.resultMode
    : "100644";
  return runGit(["mktree", "-z"], {
    cwd,
    input: `${mode} blob ${outcome.resultBlob}\tresult\0`,
  }).stdout;
}

export function publishResolution(outcome, application, cwd = process.cwd()) {
  const ref = resolutionRef(outcome);
  if (refExists(ref, cwd)) {
    const existingCommit = resolveRevision(ref, cwd);
    const existing = readNote(existingCommit, cwd).records.find(
      (record) => record.type === "resolution",
    );
    if (existing) return { ...existing, ref, commit: existingCommit };
  }

  const tree = treeForResolution(outcome, cwd);
  const message = [
    `Conflict resolution ${outcome.signature.slice(0, 20)}`,
    "",
    `Resolution-Signature: ${outcome.signature}`,
    `Result-Blob: ${outcome.resultBlob ?? "deleted"}`,
  ].join("\n");
  const commit = runGit(["commit-tree", tree, "-F", "-"], {
    cwd,
    input: `${message}\n`,
  }).stdout;
  runGit(["update-ref", ref, commit], { cwd });
  const record = {
    schema: "vcs-lab.resolution/v1",
    type: "resolution",
    id: newId("resolution"),
    signature: outcome.signature,
    algorithm: outcome.algorithm,
    base: outcome.base,
    ours: outcome.ours,
    theirs: outcome.theirs,
    resultBlob: outcome.resultBlob,
    resultMode: outcome.resultMode,
    originalPath: outcome.path,
    originatingApplication: application.id,
    originatingCommit: application.appliedCommit,
    originatingChangeId: application.appliedChangeId,
    decision: outcome.decision,
    ref,
    resolutionCommit: commit,
    createdAt: new Date().toISOString(),
  };
  appendNote(commit, record, cwd);
  return { ...record, commit };
}

function currentResolutionOperation(cwd) {
  const operation = readPendingOperation(cwd);
  if (!operation?.current?.conflicts?.length) {
    throw new CliError("No reusable conflict resolutions are pending in this worktree.",
      { code: "nothing-pending" });
  }
  return operation;
}

function selectConflicts(operation, filePath, all) {
  if (all) return operation.current.conflicts;
  if (filePath) {
    const match = operation.current.conflicts.find(
      (conflict) => conflict.path === filePath,
    );
    if (!match) throw new CliError(`'${filePath}' is not a current conflict path.`,
      { code: "no-match" });
    return [match];
  }
  if (operation.current.conflicts.length === 1) {
    return [operation.current.conflicts[0]];
  }
  throw new CliError("Choose a conflict path or pass --all.",
    { code: "ambiguous-match" });
}

function chooseCandidate(conflict, resolutionId) {
  if (resolutionId) {
    const match = conflict.candidates.find((candidate) => candidate.id === resolutionId);
    if (!match) {
      throw new CliError(
        `Resolution '${resolutionId}' is not a candidate for '${conflict.path}'.`,
          { code: "no-match" },
      );
    }
    return match;
  }
  if (conflict.candidates.length === 0) {
    throw new CliError(`No prior resolution matches '${conflict.path}'.`,
      { code: "no-match" });
  }
  if (conflict.candidates.length > 1) {
    throw new CliError(
      `Multiple resolutions match '${conflict.path}'.`,
      { code: "ambiguous-match", details: "Choose one with --resolution <id>." },
    );
  }
  return conflict.candidates[0];
}

export function materializeResolutionCandidate(conflict, candidate, cwd) {
  const absolute = path.resolve(cwd, conflict.path);
  if (!candidate.resultBlob) {
    runGit(["rm", "--ignore-unmatch", "--", conflict.path], { cwd });
    return;
  }
  if (!["100644", "100755"].includes(candidate.resultMode)) {
    throw new CliError(
      `Resolution mode '${candidate.resultMode}' is not supported by this prototype.`,
        { code: "unsupported-feature" },
    );
  }
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, readGitBlob(candidate.resultBlob, cwd));
  runGit(["add", "--", conflict.path], { cwd });
  if (candidate.resultMode === "100755") {
    runGit(["update-index", "--chmod=+x", "--", conflict.path], { cwd });
  }
}

export function applyResolution(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const operation = currentResolutionOperation(cwd);
  const selected = selectConflicts(operation, options.path, options.all);
  const choices = selected.map((conflict) => ({
    conflict,
    candidate: chooseCandidate(conflict, options.resolutionId),
  }));
  const applied = [];
  for (const { conflict, candidate } of choices) {
    materializeResolutionCandidate(conflict, candidate, cwd);
    conflict.selectedResolutionId = candidate.id;
    conflict.decisionOverride = null;
    conflict.selectionMethod = "explicit";
    conflict.suggestionAppliedAt = new Date().toISOString();
    applied.push({ path: conflict.path, resolution: candidate });
  }
  writePendingOperation(operation, cwd);
  return { operationId: operation.id, applied };
}

export function rejectResolution(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const operation = currentResolutionOperation(cwd);
  const selected = selectConflicts(operation, options.path, options.all);
  const choices = selected.map((conflict) => ({
    conflict,
    candidate: options.resolutionId
      ? chooseCandidate(conflict, options.resolutionId)
      : null,
  }));
  const rejected = [];
  for (const { conflict, candidate } of choices) {
    if (conflict.candidates.length === 0) {
      throw new CliError(`No prior resolution matches '${conflict.path}'.`,
        { code: "no-match" });
    }
    conflict.decisionOverride = "rejected";
    conflict.selectedResolutionId = candidate?.id ?? null;
    conflict.selectionMethod = "explicit";
    rejected.push({ path: conflict.path, candidates: conflict.candidates.length });
  }
  writePendingOperation(operation, cwd);
  return { operationId: operation.id, rejected };
}

export function pendingResolutionStatus(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const operation = readPendingOperation(cwd);
  return {
    active: Boolean(operation?.current?.conflicts?.length),
    operationId: operation?.id ?? null,
    conflicts: operation?.current?.conflicts ?? [],
  };
}
