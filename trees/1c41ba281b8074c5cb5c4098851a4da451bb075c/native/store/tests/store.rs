//! Writes a store, reads every object back through its index and frames, and
//! damages it to see each kind of corruption reported.

use causet_store::StoreError;
use causet_store::id::{GitAlgorithm, NativeId, Type};
use causet_store::container::{Container, ContainerWriter, Form};
use causet_store::objects::{
  ChunkList, Entry, GitKind, Kind, Preserved, Ref, RefTarget, Snapshot, Target, Tree,
};
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

/// The form an object present in `store` is stored in.
fn form(store: &Store, id: &NativeId) -> Form {
  store
    .present()
    .into_iter()
    .find(|(found, _, _)| found == id)
    .map(|(_, _, form)| form)
    .unwrap()
}

/// A snapshot with no refs, as a repository with none has.
fn no_refs() -> Snapshot {
  Snapshot::new(GitAlgorithm::Sha1, Vec::new()).unwrap()
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
  let tree_id = writer.put_tree(&tree, b"").unwrap();
  let preserved = Preserved {
    algorithm: GitAlgorithm::Sha1,
    kind: GitKind::Tree,
    payload: b"040000 sub\0aaaaaaaaaaaaaaaaaaaa".to_vec(),
  };
  let preserved_id = writer.put_preserved(&preserved, b"").unwrap();
  writer.alias(vec![0xce; 20], small);
  writer.alias(vec![0x11; 20], tree_id);
  let snapshot = Snapshot::new(
    GitAlgorithm::Sha1,
    vec![
      Ref {
        name: b"refs/tags/tree".to_vec(),
        target: RefTarget::Direct(tree_id),
      },
      Ref {
        name: b"HEAD".to_vec(),
        target: RefTarget::Symbolic(b"refs/heads/unborn".to_vec()),
      },
    ],
  )
  .unwrap();
  writer.finish(&snapshot).unwrap();

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
  assert_eq!(store.native(GitAlgorithm::Sha1, &[0xce; 20]), Some(small));
  assert_eq!(store.git(GitAlgorithm::Sha1, &tree_id), Some(vec![0x11; 20]));
  assert_eq!(store.matching(&small.hex()[..12], |_| true), [small]);
  assert_eq!(store.refs().unwrap(), snapshot);
  assert_eq!(store.read(&store.snapshot).unwrap().kind, Type::Snapshot);
  assert!(matches!(
    store.read(&NativeId([0; 32])),
    Err(StoreError::NotFound(_))
  ));
  std::fs::remove_dir_all(&root).unwrap();
}

/// The names in a directory.
fn listing(directory: &std::path::Path) -> std::collections::BTreeSet<String> {
  std::fs::read_dir(directory)
    .unwrap()
    .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
    .collect()
}

/// The container a store holds alone, and its metadata records' IDs in the
/// order its frames hold them.
fn metadata_order(root: &std::path::Path) -> Vec<NativeId> {
  let path = std::fs::read_dir(root.join(".cst/objects"))
    .unwrap()
    .map(|entry| entry.unwrap().path())
    .find(|path| path.extension().is_some_and(|extension| extension == "cstc"))
    .unwrap();
  let container = Container::open(&path).unwrap();
  let mut held: Vec<(u32, u32, NativeId)> = container
    .names
    .iter()
    .zip(&container.records)
    .filter(|(_, record)| record.kind != Type::Content)
    .map(|(name, record)| (record.frame, record.offset, NativeId(*name)))
    .collect();
  held.sort();
  held.into_iter().map(|(_, _, id)| id).collect()
}

