//! A native repository's store (objects.md §10): writing one, and reading it
//! back with every object verified by its ID.

use crate::StoreError;
use crate::alias::Aliases;
use crate::chunker;
use crate::container::{Container, ContainerWriter, Form, PRESENT, Record};
use crate::id::{GitAlgorithm, NativeId, Type, unhex};
use crate::objects::{ChunkList, Preserved, RefTarget, Snapshot, Tree};
use std::cell::RefCell;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// The root marker's exact content.
pub const FORMAT: &[u8] = b"causet-native-store 0\n";
/// Content no longer than this is stored as its bytes (storage.md §1).
const SMALL: usize = 2048;
const STAGING: &str = ".cst-import";

/// Writes a new store into an empty destination. Nothing is visible as a
/// native repository until `finish` renames the finished `.cst/` into place.
pub struct StoreWriter {
  root: PathBuf,
  staging: PathBuf,
  algorithm: GitAlgorithm,
  container: Option<ContainerWriter>,
  present: HashSet<NativeId>,
  aliases: Vec<(Vec<u8>, NativeId)>,
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
      staging,
      algorithm,
      present: HashSet::new(),
      aliases: Vec::new(),
    })
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
  /// small or one chunk, otherwise a chunk list and each new chunk. Deltas
  /// come with #306.
  pub fn put_content(&mut self, bytes: &[u8]) -> Result<NativeId, StoreError> {
    let id = NativeId::of(Type::Content, bytes);
    if self.present.contains(&id) {
      return Ok(id);
    }
    let chunks: Vec<&[u8]> = if bytes.len() <= SMALL {
      vec![bytes]
    } else {
      chunker::chunks(bytes).collect()
    };
    if chunks.len() <= 1 {
      self.add(&id, Type::Content, Form::Body, bytes)?;
      return Ok(id);
    }
    let mut list = ChunkList {
      size: bytes.len() as u64,
      chunks: Vec::with_capacity(chunks.len()),
    };
    for chunk in chunks {
      let chunk_id = NativeId::of(Type::Content, chunk);
      if !self.present.contains(&chunk_id) {
        self.add(&chunk_id, Type::Content, Form::Body, chunk)?;
      }
      list.chunks.push((chunk_id, chunk.len() as u64));
    }
    self.add(&id, Type::Content, Form::ChunkList, &list.encode())?;
    Ok(id)
  }

  pub fn put_tree(&mut self, tree: &Tree) -> Result<NativeId, StoreError> {
    self.put_metadata(Type::Tree, &tree.encode())
  }

  pub fn put_preserved(&mut self, preserved: &Preserved) -> Result<NativeId, StoreError> {
    self.put_metadata(Type::Preserved, &preserved.encode())
  }

  fn put_metadata(&mut self, kind: Type, body: &[u8]) -> Result<NativeId, StoreError> {
    let id = NativeId::of(kind, body);
    if !self.present.contains(&id) {
      self.add(&id, kind, Form::Body, body)?;
    }
    Ok(id)
  }

  /// Records that the Git object with this digest is the native object `id`.
  pub fn alias(&mut self, git_digest: Vec<u8>, id: NativeId) {
    self.aliases.push((git_digest, id));
  }

  /// Stores the ref snapshot, then writes the container, the alias file, the
  /// `snapshot` file and the marker, and renames the store into place: the
  /// commit point. Each direct ref must name a stored object with an alias
  /// row (objects.md §6).
  pub fn finish(mut self, snapshot: &Snapshot) -> Result<PathBuf, StoreError> {
    if snapshot.algorithm != self.algorithm {
      return Err(StoreError::Codec(format!(
        "a {} snapshot cannot finish a {} store",
        snapshot.algorithm.name(),
        self.algorithm.name()
      )));
    }
    let aliased: HashSet<NativeId> = self.aliases.iter().map(|(_, id)| *id).collect();
    for entry in &snapshot.refs {
      if let RefTarget::Direct(id) = &entry.target
        && !(self.present.contains(id) && aliased.contains(id))
      {
        return Err(StoreError::Codec(format!(
          "the snapshot's ref {} names {id}, which is not an imported object",
          String::from_utf8_lossy(&entry.name)
        )));
      }
    }
    let id = self.put_metadata(Type::Snapshot, &snapshot.encode())?;
    self.container.take().expect("an open container").finish()?;
    let aliases = Aliases::new(self.algorithm, std::mem::take(&mut self.aliases))
      .map_err(StoreError::Corrupt)?;
    let file = self.staging.join("aliases").join(self.algorithm.name());
    write(&file, &aliases.encode())?;
    write(
      &self.staging.join("snapshot"),
      format!("{}\n", id.hex()).as_bytes(),
    )?;
    write(&self.staging.join("format"), FORMAT)?;
    let store = self.root.join(".cst");
    std::fs::rename(&self.staging, &store).map_err(|error| StoreError::io(&store, error))?;
    Ok(store)
  }
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

/// A store opened for reading: the marker, the alias files and every
/// container's index, checked; objects are read and verified on demand.
pub struct Store {
  pub root: PathBuf,
  /// The current ref snapshot's ID, which the store holds.
  pub snapshot: NativeId,
  containers: Vec<Container>,
  aliases: Vec<Aliases>,
  frame: RefCell<Option<((usize, u32), std::rc::Rc<Vec<u8>>)>>,
}

