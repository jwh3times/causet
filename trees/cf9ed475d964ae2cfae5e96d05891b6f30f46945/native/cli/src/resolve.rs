//! `cst resolve`: the retained resolution catalog of `src/resolutions.js`
//! (`listResolutionRecords`), the pending operation's conflicts
//! (`pendingResolutionStatus`), and the explicit decisions on them
//! (`applyResolution` and `rejectResolution`), with their renderings in
//! `src/cli.js`.

use crate::metadata::{duplicated_record_ids, object_lookup};
use crate::notes::read_notes;
use crate::records::{not_callable, short};
use crate::store::read_json;
use causet_engine::errors::{GitError, GitResult};
use causet_engine::locations::{local_ref, ref_family, runtime_directory};
use causet_engine::process::{RunOptions, run_git};
use causet_engine::session::with_object_session;
use causet_engine::{engine, text};
use causet_model::js::{
  get, length, locale_compare, nullish, strict_equals, text as js_text, to_number, truthy,
};
use causet_model::json::{Object, Value, lossy, string};
use causet_model::schemas::{
  assert_readable_schema, referenced_objects, resolution_signature, validate_note_record,
};

fn as_text(value: Option<&Value>) -> Option<String> {
  match value {
    Some(Value::String(units)) => Some(lossy(units)),
    _ => None,
  }
}

/// `{ ...record, attachedTo: commit, discoveredRef: ref, commit }`.
fn retained_record(record: &Value, name: &str, commit: &str) -> Value {
  let mut spread = match record {
    Value::Object(object) => object.clone(),
    _ => Object::new(),
  };
  spread.set("attachedTo", string(commit));
  spread.set("discoveredRef", string(name));
  spread.set("commit", string(commit));
  Value::Object(spread)
}

/// `listResolutionRecords(cwd)`: the retained resolution catalog, newest first.
pub fn list_resolution_records(cwd: &str) -> GitResult<Vec<Value>> {
  // `scanResolutionRefs`: naming the family needs the repository, and that
  // failure is refused as the scan's, inside the same `try`.
  let scan = ref_family("resolutions", cwd).and_then(|family| engine::list_refs(&family, cwd));
  let entries = scan.map_err(|error| {
    GitError::new(
      "git-command-failed",
      "Could not scan resolution retention refs.",
    )
    .details(error.details)
  })?;
  if entries.is_empty() {
    return Ok(Vec::new());
  }
  with_object_session(cwd, || -> GitResult<Vec<Value>> {
    // `peelResolutionRefs`: the refs that name a commit.
    let expressions: Vec<String> = entries
      .iter()
      .map(|entry| format!("{}^{{commit}}", entry.oid))
      .collect();
    let objects = engine::inspect_git_objects(&expressions, cwd)?;
    let refs: Vec<(String, String)> = entries
      .iter()
      .zip(objects.records)
      .filter(|(_, object)| object.exists && object.kind.as_deref() == Some("commit"))
      .map(|(entry, object)| (entry.name.clone(), object.oid.unwrap_or_default()))
      .collect();
    if refs.is_empty() {
      return Ok(Vec::new());
    }
    retained_resolutions(&refs, cwd)
  })
}

