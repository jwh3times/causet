//! Deltas (storage.md §5): a large file's new version stored against its
//! previous version, as zstd's patching does it, `zstd --patch-from`, with the
//! base's bytes as a raw-content prefix and the parameters the contract fixes.

use crate::StoreError;
use crate::encoding::{Reader, put_varint};
use crate::id::NativeId;

/// The smallest content a writer stores as a delta (§5.1).
pub const SMALLEST: usize = 1 << 20;
/// The most a base and its content may hold together: zstd's largest window,
/// window log 31, must cover both (§5.1).
pub const TOGETHER: usize = 1 << 31;
/// The deepest a delta may be (§5.2).
pub const DEPTH_LIMIT: usize = 8;
/// Level 15, not the frames' 19: from level 16 zstd's match finders reach only
/// about 2^chainLog bytes back, so a delta past about 30 MB loses its base.
const LEVEL: i32 = 15;
const LARGEST_WINDOW_LOG: u32 = 31;

/// A delta record: the content it is against, the length of the content it
/// produces, and one zstd frame.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Delta {
  pub base: NativeId,
  pub size: u64,
  pub data: Vec<u8>,
}

impl Delta {
  pub fn encode(&self) -> Vec<u8> {
    let mut out = Vec::with_capacity(33 + 10 + self.data.len());
    self.base.put(&mut out);
    put_varint(&mut out, self.size);
    out.extend_from_slice(&self.data);
    out
  }

  pub fn decode(record: &[u8]) -> Result<Delta, String> {
    let mut reader = Reader::new(record);
    let base = NativeId::read(&mut reader)?;
    let size = reader.varint()?;
    let data = reader.rest().to_vec();
    if data.is_empty() {
      return Err("a delta has no zstd frame".into());
    }
    Ok(Delta { base, size, data })
  }
}

/// The smallest window log from 20 to 31 whose window covers `total` bytes.
pub fn window_log(total: usize) -> u32 {
  let mut log = 20;
  while log < LARGEST_WINDOW_LOG && (1usize << log) < total {
    log += 1;
  }
  log
}

/// `content` compressed with `base` as its prefix (§5): level 15,
/// single-threaded, long-distance matching, the content size recorded, no
/// checksum and no dictionary ID. The caller keeps the two within `TOGETHER`.
pub fn compress(base: &[u8], content: &[u8]) -> Result<Vec<u8>, StoreError> {
  use zstd::zstd_safe::{CCtx, CParameter};
  let failed = |code: usize| {
    StoreError::Codec(format!(
      "zstd could not compress a delta: {}",
      zstd::zstd_safe::get_error_name(code)
    ))
  };
  let mut context = CCtx::create();
  for parameter in [
    CParameter::CompressionLevel(LEVEL),
    CParameter::EnableLongDistanceMatching(true),
    CParameter::WindowLog(window_log(base.len() + content.len())),
    CParameter::ContentSizeFlag(true),
    CParameter::ChecksumFlag(false),
    CParameter::DictIdFlag(false),
  ] {
    context.set_parameter(parameter).map_err(failed)?;
  }
  context.ref_prefix(base).map_err(failed)?;
  let mut out = Vec::with_capacity(zstd::zstd_safe::compress_bound(content.len()));
  context.compress2(&mut out, content).map_err(failed)?;
  Ok(out)
}

