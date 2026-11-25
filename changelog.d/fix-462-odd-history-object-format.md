### Fixed

- **The sha256 suite mode passes again.** The `cst log` placeholder test on commits Git reads but
  no Git writes, in `test/native-log.test.js`, built its history in whatever object format
  `GIT_DEFAULT_HASH` chose but always read it as SHA-1, so `GIT_DEFAULT_HASH=sha256 npm test`
  failed there. That blocked the promotion of v0.32.0. The test now states the format and runs in
  both SHA-1 and SHA-256, so a regression shows in the default suite too. Nothing changes for `cst`
  or its packages.
