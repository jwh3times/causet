//! `cst forecast`: `forecastReconciliation` of `src/forecasts.js`, the plan
//! simulator it drives under either forecast engine (ADR-0016), and
//! `formatForecast` of `src/cli.js`.
//!
//! The simulator here runs the queue a reconciliation replays: one pick per
//! new change. A causal rebase's program (recreated merges, absorbed changes,
//! `edit`, omitted steps; ADR-0034 and ADR-0035) is the rest of
//! `simulatePlan`, and arrives with the rebase port (#148).

use crate::records::short;
use crate::resolve::{
  capture_conflict_descriptors, capture_resolution_outcomes, materialize_resolution_candidate,
  read_journal,
};
use crate::spec::{
  compact_spec_merge, materialize_spec_merge, plan_spec_merge, spec_files_for_conflict_paths,
};
use crate::target_overlay::{predict_overlay_tree, resolve_target_overlay};
use causet_engine::errors::{GitError, GitResult};
use causet_engine::locations::runtime_directory;
use causet_engine::merge_tree::{MERGE_TREE_ENGINE_MIN_GIT, MergeTreeSession};
use causet_engine::process::{GIT_NO_RERERE, RunOptions, run_git};
use causet_engine::session::with_object_session;
use causet_engine::{engine, metrics, text};
use causet_model::js::{get, length, nullish, strict_equals, text as js_text, to_fixed, to_number, truthy};
use causet_model::json::{Object, Value, lossy, string, stringify, stringify_pretty};
use std::time::Instant;

fn as_text(value: Option<&Value>) -> Option<String> {
  match value {
    Some(Value::String(units)) => Some(lossy(units)),
    _ => None,
  }
}

fn owned(args: &[&str]) -> Vec<String> {
  args.iter().map(|arg| (*arg).to_string()).collect()
}

fn git(args: &[&str], cwd: &str) -> GitResult<causet_engine::process::GitOutput> {
  run_git(&owned(args), &RunOptions::new(cwd))
}

fn git_allowing_failure(args: &[&str], cwd: &str) -> GitResult<causet_engine::process::GitOutput> {
  run_git(&owned(args), &RunOptions::new(cwd).allow_failure())
}

/// Milliseconds since `started`, as `performance.now()` differences are.
fn elapsed(started: Instant) -> f64 {
  started.elapsed().as_secs_f64() * 1000.0
}

/// `Number(value.toFixed(2))`.
fn rounded(value: f64) -> Value {
  Value::Number(to_fixed(value, 2).parse().unwrap_or(0.0))
}

/// `{ setupMs, applicationMs, cleanupMs, totalMs }`, rounded.
fn timings(setup: f64, application: f64, cleanup: f64, total: f64) -> Value {
  let mut object = Object::new();
  object.set("setupMs", rounded(setup));
  object.set("applicationMs", rounded(application));
  object.set("cleanupMs", rounded(cleanup));
  object.set("totalMs", rounded(total));
  Value::Object(object)
}

/// `zeroTimings()`.
fn zero_timings() -> Value {
  timings(0.0, 0.0, 0.0, 0.0)
}

/// Copies `source[name]` onto `target` when it is defined.
fn copy(target: &mut Object, source: &Value, name: &str) {
  if let Some(value) = get(Some(source), name) {
    target.set(name, value.clone());
  }
}

/// `planFingerprint(plan)`: what a forecast's approval covers.
pub(crate) fn plan_fingerprint(plan: &Value) -> String {
  let mut document = Object::new();
  for name in [
    "targetHead",
    "sourceHead",
    "targetTree",
    "sourceTree",
    "physicalBase",
    "effectiveBase",
    "reachableReceipts",
  ] {
    copy(&mut document, plan, name);
  }
  let changes = match get(Some(plan), "changes") {
    Some(Value::Array(items)) => items
      .iter()
      .map(|change| {
        let mut compact = Object::new();
        for name in ["commit", "changeId", "status", "proof"] {
          copy(&mut compact, change, name);
        }
        Value::Object(compact)
      })
      .collect(),
    _ => Vec::new(),
  };
  document.set("changes", Value::Array(changes));
  causet_model::sha256::hex(stringify(&Value::Object(document)).as_bytes())
}

/// `simulationCounts(steps)`.
fn simulation_counts(steps: &[Value]) -> Value {
  let (mut clean, mut exact, mut exact_paths, mut semantic, mut semantic_paths, mut blocked) =
    (0, 0, 0, 0, 0, 0);
  for step in steps {
    let outcome = as_text(get(Some(step), "outcome")).unwrap_or_default();
    if outcome == "clean" {
      clean += 1;
    }
    if let Some(Value::Array(resolutions)) = get(Some(step), "resolutions") {
      if !resolutions.is_empty() {
        exact += 1;
        exact_paths += resolutions.len();
      }
    }
    if let Some(Value::Array(merges)) = get(Some(step), "semanticMerges") {
      if !merges.is_empty() {
        semantic += 1;
        semantic_paths += merges.len();
      }
    }
    if outcome.starts_with("blocked") {
      blocked += 1;
    }
  }
  let mut counts = Object::new();
  for (name, value) in [
    ("clean", clean),
    ("exactResolution", exact),
    ("exactResolutionPaths", exact_paths),
    ("semanticSpec", semantic),
    ("semanticSpecPaths", semantic_paths),
    ("blocked", blocked),
  ] {
    counts.set(name, Value::Number(value as f64));
  }
  Value::Object(counts)
}

