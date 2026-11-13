//! `cst reconcile`: starting a reconciliation, reporting on one, continuing
//! one and aborting one, as `reconcile`, `reconciliationStatus`,
//! `continueReconciliation` and `abortReconciliation` of
//! `src/operations.js` do, with the journal of `src/reconcile-state.js`,
//! `forecastForPlan` of `src/forecasts.js`, `publishResolution` of
//! `src/resolutions.js`, and their renderings in `src/cli.js`.
//!
//! Both CLIs read and write the same journal
//! (`causet.reconciliation-operation/v4`), so an operation one starts the
//! other reports on, continues or aborts.

use crate::forecast::{fixed, git_activity, plan_fingerprint};
use crate::host::{fault_point, new_id};
use crate::notes::note_records;
use crate::notes_write::append_note;
use crate::records::short;
use crate::resolve::{
  capture_conflict_descriptors, capture_resolution_outcomes, materialize_resolution_candidate,
  read_journal,
};
use crate::spec::{
  assert_current_spec_decisions, capture_spec_merge_outcomes, compact_spec_merge,
  materialize_spec_merge, spec_merge_plans_for_operation, write_journal,
};
use crate::target_overlay::{
  assert_overlay_current, materialize_overlay, reduce_to_committed_head,
  restore_overlay_after_abort,
};
use causet_engine::errors::{GitError, GitResult};
use causet_engine::locations::{ref_family, runtime_directory};
use causet_engine::metrics::{self, CollectorId, Metrics, iso_now};
use causet_engine::process::{GIT_NO_RERERE, GitOutput, RunOptions, run_git};
use causet_engine::session::with_object_session;
use causet_engine::{engine, text};
use causet_model::js::{get, length, nullish, strict_equals, text as js_text, to_fixed, to_number, truthy};
use causet_model::json::{Object, Value, lossy, string};
use causet_model::schemas::assert_readable_schema;
use std::time::Instant;

const JOURNAL: &str = "reconciliation.json";

fn as_text(value: Option<&Value>) -> Option<String> {
  match value {
    Some(Value::String(units)) => Some(lossy(units)),
    _ => None,
  }
}

/// `value ?? null`.
fn or_null(value: Option<&Value>) -> Value {
  if nullish(value) {
    Value::Null
  } else {
    value.cloned().unwrap_or(Value::Null)
  }
}

/// `value ?? []`.
fn or_empty(value: Option<&Value>) -> Value {
  if nullish(value) {
    Value::Array(Vec::new())
  } else {
    value.cloned().unwrap_or(Value::Null)
  }
}

/// The items of an array, and nothing for anything else.
fn items(value: Option<&Value>) -> Vec<Value> {
  match value {
    Some(Value::Array(items)) => items.clone(),
    _ => Vec::new(),
  }
}

/// A number member, `undefined` being `NaN` as arithmetic on it is.
fn number(value: Option<&Value>) -> f64 {
  value.map_or(f64::NAN, to_number)
}

/// `value ?? fallback` of a number member.
fn number_or(value: Option<&Value>, fallback: f64) -> f64 {
  if nullish(value) { fallback } else { number(value) }
}

/// `Number(value.toFixed(2))`.
fn rounded(value: f64) -> Value {
  Value::Number(to_fixed(value, 2).parse().unwrap_or(0.0))
}

/// `target[name] = value`, where an `undefined` value leaves no member.
fn copy(target: &mut Object, name: &str, value: Option<&Value>) {
  if let Some(value) = value {
    target.set(name, value.clone());
  }
}

fn owned(args: &[&str]) -> Vec<String> {
  args.iter().map(|arg| (*arg).to_string()).collect()
}

fn git(args: &[&str], cwd: &str) -> GitResult<GitOutput> {
  run_git(&owned(args), &RunOptions::new(cwd))
}

fn git_allowing_failure(args: &[&str], cwd: &str) -> GitResult<GitOutput> {
  run_git(&owned(args), &RunOptions::new(cwd).allow_failure())
}

fn elapsed(started: Instant) -> f64 {
  started.elapsed().as_secs_f64() * 1000.0
}

// ---------------------------------------------------------------------------
// The journal
// ---------------------------------------------------------------------------

/// `readReconciliationState(cwd)`.
fn read_state(cwd: &str) -> GitResult<Option<Value>> {
  read_journal(cwd, JOURNAL, "causet.reconciliation-operation", "reconciliation")
}

/// `writeReconciliationState(state, cwd)`.
fn write_state(operation: &Object, cwd: &str) -> GitResult<()> {
  write_journal(JOURNAL, &Value::Object(operation.clone()), cwd)
}

/// `clearReconciliationState(cwd)`.
fn clear_state(cwd: &str) -> GitResult<()> {
  let git_dir = engine::repo_context(cwd)?.git_dir;
  let path = text::join(&runtime_directory(&git_dir, cwd)?, JOURNAL);
  match std::fs::remove_file(&path) {
    Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
      Err(crate::envelope::io_failure(&error, "rm", &path))
    }
    _ => Ok(()),
  }
}

/// `operation.current.<name> = value`, on the journal's own object.
fn edit_current(operation: &mut Object, change: impl FnOnce(&mut Object)) {
  let mut current = match operation.get("current") {
    Some(Value::Object(current)) => current.clone(),
    _ => Object::new(),
  };
  change(&mut current);
  operation.set("current", Value::Object(current));
}

// ---------------------------------------------------------------------------
// Forecast approval
// ---------------------------------------------------------------------------

/// `readForecast(id, cwd)`.
fn read_forecast(id: &str, cwd: &str) -> GitResult<Value> {
  let git_dir = engine::repo_context(cwd)?.git_dir;
  let directory = text::join(&runtime_directory(&git_dir, cwd)?, "forecasts");
  // `/^forecast_[a-z0-9]+$/`.
  let valid = id.strip_prefix("forecast_").is_some_and(|rest| {
    !rest.is_empty() && rest.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
  });
  if !valid {
    return Err(GitError::new("invalid-identifier", format!("Invalid forecast ID '{id}'.")));
  }
  match crate::store::read_json(&text::join(&directory, &format!("{id}.json")))? {
    Some(forecast) if truthy(Some(&forecast)) => Ok(forecast),
    _ => Err(GitError::new(
      "not-found",
      format!("Forecast '{id}' was not found in this worktree."),
    )),
  }
}

/// `forecastForPlan(id, plan, cwd)`: the forecast `id` names, refused unless
/// it still describes the reconciliation `plan` is for.
fn forecast_for_plan(id: &str, plan: &Value, cwd: &str) -> GitResult<Value> {
  let forecast = read_forecast(id, cwd)?;
  let member = |name: &str| get(Some(&forecast), name);
  // The registry decides which forecast versions this build reads (ADR-0020).
  assert_readable_schema(
    as_text(member("schema")).as_deref(),
    &format!("Forecast '{id}'"),
    Some("causet.forecast"),
    "Generate a new forecast with: cst forecast",
  )
  .map_err(|refusal| GitError::new(refusal.code, refusal.message).details(refusal.details))?;
  assert_current_spec_decisions(Some(&forecast))?;
  if !strict_equals(member("id"), Some(&string(id))) {
    return Err(GitError::new(
      "malformed-input",
      format!("Forecast '{id}' has invalid metadata."),
    ));
  }
  let fingerprint = string(&plan_fingerprint(plan));
  if !strict_equals(member("targetHead"), get(Some(plan), "targetHead"))
    || !strict_equals(member("sourceHead"), get(Some(plan), "sourceHead"))
    || !strict_equals(member("planFingerprint"), Some(&fingerprint))
  {
    return Err(
      GitError::new(
        "stale-forecast",
        format!("Forecast '{id}' no longer matches this reconciliation."),
      )
      .details("A branch head or causal record changed. Generate and review a new forecast."),
    );
  }
  if as_text(member("scope")).as_deref() == Some("source-checkpoint") {
    let comparison = member("workspaceComparison");
    let source = get(comparison, "source");
    let checkpoint = get(source, "checkpoint");
    if as_text(get(comparison, "scope")).as_deref() != Some("source-checkpoint")
      || !truthy(get(source, "id"))
      || !strict_equals(get(checkpoint, "id"), member("sourceHead"))
      || !truthy(get(checkpoint, "baseHead"))
    {
      return Err(GitError::new(
        "malformed-input",
        format!("Forecast '{id}' has invalid checkpoint metadata."),
      ));
    }
    let workspaces = items(Some(&crate::workspaces::list_workspaces(cwd)?));
    let Some(workspace) = workspaces
      .iter()
      .find(|workspace| strict_equals(get(Some(workspace), "id"), get(source, "id")))
    else {
      return Err(GitError::new(
        "stale-forecast",
        format!("Forecast '{id}' no longer matches its source workspace."),
      ));
    };
    let branch = format!("refs/heads/{}", js_text(get(Some(workspace), "compatibilityBranch")));
    let Ok(head) = engine::resolve_revision(&branch, cwd) else {
      return Err(GitError::new(
        "stale-forecast",
        format!("Forecast '{id}' no longer matches its source workspace branch."),
      ));
    };
    let head = string(&head);
    if !strict_equals(Some(&head), get(source, "head"))
      || !strict_equals(Some(&head), get(checkpoint, "baseHead"))
    {
      return Err(
        GitError::new(
          "stale-forecast",
          format!("Forecast '{id}' no longer matches its source workspace head."),
        )
        .details(
          "The source branch moved after its checkpoint was reviewed. Capture a new checkpoint and forecast.",
        ),
      );
    }
  }
  Ok(forecast)
}

