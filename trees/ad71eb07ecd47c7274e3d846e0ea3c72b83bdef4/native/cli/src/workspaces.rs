//! `cst workspace` (every subcommand but `forecast`): `src/workspaces.js` and
//! the registry lock of `src/workspace-lock.js`.

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
      // `path.join` normalizes a Git-reported directory to native separators.
      let journal = text::resolve_path(&text::join(&text::join(git_dir, set.runtime), file));
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

// ---------------------------------------------------------------------------
// Lifecycle writes
// ---------------------------------------------------------------------------

/// `findWorkspace(state, value)`: by name or id.
fn find_workspace(state: &Object, value: &str) -> GitResult<(usize, Value)> {
  workspaces_of(state)
    .into_iter()
    .enumerate()
    .find(|(_, workspace)| is_text(member(workspace, "name"), value) || is_text(member(workspace, "id"), value))
    .ok_or_else(|| GitError::new("not-found", format!("Workspace '{value}' was not found.")))
}

/// `requireLifecycle(workspace, lifecycle, action)`.
fn require_lifecycle(workspace: &Value, expected: &str, action: &str) -> GitResult<()> {
  if is_text(Some(&lifecycle(workspace)), expected) {
    return Ok(());
  }
  Err(GitError::new(
    "precondition-not-met",
    format!(
      "Workspace '{}' must be {expected} before it can be {action}.",
      js_text(member(workspace, "name"))
    ),
  ))
}

/// `requireMaterialized(workspace, action)`.
fn require_materialized(workspace: &Value, action: &str) -> GitResult<()> {
  let inspected = inspect_workspace(workspace)?;
  if is_text(member(&inspected, "pathStatus"), ACTIVE) {
    return Ok(());
  }
  Err(GitError::new(
    "precondition-not-met",
    format!(
      "Workspace '{}' is not a usable linked worktree. Repair or prune its stale path before {action}.",
      js_text(member(workspace, "name"))
    ),
  ))
}

/// `assertCallerOutsideWorkspace(cwd, workspace, action)`.
fn assert_caller_outside(cwd: &str, workspace: &Value, action: &str) -> GitResult<()> {
  let root = text::resolve_path(&engine::repo_context(cwd)?.root);
  if root == resolve_value(member(workspace, "path"))? {
    return Err(GitError::new(
      "precondition-not-met",
      format!(
        "Run workspace {action} from another linked worktree; the command changes '{}'.",
        js_text(member(workspace, "path"))
      ),
    ));
  }
  Ok(())
}

/// `appendPreviousPath(workspace, previousPath)`: every earlier path,
/// resolved, each once, in first-seen order. A string spreads into its
/// characters, and anything else that is not a list throws as V8 does.
fn append_previous_path(workspace: &Value, previous: Option<&Value>) -> GitResult<Value> {
  let mut items: Vec<Value> = match member(workspace, "previousPaths") {
    value if nullish(value) => Vec::new(),
    Some(Value::Array(items)) => items.clone(),
    Some(Value::String(units)) => lossy(units).chars().map(|c| string(&c.to_string())).collect(),
    _ => return Err(GitError::uncoded("(workspace.previousPaths ?? []) is not iterable")),
  };
  items.push(previous.cloned().unwrap_or(Value::Null));
  let mut resolved: Vec<String> = Vec::new();
  for item in &items {
    let path = resolve_value(Some(item))?;
    if !resolved.contains(&path) {
      resolved.push(path);
    }
  }
  Ok(Value::Array(resolved.iter().map(|path| string(path)).collect()))
}

/// `updateWorkspace(state, index, updates, cwd)`: the entry with `updates`
/// spread over it, saved with the whole registry.
fn update_workspace(state: &mut Object, index: usize, updates: Vec<(&str, Value)>, cwd: &str) -> GitResult<Value> {
  let mut workspaces = workspaces_of(state);
  let mut updated = spread(&workspaces[index]);
  for (name, value) in updates {
    updated.set(name, value);
  }
  workspaces[index] = Value::Object(updated);
  state.set("workspaces", Value::Array(workspaces.clone()));
  save_workspaces(state, cwd)?;
  Ok(workspaces.swap_remove(index))
}

