import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { deflateSync } from "node:zlib";
import { gitBlobId, newId, sha256, slug } from "./ids.js";
import { runGit } from "./git.js";
import { pathInventory, readGitObjects, repoContext } from "./engine.js";
import { readJson, temporaryDirectory } from "./store.js";
import {
  readPendingOperation,
  writePendingOperation,
} from "./pending-operation.js";
import { CliError } from "./errors.js";
import { assertWithinBound } from "./schemas.js";

export const SPEC_PARSER = "stable-markdown-blocks/v1";
export const SPEC_MERGE_ALGORITHM = "stable-markdown-three-way/v1";
export const SPEC_MANIFEST_SCHEMA = "vcs-lab.spec-manifest/v3";
export const SPEC_ID_ALGORITHM = "artifact-semantic-key-sha256/v1";

export function normalizeMarkdown(text) {
  return String(text).replace(/\r\n?/g, "\n");
}

function splitLines(text) {
  return normalizeMarkdown(text).split("\n");
}

function blockContent(lines, start, endExclusive) {
  return lines.slice(start, endExclusive).join("\n").trimEnd();
}

function deterministicEntityId(artifactId, semanticKey) {
  return `ent_${sha256(`${artifactId}\0${semanticKey}`).slice(0, 24)}`;
}

function parseBlocks(text) {
  const lines = splitLines(text);
  const headings = [];
  const occurrence = new Map();
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(#{1,6})\s+(.+?)\s*$/);
    if (!match) continue;
    const level = match[1].length;
    const title = match[2].replace(/\s+#+\s*$/, "").trim();
    const baseKey = `section:${level}:${slug(title)}`;
    const number = (occurrence.get(baseKey) ?? 0) + 1;
    occurrence.set(baseKey, number);
    headings.push({ index, level, title, semanticKey: `${baseKey}:${number}` });
  }

  const blocks = [];
  const firstHeading = headings[0]?.index ?? lines.length;
  const preamble = blockContent(lines, 0, firstHeading);
  if (preamble || headings.length === 0) {
    blocks.push({
      kind: "preamble",
      semanticKey: "preamble:1",
      title: "Preamble",
      level: null,
      startLine: 1,
      endLine: Math.max(1, firstHeading),
      contentHash: sha256(preamble),
    });
  }

  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index];
    const endExclusive = headings[index + 1]?.index ?? lines.length;
    const content = blockContent(lines, heading.index, endExclusive);
    blocks.push({
      kind: "section",
      semanticKey: heading.semanticKey,
      title: heading.title,
      level: heading.level,
      startLine: heading.index + 1,
      endLine: Math.max(heading.index + 1, endExclusive),
      contentHash: sha256(content),
    });
  }

  const reqOccurrence = new Map();
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^\s*(REQ-[A-Za-z0-9._-]+)\s*:\s*(.+?)\s*$/);
    if (!match) continue;
    const requirement = match[1].toUpperCase();
    const number = (reqOccurrence.get(requirement) ?? 0) + 1;
    reqOccurrence.set(requirement, number);
    blocks.push({
      kind: "requirement",
      semanticKey: `requirement:${requirement}:${number}`,
      title: requirement,
      level: null,
      startLine: index + 1,
      endLine: index + 1,
      contentHash: sha256(lines[index].trim()),
    });
  }

  return blocks.sort((left, right) =>
    left.startLine - right.startLine || left.kind.localeCompare(right.kind),
  );
}

function manifestOverrideMap(manifest) {
  const overrides = new Map(Object.entries(manifest?.idOverrides ?? {}));
  const artifactId = manifest?.artifactId;
  if (!artifactId) return overrides;
  for (const block of manifest?.blocks ?? []) {
    if (
      block?.semanticKey &&
      block?.id &&
      block.id !== deterministicEntityId(artifactId, block.semanticKey)
    ) {
      overrides.set(block.semanticKey, block.id);
    }
  }
  return overrides;
}

function materializeManifest(raw, storedManifest) {
  if (!storedManifest || typeof storedManifest !== "object") {
    throw new CliError("Specification manifest is missing or invalid.",
      { code: "malformed-input" });
  }
  if (
    ![
      "vcs-lab.spec-manifest/v1",
      "vcs-lab.spec-manifest/v2",
      SPEC_MANIFEST_SCHEMA,
    ].includes(storedManifest.schema)
  ) {
    throw new CliError(`Unsupported specification manifest '${storedManifest.schema}'.`,
      { code: "unknown-schema-version" });
  }
  if (!storedManifest.artifactId || !storedManifest.source) {
    throw new CliError("Specification manifest is missing artifact identity.",
      { code: "malformed-input" });
  }
  if (
    storedManifest.schema === SPEC_MANIFEST_SCHEMA &&
    (storedManifest.parser !== SPEC_PARSER ||
      storedManifest.idAlgorithm !== SPEC_ID_ALGORITHM)
  ) {
    throw new CliError("Specification manifest uses an unsupported parser or ID algorithm.",
      { code: "unknown-schema-version" });
  }
  const overrides = manifestOverrideMap(storedManifest);
  const canonical = normalizeMarkdown(raw);
  const blocks = parseBlocks(canonical).map((block) => ({
    id:
      overrides.get(block.semanticKey) ??
      deterministicEntityId(storedManifest.artifactId, block.semanticKey),
    ...block,
  }));
  return {
    ...storedManifest,
    schema: storedManifest.schema,
    sourceBytes: Buffer.byteLength(canonical),
    sourceLines: splitLines(canonical).length,
    entityCount: blocks.length,
    idAlgorithm: storedManifest.idAlgorithm ?? SPEC_ID_ALGORITHM,
    idOverrides: Object.fromEntries(
      [...overrides.entries()].sort(([left], [right]) => left.localeCompare(right)),
    ),
    blocks,
  };
}

