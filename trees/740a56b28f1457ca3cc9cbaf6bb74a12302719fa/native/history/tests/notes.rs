//! How a notes tree's notes become facts (facts.md §5.2): each record a fact
//! when import can take it, with its object IDs translated to native ones,
//! and a parked fact for a note it cannot read, a record it cannot take, and
//! a repeated copy.

use causet_history::fact::{Fact, Reason};
use causet_history::notes::{Note, facts_of_notes};
use causet_model::json::{self, Value};
use causet_store::id::NativeId;
use std::path::PathBuf;

fn vectors() -> Value {
  let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
    .join("../../docs/native-history/facts-vectors.json");
  json::parse(&std::fs::read_to_string(path).unwrap()).unwrap()
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
    _ => panic!("not an object"),
  }
}

fn text(value: &Value) -> String {
  match value {
    Value::String(units) => json::lossy(units),
    _ => panic!("not a string"),
  }
}

fn items(value: &Value) -> &[Value] {
  match value {
    Value::Array(items) => items,
    _ => panic!("not an array"),
  }
}

/// The vector of this name's ID.
fn vector_id(name: &str) -> NativeId {
  let vector = items(member(&vectors(), "vectors"))
    .iter()
    .find(|vector| text(member(vector, "name")) == name)
    .unwrap_or_else(|| panic!("no vector {name}"))
    .clone();
  NativeId::from_hex(&text(member(&vector, "id"))).unwrap()
}

/// The note on the example commit at the given notes commit (1 or 2).
fn vector_note(commit: f64) -> (String, Vec<u8>) {
  let note = items(member(&vectors(), "notes"))
    .iter()
    .find(|note| matches!(member(note, "commit"), Value::Number(n) if *n == commit))
    .unwrap()
    .clone();
  (text(member(&note, "attachment")), unhex(&text(member(&note, "blob"))))
}

const EXAMPLE_GIT: &str = "2425d53ec1283e808c60bcaea110ba01aca5a887";
const EXAMPLE_NATIVE: &str = "d3c30235e65ae09ed09eb0c36e8b171e33b5b318c346beaa8adbdd49e1296565";

/// The store of the example: its commit, and nothing else.
fn held(git: &str) -> Option<NativeId> {
  (git == EXAMPLE_GIT).then(|| NativeId::from_hex(EXAMPLE_NATIVE).unwrap())
}

fn ids(facts: &[Fact]) -> Vec<NativeId> {
  let mut ids: Vec<NativeId> = facts.iter().map(Fact::id).collect();
  ids.sort();
  ids
}

fn sorted(mut ids: Vec<NativeId>) -> Vec<NativeId> {
  ids.sort();
  ids
}

#[test]
fn the_vectors_notes_give_the_vectors_facts() {
  let (attachment, first) = vector_note(1.0);
  let facts = facts_of_notes(&[Note { attachment: attachment.clone(), bytes: Some(first) }], "sha1", held);
  assert_eq!(
    ids(&facts),
    sorted(vec![vector_id("a provenance record"), vector_id("parked: a record of an unknown version")])
  );
  let (_, second) = vector_note(2.0);
  let facts = facts_of_notes(&[Note { attachment, bytes: Some(second) }], "sha1", held);
  assert_eq!(
    ids(&facts),
    sorted(vec![vector_id("the provenance record, replaced"), vector_id("parked: a record of an unknown version")])
  );
}

fn container(records: &str) -> Vec<u8> {
  format!("{{\"schema\":\"causet.note/v1\",\"records\":[{records}]}}").into_bytes()
}

fn provenance(id: &str, commit: &str) -> String {
  format!(
    r#"{{"schema":"causet.provenance/v1","type":"provenance","id":"{id}","commit":"{commit}","changeId":null,"actors":[{{"role":"authored","actor":"A U Thor <author@example.com>"}}],"origin":"declared","carriedFrom":[],"createdAt":"2005-04-07T22:13:13.000Z"}}"#
  )
}

fn parked(facts: &[Fact]) -> Vec<(Reason, Vec<u8>, Option<Vec<u8>>, Vec<u8>)> {
  facts
    .iter()
    .filter_map(|fact| match fact {
      Fact::Parked { reason, place, id, bytes } => Some((*reason, place.clone(), id.clone(), bytes.clone())),
      Fact::Record { .. } => None,
    })
    .collect()
}

