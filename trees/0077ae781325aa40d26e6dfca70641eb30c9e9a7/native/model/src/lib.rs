//! The record model every ported command shares (issue #142, ADR-0037):
//! JSON as JavaScript reads and writes it, the canonical JSON profile and the
//! legacy digest serializer, logical identifiers, SHA-256, the record-family
//! and resource-bound registries with classification and validation, and the
//! error vocabulary. Ported from `src/` in the JavaScript CLI, it is the
//! authority since #243; `test/rust-model.test.js` holds it to the JavaScript
//! oracle's frozen answers.
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
