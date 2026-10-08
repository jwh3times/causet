#!/usr/bin/env node
/**
 * Read and update the cross-machine handoff map in Proton Drive.
 *
 * The owner moves between a Windows PC and a Fedora PC. `/handoff` publishes a
 * handoff document into the synced `My files/Documents/Handoffs` folder and
 * records it as this repository's active handoff in `handoff_map.json`;
 * `/lets-go` reads that entry on the other machine and clears it. The map is
 * shared by every repository the owner works in, so each update rewrites only
 * this repository's entry and `Last_Updated`.
 *
 * The folder is found under a home-directory `Proton Drive` root (the Windows
 * client nests an account folder before `My files`). Set HANDOFFS_DIR
 * where a client mounts it anywhere else.
 *
 *   node scripts/handoff-map.mjs where
 *   node scripts/handoff-map.mjs get [--repo <name>]
 *   node scripts/handoff-map.mjs publish <file.md> [--repo <name>]
 *   node scripts/handoff-map.mjs clear [--repo <name>]
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const MAP_NAME = "handoff_map.json";

const USAGE = "usage: handoff-map.mjs where | get | publish <file.md> | clear [--repo <name>]";

function isDirectory(candidate) {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function childDirs(dir, pattern) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => pattern.test(name))
    .map((name) => path.join(dir, name))
    .filter(isDirectory);
}

export function resolveHandoffsDir({ env = process.env, home = os.homedir() } = {}) {
  if (env.HANDOFFS_DIR) {
    const dir = path.resolve(env.HANDOFFS_DIR);
    if (!fs.existsSync(path.join(dir, MAP_NAME))) {
      throw new Error(`HANDOFFS_DIR has no ${MAP_NAME}: ${dir}`);
    }
    return dir;
  }
  const found = [];
  for (const root of childDirs(home, /^proton[ _-]?drive$/i)) {
    for (const base of [root, ...childDirs(root, /./)]) {
      for (const myFiles of childDirs(base, /^my files$/i)) {
        for (const documents of childDirs(myFiles, /^documents$/i)) {
          for (const handoffs of childDirs(documents, /^handoffs$/i)) {
            if (fs.existsSync(path.join(handoffs, MAP_NAME))) found.push(handoffs);
          }
        }
      }
    }
  }
  if (found.length === 1) return found[0];
  if (found.length === 0) {
    throw new Error(
      `No Proton Drive "My files/Documents/Handoffs/${MAP_NAME}" under ${home}; `
        + "set HANDOFFS_DIR to the folder that holds it.",
    );
  }
  throw new Error(`Several handoff folders found; set HANDOFFS_DIR to one of:\n${found.join("\n")}`);
}

export function formatTimestamp(date) {
  const two = (value) => String(value).padStart(2, "0");
  return `${two(date.getMonth() + 1)}-${two(date.getDate())}-${date.getFullYear()} `
    + `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
}

function localDate(date) {
  const two = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
}

function readMap(dir) {
  const file = path.join(dir, MAP_NAME);
  const raw = fs.readFileSync(file, "utf8");
  const map = JSON.parse(raw.replace(/^﻿/, ""));
  const handoffs = map?.Active_Handoffs;
  if (typeof handoffs !== "object" || handoffs === null || Array.isArray(handoffs)) {
    throw new Error(`${file} has no Active_Handoffs object`);
  }
  return { file, raw, map };
}

// Replace the map through a sibling temporary file so a sync client never
// uploads a half-written map, and keep the owner's BOM, line endings, and
// trailing newline so other machines see a one-entry change.
function writeMap({ file, raw, map }, now) {
  map.Last_Updated = formatTimestamp(now);
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  let text = JSON.stringify(map, null, 2).replaceAll("\n", eol);
  if (/\n$/.test(raw)) text += eol;
  if (raw.startsWith("﻿")) text = `﻿${text}`;
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, text);
  fs.renameSync(temporary, file);
}

const normalize = (name) => name.toLowerCase().replace(/[^a-z0-9]/g, "");

// Map keys were written by hand ("GuardianTracker", "vcs-lab"), so a repository
// matches its key exactly first and then ignoring case and punctuation.
export function mapKey(handoffs, repo) {
  if (Object.hasOwn(handoffs, repo)) return repo;
  const matches = Object.keys(handoffs).filter((key) => normalize(key) === normalize(repo));
  if (matches.length > 1) {
    throw new Error(`Several map entries match ${repo}: ${matches.join(", ")}; pass --repo with the exact key.`);
  }
  return matches[0] ?? null;
}

// The map syncs from another machine: accept only a bare file name, so an
// entry can never point a reader outside the handoff folder.
function entryFile(dir, key, value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value === "" || path.basename(value) !== value || value === "..") {
    throw new Error(`${MAP_NAME} entry ${key} is not a file name in ${dir}: ${JSON.stringify(value)}`);
  }
  return value;
}

export function activeHandoff({ dir, repo }) {
  const { map } = readMap(dir);
  const key = mapKey(map.Active_Handoffs, repo);
  const active = key === null ? null : entryFile(dir, key, map.Active_Handoffs[key]);
  const file = active === null ? null : path.join(dir, active);
  return { repo, key, active, path: file, exists: file !== null && fs.existsSync(file) };
}

export function publishHandoff({ dir, repo, source, now = new Date() }) {
  if (path.extname(source).toLowerCase() !== ".md") {
    throw new Error(`A handoff document must be Markdown: ${source}`);
  }
  const state = readMap(dir);
  const handoffs = state.map.Active_Handoffs;
  const key = mapKey(handoffs, repo) ?? repo;
  const previous = entryFile(dir, key, handoffs[key]);
  const slug = repo.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "repository";
  const stem = `${slug}-handoff-${localDate(now)}`;
  let name = `${stem}.md`;
  for (let suffix = 2; fs.existsSync(path.join(dir, name)); suffix += 1) {
    name = `${stem}-${suffix}.md`;
  }
  const target = path.join(dir, name);
  fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
  handoffs[key] = name;
  writeMap(state, now);
  return { repo, key, active: name, path: target, previous };
}

export function clearHandoff({ dir, repo, now = new Date() }) {
  const state = readMap(dir);
  const key = mapKey(state.map.Active_Handoffs, repo);
  const previous = key === null ? null : entryFile(dir, key, state.map.Active_Handoffs[key]);
  if (previous === null) return { repo, key, previous, cleared: false };
  state.map.Active_Handoffs[key] = null;
  writeMap(state, now);
  return { repo, key, previous, cleared: true };
}

// The origin repository's name, not the checkout directory's: worktrees and
// clones on the other machine may live under any directory name.
export function repoName(cwd = process.cwd()) {
  const git = (...args) => execFileSync("git", args, {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  try {
    const name = git("remote", "get-url", "origin")
      .replace(/[\\/]+$/, "").split(/[\\/:]/).pop().replace(/\.git$/i, "");
    if (name) return name;
  } catch {
    // No origin: fall back to the checkout directory.
  }
  return path.basename(git("rev-parse", "--show-toplevel"));
}

function main(argv) {
  const [command, ...rest] = argv;
  let repo;
  const positional = [];
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] === "--repo") {
      repo = rest[index += 1];
      if (!repo) throw new Error("--repo needs a name");
    } else {
      positional.push(rest[index]);
    }
  }
  if (command === "where" && positional.length === 0) return { handoffsDir: resolveHandoffsDir() };
  const expected = { get: 0, clear: 0, publish: 1 }[command];
  if (expected === undefined || positional.length !== expected) throw new Error(USAGE);
  const dir = resolveHandoffsDir();
  repo ??= repoName();
  if (command === "get") return { handoffsDir: dir, ...activeHandoff({ dir, repo }) };
  if (command === "clear") return { handoffsDir: dir, ...clearHandoff({ dir, repo }) };
  return { handoffsDir: dir, ...publishHandoff({ dir, repo, source: path.resolve(positional[0]) }) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    console.log(JSON.stringify(main(process.argv.slice(2)), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
