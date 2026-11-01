/**
 * The install scripts of ADR-0038's 2026-10-08 amendment, run against a
 * release's assets (#218).
 *
 * Each test points `scripts/install.sh` or `scripts/install.ps1` at a
 * directory holding an archive, `SHA256SUMS` and the script, and installs
 * under a prefix of its own, with no Node.js on `PATH`. The installed
 * executable is the subject, so this suite launches it directly rather than
 * through `test-support/vlab-command.js`.
 *
 * Without `CAUSET_RELEASE_SET=<directory>` the assets are made here from the
 * workspace's release build; the release workflow passes the set it has just
 * built. Skipped without either, and on a host no archive is published for.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import { environmentValue } from "../src/environment.js";
import { testEnv } from "../test-support/git-environment.js";
import { bareEnvironment, smokeSequence } from "../test-support/installed-smoke.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const windows = process.platform === "win32";
const target = windows && process.arch === "x64" ? "x86_64-pc-windows-msvc"
  : process.platform === "linux" && process.arch === "x64" ? "x86_64-unknown-linux-gnu" : null;
const built = path.join(projectRoot, "native", "target", "release", windows ? "cst.exe" : "cst");
const releaseSet = environmentValue("RELEASE_SET") ? path.resolve(environmentValue("RELEASE_SET")) : null;
const skip = !target ? `no archive is published for ${process.platform}-${process.arch}`
  : releaseSet || fs.existsSync(built) ? false : "no Rust CLI build; run node scripts/build-native.mjs";
const version = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8")).version;
const script = windows ? "install.ps1" : "install.sh";
const archive = target && `cst-${version}-${target}.${windows ? "zip" : "tar.gz"}`;

const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "vcs-lab-install-")));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const sha256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
let assets;
let shell;

before(() => {
  if (skip) return;
  assets = path.join(scratch, "assets");
  fs.mkdirSync(assets);
  if (releaseSet) {
    for (const file of [archive, "SHA256SUMS", script]) fs.copyFileSync(path.join(releaseSet, file), path.join(assets, file));
  } else {
    // The archive the release workflow makes: the executable, its notices, the license.
    const stage = path.join(scratch, "stage");
    fs.mkdirSync(stage);
    fs.copyFileSync(built, path.join(stage, path.basename(built)));
    fs.writeFileSync(path.join(stage, "THIRD-PARTY-NOTICES.txt"), "notices\n");
    fs.copyFileSync(path.join(projectRoot, "LICENSE"), path.join(stage, "LICENSE"));
    // Windows ships bsdtar, which writes a zip for a `.zip` name; a GNU tar earlier on PATH would not.
    const tar = windows ? `${process.env.SystemRoot}\\System32\\tar.exe` : "tar";
    const packed = spawnSync(tar, [
      windows ? "-a" : "-z", "-cf", path.join(assets, archive), "-C", stage,
      path.basename(built), "THIRD-PARTY-NOTICES.txt", "LICENSE",
    ], { encoding: "utf8" });
    assert.equal(packed.status, 0, packed.stderr);
    fs.copyFileSync(path.join(projectRoot, "scripts", script), path.join(assets, script));
    fs.writeFileSync(path.join(assets, "SHA256SUMS"),
      [archive, script].map((file) => `${sha256(path.join(assets, file))}  ${file}\n`).join(""));
  }
  // The script's own tools and Git, and no Node.js.
  const tools = windows ? [] : [
    "sh", "uname", "ls", "ldd", "grep", "sed", "head", "mktemp", "rm", "cp", "mv", "ln", "mkdir", "chmod",
    "tar", "gzip", "sha256sum", "cut", "cat",
  ].map((tool) => spawnSync("which", [tool], { encoding: "utf8" }).stdout.trim()).filter(Boolean);
  shell = bareEnvironment(path.join(scratch, "bare"), windows
    ? [`${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0`]
    : tools);
  const found = spawnSync(windows ? "where" : "sh", windows ? ["node"] : ["-c", "command -v node"], { encoding: "utf8", env: shell.env });
  assert.notEqual(found.status, 0, `node is still on the test's PATH: ${found.stdout}`);
});

let installs = 0;

/** Run the install script against the release at `from`, into a new prefix. */
function install(flags = [], from = assets) {
  // The script always comes from a real release; `from` may be one that is not there.
  const source = fs.existsSync(path.join(from, script)) ? from : assets;
  installs += 1;
  const prefix = path.join(scratch, `prefix-${installs}`);
  const ran = windows
    ? spawnSync(`${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`, [
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(source, script),
        "-From", from, "-Prefix", prefix, ...flags.map((flag) => flag.replace(/^--(.)/, (_, c) => `-${c.toUpperCase()}`)),
      ], { cwd: scratch, encoding: "utf8", env: shell.env })
    : spawnSync("sh", [path.join(source, script), "--from", from, "--prefix", prefix, ...flags], {
        cwd: scratch, encoding: "utf8", env: shell.env,
      });
  return { ...ran, prefix, executable: path.join(prefix, windows ? "cst.exe" : "cst") };
}

