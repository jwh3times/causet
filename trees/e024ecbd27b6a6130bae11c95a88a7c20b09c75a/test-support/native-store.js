/**
 * Reads and writes a native store's files (docs/native-store/storage.md §4)
 * for the native suites. A test uses them to put a store in a state no
 * import makes: content absent by promise, an index entry removed, another
 * container holding a copy, an annotation of an unknown type. They write what
 * the contract describes and check nothing a reader checks.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

/** The format version a store is written in (README): every reader's. */
export const VERSION = 1;
const header = (version) => Buffer.concat([Buffer.from("CSTCNTNR"), Buffer.from([version, 0x01, 0, 0, 0, 0, 0, 0])]);
const HEADER_LENGTH = 16;
const INDEX_MAGIC = Buffer.from("CSTINDEX");
const NO_FRAME = 0xffffffff;

/** The type codes of objects.md §2. */
export const TYPES = { content: 1, tree: 2, preserved: 3, snapshot: 4, annotation: 5, nativeCommit: 6 };

const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest();

/** A native ID: SHA-256 of `cst`, the type code and the body. */
export function nativeId(type, body) {
  return sha256(Buffer.concat([Buffer.from("cst"), Buffer.from([type]), body]));
}

/**
 * The entries of a ref snapshot's body (objects.md §6), as hex of each name
 * to `{ kind, target }`: `direct` with the native ID's 33 bytes, or
 * `symbolic` with the target ref name's bytes.
 */
export function snapshotEntries(body) {
  let at = 1;
  const varint = () => {
    let value = 0;
    for (let shift = 0; ; shift += 7) {
      const byte = body[at++];
      value += (byte & 0x7f) * 2 ** shift;
      if (byte < 0x80) return value;
    }
  };
  const take = (length) => {
    at += length;
    return body.subarray(at - length, at);
  };
  const entries = new Map();
  for (let count = varint(); count > 0; count--) {
    const name = take(varint());
    const kind = body[at++] === 1 ? "direct" : "symbolic";
    entries.set(name.toString("hex"), { kind, target: kind === "direct" ? take(33) : take(varint()) });
  }
  if (at !== body.length) throw new Error(`a snapshot body of ${body.length} bytes ends at ${at}`);
  return entries;
}

const ALIAS_HEADER = 16;
const FANOUT = 1024;
const gitWidth = (format) => (format === "sha1" ? 20 : 32);

/**
 * The alias file's rows as stored (objects.md §9.1): Git ID → the native
 * digest's short reference, its first 8 bytes, both as hex.
 */
export function aliasRows(store, format) {
  const file = fs.readFileSync(path.join(store, ".cst", "aliases", format));
  const width = gitWidth(format);
  const count = file.readUInt32BE(12);
  const rows = new Map();
  for (let row = 0; row < count; row++) {
    const at = ALIAS_HEADER + FANOUT + row * (width + 8);
    rows.set(file.subarray(at, at + width).toString("hex"), file.subarray(at + width, at + width + 8).toString("hex"));
  }
  return rows;
}

/**
 * The alias file's rows, Git ID → native ID, both as hex: each short
 * reference resolved to the one object of the store's indexes it begins, or
 * where several do, the one present (objects.md §1.3). A row it cannot
 * resolve so is an error: the suites resolve only stores import wrote.
 */
export function aliases(store, format) {
  const candidates = new Map();
  for (const file of containers(store)) {
    for (const object of readContainer(file).objects) {
      const short = object.name.subarray(0, 8).toString("hex");
      const found = candidates.get(short) ?? new Map();
      const id = object.name.toString("hex");
      found.set(id, found.get(id) || object.state === 0);
      candidates.set(short, found);
    }
  }
  const rows = new Map();
  for (const [gitId, short] of aliasRows(store, format)) {
    const found = [...(candidates.get(short) ?? new Map())];
    const chosen = found.length === 1 ? found : found.filter(([, present]) => present);
    if (chosen.length !== 1) throw new Error(`the ${format} alias row of ${gitId} names ${short}, which ${found.length} objects begin`);
    rows.set(gitId, chosen[0][0]);
  }
  return rows;
}

/** Reads a varint (the store contract's minimal LEB128): its value and where it ends. */
function varint(bytes, at) {
  let value = 0;
  let shift = 0;
  for (;;) {
    const byte = bytes[at++];
    value += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (!(byte & 0x80)) return [value, at];
  }
}

