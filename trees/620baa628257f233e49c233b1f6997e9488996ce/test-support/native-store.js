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

const HEADER = Buffer.concat([Buffer.from("CSTCNTNR"), Buffer.from([0x00, 0x01, 0, 0, 0, 0, 0, 0])]);
const INDEX_MAGIC = Buffer.from("CSTINDEX");
const NO_FRAME = 0xffffffff;

/** The type codes of objects.md §2. */
export const TYPES = { content: 1, tree: 2, preserved: 3, snapshot: 4, annotation: 5 };

const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest();

/** A native ID: SHA-256 of `cst`, the type code and the body. */
export function nativeId(type, body) {
  return sha256(Buffer.concat([Buffer.from("cst"), Buffer.from([type]), body]));
}

/** The alias file's rows, Git ID → native ID, both as hex. */
export function aliases(store, format) {
  const file = fs.readFileSync(path.join(store, ".cst", "aliases", format));
  const width = format === "sha1" ? 20 : 32;
  const count = file.readUInt32BE(12);
  const rows = new Map();
  for (let row = 0; row < count; row++) {
    const at = 16 + 1024 + row * (width + 32);
    rows.set(file.subarray(at, at + width).toString("hex"), file.subarray(at + width, at + width + 32).toString("hex"));
  }
  return rows;
}

/** The store's containers, in name order. */
export function containers(store) {
  const objects = path.join(store, ".cst", "objects");
  return fs.readdirSync(objects).filter((name) => name.endsWith(".cstc")).sort().map((name) => path.join(objects, name));
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
 * Writes a container into `objects`, named by its trailer, and returns its
 * path. Objects are sorted by name; each annotation names its subject, and
 * its position is computed.
 */
export function writeContainer(objects, container) {
  const sorted = [...container.objects].sort((a, b) => Buffer.compare(a.name, b.name));
  const frameTable = [];
  const parts = [HEADER];
  let offset = HEADER.length;
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

/** Rewrites the container holding `id` with `change` applied to its index. */
function rewrite(store, id, change) {
  const name = Buffer.from(id, "hex");
  for (const file of containers(store)) {
    const container = readContainer(file);
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

/** Removes an object's index entry, as if its content had been lost. */
export function removeEntry(store, id) {
  return rewrite(store, id, (container, at) => {
    container.objects.splice(at, 1);
  });
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
      const start = HEADER.length + container.frames.slice(0, first.frame).reduce((sum, frame) => sum + frame.bytes.length, 0);
      const bytes = fs.readFileSync(file);
      bytes[start + first.offset] ^= 0xff;
      fs.writeFileSync(file, bytes);
    }
    return file;
  }
}

/** An annotation's body (objects.md §7): its subject, type name and payload. */
export function annotation(subject, type, payload) {
  const name = Buffer.from(type);
  return Buffer.concat([Buffer.from([0x01]), Buffer.from(subject), Buffer.from([name.length]), name, payload]);
}
