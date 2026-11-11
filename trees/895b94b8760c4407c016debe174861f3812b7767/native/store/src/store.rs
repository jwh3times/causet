//! A native repository's store (objects.md §10): writing one, and reading it
//! back with every object verified by its ID, a tree's short references
//! resolved through every container's index.

use crate::StoreError;
use crate::alias::{AliasFile, Aliases};
use crate::chunker;
use crate::container::{self, Container, ContainerWriter, Form, Index, PRESENT, Record};
use crate::delta::{self, DEPTH_LIMIT, Delta};
use crate::id::{GitAlgorithm, NativeId, Short, Type, hex, unhex};
use crate::objects::{
  CHOICES, ChunkList, GitKind, Preserved, RefTarget, ShortTarget, ShortTree, Snapshot, Target, Tree,
};
use crate::positioned::read_exact_at;
use crate::reconstruct;
use std::cell::RefCell;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs::File;
use std::io::{BufReader, BufWriter, Read as _, Seek as _, SeekFrom, Write as _};
use std::path::{Path, PathBuf};
use std::rc::Rc;

/// The root marker's exact content, naming [`crate::VERSION`].
pub const FORMAT: &[u8] = b"causet-native-store 1\n";
const MARKER: &str = "causet-native-store ";
/// Content shorter than this is stored as its bytes (storage.md §1, rule 2).
const WHOLE: usize = 32 * 1024;
const STAGING: &str = ".cst-import";
/// Held under `.cst/` while an import adds to the store (objects.md §10).
pub const LOCK: &str = "import.lock";
/// Where an import holds its metadata until the container closes, beside
/// the lock (objects.md §10).
pub const HELD: &str = "import.metadata";
/// Where an import holds the Git bytes of the commits, tags and trees it has
/// read until it has stored them, beside the lock (objects.md §10).
pub const HELD_OBJECTS: &str = "import.objects";

/// Writes a store: a new one into an empty destination, or what an import
/// adds to an existing one. A new store is not a native repository until
/// `finish` renames the finished `.cst/` into place. An import into an
/// existing store adds one container, then replaces the alias file and, last,
/// `snapshot` (objects.md §10); until then a reader sees the store as it was.
pub struct StoreWriter {
  root: PathBuf,
  /// The directory the store's files are written in: `.cst-import/` for a
  /// new store, `.cst/` for an existing one.
  staging: PathBuf,
  algorithm: GitAlgorithm,
  container: Option<ContainerWriter>,
  /// Every object held present, in order, so a short reference's
  /// candidates are a range of it.
  present: BTreeSet<NativeId>,
  /// The depth of each delta this writer stored (storage.md §5.2).
  depths: HashMap<NativeId, usize>,
  /// This import's alias rows, whole.
  aliases: Vec<(Vec<u8>, NativeId)>,
  /// The rows of the store an import adds to, as its alias file holds them.
  existing_rows: Vec<(Vec<u8>, Short)>,
  /// The store an import adds to, as it was when the import began.
  existing: Option<Store>,
  /// What an import into an existing store has put in place so far, so a
  /// failure can take it back.
  placed: Placed,
  held: Held,
  held_objects: HeldObjects,
}

/// The metadata a writer holds until it closes the container, which it then
/// writes in path order (storage.md §3.2): trees grouped by path, then
/// everything else in the order it came. Each record waits in a file beside
/// the lock, so what a writer keeps in memory is a few bytes an object.
struct Held {
  path: PathBuf,
  file: Option<BufWriter<File>>,
  written: u64,
  records: Vec<HeldRecord>,
  /// Each path's rank, in the order its first tree came.
  paths: HashMap<Vec<u8>, u32>,
}

/// Where a held record waits, and what the container's index says of it.
struct HeldRecord {
  /// A tree's path's rank; any other record's comes after every tree's.
  group: u32,
  /// Where its ID, length and bytes begin in the file.
  offset: u64,
  kind: Type,
  form: Form,
}

/// What precedes each held record's bytes: its ID, then its length as `u64`.
const HELD_HEAD: usize = 32 + 8;

impl Held {
  fn new(staging: &Path) -> Held {
    Held {
      path: staging.join(HELD),
      file: None,
      written: 0,
      records: Vec::new(),
      paths: HashMap::new(),
    }
  }

  /// Holds a record: its ID, its length and its bytes go in the file. A
  /// tree's `path` places it.
  fn hold(
    &mut self,
    id: &NativeId,
    kind: Type,
    form: Form,
    record: &[u8],
    path: Option<&[u8]>,
  ) -> Result<(), StoreError> {
    let group = match path {
      Some(path) => {
        let next = self.paths.len() as u32;
        *self.paths.entry(path.to_vec()).or_insert(next)
      }
      None => u32::MAX,
    };
    if self.file.is_none() {
      let file = File::options()
        .read(true)
        .write(true)
        .create(true)
        .truncate(true)
        .open(&self.path)
        .map_err(|error| StoreError::io(&self.path, error))?;
      self.file = Some(BufWriter::new(file));
    }
    let file = self.file.as_mut().expect("the file just opened");
    file
      .write_all(&id.0)
      .and_then(|()| file.write_all(&(record.len() as u64).to_be_bytes()))
      .and_then(|()| file.write_all(record))
      .map_err(|error| StoreError::io(&self.path, error))?;
    self.records.push(HeldRecord {
      group,
      offset: self.written,
      kind,
      form,
    });
    self.written += (HELD_HEAD + record.len()) as u64;
    Ok(())
  }

  /// Adds every held record to `container` in path order, then removes the
  /// file.
  fn write(&mut self, container: &mut ContainerWriter) -> Result<(), StoreError> {
    let Some(file) = self.file.take() else {
      return Ok(());
    };
    let failed = |error: std::io::Error| StoreError::io(&self.path, error);
    let mut file = BufReader::new(file.into_inner().map_err(|error| failed(error.into_error()))?);
    file.seek(SeekFrom::Start(0)).map_err(failed)?;
    let mut records = std::mem::take(&mut self.records);
    // Stable, so each group keeps the order its records came in.
    records.sort_by_key(|held| held.group);
    let mut at: u64 = 0;
    let mut record = Vec::new();
    for held in records {
      // Relative, so a record near the last one is read from the buffer.
      let mut head = [0u8; HELD_HEAD];
      file
        .seek_relative(held.offset as i64 - at as i64)
        .and_then(|()| file.read_exact(&mut head))
        .map_err(failed)?;
      let length = u64::from_be_bytes(head[32..].try_into().expect("8 bytes"));
      record.resize(length as usize, 0);
      file.read_exact(&mut record).map_err(failed)?;
      at = held.offset + (HELD_HEAD as u64) + length;
      let id = NativeId(head[..32].try_into().expect("32 bytes"));
      container.add(&id, held.kind, held.form, &record)?;
    }
    drop(file);
    self.discard();
    Ok(())
  }

  fn discard(&mut self) {
    self.file = None;
    let _ = std::fs::remove_file(&self.path);
  }
}

/// The Git bytes of the commits, tags and trees an import has read, which it
/// holds in a file beside the lock until it has stored them, so that what it
/// keeps in memory is where each one sits (#405).
struct HeldObjects {
  path: PathBuf,
  /// Opened for appending when the first object is held, so a read by
  /// position never moves where the next one is written. A read writes out
  /// what is buffered first, so it takes `&self`.
  file: RefCell<Option<BufWriter<File>>>,
  written: u64,
}

/// Where an object's bytes sit in the file an import holds them in.
#[derive(Clone, Copy, Debug)]
pub struct HeldObject {
  offset: u64,
  length: u64,
}

impl HeldObjects {
  fn new(staging: &Path) -> HeldObjects {
    HeldObjects {
      path: staging.join(HELD_OBJECTS),
      file: RefCell::new(None),
      written: 0,
    }
  }