impl Store {
  /// The store of the native repository whose root is `root`.
  pub fn open(root: &Path) -> Result<Store, StoreError> {
    let store = root.join(".cst");
    let format = store.join("format");
    let marker = std::fs::read(&format).map_err(|error| StoreError::io(&format, error))?;
    if marker != FORMAT {
      return Err(StoreError::Unsupported(format!(
        "{} does not say {:?}, the only format this build reads",
        format.display(),
        String::from_utf8_lossy(&FORMAT[..FORMAT.len() - 1])
      )));
    }
    let mut aliases = Vec::new();
    for algorithm in [GitAlgorithm::Sha1, GitAlgorithm::Sha256] {
      let file = store.join("aliases").join(algorithm.name());
      match std::fs::read(&file) {
        Ok(bytes) => aliases.push(
          Aliases::decode(&bytes, algorithm)
            .map_err(|what| StoreError::Corrupt(format!("{}: {what}", file.display())))?,
        ),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(StoreError::io(&file, error)),
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
    let store = Store {
      root: root.to_path_buf(),
      snapshot,
      containers,
      aliases,
      frame: RefCell::new(None),
    };
    match store.locate(&snapshot) {
      Some((_, record)) if record.state == PRESENT && record.kind == Type::Snapshot => Ok(store),
      _ => Err(StoreError::Corrupt(format!(
        "{} names {snapshot}, which the store does not hold as a ref snapshot",
        file.display()
      ))),
    }
  }

  /// The current ref snapshot, with each direct ref checked to name a present
  /// object of the snapshot's Git algorithm (objects.md §6).
  pub fn refs(&self) -> Result<Snapshot, StoreError> {
    let read = self.read_known(&self.snapshot)?;
    let corrupt = |what: String| StoreError::Corrupt(format!("{}: {what}", self.snapshot));
    let snapshot = Snapshot::decode(&read.body).map_err(corrupt)?;
    let aliases = self.aliases_for(snapshot.algorithm);
    for entry in &snapshot.refs {
      if let RefTarget::Direct(id) = &entry.target {
        let name = String::from_utf8_lossy(&entry.name);
        if !self
          .locate(id)
          .is_some_and(|(_, record)| record.state == PRESENT)
        {
          return Err(corrupt(format!(
            "its ref {name} names {id}, which the store does not hold"
          )));
        }
        if aliases.and_then(|aliases| aliases.git(id)).is_none() {
          return Err(corrupt(format!(
            "its ref {name} names {id}, which has no {} alias row",
            snapshot.algorithm.name()
          )));
        }
      }
    }
    Ok(snapshot)
  }

  pub fn aliases(&self) -> &[Aliases] {
    &self.aliases
  }

  /// The alias file of an algorithm, when the store has one.
  pub fn aliases_for(&self, algorithm: GitAlgorithm) -> Option<&Aliases> {
    self
      .aliases
      .iter()
      .find(|aliases| aliases.algorithm == algorithm)
  }

  /// Where an object is: a present copy if any container has one.
  fn locate(&self, id: &NativeId) -> Option<(usize, Record)> {
    let mut found = None;
    for (number, container) in self.containers.iter().enumerate() {
      if let Some(record) = container.find(id) {
        if record.state == PRESENT {
          return Some((number, *record));
        }
        found.get_or_insert((number, *record));
      }
    }
    found
  }

  /// The objects whose text form begins with `prefix`, at most two.
  pub fn matching(&self, prefix: &str) -> Vec<NativeId> {
    let mut found: Vec<NativeId> = Vec::new();
    for container in &self.containers {
      for name in &container.names {
        let id = NativeId(*name);
        if id.hex().starts_with(prefix) && !found.contains(&id) {
          found.push(id);
          if found.len() == 2 {
            return found;
          }
        }
      }
    }
    found
  }

  fn record(&self, id: &NativeId) -> Result<(Type, Form, Vec<u8>), StoreError> {
    let (number, record) = self
      .locate(id)
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
        let frame = std::rc::Rc::new(self.containers[number].frame(record.frame)?);
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
      Form::Delta => return Err(delta(id)),
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

  /// The type of a known object, from the index alone.
  pub fn known_kind(&self, id: &NativeId) -> Result<Type, StoreError> {
    self
      .locate(id)
      .map(|(_, record)| record.kind)
      .ok_or_else(|| StoreError::Corrupt(format!("{id} is named in the store but not held by it")))
  }

  /// A chunk list's content, resolved without recursion. Each element must be
  /// content of exactly its listed length, so a nested list is strictly
  /// shorter than the one naming it and resolution ends (objects.md §3.3);
  /// each nested list is verified by its ID as well.
  fn resolve(&self, id: &NativeId, record: &[u8]) -> Result<Vec<u8>, StoreError> {
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
            Form::Delta => return Err(delta(&chunk)),
          }
        }
      }
    }
    Ok(out)
  }
}

fn delta(id: &NativeId) -> StoreError {
  StoreError::Unsupported(format!(
    "{id} is stored as a delta, which this build does not read yet (#306)"
  ))
}
