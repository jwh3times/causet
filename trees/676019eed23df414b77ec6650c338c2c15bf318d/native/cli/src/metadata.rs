//! `cst metadata status` and `cst metadata validate`: the metadata inventory
//! of `src/metadata.js` (`metadataSnapshot`, `publicStatus`), taken under one
//! object session, with every validator in the JavaScript order so the same
//! diagnostics arise, and the same Git processes run, at the same points.

use crate::envelope::io_failure;
use crate::lineage::repository_lineage;
use crate::migration::advanced_legacy_refs;
use crate::records::short;
use crate::store::read_json;
use causet_engine::errors::{GitError, GitResult};
use causet_engine::locations::{
  family_remainder, local_ref, names, ref_family, repository_names, runtime_directory,
};
use causet_engine::session::with_object_session;
use causet_engine::types::{ObjectRecord, RefEntry, RepoContext};
use causet_engine::{engine, text};
use causet_model::canonical::record_digest;
use causet_model::js::{
  default_sort, get, locale_compare, nullish, strict_equals, text as js_text, truthy,
};
use causet_model::json::{Object, Value, lossy, parse, string};
use causet_model::schemas::{
  assert_readable_schema, canonical_schema, referenced_objects, resolution_signature,
  schema_classification, validate_note_record, within_bound,
};
use std::collections::{BTreeSet, HashMap};

pub const METADATA_STATUS_SCHEMA: &str = "causet.metadata-status/v1";
pub const METADATA_VALIDATION_SCHEMA: &str = "causet.metadata-validation/v1";
const NOTE_CONTAINER_SCHEMA: &str = "causet.note/v1";
const PARKED_RECORD_SCHEMA: &str = "causet.quarantined-record/v1";

fn number(value: usize) -> Value {
  Value::Number(value as f64)
}

fn or_null(value: Option<&Value>) -> Value {
  if nullish(value) {
    Value::Null
  } else {
    value.cloned().unwrap_or(Value::Null)
  }
}

fn as_string(value: Option<&Value>) -> Option<String> {
  match value {
    Some(Value::String(units)) => Some(lossy(units)),
    _ => None,
  }
}

fn bound(name: &str) -> u64 {
  causet_model::registry::RESOURCE_BOUNDS
    .iter()
    .find(|(bound, _)| *bound == name)
    .map_or(0, |(_, limit)| *limit)
}

