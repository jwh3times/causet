import { spawnSync } from "node:child_process";
import { appendFileSync, readdirSync } from "node:fs";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { CliError } from "./errors.js";

const activeMetricCollectors = new Set();
const repositoryContextCache = new Map();
const activeObjectSessions = new Map();
const SESSION_INFO_BUFFER_BYTES = 1024 * 1024;
const SESSION_CONTENT_BUFFER_BYTES = 64 * 1024 * 1024;
const SESSION_TIMEOUT_MS = 60_000;
let nextSessionId = 1;

/**
 * Size of the shared response buffer for one session request. An `info`
 * response carries only headers; a `contents` response carries the objects
 * base64-encoded, so it gets a far larger buffer.
 *
 * Test hook: `VLAB_TEST_SESSION_BUFFER_BYTES` shrinks the buffer so the
 * overflow path can be exercised with a small fixture. Overflowing the real
 * content buffer needs a blob of roughly 48 MiB, which is too large to build
 * on every suite run, and the behaviour worth pinning is the fallback rather
 * than the threshold. The override is inert unless it parses as a positive
 * integer, so it cannot shrink a buffer in ordinary use.
 */
function sessionResponseBytes(command) {
  const override = Number(process.env.VLAB_TEST_SESSION_BUFFER_BYTES);
  if (Number.isInteger(override) && override > 0) return override;
  return command === "info" ? SESSION_INFO_BUFFER_BYTES : SESSION_CONTENT_BUFFER_BYTES;
}

/**
 * Marks a `runGit` call as one of this module's own read implementations.
 * The symbol is private, so a read that reaches `runGit` without it comes
 * from outside the engine seam (`src/engine.js`) and is counted as a direct
 * read; in native engine mode it is refused (ADR-0019).
 */
const ENGINE_READ = Symbol("vlab.engine-read");

/**
 * The read engines the seam can select. `git` is this module: one process
 * per query, or the object session. `native` is the phase 1 core of
 * ADR-0015; until its binding exists every operation passes through to Git
 * and records the fallback.
 */
export const READ_ENGINES = ["git", "native"];

let readEngineOverride = null;

export function defaultReadEngine() {
  return "git";
}

/**
 * Select the read engine. The environment variable mirrors
 * `VLAB_FORECAST_ENGINE`; the CLI sets it from `--engine`, and
 * `withReadEngine` overrides it for a differential comparison.
 */
export function readEngine() {
  if (readEngineOverride) return readEngineOverride;
  const value = process.env.VLAB_ENGINE;
  if (value === undefined || value === "") return defaultReadEngine();
  if (READ_ENGINES.includes(value)) return value;
  throw new CliError(
    `Unknown engine '${value}'. Use one of: ${READ_ENGINES.join(", ")}.`,
      { code: "usage-invalid-option-value" },
  );
}

/** Run `callback` with `engine` selected, restoring the previous selection. */
export function withReadEngine(engine, callback) {
  if (!READ_ENGINES.includes(engine)) {
    throw new CliError(
      `Unknown engine '${engine}'. Use one of: ${READ_ENGINES.join(", ")}.`,
        { code: "usage-invalid-option-value" },
    );
  }
  const previous = readEngineOverride;
  readEngineOverride = engine;
  try {
    return callback();
  } finally {
    readEngineOverride = previous;
  }
}

function sessionDiagnostic(event, details = {}) {
  if (process.env.VLAB_GIT_SESSION_DIAGNOSTICS !== "1") return;
  const line = `[vlab session] ${JSON.stringify({
    at: new Date().toISOString(),
    pid: process.pid,
    event,
    ...details,
  })}\n`;
  process.stderr.write(line);
  const filePath = process.env.VLAB_GIT_SESSION_DIAGNOSTICS_FILE;
  if (!filePath) return;
  try {
    appendFileSync(filePath, line, "utf8");
  } catch {
    // Diagnostics must never change session behavior.
  }
}

function diagnosticExpressions(expressions) {
  return expressions.length <= 8
    ? expressions
    : [...expressions.slice(0, 8), `... ${expressions.length - 8} more`];
}

function gitCommandName(args) {
  let commandIndex = 0;
  while (args[commandIndex] === "-c") commandIndex += 2;
  return args[commandIndex] ?? "unknown";
}

export function beginGitMetrics(label = "git") {
  const collector = { label, commands: [], fallbacks: [], directReads: 0 };
  activeMetricCollectors.add(collector);
  return collector;
}

function recordGitMetric(item) {
  for (const collector of activeMetricCollectors) {
    collector.commands.push(item);
  }
}

/**
 * Record that the engine seam answered `record.operation` with Git because
 * the selected engine could not (`record.reason`). Aggregated per operation
 * and reason by `endGitMetrics`.
 */
export function recordEngineFallback(record) {
  for (const collector of activeMetricCollectors) {
    collector.fallbacks.push(record);
  }
}

function recordDirectRead(command) {
  for (const collector of activeMetricCollectors) {
    collector.directReads += 1;
  }
  if (process.env.VLAB_TRACE === "1") {
    process.stderr.write(
      `[vlab trace] git ${command} was read outside the engine seam\n`,
    );
  }
}

function aggregateFallbacks(fallbacks) {
  const byKey = new Map();
  for (const item of fallbacks) {
    const key = `${item.operation}\0${item.reason}`;
    const current = byKey.get(key) ?? {
      operation: item.operation,
      reason: item.reason,
      count: 0,
    };
    current.count += 1;
    byKey.set(key, current);
  }
  return [...byKey.values()].sort(
    (left, right) =>
      left.operation.localeCompare(right.operation) ||
      left.reason.localeCompare(right.reason),
  );
}

function traceGitMetric(item) {
  if (process.env.VLAB_TRACE !== "1") return;
  const detail = item.cacheHit
    ? "cache hit"
    : item.transport === "session"
      ? item.processStarted
        ? "new persistent process"
        : "reused persistent process"
      : "new process";
  process.stderr.write(
    `[vlab trace] ${item.durationMs.toFixed(1)}ms git ${item.command} (${detail})\n`,
  );
}

function invalidateObjectSession(cwd) {
  activeObjectSessions.get(path.resolve(cwd))?.cache.clear();
}

const READ_ONLY_GIT_COMMANDS = new Set([
  "--version",
  "cat-file",
  "cherry",
  "diff",
  "for-each-ref",
  "log",
  "ls-files",
  "ls-tree",
  "merge-base",
  "rev-list",
  "rev-parse",
  "show",
  "show-ref",
  "status",
  "symbolic-ref",
]);

/**
 * Whether a Git invocation can change repository state. Read-only commands
 * neither invalidate the object session nor may run outside the engine seam;
 * everything else is a mutation and stays a plain `runGit` call.
 */
export function gitCommandMutates(args, command = gitCommandName(args)) {
  if (READ_ONLY_GIT_COMMANDS.has(command)) {
    // `symbolic-ref <name> <ref>` writes; vlab only ever reads one name.
    return command === "symbolic-ref" &&
      args.filter((item) => !item.startsWith("-")).length > 2;
  }
  if (command === "notes") {
    return !args.some((item) => ["list", "show"].includes(item));
  }
  if (command === "worktree") return !args.includes("list");
  if (command === "branch") {
    return !args.some((item) => ["--show-current", "--list"].includes(item));
  }
  if (command === "hash-object") return args.includes("-w");
  return true;
}

