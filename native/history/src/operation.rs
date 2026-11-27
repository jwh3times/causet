//! Operations (docs/native-history/operations.md §3): each records one change
//! to a clone's names or facts, who made it and with what command, and the
//! view it leaves, every name and both fact-log chains' heads. An operation
//! belongs to its clone and is never exchanged (ADR-0047, decision 10).

use crate::action::{ActionActor, Time};
use crate::fact::{decode_ids, encode_ids};
use crate::fact_log::Heads;
use crate::names::{Kind, Name, Target};
use causet_store::StoreError;
use causet_store::encoding::{Reader, put_bytes, put_varint};
use causet_store::id::{NativeId, Type};
use causet_store::store::Store;

/// What an operation leaves (§3.1): both chains' heads and every name, in
/// order of kind, then of name in byte order.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct View {
  /// The shared chain's heads, in byte order.
  pub shared: Vec<NativeId>,
  /// The local chain's heads, in byte order.
  pub local: Vec<NativeId>,
  pub names: Vec<Name>,
}

impl View {
  /// The view of nothing: no names, and no fact-log heads.
  pub fn empty() -> View {
    View::default()
  }

  pub fn encode(&self) -> Vec<u8> {
    let mut out = Vec::new();
    self.encode_into(&mut out);
    out
  }

  fn encode_into(&self, out: &mut Vec<u8>) {
    encode_ids(&self.shared, out);
    encode_ids(&self.local, out);
    put_varint(out, self.names.len() as u64);
    for name in &self.names {
      name.encode(out);
    }
  }

  /// A view's body alone, as the contract's merged view is given.
  pub fn decode(body: &[u8]) -> Result<View, String> {
    let mut reader = Reader::new(body);
    let view = View::read(&mut reader)?;
    if !reader.is_empty() {
      return Err("a view has bytes after its names".into());
    }
    Ok(view)
  }

  fn read(reader: &mut Reader) -> Result<View, String> {
    let shared = decode_ids(reader, "shared heads")?;
    let local = decode_ids(reader, "local heads")?;
    let count = reader.varint()?;
    if count > reader.remaining() as u64 {
      return Err("a view has more names than its bytes can hold".into());
    }
    let mut names: Vec<Name> = Vec::with_capacity(count as usize);
    for _ in 0..count {
      let name = Name::decode(reader)?;
      if let Some(last) = names.last()
        && (last.kind, &last.name) >= (name.kind, &name.name)
      {
        return Err("a view's names are out of order, or repeat one".into());
      }
      names.push(name);
    }
    Ok(View { shared, local, names })
  }

  /// Both fact-log chains' heads.
  pub fn heads(&self) -> Heads {
    Heads { shared: self.shared.clone(), local: self.local.clone() }
  }

  /// A name of the view by its kind and name.
  pub fn name(&self, kind: Kind, name: &[u8]) -> Option<&Name> {
    self
      .names
      .binary_search_by(|held| (held.kind, held.name.as_slice()).cmp(&(kind, name)))
      .ok()
      .map(|at| &self.names[at])
  }

  /// The target of a resolved name of the view.
  pub fn resolved(&self, kind: Kind, name: &[u8]) -> Option<&Target> {
    self.name(kind, name).and_then(Name::resolved)
  }

  /// The view with `name` set, replacing one of its kind and name.
  pub fn with(mut self, name: Name) -> View {
    match self.names.binary_search_by(|held| (held.kind, &held.name).cmp(&(name.kind, &name.name))) {
      Ok(at) => self.names[at] = name,
      Err(at) => self.names.insert(at, name),
    }
    self
  }

  /// The view without the name of this kind and name.
  pub fn without(mut self, kind: Kind, name: &[u8]) -> View {
    self.names.retain(|held| !(held.kind == kind && held.name == name));
    self
  }
}

/// The command import's operation records, whatever arguments import was
/// given (§4.2).
pub const IMPORT: &[u8] = b"import";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Operation {
  /// The operations it follows, in byte order; none only for import's into
  /// a new store (§3.1).
  pub parents: Vec<NativeId>,
  /// Who ran it: present exactly when the time is, on every operation a
  /// command runs, and absent on import's.
  pub actor: Option<ActionActor>,
  pub time: Option<Time>,
  /// The command's arguments, after the program's name.
  pub command: Vec<Vec<u8>>,
  pub view: View,
}

impl Operation {
  /// Import's operation (§4.2): no actor and no time, and the command
  /// `import`.
  pub fn import(parents: Vec<NativeId>, view: View) -> Operation {
    Operation { parents, actor: None, time: None, command: vec![IMPORT.to_vec()], view }
  }

  /// Whether this is import's operation, the one kind that may have no
  /// parent (§3.1).
  pub fn is_import(&self) -> bool {
    self.actor.is_none() && self.command == [IMPORT]
  }

  pub fn encode(&self) -> Vec<u8> {
    let mut out = Vec::new();
    encode_ids(&self.parents, &mut out);
    ActionActor::encode_optional(&self.actor, &mut out);
    Time::encode_optional(&self.time, &mut out);
    put_varint(&mut out, self.command.len() as u64);
    for argument in &self.command {
      put_bytes(&mut out, argument);
    }
    self.view.encode_into(&mut out);
    out
  }

  /// A body, held to the rules a body alone can be held to (§2.2, §3.1):
  /// that its heads are entries of their chains, none an ancestor of
  /// another, and that its parents and targets are held, need the store.
  pub fn decode(body: &[u8]) -> Result<Operation, String> {
    let mut reader = Reader::new(body);
    let parents = decode_ids(&mut reader, "parents")?;
    let actor = ActionActor::decode_optional(&mut reader)?;
    let time = Time::decode_optional(&mut reader)?;
    if actor.is_some() != time.is_some() {
      return Err(if actor.is_some() {
        "an operation has an actor and no time".into()
      } else {
        "an operation has a time and no actor".into()
      });
    }
    let count = reader.varint()?;
    if count > reader.remaining() as u64 {
      return Err("an operation has more arguments than its bytes can hold".into());
    }
    let mut command = Vec::with_capacity(count as usize);
    for _ in 0..count {
      command.push(reader.bytes()?.to_vec());
    }
    let view = View::read(&mut reader)?;
    if !reader.is_empty() {
      return Err("an operation has bytes after its view".into());
    }
    Ok(Operation { parents, actor, time, command, view })
  }

  pub fn id(&self) -> NativeId {
    NativeId::of(Type::Operation, &self.encode())
  }

  /// The operation `id`, which the store must hold as one.
  pub fn read(store: &Store, id: &NativeId) -> Result<Operation, StoreError> {
    let object = store.read(id)?;
    if object.kind != Type::Operation {
      return Err(StoreError::Corrupt(format!("{id} is not an operation")));
    }
    Operation::decode(&object.body).map_err(|why| StoreError::Corrupt(format!("the operation {id}: {why}")))
  }
}
