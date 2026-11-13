import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { distTagForBuild, dryRunVersion, planLanding, planPromotion } from "../scripts/release-plan.mjs";
import { testEnv } from "../test-support/git-environment.js";

const planner = fileURLToPath(new URL("../scripts/release-plan.mjs", import.meta.url));

const changelog = (...versions) => [
  "# Changelog", "", "## [Unreleased]", "", "No unreleased changes.", "",
  ...versions.flatMap((version) => [`## [${version}] - 2026-11-12`, "", "- An entry.", ""]),
].join("\n");

test("a landing is tagged with the version its newest changelog section names", () => {
  assert.deepEqual(planLanding({
    changelog: changelog("0.26.3", "0.26.2"),
    declared: "0.26.0",
    tags: ["v0.25.1", "v0.26.0", "v0.26.1", "v0.26.2"],
    tagsAtCommit: [],
  }), { version: "0.26.3", tag: true });
});

test("a landing that already carries its tag is not tagged again, so a re-run can publish it", () => {
  assert.deepEqual(planLanding({
    changelog: changelog("0.26.3", "0.26.2"),
    declared: "0.26.0",
    tags: ["v0.26.2", "v0.26.3"],
    tagsAtCommit: ["v0.26.3"],
  }), { version: "0.26.3", tag: false });
});

test("a landing with no section of its own is released as the next version, for a later section to backfill", () => {
  // A Dependabot landing writes no section, and a pull request that was not renumbered names a
  // version another landing took; either way the landing is still a version (Skipped tags: backfill).
  assert.deepEqual(planLanding({
    changelog: changelog("0.26.3", "0.26.2"),
    declared: "0.26.0",
    tags: ["v0.26.2", "v0.26.3"],
    tagsAtCommit: [],
  }), { version: "0.26.4", tag: true });
});

test("a re-run keeps the version a landing was already released as, whatever its newest section", () => {
  // The first run gave a landing with no section of its own the next version.
  assert.deepEqual(planLanding({
    changelog: changelog("0.26.3", "0.26.2"),
    declared: "0.26.0",
    tags: ["v0.26.3", "v0.26.4"],
    tagsAtCommit: ["v0.26.4"],
  }), { version: "0.26.4", tag: false });
});

test("a landing with no versioned changelog section is refused", () => {
  assert.throws(() => planLanding({
    changelog: "# Changelog\n\n## [Unreleased]\n\n- An entry.\n",
    declared: "0.26.0",
    tags: [],
    tagsAtCommit: [],
  }), /no `## \[x\.y\.z\]` section/);
});

test("a landing whose version is off the declared release line or below its floor is refused", () => {
  for (const version of ["0.27.0", "0.25.9", "1.26.0"]) {
    assert.throws(() => planLanding({
      changelog: changelog(version),
      declared: "0.26.0",
      tags: [],
      tagsAtCommit: [],
    }), /not on the release line 0\.26/, version);
  }
  assert.throws(() => planLanding({
    changelog: changelog("0.26.1"),
    declared: "0.26.2",
    tags: [],
    tagsAtCommit: [],
  }), /below the declared version 0\.26\.2/);
});

test("other tags at the landing commit do not count as a release", () => {
  assert.deepEqual(planLanding({
    changelog: changelog("0.26.0"),
    declared: "0.26.0",
    tags: ["v0.25.1", "v1.1.1.3"],
    tagsAtCommit: ["v1.1.1.3", "checkpoint"],
  }), { version: "0.26.0", tag: true });
});

test("a build is published as npm's next unless a newer build already is", () => {
  assert.equal(distTagForBuild({ version: "0.26.3", distTags: { latest: "0.25.1", next: "0.26.2" } }), "next");
  assert.equal(distTagForBuild({ version: "0.26.0", distTags: { latest: "0.25.1" } }), "next");
  assert.equal(distTagForBuild({ version: "0.26.0", distTags: {} }), "next");
  // Two landings' releases run side by side; the older one finishing second must not move next back.
  assert.equal(distTagForBuild({ version: "0.26.2", distTags: { latest: "0.25.1", next: "0.26.3" } }), "superseded");
});

const promotable = {
  version: "0.26.3",
  tags: ["v0.25.1", "v0.26.0", "v0.26.3"],
  release: { isPrerelease: true, isDraft: false },
  unpublished: [],
  latest: "0.25.1",
  allowOlder: false,
};

