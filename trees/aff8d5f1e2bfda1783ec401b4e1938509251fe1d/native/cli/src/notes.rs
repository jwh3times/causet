//! Reading causal notes, as `src/notes.js` reads them: one note parser shared
//! by every reader, and the batched catalog reads (`readNotes`,
//! `listNoteRecords`). Notes are shared-portable and untrusted, so every
//! disposition here is non-fatal (ADR-0020).

use causet_engine::engine;
use causet_engine::errors::GitResult;
use causet_engine::locations::names;
use causet_engine::text;
use causet_engine::types::NoteEntry;
use causet_model::js::{get, locale_compare, nullish, text as js_text};
use causet_model::json::{Object, Value, lossy, parse, string};
use causet_model::schemas::{canonical_schema, within_bound};
use std::collections::HashMap;

pub const NOTE_SCHEMA: &str = "causet.note/v1";

/// `classifyNoteText(text)`'s records: an empty container, the records of an
/// accepted one, or one opaque `legacy-note` record for text that is not JSON.
pub fn note_records(text: &str) -> Vec<Value> {
  if text.is_empty() || !within_bound("noteContainerBytes", text.len() as u64) {
    return Vec::new();
  }
  let Ok(parsed) = parse(text) else {
    let mut legacy = Object::new();
    legacy.set("type", string("legacy-note"));
    legacy.set("text", string(text));
    return vec![Value::Object(legacy)];
  };
  let schema = match get(Some(&parsed), "schema") {
    Some(Value::String(units)) => Some(canonical_schema(&lossy(units))),
    _ => None,
  };
  let records = match get(Some(&parsed), "records") {
    Some(Value::Array(records)) if schema.as_deref() == Some(NOTE_SCHEMA) => records,
    _ => return Vec::new(),
  };
  if !within_bound("noteContainerRecords", records.len() as u64) {
    return Vec::new();
  }
  records.clone()
}

/// A note blob's text as the readers see it: decoded and trimmed.
fn blob_text(content: &[u8]) -> String {
  text::trim(&String::from_utf8_lossy(content)).to_string()
}

/// `{ ...record, attachedTo }`: a record's own members, or a string's or an
/// array's indexed elements, then the attachment.
fn attached(record: &Value, target: &str) -> Value {
  let mut spread = match record {
    Value::Object(object) => object.clone(),
    Value::String(units) => {
      let mut object = Object::new();
      for (index, unit) in units.iter().enumerate() {
        object.set(&index.to_string(), Value::String(vec![*unit]));
      }
      object
    }
    Value::Array(items) => {
      let mut object = Object::new();
      for (index, item) in items.iter().enumerate() {
        object.set(&index.to_string(), item.clone());
      }
      object
    }
    _ => Object::new(),
  };
  spread.set("attachedTo", string(target));
  Value::Object(spread)
}

/// `listNoteEntries(cwd)`: the entries of the notes ref the repository uses.
pub fn list_note_entries(cwd: &str) -> GitResult<Vec<NoteEntry>> {
  engine::list_note_entries(names(cwd)?.notes_name, cwd)
}

/// `recordsForEntries(entries, cwd)`: every record of the listed notes, each
/// marked with its attachment.
fn records_for_entries(entries: &[NoteEntry], cwd: &str) -> GitResult<Vec<Value>> {
  if entries.is_empty() {
    return Ok(Vec::new());
  }
  let notes: Vec<String> = entries.iter().map(|entry| entry.note.clone()).collect();
  let objects = engine::read_git_objects(&notes, cwd)?;
  let mut records = Vec::new();
  for (entry, object) in entries.iter().zip(&objects.records) {
    if !object.exists || object.kind.as_deref() != Some("blob") {
      continue;
    }
    let text = blob_text(object.content.as_deref().unwrap_or_default());
    for record in note_records(&text) {
      records.push(attached(&record, &entry.target));
    }
  }
  Ok(records)
}

/// `listNoteRecords(cwd)`: every causal record, ordered by `createdAt`.
pub fn list_note_records(cwd: &str) -> GitResult<Vec<Value>> {
  let mut records = records_for_entries(&list_note_entries(cwd)?, cwd)?;
  let created = |record: &Value| match get(Some(record), "createdAt") {
    value if nullish(value) => String::new(),
    value => js_text(value),
  };
  records.sort_by(|left, right| locale_compare(&created(left), &created(right)));
  Ok(records)
}

/// `readNotes(objects, cwd)`: each object's note records (without
/// attachments), from one listing and one batched read.
pub fn read_notes(objects: &[String], cwd: &str) -> GitResult<HashMap<String, Vec<Value>>> {
  let mut notes: HashMap<String, Vec<Value>> = objects
    .iter()
    .map(|object| (object.clone(), Vec::new()))
    .collect();
  if notes.is_empty() {
    return Ok(notes);
  }
  let entries: Vec<NoteEntry> = list_note_entries(cwd)?
    .into_iter()
    .filter(|entry| notes.contains_key(&entry.target))
    .collect();
  if entries.is_empty() {
    return Ok(notes);
  }
  let blobs: Vec<String> = entries.iter().map(|entry| entry.note.clone()).collect();
  let objects = engine::read_git_objects(&blobs, cwd)?;
  for (entry, object) in entries.iter().zip(&objects.records) {
    if !object.exists || object.kind.as_deref() != Some("blob") {
      continue;
    }
    let text = blob_text(object.content.as_deref().unwrap_or_default());
    notes.insert(entry.target.clone(), note_records(&text));
  }
  Ok(notes)
}
