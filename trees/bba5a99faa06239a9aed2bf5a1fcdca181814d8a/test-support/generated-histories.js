/**
 * The generated-history corpus (ADR-0044 item 1, ADR-0045 decision 13, #308):
 * Git repositories built from a seed, each in two stages, so that every N1
 * check has the cases a real history rarely holds:
 *
 * - merges, octopus merges among them;
 * - renames, mode changes, symlinks and submodule links;
 * - empty trees and empty files;
 * - signed commits and tags, non-UTF-8 encodings and extra headers;
 * - malformed objects Git accepts, one of `MALFORMED`'s kinds each;
 * - versioned large binaries, of at least the 1 MiB delta threshold
 *   (storage.md §5.1).
 *
 * A history also holds what import's walk and snapshot read: annotated tags
 * of commits, trees, blobs and tags, a notes ref, a replacement ref, a
 * symbolic ref, a detached or unborn HEAD, and SHA-256 repositories. The
 * second stage adds commits and rewrites a branch from an earlier commit, so
 * an import into the first stage's copy keeps what the new history no longer
 * reaches; it may also delete a ref, add a tag and prune what no ref reaches.
 *
 * The objects are written as loose objects and the refs as files, without
 * Git, so a seed gives the same bytes whatever Git version is installed; Git
 * runs only to pack a history or prune it. History `index` of a corpus
 * always holds case `CASES[index % CASES.length]`, so any corpus of at least
 * `CASES.length` histories holds every case; the rest is chosen from the
 * seed. This module has no `node:test` dependency.
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { PROCESS_LIMIT, bounded } from "./bounded-process.js";

/** The kinds of malformed object a history may hold, each one Git reads. */
export const MALFORMED = [
  // A tree's entries out of Git's order, and one whose entries repeat a
  // name: an entry listed twice, and a blob and a tree of one name.
  "unsorted-tree",
  "duplicate-entry",
  // Modes Git reads but no Git writes: zero-padded, overlong (wrapping in
  // 32 bits, as #307 found), and group-writable.
  "zero-padded-mode",
  "overlong-mode",
  "group-writable-mode",
  // Entry names `fsck` refuses: `.`, `..` and `.git`.
  "dot-names",
  // A commit naming its tree and parents in uppercase hex.
  "uppercase-ids",
  // A commit with no message at all, and one whose message has no final
  // line feed.
  "no-message",
  "unterminated-message",
  // Identities without a name, without the email's `<`, without a date, or
  // with a date that overflows.
  "bad-identity",
  // A tag without a tagger, as Git wrote them before 0.99.
  "no-tagger",
];

/** The cases a corpus covers: ADR-0045 decision 13's, one per malformed kind. */
export const CASES = [
  "merge",
  "octopus-merge",
  "rename",
  "mode-change",
  "symlink",
  "submodule-link",
  "empty-tree",
  "empty-file",
  "signed-commit",
  "signed-tag",
  "non-utf8-encoding",
  "extra-headers",
  ...MALFORMED.map((kind) => `malformed:${kind}`),
  "large-binary",
];

/** The large-binary threshold of storage.md §5.1. */
const LARGE = 1024 * 1024;

const BASE_TIME = 1_700_000_000;
const ZONES = ["+0000", "-0700", "+0530", "+1245", "-1100", "+0100"];
const WORDS = ["add", "fix", "the", "store", "tree", "merge", "branch", "record", "large", "file", "rename", "mode",
  "symlink", "module", "empty", "signed", "notes", "import", "walk", "chunk"];

/**
 * A stream of numbers from `seed`: SHA-256 of the seed and a counter, read
 * four bytes at a time.
 */
export function stream(seed) {
  let block = Buffer.alloc(0);
  let at = 0;
  let counter = 0;
  const next = () => {
    if (at + 4 > block.length) {
      block = crypto.createHash("sha256").update(`${seed}/${counter++}`).digest();
      at = 0;
    }
    const value = block.readUInt32BE(at);
    at += 4;
    return value;
  };
  const random = {
    /** An integer in [0, n). */
    int: (n) => next() % n,
    /** An integer in [low, high]. */
    between: (low, high) => low + (next() % (high - low + 1)),
    chance: (p) => next() / 2 ** 32 < p,
    pick: (list) => list[next() % list.length],
    /** `length` bytes, a SHA-256 block at a time. */
    bytes: (length) => {
      const parts = [];
      const label = next();
      for (let k = 0; parts.length * 32 < length; k++) {
        parts.push(crypto.createHash("sha256").update(`${seed}/${label}/${k}`).digest());
      }
      return Buffer.concat(parts).subarray(0, length);
    },
    words: (count) => Array.from({ length: count }, () => random.pick(WORDS)).join(" "),
  };
  return random;
}