/// One diagnostic: `{ code, severity, scope, subject, message, ...extra }`.
struct Diagnostic {
  code: String,
  severity: &'static str,
  scope: &'static str,
  subject: Value,
  message: String,
  extra: Vec<(&'static str, Value)>,
}

impl Diagnostic {
  fn to_value(&self) -> Value {
    let mut object = Object::new();
    object.set("code", string(&self.code));
    object.set("severity", string(self.severity));
    object.set("scope", string(self.scope));
    object.set("subject", self.subject.clone());
    object.set("message", string(&self.message));
    for (name, value) in &self.extra {
      object.set(name, value.clone());
    }
    Value::Object(object)
  }
}

#[derive(Default)]
struct Diagnostics(Vec<Diagnostic>);

impl Diagnostics {
  fn add(
    &mut self,
    code: &str,
    severity: &'static str,
    scope: &'static str,
    subject: Value,
    message: impl Into<String>,
    extra: Vec<(&'static str, Value)>,
  ) {
    self.0.push(Diagnostic {
      code: code.to_string(),
      severity,
      scope,
      subject,
      message: message.into(),
      extra,
    });
  }
}

/// `countBy(items, field)`: `String(item[field] ?? "(missing)")` counted, in
/// `localeCompare` order.
fn count_by(items: &[Value], field: &str) -> Value {
  let mut counts: Vec<(String, usize)> = Vec::new();
  for item in items {
    let value = get(Some(item), field);
    let key = if nullish(value) {
      "(missing)".to_string()
    } else {
      js_text(value)
    };
    match counts.iter_mut().find(|(existing, _)| *existing == key) {
      Some((_, count)) => *count += 1,
      None => counts.push((key, 1)),
    }
  }
  counts.sort_by(|left, right| locale_compare(&left.0, &right.0));
  let mut object = Object::new();
  for (key, count) in counts {
    object.set(&key, number(count));
  }
  Value::Object(object)
}

/// The metadata module's `listRefs(prefix)`: sorted, and empty when Git cannot
/// scan the store.
fn list_refs(prefix: &str, cwd: &str) -> Vec<RefEntry> {
  let mut entries = engine::list_refs(prefix, cwd).unwrap_or_default();
  entries.sort_by(|left, right| locale_compare(&left.name, &right.name));
  entries
}

fn refs_value(entries: &[RefEntry]) -> Value {
  Value::Array(
    entries
      .iter()
      .map(|entry| {
        let mut object = Object::new();
        object.set("ref", string(&entry.name));
        object.set("oid", string(&entry.oid));
        Value::Object(object)
      })
      .collect(),
  )
}

/// `objectLookup(expressions)`: one batched read of the unique expressions.
pub(crate) fn object_lookup(
  expressions: Vec<String>,
  cwd: &str,
) -> GitResult<HashMap<String, ObjectRecord>> {
  let mut unique: Vec<String> = expressions
    .into_iter()
    .filter(|item| !item.is_empty())
    .collect();
  unique.sort_by(|left, right| text::compare(left, right));
  unique.dedup();
  let objects = engine::read_git_objects(&unique, cwd)?;
  Ok(unique.into_iter().zip(objects.records).collect())
}

fn is_blob(object: Option<&ObjectRecord>) -> bool {
  object.is_some_and(|object| object.exists && object.kind.as_deref() == Some("blob"))
}

fn is_commit(object: Option<&ObjectRecord>) -> bool {
  object.is_some_and(|object| object.exists && object.kind.as_deref() == Some("commit"))
}

/// `parseNoteObject(object, entry, diagnostics)`: a container's records, or
/// `None` with its diagnostic.
fn parse_note_object(
  object: Option<&ObjectRecord>,
  note: &str,
  target: &str,
  diagnostics: &mut Diagnostics,
) -> Option<Vec<Value>> {
  let subject = || string(target);
  if !is_blob(object) {
    diagnostics.add(
      "missing-note-object",
      "error",
      "shared-portable",
      subject(),
      format!("Note object '{note}' is missing or is not a blob."),
      Vec::new(),
    );
    return None;
  }
  let content = object
    .and_then(|object| object.content.as_deref())
    .unwrap_or_default();
  if !within_bound("noteContainerBytes", content.len() as u64) {
    diagnostics.add(
      "oversize-record",
      "warning",
      "shared-portable",
      subject(),
      format!(
        "The attached note exceeds the noteContainerBytes bound of {}.",
        bound("noteContainerBytes")
      ),
      Vec::new(),
    );
    return None;
  }
  let Ok(parsed) = parse(&String::from_utf8_lossy(content)) else {
    diagnostics.add(
      "malformed-record",
      "error",
      "shared-portable",
      subject(),
      "The attached note is not valid JSON.",
      Vec::new(),
    );
    return None;
  };
  let records = match (&parsed, get(Some(&parsed), "records")) {
    (Value::Object(_), Some(Value::Array(records))) => records.clone(),
    _ => {
      diagnostics.add(
        "malformed-record",
        "error",
        "shared-portable",
        subject(),
        "The attached note is not a versioned record container.",
        Vec::new(),
      );
      return None;
    }
  };
  let schema = get(Some(&parsed), "schema");
  if as_string(schema)
    .map(|schema| canonical_schema(&schema))
    .as_deref()
    != Some(NOTE_CONTAINER_SCHEMA)
  {
    let shown = if nullish(schema) {
      "(missing)".to_string()
    } else {
      js_text(schema)
    };
    diagnostics.add(
      "unknown-schema",
      "warning",
      "shared-portable",
      subject(),
      format!("Unsupported note container schema '{shown}'."),
      vec![("schema", or_null(schema))],
    );
    return None;
  }
  if !within_bound("noteContainerRecords", records.len() as u64) {
    diagnostics.add(
      "oversize-record",
      "warning",
      "shared-portable",
      subject(),
      format!(
        "The attached note exceeds the noteContainerRecords bound of {}.",
        bound("noteContainerRecords")
      ),
      Vec::new(),
    );
    return None;
  }
  Some(records)
}

/// `{ ...record, attachedTo }`, as the notes reader spreads a record.
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

/// `duplicatedRecordIds(records)`.
pub(crate) fn duplicated_record_ids(records: &[&Value]) -> BTreeSet<String> {
  let mut counts: HashMap<String, usize> = HashMap::new();
  for record in records {
    if let Some(id) = as_string(get(Some(record), "id")) {
      *counts.entry(id).or_default() += 1;
    }
  }
  counts
    .into_iter()
    .filter(|(_, count)| *count > 1)
    .map(|(id, _)| id)
    .collect()
}

/// `readCausalRecordCatalog(cwd)`: every record in the notes tree, read under
/// the snapshot's container rules, with the identifiers that conflict across
/// the whole tree (duplicated here, or disputed by a parked copy).
pub(crate) fn read_causal_record_catalog(
  cwd: &str,
) -> GitResult<(Vec<Value>, BTreeSet<String>)> {
  let context = engine::repo_context(cwd)?;
  let root = &context.root;
  let mut entries = engine::list_note_entries(names(root)?.notes_ref, root)?;
  entries.sort_by(|left, right| locale_compare(&left.target, &right.target));
  let note_objects = object_lookup(
    entries.iter().map(|entry| entry.note.clone()).collect(),
    root,
  )?;
  let mut ignored = Diagnostics::default();
  let mut records = Vec::new();
  for entry in &entries {
    let parsed = parse_note_object(
      note_objects.get(&entry.note),
      &entry.note,
      &entry.target,
      &mut ignored,
    );
    for record in parsed.unwrap_or_default() {
      records.push(attached(&record, &entry.target));
    }
  }
  let mut conflicting = duplicated_record_ids(&records.iter().collect::<Vec<_>>());
  conflicting.extend(parked_record_ids(root)?);
  Ok((records, conflicting))
}

/// `acceptedCausalRecords(records, cwd, { conflictingIds })`: the records a
/// reader may rely on, structurally valid, with every referenced object
/// present at the expected type, and no identifier conflict.
pub(crate) fn accepted_causal_records(
  records: &[&Value],
  cwd: &str,
  conflicting: &BTreeSet<String>,
) -> GitResult<Vec<Value>> {
  let context = engine::repo_context(cwd)?;
  let structural: Vec<&Value> = records
    .iter()
    .copied()
    .filter(|record| {
      !as_string(get(Some(record), "id")).is_some_and(|id| conflicting.contains(&id))
        && validate_note_record(Some(record), &context.object_format).is_empty()
    })
    .collect();
  let references: Vec<String> = structural
    .iter()
    .flat_map(|record| referenced_objects(Some(record)))
    .map(|reference| lossy(&reference.oid))
    .collect();
  let objects = object_lookup(references, cwd)?;
  Ok(
    structural
      .into_iter()
      .filter(|record| {
        referenced_objects(Some(record)).iter().all(|reference| {
          objects.get(&lossy(&reference.oid)).is_some_and(|object| {
            object.exists && object.kind.as_deref() == Some(reference.kind)
          })
        })
      })
      .cloned()
      .collect(),
  )
}

/// `parkedRecordIds(cwd)`: the identifiers a parked dispute names.
fn parked_record_ids(cwd: &str) -> GitResult<BTreeSet<String>> {
  let prefix = format!("{}/", ref_family("quarantine", cwd)?);
  Ok(
    engine::list_refs(&prefix, cwd)?
      .iter()
      .filter_map(|entry| parsed_parked_ref(&entry.name).map(|(_, record)| record))
      .collect(),
  )
}

/// `parsedParkedRef(ref)`: `<source lineage>/<record id>` under either names.
fn parsed_parked_ref(name: &str) -> Option<(String, String)> {
  let rest = family_remainder(name, "quarantine")?;
  let parts: Vec<&str> = rest.split('/').collect();
  (parts.len() == 2 && !parts[0].is_empty() && !parts[1].is_empty())
    .then(|| (parts[0].to_string(), parts[1].to_string()))
}

struct Structural {
  record: Value,
  raw: Value,
  attachment: String,
  digest: String,
  valid: bool,
}

struct Portable {
  notes: Value,
  resolutions: Value,
  accepted: usize,
  /// The accepted records with their attachments and digests, in note order.
  records: Vec<(String, Value, String)>,
  /// The summaries, for the quarantine's local digests.
  summaries: Vec<Value>,
}

/// `validatePortableNotes(context, diagnostics, options)`.
fn validate_portable_notes(
  context: &RepoContext,
  diagnostics: &mut Diagnostics,
  parked: &BTreeSet<String>,
) -> GitResult<Portable> {
  let root = &context.root;
  let repository_names = names(root)?;
  let mut entries = engine::list_note_entries(repository_names.notes_ref, root)?;
  entries.sort_by(|left, right| locale_compare(&left.target, &right.target));
  let note_objects = object_lookup(
    entries.iter().map(|entry| entry.note.clone()).collect(),
    root,
  )?;
  let target_objects = object_lookup(
    entries.iter().map(|entry| entry.target.clone()).collect(),
    root,
  )?;
  let mut raw_records: Vec<(Value, String)> = Vec::new();
  for entry in &entries {
    if !is_commit(target_objects.get(&entry.target)) {
      diagnostics.add(
        "missing-attachment",
        "error",
        "shared-portable",
        string(&entry.target),
        format!(
          "The note attachment is missing or is not a commit in this clone. Fetch {}/* together with {} from the fact's origin and validate again; if it remains missing, restore it from a trusted clone, backup, or metadata envelope.",
          repository_names.refs_root, repository_names.notes_ref
        ),
        Vec::new(),
      );
    }
    let records = parse_note_object(
      note_objects.get(&entry.note),
      &entry.note,
      &entry.target,
      diagnostics,
    );
    for record in records.unwrap_or_default() {
      raw_records.push((record, entry.target.clone()));
    }
  }

  let mut structural = Vec::new();
  for (raw, attachment) in raw_records {
    let record = attached(&raw, &attachment);
    let schema = get(Some(&record), "schema");
    let schema_text = as_string(schema);
    let classification = schema_classification(schema_text.as_deref());
    let errors = validate_note_record(Some(&record), &context.object_format);
    let subject = || {
      let id = get(Some(&record), "id");
      if nullish(id) {
        string(&attachment)
      } else {
        id.cloned().unwrap_or(Value::Null)
      }
    };
    let note_record = classification.known && classification.scope == Some("note-record");
    if !note_record {
      let shown = if nullish(schema) {
        "(missing)".to_string()
      } else {
        js_text(schema)
      };
      diagnostics.add(
        "unknown-schema",
        "warning",
        "shared-portable",
        subject(),
        format!("Unsupported causal record schema '{shown}'."),
        vec![
          ("schema", or_null(schema)),
          ("attachment", string(&attachment)),
        ],
      );
    } else if !errors.is_empty() {
      let detail: Vec<String> = errors
        .iter()
        .map(|error| format!("{} must be {}", error.field, error.expectation))
        .collect();
      diagnostics.add(
        "malformed-record",
        "error",
        "shared-portable",
        subject(),
        format!(
          "Record does not match '{}': {}.",
          js_text(schema),
          detail.join("; ")
        ),
        vec![
          ("schema", schema.cloned().unwrap_or(Value::Null)),
          ("attachment", string(&attachment)),
        ],
      );
    }
    let digest = record_digest(&attachment, &raw);
    structural.push(Structural {
      valid: note_record && errors.is_empty(),
      record,
      raw,
      attachment,
      digest,
    });
  }

  let duplicated = duplicated_record_ids(
    &structural
      .iter()
      .map(|entry| &entry.record)
      .collect::<Vec<_>>(),
  );
  let conflicting = |id: &str| duplicated.contains(id) || parked.contains(id);
  let references: Vec<String> = structural
    .iter()
    .filter(|entry| entry.valid)
    .flat_map(|entry| referenced_objects(Some(&entry.record)))
    .map(|reference| lossy(&reference.oid))
    .collect();
  let referenced = object_lookup(references, root)?;
  let resolution_refs = list_refs(&ref_family("resolutions", root)?, root);
  let peeled: HashMap<String, Option<String>> = if resolution_refs.is_empty() {
    HashMap::new()
  } else {
    let expressions: Vec<String> = resolution_refs
      .iter()
      .map(|entry| format!("{}^{{commit}}", entry.oid))
      .collect();
    let objects = engine::inspect_git_objects(&expressions, root)?;
    resolution_refs
      .iter()
      .zip(objects.records)
      .map(|(entry, object)| {
        let commit = (object.exists && object.kind.as_deref() == Some("commit"))
          .then_some(object.oid)
          .flatten();
        (entry.name.clone(), commit)
      })
      .collect()
  };
  let is_resolution =
    |record: &Value| strict_equals(get(Some(record), "type"), Some(&string("resolution")));
  let retained_objects = object_lookup(
    structural
      .iter()
      .filter(|entry| {
        entry.valid
          && is_resolution(&entry.record)
          && truthy(get(Some(&entry.record), "resultBlob"))
      })
      .map(|entry| {
        format!(
          "{}:result",
          js_text(get(Some(&entry.record), "resolutionCommit"))
        )
      })
      .collect(),
    root,
  )?;

  let mut summaries = Vec::new();
  let mut accepted: Vec<(String, Value, String)> = Vec::new();
  let mut diagnosed_conflicts: BTreeSet<String> = BTreeSet::new();
  for entry in &structural {
    let record = &entry.record;
    let member = |name: &str| get(Some(record), name);
    let mut valid = entry.valid;
    let mut codes: Vec<String> = Vec::new();
    if valid && !is_commit(target_objects.get(&entry.attachment)) {
      valid = false;
    }
    if valid {
      for reference in referenced_objects(Some(record)) {
        let oid = lossy(&reference.oid);
        let object = referenced.get(&oid);
        let present = object
          .is_some_and(|object| object.exists && object.kind.as_deref() == Some(reference.kind));
        if !present {
          let code = if is_resolution(record) && reference.field == "resultBlob" {
            "missing-resolution-blob"
          } else {
            "missing-referenced-object"
          };
          diagnostics.add(
            code,
            "error",
            "shared-portable",
            member("id").cloned().unwrap_or(Value::Null),
            format!(
              "Referenced {} '{oid}' from '{}' is missing or has the wrong type.",
              reference.kind, reference.field
            ),
            vec![
              ("schema", member("schema").cloned().unwrap_or(Value::Null)),
              ("attachment", string(&entry.attachment)),
              ("field", string(&reference.field)),
            ],
          );
          codes.push(code.into());
          valid = false;
        }
      }
    }
    if entry.valid && is_resolution(record) {
      // `resolutionSignatureFor(record) !== record.signature`.
      let signature = resolution_signature(Some(record)).ok();
      let matches = match (signature, as_string(member("signature"))) {
        (Some(computed), Some(stored)) => computed == stored,
        _ => false,
      };
      if !matches {
        diagnostics.add(
          "resolution-signature-mismatch",
          "error",
          "shared-portable",
          member("id").cloned().unwrap_or(Value::Null),
          "The stored resolution signature does not match its ordered stages.",
          vec![("attachment", string(&entry.attachment))],
        );
        codes.push("resolution-signature-mismatch".into());
        valid = false;
      }
      let named = as_string(member("ref")).unwrap_or_default();
      let local = local_ref(&named, root)?;
      let peeled_commit = peeled.get(&local).cloned().flatten();
      if peeled_commit.as_deref() != as_string(member("resolutionCommit")).as_deref()
        || peeled_commit.is_none()
      {
        diagnostics.add(
          "missing-resolution-ref",
          "error",
          "shared-portable",
          member("id").cloned().unwrap_or(Value::Null),
          format!(
            "Resolution ref '{}' is missing or points to a different commit.",
            js_text(member("ref"))
          ),
          vec![
            ("attachment", string(&entry.attachment)),
            ("ref", member("ref").cloned().unwrap_or(Value::Null)),
          ],
        );
        codes.push("missing-resolution-ref".into());
        valid = false;
      }
      if truthy(member("resultBlob")) {
        let retained =
          retained_objects.get(&format!("{}:result", js_text(member("resolutionCommit"))));
        let matches = is_blob(retained)
          && retained.and_then(|object| object.oid.as_deref())
            == as_string(member("resultBlob")).as_deref();
        if !matches {
          diagnostics.add(
            "missing-resolution-blob",
            "error",
            "shared-portable",
            member("id").cloned().unwrap_or(Value::Null),
            "The resolution retention commit does not contain the declared result blob.",
            vec![
              ("attachment", string(&entry.attachment)),
              ("ref", member("ref").cloned().unwrap_or(Value::Null)),
            ],
          );
          codes.push("missing-resolution-blob".into());
          valid = false;
        }
      }
    }
    if let Some(id) = as_string(member("id"))
      && conflicting(&id)
    {
      let code = if duplicated.contains(&id) {
        "record-id-conflict"
      } else {
        "parked-record-conflict"
      };
      if diagnosed_conflicts.insert(id.clone()) {
        diagnostics.add(
          code,
          "error",
          "shared-portable",
          string(&id),
          if code == "record-id-conflict" {
            "The same record ID names different metadata facts."
          } else {
            "A parked incoming copy disputes this record; neither copy is used until it is disposed of."
          },
          vec![("attachment", string(&entry.attachment))],
        );
      }
      codes.push(code.into());
      valid = false;
    }
    codes.sort_by(|left, right| text::compare(left, right));
    codes.dedup();
    let mut summary = Object::new();
    summary.set("attachment", string(&entry.attachment));
    summary.set("id", or_null(member("id")));
    summary.set("schema", or_null(member("schema")));
    summary.set("type", or_null(member("type")));
    summary.set("digest", string(&entry.digest));
    summary.set("valid", Value::Bool(valid));
    summary.set(
      "diagnostics",
      Value::Array(codes.iter().map(|code| string(code)).collect()),
    );
    summaries.push(Value::Object(summary));
    if valid {
      accepted.push((
        entry.attachment.clone(),
        entry.raw.clone(),
        entry.digest.clone(),
      ));
    }
  }

  let mut accepted_resolution_refs: Vec<String> = Vec::new();
  for (_, raw, _) in &accepted {
    if is_resolution(raw) {
      let local = local_ref(&as_string(get(Some(raw), "ref")).unwrap_or_default(), root)?;
      if !accepted_resolution_refs.contains(&local) {
        accepted_resolution_refs.push(local);
      }
    }
  }
  for entry in &resolution_refs {
    if !accepted_resolution_refs.contains(&entry.name) {
      diagnostics.add(
        "missing-resolution-record",
        "error",
        "shared-portable",
        string(&entry.name),
        "A resolution retention ref has no accepted resolution record.",
        Vec::new(),
      );
    }
  }

  let order = |value: &Value| {
    (
      as_string(get(Some(value), "attachment")).unwrap_or_default(),
      js_text(get(Some(value), "id")),
      as_string(get(Some(value), "digest")).unwrap_or_default(),
    )
  };
  summaries.sort_by(|left, right| {
    let (left, right) = (order(left), order(right));
    locale_compare(&left.0, &right.0)
      .then_with(|| locale_compare(&left.1, &right.1))
      .then_with(|| locale_compare(&left.2, &right.2))
  });
  // `accepted.sort(...)`: by attachment, `String(record.id)`, then digest.
  accepted.sort_by(|left, right| {
    locale_compare(&left.0, &right.0)
      .then_with(|| locale_compare(&js_text(get(Some(&left.1), "id")), &js_text(get(Some(&right.1), "id"))))
      .then_with(|| locale_compare(&left.2, &right.2))
  });
  let quarantined = summaries.len() - accepted.len();
  let mut notes = Object::new();
  notes.set("ref", string(repository_names.notes_ref));
  notes.set("targetCount", number(entries.len()));
  notes.set("recordCount", number(summaries.len()));
  notes.set("acceptedCount", number(accepted.len()));
  notes.set("quarantinedCount", number(quarantined));
  notes.set("bySchema", count_by(&summaries, "schema"));
  notes.set("byType", count_by(&summaries, "type"));
  notes.set("records", Value::Array(summaries.clone()));
  let mut resolutions = Object::new();
  resolutions.set(
    "namespace",
    string(&format!("{}/*", ref_family("resolutions", root)?)),
  );
  resolutions.set("refCount", number(resolution_refs.len()));
  resolutions.set("acceptedRefCount", number(accepted_resolution_refs.len()));
  resolutions.set("refs", refs_value(&resolution_refs));
  Ok(Portable {
    notes: Value::Object(notes),
    resolutions: Value::Object(resolutions),
    accepted: accepted.len(),
    records: accepted.clone(),
    summaries,
  })
}

/// `normalizeMarkdown(text)`: CRLF and CR line ends as LF.
fn normalize_markdown(text: &str) -> String {
  text.replace("\r\n", "\n").replace('\r', "\n")
}

/// `validateSpecs(context, diagnostics)`.
fn validate_specs(context: &RepoContext, diagnostics: &mut Diagnostics) -> GitResult<Value> {
  let root = &context.root;
  let files = engine::list_tracked_paths(&[names(root)?.specs_dir.to_string()], root)?;
  let mut manifests = Vec::new();
  for file in files {
    let absolute = std::path::Path::new(root).join(&file);
    let parsed = std::fs::read(&absolute)
      .ok()
      .and_then(|raw| parse(&String::from_utf8_lossy(&raw)).ok());
    let Some(manifest) = parsed else {
      diagnostics.add(
        "malformed-record",
        "error",
        "tracked-portable",
        string(&file),
        "The tracked specification manifest is not valid JSON.",
        Vec::new(),
      );
      let mut entry = Object::new();
      entry.set("path", string(&file));
      entry.set("schema", Value::Null);
      entry.set("source", Value::Null);
      entry.set("consistent", Value::Bool(false));
      manifests.push(Value::Object(entry));
      continue;
    };
    let member = |name: &str| get(Some(&manifest), name);
    let schema = member("schema");
    let classification = schema_classification(as_string(schema).as_deref());
    if !classification.known || classification.scope != Some("tracked") {
      let shown = if nullish(schema) {
        "(missing)".to_string()
      } else {
        js_text(schema)
      };
      diagnostics.add(
        "unknown-schema",
        "warning",
        "tracked-portable",
        string(&file),
        format!("Unsupported specification manifest schema '{shown}'."),
        vec![("schema", or_null(schema))],
      );
    }
    let source = as_string(member("source"));
    // `path.join(root, ...source.split("/"))`: joined and normalized, never
    // re-rooted by a component that looks absolute.
    let source_absolute = source
      .as_ref()
      .filter(|source| !source.is_empty())
      .map(|source| text::resolve_path(&format!("{root}{}{source}", text::SEPARATOR)));
    let mut consistent = false;
    let exists = source_absolute
      .as_ref()
      .is_some_and(|path| std::path::Path::new(path).exists());
    if !exists {
      diagnostics.add(
        "spec-source-missing",
        "error",
        "tracked-portable",
        string(&file),
        format!(
          "Specification source '{}' is missing.",
          source.clone().unwrap_or_else(|| "(missing)".into())
        ),
        Vec::new(),
      );
    } else if !matches!(member("sourceHash"), Some(Value::String(_))) {
      diagnostics.add(
        "malformed-record",
        "error",
        "tracked-portable",
        string(&file),
        "Specification manifest is missing sourceHash.",
        Vec::new(),
      );
    } else {
      let path = source_absolute.clone().unwrap_or_default();
      let raw = std::fs::read(&path).map_err(|error| io_failure(&error, "read", &path))?;
      let actual =
        causet_model::sha256::hex(normalize_markdown(&String::from_utf8_lossy(&raw)).as_bytes());
      consistent = Some(actual) == as_string(member("sourceHash"));
      if !consistent {
        diagnostics.add(
          "spec-manifest-stale",
          "error",
          "tracked-portable",
          string(&file),
          format!(
            "Specification manifest does not match '{}'.",
            source.clone().unwrap_or_default()
          ),
          Vec::new(),
        );
      }
    }
    let blocks = get(member("blocks"), "length")
      .cloned()
      .or_else(|| match member("blocks") {
        Some(Value::Array(items)) => Some(number(items.len())),
        Some(Value::String(units)) => Some(number(units.len())),
        _ => None,
      });
    let entity_count = if nullish(member("entityCount")) {
      if nullish(blocks.as_ref()) {
        Value::Null
      } else {
        blocks.unwrap_or(Value::Null)
      }
    } else {
      member("entityCount").cloned().unwrap_or(Value::Null)
    };
    let mut entry = Object::new();
    entry.set("path", string(&file.replace('\\', "/")));
    entry.set("schema", or_null(schema));
    entry.set("source", source.as_deref().map_or(Value::Null, string));
    entry.set("artifactId", or_null(member("artifactId")));
    entry.set("entityCount", entity_count);
    entry.set("consistent", Value::Bool(consistent));
    manifests.push(Value::Object(entry));
  }
  let consistent = manifests
    .iter()
    .filter(|manifest| truthy(get(Some(manifest), "consistent")))
    .count();
  let mut result = Object::new();
  result.set("manifestCount", number(manifests.len()));
  result.set("bySchema", count_by(&manifests, "schema"));
  result.set("consistentCount", number(consistent));
  result.set("manifests", Value::Array(manifests));
  Ok(Value::Object(result))
}

/// `validateSharedLocal(context, diagnostics, localDigests)`.
fn validate_shared_local(
  context: &RepoContext,
  diagnostics: &mut Diagnostics,
  local_digests: &HashMap<String, Vec<String>>,
) -> GitResult<Value> {
  let root = &context.root;
  let runtime = runtime_directory(&context.common_dir, root)?;
  let workspace_path = text::join(&runtime, "workspaces.json");
  let empty_registry = |present: bool| {
    let mut registry = Object::new();
    registry.set("present", Value::Bool(present));
    registry.set("schema", Value::Null);
    registry.set("count", number(0));
    registry.set("workspaces", Value::Array(Vec::new()));
    Value::Object(registry)
  };
  let mut registry = empty_registry(false);
  if std::path::Path::new(&workspace_path).exists() {
    let parsed = std::fs::read(&workspace_path)
      .ok()
      .and_then(|raw| parse(&String::from_utf8_lossy(&raw)).ok());
    match parsed {
      None => {
        diagnostics.add(
          "malformed-record",
          "error",
          "shared-local",
          string(&workspace_path),
          "Workspace registry is not valid JSON.",
          Vec::new(),
        );
        registry = empty_registry(true);
      }
      Some(parsed) => {
        let listed = match get(Some(&parsed), "workspaces") {
          Some(Value::Array(items)) => items.clone(),
          _ => Vec::new(),
        };
        let mut workspaces: Vec<Value> = listed
          .iter()
          .map(|workspace| {
            let member = |name: &str| get(Some(workspace), name);
            let lifecycle = member("lifecycle");
            let path = member("path");
            let exists = as_string(path).is_some_and(|path| std::path::Path::new(&path).exists());
            let mut entry = Object::new();
            entry.set("id", or_null(member("id")));
            entry.set("name", or_null(member("name")));
            entry.set("path", or_null(path));
            entry.set(
              "lifecycle",
              if nullish(lifecycle) {
                string("active")
              } else {
                lifecycle.cloned().unwrap_or(Value::Null)
              },
            );
            entry.set("pathExists", Value::Bool(exists));
            Value::Object(entry)
          })
          .collect();
        workspaces.sort_by(|left, right| {
          locale_compare(
            &js_text(get(Some(left), "id")),
            &js_text(get(Some(right), "id")),
          )
        });
        let schema = get(Some(&parsed), "schema");
        let canonical = as_string(schema).map(|schema| canonical_schema(&schema));
        if canonical.as_deref() != Some("causet.workspaces/v1")
          || !matches!(get(Some(&parsed), "workspaces"), Some(Value::Array(_)))
        {
          diagnostics.add(
            "malformed-record",
            "error",
            "shared-local",
            string(&workspace_path),
            "Workspace registry does not match causet.workspaces/v1.",
            Vec::new(),
          );
        }
        for workspace in &workspaces {
          let member = |name: &str| get(Some(workspace), name);
          let subject = || {
            for name in ["id", "name"] {
              if !nullish(member(name)) {
                return member(name).cloned().unwrap_or(Value::Null);
              }
            }
            string(&workspace_path)
          };
          let lifecycle = member("lifecycle");
          let lifecycle_text = as_string(lifecycle);
          let archived = lifecycle_text.as_deref() == Some("archived");
          let exists = truthy(member("pathExists"));
          if !matches!(lifecycle_text.as_deref(), Some("active" | "archived")) {
            let shown = if nullish(lifecycle) {
              "(missing)".to_string()
            } else {
              js_text(lifecycle)
            };
            diagnostics.add(
              "workspace-lifecycle-invalid",
              "error",
              "shared-local",
              subject(),
              format!("Workspace lifecycle '{shown}' is not supported."),
              Vec::new(),
            );
          }
          if !archived && !exists {
            let path = member("path");
            let shown = if nullish(path) {
              "(missing)".to_string()
            } else {
              js_text(path)
            };
            diagnostics.add(
              "workspace-path-missing",
              "warning",
              "shared-local",
              subject(),
              format!("Workspace path '{shown}' does not exist."),
              Vec::new(),
            );
          }
          if archived && exists {
            diagnostics.add(
              "workspace-archived-path-present",
              "warning",
              "shared-local",
              subject(),
              format!(
                "Archived workspace path '{}' still exists; repair or remove the stale materialization.",
                js_text(member("path"))
              ),
              Vec::new(),
            );
          }
        }
        let mut object = Object::new();
        object.set("present", Value::Bool(true));
        object.set("schema", or_null(schema));
        object.set("count", number(listed.len()));
        object.set("workspaces", Value::Array(workspaces));
        registry = Value::Object(object);
      }
    }
  }
  let checkpoint_refs = list_refs(&ref_family("checkpoints", root)?, root);
  let history_refs = list_refs(&ref_family("checkpoint-history", root)?, root);
  let all: Vec<&RefEntry> = checkpoint_refs.iter().chain(&history_refs).collect();
  let checkpoint_objects =
    object_lookup(all.iter().map(|entry| entry.oid.clone()).collect(), root)?;
  for checkpoint in &all {
    if !is_commit(checkpoint_objects.get(&checkpoint.oid)) {
      diagnostics.add(
        "missing-referenced-object",
        "error",
        "shared-local",
        string(&checkpoint.name),
        "Checkpoint ref does not resolve to a commit.",
        Vec::new(),
      );
    }
  }
  let mut checkpoints = Object::new();
  checkpoints.set("refCount", number(checkpoint_refs.len()));
  checkpoints.set("refs", refs_value(&checkpoint_refs));
  checkpoints.set("historyRefCount", number(history_refs.len()));
  checkpoints.set("historyRefs", refs_value(&history_refs));
  checkpoints.set("totalRefCount", number(all.len()));
  let mut shared = Object::new();
  shared.set("workspaceRegistry", registry);
  shared.set("checkpoints", Value::Object(checkpoints));
  shared.set(
    "quarantine",
    inspect_quarantine(context, diagnostics, local_digests)?,
  );
  shared.set("dispositions", inspect_dispositions(context, diagnostics)?);
  Ok(Value::Object(shared))
}

/// `inspectQuarantine` over `listParkedRecords`.
fn inspect_quarantine(
  context: &RepoContext,
  diagnostics: &mut Diagnostics,
  local_digests: &HashMap<String, Vec<String>>,
) -> GitResult<Value> {
  let root = &engine::repo_context(&context.root)?.root;
  let namespace = ref_family("quarantine", root)?;
  let mut refs: Vec<RefEntry> = engine::list_refs(&format!("{namespace}/"), root)?
    .into_iter()
    .filter(|entry| parsed_parked_ref(&entry.name).is_some())
    .collect();
  refs.sort_by(|left, right| locale_compare(&left.name, &right.name));
  let objects = if refs.is_empty() {
    Vec::new()
  } else {
    engine::read_git_objects(
      &refs
        .iter()
        .map(|entry| entry.oid.clone())
        .collect::<Vec<_>>(),
      root,
    )?
    .records
  };
  let mut records = Vec::new();
  for (entry, object) in refs.iter().zip(objects) {
    let (lineage, record_id) = parsed_parked_ref(&entry.name).unwrap_or_default();
    let payload = if object.exists && object.kind.as_deref() == Some("blob") {
      let content = object.content.unwrap_or_default();
      if !within_bound("noteContainerBytes", content.len() as u64) {
        Err("oversize-record")
      } else {
        match parse(&String::from_utf8_lossy(&content)) {
          Err(_) => Err("malformed-record"),
          Ok(payload) => {
            let schema =
              as_string(get(Some(&payload), "schema")).map(|schema| canonical_schema(&schema));
            if schema.as_deref() == Some(PARKED_RECORD_SCHEMA) {
              Ok(payload)
            } else {
              Err("unknown-schema-version")
            }
          }
        }
      }
    } else {
      Err("missing-parked-blob")
    };
    if let Err(reason) = payload {
      diagnostics.add(
        if reason == "oversize-record" {
          "oversize-record"
        } else {
          "malformed-record"
        },
        "error",
        "shared-local",
        string(&entry.name),
        format!(
          "The parked record at '{}' is not readable: {reason}.",
          entry.name
        ),
        Vec::new(),
      );
    }
    let payload = payload.ok();
    let field = |path: &[&str]| {
      or_null(
        path
          .iter()
          .fold(payload.as_ref(), |value, name| get(value, name)),
      )
    };
    let mut digests: Vec<String> = local_digests.get(&record_id).cloned().unwrap_or_default();
    digests.sort_by(|left, right| text::compare(left, right));
    let mut summary = Object::new();
    summary.set("ref", string(&entry.name));
    summary.set("recordId", string(&record_id));
    summary.set("sourceLineage", string(&lineage));
    summary.set("readable", Value::Bool(payload.is_some()));
    summary.set("digest", field(&["digest"]));
    summary.set("attachment", field(&["attachment"]));
    summary.set("schema", field(&["record", "schema"]));
    summary.set("type", field(&["record", "type"]));
    summary.set("envelopeHash", field(&["envelopeHash"]));
    summary.set("parkedAt", field(&["parkedAt"]));
    summary.set(
      "localDigests",
      Value::Array(digests.iter().map(|digest| string(digest)).collect()),
    );
    records.push(Value::Object(summary));
  }
  let mut quarantine = Object::new();
  quarantine.set(
    "namespace",
    string(&format!("{}/*", ref_family("quarantine", &context.root)?)),
  );
  quarantine.set("refCount", number(records.len()));
  quarantine.set("records", Value::Array(records));
  Ok(Value::Object(quarantine))
}

/// `readDispositions(cwd)`: the registry, or the refusal it raises.
fn read_dispositions(context: &RepoContext) -> GitResult<Value> {
  let runtime = runtime_directory(
    &engine::repo_context(&context.root)?.common_dir,
    &context.root,
  )?;
  let path = text::join(&runtime, "dispositions.json");
  let registry = match read_json(&path)? {
    Some(registry) => registry,
    None => {
      let mut empty = Object::new();
      empty.set("schema", string("causet.dispositions/v1"));
      empty.set("dispositions", Value::Array(Vec::new()));
      Value::Object(empty)
    }
  };
  let refuse = |refusal: causet_model::schemas::Refusal| {
    GitError::new(refusal.code, refusal.message).details(refusal.details)
  };
  assert_readable_schema(
    as_string(get(Some(&registry), "schema")).as_deref(),
    &format!("The disposition registry at '{path}'"),
    Some("causet.dispositions"),
    "Read it with the causet build that wrote it.",
  )
  .map_err(refuse)?;
  let Some(Value::Array(entries)) = get(Some(&registry), "dispositions") else {
    return Err(GitError::new(
      "malformed-input",
      format!("The disposition registry at '{path}' has no disposition list."),
    ));
  };
  for entry in entries {
    assert_readable_schema(
      as_string(get(Some(entry), "schema")).as_deref(),
      &format!("A disposition entry in '{path}'"),
      Some("causet.disposition"),
      "Read it with the causet build that wrote it.",
    )
    .map_err(refuse)?;
  }
  Ok(registry)
}

/// `inspectDispositions(context, diagnostics)`.
fn inspect_dispositions(context: &RepoContext, diagnostics: &mut Diagnostics) -> GitResult<Value> {
  let registry = match read_dispositions(context) {
    Ok(registry) => registry,
    Err(error) => {
      let subject = text::join(
        &runtime_directory(&context.common_dir, &context.root)?,
        "dispositions.json",
      );
      diagnostics.add(
        if error.code == "unknown-schema-version" {
          "unknown-schema"
        } else {
          "malformed-record"
        },
        "error",
        "shared-local",
        string(&subject),
        error.message,
        Vec::new(),
      );
      let mut empty = Object::new();
      empty.set("present", Value::Bool(false));
      empty.set("schema", Value::Null);
      empty.set("count", number(0));
      empty.set("dispositions", Value::Array(Vec::new()));
      return Ok(Value::Object(empty));
    }
  };
  let entries = match get(Some(&registry), "dispositions") {
    Some(Value::Array(entries)) => entries.clone(),
    _ => Vec::new(),
  };
  let mut dispositions = Vec::new();
  for entry in &entries {
    let member = |name: &str| get(Some(entry), name);
    let rejected = member("rejectedDigests");
    let mut digests: Vec<Value> = match rejected {
      value if nullish(value) => Vec::new(),
      Some(Value::Array(items)) => items.clone(),
      Some(Value::String(units)) => String::from_utf16_lossy(units)
        .chars()
        .map(|c| string(&c.to_string()))
        .collect(),
      _ => {
        return Err(GitError::uncoded(
          "(entry.rejectedDigests ?? []) is not iterable",
        ));
      }
    };
    default_sort(&mut digests);
    let mut summary = Object::new();
    summary.set("id", or_null(member("id")));
    summary.set("recordId", or_null(member("recordId")));
    summary.set("outcome", or_null(member("outcome")));
    summary.set("keptDigest", or_null(member("keptDigest")));
    summary.set("rejectedDigests", Value::Array(digests));
    summary.set("reason", or_null(member("reason")));
    summary.set("decidedAt", or_null(member("decidedAt")));
    dispositions.push(Value::Object(summary));
  }
  let mut result = Object::new();
  result.set("present", Value::Bool(!entries.is_empty()));
  result.set("schema", or_null(get(Some(&registry), "schema")));
  result.set("count", number(entries.len()));
  result.set("dispositions", Value::Array(dispositions));
  Ok(Value::Object(result))
}

/// `inspectPrivateState(context, diagnostics)`.
fn inspect_private_state(context: &RepoContext, diagnostics: &mut Diagnostics) -> GitResult<Value> {
  let root = &context.root;
  let mut paths: Vec<String> = engine::list_worktrees(root)?
    .iter()
    .map(|worktree| text::resolve_path(&worktree.path))
    .collect();
  paths.sort_by(|left, right| text::compare(left, right));
  paths.dedup();
  let mut worktrees = Vec::new();
  let mut pending_count = 0;
  let mut forecast_total = 0;
  for worktree_path in paths {
    let git_dir = if std::path::Path::new(&worktree_path).exists() {
      engine::repo_context(&worktree_path)
        .ok()
        .map(|context| context.git_dir)
    } else {
      None
    };
    let mut kinds: Vec<&str> = Vec::new();
    let mut forecasts = 0;
    if let Some(git_dir) = &git_dir {
      let runtime = runtime_directory(git_dir, root)?;
      for (kind, file) in [
        ("reconciliation", "reconciliation.json"),
        ("rebase", "rebase.json"),
      ] {
        if std::path::Path::new(&text::join(&runtime, file)).exists() {
          kinds.push(kind);
        }
      }
      let forecast_path = text::join(&runtime, "forecasts");
      if std::path::Path::new(&forecast_path).exists() {
        forecasts = std::fs::read_dir(&forecast_path)
          .map_err(|error| io_failure(&error, "scandir", &forecast_path))?
          .filter_map(Result::ok)
          .filter(|entry| {
            entry.file_type().is_ok_and(|kind| kind.is_file())
              && entry.file_name().to_string_lossy().ends_with(".json")
          })
          .count();
      }
    }
    let pending = !kinds.is_empty();
    if pending {
      pending_count += 1;
      diagnostics.add(
        "private-operation-in-progress",
        "warning",
        "worktree-private",
        string(&worktree_path),
        format!(
          "A worktree-private {} operation is in progress and will not be exported.",
          kinds.join(" and ")
        ),
        Vec::new(),
      );
    }
    forecast_total += forecasts;
    let mut entry = Object::new();
    entry.set("path", string(&worktree_path));
    entry.set("available", Value::Bool(git_dir.is_some()));
    entry.set("pendingOperation", Value::Bool(pending));
    entry.set(
      "pendingOperationKinds",
      Value::Array(kinds.iter().map(|kind| string(kind)).collect()),
    );
    entry.set("forecastCount", number(forecasts));
    worktrees.push(Value::Object(entry));
  }
  let mut result = Object::new();
  result.set("worktreeCount", number(worktrees.len()));
  result.set("pendingOperationCount", number(pending_count));
  result.set("forecastCount", number(forecast_total));
  result.set("worktrees", Value::Array(worktrees));
  Ok(Value::Object(result))
}

/// `inspectMigration(context, diagnostics)`.
fn inspect_migration(context: &RepoContext, diagnostics: &mut Diagnostics) -> GitResult<()> {
  if repository_names(&context.root)?.state == "unmigrated" {
    diagnostics.add(
      "unmigrated-repository",
      "info",
      "repository",
      string(&context.root),
      "This repository keeps its metadata under the names used before causet (refs/notes/vcs-lab, refs/vcs-lab/*). Run cst migrate --dry-run to see the move, then cst migrate.",
      Vec::new(),
    );
  }
  for entry in advanced_legacy_refs(&context.root)? {
    diagnostics.add(
      "legacy-ref-advanced",
      "warning",
      "repository",
      string(&entry.name),
      format!(
        "The former ref {} is at {}, which cst migrate did not record; a build older than causet may still publish to it. Run cst migrate again to fast-forward the new ref, or import the former side as an envelope if both moved.",
        entry.name, entry.oid
      ),
      vec![("oid", string(&entry.oid))],
    );
  }
  Ok(())
}

/// `metadataSnapshot` and `publicStatus`: the report for `schema`.
/// `metadataSnapshot({ portableOnly: true })`, reduced to what retention reads:
/// the accepted portable records with their attachments, the quarantined
/// count, and the diagnostics in the order they arose.
pub(crate) struct PortableSnapshot {
  pub records: Vec<(String, Value)>,
  pub quarantined: Value,
  pub diagnostics: Vec<Value>,
}

pub(crate) fn portable_snapshot(cwd: &str) -> GitResult<PortableSnapshot> {
  let context = engine::repo_context(cwd)?;
  with_object_session(&context.root, || -> GitResult<PortableSnapshot> {
    let mut diagnostics = Diagnostics::default();
    let parked = parked_record_ids(&context.root)?;
    let portable = validate_portable_notes(&context, &mut diagnostics, &parked)?;
    // The snapshot states the lineage, though retention does not report it.
    repository_lineage(&context.root)?;
    Ok(PortableSnapshot {
      quarantined: get(Some(&portable.notes), "quarantinedCount").cloned().unwrap_or(Value::Null),
      records: portable
        .records
        .into_iter()
        .map(|(attachment, raw, _)| (attachment, raw))
        .collect(),
      diagnostics: diagnostics.0.iter().map(Diagnostic::to_value).collect(),
    })
  })
}

/// `metadataSnapshot({ cwd })`: every scope, taken under one object session.
pub(crate) struct FullSnapshot {
  pub scopes: Value,
  diagnostics: Diagnostics,
  pub accepted: usize,
  pub quarantined: Value,
  pub lineage: Value,
  /// The accepted portable records: attachment, record, digest.
  pub records: Vec<(String, Value, String)>,
}

pub(crate) fn full_snapshot(context: &RepoContext) -> GitResult<FullSnapshot> {
  with_object_session(&context.root, || -> GitResult<FullSnapshot> {
    let mut diagnostics = Diagnostics::default();
    let parked = parked_record_ids(&context.root)?;
    let portable = validate_portable_notes(context, &mut diagnostics, &parked)?;
    let tracked = validate_specs(context, &mut diagnostics)?;
    let mut local_digests: HashMap<String, Vec<String>> = HashMap::new();
    for summary in &portable.summaries {
      if let Some(id) = as_string(get(Some(summary), "id")) {
        local_digests
          .entry(id)
          .or_default()
          .push(as_string(get(Some(summary), "digest")).unwrap_or_default());
      }
    }
    let shared = validate_shared_local(context, &mut diagnostics, &local_digests)?;
    let private = inspect_private_state(context, &mut diagnostics)?;
    inspect_migration(context, &mut diagnostics)?;
    let lineage = repository_lineage(&context.root)?;
    let quarantined = get(Some(&portable.notes), "quarantinedCount")
      .cloned()
      .unwrap_or(Value::Null);
    let mut shared_portable = Object::new();
    shared_portable.set("notes", portable.notes);
    shared_portable.set("resolutions", portable.resolutions);
    let mut scopes = Object::new();
    scopes.set("sharedPortable", Value::Object(shared_portable));
    scopes.set("trackedPortable", tracked);
    scopes.set("sharedLocal", shared);
    scopes.set("worktreePrivate", private);
    Ok(FullSnapshot {
      scopes: Value::Object(scopes),
      diagnostics,
      accepted: portable.accepted,
      quarantined,
      lineage,
      records: portable.records,
    })
  })
}

pub fn metadata_report(cwd: &str, schema: &str) -> GitResult<Value> {
  let context = engine::repo_context(cwd)?;
  let FullSnapshot { scopes, mut diagnostics, accepted, quarantined, lineage, .. } = full_snapshot(&context)?;
  diagnostics.0.sort_by(|left, right| {
    locale_compare(&left.code, &right.code)
      .then_with(|| locale_compare(left.scope, right.scope))
      .then_with(|| {
        locale_compare(
          &js_text(Some(&left.subject)),
          &js_text(Some(&right.subject)),
        )
      })
      .then_with(|| locale_compare(&left.message, &right.message))
  });
  let errors = diagnostics
    .0
    .iter()
    .filter(|item| item.severity == "error")
    .count();
  let warnings = diagnostics
    .0
    .iter()
    .filter(|item| item.severity == "warning")
    .count();
  let mut repository = Object::new();
  repository.set("root", string(&context.root));
  repository.set("objectFormat", string(&context.object_format));
  repository.set("lineage", lineage);
  let mut summary = Object::new();
  summary.set("valid", Value::Bool(errors == 0));
  summary.set("errors", number(errors));
  summary.set("warnings", number(warnings));
  summary.set("acceptedPortableRecords", number(accepted));
  summary.set("quarantinedPortableRecords", quarantined);
  let mut trust = Object::new();
  trust.set("integrityChecked", Value::Bool(true));
  trust.set("cryptographicallyTrusted", Value::Bool(false));
  trust.set("authorized", Value::Bool(false));
  trust.set(
    "statement",
    string(
      "Integrity validation does not establish actor identity, signature trust, or authorization.",
    ),
  );
  let mut report = Object::new();
  report.set("schema", string(schema));
  report.set("repository", Value::Object(repository));
  report.set("scopes", scopes);
  report.set("summary", Value::Object(summary));
  report.set(
    "diagnostics",
    Value::Array(diagnostics.0.iter().map(Diagnostic::to_value).collect()),
  );
  report.set("trust", Value::Object(trust));
  Ok(Value::Object(report))
}

/// `formatTrustState(trust)`.
pub(crate) fn trust_state(trust: Option<&Value>) -> String {
  if !matches!(trust, Some(Value::Object(_) | Value::Array(_))) {
    return "trust not reported".into();
  }
  let signed = ["cryptographicallyTrusted", "cryptographicallySigned"]
    .iter()
    .map(|name| get(trust, name))
    .find(|value| !nullish(*value))
    .flatten();
  format!(
    "{}; {}",
    if truthy(signed) {
      "signed"
    } else {
      "not signed"
    },
    if truthy(get(trust, "authorized")) {
      "authorized"
    } else {
      "not authorized"
    }
  )
}

/// `formatMetadataStatus(result, title)`.
pub fn format_metadata_status(result: &Value, title: &str) -> String {
  let at = |path: &[&str]| {
    path
      .iter()
      .fold(Some(result), |value, name| get(value, name))
  };
  let text = |path: &[&str]| js_text(at(path));
  let first_defined = |paths: &[&[&str]], fallback: &str| {
    paths
      .iter()
      .map(|path| at(path))
      .find(|value| !nullish(*value))
      .map_or(fallback.to_string(), js_text)
  };
  let mut lines = vec![
    title.to_string(),
    format!("repository   {}", text(&["repository", "root"])),
    format!("object format {}", text(&["repository", "objectFormat"])),
    format!(
      "lineage      {}",
      short(at(&["repository", "lineage", "id"]))
    ),
    format!(
      "notes        {} targets; {} accepted, {} quarantined",
      text(&["scopes", "sharedPortable", "notes", "targetCount"]),
      text(&["scopes", "sharedPortable", "notes", "acceptedCount"]),
      text(&["scopes", "sharedPortable", "notes", "quarantinedCount"])
    ),
    format!(
      "resolutions  {}/{} refs accepted",
      text(&[
        "scopes",
        "sharedPortable",
        "resolutions",
        "acceptedRefCount"
      ]),
      text(&["scopes", "sharedPortable", "resolutions", "refCount"])
    ),
    format!(
      "specs        {}/{} manifests consistent",
      text(&["scopes", "trackedPortable", "consistentCount"]),
      text(&["scopes", "trackedPortable", "manifestCount"])
    ),
    format!(
      "local        {} checkpoint refs; {} workspaces",
      first_defined(
        &[
          &["scopes", "sharedLocal", "checkpoints", "totalRefCount"],
          &["scopes", "sharedLocal", "checkpoints", "refCount"],
        ],
        "undefined"
      ),
      text(&["scopes", "sharedLocal", "workspaceRegistry", "count"])
    ),
    format!(
      "quarantine   {} parked records; {} dispositions",
      first_defined(&[&["scopes", "sharedLocal", "quarantine", "refCount"]], "0"),
      first_defined(&[&["scopes", "sharedLocal", "dispositions", "count"]], "0")
    ),
    format!(
      "private      {} operations; {} forecasts",
      text(&["scopes", "worktreePrivate", "pendingOperationCount"]),
      text(&["scopes", "worktreePrivate", "forecastCount"])
    ),
    format!(
      "diagnostics  {} errors, {} warnings",
      text(&["summary", "errors"]),
      text(&["summary", "warnings"])
    ),
    format!(
      "integrity    {}; {}",
      if truthy(at(&["summary", "valid"])) {
        "valid"
      } else {
        "invalid"
      },
      trust_state(at(&["trust"]))
    ),
  ];
  if let Some(Value::Array(parked)) = at(&["scopes", "sharedLocal", "quarantine", "records"]) {
    for entry in parked {
      let member = |name: &str| get(Some(entry), name);
      let lineage: Vec<u16> = causet_model::js::to_js_string(member("sourceLineage"));
      let count = match member("localDigests") {
        Some(Value::Array(items)) => items.len(),
        _ => 0,
      };
      lines.push(format!(
        "  # parked {} from {} disputes {count} local cop{}",
        text_of(member("recordId")),
        String::from_utf16_lossy(&lineage[..lineage.len().min(16)]),
        if count == 1 { "y" } else { "ies" }
      ));
    }
  }
  if let Some(Value::Array(diagnostics)) = at(&["diagnostics"]) {
    for diagnostic in diagnostics {
      let member = |name: &str| get(Some(diagnostic), name);
      let code = text_of(member("code"));
      let recovery = if code == "missing-attachment" {
        format!(" — {}", text_of(member("message")))
      } else {
        String::new()
      };
      lines.push(format!(
        "  {} {code}: {}{recovery}",
        if as_string(member("severity")).as_deref() == Some("error") {
          "!"
        } else {
          "?"
        },
        text_of(member("subject"))
      ));
    }
  }
  lines.join("\n")
}

fn text_of(value: Option<&Value>) -> String {
  js_text(value)
}

/// `cst metadata status` and `cst metadata validate [--strict]`, with their
/// exit codes.
pub fn metadata(subcommand: &str, strict: bool, json: bool, cwd: &str) -> GitResult<(Value, i32)> {
  if subcommand == "status" {
    let result = metadata_report(cwd, METADATA_STATUS_SCHEMA)?;
    let output = if json {
      result
    } else {
      string(&format_metadata_status(&result, "Metadata status"))
    };
    return Ok((output, 0));
  }
  let mut result = metadata_report(cwd, METADATA_VALIDATION_SCHEMA)?;
  let errors = get(get(Some(&result), "summary"), "errors").cloned();
  let warnings = get(get(Some(&result), "summary"), "warnings").cloned();
  let valid = matches!(errors, Some(Value::Number(count)) if count == 0.0)
    && (!strict || matches!(warnings, Some(Value::Number(count)) if count == 0.0));
  if let Value::Object(report) = &mut result {
    report.set("strict", Value::Bool(strict));
    if let Some(Value::Object(summary)) = report.get("summary").cloned() {
      let mut summary = summary;
      summary.set("valid", Value::Bool(valid));
      report.set("summary", Value::Object(summary));
    }
  }
  let output = if json {
    result
  } else {
    string(&format_metadata_status(&result, "Metadata validation"))
  };
  Ok((output, if valid { 0 } else { 1 }))
}