  /// Appends an object's bytes to the file, and says where they are.
  fn hold(&mut self, bytes: &[u8]) -> Result<HeldObject, StoreError> {
    let failed = |error: std::io::Error| StoreError::io(&self.path, error);
    let file = self.file.get_mut();
    if file.is_none() {
      // Created empty first, replacing what a killed import left: a file
      // opened for appending cannot be truncated.
      File::create(&self.path).map_err(failed)?;
      let opened = File::options().read(true).append(true).open(&self.path).map_err(failed)?;
      *file = Some(BufWriter::new(opened));
    }
    file.as_mut().expect("the file just opened").write_all(bytes).map_err(failed)?;
    let held = HeldObject {
      offset: self.written,
      length: bytes.len() as u64,
    };
    self.written += held.length;
    Ok(held)
  }

  /// The bytes `hold` put at `held`, read by position once what is
  /// buffered is written out. A place this file does not hold is refused.
  fn read(&self, held: HeldObject) -> Result<Vec<u8>, StoreError> {
    let failed = |error: std::io::Error| StoreError::io(&self.path, error);
    let mut file = self.file.borrow_mut();
    let file = match file.as_mut() {
      Some(file) if held.offset.checked_add(held.length).is_some_and(|end| end <= self.written) => file,
      _ => {
        return Err(StoreError::Codec(format!(
          "{} holds no {} bytes at {}",
          self.path.display(),
          held.length,
          held.offset
        )));
      }
    };
    file.flush().map_err(failed)?;
    let mut bytes = vec![0u8; held.length as usize];
    read_exact_at(file.get_ref(), held.offset, &mut bytes).map_err(failed)?;
    Ok(bytes)
  }

  fn discard(&mut self) {
    *self.file.get_mut() = None;
    let _ = std::fs::remove_file(&self.path);
  }
}

/// The previous version of a file, which a new version may be stored against
/// (storage.md §5.1): content the store holds present, and its bytes.
pub struct Base<'a> {
  pub id: NativeId,
  pub bytes: &'a [u8],
}

/// What an import into an existing store has put in place: the container it
/// named, and the alias file it replaced, with that file's earlier bytes.
#[derive(Default)]
struct Placed {
  container: Option<PathBuf>,
  aliases: Option<Option<Vec<u8>>>,
  snapshot: bool,
}