/** Runs a process to its end, as a promise of its status and output. */
function run(command, args, { cwd, env }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], timeout: PROCESS_LIMIT });
    const ending = bounded(child);
    const [stdout, stderr] = [[], []];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => resolve({ status: null, stdout: "", stderr: String(error) }));
    child.on("close", (status, signal) => resolve({
      status, stdout: Buffer.concat(stdout).toString(), stderr: `${Buffer.concat(stderr)}${ending(signal)}`,
    }));
  });
}

/** Git's order of tree entries: by name, a tree's as though it ended in `/`. */
function gitOrder(a, b) {
  const key = (entry) => Buffer.concat([entry.name, Buffer.from(entry.mode === "40000" ? "/" : "")]);
  return Buffer.compare(key(a), key(b));
}

/** A bare Git repository, written object by object and ref by ref. */
class Repository {
  constructor(directory, format) {
    this.path = directory;
    this.format = format;
    this.width = format === "sha1" ? 20 : 32;
    fs.mkdirSync(path.join(directory, "objects", "info"), { recursive: true });
    fs.mkdirSync(path.join(directory, "objects", "pack"), { recursive: true });
    fs.mkdirSync(path.join(directory, "refs", "heads"), { recursive: true });
    fs.mkdirSync(path.join(directory, "refs", "tags"), { recursive: true });
    const config = format === "sha1"
      ? "[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = true\n"
      : "[core]\n\trepositoryformatversion = 1\n\tfilemode = true\n\tbare = true\n[extensions]\n\tobjectformat = sha256\n";
    fs.writeFileSync(path.join(directory, "config"), config);
    fs.writeFileSync(path.join(directory, "HEAD"), "ref: refs/heads/main\n");
  }

  /** Writes an object of `type` holding `body`, and returns its ID. */
  write(type, body) {
    const bytes = Buffer.concat([Buffer.from(`${type} ${body.length}\0`), body]);
    const id = crypto.createHash(this.format).update(bytes).digest("hex");
    const directory = path.join(this.path, "objects", id.slice(0, 2));
    const file = path.join(directory, id.slice(2));
    if (!fs.existsSync(file)) {
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(file, zlib.deflateSync(bytes));
    }
    return id;
  }

  blob(bytes) {
    return this.write("blob", Buffer.from(bytes));
  }

  /**
   * A tree of `entries`, each `{ mode, name, id }` with `name` a buffer, in
   * Git's order unless `quirk` says otherwise.
   */
  tree(entries, quirk) {
    const ordered = [...entries].sort(gitOrder);
    if (quirk === "unsorted-tree") ordered.reverse();
    if (quirk === "duplicate-entry") ordered.splice(1, 0, ordered[0]);
    const parts = ordered.map(({ mode, name, id }) => Buffer.concat([
      Buffer.from(`${mode} `), name, Buffer.from([0]), Buffer.from(id, "hex"),
    ]));
    return this.write("tree", Buffer.concat(parts));
  }

