import { createHash } from "node:crypto";
import {
  ancestryPath,
  commitHistory,
  readGitObjects,
  refTarget,
  repoContext,
} from "./engine.js";
import { CliError } from "./errors.js";
import { validateNoteRecord } from "./schemas.js";

const NOTES_REF = "refs/notes/vcs-lab";

/**
 * The Git bindings a proof bundle carries so a verifier without the repository
 * can check what the sender claims (ADR-0031).
 *
 * Every binding here is a Git object id recomputed from raw object bytes. That
 * is the whole mechanism: a sender chooses what to put in a bundle, but it
 * cannot choose the id of a commit whose message it altered, so `changes`,
 * which is the sender's word in v1, becomes a claim that either reproduces
 * Git's own hashes or does not.
 *
 * Objects are carried once, in one map keyed by id, and the three structural
 * members reference them by id. A reachability path from the target head shares
 * its first commits with every other path, and one map is what keeps a bundle
 * proportional to history *depth* rather than to the number of claims.
 */

/** The object id of raw object bytes, under the repository's object format. */
export function gitObjectId(type, bytes, objectFormat = "sha1") {
  const content = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes));
  return createHash(objectFormat === "sha256" ? "sha256" : "sha1")
    .update(Buffer.from(`${type} ${content.length}\0`))
    .update(content)
    .digest("hex");
}

/**
 * The commit message of a raw commit object: everything after the first blank
 * line. Parsing the raw bytes rather than asking Git is the point — a verifier
 * has no repository, and the message is where the Change-Id and the subject a
 * classification depends on actually live.
 */
export function parseRawCommit(bytes) {
  const text = bytes.toString("utf8");
  const split = text.indexOf("\n\n");
  const header = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? "" : text.slice(split + 2);
  const parents = [...header.matchAll(/^parent ([0-9a-f]+)$/gm)].map((match) => match[1]);
  const tree = header.match(/^tree ([0-9a-f]+)$/m)?.[1] ?? null;
  const changeId = message.match(/^Change-Id:\s*(.+?)\s*$/im)?.[1]?.trim() ?? null;
  return {
    tree,
    parents,
    message,
    subject: message.split("\n")[0] ?? "",
    changeId,
  };
}

/** Entries of a raw tree object: `<mode> <name>\0<binary oid>` repeated. */
export function parseRawTree(bytes, objectFormat = "sha1") {
  const width = objectFormat === "sha256" ? 32 : 20;
  const entries = [];
  let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(0x20, offset);
    if (space === -1) break;
    const nul = bytes.indexOf(0x00, space);
    if (nul === -1 || nul + 1 + width > bytes.length) break;
    entries.push({
      mode: bytes.subarray(offset, space).toString("utf8"),
      name: bytes.subarray(space + 1, nul).toString("utf8"),
      oid: bytes.subarray(nul + 1, nul + 1 + width).toString("hex"),
    });
    offset = nul + 1 + width;
  }
  return entries;
}

/**
 * Read raw object bytes for several ids in one batched call, and refuse the
 * whole build if any is missing: a proof with a hole in it is not a proof, and
 * emitting one would hand a verifier a bundle that cannot reach the bound tier
 * for reasons the producer already knew about.
 */
function readRaw(oids, type, cwd) {
  const unique = [...new Set(oids)].filter(Boolean);
  if (unique.length === 0) return new Map();
  const objects = readGitObjects(unique, cwd);
  const carried = new Map();
  unique.forEach((oid, index) => {
    const object = objects[index];
    if (!object?.exists || object.type !== type) {
      throw new CliError(
        `Cannot bind the proof bundle: ${type} '${oid}' is missing from this repository.`,
        {
          code: "not-found",
          details: "A proof bundle carries Git objects; one that is absent cannot be proven.",
        },
      );
    }
    carried.set(oid, { type, base64: object.content.toString("base64") });
  });
  return carried;
}

