import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after } from "node:test";

/**
 * The environment for every Git and CLI process a suite spawns. Besides
 * disabling credential prompts, it isolates the suite from the host's Git
 * configuration: the system file is disabled and the global file is an empty
 * one created for this run, so a `commit.gpgsign`, `core.hooksPath`,
 * `init.defaultBranch`, or `core.autocrlf` set on the host cannot reach a
 * fixture. Fixtures set `user.name` and `user.email` locally. The CLI itself
 * is not changed: outside the suite it reads the user's real configuration.
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
fs.writeFileSync(isolatedGitConfig, "");
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