fn candidate_count(conflict: &Value) -> usize {
  match get(Some(conflict), "candidates") {
    Some(Value::Array(items)) => items.len(),
    _ => 0,
  }
}

/// `blockedReason(conflicts)`.
fn blocked_reason(conflicts: &[&Value]) -> &'static str {
  let missing: Vec<&&Value> = conflicts.iter().filter(|conflict| candidate_count(conflict) == 0).collect();
  let ambiguous = conflicts.iter().any(|conflict| candidate_count(conflict) > 1);
  if !missing.is_empty() && ambiguous {
    return "missing-and-ambiguous-resolutions";
  }
  let semantic_conflicts = |conflict: &Value| match get(get(Some(conflict), "semanticSpec"), "conflicts") {
    Some(Value::Array(items)) => items.clone(),
    _ => Vec::new(),
  };
  if missing.iter().any(|conflict| {
    semantic_conflicts(conflict)
      .iter()
      .any(|item| as_text(get(Some(item), "type")).as_deref() == Some("semantic-metadata-unavailable"))
  }) {
    return "semantic-spec-metadata-unavailable";
  }
  if missing.iter().any(|conflict| !semantic_conflicts(conflict).is_empty()) {
    return "semantic-spec-conflict";
  }
  if !missing.is_empty() {
    return "missing-exact-resolution";
  }
  if ambiguous {
    return "ambiguous-exact-resolution";
  }
  "unresolved-conflict"
}

/// What `simulatePlan` returns: the result members, the engine that answered,
/// the fallbacks taken, and both engines' timings.
struct Simulation {
  result: Object,
  engine: &'static str,
  fallbacks: Vec<Value>,
  worktree_timings: Value,
  merge_tree_timings: Value,
}

/// The ends of a simulation: where it starts, what it should reach, and how
/// its steps are related to their origins.
struct Bounds<'a> {
  target_head: &'a str,
  expected_result_tree: &'a str,
  clean_relation: &'a str,
  contextual_relation: &'a str,
}

/// A step of the merge-tree engine or a change of the queue: the change's
/// identity members, in the order a step lists them.
fn step_identity(change: &Value) -> Object {
  let mut step = Object::new();
  step.set("sourceCommit", get(Some(change), "commit").cloned().unwrap_or(Value::Null));
  copy(&mut step, change, "changeId");
  copy(&mut step, change, "subject");
  step
}

