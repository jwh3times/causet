// Decides what the release workflows do with a version (#440): the version a landing is tagged
// with, the npm dist-tag a build is published under, and whether a version may be promoted to
// stable. The decisions are pure functions over data the workflows look up, so they are tested
// without a registry or GitHub (test/release-plan.test.js); the CLI below does the lookups.

//   node scripts/release-plan.mjs landing                       version=, tag=  (the checked-out landing)
//   node scripts/release-plan.mjs dry-run                       version=        (what this merge would mint)
//   node scripts/release-plan.mjs dist-tag --version <v>        dist-tag=       (asks the npm registry)
//   node scripts/release-plan.mjs promote --version <v> [--allow-older] [--github-only]
//                                                               version=, noop= (asks GitHub and npm)
//
// Each writes its outputs to $GITHUB_OUTPUT when set, and to standard output otherwise. A refusal
// exits 1 with the reason on standard error and writes no output.

import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { documentedVersions, releasedVersions } from "./check-changelog.mjs";
import { computeNextVersion, declaredVersion, gitTags, refreshTags } from "./next-version.mjs";

const RELEASE_TAG = /^v(\d+\.\d+\.\d+)$/;
// The first version a landing released (ADR-0048). Earlier ones were released by hand, and their
// tags predate the workflows a promotion runs on them.
const FIRST_PER_MERGE_VERSION = "0.26.0";

// A landing's version is the newest section of its changelog. The per-merge changelog check held
// that section to `next-version.mjs`'s answer when the pull request ran, so reading it back here,
// rather than computing again, cannot race a second landing whose release is running beside it.
// A landing with no section of its own, a Dependabot pull request's or one whose number another
// landing took first, is still a version: the next one `next-version.mjs` gives, which the next
// pull request's changelog check then requires a section for (`Skipped tags: backfill`).
export function planLanding({ changelog, declared, tags, tagsAtCommit }) {
  const released = releasedVersions(tagsAtCommit);
  if (released.length > 0) return { version: released[0], tag: false };
  const version = documentedVersions(changelog)[0];
  if (!version) {
    throw new Error("CHANGELOG.md has no `## [x.y.z]` section, so this landing names no version.");
  }
  const [line, section] = [parse(declared), parse(version)];
  if (section[0] !== line[0] || section[1] !== line[1]) {
    throw new Error(`The newest section, [${version}], is not on the release line ${line[0]}.${line[1]} ` +
      "that package.json declares.");
  }
  if (compareVersions(version, declared) < 0) {
    throw new Error(`The newest section, [${version}], is below the declared version ${declared}.`);
  }
  if (releasedVersions(tags).includes(version)) {
    return { version: computeNextVersion(declared, tags), tag: true };
  }
  return { version, tag: true };
}

// A dry run builds the version the merge would mint, or one past it when that is package.json's
// own (a new line's first), so every dry run proves the build takes its version from the stamp.
export function dryRunVersion({ declared, tags }) {
  const next = computeNextVersion(declared, tags);
  if (next !== String(declared).trim()) return next;
  const [major, minor, build] = parse(next);
  return `${major}.${minor}.${build + 1}`;
}

// npm moves the dist-tag a publish names, so a build that finishes after a newer one publishes
// under `superseded` instead of moving `next` backwards. `latest` only moves by promotion.
export function distTagForBuild({ version, distTags }) {
  const next = distTags.next;
  return next && RELEASE_TAG.test(`v${next}`) && compareVersions(version, next) < 0 ? "superseded" : "next";
}

// Only a version a landing built and published can become stable: it has its tag, a published
// GitHub release, and every npm package. Promotion never moves `latest` backwards unless asked, and
// promoting the stable release again changes nothing; a promotion that moved npm's `latest` but
// did not finish the GitHub release is completed instead.
export function planPromotion({ version, tags, release, unpublished, latest, allowOlder }) {
  parse(version);
  if (compareVersions(version, FIRST_PER_MERGE_VERSION) < 0) {
    throw new Error(`${version} predates ${FIRST_PER_MERGE_VERSION}, the first version a landing ` +
      "released; roll back that far by hand (npm dist-tag add, gh release edit --latest).");
  }
  if (!releasedVersions(tags).includes(version)) throw new Error(`There is no tag v${version}.`);
  if (!release) throw new Error(`v${version} has no GitHub release.`);
  if (release.isDraft) throw new Error(`v${version}'s GitHub release is a draft.`);
  if (unpublished.length > 0) throw new Error(`npm has no ${version} of ${unpublished.join(", ")}.`);
  if (latest === version && !release.isPrerelease) return { version, noop: true };
  if (latest && RELEASE_TAG.test(`v${latest}`) && compareVersions(version, latest) < 0 && !allowOlder) {
    throw new Error(`${version} is older than the stable release ${latest}. ` +
      "Promote it again with allow-older to roll the stable release back.");
  }
  return { version, noop: false };
}

function parse(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`'${version}' is not an x.y.z version.`);
  return version.split(".").map(Number);
}

