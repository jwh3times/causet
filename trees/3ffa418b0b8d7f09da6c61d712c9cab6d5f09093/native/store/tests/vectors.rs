//! Holds the store to the contract's text: the gear table and parameters of
//! `docs/native-store/storage.md` §2, the reference vectors of
//! `docs/native-store/chunker-vectors.json`, the container header of §4 and
//! the root marker of objects.md §10.

use causet_model::json::{self, Value};
use causet_model::sha256;
use causet_store::chunker::{self, GEAR, MASK_L, MASK_S};
use causet_store::id::GitAlgorithm;
use causet_store::objects::Snapshot;
use causet_store::VERSION;
use causet_store::store::{FORMAT, StoreWriter};
use std::path::PathBuf;

fn contract(name: &str) -> String {
  let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../docs/native-store").join(name);
  std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}

fn hex(bytes: &[u8]) -> String {
  bytes.iter().map(|byte| format!("{byte:02x}")).collect()
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

fn number(value: &Value) -> usize {
  match value {
    Value::Number(number) if number.fract() == 0.0 && *number >= 0.0 => *number as usize,
    _ => panic!("not a count"),
  }
}

fn array(value: &Value) -> &[Value] {
  match value {
    Value::Array(items) => items,
    _ => panic!("not an array"),
  }
}

/// A vector's input, from its generator (`storage.md` §2.4).
fn input(spec: &Value) -> Vec<u8> {
  match text(member(spec, "kind")).as_str() {
    "zeros" => vec![0; number(member(spec, "length"))],
    "example" => (0..number(member(spec, "count")) as u32)
      .flat_map(|k| sha256::digest(&[b"cst fastcdc example".as_slice(), &k.to_be_bytes()].concat()))
      .collect(),
    "periodic" => (0..number(member(spec, "length"))).map(|i| (i % 251) as u8).collect(),
    "insert" => {
      let mut data = input(member(spec, "base"));
      let offset = number(member(spec, "offset"));
      data.splice(offset..offset, unhex(&text(member(spec, "bytes"))));
      data
    }
    kind => panic!("unknown input kind {kind}"),
  }
}

#[test]
fn the_gear_table_is_its_derivation() {
  for (i, entry) in GEAR.iter().enumerate() {
    let digest = sha256::digest(&[b"cst fastcdc gear".as_slice(), &[i as u8]].concat());
    assert_eq!(*entry, u64::from_be_bytes(digest[..8].try_into().unwrap()), "GEAR[{i}]");
  }
}

#[test]
fn the_gear_table_is_the_one_the_contract_prints() {
  let storage = contract("storage.md");
  let section = &storage[storage.find("### 2.2 The gear table").expect("§2.2")..];
  let block = section.split("```").nth(3).expect("the table's code block");
  let printed: Vec<u64> = block
    .lines()
    .flat_map(|line| line.split_whitespace().skip(1))
    .map(|entry| u64::from_str_radix(entry, 16).unwrap())
    .collect();
  assert_eq!(printed, GEAR);
}

#[test]
fn the_parameters_are_the_ones_the_contract_states() {
  let storage = contract("storage.md");
  for row in [
    format!("| `MIN` | 2,048 (2 KiB) |"),
    format!("| `NORMAL` | 8,192 (8 KiB) |"),
    format!("| `MAX` | 65,536 (64 KiB) |"),
    format!("| `MASK_S` | `0x{MASK_S:016x}` |"),
    format!("| `MASK_L` | `0x{MASK_L:016x}` |"),
  ] {
    assert!(storage.contains(&row), "storage.md §2.1 has no row starting {row}");
  }
  assert_eq!((chunker::MIN, chunker::NORMAL, chunker::MAX), (2048, 8192, 65536));
}

#[test]
fn every_reference_vector_cuts_as_published() {
  let vectors = json::parse(&contract("chunker-vectors.json")).unwrap();
  assert_eq!(number(member(&vectors, "chunker")), 1);
  assert_eq!(number(member(&vectors, "seed")), 0);
  let list = array(member(&vectors, "vectors"));
  assert!(!list.is_empty());
  for vector in list {
    let name = text(member(vector, "name"));
    let data = input(member(vector, "input"));
    assert_eq!(data.len(), number(member(vector, "length")), "{name}: length");
    assert_eq!(sha256::hex(&data), text(member(vector, "sha256")), "{name}: input");
    let lengths: Vec<usize> = chunker::chunks(&data).map(<[u8]>::len).collect();
    let published: Vec<usize> = array(member(vector, "lengths")).iter().map(number).collect();
    assert_eq!(lengths, published, "{name}: lengths");
    // A chunk is identified as content is (objects.md §3): SHA-256 of `cst`,
    // the content type byte 01, and the chunk's bytes.
    let ids: Vec<String> = chunker::chunks(&data)
      .map(|chunk| hex(&sha256::digest(&[b"cst\x01".as_slice(), chunk].concat())))
      .collect();
    let published: Vec<String> = array(member(vector, "chunks")).iter().map(text).collect();
    assert_eq!(ids, published, "{name}: chunk IDs");
  }
}

#[test]
fn the_root_marker_is_the_one_the_contract_prints() {
  let objects = contract("objects.md");
  assert_eq!(FORMAT, format!("causet-native-store {VERSION}\n").as_bytes());
  assert_eq!(FORMAT.len(), 22);
  assert!(objects.contains("holds exactly `causet-native-store 1` and a line feed, the 22"));
  assert!(objects.contains(&format!("`{}`", hex(FORMAT))), "{}", hex(FORMAT));
}

#[test]
fn a_new_container_begins_with_the_header_the_contract_prints() {
  let storage = contract("storage.md");
  let line = "**A version 1 header** is therefore `";
  let at = storage.find(line).expect("§4's header") + line.len();
  let printed: String = storage[at..at + storage[at..].find('`').unwrap()]
    .split(' ')
    .collect();
  let root =
    std::env::temp_dir().join(format!("causet-store-vectors-{}-header", std::process::id()));
  let _ = std::fs::remove_dir_all(&root);
  let mut writer = StoreWriter::create(&root, GitAlgorithm::Sha1).unwrap();
  writer.put_content(b"hello\n").unwrap();
  writer
    .finish(&Snapshot::new(GitAlgorithm::Sha1, Vec::new()).unwrap())
    .unwrap();
  let container = std::fs::read_dir(root.join(".cst/objects"))
    .unwrap()
    .map(|entry| entry.unwrap().path())
    .find(|path| path.extension().is_some_and(|extension| extension == "cstc"))
    .unwrap();
  let bytes = std::fs::read(&container).unwrap();
  std::fs::remove_dir_all(&root).unwrap();
  assert_eq!(hex(&bytes[..16]), printed);
}
