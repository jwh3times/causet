//! What facts, fact-log entries and operations share (facts.md §2): an
//! action's actor, who did something, and when it was done.

use crate::actor::Kind;
use causet_store::encoding::{Reader, put_bytes, put_varint};

/// An action's actor (§2.1): commits.md §2.2's actor without its role, since
/// recording a fact or running a command takes none.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ActionActor {
  pub actor: String,
  /// Absent is unstated, never a claim of either kind.
  pub kind: Option<Kind>,
  /// Who an agent acts for; present only with kind agent.
  pub on_behalf_of: Option<String>,
}

/// When an action happened (§2.2): a form `00` signature's time and offset.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Time {
  /// Seconds since 1970-01-01T00:00:00Z.
  pub seconds: u64,
  /// Minutes east of UTC.
  pub offset: i16,
}

fn text(bytes: &[u8], what: &str) -> Result<String, String> {
  match std::str::from_utf8(bytes) {
    Ok(text) if !text.is_empty() => Ok(text.to_string()),
    Ok(_) => Err(format!("an action's {what} is empty")),
    Err(_) => Err(format!("an action's {what} is not UTF-8")),
  }
}

/// An `optional X`'s presence flag (README, Conventions).
pub(crate) fn present(reader: &mut Reader) -> Result<bool, String> {
  match reader.u8()? {
    0x00 => Ok(false),
    0x01 => Ok(true),
    flag => Err(format!("an optional field has the flag {flag:02x}")),
  }
}

impl ActionActor {
  pub fn encode(&self, out: &mut Vec<u8>) {
    put_bytes(out, self.actor.as_bytes());
    match self.kind {
      Some(kind) => out.extend_from_slice(&[0x01, kind as u8]),
      None => out.push(0x00),
    }
    match &self.on_behalf_of {
      Some(principal) => {
        out.push(0x01);
        put_bytes(out, principal.as_bytes());
      }
      None => out.push(0x00),
    }
  }

  pub fn decode(reader: &mut Reader) -> Result<ActionActor, String> {
    let actor = text(reader.bytes()?, "actor")?;
    let kind = if present(reader)? {
      match reader.u8()? {
        0x01 => Some(Kind::Human),
        0x02 => Some(Kind::Agent),
        code => return Err(format!("an action's actor has the kind {code:02x}, which is not one")),
      }
    } else {
      None
    };
    let on_behalf_of = if present(reader)? {
      Some(text(reader.bytes()?, "principal")?)
    } else {
      None
    };
    if on_behalf_of.is_some() && kind != Some(Kind::Agent) {
      return Err("an action's actor names who it acts for without being an agent".into());
    }
    Ok(ActionActor { actor, kind, on_behalf_of })
  }

  /// An `optional actor`.
  pub fn encode_optional(actor: &Option<ActionActor>, out: &mut Vec<u8>) {
    match actor {
      Some(actor) => {
        out.push(0x01);
        actor.encode(out);
      }
      None => out.push(0x00),
    }
  }

  pub fn decode_optional(reader: &mut Reader) -> Result<Option<ActionActor>, String> {
    Ok(if present(reader)? { Some(ActionActor::decode(reader)?) } else { None })
  }
}

impl Time {
  /// An `optional time`.
  pub fn encode_optional(time: &Option<Time>, out: &mut Vec<u8>) {
    match time {
      Some(time) => {
        out.push(0x01);
        put_varint(out, time.seconds);
        out.extend_from_slice(&time.offset.to_be_bytes());
      }
      None => out.push(0x00),
    }
  }

  pub fn decode_optional(reader: &mut Reader) -> Result<Option<Time>, String> {
    if !present(reader)? {
      return Ok(None);
    }
    let seconds = reader.varint()?;
    let offset = i16::from_be_bytes(reader.take(2)?.try_into().expect("2 bytes"));
    // A form 00 signature's rule (commits.md §2.1): at most 99 hours and
    // 59 minutes either way.
    if !(-5999..=5999).contains(&offset) {
      return Err(format!("a time has the offset {offset}, outside ±99:59"));
    }
    Ok(Some(Time { seconds, offset }))
  }
}
