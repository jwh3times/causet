# Canonical JSON profile

`vcs-lab.canonical-json/v1` is the frozen byte-exact serialization used for
every new hash or signature over structured vcs-lab data (ADR-0015 phase 0b,
issue #11 item 3). It is [RFC 8785][jcs] (the JSON Canonicalization Scheme)
restricted to a value space that every planned implementation — Node today,
Rust behind the phase 1 engine seam — serializes byte-identically without
floating-point formatting rules. `src/canonical-json.js` is the reference
implementation; [`vectors.json`](vectors.json) is the shared conformance
fixture every implementation must reproduce exactly.

[jcs]: https://www.rfc-editor.org/rfc/rfc8785

## Serialization rules

Output is UTF-8 with no insignificant whitespace.

- **Value space:** `null`, `true`, `false`, strings, arrays, plain JSON
  objects, and integers `n` with `|n| ≤ 2^53 − 1`. Nothing else. Non-integer
  numbers, negative zero, integers outside the safe range, `NaN`, infinities,
  `undefined`, and non-JSON host values (functions, symbols, BigInt, binary
  buffers, dates, maps, sets, class instances) are **refused with an error**,
  never approximated, dropped, or coerced.
- **Objects:** member names sorted by UTF-16 code units (RFC 8785 §3.2.3;
  this is JavaScript's default string comparison, so a surrogate-pair name
  such as 😀 sorts before U+FB01). Duplicate names cannot occur in the data
  model.
- **Arrays:** element order preserved.
- **Strings** (RFC 8785 §3.2.2.2, exactly ECMAScript `JSON.stringify`):
  `"` and `\` escaped with a backslash; control characters U+0008, U+0009,
  U+000A, U+000C, U+000D as `\b`, `\t`, `\n`, `\f`, `\r`; every other
  character below U+0020 as lower-case `\u00xx`; all other characters,
  including `/`, U+2028, U+2029, and non-ASCII, emitted literally as UTF-8.
- **Integers** (RFC 8785 §3.2.2.3 restricted): shortest decimal form with no
  exponent, no fraction, no leading zeros, and a leading `-` only for
  negative values. Because the value space excludes non-integers, the
  IEEE-754 shortest-round-trip formatting rules of full JCS are never needed.

## Reserved members and repository identity

Hashed (and, later, signed) records reserve two top-level member names:

- **`integrity`** — carries the record's own hash and is removed before the
  record is canonicalized for hashing.
- **`signatures`** — reserved for future detached signatures; it is removed
  together with `integrity`, so a signature covers exactly the same canonical
  bytes as the hash: the record without its `integrity` and `signatures`
  members.

Both names serialize normally when they appear as ordinary data inside other
structures; the exclusion applies only to the record being hashed.

**Repository identity** is the lineage identity object
`{algorithm, objectFormat, rootCommits}` with
`algorithm = "git-root-commits-sha256/v1"`; its derived identifier is
`lineage_` followed by the SHA-256 of the object's canonical bytes. These
fields are the reserved cross-repository identity for any future trust
decision, and the vectors pin their exact bytes.

## Encoder registry

Versioned computations over canonical or legacy serializations. "Profile"
means the frozen serialization above; changing any row is a version bump.

| Encoder | Serialization | Status |
| --- | --- | --- |
| Repository lineage ID (`git-root-commits-sha256/v1`, `src/metadata.js`) | Profile | Computed through `src/canonical-json.js` since 2026-08-30 with byte-identical results; existing lineage IDs are unchanged. |
| Envelope `integrity.manifestHash` (`src/metadata-envelope.js`) | Profile, over the manifest without its reserved `integrity` and `signatures` members | Computed through `src/canonical-json.js` since 2026-08-30 with byte-identical results; a manifest the profile cannot represent fails closed. |
| Record digest, record-equality comparison, export key (`canonicalJson` in `src/metadata.js`, used by `src/metadata-transfer.js`) | Legacy sorted-key `JSON.stringify` that also accepts the non-integer timing numbers stored in receipts, and that inherits ECMAScript property enumeration — integer-like member names are emitted first, so its output is not code-unit sorted for such names | Frozen as-is: envelopes persist these digests, so their bytes must never change. New hashes must not use it. |
| Resolution signature (`ordered-three-way-blobs/v1`, `src/schemas.js`) | Fixed insertion-order `JSON.stringify` of `{algorithm, base, ours, theirs}` | Outside the profile, versioned by its own algorithm tag; byte-stable. |
| Merge/rebase plan fingerprints (`src/forecasts.js`, `src/rebase-plan.js`) | Fixed insertion-order `JSON.stringify` of selected plan fields | Outside the profile; worktree-private staleness checks only, never exported. |
| Engine differential result digest (`src/engine.js`) | Internal sorted digest that also flattens Sets and Maps | Outside the profile; in-process comparison only, never persisted. |

## Test vectors

[`vectors.json`](vectors.json) is a `vcs-lab.canonical-json-vectors/v1`
document with three sections:

- **`vectors`** — `{name, input, canonical, sha256}`: an implementation must
  serialize `input` to exactly `canonical` and hash its UTF-8 bytes to
  `sha256`. The set covers member sorting by UTF-16 code units (including a
  surrogate-pair name), string escaping, nesting, the repository-identity
  fields, and the reserved members serialized as ordinary data.
- **`encoders`** — the repository-lineage ID computation and the envelope
  manifest-hash computation (with the `integrity`/`signatures` exclusion
  rule), each with its expected canonical payload and hash; the manifest
  vector is a structurally valid envelope manifest the shipped reader
  accepts.
- **`rejects`** — inputs an implementation must refuse. Only rejects that
  JSON can represent faithfully appear in the file; the ones it cannot
  (`NaN`, infinities, negative zero, `undefined`, non-JSON host values) are
  asserted in `test/canonical-json.test.js`.

`test/canonical-json.test.js` verifies the reference implementation against
this file on every `npm test` run. It additionally pins that the legacy
digest serializer produces identical bytes for profile-conformant data
without integer-like member names — the property the byte-identical
migration of the lineage and manifest hashes rests on — and that it diverges
on the member-sorting vector, which is why new hashes must use the profile. The
phase 1 Rust implementation must consume the same file and reproduce every
byte before it may compute any hash (ADR-0015).

`vcs-lab.canonical-json/v1` and `vcs-lab.canonical-json-vectors/v1` are
profile identifiers, not record families, so they carry no document in the
[schema catalog](../schemas/README.md).