/// `{ ...inspectWorkspace(workspace), changed }`.
fn changed(workspace: &Value, changed: bool) -> GitResult<Value> {
  let mut inspected = spread(&inspect_workspace(workspace)?);
  inspected.set("changed", Value::Bool(changed));
  Ok(Value::Object(inspected))
}

/// `path.dirname(path)` for an absolute path.
fn dirname(path: &str) -> String {
  let trimmed = path.trim_end_matches(['/', '\\']);
  match trimmed.rfind(['/', '\\']) {
    None => ".".into(),
    Some(0) => path[..1].to_string(),
    Some(index) if trimmed[..index].ends_with(':') => trimmed[..=index].to_string(),
    Some(index) => trimmed[..index].to_string(),
  }
}

fn make_parent(path: &str) -> GitResult<()> {
  let parent = dirname(path);
  std::fs::create_dir_all(&parent).map_err(|error| io_failure(&error, "mkdir", &parent))
}

/// `normalizeCone(cone)`: relative directory prefixes, each once, sorted, or
/// `None`; a cone that leaves the repository is refused.
fn normalize_cone(cone: Option<&Value>) -> GitResult<Option<Vec<String>>> {
  if nullish(cone) {
    return Ok(None);
  }
  let raw: Vec<String> = match cone {
    Some(Value::Array(items)) => items.iter().map(|item| js_text(Some(item))).collect(),
    other => js_text(other).split(',').map(str::to_string).collect(),
  };
  let entries: Vec<String> = raw
    .iter()
    .map(|entry| {
      let entry = text::trim(entry).replace('\\', "/");
      entry.strip_prefix("./").map(str::to_string).unwrap_or(entry)
    })
    .filter(|entry| !entry.is_empty())
    .map(|entry| entry.trim_end_matches('/').to_string())
    .collect();
  if entries.is_empty() {
    return Ok(None);
  }
  for entry in &entries {
    let bytes = entry.as_bytes();
    let drive = bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':';
    if entry.starts_with('/') || drive {
      return Err(GitError::new(
        "path-outside-repository",
        format!("Cone path must be relative to the repository root: '{entry}'"),
      ));
    }
    if entry == ".." || entry.starts_with("../") || entry.contains("/../") {
      return Err(GitError::new(
        "path-outside-repository",
        format!("Cone path must stay inside the repository: '{entry}'"),
      ));
    }
  }
  let mut unique: Vec<String> = Vec::new();
  for entry in entries {
    if !unique.contains(&entry) {
      unique.push(entry);
    }
  }
  text::sort(&mut unique);
  Ok(Some(unique))
}

/// `addWorktree(context, worktreePath, addArgs, cone)`: a linked worktree,
/// checked out only inside the cone when there is one.
fn add_worktree(root: &str, worktree_path: &str, add_args: &[String], cone: Option<&[String]>) -> GitResult<()> {
  let git = |args: Vec<String>, cwd: &str| run_git(&args, &RunOptions::new(cwd)).map(|_| ());
  let added = (|| -> GitResult<()> {
    let mut args = vec!["worktree".to_string(), "add".to_string()];
    let Some(cone) = cone.filter(|cone| !cone.is_empty()) else {
      args.extend(add_args.iter().cloned());
      return git(args, root);
    };
    args.push("--no-checkout".into());
    args.extend(add_args.iter().cloned());
    git(args, root)?;
    let mut sparse = vec!["sparse-checkout".to_string(), "set".to_string(), "--cone".to_string()];
    sparse.extend(cone.iter().cloned());
    git(sparse, worktree_path)?;
    git(vec!["checkout".to_string()], worktree_path)
  })();
  added.map_err(|mut error| {
    error.details = format!(
      "{}\nWorkspace materialization failed at '{worktree_path}'. The workspace registry was not updated. Git may have created a worktree or branch; inspect them with git worktree list before repairing or removing partial materialization and retrying.",
      error.details
    );
    error
  })
}

