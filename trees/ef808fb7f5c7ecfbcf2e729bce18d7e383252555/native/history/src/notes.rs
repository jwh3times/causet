//! How a notes tree's notes become facts (facts.md §5.2), as the Git-backed
//! reader reads them: a note that is no readable container is one parked
//! fact; each record is a fact when import can take it, its object IDs the
//! native IDs of what they name; a record import cannot take is parked; and
//! a record that repeats an earlier one's fact is parked again as a copy, so
//! its logical ID stays conflicted.

use crate::action::{ActionActor, Time};
use crate::commit::{claimed, last_line, split};
use crate::fact::{Fact, Reason};
use crate::signature::Signature;
use causet_model::canonical::canonical_json;
use causet_model::json::{self, Object, Value};
use causet_model::schemas::{canonical_schema, object_id_fields, validate_note_record, within_bound};
use causet_store::id::NativeId;
use std::collections::{HashMap, HashSet};

/// The container schema a note holds.
const NOTE_SCHEMA: &str = "causet.note/v1";

/// One note of a notes tree.
#[derive(Clone, Debug)]
pub struct Note {
  /// The Git ID of the object it is attached to, in lowercase hex.
  pub attachment: String,
  /// Its bytes, or `None` when it is not content.
  pub bytes: Option<Vec<u8>>,
}

/// The facts the notes give, in the order they first give them, each once.
/// Notes are given in byte order of path, as the tree holds them. `format`
/// is the Git algorithm's name the validators judge object IDs in, and
/// `native` the native ID of the object a Git ID names, when the store holds
/// one: a commit's or tag's native form where import derived one.
pub fn facts_of_notes(
  notes: &[Note],
  format: &str,
  mut native: impl FnMut(&str) -> Option<NativeId>,
) -> Vec<Fact> {
  let mut facts: Vec<Fact> = Vec::new();
  let mut given: HashSet<NativeId> = HashSet::new();
  let mut give = |fact: Fact| {
    if given.insert(fact.id()) {
      facts.push(fact);
      true
    } else {
      false
    }
  };
  for note in notes {
    let place = note.attachment.as_bytes().to_vec();
    let Some(records) = note.bytes.as_deref().and_then(records_of) else {
      let bytes = note.bytes.clone().unwrap_or_default();
      give(Fact::Parked { reason: Reason::Unreadable, place, id: None, bytes });
      continue;
    };
    for (record, text) in records {
      let id = member_text(&record, "id").map(String::into_bytes);
      let parked = match fact_of_record(&record, &note.attachment, format, &mut native) {
        // A fact given before is a repeated copy (§5.2, 3).
        Some(fact) => (!give(fact)).then_some(Reason::Repeated),
        None => Some(Reason::Untaken),
      };
      if let Some(reason) = parked {
        give(Fact::Parked { reason, place: place.clone(), id, bytes: text });
      }
    }
  }
  facts
}

