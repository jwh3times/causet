import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  activeHandoff, clearHandoff, formatTimestamp, MAP_NAME, publishHandoff, resolveHandoffsDir,
} from "../scripts/handoff-map.mjs";

function withHome(run) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "vcs-lab-test-handoff-"));
  try {
    return run(home);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function handoffsFolder(root, ...segments) {
  const dir = path.join(root, ...segments);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeMap(dir, handoffs, eol = "\n") {
  const map = { FileName: MAP_NAME, Last_Updated: "01-01-2026 00:00:00", Active_Handoffs: handoffs };
  fs.writeFileSync(path.join(dir, MAP_NAME), JSON.stringify(map, null, 2).replaceAll("\n", eol) + eol);
}

const readMap = (dir) => fs.readFileSync(path.join(dir, MAP_NAME), "utf8");

test("the handoff folder is found under either Proton Drive client layout", () => {
  withHome((home) => {
    const nested = handoffsFolder(home, "Proton Drive", "account", "My files", "Documents", "Handoffs");
    writeMap(nested, {});
    assert.equal(resolveHandoffsDir({ env: {}, home }), nested);
  });
  withHome((home) => {
    const flat = handoffsFolder(home, "Proton Drive", "My Files", "Documents", "Handoffs");
    writeMap(flat, {});
    assert.equal(resolveHandoffsDir({ env: {}, home }), flat);
  });
});

test("HANDOFFS_DIR overrides discovery and must hold the map", () => {
  withHome((home) => {
    const elsewhere = handoffsFolder(home, "mnt", "handoffs");
    assert.throws(() => resolveHandoffsDir({ env: { HANDOFFS_DIR: elsewhere }, home }), /has no handoff_map\.json/);
    writeMap(elsewhere, {});
    assert.equal(resolveHandoffsDir({ env: { HANDOFFS_DIR: elsewhere }, home }), elsewhere);
    assert.throws(() => resolveHandoffsDir({ env: {}, home }), /set HANDOFFS_DIR/);
  });
});

test("publishing copies without overwriting and changes only this repository's entry", () => {
  withHome((home) => {
    const dir = handoffsFolder(home, "Handoffs");
    writeMap(dir, { GuardianTracker: "guardian.md", "vcs-lab": "vcs-lab-handoff-2026-09-15.md" }, "\r\n");
    fs.writeFileSync(path.join(dir, "vcs-lab-handoff-2026-09-15.md"), "older\n");
    const source = path.join(home, "draft.md");
    fs.writeFileSync(source, "# newer\n");
    const now = new Date(2026, 8, 15, 14, 5, 9);

    const result = publishHandoff({ dir, repo: "vcs-lab", source, now });

    assert.equal(result.active, "vcs-lab-handoff-2026-09-15-2.md");
    assert.equal(result.previous, "vcs-lab-handoff-2026-09-15.md");
    assert.equal(fs.readFileSync(path.join(dir, "vcs-lab-handoff-2026-09-15.md"), "utf8"), "older\n");
    assert.equal(fs.readFileSync(result.path, "utf8"), "# newer\n");
    const raw = readMap(dir);
    assert.ok(raw.endsWith("}\r\n") && !/[^\r]\n/.test(raw), "line endings preserved");
    assert.deepEqual(JSON.parse(raw), {
      FileName: MAP_NAME,
      Last_Updated: formatTimestamp(now),
      Active_Handoffs: { GuardianTracker: "guardian.md", "vcs-lab": "vcs-lab-handoff-2026-09-15-2.md" },
    });
    assert.equal(formatTimestamp(now), "09-15-2026 14:05:09");
    assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith(".tmp")), []);
  });
});

test("repositories match hand-written map keys and clearing consumes the handoff once", () => {
  withHome((home) => {
    const dir = handoffsFolder(home, "Handoffs");
    writeMap(dir, { GuardianTracker: "guardian.md", other: "other.md" });
    fs.writeFileSync(path.join(dir, "guardian.md"), "brief\n");

    const active = activeHandoff({ dir, repo: "guardian-tracker" });
    assert.equal(active.key, "GuardianTracker");
    assert.equal(active.exists, true);
    assert.equal(active.path, path.join(dir, "guardian.md"));

    const cleared = clearHandoff({ dir, repo: "guardian-tracker" });
    assert.deepEqual([cleared.cleared, cleared.previous], [true, "guardian.md"]);
    assert.deepEqual(JSON.parse(readMap(dir)).Active_Handoffs, { GuardianTracker: null, other: "other.md" });

    const before = readMap(dir);
    assert.equal(clearHandoff({ dir, repo: "guardian-tracker" }).cleared, false);
    assert.equal(clearHandoff({ dir, repo: "unknown" }).key, null);
    assert.equal(readMap(dir), before, "nothing to clear leaves the map untouched");
  });
});

test("a map entry that is not a bare file name is refused", () => {
  withHome((home) => {
    const dir = handoffsFolder(home, "Handoffs");
    writeMap(dir, { "vcs-lab": "../outside.md" });
    assert.throws(() => activeHandoff({ dir, repo: "vcs-lab" }), /is not a file name/);
  });
});
