#!/usr/bin/env node
// Authored .claude/agents/*.md -> generated .codex/agents/*.toml.
// Authored .agents/skills/ -> generated .claude/skills/ (complete trees).
// Run npm run sync:agents to regenerate; append -- --check to verify only.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const defaultRoot = path.resolve(path.dirname(scriptPath), "..");
const TARGETS = [".codex/agents", ".claude/skills"];
const normalize = (value) => value.replaceAll("\r\n", "\n");

function listFiles(root, relative) {
  const absolute = path.join(root, relative);
  if (!fs.existsSync(absolute)) return [];
  if (fs.lstatSync(absolute).isSymbolicLink()) throw new Error(`${relative}: mirror directories must not be symlinks`);
  return fs.readdirSync(absolute, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const file = `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`${file}: mirror entries must not be symlinks`);
      if (entry.isDirectory()) return listFiles(root, file);
      return entry.isFile() ? [file] : [];
    });
}

export function splitFrontmatter(raw, file) {
  const normalized = normalize(raw);
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized);
  if (!match) throw new Error(`${file}: expected YAML frontmatter delimited by '---'`);
  const data = new Map();
  for (const line of match[1].split("\n")) {
    const field = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!field || !["name", "description"].includes(field[1])) continue;
    let value = field[2].trim();
    if (value.startsWith('"')) {
      try { value = JSON.parse(value); } catch { throw new Error(`${file}: use JSON-compatible double-quoted scalars`); }
    } else if (value.startsWith("'")) {
      if (value.length < 2 || !value.endsWith("'")) throw new Error(`${file}: unterminated quoted scalar`);
      value = value.slice(1, -1).replaceAll("''", "'");
    }
    if (!value || /^[>|]/.test(value) || /[\r\n]/.test(value)) {
      throw new Error(`${file}: ${field[1]} must be a nonempty single-line scalar`);
    }
    data.set(field[1], value);
  }
  return { data, body: normalized.slice(match[0].length).trim() };
}

export function tomlLiteralMultiline(body, file, field) {
  if (body.includes("'''")) throw new Error(`${file}: ${field} contains a TOML literal delimiter (''')`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(body)) {
    throw new Error(`${file}: ${field} contains an unsupported control character`);
  }
  // A separate closing line keeps a trailing apostrophe clear of the delimiter.
  return `'''\n${body}\n'''`;
}

export function injectSkillBanner(file, raw) {
  const normalized = normalize(raw);
  if (!normalized.startsWith("---\n")) throw new Error(`${file}: expected SKILL.md to open with frontmatter`);
  return normalized.replace(/^---\n/, `---\n# GENERATED — do not edit. Source: ${file} — regenerate with 'npm run sync:agents'.\n`);
}

export function buildMirrors(root = defaultRoot) {
  for (const directory of [".agents", ".claude", ".codex"]) {
    const absolute = path.join(root, directory);
    try {
      if (fs.lstatSync(absolute).isSymbolicLink()) throw new Error(`${directory}: mirror parents must not be symlinks`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const mirrors = new Map();
  for (const file of listFiles(root, ".claude/agents")) {
    if (!/^\.claude\/agents\/[^/]+\.md$/.test(file)) continue;
    const { data, body } = splitFrontmatter(fs.readFileSync(path.join(root, file), "utf8"), file);
    for (const field of ["name", "description"]) {
      if (!data.get(field)) throw new Error(`${file}: frontmatter is missing '${field}'`);
    }
    if (!body) throw new Error(`${file}: instruction body is empty`);
    // Claude model IDs and tool names do not transfer to Codex.
    mirrors.set(file.replace(".claude/agents/", ".codex/agents/").replace(/\.md$/, ".toml"), [
      `# Generated from ${file} by scripts/sync-agent-assets.mjs — do not edit by hand.`,
      `name = ${JSON.stringify(data.get("name"))}`,
      `description = ${JSON.stringify(data.get("description"))}`,
      `developer_instructions = ${tomlLiteralMultiline(body, file, "developer_instructions")}`,
      "",
    ].join("\n"));
  }
  for (const file of listFiles(root, ".agents/skills")) {
    const raw = fs.readFileSync(path.join(root, file));
    mirrors.set(file.replace(".agents/skills/", ".claude/skills/"),
      path.basename(file) === "SKILL.md" ? injectSkillBanner(file, raw.toString("utf8")) : raw);
  }
  return mirrors;
}

export function syncMirrors(root = defaultRoot, { check = false } = {}) {
  // Validate all sources and target entries before changing any file.
  const mirrors = buildMirrors(root);
  const targets = TARGETS.flatMap((directory) => listFiles(root, directory));
  const stale = [];
  for (const [target, content] of mirrors) {
    const absolute = path.join(root, target);
    const current = fs.existsSync(absolute) ? fs.readFileSync(absolute) : null;
    const matches = current !== null && (Buffer.isBuffer(content)
      ? current.equals(content) : normalize(current.toString("utf8")) === content);
    if (matches) continue;
    if (check) stale.push(current === null ? `${target} (missing)` : target);
    else {
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, content);
    }
  }
  for (const target of targets.filter((file) => !mirrors.has(file))) {
    if (check) stale.push(`${target} (orphaned)`);
    else fs.rmSync(path.join(root, target));
  }
  return { stale, count: mirrors.size };
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try {
    const check = process.argv.includes("--check");
    const { stale, count } = syncMirrors(defaultRoot, { check });
    if (stale.length) {
      console.error(`Harness mirrors are out of date:\n${stale.join("\n")}\nRun npm run sync:agents.`);
      process.exitCode = 1;
    } else console.log(`${check ? "Verified" : "Synced"} ${count} harness mirror(s).`);
  } catch (error) {
    console.error(`sync-agent-assets: ${error.message}`);
    process.exitCode = 1;
  }
}
