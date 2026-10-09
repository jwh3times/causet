import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RECORD_FAMILIES } from "../src/schemas.js";

const defaultRoot = fileURLToPath(new URL("../", import.meta.url));

function sourceFiles(root, directory) {
  return fs.readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const file = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return sourceFiles(root, file);
    return entry.isFile() && /\.(?:js|mjs)$/.test(file) ? [file] : [];
  }).sort();
}

export function moduleTable(root) {
  const descriptions = JSON.parse(fs.readFileSync(path.join(root, "docs/architecture-modules.json"), "utf8"));
  const files = [...sourceFiles(root, "bin"), ...sourceFiles(root, "src")];
  const missing = files.filter((file) => !Object.hasOwn(descriptions, file));
  const stale = Object.keys(descriptions).filter((file) => !files.includes(file));
  if (missing.length || stale.length) {
    throw new Error(`Module descriptions disagree with the source tree; missing: ${missing.join(", ") || "none"}; stale: ${stale.join(", ") || "none"}`);
  }
  const rows = files.map((file) => {
    const { responsibility, dependencies } = descriptions[file];
    for (const value of [responsibility, dependencies]) {
      if (typeof value !== "string" || !value.trim() || /[\r\n|]/.test(value)) {
        throw new Error(`${file}: descriptions must be nonempty single-line Markdown table cells`);
      }
    }
    return `| \`${file}\` | ${responsibility} | ${dependencies} |`;
  });
  return ["| File | Responsibility | Important dependencies |", "| --- | --- | --- |", ...rows].join("\n");
}

export function schemaTable(families = RECORD_FAMILIES) {
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
  updated = replaceTable(updated, "schemas", schemaTable());
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
