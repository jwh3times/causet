"use strict";

// The main package's `preinstall` step (ADR-0038 §2): copy the platform
// package's executable over `cst.exe`, which until now is the Node launcher.
// npm links commands after `preinstall`, so it finds a file with no `#!`
// line and links `cst` straight to the executable.
//
// Nothing is downloaded or compiled. A platform with no published executable,
// or an install that left the optional package out, keeps the launcher. An
// executable that is not this release's is refused, and the install fails.

const fs = require("node:fs");
const path = require("node:path");
const { locate, verify } = require("./platform.js");

const target = path.join(__dirname, "cst.exe");
const found = locate();
if (found.missing) {
  process.stderr.write(`causet: ${found.missing}; cst will start through Node.\n`);
  process.exit(0);
}
try {
  verify(found);
} catch (error) {
  process.stderr.write(`causet: ${error.message}\n`);
  process.exit(1);
}
try {
  const temporary = `${target}.tmp-${process.pid}`;
  fs.copyFileSync(found.executable, temporary);
  fs.chmodSync(temporary, 0o755);
  fs.renameSync(temporary, target);
} catch (error) {
  // The launcher is still in place and still works.
  process.stderr.write(`causet: the executable could not be copied (${error.message}); cst will start through Node.\n`);
}
