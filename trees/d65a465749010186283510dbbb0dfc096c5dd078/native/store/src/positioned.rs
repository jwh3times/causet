//! A store file read by position: each read takes only the bytes it asks
//! for, and the file counts them, so a test can hold a lookup's cost to a
//! bound (#331).

use crate::StoreError;
use std::cell::Cell;
use std::fs::File;
use std::path::{Path, PathBuf};

/// A store file opened for positioned reads.
pub(crate) struct Positioned {
  pub path: PathBuf,
  file: File,
  /// The file's length when it was opened. A store file never changes once
  /// written: an import replaces an alias file by renaming a new one over it.
  pub length: u64,
  read: Cell<u64>,
}

impl Positioned {
  /// The file at `path`, and its length.
  pub fn open(path: &Path) -> Result<Positioned, StoreError> {
    let file = File::open(path).map_err(|error| StoreError::io(path, error))?;
    let length = file.metadata().map_err(|error| StoreError::io(path, error))?.len();
    Ok(Positioned {
      path: path.to_path_buf(),
      file,
      length,
      read: Cell::new(0),
    })
  }

  /// `length` bytes from `offset`, which the caller has placed within the
  /// file.
  pub fn read(&self, offset: u64, length: usize) -> Result<Vec<u8>, StoreError> {
    let mut bytes = vec![0u8; length];
    read_exact_at(&self.file, offset, &mut bytes).map_err(|error| StoreError::io(&self.path, error))?;
    self.read.set(self.read.get() + length as u64);
    Ok(bytes)
  }

  /// A big-endian `u32` from `offset`.
  pub fn u32(&self, offset: u64) -> Result<u32, StoreError> {
    Ok(u32::from_be_bytes(self.read(offset, 4)?.try_into().expect("4 bytes")))
  }

  /// The bytes read so far.
  pub fn bytes_read(&self) -> u64 {
    self.read.get()
  }
}

#[cfg(unix)]
pub(crate) fn read_exact_at(file: &File, offset: u64, bytes: &mut [u8]) -> std::io::Result<()> {
  std::os::unix::fs::FileExt::read_exact_at(file, bytes, offset)
}

#[cfg(windows)]
pub(crate) fn read_exact_at(file: &File, mut offset: u64, mut bytes: &mut [u8]) -> std::io::Result<()> {
  while !bytes.is_empty() {
    match std::os::windows::fs::FileExt::seek_read(file, bytes, offset) {
      Ok(0) => return Err(std::io::ErrorKind::UnexpectedEof.into()),
      Ok(read) => {
        offset += read as u64;
        bytes = &mut bytes[read..];
      }
      Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
      Err(error) => return Err(error),
    }
  }
  Ok(())
}

#[cfg(not(any(unix, windows)))]
pub(crate) fn read_exact_at(mut file: &File, offset: u64, bytes: &mut [u8]) -> std::io::Result<()> {
  use std::io::{Read as _, Seek as _};
  file.seek(std::io::SeekFrom::Start(offset))?;
  file.read_exact(bytes)
}