/**
 * A native commit's fields as commits.md §3.1 encodes them, decoded here
 * independently of `cst`: its parents as native IDs in hex, its encoding and
 * message as bytes, its lifted identity as text, and the preserved commit it
 * derives from, each `null` when absent. Its tree, signatures and actors are
 * read past, not returned.
 */
export function decodeNativeCommit(body) {
  let at = 33;
  const bytesAt = () => {
    const [length, next] = varint(body, at);
    const bytes = body.subarray(next, next + length);
    at = next + length;
    return bytes;
  };
  const optionalBytes = () => (body[at++] === 1 ? bytesAt() : null);
  let count;
  [count, at] = varint(body, at);
  const parents = [];
  for (let parent = 0; parent < count; parent++, at += 33) parents.push(body.subarray(at + 1, at + 33).toString("hex"));
  for (let signature = 0; signature < 2; signature++) {
    const form = body[at++];
    if (form === 0) {
      bytesAt();
      bytesAt();
      [, at] = varint(body, at);
      at += 2;
    } else if (form === 1) {
      bytesAt();
    }
  }
  const encoding = optionalBytes();
  [count, at] = varint(body, at);
  for (let actor = 0; actor < count; actor++) {
    at += 1;
    bytesAt();
    if (body[at++] === 1) at += 1;
    optionalBytes();
  }
  const [changeId, derivedFrom, originCommit] = [optionalBytes(), optionalBytes(), optionalBytes()].map((text) => text?.toString("utf8") ?? null);
  const preserved = body[at++] === 1 ? body.subarray(at + 1, at + 33).toString("hex") : null;
  at += preserved ? 33 : 0;
  return { parents, encoding, changeId, derivedFrom, originCommit, preserved, message: body.subarray(at) };
}

/** Frame codecs (storage.md §4): stored, and zstd. */
const STORED_FRAME = 0;
const ZSTD_FRAME = 1;

/** Whether this Node reads zstd frames (22.15 and later), so the suites can decode what a store compressed. */
export const readsZstd = typeof zlib.zstdDecompressSync === "function";

/** A frame's uncompressed bytes, or `null` where this Node cannot read its codec. */
function frameBytes(frame) {
  if (frame.codec === STORED_FRAME) return frame.bytes;
  if (frame.codec === ZSTD_FRAME && readsZstd) return zlib.zstdDecompressSync(frame.bytes);
  return null;
}

/**
 * Every native commit the store holds present, by ID (hex): its fields
 * decoded (`decodeNativeCommit`) and its `body` where this Node reads its
 * frame. Where it cannot, only `preserved` is known, from where import
 * places a native commit: straight after the preserved commit it derives
 * from (storage.md §3.2), which is what `cst` looks at first too, so the
 * suites check that placement independently only where zstd is read.
 */
export function nativeCommits(store) {
  const commits = new Map();
  for (const file of containers(store)) {
    const { frames, objects } = readContainer(file);
    const endingAt = new Map(objects.map((object) => [`${object.frame}:${object.offset + object.length}`, object]));
    const read = new Map();
    for (const object of objects) {
      if (object.type !== TYPES.nativeCommit || object.state !== 0) continue;
      if (!read.has(object.frame)) read.set(object.frame, frameBytes(frames[object.frame]));
      const bytes = read.get(object.frame);
      if (bytes) {
        const body = bytes.subarray(object.offset, object.offset + object.length);
        commits.set(object.name.toString("hex"), { ...decodeNativeCommit(body), body });
        continue;
      }
      const before = object.offset > 0 ? endingAt.get(`${object.frame}:${object.offset}`)
        : endingAt.get(`${object.frame - 1}:${frames[object.frame - 1]?.uncompressed}`);
      commits.set(object.name.toString("hex"), { preserved: before?.name.toString("hex") ?? null });
    }
  }
  return commits;
}

/**
 * Git ID → the native ID a native repository names that object by, both as
 * hex: a commit's native commit where it has one (commits.md §6), and
 * otherwise its alias row's object.
 */
export function names(store, format) {
  const byPreserved = new Map([...nativeCommits(store)].map(([id, commit]) => [commit.preserved, id]));
  return new Map([...aliases(store, format)].map(([gitId, native]) => [gitId, byPreserved.get(native) ?? native]));
}

/**
 * Writes the alias file of these rows, Git ID → short reference (hex), as
 * objects.md §9.1 lays it out, replacing the store's. Rows may share a short
 * reference.
 */