  /** Points `name` at `value`, an ID or `ref: <name>`, as a loose ref. */
  ref(name, value) {
    const file = path.join(this.path, ...name.split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${value}\n`);
  }

  deleteRef(name) {
    fs.rmSync(path.join(this.path, ...name.split("/")), { force: true });
  }
}

/** A fake signature block, of `kind`, from `random`: import never checks one. */
function signature(random, kind) {
  const lines = Array.from({ length: random.between(2, 5) }, () => random.bytes(48).toString("base64"));
  return kind === "ssh"
    ? ["-----BEGIN SSH SIGNATURE-----", ...lines, "-----END SSH SIGNATURE-----"]
    : ["-----BEGIN PGP SIGNATURE-----", "", ...lines, `=${random.bytes(3).toString("base64")}`, "-----END PGP SIGNATURE-----"];
}

/** A header whose value spans lines: each line after the first starts with a space. */
function header(name, lines) {
  return `${name} ${lines.join("\n ")}`;
}

/**
 * One generated history. `generate` writes its first stage and `advance`
 * its second; `cases` is what it holds.
 */
class History {
  constructor({ directory, seed, index, env }) {
    this.random = stream(`${seed}/${index}`);
    // Git packs and prunes as import reads: every object as stored.
    this.git = env({ GIT_NO_REPLACE_OBJECTS: "1" });
    this.index = index;
    this.cases = new Set();
    this.forced = CASES[index % CASES.length];
    const format = this.random.chance(0.25) ? "sha256" : "sha1";
    this.repo = new Repository(directory, format);
    if (format === "sha256") this.cases.add("sha256");
    this.time = BASE_TIME + this.random.int(1_000_000);
    this.names = 0;
    // Each branch's tip, and each commit's files: path → { mode, id }.
    this.branches = new Map();
    this.files = new Map();
    this.commits = [];
    this.tags = [];
    this.large = null;
  }

  name(prefix) {
    return `${prefix}${this.names++}`;
  }

  /**
   * An identity line's value. A bad identity on a `committer` line never has
   * an overflowing date: a commit-graph reads the committer's, and Git's
   * generation numbers never finish on one (2.56's `git gc` spins forever).
   * `overflow` asks for that date.
   */
  ident(role, quirk, { committer = false, overflow = false } = {}) {
    this.time += this.random.between(1, 5000);
    if (quirk === "bad-identity") {
      const overflowing = `${role} <${role}@example.com> 99999999999999999999 +0000`;
      if (overflow) return overflowing;
      const variants = [`<${role}@example.com> ${this.time} +0000`, `${role} ${role}@example.com> ${this.time} +0000`,
        `${role} <${role}@example.com>`];
      if (!committer) variants.push(overflowing);
      return this.random.pick(variants);
    }
    return `${role} Name <${role}@example.com> ${this.time} ${this.random.pick(ZONES)}`;
  }

  // ----- trees ------------------------------------------------------------

  /**
   * The tree of `files`, a map of path → { mode, id }. A path of an empty
   * directory has mode `40000` and the empty tree's ID. `quirk` shapes the
   * root tree, or the first tree with a subtree for a mode quirk.
   */
  treeOf(files, quirk) {
    const root = new Map();
    for (const [file, entry] of files) {
      const parts = file.split("/");
      let directory = root;
      for (const part of parts.slice(0, -1)) {
        if (!directory.has(part)) directory.set(part, new Map());
        directory = directory.get(part);
      }
      directory.set(parts.at(-1), entry);
    }
    let shaped = false;
    const write = (directory) => {
      const entries = [];
      for (const [name, value] of directory) {
        const entry = value instanceof Map ? { mode: "40000", id: write(value) } : value;
        entries.push({ mode: entry.mode, name: Buffer.from(name, "latin1"), id: entry.id });
      }
      let applied = null;
      if (!shaped && quirk === "zero-padded-mode" && entries.some((entry) => entry.mode === "40000")) {
        entries.find((entry) => entry.mode === "40000").mode = "040000";
        applied = quirk;
      } else if (!shaped && quirk === "overlong-mode" && entries.some((entry) => entry.mode === "100644")) {
        entries.find((entry) => entry.mode === "100644").mode = "10000000000000000000000000100644";
        applied = quirk;
      } else if (!shaped && quirk === "group-writable-mode" && entries.some((entry) => entry.mode === "100644")) {
        entries.find((entry) => entry.mode === "100644").mode = "100664";
        applied = quirk;
      }
      if (applied) shaped = true;
      return this.repo.tree(entries);
    };
    if (quirk === "unsorted-tree" || quirk === "duplicate-entry" || quirk === "dot-names") {
      // These shape the root tree itself, which must have entries to shape.
      const entries = [];
      for (const [name, value] of root) {
        const entry = value instanceof Map ? { mode: "40000", id: write(value) } : value;
        entries.push({ mode: entry.mode, name: Buffer.from(name, "latin1"), id: entry.id });
      }
      if (quirk === "dot-names") {
        const blob = this.repo.blob("dot\n");
        for (const name of [".", "..", ".git"]) entries.push({ mode: "100644", name: Buffer.from(name), id: blob });
      }
      if (quirk === "duplicate-entry") {
        // Git's order puts a tree after a blob of its name, as though it
        // ended in `/`, so the two need not be neighbours.
        const blob = this.repo.blob("alike\n");
        const tree = this.repo.tree([{ mode: "100644", name: Buffer.from("inside"), id: blob }]);
        entries.push({ mode: "100644", name: Buffer.from("alike"), id: blob }, { mode: "40000", name: Buffer.from("alike"), id: tree });
      }
      if (entries.length < 2) entries.push({ mode: "100644", name: Buffer.from("pad"), id: this.repo.blob("pad\n") });
      return { tree: this.repo.tree(entries, quirk), shaped: true };
    }
    return { tree: write(root), shaped };
  }

  // ----- edits to a commit's files ---------------------------------------

  /** One random edit to `files`, recording the case it makes. */
  edit(files) {
    const paths = [...files.keys()].filter((file) => !files.get(file).large);
    const regular = paths.filter((file) => ["100644", "100755"].includes(files.get(file).mode));
    const roll = this.random.int(100);
    if (roll < 30 && regular.length > 0) {
      const file = this.random.pick(regular);
      files.set(file, { ...files.get(file), id: this.repo.blob(`${this.random.words(this.random.between(1, 12))}\n`) });
    } else if (roll < 50 || regular.length === 0) {
      this.add(files);
    } else if (roll < 58 && paths.length > 1) {
      files.delete(this.random.pick(paths));
    } else if (roll < 68) {
      this.apply("rename", files);
    } else if (roll < 74) {
      this.apply("mode-change", files);
    } else if (roll < 80) {
      this.apply("symlink", files);
    } else if (roll < 85) {
      this.apply("submodule-link", files);
    } else if (roll < 90) {
      this.apply("empty-file", files);
    } else if (roll < 94) {
      this.apply("empty-tree", files);
    } else {
      this.apply("non-utf8-name", files);
    }
  }

  /** A new file, at the root or in a directory. */
  add(files, bytes) {
    const directory = this.random.chance(0.4) ? `${this.name("d")}/` : "";
    const nested = directory && this.random.chance(0.3) ? `${this.name("d")}/` : "";
    const file = `${directory}${nested}${this.name("f")}.txt`;
    files.set(file, { mode: "100644", id: this.repo.blob(bytes ?? `${this.random.words(this.random.between(1, 20))}\n`) });
    return file;
  }

  /** An edit that makes `kind`, recording it. */
  apply(kind, files) {
    const regular = [...files.keys()].filter((file) => ["100644", "100755"].includes(files.get(file).mode)
      && !files.get(file).large);
    if (regular.length === 0) regular.push(this.add(files));
    switch (kind) {
      case "rename": {
        const from = this.random.pick(regular);
        const to = `${this.random.chance(0.5) ? `${this.name("d")}/` : ""}${this.name("r")}.txt`;
        files.set(to, files.get(from));
        files.delete(from);
        break;
      }
      case "mode-change": {
        const file = this.random.pick(regular);
        const entry = files.get(file);
        files.set(file, { ...entry, mode: entry.mode === "100644" ? "100755" : "100644" });
        break;
      }
      case "symlink":
        files.set(this.name("l"), { mode: "120000", id: this.repo.blob(this.random.pick(regular)) });
        break;
      case "submodule-link": {
        // A gitlink names a commit of another repository, which this one
        // does not hold, or now and then one of its own.
        const own = this.commits.length > 0 && this.random.chance(0.3);
        const id = own ? this.random.pick(this.commits).id : this.random.bytes(this.repo.width).toString("hex");
        files.set(`${this.random.chance(0.5) ? `${this.name("d")}/` : ""}${this.name("m")}`, { mode: "160000", id });
        break;
      }
      case "empty-file":
        files.set(`${this.name("z")}.txt`, { mode: "100644", id: this.repo.blob("") });
        break;
      case "empty-tree":
        files.set(this.name("e"), { mode: "40000", id: this.repo.tree([]) });
        break;
      case "non-utf8-name":
        // Latin-1 and bytes no encoding gives: an é, and 0xFF.
        files.set(`${this.name("n")}-café-ÿ.txt`, { mode: "100644", id: this.repo.blob("latin-1 name\n") });
        break;
      default:
        throw new Error(`no edit makes ${kind}`);
    }
    this.cases.add(kind);
  }

  /** A new version of the history's large binary, or its first. */
  largeVersion(files) {
    if (!this.large) {
      this.large = { path: `${this.name("big")}.bin`, bytes: this.random.bytes(this.random.between(LARGE + 1024, LARGE + 600_000)) };
    } else {
      const bytes = this.large.bytes;
      const at = this.random.int(bytes.length - 8192);
      const change = this.random.pick(["overwrite", "insert", "append"]);
      this.large.bytes = change === "overwrite"
        ? Buffer.concat([bytes.subarray(0, at), this.random.bytes(4096), bytes.subarray(at + 4096)])
        : change === "insert"
          ? Buffer.concat([bytes.subarray(0, at), this.random.bytes(1024), bytes.subarray(at)])
          : Buffer.concat([bytes, this.random.bytes(65536)]);
    }
    files.set(this.large.path, { mode: "100644", id: this.repo.blob(this.large.bytes), large: true });
    this.cases.add("large-binary");
  }

  // ----- commits and tags -------------------------------------------------

  /**
   * A commit of `files` with `parents`, in a form chosen from the seed, or
   * shaped by `quirk` (a malformed kind) and `forms` (cases to make).
   */
  commit(files, parents, { quirk, forms = [] } = {}) {
    const { tree, shaped } = this.treeOf(files, MALFORMED.includes(quirk) ? quirk : undefined);
    if (shaped) this.cases.add(`malformed:${quirk}`);
    const want = (form, p) => forms.includes(form) || this.random.chance(p);
    const upper = quirk === "uppercase-ids";
    const lines = [`tree ${upper ? tree.toUpperCase() : tree}`,
      ...parents.map((parent) => `parent ${upper ? parent.toUpperCase() : parent}`)];
    if (upper) this.cases.add("malformed:uppercase-ids");
    const latin = want("non-utf8-encoding", 0.08);
    const identity = quirk === "bad-identity" ? "bad-identity" : undefined;
    if (identity) this.cases.add("malformed:bad-identity");
    const author = this.ident(latin ? "René Author" : "Author", identity, { overflow: forms.includes("date-overflow") });
    const committer = this.ident("Committer", identity && this.random.chance(0.5) ? identity : undefined, { committer: true });
    lines.push(`author ${author}`, `committer ${committer}`);
    if (latin) {
      lines.push("encoding ISO-8859-1");
      this.cases.add("non-utf8-encoding");
    }
    if (parents.length > 1 && want("extra-headers", 0.25)) {
      // A merge of a tag carries the tag in a `mergetag` header, as `git
      // merge` of a signed tag writes it. No ref reaches the tag itself.
      this.tag(parents[1], "commit", this.name("merged"), { signed: this.random.chance(0.7) });
      lines.push(header("mergetag", this.tags.at(-1).text.replace(/\n$/, "").split("\n")));
      this.cases.add("extra-headers");
      this.cases.add("mergetag");
    }
    if (want("extra-headers", 0.06)) {
      lines.push(`x-generated history ${this.index}`, header("x-multiline", ["first", "second", ""]));
      this.cases.add("extra-headers");
    }
    if (want("signed-commit", 0.12)) {
      const kind = this.random.pick(["pgp", "ssh"]);
      // A SHA-256 repository may carry a signature over each encoding.
      const name = this.repo.format === "sha256" && this.random.chance(0.5) ? "gpgsig-sha256" : "gpgsig";
      lines.push(header(name, signature(this.random, kind)));
      this.cases.add("signed-commit");
    }
    let message = `${this.random.words(this.random.between(1, 8))}\n`;
    if (this.random.chance(0.3)) message += `\n${this.random.words(this.random.between(4, 30))}\n`;
    if (latin) message = `café crème ${message}`;
    let text = `${lines.join("\n")}\n\n${message}`;
    if (quirk === "no-message") {
      text = `${lines.join("\n")}\n`;
      this.cases.add("malformed:no-message");
    } else if (quirk === "unterminated-message") {
      text = text.replace(/\n$/, "");
      this.cases.add("malformed:unterminated-message");
    }
    const id = this.repo.write("commit", Buffer.from(text, "latin1"));
    this.commits.push({ id, files: new Map(files) });
    if (parents.length > 1) this.cases.add(parents.length > 2 ? "octopus-merge" : "merge");
    return id;
  }

