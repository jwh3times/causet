//! Writing causal notes: the notes lock and `appendNote` of `src/notes.js`,
//! and the note and retention carriers of `src/git-carriers.js`.

use crate::envelope::io_failure;
use crate::host;
use causet_engine::errors::{GitError, GitResult};
use causet_engine::locations::{names, ref_family};
use causet_engine::process::{RunOptions, run_git};
use causet_engine::{engine, text};
use causet_model::js::get;
use causet_model::json::{Object, Value, lossy, parse, string, stringify, stringify_pretty};
use causet_model::registry::RESOURCE_BOUNDS;
use causet_model::schemas::{canonical_schema, referenced_objects, validate_note_record, within_bound};
use std::cell::RefCell;
use std::collections::BTreeSet;

const NOTE_SCHEMA: &str = "causet.note/v1";
const NOTES_LOCK_NAME: &str = "notes.lock";
const NOTES_LOCK_WAIT_MS: f64 = 5_000.0;
const NOTES_LOCK_STALE_MS: f64 = 60_000.0;
const NOTES_LOCK_POLL_MS: u64 = 15;

thread_local! {
  /// `heldNotesLocks`: the lock is reentrant within one process.
  static HELD: RefCell<BTreeSet<String>> = const { RefCell::new(BTreeSet::new()) };
}

fn bound(name: &str) -> u64 {
  RESOURCE_BOUNDS
    .iter()
    .find(|(bound, _)| *bound == name)
    .map_or(0, |(_, limit)| *limit)
}

/// Besides `EEXIST`, Windows reports these while another process still has the
/// lock file open as it is removed or renamed.
fn transient(error: &std::io::Error) -> bool {
  matches!(
    error.kind(),
    std::io::ErrorKind::AlreadyExists
      | std::io::ErrorKind::PermissionDenied
      | std::io::ErrorKind::ResourceBusy
  )
}

struct LockState {
  present: bool,
  holder: Option<Value>,
  age_ms: f64,
  stale: bool,
}

fn holder_of(path: &str) -> Option<Value> {
  let raw = std::fs::read(path).ok()?;
  parse(&String::from_utf8_lossy(&raw)).ok()
}

fn integer_pid(holder: Option<&Value>) -> Option<i64> {
  match get(holder, "pid") {
    Some(Value::Number(number)) if number.fract() == 0.0 && number.is_finite() => Some(*number as i64),
    _ => None,
  }
}

/// `inspectNotesLock(lockPath)`.
fn inspect_notes_lock(lock_path: &str) -> GitResult<LockState> {
  let metadata = match std::fs::metadata(lock_path) {
    Ok(metadata) => metadata,
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
      return Ok(LockState { present: false, holder: None, age_ms: 0.0, stale: false });
    }
    Err(error) => return Err(io_failure(&error, "stat", lock_path)),
  };
  let holder = holder_of(lock_path);
  let modified = metadata
    .modified()
    .ok()
    .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
    .map_or(0.0, |elapsed| elapsed.as_secs_f64() * 1000.0);
  let age_ms = (host::now_ms() - modified).max(0.0);
  let pid = integer_pid(holder.as_ref());
  let local = matches!(get(holder.as_ref(), "hostname"), Some(Value::String(name)) if lossy(name) == host::hostname())
    && pid.is_some();
  let own = local && pid == Some(i64::from(std::process::id()));
  let stale = own
    || if local {
      !host::process_is_running(pid.expect("local holder"))
    } else {
      age_ms >= NOTES_LOCK_STALE_MS
    };
  Ok(LockState { present: true, holder, age_ms, stale })
}

/// `abandonNotesLock(lockPath)`.
fn abandon_notes_lock(lock_path: &str) -> GitResult<()> {
  let abandoned = format!(
    "{lock_path}.abandoned-{}-{}",
    std::process::id(),
    host::now_ms() as u64
  );
  if let Err(error) = std::fs::rename(lock_path, &abandoned) {
    if error.kind() == std::io::ErrorKind::NotFound || transient(&error) {
      return Ok(());
    }
    return Err(io_failure(&error, "rename", lock_path));
  }
  let _ = std::fs::remove_file(&abandoned);
  Ok(())
}

