//! `cst workspace list`, `checkpoint` and `prune`: `src/workspaces.js` and the
//! registry lock of `src/workspace-lock.js`.

use crate::envelope::{io_failure, received};
use crate::host;
use crate::notes_write::transient;
use crate::store::{ensure_lab_runtime, read_json};
use causet_engine::errors::{GitError, GitResult};
use causet_engine::locations::{CURRENT_NAMES, LEGACY_NAMES, ref_family};
use causet_engine::process::{RunOptions, git_text, run_git};
use causet_engine::{engine, text};
use causet_model::js::{nullish, text as js_text};
use causet_model::json::{Object, Value, lossy, parse, string, stringify, stringify_pretty};
use causet_model::schemas::assert_readable_schema;

const ACTIVE: &str = "active";
const ARCHIVED: &str = "archived";
const LOCK_WAIT_MS: f64 = 5_000.0;
const LOCK_POLL_MS: u64 = 20;

fn member<'a>(workspace: &'a Value, name: &str) -> Option<&'a Value> {
  causet_model::js::get(Some(workspace), name)
}

fn is_text(value: Option<&Value>, expected: &str) -> bool {
  matches!(value, Some(Value::String(units)) if lossy(units) == expected)
}

/// `workspace.lifecycle ?? ACTIVE`.
fn lifecycle(workspace: &Value) -> Value {
  match member(workspace, "lifecycle") {
    value if nullish(value) => string(ACTIVE),
    value => value.cloned().unwrap_or(Value::Null),
  }
}

/// `object[name] = value` when `value` is not `undefined`, as `JSON.stringify`
/// leaves an `undefined` member out.
fn set_present(object: &mut Object, name: &str, value: Option<&Value>) {
  if let Some(value) = value {
    object.set(name, value.clone());
  }
}

/// `{ ...workspace }`.
fn spread(workspace: &Value) -> Object {
  match workspace {
    Value::Object(object) => object.clone(),
    _ => Object::new(),
  }
}

fn refusal(refusal: causet_model::schemas::Refusal) -> GitError {
  GitError::new(refusal.code, refusal.message).details(refusal.details)
}

fn schema_of(value: Option<&Value>) -> Option<String> {
  match value {
    Some(Value::String(units)) => Some(lossy(units)),
    _ => None,
  }
}

/// `workspaceFile(cwd)`.
fn registry_path(cwd: &str) -> GitResult<String> {
  Ok(text::join(&ensure_lab_runtime(cwd)?, "workspaces.json"))
}

/// `readWorkspaces(cwd)`: the registry, refused when this build cannot read
/// it or any of its entries (ADR-0020).
pub fn read_workspaces(cwd: &str) -> GitResult<Object> {
  let path = registry_path(cwd)?;
  let registry = match read_json(&path)? {
    Some(registry) => registry,
    None => {
      let mut registry = Object::new();
      registry.set("schema", string("causet.workspaces/v1"));
      registry.set("workspaces", Value::Array(Vec::new()));
      Value::Object(registry)
    }
  };
  assert_readable_schema(
    schema_of(member(&registry, "schema")).as_deref(),
    &format!("The workspace registry at '{path}'"),
    Some("causet.workspaces"),
    "Read it with the causet build that wrote it.",
  )
  .map_err(refusal)?;
  let Some(Value::Array(workspaces)) = member(&registry, "workspaces") else {
    return Err(GitError::new(
      "malformed-input",
      format!("The workspace registry at '{path}' has no workspace list."),
    ));
  };
  for workspace in workspaces {
    assert_readable_schema(
      schema_of(member(workspace, "schema")).as_deref(),
      &format!("A workspace entry in '{path}'"),
      Some("causet.workspace"),
      "Read it with the causet build that wrote it.",
    )
    .map_err(refusal)?;
  }
  Ok(match registry {
    Value::Object(object) => object,
    _ => Object::new(),
  })
}

fn workspaces_of(registry: &Object) -> Vec<Value> {
  match registry.get("workspaces") {
    Some(Value::Array(workspaces)) => workspaces.clone(),
    _ => Vec::new(),
  }
}

