//! Frames and containers (storage.md §3–§4): records grouped into zstd frames
//! of at most 4 MiB, one class per frame, and each delta in a stored frame of
//! its own, written back to back into a container that ends with its index
//! and footer. A container is read two ways (§4.1): for lookups, touching only
//! the entries each lookup needs, and whole, with every check, for `cst fsck`,
//! the reconstruction check and import.

use crate::StoreError;
use crate::id::{NativeId, Short, Type, hex};
use crate::positioned::Positioned;
use causet_model::sha256::{self, Sha256};
use std::collections::BTreeMap;
use std::fs::File;
use std::io::{BufWriter, Write};
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
/// The name a container is written under until it is named by its trailer.
pub(crate) const TEMPORARY: &str = "writing.tmp";

/// A record's stored form (§1).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Form {
  Body = 0,
  ChunkList = 1,
  Delta = 2,
  ShortReferences = 3,
}

impl Form {
  fn from_code(code: u8) -> Option<Form> {
    match code {
      0 => Some(Form::Body),
      1 => Some(Form::ChunkList),
      2 => Some(Form::Delta),
      3 => Some(Form::ShortReferences),
      _ => None,
    }
  }

  /// Whether an object of `kind` may take this form (§1): a chunk list and a
  /// delta only content, short references only a tree.
  fn fits(self, kind: Type) -> bool {
    match self {
      Form::Body => true,
      Form::ChunkList | Form::Delta => kind == Type::Content,
      Form::ShortReferences => kind == Type::Tree,
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
    let temporary = directory.join(TEMPORARY);
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
    header.extend_from_slice(&[crate::VERSION, 0x01, 0, 0, 0, 0, 0, 0]);
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

  /// Adds a delta (storage.md §5) as a stored frame of its own, written at
  /// once. The open frame of its class stays open, so content records after
  /// the delta can join it.
  pub fn add_stored(&mut self, id: &NativeId, kind: Type, form: Form, record: &[u8]) -> Result<(), StoreError> {
    let length = u32::try_from(record.len()).map_err(|_| {
      StoreError::TooLarge(format!(
        "{id} would be a record of {} bytes, and a record is at most 4 GiB",
        record.len()
      ))
    })?;
    self.put_frame(
      record,
      length,
      STORED,
      class_of(kind),
      vec![(id.0, kind, form, 0, length)],
    )
  }

  fn close(&mut self, class: usize) -> Result<(), StoreError> {
    let open = std::mem::take(&mut self.open[class]);
    if open.records.is_empty() {
      return Ok(());
    }
    let compressed = compress(&open.bytes)?;
    self.put_frame(
      &compressed,
      open.bytes.len() as u32,
      ZSTD,
      class as u8,
      open.records,
    )
  }

  /// Writes a frame's bytes and enters its records in the index.
  fn put_frame(
    &mut self,
    bytes: &[u8],
    uncompressed: u32,
    codec: u8,
    class: u8,
    records: Vec<([u8; 32], Type, Form, u32, u32)>,
  ) -> Result<(), StoreError> {
    if self.written - HEADER + bytes.len() as u64 > CONTAINER_LIMIT {
      return Err(StoreError::TooLarge(
        "the store would pass one container of 1 GiB, and this build writes one container".into(),
      ));
    }
    let frame = self.frames.len() as u32;
    self.frames.push(Frame {
      offset: self.written,
      compressed: bytes.len() as u64,
      uncompressed,
      codec,
      class,
    });
    self.write(bytes)?;
    for (digest, kind, form, offset, length) in records {
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

  /// Removes the container being written, which no reader sees (§4).
  pub fn abandon(self) {
    let temporary = self.temporary.clone();
    drop(self);
    let _ = std::fs::remove_file(temporary);
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

/// One zstd frame of `bytes`, with §3's parameters.
pub(crate) fn compress(bytes: &[u8]) -> Result<Vec<u8>, StoreError> {
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

/// Where the index's parts begin, from its offset and its counts (§4.1).
#[derive(Clone, Copy, Debug)]
struct Layout {
  index: u64,
  frames: u32,
  objects: u32,
}

impl Layout {
  fn frame_table(&self) -> u64 {
    self.index + 24
  }

  fn fanout(&self) -> u64 {
    self.frame_table() + 24 * u64::from(self.frames)
  }

  fn names(&self) -> u64 {
    self.fanout() + 1024
  }

  fn records(&self) -> u64 {
    self.names() + 32 * u64::from(self.objects)
  }
}

/// A container's header and footer, checked, and its index's counts: what
/// every reader checks before it reads the index (§4.1), from the header,
/// the footer and the index's first 24 bytes. The trailer is taken from the
/// footer, not computed: verifying it means reading the whole container,
/// which only a full check does. Also gives the index's SHA-256, unchecked.
fn open_file(file: &Positioned) -> Result<(Layout, [u8; 32]), StoreError> {
  let corrupt = |what: &str| StoreError::Corrupt(format!("{}: {what}", file.path.display()));
  let length = file.length;
  if length < HEADER + FOOTER {
    return Err(corrupt("it is too short to be a container"));
  }
  let header = file.read(0, 16)?;
  if &header[..8] != CONTAINER_MAGIC || header[8..] != [crate::VERSION, 0x01, 0, 0, 0, 0, 0, 0] {
    return Err(corrupt(&format!("its header is not version {}'s", crate::VERSION)));
  }
  let footer = file.read(length - FOOTER, FOOTER as usize)?;
  let index = u64::from_be_bytes(footer[..8].try_into().expect("8 bytes"));
  if index < HEADER || index > length - FOOTER {
    return Err(corrupt("its footer places the index outside the file"));
  }
  let named = file.path.file_stem().map(|stem| stem.to_string_lossy().into_owned());
  if named.as_deref() != Some(hex(&footer[40..]).as_str()) {
    return Err(corrupt("it is not named by its trailer"));
  }
  let index_length = length - FOOTER - index;
  if index_length < 24 {
    return Err(corrupt("its index's size does not match its counts"));
  }
  let head = file.read(index, 24)?;
  if head[..8] != INDEX_MAGIC[..] {
    return Err(corrupt("its index does not begin with the index's magic"));
  }
  let count = |at: usize| u32::from_be_bytes(head[at..at + 4].try_into().expect("4 bytes"));
  let (frames, objects, annotations) = (count(8), count(12), count(16));
  if count(20) != 0 {
    return Err(corrupt("its index's reserved count is not 0"));
  }
  let expected =
    1048u64 + 24 * u64::from(frames) + 48 * u64::from(objects) + 36 * u64::from(annotations);
  if index_length != expected {
    return Err(corrupt("its index's size does not match its counts"));
  }
  let digest: [u8; 32] = footer[8..40].try_into().expect("32 bytes");
  Ok((Layout { index, frames, objects }, digest))
}

/// A frame table entry, with the checks that need no other entry: its
/// reserved bytes, its class and codec, and for a stored frame its two
/// lengths. The order of the frames is the full check's.
fn frame_entry(number: u32, bytes: &[u8]) -> Result<Frame, String> {
  let mut reader = crate::encoding::Reader::new(bytes);
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
  if frame.class > CONTENT || frame.codec > ZSTD {
    return Err(format!("frame {number} has a reserved class or codec"));
  }
  if frame.codec == STORED && frame.compressed != u64::from(frame.uncompressed) {
    return Err(format!("frame {number} is stored, but its two lengths differ"));
  }
  Ok(frame)
}

/// A record, with the checks that need only its 16 bytes (§4.1; objects.md
/// §8): a known type, a form and state its type takes, a reserved byte of 0,
/// and an absent object with no location. Where a present one lies is
/// [`check_location`]'s.
fn parse_record(name: &[u8; 32], bytes: &[u8]) -> Result<Record, String> {
  let id = hex(name);
  let mut reader = crate::encoding::Reader::new(bytes);
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
  if !form.fits(kind) {
    return Err(format!("{id} is stored in a form its type does not take"));
  }
  if state != PRESENT {
    if kind != Type::Content {
      return Err(format!("{id} is metadata, and metadata is never absent"));
    }
    if form != Form::Body || record.frame != NO_FRAME || record.offset != 0 || record.length != 0 {
      return Err(format!("{id} is absent but has a location"));
    }
  }
  Ok(record)
}

/// A present record against its frame's entry, `None` when the container
/// has no such frame: it must lie within the frame, which must be of its
/// class.
fn check_location(name: &[u8; 32], record: &Record, frame: Option<&Frame>) -> Result<(), String> {
  let id = hex(name);
  let frame = frame.ok_or_else(|| format!("{id} names a frame the container does not have"))?;
  if u64::from(record.offset) + u64::from(record.length) > u64::from(frame.uncompressed) {
    return Err(format!("{id} lies outside its frame"));
  }
  if frame.class != class_of(record.kind) {
    return Err(format!("{id} is in a frame of the wrong class"));
  }
  Ok(())
}

/// Whether a fan-out read by a lookup holds: it never decreases, and its
/// last entry is the count it counts.
pub(crate) fn fanout_holds(fanout: &[u32; 256], count: u32) -> bool {
  fanout.windows(2).all(|pair| pair[0] <= pair[1]) && fanout[255] == count
}

/// A fan-out of 256 `u32`s, read from `offset`.
pub(crate) fn read_fanout(file: &Positioned, offset: u64) -> Result<[u32; 256], StoreError> {
  let bytes = file.read(offset, 1024)?;
  let mut fanout = [0u32; 256];
  for (slot, value) in fanout.iter_mut().zip(bytes.chunks_exact(4)) {
    *slot = u32::from_be_bytes(value.try_into().expect("4 bytes"));
  }
  Ok(fanout)
}

/// The positions a fan-out gives the keys whose first byte is `first`.
pub(crate) fn bucket(fanout: &[u32; 256], first: u8) -> (u32, u32) {
  let start = if first == 0 { 0 } else { fanout[first as usize - 1] };
  (start, fanout[first as usize])
}

/// The first position in `[start, end)` for which `below` is false, by
/// binary search: the positions are sorted, and `below` reads the key at one.
pub(crate) fn partition(
  (mut start, mut end): (u32, u32),
  mut below: impl FnMut(u32) -> Result<bool, StoreError>,
) -> Result<u32, StoreError> {
  while start < end {
    let middle = start + (end - start) / 2;
    if below(middle)? {
      start = middle + 1;
    } else {
      end = middle;
    }
  }
  Ok(start)
}

/// A frame's uncompressed bytes, from its compressed ones. `corrupt` names
/// the frame.
fn decode_frame(
  frame: &Frame,
  bytes: Vec<u8>,
  corrupt: impl Fn(String) -> StoreError,
) -> Result<Vec<u8>, StoreError> {
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
    return Err(corrupt("it decompresses to a length other than its index's".into()));
  }
  Ok(out)
}

/// A container read for lookups (§4.1). Its header, footer, index counts and
/// fan-out are checked when it opens. A lookup reads, by position, only the
/// names it probes and scans, the record it finds and that record's frame
/// entry, and checks each. What no lookup touches whole, the index's SHA-256,
/// the order of all the names and of the frames, and the annotation table,
/// is checked by [`Index::read`]: `cst fsck`, the reconstruction check and
/// import read every index so, and the store reads them so before it reports
/// a miss (#389). A damaged part a lookup does not check can misdirect it:
/// the object it reads then fails its ID, or the object is missed, which the
/// store's whole-index check then finds.
pub struct Container {
  pub path: PathBuf,
  file: Positioned,
  layout: Layout,
  fanout: [u32; 256],
}

impl Container {
  /// A container, with the checks of constant cost (§4.1).
  pub fn open(path: &Path) -> Result<Container, StoreError> {
    let file = Positioned::open(path)?;
    let (layout, _) = open_file(&file)?;
    let fanout = read_fanout(&file, layout.fanout())?;
    if !fanout_holds(&fanout, layout.objects) {
      return Err(StoreError::Corrupt(format!(
        "{}: its fan-out does not count its names",
        path.display()
      )));
    }
    Ok(Container {
      path: path.to_path_buf(),
      file,
      layout,
      fanout,
    })
  }

  fn corrupt(&self, what: String) -> StoreError {
    StoreError::Corrupt(format!("{}: {what}", self.path.display()))
  }

  /// The bytes this container has read from its file.
  pub fn bytes_read(&self) -> u64 {
    self.file.bytes_read()
  }

  /// The name at a position. When `first` is given, the position is in that
  /// byte's fan-out bucket, so the name must begin with it.
  fn name(&self, position: u32, first: Option<u8>) -> Result<[u8; 32], StoreError> {
    let name: [u8; 32] = self
      .file
      .read(self.layout.names() + 32 * u64::from(position), 32)?
      .try_into()
      .expect("32 bytes");
    if first.is_some_and(|first| name[0] != first) {
      return Err(self.corrupt(format!("its name {position} is outside its fan-out bucket")));
    }
    Ok(name)
  }

  /// The names from `at` on, while `keep` holds and before `end`, each
  /// greater than the one before, as the order of the names requires.
  fn scan(
    &self,
    mut at: u32,
    end: u32,
    first: Option<u8>,
    keep: impl Fn(&[u8; 32]) -> bool,
  ) -> Result<Vec<(u32, [u8; 32])>, StoreError> {
    let mut found: Vec<(u32, [u8; 32])> = Vec::new();
    while at < end {
      let name = self.name(at, first)?;
      if !keep(&name) {
        break;
      }
      if found.last().is_some_and(|(_, before)| *before >= name) {
        return Err(self.corrupt(format!("its name {at} is not in byte order")));
      }
      found.push((at, name));
      at += 1;
    }
    Ok(found)
  }

  /// The record at a position, checked against its frame's entry.
  fn record_at(&self, position: u32, name: &[u8; 32]) -> Result<Record, StoreError> {
    let bytes = self.file.read(self.layout.records() + 16 * u64::from(position), 16)?;
    let record = parse_record(name, &bytes).map_err(|what| self.corrupt(what))?;
    if record.state == PRESENT {
      let frame = self.frame_entry(record.frame)?;
      check_location(name, &record, frame.as_ref()).map_err(|what| self.corrupt(what))?;
    }
    Ok(record)
  }

  /// A frame's entry, checked, or `None` when the container has no such
  /// frame. Its bytes must lie between the header and the index.
  fn frame_entry(&self, number: u32) -> Result<Option<Frame>, StoreError> {
    if number >= self.layout.frames {
      return Ok(None);
    }
    let bytes = self.file.read(self.layout.frame_table() + 24 * u64::from(number), 24)?;
    let frame = frame_entry(number, &bytes).map_err(|what| self.corrupt(what))?;
    if frame.offset < HEADER
      || frame
        .offset
        .checked_add(frame.compressed)
        .is_none_or(|end| end > self.layout.index)
    {
      return Err(self.corrupt(format!("frame {number} lies outside the container's frames")));
    }
    Ok(Some(frame))
  }

  /// An object's record, checked, when the container lists it: a binary
  /// search of its fan-out bucket.
  pub fn find(&self, id: &NativeId) -> Result<Option<Record>, StoreError> {
    let first = id.0[0];
    let bucket = bucket(&self.fanout, first);
    let at = partition(bucket, |at| Ok(self.name(at, Some(first))? < id.0))?;
    if at == bucket.1 || self.name(at, Some(first))? != id.0 {
      return Ok(None);
    }
    self.record_at(at, &id.0).map(Some)
  }

  /// The names that begin with a short reference (objects.md §1.3), found
  /// by binary search of its fan-out bucket.
  pub fn starting(&self, short: &Short) -> Result<Vec<[u8; 32]>, StoreError> {
    let first = short[0];
    let bucket = bucket(&self.fanout, first);
    let at = partition(bucket, |at| Ok(self.name(at, Some(first))?[..8] < short[..]))?;
    let found = self.scan(at, bucket.1, Some(first), |name| name[..8] == short[..])?;
    Ok(found.into_iter().map(|(_, name)| name).collect())
  }

  /// A frame's uncompressed bytes.
  pub fn frame(&self, number: u32) -> Result<Vec<u8>, StoreError> {
    let frame = self
      .frame_entry(number)?
      .ok_or_else(|| self.corrupt(format!("it has no frame {number}")))?;
    let corrupt = |what: String| self.corrupt(format!("frame {number}: {what}"));
    let length =
      usize::try_from(frame.compressed).map_err(|_| corrupt("it is too large to read".into()))?;
    let bytes = self.file.read(frame.offset, length)?;
    decode_frame(&frame, bytes, corrupt)
  }
}

/// A container's whole index, read and checked: the index's SHA-256, every
/// frame entry, name and record, their orders, and the annotation table
/// (§4.1). `cst fsck`, the reconstruction check and import read it; frames
/// are read on demand.
pub struct Index {
  pub path: PathBuf,
  pub frames: Vec<Frame>,
  /// Each present record's position in `names`, by its frame and offset:
  /// built the first time `placed` is asked.
  places: std::cell::OnceCell<std::collections::HashMap<(u32, u32), usize>>,
  pub names: Vec<[u8; 32]>,
  pub records: Vec<Record>,
  /// The annotation table: each annotation's subject digest and its position
  /// in the names, in order.
  pub annotations: Vec<([u8; 32], u32)>,
  file: Positioned,
}

impl Index {
  /// The index of the container at `path`, with every check (§4.1).
  pub fn read(path: &Path) -> Result<Index, StoreError> {
    let corrupt = |what: String| StoreError::Corrupt(format!("{}: {what}", path.display()));
    let file = Positioned::open(path)?;
    let (layout, digest) = open_file(&file)?;
    let length = usize::try_from(file.length - FOOTER - layout.index)
      .map_err(|_| corrupt("its index is too large".into()))?;
    let index = file.read(layout.index, length)?;
    if sha256::digest(&index) != digest {
      return Err(corrupt("its index does not match the index's SHA-256".into()));
    }
    parse_index(file, &index, layout.index).map_err(corrupt)
  }

  /// The bytes this index has read from its file.
  pub fn bytes_read(&self) -> u64 {
    self.file.bytes_read()
  }

  /// The object present at an offset of a frame, with its record.
  pub fn placed(&self, frame: u32, offset: u32) -> Option<(NativeId, &Record)> {
    let places = self.places.get_or_init(|| {
      self
        .records
        .iter()
        .enumerate()
        .filter(|(_, record)| record.state == PRESENT)
        .map(|(at, record)| ((record.frame, record.offset), at))
        .collect()
    });
    places
      .get(&(frame, offset))
      .map(|&at| (NativeId(self.names[at]), &self.records[at]))
  }

  /// An object's record, when the index lists it.
  pub fn find(&self, id: &NativeId) -> Option<&Record> {
    self.names.binary_search(&id.0).ok().map(|at| &self.records[at])
  }

  /// The names that begin with a short reference (objects.md §1.3).
  pub fn starting(&self, short: &Short) -> &[[u8; 32]] {
    let start = self.names.partition_point(|name| name[..8] < short[..]);
    let end = start + self.names[start..].partition_point(|name| name[..8] == short[..]);
    &self.names[start..end]
  }

  /// The names whose text form begins with `prefix`, in lowercase hex, each
  /// with its type.
  pub fn prefixed(&self, prefix: &str) -> Vec<(NativeId, Type)> {
    let mut low = [0u8; 32];
    for (at, digit) in prefix.bytes().take(64).enumerate() {
      let value = (digit as char).to_digit(16).unwrap_or(0) as u8;
      low[at / 2] |= if at % 2 == 0 { value << 4 } else { value };
    }
    let start = self.names.partition_point(|name| *name < low);
    self.names[start..]
      .iter()
      .zip(&self.records[start..])
      .map(|(name, record)| (NativeId(*name), record.kind))
      .take_while(|(id, _)| id.hex().starts_with(prefix))
      .collect()
  }

  /// A frame's uncompressed bytes.
  pub fn frame(&self, number: u32) -> Result<Vec<u8>, StoreError> {
    let corrupt = |what: String| {
      StoreError::Corrupt(format!("{}: frame {number}: {what}", self.path.display()))
    };
    let frame = &self.frames[number as usize];
    let length =
      usize::try_from(frame.compressed).map_err(|_| corrupt("it is too large to read".into()))?;
    let bytes = self.file.read(frame.offset, length)?;
    decode_frame(frame, bytes, corrupt)
  }
}

/// The index whose counts and size `open_file` checked.
fn parse_index(file: Positioned, index: &[u8], index_offset: u64) -> Result<Index, String> {
  let mut reader = crate::encoding::Reader::new(index);
  reader.take(8)?;
  let frames_count = reader.u32()?;
  let objects = reader.u32()? as usize;
  let annotations = reader.u32()? as usize;
  reader.u32()?;
  let mut frames = Vec::with_capacity(frames_count as usize);
  let mut next = HEADER;
  for number in 0..frames_count {
    let frame = frame_entry(number, reader.take(24)?)?;
    if frame.offset != next {
      return Err(format!(
        "frame {number} leaves a gap or overlaps the one before"
      ));
    }
    next = frame
      .offset
      .checked_add(frame.compressed)
      .ok_or("a frame's length overflows")?;
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
    let record = parse_record(name, reader.take(16)?)?;
    if record.state == PRESENT {
      check_location(name, &record, frames.get(record.frame as usize))?;
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
  Ok(Index {
    path: file.path.clone(),
    frames,
    places: std::cell::OnceCell::new(),
    names,
    records,
    annotations: table,
    file,
  })
}
