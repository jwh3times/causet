//! Holds facts and fact-log entries to the contract's text: every fact and
//! entry of `docs/native-history/facts-vectors.json` decodes, encodes back to
//! its bytes, and has its ID (facts.md §3, §4, §7).

use causet_history::fact::{Fact, Reason};
use causet_history::fact_log::{Entry, Scope};
use causet_model::json::{self, Value};
use causet_store::id::NativeId;
use std::path::PathBuf;

fn vectors() -> Value {
  let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
    .join("../../docs/native-history/facts-vectors.json");
  let text =
    std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
  json::parse(&text).expect("the vectors are JSON")
}

fn unhex(text: &str) -> Vec<u8> {
  (0..text.len())
    .step_by(2)
    .map(|at| u8::from_str_radix(&text[at..at + 2], 16).unwrap())
    .collect()
}

fn member<'a>(value: &'a Value, name: &str) -> &'a Value {
  match value {
    Value::Object(object) => object.get(name).unwrap_or_else(|| panic!("no member {name}")),
    _ => panic!("not an object where {name} was expected"),
  }
}

fn text(value: &Value) -> String {
  match value {
    Value::String(units) => json::lossy(units),
    _ => panic!("not a string"),
  }
}

fn of_kind(object: &str) -> Vec<Value> {
  match member(&vectors(), "vectors") {
    Value::Array(items) => items
      .iter()
      .filter(|vector| text(member(vector, "object")) == object)
      .cloned()
      .collect(),
    _ => panic!("no vectors"),
  }
}

fn id(vector: &Value) -> NativeId {
  NativeId::from_hex(&text(member(vector, "id"))).expect("a native ID")
}

#[test]
fn every_fact_vector_round_trips_to_its_bytes_and_id() {
  let facts = [of_kind("fact"), of_kind("parked fact")].concat();
  assert_eq!(facts.len(), 4);
  for vector in &facts {
    let name = text(member(vector, "name"));
    let body = unhex(&text(member(vector, "body")));
    let fact = Fact::decode(&body).unwrap_or_else(|why| panic!("{name}: {why}"));
    assert_eq!(fact.encode(), body, "{name}");
    assert_eq!(fact.id(), id(vector), "{name}");
  }
}