/// `retainedResolutions(refs, cwd)`.
fn retained_resolutions(refs: &[(String, String)], cwd: &str) -> GitResult<Vec<Value>> {
  let commits: Vec<String> = refs.iter().map(|(_, commit)| commit.clone()).collect();
  let notes = read_notes(&commits, cwd)?;
  let mut records = Vec::new();
  for (name, commit) in refs {
    for record in notes.get(commit).cloned().unwrap_or_default() {
      let kind = match &record {
        Value::Null => {
          return Err(GitError::uncoded(
            "Cannot read properties of null (reading 'type')",
          ));
        }
        other => get(Some(other), "type"),
      };
      if as_text(kind).as_deref() == Some("resolution") {
        records.push(retained_record(&record, name, commit));
      }
    }
  }
  // `acceptedCausalRecords(records, cwd, { conflictingIds })`.
  let context = engine::repo_context(cwd)?;
  let conflicting = duplicated_record_ids(&records.iter().collect::<Vec<_>>());
  let structural: Vec<Value> = records
    .into_iter()
    .filter(|record| {
      let duplicated = as_text(get(Some(record), "id")).is_some_and(|id| conflicting.contains(&id));
      !duplicated && validate_note_record(Some(record), &context.object_format).is_empty()
    })
    .collect();
  let references: Vec<String> = structural
    .iter()
    .flat_map(|record| referenced_objects(Some(record)))
    .map(|reference| lossy(&reference.oid))
    .collect();
  let objects = object_lookup(references, cwd)?;
  let mut accepted = Vec::new();
  for record in structural {
    let present = referenced_objects(Some(&record)).iter().all(|reference| {
      objects
        .get(&lossy(&reference.oid))
        .is_some_and(|object| object.exists && object.kind.as_deref() == Some(reference.kind))
    });
    if !present {
      continue;
    }
    let member = |name: &str| as_text(get(Some(&record), name));
    let local = local_ref(&member("ref").unwrap_or_default(), cwd)?;
    let signature = resolution_signature(Some(&record)).ok();
    if Some(local) == member("discoveredRef")
      && member("resolutionCommit").is_some()
      && member("resolutionCommit") == member("commit")
      && signature.is_some()
      && signature == member("signature")
    {
      accepted.push(record);
    }
  }
  // Only existence, type and identity of the retained results are checked.
  let expressions: Vec<String> = accepted
    .iter()
    .filter(|record| truthy(get(Some(record), "resultBlob")))
    .map(|record| format!("{}:result", js_text(get(Some(record), "commit"))))
    .collect();
  let retained = engine::inspect_git_objects(&expressions, cwd)?.records;
  let mut index = 0;
  let mut catalog: Vec<Value> = accepted
    .into_iter()
    .filter(|record| {
      if !truthy(get(Some(record), "resultBlob")) {
        return true;
      }
      let object = retained.get(index);
      index += 1;
      object.is_some_and(|object| {
        object.exists
          && object.kind.as_deref() == Some("blob")
          && object.oid.as_deref() == as_text(get(Some(record), "resultBlob")).as_deref()
      })
    })
    .collect();
  let created = |record: &Value| {
    let value = get(Some(record), "createdAt");
    if nullish(value) {
      String::new()
    } else {
      js_text(value)
    }
  };
  catalog.sort_by(|left, right| locale_compare(&created(right), &created(left)));
  Ok(catalog)
}

/// `formatResolutionCatalog(records)`.
pub fn format_resolution_catalog(records: &[Value]) -> String {
  if records.is_empty() {
    return "No reusable resolutions have been recorded.".into();
  }
  let mut lines = vec![
    format!(
      "{} reusable resolution{}",
      records.len(),
      if records.len() == 1 { "" } else { "s" }
    ),
    String::new(),
  ];
  for record in records {
    let member = |name: &str| get(Some(record), name);
    let or = |name: &str, fallback: &str| {
      if nullish(member(name)) {
        fallback.to_string()
      } else {
        js_text(member(name))
      }
    };
    lines.push(format!(
      "{}  {} -> {}",
      js_text(member("id")),
      short(member("signature")),
      short(member("resultBlob"))
    ));
    lines.push(format!(
      "  original path {}; {}",
      or("originalPath", "-"),
      or("createdAt", "unknown time")
    ));
  }
  lines.join("\n")
}

/// One journal under this worktree's runtime directory, refused when this
/// build does not read its version (ADR-0020).
pub(crate) fn read_journal(cwd: &str, file: &str, family: &str, kind: &str) -> GitResult<Option<Value>> {
  let git_dir = engine::repo_context(cwd)?.git_dir;
  let path = text::join(&runtime_directory(&git_dir, cwd)?, file);
  let state = match read_json(&path)? {
    None | Some(Value::Null) => return Ok(None),
    Some(state) => state,
  };
  assert_readable_schema(
    as_text(get(Some(&state), "schema")).as_deref(),
    &format!("The {kind} journal at '{path}'"),
    Some(family),
    "Recover it with the causet build that wrote it, or remove the file to discard the operation.",
  )
  .map_err(|refusal| GitError::new(refusal.code, refusal.message).details(refusal.details))?;
  Ok(Some(state))
}

