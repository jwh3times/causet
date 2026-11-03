//! The contract's shared encodings (`docs/native-store/README.md`,
//! Conventions): big-endian fixed-width integers, minimal LEB128 varints, and
//! length-prefixed byte strings, with a reader that refuses anything else.

pub fn put_varint(out: &mut Vec<u8>, mut value: u64) {
  loop {
    let low = (value & 0x7f) as u8;
    value >>= 7;
    if value == 0 {
      out.push(low);
      return;
    }
    out.push(low | 0x80);
  }
}

pub fn put_bytes(out: &mut Vec<u8>, bytes: &[u8]) {
  put_varint(out, bytes.len() as u64);
  out.extend_from_slice(bytes);
}

/// Reads one encoding after another from a byte string. Every failure says
/// what was wrong, for the caller to name the object or file it came from.
pub struct Reader<'a> {
  data: &'a [u8],
  at: usize,
}

impl<'a> Reader<'a> {
  pub fn new(data: &'a [u8]) -> Self {
    Self { data, at: 0 }
  }

  pub fn is_empty(&self) -> bool {
    self.at == self.data.len()
  }

  pub fn rest(&mut self) -> &'a [u8] {
    let rest = &self.data[self.at..];
    self.at = self.data.len();
    rest
  }

  pub fn take(&mut self, length: usize) -> Result<&'a [u8], String> {
    if self.data.len() - self.at < length {
      return Err(format!(
        "it ends {} bytes early",
        length - (self.data.len() - self.at)
      ));
    }
    let taken = &self.data[self.at..self.at + length];
    self.at += length;
    Ok(taken)
  }

  pub fn u8(&mut self) -> Result<u8, String> {
    Ok(self.take(1)?[0])
  }

  pub fn u32(&mut self) -> Result<u32, String> {
    Ok(u32::from_be_bytes(
      self.take(4)?.try_into().expect("4 bytes"),
    ))
  }

  pub fn u64(&mut self) -> Result<u64, String> {
    Ok(u64::from_be_bytes(
      self.take(8)?.try_into().expect("8 bytes"),
    ))
  }

  /// A minimal varint of at most 64 bits.
  pub fn varint(&mut self) -> Result<u64, String> {
    let mut value: u64 = 0;
    for index in 0..10 {
      let byte = self.u8()?;
      if index == 9 && byte != 0x01 {
        return Err("a varint does not fit in 64 bits".into());
      }
      value |= u64::from(byte & 0x7f) << (7 * index);
      if byte & 0x80 == 0 {
        if byte == 0 && index > 0 {
          return Err("a varint is not minimal".into());
        }
        return Ok(value);
      }
    }
    Err("a varint does not fit in 64 bits".into())
  }

  pub fn bytes(&mut self) -> Result<&'a [u8], String> {
    let length = self.varint()?;
    let length =
      usize::try_from(length).map_err(|_| "a length does not fit in memory".to_string())?;
    self.take(length)
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn varints_are_the_contracts_examples() {
    for (value, encoded) in [
      (0u64, vec![0x00]),
      (127, vec![0x7f]),
      (128, vec![0x80, 0x01]),
      (300, vec![0xac, 0x02]),
      (
        u64::MAX,
        vec![0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01],
      ),
    ] {
      let mut out = Vec::new();
      put_varint(&mut out, value);
      assert_eq!(out, encoded);
      let mut reader = Reader::new(&encoded);
      assert_eq!(reader.varint(), Ok(value));
      assert!(reader.is_empty());
    }
  }

  #[test]
  fn a_varint_that_is_not_minimal_or_too_wide_is_refused() {
    assert!(Reader::new(&[0x80, 0x00]).varint().is_err());
    assert!(
      Reader::new(&[0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x02])
        .varint()
        .is_err()
    );
    assert!(Reader::new(&[0x80]).varint().is_err());
  }
}