/// `saveWorkspaces(value, cwd)` through `writeJson`.
fn save_workspaces(registry: &Object, cwd: &str) -> GitResult<()> {
  let path = registry_path(cwd)?;
  let temporary = format!("{path}.tmp-{}", std::process::id());
  std::fs::write(&temporary, format!("{}\n", stringify_pretty(&Value::Object(registry.clone()))))
    .map_err(|error| io_failure(&error, "open", &temporary))?;
  std::fs::rename(&temporary, &path).map_err(|error| io_failure(&error, "rename", &temporary))
}

/// `readWorkspaceMutationState(cwd)`.
fn read_mutation_state(cwd: &str) -> GitResult<Object> {
  let state = read_workspaces(cwd)?;
  host::gate_point("workspaces:after-read");
  host::fault_point("workspaces:after-read");
  Ok(state)
}

/// `workspacePathKind(workspacePath)`: a path `fs.statSync` cannot take is
/// missing.
fn path_kind(path: Option<&Value>) -> &'static str {
  let Some(Value::String(units)) = path else {
    return "missing";
  };
  match std::fs::metadata(lossy(units)) {
    Ok(metadata) if metadata.is_dir() => "directory",
    Ok(_) => "other",
    Err(_) => "missing",
  }
}

/// `inspectWorkspace(workspace)`: the entry with its lifecycle, status, path
/// status, HEAD and dirty count.
fn inspect_workspace(workspace: &Value) -> GitResult<Value> {
  let lifecycle = lifecycle(workspace);
  let mut path_status = "missing";
  let mut head = Value::Null;
  let mut dirty_files = Value::Null;
  match path_kind(member(workspace, "path")) {
    "other" => path_status = "invalid",
    "directory" => {
      let path = js_text(member(workspace, "path"));
      let status = engine::workspace_status(&path)?;
      if status.ok {
        path_status = ACTIVE;
        head = status.head.as_deref().map_or(Value::Null, string);
        dirty_files = status.dirty_files.map_or(Value::Null, Value::Number);
      } else if engine::is_inside_work_tree(&path)? {
        let mut failure = GitError::new(
          "git-command-failed",
          format!(
            "git status --porcelain=v2 --branch -z failed in workspace '{}'",
            js_text(member(workspace, "name"))
          ),
        )
        .details(status.error.unwrap_or_default());
        failure.exit_code = status.exit_code;
        return Err(failure);
      } else {
        path_status = "invalid";
      }
    }
    _ => {}
  }
  let archived = is_text(Some(&lifecycle), ARCHIVED);
  let mut inspected = spread(workspace);
  inspected.set("lifecycle", lifecycle);
  inspected.set("status", string(if archived { ARCHIVED } else { path_status }));
  inspected.set("pathStatus", string(path_status));
  inspected.set("head", head);
  inspected.set("dirtyFiles", dirty_files);
  Ok(Value::Object(inspected))
}

/// `listWorkspaces(cwd)`.
pub fn list_workspaces(cwd: &str) -> GitResult<Value> {
  let state = read_workspaces(cwd)?;
  let inspected = workspaces_of(&state)
    .iter()
    .map(inspect_workspace)
    .collect::<GitResult<Vec<_>>>()?;
  Ok(Value::Array(inspected))
}

/// `path.resolve(value)`, which throws for anything but a string.
fn resolve_value(value: Option<&Value>) -> GitResult<String> {
  match value {
    Some(Value::String(units)) => Ok(text::resolve_path(&lossy(units))),
    other => Err(GitError::node(
      format!("The \"paths[0]\" argument must be of type string. {}", received(other)),
      "ERR_INVALID_ARG_TYPE",
    )),
  }
}

/// `path.basename(root)`.
fn basename(path: &str) -> String {
  let trimmed = path.trim_end_matches(['/', '\\']);
  trimmed.rsplit(['/', '\\']).next().unwrap_or(trimmed).to_string()
}

