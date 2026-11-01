import fs from "node:fs";
import path from "node:path";
import { beginGitMetrics, endGitMetrics, runGit } from "./git.js";
import {
  readGitObjects,
  readNoteText,
  refExists,
  refTarget,
  repoContext,
  treeId,
} from "./engine.js";
import { sha256 } from "./ids.js";
import {
  canonicalJson,
  lineageRelation,
  metadataSnapshot,
  repositoryLineage,
} from "./metadata.js";
import {
  buildEnvelopeManifest,
  ENVELOPE_BUNDLE,
  readEnvelope,
  writeEnvelopeManifest,
} from "./metadata-envelope.js";
import { referencedObjectsForRecord } from "./schemas.js";
import { CliError } from "./errors.js";
import { withNotesLock } from "./notes.js";
import { buildNoteTree, commitWithParents, buildRetentionCommit, recordDependencies, checkedRefUpdate, RETENTION_REF } from "./git-carriers.js";
import { temporaryDirectory } from "./store.js";

const NOTES_REF = "refs/notes/vcs-lab";
const RESOLUTION_PREFIX = "refs/vcs-lab/resolutions/";
const MAX_COMMIT_PARENTS = 64;

function groupRecords(entries) {
  const grouped = new Map();
  for (const entry of entries) {
    const records = grouped.get(entry.attachment) ?? [];
    records.push(entry.record);
    grouped.set(entry.attachment, records);
  }
  for (const records of grouped.values()) {
    records.sort((left, right) =>
      String(left.createdAt ?? "").localeCompare(String(right.createdAt ?? "")) ||
      String(left.id ?? "").localeCompare(String(right.id ?? "")) ||
      canonicalJson(left).localeCompare(canonicalJson(right)),
    );
  }
  return grouped;
}

function notePath(attachment) {
  return `${attachment.slice(0, 2)}/${attachment.slice(2)}`;
}

function collapseCommitParents(parents, tree, cwd, env, message) {
  let layer = [...new Set(parents)];
  let depth = 0;
  while (layer.length > MAX_COMMIT_PARENTS) {
    const next = [];
    for (let index = 0; index < layer.length; index += MAX_COMMIT_PARENTS) {
      const group = layer.slice(index, index + MAX_COMMIT_PARENTS);
      const parentArgs = group.flatMap((parent) => ["-p", parent]);
      next.push(
        runGit(["commit-tree", tree, ...parentArgs, "-F", "-"], {
          cwd,
          env,
          input: `${message} retention ${depth}:${index / MAX_COMMIT_PARENTS}\n`,
        }).stdout,
      );
    }
    layer = next;
    depth += 1;
  }
  return layer;
}

