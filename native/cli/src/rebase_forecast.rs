//! `cst rebase-forecast`: `forecastRebase` and `formatRebaseForecast` of
//! `src/rebase-forecast.js`, a prediction of a causal rebase simulated away
//! from the caller's worktree and saved for `cst rebase --use-forecast`.

use crate::forecast::{
  Simulation, elapsed, format_forecast_engine, rounded, save_forecast, simulate_causal_rebase_plan,
  zero_timings,
};
use crate::plan::RebaseOptions;
use crate::records::short;
use crate::resolve::read_journal;
use crate::target_overlay::{predict_overlay_tree, resolve_target_overlay};
use causet_engine::errors::{GitError, GitResult};
use causet_engine::session::with_object_session;
use causet_engine::types::IndexOptions;
use causet_engine::{engine, metrics};
use causet_model::js::{get, length, nullish, strict_equals, text as js_text, truthy};
use causet_model::json::{Object, Value, lossy, string, stringify};
use std::time::Instant;

fn as_text(value: Option<&Value>) -> Option<String> {
  match value {
    Some(Value::String(units)) => Some(lossy(units)),
    _ => None,
  }
}

fn items(value: Option<&Value>) -> &[Value] {
  match value {
    Some(Value::Array(items)) => items,
    _ => &[],
  }
}

fn or_null(value: Option<&Value>) -> Value {
  value.cloned().unwrap_or(Value::Null)
}

fn sha256(text: &str) -> String {
  causet_model::sha256::hex(text.as_bytes())
}

/// `captureCaller(cwd)`: everything of the caller's worktree a forecast must
/// leave exactly as it found.
#[derive(PartialEq)]
struct Caller {
  head: String,
  tree: String,
  branch: Option<String>,
  index: String,
  status: String,
  worktrees: String,
}

fn capture_caller(cwd: &str) -> GitResult<Caller> {
  let ids = engine::resolve_object_ids(&["HEAD^{commit}".to_string(), "HEAD^{tree}".to_string()], cwd)?;
  let mut ids = ids.into_iter();
  let head = ids.next().unwrap_or_default();
  let tree = ids.next().unwrap_or_default();
  let branch = engine::symbolic_ref("HEAD", cwd, true)?;
  // `JSON.stringify(indexEntries(cwd))`, in the order the entries are built.
  let index = engine::index_entries(cwd, &IndexOptions::default())?
    .iter()
    .map(|entry| {
      let mut object = Object::new();
      if let Some(mode) = &entry.mode {
        object.set("mode", string(mode));
      }
      if let Some(blob) = &entry.blob {
        object.set("blob", string(blob));
      }
      object.set("stage", Value::Number(entry.stage));
      object.set("path", string(&entry.path));
      Value::Object(object)
    })
    .collect();
  let status = engine::porcelain_status(cwd, true)?;
  let text = |value: &Option<String>| value.as_deref().map_or(Value::Null, string);
  let worktrees = engine::list_worktrees(cwd)?
    .iter()
    .map(|worktree| {
      let mut object = Object::new();
      object.set("path", string(&worktree.path));
      object.set("head", text(&worktree.head));
      object.set("branch", text(&worktree.branch));
      object.set("detached", Value::Bool(worktree.detached));
      object.set("bare", Value::Bool(worktree.bare));
      object.set("locked", text(&worktree.locked));
      object.set("prunable", text(&worktree.prunable));
      Value::Object(object)
    })
    .collect();
  Ok(Caller {
    head,
    tree,
    branch,
    index: stringify(&Value::Array(index)),
    status,
    worktrees: stringify(&Value::Array(worktrees)),
  })
}

/// `ignoredDirtyFiles(status)`: the entries of a NUL-terminated porcelain
/// status, a rename or a copy counting once though it takes two fields.
fn ignored_dirty_files(status: &str) -> usize {
  let fields: Vec<&str> = status.split('\0').filter(|field| !field.is_empty()).collect();
  let mut count = 0;
  let mut index = 0;
  while index < fields.len() {
    count += 1;
    if fields[index].chars().take(2).any(|code| matches!(code, 'R' | 'C')) {
      index += 1;
    }
    index += 1;
  }
  count
}

