//! `cst metadata retain`: the retention backfill of `src/retention.js`.

use crate::host;
use crate::metadata::portable_snapshot;
use crate::notes_write::{build_retention_commit, checked_ref_update, record_dependencies, with_notes_lock};
use causet_engine::errors::{GitError, GitResult};
use causet_engine::locations::{names, ref_family};
use causet_engine::process::{RunOptions, run_git};
use causet_engine::session::with_object_session;
use causet_engine::engine;
use causet_model::js::{get, text as js_text, truthy};
use causet_model::json::{Object, Value, string};

fn nullable(value: Option<&str>) -> Value {
  value.map_or(Value::Null, string)
}

fn retain_snapshot(apply: bool, cwd: &str) -> GitResult<Value> {
  let notes_ref = names(cwd)?.notes_ref;
  let retention_ref = ref_family("retention", cwd)?;
  let notes_tip = engine::ref_target(notes_ref, cwd)?;
  let retention_before = engine::ref_target(&retention_ref, cwd)?;
  let snapshot = portable_snapshot(cwd)?;
  let dependencies = record_dependencies(&snapshot.records, cwd, false)?;
  let marker = format!(
    "Retention-Notes: {}",
    notes_tip.as_deref().map_or("null".to_string(), str::to_string)
  );
  let already_retained = match &retention_before {
    Some(retention) => engine::commit_message(retention, cwd)?
      .split('\n')
      .any(|line| line == marker),
    None => false,
  };
  let would_change = !dependencies.is_empty() && !already_retained;
  if engine::ref_target(notes_ref, cwd)? != notes_tip
    || engine::ref_target(&retention_ref, cwd)? != retention_before
  {
    return Err(GitError::new(
      "stale-input",
      "Causal metadata changed during retention inspection; retry.",
    ));
  }
  let count = |kind: &str| {
    Value::Number(dependencies.iter().filter(|(_, known)| *known == kind).count() as f64)
  };
  let mut objects = Object::new();
  objects.set("commits", count("commit"));
  objects.set("trees", count("tree"));
  objects.set("blobs", count("blob"));
  let mut result = Object::new();
  result.set("schema", string("causet.metadata-retention/v1"));
  result.set("mode", string(if apply { "apply" } else { "preview" }));
  result.set("notesTip", nullable(notes_tip.as_deref()));
  result.set("retentionBefore", nullable(retention_before.as_deref()));
  result.set("retentionAfter", nullable(retention_before.as_deref()));
  result.set("eligibleRecords", Value::Number(snapshot.records.len() as f64));
  result.set("quarantinedRecords", snapshot.quarantined);
  result.set("objects", Value::Object(objects));
  result.set("wouldChange", Value::Bool(would_change));
  result.set("changed", Value::Bool(false));
  result.set("diagnostics", Value::Array(snapshot.diagnostics));
  if apply && would_change {
    let next = build_retention_commit(
      &dependencies,
      retention_before.as_deref(),
      cwd,
      &format!("Backfill causet object retention\n\n{marker}"),
      &[],
    )?;
    host::gate_point("retention:backfill-before-publish");
    host::fault_point("retention:before-publish");
    let zero = "0".repeat(if engine::repo_context(cwd)?.object_format == "sha256" { 64 } else { 40 });
    let lines = [
      "start".to_string(),
      format!("verify {notes_ref} {}", notes_tip.as_deref().unwrap_or(&zero)),
      checked_ref_update(&retention_ref, &next, retention_before.as_deref()),
      "prepare".to_string(),
      "commit".to_string(),
      String::new(),
    ];
    let mut options = RunOptions::new(cwd);
    options.input = Some(lines.join("\n").into_bytes());
    run_git(&["update-ref".to_string(), "--stdin".to_string()], &options)?;
    result.set("retentionAfter", string(&next));
    result.set("changed", Value::Bool(true));
  }
  Ok(Value::Object(result))
}

/// `retainMetadata({ dryRun, apply })`: the report, and whether it should
/// exit 1 (quarantined records or an error diagnostic).
pub fn retain_metadata(dry_run: bool, apply: bool, cwd: &str) -> GitResult<(Value, bool)> {
  if dry_run == apply {
    return Err(GitError::new(
      "usage-conflicting-options",
      "Choose exactly one of --dry-run or --apply for metadata retention.",
    ));
  }
  let action = || with_object_session(cwd, || retain_snapshot(apply, cwd));
  let result = if apply { with_notes_lock(cwd, action)? } else { action()? };
  let failed = truthy(get(Some(&result), "quarantinedRecords"))
    || match get(Some(&result), "diagnostics") {
      Some(Value::Array(items)) => items
        .iter()
        .any(|item| js_text(get(Some(item), "severity")) == "error"),
      _ => false,
    };
  Ok((result, failed))
}

/// `formatRetention(result)`.
pub fn format_retention(result: &Value) -> String {
  let text = |name: &str| js_text(get(Some(result), name));
  let or_none = |name: &str| match get(Some(result), name) {
    None | Some(Value::Null) => "none".to_string(),
    value => js_text(value),
  };
  let objects = |name: &str| js_text(get(get(Some(result), "objects"), name));
  let state = if truthy(get(Some(result), "changed")) {
    "updated"
  } else if truthy(get(Some(result), "wouldChange")) {
    "update available"
  } else {
    "no change"
  };
  let mut lines = vec![
    format!("Retention {}: {state}", text("mode")),
    format!("Eligible records: {}", text("eligibleRecords")),
    format!("Quarantined records: {}", text("quarantinedRecords")),
    format!(
      "Dependencies: {} commits, {} trees, {} blobs",
      objects("commits"),
      objects("trees"),
      objects("blobs")
    ),
    format!("Notes: {}", or_none("notesTip")),
    format!("Retention before: {}", or_none("retentionBefore")),
    format!("Retention after: {}", or_none("retentionAfter")),
  ];
  if let Some(Value::Array(items)) = get(Some(result), "diagnostics") {
    for item in items {
      lines.push(format!(
        "{}: {}",
        js_text(get(Some(item), "code")),
        js_text(get(Some(item), "message"))
      ));
    }
  }
  lines.join("\n")
}
