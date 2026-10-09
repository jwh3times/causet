//! `cst metadata dispose <record-id> --keep-local|--replace-local`:
//! `disposeConflict` of `src/dispositions.js`, with the parked-record reader
//! and the disposition registry of `src/quarantine.js` (ADR-0030).

use crate::metadata::{full_snapshot, parsed_parked_ref, read_dispositions};
use crate::notes_write::replace_note_record;
use crate::store::ensure_lab_runtime;
use causet_engine::errors::{GitError, GitResult};
use causet_engine::locations::ref_family;
use causet_engine::process::{RunOptions, run_git};
use causet_engine::{engine, metrics, text};
use causet_model::js::{get, locale_compare, nullish, text as js_text, truthy};
use causet_model::json::{Object, Value, lossy, parse, string, stringify_pretty};
use causet_model::schemas::{assert_readable_schema, canonical_schema, within_bound};

const PARKED_RECORD_SCHEMA: &str = "causet.quarantined-record/v1";
const DISPOSITION_SCHEMA: &str = "causet.disposition/v1";

struct Parked {
  name: String,
  oid: String,
  source_lineage: String,
  record_id: String,
  reason: Option<&'static str>,
  payload: Value,
}

/// `listParkedRecords(cwd)`: every parked record, readable or not.
fn list_parked_records(root: &str) -> GitResult<Vec<Parked>> {
  let namespace = ref_family("quarantine", root)?;
  let mut refs: Vec<_> = engine::list_refs(&format!("{namespace}/"), root)?
    .into_iter()
    .filter(|entry| parsed_parked_ref(&entry.name).is_some())
    .collect();
  refs.sort_by(|left, right| locale_compare(&left.name, &right.name));
  if refs.is_empty() {
    return Ok(Vec::new());
  }
  let oids: Vec<String> = refs.iter().map(|entry| entry.oid.clone()).collect();
  let objects = engine::read_git_objects(&oids, root)?.records;
  let mut parked = Vec::new();
  for (entry, object) in refs.into_iter().zip(objects) {
    let (source_lineage, record_id) = parsed_parked_ref(&entry.name).expect("filtered");
    let mut reason = None;
    let mut payload = Value::Null;
    if !object.exists || object.kind.as_deref() != Some("blob") {
      reason = Some("missing-parked-blob");
    } else {
      let content = object.content.unwrap_or_default();
      if !within_bound("noteContainerBytes", content.len() as u64) {
        reason = Some("oversize-record");
      } else {
        match parse(&String::from_utf8_lossy(&content)) {
          Err(_) => reason = Some("malformed-record"),
          Ok(parsed) => {
            let schema = match get(Some(&parsed), "schema") {
              Some(Value::String(units)) => Some(canonical_schema(&lossy(units))),
              _ => None,
            };
            if schema.as_deref() == Some(PARKED_RECORD_SCHEMA) {
              payload = parsed;
            } else {
              reason = Some("unknown-schema-version");
            }
          }
        }
      }
    }
    parked.push(Parked { name: entry.name, oid: entry.oid, source_lineage, record_id, reason, payload });
  }
  Ok(parked)
}

/// `readParkedRecord(recordId, cwd)`: the one parked copy of `record_id`,
/// refused when it is ambiguous or unreadable.
fn read_parked_record(record_id: &str, root: &str) -> GitResult<Parked> {
  let mut matches: Vec<Parked> = list_parked_records(root)?
    .into_iter()
    .filter(|entry| entry.record_id == record_id)
    .collect();
  if matches.is_empty() {
    return Err(
      GitError::new("not-found", format!("No parked record '{record_id}' is in quarantine."))
        .details("List what is parked with: cst metadata status --json"),
    );
  }
  if matches.len() > 1 {
    return Err(
      GitError::new(
        "ambiguous-match",
        format!(
          "Record '{record_id}' is disputed by {} parked copies; name the source lineage.",
          matches.len()
        ),
      )
      .details(matches.iter().map(|entry| entry.name.clone()).collect::<Vec<_>>().join("\n")),
    );
  }
  let entry = matches.remove(0);
  match entry.reason {
    Some("unknown-schema-version") => {
      return Err(
        GitError::new(
          "unknown-schema-version",
          format!("The parked record at '{}' carries a schema this build does not read.", entry.name),
        )
        .details(format!("Inspect it with: git cat-file -p {}", entry.name)),
      );
    }
    Some(reason) => {
      return Err(
        GitError::new(
          "malformed-input",
          format!("The parked record at '{}' is not readable: {reason}.", entry.name),
        )
        .details(format!("Inspect it with: git cat-file -p {}", entry.name)),
      );
    }
    None => {}
  }
  let schema = match get(Some(&entry.payload), "schema") {
    Some(Value::String(units)) => Some(lossy(units)),
    _ => None,
  };
  assert_readable_schema(
    schema.as_deref(),
    &format!("The parked record at '{}'", entry.name),
    Some("causet.quarantined-record"),
    "Read it with the causet build that parked it.",
  )
  .map_err(|refusal| GitError::new(refusal.code, refusal.message).details(refusal.details))?;
  Ok(entry)
}

