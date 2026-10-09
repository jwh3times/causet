/**
 * The release gate's smoke sequence, run through an installed `cst` with Git
 * and nothing else on `PATH` (docs/testing.md, release gate 9). A command that
 * still needed Node.js would fail to find it.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { testEnv } from "./git-environment.js";

const windows = process.platform === "win32";

/** Where Git is, and an environment whose `PATH` holds it and `extra` only. */
export function bareEnvironment(directory, extra = []) {
  const git = spawnSync(windows ? "where" : "which", ["git"], { encoding: "utf8" }).stdout.split(/\r?\n/)[0];
  fs.mkdirSync(directory, { recursive: true });
  if (windows) {
    return { git, env: testEnv({ PATH: [path.dirname(git), `${process.env.SystemRoot}\\System32`, ...extra].join(";") }) };
  }
  for (const tool of [git, ...extra]) {
    const link = path.join(directory, path.basename(tool));
    if (!fs.existsSync(link)) fs.symlinkSync(tool, link);
  }
  return { git, env: testEnv({ PATH: directory }) };
}

/**
 * `init`, `commit`, `branch`, a compact landing, `metadata validate` and
 * `doctor` in a new repository at `repo`. `launch(args, { cwd, env })` runs the
 * installed command. Returns the doctor report.
 */
export function smokeSequence({ launch, git, env, repo }) {
  fs.mkdirSync(repo, { recursive: true });
  const run = (command, ...args) => {
    const ran = command === "git"
      ? spawnSync(git, args, { cwd: repo, encoding: "utf8", env })
      : launch(args, { cwd: repo, env });
    assert.equal(ran.status, 0, `${command} ${args.join(" ")}\n${ran.stdout}\n${ran.stderr}`);
    return ran.stdout;
  };
  run("git", "init", "-q", "-b", "main");
  run("git", "config", "user.name", "Smoke");
  run("git", "config", "user.email", "smoke@example.invalid");
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
  return JSON.parse(run("cst", "doctor"));
}
