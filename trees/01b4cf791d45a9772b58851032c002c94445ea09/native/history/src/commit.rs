//! Native commits (commits.md §3): their encoding, and how import derives
//! one from the preserved Git commit it imports (§5.2, §5.3).

use crate::actor::{self, Actor, Role};
use crate::signature::Signature;
use crate::text::{decimal, is_git_space};
use causet_model::trailer::{extract_trailer, trim};
use causet_store::StoreError;
use causet_store::encoding::{Reader, put_bytes, put_varint};
use causet_store::id::{NativeId, Type};
use causet_store::store::Store;
use std::collections::HashMap;

/// A native commit: a point in history.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Commit {
  /// A tree, or a preserved Git tree.
  pub tree: NativeId,
  /// Native commits, in order, repeated where the Git commit repeats them.
  pub parents: Vec<NativeId>,
  pub author: Signature,
  pub committer: Signature,
  /// The message's encoding, when it names one.
  pub encoding: Option<Vec<u8>>,
  pub actors: Vec<Actor>,
  pub change_id: Option<String>,
  pub derived_from: Option<String>,
  pub origin_commit: Option<String>,
  /// The preserved Git commit it was imported from; present exactly when it
  /// was imported.
  pub preserved: Option<NativeId>,
  /// Byte for byte, never re-encoded.
  pub message: Vec<u8>,
}

fn put_optional_bytes(out: &mut Vec<u8>, value: Option<&[u8]>) {
  match value {
    Some(bytes) => {
      out.push(0x01);
      put_bytes(out, bytes);
    }
    None => out.push(0x00),
  }
}

fn optional_bytes<'a>(reader: &mut Reader<'a>) -> Result<Option<&'a [u8]>, String> {
  match reader.u8()? {
    0x00 => Ok(None),
    0x01 => Ok(Some(reader.bytes()?)),
    flag => Err(format!("an optional field has the flag {flag:02x}")),
  }
}

fn optional_text(reader: &mut Reader, what: &str) -> Result<Option<String>, String> {
  optional_bytes(reader)?
    .map(|bytes| {
      String::from_utf8(bytes.to_vec()).map_err(|_| format!("a commit's {what} is not UTF-8"))
    })
    .transpose()
}

impl Commit {
  pub fn encode(&self) -> Vec<u8> {
    let mut out = Vec::with_capacity(160 + self.message.len());
    self.tree.put(&mut out);
    put_varint(&mut out, self.parents.len() as u64);
    for parent in &self.parents {
      parent.put(&mut out);
    }
    self.author.encode(&mut out);
    self.committer.encode(&mut out);
    put_optional_bytes(&mut out, self.encoding.as_deref());
    actor::encode_list(&self.actors, &mut out);
    for text in [&self.change_id, &self.derived_from, &self.origin_commit] {
      put_optional_bytes(&mut out, text.as_deref().map(str::as_bytes));
    }
    match &self.preserved {
      Some(id) => {
        out.push(0x01);
        id.put(&mut out);
      }
      None => out.push(0x00),
    }
    out.extend_from_slice(&self.message);
    out
  }

  /// A body, checked against the rules a body alone can be held to (§3.2).
  /// That a parent is a native commit, and that an imported one is exactly
  /// what import derives, need the store.
  pub fn decode(body: &[u8]) -> Result<Commit, String> {
    let mut reader = Reader::new(body);
    let tree = NativeId::read(&mut reader)?;
    let count = reader.varint()?;
    if count > (body.len() / 33) as u64 {
      return Err(format!(
        "a commit claims {count} parents, more than its body holds"
      ));
    }
    let mut parents = Vec::with_capacity(count as usize);
    for _ in 0..count {
      parents.push(NativeId::read(&mut reader)?);
    }
    let author = Signature::decode(&mut reader)?;
    let committer = Signature::decode(&mut reader)?;
    let encoding = optional_bytes(&mut reader)?.map(<[u8]>::to_vec);
    if let Some(encoding) = &encoding
      && (encoding.is_empty() || encoding.iter().any(|byte| matches!(byte, 0x0a | 0x00)))
    {
      return Err("a commit's encoding is empty, or holds a line feed or NUL".into());
    }
    let actors = actor::decode_list(&mut reader)?;
    let change_id = optional_text(&mut reader, "changeId")?;
    let derived_from = optional_text(&mut reader, "derivedFrom")?;
    let origin_commit = optional_text(&mut reader, "originCommit")?;
    let preserved = match reader.u8()? {
      0x00 => None,
      0x01 => Some(NativeId::read(&mut reader)?),
      flag => return Err(format!("an optional field has the flag {flag:02x}")),
    };
    let message = reader.rest().to_vec();
    if preserved.is_none() {
      let fields = |signature: &Signature| matches!(signature, Signature::Fields { .. });
      if !fields(&author) || !fields(&committer) || actors.is_empty() {
        return Err("a commit made natively needs both signatures in form 00, and an actor".into());
      }
    }
    Ok(Commit {
      tree,
      parents,
      author,
      committer,
      encoding,
      actors,
      change_id,
      derived_from,
      origin_commit,
      preserved,
      message,
    })
  }

