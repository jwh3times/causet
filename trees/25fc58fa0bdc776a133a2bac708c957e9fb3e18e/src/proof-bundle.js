import { sha256 } from "./ids.js";
import { canonicalJson } from "./canonical-json.js";
import { CliError } from "./errors.js";
import { RESOURCE_BOUNDS, schemaClassification, withinBound } from "./schemas.js";
import { buildBindings, verifyBindings } from "./proof-binding.js";
import {
  acceptedCausalRecords,
  lineageIdentityId,
  lineageRelation,
  readCausalRecordCatalog,
  repositoryLineage,
} from "./metadata.js";
import { buildMergePlan, coverageEvidence } from "./merge-plan.js";
import {
  commitHistory,
  currentHead,
  isAncestor,
  mergeBase,
  remoteRefs,
  resolveObjectIds,
} from "./engine.js";

export const PROOF_BUNDLE_SCHEMA = "vcs-lab.proof-bundle/v2";
/** The version before the bound inventory. Still read; never written. */
export const PROOF_BUNDLE_SCHEMA_V1 = "vcs-lab.proof-bundle/v1";
const READABLE_BUNDLE_SCHEMAS = [PROOF_BUNDLE_SCHEMA_V1, PROOF_BUNDLE_SCHEMA];

/**
 * The conclusions a verifier cannot reach from carried material alone, and why
 * (ADR-0031's tier table). Reporting them is not a formality: `new` is an
 * absence claim, and a landing policy that treated an unproven absence as
 * verified would be trusting the sender for exactly the claim the sender has the
 * most reason to get wrong.
 */
const UNAVAILABLE_WITHOUT_OBJECTS = [
  {
    conclusion: "new-work-is-absent",
    reason:
      "Coverage is a positive claim with a compact proof; newness is an absence " +
      "claim over the whole target history, which no bounded bundle can carry. " +
      "Only the repository-backed comparison establishes it.",
  },
  {
    conclusion: "candidate-equivalence",
    reason:
      "A patch-identity match is a claim about trees, and trees are what the " +
      "bundle deliberately does not carry, so a candidate stays advisory.",
  },
  {
    conclusion: "physical-base-is-best-common-ancestor",
    reason:
      "The carried path shows the stated base is an ancestor of both heads, not " +
      "that no nearer common ancestor exists; that needs the full graph.",
  },
];

const ANCHORS_NOT_CURRENT = {
  conclusion: "anchors-are-current",
  reason:
    "The bundle states its anchors and cannot prove them. Obtain them from a " +
    "channel you trust to raise every bound conclusion to the anchored tier.",
};

/**
 * The coverage proof lattice, restated as data a verifier can apply without
 * running the planner. Order is precedence: the first rule whose evidence
 * holds decides the classification, exactly as `buildMergePlan` evaluates it.
 *
 * Keeping the rules here rather than importing the planner's branch is the
 * point of the exercise (FR-PLAN-08): a verifier that shares the planner's
 * code proves only that the code is self-consistent. This table is applied to
 * the bundle's own evidence and the result compared with what the planner
 * claimed, so a doctored `proof` or `status` field is caught.
 */
export const PROOF_RULES = [
  {
    proof: "commit-ancestry",
    status: "covered",
    holds: (change, evidence) => evidence.targetCommits.has(change.commit),
    describe: (change) => ({ kind: "target-commit", commit: change.commit }),
  },
  {
    proof: "receipt-commit",
    status: "covered",
    holds: (change, evidence) => evidence.receiptCommits.has(change.commit),
    describe: (change, evidence) => ({
      kind: "receipt-absorbed-commit",
      commit: change.commit,
      receipts: evidence.receiptsClaimingCommit(change.commit),
    }),
  },
  {
    proof: "stable-change-id",
    status: "covered",
    holds: (change, evidence) => evidence.targetChangeIds.has(change.changeId),
    describe: (change) => ({ kind: "target-change-id", changeId: change.changeId }),
  },
  {
    proof: "receipt-change-id",
    status: "covered",
    holds: (change, evidence) => evidence.receiptChangeIds.has(change.changeId),
    describe: (change, evidence) => ({
      kind: "receipt-absorbed-change-id",
      changeId: change.changeId,
      receipts: evidence.receiptsClaimingChangeId(change.changeId),
    }),
  },
  {
    proof: "git-patch-id-heuristic",
    status: "candidate-equivalent",
    holds: (change, evidence) => evidence.patchEquivalentCommits.has(change.commit),
    describe: (change) => ({ kind: "patch-equivalent", commit: change.commit }),
  },
];