fn stale_batch(message: String) -> GitError {
  GitError::new("stale-forecast", message)
    .details("Abort and generate a new forecast before batch application.")
}

/// `forecastSpecMergeChoices(operation, change, cwd)`: the clean spec merge
/// plans the forecast approved for this change, each still exactly as approved.
fn forecast_spec_merge_choices(operation: &Object, change: &Value, cwd: &str) -> GitResult<Vec<Value>> {
  let approval = operation.get("forecastApproval");
  if !truthy(approval) {
    return Ok(Vec::new());
  }
  let approvals: Vec<Value> = items(get(approval, "approvedSpecMerges"))
    .into_iter()
    .filter(|item| strict_equals(get(Some(item), "sourceCommit"), get(Some(change), "commit")))
    .collect();
  if approvals.is_empty() {
    return Ok(Vec::new());
  }
  let forecast_id = js_text(operation.get("forecastId"));
  let journal = Value::Object(operation.clone());
  let plans: Vec<Value> = spec_merge_plans_for_operation(Some(&journal), cwd)?
    .into_iter()
    .filter(|plan| as_text(get(Some(plan), "status")).as_deref() == Some("clean"))
    .collect();
  if plans.len() != approvals.len() {
    return Err(stale_batch(format!(
      "Forecast '{forecast_id}' no longer matches the semantic spec conflicts."
    )));
  }
  let mut choices = Vec::new();
  for approval in &approvals {
    let field = |name: &str| get(Some(approval), name);
    let plan = plans.iter().find(|plan| {
      let result = get(Some(plan), "result");
      strict_equals(get(Some(plan), "file"), field("path"))
        && strict_equals(get(Some(plan), "signature"), field("signature"))
        && strict_equals(get(result, "markdownHash"), field("resultMarkdownHash"))
        && strict_equals(get(result, "manifestHash"), field("resultManifestHash"))
    });
    match plan {
      Some(plan) => choices.push(plan.clone()),
      None => {
        return Err(stale_batch(format!(
          "Forecast '{forecast_id}' no longer matches '{}'.",
          js_text(field("path"))
        )));
      }
    }
  }
  Ok(choices)
}

/// `forecastResolutionChoices(operation, change, conflicts)`: for each of the
/// current conflicts (named by its index in the journal), the candidate the
/// forecast approved. `None` when the forecast approved nothing for the change.
fn forecast_resolution_choices(
  operation: &Object,
  change: &Value,
  conflicts: &[(usize, Value)],
) -> GitResult<Option<Vec<(usize, Value)>>> {
  let approval = operation.get("forecastApproval");
  if !truthy(approval) {
    return Ok(None);
  }
  let approvals: Vec<Value> = items(get(approval, "approvedResolutions"))
    .into_iter()
    .filter(|item| strict_equals(get(Some(item), "sourceCommit"), get(Some(change), "commit")))
    .collect();
  if approvals.is_empty() {
    return Ok(None);
  }
  let forecast_id = js_text(operation.get("forecastId"));
  if approvals.len() != conflicts.len() {
    return Err(stale_batch(format!(
      "Forecast '{forecast_id}' no longer matches the current conflicts."
    )));
  }
  let mut choices = Vec::new();
  for (index, conflict) in conflicts {
    let field = |name: &str| get(Some(conflict), name);
    let approved = approvals.iter().find(|item| {
      strict_equals(get(Some(item), "path"), field("path"))
        && strict_equals(get(Some(item), "signature"), field("signature"))
    });
    let candidate = approved.and_then(|approved| {
      items(field("candidates")).into_iter().find(|item| {
        strict_equals(get(Some(item), "id"), get(Some(approved), "resolutionId"))
          && strict_equals(get(Some(item), "resultBlob"), get(Some(approved), "resultBlob"))
      })
    });
    match candidate {
      Some(candidate) => choices.push((*index, candidate)),
      None => {
        return Err(stale_batch(format!(
          "Forecast '{forecast_id}' no longer matches '{}'.",
          js_text(field("path"))
        )));
      }
    }
  }
  Ok(Some(choices))
}

/// `applyForecastResolutions(operation, change, cwd)`: the paused step settled
/// with exactly what the forecast approved, and committed. `false` when the
/// forecast approved nothing that settles it.
fn apply_forecast_resolutions(operation: &mut Object, change: &Value, cwd: &str) -> GitResult<bool> {
  let spec_choices = forecast_spec_merge_choices(operation, change, cwd)?;
  let semantically_resolved: Vec<Value> = spec_choices
    .iter()
    .flat_map(|plan| items(get(Some(&compact_spec_merge(plan, Value::Null)), "resolvedPaths")))
    .collect();
  let exact: Vec<(usize, Value)> = items(get(operation.get("current"), "conflicts"))
    .into_iter()
    .enumerate()
    .filter(|(_, conflict)| {
      let path = get(Some(conflict), "path");
      !semantically_resolved.iter().any(|resolved| strict_equals(Some(resolved), path))
    })
    .collect();
  let choices = forecast_resolution_choices(operation, change, &exact)?;
  if choices.is_none() && (spec_choices.is_empty() || !exact.is_empty()) {
    return Ok(false);
  }

  let mut semantic_merges = Vec::new();
  for plan in &spec_choices {
    materialize_spec_merge(plan, cwd)?;
    semantic_merges.push(compact_spec_merge(plan, string("forecast-batch")));
  }
  let captured = capture_spec_merge_outcomes(&semantic_merges, cwd)?;
  let changed = captured
    .iter()
    .any(|merge| as_text(get(Some(merge), "decision")).as_deref() != Some("accepted"));
  edit_current(operation, |current| current.set("semanticMerges", Value::Array(captured)));
  if changed {
    return Err(GitError::new(
      "stale-input",
      "A forecasted semantic spec result changed while staging.",
    ));
  }
  for (index, candidate) in choices.unwrap_or_default() {
    let mut conflicts = items(get(operation.get("current"), "conflicts"));
    materialize_resolution_candidate(conflicts.get(index), Some(&candidate), cwd)?;
    if let Some(Value::Object(conflict)) = conflicts.get_mut(index) {
      copy(conflict, "selectedResolutionId", get(Some(&candidate), "id"));
      conflict.set("decisionOverride", Value::Null);
      conflict.set("selectionMethod", string("forecast-batch"));
      conflict.set("suggestionAppliedAt", string(&iso_now()));
    }
    edit_current(operation, |current| current.set("conflicts", Value::Array(conflicts)));
  }
  let conflicts = items(get(operation.get("current"), "conflicts"));
  let decided: Vec<Value> = exact
    .iter()
    .filter_map(|(index, _)| conflicts.get(*index).cloned())
    .collect();
  let outcomes = capture_resolution_outcomes(&decided, cwd)?;
  edit_current(operation, |current| current.set("resolutionOutcomes", Value::Array(outcomes)));
  write_state(operation, cwd)?;
  let mut finish = GIT_NO_RERERE.to_vec();
  finish.extend(["-c", "core.editor=true", "cherry-pick", "--continue"]);
  let continued = git_allowing_failure(&finish, cwd)?;
  if !continued.ok {
    return Err(
      GitError::new("conflict-blocked", "Git could not apply the forecasted resolutions.")
        .details(continued.output),
    );
  }
  record_successful_application(operation, "contextual-application", cwd)?;
  Ok(true)
}