/// `currentWorkspace(cwd)`: the registered workspace this worktree is, or the
/// main worktree as a synthetic one.
fn current_workspace(cwd: &str) -> GitResult<Value> {
  let context = engine::repo_context(cwd)?;
  let state = read_workspaces(cwd)?;
  for workspace in workspaces_of(&state) {
    if resolve_value(member(&workspace, "path"))? == text::resolve_path(&context.root) {
      if !is_text(Some(&lifecycle(&workspace)), ACTIVE) {
        return Err(GitError::new(
          "precondition-not-met",
          format!(
            "Workspace '{}' must be active before it can be checkpointed.",
            js_text(member(&workspace, "name"))
          ),
        ));
      }
      return Ok(workspace);
    }
  }
  let mut main = Object::new();
  main.set("id", string("main"));
  main.set("name", string(&basename(&context.root)));
  main.set("path", string(&context.root));
  main.set("target", string("HEAD"));
  main.set("baseSnapshot", string(&engine::current_head(cwd)?));
  Ok(Value::Object(main))
}

/// `checkpointWorkspace(label)`: the worktree's whole state, untracked files
/// included, as a commit on its base, published under the checkpoint ref.
pub fn checkpoint_workspace(label: Option<&str>, cwd: &str) -> GitResult<Value> {
  let context = engine::repo_context(cwd)?;
  let workspace = current_workspace(cwd)?;
  let scratch = crate::export::temporary_directory("vlab-index-")?;
  let id = js_text(member(&workspace, "id"));
  let reference = format!("{}/{id}", ref_family("checkpoints", cwd)?);
  let result = (|| -> GitResult<Value> {
    let root = &context.root;
    let indexed = || RunOptions::new(root).env("GIT_INDEX_FILE", &text::join(&scratch, "index"));
    let args = |items: &[&str]| items.iter().map(|item| (*item).to_string()).collect::<Vec<_>>();
    run_git(&args(&["read-tree", "HEAD"]), &indexed())?;
    run_git(&args(&["add", "-A"]), &indexed())?;
    let tree = git_text(&args(&["write-tree"]), &indexed())?;
    let base_head = engine::current_head(root)?;
    let previous = if engine::ref_exists(&reference, root)? {
      Some(engine::resolve_revision(&reference, root)?)
    } else {
      None
    };
    let mut identity = Object::new();
    set_present(&mut identity, "workspaceId", member(&workspace, "id"));
    identity.set("baseHead", string(&base_head));
    identity.set("tree", string(&tree));
    let draft_change_id = format!(
      "draft_{}",
      causet_model::sha256::hex(stringify(&Value::Object(identity)).as_bytes())
    );
    let mut lines = vec![
      match label.filter(|label| !label.is_empty()) {
        Some(label) => label.to_string(),
        None => format!("Checkpoint {}", js_text(member(&workspace, "name"))),
      },
      String::new(),
      format!("Change-Id: {draft_change_id}"),
      format!("Workspace-Id: {id}"),
      format!("Workspace-Base: {base_head}"),
      format!("Workspace-Tree: {tree}"),
    ];
    if let Some(previous) = &previous {
      lines.push(format!("Workspace-Previous-Checkpoint: {previous}"));
    }
    let message = format!("{}\n", lines.join("\n"));
    let checkpoint = git_text(
      &args(&["commit-tree", &tree, "-p", &base_head, "-F", "-"]),
      &indexed().input(message.into_bytes()),
    )?;
    let mut history_ref = None;
    if let Some(previous) = &previous {
      let name = format!("{}/{id}/{previous}", ref_family("checkpoint-history", cwd)?);
      run_git(&args(&["update-ref", &name, previous]), &RunOptions::new(root))?;
      history_ref = Some(name);
    }
    run_git(&args(&["update-ref", &reference, &checkpoint]), &RunOptions::new(root))?;
    let optional = |value: &Option<String>| value.as_deref().map_or(Value::Null, string);
    let mut result = Object::new();
    result.set("schema", string("causet.checkpoint/v1"));
    result.set("id", string(&checkpoint));
    result.set("shortId", string(&checkpoint.chars().take(12).collect::<String>()));
    set_present(&mut result, "workspaceId", member(&workspace, "id"));
    set_present(&mut result, "workspaceName", member(&workspace, "name"));
    result.set("tree", string(&tree));
    result.set("parent", string(&base_head));
    result.set("baseHead", string(&base_head));
    result.set("previousCheckpoint", optional(&previous));
    result.set("historyRef", optional(&history_ref));
    result.set("draftChangeId", string(&draft_change_id));
    result.set("ref", string(&reference));
    result.set("label", label.filter(|label| !label.is_empty()).map_or(Value::Null, string));
    result.set("createdAt", string(&causet_engine::metrics::iso_now()));
    Ok(Value::Object(result))
  })();
  let _ = std::fs::remove_dir_all(&scratch);
  result
}