impl StoreWriter {
  /// `root` must not exist, or be an empty directory.
  pub fn create(root: &Path, algorithm: GitAlgorithm) -> Result<StoreWriter, StoreError> {
    match std::fs::read_dir(root) {
      Ok(mut entries) => {
        if entries.next().is_some() {
          return Err(StoreError::Exists(format!(
            "{} exists and is not empty",
            root.display()
          )));
        }
      }
      Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
        std::fs::create_dir(root).map_err(|error| StoreError::io(root, error))?;
      }
      Err(error) => return Err(StoreError::io(root, error)),
    }
    let staging = root.join(STAGING);
    let objects = staging.join("objects");
    for directory in [&staging, &objects, &staging.join("aliases")] {
      std::fs::create_dir(directory).map_err(|error| StoreError::io(directory, error))?;
    }
    Ok(StoreWriter {
      root: root.to_path_buf(),
      container: Some(ContainerWriter::create(&objects)?),
      held: Held::new(&staging),
      held_objects: HeldObjects::new(&staging),
      staging,
      algorithm,
      present: BTreeSet::new(),
      depths: HashMap::new(),
      aliases: Vec::new(),
      existing_rows: Vec::new(),
      existing: None,
      placed: Placed::default(),
    })
  }

  /// Adds to the store of the native repository at `root`, whose history must
  /// be of `algorithm`. Every object it holds present is held already, and
  /// every alias row it has is kept. One import at a time adds to a store:
  /// `.cst/import.lock` is taken before the store is read, and held until the
  /// import ends.
  pub fn open(root: &Path, algorithm: GitAlgorithm) -> Result<StoreWriter, StoreError> {
    let staging = root.join(".cst");
    let lock = staging.join(LOCK);
    let mut held = std::fs::OpenOptions::new()
      .write(true)
      .create_new(true)
      .open(&lock)
      .map_err(|error| match error.kind() {
        std::io::ErrorKind::AlreadyExists => StoreError::Exists(format!(
          "{} exists, so another import is adding to {}. If none is, remove it",
          lock.display(),
          root.display()
        )),
        _ => StoreError::io(&lock, error),
      })?;
    let _ = writeln!(held, "{}", std::process::id());
    drop(held);
    let mut writer = StoreWriter {
      root: root.to_path_buf(),
      container: None,
      held: Held::new(&staging),
      held_objects: HeldObjects::new(&staging),
      staging,
      algorithm,
      present: BTreeSet::new(),
      depths: HashMap::new(),
      aliases: Vec::new(),
      existing_rows: Vec::new(),
      existing: None,
      placed: Placed::default(),
    };
    // From here the writer releases the lock, whatever fails.
    let store = match Store::open(root) {
      Ok(store) => store,
      Err(error) => {
        let _ = std::fs::remove_file(&lock);
        return Err(error);
      }
    };
    writer.existing = Some(store);
    let store = writer.existing.as_ref().expect("the store just opened");
    let history = store.refs()?.algorithm;
    if history != algorithm {
      return Err(StoreError::Unsupported(format!(
        "{} holds a {} history, so it cannot take a {} one",
        root.display(),
        history.name(),
        algorithm.name()
      )));
    }
    // An import rewrites the alias file whole, so it reads the store whole,
    // with every check: a damaged row is refused, not carried forward under
    // a new trailer.
    writer.existing_rows = store
      .load_aliases()?
      .into_iter()
      .find(|aliases| aliases.algorithm == algorithm)
      .map(|aliases| {
        aliases
          .rows()
          .map(|(digest, short)| (digest.to_vec(), *short))
          .collect()
      })
      .unwrap_or_default();
    writer.present = store.present()?.into_iter().map(|(id, _, _)| id).collect();
    writer.container = Some(ContainerWriter::create(&writer.staging.join("objects"))?);
    Ok(writer)
  }

  /// The store an import adds to, as it was before this import.
  pub fn existing(&self) -> Option<&Store> {
    self.existing.as_ref()
  }

  /// The bytes the held metadata file has grown to (`import.metadata`). It
  /// only grows until the container closes, so before `finish` this is its
  /// peak size on disk.
  pub fn held_metadata(&self) -> u64 {
    self.held.written
  }

  /// Holds a Git object's bytes until the import has stored it, in
  /// `import.objects` beside the held metadata, and says where they are.
  pub fn hold_object(&mut self, bytes: &[u8]) -> Result<HeldObject, StoreError> {
    self.held_objects.hold(bytes)
  }

  /// The bytes of an object `hold_object` held.
  pub fn read_held_object(&self, held: HeldObject) -> Result<Vec<u8>, StoreError> {
    self.held_objects.read(held)
  }

  /// The bytes the held objects file has grown to (`import.objects`): its
  /// peak size on disk, since it only grows until the import ends.
  pub fn held_objects(&self) -> u64 {
    self.held_objects.written
  }

  fn add(
    &mut self,
    id: &NativeId,
    kind: Type,
    form: Form,
    record: &[u8],
  ) -> Result<(), StoreError> {
    self
      .container
      .as_mut()
      .expect("an open container")
      .add(id, kind, form, record)?;
    self.present.insert(*id);
    Ok(())
  }

  /// Stores content in the form storage.md §1 chooses: its bytes when it is
  /// under 32 KiB or one chunk, otherwise a chunk list and each new chunk.
  pub fn put_content(&mut self, bytes: &[u8]) -> Result<NativeId, StoreError> {
    self.put_version(bytes, None)
  }

  /// Stores a version of a file whose previous version is `base`
  /// (storage.md §5.1): as a delta against it when §5.1 allows one and it is
  /// smaller than the chunks, and otherwise as `put_content` stores it.
  pub fn put_version(&mut self, bytes: &[u8], base: Option<Base>) -> Result<NativeId, StoreError> {
    let id = NativeId::of(Type::Content, bytes);
    if self.present.contains(&id) {
      return Ok(id);
    }
    let chunks: Vec<&[u8]> = if bytes.len() < WHOLE {
      vec![bytes]
    } else {
      chunker::chunks(bytes).collect()
    };
    if chunks.len() <= 1 {
      self.add(&id, Type::Content, Form::Body, bytes)?;
      return Ok(id);
    }
    let list = ChunkList {
      size: bytes.len() as u64,
      chunks: chunks
        .iter()
        .map(|chunk| (NativeId::of(Type::Content, chunk), chunk.len() as u64))
        .collect(),
    };
    let record = list.encode();
    if let Some(base) = base
      && let Some((delta, depth)) = self.delta(&id, bytes, &base, &list, &chunks, record.len())?
    {
      // The content's new chunks are not stored (§5.1).
      self
        .container
        .as_mut()
        .expect("an open container")
        .add_stored(&id, Type::Content, Form::Delta, &delta)?;
      self.present.insert(id);
      self.depths.insert(id, depth);
      return Ok(id);
    }
    for (chunk, (chunk_id, _)) in chunks.iter().zip(&list.chunks) {
      if !self.present.contains(chunk_id) {
        self.add(chunk_id, Type::Content, Form::Body, chunk)?;
      }
    }
    self.add(&id, Type::Content, Form::ChunkList, &record)?;
    Ok(id)
  }

  /// The delta record storage.md §5.1 writes for a version, with its depth,
  /// or `None` when the version is stored as chunks instead: it is under
  /// 1 MiB, it and its base pass 2 GiB together, its base is itself or not
  /// held present, the base is 8 deep already, or the delta is not strictly
  /// smaller than the chunk list's record plus one zstd frame of the chunks
  /// the store does not hold yet.
  fn delta(
    &self,
    id: &NativeId,
    bytes: &[u8],
    base: &Base,
    list: &ChunkList,
    chunks: &[&[u8]],
    list_length: usize,
  ) -> Result<Option<(Vec<u8>, usize)>, StoreError> {
    if bytes.len() < delta::SMALLEST
      || base.bytes.len() + bytes.len() > delta::TOGETHER
      || base.id == *id
      || !self.present.contains(&base.id)
    {
      return Ok(None);
    }
    if NativeId::of(Type::Content, base.bytes) != base.id {
      return Err(StoreError::Codec(format!(
        "the base given for {id} does not hash to {}",
        base.id
      )));
    }
    let depth = self.depth(&base.id)?;
    if depth >= DEPTH_LIMIT {
      return Ok(None);
    }
    let record = Delta {
      base: base.id,
      size: bytes.len() as u64,
      data: delta::compress(base.bytes, bytes)?,
    }
    .encode();
    // The chunks cost their list at least, so a delta smaller than the list
    // is smaller than the chunks without their frame being measured.
    if record.len() >= list_length {
      let mut seen = HashSet::new();
      let mut new = Vec::new();
      for (chunk, (chunk_id, _)) in chunks.iter().zip(&list.chunks) {
        if !self.present.contains(chunk_id) && seen.insert(*chunk_id) {
          new.extend_from_slice(chunk);
        }
      }
      let frame = if new.is_empty() {
        0
      } else {
        container::compress(&new)?.len()
      };
      if record.len() >= list_length + frame {
        return Ok(None);
      }
    }
    Ok(Some((record, depth + 1)))
  }

  /// The depth of content the store holds present (§5.2): a delta's this
  /// writer stored, or the existing store's.
  fn depth(&self, id: &NativeId) -> Result<usize, StoreError> {
    if let Some(depth) = self.depths.get(id) {
      return Ok(*depth);
    }
    match &self.existing {
      Some(store) if store.locate(id)?.is_some_and(|(_, record)| record.state == PRESENT) => {
        store.depth(id)
      }
      _ => Ok(0),
    }
  }

  /// Stores a tree in short references (objects.md §4.4). A tree whose
  /// references would need more than 65,536 choices among what the store
  /// holds is refused, naming it (§1.3), and so is one naming an object the
  /// store does not hold, which no reader could resolve. `finish` checks the
  /// bound again, against what the import wrote after the tree. `path` is
  /// where import's walk first reaches the tree, which places it among the
  /// container's trees (storage.md §3.2).
  pub fn put_tree(&mut self, tree: &Tree, path: &[u8]) -> Result<NativeId, StoreError> {
    let id = NativeId::of(Type::Tree, &tree.encode());
    if self.present.contains(&id) {
      return Ok(id);
    }
    let shorts = tree.entries.iter().filter_map(|entry| match &entry.target {
      Target::Native(target) => Some(target.short()),
      Target::Git(_) => None,
    });
    match self.choices(shorts)? {
      None => {
        return Err(StoreError::Codec(format!(
          "the tree {id} names an object the store does not hold"
        )));
      }
      Some(choices) => self.within_bound(&id, choices)?,
    }
    self.hold(&id, Type::Tree, Form::ShortReferences, &tree.encode_short(), Some(path))?;
    Ok(id)
  }

  /// Holds a metadata record until the container closes (storage.md §3.2).
  /// It is a candidate for short references from now.
  fn hold(
    &mut self,
    id: &NativeId,
    kind: Type,
    form: Form,
    record: &[u8],
    path: Option<&[u8]>,
  ) -> Result<(), StoreError> {
    self.held.hold(id, kind, form, record, path)?;
    self.present.insert(*id);
    Ok(())
  }

  /// The product of each short reference's number of candidates, or `None`
  /// when one has none.
  fn choices(&self, shorts: impl Iterator<Item = Short>) -> Result<Option<u64>, StoreError> {
    let mut choices: u64 = 1;
    for short in shorts {
      match self.candidates(&short)?.len() as u64 {
        0 => return Ok(None),
        found => choices = choices.saturating_mul(found),
      }
    }
    Ok(Some(choices))
  }

  fn within_bound(&self, id: &NativeId, choices: u64) -> Result<(), StoreError> {
    if choices > CHOICES {
      return Err(StoreError::TooLarge(format!(
        "the tree {id}'s short references would allow {choices} choices, and a tree may need at most {CHOICES}"
      )));
    }
    Ok(())
  }

  /// Checks the bound again for every tree in the container this import
  /// wrote, now that every object it wrote is a candidate: an object written
  /// after a tree may share its references (objects.md §1.3). When no
  /// reference the container's names begin with has two candidates, no tree
  /// needs more than one choice, and no tree is read.
  fn check_bound(&self, path: &Path) -> Result<(), StoreError> {
    let container = Index::read(path)?;
    let mut shared: HashSet<Short> = HashSet::new();
    for name in &container.names {
      let short = NativeId(*name).short();
      if self.candidates(&short)?.len() > 1 {
        shared.insert(short);
      }
    }
    if shared.is_empty() {
      return Ok(());
    }
    let mut trees: Vec<(&[u8; 32], &Record)> = container
      .names
      .iter()
      .zip(&container.records)
      .filter(|(_, record)| record.form == Form::ShortReferences)
      .collect();
    trees.sort_by_key(|(_, record)| (record.frame, record.offset));
    let mut frame: Option<(u32, Vec<u8>)> = None;
    for (name, record) in trees {
      if frame.as_ref().is_none_or(|(number, _)| *number != record.frame) {
        frame = Some((record.frame, container.frame(record.frame)?));
      }
      let bytes = &frame.as_ref().expect("the frame just read").1;
      let start = record.offset as usize;
      let id = NativeId(*name);
      let short = ShortTree::decode(&bytes[start..start + record.length as usize])
        .map_err(|what| StoreError::Corrupt(format!("{id}: {what}")))?;
      if !short.entries.iter().any(|entry| matches!(&entry.target, ShortTarget::Short(at) if shared.contains(at))) {
        continue;
      }
      let shorts = short.entries.iter().filter_map(|entry| match &entry.target {
        ShortTarget::Short(at) => Some(*at),
        ShortTarget::Git(_) => None,
      });
      if let Some(choices) = self.choices(shorts)? {
        self.within_bound(&id, choices)?;
      }
    }
    Ok(())
  }

  /// The objects whose digest begins with `short`: what this import has
  /// written, and every index entry of the store it adds to.
  fn candidates(&self, short: &Short) -> Result<Vec<NativeId>, StoreError> {
    let mut low = [0u8; 32];
    low[..8].copy_from_slice(short);
    let mut high = [0xffu8; 32];
    high[..8].copy_from_slice(short);
    let mut found: Vec<NativeId> = self
      .present
      .range(NativeId(low)..=NativeId(high))
      .copied()
      .collect();
    if let Some(store) = &self.existing {
      found.extend(store.candidates(short)?);
      found.sort();
      found.dedup();
    }
    Ok(found)
  }

  /// Stores a commit, tag or tree kept in Git's encoding. `path` is where
  /// import's walk first reaches it, which places a tree among the
  /// container's trees (storage.md §3.2).
  pub fn put_preserved(&mut self, preserved: &Preserved, path: &[u8]) -> Result<NativeId, StoreError> {
    let body = preserved.encode();
    let id = NativeId::of(Type::Preserved, &body);
    if !self.present.contains(&id) {
      let tree = (preserved.kind == GitKind::Tree).then_some(path);
      self.hold(&id, Type::Preserved, Form::Body, &body, tree)?;
    }
    Ok(id)
  }

  /// Records that the Git object with this digest is the native object `id`.
  pub fn alias(&mut self, git_digest: Vec<u8>, id: NativeId) {
    self.aliases.push((git_digest, id));
  }

  /// Stores the ref snapshot, then writes the container, the alias file, the
  /// `snapshot` file and, for a new store, the marker, and puts the store in
  /// place: the commit point is renaming the new store into place, or
  /// replacing an existing one's `snapshot`. Each direct ref must name a
  /// stored object with an alias row (objects.md §6).
  pub fn finish(mut self, snapshot: &Snapshot) -> Result<PathBuf, StoreError> {
    // Every object it held is stored by now, and a new store must not take
    // the file into place.
    self.held_objects.discard();
    if snapshot.algorithm != self.algorithm {
      return Err(StoreError::Codec(format!(
        "a {} snapshot cannot finish a {} store",
        snapshot.algorithm.name(),
        self.algorithm.name()
      )));
    }
    let mut rows = std::mem::take(&mut self.aliases);
    rows.sort();
    rows.dedup();
    // Within one Git algorithm the map is one-to-one (objects.md §9). A
    // stored row holds only a short reference, so this import's rows are
    // checked here, while they are whole, against each other and against
    // the rows the store holds already.
    let mut aliased: Vec<NativeId> = rows.iter().map(|(_, id)| *id).collect();
    aliased.sort();
    let existing = self.existing.as_ref();
    let existing_git = |id: &NativeId| match existing {
      Some(store) => store.git(self.algorithm, id),
      None => Ok(None),
    };
    let mut repeated = aliased.windows(2).any(|pair| pair[0] == pair[1]);
    for (digest, id) in &rows {
      repeated = repeated || existing_git(id)?.is_some_and(|held| held != *digest);
    }
    if repeated {
      return Err(StoreError::Corrupt("two alias rows have the same native ID".into()));
    }
    for entry in &snapshot.refs {
      if let RefTarget::Direct(id) = &entry.target
        && !(self.present.contains(id)
          && (aliased.binary_search(id).is_ok() || existing_git(id)?.is_some()))
      {
        return Err(StoreError::Codec(format!(
          "the snapshot's ref {} names {id}, which is not an imported object",
          String::from_utf8_lossy(&entry.name)
        )));
      }
    }
    // The held metadata goes in first, so the snapshot is last (§3.2). The
    // container stays the writer's until both are in, so a failure abandons
    // it.
    let open = self.container.as_mut().expect("an open container");
    self.held.write(open)?;
    let body = snapshot.encode();
    let id = NativeId::of(Type::Snapshot, &body);
    if !self.present.contains(&id) {
      open.add(&id, Type::Snapshot, Form::Body, &body)?;
    }
    let container = self.container.take().expect("an open container");
    let mut rows: Vec<(Vec<u8>, Short)> = rows
      .into_iter()
      .map(|(digest, id)| (digest, id.short()))
      .collect();
    rows.append(&mut self.existing_rows);
    rows.sort();
    rows.dedup();
    let aliases = Aliases::new(self.algorithm, rows).map_err(StoreError::Corrupt)?.encode();
    let file = self.staging.join("aliases").join(self.algorithm.name());
    let named = self.staging.join("snapshot");
    let snapshot_file = format!("{}\n", id.hex());
    if self.existing.is_none() {
      let path = container.finish()?;
      self.check_bound(&path)?;
      write(&file, &aliases)?;
      write(&named, snapshot_file.as_bytes())?;
      write(&self.staging.join("format"), FORMAT)?;
      let store = self.root.join(".cst");
      std::fs::rename(&self.staging, &store).map_err(|error| StoreError::io(&store, error))?;
      return Ok(store);
    }
    // An import that finds nothing new adds no container, and a file it would
    // write unchanged is left as it is.
    if container.is_empty() {
      container.abandon();
    } else {
      let path = container.finish()?;
      // Placed first, so a refusal below takes it back.
      self.placed.container = Some(path.clone());
      self.check_bound(&path)?;
      sync_directory(&self.staging.join("objects"));
    }
    let before = match std::fs::read(&file) {
      Ok(bytes) => Some(bytes),
      Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
      Err(error) => return Err(StoreError::io(&file, error)),
    };
    if before.as_deref() != Some(aliases.as_slice()) {
      self.placed.aliases = Some(before);
      replace(&file, &aliases)?;
    }
    if self.existing.as_ref().map(|store| store.snapshot) != Some(id) {
      replace(&named, snapshot_file.as_bytes())?;
    }
    self.placed.snapshot = true;
    Ok(self.staging.clone())
  }
}

