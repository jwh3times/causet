//! The derived catalogs (ADR-0047 decision 14, #421): indexes that answer
//! quickly what the objects answer slowly.
//!
//! - **By change:** a change ID to the native commits that record it.
//! - **By object:** an object to the current facts that name it.
//! - **By logical ID:** a record's logical ID (`prov_…`, `land_…`) to the
//!   current facts that carry it, parked ones included.
//!
//! Each is derived from the objects alone and kept in its own file under
//! `.cst/catalogs/`. It is never exchanged, and is no part of the store's
//! contract: the store, import and `cst fsck` read none of it. A catalog
//! file records a fingerprint of the objects it was derived from, the IDs of
//! every object of its source types the store holds, and ends with a
//! checksum of its bytes. A read that finds the file missing, unreadable, of
//! another version, damaged or derived from other objects derives the
//! catalog again and writes it back. One that cannot be written is derived
//! again by the next read: a catalog is a shortcut, never the authority.

use crate::commit::Commit;
use crate::fact::Fact;
use crate::fact_log::{self, Scope};
use causet_model::js::get;
use causet_model::json::{self, Value};
use causet_model::sha256::{Sha256, digest};
use causet_store::StoreError;
use causet_store::encoding::{Reader, put_bytes, put_varint};
use causet_store::id::{NativeId, Type};
use causet_store::store::Store;
use std::cell::OnceCell;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// The first bytes of every catalog file this build writes.
const MAGIC: &[u8] = b"causet-catalog 1\n";

/// A catalog's keys, each with the IDs it names in byte order.
type Map = BTreeMap<Vec<u8>, Vec<NativeId>>;

/// The three catalogs, by the code each file records.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
  ByChange = 1,
  ByObject = 2,
  ByLogicalId = 3,
}

impl Kind {
  /// Its file's name under `.cst/catalogs/`.
  fn file(self) -> &'static str {
    match self {
      Kind::ByChange => "by-change",
      Kind::ByObject => "by-object",
      Kind::ByLogicalId => "by-logical-id",
    }
  }

  /// The object types it is derived from, whose IDs its fingerprint holds.
  /// Which facts are current follows from the entries held only while
  /// every entry no other names as a parent is a head (`fact_log::current`):
  /// once the operation log names the chains' heads (#423), its type joins
  /// these, or a catalog of the same objects under another view is trusted.
  fn sources(self) -> &'static [Type] {
    match self {
      Kind::ByChange => &[Type::NativeCommit],
      Kind::ByObject | Kind::ByLogicalId => &[Type::Fact, Type::FactLogEntry],
    }
  }
}

/// The catalogs of one store, each read or derived the first time it is
/// asked, then answered from memory.
pub struct Catalogs<'a> {
  store: &'a Store,
  by_change: OnceCell<Map>,
  by_object: OnceCell<Map>,
  by_logical_id: OnceCell<Map>,
}

