//! The bodies of the N1 object types (objects.md §3–§7): chunk lists, native
//! trees and their Git encoding, preserved Git objects, ref snapshots (§6)
//! and annotations (§7), each with the rules a reader checks.

use crate::encoding::{Reader, put_bytes, put_varint};
use crate::id::{GitAlgorithm, GitId, NativeId, Short, Type, hex, unhex};
use std::cmp::Ordering;
use std::ops::Range;

/// The chunker code of cst's FastCDC (storage.md §2).
pub const CHUNKER_FASTCDC: u8 = 0x01;

/// A content object stored in pieces (objects.md §3.3): a stored form, kept
/// under the ID of the content it lists.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChunkList {
  pub size: u64,
  pub chunks: Vec<(NativeId, u64)>,
}

impl ChunkList {
  pub fn encode(&self) -> Vec<u8> {
    let mut out = vec![CHUNKER_FASTCDC];
    out.extend_from_slice(&0u64.to_be_bytes());
    put_varint(&mut out, self.size);
    put_varint(&mut out, self.chunks.len() as u64);
    for (id, length) in &self.chunks {
      id.put(&mut out);
      put_varint(&mut out, *length);
    }
    out
  }

  pub fn decode(record: &[u8]) -> Result<ChunkList, String> {
    let mut reader = Reader::new(record);
    let chunker = reader.u8()?;
    if chunker != CHUNKER_FASTCDC {
      return Err(format!(
        "a chunk list names the chunker {chunker:02x}, which version 1 does not write"
      ));
    }
    if reader.u64()? != 0 {
      return Err("a chunk list has a seed, which version 1 does not write".into());
    }
    let size = reader.varint()?;
    let count = reader.varint()?;
    if count < 2 {
      return Err("a chunk list has fewer than 2 chunks".into());
    }
    let mut chunks = Vec::new();
    let mut total: u64 = 0;
    for _ in 0..count {
      let id = NativeId::read(&mut reader)?;
      let length = reader.varint()?;
      if length == 0 || length >= size {
        return Err("a chunk list has a chunk of length 0, or no shorter than the content".into());
      }
      total = total
        .checked_add(length)
        .ok_or("a chunk list's lengths overflow")?;
      chunks.push((id, length));
    }
    if total != size {
      return Err(format!(
        "a chunk list's lengths add up to {total}, not its size {size}"
      ));
    }
    if !reader.is_empty() {
      return Err("a chunk list has bytes after its last chunk".into());
    }
    Ok(ChunkList { size, chunks })
  }
}

/// What a tree entry is (objects.md §4.1).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Kind {
  File = 1,
  Executable = 2,
  Symlink = 3,
  Tree = 4,
  Submodule = 5,
}

impl Kind {
  pub fn from_code(code: u8) -> Option<Kind> {
    Some(match code {
      1 => Kind::File,
      2 => Kind::Executable,
      3 => Kind::Symlink,
      4 => Kind::Tree,
      5 => Kind::Submodule,
      _ => return None,
    })
  }

  /// The Git mode, exactly as a canonical Git tree writes it.
  pub fn git_mode(self) -> &'static [u8] {
    match self {
      Kind::File => b"100644",
      Kind::Executable => b"100755",
      Kind::Symlink => b"120000",
      Kind::Tree => b"40000",
      Kind::Submodule => b"160000",
    }
  }

  pub fn from_git_mode(mode: &[u8]) -> Option<Kind> {
    [
      Kind::File,
      Kind::Executable,
      Kind::Symlink,
      Kind::Tree,
      Kind::Submodule,
    ]
    .into_iter()
    .find(|kind| kind.git_mode() == mode)
  }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Target {
  Native(NativeId),
  Git(GitId),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
  pub name: Vec<u8>,
  pub kind: Kind,
  pub target: Target,
}

/// A native tree, its entries in byte order of their names.
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct Tree {
  pub entries: Vec<Entry>,
}

/// Whether `name` may name a tree entry: not empty, no NUL or `/`, and
/// neither `.` nor `..`.
pub fn valid_name(name: &[u8]) -> bool {
  !name.is_empty()
    && name != b"."
    && name != b".."
    && !name.iter().any(|&byte| byte == 0 || byte == b'/')
}

/// Git's order of tree records: a tree compares as its name followed by `/`.
pub fn git_order(a: (&[u8], bool), b: (&[u8], bool)) -> Ordering {
  fn key<'a>((name, is_tree): (&'a [u8], bool)) -> impl Iterator<Item = u8> + 'a {
    name.iter().copied().chain(is_tree.then_some(b'/'))
  }
  key(a).cmp(key(b))
}

impl Tree {
  /// A tree of these entries in any order, sorted into native order. A name
  /// that is invalid or repeated, or a target that does not fit its kind,
  /// makes no tree.
  pub fn from_entries(mut entries: Vec<Entry>) -> Result<Tree, String> {
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    let tree = Tree { entries };
    tree.check()?;
    Ok(tree)
  }

  fn check(&self) -> Result<(), String> {
    for entry in &self.entries {
      if matches!(entry.target, Target::Git(_)) != (entry.kind == Kind::Submodule) {
        return Err("a tree entry's target does not fit its kind".into());
      }
    }
    check_entries(self.entries.iter().map(|entry| {
      let algorithm = match &entry.target {
        Target::Git(id) => Some(id.algorithm),
        Target::Native(_) => None,
      };
      (entry.name.as_slice(), algorithm)
    }))
  }

