//! Import of a Git repository into a native one (ADR-0045 decisions 1 to 3):
//! every object reachable from the source's refs is imported with an alias
//! row. A blob becomes native content and a tree a native tree, or for a tree
//! that is not canonical a preserved Git object (objects.md §4.3); commits and
//! tags are preserved Git objects. Every ref is recorded verbatim in the ref
//! snapshot. Reachable means what the objects themselves name, followed by
//! import: `rev-list` is asked only for commit ancestry, so a tree Git would
//! not walk, such as one named by a file entry, is still read and imported
//! whole. Records are written in the order of import's walk (storage.md §3.2),
//! so a fresh import of the same history writes the same bytes. An import
//! into an existing native repository reads and writes only what its store
//! does not hold already.
#![forbid(unsafe_code)]

mod git;

use causet_engine::errors::{GitError, GitResult};
use causet_store::StoreError;
use causet_store::id::{GitAlgorithm, GitId, NativeId, Type, hex, unhex};
use causet_store::objects::{
  Entry, GitKind, Kind, Preserved, Ref, RefTarget, Snapshot, Target, Tree, followed, header_ids,
  parse_git_tree,
};
use causet_store::store::Store;
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
  /// Whether it added to an existing native repository, in which case every
  /// count is of what it added.
  pub added: bool,
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
  /// Every object reached that the store does not hold already: its Git type
  /// and size.
  types: HashMap<String, String>,
  sizes: HashMap<String, u64>,
  /// The bytes of every commit, tag and tree reached. Blobs are read once the
  /// walk has put them in order.
  raw: HashMap<String, Vec<u8>>,
  /// Each commit's parents, as Git parses them: the ancestry reach followed.
  parents: HashMap<String, Vec<String>>,
  native: HashMap<String, NativeId>,
  git: HashMap<NativeId, Vec<u8>>,
  imported: Imported,
}

/// What import's walk puts in order (storage.md §3.2): the commits, tags and
/// trees, then the blobs.
struct Walk {
  metadata: Vec<String>,
  content: Vec<String>,
}

