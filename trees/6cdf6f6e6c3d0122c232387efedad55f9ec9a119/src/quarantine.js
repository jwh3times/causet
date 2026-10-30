import path from "node:path";
import { runGit } from "./git.js";
import { listRefs, readGitObjects, refExists, repoContext } from "./engine.js";
import { CliError } from "./errors.js";
import { ensureLabRuntime, labRuntimeDir, readJson, writeJson } from "./store.js";
import { assertReadableSchema, RESOURCE_BOUNDS, withinBound } from "./schemas.js";

export const QUARANTINE_REFS = "refs/vcs-lab/quarantine";
export const PARKED_RECORD_SCHEMA = "vcs-lab.quarantined-record/v1";
export const DISPOSITIONS_SCHEMA = "vcs-lab.dispositions/v1";
export const DISPOSITION_SCHEMA = "vcs-lab.disposition/v1";

/**
 * The conflict policy's two local stores (ADR-0030).
 *
 * **Parked records** live one per ref under `refs/vcs-lab/quarantine/<source
 * lineage>/<record id>`, each ref naming a blob that holds the incoming record
 * verbatim together with where it came from. A ref per record, rather than one
 * index file, is what makes the store inspectable with ordinary Git
 * (`git cat-file -p <ref>`), keeps each parked blob reachable so it survives
 * `git gc`, and lets one disposition delete exactly one dispute. The namespace
 * is outside `refs/notes/` and outside `refs/heads/`, so nothing fetches or
 * pushes it: a dispute is local, and so is its record.
 *
 * **Dispositions** live in one shared-local registry beside the workspace
 * registry, because a disposition is a statement about this clone and must not
 * travel — two clones may legitimately dispose the same conflict differently.
 *
 * The identifiers of what is parked are readable from the ref names alone, so
 * the read path every planner takes (`parkedRecordIds`) costs one
 * `for-each-ref` and no object reads. Only the inventory and the disposition
 * commands pay for the blobs.
 */

function quarantineRefPrefix(sourceLineage) {
  return `${QUARANTINE_REFS}/${sourceLineage}`;
}

export function parkedRecordRef(sourceLineage, recordId) {
  assertRefComponent(sourceLineage, "source lineage");
  assertRefComponent(recordId, "record identifier");
  return `${quarantineRefPrefix(sourceLineage)}/${recordId}`;
}

/**
 * Refuse a value that cannot be one path component of a ref name. The parked
 * namespace is addressed by lineage and record identifier, both of which come
 * from a peer's envelope, so neither may introduce a slash, a `..`, or any of
 * the characters `git check-ref-format` rejects.
 */
function assertRefComponent(value, subject) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]+$/.test(value) || value.includes("..") || value.endsWith(".lock")) {
    throw new CliError(
      `Cannot park a record: the ${subject} ${JSON.stringify(value ?? null)} is not a single ref name component.`,
      { code: "malformed-input" },
    );
  }
}

/** `{ sourceLineage, recordId }` of a parked ref, or null when it is not one. */
export function parsedParkedRef(ref) {
  const rest = typeof ref === "string" && ref.startsWith(`${QUARANTINE_REFS}/`)
    ? ref.slice(QUARANTINE_REFS.length + 1)
    : null;
  const parts = rest?.split("/") ?? [];
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return { sourceLineage: parts[0], recordId: parts[1] };
}

/**
 * The record identifiers this repository holds a parked dispute about. A
 * conflicted fact contributes nothing on either side, so these identifiers
 * quarantine the local copy too, until a person disposes of the dispute.
 */
export function parkedRecordIds(cwd = process.cwd()) {
  const ids = new Set();
  for (const entry of listRefs(`${QUARANTINE_REFS}/*/*`, cwd)) {
    const parsed = parsedParkedRef(entry.ref);
    if (parsed) ids.add(parsed.recordId);
  }
  return ids;
}

/**
 * Every parked record, with its payload. A payload this build cannot read is
 * returned with `readable: false` and its reason rather than throwing, so the
 * inventory stays a report over everything present; a command that must
 * interpret one refuses instead (`readParkedRecord`).
 */
export function listParkedRecords(cwd = process.cwd()) {
  const context = repoContext(cwd);
  const refs = listRefs(`${QUARANTINE_REFS}/*/*`, context.root)
    .filter((entry) => parsedParkedRef(entry.ref))
    .sort((left, right) => left.ref.localeCompare(right.ref));
  if (refs.length === 0) return [];
  const objects = readGitObjects(refs.map((entry) => entry.oid), context.root);
  return refs.map((entry, index) => {
    const { sourceLineage, recordId } = parsedParkedRef(entry.ref);
    const base = { ref: entry.ref, oid: entry.oid, sourceLineage, recordId };
    const object = objects[index];
    if (!object?.exists || object.type !== "blob") {
      return { ...base, readable: false, reason: "missing-parked-blob", payload: null };
    }
    if (!withinBound("noteContainerBytes", object.content.length)) {
      return { ...base, readable: false, reason: "oversize-record", payload: null };
    }
    let payload;
    try {
      payload = JSON.parse(object.content.toString("utf8"));
    } catch {
      return { ...base, readable: false, reason: "malformed-record", payload: null };
    }
    if (payload?.schema !== PARKED_RECORD_SCHEMA) {
      return { ...base, readable: false, reason: "unknown-schema-version", payload: null };
    }
    return { ...base, readable: true, reason: null, payload };
  });
}

/**
 * One parked record, refused when this build cannot read its payload. Used by
 * the disposition commands, which have to interpret the parked content.
 */
