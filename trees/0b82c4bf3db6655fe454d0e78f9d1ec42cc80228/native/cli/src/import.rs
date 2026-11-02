//! `cst metadata import <directory> --dry-run|--apply [--park-conflicts]`:
//! `importMetadata` of `src/metadata-transfer.js`, with the parking of
//! `src/quarantine.js` (ADR-0030).

use crate::envelope::read_envelope_parts;
use crate::export::{build_notes_commit, group_records, resolve_against, temporary_directory};
use crate::lineage::{lineage_relation, repository_lineage};
use crate::metadata::{full_snapshot, inspection_records, read_dispositions, trust_state};
use crate::notes_write::{build_note_tree, build_retention_commit, checked_ref_update, commit_with_parents, record_dependencies, with_notes_lock};
use causet_engine::errors::{GitError, GitResult};
use causet_engine::locations::{CURRENT_NAMES, local_ref, names, ref_family};
use causet_engine::process::{RunOptions, run_git};
use causet_engine::{engine, metrics, text};
use causet_model::canonical::legacy_canonical_json;
use causet_model::js::{get, nullish, same_value_zero, strict_equals, text as js_text, to_js_string};
use causet_model::json::{Object, Value, lossy, parse, string, stringify, stringify_pretty};
use causet_model::schemas::{canonical_schema, referenced_objects, within_bound};

const NOTE_CONTAINER_SCHEMA: &str = "causet.note/v1";
const PARKED_RECORD_SCHEMA: &str = "causet.quarantined-record/v1";

fn sha256(bytes: &[u8]) -> String {
  causet_model::sha256::hex(bytes)
}

fn git(args: &[&str], cwd: &str) -> GitResult<String> {
  let args: Vec<String> = args.iter().map(|arg| (*arg).to_string()).collect();
  Ok(run_git(&args, &RunOptions::new(cwd))?.stdout)
}

fn member<'a>(value: &'a Value, name: &str) -> Option<&'a Value> {
  get(Some(value), name)
}

fn or_null(value: Option<&Value>) -> Value {
  value.cloned().unwrap_or(Value::Null)
}

fn number(value: usize) -> Value {
  Value::Number(value as f64)
}

/// `{ ...object, name: value }` for a JSON object.
fn with(object: &Value, members: Vec<(&str, Value)>) -> Value {
  let mut copy = match object {
    Value::Object(object) => object.clone(),
    _ => Object::new(),
  };
  for (name, value) in members {
    copy.set(name, value);
  }
  Value::Object(copy)
}

/// The envelope as `localizeEnvelope` leaves it: refs under this repository's names.
struct Envelope {
  directory: String,
  manifest: Value,
  bundle_path: Option<String>,
  refs: Vec<Value>,
}

/// One incoming record: its attachment, the record, and its digest.
type Entry = (String, Value, String);

/// `requiredObjectClaims(records)`: `(oid, type, record id, field)`.
fn required_object_claims(records: &[Entry]) -> Vec<(String, &'static str, Value, String)> {
  let mut required = Vec::new();
  for (attachment, record, _) in records {
    let resolution = js_text(member(record, "type")) == "resolution"
      && matches!(member(record, "type"), Some(Value::String(_)));
    let id = or_null(member(record, "id"));
    if !resolution {
      required.push((attachment.clone(), "commit", id.clone(), "attachment".to_string()));
    }
    for reference in referenced_objects(Some(record)) {
      if resolution && matches!(reference.field.as_str(), "resolutionCommit" | "resultBlob") {
        continue;
      }
      required.push((lossy(&reference.oid), reference.kind, id.clone(), reference.field.clone()));
    }
  }
  required
}

/// `destinationObjectProblems(records, cwd, providedObjects)`.
fn destination_object_problems(records: &[Entry], cwd: &str, provided: &[String]) -> GitResult<Vec<Value>> {
  let required = required_object_claims(records);
  let mut unique: Vec<String> = Vec::new();
  for (oid, ..) in &required {
    if !unique.contains(oid) {
      unique.push(oid.clone());
    }
  }
  text::sort(&mut unique);
  let objects = if unique.is_empty() {
    Vec::new()
  } else {
    engine::read_git_objects(&unique, cwd)?.records
  };
  let mut problems = Vec::new();
  for (oid, kind, record, field) in required {
    if provided.contains(&format!("{kind}:{oid}")) {
      continue;
    }
    let present = unique
      .iter()
      .position(|known| *known == oid)
      .and_then(|index| objects.get(index))
      .is_some_and(|object| object.exists && object.kind.as_deref() == Some(kind));
    if !present {
      let mut problem = Object::new();
      problem.set("code", string("missing-referenced-object"));
      problem.set("record", record);
      problem.set("field", string(&field));
      problem.set("oid", string(&oid));
      problem.set("expectedType", string(kind));
      problems.push(Value::Object(problem));
    }
  }
  Ok(problems)
}

