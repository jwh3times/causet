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
    "forecast" => {
      let source = parsed.positionals.first().cloned().unwrap_or_default();
      let forecast = crate::forecast::forecast_reconciliation(
        &source,
        parsed.truthy("targetCheckpoint"),
        parsed.truthy("acceptCandidates"),
        cwd,
      )?;
      if json {
        return Ok((forecast, 0));
      }
      Ok((causet_model::json::string(&crate::forecast::format_forecast(&forecast)), 0))
    }
    "reconcile" => {
      if parsed.truthy("status") {
        let status = crate::reconcile::reconciliation_status(cwd)?;
        if json {
          return Ok((status, 0));
        }
        return Ok((causet_model::json::string(&crate::reconcile::format_reconciliation_status(&status)), 0));
      }
      if parsed.truthy("continue") {
        let result = crate::reconcile::continue_reconciliation(parsed.truthy("fork"), cwd)?;
        if json {
          return Ok((result, 0));
        }
        return Ok((causet_model::json::string(&crate::reconcile::format_reconciliation_result(&result)), 0));
      }
      if parsed.truthy("abort") {
        // Always printed as JSON: the result is an object.
        return Ok((crate::reconcile::abort_reconciliation(cwd)?, 0));
      }
      let source = parsed.positionals.first().cloned().unwrap_or_default();
      let result = crate::reconcile::reconcile(
        &source,
        parsed.truthy("acceptCandidates"),
        parsed.value("useForecast").filter(|id| !id.is_empty()),
        cwd,
      )?;
      if json {
        return Ok((result, 0));
      }
      Ok((causet_model::json::string(&crate::reconcile::format_reconciliation_result(&result)), 0))
    }
    "spec" => {
      let file = parsed.positionals.get(1).cloned().unwrap_or_default();
      if parsed.positionals.first().map(String::as_str) == Some("resolve") {
        let path = parsed.positionals.get(1).map(String::as_str);
        let result = crate::spec::apply_pending_spec_merges(path, parsed.truthy("all"), cwd)?;
        if json {
          return Ok((result, 0));
        }
        return Ok((causet_model::json::string(&crate::spec::format_spec_merge_action(&result)), 0));
      }
      if parsed.positionals.first().map(String::as_str) == Some("index") {
        let force = parsed.truthy("force");
        if parsed.truthy("all") {
          let result = crate::spec::index_all_specs(force, cwd)?;
          if json {
            return Ok((result, 0));
          }
          return Ok((causet_model::json::string(&crate::spec::format_spec_batch(&result)), 0));
        }
        let result = crate::spec::index_spec(&file, force, cwd)?;
        if json {
          return Ok((result, 0));
        }
        return Ok((causet_model::json::string(&crate::spec::format_spec_result(&result, cwd)?), 0));
      }
      if parsed.positionals.first().map(String::as_str) == Some("merge-plan") {
        let at = |index: usize| parsed.positionals.get(index).cloned().unwrap_or_default();
        let plan = crate::spec::spec_merge_plan(&file, &at(2), &at(3), &at(4), cwd)?;
        if json {
          return Ok((plan, 0));
        }
        return Ok((causet_model::json::string(&crate::spec::format_spec_merge_plan(&plan)), 0));
      }
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
      let subcommand = parsed.positionals.first().map(String::as_str);
      if let Some(action @ ("apply" | "reject")) = subcommand {
        let file = parsed.positionals.get(1).map(String::as_str);
        let all = parsed.truthy("all");
        let resolution = parsed.value("resolution").filter(|id| !id.is_empty());
        let (result, verb) = if action == "apply" {
          (crate::resolve::apply_resolution(file, all, resolution, cwd)?, "applied")
        } else {
          (crate::resolve::reject_resolution(file, all, resolution, cwd)?, "rejected")
        };
        if json {
          return Ok((result, 0));
        }
        return Ok((
          causet_model::json::string(&crate::resolve::format_resolution_action(&result, verb)),
          0,
        ));
      }
      if subcommand == Some("list") {
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
    "commit" => {
      // Always printed as JSON: the result is an object.
      let actors = crate::commit::declared_actors(parsed)?;
      let message = parsed.value("message").unwrap_or_default();
      let result = crate::commit::create_commit(
        message,
        parsed.truthy("all"),
        parsed.truthy("allowEmpty"),
        &actors,
        cwd,
      )?;
      Ok((result, 0))
    }
    "branch" => {
      let name = parsed.positionals.first().cloned().unwrap_or_default();
      let report = crate::landing::branch(&name, parsed.positionals.get(1).map(String::as_str), cwd)?;
      Ok((causet_model::json::string(&report), 0))
    }
    "merge" | "compact-merge" | "hard-squash" => {
      // Always printed as JSON: the receipt is an object. `--compact` wins
      // over `--hard-squash`.
      let source = parsed.positionals.first().cloned().unwrap_or_default();
      let mode = if !parsed.truthy("compact") && (command == "hard-squash" || parsed.truthy("hardSquash")) {
        "hard-squash"
      } else {
        "compact"
      };
      Ok((crate::landing::land(&source, mode, parsed.value("message"), cwd)?, 0))
    }
    "cherry-pick" => {
      // Always printed as JSON: the result is an object.
      let value = parsed.positionals.first().cloned().unwrap_or_default();
      let result =
        crate::cherry_pick::cherry_pick(&value, parsed.truthy("fork"), parsed.truthy("repeat"), cwd)?;
      Ok((result, 0))
    }
    "workspace" => {
      // Every workspace result but a forecast is an object or a list, printed
      // as JSON.
      let positional = |index: usize| parsed.positionals.get(index).cloned().unwrap_or_default();
      match parsed.positionals.first().map(String::as_str) {
        Some("list") => Ok((crate::workspaces::list_workspaces(cwd)?, 0)),
        Some("forecast") => {
          let forecast = crate::forecast::forecast_workspaces(
            &positional(1),
            &positional(2),
            parsed.truthy("sourceCheckpoint"),
            parsed.truthy("acceptCandidates"),
            cwd,
          )?;
          if json {
            return Ok((forecast, 0));
          }
          Ok((causet_model::json::string(&crate::forecast::format_forecast(&forecast)), 0))
        }
        Some("checkpoint") => Ok((crate::workspaces::checkpoint_workspace(parsed.value("label"), cwd)?, 0)),
        Some("create") => {
          let options = crate::workspaces::CreateOptions {
            from: parsed.value("from"),
            path: parsed.value("path"),
            owner: parsed.value("owner"),
            focus: parsed.value("focus"),
            cone: parsed.value("cone"),
          };
          Ok((crate::workspaces::create_workspace(&positional(1), &options, cwd)?, 0))
        }
        Some("move") => Ok((crate::workspaces::move_workspace(&positional(1), &positional(2), cwd)?, 0)),
        Some("archive") => Ok((crate::workspaces::archive_workspace(&positional(1), cwd)?, 0)),
        Some("restore") => Ok((crate::workspaces::restore_workspace(&positional(1), parsed.value("path"), cwd)?, 0)),
        Some("repair") => Ok((
          crate::workspaces::repair_workspace(&positional(1), parsed.value("path").unwrap_or_default(), cwd)?,
          0,
        )),
        _ => Ok((
          crate::workspaces::prune_workspaces(parsed.truthy("apply"), parsed.truthy("dryRun"), cwd)?,
          0,
        )),
      }
    }
    "init" => {
      // Printed as text even under --json: `init` does not pass the flag on.
      let root = crate::store::init_lab(cwd)?;
      Ok((causet_model::json::string(&format!("Initialized causet metadata in {root}")), 0))
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
    "metadata" if parsed.positionals.first().map(String::as_str) == Some("dispose") => {
      let record_id = parsed.positionals.get(1).cloned().unwrap_or_default();
      let result = crate::dispose::dispose_conflict(
        &record_id,
        parsed.truthy("keepLocal"),
        parsed.value("reason"),
        cwd,
      )?;
      if json {
        return Ok((result, 0));
      }
      Ok((causet_model::json::string(&crate::dispose::format_disposition(&result)), 0))
    }
    "metadata" if parsed.positionals.first().map(String::as_str) == Some("import") => {
      let source = parsed.positionals.get(1).cloned().unwrap_or_default();
      let result = crate::import::import_metadata(
        &source,
        parsed.truthy("dryRun"),
        parsed.truthy("apply"),
        parsed.truthy("parkConflicts"),
        cwd,
      )?;
      let exit = if crate::import::import_failed(&result) { 1 } else { 0 };
      if json {
        return Ok((result, exit));
      }
      Ok((causet_model::json::string(&crate::import::format_import(&result, cwd)?), exit))
    }
    "metadata" if parsed.positionals.first().map(String::as_str) == Some("export") => {
      let destination = parsed.positionals.get(1).cloned().unwrap_or_default();
      let result = crate::export::export_metadata(&destination, cwd)?;
      if json {
        return Ok((result, 0));
      }
      Ok((causet_model::json::string(&crate::export::format_export(&result)), 0))
    }
    "metadata" if parsed.positionals.first().map(String::as_str) == Some("retain") => {
      let (result, failed) =
        crate::retain::retain_metadata(parsed.truthy("dryRun"), parsed.truthy("apply"), cwd)?;
      let exit = if failed { 1 } else { 0 };
      if json {
        return Ok((result, exit));
      }
      Ok((causet_model::json::string(&crate::retain::format_retention(&result)), exit))
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
