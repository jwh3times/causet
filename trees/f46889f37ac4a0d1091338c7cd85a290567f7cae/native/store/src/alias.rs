//! Alias files (objects.md §9.1): one per Git algorithm, mapping each imported
//! Git object's ID to its native digest's short reference and back, as two
//! sorted tables over the same rows. Resolving a row's short reference to its
//! object is the store's (§1.3).

use crate::encoding::Reader;
use crate::id::{GitAlgorithm, SHA256_TAG, Short};
use causet_model::sha256;

const MAGIC: &[u8; 8] = b"CSTALIAS";
const HEADER: usize = 16;
const FANOUT: usize = 1024;

/// An alias file's rows, by Git digest.
#[derive(Clone, Debug)]
pub struct Aliases {
  pub algorithm: GitAlgorithm,
  /// (Git digest, short reference), in byte order of Git digest.
  rows: Vec<(Vec<u8>, Short)>,
  /// Row numbers in byte order of short reference, then of Git digest.
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
  /// The file of these rows. Rows may come in any order; a Git digest that
  /// repeats is refused. Rows may share a short reference.
  pub fn new(algorithm: GitAlgorithm, mut rows: Vec<(Vec<u8>, Short)>) -> Result<Aliases, String> {
    rows.sort();
    if rows.windows(2).any(|pair| pair[0].0 == pair[1].0) {
      return Err("two alias rows have the same Git ID".into());
    }
    let mut native_order: Vec<u32> = (0..rows.len() as u32).collect();
    native_order.sort_by(|&left, &right| {
      let (left, right) = (&rows[left as usize], &rows[right as usize]);
      (left.1, &left.0).cmp(&(right.1, &right.0))
    });
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

  /// Every row, as (Git digest, short reference), in byte order of Git digest.
  pub fn rows(&self) -> impl Iterator<Item = (&[u8], &Short)> {
    self
      .rows
      .iter()
      .map(|(digest, short)| (digest.as_slice(), short))
  }

  /// The short reference of a Git ID's row, unresolved.
  pub fn short(&self, git_digest: &[u8]) -> Option<Short> {
    self
      .rows
      .binary_search_by(|(digest, _)| digest.as_slice().cmp(git_digest))
      .ok()
      .map(|row| self.rows[row].1)
  }

  /// The Git digests of the rows holding a short reference, which sit
  /// together in the native order, by Git digest.
  pub fn sharing(&self, short: &Short) -> impl Iterator<Item = &[u8]> {
    let start = self
      .native_order
      .partition_point(|&row| self.rows[row as usize].1 < *short);
    self.native_order[start..]
      .iter()
      .map(|&row| &self.rows[row as usize])
      .take_while(move |(_, held)| held == short)
      .map(|(digest, _)| digest.as_slice())
  }

  pub fn encode(&self) -> Vec<u8> {
    let mut out = Vec::with_capacity(
      HEADER + 2 * FANOUT + self.rows.len() * (self.algorithm.length() + 12) + 32,
    );
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&[crate::VERSION, self.algorithm.code(), SHA256_TAG, 0x00]);
    out.extend_from_slice(&(self.rows.len() as u32).to_be_bytes());
    for count in fanout(self.rows.iter().map(|(digest, _)| digest[0])) {
      out.extend_from_slice(&count.to_be_bytes());
    }
    for (digest, short) in &self.rows {
      out.extend_from_slice(digest);
      out.extend_from_slice(short);
    }
    for count in fanout(
      self
        .native_order
        .iter()
        .map(|&row| self.rows[row as usize].1[0]),
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
    if header != [crate::VERSION, expected.code(), SHA256_TAG, 0x00] {
      return Err(format!(
        "its version, algorithms or reserved byte are not version {}'s",
        crate::VERSION
      ));
    }
    let count = reader.u32()? as usize;
    let width = expected.length();
    if body.len() != HEADER + 2 * FANOUT + count * (width + 12) {
      return Err("its length does not match its row count".into());
    }
    let mut git_fanout = [0u32; 256];
    for slot in git_fanout.iter_mut() {
      *slot = reader.u32()?;
    }
    let mut rows = Vec::with_capacity(count);
    for _ in 0..count {
      let digest = reader.take(width)?.to_vec();
      let short: Short = reader.take(8)?.try_into().expect("8 bytes");
      rows.push((digest, short));
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
    if native_order.windows(2).any(|pair| {
      let (left, right) = (&rows[pair[0] as usize], &rows[pair[1] as usize]);
      (left.1, &left.0) >= (right.1, &right.0)
    }) {
      return Err(
        "its native order is not in byte order of short reference, then of Git ID".into(),
      );
    }
    if native_fanout != fanout(native_order.iter().map(|&row| rows[row as usize].1[0])) {
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
  use crate::id::{NativeId, hex, unhex};

  fn row(git: &str, native: &str) -> (Vec<u8>, Short) {
    (unhex(git).unwrap(), NativeId::from_hex(native).unwrap().short())
  }

  #[test]
  fn the_alias_file_is_the_contracts_example() {
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
    assert_eq!(file.len(), 2192);
    assert_eq!(hex(&file[..16]), "435354414c4941530101010000000003");
    let rows = &file[16 + 1024..16 + 1024 + 3 * 28];
    assert_eq!(
      hex(rows),
      "2425d53ec1283e808c60bcaea110ba01aca5a8871ba8e668bdf6a1eb\
       aaa96ced2d9a1c8e72c56b253a0e2fe78393feb7754a90b4c821bcf4\
       ce013625030ba8dba906f756967f9e9ca394464ac32f27e6a5e1d06a"
    );
    let order = &file[file.len() - 32 - 12..file.len() - 32];
    assert_eq!(hex(order), "000000000000000100000002");
    assert_eq!(
      hex(&file[file.len() - 32..]),
      "bcf145c3c3792a7e06e16a49b7593fdf01f517d7c1148161d8f75ba30914d7a0"
    );
    let read = Aliases::decode(&file, GitAlgorithm::Sha1).unwrap();
    let blob = unhex("ce013625030ba8dba906f756967f9e9ca394464a").unwrap();
    let short = read.short(&blob).unwrap();
    assert_eq!(hex(&short), "c32f27e6a5e1d06a");
    assert_eq!(read.sharing(&short).collect::<Vec<_>>(), [blob.as_slice()]);
    assert!(Aliases::decode(&file, GitAlgorithm::Sha256).is_err());
    let mut damaged = file.clone();
    damaged[2000] ^= 1;
    assert!(Aliases::decode(&damaged, GitAlgorithm::Sha1).is_err());
    // Version 0's header, with its trailer made right again.
    let mut earlier = file[..file.len() - 32].to_vec();
    earlier[8] = 0x00;
    let trailer = sha256::digest(&earlier);
    earlier.extend_from_slice(&trailer);
    let refused = Aliases::decode(&earlier, GitAlgorithm::Sha1).unwrap_err();
    assert!(refused.contains("not version 1's"), "{refused}");
  }

  #[test]
  fn rows_sharing_a_short_reference_sit_together_by_git_id() {
    let short = [0x5a; 8];
    let aliases = Aliases::new(
      GitAlgorithm::Sha1,
      vec![
        (vec![0x30; 20], short),
        (vec![0x10; 20], [0x01; 8]),
        (vec![0x20; 20], short),
        (vec![0x40; 20], [0xff; 8]),
      ],
    )
    .unwrap();
    let read = Aliases::decode(&aliases.encode(), GitAlgorithm::Sha1).unwrap();
    assert_eq!(
      read.sharing(&short).collect::<Vec<_>>(),
      [[0x20; 20].as_slice(), [0x30; 20].as_slice()]
    );
    assert_eq!(read.sharing(&[0x02; 8]).count(), 0);
    // A native order that lists two rows sharing a short reference out of
    // Git ID order is refused.
    let mut file = aliases.encode();
    let order = file.len() - 32 - 16;
    file[order..order + 16].copy_from_slice(&[0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 1, 0, 0, 0, 3]);
    let body = file.len() - 32;
    let trailer = sha256::digest(&file[..body]);
    file[body..].copy_from_slice(&trailer);
    let refused = Aliases::decode(&file, GitAlgorithm::Sha1).unwrap_err();
    assert!(refused.contains("then of Git ID"), "{refused}");
  }
}