/** Index the bundle's evidence arrays for rule evaluation. */
function indexEvidence(evidence) {
  const receipts = evidence.receipts ?? [];
  return {
    targetCommits: new Set(evidence.targetCommits ?? []),
    targetChangeIds: new Set(evidence.targetChangeIds ?? []),
    receiptCommits: new Set(receipts.flatMap((r) => r.absorbedCommits ?? [])),
    receiptChangeIds: new Set(receipts.flatMap((r) => r.absorbedChanges ?? [])),
    patchEquivalentCommits: new Set(evidence.patchEquivalentCommits ?? []),
    receiptsClaimingCommit: (commit) =>
      receipts.filter((r) => (r.absorbedCommits ?? []).includes(commit)).map((r) => r.id),
    receiptsClaimingChangeId: (changeId) =>
      receipts.filter((r) => (r.absorbedChanges ?? []).includes(changeId)).map((r) => r.id),
  };
}

/**
 * Apply the lattice to one change. Returns the classification and the specific
 * evidence that produced it, which is what the plan's bare `proof` string
 * cannot give a reader: not only that a receipt covered this commit, but which
 * receipt claimed it.
 */
export function classifyFromEvidence(change, indexed) {
  for (const rule of PROOF_RULES) {
    if (rule.holds(change, indexed)) {
      return {
        status: rule.status,
        proof: rule.proof,
        evidence: rule.describe(change, indexed),
      };
    }
  }
  return { status: "new", proof: null, evidence: { kind: "none" } };
}

/** The bundle's hash covers everything except its own `integrity` member. */
export function bundleHash(bundle) {
  const { integrity, signatures, ...payload } = bundle;
  try {
    return sha256(canonicalJson(payload));
  } catch (error) {
    // The canonical profile refuses floats, unsafe integers, and non-JSON
    // values. A bundle carrying them is malformed input, not a defect here.
    throw new CliError(
      "The proof bundle cannot be hashed under the canonical JSON profile.",
      { code: "malformed-input", details: error.message },
    );
  }
}

const isPlainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function classificationCounts(changes) {
  const counts = { covered: 0, "candidate-equivalent": 0, new: 0 };
  for (const change of changes) counts[change.status]++;
  return counts;
}

/**
 * Refuse a document that is not a proof bundle, or one whose members are not
 * the shapes the lattice and the repository comparison read. The bundle is
 * another party's document, so a wrong shape is `malformed-input` reported
 * before any member is dereferenced, never a runtime error from inside the
 * classification.
 */
