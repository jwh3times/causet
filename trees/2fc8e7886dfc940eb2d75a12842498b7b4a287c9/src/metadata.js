import fs from "node:fs";
import path from "node:path";
import {
  inspectGitObjects,
  listNoteEntries,
  listRefs as scanRefs,
  listTrackedPaths,
  listWorktrees,
  readGitObjects,
  repoContext,
  rootCommits,
} from "./engine.js";
import { sha256 } from "./ids.js";
import { canonicalJson as profileCanonicalJson } from "./canonical-json.js";
import { normalizeMarkdown } from "./specs.js";
import {
  METADATA_LINEAGE_ALGORITHM,
  METADATA_STATUS_SCHEMA,
  METADATA_VALIDATION_SCHEMA,
  NOTE_CONTAINER_SCHEMA,
  RESOURCE_BOUNDS,
  isStructurallyValidNoteRecord,
  referencedObjectsForRecord,
  resolutionSignatureFor,
  schemaClassification,
  validateNoteRecord,
  withinBound,
} from "./schemas.js";

const NOTES_REF = "refs/notes/vcs-lab";
const RESOLUTION_REFS = "refs/vcs-lab/resolutions";
const CHECKPOINT_REFS = "refs/vcs-lab/checkpoints";
const CHECKPOINT_HISTORY_REFS = "refs/vcs-lab/checkpoint-history";

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object" && !Buffer.isBuffer(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalValue(value[key])]),
    );
  }
  return value;
}

/**
 * Legacy sorted-key serializer for record digests, record-equality
 * comparison, and export keys. It accepts whatever JSON.stringify accepts —
 * including the non-integer timing numbers stored in receipts — so the
 * digests that envelopes persist stay byte-stable across releases. New
 * hashed or signed structures must use the frozen profile in
 * ./canonical-json.js instead (docs/canonical-json/README.md).
 */