#[test]
fn a_note_import_cannot_read_is_one_parked_fact_holding_it_whole() {
  let place = EXAMPLE_GIT.as_bytes().to_vec();
  for bytes in [&b"not json at all"[..], b"{\"schema\":\"causet.other/v1\",\"records\":[]}", b"[1,2]", b""] {
    let facts = facts_of_notes(&[Note { attachment: EXAMPLE_GIT.into(), bytes: Some(bytes.to_vec()) }], "sha1", held);
    assert_eq!(parked(&facts), vec![(Reason::Unreadable, place.clone(), None, bytes.to_vec())], "{}", String::from_utf8_lossy(bytes));
    assert_eq!(facts.len(), 1);
  }
  // A note that is not content holds nothing.
  let facts = facts_of_notes(&[Note { attachment: EXAMPLE_GIT.into(), bytes: None }], "sha1", held);
  assert_eq!(parked(&facts), vec![(Reason::Unreadable, place, None, Vec::new())]);
}

#[test]
fn a_record_import_cannot_take_is_parked_with_its_text_as_the_note_holds_it() {
  let missing = "0123456789abcdef0123456789abcdef01234567";
  let unheld = provenance("prov_unheld", missing);
  let invalid = r#"{ "schema" : "causet.provenance/v1", "type": "provenance", "id": "prov_invalid" }"#;
  let not_canonical = r#"{"schema":"causet.provenance/v1","id":"prov_fraction","n":1.5}"#;
  let note = container(&format!("{unheld}, {invalid},{not_canonical}"));
  let facts = facts_of_notes(&[Note { attachment: EXAMPLE_GIT.into(), bytes: Some(note) }], "sha1", held);
  let place = EXAMPLE_GIT.as_bytes().to_vec();
  assert_eq!(
    parked(&facts),
    vec![
      (Reason::Untaken, place.clone(), Some(b"prov_unheld".to_vec()), unheld.into_bytes()),
      (Reason::Untaken, place.clone(), Some(b"prov_invalid".to_vec()), invalid.as_bytes().to_vec()),
      (Reason::Untaken, place, Some(b"prov_fraction".to_vec()), not_canonical.as_bytes().to_vec()),
    ]
  );
  assert_eq!(facts.len(), 3);
}

#[test]
fn a_record_that_repeats_an_earlier_ones_fact_also_gives_a_parked_copy() {
  let record = provenance("prov_twice", EXAMPLE_GIT);
  // The same record again, in other text: its members reordered and spaced.
  let again = r#"{ "id": "prov_twice", "schema": "causet.provenance/v1", "type": "provenance", "commit": "2425d53ec1283e808c60bcaea110ba01aca5a887", "changeId": null, "actors": [{"actor": "A U Thor <author@example.com>", "role": "authored"}], "origin": "declared", "carriedFrom": [], "createdAt": "2005-04-07T22:13:13.000Z" }"#;
  let note = container(&format!("{record},{again}"));
  let facts = facts_of_notes(&[Note { attachment: EXAMPLE_GIT.into(), bytes: Some(note) }], "sha1", held);
  assert_eq!(
    parked(&facts),
    vec![(Reason::Repeated, EXAMPLE_GIT.as_bytes().to_vec(), Some(b"prov_twice".to_vec()), again.as_bytes().to_vec())]
  );
  assert_eq!(facts.len(), 2);
}

#[test]
fn a_records_object_ids_become_native_ids_and_its_names() {
  let note = container(&provenance("prov_x", EXAMPLE_GIT));
  let facts = facts_of_notes(&[Note { attachment: EXAMPLE_GIT.into(), bytes: Some(note) }], "sha1", held);
  let [Fact::Record { schema, actor, subject, names, record }] = facts.as_slice() else {
    panic!("one record fact");
  };
  let native = NativeId::from_hex(EXAMPLE_NATIVE).unwrap();
  assert_eq!(schema, b"causet.provenance/v1");
  assert_eq!(*actor, None);
  assert_eq!(*subject, Some(native));
  assert_eq!(*names, vec![native]);
  assert_eq!(
    String::from_utf8(record.clone()).unwrap(),
    format!(
      r#"{{"actors":[{{"actor":"A U Thor <author@example.com>","role":"authored"}}],"carriedFrom":[],"changeId":null,"commit":"{EXAMPLE_NATIVE}","createdAt":"2005-04-07T22:13:13.000Z","id":"prov_x","origin":"declared","schema":"causet.provenance/v1","type":"provenance"}}"#
    )
  );
}