/// An import into an existing store that does not finish takes back what it
/// put in place, so the store is as it was, and releases the store.
impl Drop for StoreWriter {
  fn drop(&mut self) {
    self.held.discard();
    self.held_objects.discard();
    if self.existing.is_none() {
      return;
    }
    if let Some(container) = self.container.take() {
      container.abandon();
    }
    let file = self.staging.join("aliases").join(self.algorithm.name());
    let _ = std::fs::remove_file(temporary(&file));
    let _ = std::fs::remove_file(temporary(&self.staging.join("snapshot")));
    if !self.placed.snapshot {
      // The earlier alias file goes back before the container its new rows
      // name is removed, so no row is left naming what the store lacks.
      let restored = match self.placed.aliases.take() {
        Some(Some(bytes)) => replace(&file, &bytes).is_ok(),
        Some(None) => std::fs::remove_file(&file).is_ok(),
        None => true,
      };
      if restored && let Some(container) = self.placed.container.take() {
        let _ = std::fs::remove_file(container);
      }
    }
    let _ = std::fs::remove_file(self.staging.join(LOCK));
  }
}

/// Where a file is written before it replaces the one at `path`.
fn temporary(path: &Path) -> PathBuf {
  let mut name = path.file_name().unwrap_or_default().to_os_string();
  name.push(".tmp");
  path.with_file_name(name)
}

/// Replaces a file a reader may be reading: its bytes are written under a
/// temporary name and synced, then renamed over it, so a reader sees one or
/// the other, and a crash leaves one or the other.
fn replace(path: &Path, bytes: &[u8]) -> Result<(), StoreError> {
  let written = temporary(path);
  let mut file = std::fs::File::create(&written).map_err(|error| StoreError::io(&written, error))?;
  file
    .write_all(bytes)
    .and_then(|()| file.sync_all())
    .map_err(|error| StoreError::io(&written, error))?;
  drop(file);
  std::fs::rename(&written, path).map_err(|error| StoreError::io(path, error))?;
  sync_directory(path.parent().unwrap_or(path));
  Ok(())
}