/// `simulatePlanWithMergeTree(cwd, options)`: a queue of clean picks merged
/// onto one accumulating tree by one `git merge-tree --stdin` process. Any
/// case the worktree simulator would not label `clean` is handed back to it
/// as a fallback, with the timings spent so far.
fn simulate_with_merge_tree(
  cwd: &str,
  bounds: &Bounds,
  queue: &[&Value],
) -> GitResult<Result<(Object, Value), (Value, Value)>> {
  let total_started = Instant::now();
  let mut setup_ms: Option<f64> = None;
  let mut application_started: Option<Instant> = None;
  let fallback = |reason: &str,
                  extra: Vec<(&str, Value)>,
                  setup_ms: Option<f64>,
                  application_started: Option<Instant>| {
    let total = elapsed(total_started);
    let mut fallback = Object::new();
    fallback.set("engine", string("merge-tree"));
    fallback.set("reason", string(reason));
    for (name, value) in extra {
      fallback.set(name, value);
    }
    let timings = timings(
      setup_ms.unwrap_or(total),
      application_started.map_or(0.0, elapsed),
      0.0,
      total,
    );
    Err((Value::Object(fallback), timings))
  };
  let mut expressions = vec![format!("{}^{{tree}}", bounds.target_head)];
  for change in queue {
    let commit = js_text(get(Some(change), "commit"));
    expressions.push(format!("{commit}^{{tree}}"));
    expressions.push(format!("{commit}^^{{tree}}"));
    expressions.push(format!("{commit}^2^{{commit}}"));
    expressions.push(format!("{commit}:.gitattributes"));
    expressions.push(format!("{commit}^:.gitattributes"));
  }
  let objects = engine::inspect_git_objects(&expressions, cwd)?.records;
  let is_tree = |index: usize| objects[index].exists && objects[index].kind.as_deref() == Some("tree");
  if !is_tree(0) {
    return Ok(fallback("target-tree-unavailable", Vec::new(), setup_ms, application_started));
  }
  let target_tree = objects[0].oid.clone().unwrap_or_default();
  let mut inputs = Vec::new();
  for (index, change) in queue.iter().enumerate() {
    let at = |offset: usize| 1 + index * 5 + offset;
    let commit = get(Some(change), "commit").cloned().unwrap_or(Value::Null);
    let located = |extra: Vec<(&'static str, Value)>| {
      let mut members = vec![("step", Value::Number(index as f64)), ("sourceCommit", commit.clone())];
      members.extend(extra);
      members
    };
    if objects[at(2)].exists {
      return Ok(fallback("merge-commit", located(Vec::new()), setup_ms, application_started));
    }
    if !is_tree(at(0)) {
      return Ok(fallback("change-tree-unavailable", located(Vec::new()), setup_ms, application_started));
    }
    if !is_tree(at(1)) {
      return Ok(fallback("root-commit", located(Vec::new()), setup_ms, application_started));
    }
    if index < queue.len() - 1 {
      let attribute_path = match get(Some(change), "changedPaths") {
        Some(Value::Array(paths)) => paths.iter().find_map(|path| {
          let path = as_text(Some(path))?;
          (path == ".gitattributes" || path.ends_with("/.gitattributes")).then_some(path)
        }),
        _ => None,
      };
      if let Some(path) = attribute_path {
        return Ok(fallback(
          "attributes-changed",
          located(vec![("path", string(&path))]),
          setup_ms,
          application_started,
        ));
      }
      let after = &objects[at(3)];
      let before = &objects[at(4)];
      if after.exists != before.exists || after.oid != before.oid {
        return Ok(fallback(
          "attributes-changed",
          located(vec![("path", string(".gitattributes"))]),
          setup_ms,
          application_started,
        ));
      }
    }
    inputs.push((
      *change,
      objects[at(0)].oid.clone().unwrap_or_default(),
      objects[at(1)].oid.clone().unwrap_or_default(),
    ));
  }
  setup_ms = Some(elapsed(total_started));

  let mut steps = Vec::new();
  let mut accumulated = target_tree.clone();
  let mut session = MergeTreeSession::new(cwd, Some(&target_tree));
  application_started = Some(Instant::now());
  for (index, (change, change_tree, parent_tree)) in inputs.iter().enumerate() {
    let commit = get(Some(change), "commit").cloned().unwrap_or(Value::Null);
    let located = |extra: Vec<(&'static str, Value)>| {
      let mut members = vec![("step", Value::Number(index as f64)), ("sourceCommit", commit.clone())];
      members.extend(extra);
      members
    };
    let merged = match session.merge(parent_tree, &accumulated, change_tree) {
      Ok(merged) => merged,
      Err(error) => {
        let too_old = |version: Option<String>| {
          let mut extra = vec![("requiredGit", string(MERGE_TREE_ENGINE_MIN_GIT))];
          if let Some(version) = version {
            extra.push(("git", string(&version)));
          }
          extra.push(("detail", string(&error.message)));
          located(extra)
        };
        let outcome = if error.session_failure.as_deref() == Some("too-old") {
          fallback("git-too-old", too_old(error.git_version.clone()), setup_ms, application_started)
        } else if index == 0
          && error.session_failure.as_deref() == Some("exited")
          && !engine::git_at_least(MERGE_TREE_ENGINE_MIN_GIT, cwd)?
        {
          let raw = engine::git_version(cwd)?.raw;
          fallback("git-too-old", too_old(Some(raw)), setup_ms, application_started)
        } else {
          fallback(
            "merge-tree-unavailable",
            located(vec![("detail", string(&error.message))]),
            setup_ms,
            application_started,
          )
        };
        session.close();
        return Ok(outcome);
      }
    };
    if !merged.clean {
      let outcome = fallback("conflicted-step", located(Vec::new()), setup_ms, application_started);
      session.close();
      return Ok(outcome);
    }
    if merged.tree == accumulated {
      let outcome = fallback("empty-step", located(Vec::new()), setup_ms, application_started);
      session.close();
      return Ok(outcome);
    }
    let mut step = step_identity(change);
    step.set("outcome", string("clean"));
    step.set("relation", string(bounds.clean_relation));
    step.set("targetBeforeTree", string(&accumulated));
    step.set("resultTree", string(&merged.tree));
    steps.push(Value::Object(step));
    accumulated = merged.tree;
  }
  let application_ms = application_started.map_or(0.0, elapsed);
  let cleanup_started = Instant::now();
  session.close();
  let cleanup_ms = elapsed(cleanup_started);
  let count = steps.len();
  let mut ordered = Object::new();
  ordered.set("status", string("complete"));
  ordered.set("blockedReason", Value::Null);
  ordered.set("steps", Value::Array(steps.clone()));
  ordered.set("approvedResolutions", Value::Array(Vec::new()));
  ordered.set("approvedSpecMerges", Value::Array(Vec::new()));
  ordered.set("counts", simulation_counts(&steps));
  ordered.set("simulatedChanges", Value::Number(count as f64));
  ordered.set("remainingChanges", Value::Number(0.0));
  ordered.set("partialResultTree", string(&accumulated));
  ordered.set("predictedResultTree", string(&accumulated));
  ordered.set("exactStateEqualityAfter", Value::Bool(accumulated == bounds.expected_result_tree));
  Ok(Ok((
    ordered,
    timings(
      setup_ms.unwrap_or(0.0),
      application_ms,
      cleanup_ms,
      elapsed(total_started),
    ),
  )))
}

