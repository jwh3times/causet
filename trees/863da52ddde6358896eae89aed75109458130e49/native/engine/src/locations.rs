//! Where causet keeps what it stores (ADR-0039 §1, §3), decided as
//! `src/locations.js` decides it: from files alone, except in a reftable
//! repository, whose refs cost one listing.

use crate::engine;
use crate::errors::GitResult;
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
  pub names: Names,
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

fn holds_any(context: &RepoContext, set: &Names) -> GitResult<bool> {
  if under(&context.common_dir, set.runtime).exists()
    || under(&context.git_dir, set.runtime).exists()
    || under(&context.root, set.specs_dir).exists()
  {
    return Ok(true);
  }
  if Path::new(&context.common_dir).join("reftable").exists() {
    return Ok(
      !engine::list_refs(set.notes_ref, &context.root)?.is_empty()
        || !engine::list_refs(&format!("{}/", set.refs_root), &context.root)?.is_empty(),
    );
  }
  if [set.notes_ref, set.refs_root]
    .iter()
    .any(|name| under(&context.common_dir, name).exists())
  {
    return Ok(true);
  }
  let Ok(packed) = std::fs::read(Path::new(&context.common_dir).join("packed-refs")) else {
    return Ok(false);
  };
  let packed = String::from_utf8_lossy(&packed);
  let prefix = format!("{}/", set.refs_root);
  Ok(packed.split('\n').any(|line| {
    line
      .split(' ')
      .nth(1)
      .is_some_and(|name| name == set.notes_ref || name.starts_with(&prefix))
  }))
}

/// `repositoryNames(cwd)`: the state of the repository and the names it uses.
pub fn repository_names(cwd: &str) -> GitResult<RepositoryNames> {
  let context = engine::repo_context(cwd)?;
  if let Some(cached) = CACHE.with(|cache| cache.borrow().get(&context.common_dir).copied()) {
    return Ok(cached);
  }
  let evidence = Evidence {
    marker: Path::new(&migration_marker_path(&context)).exists(),
    current: holds_any(&context, &CURRENT_NAMES)?,
    legacy: holds_any(&context, &LEGACY_NAMES)?,
  };
  let state = if evidence.marker {
    "migrated"
  } else if evidence.legacy && !evidence.current {
    "unmigrated"
  } else {
    "fresh"
  };
  let result = RepositoryNames {
    state,
    evidence,
    names: if state == "unmigrated" {
      LEGACY_NAMES
    } else {
      CURRENT_NAMES
    },
  };
  CACHE.with(|cache| {
    cache
      .borrow_mut()
      .insert(context.common_dir.clone(), result)
  });
  Ok(result)
}

/// `names(cwd)`.
pub fn names(cwd: &str) -> GitResult<Names> {
  Ok(repository_names(cwd)?.names)
}
