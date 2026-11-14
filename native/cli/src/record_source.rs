//! Where the readers of cst's records get them (#415): one source between the
//! commands that read records (`provenance`, `receipts` and `metadata
//! status`/`validate` among them) and the storage that holds the records, so
//! that a native repository can later hand the same containers over from its
//! fact log (ADR-0047, decisions 5-8) without any reader's parsing,
//! validation or formatting changing.
//!
//! The unit is a container of records with what it is attached to. Readers
//! parse and judge its bytes themselves, as `metadata validate` diagnoses a
//! whole container. In a Git-backed repository the containers are the notes
//! of `refs/notes/causet`, or of the legacy ref a repository still uses, read
//! through the engine.

use causet_engine::engine;
use causet_engine::errors::GitResult;
use causet_engine::locations::names;
use causet_engine::types::NoteEntry;
use std::collections::{HashMap, HashSet};

/// One container of records and the object it is attached to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Container {
  /// The object the container is attached to: a commit, in a sound repository.
  pub target: String,
  /// The container's own ID: a note blob's object ID over Git.
  pub id: String,
  /// The container's bytes, or `None` when it is missing or is not a blob.
  pub bytes: Option<Vec<u8>>,
}

/// A source of record containers.
pub trait RecordSource {
  /// Every container, in the source's listing order.
  fn containers(&self) -> GitResult<Vec<Container>>;

  /// The containers attached to any of `objects`, in the source's listing
  /// order.
  fn containers_for(&self, objects: &[String]) -> GitResult<Vec<Container>> {
    let wanted: HashSet<&str> = objects.iter().map(String::as_str).collect();
    Ok(
      self
        .containers()?
        .into_iter()
        .filter(|container| wanted.contains(container.target.as_str()))
        .collect(),
    )
  }
}

/// The notes of a Git-backed repository, read through the engine seam.
pub struct Notes<'a> {
  cwd: &'a str,
}

impl<'a> Notes<'a> {
  /// The notes of the repository at or above `cwd`.
  pub fn at(cwd: &'a str) -> Self {
    Notes { cwd }
  }

  /// `listNoteEntries(cwd)`: the entries of the notes ref the repository
  /// uses, named in full (`refs/notes/causet`), which every engine reads as
  /// it reads the short name.
  fn entries(&self) -> GitResult<Vec<NoteEntry>> {
    engine::list_note_entries(names(self.cwd)?.notes_ref, self.cwd)
  }

  /// One batched read of the entries' note blobs, each blob once.
  fn read(&self, entries: Vec<NoteEntry>) -> GitResult<Vec<Container>> {
    let mut unique: Vec<String> = Vec::new();
    for entry in &entries {
      if !unique.contains(&entry.note) {
        unique.push(entry.note.clone());
      }
    }
    let objects = engine::read_git_objects(&unique, self.cwd)?;
    let blobs: HashMap<String, Option<Vec<u8>>> = unique
      .into_iter()
      .zip(objects.records)
      .map(|(note, object)| {
        let blob = (object.exists && object.kind.as_deref() == Some("blob"))
          .then(|| object.content.unwrap_or_default());
        (note, blob)
      })
      .collect();
    Ok(
      entries
        .into_iter()
        .map(|entry| Container {
          bytes: blobs.get(&entry.note).cloned().flatten(),
          target: entry.target,
          id: entry.note,
        })
        .collect(),
    )
  }
}

impl RecordSource for Notes<'_> {
  fn containers(&self) -> GitResult<Vec<Container>> {
    let entries = self.entries()?;
    self.read(entries)
  }

  /// Lists every note but reads only the asked objects' blobs, and nothing
  /// when no object is asked.
  fn containers_for(&self, objects: &[String]) -> GitResult<Vec<Container>> {
    if objects.is_empty() {
      return Ok(Vec::new());
    }
    let wanted: HashSet<&str> = objects.iter().map(String::as_str).collect();
    let entries: Vec<NoteEntry> = self
      .entries()?
      .into_iter()
      .filter(|entry| wanted.contains(entry.target.as_str()))
      .collect();
    self.read(entries)
  }
}

#[cfg(test)]
pub(crate) mod fake {
  use super::*;

  /// An in-memory source, for the readers' unit tests.
  pub struct Containers(pub Vec<Container>);

  /// A container holding `text`, attached to `target`.
  pub fn container(target: &str, text: &str) -> Container {
    Container {
      target: target.to_string(),
      id: format!("container-of-{target}"),
      bytes: Some(text.as_bytes().to_vec()),
    }
  }

  impl RecordSource for Containers {
    fn containers(&self) -> GitResult<Vec<Container>> {
      Ok(self.0.clone())
    }
  }
}
