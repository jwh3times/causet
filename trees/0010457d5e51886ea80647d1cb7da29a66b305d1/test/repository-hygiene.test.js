/**
 * Properties of the checkout itself, rather than of anything the CLI does.
 *
 * These exist because a defect got through every other control. A literal NUL
 * byte was committed inside a JavaScript string literal: valid JavaScript,
 * harmless at run time, and invisible to `node --check`, the whole suite, five
 * suite modes, the demos, the benchmark, and the release gate. What it broke
 * was review — Git classifies a file containing NUL as binary, so the file had
 * no diff, no blame, and no reviewable history from the moment it landed.
 *
 * A check that ran only at release would have caught it a release too late, so
 * it lives in the suite and the release gate cites the suite.
 *
 * Two details are the difference between this catching the defect and repeating
 * it. The scan covers **untracked files too**, so a file is checked before it
 * is ever committed rather than one commit after. And the character is never
 * written literally in this file — `String.fromCharCode(0)` builds it — because
 * the first version of this test did embed one, in the regex meant to render
 * it, and was itself a binary file. It did not notice, because it was not yet
 * tracked.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { fixturePrefixes } from "../scripts/clean-demo-fixtures.mjs";
import { VERSION } from "../src/version.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Built rather than written, so this file can never contain the byte it hunts. */
const NUL = String.fromCharCode(0);

/**
 * Paths that are genuinely binary and may contain NUL. Empty today: every file
 * in this repository is text. A new entry needs a reason, because the cost is
 * permanent — it is a file nobody can review in a diff again.
 */
const BINARY_ALLOWLIST = new Set();

/**
 * Every file a reviewer would see: tracked, plus untracked files that are not
 * ignored. Untracked matters — a new file is exactly where an embedded NUL
 * arrives, and checking only `git ls-files` would let the first commit of it
 * through.
 */
function reviewableFiles() {
  const output = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: projectRoot, encoding: "buffer", maxBuffer: 32 * 1024 * 1024 },
  );
  return [...new Set(output.toString("utf8").split(NUL).filter(Boolean))];
}

test("no file in the checkout contains a NUL byte", () => {
  // Git decides a file is binary by finding a NUL near its start, and a binary
  // file has no diff, no blame, and no `git grep`. For a source file that is a
  // silent loss of reviewability rather than a runtime fault, which is exactly
  // why nothing else catches it.
  const files = reviewableFiles();
  assert.ok(
    files.length > 50,
    `expected the whole checkout enumerated, got ${files.length} files`,
  );

  const offenders = [];
  for (const relative of files) {
    if (BINARY_ALLOWLIST.has(relative)) continue;
    const absolute = path.join(projectRoot, relative);
    let bytes;
    try {
      bytes = fs.readFileSync(absolute);
    } catch (error) {
      // A path that is a directory or has gone missing is a different problem
      // and not this test's to report.
      if (error?.code === "ENOENT" || error?.code === "EISDIR") continue;
      throw error;
    }
    const at = bytes.indexOf(0);
    if (at === -1) continue;
    // Name the surrounding bytes, so the report says where to look rather than
    // only that something is wrong.
    const context = bytes
      .subarray(Math.max(0, at - 30), at + 30)
      .toString("utf8")
      .split(NUL)
      .join("<NUL>")
      .replace(/\r?\n/g, " ");
    const line = bytes.subarray(0, at).toString("utf8").split("\n").length;
    offenders.push(`${relative}:${line} (byte ${at}): ${context}`);
  }

  assert.deepEqual(
    offenders,
    [],
    "files containing a NUL byte, which makes Git treat them as binary — no " +
    "diff, no blame, no grep:\n" + offenders.join("\n") +
    "\nBuild the character rather than embedding it (String.fromCharCode(0), " +
    "or a \\u0000 escape), or add the path to BINARY_ALLOWLIST with a reason " +
    "if it is genuinely binary.",
  );
});

test("Git agrees that every file in the checkout is text", () => {
  // The same property from Git's own side. `git grep -I` skips binary files,
  // so a file matching the empty pattern as text is one Git will diff. This
  // catches something the byte scan cannot: a `binary` attribute in
  // .gitattributes hides a file from review with no NUL in it at all.
  const textFiles = new Set(
    execFileSync("git", ["grep", "-I", "--name-only", "--untracked", "-e", ""], {
      cwd: projectRoot,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    })
      .split("\n")
      .filter(Boolean),
  );

  const opaque = reviewableFiles().filter((relative) => {
    if (BINARY_ALLOWLIST.has(relative) || textFiles.has(relative)) return false;
    const absolute = path.join(projectRoot, relative);
    // An empty file is not binary; it simply has nothing for `git grep` to
    // match, so it never appears in the text listing.
    return fs.existsSync(absolute) && fs.statSync(absolute).size > 0;
  });

  assert.deepEqual(
    opaque,
    [],
    "files Git will not treat as text, so they cannot be reviewed in a diff:\n" +
    opaque.join("\n"),
  );
});

test("every demo's fixture prefix is one demo:clean will sweep", () => {
  // `npm run demo:clean` derives its prefixes from the demo scripts rather
  // than listing them, because a hardcoded list stops covering a demo the day
  // someone adds one and fails invisibly: fixtures simply keep accumulating.
  // This asserts the derivation still finds every demo, so a new demo whose
  // fixture is named differently — or a regex that stops matching — fails here
  // rather than silently leaving repositories in the temporary directory.
  const scriptsDir = path.join(projectRoot, "scripts");
  const demos = fs
    .readdirSync(scriptsDir)
    .filter((name) => name.endsWith(".mjs") && name.includes("demo") && name !== "clean-demo-fixtures.mjs");
  assert.ok(demos.length >= 6, `expected the demo scripts, found ${demos.length}`);

  const swept = fixturePrefixes();
  const uncovered = [];
  for (const name of demos) {
    const source = fs.readFileSync(path.join(scriptsDir, name), "utf8");
    const match = source.match(/mkdtempSync\(\s*path\.join\(\s*os\.tmpdir\(\)\s*,\s*"([^"]+)"/);
    assert.ok(match, `${name}: no temporary-fixture prefix found`);
    if (!swept.includes(match[1])) uncovered.push(`${name} -> ${match[1]}`);
  }

  assert.deepEqual(
    uncovered,
    [],
    "demo fixtures npm run demo:clean would not remove:\n" + uncovered.join("\n"),
  );
});

test("src/version.js publishes the version package.json declares", () => {
  // `vlab --version` and `vlab doctor` report src/version.js while npm
  // publishes package.json. Both are edited by hand at every release, and
  // nothing else notices when only one of them moves.
  const manifest = JSON.parse(
    fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"),
  );
  assert.equal(VERSION, manifest.version);
});