export function writeAliases(store, format, rows) {
  const width = gitWidth(format);
  const sorted = [...rows].map(([gitId, short]) => [Buffer.from(gitId, "hex"), Buffer.from(short, "hex")])
    .sort((a, b) => Buffer.compare(a[0], b[0]));
  const order = sorted.map((_, row) => row)
    .sort((a, b) => Buffer.compare(sorted[a][1], sorted[b][1]) || Buffer.compare(sorted[a][0], sorted[b][0]));
  const fanout = (firsts) => {
    const table = Buffer.alloc(FANOUT);
    for (let byte = 0; byte < 256; byte++) table.writeUInt32BE(firsts.filter((first) => first <= byte).length, byte * 4);
    return table;
  };
  const head = Buffer.alloc(ALIAS_HEADER);
  Buffer.from("CSTALIAS").copy(head);
  head.set([VERSION, width === 20 ? 0x01 : 0x02, 0x01, 0x00], 8);
  head.writeUInt32BE(sorted.length, 12);
  const numbers = Buffer.alloc(order.length * 4);
  order.forEach((row, at) => numbers.writeUInt32BE(row, at * 4));
  const body = Buffer.concat([
    head, fanout(sorted.map(([gitId]) => gitId[0])), ...sorted.flat(),
    fanout(order.map((row) => sorted[row][1][0])), numbers,
  ]);
  fs.writeFileSync(path.join(store, ".cst", "aliases", format), Buffer.concat([body, sha256(body)]));
}

/** The store's containers, in name order. */
export function containers(store) {
  const objects = path.join(store, ".cst", "objects");
  return fs.readdirSync(objects).filter((name) => name.endsWith(".cstc")).sort().map((name) => path.join(objects, name));
}

/** Every file under a store's `.cst/`, by its path there, with its bytes. */
export function storeFiles(store) {
  const found = new Map();
  const visit = (directory, prefix) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const at = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(at, `${prefix}${entry.name}/`);
      else found.set(`${prefix}${entry.name}`, fs.readFileSync(at));
    }
  };
  visit(path.join(store, ".cst"), "");
  return found;
}

/** Every object the store's containers list, as hex. */
export function storeObjects(store) {
  const found = new Set();
  for (const file of containers(store)) {
    for (const object of readContainer(file).objects) found.add(object.name.toString("hex"));
  }
  return found;
}

/** A container's frames, as their stored bytes, and its index. */
export function readContainer(file) {
  const bytes = fs.readFileSync(file);
  const indexAt = Number(bytes.readBigUInt64BE(bytes.length - 72));
  const index = bytes.subarray(indexAt, bytes.length - 72);
  const [frames, objects, annotations] = [8, 12, 16].map((at) => index.readUInt32BE(at));
  const container = { frames: [], objects: [], annotations: [] };
  let at = 24;
  for (let frame = 0; frame < frames; frame++, at += 24) {
    const offset = Number(index.readBigUInt64BE(at));
    const compressed = Number(index.readBigUInt64BE(at + 8));
    container.frames.push({
      bytes: Buffer.from(bytes.subarray(offset, offset + compressed)),
      uncompressed: index.readUInt32BE(at + 16),
      codec: index[at + 20],
      kind: index[at + 21],
    });
  }
  at += 1024;
  const names = [];
  for (let object = 0; object < objects; object++, at += 32) names.push(Buffer.from(index.subarray(at, at + 32)));
  for (let object = 0; object < objects; object++, at += 16) {
    container.objects.push({
      name: names[object],
      type: index[at],
      form: index[at + 1],
      state: index[at + 2],
      frame: index.readUInt32BE(at + 4),
      offset: index.readUInt32BE(at + 8),
      length: index.readUInt32BE(at + 12),
    });
  }
  for (let annotation = 0; annotation < annotations; annotation++, at += 36) {
    container.annotations.push({ subject: Buffer.from(index.subarray(at, at + 32)), position: index.readUInt32BE(at + 32) });
  }
  return container;
}

/**
 * A delta's record (storage.md §5): `base`, the 33-byte native ID of the
 * content it is against; `size`, the length of the content it produces; and
 * `data`, its zstd frame.
 */
export function readDelta(record) {
  let at = 33;
  let size = 0;
  for (let shift = 0; ; shift += 7) {
    if (at >= record.length) throw new Error(`a delta record of ${record.length} bytes ends before its size does`);
    const byte = record[at++];
    size += (byte & 0x7f) * 2 ** shift;
    if (byte < 0x80) break;
  }
  return { base: record.subarray(0, 33), size, data: record.subarray(at) };
}