export function assertProofBundleDocument(bundle) {
  if (!isPlainObject(bundle)) {
    throw new CliError("The proof bundle is not a JSON object.", { code: "malformed-input" });
  }
  if (!READABLE_BUNDLE_SCHEMAS.includes(bundle.schema)) {
    // The right family at another version is a build mismatch, not a foreign
    // document: its remedy is the build that wrote it (issue #98).
    const { family, version } = schemaClassification(bundle.schema);
    const { family: ownFamily } = schemaClassification(PROOF_BUNDLE_SCHEMA);
    if (family === ownFamily && version !== null) {
      throw new CliError(
        `The proof bundle carries unsupported schema ${JSON.stringify(bundle.schema)}.`,
        {
          code: "unknown-schema-version",
          details: `This build reads ${READABLE_BUNDLE_SCHEMAS.join(", ")}.`,
        },
      );
    }
    // The complaint is about the family, so the message names the family rather
    // than one of its versions: this build reads several.
    throw new CliError(
      `Not a vcs-lab.proof-bundle document (found ${JSON.stringify(bundle.schema ?? null)}).`,
        { code: "wrong-record-family" },
    );
  }
  // The members and shapes below are the ones docs/schemas/proof-bundle.v1
  // .schema.json requires; a bundle missing one is malformed, not merely
  // failing its integrity check.
  const problems = [];
  const expectObject = (value, name, required = true) => {
    if (value === undefined) {
      if (required) problems.push(`${name} is required`);
    } else if (!isPlainObject(value)) problems.push(`${name} must be an object`);
  };
  const expectArray = (value, name, required = true) => {
    if (value === undefined) {
      if (required) problems.push(`${name} is required`);
    } else if (!Array.isArray(value)) problems.push(`${name} must be an array`);
  };
  const expectString = (value, name) => {
    if (typeof value !== "string" || value.length === 0) problems.push(`${name} must be a non-empty string`);
  };
  for (const name of ["repository", "target", "source", "effectiveBase", "evidence", "counts", "integrity"]) {
    expectObject(bundle[name], name);
  }
  expectString(bundle.physicalBase, "physicalBase");
  expectArray(bundle.changes, "changes");
  if (Array.isArray(bundle.changes)) {
    bundle.changes.forEach((change, index) => {
      expectObject(change, `changes[${index}]`);
      if (isPlainObject(change)) {
        expectString(change.commit, `changes[${index}].commit`);
        expectString(change.changeId, `changes[${index}].changeId`);
        if (typeof change.subject !== "string") {
          problems.push(`changes[${index}].subject must be a string`);
        }
        if (!["covered", "candidate-equivalent", "new"].includes(change.status)) {
          problems.push(`changes[${index}].status must be covered, candidate-equivalent, or new`);
        }
        // Null is the proof of new work; anything else must name a proof.
        if (change.proof !== null && (typeof change.proof !== "string" || change.proof.length === 0)) {
          problems.push(`changes[${index}].proof must be a non-empty string or null`);
        }
      }
    });
  }
  if (isPlainObject(bundle.evidence)) {
    const { evidence } = bundle;
    for (const name of ["receipts", "targetCommits", "targetChangeIds", "patchEquivalentCommits"]) {
      expectArray(evidence[name], `evidence.${name}`);
    }
    if (Array.isArray(evidence.receipts)) {
      evidence.receipts.forEach((receipt, index) => {
        expectObject(receipt, `evidence.receipts[${index}]`);
        if (isPlainObject(receipt)) {
          expectArray(receipt.absorbedCommits, `evidence.receipts[${index}].absorbedCommits`, false);
          expectArray(receipt.absorbedChanges, `evidence.receipts[${index}].absorbedChanges`, false);
        }
      });
    }
  }
  if (bundle.schema === PROOF_BUNDLE_SCHEMA) {
    // The v2 members. A bundle that claims v2 and omits them is malformed
    // rather than merely unbound: the version is a promise about what it
    // carries.
    for (const name of ["objects", "sourceInventory", "reachability", "receiptInclusion", "anchors"]) {
      expectObject(bundle[name], name);
    }
    if (isPlainObject(bundle.objects)) {
      for (const [oid, object] of Object.entries(bundle.objects)) {
        if (!isPlainObject(object)) {
          problems.push(`objects.${oid} must be an object`);
          continue;
        }
        expectString(object.base64, `objects.${oid}.base64`);
        if (!["commit", "tree", "blob"].includes(object.type)) {
          problems.push(`objects.${oid}.type must be commit, tree, or blob`);
        }
      }
    }
    if (isPlainObject(bundle.sourceInventory)) {
      expectArray(bundle.sourceInventory.commits, "sourceInventory.commits");
    }
    if (isPlainObject(bundle.reachability)) {
      expectArray(bundle.reachability.paths, "reachability.paths");
      if (Array.isArray(bundle.reachability.paths)) {
        bundle.reachability.paths.forEach((entry, index) => {
          expectObject(entry, `reachability.paths[${index}]`);
          if (isPlainObject(entry)) {
            expectArray(entry.commits, `reachability.paths[${index}].commits`);
          }
        });
      }
    }
    if (isPlainObject(bundle.receiptInclusion)) {
      expectArray(bundle.receiptInclusion.receipts, "receiptInclusion.receipts");
    }
  }
  if (problems.length) {
    throw new CliError("The proof bundle is not structurally valid.", {
      code: "malformed-input",
      details: problems.join("\n"),
    });
  }
}

