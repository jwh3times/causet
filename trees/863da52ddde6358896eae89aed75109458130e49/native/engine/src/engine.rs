//! The read-side engine seam (ADR-0019), as `src/engine.js` defines it.
//!
//! Every Git read a domain module needs is one operation of the catalog
//! below, answered by a [`ReadBackend`]. [`GitBackend`] implements all of
//! them; [`NativeBackend`] (gitoxide) answers the subset it is qualified for.
//! With the native engine selected, an operation it cannot answer, or fails,
//! falls back to Git and the fallback is recorded in the active metrics.
//! Mutations never pass through here: they are explicit `run_git` calls.

use crate::environment;
use crate::errors::{GitError, GitResult};
use crate::metrics::{self, Fallback};
use crate::types::*;
use crate::{git, native};
use causet_model::json::{Value, object, string};
use std::cell::Cell;

/// Why a backend did not answer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Refusal {
  /// The backend does not implement the operation.
  Unsupported,
  /// The input is outside the backend's supported profile.
  UnsupportedInput(String),
  /// The backend failed.
  Failed(String),
  /// The Git engine's own failure, which the seam raises.
  Error(GitError),
}

pub type Answer<T> = Result<T, Refusal>;

/// The Git engine: every operation, one process or the object session each.
pub struct GitBackend;

/// The gitoxide engine: the operations `causet-core` answers.
pub struct NativeBackend;

macro_rules! catalog {
  ($( $operation:literal => fn $name:ident ( $( $argument:ident : $kind:ty ),* ) -> $answer:ty ; )*) => {
    /// One read backend of the seam. Every operation defaults to
    /// [`Refusal::Unsupported`].
    #[allow(unused_variables)]
    pub trait ReadBackend {
      fn name(&self) -> &'static str;
      $( fn $name(&self, $( $argument: $kind ),*) -> Answer<$answer> { Err(Refusal::Unsupported) } )*
    }

    impl ReadBackend for GitBackend {
      fn name(&self) -> &'static str {
        "git"
      }
      $( fn $name(&self, $( $argument: $kind ),*) -> Answer<$answer> {
        git::$name($( $argument ),*).map_err(Refusal::Error)
      } )*
    }

    /// The names of every cataloged read operation, in catalog order.
    pub const READ_OPERATIONS: &[&str] = &[$( $operation ),*];

    $(
      #[doc = concat!("`", $operation, "` through the seam.")]
      pub fn $name($( $argument: $kind ),*) -> GitResult<$answer> {
        dispatch($operation, |backend| backend.$name($( $argument ),*))
      }
    )*
  };
}