// ---------------------------------------------------------------------------
// Applying the queue
// ---------------------------------------------------------------------------

/// `applicationRecord(...)` and `recordSuccessfulApplication(operation,
/// relation, cwd)`: the step HEAD now holds, recorded on the journal, which
/// then moves on to the next change.
fn record_successful_application(operation: &mut Object, relation: &str, cwd: &str) -> GitResult<()> {
  let next = number(operation.get("nextIndex"));
  let queue = items(operation.get("queue"));
  let change = queue.get(next as usize).cloned().unwrap_or(Value::Null);
  let commit = js_text(get(Some(&change), "commit"));
  let ids = engine::resolve_object_ids(
    &["HEAD".to_string(), format!("{commit}^{{tree}}"), "HEAD^{tree}".to_string()],
    cwd,
  )?;
  let id = |index: usize| ids.get(index).cloned().unwrap_or_default();
  let current = operation.get("current");
  let mut application = Object::new();
  application.set("schema", string("causet.application/v4"));
  application.set("type", string("application"));
  application.set("id", string(&new_id("apply")));
  copy(&mut application, "reconciliationOperation", operation.get("id"));
  copy(&mut application, "originCommit", get(Some(&change), "commit"));
  copy(&mut application, "originChangeId", get(Some(&change), "changeId"));
  application.set("appliedCommit", string(&id(0)));
  if relation == "contextual-fork" {
    application.set("appliedChangeId", string(&engine::change_id_for_commit(&id(0), cwd)?));
  } else {
    copy(&mut application, "appliedChangeId", get(Some(&change), "changeId"));
  }
  copy(&mut application, "targetBefore", get(current, "targetBefore"));
  application.set("sourceTree", string(&id(1)));
  application.set("resultTree", string(&id(2)));
  application.set("relation", string(relation));
  application.set("forecastId", or_null(operation.get("forecastId")));
  application.set("conflictedPaths", or_empty(get(current, "conflictedPaths")));
  application.set("resolutions", or_empty(get(current, "resolutionOutcomes")));
  application.set("semanticMerges", or_empty(get(current, "semanticMerges")));
  application.set("createdAt", string(&iso_now()));

  let mut applied = items(operation.get("applied"));
  applied.push(Value::Object(application));
  operation.set("applied", Value::Array(applied));
  operation.set("nextIndex", Value::Number(next + 1.0));
  operation.set("current", Value::Null);
  operation.set("state", string("running"));
  fault_point("reconcile:before-journal-advance");
  write_state(operation, cwd)
}

/// `conflictError(operation, result, cwd)`: the refusal a paused step answers
/// with, naming what is conflicted and what could settle it.
fn conflict_error(operation: &Object, change: &Value, output: &str, cwd: &str) -> GitError {
  let current = operation.get("current");
  let paths: Vec<String> = items(get(current, "conflictedPaths"))
    .iter()
    .map(|path| js_text(Some(path)))
    .collect();
  let suggestions: usize = items(get(current, "conflicts"))
    .iter()
    .map(|conflict| items(get(Some(conflict), "candidates")).len())
    .sum();
  let plural = |count: usize| if count == 1 { "" } else { "s" };
  let mut details = Vec::new();
  if !output.is_empty() {
    details.push(output.to_string());
  }
  if !paths.is_empty() {
    details.push(format!("\nConflicted paths: {}", paths.join(", ")));
  }
  details.push(if suggestions > 0 {
    format!(
      "{suggestions} prior resolution candidate{} found. Run 'cst resolve status'.",
      plural(suggestions)
    )
  } else {
    "No exact prior resolution was found.".to_string()
  });
  // An ordinary conflict remains actionable even if semantic metadata is stale.
  let journal = Value::Object(operation.clone());
  if let Ok(plans) = spec_merge_plans_for_operation(Some(&journal), cwd) {
    let clean = plans
      .iter()
      .filter(|plan| as_text(get(Some(plan), "status")).as_deref() == Some("clean"))
      .count();
    if clean > 0 {
      details.push(format!(
        "{clean} deterministic spec merge{} available. Run 'cst spec status'.",
        plural(clean)
      ));
    }
  }
  details.push("Resolve and stage the files, then run 'cst reconcile --continue'.".to_string());
  details.push(
    "Run 'cst reconcile --status' for details or 'cst reconcile --abort' to restore the starting state."
      .to_string(),
  );
  GitError::new(
    "conflict-paused",
    format!(
      "Reconciliation paused while applying {}.",
      js_text(get(Some(change), "shortCommit"))
    ),
  )
  .details(details.join("\n"))
}

/// The `timings` member, as `operation.timings ??= { activeApplicationMs: 0 }`
/// leaves it.
fn timings_of(operation: &Object) -> Object {
  match operation.get("timings") {
    Some(Value::Object(timings)) => timings.clone(),
    _ => {
      let mut timings = Object::new();
      timings.set("activeApplicationMs", Value::Number(0.0));
      timings
    }
  }
}

/// `accumulateGitMetrics(operation, metrics)`: one phase's Git activity added
/// to what the journal already holds, command by command. A journal whose
/// counts are missing adds up as JavaScript adds `undefined`: to `NaN`, which
/// is written as `null`.
fn accumulate_git_metrics(operation: &mut Object, metrics: &Metrics) -> GitResult<()> {
  let mut timings = timings_of(operation);
  let existing = timings.get("git").filter(|git| !nullish(Some(git))).cloned();
  let existing = existing.as_ref();
  // A member of `existing`, which is all zeros when the journal holds none.
  let stored = |name: &str| match existing {
    Some(_) => number(get(existing, name)),
    None => 0.0,
  };
  // `existing.<name> ?? fallback`.
  let stored_or = |name: &str, fallback: f64| match get(existing, name) {
    value if nullish(value) => fallback,
    value => number(value),
  };
  // `existing.byCommand.map(...)`.
  let recorded = match (existing, get(existing, "byCommand")) {
    (None, _) => Vec::new(),
    (_, Some(Value::Array(recorded))) => recorded.clone(),
    (_, None) => {
      return Err(GitError::uncoded("Cannot read properties of undefined (reading 'map')"));
    }
    (_, Some(Value::Null)) => {
      return Err(GitError::uncoded("Cannot read properties of null (reading 'map')"));
    }
    _ => return Err(GitError::uncoded("existing.byCommand.map is not a function")),
  };
  let mut by_command: Vec<(Value, Object)> = Vec::new();
  for item in recorded {
    let Value::Object(mut entry) = item else {
      continue;
    };
    let count = entry.get("count").cloned();
    let processes = or_null(entry.get("processes"));
    entry.set(
      "processes",
      if matches!(processes, Value::Null) { count.unwrap_or(Value::Null) } else { processes },
    );
    for name in ["sessionQueries", "cacheHits"] {
      let value = number_or(entry.get(name), 0.0);
      entry.set(name, Value::Number(value));
    }
    let command = entry.get("command").cloned().unwrap_or(Value::Null);
    match by_command.iter_mut().find(|(key, _)| strict_equals(Some(key), Some(&command))) {
      Some(slot) => slot.1 = entry,
      None => by_command.push((command, entry)),
    }
  }
  for item in &metrics.by_command {
    let command = string(&item.command);
    let index = match by_command.iter().position(|(key, _)| strict_equals(Some(key), Some(&command))) {
      Some(index) => index,
      None => {
        let mut entry = Object::new();
        entry.set("command", command.clone());
        for name in ["count", "processes", "sessionQueries", "cacheHits", "totalMs", "maxMs"] {
          entry.set(name, Value::Number(0.0));
        }
        by_command.push((command, entry));
        by_command.len() - 1
      }
    };
    let entry = &mut by_command[index].1;
    let mut add = |name: &str, amount: f64| {
      let value = number(entry.get(name)) + amount;
      entry.set(name, Value::Number(value));
    };
    add("count", item.count as f64);
    add("processes", item.processes as f64);
    add("sessionQueries", item.session_queries as f64);
    add("cacheHits", item.cache_hits as f64);
    add("totalMs", item.total_ms);
    let longest = number(entry.get("maxMs")).max(item.max_ms);
    entry.set("maxMs", Value::Number(longest));
  }
  let mut commands: Vec<Object> = by_command
    .into_iter()
    .map(|(_, mut entry)| {
      for name in ["totalMs", "maxMs"] {
        let value = number(entry.get(name));
        entry.set(name, rounded(value));
      }
      entry
    })
    .collect();
  // `right.totalMs - left.totalMs`, stable.
  commands.sort_by(|left, right| {
    number(right.get("totalMs"))
      .partial_cmp(&number(left.get("totalMs")))
      .unwrap_or(std::cmp::Ordering::Equal)
  });
  let mut git = Object::new();
  git.set("count", Value::Number(stored("count") + metrics.count as f64));
  git.set(
    "processes",
    Value::Number(stored_or("processes", stored("count")) + metrics.processes as f64),
  );
  git.set(
    "sessionQueries",
    Value::Number(stored_or("sessionQueries", 0.0) + metrics.session_queries as f64),
  );
  git.set("cacheHits", Value::Number(stored_or("cacheHits", 0.0) + metrics.cache_hits as f64));
  git.set("totalMs", rounded(stored("totalMs") + metrics.total_ms));
  git.set("failed", Value::Number(stored("failed") + metrics.failed as f64));
  git.set("byCommand", Value::Array(commands.into_iter().map(Value::Object).collect()));
  timings.set("git", Value::Object(git));
  operation.set("timings", Value::Object(timings));
  Ok(())
}

