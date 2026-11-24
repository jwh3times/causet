//! Native tags (commits.md §4): their encoding, and how import derives one
//! from the preserved Git tag it imports (§5.4).

use crate::actor::{self, Actor, Role};
use crate::commit::{header_lines, split};
use crate::signature::Signature;
use causet_store::StoreError;
use causet_store::encoding::{Reader, put_bytes};
use causet_store::id::{NativeId, Type};
use causet_store::store::Store;
use std::collections::HashMap;

/// A native tag: an annotated tag.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Tag {
  /// A native commit, a native tag, a tree, a preserved Git tree, or
  /// content; never a preserved commit or tag (§4.2).
  pub target: NativeId,
  /// The tag's name, empty for an imported tag whose Git tag names none.
  pub name: Vec<u8>,
  pub tagger: Signature,
  pub actors: Vec<Actor>,
  /// The preserved Git tag it was imported from; present exactly when it
  /// was imported.
  pub preserved: Option<NativeId>,
  /// Byte for byte, an inline signature included.
  pub message: Vec<u8>,
}

impl Tag {
  pub fn encode(&self) -> Vec<u8> {
    let mut out = Vec::with_capacity(120 + self.name.len() + self.message.len());
    self.target.put(&mut out);
    put_bytes(&mut out, &self.name);
    self.tagger.encode(&mut out);
    actor::encode_list(&self.actors, &mut out);
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

  /// A body, checked against the rules a body alone can be held to (§4.2).
  /// What its target is, and that an imported one is exactly what import
  /// derives, need the store.
  pub fn decode(body: &[u8]) -> Result<Tag, String> {
    let mut reader = Reader::new(body);
    let target = NativeId::read(&mut reader)?;
    let name = reader.bytes()?.to_vec();
    let tagger = Signature::decode(&mut reader)?;
    let actors = actor::decode_list(&mut reader)?;
    let preserved = match reader.u8()? {
      0x00 => None,
      0x01 => Some(NativeId::read(&mut reader)?),
      flag => return Err(format!("an optional field has the flag {flag:02x}")),
    };
    let message = reader.rest().to_vec();
    if preserved.is_none()
      && (name.is_empty() || !matches!(tagger, Signature::Fields { .. }) || actors.is_empty())
    {
      return Err("a tag made natively needs a name, a tagger in form 00, and an actor".into());
    }
    Ok(Tag {
      target,
      name,
      tagger,
      actors,
      preserved,
      message,
    })
  }

  pub fn id(&self) -> NativeId {
    NativeId::of(Type::NativeTag, &self.encode())
  }
}

/// Every native tag a store holds, decoded, with the native tag of each
/// preserved tag an imported one derives from. A body that does not decode
/// is corrupt.
pub struct Tags {
  pub by_id: HashMap<NativeId, Tag>,
  pub by_preserved: HashMap<NativeId, NativeId>,
}

impl Tags {
  pub fn read(store: &Store) -> Result<Tags, StoreError> {
    let mut by_id = HashMap::new();
    let mut by_preserved = HashMap::new();
    for (id, kind, _) in store.present()? {
      if kind != Type::NativeTag {
        continue;
      }
      let tag = Tag::decode(&store.read(&id)?.body)
        .map_err(|why| StoreError::Corrupt(format!("the native tag {id}: {why}")))?;
      if let Some(preserved) = tag.preserved {
        by_preserved.insert(preserved, id);
      }
      by_id.insert(id, tag);
    }
    Ok(Tags {
      by_id,
      by_preserved,
    })
  }
}

/// The native tag import derives from a Git tag's payload (§5.4), given the
/// native form of what it names and its preserved object.
pub fn derive(payload: &[u8], preserved: NativeId, target: NativeId) -> Tag {
  let (header, message) = split(payload);
  let first = |word: &[u8]| {
    header_lines(header)
      .find_map(|line| line.strip_prefix(word))
      .map(<[u8]>::to_vec)
  };
  let tagger_line = first(b"tagger ");
  let actors = tagger_line
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
  Tag {
    target,
    name: first(b"tag ").unwrap_or_default(),
    tagger: tagger_line
      .as_deref()
      .map_or(Signature::None, Signature::from_line),
    actors,
    preserved: Some(preserved),
    message: message.to_vec(),
  }
}
