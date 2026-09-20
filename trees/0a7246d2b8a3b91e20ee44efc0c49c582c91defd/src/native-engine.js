import { createRequire } from "node:module";
import path from "node:path";
import { realpathSync } from "node:fs";

const require = createRequire(import.meta.url);

/** Optional local prebuild. Loading never downloads or compiles code. */
export function loadNativeEngine(load = require) {
  const unavailable = (reason) => Object.freeze({
    available: false, reason, profile: null, operations: Object.freeze({}),
  });
  if (process.env.VLAB_TEST_NATIVE_BINDING === "missing") return unavailable("binding-missing");
  let binding;
  try {
    binding = load(`../native/prebuilds/${process.platform}-${process.arch}/vlab-core.node`);
    if (binding.profileVersion?.() !== 1 || ["repoContext", "listRefs", "readObjects", "listNoteEntries"]
      .some((operation) => typeof binding[operation] !== "function")) {
      return unavailable("binding-incompatible");
    }
  } catch (error) {
    return unavailable(error.code === "MODULE_NOT_FOUND" ? "binding-missing" : "binding-load-error");
  }
  const cwd = (value = process.cwd()) => path.resolve(value);
  const context = (directory) => {
    const resolved = cwd(directory);
    if (resolved.startsWith("\\\\") || realpathSync.native(resolved) !== resolved) {
      throw new Error("unsupported aliased repository path");
    }
    const result = binding.repoContext(resolved);
    for (const key of ["gitDir", "commonDir"]) {
      if (!path.isAbsolute(result[key])) throw new Error("unsupported relative Git directory");
      const normalized = path.resolve(result[key]);
      if (normalized.startsWith("\\\\") || realpathSync.native(normalized) !== normalized) {
        throw new Error("unsupported aliased Git directory");
      }
      result[key] = normalized;
    }
    return result;
  };
  const objects = (expressions, directory, contents) => {
    if (!Array.isArray(expressions) || expressions.length === 0) return [];
    return binding.readObjects(expressions, cwd(directory), contents).map((record) => ({
      expression: record.expression,
      exists: record.exists,
      oid: record.oid ?? null,
      type: record.kind ?? null,
      size: record.size,
      ...(contents ? { content: record.content ?? null } : {}),
    }));
  };
  return Object.freeze({
    available: true,
    reason: null,
    profile: "files-sha1-resolution-v1",
    operations: Object.freeze({
      repoContext: context,
      listRefs: (pattern, directory) => binding.listRefs(pattern, cwd(directory))
        .map(({ name, oid }) => ({ ref: name, oid })),
      inspectGitObjects: (expressions, directory) => objects(expressions, directory, false),
      readGitObjects: (expressions, directory) => objects(expressions, directory, true),
      listNoteEntries: (ref, directory) => binding.listNoteEntries(ref, cwd(directory)),
    }),
  });
}