  pub fn encode(&self) -> Vec<u8> {
    self.encode_with(|id, out| id.put(out))
  }

  /// The short-reference record (objects.md §4.4): the body with each native
  /// target replaced by its short reference.
  pub fn encode_short(&self) -> Vec<u8> {
    self.encode_with(|id, out| out.extend_from_slice(&id.short()))
  }

  /// The entries, each native target written by `native`.
  fn encode_with(&self, native: impl Fn(&NativeId, &mut Vec<u8>)) -> Vec<u8> {
    let mut out = Vec::new();
    put_varint(&mut out, self.entries.len() as u64);
    for entry in &self.entries {
      put_bytes(&mut out, &entry.name);
      out.push(entry.kind as u8);
      match &entry.target {
        Target::Native(id) => native(id, &mut out),
        Target::Git(id) => id.put(&mut out),
      }
    }
    out
  }

  pub fn decode(body: &[u8]) -> Result<Tree, String> {
    let mut reader = Reader::new(body);
    let count = reader.varint()?;
    let mut entries = Vec::new();
    for _ in 0..count {
      let name = reader.bytes()?.to_vec();
      let code = reader.u8()?;
      let kind = Kind::from_code(code)
        .ok_or_else(|| format!("a tree entry has the kind {code:02x}, which is reserved"))?;
      let target = match kind {
        Kind::Submodule => Target::Git(GitId::read(&mut reader)?),
        _ => Target::Native(NativeId::read(&mut reader)?),
      };
      entries.push(Entry { name, kind, target });
    }
    if !reader.is_empty() {
      return Err("a tree has bytes after its last entry".into());
    }
    let tree = Tree { entries };
    tree.check()?;
    Ok(tree)
  }

  /// The entries in Git's order.
  pub fn git_ordered(&self) -> Vec<&Entry> {
    let mut entries: Vec<&Entry> = self.entries.iter().collect();
    entries.sort_by(|a, b| {
      git_order(
        (&a.name, a.kind == Kind::Tree),
        (&b.name, b.kind == Kind::Tree),
      )
    });
    entries
  }

  /// The Git encoding (objects.md §4.2), given each native target's Git
  /// digest in the algorithm being encoded for; `None` when one has none.
  pub fn git_encoding(&self, git_digest: &dyn Fn(&NativeId) -> Option<Vec<u8>>) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    for entry in self.git_ordered() {
      out.extend_from_slice(entry.kind.git_mode());
      out.push(b' ');
      out.extend_from_slice(&entry.name);
      out.push(0);
      match &entry.target {
        Target::Native(id) => out.extend_from_slice(&git_digest(id)?),
        Target::Git(id) => out.extend_from_slice(&id.digest),
      }
    }
    Some(out)
  }

  /// The length of the Git encoding in an algorithm, without building it.
  pub fn git_size(&self, algorithm: GitAlgorithm) -> usize {
    self
      .entries
      .iter()
      .map(|entry| entry.kind.git_mode().len() + entry.name.len() + 2 + algorithm.length())
      .sum()
  }
}

/// The rules of objects.md §4.1 a tree's entries keep in either stored form:
/// valid names, in byte order, each once, and at most one Git algorithm among
/// its submodule links. Each entry is its name and its link's algorithm.
fn check_entries<'a>(
  entries: impl Iterator<Item = (&'a [u8], Option<u8>)>,
) -> Result<(), String> {
  let mut previous: Option<&[u8]> = None;
  let mut algorithm = None;
  for (name, linked) in entries {
    if !valid_name(name) {
      return Err(format!(
        "a tree has the entry name {:?}, which is not valid",
        String::from_utf8_lossy(name)
      ));
    }
    if previous.is_some_and(|before| before >= name) {
      return Err("a tree's entries are not in byte order of their names, or repeat one".into());
    }
    previous = Some(name);
    if let Some(linked) = linked {
      if algorithm.is_some_and(|known| known != linked) {
        return Err("a tree names Git IDs of two algorithms".into());
      }
      algorithm = Some(linked);
    }
  }
  Ok(())
}

/// The most choices a stored tree's short references may need (objects.md
/// §1.3).
pub const CHOICES: u64 = 65_536;

/// What a short-reference record's entry names (objects.md §4.4).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ShortTarget {
  Short(Short),
  Git(GitId),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ShortEntry {
  pub name: Vec<u8>,
  pub kind: Kind,
  pub target: ShortTarget,
}

/// A tree as stored in form `03` (objects.md §4.4), its native targets not
/// yet resolved.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ShortTree {
  pub entries: Vec<ShortEntry>,
}

impl ShortTree {
  /// The record, checked against every rule of §4.1 but its targets'.
  pub fn decode(record: &[u8]) -> Result<ShortTree, String> {
    let mut reader = Reader::new(record);
    let count = reader.varint()?;
    let mut entries = Vec::new();
    for _ in 0..count {
      let name = reader.bytes()?.to_vec();
      let code = reader.u8()?;
      let kind = Kind::from_code(code)
        .ok_or_else(|| format!("a tree entry has the kind {code:02x}, which is reserved"))?;
      let target = match kind {
        Kind::Submodule => ShortTarget::Git(GitId::read(&mut reader)?),
        _ => ShortTarget::Short(reader.take(8)?.try_into().expect("8 bytes")),
      };
      entries.push(ShortEntry { name, kind, target });
    }
    if !reader.is_empty() {
      return Err("a tree has bytes after its last entry".into());
    }
    check_entries(entries.iter().map(|entry| {
      let algorithm = match &entry.target {
        ShortTarget::Git(id) => Some(id.algorithm),
        ShortTarget::Short(_) => None,
      };
      (entry.name.as_slice(), algorithm)
    }))?;
    Ok(ShortTree { entries })
  }

