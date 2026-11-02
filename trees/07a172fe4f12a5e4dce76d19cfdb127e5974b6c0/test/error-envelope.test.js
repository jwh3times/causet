/**
 * The failure contract (ADR-0021, issue #12, FR-GIT-06).
 *
 * `--json` used to have no effect on the failure path: JSON on success, prose
 * on failure, and an exit code that is 1 for nearly everything. ADR-0020 made
 * the *cause* of a refusal contractual — an unreadable schema version, a
 * wrong-family record, an exceeded bound each imply a different response — and
 * a contract a caller cannot read is not much of one.
 *
 * Two of these tests are static. They scan the source rather than run it,
 * because the property that matters is "every raise site is classified", and
 * no amount of exercising the CLI proves that about the sites no test reaches.
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { ERROR_CODES, ERROR_ENVELOPE_SCHEMA } from "../src/errors.js";
import { testEnv } from "../test-support/git-environment.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(projectRoot, "bin", "vlab.js");

const sourceDir = path.join(projectRoot, "src");

const created = [];
after(() => {
  for (const directory of created) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * Every `new CliError(...)` argument list in a source file, found by matching
 * parentheses rather than by a regex that would stop at the first `)` inside a
 * template literal or a nested call.
 */
function raiseSites(text) {
  const sites = [];
  const opener = /new CliError\(/g;
  let match;
  while ((match = opener.exec(text)) !== null) {
    let index = match.index + match[0].length;
    let depth = 1;
    let quote = null;
    let template = 0;
    while (index < text.length && depth > 0) {
      const character = text[index];
      if (quote) {
        if (character === "\\") { index += 2; continue; }
        if (quote === "`" && character === "$" && text[index + 1] === "{") {
          template += 1; index += 2; continue;
        }
        if (quote === "`" && character === "}" && template > 0) {
          template -= 1; index += 1; continue;
        }
        if (character === quote && template === 0) quote = null;
        index += 1;
        continue;
      }
      if (character === '"' || character === "'" || character === "`") {
        quote = character; index += 1; continue;
      }
      if (character === "(") depth += 1;
      else if (character === ")") depth -= 1;
      index += 1;
    }
    sites.push({
      line: text.slice(0, match.index).split("\n").length,
      args: text.slice(match.index + match[0].length, index - 1),
    });
  }
  return sites;
}

function allRaiseSites() {
  const found = [];
  for (const name of fs.readdirSync(sourceDir).filter((f) => f.endsWith(".js"))) {
    const text = fs.readFileSync(path.join(sourceDir, name), "utf8");
    for (const site of raiseSites(text)) found.push({ file: name, ...site });
  }
  return found;
}

function makeRepo() {
  const parent = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "vcs-lab-error-")));
  created.push(parent);
  const repo = path.join(parent, "repo");
  fs.mkdirSync(repo);
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", env: testEnv() });
  git("init", "-b", "main");
  git("config", "core.autocrlf", "false");
  git("config", "user.name", "VCS Lab Error Test");
  git("config", "user.email", "vcs-lab-error@example.invalid");
  fs.writeFileSync(path.join(repo, "a.txt"), "base\n");
  git("add", "-A");
  execFileSync(process.execPath, [cli, "commit", "-m", "base"], { cwd: repo, encoding: "utf8", env: testEnv() });
  execFileSync(process.execPath, [cli, "init"], { cwd: repo, encoding: "utf8", env: testEnv() });
  return repo;
}

const run = (repo, ...args) =>
  spawnSync(process.execPath, [cli, ...args], {
    cwd: repo,
    encoding: "utf8",
    env: testEnv(),
  });

test("every raise site carries a code from the published vocabulary", () => {
  // The property ADR-0021 asks for, and the reason it is checked statically:
  // an uncoded raise site is a defect wherever it is, including in the paths
  // no test reaches. There is deliberately no `unknown` code to fall back to,
  // so a new raise site cannot be added without deciding what it means.
  const sites = allRaiseSites();
  assert.ok(sites.length > 200, `expected the whole source scanned, found ${sites.length}`);

  const uncoded = [];
  const unpublished = [];
  for (const site of sites) {
    const match = site.args.match(/\bcode:\s*"([a-z-]+)"/);
    if (!match) {
      uncoded.push(`${site.file}:${site.line}`);
      continue;
    }
    if (!Object.hasOwn(ERROR_CODES, match[1])) {
      unpublished.push(`${site.file}:${site.line} -> ${match[1]}`);
    }
  }
  assert.deepEqual(uncoded, [], `raise sites with no error code:\n${uncoded.join("\n")}`);
  assert.deepEqual(
    unpublished,
    [],
    `raise sites using a code outside ERROR_CODES:\n${unpublished.join("\n")}`,
  );
});