/// A phase of active application: when it began, and the collector counting
/// its Git activity until it is recorded.
type Phase = Option<(Instant, CollectorId)>;

/// `finishPhase(persist)`: the phase's duration and Git activity added to the
/// journal's timings, once.
fn finish_phase(operation: &mut Object, phase: &mut Phase, persist: bool, cwd: &str) -> GitResult<()> {
  let Some((started, collector)) = phase.take() else {
    return Ok(());
  };
  let mut timings = timings_of(operation);
  let active = number(timings.get("activeApplicationMs")) + elapsed(started);
  timings.set("activeApplicationMs", Value::Number(active));
  operation.set("timings", Value::Object(timings));
  accumulate_git_metrics(operation, &metrics::end(collector))?;
  if persist {
    write_state(operation, cwd)?;
  }
  Ok(())
}

/// The loop of `runReconciliationQueue`: each queued change picked onto the
/// last, until the queue is done or a step pauses.
fn apply_queue(operation: &mut Object, phase: &mut Phase, cwd: &str) -> GitResult<()> {
  loop {
    let queue = items(operation.get("queue"));
    let Some(change) = queue.get(number(operation.get("nextIndex")) as usize).cloned() else {
      return Ok(());
    };
    let commit = js_text(get(Some(&change), "commit"));
    operation.set("state", string("applying"));
    let mut current = Object::new();
    copy(&mut current, "sourceCommit", get(Some(&change), "commit"));
    copy(&mut current, "sourceChangeId", get(Some(&change), "changeId"));
    current.set("targetBefore", string(&engine::current_head(cwd)?));
    current.set("conflictedPaths", Value::Array(Vec::new()));
    current.set("startedAt", string(&iso_now()));
    operation.set("current", Value::Object(current));
    write_state(operation, cwd)?;

    let mut pick = GIT_NO_RERERE.to_vec();
    pick.extend(["cherry-pick", "-x", &commit]);
    let result = git_allowing_failure(&pick, cwd)?;
    if result.ok {
      record_successful_application(operation, "causal-reconciliation", cwd)?;
      continue;
    }
    let paths = engine::unmerged_paths(cwd)?;
    edit_current(operation, |current| {
      current.set("conflictedPaths", Value::Array(paths.iter().map(|path| string(path)).collect()));
    });
    let conflicts = capture_conflict_descriptors(&paths, cwd)?;
    edit_current(operation, |current| {
      current.set("conflicts", Value::Array(conflicts));
      current.set("gitOutput", string(&result.output));
    });
    operation.set("state", string(if paths.is_empty() { "blocked" } else { "conflicted" }));
    if !paths.is_empty() && apply_forecast_resolutions(operation, &change, cwd)? {
      continue;
    }
    finish_phase(operation, phase, false, cwd)?;
    write_state(operation, cwd)?;
    return Err(conflict_error(operation, &change, &result.output, cwd));
  }
}

/// `runReconciliationQueue(operation, cwd, phaseStarted)`.
fn run_queue(operation: &mut Object, cwd: &str, phase_started: Instant) -> GitResult<Value> {
  let mut phase: Phase = Some((phase_started, metrics::begin("reconciliation-application")));
  if let Err(error) = apply_queue(operation, &mut phase, cwd) {
    finish_phase(operation, &mut phase, true, cwd)?;
    return Err(error);
  }
  finish_phase(operation, &mut phase, false, cwd)?;
  finalize(operation, cwd)
}

// ---------------------------------------------------------------------------
// Publication
// ---------------------------------------------------------------------------

/// `publishResolution(outcome, application, cwd)`: the resolution retained
/// under its signature and result, unless that ref already holds one.
fn publish_resolution(outcome: &Value, application: &Value, cwd: &str) -> GitResult<()> {
  let field = |name: &str| get(Some(outcome), name);
  let signature = js_text(field("signature"));
  let result_blob = field("resultBlob").filter(|blob| !nullish(Some(blob)));
  let blob_name = result_blob.map_or_else(|| "deleted".to_string(), |blob| js_text(Some(blob)));
  let name = format!("{}/{signature}/{blob_name}", ref_family("resolutions", cwd)?);
  if engine::ref_exists(&name, cwd)? {
    let existing = engine::resolve_revision(&name, cwd)?;
    // `readNote(existingCommit, cwd)`: one note, read by itself.
    let notes_name = causet_engine::locations::names(cwd)?.notes_name;
    let note = engine::read_note_text(notes_name, &existing, cwd)?.unwrap_or_default();
    let retained = note_records(&note)
      .iter()
      .any(|record| as_text(get(Some(record), "type")).as_deref() == Some("resolution"));
    if retained {
      return Ok(());
    }
  }

  // `treeForResolution(outcome, cwd)`.
  let tree = if truthy(field("resultBlob")) {
    let mode = match as_text(field("resultMode")).as_deref() {
      Some("100755") => "100755",
      _ => "100644",
    };
    let entry = format!("{mode} blob {blob_name}\tresult\0");
    run_git(&owned(&["mktree", "-z"]), &RunOptions::new(cwd).input(entry))?.stdout
  } else {
    run_git(&owned(&["mktree"]), &RunOptions::new(cwd).input(""))?.stdout
  };
  let message = [
    format!("Conflict resolution {}", signature.chars().take(20).collect::<String>()),
    String::new(),
    format!("Resolution-Signature: {signature}"),
    format!("Result-Blob: {blob_name}"),
  ]
  .join("\n");
  let commit = run_git(
    &owned(&["commit-tree", &tree, "-F", "-"]),
    &RunOptions::new(cwd).input(format!("{message}\n")),
  )?
  .stdout;
  let mut record = Object::new();
  record.set("schema", string("causet.resolution/v1"));
  record.set("type", string("resolution"));
  record.set("id", string(&new_id("resolution")));
  for (name, from) in [
    ("signature", "signature"),
    ("algorithm", "algorithm"),
    ("base", "base"),
    ("ours", "ours"),
    ("theirs", "theirs"),
    ("resultBlob", "resultBlob"),
    ("resultMode", "resultMode"),
    ("originalPath", "path"),
  ] {
    copy(&mut record, name, field(from));
  }
  copy(&mut record, "originatingApplication", get(Some(application), "id"));
  copy(&mut record, "originatingCommit", get(Some(application), "appliedCommit"));
  copy(&mut record, "originatingChangeId", get(Some(application), "appliedChangeId"));
  copy(&mut record, "decision", field("decision"));
  record.set("ref", string(&name));
  record.set("resolutionCommit", string(&commit));
  record.set("createdAt", string(&iso_now()));
  let published = append_note(&commit, &Value::Object(record), cwd, &[format!("create {name} {commit}")]);
  let Err(error) = published else {
    return Ok(());
  };
  // Diagnose only a failed path creation, never an existing lock or a
  // permission refusal.
  let details = error.details.to_lowercase();
  let path_creation = (details.contains("unable to create directory") || details.contains("filename too long"))
    && !details.contains("permission denied")
    && !details.contains("file exists");
  if cfg!(windows) && error.code == "git-command-failed" && path_creation {
    if let Ok(relative) = engine::git_path(&name, cwd) {
      let ref_path = text::resolve(cwd, &relative);
      let lock_length = format!("{ref_path}.lock").encode_utf16().count();
      if lock_length >= 260 {
        return Err(
          GitError::new(
            "path-length-exceeded",
            format!(
              "Cannot retain conflict resolution: the Windows ref lock path is {lock_length} characters; MAX_PATH permits at most 259."
            ),
          )
          .details(format!(
            "Ref: {ref_path}\nShorten the repository's Git directory path by at least {} characters, or enable Git long paths with git config core.longpaths true. If an operation is pending, use its --abort command before starting it again.\n{}",
            lock_length - 259,
            error.details
          )),
        );
      }
    }
  }
  Err(error)
}

