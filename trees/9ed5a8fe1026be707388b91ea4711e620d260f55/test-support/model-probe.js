/**
 * The Rust record model (`native/model`, issue #142) as the suites reach it:
 * the `model-probe` executable, which answers one JSON request per line. The
 * JavaScript modules stay the authority; suites put both on the same inputs.
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

/** What `validateNoteRecord` returns, or `{ thrown: true }`, in the probe's shape. */
export function jsValidation(validate, record, format) {
  try {
    return { errors: validate(record, format) };
  } catch {
    return { thrown: true };
  }
}

/** What `referencedObjectsForRecord` returns, or `{ thrown: true }`. */
export function jsReferences(references, record) {
  try {
    return { objects: references(record) };
  } catch {
    return { thrown: true };
  }
}
