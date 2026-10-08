//! Target overlays (ADR-0028), the uncommitted work a target workspace has
//! captured in a checkpoint: `src/target-overlay.js`, from resolving and
//! predicting an overlay for a forecast to carrying it through an application
//! and putting it back. An overlay is context, never a committed draft,
//! and everything here works from the checkpoint's tree rather than live bytes.

use crate::workspaces::{latest_workspace_checkpoint, list_workspaces};
use causet_engine::errors::{GitError, GitResult};
use causet_engine::process::{RunOptions, run_git};
use causet_engine::{engine, text};
use causet_model::js::{get, nullish, text as js_text};
use causet_model::json::{Object, Value, lossy, string};

/// `path.resolve(candidate.path ?? "")`, which throws for a path that is not
/// a string.
fn resolve_workspace_path(value: Option<&Value>) -> GitResult<String> {
  match value {
    value if nullish(value) => Ok(text::resolve_path("")),
    Some(Value::String(units)) => Ok(text::resolve_path(&lossy(units))),
    other => Err(GitError::node(
      format!(
        "The \"paths[0]\" argument must be of type string. {}",
        crate::envelope::received(other)
      ),
      "ERR_INVALID_ARG_TYPE",
    )),
  }
}

/// The first 12 characters of a text value (`value.slice(0, 12)`).
fn prefix(value: Option<&Value>) -> String {
  js_text(value).chars().take(12).collect()
}

/// `resolveTargetOverlay(cwd)`: the overlay a `--target-checkpoint` forecast
/// is about, or a refusal saying why there is none. Nothing is captured on
/// the caller's behalf.
pub(crate) fn resolve_target_overlay(cwd: &str) -> GitResult<Value> {
  let context = engine::repo_context(cwd)?;
  let here = text::resolve_path(cwd);
  let mut found = None;
  if let Value::Array(workspaces) = list_workspaces(&context.root)? {
    for candidate in workspaces {
      if resolve_workspace_path(get(Some(&candidate), "path"))? == here {
        found = Some(candidate);
        break;
      }
    }
  }
  let Some(workspace) = found else {
    return Err(
      GitError::new(
        "precondition-not-met",
        "A target checkpoint needs a registered workspace, and this worktree is not one.",
      )
      .details(
        "Create one with 'cst workspace create', or forecast without --target-checkpoint to ignore uncommitted work as before.",
      ),
    );
  };
  let name = js_text(get(Some(&workspace), "name"));
  let Some(checkpoint) = latest_workspace_checkpoint(&workspace, &context.root)? else {
    return Err(
      GitError::new(
        "precondition-not-met",
        format!("Workspace '{name}' has no checkpoint to carry as a target overlay."),
      )
      .details(
        "Capture one with 'cst workspace checkpoint'. Uncommitted work is never captured on your behalf, because an overlay is state you approved.",
      ),
    );
  };
  let member = |key: &str| get(Some(&checkpoint), key);
  let head = engine::resolve_object_ids(&["HEAD^{commit}".to_string()], cwd)?
    .into_iter()
    .next()
    .unwrap_or_default();
  if js_text(member("baseHead")) != head {
    return Err(
      GitError::new(
        "stale-input",
        format!(
          "Checkpoint '{}' was captured on {}, but this worktree is on {}.",
          prefix(member("id")),
          prefix(member("baseHead")),
          head.chars().take(12).collect::<String>()
        ),
      )
      .details("Capture a new checkpoint before forecasting it as a target overlay."),
    );
  }
  if js_text(member("tree")) == engine::tree_id(&head, cwd)? {
    return Err(GitError::new(
      "precondition-not-met",
      format!(
        "Checkpoint '{}' holds no draft beyond the committed head, so there is no overlay to carry.",
        prefix(member("id"))
      ),
    ));
  }
  let mut overlay = Object::new();
  let copy = |overlay: &mut Object, key: &str, value: Option<&Value>| {
    if let Some(value) = value {
      overlay.set(key, value.clone());
    }
  };
  copy(&mut overlay, "checkpoint", member("id"));
  copy(&mut overlay, "tree", member("tree"));
  copy(&mut overlay, "baseHead", member("baseHead"));
  copy(&mut overlay, "draftChangeId", member("draftChangeId"));
  copy(&mut overlay, "workspaceId", get(Some(&workspace), "id"));
  copy(&mut overlay, "workspaceName", get(Some(&workspace), "name"));
  Ok(Value::Object(overlay))
}

