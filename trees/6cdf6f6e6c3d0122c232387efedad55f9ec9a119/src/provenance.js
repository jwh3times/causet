import { newId } from "./ids.js";
import { appendNote, readNotes } from "./notes.js";
import { CliError } from "./errors.js";
import { RESOURCE_BOUNDS, withinBound } from "./schemas.js";

export const PROVENANCE_SCHEMA = "vcs-lab.provenance/v1";

/**
 * The closed role vocabulary (FR-ID-08). A closed set is the point: an open
 * one cannot be reasoned about, and a consumer deciding what to do with
 * "co-authored" or "assisted" would be guessing at exactly the distinction
 * this record exists to state.
 *
 * The role carries the human/machine distinction, so no separate `kind` field
 * has to be inferred from an actor's name. `generated` is a claim that a
 * machine produced the content; `authored` is a claim that a person wrote it.
 */
export const PROVENANCE_ROLES = Object.freeze({
  authored: "a person wrote this content",
  generated: "a machine produced this content",
  reviewed: "an actor examined this content and accepted it",
});

/**
 * Environment variable an agent harness sets once so every commit it makes
 * carries attribution without the agent having to remember a flag. This is the
 * capture mechanism the requirement actually turns on: attribution that is not
 * recorded when the content is written cannot be recovered afterwards by any
 * store, so the cheap declaration at commit time is the whole game.
 */
export const AGENT_ENV = "VLAB_AGENT";

/**
 * Provenance is **declared, never inferred** (FR-TRUST-04). Nothing in this
 * module examines content to decide who produced it, and nothing reads
 * `Co-Authored-By` or any other trailer to guess a role: mapping an existing
 * trailer onto this vocabulary would be an inference dressed as a reading.
 * A record exists only because an actor said so, and it is an unauthenticated
 * claim by whoever ran the command — the FR-TRUST-01 discipline applied to a
 * second kind of claim. Signing it is FR-TRUST-02 and does not exist yet.
 */
function normalizeActors(actors) {
  const seen = new Map();
  for (const entry of actors ?? []) {
    const role = String(entry?.role ?? "").trim();
    const actor = String(entry?.actor ?? "").trim();
    if (!Object.hasOwn(PROVENANCE_ROLES, role)) {
      throw new CliError(
        `'${role}' is not a provenance role.`,
        {
          code: "invalid-identifier",
          details: `Roles are: ${Object.keys(PROVENANCE_ROLES).join(", ")}.`,
        },
      );
    }
    if (actor === "") {
      throw new CliError(`The '${role}' provenance role needs an actor name.`,
        { code: "invalid-identifier" });
    }
    // Deduplicate on the pair, so declaring the same actor twice in one
    // command and carrying the same actor from two absorbed commits both
    // collapse to one entry.
    // The separator is an explicit escape rather than a literal control
    // character: a role comes from the closed set above and cannot contain
    // one, so the pair is unambiguous, and the source file stays plain text.
    seen.set(`${role}\u0000${actor}`, { role, actor });
  }
  // Deterministic order, so the same declaration produces the same record
  // bytes regardless of flag order or note read order (FR-PLAN-06).
  return [...seen.values()].sort(
    (left, right) =>
      left.role.localeCompare(right.role) || left.actor.localeCompare(right.actor),
  );
}

/**
 * Collect declared actors from command options and the environment. Both are
 * merged rather than one overriding the other: a human committing an agent's
 * work under review is two actors on one commit, which is the case worth
 * representing.
 */
export function declaredActors(options = {}, env = process.env) {
  const actors = [];
  const flags = [
    ["authored", options.authoredBy],
    ["generated", options.generatedBy],
    ["reviewed", options.reviewedBy],
  ];
  for (const [role, value] of flags) {
    for (const actor of Array.isArray(value) ? value : value ? [value] : []) {
      actors.push({ role, actor });
    }
  }
  const agent = env?.[AGENT_ENV];
  if (typeof agent === "string" && agent.trim() !== "") {
    actors.push({ role: "generated", actor: agent.trim() });
  }
  return normalizeActors(actors);
}

