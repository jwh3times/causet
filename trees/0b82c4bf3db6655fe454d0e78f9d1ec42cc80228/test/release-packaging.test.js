/**
 * The package set of ADR-0038, installed the way a user installs it (#150).
 *
 * `scripts/pack-release.mjs` builds the main package and this host's platform
 * package from the workspace's release build of the Rust CLI. Each test
 * installs them globally under a prefix of its own and runs the `cst` npm
 * linked there. That command is the subject, so this suite launches it
 * directly rather than through `test-support/vlab-command.js`.
 *
 * With `CAUSET_RELEASE_SET=<directory>` it installs the tarballs a release
 * workflow already packed there instead of packing its own, which is how the
 * workflow smoke-tests what it is about to publish.
 *
 * Skipped without either (`node scripts/build-native.mjs` makes the build) and
 * on a host no platform package is published for.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import { environmentValue } from "../src/environment.js";
import { testEnv } from "../test-support/git-environment.js";
import { packRelease } from "../scripts/pack-release.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { hostKey, PLATFORMS } = createRequire(import.meta.url)("../bin/native/platform.js");
const windows = process.platform === "win32";
const built = path.join(projectRoot, "native", "target", "release", windows ? "cst.exe" : "cst");
const platform = PLATFORMS[hostKey()];
const releaseSet = environmentValue("RELEASE_SET") ? path.resolve(environmentValue("RELEASE_SET")) : null;
const skip = !platform ? `no platform package is published for ${hostKey()}`
  : releaseSet || fs.existsSync(built) ? false : "no Rust CLI build; run node scripts/build-native.mjs";
const version = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8")).version;

const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "vcs-lab-packaging-")));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

let packed;
let sums;
before(() => {
  if (skip) return;
  if (!releaseSet) {
    packed = packRelease({ out: path.join(scratch, "packed"), executable: { [hostKey()]: built }, notices: {} });
    sums = fs.readFileSync(path.join(scratch, "packed", "SHA256SUMS"), "utf8");
    return;
  }
  // The main package sorts last: its name is a prefix of every platform package's.
  const tarballs = fs.readdirSync(releaseSet)
    .filter((file) => /^holland-vip-causet-.*\.tgz$/.test(file))
    .sort((left, right) => right.length - left.length)
    .map((file) => path.join(releaseSet, file));
  sums = fs.readFileSync(path.join(releaseSet, "SHA256SUMS"), "utf8");
  const digest = new RegExp(`^([0-9a-f]{64})  ${platform.package}/${platform.file}$`, "m").exec(sums)?.[1];
  packed = { version, tarballs, checksums: { [platform.package]: { sha256: digest } } };
});

const npm = windows ? "npm.cmd" : "npm";
let installs = 0;

/** Install tarballs globally under a new prefix and say where things landed. */
function install(tarballs, flags = []) {
  installs += 1;
  const prefix = path.join(scratch, `prefix-${installs}`);
  const ran = spawnSync(npm, [
    "install", "--global", "--prefix", prefix, "--offline", "--no-audit", "--no-fund", ...flags, ...tarballs,
  ], { cwd: scratch, encoding: "utf8", shell: windows, env: testEnv() });
  assert.equal(ran.status, 0, `npm install ${flags.join(" ")}\n${ran.stdout}\n${ran.stderr}`);
  const modules = windows ? path.join(prefix, "node_modules") : path.join(prefix, "lib", "node_modules");
  return {
    command: windows ? path.join(prefix, "cst.cmd") : path.join(prefix, "bin", "cst"),
    target: path.join(modules, "@holland-vip", "causet", "bin", "native", "cst.exe"),
    executable: path.join(modules, ...platform.package.split("/"), platform.file),
  };
}

function cst(installed, args, options = {}) {
  return spawnSync(installed.command, args, {
    cwd: options.cwd ?? scratch, encoding: "utf8", shell: windows, env: options.env ?? testEnv(),
  });
}

const tarball = (name) => packed.tarballs.find((file) => path.basename(file).startsWith(name));
const mainTarball = () => packed.tarballs.at(-1);
const platformTarball = () => tarball(`holland-vip-causet-${hostKey()}`);
// npm 12 runs no install script it was not told to; earlier versions ignore the flag.
const withScripts = ["--dangerously-allow-all-scripts"];
const startsWithShebang = (file) => fs.readFileSync(file).subarray(0, 2).toString("latin1") === "#!";

test("the package set carries matching versions and recorded digests", { skip }, () => {
  assert.equal(packed.version, version);
  assert.ok(packed.tarballs.length >= 2, "a main package and at least this host's platform package");
  assert.match(sums, new RegExp(`^${packed.checksums[platform.package].sha256}  ${platform.package}/${platform.file}$`, "m"));
  for (const file of packed.tarballs) assert.match(sums, new RegExp(`^[0-9a-f]{64}  ${path.basename(file)}$`, "m"));
  // The checkout's own manifest keeps the JavaScript CLI as its command, for development.
  const checkout = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));
  assert.equal(checkout.bin.cst, "./bin/vlab.js");
  assert.equal(checkout.optionalDependencies, undefined);
});

