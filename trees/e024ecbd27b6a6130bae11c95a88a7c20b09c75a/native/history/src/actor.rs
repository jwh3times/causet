//! Actors (commits.md §2.2): `causet.provenance/v1`'s `{role, actor}` with
//! the optional `kind` and `for`, as a commit or tag carries its commit-time
//! claim.

use causet_store::encoding::{Reader, put_bytes, put_varint};

/// The `provenanceActors` bound: the most actors one list holds.
pub const MOST: usize = 64;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Role {
  Authored = 1,
  Generated = 2,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
  Human = 1,
  Agent = 2,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Actor {
  pub role: Role,
  pub actor: String,
  /// Absent is unstated, never a claim of either kind.
  pub kind: Option<Kind>,
  /// Who an agent acts for; present only with kind agent.
  pub on_behalf_of: Option<String>,
}

fn text(bytes: &[u8], what: &str) -> Result<String, String> {
  match std::str::from_utf8(bytes) {
    Ok(text) if !text.is_empty() => Ok(text.to_string()),
    Ok(_) => Err(format!("an actor's {what} is empty")),
    Err(_) => Err(format!("an actor's {what} is not UTF-8")),
  }
}

fn optional(reader: &mut Reader) -> Result<Option<u8>, String> {
  match reader.u8()? {
    0x00 => Ok(None),
    0x01 => Ok(Some(reader.u8()?)),
    flag => Err(format!("an optional field has the flag {flag:02x}")),
  }
}

impl Actor {
  fn encode(&self, out: &mut Vec<u8>) {
    out.push(self.role as u8);
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

  fn decode(reader: &mut Reader) -> Result<Actor, String> {
    let role = match reader.u8()? {
      0x01 => Role::Authored,
      0x02 => Role::Generated,
      code => {
        return Err(format!(
          "an actor has the role {code:02x}, which a commit cannot take"
        ));
      }
    };
    let actor = text(reader.bytes()?, "name")?;
    let kind = match optional(reader)? {
      None => None,
      Some(0x01) => Some(Kind::Human),
      Some(0x02) => Some(Kind::Agent),
      Some(code) => {
        return Err(format!(
          "an actor has the kind {code:02x}, which is not one"
        ));
      }
    };
    let on_behalf_of = match reader.u8()? {
      0x00 => None,
      0x01 => Some(text(reader.bytes()?, "principal")?),
      flag => return Err(format!("an optional field has the flag {flag:02x}")),
    };
    if on_behalf_of.is_some() && kind != Some(Kind::Agent) {
      return Err("an actor names who it acts for without being an agent".into());
    }
    Ok(Actor {
      role,
      actor,
      kind,
      on_behalf_of,
    })
  }
}

/// A list of actors: a count, then each in order of role, then of actor in
/// byte order, no two sharing both.
pub fn encode_list(actors: &[Actor], out: &mut Vec<u8>) {
  put_varint(out, actors.len() as u64);
  for actor in actors {
    actor.encode(out);
  }
}

pub fn decode_list(reader: &mut Reader) -> Result<Vec<Actor>, String> {
  let count = reader.varint()?;
  if count > MOST as u64 {
    return Err(format!("a list holds {count} actors, more than {MOST}"));
  }
  let mut actors: Vec<Actor> = Vec::with_capacity(count as usize);
  for _ in 0..count {
    let actor = Actor::decode(reader)?;
    if let Some(last) = actors.last()
      && (last.role, last.actor.as_bytes()) >= (actor.role, actor.actor.as_bytes())
    {
      return Err("a list of actors is out of order, or repeats one".into());
    }
    actors.push(actor);
  }
  Ok(actors)
}