test("the published vocabulary has no dead members", () => {
  // The other direction. A code nothing raises is a promise to callers that
  // the tool never keeps, and it is how a published vocabulary rots: removing
  // one later is a version bump, so it should not be added speculatively.
  const used = new Set();
  for (const site of allRaiseSites()) {
    const match = site.args.match(/\bcode:\s*"([a-z-]+)"/);
    if (match) used.add(match[1]);
  }
  const dead = Object.keys(ERROR_CODES).filter((code) => !used.has(code));
  assert.deepEqual(dead, [], `codes in ERROR_CODES that nothing raises: ${dead.join(", ")}`);
});

test("every code states what it means", () => {
  for (const [code, meaning] of Object.entries(ERROR_CODES)) {
    assert.match(code, /^[a-z][a-z-]*[a-z]$/, `${code}: kebab-case`);
    // The bar is substance, not phrasing: a description may well contain the
    // slug's own words ("already exists" is the clearest way to say it). What
    // it may not be is a restatement with nothing added, since the whole point
    // of the vocabulary is telling a caller what to do next.
    assert.ok(
      meaning.split(/\s+/).length >= 10,
      `${code}: the meaning must say what happened and what to do, not restate the slug`,
    );
    assert.match(meaning, /\.$/, `${code}: the meaning reads as prose`);
  }
});

test("the published vocabulary and the runtime map say the same thing", () => {
  // docs/schemas/errors.md is the published contract and src/errors.js is the
  // runtime authority, exactly as docs/schemas/ and src/schemas.js relate for
  // record families (ADR-0020). Publishing a table nothing checks is how the
  // two drift.
  const published = fs.readFileSync(
    path.join(projectRoot, "docs", "schemas", "errors.md"),
    "utf8",
  );
  const rows = new Map();
  for (const match of published.matchAll(/^\| `([a-z-]+)` \| (.+?) \|$/gm)) {
    rows.set(match[1], match[2].trim());
  }

  assert.deepEqual(
    [...rows.keys()].sort(),
    Object.keys(ERROR_CODES).sort(),
    "errors.md and ERROR_CODES must publish the same codes",
  );
  for (const [code, meaning] of Object.entries(ERROR_CODES)) {
    assert.equal(rows.get(code), meaning, `${code}: the published meaning must match`);
  }
});

test("a failure under --json is an envelope on stdout and nothing on stderr", () => {
  const repo = makeRepo();
  const failed = run(repo, "merge-plan", "does-not-exist", "--json");

  assert.notEqual(failed.status, 0);
  assert.equal(failed.stderr, "", "the JSON caller reads one stream, not two");

  const envelope = JSON.parse(failed.stdout);
  assert.equal(envelope.schema, ERROR_ENVELOPE_SCHEMA);
  assert.ok(Object.hasOwn(ERROR_CODES, envelope.code), `${envelope.code} is published`);
  assert.equal(envelope.exitCode, failed.status, "the envelope states the exit code it caused");
  assert.ok(envelope.message.length > 0);
  assert.equal(typeof envelope.details, "string");

  // The classification has to be the useful one. A caller who named a
  // reference that is not there must not be told to report a Git bug.
  assert.equal(envelope.code, "revision-not-resolved");
});

test("human output and exit codes are unchanged by the envelope", () => {
  // ADR-0021 adds a mode; it must not reword the prose people already read or
  // move an exit code any existing caller branches on.
  const repo = makeRepo();
  const human = run(repo, "merge-plan", "does-not-exist");
  const json = run(repo, "merge-plan", "does-not-exist", "--json");

  assert.equal(human.stdout, "", "the human path still writes its failure to stderr");
  assert.match(human.stderr, /^vlab: /m);
  assert.equal(
    human.status,
    json.status,
    "the same failure exits the same way in both modes",
  );

  const envelope = JSON.parse(json.stdout);
  assert.ok(
    human.stderr.includes(envelope.message),
    "the envelope carries the same message the human path prints",
  );
});

test("a pre-dispatch failure keeps prose, because no output mode is known yet", () => {
  // The boundary is narrower than "before the command word": global flags are
  // consumed before the per-command options are parsed, so a failure there has
  // no --json to honor even when one was typed. Everything from the argument
  // parse onward is enveloped, which includes an unknown command.
  const repo = makeRepo();

  const globalFlag = run(repo, "--git-session", "--no-git-session", "receipts", "--json");
  assert.notEqual(globalFlag.status, 0);
  assert.equal(globalFlag.stdout, "", "no envelope: the mode was not known yet");
  assert.match(globalFlag.stderr, /^vlab: Choose only one of/m);

  const unknownCommand = run(repo, "no-such-command", "--json");
  assert.notEqual(unknownCommand.status, 0);
  assert.equal(
    JSON.parse(unknownCommand.stdout).code,
    "usage-unknown-command",
    "an unknown command is dispatched far enough to know the caller wanted JSON",
  );
});

