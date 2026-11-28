//! The operation heads (docs/native-history/operations.md §3.2): import's
//! operation becomes the one head; a writer adds its own head and removes its
//! parents' with no lock, so two writers that start from the same head both
//! keep theirs; a head that is an ancestor of another, which a crash between
//! a writer's steps leaves, is not current; and `log` lists the operations
//! newest first.

use causet_history::action::{ActionActor, Time};
use causet_history::actor::Kind as ActorKind;
use causet_history::names::{Kind, Name, Target, Value};
use causet_history::op_log::{self, Current};
use causet_history::operation::{Operation, View};
use causet_store::heads;
use causet_store::id::{GitAlgorithm, NativeId, Type};
use causet_store::objects::{Snapshot, Tree};
use causet_store::store::{Store, StoreWriter};
use std::path::{Path, PathBuf};

fn scratch(name: &str) -> PathBuf {
  let directory = std::env::temp_dir().join(format!("causet-op-log-test-{}-{name}", std::process::id()));
  let _ = std::fs::remove_dir_all(&directory);
  directory
}

fn no_refs() -> Snapshot {
  Snapshot::new(GitAlgorithm::Sha1, Vec::new()).unwrap()
}

fn branch(name: &str, target: NativeId) -> Name {
  Name { kind: Kind::Branch, name: name.as_bytes().to_vec(), local: false, value: Value::Resolved(Target::Object(target)) }
}

fn ada() -> Option<ActionActor> {
  Some(ActionActor { actor: "Ada Lovelace <ada@example.com>".into(), kind: Some(ActorKind::Human), on_behalf_of: None })
}

/// A store whose import stored a tree and wrote the operation naming it as
/// `main`; the tree's ID and the operation's.
fn imported(root: &Path) -> (NativeId, NativeId) {
  let mut writer = StoreWriter::create(root, GitAlgorithm::Sha1).unwrap();
  let tree = writer.put_tree(&Tree { entries: Vec::new() }, b"").unwrap();
  let operation = Operation::import(Vec::new(), View { shared: Vec::new(), local: Vec::new(), names: vec![branch("main", tree)] });
  let id = writer.put_metadata(Type::Operation, &operation.encode()).unwrap();
  writer.finish_with_head(&no_refs(), &id, &[]).unwrap();
  (tree, id)
}

/// The operation that moves `main` from `parent`'s view to `target`.
fn moving(store: &Store, parent: NativeId, name: &str, target: NativeId, seconds: u64) -> Operation {
  let view = Operation::read(store, &parent).unwrap().view.with(branch(name, target));
  Operation {
    parents: vec![parent],
    actor: ada(),
    time: Some(Time { seconds, offset: 0 }),
    command: vec![b"branch".to_vec(), b"--force".to_vec(), name.as_bytes().to_vec(), target.hex().into_bytes()],
    view,
  }
}

fn head_files(root: &Path) -> Vec<NativeId> {
  heads::list(&root.join(".cst")).unwrap().unwrap().0
}