  /** An annotated tag of `object`, of `type`, named `name`. */
  tag(object, type, name, { quirk, signed } = {}) {
    const lines = [`object ${object}`, `type ${type}`, `tag ${name}`];
    if (quirk === "no-tagger") {
      this.cases.add("malformed:no-tagger");
    } else {
      lines.push(`tagger ${this.ident("Tagger")}`);
    }
    let text = `${lines.join("\n")}\n\n${this.random.words(this.random.between(1, 6))}\n`;
    if (signed || this.random.chance(0.2)) {
      text += `${signature(this.random, this.random.pick(["pgp", "ssh"])).join("\n")}\n`;
      this.cases.add("signed-tag");
    }
    const id = this.repo.write("tag", Buffer.from(text, "latin1"));
    this.tags.push({ id, text });
    return id;
  }

  /** A commit on `branch` of its tip's files after a few edits. */
  extend(branch, options = {}) {
    const tip = this.branches.get(branch);
    const files = new Map(tip ? this.files.get(tip) : []);
    for (let k = this.random.between(1, 3); k > 0; k--) this.edit(files);
    if (this.large && this.random.chance(0.5)) this.largeVersion(files);
    const id = this.commit(files, tip ? [tip] : [], options);
    this.files.set(id, files);
    this.branches.set(branch, id);
    return id;
  }