  pub fn id(&self) -> NativeId {
    NativeId::of(Type::NativeCommit, &self.encode())
  }

  /// Its date as Git's revision walk orders by it: the committer's time,
  /// or for a line held verbatim the digits after its last `>` and any
  /// space, and 0 when there are none. Git reads the committer line
  /// straight after the author's, which a commit with repeated or reordered
  /// lines may not have; such commits are #417's.
  pub fn date(&self) -> u64 {
    match &self.committer {
      Signature::Fields { time, .. } => *time,
      Signature::Verbatim(line) => match line.iter().rposition(|&byte| byte == b'>') {
        Some(at) => {
          let rest = &line[at + 1..];
          let start = rest
            .iter()
            .position(|&byte| !is_git_space(byte))
            .unwrap_or(rest.len());
          let digits = rest[start..]
            .iter()
            .take_while(|byte| byte.is_ascii_digit())
            .count();
          decimal(&rest[start..start + digits])
        }
        None => 0,
      },
      Signature::None => 0,
    }
  }
}

/// Every native commit a store holds, decoded, with the native commit of
/// each preserved commit an imported one derives from. A body that does
/// not decode is corrupt.
pub struct Commits {
  pub by_id: HashMap<NativeId, Commit>,
  pub by_preserved: HashMap<NativeId, NativeId>,
  /// How many objects the store holds present, every type counted.
  pub objects: usize,
}

impl Commits {
  pub fn read(store: &Store) -> Result<Commits, StoreError> {
    let present = store.present()?;
    let mut by_id = HashMap::new();
    let mut by_preserved = HashMap::new();
    for (id, kind, _) in &present {
      if *kind != Type::NativeCommit {
        continue;
      }
      let body = store.read(id)?.body;
      let commit = Commit::decode(&body)
        .map_err(|why| StoreError::Corrupt(format!("the native commit {id}: {why}")))?;
      if let Some(preserved) = commit.preserved {
        by_preserved.insert(preserved, *id);
      }
      by_id.insert(*id, commit);
    }
    Ok(Commits {
      by_id,
      by_preserved,
      objects: present.len(),
    })
  }
}

/// A Git commit's or tag's header and message (§5.2): the payload up to the
/// first empty line, and everything after it, empty when there is none.
pub fn split(payload: &[u8]) -> (&[u8], &[u8]) {
  match payload.windows(2).position(|pair| pair == b"\n\n") {
    Some(at) => (&payload[..at], &payload[at + 2..]),
    None => (payload, &[]),
  }
}

/// The header lines: the lines of the header that do not begin with a
/// space, which continue the line before.
pub fn header_lines(header: &[u8]) -> impl Iterator<Item = &[u8]> {
  header
    .split(|&byte| byte == b'\n')
    .filter(|line| line.first() != Some(&b' '))
}

/// The lift (§5.3): a trailer's value as Git-backed cst reads it from a
/// commit object, decoded as UTF-8 with replacement and trimmed.
pub fn lift(message: &[u8], name: &str) -> Option<String> {
  extract_trailer(trim(&String::from_utf8_lossy(message)), name)
}

/// The native commit import derives from a Git commit's payload (§5.2),
/// given the native forms of its tree and parents and its preserved object.
pub fn derive(
  payload: &[u8],
  preserved: NativeId,
  tree: NativeId,
  parents: Vec<NativeId>,
) -> Commit {
  let (header, message) = split(payload);
  let last = |word: &[u8]| {
    header_lines(header)
      .filter_map(|line| line.strip_prefix(word))
      .last()
      .map(<[u8]>::to_vec)
  };
  let author_line = last(b"author ");
  let signature = |line: &Option<Vec<u8>>| {
    line
      .as_deref()
      .map_or(Signature::None, Signature::from_line)
  };
  // A value Git could not name an encoding with is no encoding (§3.2).
  let encoding = header_lines(header)
    .find_map(|line| line.strip_prefix(b"encoding ").map(<[u8]>::to_vec))
    .filter(|value| !value.is_empty() && !value.contains(&0x00));
  let actors = author_line
    .as_deref()
    .map(|line| match line.iter().rposition(|&byte| byte == b'>') {
      Some(at) => &line[..=at],
      None => line,
    })
    .map(|claimed| String::from_utf8_lossy(claimed).into_owned())
    .filter(|claimed| !claimed.is_empty())
    .map(|claimed| Actor {
      role: Role::Authored,
      actor: claimed,
      kind: None,
      on_behalf_of: None,
    })
    .into_iter()
    .collect();
  Commit {
    tree,
    parents,
    author: signature(&author_line),
    committer: signature(&last(b"committer ")),
    encoding,
    actors,
    change_id: lift(message, "Change-Id"),
    derived_from: lift(message, "Derived-From"),
    origin_commit: lift(message, "Origin-Commit"),
    preserved: Some(preserved),
    message: message.to_vec(),
  }
}