/**
 * Build a portable proof bundle for `sourceRef` against the current target
 * (FR-PLAN-08). The bundle carries the classification *and the evidence it was
 * derived from*, so a third party can recompute the classification instead of
 * trusting it, and can check the evidence against the repository when they
 * have one.
 */
export function buildProofBundle(sourceRef, cwd = process.cwd()) {
  const plan = buildMergePlan(sourceRef, cwd);
  const evidence = coverageEvidence(sourceRef, cwd);
  const lineage = repositoryLineage(cwd);
  const bundle = {
    schema: PROOF_BUNDLE_SCHEMA,
    repository: {
      lineage,
    },
    target: { head: plan.targetHead },
    source: { ref: plan.sourceRef, head: plan.sourceHead },
    physicalBase: plan.physicalBase,
    effectiveBase: plan.effectiveBase,
    evidence,
    changes: plan.changes.map((change) => ({
      commit: change.commit,
      changeId: change.changeId,
      subject: change.subject,
      status: change.status,
      proof: change.proof,
    })),
    counts: plan.counts,
  };
  // The v1 members above are unchanged, and the repository-backed comparison
  // still reads exactly them. Everything below is what a verifier without the
  // repository needs (ADR-0031).
  Object.assign(bundle, buildBindings(plan, evidence, lineage, cwd));
  bundle.integrity = { algorithm: "sha256", bundleHash: bundleHash(bundle) };
  assertWithinProofBound(bundle);
  return bundle;
}

/**
 * Refuse to emit a bundle over the published bound rather than truncating it
 * (ADR-0031). A truncated proof is indistinguishable from an omission, which is
 * the attack the bound inventory exists to catch, so the producer names the
 * member that did not fit and stops.
 */
function assertWithinProofBound(bundle) {
  const bytes = Buffer.byteLength(`${JSON.stringify(bundle, null, 2)}\n`);
  if (withinBound("proofBundleBytes", bytes)) return;
  const sizeOf = (member) => Buffer.byteLength(JSON.stringify(bundle[member] ?? null));
  const largest = ["objects", "evidence", "reachability", "receiptInclusion", "sourceInventory"]
    .map((member) => ({ member, bytes: sizeOf(member) }))
    .sort((left, right) => right.bytes - left.bytes)[0];
  throw new CliError(
    `The proof bundle is ${bytes} bytes, over the proofBundleBytes bound of ${RESOURCE_BOUNDS.proofBundleBytes}.`,
    {
      code: "resource-bound-exceeded",
      details:
        `The largest member is '${largest.member}' at ${largest.bytes} bytes. A truncated ` +
        "proof cannot be told apart from an omission, so nothing was emitted.",
    },
  );
}

/**
 * Whether the bundle's stated lineage survives comparison with this
 * repository's. `same` is decided by the id alone, so the whole identity is
 * compared: a bundle that kept its id but altered its root list is a tampered
 * claim, not this repository. `fork` shares a root with a different id, so
 * the claim must at least be self-consistent: its id must be the hash of the
 * identity it states, in this repository's algorithm and object format.
 */
function lineageClaimHolds(claimed, actual, relation) {
  if (relation === "same") return canonicalJson(claimed) === canonicalJson(actual);
  if (relation === "fork") {
    return Array.isArray(claimed?.rootCommits) &&
      claimed.algorithm === actual.algorithm &&
      claimed.objectFormat === actual.objectFormat &&
      claimed.id === lineageIdentityId(claimed);
  }
  return false;
}

/**
 * Check the bundle's evidence against a real repository, which is the only
 * check that can catch **fabricated** evidence. Recomputing the classification
 * proves a plan follows from what it states; it cannot notice that a stated
 * receipt never existed. This recomputes the evidence from the repository and
 * compares it byte for byte under the canonical JSON profile. Source inventory
 * and bases are derived from Git history and accepted records independently of
 * buildMergePlan; otherwise an omitted change would never reach the lattice.
 *
 * A repository that has moved on since the bundle was produced is reported as
 * `skipped`, not as a failure: different heads legitimately produce different
 * evidence, and calling that tampering would cry wolf.
 */
