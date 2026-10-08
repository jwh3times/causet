import { spawn } from "node:child_process";
import { parentPort, workerData } from "node:worker_threads";

/**
 * Owns one `git merge-tree --stdin` process for the merge-tree forecast
 * engine. Each request is one `<base> -- <ours> <theirs>` line; Git answers
 * with `<status>\0<tree>\0` followed by conflict sections for a conflicted
 * merge and a final `\0` record terminator. A clean merge is therefore exactly
 * `1\0<tree>\0\0`. The engine abandons the session on the first conflicted
 * step, so a conflicted record is resolved as soon as its status and tree are
 * known and the session accepts no further requests.
 *
 * Git flushes each record before reading the next line only from 2.49; older
 * versions keep the records in the process's stdio buffer until it exits, so a
 * session would wait out its timeout without ever seeing an answer. The
 * worker therefore learns the exact Git version from the trace2 `version`
 * event the process writes to stderr as it starts (Git 2.22+, before it reads
 * any input) and refuses the first request on a Git older than the engine
 * needs, at the cost of no extra process. Requests queue until the version is
 * known.
 */
const gitCommand = workerData.gitCommand ?? "git";
const requiredGit = workerData.requiredGit ?? null;
const spoofedGitVersion = workerData.spoofGitVersion ?? null;
const VERSION_WAIT_MS = 10_000;
const STDERR_LIMIT = 64 * 1024;

const git = spawn(gitCommand, ["merge-tree", "--stdin"], {
  cwd: workerData.cwd,
  env: {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    // The trace2 event stream on stderr carries the version event; brief mode
    // drops per-event timestamps and source locations. Git's own messages
    // stay on stderr as plain lines and are separated below.
    GIT_TRACE2_EVENT: "2",
    GIT_TRACE2_EVENT_BRIEF: "1",
    // Read .gitattributes from the simulated target tree, as the worktree
    // simulator's checkout does, rather than from the caller's checkout
    // (Git 2.43+; older Git ignores the variable and uses the checkout).
    ...(workerData.attrSource ? { GIT_ATTR_SOURCE: workerData.attrSource } : {}),
  },
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});

let stdout = Buffer.alloc(0);
let stderr = "";
let stderrRemainder = "";
let startupError = null;
let gitExited = false;
let gitClosed = false;
let sessionUnusable = null;
let gitVersionText = null;
/** `pending` | `ok` | `too-old` | `unknown` (no version event in time). */
let versionState = "pending";
const pending = [];

function parseVersion(text) {
  const match = String(text ?? "").match(/(\d+)\.(\d+)/);
  return match ? [Number(match[1]), Number(match[2])] : null;
}

/**
 * Whether `text` names a Git at least `required` (`"major.minor"`). A
 * version that cannot be parsed counts as new enough so that Git itself
 * reports any failure, as `gitAtLeast` in git.js does.
 */
function versionAtLeast(required, text) {
  const parts = parseVersion(text);
  if (!parts || !required) return true;
  const [wantMajor, wantMinor] = required.split(".").map(Number);
  return parts[0] > wantMajor || (parts[0] === wantMajor && parts[1] >= wantMinor);
}

function tooOldError() {
  const error = new Error(
    `Git ${gitVersionText} is older than the ${requiredGit} the merge-tree engine needs (git merge-tree --stdin flushes each record only from ${requiredGit}).`,
  );
  error.sessionFailure = "too-old";
  error.gitVersion = gitVersionText;
  return error;
}

function writeRequest(request) {
  if (request.written) return;
  request.written = true;
  git.stdin.write(request.line, "utf8", (error) => {
    if (!error) return;
    const index = pending.indexOf(request);
    if (index >= 0) pending.splice(index, 1);
    request.reject(error);
  });
}

function settleVersion(state) {
  if (versionState !== "pending") return;
  versionState = state;
  clearTimeout(versionTimer);
  if (startupError || gitExited) return;
  if (state === "too-old") {
    const error = tooOldError();
    sessionUnusable = error.message;
    while (pending.length) pending.shift().reject(error);
    // No request was written; end the input so the process exits cleanly.
    git.stdin.end();
    return;
  }
  for (const request of pending) writeRequest(request);
}

const versionTimer = setTimeout(() => settleVersion("unknown"), VERSION_WAIT_MS);
versionTimer.unref();

function observeVersion(text) {
  if (gitVersionText !== null) return;
  gitVersionText = String(text);
  settleVersion(versionAtLeast(requiredGit, gitVersionText) ? "ok" : "too-old");
}

function consumeStderrLine(line) {
  if (line.startsWith("{")) {
    let event = null;
    try {
      event = JSON.parse(line);
    } catch {
      event = null;
    }
    if (event && typeof event.event === "string") {
      if (event.event === "version" && !spoofedGitVersion) observeVersion(event.exe);
      return;
    }
  }
  stderr += `${line}\n`;
  if (stderr.length > STDERR_LIMIT) stderr = stderr.slice(-STDERR_LIMIT);
}

