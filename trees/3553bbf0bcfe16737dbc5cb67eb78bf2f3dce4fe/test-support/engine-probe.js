/**
 * The Rust Git engine (`native/engine`, issue #143) as the suites reach it:
 * the `engine-probe` executable, which answers one JSON request per line.
 * Until #243 a JavaScript `run` here answered the same requests with
 * `src/engine.js`; its answers are frozen in `test/fixtures/oracle/engine.json`.
 *
 * `available` is false until `node scripts/build-native.mjs` (or
 * `cargo build --release`) has built the probe, and the suites then skip.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const executable = path.join(root, "native/target/release",
  process.platform === "win32" ? "engine-probe.exe" : "engine-probe");

export const available = fs.existsSync(executable);
export const unavailableReason = "no Rust engine probe; run node scripts/build-native.mjs";

/** Answer every request, in order, from one probe process. */
export function probe(requests, env) {
  if (!requests.length) return [];
  if (!available) throw new Error(unavailableReason);
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