export function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function countBy(items, field) {
  const counts = {};
  for (const item of items) {
    const key = String(item[field] ?? "(missing)");
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function listRefs(prefix, cwd) {
  // A ref store Git cannot scan is inventoried as empty, as before the seam;
  // the diagnostics below then report what the inventory lacks.
  let entries;
  try {
    entries = scanRefs(prefix, cwd);
  } catch {
    return [];
  }
  return [...entries].sort((left, right) => left.ref.localeCompare(right.ref));
}

/**
 * Peel each retention ref target to a commit with one batched object check,
 * exactly as the resolution catalog does (`<oid>^{commit}`), so a ref that
 * names an annotated tag of its retention commit validates the same way it is
 * listed. A target that does not peel to a commit (a tree, a blob, or a
 * dangling ID) maps to `null` instead of aborting the scan.
 */
function peelResolutionRefs(refs, cwd) {
  if (refs.length === 0) return new Map();
  const objects = inspectGitObjects(refs.map((entry) => `${entry.oid}^{commit}`), cwd);
  return new Map(refs.map((entry, index) => [
    entry.ref,
    objects[index].exists && objects[index].type === "commit" ? objects[index].oid : null,
  ]));
}

function addDiagnostic(diagnostics, code, severity, scope, subject, message, extra = {}) {
  diagnostics.push({ code, severity, scope, subject, message, ...extra });
}

function sortDiagnostics(diagnostics) {
  return diagnostics.sort((left, right) =>
    left.code.localeCompare(right.code) ||
    left.scope.localeCompare(right.scope) ||
    String(left.subject).localeCompare(String(right.subject)) ||
    left.message.localeCompare(right.message),
  );
}

export function repositoryLineage(cwd = process.cwd()) {
  const context = repoContext(cwd);
  const roots = rootCommits(cwd);
  const identity = {
    algorithm: METADATA_LINEAGE_ALGORITHM,
    objectFormat: context.objectFormat,
    rootCommits: roots,
  };
  // The identity is hashed under the frozen canonical JSON profile
  // (vcs-lab.canonical-json/v1); for this float-free shape the bytes are
  // identical to the legacy serializer's, so lineage IDs are unchanged.
  return { ...identity, id: `lineage_${sha256(profileCanonicalJson(identity))}` };
}

export function lineageRelation(source, destination) {
  if (
    source?.algorithm !== METADATA_LINEAGE_ALGORITHM ||
    destination?.algorithm !== METADATA_LINEAGE_ALGORITHM ||
    source.objectFormat !== destination.objectFormat
  ) return "incompatible";
  if (source.id === destination.id) return "same";
  const destinationRoots = new Set(destination.rootCommits ?? []);
  return (source.rootCommits ?? []).some((root) => destinationRoots.has(root))
    ? "fork"
    : "unrelated";
}

function noteEntries(cwd) {
  return [...listNoteEntries(NOTES_REF, cwd)].sort((left, right) =>
    left.target.localeCompare(right.target),
  );
}

function parseNoteObject(object, entry, diagnostics) {
  if (!object?.exists || object.type !== "blob") {
    addDiagnostic(
      diagnostics,
      "missing-note-object",
      "error",
      "shared-portable",
      entry.target,
      `Note object '${entry.note}' is missing or is not a blob.`,
    );
    return null;
  }
  // Notes are shared-portable and untrusted: a note over a published resource
  // bound is quarantined unparsed rather than loaded (ADR-0020).
  if (!withinBound("noteContainerBytes", object.content.length)) {
    addDiagnostic(
      diagnostics,
      "oversize-record",
      "warning",
      "shared-portable",
      entry.target,
      `The attached note exceeds the noteContainerBytes bound of ${RESOURCE_BOUNDS.noteContainerBytes}.`,
    );
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(object.content.toString("utf8"));
  } catch {
    addDiagnostic(
      diagnostics,
      "malformed-record",
      "error",
      "shared-portable",
      entry.target,
      "The attached note is not valid JSON.",
    );
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Array.isArray(parsed.records)) {
    addDiagnostic(
      diagnostics,
      "malformed-record",
      "error",
      "shared-portable",
      entry.target,
      "The attached note is not a versioned record container.",
    );
    return null;
  }
  if (parsed.schema !== NOTE_CONTAINER_SCHEMA) {
    addDiagnostic(
      diagnostics,
      "unknown-schema",
      "warning",
      "shared-portable",
      entry.target,
      `Unsupported note container schema '${parsed.schema ?? "(missing)"}'.`,
      { schema: parsed.schema ?? null },
    );
    return null;
  }
  if (!withinBound("noteContainerRecords", parsed.records.length)) {
    addDiagnostic(
      diagnostics,
      "oversize-record",
      "warning",
      "shared-portable",
      entry.target,
      `The attached note exceeds the noteContainerRecords bound of ${RESOURCE_BOUNDS.noteContainerRecords}.`,
    );
    return null;
  }
  return parsed.records;
}

function objectLookup(expressions, cwd) {
  const unique = [...new Set(expressions.filter(Boolean))].sort();
  const objects = readGitObjects(unique, cwd);
  return new Map(unique.map((expression, index) => [expression, objects[index]]));
}

function validatePortableNotes(context, diagnostics, options) {
  const entries = noteEntries(context.root);
  const noteObjects = objectLookup(entries.map((entry) => entry.note), context.root);
  const targetObjects = options.validateAttachments === false
    ? new Map()
    : objectLookup(entries.map((entry) => entry.target), context.root);
  const rawRecords = [];
  for (const entry of entries) {
    if (options.validateAttachments !== false) {
      const target = targetObjects.get(entry.target);
      if (!target?.exists || target.type !== "commit") {
        addDiagnostic(
          diagnostics,
          "missing-attachment",
          "error",
          "shared-portable",
          entry.target,
          "The note attachment is missing or is not a commit.",
        );
      }
    }
    const records = parseNoteObject(noteObjects.get(entry.note), entry, diagnostics);
    for (const record of records ?? []) {
      rawRecords.push({ record, attachment: entry.target, noteOid: entry.note });
    }
  }

  const structural = rawRecords.map((entry) => {
    const record = { ...entry.record, attachedTo: entry.attachment };
    const classification = schemaClassification(record.schema);
    const errors = validateNoteRecord(record, context.objectFormat);
    if (!classification.known || classification.scope !== "note-record") {
      addDiagnostic(
        diagnostics,
        "unknown-schema",
        "warning",
        "shared-portable",
        record.id ?? entry.attachment,
        `Unsupported causal record schema '${record.schema ?? "(missing)"}'.`,
        { schema: record.schema ?? null, attachment: entry.attachment },
      );
    } else if (errors.length) {
      addDiagnostic(
        diagnostics,
        "malformed-record",
        "error",
        "shared-portable",
        record.id ?? entry.attachment,
        `Record does not match '${record.schema}': ${errors.map((error) => `${error.field} must be ${error.expectation}`).join("; ")}.`,
        { schema: record.schema, attachment: entry.attachment },
      );
    }
    return {
      ...entry,
      rawRecord: entry.record,
      record,
      digest: sha256(canonicalJson({ attachment: entry.attachment, record: entry.record })),
      structurallyValid: classification.known && classification.scope === "note-record" && errors.length === 0,
    };
  });

  const digestsById = new Map();
  for (const entry of structural) {
    if (typeof entry.record.id !== "string") continue;
    const state = digestsById.get(entry.record.id) ?? { count: 0, digests: new Set() };
    state.count += 1;
    state.digests.add(entry.digest);
    digestsById.set(entry.record.id, state);
  }
  const conflictingIds = new Set(
    [...digestsById].filter(([, state]) => state.count > 1).map(([id]) => id),
  );

  const references = structural
    .filter((entry) => entry.structurallyValid)
    .flatMap((entry) => referencedObjectsForRecord(entry.record));
  const referenced = options.validateReferences === false
    ? new Map()
    : objectLookup(references.map((reference) => reference.oid), context.root);
  // `resolutionRefs[].oid` stays the raw ref target (it is reported as
  // `resolutions.refs` and compared raw by envelope export/import); only the
  // record check below uses the peeled commit.
  const resolutionRefs = listRefs(RESOLUTION_REFS, context.root);
  const resolutionRefMap = peelResolutionRefs(resolutionRefs, context.root);
  const resolutionTreeObjects = objectLookup(
    structural
      .filter((entry) => entry.structurallyValid && entry.record.type === "resolution" && entry.record.resultBlob)
      .map((entry) => `${entry.record.resolutionCommit}:result`),
    context.root,
  );
  const accepted = [];
  const summaries = [];
  const diagnosedConflicts = new Set();

  for (const entry of structural) {
    const record = entry.record;
    let valid = entry.structurallyValid;
    const codes = [];
    if (valid && options.validateAttachments !== false) {
      const attachment = targetObjects.get(entry.attachment);
      if (!attachment?.exists || attachment.type !== "commit") valid = false;
    }
    if (valid && options.validateReferences !== false) {
      for (const reference of referencedObjectsForRecord(record)) {
        const object = referenced.get(reference.oid);
        if (!object?.exists || object.type !== reference.type) {
          const code = record.type === "resolution" && reference.field === "resultBlob"
            ? "missing-resolution-blob"
            : "missing-referenced-object";
          addDiagnostic(
            diagnostics,
            code,
            "error",
            "shared-portable",
            record.id,
            `Referenced ${reference.type} '${reference.oid}' from '${reference.field}' is missing or has the wrong type.`,
            { schema: record.schema, attachment: entry.attachment, field: reference.field },
          );
          codes.push(code);
          valid = false;
        }
      }
    }
    if (entry.structurallyValid && record.type === "resolution") {
      if (resolutionSignatureFor(record) !== record.signature) {
        addDiagnostic(
          diagnostics,
          "resolution-signature-mismatch",
          "error",
          "shared-portable",
          record.id,
          "The stored resolution signature does not match its ordered stages.",
          { attachment: entry.attachment },
        );
        codes.push("resolution-signature-mismatch");
        valid = false;
      }
      if (resolutionRefMap.get(record.ref) !== record.resolutionCommit) {
        addDiagnostic(
          diagnostics,
          "missing-resolution-ref",
          "error",
          "shared-portable",
          record.id,
          `Resolution ref '${record.ref}' is missing or points to a different commit.`,
          { attachment: entry.attachment, ref: record.ref },
        );
        codes.push("missing-resolution-ref");
        valid = false;
      }
      if (record.resultBlob) {
        const retained = resolutionTreeObjects.get(`${record.resolutionCommit}:result`);
        if (!retained?.exists || retained.type !== "blob" || retained.oid !== record.resultBlob) {
          addDiagnostic(
            diagnostics,
            "missing-resolution-blob",
            "error",
            "shared-portable",
            record.id,
            "The resolution retention commit does not contain the declared result blob.",
            { attachment: entry.attachment, ref: record.ref },
          );
          codes.push("missing-resolution-blob");
          valid = false;
        }
      }
    }

    const digest = entry.digest;
    if (typeof record.id === "string" && conflictingIds.has(record.id)) {
      if (!diagnosedConflicts.has(record.id)) {
        addDiagnostic(
          diagnostics,
          "record-id-conflict",
          "error",
          "shared-portable",
          record.id,
          "The same record ID names different metadata facts.",
          { attachment: entry.attachment },
        );
        diagnosedConflicts.add(record.id);
      }
      codes.push("record-id-conflict");
      valid = false;
    }

    const summary = {
      attachment: entry.attachment,
      id: record.id ?? null,
      schema: record.schema ?? null,
      type: record.type ?? null,
      digest,
      valid,
      diagnostics: [...new Set(codes)].sort(),
    };
    summaries.push(summary);
    if (valid) {
      accepted.push({
        attachment: entry.attachment,
        noteOid: entry.noteOid,
        record: entry.rawRecord,
        digest,
      });
    }
  }

  const acceptedResolutionRefs = new Set(
    accepted.filter((entry) => entry.record.type === "resolution").map((entry) => entry.record.ref),
  );
  for (const entry of resolutionRefs) {
    if (!acceptedResolutionRefs.has(entry.ref)) {
      addDiagnostic(
        diagnostics,
        "missing-resolution-record",
        "error",
        "shared-portable",
        entry.ref,
        "A resolution retention ref has no accepted resolution record.",
      );
    }
  }

  summaries.sort((left, right) =>
    left.attachment.localeCompare(right.attachment) ||
    String(left.id).localeCompare(String(right.id)) ||
    left.digest.localeCompare(right.digest),
  );
  accepted.sort((left, right) =>
    left.attachment.localeCompare(right.attachment) ||
    String(left.record.id).localeCompare(String(right.record.id)) ||
    left.digest.localeCompare(right.digest),
  );
  return {
    notes: {
      ref: NOTES_REF,
      targetCount: entries.length,
      recordCount: summaries.length,
      acceptedCount: accepted.length,
      quarantinedCount: summaries.length - accepted.length,
      bySchema: countBy(summaries, "schema"),
      byType: countBy(summaries, "type"),
      records: summaries,
    },
    resolutions: {
      namespace: `${RESOLUTION_REFS}/*`,
      refCount: resolutionRefs.length,
      acceptedRefCount: acceptedResolutionRefs.size,
      refs: resolutionRefs,
    },
    accepted,
  };
}

function validateSpecs(context, diagnostics) {
  const files = listTrackedPaths([".vcs-lab/specs"], context.root);
  const manifests = [];
  for (const file of files) {
    const absolute = path.join(context.root, file);
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(absolute, "utf8"));
    } catch {
      addDiagnostic(diagnostics, "malformed-record", "error", "tracked-portable", file, "The tracked specification manifest is not valid JSON.");
      manifests.push({ path: file, schema: null, source: null, consistent: false });
      continue;
    }
    const classification = schemaClassification(manifest?.schema);
    if (!classification.known || classification.scope !== "tracked") {
      addDiagnostic(
        diagnostics,
        "unknown-schema",
        "warning",
        "tracked-portable",
        file,
        `Unsupported specification manifest schema '${manifest?.schema ?? "(missing)"}'.`,
        { schema: manifest?.schema ?? null },
      );
    }
    const source = typeof manifest?.source === "string" ? manifest.source : null;
    const sourceAbsolute = source ? path.join(context.root, ...source.split("/")) : null;
    let consistent = false;
    if (!source || !sourceAbsolute || !fs.existsSync(sourceAbsolute)) {
      addDiagnostic(
        diagnostics,
        "spec-source-missing",
        "error",
        "tracked-portable",
        file,
        `Specification source '${source ?? "(missing)"}' is missing.`,
      );
    } else if (typeof manifest.sourceHash !== "string") {
      addDiagnostic(diagnostics, "malformed-record", "error", "tracked-portable", file, "Specification manifest is missing sourceHash.");
    } else {
      const actual = sha256(normalizeMarkdown(fs.readFileSync(sourceAbsolute, "utf8")));
      consistent = actual === manifest.sourceHash;
      if (!consistent) {
        addDiagnostic(
          diagnostics,
          "spec-manifest-stale",
          "error",
          "tracked-portable",
          file,
          `Specification manifest does not match '${source}'.`,
        );
      }
    }
    manifests.push({
      path: file.replace(/\\/g, "/"),
      schema: manifest?.schema ?? null,
      source,
      artifactId: manifest?.artifactId ?? null,
      entityCount: manifest?.entityCount ?? manifest?.blocks?.length ?? null,
      consistent,
    });
  }
  return {
    manifestCount: manifests.length,
    bySchema: countBy(manifests, "schema"),
    consistentCount: manifests.filter((manifest) => manifest.consistent).length,
    manifests,
  };
}

