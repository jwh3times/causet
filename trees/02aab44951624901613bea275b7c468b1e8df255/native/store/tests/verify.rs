//! The store's verification (objects.md §8, storage.md §4): every present
//! copy in every container is checked, absent content is a state and not
//! corruption, and an annotation of an unknown type is checked only for what
//! every type shares.

use causet_store::container::{ABSENT_BY_PROMISE, ContainerWriter, Form};
use causet_store::id::{GitAlgorithm, NativeId, Type};
use causet_store::objects::{Annotation, ChunkList, Entry, Kind, Snapshot, Target, Tree};
use causet_store::store::{Store, StoreWriter};
use causet_store::verify::verify;
use std::path::{Path, PathBuf};

fn scratch(name: &str) -> PathBuf {
  let directory =
    std::env::temp_dir().join(format!("causet-verify-test-{}-{name}", std::process::id()));
  let _ = std::fs::remove_dir_all(&directory);
  directory
}

/// Bytes the chunker cuts into several chunks.
fn varied(length: usize, seed: u32) -> Vec<u8> {
  let mut state = seed.wrapping_mul(2_654_435_761) | 1;
  (0..length)
    .map(|_| {
      state ^= state << 13;
      state ^= state >> 17;
      state ^= state << 5;
      (state >> 24) as u8
    })
    .collect()
}

/// A store of a small file, a chunked file and a tree naming both.
fn store(name: &str) -> (PathBuf, NativeId, NativeId, NativeId) {
  let root = scratch(name);
  let mut writer = StoreWriter::create(&root, GitAlgorithm::Sha1).unwrap();
  let small = writer.put_content(b"hello\n").unwrap();
  let large = writer.put_content(&varied(200_000, 7)).unwrap();
  let tree = writer
    .put_tree(&Tree {
      entries: vec![
        Entry { name: b"large".to_vec(), kind: Kind::File, target: Target::Native(large) },
        Entry { name: b"small".to_vec(), kind: Kind::File, target: Target::Native(small) },
      ],
    })
    .unwrap();
  writer
    .finish(&Snapshot::new(GitAlgorithm::Sha1, Vec::new()).unwrap())
    .unwrap();
  (root, small, large, tree)
}

fn container(root: &Path) -> PathBuf {
  std::fs::read_dir(root.join(".cst/objects"))
    .unwrap()
    .map(|entry| entry.unwrap().path())
    .find(|path| path.extension().is_some_and(|extension| extension == "cstc"))
    .unwrap()
}

#[test]
fn a_sound_store_verifies_every_copy() {
  let (root, ..) = store("sound");
  let found = verify(&Store::open(&root).unwrap()).unwrap();
  assert!(found.problems.is_empty(), "{:?}", found.problems);
  assert_eq!(found.containers, 1);
  assert_eq!(found.copies, found.objects);
  assert!(found.absent_by_promise.is_empty() && found.absent_by_policy.is_empty());
  std::fs::remove_dir_all(&root).unwrap();
}

#[test]
fn a_damaged_copy_in_a_second_container_is_reported() {
  let (root, small, ..) = store("second-copy");
  let first = container(&root);
  // A second copy of `small`, damaged: the index and trailer were written
  // over the damaged bytes, so only its hash shows it.
  let mut writer = ContainerWriter::create(&root.join(".cst/objects")).unwrap();
  writer.add(&small, Type::Content, Form::Body, b"hellO\n").unwrap();
  let second = writer.finish().unwrap();
  let store = Store::open(&root).unwrap();
  let found = verify(&store).unwrap();
  let named = second.file_name().unwrap().to_string_lossy().into_owned();
  assert_eq!(
    found.problems,
    [format!("{small}, its copy in {named}: its bytes do not hash to its ID")],
    "the first container was {}",
    first.display()
  );
  std::fs::remove_dir_all(&root).unwrap();
}

#[test]
fn damage_to_a_frame_names_the_container_and_each_object_it_reaches() {
  let (root, ..) = store("frame");
  let path = container(&root);
  let mut bytes = std::fs::read(&path).unwrap();
  bytes[40] ^= 0xff;
  std::fs::write(&path, &bytes).unwrap();
  let found = verify(&Store::open(&root).unwrap()).unwrap();
  let named = path.file_name().unwrap().to_string_lossy().into_owned();
  assert!(
    found.problems[0].ends_with(": its trailer is not the SHA-256 of its bytes"),
    "{:?}",
    found.problems
  );
  // The rest each name an object of the damaged frame and this container:
  // its bytes, or the frame itself, no longer read.
  assert!(found.problems.len() > 1, "{:?}", found.problems);
  for problem in &found.problems[1..] {
    assert!(
      problem.contains(&format!(", its copy in {named}: ")) || problem.contains("frame"),
      "{problem}"
    );
  }
  std::fs::remove_dir_all(&root).unwrap();
}

