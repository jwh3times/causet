### Changed

- **The import checks hold what N2 derives from cst's records (#422, ADR-0047 decisions 4 and
  17).** `test/native-import.test.js` imports a history the Git-backed cst wrote records into, in
  sha1 and sha256. Two fresh imports write byte-identical native commits, tags, facts and fact
  logs. An import after new commits, new records and a settled dispute holds what a full import
  holds. A `cst provenance declare` on the original after a first import changes no native
  commit's ID, including that of a commit only a record reached until a branch named it. No
  import behavior changed: the import already met the contract.
- **An incremental import's local chain is compared by what is current in it (#422).** Its one
  entry names the store's own local heads (`docs/native-history/facts.md` §5.3), so it can never
  equal a full import's, as its operation cannot. The shared check in
  `test-support/import-checks.js`, which the generated-history and real-repository corpora run,
  leaves that entry out and requires the facts current in the local chain to be the full import's.
  `docs/native-history/operations.md` §4.2 now says that an incremental import differs from a full
  one in that entry and the view's local heads, as well as in its operation.
