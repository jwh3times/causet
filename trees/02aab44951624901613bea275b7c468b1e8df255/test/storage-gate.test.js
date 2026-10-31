/**
 * The storage gate's verdict on one real repository
 * (`test-support/storage-gate.js`), with and without its known-gap entry.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { storageGate } from "../test-support/storage-gate.js";

const where = "the real repository r";

test("the storage gate passes a store of at most Git's bytes", () => {
  assert.deepEqual(storageGate({}, 100, 100, where), { gate: "passed", problem: null });
  assert.equal(storageGate({}, 101, 100, where).gate, "failed");
  assert.equal(storageGate({}, 101, 100, where).problem,
    "the real repository r: the store takes 101 bytes, which is not at most the 100 of git gc --aggressive");
});

test("a strict storage gate passes only a store of fewer bytes than Git's", () => {
  assert.equal(storageGate({ strictly: true }, 99, 100, where).gate, "passed");
  assert.equal(storageGate({ strictly: true }, 100, 100, where).problem,
    "the real repository r: the store takes 100 bytes, which is not fewer than the 100 of git gc --aggressive");
});

test("a known gap passes a store above Git's bytes up to its ceiling", () => {
  const repository = { knownGap: { issue: 345, ceiling: 2.05 } };
  assert.deepEqual(storageGate(repository, 205, 100, where), { gate: "known gap (#345)", problem: null });
  assert.equal(storageGate(repository, 206, 100, where).gate, "failed");
  assert.equal(storageGate(repository, 206, 100, where).problem,
    "the real repository r: the store takes 206 bytes, past the known gap's ceiling of 2.05 times the 100 of git gc --aggressive (#345)");
});

test("a known gap fails once the store meets the gate, so its entry is removed", () => {
  const repository = { knownGap: { issue: 345, ceiling: 2.05 } };
  assert.equal(storageGate(repository, 100, 100, where).problem,
    "the real repository r: the store takes 100 bytes, at most the 100 of git gc --aggressive: the known gap is closed, so remove its entry (#345)");
  assert.equal(storageGate({ ...repository, strictly: true }, 100, 100, where).gate, "known gap (#345)");
});

test("a margin entry passes a store on either side of Git's bytes up to its ceiling", () => {
  const repository = { knownGap: { issue: 345, ceiling: 1.02, margin: true } };
  assert.deepEqual(storageGate(repository, 90, 100, where), { gate: "within margin (#345)", problem: null });
  assert.equal(storageGate(repository, 102, 100, where).gate, "within margin (#345)");
  assert.equal(storageGate(repository, 103, 100, where).problem,
    "the real repository r: the store takes 103 bytes, past the margin's ceiling of 1.02 times the 100 of git gc --aggressive (#345)");
});
