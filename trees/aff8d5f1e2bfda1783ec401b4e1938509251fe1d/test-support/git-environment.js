import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach } from "node:test";
import { environmentValue } from "../src/environment.js";
import { cliInvocations, resetCliInvocations, selectedCli } from "./vlab-command.js";

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
 * runs every JavaScript file under a directory named `test` as a test file
 * (Node 20 by the directory's name, Node 22 and later by its `test/**` glob),
 * so a shared helper there would be executed as one. Every suite file runs in
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
      const report = environmentValue("CLI_REPORT");
      if (report) {
        fs.appendFileSync(report,
          `${JSON.stringify({ file: process.argv[1] ?? null, test: t.fullName })}\n`);
      }
    }
    resetCliInvocations();
  });
}