function buildManifest(source, raw, options = {}) {
  const canonical = normalizeMarkdown(raw);
  const oldManifest = options.oldManifest ?? null;
  const artifactId = options.artifactId ?? oldManifest?.artifactId ?? newId("artifact");
  const priorIds = manifestOverrideMap(oldManifest);
  for (const block of oldManifest?.blocks ?? []) {
    priorIds.set(block.semanticKey, block.id);
  }
  for (const [semanticKey, id] of options.preferredIds ?? []) {
    priorIds.set(semanticKey, id);
  }
  const blocks = parseBlocks(canonical).map((block) => ({
    id:
      priorIds.get(block.semanticKey) ??
      deterministicEntityId(artifactId, block.semanticKey),
    ...block,
  }));
  const idOverrides = {};
  for (const block of blocks) {
    if (block.id !== deterministicEntityId(artifactId, block.semanticKey)) {
      idOverrides[block.semanticKey] = block.id;
    }
  }
  return {
    schema: SPEC_MANIFEST_SCHEMA,
    artifactId,
    source,
    sourceHash: sha256(canonical),
    sourceBlob: options.sourceBlob ?? null,
    sourceBytes: Buffer.byteLength(canonical),
    sourceLines: splitLines(canonical).length,
    entityCount: blocks.length,
    representation: "annotated-markdown",
    parser: SPEC_PARSER,
    idAlgorithm: SPEC_ID_ALGORITHM,
    idOverrides,
    blocks,
  };
}

export function serializeSpecManifest(manifest) {
  const stored = {
    schema: SPEC_MANIFEST_SCHEMA,
    artifactId: manifest.artifactId,
    source: manifest.source,
    sourceHash: manifest.sourceHash,
    ...(manifest.sourceBlob ? { sourceBlob: manifest.sourceBlob } : {}),
    entityCount: manifest.entityCount ?? manifest.blocks?.length ?? 0,
    representation: manifest.representation ?? "annotated-markdown",
    parser: manifest.parser ?? SPEC_PARSER,
    idAlgorithm: manifest.idAlgorithm ?? SPEC_ID_ALGORITHM,
    idOverrides: Object.fromEntries(
      Object.entries(manifest.idOverrides ?? {}).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
  };
  return `${JSON.stringify(stored, null, 2)}\n`;
}

function writeSpecManifest(file, manifest) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, serializeSpecManifest(manifest));
}

function manifestRelativePath(source) {
  return `.vcs-lab/specs/${source}.json`;
}

export function specFilesForConflictPaths(paths) {
  const files = new Set();
  for (const file of paths) {
    if (/\.md$/i.test(file)) files.add(file);
    const match = file.match(/^\.vcs-lab\/specs\/(.+\.md)\.json$/i);
    if (match) files.add(match[1]);
  }
  return [...files].sort();
}

function relativeSpecPath(file, context, cwd) {
  const absolute = path.resolve(cwd, file);
  const relative = path.relative(context.root, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new CliError("Specification must be inside the repository.",
      { code: "path-outside-repository" });
  }
  return relative.split(path.sep).join("/");
}

function manifestPathFromRelative(relative, context) {
  return path.join(context.root, ".vcs-lab", "specs", `${relative}.json`);
}

export function manifestPathFor(file, cwd = process.cwd()) {
  const context = repoContext(cwd);
  const relative = relativeSpecPath(file, context, cwd);
  return manifestPathFromRelative(relative, context);
}

function changesBetween(oldManifest, manifest) {
  const oldByKey = new Map(
    (oldManifest?.blocks ?? []).map((block) => [block.semanticKey, block]),
  );
  const newKeys = new Set(manifest.blocks.map((block) => block.semanticKey));
  const changes = {
    added: [],
    removed: [],
    changed: [],
    moved: [],
    unchanged: [],
  };
  for (const block of manifest.blocks) {
    const previous = oldByKey.get(block.semanticKey);
    if (!previous) {
      changes.added.push(block.id);
      continue;
    }
    if (previous.contentHash !== block.contentHash) changes.changed.push(block.id);
    if (previous.startLine !== block.startLine) changes.moved.push(block.id);
    if (
      previous.contentHash === block.contentHash &&
      previous.startLine === block.startLine
    ) {
      changes.unchanged.push(block.id);
    }
  }
  for (const previous of oldManifest?.blocks ?? []) {
    if (!newKeys.has(previous.semanticKey)) changes.removed.push(previous.id);
  }
  return changes;
}

function priorManifestView(storedManifest, currentRaw, cwd) {
  if (!storedManifest) return null;
  if (Array.isArray(storedManifest.blocks)) return storedManifest;
  let priorRaw = null;
  if (storedManifest.sourceBlob) {
    const object = readGitObjects([storedManifest.sourceBlob], cwd)[0];
    if (object.exists && object.type === "blob") {
      priorRaw = normalizeMarkdown(object.content.toString("utf8"));
    }
  } else {
    const candidates = readGitObjects(
      [`:${storedManifest.source}`, `HEAD:${storedManifest.source}`],
      cwd,
    );
    const matching = candidates.find(
      (object) =>
        object.exists &&
        object.type === "blob" &&
        sha256(normalizeMarkdown(object.content.toString("utf8"))) ===
          storedManifest.sourceHash,
    );
    if (matching) priorRaw = normalizeMarkdown(matching.content.toString("utf8"));
  }
  if (priorRaw === null && sha256(currentRaw) === storedManifest.sourceHash) {
    priorRaw = currentRaw;
  }
  if (priorRaw === null || sha256(priorRaw) !== storedManifest.sourceHash) {
    return { ...storedManifest, blocks: [] };
  }
  return materializeManifest(priorRaw, storedManifest);
}