export function compareVersions(a, b) {
  const [left, right] = [parse(a), parse(b)];
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}

// Every package a release publishes: the main package and one per platform (ADR-0038).
export function releasePackages() {
  const { PLATFORMS } = createRequire(import.meta.url)("../bin/native/platform.js");
  return [mainPackage(), ...Object.values(PLATFORMS).map((platform) => platform.package)];
}

function run(command, args, root) {
  // Windows runs npm through its .cmd shim, which needs a shell; the arguments are package names
  // and a version parseArgs has checked, so one quoted command line is safe.
  const shim = process.platform === "win32" && command === "npm";
  const result = shim
    ? spawnSync([command, ...args.map((arg) => `"${arg}"`)].join(" "), { cwd: root, encoding: "utf8", windowsHide: true, shell: true })
    : spawnSync(command, args, { cwd: root, encoding: "utf8", windowsHide: true });
  return { ok: result.status === 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function git(root, args) {
  const result = run("git", args, root);
  if (!result.ok) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout.split(/\r?\n/).filter(Boolean);
}

function mainPackage() {
  return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).name;
}

function npmDistTags(root) {
  const result = run("npm", ["view", mainPackage(), "dist-tags", "--json"], root);
  if (result.ok) {
    // npm 12 wraps a view's JSON in an array; earlier versions print the object itself.
    const parsed = JSON.parse(result.stdout || "{}");
    return Array.isArray(parsed) ? Object.assign({}, ...parsed) : parsed;
  }
  if (/E404/.test(result.stderr)) return {};
  throw new Error(`npm view ${mainPackage()} dist-tags failed: ${result.stderr.trim()}`);
}

function npmHas(root, name, version) {
  const result = run("npm", ["view", `${name}@${version}`, "version", "--json"], root);
  if (!result.ok && !/E404/.test(result.stderr)) {
    throw new Error(`npm view ${name}@${version} failed: ${result.stderr.trim()}`);
  }
  return result.ok && result.stdout.includes(version);
}

function githubRelease(root, version) {
  const result = run("gh", ["release", "view", `v${version}`, "--json", "isPrerelease,isDraft"], root);
  if (result.ok) return JSON.parse(result.stdout);
  if (/release not found/i.test(result.stderr)) return null;
  throw new Error(`gh release view v${version} failed: ${result.stderr.trim()}`);
}

// The version of the release GitHub marks latest, which the install scripts install by default.
function githubLatest(root) {
  const result = run("gh", ["release", "view", "--json", "tagName"], root);
  if (!result.ok) {
    if (/release not found/i.test(result.stderr)) return null;
    throw new Error(`gh release view failed: ${result.stderr.trim()}`);
  }
  return RELEASE_TAG.exec(JSON.parse(result.stdout).tagName)?.[1] ?? null;
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { command, version: null, allowOlder: false, githubOnly: false };
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] === "--allow-older") options.allowOlder = true;
    else if (rest[index] === "--github-only") options.githubOnly = true;
    else if (rest[index] === "--version" && rest[index + 1]) options.version = rest[++index];
    else throw new Error(`Unknown argument: ${rest[index]}`);
  }
  if (["dist-tag", "promote"].includes(command)) {
    if (!options.version) throw new Error(`${command} needs --version <x.y.z>.`);
    parse(options.version);
  }
  return options;
}

export function main(argv, root = process.cwd()) {
  const options = parseArgs(argv);
  let outputs;
  if (options.command === "landing") {
    refreshTags(root);
    const plan = planLanding({
      changelog: readFileSync(path.join(root, "CHANGELOG.md"), "utf8"),
      declared: String(declaredVersion(root)).trim(),
      tags: gitTags(root),
      tagsAtCommit: git(root, ["tag", "--points-at", "HEAD"]),
    });
    outputs = { version: plan.version, tag: plan.tag };
  } else if (options.command === "dry-run") {
    refreshTags(root);
    outputs = { version: dryRunVersion({ declared: declaredVersion(root), tags: gitTags(root) }) };
  } else if (options.command === "dist-tag") {
    outputs = { "dist-tag": distTagForBuild({ version: options.version, distTags: npmDistTags(root) }) };
  } else if (options.command === "promote") {
    refreshTags(root);
    // Without npm (NPM_PUBLISH is not `true`), the stable release is GitHub's latest alone.
    const plan = planPromotion({
      version: options.version,
      tags: gitTags(root),
      release: githubRelease(root, options.version),
      unpublished: options.githubOnly ? [] : releasePackages().filter((name) => !npmHas(root, name, options.version)),
      latest: options.githubOnly ? githubLatest(root) : npmDistTags(root).latest ?? null,
      allowOlder: options.allowOlder,
    });
    outputs = { version: plan.version, noop: plan.noop };
  } else {
    throw new Error("Usage: release-plan.mjs landing | dry-run | dist-tag --version <v> | promote --version <v> [--allow-older] [--github-only]");
  }
  const lines = Object.entries(outputs).map(([name, value]) => `${name}=${value}\n`).join("");
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, lines);
  else process.stdout.write(lines);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`release-plan: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