/// `withTemporaryWorktree(targetHead, cwd, callback)`: the callback run in a
/// detached worktree at `targetHead`, which is removed afterwards whatever
/// the callback did.
fn with_temporary_worktree(
  target_head: &str,
  cwd: &str,
  callback: impl FnOnce(&str) -> GitResult<Object>,
) -> GitResult<(Object, Value)> {
  let total_started = Instant::now();
  let root = crate::export::temporary_directory("vcs-lab-forecast-")?;
  let worktree = text::join(&root, "worktree");
  let mut added = false;
  let mut value: Option<Object> = None;
  let mut failure: Option<GitError> = None;
  let (mut setup_ms, mut callback_ms) = (0.0, 0.0);
  let setup_started = Instant::now();
  match git(&["worktree", "add", "--detach", &worktree, target_head], cwd) {
    Ok(_) => {
      added = true;
      setup_ms = elapsed(setup_started);
      let callback_started = Instant::now();
      match with_object_session(&worktree, || callback(&worktree)) {
        Ok(result) => {
          value = Some(result);
          callback_ms = elapsed(callback_started);
        }
        Err(error) => failure = Some(error),
      }
    }
    Err(error) => failure = Some(error),
  }
  let cleanup_started = Instant::now();
  let mut prune_after_removal = false;
  if added {
    // Only a blocked run, or one that failed, can leave a pick or a merge
    // pending; aborting when nothing is pending is harmless.
    let complete = value
      .as_ref()
      .is_some_and(|result| as_text(result.get("status")).as_deref() == Some("complete"));
    if !complete && std::path::Path::new(&worktree).exists() {
      for command in ["cherry-pick", "merge"] {
        git_allowing_failure(&[command, "--abort"], &worktree)?;
      }
    }
    let removed = git_allowing_failure(&["worktree", "remove", "--force", &worktree], cwd)?;
    prune_after_removal = !removed.ok;
  }
  match std::fs::remove_dir_all(&root) {
    Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
      return Err(crate::envelope::io_failure(&error, "rm", &root));
    }
    _ => {}
  }
  if prune_after_removal {
    git(&["worktree", "prune"], cwd)?;
  }
  let cleanup_ms = elapsed(cleanup_started);
  if let Some(error) = failure {
    return Err(error);
  }
  Ok((
    value.unwrap_or_default(),
    timings(setup_ms, callback_ms, cleanup_ms, elapsed(total_started)),
  ))
}

