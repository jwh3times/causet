//! Frames and containers (storage.md §3–§4): records grouped into zstd frames
//! of at most 4 MiB, one class per frame, written back to back into a
//! container that ends with its index and footer, and read back with every
//! check the contract lists for a reader that reads the index.

use crate::StoreError;
use crate::id::{NativeId, Type, hex};
use causet_model::sha256::{self, Sha256};
use std::collections::BTreeMap;
use std::fs::File;
use std::io::{BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

const CONTAINER_MAGIC: &[u8; 8] = b"CSTCNTNR";
const INDEX_MAGIC: &[u8; 8] = b"CSTINDEX";
const HEADER: u64 = 16;
const FOOTER: u64 = 72;
/// A frame's largest uncompressed size, unless it holds one larger record (§3.1).
pub const FRAME_LIMIT: usize = 4 * 1024 * 1024;
/// A container's largest total of compressed frame bytes (§4.3).
pub const CONTAINER_LIMIT: u64 = 1 << 30;
/// zstd's level for every frame (§3).
const LEVEL: i32 = 19;
const NO_FRAME: u32 = 0xffff_ffff;

/// A record's stored form (§1).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Form {
  Body = 0,
  ChunkList = 1,
  Delta = 2,
}

impl Form {
  fn from_code(code: u8) -> Option<Form> {
    match code {
      0 => Some(Form::Body),
      1 => Some(Form::ChunkList),
      2 => Some(Form::Delta),
      _ => None,
    }
  }
}

/// The object states of objects.md §8, by code.
pub const PRESENT: u8 = 0;
pub const ABSENT_BY_PROMISE: u8 = 1;
pub const ABSENT_BY_POLICY: u8 = 2;

const METADATA: u8 = 0;
const CONTENT: u8 = 1;
const STORED: u8 = 0;
const ZSTD: u8 = 1;

fn class_of(kind: Type) -> u8 {
  if kind == Type::Content {
    CONTENT
  } else {
    METADATA
  }
}

#[derive(Clone, Debug)]
pub struct Frame {
  pub offset: u64,
  pub compressed: u64,
  pub uncompressed: u32,
  pub codec: u8,
  pub class: u8,
}

#[derive(Clone, Copy, Debug)]
pub struct Record {
  pub kind: Type,
  pub form: Form,
  pub state: u8,
  pub frame: u32,
  pub offset: u32,
  pub length: u32,
}

#[derive(Default)]
struct OpenFrame {
  bytes: Vec<u8>,
  records: Vec<([u8; 32], Type, Form, u32, u32)>,
}

/// Writes one container under a temporary name, then renames it to its
/// trailer when finished.
pub struct ContainerWriter {
  directory: PathBuf,
  temporary: PathBuf,
  file: BufWriter<File>,
  hasher: Sha256,
  written: u64,
  frames: Vec<Frame>,
  records: BTreeMap<[u8; 32], Record>,
  /// Each annotation's subject digest and its own (§4.1's table).
  annotations: Vec<([u8; 32], [u8; 32])>,
  open: [OpenFrame; 2],
}

fn io(path: &Path, error: std::io::Error) -> StoreError {
  StoreError::io(path, error)
}

impl ContainerWriter {
  pub fn create(directory: &Path) -> Result<ContainerWriter, StoreError> {
    let temporary = directory.join("writing.tmp");
    let file = File::create(&temporary).map_err(|error| io(&temporary, error))?;
    let mut writer = ContainerWriter {
      directory: directory.to_path_buf(),
      temporary,
      file: BufWriter::new(file),
      hasher: Sha256::new(),
      written: 0,
      frames: Vec::new(),
      records: BTreeMap::new(),
      annotations: Vec::new(),
      open: [OpenFrame::default(), OpenFrame::default()],
    };
    let mut header = CONTAINER_MAGIC.to_vec();
    header.extend_from_slice(&[0x00, 0x01, 0, 0, 0, 0, 0, 0]);
    writer.write(&header)?;
    Ok(writer)
  }

