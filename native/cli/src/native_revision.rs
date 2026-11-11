//! Revisions in a native repository (N1, #304): the names `cst cat-file`,
//! `cst ls-tree` and `cst rev-parse` take, resolved as Git's `get_oid`
//! resolves them, from the store and its ref snapshot alone. A name is a ref
//! (by Git's rules for short names), `HEAD` or `@`, a native ID or a unique
//! prefix of one, or a Git ID, followed by any of `~<n>`, `^<n>` and
//! `^{<type>}`, and optionally `:<path>`. What needs a reflog, an index or a
//! search is refused.
//!
//! A commit is named by its native commit where import derived one, and the
//! preserved commit it derives from is named by nothing (commits.md §6): what
//! a name resolves to, and every ID this hands out, is the native commit.

use crate::native_repository::{Listed, alias, corrupt, listing};
use causet_engine::errors::{GitError, GitResult};
use causet_history::commit::{Commit, Commits};
use causet_import::store_error;
use causet_store::StoreError;
use causet_store::id::{NativeId, Type};
use causet_store::objects::{GitKind, Preserved, RefTarget, Snapshot};
use causet_store::store::{Object as Stored, Store};
use std::cell::OnceCell;
use std::path::Path;

/// Git's `ref_rev_parse_rules`: the full names a short name is tried as, in
/// order, each as the text before and after it.
pub const RULES: [(&str, &str); 6] = [
  ("", ""),
  ("refs/", ""),
  ("refs/tags/", ""),
  ("refs/heads/", ""),
  ("refs/remotes/", ""),
  ("refs/remotes/", "/HEAD"),
];

/// Git's `SYMREF_MAXDEPTH`: the most refs one resolution reads.
const SYMREF_MAXDEPTH: usize = 5;

/// An object's Git type, or the native type no Git object has. A native
/// commit is a commit (commits.md §6).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Object {
  Blob,
  Tree,
  Commit,
  Tag,
  Snapshot,
  Annotation,
}

impl Object {
  pub fn name(self) -> &'static str {
    match self {
      Object::Blob => "blob",
      Object::Tree => "tree",
      Object::Commit => "commit",
      Object::Tag => "tag",
      Object::Snapshot => "snapshot",
      Object::Annotation => "annotation",
    }
  }
}

/// The type of object a context expects of a name, as Git's
/// `GET_OID_COMMITTISH` and `GET_OID_TREEISH` say.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Hint {
  Any,
  Commit,
  Committish,
  Treeish,
}

/// A native repository opened for reading: its store and its ref snapshot.
pub struct Repository {
  pub store: Store,
  pub snapshot: Snapshot,
  /// Every native commit, read only when one is not where import places it
  /// (`native_of`).
  commits: OnceCell<Commits>,
}

pub fn unsupported(what: impl std::fmt::Display) -> GitError {
  GitError::new(
    "unsupported-feature",
    format!("{what} is not implemented in a native repository yet."),
  )
}

impl Repository {
  pub fn open(root: &Path) -> GitResult<Repository> {
    let store = Store::open(root).map_err(store_error)?;
    let snapshot = store.refs().map_err(store_error)?;
    Ok(Repository {
      store,
      snapshot,
      commits: OnceCell::new(),
    })
  }

  /// Every native commit the store holds, read once.
  pub fn commits(&self) -> Result<&Commits, StoreError> {
    if let Some(commits) = self.commits.get() {
      return Ok(commits);
    }
    let read = Commits::read(&self.store)?;
    Ok(self.commits.get_or_init(|| read))
  }

  /// A native commit the store holds, decoded.
  fn native_commit(&self, id: &NativeId) -> Result<Commit, StoreError> {
    decoded(id, &self.store.read_known(id)?.body)
  }

