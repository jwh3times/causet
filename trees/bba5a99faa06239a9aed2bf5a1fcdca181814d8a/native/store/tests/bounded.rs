//! Opening a store and answering one lookup reads a bounded part of it
//! (#331): a reader checks only what is constant-cost to check, plus the bytes
//! each lookup touches. The whole-file checks are `cst fsck`'s and the
//! reconstruction check's (objects.md §9.1; storage.md §4.1).

use causet_store::StoreError;
use causet_store::container::{ABSENT_BY_PROMISE, ContainerWriter};
use causet_store::id::{GitAlgorithm, NativeId, Type};
use causet_store::objects::Snapshot;
use causet_store::store::{Store, StoreWriter};
use std::path::{Path, PathBuf};

fn scratch(name: &str) -> PathBuf {
  let directory =
    std::env::temp_dir().join(format!("causet-store-bounded-{}-{name}", std::process::id()));
  let _ = std::fs::remove_dir_all(&directory);
  directory
}

/// A Git digest for the `n`th object, spread over every fan-out bucket.
fn git_digest(n: u32) -> Vec<u8> {
  let mut digest = causet_model::sha256::digest(&n.to_be_bytes())[..20].to_vec();
  digest[19] ^= 0x5a;
  digest
}

/// A store of `count` small content objects, each with an alias row, and the
/// first object's native ID and Git digest.
fn store_of(root: &Path, count: u32) -> (NativeId, Vec<u8>) {
  let mut writer = StoreWriter::create(root, GitAlgorithm::Sha1).unwrap();
  let mut first = None;
  for n in 0..count {
    let id = writer.put_content(format!("object {n}\n").as_bytes()).unwrap();
    writer.alias(git_digest(n), id);
    first.get_or_insert((id, git_digest(n)));
  }
  writer.finish(&Snapshot::new(GitAlgorithm::Sha1, Vec::new()).unwrap()).unwrap();
  first.unwrap()
}

/// Every byte a reader may read to open a one-container SHA-1 store and
/// answer one lookup by Git ID and one by native ID, whatever the store's
/// object count:
/// - the root marker (22) and `snapshot` (65);
/// - the alias file's header and both fan-outs (16 + 2 × 1,024);
/// - the container's header, footer, index counts and fan-out (16 + 72 + 24 + 1,024);
/// - four binary searches (the snapshot's entry, the Git ID's row, its
///   short reference's candidates, the native ID's entry), each at most 33
///   probes of a 32-byte name or a 28-byte row, a few names read past each,
///   and each found entry's record (16) and frame (24).
const BOUND: u64 = 22 + 65 + 16 + 2 * 1024 + 16 + 72 + 24 + 1024 + 4 * (33 * 32 + 4 * 32 + 16 + 24);

#[test]
fn opening_a_store_and_one_lookup_read_the_same_bounded_bytes_whatever_its_size() {
  let mut read = Vec::new();
  for (name, count) in [("small", 3), ("large", 6_000)] {
    let root = scratch(name);
    let (id, digest) = store_of(&root, count);
    let store = Store::open(&root).unwrap();
    assert_eq!(store.native(GitAlgorithm::Sha1, &digest).unwrap(), Some(id));
    assert_eq!(store.held(&id).unwrap(), Some(Type::Content));
    let bytes = store.bytes_read();
    assert!(bytes <= BOUND, "{name}: {bytes} bytes read, past the bound of {BOUND}");
    let stored: u64 = ["aliases/sha1", "objects"]
      .iter()
      .map(|part| size_of(&root.join(".cst").join(part)))
      .sum();
    read.push((count, bytes, stored));
    drop(store);
    std::fs::remove_dir_all(&root).unwrap();
  }
  // The large store's alias file and container are hundreds of kilobytes,
  // and it reads under 1% of them.
  let (_, large, stored) = read[1];
  assert!(stored > 400_000, "{read:?}");
  assert!(large < stored / 100, "{read:?}");
}