/// `emptySimulation(status, blockedReason, remainingChanges)`.
fn empty_simulation(status: &str, blocked_reason: Value, remaining: usize) -> Object {
  let mut counts = Object::new();
  for name in [
    "clean",
    "exactResolution",
    "exactResolutionPaths",
    "semanticSpec",
    "semanticSpecPaths",
    "blocked",
  ] {
    counts.set(name, Value::Number(0.0));
  }
  let mut result = Object::new();
  result.set("status", string(status));
  result.set("blockedReason", blocked_reason);
  result.set("steps", Value::Array(Vec::new()));
  result.set("approvedResolutions", Value::Array(Vec::new()));
  result.set("approvedSpecMerges", Value::Array(Vec::new()));
  result.set("counts", Value::Object(counts));
  result.set("simulatedChanges", Value::Number(0.0));
  result.set("remainingChanges", Value::Number(remaining as f64));
  result.set("partialResultTree", Value::Null);
  result.set("predictedResultTree", Value::Null);
  result.set("exactStateEqualityAfter", Value::Null);
  result
}

fn withhold(result: &mut Object, status: &str, reason: Value) {
  result.set("status", string(status));
  result.set("blockedReason", reason);
  result.set("predictedResultTree", Value::Null);
  result.set("exactStateEqualityAfter", Value::Null);
}

/// What `cst rebase-forecast` was asked for.
pub struct ForecastOptions {
  pub accept_candidates: bool,
  pub target_checkpoint: bool,
  pub plan: RebaseOptions,
}

/// `forecastRebase(ontoRef, sourceRef, options)`.
pub fn forecast_rebase(
  onto_ref: &str,
  source_ref: Option<&str>,
  options: &ForecastOptions,
  cwd: &str,
) -> GitResult<Value> {
  with_object_session(cwd, || forecast_in_session(onto_ref, source_ref, options, cwd))
}

