//! Facts (facts.md §3): a thin binary envelope around one of cst's records
//! in canonical JSON, with native IDs where Git IDs stand in Git, or a
//! parked fact, what import could not take as a record, kept for the bridge.

use crate::action::{ActionActor, present};
use causet_store::StoreError;
use causet_store::encoding::{Reader, put_bytes, put_varint};
use crate::fact_log::Scope;
use causet_store::id::{NativeId, Type};
use causet_store::store::Store;

/// The one family of the local chain (§3.4).
const DISPOSITION_SCHEMA: &str = "causet.disposition/v1";

/// Why a fact is parked (§3.3).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Reason {
  /// A note import cannot read.
  Unreadable = 1,
  /// A record import cannot take.
  Untaken = 2,
  /// A record that gives a fact an earlier record of the same notes tree
  /// gave.
  Repeated = 3,
  /// A disputed copy, under `refs/causet/quarantine/`.
  Disputed = 4,
}

impl Reason {
  fn of(code: u8) -> Result<Reason, String> {
    Ok(match code {
      0x01 => Reason::Unreadable,
      0x02 => Reason::Untaken,
      0x03 => Reason::Repeated,
      0x04 => Reason::Disputed,
      code => return Err(format!("a parked fact has the reason {code:02x}, which is not one")),
    })
  }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Fact {
  /// State `00`: a record.
  Record {
    /// The record's `schema` member, exactly.
    schema: Vec<u8>,
    /// Absent on an imported fact (§3.2).
    actor: Option<ActionActor>,
    /// The native form of the object whose note held the record.
    subject: Option<NativeId>,
    /// Every object the record names, and the subject, each once, in byte
    /// order.
    names: Vec<NativeId>,
    /// The record in canonical JSON, UTF-8, with no line feed after it.
    record: Vec<u8>,
  },
  /// State `01`: a parked fact, which no reader uses.
  Parked {
    reason: Reason,
    /// Where the original held it (§3.3).
    place: Vec<u8>,
    /// The logical ID it carries.
    id: Option<Vec<u8>>,
    /// Byte for byte.
    bytes: Vec<u8>,
  },
}

/// A list of IDs in byte order with none repeated, as every list of native
/// history holds them.
pub(crate) fn decode_ids(reader: &mut Reader, what: &str) -> Result<Vec<NativeId>, String> {
  let count = reader.varint()?;
  let mut ids: Vec<NativeId> = Vec::new();
  for _ in 0..count {
    let id = NativeId::read(reader)?;
    if ids.last().is_some_and(|last| *last >= id) {
      return Err(format!("its {what} are out of order, or repeat one"));
    }
    ids.push(id);
  }
  Ok(ids)
}

pub(crate) fn encode_ids(ids: &[NativeId], out: &mut Vec<u8>) {
  put_varint(out, ids.len() as u64);
  for id in ids {
    id.put(out);
  }
}

impl Fact {
  pub fn encode(&self) -> Vec<u8> {
    let mut out = Vec::new();
    match self {
      Fact::Record { schema, actor, subject, names, record } => {
        out.push(0x00);
        put_bytes(&mut out, schema);
        ActionActor::encode_optional(actor, &mut out);
        match subject {
          Some(subject) => {
            out.push(0x01);
            subject.put(&mut out);
          }
          None => out.push(0x00),
        }
        encode_ids(names, &mut out);
        out.extend_from_slice(record);
      }
      Fact::Parked { reason, place, id, bytes } => {
        out.push(0x01);
        out.push(*reason as u8);
        put_bytes(&mut out, place);
        match id {
          Some(id) => {
            out.push(0x01);
            put_bytes(&mut out, id);
          }
          None => out.push(0x00),
        }
        out.extend_from_slice(bytes);
      }
    }
    out
  }

  /// A body, checked against the rules a body alone can be held to: that a
  /// record is canonical JSON of the schema it names, and that its names are
  /// what it holds, need the record model and the store.
  pub fn decode(body: &[u8]) -> Result<Fact, String> {
    let mut reader = Reader::new(body);
    match reader.u8()? {
      0x00 => {
        let schema = reader.bytes()?.to_vec();
        let actor = ActionActor::decode_optional(&mut reader)?;
        let subject = if present(&mut reader)? { Some(NativeId::read(&mut reader)?) } else { None };
        let names = decode_ids(&mut reader, "names")?;
        if let Some(subject) = &subject
          && !names.contains(subject)
        {
          return Err("its names leave out its subject".into());
        }
        Ok(Fact::Record { schema, actor, subject, names, record: reader.rest().to_vec() })
      }
      0x01 => {
        let reason = Reason::of(reader.u8()?)?;
        let place = reader.bytes()?.to_vec();
        let id = if present(&mut reader)? { Some(reader.bytes()?.to_vec()) } else { None };
        Ok(Fact::Parked { reason, place, id, bytes: reader.rest().to_vec() })
      }
      state => Err(format!("a fact has the state {state:02x}, which is not one")),
    }
  }

  pub fn id(&self) -> NativeId {
    NativeId::of(Type::Fact, &self.encode())
  }

  /// The fact `id` names, read from the store; a body that does not decode
  /// is corrupt.
  pub fn read(store: &Store, id: &NativeId) -> Result<Fact, StoreError> {
    Fact::decode(&store.read(id)?.body).map_err(|why| StoreError::Corrupt(format!("the fact {id}: {why}")))
  }

  /// The chain that records it (§3.4): a disposition and a disputed copy are
  /// the clone's own, and every other fact is shared.
  pub fn scope(&self) -> Scope {
    let local = match self {
      Fact::Record { schema, .. } => {
        causet_model::schemas::canonical_schema(&String::from_utf8_lossy(schema)) == DISPOSITION_SCHEMA
      }
      Fact::Parked { reason, .. } => *reason == Reason::Disputed,
    };
    if local { Scope::Local } else { Scope::Shared }
  }
}
