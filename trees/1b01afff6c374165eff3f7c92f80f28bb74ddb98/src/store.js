import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runGit } from "./git.js";
import { repoContext } from "./engine.js";
import { CliError } from "./errors.js";
import { assertWithinBound } from "./schemas.js";

/**
 * A fresh directory under the OS temporary root, returned in canonical form.
 * Windows may spell the temporary root as an 8.3 alias (`RUNNER~1`) while Git
 * reports every path it touches in long form, and vlab compares the two —
 * a specification inside a forecast worktree, a workspace path in the
 * registry. Resolving once here keeps every temporary repository, worktree,
 * and corpus vlab creates on the same spelling Git uses.
 */
export function temporaryDirectory(prefix) {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export function labRuntimeDir(cwd = process.cwd()) {
  const { commonDir } = repoContext(cwd);
  return path.join(commonDir, "vcs-lab");
}

export function ensureLabRuntime(cwd = process.cwd()) {
  const directory = labRuntimeDir(cwd);
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

export function initLab(cwd = process.cwd()) {
  const context = repoContext(cwd);
  ensureLabRuntime(cwd);

  runGit(["config", "notes.displayRef", "refs/notes/vcs-lab"], {
    cwd: context.root,
  });
  runGit(["config", "notes.rewriteRef", "refs/notes/vcs-lab"], {
    cwd: context.root,
  });

  return context;
}

/**
 * Read one worktree-private or shared-local JSON state file. This is the single
 * reader for every `<git dir>/vcs-lab/**` and `<common dir>/vcs-lab/**`
 * document, so it is where the `localStateBytes` resource bound is enforced
 * (ADR-0020): a file over the bound is refused before it is parsed, rather than
 * being loaded into memory first. Malformed content is refused as a domain
 * error naming the file instead of surfacing a bare `SyntaxError`.
 */
export function readJson(filePath, fallback) {
  let raw;
  try {
    const stat = fs.statSync(filePath);
    assertWithinBound("localStateBytes", stat.size, `Local state file '${filePath}'`);
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new CliError(`Local state file '${filePath}' is not valid JSON.`, {
      code: "malformed-input",
      details: "Recover or remove the file; vcs-lab will not guess its contents.",
    });
  }
}

export function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporary, filePath);
}