fn size_of(path: &Path) -> u64 {
  if path.is_dir() {
    std::fs::read_dir(path).unwrap().map(|entry| size_of(&entry.unwrap().path())).sum()
  } else {
    std::fs::metadata(path).unwrap().len()
  }
}

fn corrupt(result: Result<impl std::fmt::Debug, StoreError>) -> String {
  match result {
    Err(StoreError::Corrupt(why)) => why,
    other => panic!("{other:?}"),
  }
}

/// The store's one container.
fn container_of(root: &Path) -> PathBuf {
  std::fs::read_dir(root.join(".cst/objects"))
    .unwrap()
    .map(|entry| entry.unwrap().path())
    .find(|path| path.extension().is_some_and(|extension| extension == "cstc"))
    .unwrap()
}

/// Rewrites a byte of a file.
fn flip(path: &Path, at: usize) {
  let mut bytes = std::fs::read(path).unwrap();
  bytes[at] ^= 0x01;
  std::fs::write(path, bytes).unwrap();
}

/// Where a container's index begins, and the position of `id` in its names.
fn index_layout(path: &Path, id: &NativeId) -> (usize, usize, usize) {
  let bytes = std::fs::read(path).unwrap();
  let footer = bytes.len() - 72;
  let index = u64::from_be_bytes(bytes[footer..footer + 8].try_into().unwrap()) as usize;
  let frames = u32::from_be_bytes(bytes[index + 8..index + 12].try_into().unwrap()) as usize;
  let objects = u32::from_be_bytes(bytes[index + 12..index + 16].try_into().unwrap()) as usize;
  let names = index + 24 + 24 * frames + 1024;
  let position = (0..objects)
    .find(|at| bytes[names + 32 * at..names + 32 * at + 32] == id.0)
    .unwrap();
  (names, names + 32 * objects, position)
}

#[test]
fn a_damaged_trailer_or_index_digest_is_left_to_fsck_which_still_reports_it() {
  let root = scratch("fsck-tier");
  let (id, digest) = store_of(&root, 50);
  let aliases = root.join(".cst/aliases/sha1");
  let length = std::fs::metadata(&aliases).unwrap().len() as usize;
  flip(&aliases, length - 1);
  let container = container_of(&root);
  let length = std::fs::metadata(&container).unwrap().len() as usize;
  flip(&container, length - 72 + 8);

  // A reader checks neither, and answers.
  let store = Store::open(&root).unwrap();
  assert_eq!(store.native(GitAlgorithm::Sha1, &digest).unwrap(), Some(id));
  assert_eq!(store.read(&id).unwrap().body, b"object 0\n");

  // Verification and the reconstruction check read both whole.
  let why = corrupt(causet_store::verify::verify(&store));
  assert!(why.ends_with("sha1: its trailer does not match its bytes"), "{why}");
  let why = corrupt(causet_store::reconstruct::check(&store));
  assert!(why.ends_with("sha1: its trailer does not match its bytes"), "{why}");
  flip(&aliases, std::fs::metadata(&aliases).unwrap().len() as usize - 1);
  let why = corrupt(causet_store::verify::verify(&store));
  assert!(why.ends_with(": its index does not match the index's SHA-256"), "{why}");

  // Names out of order, under an index digest made right again.
  flip(&container, length - 72 + 8);
  let (names, _, _) = index_layout(&container, &id);
  let mut bytes = std::fs::read(&container).unwrap();
  let (first, second) = (bytes[names..names + 32].to_vec(), bytes[names + 32..names + 64].to_vec());
  bytes[names..names + 32].copy_from_slice(&second);
  bytes[names + 32..names + 64].copy_from_slice(&first);
  let footer = bytes.len() - 72;
  let index = u64::from_be_bytes(bytes[footer..footer + 8].try_into().unwrap()) as usize;
  let digest = causet_model::sha256::digest(&bytes[index..footer]);
  bytes[footer + 8..footer + 40].copy_from_slice(&digest);
  std::fs::write(&container, bytes).unwrap();
  let store = Store::open(&root).unwrap();
  let why = corrupt(causet_store::verify::verify(&store));
  assert!(why.ends_with(": its names are not in byte order, or repeat one"), "{why}");
  drop(store);
  std::fs::remove_dir_all(&root).unwrap();
}

