import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { parentPort, threadId, workerData } from "node:worker_threads";

function sessionDiagnostic(event, details = {}) {
  if (process.env.VLAB_GIT_SESSION_DIAGNOSTICS !== "1") return;
  const line = `[vlab session-worker] ${JSON.stringify({
    at: new Date().toISOString(),
    pid: process.pid,
    threadId,
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

const gitCommand = workerData.gitCommand ?? "git";
const git = spawn(gitCommand, ["cat-file", "--batch-command"], {
  cwd: workerData.cwd,
  env: {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
  },
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});

let stdout = Buffer.alloc(0);
let stderr = "";
let startupError = null;
let gitClosed = false;
const pending = [];

sessionDiagnostic("worker-start", {
  cwd: workerData.cwd,
  gitCommand,
});

git.stderr.setEncoding("utf8");
git.stderr.on("data", (chunk) => {
  stderr += chunk;
  if (stderr.length > 64 * 1024) stderr = stderr.slice(-64 * 1024);
  sessionDiagnostic("git-stderr", {
    bytes: Buffer.byteLength(chunk, "utf8"),
    pending: pending.length,
    tail: stderr.slice(-512),
  });
});
git.on("error", (error) => {
  startupError = error;
  sessionDiagnostic("git-error", {
    message: error.message,
    code: error.code ?? null,
    pending: pending.length,
  });
  while (pending.length) pending.shift().reject(error);
});
git.on("exit", (code, signal) => {
  sessionDiagnostic("git-exit", {
    code,
    signal,
    pending: pending.length,
    stderr: stderr.trim() || null,
  });
  if (pending.length === 0) return;
  const error = new Error(
    `git cat-file session exited with status ${code ?? signal}.${stderr.trim() ? ` ${stderr.trim()}` : ""}`,
  );
  while (pending.length) pending.shift().reject(error);
});
git.on("close", (code, signal) => {
  gitClosed = true;
  sessionDiagnostic("git-close", {
    code,
    signal,
    pending: pending.length,
  });
});

function parseResponse() {
  while (pending.length) {
    const newline = stdout.indexOf(0x0a);
    if (newline < 0) return;
    const header = stdout.subarray(0, newline).toString("utf8");
    const request = pending[0];
    sessionDiagnostic("git-response-header", {
      requestId: request.requestId,
      command: request.command,
      expression: request.expression,
      header,
      bufferedBytes: stdout.length,
      pending: pending.length,
    });
    if (header.endsWith(" missing")) {
      stdout = stdout.subarray(newline + 1);
      pending.shift();
      sessionDiagnostic("request-resolved", {
        requestId: request.requestId,
        command: request.command,
        expression: request.expression,
        exists: false,
      });
      request.resolve({
        expression: request.expression,
        exists: false,
        oid: null,
        type: null,
        size: 0,
        content: null,
      });
      continue;
    }
    const match = header.match(/^([0-9a-f]+) (\S+) (\d+)$/);
    if (!match) {
      pending.shift();
      sessionDiagnostic("request-rejected", {
        requestId: request.requestId,
        command: request.command,
        expression: request.expression,
        error: `Unexpected git cat-file session header: ${header}`,
      });
      request.reject(new Error(`Unexpected git cat-file session header: ${header}`));
      stdout = stdout.subarray(newline + 1);
      continue;
    }
    const size = Number(match[3]);
    if (request.command === "info") {
      stdout = stdout.subarray(newline + 1);
      pending.shift();
      sessionDiagnostic("request-resolved", {
        requestId: request.requestId,
        command: request.command,
        expression: request.expression,
        exists: true,
        infoOnly: true,
      });
      request.resolve({
        expression: request.expression,
        exists: true,
        oid: match[1],
        type: match[2],
        size,
        content: null,
      });
      continue;
    }
    const contentStart = newline + 1;
    const contentEnd = contentStart + size;
    if (stdout.length <= contentEnd) return;
    if (stdout[contentEnd] !== 0x0a) {
      pending.shift();
      sessionDiagnostic("request-rejected", {
        requestId: request.requestId,
        command: request.command,
        expression: request.expression,
        error: "Git returned malformed session object content.",
      });
      request.reject(new Error("Git returned malformed session object content."));
      stdout = stdout.subarray(contentEnd);
      continue;
    }
    const content = stdout.subarray(contentStart, contentEnd);
    stdout = stdout.subarray(contentEnd + 1);
    pending.shift();
    sessionDiagnostic("request-resolved", {
      requestId: request.requestId,
      command: request.command,
      expression: request.expression,
      exists: true,
      size,
    });
    request.resolve({
      expression: request.expression,
      exists: true,
      oid: match[1],
      type: match[2],
      size,
      content: content.toString("base64"),
    });
  }
}

git.stdout.on("data", (chunk) => {
  stdout = Buffer.concat([stdout, chunk]);
  sessionDiagnostic("git-stdout", {
    bytes: chunk.length,
    bufferedBytes: stdout.length,
    pending: pending.length,
  });
  parseResponse();
});

function query(command, expression, requestId) {
  if (startupError) return Promise.reject(startupError);
  return new Promise((resolve, reject) => {
    pending.push({ command, expression, requestId, resolve, reject });
    sessionDiagnostic("git-request-writing", {
      requestId,
      command,
      expression,
      pending: pending.length,
    });
    git.stdin.write(`${command} ${expression}\n`, "utf8", (error) => {
      sessionDiagnostic("git-request-write-callback", {
        requestId,
        command,
        expression,
        ok: !error,
        error: error?.message ?? null,
      });
      if (!error) return;
      const index = pending.findIndex(
        (item) => item.requestId === requestId,
      );
      if (index >= 0) pending.splice(index, 1);
      reject(error);
    });
  });
}

function respond(shared, value, details = {}) {
  const header = new Int32Array(shared, 0, 4);
  const payload = new Uint8Array(shared, 16);
  let encoded = Buffer.from(JSON.stringify(value), "utf8");
  if (encoded.length > payload.length) {
    encoded = Buffer.from(
      JSON.stringify({
        ok: false,
        error: "Git object-session response exceeded its shared buffer.",
        code: "response-too-large",
      }),
      "utf8",
    );
  }
  payload.set(encoded);
  Atomics.store(header, 1, encoded.length);
  Atomics.store(header, 0, 1);
  Atomics.notify(header, 0);
  sessionDiagnostic("shared-response", {
    ...details,
    ok: value?.ok ?? null,
    encodedBytes: encoded.length,
  });
}

function closeGitSession(shared) {
  let finished = false;
  sessionDiagnostic("close-start", {
    pending: pending.length,
    gitExitCode: git.exitCode,
    gitSignalCode: git.signalCode,
  });
  const finish = (response = { ok: true }) => {
    if (finished) return;
    finished = true;
    sessionDiagnostic("close-finish", {
      pending: pending.length,
      ok: response.ok,
      error: response.error ?? null,
    });
    respond(shared, response, { type: "close" });
    process.exit(0);
  };
  if (gitClosed) {
    finish();
    return;
  }
  git.once("close", finish);
  sessionDiagnostic("close-stdin-end", { pending: pending.length });
  git.stdin.end();
  const terminate = setTimeout(() => {
    if (finished) return;
    sessionDiagnostic("close-git-kill", {
      pending: pending.length,
      pid: git.pid ?? null,
      tree: process.platform === "win32",
    });
    if (process.platform === "win32" && Number.isInteger(git.pid)) {
      const killer = spawn(
        "taskkill.exe",
        ["/PID", String(git.pid), "/T", "/F"],
        { stdio: "ignore", windowsHide: true },
      );
      killer.once("error", () => git.kill());
      killer.once("close", (code) => {
        if (code !== 0 && !gitClosed) git.kill();
      });
    } else {
      git.kill();
    }
  }, 2_000);
  terminate.unref();
  const fallback = setTimeout(
    () => finish({
      ok: false,
      error: "Git object-session process did not close within the shutdown deadline.",
    }),
    4_000,
  );
  fallback.unref();
}

parentPort.on("message", async (message) => {
  sessionDiagnostic("parent-message", {
    type: message.type,
    requestId: message.requestId ?? null,
    command: message.command ?? null,
    expressionCount: Array.isArray(message.expressions) ? message.expressions.length : 0,
    pending: pending.length,
  });
  if (message.type === "close") {
    closeGitSession(message.shared);
    return;
  }
  try {
    const expressions = message.expressions.map(String);
    const results = await Promise.all(
      expressions.map((expression, index) =>
        query(message.command, expression, `${message.requestId}.${index + 1}`),
      ),
    );
    respond(message.shared, { ok: true, results }, {
      type: "query",
      requestId: message.requestId,
    });
  } catch (error) {
    const messageText = error?.message ?? String(error);
    sessionDiagnostic("query-failed", {
      requestId: message.requestId,
      error: messageText,
      pending: pending.length,
    });
    respond(
      message.shared,
      { ok: false, error: messageText },
      { type: "query", requestId: message.requestId },
    );
  }
});