  /** A merge into `into` of `others`: its files, with what the others add. */
  merge(into, others, options = {}) {
    const parents = [this.branches.get(into), ...others.map((other) => this.branches.get(other))];
    const files = new Map(this.files.get(parents[0]));
    for (const parent of parents.slice(1)) {
      for (const [file, entry] of this.files.get(parent)) {
        if (!files.has(file) && !this.conflicts(files, file)) files.set(file, entry);
      }
    }
    if (this.random.chance(0.5)) this.edit(files);
    const id = this.commit(files, parents, options);
    this.files.set(id, files);
    this.branches.set(into, id);
    return id;
  }

  /** Whether `file` would sit under a file of `files`, or a file under it. */
  conflicts(files, file) {
    for (const other of files.keys()) {
      if (file.startsWith(`${other}/`) || other.startsWith(`${file}/`)) return true;
    }
    return false;
  }

  /** A new branch at a commit already made. */
  branch(from) {
    const name = this.name("b");
    this.branches.set(name, from ?? this.random.pick(this.commits).id);
    return name;
  }

  /** A branch whose one commit names the empty tree as its root. */
  emptyRoot() {
    const branch = this.name("empty");
    const id = this.commit(new Map(), []);
    this.files.set(id, new Map());
    this.branches.set(branch, id);
    this.cases.add("empty-tree");
    this.cases.add("empty-root-tree");
  }