  /// The native commit import derived from a preserved commit, if any: the
  /// object stored straight after it, where import puts it (storage.md
  /// §3.2), when that names it; otherwise whichever native commit names it,
  /// found by reading every one.
  fn native_of(&self, preserved: &NativeId) -> Result<Option<NativeId>, StoreError> {
    if let Some((next, Type::NativeCommit)) = self.store.following(preserved)?
      && self.native_commit(&next)?.preserved == Some(*preserved)
    {
      return Ok(Some(next));
    }
    Ok(self.commits()?.by_preserved.get(preserved).copied())
  }

  /// Whether `id` is a preserved Git commit.
  fn is_preserved_commit(&self, id: &NativeId) -> Result<bool, StoreError> {
    if self.store.held(id)? != Some(Type::Preserved) {
      return Ok(false);
    }
    let read = self.store.read_known(id)?;
    Ok(Preserved::decode(&read.body).map_err(StoreError::Corrupt)?.kind == GitKind::Commit)
  }

  /// Whether no command names `id`: a preserved commit a native commit
  /// derives from (commits.md §6).
  fn hidden(&self, id: &NativeId) -> Result<bool, StoreError> {
    Ok(self.is_preserved_commit(id)? && self.native_of(id)?.is_some())
  }

  /// The ID a command names an object by (commits.md §6): a preserved
  /// commit's native commit, where import derived one, and otherwise the
  /// object's own. A commit with none, such as a carrier, keeps its preserved
  /// commit's.
  pub fn named(&self, id: NativeId) -> GitResult<NativeId> {
    if !self.is_preserved_commit(&id).map_err(store_error)? {
      return Ok(id);
    }
    Ok(self.native_of(&id).map_err(store_error)?.unwrap_or(id))
  }

  /// An object as the commands show it: a native commit as the preserved
  /// Git commit it derives from, whose payload is the commit's Git encoding
  /// (commits.md §7), and a preserved commit a native commit derives from as
  /// no object at all.
  pub fn presented(&self, id: &NativeId) -> Result<Stored, StoreError> {
    let read = self.store.read(id)?;
    match read.kind {
      Type::NativeCommit => {
        match decoded(id, &read.body)?.preserved {
          Some(preserved) => self.store.read_known(&preserved),
          None => Err(StoreError::Unsupported(format!(
            "{id} is a commit made natively, and showing one is not implemented yet"
          ))),
        }
      }
      Type::Preserved if self.hidden(id)? => Err(StoreError::NotFound(format!(
        "{id} is not an object this store names"
      ))),
      _ => Ok(read),
    }
  }

  /// The Git ID of an object a command names, in hex (ADR-0046, decision
  /// 5): its alias row's, a native commit's that of the preserved commit it
  /// derives from. An object with none, such as a ref snapshot or a commit
  /// made natively, is refused.
  pub fn git_id(&self, id: &NativeId) -> GitResult<String> {
    let mut object = *id;
    if self.store.held(id).map_err(store_error)? == Some(Type::NativeCommit) {
      if let Some(preserved) = self.native_commit(id).map_err(store_error)?.preserved {
        object = preserved;
      }
    }
    for algorithm in self.store.algorithms() {
      if let Some(digest) = self.store.git(algorithm, &object).map_err(store_error)? {
        return Ok(causet_store::id::hex(&digest));
      }
    }
    Err(GitError::new(
      "not-found",
      format!("{id} has no Git ID: it is no object imported from Git"),
    ))
  }

  /// The object a whole Git ID names here, through the alias map, a commit
  /// as its preserved commit (commits.md §6). `None` when the store has no
  /// alias row for it.
  fn git_object(&self, hex: &str) -> GitResult<Option<NativeId>> {
    let Some(digest) = digest_of(hex) else {
      return Ok(None);
    };
    for algorithm in self.store.algorithms() {
      if let Some(id) = alias(&self.store, algorithm, &digest)? {
        return Ok(Some(id));
      }
    }
    Ok(None)
  }

