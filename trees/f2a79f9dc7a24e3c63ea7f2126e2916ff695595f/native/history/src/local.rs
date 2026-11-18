//! The local chain import writes (facts.md §5.3): the clone's own facts,
//! never exchanged. A disputed copy under `refs/causet/quarantine/` is a
//! parked fact of reason `04`, and each disposition of `dispositions.json`
//! import can take is a fact, so the copy settles what its original settled.
//! Each import writes at most one entry, with no actor and no time, which
//! brings the facts current in the chain to the original's.

use crate::fact::{Fact, Reason};
use crate::fact_log::{Entry, Scope};
use crate::notes::{object_ids, translate};
use causet_model::canonical::canonical_json;
use causet_model::js::get;
use causet_model::json::{self, Value};
use causet_model::schemas::{canonical_schema, validate_disposition};
use causet_store::id::NativeId;
use std::collections::{BTreeSet, HashMap, HashSet};

/// The parked fact of the disputed copy at the ref whose name after
/// `refs/causet/quarantine/` is `remainder`, holding `bytes`: what the ref
/// names when it is content, and nothing otherwise. A remainder that is not a
/// source lineage, `/`, and a record ID gives none, as the Git-backed reader
/// parks a record by the ref's name alone.
pub fn disputed(remainder: &[u8], bytes: Vec<u8>) -> Option<Fact> {
  let mut parts = remainder.split(|byte| *byte == b'/');
  let (Some(lineage), Some(record), None) = (parts.next(), parts.next(), parts.next()) else {
    return None;
  };
  if lineage.is_empty() || record.is_empty() {
    return None;
  }
  Some(Fact::Parked { reason: Reason::Disputed, place: remainder.to_vec(), id: Some(record.to_vec()), bytes })
}

/// The facts of a `dispositions.json` registry: one for each disposition
/// import can take by facts.md §5.2's tests, in the registry's order. A
/// registry import cannot read gives none, and so does a disposition it
/// cannot take: of a version this build does not know, invalid by its
/// schema, outside the canonical profile, or with an attachment `native`
/// does not name. Its object IDs become the native IDs of what they name.
pub fn dispositions(file: &[u8], format: &str, mut native: impl FnMut(&str) -> Option<NativeId>) -> Vec<Fact> {
  let mut facts = Vec::new();
  for entry in &valid_entries(file, format) {
    let ids = object_ids(entry);
    let mut natives: HashMap<String, NativeId> = HashMap::new();
    for (_, id) in &ids {
      if let Some(found) = native(id) {
        natives.insert(id.clone(), found);
      }
    }
    if natives.len() < ids.iter().map(|(_, id)| id).collect::<HashSet<_>>().len() {
      continue;
    }
    let mut names: Vec<NativeId> = natives.values().copied().collect();
    names.sort();
    names.dedup();
    let fields: HashSet<String> = ids.into_iter().map(|(field, _)| field).collect();
    let Ok(record) = canonical_json(&translate(entry, "", &fields, &natives)) else {
      continue;
    };
    let Some(Value::String(schema)) = get(Some(entry), "schema") else {
      continue;
    };
    facts.push(Fact::Record {
      schema: json::lossy(schema).into_bytes(),
      actor: None,
      subject: None,
      names,
      record: record.into_bytes(),
    });
  }
  facts
}

/// The dispositions of a registry that are valid by their schema and inside
/// the canonical profile, in its order: none when it cannot be read.
fn valid_entries(file: &[u8], format: &str) -> Vec<Value> {
  let Ok(registry) = json::parse(&String::from_utf8_lossy(file)) else {
    return Vec::new();
  };
  let schema = match get(Some(&registry), "schema") {
    Some(Value::String(units)) => canonical_schema(&json::lossy(units)),
    _ => return Vec::new(),
  };
  let (true, Some(Value::Array(entries))) = (schema == "causet.dispositions/v1", get(Some(&registry), "dispositions")) else {
    return Vec::new();
  };
  entries
    .iter()
    .filter(|entry| validate_disposition(Some(entry), format).is_empty() && canonical_json(entry).is_ok())
    .cloned()
    .collect()
}

/// The objects the dispositions import can take name, as Git IDs in
/// lowercase hex: roots of import's walk, as a record's are (facts.md §5.5).
/// `held` says whether the store holds an object.
pub fn disposition_roots(file: &[u8], format: &str, held: impl Fn(&str) -> bool) -> Vec<String> {
  let mut roots = Vec::new();
  for entry in &valid_entries(file, format) {
    let ids: Vec<String> = object_ids(entry).into_iter().map(|(_, id)| id).collect();
    if ids.iter().all(|id| held(id)) {
      roots.extend(ids);
    }
  }
  roots
}

/// The local chain's entry for an import, whose parents are the chain's
/// `heads` in the store it adds to and `current` the facts current at them
/// (facts.md §5.3): it adds each fact of `facts` not current there, and
/// retires each current there that `facts` leaves out, so the facts current
/// at it are the original's state. `None` when it would change nothing,
/// such as a fresh import of an original with no local facts.
pub fn local_entry(heads: &[NativeId], current: &BTreeSet<NativeId>, facts: &[Fact]) -> Option<Entry> {
  let given: BTreeSet<NativeId> = facts.iter().map(Fact::id).collect();
  let adds: Vec<NativeId> = given.difference(current).copied().collect();
  let retires: Vec<NativeId> = current.difference(&given).copied().collect();
  let mut parents = heads.to_vec();
  parents.sort();
  parents.dedup();
  (!adds.is_empty() || !retires.is_empty())
    .then(|| Entry { scope: Scope::Local, parents, adds, retires, actor: None, time: None })
}
