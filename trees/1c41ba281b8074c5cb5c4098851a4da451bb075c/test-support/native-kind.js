/**
 * The native-kind suite mode (ADR-0044 item 1, #307): `CAUSET_KIND=native
 * npm test` runs every suite as usual and, after each test, imports every
 * Git repository the test left in its temporary directory into a native
 * repository. N1's commands then answer from the native copy, and their
 * answers must equal Git's on the original once Git's IDs are translated
 * through the import's alias map:
 *
 * - `cst import --verify` rebuilds every imported object to its Git ID, so a
 *   store problem fails as such rather than as some command's mismatch;
 * - `cst for-each-ref` and `cst rev-parse` answer for the refs and HEAD;
 * - `cst cat-file -t`, `-s` and `-p` answer for every imported object;
 * - `cst ls-tree -r -t -l` answers for everything a ref names.
 *
 * A test's repositories are found by giving each test its own temporary
 * directory: `TMPDIR`, `TEMP` and `TMP` name it while the test runs, so
 * `os.tmpdir()` and every process the test starts write there. After a
 * suite file's last test, everything it made is looked at again, and any
 * repository whose refs or HEAD changed since it was compared is compared
 * again. A
 * repository import refuses fails the test unless `REFUSALS` lists it with
 * its reason. The comparisons run as many at a time as the host has cores,
 * because each `cst` process opens the store again.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { aliases } from "./native-store.js";
import { PROCESS_LIMIT, bounded } from "./bounded-process.js";
import { cstCommand, cstPrefix } from "./cst-command.js";

/** Whether this run is the native-kind mode. */
export const nativeKind = process.env.CAUSET_KIND === "native";

/**
 * The repositories the suites make that import refuses, each with why. A
 * refusal matches when its suite file and test name are these and its
 * message contains `refusal`; any other refusal fails the test.
 */
export const REFUSALS = [
  {
    file: "native-repository.test.js",
    test: "shallow, partial and grafted sources are refused before anything is written, each naming why",
    refusal: "is a shallow clone",
    reason: "a shallow clone lacks commits its history names (ADR-0045, decision 1); the test makes one",
  },
  {
    file: "native-repository.test.js",
    test: "shallow, partial and grafted sources are refused before anything is written, each naming why",
    refusal: "is a partial clone",
    reason: "a partial clone may lack objects its history names (ADR-0045, decision 1); the test makes three",
  },
  {
    file: "native-import.test.js",
    test: "an import into a native repository that fails leaves it as it was",
    refusal: "but does not hold it",
    reason: "the test deletes an object the source's history names, so that import fails",
  },
  {
    file: "notes-session.test.js",
    test: "a missing notes subtree preserves Git's failure result instead of a partial catalog",
    refusal: "but does not hold it",
    reason: "the test points the notes ref at a tree whose subtree is missing",
  },
  {
    file: "integration.test.js",
    test: "batched resolution catalog lists retained records newest-first and quarantines mismatched retention state",
    refusal: "fatal: bad object refs/",
    reason: "the test leaves a ref naming an object the repository does not hold",
  },
  {
    file: "rust-engine.test.js",
    test: "(outside any test)",
    refusal: "fatal: bad object refs/",
    reason: "the suite's shared repository has a ref naming an object it does not hold",
  },
  {
    file: "rust-engine.test.js",
    test: "(outside any test)",
    refusal: "is a shallow clone",
    reason: "the suite clones this checkout, which CI fetches one commit deep",
  },
];

const TEMPORARY = ["TMPDIR", "TEMP", "TMP"];
const OPT_IN = { CAUSET_EXPERIMENTAL: "native" };

function point(directory) {
  for (const name of TEMPORARY) {
    process.env[name] = directory;
  }
}

/**
 * Installs the mode's hooks. `env` makes the suites' Git environment, so Git
 * and cst read no host configuration here either.
 */
