//! Holds operations and views to the contract's text: every operation and
//! view of `docs/native-history/facts-vectors.json` decodes, encodes back to
//! its bytes, and has its ID (operations.md §2.2, §3.1, §6), and a body that
//! breaks §2.2's or §3.1's rules is refused.

use causet_history::action::{ActionActor, Time};
use causet_history::actor::Kind as ActorKind;
use causet_history::merge;
use causet_history::op_log;
use causet_store::id::{GitAlgorithm, Type};
use causet_store::objects::Snapshot;
use causet_store::store::{Store, StoreWriter};
use causet_history::names::{Kind, Name, Target, Value as NameValue};
use causet_history::operation::{Operation, View};
use causet_model::json::{self, Value};
use causet_store::id::NativeId;
use std::path::PathBuf;

fn vectors() -> Value {
  let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../docs/native-history/facts-vectors.json");
  let text = std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
  json::parse(&text).expect("the vectors are JSON")
}

fn unhex(text: &str) -> Vec<u8> {
  (0..text.len()).step_by(2).map(|at| u8::from_str_radix(&text[at..at + 2], 16).unwrap()).collect()
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
    Value::Array(items) => {
      items.iter().filter(|vector| text(member(vector, "object")) == object).cloned().collect()
    }
    _ => panic!("no vectors"),
  }
}

fn named(object: &str, name: &str) -> Value {
  of_kind(object).into_iter().find(|vector| text(member(vector, "name")) == name).expect(name)
}

fn native(hex: &str) -> NativeId {
  NativeId::from_hex(hex).expect("a native ID")
}

const IMPORT: &str = "f49d099ac0f5e00492724c8609ce1b5d955ee94233509392a943700322555726";
const ADA: &str = "666ae48cd59a5af1037a0797abd6a45f590c7493de198c4839def288ba7cb0b5";
const AGENT: &str = "49a1a11f14f91e6bb19d039e5faf972e1795af8611d4dcd7315e86fd9099f547";
const EXAMPLE_COMMIT: &str = "d3c30235e65ae09ed09eb0c36e8b171e33b5b318c346beaa8adbdd49e1296565";
const ADAS_COMMIT: &str = "36ed38eb3ac4beb9513896a23becb6a197364390e245514082875e5f041c51fa";

#[test]
fn every_operation_vector_round_trips_to_its_bytes_and_id() {
  let operations = of_kind("operation");
  assert_eq!(operations.len(), 4);
  for vector in &operations {
    let name = text(member(vector, "name"));
    let body = unhex(&text(member(vector, "body")));
    let operation = Operation::decode(&body).unwrap_or_else(|why| panic!("{name}: {why}"));
    assert_eq!(operation.encode(), body, "{name}");
    assert_eq!(operation.id(), native(&text(member(vector, "id"))), "{name}");
  }
}

#[test]
fn the_import_operation_holds_no_parent_actor_or_time_and_the_snapshot_names() {
  let vector = named("operation", "imported");
  let operation = Operation::decode(&unhex(&text(member(&vector, "body")))).unwrap();
  assert!(operation.parents.is_empty());
  assert_eq!(operation.actor, None);
  assert_eq!(operation.time, None);
  assert_eq!(operation.command, vec![b"import".to_vec()]);
  assert_eq!(operation.view.shared, vec![native("39deba682a85f74b9faafec22565ab90c4355eb7493f25d436cf990141a10409")]);
  assert_eq!(operation.view.local, vec![native("4ffcff81a6811eedbb80b62aef35a11eed15b5c8f5109c13f4bfc01f6c947a90")]);
  let resolved = |kind, name: &[u8], target| Name { kind, name: name.to_vec(), local: false, value: NameValue::Resolved(target) };
  assert_eq!(
    operation.view.names,
    vec![
      resolved(Kind::Branch, b"main", Target::Object(native(EXAMPLE_COMMIT))),
      resolved(Kind::Tag, b"v1", Target::Object(native("1d742c3ccb83c886824c7fcf70bfc01719a2c3c2aed3081a56923a50b7d14a67"))),
      resolved(Kind::RemoteTracking, b"origin/HEAD", Target::Name(Kind::RemoteTracking, b"origin/main".to_vec())),
      resolved(Kind::RemoteTracking, b"origin/main", Target::Object(native(EXAMPLE_COMMIT))),
    ]
  );
}

