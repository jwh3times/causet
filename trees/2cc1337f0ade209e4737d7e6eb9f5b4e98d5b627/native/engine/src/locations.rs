//! Where causet keeps what it stores (ADR-0039 §1, §3): from files alone, as
//! `src/locations.js` decided it, except in a reftable repository, whose refs
//! cost one listing for both sets of names where the JavaScript CLI listed
//! each (#277).

use crate::engine;
use crate::errors::{GitError, GitResult};
use crate::text;
use crate::types::RepoContext;
use std::cell::RefCell;
use std::collections::HashMap;
use std::path::Path;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Names {
  pub notes_name: &'static str,
  pub notes_ref: &'static str,
  pub refs_root: &'static str,
  pub runtime: &'static str,
  pub specs_dir: &'static str,
  pub workspace_branch_prefix: &'static str,
}

pub const CURRENT_NAMES: Names = Names {
  notes_name: "causet",
  notes_ref: "refs/notes/causet",
  refs_root: "refs/causet",
  runtime: "causet",
  specs_dir: ".causet/specs",
  workspace_branch_prefix: "causet/ws/",
};

pub const LEGACY_NAMES: Names = Names {
  notes_name: "vcs-lab",
  notes_ref: "refs/notes/vcs-lab",
  refs_root: "refs/vcs-lab",
  runtime: "vcs-lab",
  specs_dir: ".vcs-lab/specs",
  workspace_branch_prefix: "vlab/ws/",
};

