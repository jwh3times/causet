#!/usr/bin/env node

import { main } from "../src/cli.js";
import { errorEnvelope, jsonErrorsRequested } from "../src/errors.js";

main(process.argv.slice(2)).catch((error) => {
  // One stream per mode (ADR-0021). A caller that asked for JSON gets the
  // failure as JSON on stdout, where it was already reading, and stderr stays
  // empty; a human keeps the prose they read today, unchanged. Exit codes are
  // identical either way: the classification lives in `code`, not in the exit
  // status, so adding the envelope breaks no existing caller.
  if (jsonErrorsRequested()) {
    console.log(JSON.stringify(errorEnvelope(error), null, 2));
  } else {
    const message = error?.message ?? String(error);
    console.error(`vlab: ${message}`);
    if (error?.details) {
      console.error(error.details);
    }
  }
  process.exitCode = error?.exitCode ?? 1;
});
