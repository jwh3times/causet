//! `cst resolve list` and `cst resolve status`: the retained resolution
//! catalog of `src/resolutions.js` (`listResolutionRecords`) and the pending
//! operation's conflicts (`pendingResolutionStatus`), with their renderings in
//! `src/cli.js`.

use crate::metadata::{duplicated_record_ids, object_lookup};
use crate::notes::read_notes;
use crate::records::{not_callable, short};
use crate::store::read_json;
use causet_engine::errors::{GitError, GitResult};
use causet_engine::locations::{local_ref, ref_family, runtime_directory};
use causet_engine::session::with_object_session;
use causet_engine::{engine, text};
use causet_model::js::{get, length, locale_compare, nullish, text as js_text, truthy};
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
fn read_journal(cwd: &str, file: &str, family: &str, kind: &str) -> GitResult<Option<Value>> {
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
