import { commitHistory, repoContext } from "./engine.js";
import { listNoteRecords } from "./notes.js";

export const IDENTITY_AUDIT_SCHEMA = "vcs-lab.identity-audit/v1";

const APPLICATION_TYPES = new Set(["application", "rebase-application"]);

/**
 * Every `Change-Id` trailer a commit message carries, in order. The planner's
 * reader takes the first and ignores the rest, which is the right behavior for
 * planning but hides a message that claims two identities; this audit is where
 * that becomes visible (FR-ID-06).
 */
export function changeIdTrailers(message) {
  const trailers = [];
  for (const line of String(message ?? "").split(/\r?\n/)) {
    const match = line.match(/^Change-Id:\s*(.+?)\s*$/i);
    if (match) trailers.push(match[1].trim());
  }
  return trailers;
}

/**
 * The identity-preserving application edges among `records`: each links an
 * origin commit to the commit a cherry-pick or causal rebase produced from it
 * under the same `Change-Id`. A fork deliberately changes the identity, so a
 * fork edge is not one of these. The edges are the identity model of
 * FR-ID-06: the audit unions them to find collisions, and the resolver of a
 * `ch_*` argument follows them to a change's origin
 * (docs/identity/README.md §5).
 */
export function identityPreservingEdges(records) {
  const edges = [];
  for (const record of records) {
    if (!APPLICATION_TYPES.has(record.type)) continue;
    const origin = record.originCommit;
    const applied = record.appliedCommit ?? record.attachedTo;
    if (!origin || !applied) continue;
    if (record.originChangeId && record.appliedChangeId &&
        record.originChangeId === record.appliedChangeId) {
      edges.push({ origin, applied });
    }
  }
  return edges;
}

/** Union-find over commits linked by identity-preserving application edges. */
function makeComponents() {
  const parent = new Map();
  const find = (node) => {
    if (!parent.has(node)) parent.set(node, node);
    let root = node;
    while (parent.get(root) !== root) root = parent.get(root);
    let cursor = node;
    while (parent.get(cursor) !== root) {
      const next = parent.get(cursor);
      parent.set(cursor, root);
      cursor = next;
    }
    return root;
  };
  return {
    find,
    union: (left, right) => {
      const a = find(left);
      const b = find(right);
      if (a !== b) parent.set(a, b);
    },
  };
}

function finding(code, severity, message, extra = {}) {
  return { code, severity, message, ...extra };
}

/**
 * Repository-wide identity audit (FR-ID-06). Answers three questions the
 * per-command paths cannot, because each of them looks at one plan:
 *
 * - does any commit message claim more than one logical identity?
 * - do commits share a `Change-Id` without any recorded derivation between
 *   them, which is a collision rather than the preserved identity of
 *   FR-ID-02?
 * - does any applied commit have more than one claimed origin, leaving its
 *   provenance ambiguous?
 *
 * It also checks the two identity invariants the application records are
 * supposed to maintain: a fork must diverge the identity (FR-ID-03) and a
 * non-fork must preserve it (FR-ID-02).
 *
 * Scope is every commit reachable from any ref, and every causal record in the
 * notes ref, rather than one plan's reachable set: a collision that a
 * particular plan cannot see is still a collision.
 */