function buildNotesCommit(entries, cwd, options = {}) {
  if (options.baseRef) {
    let tree = `${options.baseRef}^{tree}`;
    for (const [attachment, records] of groupRecords(entries)) {
      tree = buildNoteTree({ schema: "vcs-lab.note/v1", records }, attachment, tree, cwd);
    }
    return { tree, commit: commitWithParents(tree, options.parents ?? [], cwd, options) };
  }
  const temporary = temporaryDirectory("vlab-metadata-index-");
  const indexPath = path.join(temporary, "index");
  const env = {
    GIT_INDEX_FILE: indexPath,
    ...(options.deterministic ? {
      GIT_AUTHOR_NAME: "vcs-lab metadata envelope",
      GIT_AUTHOR_EMAIL: "metadata-envelope@example.invalid",
      GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
      GIT_COMMITTER_NAME: "vcs-lab metadata envelope",
      GIT_COMMITTER_EMAIL: "metadata-envelope@example.invalid",
      GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
    } : {}),
  };
  try {
    runGit(["read-tree", "--empty"], { cwd, env });
    for (const [attachment, records] of groupRecords(entries)) {
      const body = `${JSON.stringify({ schema: "vcs-lab.note/v1", records }, null, 2)}\n`;
      const blob = runGit(["hash-object", "-w", "--stdin"], {
        cwd,
        env,
        input: body,
      }).stdout;
      runGit(
        ["update-index", "--add", "--cacheinfo", "100644", blob, notePath(attachment)],
        { cwd, env },
      );
    }
    const tree = runGit(["write-tree"], { cwd, env }).stdout;
    const retainedParents = collapseCommitParents(
      options.parents ?? [],
      tree,
      cwd,
      env,
      options.message ?? "vcs-lab metadata envelope",
    );
    const parents = retainedParents.flatMap((parent) => ["-p", parent]);
    const commit = runGit(["commit-tree", tree, ...parents, "-F", "-"], {
      cwd,
      env,
      input: `${options.message ?? "vcs-lab metadata envelope"}\n`,
    }).stdout;
    return { tree, commit };
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function readRecordsFromNoteRef(ref, attachment, cwd) {
  const text = readNoteText(ref, attachment, cwd);
  if (!text) return [];
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CliError(`Cannot merge malformed existing note on '${attachment}'.`,
      { code: "malformed-input" });
  }
  if (parsed?.schema !== "vcs-lab.note/v1" || !Array.isArray(parsed.records)) {
    throw new CliError(`Cannot merge unsupported existing note on '${attachment}'.`,
      { code: "unknown-schema-version" });
  }
  return parsed.records;
}

function combineNoteEntries(existingRef, incomingEntries, cwd) {
  const combined = [];
  for (const [attachment, incoming] of groupRecords(incomingEntries)) {
    const existing = readRecordsFromNoteRef(existingRef, attachment, cwd);
    const byId = new Map();
    for (const record of existing) {
      byId.set(record.id ?? `anonymous:${sha256(canonicalJson(record))}`, record);
    }
    for (const record of incoming) {
      const key = record.id ?? `anonymous:${sha256(canonicalJson(record))}`;
      const prior = byId.get(key);
      if (prior && canonicalJson(prior) !== canonicalJson(record)) {
        throw new CliError(`Metadata record '${record.id ?? key}' conflicts during note merge.`,
          { code: "identity-conflict" });
      }
      if (!prior) byId.set(key, record);
    }
    for (const record of byId.values()) combined.push({ attachment, record });
  }
  return combined;
}

function safeDeleteRef(ref, cwd) {
  if (!refExists(ref, cwd)) return;
  runGit(["update-ref", "-d", ref], { cwd, allowFailure: true });
}

function portableResolutionRefs(snapshot) {
  const accepted = new Set(
    snapshot.portableRecords
      .filter((entry) => entry.record.type === "resolution")
      .map((entry) => entry.record.ref),
  );
  return snapshot.scopes.sharedPortable.resolutions.refs.filter((entry) => accepted.has(entry.ref));
}

export function exportMetadata(envelopePath, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const context = repoContext(cwd);
  const directory = path.resolve(cwd, envelopePath);
  if (fs.existsSync(directory)) {
    throw new CliError(`Metadata export path already exists: '${directory}'.`,
      { code: "already-exists" });
  }
  const metrics = beginGitMetrics("metadata-export");
  const snapshot = metadataSnapshot({ cwd: context.root });
  const exportKey = sha256(canonicalJson({
    lineage: snapshot.repository.lineage,
    records: snapshot.portableRecords.map((entry) => entry.digest),
  })).slice(0, 24);
  const temporaryNoteRef = `refs/vcs-lab/exports/${exportKey}/notes`;
  let createdDirectory = false;
  try {
    fs.mkdirSync(directory);
    createdDirectory = true;
    const refs = [];
    const bundleRefs = [];
    if (snapshot.portableRecords.length) {
      const carrier = buildRetentionCommit(
        recordDependencies(snapshot.portableRecords, context.root, { validate: false }),
        null, context.root, { deterministic: true, message: `vcs-lab metadata objects ${exportKey}` },
      );
      const notes = buildNotesCommit(snapshot.portableRecords, context.root, {
        message: `vcs-lab metadata export ${exportKey}`,
        deterministic: true,
        parents: [carrier],
      });
      runGit(["update-ref", temporaryNoteRef, notes.commit], { cwd: context.root });
      refs.push({ ref: NOTES_REF, bundleRef: temporaryNoteRef, oid: notes.commit });
      bundleRefs.push(temporaryNoteRef);
    }
    for (const entry of portableResolutionRefs(snapshot)) {
      refs.push({ ref: entry.ref, bundleRef: entry.ref, oid: entry.oid });
      bundleRefs.push(entry.ref);
    }

    let payload = null;
    if (bundleRefs.length) {
      const bundlePath = path.join(directory, ENVELOPE_BUNDLE);
      runGit(["bundle", "create", bundlePath, ...bundleRefs], { cwd: context.root });
      const bytes = fs.readFileSync(bundlePath);
      payload = {
        file: ENVELOPE_BUNDLE,
        bytes: bytes.length,
        sha256: sha256(bytes),
      };
    }
    const manifest = buildEnvelopeManifest(snapshot, payload, refs);
    writeEnvelopeManifest(directory, manifest);
    const git = endGitMetrics(metrics);
    return {
      schema: "vcs-lab.metadata-export/v1",
      path: directory,
      manifest: path.join(directory, "manifest.json"),
      payload: payload ? path.join(directory, payload.file) : null,
      records: manifest.records.length,
      refs: manifest.refs.length,
      quarantinedRecords: snapshot.scopes.sharedPortable.notes.quarantinedCount,
      bytes: payload?.bytes ?? 0,
      git,
      trust: manifest.trust,
    };
  } catch (error) {
    endGitMetrics(metrics);
    if (createdDirectory) fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  } finally {
    safeDeleteRef(temporaryNoteRef, context.root);
  }
}

function initInspectionRepository(objectFormat) {
  const parent = temporaryDirectory("vlab-envelope-inspect-");
  const repo = path.join(parent, "repo");
  fs.mkdirSync(repo);
  runGit(["init", "-b", "main", `--object-format=${objectFormat}`], { cwd: repo });
  runGit(["config", "user.name", "vcs-lab metadata inspector"], { cwd: repo });
  runGit(["config", "user.email", "metadata-inspector@example.invalid"], { cwd: repo });
  return { parent, repo };
}

function manifestRecordSummary(entry) {
  return {
    attachment: entry.attachment,
    id: entry.record.id,
    schema: entry.record.schema,
    type: entry.record.type,
    digest: entry.digest,
    ref: entry.record.type === "resolution" ? entry.record.ref : null,
    resultBlob: entry.record.type === "resolution" ? entry.record.resultBlob : null,
  };
}

function inspectEnvelopePayload(envelope) {
  if (!envelope.bundlePath) {
    return { records: [], refs: [], providedObjects: new Set() };
  }
  const temporary = initInspectionRepository(envelope.manifest.repository.objectFormat);
  try {
    const refspecs = envelope.manifest.refs.map((entry) => `${entry.bundleRef}:${entry.ref}`);
    runGit(["fetch", "--no-tags", envelope.bundlePath, ...refspecs], {
      cwd: temporary.repo,
    });
    const snapshot = metadataSnapshot({
      cwd: temporary.repo,
      portableOnly: true,
      validateAttachments: false,
      validateReferences: false,
    });
    const actualRecords = snapshot.portableRecords.map(manifestRecordSummary);
    if (canonicalJson(actualRecords) !== canonicalJson(envelope.manifest.records)) {
      throw new CliError("Metadata envelope record inventory does not match its Git payload.",
        { code: "malformed-input" });
    }
    const payloadObjectProblems = destinationObjectProblems(
      snapshot.portableRecords,
      temporary.repo,
    );
    const unavailableObjects = new Set(
      payloadObjectProblems.map(
        (entry) => `${entry.expectedType}:${entry.oid}`,
      ),
    );
    const refs = envelope.manifest.refs.map((entry) => {
      if (refTarget(entry.ref, temporary.repo) !== entry.oid) {
        throw new CliError(`Metadata envelope ref '${entry.ref}' does not match its manifest.`,
          { code: "malformed-input" });
      }
      return entry;
    });
    return {
      records: snapshot.portableRecords,
      refs,
      providedObjects: new Set(
        requiredObjectClaims(snapshot.portableRecords).map(
          (entry) => `${entry.type}:${entry.oid}`,
        ).filter((key) => !unavailableObjects.has(key)),
      ),
    };
  } finally {
    fs.rmSync(temporary.parent, { recursive: true, force: true });
  }
}

function requiredObjectClaims(records) {
  const required = [];
  for (const entry of records) {
    const record = entry.record;
    if (record.type !== "resolution") {
      required.push({ oid: entry.attachment, type: "commit", record: record.id, field: "attachment" });
    }
    for (const reference of referencedObjectsForRecord(record)) {
      if (
        record.type === "resolution" &&
        ["resolutionCommit", "resultBlob"].includes(reference.field)
      ) continue;
      required.push({ ...reference, record: record.id });
    }
  }
  return required;
}

function destinationObjectProblems(records, cwd, providedObjects = new Set()) {
  const required = requiredObjectClaims(records);
  const unique = [...new Set(required.map((entry) => entry.oid))].sort();
  const objects = readGitObjects(unique, cwd);
  const lookup = new Map(unique.map((oid, index) => [oid, objects[index]]));
  return required
    .filter((entry) => {
      if (providedObjects.has(`${entry.type}:${entry.oid}`)) return false;
      const object = lookup.get(entry.oid);
      return !object?.exists || object.type !== entry.type;
    })
    .map((entry) => ({
      code: "missing-referenced-object",
      record: entry.record,
      field: entry.field,
      oid: entry.oid,
      expectedType: entry.type,
    }));
}

function importPreview(envelope, incoming, cwd) {
  const context = repoContext(cwd);
  if (envelope.manifest.repository.objectFormat !== context.objectFormat) {
    throw new CliError(
      `Envelope object format '${envelope.manifest.repository.objectFormat}' is incompatible with '${context.objectFormat}'.`,
        { code: "unsupported-repository-shape" },
    );
  }
  const destinationLineage = repositoryLineage(cwd);
  const relation = lineageRelation(envelope.manifest.repository.lineage, destinationLineage);
  if (!['same', 'fork'].includes(relation)) {
    throw new CliError(
      `Metadata envelope lineage is ${relation}; v1 import requires a shared root commit.`,
        { code: "unsupported-repository-shape" },
    );
  }
  const destination = metadataSnapshot({ cwd });
  const existingById = new Map(
    destination.portableRecords.map((entry) => [entry.record.id, entry]),
  );
  const records = incoming.records.map((entry) => {
    const existing = existingById.get(entry.record.id);
    return {
      id: entry.record.id,
      schema: entry.record.schema,
      type: entry.record.type,
      attachment: entry.attachment,
      digest: entry.digest,
      action: !existing ? "add" : existing.digest === entry.digest ? "noop" : "conflict",
    };
  });
  const hasRecordAdds = records.some((entry) => entry.action === "add");
  const refs = incoming.refs.map((entry) => {
    const current = refTarget(entry.ref, cwd);
    // Ref targets are compared raw, without peeling: the manifest records the
    // unpeeled object ID of each exported ref, so a retention ref that names
    // an annotated tag of its retention commit round-trips exactly. As a
    // consequence, a destination ref that names the retention commit directly
    // and a source ref that names a tag of that same commit are different
    // targets and are reported as a conflict rather than a noop.
    let action = "create";
    if (entry.ref === NOTES_REF && current !== null) action = hasRecordAdds ? "merge" : "noop";
    else if (current === entry.oid) action = "noop";
    else if (current !== null) action = "conflict";
    return { ref: entry.ref, incoming: entry.oid, existing: current, action };
  });
  const objectProblems = destinationObjectProblems(
    incoming.records,
    cwd,
    incoming.providedObjects,
  );
  const conflicts = records.filter((entry) => entry.action === "conflict").length +
    refs.filter((entry) => entry.action === "conflict").length + objectProblems.length;
  return {
    schema: "vcs-lab.metadata-import-preview/v1",
    path: envelope.directory,
    repository: {
      objectFormat: context.objectFormat,
      lineageRelation: relation,
      sourceLineage: envelope.manifest.repository.lineage.id,
      destinationLineage: destinationLineage.id,
    },
    records,
    refs,
    objectProblems,
    summary: {
      addRecords: records.filter((entry) => entry.action === "add").length,
      noopRecords: records.filter((entry) => entry.action === "noop").length,
      createRefs: refs.filter((entry) => entry.action === "create").length,
      mergeRefs: refs.filter((entry) => entry.action === "merge").length,
      noopRefs: refs.filter((entry) => entry.action === "noop").length,
      conflicts,
      applicable: conflicts === 0,
    },
    exclusions: envelope.manifest.excludedScopes,
    trust: envelope.manifest.trust,
  };
}

function stageEnvelopeRefs(envelope, cwd) {
  const stageId = `${sha256(envelope.manifest.integrity.manifestHash).slice(0, 16)}-${process.pid}`;
  const staged = envelope.manifest.refs.map((entry, index) => ({
    ...entry,
    stageRef: `refs/vcs-lab/import-staging/${stageId}/${String(index).padStart(4, "0")}`,
  }));
  for (const entry of staged) {
    if (refExists(entry.stageRef, cwd)) {
      throw new CliError(`Import staging ref already exists: '${entry.stageRef}'.`,
        { code: "already-exists" });
    }
  }
  runGit(
    ["fetch", "--no-tags", envelope.bundlePath, ...staged.map((entry) => `${entry.bundleRef}:${entry.stageRef}`)],
    { cwd },
  );
  for (const entry of staged) {
    // Compare the raw staged target rather than a peeled commit: the manifest
    // carries the unpeeled object ID, and a retention ref may legitimately
    // name an annotated tag of its retention commit.
    if (refTarget(entry.stageRef, cwd) !== entry.oid) {
      throw new CliError(`Staged metadata ref '${entry.ref}' changed during import.`,
        { code: "stale-input" });
    }
  }
  return staged;
}

function deleteStagedRefs(staged, cwd) {
  for (const entry of staged) safeDeleteRef(entry.stageRef, cwd);
}

function applyImport(envelope, incoming, preview, cwd) {
  if (!preview.summary.applicable) {
    throw new CliError("Metadata import has conflicts; no destination refs were changed.",
      { code: "conflict-blocked" });
  }
  if (!envelope.bundlePath || incoming.refs.length === 0) {
    return { ...preview, schema: "vcs-lab.metadata-import/v1", applied: true, changed: false };
  }
  if (preview.summary.addRecords === 0 && preview.summary.createRefs === 0 && preview.summary.mergeRefs === 0) {
    return { ...preview, schema: "vcs-lab.metadata-import/v1", applied: true, changed: false };
  }
  const staged = stageEnvelopeRefs(envelope, cwd);
  try {
    // The notes ref is read and then replaced in one transaction, under the
    // lock every publisher holds (`withNotesLock`), so a receipt appended
    // between the read and the update is merged rather than dropped.
    withNotesLock(cwd, () => {
      const commands = ["start"];
      const notesStage = staged.find((entry) => entry.ref === NOTES_REF);
      const existingNotes = refTarget(NOTES_REF, cwd);
      const existingRetention = refTarget(RETENTION_REF, cwd);
      if (notesStage) {
        if (existingNotes === null) {
          commands.push(`create ${NOTES_REF} ${notesStage.oid}`);
        } else {
          const combined = combineNoteEntries(NOTES_REF, incoming.records, cwd);
          const existingTree = treeId(NOTES_REF, cwd);
          const merged = buildNotesCommit(combined, cwd, {
            baseRef: NOTES_REF,
            parents: [existingNotes, notesStage.oid],
            message: `Import vcs-lab metadata ${envelope.manifest.integrity.manifestHash.slice(0, 16)}`,
          });
          if (merged.tree !== existingTree) {
            commands.push(`update ${NOTES_REF} ${merged.commit} ${existingNotes}`);
          }
        }
      }
      for (const entry of staged.filter((item) => item.ref.startsWith(RESOLUTION_PREFIX))) {
        const current = refTarget(entry.ref, cwd);
        if (current === null) {
          commands.push(`create ${entry.ref} ${entry.oid}`);
        } else if (current !== entry.oid) {
          throw new CliError(`Resolution ref '${entry.ref}' changed or conflicts during import.`,
            { code: "stale-input" });
        }
      }
      const retained = buildRetentionCommit(recordDependencies(incoming.records, cwd), existingRetention, cwd);
      commands.push(checkedRefUpdate(RETENTION_REF, retained, existingRetention));
      // Even an unchanged notes tree must match the snapshot used for this publication.
      if (!commands.some(command => command.startsWith(`create ${NOTES_REF} `) || command.startsWith(`update ${NOTES_REF} `))) {
        commands.push(`verify ${NOTES_REF} ${existingNotes ?? "0".repeat(repoContext(cwd).objectFormat === "sha256" ? 64 : 40)}`);
      }
      for (const entry of staged) commands.push(`delete ${entry.stageRef} ${entry.oid}`);
      commands.push("prepare", "commit");
      runGit(["update-ref", "--stdin"], { cwd, input: `${commands.join("\n")}\n` });
    });
    return {
      ...preview,
      schema: "vcs-lab.metadata-import/v1",
      applied: true,
      changed: preview.summary.addRecords > 0 || preview.summary.createRefs > 0 || preview.summary.mergeRefs > 0,
    };
  } catch (error) {
    deleteStagedRefs(staged, cwd);
    throw error;
  }
}

export function importMetadata(envelopePath, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  if (Boolean(options.dryRun) === Boolean(options.apply)) {
    throw new CliError("Choose exactly one of --dry-run or --apply for metadata import.",
      { code: "usage-conflicting-options" });
  }
  const metrics = beginGitMetrics("metadata-import");
  try {
    const envelope = readEnvelope(path.resolve(cwd, envelopePath));
    const incoming = inspectEnvelopePayload(envelope);
    const preview = importPreview(envelope, incoming, cwd);
    const result = options.dryRun
      ? preview
      : applyImport(envelope, incoming, preview, cwd);
    result.metrics = {
      payloadBytes: envelope.manifest.payload?.bytes ?? 0,
      git: endGitMetrics(metrics),
    };
    return result;
  } catch (error) {
    endGitMetrics(metrics);
    throw error;
  }
}
