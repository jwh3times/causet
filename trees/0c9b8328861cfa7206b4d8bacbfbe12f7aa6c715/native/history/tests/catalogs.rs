//! The derived catalogs (ADR-0047 decision 14): change ID to commits, object
//! to the current facts naming it, and logical ID to the current facts
//! carrying it. Each is derived from the objects alone, kept under
//! `.cst/catalogs/`, rebuilt when missing, and rebuilt, not trusted, when it
//! disagrees with the objects (#421).

use causet_history::actor::{Actor, Role};
use causet_history::catalog::Catalogs;
use causet_history::commit::Commit;
use causet_history::fact::{Fact, Reason};
use causet_history::fact_log::{Entry, Scope};
use causet_history::signature::Signature;
use causet_store::id::{GitAlgorithm, NativeId, Type};
use causet_store::objects::{Snapshot, Tree};
use causet_store::store::{Store, StoreWriter};
use std::path::{Path, PathBuf};

fn scratch(name: &str) -> PathBuf {
  let directory =
    std::env::temp_dir().join(format!("causet-catalog-test-{}-{name}", std::process::id()));
  let _ = std::fs::remove_dir_all(&directory);
  directory
}

fn no_refs() -> Snapshot {
  Snapshot::new(GitAlgorithm::Sha1, Vec::new()).unwrap()
}

fn signature(time: u64) -> Signature {
  Signature::Fields { name: b"A U Thor".to_vec(), email: b"author@example.com".to_vec(), time, offset: 0 }
}

fn commit(tree: NativeId, parents: Vec<NativeId>, change: Option<&str>, time: u64) -> Commit {
  Commit {
    tree,
    parents,
    author: signature(time),
    committer: signature(time),
    encoding: None,
    actors: vec![Actor { role: Role::Authored, actor: "A U Thor <author@example.com>".to_string(), kind: None, on_behalf_of: None }],
    change_id: change.map(str::to_string),
    derived_from: None,
    origin_commit: None,
    preserved: None,
    message: format!("commit at {time}\n").into_bytes(),
  }
}

/// A record fact: `names` holds the subject and whatever else it names.
fn record(schema: &str, logical: &str, subject: Option<NativeId>, mut names: Vec<NativeId>) -> Fact {
  names.sort();
  names.dedup();
  let target = subject.map(|id| id.hex()).unwrap_or_default();
  Fact::Record {
    schema: schema.as_bytes().to_vec(),
    actor: None,
    subject,
    names,
    record: format!("{{\"commit\":\"{target}\",\"id\":\"{logical}\",\"schema\":\"{schema}\"}}").into_bytes(),
  }
}

fn entry(scope: Scope, parents: Vec<NativeId>, mut adds: Vec<NativeId>, mut retires: Vec<NativeId>) -> Entry {
  adds.sort();
  retires.sort();
  Entry { scope, parents, adds, retires, actor: None, time: None }
}

fn sorted(mut ids: Vec<NativeId>) -> Vec<NativeId> {
  ids.sort();
  ids
}

/// What a small store holds, by name.
struct Held {
  root: PathBuf,
  a: NativeId,
  b: NativeId,
  c: NativeId,
  d: NativeId,
  reviewed: NativeId,
  landed: NativeId,
  disposition: NativeId,
  disputed: NativeId,
  /// The shared chain's one head, its second entry.
  shared_head: NativeId,
}

impl Drop for Held {
  fn drop(&mut self) {
    let _ = std::fs::remove_dir_all(&self.root);
  }
}