export function auditIdentity(cwd = process.cwd()) {
  const context = repoContext(cwd);
  const commits = commitHistory(["--all"], cwd);
  const records = listNoteRecords(cwd);
  const applications = records.filter((record) =>
    APPLICATION_TYPES.has(record.type),
  );

  const findings = [];

  // 1. A commit message that claims two identities.
  const trailersByCommit = new Map();
  for (const commit of commits) {
    const trailers = changeIdTrailers(commit.message);
    trailersByCommit.set(commit.commit, trailers);
    const distinct = [...new Set(trailers)];
    if (distinct.length > 1) {
      findings.push(finding(
        "conflicting-change-id-trailer",
        "error",
        `Commit ${commit.commit} carries ${distinct.length} different Change-Id trailers; planning reads only the first.`,
        { commit: commit.commit, changeIds: distinct },
      ));
    }
  }

  // 2. Identity-preserving derivation links commits that legitimately share an
  //    ID. A fork deliberately changes the identity, so a fork edge must not
  //    link its endpoints here.
  const components = makeComponents();
  for (const edge of identityPreservingEdges(applications)) {
    components.union(edge.origin, edge.applied);
  }

  const commitsByChangeId = new Map();
  for (const commit of commits) {
    const trailers = trailersByCommit.get(commit.commit) ?? [];
    // A commit without a trailer has the `git:<oid>` fallback identity of
    // FR-ID-05, which is unique by construction and cannot collide.
    for (const changeId of new Set(trailers)) {
      if (!commitsByChangeId.has(changeId)) commitsByChangeId.set(changeId, []);
      commitsByChangeId.get(changeId).push(commit.commit);
    }
  }

  for (const [changeId, bearers] of [...commitsByChangeId].sort()) {
    if (bearers.length < 2) continue;
    const groups = new Map();
    for (const commit of bearers) {
      const root = components.find(commit);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push(commit);
    }
    if (groups.size > 1) {
      findings.push(finding(
        "change-id-collision",
        "error",
        `Change-Id ${changeId} is carried by ${bearers.length} commits in ` +
        `${groups.size} groups with no recorded derivation between them.`,
        {
          changeId,
          commits: [...bearers].sort(),
          unlinkedGroups: [...groups.values()].map((group) => [...group].sort()),
        },
      ));
    }
  }

  // 3. One applied commit, several claimed origins.
  const originsByApplied = new Map();
  for (const record of applications) {
    const applied = record.appliedCommit ?? record.attachedTo;
    if (!applied || !record.originCommit) continue;
    if (!originsByApplied.has(applied)) originsByApplied.set(applied, new Map());
    originsByApplied.get(applied).set(record.originCommit, record.id);
  }
  for (const [applied, origins] of [...originsByApplied].sort()) {
    if (origins.size < 2) continue;
    findings.push(finding(
      "ambiguous-origin",
      "error",
      `Commit ${applied} is claimed by ${origins.size} application records with different origins.`,
      {
        commit: applied,
        origins: [...origins.entries()]
          .map(([originCommit, recordId]) => ({ originCommit, recordId }))
          .sort((left, right) => left.originCommit.localeCompare(right.originCommit)),
      },
    ));
  }

  // 4/5. The identity invariants the records themselves are meant to hold.
  for (const record of applications) {
    if (!record.originChangeId || !record.appliedChangeId) continue;
    const forked = record.relation === "contextual-fork";
    if (forked && record.originChangeId === record.appliedChangeId) {
      findings.push(finding(
        "fork-without-new-identity",
        "error",
        `Record ${record.id} is a fork but keeps the origin Change-Id, which FR-ID-03 forbids.`,
        { recordId: record.id, changeId: record.originChangeId },
      ));
    }
    if (!forked && record.originChangeId !== record.appliedChangeId) {
      findings.push(finding(
        "identity-not-preserved",
        "error",
        `Record ${record.id} is a ${record.relation ?? "non-fork"} application but changed the Change-Id, which FR-ID-02 forbids.`,
        {
          recordId: record.id,
          originChangeId: record.originChangeId,
          appliedChangeId: record.appliedChangeId,
        },
      ));
    }
  }

  const errors = findings.filter((item) => item.severity === "error").length;
  const warnings = findings.filter((item) => item.severity === "warning").length;
  return {
    schema: IDENTITY_AUDIT_SCHEMA,
    repository: {
      root: context.root,
      objectFormat: context.objectFormat,
    },
    scanned: {
      commits: commits.length,
      changeIds: commitsByChangeId.size,
      applicationRecords: applications.length,
      causalRecords: records.length,
    },
    findings: findings.sort((left, right) =>
      left.code.localeCompare(right.code) || left.message.localeCompare(right.message),
    ),
    summary: {
      errors,
      warnings,
      collisions: findings.filter((item) => item.code === "change-id-collision").length,
      conflictingTrailers: findings.filter(
        (item) => item.code === "conflicting-change-id-trailer",
      ).length,
      ambiguousOrigins: findings.filter((item) => item.code === "ambiguous-origin").length,
      clean: errors === 0 && warnings === 0,
    },
  };
}
