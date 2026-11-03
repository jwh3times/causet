import { runGit } from "./git.js";
import { inspectGitObjects, readGitObjects, repoContext } from "./engine.js";
import { referencedObjectsForRecord, validateNoteRecord } from "./schemas.js";
import { CliError } from "./errors.js";

export const RETENTION_REF = "refs/vcs-lab/retention";
export const DETERMINISTIC_CARRIER_ENV = {
  GIT_AUTHOR_NAME: "vcs-lab metadata envelope",
  GIT_AUTHOR_EMAIL: "metadata-envelope@example.invalid",
  GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
  GIT_COMMITTER_NAME: "vcs-lab metadata envelope",
  GIT_COMMITTER_EMAIL: "metadata-envelope@example.invalid",
  GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
};

function writeTree(entries, cwd) {
  return runGit(["mktree", "-z"], {
    cwd,
    input: Buffer.concat(entries.map(({ mode, type, oid, name }) => Buffer.concat([
      Buffer.from(`${mode} ${type} ${oid}\t`), Buffer.from(name), Buffer.from([0]),
    ]))),
  }).stdout;
}

// Read only the path being replaced. Preserve opaque names and non-note entries
// byte-for-byte, and accept Git's flat, fanned-out, and mixed notes trees.
function readTree(oid, cwd, oidBytes) {
  const [object] = readGitObjects([oid], cwd);
  if (!object.exists || object.type !== "tree") {
    throw new CliError("The notes tree is missing or malformed.", { code: "malformed-input" });
  }
  const entries = [];
  for (let offset = 0; offset < object.content.length;) {
    const space = object.content.indexOf(32, offset);
    const nul = object.content.indexOf(0, space + 1);
    if (space < offset || nul < space || nul + 1 + oidBytes > object.content.length) {
      throw new CliError("Git returned a malformed notes tree.", { code: "git-response-malformed" });
    }
    const mode = object.content.subarray(offset, space).toString("ascii");
    entries.push({
      mode, type: mode === "40000" ? "tree" : mode === "160000" ? "commit" : "blob",
      name: object.content.subarray(space + 1, nul),
      oid: object.content.subarray(nul + 1, nul + 1 + oidBytes).toString("hex"),
    });
    offset = nul + 1 + oidBytes;
  }
  return entries;
}

function replaceNote(tree, suffix, blob, cwd, oidBytes) {
  const entries = tree ? readTree(tree, cwd, oidBytes) : [];
  const exact = entries.find(entry => entry.name.toString("utf8") === suffix);
  const directory = entries.find(entry => entry.type === "tree" &&
    /^[0-9a-f]+$/.test(entry.name.toString("utf8")) &&
    entry.name.length < suffix.length && suffix.startsWith(entry.name.toString("utf8")));
  if (exact) {
    exact.oid = blob;
    exact.type = "blob";
    exact.mode = "100644";
  } else if (directory) {
    directory.oid = replaceNote(directory.oid, suffix.slice(directory.name.length), blob, cwd, oidBytes);
  } else {
    entries.push({ mode: "100644", type: "blob", name: Buffer.from(suffix), oid: blob });
  }
  return writeTree(entries, cwd);
}

export function commitWithParents(tree, parents, cwd, options = {}) {
  let layer = [...new Set(parents)].sort();
  const env = options.deterministic ? DETERMINISTIC_CARRIER_ENV : {};
  const commit = group => runGit(["commit-tree", tree, ...group.flatMap(oid => ["-p", oid]), "-F", "-"], {
    cwd, env, input: `${options.message ?? "vcs-lab object retention"}\n`,
  }).stdout;
  while (layer.length > 64) {
    const next = [];
    for (let index = 0; index < layer.length; index += 64) next.push(commit(layer.slice(index, index + 64)));
    layer = next;
  }
  return commit(layer);
}

export function buildNoteTree(note, attachment, previousTree, cwd) {
  const blob = runGit(["hash-object", "-w", "--stdin"], { cwd, input: `${JSON.stringify(note, null, 2)}\n` }).stdout;
  return replaceNote(previousTree, attachment, blob, cwd, attachment.length / 2);
}

export function buildNoteCommit(note, attachment, previous, cwd) {
  const tree = buildNoteTree(note, attachment, previous ? `${previous}^{tree}` : null, cwd);
  return commitWithParents(tree, previous ? [previous] : [], cwd, { message: "Publish vcs-lab causal note" });
}

/** All dependencies of accepted facts, including attachments and raw stage blobs. */
export function recordDependencies(entries, cwd, { validate = true } = {}) {
  const dependencies = new Map();
  const format = repoContext(cwd).objectFormat;
  for (const { attachment, record } of entries) {
    if (validate) {
      const errors = validateNoteRecord({ ...record, attachedTo: attachment }, format);
      if (errors.length) throw new CliError("Cannot publish an invalid causal record.", {
        code: "malformed-input", details: JSON.stringify(errors),
      });
    }
    for (const reference of [{ oid: attachment, type: "commit" }, ...referencedObjectsForRecord(record)]) {
      if (dependencies.has(reference.oid) && dependencies.get(reference.oid) !== reference.type) {
        throw new CliError("A causal record assigns incompatible types to one object.", { code: "malformed-input" });
      }
      dependencies.set(reference.oid, reference.type);
    }
  }
  if (validate && dependencies.size) {
    const expected = [...dependencies];
    const objects = inspectGitObjects(expected.map(([oid]) => oid), cwd);
    for (let index = 0; index < objects.length; index += 1) {
      const [oid, type] = expected[index];
      if (!objects[index].exists || objects[index].type !== type) {
        throw new CliError(`Required ${type} '${oid}' is missing or has the wrong type.`, { code: "integrity-check-failed" });
      }
    }
  }
  return dependencies;
}

export function buildRetentionCommit(dependencies, previous, cwd, options = {}) {
  const parents = previous ? [previous] : [];
  const directories = [];
  for (const type of ["blob", "tree"]) {
    const entries = [...dependencies].filter(([, kind]) => kind === type).sort().map(([oid]) => ({
      mode: type === "tree" ? "40000" : "100644", type, oid, name: oid,
    }));
    if (entries.length) directories.push({ mode: "40000", type: "tree", oid: writeTree(entries, cwd), name: `${type}s` });
  }
  for (const [oid, type] of dependencies) if (type === "commit") parents.push(oid);
  const tree = writeTree(directories, cwd);
  return commitWithParents(tree, parents, cwd, options);
}

export function checkedRefUpdate(ref, next, previous) {
  return previous ? `update ${ref} ${next} ${previous}` : `create ${ref} ${next}`;
}