function hashSpecBlob(relative, raw, context, options = {}) {
  if (options.sourceBlob !== undefined) return options.sourceBlob;
  if (options.writeBlob === false) return null;
  return runGit(["hash-object", "-w", `--path=${relative}`, "--stdin"], {
    cwd: context.root,
    input: raw,
  }).stdout;
}

function unchangedChanges(manifest) {
  return {
    added: [],
    removed: [],
    changed: [],
    moved: [],
    unchanged: manifest.blocks?.map((block) => block.id) ?? [],
  };
}

function indexSpecWithContext(file, context, cwd, options = {}) {
  const absolute = path.resolve(cwd, file);
  if (!fs.existsSync(absolute)) throw new CliError(`Spec not found: ${file}`,
    { code: "not-found" });
  const relative = relativeSpecPath(file, context, cwd);
  const manifestPath = manifestPathFromRelative(relative, context);
  const storedManifest = readJson(manifestPath, null);

  if (
    !options.force &&
    options.lazy &&
    options.sourceBlob &&
    storedManifest?.schema === SPEC_MANIFEST_SCHEMA &&
    storedManifest?.parser === SPEC_PARSER &&
    storedManifest?.idAlgorithm === SPEC_ID_ALGORITHM &&
    storedManifest?.sourceBlob === options.sourceBlob
  ) {
    const entityCount = storedManifest.entityCount ?? 0;
    return {
      manifestPath,
      manifest: storedManifest,
      changes: unchangedChanges(storedManifest),
      changeCounts: { added: 0, removed: 0, changed: 0, moved: 0, unchanged: entityCount },
      entityCount,
      cacheHit: true,
      cacheMode: "git-index-blob",
      contentRead: false,
      written: false,
    };
  }

  const raw = normalizeMarkdown(fs.readFileSync(absolute, "utf8"));
  const sourceHash = sha256(raw);
  if (
    !options.force &&
    storedManifest?.schema === SPEC_MANIFEST_SCHEMA &&
    storedManifest?.parser === SPEC_PARSER &&
    storedManifest?.idAlgorithm === SPEC_ID_ALGORITHM &&
    storedManifest?.sourceHash === sourceHash
  ) {
    const manifest = materializeManifest(raw, storedManifest);
    return {
      manifestPath,
      manifest,
      changes: unchangedChanges(manifest),
      entityCount: manifest.entityCount,
      cacheHit: true,
      cacheMode: "source-hash",
      contentRead: true,
      written: false,
    };
  }

  const oldManifest = priorManifestView(storedManifest, raw, cwd);
  const sourceBlob = hashSpecBlob(relative, raw, context, options);
  const manifest = buildManifest(relative, raw, { oldManifest, sourceBlob });
  const changes = changesBetween(oldManifest, manifest);
  writeSpecManifest(manifestPath, manifest);
  return {
    manifestPath,
    manifest,
    changes,
    entityCount: manifest.entityCount,
    cacheHit: false,
    cacheMode: null,
    contentRead: true,
    migratedFrom: storedManifest?.schema && storedManifest.schema !== SPEC_MANIFEST_SCHEMA
      ? storedManifest.schema
      : null,
    written: true,
  };
}

export function indexSpec(file, cwd = process.cwd(), options = {}) {
  const context = repoContext(cwd);
  return indexSpecWithContext(file, context, cwd, options);
}

function markdownInventory(cwd) {
  const files = new Set();
  const blobs = new Map();
  const dirty = new Set();
  for (const entry of pathInventory(["*.md"], cwd)) {
    files.add(entry.path);
    if (entry.tag === "?") {
      dirty.add(entry.path);
      continue;
    }
    if (entry.stage === 0) blobs.set(entry.path, entry.blob);
    if (entry.tag !== "H") dirty.add(entry.path);
  }
  return {
    files: [...files]
      .filter((file) => fs.existsSync(path.join(cwd, file)))
      .sort(),
    blobs,
    dirty,
  };
}

function hashWorkingTreeSpecs(files, context) {
  if (files.length === 0) return new Map();
  if (files.some((file) => /[\r\n]/.test(file))) {
    throw new CliError("Specification paths containing newlines are not supported.",
      { code: "unsafe-input" });
  }
  const output = runGit(["hash-object", "-w", "--stdin-paths"], {
    cwd: context.root,
    input: `${files.join("\n")}\n`,
    trim: false,
  }).stdout.split(/\r?\n/).filter(Boolean);
  if (output.length !== files.length) {
    throw new CliError("Git did not return a blob identity for every specification.",
      { code: "git-response-malformed" });
  }
  return new Map(files.map((file, index) => [file, output[index]]));
}

function changeCount(result, name) {
  return result.changeCounts?.[name] ?? result.changes[name].length;
}

function summarizeIndexResults(results, durationMs) {
  return {
    files: results.length,
    cacheHits: results.filter((result) => result.cacheHit).length,
    manifestsWritten: results.filter((result) => result.written).length,
    blocks: results.reduce((total, result) => total + result.entityCount, 0),
    contentReads: results.filter((result) => result.contentRead).length,
    blobCacheHits: results.filter(
      (result) => result.cacheMode === "git-index-blob",
    ).length,
    changes: results.reduce(
      (summary, result) => {
        for (const name of ["added", "removed", "changed", "moved", "unchanged"]) {
          summary[name] += changeCount(result, name);
        }
        return summary;
      },
      { added: 0, removed: 0, changed: 0, moved: 0, unchanged: 0 },
    ),
    durationMs: Number(durationMs.toFixed(2)),
  };
}