#[test]
fn a_damaged_name_or_record_a_lookup_lands_on_is_refused_by_the_read() {
  let root = scratch("reader-tier");
  let (id, _) = store_of(&root, 50);
  let container = container_of(&root);
  let original = std::fs::read(&container).unwrap();
  let (names, records, position) = index_layout(&container, &id);

  // The name's last byte: a lookup of the name it now holds lands on the
  // entry, and the bytes it reads do not hash to it.
  flip(&container, names + 32 * position + 31);
  let mut landed = id.0;
  landed[31] ^= 0x01;
  let store = Store::open(&root).unwrap();
  let why = corrupt(store.read(&NativeId(landed)));
  assert!(why.ends_with("its bytes do not hash to its ID"), "{why}");
  // A lookup of the name it held misses, so the reader checks every index
  // whole before it answers, and the damage is found (#389).
  for why in [
    corrupt(store.read(&id)),
    corrupt(store.held(&id)),
    corrupt(store.read_known(&id)),
  ] {
    assert!(why.ends_with(": its index does not match the index's SHA-256"), "{why}");
  }
  drop(store);

  // The record's reserved byte.
  std::fs::write(&container, &original).unwrap();
  flip(&container, records + 16 * position + 3);
  let store = Store::open(&root).unwrap();
  let why = corrupt(store.read(&id));
  assert!(why.ends_with(&format!("{id}'s reserved byte is not 0")), "{why}");
  let why = corrupt(store.held(&id));
  assert!(why.ends_with(&format!("{id}'s reserved byte is not 0")), "{why}");

  // Its frame, past the frames the container has.
  std::fs::write(&container, &original).unwrap();
  flip(&container, records + 16 * position + 4);
  let store = Store::open(&root).unwrap();
  let why = corrupt(store.read(&id));
  assert!(why.ends_with(&format!("{id} names a frame the container does not have")), "{why}");
  drop(store);
  std::fs::remove_dir_all(&root).unwrap();
}

#[test]
fn an_absent_copy_is_not_answered_when_damage_hides_a_present_one() {
  let root = scratch("absent-copy");
  let (id, _) = store_of(&root, 50);
  let container = container_of(&root);
  // A second container lists the object absent by promise.
  let objects = root.join(".cst/objects");
  let mut writer = ContainerWriter::create(&objects).unwrap();
  writer.add_absent(&id, Type::Content, ABSENT_BY_PROMISE);
  writer.finish().unwrap();
  let (names, _, position) = index_layout(&container, &id);
  flip(&container, names + 32 * position + 31);
  let store = Store::open(&root).unwrap();
  let why = corrupt(store.read(&id));
  assert!(why.ends_with(": its index does not match the index's SHA-256"), "{why}");
  drop(store);
  std::fs::remove_dir_all(&root).unwrap();
}

#[test]
fn a_damaged_alias_row_a_lookup_lands_on_is_corrupt_not_a_missing_row() {
  let root = scratch("alias-row");
  let (_, digest) = store_of(&root, 50);
  // The row's short reference, which follows its 20-byte Git digest. The
  // trailer no longer matches, which only verification reads.
  let aliases = root.join(".cst/aliases/sha1");
  let row = alias_row(&std::fs::read(&aliases).unwrap(), &digest);
  flip(&aliases, ROWS + ROW * row + 20 + 7);
  let store = Store::open(&root).unwrap();
  let why = corrupt(store.native(GitAlgorithm::Sha1, &digest));
  assert!(why.contains("a short reference no index entry's name begins with"), "{why}");
  // A Git ID of no length has no row.
  assert_eq!(store.native(GitAlgorithm::Sha1, &[]).unwrap(), None);
  drop(store);
  std::fs::remove_dir_all(&root).unwrap();
}

