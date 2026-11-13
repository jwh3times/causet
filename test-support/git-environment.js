import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, beforeEach } from "node:test";
import { cliInvocations, resetCliInvocations, selectedCli } from "./cst-command.js";
import { installNativeKind, nativeKind } from "./native-kind.js";

/**
 * The environment for every Git and CLI process a suite spawns. Besides
 * disabling credential prompts, it isolates the suite from the host's Git
 * configuration: the system file is disabled and the global file is an empty
 * one created for this run, so a `commit.gpgsign`, `core.hooksPath`,
 * `init.defaultBranch`, or `core.autocrlf` set on the host cannot reach a
 * fixture. Fixtures set `user.name` and `user.email` locally. The CLI itself
 * is not changed: outside the suite it reads the user's real configuration.
 *
 * The one setting the file does carry turns off Git's automatic maintenance.
 * `git commit` otherwise starts `git maintenance run --auto --detach`, and
 * where Git can detach, newer versions leave `objects/maintenance.lock` for
 * the detached process to remove a few milliseconds after the commit has
 * returned. A suite that copies a fixture right after building it could list
 * that file and then fail to copy it (#203).
 *
 * This module lives beside `test/` rather than inside it because `node --test`
 * runs every JavaScript file under `test/**` as a test file, so a shared
 * helper there would be executed as one. Every suite file runs in
 * its own process and imports this module once, so the configuration is
 * created and removed per process.
 */
export const isolatedGitConfigDir = fs.realpathSync.native(
  fs.mkdtempSync(path.join(os.tmpdir(), "vcs-lab-gitconfig-")),
);
export const isolatedGitConfig = path.join(isolatedGitConfigDir, "gitconfig");
fs.writeFileSync(isolatedGitConfig, "[maintenance]\n\tauto = false\n");
after(() => fs.rmSync(isolatedGitConfigDir, { recursive: true, force: true }));

export function testEnv(overrides = {}) {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: isolatedGitConfig,
    ...overrides,
  };
}

/**
 * The override that makes `git init` create a files repository whatever
 * `GIT_DEFAULT_REF_FORMAT` the run sets (#277). It is for a fixture whose
 * subject only files storage has: a loose ref file's path, the native read
 * engine's supported profile, or answers frozen on files storage. A Git
 * before 2.45 has no other storage and ignores the variable.
 */
export const FILES_REFS = { GIT_DEFAULT_REF_FORMAT: "files" };

/**
 * The override that makes `git init` create a SHA-1 repository whatever
 * `GIT_DEFAULT_HASH` the run sets (#278). It is for a fixture whose subject
 * only SHA-1 has: objects or answers recorded under SHA-1, such as a frozen
 * bundle or oracle, or a native store, which is SHA-1 only for now.
 */
export const SHA1_OBJECTS = { GIT_DEFAULT_HASH: "sha1" };

/** The storage the frozen oracles were recorded on: files refs, SHA-1 objects. */
export const FROZEN_STORAGE = { ...FILES_REFS, ...SHA1_OBJECTS };

/**
 * A regular expression matching one object ID of either format, for a test
 * that reads IDs from whatever repository the run creates.
 */
export const OBJECT_ID = /[0-9a-f]{40}(?:[0-9a-f]{24})?/;

let reftableSupport;

/**
 * Why this Git cannot create a reftable repository (Git 2.45 or later can),
 * or `false` when it can: a test's `skip` value.
 */
export function reftableUnsupported() {
  if (reftableSupport === undefined) {
    const probe = fs.mkdtempSync(path.join(os.tmpdir(), "vcs-lab-reftable-probe-"));
    try {
      const created = spawnSync("git", ["init", "-q", "--ref-format=reftable", probe], {
        encoding: "utf8", env: testEnv(),
      });
      reftableSupport = created.status === 0
        ? false
        : "this Git cannot create a reftable repository (Git 2.45 or later can)";
    } finally {
      fs.rmSync(probe, { recursive: true, force: true });
    }
  }
  return reftableSupport;
}

/**
 * Hold `ref` locked the way a concurrent Git does, whichever ref storage the
 * repository uses: a `git update-ref --stdin` transaction is prepared and left
 * open (#277). With files storage that is the ref's `.lock` file; a reftable
 * repository locks its whole stack, so every ref write fails while it is held.
 * Resolves, once the lock is held, to a function that aborts the transaction
 * and waits for Git to exit.
 */
export async function holdRefLock(cwd, ref) {
  const target = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8", env: testEnv() }).trim();
  const child = spawn("git", ["update-ref", "--stdin"], { cwd, env: testEnv(), windowsHide: true });
  const exited = new Promise((resolve) => child.once("close", resolve));
  let stdout = "";
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  await new Promise((resolve, reject) => {
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
      if (stdout.includes("prepare: ok")) resolve();
    });
    exited.then((code) => reject(new Error(`git update-ref --stdin exited ${code} before holding ${ref}: ${stderr}`)));
    child.stdin.write(`start\nupdate ${ref} ${target}\nprepare\n`);
  });
  return async () => {
    child.stdin.end("abort\n");
    assert.equal(await exited, 0, stderr);
  };
}

/** Whether the repository at `cwd` keeps its refs in a reftable stack. */
export function usesReftable(cwd) {
  const commonDir = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd, encoding: "utf8", env: testEnv(),
  }).trim();
  return fs.existsSync(path.join(commonDir, "reftable"));
}

/**
 * When `CAUSET_CLI` selects another implementation, report every test that
 * never invoked it: such a test exercises the JavaScript modules directly and
 * says nothing about the selected CLI, whatever its result (ADR-0037, #140).
 * `CAUSET_CLI_REPORT=<file>` also appends one JSON line per such test, so a
 * whole run can be counted.
 */
if (selectedCli) {
  afterEach((t) => {
    if (cliInvocations() === 0) {
      t.diagnostic(`did not invoke the CLI under test (${selectedCli}); module-level test`);
      const report = process.env.CAUSET_CLI_REPORT;
      if (report) {
        fs.appendFileSync(report,
          `${JSON.stringify({ file: process.argv[1] ?? null, test: t.fullName })}\n`);
      }
    }
    resetCliInvocations();
  });
}

/**
 * `CAUSET_KIND=native` imports every repository each test leaves and
 * compares N1's commands on the native copy with Git's on the original
 * (`native-kind.js`, ADR-0044 item 1).
 */
if (nativeKind) {
  installNativeKind({ beforeEach, afterEach, after, env: testEnv });
}