/// `predictOverlayTree({ baseTree, resultTree, overlayTree }, cwd)`: the tree
/// the worktree will hold once the overlay is put back, as `{ tree, conflict }`.
/// A conflict is the forecast's own blocking reason, never something to
/// resolve (ADR-0028 decision 2).
pub(crate) fn predict_overlay_tree(
  base_tree: &str,
  result_tree: &str,
  overlay_tree: &str,
  cwd: &str,
) -> GitResult<Value> {
  let outcome = |tree: Value, conflict: Value| {
    let mut prediction = Object::new();
    prediction.set("tree", tree);
    prediction.set("conflict", conflict);
    Value::Object(prediction)
  };
  let conflict = |details: &str| {
    let mut conflict = Object::new();
    conflict.set("reason", string("target-overlay-conflict"));
    conflict.set("details", string(details));
    Value::Object(conflict)
  };
  if result_tree == base_tree {
    return Ok(outcome(string(overlay_tree), Value::Null));
  }
  let args: Vec<String> = [
    "merge-tree",
    "--write-tree",
    "--merge-base",
    base_tree,
    result_tree,
    overlay_tree,
  ]
  .iter()
  .map(|arg| (*arg).to_string())
  .collect();
  let merged = run_git(&args, &RunOptions::new(cwd).allow_failure())?;
  if !merged.ok {
    let details = [merged.output.trim(), merged.stderr.trim()]
      .into_iter()
      .find(|text| !text.is_empty())
      .unwrap_or("The overlay does not merge with the committed result.");
    return Ok(outcome(Value::Null, conflict(details)));
  }
  let tree = merged
    .stdout
    .split('\n')
    .map(|line| line.strip_suffix('\r').unwrap_or(line))
    .find(|line| !line.is_empty())
    .unwrap_or_default();
  let hex = |length: usize| tree.len() == length && tree.bytes().all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'));
  if !(hex(40) || hex(64)) {
    return Ok(outcome(Value::Null, conflict(merged.stdout.trim())));
  }
  Ok(outcome(string(tree), Value::Null))
}

fn git(args: &[&str], options: &RunOptions) -> GitResult<causet_engine::process::GitOutput> {
  let args: Vec<String> = args.iter().map(|arg| (*arg).to_string()).collect();
  run_git(&args, options)
}

/// A scratch directory holding a temporary index, removed whatever `action`
/// did (`try { ... } finally { fs.rmSync(scratch, ...) }`).
fn with_temporary_index<T>(prefix: &str, cwd: &str, action: impl FnOnce(&RunOptions) -> GitResult<T>) -> GitResult<T> {
  let scratch = crate::export::temporary_directory(prefix)?;
  let options = RunOptions::new(cwd).env("GIT_INDEX_FILE", &text::join(&scratch, "index"));
  let outcome = action(&options);
  match std::fs::remove_dir_all(&scratch) {
    Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
      return Err(crate::envelope::io_failure(&error, "rm", &scratch));
    }
    _ => {}
  }
  outcome
}

/// `liveWorktreeTree(cwd)`: the tree the live worktree holds, written through
/// the same temporary index a checkpoint capture uses. Ignored files are
/// outside it.
pub(crate) fn live_worktree_tree(cwd: &str) -> GitResult<String> {
  with_temporary_index("vlab-overlay-index-", cwd, |options| {
    git(&["read-tree", "HEAD"], options)?;
    git(&["add", "--all", "."], options)?;
    Ok(git(&["write-tree"], options)?.stdout)
  })
}

fn stale_forecast(message: String) -> GitError {
  GitError::new("stale-forecast", message).details("Capture a new checkpoint and forecast again.")
}

/// `assertOverlayCurrent(overlay, cwd)`: refuse a forecast whose overlay no
/// longer describes this worktree. A moved base head or a missing checkpoint
/// is `stale-forecast`; a live tree that drifted is `stale-overlay`. Nothing
/// is re-captured.
pub(crate) fn assert_overlay_current(overlay: &Value, cwd: &str) -> GitResult<()> {
  let member = |key: &str| get(Some(overlay), key);
  let head = engine::resolve_object_ids(&["HEAD^{commit}".to_string()], cwd)?
    .into_iter()
    .next()
    .unwrap_or_default();
  if js_text(member("baseHead")) != head {
    return Err(stale_forecast(format!(
      "The approved target overlay was captured on {}, but this worktree is on {}.",
      prefix(member("baseHead")),
      head.chars().take(12).collect::<String>()
    )));
  }
  // An overlay that was garbage collected is a staleness answer, not a
  // malformed expression, so absence is tolerated here.
  let expression = format!("{}^{{commit}}", js_text(member("checkpoint")));
  let objects = engine::inspect_git_objects(&[expression], cwd)?.records;
  if !objects.first().is_some_and(|object| object.exists && object.kind.as_deref() == Some("commit")) {
    return Err(stale_forecast(format!(
      "The approved target overlay checkpoint {} is no longer in this repository.",
      prefix(member("checkpoint"))
    )));
  }
  let live = live_worktree_tree(cwd)?;
  if js_text(member("tree")) != live {
    return Err(
      GitError::new("stale-overlay", "The worktree has changed since the target overlay was captured.").details(
        [
          format!("Overlay checkpoint tree: {}", js_text(member("tree"))),
          format!("Live worktree tree:      {live}"),
          "Capture a new checkpoint with 'cst workspace checkpoint' and forecast again.".to_string(),
          "Nothing was changed, and no work was re-captured on your behalf.".to_string(),
        ]
        .join("\n"),
      ),
    );
  }
  Ok(())
}

