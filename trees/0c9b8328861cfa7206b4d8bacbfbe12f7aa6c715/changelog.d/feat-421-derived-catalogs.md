### Added

- **Native repositories keep derived catalogs of their history under `.cst/catalogs/` (#421).**
  Three indexes, derived from the objects alone, answer quickly what the objects answer slowly: a
  change ID's native commits, the current facts naming an object, and the current facts carrying a
  logical ID (ADR-0047 decision 14). Each file records a fingerprint of the objects it was derived
  from and a checksum of its own bytes. A read that finds a catalog missing, damaged, written by
  another version or derived from other objects, as after an incremental import, derives it again
  and writes it back. A catalog that can't be written is derived again by the next read. The
  catalogs are never exchanged and are no part of the store's contract: the store, import and
  `cst fsck` read none of them. `cst provenance` in a native repository now reads the facts on the
  commits it inspects through the by-object catalog instead of decoding every fact. Its answers
  are unchanged.