/// The worktree simulator's loop over a reconciliation's queue: each change
/// picked onto the last, its conflicts settled only by a deterministic spec
/// merge or an exact retained resolution, and anything else a stop.
fn simulate_queue(worktree: &str, bounds: &Bounds, queue: &[&Value]) -> GitResult<Object> {
  let mut steps: Vec<Value> = Vec::new();
  let mut approved_resolutions = Vec::new();
  let mut approved_spec_merges = Vec::new();
  let mut status = "complete";
  let mut reason = Value::Null;
  for change in queue {
    let commit = js_text(get(Some(change), "commit"));
    let target_before = engine::current_head(worktree)?;
    let target_before_tree = engine::tree_id(&target_before, worktree)?;
    let mut pick = GIT_NO_RERERE.to_vec();
    pick.extend(["cherry-pick", "-x", &commit]);
    let applied = git_allowing_failure(&pick, worktree)?;
    let mut step = step_identity(change);
    if applied.ok {
      step.set("outcome", string("clean"));
      step.set("kind", string("pick"));
      step.set(
        "action",
        match get(Some(change), "action") {
          value if nullish(value) => string("replay"),
          value => value.cloned().unwrap_or(Value::Null),
        },
      );
      step.set("relation", string(bounds.clean_relation));
      step.set("targetBeforeTree", string(&target_before_tree));
      step.set("resultTree", string(&engine::tree_id("HEAD", worktree)?));
      steps.push(Value::Object(step));
      continue;
    }

    let paths = engine::unmerged_paths(worktree)?;
    if paths.is_empty() {
      status = "blocked";
      reason = string("git-application-error");
      step.set("outcome", string("blocked-git-error"));
      step.set("kind", string("pick"));
      step.set("targetBeforeTree", string(&target_before_tree));
      step.set("gitOutput", string(&applied.output));
      steps.push(Value::Object(step));
      break;
    }

    let mut conflicts = capture_conflict_descriptors(&paths, worktree)?;
    let path_values = Value::Array(paths.iter().map(|path| string(path)).collect());
    let mut semantic_plans = Vec::new();
    for file in spec_files_for_conflict_paths(Some(&path_values))? {
      semantic_plans.push(plan_spec_merge(
        &js_text(Some(&file)),
        [
          Some(string(&format!("{commit}^"))),
          Some(string(&target_before)),
          Some(string(&commit)),
        ],
        worktree,
      )?);
    }
    for semantic_plan in &semantic_plans {
      let descriptor = conflicts.iter_mut().find(|conflict| {
        let path = get(Some(conflict), "path");
        strict_equals(path, get(Some(semantic_plan), "file"))
          || strict_equals(path, get(Some(semantic_plan), "manifestFile"))
      });
      if let Some(Value::Object(descriptor)) = descriptor {
        descriptor.set("semanticSpec", compact_spec_merge(semantic_plan, Value::Null));
      }
    }

    let mut semantic_merges = Vec::new();
    let mut semantically_resolved: Vec<String> = Vec::new();
    for semantic_plan in semantic_plans
      .iter()
      .filter(|plan| as_text(get(Some(plan), "status")).as_deref() == Some("clean"))
    {
      materialize_spec_merge(semantic_plan, worktree)?;
      let outcome = compact_spec_merge(semantic_plan, string("forecast-batch"));
      if let Some(Value::Array(resolved)) = get(Some(&outcome), "resolvedPaths") {
        for path in resolved.iter().filter_map(|path| as_text(Some(path))) {
          if paths.contains(&path) && !semantically_resolved.contains(&path) {
            semantically_resolved.push(path);
          }
        }
      }
      let mut approved = Object::new();
      approved.set("algorithm", get(Some(&outcome), "algorithm").cloned().unwrap_or(Value::Null));
      approved.set("sourceCommit", string(&commit));
      approved.set("path", get(Some(&outcome), "path").cloned().unwrap_or(Value::Null));
      approved.set("signature", get(Some(&outcome), "signature").cloned().unwrap_or(Value::Null));
      approved.set(
        "resultMarkdownHash",
        get(Some(&outcome), "resultMarkdownHash").cloned().unwrap_or(Value::Null),
      );
      approved.set(
        "resultManifestHash",
        get(Some(&outcome), "resultManifestHash").cloned().unwrap_or(Value::Null),
      );
      approved_spec_merges.push(Value::Object(approved));
      semantic_merges.push(outcome);
    }
    let exact: Vec<usize> = conflicts
      .iter()
      .enumerate()
      .filter(|(_, conflict)| {
        as_text(get(Some(conflict), "path")).is_none_or(|path| !semantically_resolved.contains(&path))
      })
      .map(|(index, _)| index)
      .collect();
    if !exact.iter().all(|index| candidate_count(&conflicts[*index]) == 1) {
      status = "blocked";
      reason = string(blocked_reason(&exact.iter().map(|index| &conflicts[*index]).collect::<Vec<_>>()));
      step.set("outcome", string("blocked-conflict"));
      step.set("kind", string("pick"));
      step.set("targetBeforeTree", string(&target_before_tree));
      step.set("conflicts", Value::Array(conflicts));
      step.set("semanticMerges", Value::Array(semantic_merges));
      steps.push(Value::Object(step));
      break;
    }

    for index in &exact {
      let candidate = match get(Some(&conflicts[*index]), "candidates") {
        Some(Value::Array(items)) => items[0].clone(),
        _ => Value::Null,
      };
      materialize_resolution_candidate(Some(&conflicts[*index]), Some(&candidate), worktree)?;
      if let Value::Object(conflict) = &mut conflicts[*index] {
        conflict.set("selectedResolutionId", get(Some(&candidate), "id").cloned().unwrap_or(Value::Null));
        conflict.set("selectionMethod", string("forecast-batch"));
      }
    }
    let exact_conflicts: Vec<Value> = exact.iter().map(|index| conflicts[*index].clone()).collect();
    let resolutions = capture_resolution_outcomes(&exact_conflicts, worktree)?;
    let mut finish = GIT_NO_RERERE.to_vec();
    finish.extend(["-c", "core.editor=true", "cherry-pick", "--continue"]);
    let continued = git_allowing_failure(&finish, worktree)?;
    if !continued.ok {
      status = "blocked";
      reason = string("exact-resolution-application-error");
      step.set("outcome", string("blocked-resolution-application"));
      step.set("kind", string("pick"));
      step.set("targetBeforeTree", string(&target_before_tree));
      step.set("conflicts", Value::Array(conflicts));
      step.set("semanticMerges", Value::Array(semantic_merges));
      step.set("resolutions", Value::Array(resolutions));
      step.set("gitOutput", string(&continued.output));
      steps.push(Value::Object(step));
      break;
    }

    for resolution in &resolutions {
      let mut approved = Object::new();
      approved.set("sourceCommit", string(&commit));
      for (name, from) in [
        ("path", "path"),
        ("signature", "signature"),
        ("resolutionId", "selectedResolutionId"),
        ("resultBlob", "resultBlob"),
      ] {
        if let Some(value) = get(Some(resolution), from) {
          approved.set(name, value.clone());
        }
      }
      approved_resolutions.push(Value::Object(approved));
    }
    let outcome = match (semantic_merges.is_empty(), resolutions.is_empty()) {
      (false, false) => "semantic-spec-and-exact-resolution",
      (false, true) => "semantic-spec-merge",
      _ => "exact-resolution",
    };
    step.set("outcome", string(outcome));
    step.set("kind", string("pick"));
    step.set("relation", string(bounds.contextual_relation));
    step.set("targetBeforeTree", string(&target_before_tree));
    step.set("conflicts", Value::Array(conflicts));
    step.set("resolutions", Value::Array(resolutions));
    step.set("semanticMerges", Value::Array(semantic_merges));
    step.set("resultTree", string(&engine::tree_id("HEAD", worktree)?));
    steps.push(Value::Object(step));
  }

  let partial = engine::tree_id("HEAD", worktree)?;
  let complete = status == "complete";
  let simulated = steps.len();
  let counts = simulation_counts(&steps);
  let mut ordered = Object::new();
  ordered.set("status", string(status));
  ordered.set("blockedReason", reason);
  ordered.set("steps", Value::Array(steps));
  ordered.set("approvedResolutions", Value::Array(approved_resolutions));
  ordered.set("approvedSpecMerges", Value::Array(approved_spec_merges));
  ordered.set("counts", counts);
  ordered.set("simulatedChanges", Value::Number(simulated as f64));
  ordered.set(
    "remainingChanges",
    Value::Number(queue.len() as f64 - simulated as f64),
  );
  ordered.set("partialResultTree", string(&partial));
  ordered.set("predictedResultTree", if complete { string(&partial) } else { Value::Null });
  ordered.set(
    "exactStateEqualityAfter",
    if complete {
      Value::Bool(partial == bounds.expected_result_tree)
    } else {
      Value::Null
    },
  );
  Ok(ordered)
}