export function endGitMetrics(collector) {
  activeMetricCollectors.delete(collector);
  const byCommand = new Map();
  for (const item of collector.commands) {
    const current = byCommand.get(item.command) ?? {
      command: item.command,
      count: 0,
      processes: 0,
      sessionQueries: 0,
      cacheHits: 0,
      totalMs: 0,
      maxMs: 0,
    };
    current.count += 1;
    current.processes += item.processStarted ? 1 : 0;
    current.sessionQueries += item.transport === "session" ? 1 : 0;
    current.cacheHits += item.cacheHit ? 1 : 0;
    current.totalMs += item.durationMs;
    current.maxMs = Math.max(current.maxMs, item.durationMs);
    byCommand.set(item.command, current);
  }
  const totalMs = collector.commands.reduce(
    (total, item) => total + item.durationMs,
    0,
  );
  return {
    count: collector.commands.length,
    processes: collector.commands.filter((item) => item.processStarted).length,
    sessionQueries: collector.commands.filter(
      (item) => item.transport === "session",
    ).length,
    cacheHits: collector.commands.filter((item) => item.cacheHit).length,
    totalMs: Number(totalMs.toFixed(2)),
    failed: collector.commands.filter((item) => !item.ok).length,
    engine: readEngine(),
    fallbacks: aggregateFallbacks(collector.fallbacks),
    directReads: collector.directReads,
    byCommand: [...byCommand.values()]
      .map((item) => ({
        ...item,
        totalMs: Number(item.totalMs.toFixed(2)),
        maxMs: Number(item.maxMs.toFixed(2)),
      }))
      .sort((left, right) =>
        right.totalMs - left.totalMs || left.command.localeCompare(right.command),
      ),
  };
}

export function runGit(args, options = {}) {
  const {
    cwd = process.cwd(),
    env = {},
    input,
    allowFailure = false,
    trim = true,
    binary = false,
    maxBuffer = 256 * 1024 * 1024,
    rawProbe = false,
  } = options;

  const command = gitCommandName(args);
  if (!gitCommandMutates(args, command) && !options[ENGINE_READ] && !rawProbe) {
    // A read that did not come through the engine seam. `rawProbe` marks the
    // doctor's deliberate process-cost probes; nothing else may read here.
    recordDirectRead(command);
    if (readEngine() === "native") {
      throw new CliError(
        `git ${command} was read outside the engine seam; every Git read must be an operation of src/engine.js.`,
          { code: "internal-invariant" },
      );
    }
  }

  const startedAt = performance.now();
  sessionDiagnostic("git-spawn-start", {
    cwd,
    args,
    command,
  });
  const result = spawnSync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      ...env,
    },
    input,
    encoding: binary ? null : "utf8",
    maxBuffer,
    windowsHide: true,
  });

  if (result.error) {
    throw new CliError(`Could not run git: ${result.error.message}`,
      { code: "git-unavailable" });
  }

  const durationMs = performance.now() - startedAt;
  sessionDiagnostic("git-spawn-end", {
    cwd,
    args,
    command: gitCommandName(args),
    status: result.status,
    error: result.error?.message ?? null,
    durationMs: Number(durationMs.toFixed(3)),
  });
  const stdout = binary
    ? result.stdout
    : trim
      ? result.stdout.trim()
      : result.stdout;
  const stderr = binary
    ? result.stderr.toString("utf8").trim()
    : result.stderr.trim();
  const output = binary
    ? stderr
    : [stdout, stderr].filter(Boolean).join("\n");

  recordGitMetric({
    command,
    durationMs,
    ok: result.status === 0,
    transport: "spawn",
    processStarted: true,
    cacheHit: false,
  });

  traceGitMetric({
    command,
    durationMs,
    transport: "spawn",
    processStarted: true,
    cacheHit: false,
  });

  if (result.status === 0 && gitCommandMutates(args, command)) {
    invalidateObjectSession(cwd);
  }

  if (result.status !== 0 && !allowFailure) {
    throw new CliError(`git ${args.join(" ")} failed`, {
      code: "git-command-failed",
      details: output,
      exitCode: result.status || 1,
    });
  }

  return {
    ok: result.status === 0,
    status: result.status ?? 1,
    stdout,
    stderr,
    output,
    durationMs,
  };
}

function validateObjectExpressions(expressions) {
  for (const expression of expressions) {
    if (String(expression).includes("\n") || String(expression).includes("\r")) {
      throw new CliError("Git object expressions cannot contain newlines.",
        { code: "unsafe-input" });
    }
  }
}

function immutableObjectExpression(expression) {
  return /^[0-9a-f]{40,64}(?:\^\{(?:blob|commit|tag|tree)\})?(?::.*)?$/i.test(
    String(expression),
  );
}

class GitObjectSession {
  constructor(cwd) {
    this.cwd = cwd;
    this.sessionId = `${process.pid}-${nextSessionId++}`;
    this.nextRequestId = 1;
    this.cache = new Map();
    this.processCounted = false;
    this.closed = false;
    this.failed = false;
    this.worker = null;
    this.gitCommand = process.env.VLAB_TEST_GIT_SESSION_FAILURE === "1"
      ? "vlab-intentionally-missing-git"
      : "git";
    sessionDiagnostic("session-created", {
      sessionId: this.sessionId,
      cwd,
      gitCommand: this.gitCommand,
      workerStarted: false,
    });
  }

  startWorker() {
    if (this.worker) return this.worker;
    if (this.closed) {
      throw new CliError("The Git object session is already closed.",
        { code: "session-unavailable" });
    }
    sessionDiagnostic("worker-create-start", {
      sessionId: this.sessionId,
      cwd: this.cwd,
      gitCommand: this.gitCommand,
    });
    const worker = new Worker(new URL("./git-session-worker.js", import.meta.url), {
      workerData: {
        cwd: this.cwd,
        gitCommand: this.gitCommand,
      },
    });
    this.worker = worker;
    worker.on("error", (error) => {
      sessionDiagnostic("worker-error", {
        sessionId: this.sessionId,
        message: error.message,
        code: error.code ?? null,
      });
    });
    worker.on("exit", (code) => {
      sessionDiagnostic("worker-exit", {
        sessionId: this.sessionId,
        code,
      });
    });
    worker.unref();
    sessionDiagnostic("worker-create-complete", {
      sessionId: this.sessionId,
      cwd: this.cwd,
      gitCommand: this.gitCommand,
    });
    return worker;
  }