export function indexAllSpecs(cwd = process.cwd(), options = {}) {
  const totalStarted = performance.now();
  const context = repoContext(cwd);
  const inventory = markdownInventory(context.root);
  const files = inventory.files;
  const knownBlobs = new Map(
    files
      .filter((file) => inventory.blobs.has(file) && !inventory.dirty.has(file))
      .map((file) => [file, inventory.blobs.get(file)]),
  );
  const rebuild = files.filter((file) => {
    if (options.force) return true;
    const stored = readJson(manifestPathFromRelative(file, context), null);
    return !(
      stored?.schema === SPEC_MANIFEST_SCHEMA &&
      stored?.parser === SPEC_PARSER &&
      stored?.idAlgorithm === SPEC_ID_ALGORITHM &&
      stored?.sourceBlob &&
      stored.sourceBlob === knownBlobs.get(file)
    );
  });
  const workingBlobs = hashWorkingTreeSpecs(rebuild, context);
  const started = performance.now();
  const results = files.map((file) =>
    indexSpecWithContext(file, context, context.root, {
      ...options,
      lazy: true,
      sourceBlob: knownBlobs.get(file) ?? workingBlobs.get(file),
    }),
  );
  const summary = summarizeIndexResults(results, performance.now() - started);
  return {
    ...summary,
    preparationMs: Number((started - totalStarted).toFixed(2)),
    totalDurationMs: Number((performance.now() - totalStarted).toFixed(2)),
    results,
  };
}

export function readSpecManifest(file, cwd = process.cwd()) {
  const context = repoContext(cwd);
  const relative = relativeSpecPath(file, context, cwd);
  const manifestPath = manifestPathFor(file, cwd);
  const manifestStat = fs.statSync(manifestPath, { throwIfNoEntry: false });
  if (manifestStat) {
    assertWithinBound("specManifestBytes", manifestStat.size, `Spec manifest '${manifestPath}'`);
  }
  const storedManifest = readJson(manifestPath, null);
  if (!storedManifest) {
    throw new CliError(`No manifest exists for '${file}'. Run 'vlab spec index ${file}'.`,
      { code: "not-found" });
  }
  const absolute = path.join(context.root, relative);
  if (!fs.existsSync(absolute)) throw new CliError(`Spec not found: ${file}`,
    { code: "not-found" });
  const raw = normalizeMarkdown(fs.readFileSync(absolute, "utf8"));
  if (sha256(raw) !== storedManifest.sourceHash) {
    throw new CliError(`Spec manifest for '${file}' is stale.`, {
      code: "stale-manifest",
      details: `Re-index it with: vlab spec index ${file}`,
    });
  }
  return { manifestPath, manifest: materializeManifest(raw, storedManifest) };
}

function primaryBlocks(raw, manifest) {
  const lines = splitLines(raw);
  const primary = manifest.blocks
    .filter((block) => block.kind === "preamble" || block.kind === "section")
    .map((block) => {
      const content = blockContent(lines, block.startLine - 1, block.endLine);
      if (sha256(content) !== block.contentHash) {
        throw new CliError(
          `Spec manifest block '${block.id}' does not match '${manifest.source}'.`,
            { code: "malformed-input" },
        );
      }
      return { ...block, content };
    });
  if (
    !primary.some((block) => block.kind === "preamble") &&
    primary[0]?.startLine > 1
  ) {
    const content = blockContent(lines, 0, primary[0].startLine - 1);
    if (content) {
      primary.unshift({
        id: deterministicEntityId(manifest.artifactId, "preamble:1"),
        kind: "preamble",
        semanticKey: "preamble:1",
        title: "Preamble",
        level: null,
        startLine: 1,
        endLine: primary[0].startLine - 1,
        contentHash: sha256(content),
        content,
      });
    }
  }
  const ids = new Set();
  for (const block of primary) {
    if (ids.has(block.id)) {
      throw new CliError(`Spec manifest for '${manifest.source}' has duplicate block IDs.`,
        { code: "malformed-input" });
    }
    ids.add(block.id);
  }
  return primary;
}

function revisionStageFromObjects(file, revision, sourceObject, manifestObject) {
  const raw = sourceObject.exists
    ? normalizeMarkdown(sourceObject.content.toString("utf8"))
    : null;
  const manifestRaw = manifestObject.exists
    ? normalizeMarkdown(manifestObject.content.toString("utf8"))
    : null;
  if (raw === null) {
    return {
      revision,
      exists: false,
      raw: null,
      sourceHash: null,
      manifest: null,
      manifestHash: manifestRaw === null ? null : sha256(manifestRaw),
      blocks: [],
    };
  }
  if (manifestRaw === null) {
    throw new CliError(
      `No committed spec manifest exists for '${file}' at ${revision}.`,
      { code: "not-found", details: `Index and commit it with: vlab spec index ${file}` },
    );
  }
  assertWithinBound(
    "specManifestBytes",
    Buffer.byteLength(manifestRaw, "utf8"),
    `Spec manifest for '${file}' at ${revision}`,
  );
  let storedManifest;
  try {
    storedManifest = JSON.parse(manifestRaw);
  } catch {
    throw new CliError(`Spec manifest for '${file}' at ${revision} is invalid JSON.`,
      { code: "malformed-input" });
  }
  if (storedManifest.source !== file) {
    throw new CliError(`Spec manifest source does not match '${file}' at ${revision}.`,
      { code: "malformed-input" });
  }
  const normalizedHash = sha256(raw);
  const compatibleHashes = [normalizedHash];
  if (storedManifest.schema === "vcs-lab.spec-manifest/v1") {
    compatibleHashes.push(sha256(raw.replace(/\n/g, "\r\n")));
  }
  if (!compatibleHashes.includes(storedManifest.sourceHash)) {
    throw new CliError(`Spec manifest for '${file}' is stale at ${revision}.`, {
      code: "stale-manifest",
      details: `Re-index and commit it with: vlab spec index ${file}`,
    });
  }
  const manifest = materializeManifest(raw, storedManifest);
  return {
    revision,
    exists: true,
    raw,
    sourceHash: normalizedHash,
    manifest,
    manifestHash: sha256(manifestRaw),
    blocks: primaryBlocks(raw, manifest),
  };
}