/**
 * Writes a container into `objects`, named by its trailer, and returns its
 * path. Objects are sorted by name; each annotation names its subject, and
 * its position is computed. Its header says `version`.
 */
export function writeContainer(objects, container, { version = VERSION } = {}) {
  const sorted = [...container.objects].sort((a, b) => Buffer.compare(a.name, b.name));
  const frameTable = [];
  const parts = [header(version)];
  let offset = HEADER_LENGTH;
  for (const frame of container.frames) {
    const entry = Buffer.alloc(24);
    entry.writeBigUInt64BE(BigInt(offset), 0);
    entry.writeBigUInt64BE(BigInt(frame.bytes.length), 8);
    entry.writeUInt32BE(frame.uncompressed, 16);
    entry[20] = frame.codec;
    entry[21] = frame.kind;
    frameTable.push(entry);
    parts.push(frame.bytes);
    offset += frame.bytes.length;
  }
  const counts = Buffer.alloc(16);
  const annotations = (container.annotations ?? [])
    .map(({ subject, annotation }) => ({ subject, position: sorted.findIndex((object) => object.name.equals(annotation)) }))
    .sort((a, b) => Buffer.compare(a.subject, b.subject) || a.position - b.position);
  counts.writeUInt32BE(container.frames.length, 0);
  counts.writeUInt32BE(sorted.length, 4);
  counts.writeUInt32BE(annotations.length, 8);
  const fanout = Buffer.alloc(1024);
  for (let byte = 0; byte < 256; byte++) fanout.writeUInt32BE(sorted.filter((object) => object.name[0] <= byte).length, byte * 4);
  const records = sorted.map((object) => {
    const record = Buffer.alloc(16);
    record[0] = object.type;
    record[1] = object.form;
    record[2] = object.state;
    record.writeUInt32BE(object.frame, 4);
    record.writeUInt32BE(object.offset, 8);
    record.writeUInt32BE(object.length, 12);
    return record;
  });
  const table = annotations.map(({ subject, position }) => {
    const entry = Buffer.alloc(36);
    subject.copy(entry);
    entry.writeUInt32BE(position, 32);
    return entry;
  });
  const index = Buffer.concat([INDEX_MAGIC, counts, ...frameTable, fanout, ...sorted.map((object) => object.name), ...records, ...table]);
  const indexAt = Buffer.alloc(8);
  indexAt.writeBigUInt64BE(BigInt(offset));
  const body = Buffer.concat([...parts, index, indexAt, sha256(index)]);
  const trailer = sha256(body);
  const file = path.join(objects, `${trailer.toString("hex")}.cstc`);
  fs.writeFileSync(file, Buffer.concat([body, trailer]));
  return file;
}

/**
 * A container as `writeContainer` takes it: each annotation names its
 * annotation object rather than that object's position, which a change to the
 * objects would move.
 */
function readForRewrite(file) {
  const container = readContainer(file);
  container.annotations = container.annotations.map(({ subject, position }) => ({ subject, annotation: container.objects[position].name }));
  return container;
}

/** Rewrites the container holding `id` with `change` applied to its index. */
function rewrite(store, id, change) {
  const name = Buffer.from(id, "hex");
  for (const file of containers(store)) {
    const container = readForRewrite(file);
    const at = container.objects.findIndex((object) => object.name.equals(name));
    if (at === -1) continue;
    change(container, at);
    fs.rmSync(file);
    return writeContainer(path.dirname(file), container);
  }
  throw new Error(`no container holds ${id}`);
}

/**
 * Marks an object absent by promise (1) or by policy (2), dropping its
 * location (storage.md §4.1); its bytes stay in their frame, unnamed.
 */
export function markAbsent(store, id, state) {
  return rewrite(store, id, (container, at) => {
    Object.assign(container.objects[at], { form: 0, state, frame: NO_FRAME, offset: 0, length: 0 });
  });
}

/**
 * Rewrites the frame that holds `id` alone, as a delta's stored frame does
 * (storage.md §5), with `change` applied to it: its `bytes` or its `codec`.
 * The object's location follows the frame's new length.
 */
export function changeFrame(store, id, change) {
  return rewrite(store, id, (container, at) => {
    const object = container.objects[at];
    const frame = container.frames[object.frame];
    if (object.offset !== 0 || object.length !== frame.bytes.length) throw new Error(`${id} is not alone in its frame`);
    frame.bytes = Buffer.from(frame.bytes);
    change(frame);
    frame.uncompressed = frame.bytes.length;
    object.length = frame.bytes.length;
  });
}