fn forecast_in_session(
  onto_ref: &str,
  source_ref: Option<&str>,
  options: &ForecastOptions,
  cwd: &str,
) -> GitResult<Value> {
  let busy = read_journal(
    cwd,
    "reconciliation.json",
    "causet.reconciliation-operation",
    "reconciliation",
  )?
  .is_some()
    || read_journal(cwd, "rebase.json", "causet.rebase-operation", "rebase")?.is_some();
  if busy {
    return Err(GitError::new(
      "operation-in-progress",
      "Finish or abort the current VCS Lab operation before forecasting a rebase.",
    ));
  }
  // Resolved before any planning, so a worktree that cannot supply an overlay
  // refuses without having simulated anything. The overlaid worktree is the
  // source branch's own, because a rebase rewrites the branch it stands on.
  let target_overlay = if options.target_checkpoint {
    Some(resolve_target_overlay(cwd)?)
  } else {
    None
  };
  let started_at = metrics::iso_now();
  let started = Instant::now();
  let collector = metrics::begin("rebase-forecast");
  let mut phases = Object::new();

  let preflight_started = Instant::now();
  let before = capture_caller(cwd)?;
  phases.set("preflightMs", rounded(elapsed(preflight_started)));

  let planning_started = Instant::now();
  let plan = crate::plan::rebase_plan(onto_ref, source_ref, cwd, &options.plan)?;
  phases.set("planningMs", rounded(elapsed(planning_started)));
  let member = |name: &str| get(Some(&plan), name);

  let simulation_started = Instant::now();
  let constraints = member("constraints");
  let mut simulation = if truthy(get(constraints, "supported")) {
    simulate_causal_rebase_plan(&plan, cwd)?
  } else {
    // Which shape, not merely "there are merges": the plan recreates merges,
    // so the only unsupported ranges are the ones ADR-0034 names.
    let reason = match get(items(get(constraints, "unsupportedMerges")).first(), "reason") {
      value if nullish(value) => string("merge-topology-unsupported"),
      value => or_null(value),
    };
    Simulation {
      result: empty_simulation("unsupported", reason, items(member("replayQueue")).len()),
      engine: None,
      fallbacks: Vec::new(),
      worktree_timings: zero_timings(),
      merge_tree_timings: zero_timings(),
    }
  };
  phases.set("simulationMs", rounded(elapsed(simulation_started)));

  let candidates = items(member("candidates"));
  let candidate_decision_required = !candidates.is_empty() && !options.accept_candidates;
  if candidate_decision_required && as_text(simulation.result.get("status")).as_deref() == Some("complete") {
    withhold(
      &mut simulation.result,
      "review-required",
      string("heuristic-candidate-decision-required"),
    );
  }

  // The overlay prediction runs on trees, never on live bytes. Its base is
  // the tree the source branch held before the rebase and `ours` is the
  // rewritten tip, so it is pinned once per run rather than once per pick.
  let mut overlay_prediction: Option<Value> = None;
  if let Some(overlay) = &target_overlay {
    let prediction = match simulation.result.get("predictedResultTree") {
      Some(Value::String(units)) if !units.is_empty() => predict_overlay_tree(
        &js_text(member("sourceTree")),
        &lossy(units),
        &js_text(get(Some(overlay), "tree")),
        cwd,
      )?,
      _ => {
        let mut empty = Object::new();
        empty.set("tree", Value::Null);
        empty.set("conflict", Value::Null);
        Value::Object(empty)
      }
    };
    if let Some(conflict) = get(Some(&prediction), "conflict").filter(|conflict| truthy(Some(conflict))) {
      let reason = or_null(get(Some(conflict), "reason"));
      withhold(&mut simulation.result, "blocked-target-overlay", reason);
    }
    overlay_prediction = Some(prediction);
  }

  let invariant_started = Instant::now();
  let after = capture_caller(cwd)?;
  if before != after {
    metrics::end(collector);
    return Err(GitError::new(
      "internal-invariant",
      "Rebase forecasting unexpectedly changed the caller worktree.",
    ));
  }
  phases.set("invariantCheckMs", rounded(elapsed(invariant_started)));

  let context = engine::repo_context(cwd)?;
  let git_metrics = metrics::end(collector).to_value();
  let id = crate::host::new_id("rebase_forecast");
  let mut forecast = Object::new();
  forecast.set("schema", string("causet.rebase-forecast/v3"));
  forecast.set("id", string(&id));
  for name in [
    "mode",
    "sourceRef",
    "sourceHead",
    "sourceTree",
    "ontoRef",
    "ontoHead",
    "ontoTree",
  ] {
    if let Some(value) = member(name) {
      forecast.set(name, value.clone());
    }
  }
  let or_empty = |name: &str| match member(name) {
    value if nullish(value) => Value::Array(Vec::new()),
    value => or_null(value),
  };
  forecast.set("quarantinedFacts", or_empty("quarantinedFacts"));
  // Pinned beside the heads and trees: a forecast approves one range, and
  // application refuses it for another (ADR-0032).
  for name in ["range", "excludedByRange"] {
    if let Some(value) = member(name) {
      forecast.set(name, value.clone());
    }
  }
  forecast.set("targetWorktree", string(&context.root));
  forecast.set(
    "scope",
    string(if target_overlay.is_some() { "target-checkpoint" } else { "committed-heads" }),
  );
  forecast.set(
    "targetOverlay",
    match &target_overlay {
      Some(Value::Object(overlay)) => {
        let mut overlay = overlay.clone();
        overlay.set("rematerialized", string("uncommitted"));
        Value::Object(overlay)
      }
      _ => Value::Null,
    },
  );
  let predicted = |name: &str| match get(overlay_prediction.as_ref(), name) {
    value if nullish(value) => Value::Null,
    value => or_null(value),
  };
  forecast.set("predictedOverlayTree", predicted("tree"));
  forecast.set("targetOverlayConflict", predicted("conflict"));
  forecast.set(
    "ignoredCallerDirtyFiles",
    Value::Number(ignored_dirty_files(&before.status) as f64),
  );
  forecast.set("acceptCandidates", Value::Bool(options.accept_candidates));
  forecast.set("candidateDecisionRequired", Value::Bool(candidate_decision_required));
  forecast.set(
    "candidatePolicy",
    string(if candidates.is_empty() {
      "none"
    } else if options.accept_candidates {
      "accepted"
    } else {
      "review-required"
    }),
  );
  forecast.set(
    "acceptedCandidates",
    Value::Array(if options.accept_candidates {
      candidates
        .iter()
        .map(|candidate| {
          let mut accepted = match candidate {
            Value::Object(candidate) => candidate.clone(),
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
  forecast.set("planFingerprint", or_null(member("fingerprint")));
  // Lifted out of `plan` so a reader of the forecast sees the preserved
  // topology and the declared program without reading the plan it pins.
  forecast.set("recreatedMerges", or_empty("recreatedMerges"));
  forecast.set("interactive", or_empty("interactive"));
  forecast.set("plan", plan.clone());
  for name in simulation.result.keys() {
    if let Some(value) = simulation.result.get_units(name) {
      forecast.insert(name.clone(), value.clone());
    }
  }
  forecast.set("engine", simulation.engine.map_or(Value::Null, string));
  forecast.set("fallbacks", Value::Array(simulation.fallbacks));
  let mut invariants = Object::new();
  invariants.set("preserved", Value::Bool(true));
  invariants.set("head", string(&before.head));
  invariants.set("tree", string(&before.tree));
  invariants.set("branch", before.branch.as_deref().map_or(Value::Null, string));
  invariants.set("indexDigest", string(&sha256(&before.index)));
  invariants.set("statusDigest", string(&sha256(&before.status)));
  invariants.set("worktreeListDigest", string(&sha256(&before.worktrees)));
  forecast.set("callerInvariants", Value::Object(invariants));
  let mut timings = Object::new();
  timings.set("forecastMs", rounded(elapsed(started)));
  timings.set("phases", Value::Object(phases));
  timings.set("worktree", simulation.worktree_timings);
  timings.set("mergeTree", simulation.merge_tree_timings);
  timings.set("git", git_metrics);
  forecast.set("timings", Value::Object(timings));
  forecast.set("startedAt", string(&started_at));
  forecast.set("createdAt", string(&metrics::iso_now()));
  let forecast = Value::Object(forecast);
  save_forecast(&forecast, &id, cwd)?;
  Ok(forecast)
}

fn plural(count: f64) -> &'static str {
  if count == 1.0 { "" } else { "s" }
}

/// `formatRebaseForecast(forecast)`.
pub fn format_rebase_forecast(forecast: &Value) -> String {
  let member = |name: &str| get(Some(forecast), name);
  let scope = match as_text(member("scope")).as_deref() {
    Some("target-checkpoint") => "committed heads plus a caller overlay",
    _ => "committed heads only",
  };
  let counts = member("counts");
  let plan_counts = get(member("plan"), "counts");
  let same_state = match member("exactStateEqualityAfter") {
    value if nullish(value) => "unknown",
    value if truthy(value) => "yes",
    _ => "no",
  };
  let mut lines = vec![
    if as_text(member("mode")).as_deref() == Some("merge-preserving") {
      "Causal rebase forecast (merge-preserving)".to_string()
    } else {
      "Causal rebase forecast".to_string()
    },
    format!("forecast     {}", js_text(member("id"))),
    format!("status       {}", js_text(member("status"))),
    format!("onto         {} @ {}", js_text(member("ontoRef")), short(member("ontoHead"))),
    format!("source       {} @ {}", js_text(member("sourceRef")), short(member("sourceHead"))),
    format!("scope        {scope}"),
    format!(
      "plan         {} omit, {} review, {} replay",
      js_text(get(plan_counts, "covered")),
      js_text(get(plan_counts, "candidate-equivalent")),
      js_text(get(plan_counts, "new"))
    ),
    format!(
      "simulation   {} clean, {} exact-resolved, {} spec-merged, {} blocked",
      js_text(get(counts, "clean")),
      js_text(get(counts, "exactResolution")),
      js_text(get(counts, "semanticSpec")),
      js_text(get(counts, "blocked"))
    ),
  ];
  let recreated = items(member("recreatedMerges")).len();
  if recreated > 0 {
    lines.push(format!(
      "recreated    {recreated} merge{} preserved as joins",
      plural(recreated as f64)
    ));
  }
  lines.push(format!("predicted    {}", short(member("predictedResultTree"))));
  lines.push(format!("partial      {}", short(member("partialResultTree"))));
  lines.push(format!("same state   {same_state}"));
  lines.push(format!("fingerprint  {}", js_text(member("planFingerprint"))));
  lines.extend(format_forecast_engine(forecast));

  let overlay = member("targetOverlay").filter(|overlay| truthy(Some(overlay)));
  if let Some(overlay) = overlay {
    let field = |name: &str| get(Some(overlay), name);
    lines.push(format!(
      "overlay      checkpoint {} of workspace {}",
      short(field("checkpoint")),
      js_text(field("workspaceName"))
    ));
    lines.push(format!("overlay tree {}", js_text(field("tree"))));
    lines.push(format!(
      "overlay base {}; draft {}",
      short(field("baseHead")),
      js_text(field("draftChangeId")).chars().take(18).collect::<String>()
    ));
    let predicted = member("predictedOverlayTree");
    lines.push(if truthy(predicted) {
      format!(
        "overlay after {} (re-materialized uncommitted; never committed)",
        js_text(predicted)
      )
    } else {
      "overlay after BLOCKED: the overlay does not merge with the rewritten tip".to_string()
    });
    if let Some(conflict) = member("targetOverlayConflict").filter(|conflict| truthy(Some(conflict))) {
      lines.push(format!("  ! {}", js_text(get(Some(conflict), "reason"))));
    }
  }
  // With an overlay the caller's dirty files are the pinned draft, so calling
  // them ignored would say the opposite of what happens to them.
  let dirty = member("ignoredCallerDirtyFiles");
  if truthy(dirty) {
    let suffix = if strict_equals(dirty, Some(&Value::Number(1.0))) { "" } else { "s" };
    lines.push(if overlay.is_some() {
      format!("caller draft {} file{suffix} carried as the overlay", js_text(dirty))
    } else {
      format!("caller dirty {} file{suffix} ignored", js_text(dirty))
    });
  }
  lines.push(String::new());

  let steps = items(member("steps"));
  if steps.is_empty() {
    lines.push("No new source changes required simulation.".into());
  }
  for step in steps {
    let field = |name: &str| get(Some(step), name);
    let outcome = js_text(field("outcome"));
    let marker = if outcome.starts_with("blocked") {
      "!"
    } else if as_text(field("kind")).as_deref() == Some("recreate-merge") {
      "M"
    } else {
      "C"
    };
    lines.push(format!(
      "{marker} {} {} [{outcome}] {} -> {}",
      short(field("sourceCommit")),
      js_text(field("subject")),
      short(field("targetBeforeTree")),
      short(field("resultTree"))
    ));
    for conflict in items(field("conflicts")) {
      let count = length(get(Some(conflict), "candidates"));
      let single = strict_equals(count.as_ref(), Some(&Value::Number(1.0)));
      lines.push(format!(
        "  {}: {} exact candidate{}",
        js_text(get(Some(conflict), "path")),
        js_text(count.as_ref()),
        if single { "" } else { "s" }
      ));
    }
  }
  if truthy(member("blockedReason")) {
    lines.push(String::new());
    lines.push(format!("blocked by   {}", js_text(member("blockedReason"))));
  }
  let accepted = items(member("acceptedCandidates")).len();
  if accepted > 0 {
    lines.push(String::new());
    lines.push(format!(
      "accepted     {accepted} heuristic candidate{} as explicit omissions",
      plural(accepted as f64)
    ));
  }
  lines.push(String::new());
  let changed = matches!(get(member("callerInvariants"), "preserved"), Some(Value::Bool(false)));
  lines.push(
    if changed {
      "The caller worktree changed during forecasting; this forecast is not usable."
    } else {
      "The caller HEAD, branch, index, status, files, and worktree list were not changed."
    }
    .to_string(),
  );
  if as_text(member("status")).as_deref() == Some("unsupported") {
    for merge in items(get(get(member("plan"), "constraints"), "unsupportedMerges")) {
      lines.push(format!(
        "unsupported  {} {}: {}",
        js_text(get(Some(merge), "commit")).chars().take(12).collect::<String>(),
        js_text(get(Some(merge), "reason")),
        js_text(get(Some(merge), "details"))
      ));
    }
  } else if truthy(member("candidateDecisionRequired")) {
    lines.push("Review the heuristic candidates, then regenerate with:".into());
    lines.push(format!(
      "  cst rebase-forecast {} {} --accept-candidates",
      js_text(member("ontoRef")),
      js_text(member("sourceRef"))
    ));
  } else {
    lines.push("The forecast is pinned for the future rebase application slice.".into());
  }
  lines.join("\n")
}