function provenanceRecord(commit, changeId, actors, origin, carriedFrom) {
  if (!withinBound("provenanceActors", actors.length)) {
    throw new CliError(
      `A provenance record would carry ${actors.length} actors, over the ` +
      `provenanceActors bound of ${RESOURCE_BOUNDS.provenanceActors}.`,
      {
        code: "resource-bound-exceeded",
        details:
          "Provenance carried through a landing is the union of the absorbed " +
          "commits' actors; see docs/schemas/compatibility.md.",
      },
    );
  }
  return {
    schema: PROVENANCE_SCHEMA,
    type: "provenance",
    id: newId("prov"),
    commit,
    changeId: changeId ?? null,
    actors,
    origin,
    carriedFrom,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Attach a declared provenance record to a commit. Returns `null` when nothing
 * was declared: an absent record is the honest representation of "nobody said",
 * and writing an empty one would turn silence into a claim.
 */
export function declareProvenance(commit, changeId, actors, cwd = process.cwd()) {
  const normalized = normalizeActors(actors);
  if (normalized.length === 0) return null;
  const record = provenanceRecord(commit, changeId, normalized, "declared", []);
  appendNote(commit, record, cwd);
  return record;
}

/**
 * Every provenance record attached to each of `commits`, keyed by commit. One
 * batched note read serves the whole set (FR-PLAN-07).
 */
export function provenanceFor(commits, cwd = process.cwd()) {
  const found = new Map();
  const unique = [...new Set(commits.filter(Boolean))];
  if (unique.length === 0) return found;
  const notes = readNotes(unique, cwd);
  for (const commit of unique) {
    const records = (notes.get(commit)?.records ?? []).filter(
      (record) => record?.schema === PROVENANCE_SCHEMA,
    );
    if (records.length > 0) found.set(commit, records);
  }
  return found;
}

/**
 * Carry provenance from the commits a rewrite consumed onto the commit it
 * produced. This is the requirement's whole point: Git reconstructs line
 * attribution heuristically and loses it through the rewrites this tool exists
 * to perform, while every application and landing path here already records
 * which origin commits produced which result. That recorded correspondence,
 * not a diff heuristic, is what carries the claim.
 *
 * The result is marked `carried` and names its immediate sources. It is never
 * presented as a fresh declaration, and `carriedFrom` holds the immediate
 * sources rather than the whole chain, so a long rewrite history stays bounded
 * and each hop remains individually inspectable.
 */
export function carryProvenance(fromCommits, toCommit, changeId, cwd = process.cwd(), known = null) {
  const sources = [...new Set((fromCommits ?? []).filter(Boolean))].sort();
  // `known` lets a caller that already read the provenance of many commits
  // reuse that read. Without it, a publication loop would list the notes ref
  // once per application, which is the per-entity process amplification
  // ADR-0013 exists to prevent: six applications cost six extra Git processes
  // on Windows, ~30 ms each, purely to discover there is nothing to carry.
  const existing = known ?? provenanceFor(sources, cwd);
  if (existing.size === 0) return null;
  const actors = [];
  const carriedFrom = [];
  for (const commit of sources) {
    const records = existing.get(commit);
    if (!records) continue;
    carriedFrom.push(commit);
    for (const record of records) {
      for (const actor of record.actors ?? []) actors.push(actor);
    }
  }
  const normalized = normalizeActors(actors);
  if (normalized.length === 0) return null;
  const record = provenanceRecord(
    toCommit,
    changeId,
    normalized,
    "carried",
    carriedFrom,
  );
  appendNote(toCommit, record, cwd);
  return record;
}

/**
 * Carry provenance without letting a failure lose the operation. A rewrite has
 * already produced its commit and its causal receipt by the time provenance is
 * carried; refusing the whole operation because a note could not be extended
 * would trade a complete rewrite for a missing attribution. The failure is
 * returned so the caller can report it rather than swallowing it silently.
 */
export function carryProvenanceSafely(
  fromCommits, toCommit, changeId, cwd = process.cwd(), known = null,
) {
  try {
    return {
      record: carryProvenance(fromCommits, toCommit, changeId, cwd, known),
      error: null,
    };
  } catch (error) {
    return { record: null, error: error?.message ?? String(error) };
  }
}

/**
 * Carry provenance for a whole publication loop with one read of the notes
 * ref, rather than one per application. `applications` supplies each rewrite's
 * origin and result; the union of every origin is read once and each result
 * then draws from that single map.
 *
 * The writes stay per record — a note belongs to one commit — but the discovery
 * is bounded by the invocation rather than by the number of changes.
 */
export function carryProvenanceForApplications(applications, cwd = process.cwd()) {
  const entries = [...applications];
  if (entries.length === 0) return [];
  const origins = entries.map((entry) => entry.originCommit).filter(Boolean);
  const known = provenanceFor(origins, cwd);
  if (known.size === 0) return [];
  return entries.map((entry) =>
    carryProvenanceSafely(
      [entry.originCommit],
      entry.appliedCommit,
      entry.appliedChangeId,
      cwd,
      known,
    ),
  );
}

export function formatProvenance(entries) {
  if (entries.length === 0) {
    return "No provenance has been declared for the commits inspected.\n\n" +
      "Provenance is declared, never inferred: vcs-lab records only what an " +
      "actor stated with --authored-by, --generated-by, --reviewed-by, or " +
      `the ${AGENT_ENV} environment variable.`;
  }
  const lines = ["Declared provenance (unverified claims, not detection)"];
  for (const entry of entries) {
    const origin =
      entry.origin === "carried"
        ? `carried from ${entry.carriedFrom.map((c) => c.slice(0, 12)).join(", ")}`
        : "declared";
    lines.push(`${entry.commit.slice(0, 12)}  ${entry.subject}`);
    lines.push(`  ${entry.id}  ${origin}`);
    for (const actor of entry.actors) {
      lines.push(`    ${actor.role.padEnd(9)} ${actor.actor}`);
    }
  }
  return lines.join("\n");
}