/// Makes a rename in this directory durable, where the platform allows it.
fn sync_directory(directory: &Path) {
  #[cfg(unix)]
  if let Ok(handle) = std::fs::File::open(directory) {
    let _ = handle.sync_all();
  }
  #[cfg(not(unix))]
  let _ = directory;
}

fn write(path: &Path, bytes: &[u8]) -> Result<(), StoreError> {
  std::fs::write(path, bytes).map_err(|error| StoreError::io(path, error))
}

/// An object read from the store: its type and its body, or for content its
/// bytes, verified against its ID.
#[derive(Debug)]
pub struct Object {
  pub kind: Type,
  pub body: Vec<u8>,
}

/// Why an alias row resolves to no one object (objects.md §1.3). Each says
/// what the row names, to follow "the row" or "it".
#[derive(Debug)]
pub enum Unresolved {
  /// No candidate; none that verifies, every one present; or more than one
  /// that verifies.
  Corrupt(String),
  /// None verifies, and an absent candidate might: as a chunk list naming
  /// absent content is (objects.md §8), the row is unverified, not corrupt.
  Unverified(String),
}

impl Unresolved {
  /// What the row names, and why it resolves to no one object.
  pub fn why(&self) -> &str {
    match self {
      Unresolved::Corrupt(why) | Unresolved::Unverified(why) => why,
    }
  }
}

/// A store opened for reading: the marker and `snapshot`, checked, and each
/// alias file and container opened with the checks of constant cost
/// (objects.md §9.1; storage.md §4.1). Opening it and answering one lookup
/// read a part of it bounded whatever its object count, and one more for
/// each container. Objects are read and verified on demand. The whole-file
/// checks are [`Store::load_aliases`]'s and [`Store::indexes`]'s. Before a
/// lookup reports a miss, and before an abbreviation resolves, the files it
/// searched are checked whole, at most once each per opened store, which a
/// command opens once (#389). Damage they find is refused, not answered as a
/// miss. Once a file is read whole, every later lookup answers from what was
/// read, not from the file, so a command that reads the store whole makes no
/// read per lookup (#392).
pub struct Store {
  pub root: PathBuf,
  /// The current ref snapshot's ID, which the store holds.
  pub snapshot: NativeId,
  containers: Vec<Container>,
  aliases: Vec<AliasFile>,
  frame: RefCell<Option<((usize, u32), Rc<Vec<u8>>)>>,
  /// The bytes of the marker and `snapshot`.
  opened: u64,
  /// What this store has read whole, so none is read twice and later
  /// lookups answer from it.
  whole: RefCell<Whole>,
}

/// The files an opened store has read whole, with every check (#389), kept
/// so that every later lookup answers from them, not from the files: a
/// command that reads the store whole, such as the reconstruction check,
/// `cst fsck` or an import, then makes no read per lookup (#392).
#[derive(Default)]
struct Whole {
  /// Every container's index, in name order.
  indexes: Option<Rc<Vec<Index>>>,
  /// Each alias file read so far.
  aliases: Vec<Rc<Aliases>>,
}

/// The version a root marker of another build names: `causet-native-store`,
/// a space, a number in decimal without leading zeros, and a line feed.
fn marker_version(marker: &[u8]) -> Option<&str> {
  let number = std::str::from_utf8(marker).ok()?.strip_prefix(MARKER)?.strip_suffix('\n')?;
  let digits = !number.is_empty() && number.bytes().all(|byte| byte.is_ascii_digit());
  (digits && (number == "0" || !number.starts_with('0'))).then_some(number)
}

impl Store {
  /// The store of the native repository whose root is `root`.
  pub fn open(root: &Path) -> Result<Store, StoreError> {
    let store = root.join(".cst");
    let format = store.join("format");
    let marker = std::fs::read(&format).map_err(|error| StoreError::io(&format, error))?;
    if marker != FORMAT {
      return Err(StoreError::Unsupported(match marker_version(&marker) {
        Some(version) => format!(
          "{} says the store is format version {version}, and this build reads only version {}. \
           To use it with this build, import the repository again into a new directory",
          format.display(),
          crate::VERSION
        ),
        None => format!(
          "{} does not say {:?}, the only format this build reads",
          format.display(),
          String::from_utf8_lossy(&FORMAT[..FORMAT.len() - 1])
        ),
      }));
    }
    // `snapshot` is read first: an import replaces it last, so every alias
    // row and container it needs is in place before a reader can see it
    // (objects.md §10).
    let file = store.join("snapshot");
    let named = std::fs::read(&file).map_err(|error| match error.kind() {
      std::io::ErrorKind::NotFound => StoreError::Corrupt(format!(
        "{} is missing, so the store names no refs",
        file.display()
      )),
      _ => StoreError::io(&file, error),
    })?;
    let snapshot = std::str::from_utf8(&named)
      .ok()
      .and_then(|text| text.strip_suffix('\n'))
      .filter(|hex| hex.len() == 64 && *hex == hex.to_lowercase())
      .and_then(NativeId::from_hex)
      .ok_or_else(|| {
        StoreError::Corrupt(format!(
          "{} does not hold a native ID as 64 lowercase hex digits and a line feed",
          file.display()
        ))
      })?;
    let mut aliases = Vec::new();
    for algorithm in [GitAlgorithm::Sha1, GitAlgorithm::Sha256] {
      let file = store.join("aliases").join(algorithm.name());
      match AliasFile::open(&file, algorithm) {
        Ok(opened) => aliases.push(opened),
        Err(StoreError::Io { errno: "ENOENT", .. }) => {}
        Err(error) => return Err(error),
      }
    }
    let objects = store.join("objects");
    let mut names = Vec::new();
    for entry in std::fs::read_dir(&objects).map_err(|error| StoreError::io(&objects, error))? {
      let entry = entry.map_err(|error| StoreError::io(&objects, error))?;
      let name = entry.file_name().to_string_lossy().into_owned();
      // Any other name is ignored, so a container can be written under a
      // temporary name (storage.md §4).
      if name.strip_suffix(".cstc").is_some_and(|stem| {
        stem.len() == 64 && unhex(stem).is_some() && stem == stem.to_lowercase()
      }) {
        names.push(entry.path());
      }
    }
    names.sort();
    let containers = names
      .iter()
      .map(|path| Container::open(path))
      .collect::<Result<Vec<_>, _>>()?;
    let store = Store {
      root: root.to_path_buf(),
      snapshot,
      containers,
      aliases,
      frame: RefCell::new(None),
      opened: (marker.len() + named.len()) as u64,
      whole: RefCell::new(Whole::default()),
    };
    match store.locate(&snapshot)? {
      Some((_, record)) if record.state == PRESENT && record.kind == Type::Snapshot => Ok(store),
      _ => Err(StoreError::Corrupt(format!(
        "{} names {snapshot}, which the store does not hold as a ref snapshot",
        file.display()
      ))),
    }
  }

  /// The current ref snapshot, with each direct ref checked to name an object
  /// the store holds, of the snapshot's Git algorithm (objects.md §6).
  /// Content may be held absent (§8).
  pub fn refs(&self) -> Result<Snapshot, StoreError> {
    let read = self.read_known(&self.snapshot)?;
    let corrupt = |what: String| StoreError::Corrupt(format!("{}: {what}", self.snapshot));
    let snapshot = Snapshot::decode(&read.body).map_err(corrupt)?;
    for entry in &snapshot.refs {
      if let RefTarget::Direct(id) = &entry.target {
        let name = String::from_utf8_lossy(&entry.name);
        if self.locate(id)?.is_none() {
          return Err(corrupt(format!(
            "its ref {name} names {id}, which the store does not hold"
          )));
        }
        if self.git(snapshot.algorithm, id)?.is_none() {
          return Err(corrupt(format!(
            "its ref {name} names {id}, which has no {} alias row",
            snapshot.algorithm.name()
          )));
        }
      }
    }
    Ok(snapshot)
  }