export function readParkedRecord(recordId, cwd = process.cwd()) {
  const matches = listParkedRecords(cwd).filter((entry) => entry.recordId === recordId);
  if (matches.length === 0) {
    throw new CliError(`No parked record '${recordId}' is in quarantine.`, {
      code: "not-found",
      details: `List what is parked with: vlab metadata status --json`,
    });
  }
  if (matches.length > 1) {
    throw new CliError(
      `Record '${recordId}' is disputed by ${matches.length} parked copies; name the source lineage.`,
      {
        code: "ambiguous-match",
        details: matches.map((entry) => entry.ref).join("\n"),
      },
    );
  }
  const [entry] = matches;
  // An unreadable payload is refused with the code its reason names, so a
  // caller can tell "a version this build does not read" from "bytes that are
  // not a record at all". The schema gate below is the ADR-0020 refusal for a
  // version inside the family.
  if (entry.reason === "unknown-schema-version") {
    throw new CliError(
      `The parked record at '${entry.ref}' carries a schema this build does not read.`,
      {
        code: "unknown-schema-version",
        details: `Inspect it with: git cat-file -p ${entry.ref}`,
      },
    );
  }
  if (!entry.readable) {
    throw new CliError(
      `The parked record at '${entry.ref}' is not readable: ${entry.reason}.`,
      {
        code: "malformed-input",
        details: `Inspect it with: git cat-file -p ${entry.ref}`,
      },
    );
  }
  assertReadableSchema(entry.payload.schema, `The parked record at '${entry.ref}'`, {
    family: "vcs-lab.quarantined-record",
    recovery: "Read it with the vcs-lab build that parked it.",
  });
  return entry;
}

/** The payload a parked ref names: the incoming record and its provenance. */
export function buildParkedPayload({ record, digest, attachment, sourceLineage, envelopeHash, localDigests }) {
  return {
    schema: PARKED_RECORD_SCHEMA,
    recordId: record.id,
    digest,
    attachment,
    sourceLineage,
    envelopeHash,
    disputedLocalDigests: localDigests ?? null,
    parkedAt: new Date().toISOString(),
    record,
  };
}

/**
 * Write one parked payload as a blob and return the ref update that publishes
 * it. The blob is written before the transaction and the ref inside it, so
 * parking joins the same atomic `update-ref` batch that applies the
 * non-conflicting records: either the whole exchange lands or none of it does.
 */
export function stageParkedRecord(payload, cwd) {
  const ref = parkedRecordRef(payload.sourceLineage, payload.recordId);
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  if (!withinBound("noteContainerBytes", Buffer.byteLength(body))) {
    throw new CliError(
      `Parking record '${payload.recordId}' would exceed the noteContainerBytes bound of ${RESOURCE_BOUNDS.noteContainerBytes}.`,
      { code: "resource-bound-exceeded" },
    );
  }
  const oid = runGit(["hash-object", "-w", "--stdin"], { cwd, input: body }).stdout;
  return { ref, oid, existed: refExists(ref, cwd) };
}

// ---------------------------------------------------------------------------
// Dispositions
// ---------------------------------------------------------------------------

/**
 * Reading the registry must not create anything: `metadataSnapshot` reports it,
 * and a `vlab metadata status` that made a directory in a repository it was only
 * asked to inspect would be a mutation nobody asked for. Only `saveDispositions`
 * creates the runtime directory.
 */
function dispositionsFile(cwd) {
  return path.join(labRuntimeDir(cwd), "dispositions.json");
}

/**
 * Read the shared-local disposition registry. Like the workspace registry it
 * is refused rather than used when this build does not read its version: every
 * mutation rewrites the whole file, so consuming a version we do not
 * understand would silently drop decisions a person made.
 */
export function readDispositions(cwd = process.cwd()) {
  const registryPath = dispositionsFile(cwd);
  const registry = readJson(registryPath, {
    schema: DISPOSITIONS_SCHEMA,
    dispositions: [],
  });
  assertReadableSchema(registry?.schema, `The disposition registry at '${registryPath}'`, {
    family: "vcs-lab.dispositions",
    recovery: "Read it with the vcs-lab build that wrote it.",
  });
  if (!Array.isArray(registry.dispositions)) {
    throw new CliError(`The disposition registry at '${registryPath}' has no disposition list.`,
      { code: "malformed-input" });
  }
  for (const entry of registry.dispositions) {
    assertReadableSchema(entry?.schema, `A disposition entry in '${registryPath}'`, {
      family: "vcs-lab.disposition",
      recovery: "Read it with the vcs-lab build that wrote it.",
    });
  }
  return registry;
}

export function saveDispositions(registry, cwd = process.cwd()) {
  ensureLabRuntime(cwd);
  writeJson(dispositionsFile(cwd), registry);
  return registry;
}

/**
 * The digests a person has already rejected, by record identifier. An arriving
 * record whose digest is listed is reported as already disposed rather than
 * parked again, which is the whole reason the registry exists: the same
 * disagreement is reported once, not on every exchange.
 */
export function rejectedDigests(cwd = process.cwd()) {
  const byRecord = new Map();
  for (const entry of readDispositions(cwd).dispositions) {
    const digests = byRecord.get(entry.recordId) ?? new Set();
    for (const digest of entry.rejectedDigests ?? []) digests.add(digest);
    byRecord.set(entry.recordId, digests);
  }
  return byRecord;
}

export function appendDisposition(entry, cwd = process.cwd()) {
  const registry = readDispositions(cwd);
  return saveDispositions(
    { ...registry, dispositions: [...registry.dispositions, entry] },
    cwd,
  ).dispositions.at(-1);
}