  request(command, expressions) {
    if (this.closed) {
      throw new CliError("The Git object session is already closed.",
        { code: "session-unavailable" });
    }
    validateObjectExpressions(expressions);
    const requestId = this.nextRequestId++;
    sessionDiagnostic("request-start", {
      sessionId: this.sessionId,
      requestId,
      command,
      expressions: diagnosticExpressions(expressions),
    });
    const cacheKeys = expressions.map((expression) =>
      immutableObjectExpression(expression)
        ? `${command}\0${expression}`
        : null,
    );
    const cached = cacheKeys.map((key) => key ? this.cache.get(key) : undefined);
    if (cached.every(Boolean)) {
      const started = performance.now();
      recordGitMetric({
        command: "object-cache",
        durationMs: performance.now() - started,
        ok: true,
        transport: "cache",
        processStarted: false,
        cacheHit: true,
      });
      traceGitMetric({
        command: "object-cache",
        durationMs: performance.now() - started,
        transport: "cache",
        processStarted: false,
        cacheHit: true,
      });
      sessionDiagnostic("request-cache-hit", {
        sessionId: this.sessionId,
        requestId,
        command,
        count: expressions.length,
      });
      return cached;
    }

    const missingIndexes = [];
    const missingExpressions = [];
    cached.forEach((value, index) => {
      if (value) return;
      missingIndexes.push(index);
      missingExpressions.push(expressions[index]);
    });
    const shared = new SharedArrayBuffer(16 + sessionResponseBytes(command));
    const header = new Int32Array(shared, 0, 4);
    const started = performance.now();
    const worker = this.startWorker();
    sessionDiagnostic("request-posting", {
      sessionId: this.sessionId,
      requestId,
      command,
      expressions: diagnosticExpressions(missingExpressions),
      cachedCount: expressions.length - missingExpressions.length,
    });
    try {
      worker.postMessage({
        type: "query",
        requestId,
        command,
        expressions: missingExpressions,
        shared,
      });
    } catch (error) {
      sessionDiagnostic("request-post-error", {
        sessionId: this.sessionId,
        requestId,
        command,
        message: error.message,
      });
      throw error;
    }
    sessionDiagnostic("request-posted", {
      sessionId: this.sessionId,
      requestId,
      command,
    });
    const wait = Atomics.wait(header, 0, 0, SESSION_TIMEOUT_MS);
    const durationMs = performance.now() - started;
    const responseState = Atomics.load(header, 0);
    const responseLength = Atomics.load(header, 1);
    sessionDiagnostic("request-wait-returned", {
      sessionId: this.sessionId,
      requestId,
      command,
      wait,
      responseState,
      responseLength,
      durationMs: Number(durationMs.toFixed(3)),
    });
    const processStarted = !this.processCounted;
    this.processCounted = true;
    if (wait === "timed-out") {
      sessionDiagnostic("request-timeout", {
        sessionId: this.sessionId,
        requestId,
        command,
        durationMs: Number(durationMs.toFixed(3)),
      });
      recordGitMetric({
        command: "cat-file-session",
        durationMs,
        ok: false,
        transport: "session",
        processStarted,
        cacheHit: false,
      });
      throw new CliError("Timed out waiting for the Git object session.",
        { code: "session-unavailable" });
    }
    const length = Atomics.load(header, 1);
    const payload = Buffer.from(new Uint8Array(shared, 16, length)).toString("utf8");
    let response;
    try {
      response = JSON.parse(payload);
    } catch {
      sessionDiagnostic("response-malformed", {
        sessionId: this.sessionId,
        requestId,
        command,
        responseLength: payload.length,
      });
      throw new CliError("The Git object session returned malformed data.",
        { code: "session-unavailable" });
    }
    sessionDiagnostic("response-received", {
      sessionId: this.sessionId,
      requestId,
      command,
      ok: Boolean(response.ok),
      error: response.ok ? null : response.error ?? "unknown session error",
      resultCount: Array.isArray(response.results) ? response.results.length : 0,
    });
    recordGitMetric({
      command: "cat-file-session",
      durationMs,
      ok: Boolean(response.ok),
      transport: "session",
      processStarted,
      cacheHit: false,
    });
    traceGitMetric({
      command: "cat-file-session",
      durationMs,
      transport: "session",
      processStarted,
      cacheHit: false,
    });
    if (!response.ok) {
      sessionDiagnostic("response-failed", {
        sessionId: this.sessionId,
        requestId,
        command,
        error: response.error ?? "unknown session error",
      });
      throw new CliError(`Git object session failed: ${response.error}`,
        { code: "session-unavailable" });
    }
    for (let index = 0; index < response.results.length; index += 1) {
      const resultIndex = missingIndexes[index];
      const raw = response.results[index];
      const value = {
        ...raw,
        content: raw.content === null ? null : Buffer.from(raw.content, "base64"),
      };
      cached[resultIndex] = value;
      if (cacheKeys[resultIndex]) this.cache.set(cacheKeys[resultIndex], value);
    }
    return cached;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    const worker = this.worker;
    if (!worker) {
      sessionDiagnostic("session-close-no-worker", {
        sessionId: this.sessionId,
      });
      return;
    }
    const shared = new SharedArrayBuffer(16 + 1024);
    const header = new Int32Array(shared, 0, 4);
    sessionDiagnostic("session-close-posting", {
      sessionId: this.sessionId,
    });
    let wait = "post-error";
    try {
      worker.postMessage({ type: "close", shared });
      wait = Atomics.wait(header, 0, 0, 5_000);
    } catch (error) {
      sessionDiagnostic("session-close-error", {
        sessionId: this.sessionId,
        message: error.message,
      });
    }
    sessionDiagnostic("session-close-wait-returned", {
      sessionId: this.sessionId,
      wait,
      responseState: Atomics.load(header, 0),
      responseLength: Atomics.load(header, 1),
    });
    worker.terminate();
    worker.unref();
    sessionDiagnostic("session-close-terminated", {
      sessionId: this.sessionId,
    });
  }

  disable() {
    if (this.closed) return;
    this.failed = true;
    this.closed = true;
    const worker = this.worker;
    if (!worker) {
      sessionDiagnostic("session-disable-no-worker", {
        sessionId: this.sessionId,
      });
      return;
    }
    const shared = new SharedArrayBuffer(16 + 1024);
    const header = new Int32Array(shared, 0, 4);
    sessionDiagnostic("session-disable-posting", {
      sessionId: this.sessionId,
    });
    let wait = "post-error";
    try {
      worker.postMessage({ type: "close", shared });
      wait = Atomics.wait(header, 0, 0, 5_000);
    } catch (error) {
      sessionDiagnostic("session-disable-error", {
        sessionId: this.sessionId,
        message: error.message,
      });
    }
    sessionDiagnostic("session-disable-wait-returned", {
      sessionId: this.sessionId,
      wait,
      responseState: Atomics.load(header, 0),
      responseLength: Atomics.load(header, 1),
    });
    worker.terminate();
    worker.unref();
    sessionDiagnostic("session-disable-terminated", {
      sessionId: this.sessionId,
    });
  }
}

function objectSession(cwd) {
  return activeObjectSessions.get(path.resolve(cwd)) ?? null;
}

function queryObjectSession(cwd, command, expressions) {
  const session = objectSession(cwd);
  if (!session || session.failed) return null;
  try {
    return session.request(command, expressions);
  } catch (error) {
    sessionDiagnostic("session-fallback", {
      sessionId: session.sessionId,
      command,
      expressions: diagnosticExpressions(expressions),
      message: error.message,
    });
    session.disable();
    if (process.env.VLAB_TRACE === "1") {
      process.stderr.write(
        `[vlab trace] Git object session unavailable; using ordinary processes (${error.message})\n`,
      );
    }
    return null;
  }
}