  pub fn is_empty(&self) -> bool {
    self.records.is_empty() && self.open.iter().all(|open| open.records.is_empty())
  }

  fn write(&mut self, bytes: &[u8]) -> Result<(), StoreError> {
    self
      .file
      .write_all(bytes)
      .map_err(|error| io(&self.temporary, error))?;
    self.hasher.update(bytes);
    self.written += bytes.len() as u64;
    Ok(())
  }

  /// Adds a present record. The caller adds each object once.
  pub fn add(
    &mut self,
    id: &NativeId,
    kind: Type,
    form: Form,
    record: &[u8],
  ) -> Result<(), StoreError> {
    if u32::try_from(record.len()).is_err() {
      return Err(StoreError::TooLarge(format!(
        "{id} would be a record of {} bytes, and a record is at most 4 GiB",
        record.len()
      )));
    }
    if kind == Type::Annotation {
      let subject = crate::objects::Annotation::decode(record)
        .map_err(|what| StoreError::Codec(format!("{id}: {what}")))?
        .subject;
      self.annotations.push((subject.0, id.0));
    }
    let class = class_of(kind) as usize;
    if self.open[class].bytes.len() + record.len() > FRAME_LIMIT {
      self.close(class)?;
    }
    let open = &mut self.open[class];
    open.records.push((
      id.0,
      kind,
      form,
      open.bytes.len() as u32,
      record.len() as u32,
    ));
    open.bytes.extend_from_slice(record);
    if record.len() > FRAME_LIMIT {
      self.close(class)?;
    }
    Ok(())
  }

  /// Records an object as absent by promise or by policy (objects.md §8):
  /// an index entry with its state and no location. Only content may be
  /// absent; a reader refuses any other.
  pub fn add_absent(&mut self, id: &NativeId, kind: Type, state: u8) {
    self.records.insert(
      id.0,
      Record {
        kind,
        form: Form::Body,
        state,
        frame: NO_FRAME,
        offset: 0,
        length: 0,
      },
    );
  }

  fn close(&mut self, class: usize) -> Result<(), StoreError> {
    let open = std::mem::take(&mut self.open[class]);
    if open.records.is_empty() {
      return Ok(());
    }
    let compressed = compress(&open.bytes)?;
    if self.written - HEADER + compressed.len() as u64 > CONTAINER_LIMIT {
      return Err(StoreError::TooLarge(
        "the store would pass one container of 1 GiB, and this build writes one container".into(),
      ));
    }
    let frame = self.frames.len() as u32;
    self.frames.push(Frame {
      offset: self.written,
      compressed: compressed.len() as u64,
      uncompressed: open.bytes.len() as u32,
      codec: ZSTD,
      class: class as u8,
    });
    self.write(&compressed)?;
    for (digest, kind, form, offset, length) in open.records {
      self.records.insert(
        digest,
        Record {
          kind,
          form,
          state: PRESENT,
          frame,
          offset,
          length,
        },
      );
    }
    Ok(())
  }

  /// Closes the open frames, writes the index and footer, and names the
  /// container by its trailer.
  pub fn finish(mut self) -> Result<PathBuf, StoreError> {
    self.close(METADATA as usize)?;
    self.close(CONTENT as usize)?;
    let index = self.index();
    let index_offset = self.written;
    self.write(&index)?;
    self.write(&index_offset.to_be_bytes())?;
    self.write(&sha256::digest(&index))?;
    let trailer = std::mem::take(&mut self.hasher).finish();
    self
      .file
      .write_all(&trailer)
      .map_err(|error| io(&self.temporary, error))?;
    let file = self
      .file
      .into_inner()
      .map_err(|error| io(&self.temporary, error.into_error()))?;
    file
      .sync_all()
      .map_err(|error| io(&self.temporary, error))?;
    drop(file);
    let name = self.directory.join(format!("{}.cstc", hex(&trailer)));
    std::fs::rename(&self.temporary, &name).map_err(|error| io(&name, error))?;
    Ok(name)
  }