export function installNativeKind({ beforeEach, afterEach, after, env }) {
  // Node runs a test's own `t.after` cleanup after `afterEach` only from
  // 20.5; before it, a repository a test removes there would go unchecked.
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 20 || (major === 20 && minor < 5)) {
    throw new Error(`CAUSET_KIND=native needs Node 20.5 or later, not ${process.versions.node}`);
  }
  // Every directory the mode makes sits directly in the host's temporary
  // directory under a short name: Windows refuses paths over 259 characters,
  // and some suites already come within a dozen of that.
  const base = os.tmpdir();
  const made = [];
  const directory = () => {
    const at = fs.realpathSync.native(fs.mkdtempSync(path.join(base, "ck")));
    made.push(at);
    return at;
  };
  const suite = directory();
  const copies = directory();
  const saved = Object.fromEntries(TEMPORARY.map((name) => [name, process.env[name]]));
  point(suite);
  process.on("exit", () => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    for (const each of made) {
      fs.rmSync(each, { recursive: true, force: true });
    }
  });

  // Each repository's refs and HEAD when it was last compared, by its common
  // directory: a repository is compared again whenever they have changed.
  const compared = new Map();
  const testDirectories = [];
  let copiesMade = 0;
  const file = path.basename(process.argv[1] ?? "");

  const check = async (directories, testName) => {
    const problems = [];
    for (const repository of directories.flatMap((each) => repositories(each, env))) {
      const state = fingerprint(repository, env);
      if (compared.get(repository.common) === state) continue;
      compared.set(repository.common, state);
      const destination = path.join(copies, String(++copiesMade));
      problems.push(...await compare(repository, destination, { env, file, testName }));
      fs.rmSync(destination, { recursive: true, force: true, maxRetries: 3 });
    }
    if (problems.length > 0) {
      throw new Error(`the native copy answers differently from Git:\n${problems.slice(0, 20).join("\n")}`
        + (problems.length > 20 ? `\n… and ${problems.length - 20} more` : ""));
    }
  };

  // A subtest runs these hooks too, inside its parent's, so each test's
  // directory and the one it replaced are kept on a stack.
  const running = [];
  beforeEach(() => {
    const own = directory();
    testDirectories.push(own);
    running.push({ own, outer: process.env.TMPDIR });
    point(own);
  });
  afterEach(async (t) => {
    const { own, outer } = running.pop();
    point(outer);
    await check([own], t.fullName);
  });
  // Last, everything the file made, inside a test or not, so a fixture one
  // test made and later tests changed is compared as they left it.
  after(() => check([suite, ...testDirectories], "(outside any test)"));
}

/** A repository's refs and HEAD, which are all an import of it reads from. */
function fingerprint(repository, env) {
  const refs = git(repository.path, ["for-each-ref", "--format=%(refname) %(objectname) %(symref)"], env);
  let head = "";
  try {
    head = fs.readFileSync(path.join(repository.common, "HEAD"), "latin1");
  } catch {
    // A repository without HEAD is compared, and fails, as Git reads it.
  }
  return `${refs.status} ${refs.stdout.toString("latin1")}\n${head}`;
}

/**
 * The Git repositories under `directory`, each once by its common directory:
 * a working tree's, a linked worktree's, or a bare repository.
 */
function repositories(directory, env) {
  const found = [];
  const walk = (at, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(at, { withFileTypes: true });
    } catch {
      return;
    }
    const names = new Set(entries.map((entry) => entry.name));
    if (names.has(".cst")) return;
    const bare = names.has("HEAD") && names.has("objects") && names.has("refs");
    if (names.has(".git") || bare) {
      const common = git(at, ["rev-parse", "--path-format=absolute", "--git-common-dir"], env);
      if (common.status === 0) {
        found.push({ path: at, common: common.stdout.toString().trim() });
      }
      if (bare) return;
    }
    if (depth === 0) return;
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== ".git" && entry.name !== "node_modules") {
        walk(path.join(at, entry.name), depth - 1);
      }
    }
  };
  walk(directory, 7);
  return found;
}

/**
 * A process's exit status and output, as `spawnSync` gives them. One that
 * runs past `PROCESS_LIMIT` is stopped, which fails its comparison.
 */
function run(command, args, { cwd, env, input, limit = PROCESS_LIMIT }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env, timeout: limit });
    const ending = bounded(child);
    const [stdout, stderr] = [[], []];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    // A process that cannot start is an answer that fails, not an exception
    // that would stop the other comparisons.
    child.on("error", (error) => resolve({ status: null, stdout: Buffer.alloc(0), stderr: Buffer.from(String(error)) }));
    child.on("close", (status, signal) => resolve({
      status, stdout: Buffer.concat(stdout), stderr: Buffer.concat([...stderr, Buffer.from(ending(signal))]),
    }));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

/** Git as import reads a repository: every object as stored, no replacement. */
function git(cwd, args, env, input) {
  return spawnSync("git", args, {
    cwd, env: env({ GIT_NO_REPLACE_OBJECTS: "1" }), input, encoding: "buffer", maxBuffer: 256 * 1024 * 1024,
  });
}

function gitAsync(cwd, args, env, input) {
  return run("git", args, { cwd, env: env({ GIT_NO_REPLACE_OBJECTS: "1" }), input });
}

function cst(cwd, args, env) {
  return run(cstCommand, [...cstPrefix(), ...args], { cwd, env: env(OPT_IN) });
}

let gitless = null;

/**
 * `environment` with a `PATH` that holds no Git, so that a process started
 * in it fails if it starts Git: a native repository runs none (ADR-0044
 * item 2).
 */
