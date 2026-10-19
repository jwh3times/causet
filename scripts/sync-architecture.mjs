import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The generated tables of docs/architecture.md. The module table lists every
// source file of the Rust crates and of the npm launcher, each with the first
// sentence of its own header comment and the modules and crates it uses; the
// schema table is RECORD_FAMILIES as native/model/src/registry.rs declares it.
// Both are read from the source rather than from a build, so CI's static
// checks can run them. Until #243 the modules were the JavaScript CLI's, and
// their descriptions lived in docs/architecture-modules.json.

const defaultRoot = fileURLToPath(new URL("../", import.meta.url));

/** The directories whose files the module table lists, crates in dependency order. */
export const SOURCE_ROOTS = ["native/core/src", "native/model/src", "native/engine/src", "native/store/src", "native/cli/src", "bin/native"];
const CRATES = { causet_core: "causet-core", causet_model: "causet-model", causet_engine: "causet-engine", causet_store: "causet-store" };

function sourceFiles(root, directory) {
  const full = path.join(root, directory);
  if (!fs.existsSync(full)) return [];
  return fs.readdirSync(full, { withFileTypes: true }).flatMap((entry) => {
    const file = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return sourceFiles(root, file);
    return entry.isFile() && /\.(?:rs|js|exe)$/.test(entry.name) ? [file] : [];
  }).sort();
}

/**
 * The header comment's first paragraph: a Rust file's leading `//!` lines, or
 * a launcher file's first `//` lines after its `#!` and "use strict".
 */
function header(text, file) {
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  const rust = file.endsWith(".rs");
  let index = 0;
  if (!rust) {
    while (index < lines.length && (/^#!/.test(lines[index]) || /^"use strict";$/.test(lines[index]) || lines[index].trim() === "")) index += 1;
  }
  const prefix = rust ? /^\/\/!\s?/ : /^\/\/\s?/;
  const paragraph = [];
  for (; index < lines.length && prefix.test(lines[index]); index += 1) {
    const line = lines[index].replace(prefix, "");
    if (line.trim() === "") break;
    paragraph.push(line.trim());
  }
  return paragraph.join(" ");
}

/** The first sentence of a header: up to the first full stop followed by a space. */
function firstSentence(paragraph) {
  const match = /^(.*?\.)(?=\s|$)/.exec(paragraph);
  return match ? match[1] : paragraph;
}

function uses(text, file) {
  const own = path.basename(file).replace(/\.[^.]+$/, "");
  const names = new Set();
  if (file.endsWith(".rs")) {
    for (const match of text.matchAll(/\bcrate::([a-z_][a-z0-9_]*)/g)) if (match[1] !== own) names.add(`\`${match[1]}\``);
    for (const [crate, name] of Object.entries(CRATES)) if (new RegExp(`\\b${crate}\\b`).test(text)) names.add(name);
  } else {
    for (const match of text.matchAll(/require\("\.\/([a-z-]+)\.js"\)/g)) names.add(`\`${match[1]}.js\``);
  }
  return names.size ? [...names].sort().join(", ") : "None";
}

export function moduleTable(root) {
  const rows = SOURCE_ROOTS.flatMap((directory) => sourceFiles(root, directory)).map((file) => {
    const text = fs.readFileSync(path.join(root, file), "utf8");
    const responsibility = firstSentence(header(text, file));
    if (!responsibility) throw new Error(`${file} has no header comment; begin it with one that says what the file is for`);
    return `| \`${file}\` | ${responsibility.replaceAll("|", "\\|")} | ${uses(text, file)} |`;
  });
  return ["| File | Responsibility | Uses |", "| --- | --- | --- |", ...rows].join("\n");
}

/** RECORD_FAMILIES as `native/model/src/registry.rs` declares it, by family name. */
export function recordFamilies(root) {
  const source = fs.readFileSync(path.join(root, "native/model/src/registry.rs"), "utf8");
  const block = /pub const RECORD_FAMILIES: &\[Family\] = &\[([\s\S]*?)\n\];/.exec(source);
  if (!block) throw new Error("native/model/src/registry.rs no longer declares RECORD_FAMILIES");
  const versions = (text) => text.split(",").map((item) => item.trim()).filter(Boolean).map(Number);
  const families = new Map();
  for (const match of block[1].matchAll(/Family \{\s*name: "([^"]+)",\s*scope: "([^"]+)",\s*registered: &\[([^\]]*)\],\s*readable: &\[([^\]]*)\],\s*written: &\[([^\]]*)\],\s*unknown_version: "([^"]+)",\s*store: "([^"]+)",\s*\}/g)) {
    const [, name, scope, registered, readable, written, unknownVersion, store] = match;
    families.set(name, { scope, registered: versions(registered), readable: versions(readable), written: versions(written), unknownVersion, store });
  }
  if (families.size !== (block[1].match(/Family \{/g) ?? []).length) {
    throw new Error("A RECORD_FAMILIES entry in native/model/src/registry.rs is not in the form this script reads");
  }
  return families;
}

export function schemaTable(families) {
  const versions = (values) => values.map((version) => `v${version}`).join(", ");
  return [
    "| Family | Readable versions | Written versions | Store | Scope |",
    "| --- | --- | --- | --- | --- |",
    ...[...families].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([family, policy]) =>
      `| \`${family}\` | ${versions(policy.readable)} | ${versions(policy.written)} | \`${policy.store}\` | \`${policy.scope}\` |`),
  ].join("\n");
}

export function replaceTable(document, name, table) {
  const start = `<!-- generated:${name}:start -->`;
  const end = `<!-- generated:${name}:end -->`;
  const before = document.split(start);
  const after = document.split(end);
  if (before.length !== 2 || after.length !== 2 || document.indexOf(start) >= document.indexOf(end)) {
    throw new Error(`Expected exactly one ordered marker pair for ${name}`);
  }
  return `${before[0]}${start}\n${table}\n${end}${after[1]}`;
}

export function syncArchitecture(root = defaultRoot, check = false) {
  const file = path.join(root, "docs/architecture.md");
  const original = fs.readFileSync(file, "utf8");
  const normalized = original.replaceAll("\r\n", "\n");
  let updated = replaceTable(normalized, "modules", moduleTable(root));
  updated = replaceTable(updated, "schemas", schemaTable(recordFamilies(root)));
  if (updated === normalized) return false;
  if (check) throw new Error("Architecture tables are stale; run npm run sync:architecture");
  fs.writeFileSync(file, original.includes("\r\n") ? updated.replaceAll("\n", "\r\n") : updated);
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.slice(2).some((arg) => arg !== "--check")) throw new Error("Usage: sync-architecture.mjs [--check]");
    const changed = syncArchitecture(defaultRoot, process.argv.includes("--check"));
    console.log(changed ? "Updated architecture tables." : "Architecture tables are current.");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