/// The files of `tree` written over the worktree through a temporary index,
/// so the real index stays at the committed head; then the live tree.
fn check_out_tree(prefix: &str, tree: &str, cwd: &str) -> GitResult<String> {
  with_temporary_index(prefix, cwd, |options| {
    git(&["read-tree", tree], options)?;
    let mut args = causet_engine::process::GIT_NO_RERERE.to_vec();
    args.extend(["checkout-index", "--all", "--force"]);
    git(&args, options)?;
    live_worktree_tree(cwd)
  })
}

/// `materializeOverlay(overlay, { baseTree, resultTree }, cwd)`: the overlay
/// put back uncommitted, as the three-way merge the forecast predicted rather
/// than the overlay tree itself, which would undo what the application did.
/// `{ tree, conflict }`.
pub(crate) fn materialize_overlay(overlay: &Value, base_tree: &str, result_tree: &str, cwd: &str) -> GitResult<Value> {
  let merged = predict_overlay_tree(base_tree, result_tree, &js_text(get(Some(overlay), "tree")), cwd)?;
  if causet_model::js::truthy(get(Some(&merged), "conflict")) {
    let mut outcome = Object::new();
    outcome.set("tree", Value::Null);
    outcome.set("conflict", get(Some(&merged), "conflict").cloned().unwrap_or(Value::Null));
    return Ok(Value::Object(outcome));
  }
  let tree = check_out_tree("vlab-overlay-restore-", &js_text(get(Some(&merged), "tree")), cwd)?;
  let mut outcome = Object::new();
  outcome.set("tree", string(&tree));
  outcome.set("conflict", Value::Null);
  Ok(Value::Object(outcome))
}

/// `reduceToCommittedHead(overlay, cwd)`: the worktree reduced to the
/// committed head, the overlay being safe in its checkpoint. A path is
/// deleted exactly when the overlay tree holds it and the committed tree does
/// not; a file in neither is the user's own.
pub(crate) fn reduce_to_committed_head(overlay: &Value, cwd: &str) -> GitResult<()> {
  let head = engine::resolve_object_ids(&["HEAD^{commit}".to_string()], cwd)?
    .into_iter()
    .next()
    .unwrap_or_default();
  let committed: std::collections::HashSet<String> =
    engine::tree_paths(&engine::tree_id(&head, cwd)?, cwd)?.into_iter().collect();
  for relative in engine::tree_paths(&js_text(get(Some(overlay), "tree")), cwd)? {
    if committed.contains(&relative) {
      continue;
    }
    let target = text::resolve(cwd, &relative);
    if std::path::Path::new(&target).exists() {
      match std::fs::remove_file(&target) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
          return Err(crate::envelope::io_failure(&error, "rm", &target));
        }
        _ => {}
      }
    }
  }
  git(&["reset", "--hard", &head], &RunOptions::new(cwd))?;
  Ok(())
}

/// `restoreOverlayAfterAbort(overlay, cwd)`: the captured overlay put back
/// once an abort restored the committed tip, with no merge involved. An
/// overlay whose tree is gone is reported, never guessed at.
pub(crate) fn restore_overlay_after_abort(overlay: &Value, cwd: &str) -> GitResult<Value> {
  let member = |key: &str| get(Some(overlay), key);
  let mut outcome = Object::new();
  if !causet_model::js::truthy(member("checkpoint")) || !causet_model::js::truthy(member("tree")) {
    outcome.set("restored", Value::Bool(false));
    outcome.set("reason", string("no overlay was recorded for this operation"));
    return Ok(Value::Object(outcome));
  }
  let tree = js_text(member("tree"));
  let objects = engine::inspect_git_objects(std::slice::from_ref(&tree), cwd)?.records;
  if !objects.first().is_some_and(|object| object.exists && object.kind.as_deref() == Some("tree")) {
    outcome.set("restored", Value::Bool(false));
    outcome.set("checkpoint", member("checkpoint").cloned().unwrap_or(Value::Null));
    outcome.set(
      "reason",
      string(&format!(
        "the overlay tree {} is unavailable, so the captured draft could not be restored; the committed tip is correct and the worktree is clean",
        prefix(member("tree"))
      )),
    );
    return Ok(Value::Object(outcome));
  }
  let live = check_out_tree("vlab-overlay-abort-", &tree, cwd)?;
  outcome.set("restored", Value::Bool(true));
  outcome.set("checkpoint", member("checkpoint").cloned().unwrap_or(Value::Null));
  outcome.set("tree", string(&live));
  Ok(Value::Object(outcome))
}
