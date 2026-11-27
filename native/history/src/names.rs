//! Names (docs/native-history/operations.md §2): branches, tags and
//! remote-tracking names, and which refs of an imported snapshot become them
//! (§4.1, ADR-0047 decision 9). Every other ref stays in the snapshot for the
//! bridge, and is never shown as a name.

use causet_store::encoding::{Reader, put_bytes, put_varint};
use causet_store::id::NativeId;
use causet_store::objects::{Ref, RefTarget, Snapshot};

/// A name's kind, in the order a view lists them (§2.1).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Kind {
  Branch = 1,
  Tag = 2,
  RemoteTracking = 3,
}

impl Kind {
  pub const ALL: [Kind; 3] = [Kind::Branch, Kind::Tag, Kind::RemoteTracking];

  /// Its code in a name's encoding (§2.2).
  pub fn code(self) -> u8 {
    self as u8
  }

  /// The word output uses for it.
  pub fn word(self) -> &'static str {
    match self {
      Kind::Branch => "branch",
      Kind::Tag => "tag",
      Kind::RemoteTracking => "remote-tracking",
    }
  }

  /// The Git namespace its names come from on import, and are shown in where
  /// a format asks for a ref's full name.
  pub fn namespace(self) -> &'static [u8] {
    match self {
      Kind::Branch => b"refs/heads/",
      Kind::Tag => b"refs/tags/",
      Kind::RemoteTracking => b"refs/remotes/",
    }
  }

  /// A name of this kind as the full Git ref it comes from.
  pub fn reference(self, name: &[u8]) -> Vec<u8> {
    [self.namespace(), name].concat()
  }

  /// The kind and name a full Git ref becomes, when it becomes one: in one of
  /// the three namespaces, with something after it.
  pub fn of_reference(reference: &[u8]) -> Option<(Kind, &[u8])> {
    Kind::ALL.into_iter().find_map(|kind| {
      reference
        .strip_prefix(kind.namespace())
        .filter(|name| !name.is_empty())
        .map(|name| (kind, name))
    })
  }
}

/// What a resolved name names (§2.1): an object, by the ID a command names it
/// by, or another name, which makes the name symbolic. A symbolic name's
/// target need not exist.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Target {
  Object(NativeId),
  Name(Kind, Vec<u8>),
}

/// A name's value (§2.1): resolved, naming one target, or conflicted, naming
/// every side two operations moved it to, an absent side being one that
/// deleted it, and the bases they moved from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Value {
  Resolved(Target),
  Conflicted {
    /// The sides, at least two; `None` is absent.
    adds: Vec<Option<Target>>,
    /// The bases, one fewer than the adds.
    removes: Vec<Option<Target>>,
  },
}

/// A name and its value. Every name import derives is resolved; conflicted
/// names come with concurrent operations (§3.3).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Name {
  pub kind: Kind,
  /// The name, without its kind's namespace; its bytes need not be UTF-8.
  pub name: Vec<u8>,
  /// Only a branch is ever local, and import marks none.
  pub local: bool,
  pub value: Value,
}

impl Name {
  /// The one target of a resolved name; `None` for a conflicted one.
  pub fn resolved(&self) -> Option<&Target> {
    match &self.value {
      Value::Resolved(target) => Some(target),
      Value::Conflicted { .. } => None,
    }
  }

  /// Its encoding (§2.2).
  pub fn encode(&self, out: &mut Vec<u8>) {
    out.push(self.kind.code());
    put_bytes(out, &self.name);
    out.push(u8::from(self.local));
    match &self.value {
      Value::Resolved(target) => {
        put_varint(out, 1);
        encode_target(Some(target), out);
      }
      Value::Conflicted { adds, removes } => {
        put_varint(out, adds.len() as u64);
        for target in adds.iter().chain(removes) {
          encode_target(target.as_ref(), out);
        }
      }
    }
  }

  /// A name, held to §2.2's rules.
  pub fn decode(reader: &mut Reader) -> Result<Name, String> {
    let kind = decode_kind(reader)?;
    let name = decode_name(reader)?;
    let local = match reader.u8()? {
      0x00 => false,
      0x01 if kind == Kind::Branch => true,
      0x01 => return Err(format!("the {} {} is marked local, and only a branch can be", kind.word(), shown(&name))),
      flag => return Err(format!("the {} {} has the local mark {flag:02x}", kind.word(), shown(&name))),
    };
    let count = reader.varint()?;
    if count == 0 {
      return Err(format!("the {} {} has no adds", kind.word(), shown(&name)));
    }
    // A conflicted value is a few sides; this bounds what a corrupt count
    // could make a reader allocate.
    if count > reader.remaining() as u64 {
      return Err(format!("the {} {} has more adds than its bytes can hold", kind.word(), shown(&name)));
    }
    let mut adds = Vec::with_capacity(count as usize);
    for _ in 0..count {
      adds.push(decode_target(reader)?);
    }
    let mut removes = Vec::with_capacity(count as usize - 1);
    for _ in 1..count {
      removes.push(decode_target(reader)?);
    }
    let value = if count == 1 {
      match adds.pop().expect("one add") {
        Some(target) => Value::Resolved(target),
        None => return Err(format!("the {} {} names only absent, which is no name", kind.word(), shown(&name))),
      }
    } else {
      if removes.iter().any(|remove| adds.contains(remove)) {
        return Err(format!("the conflicted {} {} is not simplified: a remove equals an add", kind.word(), shown(&name)));
      }
      if adds.iter().all(|add| *add == adds[0]) {
        return Err(format!("the conflicted {} {} is not simplified: every add is one target", kind.word(), shown(&name)));
      }
      Value::Conflicted { adds, removes }
    };
    Ok(Name { kind, name, local, value })
  }
}