function revisionStages(file, revisions, cwd) {
  const manifestFile = manifestRelativePath(file);
  const expressions = revisions.flatMap((revision) => [
    `${revision}:${file}`,
    `${revision}:${manifestFile}`,
  ]);
  const objects = readGitObjects(expressions, cwd);
  return revisions.map((revision, index) =>
    revisionStageFromObjects(
      file,
      revision,
      objects[index * 2],
      objects[index * 2 + 1],
    ),
  );
}

function sameArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function contentDecision(id, base, ours, theirs) {
  const same = (left, right) => left?.contentHash === right?.contentHash;
  if (base) {
    if (!ours && !theirs) return { id, outcome: "deleted-both", block: null };
    if (!ours) {
      if (same(base, theirs)) return { id, outcome: "deleted-ours", block: null };
      return {
        id,
        outcome: "conflict",
        conflict: "delete-vs-edit",
        deletedBy: "ours",
        block: null,
      };
    }
    if (!theirs) {
      if (same(base, ours)) return { id, outcome: "deleted-theirs", block: null };
      return {
        id,
        outcome: "conflict",
        conflict: "delete-vs-edit",
        deletedBy: "theirs",
        block: null,
      };
    }
    const oursChanged = !same(base, ours);
    const theirsChanged = !same(base, theirs);
    if (!oursChanged && !theirsChanged) {
      return { id, outcome: "unchanged", block: ours };
    }
    if (oursChanged && !theirsChanged) {
      return { id, outcome: "ours-edit", block: ours };
    }
    if (!oursChanged && theirsChanged) {
      return { id, outcome: "theirs-edit", block: theirs };
    }
    if (same(ours, theirs)) {
      return { id, outcome: "identical-edit", block: ours };
    }
    return {
      id,
      outcome: "conflict",
      conflict: "same-block-edit",
      block: null,
    };
  }
  if (ours && theirs) {
    if (same(ours, theirs)) {
      return { id, outcome: "identical-add", block: ours };
    }
    return {
      id,
      outcome: "conflict",
      conflict: "same-block-concurrent-add",
      block: null,
    };
  }
  if (ours) return { id, outcome: "ours-add", block: ours };
  return { id, outcome: "theirs-add", block: theirs };
}

function orderAdded(stage, skeletonSet) {
  const groups = new Map();
  let anchor = "__start__";
  for (const block of stage.blocks) {
    if (skeletonSet.has(block.id)) {
      anchor = block.id;
      continue;
    }
    const items = groups.get(anchor) ?? [];
    items.push(block.id);
    groups.set(anchor, items);
  }
  return groups;
}

function addedAnchors(groups) {
  const anchors = new Map();
  for (const [anchor, ids] of groups) {
    for (const id of ids) anchors.set(id, anchor);
  }
  return anchors;
}

function mergeOrder(base, ours, theirs, chosen) {
  const chosenIds = new Set(chosen.keys());
  const baseIds = base.blocks.map((block) => block.id).filter((id) => chosenIds.has(id));
  const baseSet = new Set(baseIds);
  const oursProjection = ours.blocks
    .map((block) => block.id)
    .filter((id) => baseSet.has(id));
  const theirsProjection = theirs.blocks
    .map((block) => block.id)
    .filter((id) => baseSet.has(id));
  let skeleton;
  let orderDecision;
  if (sameArray(oursProjection, theirsProjection)) {
    skeleton = oursProjection;
    orderDecision = sameArray(baseIds, oursProjection)
      ? "unchanged"
      : "same-move";
  } else if (sameArray(oursProjection, baseIds)) {
    skeleton = theirsProjection;
    orderDecision = "theirs-move";
  } else if (sameArray(theirsProjection, baseIds)) {
    skeleton = oursProjection;
    orderDecision = "ours-move";
  } else {
    return {
      order: [],
      decision: "conflict",
      conflicts: [{ type: "conflicting-block-order" }],
    };
  }

  const skeletonSet = new Set(skeleton);
  const oursAdded = orderAdded(ours, skeletonSet);
  const theirsAdded = orderAdded(theirs, skeletonSet);
  const oursAnchors = addedAnchors(oursAdded);
  const theirsAnchors = addedAnchors(theirsAdded);
  for (const id of chosenIds) {
    if (baseSet.has(id)) continue;
    if (
      oursAnchors.has(id) &&
      theirsAnchors.has(id) &&
      oursAnchors.get(id) !== theirsAnchors.get(id)
    ) {
      return {
        order: [],
        decision: "conflict",
        conflicts: [{ type: "concurrent-add-placement", blockId: id }],
      };
    }
  }
  for (const anchor of new Set([...oursAdded.keys(), ...theirsAdded.keys()])) {
    const oursItems = (oursAdded.get(anchor) ?? []).filter((id) =>
      theirsAnchors.has(id),
    );
    const theirsItems = (theirsAdded.get(anchor) ?? []).filter((id) =>
      oursAnchors.has(id),
    );
    if (!sameArray(oursItems, theirsItems)) {
      return {
        order: [],
        decision: "conflict",
        conflicts: [{ type: "conflicting-added-block-order", anchor }],
      };
    }
  }
  const appendGroup = (output, anchor) => {
    const oursItems = oursAdded.get(anchor) ?? [];
    const theirsItems = theirsAdded.get(anchor) ?? [];
    for (const id of [...oursItems, ...theirsItems]) {
      if (chosenIds.has(id) && !output.includes(id)) output.push(id);
    }
  };
  const order = [];
  appendGroup(order, "__start__");
  for (const id of skeleton) {
    if (!order.includes(id)) order.push(id);
    appendGroup(order, id);
  }
  for (const id of chosenIds) {
    if (!order.includes(id)) order.push(id);
  }
  return { order, decision: orderDecision, conflicts: [] };
}