  /// The tree `id` names, its short references resolved through
  /// `candidates` (§1.3): the one choice of a candidate for every entry whose
  /// body hashes to `id`. No candidate for an entry, more than [`CHOICES`]
  /// choices, and no choice or more than one that verifies are corrupt.
  pub fn resolve(
    &self,
    id: &NativeId,
    candidates: &dyn Fn(&Short) -> Vec<NativeId>,
  ) -> Result<Tree, String> {
    let mut options: Vec<Vec<NativeId>> = Vec::with_capacity(self.entries.len());
    let mut choices: u64 = 1;
    for entry in &self.entries {
      let found = match &entry.target {
        ShortTarget::Short(short) => {
          let found = candidates(short);
          if found.is_empty() {
            return Err(format!(
              "its entry {} names {}, a short reference no index entry's name begins with",
              String::from_utf8_lossy(&entry.name),
              hex(short)
            ));
          }
          choices = choices.saturating_mul(found.len() as u64);
          found
        }
        ShortTarget::Git(_) => Vec::new(),
      };
      options.push(found);
    }
    if choices > CHOICES {
      return Err(format!(
        "its short references allow {choices} choices, and a tree may need at most {CHOICES}"
      ));
    }
    // Every choice is tried, so a second one that verifies is found too.
    let mut at = vec![0usize; self.entries.len()];
    let mut verified = None;
    loop {
      let tree = Tree {
        entries: self
          .entries
          .iter()
          .zip(&options)
          .zip(&at)
          .map(|((entry, found), &chosen)| Entry {
            name: entry.name.clone(),
            kind: entry.kind,
            target: match &entry.target {
              ShortTarget::Short(_) => Target::Native(found[chosen]),
              ShortTarget::Git(git) => Target::Git(git.clone()),
            },
          })
          .collect(),
      };
      if NativeId::of(Type::Tree, &tree.encode()) == *id {
        if verified.is_some() {
          return Err("more than one choice of its short references' candidates hashes to its ID".into());
        }
        verified = Some(tree);
      }
      // The next choice, as an odometer: each entry's candidate turns over
      // to its first and carries to the next entry's.
      let advanced = at.iter_mut().zip(&options).any(|(chosen, found)| {
        *chosen += 1;
        if *chosen < found.len() {
          return true;
        }
        *chosen = 0;
        false
      });
      if !advanced {
        break;
      }
    }
    verified.ok_or_else(|| "no choice of its short references' candidates hashes to its ID".into())
  }
}

/// The Git kind of a preserved object (objects.md §5).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GitKind {
  Commit = 1,
  Tag = 2,
  Tree = 3,
}

impl GitKind {
  pub fn name(self) -> &'static str {
    match self {
      GitKind::Commit => "commit",
      GitKind::Tag => "tag",
      GitKind::Tree => "tree",
    }
  }

  /// The header lines that name the objects one is built on: a commit's
  /// `tree` and `parent`, and a tag's `object`, the first line's name first.
  pub fn naming(self) -> &'static [&'static [u8]] {
    match self {
      GitKind::Commit => &[b"tree ", b"parent "],
      GitKind::Tag => &[b"object "],
      GitKind::Tree => &[],
    }
  }
}

/// A Git object kept in Git's encoding, for the bridge.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Preserved {
  pub algorithm: GitAlgorithm,
  pub kind: GitKind,
  pub payload: Vec<u8>,
}

impl Preserved {
  pub fn encode(&self) -> Vec<u8> {
    let mut out = vec![self.algorithm.code(), self.kind as u8];
    out.extend_from_slice(&self.payload);
    out
  }

  pub fn decode(body: &[u8]) -> Result<Preserved, String> {
    let mut reader = Reader::new(body);
    let code = reader.u8()?;
    let algorithm = GitAlgorithm::from_code(code).ok_or_else(|| {
      format!("a preserved object has the Git algorithm {code:02x}, which is reserved")
    })?;
    let kind = match reader.u8()? {
      1 => GitKind::Commit,
      2 => GitKind::Tag,
      3 => GitKind::Tree,
      code => {
        return Err(format!(
          "a preserved object has the Git kind {code:02x}, which is reserved"
        ));
      }
    };
    Ok(Preserved {
      algorithm,
      kind,
      payload: reader.rest().to_vec(),
    })
  }

  /// The Git digests it names that Git follows, in order: for a commit or
  /// tag, its header IDs (`Preserved::header_ids`); for a tree, its entries
  /// but its submodule links.
  pub fn named(&self) -> Vec<Vec<u8>> {
    if self.kind == GitKind::Tree {
      return parse_git_tree(&self.payload, self.algorithm)
        .unwrap_or_default()
        .into_iter()
        .filter(|entry| followed(&entry.mode))
        .map(|entry| entry.digest)
        .collect();
    }
    self
      .header_ids()
      .into_iter()
      .map(|id| id.digest)
      .collect()
  }