export function verifyAgainstRepository(bundle, cwd = process.cwd()) {
  const claimedTarget = bundle?.target?.head ?? null;
  const claimedSource = bundle?.source?.head ?? null;
  const sourceRef = bundle?.source?.ref ?? null;
  if (!claimedTarget || !claimedSource || !sourceRef) {
    return { checked: false, reason: "bundle-incomplete", matches: null };
  }

  // Lineage first, because it is the only discriminator that separates a
  // bundle about this repository from a bundle about a different one. Without
  // it every mismatch below reads as "the branch moved on, fetch and retry",
  // which is exactly the wrong advice for a bundle that was never about this
  // repository at all. Lineage is derived from the root commits, so it also
  // catches the case where the two repositories do not even share an object
  // format.
  // The relation is the one `vlab metadata import` applies: a fork (a shared
  // root plus further roots) holds every object the comparison needs and is
  // verified like the same repository; only an unrelated or incompatible
  // lineage means the bundle will never be about this repository (issue #89).
  const claimedLineage = bundle?.repository?.lineage ?? null;
  const actualLineage = repositoryLineage(cwd);
  let relation = null;
  if (claimedLineage?.id) {
    relation = lineageRelation(claimedLineage, actualLineage);
    if (!["same", "fork"].includes(relation)) {
      return {
        checked: false,
        reason: "different-repository",
        matches: null,
        lineageRelation: relation,
        claimedLineage: claimedLineage.id,
        repositoryLineage: actualLineage?.id ?? null,
        claimedObjectFormat: claimedLineage.objectFormat ?? null,
        repositoryObjectFormat: actualLineage?.objectFormat ?? null,
      };
    }
  }

  const head = currentHead(cwd);
  if (head !== claimedTarget) {
    return {
      checked: false,
      reason: "target-moved",
      matches: null,
      claimedTarget,
      repositoryTarget: head,
    };
  }
  let repositorySource;
  try {
    [repositorySource] = resolveObjectIds([`${sourceRef}^{commit}`], cwd);
  } catch {
    return { checked: false, reason: "source-ref-missing", matches: null, sourceRef };
  }
  if (repositorySource !== claimedSource) {
    return {
      checked: false,
      reason: "source-moved",
      matches: null,
      claimedSource,
      repositorySource,
    };
  }
  const actual = coverageEvidence(sourceRef, cwd);
  const physicalBase = mergeBase(head, repositorySource, cwd);
  const sourceChanges = commitHistory([`${physicalBase}..${repositorySource}`], cwd, {
    reverse: true,
  }).map(({ commit, message, subject }) => ({
    commit,
    changeId: message.match(/^Change-Id:\s*(.+?)\s*$/im)?.[1]?.trim() ?? `git:${commit}`,
    subject,
  }));
  const targetCommits = new Set(actual.targetCommits ?? []);
  const catalog = readCausalRecordCatalog(cwd);
  const receipts = acceptedCausalRecords(
    catalog.records.filter((record) =>
      targetCommits.has(record.attachedTo) &&
      ["landing", "reconciliation", "rebase"].includes(record.type),
    ),
    cwd,
    { conflictingIds: catalog.conflictingIds },
  );
  let effectiveBase = { commit: physicalBase, reason: "physical-ancestry" };
  for (const receipt of receipts) {
    if (receipt.sourceHead &&
        isAncestor(receipt.sourceHead, repositorySource, cwd) &&
        isAncestor(effectiveBase.commit, receipt.sourceHead, cwd)) {
      effectiveBase = { commit: receipt.sourceHead, reason: `causal-receipt:${receipt.id}` };
    }
  }
  const indexed = indexEvidence(actual);
  const counts = classificationCounts(sourceChanges.map((change) =>
    classifyFromEvidence(change, indexed),
  ));
  const checks = {
    lineage: lineageClaimHolds(claimedLineage, actualLineage, relation),
    evidence: canonicalJson(actual) === canonicalJson(bundle.evidence),
    sourceChanges: canonicalJson(sourceChanges) === canonicalJson(
      bundle.changes.map(({ commit, changeId, subject }) => ({ commit, changeId, subject })),
    ),
    physicalBase: bundle.physicalBase === physicalBase,
    effectiveBase: canonicalJson(bundle.effectiveBase) === canonicalJson(effectiveBase),
    counts: canonicalJson(bundle.counts) === canonicalJson(counts),
  };
  return {
    checked: true,
    reason: null,
    matches: Object.values(checks).every(Boolean),
    lineageRelation: relation,
    checks,
    evidenceHash: {
      claimed: sha256(canonicalJson(bundle.evidence ?? {})),
      repository: sha256(canonicalJson(actual)),
    },
  };
}

