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
    let envelope = if !causet_model::errors::is_published_code(error.code) {
      // A JavaScript `TypeError` (no code) or a Node error (its own code)
      // rather than a `CliError`.
      let code = if error.code.is_empty() {
        Value::Null
      } else {
        causet_model::json::string(error.code)
      };
      stringify_pretty(&causet_model::json::object([
        (
          "schema",
          causet_model::json::string(causet_model::registry::ERROR_ENVELOPE_SCHEMA),
        ),
        ("code", code),
        ("message", causet_model::json::string(&error.message)),
        ("details", causet_model::json::string(&error.details)),
        ("exitCode", Value::Number(f64::from(error.exit_code))),
      ]))
    } else {
      causet_model::errors::envelope(error.code, &error.message, &error.details, error.exit_code)
    };
    let _ = writeln!(std::io::stdout().lock(), "{envelope}");
  } else {
    let mut stderr = std::io::stderr().lock();
    let _ = writeln!(stderr, "cst: {}", error.message);
    if !error.details.is_empty() {
      let _ = writeln!(stderr, "{}", error.details);
    }
  }
  error.exit_code
}

/// A command's output and exit code. A command may print and still exit 1,
/// as `capabilities --against` does for a partially compatible peer.
fn answer(command: &str, parsed: &Parsed, cwd: &str) -> GitResult<(Value, i32)> {
  let json = parsed.truthy("json");
  match command {
    "doctor" => Ok((crate::doctor::doctor(parsed, cwd)?, 0)),
    "capabilities" => {
      use crate::capabilities::*;
      use causet_model::js::{get, truthy};
      if parsed.truthy("against") {
        let report = negotiate_against(parsed.value("against").unwrap_or_default(), cwd)?;
        let compatible = truthy(get(get(Some(&report), "summary"), "fullyCompatible"));
        let output = if json {
          report
        } else {
          causet_model::json::string(&format_capability_report(&report))
        };
        return Ok((output, if compatible { 0 } else { 1 }));
      }
      let document = capability_document(cwd)?;
      let output = if json {
        document
      } else {
        causet_model::json::string(&format_capabilities(&document))
      };
      Ok((output, 0))
    }
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
    Ok((value, code)) => {
      print(&value);
      code
    }
    Err(error) => report(&error, parsed.truthy("json")),
  }
}