  /// The objects a prefix of an ID may name, of at least 4 lowercase hex
  /// digits: every object the store holds present but ref snapshots,
  /// annotations and the preserved commits no command names. Native commits
  /// are among them (commits.md §6).
  pub fn candidates(&self, prefix: &str) -> GitResult<Vec<NativeId>> {
    let found = self
      .store
      .matching(prefix, |kind| !matches!(kind, Type::Snapshot | Type::Annotation))
      .map_err(store_error)?;
    let mut kept = Vec::with_capacity(found.len());
    for id in found {
      if !self.hidden(&id).map_err(store_error)? {
        kept.push(id);
      }
    }
    Ok(kept)
  }

  /// A ref by its full name, followed through symbolic refs as Git's
  /// `resolve_ref` follows them: the name it ends at, and the object the
  /// snapshot records there, a commit as its preserved commit (`named` gives
  /// the ID a command shows). A symbolic ref to a ref the snapshot does not
  /// hold resolves to nothing.
  pub fn resolve_ref(&self, name: &[u8]) -> Option<(Vec<u8>, NativeId)> {
    let mut name = name.to_vec();
    for _ in 0..SYMREF_MAXDEPTH {
      let at = self
        .snapshot
        .refs
        .binary_search_by(|entry| entry.name.as_slice().cmp(&name))
        .ok()?;
      match &self.snapshot.refs[at].target {
        RefTarget::Direct(id) => return Some((name, *id)),
        RefTarget::Symbolic(target) => name = target.clone(),
      }
    }
    None
  }

  /// Git's `dwim_ref`: every ref a short name means by `RULES`, in their
  /// order, each as the name it resolves to and its object. The first is the
  /// one it names.
  pub fn dwim(&self, short: &[u8]) -> Vec<(Vec<u8>, NativeId)> {
    RULES
      .iter()
      .filter_map(|(before, after)| {
        self.resolve_ref(&[before.as_bytes(), short, after.as_bytes()].concat())
      })
      .collect()
  }

  /// Git's `shorten_unambiguous_ref`: the shortest name by `RULES` that no
  /// earlier rule (every other rule, when `strict`) resolves to another ref.
  pub fn shorten(&self, full: &[u8], strict: bool) -> Vec<u8> {
    for rule in (1..RULES.len()).rev() {
      let (before, after) = RULES[rule];
      let Some(short) = full
        .strip_prefix(before.as_bytes())
        .and_then(|rest| rest.strip_suffix(after.as_bytes()))
      else {
        continue;
      };
      let checked = if strict { RULES.len() } else { rule };
      let ambiguous = (0..checked).filter(|other| *other != rule).any(|other| {
        let (before, after) = RULES[other];
        self
          .resolve_ref(&[before.as_bytes(), short, after.as_bytes()].concat())
          .is_some()
      });
      if !ambiguous {
        return short.to_vec();
      }
    }
    full.to_vec()
  }

  /// An object's type, or `None` when the store does not hold it, or holds
  /// it as a preserved commit no command names.
  pub fn object(&self, id: &NativeId) -> GitResult<Option<Object>> {
    let kind = self.kind(id)?;
    if kind == Some(Object::Commit) && self.hidden(id).map_err(store_error)? {
      return Ok(None);
    }
    Ok(kind)
  }

  /// An object's type, a preserved commit's included, or `None` when the
  /// store does not hold it.
  fn kind(&self, id: &NativeId) -> GitResult<Option<Object>> {
    Ok(Some(match self.store.held(id).map_err(store_error)? {
      None => return Ok(None),
      Some(Type::Content) => Object::Blob,
      Some(Type::Tree) => Object::Tree,
      Some(Type::Snapshot) => Object::Snapshot,
      Some(Type::Annotation) => Object::Annotation,
      Some(Type::NativeCommit) => Object::Commit,
      Some(Type::Preserved) => match self.preserved(id)?.kind {
        GitKind::Commit => Object::Commit,
        GitKind::Tag => Object::Tag,
        GitKind::Tree => Object::Tree,
      },
    }))
  }

  fn preserved(&self, id: &NativeId) -> GitResult<Preserved> {
    let read = self.store.read_known(id).map_err(store_error)?;
    Preserved::decode(&read.body).map_err(corrupt)
  }

