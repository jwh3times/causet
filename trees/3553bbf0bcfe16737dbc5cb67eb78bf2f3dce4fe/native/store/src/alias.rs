//! Alias files (objects.md §9.1): one per Git algorithm, mapping each imported
//! Git object's ID to its native ID and back, as two sorted tables over the
//! same rows.

use crate::encoding::Reader;
use crate::id::{GitAlgorithm, NativeId, SHA256_TAG};
use causet_model::sha256;

const MAGIC: &[u8; 8] = b"CSTALIAS";
const HEADER: usize = 16;
const FANOUT: usize = 1024;

/// An alias file's rows, by Git digest.
#[derive(Clone, Debug)]
pub struct Aliases {
  pub algorithm: GitAlgorithm,
  /// (Git digest, native ID), in byte order of Git digest.
  rows: Vec<(Vec<u8>, NativeId)>,
  /// Row numbers in byte order of native digest.
  native_order: Vec<u32>,
}

fn fanout(keys: impl Iterator<Item = u8>) -> [u32; 256] {
  let mut counts = [0u32; 256];
  for first in keys {
    counts[first as usize] += 1;
  }
  let mut total = 0;
  for count in counts.iter_mut() {
    total += *count;
    *count = total;
  }
  counts
}

impl Aliases {
  /// The file of these rows. Rows may come in any order; a Git digest or a
  /// native ID that repeats is refused.
  pub fn new(
    algorithm: GitAlgorithm,
    mut rows: Vec<(Vec<u8>, NativeId)>,
  ) -> Result<Aliases, String> {
    rows.sort();
    if rows.windows(2).any(|pair| pair[0].0 == pair[1].0) {
      return Err("two alias rows have the same Git ID".into());
    }
    let mut native_order: Vec<u32> = (0..rows.len() as u32).collect();
    native_order.sort_by_key(|&row| rows[row as usize].1);
    if native_order
      .windows(2)
      .any(|pair| rows[pair[0] as usize].1 == rows[pair[1] as usize].1)
    {
      return Err("two alias rows have the same native ID".into());
    }
    Ok(Aliases {
      algorithm,
      rows,
      native_order,
    })
  }

  pub fn len(&self) -> usize {
    self.rows.len()
  }

  pub fn is_empty(&self) -> bool {
    self.rows.is_empty()
  }

  pub fn native(&self, git_digest: &[u8]) -> Option<NativeId> {
    self
      .rows
      .binary_search_by(|(digest, _)| digest.as_slice().cmp(git_digest))
      .ok()
      .map(|row| self.rows[row].1)
  }

  pub fn git(&self, native: &NativeId) -> Option<&[u8]> {
    self
      .native_order
      .binary_search_by(|&row| self.rows[row as usize].1.cmp(native))
      .ok()
      .map(|at| self.rows[self.native_order[at] as usize].0.as_slice())
  }

