import { runGit } from "./git.js";
import { refExists, repoContext } from "./engine.js";
import { CliError } from "./errors.js";
import { newId } from "./ids.js";
import { metadataSnapshot } from "./metadata.js";
import { replaceNoteRecord } from "./notes.js";
import {
  appendDisposition,
  DISPOSITION_SCHEMA,
  readParkedRecord,
} from "./quarantine.js";

/**
 * Resolve one parked conflict with a declared local decision (ADR-0030).
 *
 * `keep-local` deletes the parked copy and returns the local record to service.
 * `replace-local` rewrites the local record to the parked content under the
 * notes lock and returns that to service instead. Either way the decision is
 * itself recorded, with the digest kept and the digests rejected, so the same
 * disagreement arriving again is reported as already disposed rather than
 * parked a second time.
 *
 * The registry is local on purpose: two clones may dispose the same conflict
 * differently, and that disagreement is real rather than something to hide.
 */
export function disposeConflict(recordId, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const outcome = options.outcome;
  if (!["keep-local", "replace-local"].includes(outcome)) {
    throw new CliError("Choose exactly one of --keep-local or --replace-local.",
      { code: "usage-conflicting-options" });
  }
  const context = repoContext(cwd);
  const parked = readParkedRecord(recordId, context.root);
  const local = localCopies(recordId, context.root);
  if (local.length === 0) {
    throw new CliError(
      `No local record '${recordId}' disputes the parked copy at '${parked.ref}'.`,
      {
        code: "not-found",
        details:
          "Nothing local claims this identifier any more, so there is no conflict to " +
          `dispose of. Remove the parked copy with: git update-ref -d ${parked.ref}`,
      },
    );
  }
  if (local.length > 1) {
    throw new CliError(
      `Record '${recordId}' names ${local.length} different local facts; resolve that duplication first.`,
      {
        code: "identity-conflict",
        details:
          "A disposition replaces or keeps one local record. Repair the duplicated " +
          "identifier in the notes tree, then dispose of the parked copy.",
      },
    );
  }
  const [copy] = local;
  if (outcome === "replace-local" && copy.attachment !== parked.payload.attachment) {
    throw new CliError(
      `The parked copy of '${recordId}' is attached to ${parked.payload.attachment}, but the local copy is attached to ${copy.attachment}.`,
      {
        code: "identity-conflict",
        details:
          "Replacing the local record would move a fact to another commit. Inspect " +
          `both with: git cat-file -p ${parked.ref}`,
      },
    );
  }

  const entry = {
    schema: DISPOSITION_SCHEMA,
    id: newId("disposition"),
    recordId,
    outcome,
    sourceLineage: parked.sourceLineage,
    parkedRef: parked.ref,
    attachment: copy.attachment,
    keptDigest: outcome === "keep-local" ? copy.digest : parked.payload.digest,
    rejectedDigests: [outcome === "keep-local" ? parked.payload.digest : copy.digest],
    reason: options.reason ?? null,
    decidedAt: new Date().toISOString(),
  };

  // The dispute is cleared before the decision is filed, deliberately. An
  // interruption in that window leaves the conflict gone and unrecorded, so the
  // next exchange parks it again and a person decides again — recoverable. The
  // other order would leave a decided conflict still parked, which keeps a fact
  // out of service with nothing to show why. `replace-local` clears the ref
  // inside the note rewrite's own transaction, so the record and the dispute
  // move together or not at all.
  if (outcome === "replace-local") {
    replaceNoteRecord(copy.attachment, recordId, parked.payload.record, context.root, {
      refUpdates: [`delete ${parked.ref} ${parked.oid}`],
    });
  } else {
    runGit(["update-ref", "-d", parked.ref, parked.oid], { cwd: context.root });
  }
  appendDisposition(entry, context.root);

  // Read the record back rather than asserting it returned to service. Removing
  // the dispute is necessary and not sufficient: the surviving copy can still be
  // quarantined for a reason that has nothing to do with this conflict, such as
  // a referenced object that is no longer present.
  const after = metadataSnapshot({ cwd: context.root })
    .scopes.sharedPortable.notes.records.find((record) => record.id === recordId);
  return {
    schema: "vcs-lab.metadata-disposition/v1",
    disposition: entry,
    parkedRef: parked.ref,
    parkedRemoved: !refExists(parked.ref, context.root),
    record: {
      id: recordId,
      schema: after?.schema ?? parked.payload.record?.schema ?? null,
      type: after?.type ?? parked.payload.record?.type ?? null,
      attachment: after?.attachment ?? copy.attachment,
      inService: Boolean(after?.valid),
      diagnostics: after?.diagnostics ?? [],
    },
  };
}

/**
 * Every local note record carrying `recordId`, with the digest the snapshot
 * computes for it. Read through the snapshot rather than the notes directly, so
 * a disposition sees the same records `vlab metadata status` reported.
 */
function localCopies(recordId, cwd) {
  return metadataSnapshot({ cwd }).scopes.sharedPortable.notes.records
    .filter((record) => record.id === recordId)
    .map((record) => ({ attachment: record.attachment, digest: record.digest }));
}