  /// What a commit or tag is built on: a native commit's tree, or what the
  /// first header line of one kept in Git's encoding names through the alias
  /// map, a commit's tree or a tag's object, a commit as its preserved commit
  /// (`named` gives the ID a command shows).
  fn built_on(&self, id: &NativeId) -> GitResult<NativeId> {
    if self.store.held(id).map_err(store_error)? == Some(Type::NativeCommit) {
      return Ok(self.native_commit(id).map_err(store_error)?.tree);
    }
    let preserved = self.preserved(id)?;
    let first = preserved.header_ids().into_iter().find(|header| header.first);
    let built_on = match first {
      Some(header) => alias(&self.store, preserved.algorithm, &header.digest)?,
      None => None,
    };
    built_on.ok_or_else(|| {
      GitError::new(
        "not-found",
        format!(
          "the {} {id} names no imported object to build on",
          preserved.kind.name()
        ),
      )
    })
  }

  /// What a tag names, from its first line, as a command names it.
  pub fn tagged(&self, tag: &NativeId) -> GitResult<NativeId> {
    self.named(self.built_on(tag)?)
  }

  /// A commit's parents, in order, as a command names them: a native
  /// commit's own, or those one kept in Git's encoding names, through the
  /// alias map.
  pub fn parents(&self, commit: &NativeId) -> GitResult<Vec<NativeId>> {
    if self.store.held(commit).map_err(store_error)? == Some(Type::NativeCommit) {
      return Ok(self.native_commit(commit).map_err(store_error)?.parents);
    }
    let preserved = self.preserved(commit)?;
    preserved
      .header_ids()
      .into_iter()
      .filter(|header| !header.first)
      .map(|header| {
        let parent = alias(&self.store, preserved.algorithm, &header.digest)?
          .ok_or_else(|| corrupt(format!("the commit {commit} names a parent that was not imported")))?;
        self.named(parent)
      })
      .collect()
  }

  /// Follows tags, guarding against a cycle only a damaged alias map makes,
  /// to an object as a command names it. A commit passed through on the way,
  /// as a tag's on the way to its tree, is not named, which would cost a
  /// lookup of its native commit.
  fn peeling(&self, id: NativeId, step: impl Fn(Object) -> bool) -> GitResult<(NativeId, Option<Object>)> {
    let mut id = id;
    let mut seen = std::collections::HashSet::new();
    let mut kind = self.kind(&id)?;
    loop {
      match kind {
        Some(found) if step(found) => {
          if !seen.insert(id) {
            return Err(corrupt(format!("{id} names itself through the alias map")));
          }
          id = self.built_on(&id)?;
          kind = self.kind(&id)?;
        }
        Some(Object::Commit) => return Ok((self.named(id)?, kind)),
        _ => return Ok((id, kind)),
      }
    }
  }

  /// Git's `deref_tag`: through tags to what they name.
  pub fn deref_tags(&self, id: NativeId) -> GitResult<(NativeId, Option<Object>)> {
    self.peeling(id, |kind| kind == Object::Tag)
  }

  /// Git's `lookup_commit_reference`: the commit a name peels to through
  /// tags, if it is one.
  pub fn commit_of(&self, id: NativeId) -> GitResult<Option<NativeId>> {
    Ok(match self.deref_tags(id)? {
      (commit, Some(Object::Commit)) => Some(commit),
      _ => None,
    })
  }

  /// Git's `read_object_with_reference` for a tree: through tags and a
  /// commit's tree to a tree.
  pub fn tree_of(&self, id: NativeId) -> GitResult<NativeId> {
    match self.peeling(id, |kind| matches!(kind, Object::Tag | Object::Commit))? {
      (tree, Some(Object::Tree)) => Ok(tree),
      _ => Err(GitError::new("not-found", "not a tree object")),
    }
  }