/**
 * Verify a bundle. Two independent checks, reported separately because they
 * answer different questions:
 *
 * - **integrity**: the bundle's own hash still matches its contents, so nothing
 *   was edited after it was produced.
 * - **classification**: re-deriving every change from the bundle's evidence
 *   reproduces the status and proof it claims. This catches a doctored `proof`
 *   or `status`, and it is the check FR-PLAN-08 asks for.
 *
 * Neither check can tell whether the *evidence itself* is truthful — a bundle
 * could state receipts that do not exist. That requires the repository, and is
 * what `verifyAgainstRepository` adds.
 */
/**
 * Which tier a conclusion about this bundle may be reported at (ADR-0031).
 *
 * The tiers are not degrees of confidence in the same statement; they are
 * different statements. Tier 0 says the classification follows from what the
 * bundle states. Tier 1 says the stated evidence is bound to Git objects
 * between the *stated* heads. Tier 2 says those heads are the real ones,
 * which no bundle can say about itself — only a channel the verifier chose can.
 * A third party may act on tier 2.
 */
function conclusionTier(binding, anchors) {
  if (!binding.checked || !binding.agrees) return "self-consistent";
  return anchors?.anchored ? "anchored" : "bound";
}

/**
 * Anchors obtained from a remote the *verifier* names, read with
 * `git ls-remote` (ADR-0031 owner decision 5). A remote named inside the bundle
 * is only ever a hint, because the bundle's producer controls that name, so this
 * takes the remote as an argument and never reads one out of the document.
 *
 * Root commits are not ref tips, so this channel cannot supply them; that is
 * reported rather than quietly treated as confirmed.
 */
export function anchorsFromLsRemote(bundle, remote, cwd = process.cwd()) {
  const advertised = remoteRefs(remote, cwd);
  if (advertised === null) {
    return {
      channel: "ls-remote",
      remote,
      available: false,
      reason: "remote-unreadable",
      confirmed: [],
      unconfirmed: [],
      anchored: false,
      details: "The remote could not be read; no anchor was confirmed or denied.",
    };
  }
  const refsByOid = new Map();
  for (const entry of advertised) {
    refsByOid.set(entry.oid, [...(refsByOid.get(entry.oid) ?? []), entry.ref]);
  }
  const wanted = [
    ["targetHead", bundle.anchors?.targetHead ?? bundle.target?.head ?? null],
    ["sourceHead", bundle.anchors?.sourceHead ?? bundle.source?.head ?? null],
    ["notesTip", bundle.anchors?.notesTip ?? null],
  ].filter(([, oid]) => Boolean(oid));
  const confirmed = [];
  const unconfirmed = [];
  for (const [name, oid] of wanted) {
    const refs = refsByOid.get(oid);
    if (refs) confirmed.push({ anchor: name, oid, refs });
    else unconfirmed.push({ anchor: name, oid, reason: "not-a-ref-tip-on-the-chosen-remote" });
  }
  const roots = bundle.anchors?.lineageRoots ?? [];
  return {
    channel: "ls-remote",
    remote,
    available: true,
    reason: null,
    confirmed,
    unconfirmed,
    // Root commits are history, not ref tips; a verifier that wants them
    // anchored needs objects, which is the repository-backed path.
    lineageRoots: { count: roots.length, supplied: false, reason: "root-commits-are-not-ref-tips" },
    anchored: wanted.length > 0 && unconfirmed.length === 0,
  };
}