/// `readPendingOperation(cwd)`: the reconciliation or rebase journal.
pub(crate) fn read_pending_operation(cwd: &str) -> GitResult<Option<Value>> {
  let reconciliation = read_journal(
    cwd,
    "reconciliation.json",
    "causet.reconciliation-operation",
    "reconciliation",
  )?;
  let rebase = read_journal(cwd, "rebase.json", "causet.rebase-operation", "rebase")?;
  if reconciliation.is_some() && rebase.is_some() {
    return Err(
      GitError::new(
        "git-operation-active",
        "This worktree contains both reconciliation and rebase journals.",
      )
      .details("Do not mutate the worktree; inspect and recover one journal explicitly."),
    );
  }
  Ok(reconciliation.or(rebase))
}

/// `pendingResolutionStatus()`.
pub fn pending_resolution_status(cwd: &str) -> GitResult<Value> {
  let operation = read_pending_operation(cwd)?;
  let conflicts = get(get(operation.as_ref(), "current"), "conflicts");
  let mut status = Object::new();
  status.set(
    "active",
    Value::Bool(truthy(length(conflicts).as_ref()) && !nullish(conflicts)),
  );
  let id = get(operation.as_ref(), "id");
  status.set(
    "operationId",
    if nullish(id) {
      Value::Null
    } else {
      id.cloned().unwrap_or(Value::Null)
    },
  );
  status.set(
    "conflicts",
    if nullish(conflicts) {
      Value::Array(Vec::new())
    } else {
      conflicts.cloned().unwrap_or(Value::Null)
    },
  );
  Ok(Value::Object(status))
}

/// `for (const item of <expression>)`: an array's items or a string's code
/// points, and V8's refusal for anything else.
fn iterate(value: Option<&Value>, expression: &str) -> GitResult<Vec<Value>> {
  match value {
    Some(Value::Array(items)) => Ok(items.clone()),
    Some(Value::String(units)) => Ok(
      String::from_utf16_lossy(units)
        .chars()
        .map(|c| string(&c.to_string()))
        .collect(),
    ),
    _ => Err(GitError::uncoded(format!("{expression} is not iterable"))),
  }
}

/// `x.<name>`, which throws when `x` is `null` or `undefined`.
fn member<'a>(value: Option<&'a Value>, name: &str) -> GitResult<Option<&'a Value>> {
  match value {
    None => Err(GitError::uncoded(format!(
      "Cannot read properties of undefined (reading '{name}')"
    ))),
    Some(Value::Null) => Err(GitError::uncoded(format!(
      "Cannot read properties of null (reading '{name}')"
    ))),
    other => Ok(get(other, name)),
  }
}

/// `formatResolutionStatus(status)`.
pub fn format_resolution_status(status: &Value) -> GitResult<String> {
  if !truthy(get(Some(status), "active")) {
    return Ok("No reusable conflict resolution is pending.".into());
  }
  let mut lines = vec![format!(
    "operation    {}",
    js_text(get(Some(status), "operationId"))
  )];
  let conflicts = get(Some(status), "conflicts");
  for conflict in iterate(conflicts, "status.conflicts")? {
    let conflict = Some(&conflict);
    let path = member(conflict, "path")?;
    let signature = member(conflict, "signature")?;
    let candidates = member(conflict, "candidates")?;
    let count = member(candidates, "length").map(|_| length(candidates))?;
    lines.push(String::new());
    lines.push(format!("path         {}", js_text(path)));
    lines.push(format!("signature    {}", short(signature)));
    lines.push(format!("candidates   {}", js_text(count.as_ref())));
    for candidate in iterate(candidates, "conflict.candidates")? {
      let candidate = Some(&candidate);
      let id = member(candidate, "id")?;
      let original = get(candidate, "originalPath");
      lines.push(format!(
        "  {} result {} from {}",
        js_text(id),
        short(get(candidate, "resultBlob")),
        if nullish(original) {
          "unknown path".to_string()
        } else {
          js_text(original)
        }
      ));
    }
  }
  // `status.conflicts.some((conflict) => conflict.candidates.length)`.
  let any = match conflicts {
    Some(Value::Array(items)) => {
      let mut found = false;
      for conflict in items {
        let candidates = member(Some(conflict), "candidates")?;
        let count = member(candidates, "length").map(|_| length(candidates))?;
        if truthy(count.as_ref()) {
          found = true;
          break;
        }
      }
      found
    }
    other => return Err(not_callable("status.conflicts", "some", other)),
  };
  if any {
    lines.push(String::new());
    lines.push("Apply a suggestion with: cst resolve apply --all".into());
  }
  Ok(lines.join("\n"))
}

