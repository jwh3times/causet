import { CliError } from "./errors.js";
import { sha256 } from "./ids.js";

export const NOTE_CONTAINER_SCHEMA = "vcs-lab.note/v1";

/**
 * The closed provenance role vocabulary, duplicated here as a validation
 * authority so `src/schemas.js` does not import a domain module. `src/provenance.js`
 * owns the descriptions; `test/schema-catalog.test.js` keeps the two in step.
 */
export const PROVENANCE_ROLE_NAMES = new Set(["authored", "generated", "reviewed"]);
export const METADATA_STATUS_SCHEMA = "vcs-lab.metadata-status/v1";
export const METADATA_VALIDATION_SCHEMA = "vcs-lab.metadata-validation/v1";
export const METADATA_ENVELOPE_SCHEMA = "vcs-lab.metadata-envelope/v1";
export const METADATA_LINEAGE_ALGORITHM = "git-root-commits-sha256/v1";
export const RESOLUTION_SIGNATURE_ALGORITHM = "ordered-three-way-blobs/v1";

/**
 * The per-family compatibility registry (issue #11 item 4; ADR-0020). This is
 * the runtime authority for what each record family accepts, what it writes,
 * and what a reader does with a version it does not accept.
 * `docs/schemas/compatibility.md` publishes the same rules and
 * `test/schema-compatibility.test.js` fails the suite when the two disagree.
 *
 * - `scope`: persistence scope, as `schemaClassification` reports it.
 * - `registered`: versions carried in the runtime registry, so
 *   `schemaClassification(...).known` is true for them.
 * - `readable`: versions a reader accepts, current and superseded.
 * - `written`: versions a writer emits today.
 * - `unknownVersion`: what a reader does with a version outside `readable`.
 *   `quarantine` reports and skips the record without consuming it and without
 *   failing the command; `refuse` fails the command closed; `ignore` yields no
 *   records and leaves the stored bytes untouched.
 * - `store`: where records of the family live.
 */
export const RECORD_FAMILIES = new Map([
  ["vcs-lab.note", {
    scope: "note-container",
    registered: [1],
    readable: [1],
    written: [1],
    unknownVersion: "ignore",
    store: "refs/notes/vcs-lab note blobs",
  }],
  ["vcs-lab.landing", {
    scope: "note-record",
    registered: [1],
    readable: [1],
    written: [1],
    unknownVersion: "quarantine",
    store: "refs/notes/vcs-lab note containers",
  }],
  ["vcs-lab.application", {
    scope: "note-record",
    registered: [1, 4],
    readable: [1, 4],
    written: [1, 4],
    unknownVersion: "quarantine",
    store: "refs/notes/vcs-lab note containers",
  }],
  ["vcs-lab.reconciliation", {
    scope: "note-record",
    registered: [6],
    readable: [6],
    written: [6],
    unknownVersion: "quarantine",
    store: "refs/notes/vcs-lab note containers",
  }],
  ["vcs-lab.rebase-application", {
    scope: "note-record",
    registered: [1],
    readable: [1],
    written: [1],
    unknownVersion: "quarantine",
    store: "refs/notes/vcs-lab note containers",
  }],
  ["vcs-lab.rebase", {
    scope: "note-record",
    registered: [1],
    readable: [1],
    written: [1],
    unknownVersion: "quarantine",
    store: "refs/notes/vcs-lab note containers",
  }],
  ["vcs-lab.provenance", {
    scope: "note-record",
    registered: [1],
    readable: [1],
    written: [1],
    unknownVersion: "quarantine",
    store: "refs/notes/vcs-lab note containers",
  }],
  ["vcs-lab.resolution", {
    scope: "note-record",
    registered: [1],
    readable: [1],
    written: [1],
    unknownVersion: "quarantine",
    store: "refs/notes/vcs-lab note containers",
  }],
  ["vcs-lab.reconciliation-operation", {
    scope: "private",
    registered: [4],
    readable: [4],
    written: [4],
    unknownVersion: "refuse",
    store: "<git dir>/vcs-lab/reconciliation.json",
  }],
  ["vcs-lab.rebase-operation", {
    scope: "private",
    registered: [1],
    readable: [1],
    written: [1],
    unknownVersion: "refuse",
    store: "<git dir>/vcs-lab/rebase.json",
  }],
  ["vcs-lab.forecast", {
    scope: "private",
    registered: [2],
    readable: [1, 2],
    written: [2],
    unknownVersion: "refuse",
    store: "<git dir>/vcs-lab/forecasts/<id>.json",
  }],
  ["vcs-lab.rebase-forecast", {
    scope: "private",
    registered: [1],
    readable: [1],
    written: [1],
    unknownVersion: "refuse",
    store: "<git dir>/vcs-lab/forecasts/<id>.json",
  }],
  ["vcs-lab.workspaces", {
    scope: "shared-local",
    registered: [1],
    readable: [1],
    written: [1],
    unknownVersion: "refuse",
    store: "<common dir>/vcs-lab/workspaces.json",
  }],
  ["vcs-lab.workspace", {
    scope: "shared-local",
    registered: [1],
    readable: [1],
    written: [1],
    unknownVersion: "refuse",
    store: "entries of <common dir>/vcs-lab/workspaces.json",
  }],
  ["vcs-lab.spec-manifest", {
    scope: "tracked",
    registered: [1, 2, 3],
    readable: [1, 2, 3],
    written: [3],
    unknownVersion: "refuse",
    store: ".vcs-lab/specs/**",
  }],
  ["vcs-lab.metadata-envelope", {
    scope: "envelope",
    registered: [1],
    readable: [1],
    written: [1],
    unknownVersion: "refuse",
    store: "manifest.json of a metadata export directory",
  }],
]);

