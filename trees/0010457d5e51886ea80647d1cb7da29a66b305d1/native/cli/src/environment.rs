//! The user-facing environment variables, read as `src/environment.js` reads
//! them (ADR-0039 §5): `CAUSET_<name>` when present, even empty, and otherwise
//! the former `VLAB_<name>`.

use std::{env, ffi::OsString};

pub fn value_os(name: &str) -> Option<OsString> {
  env::var_os(format!("CAUSET_{name}")).or_else(|| env::var_os(format!("VLAB_{name}")))
}

/// The value as text; `Err` when the variable read is not valid Unicode.
pub fn value(name: &str) -> Result<Option<String>, OsString> {
  match value_os(name) {
    None => Ok(None),
    Some(value) => value.into_string().map(Some),
  }
}
