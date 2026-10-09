//! `cst rebase`: `src/rebase-operations.js`, the journaled causal rebase.
//!
//! `startRebase`, `rebaseStatus`, `continueRebase` and `abortRebase`, with the
//! journal of `src/rebase-state.js` and `formatRebaseStatus` and
//! `formatRebaseResult` of `src/cli.js`. The journal is kept as the JSON the
//! JavaScript CLI writes, so a rebase one CLI starts the other reports on,
//! continues or aborts.

use crate::forecast::{fixed, git_activity};
use crate::host::{fault_point, new_id};
use crate::notes_write::append_note;
use crate::plan::RebaseOptions;
use crate::rebase_forecast::{read_rebase_forecast, rebase_forecast_for_plan};
use crate::rebase_program::{
  Parent, absorbed_change_id, absorbed_message, assert_single_identity, rebase_program,
  recreated_merge_message, resolve_step_parents, reworded_message,
};
use crate::reconcile::{accumulate_git_metrics, publish_resolution, timings_of};
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
  assert_overlay_current, materialize_overlay, reduce_to_committed_head, restore_overlay_after_abort,
};
use causet_engine::errors::{GitError, GitResult};
use causet_engine::locations::{CURRENT_NAMES, runtime_directory};
use causet_engine::metrics::{self, CollectorId, iso_now};
use causet_engine::process::{GIT_NO_RERERE, GitOutput, RunOptions, run_git};
use causet_engine::session::with_object_session;
use causet_engine::{engine, text};
use causet_model::js::{get, nullish, strict_equals, text as js_text, to_fixed, to_number, truthy};
use causet_model::json::{Object, Value, lossy, string};
use std::collections::HashMap;
use std::time::Instant;

const JOURNAL: &str = "rebase.json";

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

fn strings(values: &[String]) -> Value {
  Value::Array(values.iter().map(|value| string(value)).collect())
}

/// `value.slice(0, 12)`.
fn twelve(value: &str) -> String {
  value.chars().take(12).collect()
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

/// The lines that are not empty, joined: `[...].filter(Boolean).join("\n")`.
fn joined(lines: &[&str]) -> String {
  lines
    .iter()
    .filter(|line| !line.is_empty())
    .copied()
    .collect::<Vec<_>>()
    .join("\n")
}

// ---------------------------------------------------------------------------
// The journal
// ---------------------------------------------------------------------------

/// `readRebaseState(cwd)`.
fn read_state(cwd: &str) -> GitResult<Option<Value>> {
  read_journal(cwd, JOURNAL, "causet.rebase-operation", "rebase")
}

/// `writeRebaseState(state, cwd)`.
fn write_state(operation: &Object, cwd: &str) -> GitResult<()> {
  write_journal(JOURNAL, &Value::Object(operation.clone()), cwd)
}

/// `clearRebaseState(cwd)`.
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

/// `operation.current.absorption.<name> = value`.
fn edit_absorption(operation: &mut Object, change: impl FnOnce(&mut Object)) {
  edit_current(operation, |current| {
    let mut absorption = match current.get("absorption") {
      Some(Value::Object(absorption)) => absorption.clone(),
      _ => Object::new(),
    };
    change(&mut absorption);
    current.set("absorption", Value::Object(absorption));
  });
}

/// The queued step and its change: `item.change ?? item`.
fn queued(operation: &Object) -> (Value, Value) {
  let queue = items(operation.get("queue"));
  let item = queue
    .get(number(operation.get("nextIndex")) as usize)
    .cloned()
    .unwrap_or(Value::Null);
  let change = match get(Some(&item), "change") {
    value if nullish(value) => item.clone(),
    value => value.cloned().unwrap_or(Value::Null),
  };
  (item, change)
}

/// `executableSteps(operation)`: the program steps that run, which is what
/// progress is counted over.
fn executable_steps(operation: &Value) -> usize {
  items(get(Some(operation), "queue"))
    .iter()
    .filter(|item| as_text(get(Some(item), "kind")).as_deref() != Some("omit"))
    .count()
}

/// `change.shortCommit ?? change.commit.slice(0, 12)`.
fn short_or_commit(change: &Value) -> String {
  match get(Some(change), "shortCommit") {
    value if nullish(value) => twelve(&js_text(get(Some(change), "commit"))),
    value => js_text(value),
  }
}

// ---------------------------------------------------------------------------
// Preconditions
// ---------------------------------------------------------------------------

/// `requirePendingRebase(cwd)`.
fn require_pending(cwd: &str) -> GitResult<Object> {
  match read_state(cwd)? {
    Some(Value::Object(operation)) => Ok(operation),
    _ => Err(GitError::new(
      "no-operation-pending",
      "No causal rebase is in progress in this worktree.",
    )),
  }
}

/// `currentBranch(cwd)`: the branch's ref and its name.
fn current_branch(cwd: &str) -> GitResult<(String, String)> {
  match engine::symbolic_ref("HEAD", cwd, false)? {
    Some(reference) if reference.starts_with("refs/heads/") => {
      let name = reference["refs/heads/".len()..].to_string();
      Ok((reference, name))
    }
    _ => Err(GitError::new(
      "precondition-not-met",
      "Causal rebase requires a named local branch.",
    )),
  }
}

/// `requireOperationBranch(operation, cwd)`.
fn require_operation_branch(operation: &Object, cwd: &str) -> GitResult<()> {
  let (reference, name) = current_branch(cwd)?;
  if strict_equals(Some(&string(&reference)), operation.get("sourceBranchRef")) {
    return Ok(());
  }
  let source = js_text(operation.get("sourceRef"));
  Err(
    GitError::new(
      "out-of-band-change",
      format!("The rebase journal belongs to branch '{source}', not '{name}'."),
    )
    .details(format!(
      "Switch back to '{source}' before status recovery, continue, or abort."
    )),
  )
}

/// `assertNoGitReplay(cwd)`.
fn assert_no_git_replay(cwd: &str) -> GitResult<()> {
  let mut active = Vec::new();
  for name in ["CHERRY_PICK_HEAD", "REVERT_HEAD", "MERGE_HEAD", "REBASE_HEAD"] {
    if engine::revision_resolves(name, cwd)? {
      active.push(name.to_string());
    }
  }
  for name in ["rebase-merge", "rebase-apply", "sequencer"] {
    let location = engine::git_path(name, cwd)?;
    if std::path::Path::new(&text::resolve(cwd, &location)).exists() {
      let base = location.trim_end_matches(['/', '\\']);
      active.push(base.rsplit(['/', '\\']).next().unwrap_or(base).to_string());
    }
  }
  if active.is_empty() {
    return Ok(());
  }
  Err(GitError::new(
    "git-operation-active",
    format!("Git already has an active replay operation ({}).", active.join(", ")),
  ))
}

// ---------------------------------------------------------------------------
// Forecast approval
// ---------------------------------------------------------------------------

/// `markMismatch(operation, message, cwd, details)`: the journal marked, and
/// the refusal to raise.
fn mark_mismatch(operation: &mut Object, message: String, cwd: &str, details: Option<String>) -> GitError {
  operation.set("state", string("forecast-mismatch"));
  if let Err(error) = write_state(operation, cwd) {
    return error;
  }
  GitError::new("stale-forecast", message).details(
    details.unwrap_or_else(|| "Run 'cst rebase --abort', then generate and review a new forecast.".to_string()),
  )
}

/// `expectedForecastStep(operation, change, cwd)`.
fn expected_forecast_step(operation: &mut Object, change: &Value, cwd: &str) -> GitResult<Option<Value>> {
  let approval = operation.get("forecastApproval");
  if !truthy(approval) {
    return Ok(None);
  }
  let index = match operation.get("executedCount") {
    value if nullish(value) => number(operation.get("nextIndex")),
    value => number(value),
  };
  let step = items(get(approval, "steps")).get(index as usize).cloned();
  match step {
    Some(step)
      if truthy(Some(&step)) && strict_equals(get(Some(&step), "sourceCommit"), get(Some(change), "commit")) =>
    {
      Ok(Some(step))
    }
    _ => {
      let message = format!(
        "Rebase forecast '{}' has a different replay queue.",
        js_text(operation.get("forecastId"))
      );
      Err(mark_mismatch(operation, message, cwd, None))
    }
  }
}

/// `validateForecastBefore(operation, change, targetBeforeTree, cwd)`.
fn validate_forecast_before(
  operation: &mut Object,
  change: &Value,
  target_before_tree: &str,
  cwd: &str,
) -> GitResult<Option<Value>> {
  let step = expected_forecast_step(operation, change, cwd)?;
  if let Some(step) = &step {
    let forecast_tree = get(Some(step), "targetBeforeTree");
    if !strict_equals(forecast_tree, Some(&string(target_before_tree))) {
      let message = format!(
        "Rebase forecast '{}' no longer matches the target-before tree.",
        js_text(operation.get("forecastId"))
      );
      let details = [
        format!("Forecast tree: {}", js_text(forecast_tree)),
        format!("Actual tree:   {target_before_tree}"),
        "Abort and generate a new forecast.".to_string(),
      ]
      .join("\n");
      return Err(mark_mismatch(operation, message, cwd, Some(details)));
    }
  }
  Ok(step)
}

/// `validateForecastAfter(operation, change, resultTree, outcome, cwd)`.
fn validate_forecast_after(
  operation: &mut Object,
  change: &Value,
  result_tree: &str,
  outcome: &str,
  cwd: &str,
) -> GitResult<()> {
  let Some(step) = expected_forecast_step(operation, change, cwd)? else {
    return Ok(());
  };
  let forecast_tree = get(Some(&step), "resultTree");
  let forecast_outcome = get(Some(&step), "outcome");
  if strict_equals(forecast_tree, Some(&string(result_tree)))
    && strict_equals(forecast_outcome, Some(&string(outcome)))
  {
    return Ok(());
  }
  let message = format!(
    "Rebase step for {} does not match forecast '{}'.",
    js_text(get(Some(change), "shortCommit")),
    js_text(operation.get("forecastId"))
  );
  let details = [
    format!(
      "Forecast outcome/tree: {} {}",
      js_text(forecast_outcome),
      if nullish(forecast_tree) { "-".to_string() } else { js_text(forecast_tree) }
    ),
    format!("Actual outcome/tree:   {outcome} {result_tree}"),
    "Abort and generate a new forecast.".to_string(),
  ]
  .join("\n");
  Err(mark_mismatch(operation, message, cwd, Some(details)))
}

fn stale(message: String) -> GitError {
  GitError::new("stale-forecast", message)
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
    return Err(stale(format!(
      "Rebase forecast '{forecast_id}' no longer matches the current conflicts."
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
        return Err(stale(format!(
          "Rebase forecast '{forecast_id}' no longer matches '{}'.",
          js_text(field("path"))
        )));
      }
    }
  }
  Ok(Some(choices))
}

/// `forecastSpecMergeChoices(operation, change, cwd)`.
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
    return Err(stale(format!(
      "Rebase forecast '{forecast_id}' no longer matches the semantic spec conflicts."
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
        return Err(stale(format!(
          "Rebase forecast '{forecast_id}' no longer matches '{}'.",
          js_text(field("path"))
        )));
      }
    }
  }
  Ok(choices)
}