#[test]
fn an_agents_operation_records_its_actor_for_whom_and_its_command() {
  let vector = named("operation", "an agent deletes main");
  let operation = Operation::decode(&unhex(&text(member(&vector, "body")))).unwrap();
  assert_eq!(operation.parents, vec![native(IMPORT)]);
  assert_eq!(
    operation.actor,
    Some(ActionActor {
      actor: "claude-opus-5-5".into(),
      kind: Some(ActorKind::Agent),
      on_behalf_of: Some("Ada Lovelace <ada@example.com>".into()),
    })
  );
  assert_eq!(operation.time, Some(Time { seconds: 1762732950, offset: 60 }));
  assert_eq!(operation.command, vec![b"branch".to_vec(), b"--delete".to_vec(), b"main".to_vec()]);
  assert!(operation.view.names.iter().all(|name| name.name != b"main" || name.kind != Kind::Branch));
}

#[test]
fn the_merged_view_holds_main_conflicted_and_round_trips() {
  let vector = named("view", "the merged view of the two");
  let body = unhex(&text(member(&vector, "body")));
  let view = View::decode(&body).unwrap();
  assert_eq!(view.encode(), body);
  let main = view.names.iter().find(|name| name.kind == Kind::Branch && name.name == b"main").unwrap();
  assert_eq!(
    main.value,
    NameValue::Conflicted {
      adds: vec![None, Some(Target::Object(native(ADAS_COMMIT)))],
      removes: vec![Some(Target::Object(native(EXAMPLE_COMMIT)))],
    }
  );
  // Ada's operation is a side of it: its view moved main.
  let ada = Operation::decode(&unhex(&text(member(&named("operation", "Ada moves main"), "body")))).unwrap();
  assert_eq!(ada.id(), native(ADA));
  assert_eq!(ada.view.resolved(Kind::Branch, b"main"), Some(&Target::Object(native(ADAS_COMMIT))));
  assert_eq!(text(member(&vector, "base")), IMPORT);
  assert!(matches!(member(&vector, "sides"), Value::Array(sides) if sides.len() == 2 && text(&sides[0]) == AGENT));
}

#[test]
fn merging_adas_and_the_agents_operations_from_the_import_gives_the_contracts_merged_view() {
  let decode = |name: &str| Operation::decode(&unhex(&text(member(&named("operation", name), "body")))).unwrap();
  let (import, ada, agent) = (decode("imported"), decode("Ada moves main"), decode("an agent deletes main"));
  // The sides in byte order of their IDs: the agent's, then Ada's (§3.3).
  let mut reduced = Vec::new();
  let view = merge::views(&import.view, &[&agent.view, &ada.view], |heads| {
    reduced.push(heads.clone());
    Ok::<_, ()>(heads)
  })
  .unwrap();
  let expected = unhex(&text(member(&named("view", "the merged view of the two"), "body")));
  assert_eq!(view.encode(), expected);
  // Each chain's heads are the union of the sides', once each, which the
  // caller then reduces to those no other head reaches.
  assert_eq!(reduced, vec![import.view.shared.clone(), import.view.local.clone()]);
}