  /// The bytes this store has read from its files: the marker, `snapshot`,
  /// what its alias files and containers have read, and the indexes it has
  /// checked whole. A test holds a lookup's cost to a bound by it (#331).
  pub fn bytes_read(&self) -> u64 {
    self.opened
      + self.loaded_indexes().map_or(0, |indexes| indexes.iter().map(Index::bytes_read).sum::<u64>())
      + self.aliases.iter().map(AliasFile::bytes_read).sum::<u64>()
      + self.containers.iter().map(Container::bytes_read).sum::<u64>()
  }

  /// The Git algorithms the store has an alias file of.
  pub fn algorithms(&self) -> Vec<GitAlgorithm> {
    self.aliases.iter().map(|file| file.algorithm).collect()
  }

  /// Every alias file whole, with every check (objects.md §9.1): its
  /// trailer, both orders and the native order's permutation. Each is read
  /// once per opened store, and later lookups answer from it.
  pub fn load_aliases(&self) -> Result<Vec<Rc<Aliases>>, StoreError> {
    self.aliases.iter().map(|file| self.whole_aliases(file)).collect()
  }

  /// One alias file whole, read once per opened store.
  fn whole_aliases(&self, file: &AliasFile) -> Result<Rc<Aliases>, StoreError> {
    if let Some(loaded) = self.loaded_aliases(file.algorithm) {
      return Ok(loaded);
    }
    let loaded = Rc::new(file.full()?);
    self.whole.borrow_mut().aliases.push(loaded.clone());
    Ok(loaded)
  }

  /// An algorithm's alias file, when this store has read it whole.
  fn loaded_aliases(&self, algorithm: GitAlgorithm) -> Option<Rc<Aliases>> {
    let whole = self.whole.borrow();
    whole.aliases.iter().find(|aliases| aliases.algorithm == algorithm).cloned()
  }

  /// An algorithm's alias file checked whole, once per opened store: what a
  /// lookup by Git ID, or of a native ID's row, runs before it reports a miss
  /// (#389).
  fn check_aliases(&self, file: &AliasFile) -> Result<(), StoreError> {
    self.whole_aliases(file).map(drop)
  }

  /// Every container's whole index, in name order, with every check
  /// (storage.md §4.1): the index's SHA-256, the orders of its frames and
  /// names, and its annotation table. They are read once per opened store,
  /// and later lookups answer from them.
  pub fn indexes(&self) -> Result<Rc<Vec<Index>>, StoreError> {
    if let Some(loaded) = self.loaded_indexes() {
      return Ok(loaded);
    }
    let indexes = self
      .containers
      .iter()
      .map(|container| Index::read(&container.path))
      .collect::<Result<Vec<_>, _>>()?;
    let loaded = Rc::new(indexes);
    self.whole.borrow_mut().indexes = Some(loaded.clone());
    Ok(loaded)
  }

  /// Every index, when this store has read them whole.
  fn loaded_indexes(&self) -> Option<Rc<Vec<Index>>> {
    self.whole.borrow().indexes.clone()
  }

  /// Every container's index checked whole, once per opened store: what a
  /// lookup by native ID runs before it reports a miss (#389).
  fn check_indexes(&self) -> Result<(), StoreError> {
    self.indexes().map(drop)
  }

  /// Reads every index and alias file whole, with every check, for a command
  /// that will look up many objects: each lookup then answers from what was
  /// read, at a cost the store's size sets once (#392).
  pub fn read_whole(&self) -> Result<(), StoreError> {
    self.indexes()?;
    self.load_aliases().map(drop)
  }

  fn alias_file(&self, algorithm: GitAlgorithm) -> Option<&AliasFile> {
    self.aliases.iter().find(|file| file.algorithm == algorithm)
  }

  /// The object a Git ID's alias row names, its short reference resolved
  /// (objects.md §9.1): `None` when the Git ID has no row, or when only an
  /// absent candidate could verify it. A row that resolves to no object is
  /// corrupt. Before it reports no row, the alias file is checked whole.
  pub fn native(&self, algorithm: GitAlgorithm, git_digest: &[u8]) -> Result<Option<NativeId>, StoreError> {
    // A digest not of the algorithm's length is no Git ID of it.
    let Some(file) = self.alias_file(algorithm).filter(|_| git_digest.len() == algorithm.length()) else {
      return Ok(None);
    };
    let short = match self.loaded_aliases(algorithm) {
      Some(whole) => whole.short(git_digest),
      None => file.short(git_digest)?,
    };
    let Some(short) = short else {
      self.check_aliases(file)?;
      return Ok(None);
    };
    match self.resolve_row(algorithm, git_digest, &short)? {
      Ok(native) => Ok(Some(native)),
      // Damage could hide the present candidate that verifies.
      Err(Unresolved::Unverified(_)) => {
        self.check_indexes()?;
        Ok(None)
      }
      Err(Unresolved::Corrupt(why)) => Err(StoreError::Corrupt(format!(
        "the {} alias row of {} {why}",
        algorithm.name(),
        hex(git_digest)
      ))),
    }
  }

  /// An object's Git digest in an algorithm: among the rows holding its
  /// short reference, the one that is its own, confirmed by its full ID
  /// (objects.md §9.1). When it is the reference's one candidate and one row
  /// holds it, that row is its own; otherwise its own row is the one whose
  /// Git ID its Git encoding has. Before it reports no row, the alias file
  /// is checked whole.
  pub fn git(&self, algorithm: GitAlgorithm, id: &NativeId) -> Result<Option<Vec<u8>>, StoreError> {
    let Some(file) = self.alias_file(algorithm) else {
      return Ok(None);
    };
    let short = id.short();
    let rows = match self.loaded_aliases(algorithm) {
      Some(whole) => whole.sharing(&short).map(<[u8]>::to_vec).collect(),
      None => file.sharing(&short)?,
    };
    match rows.as_slice() {
      [] => {
        self.check_aliases(file)?;
        return Ok(None);
      }
      [one] if self.sole(&short, id)? => return Ok(Some(one.clone())),
      _ => {}
    }
    // An object with no Git encoding in the algorithm has no row of it.
    let Ok(own) = reconstruct::git_id_of(self, algorithm, id)? else {
      return Ok(None);
    };
    let found = rows.into_iter().find(|digest| *digest == own);
    if found.is_none() {
      self.check_aliases(file)?;
    }
    Ok(found)
  }

  /// An alias row's object (objects.md §1.3): a short reference's one
  /// candidate, or among several, the one present candidate whose Git
  /// encoding has the row's Git ID. The outer `Err` is a lookup that could
  /// not be answered.
  pub fn resolve_row(
    &self,
    algorithm: GitAlgorithm,
    git_digest: &[u8],
    short: &Short,
  ) -> Result<Result<NativeId, Unresolved>, StoreError> {
    let candidates = self.candidates(short)?;
    if let [one] = candidates.as_slice() {
      return Ok(Ok(*one));
    }
    let named = hex(short);
    if candidates.is_empty() {
      return Ok(Err(Unresolved::Corrupt(format!(
        "names {named}, a short reference no index entry's name begins with"
      ))));
    }
    let mut verified = Vec::new();
    let mut absent = false;
    for candidate in candidates {
      if self.locate(&candidate)?.is_some_and(|(_, record)| record.state != PRESENT) {
        absent = true;
      } else if reconstruct::git_id_of(self, algorithm, &candidate)
        .is_ok_and(|own| own.is_ok_and(|id| id == git_digest))
      {
        // A candidate that does not read is not this row's: if no other
        // verifies, the row is corrupt.
        verified.push(candidate);
      }
    }
    Ok(match verified.as_slice() {
      [one] => Ok(*one),
      [] if absent => Err(Unresolved::Unverified(format!(
        "names {named}, and no present candidate's Git encoding has its Git ID"
      ))),
      [] => Err(Unresolved::Corrupt(format!(
        "names {named}, and no candidate's Git encoding has its Git ID"
      ))),
      _ => Err(Unresolved::Corrupt(format!(
        "names {named}, and more than one candidate's Git encoding has its Git ID"
      ))),
    })
  }