  /// The Git IDs of its header that Git's parser follows (`header_ids`).
  pub fn header_ids(&self) -> Vec<HeaderId> {
    header_ids(self.algorithm, self.kind, &self.payload)
  }
}

/// The Git IDs of a commit's or tag's header that Git's parser follows, in
/// order: the first line's (`tree`, `object`), then a commit's `parent` lines
/// straight after it (`GitKind::naming`). A later line of either name is not
/// followed. A value is read in either case of hex, as Git's parser reads
/// it; one that is not a Git ID of its algorithm is not one, and the
/// payload's validity is Git's to judge (§5). A tree has none.
pub fn header_ids(algorithm: GitAlgorithm, kind: GitKind, payload: &[u8]) -> Vec<HeaderId> {
  let naming = kind.naming();
  let Some(&first) = naming.first() else {
    return Vec::new();
  };
  let digest = |value: &[u8]| {
    let value = std::str::from_utf8(value).ok()?;
    if value.len() != algorithm.length() * 2 {
      return None;
    }
    unhex(value)
  };
  let mut ids = Vec::new();
  let mut start = 0;
  for (index, line) in payload.split(|&byte| byte == b'\n').enumerate() {
    let name = match index {
      0 => first,
      _ => match naming.get(1) {
        Some(&then) => then,
        None => break,
      },
    };
    if !line.starts_with(name) {
      break;
    }
    let at = start + name.len()..start + line.len();
    if let Some(digest) = digest(&payload[at.clone()]) {
      ids.push(HeaderId {
        first: index == 0,
        at,
        digest,
      });
    }
    start += line.len() + 1;
  }
  ids
}

/// A Git ID a commit's or tag's header names where Git's parser follows it
/// (`header_ids`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HeaderId {
  /// Whether it is the first line's: a commit's tree, a tag's object.
  pub first: bool,
  /// Where its hex is in the payload.
  pub at: Range<usize>,
  pub digest: Vec<u8>,
}

/// What a ref in a snapshot points to (objects.md §6).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RefTarget {
  Direct(NativeId),
  Symbolic(Vec<u8>),
}

/// One ref of a snapshot.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Ref {
  pub name: Vec<u8>,
  pub target: RefTarget,
}

/// A repository's refs at one import, verbatim (objects.md §6).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Snapshot {
  pub algorithm: GitAlgorithm,
  pub refs: Vec<Ref>,
}

fn ref_name(name: &[u8]) -> bool {
  !name.is_empty() && !name.contains(&0)
}

impl Snapshot {
  /// A snapshot of these refs in byte order of their names; two refs of one
  /// name, or a name the contract does not allow, are refused.
  pub fn new(algorithm: GitAlgorithm, mut refs: Vec<Ref>) -> Result<Snapshot, String> {
    refs.sort_by(|a, b| a.name.cmp(&b.name));
    let snapshot = Snapshot { algorithm, refs };
    snapshot.check()?;
    Ok(snapshot)
  }

  /// The rules a snapshot's own bytes must keep. Whether each direct target
  /// is present and has an alias row is the store's to check.
  fn check(&self) -> Result<(), String> {
    for (index, entry) in self.refs.iter().enumerate() {
      let shown = String::from_utf8_lossy(&entry.name);
      if !ref_name(&entry.name) {
        return Err(format!(
          "a snapshot has the ref name {shown:?}, which is empty or holds a NUL"
        ));
      }
      if let RefTarget::Symbolic(target) = &entry.target
        && !ref_name(target)
      {
        return Err(format!(
          "a snapshot's ref {shown} is symbolic to a name that is empty or holds a NUL"
        ));
      }
      if index > 0 && self.refs[index - 1].name >= entry.name {
        return Err(format!(
          "a snapshot's refs are not in byte order of their names, with none equal, at {shown}"
        ));
      }
    }
    Ok(())
  }

  pub fn encode(&self) -> Vec<u8> {
    let mut out = vec![self.algorithm.code()];
    put_varint(&mut out, self.refs.len() as u64);
    for entry in &self.refs {
      put_bytes(&mut out, &entry.name);
      match &entry.target {
        RefTarget::Direct(id) => {
          out.push(1);
          id.put(&mut out);
        }
        RefTarget::Symbolic(target) => {
          out.push(2);
          put_bytes(&mut out, target);
        }
      }
    }
    out
  }

  pub fn decode(body: &[u8]) -> Result<Snapshot, String> {
    let mut reader = Reader::new(body);
    let code = reader.u8()?;
    let algorithm = GitAlgorithm::from_code(code)
      .ok_or_else(|| format!("a snapshot has the Git algorithm {code:02x}, which is reserved"))?;
    let count = reader.varint()?;
    // Each ref takes at least 3 bytes, so a count past the body is refused
    // before anything is allocated for it.
    if count > body.len() as u64 / 3 {
      return Err(format!(
        "a snapshot says it has {count} refs, more than its bytes hold"
      ));
    }
    let mut refs = Vec::with_capacity(count as usize);
    for _ in 0..count {
      let name = reader.bytes()?.to_vec();
      let target = match reader.u8()? {
        1 => RefTarget::Direct(NativeId::read(&mut reader)?),
        2 => RefTarget::Symbolic(reader.bytes()?.to_vec()),
        kind => {
          return Err(format!(
            "a snapshot's ref {} has the kind {kind:02x}, which is reserved",
            String::from_utf8_lossy(&name)
          ));
        }
      };
      refs.push(Ref { name, target });
    }
    if !reader.is_empty() {
      return Err("a snapshot has bytes after its last ref".into());
    }
    let snapshot = Snapshot { algorithm, refs };
    snapshot.check()?;
    Ok(snapshot)
  }
}

