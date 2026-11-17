//! Keeps `object_id_fields` in agreement with the published schema catalog
//! (docs/native-history/facts.md §3.2): a note record's member is an object
//! ID exactly where its family's schema gives it the object-ID pattern,
//! directly or through a `$ref`, at any depth of objects and arrays.

use causet_model::js::get;
use causet_model::json::{self, Value};
use causet_model::schemas::object_id_fields;
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

const OBJECT_ID_PATTERN: &str = "^[0-9a-fA-F]{40}$|^[0-9a-fA-F]{64}$";

fn text(value: Option<&Value>) -> Option<String> {
  match value {
    Some(Value::String(units)) => Some(json::lossy(units)),
    _ => None,
  }
}

/// Every schema document of the catalog, by `$id`.
fn catalog() -> BTreeMap<String, Value> {
  let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../docs/schemas");
  let mut documents = BTreeMap::new();
  for entry in std::fs::read_dir(&directory).unwrap() {
    let path = entry.unwrap().path();
    if !path.to_string_lossy().ends_with(".schema.json") {
      continue;
    }
    let document = json::parse(&std::fs::read_to_string(&path).unwrap()).unwrap();
    documents.insert(text(get(Some(&document), "$id")).unwrap(), document);
  }
  documents
}

/// What a `$ref` names: a JSON pointer into this document or another.
fn resolve<'a>(reference: &str, here: &'a Value, catalog: &'a BTreeMap<String, Value>) -> (&'a Value, &'a Value) {
  let (file, pointer) = reference.split_once('#').unwrap_or((reference, ""));
  let document = if file.is_empty() { here } else { &catalog[file] };
  let mut node = document;
  for part in pointer.split('/').filter(|part| !part.is_empty()) {
    node = get(Some(node), part).unwrap_or_else(|| panic!("{reference} names nothing"));
  }
  (node, document)
}

/// The dotted paths, arrays not counted, at which a schema node holds an
/// object ID.
fn walk(node: &Value, path: &str, document: &Value, catalog: &BTreeMap<String, Value>, depth: usize, found: &mut BTreeSet<String>) {
  assert!(depth < 16, "{path} nests too deep");
  if let Some(reference) = text(get(Some(node), "$ref")) {
    let (target, target_document) = resolve(&reference, document, catalog);
    return walk(target, path, target_document, catalog, depth + 1, found);
  }
  if text(get(Some(node), "pattern")).as_deref() == Some(OBJECT_ID_PATTERN) {
    found.insert(path.to_string());
    return;
  }
  for combinator in ["anyOf", "oneOf", "allOf"] {
    if let Some(Value::Array(options)) = get(Some(node), combinator) {
      for option in options {
        walk(option, path, document, catalog, depth + 1, found);
      }
    }
  }
  if let Some(Value::Object(properties)) = get(Some(node), "properties") {
    for key in properties.keys() {
      let name = json::lossy(key);
      let child = if path.is_empty() { name.clone() } else { format!("{path}.{name}") };
      walk(properties.get_units(key).unwrap(), &child, document, catalog, depth + 1, found);
    }
  }
  if let Some(items) = get(Some(node), "items") {
    walk(items, path, document, catalog, depth + 1, found);
  }
}

#[test]
fn every_note_record_familys_object_id_fields_are_those_its_published_schema_gives() {
  let catalog = catalog();
  let mut checked = 0;
  for (id, document) in &catalog {
    // The note-record families, and the disposition, the one family of the
    // local chain (facts.md §3.4).
    if text(get(Some(document), "x-causet-scope")).as_deref() != Some("note-record") && id != "causet.disposition/v1" {
      continue;
    }
    let mut found = BTreeSet::new();
    walk(document, "", document, &catalog, 0, &mut found);
    // A listing adds `attachedTo` to a record, and no note holds it.
    found.remove("attachedTo");
    let table: BTreeSet<String> = object_id_fields(id).iter().map(|field| field.to_string()).collect();
    assert_eq!(table, found, "{id}");
    checked += 1;
  }
  assert!(checked >= 12, "only {checked} note-record families");
}

#[test]
fn a_schema_this_build_does_not_know_has_no_object_id_fields() {
  assert!(object_id_fields("causet.provenance/v9").is_empty());
  // The legacy alias names the same family.
  assert_eq!(object_id_fields("vcs-lab.provenance/v1"), object_id_fields("causet.provenance/v1"));
}