/// `manifestRecordSummary(entry)`.
fn record_summary((attachment, record, digest): &Entry) -> Value {
  let resolution = js_text(member(record, "type")) == "resolution"
    && matches!(member(record, "type"), Some(Value::String(_)));
  let mut summary = Object::new();
  summary.set("attachment", string(attachment));
  for name in ["id", "schema", "type"] {
    if let Some(value) = member(record, name) {
      summary.set(name, value.clone());
    }
  }
  summary.set("digest", string(digest));
  summary.set("ref", if resolution { or_null(member(record, "ref")) } else { Value::Null });
  summary.set("resultBlob", if resolution { or_null(member(record, "resultBlob")) } else { Value::Null });
  Value::Object(summary)
}

struct Incoming {
  records: Vec<Entry>,
  refs: Vec<Value>,
  provided: Vec<String>,
}

/// `inspectEnvelopePayload(envelope)`: the payload fetched into an empty
/// repository and checked against the manifest.
fn inspect_envelope_payload(envelope: &Envelope) -> GitResult<Incoming> {
  let Some(bundle_path) = &envelope.bundle_path else {
    return Ok(Incoming { records: Vec::new(), refs: Vec::new(), provided: Vec::new() });
  };
  let object_format = js_text(member(&envelope.manifest, "repository").and_then(|repository| get(Some(repository), "objectFormat")));
  let parent = temporary_directory("vlab-envelope-inspect-")?;
  let result = (|| -> GitResult<Incoming> {
    let repo = text::join(&parent, "repo");
    std::fs::create_dir(&repo).map_err(|error| crate::envelope::io_failure(&error, "mkdir", &repo))?;
    git(&["init", "-b", "main", &format!("--object-format={object_format}")], &repo)?;
    git(&["config", "user.name", "causet metadata inspector"], &repo)?;
    git(&["config", "user.email", "metadata-inspector@example.invalid"], &repo)?;
    let refspecs: Vec<String> = envelope
      .refs
      .iter()
      .map(|entry| format!("{}:{}", js_text(member(entry, "bundleRef")), js_text(member(entry, "ref"))))
      .collect();
    let mut args = vec!["fetch", "--no-tags", bundle_path.as_str()];
    args.extend(refspecs.iter().map(String::as_str));
    git(&args, &repo)?;
    let records = inspection_records(&repo)?;
    let actual = Value::Array(records.iter().map(record_summary).collect());
    let declared = or_null(member(&envelope.manifest, "records"));
    if legacy_canonical_json(&actual) != legacy_canonical_json(&declared) {
      return Err(GitError::new(
        "malformed-input",
        "Metadata envelope record inventory does not match its Git payload.",
      ));
    }
    let unavailable: Vec<String> = destination_object_problems(&records, &repo, &[])?
      .iter()
      .map(|problem| format!("{}:{}", js_text(member(problem, "expectedType")), js_text(member(problem, "oid"))))
      .collect();
    for entry in &envelope.refs {
      let name = js_text(member(entry, "ref"));
      let target = engine::ref_target(&name, &repo)?;
      if !strict_equals(target.as_deref().map(string).as_ref(), member(entry, "oid")) {
        return Err(GitError::new(
          "malformed-input",
          format!("Metadata envelope ref '{name}' does not match its manifest."),
        ));
      }
    }
    let provided = required_object_claims(&records)
      .into_iter()
      .map(|(oid, kind, ..)| format!("{kind}:{oid}"))
      .filter(|key| !unavailable.contains(key))
      .collect();
    Ok(Incoming { records, refs: envelope.refs.clone(), provided })
  })();
  let _ = std::fs::remove_dir_all(&parent);
  result
}

/// `rejectedDigests(cwd)`: the digests a person has rejected, by record id.
fn rejected_digests(cwd: &str) -> GitResult<Vec<(Value, Vec<Value>)>> {
  let context = engine::repo_context(cwd)?;
  let registry = read_dispositions(&context)?;
  let mut by_record: Vec<(Value, Vec<Value>)> = Vec::new();
  if let Some(Value::Array(entries)) = member(&registry, "dispositions") {
    for entry in entries {
      let digests: Vec<Value> = match member(entry, "rejectedDigests") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(items)) => items.clone(),
        Some(Value::String(units)) => units.iter().map(|unit| Value::String(vec![*unit])).collect(),
        Some(value @ (Value::Number(_) | Value::Bool(_))) => {
          let kind = if matches!(value, Value::Number(_)) { "number" } else { "boolean" };
          return Err(GitError::uncoded(format!(
            "{kind} {} is not iterable (cannot read property Symbol(Symbol.iterator))",
            js_text(Some(value))
          )));
        }
        Some(_) => {
          return Err(GitError::uncoded(
            "object is not iterable (cannot read property Symbol(Symbol.iterator))",
          ));
        }
      };
      let id = or_null(member(entry, "recordId"));
      match by_record.iter_mut().find(|(known, _)| same_value_zero(Some(known), Some(&id))) {
        Some((_, known)) => {
          for digest in digests {
            if !known.iter().any(|item| same_value_zero(Some(item), Some(&digest))) {
              known.push(digest);
            }
          }
        }
        None => {
          let mut unique: Vec<Value> = Vec::new();
          for digest in digests {
            if !unique.iter().any(|item| same_value_zero(Some(item), Some(&digest))) {
              unique.push(digest);
            }
          }
          by_record.push((id, unique));
        }
      }
    }
  }
  Ok(by_record)
}