/// A name's bytes as a message shows them.
fn shown(name: &[u8]) -> String {
  format!("{:?}", String::from_utf8_lossy(name))
}

fn decode_kind(reader: &mut Reader) -> Result<Kind, String> {
  match reader.u8()? {
    0x01 => Ok(Kind::Branch),
    0x02 => Ok(Kind::Tag),
    0x03 => Ok(Kind::RemoteTracking),
    code => Err(format!("a name has the kind {code:02x}, which is not one")),
  }
}

/// A name's bytes (§2.2): not empty, and holding no `00`.
fn decode_name(reader: &mut Reader) -> Result<Vec<u8>, String> {
  let name = reader.bytes()?;
  if name.is_empty() {
    return Err("a name is empty".into());
  }
  if name.contains(&0) {
    return Err(format!("the name {} holds a 00 byte", shown(name)));
  }
  Ok(name.to_vec())
}

fn encode_target(target: Option<&Target>, out: &mut Vec<u8>) {
  match target {
    None => out.push(0x00),
    Some(Target::Object(id)) => {
      out.push(0x01);
      id.put(out);
    }
    Some(Target::Name(kind, name)) => {
      out.push(0x02);
      out.push(kind.code());
      put_bytes(out, name);
    }
  }
}

fn decode_target(reader: &mut Reader) -> Result<Option<Target>, String> {
  match reader.u8()? {
    0x00 => Ok(None),
    0x01 => Ok(Some(Target::Object(NativeId::read(reader)?))),
    0x02 => {
      let kind = decode_kind(reader)?;
      Ok(Some(Target::Name(kind, decode_name(reader)?)))
    }
    form => Err(format!("a target has the form {form:02x}, which is not one")),
  }
}

/// Whether a snapshot's ref becomes a name on import (§4.1): one in the three
/// namespaces that is direct, or symbolic to another such ref.
pub fn becomes_name(entry: &Ref) -> bool {
  Kind::of_reference(&entry.name).is_some()
    && match &entry.target {
      RefTarget::Direct(_) => true,
      RefTarget::Symbolic(reference) => Kind::of_reference(reference).is_some(),
    }
}

/// The refs a reader resolves revisions through (#423): every resolved name
/// of the current view as the full ref it would be, and every ref of the
/// snapshot that did not become a name, such as `HEAD` and the notes, which
/// stay the snapshot's (§4.1). A name of the view replaces a snapshot-only
/// ref of the same full name. In byte order of name. A conflicted name is
/// no ref: it names no one object.
pub fn refs_of(snapshot: &Snapshot, names: &[Name]) -> Vec<Ref> {
  let mut refs: Vec<Ref> = names
    .iter()
    .filter_map(|name| {
      let target = match name.resolved()? {
        Target::Object(id) => RefTarget::Direct(*id),
        Target::Name(kind, named) => RefTarget::Symbolic(kind.reference(named)),
      };
      Some(Ref { name: name.kind.reference(&name.name), target })
    })
    .collect();
  let held: std::collections::HashSet<Vec<u8>> = names.iter().map(|name| name.kind.reference(&name.name)).collect();
  refs.extend(
    snapshot.refs.iter().filter(|entry| !becomes_name(entry) && !held.contains(&entry.name)).cloned(),
  );
  refs.sort_by(|a, b| a.name.cmp(&b.name));
  refs
}

/// The names an imported snapshot's refs become (§4.1), in a view's order:
/// by kind, then by name in byte order. `native` gives the ID a direct ref's
/// object is named by: a preserved commit's or tag's native form, and
/// otherwise the object itself.
pub fn from_snapshot<E>(
  snapshot: &Snapshot,
  mut native: impl FnMut(&NativeId) -> Result<NativeId, E>,
) -> Result<Vec<Name>, E> {
  let mut names = Vec::new();
  for entry in &snapshot.refs {
    let Some((kind, name)) = Kind::of_reference(&entry.name) else {
      continue;
    };
    let target = match &entry.target {
      RefTarget::Direct(id) => Target::Object(native(id)?),
      RefTarget::Symbolic(reference) => match Kind::of_reference(reference) {
        Some((kind, name)) => Target::Name(kind, name.to_vec()),
        None => continue,
      },
    };
    names.push(Name { kind, name: name.to_vec(), local: false, value: Value::Resolved(target) });
  }
  names.sort_by(|a, b| (a.kind, &a.name).cmp(&(b.kind, &b.name)));
  Ok(names)
}