/// `acquireNotesLock(lockPath)`.
fn acquire_notes_lock(lock_path: &str) -> GitResult<()> {
  let mut claim = Object::new();
  claim.set("pid", Value::Number(f64::from(std::process::id())));
  claim.set("hostname", string(&host::hostname()));
  claim.set("createdAt", string(&causet_engine::metrics::iso_now()));
  let claim = format!("{}\n", stringify(&Value::Object(claim)));
  let deadline = host::now_ms() + NOTES_LOCK_WAIT_MS;
  let mut last_error: Option<std::io::Error>;
  loop {
    let created = std::fs::OpenOptions::new()
      .write(true)
      .create_new(true)
      .open(lock_path);
    match created {
      Ok(mut file) => {
        use std::io::Write as _;
        file
          .write_all(claim.as_bytes())
          .map_err(|error| io_failure(&error, "write", lock_path))?;
        return Ok(());
      }
      Err(error) if transient(&error) => last_error = Some(error),
      Err(error) => return Err(io_failure(&error, "open", lock_path)),
    }
    let lock = inspect_notes_lock(lock_path)?;
    if lock.present && lock.stale {
      abandon_notes_lock(lock_path)?;
      continue;
    }
    if host::now_ms() >= deadline {
      if !lock.present {
        let error = last_error.expect("a failed claim");
        return Err(io_failure(&error, "open", lock_path));
      }
      // `lock.holder?.pid ? \`process ${pid} on ${hostname}\` : "another process"`.
      let holder = if causet_model::js::truthy(get(lock.holder.as_ref(), "pid")) {
        format!(
          "process {} on {}",
          causet_model::js::text(get(lock.holder.as_ref(), "pid")),
          causet_model::js::text(get(lock.holder.as_ref(), "hostname"))
        )
      } else {
        "another process".to_string()
      };
      return Err(
        GitError::new(
          "notes-locked",
          format!(
            "The causal notes are locked by {holder}; the lock is {} s old.",
            (lock.age_ms / 1000.0).round()
          ),
        )
        .details(format!(
          "Wait for that publication to finish and retry. If the process is gone, remove {lock_path}."
        )),
      );
    }
    std::thread::sleep(std::time::Duration::from_millis(NOTES_LOCK_POLL_MS));
  }
}

/// `releaseNotesLock(lockPath)`: remove only this process's claim.
fn release_notes_lock(lock_path: &str) {
  let Some(holder) = holder_of(lock_path) else {
    return;
  };
  let mine = integer_pid(Some(&holder)) == Some(i64::from(std::process::id()))
    && matches!(get(Some(&holder), "hostname"), Some(Value::String(name)) if lossy(name) == host::hostname());
  if mine {
    let _ = std::fs::remove_file(lock_path);
  }
}

/// `withNotesLock(cwd, action)`.
pub fn with_notes_lock<T>(cwd: &str, action: impl FnOnce() -> GitResult<T>) -> GitResult<T> {
  let runtime = crate::store::ensure_lab_runtime(cwd)?;
  let lock_path = text::join(&runtime, NOTES_LOCK_NAME);
  if HELD.with(|held| held.borrow().contains(&lock_path)) {
    return action();
  }
  acquire_notes_lock(&lock_path)?;
  HELD.with(|held| held.borrow_mut().insert(lock_path.clone()));
  let result = action();
  HELD.with(|held| held.borrow_mut().remove(&lock_path));
  release_notes_lock(&lock_path);
  result
}

// ---------------------------------------------------------------------------
// Note containers
// ---------------------------------------------------------------------------

enum Disposition {
  Empty,
  Oversize,
  Legacy,
  Foreign,
  Accept,
}

fn empty_note() -> Object {
  let mut note = Object::new();
  note.set("schema", string(NOTE_SCHEMA));
  note.set("records", Value::Array(Vec::new()));
  note
}

/// `classifyNoteText(text)`.
fn classify_note_text(text: &str) -> (Object, Disposition) {
  if text.is_empty() {
    return (empty_note(), Disposition::Empty);
  }
  if !within_bound("noteContainerBytes", text.len() as u64) {
    return (empty_note(), Disposition::Oversize);
  }
  let Ok(parsed) = parse(text) else {
    let mut legacy = Object::new();
    legacy.set("type", string("legacy-note"));
    legacy.set("text", string(text));
    let mut note = empty_note();
    note.set("records", Value::Array(vec![Value::Object(legacy)]));
    return (note, Disposition::Legacy);
  };
  let schema = match get(Some(&parsed), "schema") {
    Some(Value::String(units)) => Some(canonical_schema(&lossy(units))),
    _ => None,
  };
  let records = match get(Some(&parsed), "records") {
    Some(Value::Array(records)) => Some(records.len()),
    _ => None,
  };
  let (Some(schema), Some(count), Value::Object(note)) = (schema, records, &parsed) else {
    return (empty_note(), Disposition::Foreign);
  };
  if schema != NOTE_SCHEMA {
    return (empty_note(), Disposition::Foreign);
  }
  if !within_bound("noteContainerRecords", count as u64) {
    return (empty_note(), Disposition::Oversize);
  }
  (note.clone(), Disposition::Accept)
}