/// Where a SHA-1 alias file's rows begin, and each row's width: a 20-byte
/// Git digest and an 8-byte short reference (objects.md §9.1).
const ROWS: usize = 16 + 1024;
const ROW: usize = 28;

/// A SHA-1 alias file's row count.
fn alias_count(bytes: &[u8]) -> usize {
  u32::from_be_bytes(bytes[12..16].try_into().unwrap()) as usize
}

/// Where a SHA-1 alias file's native order begins, after its native fan-out.
fn native_order(bytes: &[u8]) -> usize {
  ROWS + ROW * alias_count(bytes) + 1024
}

/// The row of a Git digest in a SHA-1 alias file's bytes.
fn alias_row(bytes: &[u8], digest: &[u8]) -> usize {
  (0..alias_count(bytes))
    .find(|row| bytes[ROWS + ROW * row..ROWS + ROW * row + 20] == digest[..])
    .unwrap()
}

#[test]
fn a_native_id_whose_row_a_damaged_native_order_hides_is_corrupt_not_unimported() {
  let root = scratch("order-miss");
  store_of(&root, 300);
  let aliases = root.join(".cst/aliases/sha1");
  let mut bytes = std::fs::read(&aliases).unwrap();
  let count = alias_count(&bytes);
  let short = |row: usize| bytes[ROWS + ROW * row + 20..ROWS + ROW * row + ROW].to_vec();
  let order = native_order(&bytes);
  let entry = |bytes: &[u8], at: usize| u32::from_be_bytes(bytes[order + 4 * at..order + 4 * at + 4].try_into().unwrap()) as usize;
  // Two neighbouring native-order entries whose rows' short references
  // share a first byte, so swapping them keeps every entry in its bucket.
  let at = (0..count - 1)
    .find(|&at| short(entry(&bytes, at))[0] == short(entry(&bytes, at + 1))[0])
    .unwrap();
  let row = entry(&bytes, at + 1);
  let digest = bytes[ROWS + ROW * row..ROWS + ROW * row + 20].to_vec();
  let id = Store::open(&root).unwrap().native(GitAlgorithm::Sha1, &digest).unwrap().unwrap();
  let (first, second) = (bytes[order + 4 * at..order + 4 * at + 4].to_vec(), bytes[order + 4 * at + 4..order + 4 * at + 8].to_vec());
  bytes[order + 4 * at..order + 4 * at + 4].copy_from_slice(&second);
  bytes[order + 4 * at + 4..order + 4 * at + 8].copy_from_slice(&first);
  std::fs::write(&aliases, bytes).unwrap();
  let store = Store::open(&root).unwrap();
  let why = corrupt(store.git(GitAlgorithm::Sha1, &id));
  assert!(why.ends_with("sha1: its trailer does not match its bytes"), "{why}");
  drop(store);
  std::fs::remove_dir_all(&root).unwrap();
}