/** Commits of `base..head`, oldest first, the order the change list uses. */
function rangeCommits(base, head, cwd) {
  return commitHistory([`${base}..${head}`], cwd, { reverse: true })
    .map((item) => item.commit);
}

/**
 * The shortest commit path from `from` down to `to`, as object ids ending at
 * `to`. `git rev-list --ancestry-path` gives the commits that lie on a path
 * between the two, and the first-parent-preferring walk below turns that set
 * into one concrete chain a verifier can follow link by link.
 *
 * Returns null when no path exists, which is not always a fault: a receipt
 * whose attachment was superseded from the same base is legitimately
 * unreachable, and the planner already ignores it.
 */
function commitPath(from, to, cwd) {
  if (from === to) return [to];
  const between = ancestryPath(from, to, cwd);
  if (between.length === 0) return null;
  const parentsOf = new Map(between.map((row) => [row.commit, row.parents]));
  // Breadth-first from `from`, so the carried chain is the shortest one and a
  // deep history costs the fewest objects.
  const queue = [[from]];
  const seen = new Set([from]);
  while (queue.length) {
    const chain = queue.shift();
    const tip = chain[chain.length - 1];
    if (tip === to) return chain;
    for (const parent of parentsOf.get(tip) ?? []) {
      if (seen.has(parent)) continue;
      seen.add(parent);
      queue.push([...chain, parent]);
    }
  }
  return null;
}

/**
 * The tree path from a notes commit to the blob holding `attachment`'s note,
 * as the tree object ids to carry. Git chooses its own fanout, so the path is
 * walked rather than computed from the attachment id.
 */
function notePath(notesTip, attachment, cwd) {
  const commit = readGitObjects([notesTip], cwd)[0];
  if (!commit?.exists || commit.type !== "commit") return null;
  const root = parseRawCommit(commit.content).tree;
  const context = repoContext(cwd);
  const trees = [];
  let current = root;
  let remaining = attachment;
  while (current) {
    trees.push(current);
    const tree = readGitObjects([current], cwd)[0];
    if (!tree?.exists || tree.type !== "tree") return null;
    const entries = parseRawTree(tree.content, context.objectFormat);
    const match = entries.find((entry) => remaining === entry.name || remaining.startsWith(entry.name));
    if (!match) return null;
    if (match.name === remaining) return { trees, blob: match.oid };
    remaining = remaining.slice(match.name.length);
    current = match.oid;
  }
  return null;
}

/**
 * Build the bound inventory, the reachability proofs, the receipt inclusion
 * proofs, and the anchors for one plan (ADR-0031 contract section).
 *
 * `plan` and `evidence` are the ones the bundle already carries, so the proofs
 * are built for exactly the claims the bundle makes rather than for a second
 * reading of the repository.
 */