/// Four commits, two of them one change rebased; a shared chain of two
/// entries, the second retiring a fact the first added; and a local chain
/// with a disposition and a disputed copy of the reviewed record.
fn small_store(name: &str) -> Held {
  let root = scratch(name);
  let mut writer = StoreWriter::create(&root, GitAlgorithm::Sha1).unwrap();
  let tree = writer.put_tree(&Tree::from_entries(Vec::new()).unwrap(), b"").unwrap();
  let put_commit = |writer: &mut StoreWriter, commit: Commit| writer.put_native_commit(&commit.encode()).unwrap();
  let a = put_commit(&mut writer, commit(tree, Vec::new(), Some("ch_a"), 1));
  let b = put_commit(&mut writer, commit(tree, Vec::new(), Some("ch_a"), 2));
  let c = put_commit(&mut writer, commit(tree, vec![a], Some("ch_c"), 3));
  let d = put_commit(&mut writer, commit(tree, vec![c], None, 4));
  let put_fact = |writer: &mut StoreWriter, fact: Fact| writer.put_metadata(Type::Fact, &fact.encode()).unwrap();
  let reviewed = put_fact(&mut writer, record("causet.provenance/v1", "prov_reviewed", Some(a), vec![a]));
  let landed = put_fact(&mut writer, record("causet.landing/v1", "land_one", Some(c), vec![a, c]));
  let retired = put_fact(&mut writer, record("causet.provenance/v1", "prov_retired", Some(a), vec![a]));
  let disposition = put_fact(&mut writer, record("causet.disposition/v1", "disp_one", None, Vec::new()));
  let disputed = put_fact(
    &mut writer,
    Fact::Parked { reason: Reason::Disputed, place: b"refs/causet/quarantine/x".to_vec(), id: Some(b"prov_reviewed".to_vec()), bytes: b"{}".to_vec() },
  );
  let put_entry = |writer: &mut StoreWriter, entry: Entry| writer.put_metadata(Type::FactLogEntry, &entry.encode()).unwrap();
  let first = put_entry(&mut writer, entry(Scope::Shared, Vec::new(), vec![reviewed, retired], Vec::new()));
  let shared_head = put_entry(&mut writer, entry(Scope::Shared, vec![first], vec![landed], vec![retired]));
  put_entry(&mut writer, entry(Scope::Local, Vec::new(), vec![disposition, disputed], Vec::new()));
  writer.finish(&no_refs()).unwrap();
  Held { root, a, b, c, d, reviewed, landed, disposition, disputed, shared_head }
}

fn catalogs_dir(root: &Path) -> PathBuf {
  root.join(".cst").join("catalogs")
}

/// Every answer the small store's catalogs give, checked against what it
/// was built to hold.
fn assert_answers(held: &Held) {
  let store = Store::open(&held.root).unwrap();
  let catalogs = Catalogs::of(&store);
  assert_eq!(catalogs.commits_of_change("ch_a").unwrap(), sorted(vec![held.a, held.b]));
  assert_eq!(catalogs.commits_of_change("ch_c").unwrap(), vec![held.c]);
  assert_eq!(catalogs.commits_of_change("ch_none").unwrap(), Vec::<NativeId>::new());
  assert_eq!(catalogs.facts_naming(&held.a).unwrap(), sorted(vec![held.reviewed, held.landed]));
  assert_eq!(catalogs.facts_naming(&held.c).unwrap(), vec![held.landed]);
  assert_eq!(catalogs.facts_naming(&held.d).unwrap(), Vec::<NativeId>::new());
  assert_eq!(catalogs.facts_carrying(b"prov_reviewed").unwrap(), sorted(vec![held.reviewed, held.disputed]));
  assert_eq!(catalogs.facts_carrying(b"land_one").unwrap(), vec![held.landed]);
  assert_eq!(catalogs.facts_carrying(b"disp_one").unwrap(), vec![held.disposition]);
  assert_eq!(catalogs.facts_carrying(b"prov_retired").unwrap(), Vec::<NativeId>::new());
}

#[test]
fn each_catalog_answers_from_the_objects_and_is_written_under_cst_catalogs() {
  let held = small_store("answers");
  assert!(!catalogs_dir(&held.root).exists(), "import writes no catalog");
  assert_answers(&held);
  for name in FILES {
    assert!(catalogs_dir(&held.root).join(name).is_file(), "{name} is written");
  }
  // A second read answers the same from the written catalogs.
  assert_answers(&held);
}

const FILES: [&str; 3] = ["by-change", "by-object", "by-logical-id"];

/// Each catalog file's bytes, by name.
fn written(root: &Path) -> Vec<Vec<u8>> {
  FILES.iter().map(|name| std::fs::read(catalogs_dir(root).join(name)).unwrap()).collect()
}

#[test]
fn deleting_every_catalog_gives_the_same_answers_and_the_catalogs_are_rebuilt() {
  let held = small_store("deleted");
  assert_answers(&held);
  let before = written(&held.root);
  std::fs::remove_dir_all(catalogs_dir(&held.root)).unwrap();
  assert_answers(&held);
  assert_eq!(written(&held.root), before, "each catalog is rebuilt as it was");
}

