import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const ignoredDirectories = new Set([".git", "node_modules"]);

function markdownFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...markdownFiles(absolute));
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push(absolute);
  }
  return files;
}

function decode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Split a link target into the local file it names and the fragment it
 * carries. A bare `#fragment` names the current file. An absolute URL or an
 * empty target is not local and yields null.
 */
function localTarget(rawTarget) {
  let target = rawTarget.trim();
  if (target.startsWith("<") && target.endsWith(">")) {
    target = target.slice(1, -1);
  }
  if (!target) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return null;

  const hashAt = target.indexOf("#");
  const file = (hashAt >= 0 ? target.slice(0, hashAt) : target).split("?", 1)[0];
  const fragment = hashAt >= 0 ? target.slice(hashAt + 1) : "";
  if (!file && !fragment) return null;
  return { file: decode(file) || null, anchor: decode(fragment) || null };
}

/**
 * The slug GitHub gives a heading: lowercase; every character other than a
 * letter, digit, mark, space, hyphen, or underscore removed; spaces to
 * hyphens. Inline Markdown is rendered away first, so `## \`vlab merge\``
 * slugs as `vlab-merge` and `## [Guide](guide.md)` as `guide`.
 */
function headingSlug(heading) {
  const text = heading
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/(^|[^\p{L}\p{N}_])_([^_]+)_(?=[^\p{L}\p{N}_]|$)/gu, "$1$2");
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M} _-]/gu, "")
    .replace(/ /g, "-");
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const ATX_HEADING = /^ {0,3}#{1,6}(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const SETEXT_UNDERLINE = /^ {0,3}(=+|-+)[ \t]*$/;
const LIST_ITEM = /^ {0,3}(?:[-*+]|\d+[.)])\s/;
const HTML_ANCHOR = /<[a-zA-Z][^>]*\s(?:id|name)="([^"]+)"/g;

/**
 * Every fragment a Markdown file answers to: the GitHub slug of each heading
 * outside fenced code and front matter, numbered `-1`, `-2`, ... when a slug
 * repeats, plus any explicit `id="..."` or `name="..."` on an HTML tag.
 */
const anchorCache = new Map();
function anchorsOf(file) {
  if (anchorCache.has(file)) return anchorCache.get(file);
  const anchors = new Set();
  const seen = new Map();
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);

  let index = 0;
  if (lines[0] === "---") {
    const end = lines.indexOf("---", 1);
    if (end > 0) index = end + 1;
  }
  let fence = null;
  for (; index < lines.length; index += 1) {
    const line = lines[index];
    const fenceMatch = line.match(FENCE);
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1][0];
      else if (fenceMatch[1][0] === fence) fence = null;
      continue;
    }
    if (fence) continue;

    for (const match of line.matchAll(HTML_ANCHOR)) anchors.add(match[1]);

    let heading = null;
    const atx = line.match(ATX_HEADING);
    if (atx) {
      heading = atx[1] ?? "";
    } else if (
      index + 1 < lines.length &&
      SETEXT_UNDERLINE.test(lines[index + 1]) &&
      line.trim() &&
      !SETEXT_UNDERLINE.test(line) &&
      !LIST_ITEM.test(line) &&
      !line.trim().startsWith("|")
    ) {
      heading = line.trim();
    }
    if (heading === null) continue;

    const slug = headingSlug(heading);
    const count = seen.get(slug) ?? 0;
    seen.set(slug, count + 1);
    anchors.add(count === 0 ? slug : `${slug}-${count}`);
  }
  anchorCache.set(file, anchors);
  return anchors;
}

const failures = [];
let linkCount = 0;
let anchorCount = 0;

for (const file of markdownFiles(root)) {
  const relativeFile = path.relative(root, file);
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  let linkFence = null;
  for (const [index, line] of lines.entries()) {
    const opening = line.match(FENCE);
    if (linkFence) {
      const closing = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
      if (closing && closing[1][0] === linkFence[0] && closing[1].length >= linkFence.length) {
        linkFence = null;
      }
      continue;
    }
    if (opening) {
      linkFence = opening[1];
      continue;
    }
    for (const match of line.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = localTarget(match[1]);
      if (!target) continue;
      linkCount += 1;
      const resolved = target.file ? path.resolve(path.dirname(file), target.file) : file;
      if (!fs.existsSync(resolved)) {
        failures.push(`${relativeFile}:${index + 1}: ${match[1]}`);
        continue;
      }
      // A fragment into anything but a Markdown file is not ours to judge.
      if (!target.anchor || !resolved.endsWith(".md") || !fs.statSync(resolved).isFile()) continue;
      anchorCount += 1;
      if (!anchorsOf(resolved).has(target.anchor)) {
        const targetFile = path.relative(root, resolved).split(path.sep).join("/");
        failures.push(
          `${relativeFile}:${index + 1}: ${match[1]} ` +
          `(no heading or anchor '#${target.anchor}' in ${targetFile})`,
        );
      }
    }
  }
}

if (failures.length) {
  console.error("Broken local Markdown links:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Checked ${linkCount} local Markdown links (${anchorCount} with anchors).`);
}
