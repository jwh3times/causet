import { createHash, randomBytes } from "node:crypto";

export const LOGICAL_ID_PROFILE = "vcs-lab.logical-id/v1";

/**
 * Every namespace `newId` mints, and what an identifier in it names. The set
 * is closed: an identifier in an unlisted namespace is not a vcs-lab logical
 * identifier, which is what lets a reader tell one apart from an arbitrary
 * string that happens to contain an underscore (FR-ID-07).
 */
export const ID_NAMESPACES = Object.freeze({
  ch: "a logical change, carried by the Change-Id commit trailer",
  land: "a landing receipt",
  apply: "an application receipt",
  reconcile: "a reconciliation receipt",
  reconcile_op: "a worktree-private reconciliation journal",
  rebase: "a completed causal rebase receipt",
  rebase_apply: "a rebase application receipt",
  rebase_op: "a worktree-private rebase journal",
  forecast: "a stored reconciliation forecast",
  rebase_forecast: "a stored rebase forecast",
  resolution: "a recorded conflict resolution",
  ws: "a workspace registry entry",
  prov: "a declared authorship provenance record",
  artifact: "a specification artifact",
});

/** Random bits per identifier: `randomBytes(6)` rendered as 12 hex digits. */
export const ID_ENTROPY_BITS = 48;

const LOGICAL_ID_PATTERN =
  /^(?<namespace>[a-z][a-z_]*)_(?<minted>[0-9a-z]{9})(?<random>[0-9a-f]{12})$/;

/**
 * Mint a logical identifier: `<namespace>_<minted><random>`, where `minted` is
 * the millisecond clock in base36 padded to nine characters and `random` is
 * 48 bits from the system CSPRNG in hex.
 *
 * The clock is a partition, not a guarantee: two identifiers can only collide
 * when they are minted in the same millisecond *and* their random halves
 * match, which puts the birthday bound at roughly 2^24 identifiers within one
 * millisecond. It is not a sort key and must not be read as a timestamp for
 * any decision — a peer's clock is not ours.
 *
 * Accidental collision is therefore negligible; **deliberate collision is
 * trivial**, because anyone who can write a commit message can write any
 * `Change-Id` trailer. Logical identifiers coordinate work; they do not
 * authenticate it. See `docs/identity/README.md`.
 */
export function newId(prefix) {
  const time = Date.now().toString(36).padStart(9, "0");
  const random = randomBytes(6).toString("hex");
  return `${prefix}_${time}${random}`;
}

/**
 * Parse a logical identifier into its parts, or say why it is not one. The
 * `git:<oid>` fallback of FR-ID-05 is deliberately not a logical identifier:
 * it is a commit address standing in for an absent one, and reporting it as
 * such keeps the two forms distinguishable.
 */
export function parseLogicalId(value) {
  if (typeof value !== "string" || value === "") {
    return { valid: false, reason: "not-a-string" };
  }
  if (value.startsWith("git:")) {
    return { valid: false, reason: "commit-fallback-identity" };
  }
  const match = value.match(LOGICAL_ID_PATTERN);
  if (!match) return { valid: false, reason: "malformed" };
  const { namespace, minted, random } = match.groups;
  if (!Object.hasOwn(ID_NAMESPACES, namespace)) {
    return { valid: false, reason: "unknown-namespace", namespace };
  }
  return { valid: true, namespace, minted, random };
}

/** True when `value` is a logical identifier, optionally of one namespace. */
export function isLogicalId(value, namespace = null) {
  const parsed = parseLogicalId(value);
  return parsed.valid && (namespace === null || parsed.namespace === namespace);
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function gitBlobId(value, algorithm = "sha1") {
  const content = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  const header = Buffer.from(`blob ${content.length}\0`);
  return createHash(algorithm).update(header).update(content).digest("hex");
}

export function slug(value) {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "untitled";
}