  /// Whether `id` is a short reference's one candidate, without collecting
  /// them: the lookup every row of an unshared store takes.
  fn sole(&self, short: &Short, id: &NativeId) -> Result<bool, StoreError> {
    let mut found = false;
    let loaded = self.loaded_indexes();
    for (number, container) in self.containers.iter().enumerate() {
      let lazy;
      let names = match &loaded {
        Some(indexes) => indexes[number].starting(short),
        None => {
          lazy = container.starting(short)?;
          lazy.as_slice()
        }
      };
      match names {
        [] => {}
        [name] if *name == id.0 => found = true,
        _ => return Ok(false),
      }
    }
    Ok(found)
  }

  /// Every object the store holds present, once, with its type and stored
  /// form, in storage order (container, frame, offset): the copy a read uses.
  /// It reads every index whole, with every check.
  pub fn present(&self) -> Result<Vec<(NativeId, Type, Form)>, StoreError> {
    let mut seen = HashSet::new();
    let mut found = Vec::new();
    for (number, index) in self.indexes()?.iter().enumerate() {
      for (name, record) in index.names.iter().zip(&index.records) {
        if record.state == PRESENT && seen.insert(*name) {
          found.push(((number, record.frame, record.offset), NativeId(*name), *record));
        }
      }
    }
    found.sort_by_key(|(at, _, _)| *at);
    Ok(
      found
        .into_iter()
        .map(|(_, id, record)| (id, record.kind, record.form))
        .collect(),
    )
  }

  /// A content object's chunk list, as stored: what it names, unresolved.
  pub fn chunk_list(&self, id: &NativeId) -> Result<ChunkList, StoreError> {
    match self.record(id)? {
      (Type::Content, Form::ChunkList, record) => {
        ChunkList::decode(&record).map_err(|what| StoreError::Corrupt(format!("{id}: {what}")))
      }
      _ => Err(StoreError::NotFound(format!(
        "{id} is not stored as a chunk list"
      ))),
    }
  }

  /// Where an object is: a present copy if any container has one. Before it
  /// reports that none does, absent or not held, every index is checked
  /// whole: damage could hide a present copy.
  pub(crate) fn locate(&self, id: &NativeId) -> Result<Option<(usize, Record)>, StoreError> {
    let mut found = None;
    if let Some(indexes) = self.loaded_indexes() {
      for (number, index) in indexes.iter().enumerate() {
        if let Some(record) = index.find(id) {
          if record.state == PRESENT {
            return Ok(Some((number, *record)));
          }
          found.get_or_insert((number, *record));
        }
      }
      return Ok(found);
    }
    for (number, container) in self.containers.iter().enumerate() {
      if let Some(record) = container.find(id)? {
        if record.state == PRESENT {
          return Ok(Some((number, record)));
        }
        found.get_or_insert((number, record));
      }
    }
    // Damage a lookup does not check can make it miss (storage.md §4.1).
    self.check_indexes()?;
    Ok(found)
  }

  /// The objects whose text form begins with `prefix`, in lowercase hex,
  /// and whose type `accept` takes, each once. Every index is checked whole
  /// first: names out of order could hide a match, found or not (#389).
  pub fn matching(&self, prefix: &str, accept: impl Fn(Type) -> bool) -> Result<Vec<NativeId>, StoreError> {
    let mut found: Vec<NativeId> = Vec::new();
    for index in self.indexes()?.iter() {
      for (id, kind) in index.prefixed(prefix) {
        if accept(kind) && !found.contains(&id) {
          found.push(id);
        }
      }
    }
    Ok(found)
  }

  /// A short reference's candidates (objects.md §1.3): every object, present
  /// or absent, whose digest begins with it, in any container, each once and
  /// in order.
  pub fn candidates(&self, short: &Short) -> Result<Vec<NativeId>, StoreError> {
    let mut found = Vec::new();
    match self.loaded_indexes() {
      Some(indexes) => {
        for index in indexes.iter() {
          found.extend(index.starting(short).iter().copied().map(NativeId));
        }
      }
      None => {
        for container in &self.containers {
          found.extend(container.starting(short)?.into_iter().map(NativeId));
        }
      }
    }
    found.sort();
    found.dedup();
    Ok(found)
  }

  /// A tree stored in short references, resolved (objects.md §4.4). The
  /// inner `Err` is its corruption.
  pub(crate) fn unshorten(&self, id: &NativeId, record: &[u8]) -> Result<Result<Tree, String>, StoreError> {
    let failed = RefCell::new(None);
    let resolved = ShortTree::decode(record).and_then(|short| {
      short.resolve(id, &|short| {
        self.candidates(short).unwrap_or_else(|error| {
          failed.borrow_mut().get_or_insert(error);
          Vec::new()
        })
      })
    });
    match failed.into_inner() {
      Some(error) => Err(error),
      None => Ok(resolved),
    }
  }

  fn record(&self, id: &NativeId) -> Result<(Type, Form, Vec<u8>), StoreError> {
    let (number, record) = self
      .locate(id)?
      .ok_or_else(|| StoreError::NotFound(format!("{id} is not in this store")))?;
    if record.state != PRESENT {
      let state = if record.state == 1 {
        "absent by promise"
      } else {
        "absent by policy"
      };
      return Err(StoreError::Absent(format!("{id} is {state}")));
    }
    let key = (number, record.frame);
    let cached = self
      .frame
      .borrow()
      .as_ref()
      .filter(|(at, _)| *at == key)
      .map(|(_, bytes)| bytes.clone());
    let frame = match cached {
      Some(frame) => frame,
      None => {
        // A loaded index has every frame's entry already.
        let frame = Rc::new(match self.loaded_indexes() {
          Some(indexes) => indexes[number].frame(record.frame)?,
          None => self.containers[number].frame(record.frame)?,
        });
        *self.frame.borrow_mut() = Some((key, frame.clone()));
        frame
      }
    };
    let start = record.offset as usize;
    Ok((
      record.kind,
      record.form,
      frame[start..start + record.length as usize].to_vec(),
    ))
  }

  /// An object, resolved from its stored form and verified by its ID.
  pub fn read(&self, id: &NativeId) -> Result<Object, StoreError> {
    let (kind, form, record) = self.record(id)?;
    let body = match form {
      Form::Body => record,
      Form::ChunkList => self.resolve(id, &record)?,
      // Each version a delta produces is verified as it is produced.
      Form::Delta => return Ok(Object { kind, body: self.undelta(id, &record)? }),
      // Resolution keeps only the choice whose body hashes to the ID.
      Form::ShortReferences => {
        let tree = self
          .unshorten(id, &record)?
          .map_err(|what| StoreError::Corrupt(format!("{id}: {what}")))?;
        return Ok(Object { kind, body: tree.encode() });
      }
    };
    if NativeId::of(kind, &body) != *id {
      return Err(StoreError::Corrupt(format!(
        "{id}: its bytes do not hash to its ID"
      )));
    }
    Ok(Object { kind, body })
  }

  /// A known object, which the store must hold: one it does not is corrupt
  /// (objects.md §8).
  pub fn read_known(&self, id: &NativeId) -> Result<Object, StoreError> {
    self.read(id).map_err(|error| match error {
      StoreError::NotFound(_) => {
        StoreError::Corrupt(format!("{id} is named in the store but not held by it"))
      }
      other => other,
    })
  }

  /// An object's type, from the index alone, when any container lists it.
  pub fn held(&self, id: &NativeId) -> Result<Option<Type>, StoreError> {
    Ok(self.locate(id)?.map(|(_, record)| record.kind))
  }

  /// A content object's length, from its record alone: its bytes, or the
  /// size its chunk list gives.
  pub fn content_size(&self, id: &NativeId) -> Result<u64, StoreError> {
    match self.record(id)? {
      (Type::Content, Form::Body, record) => Ok(record.len() as u64),
      (Type::Content, Form::ChunkList, record) => ChunkList::decode(&record)
        .map(|list| list.size)
        .map_err(|what| StoreError::Corrupt(format!("{id}: {what}"))),
      (Type::Content, Form::Delta, record) => Delta::decode(&record)
        .map(|delta| delta.size)
        .map_err(|what| StoreError::Corrupt(format!("{id}: {what}"))),
      _ => Err(StoreError::NotFound(format!("{id} is not content"))),
    }
  }