/// The content a delta's frame produces from its base's bytes: exactly one
/// zstd frame, decompressed with a window log up to 31, of `size` bytes. `Err`
/// says why the frame is corrupt; the caller checks the content's ID.
pub fn decompress(base: &[u8], data: &[u8], size: u64) -> Result<Vec<u8>, StoreError> {
  use zstd::zstd_safe::{DCtx, DParameter};
  let corrupt = |what: String| StoreError::Corrupt(what);
  match zstd::zstd_safe::find_frame_compressed_size(data) {
    Ok(length) if length == data.len() => {}
    _ => return Err(corrupt("its delta is not exactly one zstd frame".into())),
  }
  // The frame records its content's size, so a record that disagrees is
  // refused before anything is allocated for it.
  if !matches!(zstd::zstd_safe::get_frame_content_size(data), Ok(Some(recorded)) if recorded == size) {
    return Err(corrupt(format!(
      "its delta's frame does not record the {size} bytes the delta does"
    )));
  }
  let size = usize::try_from(size)
    .ok()
    .filter(|size| *size <= TOGETHER)
    .ok_or_else(|| {
      StoreError::TooLarge(format!(
        "its delta produces {size} bytes, and this build reads a delta of at most 2 GiB"
      ))
    })?;
  let failed = |code: usize| {
    StoreError::Codec(format!(
      "zstd could not start: {}",
      zstd::zstd_safe::get_error_name(code)
    ))
  };
  let mut context = DCtx::create();
  context
    .set_parameter(DParameter::WindowLogMax(LARGEST_WINDOW_LOG))
    .map_err(failed)?;
  context.ref_prefix(base).map_err(failed)?;
  let mut out = Vec::with_capacity(size);
  context.decompress(&mut out, data).map_err(|code| {
    corrupt(format!(
      "zstd could not decompress its delta: {}",
      zstd::zstd_safe::get_error_name(code)
    ))
  })?;
  if out.len() != size {
    return Err(corrupt(format!(
      "its delta produces {} bytes, not the {size} it records",
      out.len()
    )));
  }
  Ok(out)
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::id::Type;

  fn varied(length: usize, label: u8) -> Vec<u8> {
    let mut out = Vec::with_capacity(length + 32);
    let mut k: u32 = 0;
    while out.len() < length {
      let mut input = vec![label];
      input.extend_from_slice(&k.to_be_bytes());
      out.extend_from_slice(&causet_model::sha256::digest(&input));
      k += 1;
    }
    out.truncate(length);
    out
  }

  #[test]
  fn the_window_log_is_the_smallest_from_20_to_31_that_covers_both() {
    assert_eq!(window_log(0), 20);
    assert_eq!(window_log(1 << 20), 20);
    assert_eq!(window_log((1 << 20) + 1), 21);
    assert_eq!(window_log(3 << 20), 22);
    assert_eq!(window_log(1 << 31), 31);
  }

  #[test]
  fn a_delta_reproduces_its_content_from_its_base_and_only_from_it() {
    let base = varied(300_000, 1);
    let mut content = base.clone();
    content.splice(100_000..100_000, b"an insertion".iter().copied());
    content.truncate(250_000);
    let data = compress(&base, &content).unwrap();
    assert!(data.len() < 1_000, "{} bytes", data.len());
    assert_eq!(decompress(&base, &data, content.len() as u64).unwrap(), content);
    let other = varied(300_000, 2);
    assert!(decompress(&other, &data, content.len() as u64)
      .map_or(true, |wrong| wrong != content));
    assert!(matches!(
      decompress(&base, &data, content.len() as u64 + 1),
      Err(StoreError::Corrupt(_))
    ));
    let mut trailing = data.clone();
    trailing.push(0);
    assert!(matches!(
      decompress(&base, &trailing, content.len() as u64),
      Err(StoreError::Corrupt(_))
    ));
  }

  #[test]
  fn a_delta_finds_its_base_past_30_mb() {
    // Level 19 stores this 64-byte edit as about 6 MB; level 15 as a few KB.
    let mut state: u64 = 0x9e37_79b9_7f4a_7c15;
    let base: Vec<u8> = (0..40_000_000 / 8)
      .flat_map(|_| {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        state.to_le_bytes()
      })
      .collect();
    let mut content = base.clone();
    content[20_000_000..20_000_064].fill(0);
    let data = compress(&base, &content).unwrap();
    assert!(data.len() < 64 * 1024, "{} bytes", data.len());
    assert_eq!(decompress(&base, &data, content.len() as u64).unwrap(), content);
  }

  #[test]
  fn a_delta_record_round_trips_and_needs_a_frame() {
    let delta = Delta {
      base: NativeId::of(Type::Content, b"base"),
      size: 300,
      data: vec![1, 2, 3],
    };
    let record = delta.encode();
    assert_eq!(record.len(), 33 + 2 + 3);
    assert_eq!(Delta::decode(&record).unwrap(), delta);
    assert!(Delta::decode(&record[..35]).is_err());
  }
}
