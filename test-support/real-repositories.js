/**
 * The real repositories of ADR-0045 decision 13 (#309), each made in a bare
 * Git repository in two stages, so that both import checks run on it:
 *
 * - `causet`: this repository's history at the commit under test, from a
 *   full checkout of it, with the release tags. Its first stage is the
 *   history at `v0.25.0`.
 * - `git`: git/git at `v2.56.0`, fetched from GitHub. Its first stage is
 *   `v2.55.0`. Both are tags, so the history never changes.
 * - `large-files`: successive Node.js release executables, each pinned by
 *   its archive's SHA-256, and generated asset-edit histories, written with
 *   `git fast-import` and pinned by the commit they make.
 *
 * `stage(source, n, env)` brings the bare repository at `source` to stage
 * `n`, 1 or 2; `select`, when given, chooses the objects equality compares
 * one by one (`compareCopy` in `native-kind.js`); `strictly` asks for
 * strictly fewer stored bytes than Git's, not at most as many; and
 * `knownGap` lists the repository's known storage gap (`storage-gate.js`).
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { PROCESS_LIMIT } from "./bounded-process.js";
import { stream } from "./generated-histories.js";

const CHECKOUT = fileURLToPath(new URL("..", import.meta.url));

/** Git in `cwd`, which must succeed; its standard output. */
function git(cwd, args, env) {
  const result = spawnSync("git", args, { cwd, env, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.error ?? result.stderr}`);
  return result.stdout.toString().trim();
}

/** Fetches `refspecs` from `from` into the bare repository `source`, tags only as named. */
function fetchRefs(source, from, refspecs, env) {
  git(source, ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", from, ...refspecs], env);
}

// ----- causet ----------------------------------------------------------------

/**
 * This repository at the commit under test. `CAUSET_REAL_CAUSET` names
 * another checkout of it; CI's checkout must hold the whole history and the
 * tags (`fetch-depth: 0`).
 */
const causet = {
  name: "causet",
  // Near Git's bytes, on either side as the history grows: 1.1% under in
  // #343's CI, 732 bytes over locally at 08c4365.
  knownGap: { issue: 345, ceiling: 1.02, margin: true },
  stage(source, n, env) {
    const checkout = process.env.CAUSET_REAL_CAUSET || CHECKOUT;
    assert.equal(git(checkout, ["rev-parse", "--is-shallow-repository"], env), "false",
      `${checkout} is a shallow clone; the causet corpus needs its whole history (fetch-depth: 0)`);
    if (n === 1) {
      fetchRefs(source, checkout, ["+refs/tags/v0.25.0:refs/tags/v0.25.0"], env);
      git(source, ["update-ref", "refs/heads/main", "refs/tags/v0.25.0^{commit}"], env);
    } else {
      fetchRefs(source, checkout, ["+HEAD:refs/heads/main", "+refs/tags/v*:refs/tags/v*"], env);
    }
  },
};

// ----- git/git ---------------------------------------------------------------

/**
 * git/git at two release tags. Comparing every object would take a `cst`
 * process for each of three answers on each of 420,000 objects, so equality
 * compares the 512 lowest Git IDs one by one, a mix of every type, besides
 * the refs and each ref's whole tree; the reconstruction check still
 * rebuilds every object. `CAUSET_REAL_GIT_URL` names another copy of it.
 */
const gitGit = {
  name: "git",
  stage(source, n, env) {
    const url = process.env.CAUSET_REAL_GIT_URL || "https://github.com/git/git.git";
    const tag = n === 1 ? "v2.55.0" : "v2.56.0";
    fetchRefs(source, url, [`+refs/tags/${tag}:refs/tags/${tag}`], env);
    git(source, ["update-ref", "refs/heads/main", `refs/tags/${tag}^{commit}`], env);
  },
  select: (ids) => [...ids].sort().slice(0, 512),
  // 2.00 times Git's bytes in #343's CI, in trees and per-object metadata
  // (storage.md §6.1).
  knownGap: { issue: 345, ceiling: 2.05 },
};

// ----- the large-file corpus ---------------------------------------------------

/**
 * Successive Node.js releases, each with the SHA-256 of its Linux x64
 * archive from the release's `SHASUMS256.txt`. Every host commits the same
 * `bin/node` from it, whatever platform it runs on.
 */
const NODE_RELEASES = [
  ["v24.18.0", "783130984963db7ba9cbd01089eaf2c2efb055c7c1693c943174b967b3050cb8"],
  ["v24.18.1", "9f5eb6ac21845a66c493c91a253b1da32fd684e89e9b7202d4936982336be4ca"],
  ["v24.19.0", "f625d97cd707df4ff96254916fbc5ff014f09c09effe5a1e0ca8f6d41a8789d4"],
  ["v24.20.0", "855d581f8a4eb1a8117e3426de25fe02770592febcfb31369aee1ffbfee9e8ec"],
  ["v24.21.0", "6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff"],
  ["v24.22.0", "28ea0a438de9a13bd7891fd758eee6c7819ee8af5442dfd8d45bd65e56d4228c"],
];

/**
 * Where downloaded archives are kept between runs: `CAUSET_LARGE_FILE_CACHE`,
 * which CI caches, or a directory under the system's temporary directory.
 */
function cacheDirectory() {
  const directory = process.env.CAUSET_LARGE_FILE_CACHE || path.join(os.tmpdir(), "causet-large-file-cache");
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

/** The archive of `version`, downloaded once and checked against `sha256`. */
async function nodeArchive(version, sha256) {
  const name = `node-${version}-linux-x64.tar.gz`;
  const file = path.join(cacheDirectory(), name);
  const digest = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
  const cached = fs.existsSync(file) ? fs.readFileSync(file) : null;
  if (cached && digest(cached) === sha256) return cached;
  const response = await fetch(`https://nodejs.org/dist/${version}/${name}`);
  assert.ok(response.ok, `downloading ${name}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(digest(bytes), sha256, `${name} does not have the pinned SHA-256`);
  fs.writeFileSync(file, bytes);
  return bytes;
}

/** The file at `wanted` in a gzipped tar archive. */
function untar(archive, wanted) {
  const tar = zlib.gunzipSync(archive);
  for (let at = 0; at + 512 <= tar.length;) {
    const header = tar.subarray(at, at + 512);
    if (header.every((byte) => byte === 0)) break;
    const text = (from, to) => header.subarray(from, to).toString("latin1").replace(/\0.*$/s, "");
    const size = parseInt(text(124, 136).trim(), 8);
    const name = [text(345, 500), text(0, 100)].filter(Boolean).join("/");
    if (name === wanted) return tar.subarray(at + 512, at + 512 + size);
    at += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error(`the archive holds no ${wanted}`);
}

/** A fast generator of bytes from a 32-bit seed (xorshift32). */
function xorshift(seed) {
  let state = seed || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

const WIDTH = 2048;

/**
 * The generated assets, edited at each version as an artist's tools would:
 * `assets/texture.rgba`, a 16 MiB image painted over in places;
 * `assets/scene.bin`, records inserted and removed, which moves everything
 * after them; and `assets/audio.pcm`, which grows at its end.
 */
class Assets {
  constructor(seed) {
    this.random = stream(seed);
    const texture = Buffer.alloc(WIDTH * WIDTH * 4);
    this.paint(texture, 0, 0, WIDTH, WIDTH);
    this.texture = texture;
    this.scene = Buffer.concat(Array.from({ length: 96 }, () => this.records(1024)));
    this.audio = this.samples(2 * 1024 * 1024);
  }

  /** A gradient with noise over a rectangle of the texture. */
  paint(texture, left, top, width, height) {
    const next = xorshift(this.random.int(2 ** 32));
    const [r, g, b] = [this.random.int(256), this.random.int(256), this.random.int(256)];
    for (let y = top; y < top + height; y++) {
      for (let x = left; x < left + width; x++) {
        const at = (y * WIDTH + x) * 4;
        const noise = next() & 7;
        texture[at] = (r + (x >> 3) + noise) & 255;
        texture[at + 1] = (g + (y >> 3) + noise) & 255;
        texture[at + 2] = (b + ((x + y) >> 4)) & 255;
        texture[at + 3] = 255;
      }
    }
  }

  /** `count` scene records of 64 bytes: an ID, a kind, and coordinates. */
  records(count) {
    const next = xorshift(this.random.int(2 ** 32));
    const bytes = Buffer.alloc(count * 64);
    for (let record = 0; record < count; record++) {
      const at = record * 64;
      bytes.writeUInt32LE(next(), at);
      bytes.writeUInt32LE(next() % 12, at + 4);
      for (let field = 0; field < 7; field++) bytes.writeFloatLE((next() % 100000) / 100, at + 8 + field * 8);
    }
    return bytes;
  }

  /** `length` bytes of 16-bit audio: two tones and a little noise. */
  samples(length) {
    const next = xorshift(this.random.int(2 ** 32));
    const [low, high] = [this.random.between(50, 400), this.random.between(800, 4000)];
    const bytes = Buffer.alloc(length);
    for (let at = 0; at < length; at += 2) {
      const t = at / 2 / 44100;
      const value = 9000 * Math.sin(2 * Math.PI * low * t) + 3000 * Math.sin(2 * Math.PI * high * t) + (next() % 512) - 256;
      bytes.writeInt16LE(Math.round(value), at);
    }
    return bytes;
  }

  /** The next version of every asset. */
  edit() {
    for (let stroke = this.random.between(1, 4); stroke > 0; stroke--) {
      const [width, height] = [this.random.between(32, 384), this.random.between(32, 384)];
      this.paint(this.texture, this.random.int(WIDTH - width), this.random.int(WIDTH - height), width, height);
    }
    const record = () => this.random.int(this.scene.length / 64) * 64;
    for (let change = this.random.between(1, 3); change > 0; change--) {
      const at = record();
      this.scene = this.random.chance(0.5)
        ? Buffer.concat([this.scene.subarray(0, at), this.records(this.random.between(1, 400)), this.scene.subarray(at)])
        : Buffer.concat([this.scene.subarray(0, at), this.scene.subarray(Math.min(this.scene.length, at + 64 * this.random.between(1, 400)))]);
    }
    this.audio = Buffer.concat([this.audio, this.samples(512 * 1024)]);
  }
}

/** Commits per Node.js release: the release's own, then asset edits. */
const PER_RELEASE = 3;
/** The releases of the first stage. */
const FIRST_RELEASES = 3;
const BASE_TIME = 1_750_000_000;

/** What the large-file corpus's `main` is after its second stage, on every host. */
const LARGE_FILE_TIP = "cefd14e21026c543508fde3699abd5718183f061";

/**
 * Writes `bytes` to a child's standard input, waiting while its buffer is
 * full, unless the child has ended: then its status says why.
 */
async function write(child, bytes) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (!child.stdin.write(bytes)) {
    await new Promise((resolve) => {
      const done = () => {
        child.stdin.off("drain", done);
        child.off("close", done);
        resolve();
      };
      child.stdin.once("drain", done);
      child.once("close", done);
    });
  }
}

/**
 * The large-file corpus: commit k holds release floor(k / `PER_RELEASE`)'s
 * `bin/node` and version k of the assets, and each release's first commit
 * is tagged. The first stage is the commits of the first `FIRST_RELEASES`
 * releases, the second the rest.
 */
const largeFiles = {
  name: "large-files",
  // ADR-0044 item 2: on the large-file corpus, strictly fewer bytes than Git.
  strictly: true,
  async stage(source, n, env) {
    const commits = NODE_RELEASES.length * PER_RELEASE;
    const half = FIRST_RELEASES * PER_RELEASE;
    const assets = new Assets("causet-large-files");
    // The assets' versions before this stage, generated again: each depends
    // on the ones before it.
    for (let k = 1; k < (n === 1 ? 0 : half); k++) assets.edit();
    const child = spawn("git", ["fast-import", "--quiet", "--done"], { cwd: source, env, stdio: ["pipe", "ignore", "pipe"], timeout: PROCESS_LIMIT });
    const errors = [];
    child.stderr.on("data", (chunk) => errors.push(chunk));
    const ended = new Promise((resolve) => child.on("close", resolve));
    child.stdin.on("error", () => {});
    const file = async (mode, name, bytes) => {
      await write(child, `M ${mode} inline ${name}\ndata ${bytes.length}\n`);
      await write(child, bytes);
      await write(child, "\n");
    };
    for (let k = n === 1 ? 0 : half; k < (n === 1 ? half : commits); k++) {
      if (k > 0) assets.edit();
      const [version, sha256] = NODE_RELEASES[Math.floor(k / PER_RELEASE)];
      const time = BASE_TIME + k * 86_400;
      const message = k % PER_RELEASE === 0 ? `Update node to ${version}\n` : `Edit the assets (${k})\n`;
      await write(child, `commit refs/heads/main\nmark :${k + 1}\ncommitter Large Files <large@example.com> ${time} +0000\ndata ${Buffer.byteLength(message)}\n${message}`);
      if (k === half) await write(child, "from refs/heads/main^0\n");
      if (k % PER_RELEASE === 0) {
        await file("100755", "bin/node", untar(await nodeArchive(version, sha256), `node-${version}-linux-x64/bin/node`));
      }
      await file("100644", "assets/texture.rgba", assets.texture);
      await file("100644", "assets/scene.bin", assets.scene);
      await file("100644", "assets/audio.pcm", assets.audio);
      await write(child, "\n");
      if (k % PER_RELEASE === 0) {
        const note = `Node.js ${version}\n`;
        await write(child, `tag node-${version}\nfrom :${k + 1}\ntagger Large Files <large@example.com> ${time} +0000\ndata ${Buffer.byteLength(note)}\n${note}\n`);
      }
    }
    await write(child, "done\n");
    child.stdin.end();
    const status = await ended;
    assert.equal(status, 0, `git fast-import: ${Buffer.concat(errors)}`);
    git(source, ["symbolic-ref", "HEAD", "refs/heads/main"], env);
    if (n === 2) {
      assert.equal(git(source, ["rev-parse", "refs/heads/main"], env), LARGE_FILE_TIP,
        "the large-file corpus is not the one every host makes");
    }
  },
};

/** The real repositories, by name. */
export const REAL_REPOSITORIES = Object.fromEntries([causet, gitGit, largeFiles].map((each) => [each.name, each]));