export function gitObjectSessionEnabled() {
  if (process.env.VLAB_GIT_SESSION === "0") return false;
  if (process.env.VLAB_GIT_SESSION === "1") return true;
  return process.platform === "win32";
}

export function withGitObjectSession(cwd = process.cwd(), callback) {
  if (!gitObjectSessionEnabled()) return callback();
  const key = path.resolve(cwd);
  if (activeObjectSessions.has(key)) return callback();
  const session = new GitObjectSession(key);
  activeObjectSessions.set(key, session);
  sessionDiagnostic("session-enter", {
    sessionId: session.sessionId,
    cwd: key,
  });
  try {
    return callback();
  } finally {
    activeObjectSessions.delete(key);
    sessionDiagnostic("session-exit", {
      sessionId: session.sessionId,
      cwd: key,
    });
    session.close();
  }
}

/*
 * Read operations of the Git engine. Each function below is the Git
 * implementation of one operation in the catalog of `src/engine.js`; domain
 * modules call the seam, never these functions directly. Every Git process
 * they launch carries the private `ENGINE_READ` mark, which is what lets
 * `runGit` tell a seam read from a read that bypassed it.
 */

function readGit(args, options = {}) {
  return runGit(args, { ...options, [ENGINE_READ]: true });
}

function readText(args, options = {}) {
  return readGit(args, options).stdout;
}

export function readGitBlob(blob, cwd = process.cwd()) {
  const sessionResult = queryObjectSession(cwd, "contents", [blob]);
  if (sessionResult) {
    const object = sessionResult[0];
    if (!object.exists || object.type !== "blob") {
      throw new CliError(`Git object '${blob}' is not a blob.`,
        { code: "revision-not-resolved" });
    }
    return object.content;
  }
  const result = readGit(["cat-file", "blob", blob], {
    cwd,
    binary: true,
    trim: false,
    allowFailure: true,
  });
  if (!result.ok) {
    throw new CliError(`Git object '${blob}' is not a blob.`,
      { code: "revision-not-resolved", details: result.stderr });
  }
  return result.stdout;
}

function readBatchLine(buffer, offset) {
  const newline = buffer.indexOf(0x0a, offset);
  if (newline < 0) {
    throw new CliError("Git returned a truncated cat-file batch response.",
      { code: "git-response-malformed" });
  }
  return {
    line: buffer.subarray(offset, newline).toString("utf8"),
    next: newline + 1,
  };
}

/**
 * Read several Git object expressions with one process. Expressions may be
 * object IDs, revision:path pairs, or index expressions such as :path.
 */
export function readGitObjects(expressions, cwd = process.cwd()) {
  if (!Array.isArray(expressions) || expressions.length === 0) return [];
  validateObjectExpressions(expressions);
  const sessionResult = queryObjectSession(cwd, "contents", expressions);
  if (sessionResult) return sessionResult;
  const input = Buffer.from(`${expressions.join("\n")}\n`, "utf8");
  const response = readGit(["cat-file", "--batch"], {
    cwd,
    input,
    binary: true,
    trim: false,
  }).stdout;
  const results = [];
  let offset = 0;
  for (const expression of expressions) {
    const header = readBatchLine(response, offset);
    offset = header.next;
    if (header.line.endsWith(" missing")) {
      results.push({
        expression,
        exists: false,
        oid: null,
        type: null,
        size: 0,
        content: null,
      });
      continue;
    }
    const match = header.line.match(/^([0-9a-f]+) (\S+) (\d+)$/);
    if (!match) {
      throw new CliError(`Unexpected git cat-file batch header: ${header.line}`,
        { code: "git-response-malformed" });
    }
    const size = Number(match[3]);
    const end = offset + size;
    if (end >= response.length || response[end] !== 0x0a) {
      throw new CliError("Git returned a malformed cat-file batch object.",
        { code: "git-response-malformed" });
    }
    results.push({
      expression,
      exists: true,
      oid: match[1],
      type: match[2],
      size,
      content: response.subarray(offset, end),
    });
    offset = end + 1;
  }
  return results;
}

/**
 * Classify several Git object expressions with one process, tolerating
 * expressions that do not resolve. Unlike `resolveObjectIds`, a missing or
 * unpeelable expression yields `{ exists: false }` instead of an error, so a
 * caller can quarantine individual entries from a bounded scan.
 */
export function inspectGitObjects(expressions, cwd = process.cwd()) {
  if (!Array.isArray(expressions) || expressions.length === 0) return [];
  validateObjectExpressions(expressions);
  const sessionResult = queryObjectSession(cwd, "info", expressions);
  if (sessionResult) {
    return sessionResult.map((object, index) => ({
      expression: expressions[index],
      exists: Boolean(object.exists),
      oid: object.exists ? object.oid : null,
      type: object.exists ? object.type : null,
      size: object.exists ? object.size : 0,
    }));
  }
  const output = readGit(["cat-file", "--batch-check"], {
    cwd,
    input: `${expressions.join("\n")}\n`,
    trim: false,
  }).stdout;
  const lines = output.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length !== expressions.length) {
    throw new CliError("Git did not classify every requested object expression.",
      { code: "git-response-malformed" });
  }
  return expressions.map((expression, index) => {
    const line = lines[index];
    if (line.endsWith(" missing") || line.endsWith(" ambiguous")) {
      return { expression, exists: false, oid: null, type: null, size: 0 };
    }
    const match = line.match(/^([0-9a-f]+) (\S+) (\d+)$/);
    if (!match) {
      throw new CliError(`Unexpected git cat-file batch-check line: ${line}`,
        { code: "git-response-malformed" });
    }
    return {
      expression,
      exists: true,
      oid: match[1],
      type: match[2],
      size: Number(match[3]),
    };
  });
}

/** Run a mutating Git command and return its trimmed standard output. */
export function gitText(args, options = {}) {
  return runGit(args, options).stdout;
}

export function repoContext(cwd = process.cwd()) {
  const cacheKey = path.resolve(cwd);
  const cached = repositoryContextCache.get(cacheKey);
  if (cached) return cached;
  const [root, gitDirRaw, commonDirRaw, objectFormat] = readText(
    [
      "rev-parse",
      "--show-toplevel",
      "--git-dir",
      "--git-common-dir",
      "--show-object-format",
    ],
    { cwd },
  ).split(/\r?\n/);
  if (!root || !gitDirRaw || !commonDirRaw || !["sha1", "sha256"].includes(objectFormat)) {
    throw new CliError("Git did not return a complete repository context.",
      { code: "git-response-malformed" });
  }
  const context = {
    root: path.resolve(root),
    gitDir: path.resolve(cwd, gitDirRaw),
    commonDir: path.resolve(cwd, commonDirRaw),
    objectFormat,
  };
  repositoryContextCache.set(cacheKey, context);
  return context;
}