function validateSharedLocal(context, diagnostics) {
  const runtime = path.join(context.commonDir, "vcs-lab");
  const workspacePath = path.join(runtime, "workspaces.json");
  let registry = { present: false, schema: null, count: 0, workspaces: [] };
  if (fs.existsSync(workspacePath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(workspacePath, "utf8"));
      const workspaces = Array.isArray(parsed?.workspaces) ? parsed.workspaces : [];
      registry = {
        present: true,
        schema: parsed?.schema ?? null,
        count: workspaces.length,
        workspaces: workspaces
          .map((workspace) => ({
            id: workspace?.id ?? null,
            name: workspace?.name ?? null,
            path: workspace?.path ?? null,
            lifecycle: workspace?.lifecycle ?? "active",
            pathExists: typeof workspace?.path === "string" && fs.existsSync(workspace.path),
          }))
          .sort((left, right) => String(left.id).localeCompare(String(right.id))),
      };
      if (parsed?.schema !== "vcs-lab.workspaces/v1" || !Array.isArray(parsed?.workspaces)) {
        addDiagnostic(diagnostics, "malformed-record", "error", "shared-local", workspacePath, "Workspace registry does not match vcs-lab.workspaces/v1.");
      }
      for (const workspace of registry.workspaces) {
        if (!["active", "archived"].includes(workspace.lifecycle)) {
          addDiagnostic(
            diagnostics,
            "workspace-lifecycle-invalid",
            "error",
            "shared-local",
            workspace.id ?? workspace.name ?? workspacePath,
            `Workspace lifecycle '${workspace.lifecycle ?? "(missing)"}' is not supported.`,
          );
        }
        if (workspace.lifecycle !== "archived" && !workspace.pathExists) {
          addDiagnostic(
            diagnostics,
            "workspace-path-missing",
            "warning",
            "shared-local",
            workspace.id ?? workspace.name ?? workspacePath,
            `Workspace path '${workspace.path ?? "(missing)"}' does not exist.`,
          );
        }
        if (workspace.lifecycle === "archived" && workspace.pathExists) {
          addDiagnostic(
            diagnostics,
            "workspace-archived-path-present",
            "warning",
            "shared-local",
            workspace.id ?? workspace.name ?? workspacePath,
            `Archived workspace path '${workspace.path}' still exists; repair or remove the stale materialization.`,
          );
        }
      }
    } catch {
      addDiagnostic(diagnostics, "malformed-record", "error", "shared-local", workspacePath, "Workspace registry is not valid JSON.");
      registry = { present: true, schema: null, count: 0, workspaces: [] };
    }
  }
  const checkpointRefs = listRefs(CHECKPOINT_REFS, context.root);
  const checkpointHistoryRefs = listRefs(
    CHECKPOINT_HISTORY_REFS,
    context.root,
  );
  const allCheckpointRefs = [...checkpointRefs, ...checkpointHistoryRefs];
  const checkpointObjects = objectLookup(
    allCheckpointRefs.map((entry) => entry.oid),
    context.root,
  );
  for (const checkpoint of allCheckpointRefs) {
    const object = checkpointObjects.get(checkpoint.oid);
    if (!object?.exists || object.type !== "commit") {
      addDiagnostic(diagnostics, "missing-referenced-object", "error", "shared-local", checkpoint.ref, "Checkpoint ref does not resolve to a commit.");
    }
  }
  return {
    workspaceRegistry: registry,
    checkpoints: {
      refCount: checkpointRefs.length,
      refs: checkpointRefs,
      historyRefCount: checkpointHistoryRefs.length,
      historyRefs: checkpointHistoryRefs,
      totalRefCount: allCheckpointRefs.length,
    },
  };
}