/// The local snapshot's summary records.
fn summaries(root: &str) -> GitResult<Vec<Value>> {
  let context = engine::repo_context(root)?;
  let snapshot = full_snapshot(&context)?;
  Ok(match get(get(get(Some(&snapshot.scopes), "sharedPortable"), "notes"), "records") {
    Some(Value::Array(items)) => items.clone(),
    _ => Vec::new(),
  })
}

fn is_id(summary: &Value, record_id: &str) -> bool {
  matches!(get(Some(summary), "id"), Some(Value::String(units)) if lossy(units) == record_id)
}

/// `appendDisposition(entry, cwd)`: the registry rewritten with the entry
/// appended, through a temporary file and a rename.
fn append_disposition(entry: &Value, root: &str) -> GitResult<()> {
  let context = engine::repo_context(root)?;
  let registry = read_dispositions(&context)?;
  let mut updated = match registry {
    Value::Object(object) => object,
    _ => Object::new(),
  };
  let mut dispositions = match updated.get("dispositions") {
    Some(Value::Array(items)) => items.clone(),
    _ => Vec::new(),
  };
  dispositions.push(entry.clone());
  updated.set("dispositions", Value::Array(dispositions));
  let runtime = ensure_lab_runtime(root)?;
  let path = text::join(&runtime, "dispositions.json");
  let temporary = format!("{path}.tmp-{}", std::process::id());
  std::fs::write(&temporary, format!("{}\n", stringify_pretty(&Value::Object(updated))))
    .map_err(|error| crate::envelope::io_failure(&error, "open", &temporary))?;
  std::fs::rename(&temporary, &path)
    .map_err(|error| crate::envelope::io_failure(&error, "rename", &temporary))?;
  Ok(())
}

