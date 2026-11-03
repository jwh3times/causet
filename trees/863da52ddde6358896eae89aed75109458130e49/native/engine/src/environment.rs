//! The user-facing environment variables, read as `src/environment.js` reads
//! them (ADR-0039 §5): `CAUSET_<name>` when present, even empty, and otherwise
//! the former `VLAB_<name>`. Test hooks (`CAUSET_TEST_*`) have no legacy name.

use std::env;

/// The value of `CAUSET_<name>`, else `VLAB_<name>`; `None` when neither is
/// set. A value that is not valid Unicode reads as its lossy conversion.
pub fn value(name: &str) -> Option<String> {
  env::var_os(format!("CAUSET_{name}"))
    .or_else(|| env::var_os(format!("VLAB_{name}")))
    .map(|value| value.to_string_lossy().into_owned())
}

/// A test hook, read under its one name.
pub fn test_hook(name: &str) -> Option<String> {
  env::var_os(name)
    .map(|value| value.to_string_lossy().into_owned())
    .filter(|value| !value.is_empty())
}