/// `importPreview(envelope, incoming, cwd, { parkConflicts })`.
fn import_preview(envelope: &Envelope, incoming: &Incoming, cwd: &str, park_conflicts: bool) -> GitResult<Value> {
  let context = engine::repo_context(cwd)?;
  let notes_ref = names(cwd)?.notes_ref;
  let manifest = &envelope.manifest;
  let repository = member(manifest, "repository");
  let declared_format = get(repository, "objectFormat");
  if !strict_equals(declared_format, Some(&string(&context.object_format))) {
    return Err(GitError::new(
      "unsupported-repository-shape",
      format!(
        "Envelope object format '{}' is incompatible with '{}'.",
        js_text(declared_format),
        context.object_format
      ),
    ));
  }
  let destination_lineage = repository_lineage(cwd)?;
  let relation = lineage_relation(get(repository, "lineage"), Some(&destination_lineage))?;
  if !matches!(relation, "same" | "fork") {
    return Err(GitError::new(
      "unsupported-repository-shape",
      format!("Metadata envelope lineage is {relation}; v1 import requires a shared root commit."),
    ));
  }
  let destination = full_snapshot(&context)?;
  let mut local_digests: Vec<(String, Vec<String>)> = Vec::new();
  let summaries = get(get(get(Some(&destination.scopes), "sharedPortable"), "notes"), "records");
  if let Some(Value::Array(summaries)) = summaries {
    for summary in summaries {
      let Some(Value::String(id)) = member(summary, "id") else {
        continue;
      };
      let id = lossy(id);
      let digest = js_text(member(summary, "digest"));
      match local_digests.iter_mut().find(|(known, _)| *known == id) {
        Some((_, digests)) => digests.push(digest),
        None => local_digests.push((id, vec![digest])),
      }
    }
  }
  let disposed = rejected_digests(cwd)?;

  let mut ref_states: Vec<(String, Value, Option<String>, &'static str)> = Vec::new();
  for entry in &incoming.refs {
    let name = js_text(member(entry, "ref"));
    let current = engine::ref_target(&name, cwd)?;
    let oid = or_null(member(entry, "oid"));
    let action = if name == notes_ref {
      if current.is_none() { "create" } else { "pending-records" }
    } else if strict_equals(current.as_deref().map(string).as_ref(), Some(&oid)) {
      "noop"
    } else if current.is_none() {
      "create"
    } else if park_conflicts {
      "refuse"
    } else {
      "conflict"
    };
    ref_states.push((name, oid, current, action));
  }
  let refused: Vec<String> = ref_states
    .iter()
    .filter(|(.., action)| *action == "refuse")
    .map(|(name, ..)| name.clone())
    .collect();

  let mut records = Vec::new();
  for (attachment, record, digest) in &incoming.records {
    let id = member(record, "id");
    let local: Vec<String> = match id {
      Some(Value::String(units)) => local_digests
        .iter()
        .find(|(known, _)| *known == lossy(units))
        .map(|(_, digests)| digests.clone())
        .unwrap_or_default(),
      _ => Vec::new(),
    };
    let record_ref = member(record, "ref");
    let refused_ref = match record_ref {
      Some(Value::String(units)) => refused.contains(&local_ref(&lossy(units), cwd)?),
      _ => false,
    };
    let action = if refused_ref {
      "park"
    } else if local.is_empty() {
      "add"
    } else if local.contains(digest) {
      "noop"
    } else if disposed
      .iter()
      .find(|(known, _)| same_value_zero(Some(known), id))
      .is_some_and(|(_, digests)| digests.iter().any(|item| strict_equals(Some(item), Some(&string(digest)))))
    {
      "disposed"
    } else if park_conflicts {
      "park"
    } else {
      "conflict"
    };
    let mut sorted = local.clone();
    text::sort(&mut sorted);
    let mut summary = Object::new();
    for name in ["id", "schema", "type"] {
      if let Some(value) = member(record, name) {
        summary.set(name, value.clone());
      }
    }
    summary.set("attachment", string(attachment));
    summary.set("digest", string(digest));
    summary.set("action", string(action));
    summary.set("localDigests", Value::Array(sorted.iter().map(|item| string(item)).collect()));
    records.push(Value::Object(summary));
  }
  let action_of = |entry: &Value| js_text(member(entry, "action"));
  let has_adds = records.iter().any(|entry| action_of(entry) == "add");
  let refs: Vec<Value> = ref_states
    .iter()
    .map(|(name, oid, current, action)| {
      let action = match *action {
        "pending-records" => {
          if has_adds { "merge" } else { "noop" }
        }
        other => other,
      };
      let mut entry = Object::new();
      entry.set("ref", string(name));
      entry.set("incoming", oid.clone());
      entry.set("existing", current.as_deref().map_or(Value::Null, string));
      entry.set("action", string(action));
      Value::Object(entry)
    })
    .collect();
  let object_problems = destination_object_problems(&incoming.records, cwd, &incoming.provided)?;
  let count = |items: &[Value], action: &str| items.iter().filter(|entry| action_of(entry) == action).count();
  let conflicts = count(&records, "conflict") + count(&refs, "conflict") + object_problems.len();

  let mut repository_summary = Object::new();
  repository_summary.set("objectFormat", string(&context.object_format));
  repository_summary.set("lineageRelation", string(relation));
  repository_summary.set("sourceLineage", or_null(get(get(repository, "lineage"), "id")));
  repository_summary.set("destinationLineage", or_null(member(&destination_lineage, "id")));
  let mut summary = Object::new();
  summary.set("addRecords", number(count(&records, "add")));
  summary.set("noopRecords", number(count(&records, "noop")));
  summary.set("parkRecords", number(count(&records, "park")));
  summary.set("disposedRecords", number(count(&records, "disposed")));
  summary.set("createRefs", number(count(&refs, "create")));
  summary.set("mergeRefs", number(count(&refs, "merge")));
  summary.set("noopRefs", number(count(&refs, "noop")));
  summary.set("refusedRefs", number(count(&refs, "refuse")));
  summary.set("conflicts", number(conflicts));
  summary.set("applicable", Value::Bool(conflicts == 0));
  let mut preview = Object::new();
  preview.set("schema", string("causet.metadata-import-preview/v1"));
  preview.set("path", string(&envelope.directory));
  preview.set("mode", string(if park_conflicts { "park-conflicts" } else { "refuse-conflicts" }));
  preview.set("repository", Value::Object(repository_summary));
  preview.set("records", Value::Array(records));
  preview.set("refs", Value::Array(refs));
  preview.set("objectProblems", Value::Array(object_problems));
  preview.set("summary", Value::Object(summary));
  if let Some(exclusions) = member(manifest, "excludedScopes") {
    preview.set("exclusions", exclusions.clone());
  }
  if let Some(trust) = member(manifest, "trust") {
    preview.set("trust", trust.clone());
  }
  Ok(Value::Object(preview))
}

/// `readRecordsFromNoteRef(ref, attachment, cwd)`.
fn read_records_from_note_ref(name: &str, attachment: &str, cwd: &str) -> GitResult<Vec<Value>> {
  let Some(note) = engine::read_note_text(name, attachment, cwd)?.filter(|note| !note.is_empty()) else {
    return Ok(Vec::new());
  };
  let parsed = parse(&note).map_err(|_| {
    GitError::new("malformed-input", format!("Cannot merge malformed existing note on '{attachment}'."))
  })?;
  let schema = match member(&parsed, "schema") {
    Some(Value::String(units)) => Some(canonical_schema(&lossy(units))),
    _ => None,
  };
  match (schema.as_deref(), member(&parsed, "records")) {
    (Some(NOTE_CONTAINER_SCHEMA), Some(Value::Array(records))) => Ok(records.clone()),
    _ => Err(GitError::new(
      "unknown-schema-version",
      format!("Cannot merge unsupported existing note on '{attachment}'."),
    )),
  }
}

/// `record.id ?? \`anonymous:${sha256(canonicalJson(record))}\``.
fn record_key(record: &Value) -> GitResult<Value> {
  if matches!(record, Value::Null) {
    return Err(GitError::uncoded("Cannot read properties of null (reading 'id')"));
  }
  Ok(match member(record, "id") {
    Some(id) if !nullish(Some(id)) => id.clone(),
    _ => string(&format!("anonymous:{}", sha256(legacy_canonical_json(record).as_bytes()))),
  })
}

/// `combineNoteEntries(existingRef, incomingEntries, cwd)`.
fn combine_note_entries(existing_ref: &str, incoming: &[(String, Value)], cwd: &str) -> GitResult<Vec<(String, Value)>> {
  let mut combined = Vec::new();
  for (attachment, records) in group_records(incoming) {
    let existing = read_records_from_note_ref(existing_ref, &attachment, cwd)?;
    let mut by_id: Vec<(Value, Value)> = Vec::new();
    let put = |by_id: &mut Vec<(Value, Value)>, key: Value, record: Value| {
      match by_id.iter_mut().find(|(known, _)| same_value_zero(Some(known), Some(&key))) {
        Some(entry) => entry.1 = record,
        None => by_id.push((key, record)),
      }
    };
    for record in existing {
      let key = record_key(&record)?;
      put(&mut by_id, key, record);
    }
    for record in records {
      let key = record_key(&record)?;
      let prior = by_id
        .iter()
        .find(|(known, _)| same_value_zero(Some(known), Some(&key)))
        .map(|(_, prior)| prior.clone());
      match prior {
        Some(prior) => {
          if legacy_canonical_json(&prior) != legacy_canonical_json(&record) {
            let named = match member(&record, "id") {
              Some(id) if !nullish(Some(id)) => lossy(&to_js_string(Some(id))),
              _ => lossy(&to_js_string(Some(&key))),
            };
            return Err(GitError::new(
              "identity-conflict",
              format!("Metadata record '{named}' conflicts during note merge."),
            ));
          }
        }
        None => put(&mut by_id, key, record),
      }
    }
    for (_, record) in by_id {
      combined.push((attachment.clone(), record));
    }
  }
  Ok(combined)
}

fn safe_delete_ref(name: &str, cwd: &str) {
  if engine::ref_exists(name, cwd).unwrap_or(false) {
    let mut options = RunOptions::new(cwd);
    options.allow_failure = true;
    let _ = run_git(&["update-ref".to_string(), "-d".to_string(), name.to_string()], &options);
  }
}

struct Staged {
  name: String,
  oid: String,
  stage_ref: String,
}

/// `stageEnvelopeRefs(envelope, cwd)`.
fn stage_envelope_refs(envelope: &Envelope, cwd: &str) -> GitResult<Vec<Staged>> {
  let hash = js_text(get(get(Some(&envelope.manifest), "integrity"), "manifestHash"));
  let stage_id = format!("{}-{}", &sha256(hash.as_bytes())[..16], std::process::id());
  let staged: Vec<Staged> = envelope
    .refs
    .iter()
    .enumerate()
    .map(|(index, entry)| Staged {
      name: js_text(member(entry, "ref")),
      oid: js_text(member(entry, "oid")),
      stage_ref: format!("{}/import-staging/{stage_id}/{index:04}", CURRENT_NAMES.refs_root),
    })
    .collect();
  for entry in &staged {
    if engine::ref_exists(&entry.stage_ref, cwd)? {
      return Err(GitError::new(
        "already-exists",
        format!("Import staging ref already exists: '{}'.", entry.stage_ref),
      ));
    }
  }
  let bundle = envelope.bundle_path.clone().unwrap_or_default();
  let refspecs: Vec<String> = envelope
    .refs
    .iter()
    .zip(&staged)
    .map(|(entry, stage)| format!("{}:{}", js_text(member(entry, "bundleRef")), stage.stage_ref))
    .collect();
  let mut args = vec!["fetch", "--no-tags", bundle.as_str()];
  args.extend(refspecs.iter().map(String::as_str));
  git(&args, cwd)?;
  for entry in &staged {
    if engine::ref_target(&entry.stage_ref, cwd)?.as_deref() != Some(entry.oid.as_str()) {
      return Err(GitError::new(
        "stale-input",
        format!("Staged metadata ref '{}' changed during import.", entry.name),
      ));
    }
  }
  Ok(staged)
}

/// `assertRefComponent(value, subject)`.
fn assert_ref_component(value: Option<&Value>, subject: &str) -> GitResult<String> {
  let valid = match value {
    Some(Value::String(units)) => {
      let text = lossy(units);
      !text.is_empty()
        && text.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
        && !text.contains("..")
        && !text.ends_with(".lock")
        && text.encode_utf16().count() == units.len()
    }
    _ => false,
  };
  if !valid {
    return Err(GitError::new(
      "malformed-input",
      format!(
        "Cannot park a record: the {subject} {} is not a single ref name component.",
        stringify(&or_null(value))
      ),
    ));
  }
  Ok(js_text(value))
}

struct ParkedStage {
  name: String,
  oid: String,
  existed: bool,
  payload: Value,
}

/// `stageParkedRecords(parked, envelope, preview, cwd)`.
fn stage_parked_records(parked: &[Entry], envelope: &Envelope, preview: &Value, cwd: &str) -> GitResult<Vec<ParkedStage>> {
  let source_lineage = or_null(get(member(preview, "repository"), "sourceLineage"));
  let envelope_hash = or_null(get(get(Some(&envelope.manifest), "integrity"), "manifestHash"));
  let summaries = match member(preview, "records") {
    Some(Value::Array(items)) => items.clone(),
    _ => Vec::new(),
  };
  let mut staged = Vec::new();
  for (attachment, record, digest) in parked {
    let local = summaries
      .iter()
      .find(|summary| strict_equals(member(summary, "id"), member(record, "id")) && js_text(member(summary, "digest")) == *digest)
      .and_then(|summary| member(summary, "localDigests").cloned())
      .unwrap_or(Value::Null);
    let mut payload = Object::new();
    payload.set("schema", string(PARKED_RECORD_SCHEMA));
    if let Some(id) = member(record, "id") {
      payload.set("recordId", id.clone());
    }
    payload.set("digest", string(digest));
    payload.set("attachment", string(attachment));
    payload.set("sourceLineage", source_lineage.clone());
    payload.set("envelopeHash", envelope_hash.clone());
    payload.set("disputedLocalDigests", local);
    payload.set("parkedAt", string(&metrics::iso_now()));
    payload.set("record", record.clone());
    let payload = Value::Object(payload);
    let lineage = assert_ref_component(member(&payload, "sourceLineage"), "source lineage")?;
    let id = assert_ref_component(member(&payload, "recordId"), "record identifier")?;
    let name = format!("{}/{lineage}/{id}", ref_family("quarantine", cwd)?);
    let body = format!("{}\n", stringify_pretty(&payload));
    if !within_bound("noteContainerBytes", body.len() as u64) {
      let limit = causet_model::registry::RESOURCE_BOUNDS
        .iter()
        .find(|(bound, _)| *bound == "noteContainerBytes")
        .map_or(0, |(_, limit)| *limit);
      return Err(GitError::new(
        "resource-bound-exceeded",
        format!("Parking record '{id}' would exceed the noteContainerBytes bound of {limit}."),
      ));
    }
    let mut options = RunOptions::new(cwd);
    options.input = Some(body.into_bytes());
    let oid = run_git(&["hash-object".to_string(), "-w".to_string(), "--stdin".to_string()], &options)?.stdout;
    let existed = engine::ref_exists(&name, cwd)?;
    staged.push(ParkedStage { name, oid, existed, payload });
  }
  Ok(staged)
}

fn unchanged(preview: &Value) -> Value {
  with(
    preview,
    vec![
      ("schema", string("causet.metadata-import/v1")),
      ("applied", Value::Bool(true)),
      ("changed", Value::Bool(false)),
    ],
  )
}

/// `applyImport(envelope, incoming, preview, cwd)`.
fn apply_import(envelope: &Envelope, incoming: &Incoming, preview: &Value, cwd: &str) -> GitResult<Value> {
  let repository = names(cwd)?;
  let notes_ref = repository.notes_ref;
  let resolution_prefix = format!("{}/", ref_family("resolutions", cwd)?);
  let retention_ref = ref_family("retention", cwd)?;
  let summary = member(preview, "summary");
  let summary_count = |name: &str| match get(summary, name) {
    Some(Value::Number(number)) => *number,
    _ => 0.0,
  };
  if !matches!(get(summary, "applicable"), Some(Value::Bool(true))) {
    return Err(GitError::new(
      "conflict-blocked",
      "Metadata import has conflicts; no destination refs were changed.",
    ));
  }
  if envelope.bundle_path.is_none() || incoming.refs.is_empty() {
    return Ok(unchanged(preview));
  }
  // `partitionIncoming(incoming, preview)`.
  let summaries = match member(preview, "records") {
    Some(Value::Array(items)) => items.clone(),
    _ => Vec::new(),
  };
  let action_for = |record: &Value, digest: &str| {
    summaries
      .iter()
      .rev()
      .find(|summary| {
        lossy(&to_js_string(member(summary, "id"))) == lossy(&to_js_string(member(record, "id")))
          && js_text(member(summary, "digest")) == digest
      })
      .map(|summary| js_text(member(summary, "action")))
  };
  let mut applied: Vec<(String, Value)> = Vec::new();
  let mut parked: Vec<Entry> = Vec::new();
  for (attachment, record, digest) in &incoming.records {
    match action_for(record, digest).as_deref() {
      Some("park") => parked.push((attachment.clone(), record.clone(), digest.clone())),
      Some("disposed") => {}
      _ => applied.push((attachment.clone(), record.clone())),
    }
  }
  if summary_count("addRecords") == 0.0
    && summary_count("createRefs") == 0.0
    && summary_count("mergeRefs") == 0.0
    && summary_count("parkRecords") == 0.0
  {
    return Ok(unchanged(preview));
  }
  let staged = stage_envelope_refs(envelope, cwd)?;
  let parked_stage = stage_parked_records(&parked, envelope, preview, cwd)?;
  let outcome = with_notes_lock(cwd, || -> GitResult<()> {
    let mut commands = vec!["start".to_string()];
    let notes_stage = staged.iter().find(|entry| entry.name == notes_ref);
    let existing_notes = engine::ref_target(notes_ref, cwd)?;
    let existing_retention = engine::ref_target(&retention_ref, cwd)?;
    if let Some(stage) = notes_stage {
      if parked.is_empty() && existing_notes.is_none() {
        commands.push(format!("create {notes_ref} {}", stage.oid));
      } else {
        let combined = combine_note_entries(notes_ref, &applied, cwd)?;
        let existing_tree = match &existing_notes {
          Some(_) => Some(engine::tree_id(notes_ref, cwd)?),
          None => None,
        };
        let manifest_hash = js_text(get(get(Some(&envelope.manifest), "integrity"), "manifestHash"));
        let message = format!("Import causet metadata {}", manifest_hash.chars().take(16).collect::<String>());
        let parents: Vec<String> = match &existing_notes {
          Some(existing) => vec![existing.clone(), stage.oid.clone()],
          None => vec![stage.oid.clone()],
        };
        let (tree, commit) = if existing_notes.is_some() {
          let mut tree = format!("{notes_ref}^{{tree}}");
          for (attachment, records) in group_records(&combined) {
            let mut note = Object::new();
            note.set("schema", string(NOTE_CONTAINER_SCHEMA));
            note.set("records", Value::Array(records));
            tree = build_note_tree(&note, &attachment, Some(&tree), cwd)?;
          }
          let commit = commit_with_parents(&tree, &parents, cwd, &message, &[])?;
          (tree, commit)
        } else {
          build_notes_commit(&combined, cwd, &message, &parents, false)?
        };
        if Some(&tree) != existing_tree.as_ref() {
          commands.push(match &existing_notes {
            Some(existing) => format!("update {notes_ref} {commit} {existing}"),
            None => format!("create {notes_ref} {commit}"),
          });
        }
      }
    }
    for entry in &parked_stage {
      commands.push(if entry.existed {
        format!("update {} {}", entry.name, entry.oid)
      } else {
        format!("create {} {}", entry.name, entry.oid)
      });
    }
    let refused: Vec<String> = match member(preview, "refs") {
      Some(Value::Array(items)) => items
        .iter()
        .filter(|item| js_text(member(item, "action")) == "refuse")
        .map(|item| js_text(member(item, "ref")))
        .collect(),
      _ => Vec::new(),
    };
    for entry in staged.iter().filter(|entry| entry.name.starts_with(&resolution_prefix)) {
      match engine::ref_target(&entry.name, cwd)? {
        None => commands.push(format!("create {} {}", entry.name, entry.oid)),
        Some(current) if current != entry.oid && !refused.contains(&entry.name) => {
          return Err(GitError::new(
            "stale-input",
            format!("Resolution ref '{}' changed or conflicts during import.", entry.name),
          ));
        }
        Some(_) => {}
      }
    }
    let records: Vec<(String, Value)> = incoming
      .records
      .iter()
      .map(|(attachment, record, _)| (attachment.clone(), record.clone()))
      .collect();
    let dependencies = record_dependencies(&records, cwd, true)?;
    let retained = build_retention_commit(&dependencies, existing_retention.as_deref(), cwd, "causet object retention", &[])?;
    commands.push(checked_ref_update(&retention_ref, &retained, existing_retention.as_deref()));
    let publishes_notes = commands.iter().any(|command| {
      command.starts_with(&format!("create {notes_ref} ")) || command.starts_with(&format!("update {notes_ref} "))
    });
    if !publishes_notes {
      let zero = "0".repeat(if engine::repo_context(cwd)?.object_format == "sha256" { 64 } else { 40 });
      commands.push(format!("verify {notes_ref} {}", existing_notes.as_deref().unwrap_or(&zero)));
    }
    for entry in &staged {
      commands.push(format!("delete {} {}", entry.stage_ref, entry.oid));
    }
    commands.push("prepare".into());
    commands.push("commit".into());
    let mut options = RunOptions::new(cwd);
    options.input = Some(format!("{}\n", commands.join("\n")).into_bytes());
    run_git(&["update-ref".to_string(), "--stdin".to_string()], &options)?;
    Ok(())
  });
  if let Err(error) = outcome {
    for entry in &staged {
      safe_delete_ref(&entry.stage_ref, cwd);
    }
    return Err(error);
  }
  let changed = summary_count("addRecords") > 0.0
    || summary_count("createRefs") > 0.0
    || summary_count("mergeRefs") > 0.0
    || summary_count("parkRecords") > 0.0;
  let parked_value = Value::Array(
    parked_stage
      .iter()
      .map(|entry| {
        let mut object = Object::new();
        object.set("ref", string(&entry.name));
        object.set("recordId", or_null(member(&entry.payload, "recordId")));
        object.set("digest", or_null(member(&entry.payload, "digest")));
        object.set("sourceLineage", or_null(member(&entry.payload, "sourceLineage")));
        Value::Object(object)
      })
      .collect(),
  );
  Ok(with(
    preview,
    vec![
      ("schema", string("causet.metadata-import/v1")),
      ("applied", Value::Bool(true)),
      ("changed", Value::Bool(changed)),
      ("parked", parked_value),
    ],
  ))
}

/// `importMetadata(envelopePath, { dryRun, apply, parkConflicts })`.
pub fn import_metadata(envelope_path: &str, dry_run: bool, apply: bool, park_conflicts: bool, cwd: &str) -> GitResult<Value> {
  if dry_run == apply {
    return Err(GitError::new(
      "usage-conflicting-options",
      "Choose exactly one of --dry-run or --apply for metadata import.",
    ));
  }
  let collector = metrics::begin("metadata-import");
  let outcome = (|| -> GitResult<(Value, Value)> {
    let parts = read_envelope_parts(&resolve_against(cwd, envelope_path))?;
    // `localizeEnvelope`: refs under this repository's own names.
    let refs = match member(&parts.manifest, "refs") {
      Some(Value::Array(items)) => items
        .iter()
        .map(|entry| -> GitResult<Value> {
          match member(entry, "ref") {
            Some(Value::String(units)) => Ok(with(entry, vec![("ref", string(&local_ref(&lossy(units), cwd)?))])),
            _ => Ok(entry.clone()),
          }
        })
        .collect::<GitResult<Vec<Value>>>()?,
      _ => Vec::new(),
    };
    let envelope = Envelope {
      directory: parts.directory,
      manifest: parts.manifest,
      bundle_path: parts.bundle_path,
      refs,
    };
    let incoming = inspect_envelope_payload(&envelope)?;
    let preview = import_preview(&envelope, &incoming, cwd, park_conflicts)?;
    let result = if dry_run {
      preview
    } else {
      apply_import(&envelope, &incoming, &preview, cwd)?
    };
    let bytes = match get(member(&envelope.manifest, "payload"), "bytes") {
      None | Some(Value::Null) => Value::Number(0.0),
      Some(value) => value.clone(),
    };
    Ok((result, bytes))
  })();
  let git_metrics = metrics::end(collector).to_value();
  let (result, bytes) = outcome?;
  let mut block = Object::new();
  block.set("payloadBytes", bytes);
  block.set("git", git_metrics);
  Ok(with(&result, vec![("metrics", Value::Object(block))]))
}

/// `formatMetadataTransfer(result)` for an import.
pub fn format_import(result: &Value, cwd: &str) -> GitResult<String> {
  let summary = member(result, "summary");
  let count = |name: &str| js_text(get(summary, name));
  let number_of = |name: &str| match get(summary, name) {
    Some(Value::Number(number)) => *number,
    _ => 0.0,
  };
  let mode = match member(result, "mode") {
    None | Some(Value::Null) => "refuse-conflicts".to_string(),
    value => js_text(value),
  };
  let mut lines = vec![
    if causet_model::js::truthy(member(result, "applied")) {
      "Metadata import applied".to_string()
    } else {
      "Metadata import preview".to_string()
    },
    format!("path         {}", js_text(member(result, "path"))),
    format!("mode         {mode}"),
    format!("lineage      {}", js_text(get(member(result, "repository"), "lineageRelation"))),
    format!("records      {} add, {} unchanged", count("addRecords"), count("noopRecords")),
    format!(
      "refs         {} create, {} merge, {} unchanged",
      count("createRefs"),
      count("mergeRefs"),
      count("noopRefs")
    ),
    format!("conflicts    {}", count("conflicts")),
  ];
  if number_of("parkRecords") != 0.0 {
    let parked = number_of("parkRecords");
    lines.push(format!(
      "parked       {} conflicting record{} under {}",
      count("parkRecords"),
      if parked == 1.0 { "" } else { "s" },
      ref_family("quarantine", cwd)?
    ));
    if let Some(Value::Array(records)) = member(result, "records") {
      for entry in records.iter().filter(|entry| js_text(member(entry, "action")) == "park") {
        lines.push(format!(
          "  ! {} disputes the local copy; resolve it with cst metadata dispose",
          js_text(member(entry, "id"))
        ));
      }
    }
  }
  if number_of("disposedRecords") != 0.0 {
    let disposed = number_of("disposedRecords");
    lines.push(format!(
      "disposed     {} record{} already rejected here; not parked again",
      count("disposedRecords"),
      if disposed == 1.0 { "" } else { "s" }
    ));
  }
  lines.push(format!(
    "applicable   {}",
    if causet_model::js::truthy(get(summary, "applicable")) { "yes" } else { "no" }
  ));
  lines.push(format!("trust        integrity only; {}", trust_state(member(result, "trust"))));
  Ok(lines.join("\n"))
}

/// Whether the import exits 1: `!result.summary.applicable`.
pub fn import_failed(result: &Value) -> bool {
  !causet_model::js::truthy(get(member(result, "summary"), "applicable"))
}