function decisionCounts(decisions) {
  const counts = {};
  for (const decision of decisions) {
    const key = decision.conflict ?? decision.outcome;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function stageFingerprint(stage) {
  return {
    exists: stage.exists,
    sourceHash: stage.sourceHash,
    manifestHash: stage.manifestHash,
  };
}

export function planSpecMerge(
  file,
  baseRevision,
  oursRevision,
  theirsRevision,
  cwd = process.cwd(),
) {
  const context = repoContext(cwd);
  const relative = relativeSpecPath(file, context, cwd);
  if (!/\.md$/i.test(relative)) {
    throw new CliError("Semantic spec merge currently supports Markdown files only.",
      { code: "unsupported-feature" });
  }
  const manifestFile = manifestRelativePath(relative);
  let base;
  let ours;
  let theirs;
  try {
    [base, ours, theirs] = revisionStages(
      relative,
      [baseRevision, oursRevision, theirsRevision],
      cwd,
    );
  } catch (error) {
    return {
      schema: "vcs-lab.spec-merge-plan/v1",
      algorithm: SPEC_MERGE_ALGORITHM,
      status: "blocked",
      file: relative,
      manifestFile,
      artifactId: null,
      signature: null,
      revisions: { base: baseRevision, ours: oursRevision, theirs: theirsRevision },
      base: null,
      ours: null,
      theirs: null,
      decisions: [],
      counts: { "semantic-metadata-unavailable": 1 },
      ordering: { decision: "not-evaluated", order: [] },
      conflicts: [
        {
          type: "semantic-metadata-unavailable",
          message: error.message,
        },
      ],
      result: null,
    };
  }
  const artifacts = new Set(
    [base, ours, theirs]
      .map((stage) => stage.manifest?.artifactId)
      .filter(Boolean),
  );
  if (artifacts.size !== 1) {
    return {
      schema: "vcs-lab.spec-merge-plan/v1",
      algorithm: SPEC_MERGE_ALGORITHM,
      status: "blocked",
      file: relative,
      manifestFile,
      artifactId: null,
      signature: null,
      base: stageFingerprint(base),
      ours: stageFingerprint(ours),
      theirs: stageFingerprint(theirs),
      decisions: [],
      counts: { "artifact-identity-mismatch": 1 },
      ordering: { decision: "not-evaluated" },
      conflicts: [{ type: "artifact-identity-mismatch" }],
      result: null,
    };
  }
  const artifactId = [...artifacts][0];
  const signature = `ssig_${sha256(JSON.stringify({
    algorithm: SPEC_MERGE_ALGORITHM,
    artifactId,
    base: stageFingerprint(base),
    ours: stageFingerprint(ours),
    theirs: stageFingerprint(theirs),
  }))}`;
  const byId = (stage) => new Map(stage.blocks.map((block) => [block.id, block]));
  const baseById = byId(base);
  const oursById = byId(ours);
  const theirsById = byId(theirs);
  const ids = new Set([...baseById.keys(), ...oursById.keys(), ...theirsById.keys()]);
  const decisions = [...ids].map((id) =>
    contentDecision(id, baseById.get(id), oursById.get(id), theirsById.get(id)),
  );
  const chosen = new Map(
    decisions.filter((decision) => decision.block).map((decision) => [decision.id, decision.block]),
  );
  const conflicts = decisions
    .filter((decision) => decision.conflict)
    .map((decision) => ({
      type: decision.conflict,
      blockId: decision.id,
      semanticKey:
        baseById.get(decision.id)?.semanticKey ??
        oursById.get(decision.id)?.semanticKey ??
        theirsById.get(decision.id)?.semanticKey ??
        null,
      title:
        baseById.get(decision.id)?.title ??
        oursById.get(decision.id)?.title ??
        theirsById.get(decision.id)?.title ??
        null,
      deletedBy: decision.deletedBy ?? null,
    }));
  const ordering = mergeOrder(base, ours, theirs, chosen);
  conflicts.push(...ordering.conflicts);
  const counts = decisionCounts(decisions);
  if (ordering.conflicts.length) {
    counts[ordering.conflicts[0].type] =
      (counts[ordering.conflicts[0].type] ?? 0) + 1;
  }

  let result = null;
  if (conflicts.length === 0) {
    const ordered = ordering.order.map((id) => chosen.get(id)).filter(Boolean);
    const deleted = ordered.length === 0 && (!ours.exists || !theirs.exists);
    if (deleted) {
      result = {
        deleted: true,
        markdown: null,
        manifest: null,
        markdownHash: null,
        manifestHash: null,
      };
    } else {
      const markdown = `${ordered.map((block) => block.content.trimEnd()).join("\n\n").trimEnd()}\n`;
      const preferredIdMap = new Map();
      for (const stage of [base, ours, theirs]) {
        for (const block of stage.manifest?.blocks ?? []) {
          if (!preferredIdMap.has(block.semanticKey)) {
            preferredIdMap.set(block.semanticKey, block.id);
          }
        }
      }
      for (const block of ordered) {
        preferredIdMap.set(block.semanticKey, block.id);
      }
      const manifest = buildManifest(relative, markdown, {
        artifactId,
        preferredIds: preferredIdMap,
        sourceBlob: gitBlobId(markdown, context.objectFormat),
      });
      const manifestText = serializeSpecManifest(manifest);
      result = {
        deleted: false,
        markdown,
        manifest,
        markdownHash: sha256(markdown),
        manifestHash: sha256(manifestText),
      };
    }
  }

  return {
    schema: "vcs-lab.spec-merge-plan/v1",
    algorithm: SPEC_MERGE_ALGORITHM,
    status: conflicts.length ? "blocked" : "clean",
    file: relative,
    manifestFile,
    artifactId,
    signature,
    revisions: { base: baseRevision, ours: oursRevision, theirs: theirsRevision },
    base: stageFingerprint(base),
    ours: stageFingerprint(ours),
    theirs: stageFingerprint(theirs),
    decisions: decisions.map(({ block, ...decision }) => decision),
    counts,
    ordering: { decision: ordering.decision, order: ordering.order },
    conflicts,
    result,
  };
}

export function materializeSpecMerge(plan, cwd = process.cwd()) {
  if (plan.status !== "clean" || !plan.result) {
    throw new CliError(`Spec merge for '${plan.file}' is not clean.`,
      { code: "manual-review-required" });
  }
  if (plan.result.deleted) {
    runGit(["rm", "--ignore-unmatch", "--", plan.file, plan.manifestFile], { cwd });
    return;
  }
  const markdownPath = path.resolve(cwd, plan.file);
  const manifestPath = path.resolve(cwd, plan.manifestFile);
  fs.mkdirSync(path.dirname(markdownPath), { recursive: true });
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(markdownPath, plan.result.markdown);
  writeSpecManifest(manifestPath, plan.result.manifest);
  runGit(["add", "--", plan.file, plan.manifestFile], { cwd });
}

export function compactSpecMerge(plan, selectionMethod = null) {
  return {
    path: plan.file,
    manifestPath: plan.manifestFile,
    signature: plan.signature,
    algorithm: plan.algorithm,
    status: plan.status,
    counts: plan.counts,
    ordering: plan.ordering.decision,
    conflicts: plan.conflicts,
    resultMarkdownHash: plan.result?.markdownHash ?? null,
    resultManifestHash: plan.result?.manifestHash ?? null,
    resolvedPaths: [plan.file, plan.manifestFile],
    selectionMethod,
  };
}

export function captureSpecMergeOutcomes(merges, cwd = process.cwd()) {
  const objects = readGitObjects(
    merges.flatMap((merge) => [`:${merge.path}`, `:${merge.manifestPath}`]),
    cwd,
  );
  return merges.map((merge, index) => {
    const markdownObject = objects[index * 2];
    const manifestObject = objects[index * 2 + 1];
    const markdown = markdownObject.exists
      ? normalizeMarkdown(markdownObject.content.toString("utf8"))
      : null;
    const manifest = manifestObject.exists
      ? normalizeMarkdown(manifestObject.content.toString("utf8"))
      : null;
    if ((markdown === null) !== (manifest === null)) {
      throw new CliError(
        `Staged spec '${merge.path}' and its manifest must be added or deleted together.`,
          { code: "precondition-not-met" },
      );
    }
    if (markdown !== null) {
      let storedManifest;
      try {
        storedManifest = JSON.parse(manifest);
      } catch {
        throw new CliError(`Staged manifest for '${merge.path}' is invalid JSON.`,
          { code: "malformed-input" });
      }
      if (
        storedManifest.source !== merge.path ||
        storedManifest.sourceHash !== sha256(markdown)
      ) {
        throw new CliError(`Staged manifest for '${merge.path}' is stale.`, {
          code: "stale-manifest",
          details: `Run 'vlab spec index ${merge.path}', stage both files, and continue again.`,
        });
      }
      const parsed = materializeManifest(markdown, storedManifest);
      primaryBlocks(markdown, parsed);
    }
    const actualMarkdownHash = markdown === null ? null : sha256(markdown);
    const actualManifestHash = manifest === null ? null : sha256(manifest);
    const accepted =
      actualMarkdownHash === merge.resultMarkdownHash &&
      actualManifestHash === merge.resultManifestHash;
    return {
      ...merge,
      decision: accepted ? "accepted" : "modified",
      actualMarkdownHash,
      actualManifestHash,
    };
  });
}

export function specMergePlansForOperation(operation, cwd = process.cwd()) {
  if (!operation?.current) return [];
  const markdown = specFilesForConflictPaths(
    operation.current.conflictedPaths ?? [],
  );
  return markdown.map((file) =>
    planSpecMerge(
      file,
      `${operation.current.sourceCommit}^`,
      operation.current.targetBefore,
      operation.current.sourceCommit,
      cwd,
    ),
  );
}

export function pendingSpecMergeStatus(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const operation = readPendingOperation(cwd);
  const plans = specMergePlansForOperation(operation, cwd);
  return {
    active: plans.length > 0,
    operationId: operation?.id ?? null,
    plans: plans.map((plan) => compactSpecMerge(plan)),
  };
}

export function applyPendingSpecMerges(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const operation = readPendingOperation(cwd);
  if (!operation?.current) {
    throw new CliError("No VCS Lab conflict is pending in this worktree.",
      { code: "nothing-pending" });
  }
  let plans = specMergePlansForOperation(operation, cwd);
  if (options.path) plans = plans.filter((plan) => plan.file === options.path);
  if (plans.length === 0) {
    throw new CliError("No semantic specification merge is pending.",
      { code: "nothing-pending" });
  }
  if (!options.all && !options.path && plans.length !== 1) {
    throw new CliError("Choose a spec path or pass --all.", { code: "ambiguous-match" });
  }
  if (!options.all && options.path && plans.length === 0) {
    throw new CliError(`'${options.path}' is not a pending spec conflict.`,
      { code: "no-match" });
  }
  const blocked = plans.filter((plan) => plan.status !== "clean");
  if (blocked.length) {
    throw new CliError("One or more spec merges require manual review.", {
      code: "manual-review-required",
      details: blocked
        .map((plan) => `${plan.file}: ${plan.conflicts.map((item) => item.type).join(", ")}`)
        .join("\n"),
    });
  }
  const applied = [];
  for (const plan of plans) {
    materializeSpecMerge(plan, cwd);
    applied.push(compactSpecMerge(plan, "explicit-spec-merge"));
  }
  operation.current.semanticMerges = [
    ...(operation.current.semanticMerges ?? []).filter(
      (existing) => !applied.some((item) => item.path === existing.path),
    ),
    ...applied,
  ];
  writePendingOperation(operation, cwd);
  return { operationId: operation.id, applied };
}

function corpusDocument(documentIndex, blocks) {
  const sections = [];
  for (let block = 0; block < blocks; block += 1) {
    sections.push(
      `## Capability ${documentIndex}-${block}\n\n` +
      `REQ-D${documentIndex}-B${block}: The capability must remain deterministic.\n\n` +
      `Generated design context for block ${block}.`,
    );
  }
  return `# Specification ${documentIndex}\n\n${sections.join("\n\n")}\n`;
}

export function benchmarkSpecIndex(options = {}) {
  const readSize = (value, fallback, name) => {
    const number = value === undefined ? fallback : Number(value);
    if (!Number.isInteger(number) || number < 1 || number > 1_000) {
      throw new CliError(`${name} must be an integer between 1 and 1000.`,
        { code: "usage-invalid-option-value" });
    }
    return number;
  };
  const documents = readSize(options.documents, 25, "--documents");
  const blocksPerDocument = readSize(options.blocks, 40, "--blocks");
  if (documents * blocksPerDocument > 100_000) {
    throw new CliError("The benchmark is limited to 100,000 generated blocks.",
      { code: "usage-invalid-option-value" });
  }
  const temporary = temporaryDirectory("vcs-lab-spec-benchmark-");
  try {
    runGit(["init", "-q", "-b", "main"], { cwd: temporary });
    const context = repoContext(temporary);
    const files = [];
    for (let index = 0; index < documents; index += 1) {
      const relative = `docs/generated-${index}.md`;
      const absolute = path.join(temporary, relative);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, corpusDocument(index, blocksPerDocument));
      files.push(relative);
    }
    const blobStarted = performance.now();
    const sourceBlobs = hashWorkingTreeSpecs(files, context);
    const initialPreparationMs = performance.now() - blobStarted;
    const run = (preparationMs = 0) => {
      const started = performance.now();
      const results = files.map((file) =>
        indexSpecWithContext(file, context, temporary, {
          lazy: true,
          sourceBlob: sourceBlobs.get(file),
        }),
      );
      const summary = summarizeIndexResults(results, performance.now() - started);
      return {
        results,
        summary: {
          ...summary,
          preparationMs: Number(preparationMs.toFixed(2)),
          totalDurationMs: Number((preparationMs + summary.durationMs).toFixed(2)),
        },
      };
    };
    const coldRun = run(initialPreparationMs);
    const cold = coldRun.summary;
    const unchanged = run().summary;
    const changedFile = files[Math.floor(files.length / 2)];
    const changedPath = path.join(temporary, changedFile);
    const original = fs.readFileSync(changedPath, "utf8");
    fs.writeFileSync(
      changedPath,
      original.replace(
        "The capability must remain deterministic.",
        "The capability must remain deterministic and auditable.",
      ),
    );
    const changedBlobStarted = performance.now();
    sourceBlobs.set(
      changedFile,
      hashWorkingTreeSpecs([changedFile], context).get(changedFile),
    );
    const oneBlockChanged = run(performance.now() - changedBlobStarted).summary;
    const sourceFiles = files.map((file) =>
      fs.readFileSync(path.join(temporary, file)),
    );
    const manifestFiles = files.map((file) =>
      fs.readFileSync(manifestPathFromRelative(file, context)),
    );
    const sourceBytes = sourceFiles.reduce((total, value) => total + value.length, 0);
    const manifestBytes = manifestFiles.reduce((total, value) => total + value.length, 0);
    const compressedSourceBytes = sourceFiles.reduce(
      (total, value) => total + deflateSync(value).length,
      0,
    );
    const compressedManifestBytes = manifestFiles.reduce(
      (total, value) => total + deflateSync(value).length,
      0,
    );
    const legacyV2Files = coldRun.results.map((result) => {
      const manifest = result.manifest;
      return Buffer.from(`${JSON.stringify({
        schema: "vcs-lab.spec-manifest/v2",
        artifactId: manifest.artifactId,
        source: manifest.source,
        sourceHash: manifest.sourceHash,
        sourceBytes: manifest.sourceBytes,
        sourceLines: manifest.sourceLines,
        representation: manifest.representation,
        parser: manifest.parser,
        blocks: manifest.blocks,
      }, null, 2)}\n`);
    });
    const legacyV2EquivalentBytes = legacyV2Files.reduce(
      (total, value) => total + value.length,
      0,
    );
    const estimatedCompressedLegacyV2Bytes = legacyV2Files.reduce(
      (total, value) => total + deflateSync(value).length,
      0,
    );
    return {
      schema: "vcs-lab.spec-benchmark/v2",
      manifestSchema: SPEC_MANIFEST_SCHEMA,
      documents,
      blocksPerDocument,
      semanticEntities: cold.blocks,
      sourceBytes,
      manifestBytes,
      manifestToSourceRatio: Number((manifestBytes / sourceBytes).toFixed(3)),
      estimatedCompressedSourceBytes: compressedSourceBytes,
      estimatedCompressedManifestBytes: compressedManifestBytes,
      estimatedCompressedManifestToSourceRatio: Number(
        (compressedManifestBytes / compressedSourceBytes).toFixed(3),
      ),
      legacyV2EquivalentBytes,
      metadataReductionPercent: Number(
        ((1 - manifestBytes / legacyV2EquivalentBytes) * 100).toFixed(2),
      ),
      estimatedCompressedLegacyV2Bytes,
      estimatedCompressedMetadataReductionPercent: Number(
        ((1 - compressedManifestBytes / estimatedCompressedLegacyV2Bytes) * 100).toFixed(2),
      ),
      bytesPerEntity: Number((manifestBytes / cold.blocks).toFixed(2)),
      cold,
      unchanged,
      oneBlockChanged,
    };
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