/// `currentResolutionOperation(cwd)`: the pending operation, when its paused
/// step has conflicts (`operation?.current?.conflicts?.length`).
fn current_resolution_operation(cwd: &str) -> GitResult<Value> {
  let operation = read_pending_operation(cwd)?;
  let pending = truthy(length(get(get(operation.as_ref(), "current"), "conflicts")).as_ref());
  match operation {
    Some(operation) if pending => Ok(operation),
    _ => Err(GitError::new(
      "nothing-pending",
      "No reusable conflict resolutions are pending in this worktree.",
    )),
  }
}

/// Where a selected conflict lives in the journal, so a decision recorded on
/// it is written back as JavaScript's mutation of the same object would be.
enum Slot {
  /// `conflicts[index]` of an array.
  Index(usize),
  /// `conflicts[0]` of an object whose `length` is 1.
  Member,
  /// `conflicts[0]` of a one-character string, which nothing can record on.
  Detached(Value),
}

/// What `selectConflicts` returns: slots, or a value that is not an array
/// (which `--all` hands on as it is, for `selected.map` to refuse).
enum Selected {
  Slots(Vec<Slot>),
  NotArray,
}

/// `selectConflicts(operation, filePath, all)`.
fn select_conflicts(operation: &Value, file: Option<&str>, all: bool) -> GitResult<Selected> {
  let conflicts = get(get(Some(operation), "current"), "conflicts");
  if all {
    return Ok(match conflicts {
      Some(Value::Array(items)) => Selected::Slots((0..items.len()).map(Slot::Index).collect()),
      _ => Selected::NotArray,
    });
  }
  if let Some(file) = file.filter(|file| !file.is_empty()) {
    let Some(Value::Array(items)) = conflicts else {
      return Err(not_callable("operation.current.conflicts", "find", conflicts));
    };
    let wanted = string(file);
    for (index, conflict) in items.iter().enumerate() {
      if matches!(conflict, Value::Null) {
        return Err(GitError::uncoded("Cannot read properties of null (reading 'path')"));
      }
      if strict_equals(get(Some(conflict), "path"), Some(&wanted)) {
        return Ok(Selected::Slots(vec![Slot::Index(index)]));
      }
    }
    return Err(GitError::new(
      "no-match",
      format!("'{file}' is not a current conflict path."),
    ));
  }
  if strict_equals(length(conflicts).as_ref(), Some(&Value::Number(1.0))) {
    let slot = match conflicts {
      Some(Value::Array(_)) => Slot::Index(0),
      Some(Value::String(units)) => Slot::Detached(Value::String(units[..1].to_vec())),
      _ => Slot::Member,
    };
    return Ok(Selected::Slots(vec![slot]));
  }
  Err(GitError::new("ambiguous-match", "Choose a conflict path or pass --all."))
}

/// The value a slot names.
fn slot_value<'a>(conflicts: Option<&'a Value>, slot: &'a Slot) -> Option<&'a Value> {
  match slot {
    Slot::Index(index) => match conflicts {
      Some(Value::Array(items)) => items.get(*index),
      _ => None,
    },
    Slot::Member => get(conflicts, "0"),
    Slot::Detached(value) => Some(value),
  }
}

/// `value[0]`: an array's first item, a string's first code unit, or an
/// object's `0` member.
fn first_of(value: Option<&Value>) -> Option<Value> {
  match value {
    Some(Value::Array(items)) => items.first().cloned(),
    Some(Value::String(units)) if !units.is_empty() => Some(Value::String(units[..1].to_vec())),
    Some(Value::Object(object)) => object.get("0").cloned(),
    _ => None,
  }
}