/// `assertNoOperationJournal(gitDir, action, recovery)`: any journal, under
/// either runtime name, blocks; its presence alone is enough.
fn assert_no_operation_journal(git_dir: &str, action: &str, recovery: &str) -> GitResult<()> {
  for set in [CURRENT_NAMES, LEGACY_NAMES] {
    for (file, command) in [("reconciliation.json", "reconcile"), ("rebase.json", "rebase")] {
      let journal = text::join(&text::join(git_dir, set.runtime), file);
      match std::fs::symlink_metadata(&journal) {
        Ok(_) => {
          return Err(
            GitError::new(
              "operation-in-progress",
              format!("Cannot {action}: a {command} operation journal exists at '{journal}'."),
            )
            .details(format!(
              "{recovery} Run 'cst {command} --status', then continue a resolved conflict or abort the operation in that worktree before retrying. If this build cannot read the journal, preserve it and recover with the build that wrote it."
            )),
          );
        }
        Err(error)
          if matches!(
            error.kind(),
            std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
          ) => {}
        Err(error) => return Err(io_failure(&error, "lstat", &journal)),
      }
    }
  }
  Ok(())
}

/// `pruneWorkspaces({ apply, dryRun })`: active workspaces whose path is gone,
/// reported, or with `--apply` archived after `git worktree prune`.
pub fn prune_workspaces(apply: bool, dry_run: bool, cwd: &str) -> GitResult<Value> {
  if !apply {
    return prune_locked(apply, dry_run, cwd);
  }
  with_registry_lock(cwd, || prune_locked(apply, dry_run, cwd))
}

fn prune_locked(apply: bool, dry_run: bool, cwd: &str) -> GitResult<Value> {
  if apply && dry_run {
    return Err(GitError::new(
      "usage-conflicting-options",
      "Choose either --dry-run or --apply for workspace prune.",
    ));
  }
  let context = engine::repo_context(cwd)?;
  let mut state = if apply { read_mutation_state(cwd)? } else { read_workspaces(cwd)? };
  let mut workspaces = workspaces_of(&state);
  let candidates: Vec<usize> = workspaces
    .iter()
    .enumerate()
    .filter(|(_, workspace)| {
      let exists = match member(workspace, "path") {
        Some(Value::String(units)) => std::path::Path::new(&lossy(units)).exists(),
        _ => false,
      };
      is_text(Some(&lifecycle(workspace)), ACTIVE) && !exists
    })
    .map(|(index, _)| index)
    .collect();
  let mut result = Object::new();
  result.set("schema", string("causet.workspace-prune/v1"));
  result.set("dryRun", Value::Bool(!apply));
  result.set("applied", Value::Bool(apply));
  result.set("changed", Value::Bool(false));
  result.set("count", Value::Number(candidates.len() as f64));
  result.set(
    "candidates",
    Value::Array(
      candidates
        .iter()
        .map(|index| {
          let workspace = &workspaces[*index];
          let mut candidate = Object::new();
          for name in ["id", "name", "path", "compatibilityBranch"] {
            set_present(&mut candidate, name, member(workspace, name));
          }
          Value::Object(candidate)
        })
        .collect(),
    ),
  );
  if !apply || candidates.is_empty() {
    return Ok(Value::Object(result));
  }

  // `git worktree prune` is repository-wide, so every linked journal must be
  // recovered first.
  for git_dir in engine::list_worktree_git_dirs(cwd)? {
    assert_no_operation_journal(
      &git_dir,
      "prune workspaces",
      "Restore any missing worktree path and repair its Git links before recovery.",
    )?;
  }
  run_git(&["worktree".to_string(), "prune".to_string()], &RunOptions::new(&context.root))?;
  let now = causet_engine::metrics::iso_now();
  for index in candidates {
    let workspace = &workspaces[index];
    let branch_ref = format!("refs/heads/{}", js_text(member(workspace, "compatibilityBranch")));
    let last_head = if engine::ref_exists(&branch_ref, cwd)? {
      string(&engine::resolve_revision(&branch_ref, cwd)?)
    } else {
      match member(workspace, "lastHead") {
        value if nullish(value) => Value::Null,
        value => value.cloned().unwrap_or(Value::Null),
      }
    };
    let mut archived = spread(workspace);
    archived.set("lifecycle", string(ARCHIVED));
    archived.set("archivedAt", string(&now));
    archived.set("archiveReason", string("missing-path-pruned"));
    archived.set("lastHead", last_head);
    archived.set("updatedAt", string(&now));
    workspaces[index] = Value::Object(archived);
  }
  state.set("workspaces", Value::Array(workspaces));
  save_workspaces(&state, cwd)?;
  result.set("changed", Value::Bool(true));
  Ok(Value::Object(result))
}

