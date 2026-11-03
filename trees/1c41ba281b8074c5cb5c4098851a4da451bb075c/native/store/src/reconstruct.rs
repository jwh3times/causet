//! The reconstruction check (objects.md §9.2; ADR-0044, item 4): each alias
//! row's short reference is resolved, and its native object, rebuilt in Git's
//! encoding for the row's algorithm, must hash to the row's Git ID, which the
//! row holds whole, and every object the store holds from Git must have a
//! row. It reads the store and its alias files alone, runs no Git, and writes
//! nothing.

use crate::StoreError;
use crate::container::Form;
use crate::id::{GitAlgorithm, GitId, NativeId, Type, hex};
use crate::objects::{Preserved, Target, Tree};
use crate::store::Store;
use causet_model::sha256::Sha256;
use sha1_checked::Digest as _;
use std::collections::{HashMap, HashSet};
use std::fmt;

/// The rows that rebuilt, by Git type.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Rebuilt {
  pub blobs: usize,
  pub trees: usize,
  pub commits: usize,
  pub tags: usize,
}

/// An object that fails the check, and why: a row that does not rebuild to
/// its Git ID (`native` is `None` when its short reference resolves to no
/// one object), or an object the store holds that should have a row and has
/// none (`git` is then `None`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Failure {
  pub git: Option<GitId>,
  pub native: Option<NativeId>,
  pub why: String,
}

impl fmt::Display for Failure {
  fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
    match (&self.git, &self.native) {
      (Some(git), Some(native)) => write!(
        f,
        "{} {} (native {native}): {}",
        git.algorithm().name(),
        git.hex(),
        self.why
      ),
      (Some(git), None) => write!(f, "{} {}: {}", git.algorithm().name(), git.hex(), self.why),
      (None, Some(native)) => write!(f, "native {native}: {}", self.why),
      (None, None) => write!(f, "{}", self.why),
    }
  }
}

/// What the check found: every row is either rebuilt or failed.
#[derive(Clone, Debug, Default)]
pub struct Reconstruction {
  pub rows: usize,
  pub rebuilt: Rebuilt,
  pub failures: Vec<Failure>,
}

/// Runs the check on every row of every alias file, then requires a row for
/// every object the store holds that the import read from Git. A store that
/// cannot be opened to its rows, or whose snapshot names an object with no
/// row, fails as a whole; an object that fails is a `Failure`, and the rest
/// are still checked.
pub fn check(store: &Store) -> Result<Reconstruction, StoreError> {
  store.refs()?;
  let held = store.present();
  // Rows are read in storage order, so each frame is decompressed about
  // once rather than once per row.
  let order: HashMap<NativeId, usize> = held
    .iter()
    .enumerate()
    .map(|(at, (id, _, _))| (*id, at))
    .collect();
  let mut found = Reconstruction::default();
  for aliases in store.aliases() {
    let algorithm = aliases.algorithm;
    let mut rows: Vec<(&[u8], Result<NativeId, String>)> = aliases
      .rows()
      .map(|(digest, short)| {
        let native = store
          .resolve_row(algorithm, digest, short)
          .map_err(|unresolved| format!("it {}", unresolved.why()));
        (digest, native)
      })
      .collect();
    rows.sort_by_key(|(_, native)| {
      native
        .as_ref()
        .ok()
        .and_then(|native| order.get(native).copied())
        .unwrap_or(usize::MAX)
    });
    for (digest, native) in rows {
      found.rows += 1;
      let rebuilt = native.clone().and_then(|native| {
        let (kind, payload) = rebuild(store, algorithm, &native)?;
        let id = git_id(algorithm, kind, &payload)?;
        if id != digest {
          return Err(format!("it rebuilds to {}", hex(&id)));
        }
        Ok(kind)
      });
      match rebuilt {
        Ok("blob") => found.rebuilt.blobs += 1,
        Ok("tree") => found.rebuilt.trees += 1,
        Ok("commit") => found.rebuilt.commits += 1,
        Ok(_) => found.rebuilt.tags += 1,
        Err(why) => found.failures.push(Failure {
          git: Some(GitId::new(algorithm, digest.to_vec())),
          native: native.ok(),
          why,
        }),
      }
    }
  }
  unaliased(store, &held, &mut found.failures);
  Ok(found)
}