/// `simulatePlan(plan, cwd)` for a reconciliation: the merge-tree engine when
/// it is selected and can answer, and the temporary-worktree simulator, the
/// oracle, otherwise.
fn simulate_plan(plan: &Value, cwd: &str) -> GitResult<Simulation> {
  let target_head = js_text(get(Some(plan), "targetHead"));
  let expected_result_tree = js_text(get(Some(plan), "sourceTree"));
  let bounds = Bounds {
    target_head: &target_head,
    expected_result_tree: &expected_result_tree,
    clean_relation: "causal-reconciliation",
    contextual_relation: "contextual-application",
  };
  let queue: Vec<&Value> = match get(Some(plan), "changes") {
    Some(Value::Array(changes)) => changes
      .iter()
      .filter(|change| as_text(get(Some(change), "status")).as_deref() == Some("new"))
      .collect(),
    _ => Vec::new(),
  };
  let mut fallbacks = Vec::new();
  let mut merge_tree_timings = zero_timings();
  if engine::forecast_engine()? == "merge-tree" {
    match simulate_with_merge_tree(cwd, &bounds, &queue)? {
      Ok((result, timings)) => {
        return Ok(Simulation {
          result,
          engine: "merge-tree",
          fallbacks,
          worktree_timings: zero_timings(),
          merge_tree_timings: timings,
        });
      }
      Err((fallback, timings)) => {
        merge_tree_timings = timings;
        fallbacks.push(fallback);
      }
    }
  }
  let (result, worktree_timings) =
    with_temporary_worktree(&target_head, cwd, |worktree| simulate_queue(worktree, &bounds, &queue))?;
  Ok(Simulation {
    result,
    engine: "worktree",
    fallbacks,
    worktree_timings,
    merge_tree_timings,
  })
}

/// `HEAD^{commit}`, `HEAD^{tree}` and the porcelain status: what forecasting
/// must leave exactly as it found.
fn worktree_state(cwd: &str) -> GitResult<(String, String, String)> {
  let ids = engine::resolve_object_ids(&owned(&["HEAD^{commit}", "HEAD^{tree}"]), cwd)?;
  let status = engine::porcelain_status(cwd, false)?;
  let mut ids = ids.into_iter();
  Ok((
    ids.next().unwrap_or_default(),
    ids.next().unwrap_or_default(),
    status,
  ))
}

/// `saveForecast(forecast, cwd)`: the forecast under this worktree's runtime
/// directory, written whole or not at all.
fn save_forecast(forecast: &Value, id: &str, cwd: &str) -> GitResult<()> {
  let git_dir = engine::repo_context(cwd)?.git_dir;
  let directory = text::join(&runtime_directory(&git_dir, cwd)?, "forecasts");
  let path = text::join(&directory, &format!("{id}.json"));
  std::fs::create_dir_all(&directory)
    .map_err(|error| crate::envelope::io_failure(&error, "mkdir", &directory))?;
  let temporary = format!("{path}.tmp-{}", std::process::id());
  std::fs::write(&temporary, format!("{}\n", stringify_pretty(forecast)))
    .map_err(|error| crate::envelope::io_failure(&error, "open", &temporary))?;
  std::fs::rename(&temporary, &path).map_err(|error| crate::envelope::io_failure(&error, "rename", &temporary))
}

/// Sets members of the simulation result in place, as the forecast does when
/// it withholds an approval.
fn withhold(result: &mut Object, status: &str, reason: Value) {
  result.set("status", string(status));
  result.set("blockedReason", reason);
  result.set("predictedResultTree", Value::Null);
  result.set("exactStateEqualityAfter", Value::Null);
}

/// `forecastReconciliation(sourceRef, { targetCheckpoint, acceptCandidates })`:
/// a prediction of what reconciling `sourceRef` into this worktree would do,
/// simulated away from it and saved for `cst reconcile --use-forecast`.
pub fn forecast_reconciliation(
  source_ref: &str,
  target_checkpoint: bool,
  accept_candidates: bool,
  cwd: &str,
) -> GitResult<Value> {
  with_object_session(cwd, || {
    forecast_in_session(source_ref, target_checkpoint, accept_candidates, cwd)
  })
}