/// What `cst workspace create` takes besides the name.
pub struct CreateOptions<'a> {
  pub from: Option<&'a str>,
  pub path: Option<&'a str>,
  pub owner: Option<&'a str>,
  pub focus: Option<&'a str>,
  pub cone: Option<&'a str>,
}

/// `createWorkspace(name, options)`: a linked worktree on a new compatibility
/// branch at the base, registered as an active workspace.
pub fn create_workspace(name: &str, options: &CreateOptions, cwd: &str) -> GitResult<Value> {
  with_registry_lock(cwd, || create_locked(name, options, cwd))
}

fn create_locked(name: &str, options: &CreateOptions, cwd: &str) -> GitResult<Value> {
  let context = engine::repo_context(cwd)?;
  let target = options.from.unwrap_or("HEAD");
  let safe_name = crate::spec::slug(name);
  let branch = format!("{}{safe_name}", causet_engine::locations::names(cwd)?.workspace_branch_prefix);
  let objects = engine::inspect_git_objects(&[format!("{target}^{{commit}}"), format!("refs/heads/{branch}")], cwd)?;
  let (base, branch_object) = (&objects.records[0], &objects.records[1]);
  if !base.exists || base.kind.as_deref() != Some("commit") {
    return Err(GitError::new(
      "revision-not-resolved",
      format!("Git revision '{target}' did not resolve to a commit."),
    ));
  }
  let base_snapshot = base.oid.clone().unwrap_or_default();

  let mut state = read_mutation_state(cwd)?;
  if workspaces_of(&state).iter().any(|workspace| is_text(member(workspace, "name"), name)) {
    return Err(GitError::new("already-exists", format!("Workspace '{name}' already exists.")));
  }
  let workspace_path = match options.path {
    Some(path) => text::resolve_path(path),
    None => text::resolve_path(&format!(
      "{}/{}.workspaces/{safe_name}",
      dirname(&context.root),
      basename(&context.root)
    )),
  };
  if branch_object.exists {
    return Err(GitError::new(
      "already-exists",
      format!("The compatibility branch '{branch}' already exists."),
    ));
  }
  let cone = normalize_cone(options.cone.map(string).as_ref())?;
  make_parent(&workspace_path)?;
  add_worktree(
    &context.root,
    &workspace_path,
    &["-b", &branch, &workspace_path, &base_snapshot].map(String::from),
    cone.as_deref(),
  )?;

  let optional = |value: Option<&str>| value.map_or(Value::Null, string);
  let mut workspace = Object::new();
  workspace.set("schema", string("causet.workspace/v1"));
  workspace.set("id", string(&host::new_id("ws")));
  workspace.set("name", string(name));
  workspace.set("path", string(&workspace_path));
  workspace.set("compatibilityBranch", string(&branch));
  workspace.set("target", string(target));
  workspace.set("baseSnapshot", string(&base_snapshot));
  workspace.set("createdAt", string(&causet_engine::metrics::iso_now()));
  workspace.set("owner", optional(options.owner));
  workspace.set("focus", optional(options.focus));
  workspace.set(
    "cone",
    cone.map_or(Value::Null, |cone| Value::Array(cone.iter().map(|entry| string(entry)).collect())),
  );
  workspace.set("lifecycle", string(ACTIVE));
  let workspace = Value::Object(workspace);
  let mut workspaces = workspaces_of(&state);
  workspaces.push(workspace.clone());
  state.set("workspaces", Value::Array(workspaces));
  save_workspaces(&state, cwd)?;
  Ok(workspace)
}

