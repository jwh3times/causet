//! Signatures (commits.md §2.1): who made a commit or tag, and when, in one
//! of three forms, so that every identity line has exactly one encoding.

use causet_store::encoding::{Reader, put_bytes, put_varint};

/// A signature: an identity line held as fields when writing them back gives
/// the line exactly, held verbatim otherwise, or missing.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Signature {
  /// Form `00`. `offset` is in minutes east of UTC.
  Fields {
    name: Vec<u8>,
    email: Vec<u8>,
    time: u64,
    offset: i16,
  },
  /// Form `01`: the identity line's value, exactly.
  Verbatim(Vec<u8>),
  /// Form `02`: no line at all.
  None,
}

/// `09`–`0d` and `20`: what a name may neither begin nor end with.
fn is_name_space(byte: u8) -> bool {
  matches!(byte, 0x09..=0x0d | 0x20)
}

fn fields_allowed(name: &[u8], email: &[u8], offset: i16) -> bool {
  let clean = |bytes: &[u8]| {
    !bytes
      .iter()
      .any(|byte| matches!(byte, b'<' | b'>' | 0x0a | 0x00))
  };
  !name.is_empty()
    && !is_name_space(name[0])
    && !is_name_space(name[name.len() - 1])
    && clean(name)
    && clean(email)
    && (-5999..=5999).contains(&offset)
}

/// The line form `00` writes for these fields.
fn written(name: &[u8], email: &[u8], time: u64, offset: i16) -> Vec<u8> {
  let sign = if offset < 0 { '-' } else { '+' };
  let minutes = offset.unsigned_abs();
  let mut line = Vec::with_capacity(name.len() + email.len() + 24);
  line.extend_from_slice(name);
  line.extend_from_slice(b" <");
  line.extend_from_slice(email);
  line
    .extend_from_slice(format!("> {time} {sign}{:02}{:02}", minutes / 60, minutes % 60).as_bytes());
  line
}

/// The fields a line parses into, when it has the shape form `00` writes:
/// a name, ` <`, an email, `> `, decimal digits, a space, a sign and four
/// digits. Whether they write the line back exactly is the caller's check.
fn parse(line: &[u8]) -> Option<(Vec<u8>, Vec<u8>, u64, i16)> {
  let open = line.iter().position(|&byte| byte == b'<')?;
  let name = line[..open].strip_suffix(b" ")?;
  let close = open + 1 + line[open + 1..].iter().position(|&byte| byte == b'>')?;
  let email = &line[open + 1..close];
  let rest = line[close + 1..].strip_prefix(b" ")?;
  let space = rest.iter().position(|&byte| byte == b' ')?;
  let (digits, zone) = (&rest[..space], &rest[space + 1..]);
  if digits.is_empty() || !digits.iter().all(u8::is_ascii_digit) {
    return None;
  }
  let time: u64 = std::str::from_utf8(digits).ok()?.parse().ok()?;
  let [sign @ (b'+' | b'-'), zone @ ..] = zone else {
    return None;
  };
  if zone.len() != 4 || !zone.iter().all(u8::is_ascii_digit) {
    return None;
  }
  let number = |at: usize| i16::from((zone[at] - b'0') * 10 + (zone[at + 1] - b'0'));
  let minutes = number(0) * 60 + number(2);
  let offset = if *sign == b'-' { -minutes } else { minutes };
  Some((name.to_vec(), email.to_vec(), time, offset))
}

impl Signature {
  /// The one encoding of an identity line's value: its fields when they are
  /// allowed and write the line back exactly, the line verbatim otherwise.
  pub fn from_line(line: &[u8]) -> Signature {
    match parse(line) {
      Some((name, email, time, offset))
        if fields_allowed(&name, &email, offset)
          && written(&name, &email, time, offset) == line =>
      {
        Signature::Fields {
          name,
          email,
          time,
          offset,
        }
      }
      _ => Signature::Verbatim(line.to_vec()),
    }
  }

  /// The identity line's value, as Git holds it; `None` for form `02`.
  pub fn line(&self) -> Option<Vec<u8>> {
    match self {
      Signature::Fields {
        name,
        email,
        time,
        offset,
      } => Some(written(name, email, *time, *offset)),
      Signature::Verbatim(line) => Some(line.clone()),
      Signature::None => None,
    }
  }

  pub fn encode(&self, out: &mut Vec<u8>) {
    match self {
      Signature::Fields {
        name,
        email,
        time,
        offset,
      } => {
        out.push(0x00);
        put_bytes(out, name);
        put_bytes(out, email);
        put_varint(out, *time);
        out.extend_from_slice(&offset.to_be_bytes());
      }
      Signature::Verbatim(line) => {
        out.push(0x01);
        put_bytes(out, line);
      }
      Signature::None => out.push(0x02),
    }
  }

  pub fn decode(reader: &mut Reader) -> Result<Signature, String> {
    match reader.u8()? {
      0x00 => {
        let name = reader.bytes()?.to_vec();
        let email = reader.bytes()?.to_vec();
        let time = reader.varint()?;
        let offset = i16::from_be_bytes(reader.take(2)?.try_into().expect("2 bytes"));
        if !fields_allowed(&name, &email, offset) {
          return Err("a signature's fields break the rules of form 00".into());
        }
        Ok(Signature::Fields {
          name,
          email,
          time,
          offset,
        })
      }
      0x01 => {
        let line = reader.bytes()?.to_vec();
        if line.contains(&0x0a) {
          return Err("a verbatim signature holds a line feed".into());
        }
        match Signature::from_line(&line) {
          Signature::Verbatim(_) => Ok(Signature::Verbatim(line)),
          _ => Err("a verbatim signature holds a line that form 00 writes".into()),
        }
      }
      0x02 => Ok(Signature::None),
      form => Err(format!(
        "a signature has the form {form:02x}, which is not one"
      )),
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn a_line_is_fields_only_when_they_write_it_back_exactly() {
    let fields = Signature::from_line(b"A U Thor <author@example.com> 1112911993 -0700");
    assert_eq!(
      fields,
      Signature::Fields {
        name: b"A U Thor".to_vec(),
        email: b"author@example.com".to_vec(),
        time: 1112911993,
        offset: -420,
      }
    );
    for line in [
      &b"A U Thor <author@example.com> 0123 +0000"[..],
      b"C O Mitter <committer@example.com> 1112911993 +0060",
      b"C O Mitter <committer@example.com> 1112911993 -0000",
      b"<author@example.com> 1112911993 +0000",
      b"A U Thor  <author@example.com> 1112911993 +0000",
    ] {
      assert_eq!(
        Signature::from_line(line),
        Signature::Verbatim(line.to_vec())
      );
    }
  }
}
