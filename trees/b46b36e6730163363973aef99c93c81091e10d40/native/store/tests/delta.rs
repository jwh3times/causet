//! Large-file deltas (storage.md §5): each version of a large file reads back
//! byte for byte, no chain passes the depth limit, a version is a delta only
//! when that is smaller than its chunks, content IDs do not depend on deltas,
//! and a delta that breaks the contract is reported as corruption.

use causet_store::StoreError;
use causet_store::container::{ABSENT_BY_PROMISE, ContainerWriter, Form};
use causet_store::delta::{self, Delta};
use causet_store::id::{GitAlgorithm, NativeId, Type};
use causet_store::objects::{ChunkList, Snapshot};
use causet_store::store::{Base, Store, StoreWriter};
use causet_store::verify::verify;
use std::path::PathBuf;

fn scratch(name: &str) -> PathBuf {
  let directory =
    std::env::temp_dir().join(format!("causet-delta-test-{}-{name}", std::process::id()));
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

fn no_refs() -> Snapshot {
  Snapshot::new(GitAlgorithm::Sha1, Vec::new()).unwrap()
}

const SIZE: usize = 1_100_000;

/// `count` versions of a file over 1 MiB, each a small edit of the one before.
fn versions(count: usize) -> Vec<Vec<u8>> {
  let mut current = varied(SIZE, 1);
  (0..count)
    .map(|n| {
      let at = (n * 97_000) % (SIZE - 100);
      current[at..at + 16].copy_from_slice(&varied(16, 100 + n as u32));
      current.clone()
    })
    .collect()
}

/// Stores each version against the one before, as import does a file's.
fn put_chain(writer: &mut StoreWriter, versions: &[Vec<u8>], before: Option<&[u8]>) -> Vec<NativeId> {
  let mut previous = before.map(<[u8]>::to_vec);
  versions
    .iter()
    .map(|bytes| {
      let base = previous.as_ref().map(|base| Base {
        id: NativeId::of(Type::Content, base),
        bytes: base,
      });
      let id = writer.put_version(bytes, base).unwrap();
      previous = Some(bytes.clone());
      id
    })
    .collect()
}

fn form(store: &Store, id: &NativeId) -> Form {
  store
    .present()
    .into_iter()
    .find(|(found, _, _)| found == id)
    .map(|(_, _, form)| form)
    .unwrap()
}

#[test]
fn every_version_reads_back_byte_exact_and_no_chain_passes_8() {
  let root = scratch("chain");
  let versions = versions(12);
  let mut writer = StoreWriter::create(&root, GitAlgorithm::Sha1).unwrap();
  let ids = put_chain(&mut writer, &versions, None);
  writer.finish(&no_refs()).unwrap();
  let store = Store::open(&root).unwrap();
  let depths: Vec<usize> = ids.iter().map(|id| store.depth(id).unwrap()).collect();
  // The ninth delta would be 9 deep, so that version starts a new chain.
  assert_eq!(depths, [0, 1, 2, 3, 4, 5, 6, 7, 8, 0, 1, 2]);
  for (n, (id, bytes)) in ids.iter().zip(&versions).enumerate() {
    let expected = if depths[n] == 0 { Form::ChunkList } else { Form::Delta };
    assert_eq!(form(&store, id), expected, "version {n}");
    let read = store.read(id).unwrap();
    assert_eq!(read.kind, Type::Content);
    assert!(read.body == *bytes, "version {n} reads back as written");
    assert_eq!(store.content_size(id).unwrap(), bytes.len() as u64);
  }
  let found = verify(&store).unwrap();
  assert!(found.problems.is_empty(), "{:?}", found.problems);
  std::fs::remove_dir_all(&root).unwrap();
}

#[test]
fn content_ids_are_the_same_with_or_without_deltas() {
  let versions = versions(3);
  let with = scratch("with");
  let mut writer = StoreWriter::create(&with, GitAlgorithm::Sha1).unwrap();
  let delta_ids = put_chain(&mut writer, &versions, None);
  writer.finish(&no_refs()).unwrap();
  let without = scratch("without");
  let mut writer = StoreWriter::create(&without, GitAlgorithm::Sha1).unwrap();
  let plain_ids: Vec<NativeId> = versions.iter().map(|bytes| writer.put_content(bytes).unwrap()).collect();
  writer.finish(&no_refs()).unwrap();
  assert_eq!(delta_ids, plain_ids);
  for (id, bytes) in plain_ids.iter().zip(&versions) {
    assert_eq!(*id, NativeId::of(Type::Content, bytes));
  }
  let (with_store, without_store) = (Store::open(&with).unwrap(), Store::open(&without).unwrap());
  assert_eq!(form(&with_store, &delta_ids[1]), Form::Delta);
  assert_eq!(form(&without_store, &plain_ids[1]), Form::ChunkList);
  std::fs::remove_dir_all(&with).unwrap();
  std::fs::remove_dir_all(&without).unwrap();
}

#[test]
fn a_version_is_a_delta_only_when_smaller_than_its_chunks() {
  let root = scratch("smaller");
  let mut writer = StoreWriter::create(&root, GitAlgorithm::Sha1).unwrap();
  let first = varied(SIZE, 1);
  let other = varied(SIZE, 2);
  let mut edited = first.clone();
  edited[500_000..500_016].copy_from_slice(&[0xab; 16]);
  writer.put_content(&first).unwrap();
  writer.put_content(&other).unwrap();
  // Against `other`, a delta is as large as the content, but nearly every
  // chunk of `edited` is held already, so its chunks cost the list and one.
  let unlike = writer
    .put_version(&edited, Some(Base { id: NativeId::of(Type::Content, &other), bytes: &other }))
    .unwrap();
  // Half of it new: the delta is larger than the chunk list, but smaller than
  // the list and a frame of its new chunks.
  let half = [&first[..SIZE / 2], &varied(SIZE / 2, 5)[..]].concat();
  let half = writer
    .put_version(&half, Some(Base { id: NativeId::of(Type::Content, &first), bytes: &first }))
    .unwrap();
  // Under 1 MiB, never a delta, however alike.
  let small_base = varied(600_000, 3);
  let mut small = small_base.clone();
  small[1000] ^= 1;
  let small_base_id = writer.put_content(&small_base).unwrap();
  let small = writer
    .put_version(&small, Some(Base { id: small_base_id, bytes: &small_base }))
    .unwrap();
  // A base the store does not hold is no base.
  let unheld = varied(SIZE, 4);
  let mut after_unheld = unheld.clone();
  after_unheld[10] ^= 1;
  let after_unheld = writer
    .put_version(&after_unheld, Some(Base { id: NativeId::of(Type::Content, &unheld), bytes: &unheld }))
    .unwrap();
  // A base that is not what it names is refused.
  let mut wrong = first.clone();
  wrong[0] ^= 1;
  assert!(matches!(
    writer.put_version(&wrong, Some(Base { id: NativeId::of(Type::Content, &first), bytes: &other })),
    Err(StoreError::Codec(_))
  ));
  writer.finish(&no_refs()).unwrap();
  let store = Store::open(&root).unwrap();
  assert_eq!(form(&store, &unlike), Form::ChunkList);
  assert_eq!(form(&store, &half), Form::Delta);
  assert_eq!(form(&store, &small), Form::ChunkList);
  assert_eq!(form(&store, &after_unheld), Form::ChunkList);
  std::fs::remove_dir_all(&root).unwrap();
}

#[test]
fn a_store_added_to_continues_a_chain_it_holds() {
  let root = scratch("added");
  let versions = versions(10);
  let mut writer = StoreWriter::create(&root, GitAlgorithm::Sha1).unwrap();
  put_chain(&mut writer, &versions[..6], None);
  writer.finish(&no_refs()).unwrap();
  let mut writer = StoreWriter::open(&root, GitAlgorithm::Sha1).unwrap();
  let added = put_chain(&mut writer, &versions[6..], Some(&versions[5]));
  writer.finish(&no_refs()).unwrap();
  let store = Store::open(&root).unwrap();
  let depths: Vec<usize> = added.iter().map(|id| store.depth(id).unwrap()).collect();
  assert_eq!(depths, [6, 7, 8, 0]);
  for (id, bytes) in added.iter().zip(&versions[6..]) {
    assert!(store.read(id).unwrap().body == *bytes);
  }
  std::fs::remove_dir_all(&root).unwrap();
}

/// A store holding these records past the writer's rules: each `(id, form,
/// record)` is content, a delta in a stored frame, anything else in a zstd
/// frame; `absent` are held absent by promise.
fn crafted(name: &str, records: &[(NativeId, Form, Vec<u8>)], absent: &[NativeId]) -> PathBuf {
  let root = scratch(name);
  let objects = root.join(".cst").join("objects");
  std::fs::create_dir_all(&objects).unwrap();
  std::fs::write(root.join(".cst").join("format"), causet_store::store::FORMAT).unwrap();
  let snapshot = no_refs().encode();
  let snapshot_id = NativeId::of(Type::Snapshot, &snapshot);
  std::fs::write(root.join(".cst").join("snapshot"), format!("{}\n", snapshot_id.hex())).unwrap();
  let mut container = ContainerWriter::create(&objects).unwrap();
  container.add(&snapshot_id, Type::Snapshot, Form::Body, &snapshot).unwrap();
  for (id, form, record) in records {
    if *form == Form::Delta {
      container.add_stored(id, Type::Content, *form, record).unwrap();
    } else {
      container.add(id, Type::Content, *form, record).unwrap();
    }
  }
  for id in absent {
    container.add_absent(id, Type::Content, ABSENT_BY_PROMISE);
  }
  container.finish().unwrap();
  root
}

fn delta_of(base: &[u8], content: &[u8]) -> Vec<u8> {
  Delta {
    base: NativeId::of(Type::Content, base),
    size: content.len() as u64,
    data: delta::compress(base, content).unwrap(),
  }
  .encode()
}

#[test]
fn a_delta_that_breaks_the_contract_is_corruption() {
  let base = b"the base version of a file".to_vec();
  let base_id = NativeId::of(Type::Content, &base);
  let content = b"the next version of a file".to_vec();
  let id = NativeId::of(Type::Content, &content);
  let record = delta_of(&base, &content);
  // Nine versions, each a delta of the one before: the last is 9 deep.
  let chain: Vec<Vec<u8>> = (0..10).map(|n| format!("version {n} of a file").into_bytes()).collect();
  let mut deep: Vec<(NativeId, Form, Vec<u8>)> = vec![(NativeId::of(Type::Content, &chain[0]), Form::Body, chain[0].clone())];
  for pair in chain.windows(2) {
    deep.push((NativeId::of(Type::Content, &pair[1]), Form::Delta, delta_of(&pair[0], &pair[1])));
  }
  let deepest = NativeId::of(Type::Content, &chain[9]);
  let eighth = NativeId::of(Type::Content, &chain[8]);
  let mut wrong_size = Delta::decode(&record).unwrap();
  wrong_size.size += 1;
  let mut damaged = Delta::decode(&record).unwrap();
  damaged.data.push(0);
  // A chunk list one of whose chunks is stored as a delta.
  let chunk = vec![b'x'; 40];
  let chunk_id = NativeId::of(Type::Content, &chunk);
  let listed = [chunk.clone(), content.clone()].concat();
  let list = ChunkList {
    size: listed.len() as u64,
    chunks: vec![(chunk_id, chunk.len() as u64), (id, content.len() as u64)],
  }
  .encode();
  let listed_id = NativeId::of(Type::Content, &listed);
  let cases: Vec<(&str, NativeId, Vec<(NativeId, Form, Vec<u8>)>, Vec<NativeId>)> = vec![
    ("missing-base", id, vec![(id, Form::Delta, record.clone())], vec![]),
    ("absent-base", id, vec![(id, Form::Delta, record.clone())], vec![base_id]),
    ("too-deep", deepest, deep.clone(), vec![]),
    ("wrong-size", id, vec![(base_id, Form::Body, base.clone()), (id, Form::Delta, wrong_size.encode())], vec![]),
    ("not-one-frame", id, vec![(base_id, Form::Body, base.clone()), (id, Form::Delta, damaged.encode())], vec![]),
    (
      "wrong-base",
      id,
      vec![(base_id, Form::Body, base.clone()), (id, Form::Delta, delta_of(&base, b"some other version"))],
      vec![],
    ),
    (
      "delta-chunk",
      listed_id,
      vec![
        (base_id, Form::Body, base.clone()),
        (chunk_id, Form::Body, chunk.clone()),
        (id, Form::Delta, record.clone()),
        (listed_id, Form::ChunkList, list),
      ],
      vec![],
    ),
  ];
  for (name, read, records, absent) in cases {
    let root = crafted(name, &records, &absent);
    let store = Store::open(&root).unwrap();
    assert!(matches!(store.read(&read), Err(StoreError::Corrupt(_))), "{name}: {:?}", store.read(&read));
    let found = verify(&store).unwrap();
    assert!(
      found.problems.iter().any(|problem| problem.starts_with(&format!("{read}, its copy in"))),
      "{name}: {:?}",
      found.problems
    );
    std::fs::remove_dir_all(&root).unwrap();
  }
  // A base stored as a chunk list naming absent content leaves its delta
  // unverified, not corrupt.
  let (first, second) = (vec![b'a'; 30], vec![b'b'; 30]);
  let whole = [first.clone(), second.clone()].concat();
  let whole_id = NativeId::of(Type::Content, &whole);
  let pieces = ChunkList {
    size: whole.len() as u64,
    chunks: vec![(NativeId::of(Type::Content, &first), 30), (NativeId::of(Type::Content, &second), 30)],
  }
  .encode();
  let next = [whole.clone(), b"and more".to_vec()].concat();
  let next_id = NativeId::of(Type::Content, &next);
  let root = crafted(
    "absent-chunk",
    &[
      (whole_id, Form::ChunkList, pieces),
      (NativeId::of(Type::Content, &first), Form::Body, first.clone()),
      (next_id, Form::Delta, delta_of(&whole, &next)),
    ],
    &[NativeId::of(Type::Content, &second)],
  );
  let store = Store::open(&root).unwrap();
  assert!(matches!(store.read(&next_id), Err(StoreError::Absent(_))));
  let found = verify(&store).unwrap();
  assert!(found.problems.is_empty(), "{:?}", found.problems);
  assert_eq!(found.absent_by_promise, [NativeId::of(Type::Content, &second)]);
  std::fs::remove_dir_all(&root).unwrap();
  // At 8 deep, the same chain reads and verifies.
  let root = crafted("eight-deep", &deep[..9], &[]);
  let store = Store::open(&root).unwrap();
  assert_eq!(store.depth(&eighth).unwrap(), 8);
  assert_eq!(store.read(&eighth).unwrap().body, chain[8]);
  assert!(verify(&store).unwrap().problems.is_empty());
  std::fs::remove_dir_all(&root).unwrap();
}