  fn index(&self) -> Vec<u8> {
    let mut out = INDEX_MAGIC.to_vec();
    let counts = [
      self.frames.len() as u32,
      self.records.len() as u32,
      self.annotations.len() as u32,
      0,
    ];
    for count in counts {
      out.extend_from_slice(&count.to_be_bytes());
    }
    for frame in &self.frames {
      out.extend_from_slice(&frame.offset.to_be_bytes());
      out.extend_from_slice(&frame.compressed.to_be_bytes());
      out.extend_from_slice(&frame.uncompressed.to_be_bytes());
      out.extend_from_slice(&[frame.codec, frame.class, 0, 0]);
    }
    for count in fanout(self.records.keys()) {
      out.extend_from_slice(&count.to_be_bytes());
    }
    for digest in self.records.keys() {
      out.extend_from_slice(digest);
    }
    for record in self.records.values() {
      out.extend_from_slice(&[record.kind.code(), record.form as u8, record.state, 0]);
      for value in [record.frame, record.offset, record.length] {
        out.extend_from_slice(&value.to_be_bytes());
      }
    }
    let names: Vec<&[u8; 32]> = self.records.keys().collect();
    let mut table: Vec<([u8; 32], u32)> = self
      .annotations
      .iter()
      .map(|(subject, id)| {
        let position = names.binary_search(&id).expect("an annotation's own record") as u32;
        (*subject, position)
      })
      .collect();
    table.sort();
    table.dedup();
    for (subject, position) in table {
      out.extend_from_slice(&subject);
      out.extend_from_slice(&position.to_be_bytes());
    }
    out
  }
}

fn fanout<'a>(names: impl Iterator<Item = &'a [u8; 32]>) -> [u32; 256] {
  let mut counts = [0u32; 256];
  for name in names {
    counts[name[0] as usize] += 1;
  }
  let mut total = 0;
  for count in counts.iter_mut() {
    total += *count;
    *count = total;
  }
  counts
}

fn compress(bytes: &[u8]) -> Result<Vec<u8>, StoreError> {
  use zstd::zstd_safe::CParameter;
  let failed =
    |error: std::io::Error| StoreError::Codec(format!("zstd could not compress a frame: {error}"));
  let mut compressor = zstd::bulk::Compressor::new(LEVEL).map_err(failed)?;
  compressor
    .set_parameter(CParameter::ChecksumFlag(false))
    .map_err(failed)?;
  compressor
    .set_parameter(CParameter::ContentSizeFlag(true))
    .map_err(failed)?;
  compressor.compress(bytes).map_err(failed)
}

/// A container's index, read and checked; frames are read on demand.
pub struct Container {
  pub path: PathBuf,
  pub frames: Vec<Frame>,
  pub names: Vec<[u8; 32]>,
  pub records: Vec<Record>,
  /// The annotation table: each annotation's subject digest and its position
  /// in the names, in order.
  pub annotations: Vec<([u8; 32], u32)>,
}

impl Container {
  pub fn open(path: &Path) -> Result<Container, StoreError> {
    let corrupt = |what: String| StoreError::Corrupt(format!("{}: {what}", path.display()));
    let mut file = File::open(path).map_err(|error| io(path, error))?;
    let length = file.metadata().map_err(|error| io(path, error))?.len();
    if length < HEADER + FOOTER {
      return Err(corrupt("it is too short to be a container".into()));
    }
    let mut header = [0u8; 16];
    file
      .read_exact(&mut header)
      .map_err(|error| io(path, error))?;
    if &header[..8] != CONTAINER_MAGIC || header[8..] != [0x00, 0x01, 0, 0, 0, 0, 0, 0] {
      return Err(corrupt("its header is not version 0's".into()));
    }
    let mut footer = [0u8; 72];
    file
      .seek(SeekFrom::Start(length - FOOTER))
      .map_err(|error| io(path, error))?;
    file
      .read_exact(&mut footer)
      .map_err(|error| io(path, error))?;
    let index_offset = u64::from_be_bytes(footer[..8].try_into().expect("8 bytes"));
    if index_offset < HEADER || index_offset > length - FOOTER {
      return Err(corrupt(
        "its footer places the index outside the file".into(),
      ));
    }
    let index_length = usize::try_from(length - FOOTER - index_offset)
      .map_err(|_| corrupt("its index is too large".into()))?;
    let mut index = vec![0u8; index_length];
    file
      .seek(SeekFrom::Start(index_offset))
      .map_err(|error| io(path, error))?;
    file
      .read_exact(&mut index)
      .map_err(|error| io(path, error))?;
    if sha256::digest(&index) != footer[8..40] {
      return Err(corrupt(
        "its index does not match the index's SHA-256".into(),
      ));
    }
    // The trailer is read from the footer, not computed: verifying it means
    // reading the whole container, which only a full check does.
    let named = path
      .file_stem()
      .map(|stem| stem.to_string_lossy().into_owned());
    if named.as_deref() != Some(hex(&footer[40..]).as_str()) {
      return Err(corrupt("it is not named by its trailer".into()));
    }
    let container = parse_index(path, &index, index_offset).map_err(corrupt)?;
    Ok(container)
  }