/// Every tree and preserved object the store holds came from Git, and so did
/// all its content but the chunks of other content (objects.md §3.3): each
/// must have a row (§9.2). A row lost from the alias file is found here even
/// when nothing that has a row names its object.
fn unaliased(store: &Store, held: &[(NativeId, Type, Form)], failures: &mut Vec<Failure>) {
  let mut chunks = HashSet::new();
  for (id, _, form) in held {
    if *form == Form::ChunkList {
      match store.chunk_list(id) {
        Ok(list) => chunks.extend(list.chunks.into_iter().map(|(chunk, _)| chunk)),
        Err(error) => failures.push(Failure {
          git: None,
          native: Some(*id),
          why: error.message().to_string(),
        }),
      }
    }
  }
  for (id, kind, _) in held {
    if store
      .aliases()
      .iter()
      .any(|aliases| store.git(aliases.algorithm, id).is_some())
    {
      continue;
    }
    let why = match kind {
      Type::Tree => "it is a tree, which has no alias row",
      Type::Preserved => "it is a preserved Git object, which has no alias row",
      Type::Content if !chunks.contains(id) => {
        "it is content no chunk list names, which has no alias row"
      }
      _ => continue,
    };
    failures.push(Failure {
      git: None,
      native: Some(*id),
      why: why.into(),
    });
  }
}

/// A native object in Git's encoding for an alias file's algorithm: its Git
/// type and the payload after Git's header, once every object it names that
/// Git's parser follows is found to have a row.
fn rebuild(
  store: &Store,
  algorithm: GitAlgorithm,
  native: &NativeId,
) -> Result<(&'static str, Vec<u8>), String> {
  let object = store
    .read_known(native)
    .map_err(|error| error.message().to_string())?;
  let named = algorithm.name();
  match object.kind {
    Type::Content => Ok(("blob", object.body)),
    Type::Tree => {
      let tree = Tree::decode(&object.body)?;
      for entry in &tree.entries {
        let name = String::from_utf8_lossy(&entry.name);
        match &entry.target {
          Target::Native(id) if store.git(algorithm, id).is_none() => {
            return Err(format!(
              "its entry {name} names {id}, which has no {named} alias row"
            ));
          }
          Target::Git(id) if id.algorithm() != algorithm => {
            return Err(format!(
              "its submodule link {name} is a {} Git ID, not {named}",
              id.algorithm().name()
            ));
          }
          _ => {}
        }
      }
      let encoding = tree
        .git_encoding(&|id| store.git(algorithm, id))
        .expect("every native target has a row");
      Ok(("tree", encoding))
    }
    Type::Preserved => {
      let preserved = Preserved::decode(&object.body)?;
      if preserved.algorithm != algorithm {
        return Err(format!(
          "it is a preserved {} object, in the {named} alias file",
          preserved.algorithm.name()
        ));
      }
      // Every object the import read from Git has a row (§9.2), so one a
      // commit or tag is built on does too.
      if let Some(missing) = preserved
        .named()
        .into_iter()
        .find(|digest| store.native(algorithm, digest).is_none())
      {
        return Err(format!(
          "it names {named} {}, which has no alias row",
          hex(&missing)
        ));
      }
      Ok((preserved.kind.name(), preserved.payload))
    }
    Type::Snapshot => Err("it is a ref snapshot, which no Git object becomes".into()),
    Type::Annotation => Err("it is an annotation, which no Git object becomes".into()),
  }
}

/// A native object's Git ID in an algorithm, from its Git encoding alone:
/// what a candidate for a shared short reference is checked by (objects.md
/// §1.3). Unlike the check's, it does not follow what a commit or tag names,
/// so checking one candidate never walks the history behind it.
pub(crate) fn git_id_of(store: &Store, algorithm: GitAlgorithm, native: &NativeId) -> Result<Vec<u8>, String> {
  let object = store
    .read_known(native)
    .map_err(|error| error.message().to_string())?;
  let (kind, payload) = match object.kind {
    Type::Content => ("blob", object.body),
    Type::Tree => (
      "tree",
      Tree::decode(&object.body)?
        .git_encoding(&|id| store.git(algorithm, id))
        .ok_or("an entry has no alias row")?,
    ),
    Type::Preserved => {
      let preserved = Preserved::decode(&object.body)?;
      if preserved.algorithm != algorithm {
        return Err("it is a preserved object of another Git algorithm".into());
      }
      (preserved.kind.name(), preserved.payload)
    }
    Type::Snapshot | Type::Annotation => return Err("no Git object becomes it".into()),
  };
  git_id(algorithm, kind, &payload)
}

/// A Git object's ID: the algorithm's hash of `<type> <size>`, a NUL and the
/// payload. A SHA-1 input that shows a known collision attack has none, as
/// in Git.
fn git_id(algorithm: GitAlgorithm, kind: &str, payload: &[u8]) -> Result<Vec<u8>, String> {
  let header = format!("{kind} {}\0", payload.len());
  match algorithm {
    GitAlgorithm::Sha1 => {
      let mut hasher = sha1_checked::Builder::default().safe_hash(false).build();
      hasher.update(header.as_bytes());
      hasher.update(payload);
      let result = hasher.try_finalize();
      if result.has_collision() {
        return Err("its Git encoding shows a SHA-1 collision attack".into());
      }
      Ok(result.hash().to_vec())
    }
    GitAlgorithm::Sha256 => {
      let mut hasher = Sha256::new();
      hasher.update(header.as_bytes());
      hasher.update(payload);
      Ok(hasher.finish().to_vec())
    }
  }
}