  /// The type of a known object, from the index alone.
  pub fn known_kind(&self, id: &NativeId) -> Result<Type, StoreError> {
    self
      .locate(id)?
      .map(|(_, record)| record.kind)
      .ok_or_else(|| StoreError::Corrupt(format!("{id} is named in the store but not held by it")))
  }

  /// A delta's content (storage.md §5): its chain followed to the first base
  /// that is not a delta, at most 8 deltas deep, that base read and verified,
  /// then each delta applied in turn, and each version it produces verified
  /// by its ID. A delta whose base the store does not hold present is
  /// corrupt (§5.2).
  pub(crate) fn undelta(&self, id: &NativeId, record: &[u8]) -> Result<Vec<u8>, StoreError> {
    let corrupt = |at: &NativeId, what: String| StoreError::Corrupt(format!("{at}: {what}"));
    let decode = |at: &NativeId, record: &[u8]| Delta::decode(record).map_err(|what| corrupt(at, what));
    // Only each delta's ID is kept while the chain is followed: its record
    // is read again when it is applied, so one delta is in memory at a time.
    let mut chain = vec![*id];
    let mut base = decode(id, record)?.base;
    let mut bytes = loop {
      let at = *chain.last().expect("a delta");
      let (kind, form, base_record) = self.record(&base).map_err(|error| match error {
        StoreError::NotFound(_) => corrupt(&at, format!("its base {base} is not in this store")),
        StoreError::Absent(why) => corrupt(&at, format!("its base is absent: {why}")),
        other => other,
      })?;
      if kind != Type::Content {
        return Err(corrupt(&at, format!("its base {base} is not content")));
      }
      let content = match form {
        Form::Body => base_record,
        Form::ChunkList => self.resolve(&base, &base_record)?,
        Form::Delta => {
          if chain.len() == DEPTH_LIMIT {
            return Err(corrupt(id, "its chain of deltas is deeper than 8".into()));
          }
          let next = decode(&base, &base_record)?.base;
          chain.push(base);
          base = next;
          continue;
        }
        Form::ShortReferences => unreachable!("an index admits short references only for a tree"),
      };
      if NativeId::of(Type::Content, &content) != base {
        return Err(corrupt(&base, "its bytes do not hash to its ID".into()));
      }
      break content;
    };
    while let Some(at) = chain.pop() {
      let delta = if at == *id {
        decode(id, record)?
      } else {
        decode(&at, &self.record(&at)?.2)?
      };
      bytes = delta::decompress(&bytes, &delta.data, delta.size).map_err(|error| match error {
        StoreError::Corrupt(what) => corrupt(&at, what),
        other => other,
      })?;
      if NativeId::of(Type::Content, &bytes) != at {
        return Err(corrupt(&at, "its delta does not produce its content".into()));
      }
    }
    Ok(bytes)
  }

  /// A content object's depth (storage.md §5.2), from its records alone: 0
  /// for bytes and for a chunk list, one more than its base's for a delta.
  pub fn depth(&self, id: &NativeId) -> Result<usize, StoreError> {
    let mut depth = 0;
    let mut at = *id;
    while let (_, Form::Delta, record) = self.record(&at)? {
      if depth == DEPTH_LIMIT {
        return Err(StoreError::Corrupt(format!(
          "{id}: its chain of deltas is deeper than 8"
        )));
      }
      depth += 1;
      at = Delta::decode(&record)
        .map_err(|what| StoreError::Corrupt(format!("{at}: {what}")))?
        .base;
    }
    Ok(depth)
  }

  /// A chunk list's content, resolved without recursion. Each element must be
  /// content of exactly its listed length, so a nested list is strictly
  /// shorter than the one naming it and resolution ends (objects.md §3.3);
  /// each nested list is verified by its ID as well.
  pub(crate) fn resolve(&self, id: &NativeId, record: &[u8]) -> Result<Vec<u8>, StoreError> {
    enum Step {
      Chunk(NativeId, u64),
      Verify(NativeId, usize),
    }
    let corrupt = |at: &NativeId, what: &str| StoreError::Corrupt(format!("{at}: {what}"));
    let list = ChunkList::decode(record).map_err(|what| corrupt(id, &what))?;
    let mut out = Vec::with_capacity(list.size.min(64 << 20) as usize);
    let mut steps: Vec<Step> = list
      .chunks
      .iter()
      .rev()
      .map(|(chunk, length)| Step::Chunk(*chunk, *length))
      .collect();
    while let Some(step) = steps.pop() {
      match step {
        Step::Verify(chunk, start) => {
          if NativeId::of(Type::Content, &out[start..]) != chunk {
            return Err(corrupt(&chunk, "its chunks do not hash to its ID"));
          }
        }
        Step::Chunk(chunk, length) => {
          let (kind, form, record) = self.record(&chunk).map_err(|error| match error {
            StoreError::NotFound(_) => corrupt(
              id,
              &format!("its chunk list names {chunk}, which the store does not hold"),
            ),
            other => other,
          })?;
          if kind != Type::Content {
            return Err(corrupt(
              id,
              &format!("its chunk list names {chunk}, which is not content"),
            ));
          }
          match form {
            Form::Body => {
              if record.len() as u64 != length || NativeId::of(Type::Content, &record) != chunk {
                return Err(corrupt(
                  &chunk,
                  "it is not content of the length its chunk list gives",
                ));
              }
              out.extend_from_slice(&record);
            }
            Form::ChunkList => {
              let nested = ChunkList::decode(&record).map_err(|what| corrupt(&chunk, &what))?;
              if nested.size != length {
                return Err(corrupt(
                  &chunk,
                  "it is not content of the length its chunk list gives",
                ));
              }
              steps.push(Step::Verify(chunk, out.len()));
              steps.extend(
                nested
                  .chunks
                  .iter()
                  .rev()
                  .map(|(inner, length)| Step::Chunk(*inner, *length)),
              );
            }
            // A chunk is at most 64 KiB, and a delta at least 1 MiB, so a
            // chunk is never stored as one (objects.md §3.3), and a chunk
            // list never resolves through a delta back to itself.
            Form::Delta => {
              return Err(corrupt(
                id,
                &format!("its chunk list names {chunk}, which is stored as a delta"),
              ));
            }
            Form::ShortReferences => {
              unreachable!("an index admits short references only for a tree")
            }
          }
        }
      }
    }
    Ok(out)
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::objects::{Entry, Kind};

  #[test]
  fn objects_written_after_a_tree_that_share_its_references_count_against_its_bound() {
    let root = std::env::temp_dir().join(format!("causet-store-unit-{}-bound", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let mut writer = StoreWriter::create(&root, GitAlgorithm::Sha1).unwrap();
    let targets: Vec<NativeId> = (0..17u8).map(|n| writer.put_content(&[n]).unwrap()).collect();
    let tree = Tree::from_entries(
      targets
        .iter()
        .enumerate()
        .map(|(n, target)| Entry {
          name: format!("f{n:02}").into_bytes(),
          kind: Kind::File,
          target: Target::Native(*target),
        })
        .collect(),
    )
    .unwrap();
    // One candidate each when the tree is written.
    let id = writer.put_tree(&tree, b"").unwrap();
    // Then objects of the same import sharing each target's 8 bytes, as a
    // history built to collide would hold: 2^17 choices once they are written.
    for target in &targets {
      let mut digest = target.0;
      digest[31] ^= 0xff;
      writer.present.insert(NativeId(digest));
    }
    match writer.finish(&Snapshot::new(GitAlgorithm::Sha1, Vec::new()).unwrap()) {
      Err(StoreError::TooLarge(why)) => assert_eq!(
        why,
        format!("the tree {id}'s short references would allow 131072 choices, and a tree may need at most 65536")
      ),
      other => panic!("{other:?}"),
    }
    std::fs::remove_dir_all(&root).unwrap();
  }
}
