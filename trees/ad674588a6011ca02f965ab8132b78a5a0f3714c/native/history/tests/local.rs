//! The local chain import writes (facts.md §5.3): a parked fact of reason
//! `04` for each disputed copy under `refs/causet/quarantine/`, a fact for
//! each disposition of `dispositions.json` import can take, and one entry
//! with no parents that adds them all, held to the reference vectors.

use causet_history::fact::{Fact, Reason};
use causet_history::fact_log::Scope;
use causet_history::local::{disputed, dispositions, local_entry};
use causet_model::json::{self, Value};
use causet_store::id::NativeId;
use std::collections::BTreeSet;
use std::path::PathBuf;

fn vectors() -> Value {
  let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../docs/native-history/facts-vectors.json");
  json::parse(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn member<'a>(value: &'a Value, name: &str) -> &'a Value {
  causet_model::js::get(Some(value), name).unwrap_or_else(|| panic!("no member {name}"))
}

fn text(value: &Value) -> String {
  match value {
    Value::String(units) => json::lossy(units),
    _ => panic!("not a string"),
  }
}

fn vector(name: &str) -> Value {
  let all = vectors();
  let Value::Array(items) = member(&all, "vectors") else { panic!("no vectors") };
  items.iter().find(|vector| text(member(vector, "name")) == name).cloned().unwrap()
}

const ATTACHMENT: &str = "2425d53ec1283e808c60bcaea110ba01aca5a887";
const NATIVE_COMMIT: &str = "d3c30235e65ae09ed09eb0c36e8b171e33b5b318c346beaa8adbdd49e1296565";

/// The example's native commit for its Git commit, and nothing else.
fn native(id: &str) -> Option<NativeId> {
  (id == ATTACHMENT).then(|| NativeId::from_hex(NATIVE_COMMIT).unwrap())
}

/// A `causet.dispositions/v1` registry holding `entries`, as cst writes one.
fn registry(entries: &[Value]) -> Vec<u8> {
  let file = json::object([
    ("schema", json::string("causet.dispositions/v1")),
    ("dispositions", Value::Array(entries.to_vec())),
  ]);
  format!("{}\n", json::stringify_pretty(&file)).into_bytes()
}

fn the_disposition() -> Value {
  member(&vector("a disposition"), "record").clone()
}

fn with(record: &Value, name: &str, value: Value) -> Value {
  let Value::Object(object) = record else { panic!("an object") };
  let mut object = object.clone();
  object.set(name, value);
  Value::Object(object)
}

#[test]
fn a_disposition_becomes_the_vectors_fact_and_the_local_entry_adds_it() {
  let facts = dispositions(&registry(&[the_disposition()]), "sha1", native);
  let expected = vector("a disposition");
  assert_eq!(facts.len(), 1);
  assert_eq!(facts[0].id().hex(), text(member(&expected, "id")));
  assert_eq!(facts[0].scope(), Scope::Local);
  let entry = local_entry(&[], &BTreeSet::new(), &facts).expect("an entry");
  assert_eq!(entry.id().hex(), text(member(&vector("imported: the local facts"), "id")));
  assert_eq!(entry.scope, Scope::Local);
  assert!(entry.parents.is_empty() && entry.retires.is_empty() && entry.actor.is_none() && entry.time.is_none());
}

#[test]
fn a_disputed_copy_is_a_parked_fact_of_reason_04_at_its_lineage_and_record_id() {
  let fact = disputed(b"lineage_abc/prov_0e79j2dns3a1b2c3d4e5f", b"{\"parked\":true}".to_vec()).expect("a fact");
  assert_eq!(
    fact,
    Fact::Parked {
      reason: Reason::Disputed,
      place: b"lineage_abc/prov_0e79j2dns3a1b2c3d4e5f".to_vec(),
      id: Some(b"prov_0e79j2dns3a1b2c3d4e5f".to_vec()),
      bytes: b"{\"parked\":true}".to_vec(),
    }
  );
  assert_eq!(fact.scope(), Scope::Local);
  // A ref whose remainder is not a lineage and a record ID is snapshot only.
  for other in [&b"lineage_abc"[..], b"lineage_abc/prov/x", b"/prov_x", b"lineage_abc/"] {
    assert_eq!(disputed(other, Vec::new()), None, "{}", String::from_utf8_lossy(other));
  }
}

#[test]
fn a_disposition_import_cannot_take_gives_nothing_and_the_others_stay() {
  let good = the_disposition();
  let unknown_version = with(&good, "schema", json::string("causet.disposition/v9"));
  let invalid = with(&good, "outcome", json::string("keep-both"));
  let unheld = with(&good, "attachment", json::string(&"ab".repeat(20)));
  // Valid by its schema, which admits other members, and outside the
  // canonical profile.
  let fraction = with(&good, "weight", Value::Number(0.5));
  assert!(causet_model::schemas::validate_disposition(Some(&fraction), "sha1").is_empty());
  let facts = dispositions(&registry(&[unknown_version, invalid, unheld, fraction, good]), "sha1", native);
  assert_eq!(facts.len(), 1);
  assert_eq!(facts[0].id().hex(), text(member(&vector("a disposition"), "id")));
}

#[test]
fn a_registry_import_cannot_read_gives_no_facts_and_no_entry() {
  let not_json = b"{ not json".to_vec();
  let other_schema = br#"{"schema":"causet.dispositions/v9","dispositions":[]}"#.to_vec();
  let no_list = br#"{"schema":"causet.dispositions/v1"}"#.to_vec();
  for file in [not_json, other_schema, no_list] {
    let facts = dispositions(&file, "sha1", native);
    assert!(facts.is_empty(), "{}", String::from_utf8_lossy(&file));
  }
  assert_eq!(local_entry(&[], &BTreeSet::new(), &[]), None);
}

#[test]
fn a_later_import_retires_what_the_original_settled_and_adds_what_is_new() {
  let settled = disputed(b"lineage_abc/prov_a", b"{}".to_vec()).unwrap();
  let open = disputed(b"lineage_abc/prov_b", b"{}".to_vec()).unwrap();
  let decided = dispositions(&registry(&[the_disposition()]), "sha1", native).remove(0);
  let head = NativeId([7; 32]);
  let current: BTreeSet<NativeId> = [settled.id(), open.id()].into_iter().collect();
  // The first dispute was settled: its copy is gone, and a disposition says how.
  let entry = local_entry(&[head], &current, &[open.clone(), decided.clone()]).expect("an entry");
  assert_eq!(entry.parents, vec![head]);
  assert_eq!(entry.adds, vec![decided.id()]);
  assert_eq!(entry.retires, vec![settled.id()]);
  // An import that finds the same state writes nothing.
  assert_eq!(local_entry(&[head], &current, &[settled, open]), None);
}