/// `chooseCandidate(conflict, resolutionId)`. `None` is `undefined`.
fn choose_candidate(conflict: Option<&Value>, resolution_id: Option<&str>) -> GitResult<Option<Value>> {
  let candidates = member(conflict, "candidates")?;
  let path = || js_text(get(conflict, "path"));
  if let Some(id) = resolution_id {
    let Some(Value::Array(items)) = candidates else {
      return Err(not_callable("conflict.candidates", "find", candidates));
    };
    let wanted = string(id);
    for item in items {
      if matches!(item, Value::Null) {
        return Err(GitError::uncoded("Cannot read properties of null (reading 'id')"));
      }
      if strict_equals(get(Some(item), "id"), Some(&wanted)) {
        return Ok(Some(item.clone()));
      }
    }
    return Err(GitError::new(
      "no-match",
      format!("Resolution '{id}' is not a candidate for '{}'.", path()),
    ));
  }
  let count = member(candidates, "length").map(|_| length(candidates))?;
  if strict_equals(count.as_ref(), Some(&Value::Number(0.0))) {
    return Err(GitError::new(
      "no-match",
      format!("No prior resolution matches '{}'.", path()),
    ));
  }
  if count.as_ref().is_some_and(|count| to_number(count) > 1.0) {
    return Err(
      GitError::new("ambiguous-match", format!("Multiple resolutions match '{}'.", path()))
        .details("Choose one with --resolution <id>."),
    );
  }
  Ok(first_of(candidates))
}

fn git(cwd: &str, args: &[&str]) -> GitResult<()> {
  let args: Vec<String> = args.iter().map(|arg| (*arg).to_string()).collect();
  run_git(&args, &RunOptions::new(cwd)).map(|_| ())
}

/// `materializeResolutionCandidate(conflict, candidate, cwd)`: the retained
/// result written and staged, or the path removed for a deletion.
pub(crate) fn materialize_resolution_candidate(
  conflict: Option<&Value>,
  candidate: Option<&Value>,
  cwd: &str,
) -> GitResult<()> {
  let file = match get(conflict, "path") {
    Some(Value::String(units)) => lossy(units),
    other => {
      return Err(GitError::node(
        format!(
          "The \"paths[1]\" argument must be of type string. {}",
          crate::envelope::received(other)
        ),
        "ERR_INVALID_ARG_TYPE",
      ));
    }
  };
  let absolute = text::resolve(cwd, &file);
  let blob = member(candidate, "resultBlob")?;
  if !truthy(blob) {
    return git(cwd, &["rm", "--ignore-unmatch", "--", &file]);
  }
  let mode = get(candidate, "resultMode");
  let executable = match mode {
    Some(Value::String(units)) if lossy(units) == "100644" => false,
    Some(Value::String(units)) if lossy(units) == "100755" => true,
    _ => {
      return Err(GitError::new(
        "unsupported-feature",
        format!(
          "Resolution mode '{}' is not supported by this prototype.",
          js_text(mode)
        ),
      ));
    }
  };
  if let Some(parent) = std::path::Path::new(&absolute).parent() {
    std::fs::create_dir_all(parent)
      .map_err(|error| crate::envelope::io_failure(&error, "mkdir", &parent.to_string_lossy()))?;
  }
  let contents = engine::read_git_blob(&js_text(blob), cwd)?;
  std::fs::write(&absolute, contents)
    .map_err(|error| crate::envelope::io_failure(&error, "open", &absolute))?;
  git(cwd, &["add", "--", &file])?;
  if executable {
    git(cwd, &["update-index", "--chmod=+x", "--", &file])?;
  }
  Ok(())
}

/// Records a decision on the conflict a slot names, as assigning to that
/// object's members does in JavaScript.
fn record_on(operation: &mut Value, slot: &Slot, change: impl FnOnce(&mut Object)) {
  let Value::Object(root) = operation else {
    return;
  };
  let Some(Value::Object(mut current)) = root.get("current").cloned() else {
    return;
  };
  let Some(mut conflicts) = current.get("conflicts").cloned() else {
    return;
  };
  match (slot, &mut conflicts) {
    (Slot::Index(index), Value::Array(items)) => match items.get_mut(*index) {
      Some(Value::Object(conflict)) => change(conflict),
      _ => return,
    },
    (Slot::Member, Value::Object(object)) => match object.get("0").cloned() {
      Some(Value::Object(mut conflict)) => {
        change(&mut conflict);
        object.set("0", Value::Object(conflict));
      }
      _ => return,
    },
    _ => return,
  }
  current.set("conflicts", conflicts);
  root.set("current", Value::Object(current));
}