/// A tree entry's mode as Git reads it (`get_mode` in Git's `tree-walk.c`):
/// one or more octal digits, in an unsigned 32-bit number that wraps as Git's
/// does, so `10000000000000000000000000100644` is `100644`. `None` when Git
/// cannot read the mode, a sign or an empty mode included.
pub fn git_mode(mode: &[u8]) -> Option<u32> {
  if mode.is_empty() || !mode.iter().all(|digit| (b'0'..=b'7').contains(digit)) {
    return None;
  }
  Some(mode.iter().fold(0u32, |value, digit| (value << 3).wrapping_add(u32::from(digit - b'0'))))
}

/// Whether Git follows a tree entry of this mode: every mode but a submodule
/// link's, after Git's own `canon_mode`. A mode Git cannot read is followed
/// by neither.
pub fn followed(mode: &[u8]) -> bool {
  git_mode(mode).is_some_and(|mode| matches!(mode & 0o170000, 0o100000 | 0o120000 | 0o040000))
}

/// One record of a Git tree, as Git wrote it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GitEntry {
  pub mode: Vec<u8>,
  pub name: Vec<u8>,
  pub digest: Vec<u8>,
}

/// A Git tree's records, in the order written; `None` when the bytes are not a
/// sequence of `<mode> <name>\0<digest>` records.
pub fn parse_git_tree(payload: &[u8], algorithm: GitAlgorithm) -> Option<Vec<GitEntry>> {
  let mut entries = Vec::new();
  let mut rest = payload;
  while !rest.is_empty() {
    let space = rest.iter().position(|&byte| byte == b' ')?;
    let nul = space + 1 + rest[space + 1..].iter().position(|&byte| byte == 0)?;
    let end = nul + 1 + algorithm.length();
    if rest.len() < end {
      return None;
    }
    entries.push(GitEntry {
      mode: rest[..space].to_vec(),
      name: rest[space + 1..nul].to_vec(),
      digest: rest[nul + 1..end].to_vec(),
    });
    rest = &rest[end..];
  }
  Some(entries)
}

/// An annotation (objects.md §7): derived data attached to a subject without
/// changing the subject's ID.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Annotation {
  pub subject: NativeId,
  /// The annotation type's name.
  pub kind: Vec<u8>,
  /// Interpreted by the type; a reader that does not know the type leaves it
  /// undecoded.
  pub payload: Vec<u8>,
}

impl Annotation {
  pub fn encode(&self) -> Vec<u8> {
    let mut out = Vec::new();
    self.subject.put(&mut out);
    put_bytes(&mut out, &self.kind);
    out.extend_from_slice(&self.payload);
    out
  }