  /** Two to four commits on main, each with a new version of the large binary. */
  largeCommits() {
    for (let k = this.random.between(2, 4); k > 0; k--) {
      const files = new Map(this.files.get(this.branches.get("main")));
      this.largeVersion(files);
      const id = this.commit(files, [this.branches.get("main")]);
      this.files.set(id, files);
      this.branches.set("main", id);
    }
  }

  /** Makes sure the history holds `kind`, with a commit or tag of its own. */
  ensure(kind) {
    if (this.cases.has(kind)) return;
    const main = "main";
    if (kind === "merge") {
      const side = this.branch(this.branches.get(main));
      this.extend(side);
      this.extend(main);
      this.merge(main, [side]);
    } else if (kind === "octopus-merge") {
      const sides = [this.branch(this.branches.get(main)), this.branch(this.branches.get(main))];
      for (const side of sides) this.extend(side);
      this.merge(main, sides);
    } else if (kind === "extra-headers") {
      const side = this.branch(this.branches.get(main));
      this.extend(side);
      this.extend(main);
      this.merge(main, [side], { forms: ["extra-headers"] });
    } else if (kind === "empty-tree") {
      this.emptyRoot();
      const files = new Map(this.files.get(this.branches.get(main)));
      this.apply(kind, files);
      const id = this.commit(files, [this.branches.get(main)]);
      this.files.set(id, files);
      this.branches.set(main, id);
    } else if (["rename", "mode-change", "symlink", "submodule-link", "empty-file"].includes(kind)) {
      const files = new Map(this.files.get(this.branches.get(main)));
      this.apply(kind, files);
      const id = this.commit(files, [this.branches.get(main)]);
      this.files.set(id, files);
      this.branches.set(main, id);
    } else if (["signed-commit", "non-utf8-encoding"].includes(kind)) {
      this.extend(main, { forms: [kind] });
    } else if (kind === "signed-tag" || kind === "malformed:no-tagger") {
      const name = this.name("t");
      const options = kind === "signed-tag" ? { signed: true } : { quirk: "no-tagger" };
      this.repo.ref(`refs/tags/${name}`, this.tag(this.branches.get(main), "commit", name, options));
    } else if (kind.startsWith("malformed:")) {
      const quirk = kind.slice("malformed:".length);
      const files = new Map(this.files.get(this.branches.get(main)));
      // A mode quirk needs a subtree or a regular file to shape.
      if (quirk === "zero-padded-mode") files.set(`${this.name("d")}/${this.name("f")}.txt`, { mode: "100644", id: this.repo.blob("in a directory\n") });
      if (quirk.endsWith("-mode")) files.set(`${this.name("f")}.txt`, { mode: "100644", id: this.repo.blob("regular\n") });
      // A quirk that shapes the tree goes on a branch of its own, so later
      // edits do not drop it from the tip.
      const branch = this.branch(this.branches.get(main));
      // The bad identity every corpus holds is the overflowing date, the one
      // a seed would otherwise draw rarely.
      const forms = quirk === "bad-identity" ? ["date-overflow"] : [];
      const id = this.commit(files, [this.branches.get(branch)], { quirk, forms });
      this.files.set(id, files);
      this.branches.set(branch, id);
    } else if (kind === "large-binary") {
      this.largeCommits();
    } else {
      throw new Error(`nothing ensures ${kind}`);
    }
    if (!this.cases.has(kind)) throw new Error(`history ${this.index}: ensuring ${kind} did not make it`);
  }

