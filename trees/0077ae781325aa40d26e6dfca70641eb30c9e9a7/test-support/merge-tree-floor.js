/**
 * The oldest Git the merge-tree forecast engine works on, read from the Rust
 * engine that enforces it (`native/engine/src/merge_tree.rs`), so the suites
 * and scripts share its one definition (#243).
 */
import fs from "node:fs";

const source = fs.readFileSync(new URL("../native/engine/src/merge_tree.rs", import.meta.url), "utf8");
const declared = /pub const MERGE_TREE_ENGINE_MIN_GIT: &str = "(\d+\.\d+)";/.exec(source);
if (!declared) throw new Error("native/engine/src/merge_tree.rs no longer declares MERGE_TREE_ENGINE_MIN_GIT");

export const MERGE_TREE_ENGINE_MIN_GIT = declared[1];
