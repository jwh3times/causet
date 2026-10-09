//! The record-family and resource-bound registries of `src/schemas.js` and the
//! error vocabulary of `src/errors.js`. The JavaScript modules stay the
//! authority; `test/rust-model.test.js` fails when these tables and theirs differ.

pub struct Family {
  pub name: &'static str,
  pub scope: &'static str,
  pub registered: &'static [u32],
  pub readable: &'static [u32],
  pub written: &'static [u32],
  pub unknown_version: &'static str,
  pub store: &'static str,
}

pub const RECORD_FAMILIES: &[Family] = &[
  Family {
    name: "causet.note",
    scope: "note-container",
    registered: &[1],
    readable: &[1],
    written: &[1],
    unknown_version: "ignore",
    store: "refs/notes/causet note blobs",
  },
  Family {
    name: "causet.landing",
    scope: "note-record",
    registered: &[1],
    readable: &[1],
    written: &[1],
    unknown_version: "quarantine",
    store: "refs/notes/causet note containers",
  },
  Family {
    name: "causet.application",
    scope: "note-record",
    registered: &[1, 4],
    readable: &[1, 4],
    written: &[1, 4],
    unknown_version: "quarantine",
    store: "refs/notes/causet note containers",
  },
  Family {
    name: "causet.reconciliation",
    scope: "note-record",
    registered: &[6],
    readable: &[6],
    written: &[6],
    unknown_version: "quarantine",
    store: "refs/notes/causet note containers",
  },
  Family {
    name: "causet.rebase-application",
    scope: "note-record",
    registered: &[1],
    readable: &[1],
    written: &[1],
    unknown_version: "quarantine",
    store: "refs/notes/causet note containers",
  },
  Family {
    name: "causet.rebase",
    scope: "note-record",
    registered: &[1, 2, 3],
    readable: &[1, 2, 3],
    written: &[3],
    unknown_version: "quarantine",
    store: "refs/notes/causet note containers",
  },
  Family {
    name: "causet.amendment",
    scope: "note-record",
    registered: &[1],
    readable: &[1],
    written: &[1],
    unknown_version: "quarantine",
    store: "refs/notes/causet note containers",
  },
  Family {
    name: "causet.interactive-absorption",
    scope: "note-record",
    registered: &[1],
    readable: &[1],
    written: &[1],
    unknown_version: "quarantine",
    store: "refs/notes/causet note containers",
  },
  Family {
    name: "causet.provenance",
    scope: "note-record",
    registered: &[1],
    readable: &[1],
    written: &[1],
    unknown_version: "quarantine",
    store: "refs/notes/causet note containers",
  },
  Family {
    name: "causet.resolution",
    scope: "note-record",
    registered: &[1],
    readable: &[1],
    written: &[1],
    unknown_version: "quarantine",
    store: "refs/notes/causet note containers",
  },
  Family {
    name: "causet.reconciliation-operation",
    scope: "private",
    registered: &[4],
    readable: &[4],
    written: &[4],
    unknown_version: "refuse",
    store: "<git dir>/causet/reconciliation.json",
  },
  Family {
    name: "causet.rebase-operation",
    scope: "private",
    registered: &[1, 2, 3],
    readable: &[3],
    written: &[3],
    unknown_version: "refuse",
    store: "<git dir>/causet/rebase.json",
  },
  Family {
    name: "causet.forecast",
    scope: "private",
    registered: &[2],
    readable: &[1, 2],
    written: &[2],
    unknown_version: "refuse",
    store: "<git dir>/causet/forecasts/<id>.json",
  },
  Family {
    name: "causet.rebase-forecast",
    scope: "private",
    registered: &[1, 2, 3],
    readable: &[3],
    written: &[3],
    unknown_version: "refuse",
    store: "<git dir>/causet/forecasts/<id>.json",
  },
  Family {
    name: "causet.workspaces",
    scope: "shared-local",
    registered: &[1],
    readable: &[1],
    written: &[1],
    unknown_version: "refuse",
    store: "<common dir>/causet/workspaces.json",
  },
  Family {
    name: "causet.workspace",
    scope: "shared-local",
    registered: &[1],
    readable: &[1],
    written: &[1],
    unknown_version: "refuse",
    store: "entries of <common dir>/causet/workspaces.json",
  },
  Family {
    name: "causet.quarantined-record",
    scope: "shared-local",
    registered: &[1],
    readable: &[1],
    written: &[1],
    unknown_version: "refuse",
    store: "refs/causet/quarantine/<lineage>/<record id> blobs",
  },
  Family {
    name: "causet.dispositions",
    scope: "shared-local",
    registered: &[1],
    readable: &[1],
    written: &[1],
    unknown_version: "refuse",
    store: "<common dir>/causet/dispositions.json",
  },
  Family {
    name: "causet.disposition",
    scope: "shared-local",
    registered: &[1],
    readable: &[1],
    written: &[1],
    unknown_version: "refuse",
    store: "entries of <common dir>/causet/dispositions.json",
  },
  Family {
    name: "causet.migration",
    scope: "shared-local",
    registered: &[1],
    readable: &[1],
    written: &[1],
    unknown_version: "refuse",
    store: "<common dir>/causet/migration.json",
  },
  Family {
    name: "causet.spec-manifest",
    scope: "tracked",
    registered: &[1, 2, 3, 4],
    readable: &[1, 2, 3, 4],
    written: &[4],
    unknown_version: "refuse",
    store: ".causet/specs/**",
  },
  Family {
    name: "causet.metadata-envelope",
    scope: "envelope",
    registered: &[1],
    readable: &[1],
    written: &[1],
    unknown_version: "refuse",
    store: "manifest.json of a metadata export directory",
  },
  Family {
    name: "causet.proof-bundle",
    scope: "envelope",
    registered: &[1, 2],
    readable: &[1, 2],
    written: &[2],
    unknown_version: "refuse",
    store: "a file handed to cst verify-proof",
  },
  Family {
    name: "causet.capabilities",
    scope: "advertisement",
    registered: &[1],
    readable: &[1],
    written: &[1],
    unknown_version: "refuse",
    store: "produced on demand by cst capabilities; served by a gateway",
  },
];