export function resolveRevision(revision, cwd = process.cwd()) {
  const sessionResult = queryObjectSession(cwd, "info", [`${revision}^{commit}`]);
  if (sessionResult) {
    const object = sessionResult[0];
    if (!object.exists || object.type !== "commit") {
      throw new CliError(`Git revision '${revision}' did not resolve to a commit.`,
        { code: "revision-not-resolved" });
    }
    return object.oid;
  }
  // The process path must classify a missing revision the way the session
  // path does (ADR-0021): a reference that is not there is the caller's
  // problem, not a Git defect, and the code must not depend on which
  // transport answered — the session is the default on Windows only.
  const result = readGit(["rev-parse", "--verify", "--quiet", `${revision}^{commit}`], {
    cwd,
    allowFailure: true,
  });
  if (!result.ok || !result.stdout) {
    throw new CliError(`Git revision '${revision}' did not resolve to a commit.`,
      { code: "revision-not-resolved", details: result.stderr });
  }
  return result.stdout;
}

export function resolveObjectIds(expressions, cwd = process.cwd()) {
  if (!Array.isArray(expressions) || expressions.length === 0) return [];
  const sessionResult = queryObjectSession(cwd, "info", expressions);
  if (sessionResult) {
    const objects = sessionResult;
    if (objects.some((object) => !object.exists)) {
      throw new CliError("Git did not resolve every requested object expression.",
        { code: "revision-not-resolved" });
    }
    return objects.map((object) => object.oid);
  }
  const result = readGit(["rev-parse", ...expressions], { cwd, allowFailure: true });
  const ids = result.ok ? result.stdout.split(/\r?\n/).filter(Boolean) : [];
  if (!result.ok || ids.length !== expressions.length) {
    throw new CliError("Git did not resolve every requested object expression.",
      { code: "revision-not-resolved", details: result.ok ? "" : result.stderr });
  }
  return ids;
}

export function treeId(revision, cwd = process.cwd()) {
  const sessionResult = queryObjectSession(cwd, "info", [`${revision}^{tree}`]);
  if (sessionResult) {
    const object = sessionResult[0];
    if (!object.exists || object.type !== "tree") {
      throw new CliError(`Git revision '${revision}' did not resolve to a tree.`,
        { code: "revision-not-resolved" });
    }
    return object.oid;
  }
  const result = readGit(["rev-parse", "--verify", "--quiet", `${revision}^{tree}`], {
    cwd,
    allowFailure: true,
  });
  if (!result.ok || !result.stdout) {
    throw new CliError(`Git revision '${revision}' did not resolve to a tree.`,
      { code: "revision-not-resolved", details: result.stderr });
  }
  return result.stdout;
}

export function mergeBase(left, right, cwd = process.cwd()) {
  return readText(["merge-base", left, right], { cwd });
}

export function listCommits(base, tip, cwd = process.cwd()) {
  const result = readText(["rev-list", "--reverse", `${base}..${tip}`], { cwd });
  return result ? result.split(/\r?\n/).filter(Boolean) : [];
}

/** Every commit reachable from `revision`, newest first. */
export function reachableCommits(revision, cwd = process.cwd()) {
  const output = readText(["rev-list", revision], { cwd });
  return output ? output.split(/\r?\n/).filter(Boolean) : [];
}

/** The number of commits reachable from `revision`. */
export function countCommits(revision, cwd = process.cwd()) {
  return Number(readText(["rev-list", "--count", revision], { cwd }));
}

/** The commits in `base..tip` that have more than one parent, sorted. */
export function mergeCommitsBetween(base, tip, cwd = process.cwd()) {
  const output = readText(["rev-list", "--parents", `${base}..${tip}`], { cwd });
  if (!output) return [];
  return output
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter((fields) => fields.length > 2)
    .map(([commit]) => commit)
    .sort();
}

/**
 * Root commits (no parents) reachable from any branch, tag, or remote ref,
 * unique and sorted; empty when the repository has no such ref.
 */
export function rootCommits(cwd = process.cwd()) {
  const result = readGit(
    ["rev-list", "--max-parents=0", "--branches", "--tags", "--remotes"],
    { cwd, allowFailure: true },
  );
  return [...new Set(
    result.ok && result.stdout ? result.stdout.split(/\r?\n/).filter(Boolean) : [],
  )].sort();
}

/**
 * `{ commit, subject, message }` for every commit `git log` selects from
 * `revisions` (revisions, ranges, or exclusions), newest first unless
 * `reverse`. With `options.paths`, each record also carries `changedPaths`,
 * the paths that commit touched, produced by the same single process.
 *
 * The format begins with `%x00` so every record starts with an empty field
 * once the output is split. `-z` gives a `--name-only` list no terminator, so
 * without that sentinel the last file name of one commit cannot be told from
 * the first field of the next; with it a record boundary is unambiguous,
 * because a path is never empty. Git separates the format output from the
 * name list with a newline, which lands at the front of the first path field.
 */
export function commitHistory(revisions, cwd = process.cwd(), options = {}) {
  const output = readText(
    [
      "log",
      "-z",
      ...(options.reverse ? ["--reverse"] : []),
      ...(options.paths ? ["--name-only"] : []),
      "--format=%x00%H%x00%s%x00%B",
      ...revisions,
    ],
    { cwd, trim: false },
  );
  const records = [];
  const fields = output.split("\0");
  let index = 0;
  while (index < fields.length) {
    if (fields[index] !== "") {
      index += 1;
      continue;
    }
    if (index + 3 >= fields.length) break;
    const commit = fields[index + 1].trim();
    if (!commit) {
      index += 1;
      continue;
    }
    const record = {
      commit,
      subject: fields[index + 2],
      message: fields[index + 3],
    };
    index += 4;
    if (options.paths) {
      const changedPaths = [];
      while (index < fields.length && fields[index] !== "") {
        const field = fields[index];
        const path = field.startsWith("\n") ? field.slice(1) : field;
        if (path) changedPaths.push(path);
        index += 1;
      }
      record.changedPaths = changedPaths;
    }
    records.push(record);
  }
  return records;
}

export function commitMessage(commit, cwd = process.cwd()) {
  const sessionResult = queryObjectSession(cwd, "contents", [`${commit}^{commit}`]);
  if (sessionResult) {
    const object = sessionResult[0];
    if (!object.exists || object.type !== "commit") {
      throw new CliError(`Git revision '${commit}' did not resolve to a commit.`,
        { code: "revision-not-resolved" });
    }
    const raw = object.content.toString("utf8");
    const separator = raw.indexOf("\n\n");
    return (separator < 0 ? "" : raw.slice(separator + 2)).trim();
  }
  const result = readGit(["show", "-s", "--format=%B", `${commit}^{commit}`], {
    cwd,
    allowFailure: true,
  });
  if (!result.ok) {
    throw new CliError(`Git revision '${commit}' did not resolve to a commit.`,
      { code: "revision-not-resolved", details: result.stderr });
  }
  return result.stdout;
}

export function commitSubject(commit, cwd = process.cwd()) {
  if (objectSession(cwd)?.failed === false) {
    return commitMessage(commit, cwd).split(/\r?\n/, 1)[0];
  }
  return readText(["show", "-s", "--format=%s", commit], { cwd });
}

export function extractTrailer(message, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = message.match(new RegExp(`^${escaped}:\\s*(.+?)\\s*$`, "im"));
  return match?.[1]?.trim() ?? null;
}

