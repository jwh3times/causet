/**
 * The Rust record model (`native/model`, issue #142) as the suites reach it:
 * the `model-probe` executable, which answers one JSON request per line. The
 * Rust model is the authority for the records' rules since #243.
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
  process.platform === "win32" ? "model-probe.exe" : "model-probe");

export const available = fs.existsSync(executable);
export const unavailableReason = "no Rust model probe; run node scripts/build-native.mjs";

/** Answer every request, in order, from one probe process. */
export function probe(requests) {
  if (!requests.length) return [];
  if (!available) throw new Error(unavailableReason);
  const result = spawnSync(executable, [], {
    input: `${requests.map((request) => JSON.stringify(request)).join("\n")}\n`,
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`model-probe exited ${result.status}: ${result.stderr}`);
  const replies = result.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  if (replies.length !== requests.length) {
    throw new Error(`model-probe answered ${replies.length} of ${requests.length} requests`);
  }
  return replies;
}

let registryReply;

/**
 * The Rust model's registries: record families, resource bounds, error codes,
 * identifier namespaces and the profile and algorithm names.
 */
export function registry() {
  registryReply ??= probe([{ op: "registry" }])[0];
  return registryReply;
}

/** The SHA-256 of a document's hashed payload, as `bundleHash` computed it. */
export function hashedSha256(document) {
  const [reply] = probe([{ op: "hashed", text: JSON.stringify(document) }]);
  if (reply.error) throw new Error(reply.error);
  return reply.sha256;
}