// ---------------------------------------------------------------------------
// Carriers (`src/git-carriers.js`)
// ---------------------------------------------------------------------------

struct TreeEntry {
  mode: String,
  kind: &'static str,
  name: Vec<u8>,
  oid: String,
}

fn git(args: &[&str], cwd: &str, input: Option<Vec<u8>>) -> GitResult<String> {
  let mut options = RunOptions::new(cwd);
  options.input = input;
  let args: Vec<String> = args.iter().map(|arg| (*arg).to_string()).collect();
  Ok(run_git(&args, &options)?.stdout)
}

/// `writeTree(entries, cwd)`: `git mktree -z`.
fn write_tree(entries: &[TreeEntry], cwd: &str) -> GitResult<String> {
  let mut input = Vec::new();
  for entry in entries {
    input.extend_from_slice(format!("{} {} {}\t", entry.mode, entry.kind, entry.oid).as_bytes());
    input.extend_from_slice(&entry.name);
    input.push(0);
  }
  git(&["mktree", "-z"], cwd, Some(input))
}

/// `readTree(oid, cwd, oidBytes)`.
fn read_tree(oid: &str, cwd: &str, oid_bytes: usize) -> GitResult<Vec<TreeEntry>> {
  let object = engine::read_git_objects(&[oid.to_string()], cwd)?.records.remove(0);
  if !object.exists || object.kind.as_deref() != Some("tree") {
    return Err(GitError::new("malformed-input", "The notes tree is missing or malformed."));
  }
  let content = object.content.unwrap_or_default();
  let mut entries = Vec::new();
  let mut offset = 0;
  while offset < content.len() {
    let space = content[offset..].iter().position(|byte| *byte == b' ').map(|at| offset + at);
    let nul = space.and_then(|space| {
      content[space + 1..].iter().position(|byte| *byte == 0).map(|at| space + 1 + at)
    });
    let (Some(space), Some(nul)) = (space, nul) else {
      return Err(GitError::new("git-response-malformed", "Git returned a malformed notes tree."));
    };
    if nul + 1 + oid_bytes > content.len() {
      return Err(GitError::new("git-response-malformed", "Git returned a malformed notes tree."));
    }
    let mode = String::from_utf8_lossy(&content[offset..space]).into_owned();
    let kind = match mode.as_str() {
      "40000" => "tree",
      "160000" => "commit",
      _ => "blob",
    };
    entries.push(TreeEntry {
      mode,
      kind,
      name: content[space + 1..nul].to_vec(),
      oid: content[nul + 1..nul + 1 + oid_bytes].iter().map(|byte| format!("{byte:02x}")).collect(),
    });
    offset = nul + 1 + oid_bytes;
  }
  Ok(entries)
}

