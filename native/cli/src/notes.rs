//! Reading causal notes, as `src/notes.js` reads them: one note parser shared
//! by every reader, and the catalog reads (`readNotes`, `listNoteRecords`)
//! over a record source (`record_source`). Notes are shared-portable and
//! untrusted, so every disposition here is non-fatal (ADR-0020).

use crate::record_source::{Container, RecordSource};
use causet_engine::errors::GitResult;
use causet_engine::text;
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

/// A container's records as the readers see them, or `None` when the
/// container is missing or is not a blob.
fn container_records(container: &Container) -> Option<Vec<Value>> {
  container.bytes.as_deref().map(|bytes| note_records(&blob_text(bytes)))
}

/// `recordsForEntries(entries, cwd)`: every record of the containers, each
/// marked with its attachment.
fn records_for_containers(containers: &[Container]) -> Vec<Value> {
  containers
    .iter()
    .flat_map(|container| {
      container_records(container)
        .unwrap_or_default()
        .into_iter()
        .map(|record| attached(&record, &container.target))
    })
    .collect()
}

/// `listNoteRecords(cwd)`: every causal record the source holds, ordered by
/// `createdAt`.
pub fn list_note_records(source: &dyn RecordSource) -> GitResult<Vec<Value>> {
  let mut records = records_for_containers(&source.containers()?);
  let created = |record: &Value| match get(Some(record), "createdAt") {
    value if nullish(value) => String::new(),
    value => js_text(value),
  };
  records.sort_by(|left, right| locale_compare(&created(left), &created(right)));
  Ok(records)
}

/// `readNotes(objects, cwd)`: each object's records (without attachments),
/// from the containers the source holds for them.
pub fn read_notes(objects: &[String], source: &dyn RecordSource) -> GitResult<HashMap<String, Vec<Value>>> {
  let mut notes: HashMap<String, Vec<Value>> = objects
    .iter()
    .map(|object| (object.clone(), Vec::new()))
    .collect();
  if notes.is_empty() {
    return Ok(notes);
  }
  for container in source.containers_for(objects)? {
    if let Some(records) = container_records(&container) {
      notes.insert(container.target, records);
    }
  }
  Ok(notes)
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::record_source::fake::{Containers, container};
  use causet_model::json::stringify;

  fn container_of(records: &str) -> String {
    format!("{{\"schema\":\"causet.note/v1\",\"records\":[{records}]}}")
  }

  #[test]
  fn every_record_comes_from_the_source_marked_with_its_attachment_in_created_order() {
    let source = Containers(vec![
      container("c2", &container_of(r#"{"id":"late","createdAt":"2026-02-01T00:00:00.000Z"}"#)),
      container("c1", &container_of(r#"{"id":"early","createdAt":"2026-01-01T00:00:00.000Z"}"#)),
      container("c3", "  not json  "),
      Container { target: "c4".into(), id: "gone".into(), bytes: None },
      container("c5", "{\"schema\":\"causet.other/v1\",\"records\":[{\"id\":\"ignored\"}]}"),
    ]);
    let records: Vec<String> = list_note_records(&source).unwrap().iter().map(stringify).collect();
    assert_eq!(
      records,
      [
        r#"{"type":"legacy-note","text":"not json","attachedTo":"c3"}"#,
        r#"{"id":"early","createdAt":"2026-01-01T00:00:00.000Z","attachedTo":"c1"}"#,
        r#"{"id":"late","createdAt":"2026-02-01T00:00:00.000Z","attachedTo":"c2"}"#,
      ]
    );
  }

  #[test]
  fn each_asked_object_gets_the_records_its_container_holds_and_no_attachment() {
    let source = Containers(vec![
      container("c1", &container_of(r#"{"id":"one"}"#)),
      container("other", &container_of(r#"{"id":"not asked for"}"#)),
    ]);
    let notes = read_notes(&["c1".to_string(), "c2".to_string()], &source).unwrap();
    assert_eq!(notes.len(), 2);
    assert_eq!(notes["c1"].iter().map(stringify).collect::<Vec<_>>(), [r#"{"id":"one"}"#]);
    assert!(notes["c2"].is_empty());
  }
}