  pub fn find(&self, id: &NativeId) -> Option<&Record> {
    self
      .names
      .binary_search(&id.0)
      .ok()
      .map(|at| &self.records[at])
  }

  /// A frame's uncompressed bytes.
  pub fn frame(&self, number: u32) -> Result<Vec<u8>, StoreError> {
    let corrupt = |what: String| {
      StoreError::Corrupt(format!("{}: frame {number}: {what}", self.path.display()))
    };
    let frame = &self.frames[number as usize];
    let mut file = File::open(&self.path).map_err(|error| io(&self.path, error))?;
    file
      .seek(SeekFrom::Start(frame.offset))
      .map_err(|error| io(&self.path, error))?;
    let length =
      usize::try_from(frame.compressed).map_err(|_| corrupt("it is too large to read".into()))?;
    let mut bytes = vec![0u8; length];
    file
      .read_exact(&mut bytes)
      .map_err(|error| io(&self.path, error))?;
    if frame.codec == STORED {
      return Ok(bytes);
    }
    match zstd::zstd_safe::find_frame_compressed_size(&bytes) {
      Ok(size) if size == bytes.len() => {}
      _ => return Err(corrupt("its bytes are not exactly one zstd frame".into())),
    }
    let mut decompressor = zstd::bulk::Decompressor::new()
      .map_err(|error| StoreError::Codec(format!("zstd could not start: {error}")))?;
    let out = decompressor
      .decompress(&bytes, frame.uncompressed as usize)
      .map_err(|error| corrupt(format!("zstd could not decompress it: {error}")))?;
    if out.len() != frame.uncompressed as usize {
      return Err(corrupt(
        "it decompresses to a length other than its index's".into(),
      ));
    }
    Ok(out)
  }
}