  /** Writes every branch, and the refs a history holds besides. */
  writeRefs() {
    for (const [branch, id] of this.branches) this.repo.ref(`refs/heads/${branch}`, id);
  }

  // ----- the two stages ---------------------------------------------------

  /** The first stage: a history, its tags and other refs, and its HEAD. */
  async generate() {
    const random = this.random;
    this.extend("main");
    if (random.chance(0.04)) this.largeCommits();
    if (random.chance(0.05)) this.emptyRoot();
    for (let step = random.between(2, 10); step > 0; step--) {
      const branches = [...this.branches.keys()];
      const roll = random.int(100);
      if (roll < 55) {
        this.extend(random.pick(branches));
      } else if (roll < 70) {
        this.extend(this.branch());
      } else if (roll < 85 && branches.length > 1) {
        const into = random.pick(branches);
        this.merge(into, [random.pick(branches.filter((name) => name !== into))]);
      } else if (roll < 90 && branches.length > 2) {
        const into = random.pick(branches);
        const others = branches.filter((name) => name !== into).slice(0, random.between(2, 4));
        this.merge(into, others);
      } else if (roll < 95) {
        // A second root.
        const lone = this.name("lone");
        this.extend(lone);
      } else {
        const quirk = random.pick(MALFORMED.filter((kind) => kind !== "no-tagger"));
        this.extend(this.branch(), { quirk });
      }
    }
    // A few tags: of commits, now and then of a tree, a blob or a tag.
    for (let k = random.between(0, 3); k > 0; k--) {
      const target = random.pick(this.commits);
      const roll = random.int(10);
      const name = this.name("v");
      if (roll < 4) {
        this.repo.ref(`refs/tags/${name}`, target.id);
      } else if (roll < 7) {
        this.repo.ref(`refs/tags/${name}`, this.tag(target.id, "commit", name, { quirk: random.chance(0.05) ? "no-tagger" : undefined }));
      } else if (roll < 8) {
        const { tree } = this.treeOf(target.files);
        this.repo.ref(`refs/tags/${name}`, this.tag(tree, "tree", name));
        this.cases.add("tag-of-tree");
      } else if (roll < 9 && target.files.size > 0) {
        const blob = [...target.files.values()].find((entry) => entry.mode !== "160000" && entry.mode !== "40000");
        if (blob) {
          this.repo.ref(`refs/tags/${name}`, this.tag(blob.id, "blob", name));
          this.cases.add("tag-of-blob");
        }
      } else {
        const inner = this.tag(target.id, "commit", `${name}-inner`);
        this.repo.ref(`refs/tags/${name}`, this.tag(inner, "tag", name));
        this.cases.add("tag-of-tag");
      }
    }
    this.ensure(this.forced);
    this.writeRefs();
    if (random.chance(0.15)) this.notes();
    if (random.chance(0.1) && this.commits.length > 1) {
      // Import reads without replacement, so this ref is recorded and
      // nothing it replaces is.
      const original = random.pick(this.commits).id;
      const replacement = random.pick(this.commits.filter((commit) => commit.id !== original)).id;
      this.repo.ref(`refs/replace/${original}`, replacement);
      this.cases.add("replace-ref");
    }
    if (random.chance(0.1)) {
      this.repo.ref("refs/remotes/origin/main", this.branches.get("main"));
      this.cases.add("remote-tracking-ref");
    }
    if (random.chance(0.15)) {
      this.repo.ref("refs/heads/current", "ref: refs/heads/main");
      this.cases.add("symbolic-ref");
    }
    const head = random.int(20);
    if (head === 0) {
      fs.writeFileSync(path.join(this.repo.path, "HEAD"), `${random.pick(this.commits).id}\n`);
      this.cases.add("detached-head");
    } else if (head === 1) {
      fs.writeFileSync(path.join(this.repo.path, "HEAD"), "ref: refs/heads/unborn\n");
      this.cases.add("unborn-head");
    }
    if (random.chance(0.2)) await this.pack();
  }