/// `obj.name = value`, where an `undefined` value is one `JSON.stringify`
/// leaves out.
fn assign(object: &mut Object, name: &str, value: Option<&Value>) {
  match value {
    Some(value) => object.set(name, value.clone()),
    None => object.remove(name),
  }
}

/// `{ operationId: operation.id, <action>: items }`.
fn action_result(operation: &Value, action: &str, items: Vec<Value>) -> Value {
  let mut result = Object::new();
  if let Some(id) = get(Some(operation), "id") {
    result.set("operationId", id.clone());
  }
  result.set(action, Value::Array(items));
  Value::Object(result)
}

/// `applyResolution({ path, all, resolutionId })`.
pub fn apply_resolution(
  file: Option<&str>,
  all: bool,
  resolution_id: Option<&str>,
  cwd: &str,
) -> GitResult<Value> {
  let mut operation = current_resolution_operation(cwd)?;
  let Selected::Slots(slots) = select_conflicts(&operation, file, all)? else {
    return Err(GitError::uncoded("selected.map is not a function"));
  };
  let conflicts = get(get(Some(&operation), "current"), "conflicts").cloned();
  let mut choices = Vec::new();
  for slot in slots {
    let conflict = slot_value(conflicts.as_ref(), &slot).cloned();
    let candidate = choose_candidate(conflict.as_ref(), resolution_id)?;
    choices.push((slot, conflict, candidate));
  }
  let mut applied = Vec::new();
  for (slot, conflict, candidate) in choices {
    materialize_resolution_candidate(conflict.as_ref(), candidate.as_ref(), cwd)?;
    let id = get(candidate.as_ref(), "id").cloned();
    record_on(&mut operation, &slot, |conflict| {
      assign(conflict, "selectedResolutionId", id.as_ref());
      conflict.set("decisionOverride", Value::Null);
      conflict.set("selectionMethod", string("explicit"));
      conflict.set("suggestionAppliedAt", string(&causet_engine::metrics::iso_now()));
    });
    let mut item = Object::new();
    if let Some(path) = get(conflict.as_ref(), "path") {
      item.set("path", path.clone());
    }
    if let Some(candidate) = candidate {
      item.set("resolution", candidate);
    }
    applied.push(Value::Object(item));
  }
  crate::spec::write_pending_operation(&operation, cwd)?;
  Ok(action_result(&operation, "applied", applied))
}

/// `rejectResolution({ path, all, resolutionId })`.
pub fn reject_resolution(
  file: Option<&str>,
  all: bool,
  resolution_id: Option<&str>,
  cwd: &str,
) -> GitResult<Value> {
  let mut operation = current_resolution_operation(cwd)?;
  let Selected::Slots(slots) = select_conflicts(&operation, file, all)? else {
    return Err(GitError::uncoded("selected.map is not a function"));
  };
  let conflicts = get(get(Some(&operation), "current"), "conflicts").cloned();
  let mut choices = Vec::new();
  for slot in slots {
    let conflict = slot_value(conflicts.as_ref(), &slot).cloned();
    let candidate = match resolution_id {
      Some(id) => choose_candidate(conflict.as_ref(), Some(id))?,
      None => None,
    };
    choices.push((slot, conflict, candidate));
  }
  // Every decision is checked before the journal is written, as a refusal part
  // way through the JavaScript loop leaves its in-memory edits unwritten.
  let mut decisions = Vec::new();
  for (slot, conflict, candidate) in choices {
    let candidates = member(conflict.as_ref(), "candidates")?;
    let count = member(candidates, "length").map(|_| length(candidates))?;
    if strict_equals(count.as_ref(), Some(&Value::Number(0.0))) {
      return Err(GitError::new(
        "no-match",
        format!(
          "No prior resolution matches '{}'.",
          js_text(get(conflict.as_ref(), "path"))
        ),
      ));
    }
    let id = match get(candidate.as_ref(), "id") {
      value if nullish(value) => Value::Null,
      value => value.cloned().unwrap_or(Value::Null),
    };
    let mut item = Object::new();
    if let Some(path) = get(conflict.as_ref(), "path") {
      item.set("path", path.clone());
    }
    if let Some(count) = count {
      item.set("candidates", count);
    }
    decisions.push((slot, id, Value::Object(item)));
  }
  let mut rejected = Vec::new();
  for (slot, id, item) in decisions {
    record_on(&mut operation, &slot, |conflict| {
      conflict.set("decisionOverride", string("rejected"));
      conflict.set("selectedResolutionId", id);
      conflict.set("selectionMethod", string("explicit"));
    });
    rejected.push(item);
  }
  crate::spec::write_pending_operation(&operation, cwd)?;
  Ok(action_result(&operation, "rejected", rejected))
}

