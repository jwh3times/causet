import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import "../test-support/git-environment.js";

const checker = fileURLToPath(new URL("../scripts/check-doc-links.mjs", import.meta.url));

test("documentation checks ignore fenced examples while validating rendered links", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vlab-doc-links-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "README.md");
  fs.writeFileSync(file, [
    "# Documentation", "[Self](README.md#documentation)",
    "````markdown", "[Example](missing.md)", "```",
    "[Still example](missing.md)", "````", "~~~md", "[Example](missing.md)", "~~~", "",
  ].join("\n"));
  const run = () => spawnSync(process.execPath, [checker], { cwd: root, encoding: "utf8" });
  assert.equal(run().status, 0);
  fs.appendFileSync(file, "[Broken](missing.md)\n");
  const failed = run();
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /missing.md/);
});