/// Marks the journal as unable to publish, and answers with why.
fn forecast_mismatch(operation: &mut Object, cwd: &str, message: String, details: Vec<String>) -> GitResult<Value> {
  operation.set("state", string("forecast-mismatch"));
  write_state(operation, cwd)?;
  Err(GitError::new("stale-forecast", message).details(details.join("\n")))
}

/// `finalizeReconciliation(operation, cwd)`: the result checked against its
/// forecast, the overlay put back, and the applications, their retained
/// resolutions and the receipt published.
fn finalize(operation: &mut Object, cwd: &str) -> GitResult<Value> {
  let ids = engine::resolve_object_ids(&owned(&["HEAD^{commit}", "HEAD^{tree}"]), cwd)?;
  let attached_to = ids.first().cloned().unwrap_or_default();
  let result_tree = ids.get(1).cloned().unwrap_or_default();
  let forecast_id = js_text(operation.get("forecastId"));
  let approval = operation.get("forecastApproval").cloned();
  let predicted_tree = get(approval.as_ref(), "predictedResultTree");
  if truthy(predicted_tree) && !strict_equals(predicted_tree, Some(&string(&result_tree))) {
    return forecast_mismatch(
      operation,
      cwd,
      format!("Reconciliation result does not match forecast '{forecast_id}'."),
      vec![
        format!("Forecast tree: {}", js_text(predicted_tree)),
        format!("Actual tree:   {result_tree}"),
        "Run 'cst reconcile --abort' and generate a new forecast.".to_string(),
      ],
    );
  }
  // The overlay goes back only after the committed result has verified, and
  // its own prediction is checked before anything is published.
  let mut overlay_result = Value::Null;
  if let Some(overlay) = operation.get("targetOverlay").filter(|overlay| truthy(Some(overlay))).cloned() {
    let base_tree = engine::tree_id(&js_text(operation.get("targetBefore")), cwd)?;
    let restored = materialize_overlay(&overlay, &base_tree, &result_tree, cwd)?;
    if let Some(conflict) = get(Some(&restored), "conflict").filter(|conflict| truthy(Some(conflict))) {
      return forecast_mismatch(
        operation,
        cwd,
        "The target overlay no longer merges with the committed result.".to_string(),
        vec![
          js_text(get(Some(conflict), "details")),
          "Nothing was published. Run 'cst reconcile --abort' and forecast again.".to_string(),
        ],
      );
    }
    let actual = get(Some(&restored), "tree").cloned().unwrap_or(Value::Null);
    // The merged draft is on disk from here on, so the worktree is dirty by
    // this operation's own doing. Journaled before the prediction is compared,
    // so an abort can tell that dirt apart from the user's own (ADR-0028).
    operation.set("overlayRematerialized", Value::Bool(true));
    write_state(operation, cwd)?;
    let predicted = or_null(get(approval.as_ref(), "predictedOverlayTree"));
    if truthy(Some(&predicted)) && !strict_equals(Some(&predicted), Some(&actual)) {
      return forecast_mismatch(
        operation,
        cwd,
        format!("Re-materializing the target overlay did not match forecast '{forecast_id}'."),
        vec![
          format!("Forecast overlay tree: {}", js_text(Some(&predicted))),
          format!("Actual overlay tree:   {}", js_text(Some(&actual))),
          "Nothing was published. Run 'cst reconcile --abort' and forecast again.".to_string(),
        ],
      );
    }
    let mut outcome = Object::new();
    copy(&mut outcome, "checkpoint", get(Some(&overlay), "checkpoint"));
    outcome.set("tree", actual);
    outcome.set("predicted", predicted);
    outcome.set("rematerialized", Value::Bool(true));
    overlay_result = Value::Object(outcome);
  }

  let applications = items(operation.get("applied"));
  let plan = operation.get("plan").cloned();
  let plan = plan.as_ref();
  let forked: Vec<Value> = applications
    .iter()
    .filter(|application| as_text(get(Some(application), "relation")).as_deref() == Some("contextual-fork"))
    .filter_map(|application| get(Some(application), "originCommit").cloned())
    .fold(Vec::new(), |mut origins, origin| {
      if !origins.iter().any(|known| strict_equals(Some(known), Some(&origin))) {
        origins.push(origin);
      }
      origins
    });
  let accept_candidates = truthy(operation.get("acceptCandidates"));
  let covered: Vec<Value> = items(get(plan, "changes"))
    .into_iter()
    .filter(|change| {
      let commit = get(Some(change), "commit");
      !forked.iter().any(|origin| strict_equals(Some(origin), commit))
        && (as_text(get(Some(change), "status")).as_deref() != Some("candidate-equivalent") || accept_candidates)
    })
    .collect();
  let column = |name: &str| {
    Value::Array(covered.iter().map(|change| get(Some(change), name).cloned().unwrap_or(Value::Null)).collect())
  };
  let applied: Vec<Value> = applications
    .iter()
    .map(|application| {
      let mut item = Object::new();
      for (name, from) in [
        ("sourceCommit", "originCommit"),
        ("appliedCommit", "appliedCommit"),
        ("changeId", "appliedChangeId"),
        ("relation", "relation"),
        ("conflictedPaths", "conflictedPaths"),
        ("resolutions", "resolutions"),
        ("semanticMerges", "semanticMerges"),
      ] {
        copy(&mut item, name, get(Some(application), from));
      }
      Value::Object(item)
    })
    .collect();
  let timings = operation.get("timings");
  let started_at = js_text(operation.get("startedAt"));
  let mut receipt_timings = Object::new();
  receipt_timings.set(
    "activeApplicationMs",
    rounded(number_or(get(timings, "activeApplicationMs"), 0.0)),
  );
  receipt_timings.set(
    "elapsedWallMs",
    match causet_model::dates::parse_ms(&started_at) {
      Some(started) => Value::Number(crate::host::now_ms() - started),
      None => Value::Null,
    },
  );
  receipt_timings.set("git", or_null(get(timings, "git")));
  let mut receipt = Object::new();
  receipt.set("schema", string("causet.reconciliation/v6"));
  receipt.set("type", string("reconciliation"));
  receipt.set("id", string(&new_id("reconcile")));
  copy(&mut receipt, "operationId", operation.get("id"));
  receipt.set("forecastId", or_null(operation.get("forecastId")));
  copy(&mut receipt, "sourceRef", operation.get("sourceRef"));
  copy(&mut receipt, "sourceHead", operation.get("sourceHead"));
  copy(&mut receipt, "targetBefore", operation.get("targetBefore"));
  receipt.set("resultCommit", string(&attached_to));
  receipt.set("absorbedCommits", column("commit"));
  receipt.set("absorbedChanges", column("changeId"));
  receipt.set("applied", Value::Array(applied));
  receipt.set("forkedSourceCommits", Value::Array(forked));
  receipt.set("quarantinedFacts", or_empty(get(plan, "quarantinedFacts")));
  copy(&mut receipt, "targetTreeBefore", get(plan, "targetTree"));
  copy(&mut receipt, "sourceTree", get(plan, "sourceTree"));
  receipt.set("resultTree", string(&result_tree));
  copy(&mut receipt, "exactStateEqualityBefore", get(plan, "exactStateEquality"));
  receipt.set(
    "exactStateEqualityAfter",
    Value::Bool(strict_equals(Some(&string(&result_tree)), get(plan, "sourceTree"))),
  );
  receipt.set("timings", Value::Object(receipt_timings));
  copy(&mut receipt, "startedAt", operation.get("startedAt"));
  receipt.set("createdAt", string(&iso_now()));
  let receipt = Value::Object(receipt);

  // Publication is the one stretch that is not a single atomic act; the fault
  // points name where the failure-boundary tests stop it.
  fault_point("reconcile:before-publish");
  let mut carried = Vec::new();
  for application in &applications {
    for outcome in items(get(Some(application), "resolutions")) {
      publish_resolution(&outcome, application, cwd)?;
    }
    let applied_commit = js_text(get(Some(application), "appliedCommit"));
    append_note(&applied_commit, application, cwd, &[])?;
    fault_point("reconcile:mid-publish");
    let origin = get(Some(application), "originCommit");
    carried.push((
      if truthy(origin) { js_text(origin) } else { String::new() },
      applied_commit,
      as_text(get(Some(application), "appliedChangeId")),
    ));
  }
  // One read of the notes ref for the whole queue (ADR-0013).
  crate::provenance::carry_provenance_for_applications(&carried, cwd)?;
  fault_point("reconcile:before-receipt");
  append_note(&attached_to, &receipt, cwd, &[])?;
  fault_point("reconcile:before-clear");
  clear_state(cwd)?;
  let mut result = Object::new();
  copy(&mut result, "operationId", operation.get("id"));
  copy(&mut result, "plan", plan);
  result.set("receipt", receipt);
  // Reported, never published: the overlay is uncommitted context (ADR-0028).
  result.set("targetOverlay", overlay_result);
  Ok(Value::Object(result))
}