const KNOWN_SCHEMAS = new Map(
  [...RECORD_FAMILIES].flatMap(([family, policy]) =>
    policy.registered.map((version) => [`${family}/v${version}`, policy.scope]),
  ),
);

/**
 * Frozen resource bounds for reading persisted records (issue #11 item 4;
 * ADR-0020). Every bound fails closed: a shared-portable input over a bound is
 * quarantined without being interpreted, and a worktree-private, shared-local,
 * tracked, or imported input over a bound refuses the command. The bounds are
 * constants, not configuration, so every implementation of the contract agrees.
 * Transport bounds (process buffers, session buffers, session timeouts) are
 * separate and live in `src/git.js`.
 */
export const RESOURCE_BOUNDS = Object.freeze({
  /** Bytes of one refs/notes/vcs-lab note blob that may be parsed. */
  noteContainerBytes: 8 * 1024 * 1024,
  /** Records one note container may carry. */
  noteContainerRecords: 4096,
  /** Bytes of one worktree-private or shared-local JSON state file. */
  localStateBytes: 64 * 1024 * 1024,
  /** Bytes of one tracked specification manifest. */
  specManifestBytes: 8 * 1024 * 1024,
  /** Bytes of the manifest.json of a metadata envelope. */
  envelopeManifestBytes: 16 * 1024 * 1024,
  /** Bytes an envelope may declare for its objects.bundle payload. */
  envelopeBundleBytes: 2 * 1024 * 1024 * 1024,
  /** Records one metadata envelope may declare. */
  envelopeRecords: 1_000_000,
  /**
   * Actors one provenance record may carry. A landing's provenance is the
   * union of every absorbed commit's actors, so this bounds what a long branch
   * can accumulate before the claim stops being reviewable by a person.
   */
  provenanceActors: 64,
  /** Bytes of one `vcs-lab.proof-bundle/v1` document handed to `vlab verify-proof`. */
  proofBundleBytes: 16 * 1024 * 1024,
});

/**
 * True when `actual` is within the named bound. An unknown bound name is a
 * programming error and throws, so a bound cannot be silently skipped.
 */
export function withinBound(name, actual) {
  const limit = RESOURCE_BOUNDS[name];
  if (typeof limit !== "number") {
    throw new TypeError(`Unknown resource bound '${name}'.`);
  }
  return actual <= limit;
}

/**
 * Fail a command closed when a worktree-private, shared-local, tracked, or
 * imported input exceeds a bound. Shared-portable inputs are quarantined
 * instead and must not call this.
 */
export function assertWithinBound(name, actual, subject) {
  if (withinBound(name, actual)) return;
  throw new CliError(
    `${subject} exceeds the ${name} resource bound of ${RESOURCE_BOUNDS[name]}.`,
    {
      code: "resource-bound-exceeded",
      details:
        "vcs-lab refuses to interpret a record larger than its published " +
        "resource bound; see docs/schemas/compatibility.md.",
    },
  );
}