/// `readClaim(file)`: the holder's claim, or `None` for anything unreadable.
fn read_claim(file: &str) -> Option<Value> {
  let metadata = std::fs::metadata(file).ok()?;
  if metadata.len() > 4_096 {
    return None;
  }
  parse(&String::from_utf8_lossy(&std::fs::read(file).ok()?)).ok()
}

/// `withWorkspaceRegistryLock(cwd, action)`: one registry transaction at a
/// time across every linked worktree. No waiter ever removes a claim.
fn with_registry_lock<T>(cwd: &str, action: impl FnOnce() -> GitResult<T>) -> GitResult<T> {
  let runtime = ensure_lab_runtime(cwd)?;
  let real = std::fs::canonicalize(&runtime)
    .map(|path| path.to_string_lossy().into_owned())
    .unwrap_or(runtime);
  let file = text::join(real.strip_prefix(r"\\?\").unwrap_or(&real), "workspaces.lock");
  let token = host::new_id("lock");
  let mut claim = Object::new();
  claim.set("token", string(&token));
  claim.set("pid", Value::Number(f64::from(std::process::id())));
  claim.set("hostname", string(&host::hostname()));
  claim.set("createdAt", string(&causet_engine::metrics::iso_now()));
  let claim = format!("{}\n", stringify(&Value::Object(claim)));
  let deadline = host::now_ms() + LOCK_WAIT_MS;
  loop {
    let created = std::fs::OpenOptions::new().write(true).create_new(true).open(&file);
    match created {
      Ok(mut handle) => {
        use std::io::Write as _;
        handle.write_all(claim.as_bytes()).map_err(|error| io_failure(&error, "write", &file))?;
        break;
      }
      Err(error) if transient(&error) => {}
      Err(error) => return Err(io_failure(&error, "open", &file)),
    }
    host::gate_point("workspaces:lock-contended");
    if host::now_ms() >= deadline {
      let holder = read_claim(&file);
      let pid = match member_of(holder.as_ref(), "pid") {
        Some(Value::Number(pid)) if *pid > 0.0 && pid.fract() == 0.0 && *pid <= 9_007_199_254_740_991.0 => {
          format!("{pid}")
        }
        _ => "unknown".into(),
      };
      let hostname = match member_of(holder.as_ref(), "hostname") {
        Some(Value::String(units)) => lossy(&units[..units.len().min(255)]),
        _ => "unknown".into(),
      };
      return Err(GitError::new("workspace-registry-locked", "The workspace registry lock could not be acquired.").details(format!(
        "{file}\nHolder: process {pid} on {hostname}\nWait for the operation to finish and retry. For an abandoned lock, stop all workspace writers on every host sharing this repository, inspect the registry and Git worktrees for partial changes, then remove only this lock file before restarting writers. Age or a missing PID alone does not authorize removing a lock while writers can run."
      )));
    }
    std::thread::sleep(std::time::Duration::from_millis(LOCK_POLL_MS));
  }
  let result = action();
  // Preserve a claim replaced out of band rather than deleting another holder's.
  if is_text(member_of(read_claim(&file).as_ref(), "token"), &token) {
    let _ = std::fs::remove_file(&file);
  }
  result
}

fn member_of<'a>(value: Option<&'a Value>, name: &str) -> Option<&'a Value> {
  causet_model::js::get(value, name)
}
