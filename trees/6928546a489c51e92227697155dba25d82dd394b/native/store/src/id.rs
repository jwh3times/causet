//! Native IDs and Git IDs (objects.md §1), and the identity input a native ID
//! is the digest of (§2).

use crate::encoding::Reader;
use causet_model::sha256::Sha256;
use std::fmt;

/// The algorithm tag of every native ID version 1 writes: SHA-256.
pub const SHA256_TAG: u8 = 0x01;

/// What an object is, by its type code (objects.md §2).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Type {
  Content = 1,
  Tree = 2,
  Preserved = 3,
  Snapshot = 4,
  Annotation = 5,
}

impl Type {
  pub fn from_code(code: u8) -> Option<Type> {
    Some(match code {
      1 => Type::Content,
      2 => Type::Tree,
      3 => Type::Preserved,
      4 => Type::Snapshot,
      5 => Type::Annotation,
      _ => return None,
    })
  }

  pub fn code(self) -> u8 {
    self as u8
  }
}

/// A native ID: the SHA-256 digest of an object's identity input. Its tag is
/// implied, since version 1 knows one algorithm.
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct NativeId(pub [u8; 32]);

impl NativeId {
  /// The ID of an object of type `kind` with this body.
  pub fn of(kind: Type, body: &[u8]) -> NativeId {
    let mut hasher = Sha256::new();
    hasher.update(b"cst");
    hasher.update(&[kind.code()]);
    hasher.update(body);
    NativeId(hasher.finish())
  }

  /// The text form: 64 lowercase hex digits, without the tag.
  pub fn hex(&self) -> String {
    hex(&self.0)
  }

  pub fn from_hex(text: &str) -> Option<NativeId> {
    let bytes = unhex(text)?;
    Some(NativeId(bytes.try_into().ok()?))
  }

  /// The binary form: the tag, then the digest.
  pub fn put(&self, out: &mut Vec<u8>) {
    out.push(SHA256_TAG);
    out.extend_from_slice(&self.0);
  }

  pub fn read(reader: &mut Reader) -> Result<NativeId, String> {
    let tag = reader.u8()?;
    if tag != SHA256_TAG {
      return Err(format!(
        "a native ID has the algorithm tag {tag:02x}, which this build does not know"
      ));
    }
    Ok(NativeId(reader.take(32)?.try_into().expect("32 bytes")))
  }
}

impl fmt::Debug for NativeId {
  fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
    write!(f, "{}", self.hex())
  }
}

impl fmt::Display for NativeId {
  fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
    write!(f, "{}", self.hex())
  }
}

/// A Git hash algorithm, by its code in the store (objects.md §1.2).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum GitAlgorithm {
  Sha1 = 1,
  Sha256 = 2,
}

impl GitAlgorithm {
  pub fn from_code(code: u8) -> Option<GitAlgorithm> {
    match code {
      1 => Some(GitAlgorithm::Sha1),
      2 => Some(GitAlgorithm::Sha256),
      _ => None,
    }
  }

  /// The name `git rev-parse --show-object-format` prints, which is also the
  /// alias file's name.
  pub fn from_name(name: &str) -> Option<GitAlgorithm> {
    match name {
      "sha1" => Some(GitAlgorithm::Sha1),
      "sha256" => Some(GitAlgorithm::Sha256),
      _ => None,
    }
  }

  pub fn code(self) -> u8 {
    self as u8
  }

  pub fn name(self) -> &'static str {
    match self {
      GitAlgorithm::Sha1 => "sha1",
      GitAlgorithm::Sha256 => "sha256",
    }
  }

  /// G, the digest's length in bytes.
  pub fn length(self) -> usize {
    match self {
      GitAlgorithm::Sha1 => 20,
      GitAlgorithm::Sha256 => 32,
    }
  }
}

/// A Git object ID with its algorithm.
#[derive(Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct GitId {
  pub algorithm: u8,
  pub digest: Vec<u8>,
}

impl GitId {
  pub fn new(algorithm: GitAlgorithm, digest: Vec<u8>) -> GitId {
    debug_assert_eq!(digest.len(), algorithm.length());
    GitId {
      algorithm: algorithm.code(),
      digest,
    }
  }

  pub fn algorithm(&self) -> GitAlgorithm {
    GitAlgorithm::from_code(self.algorithm).expect("a known Git algorithm")
  }

  pub fn hex(&self) -> String {
    hex(&self.digest)
  }

  pub fn put(&self, out: &mut Vec<u8>) {
    out.push(self.algorithm);
    out.extend_from_slice(&self.digest);
  }

  pub fn read(reader: &mut Reader) -> Result<GitId, String> {
    let code = reader.u8()?;
    let algorithm = GitAlgorithm::from_code(code)
      .ok_or_else(|| format!("a Git ID has the algorithm code {code:02x}, which is reserved"))?;
    Ok(GitId::new(
      algorithm,
      reader.take(algorithm.length())?.to_vec(),
    ))
  }
}

impl fmt::Debug for GitId {
  fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
    write!(f, "{}", self.hex())
  }
}

pub fn hex(bytes: &[u8]) -> String {
  bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Lowercase or uppercase hex of an even length.
pub fn unhex(text: &str) -> Option<Vec<u8>> {
  if text.len() % 2 != 0 || !text.bytes().all(|byte| byte.is_ascii_hexdigit()) {
    return None;
  }
  (0..text.len())
    .step_by(2)
    .map(|at| u8::from_str_radix(&text[at..at + 2], 16).ok())
    .collect()
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn content_ids_are_the_contracts_examples() {
    assert_eq!(
      NativeId::of(Type::Content, b"").hex(),
      "47db763a1ed5dfde5b8218a3ee71dcdd2eed02f49702781ab7ea1927b053060a"
    );
    assert_eq!(
      NativeId::of(Type::Content, b"hello\n").hex(),
      "c32f27e6a5e1d06a6c75540b1410f868f228ace6b7dcc3b3f1834c6dce1b1988"
    );
  }

  #[test]
  fn an_unknown_algorithm_tag_is_refused() {
    let mut bytes = vec![0x02];
    bytes.extend_from_slice(&[0; 32]);
    assert!(NativeId::read(&mut Reader::new(&bytes)).is_err());
    assert!(GitId::read(&mut Reader::new(&[0x03; 33])).is_err());
  }
}
