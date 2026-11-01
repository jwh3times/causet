//! Import of a Git repository into a native one (ADR-0045 decisions 1 and 2):
//! every object reachable from the source's refs is imported with an alias
//! row. A blob becomes native content and a tree a native tree, or for a tree
//! that is not canonical a preserved Git object (objects.md §4.3); commits and
//! tags are preserved Git objects. Every ref is recorded verbatim in the ref
//! snapshot. Reachable means what the objects themselves name, followed by
//! import: `rev-list` is asked only for commit ancestry, so a tree Git would
//! not walk, such as one named by a file entry, is still read and imported
//! whole.
#![forbid(unsafe_code)]

mod git;

use causet_engine::errors::{GitError, GitResult};
use causet_store::StoreError;
use causet_store::id::{GitAlgorithm, GitId, NativeId, Type, hex, unhex};
use causet_store::objects::{
  Entry, GitKind, Kind, Preserved, Ref, RefTarget, Snapshot, Target, Tree, parse_git_tree,
};
use causet_store::store::StoreWriter;
use std::collections::{HashMap, HashSet};
use std::path::Path;

/// A store failure as a published error.
pub fn store_error(error: StoreError) -> GitError {
  let message = error.to_string();
  match error {
    StoreError::Corrupt(_) => GitError::new("store-corrupt", message),
    StoreError::NotFound(_) | StoreError::Absent(_) => GitError::new("not-found", message),
    StoreError::Unsupported(_) => GitError::new("unsupported-feature", message),
    StoreError::TooLarge(_) => GitError::new("resource-bound-exceeded", message),
    StoreError::Exists(_) => GitError::new("already-exists", message),
    StoreError::Codec(_) => GitError::new("internal-invariant", message),
    StoreError::Io { errno, .. } => GitError::node(message, errno),
  }
}

/// What an import wrote.
#[derive(Debug, Default)]
pub struct Imported {
  pub algorithm: &'static str,
  pub blobs: usize,
  pub trees: usize,
  /// Trees kept in Git's encoding because they are not canonical.
  pub preserved_trees: usize,
  pub commits: usize,
  pub tags: usize,
  /// The refs the snapshot records, `HEAD` included, and how many of them
  /// are symbolic.
  pub refs: usize,
  pub symbolic: usize,
  pub snapshot: Option<NativeId>,
  /// The object `HEAD` resolves to through the snapshot, unless it is unborn.
  pub head: Option<NativeId>,
}

struct Importer<'a> {
  source: &'a git::Source,
  algorithm: GitAlgorithm,
  store: &'a mut StoreWriter,
  /// Every object reached, in the order it was first named.
  order: Vec<String>,
  types: HashMap<String, String>,
  /// The bytes of every tree; other objects go straight to the store.
  raw: HashMap<String, Vec<u8>>,
  native: HashMap<String, NativeId>,
  git: HashMap<NativeId, Vec<u8>>,
  imported: Imported,
}

/// Imports `source` into a new native repository at `destination`, which
/// must not exist or be empty. A source that cannot be imported exactly is
/// refused before anything is written; on any later failure nothing is left
/// that import created.
pub fn import(source: &str, destination: &Path) -> GitResult<Imported> {
  let source = git::Source::open(source)?;
  let algorithm = GitAlgorithm::from_name(&source.format).ok_or_else(|| {
    GitError::new(
      "unsupported-repository-shape",
      format!(
        "{} uses the object format {}, which this build does not import",
        source.path, source.format
      ),
    )
  })?;
  let existed = destination.exists();
  let mut store = StoreWriter::create(destination, algorithm).map_err(store_error)?;
  let result = write(&source, algorithm, &mut store);
  let result = result.and_then(|(mut imported, snapshot)| {
    store.finish(&snapshot).map_err(store_error)?;
    imported.snapshot = Some(NativeId::of(Type::Snapshot, &snapshot.encode()));
    Ok(imported)
  });
  if result.is_err() {
    let _ = if existed {
      std::fs::remove_dir_all(destination.join(".cst-import"))
    } else {
      std::fs::remove_dir_all(destination)
    };
  }
  result
}