/// `moveWorkspace(value, destination)`: `git worktree move`, with the old
/// path kept in `previousPaths`.
pub fn move_workspace(value: &str, destination: &str, cwd: &str) -> GitResult<Value> {
  with_registry_lock(cwd, || {
    let context = engine::repo_context(cwd)?;
    let mut state = read_mutation_state(cwd)?;
    let (index, workspace) = find_workspace(&state, value)?;
    require_lifecycle(&workspace, ACTIVE, "moved")?;
    require_materialized(&workspace, "moving it")?;
    assert_caller_outside(cwd, &workspace, "move")?;
    let next_path = text::resolve_path(destination);
    if next_path == resolve_value(member(&workspace, "path"))? {
      return changed(&workspace, false);
    }
    if std::path::Path::new(&next_path).exists() {
      return Err(GitError::new(
        "already-exists",
        format!("Workspace destination already exists: {next_path}"),
      ));
    }
    make_parent(&next_path)?;
    let current = js_text(member(&workspace, "path"));
    run_git(&["worktree", "move", &current, &next_path].map(String::from), &RunOptions::new(&context.root))?;
    let now = string(&causet_engine::metrics::iso_now());
    let previous = append_previous_path(&workspace, member(&workspace, "path"))?;
    let updated = update_workspace(
      &mut state,
      index,
      vec![("path", string(&next_path)), ("previousPaths", previous), ("movedAt", now.clone()), ("updatedAt", now)],
      cwd,
    )?;
    changed(&updated, true)
  })
}

/// `archiveWorkspace(value)`: a clean worktree removed, its branch and last
/// HEAD kept so it can be restored.
pub fn archive_workspace(value: &str, cwd: &str) -> GitResult<Value> {
  with_registry_lock(cwd, || {
    let context = engine::repo_context(cwd)?;
    let mut state = read_mutation_state(cwd)?;
    let (index, workspace) = find_workspace(&state, value)?;
    require_lifecycle(&workspace, ACTIVE, "archived")?;
    require_materialized(&workspace, "archiving it")?;
    assert_caller_outside(cwd, &workspace, "archive")?;
    let path = js_text(member(&workspace, "path"));
    let name = js_text(member(&workspace, "name"));
    assert_no_operation_journal(
      &engine::repo_context(&path)?.git_dir,
      &format!("archive workspace '{name}'"),
      &format!("Recover the operation in '{path}'."),
    )?;
    let status = engine::porcelain_status(&path, false)?;
    if !status.is_empty() {
      return Err(
        GitError::new(
          "precondition-not-met",
          format!("Workspace '{name}' has tracked or untracked changes. Commit or remove them before archiving."),
        )
        .details(status),
      );
    }
    let ignored = engine::ignored_paths(&path)?;
    if !ignored.is_empty() {
      return Err(
        GitError::new(
          "precondition-not-met",
          format!("Workspace '{name}' contains ignored files. Move or remove them before archiving."),
        )
        .details(ignored.join("\n")),
      );
    }
    let last_head = engine::current_head(&path)?;
    run_git(&["worktree", "remove", &path].map(String::from), &RunOptions::new(&context.root))?;
    let now = string(&causet_engine::metrics::iso_now());
    let updated = update_workspace(
      &mut state,
      index,
      vec![
        ("lifecycle", string(ARCHIVED)),
        ("archivedAt", now.clone()),
        ("archiveReason", string("user")),
        ("lastHead", string(&last_head)),
        ("updatedAt", now),
      ],
      cwd,
    )?;
    changed(&updated, true)
  })
}