#[test]
fn a_store_holding_the_contracts_operations_merges_adas_and_the_agents_from_their_base_into_its_merged_view() {
  let root = std::env::temp_dir().join(format!("causet-operations-test-{}-merged", std::process::id()));
  let _ = std::fs::remove_dir_all(&root);
  let mut writer = StoreWriter::create(&root, GitAlgorithm::Sha1).unwrap();
  for name in ["imported", "Ada moves main", "an agent deletes main"] {
    writer.put_metadata(Type::Operation, &unhex(&text(member(&named("operation", name), "body")))).unwrap();
  }
  writer.finish(&Snapshot::new(GitAlgorithm::Sha1, Vec::new()).unwrap()).unwrap();
  let store = Store::open(&root).unwrap();
  // The store finds their base, the import's operation, itself.
  let view = op_log::merged(&store, &[native(ADA), native(AGENT)]).unwrap();
  assert_eq!(view.encode(), unhex(&text(member(&named("view", "the merged view of the two"), "body"))));
  let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn a_name_one_side_moved_takes_the_move_and_two_moves_to_one_target_agree() {
  let branch = |name: &str, target: &str, local: bool| Name {
    kind: Kind::Branch,
    name: name.as_bytes().to_vec(),
    local,
    value: NameValue::Resolved(Target::Object(native(target))),
  };
  let view = |names: Vec<Name>| View { shared: Vec::new(), local: Vec::new(), names };
  let base = view(vec![branch("both", EXAMPLE_COMMIT, false), branch("gone", EXAMPLE_COMMIT, false), branch("one", EXAMPLE_COMMIT, false)]);
  // One side moves `one` and marks `both` local; the other moves `both` where
  // the first did not, deletes `gone`, and adds `new`, local.
  let first = view(vec![branch("both", EXAMPLE_COMMIT, true), branch("gone", EXAMPLE_COMMIT, false), branch("one", ADAS_COMMIT, false)]);
  let second = view(vec![branch("both", ADAS_COMMIT, false), branch("new", ADAS_COMMIT, true), branch("one", EXAMPLE_COMMIT, false)]);
  let merged = merge::views(&base, &[&first, &second], Ok::<_, ()>).unwrap();
  assert_eq!(
    merged.names,
    vec![branch("both", ADAS_COMMIT, true), branch("new", ADAS_COMMIT, true), branch("one", ADAS_COMMIT, false)]
  );
  // Both sides moving a name to one target is no conflict either.
  let agreed = merge::views(&base, &[&first, &first.clone()], Ok::<_, ()>).unwrap();
  assert_eq!(agreed.names, first.names);
  // A branch the base marks local, which one side keeps local and the other
  // unmarks, takes the side that differs from the base: not local.
  let local = view(vec![branch("both", EXAMPLE_COMMIT, true)]);
  let unmarked = view(vec![branch("both", EXAMPLE_COMMIT, false)]);
  let merged = merge::views(&local, &[&local.clone(), &unmarked], Ok::<_, ()>).unwrap();
  assert_eq!(merged.names, vec![branch("both", EXAMPLE_COMMIT, false)]);
}

/// The import operation's body with its four names replaced by `names`,
/// each given as its encoded bytes.
fn import_with_names(names: &[&[u8]]) -> Vec<u8> {
  let body = unhex(&text(member(&named("operation", "imported"), "body")));
  // Everything before the names count: parents, actor, time, command and both
  // heads lists (operations.md §3.4): 1+1+1+8+34+34 bytes.
  let mut out = body[..79].to_vec();
  assert_eq!(body[79], 4, "the names count");
  out.push(names.len() as u8);
  for name in names {
    out.extend_from_slice(name);
  }
  out
}

fn object_target(hex: &str) -> Vec<u8> {
  [&[0x01, 0x01][..], &unhex(hex)].concat()
}

#[test]
fn names_that_break_the_encodings_rules_are_refused() {
  let commit = object_target(EXAMPLE_COMMIT);
  let resolved_main: Vec<u8> = [&[0x01, 0x04][..], b"main", &[0x00, 0x01], &commit].concat();
  assert!(Operation::decode(&import_with_names(&[&resolved_main])).is_ok());
  let cases: Vec<(&str, Vec<Vec<u8>>)> = vec![
    ("a single absent add", vec![[&[0x01, 0x04][..], b"main", &[0x00, 0x01, 0x00]].concat()]),
    ("an empty name", vec![[&[0x01, 0x00, 0x00, 0x01][..], &commit].concat()]),
    ("a name holding 00", vec![[&[0x01, 0x02][..], b"a\0", &[0x00, 0x01], &commit].concat()]),
    ("a local tag", vec![[&[0x02, 0x02][..], b"v1", &[0x01, 0x01], &commit].concat()]),
    ("an unknown kind", vec![[&[0x04, 0x01][..], b"x", &[0x00, 0x01], &commit].concat()]),
    (
      "a conflict whose remove equals an add",
      vec![[&[0x01, 0x04][..], b"main", &[0x00, 0x02, 0x00], &commit, &commit].concat()],
    ),
    (
      "a conflict whose adds are all one target",
      vec![[&[0x01, 0x04][..], b"main", &[0x00, 0x02], &commit, &commit, &[0x00]].concat()],
    ),
    ("names out of order", vec![resolved_main.clone(), [&[0x01, 0x01][..], b"a", &[0x00, 0x01], &commit].concat()]),
    ("a name twice", vec![resolved_main.clone(), resolved_main.clone()]),
  ];
  for (what, names) in cases {
    let names: Vec<&[u8]> = names.iter().map(Vec::as_slice).collect();
    assert!(Operation::decode(&import_with_names(&names)).is_err(), "{what} was accepted");
  }
  let mut trailing = import_with_names(&[&resolved_main]);
  trailing.push(0x00);
  assert!(Operation::decode(&trailing).is_err(), "bytes after the view were accepted");
}

#[test]
fn an_operation_with_an_actor_and_no_time_or_parents_out_of_order_is_refused() {
  let body = unhex(&text(member(&named("operation", "Ada chooses her side"), "body")));
  let operation = Operation::decode(&body).unwrap();
  assert_eq!(operation.parents, vec![native(AGENT), native(ADA)]);
  let mut swapped = operation.clone();
  swapped.parents.reverse();
  assert!(Operation::decode(&swapped.encode()).is_err(), "parents out of order were accepted");
  let mut timeless = operation;
  timeless.time = None;
  assert!(Operation::decode(&timeless.encode()).is_err(), "an actor without a time was accepted");
}
