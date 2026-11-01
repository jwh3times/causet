import { sha256 } from "./ids.js";
import { canonicalJson } from "./canonical-json.js";
import { CliError } from "./errors.js";
import { acceptedCausalRecords, repositoryLineage } from "./metadata.js";
import { recordsReachableFrom } from "./notes.js";
import { buildMergePlan, coverageEvidence } from "./merge-plan.js";
import { commitHistory, currentHead, isAncestor, mergeBase, resolveObjectIds } from "./engine.js";

export const PROOF_BUNDLE_SCHEMA = "vcs-lab.proof-bundle/v1";

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
  if (bundle.schema !== PROOF_BUNDLE_SCHEMA) {
    throw new CliError(
      `Not a ${PROOF_BUNDLE_SCHEMA} document (found ${JSON.stringify(bundle.schema ?? null)}).`,
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
  const bundle = {
    schema: PROOF_BUNDLE_SCHEMA,
    repository: {
      lineage: repositoryLineage(cwd),
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
  bundle.integrity = { algorithm: "sha256", bundleHash: bundleHash(bundle) };
  return bundle;
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
  const claimedLineage = bundle?.repository?.lineage ?? null;
  const actualLineage = repositoryLineage(cwd);
  if (claimedLineage?.id) {
    if (actualLineage?.id !== claimedLineage.id) {
      return {
        checked: false,
        reason: "different-repository",
        matches: null,
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
  const receipts = acceptedCausalRecords(
    recordsReachableFrom(head, cwd, actual.targetCommits).filter((record) =>
      ["landing", "reconciliation", "rebase"].includes(record.type),
    ),
    cwd,
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
    lineage: canonicalJson(claimedLineage) === canonicalJson(actualLineage),
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
export function verifyProofBundle(bundle, repository = null) {
  assertProofBundleDocument(bundle);
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
      repository?.matches !== false,
  };
}
