#!/usr/bin/env node
/**
 * Remove the demonstration fixtures from the OS temporary directory.
 *
 * The `demo:*` scripts deliberately leave their repositories behind — each ends
 * by printing `Inspect it with: cd <path>`, and that is the point of a
 * demonstration. Nothing has ever removed them, so they accumulate: one per
 * demo per run, indefinitely. Three release-gate runs leave eighteen.
 *
 * Listing is the default and `--apply` removes, matching `vlab workspace prune`
 * and `vlab metadata import`: a command that deletes directories should say
 * what it would delete before it does it.
 *
 * Do not run this while a demo, suite, or benchmark is in progress. It removes
 * fixtures by name, not by whether something is using them.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const temporaryDir = os.tmpdir();

/**
 * The prefixes to sweep, read out of the scripts themselves rather than listed
 * here. A hardcoded list silently stops covering a demo the day someone adds
 * one, and the failure is invisible: fixtures simply keep accumulating.
 * `test/repository-hygiene.test.js` asserts this derivation still finds them.
 */
export function fixturePrefixes() {
  const prefixes = new Set();
  const self = path.basename(fileURLToPath(import.meta.url));
  for (const name of fs.readdirSync(scriptDir).filter((f) => f.endsWith(".mjs"))) {
    // Skip this file: it describes the scan, so its own prose about the
    // patterns would otherwise be read as one of them.
    if (name === self) continue;
    const source = fs.readFileSync(path.join(scriptDir, name), "utf8");
    for (const match of source.matchAll(/mkdtempSync\(\s*path\.join\(\s*os\.tmpdir\(\)\s*,\s*(?:FIXTURE_PREFIX|"([^"]+)")/g)) {
      if (match[1]) prefixes.add(match[1]);
    }
    // `const FIXTURE_PREFIX = "..."` used at the call site above.
    for (const match of source.matchAll(/FIXTURE_PREFIX\s*=\s*"([^"]+)"/g)) {
      prefixes.add(match[1]);
    }
  }
  // Only accept something shaped like one of this project's fixture prefixes.
  // A regex over source text will eventually match prose; this makes that
  // harmless rather than a directory nobody meant to sweep.
  return [...prefixes].filter((prefix) => prefix.startsWith("vcs-lab-")).sort();
}

/** Every fixture directory in the temporary directory matching a prefix. */
export function findFixtures(prefixes, { all = false } = {}) {
  let entries;
  try {
    entries = fs.readdirSync(temporaryDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const matches = all
      ? entry.name.startsWith("vcs-lab-")
      : prefixes.some((prefix) => entry.name.startsWith(prefix));
    if (!matches) continue;
    const absolute = path.join(temporaryDir, entry.name);
    // Never step outside the temporary directory, whatever the name resolves
    // to: a fixture is always one level down, and anything else is not ours.
    const resolved = path.resolve(absolute);
    if (path.dirname(resolved) !== path.resolve(temporaryDir)) continue;
    let stat;
    try {
      stat = fs.statSync(resolved);
    } catch {
      continue;
    }
    found.push({ name: entry.name, path: resolved, modified: stat.mtime });
  }
  return found.sort((left, right) => left.name.localeCompare(right.name));
}

function directoryBytes(target) {
  let total = 0;
  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const next = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(next);
      } else if (entry.isFile()) {
        try {
          total += fs.statSync(next).size;
        } catch {
          // A file that vanished mid-walk contributes nothing.
        }
      }
    }
  };
  walk(target);
  return total;
}

function human(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function ageOf(modified) {
  const minutes = Math.round((Date.now() - modified.getTime()) / 60_000);
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / (60 * 24))}d`;
}

function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const all = args.includes("--all");
  const unknown = args.filter((item) => !["--apply", "--all"].includes(item));
  if (unknown.length) {
    console.error(`Unknown option: ${unknown.join(" ")}. Use --apply and/or --all.`);
    process.exit(2);
  }

  const prefixes = fixturePrefixes();
  const fixtures = findFixtures(prefixes, { all });

  if (fixtures.length === 0) {
    console.log(
      `No ${all ? "vcs-lab" : "demonstration"} fixtures in ${temporaryDir}.`,
    );
    return;
  }

  let totalBytes = 0;
  const rows = fixtures.map((fixture) => {
    const bytes = directoryBytes(fixture.path);
    totalBytes += bytes;
    return { ...fixture, bytes };
  });

  const width = Math.max(...rows.map((row) => row.name.length));
  for (const row of rows) {
    const status = apply ? "removed" : "would remove";
    console.log(
      `${status.padEnd(12)} ${row.name.padEnd(width)}  ${ageOf(row.modified).padStart(4)}  ${human(row.bytes).padStart(9)}`,
    );
    if (apply) fs.rmSync(row.path, { recursive: true, force: true });
  }

  console.log(
    `\n${apply ? "Removed" : "Would remove"} ${rows.length} fixture${rows.length === 1 ? "" : "s"}, ${human(totalBytes)}, from ${temporaryDir}.`,
  );
  if (!apply) {
    console.log("Re-run with --apply to remove them.");
  }
  if (!all) {
    console.log(
      "Test and benchmark fixtures clean up after themselves; --all also sweeps " +
      "any left by an interrupted run.",
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("clean-demo-fixtures.mjs")) {
  main();
}