git.stderr.setEncoding("utf8");
git.stderr.on("data", (chunk) => {
  stderrRemainder += chunk;
  let newline = stderrRemainder.indexOf("\n");
  while (newline >= 0) {
    consumeStderrLine(stderrRemainder.slice(0, newline).replace(/\r$/, ""));
    stderrRemainder = stderrRemainder.slice(newline + 1);
    newline = stderrRemainder.indexOf("\n");
  }
});
git.on("error", (error) => {
  startupError = error;
  clearTimeout(versionTimer);
  while (pending.length) pending.shift().reject(error);
});
git.on("exit", (code, signal) => {
  gitExited = true;
  clearTimeout(versionTimer);
  if (stderrRemainder) {
    consumeStderrLine(stderrRemainder.replace(/\r$/, ""));
    stderrRemainder = "";
  }
  if (pending.length === 0) return;
  const error = new Error(
    `git merge-tree session exited with status ${code ?? signal}.${stderr.trim() ? ` ${stderr.trim()}` : ""}`,
  );
  error.sessionFailure = "exited";
  while (pending.length) pending.shift().reject(error);
});
git.on("close", () => {
  gitClosed = true;
});
// A write after the process has gone away surfaces here (EPIPE); without a
// listener it would crash the worker and leave the caller waiting for the
// session timeout.
git.stdin.on("error", (error) => {
  while (pending.length) pending.shift().reject(error);
});
if (spoofedGitVersion) observeVersion(spoofedGitVersion);

function readToken(offset) {
  const end = stdout.indexOf(0x00, offset);
  if (end < 0) return null;
  return { value: stdout.subarray(offset, end).toString("utf8"), next: end + 1 };
}

function parseResponses() {
  while (pending.length) {
    const status = readToken(0);
    if (!status) return;
    const tree = readToken(status.next);
    if (!tree) return;
    const request = pending[0];
    if (!/^[0-9a-f]{40,64}$/.test(tree.value)) {
      pending.shift();
      sessionUnusable = `Unexpected git merge-tree session response: ${status.value} ${tree.value}`;
      request.reject(new Error(sessionUnusable));
      stdout = Buffer.alloc(0);
      continue;
    }
    if (status.value === "1") {
      if (stdout.length <= tree.next) return;
      if (stdout[tree.next] !== 0x00) {
        pending.shift();
        sessionUnusable = "Git returned a malformed merge-tree session record.";
        request.reject(new Error(sessionUnusable));
        stdout = Buffer.alloc(0);
        continue;
      }
      stdout = stdout.subarray(tree.next + 1);
      pending.shift();
      request.resolve({ clean: true, tree: tree.value });
      continue;
    }
    if (status.value === "0") {
      // The rest of a conflicted record is not consumed: the engine falls back
      // to the worktree simulator and closes this session.
      sessionUnusable = "The merge-tree session reported a conflict and accepts no further requests.";
      stdout = Buffer.alloc(0);
      pending.shift();
      request.resolve({ clean: false, tree: tree.value });
      while (pending.length) pending.shift().reject(new Error(sessionUnusable));
      continue;
    }
    pending.shift();
    sessionUnusable = `Unexpected git merge-tree session status: ${status.value}`;
    request.reject(new Error(sessionUnusable));
    stdout = Buffer.alloc(0);
  }
}

git.stdout.on("data", (chunk) => {
  stdout = Buffer.concat([stdout, chunk]);
  parseResponses();
});

function merge(base, ours, theirs) {
  if (startupError) return Promise.reject(startupError);
  if (versionState === "too-old") return Promise.reject(tooOldError());
  if (sessionUnusable) return Promise.reject(new Error(sessionUnusable));
  if (gitExited) {
    return Promise.reject(new Error("The git merge-tree session process has exited."));
  }
  return new Promise((resolve, reject) => {
    const request = {
      resolve,
      reject,
      line: `${base} -- ${ours} ${theirs}\n`,
      written: false,
    };
    pending.push(request);
    // Until the version is known the request waits; a too-old Git rejects it
    // before anything is written.
    if (versionState !== "pending") writeRequest(request);
  });
}

function respond(shared, value) {
  const header = new Int32Array(shared, 0, 4);
  const payload = new Uint8Array(shared, 16);
  let encoded = Buffer.from(JSON.stringify(value), "utf8");
  if (encoded.length > payload.length) {
    encoded = Buffer.from(
      JSON.stringify({
        ok: false,
        error: "Git merge-tree session response exceeded its shared buffer.",
      }),
      "utf8",
    );
  }
  payload.set(encoded);
  Atomics.store(header, 1, encoded.length);
  Atomics.store(header, 0, 1);
  Atomics.notify(header, 0);
}

function closeSession(shared) {
  let finished = false;
  const finish = (response = { ok: true }) => {
    if (finished) return;
    finished = true;
    respond(shared, response);
    process.exit(0);
  };
  if (gitClosed) {
    finish();
    return;
  }
  git.once("close", () => finish());
  if (!git.stdin.destroyed && !git.stdin.writableEnded) git.stdin.end();
  const terminate = setTimeout(() => {
    if (finished) return;
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
      error: "Git merge-tree session process did not close within the shutdown deadline.",
    }),
    4_000,
  );
  fallback.unref();
}

parentPort.on("message", async (message) => {
  if (message.type === "close") {
    closeSession(message.shared);
    return;
  }
  try {
    const result = await merge(
      String(message.base),
      String(message.ours),
      String(message.theirs),
    );
    respond(message.shared, { ok: true, result, gitVersion: gitVersionText });
  } catch (error) {
    respond(message.shared, {
      ok: false,
      error: error?.message ?? String(error),
      sessionFailure: error?.sessionFailure ?? null,
      gitVersion: error?.gitVersion ?? gitVersionText,
    });
  }
});