fn parse_index(path: &Path, index: &[u8], index_offset: u64) -> Result<Container, String> {
  let mut reader = crate::encoding::Reader::new(index);
  if reader.take(8)? != INDEX_MAGIC {
    return Err("its index does not begin with the index's magic".into());
  }
  let frames_count = reader.u32()? as usize;
  let objects = reader.u32()? as usize;
  let annotations = reader.u32()? as usize;
  if reader.u32()? != 0 {
    return Err("its index's reserved count is not 0".into());
  }
  let expected = 1048u64 + 24 * frames_count as u64 + 48 * objects as u64 + 36 * annotations as u64;
  if index.len() as u64 != expected {
    return Err("its index's size does not match its counts".into());
  }
  let mut frames = Vec::with_capacity(frames_count);
  let mut next = HEADER;
  for number in 0..frames_count {
    let frame = Frame {
      offset: reader.u64()?,
      compressed: reader.u64()?,
      uncompressed: reader.u32()?,
      codec: reader.u8()?,
      class: reader.u8()?,
    };
    if reader.take(2)? != [0, 0] {
      return Err(format!("frame {number}'s reserved bytes are not 0"));
    }
    if frame.offset != next {
      return Err(format!(
        "frame {number} leaves a gap or overlaps the one before"
      ));
    }
    next = frame
      .offset
      .checked_add(frame.compressed)
      .ok_or("a frame's length overflows")?;
    if frame.class > CONTENT || frame.codec > ZSTD {
      return Err(format!("frame {number} has a reserved class or codec"));
    }
    if frame.codec == STORED && frame.compressed != u64::from(frame.uncompressed) {
      return Err(format!(
        "frame {number} is stored, but its two lengths differ"
      ));
    }
    frames.push(frame);
  }
  if next != index_offset {
    return Err("its frames do not end where its index begins".into());
  }
  let mut fanout_counts = [0u32; 256];
  for slot in fanout_counts.iter_mut() {
    *slot = reader.u32()?;
  }
  let mut names = Vec::with_capacity(objects);
  for _ in 0..objects {
    names.push(<[u8; 32]>::try_from(reader.take(32)?).expect("32 bytes"));
  }
  if names.windows(2).any(|pair| pair[0] >= pair[1]) {
    return Err("its names are not in byte order, or repeat one".into());
  }
  if fanout_counts != fanout(names.iter()) {
    return Err("its fan-out does not count its names".into());
  }
  let mut records = Vec::with_capacity(objects);
  for name in &names {
    let id = hex(name);
    let code = reader.u8()?;
    let kind = Type::from_code(code)
      .ok_or_else(|| format!("{id} has the type {code:02x}, which this build does not know"))?;
    let form =
      Form::from_code(reader.u8()?).ok_or_else(|| format!("{id} has a reserved stored form"))?;
    let state = reader.u8()?;
    if reader.u8()? != 0 {
      return Err(format!("{id}'s reserved byte is not 0"));
    }
    let record = Record {
      kind,
      form,
      state,
      frame: reader.u32()?,
      offset: reader.u32()?,
      length: reader.u32()?,
    };
    if state > ABSENT_BY_POLICY {
      return Err(format!("{id} has a reserved state"));
    }
    if form != Form::Body && kind != Type::Content {
      return Err(format!(
        "{id} is metadata stored in a form only content takes"
      ));
    }
    if state == PRESENT {
      let frame = frames
        .get(record.frame as usize)
        .ok_or_else(|| format!("{id} names a frame the container does not have"))?;
      if u64::from(record.offset) + u64::from(record.length) > u64::from(frame.uncompressed) {
        return Err(format!("{id} lies outside its frame"));
      }
      if frame.class != class_of(kind) {
        return Err(format!("{id} is in a frame of the wrong class"));
      }
    } else {
      if kind != Type::Content {
        return Err(format!("{id} is metadata, and metadata is never absent"));
      }
      if form != Form::Body || record.frame != NO_FRAME || record.offset != 0 || record.length != 0
      {
        return Err(format!("{id} is absent but has a location"));
      }
    }
    records.push(record);
  }
  let mut previous: Option<([u8; 32], u32)> = None;
  let mut listed = std::collections::HashSet::new();
  let mut table = Vec::with_capacity(annotations);
  for _ in 0..annotations {
    let subject = <[u8; 32]>::try_from(reader.take(32)?).expect("32 bytes");
    let position = reader.u32()?;
    if records
      .get(position as usize)
      .is_none_or(|record| record.kind != Type::Annotation)
    {
      return Err("its annotation table names an object that is not an annotation".into());
    }
    if previous.is_some_and(|before| before >= (subject, position)) {
      return Err("its annotation table is not in order".into());
    }
    if !listed.insert(position) {
      return Err("its annotation table lists an annotation twice".into());
    }
    previous = Some((subject, position));
    table.push((subject, position));
  }
  if records
    .iter()
    .filter(|record| record.kind == Type::Annotation)
    .count()
    != annotations
  {
    return Err("its annotation table does not list every annotation".into());
  }
  Ok(Container {
    path: path.to_path_buf(),
    frames,
    names,
    records,
    annotations: table,
  })
}