#[test]
fn a_miss_on_a_sound_store_checks_each_file_whole_once_then_answers_none() {
  let root = scratch("sound-miss");
  store_of(&root, 300);
  let aliases = size_of(&root.join(".cst/aliases/sha1"));
  let store = Store::open(&root).unwrap();
  let opened = store.bytes_read();
  assert_eq!(store.native(GitAlgorithm::Sha1, &[0x77; 20]).unwrap(), None);
  let after_alias_miss = store.bytes_read();
  assert_eq!(store.held(&NativeId([0x77; 32])).unwrap(), None);
  let after_object_miss = store.bytes_read();
  // The first miss of each kind read its files whole.
  assert!(after_alias_miss - opened >= aliases, "{opened} {after_alias_miss}");
  assert!(after_object_miss - after_alias_miss >= 300 * 48, "{after_alias_miss} {after_object_miss}");
  // Misses after them, and abbreviations, read only what a lookup reads.
  assert_eq!(store.native(GitAlgorithm::Sha1, &[0x78; 20]).unwrap(), None);
  assert_eq!(store.held(&NativeId([0x78; 32])).unwrap(), None);
  assert_eq!(store.matching("7878", |_| true).unwrap(), Vec::<NativeId>::new());
  assert!(store.bytes_read() - after_object_miss < BOUND, "{after_object_miss} {}", store.bytes_read());
  drop(store);

  // An import's writer read the store whole when it opened, so its lookups
  // of the store check nothing again.
  let writer = StoreWriter::open(&root, GitAlgorithm::Sha1).unwrap();
  let existing = writer.existing().unwrap();
  let opened = existing.bytes_read();
  assert_eq!(existing.native(GitAlgorithm::Sha1, &[0x77; 20]).unwrap(), None);
  assert_eq!(existing.held(&NativeId([0x77; 32])).unwrap(), None);
  assert!(existing.bytes_read() - opened < BOUND, "{opened} {}", existing.bytes_read());
  drop(writer);
  std::fs::remove_dir_all(&root).unwrap();
}

#[test]
fn a_git_id_whose_damaged_row_a_lookup_misses_is_corrupt_not_unimported() {
  let root = scratch("alias-miss");
  let (_, digest) = store_of(&root, 50);
  let aliases = root.join(".cst/aliases/sha1");
  let row = alias_row(&std::fs::read(&aliases).unwrap(), &digest);
  // The digest's last byte: the row keeps its place, and a lookup of the Git
  // ID it held misses it.
  flip(&aliases, ROWS + ROW * row + 19);
  let store = Store::open(&root).unwrap();
  let why = corrupt(store.native(GitAlgorithm::Sha1, &digest));
  assert!(why.ends_with("sha1: its trailer does not match its bytes"), "{why}");
  drop(store);
  std::fs::remove_dir_all(&root).unwrap();
}

#[test]
fn names_out_of_order_under_an_abbreviation_are_corrupt() {
  let root = scratch("abbreviation");
  let (id, _) = store_of(&root, 300);
  let container = container_of(&root);
  let (names, _, _) = index_layout(&container, &id);
  let mut bytes = std::fs::read(&container).unwrap();
  // The first two names both begin with the hex digit 0, so an abbreviation
  // of one digit scans them both.
  assert_eq!((bytes[names] >> 4, bytes[names + 32] >> 4), (0, 0));
  let (first, second) = (bytes[names..names + 32].to_vec(), bytes[names + 32..names + 64].to_vec());
  bytes[names..names + 32].copy_from_slice(&second);
  bytes[names + 32..names + 64].copy_from_slice(&first);
  std::fs::write(&container, bytes).unwrap();
  let store = Store::open(&root).unwrap();
  let why = corrupt(store.matching("0", |_| true));
  assert!(why.ends_with(": its index does not match the index's SHA-256"), "{why}");
  drop(store);
  std::fs::remove_dir_all(&root).unwrap();
}

#[test]
fn an_abbreviation_whose_second_match_damage_hides_is_corrupt_not_unique() {
  let root = scratch("hidden-match");
  let (id, _) = store_of(&root, 300);
  let container = container_of(&root);
  let (names, _, _) = index_layout(&container, &id);
  let bytes = std::fs::read(&container).unwrap();
  // The first three names begin with the hex digit 0. Name 1 made to begin
  // with f stops a scan for 0 there, so name 2 is not found, while every
  // name the scan reads is in order.
  assert_eq!((bytes[names] >> 4, bytes[names + 32] >> 4, bytes[names + 64] >> 4), (0, 0, 0));
  let mut damaged = bytes.clone();
  damaged[names + 32] = 0xf0;
  std::fs::write(&container, damaged).unwrap();
  let store = Store::open(&root).unwrap();
  let why = corrupt(store.matching("0", |_| true));
  assert!(why.ends_with(": its index does not match the index's SHA-256"), "{why}");
  drop(store);
  std::fs::remove_dir_all(&root).unwrap();
}