/// `formatResolutionAction(result, action)`.
pub fn format_resolution_action(result: &Value, action: &str) -> String {
  let items = match get(Some(result), action) {
    Some(Value::Array(items)) => items.clone(),
    _ => Vec::new(),
  };
  let mut lines = vec![format!(
    "{} {} resolution suggestion{}.",
    if action == "applied" { "Applied" } else { "Rejected" },
    items.len(),
    if items.len() == 1 { "" } else { "s" }
  )];
  for item in &items {
    lines.push(format!("  {}", js_text(get(Some(item), "path"))));
  }
  lines.push(if action == "applied" {
    "Continue with: cst reconcile --continue".into()
  } else {
    "Resolve the files manually, stage them, then continue reconciliation.".into()
  });
  lines.join("\n")
}

/// `{ mode, blob }` of an index entry, or `null` without one.
fn compact_stage(entry: Option<&causet_engine::types::IndexEntry>) -> Value {
  let Some(entry) = entry else {
    return Value::Null;
  };
  let mut compact = Object::new();
  if let Some(mode) = &entry.mode {
    compact.set("mode", string(mode));
  }
  if let Some(blob) = &entry.blob {
    compact.set("blob", string(blob));
  }
  Value::Object(compact)
}

/// `conflictStages(filePath, cwd)`: the base, ours and theirs index stages.
fn conflict_stages(file: &str, cwd: &str) -> GitResult<Object> {
  let entries = engine::index_entries(
    cwd,
    &causet_engine::types::IndexOptions {
      unmerged_only: true,
      paths: vec![file.to_string()],
    },
  )?;
  // `new Map(entries.map(...))`: the last entry of a stage wins.
  let stage = |number: f64| entries.iter().rev().find(|entry| entry.stage == number);
  let mut stages = Object::new();
  stages.set("base", compact_stage(stage(1.0)));
  stages.set("ours", compact_stage(stage(2.0)));
  stages.set("theirs", compact_stage(stage(3.0)));
  Ok(stages)
}

/// `compactResolution(record)`: a catalog record as a conflict candidate.
fn compact_resolution(record: &Value) -> Value {
  let member = |name: &str| get(Some(record), name);
  let or_null = |name: &str| match member(name) {
    value if nullish(value) => Value::Null,
    value => value.cloned().unwrap_or(Value::Null),
  };
  let mut compact = Object::new();
  if let Some(id) = member("id") {
    compact.set("id", id.clone());
  }
  if let Some(signature) = member("signature") {
    compact.set("signature", signature.clone());
  }
  compact.set("resultBlob", or_null("resultBlob"));
  compact.set("resultMode", or_null("resultMode"));
  if let Some(reference) = member("ref") {
    compact.set("ref", reference.clone());
  }
  compact.set("originalPath", or_null("originalPath"));
  compact.set("createdAt", or_null("createdAt"));
  Value::Object(compact)
}