fn forecast_in_session(
  source_ref: &str,
  target_checkpoint: bool,
  accept_candidates: bool,
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
      "Finish or abort the current VCS Lab operation before forecasting another.",
    ));
  }
  // Resolved before any planning, so a worktree that cannot supply an overlay
  // refuses without having simulated anything.
  let target_overlay = if target_checkpoint {
    Some(resolve_target_overlay(cwd)?)
  } else {
    None
  };
  let started_at = metrics::iso_now();
  let started = Instant::now();
  let collector = metrics::begin("forecast");
  let mut phases = Object::new();
  let preflight_started = Instant::now();
  let before = worktree_state(cwd)?;
  phases.set("preflightMs", rounded(elapsed(preflight_started)));
  let planning_started = Instant::now();
  let plan = crate::plan::merge_plan(source_ref, cwd)?;
  phases.set("planningMs", rounded(elapsed(planning_started)));
  let simulation_started = Instant::now();
  let mut simulation = simulate_plan(&plan, cwd)?;
  phases.set("simulationMs", rounded(elapsed(simulation_started)));
  let candidates = get(get(Some(&plan), "counts"), "candidate-equivalent");
  let candidate_decision_required =
    candidates.is_some_and(|count| to_number(count) > 0.0) && !accept_candidates;
  if candidate_decision_required
    && as_text(simulation.result.get("status")).as_deref() == Some("complete")
  {
    withhold(
      &mut simulation.result,
      "review-required",
      string("heuristic-candidate-decision-required"),
    );
  }
  // The overlay prediction runs on trees, never on live bytes, so it cannot
  // disturb the worktree the invariant check is about to compare.
  let mut overlay_prediction: Option<Value> = None;
  if let Some(overlay) = &target_overlay {
    let prediction = match simulation.result.get("predictedResultTree") {
      Some(Value::String(units)) if !units.is_empty() => predict_overlay_tree(
        &before.1,
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
      let reason = get(Some(conflict), "reason").cloned().unwrap_or(Value::Null);
      withhold(&mut simulation.result, "blocked-target-overlay", reason);
    }
    overlay_prediction = Some(prediction);
  }
  let invariant_started = Instant::now();
  let after = worktree_state(cwd)?;
  if before != after {
    metrics::end(collector);
    return Err(GitError::new(
      "internal-invariant",
      "Forecasting unexpectedly changed the current worktree.",
    ));
  }
  phases.set("invariantCheckMs", rounded(elapsed(invariant_started)));

  let context = engine::repo_context(cwd)?;
  let git_metrics = metrics::end(collector).to_value();
  let id = crate::host::new_id("forecast");
  let mut forecast = Object::new();
  forecast.set("schema", string("causet.forecast/v2"));
  forecast.set("id", string(&id));
  forecast.set("sourceRef", string(source_ref));
  forecast.set("sourceHead", get(Some(&plan), "sourceHead").cloned().unwrap_or(Value::Null));
  forecast.set("targetHead", get(Some(&plan), "targetHead").cloned().unwrap_or(Value::Null));
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
    value => value.cloned().unwrap_or(Value::Null),
  };
  forecast.set("predictedOverlayTree", predicted("tree"));
  forecast.set("targetOverlayConflict", predicted("conflict"));
  let dirty = before
    .2
    .split('\n')
    .map(|line| line.strip_suffix('\r').unwrap_or(line))
    .filter(|line| !line.is_empty())
    .count();
  forecast.set("ignoredTargetDirtyFiles", Value::Number(dirty as f64));
  forecast.set("acceptCandidates", Value::Bool(accept_candidates));
  forecast.set("candidateDecisionRequired", Value::Bool(candidate_decision_required));
  forecast.set("planFingerprint", string(&plan_fingerprint(&plan)));
  // Lifted out of the plan so a reader of the forecast alone sees that
  // coverage rested on reduced evidence (ADR-0030).
  forecast.set(
    "quarantinedFacts",
    match get(Some(&plan), "quarantinedFacts") {
      value if nullish(value) => Value::Array(Vec::new()),
      value => value.cloned().unwrap_or(Value::Null),
    },
  );
  forecast.set("plan", plan.clone());
  for name in [
    "status",
    "blockedReason",
    "steps",
    "approvedResolutions",
    "approvedSpecMerges",
    "counts",
    "simulatedChanges",
    "remainingChanges",
    "partialResultTree",
    "predictedResultTree",
    "exactStateEqualityAfter",
  ] {
    forecast.set(name, simulation.result.get(name).cloned().unwrap_or(Value::Null));
  }
  forecast.set("engine", string(simulation.engine));
  forecast.set("fallbacks", Value::Array(simulation.fallbacks));
  forecast.set("workspaceComparison", Value::Null);
  let mut forecast_timings = Object::new();
  forecast_timings.set("forecastMs", rounded(elapsed(started)));
  forecast_timings.set("phases", Value::Object(phases));
  forecast_timings.set("worktree", simulation.worktree_timings);
  forecast_timings.set("mergeTree", simulation.merge_tree_timings);
  forecast_timings.set("git", git_metrics);
  forecast.set("timings", Value::Object(forecast_timings));
  forecast.set("startedAt", string(&started_at));
  forecast.set("createdAt", string(&metrics::iso_now()));
  let forecast = Value::Object(forecast);
  save_forecast(&forecast, &id, cwd)?;
  Ok(forecast)
}

/// `value.toFixed(2)` of a timing.
pub(crate) fn fixed(value: Option<&Value>) -> String {
  match value {
    Some(Value::Number(number)) => to_fixed(*number, 2),
    _ => js_text(value),
  }
}

/// `formatForecastEngine(forecast)`.
pub(crate) fn format_forecast_engine(forecast: &Value) -> Vec<String> {
  let mut lines = Vec::new();
  let engine = get(Some(forecast), "engine");
  if truthy(engine) {
    lines.push(format!("engine       {}", js_text(engine)));
  }
  if let Some(Value::Array(fallbacks)) = get(Some(forecast), "fallbacks") {
    for fallback in fallbacks {
      let step = get(Some(fallback), "step");
      let place = match step {
        None => String::new(),
        Some(step) => {
          let commit = get(Some(fallback), "sourceCommit");
          format!(
            " at step {}{}",
            causet_model::json::number_to_string(to_number(step) + 1.0),
            if truthy(commit) { format!(" ({})", short(commit)) } else { String::new() }
          )
        }
      };
      lines.push(format!(
        "fallback     {} -> {}: {}{place}",
        js_text(get(Some(fallback), "engine")),
        js_text(engine),
        js_text(get(Some(fallback), "reason"))
      ));
    }
  }
  lines
}

/// `formatGitActivity(git)`.
pub(crate) fn git_activity(git: Option<&Value>) -> Option<String> {
  if !truthy(git) {
    return None;
  }
  let processes = match get(git, "processes") {
    value if nullish(value) => get(git, "count"),
    value => value,
  };
  Some(format!(
    "git work     {} processes; {} queries ({} ms)",
    js_text(processes),
    js_text(get(git, "count")),
    fixed(get(git, "totalMs"))
  ))
}