#[test]
fn metadata_is_written_trees_by_path_then_commits_and_tags_then_the_snapshot() {
  let root = scratch("path-order");
  let mut writer = StoreWriter::create(&root, GitAlgorithm::Sha1).unwrap();
  let file = |writer: &mut StoreWriter, bytes: &[u8]| {
    let content = writer.put_content(bytes).unwrap();
    Tree::from_entries(vec![Entry {
      name: b"f".to_vec(),
      kind: Kind::File,
      target: Target::Native(content),
    }])
    .unwrap()
  };
  let inside = |tree: NativeId| {
    Tree::from_entries(vec![Entry {
      name: b"dir".to_vec(),
      kind: Kind::Tree,
      target: Target::Native(tree),
    }])
    .unwrap()
  };
  let commit = |message: &str| Preserved {
    algorithm: GitAlgorithm::Sha1,
    kind: GitKind::Commit,
    payload: format!("tree 0000000000000000000000000000000000000000\n\n{message}\n").into_bytes(),
  };
  // Two commits as import's walk leaves them: each one's `dir`, then its
  // root, then the commit. A preserved tree is grouped by its path too.
  let tree = file(&mut writer, b"one\n");
  let dir_one = writer.put_tree(&tree, b"dir").unwrap();
  let root_one = writer.put_tree(&inside(dir_one), b"").unwrap();
  let commit_one = writer.put_preserved(&commit("one"), b"").unwrap();
  let tree = file(&mut writer, b"two\n");
  let dir_two = writer.put_tree(&tree, b"dir").unwrap();
  let odd = writer
    .put_preserved(
      &Preserved {
        algorithm: GitAlgorithm::Sha1,
        kind: GitKind::Tree,
        payload: b"100644 f\0bbbbbbbbbbbbbbbbbbbb".to_vec(),
      },
      b"dir",
    )
    .unwrap();
  let root_two = writer.put_tree(&inside(dir_two), b"").unwrap();
  let commit_two = writer.put_preserved(&commit("two"), b"").unwrap();
  // An object written again keeps its first place.
  assert_eq!(writer.put_tree(&inside(dir_one), b"elsewhere").unwrap(), root_one);
  let snapshot = no_refs();
  writer.finish(&snapshot).unwrap();

  assert_eq!(
    metadata_order(&root),
    [
      dir_one,
      dir_two,
      odd,
      root_one,
      root_two,
      commit_one,
      commit_two,
      NativeId::of(Type::Snapshot, &snapshot.encode()),
    ]
  );
  // The metadata held until the container closed is gone with the staging.
  assert_eq!(
    listing(&root.join(".cst")),
    ["aliases", "format", "objects", "snapshot"].map(String::from).into()
  );
  let store = Store::open(&root).unwrap();
  assert_eq!(store.read(&root_two).unwrap().kind, Type::Tree);
  std::fs::remove_dir_all(&root).unwrap();
}