export function schemaClassification(schema) {
  if (typeof schema !== "string" || !schema) {
    return { known: false, family: null, version: null, scope: null };
  }
  const match = schema.match(/^(.+)\/v(\d+)$/);
  return {
    known: KNOWN_SCHEMAS.has(schema),
    family: match?.[1] ?? null,
    version: match ? Number(match[2]) : null,
    scope: KNOWN_SCHEMAS.get(schema) ?? null,
  };
}

/**
 * Resolve one schema identifier against the compatibility registry. `readable`
 * says whether a reader accepts it; `migrated` says whether reading it also
 * migrates it forward to a written version; `disposition` is `accept`,
 * `migrate`, or the family's `unknownVersion` rule. An identifier whose family
 * is not registered has no policy and reports `unknown-family`.
 */
export function schemaCompatibility(schema) {
  const { family, version } = schemaClassification(schema);
  const policy = family ? RECORD_FAMILIES.get(family) : null;
  if (!policy || version === null) {
    return {
      family,
      version,
      policy: null,
      scope: null,
      readable: false,
      migrated: false,
      disposition: "unknown-family",
    };
  }
  const readable = policy.readable.includes(version);
  const migrated = readable && !policy.written.includes(version);
  return {
    family,
    version,
    policy,
    scope: policy.scope,
    readable,
    migrated,
    disposition: readable ? (migrated ? "migrate" : "accept") : policy.unknownVersion,
  };
}

/**
 * Refuse a stored record whose family or version this build does not read.
 * Used by the worktree-private, shared-local, tracked, and envelope readers,
 * whose registry rule is `refuse`; shared-portable readers quarantine instead.
 * `family` additionally pins which family the store may hold, so one store
 * cannot be resumed from another store's record.
 */
export function assertReadableSchema(schema, subject, { family = null, recovery = "" } = {}) {
  const compatibility = schemaCompatibility(schema);
  const quoted = typeof schema === "string" && schema ? JSON.stringify(schema) : "(missing)";
  if (family && compatibility.family !== family) {
    throw new CliError(`${subject} carries schema ${quoted}, not a ${family} record.`, {
      code: "wrong-record-family",
      details: recovery,
    });
  }
  if (compatibility.readable) return compatibility;
  const known = compatibility.policy
    ? `This build reads ${compatibility.policy.readable.map((version) => `v${version}`).join(", ")} of that family.`
    : "This build does not know that record family.";
  throw new CliError(`${subject} carries unsupported schema ${quoted}.`, {
    code: "unknown-schema-version",
    details: [known, recovery].filter(Boolean).join(" "),
  });
}

export function oidLength(objectFormat) {
  return objectFormat === "sha256" ? 64 : 40;
}

export function isOid(value, objectFormat) {
  return (
    typeof value === "string" &&
    new RegExp(`^[0-9a-f]{${oidLength(objectFormat)}}$`, "i").test(value)
  );
}

function fieldError(errors, condition, field, expectation) {
  if (!condition) errors.push({ field, expectation });
}

function validateCommonRecord(record, expectedType, objectFormat, errors) {
  fieldError(errors, record && typeof record === "object" && !Array.isArray(record), "$", "object");
  if (!record || typeof record !== "object" || Array.isArray(record)) return;
  fieldError(errors, typeof record.schema === "string", "schema", "versioned schema string");
  fieldError(errors, record.type === expectedType, "type", expectedType);
  fieldError(errors, typeof record.id === "string" && record.id.length > 3, "id", "non-empty record ID");
  if (record.createdAt !== undefined) {
    fieldError(errors, typeof record.createdAt === "string" && !Number.isNaN(Date.parse(record.createdAt)), "createdAt", "ISO-compatible timestamp");
  }
  if (record.attachedTo !== undefined) {
    fieldError(errors, isOid(record.attachedTo, objectFormat), "attachedTo", `${objectFormat} commit OID`);
  }
}