catalog! {
  // Repository and host
  "repoContext" => fn repo_context(cwd: &str) -> RepoContext;
  "gitVersion" => fn git_version(cwd: &str) -> GitVersion;
  "isInsideWorkTree" => fn is_inside_work_tree(cwd: &str) -> bool;
  "gitPath" => fn git_path(name: &str, cwd: &str) -> String;
  // Objects
  "resolveRevision" => fn resolve_revision(revision: &str, cwd: &str) -> String;
  "resolveObjectIds" => fn resolve_object_ids(expressions: &[String], cwd: &str) -> Vec<String>;
  "revisionResolves" => fn revision_resolves(name: &str, cwd: &str) -> bool;
  "treeId" => fn tree_id(revision: &str, cwd: &str) -> String;
  "readGitBlob" => fn read_git_blob(blob: &str, cwd: &str) -> Vec<u8>;
  "readGitObjects" => fn read_git_objects(expressions: &[String], cwd: &str) -> Objects;
  "inspectGitObjects" => fn inspect_git_objects(expressions: &[String], cwd: &str) -> Objects;
  // History
  "mergeBase" => fn merge_base(left: &str, right: &str, cwd: &str) -> String;
  "isAncestor" => fn is_ancestor(ancestor: &str, descendant: &str, cwd: &str) -> bool;
  "listCommits" => fn list_commits(base: &str, tip: &str, cwd: &str) -> Vec<String>;
  "reachableCommits" => fn reachable_commits(revision: &str, cwd: &str) -> Vec<String>;
  "countCommits" => fn count_commits(revision: &str, cwd: &str) -> f64;
  "mergeCommitsBetween" => fn merge_commits_between(base: &str, tip: &str, cwd: &str) -> Vec<String>;
  "commitTopology" => fn commit_topology(base: &str, tip: &str, cwd: &str) -> Vec<CommitParents>;
  "rootCommits" => fn root_commits(cwd: &str) -> Vec<String>;
  "commitHistory" => fn commit_history(revisions: &[String], cwd: &str, options: HistoryOptions) -> Vec<CommitRecord>;
  "commitMessage" => fn commit_message(commit: &str, cwd: &str) -> String;
  "commitSubject" => fn commit_subject(commit: &str, cwd: &str) -> String;
  "findCommitsByChangeId" => fn find_commits_by_change_id(change_id: &str, cwd: &str) -> Vec<String>;
  "patchEquivalentCommits" => fn patch_equivalent_commits(target: &str, source: &str, base: &str, cwd: &str) -> Vec<String>;
  "historyGraph" => fn history_graph(cwd: &str) -> String;
  "ancestryPath" => fn ancestry_path(from: &str, to: &str, cwd: &str) -> Vec<CommitParents>;
  "treePaths" => fn tree_paths(tree: &str, cwd: &str) -> Vec<String>;
  "remoteRefs" => fn remote_refs(remote: &str, cwd: &str) -> Option<Vec<RefEntry>>;
  // Refs and notes
  "refExists" => fn ref_exists(name: &str, cwd: &str) -> bool;
  "refTarget" => fn ref_target(name: &str, cwd: &str) -> Option<String>;
  "listRefs" => fn list_refs(pattern: &str, cwd: &str) -> Vec<RefEntry>;
  "symbolicRef" => fn symbolic_ref(name: &str, cwd: &str, short: bool) -> Option<String>;
  "pseudoRefTarget" => fn pseudo_ref_target(name: &str, cwd: &str) -> Option<String>;
  "listNoteEntries" => fn list_note_entries(notes_ref: &str, cwd: &str) -> Vec<NoteEntry>;
  "readNoteText" => fn read_note_text(notes_ref: &str, target: &str, cwd: &str) -> Option<String>;
  // Worktree, index, and status
  "workspaceStatus" => fn workspace_status(cwd: &str) -> WorkspaceStatus;
  "porcelainStatus" => fn porcelain_status(cwd: &str, nul_terminated: bool) -> String;
  "unmergedPaths" => fn unmerged_paths(cwd: &str) -> Vec<String>;
  "indexEntries" => fn index_entries(cwd: &str, options: &IndexOptions) -> Vec<IndexEntry>;
  "listTrackedPaths" => fn list_tracked_paths(pathspecs: &[String], cwd: &str) -> Vec<String>;
  "pathInventory" => fn path_inventory(pathspecs: &[String], cwd: &str) -> Vec<InventoryEntry>;
  "ignoredPaths" => fn ignored_paths(cwd: &str) -> Vec<String>;
  "listWorktrees" => fn list_worktrees(cwd: &str) -> Vec<Worktree>;
  "listWorktreeGitDirs" => fn list_worktree_git_dirs(cwd: &str) -> Vec<String>;
}

impl ReadBackend for NativeBackend {
  fn name(&self) -> &'static str {
    "native"
  }

  fn repo_context(&self, cwd: &str) -> Answer<RepoContext> {
    native::repo_context(cwd)
  }

  fn list_refs(&self, pattern: &str, cwd: &str) -> Answer<Vec<RefEntry>> {
    native::list_refs(pattern, cwd)
  }

  fn inspect_git_objects(&self, expressions: &[String], cwd: &str) -> Answer<Objects> {
    native::inspect_git_objects(expressions, cwd)
  }

  fn read_git_objects(&self, expressions: &[String], cwd: &str) -> Answer<Objects> {
    native::read_git_objects(expressions, cwd)
  }

  fn list_note_entries(&self, notes_ref: &str, cwd: &str) -> Answer<Vec<NoteEntry>> {
    native::list_note_entries(notes_ref, cwd)
  }
}

// ---------------------------------------------------------------------------
// Engine selection
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReadEngine {
  Git,
  Native,
}

impl ReadEngine {
  pub fn name(self) -> &'static str {
    match self {
      ReadEngine::Git => "git",
      ReadEngine::Native => "native",
    }
  }
}

/// The engines the seam can select, oracle first.
pub const READ_ENGINES: [&str; 2] = ["git", "native"];

thread_local! {
  static OVERRIDE: Cell<Option<ReadEngine>> = const { Cell::new(None) };
}

pub fn default_read_engine() -> ReadEngine {
  ReadEngine::Git
}