fn two_hex(name: &[u8]) -> bool {
  name.len() == 2 && name.iter().all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

/// `replaceNote(tree, suffix, blob, cwd, oidBytes)`.
fn replace_note(tree: Option<&str>, suffix: &str, blob: &str, cwd: &str, oid_bytes: usize) -> GitResult<String> {
  let mut entries = match tree {
    Some(tree) => read_tree(tree, cwd, oid_bytes)?,
    None => Vec::new(),
  };
  let exact = entries
    .iter()
    .position(|entry| String::from_utf8_lossy(&entry.name) == suffix);
  if let Some(index) = exact {
    if entries[index].kind != "blob" {
      return Err(GitError::new(
        "malformed-input",
        "A non-note object occupies the notes attachment path; publication refused.",
      ));
    }
  }
  let directory = entries.iter().position(|entry| {
    entry.kind == "tree"
      && two_hex(&entry.name)
      && entry.name.len() < suffix.len()
      && suffix.as_bytes().starts_with(&entry.name)
  });
  if let Some(index) = exact {
    let entry = &mut entries[index];
    entry.oid = blob.to_string();
    entry.kind = "blob";
    entry.mode = "100644".into();
  } else if let Some(index) = directory {
    let name_length = entries[index].name.len();
    let child = entries[index].oid.clone();
    entries[index].oid = replace_note(Some(&child), &suffix[name_length..], blob, cwd, oid_bytes)?;
  } else {
    entries.push(TreeEntry {
      mode: "100644".into(),
      kind: "blob",
      name: suffix.as_bytes().to_vec(),
      oid: blob.to_string(),
    });
  }
  write_tree(&entries, cwd)
}

/// `commitWithParents(tree, parents, cwd, { message })`.
pub fn commit_with_parents(tree: &str, parents: &[String], cwd: &str, message: &str, env: &[(&str, &str)]) -> GitResult<String> {
  let mut layer: Vec<String> = Vec::new();
  for parent in parents {
    if !layer.contains(parent) {
      layer.push(parent.clone());
    }
  }
  text::sort(&mut layer);
  let commit = |group: &[String]| -> GitResult<String> {
    let mut args = vec!["commit-tree".to_string(), tree.to_string()];
    for oid in group {
      args.push("-p".into());
      args.push(oid.clone());
    }
    args.push("-F".into());
    args.push("-".into());
    let mut options = RunOptions::new(cwd);
    options.input = Some(format!("{message}\n").into_bytes());
    options.env = env.iter().map(|(name, value)| ((*name).to_string(), (*value).to_string())).collect();
    Ok(run_git(&args, &options)?.stdout)
  };
  while layer.len() > 64 {
    let mut next = Vec::new();
    for group in layer.chunks(64) {
      next.push(commit(group)?);
    }
    layer = next;
  }
  commit(&layer)
}

/// `buildNoteCommit(note, attachment, previous, cwd)`.
fn build_note_commit(note: &Object, attachment: &str, previous: Option<&str>, cwd: &str) -> GitResult<String> {
  let blob = git(
    &["hash-object", "-w", "--stdin"],
    cwd,
    Some(format!("{}\n", stringify_pretty(&Value::Object(note.clone()))).into_bytes()),
  )?;
  let previous_tree = previous.map(|previous| format!("{previous}^{{tree}}"));
  let tree = replace_note(previous_tree.as_deref(), attachment, &blob, cwd, attachment.len() / 2)?;
  let parents: Vec<String> = previous.map(|previous| vec![previous.to_string()]).unwrap_or_default();
  commit_with_parents(&tree, &parents, cwd, "Publish causet causal note", &[])
}

/// `recordDependencies(entries, cwd)`: every object an accepted fact needs,
/// in first-reference order, validated against the repository.
pub fn record_dependencies(entries: &[(String, Value)], cwd: &str) -> GitResult<Vec<(String, &'static str)>> {
  let mut dependencies: Vec<(String, &'static str)> = Vec::new();
  let format = engine::repo_context(cwd)?.object_format;
  for (attachment, record) in entries {
    let mut attached = match record {
      Value::Object(object) => object.clone(),
      _ => Object::new(),
    };
    attached.set("attachedTo", string(attachment));
    let errors = validate_note_record(Some(&Value::Object(attached)), &format);
    if !errors.is_empty() {
      let details = Value::Array(
        errors
          .iter()
          .map(|error| {
            let mut object = Object::new();
            object.set("field", string(&error.field));
            object.set("expectation", string(&error.expectation));
            Value::Object(object)
          })
          .collect(),
      );
      return Err(
        GitError::new("malformed-input", "Cannot publish an invalid causal record.")
          .details(stringify(&details)),
      );
    }
    let mut references = vec![(attachment.clone(), "commit")];
    references.extend(
      referenced_objects(Some(record))
        .into_iter()
        .map(|reference| (lossy(&reference.oid), reference.kind)),
    );
    for (oid, kind) in references {
      match dependencies.iter_mut().find(|(known, _)| *known == oid) {
        Some((_, known)) if *known != kind => {
          return Err(GitError::new(
            "malformed-input",
            "A causal record assigns incompatible types to one object.",
          ));
        }
        Some(_) => {}
        None => dependencies.push((oid, kind)),
      }
    }
  }
  if !dependencies.is_empty() {
    let expressions: Vec<String> = dependencies.iter().map(|(oid, _)| oid.clone()).collect();
    let objects = engine::inspect_git_objects(&expressions, cwd)?.records;
    for ((oid, kind), object) in dependencies.iter().zip(objects) {
      if !object.exists || object.kind.as_deref() != Some(kind) {
        return Err(GitError::new(
          "integrity-check-failed",
          format!("Required {kind} '{oid}' is missing or has the wrong type."),
        ));
      }
    }
  }
  Ok(dependencies)
}

/// `buildRetentionCommit(dependencies, previous, cwd)`.
pub fn build_retention_commit(
  dependencies: &[(String, &'static str)],
  previous: Option<&str>,
  cwd: &str,
  message: &str,
  env: &[(&str, &str)],
) -> GitResult<String> {
  let mut parents: Vec<String> = previous.map(|previous| vec![previous.to_string()]).unwrap_or_default();
  let mut directories = Vec::new();
  for kind in ["blob", "tree"] {
    let mut oids: Vec<String> = dependencies
      .iter()
      .filter(|(_, known)| *known == kind)
      .map(|(oid, _)| oid.clone())
      .collect();
    text::sort(&mut oids);
    if oids.is_empty() {
      continue;
    }
    let entries: Vec<TreeEntry> = oids
      .into_iter()
      .map(|oid| TreeEntry {
        mode: if kind == "tree" { "40000".into() } else { "100644".into() },
        kind,
        name: oid.as_bytes().to_vec(),
        oid,
      })
      .collect();
    directories.push(TreeEntry {
      mode: "40000".into(),
      kind: "tree",
      oid: write_tree(&entries, cwd)?,
      name: format!("{kind}s").into_bytes(),
    });
  }
  for (oid, kind) in dependencies {
    if *kind == "commit" {
      parents.push(oid.clone());
    }
  }
  let tree = write_tree(&directories, cwd)?;
  commit_with_parents(&tree, &parents, cwd, message, env)
}

/// `checkedRefUpdate(ref, next, previous)`.
pub fn checked_ref_update(name: &str, next: &str, previous: Option<&str>) -> String {
  match previous {
    Some(previous) => format!("update {name} {next} {previous}"),
    None => format!("create {name} {next}"),
  }
}

/// `appendNote(commit, record, cwd)`: the container with the record appended,
/// published together with the objects it keeps reachable.
pub fn append_note(commit: &str, record: &Value, cwd: &str, ref_updates: &[String]) -> GitResult<Object> {
  with_notes_lock(cwd, || {
    let repository = names(cwd)?;
    let retention = ref_family("retention", cwd)?;
    let previous_notes = engine::ref_target(repository.notes_ref, cwd)?;
    let previous_retention = engine::ref_target(&retention, cwd)?;
    let note_text = engine::read_note_text(repository.notes_name, commit, cwd)?.unwrap_or_default();
    let (mut note, disposition) = classify_note_text(&note_text);
    match disposition {
      Disposition::Foreign => {
        return Err(
          GitError::new(
            "wrong-record-family",
            format!("The note on '{commit}' is not a {NOTE_SCHEMA} container."),
          )
          .details(format!(
            "causet will not overwrite a note container it cannot read. Inspect it with: git notes --ref={} show {commit}",
            repository.notes_name
          )),
        );
      }
      Disposition::Oversize => {
        return Err(
          GitError::new(
            "resource-bound-exceeded",
            format!("The note on '{commit}' exceeds a published note-container resource bound."),
          )
          .details(format!(
            "Notes are limited to {} bytes and {} records; see docs/schemas/compatibility.md.",
            bound("noteContainerBytes"),
            bound("noteContainerRecords")
          )),
        );
      }
      Disposition::Empty | Disposition::Legacy | Disposition::Accept => {}
    }
    let mut records = match note.get("records") {
      Some(Value::Array(records)) => records.clone(),
      _ => Vec::new(),
    };
    records.push(record.clone());
    let count = records.len();
    note.set("records", Value::Array(records));
    if !within_bound("noteContainerRecords", count as u64) {
      return Err(GitError::new(
        "resource-bound-exceeded",
        format!(
          "The note on '{commit}' would exceed the noteContainerRecords bound of {}.",
          bound("noteContainerRecords")
        ),
      ));
    }
    let bytes = stringify_pretty(&Value::Object(note.clone())).len() + 1;
    if !within_bound("noteContainerBytes", bytes as u64) {
      return Err(GitError::new(
        "resource-bound-exceeded",
        "The resulting note exceeds the noteContainerBytes bound.",
      ));
    }
    let dependencies = record_dependencies(&[(commit.to_string(), record.clone())], cwd)?;
    host::gate_point("notes:after-read");
    let next_notes = build_note_commit(&note, commit, previous_notes.as_deref(), cwd)?;
    let next_retention = build_retention_commit(
      &dependencies,
      previous_retention.as_deref(),
      cwd,
      "causet object retention",
      &[],
    )?;
    host::fault_point("retention:before-publish");
    let mut lines = vec![
      "start".to_string(),
      checked_ref_update(repository.notes_ref, &next_notes, previous_notes.as_deref()),
      checked_ref_update(&retention, &next_retention, previous_retention.as_deref()),
    ];
    lines.extend(ref_updates.iter().cloned());
    lines.extend(["prepare".to_string(), "commit".to_string(), String::new()]);
    let mut options = RunOptions::new(cwd);
    options.input = Some(lines.join("\n").into_bytes());
    run_git(&["update-ref".to_string(), "--stdin".to_string()], &options)?;
    host::fault_point("retention:after-publish");
    Ok(note)
  })
}