/** A copy of the assets a test may damage. */
function copyOfAssets() {
  const copy = path.join(scratch, `assets-${installs + 1}`);
  fs.cpSync(assets, copy, { recursive: true });
  return copy;
}

test("the script installs cst and its alias with no Node.js on PATH, and the installed command works", { skip }, () => {
  assert.equal(sha256(path.join(assets, script)), sha256(path.join(projectRoot, "scripts", script)),
    "the release carries this checkout's install script");
  const installed = install();
  assert.equal(installed.status, 0, `${installed.stdout}\n${installed.stderr}`);
  assert.match(installed.stdout, new RegExp(`^Installed causet ${version.replaceAll(".", "\\.")} \\(${target}\\):`));
  assert.match(installed.stdout, /is not on PATH\. Add it for this/);
  const launch = (args, options = {}) => spawnSync(installed.executable, args, {
    cwd: options.cwd ?? scratch, encoding: "utf8", env: options.env ?? shell.env,
  });
  assert.equal(launch(["--version"]).stdout, `causet ${version}\n`);
  const alias = spawnSync(path.join(installed.prefix, windows ? "vlab.cmd" : "vlab"), ["--version"], {
    cwd: scratch, encoding: "utf8", env: shell.env, shell: windows,
  });
  assert.equal(alias.stdout.trim(), `causet ${version}`, alias.stderr);
  const doctor = smokeSequence({ launch, git: shell.git, env: shell.env, repo: path.join(scratch, "repo") });
  assert.equal(doctor.implementation, "rust");
  assert.equal(doctor.node, null);
  assert.equal(doctor.launcher, null);

  // Running it again upgrades in place, and a pinned version finds its archive.
  const again = install(["--version", version]);
  assert.equal(again.status, 0, again.stderr);
});

test("an archive that is not the listed one is refused, and nothing is installed", { skip }, () => {
  const damaged = copyOfAssets();
  fs.appendFileSync(path.join(damaged, archive), "tampered");
  const refused = install([], damaged);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /has SHA-256 [0-9a-f]{64}, not the [0-9a-f]{64} its release lists\. Nothing was installed\./);
  assert.equal(fs.existsSync(refused.prefix), false);
});

test("a release that lists no digest for the archive, or no archive for the host, is refused by name", { skip }, () => {
  const unlisted = copyOfAssets();
  fs.writeFileSync(path.join(unlisted, "SHA256SUMS"), `${"0".repeat(64)}  ${script}\n`);
  const missing = install([], unlisted);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, new RegExp(`lists no cst archive for ${target}`));
  assert.equal(fs.existsSync(missing.prefix), false);

  const elsewhere = install(["--target", "riscv64gc-unknown-linux-gnu"]);
  assert.equal(elsewhere.status, 1);
  assert.match(elsewhere.stderr, /lists no cst archive for riscv64gc-unknown-linux-gnu\.[^]*npm install -g @holland-vip\/causet/);

  const otherVersion = install(["--version", "0.0.1"]);
  assert.equal(otherVersion.status, 1);
  assert.match(otherVersion.stderr, /at version 0\.0\.1/);

  const nowhere = install([], path.join(scratch, "no-such-release"));
  assert.equal(nowhere.status, 1);
});