  /** A notes ref whose notes name some of the history's commits. */
  notes() {
    const noted = [...new Set(Array.from({ length: this.random.between(1, 4) }, () => this.random.pick(this.commits).id))];
    const entries = noted.map((id) => ({ mode: "100644", name: Buffer.from(id), id: this.repo.blob(`a note on ${id}\n`) }));
    const tree = this.repo.tree(entries);
    const commit = this.repo.write("commit", Buffer.from(
      `tree ${tree}\nauthor ${this.ident("Notes")}\ncommitter ${this.ident("Notes")}\n\nNotes added by 'git notes add'\n`));
    this.repo.ref("refs/notes/commits", commit);
    this.cases.add("notes");
  }

  /** Packs the objects and refs with Git, as a gc leaves a repository. */
  async pack() {
    for (const args of [["repack", "-adq"], ["pack-refs", "--all"]]) {
      const result = await run("git", args, { cwd: this.repo.path, env: this.git });
      if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${this.repo.path}: ${result.stderr}`);
    }
    this.cases.add("packed");
  }

  /**
   * The second stage: new commits, a branch rewritten from an earlier
   * commit, a deleted ref and a moved one, a new tag, and now and then a
   * prune of what no ref reaches.
   */
  async advance() {
    const random = this.random;
    const branches = [...this.branches.keys()];
    for (let k = random.between(1, 3); k > 0; k--) this.extend(random.pick(branches));
    // A rewrite: a branch starts again from an earlier commit, of its own
    // history or another's, so what only its old tip reached is reached no
    // more.
    const branch = random.pick(branches);
    this.branches.set(branch, random.pick(this.commits.slice(0, Math.max(1, this.commits.length - 2))).id);
    this.extend(branch);
    this.cases.add("rewrite");
    const others = [...this.branches.keys()].filter((name) => name !== "main");
    if (others.length > 0 && random.chance(0.5)) {
      const gone = random.pick(others);
      this.branches.delete(gone);
      this.repo.deleteRef(`refs/heads/${gone}`);
      await this.deletePacked(`refs/heads/${gone}`);
      this.cases.add("deleted-ref");
    }
    if (random.chance(0.5)) {
      const name = this.name("v");
      this.repo.ref(`refs/tags/${name}`, this.tag(this.branches.get("main"), "commit", name));
    }
    this.writeRefs();
    if (random.chance(0.3)) {
      for (const args of [["reflog", "expire", "--expire=now", "--all"], ["gc", "-q", "--prune=now"]]) {
        const result = await run("git", args, { cwd: this.repo.path, env: this.git });
        if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${this.repo.path}: ${result.stderr}`);
      }
      this.cases.add("pruned");
    }
  }

  /** Removes `ref` from `packed-refs`, where a pack may have put it. */
  async deletePacked(ref) {
    if (!fs.existsSync(path.join(this.repo.path, "packed-refs"))) return;
    const result = await run("git", ["update-ref", "-d", ref], { cwd: this.repo.path, env: this.git });
    if (result.status !== 0) throw new Error(`git update-ref -d ${ref} failed in ${this.repo.path}: ${result.stderr}`);
  }
}

/**
 * History `index` of the corpus `seed`, a bare repository at `directory`:
 * `generate()` writes its first stage, `advance()` its second, and `cases`
 * names what it holds. `env` makes the environment Git runs in.
 */
export function history({ directory, seed, index, env }) {
  const made = new History({ directory, seed, index, env });
  return {
    path: directory,
    get format() {
      return made.repo.format;
    },
    cases: made.cases,
    generate: () => made.generate(),
    advance: () => made.advance(),
  };
}