export function buildBindings(plan, evidence, lineage, cwd = process.cwd()) {
  const context = repoContext(cwd);
  const objects = new Map();
  const absorb = (carried) => {
    for (const [oid, object] of carried) objects.set(oid, object);
  };

  // 1. The bound source inventory: every commit of the range the changes claim.
  const inventory = rangeCommits(plan.physicalBase, plan.sourceHead, cwd);
  absorb(readRaw(inventory, "commit", cwd));
  // Every parent of a carried commit must itself be carried or be the physical
  // base, so a verifier's walk never dead-ends. A merge brings in parents that
  // are outside `base..head` only when they are already ancestors of the base.
  const parents = new Set();
  for (const oid of inventory) {
    for (const parent of parseRawCommit(Buffer.from(objects.get(oid).base64, "base64")).parents) {
      if (!objects.has(parent)) parents.add(parent);
    }
  }
  absorb(readRaw([...parents], "commit", cwd));

  // 2. Reachability for every positive claim, and for the bases.
  const paths = [];
  const addPath = (claim, subject, to) => {
    if (!to) return;
    const chain = commitPath(plan.targetHead, to, cwd);
    if (!chain) return;
    absorb(readRaw(chain, "commit", cwd));
    paths.push({ claim, subject, from: plan.targetHead, to, commits: chain });
  };
  const receiptsById = new Map((evidence.receipts ?? []).map((receipt) => [receipt.id, receipt]));
  for (const change of plan.changes) {
    if (change.status !== "covered") continue;
    if (change.proof === "commit-ancestry") {
      addPath(change.proof, change.commit, change.commit);
      continue;
    }
    if (change.proof === "stable-change-id") {
      addPath(change.proof, change.commit, targetCommitCarrying(change.changeId, plan, cwd));
      continue;
    }
    // A receipt proof terminates at the receipt's attachment commit.
    for (const receipt of receiptsFor(change, receiptsById)) {
      addPath(change.proof, change.commit, receipt.attachedTo);
    }
  }
  addPath("physical-base-ancestry", plan.physicalBase, plan.physicalBase);
  if (plan.effectiveBase?.commit && plan.effectiveBase.commit !== plan.physicalBase) {
    const chain = commitPath(plan.sourceHead, plan.effectiveBase.commit, cwd);
    if (chain) {
      absorb(readRaw(chain, "commit", cwd));
      paths.push({
        claim: "effective-base",
        subject: plan.effectiveBase.commit,
        from: plan.sourceHead,
        to: plan.effectiveBase.commit,
        commits: chain,
      });
    }
  }

  // 3. Receipt inclusion, anchored to the notes tip only (owner decision 4).
  const notesTip = refTarget(NOTES_REF, cwd);
  const receipts = [];
  if (notesTip) {
    absorb(readRaw([notesTip], "commit", cwd));
    for (const receipt of evidence.receipts ?? []) {
      if (!receipt.attachedTo) continue;
      const located = notePath(notesTip, receipt.attachedTo, cwd);
      if (!located) continue;
      absorb(readRaw(located.trees, "tree", cwd));
      absorb(readRaw([located.blob], "blob", cwd));
      receipts.push({
        id: receipt.id,
        attachment: receipt.attachedTo,
        path: located.trees,
        blob: located.blob,
      });
    }
  }

  return {
    objects: Object.fromEntries([...objects].sort(([left], [right]) => left.localeCompare(right))),
    sourceInventory: { commits: inventory },
    reachability: { paths },
    receiptInclusion: { notesTip: notesTip ?? null, receipts },
    anchors: {
      targetHead: plan.targetHead,
      sourceHead: plan.sourceHead,
      notesTip: notesTip ?? null,
      lineageRoots: [...(lineage?.rootCommits ?? [])],
    },
  };
}

function receiptsFor(change, receiptsById) {
  const claimed = [...receiptsById.values()].filter((receipt) =>
    change.proof === "receipt-commit"
      ? (receipt.absorbedCommits ?? []).includes(change.commit)
      : (receipt.absorbedChanges ?? []).includes(change.changeId));
  return claimed;
}