/// Imports `source` into a new native repository at `destination`, which
/// must not exist or be empty, or into the native repository there. A source
/// that cannot be imported exactly is refused before anything is written; on
/// any later failure nothing is left that import created, and an existing
/// repository is as it was.
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
  if destination.join(".cst").join("format").is_file() {
    let mut store = StoreWriter::open(destination, algorithm).map_err(store_error)?;
    let (mut imported, snapshot) = write(&source, algorithm, &mut store)?;
    store.finish(&snapshot).map_err(store_error)?;
    imported.added = true;
    imported.snapshot = Some(NativeId::of(Type::Snapshot, &snapshot.encode()));
    return Ok(imported);
  }
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
  let mut refs = source.refs()?;
  refs.sort_by(|a, b| a.name.cmp(&b.name));
  // The walk starts from the objects the refs that are not symbolic name, in
  // byte order of ref name, then from what only other worktrees' `HEAD`
  // names, which the snapshot does not record (objects.md §6, §9), in byte
  // order of Git ID.
  let mut tips: Vec<String> = Vec::new();
  let mut listed: HashSet<String> = HashSet::new();
  for id in refs
    .iter()
    .filter(|entry| entry.symbolic.is_none())
    .filter_map(|entry| entry.id.as_ref())
  {
    if listed.insert(id.clone()) {
      tips.push(id.clone());
    }
  }
  let mut others: Vec<String> = source
    .all_tips()?
    .into_iter()
    .filter(|id| !listed.contains(id))
    .collect();
  others.sort();
  others.dedup();
  tips.extend(others);
  // History the store holds already is not walked again: Git is asked for
  // no commit that its current refs reach and the source still holds.
  let except = match store.existing() {
    Some(existing) => source.holding(&held_tips(existing, algorithm)?)?,
    None => Vec::new(),
  };
  let mut importer = Importer {
    source,
    algorithm,
    store,
    types: HashMap::new(),
    sizes: HashMap::new(),
    raw: HashMap::new(),
    parents: HashMap::new(),
    native: HashMap::new(),
    git: HashMap::new(),
    imported: Imported {
      algorithm: algorithm.name(),
      ..Imported::default()
    },
  };
  importer.reach(&tips, &except)?;
  let walk = importer.walk(&tips);
  if walk.metadata.len() + walk.content.len() != importer.types.len() {
    return Err(GitError::new(
      "internal-invariant",
      format!(
        "import's walk left {} of the {} objects it read",
        walk.metadata.len() + walk.content.len(),
        importer.types.len()
      ),
    ));
  }
  importer.content(&walk.content)?;
  for id in &walk.metadata {
    importer.metadata(id)?;
  }
  let mut recorded = Vec::with_capacity(refs.len());
  for listed in refs {
    let target = match (listed.symbolic, &listed.id) {
      (Some(name), _) => {
        importer.imported.symbolic += 1;
        RefTarget::Symbolic(name)
      }
      (None, Some(id)) => RefTarget::Direct(importer.native_of(id).ok_or_else(|| {
        GitError::new(
          "internal-invariant",
          format!("the ref target {id} was not imported"),
        )
      })?),
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

/// The Git IDs of the objects an existing store's current refs name.
fn held_tips(store: &Store, algorithm: GitAlgorithm) -> GitResult<Vec<String>> {
  let snapshot = store.refs().map_err(store_error)?;
  let Some(aliases) = store.aliases_for(algorithm) else {
    return Ok(Vec::new());
  };
  let mut tips: Vec<String> = snapshot
    .refs
    .iter()
    .filter_map(|entry| match &entry.target {
      RefTarget::Direct(id) => aliases.git(id).map(hex),
      RefTarget::Symbolic(_) => None,
    })
    .collect();
  tips.sort();
  tips.dedup();
  Ok(tips)
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

/// What a commit or tag is built on, as Git's parser reads it: its first
/// line's ID (`header_ids`), a commit's tree or a tag's object. A commit's
/// parents come from its ancestry instead.
fn built_on(algorithm: GitAlgorithm, kind: GitKind, raw: &[u8]) -> Option<String> {
  header_ids(algorithm, kind, raw)
    .into_iter()
    .find(|id| id.first)
    .map(|id| hex(&id.digest))
}

/// A tree entry's path, below the tree at `path`.
fn below(path: &[u8], name: &[u8]) -> Vec<u8> {
  if path.is_empty() {
    return name.to_vec();
  }
  [path, b"/", name].concat()
}

impl Importer<'_> {
  /// The native object the store held already for a Git ID.
  fn held(&self, id: &str) -> Option<NativeId> {
    let aliases = self.store.existing()?.aliases_for(self.algorithm)?;
    aliases.native(&unhex(id)?)
  }

  fn native_of(&self, id: &str) -> Option<NativeId> {
    self.native.get(id).copied().or_else(|| self.held(id))
  }

  /// A Git object's type: as the source gave it, or for one the store held
  /// already, as its native object records it.
  fn git_type(&self, id: &str) -> Option<&str> {
    if let Some(kind) = self.types.get(id) {
      return Some(kind);
    }
    let store = self.store.existing()?;
    let native = self.held(id)?;
    Some(match store.held(&native)? {
      Type::Content => "blob",
      Type::Tree => "tree",
      Type::Preserved => {
        let read = store.read(&native).ok()?;
        match Preserved::decode(&read.body).ok()?.kind {
          GitKind::Commit => "commit",
          GitKind::Tag => "tag",
          GitKind::Tree => "tree",
        }
      }
      Type::Snapshot | Type::Annotation => return None,
    })
  }

  /// Reads every object the tips reach that the store does not hold
  /// already, in rounds: each round reads the objects named so far and not
  /// yet read, with the ancestry of each new commit, and names what those
  /// objects name. A blob's bytes are not read here.
  fn reach(&mut self, tips: &[String], except: &[String]) -> GitResult<()> {
    let source = self.source;
    let mut seen: HashSet<String> = HashSet::new();
    let mut pending: Vec<String> = tips
      .iter()
      .filter(|id| seen.insert((*id).clone()) && self.held(id).is_none())
      .cloned()
      .collect();
    while !pending.is_empty() {
      let types = source.types(&pending)?;
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
      let mut ancestors: Vec<String> = Vec::new();
      for (commit, parents) in source.commits(&commits, except)? {
        if seen.insert(commit.clone()) && self.held(&commit).is_none() {
          ancestors.push(commit.clone());
        }
        self.parents.entry(commit).or_insert(parents);
      }
      for (id, (kind, size)) in ancestors.iter().zip(source.types(&ancestors)?) {
        round.push((id.clone(), kind, size));
      }
      let mut ids = Vec::new();
      let mut sizes = Vec::new();
      for (id, kind, size) in round {
        if !matches!(kind.as_str(), "blob" | "tree" | "commit" | "tag") {
          return Err(GitError::new(
            "git-response-malformed",
            format!("git named {id} an object of type {kind}"),
          ));
        }
        if kind != "blob" {
          ids.push(id.clone());
          sizes.push(size);
        }
        self.sizes.insert(id.clone(), size);
        self.types.insert(id, kind);
      }
      let mut named = Vec::new();
      let algorithm = self.algorithm;
      let raw = &mut self.raw;
      source.contents(&ids, &sizes, &mut |id, kind, body| {
        match kind {
          "tree" => {
            for entry in parse_git_tree(&body, algorithm).unwrap_or_default() {
              if followed(&entry.mode) {
                named.push(hex(&entry.digest));
              }
            }
          }
          "commit" => named.extend(built_on(algorithm, GitKind::Commit, &body)),
          "tag" => named.extend(built_on(algorithm, GitKind::Tag, &body)),
          _ => {
            return Err(GitError::new(
              "git-response-malformed",
              format!("git printed {id} as an object of type {kind}"),
            ));
          }
        }
        raw.insert(id.to_string(), body);
        Ok(())
      })?;
      pending = named
        .into_iter()
        .filter(|id| seen.insert(id.clone()) && self.held(id).is_none())
        .collect();
    }
    Ok(())
  }

  /// What an object names, in the order the walk follows it, each with the
  /// path it is reached at: a commit's parents, as Git parses them, then its
  /// tree; a tag's object; a tree's entries Git follows, as stored. Only what
  /// this import reads.
  fn names(&self, id: &str, path: &[u8]) -> Vec<(String, Vec<u8>)> {
    let raw = self.raw.get(id).map(Vec::as_slice).unwrap_or_default();
    let named: Vec<(String, Vec<u8>)> = match self.types[id].as_str() {
      "commit" => self
        .parents
        .get(id)
        .into_iter()
        .flatten()
        .cloned()
        .chain(built_on(self.algorithm, GitKind::Commit, raw))
        .map(|named| (named, Vec::new()))
        .collect(),
      "tag" => built_on(self.algorithm, GitKind::Tag, raw)
        .map(|target| (target, Vec::new()))
        .into_iter()
        .collect(),
      "tree" => parse_git_tree(raw, self.algorithm)
        .unwrap_or_default()
        .into_iter()
        .filter(|entry| followed(&entry.mode))
        .map(|entry| (hex(&entry.digest), below(path, &entry.name)))
        .collect(),
      _ => Vec::new(),
    };
    named
      .into_iter()
      .filter(|(named, _)| self.types.contains_key(named))
      .collect()
  }

  /// Import's walk (storage.md §3.2): depth first from the tips, each object
  /// after everything it names. Commits, tags and trees are in the order the
  /// walk leaves them; blobs are grouped by the path each is first reached
  /// at, the paths in the order the walk first reaches a blob at them, and
  /// within a path in the walk's order, so a path's versions are adjacent,
  /// oldest first.
  fn walk(&self, tips: &[String]) -> Walk {
    enum Step {
      Enter(String, Vec<u8>),
      Leave(String, Vec<u8>),
    }
    let mut visited: HashSet<String> = HashSet::new();
    let mut paths: HashMap<Vec<u8>, usize> = HashMap::new();
    let mut content: Vec<(usize, usize, String)> = Vec::new();
    let mut metadata = Vec::new();
    let mut steps: Vec<Step> = tips
      .iter()
      .rev()
      .map(|id| Step::Enter(id.clone(), Vec::new()))
      .collect();
    while let Some(step) = steps.pop() {
      match step {
        Step::Enter(id, path) => {
          if !self.types.contains_key(&id) || !visited.insert(id.clone()) {
            continue;
          }
          let named = self.names(&id, &path);
          steps.push(Step::Leave(id, path));
          steps.extend(
            named
              .into_iter()
              .rev()
              .map(|(named, path)| Step::Enter(named, path)),
          );
        }
        Step::Leave(id, path) => {
          if self.types[&id] == "blob" {
            let next = paths.len();
            let rank = *paths.entry(path).or_insert(next);
            content.push((rank, content.len(), id));
          } else {
            metadata.push(id);
          }
        }
      }
    }
    content.sort();
    Walk {
      metadata,
      content: content.into_iter().map(|(_, _, id)| id).collect(),
    }
  }

  /// Reads the blobs in the walk's order and stores each as content.
  fn content(&mut self, ids: &[String]) -> GitResult<()> {
    let source = self.source;
    let sizes: Vec<u64> = ids.iter().map(|id| self.sizes[id]).collect();
    source.contents(ids, &sizes, &mut |id, kind, body| {
      if kind != "blob" {
        return Err(GitError::new(
          "git-response-malformed",
          format!("git printed {id} as an object of type {kind}"),
        ));
      }
      let native = self.store.put_content(&body).map_err(store_error)?;
      self.record(id, native)?;
      self.imported.blobs += 1;
      Ok(())
    })
  }

  /// Stores a commit, tag or tree. Everything a tree names is stored
  /// already, since the walk leaves an object after what it names.
  fn metadata(&mut self, id: &str) -> GitResult<()> {
    let payload = self.raw.remove(id).ok_or_else(|| {
      GitError::new(
        "git-response-malformed",
        format!("git did not print the object {id}"),
      )
    })?;
    let native = match self.types[id].as_str() {
      "tree" => match self.canonical(&payload) {
        Some(tree) => {
          self.imported.trees += 1;
          self.store.put_tree(&tree).map_err(store_error)?
        }
        None => {
          self.imported.preserved_trees += 1;
          self.preserved(GitKind::Tree, payload)?
        }
      },
      "commit" => {
        self.imported.commits += 1;
        self.preserved(GitKind::Commit, payload)?
      }
      _ => {
        self.imported.tags += 1;
        self.preserved(GitKind::Tag, payload)?
      }
    };
    self.record(id, native)
  }

  fn preserved(&mut self, kind: GitKind, payload: Vec<u8>) -> GitResult<NativeId> {
    let preserved = Preserved {
      algorithm: self.algorithm,
      kind,
      payload,
    };
    self.store.put_preserved(&preserved).map_err(store_error)
  }

  fn record(&mut self, id: &str, native: NativeId) -> GitResult<()> {
    let digest = digest(id)?;
    self.native.insert(id.to_string(), native);
    self.git.insert(native, digest.clone());
    self.store.alias(digest, native);
    Ok(())
  }

  /// The native tree a Git tree becomes, or `None` when it is not canonical
  /// (objects.md §4.3). Every tree it names is stored already.
  fn canonical(&self, payload: &[u8]) -> Option<Tree> {
    let records = parse_git_tree(payload, self.algorithm)?;
    let mut entries = Vec::with_capacity(records.len());
    for record in records {
      let kind = Kind::from_git_mode(&record.mode)?;
      let id = hex(&record.digest);
      let target = match kind {
        Kind::Submodule => Target::Git(GitId::new(self.algorithm, record.digest)),
        Kind::Tree if self.git_type(&id) == Some("tree") => Target::Native(self.native_of(&id)?),
        Kind::File | Kind::Executable | Kind::Symlink if self.git_type(&id) == Some("blob") => {
          Target::Native(self.native_of(&id)?)
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
    let held = self
      .store
      .existing()
      .and_then(|store| store.aliases_for(self.algorithm));
    let git_of = |native: &NativeId| {
      git
        .get(native)
        .cloned()
        .or_else(|| held.and_then(|aliases| aliases.git(native)).map(<[u8]>::to_vec))
    };
    (tree.git_encoding(&git_of).as_deref() == Some(payload)).then_some(tree)
  }
}