impl<'a> Catalogs<'a> {
  /// The catalogs of `store`, none read yet.
  pub fn of(store: &'a Store) -> Catalogs<'a> {
    Catalogs { store, by_change: OnceCell::new(), by_object: OnceCell::new(), by_logical_id: OnceCell::new() }
  }

  /// The native commits whose change ID is `change`, in byte order.
  pub fn commits_of_change(&self, change: &str) -> Result<Vec<NativeId>, StoreError> {
    self.lookup(Kind::ByChange, change.as_bytes())
  }

  /// The current facts of either chain that name `object`, in byte order.
  pub fn facts_naming(&self, object: &NativeId) -> Result<Vec<NativeId>, StoreError> {
    self.lookup(Kind::ByObject, &object.0)
  }

  /// The current facts of either chain that carry the logical ID `logical`,
  /// parked ones included, in byte order.
  pub fn facts_carrying(&self, logical: &[u8]) -> Result<Vec<NativeId>, StoreError> {
    self.lookup(Kind::ByLogicalId, logical)
  }

  /// The IDs a catalog names under `key`, or none.
  fn lookup(&self, kind: Kind, key: &[u8]) -> Result<Vec<NativeId>, StoreError> {
    Ok(self.map(kind)?.get(key).cloned().unwrap_or_default())
  }

  /// A catalog, read or derived the first time it is asked.
  fn map(&self, kind: Kind) -> Result<&Map, StoreError> {
    let cell = match kind {
      Kind::ByChange => &self.by_change,
      Kind::ByObject => &self.by_object,
      Kind::ByLogicalId => &self.by_logical_id,
    };
    if let Some(map) = cell.get() {
      return Ok(map);
    }
    let loaded = load(self.store, kind)?;
    Ok(cell.get_or_init(|| loaded))
  }
}

/// Where a store keeps a catalog.
fn path_of(store: &Store, kind: Kind) -> PathBuf {
  store.root.join(".cst").join("catalogs").join(kind.file())
}

/// The digest of every object of the catalog's source types the store holds.
fn fingerprint(store: &Store, kind: Kind) -> Result<[u8; 32], StoreError> {
  let mut hasher = Sha256::new();
  hasher.update(MAGIC);
  hasher.update(&[kind as u8]);
  for source in kind.sources() {
    let ids = store.present_of(*source)?;
    hasher.update(&[source.code()]);
    hasher.update(&(ids.len() as u64).to_be_bytes());
    for id in &ids {
      hasher.update(&id.0);
    }
  }
  Ok(hasher.finish())
}

/// The catalog as its file holds it, or as derived again when the file is
/// not one to trust.
fn load(store: &Store, kind: Kind) -> Result<Map, StoreError> {
  let print = fingerprint(store, kind)?;
  let path = path_of(store, kind);
  if let Ok(bytes) = std::fs::read(&path)
    && let Some(map) = decode(&bytes, &print)
  {
    return Ok(map);
  }
  let map = derive(store, kind)?;
  // A catalog that cannot be written, in a read-only repository say, is
  // derived again by the next read.
  let _ = replace(&path, &encode(&map, kind, &print));
  Ok(map)
}

/// The catalog from the objects alone.
fn derive(store: &Store, kind: Kind) -> Result<Map, StoreError> {
  let mut map = Map::new();
  match kind {
    Kind::ByChange => {
      for id in store.present_of(Type::NativeCommit)? {
        let commit = Commit::decode(&store.read(&id)?.body)
          .map_err(|why| StoreError::Corrupt(format!("the native commit {id}: {why}")))?;
        if let Some(change) = commit.change_id {
          map.entry(change.into_bytes()).or_default().push(id);
        }
      }
    }
    Kind::ByObject | Kind::ByLogicalId => {
      for scope in [Scope::Shared, Scope::Local] {
        for (id, fact) in fact_log::current(store, scope)? {
          let keys = if kind == Kind::ByObject { named(&fact) } else { logical_id(&fact).into_iter().collect() };
          for key in keys {
            map.entry(key).or_default().push(id);
          }
        }
      }
    }
  }
  for ids in map.values_mut() {
    ids.sort();
    ids.dedup();
  }
  Ok(map)
}

/// The objects a fact names, as catalog keys.
fn named(fact: &Fact) -> Vec<Vec<u8>> {
  match fact {
    Fact::Record { names, .. } => names.iter().map(|id| id.0.to_vec()).collect(),
    Fact::Parked { .. } => Vec::new(),
  }
}

/// The logical ID a fact carries: its record's `id` member, or the one a
/// parked fact kept.
fn logical_id(fact: &Fact) -> Option<Vec<u8>> {
  match fact {
    Fact::Record { record, .. } => {
      let value = json::parse(std::str::from_utf8(record).ok()?).ok()?;
      match get(Some(&value), "id") {
        Some(Value::String(units)) => Some(json::lossy(units).into_bytes()),
        _ => None,
      }
    }
    Fact::Parked { id, .. } => id.clone(),
  }
}

/// A catalog's file: the magic, its kind, its fingerprint, each key with its
/// IDs, and the SHA-256 of everything before it.
fn encode(map: &Map, kind: Kind, print: &[u8; 32]) -> Vec<u8> {
  let mut out = MAGIC.to_vec();
  out.push(kind as u8);
  out.extend_from_slice(print);
  put_varint(&mut out, map.len() as u64);
  for (key, ids) in map {
    put_bytes(&mut out, key);
    put_varint(&mut out, ids.len() as u64);
    for id in ids {
      id.put(&mut out);
    }
  }
  let checksum = digest(&out);
  out.extend_from_slice(&checksum);
  out
}

/// The catalog a file holds, when it is this build's, of this kind, derived
/// from the objects the store holds now, and undamaged.
fn decode(bytes: &[u8], print: &[u8; 32]) -> Option<Map> {
  let body = bytes.get(..bytes.len().checked_sub(32)?)?;
  if digest(body) != bytes[body.len()..] {
    return None;
  }
  let mut reader = Reader::new(body);
  // The kind byte needs no check of its own: the fingerprint is of the kind
  // as well as of the objects.
  if reader.take(MAGIC.len()).ok()? != MAGIC {
    return None;
  }
  reader.u8().ok()?;
  if reader.take(32).ok()? != print {
    return None;
  }
  // Nor does the order of keys and IDs: a file whose checksum holds and
  // whose fingerprint matches is this build's own encoding of a sorted map.
  let mut map = Map::new();
  for _ in 0..reader.varint().ok()? {
    let key = reader.bytes().ok()?.to_vec();
    let mut ids: Vec<NativeId> = Vec::new();
    for _ in 0..reader.varint().ok()? {
      ids.push(NativeId::read(&mut reader).ok()?);
    }
    map.insert(key, ids);
  }
  reader.rest().is_empty().then_some(map)
}

/// Writes a catalog under a name of this process's, then renames it into
/// place, so a reader sees the old file or the new one, never part of one.
fn replace(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
  let directory = path.parent().unwrap_or(path);
  std::fs::create_dir_all(directory)?;
  let mut name = path.file_name().unwrap_or_default().to_os_string();
  name.push(format!(".{}.tmp", std::process::id()));
  let written = path.with_file_name(name);
  std::fs::write(&written, bytes).and_then(|()| std::fs::rename(&written, path)).inspect_err(|_| {
    let _ = std::fs::remove_file(&written);
  })
}
