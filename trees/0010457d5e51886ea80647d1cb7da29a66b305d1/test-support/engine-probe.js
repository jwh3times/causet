/**
 * The Rust Git engine (`native/engine`, issue #143) as the suites reach it:
 * the `engine-probe` executable, which answers one JSON request per line. The
 * JavaScript engine stays the authority; `run` below answers the same request
 * with `src/engine.js`, so a suite can hold the two to the same values and the
 * same process counts.
 *
 * `available` is false until `node scripts/build-native.mjs` (or
 * `cargo build --release`) has built the probe, and the suites then skip.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as engine from "../src/engine.js";
import * as git from "../src/git.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const executable = path.join(root, "native/target/release",
  process.platform === "win32" ? "engine-probe.exe" : "engine-probe");

export const available = fs.existsSync(executable);
export const unavailableReason = "no Rust engine probe; run node scripts/build-native.mjs";

/** Answer every request, in order, from one probe process. */
export function probe(requests, env) {
  if (!requests.length) return [];
  const result = spawnSync(executable, [], {
    input: `${requests.map((request) => JSON.stringify(request)).join("\n")}\n`,
    encoding: "utf8",
    env,
    maxBuffer: 512 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`engine-probe exited ${result.status}: ${result.stderr}`);
  const replies = result.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  if (replies.length !== requests.length) {
    throw new Error(`engine-probe answered ${replies.length} of ${requests.length} requests`);
  }
  return replies;
}

/** `canonicalValue` of `src/engine.js`: sorted members, bytes as a digest. */
export function canonicalValue(value) {
  if (Buffer.isBuffer(value)) {
    return { bytes: value.length, sha256: createHash("sha256").update(value).digest("hex") };
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort()
      .map((key) => [key, canonicalValue(value[key])]));
  }
  return value === undefined ? null : value;
}

/** The metrics both engines must agree on: every count, no timings. */
export function comparableMetrics(metrics) {
  return {
    count: metrics.count,
    processes: metrics.processes,
    sessionQueries: metrics.sessionQueries,
    cacheHits: metrics.cacheHits,
    failed: metrics.failed,
    fallbacks: metrics.fallbacks,
    nativeReads: metrics.nativeReads,
    directReads: metrics.directReads,
    commands: metrics.byCommand
      .map(({ command, count, processes, sessionQueries, cacheHits }) =>
        ({ command, count, processes, sessionQueries, cacheHits }))
      .sort((left, right) => (left.command < right.command ? -1 : left.command > right.command ? 1 : 0)),
  };
}

function errorValue(error) {
  return {
    code: error?.code ?? null,
    message: error?.message ?? String(error),
    details: error?.details ?? "",
    exitCode: error?.exitCode ?? 1,
  };
}

function call(op, args, options, cwd) {
  if (op === "$run") {
    const result = git.runGit(args[0], { cwd, allowFailure: true });
    return { ok: result.ok, stdout: result.stdout };
  }
  if (op === "$mergeTree") {
    const session = new git.MergeTreeSession(cwd);
    try {
      return args.map(([base, ours, theirs]) => {
        try {
          const { clean, tree } = session.merge(base, ours, theirs);
          return { clean, tree };
        } catch (error) {
          return { error: { message: error.message, sessionFailure: error.sessionFailure ?? null } };
        }
      });
    } finally {
      session.close();
    }
  }
  return canonicalValue(engine[op](...args, cwd, ...(options ? [options] : [])));
}

/** What the probe answers for `request`, computed with the JavaScript engine. */
export function run(request) {
  if (request.differential) {
    try {
      return engine.runDifferential(request.differential);
    } catch (error) {
      return { error: errorValue(error) };
    }
  }
  const { cwd } = request;
  if (request.warm) {
    git.withReadEngine("git", () => {
      try { engine.repoContext(cwd); } catch { /* the probe ignores it too */ }
      try { engine.gitVersion(cwd); } catch { /* the probe ignores it too */ }
    });
  }
  const answer = () => request.calls.map(({ op, args = [], options }) => {
    const collector = git.beginGitMetrics(op);
    const reply = {};
    try {
      reply.value = git.withReadEngine(request.engine ?? "git", () => call(op, args, options, cwd));
    } catch (error) {
      reply.error = errorValue(error);
    }
    reply.metrics = comparableMetrics(git.endGitMetrics(collector));
    return reply;
  });
  return { results: request.session ? git.withGitObjectSession(cwd, answer) : answer() };
}
