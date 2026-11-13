/**
 * The hand npm publish, `scripts/publish-npm.ps1` (#448).
 *
 * While npm/cli#9969 keeps `NPM_PUBLISH` false (#139), a maintainer publishes
 * each stable version to npm with this script. Each test packs a release set
 * with `scripts/pack-release.mjs`, as the release workflow does, and runs the
 * script on it with `-From`, so nothing is downloaded. A stub `npm` first on
 * `PATH` answers `whoami` and `view` and records every call, so no test
 * reaches the registry; the record is what the script would have published.
 *
 * The executables are placeholders: the script checks the tarballs, not what
 * is inside them. Skipped where PowerShell 7 (`pwsh`) is not installed.
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import { packRelease } from "../scripts/pack-release.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(projectRoot, "scripts", "publish-npm.ps1");
const windows = process.platform === "win32";
const skip = spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"]).status === 0 ? false : "PowerShell 7 (pwsh) is not installed";
const { version } = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));
const linux = `holland-vip-causet-linux-x64-gnu-${version}.tgz`;
const win32 = `holland-vip-causet-win32-x64-${version}.tgz`;
const main = `holland-vip-causet-${version}.tgz`;

const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "vcs-lab-publish-")));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));
/** `text` matched literally in a pattern: package names and versions hold only dots to escape. */
const literal = (text) => text.replaceAll(".", "\\.");
const sha256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

/**
 * A stand-in for npm: logged in as `NPM_STUB_USER`, with `NPM_STUB_PUBLISHED`
 * already on the registry. Off Windows it is an executable named exactly
 * `npm`, so no other npm on `PATH` can answer first.
 */
const STUB = `${windows ? "" : "#!/usr/bin/env pwsh\n"}Add-Content -LiteralPath $env:NPM_STUB_LOG -Value ($args -join ' ')
switch ($args[0]) {
  'whoami' { if ($env:NPM_STUB_USER) { $env:NPM_STUB_USER; exit 0 }; exit 1 }
  'view' { if (($env:NPM_STUB_PUBLISHED -split ',') -contains $args[1]) { $args[1].Split('@')[-1]; exit 0 }; exit 1 }
  'publish' { exit 0 }
}
exit 2
`;

let release;
let stubs;
before(() => {
  if (skip) return;
  const executable = path.join(scratch, "cst-placeholder");
  const notices = path.join(scratch, "notices.txt");
  fs.writeFileSync(executable, "a placeholder for cst\n");
  fs.writeFileSync(notices, "notices\n");
  release = path.join(scratch, "release");
  packRelease({
    out: release,
    executable: { "win32-x64": executable, "linux-x64-gnu": executable },
    notices: { "win32-x64": notices, "linux-x64-gnu": notices },
  });
  stubs = path.join(scratch, "stubs");
  fs.mkdirSync(stubs);
  fs.writeFileSync(path.join(stubs, windows ? "npm.ps1" : "npm"), STUB, { mode: 0o755 });
  // Were a real npm reached after all, it would have no registry and no login to publish with.
  fs.writeFileSync(path.join(scratch, "npmrc"), "");
});

let runs = 0;
let copies = 0;

/** A copy of the release set a test may damage. */
function copyOfRelease() {
  copies += 1;
  const copy = path.join(scratch, `release-copy-${copies}`);
  fs.cpSync(release, copy, { recursive: true });
  return copy;
}

/** Run the script on the set at `from`, with the stub npm; `calls` is every npm call it made. */
function publish(flags = [], { from = release, user = "maintainer", published = [] } = {}) {
  runs += 1;
  const log = path.join(scratch, `npm-${runs}.log`);
  fs.writeFileSync(log, "");
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(path|psmodulepath)$/i.test(key)));
  const ran = spawnSync("pwsh", [
    "-NoProfile", "-NonInteractive", ...(windows ? ["-ExecutionPolicy", "Bypass"] : []),
    "-File", script, "-Version", version, "-From", from, ...flags,
  ], {
    cwd: scratch, encoding: "utf8",
    env: { ...env, PATH: `${stubs}${path.delimiter}${process.env.PATH ?? process.env.Path}`,
      NPM_STUB_LOG: log, NPM_STUB_USER: user, NPM_STUB_PUBLISHED: published.join(","),
      NPM_CONFIG_REGISTRY: "http://127.0.0.1:9/", NPM_CONFIG_USERCONFIG: path.join(scratch, "npmrc") },
  });
  const calls = fs.readFileSync(log, "utf8").split(/\r?\n/).filter(Boolean);
  return { ...ran, calls, publishes: calls.filter((call) => call.startsWith("publish ")) };
}