// ---------------------------------------------------------------------------
// Recording a step
// ---------------------------------------------------------------------------

/// `anchorRoot()`: where a merge-preserving rebase anchors its rewritten
/// commits. Anchors are transient, so they are only ever under the current
/// names (ADR-0039 §1).
fn anchor_root() -> String {
  format!("{}/rebase", CURRENT_NAMES.refs_root)
}

fn merge_preserving(operation: &Object) -> bool {
  as_text(get(operation.get("plan"), "mode")).as_deref() == Some("merge-preserving")
}

/// `anchorRewritten(operation, originCommit, newCommit, cwd)`: the mapping
/// recorded, and in a merge-preserving rewrite the new commit named by a ref
/// of this operation's own.
fn anchor_rewritten(operation: &mut Object, origin: &str, commit: &str, cwd: &str) -> GitResult<()> {
  let mut rewritten = match operation.get("rewritten") {
    Some(Value::Object(rewritten)) => rewritten.clone(),
    _ => Object::new(),
  };
  rewritten.set(origin, string(commit));
  operation.set("rewritten", Value::Object(rewritten));
  if !merge_preserving(operation) {
    return Ok(());
  }
  let name = format!("{}/{}/{origin}", anchor_root(), js_text(operation.get("id")));
  git(&["update-ref", &name, commit], cwd)?;
  Ok(())
}

/// `releaseAnchors(operation, cwd)`.
fn release_anchors(operation: &Object, cwd: &str) -> GitResult<()> {
  if !merge_preserving(operation) {
    return Ok(());
  }
  if let Some(Value::Object(rewritten)) = operation.get("rewritten") {
    for origin in rewritten.keys() {
      let name = format!(
        "{}/{}/{}",
        anchor_root(),
        js_text(operation.get("id")),
        lossy(origin)
      );
      git_allowing_failure(&["update-ref", "-d", &name], cwd)?;
    }
  }
  Ok(())
}

/// `rewrittenMap(operation)`.
fn rewritten_map(operation: &Object) -> HashMap<String, String> {
  match operation.get("rewritten") {
    Some(Value::Object(rewritten)) => rewritten
      .keys()
      .into_iter()
      .filter_map(|origin| {
        let commit = as_text(rewritten.get_units(origin))?;
        Some((lossy(origin), commit))
      })
      .collect(),
    _ => HashMap::new(),
  }
}

/// `absorptionOutcome(operation)`: the absorption an application record
/// carries, once it has finished.
fn absorption_outcome(operation: &Object) -> Object {
  let absorption = get(operation.get("current"), "absorption");
  let column = |name: &str| {
    Value::Array(
      items(get(absorption, "items"))
        .iter()
        .map(|item| get(Some(item), name).cloned().unwrap_or(Value::Null))
        .collect(),
    )
  };
  let mut outcome = Object::new();
  copy(&mut outcome, "action", get(absorption, "action"));
  outcome.set("absorbedCommits", column("commit"));
  outcome.set("absorbedChanges", column("changeId"));
  copy(&mut outcome, "resolutions", get(absorption, "resolutions"));
  outcome
}

/// The journal moved past the step that just ran.
fn advance(operation: &mut Object, cwd: &str) -> GitResult<()> {
  let next = number(operation.get("nextIndex"));
  operation.set("nextIndex", Value::Number(next + 1.0));
  let executed = match operation.get("executedCount") {
    value if nullish(value) => 0.0,
    value => number(value),
  };
  operation.set("executedCount", Value::Number(executed + 1.0));
  operation.set("current", Value::Null);
  operation.set("state", string("running"));
  fault_point("rebase:before-journal-advance");
  write_state(operation, cwd)
}

/// `applicationRecord(...)` and `recordSuccessfulApplication(operation,
/// relation, cwd)`: the step HEAD now holds, recorded on the journal with the
/// identities it absorbed, which then moves on to the next step.
fn record_successful_application(operation: &mut Object, relation: &str, cwd: &str) -> GitResult<()> {
  let (_, change) = queued(operation);
  let commit = js_text(get(Some(&change), "commit"));
  let ids = engine::resolve_object_ids(
    &[
      "HEAD^{commit}".to_string(),
      format!("{commit}^{{tree}}"),
      "HEAD^{tree}".to_string(),
    ],
    cwd,
  )?;
  let id = |index: usize| ids.get(index).cloned().unwrap_or_default();
  let applied_commit = id(0);
  let actual_change_id = engine::change_id_for_commit(&applied_commit, cwd)?;
  let change_id = js_text(get(Some(&change), "changeId"));
  if relation != "contextual-fork" && !change_id.starts_with("git:") && actual_change_id != change_id {
    operation.set("state", string("identity-mismatch"));
    write_state(operation, cwd)?;
    return Err(
      GitError::new(
        "identity-not-preserved",
        format!("Rebased commit '{applied_commit}' did not preserve Change-Id '{change_id}'."),
      )
      .details("Abort the rebase; no shared receipts were published."),
    );
  }
  let current = operation.get("current");
  let mut application = Object::new();
  application.set("schema", string("causet.rebase-application/v1"));
  application.set("type", string("rebase-application"));
  application.set("id", string(&new_id("rebase_apply")));
  copy(&mut application, "rebaseOperation", operation.get("id"));
  application.set("forecastId", or_null(operation.get("forecastId")));
  copy(&mut application, "originCommit", get(Some(&change), "commit"));
  copy(&mut application, "originChangeId", get(Some(&change), "changeId"));
  application.set("appliedCommit", string(&applied_commit));
  application.set("appliedChangeId", string(&actual_change_id));
  copy(&mut application, "targetBefore", get(current, "targetBefore"));
  copy(&mut application, "targetBeforeTree", get(current, "targetBeforeTree"));
  application.set("sourceTree", string(&id(1)));
  application.set("resultTree", string(&id(2)));
  application.set("relation", string(relation));
  application.set("conflictedPaths", or_empty(get(current, "conflictedPaths")));
  application.set("resolutions", or_empty(get(current, "resolutionOutcomes")));
  application.set("semanticMerges", or_empty(get(current, "semanticMerges")));
  application.set("createdAt", string(&iso_now()));

  if truthy(get(current, "absorption")) {
    let outcome = absorption_outcome(operation);
    let mut absorption = Object::new();
    absorption.set("schema", string("causet.interactive-absorption/v1"));
    absorption.set("type", string("interactive-absorption"));
    absorption.set("id", string(&new_id("absorb")));
    copy(&mut absorption, "action", outcome.get("action"));
    absorption.set("survivingCommit", string(&applied_commit));
    absorption.set("survivingChangeId", string(&actual_change_id));
    copy(&mut absorption, "absorbedCommits", outcome.get("absorbedCommits"));
    copy(&mut absorption, "absorbedChanges", outcome.get("absorbedChanges"));
    copy(&mut absorption, "rebaseOperation", operation.get("id"));
    absorption.set("createdAt", string(&iso_now()));
    let mut absorptions = items(operation.get("absorptions"));
    absorptions.push(Value::Object(absorption));
    operation.set("absorptions", Value::Array(absorptions));
    // A resolution decided or reused while absorbing is an ordinary
    // resolution, so it travels with the application that carries it.
    let mut resolutions = items(application.get("resolutions"));
    resolutions.extend(items(outcome.get("resolutions")));
    application.set("resolutions", Value::Array(resolutions));
  }
  let mut applied = items(operation.get("applied"));
  applied.push(Value::Object(application));
  operation.set("applied", Value::Array(applied));
  anchor_rewritten(operation, &commit, &applied_commit, cwd)?;
  advance(operation, cwd)
}

/// A recreated merge's parents as the journal names them:
/// `{ commit, replaces, source }`.
fn merge_parents(parents: &[Parent]) -> Value {
  Value::Array(
    parents
      .iter()
      .map(|parent| {
        let mut entry = Object::new();
        entry.set("commit", string(&parent.commit));
        entry.set("replaces", parent.origin.clone());
        entry.set("source", parent.source.clone());
        Value::Object(entry)
      })
      .collect(),
  )
}

/// `recordRecreatedMerge(operation, change, parents, cleanJoin, cwd)`: one
/// recreated merge journaled. It is not an application and never becomes
/// one: it records what was joined, and is concluded from by nothing
/// (ADR-0034).
fn record_recreated_merge(
  operation: &mut Object,
  change: &Value,
  parents: Value,
  clean_join: bool,
  cwd: &str,
) -> GitResult<()> {
  let result_commit = engine::resolve_object_ids(&["HEAD^{commit}".to_string()], cwd)?
    .into_iter()
    .next()
    .unwrap_or_default();
  let current = operation.get("current");
  let mut entry = Object::new();
  copy(&mut entry, "originCommit", get(Some(change), "commit"));
  copy(&mut entry, "originChangeId", get(Some(change), "changeId"));
  entry.set("resultCommit", string(&result_commit));
  copy(&mut entry, "changeId", get(current, "mergeChangeId"));
  entry.set("cleanJoin", Value::Bool(clean_join));
  entry.set("parents", parents);
  entry.set("resolutions", or_empty(get(current, "resolutionOutcomes")));
  entry.set("semanticMerges", or_empty(get(current, "semanticMerges")));
  entry.set("conflictedPaths", or_empty(get(current, "conflictedPaths")));
  entry.set("relation", string("recreated-merge"));
  entry.set("createdAt", string(&iso_now()));
  let mut merges = items(operation.get("recreatedMerges"));
  merges.push(Value::Object(entry));
  operation.set("recreatedMerges", Value::Array(merges));
  anchor_rewritten(operation, &js_text(get(Some(change), "commit")), &result_commit, cwd)?;
  advance(operation, cwd)
}

