//! Target overlays (ADR-0028), the uncommitted work a target workspace has
//! captured in a checkpoint: `resolveTargetOverlay` and `predictOverlayTree`
//! of `src/target-overlay.js`. An overlay is context, never a committed draft,
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