  /// Git's `peel_to_type`: through tags, and a commit to its tree, to an
  /// object of type `want`.
  fn peel_to(&self, id: NativeId, want: Object) -> GitResult<Option<NativeId>> {
    let (id, kind) = self.peeling(id, |kind| {
      kind != want && (kind == Object::Tag || (kind == Object::Commit && want != Object::Commit))
    })?;
    Ok((kind == Some(want)).then_some(id))
  }

  /// The object a name means, or a `not-found` naming it as Git does.
  pub fn resolve(&self, name: &[u8]) -> GitResult<NativeId> {
    self.resolve_as(name, Hint::Any)
  }

  /// `resolve`, with the type a context expects, which chooses among
  /// objects a short ID is a prefix of. What it resolves to is named as a
  /// command names it; on the way, a ref's commit is its preserved commit,
  /// which costs no lookup of its native commit when a tree is what is
  /// sought.
  pub fn resolve_as(&self, name: &[u8], hint: Hint) -> GitResult<NativeId> {
    self.named(self.resolve_raw(name, hint)?)
  }

  /// The tree a tree-ish names (`tree_of`), resolved without naming the
  /// commit on the way, whose native commit takes every index to find.
  pub fn resolve_tree(&self, name: &[u8]) -> GitResult<NativeId> {
    self.tree_of(self.resolve_raw(name, Hint::Any)?)
  }

  fn resolve_raw(&self, name: &[u8], hint: Hint) -> GitResult<NativeId> {
    let shown = String::from_utf8_lossy(name).into_owned();
    let not_valid = || GitError::new("not-found", format!("Not a valid object name {shown}"));
    if name.first() == Some(&b':') {
      return Err(unsupported(format!(
        "'{shown}': a path in the index, or a commit found by its message,"
      )));
    }
    let mut depth = 0;
    let colon = name.iter().position(|&byte| {
      match byte {
        b'{' => depth += 1,
        b'}' if depth > 0 => depth -= 1,
        b':' if depth == 0 => return true,
        _ => {}
      }
      false
    });
    let Some(colon) = colon else {
      return self.get_as(name, hint)?.ok_or_else(not_valid);
    };
    let (revision, path) = (&name[..colon], &name[colon + 1..]);
    let tree = self.get_as(revision, Hint::Treeish)?.ok_or_else(not_valid)?;
    let tree = self.tree_of(tree)?;
    self.lookup(tree, path, revision)
  }

