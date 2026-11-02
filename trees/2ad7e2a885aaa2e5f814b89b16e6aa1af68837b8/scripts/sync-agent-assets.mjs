#!/usr/bin/env node
// Mirror the canonical agent skills in .agents/skills into .claude/skills so
// Codex and Claude Code read the same instructions. The canonical copy is
// .agents/skills; .claude/skills is generated and must not be hand-edited.
//
//   node ./scripts/sync-agent-assets.mjs           # write the mirror
//   node ./scripts/sync-agent-assets.mjs --check   # report drift, exit 1 if any
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIRRORS = [{ source: ".agents/skills", target: ".claude/skills" }];
const check = process.argv.includes("--check");

function listFiles(root) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) files.push(path.relative(root, absolute));
    }
  };
  walk(root);
  return files.sort();
}

function sameContent(left, right) {
  return fs.existsSync(left) && fs.existsSync(right) &&
    fs.readFileSync(left).equals(fs.readFileSync(right));
}

let drift = 0;
for (const mirror of MIRRORS) {
  const sourceRoot = path.join(projectRoot, mirror.source);
  const targetRoot = path.join(projectRoot, mirror.target);
  const sourceFiles = listFiles(sourceRoot);
  const targetFiles = listFiles(targetRoot);

  for (const relative of sourceFiles) {
    const from = path.join(sourceRoot, relative);
    const to = path.join(targetRoot, relative);
    if (sameContent(from, to)) continue;
    drift += 1;
    if (check) {
      console.log(`${fs.existsSync(to) ? "differs" : "missing"}: ${mirror.target}/${relative}`);
      continue;
    }
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    console.log(`synced: ${mirror.target}/${relative}`);
  }

  for (const relative of targetFiles) {
    if (sourceFiles.includes(relative)) continue;
    drift += 1;
    if (check) {
      console.log(`extra: ${mirror.target}/${relative}`);
      continue;
    }
    fs.rmSync(path.join(targetRoot, relative));
    console.log(`removed: ${mirror.target}/${relative}`);
  }
}

if (check) {
  if (drift === 0) {
    console.log("Agent skill mirrors are in sync.");
  } else {
    console.error(`${drift} agent skill file(s) out of sync; run \`npm run sync:agents\`.`);
    process.exit(1);
  }
} else if (drift === 0) {
  console.log("Agent skill mirrors were already in sync.");
}