/// `formatForecast(forecast)`.
pub fn format_forecast(forecast: &Value) -> String {
  let member = |name: &str| get(Some(forecast), name);
  let counts = member("counts");
  let plan_counts = get(member("plan"), "counts");
  let scope = match as_text(member("scope")).as_deref() {
    Some("source-checkpoint") => "immutable source checkpoint",
    Some("target-checkpoint") => "committed heads plus a target overlay",
    Some("source-and-target-checkpoint") => "immutable source checkpoint plus a target overlay",
    _ => "committed heads only",
  };
  let same_state = match member("exactStateEqualityAfter") {
    Some(Value::Null) => "unknown",
    value if truthy(value) => "yes",
    _ => "no",
  };
  let semantic = match get(counts, "semanticSpec") {
    value if nullish(value) => "0".to_string(),
    value => js_text(value),
  };
  let mut lines = vec![
    "Reconciliation forecast".to_string(),
    format!("forecast     {}", js_text(member("id"))),
    format!("status       {}", js_text(member("status"))),
    format!("target       {}", short(member("targetHead"))),
    format!("source       {} @ {}", js_text(member("sourceRef")), short(member("sourceHead"))),
    format!("scope        {scope}"),
    format!(
      "plan         {} covered, {} candidate, {} new",
      js_text(get(plan_counts, "covered")),
      js_text(get(plan_counts, "candidate-equivalent")),
      js_text(get(plan_counts, "new"))
    ),
    format!(
      "simulation   {} clean, {} exact-resolved, {semantic} spec-merged, {} blocked",
      js_text(get(counts, "clean")),
      js_text(get(counts, "exactResolution")),
      js_text(get(counts, "blocked"))
    ),
    format!("predicted    {}", short(member("predictedResultTree"))),
    format!("partial      {}", short(member("partialResultTree"))),
    format!("same state   {same_state}"),
    format!("forecast time {} ms", fixed(get(member("timings"), "forecastMs"))),
  ];
  lines.extend(git_activity(get(member("timings"), "git")));
  lines.extend(format_forecast_engine(forecast));
  if let Some(overlay) = member("targetOverlay").filter(|overlay| truthy(Some(overlay))) {
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
      "overlay after BLOCKED: the overlay does not merge with the committed result".to_string()
    });
    if let Some(conflict) = member("targetOverlayConflict").filter(|conflict| truthy(Some(conflict))) {
      lines.push(format!("  ! {}", js_text(get(Some(conflict), "reason"))));
    }
  }
  if truthy(member("ignoredTargetDirtyFiles")) {
    lines.push(format!(
      "target dirty {} files ignored",
      js_text(member("ignoredTargetDirtyFiles"))
    ));
  }
  lines.push(String::new());
  let steps = match member("steps") {
    Some(Value::Array(steps)) => steps.clone(),
    _ => Vec::new(),
  };
  if steps.is_empty() {
    lines.push("No new source changes require simulation.".into());
  }
  for step in &steps {
    let field = |name: &str| get(Some(step), name);
    let outcome = js_text(field("outcome"));
    let items = |name: &str| match field(name) {
      Some(Value::Array(items)) => items.clone(),
      _ => Vec::new(),
    };
    if outcome == "clean" {
      lines.push(format!(
        "C {} {} [clean]",
        short(field("sourceCommit")),
        js_text(field("subject"))
      ));
    } else if !outcome.starts_with("blocked") {
      let merges = items("semanticMerges");
      let resolutions = items("resolutions");
      let mut labels = Vec::new();
      if !merges.is_empty() {
        labels.push(format!(
          "{} deterministic spec merge{}",
          merges.len(),
          if merges.len() == 1 { "" } else { "s" }
        ));
      }
      if !resolutions.is_empty() {
        labels.push(format!(
          "{} exact resolution{}",
          resolutions.len(),
          if resolutions.len() == 1 { "" } else { "s" }
        ));
      }
      lines.push(format!(
        "R {} {} [{}]",
        short(field("sourceCommit")),
        js_text(field("subject")),
        labels.join(", ")
      ));
      for merge in &merges {
        lines.push(format!("  {} <= stable block IDs", js_text(get(Some(merge), "path"))));
      }
      for resolution in &resolutions {
        lines.push(format!(
          "  {} <= {}",
          js_text(get(Some(resolution), "path")),
          js_text(get(Some(resolution), "selectedResolutionId"))
        ));
      }
    } else {
      lines.push(format!(
        "! {} {} [blocked]",
        short(field("sourceCommit")),
        js_text(field("subject"))
      ));
      for conflict in items("conflicts") {
        let count = length(get(Some(&conflict), "candidates"));
        let plural = !strict_equals(count.as_ref(), Some(&Value::Number(1.0)));
        lines.push(format!(
          "  {}: {} exact candidate{}",
          js_text(get(Some(&conflict), "path")),
          js_text(count.as_ref()),
          if plural { "s" } else { "" }
        ));
        if let Some(Value::Array(semantic)) = get(get(Some(&conflict), "semanticSpec"), "conflicts") {
          for item in semantic {
            lines.push(format!("    semantic blocker: {}", js_text(get(Some(item), "type"))));
          }
        }
      }
    }
  }
  if truthy(member("blockedReason")) {
    lines.push(String::new());
    lines.push(format!("blocked by   {}", js_text(member("blockedReason"))));
  }
  lines.push(String::new());
  lines.push("The current HEAD, index, and working files were not changed.".into());
  if truthy(member("candidateDecisionRequired")) {
    lines.push("Review the heuristic candidates, then regenerate with:".into());
    lines.push(format!(
      "  cst forecast {} --accept-candidates",
      js_text(member("sourceRef"))
    ));
    return lines.join("\n");
  }
  lines.push("Start the pinned reconciliation with:".into());
  lines.push(format!(
    "  cst reconcile {} --use-forecast {}",
    js_text(member("sourceRef")),
    js_text(member("id"))
  ));
  lines.join("\n")
}
