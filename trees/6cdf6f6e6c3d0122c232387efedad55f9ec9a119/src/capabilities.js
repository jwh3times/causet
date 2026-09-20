import fs from "node:fs";
import path from "node:path";
import { CANONICAL_JSON_PROFILE, hashedPayload } from "./canonical-json.js";
import { ERROR_ENVELOPE_SCHEMA, CliError } from "./errors.js";
import { LOGICAL_ID_PROFILE, sha256 } from "./ids.js";
import { lineageRelation, repositoryLineage } from "./metadata.js";
import { ENVELOPE_MANIFEST, readEnvelope } from "./metadata-envelope.js";
import { repoContext } from "./engine.js";
import {
  CAPABILITIES_SCHEMA,
  EXCHANGE_FEATURES,
  EXCHANGED_SCOPES,
  METADATA_ENVELOPE_SCHEMA,
  METADATA_LINEAGE_ALGORITHM,
  RECORD_FAMILIES,
  RESOURCE_BOUNDS,
  RESOLUTION_SIGNATURE_ALGORITHM,
  assertReadableSchema,
} from "./schemas.js";
import { VERSION } from "./version.js";

export const CAPABILITY_REPORT_SCHEMA = "vcs-lab.capability-report/v1";

/** Object formats this build reads and writes. */
const OBJECT_FORMATS = Object.freeze(["sha1", "sha256"]);

/**
 * The resource bounds a peer needs, and the reason every other bound is not a
 * peer's business. Together these must name every entry of `RESOURCE_BOUNDS`;
 * `test/schema-compatibility.test.js` fails the suite otherwise, so a new bound
 * cannot be added without deciding whether it is advertised.
 */
export const ADVERTISED_BOUNDS = Object.freeze([
  "noteContainerBytes",
  "noteContainerRecords",
  "envelopeManifestBytes",
  "envelopeBundleBytes",
  "envelopeRecords",
  "provenanceActors",
  "capabilityDocumentBytes",
  "proofBundleBytes",
]);

export const UNADVERTISED_BOUNDS = Object.freeze({
  localStateBytes:
    "worktree-private and shared-local state, which no exchange carries",
  specManifestBytes:
    "tracked manifests, which move with ordinary Git content rather than through an exchange",
});

/**
 * The capability document (ADR-0033): what this build reads and writes, stated
 * so another party can decide what may be exchanged without asking anything
 * else. Every member except `repository` and `integrity` is projected from a
 * runtime registry rather than maintained by hand, so the document cannot
 * disagree with the build that emits it.
 *
 * `repository` makes the document repository-scoped. Producing it reads the
 * repository and writes nothing — in particular it must not call `initLab`,
 * which writes Git configuration.
 */
export function capabilityDocument(options = {}) {
  const document = {
    schema: CAPABILITIES_SCHEMA,
    producer: { name: "causal-vcs-lab", version: VERSION },
    families: [...RECORD_FAMILIES]
      .filter(([, policy]) => EXCHANGED_SCOPES.includes(policy.scope))
      .map(([family, policy]) => ({
        family,
        scope: policy.scope,
        written: sortedVersions(policy.written),
        readable: sortedVersions(policy.readable),
        unknownVersion: policy.unknownVersion,
      }))
      .sort((left, right) => left.family.localeCompare(right.family)),
    profiles: {
      canonicalJson: CANONICAL_JSON_PROFILE,
      logicalId: LOGICAL_ID_PROFILE,
      errorEnvelope: ERROR_ENVELOPE_SCHEMA,
    },
    algorithms: {
      lineage: METADATA_LINEAGE_ALGORITHM,
      resolutionSignature: RESOLUTION_SIGNATURE_ALGORITHM,
      integrity: "sha256",
    },
    objectFormats: [...OBJECT_FORMATS],
    features: [...EXCHANGE_FEATURES].sort(),
    bounds: Object.fromEntries(
      [...ADVERTISED_BOUNDS].sort().map((name) => [name, RESOURCE_BOUNDS[name]]),
    ),
  };
  // `repository: null` asks for the build-scoped form explicitly; omitting the
  // option detects the repository. `??` would conflate the two.
  const repository = options.repository === undefined
    ? repositoryScope(options.cwd)
    : options.repository;
  if (repository) document.repository = repository;
  document.integrity = {
    algorithm: "sha256",
    documentHash: documentHash(document),
  };
  return document;
}