test("with install scripts, cst is the executable itself and runs without Node", { skip }, () => {
  const installed = install([mainTarball(), platformTarball()], withScripts);
  assert.equal(startsWithShebang(installed.target), false, "the command's target is still the launcher");
  assert.deepEqual(fs.readFileSync(installed.target), fs.readFileSync(installed.executable));
  if (windows) {
    // The shim calls the executable itself: `"%dp0%\...\cst.exe" %*`, with no
    // interpreter in front of it.
    const shim = fs.readFileSync(installed.command, "utf8");
    assert.match(shim, /^"%dp0%\\[^"]*\\bin\\native\\cst\.exe"\s+%\*\r?$/m);
    assert.doesNotMatch(shim, /node(?:\.exe)?"?\s/i);
  }
  // Git and nothing else on PATH: a launcher would fail to find `node`.
  const bare = path.join(scratch, `bare-${installs}`);
  fs.mkdirSync(bare);
  const git = spawnSync(windows ? "where" : "which", ["git"], { encoding: "utf8" }).stdout.split(/\r?\n/)[0];
  const env = windows
    ? testEnv({ PATH: `${path.dirname(git)};${process.env.SystemRoot}\\System32` })
    : (fs.symlinkSync(git, path.join(bare, "git")), testEnv({ PATH: bare }));
  const reported = cst(installed, ["--version"], { env });
  assert.equal(reported.stdout, `causet ${version}\n`, reported.stderr);

  // The release gate's smoke sequence, in a repository of its own.
  const repo = path.join(scratch, `repo-${installs}`);
  fs.mkdirSync(repo);
  const run = (command, ...args) => {
    const ran = command === "git"
      ? spawnSync(git, args, { cwd: repo, encoding: "utf8", env })
      : cst(installed, args, { cwd: repo, env });
    assert.equal(ran.status, 0, `${command} ${args.join(" ")}\n${ran.stdout}\n${ran.stderr}`);
    return ran.stdout;
  };
  run("git", "init", "-q", "-b", "main");
  run("git", "config", "user.name", "Packaging");
  run("git", "config", "user.email", "packaging@example.invalid");
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
  run("git", "add", "-A");
  run("cst", "commit", "-m", "base");
  run("cst", "init");
  run("cst", "branch", "work");
  fs.writeFileSync(path.join(repo, "b.txt"), "b\n");
  run("git", "add", "-A");
  run("cst", "commit", "-m", "work");
  run("git", "switch", "-q", "main");
  run("cst", "merge", "work", "--compact", "-m", "land work");
  assert.equal(JSON.parse(run("cst", "metadata", "validate", "--json")).summary.valid, true);
  const doctor = JSON.parse(run("cst", "doctor"));
  assert.equal(doctor.implementation, "rust");
  assert.equal(doctor.launcher, null);
});

test("without install scripts, the launcher runs the executable and doctor says so", { skip }, () => {
  const installed = install([mainTarball(), platformTarball()], ["--ignore-scripts"]);
  assert.equal(startsWithShebang(installed.target), true);
  const reported = cst(installed, ["--version"]);
  assert.equal(reported.stdout, `causet ${version}\n`, reported.stderr);
  assert.equal(reported.stderr, "");
  const failed = cst(installed, ["no-such-command"]);
  assert.equal(failed.status, 1);
  const repo = path.join(scratch, `repo-${installs}`);
  fs.mkdirSync(repo);
  assert.equal(spawnSync("git", ["init", "-q", "-b", "main"], { cwd: repo, env: testEnv() }).status, 0);
  const doctor = JSON.parse(cst(installed, ["doctor"], { cwd: repo }).stdout);
  assert.equal(doctor.implementation, "rust");
  assert.equal(doctor.launcher, "node");
});

test("an executable that is not this release's is refused, by the launcher and by the install", { skip }, () => {
  const installed = install([mainTarball(), platformTarball()], ["--ignore-scripts"]);
  fs.appendFileSync(installed.executable, "tampered");
  const refused = cst(installed, ["--version"]);
  assert.equal(refused.status, 1);
  assert.equal(refused.stdout, "");
  assert.match(refused.stderr, /holds an executable with SHA-256 [0-9a-f]{64}, not the [0-9a-f]{64} this release/);
  // The same check stops the copy, and with it the install.
  const preinstall = spawnSync(process.execPath, [path.join(path.dirname(installed.target), "preinstall.js")], {
    encoding: "utf8", env: testEnv(),
  });
  assert.equal(preinstall.status, 1);
  assert.match(preinstall.stderr, /Reinstall both packages at the same version/);
  assert.equal(startsWithShebang(installed.target), true);
});

test("without a platform package, cst runs the JavaScript CLI and says why", { skip }, () => {
  const installed = install([mainTarball()], ["--omit=optional", ...withScripts]);
  assert.equal(startsWithShebang(installed.target), true);
  const reported = cst(installed, ["--version"]);
  assert.equal(reported.status, 0, reported.stderr);
  assert.equal(reported.stdout, `causet ${version}\n`);
  assert.match(reported.stderr, /^cst: the optional package @holland-vip\/causet-\S+ is not installed; running the JavaScript CLI\.\n$/);
});