function requireOid(record, field, objectFormat, errors, nullable = false) {
  const value = record[field];
  fieldError(
    errors,
    (nullable && value === null) || isOid(value, objectFormat),
    field,
    nullable ? `${objectFormat} OID or null` : `${objectFormat} OID`,
  );
}

function requireOidArray(record, field, objectFormat, errors) {
  const value = record[field];
  fieldError(
    errors,
    Array.isArray(value) && value.every((item) => isOid(item, objectFormat)),
    field,
    `array of ${objectFormat} OIDs`,
  );
}

function requireStringArray(record, field, errors) {
  const value = record[field];
  fieldError(
    errors,
    Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0),
    field,
    "array of non-empty strings",
  );
}

function attachmentMatches(record, field, errors) {
  if (record.attachedTo !== undefined && record[field] !== record.attachedTo) {
    errors.push({ field: "attachedTo", expectation: `same OID as ${field}` });
  }
}

export function validateNoteRecord(record, objectFormat = "sha1") {
  const errors = [];
  const schema = record?.schema;
  if (!schemaClassification(schema).known || schemaClassification(schema).scope !== "note-record") {
    return [{ field: "schema", expectation: "supported causal note record schema" }];
  }

  if (schema === "vcs-lab.landing/v1") {
    validateCommonRecord(record, "landing", objectFormat, errors);
    fieldError(errors, ["compact", "hard-squash"].includes(record.mode), "mode", "compact or hard-squash");
    for (const field of ["sourceHead", "targetBefore", "landingCommit", "base", "resultTree"]) {
      requireOid(record, field, objectFormat, errors);
    }
    requireOidArray(record, "absorbedCommits", objectFormat, errors);
    requireStringArray(record, "absorbedChanges", errors);
    attachmentMatches(record, "landingCommit", errors);
  } else if (schema === "vcs-lab.application/v1") {
    validateCommonRecord(record, "application", objectFormat, errors);
    for (const field of ["originCommit", "appliedCommit", "targetBefore"]) {
      requireOid(record, field, objectFormat, errors);
    }
    for (const field of ["originChangeId", "appliedChangeId", "relation"]) {
      fieldError(errors, typeof record[field] === "string" && record[field].length > 0, field, "non-empty string");
    }
    attachmentMatches(record, "appliedCommit", errors);
  } else if (schema === "vcs-lab.application/v4") {
    validateCommonRecord(record, "application", objectFormat, errors);
    for (const field of ["originCommit", "appliedCommit", "targetBefore", "sourceTree", "resultTree"]) {
      requireOid(record, field, objectFormat, errors);
    }
    for (const field of ["originChangeId", "appliedChangeId", "relation"]) {
      fieldError(errors, typeof record[field] === "string" && record[field].length > 0, field, "non-empty string");
    }
    attachmentMatches(record, "appliedCommit", errors);
  } else if (schema === "vcs-lab.reconciliation/v6") {
    validateCommonRecord(record, "reconciliation", objectFormat, errors);
    for (const field of ["sourceHead", "targetBefore", "resultCommit", "targetTreeBefore", "sourceTree", "resultTree"]) {
      requireOid(record, field, objectFormat, errors);
    }
    requireOidArray(record, "absorbedCommits", objectFormat, errors);
    requireStringArray(record, "absorbedChanges", errors);
    fieldError(errors, Array.isArray(record.applied), "applied", "array");
    attachmentMatches(record, "resultCommit", errors);
  } else if (schema === "vcs-lab.provenance/v1") {
    validateCommonRecord(record, "provenance", objectFormat, errors);
    requireOid(record, "commit", objectFormat, errors);
    fieldError(errors, ["declared", "carried"].includes(record.origin), "origin", "declared or carried");
    requireOidArray(record, "carriedFrom", objectFormat, errors);
    fieldError(
      errors,
      record.changeId === null || (typeof record.changeId === "string" && record.changeId.length > 0),
      "changeId",
      "non-empty string or null",
    );
    fieldError(
      errors,
      Array.isArray(record.actors) &&
        record.actors.length > 0 &&
        record.actors.every(
          (actor) =>
            actor && typeof actor === "object" &&
            PROVENANCE_ROLE_NAMES.has(actor.role) &&
            typeof actor.actor === "string" && actor.actor.length > 0,
        ),
      "actors",
      `non-empty array of {role, actor} with role in ${[...PROVENANCE_ROLE_NAMES].join("|")}`,
    );
    // A declared record has no sources; a carried one must name at least one,
    // or it is asserting a rewrite carried a claim from nowhere.
    fieldError(
      errors,
      record.origin === "carried"
        ? Array.isArray(record.carriedFrom) && record.carriedFrom.length > 0
        : Array.isArray(record.carriedFrom) && record.carriedFrom.length === 0,
      "carriedFrom",
      record.origin === "carried" ? "at least one source commit" : "empty for a declared record",
    );
    attachmentMatches(record, "commit", errors);
  } else if (schema === "vcs-lab.rebase-application/v1") {
    validateCommonRecord(record, "rebase-application", objectFormat, errors);
    for (const field of ["originCommit", "appliedCommit", "targetBefore"]) {
      requireOid(record, field, objectFormat, errors);
    }
    for (const field of ["sourceTree", "targetBeforeTree", "resultTree"]) {
      requireOid(record, field, objectFormat, errors);
    }
    for (const field of ["originChangeId", "appliedChangeId", "relation"]) {
      fieldError(errors, typeof record[field] === "string" && record[field].length > 0, field, "non-empty string");
    }
    fieldError(errors, typeof record.rebaseOperation === "string" && record.rebaseOperation.length > 3, "rebaseOperation", "non-empty operation ID");
    fieldError(errors, ["causal-rebase", "contextual-rebase", "contextual-fork"].includes(record.relation), "relation", "supported rebase relation");
    fieldError(errors, Array.isArray(record.conflictedPaths), "conflictedPaths", "array");
    fieldError(errors, Array.isArray(record.resolutions), "resolutions", "array");
    fieldError(errors, Array.isArray(record.semanticMerges), "semanticMerges", "array");
    attachmentMatches(record, "appliedCommit", errors);
  } else if (schema === "vcs-lab.rebase/v1") {
    validateCommonRecord(record, "rebase", objectFormat, errors);
    for (const field of ["sourceHead", "ontoHead", "physicalBase", "resultCommit"]) {
      requireOid(record, field, objectFormat, errors);
    }
    for (const field of ["sourceTree", "ontoTree", "resultTree"]) {
      requireOid(record, field, objectFormat, errors);
    }
    requireOidArray(record, "absorbedCommits", objectFormat, errors);
    requireOidArray(record, "forkedSourceCommits", objectFormat, errors);
    requireStringArray(record, "absorbedChanges", errors);
    fieldError(errors, Array.isArray(record.omitted), "omitted", "array");
    fieldError(errors, Array.isArray(record.acceptedCandidates), "acceptedCandidates", "array");
    fieldError(errors, Array.isArray(record.applications), "applications", "array");
    fieldError(errors, typeof record.planFingerprint === "string" && /^[0-9a-f]{64}$/i.test(record.planFingerprint), "planFingerprint", "SHA-256 value");
    fieldError(errors, record.effectiveBase && typeof record.effectiveBase === "object", "effectiveBase", "base descriptor");
    if (record.effectiveBase && typeof record.effectiveBase === "object") {
      requireOid(record.effectiveBase, "commit", objectFormat, errors);
    }
    for (const [index, application] of (record.applications ?? []).entries()) {
      fieldError(errors, application && typeof application === "object" && !Array.isArray(application), `applications[${index}]`, "object");
      if (!application || typeof application !== "object" || Array.isArray(application)) continue;
      for (const field of ["sourceCommit", "appliedCommit"]) {
        requireOid(application, field, objectFormat, errors);
      }
      for (const field of ["targetBeforeTree", "resultTree"]) {
        requireOid(application, field, objectFormat, errors);
      }
      for (const field of ["sourceChangeId", "appliedChangeId", "relation"]) {
        fieldError(errors, typeof application[field] === "string" && application[field].length > 0, `applications[${index}].${field}`, "non-empty string");
      }
    }
    attachmentMatches(record, "resultCommit", errors);
  } else if (schema === "vcs-lab.resolution/v1") {
    validateCommonRecord(record, "resolution", objectFormat, errors);
    fieldError(errors, record.algorithm === RESOLUTION_SIGNATURE_ALGORITHM, "algorithm", RESOLUTION_SIGNATURE_ALGORITHM);
    fieldError(errors, typeof record.signature === "string" && /^rsig_[0-9a-f]{64}$/i.test(record.signature), "signature", "rsig_ SHA-256 value");
    for (const side of ["base", "ours", "theirs"]) {
      const value = record[side];
      fieldError(errors, value === null || (value && typeof value === "object"), side, "stage object or null");
      if (value) requireOid(value, "blob", objectFormat, errors);
    }
    requireOid(record, "resultBlob", objectFormat, errors, true);
    requireOid(record, "resolutionCommit", objectFormat, errors);
    fieldError(errors, typeof record.ref === "string" && record.ref.startsWith("refs/vcs-lab/resolutions/"), "ref", "resolution retention ref");
    attachmentMatches(record, "resolutionCommit", errors);
  }
  return errors;
}