fn write(
  source: &git::Source,
  algorithm: GitAlgorithm,
  store: &mut StoreWriter,
) -> GitResult<(Imported, Snapshot)> {
  let refs = source.refs()?;
  let mut importer = Importer {
    source,
    algorithm,
    store,
    order: Vec::new(),
    types: HashMap::new(),
    raw: HashMap::new(),
    native: HashMap::new(),
    git: HashMap::new(),
    imported: Imported {
      algorithm: algorithm.name(),
      ..Imported::default()
    },
  };
  // What only other worktrees reach is imported too, though the snapshot
  // does not record their refs (objects.md §6, §9).
  let mut tips: Vec<String> = refs.iter().filter_map(|listed| listed.id.clone()).collect();
  tips.extend(source.all_tips()?);
  tips.sort();
  tips.dedup();
  importer.reach(tips)?;
  for id in importer.order.clone() {
    if importer.types[&id] == "tree" {
      importer.tree(&id)?;
    }
  }
  let mut recorded = Vec::with_capacity(refs.len());
  for listed in refs {
    let target = match (listed.symbolic, &listed.id) {
      (Some(name), _) => {
        importer.imported.symbolic += 1;
        RefTarget::Symbolic(name)
      }
      (None, Some(id)) => RefTarget::Direct(importer.native[id]),
      (None, None) => {
        return Err(GitError::new(
          "git-response-malformed",
          format!(
            "git listed the ref {} as neither symbolic nor naming an object",
            String::from_utf8_lossy(&listed.name)
          ),
        ));
      }
    };
    recorded.push(Ref {
      name: listed.name,
      target,
    });
  }
  let snapshot = Snapshot::new(algorithm, recorded).map_err(|what| {
    GitError::new(
      "git-response-malformed",
      format!("git listed refs that make no snapshot: {what}"),
    )
  })?;
  importer.imported.refs = snapshot.refs.len();
  importer.imported.head = head(&snapshot);
  Ok((importer.imported, snapshot))
}

/// The object `HEAD` resolves to, following symbolic refs within the
/// snapshot; `None` when it is unborn.
fn head(snapshot: &Snapshot) -> Option<NativeId> {
  let mut name: &[u8] = b"HEAD";
  for _ in 0..=snapshot.refs.len() {
    let found = snapshot.refs.iter().find(|entry| entry.name == name)?;
    match &found.target {
      RefTarget::Direct(id) => return Some(*id),
      RefTarget::Symbolic(target) => name = target,
    }
  }
  None
}

fn digest(id: &str) -> GitResult<Vec<u8>> {
  unhex(id).ok_or_else(|| {
    GitError::new(
      "git-response-malformed",
      format!("git printed the object ID {id}, which is not hex"),
    )
  })
}

/// Whether Git follows a tree entry of this mode: every mode but a submodule
/// link's, after Git's own `canon_mode`. A mode that is not octal is followed
/// by neither.
fn followed(mode: &[u8]) -> bool {
  let Some(mode) = std::str::from_utf8(mode)
    .ok()
    .filter(|mode| !mode.is_empty())
    .and_then(|mode| u32::from_str_radix(mode, 8).ok())
  else {
    return false;
  };
  matches!(mode & 0o170000, 0o100000 | 0o120000 | 0o040000)
}

/// The value of a header line of a commit or tag, such as `tree` or `object`.
fn header<'a>(raw: &'a [u8], name: &str) -> Option<&'a str> {
  raw
    .split(|&byte| byte == b'\n')
    .take_while(|line| !line.is_empty())
    .find_map(|line| line.strip_prefix(name.as_bytes())?.strip_prefix(b" "))
    .and_then(|value| std::str::from_utf8(value).ok())
}

