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
    "graph" => {
      let graph = causet_engine::engine::history_graph(cwd)?;
      let records = crate::notes::list_note_records(cwd)?;
      let edges = crate::records::format_causal_edges(&records)?;
      Ok((
        causet_model::json::string(&format!(
          "Project history
{graph}

Causal edges
{edges}"
        )),
        0,
      ))
    }
    "receipts" => {
      let records = crate::notes::list_note_records(cwd)?;
      if json {
        return Ok((Value::Array(records), 0));
      }
      Ok((
        causet_model::json::string(&crate::records::format_receipts(&records)?),
        0,
      ))
    }
    "provenance" => Ok((crate::provenance::provenance(parsed, cwd)?, 0)),
    "spec" => {
      let file = parsed.positionals.get(1).cloned().unwrap_or_default();
      if parsed.positionals.first().map(String::as_str) == Some("show") {
        // `print(readSpecManifest(file), true)`: JSON either way.
        return Ok((crate::spec::read_spec_manifest(&file, cwd)?, 0));
      }
      let status = crate::spec::pending_spec_merge_status(cwd)?;
      if json {
        return Ok((status, 0));
      }
      Ok((
        causet_model::json::string(&crate::spec::format_spec_merge_status(&status)),
        0,
      ))
    }
    "resolve" => {
      // `positionals[0] ?? "status"`.
      if parsed.positionals.first().map(String::as_str) == Some("list") {
        let records = crate::resolve::list_resolution_records(cwd)?;
        if json {
          return Ok((Value::Array(records), 0));
        }
        return Ok((
          causet_model::json::string(&crate::resolve::format_resolution_catalog(&records)),
          0,
        ));
      }
      let status = crate::resolve::pending_resolution_status(cwd)?;
      if json {
        return Ok((status, 0));
      }
      Ok((
        causet_model::json::string(&crate::resolve::format_resolution_status(&status)?),
        0,
      ))
    }
    "audit" => {
      let result = crate::audit::audit_identity(cwd)?;
      let errors = causet_model::js::get(causet_model::js::get(Some(&result), "summary"), "errors");
      let failed = matches!(errors, Some(Value::Number(count)) if *count > 0.0);
      let output = if json {
        result
      } else {
        causet_model::json::string(&crate::audit::format_identity_audit(&result))
      };
      Ok((output, if failed { 1 } else { 0 }))
    }
    "proof-bundle" => {
      // Always JSON: the bundle exists to be handed to another tool.
      let source = parsed.positionals.first().cloned().unwrap_or_default();
      Ok((crate::proof::build_proof_bundle(&source, cwd)?, 0))
    }
    "verify-proof" => {
      let file = parsed.positionals.first().cloned().unwrap_or_default();
      let (result, ok) = crate::proof::verify_proof(
        &file,
        parsed.truthy("offline"),
        parsed.value("anchorsFrom"),
        cwd,
      )?;
      let exit = if ok { 0 } else { 1 };
      if json {
        return Ok((result, exit));
      }
      Ok((causet_model::json::string(&crate::proof::format_proof_verification(&result)), exit))
    }
    "merge-plan" => {
      let source = parsed.positionals.first().cloned().unwrap_or_default();
      let plan = crate::plan::merge_plan(&source, cwd)?;
      if json {
        return Ok((plan, 0));
      }
      Ok((causet_model::json::string(&crate::plan::format_merge_plan(&plan)), 0))
    }
    "rebase-plan" => {
      use crate::parsed::Opt;
      let values = |key: &str| match parsed.options.get(key) {
        Some(Opt::Values(values)) => values.clone(),
        Some(Opt::Value(value)) => vec![value.clone()],
        _ => Vec::new(),
      };
      let options = crate::plan::RebaseOptions {
        from: parsed.value("from").map(str::to_string),
        interactive: ["reword", "edit", "squash", "fixup"]
          .into_iter()
          .map(|action| (action, values(action)))
          .collect(),
      };
      let onto = parsed.positionals.first().cloned().unwrap_or_default();
      let plan =
        crate::plan::rebase_plan(&onto, parsed.positionals.get(1).map(String::as_str), cwd, &options)?;
      if json {
        return Ok((plan, 0));
      }
      Ok((causet_model::json::string(&crate::plan::format_rebase_plan(&plan)), 0))
    }
    "metadata" => {
      let subcommand = parsed
        .positionals
        .first()
        .map(String::as_str)
        .unwrap_or_default();
      crate::metadata::metadata(subcommand, parsed.truthy("strict"), json, cwd)
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