test("a release set passes every check and publishes the platform packages before the main package", { skip }, () => {
  const done = publish();
  assert.equal(done.status, 0, `${done.stdout}\n${done.stderr}`);
  for (const tarball of [win32, linux, main]) assert.match(done.stdout, new RegExp(`digest ok +${literal(tarball)}`));
  assert.match(done.stdout, /manifest ok/);
  assert.deepEqual(done.publishes, [win32, linux, main].map((tarball) => `publish ${path.join(release, tarball)} --access public`));
});

test("a dry run passes --dry-run to every publish and says nothing was published", { skip }, () => {
  const dry = publish(["-DryRun"]);
  assert.equal(dry.status, 0, `${dry.stdout}\n${dry.stderr}`);
  assert.ok(dry.publishes.length === 3 && dry.publishes.every((call) => call.endsWith(" --dry-run")), dry.publishes.join("\n"));
  assert.match(dry.stdout, /Dry run only: nothing was published\./);
});

test("a rerun after a partial publish skips the versions npm already has", { skip }, () => {
  const rerun = publish([], { published: [`@holland-vip/causet-win32-x64@${version}`, `@holland-vip/causet-linux-x64-gnu@${version}`] });
  assert.equal(rerun.status, 0, `${rerun.stdout}\n${rerun.stderr}`);
  assert.match(rerun.stdout, new RegExp(`already published +@holland-vip/causet-linux-x64-gnu@${literal(version)}`));
  assert.deepEqual(rerun.publishes, [`publish ${path.join(release, main)} --access public`]);
});

test("without an npm login the script stops before it reads the set", { skip }, () => {
  const refused = publish([], { user: "" });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /npm is not logged in: run `npm login`/);
  assert.deepEqual(refused.calls, ["whoami"]);
});

test("a tarball that is not the listed one is refused by name, and nothing is published", { skip }, () => {
  const damaged = copyOfRelease();
  fs.appendFileSync(path.join(damaged, linux), "tampered");
  const refused = publish([], { from: damaged });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, new RegExp(`${literal(linux)} has SHA-256 [0-9a-f]{64}, not the [0-9a-f]{64} the release lists`));
  assert.deepEqual(refused.publishes, []);
});

test("a set missing a tarball, or listing no digest for one, is refused by name, and nothing is published", { skip }, () => {
  const missing = copyOfRelease();
  fs.rmSync(path.join(missing, win32));
  const noTarball = publish([], { from: missing });
  assert.equal(noTarball.status, 1);
  assert.match(noTarball.stderr, new RegExp(`the release has no ${literal(win32)}`));
  assert.deepEqual(noTarball.publishes, []);

  const unlisted = copyOfRelease();
  const sums = path.join(unlisted, "SHA256SUMS");
  fs.writeFileSync(sums, fs.readFileSync(sums, "utf8").split("\n").filter((line) => !line.endsWith(`  ${main}`)).join("\n"));
  const noDigest = publish([], { from: unlisted });
  assert.equal(noDigest.status, 1);
  assert.match(noDigest.stderr, new RegExp(`SHA256SUMS lists no digest for ${literal(main)}`));
  assert.deepEqual(noDigest.publishes, []);
});

test("a main package packed from the checkout is refused as not a release build, and nothing is published", { skip }, () => {
  // The mistake this script exists to prevent: `npm pack` in the checkout,
  // whose manifest pins no platform package, listed as if it were the release's.
  const checkout = copyOfRelease();
  fs.rmSync(path.join(checkout, main));
  execFileSync(windows ? "npm.cmd" : "npm", ["pack", "--pack-destination", checkout], {
    cwd: projectRoot, stdio: "ignore", shell: windows,
  });
  const sums = path.join(checkout, "SHA256SUMS");
  fs.writeFileSync(sums, fs.readFileSync(sums, "utf8").replace(/^[0-9a-f]{64}(?= {2}holland-vip-causet-\d)/m, sha256(path.join(checkout, main))));
  const refused = publish([], { from: checkout });
  assert.equal(refused.status, 1);
  assert.match(refused.stdout, new RegExp(`digest ok +${literal(main)}`));
  assert.match(refused.stderr, /does not pin @holland-vip\/causet-win32-x64 at [\d.]+; it is not a release build/);
  assert.deepEqual(refused.publishes, []);
});