#[test]
fn the_commits_taken_records_name_are_roots_but_a_resolutions_carrier_is_not() {
  let base = "1111111111111111111111111111111111111111";
  let carrier = "2222222222222222222222222222222222222222";
  let blob = "3333333333333333333333333333333333333333";
  let unheld = "4444444444444444444444444444444444444444";
  let held = |id: &str| [EXAMPLE_GIT, base, carrier, blob].contains(&id);
  let carried = format!(
    r#"{{"schema":"causet.provenance/v1","type":"provenance","id":"prov_carried","commit":"{EXAMPLE_GIT}","changeId":null,"actors":[{{"role":"authored","actor":"A U Thor <author@example.com>"}}],"origin":"carried","carriedFrom":["{base}"],"createdAt":"2005-04-07T22:13:13.000Z"}}"#
  );
  let unheld_record = provenance("prov_unheld", unheld);
  let note = container(&format!("{carried},{unheld_record}"));
  let mut roots = causet_history::notes::roots_of_notes(&[Note { attachment: EXAMPLE_GIT.into(), bytes: Some(note) }], "sha1", held);
  roots.sort();
  assert_eq!(roots, vec![base.to_string(), EXAMPLE_GIT.to_string()]);
  let sig = "ab".repeat(32);
  let stage = format!(r#"{{"path":"f","mode":"100644","blob":"{blob}"}}"#);
  let resolution = format!(
    r#"{{"schema":"causet.resolution/v1","type":"resolution","id":"res_x","path":"f","algorithm":"ordered-three-way-blobs/v1","signature":"rsig_{sig}","base":{stage},"ours":{stage},"theirs":{stage},"resultBlob":"{blob}","resolutionCommit":"{carrier}","ref":"refs/causet/resolutions/x","createdAt":"2005-04-07T22:13:13.000Z"}}"#
  );
  let notes = [Note { attachment: carrier.into(), bytes: Some(container(&resolution)) }];
  // The record is one import takes, so no root is missing for want of that.
  let facts = facts_of_notes(&notes, "sha1", |id: &str| held(id).then(|| NativeId::of(causet_store::id::Type::Content, id.as_bytes())));
  assert!(matches!(facts.as_slice(), [Fact::Record { .. }]), "{facts:?}");
  // Its blobs are roots too, which import leaves out as no commits; its
  // carrier commit is not.
  let roots = causet_history::notes::roots_of_notes(&notes, "sha1", held);
  assert!(!roots.is_empty() && roots.iter().all(|root| root == blob), "{roots:?}");
}

#[test]
fn a_notes_commits_entry_takes_its_committer_as_its_actor_and_time() {
  // facts.md §4.3: the second notes commit, committed at 1112912200 -0700.
  let payload = b"tree 0000000000000000000000000000000000000000\nauthor A U Thor <author@example.com> 1112912100 -0700\ncommitter C O Mitter <committer@example.com> 1112912200 -0700\n\nNotes added by 'git notes add'\n";
  let (actor, time) = causet_history::notes::notes_commit_action(payload);
  let actor = actor.unwrap();
  assert_eq!((actor.actor.as_str(), actor.kind, actor.on_behalf_of), ("C O Mitter <committer@example.com>", None, None));
  let time = time.unwrap();
  assert_eq!((time.seconds, time.offset), (1112912200, -420));
  // A line not in form 00 gives the actor and no time; no line gives neither.
  let (actor, time) = causet_history::notes::notes_commit_action(b"tree 0\ncommitter C O Mitter <committer@example.com> soon\n\nx\n");
  assert_eq!((actor.map(|actor| actor.actor), time), (Some("C O Mitter <committer@example.com>".to_string()), None));
  assert_eq!(causet_history::notes::notes_commit_action(b"tree 0\n\nx\n"), (None, None));
}

#[test]
fn a_records_object_ids_are_every_field_its_published_schema_marks() {
  // facts.md §3.2: the schema decides, nested arrays of objects included.
  let record = json::parse(
    r#"{"schema":"causet.reconciliation/v6","id":"reconcile_x","sourceHead":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","forkedSourceCommits":["bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"],"applied":[{"sourceCommit":"cccccccccccccccccccccccccccccccccccccccc","appliedCommit":"dddddddddddddddddddddddddddddddddddddddd","note":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"}],"sourceRef":"ffffffffffffffffffffffffffffffffffffffff"}"#,
  )
  .unwrap();
  let mut ids = causet_history::notes::object_ids(&record);
  ids.sort();
  let pair = |field: &str, byte: char| (field.to_string(), byte.to_string().repeat(40));
  assert_eq!(
    ids,
    vec![
      pair("applied.appliedCommit", 'd'),
      pair("applied.sourceCommit", 'c'),
      pair("forkedSourceCommits", 'b'),
      pair("sourceHead", 'a'),
    ]
  );
}