/// `commitRecreatedMerge(operation, change, cwd)`: the staged join committed
/// under the identity the journal already minted.
fn commit_recreated_merge(operation: &Object, change: &Value, cwd: &str) -> GitResult<()> {
  let path = text::join(&engine::repo_context(cwd)?.git_dir, "MERGE_MSG");
  let message = recreated_merge_message(
    get(Some(change), "subject"),
    &js_text(get(operation.get("current"), "mergeChangeId")),
    get(Some(change), "changeId"),
    &js_text(get(Some(change), "commit")),
  );
  std::fs::write(&path, message).map_err(|error| crate::envelope::io_failure(&error, "open", &path))?;
  let committed = git_allowing_failure(&["-c", "core.editor=true", "commit", "--no-edit"], cwd)?;
  if committed.ok {
    return Ok(());
  }
  Err(GitError::new("conflict-blocked", "Git could not commit the recreated merge.").details(committed.output))
}

/// The journaled `mergeParents` of the paused join.
fn journaled_merge_parents(operation: &Object) -> Value {
  Value::Array(
    items(get(operation.get("current"), "mergeParents"))
      .iter()
      .map(|parent| {
        let mut entry = Object::new();
        for name in ["commit", "replaces", "source"] {
          copy(&mut entry, name, get(Some(parent), name));
        }
        Value::Object(entry)
      })
      .collect(),
  )
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
    semantic_merges.push(compact_spec_merge(plan, string("rebase-forecast-batch")));
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
  let chosen = choices.unwrap_or_default();
  for (index, candidate) in &chosen {
    let mut conflicts = items(get(operation.get("current"), "conflicts"));
    materialize_resolution_candidate(conflicts.get(*index), Some(candidate), cwd)?;
    if let Some(Value::Object(conflict)) = conflicts.get_mut(*index) {
      copy(conflict, "selectedResolutionId", get(Some(candidate), "id"));
      conflict.set("decisionOverride", Value::Null);
      conflict.set("selectionMethod", string("rebase-forecast-batch"));
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
  let recreating = as_text(get(operation.get("current"), "kind")).as_deref() == Some("recreate-merge");
  // A resolved pick is finished by the sequencer; a resolved join is an
  // ordinary commit of a staged index, because nothing is sequencing it.
  if recreating {
    commit_recreated_merge(operation, change, cwd)?;
  } else {
    let mut finish = GIT_NO_RERERE.to_vec();
    finish.extend(["-c", "core.editor=true", "cherry-pick", "--continue"]);
    let continued = git_allowing_failure(&finish, cwd)?;
    if !continued.ok {
      return Err(
        GitError::new(
          "conflict-blocked",
          "Git could not apply the forecasted rebase resolutions.",
        )
        .details(continued.output),
      );
    }
  }
  let result_tree = engine::tree_id("HEAD", cwd)?;
  let outcome = match (semantic_merges.is_empty(), chosen.is_empty()) {
    (false, false) => "semantic-spec-and-exact-resolution",
    (false, true) => "semantic-spec-merge",
    _ => "exact-resolution",
  };
  validate_forecast_after(operation, change, &result_tree, outcome, cwd)?;
  if recreating {
    let parents = journaled_merge_parents(operation);
    record_recreated_merge(operation, change, parents, false, cwd)?;
  } else {
    record_successful_application(operation, "contextual-rebase", cwd)?;
  }
  Ok(true)
}

// ---------------------------------------------------------------------------
// Interactive steps
// ---------------------------------------------------------------------------

/// The candidates line of a paused step's details.
fn candidates_line(conflicts: &[Value]) -> String {
  let candidates: usize = conflicts
    .iter()
    .map(|conflict| items(get(Some(conflict), "candidates")).len())
    .sum();
  if candidates == 0 {
    "No exact prior resolution was found.".to_string()
  } else {
    format!(
      "{candidates} exact prior resolution candidate{} found. Run 'cst resolve status'.",
      if candidates == 1 { "" } else { "s" }
    )
  }
}

/// `absorbOutstanding(operation, cwd)`: the absorbed changes still outstanding
/// melded into the commit at HEAD. The journal carries the cursor, so a pause
/// in the middle resumes at the change that stopped. An absorbed change gets
/// the two chances a pick gets: an exact prior resolution settles it, and
/// anything else pauses for a person (ADR-0007, ADR-0035).
fn absorb_outstanding(operation: &mut Object, cwd: &str) -> GitResult<()> {
  loop {
    let absorption = get(operation.get("current"), "absorption").cloned();
    let absorption = absorption.as_ref();
    let cursor = number(get(absorption, "nextIndex"));
    let Some(item) = items(get(absorption, "items")).get(cursor as usize).cloned() else {
      break;
    };
    let commit = js_text(get(Some(&item), "commit"));
    let mut pick = GIT_NO_RERERE.to_vec();
    pick.extend(["cherry-pick", "--no-commit", &commit]);
    let applied = git_allowing_failure(&pick, cwd)?;
    if !applied.ok {
      let paths = engine::unmerged_paths(cwd)?;
      if paths.is_empty() {
        // No conflicted path means Git could not apply it at all, which no
        // resolution can settle.
        git_allowing_failure(&["cherry-pick", "--abort"], cwd)?;
        operation.set("state", string("blocked"));
        write_state(operation, cwd)?;
        return Err(
          GitError::new(
            "conflict-blocked",
            format!("Absorbing {} failed without a conflicted path.", twelve(&commit)),
          )
          .details(joined(&[&applied.output, "Run 'cst rebase --abort'."])),
        );
      }
      let mut conflicts = capture_conflict_descriptors(&paths, cwd)?;
      let exact = conflicts
        .iter()
        .all(|conflict| items(get(Some(conflict), "candidates")).len() == 1);
      if !exact {
        let recorded = Value::Array(conflicts.clone());
        edit_absorption(operation, |absorption| {
          absorption.set("conflicts", recorded.clone());
          absorption.set("conflictedPaths", strings(&paths));
          absorption.set("conflictedCommit", string(&commit));
        });
        operation.set("state", string("awaiting-absorption"));
        edit_current(operation, |current| {
          current.set("conflicts", recorded);
          current.set("conflictedPaths", strings(&paths));
        });
        write_state(operation, cwd)?;
        let surviving = js_text(get(operation.get("current"), "sourceCommit"));
        return Err(
          GitError::new(
            "conflict-paused",
            format!(
              "Causal rebase paused absorbing {} into {}.",
              twelve(&commit),
              twelve(&surviving)
            ),
          )
          .details(joined(&[
            &applied.output,
            &format!("Conflicted paths: {}", paths.join(", ")),
            &candidates_line(&conflicts),
            "Resolve and stage the files, then run 'cst rebase --continue'.",
            "The surviving commit keeps its own identity either way; 'cst rebase --abort' restores the original tip.",
          ])),
        );
      }
      for conflict in &mut conflicts {
        let candidate = items(get(Some(conflict), "candidates")).into_iter().next();
        materialize_resolution_candidate(Some(conflict), candidate.as_ref(), cwd)?;
        if let Value::Object(conflict) = conflict {
          copy(conflict, "selectedResolutionId", get(candidate.as_ref(), "id"));
          conflict.set("decisionOverride", Value::Null);
          conflict.set("selectionMethod", string("absorption-exact-reuse"));
          conflict.set("suggestionAppliedAt", string(&iso_now()));
        }
      }
      let outcomes = capture_resolution_outcomes(&conflicts, cwd)?;
      edit_absorption(operation, |absorption| {
        let mut resolutions = items(absorption.get("resolutions"));
        resolutions.extend(outcomes);
        absorption.set("resolutions", Value::Array(resolutions));
      });
    }
    edit_absorption(operation, |absorption| {
      let next = number(absorption.get("nextIndex"));
      absorption.set("nextIndex", Value::Number(next + 1.0));
    });
    write_state(operation, cwd)?;
  }

  let message = js_text(get(get(operation.get("current"), "absorption"), "message"));
  let amended = git_allowing_failure(&["-c", "core.editor=true", "commit", "--amend", "-m", &message], cwd)?;
  if !amended.ok {
    return Err(
      GitError::new(
        "conflict-blocked",
        "Git could not fold the absorbed changes into the surviving commit.",
      )
      .details(amended.output),
    );
  }
  edit_current(operation, |current| {
    current.set("conflicts", Value::Array(Vec::new()));
    current.set("conflictedPaths", Value::Array(Vec::new()));
  });
  Ok(())
}

/// `applyAbsorption(operation, item, change, cwd)`: the absorbed changes a
/// surviving step carries, under the one message that survives them. The
/// message is composed up front, so the identity check runs before any
/// content moves (ADR-0035).
fn apply_absorption(operation: &mut Object, item: &Value, change: &Value, cwd: &str) -> GitResult<()> {
  let absorbs = items(get(Some(item), "absorbs"));
  if absorbs.is_empty() {
    return Ok(());
  }
  let surviving = engine::commit_message("HEAD", cwd)?;
  let mut absorbed = Vec::new();
  for entry in &absorbs {
    absorbed.push((
      js_text(get(Some(entry), "action")),
      engine::commit_message(&js_text(get(Some(entry), "commit")), cwd)?,
    ));
  }
  let change_id = js_text(get(Some(change), "changeId"));
  let message = absorbed_message(&surviving, &absorbed, &change_id);
  assert_single_identity(&message, &change_id)?;
  let mut absorption = Object::new();
  copy(&mut absorption, "action", get(absorbs.first(), "action"));
  absorption.set("message", string(&message));
  absorption.set(
    "items",
    Value::Array(
      absorbs
        .iter()
        .map(|entry| {
          let mut item = Object::new();
          copy(&mut item, "commit", get(Some(entry), "commit"));
          item.set("changeId", absorbed_change_id(entry));
          copy(&mut item, "action", get(Some(entry), "action"));
          Value::Object(item)
        })
        .collect(),
    ),
  );
  absorption.set("nextIndex", Value::Number(0.0));
  absorption.set("resolutions", Value::Array(Vec::new()));
  edit_current(operation, |current| current.set("absorption", Value::Object(absorption)));
  write_state(operation, cwd)?;
  absorb_outstanding(operation, cwd)
}

/// `interactivePause(operation, change, waiting, cwd)`: the journal marked as
/// waiting on the caller, and the refusal that says so. A pause is not a
/// failure, but it must not look like completion to a script (ADR-0021).
fn interactive_pause(operation: &mut Object, change: &Value, waiting: &str, cwd: &str) -> GitError {
  operation.set("state", string(waiting));
  if let Err(error) = write_state(operation, cwd) {
    return error;
  }
  let for_message = waiting == "awaiting-message";
  GitError::new(
    "interactive-paused",
    format!(
      "Causal rebase paused at {} for {}.",
      short_or_commit(change),
      if for_message { "a message" } else { "content" }
    ),
  )
  .details(
    [
      if for_message {
        "Supply the new message with: cst rebase --continue -m \"<message>\""
      } else {
        "Change the files, stage them, then run: cst rebase --continue"
      },
      "The identity is kept either way; run 'cst rebase --abort' to restore the original tip.",
    ]
    .join("\n"),
  )
}

/// `finishSurvivingStep(operation, cwd)`: the surviving step recorded once its
/// absorption is complete. A `reword` or an `edit` pauses after absorption,
/// so the caller is shown the commit they are about to describe or amend.
fn finish_surviving_step(operation: &mut Object, cwd: &str) -> GitResult<()> {
  let (item, change) = queued(operation);
  let action = as_text(get(Some(&item), "action"));
  if matches!(action.as_deref(), Some("reword" | "edit")) {
    let tree = engine::tree_id("HEAD", cwd)?;
    edit_current(operation, |current| current.set("treeBeforeEdit", string(&tree)));
    let waiting = if action.as_deref() == Some("reword") { "awaiting-message" } else { "awaiting-content" };
    return Err(interactive_pause(operation, &change, waiting, cwd));
  }
  let result_tree = engine::tree_id("HEAD", cwd)?;
  validate_forecast_after(operation, &change, &result_tree, "clean", cwd)?;
  record_successful_application(operation, "causal-rebase", cwd)
}

/// `conflictError(operation, result)`: the refusal a paused step answers.
fn conflict_error(operation: &Object, output: &str) -> GitError {
  let (_, change) = queued(operation);
  let current = operation.get("current");
  let paths: Vec<String> = items(get(current, "conflictedPaths"))
    .iter()
    .map(|path| js_text(Some(path)))
    .collect();
  let short_commit = js_text(get(Some(&change), "shortCommit"));
  if paths.is_empty() {
    let reported = if output.is_empty() { String::new() } else { format!("Git reported:\n{output}") };
    return GitError::new(
      "conflict-blocked",
      format!("Causal rebase blocked while applying {short_commit}."),
    )
    .details(joined(&[
      "No change was silently skipped. Run 'cst rebase --abort'.",
      "Git did not report conflict paths; the replay may have become unexpectedly empty.",
      &reported,
    ]));
  }
  GitError::new(
    "conflict-paused",
    format!("Causal rebase paused while applying {short_commit}."),
  )
  .details(
    [
      output,
      &format!("Conflicted paths: {}", paths.join(", ")),
      &candidates_line(&items(get(current, "conflicts"))),
      "Resolve and stage the files, then run 'cst rebase --continue'.",
      "Run 'cst rebase --abort' to restore the original branch tip.",
    ]
    .join("\n"),
  )
}

// ---------------------------------------------------------------------------
// Applying the queue
// ---------------------------------------------------------------------------

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
  accumulate_git_metrics(operation, &metrics::end(collector), true)?;
  if persist {
    write_state(operation, cwd)?;
  }
  Ok(())
}

/// The loop of `runRebaseQueue`: each step of the program run onto the parent
/// it names, until the program is done or a step pauses.
fn apply_queue(operation: &mut Object, phase: &mut Phase, cwd: &str) -> GitResult<()> {
  loop {
    let queue = items(operation.get("queue"));
    if number(operation.get("nextIndex")) as usize >= queue.len() {
      return Ok(());
    }
    let (item, change) = queued(operation);
    let commit = js_text(get(Some(&change), "commit"));
    let kind = as_text(get(Some(&item), "kind"));
    let recreating = kind.as_deref() == Some("recreate-merge");
    let parents = match get(Some(&item), "step").filter(|step| truthy(Some(step))) {
      Some(step) => Some(resolve_step_parents(
        step,
        &js_text(operation.get("ontoHead")),
        &rewritten_map(operation),
      )?),
      None => None,
    };
    let parent = |index: usize| {
      parents
        .as_ref()
        .and_then(|parents| parents.get(index))
        .map(|parent| parent.commit.clone())
        .unwrap_or_default()
    };
    if kind.as_deref() == Some("omit") {
      // The commit collapses out of the rewritten line. Nothing runs and
      // nothing is recorded but the mapping, which a later merge may need.
      anchor_rewritten(operation, &commit, &parent(0), cwd)?;
      let next = number(operation.get("nextIndex"));
      operation.set("nextIndex", Value::Number(next + 1.0));
      write_state(operation, cwd)?;
      continue;
    }
    // A program with merges jumps between lines, so a step states the parent
    // it applies onto rather than inheriting wherever the last one ended.
    if parents.is_some() && engine::current_head(cwd)? != parent(0) {
      operation.set("state", string("positioning"));
      write_state(operation, cwd)?;
      git(&["reset", "--hard", &parent(0)], cwd)?;
    }
    let target_before = engine::current_head(cwd)?;
    let target_before_tree = engine::tree_id(&target_before, cwd)?;
    operation.set("state", string("applying"));
    let mut current = Object::new();
    copy(&mut current, "sourceCommit", get(Some(&change), "commit"));
    copy(&mut current, "sourceChangeId", get(Some(&change), "changeId"));
    current.set("targetBefore", string(&target_before));
    current.set("targetBeforeTree", string(&target_before_tree));
    current.set("conflictedPaths", Value::Array(Vec::new()));
    copy(&mut current, "kind", get(Some(&item), "kind"));
    if recreating {
      // Minted and journaled before the commit exists, so an interruption
      // between the two cannot produce a second identity for the same join.
      current.set("mergeChangeId", string(&new_id("ch")));
      current.set("mergeParents", merge_parents(parents.as_deref().unwrap_or(&[])));
    }
    current.set("startedAt", string(&iso_now()));
    operation.set("current", Value::Object(current));
    write_state(operation, cwd)?;
    let expected = validate_forecast_before(operation, &change, &target_before_tree, cwd)?;

    let second = parent(1);
    let mut apply = GIT_NO_RERERE.to_vec();
    if recreating {
      apply.extend(["merge", "--no-ff", "--no-commit", &second]);
    } else {
      apply.extend(["cherry-pick", "-x", &commit]);
    }
    let result = git_allowing_failure(&apply, cwd)?;
    // Both parents became the same line, so the join joins nothing. The
    // operator decides; the machinery does not drop it (ADR-0034).
    if recreating
      && result.ok
      && !engine::pseudo_ref_target("MERGE_HEAD", cwd)?.is_some_and(|head| !head.is_empty())
    {
      operation.set("state", string("blocked"));
      finish_phase(operation, phase, false, cwd)?;
      write_state(operation, cwd)?;
      return Err(
        GitError::new(
          "conflict-blocked",
          format!(
            "Recreating the merge {} would produce no join.",
            short_or_commit(&change)
          ),
        )
        .details(
          [
            format!("Both parents resolved to the same line ({}).", twelve(&parent(0))),
            "Nothing was dropped. Run 'cst rebase --abort'.".to_string(),
          ]
          .join("\n"),
        ),
      );
    }
    if result.ok {
      if recreating {
        commit_recreated_merge(operation, &change, cwd)?;
        let result_tree = engine::tree_id("HEAD", cwd)?;
        validate_forecast_after(operation, &change, &result_tree, "clean", cwd)?;
        let joined = merge_parents(parents.as_deref().unwrap_or(&[]));
        record_recreated_merge(operation, &change, joined, true, cwd)?;
        continue;
      }
      // Absorption first, then whatever the step's own action asks for. Both
      // interactive pauses happen after the work is in the worktree.
      let finished = apply_absorption(operation, &item, &change, cwd)
        .and_then(|()| finish_surviving_step(operation, cwd));
      if let Err(error) = finished {
        finish_phase(operation, phase, false, cwd)?;
        return Err(error);
      }
      continue;
    }

    let paths = engine::unmerged_paths(cwd)?;
    edit_current(operation, |current| current.set("conflictedPaths", strings(&paths)));
    let conflicts = capture_conflict_descriptors(&paths, cwd)?;
    edit_current(operation, |current| {
      current.set("conflicts", Value::Array(conflicts));
      current.set("gitOutput", string(&result.output));
    });
    operation.set("state", string(if paths.is_empty() { "blocked" } else { "conflicted" }));
    let short_commit = js_text(get(Some(&change), "shortCommit"));
    let forecast_id = js_text(operation.get("forecastId"));
    if !paths.is_empty() {
      match apply_forecast_resolutions(operation, &change, cwd) {
        Ok(true) => continue,
        Ok(false) => {}
        Err(error) => {
          if expected.is_some() {
            return Err(mark_mismatch(
              operation,
              format!("Rebase step for {short_commit} no longer matches forecast '{forecast_id}'."),
              cwd,
              Some(joined(&[
                &error.message,
                &error.details,
                "Abort and generate a new forecast.",
              ])),
            ));
          }
          return Err(error);
        }
      }
    }
    if expected.is_some() {
      return Err(mark_mismatch(
        operation,
        format!("Rebase step for {short_commit} did not reproduce forecast '{forecast_id}'."),
        cwd,
        Some(joined(&[&result.output, "Abort and generate a new forecast."])),
      ));
    }
    finish_phase(operation, phase, false, cwd)?;
    write_state(operation, cwd)?;
    return Err(conflict_error(operation, &result.output));
  }
}

/// `runRebaseQueue(operation, cwd, phaseStarted)`.
fn run_queue(operation: &mut Object, cwd: &str, phase_started: Instant) -> GitResult<Value> {
  let mut phase: Phase = Some((phase_started, metrics::begin("rebase-application")));
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

/// The named members of each item, in the order given.
fn projected(list: Option<&Value>, members: &[(&str, &str)]) -> Value {
  Value::Array(
    items(list)
      .iter()
      .map(|item| {
        let mut object = Object::new();
        for (name, from) in members {
          copy(&mut object, name, get(Some(item), from));
        }
        Value::Object(object)
      })
      .collect(),
  )
}

/// `finalizeRebase(operation, cwd)`: the result checked against its forecast,
/// the overlay put back, and the applications, their retained resolutions,
/// the amendments, the absorptions and the receipt published.
fn finalize(operation: &mut Object, cwd: &str) -> GitResult<Value> {
  let ids = engine::resolve_object_ids(&owned(&["HEAD^{commit}", "HEAD^{tree}"]), cwd)?;
  let result_commit = ids.first().cloned().unwrap_or_default();
  let result_tree = ids.get(1).cloned().unwrap_or_default();
  let forecast_id = js_text(operation.get("forecastId"));
  let approval = operation.get("forecastApproval").cloned();
  let predicted_tree = get(approval.as_ref(), "predictedResultTree");
  if truthy(predicted_tree) && !strict_equals(predicted_tree, Some(&string(&result_tree))) {
    let details = [
      format!("Forecast tree: {}", js_text(predicted_tree)),
      format!("Actual tree:   {result_tree}"),
      "Abort and generate a new forecast.".to_string(),
    ]
    .join("\n");
    return Err(mark_mismatch(
      operation,
      format!("Rebase result does not match forecast '{forecast_id}'."),
      cwd,
      Some(details),
    ));
  }
  let plan = operation.get("plan").cloned();
  let plan = plan.as_ref();

  // The overlay goes back only after the committed result has verified, and
  // its own prediction is checked before anything is published. The base of
  // the merge is the tree the source branch held before the rebase started;
  // `ours` is the rewritten tip.
  let mut overlay_result = Value::Null;
  if let Some(overlay) = operation.get("targetOverlay").filter(|overlay| truthy(Some(overlay))).cloned() {
    let restored = materialize_overlay(&overlay, &js_text(get(plan, "sourceTree")), &result_tree, cwd)?;
    if let Some(conflict) = get(Some(&restored), "conflict").filter(|conflict| truthy(Some(conflict))) {
      let details = [
        js_text(get(Some(conflict), "details")),
        "Nothing was published. Run 'cst rebase --abort' and forecast again.".to_string(),
      ]
      .join("\n");
      return Err(mark_mismatch(
        operation,
        "The caller overlay no longer merges with the rewritten branch.".to_string(),
        cwd,
        Some(details),
      ));
    }
    let actual = get(Some(&restored), "tree").cloned().unwrap_or(Value::Null);
    // The merged draft is on disk from here on, so the worktree is dirty by
    // this operation's own doing. Journaled before the prediction is compared,
    // so an abort can tell that dirt apart from the user's own (ADR-0028).
    operation.set("overlayRematerialized", Value::Bool(true));
    write_state(operation, cwd)?;
    let predicted = or_null(get(approval.as_ref(), "predictedOverlayTree"));
    if truthy(Some(&predicted)) && !strict_equals(Some(&predicted), Some(&actual)) {
      let details = [
        format!("Forecast overlay tree: {}", js_text(Some(&predicted))),
        format!("Actual overlay tree:   {}", js_text(Some(&actual))),
        "Nothing was published. Run 'cst rebase --abort' and forecast again.".to_string(),
      ]
      .join("\n");
      return Err(mark_mismatch(
        operation,
        format!("Re-materializing the caller overlay did not match forecast '{forecast_id}'."),
        cwd,
        Some(details),
      ));
    }
    let mut outcome = Object::new();
    copy(&mut outcome, "checkpoint", get(Some(&overlay), "checkpoint"));
    outcome.set("tree", actual);
    outcome.set("predicted", predicted);
    outcome.set("rematerialized", Value::Bool(true));
    overlay_result = Value::Object(outcome);
  }

  let applied = items(operation.get("applied"));
  let forked: Vec<Value> = applied
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
  // `plan.changes` already excludes every recreated merge, because a merge is
  // not a change (ADR-0034); a receipt that absorbed a join would be claiming
  // the work beneath it.
  let absorbed: Vec<Value> = items(get(plan, "changes"))
    .into_iter()
    .filter(|change| {
      let commit = get(Some(change), "commit");
      !forked.iter().any(|origin| strict_equals(Some(origin), commit))
        && (as_text(get(Some(change), "action")).as_deref() != Some("review") || accept_candidates)
    })
    .collect();
  let column = |name: &str| {
    Value::Array(absorbed.iter().map(|change| get(Some(change), name).cloned().unwrap_or(Value::Null)).collect())
  };
  let applications = projected(
    operation.get("applied"),
    &[
      ("id", "id"),
      ("sourceCommit", "originCommit"),
      ("sourceChangeId", "originChangeId"),
      ("appliedCommit", "appliedCommit"),
      ("appliedChangeId", "appliedChangeId"),
      ("targetBeforeTree", "targetBeforeTree"),
      ("resultTree", "resultTree"),
      ("relation", "relation"),
      ("conflictedPaths", "conflictedPaths"),
      ("resolutions", "resolutions"),
      ("semanticMerges", "semanticMerges"),
    ],
  );
  // A join, not a contribution: a plan concludes nothing from this entry, it
  // is not exact evidence under ADR-0004, and it contributes to no coverage
  // class (ADR-0034).
  let recreated: Vec<Value> = items(operation.get("recreatedMerges"))
    .iter()
    .map(|merge| {
      let mut entry = Object::new();
      for name in ["originCommit", "originChangeId", "resultCommit", "changeId", "parents"] {
        copy(&mut entry, name, get(Some(merge), name));
      }
      entry.set(
        "resolutions",
        Value::Array(
          items(get(Some(merge), "resolutions"))
            .iter()
            .map(|outcome| {
              let field = |name: &str| get(Some(outcome), name);
              let mut resolution = Object::new();
              copy(&mut resolution, "path", field("path"));
              copy(&mut resolution, "signature", field("signature"));
              copy(&mut resolution, "algorithm", field("algorithm"));
              // `exact-reused` when a recorded signature supplied the result,
              // `decided` when a person resolved it during the operation.
              resolution.set(
                "origin",
                string(if as_text(field("decision")).as_deref() == Some("created") {
                  "decided"
                } else {
                  "exact-reused"
                }),
              );
              resolution.set("resolutionId", or_null(field("selectedResolutionId")));
              resolution.set("resultBlob", or_null(field("resultBlob")));
              Value::Object(resolution)
            })
            .collect(),
        ),
      );
      copy(&mut entry, "semanticMerges", get(Some(merge), "semanticMerges"));
      copy(&mut entry, "cleanJoin", get(Some(merge), "cleanJoin"));
      entry.set("relation", string("recreated-merge"));
      Value::Object(entry)
    })
    .collect();
  let amendments = projected(
    operation.get("amendments"),
    &[
      ("id", "id"),
      ("changeId", "changeId"),
      ("commit", "commit"),
      ("originCommit", "originCommit"),
      ("treeBefore", "treeBefore"),
      ("treeAfter", "treeAfter"),
    ],
  );
  let absorptions = projected(
    operation.get("absorptions"),
    &[
      ("id", "id"),
      ("action", "action"),
      ("survivingCommit", "survivingCommit"),
      ("survivingChangeId", "survivingChangeId"),
      ("absorbedCommits", "absorbedCommits"),
      ("absorbedChanges", "absorbedChanges"),
    ],
  );
  let timings = operation.get("timings");
  let started_at = js_text(operation.get("startedAt"));
  let mut receipt_timings = Object::new();
  receipt_timings.set(
    "activeApplicationMs",
    rounded(match get(timings, "activeApplicationMs") {
      value if nullish(value) => 0.0,
      value => number(value),
    }),
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
  receipt.set("schema", string("causet.rebase/v3"));
  receipt.set("type", string("rebase"));
  receipt.set("id", string(&new_id("rebase")));
  copy(&mut receipt, "operationId", operation.get("id"));
  receipt.set("forecastId", or_null(operation.get("forecastId")));
  for name in ["sourceRef", "sourceHead", "ontoRef", "ontoHead"] {
    copy(&mut receipt, name, operation.get(name));
  }
  copy(&mut receipt, "physicalBase", get(plan, "physicalBase"));
  copy(&mut receipt, "effectiveBase", get(plan, "effectiveBase"));
  copy(&mut receipt, "planFingerprint", get(plan, "fingerprint"));
  receipt.set("quarantinedFacts", or_empty(get(plan, "quarantinedFacts")));
  // The range this rebase ran, and the commits the caller declared out of it:
  // a receipt never claims excluded work (ADR-0032).
  copy(&mut receipt, "range", get(plan, "range"));
  receipt.set("excludedByRange", or_empty(get(plan, "excludedByRange")));
  copy(&mut receipt, "acceptCandidates", operation.get("acceptCandidates"));
  copy(&mut receipt, "candidatePolicy", operation.get("candidatePolicy"));
  copy(&mut receipt, "omitted", get(plan, "omitted"));
  receipt.set(
    "acceptedCandidates",
    Value::Array(if accept_candidates {
      items(get(plan, "candidates"))
        .into_iter()
        .map(|candidate| {
          let mut accepted = match candidate {
            Value::Object(candidate) => candidate,
            _ => Object::new(),
          };
          accepted.set("decision", string("omit"));
          Value::Object(accepted)
        })
        .collect()
    } else {
      Vec::new()
    }),
  );
  receipt.set("applications", applications);
  receipt.set("recreatedMerges", Value::Array(recreated));
  // The declared program this rebase ran, and what the two identity-bearing
  // actions produced (ADR-0035).
  receipt.set("interactive", or_empty(get(plan, "interactive")));
  receipt.set("amendments", amendments);
  receipt.set("absorptions", absorptions);
  receipt.set("forkedSourceCommits", Value::Array(forked));
  receipt.set("absorbedCommits", column("commit"));
  receipt.set("absorbedChanges", column("changeId"));
  receipt.set("resultCommit", string(&result_commit));
  copy(&mut receipt, "sourceTree", get(plan, "sourceTree"));
  copy(&mut receipt, "ontoTree", get(plan, "ontoTree"));
  receipt.set("resultTree", string(&result_tree));
  receipt.set(
    "exactStateEqualityAfter",
    Value::Bool(strict_equals(Some(&string(&result_tree)), get(plan, "sourceTree"))),
  );
  receipt.set("timings", Value::Object(receipt_timings));
  copy(&mut receipt, "startedAt", operation.get("startedAt"));
  receipt.set("createdAt", string(&iso_now()));

  // The same non-atomic stretch as the reconciliation publication path, with
  // more at stake: the branch ref has already moved by the time it starts.
  fault_point("rebase:before-publish");
  let mut carried = Vec::new();
  for application in &applied {
    for outcome in items(get(Some(application), "resolutions")) {
      publish_resolution(&outcome, application, cwd)?;
    }
    let applied_commit = js_text(get(Some(application), "appliedCommit"));
    append_note(&applied_commit, application, cwd, &[])?;
    fault_point("rebase:mid-publish");
    let origin = get(Some(application), "originCommit");
    carried.push((
      if truthy(origin) { js_text(origin) } else { String::new() },
      applied_commit,
      as_text(get(Some(application), "appliedChangeId")),
    ));
  }
  // One read of the notes ref for the whole queue (ADR-0013).
  crate::provenance::carry_provenance_for_applications(&carried, cwd)?;
  // A resolution decided during a recreated merge is an ordinary resolution:
  // a merge rather than a pick producing the conflict changes nothing about
  // its signature (ADR-0034).
  for merge in items(operation.get("recreatedMerges")) {
    let mut origin = Object::new();
    copy(&mut origin, "id", get(Some(&merge), "changeId"));
    copy(&mut origin, "appliedCommit", get(Some(&merge), "resultCommit"));
    copy(&mut origin, "appliedChangeId", get(Some(&merge), "changeId"));
    let origin = Value::Object(origin);
    for outcome in items(get(Some(&merge), "resolutions")) {
      publish_resolution(&outcome, &origin, cwd)?;
    }
  }
  // Published before the receipt that names them, so a reader that sees the
  // receipt can always resolve the facts it points at.
  for amendment in items(operation.get("amendments")) {
    append_note(&js_text(get(Some(&amendment), "commit")), &amendment, cwd, &[])?;
  }
  for absorption in items(operation.get("absorptions")) {
    append_note(&js_text(get(Some(&absorption), "survivingCommit")), &absorption, cwd, &[])?;
  }
  fault_point("rebase:before-receipt");
  let receipt = Value::Object(receipt);
  append_note(&result_commit, &receipt, cwd, &[])?;
  release_anchors(operation, cwd)?;
  fault_point("rebase:before-clear");
  clear_state(cwd)?;
  let mut result = Object::new();
  copy(&mut result, "operationId", operation.get("id"));
  copy(&mut result, "plan", plan);
  for name in ["recreatedMerges", "amendments", "absorptions"] {
    copy(&mut result, name, get(Some(&receipt), name));
  }
  result.set("receipt", receipt);
  // Reported, never published: the overlay is uncommitted context (ADR-0028).
  result.set("targetOverlay", overlay_result);
  Ok(Value::Object(result))
}

// ---------------------------------------------------------------------------
// Starting
// ---------------------------------------------------------------------------

/// `unsupportedTopologyError(topology)`: the refusal for a range this version
/// does not recreate, naming the first merge and listing the rest.
fn unsupported_topology(topology: Option<&Value>) -> GitError {
  let merges = items(get(topology, "unsupportedMerges"));
  let first = merges.first();
  let mut details = vec![js_text(get(first, "details"))];
  for item in merges.iter().skip(1) {
    details.push(format!(
      "{}: {}",
      twelve(&js_text(get(Some(item), "commit"))),
      js_text(get(Some(item), "details"))
    ));
  }
  details.push("Reshape the history, narrow the range with --from, or use ordinary Git for this topology.".into());
  let message = format!(
    "Causal rebase cannot recreate the merge {}.",
    twelve(&js_text(get(first, "commit")))
  );
  let code = if as_text(get(first, "reason")).as_deref() == Some("octopus-merge") {
    "unsupported-repository-shape"
  } else {
    "unsupported-range"
  };
  GitError::new(code, message).details(details.join("\n"))
}

/// `startOperation(branch, ontoRef, plan, options, cwd)`: the journal of a new
/// rebase.
fn start_operation(
  branch: &(String, String),
  onto_ref: &str,
  plan: &Value,
  accept_candidates: bool,
  forecast: Option<&Value>,
  cwd: &str,
) -> GitResult<Object> {
  let context = engine::repo_context(cwd)?;
  let planned = |name: &str| get(Some(plan), name);
  let candidates = items(planned("candidates"));
  let mut operation = Object::new();
  operation.set("schema", string("causet.rebase-operation/v3"));
  operation.set("id", string(&new_id("rebase_op")));
  operation.set("state", string("prepared"));
  operation.set("worktree", string(&context.root));
  operation.set("sourceRef", string(&branch.1));
  operation.set("sourceBranchRef", string(&branch.0));
  copy(&mut operation, "sourceHead", planned("sourceHead"));
  copy(&mut operation, "originalHead", planned("sourceHead"));
  operation.set("ontoRef", string(onto_ref));
  copy(&mut operation, "ontoHead", planned("ontoHead"));
  operation.set("acceptCandidates", Value::Bool(accept_candidates));
  operation.set(
    "candidatePolicy",
    string(if candidates.is_empty() {
      "none"
    } else if accept_candidates {
      "accepted"
    } else {
      "review-required"
    }),
  );
  operation.set("forecastId", or_null(get(forecast, "id")));
  operation.set(
    "forecastApproval",
    match forecast {
      Some(forecast) => {
        let field = |name: &str| get(Some(forecast), name);
        let mut approval = Object::new();
        copy(&mut approval, "id", field("id"));
        copy(&mut approval, "planFingerprint", field("planFingerprint"));
        copy(&mut approval, "steps", field("steps"));
        approval.set("approvedResolutions", or_empty(field("approvedResolutions")));
        approval.set("approvedSpecMerges", or_empty(field("approvedSpecMerges")));
        approval.set("acceptedCandidates", or_empty(field("acceptedCandidates")));
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
  // Every step of the rewrite, in the order it runs, so the parent mapping
  // can be rebuilt after an interruption (ADR-0034).
  operation.set(
    "queue",
    Value::Array(rebase_program(plan).iter().map(|item| item.to_value()).collect()),
  );
  operation.set("nextIndex", Value::Number(0.0));
  // Advances only on a step that ran, because a forecast has no entry for a
  // commit nothing replayed.
  operation.set("executedCount", Value::Number(0.0));
  operation.set("rewritten", Value::Object(Object::new()));
  for name in ["recreatedMerges", "amendments", "absorptions", "applied"] {
    operation.set(name, Value::Array(Vec::new()));
  }
  operation.set("current", Value::Null);
  operation.set("startedAt", string(&iso_now()));
  let mut git_timings = Object::new();
  for name in ["count", "processes", "sessionQueries", "cacheHits", "totalMs", "failed"] {
    git_timings.set(name, Value::Number(0.0));
  }
  git_timings.set("byCommand", Value::Array(Vec::new()));
  let mut timings = Object::new();
  timings.set("activeApplicationMs", Value::Number(0.0));
  timings.set("git", Value::Object(git_timings));
  operation.set("timings", Value::Object(timings));
  operation.set("updatedAt", string(&iso_now()));
  Ok(operation)
}

/// What `cst rebase <onto>` was asked for.
pub struct StartOptions<'a> {
  pub accept_candidates: bool,
  pub forecast_id: Option<&'a str>,
  pub plan: RebaseOptions,
}

/// `startRebase(ontoRef, options)`: the current branch rewritten onto
/// `ontoRef`, one journaled step at a time.
pub fn start_rebase(onto_ref: &str, options: &StartOptions, cwd: &str) -> GitResult<Value> {
  with_object_session(cwd, || start_in_session(onto_ref, options, cwd))
}

fn start_in_session(onto_ref: &str, options: &StartOptions, cwd: &str) -> GitResult<Value> {
  let busy = read_journal(
    cwd,
    "reconciliation.json",
    "causet.reconciliation-operation",
    "reconciliation",
  )?
  .is_some()
    || read_state(cwd)?.is_some();
  if busy {
    return Err(GitError::new(
      "operation-in-progress",
      "A VCS Lab operation is already in progress in this worktree.",
    ));
  }
  let forecast_id = options.forecast_id.filter(|id| !id.is_empty());
  // A forecast carrying an overlay expects a dirty worktree: the overlay is
  // the uncommitted work. The clean check is replaced by a stricter one, that
  // the live tree equals the overlay tree exactly (ADR-0028).
  let approved_overlay = match forecast_id {
    Some(id) => get(Some(&read_rebase_forecast(id, cwd)?), "targetOverlay")
      .filter(|overlay| truthy(Some(overlay)))
      .cloned(),
    None => None,
  };
  if approved_overlay.is_none() {
    engine::assert_clean(cwd)?;
  }
  assert_no_git_replay(cwd)?;
  let branch = current_branch(cwd)?;
  let plan = crate::plan::rebase_plan(onto_ref, Some(&branch.1), cwd, &options.plan)?;
  if !truthy(get(get(Some(&plan), "constraints"), "supported")) {
    return Err(unsupported_topology(get(Some(&plan), "topology")));
  }
  let forecast = match forecast_id {
    Some(id) => Some(rebase_forecast_for_plan(id, &plan, cwd)?),
    None => None,
  };
  if let Some(overlay) = &approved_overlay {
    // Refuses before anything moves: a drifted worktree is `stale-overlay`
    // and a moved base head or missing checkpoint is `stale-forecast`.
    assert_overlay_current(overlay, cwd)?;
  }
  let accept_candidates = options.accept_candidates || truthy(get(forecast.as_ref(), "acceptCandidates"));
  if !items(get(Some(&plan), "candidates")).is_empty() && !accept_candidates {
    return Err(
      GitError::new(
        "approval-required",
        "The rebase plan contains heuristic patch-equivalence candidates.",
      )
      .details(
        "Review 'cst rebase-plan' and rerun with --accept-candidates, or use a complete reviewed rebase forecast.",
      ),
    );
  }

  let mut operation = start_operation(&branch, onto_ref, &plan, accept_candidates, forecast.as_ref(), cwd)?;
  write_state(&operation, cwd)?;
  if let Some(overlay) = &approved_overlay {
    // The overlay is safe in its checkpoint, so the worktree is reduced to
    // the committed head before the reset onto the new base, which would
    // discard its tracked edits and strand its untracked files.
    operation.set("state", string("reducing-overlay"));
    write_state(&operation, cwd)?;
    reduce_to_committed_head(overlay, cwd)?;
  }
  operation.set("state", string("resetting"));
  write_state(&operation, cwd)?;
  git(&["reset", "--hard", &js_text(get(Some(&plan), "ontoHead"))], cwd)?;
  operation.set("state", string("running"));
  write_state(&operation, cwd)?;
  run_queue(&mut operation, cwd, Instant::now())
}

/// `formatRebaseResult(result)`.
pub fn format_rebase_result(result: &Value) -> String {
  let receipt = get(Some(result), "receipt");
  let field = |name: &str| get(receipt, name);
  let applications = items(field("applications"));
  let related = |relation: &str| {
    applications
      .iter()
      .filter(|application| as_text(get(Some(application), "relation")).as_deref() == Some(relation))
      .count()
  };
  let mut lines = vec![
    "Causal rebase complete.".to_string(),
    format!("operation    {}", js_text(get(Some(result), "operationId"))),
    format!("branch       {}", js_text(field("sourceRef"))),
    format!("source       {}", short(field("sourceHead"))),
    format!("onto         {} @ {}", js_text(field("ontoRef")), short(field("ontoHead"))),
    format!("result       {}", short(field("resultCommit"))),
    format!(
      "coverage     {} exact omit; {} accepted candidate; {} replayed",
      items(field("omitted")).len(),
      items(field("acceptedCandidates")).len(),
      applications.len()
    ),
    format!("contextual   {}", related("contextual-rebase")),
    format!("forked       {}", related("contextual-fork")),
    format!(
      "same state   {}",
      if truthy(field("exactStateEqualityAfter")) { "yes" } else { "no" }
    ),
  ];
  if truthy(field("forecastId")) {
    lines.push(format!("forecast     {}", js_text(field("forecastId"))));
  }
  if let Some(overlay) = get(Some(result), "targetOverlay").filter(|overlay| truthy(Some(overlay))) {
    lines.push(format!(
      "overlay      checkpoint {} re-materialized uncommitted as {}",
      short(get(Some(overlay), "checkpoint")),
      short(get(Some(overlay), "tree"))
    ));
  }
  let timings = field("timings");
  if truthy(timings) {
    lines.push(format!(
      "active time  {} ms",
      fixed(get(timings, "activeApplicationMs"))
    ));
  }
  lines.extend(git_activity(get(timings, "git")));
  lines.join("\n")
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/// `rebaseStatus()`: the journal, with what Git holds beside it.
pub fn rebase_status(cwd: &str) -> GitResult<Value> {
  let mut status = Object::new();
  let Some(operation) = read_state(cwd)? else {
    status.set("active", Value::Bool(false));
    status.set("state", string("idle"));
    return Ok(Value::Object(status));
  };
  let field = |name: &str| get(Some(&operation), name);
  let actual = engine::symbolic_ref("HEAD", cwd, false)?.map_or(Value::Null, |name| string(&name));
  let actual_head = engine::current_head(cwd)?;
  status.set("active", Value::Bool(true));
  copy(&mut status, "operationId", field("id"));
  for name in [
    "state",
    "worktree",
    "sourceRef",
    "sourceHead",
    "sourceBranchRef",
    "ontoRef",
    "ontoHead",
  ] {
    copy(&mut status, name, field(name));
  }
  status.set("forecastId", or_null(field("forecastId")));
  // Counted over the steps that run: a merge-preserving program also carries
  // the commits that collapse out, which are not remaining work.
  let completed = match field("executedCount") {
    value if nullish(value) => field("nextIndex"),
    value => value,
  };
  let total = executable_steps(&operation);
  let done = number(completed);
  let remaining = (0..total).filter(|index| (*index as f64) >= done).count();
  let mut progress = Object::new();
  copy(&mut progress, "completed", completed);
  progress.set("total", Value::Number(total as f64));
  progress.set("remaining", Value::Number(remaining as f64));
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
      current.set("unresolvedPaths", strings(&engine::unmerged_paths(cwd)?));
      Value::Object(current)
    } else {
      Value::Null
    },
  );
  copy(&mut status, "applied", field("applied"));
  // Joins, never applications: listed separately so a reader of a paused
  // operation cannot mistake one for coverage (ADR-0034).
  status.set("recreatedMerges", or_empty(field("recreatedMerges")));
  let mut recovery = Object::new();
  copy(&mut recovery, "expectedBranchRef", field("sourceBranchRef"));
  recovery.set("actualBranchRef", actual.clone());
  recovery.set("actualHead", string(&actual_head));
  copy(&mut recovery, "originalHead", field("originalHead"));
  recovery.set(
    "branchMatches",
    Value::Bool(strict_equals(Some(&actual), field("sourceBranchRef"))),
  );
  status.set("recovery", Value::Object(recovery));
  for name in ["timings", "startedAt", "updatedAt"] {
    copy(&mut status, name, field(name));
  }
  Ok(Value::Object(status))
}

/// `formatRebaseStatus(status)`.
pub fn format_rebase_status(status: &Value) -> String {
  let field = |name: &str| get(Some(status), name);
  if !truthy(field("active")) {
    return "No causal rebase is in progress in this worktree.".to_string();
  }
  let progress = field("progress");
  let mut lines = vec![
    format!("operation    {}", js_text(field("operationId"))),
    format!("state        {}", js_text(field("state"))),
    format!("branch       {}", js_text(field("sourceRef"))),
    format!("source start {}", short(field("sourceHead"))),
    format!("onto         {} @ {}", js_text(field("ontoRef")), short(field("ontoHead"))),
    format!(
      "progress     {}/{} replayed",
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
      let paths: Vec<String> = paths.iter().map(|path| js_text(Some(path))).collect();
      lines.push(format!("conflicts    {}", paths.join(", ")));
    }
  }
  if !truthy(get(field("recovery"), "branchMatches")) {
    lines.push(String::new());
    lines.push(format!(
      "branch mismatch: switch back to {} before recovery.",
      js_text(field("sourceRef"))
    ));
  }
  lines.push(String::new());
  lines.push(
    match as_text(field("state")).as_deref() {
      Some("conflicted") => "Resolve and stage the conflicts, then run: cst rebase --continue",
      Some("forecast-mismatch" | "identity-mismatch" | "blocked") => {
        "The operation is blocked and cannot publish receipts."
      }
      _ => "The operation is resumable in this worktree.",
    }
    .to_string(),
  );
  lines.push("Abort and restore the original branch tip with: cst rebase --abort".to_string());
  lines.join("\n")
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

/// `completeInteractiveStep(operation, options, cwd)`: a `reword` or an `edit`
/// the caller has come back to. A `reword` rewrites the message under the
/// original identity and nothing else. An `edit` keeps both and takes what
/// the caller staged; a tree that diverged publishes an amendment (ADR-0035).
fn complete_interactive_step(operation: &mut Object, message: Option<&str>, cwd: &str) -> GitResult<()> {
  let (_, change) = queued(operation);
  let change_id = js_text(get(Some(&change), "changeId"));
  let message = message.filter(|message| !message.is_empty());
  let tree_before = get(operation.get("current"), "treeBeforeEdit").cloned();
  if as_text(operation.get("state")).as_deref() == Some("awaiting-message") {
    let Some(message) = message else {
      return Err(
        GitError::new("usage-missing-argument", "This rebase is paused for a new message.")
          .details("Supply it with: cst rebase --continue -m \"<message>\""),
      );
    };
    let message = reworded_message(message, &change_id)?;
    assert_single_identity(&message, &change_id)?;
    let amended = git_allowing_failure(&["-c", "core.editor=true", "commit", "--amend", "-m", &message], cwd)?;
    if !amended.ok {
      return Err(
        GitError::new("conflict-blocked", "Git could not apply the reworded message.").details(amended.output),
      );
    }
    // A reword changes a message and nothing else, so a tree that moved means
    // something else changed the worktree while the operation was paused.
    let after = engine::tree_id("HEAD", cwd)?;
    if !strict_equals(Some(&string(&after)), tree_before.as_ref()) {
      operation.set("state", string("blocked"));
      write_state(operation, cwd)?;
      return Err(
        GitError::new(
          "out-of-band-change",
          "The worktree changed while the reword was paused.",
        )
        .details(
          [
            format!("Tree at the pause: {}", js_text(tree_before.as_ref())),
            format!("Tree now:          {after}"),
            "A reword changes a message and nothing else. Run 'cst rebase --abort'.".to_string(),
          ]
          .join("\n"),
        ),
      );
    }
    edit_current(operation, |current| current.set("rewordedTo", string(&message)));
    return record_successful_application(operation, "causal-rebase", cwd);
  }

  if message.is_some() {
    return Err(
      GitError::new(
        "usage-invalid-option-value",
        "This rebase is paused for content, not for a message.",
      )
      .details("An edit keeps the message it had. Stage your changes and continue without -m."),
    );
  }
  let staged = git_allowing_failure(
    &["-c", "core.editor=true", "commit", "--amend", "--no-edit", "--allow-empty"],
    cwd,
  )?;
  if !staged.ok {
    return Err(GitError::new("conflict-blocked", "Git could not apply the edited content.").details(staged.output));
  }
  let ids = engine::resolve_object_ids(&owned(&["HEAD^{commit}", "HEAD^{tree}"]), cwd)?;
  let tree_after = string(&ids.get(1).cloned().unwrap_or_default());
  // An amendment whose before and after trees are equal publishes nothing,
  // because nothing diverged (ADR-0035).
  if !strict_equals(Some(&tree_after), tree_before.as_ref()) {
    let mut amendment = Object::new();
    amendment.set("schema", string("causet.amendment/v1"));
    amendment.set("type", string("amendment"));
    amendment.set("id", string(&new_id("amend")));
    copy(&mut amendment, "changeId", get(Some(&change), "changeId"));
    amendment.set("commit", string(&ids.first().cloned().unwrap_or_default()));
    copy(&mut amendment, "originCommit", get(Some(&change), "commit"));
    copy(&mut amendment, "treeBefore", tree_before.as_ref());
    amendment.set("treeAfter", tree_after);
    copy(&mut amendment, "rebaseOperation", operation.get("id"));
    amendment.set("createdAt", string(&iso_now()));
    let mut amendments = items(operation.get("amendments"));
    amendments.push(Value::Object(amendment));
    operation.set("amendments", Value::Array(amendments));
  }
  record_successful_application(operation, "causal-rebase", cwd)
}

/// `completeAbsorption(operation, cwd)`: the absorbed change a caller has
/// resolved, then the rest. Its resolution is captured and published like any
/// other (ADR-0007, ADR-0035).
fn complete_absorption(operation: &mut Object, cwd: &str) -> GitResult<()> {
  let unresolved = engine::unmerged_paths(cwd)?;
  if !unresolved.is_empty() {
    return Err(
      GitError::new("conflict-blocked", "The absorbed change still has unresolved paths.")
        .details(unresolved.join("\n")),
    );
  }
  let conflicts = items(get(get(operation.get("current"), "absorption"), "conflicts"));
  let outcomes = capture_resolution_outcomes(&conflicts, cwd)?;
  edit_absorption(operation, |absorption| {
    let mut resolutions = items(absorption.get("resolutions"));
    resolutions.extend(outcomes);
    absorption.set("resolutions", Value::Array(resolutions));
    absorption.set("conflicts", Value::Null);
    absorption.set("conflictedPaths", Value::Array(Vec::new()));
    absorption.set("conflictedCommit", Value::Null);
    // The change that conflicted is folded in now, so the cursor advances
    // past it before the loop resumes; otherwise it would be applied twice.
    let next = number(absorption.get("nextIndex"));
    absorption.set("nextIndex", Value::Number(next + 1.0));
  });
  operation.set("state", string("applying"));
  write_state(operation, cwd)?;
  absorb_outstanding(operation, cwd)?;
  finish_surviving_step(operation, cwd)
}

/// `continueRebase({ fork, message })`: the paused step finished as the
/// worktree now has it, and the rest of the program run.
pub fn continue_rebase(fork: bool, message: Option<&str>, cwd: &str) -> GitResult<Value> {
  with_object_session(cwd, || continue_in_session(fork, message, cwd))
}

fn continue_in_session(fork: bool, message: Option<&str>, cwd: &str) -> GitResult<Value> {
  let phase_started = Instant::now();
  let mut operation = require_pending(cwd)?;
  assert_current_spec_decisions(Some(&Value::Object(operation.clone())))?;
  require_operation_branch(&operation, cwd)?;
  let state = as_text(operation.get("state"));
  if matches!(state.as_deref(), Some("awaiting-message" | "awaiting-content")) {
    complete_interactive_step(&mut operation, message, cwd)?;
    return run_queue(&mut operation, cwd, phase_started);
  }
  if state.as_deref() == Some("awaiting-absorption") {
    complete_absorption(&mut operation, cwd)?;
    return run_queue(&mut operation, cwd, phase_started);
  }
  if state.as_deref() != Some("conflicted") || !truthy(operation.get("current")) {
    return Err(
      GitError::new(
        "operation-state-invalid",
        format!("Rebase state '{}' cannot be continued.", js_text(operation.get("state"))),
      )
      .details("Only a resolved conflict can continue; abort other blocked states."),
    );
  }
  let unresolved = engine::unmerged_paths(cwd)?;
  if !unresolved.is_empty() {
    return Err(
      GitError::new("conflict-blocked", "Causal rebase still has unresolved paths.").details(unresolved.join("\n")),
    );
  }
  let recreating = as_text(get(operation.get("current"), "kind")).as_deref() == Some("recreate-merge");
  if recreating {
    // A recreated merge is pending as a merge, and what identifies it is the
    // side it is joining: no commit is being applied (ADR-0034).
    let joined = engine::pseudo_ref_target("MERGE_HEAD", cwd)?.filter(|head| !head.is_empty());
    let expected = items(get(operation.get("current"), "mergeParents"))
      .get(1)
      .and_then(|parent| get(Some(parent), "commit").cloned());
    if !joined.is_some_and(|joined| strict_equals(Some(&string(&joined)), expected.as_ref())) {
      return Err(
        GitError::new(
          "out-of-band-change",
          "Git's pending merge does not match the causal rebase journal.",
        )
        .details("Abort the VCS Lab rebase to restore the original branch tip."),
      );
    }
  } else {
    let pending = engine::pseudo_ref_target("CHERRY_PICK_HEAD", cwd)?.filter(|head| !head.is_empty());
    let source = get(operation.get("current"), "sourceCommit");
    if !pending.is_some_and(|pending| strict_equals(Some(&string(&pending)), source)) {
      return Err(
        GitError::new(
          "out-of-band-change",
          "Git's pending cherry-pick does not match the causal rebase journal.",
        )
        .details("Abort the VCS Lab rebase to restore the original branch tip."),
      );
    }
  }

  let merges = capture_spec_merge_outcomes(&items(get(operation.get("current"), "semanticMerges")), cwd)?;
  let semantically_resolved: Vec<Value> = merges
    .iter()
    .flat_map(|merge| items(get(Some(merge), "resolvedPaths")))
    .collect();
  edit_current(&mut operation, |current| current.set("semanticMerges", Value::Array(merges)));
  let exact: Vec<Value> = items(get(operation.get("current"), "conflicts"))
    .into_iter()
    .filter(|conflict| {
      let path = get(Some(conflict), "path");
      !semantically_resolved.iter().any(|resolved| strict_equals(Some(resolved), path))
    })
    .collect();
  let outcomes = capture_resolution_outcomes(&exact, cwd)?;
  edit_current(&mut operation, |current| current.set("resolutionOutcomes", Value::Array(outcomes)));
  write_state(&operation, cwd)?;
  if recreating {
    // A recreated merge already has a new identity by contract, so there is
    // no fork to declare: a join claims to be nothing.
    if fork {
      return Err(
        GitError::new(
          "operation-state-invalid",
          "A recreated merge cannot be forked; it already takes a new identity.",
        )
        .details("Continue without --fork. See ADR-0034 for why a join claims nothing."),
      );
    }
    let (_, change) = queued(&operation);
    commit_recreated_merge(&operation, &change, cwd)?;
    let parents = journaled_merge_parents(&operation);
    record_recreated_merge(&mut operation, &change, parents, false, cwd)?;
    return run_queue(&mut operation, cwd, phase_started);
  }
  if fork || truthy(get(operation.get("current"), "forkChangeId")) {
    fork_merge_message(&mut operation, cwd)?;
  }
  let mut finish = GIT_NO_RERERE.to_vec();
  finish.extend(["-c", "core.editor=true", "cherry-pick", "--continue"]);
  let result = git_allowing_failure(&finish, cwd)?;
  if !result.ok {
    return Err(GitError::new("conflict-blocked", "Git could not continue the causal rebase.").details(result.output));
  }
  let relation = if truthy(get(operation.get("current"), "forkChangeId")) {
    "contextual-fork"
  } else {
    "contextual-rebase"
  };
  record_successful_application(&mut operation, relation, cwd)?;
  run_queue(&mut operation, cwd, phase_started)
}

// ---------------------------------------------------------------------------
// Aborting
// ---------------------------------------------------------------------------

/// `abortRebase()`: whatever is pending abandoned, the branch's original tip
/// restored, and a carried overlay put back.
pub fn abort_rebase(cwd: &str) -> GitResult<Value> {
  let operation = require_pending(cwd)?;
  require_operation_branch(&operation, cwd)?;
  let pending = |name: &str| -> GitResult<bool> {
    Ok(engine::pseudo_ref_target(name, cwd)?.is_some_and(|head| !head.is_empty()))
  };
  if pending("CHERRY_PICK_HEAD")? {
    git(&["cherry-pick", "--abort"], cwd)?;
  } else if pending("MERGE_HEAD")? {
    // A recreated merge is pending, so the dirt is this operation's own join.
    git(&["merge", "--abort"], cwd)?;
  } else if as_text(operation.get("state")).as_deref() == Some("awaiting-absorption") {
    // `cherry-pick --no-commit` leaves only unmerged index entries on a
    // conflict, so the journal is what identifies this operation's own dirt,
    // and the reset below clears it.
  } else if !truthy(operation.get("overlayRematerialized")) {
    // Skipped only once the journal says this operation put the overlay back
    // itself: in that one state the dirt is the merged draft it wrote.
    engine::assert_clean(cwd)?;
  }
  let original = operation.get("originalHead");
  if !strict_equals(Some(&string(&engine::current_head(cwd)?)), original) {
    git(&["reset", "--hard", &js_text(original)], cwd)?;
  }
  let restored_head = engine::current_head(cwd)?;
  if !strict_equals(Some(&string(&restored_head)), original) {
    return Err(GitError::new(
      "internal-invariant",
      "Causal rebase abort did not restore the original tip.",
    ));
  }
  // The committed tip is restored first and unconditionally; the overlay is
  // put back afterwards, so a draft that cannot be recovered never costs the
  // tip (ADR-0028).
  let overlay = match operation.get("targetOverlay").filter(|overlay| truthy(Some(overlay))) {
    Some(overlay) => restore_overlay_after_abort(overlay, cwd)?,
    None => Value::Null,
  };
  // Released only once the tip is restored: until then these refs are the
  // only thing naming a partially rewritten line.
  release_anchors(&operation, cwd)?;
  fault_point("rebase:abort-before-clear");
  clear_state(cwd)?;
  let mut result = Object::new();
  result.set("aborted", Value::Bool(true));
  copy(&mut result, "operationId", operation.get("id"));
  copy(&mut result, "sourceRef", operation.get("sourceRef"));
  result.set("restoredHead", string(&restored_head));
  result.set("overlay", overlay);
  Ok(Value::Object(result))
}