impl Importer<'_> {
  /// Reads every object the tips reach, in rounds: each round reads the
  /// objects named so far and not yet read, with the ancestry of each new
  /// commit, and names what those objects name.
  fn reach(&mut self, tips: Vec<String>) -> GitResult<()> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut pending: Vec<String> = tips
      .into_iter()
      .filter(|id| seen.insert(id.clone()))
      .collect();
    while !pending.is_empty() {
      let types = self.source.types(&pending)?;
      let commits: Vec<String> = pending
        .iter()
        .zip(&types)
        .filter(|(_, (kind, _))| kind == "commit")
        .map(|(id, _)| id.clone())
        .collect();
      let mut round: Vec<(String, String, u64)> = pending
        .drain(..)
        .zip(types)
        .map(|(id, (kind, size))| (id, kind, size))
        .collect();
      let ancestors: Vec<String> = self
        .source
        .commits(&commits)?
        .into_iter()
        .filter(|id| seen.insert(id.clone()))
        .collect();
      for (id, (kind, size)) in ancestors.iter().zip(self.source.types(&ancestors)?) {
        round.push((id.clone(), kind, size));
      }
      let ids: Vec<String> = round.iter().map(|(id, _, _)| id.clone()).collect();
      let sizes: Vec<u64> = round.iter().map(|(_, _, size)| *size).collect();
      for (id, kind, _) in &round {
        self.order.push(id.clone());
        self.types.insert(id.clone(), kind.clone());
      }
      let mut named = Vec::new();
      self.source.contents(&ids, &sizes, &mut |id, kind, body| {
        match kind {
          "tree" => {
            for entry in parse_git_tree(&body, self.algorithm).unwrap_or_default() {
              if followed(&entry.mode) {
                named.push(hex(&entry.digest));
              }
            }
          }
          "commit" => named.extend(header(&body, "tree").map(str::to_string)),
          "tag" => named.extend(header(&body, "object").map(str::to_string)),
          _ => {}
        }
        self.object(id, kind, body)
      })?;
      pending = named
        .into_iter()
        .filter(|id| seen.insert(id.clone()))
        .collect();
    }
    Ok(())
  }

  fn object(&mut self, id: &str, kind: &str, body: Vec<u8>) -> GitResult<()> {
    match kind {
      "blob" => {
        let native = self.store.put_content(&body).map_err(store_error)?;
        self.record(id, native)?;
        self.imported.blobs += 1;
      }
      "tree" => {
        self.raw.insert(id.to_string(), body);
      }
      "commit" | "tag" => {
        let kind = if kind == "commit" {
          self.imported.commits += 1;
          GitKind::Commit
        } else {
          self.imported.tags += 1;
          GitKind::Tag
        };
        let preserved = Preserved {
          algorithm: self.algorithm,
          kind,
          payload: body,
        };
        let native = self.store.put_preserved(&preserved).map_err(store_error)?;
        self.record(id, native)?;
      }
      _ => {
        return Err(GitError::new(
          "git-response-malformed",
          format!("git named {id} an object of type {kind}"),
        ));
      }
    }
    Ok(())
  }

  fn record(&mut self, id: &str, native: NativeId) -> GitResult<()> {
    let digest = digest(id)?;
    self.native.insert(id.to_string(), native);
    self.git.insert(native, digest.clone());
    self.store.alias(digest, native);
    Ok(())
  }

  /// Imports a Git tree after every tree its canonical entries name, by an
  /// explicit stack, so a tree of any depth Git accepts imports.
  fn tree(&mut self, id: &str) -> GitResult<NativeId> {
    let mut stack = vec![id.to_string()];
    while let Some(top) = stack.last().cloned() {
      if self.native.contains_key(&top) {
        stack.pop();
        continue;
      }
      let payload = self.raw.get(&top).ok_or_else(|| {
        GitError::new(
          "git-response-malformed",
          format!("git did not print the tree {top}"),
        )
      })?;
      let waiting: Vec<String> = parse_git_tree(payload, self.algorithm)
        .unwrap_or_default()
        .into_iter()
        .filter(|entry| Kind::from_git_mode(&entry.mode) == Some(Kind::Tree))
        .map(|entry| hex(&entry.digest))
        .filter(|child| {
          self.types.get(child).map(String::as_str) == Some("tree")
            && !self.native.contains_key(child)
        })
        .collect();
      if waiting.is_empty() {
        stack.pop();
        self.import_tree(&top)?;
      } else {
        stack.extend(waiting);
      }
    }
    Ok(self.native[id])
  }

  fn import_tree(&mut self, id: &str) -> GitResult<()> {
    let payload = self.raw[id].clone();
    let native = match self.canonical(&payload) {
      Some(tree) => {
        self.imported.trees += 1;
        self.store.put_tree(&tree).map_err(store_error)?
      }
      None => {
        self.imported.preserved_trees += 1;
        let preserved = Preserved {
          algorithm: self.algorithm,
          kind: GitKind::Tree,
          payload,
        };
        self.store.put_preserved(&preserved).map_err(store_error)?
      }
    };
    self.record(id, native)
  }

  /// The native tree a Git tree becomes, or `None` when it is not canonical
  /// (objects.md §4.3). Every tree it names is imported already.
  fn canonical(&self, payload: &[u8]) -> Option<Tree> {
    let records = parse_git_tree(payload, self.algorithm)?;
    let mut entries = Vec::with_capacity(records.len());
    for record in records {
      let kind = Kind::from_git_mode(&record.mode)?;
      let id = hex(&record.digest);
      let target = match kind {
        Kind::Submodule => Target::Git(GitId::new(self.algorithm, record.digest)),
        Kind::Tree if self.types.get(&id).map(String::as_str) == Some("tree") => {
          Target::Native(self.native[&id])
        }
        Kind::File | Kind::Executable | Kind::Symlink
          if self.types.get(&id).map(String::as_str) == Some("blob") =>
        {
          Target::Native(self.native[&id])
        }
        _ => return None,
      };
      entries.push(Entry {
        name: record.name,
        kind,
        target,
      });
    }
    let tree = Tree::from_entries(entries).ok()?;
    let git = &self.git;
    (tree
      .git_encoding(&|native| git.get(native).cloned())
      .as_deref()
      == Some(payload))
    .then_some(tree)
  }
}