/// An engine by name, refused as `src/git.js` refuses an unknown one.
pub fn parse_engine(name: &str) -> GitResult<ReadEngine> {
  match name {
    "git" => Ok(ReadEngine::Git),
    "native" => Ok(ReadEngine::Native),
    _ => Err(GitError::new(
      "usage-invalid-option-value",
      format!(
        "Unknown engine '{name}'. Use one of: {}.",
        READ_ENGINES.join(", ")
      ),
    )),
  }
}

/// `readEngine()`: the override, else `CAUSET_ENGINE`, else the default.
pub fn read_engine() -> GitResult<ReadEngine> {
  if let Some(engine) = OVERRIDE.with(Cell::get) {
    return Ok(engine);
  }
  match environment::value("ENGINE") {
    None => Ok(default_read_engine()),
    Some(value) if value.is_empty() => Ok(default_read_engine()),
    Some(value) => parse_engine(&value),
  }
}

struct Restore(Option<ReadEngine>);

impl Drop for Restore {
  fn drop(&mut self) {
    OVERRIDE.with(|cell| cell.set(self.0));
  }
}

/// `withReadEngine(engine, callback)`.
pub fn with_read_engine<T>(engine: ReadEngine, callback: impl FnOnce() -> T) -> T {
  let _restore = Restore(OVERRIDE.with(|cell| cell.replace(Some(engine))));
  callback()
}

fn dispatch<T>(
  operation: &'static str,
  run: impl Fn(&dyn ReadBackend) -> Answer<T>,
) -> GitResult<T> {
  if read_engine()? == ReadEngine::Native {
    let (reason, detail) = match run(&NativeBackend) {
      Ok(value) => {
        metrics::record_native_read(operation);
        return Ok(value);
      }
      Err(Refusal::Unsupported) => ("unsupported", None),
      Err(Refusal::UnsupportedInput(message)) => ("unsupported-input", Some(message)),
      Err(Refusal::Failed(message)) => ("native-error", Some(message)),
      Err(Refusal::Error(error)) => ("native-error", Some(error.message)),
    };
    metrics::record_fallback(Fallback {
      operation: operation.into(),
      reason: reason.into(),
      detail,
    });
  }
  match run(&GitBackend) {
    Ok(value) => Ok(value),
    Err(Refusal::Error(error)) => Err(error),
    Err(_) => Err(GitError::new(
      "internal-invariant",
      format!("The Git engine did not answer {operation}."),
    )),
  }
}

/// `describeReadEngines()`, for `cst doctor`. The native engine is compiled
/// in, so it is always available.
pub fn describe_read_engines() -> GitResult<Value> {
  Ok(object([
    ("selected", string(read_engine()?.name())),
    ("default", string(default_read_engine().name())),
    (
      "available",
      Value::Array(READ_ENGINES.iter().map(|engine| string(engine)).collect()),
    ),
    (
      "native",
      object([
        ("available", Value::Bool(true)),
        ("reason", Value::Null),
        ("profile", string(native::PROFILE)),
        (
          "operations",
          Value::Array(
            native::OPERATIONS
              .iter()
              .map(|operation| string(operation))
              .collect(),
          ),
        ),
      ]),
    ),
  ]))
}

// ---------------------------------------------------------------------------
// Composites: derived from cataloged operations, never from Git directly.
// ---------------------------------------------------------------------------

pub fn current_head(cwd: &str) -> GitResult<String> {
  resolve_revision("HEAD", cwd)
}

pub fn change_id_for_commit(commit: &str, cwd: &str) -> GitResult<String> {
  Ok(
    crate::text::extract_trailer(&commit_message(commit, cwd)?, "Change-Id")
      .unwrap_or_else(|| format!("git:{commit}")),
  )
}

pub fn assert_clean(cwd: &str) -> GitResult<()> {
  let status = porcelain_status(cwd, false)?;
  if status.is_empty() {
    return Ok(());
  }
  Err(
    GitError::new(
      "dirty-worktree",
      "The worktree must be clean for this operation.",
    )
    .details(status),
  )
}

/// Whether the host Git is at least `required` (`"major.minor"`). Output that
/// cannot be parsed counts as new enough, so Git itself reports any failure.
pub fn git_at_least(required: &str, cwd: &str) -> GitResult<bool> {
  let Some(parts) = git_version(cwd)?.parts else {
    return Ok(true);
  };
  for (index, wanted) in required.split('.').map(crate::text::number).enumerate() {
    let actual = parts.get(index).copied().unwrap_or(f64::NAN);
    if actual != wanted {
      return Ok(actual > wanted);
    }
  }
  Ok(true)
}