/// Frozen resource bounds (ADR-0020), in publication order.
pub const RESOURCE_BOUNDS: &[(&str, u64)] = &[
  ("noteContainerBytes", 8388608),
  ("noteContainerRecords", 4096),
  ("localStateBytes", 67108864),
  ("specManifestBytes", 8388608),
  ("envelopeManifestBytes", 16777216),
  ("envelopeBundleBytes", 2147483648),
  ("envelopeRecords", 1000000),
  ("provenanceActors", 64),
  ("proofBundleBytes", 16777216),
  ("capabilityDocumentBytes", 1048576),
];

pub const EXCHANGED_SCOPES: &[&str] =
  &["note-container", "note-record", "envelope", "advertisement"];
pub const EXCHANGE_FEATURES: &[&str] = &[
  "bound-source-inventory/v1",
  "causal-notes/v1",
  "causal-rebase/v1",
  "exact-resolutions/v1",
  "metadata-integrity/v1",
];
pub const PROVENANCE_ROLE_NAMES: &[&str] = &["authored", "generated", "reviewed"];
pub const RESOLUTION_SIGNATURE_ALGORITHM: &str = "ordered-three-way-blobs/v1";
pub const METADATA_LINEAGE_ALGORITHM: &str = "git-root-commits-sha256/v1";

pub const ERROR_ENVELOPE_SCHEMA: &str = "causet.error/v1";

