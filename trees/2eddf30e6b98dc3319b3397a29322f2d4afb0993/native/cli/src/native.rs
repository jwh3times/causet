//! Running a ported command: the part of `main` in `src/cli.js` after the
//! front end, and the error reporting of `bin/vlab.js` (ADR-0021).

use crate::parsed::Parsed;
use causet_engine::environment;
use causet_engine::errors::{GitError, GitResult};
use causet_model::json::{Value, stringify_pretty};
use std::io::Write as _;

/// `canonicalizeWorkingDirectory()`: work from the directory's canonical
/// spelling, as Git reports it, so paths related to the repository root
/// compare equal. A directory that cannot be resolved is left for the first
/// Git call to report.
fn canonical_working_directory() -> String {
  let current = std::env::current_dir().unwrap_or_default();
  if let Ok(real) = std::fs::canonicalize(&current) {
    let text = real.to_string_lossy().into_owned();
    let canonical = match text.strip_prefix(r"\\?\UNC\") {
      Some(share) => format!(r"\\{share}"),
      None => text.strip_prefix(r"\\?\").unwrap_or(&text).to_string(),
    };
    if std::path::Path::new(&canonical) != current && std::env::set_current_dir(&canonical).is_ok()
    {
      return canonical;
    }
  }
  current.to_string_lossy().into_owned()
}

/// `print(value, json)`: `JSON.stringify(value, null, 2)` for anything that
/// is not a string, and `console.log` either way.
pub fn print(value: &Value) {
  let mut stdout = std::io::stdout().lock();
  let text = match value {
    Value::String(units) => causet_model::json::lossy(units),
    other => stringify_pretty(other),
  };
  let _ = writeln!(stdout, "{text}");
}

/// The failure as `bin/vlab.js` reports it: an envelope on stdout under
/// `--json`, prose on stderr otherwise.
fn report(error: &GitError, json: bool) -> i32 {
  if json {
    let _ = writeln!(
      std::io::stdout().lock(),
      "{}",
      causet_model::errors::envelope(error.code, &error.message, &error.details, error.exit_code)
    );
  } else {
    let mut stderr = std::io::stderr().lock();
    let _ = writeln!(stderr, "cst: {}", error.message);
    if !error.details.is_empty() {
      let _ = writeln!(stderr, "{}", error.details);
    }
  }
  error.exit_code
}

fn answer(command: &str, parsed: &Parsed, cwd: &str) -> GitResult<Value> {
  match command {
    "doctor" => crate::doctor::doctor(parsed, cwd),
    other => Err(GitError::new(
      "internal-invariant",
      format!("'{other}' is listed as native but has no implementation."),
    )),
  }
}

/// Run a ported command and return its exit code.
pub fn run(command: &str, parsed: &Parsed, settings: &[(&str, String)]) -> i32 {
  for (name, value) in settings {
    environment::set(name, value);
  }
  let cwd = canonical_working_directory();
  match answer(command, parsed, &cwd) {
    Ok(value) => {
      print(&value);
      0
    }
    Err(error) => report(&error, parsed.truthy("json")),
  }
}