function sortedVersions(versions) {
  return [...versions].sort((left, right) => left - right);
}

/**
 * The repository members, or null outside a repository. A build-scoped document
 * is the honest answer there: there is no lineage to state, and inventing one
 * would make two builds look like two repositories.
 */
function repositoryScope(cwd = process.cwd()) {
  let context;
  try {
    context = repoContext(cwd);
  } catch {
    return null;
  }
  return {
    objectFormat: context.objectFormat,
    lineage: repositoryLineage(context.root),
  };
}

/**
 * The document hash covers the canonical-JSON bytes of the document without its
 * reserved `integrity` and `signatures` members, exactly as the envelope
 * manifest's hash does, so a future detached signature covers the same bytes
 * (docs/canonical-json/README.md).
 */
function documentHash(value) {
  try {
    return sha256(hashedPayload(value));
  } catch (error) {
    if (error instanceof TypeError) {
      throw new CliError(
        "Capability document is not representable in the canonical JSON profile.",
        { code: "malformed-input", details: error.message },
      );
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Reading a peer's statement
// ---------------------------------------------------------------------------

/**
 * A peer's capability document, or the part of one an envelope manifest states.
 * The bound is checked before the bytes are parsed, and a version this build
 * does not read is refused rather than guessed at: a client cannot negotiate
 * from a document it does not understand (ADR-0033).
 */
export function readPeerCapabilities(target) {
  const resolved = path.resolve(target);
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new CliError(`No capability document or envelope at '${resolved}'.`,
        { code: "not-found" });
    }
    throw error;
  }
  if (stat.isDirectory()) return peerFromEnvelope(resolved);
  if (stat.size > RESOURCE_BOUNDS.capabilityDocumentBytes) {
    throw new CliError(
      `Capability document '${resolved}' exceeds the capabilityDocumentBytes bound of ${RESOURCE_BOUNDS.capabilityDocumentBytes}.`,
      {
        code: "resource-bound-exceeded",
        details: "The bound is checked before the document is parsed; see docs/schemas/compatibility.md.",
      },
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(resolved, "utf8"));
  } catch {
    throw new CliError(`Capability document '${resolved}' is not valid JSON.`,
      { code: "malformed-input" });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CliError(`Capability document '${resolved}' is not a JSON object.`,
      { code: "malformed-input" });
  }
  assertReadableSchema(parsed.schema, `The capability document at '${resolved}'`, {
    family: "vcs-lab.capabilities",
    recovery: "Ask the peer for a version this build reads, or upgrade this build.",
  });
  return { source: "document", document: normalizePeer(parsed) };
}

/**
 * What an envelope manifest states about its producer. A v1 envelope carries
 * `producer`, `repository`, and the `capabilities` feature tokens, and nothing
 * about families, profiles, algorithms, or bounds — so the report must say those
 * were not stated rather than that the peer cannot read them.
 */
function peerFromEnvelope(directory) {
  const manifestPath = path.join(directory, ENVELOPE_MANIFEST);
  if (!fs.existsSync(manifestPath)) {
    throw new CliError(
      `'${directory}' is a directory but holds no ${ENVELOPE_MANIFEST}.`,
      {
        code: "not-found",
        details: "Give a capability document, or a metadata envelope directory.",
      },
    );
  }
  const envelope = readEnvelope(directory);
  return {
    source: "envelope",
    document: normalizePeer({
      schema: CAPABILITIES_SCHEMA,
      producer: envelope.manifest.producer,
      repository: envelope.manifest.repository,
      features: [...(envelope.manifest.capabilities ?? [])].sort(),
      statedBy: METADATA_ENVELOPE_SCHEMA,
    }),
  };
}

/**
 * Fill in what a peer document does not state, keeping "not stated" distinct
 * from "stated as empty". An older or narrower producer may omit a whole
 * section, and reporting that as "the peer cannot read anything" would be a
 * claim the document does not make.
 */
function normalizePeer(document) {
  return {
    ...document,
    stated: {
      families: Array.isArray(document.families),
      profiles: Boolean(document.profiles),
      algorithms: Boolean(document.algorithms),
      bounds: Boolean(document.bounds),
      objectFormats: Array.isArray(document.objectFormats),
      features: Array.isArray(document.features),
      repository: Boolean(document.repository),
    },
    families: Array.isArray(document.families) ? document.families : [],
    features: Array.isArray(document.features) ? document.features : [],
    objectFormats: Array.isArray(document.objectFormats) ? document.objectFormats : [],
  };
}

// ---------------------------------------------------------------------------
// Negotiation
// ---------------------------------------------------------------------------

/**
 * Compare two capability documents. A pure function: it reads no network, no
 * repository, and no clock, so where the peer's document came from cannot change
 * what it concludes. That is the whole point of ADR-0033 — every decision a
 * gateway would enable is reproducible offline from the same two documents.
 *
 * The report never throws for an incompatibility; `assertExchangePossible`
 * decides which of them make an exchange impossible rather than merely smaller.
 */
export function negotiate(local, peer, options = {}) {
  const peerStated = peer.stated ?? normalizePeer(peer).stated;
  return {
    schema: CAPABILITY_REPORT_SCHEMA,
    local: {
      producer: local.producer,
      repositoryScoped: Boolean(local.repository),
    },
    peer: {
      source: options.source ?? "document",
      producer: peer.producer ?? null,
      statedBy: peer.statedBy ?? CAPABILITIES_SCHEMA,
      repositoryScoped: Boolean(peer.repository),
      statedFamilies: peerStated.families,
      statedProfiles: peerStated.profiles,
      statedBounds: peerStated.bounds,
    },
    repository: compareRepository(local, peer),
    families: compareFamilies(local, peer, peerStated),
    profiles: compareNamed(local.profiles, peer.profiles, peerStated.profiles),
    algorithms: compareNamed(local.algorithms, peer.algorithms, peerStated.algorithms),
    objectFormats: compareObjectFormats(local, peer, peerStated),
    features: compareFeatures(local, peer, peerStated),
    bounds: compareBounds(local, peer, peerStated),
  };
}

/**
 * Step 1. Only two repository-scoped documents describe repositories, so a
 * build-scoped document on either side reports no comparison rather than a
 * failed one.
 */
function compareRepository(local, peer) {
  if (!local.repository || !peer.repository) return null;
  const relation = lineageRelation(peer.repository.lineage, local.repository.lineage);
  return {
    localObjectFormat: local.repository.objectFormat,
    peerObjectFormat: peer.repository.objectFormat,
    objectFormatAgreed: local.repository.objectFormat === peer.repository.objectFormat,
    localLineage: local.repository.lineage.id,
    peerLineage: peer.repository.lineage.id,
    lineageRelation: relation,
    // The relations an exchange admits are the ones envelope import already
    // admits: the same repository, or an ordinary fork of it.
    admitted: ["same", "fork"].includes(relation),
  };
}

/**
 * Steps 2 and 3. For each family this build advertises, what can be sent and
 * what can be received.
 *
 * `unreadableByPeer` is the per-record rule: a stored record's version is fixed
 * by whoever wrote it and may not be re-encoded, so the sender learns which of
 * its versions the receiver would quarantine *before* the transfer rather than
 * from the receiver's `vlab metadata status` after it. `selectedForSend` is the
 * per-document rule: for something produced fresh for this exchange, the highest
 * version both sides admit.
 */
function compareFamilies(local, peer, peerStated) {
  const peerByFamily = new Map(peer.families.map((entry) => [entry.family, entry]));
  return local.families.map((entry) => {
    const other = peerByFamily.get(entry.family);
    const peerReadable = sortedVersions(other?.readable ?? []);
    const peerWritten = sortedVersions(other?.written ?? []);
    const sendable = entry.written.filter((version) => peerReadable.includes(version));
    const unreadableByPeer = entry.written.filter((version) => !peerReadable.includes(version));
    const receivable = peerWritten.filter((version) => entry.readable.includes(version));
    return {
      family: entry.family,
      scope: entry.scope,
      localWritten: entry.written,
      localReadable: entry.readable,
      peerWritten,
      peerReadable,
      selectedForSend: sendable.length ? Math.max(...sendable) : null,
      selectedForReceive: receivable.length ? Math.max(...receivable) : null,
      unreadableByPeer,
      // What the receiving side would do with a version it does not read, taken
      // from the peer's own advertisement when it states one.
      peerDisposition: other?.unknownVersion ?? null,
      status: familyStatus({ peerStated, other, sendable, unreadableByPeer }),
    };
  });
}

function familyStatus({ peerStated, other, sendable, unreadableByPeer }) {
  if (!peerStated.families) return "peer-not-stated";
  if (!other) return "peer-unknown-family";
  if (sendable.length === 0) return "blocked";
  return unreadableByPeer.length === 0 ? "compatible" : "reduced";
}

/**
 * Profiles and algorithms negotiate like families with one version each: every
 * hash and identifier in an exchange is read under them, so a disagreement is
 * not a reduction but a refusal (ADR-0033).
 */
function compareNamed(localGroup, peerGroup, stated) {
  return Object.entries(localGroup ?? {})
    .map(([name, value]) => ({
      name,
      local: value,
      peer: stated ? (peerGroup?.[name] ?? null) : null,
      stated: Boolean(stated),
      agreed: stated ? peerGroup?.[name] === value : true,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function compareObjectFormats(local, peer, peerStated) {
  // Unstated is not the same as empty, and it is not the same as agreed: a peer
  // that never said which formats it handles has told us nothing to intersect.
  // The repository object format, which is what an exchange actually turns on,
  // is compared separately in `compareRepository`.
  return {
    local: [...local.objectFormats].sort(),
    peer: peerStated.objectFormats ? [...peer.objectFormats].sort() : null,
    common: peerStated.objectFormats
      ? [...local.objectFormats].filter((format) => peer.objectFormats.includes(format)).sort()
      : null,
    stated: peerStated.objectFormats,
  };
}

/**
 * Step 4. A feature is usable only when both sides advertise it. Tokens are
 * opaque, so a token only the peer knows is reported and otherwise ignored
 * rather than treated as a failure.
 */
function compareFeatures(local, peer, peerStated) {
  const localFeatures = new Set(local.features ?? []);
  const peerFeatures = new Set(peer.features ?? []);
  return {
    stated: peerStated.features,
    common: [...localFeatures].filter((token) => peerFeatures.has(token)).sort(),
    localOnly: [...localFeatures].filter((token) => !peerFeatures.has(token)).sort(),
    peerOnly: [...peerFeatures].filter((token) => !localFeatures.has(token)).sort(),
  };
}

/**
 * Step 5. Bounds are the receiver's, so the bound that governs what this build
 * may send is the peer's and the bound that governs what it may receive is its
 * own. A document or record over the receiver's bound is withheld and reported,
 * not sent to be refused.
 */
function compareBounds(local, peer, peerStated) {
  return Object.entries(local.bounds ?? {})
    .map(([name, value]) => ({
      name,
      receiving: value,
      sending: peerStated.bounds ? (peer.bounds?.[name] ?? null) : null,
      stated: Boolean(peerStated.bounds) && peer.bounds?.[name] !== undefined,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

// ---------------------------------------------------------------------------
// What makes an exchange impossible, rather than smaller
// ---------------------------------------------------------------------------

/**
 * Refuse the exchanges that cannot happen at all, and summarize the rest.
 *
 * The distinction is the substance of ADR-0033. A family version gap makes an
 * exchange *smaller*: those records are filtered, every other record still
 * moves, and the report names what was left behind. A profile, algorithm,
 * repository, or capability-version disagreement makes it *impossible*: there is
 * no set of bytes both sides would read the same way, so there is nothing to
 * report per record.
 */
export function assertExchangePossible(report) {
  if (report.repository && !report.repository.objectFormatAgreed) {
    throw new CliError(
      `The peer repository uses object format '${report.repository.peerObjectFormat}', not '${report.repository.localObjectFormat}'.`,
      {
        code: "repository-mismatch",
        details: "Git object formats are not interchangeable; no exchange between them is possible.",
      },
    );
  }
  if (report.repository && !report.repository.admitted) {
    throw new CliError(
      `The peer repository lineage is ${report.repository.lineageRelation}; an exchange requires the same repository or an ordinary fork of it.`,
      {
        code: "repository-mismatch",
        details: `Local lineage ${report.repository.localLineage}, peer lineage ${report.repository.peerLineage}.`,
      },
    );
  }
  for (const group of ["profiles", "algorithms"]) {
    for (const entry of report[group]) {
      if (entry.stated && !entry.agreed) {
        throw new CliError(
          `The peer states ${group.slice(0, -1)} ${entry.name} as '${entry.peer ?? "(missing)"}', not '${entry.local}'.`,
          {
            code: "no-common-version",
            details:
              "Every hash and identifier in an exchange is read under these, so a " +
              "disagreement leaves nothing both sides would read the same way.",
          },
        );
      }
    }
  }
  const own = report.families.find((entry) => entry.family === "vcs-lab.capabilities");
  if (own && own.status === "blocked") {
    throw new CliError(
      `The peer reads no ${own.family} version this build writes (writes ${own.localWritten.join(", ")}; peer reads ${own.peerReadable.join(", ") || "none"}).`,
      {
        code: "no-common-version",
        details: "Negotiation itself needs a document both sides can read. Upgrade one side.",
      },
    );
  }
  return summarize(report);
}

function summarize(report) {
  const counted = report.families.filter((entry) => entry.status !== "peer-not-stated");
  const reduced = counted.filter((entry) => entry.status === "reduced");
  const blocked = counted.filter((entry) =>
    ["blocked", "peer-unknown-family"].includes(entry.status));
  return {
    ...report,
    summary: {
      families: counted.length,
      reducedFamilies: reduced.length,
      blockedFamilies: blocked.length,
      // The exchange is possible: `assertExchangePossible` has already refused
      // the cases where it is not. What remains is how much of it moves.
      exchangeable: true,
      fullyCompatible: reduced.length === 0 && blocked.length === 0,
      blockers: blocked
        .map((entry) => ({
          kind: entry.status,
          subject: entry.family,
          detail: entry.status === "peer-unknown-family"
            ? "the peer does not advertise this family"
            : `the peer reads none of ${entry.localWritten.join(", ")}`,
        }))
        .sort((left, right) => left.subject.localeCompare(right.subject)),
      reductions: reduced
        .map((entry) => ({
          subject: entry.family,
          unreadableByPeer: entry.unreadableByPeer,
          selectedForSend: entry.selectedForSend,
        }))
        .sort((left, right) => left.subject.localeCompare(right.subject)),
    },
  };
}

/**
 * The whole offline path: this build's document, the peer's, and what the two
 * conclude. `vlab capabilities --against` is this function.
 */
export function negotiateAgainst(target, options = {}) {
  const local = capabilityDocument({ cwd: options.cwd });
  const peer = readPeerCapabilities(target);
  return assertExchangePossible(
    negotiate(local, peer.document, { source: peer.source }),
  );
}