/** Removes an object's index entry, as if its content had been lost. */
export function removeEntry(store, id) {
  return rewrite(store, id, (container, at) => {
    container.objects.splice(at, 1);
  });
}

/**
 * Adds a container whose index lists each of `ids` (hex) as content absent
 * by promise (1) or by policy (2), with no frames. The names need not be the
 * ID of any content, so a test can make one share another object's short
 * reference (objects.md §1.3), as only a collision would.
 */
export function addAbsent(store, ids, state = 1) {
  const objects = ids.map((id) => ({ name: Buffer.from(id, "hex"), type: TYPES.content, form: 0, state, frame: NO_FRAME, offset: 0, length: 0 }));
  return writeContainer(path.join(store, ".cst", "objects"), { frames: [], objects, annotations: [] });
}

/** An ID sharing `id`'s short reference, the first 8 bytes: its last byte differs. */
export function sharingShort(id) {
  const digest = Buffer.from(id, "hex");
  digest[31] ^= 0xff;
  return digest.toString("hex");
}

/**
 * Adds a container holding these objects, each a body in one stored frame of
 * its class, and annotations of their subjects. With `after`, the container
 * is padded with an annotation until its name sorts after that container's,
 * so a reader prefers the other's copies. With `damage`, a byte of the first
 * object's bytes is flipped once the container is written, as decay would:
 * its name and footer no longer match its bytes.
 */
export function addContainer(store, objects, { after, damage } = {}) {
  const directory = path.join(store, ".cst", "objects");
  for (let pad = 0; ; pad++) {
    const all = [...objects];
    if (after) all.push({ type: TYPES.annotation, body: annotation(nativeId(objects[0].type, objects[0].body), "test-padding", Buffer.from(String(pad))) });
    const container = { frames: [], objects: [], annotations: [] };
    for (const kind of [0, 1]) {
      const members = all.filter((object) => (object.type === TYPES.content ? 1 : 0) === kind);
      if (members.length === 0) continue;
      const frame = container.frames.length;
      let offset = 0;
      for (const object of members) {
        const name = nativeId(object.type, object.body);
        container.objects.push({ name, type: object.type, form: 0, state: 0, frame, offset, length: object.body.length });
        if (object.type === TYPES.annotation) container.annotations.push({ subject: object.body.subarray(1, 33), annotation: name });
        offset += object.body.length;
      }
      const bytes = Buffer.concat(members.map((object) => object.body));
      container.frames.push({ bytes, uncompressed: bytes.length, codec: 0, kind });
    }
    const file = writeContainer(directory, container);
    if (after && path.basename(file) < path.basename(after)) {
      fs.rmSync(file);
      continue;
    }
    if (damage) {
      const first = container.objects.find((object) => object.name.equals(nativeId(objects[0].type, objects[0].body)));
      const start = HEADER_LENGTH + container.frames.slice(0, first.frame).reduce((sum, frame) => sum + frame.bytes.length, 0);
      const bytes = fs.readFileSync(file);
      bytes[start + first.offset] ^= 0xff;
      fs.writeFileSync(file, bytes);
    }
    return file;
  }
}

/**
 * Rewrites a store's version marks to say `version`: the root marker, each
 * container's header and each alias file's version byte (objects.md §9.1,
 * §10, storage.md §4), with every checksum made right again. Nothing else
 * changes, so this makes a store as an earlier or later build would label
 * it, not as one would lay it out.
 */
export function setVersion(store, version) {
  fs.writeFileSync(path.join(store, ".cst", "format"), `causet-native-store ${version}\n`);
  for (const file of containers(store)) {
    const container = readForRewrite(file);
    fs.rmSync(file);
    writeContainer(path.dirname(file), container, { version });
  }
  const directory = path.join(store, ".cst", "aliases");
  for (const name of fs.existsSync(directory) ? fs.readdirSync(directory) : []) {
    const file = path.join(directory, name);
    const body = Buffer.from(fs.readFileSync(file).subarray(0, -32));
    body[8] = version;
    fs.writeFileSync(file, Buffer.concat([body, sha256(body)]));
  }
}

/** An annotation's body (objects.md §7): its subject, type name and payload. */
export function annotation(subject, type, payload) {
  const name = Buffer.from(type);
  return Buffer.concat([Buffer.from([0x01]), Buffer.from(subject), Buffer.from([name.length]), name, payload]);
}