#[test]
fn a_known_id_with_no_index_entry_is_corrupt_and_an_unknown_annotation_is_not() {
  let root = scratch("known");
  let objects = root.join(".cst/objects");
  std::fs::create_dir_all(&objects).unwrap();
  std::fs::write(root.join(".cst/format"), causet_store::store::FORMAT).unwrap();
  let snapshot = Snapshot::new(GitAlgorithm::Sha1, Vec::new()).unwrap().encode();
  let snapshot_id = NativeId::of(Type::Snapshot, &snapshot);
  std::fs::write(root.join(".cst/snapshot"), format!("{}\n", snapshot_id.hex())).unwrap();
  let held = NativeId::of(Type::Content, b"held");
  let lost = NativeId::of(Type::Content, b"lost");
  let tree = Tree {
    entries: vec![
      Entry { name: b"held".to_vec(), kind: Kind::File, target: Target::Native(held) },
      Entry { name: b"lost".to_vec(), kind: Kind::File, target: Target::Native(lost) },
    ],
  }
  .encode();
  let tree_id = NativeId::of(Type::Tree, &tree);
  let known = Annotation { subject: held, kind: b"example".to_vec(), payload: b"anything".to_vec() }.encode();
  let unknown = Annotation { subject: lost, kind: b"example".to_vec(), payload: Vec::new() }.encode();
  let mut writer = ContainerWriter::create(&objects).unwrap();
  writer.add(&snapshot_id, Type::Snapshot, Form::Body, &snapshot).unwrap();
  writer.add(&held, Type::Content, Form::Body, b"held").unwrap();
  writer.add(&tree_id, Type::Tree, Form::Body, &tree).unwrap();
  for body in [&known, &unknown] {
    writer
      .add(&NativeId::of(Type::Annotation, body), Type::Annotation, Form::Body, body)
      .unwrap();
  }
  writer.finish().unwrap();
  let found = verify(&Store::open(&root).unwrap()).unwrap();
  assert_eq!(found.annotations, 2);
  let unknown_id = NativeId::of(Type::Annotation, &unknown);
  let mut problems = found.problems.clone();
  problems.sort();
  let mut expected = vec![
    format!("{tree_id}: its entry lost names {lost}, which has no index entry"),
    format!("{unknown_id}: its subject {lost}, which has no index entry"),
  ];
  expected.sort();
  assert_eq!(problems, expected);
  std::fs::remove_dir_all(&root).unwrap();
}

#[test]
fn a_chunk_list_with_an_absent_chunk_still_has_every_chunk_checked() {
  let root = scratch("absent-chunk");
  let objects = root.join(".cst/objects");
  std::fs::create_dir_all(&objects).unwrap();
  std::fs::write(root.join(".cst/format"), causet_store::store::FORMAT).unwrap();
  let snapshot = Snapshot::new(GitAlgorithm::Sha1, Vec::new()).unwrap().encode();
  let snapshot_id = NativeId::of(Type::Snapshot, &snapshot);
  std::fs::write(root.join(".cst/snapshot"), format!("{}\n", snapshot_id.hex())).unwrap();
  let (first, second, third) = (b"first chunk".to_vec(), b"second chunk".to_vec(), b"third chunk".to_vec());
  let ids: Vec<NativeId> = [&first, &second, &third].iter().map(|bytes| NativeId::of(Type::Content, bytes)).collect();
  let content = [first.clone(), second.clone(), third.clone()].concat();
  let id = NativeId::of(Type::Content, &content);
  let list = ChunkList {
    size: content.len() as u64,
    chunks: vec![(ids[0], first.len() as u64), (ids[1], second.len() as u64), (ids[2], third.len() as u64)],
  }
  .encode();
  let write = |lost: bool| {
    for entry in std::fs::read_dir(&objects).unwrap() {
      std::fs::remove_file(entry.unwrap().path()).unwrap();
    }
    let mut writer = ContainerWriter::create(&objects).unwrap();
    writer.add(&snapshot_id, Type::Snapshot, Form::Body, &snapshot).unwrap();
    writer.add(&id, Type::Content, Form::ChunkList, &list).unwrap();
    // The first chunk absent, so the list never resolves to its end.
    writer.add_absent(&ids[0], Type::Content, ABSENT_BY_PROMISE);
    writer.add(&ids[1], Type::Content, Form::Body, &second).unwrap();
    if !lost {
      writer.add(&ids[2], Type::Content, Form::Body, &third).unwrap();
    }
    writer.finish().unwrap();
  };
  write(false);
  let found = verify(&Store::open(&root).unwrap()).unwrap();
  assert!(found.problems.is_empty(), "{:?}", found.problems);
  assert_eq!(found.absent_by_promise, [ids[0]]);
  write(true);
  let found = verify(&Store::open(&root).unwrap()).unwrap();
  assert_eq!(
    found.problems.len(),
    1,
    "{:?}",
    found.problems
  );
  assert!(
    found.problems[0].ends_with(&format!("its chunk list names {}, which has no index entry", ids[2])),
    "{:?}",
    found.problems
  );
  std::fs::remove_dir_all(&root).unwrap();
}
