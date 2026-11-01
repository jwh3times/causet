export const ERROR_ENVELOPE_SCHEMA = "vcs-lab.error/v1";

/**
 * The closed error-code vocabulary (ADR-0021, issue #12). A code names *why* a
 * command refused, so a caller can decide what to do without matching English
 * prose. The value is the caller-facing meaning: what the code says happened
 * and what a caller should do about it.
 *
 * **The namespace is flat.** ADR-0021 left this open, to be settled against a
 * real enumeration rather than in advance. The enumeration settles it: codes
 * cluster by *cause* — usage, repository state, Git transport, schema — and a
 * single cause routinely spans several record families. `resource-bound-exceeded`
 * covers notes, envelopes, and manifests alike, so a per-family namespace would
 * split one caller response across several names and still not tell a caller
 * anything the family-carrying `message` does not.
 *
 * Adding a code is an additive change inside `v1`. Removing one, or changing
 * what a code means, is a version bump — the same rule ADR-0020 fixed for
 * record families.
 *
 * A raise site with no code, or with a code outside this map, is a defect:
 * `test/error-envelope.test.js` scans every `new CliError` in `src/` and fails
 * the suite. There is deliberately no `unknown` member to fall back to.
 */
export const ERROR_CODES = Object.freeze({
  // --- The caller invoked the command wrongly ------------------------------
  "usage-missing-argument": "A required argument or flag value was absent. Supply it.",
  "usage-unknown-command": "The command or subcommand does not exist. Check the spelling against --help.",
  "usage-conflicting-options": "Two options that cannot be combined were both given. Choose one.",
  "usage-invalid-option-value": "An option value was outside its accepted set or range. Choose a permitted value.",

  // --- The caller named something that is not there, or already is ---------
  "not-found": "The named forecast, workspace, commit, file, or envelope does not exist. Check the identifier.",
  "already-exists": "The destination path or ref already exists. Choose another, or remove the existing one deliberately.",
  "no-match": "The named item exists but is not a candidate for this operation. List the candidates and choose again.",
  "ambiguous-match": "Several candidates matched and none was selected. Name one explicitly.",
  "nothing-pending": "There is nothing of this kind pending in this worktree. No action is required.",

  // --- The input is not what it claims to be -------------------------------
  "malformed-input": "A document or record could not be parsed, or failed a structural check. Repair or regenerate it.",
  "invalid-identifier": "An identifier does not have the required form. Check it against the published identity profile.",
  "unsafe-input": "An argument contained a character that is not safe to pass to Git. Remove it.",
  "path-outside-repository": "A path escaped the repository root. Give a path inside the repository.",
  "integrity-check-failed": "A declared hash did not match the bytes it covers. The artifact was altered or truncated.",

  // --- Compatibility: the ADR-0020 contractual refusals --------------------
  "unknown-schema-version": "A record's schema version is outside what this build reads. Read it with the build that wrote it.",
  "wrong-record-family": "A store held a record of a different family than expected. Stop and surface this to a human.",
  "resource-bound-exceeded": "An input exceeded a published resource bound. Reduce the input, or raise the bound deliberately.",

  // --- The repository or operation is not in the required state ------------
  "dirty-worktree": "The worktree has uncommitted changes and this operation requires a clean one.",
  "precondition-not-met": "A stated precondition does not hold yet. The message names the step that establishes it.",
  "operation-in-progress": "A VCS Lab operation journal is present in an affected worktree. Finish or abort it first.",
  "notes-locked": "Another vcs-lab process holds the causal notes lock. Wait for it to finish and retry; remove the lock file only if that process is gone.",
  "workspace-registry-locked": "The workspace registry lock could not be acquired. Retry after the holder finishes; recover an abandoned lock only with all workspace writers stopped on every host sharing the repository.",
  "no-operation-pending": "No VCS Lab operation is pending, so there is nothing to continue or abort.",
  "operation-state-invalid": "The pending operation is in a state this command cannot act on. The message names the state.",
  "git-operation-active": "Git itself has a replay or sequencer operation in progress. Resolve it before continuing.",
  "out-of-band-change": "Git's state and the VCS Lab journal disagree, because Git was driven directly. Abort and restart the operation.",
  "repository-mismatch": "The named path or object belongs to a different repository or workspace than the one in use.",

  // --- Staleness: pinned inputs moved --------------------------------------
  "stale-forecast": "A forecast no longer matches the repository it was pinned to. Regenerate and re-approve it.",
  "stale-input": "An input changed while the operation was running. Retry from a quiet repository.",
  "stale-manifest": "A specification manifest no longer matches the Markdown it describes. Re-index it with vlab spec index, then stage or commit the result.",

  // --- Conflicts and decisions that need a person --------------------------
  "conflict-paused": "The operation paused on a conflict and is resumable. Resolve the paths, then continue.",
  "conflict-blocked": "Git could not apply or continue the change. The details carry Git's own output.",
  "approval-required": "The plan contains heuristic candidates that must be accepted explicitly before proceeding.",
  "manual-review-required": "A semantic merge could not be decided conservatively and needs a human.",

  // --- Identity ------------------------------------------------------------
  "identity-not-preserved": "A rewrite did not carry the logical identity it was required to preserve (FR-ID-02).",
  "identity-conflict": "Two records claim the same identifier with different content. Resolve the conflict before importing.",

  // --- Git subprocess and transport ----------------------------------------
  "git-unavailable": "Git could not be started at all. Check that it is installed and on PATH.",
  "git-command-failed": "A Git command exited non-zero. The details carry its output.",
  "revision-not-resolved": "A revision or object did not resolve to the expected type. Check the reference.",
  "git-response-malformed": "Git returned output this build could not parse. Report it with the Git version.",
  "session-unavailable": "A batched Git session is closed, timed out, or failed. The command falls back to ordinary Git where it can.",

  // --- Not implemented -----------------------------------------------------
  "unsupported-feature": "The prototype does not implement this case. The message names the supported set.",
  "unsupported-repository-shape": "The repository's history or object format is outside what this operation supports.",

  // --- Defects -------------------------------------------------------------
  "internal-invariant": "An internal invariant did not hold. This is a defect; report it.",
});

export class CliError extends Error {
  constructor(message, { details = "", exitCode = 1, code = null } = {}) {
    super(message);
    this.name = "CliError";
    this.details = details;
    this.exitCode = exitCode;
    // A code outside the vocabulary is a defect at the raise site, not a
    // runtime condition, so it fails loudly rather than being carried into
    // output a caller might branch on.
    if (code !== null && !Object.hasOwn(ERROR_CODES, code)) {
      throw new TypeError(`'${code}' is not a published vcs-lab error code.`);
    }
    this.code = code;
  }
}

/**
 * Whether this invocation asked for JSON. Set once the dispatched command's
 * options are known, which is why pre-dispatch failures — an unknown command,
 * a malformed global flag — keep prose on stderr: `--json` is parsed per
 * command, so at that point there is no request to honor (ADR-0021).
 */
let jsonRequested = false;

export function requestJsonErrors(on) {
  jsonRequested = Boolean(on);
}

export function jsonErrorsRequested() {
  return jsonRequested;
}

/**
 * The failure envelope. Carries the classification, never repository content:
 * `message` and `details` are already what the human path prints, and no code
 * adds file contents or commit messages to them (NFR-SEC-02).
 */
export function errorEnvelope(error) {
  return {
    schema: ERROR_ENVELOPE_SCHEMA,
    code: error?.code ?? null,
    message: error?.message ?? String(error),
    details: error?.details ?? "",
    exitCode: error?.exitCode ?? 1,
  };
}