export function withoutGit(environment) {
  if (gitless === null) {
    gitless = fs.mkdtempSync(path.join(os.tmpdir(), "cst-no-git-"));
    const made = gitless;
    process.on("exit", () => fs.rmSync(made, { recursive: true, force: true }));
  }
  const kept = Object.entries(environment).filter(([name]) => name.toUpperCase() !== "PATH");
  return { ...Object.fromEntries(kept), PATH: gitless };
}

/**
 * `cst` reading a native repository without Git, so each comparison also
 * shows that a native read runs no Git process.
 */
function read(cwd, args, env, limit) {
  return run(cstCommand, [...cstPrefix(), ...args], { cwd, env: withoutGit(env(OPT_IN)), limit });
}

/** Runs `jobs`, each a function returning a promise, `width` at a time. */
async function pool(jobs, width) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(width, jobs.length) }, async () => {
    while (next < jobs.length) {
      await jobs[next++]();
    }
  }));
}

/** Imports one repository and compares N1's answers on the copy with Git's. */
async function compare(repository, destination, { env, file, testName }) {
  const where = `${file} › ${testName} › ${repository.path}`;
  const imported = await cst(path.dirname(destination), ["import", repository.path, destination], env);
  if (imported.status !== 0) {
    const reason = imported.stderr.toString().trim();
    const listed = REFUSALS.some((refusal) => refusal.file === file && refusal.test === testName
      && reason.includes(refusal.refusal));
    return listed ? [] : [`${where}: import refused, and REFUSALS does not list it: ${reason}`];
  }
  return compareCopy(repository, destination, { env, where });
}

/** At most how many bytes of Git's objects a comparison holds at once. */
const HELD = 64 * 1024 * 1024;

/**
 * N1's answers on `destination`, an import of `repository` (`{ path,
 * common }`), against Git's on it: the problems found, each starting with
 * `where`. `width` is how many processes run at a time. `select`, given the
 * Git IDs of every object the alias map names, returns those to compare one
 * by one; by default, all of them. `limit` bounds the reconstruction check,
 * which reads every object. Every `cst` here runs without Git.
 */
