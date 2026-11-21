//! Names (docs/native-history/operations.md §2): branches, tags and
//! remote-tracking names, and which refs of an imported snapshot become them
//! (§4.1, ADR-0047 decision 9). Every other ref stays in the snapshot for the
//! bridge, and is never shown as a name.

use causet_store::id::NativeId;
use causet_store::objects::{RefTarget, Snapshot};

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

/// A name and its value. Every name import derives is resolved; conflicted
/// names come with concurrent operations (§3.3).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Name {
  pub kind: Kind,
  /// The name, without its kind's namespace; its bytes need not be UTF-8.
  pub name: Vec<u8>,
  /// Only a branch is ever local, and import marks none.
  pub local: bool,
  pub target: Target,
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
    names.push(Name { kind, name: name.to_vec(), local: false, target });
  }
  names.sort_by(|a, b| (a.kind, &a.name).cmp(&(b.kind, &b.name)));
  Ok(names)
}
