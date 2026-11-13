//! Holds native commits to the contract's text: every native commit of
//! `docs/native-history/history-vectors.json` encodes and decodes to its
//! bytes and ID, an imported one is derived from its Git commit alone
//! (commits.md §5.2), and the lift gives each `lift` message its `changeId`
//! (§5.3).

use causet_history::commit::{Commit, derive, lift};
use causet_model::json::{self, Value};
use causet_store::id::NativeId;
use std::path::PathBuf;

fn vectors() -> Value {
  let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
    .join("../../docs/native-history/history-vectors.json");
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
    Value::Object(object) => object
      .get(name)
      .unwrap_or_else(|| panic!("no member {name}")),
    _ => panic!("not an object where {name} was expected"),
  }
}

fn optional<'a>(value: &'a Value, name: &str) -> Option<&'a Value> {
  match value {
    Value::Object(object) => object.get(name),
    _ => None,
  }
}

fn text(value: &Value) -> String {
  match value {
    Value::String(units) => json::lossy(units),
    _ => panic!("not a string"),
  }
}

fn text_or_null(value: &Value) -> Option<String> {
  match value {
    Value::Null => None,
    other => Some(text(other)),
  }
}

fn array(value: &Value) -> &[Value] {
  match value {
    Value::Array(items) => items,
    _ => panic!("not an array"),
  }
}

fn id(value: &Value) -> NativeId {
  NativeId::from_hex(&text(value)).expect("a native ID")
}

fn native_commits() -> Vec<Value> {
  array(member(&vectors(), "vectors"))
    .iter()
    .filter(|vector| text(member(vector, "object")) == "native commit")
    .cloned()
    .collect()
}

#[test]
fn every_native_commit_vector_round_trips_to_its_bytes_and_id() {
  let commits = native_commits();
  assert_eq!(commits.len(), 6);
  for vector in &commits {
    let name = text(member(vector, "name"));
    let body = unhex(&text(member(vector, "body")));
    let commit = Commit::decode(&body).unwrap_or_else(|why| panic!("{name}: {why}"));
    assert_eq!(commit.encode(), body, "{name}");
    assert_eq!(commit.id(), id(member(vector, "id")), "{name}");
  }
}

#[test]
fn an_imported_commit_is_derived_from_its_git_commit_alone() {
  let mut imported = 0;
  for vector in native_commits() {
    let Some(payload) = optional(&vector, "gitPayload") else {
      continue;
    };
    imported += 1;
    let name = text(member(&vector, "name"));
    let expected = Commit::decode(&unhex(&text(member(&vector, "body")))).unwrap();
    // What the store maps the Git commit's tree and parents to is the
    // import's; the contract fixes everything else from the payload.
    let derived = derive(
      &unhex(&text(payload)),
      id(member(&vector, "preservedId")),
      expected.tree,
      expected.parents.clone(),
    );
    assert_eq!(
      derived.encode(),
      unhex(&text(member(&vector, "body"))),
      "{name}"
    );
    let lifted = member(&vector, "lifted");
    assert_eq!(
      derived.change_id,
      text_or_null(member(lifted, "changeId")),
      "{name}"
    );
    assert_eq!(
      derived.derived_from,
      text_or_null(member(lifted, "derivedFrom")),
      "{name}"
    );
    assert_eq!(
      derived.origin_commit,
      text_or_null(member(lifted, "originCommit")),
      "{name}"
    );
  }
  assert_eq!(imported, 5);
}

#[test]
fn the_lift_gives_each_message_its_change_id() {
  let all = vectors();
  for case in array(member(&all, "lift")) {
    let message = text(member(case, "message"));
    assert_eq!(
      lift(message.as_bytes(), "Change-Id"),
      text_or_null(member(case, "changeId")),
      "{message:?}"
    );
  }
}

#[test]
fn a_body_that_breaks_a_rule_is_refused() {
  let example = native_commits()
    .into_iter()
    .find(|vector| text(member(vector, "name")) == "imported: the example commit")
    .unwrap();
  let body = unhex(&text(member(&example, "body")));
  // Form 01 holding a line that form 00 writes: each line has one encoding.
  let mut verbatim = body.clone();
  let author = 34;
  assert_eq!(verbatim[author], 0x00, "the author's form");
  let line = b"A U Thor <author@example.com> 1112911993 -0700";
  let fields_end = author + 1 + 9 + 19 + 5 + 2;
  let mut replaced = vec![0x01, line.len() as u8];
  replaced.extend_from_slice(line);
  verbatim.splice(author..fields_end, replaced);
  assert!(
    Commit::decode(&verbatim).is_err(),
    "a form 01 line form 00 writes"
  );
  // Nothing may follow the fields but the message, so a truncated body fails.
  assert!(Commit::decode(&body[..40]).is_err(), "a truncated body");
}