/// `disposeConflict(recordId, { outcome, reason })`.
pub fn dispose_conflict(record_id: &str, keep_local: bool, reason: Option<&str>, cwd: &str) -> GitResult<Value> {
  let outcome = if keep_local { "keep-local" } else { "replace-local" };
  let context = engine::repo_context(cwd)?;
  let root = context.root.clone();
  let parked = read_parked_record(record_id, &root)?;
  let local: Vec<(String, String)> = summaries(&root)?
    .iter()
    .filter(|summary| is_id(summary, record_id))
    .map(|summary| (js_text(get(Some(summary), "attachment")), js_text(get(Some(summary), "digest"))))
    .collect();
  if local.is_empty() {
    return Err(
      GitError::new(
        "not-found",
        format!("No local record '{record_id}' disputes the parked copy at '{}'.", parked.name),
      )
      .details(format!(
        "Nothing local claims this identifier any more, so there is no conflict to dispose of. Remove the parked copy with: git update-ref -d {}",
        parked.name
      )),
    );
  }
  if local.len() > 1 {
    return Err(
      GitError::new(
        "identity-conflict",
        format!(
          "Record '{record_id}' names {} different local facts; resolve that duplication first.",
          local.len()
        ),
      )
      .details(
        "A disposition replaces or keeps one local record. Repair the duplicated identifier in the notes tree, then dispose of the parked copy.",
      ),
    );
  }
  let (attachment, digest) = local[0].clone();
  let parked_attachment = get(Some(&parked.payload), "attachment");
  if !keep_local && !matches!(parked_attachment, Some(Value::String(units)) if lossy(units) == attachment) {
    return Err(
      GitError::new(
        "identity-conflict",
        format!(
          "The parked copy of '{record_id}' is attached to {}, but the local copy is attached to {attachment}.",
          js_text(parked_attachment)
        ),
      )
      .details(format!(
        "Replacing the local record would move a fact to another commit. Inspect both with: git cat-file -p {}",
        parked.name
      )),
    );
  }
  let parked_digest = get(Some(&parked.payload), "digest").cloned().unwrap_or(Value::Null);
  let mut entry = Object::new();
  entry.set("schema", string(DISPOSITION_SCHEMA));
  entry.set("id", string(&crate::host::new_id("disposition")));
  entry.set("recordId", string(record_id));
  entry.set("outcome", string(outcome));
  entry.set("sourceLineage", string(&parked.source_lineage));
  entry.set("parkedRef", string(&parked.name));
  entry.set("attachment", string(&attachment));
  entry.set("keptDigest", if keep_local { string(&digest) } else { parked_digest.clone() });
  entry.set(
    "rejectedDigests",
    Value::Array(vec![if keep_local { parked_digest.clone() } else { string(&digest) }]),
  );
  entry.set("reason", reason.map_or(Value::Null, string));
  entry.set("decidedAt", string(&metrics::iso_now()));
  let entry = Value::Object(entry);

  // The dispute is cleared before the decision is filed; `replace-local` clears
  // it inside the note rewrite's own transaction.
  if keep_local {
    let args: Vec<String> = ["update-ref", "-d", &parked.name, &parked.oid].map(String::from).to_vec();
    run_git(&args, &RunOptions::new(&root))?;
  } else {
    let replacement = get(Some(&parked.payload), "record").cloned().unwrap_or(Value::Null);
    replace_note_record(
      &attachment,
      record_id,
      &replacement,
      &root,
      &[format!("delete {} {}", parked.name, parked.oid)],
    )?;
  }
  append_disposition(&entry, &root)?;

  // Read the record back rather than asserting it returned to service.
  let after = summaries(&root)?.into_iter().find(|summary| is_id(summary, record_id));
  let parked_record = get(Some(&parked.payload), "record");
  let pick = |name: &str| -> Value {
    match after.as_ref().and_then(|after| get(Some(after), name)) {
      Some(value) if !nullish(Some(value)) => value.clone(),
      _ => match get(parked_record, name) {
        Some(value) if !nullish(Some(value)) => value.clone(),
        _ => Value::Null,
      },
    }
  };
  let mut record = Object::new();
  record.set("id", string(record_id));
  record.set("schema", pick("schema"));
  record.set("type", pick("type"));
  record.set(
    "attachment",
    match after.as_ref().and_then(|after| get(Some(after), "attachment")) {
      Some(value) if !nullish(Some(value)) => value.clone(),
      _ => string(&attachment),
    },
  );
  record.set("inService", Value::Bool(truthy(after.as_ref().and_then(|after| get(Some(after), "valid")))));
  record.set(
    "diagnostics",
    match after.as_ref().and_then(|after| get(Some(after), "diagnostics")) {
      Some(value) if !nullish(Some(value)) => value.clone(),
      _ => Value::Array(Vec::new()),
    },
  );
  let mut result = Object::new();
  result.set("schema", string("causet.metadata-disposition/v1"));
  result.set("disposition", entry);
  result.set("parkedRef", string(&parked.name));
  result.set("parkedRemoved", Value::Bool(!engine::ref_exists(&parked.name, &root)?));
  result.set("record", Value::Object(record));
  Ok(Value::Object(result))
}

/// `formatDisposition(result)`.
pub fn format_disposition(result: &Value) -> String {
  let entry = get(Some(result), "disposition");
  let record = get(Some(result), "record");
  let field = |value: Option<&Value>, name: &str| js_text(get(value, name));
  let schema = match get(record, "schema") {
    None | Some(Value::Null) => "unknown schema".to_string(),
    value => js_text(value),
  };
  let rejected = match get(entry, "rejectedDigests") {
    Some(Value::Array(items)) => lossy(&causet_model::js::join(items, &causet_model::json::js(", "))),
    _ => String::new(),
  };
  let reason = match get(entry, "reason") {
    None | Some(Value::Null) => "(none given)".to_string(),
    value => js_text(value),
  };
  let diagnostics = match get(record, "diagnostics") {
    Some(Value::Array(items)) => lossy(&causet_model::js::join(items, &causet_model::json::js(", "))),
    _ => String::new(),
  };
  [
    format!("Conflict disposed: {}", field(entry, "outcome")),
    format!("record       {} ({schema})", field(entry, "recordId")),
    format!("attachment   {}", field(entry, "attachment")),
    format!("kept         {}", field(entry, "keptDigest")),
    format!("rejected     {rejected}"),
    format!(
      "parked ref   {} ({})",
      js_text(get(Some(result), "parkedRef")),
      if truthy(get(Some(result), "parkedRemoved")) { "removed" } else { "still present" }
    ),
    format!("reason       {reason}"),
    if truthy(get(record, "inService")) {
      "The record is in service again; the decision is local and is never exported.".to_string()
    } else {
      format!(
        "The dispute is resolved, but the record is still quarantined: {}.",
        if diagnostics.is_empty() { "see cst metadata status".to_string() } else { diagnostics }
      )
    },
  ]
  .join("\n")
}