// ---------------------------------------------------------------------------
// Starting
// ---------------------------------------------------------------------------

/// `startOperation(sourceRef, plan, options, cwd)`: the journal of a new
/// reconciliation.
fn start_operation(
  source_ref: &str,
  plan: &Value,
  accept_candidates: bool,
  forecast: Option<&Value>,
  cwd: &str,
) -> GitResult<Object> {
  let context = engine::repo_context(cwd)?;
  let mut operation = Object::new();
  operation.set("schema", string("causet.reconciliation-operation/v4"));
  operation.set("id", string(&new_id("reconcile_op")));
  operation.set("state", string("running"));
  operation.set("worktree", string(&context.root));
  operation.set("sourceRef", string(source_ref));
  copy(&mut operation, "sourceHead", get(Some(plan), "sourceHead"));
  copy(&mut operation, "targetBefore", get(Some(plan), "targetHead"));
  operation.set(
    "targetBranchRef",
    engine::symbolic_ref("HEAD", cwd, false)?.map_or(Value::Null, |name| string(&name)),
  );
  operation.set("acceptCandidates", Value::Bool(accept_candidates));
  operation.set("forecastId", or_null(get(forecast, "id")));
  operation.set(
    "forecastApproval",
    match forecast {
      Some(forecast) => {
        let field = |name: &str| get(Some(forecast), name);
        let mut approval = Object::new();
        copy(&mut approval, "id", field("id"));
        copy(&mut approval, "planFingerprint", field("planFingerprint"));
        approval.set("approvedResolutions", or_empty(field("approvedResolutions")));
        approval.set("approvedSpecMerges", or_empty(field("approvedSpecMerges")));
        copy(&mut approval, "status", field("status"));
        copy(&mut approval, "predictedResultTree", field("predictedResultTree"));
        approval.set("predictedOverlayTree", or_null(field("predictedOverlayTree")));
        Value::Object(approval)
      }
      None => Value::Null,
    },
  );
  // Recorded so an abort can put the captured worktree back, and so a resumed
  // operation in a new process knows an overlay is in play (ADR-0028).
  operation.set("targetOverlay", or_null(get(forecast, "targetOverlay")));
  operation.set("plan", plan.clone());
  operation.set(
    "queue",
    Value::Array(
      items(get(Some(plan), "changes"))
        .into_iter()
        .filter(|change| as_text(get(Some(change), "status")).as_deref() == Some("new"))
        .collect(),
    ),
  );
  operation.set("nextIndex", Value::Number(0.0));
  operation.set("applied", Value::Array(Vec::new()));
  operation.set("current", Value::Null);
  operation.set("startedAt", string(&iso_now()));
  let mut git = Object::new();
  for name in ["count", "processes", "sessionQueries", "cacheHits", "totalMs", "failed"] {
    git.set(name, Value::Number(0.0));
  }
  git.set("byCommand", Value::Array(Vec::new()));
  let mut timings = Object::new();
  timings.set("activeApplicationMs", Value::Number(0.0));
  timings.set("git", Value::Object(git));
  operation.set("timings", Value::Object(timings));
  operation.set("updatedAt", string(&iso_now()));
  Ok(operation)
}

/// `reconcile(sourceRef, { acceptCandidates, forecastId })`: the source's new
/// changes applied to this worktree's branch, one pick each, and the receipt
/// published; or the refusal of the step it paused on.
pub fn reconcile(source_ref: &str, accept_candidates: bool, forecast_id: Option<&str>, cwd: &str) -> GitResult<Value> {
  with_object_session(cwd, || reconcile_in_session(source_ref, accept_candidates, forecast_id, cwd))
}

fn reconcile_in_session(
  source_ref: &str,
  accept_candidates: bool,
  forecast_id: Option<&str>,
  cwd: &str,
) -> GitResult<Value> {
  let busy = read_state(cwd)?.is_some()
    || read_journal(cwd, "rebase.json", "causet.rebase-operation", "rebase")?.is_some();
  if busy {
    return Err(
      GitError::new(
        "operation-in-progress",
        "A VCS Lab operation is already in progress in this worktree.",
      )
      .details("Inspect the active reconciliation or rebase before starting another operation."),
    );
  }
  // A forecast carrying a target overlay expects a dirty worktree: the overlay
  // is the uncommitted work. The clean check is replaced by a stricter one,
  // that the live tree equals the overlay tree exactly (ADR-0028).
  let approved_overlay = match forecast_id {
    Some(id) => get(Some(&read_forecast(id, cwd)?), "targetOverlay")
      .filter(|overlay| truthy(Some(overlay)))
      .cloned(),
    None => None,
  };
  if approved_overlay.is_none() {
    engine::assert_clean(cwd)?;
  }
  let plan = crate::plan::merge_plan(source_ref, cwd)?;
  let forecast = match forecast_id {
    Some(id) => Some(forecast_for_plan(id, &plan, cwd)?),
    None => None,
  };
  if let Some(overlay) = &approved_overlay {
    // Refuses before anything moves.
    assert_overlay_current(overlay, cwd)?;
  }
  let accept_candidates = accept_candidates || truthy(get(forecast.as_ref(), "acceptCandidates"));
  let candidates = items(get(Some(&plan), "changes"))
    .iter()
    .any(|change| as_text(get(Some(change), "status")).as_deref() == Some("candidate-equivalent"));
  if candidates && !accept_candidates {
    return Err(
      GitError::new(
        "approval-required",
        "The plan contains heuristic patch-equivalence candidates.",
      )
      .details("Review 'cst merge-plan' and rerun with --accept-candidates to treat them as already applied."),
    );
  }

  let mut operation = start_operation(source_ref, &plan, accept_candidates, forecast.as_ref(), cwd)?;
  write_state(&operation, cwd)?;
  if let Some(overlay) = &approved_overlay {
    // The overlay is safe in its checkpoint, so the worktree can be reduced to
    // the committed head and the queue runs exactly as it does without one.
    operation.set("state", string("reducing-overlay"));
    write_state(&operation, cwd)?;
    reduce_to_committed_head(overlay, cwd)?;
    operation.set("state", string("running"));
    write_state(&operation, cwd)?;
  }
  run_queue(&mut operation, cwd, Instant::now())
}