export function isAncestor(ancestor, descendant, cwd = process.cwd()) {
  return readGit(["merge-base", "--is-ancestor", ancestor, descendant], {
    cwd,
    allowFailure: true,
  }).ok;
}

/**
 * The commits of `source` (beyond `base`) whose patch ID also appears in
 * `target`, as `git cherry` reports them; empty when Git cannot compare.
 */
export function patchEquivalentCommits(target, source, base, cwd = process.cwd()) {
  const result = readGit(["cherry", target, source, base], {
    cwd,
    allowFailure: true,
  });
  const equivalents = [];
  if (!result.ok || !result.stdout) return equivalents;
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = line.match(/^(-|\+)\s+([0-9a-f]+)/i);
    if (match?.[1] === "-") equivalents.push(match[2]);
  }
  return equivalents;
}

export function refExists(ref, cwd = process.cwd()) {
  return readGit(["show-ref", "--verify", "--quiet", ref], {
    cwd,
    allowFailure: true,
  }).ok;
}

/** The raw, unpeeled object ID `ref` names, or null when it does not exist. */
export function refTarget(ref, cwd = process.cwd()) {
  const result = readGit(["show-ref", "--verify", "--hash", ref], {
    cwd,
    allowFailure: true,
  });
  return result.ok ? result.stdout : null;
}

/** `{ ref, oid }` for every ref under `pattern`, in Git's ref order. */
export function listRefs(pattern, cwd = process.cwd()) {
  const scan = readGit(
    ["for-each-ref", "--format=%(refname)%00%(objectname)", pattern],
    { cwd, allowFailure: true },
  );
  if (!scan.ok) {
    throw new CliError(`Could not scan refs under '${pattern}'.`, {
      code: "git-command-failed",
      details: scan.stderr,
    });
  }
  const entries = [];
  for (const line of scan.stdout.split(/\r?\n/)) {
    if (!line) continue;
    const [ref, oid] = line.split("\0");
    if (ref && oid) entries.push({ ref, oid });
  }
  return entries;
}

/**
 * The symbolic target of `name` (normally `HEAD`), or null when it is
 * detached or absent; `short` asks Git for its unambiguous short form.
 */
export function symbolicRef(name, cwd = process.cwd(), options = {}) {
  const result = readGit(
    ["symbolic-ref", "--quiet", ...(options.short ? ["--short"] : []), name],
    { cwd, allowFailure: true },
  );
  return result.ok && result.stdout ? result.stdout : null;
}

/**
 * The commit a pseudo-ref such as `CHERRY_PICK_HEAD` names, or null when it
 * is not set. Always a fresh `rev-parse`: the sequencer creates and removes
 * these refs within one invocation, so neither the object session nor a
 * file under the Git directory may stand in for Git's own answer (with the
 * reftable backend they are not files at all).
 */
export function pseudoRefTarget(name, cwd = process.cwd()) {
  const result = readGit(
    ["rev-parse", `${name}^{commit}`, "--symbolic-full-name", name],
    { cwd, allowFailure: true },
  );
  if (!result.ok) return null;
  const [oid = "", fullName = ""] = result.stdout.split(/\r?\n/);
  // A branch or tag that carries the pseudo-ref's name resolves too, and Git
  // reports it as `refs/heads/<name>`; only a name outside `refs/` is the
  // sequencer's. When both exist Git answers with the sequencer's ref and,
  // calling the name ambiguous, prints no full name at all. Git metadata is
  // untrusted input, so the branch must not pass for a pending operation.
  if (fullName.startsWith("refs/")) return null;
  return /^[0-9a-f]{40,64}$/i.test(oid) ? oid : null;
}

/** Whether `name` (a ref, pseudo-ref, or revision) resolves to an object. */
export function revisionResolves(name, cwd = process.cwd()) {
  return readGit(["rev-parse", "--verify", "--quiet", name], {
    cwd,
    allowFailure: true,
  }).ok;
}

/** The path Git uses for `name` inside this worktree's Git directory. */
export function gitPath(name, cwd = process.cwd()) {
  return readText(["rev-parse", "--git-path", name], { cwd });
}

/** Whether `cwd` lies inside a Git work tree (false when Git rejects it). */
export function isInsideWorkTree(cwd = process.cwd()) {
  const probe = readGit(["rev-parse", "--is-inside-work-tree"], {
    cwd,
    allowFailure: true,
  });
  return probe.ok && probe.stdout === "true";
}

/**
 * Every commit reachable from a ref that carries `changeId` as its
 * `Change-Id` trailer, in the order the identity protocol states
 * (docs/identity/README.md §5): earliest committer date first, and equal
 * dates by ascending commit id. Both keys are content of the commits, so the
 * order is the same on every host that reaches the same commits. A caller
 * that needs one bearer takes the first, or applies the protocol's origin
 * preference to the whole list.
 */
export function findCommitsByChangeId(changeId, cwd = process.cwd()) {
  const output = readText(
    ["log", "--all", "--format=%H%x1f%ct%x1f%B%x1e"],
    { cwd, trim: false },
  );
  const bearers = [];
  for (const record of output.split("\x1e")) {
    if (!record.trim()) continue;
    const first = record.indexOf("\x1f");
    const second = first < 0 ? -1 : record.indexOf("\x1f", first + 1);
    if (second < 0) continue;
    const commit = record.slice(0, first).trim();
    const committedAt = Number(record.slice(first + 1, second));
    const message = record.slice(second + 1);
    if (extractTrailer(message, "Change-Id") === changeId) {
      bearers.push({ commit, committedAt });
    }
  }
  bearers.sort((left, right) =>
    left.committedAt - right.committedAt ||
    (left.commit < right.commit ? -1 : left.commit > right.commit ? 1 : 0),
  );
  return bearers.map((bearer) => bearer.commit);
}

/** The decorated `git log --graph` text of every ref, for `vlab graph`. */
export function historyGraph(cwd = process.cwd()) {
  return readText(
    [
      "log",
      "--graph",
      "--oneline",
      "--decorate",
      "--branches",
      "--tags",
      "--remotes",
      "HEAD",
    ],
    { cwd },
  );
}

/** `{ note, target }` for every note in `notesRef`; empty when it is absent. */
export function listNoteEntries(notesRef, cwd = process.cwd()) {
  const result = readGit(["notes", `--ref=${notesRef}`, "list"], {
    cwd,
    allowFailure: true,
  });
  if (!result.ok || !result.stdout) return [];
  return result.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [note, target] = line.trim().split(/\s+/);
      return note && target ? { note, target } : null;
    })
    .filter(Boolean);
}

/** The trimmed note text `notesRef` attaches to `target`, or null when none. */
export function readNoteText(notesRef, target, cwd = process.cwd()) {
  const result = readGit(["notes", `--ref=${notesRef}`, "show", target], {
    cwd,
    allowFailure: true,
  });
  return result.ok ? result.stdout : null;
}

/**
 * Parse `git status --porcelain=v2 --branch -z` output into the exact HEAD
 * commit and the number of changed or untracked entries. Header fields start
 * with `# `; rename and copy entries (`2 ...`) carry the original path in a
 * second NUL-terminated field that must not be counted as another entry.
 */