function parseWorktreePaths(cwd) {
  return [...new Set(
    listWorktrees(cwd).map((worktree) => path.resolve(worktree.path)),
  )].sort();
}

function inspectPrivateState(context, diagnostics) {
  const worktrees = [];
  for (const worktreePath of parseWorktreePaths(context.root)) {
    let gitDir = null;
    if (fs.existsSync(worktreePath)) {
      try {
        gitDir = repoContext(worktreePath).gitDir;
      } catch {
        gitDir = null;
      }
    }
    const operationPaths = gitDir
      ? [
          {
            kind: "reconciliation",
            path: path.join(gitDir, "vcs-lab", "reconciliation.json"),
          },
          {
            kind: "rebase",
            path: path.join(gitDir, "vcs-lab", "rebase.json"),
          },
        ]
      : [];
    const forecastPath = gitDir ? path.join(gitDir, "vcs-lab", "forecasts") : null;
    const pendingOperationKinds = operationPaths
      .filter((entry) => fs.existsSync(entry.path))
      .map((entry) => entry.kind);
    const pendingOperation = pendingOperationKinds.length > 0;
    const forecastCount = forecastPath && fs.existsSync(forecastPath)
      ? fs.readdirSync(forecastPath, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith(".json")).length
      : 0;
    if (pendingOperation) {
      addDiagnostic(
        diagnostics,
        "private-operation-in-progress",
        "warning",
        "worktree-private",
        worktreePath,
        `A worktree-private ${pendingOperationKinds.join(" and ")} operation is in progress and will not be exported.`,
      );
    }
    worktrees.push({
      path: worktreePath,
      available: Boolean(gitDir),
      pendingOperation,
      pendingOperationKinds,
      forecastCount,
    });
  }
  return {
    worktreeCount: worktrees.length,
    pendingOperationCount: worktrees.filter((entry) => entry.pendingOperation).length,
    forecastCount: worktrees.reduce((total, entry) => total + entry.forecastCount, 0),
    worktrees,
  };
}

