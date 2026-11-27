//! The operation heads' files (objects.md §10; native history's
//! operations.md §3.2): `.cst/op-heads/` holds one empty file for each
//! operation head, named by its ID in 64 lowercase hex digits. It is the only
//! mutable thing native history has, and no writer locks it: each adds its
//! own head, created exclusively, and removes its parents'. What an
//! operation is, and which heads are current, is native history's.

use crate::StoreError;
use crate::id::NativeId;
use std::path::{Path, PathBuf};

/// The directory's name under `.cst/`.
pub const DIRECTORY: &str = "op-heads";

/// The heads directory of a store directory: `.cst/`, or `.cst-import/`
/// while a new store is written.
pub fn directory(store: &Path) -> PathBuf {
  store.join(DIRECTORY)
}

/// The heads a store directory holds, in byte order, and the names in it
/// that are not a head's, for `cst fsck` to report. `None` when there is no
/// heads directory: a store this build's import did not write.
pub fn list(store: &Path) -> Result<Option<(Vec<NativeId>, Vec<String>)>, StoreError> {
  let directory = directory(store);
  let entries = match std::fs::read_dir(&directory) {
    Ok(entries) => entries,
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
    Err(error) => return Err(StoreError::io(&directory, error)),
  };
  let mut heads = Vec::new();
  let mut strays = Vec::new();
  for entry in entries {
    let entry = entry.map_err(|error| StoreError::io(&directory, error))?;
    let name = entry.file_name().to_string_lossy().into_owned();
    // 64 hex digits, lowercase: `from_hex` takes either case.
    match NativeId::from_hex(&name).filter(|_| name == name.to_lowercase()) {
      Some(id) => heads.push(id),
      None => strays.push(name),
    }
  }
  heads.sort();
  strays.sort();
  Ok(Some((heads, strays)))
}

/// Adds the head file of `id`, created exclusively, making the directory
/// when it is the first. One already there is the same head, written by an
/// identical operation, and is not an error.
pub fn add(store: &Path, id: &NativeId) -> Result<(), StoreError> {
  let directory = directory(store);
  match std::fs::create_dir(&directory) {
    Ok(()) => {}
    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
    Err(error) => return Err(StoreError::io(&directory, error)),
  }
  let file = directory.join(id.hex());
  let created = std::fs::OpenOptions::new().write(true).create_new(true).open(&file);
  match created {
    Ok(handle) => handle.sync_all().map_err(|error| StoreError::io(&file, error))?,
    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
    Err(error) => return Err(StoreError::io(&file, error)),
  }
  crate::store::sync_directory(&directory);
  Ok(())
}

/// Removes the head files of `ids`, an operation's parents once its own is
/// added. One already gone is not an error: a concurrent writer that
/// started from the same head removed it.
pub fn remove(store: &Path, ids: &[NativeId]) -> Result<(), StoreError> {
  let directory = directory(store);
  for id in ids {
    let file = directory.join(id.hex());
    match std::fs::remove_file(&file) {
      Ok(()) => {}
      Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
      Err(error) => return Err(StoreError::io(&file, error)),
    }
  }
  crate::store::sync_directory(&directory);
  Ok(())
}
