"use strict";

// Where the prebuilt `cst` executable for this host lives, and whether it is
// the one this package was released with (ADR-0038 §2, §5, §6). Shared by the
// launcher (`cst.exe`) and the `preinstall` copy. CommonJS, because both run
// before, or instead of, the ESM JavaScript CLI.

const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const packageRoot = path.resolve(__dirname, "..", "..");
const SCOPE = "@holland-vip";

/** The platforms a package is published for, by `process.platform-process.arch[-libc]`. */
const PLATFORMS = {
  "win32-x64": { package: `${SCOPE}/causet-win32-x64`, file: "cst.exe" },
  "linux-x64-gnu": { package: `${SCOPE}/causet-linux-x64-gnu`, file: "cst" },
};

/** `glibc` or `musl` on Linux, as npm's `libc` field names them. */
function libc() {
  if (process.platform !== "linux") return null;
  const header = process.report?.getReport?.().header;
  return header?.glibcVersionRuntime ? "gnu" : "musl";
}

function hostKey() {
  const family = libc();
  return [process.platform, process.arch, family].filter(Boolean).join("-");
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/**
 * The installed platform package's executable, or why there is none.
 * `{ executable, package }` or `{ missing }`.
 */
function locate() {
  const key = hostKey();
  const platform = PLATFORMS[key];
  if (!platform) {
    return { missing: `no prebuilt executable is published for ${key}` };
  }
  let manifest;
  try {
    manifest = require.resolve(`${platform.package}/package.json`, { paths: [packageRoot] });
  } catch {
    return { missing: `the optional package ${platform.package} is not installed` };
  }
  const executable = path.join(path.dirname(manifest), platform.file);
  if (!fs.existsSync(executable)) {
    return { missing: `${platform.package} holds no ${platform.file}` };
  }
  return { executable, package: platform.package };
}

/**
 * Refuse an executable that is not the one this package was released with:
 * its digest must be the recorded one, and it must report this package's
 * version. Returns nothing; throws an `Error` naming both sides.
 */
function verify(found) {
  const version = readJson(path.join(packageRoot, "package.json")).version;
  const checksums = readJson(path.join(__dirname, "checksums.json"));
  const expected = checksums[found.package]?.sha256;
  const actual = sha256(found.executable);
  if (!expected || expected !== actual) {
    throw new Error(
      `${found.package} holds an executable with SHA-256 ${actual}, not the ${expected ?? "(unrecorded)"} this release of causet ${version} lists. Reinstall both packages at the same version.`,
    );
  }
  const reported = execFileSync(found.executable, ["--version"], { encoding: "utf8" }).trim();
  if (reported !== `causet ${version}`) {
    throw new Error(
      `${found.package} reports '${reported}', but this package is causet ${version}. Reinstall both packages at the same version.`,
    );
  }
}

module.exports = { hostKey, locate, packageRoot, PLATFORMS, sha256, verify };