function publicStatus(snapshot, schema) {
  const diagnostics = sortDiagnostics([...snapshot.diagnostics]);
  const counts = {
    errors: diagnostics.filter((item) => item.severity === "error").length,
    warnings: diagnostics.filter((item) => item.severity === "warning").length,
  };
  return {
    schema,
    repository: snapshot.repository,
    scopes: snapshot.scopes,
    summary: {
      valid: counts.errors === 0,
      ...counts,
      acceptedPortableRecords: snapshot.portableRecords.length,
      quarantinedPortableRecords: snapshot.scopes.sharedPortable.notes.quarantinedCount,
    },
    diagnostics,
    trust: {
      integrityChecked: true,
      cryptographicallyTrusted: false,
      authorized: false,
      statement: "Integrity validation does not establish actor identity, signature trust, or authorization.",
    },
  };
}

export function metadataSnapshot(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const context = repoContext(cwd);
  const diagnostics = [];
  const portable = validatePortableNotes(context, diagnostics, options);
  const trackedPortable = options.portableOnly ? {
    manifestCount: 0,
    bySchema: {},
    consistentCount: 0,
    manifests: [],
  } : validateSpecs(context, diagnostics);
  const sharedLocal = options.portableOnly ? {
    workspaceRegistry: { present: false, schema: null, count: 0, workspaces: [] },
    checkpoints: {
      refCount: 0,
      refs: [],
      historyRefCount: 0,
      historyRefs: [],
      totalRefCount: 0,
    },
  } : validateSharedLocal(context, diagnostics);
  const worktreePrivate = options.portableOnly ? {
    worktreeCount: 0,
    pendingOperationCount: 0,
    forecastCount: 0,
    worktrees: [],
  } : inspectPrivateState(context, diagnostics);
  return {
    repository: {
      root: context.root,
      objectFormat: context.objectFormat,
      lineage: repositoryLineage(context.root),
    },
    scopes: {
      sharedPortable: { notes: portable.notes, resolutions: portable.resolutions },
      trackedPortable,
      sharedLocal,
      worktreePrivate,
    },
    diagnostics,
    portableRecords: portable.accepted,
  };
}

export function metadataStatus(options = {}) {
  return publicStatus(metadataSnapshot(options), METADATA_STATUS_SCHEMA);
}

export function validateMetadata(options = {}) {
  const result = publicStatus(metadataSnapshot(options), METADATA_VALIDATION_SCHEMA);
  result.strict = Boolean(options.strict);
  result.summary.valid = result.summary.errors === 0 && (!result.strict || result.summary.warnings === 0);
  return result;
}

export function acceptedCausalRecords(records, cwd = process.cwd()) {
  const context = repoContext(cwd);
  const structural = records.filter((record) =>
    isStructurallyValidNoteRecord(record, context.objectFormat),
  );
  const references = structural.flatMap(referencedObjectsForRecord);
  const objects = objectLookup(references.map((reference) => reference.oid), cwd);
  return structural.filter((record) =>
    referencedObjectsForRecord(record).every((reference) => {
      const object = objects.get(reference.oid);
      return object?.exists && object.type === reference.type;
    }),
  );
}