/// JavaScript's `String.prototype.trim`, as the Git-backed reader trims a
/// note's text.
fn trimmed(text: &str) -> &str {
  text.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

/// A readable container's records, each with its JSON text as the note
/// holds it, or `None` for a note that is not one: over the note container
/// bounds, not JSON, or not a `causet.note/v1` container (§5.2, 1). The
/// bytes are decoded as the Git-backed reader decodes them, with
/// replacement.
fn records_of(bytes: &[u8]) -> Option<Vec<(Value, Vec<u8>)>> {
  let decoded = String::from_utf8_lossy(bytes);
  let text = trimmed(&decoded);
  if !within_bound("noteContainerBytes", text.len() as u64) {
    return None;
  }
  let parsed = json::parse(text).ok()?;
  let schema = canonical_schema(&member_text(&parsed, "schema")?);
  let Some(Value::Array(records)) = causet_model::js::get(Some(&parsed), "records") else {
    return None;
  };
  if schema != NOTE_SCHEMA || !within_bound("noteContainerRecords", records.len() as u64) {
    return None;
  }
  let spans = record_spans(text.as_bytes())?;
  if spans.len() != records.len() {
    return None;
  }
  Some(
    records
      .iter()
      .cloned()
      .zip(spans.into_iter().map(|(start, end)| text.as_bytes()[start..end].to_vec()))
      .collect(),
  )
}

/// A record's member, when it is a string.
fn member_text(record: &Value, name: &str) -> Option<String> {
  match causet_model::js::get(Some(record), name) {
    Some(Value::String(units)) => Some(json::lossy(units)),
    _ => None,
  }
}

/// The object IDs a record holds (§3.2), each with the field it is at and in
/// lowercase: every string at one of its family's object-ID fields.
pub fn object_ids(record: &Value) -> Vec<(String, String)> {
  let fields: HashSet<&str> = member_text(record, "schema")
    .map(|schema| object_id_fields(&schema).iter().copied().collect())
    .unwrap_or_default();
  let mut found = Vec::new();
  collect_ids(record, "", &fields, &mut found);
  found
}

fn collect_ids(value: &Value, path: &str, fields: &HashSet<&str>, found: &mut Vec<(String, String)>) {
  match value {
    Value::String(units) if fields.contains(path) => {
      found.push((path.to_string(), json::lossy(units).to_ascii_lowercase()));
    }
    Value::Array(items) => {
      for item in items {
        collect_ids(item, path, fields, found);
      }
    }
    Value::Object(object) => {
      for key in object.keys() {
        let name = json::lossy(key);
        let child = if path.is_empty() { name } else { format!("{path}.{name}") };
        collect_ids(object.get_units(key).expect("a key it lists"), &child, fields, found);
      }
    }
    _ => {}
  }
}

/// The object IDs of a record import can take (§5.2, 2), or `None` when it
/// cannot: of a note-record family in a version this build knows, valid by
/// its schema with its attachment, inside the canonical profile, and with
/// its attachment and every object ID naming an object `held` says the store
/// holds. The fact derivation and the roots both ask this, so they agree.
fn acceptance(
  record: &Value,
  attachment: &str,
  format: &str,
  held: &mut impl FnMut(&str) -> bool,
) -> Option<Vec<(String, String)>> {
  let Value::Object(members) = record else {
    return None;
  };
  let mut attached = members.clone();
  attached.set("attachedTo", json::string(attachment));
  if !validate_note_record(Some(&Value::Object(attached)), format).is_empty() || canonical_json(record).is_err() {
    return None;
  }
  let ids = object_ids(record);
  (held(attachment) && ids.iter().all(|(_, id)| held(id))).then_some(ids)
}

/// The fact a record gives when import can take it, its object IDs the
/// native IDs of what they name (§3.2), or `None` when it cannot.
fn fact_of_record(
  record: &Value,
  attachment: &str,
  format: &str,
  native: &mut impl FnMut(&str) -> Option<NativeId>,
) -> Option<Fact> {
  let mut natives: HashMap<String, NativeId> = HashMap::new();
  let mut lookup = |id: &str| {
    if natives.contains_key(id) {
      return true;
    }
    match native(id) {
      Some(found) => {
        natives.insert(id.to_string(), found);
        true
      }
      None => false,
    }
  };
  let ids = acceptance(record, attachment, format, &mut lookup)?;
  let subject = natives[attachment];
  let mut names: Vec<NativeId> = ids.iter().map(|(_, id)| natives[id]).collect();
  names.push(subject);
  names.sort();
  names.dedup();
  let fields: HashSet<String> = ids.into_iter().map(|(field, _)| field).collect();
  let translated = translate(record, "", &fields, &natives);
  let canonical = canonical_json(&translated).ok()?;
  let schema = member_text(record, "schema")?.into_bytes();
  Some(Fact::Record { schema, actor: None, subject: Some(subject), names, record: canonical.into_bytes() })
}

/// A record with the object ID at each of `fields` (dotted paths, arrays
/// not counted) replaced by the text form of the native ID of what it names.
fn translate(value: &Value, path: &str, fields: &HashSet<String>, natives: &HashMap<String, NativeId>) -> Value {
  match value {
    Value::String(units) if fields.contains(path) => {
      json::string(&natives[&json::lossy(units).to_ascii_lowercase()].hex())
    }
    Value::Array(items) => Value::Array(items.iter().map(|item| translate(item, path, fields, natives)).collect()),
    Value::Object(object) => {
      let mut copy = Object::new();
      for key in object.keys() {
        let name = json::lossy(key);
        let child = if path.is_empty() { name } else { format!("{path}.{name}") };
        copy.insert(key.clone(), translate(object.get_units(key).expect("a key it lists"), &child, fields, natives));
      }
      Value::Object(copy)
    }
    other => other.clone(),
  }
}

/// The family whose `resolutionCommit` is a carrier, and no root (§5.5).
const RESOLUTION_SCHEMA: &str = "causet.resolution/v1";

/// The objects the records import can take name (§5.5), as Git IDs in
/// lowercase hex: each commit or Git tag among them is a root of import's
/// walk, so it gets a native commit or tag, and import leaves out the rest.
/// A resolution's `resolutionCommit`, also its subject, is a carrier and is
/// no root. `held` says whether the store holds an object.
pub fn roots_of_notes(notes: &[Note], format: &str, held: impl Fn(&str) -> bool) -> Vec<String> {
  let mut roots = Vec::new();
  for note in notes {
    let Some(records) = note.bytes.as_deref().and_then(records_of) else {
      continue;
    };
    for (record, _) in records {
      let Some(ids) = acceptance(&record, &note.attachment, format, &mut |id| held(id)) else {
        continue;
      };
      let resolution = member_text(&record, "schema").is_some_and(|schema| canonical_schema(&schema) == RESOLUTION_SCHEMA);
      for (field, id) in ids {
        if !(resolution && field == "resolutionCommit") {
          roots.push(id);
        }
      }
    }
  }
  roots
}

/// The actor and time of the entry import writes for a notes commit (§5.1),
/// from its committer line as an author's actor is derived: no kind, and none
/// when the line is empty or missing; the time only when the line is in
/// form `00`.
pub fn notes_commit_action(payload: &[u8]) -> (Option<ActionActor>, Option<Time>) {
  let (header, _) = split(payload);
  let Some(line) = last_line(header, b"committer ") else {
    return (None, None);
  };
  let actor = claimed(&line).map(|actor| ActionActor { actor, kind: None, on_behalf_of: None });
  let time = match Signature::from_line(&line) {
    Signature::Fields { time, offset, .. } => Some(Time { seconds: time, offset }),
    _ => None,
  };
  (actor, time)
}

/// The byte span of each element of a container's `records` array, from its
/// first byte to its last, in a text already parsed as JSON: of its last
/// `records` member, whose value `JSON.parse` keeps.
fn record_spans(text: &[u8]) -> Option<Vec<(usize, usize)>> {
  let mut at = skip_space(text, 0);
  if text.get(at) != Some(&b'{') {
    return None;
  }
  at = skip_space(text, at + 1);
  let mut found = None;
  while text.get(at) != Some(&b'}') {
    let key_end = value_end(text, at)?;
    let key = json::parse(std::str::from_utf8(&text[at..key_end]).ok()?).ok()?;
    at = skip_space(text, key_end);
    if text.get(at) != Some(&b':') {
      return None;
    }
    at = skip_space(text, at + 1);
    let end = value_end(text, at)?;
    if matches!(&key, Value::String(units) if json::lossy(units) == "records") && text[at] == b'[' {
      found = Some(elements(text, at)?);
    }
    at = skip_space(text, end);
    if text.get(at) == Some(&b',') {
      at = skip_space(text, at + 1);
    }
  }
  found
}

/// The spans of an array's elements, the array starting at `at`.
fn elements(text: &[u8], at: usize) -> Option<Vec<(usize, usize)>> {
  let mut spans = Vec::new();
  let mut at = skip_space(text, at + 1);
  while text.get(at) != Some(&b']') {
    let end = value_end(text, at)?;
    spans.push((at, end));
    at = skip_space(text, end);
    if text.get(at) == Some(&b',') {
      at = skip_space(text, at + 1);
    }
  }
  Some(spans)
}

/// JSON's whitespace.
fn skip_space(text: &[u8], mut at: usize) -> usize {
  while matches!(text.get(at), Some(b' ' | b'\t' | b'\n' | b'\r')) {
    at += 1;
  }
  at
}

/// Where the JSON value starting at `at` ends, one past its last byte.
fn value_end(text: &[u8], at: usize) -> Option<usize> {
  match text.get(at)? {
    b'"' => {
      let mut at = at + 1;
      loop {
        match text.get(at)? {
          b'\\' => at += 2,
          b'"' => return Some(at + 1),
          _ => at += 1,
        }
      }
    }
    b'{' | b'[' => {
      let mut depth = 0usize;
      let mut at = at;
      loop {
        match text.get(at)? {
          b'"' => {
            at = value_end(text, at)?;
            continue;
          }
          b'{' | b'[' => depth += 1,
          b'}' | b']' => {
            depth -= 1;
            if depth == 0 {
              return Some(at + 1);
            }
          }
          _ => {}
        }
        at += 1;
      }
    }
    _ => {
      let mut at = at;
      while !matches!(text.get(at), None | Some(b',' | b']' | b'}' | b' ' | b'\t' | b'\n' | b'\r')) {
        at += 1;
      }
      Some(at)
    }
  }
}