function parseWorktreeStatus(output) {
  let head = null;
  let dirtyFiles = 0;
  const fields = output.split("\0");
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (!field) continue;
    if (field.startsWith("# ")) {
      if (field.startsWith("# branch.oid ")) {
        const oid = field.slice("# branch.oid ".length);
        head = oid === "(initial)" ? null : oid;
      }
      continue;
    }
    dirtyFiles += 1;
    if (field.startsWith("2 ")) index += 1;
  }
  return { head, dirtyFiles };
}

/**
 * One worktree-scoped status query: `{ ok: true, head, dirtyFiles }` for a
 * work tree Git can read, or `{ ok: false, error, exitCode }` with Git's
 * output when it cannot (the caller decides whether that is a missing work
 * tree or an error).
 */
export function workspaceStatus(cwd = process.cwd()) {
  const status = readGit(["status", "--porcelain=v2", "--branch", "-z"], {
    cwd,
    allowFailure: true,
    trim: false,
  });
  if (!status.ok) {
    return {
      ok: false,
      head: null,
      dirtyFiles: null,
      error: status.output,
      exitCode: status.status || 1,
    };
  }
  return { ok: true, ...parseWorktreeStatus(status.stdout), error: null, exitCode: 0 };
}

/**
 * `git status --porcelain=v1` text: trimmed and newline-separated by
 * default, or the raw NUL-terminated form with `nulTerminated`.
 */
export function porcelainStatus(cwd = process.cwd(), options = {}) {
  return readText(
    ["status", "--porcelain=v1", ...(options.nulTerminated ? ["-z"] : [])],
    { cwd, trim: !options.nulTerminated },
  );
}

/** Paths with unresolved merge conflicts in the index. */
export function unmergedPaths(cwd = process.cwd()) {
  const result = readGit(["diff", "--name-only", "--diff-filter=U"], {
    cwd,
    allowFailure: true,
  });
  return result.stdout ? result.stdout.split(/\r?\n/).filter(Boolean) : [];
}

function parseIndexEntries(output) {
  const entries = [];
  for (const record of output.split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const [mode, blob, stageText] = record.slice(0, tab).split(/\s+/);
    entries.push({
      mode,
      blob,
      stage: Number(stageText),
      path: record.slice(tab + 1),
    });
  }
  return entries;
}

/**
 * `{ mode, blob, stage, path }` for the index entries under `paths` (or the
 * whole index), or only the unmerged stages with `unmergedOnly`.
 */
export function indexEntries(cwd = process.cwd(), options = {}) {
  const args = ["ls-files", options.unmergedOnly ? "-u" : "--stage", "-z"];
  if (options.paths?.length) args.push("--", ...options.paths);
  return parseIndexEntries(readText(args, { cwd, trim: false }));
}

/** Tracked paths under `pathspecs`, sorted; empty when Git cannot list them. */
export function listTrackedPaths(pathspecs, cwd = process.cwd()) {
  const result = readGit(["ls-files", "-z", "--", ...pathspecs], {
    cwd,
    trim: false,
    allowFailure: true,
  });
  return result.ok && result.stdout
    ? result.stdout.split("\0").filter(Boolean).sort()
    : [];
}

/**
 * Tracked, modified, and untracked (not ignored) paths under `pathspecs`
 * with their `git ls-files -t` tag and, for index entries, mode, blob, and
 * stage; untracked entries carry the `?` tag and null index fields.
 */
export function pathInventory(pathspecs, cwd = process.cwd()) {
  const output = readText(
    [
      "ls-files",
      "-z",
      "-t",
      "--cached",
      "--modified",
      "--others",
      "--exclude-standard",
      "--stage",
      "--full-name",
      "--",
      ...pathspecs,
    ],
    { cwd, trim: false },
  );
  const entries = [];
  for (const record of output.split("\0").filter(Boolean)) {
    if (record.startsWith("? ")) {
      entries.push({ tag: "?", mode: null, blob: null, stage: null, path: record.slice(2) });
      continue;
    }
    const tag = record[0];
    const body = record.slice(2);
    const tab = body.indexOf("\t");
    if (tab < 0) continue;
    const [mode, blob, stageText] = body.slice(0, tab).split(" ");
    entries.push({ tag, mode, blob, stage: Number(stageText), path: body.slice(tab + 1) });
  }
  return entries;
}

/** Untracked paths that the ignore rules exclude. */
export function ignoredPaths(cwd = process.cwd()) {
  return readText(
    ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"],
    { cwd, trim: false },
  ).split("\0").filter(Boolean);
}

/** Linked administrative directories, including worktrees whose paths are missing. */
export function listWorktreeGitDirs(cwd = process.cwd()) {
  const directory = path.join(repoContext(cwd).commonDir, "worktrees");
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return entries.filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => path.join(directory, entry.name)).sort();
}

/**
 * Every work tree of the repository as
 * `{ path, head, branch, detached, bare, locked, prunable }`, parsed from
 * `git worktree list --porcelain -z`; `locked` and `prunable` carry Git's
 * reason text (possibly empty) or null.
 */
export function listWorktrees(cwd = process.cwd()) {
  const output = readText(["worktree", "list", "--porcelain", "-z"], {
    cwd,
    trim: false,
  });
  const worktrees = [];
  let current = null;
  for (const field of output.split("\0")) {
    if (field === "") {
      if (current) worktrees.push(current);
      current = null;
      continue;
    }
    if (field.startsWith("worktree ")) {
      if (current) worktrees.push(current);
      current = {
        path: field.slice("worktree ".length),
        head: null,
        branch: null,
        detached: false,
        bare: false,
        locked: null,
        prunable: null,
      };
      continue;
    }
    if (!current) continue;
    if (field.startsWith("HEAD ")) current.head = field.slice("HEAD ".length);
    else if (field.startsWith("branch ")) current.branch = field.slice("branch ".length);
    else if (field === "detached") current.detached = true;
    else if (field === "bare") current.bare = true;
    else if (field === "locked" || field.startsWith("locked ")) current.locked = field.slice("locked".length).trim();
    else if (field === "prunable" || field.startsWith("prunable ")) current.prunable = field.slice("prunable".length).trim();
  }
  if (current) worktrees.push(current);
  return worktrees;
}

export const FORECAST_ENGINES = ["worktree", "merge-tree"];

/**
 * Configuration prepended to every `cherry-pick` and landing `merge` vlab
 * runs. Git applies a recorded `rerere` resolution during a conflicted pick
 * or merge whenever `.git/rr-cache` exists (with `rerere.autoUpdate` the
 * index is left fully resolved and no unmerged path remains), and records
 * the resolution of a continued pick. Neither may happen inside vlab: a
 * conflict is resolved only by vlab's own approved memory or by the user,
 * and only vlab's catalog records it (ADR-0018).
 */
export const GIT_NO_RERERE = ["-c", "rerere.enabled=false"];

/**
 * The forecast engine used when neither `VLAB_FORECAST_ENGINE` nor
 * `--forecast-engine` selects one. Like the object session, the merge-tree
 * engine is the default on Windows, where a process launch costs tens of
 * milliseconds and Git for Windows is current, and opt-in elsewhere, where
 * distribution Git is often older than the engine needs (ADR-0016, amendment
 * of 2026-08-30).
 */