export function verifyProofBundle(bundle, repository = null, anchors = null) {
  assertProofBundleDocument(bundle);
  const binding = bundle.schema === PROOF_BUNDLE_SCHEMA
    ? verifyBindings(bundle)
    : {
        checked: false,
        reason: "not-carried",
        problems: [],
        agrees: false,
        coverage: [],
        receipts: [],
      };
  const tier = conclusionTier(binding, anchors);
  const provenByBinding = new Map(
    (binding.coverage ?? []).map((entry) => [entry.commit, entry]),
  );
  const unavailable = [
    ...UNAVAILABLE_WITHOUT_OBJECTS,
    ...(anchors?.anchored ? [] : [ANCHORS_NOT_CURRENT]),
    ...(binding.checked ? [] : [
      {
        conclusion: "source-inventory-is-complete",
        reason:
          "A v1 bundle carries no Git objects, so a verifier without the repository " +
          "cannot tell an omitted change from a change that never existed.",
      },
      {
        conclusion: "coverage-rests-on-reachable-commits",
        reason:
          "Without carried reachability paths, a coverage claim is only as good as " +
          "the evidence list the sender chose to state.",
      },
    ]),
  ];
  const expected = bundle.integrity?.bundleHash ?? null;
  const actual = bundleHash(bundle);
  const indexed = indexEvidence(bundle.evidence ?? {});
  const counts = classificationCounts(bundle.changes);
  const countsAgree = canonicalJson(bundle.counts) === canonicalJson(counts);
  const uniqueCommits = new Set(bundle.changes.map((change) => change.commit)).size === bundle.changes.length;
  const disagreements = [];
  for (const change of bundle.changes ?? []) {
    const recomputed = classifyFromEvidence(change, indexed);
    if (recomputed.status !== change.status || recomputed.proof !== change.proof) {
      disagreements.push({
        commit: change.commit,
        changeId: change.changeId,
        claimed: { status: change.status, proof: change.proof },
        recomputed: { status: recomputed.status, proof: recomputed.proof },
      });
    }
  }
  return {
    schema: "vcs-lab.proof-verification/v1",
    bundleSchema: bundle.schema,
    integrity: {
      algorithm: bundle.integrity?.algorithm ?? null,
      claimed: expected,
      computed: actual,
      intact: expected === actual,
    },
    classification: {
      changes: (bundle.changes ?? []).length,
      reproduced: (bundle.changes ?? []).length - disagreements.length,
      disagreements,
      counts: { claimed: bundle.counts, recomputed: counts, agrees: countsAgree },
      uniqueCommits,
      agrees: disagreements.length === 0 && countsAgree && uniqueCommits,
    },
    repository: repository ?? { checked: false, reason: "not-requested", matches: null },
    binding,
    anchors: anchors ?? { channel: "none", confirmed: [], unconfirmed: [], anchored: false },
    tier,
    changes: (bundle.changes ?? []).map((change) => {
      const proof = provenByBinding.get(change.commit);
      const proven = Boolean(proof?.proven);
      return {
        commit: change.commit,
        status: change.status,
        proof: change.proof,
        proven,
        // A change is only ever at the report's tier when its own claim was
        // bound; an unproven claim stays where v1 left it.
        tier: proven ? tier : "self-consistent",
      };
    }),
    unavailable,
    trust: {
      evidenceCheckedAgainstRepository: Boolean(repository?.checked),
      statement: repository?.checked
        ? "The classification was recomputed from the bundle's evidence, and " +
          "the evidence, complete source inventory, identities, subjects, counts, " +
          "and physical/effective bases were compared with the repository."
        : "Recomputing the classification from the bundle's own evidence proves " +
          "the plan follows from what it states, not that the evidence is true. " +
          "Repository source completeness, commit identities, and bases were not checked.",
    },
    ok:
      expected === actual &&
      disagreements.length === 0 &&
      countsAgree &&
      uniqueCommits &&
      repository?.matches !== false &&
      // A v2 bundle promises bindings; carrying ones that do not hold is a
      // failure, not a lower tier. A v1 bundle promises none, so its absence
      // is reported in `unavailable` and does not fail the check.
      (!binding.checked || binding.agrees),
  };
}