test("the ADR-0020 refusals are readable without matching English", () => {
  // The refusals that motivated the envelope. Each implies a different caller
  // response, and before this a caller could only tell them apart by prose.
  const repo = makeRepo();

  const journal = path.join(repo, ".git", "vcs-lab", "reconciliation.json");
  fs.mkdirSync(path.dirname(journal), { recursive: true });
  fs.writeFileSync(
    journal,
    JSON.stringify({ schema: "vcs-lab.reconciliation-operation/v99", id: "reconcile_op_x" }),
  );
  const unknownVersion = run(repo, "reconcile", "--status", "--json");
  assert.notEqual(unknownVersion.status, 0);
  assert.equal(
    JSON.parse(unknownVersion.stdout).code,
    "unknown-schema-version",
    "a journal from a newer build is refused with a code that says to use that build",
  );
  fs.rmSync(journal);

  const missingArgument = run(repo, "cherry-pick", "--json");
  assert.notEqual(missingArgument.status, 0);
  assert.equal(JSON.parse(missingArgument.stdout).code, "usage-missing-argument");
});

test("a missing revision is classified the same way on both Git transports", () => {
  // The object session answers reads in-process on Windows by default and is
  // off by default elsewhere. The session path always said
  // `revision-not-resolved`; the one-process fallback let `git rev-parse` fail
  // and reported `git-command-failed`, so the same command published different
  // codes on the two platforms and the release gate, run where the session is
  // on, could not see it.
  const repo = makeRepo();
  const codes = {};
  for (const session of ["0", "1"]) {
    const failed = spawnSync(process.execPath, [cli, "merge-plan", "does-not-exist", "--json"], {
      cwd: repo,
      encoding: "utf8",
      env: testEnv({ VLAB_GIT_SESSION: session }),
    });
    assert.notEqual(failed.status, 0);
    assert.equal(failed.stderr, "");
    const envelope = JSON.parse(failed.stdout);
    codes[session] = envelope;
  }
  assert.equal(codes["0"].code, "revision-not-resolved", "process transport");
  assert.equal(codes["1"].code, "revision-not-resolved", "session transport");
  assert.equal(codes["0"].message, codes["1"].message, "and the message does not depend on the transport");
});

test("a conflicted landing, a duplicate workspace, and a stale manifest carry their own codes", () => {
  // Three refusals that hid behind the wrong code: the landing threw a bare
  // Error (so the envelope reported null), the duplicate workspace said
  // not-found, and the stale manifest said stale-forecast.
  const repo = makeRepo();
  const parent = path.dirname(repo);
  const git = (...args) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8", env: testEnv() }).trim();
  const vlab = (...args) =>
    execFileSync(process.execPath, [cli, ...args], { cwd: repo, encoding: "utf8", env: testEnv() }).trim();
  const notesRef = () =>
    spawnSync("git", ["rev-parse", "--verify", "--quiet", "refs/notes/vcs-lab"], {
      cwd: repo,
      encoding: "utf8",
      env: testEnv(),
    }).stdout.trim();

  git("switch", "-c", "feature");
  fs.writeFileSync(path.join(repo, "a.txt"), "feature\n");
  git("add", "-A");
  vlab("commit", "-m", "feature side");
  git("switch", "main");
  fs.writeFileSync(path.join(repo, "a.txt"), "main\n");
  git("add", "-A");
  vlab("commit", "-m", "main side");
  const notesBefore = notesRef();

  const landing = run(repo, "compact-merge", "feature", "-m", "land feature", "--json");
  assert.notEqual(landing.status, 0);
  assert.equal(JSON.parse(landing.stdout).code, "conflict-blocked");
  assert.equal(notesRef(), notesBefore, "no receipt is recorded for a conflicted landing");
  git("merge", "--abort");
  assert.equal(git("status", "--porcelain=v1"), "");

  const created = run(repo, "workspace", "create", "w1", "--path", path.join(parent, "w1"), "--json");
  assert.equal(created.status, 0, created.stderr);
  const duplicate = run(
    repo, "workspace", "create", "w1", "--path", path.join(parent, "w1-again"), "--json",
  );
  assert.notEqual(duplicate.status, 0);
  assert.equal(JSON.parse(duplicate.stdout).code, "already-exists");

  fs.writeFileSync(path.join(repo, "spec.md"), "# Spec\n\nREQ-E-01: Codes are stable.\n");
  vlab("spec", "index", "spec.md");
  git("add", "-A");
  vlab("commit", "-m", "spec");
  fs.writeFileSync(
    path.join(repo, "spec.md"),
    "# Spec\n\nREQ-E-01: Codes are stable and published.\n",
  );
  const stale = run(repo, "spec", "show", "spec.md", "--json");
  assert.notEqual(stale.status, 0);
  assert.equal(JSON.parse(stale.stdout).code, "stale-manifest");
});
