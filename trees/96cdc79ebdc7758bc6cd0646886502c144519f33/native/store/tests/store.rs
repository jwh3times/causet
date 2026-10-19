//! Writes a store, reads every object back through its index and frames, and
//! damages it to see each kind of corruption reported.

use causet_store::StoreError;
use causet_store::id::{GitAlgorithm, NativeId, Type};
use causet_store::container::{ContainerWriter, Form};
use causet_store::objects::{ChunkList, Entry, GitKind, Kind, Preserved, Target, Tree};
use causet_store::store::{Store, StoreWriter};
use std::path::PathBuf;

fn scratch(name: &str) -> PathBuf {
  let directory =
    std::env::temp_dir().join(format!("causet-store-test-{}-{name}", std::process::id()));
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

#[test]
fn every_object_written_reads_back_verified() {
  let root = scratch("round-trip");
  let mut writer = StoreWriter::create(&root, GitAlgorithm::Sha1).unwrap();
  let small = writer.put_content(b"hello\n").unwrap();
  let large_bytes = varied(300_000, 7);
  let large = writer.put_content(&large_bytes).unwrap();
  // A second version sharing most of the first's chunks.
  let mut edited = large_bytes.clone();
  edited.splice(150_000..150_000, *b"inserted");
  let second = writer.put_content(&edited).unwrap();
  assert_eq!(writer.put_content(b"hello\n").unwrap(), small);
  let tree = Tree::from_entries(vec![
    Entry {
      name: b"small".to_vec(),
      kind: Kind::File,
      target: Target::Native(small),
    },
    Entry {
      name: b"large".to_vec(),
      kind: Kind::Executable,
      target: Target::Native(large),
    },
  ])
  .unwrap();
  let tree_id = writer.put_tree(&tree).unwrap();
  let preserved = Preserved {
    algorithm: GitAlgorithm::Sha1,
    kind: GitKind::Tree,
    payload: b"040000 sub\0aaaaaaaaaaaaaaaaaaaa".to_vec(),
  };
  let preserved_id = writer.put_preserved(&preserved).unwrap();
  writer.alias(vec![0xce; 20], small);
  writer.alias(vec![0x11; 20], tree_id);
  writer.finish().unwrap();

  let store = Store::open(&root).unwrap();
  assert_eq!(store.read(&small).unwrap().body, b"hello\n");
  assert_eq!(store.read(&large).unwrap().body, large_bytes);
  assert_eq!(store.read(&second).unwrap().body, edited);
  let read = store.read(&tree_id).unwrap();
  assert_eq!(read.kind, Type::Tree);
  assert_eq!(Tree::decode(&read.body).unwrap(), tree);
  assert_eq!(
    Preserved::decode(&store.read(&preserved_id).unwrap().body).unwrap(),
    preserved
  );
  let aliases = store.aliases_for(GitAlgorithm::Sha1).unwrap();
  assert_eq!(aliases.native(&[0xce; 20]), Some(small));
  assert_eq!(aliases.git(&tree_id), Some([0x11; 20].as_slice()));
  assert_eq!(store.matching(&small.hex()[..12]), [small]);
  assert!(matches!(
    store.read(&NativeId([0; 32])),
    Err(StoreError::NotFound(_))
  ));
  std::fs::remove_dir_all(&root).unwrap();
}

#[test]
fn a_destination_that_is_not_empty_is_refused() {
  let root = scratch("not-empty");
  std::fs::create_dir_all(&root).unwrap();
  std::fs::write(root.join("file"), b"x").unwrap();
  assert!(matches!(
    StoreWriter::create(&root, GitAlgorithm::Sha1),
    Err(StoreError::Exists(_))
  ));
  std::fs::remove_dir_all(&root).unwrap();
}

#[test]
fn damage_to_a_container_is_reported_as_corruption() {
  let root = scratch("damaged");
  let mut writer = StoreWriter::create(&root, GitAlgorithm::Sha1).unwrap();
  let id = writer.put_content(&varied(10_000, 3)).unwrap();
  writer.finish().unwrap();
  let objects = root.join(".cst/objects");
  let container = std::fs::read_dir(&objects)
    .unwrap()
    .next()
    .unwrap()
    .unwrap()
    .path();
  let original = std::fs::read(&container).unwrap();

  // A byte of a frame: the index still checks, the record does not.
  let mut frame = original.clone();
  frame[40] ^= 0xff;
  std::fs::write(&container, &frame).unwrap();
  let store = Store::open(&root).unwrap();
  assert!(
    matches!(store.read(&id), Err(StoreError::Corrupt(_))),
    "{:?}",
    store.read(&id)
  );

  // A byte of the index: it no longer matches its SHA-256.
  let mut index = original.clone();
  let at = index.len() - 100;
  index[at] ^= 0xff;
  std::fs::write(&container, &index).unwrap();
  assert!(matches!(Store::open(&root), Err(StoreError::Corrupt(_))));

  std::fs::write(root.join(".cst/format"), b"causet-native-store 1\n").unwrap();
  assert!(matches!(
    Store::open(&root),
    Err(StoreError::Unsupported(_))
  ));
  std::fs::remove_dir_all(&root).unwrap();
}

/// A store holding exactly these records, written past the store's own rules.
fn crafted(name: &str, records: &[(NativeId, Type, Form, Vec<u8>)]) -> PathBuf {
  let root = scratch(name);
  let objects = root.join(".cst").join("objects");
  std::fs::create_dir_all(&objects).unwrap();
  std::fs::write(root.join(".cst").join("format"), causet_store::store::FORMAT).unwrap();
  let mut container = ContainerWriter::create(&objects).unwrap();
  for (id, kind, form, record) in records {
    container.add(id, *kind, *form, record).unwrap();
  }
  container.finish().unwrap();
  root
}

#[test]
fn a_hostile_chunk_list_is_reported_as_corruption_without_exhausting_the_reader() {
  let small = b"0123456789".to_vec();
  let small_id = NativeId::of(Type::Content, &small);
  let named = NativeId([7; 32]);
  let list = |size: u64, chunks: Vec<(NativeId, u64)>| ChunkList { size, chunks }.encode();
  let cases = [
    // A list that names itself: its element would be as long as the list.
    ("self", vec![(named, Type::Content, Form::ChunkList, list(20, vec![(named, 10), (small_id, 10)]))]),
    // A list claiming 2^63 bytes from two small chunks.
    (
      "huge",
      vec![
        (named, Type::Content, Form::ChunkList, list(1 << 63, vec![(small_id, 1 << 62), (small_id, 1 << 62)])),
        (small_id, Type::Content, Form::Body, small.clone()),
      ],
    ),
    // A chunk the store does not hold.
    ("missing", vec![(named, Type::Content, Form::ChunkList, list(20, vec![(small_id, 10), (small_id, 10)]))]),
    // A chunk that is a tree.
    (
      "not-content",
      vec![
        (named, Type::Content, Form::ChunkList, list(20, vec![(small_id, 10), (small_id, 10)])),
        (small_id, Type::Tree, Form::Body, small.clone()),
      ],
    ),
  ];
  for (name, records) in cases {
    let root = crafted(name, &records);
    let store = Store::open(&root).unwrap();
    assert!(matches!(store.read(&named), Err(StoreError::Corrupt(_))), "{name}: {:?}", store.read(&named));
    std::fs::remove_dir_all(&root).unwrap();
  }
}

#[test]
fn a_container_not_named_by_its_trailer_is_corrupt() {
  let root = scratch("misnamed");
  let mut writer = StoreWriter::create(&root, GitAlgorithm::Sha1).unwrap();
  writer.put_content(b"x").unwrap();
  writer.finish().unwrap();
  let objects = root.join(".cst/objects");
  let container = std::fs::read_dir(&objects).unwrap().next().unwrap().unwrap().path();
  std::fs::rename(&container, objects.join(format!("{}.cstc", "0".repeat(64)))).unwrap();
  assert!(matches!(Store::open(&root), Err(StoreError::Corrupt(_))));
  std::fs::remove_dir_all(&root).unwrap();
}
