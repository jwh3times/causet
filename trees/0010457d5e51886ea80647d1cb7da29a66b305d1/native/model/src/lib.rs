//! The record model every ported command shares (issue #142, ADR-0037):
//! JSON as JavaScript reads and writes it, the canonical JSON profile and the
//! legacy digest serializer, logical identifiers, SHA-256, the record-family
//! and resource-bound registries with classification and validation, and the
//! error vocabulary. `src/` in the JavaScript CLI stays the authority;
//! `test/rust-model.test.js` runs both against the same inputs.
#![forbid(unsafe_code)]

pub mod canonical;
pub mod dates;
pub mod errors;
pub mod ids;
pub mod js;
pub mod json;
pub mod registry;
pub mod schemas;
pub mod sha256;