export async function compareCopy(repository, destination, { env, where, width = os.availableParallelism(), select = (ids) => ids, limit }) {
  const verified = await read(destination, ["import", "--verify"], env, limit);
  if (verified.status !== 0) {
    return [`${where}: import --verify failed: ${verified.stderr}`];
  }
  // Git answers for the common directory, so HEAD is the main worktree's,
  // which is the HEAD import records. It runs where no file is named like a
  // revision: inside a Git directory, `rev-parse HEAD` of an unborn branch
  // would name the file `HEAD` instead of failing.
  const inGit = (args) => ["--git-dir", repository.common, ...args];
  const neutral = path.dirname(destination);
  const format = git(neutral, inGit(["rev-parse", "--show-object-format"]), env).stdout.toString().trim();
  const rows = aliases(destination, format);
  const id = format === "sha1" ? "[0-9a-f]{40}" : "[0-9a-f]{64}";
  const swap = (pattern) => (text) => text.replace(pattern, (whole, before, git, after) =>
    rows.has(git) ? `${before}${rows.get(git)}${after}` : whole);
  // Only the IDs each answer names objects by are translated: a blob's bytes,
  // a commit's message and a tree entry's name stay Git's, whatever they hold.
  const entries = swap(new RegExp(`^(\\d+ \\w+ )(${id})([ \t])`, "gm"));
  const refs = swap(new RegExp(`^()(${id})( )`, "gm"));
  const lines = swap(new RegExp(`^()(${id})()$`, "gm"));
  const problems = [];
  const differs = (shown, expected, answered) => {
    // A panic or a signal is cst failing, whatever Git did.
    if (answered.status === null || answered.status === 101) {
      problems.push(`${where}: ${shown}: cst ended with ${answered.status ?? "a signal"}: ${answered.stderr}`);
      return;
    }
    if ((expected.status === 0) !== (answered.status === 0)) {
      problems.push(`${where}: ${shown}: git exits ${expected.status}, cst ${answered.status}: ${answered.stderr}`);
      return;
    }
    const wanted = expected.stdout.toString("latin1");
    const got = answered.stdout.toString("latin1");
    if (got !== wanted) {
      problems.push(`${where}: ${shown}: git answers ${JSON.stringify(wanted.slice(0, 300))}, cst ${JSON.stringify(got.slice(0, 300))}`);
    }
  };
  const jobs = [];
  const same = (gitArgs, cstArgs, translate) => jobs.push(async () => {
    const [expected, answered] = await Promise.all([gitAsync(neutral, inGit(gitArgs), env), read(destination, cstArgs, env)]);
    const answer = translate(expected.stdout.toString("latin1"));
    differs(`git ${gitArgs.join(" ")}`, { status: expected.status, stdout: Buffer.from(answer, "latin1") }, answered);
  });
  const known = (gitArgs, cstArgs, stdout) => jobs.push(async () => {
    differs(`git ${gitArgs.join(" ")}`, { status: 0, stdout }, await read(destination, cstArgs, env));
  });
  same(["for-each-ref"], ["for-each-ref"], refs);
  same(["rev-parse", "HEAD"], ["rev-parse", "HEAD"], lines);
  same(["rev-parse", "--symbolic-full-name", "HEAD"], ["rev-parse", "--symbolic-full-name", "HEAD"], (text) => text);
  same(["rev-parse", "--all"], ["rev-parse", "--all"], lines);
  // Each tree a ref names, listed whole: every tree object is also printed
  // on its own below, so listing every commit's would only repeat them.
  const tips = new Set(git(neutral, inGit(["rev-parse", "--all"]), env).stdout.toString().split("\n").filter(Boolean));
  for (const tip of tips) {
    if (rows.has(tip)) {
      same(["ls-tree", "-r", "-t", "-l", tip], ["ls-tree", "-r", "-t", "-l", rows.get(tip)], entries);
    }
  }
  await pool(jobs.splice(0), width);
  // Git's side of each object but a tree's listing, its type, size and
  // bytes, read by as few processes as hold at most `HELD` bytes each, and
  // compared before the next group is read.
  const ids = select([...rows.keys()]);
  const sizes = ids.length === 0 ? { status: 0, stdout: Buffer.alloc(0) }
    : git(neutral, inGit(["cat-file", "--batch-check=%(objectsize)"]), env, Buffer.from(`${ids.join("\n")}\n`));
  const sized = (sizes.stdout ?? "").toString().split("\n").filter(Boolean).map(Number);
  if (sizes.status !== 0 || sized.length !== ids.length || sized.some((size) => !Number.isSafeInteger(size))) {
    problems.push(`${where}: git cat-file --batch-check sized ${sized.length} of the ${ids.length} objects the alias map names: ${sizes.error ?? sizes.stderr}`);
    return problems;
  }
  for (let at = 0; at < ids.length;) {
    const group = [];
    for (let held = 0; at < ids.length && (group.length === 0 || held + sized[at] <= HELD); at++) {
      group.push(ids[at]);
      held += sized[at];
    }
    const listed = git(neutral, inGit(["cat-file", "--batch"]), env, Buffer.from(`${group.join("\n")}\n`));
    const objects = listed.status === 0 ? batch(listed.stdout) : [];
    if (objects.length !== group.length) {
      problems.push(`${where}: git cat-file --batch read ${objects.length} of ${group.length} objects the alias map names: ${listed.error ?? listed.stderr}`);
      return problems;
    }
    for (const { git: gitId, type, bytes } of objects) {
      const native = rows.get(gitId);
      known(["cat-file", "-t", gitId], ["cat-file", "-t", native], Buffer.from(`${type}\n`));
      known(["cat-file", "-s", gitId], ["cat-file", "-s", native], Buffer.from(`${bytes.length}\n`));
      if (type === "tree") {
        same(["cat-file", "-p", gitId], ["cat-file", "-p", native], entries);
      } else if (type === "blob") {
        known(["cat-file", "-p", gitId], ["cat-file", "-p", native], bytes);
      } else {
        known(["cat-file", "-p", gitId], ["cat-file", "-p", native], Buffer.from(headers(type, bytes.toString("latin1"), rows), "latin1"));
      }
    }
    await pool(jobs.splice(0), width);
  }
  return problems;
}

/** `git cat-file --batch` output: each object's ID, type and bytes. */
function batch(output) {
  const objects = [];
  let at = 0;
  while (at < output.length) {
    const end = output.indexOf(0x0a, at);
    const [git, type, size] = output.subarray(at, end).toString().split(" ");
    if (end < 0 || !/^\d+$/.test(size ?? "")) break;
    const bytes = output.subarray(end + 1, end + 1 + Number(size));
    objects.push({ git, type, bytes });
    at = end + 1 + Number(size) + 1;
  }
  return objects;
}

/**
 * `cat-file -p` of a commit or tag as a native repository prints it: Git's
 * payload with the IDs of the header lines Git's parser follows translated,
 * the first line (a commit's tree, a tag's object) and a commit's parent
 * lines straight after it (as `test/native-repository.test.js` checks).
 */
function headers(kind, text, rows) {
  let followed = true;
  return text.split("\n").map((line, index) => {
    const name = index === 0 ? (kind === "commit" ? "tree" : "object") : kind === "commit" ? "parent" : null;
    // Git reads a header's ID in either case of hex.
    const id = line.slice(`${name} `.length).toLowerCase();
    followed &&= name !== null && line.startsWith(`${name} `);
    return followed && rows.has(id) ? `${name} ${rows.get(id)}` : line;
  }).join("\n");
}