#[test]
fn a_fact_holds_its_schema_subject_names_and_canonical_record() {
  let vector = &of_kind("fact")[0];
  let Fact::Record { schema, actor, subject, names, record } =
    Fact::decode(&unhex(&text(member(vector, "body")))).unwrap()
  else {
    panic!("a record fact");
  };
  let native_commit = NativeId::from_hex("d3c30235e65ae09ed09eb0c36e8b171e33b5b318c346beaa8adbdd49e1296565").unwrap();
  assert_eq!(schema, b"causet.provenance/v1");
  assert_eq!(actor, None);
  assert_eq!(subject, Some(native_commit));
  assert_eq!(names, vec![native_commit]);
  // facts.md §3.5, the record, 326 bytes.
  assert_eq!(record.len(), 326);
  assert!(record.starts_with(br#"{"actors":[{"actor":"A U Thor <author@example.com>","role":"authored"}],"#));
}

#[test]
fn a_parked_fact_holds_its_reason_place_id_and_bytes() {
  let vector = &of_kind("parked fact")[0];
  let Fact::Parked { reason, place, id, bytes } = Fact::decode(&unhex(&text(member(vector, "body")))).unwrap() else {
    panic!("a parked fact");
  };
  assert_eq!(reason, Reason::Untaken);
  assert_eq!(place, b"2425d53ec1283e808c60bcaea110ba01aca5a887");
  assert_eq!(id.as_deref(), Some(&b"prov_0e79j3dxc9d8e7f6a5b4c"[..]));
  assert!(bytes.starts_with(b"{\n      \"schema\": \"causet.provenance/v9\","));
  assert!(bytes.ends_with(b"\"2005-04-07T22:14:00.000Z\"\n    }"));
}

#[test]
fn every_entry_vector_round_trips_to_its_bytes_and_id() {
  let entries = of_kind("fact-log entry");
  assert_eq!(entries.len(), 3);
  for vector in &entries {
    let name = text(member(vector, "name"));
    let body = unhex(&text(member(vector, "body")));
    let entry = Entry::decode(&body).unwrap_or_else(|why| panic!("{name}: {why}"));
    assert_eq!(entry.encode(), body, "{name}");
    assert_eq!(entry.id(), id(vector), "{name}");
  }
}

#[test]
fn the_second_notes_commits_entry_retires_the_record_its_reviewed_copy_replaces() {
  // facts.md §4.3.
  let vector = of_kind("fact-log entry")
    .into_iter()
    .find(|vector| text(member(vector, "name")) == "imported: the second notes commit")
    .unwrap();
  let entry = Entry::decode(&unhex(&text(member(&vector, "body")))).unwrap();
  let hex = |text: &str| NativeId::from_hex(text).unwrap();
  assert_eq!(entry.scope, Scope::Shared);
  assert_eq!(entry.parents, vec![hex("48485d721abf632766e5c4085e6fd4282f2cc9aebee4f3acceb2c7bf1f08fa5e")]);
  assert_eq!(entry.adds, vec![hex("ca02fe39fb7ee0c598c1fa9ce10caf584de19a00ea71568dd2f9f5f3d7da8ed5")]);
  assert_eq!(entry.retires, vec![hex("bce55fc72f7ff26d687608081068f4b9a8ca558b0fef1dcec89a7d2cf70937e2")]);
  let actor = entry.actor.expect("an actor");
  assert_eq!(actor.actor, "C O Mitter <committer@example.com>");
  assert_eq!(actor.kind, None);
  assert_eq!(actor.on_behalf_of, None);
  let time = entry.time.expect("a time");
  assert_eq!((time.seconds, time.offset), (1112912200, -420));
}

#[test]
fn bodies_that_break_the_rules_are_refused() {
  // A state that is no state; a parked fact of reason 00.
  assert!(Fact::decode(&[0x02]).is_err());
  assert!(Fact::decode(&[0x01, 0x00, 0x00, 0x00]).is_err());
  // An entry of scope 03, and one whose adds are out of order.
  assert!(Entry::decode(&[0x03, 0x00, 0x00, 0x00, 0x00, 0x00]).is_err());
  let a = NativeId([1; 32]);
  let b = NativeId([2; 32]);
  let mut body = vec![0x01, 0x00, 0x02];
  b.put(&mut body);
  a.put(&mut body);
  body.extend_from_slice(&[0x00, 0x00, 0x00]);
  assert!(Entry::decode(&body).is_err());
}

mod current {
  use super::*;
  use causet_history::fact_log::State;
  use std::collections::{BTreeSet, HashMap};

  fn fact(n: u8) -> NativeId {
    NativeId([n; 32])
  }

  /// A log of entries by ID, each given its parents, adds and retires.
  struct Log(HashMap<NativeId, Entry>);

  impl Log {
    fn new() -> Log {
      Log(HashMap::new())
    }

    fn entry(&mut self, parents: &[NativeId], adds: &[NativeId], retires: &[NativeId]) -> NativeId {
      let sorted = |ids: &[NativeId]| {
        let mut ids = ids.to_vec();
        ids.sort();
        ids
      };
      let entry = Entry {
        scope: Scope::Shared,
        parents: sorted(parents),
        adds: sorted(adds),
        retires: sorted(retires),
        actor: None,
        time: None,
      };
      let id = entry.id();
      self.0.insert(id, entry);
      id
    }

    fn current(&self, heads: &[NativeId]) -> BTreeSet<NativeId> {
      State::at(heads, |id| Ok::<_, String>(self.0[id].clone())).unwrap().current()
    }
  }

  #[test]
  fn the_vectors_reviewed_copy_replaces_the_record_and_the_parked_fact_stays() {
    // facts.md §4.3: at the second entry, the reviewed copy and the parked
    // fact are current, and the record of §3.5 is not.
    let entries: HashMap<NativeId, Entry> = of_kind("fact-log entry")
      .iter()
      .map(|vector| (id(vector), Entry::decode(&unhex(&text(member(vector, "body")))).unwrap()))
      .collect();
    let hex = |text: &str| NativeId::from_hex(text).unwrap();
    let second = hex("39deba682a85f74b9faafec22565ab90c4355eb7493f25d436cf990141a10409");
    let first = hex("48485d721abf632766e5c4085e6fd4282f2cc9aebee4f3acceb2c7bf1f08fa5e");
    let current = |head: NativeId| State::at(&[head], |id| Ok::<_, String>(entries[id].clone())).unwrap().current();
    let record = hex("bce55fc72f7ff26d687608081068f4b9a8ca558b0fef1dcec89a7d2cf70937e2");
    let reviewed = hex("ca02fe39fb7ee0c598c1fa9ce10caf584de19a00ea71568dd2f9f5f3d7da8ed5");
    let parked = id(&of_kind("parked fact")[0]);
    assert_eq!(current(first), BTreeSet::from([record, parked]));
    assert_eq!(current(second), BTreeSet::from([reviewed, parked]));
  }

  #[test]
  fn an_add_concurrent_with_a_retire_survives_the_join() {
    let mut log = Log::new();
    let base = log.entry(&[], &[fact(1)], &[]);
    let retired = log.entry(&[base], &[], &[fact(1)]);
    // Another chain adds fact 1 too, with no entry that retires it among its
    // ancestors: the retire never saw this add.
    let concurrent = log.entry(&[], &[fact(1), fact(2)], &[]);
    assert_eq!(log.current(&[retired]), BTreeSet::new());
    assert_eq!(log.current(&[retired, concurrent]), BTreeSet::from([fact(1), fact(2)]));
    let join = log.entry(&[retired, concurrent], &[], &[]);
    assert_eq!(log.current(&[join]), BTreeSet::from([fact(1), fact(2)]));
    // A retire after the join has seen both adds, and removes both.
    let after = log.entry(&[join], &[], &[fact(1)]);
    assert_eq!(log.current(&[after]), BTreeSet::from([fact(2)]));
  }

  #[test]
  fn a_join_never_brings_back_a_fact_one_side_retired_and_the_other_kept() {
    let mut log = Log::new();
    let base = log.entry(&[], &[fact(1), fact(2)], &[]);
    let retired = log.entry(&[base], &[], &[fact(1)]);
    let kept = log.entry(&[base], &[fact(3)], &[]);
    assert_eq!(log.current(&[retired, kept]), BTreeSet::from([fact(2), fact(3)]));
    let join = log.entry(&[retired, kept], &[], &[]);
    assert_eq!(log.current(&[join]), BTreeSet::from([fact(2), fact(3)]));
  }

  #[test]
  fn a_head_that_is_an_ancestor_of_another_changes_nothing() {
    let mut log = Log::new();
    let base = log.entry(&[], &[fact(1)], &[]);
    let next = log.entry(&[base], &[], &[fact(1)]);
    assert_eq!(log.current(&[base, next]), BTreeSet::new());
  }
}