#[test]
fn an_import_that_does_not_finish_leaves_no_held_metadata() {
  let hold_a_tree = |writer: &mut StoreWriter| {
    let content = writer.put_content(b"kept back\n").unwrap();
    let tree = Tree::from_entries(vec![Entry {
      name: b"f".to_vec(),
      kind: Kind::File,
      target: Target::Native(content),
    }])
    .unwrap();
    writer.put_tree(&tree, b"").unwrap();
  };
  // A new store holds it in its staging directory, which import removes.
  let root = scratch("held-failure");
  let mut writer = StoreWriter::create(&root, GitAlgorithm::Sha1).unwrap();
  hold_a_tree(&mut writer);
  assert!(root.join(".cst-import/import.metadata").is_file(), "the tree is held in the staging");
  drop(writer);
  assert!(!root.join(".cst-import/import.metadata").exists());
  std::fs::remove_dir_all(&root).unwrap();

  // An existing store holds it beside the lock, and is left as it was.
  let writer = StoreWriter::create(&root, GitAlgorithm::Sha1).unwrap();
  writer.finish(&no_refs()).unwrap();
  let before = listing(&root.join(".cst"));
  let mut writer = StoreWriter::open(&root, GitAlgorithm::Sha1).unwrap();
  hold_a_tree(&mut writer);
  assert!(root.join(".cst/import.metadata").is_file(), "the tree is held beside the lock");
  drop(writer);
  assert_eq!(listing(&root.join(".cst")), before);
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
fn content_under_32_kib_is_stored_whole_even_when_the_chunker_would_cut_it() {
  let root = scratch("whole-under-32k");
  let mut writer = StoreWriter::create(&root, GitAlgorithm::Sha1).unwrap();
  let below = varied(32_767, 11);
  let at = varied(32_768, 11);
  // Both would be cut into several chunks if they were chunked.
  assert!(causet_store::chunker::chunks(&below).count() > 1);
  assert!(causet_store::chunker::chunks(&at).count() > 1);
  let whole = writer.put_content(&below).unwrap();
  let listed = writer.put_content(&at).unwrap();
  writer.finish(&no_refs()).unwrap();
  let store = Store::open(&root).unwrap();
  assert_eq!(form(&store, &whole), Form::Body, "32,767 bytes are stored as their bytes");
  assert_eq!(form(&store, &listed), Form::ChunkList, "32,768 bytes are stored as a chunk list");
  assert_eq!(store.read(&whole).unwrap().body, below);
  assert_eq!(store.read(&listed).unwrap().body, at);
  std::fs::remove_dir_all(&root).unwrap();
}

#[test]
fn damage_to_a_container_is_reported_as_corruption() {
  let root = scratch("damaged");
  let mut writer = StoreWriter::create(&root, GitAlgorithm::Sha1).unwrap();
  let id = writer.put_content(&varied(10_000, 3)).unwrap();
  writer.finish(&no_refs()).unwrap();
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

  std::fs::remove_dir_all(&root).unwrap();
}

#[test]
fn a_store_of_another_version_is_refused_by_its_version() {
  let root = scratch("version");
  let mut writer = StoreWriter::create(&root, GitAlgorithm::Sha1).unwrap();
  writer.put_content(b"hello\n").unwrap();
  writer.finish(&no_refs()).unwrap();
  assert!(Store::open(&root).is_ok());
  for (version, marker) in [
    ("0", b"causet-native-store 0\n".as_slice()),
    ("2", b"causet-native-store 2\n".as_slice()),
  ] {
    std::fs::write(root.join(".cst/format"), marker).unwrap();
    match Store::open(&root) {
      Err(StoreError::Unsupported(message)) => {
        assert!(message.contains(&format!("format version {version}")), "{message}");
        assert!(message.contains("reads only version 1"), "{message}");
        assert!(message.contains("import the repository again into a new directory"), "{message}");
      }
      other => panic!("{version}: {:?}", other.map(|_| ())),
    }
  }
  for marker in [b"something else\n".as_slice(), b"causet-native-store 01\n"] {
    std::fs::write(root.join(".cst/format"), marker).unwrap();
    match Store::open(&root) {
      Err(StoreError::Unsupported(message)) => {
        assert!(message.contains("the only format this build reads"), "{message}")
      }
      other => panic!("{:?}", other.map(|_| ())),
    }
  }

  // A version 1 store holding a container of another version is corrupt.
  std::fs::write(root.join(".cst/format"), b"causet-native-store 1\n").unwrap();
  let container = std::fs::read_dir(root.join(".cst/objects"))
    .unwrap()
    .map(|entry| entry.unwrap().path())
    .find(|path| path.extension().is_some_and(|extension| extension == "cstc"))
    .unwrap();
  let mut bytes = std::fs::read(&container).unwrap();
  bytes[8] = 0x00;
  std::fs::write(&container, &bytes).unwrap();
  match Store::open(&root) {
    Err(StoreError::Corrupt(message)) => assert!(message.contains("not version 1's"), "{message}"),
    other => panic!("{:?}", other.map(|_| ())),
  }
  std::fs::remove_dir_all(&root).unwrap();
}

/// A store holding exactly these records, written past the store's own rules.
/// With them, a snapshot with no refs, which every store has.
fn crafted(name: &str, records: &[(NativeId, Type, Form, Vec<u8>)]) -> PathBuf {
  let root = scratch(name);
  let objects = root.join(".cst").join("objects");
  std::fs::create_dir_all(&objects).unwrap();
  std::fs::write(root.join(".cst").join("format"), causet_store::store::FORMAT).unwrap();
  let snapshot = no_refs().encode();
  let snapshot_id = NativeId::of(Type::Snapshot, &snapshot);
  std::fs::write(
    root.join(".cst").join("snapshot"),
    format!("{}\n", snapshot_id.hex()),
  )
  .unwrap();
  let mut container = ContainerWriter::create(&objects).unwrap();
  container
    .add(&snapshot_id, Type::Snapshot, Form::Body, &snapshot)
    .unwrap();
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
  writer.finish(&no_refs()).unwrap();
  let objects = root.join(".cst/objects");
  let container = std::fs::read_dir(&objects).unwrap().next().unwrap().unwrap().path();
  std::fs::rename(&container, objects.join(format!("{}.cstc", "0".repeat(64)))).unwrap();
  assert!(matches!(Store::open(&root), Err(StoreError::Corrupt(_))));
  std::fs::remove_dir_all(&root).unwrap();
}

#[test]
fn a_snapshot_the_store_does_not_hold_or_that_names_no_imported_object_is_corrupt() {
  let root = scratch("snapshot");
  let mut writer = StoreWriter::create(&root, GitAlgorithm::Sha1).unwrap();
  let blob = writer.put_content(b"x").unwrap();
  let unaliased = Snapshot::new(
    GitAlgorithm::Sha1,
    vec![Ref {
      name: b"refs/heads/main".to_vec(),
      target: RefTarget::Direct(blob),
    }],
  )
  .unwrap();
  assert!(matches!(writer.finish(&unaliased), Err(StoreError::Codec(_))));
  std::fs::remove_dir_all(&root).unwrap();

  let mut writer = StoreWriter::create(&root, GitAlgorithm::Sha1).unwrap();
  writer.put_content(b"x").unwrap();
  writer.finish(&no_refs()).unwrap();
  let file = root.join(".cst/snapshot");
  for damaged in [
    format!("{}\n", "0".repeat(64)),
    format!("{}\n", NativeId::of(Type::Content, b"x").hex()),
    "not hex\n".to_string(),
  ] {
    std::fs::write(&file, damaged.as_bytes()).unwrap();
    assert!(matches!(Store::open(&root), Err(StoreError::Corrupt(_))), "{damaged}");
  }
  std::fs::remove_file(&file).unwrap();
  assert!(matches!(Store::open(&root), Err(StoreError::Corrupt(_))));
  std::fs::remove_dir_all(&root).unwrap();

  // A snapshot naming an object that the store holds but did not import.
  let held = b"y".to_vec();
  let held_id = NativeId::of(Type::Content, &held);
  let root = crafted("snapshot-unaliased", &[(held_id, Type::Content, Form::Body, held)]);
  let snapshot = Snapshot {
    algorithm: GitAlgorithm::Sha1,
    refs: vec![Ref {
      name: b"HEAD".to_vec(),
      target: RefTarget::Direct(held_id),
    }],
  }
  .encode();
  let objects = root.join(".cst/objects");
  for entry in std::fs::read_dir(&objects).unwrap() {
    std::fs::remove_file(entry.unwrap().path()).unwrap();
  }
  let snapshot_id = NativeId::of(Type::Snapshot, &snapshot);
  let mut container = ContainerWriter::create(&objects).unwrap();
  container.add(&snapshot_id, Type::Snapshot, Form::Body, &snapshot).unwrap();
  container.add(&held_id, Type::Content, Form::Body, b"y").unwrap();
  container.finish().unwrap();
  std::fs::write(root.join(".cst/snapshot"), format!("{}\n", snapshot_id.hex())).unwrap();
  let store = Store::open(&root).unwrap();
  assert!(matches!(store.refs(), Err(StoreError::Corrupt(_))));
  std::fs::remove_dir_all(&root).unwrap();
}

/// An ID sharing `id`'s short reference (objects.md §1.3): only its last
/// byte differs, as a collision in the first 8 bytes would.
fn sharing(id: &NativeId) -> NativeId {
  let mut digest = id.0;
  digest[31] ^= 0xff;
  NativeId(digest)
}

/// Adds a container to the store at `root` whose index lists each of `ids`
/// as content absent by promise: index names a reader must consider.
fn add_absent(root: &std::path::Path, ids: &[NativeId]) {
  let mut container = ContainerWriter::create(&root.join(".cst").join("objects")).unwrap();
  for id in ids {
    container.add_absent(id, Type::Content, causet_store::container::ABSENT_BY_PROMISE);
  }
  container.finish().unwrap();
}

fn file(name: &str, target: NativeId) -> Entry {
  Entry {
    name: name.as_bytes().to_vec(),
    kind: Kind::File,
    target: Target::Native(target),
  }
}

#[test]
fn a_tree_is_stored_in_short_references_and_reads_back_beside_an_entry_sharing_its_prefix() {
  let root = scratch("short-references");
  let mut writer = StoreWriter::create(&root, GitAlgorithm::Sha1).unwrap();
  let hello = writer.put_content(b"hello\n").unwrap();
  let inner = Tree::from_entries(vec![file("hello.txt", hello)]).unwrap();
  let inner_id = writer.put_tree(&inner, b"").unwrap();
  let outer = Tree::from_entries(vec![
    file("a", hello),
    Entry {
      name: b"dir".to_vec(),
      kind: Kind::Tree,
      target: Target::Native(inner_id),
    },
    Entry {
      name: b"module".to_vec(),
      kind: Kind::Submodule,
      target: Target::Git(causet_store::id::GitId::new(GitAlgorithm::Sha1, vec![1; 20])),
    },
  ])
  .unwrap();
  let outer_id = writer.put_tree(&outer, b"").unwrap();
  writer.finish(&no_refs()).unwrap();
  let store = Store::open(&root).unwrap();
  assert_eq!(form(&store, &outer_id), Form::ShortReferences);
  assert_eq!(form(&store, &inner_id), Form::ShortReferences);
  assert_eq!(store.read(&outer_id).unwrap().body, outer.encode());

  // An absent entry shares the content's 8 bytes: two candidates, and the
  // reader keeps the one that verifies.
  add_absent(&root, &[sharing(&hello)]);
  let store = Store::open(&root).unwrap();
  assert_eq!(store.candidates(&hello.short()), vec![sharing(&hello), hello], "in order");
  assert_eq!(store.read(&outer_id).unwrap().body, outer.encode());
  assert_eq!(store.read(&inner_id).unwrap().body, inner.encode());
  let found = causet_store::verify::verify(&store).unwrap();
  assert!(found.problems.is_empty(), "{:?}", found.problems);
  std::fs::remove_dir_all(&root).unwrap();
}

#[test]
fn an_incremental_import_stores_a_tree_naming_an_earlier_containers_objects() {
  let root = scratch("short-incremental");
  let mut writer = StoreWriter::create(&root, GitAlgorithm::Sha1).unwrap();
  let hello = writer.put_content(b"hello\n").unwrap();
  writer.finish(&no_refs()).unwrap();
  let mut writer = StoreWriter::open(&root, GitAlgorithm::Sha1).unwrap();
  let tree = Tree::from_entries(vec![file("hello.txt", hello)]).unwrap();
  let id = writer.put_tree(&tree, b"").unwrap();
  writer.finish(&no_refs()).unwrap();
  let store = Store::open(&root).unwrap();
  assert_eq!(store.read(&id).unwrap().body, tree.encode());
  std::fs::remove_dir_all(&root).unwrap();
}

#[test]
fn an_import_refuses_a_row_for_an_object_the_store_holds_under_another_git_id() {
  let root = scratch("alias-one-to-one");
  let mut writer = StoreWriter::create(&root, GitAlgorithm::Sha1).unwrap();
  let hello = writer.put_content(b"hello\n").unwrap();
  writer.alias(vec![0xce; 20], hello);
  writer.finish(&no_refs()).unwrap();
  let before = std::fs::read(root.join(".cst/aliases/sha1")).unwrap();
  // The store's row holds only hello's short reference, so the import checks
  // its own whole rows against the object each held row resolves to.
  let mut writer = StoreWriter::open(&root, GitAlgorithm::Sha1).unwrap();
  writer.alias(vec![0x11; 20], hello);
  match writer.finish(&no_refs()) {
    Err(StoreError::Corrupt(why)) => assert_eq!(why, "two alias rows have the same native ID"),
    other => panic!("{other:?}"),
  }
  // The same row again is no second row.
  let mut writer = StoreWriter::open(&root, GitAlgorithm::Sha1).unwrap();
  writer.alias(vec![0xce; 20], hello);
  writer.finish(&no_refs()).unwrap();
  assert_eq!(std::fs::read(root.join(".cst/aliases/sha1")).unwrap(), before);
  std::fs::remove_dir_all(&root).unwrap();
}

#[test]
fn a_tree_needing_more_than_65536_choices_is_refused_naming_it_and_one_needing_65536_reads() {
  let root = scratch("short-bound");
  let mut writer = StoreWriter::create(&root, GitAlgorithm::Sha1).unwrap();
  let targets: Vec<NativeId> = (0..17u8).map(|n| writer.put_content(&[n]).unwrap()).collect();
  writer.finish(&no_refs()).unwrap();
  // Every target's reference then has two candidates.
  add_absent(&root, &targets.iter().map(sharing).collect::<Vec<_>>());
  let entries = |count: usize| -> Tree {
    Tree::from_entries(
      targets[..count]
        .iter()
        .enumerate()
        .map(|(n, target)| file(&format!("f{n:02}"), *target))
        .collect(),
    )
    .unwrap()
  };

  let mut writer = StoreWriter::open(&root, GitAlgorithm::Sha1).unwrap();
  let refused = entries(17);
  let refused_id = NativeId::of(Type::Tree, &refused.encode());
  match writer.put_tree(&refused, b"") {
    Err(StoreError::TooLarge(why)) => assert_eq!(
      why,
      format!("the tree {refused_id}'s short references would allow 131072 choices, and a tree may need at most 65536")
    ),
    other => panic!("{other:?}"),
  }
  drop(writer);

  // 16 entries of two candidates each are 65,536 choices, the bound itself.
  let mut writer = StoreWriter::open(&root, GitAlgorithm::Sha1).unwrap();
  let kept = entries(16);
  let kept_id = writer.put_tree(&kept, b"").unwrap();
  writer.finish(&no_refs()).unwrap();
  let store = Store::open(&root).unwrap();
  assert_eq!(store.read(&kept_id).unwrap().body, kept.encode());
  std::fs::remove_dir_all(&root).unwrap();
}

#[test]
fn a_tree_naming_an_object_the_store_does_not_hold_is_refused() {
  let root = scratch("short-unheld");
  let mut writer = StoreWriter::create(&root, GitAlgorithm::Sha1).unwrap();
  let tree = Tree::from_entries(vec![file("gone", NativeId::of(Type::Content, b"never written"))]).unwrap();
  let id = NativeId::of(Type::Tree, &tree.encode());
  match writer.put_tree(&tree, b"") {
    Err(StoreError::Codec(why)) => {
      assert_eq!(why, format!("the tree {id} names an object the store does not hold"))
    }
    other => panic!("{other:?}"),
  }
  drop(writer);
  std::fs::remove_dir_all(&root).unwrap();
}

#[test]
fn a_preserved_git_tree_is_stored_as_its_body() {
  let root = scratch("preserved-body");
  let mut writer = StoreWriter::create(&root, GitAlgorithm::Sha1).unwrap();
  let preserved = Preserved {
    algorithm: GitAlgorithm::Sha1,
    kind: GitKind::Tree,
    payload: b"040000 sub\0aaaaaaaaaaaaaaaaaaaa".to_vec(),
  };
  let id = writer.put_preserved(&preserved, b"").unwrap();
  writer.finish(&no_refs()).unwrap();
  let store = Store::open(&root).unwrap();
  assert_eq!(form(&store, &id), Form::Body);
  assert_eq!(store.read(&id).unwrap().body, preserved.encode());
  std::fs::remove_dir_all(&root).unwrap();
}