/// `restoreWorkspace(value, { path })`: the archived workspace materialized
/// again from its branch, with the cone it was created with.
pub fn restore_workspace(value: &str, path: Option<&str>, cwd: &str) -> GitResult<Value> {
  with_registry_lock(cwd, || {
    let context = engine::repo_context(cwd)?;
    let mut state = read_mutation_state(cwd)?;
    let (index, workspace) = find_workspace(&state, value)?;
    require_lifecycle(&workspace, ARCHIVED, "restored")?;
    let branch = js_text(member(&workspace, "compatibilityBranch"));
    if !engine::ref_exists(&format!("refs/heads/{branch}"), cwd)? {
      return Err(GitError::new(
        "not-found",
        format!("Workspace branch '{branch}' no longer exists."),
      ));
    }
    let restored_path = match path {
      Some(path) => text::resolve_path(path),
      None => resolve_value(member(&workspace, "path"))?,
    };
    if std::path::Path::new(&restored_path).exists() {
      return Err(GitError::new(
        "already-exists",
        format!("Workspace restore path already exists: {restored_path}"),
      ));
    }
    make_parent(&restored_path)?;
    let cone = normalize_cone(member(&workspace, "cone"))?;
    add_worktree(&context.root, &restored_path, &[restored_path.clone(), branch], cone.as_deref())?;
    let now = string(&causet_engine::metrics::iso_now());
    let mut updates = vec![
      ("path", string(&restored_path)),
      ("lifecycle", string(ACTIVE)),
      ("archivedAt", Value::Null),
      ("archiveReason", Value::Null),
      ("restoredAt", now.clone()),
      ("updatedAt", now),
    ];
    if restored_path != resolve_value(member(&workspace, "path"))? {
      updates.push(("previousPaths", append_previous_path(&workspace, member(&workspace, "path"))?));
    }
    let updated = update_workspace(&mut state, index, updates, cwd)?;
    changed(&updated, true)
  })
}

/// `repairWorkspace(value, destination)`: re-link a workspace whose worktree
/// was moved outside causet, after checking it is this repository's worktree
/// on the workspace's branch.
pub fn repair_workspace(value: &str, destination: &str, cwd: &str) -> GitResult<Value> {
  with_registry_lock(cwd, || {
    let context = engine::repo_context(cwd)?;
    let mut state = read_mutation_state(cwd)?;
    let (index, workspace) = find_workspace(&state, value)?;
    let repaired_path = text::resolve_path(destination);
    if !std::path::Path::new(&repaired_path).exists() {
      return Err(GitError::new(
        "not-found",
        format!("Workspace repair path does not exist: {repaired_path}"),
      ));
    }
    let recorded_exists = match member(&workspace, "path") {
      Some(Value::String(units)) => std::path::Path::new(&lossy(units)).exists(),
      _ => false,
    };
    if resolve_value(member(&workspace, "path"))? != repaired_path && recorded_exists {
      return Err(GitError::new(
        "precondition-not-met",
        format!(
          "Recorded workspace path still exists: {}. Use workspace move instead.",
          js_text(member(&workspace, "path"))
        ),
      ));
    }
    let repaired_context = engine::repo_context(&repaired_path).map_err(|_| {
      GitError::new(
        "precondition-not-met",
        format!("Repair path is not a linked Git worktree: {repaired_path}"),
      )
    })?;
    if text::resolve_path(&repaired_context.common_dir) != text::resolve_path(&context.common_dir) {
      return Err(GitError::new(
        "repository-mismatch",
        "Repair path belongs to a different Git repository.",
      ));
    }
    let head_ref = engine::symbolic_ref("HEAD", &repaired_path, false)?;
    let branch = head_ref
      .as_deref()
      .and_then(|name| name.strip_prefix("refs/heads/"))
      .unwrap_or("")
      .to_string();
    if !is_text(member(&workspace, "compatibilityBranch"), &branch) {
      return Err(GitError::new(
        "precondition-not-met",
        format!(
          "Repair path has branch '{}', expected '{}'.",
          if branch.is_empty() { "(detached)" } else { &branch },
          js_text(member(&workspace, "compatibilityBranch"))
        ),
      ));
    }
    run_git(&["worktree", "repair", &repaired_path].map(String::from), &RunOptions::new(&context.root))?;
    let now = string(&causet_engine::metrics::iso_now());
    let mut updates = vec![
      ("path", string(&repaired_path)),
      ("lifecycle", string(ACTIVE)),
      ("archivedAt", Value::Null),
      ("archiveReason", Value::Null),
      ("repairedAt", now.clone()),
      ("updatedAt", now),
    ];
    if repaired_path != resolve_value(member(&workspace, "path"))? {
      updates.push(("previousPaths", append_previous_path(&workspace, member(&workspace, "path"))?));
    }
    let updated = update_workspace(&mut state, index, updates, cwd)?;
    changed(&updated, true)
  })
}