/// The closed error-code vocabulary (ADR-0021): each code and what it tells a caller.
pub const ERROR_CODES: &[(&str, &str)] = &[
  (
    "usage-missing-argument",
    "A required argument or flag value was absent. Supply it.",
  ),
  (
    "usage-unknown-command",
    "The command or subcommand does not exist. Check the spelling against --help.",
  ),
  (
    "usage-conflicting-options",
    "Two options that cannot be combined were both given. Choose one.",
  ),
  (
    "usage-invalid-option-value",
    "An option value was outside its accepted set or range. Choose a permitted value.",
  ),
  (
    "not-found",
    "The named forecast, workspace, commit, file, or envelope does not exist. Check the identifier.",
  ),
  (
    "already-exists",
    "The destination path or ref already exists. Choose another, or remove the existing one deliberately.",
  ),
  (
    "no-match",
    "The named item exists but is not a candidate for this operation. List the candidates and choose again.",
  ),
  (
    "ambiguous-match",
    "Several candidates matched and none was selected. Name one explicitly.",
  ),
  (
    "nothing-pending",
    "There is nothing of this kind pending in this worktree. No action is required.",
  ),
  (
    "malformed-input",
    "A document or record could not be parsed, or failed a structural check. Repair or regenerate it.",
  ),
  (
    "invalid-identifier",
    "An identifier does not have the required form. Check it against the published identity profile.",
  ),
  (
    "unsafe-input",
    "An argument contained a character that is not safe to pass to Git. Remove it.",
  ),
  (
    "path-outside-repository",
    "A path escaped the repository root. Give a path inside the repository.",
  ),
  (
    "integrity-check-failed",
    "A declared hash did not match the bytes it covers. The artifact was altered or truncated.",
  ),
  (
    "unknown-schema-version",
    "A record's schema version is outside what this build reads. Read it with the build that wrote it.",
  ),
  (
    "wrong-record-family",
    "A store held a record of a different family than expected. Stop and surface this to a human.",
  ),
  (
    "resource-bound-exceeded",
    "An input exceeded a published resource bound. Reduce the input, or raise the bound deliberately.",
  ),
  (
    "no-common-version",
    "Two builds share no version of a family, profile, or algorithm an exchange needs. Upgrade one side; nothing is wrong with either record.",
  ),
  (
    "dirty-worktree",
    "The worktree has uncommitted changes and this operation requires a clean one.",
  ),
  (
    "precondition-not-met",
    "A stated precondition does not hold yet. The message names the step that establishes it.",
  ),
  (
    "operation-in-progress",
    "A VCS Lab operation journal is present in an affected worktree. Finish or abort it first.",
  ),
  (
    "notes-locked",
    "Another causet process holds the causal notes lock. Wait for it to finish and retry; remove the lock file only if that process is gone.",
  ),
  (
    "workspace-registry-locked",
    "The workspace registry lock could not be acquired. Retry after the holder finishes; recover an abandoned lock only with all workspace writers stopped on every host sharing the repository.",
  ),
  (
    "no-operation-pending",
    "No VCS Lab operation is pending, so there is nothing to continue or abort.",
  ),
  (
    "operation-state-invalid",
    "The pending operation is in a state this command cannot act on. The message names the state.",
  ),
  (
    "git-operation-active",
    "Git itself has a replay or sequencer operation in progress. Resolve it before continuing.",
  ),
  (
    "out-of-band-change",
    "Git's state and the VCS Lab journal disagree, because Git was driven directly. Abort and restart the operation.",
  ),
  (
    "repository-mismatch",
    "The named path or object belongs to a different repository or workspace than the one in use.",
  ),
  (
    "unmigrated-repository",
    "The repository keeps its metadata under the names used before causet, which this build no longer reads. Run cst migrate; it deletes nothing.",
  ),
  (
    "stale-forecast",
    "A forecast no longer matches the repository it was pinned to. Regenerate and re-approve it.",
  ),
  (
    "stale-overlay",
    "The worktree changed since its target overlay was captured. Capture a new checkpoint and forecast again; nothing was re-captured for you.",
  ),
  (
    "stale-input",
    "An input changed while the operation was running. Retry from a quiet repository.",
  ),
  (
    "stale-manifest",
    "A specification manifest no longer matches the Markdown it describes. Re-index it with cst spec index, then stage or commit the result.",
  ),
  (
    "conflict-paused",
    "The operation paused on a conflict and is resumable. Resolve the paths, then continue.",
  ),
  (
    "interactive-paused",
    "A declared interactive action paused the rebase for the caller to supply a message or change content. Continue when ready; nothing was lost.",
  ),
  (
    "conflict-blocked",
    "Git could not apply or continue the change. The details carry Git's own output.",
  ),
  (
    "approval-required",
    "The plan contains heuristic candidates that must be accepted explicitly before proceeding.",
  ),
  (
    "manual-review-required",
    "A semantic merge could not be decided conservatively and needs a human.",
  ),
  (
    "identity-not-preserved",
    "A rewrite did not carry the logical identity it was required to preserve (FR-ID-02).",
  ),
  (
    "identity-conflict",
    "Two records claim the same identifier with different content. Resolve the conflict before importing.",
  ),
  (
    "git-unavailable",
    "Git could not be started at all. Check that it is installed and on PATH.",
  ),
  (
    "git-command-failed",
    "A Git command exited non-zero. The details carry its output.",
  ),
  (
    "path-length-exceeded",
    "Git could not create a resolution retention ref at the Windows path-length limit. Shorten the Git directory path or enable Git long paths, then retry.",
  ),
  (
    "revision-not-resolved",
    "A revision or object did not resolve to the expected type. Check the reference.",
  ),
  (
    "git-response-malformed",
    "Git returned output this build could not parse. Report it with the Git version.",
  ),
  (
    "session-unavailable",
    "A batched Git session is closed, timed out, or failed. The command falls back to ordinary Git where it can.",
  ),
  (
    "unsupported-feature",
    "The prototype does not implement this case. The message names the supported set.",
  ),
  (
    "unsupported-repository-shape",
    "The repository's history or object format is outside what this operation supports.",
  ),
  (
    "unsupported-range",
    "The named commit range is not one this operation can execute. The message says which rule it broke; name a range from an ancestor up to a branch tip.",
  ),
  (
    "internal-invariant",
    "An internal invariant did not hold. This is a defect; report it.",
  ),
];