export function isStructurallyValidNoteRecord(record, objectFormat = "sha1") {
  return validateNoteRecord(record, objectFormat).length === 0;
}

export function referencedObjectsForRecord(record) {
  const objects = [];
  const add = (oid, type, field) => {
    if (typeof oid === "string") objects.push({ oid, type, field });
  };
  if (record.schema === "vcs-lab.landing/v1") {
    for (const field of ["sourceHead", "targetBefore", "landingCommit", "base"]) add(record[field], "commit", field);
    for (const oid of record.absorbedCommits ?? []) add(oid, "commit", "absorbedCommits");
    add(record.resultTree, "tree", "resultTree");
  } else if (record.schema === "vcs-lab.application/v1") {
    for (const field of ["originCommit", "appliedCommit", "targetBefore"]) add(record[field], "commit", field);
  } else if (record.schema === "vcs-lab.application/v4") {
    for (const field of ["originCommit", "appliedCommit", "targetBefore"]) add(record[field], "commit", field);
    for (const field of ["sourceTree", "resultTree"]) add(record[field], "tree", field);
  } else if (record.schema === "vcs-lab.reconciliation/v6") {
    for (const field of ["sourceHead", "targetBefore", "resultCommit"]) add(record[field], "commit", field);
    for (const oid of record.absorbedCommits ?? []) add(oid, "commit", "absorbedCommits");
    for (const field of ["targetTreeBefore", "sourceTree", "resultTree"]) add(record[field], "tree", field);
  } else if (record.schema === "vcs-lab.rebase-application/v1") {
    for (const field of ["originCommit", "appliedCommit", "targetBefore"]) add(record[field], "commit", field);
    for (const field of ["sourceTree", "targetBeforeTree", "resultTree"]) add(record[field], "tree", field);
  } else if (record.schema === "vcs-lab.rebase/v1") {
    for (const field of ["sourceHead", "ontoHead", "physicalBase", "resultCommit"]) add(record[field], "commit", field);
    add(record.effectiveBase?.commit, "commit", "effectiveBase.commit");
    for (const oid of record.absorbedCommits ?? []) add(oid, "commit", "absorbedCommits");
    for (const application of record.applications ?? []) {
      add(application.sourceCommit, "commit", "applications.sourceCommit");
      add(application.appliedCommit, "commit", "applications.appliedCommit");
      add(application.targetBeforeTree, "tree", "applications.targetBeforeTree");
      add(application.resultTree, "tree", "applications.resultTree");
    }
    for (const field of ["sourceTree", "ontoTree", "resultTree"]) add(record[field], "tree", field);
  } else if (record.schema === "vcs-lab.provenance/v1") {
    add(record.commit, "commit", "commit");
    for (const oid of record.carriedFrom ?? []) add(oid, "commit", "carriedFrom");
  } else if (record.schema === "vcs-lab.resolution/v1") {
    add(record.resolutionCommit, "commit", "resolutionCommit");
    for (const field of ["base", "ours", "theirs"]) add(record[field]?.blob, "blob", `${field}.blob`);
    add(record.resultBlob, "blob", "resultBlob");
  }
  return objects;
}

export function resolutionSignatureFor(stages) {
  const canonical = JSON.stringify({
    algorithm: RESOLUTION_SIGNATURE_ALGORITHM,
    base: stages.base ?? null,
    ours: stages.ours ?? null,
    theirs: stages.theirs ?? null,
  });
  return `rsig_${sha256(canonical)}`;
}