#[test]
fn a_damaged_catalog_is_detected_and_rebuilt_not_trusted() {
  let held = small_store("damaged");
  assert_answers(&held);
  let fresh = written(&held.root);
  let damages: [(&str, fn(&mut Vec<u8>)); 4] = [
    ("a flipped byte", |bytes| {
      let middle = bytes.len() / 2;
      bytes[middle] ^= 0x01;
    }),
    ("a truncated file", |bytes| bytes.truncate(bytes.len() - 1)),
    ("an empty file", |bytes| bytes.clear()),
    ("another version, its checksum recomputed", |bytes| {
      let at = b"causet-catalog ".len();
      bytes[at] = b'9';
      let body = bytes.len() - 32;
      let checksum = causet_model::sha256::digest(&bytes[..body]);
      bytes[body..].copy_from_slice(&checksum);
    }),
  ];
  for (what, damage) in damages {
    for (index, name) in FILES.iter().enumerate() {
      let mut bytes = fresh[index].clone();
      damage(&mut bytes);
      std::fs::write(catalogs_dir(&held.root).join(name), &bytes).unwrap();
    }
    assert_answers(&held);
    assert_eq!(written(&held.root), fresh, "{what}: each catalog is rewritten from the objects");
  }
}

#[test]
fn a_catalog_derived_from_other_objects_is_rebuilt_not_trusted() {
  let held = small_store("stale");
  assert_answers(&held);
  let stale = written(&held.root);

  // The objects change after the catalogs are written, as an incremental
  // import changes them: a commit of change ch_a, and an entry adding a fact
  // naming d and retiring the landing. Each catalog file is left undamaged,
  // derived from the objects as they were.
  let mut writer = StoreWriter::open(&held.root, GitAlgorithm::Sha1).unwrap();
  let tree = writer.put_tree(&Tree::from_entries(Vec::new()).unwrap(), b"").unwrap();
  let e = writer.put_native_commit(&commit(tree, vec![held.d], Some("ch_a"), 5).encode()).unwrap();
  let noted = writer
    .put_metadata(Type::Fact, &record("causet.provenance/v1", "prov_noted", Some(held.d), vec![held.d]).encode())
    .unwrap();
  let third = writer
    .put_metadata(Type::FactLogEntry, &entry(Scope::Shared, vec![held.shared_head], vec![noted], vec![held.landed]).encode())
    .unwrap();
  writer.finish(&no_refs()).unwrap();
  assert_eq!(written(&held.root), stale, "the import leaves the catalogs as they were");

  let store = Store::open(&held.root).unwrap();
  let catalogs = Catalogs::of(&store);
  assert_eq!(catalogs.commits_of_change("ch_a").unwrap(), sorted(vec![held.a, held.b, e]));
  assert_eq!(catalogs.facts_naming(&held.d).unwrap(), vec![noted]);
  assert_eq!(catalogs.facts_naming(&held.c).unwrap(), Vec::<NativeId>::new(), "the landing is retired");
  assert_eq!(catalogs.facts_naming(&held.a).unwrap(), vec![held.reviewed]);
  assert_eq!(catalogs.facts_carrying(b"prov_noted").unwrap(), vec![noted]);
  assert_eq!(catalogs.facts_carrying(b"land_one").unwrap(), Vec::<NativeId>::new());
  let rebuilt = written(&held.root);
  for (index, name) in FILES.iter().enumerate() {
    assert_ne!(rebuilt[index], stale[index], "{name} is derived again from the objects held now");
  }
  drop(catalogs);
  drop(store);

  // An entry that only retires, adding no fact, changes what is current too.
  let mut writer = StoreWriter::open(&held.root, GitAlgorithm::Sha1).unwrap();
  writer
    .put_metadata(Type::FactLogEntry, &entry(Scope::Shared, vec![third], Vec::new(), vec![noted]).encode())
    .unwrap();
  writer.finish(&no_refs()).unwrap();
  let store = Store::open(&held.root).unwrap();
  let catalogs = Catalogs::of(&store);
  assert_eq!(catalogs.facts_naming(&held.d).unwrap(), Vec::<NativeId>::new(), "the noted record is retired");
  assert_eq!(catalogs.facts_carrying(b"prov_noted").unwrap(), Vec::<NativeId>::new());
}

/// Asks each catalog once, and says how many bytes the store read to answer.
fn bytes_to_answer(held: &Held) -> u64 {
  let store = Store::open(&held.root).unwrap();
  let catalogs = Catalogs::of(&store);
  catalogs.commits_of_change("ch_a").unwrap();
  catalogs.facts_naming(&held.a).unwrap();
  catalogs.facts_carrying(b"prov_reviewed").unwrap();
  store.bytes_read()
}

#[test]
fn a_catalog_that_agrees_with_the_objects_is_read_not_derived_again() {
  let held = small_store("trusted");
  let deriving = bytes_to_answer(&held);
  assert!(catalogs_dir(&held.root).join("by-object").is_file());
  let trusting = bytes_to_answer(&held);
  assert!(
    trusting < deriving,
    "answering from the catalogs reads {trusting} bytes of the store, deriving them {deriving}"
  );
  assert_answers(&held);
}