  /// Git's `get_oid_1`: a name without `:<path>`, or `None` when it names
  /// nothing.
  fn get_as(&self, name: &[u8], hint: Hint) -> GitResult<Option<NativeId>> {
    // `<rev>~<n>` and `<rev>^<n>`; a bare `~` or `^` is 1.
    let digits = name.iter().rev().take_while(|byte| byte.is_ascii_digit()).count();
    let before = name.len() - digits;
    if before > 0 && matches!(name[before - 1], b'~' | b'^') {
      let suffix = name[before - 1];
      let number = match digits {
        0 => 1,
        _ => match std::str::from_utf8(&name[before..])
          .ok()
          .and_then(|text| text.parse::<u32>().ok())
          .filter(|number| *number <= i32::MAX as u32)
        {
          Some(number) => number as usize,
          None => return Ok(None),
        },
      };
      let Some(base) = self.get_as(&name[..before - 1], Hint::Committish)? else {
        return Ok(None);
      };
      let Some(commit) = self.commit_of(base)? else {
        return Ok(None);
      };
      if suffix == b'^' {
        return Ok(match number {
          0 => Some(commit),
          _ => self.parents(&commit)?.get(number - 1).copied(),
        });
      }
      let mut at = commit;
      for _ in 0..number {
        match self.parents(&at)?.first() {
          Some(parent) => at = *parent,
          None => return Ok(None),
        }
      }
      return Ok(Some(at));
    }
    // `<rev>^{<type>}` and `<rev>^{}`. Git's `peel_onion` takes the type as a
    // prefix of what follows the last `^{`, up to its own `}`.
    if name.len() >= 4
      && name.ends_with(b"}")
      && let Some(open) = (1..name.len()).rev().find(|&at| name[at] == b'{' && name[at - 1] == b'^')
    {
      let rest = &name[open + 1..];
      let (want, word): (Option<Object>, &[u8]) = if rest.starts_with(b"commit}") {
        (Some(Object::Commit), b"commit")
      } else if rest.starts_with(b"tag}") {
        (Some(Object::Tag), b"tag")
      } else if rest.starts_with(b"tree}") {
        (Some(Object::Tree), b"tree")
      } else if rest.starts_with(b"blob}") {
        (Some(Object::Blob), b"blob")
      } else if rest.starts_with(b"object}") {
        (None, b"object")
      } else if rest.starts_with(b"}") {
        (None, b"")
      } else if rest.starts_with(b"/") {
        return Err(unsupported(format!(
          "'{}': finding a commit by its message",
          String::from_utf8_lossy(name)
        )));
      } else {
        return Ok(None);
      };
      let inner = match want {
        Some(Object::Commit) => Hint::Committish,
        Some(Object::Tree) => Hint::Treeish,
        _ => Hint::Any,
      };
      let Some(base) = self.get_as(&name[..open - 1], inner)? else {
        return Ok(None);
      };
      if self.kind(&base)?.is_none() {
        return Ok(None);
      }
      return match (want, word) {
        (Some(want), _) => self.peel_to(base, want),
        (None, b"object") => Ok(Some(base)),
        (None, _) => Ok(Some(self.deref_tags(base)?.0)),
      };
    }
    let text = std::str::from_utf8(name).ok();
    let hex = text.filter(|text| !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_hexdigit()));
    if let Some(hex) = hex {
      let lower = hex.to_ascii_lowercase();
      let native = (hex.len() == 64).then(|| NativeId::from_hex(&lower)).flatten();
      if let Some(id) = native
        && self.store.held(&id).map_err(store_error)?.is_some()
      {
        // A preserved commit a native commit derives from is named by
        // nothing (commits.md §6).
        if self.hidden(&id).map_err(store_error)? {
          return Ok(None);
        }
        return Ok(Some(id));
      }
      // A whole Git ID names what import made of its object (commits.md §6).
      if let Some(id) = self.git_object(&lower)? {
        return Ok(Some(id));
      }
      // A whole native ID names itself, held or not, as a whole Git ID does.
      if native.is_some() {
        return Ok(native);
      }
    }
    if name.windows(2).any(|pair| pair == b"@{") {
      return Err(unsupported(format!(
        "'{}': a reflog entry or an upstream",
        String::from_utf8_lossy(name)
      )));
    }
    let short: &[u8] = if name == b"@" { b"HEAD" } else { name };
    if let Some((_, id)) = self.dwim(short).first() {
      return Ok(Some(*id));
    }
    // Git's `get_describe_name`: `<tag>-<n>-g<hex>`, as `git describe`
    // prints it, names the commit its hex is a prefix of.
    let described = |before: &[u8]| {
      let digits = before.iter().rev().take_while(|byte| byte.is_ascii_digit()).count();
      digits > 0 && before.len() > digits + 1 && before[before.len() - digits - 1] == b'-'
    };
    for at in (2..name.len()).rev() {
      if !name[at].is_ascii_hexdigit() {
        if name[at] == b'g' && name[at - 1] == b'-' && described(&name[..at - 1]) {
          let prefix = String::from_utf8_lossy(&name[at + 1..]).into_owned();
          if let Some(id) = self.short(&prefix, Hint::Commit)? {
            return Ok(Some(id));
          }
          break;
        }
      }
    }
    match hex {
      Some(prefix) => self.short(prefix, hint),
      None => Ok(None),
    }
  }

  /// Git's `get_short_oid`: the object a prefix of at least 4 hex digits
  /// names, of the `candidates`. Of several, the one alone of the type
  /// `hint` asks for.
  fn short(&self, prefix: &str, hint: Hint) -> GitResult<Option<NativeId>> {
    if prefix.len() < 4 || !prefix.bytes().all(|byte| byte.is_ascii_hexdigit()) {
      return Ok(None);
    }
    let found = self.candidates(&prefix.to_ascii_lowercase())?;
    let ambiguous = || {
      GitError::new(
        "ambiguous-match",
        format!("short object ID {prefix} is ambiguous"),
      )
    };
    match found.as_slice() {
      [] => return Ok(None),
      [id] => return Ok(Some(*id)),
      _ if hint == Hint::Any => return Err(ambiguous()),
      _ => {}
    }
    let mut fitting = Vec::new();
    for id in &found {
      if self.fits(id, hint)? {
        fitting.push(*id);
      }
    }
    match fitting.as_slice() {
      [id] => Ok(Some(*id)),
      _ => Err(ambiguous()),
    }
  }

  /// Git's `disambiguate_*_only`: whether an object is of the type a hint
  /// asks for, a tag counting as what it peels to.
  fn fits(&self, id: &NativeId, hint: Hint) -> GitResult<bool> {
    let kind = self.object(id)?;
    Ok(match hint {
      Hint::Any => true,
      Hint::Commit => kind == Some(Object::Commit),
      Hint::Committish | Hint::Treeish => {
        let peeled = match kind {
          Some(Object::Tag) => self.deref_tags(*id)?.1,
          other => other,
        };
        peeled == Some(Object::Commit) || (hint == Hint::Treeish && peeled == Some(Object::Tree))
      }
    })
  }

  /// A path looked up through trees from `tree`, as Git's `get_tree_entry`
  /// does; an empty path is the tree itself.
  fn lookup(&self, tree: NativeId, path: &[u8], revision: &[u8]) -> GitResult<NativeId> {
    let missing = || {
      GitError::new(
        "not-found",
        format!(
          "path '{}' does not exist in '{}'",
          String::from_utf8_lossy(path),
          String::from_utf8_lossy(revision)
        ),
      )
    };
    let (mut tree, mut rest) = (tree, path);
    loop {
      if rest.is_empty() {
        return Ok(tree);
      }
      let read = self.store.read_known(&tree).map_err(store_error)?;
      let entries = listing(self, &read.kind, &read.body)?.ok_or_else(missing)?;
      // Git's `find_tree_entry`: entries are taken to be in Git's order, so the
      // search ends at the first name past the one sought.
      let mut next = None;
      for entry in &entries {
        let length = entry.name.len();
        if length > rest.len() {
          continue;
        }
        match rest[..length].cmp(&entry.name) {
          std::cmp::Ordering::Greater => continue,
          std::cmp::Ordering::Less => break,
          std::cmp::Ordering::Equal => {}
        }
        if length == rest.len() {
          return found(entry);
        }
        if rest[length] != b'/' {
          continue;
        }
        if entry.mode & 0o170000 != 0o040000 {
          break;
        }
        if length + 1 == rest.len() {
          return found(entry);
        }
        next = Some((entry.target, &rest[length + 1..]));
        break;
      }
      let (target, remaining) = next.ok_or_else(missing)?;
      tree = target.ok_or_else(missing)?;
      rest = remaining;
    }
  }
}

fn found(entry: &Listed) -> GitResult<NativeId> {
  entry.target.ok_or_else(|| {
    unsupported(format!(
      "Naming {}, a submodule link to the commit {} of another repository,",
      String::from_utf8_lossy(&entry.name),
      entry.shown
    ))
  })
}

/// A native commit's body decoded; one that does not decode is corrupt.
fn decoded(id: &NativeId, body: &[u8]) -> Result<Commit, StoreError> {
  Commit::decode(body).map_err(|why| StoreError::Corrupt(format!("the native commit {id}: {why}")))
}

/// The bytes an even number of hex digits spell.
fn digest_of(hex: &str) -> Option<Vec<u8>> {
  if hex.len() % 2 != 0 {
    return None;
  }
  (0..hex.len())
    .step_by(2)
    .map(|at| u8::from_str_radix(&hex[at..at + 2], 16).ok())
    .collect()
}