  /// An annotation's body, checked for what every type shares: a subject of
  /// a known tag, and a well-formed type name.
  pub fn decode(body: &[u8]) -> Result<Annotation, String> {
    let mut reader = Reader::new(body);
    let subject = NativeId::read(&mut reader)?;
    let kind = reader.bytes()?.to_vec();
    let well_formed = !kind.is_empty()
      && kind.len() <= 64
      && kind[0].is_ascii_alphanumeric()
      && kind
        .iter()
        .all(|&byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'.' || byte == b'-');
    if !well_formed {
      return Err(format!(
        "an annotation's type {:?} is not a type name",
        String::from_utf8_lossy(&kind)
      ));
    }
    Ok(Annotation {
      subject,
      kind,
      payload: reader.rest().to_vec(),
    })
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::id::{Type, hex, unhex};

  fn content(bytes: &[u8]) -> NativeId {
    NativeId::of(Type::Content, bytes)
  }

  #[test]
  fn a_mode_reads_as_git_reads_it() {
    assert_eq!(git_mode(b"100644"), Some(0o100644));
    assert_eq!(git_mode(b"40000"), Some(0o40000));
    // Git's unsigned int wraps: the digits past 32 bits fall away.
    assert_eq!(git_mode(b"10000000000000000000000000100644"), Some(0o100644));
    assert_eq!(git_mode(b"77777777777"), Some(u32::MAX));
    for unread in [&b""[..], b"+100644", b"-1", b"100648", b"10 644"] {
      assert_eq!(git_mode(unread), None, "{}", String::from_utf8_lossy(unread));
    }
    assert!(followed(b"10000000000000000000000000100644"));
    assert!(!followed(b"+100644"));
  }

  #[test]
  fn trees_are_the_contracts_examples() {
    let empty = Tree::default();
    assert_eq!(empty.encode(), [0x00]);
    assert_eq!(
      NativeId::of(Type::Tree, &empty.encode()).hex(),
      "da296d2ac403c5b842b5ad9b5a423dc035e0f13bdfe464b6108e18f1ca6c78f1"
    );
    let hello = Tree::from_entries(vec![Entry {
      name: b"hello.txt".to_vec(),
      kind: Kind::File,
      target: Target::Native(content(b"hello\n")),
    }])
    .unwrap();
    let body = hello.encode();
    assert_eq!(body.len(), 45);
    assert_eq!(
      hex(&body),
      "010968656c6c6f2e7478740101c32f27e6a5e1d06a6c75540b1410f868f228ace6b7dcc3b3f1834c6dce1b1988"
    );
    assert_eq!(
      NativeId::of(Type::Tree, &body).hex(),
      "754a90b4c821bcf47f6441bdbed3bfe8eae725f9f72f50beafebf4c2b603680a"
    );
    assert_eq!(Tree::decode(&body).unwrap(), hello);
    let blob = unhex("ce013625030ba8dba906f756967f9e9ca394464a").unwrap();
    let git = hello.git_encoding(&|_| Some(blob.clone())).unwrap();
    assert_eq!(git, [b"100644 hello.txt\0".as_slice(), &blob].concat());
    assert_eq!(hello.git_size(GitAlgorithm::Sha1), git.len());
  }

  /// An ID sharing `id`'s short reference, as an index name may: only its
  /// last byte differs.
  fn sharing(id: &NativeId) -> NativeId {
    let mut digest = id.0;
    digest[31] ^= 0xff;
    NativeId(digest)
  }

  fn hello() -> Tree {
    Tree::from_entries(vec![Entry {
      name: b"hello.txt".to_vec(),
      kind: Kind::File,
      target: Target::Native(content(b"hello\n")),
    }])
    .unwrap()
  }

  #[test]
  fn the_short_reference_form_is_the_contracts_example() {
    let tree = hello();
    let id = NativeId::of(Type::Tree, &tree.encode());
    let record = tree.encode_short();
    assert_eq!(record.len(), 20);
    assert_eq!(hex(&record), "010968656c6c6f2e74787401c32f27e6a5e1d06a");
    let short = ShortTree::decode(&record).unwrap();
    let resolved = short
      .resolve(&id, &|prefix| {
        assert_eq!(hex(prefix), "c32f27e6a5e1d06a");
        vec![content(b"hello\n")]
      })
      .unwrap();
    assert_eq!(resolved, tree);
  }

  #[test]
  fn a_shared_reference_resolves_to_the_one_choice_that_verifies() {
    let target = content(b"hello\n");
    let tree = Tree::from_entries(vec![
      Entry {
        name: b"a".to_vec(),
        kind: Kind::File,
        target: Target::Native(target),
      },
      Entry {
        name: b"m".to_vec(),
        kind: Kind::Submodule,
        target: Target::Git(GitId::new(GitAlgorithm::Sha1, vec![7; 20])),
      },
      Entry {
        name: b"z".to_vec(),
        kind: Kind::Tree,
        target: Target::Native(NativeId::of(Type::Tree, &[0])),
      },
    ])
    .unwrap();
    let id = NativeId::of(Type::Tree, &tree.encode());
    let short = ShortTree::decode(&tree.encode_short()).unwrap();
    // The other candidate sorts first, so the reader cannot just take the
    // first; a submodule link keeps its whole Git ID.
    let candidates = |prefix: &[u8; 8]| {
      let mut found = vec![target, sharing(&target), NativeId::of(Type::Tree, &[0])];
      found.retain(|candidate| candidate.short() == *prefix);
      found.sort();
      found
    };
    assert_eq!(short.resolve(&id, &candidates).unwrap(), tree);
  }

  #[test]
  fn a_reference_with_no_candidate_is_corrupt_naming_its_entry() {
    let tree = hello();
    let id = NativeId::of(Type::Tree, &tree.encode());
    let short = ShortTree::decode(&tree.encode_short()).unwrap();
    assert_eq!(
      short.resolve(&id, &|_| Vec::new()).unwrap_err(),
      "its entry hello.txt names c32f27e6a5e1d06a, a short reference no index entry's name begins with"
    );
  }

  #[test]
  fn no_choice_that_verifies_or_more_than_the_bound_is_corrupt() {
    let tree = hello();
    let id = NativeId::of(Type::Tree, &tree.encode());
    let short = ShortTree::decode(&tree.encode_short()).unwrap();
    let wrong = sharing(&content(b"hello\n"));
    assert_eq!(
      short.resolve(&id, &|_| vec![wrong]).unwrap_err(),
      "no choice of its short references' candidates hashes to its ID"
    );
    // 17 entries of two candidates each need 131,072 choices.
    let entries: Vec<Entry> = (0..17u8)
      .map(|n| Entry {
        name: vec![b'a' + n],
        kind: Kind::File,
        target: Target::Native(content(&[n])),
      })
      .collect();
    let wide = Tree::from_entries(entries).unwrap();
    let wide_id = NativeId::of(Type::Tree, &wide.encode());
    let pairs = |prefix: &[u8; 8]| {
      let mut digest = [0xff; 32];
      digest[..8].copy_from_slice(prefix);
      vec![NativeId(digest), NativeId(digest)]
        .into_iter()
        .enumerate()
        .map(|(n, mut id)| {
          id.0[31] = n as u8;
          id
        })
        .collect()
    };
    assert_eq!(
      ShortTree::decode(&wide.encode_short())
        .unwrap()
        .resolve(&wide_id, &pairs)
        .unwrap_err(),
      "its short references allow 131072 choices, and a tree may need at most 65536"
    );
  }

  #[test]
  fn a_short_record_that_breaks_the_tree_rules_is_refused() {
    let mut record = hello().encode_short();
    record.push(0);
    assert!(ShortTree::decode(&record).is_err());
    // Two entries out of order.
    let tree = Tree {
      entries: vec![
        Entry {
          name: b"b".to_vec(),
          kind: Kind::File,
          target: Target::Native(content(b"b")),
        },
        Entry {
          name: b"a".to_vec(),
          kind: Kind::File,
          target: Target::Native(content(b"a")),
        },
      ],
    };
    assert!(ShortTree::decode(&tree.encode_short()).is_err());
  }

  #[test]
  fn git_order_puts_a_tree_after_a_name_it_prefixes() {
    let tree = Tree::from_entries(vec![
      Entry {
        name: b"a.b".to_vec(),
        kind: Kind::File,
        target: Target::Native(content(b"x")),
      },
      Entry {
        name: b"a".to_vec(),
        kind: Kind::Tree,
        target: Target::Native(content(b"y")),
      },
    ])
    .unwrap();
    assert_eq!(tree.entries[0].name, b"a");
    let names: Vec<&[u8]> = tree
      .git_ordered()
      .iter()
      .map(|entry| entry.name.as_slice())
      .collect();
    assert_eq!(names, [b"a.b".as_slice(), b"a"]);
  }

  #[test]
  fn a_tree_breaking_a_rule_is_refused() {
    let file = |name: &[u8]| Entry {
      name: name.to_vec(),
      kind: Kind::File,
      target: Target::Native(content(b"")),
    };
    for names in [
      vec![b"a".as_slice(), b"a"],
      vec![b"."],
      vec![b"a/b"],
      vec![b""],
      vec![b"a\0"],
    ] {
      assert!(Tree::from_entries(names.into_iter().map(file).collect()).is_err());
    }
    let unsorted = Tree {
      entries: vec![file(b"b"), file(b"a")],
    };
    assert!(Tree::decode(&unsorted.encode()).is_err());
  }

  #[test]
  fn chunk_lists_are_the_contracts_example() {
    let list = ChunkList {
      size: 6,
      chunks: vec![(content(b"hel"), 3), (content(b"lo\n"), 3)],
    };
    assert_eq!(
      content(b"hel").hex(),
      "a77ca2722fdec8942eb8d8f2440b5dbe6dc40a52625103a896356aa1c169e639"
    );
    assert_eq!(
      content(b"lo\n").hex(),
      "36b41755fab71e5114ddd9a148ea92e47e16c5d5c68c7a725e70d8e1b2a6b80f"
    );
    let encoded = list.encode();
    assert_eq!(
      hex(&encoded),
      [
        "01",
        "0000000000000000",
        "06",
        "02",
        "01a77ca2722fdec8942eb8d8f2440b5dbe6dc40a52625103a896356aa1c169e639",
        "03",
        "0136b41755fab71e5114ddd9a148ea92e47e16c5d5c68c7a725e70d8e1b2a6b80f",
        "03",
      ]
      .concat()
    );
    assert_eq!(ChunkList::decode(&encoded).unwrap(), list);
    let mut short = list.clone();
    short.chunks[1].1 = 2;
    assert!(ChunkList::decode(&short.encode()).is_err());
  }

  #[test]
  fn preserved_objects_are_the_contracts_examples() {
    let commit = b"tree aaa96ced2d9a1c8e72c56b253a0e2fe78393feb7\n\
author A U Thor <author@example.com> 1112911993 -0700\n\
committer C O Mitter <committer@example.com> 1112911993 -0700\n\nAdd hello\n";
    assert_eq!(commit.len(), 173);
    let preserved = Preserved {
      algorithm: GitAlgorithm::Sha1,
      kind: GitKind::Commit,
      payload: commit.to_vec(),
    };
    assert_eq!(
      NativeId::of(Type::Preserved, &preserved.encode()).hex(),
      "1ba8e668bdf6a1eb2a9393f5f658625f1f3ca733b6dc6648df2d62977c32ef96"
    );
    let body = unhex("010330343030303020737562004b825dc642cb6eb9a060e54bf8d69288fbee4904").unwrap();
    let tree = Preserved::decode(&body).unwrap();
    assert_eq!(
      (tree.algorithm, tree.kind),
      (GitAlgorithm::Sha1, GitKind::Tree)
    );
    assert_eq!(tree.encode(), body);
    assert_eq!(
      NativeId::of(Type::Preserved, &body).hex(),
      "676df8b76c086c6d81d5c237307e5c9d39425ede8923bacbe34e0e92b78eed09"
    );
    let entries = parse_git_tree(&tree.payload, GitAlgorithm::Sha1).unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(
      (entries[0].mode.as_slice(), entries[0].name.as_slice()),
      (b"040000".as_slice(), b"sub".as_slice())
    );
    assert_eq!(Kind::from_git_mode(&entries[0].mode), None);
  }

  #[test]
  fn only_the_header_ids_git_reads_are_followed() {
    let tree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
    let one = "1111111111111111111111111111111111111111";
    let two = "2222222222222222222222222222222222222222";
    let preserved = |kind, payload: String| Preserved {
      algorithm: GitAlgorithm::Sha1,
      kind,
      payload: payload.into_bytes(),
    };
    let shown = |preserved: &Preserved| -> Vec<(bool, String)> {
      preserved
        .header_ids()
        .into_iter()
        .map(|id| {
          let text = String::from_utf8(preserved.payload[id.at.clone()].to_vec()).unwrap();
          assert_eq!(hex(&id.digest), text.to_ascii_lowercase());
          (id.first, text)
        })
        .collect()
    };

    // The first line, the parents straight after it, and nothing later: not
    // a parent after another line, a second tree, or anything past the
    // header. Hex in either case is read, as Git reads it; a value that is
    // no Git ID is skipped.
    let upper = "AB".repeat(20);
    let commit = preserved(
      GitKind::Commit,
      format!(
        "tree {tree}\nparent {one}\nparent {upper}\nparent {}\nparent {}\nparent {two}\n\
         author A <a@e> 1 +0000\nparent {one}\ntree {two}\n\nparent {two}\n",
        "zz".repeat(20),
        "ab".repeat(19)
      ),
    );
    assert_eq!(
      shown(&commit),
      [
        (true, tree.into()),
        (false, one.into()),
        (false, upper.clone()),
        (false, two.into())
      ]
    );
    assert_eq!(commit.named().len(), 4);

    // A commit whose first line is not its tree is built on nothing Git reads.
    let late = preserved(GitKind::Commit, format!("author A <a@e> 1 +0000\ntree {tree}\n\nx\n"));
    assert!(late.header_ids().is_empty());

    let tag = preserved(
      GitKind::Tag,
      format!("object {one}\ntype commit\nobject {two}\ntag v\n\nobject {two}\n"),
    );
    assert_eq!(shown(&tag), [(true, one.into())]);

    let kept = preserved(GitKind::Tree, String::new());
    assert!(kept.header_ids().is_empty());
  }

  #[test]
  fn annotations_are_the_contracts_example_and_keep_their_rules() {
    let annotation = Annotation {
      subject: content(b"hello\n"),
      kind: b"example".to_vec(),
      payload: b"x".to_vec(),
    };
    let body = annotation.encode();
    assert_eq!(body.len(), 42);
    assert_eq!(
      NativeId::of(Type::Annotation, &body).hex(),
      "dc1e9fcb5149da8887cbc87733281a38cfee0a1cb79a288ecd9b45635f403bea"
    );
    assert_eq!(Annotation::decode(&body).unwrap(), annotation);
    for kind in [&b""[..], b"Upper", b"-lead", b"sp ace", &[b'a'; 65]] {
      let bad = Annotation {
        kind: kind.to_vec(),
        ..annotation.clone()
      };
      assert!(Annotation::decode(&bad.encode()).is_err(), "{kind:?}");
    }
    let mut tag = body.clone();
    tag[0] = 0x02;
    assert!(Annotation::decode(&tag).is_err());
  }

  #[test]
  fn snapshots_are_the_contracts_example_and_keep_their_rules() {
    let commit =
      NativeId::from_hex("1ba8e668bdf6a1eb2a9393f5f658625f1f3ca733b6dc6648df2d62977c32ef96")
        .unwrap();
    let snapshot = Snapshot::new(
      GitAlgorithm::Sha1,
      vec![
        Ref {
          name: b"refs/heads/main".to_vec(),
          target: RefTarget::Direct(commit),
        },
        Ref {
          name: b"HEAD".to_vec(),
          target: RefTarget::Symbolic(b"refs/heads/main".to_vec()),
        },
      ],
    )
    .unwrap();
    let body = snapshot.encode();
    assert_eq!(body.len(), 74);
    assert_eq!(
      hex(&body),
      concat!(
        "0102",
        "0448454144",
        "02",
        "0f726566732f68656164732f6d61696e",
        "0f726566732f68656164732f6d61696e",
        "01",
        "011ba8e668bdf6a1eb2a9393f5f658625f1f3ca733b6dc6648df2d62977c32ef96"
      )
    );
    assert_eq!(
      NativeId::of(Type::Snapshot, &body).hex(),
      "78c68444e6ea2ca3d6da20db3e36bdf71ff3da61a55a3c47c5200fbdada776b5"
    );
    assert_eq!(Snapshot::decode(&body).unwrap(), snapshot);

    let direct = |name: &[u8]| Ref {
      name: name.to_vec(),
      target: RefTarget::Direct(commit),
    };
    assert!(Snapshot::new(GitAlgorithm::Sha1, vec![direct(b"a"), direct(b"a")]).is_err());
    assert!(Snapshot::new(GitAlgorithm::Sha1, vec![direct(b"")]).is_err());
    assert!(Snapshot::new(GitAlgorithm::Sha1, vec![direct(b"a\0b")]).is_err());
    let unordered = Snapshot {
      algorithm: GitAlgorithm::Sha1,
      refs: vec![direct(b"b"), direct(b"a")],
    };
    assert!(Snapshot::decode(&unordered.encode()).is_err());
    let mut trailing = body.clone();
    trailing.push(0);
    assert!(Snapshot::decode(&trailing).is_err());
    let mut kind = body.clone();
    kind[7] = 3;
    assert!(Snapshot::decode(&kind).is_err());
    assert!(Snapshot::decode(&[0x01, 0xff, 0xff, 0xff, 0x0f]).is_err());
  }
}