#[test]
fn import_writes_the_one_head_and_its_view_is_current() {
  let root = scratch("import");
  let (tree, id) = imported(&root);
  assert_eq!(head_files(&root), vec![id]);
  let store = Store::open(&root).unwrap();
  let Current::One(current, operation) = op_log::current(&store).unwrap() else { panic!("one current head") };
  assert_eq!(current, id);
  assert_eq!(operation.view.resolved(Kind::Branch, b"main"), Some(&Target::Object(tree)));
  let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn a_write_replaces_its_parent_as_the_head_and_the_log_lists_both_newest_first() {
  let root = scratch("write");
  let (tree, import) = imported(&root);
  let store = Store::open(&root).unwrap();
  let id = op_log::write(&root, &moving(&store, import, "topic", tree, 100), &[]).unwrap();
  assert_eq!(head_files(&root), vec![id]);
  let store = Store::open(&root).unwrap();
  let Current::One(current, operation) = op_log::current(&store).unwrap() else { panic!("one current head") };
  assert_eq!(current, id);
  assert_eq!(operation.actor, ada());
  assert!(operation.view.resolved(Kind::Branch, b"topic").is_some());
  let listed: Vec<NativeId> = op_log::log(&store, &[id], None).unwrap().into_iter().map(|(id, _)| id).collect();
  assert_eq!(listed, vec![id, import]);
  assert_eq!(op_log::log(&store, &[id], Some(1)).unwrap().len(), 1);
  let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn two_writers_from_the_same_head_both_keep_theirs() {
  let root = scratch("race");
  let (tree, import) = imported(&root);
  // Both read the same current head before either writes.
  let store = Store::open(&root).unwrap();
  let first = moving(&store, import, "one", tree, 100);
  let second = moving(&store, import, "two", tree, 101);
  let first = op_log::write(&root, &first, &[]).unwrap();
  let second = op_log::write(&root, &second, &[]).unwrap();
  let mut both = vec![first, second];
  both.sort();
  assert_eq!(head_files(&root), both);
  let store = Store::open(&root).unwrap();
  match op_log::current(&store).unwrap() {
    Current::Several { heads, view } => {
      assert_eq!(heads, both);
      // The current view is their merge (§3.3): each side's new branch, and
      // `main`, which neither moved.
      assert_eq!(view.names, vec![branch("main", tree), branch("one", tree), branch("two", tree)]);
    }
    other => panic!("expected two current heads, got {other:?}"),
  }
  let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn two_operations_with_no_common_ancestor_merge_from_the_empty_view() {
  let root = scratch("unrelated");
  let (tree, first) = imported(&root);
  // A second import's operation with no parent, which shares no ancestor
  // with the first: their base is the empty view (§3.3).
  // The merge reads no target, so another object ID stands for one.
  let elsewhere = NativeId::of(Type::Tree, b"elsewhere");
  let other = Operation::import(Vec::new(), View { shared: Vec::new(), local: Vec::new(), names: vec![branch("main", elsewhere), branch("solo", tree)] });
  let second = op_log::write(&root, &other, &[]).unwrap();
  let store = Store::open(&root).unwrap();
  let Current::Several { view, .. } = op_log::current(&store).unwrap() else { panic!("two current heads") };
  // `main`, which each holds at another target, is conflicted from no base;
  // `solo`, which one holds, is that one's.
  let mut sides = [(first, tree), (second, elsewhere)];
  sides.sort();
  let main = view.name(Kind::Branch, b"main").unwrap();
  assert_eq!(
    main.value,
    Value::Conflicted { adds: sides.iter().map(|(_, target)| Some(Target::Object(*target))).collect(), removes: vec![None] }
  );
  assert_eq!(view.name(Kind::Branch, b"solo"), Some(&branch("solo", tree)));
  let _ = std::fs::remove_dir_all(&root);
}

/// The operation with `parents`, a write after their merge, whose view is
/// `view`.
fn after(parents: &[NativeId], view: View, seconds: u64) -> Operation {
  let mut parents = parents.to_vec();
  parents.sort();
  Operation { parents, actor: ada(), time: Some(Time { seconds, offset: 0 }), command: vec![b"branch".to_vec()], view }
}

#[test]
fn two_merges_of_the_same_two_sides_merge_from_the_merge_of_both() {
  let root = scratch("criss-cross");
  let (tree, import) = imported(&root);
  let store = Store::open(&root).unwrap();
  // A adds `one` and B adds `two`, at once.
  let a = op_log::write(&root, &moving(&store, import, "one", tree, 100), &[]).unwrap();
  let b = op_log::write(&root, &moving(&store, import, "two", tree, 101), &[]).unwrap();
  let store = Store::open(&root).unwrap();
  let both = op_log::merged(&store, &[a, b]).unwrap();
  // Then two writers each merge A and B at once: one deletes `two`, the
  // other `one`. A and B are both their latest common ancestors.
  let deletes_two = after(&[a, b], both.clone().without(Kind::Branch, b"two"), 102);
  let deletes_one = after(&[a, b], both.without(Kind::Branch, b"one"), 103);
  let first = op_log::write(&root, &deletes_two, &[]).unwrap();
  let second = op_log::write(&root, &deletes_one, &[]).unwrap();
  let store = Store::open(&root).unwrap();
  let Current::Several { heads, view } = op_log::current(&store).unwrap() else { panic!("two current heads") };
  let mut expected = vec![first, second];
  expected.sort();
  assert_eq!(heads, expected);
  // Merged from A's and B's merge, each deletion is one side's alone. From
  // the import, or from A or B alone, one of the two would stay.
  assert_eq!(view.names, vec![branch("main", tree)]);
  let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn a_head_left_by_a_crash_before_its_parent_was_removed_is_not_current() {
  let root = scratch("crash");
  let (tree, import) = imported(&root);
  let store = Store::open(&root).unwrap();
  let id = op_log::write(&root, &moving(&store, import, "topic", tree, 100), &[]).unwrap();
  // The crash: the parent's head file was never removed.
  heads::add(&root.join(".cst"), &import).unwrap();
  let mut files = vec![import, id];
  files.sort();
  assert_eq!(head_files(&root), files);
  let store = Store::open(&root).unwrap();
  let Current::One(current, _) = op_log::current(&store).unwrap() else { panic!("one current head") };
  assert_eq!(current, id);
  let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn a_store_without_heads_is_missing_and_an_empty_heads_directory_is_corrupt() {
  let root = scratch("missing");
  StoreWriter::create(&root, GitAlgorithm::Sha1).unwrap().finish(&no_refs()).unwrap();
  let store = Store::open(&root).unwrap();
  assert!(matches!(op_log::current(&store).unwrap(), Current::Missing));
  std::fs::create_dir(root.join(".cst").join("op-heads")).unwrap();
  assert!(op_log::current(&store).is_err());
  let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn fsck_refuses_a_fact_naming_an_operation_and_a_head_naming_none() {
  let root = scratch("fsck");
  let (_, import) = imported(&root);
  assert_eq!(causet_history::verify::problems(&Store::open(&root).unwrap()).unwrap(), Vec::<String>::new());
  // A fact that names the import's operation, as an exchanged record must
  // never do (operations.md §1).
  let fact = causet_history::fact::Fact::Record {
    schema: b"causet.provenance/v1".to_vec(),
    actor: None,
    subject: Some(import),
    names: vec![import],
    record: format!("{{\"commit\":\"{}\",\"schema\":\"causet.provenance/v1\"}}", import.hex()).into_bytes(),
  };
  causet_store::store::add_metadata(&root, &[(Type::Fact, &fact.encode())]).unwrap();
  let stray = NativeId([7; 32]);
  heads::add(&root.join(".cst"), &stray).unwrap();
  let problems = causet_history::verify::problems(&Store::open(&root).unwrap()).unwrap();
  assert!(problems.iter().any(|problem| problem.contains("names the operation") && problem.contains("never exchanged")), "{problems:?}");
  assert!(problems.iter().any(|problem| problem.contains(&format!("operation head {stray}"))), "{problems:?}");
  let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn a_head_file_named_in_uppercase_is_no_head_and_fsck_reports_it() {
  let root = scratch("uppercase");
  let (tree, import) = imported(&root);
  // A held operation that is no head, named in uppercase: a file system that
  // matches names without case holds no other file of that name.
  let store = Store::open(&root).unwrap();
  let other = moving(&store, import, "topic", tree, 100);
  causet_store::store::add_metadata(&root, &[(Type::Operation, &other.encode())]).unwrap();
  let upper = other.id().hex().to_uppercase();
  std::fs::write(root.join(".cst").join("op-heads").join(&upper), b"").unwrap();
  let store = Store::open(&root).unwrap();
  let (heads, strays) = op_log::heads(&store).unwrap().unwrap();
  assert_eq!(heads, vec![import]);
  assert_eq!(strays, vec![upper.clone()]);
  let problems = causet_history::verify::problems(&store).unwrap();
  assert!(problems.iter().any(|problem| problem == &format!("{upper} in .cst/op-heads/ names no operation")), "{problems:?}");
  let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn fsck_refuses_an_operation_with_no_parent_that_is_not_imports() {
  let root = scratch("orphan");
  let (tree, import) = imported(&root);
  let store = Store::open(&root).unwrap();
  let mut orphan = moving(&store, import, "topic", tree, 100);
  orphan.parents = Vec::new();
  causet_store::store::add_metadata(&root, &[(Type::Operation, &orphan.encode())]).unwrap();
  let problems = causet_history::verify::problems(&Store::open(&root).unwrap()).unwrap();
  assert!(
    problems.iter().any(|problem| problem == &format!("the operation {}: it has no parent, and only import's into a new store has none", orphan.id())),
    "{problems:?}"
  );
  let _ = std::fs::remove_dir_all(&root);
}