/// `formatReconciliationResult(result)`.
pub fn format_reconciliation_result(result: &Value) -> String {
  let receipt = get(Some(result), "receipt");
  let field = |name: &str| get(receipt, name);
  let applied = items(field("applied"));
  let contextual = applied
    .iter()
    .filter(|item| as_text(get(Some(item), "relation")).is_some_and(|relation| relation.starts_with("contextual-")))
    .count();
  let mut decisions: Vec<(String, usize)> = Vec::new();
  let mut semantic_merges = 0;
  for item in &applied {
    for resolution in items(get(Some(item), "resolutions")) {
      let decision = js_text(get(Some(&resolution), "decision"));
      match decisions.iter_mut().find(|(name, _)| *name == decision) {
        Some((_, count)) => *count += 1,
        None => decisions.push((decision, 1)),
      }
    }
    semantic_merges += items(get(Some(item), "semanticMerges")).len();
  }
  let mut lines = vec![
    "Reconciliation complete.".to_string(),
    format!("operation    {}", js_text(get(Some(result), "operationId"))),
    format!("result       {}", short(field("resultCommit"))),
    format!("source       {} @ {}", js_text(field("sourceRef")), short(field("sourceHead"))),
    format!(
      "coverage     {} covered; {} applied",
      items(field("absorbedChanges")).len(),
      applied.len()
    ),
    format!("contextual   {contextual}"),
    format!(
      "same state   {}",
      if truthy(field("exactStateEqualityAfter")) { "yes" } else { "no" }
    ),
  ];
  if truthy(field("forecastId")) {
    lines.push(format!("forecast     {}", js_text(field("forecastId"))));
  }
  // `formatOverlayOutcome(result.targetOverlay)`.
  if let Some(overlay) = get(Some(result), "targetOverlay").filter(|overlay| truthy(Some(overlay))) {
    lines.push(format!(
      "overlay      checkpoint {} re-materialized uncommitted as {}",
      short(get(Some(overlay), "checkpoint")),
      short(get(Some(overlay), "tree"))
    ));
  }
  let timings = field("timings");
  if truthy(timings) {
    lines.push(format!("active time  {} ms", fixed(get(timings, "activeApplicationMs"))));
  }
  lines.extend(git_activity(get(timings, "git")));
  if semantic_merges > 0 {
    lines.push(format!("spec merges  {semantic_merges} deterministic"));
  }
  if !decisions.is_empty() {
    let text: Vec<String> = decisions.iter().map(|(name, count)| format!("{count} {name}")).collect();
    lines.push(format!("resolutions  {}", text.join(", ")));
  }
  lines.join("\n")
}

// ---------------------------------------------------------------------------
// Status and abort
// ---------------------------------------------------------------------------

/// `reconciliationStatus()`.
pub fn reconciliation_status(cwd: &str) -> GitResult<Value> {
  let mut status = Object::new();
  let Some(operation) = read_state(cwd)? else {
    status.set("active", Value::Bool(false));
    status.set("state", string("idle"));
    return Ok(Value::Object(status));
  };
  let field = |name: &str| get(Some(&operation), name);
  let actual = engine::symbolic_ref("HEAD", cwd, false)?.map_or(Value::Null, |name| string(&name));
  let recorded = matches!(&operation, Value::Object(object) if object.get("targetBranchRef").is_some());
  status.set("active", Value::Bool(true));
  copy(&mut status, "operationId", field("id"));
  for name in ["state", "worktree", "sourceRef", "sourceHead", "targetBefore"] {
    copy(&mut status, name, field(name));
  }
  status.set("targetBranchRef", or_null(field("targetBranchRef")));
  status.set("forecastId", or_null(field("forecastId")));
  let mut recovery = Object::new();
  recovery.set("expectedBranchRef", or_null(field("targetBranchRef")));
  recovery.set("actualBranchRef", actual.clone());
  recovery.set("actualHead", string(&engine::current_head(cwd)?));
  copy(&mut recovery, "targetBefore", field("targetBefore"));
  recovery.set(
    "branchMatches",
    if recorded {
      Value::Bool(strict_equals(Some(&actual), field("targetBranchRef")))
    } else {
      Value::Null
    },
  );
  status.set("recovery", Value::Object(recovery));
  let total = match field("queue") {
    None => {
      return Err(GitError::uncoded("Cannot read properties of undefined (reading 'length')"));
    }
    Some(Value::Null) => {
      return Err(GitError::uncoded("Cannot read properties of null (reading 'length')"));
    }
    queue => length(queue),
  };
  let mut progress = Object::new();
  copy(&mut progress, "completed", field("nextIndex"));
  copy(&mut progress, "total", total.as_ref());
  let remaining = number(total.as_ref()) - number(field("nextIndex"));
  progress.set(
    "remaining",
    if remaining.is_finite() { Value::Number(remaining) } else { Value::Null },
  );
  status.set("progress", Value::Object(progress));
  status.set(
    "current",
    if truthy(field("current")) {
      let mut current = match field("current") {
        Some(Value::Object(current)) => current.clone(),
        _ => Object::new(),
      };
      current.set(
        "gitCherryPickHead",
        engine::pseudo_ref_target("CHERRY_PICK_HEAD", cwd)?.map_or(Value::Null, |commit| string(&commit)),
      );
      current.set(
        "unresolvedPaths",
        Value::Array(engine::unmerged_paths(cwd)?.iter().map(|path| string(path)).collect()),
      );
      Value::Object(current)
    } else {
      Value::Null
    },
  );
  copy(&mut status, "applied", field("applied"));
  status.set("timings", or_null(field("timings")));
  copy(&mut status, "startedAt", field("startedAt"));
  copy(&mut status, "updatedAt", field("updatedAt"));
  Ok(Value::Object(status))
}

/// `formatReconciliationStatus(status)`.
pub fn format_reconciliation_status(status: &Value) -> String {
  let field = |name: &str| get(Some(status), name);
  if !truthy(field("active")) {
    return "No reconciliation is in progress in this worktree.".into();
  }
  let progress = field("progress");
  let mut lines = vec![
    format!("operation    {}", js_text(field("operationId"))),
    format!("state        {}", js_text(field("state"))),
    format!("source       {} @ {}", js_text(field("sourceRef")), short(field("sourceHead"))),
    format!("target start {}", short(field("targetBefore"))),
    format!(
      "progress     {}/{} applied",
      js_text(get(progress, "completed")),
      js_text(get(progress, "total"))
    ),
  ];
  if let Some(current) = field("current").filter(|current| truthy(Some(current))) {
    lines.push(format!(
      "current      {} {}",
      short(get(Some(current), "sourceCommit")),
      js_text(get(Some(current), "sourceChangeId"))
    ));
    let unresolved = items(get(Some(current), "unresolvedPaths"));
    let paths = if unresolved.is_empty() {
      items(get(Some(current), "conflictedPaths"))
    } else {
      unresolved
    };
    if !paths.is_empty() {
      let names: Vec<String> = paths.iter().map(|path| js_text(Some(path))).collect();
      lines.push(format!("conflicts    {}", names.join(", ")));
    }
  }
  lines.push(String::new());
  lines.push(
    match as_text(field("state")).as_deref() {
      Some("conflicted") => "Resolve and stage the conflicts, then run: cst reconcile --continue",
      Some("forecast-mismatch") => "The applied tree diverged from its forecast and cannot be published.",
      _ => "The operation is resumable in this worktree.",
    }
    .to_string(),
  );
  lines.push("Abort and restore the starting commit with: cst reconcile --abort".to_string());
  lines.join("\n")
}

/// `branchLabel(ref)`.
fn branch_label(name: Option<&str>) -> String {
  match name {
    None | Some("") => "a detached HEAD".to_string(),
    Some(name) => name.strip_prefix("refs/heads/").unwrap_or(name).to_string(),
  }
}

/// `requireReconciliationBranch(operation, cwd)`: refuse to continue or abort
/// from a worktree that is no longer on the branch the operation started on,
/// because abort's `reset --hard` moves whatever branch HEAD points at.
///
/// A journal written before `targetBranchRef` existed is trusted only while
/// Git's own sequencer still holds the pick the journal is paused on.
fn require_reconciliation_branch(operation: &Value, cwd: &str) -> GitResult<()> {
  let actual = engine::symbolic_ref("HEAD", cwd, false)?;
  let recorded = match operation {
    Value::Object(object) => object.get("targetBranchRef"),
    _ => None,
  };
  if let Some(target) = recorded {
    let actual_value = actual.as_deref().map_or(Value::Null, string);
    if strict_equals(Some(&actual_value), Some(target)) {
      return Ok(());
    }
    let named = truthy(Some(target));
    let target_label = branch_label(as_text(Some(target)).as_deref());
    let expected = if named {
      format!("branch '{target_label}'")
    } else {
      "a detached HEAD".to_string()
    };
    let found = if named && actual.as_deref().is_some_and(|name| !name.is_empty()) {
      format!("'{}'", branch_label(actual.as_deref()))
    } else {
      branch_label(actual.as_deref())
    };
    let place = if named {
      format!("'{target_label}'")
    } else {
      "the detached HEAD the operation started on".to_string()
    };
    return Err(
      GitError::new(
        "out-of-band-change",
        format!("The reconciliation journal belongs to {expected}, not {found}."),
      )
      .details(format!(
        "Switch back to {place} before continuing or aborting the reconciliation."
      )),
    );
  }
  let pending = engine::pseudo_ref_target("CHERRY_PICK_HEAD", cwd)?;
  let source = get(get(Some(operation), "current"), "sourceCommit");
  if pending
    .as_deref()
    .is_some_and(|commit| !commit.is_empty() && strict_equals(Some(&string(commit)), source))
  {
    return Ok(());
  }
  Err(
    GitError::new(
      "out-of-band-change",
      "The reconciliation journal does not record its branch, and Git holds no matching cherry-pick.",
    )
    .details(
      [
        "The journal predates the branch record, so cst cannot prove this worktree is still on the branch the reconciliation started on.".to_string(),
        format!(
          "Restore it by hand if needed: git reset --hard {} on that branch, then remove the journal file.",
          js_text(get(Some(operation), "targetBefore"))
        ),
      ]
      .join("\n"),
    ),
  )
}

