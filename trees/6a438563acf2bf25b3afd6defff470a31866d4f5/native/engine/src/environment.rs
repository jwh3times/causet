//! The user-facing environment variables, read as `src/environment.js` reads
//! them (ADR-0039 §5): `CAUSET_<name>` when present, even empty, and otherwise
//! the former `VLAB_<name>`. Test hooks (`CAUSET_TEST_*`) have no legacy name.
//!
//! The JavaScript CLI turns a global flag (`--engine`, `--git-session`,
//! `--trace-git`, `--forecast-engine`) into `CAUSET_<name>` in its own
//! environment. [`set`] is that assignment for this process: it wins over both
//! names, as the assignment does, without touching the real environment.

use std::env;
use std::sync::Mutex;

/// Every user-facing variable, by the name after its prefix.
pub const ENVIRONMENT_VARIABLES: [&str; 15] = [
  "AGENT",
  "BENCHMARK_HOST",
  "CLI",
  "CLI_REPORT",
  "DELEGATE",
  "ENGINE",
  "FORECAST_ENGINE",
  "GIT_SESSION",
  "GIT_SESSION_DIAGNOSTICS",
  "GIT_SESSION_DIAGNOSTICS_FILE",
  "JS_CLI",
  "LAUNCHER",
  "RELEASE_SET",
  "REQUIRE_NATIVE",
  "TRACE",
];

static SELECTED: Mutex<Vec<(String, String)>> = Mutex::new(Vec::new());

fn selected(name: &str) -> Option<String> {
  SELECTED
    .lock()
    .unwrap_or_else(|poison| poison.into_inner())
    .iter()
    .rev()
    .find(|(selected, _)| selected == name)
    .map(|(_, value)| value.clone())
}

/// `setEnvironmentValue(name, value)`: select a value for this process.
pub fn set(name: &str, value: &str) {
  SELECTED
    .lock()
    .unwrap_or_else(|poison| poison.into_inner())
    .push((name.to_string(), value.to_string()));
}

/// The value of `CAUSET_<name>`, else `VLAB_<name>`; `None` when neither is
/// set. A value that is not valid Unicode reads as its lossy conversion.
pub fn value(name: &str) -> Option<String> {
  selected(name).or_else(|| {
    env::var_os(format!("CAUSET_{name}"))
      .or_else(|| env::var_os(format!("VLAB_{name}")))
      .map(|value| value.to_string_lossy().into_owned())
  })
}

/// `legacyVariablesInUse()`: the `VLAB_*` variables being read, because no
/// current name (set or selected) hides them.
pub fn legacy_variables_in_use() -> Vec<String> {
  ENVIRONMENT_VARIABLES
    .iter()
    .filter(|name| {
      env::var_os(format!("VLAB_{name}")).is_some()
        && env::var_os(format!("CAUSET_{name}")).is_none()
        && selected(name).is_none()
    })
    .map(|name| format!("VLAB_{name}"))
    .collect()
}

/// A test hook, read under its one name.
pub fn test_hook(name: &str) -> Option<String> {
  env::var_os(name)
    .map(|value| value.to_string_lossy().into_owned())
    .filter(|value| !value.is_empty())
}