pub const MIGRATION_MARKER: &str = "migration.json";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Evidence {
  pub marker: bool,
  pub current: bool,
  pub legacy: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RepositoryNames {
  /// `unmigrated`, `migrated`, or `fresh`.
  pub state: &'static str,
  pub evidence: Evidence,
}

thread_local! {
  static CACHE: RefCell<HashMap<String, RepositoryNames>> = RefCell::new(HashMap::new());
}

/// Forget cached states, after `cst migrate` changes one.
pub fn forget_repository_names() {
  CACHE.with(|cache| cache.borrow_mut().clear());
}

fn under(base: &str, relative: &str) -> std::path::PathBuf {
  relative
    .split('/')
    .fold(Path::new(base).to_path_buf(), |path, part| path.join(part))
}

pub fn migration_marker_path(context: &RepoContext) -> String {
  text::join(
    &text::join(&context.common_dir, CURRENT_NAMES.runtime),
    MIGRATION_MARKER,
  )
}

/// Whether the set's runtime or specs directory exists.
fn holds_directory(context: &RepoContext, set: &Names) -> bool {
  under(&context.common_dir, set.runtime).exists()
    || under(&context.git_dir, set.runtime).exists()
    || under(&context.root, set.specs_dir).exists()
}

/// Whether `name` is one of the set's refs, as `git for-each-ref` matches the
/// set's notes ref and `<refs root>/`.
fn is_ref_of(set: &Names, name: &str) -> bool {
  name
    .strip_prefix(set.notes_ref)
    .is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
    || name
      .strip_prefix(set.refs_root)
      .is_some_and(|rest| rest.starts_with('/'))
}

/// Which of `sets` hold anything. A set with no directory is decided from the
/// ref files, or in a reftable repository from one listing of every such
/// set's refs.
fn held_sets<const N: usize>(context: &RepoContext, sets: [&Names; N]) -> GitResult<[bool; N]> {
  let mut held = sets.map(|set| holds_directory(context, set));
  if !Path::new(&context.common_dir).join("reftable").exists() {
    for (held, set) in held.iter_mut().zip(sets) {
      *held = *held || holds_file_ref(context, set);
    }
    return Ok(held);
  }
  let undecided: Vec<&Names> = sets
    .iter()
    .zip(held)
    .filter(|(_, held)| !held)
    .map(|(set, _)| *set)
    .collect();
  if undecided.is_empty() {
    return Ok(held);
  }
  let roots: Vec<String> = undecided
    .iter()
    .map(|set| format!("{}/", set.refs_root))
    .collect();
  let mut patterns = Vec::new();
  for (set, root) in undecided.iter().zip(&roots) {
    patterns.extend([set.notes_ref, root.as_str()]);
  }
  let refs = engine::list_refs_matching(&patterns, &context.root)?;
  for (held, set) in held.iter_mut().zip(sets) {
    *held = *held || refs.iter().any(|entry| is_ref_of(set, &entry.name));
  }
  Ok(held)
}

/// Whether the set has a loose or packed ref.
fn holds_file_ref(context: &RepoContext, set: &Names) -> bool {
  if [set.notes_ref, set.refs_root]
    .iter()
    .any(|name| holds_loose_ref(&under(&context.common_dir, name)))
  {
    return true;
  }
  let Ok(packed) = std::fs::read(Path::new(&context.common_dir).join("packed-refs")) else {
    return false;
  };
  let packed = String::from_utf8_lossy(&packed);
  let prefix = format!("{}/", set.refs_root);
  packed.split('\n').any(|line| {
    line
      .split(' ')
      .nth(1)
      .is_some_and(|name| name == set.notes_ref || name.starts_with(&prefix))
  })
}

/// `holdsLooseRef`: whether `location` is a loose ref or a directory holding
/// one. Git leaves a deleted loose ref's empty directories behind, so an empty
/// directory is not evidence (#191). A `.lock` file is never a ref.
fn holds_loose_ref(location: &Path) -> bool {
  match std::fs::metadata(location) {
    Err(_) => false,
    Ok(metadata) if !metadata.is_dir() => true,
    Ok(_) => std::fs::read_dir(location).is_ok_and(|entries| {
      entries.flatten().any(|entry| match entry.file_type() {
        Ok(kind) if kind.is_dir() => holds_loose_ref(&entry.path()),
        _ => !entry.file_name().to_string_lossy().ends_with(".lock"),
      })
    }),
  }
}

/// `repositoryNames(cwd)`: the state of the repository.
pub fn repository_names(cwd: &str) -> GitResult<RepositoryNames> {
  let context = engine::repo_context(cwd)?;
  if let Some(cached) = CACHE.with(|cache| cache.borrow().get(&context.common_dir).copied()) {
    return Ok(cached);
  }
  let [current, legacy] = held_sets(&context, [&CURRENT_NAMES, &LEGACY_NAMES])?;
  let evidence = Evidence {
    marker: Path::new(&migration_marker_path(&context)).exists(),
    current,
    legacy,
  };
  let state = if evidence.marker {
    "migrated"
  } else if evidence.legacy && !evidence.current {
    "unmigrated"
  } else {
    "fresh"
  };
  let result = RepositoryNames { state, evidence };
  CACHE.with(|cache| {
    cache
      .borrow_mut()
      .insert(context.common_dir.clone(), result)
  });
  Ok(result)
}

/// The refusal of a repository that still keeps its metadata under the former
/// names: the migration window has ended (ADR-0039 §8).
pub fn unmigrated_error() -> GitError {
  GitError::new(
    "unmigrated-repository",
    format!(
      "This repository keeps its metadata under the names used before causet ({}, {}/*), which this build no longer reads.",
      LEGACY_NAMES.notes_ref, LEGACY_NAMES.refs_root
    ),
  )
  .details("Run cst migrate --dry-run to see the move, then cst migrate. It deletes nothing.")
}

/// `assertMigrated(cwd)`.
pub fn assert_migrated(cwd: &str) -> GitResult<()> {
  if repository_names(cwd)?.state == "unmigrated" {
    return Err(unmigrated_error());
  }
  Ok(())
}

/// `names(cwd)`: the names everything that persists is kept under. An
/// unmigrated repository has none this build can use, so asking refuses it.
pub fn names(cwd: &str) -> GitResult<Names> {
  assert_migrated(cwd)?;
  Ok(CURRENT_NAMES)
}

/// `refFamily(family, cwd)`: `<refs root>/<family>` under the names in use.
pub fn ref_family(family: &str, cwd: &str) -> GitResult<String> {
  Ok(format!("{}/{family}", names(cwd)?.refs_root))
}

/// `runtimeDirectory(gitDirectory, cwd)`.
pub fn runtime_directory(git_directory: &str, cwd: &str) -> GitResult<String> {
  Ok(text::join(git_directory, names(cwd)?.runtime))
}

/// `familyRemainder(ref, family)`: what follows `<root>/<family>/` under
/// either set of names.
pub fn family_remainder<'a>(name: &'a str, family: &str) -> Option<&'a str> {
  [CURRENT_NAMES, LEGACY_NAMES]
    .iter()
    .find_map(|set| name.strip_prefix(&format!("{}/{family}/", set.refs_root)))
}

/// `localRef(ref, cwd)`: a ref a record names, under the current names. Records
/// are permanent, so this translation is too (ADR-0039 §2, §8).
pub fn local_ref(name: &str, cwd: &str) -> GitResult<String> {
  let local = names(cwd)?;
  if name == CURRENT_NAMES.notes_ref || name == LEGACY_NAMES.notes_ref {
    return Ok(local.notes_ref.to_string());
  }
  for set in [CURRENT_NAMES, LEGACY_NAMES] {
    if let Some(rest) = name.strip_prefix(&format!("{}/", set.refs_root)) {
      return Ok(format!("{}/{rest}", local.refs_root));
    }
  }
  Ok(name.to_string())
}