/// `abortReconciliation()`: the pending pick abandoned, the target's original
/// tip restored, and a carried overlay put back.
pub fn abort_reconciliation(cwd: &str) -> GitResult<Value> {
  let Some(operation) = read_state(cwd)? else {
    return Err(GitError::new(
      "no-operation-pending",
      "No reconciliation is in progress in this worktree.",
    ));
  };
  let field = |name: &str| get(Some(&operation), name);
  require_reconciliation_branch(&operation, cwd)?;
  if engine::pseudo_ref_target("CHERRY_PICK_HEAD", cwd)?.is_some_and(|commit| !commit.is_empty()) {
    git(&["cherry-pick", "--abort"], cwd)?;
  } else if !truthy(field("overlayRematerialized")) {
    // Skipped only once the journal says this operation put the overlay back
    // itself: in that one state the dirt is the merged draft it wrote.
    engine::assert_clean(cwd)?;
  }
  let target_before = field("targetBefore");
  let at_target = |cwd: &str| -> GitResult<bool> {
    Ok(strict_equals(Some(&string(&engine::current_head(cwd)?)), target_before))
  };
  if !at_target(cwd)? {
    git(&["reset", "--hard", &js_text(target_before)], cwd)?;
  }
  if !at_target(cwd)? {
    return Err(GitError::new(
      "internal-invariant",
      "Reconciliation abort did not restore the target's original tip.",
    ));
  }
  // The committed tip is restored first and unconditionally; the overlay is
  // put back afterwards, so a draft that cannot be recovered never costs the
  // tip (ADR-0028).
  let overlay = match field("targetOverlay").filter(|overlay| truthy(Some(overlay))) {
    Some(overlay) => restore_overlay_after_abort(overlay, cwd)?,
    None => Value::Null,
  };
  fault_point("reconcile:abort-before-clear");
  clear_state(cwd)?;
  let mut result = Object::new();
  result.set("aborted", Value::Bool(true));
  copy(&mut result, "operationId", field("id"));
  result.set("restoredHead", string(&engine::current_head(cwd)?));
  result.set("overlay", overlay);
  Ok(Value::Object(result))
}

// ---------------------------------------------------------------------------
// Continuing
// ---------------------------------------------------------------------------

/// `forkMergeMessage(operation, cwd)`: the pending pick's message rewritten so
/// the commit it becomes is a new change derived from the one being applied,
/// under a Change-Id the journal remembers across attempts.
fn fork_merge_message(operation: &mut Object, cwd: &str) -> GitResult<()> {
  if !truthy(get(operation.get("current"), "forkChangeId")) {
    let id = string(&new_id("ch"));
    edit_current(operation, |current| current.set("forkChangeId", id));
  }
  let current = operation.get("current");
  // `mergeMessagePath(cwd)`: the sequencer's own state, which
  // `cherry-pick --continue` reads.
  let path = text::join(&engine::repo_context(cwd)?.git_dir, "MERGE_MSG");
  let original = std::fs::read(&path).map_err(|error| crate::envelope::io_failure(&error, "open", &path))?;
  let original = String::from_utf8_lossy(&original);
  // `original.split(/\r?\n/).filter((line) => !/^Change-Id:\s*/i.test(line))`.
  let retained: Vec<&str> = text::split_lines(&original)
    .into_iter()
    .filter(|line| {
      !line
        .get(.."change-id:".len())
        .is_some_and(|start| start.eq_ignore_ascii_case("change-id:"))
    })
    .collect();
  let retained = retained.join("\n");
  let retained = retained.trim_end_matches(text::is_space);
  let trailers = [
    format!("Change-Id: {}", js_text(get(current, "forkChangeId"))),
    format!("Derived-From: {}", js_text(get(current, "sourceChangeId"))),
    format!("Origin-Commit: {}", js_text(get(current, "sourceCommit"))),
  ];
  std::fs::write(&path, format!("{retained}\n\n{}\n", trailers.join("\n")))
    .map_err(|error| crate::envelope::io_failure(&error, "open", &path))?;
  write_state(operation, cwd)
}

/// `continueReconciliation({ fork })`: the paused step committed as the
/// worktree now has it, and the rest of the queue applied. With `fork`, the
/// step becomes a new change derived from the one it applies.
pub fn continue_reconciliation(fork: bool, cwd: &str) -> GitResult<Value> {
  with_object_session(cwd, || continue_in_session(fork, cwd))
}

fn continue_in_session(fork: bool, cwd: &str) -> GitResult<Value> {
  let phase_started = Instant::now();
  let Some(journal) = read_state(cwd)? else {
    return Err(GitError::new(
      "no-operation-pending",
      "No reconciliation is in progress in this worktree.",
    ));
  };
  assert_current_spec_decisions(Some(&journal))?;
  require_reconciliation_branch(&journal, cwd)?;
  if !truthy(get(Some(&journal), "current")) {
    return Err(GitError::new(
      "no-operation-pending",
      "The pending reconciliation has no current change.",
    ));
  }
  let unresolved = engine::unmerged_paths(cwd)?;
  if !unresolved.is_empty() {
    return Err(
      GitError::new("conflict-blocked", "Reconciliation still has unresolved paths.").details(unresolved.join("\n")),
    );
  }
  let Some(pending) = engine::pseudo_ref_target("CHERRY_PICK_HEAD", cwd)?.filter(|commit| !commit.is_empty()) else {
    return Err(
      GitError::new("out-of-band-change", "Git no longer has a cherry-pick to continue.").details(
        "If Git was continued manually, abort this pending cst operation and start a new reconciliation plan.",
      ),
    );
  };
  let source = get(get(Some(&journal), "current"), "sourceCommit");
  if !strict_equals(Some(&string(&pending)), source) {
    return Err(GitError::new(
      "out-of-band-change",
      "Git's pending cherry-pick does not match the cst operation.",
    ));
  }
  let mut operation = match journal {
    Value::Object(operation) => operation,
    _ => Object::new(),
  };

  let merges = items(get(operation.get("current"), "semanticMerges"));
  let captured = capture_spec_merge_outcomes(&merges, cwd)?;
  let semantically_resolved: Vec<Value> = captured
    .iter()
    .flat_map(|merge| items(get(Some(merge), "resolvedPaths")))
    .collect();
  edit_current(&mut operation, |current| current.set("semanticMerges", Value::Array(captured)));
  let decided: Vec<Value> = items(get(operation.get("current"), "conflicts"))
    .into_iter()
    .filter(|conflict| {
      let path = get(Some(conflict), "path");
      !semantically_resolved.iter().any(|resolved| strict_equals(Some(resolved), path))
    })
    .collect();
  let outcomes = capture_resolution_outcomes(&decided, cwd)?;
  edit_current(&mut operation, |current| current.set("resolutionOutcomes", Value::Array(outcomes)));
  write_state(&operation, cwd)?;

  if fork || truthy(get(operation.get("current"), "forkChangeId")) {
    fork_merge_message(&mut operation, cwd)?;
  }
  let mut finish = GIT_NO_RERERE.to_vec();
  finish.extend(["-c", "core.editor=true", "cherry-pick", "--continue"]);
  let result = git_allowing_failure(&finish, cwd)?;
  if !result.ok {
    return Err(
      GitError::new("conflict-blocked", "Git could not continue the reconciliation.").details(result.output),
    );
  }
  let relation = if truthy(get(operation.get("current"), "forkChangeId")) {
    "contextual-fork"
  } else {
    "contextual-application"
  };
  record_successful_application(&mut operation, relation, cwd)?;
  run_queue(&mut operation, cwd, phase_started)
}