test("a built and published version newer than the stable release can be promoted", () => {
  assert.deepEqual(planPromotion(promotable), { version: "0.26.3", noop: false });
});

test("a promotion refuses a version that was never built and published", () => {
  assert.throws(() => planPromotion({ ...promotable, version: "0.26.4" }), /There is no tag v0\.26\.4/);
  assert.throws(() => planPromotion({ ...promotable, release: null }), /v0\.26\.3 has no GitHub release/);
  assert.throws(() => planPromotion({ ...promotable, release: { isPrerelease: false, isDraft: true } }),
    /v0\.26\.3's GitHub release is a draft/);
  assert.throws(() => planPromotion({ ...promotable, unpublished: ["@holland-vip/causet-win32-x64"] }),
    /npm has no 0\.26\.3 of @holland-vip\/causet-win32-x64/);
  assert.throws(() => planPromotion({ ...promotable, version: "v0.26.3" }), /not an x\.y\.z version/);
});

test("a promotion refuses to move the stable release backwards unless told to", () => {
  const older = { ...promotable, version: "0.26.0", latest: "0.26.3" };
  assert.throws(() => planPromotion(older), /0\.26\.0 is older than the stable release 0\.26\.3.*allow-older/);
  assert.deepEqual(planPromotion({ ...older, allowOlder: true }), { version: "0.26.0", noop: false });
});

test("promoting the stable release again is a no-op, and finishing a half-done promotion is not", () => {
  const stable = { ...promotable, latest: "0.26.3" };
  assert.deepEqual(planPromotion({ ...stable, release: { isPrerelease: false, isDraft: false } }),
    { version: "0.26.3", noop: true });
  assert.deepEqual(planPromotion(stable), { version: "0.26.3", noop: false });
});

test("the CLI writes the landing's version and the dry run's as Actions outputs", (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "vcs-lab-release-plan-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd, env: testEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init");
  git("config", "user.name", "CI Test");
  git("config", "user.email", "ci@example.test");
  fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ version: "0.26.0" }));
  fs.writeFileSync(path.join(cwd, "CHANGELOG.md"), changelog("0.26.0"));
  git("add", ".");
  git("commit", "-m", "the first landing on the line");
  git("tag", "v0.26.0");
  fs.writeFileSync(path.join(cwd, "CHANGELOG.md"), changelog("0.26.1", "0.26.0"));
  git("commit", "-am", "the second landing");

  const run = (...args) => {
    const output = path.join(cwd, "output.txt");
    fs.writeFileSync(output, "");
    const ran = spawnSync(process.execPath, [planner, ...args], {
      cwd, env: testEnv({ GITHUB_OUTPUT: output }), encoding: "utf8",
    });
    return { ...ran, outputs: fs.readFileSync(output, "utf8").trim().split("\n").filter(Boolean) };
  };
  assert.deepEqual(run("landing").outputs, ["version=0.26.1", "tag=true"]);
  assert.deepEqual(run("dry-run").outputs, ["version=0.26.1"]);

  fs.writeFileSync(path.join(cwd, "CHANGELOG.md"), changelog("0.27.0", "0.26.0"));
  git("commit", "-am", "a section off the declared line");
  const refused = run("landing");
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /release-plan: The newest section, \[0\.27\.0\], is not on the release line 0\.26/);
  assert.deepEqual(refused.outputs, []);
});

test("a dry run builds a version package.json does not name, so the stamp is always exercised", () => {
  assert.equal(dryRunVersion({ declared: "0.26.0", tags: ["v0.26.0", "v0.26.1"] }), "0.26.2");
  // A new line's first version is package.json's own; the dry run goes one past it.
  assert.equal(dryRunVersion({ declared: "0.26.0", tags: ["v0.25.1"] }), "0.26.1");
});

test("a version from before every landing was released cannot be promoted", () => {
  // Those were released by hand; their tags predate the workflows promote.yml runs on them.
  assert.throws(() => planPromotion({ ...promotable, version: "0.25.1", tags: ["v0.25.1"], latest: "0.25.1",
    release: { isPrerelease: true, isDraft: false } }), /0\.25\.1 predates 0\.26\.0/);
  assert.deepEqual(planPromotion({ ...promotable, version: "0.26.0", latest: "0.25.1" }),
    { version: "0.26.0", noop: false });
});
