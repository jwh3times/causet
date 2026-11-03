//! `cst forecast` and `cst workspace forecast`: `forecastReconciliation` and
//! `forecastWorkspaces` of `src/forecasts.js`, the plan simulator they drive
//! under either forecast engine (ADR-0016), and `formatForecast` of
//! `src/cli.js`.
//!
//! The simulator runs a program: the queue a reconciliation replays, one pick
//! per new change, or a causal rebase's, which may recreate merges, absorb
//! changes, pause for an `edit` and leave commits out (ADR-0034, ADR-0035).

use crate::rebase_program::{
  ProgramItem, absorbed_change_id, absorbed_message, assert_single_identity, is_interactive,
  rebase_program, recreated_merge_message, resolve_step_parents,
};
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
use std::collections::HashMap;
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
pub(crate) fn elapsed(started: Instant) -> f64 {
  started.elapsed().as_secs_f64() * 1000.0
}

/// `Number(value.toFixed(2))`.
pub(crate) fn rounded(value: f64) -> Value {
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
pub(crate) fn zero_timings() -> Value {
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
pub(crate) struct Simulation {
  pub result: Object,
  pub engine: Option<&'static str>,
  pub fallbacks: Vec<Value>,
  pub worktree_timings: Value,
  pub merge_tree_timings: Value,
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

/// `commitRecreatedMerge(change, cwd)`: the staged join committed under the
/// message the application will write, with an identity of its own.
fn commit_recreated_merge(change: &Value, cwd: &str) -> GitResult<()> {
  let path = text::join(&engine::repo_context(cwd)?.git_dir, "MERGE_MSG");
  let message = recreated_merge_message(
    get(Some(change), "subject"),
    &crate::host::new_id("ch"),
    get(Some(change), "changeId"),
    &js_text(get(Some(change), "commit")),
  );
  std::fs::write(&path, message).map_err(|error| crate::envelope::io_failure(&error, "open", &path))?;
  git(&["-c", "core.editor=true", "commit", "--no-edit"], cwd)?;
  Ok(())
}

/// What `absorbChanges` returns when an absorbed change cannot be melded.
struct FailedAbsorption {
  commit: Value,
  output: String,
  conflicts: Option<Vec<Value>>,
  reason: &'static str,
}

/// `absorbChanges(absorbs, message, cwd)`: every absorbed change applied
/// without committing and folded into the commit at HEAD, which keeps one
/// commit and one `Change-Id` (ADR-0035). A conflict gets the one chance a
/// forecast can take, an exact prior resolution.
fn absorb_changes(
  absorbs: &[Value],
  message: &str,
  cwd: &str,
) -> GitResult<Result<Vec<Value>, FailedAbsorption>> {
  let mut resolutions = Vec::new();
  for item in absorbs {
    let commit = js_text(get(Some(item), "commit"));
    let mut pick = GIT_NO_RERERE.to_vec();
    pick.extend(["cherry-pick", "--no-commit", &commit]);
    let applied = git_allowing_failure(&pick, cwd)?;
    if applied.ok {
      continue;
    }
    let paths = engine::unmerged_paths(cwd)?;
    let mut conflicts = if paths.is_empty() {
      Vec::new()
    } else {
      capture_conflict_descriptors(&paths, cwd)?
    };
    if conflicts.is_empty() || !conflicts.iter().all(|conflict| candidate_count(conflict) == 1) {
      git_allowing_failure(&["cherry-pick", "--abort"], cwd)?;
      let reason = if conflicts.is_empty() {
        "git-application-error"
      } else {
        blocked_reason(&conflicts.iter().collect::<Vec<_>>())
      };
      return Ok(Err(FailedAbsorption {
        commit: string(&commit),
        output: applied.output,
        conflicts: Some(conflicts),
        reason,
      }));
    }
    for conflict in &mut conflicts {
      let candidate = match get(Some(conflict), "candidates") {
        Some(Value::Array(items)) => items[0].clone(),
        _ => Value::Null,
      };
      materialize_resolution_candidate(Some(conflict), Some(&candidate), cwd)?;
      if let Value::Object(conflict) = conflict {
        conflict.set("selectedResolutionId", get(Some(&candidate), "id").cloned().unwrap_or(Value::Null));
        conflict.set("selectionMethod", string("absorption-exact-reuse"));
      }
    }
    for outcome in capture_resolution_outcomes(&conflicts, cwd)? {
      let mut outcome = match outcome {
        Value::Object(outcome) => outcome,
        _ => Object::new(),
      };
      outcome.set("absorbedCommit", string(&commit));
      resolutions.push(Value::Object(outcome));
    }
  }
  let amended = git_allowing_failure(&["-c", "core.editor=true", "commit", "--amend", "-m", message], cwd)?;
  if amended.ok {
    return Ok(Ok(resolutions));
  }
  Ok(Err(FailedAbsorption {
    commit: Value::Null,
    output: amended.output,
    conflicts: None,
    reason: "absorption-amend-error",
  }))
}

/// The worktree simulator's loop over a program: each step applied onto the
/// parent it names, or onto the last step for a plain queue. A conflict is
/// settled only by a deterministic spec merge or an exact retained
/// resolution, and anything else is a stop.
fn simulate_program(
  worktree: &str,
  bounds: &Bounds,
  program: &[ProgramItem],
  new_base: &str,
) -> GitResult<Object> {
  let mut steps: Vec<Value> = Vec::new();
  let mut approved_resolutions = Vec::new();
  let mut approved_spec_merges = Vec::new();
  let mut status = "complete";
  let mut reason = Value::Null;
  // Original commit to the commit that replaced it. Only a program that
  // states its parents reads it, so a plain queue does not pay one process a
  // step to fill it (ADR-0034).
  let mut rewritten: HashMap<String, String> = HashMap::new();
  let states_parents = program.iter().any(|item| item.step.is_some());
  for item in program {
    let change = &item.change;
    let commit = js_text(get(Some(change), "commit"));
    let recreating = item.kind == "recreate-merge";
    let kind = if recreating { "recreate-merge" } else { "pick" };
    let parents = match &item.step {
      Some(step) => Some(resolve_step_parents(step, new_base, &rewritten)?),
      None => None,
    };
    let parent = |index: usize| {
      parents
        .as_ref()
        .and_then(|parents| parents.get(index))
        .map(|parent| parent.commit.clone())
        .unwrap_or_default()
    };
    let parent_commits = || {
      Value::Array(
        parents
          .iter()
          .flatten()
          .map(|parent| string(&parent.commit))
          .collect(),
      )
    };
    if item.kind == "omit" {
      // The commit collapses out of the rewritten line: anything that named
      // it as a parent now names whatever replaced the commit beneath it.
      rewritten.insert(commit, parent(0));
      continue;
    }
    let mut step = step_identity(change);
    // `edit` lets a person change the content, so its result tree is not a
    // thing a forecast can predict. It says so and stops (ADR-0035).
    if item.action.as_deref() == Some("edit") {
      status = "pauses-for-content";
      reason = string("interactive-edit-pauses");
      step.set("outcome", string("pauses-for-content"));
      step.set("kind", string("pick"));
      step.set("action", string("edit"));
      let head = engine::current_head(worktree)?;
      step.set("targetBeforeTree", string(&engine::tree_id(&head, worktree)?));
      steps.push(Value::Object(step));
      break;
    }
    // A program with merges jumps between lines, so each step states the
    // parent it applies onto.
    if parents.is_some() && engine::current_head(worktree)? != parent(0) {
      git(&["reset", "--hard", &parent(0)], worktree)?;
    }
    let target_before = engine::current_head(worktree)?;
    let target_before_tree = engine::tree_id(&target_before, worktree)?;
    let second = parent(1);
    let mut apply = GIT_NO_RERERE.to_vec();
    if recreating {
      apply.extend(["merge", "--no-ff", "--no-commit", &second]);
    } else {
      apply.extend(["cherry-pick", "-x", &commit]);
    }
    let applied = git_allowing_failure(&apply, worktree)?;
    // A recreated merge whose two parents became the same line joins nothing.
    // Git reports that as success with no pending merge, and the operator
    // decides what becomes of it (ADR-0034).
    if recreating
      && applied.ok
      && !engine::pseudo_ref_target("MERGE_HEAD", worktree)?.is_some_and(|head| !head.is_empty())
    {
      status = "blocked";
      reason = string("unexpected-empty");
      step.set("outcome", string("blocked-empty-merge"));
      step.set("kind", string("recreate-merge"));
      step.set("parents", parent_commits());
      step.set("targetBeforeTree", string(&target_before_tree));
      step.set("gitOutput", string(&applied.output));
      steps.push(Value::Object(step));
      break;
    }
    if applied.ok {
      if recreating {
        commit_recreated_merge(change, worktree)?;
        if states_parents {
          rewritten.insert(commit.clone(), engine::current_head(worktree)?);
        }
        step.set("outcome", string("clean"));
        step.set("kind", string("recreate-merge"));
        step.set("relation", string("recreated-merge"));
        step.set("parents", parent_commits());
        step.set("cleanJoin", Value::Bool(true));
        step.set("targetBeforeTree", string(&target_before_tree));
        step.set("resultTree", string(&engine::tree_id("HEAD", worktree)?));
        steps.push(Value::Object(step));
        continue;
      }
      let absorbed_commits = || {
        Value::Array(
          item
            .absorbs
            .iter()
            .map(|entry| get(Some(entry), "commit").cloned().unwrap_or(Value::Null))
            .collect(),
        )
      };
      let mut absorbed_resolutions = Vec::new();
      if !item.absorbs.is_empty() {
        let surviving = engine::commit_message("HEAD", worktree)?;
        let mut absorbed = Vec::new();
        for entry in &item.absorbs {
          absorbed.push((
            js_text(get(Some(entry), "action")),
            engine::commit_message(&js_text(get(Some(entry), "commit")), worktree)?,
          ));
        }
        let change_id = js_text(get(Some(change), "changeId"));
        let message = absorbed_message(&surviving, &absorbed, &change_id);
        assert_single_identity(&message, &change_id)?;
        match absorb_changes(&item.absorbs, &message, worktree)? {
          Ok(resolutions) => absorbed_resolutions = resolutions,
          Err(failed) => {
            status = "blocked";
            reason = string(failed.reason);
            step.set("outcome", string("blocked-absorption"));
            step.set("kind", string("pick"));
            if let Some(action) = get(Some(change), "action") {
              step.set("action", action.clone());
            }
            step.set("absorbedCommits", absorbed_commits());
            step.set("conflictedAbsorption", failed.commit);
            step.set("conflicts", Value::Array(failed.conflicts.unwrap_or_default()));
            step.set("targetBeforeTree", string(&target_before_tree));
            step.set("gitOutput", string(&failed.output));
            steps.push(Value::Object(step));
            break;
          }
        }
      }
      if states_parents {
        rewritten.insert(commit.clone(), engine::current_head(worktree)?);
      }
      step.set("outcome", string("clean"));
      step.set("kind", string("pick"));
      step.set(
        "action",
        match get(Some(change), "action") {
          value if nullish(value) => string("replay"),
          value => value.cloned().unwrap_or(Value::Null),
        },
      );
      if !item.absorbs.is_empty() {
        step.set("absorbedCommits", absorbed_commits());
        step.set(
          "absorbedChanges",
          Value::Array(item.absorbs.iter().map(absorbed_change_id).collect()),
        );
        step.set("absorbedResolutions", Value::Array(absorbed_resolutions));
      }
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
      step.set("kind", string(kind));
      step.set("targetBeforeTree", string(&target_before_tree));
      step.set("gitOutput", string(&applied.output));
      steps.push(Value::Object(step));
      break;
    }

    let mut conflicts = capture_conflict_descriptors(&paths, worktree)?;
    // A pick's three-way endpoints are the change, its parent, and the tree it
    // lands on. A recreated merge's are the two parents it joins and their
    // own merge base (ADR-0034).
    let endpoints = if recreating {
      [
        Some(string(&engine::merge_base(&parent(0), &second, worktree)?)),
        Some(string(&parent(0))),
        Some(string(&second)),
      ]
    } else {
      [
        Some(string(&format!("{commit}^"))),
        Some(string(&target_before)),
        Some(string(&commit)),
      ]
    };
    let path_values = Value::Array(paths.iter().map(|path| string(path)).collect());
    let mut semantic_plans = Vec::new();
    for file in spec_files_for_conflict_paths(Some(&path_values))? {
      semantic_plans.push(plan_spec_merge(&js_text(Some(&file)), endpoints.clone(), worktree)?);
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
      step.set("kind", string(kind));
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
    // A resolved pick is finished by the sequencer; a resolved merge is an
    // ordinary commit of a staged index, because nothing is sequencing it.
    let continued = if recreating {
      commit_recreated_merge(change, worktree)?;
      None
    } else {
      let mut finish = GIT_NO_RERERE.to_vec();
      finish.extend(["-c", "core.editor=true", "cherry-pick", "--continue"]);
      Some(git_allowing_failure(&finish, worktree)?).filter(|continued| !continued.ok)
    };
    if let Some(continued) = continued {
      status = "blocked";
      reason = string("exact-resolution-application-error");
      step.set("outcome", string("blocked-resolution-application"));
      step.set("kind", string(kind));
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
    if states_parents {
      rewritten.insert(commit.clone(), engine::current_head(worktree)?);
    }
    let outcome = match (semantic_merges.is_empty(), resolutions.is_empty()) {
      (false, false) => "semantic-spec-and-exact-resolution",
      (false, true) => "semantic-spec-merge",
      _ => "exact-resolution",
    };
    step.set("outcome", string(outcome));
    step.set("kind", string(kind));
    step.set(
      "relation",
      string(if recreating { "recreated-merge" } else { bounds.contextual_relation }),
    );
    if recreating {
      step.set("parents", parent_commits());
      step.set("cleanJoin", Value::Bool(false));
    }
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
  let replayed = program.iter().filter(|item| item.kind != "omit").count();
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
    Value::Number(replayed as f64 - simulated as f64),
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

/// `simulatePlan(plan, cwd, options)`: the merge-tree engine when it is
/// selected and can answer the program, and the temporary-worktree simulator,
/// the oracle, otherwise. Without a `program` the queue is the program.
fn simulate(
  bounds: &Bounds,
  queue: &[&Value],
  program: Option<Vec<ProgramItem>>,
  cwd: &str,
) -> GitResult<Simulation> {
  let program = program.unwrap_or_else(|| queue.iter().map(|change| ProgramItem::pick(change)).collect());
  let mut fallbacks = Vec::new();
  let mut merge_tree_timings = zero_timings();
  // `merge-tree` accumulates one tree from a queue of picks. It has no second
  // parent for a recreated merge, and no commit to amend for a reworded,
  // edited, or absorbing step, so either program goes to the worktree oracle.
  let merge_preserving = program.iter().any(|item| item.kind == "recreate-merge");
  let interactive = is_interactive(&program);
  if merge_preserving || interactive {
    if engine::forecast_engine()? == "merge-tree" {
      let mut fallback = Object::new();
      fallback.set("engine", string("merge-tree"));
      fallback.set(
        "reason",
        string(if merge_preserving { "merge-preserving-program" } else { "interactive-program" }),
      );
      fallbacks.push(Value::Object(fallback));
    }
  } else if engine::forecast_engine()? == "merge-tree" {
    match simulate_with_merge_tree(cwd, bounds, queue)? {
      Ok((result, timings)) => {
        return Ok(Simulation {
          result,
          engine: Some("merge-tree"),
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
  let (result, worktree_timings) = with_temporary_worktree(bounds.target_head, cwd, |worktree| {
    simulate_program(worktree, bounds, &program, bounds.target_head)
  })?;
  Ok(Simulation {
    result,
    engine: Some("worktree"),
    fallbacks,
    worktree_timings,
    merge_tree_timings,
  })
}

/// `simulatePlan(plan, cwd)` for a reconciliation: one pick per new change.
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
  simulate(&bounds, &queue, None, cwd)
}

/// `simulateCausalRebasePlan(plan, cwd)`: the changes the plan replays, onto
/// the plan's `onto` head. A linear plan without declared actions keeps its
/// queue as its program, so the merge-tree engine still answers it.
pub(crate) fn simulate_causal_rebase_plan(plan: &Value, cwd: &str) -> GitResult<Simulation> {
  let onto_head = js_text(get(Some(plan), "ontoHead"));
  let expected_result_tree = js_text(get(Some(plan), "sourceTree"));
  let bounds = Bounds {
    target_head: &onto_head,
    expected_result_tree: &expected_result_tree,
    clean_relation: "causal-rebase",
    contextual_relation: "contextual-rebase",
  };
  let queue: Vec<&Value> = match get(Some(plan), "changes") {
    Some(Value::Array(changes)) => changes
      .iter()
      .filter(|change| as_text(get(Some(change), "action")).as_deref() == Some("replay"))
      .collect(),
    _ => Vec::new(),
  };
  let declared = matches!(get(Some(plan), "interactive"), Some(Value::Array(items)) if !items.is_empty());
  let program = (as_text(get(Some(plan), "mode")).as_deref() == Some("merge-preserving") || declared)
    .then(|| rebase_program(plan));
  simulate(&bounds, &queue, program, cwd)
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
pub(crate) fn save_forecast(forecast: &Value, id: &str, cwd: &str) -> GitResult<()> {
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
    forecast_in_session(source_ref, target_checkpoint, accept_candidates, None, cwd)
  })
}

/// The `scope` and `workspaceComparison` options `forecastWorkspaces` passes.
struct Comparison {
  scope: &'static str,
  workspaces: Value,
}

/// `requireWorkspace(workspaces, value, role)`.
fn require_workspace<'a>(workspaces: &'a [Value], value: &str, role: &str) -> GitResult<&'a Value> {
  let named = |workspace: &&Value| {
    ["name", "id"]
      .iter()
      .any(|name| as_text(get(Some(workspace), name)).as_deref() == Some(value))
  };
  let Some(workspace) = workspaces.iter().find(named) else {
    return Err(GitError::new(
      "not-found",
      format!("{role} workspace '{value}' was not found."),
    ));
  };
  if as_text(get(Some(workspace), "status")).as_deref() != Some("active") {
    return Err(GitError::new(
      "precondition-not-met",
      format!("{role} workspace '{value}' is not active."),
    ));
  }
  Ok(workspace)
}

/// `forecastWorkspaces(targetName, sourceName, { sourceCheckpoint,
/// acceptCandidates })`: a forecast of reconciling one workspace's branch, or
/// its latest checkpoint, into another, run in the target's worktree.
///
/// `src/cli.js` also hands it `targetCheckpoint`, which it does not read; a
/// workspace forecast therefore never carries a target overlay.
pub fn forecast_workspaces(
  target_name: &str,
  source_name: &str,
  source_checkpoint: bool,
  accept_candidates: bool,
  cwd: &str,
) -> GitResult<Value> {
  let listed = crate::workspaces::list_workspaces(cwd)?;
  let workspaces = match &listed {
    Value::Array(workspaces) => workspaces.as_slice(),
    _ => &[],
  };
  let target = require_workspace(workspaces, target_name, "Target")?;
  let source = require_workspace(workspaces, source_name, "Source")?;
  let of = |workspace: &'_ Value, name: &str| get(Some(workspace), name).cloned();
  if strict_equals(of(target, "id").as_ref(), of(source, "id").as_ref()) {
    return Err(GitError::new(
      "usage-conflicting-options",
      "Choose two different workspaces to compare.",
    ));
  }
  let source_label = js_text(of(source, "name").as_ref());
  let checkpoint = if source_checkpoint {
    let Some(checkpoint) = crate::workspaces::latest_workspace_checkpoint(source, cwd)? else {
      return Err(GitError::new(
        "precondition-not-met",
        format!(
          "Source workspace '{source_label}' has no checkpoint. Capture one before requesting a checkpoint forecast."
        ),
      ));
    };
    let id = js_text(get(Some(&checkpoint), "id"));
    if !strict_equals(get(Some(&checkpoint), "baseHead"), of(source, "head").as_ref()) {
      return Err(GitError::new(
        "stale-input",
        format!(
          "Source workspace '{source_label}' moved after checkpoint '{id}'. Capture a new checkpoint before forecasting its draft."
        ),
      ));
    }
    let committed = engine::tree_id(
      &js_text(of(source, "head").as_ref()),
      &js_text(of(source, "path").as_ref()),
    )?;
    if as_text(get(Some(&checkpoint), "tree")).as_deref() == Some(committed.as_str()) {
      return Err(GitError::new(
        "precondition-not-met",
        format!(
          "Source checkpoint '{id}' contains no draft overlay beyond the committed workspace head."
        ),
      ));
    }
    Some(checkpoint)
  } else {
    None
  };
  let scope = if checkpoint.is_some() { "source-checkpoint" } else { "committed-heads" };
  let side = |workspace: &Value| {
    let mut side = Object::new();
    for (name, member) in [
      ("id", "id"),
      ("name", "name"),
      ("path", "path"),
      ("head", "head"),
      ("ignoredDirtyFiles", "dirtyFiles"),
    ] {
      if let Some(value) = of(workspace, member) {
        side.set(name, value);
      }
    }
    side
  };
  let source_ref = match &checkpoint {
    Some(checkpoint) => js_text(get(Some(checkpoint), "id")),
    None => js_text(of(source, "compatibilityBranch").as_ref()),
  };
  let mut source_side = side(source);
  source_side.set("checkpoint", checkpoint.unwrap_or(Value::Null));
  let mut comparison = Object::new();
  comparison.set("target", Value::Object(side(target)));
  comparison.set("source", Value::Object(source_side));
  comparison.set("scope", string(scope));
  let comparison = Comparison {
    scope,
    workspaces: Value::Object(comparison),
  };
  let target_path = js_text(of(target, "path").as_ref());
  with_object_session(&target_path, || {
    forecast_in_session(&source_ref, false, accept_candidates, Some(&comparison), &target_path)
  })
}

fn forecast_in_session(
  source_ref: &str,
  target_checkpoint: bool,
  accept_candidates: bool,
  comparison: Option<&Comparison>,
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
    string(match comparison {
      Some(comparison) => comparison.scope,
      None if target_overlay.is_some() => "target-checkpoint",
      None => "committed-heads",
    }),
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
  forecast.set("engine", simulation.engine.map_or(Value::Null, string));
  forecast.set("fallbacks", Value::Array(simulation.fallbacks));
  forecast.set(
    "workspaceComparison",
    comparison.map_or(Value::Null, |comparison| comparison.workspaces.clone()),
  );
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
  let comparison = member("workspaceComparison").filter(|comparison| truthy(Some(comparison)));
  if let Some(comparison) = comparison {
    let side = |name: &str| get(Some(comparison), name);
    lines.push(format!(
      "workspaces   {} <= {}",
      js_text(get(side("target"), "name")),
      js_text(get(side("source"), "name"))
    ));
    let dirty: Vec<String> = [side("target"), side("source")]
      .into_iter()
      .filter(|workspace| truthy(get(*workspace, "ignoredDirtyFiles")))
      .map(|workspace| {
        format!(
          "{}:{}",
          js_text(get(workspace, "name")),
          js_text(get(workspace, "ignoredDirtyFiles"))
        )
      })
      .collect();
    if !dirty.is_empty() {
      lines.push(format!("dirty ignored {}", dirty.join(", ")));
    }
    let checkpoint = get(side("source"), "checkpoint");
    if truthy(checkpoint) {
      lines.push(format!(
        "checkpoint   {} tree {}",
        short(get(checkpoint, "id")),
        short(get(checkpoint, "tree"))
      ));
      lines.push(format!("draft change {}", js_text(get(checkpoint, "draftChangeId"))));
    }
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
    lines.push(match comparison {
      Some(comparison) => format!(
        "  cst workspace forecast {} {}{} --accept-candidates",
        js_text(get(get(Some(comparison), "target"), "name")),
        js_text(get(get(Some(comparison), "source"), "name")),
        if as_text(member("scope")).as_deref() == Some("source-checkpoint") {
          " --source-checkpoint"
        } else {
          ""
        }
      ),
      None => format!(
        "  cst forecast {} --accept-candidates",
        js_text(member("sourceRef"))
      ),
    });
    return lines.join("\n");
  }
  if let Some(comparison) = comparison {
    lines.push(format!(
      "Run from target worktree: {}",
      js_text(get(get(Some(comparison), "target"), "path"))
    ));
  }
  lines.push("Start the pinned reconciliation with:".into());
  lines.push(format!(
    "  cst reconcile {} --use-forecast {}",
    js_text(member("sourceRef")),
    js_text(member("id"))
  ));
  lines.join("\n")
}