export function defaultForecastEngine() {
  return process.platform === "win32" ? "merge-tree" : "worktree";
}

/**
 * Select the forecast simulation engine. `worktree` is the temporary-worktree
 * simulator and the semantic oracle; `merge-tree` simulates clean steps with
 * `git merge-tree --write-tree` and falls back to the worktree simulator for
 * any step it cannot reproduce. The environment variable mirrors the
 * `VLAB_GIT_SESSION` pattern; the CLI sets it from `--forecast-engine`.
 */
export function forecastEngine() {
  const value = process.env.VLAB_FORECAST_ENGINE;
  if (value === undefined || value === "") return defaultForecastEngine();
  if (FORECAST_ENGINES.includes(value)) return value;
  throw new CliError(
    `Unknown forecast engine '${value}'. Use one of: ${FORECAST_ENGINES.join(", ")}.`,
      { code: "usage-invalid-option-value" },
  );
}

/**
 * The oldest Git the merge-tree engine works on. `git merge-tree --stdin`
 * flushes each record before reading the next line only from 2.49 (Git
 * commit 344a107b, "merge-tree --stdin: flush stdout to avoid deadlock");
 * before that the records sit in the process's stdio buffer until it exits,
 * so a session never sees its first answer. The other requirements are older:
 * bare tree object IDs for the three operands from 2.45 (earlier versions
 * resolve them as commits and die) and `GIT_ATTR_SOURCE` from 2.43. vlab's
 * supported baseline stays 2.40; on older Git the session worker reads the
 * version from the trace2 `version` event of its own process, refuses the
 * first request, and the engine falls back to the worktree simulator with
 * the reason `git-too-old` without spawning another process.
 */
export const MERGE_TREE_ENGINE_MIN_GIT = "2.49";

let cachedGitVersion = null;

/** `git --version` as `{ raw, parts }`, run at most once per process. */
export function gitVersion(cwd = process.cwd()) {
  if (!cachedGitVersion) {
    const raw = readGit(["--version"], { cwd }).stdout.trim();
    const match = raw.match(/(\d+)\.(\d+)(?:\.(\d+))?/);
    cachedGitVersion = {
      raw,
      parts: match
        ? [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)]
        : null,
    };
  }
  return cachedGitVersion;
}

const MERGE_TREE_RESPONSE_BYTES = 64 * 1024;
const OBJECT_ID_PATTERN = /^[0-9a-f]{40,64}$/;

/**
 * One `git merge-tree --stdin` process reused for every clean step of a
 * forecast. Requests are synchronous, like the object session, because the CLI
 * is synchronous; the worker thread owns the process and answers through a
 * shared buffer.
 */
export class MergeTreeSession {
  constructor(cwd, options = {}) {
    this.cwd = path.resolve(cwd);
    this.attrSource = options.attrSource ?? null;
    this.sessionId = `${process.pid}-merge-tree-${nextSessionId++}`;
    this.worker = null;
    this.closed = false;
    this.processCounted = false;
    this.gitCommand = process.env.VLAB_TEST_MERGE_TREE_SESSION_FAILURE === "1"
      ? "vlab-intentionally-missing-git"
      : "git";
    // Test hook: pretend the session process reported this Git version
    // instead of the one its trace2 version event names.
    this.spoofGitVersion = process.env.VLAB_TEST_MERGE_TREE_GIT_VERSION || null;
    /** The Git version the session process reported, once known. */
    this.gitVersion = null;
  }

  startWorker() {
    if (this.worker) return this.worker;
    if (this.closed) {
      throw new CliError("The merge-tree session is already closed.",
        { code: "session-unavailable" });
    }
    const worker = new Worker(
      new URL("./merge-tree-session-worker.js", import.meta.url),
      {
        workerData: {
          cwd: this.cwd,
          gitCommand: this.gitCommand,
          attrSource: this.attrSource,
          requiredGit: MERGE_TREE_ENGINE_MIN_GIT,
          spoofGitVersion: this.spoofGitVersion,
        },
      },
    );
    this.worker = worker;
    worker.on("error", (error) => {
      sessionDiagnostic("merge-tree-worker-error", {
        sessionId: this.sessionId,
        message: error.message,
      });
    });
    worker.unref();
    sessionDiagnostic("merge-tree-worker-created", {
      sessionId: this.sessionId,
      cwd: this.cwd,
    });
    return worker;
  }

  /**
   * Merge `theirs` onto `ours` relative to `base`, all tree or commit object
   * IDs. Returns `{ clean, tree }`. A conflicted result ends the session.
   */
  merge(base, ours, theirs) {
    if (this.closed) {
      throw new CliError("The merge-tree session is already closed.",
        { code: "session-unavailable" });
    }
    for (const oid of [base, ours, theirs]) {
      if (!OBJECT_ID_PATTERN.test(String(oid))) {
        throw new CliError("Merge-tree session arguments must be full object IDs.",
          { code: "session-unavailable" });
      }
    }
    const shared = new SharedArrayBuffer(16 + MERGE_TREE_RESPONSE_BYTES);
    const header = new Int32Array(shared, 0, 4);
    const started = performance.now();
    const worker = this.startWorker();
    worker.postMessage({ type: "merge", base, ours, theirs, shared });
    const wait = Atomics.wait(header, 0, 0, SESSION_TIMEOUT_MS);
    const durationMs = performance.now() - started;
    const processStarted = !this.processCounted;
    this.processCounted = true;
    const record = (ok) => {
      const item = {
        command: "merge-tree-session",
        durationMs,
        ok,
        transport: "session",
        processStarted,
        cacheHit: false,
      };
      recordGitMetric(item);
      traceGitMetric(item);
    };
    if (wait === "timed-out") {
      record(false);
      throw new CliError("Timed out waiting for the Git merge-tree session.",
        { code: "session-unavailable" });
    }
    const length = Atomics.load(header, 1);
    const payload = Buffer.from(new Uint8Array(shared, 16, length)).toString("utf8");
    let response;
    try {
      response = JSON.parse(payload);
    } catch {
      record(false);
      throw new CliError("The Git merge-tree session returned malformed data.",
        { code: "session-unavailable" });
    }
    record(Boolean(response.ok));
    if (response.gitVersion) this.gitVersion = response.gitVersion;
    if (!response.ok) {
      const failure = new CliError(`Git merge-tree session failed: ${response.error}`,
        { code: "session-unavailable" });
      failure.sessionFailure = response.sessionFailure ?? null;
      failure.gitVersion = response.gitVersion ?? null;
      throw failure;
    }
    return response.result;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    const worker = this.worker;
    if (!worker) return;
    const shared = new SharedArrayBuffer(16 + 1024);
    const header = new Int32Array(shared, 0, 4);
    try {
      worker.postMessage({ type: "close", shared });
      Atomics.wait(header, 0, 0, 5_000);
    } catch (error) {
      sessionDiagnostic("merge-tree-session-close-error", {
        sessionId: this.sessionId,
        message: error.message,
      });
    }
    worker.terminate();
    worker.unref();
    sessionDiagnostic("merge-tree-session-closed", { sessionId: this.sessionId });
  }
}
