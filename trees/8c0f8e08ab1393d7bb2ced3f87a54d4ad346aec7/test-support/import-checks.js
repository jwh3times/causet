/**
 * The import checks of ADR-0044 item 5, as every corpus runs them
 * (ADR-0045 decision 3, as amended on 2026-10-26): two fresh imports of one
 * history write byte-identical stores, and an incremental import holds what
 * a full import of the final history holds. The generated-history corpus
 * (`generated-history-check.js`) and the real repositories
 * (`real-repository-check.js`) both run them.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { TYPES, aliases, containers, readContainer, storeFiles } from "./native-store.js";

const sorted = (items) => [...items].sort();

/** Asserts that the stores `first` and `second` hold the same files, byte for byte. */
export function sameStores(first, second, what) {
  const written = storeFiles(first);
  const again = storeFiles(second);
  assert.deepEqual([...again.keys()], [...written.keys()], `${what} hold other files`);
  for (const [name, bytes] of written) {
    assert.ok(again.get(name).equals(bytes), `${what} differ in ${name}`);
  }
}

/**
 * A store's objects, as hex: `named`, those the history names, with each
 * one's stored form, and `chunks`, content no alias row names. That content
 * is a chunk of a larger file, a storage detail (ADR-0045, decision 4) whose
 * presence depends on the forms import chose. A store holds each object
 * once (storage.md §4.2).
 */
export function storeObjects(store, format) {
  const rows = new Set(aliases(store, format).values());
  const found = { named: new Map(), chunks: new Set() };
  for (const file of containers(store)) {
    for (const object of readContainer(file).objects) {
      const id = object.name.toString("hex");
      assert.ok(!found.named.has(id) && !found.chunks.has(id), `${store} holds ${id} twice`);
      if (object.type !== TYPES.content || rows.has(id)) found.named.set(id, object.form);
      else found.chunks.add(id);
    }
  }
  return found;
}

/** What an incremental import compares a store with later: its objects and alias rows. */
export function storeState(store, format) {
  return { objects: storeObjects(store, format), aliases: aliases(store, format) };
}

// A chunk list and a delta (objects.md §3), the forms one large version may
// take in one store and not another.
const CHUNKED = 1;
const DELTA = 2;

/**
 * Asserts that `incremental`, a store that held `before` (`storeState`) and
 * then imported the final history, holds what `full`, a fresh import of that
 * history, holds: the same ref snapshot, its own and the full import's alias
 * rows and objects, and each object it held already in the form it had.
 */
export function sameAsFull({ before, incremental, full, format }) {
  assert.ok(fs.readFileSync(path.join(incremental, ".cst", "snapshot")).equals(fs.readFileSync(path.join(full, ".cst", "snapshot"))),
    "the incremental import's ref snapshot differs from the full import's");
  const after = storeObjects(incremental, format);
  const whole = storeObjects(full, format);
  assert.deepEqual(sorted(after.named.keys()), sorted(new Set([...before.objects.named.keys(), ...whole.named.keys()])),
    "the incremental import's objects are not its own and the full import's");
  for (const [id, form] of before.objects.named) {
    assert.equal(after.named.get(id), form, `the incremental import changed the form of ${id}, which it held already`);
  }
  // Each form is what the store held when it was written (storage.md §5.1):
  // a delta needs its base present, and chunks win when the store holds
  // more of them. An incremental import's store holds other things than a
  // full import's at each version, so a large version may be a chunk list
  // in one and a delta in the other, and nothing else may differ.
  let chunkedHere = false;
  for (const [id, form] of whole.named) {
    const other = after.named.get(id);
    assert.ok(other === form || (Math.min(form, other) === CHUNKED && Math.max(form, other) === DELTA),
      `${id} is stored in form ${other} by the incremental import and ${form} by the full import`);
    if (other === CHUNKED && form === DELTA && !before.objects.named.has(id)) chunkedHere = true;
  }
  // Only a new version the incremental import chunked and the full import
  // did not brings chunks the full import lacks. Otherwise every chunk is
  // one of the two.
  if (!chunkedHere) {
    const known = new Set([...before.objects.chunks, ...whole.chunks]);
    assert.deepEqual([...after.chunks].filter((id) => !known.has(id)), [],
      "the incremental import holds chunks that neither its earlier store nor the full import holds");
  }
  const rows = aliases(incremental, format);
  const fullRows = aliases(full, format);
  assert.deepEqual(sorted(rows.keys()), sorted(new Set([...before.aliases.keys(), ...fullRows.keys()])),
    "the incremental import's alias rows are not its own and the full import's");
  for (const [gitId, id] of [...before.aliases, ...fullRows]) {
    assert.equal(rows.get(gitId), id, `the incremental import's alias for ${gitId}`);
  }
}
