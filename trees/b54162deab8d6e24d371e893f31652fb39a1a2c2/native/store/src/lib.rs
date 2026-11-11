//! The native content store of N1 (ADR-0045, #297), built to the contract in
//! `docs/native-store/`: IDs, the object types, the chunker, frames and
//! containers, the alias map, the store that writes and reads them, the
//! reconstruction check, and the store's verification.
#![forbid(unsafe_code)]

pub mod alias;
pub mod chunker;
pub mod container;
pub mod encoding;
pub mod id;
pub mod objects;
pub mod reconstruct;
pub mod store;
pub mod verify;

use std::fmt;
use std::path::Path;

/// Why a store operation failed. The command that reports it gives each a
/// published error code.
#[derive(Debug)]
pub enum StoreError {
  /// The store breaks its contract (README, Conventions: "Corrupt").
  Corrupt(String),
  /// No object, or no store, by that name.
  NotFound(String),
  /// The object is known but absent by promise or policy (objects.md §8).
  Absent(String),
  /// The store uses something this build does not read.
  Unsupported(String),
  /// An object or the store is past a bound of the format, or of this build.
  TooLarge(String),
  /// A destination that must be new already exists.
  Exists(String),
  /// The file system refused, with Node's name for the reason.
  Io {
    message: String,
    errno: &'static str,
  },
  Codec(String),
}

impl StoreError {
  pub fn io(path: &Path, error: std::io::Error) -> StoreError {
    let errno = match error.kind() {
      std::io::ErrorKind::NotFound => "ENOENT",
      std::io::ErrorKind::PermissionDenied => "EACCES",
      std::io::ErrorKind::AlreadyExists => "EEXIST",
      _ => "EIO",
    };
    StoreError::Io {
      message: format!("{}: {error}", path.display()),
      errno,
    }
  }

  pub fn message(&self) -> &str {
    match self {
      StoreError::Corrupt(message)
      | StoreError::NotFound(message)
      | StoreError::Absent(message)
      | StoreError::Unsupported(message)
      | StoreError::TooLarge(message)
      | StoreError::Exists(message)
      | StoreError::Codec(message)
      | StoreError::Io { message, .. } => message,
    }
  }
}

impl fmt::Display for StoreError {
  fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
    match self {
      StoreError::Corrupt(message) => write!(f, "the native store is corrupt: {message}"),
      _ => write!(f, "{}", self.message()),
    }
  }
}