  pub fn encode(&self) -> Vec<u8> {
    let mut out = Vec::with_capacity(
      HEADER + 2 * FANOUT + self.rows.len() * (self.algorithm.length() + 36) + 32,
    );
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&[0x00, self.algorithm.code(), SHA256_TAG, 0x00]);
    out.extend_from_slice(&(self.rows.len() as u32).to_be_bytes());
    for count in fanout(self.rows.iter().map(|(digest, _)| digest[0])) {
      out.extend_from_slice(&count.to_be_bytes());
    }
    for (digest, native) in &self.rows {
      out.extend_from_slice(digest);
      out.extend_from_slice(&native.0);
    }
    for count in fanout(
      self
        .native_order
        .iter()
        .map(|&row| self.rows[row as usize].1.0[0]),
    ) {
      out.extend_from_slice(&count.to_be_bytes());
    }
    for row in &self.native_order {
      out.extend_from_slice(&row.to_be_bytes());
    }
    let trailer = sha256::digest(&out);
    out.extend_from_slice(&trailer);
    out
  }

  /// A file's rows, after every check a reader makes (objects.md §9.1).
  pub fn decode(file: &[u8], expected: GitAlgorithm) -> Result<Aliases, String> {
    if file.len() < HEADER + 2 * FANOUT + 32 {
      return Err("it is too short to be an alias file".into());
    }
    let (body, trailer) = file.split_at(file.len() - 32);
    if sha256::digest(body) != trailer {
      return Err("its trailer does not match its bytes".into());
    }
    let mut reader = Reader::new(body);
    if reader.take(8)? != MAGIC {
      return Err("it does not begin with the alias file's magic".into());
    }
    let header = reader.take(4)?;
    if header != [0x00, expected.code(), SHA256_TAG, 0x00] {
      return Err("its version, algorithms or reserved byte are not version 0's".into());
    }
    let count = reader.u32()? as usize;
    let width = expected.length();
    if body.len() != HEADER + 2 * FANOUT + count * (width + 36) {
      return Err("its length does not match its row count".into());
    }
    let mut git_fanout = [0u32; 256];
    for slot in git_fanout.iter_mut() {
      *slot = reader.u32()?;
    }
    let mut rows = Vec::with_capacity(count);
    for _ in 0..count {
      let digest = reader.take(width)?.to_vec();
      let native = NativeId(reader.take(32)?.try_into().expect("32 bytes"));
      rows.push((digest, native));
    }
    let mut native_fanout = [0u32; 256];
    for slot in native_fanout.iter_mut() {
      *slot = reader.u32()?;
    }
    let mut native_order = Vec::with_capacity(count);
    for _ in 0..count {
      native_order.push(reader.u32()?);
    }
    if rows.windows(2).any(|pair| pair[0].0 >= pair[1].0) {
      return Err("its rows are not in byte order of Git ID, or repeat one".into());
    }
    if git_fanout != fanout(rows.iter().map(|(digest, _)| digest[0])) {
      return Err("its Git fan-out does not count its rows".into());
    }
    let mut seen = vec![false; count];
    for &row in &native_order {
      let row = row as usize;
      if row >= count || seen[row] {
        return Err("its native order does not list every row once".into());
      }
      seen[row] = true;
    }
    if native_order
      .windows(2)
      .any(|pair| rows[pair[0] as usize].1 >= rows[pair[1] as usize].1)
    {
      return Err("its native order is not in byte order of native ID, or repeats one".into());
    }
    if native_fanout != fanout(native_order.iter().map(|&row| rows[row as usize].1.0[0])) {
      return Err("its native fan-out does not count its rows".into());
    }
    Ok(Aliases {
      algorithm: expected,
      rows,
      native_order,
    })
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::id::{hex, unhex};

  #[test]
  fn the_alias_file_is_the_contracts_example() {
    let row = |git: &str, native: &str| (unhex(git).unwrap(), NativeId::from_hex(native).unwrap());
    let aliases = Aliases::new(
      GitAlgorithm::Sha1,
      vec![
        row(
          "ce013625030ba8dba906f756967f9e9ca394464a",
          "c32f27e6a5e1d06a6c75540b1410f868f228ace6b7dcc3b3f1834c6dce1b1988",
        ),
        row(
          "2425d53ec1283e808c60bcaea110ba01aca5a887",
          "1ba8e668bdf6a1eb2a9393f5f658625f1f3ca733b6dc6648df2d62977c32ef96",
        ),
        row(
          "aaa96ced2d9a1c8e72c56b253a0e2fe78393feb7",
          "754a90b4c821bcf47f6441bdbed3bfe8eae725f9f72f50beafebf4c2b603680a",
        ),
      ],
    )
    .unwrap();
    let file = aliases.encode();
    assert_eq!(file.len(), 2264);
    assert_eq!(hex(&file[..16]), "435354414c4941530001010000000003");
    assert_eq!(
      hex(&file[file.len() - 32..]),
      "62f89a20ce576032d48bb7f8e7ef7679f0ed664be4709f2f48c25049e146ffb9"
    );
    let read = Aliases::decode(&file, GitAlgorithm::Sha1).unwrap();
    let blob = unhex("ce013625030ba8dba906f756967f9e9ca394464a").unwrap();
    let native = read.native(&blob).unwrap();
    assert_eq!(
      native.hex(),
      "c32f27e6a5e1d06a6c75540b1410f868f228ace6b7dcc3b3f1834c6dce1b1988"
    );
    assert_eq!(read.git(&native), Some(blob.as_slice()));
    assert!(Aliases::decode(&file, GitAlgorithm::Sha256).is_err());
    let mut damaged = file.clone();
    damaged[2000] ^= 1;
    assert!(Aliases::decode(&damaged, GitAlgorithm::Sha1).is_err());
  }
}