/// `captureConflictDescriptors(paths, cwd)`: each conflicted path with its
/// stages, signature and the retained resolutions that match it exactly.
pub(crate) fn capture_conflict_descriptors(paths: &[String], cwd: &str) -> GitResult<Vec<Value>> {
  if paths.is_empty() {
    return Ok(Vec::new());
  }
  // The catalog is scanned once per capture, not once per path.
  let catalog = list_resolution_records(cwd)?;
  let mut descriptors = Vec::new();
  for file in paths {
    let stages = conflict_stages(file, cwd)?;
    let stages_value = Value::Object(stages.clone());
    // The stages are always an object here, which the signature never refuses.
    let signature = resolution_signature(Some(&stages_value))
      .map_err(|_| GitError::uncoded("The conflict stages could not be signed."))?;
    let wanted = string(&signature);
    let candidates: Vec<Value> = catalog
      .iter()
      .filter(|record| strict_equals(get(Some(record), "signature"), Some(&wanted)))
      .map(compact_resolution)
      .collect();
    let mut descriptor = Object::new();
    descriptor.set("path", string(file));
    descriptor.set("signature", wanted);
    descriptor.set(
      "algorithm",
      string(causet_model::registry::RESOLUTION_SIGNATURE_ALGORITHM),
    );
    for name in ["base", "ours", "theirs"] {
      descriptor.set(name, stages.get(name).cloned().unwrap_or(Value::Null));
    }
    descriptor.set("candidates", Value::Array(candidates));
    descriptor.set("selectedResolutionId", Value::Null);
    descriptor.set("decisionOverride", Value::Null);
    descriptors.push(Value::Object(descriptor));
  }
  Ok(descriptors)
}

/// `stagedResult(filePath, cwd)`: the stage-0 mode and blob, or nulls.
fn staged_result(file: &str, cwd: &str) -> GitResult<(Value, Value)> {
  let entries = engine::index_entries(
    cwd,
    &causet_engine::types::IndexOptions {
      unmerged_only: false,
      paths: vec![file.to_string()],
    },
  )?;
  let text_or_null = |value: &Option<String>| value.as_deref().map_or(Value::Null, string);
  Ok(match entries.iter().find(|entry| entry.stage == 0.0) {
    Some(entry) => (text_or_null(&entry.mode), text_or_null(&entry.blob)),
    None => (Value::Null, Value::Null),
  })
}

/// `captureResolutionOutcomes(conflicts, cwd)`: what each conflict resolved
/// to, and how that relates to its candidates.
pub(crate) fn capture_resolution_outcomes(conflicts: &[Value], cwd: &str) -> GitResult<Vec<Value>> {
  let mut outcomes = Vec::new();
  for conflict in conflicts {
    let member = |name: &str| get(Some(conflict), name);
    let path = js_text(member("path"));
    let (result_mode, result_blob) = staged_result(&path, cwd)?;
    let candidates = match member("candidates") {
      Some(Value::Array(items)) => items.clone(),
      _ => Vec::new(),
    };
    let matching = candidates
      .iter()
      .find(|candidate| strict_equals(get(Some(candidate), "resultBlob"), Some(&result_blob)));
    let selected = candidates.iter().find(|candidate| {
      strict_equals(get(Some(candidate), "id"), member("selectedResolutionId"))
    });
    let mut decision = "created";
    if !candidates.is_empty() {
      decision = if as_text(member("decisionOverride")).as_deref() == Some("rejected") {
        "rejected"
      } else if let Some(selected) = selected {
        if strict_equals(get(Some(selected), "resultBlob"), Some(&result_blob)) {
          "accepted"
        } else {
          "modified"
        }
      } else if matching.is_some() {
        "accepted"
      } else {
        "rejected"
      };
    }
    let id_of = |candidate: Option<&Value>| match get(candidate, "id") {
      value if nullish(value) => Value::Null,
      value => value.cloned().unwrap_or(Value::Null),
    };
    let mut outcome = Object::new();
    for name in ["path", "signature", "algorithm", "base", "ours", "theirs"] {
      if let Some(value) = member(name) {
        outcome.set(name, value.clone());
      }
    }
    outcome.set("resultMode", result_mode);
    outcome.set("resultBlob", result_blob);
    outcome.set("decision", string(decision));
    outcome.set(
      "selectionMethod",
      match member("selectionMethod") {
        value if nullish(value) => Value::Null,
        value => value.cloned().unwrap_or(Value::Null),
      },
    );
    outcome.set("selectedResolutionId", id_of(selected));
    outcome.set("reusedResolutionId", id_of(matching));
    outcomes.push(Value::Object(outcome));
  }
  Ok(outcomes)
}