/** The target commit whose message carries `changeId`, for a stable-id proof. */
function targetCommitCarrying(changeId, plan, cwd) {
  const history = commitHistory([plan.targetHead], cwd);
  for (const item of history) {
    const match = item.message.match(/^Change-Id:\s*(.+?)\s*$/im);
    if (match?.[1]?.trim() === changeId) return item.commit;
    if (`git:${item.commit}` === changeId) return item.commit;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/**
 * Check a bundle's carried bindings without a repository (ADR-0031 tier 1).
 *
 * Nothing here reads Git. Every conclusion is reached by recomputing object ids
 * from carried bytes and walking the links those bytes contain, which is why a
 * party that shares nothing with the producer can reach it.
 */
export function verifyBindings(bundle) {
  const problems = [];
  const objectFormat = bundle.repository?.lineage?.objectFormat === "sha256" ? "sha256" : "sha1";
  const carried = new Map();
  for (const [oid, object] of Object.entries(bundle.objects ?? {})) {
    if (!object || typeof object.base64 !== "string" || typeof object.type !== "string") {
      problems.push(`objects.${oid} is not a carried object`);
      continue;
    }
    const bytes = Buffer.from(object.base64, "base64");
    const recomputed = gitObjectId(object.type, bytes, objectFormat);
    if (recomputed !== oid) {
      problems.push(`objects.${oid} hashes to ${recomputed}, so its bytes are not the object it claims to be`);
      continue;
    }
    carried.set(oid, { type: object.type, bytes });
  }

  const commitAt = (oid) => {
    const object = carried.get(oid);
    if (!object || object.type !== "commit") return null;
    return parseRawCommit(object.bytes);
  };

  const inventory = verifyInventory(bundle, commitAt, problems);
  const coverage = verifyCoverage(bundle, carried, commitAt, problems);
  const receipts = verifyReceipts(bundle, carried, objectFormat, problems);
  const anchorsAgree = verifyStatedAnchors(bundle, problems);

  return {
    checked: true,
    objectFormat,
    objects: { carried: carried.size, declared: Object.keys(bundle.objects ?? {}).length },
    sourceInventory: inventory,
    coverage,
    receipts,
    anchorsAgree,
    problems,
    agrees: problems.length === 0,
  };
}

/**
 * The inventory is complete and correctly identified: the walk from the stated
 * source head reaches the stated physical base, enumerates exactly the change
 * list in its order, and every change's `changeId` and `subject` are the ones
 * its carried commit actually holds.
 */
function verifyInventory(bundle, commitAt, problems) {
  const claimed = (bundle.sourceInventory?.commits ?? []);
  const changes = (bundle.changes ?? []).map((change) => change.commit);
  const sameList = claimed.length === changes.length &&
    claimed.every((oid, index) => oid === changes[index]);
  if (!sameList) {
    problems.push("sourceInventory.commits does not enumerate the change list in its order");
  }

  // Walk parents from the source head, staying inside the claimed set, and
  // require the walk to reach the physical base.
  const inside = new Set(claimed);
  const visited = new Set();
  const queue = [bundle.source?.head].filter(Boolean);
  let reachesBase = false;
  while (queue.length) {
    const oid = queue.shift();
    if (visited.has(oid)) continue;
    visited.add(oid);
    if (oid === bundle.physicalBase) {
      reachesBase = true;
      continue;
    }
    const commit = commitAt(oid);
    if (!commit) {
      problems.push(`the inventory walk needs commit ${oid}, which is not carried`);
      continue;
    }
    for (const parent of commit.parents) queue.push(parent);
  }
  if (!reachesBase) {
    problems.push(`the inventory walk from ${bundle.source?.head} never reaches the physical base ${bundle.physicalBase}`);
  }
  const walked = new Set([...visited].filter((oid) => oid !== bundle.physicalBase));
  for (const oid of claimed) {
    if (!walked.has(oid)) problems.push(`inventory commit ${oid} is not reachable from the source head`);
  }
  for (const oid of walked) {
    if (!inside.has(oid) && oid !== bundle.source?.head) continue;
    if (!inside.has(oid)) problems.push(`commit ${oid} is in the range but not in the inventory`);
  }

  // Identity: the message a commit carries decides its Change-Id and subject.
  let identitiesAgree = true;
  for (const change of bundle.changes ?? []) {
    const commit = commitAt(change.commit);
    if (!commit) {
      problems.push(`change ${change.commit} carries no commit object`);
      identitiesAgree = false;
      continue;
    }
    const expected = commit.changeId ?? `git:${change.commit}`;
    if (change.changeId !== expected) {
      problems.push(`change ${change.commit} claims Change-Id '${change.changeId}' but its commit carries '${expected}'`);
      identitiesAgree = false;
    }
    if (change.subject !== commit.subject) {
      problems.push(`change ${change.commit} claims subject '${change.subject}' but its commit carries '${commit.subject}'`);
      identitiesAgree = false;
    }
  }

  return {
    commits: claimed.length,
    enumeratesChanges: sameList,
    reachesPhysicalBase: reachesBase,
    identitiesAgree,
    complete: sameList && reachesBase && identitiesAgree,
  };
}

/**
 * Every `covered` claim rests on a commit reachable from the stated target
 * head, by a path of carried commits whose links a verifier follows one by one.
 * A claim with no such path is reported unproven; that is the difference
 * between v1's "the plan follows from the stated evidence" and v2's "the stated
 * evidence is bound to Git".
 */
function verifyCoverage(bundle, carried, commitAt, problems) {
  const paths = bundle.reachability?.paths ?? [];
  const results = [];
  for (const change of bundle.changes ?? []) {
    if (change.status !== "covered") {
      results.push({ commit: change.commit, proof: change.proof, proven: false, reason: "not-a-positive-claim" });
      continue;
    }
    const candidates = paths.filter((entry) => entry.subject === change.commit);
    if (candidates.length === 0) {
      problems.push(`covered change ${change.commit} carries no reachability path from the target head`);
      results.push({ commit: change.commit, proof: change.proof, proven: false, reason: "no-carried-path" });
      continue;
    }
    const valid = candidates.some((entry) => pathHolds(entry, bundle, carried, commitAt, change, problems));
    if (!valid) {
      results.push({ commit: change.commit, proof: change.proof, proven: false, reason: "path-does-not-hold" });
      continue;
    }
    results.push({ commit: change.commit, proof: change.proof, proven: true, reason: null });
  }
  return results;
}

/**
 * One path holds when it starts at the target head, every link is a real parent
 * edge between carried commits, and its end actually carries the coverage the
 * proof names.
 */
function pathHolds(entry, bundle, carried, commitAt, change, problems) {
  if (entry.from !== bundle.target?.head) {
    problems.push(`a reachability path for ${change.commit} starts at ${entry.from}, not the target head`);
    return false;
  }
  const chain = entry.commits ?? [];
  if (chain.length === 0 || chain[0] !== entry.from || chain[chain.length - 1] !== entry.to) {
    problems.push(`a reachability path for ${change.commit} does not run from ${entry.from} to ${entry.to}`);
    return false;
  }
  for (let index = 0; index < chain.length - 1; index += 1) {
    const commit = commitAt(chain[index]);
    if (!commit) {
      problems.push(`reachability path commit ${chain[index]} is not carried`);
      return false;
    }
    if (!commit.parents.includes(chain[index + 1])) {
      problems.push(`${chain[index + 1]} is not a parent of ${chain[index]}, so the path is not a real chain`);
      return false;
    }
  }
  const end = commitAt(entry.to);
  if (!end) {
    problems.push(`reachability path end ${entry.to} is not carried`);
    return false;
  }
  if (change.proof === "commit-ancestry") return entry.to === change.commit;
  if (change.proof === "stable-change-id") {
    const carriedId = end.changeId ?? `git:${entry.to}`;
    if (carriedId !== change.changeId) {
      problems.push(`the target commit ${entry.to} does not carry Change-Id '${change.changeId}'`);
      return false;
    }
    return true;
  }
  // A receipt proof is completed by the inclusion proof, which is checked
  // separately; here the path must end at a receipt attachment the bundle
  // actually carries an inclusion proof for.
  const included = (bundle.receiptInclusion?.receipts ?? [])
    .some((receipt) => receipt.attachment === entry.to);
  if (!included) {
    problems.push(`the receipt attachment ${entry.to} carries no inclusion proof`);
    return false;
  }
  void carried;
  return true;
}

/**
 * Each receipt's content is what the stated notes tip holds: the tree path
 * recomputes, the blob parses as a note container, and the record validates
 * under its own schema before the lattice is allowed to rely on it.
 */
function verifyReceipts(bundle, carried, objectFormat, problems) {
  const notesTip = bundle.receiptInclusion?.notesTip ?? null;
  const results = [];
  for (const entry of bundle.receiptInclusion?.receipts ?? []) {
    const result = { id: entry.id, attachment: entry.attachment, included: false, validates: false, absorbs: false };
    const tip = carried.get(notesTip);
    if (!tip || tip.type !== "commit") {
      problems.push(`the notes tip ${notesTip} is not carried, so no receipt is included`);
      results.push(result);
      continue;
    }
    const root = parseRawCommit(tip.bytes).tree;
    if ((entry.path ?? [])[0] !== root) {
      problems.push(`the inclusion proof for ${entry.id} does not start at the notes tip tree`);
      results.push(result);
      continue;
    }
    // Walk the carried trees, requiring each to contain the next object.
    let ok = true;
    for (let index = 0; index < entry.path.length; index += 1) {
      const tree = carried.get(entry.path[index]);
      if (!tree || tree.type !== "tree") {
        problems.push(`inclusion tree ${entry.path[index]} for ${entry.id} is not carried`);
        ok = false;
        break;
      }
      const next = entry.path[index + 1] ?? entry.blob;
      if (!parseRawTree(tree.bytes, objectFormat).some((item) => item.oid === next)) {
        problems.push(`inclusion tree ${entry.path[index]} for ${entry.id} does not contain ${next}`);
        ok = false;
        break;
      }
    }
    if (!ok) {
      results.push(result);
      continue;
    }
    const blob = carried.get(entry.blob);
    if (!blob || blob.type !== "blob") {
      problems.push(`the note blob ${entry.blob} for ${entry.id} is not carried`);
      results.push(result);
      continue;
    }
    result.included = true;
    let container;
    try {
      container = JSON.parse(blob.bytes.toString("utf8"));
    } catch {
      problems.push(`the note blob for ${entry.id} is not valid JSON`);
      results.push(result);
      continue;
    }
    const record = (container?.records ?? []).find((item) => item?.id === entry.id);
    if (!record) {
      problems.push(`the note blob for ${entry.id} does not hold that record`);
      results.push(result);
      continue;
    }
    const errors = validateNoteRecord({ ...record, attachedTo: entry.attachment }, objectFormat);
    if (errors.length) {
      problems.push(`receipt ${entry.id} does not validate: ${errors.map((error) => error.field).join(", ")}`);
      results.push(result);
      continue;
    }
    result.validates = true;
    // The bundle's evidence must claim exactly what the carried record claims,
    // or the lattice was applied to a receipt nobody wrote.
    const claimed = (bundle.evidence?.receipts ?? []).find((item) => item.id === entry.id);
    const sameCommits = sameSet(claimed?.absorbedCommits, record.absorbedCommits);
    const sameChanges = sameSet(claimed?.absorbedChanges, record.absorbedChanges);
    if (!sameCommits || !sameChanges) {
      problems.push(`receipt ${entry.id} in the evidence does not match the record the notes tip holds`);
      results.push(result);
      continue;
    }
    result.absorbs = true;
    results.push(result);
  }
  return results;
}

function sameSet(left, right) {
  const first = [...(left ?? [])].sort();
  const second = [...(right ?? [])].sort();
  return first.length === second.length && first.every((value, index) => value === second[index]);
}

/**
 * The stated anchors must agree with the members they restate. A bundle whose
 * `anchors.targetHead` differs from `target.head` is stating two different
 * repositories to two different readers.
 */
function verifyStatedAnchors(bundle, problems) {
  const anchors = bundle.anchors ?? {};
  let agrees = true;
  const check = (name, stated, member) => {
    if (stated !== member) {
      problems.push(`anchors.${name} states ${stated} but the bundle's own member is ${member}`);
      agrees = false;
    }
  };
  check("targetHead", anchors.targetHead, bundle.target?.head);
  check("sourceHead", anchors.sourceHead, bundle.source?.head);
  check("notesTip", anchors.notesTip, bundle.receiptInclusion?.notesTip ?? null);
  if (!sameSet(anchors.lineageRoots, bundle.repository?.lineage?.rootCommits)) {
    problems.push("anchors.lineageRoots does not match the stated lineage");
    agrees = false;
  }
  return agrees;
}
