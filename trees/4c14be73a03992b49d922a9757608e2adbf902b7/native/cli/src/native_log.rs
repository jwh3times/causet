//! `cst log` in a native repository (#416, ADR-0046 decision 2, ADR-0047
//! decision 12): one revision's history, in Git's order, each commit printed
//! by `--format` as Git prints it, with native IDs (commits.md §6). It reads
//! native commits alone, never the preserved Git commits they derive from,
//! and runs no Git. The rest of `log`, its human output and `--json` among
//! it, is #417's; anything not implemented is refused, never approximated.

use crate::native_repository::{bytes_of, corrupt};
use crate::native_revision::{Hint, Object, Repository, unsupported};
use causet_engine::errors::{GitError, GitResult};
use causet_history::commit::{Commit, Commits};
use causet_history::pretty::{Failure, Format};
use causet_import::store_error;
use causet_store::id::NativeId;
use std::collections::HashSet;
use std::ffi::OsString;
use std::io::Write as _;
use std::path::Path;

const USAGE: &str = "Usage: cst log [<revision>] --format=<format>";

/// Git's `FALLBACK_DEFAULT_ABBREV`.
const SHORTEST: usize = 7;

/// `cst log [<revision>] --format=<format>`: the history of one revision,
/// `HEAD` by default, as `git log --format` prints it. Paths, every other
/// option and a named format are refused.
pub fn log(args: &[OsString], root: &Path) -> GitResult<i32> {
  let mut format = None;
  let mut revisions = Vec::new();
  let mut args = args.iter();
  for arg in args.by_ref() {
    let arg = bytes_of(arg);
    if arg == b"--" {
      break;
    } else if !arg.starts_with(b"-") {
      revisions.push(arg);
    } else if let Some(value) = arg.strip_prefix(b"--format=") {
      format = Some(value.to_vec());
    } else {
      return Err(GitError::new(
        "usage-unknown-option",
        format!(
          "Unknown option '{}' for 'cst log'. {USAGE}",
          String::from_utf8_lossy(&arg)
        ),
      ));
    }
  }
  // What follows `--` is paths, as Git reads them.
  if args.next().is_some() {
    return Err(unsupported("cst log with paths"));
  }
  let format = format.ok_or_else(|| unsupported("cst log without --format"))?;
  let format =
    Format::parse(&format).map_err(|what| unsupported(format!("cst log --format with {what}")))?;
  let revision = match revisions.as_slice() {
    [] => b"HEAD".to_vec(),
    [one] => one.clone(),
    _ => return Err(unsupported("cst log of more than one revision")),
  };
  let repository = Repository::open(root)?;
  let history = History {
    repository: &repository,
    commits: repository.commits().map_err(store_error)?,
  };
  let tip = history.tip(&revision)?;
  let mut out = Vec::new();
  let result = history.print(tip, &format, &mut out);
  let _ = std::io::stdout().lock().write_all(&out);
  result.map(|()| 0)
}

/// A native repository with its native commits read.
struct History<'a> {
  repository: &'a Repository,
  commits: &'a Commits,
}

impl History<'_> {
  /// The native commit a revision names, through tags, as every N1 command
  /// resolves names (commits.md §6). A commit with no native commit is one
  /// an import before native history left.
  fn tip(&self, revision: &[u8]) -> GitResult<NativeId> {
    let shown = String::from_utf8_lossy(revision).into_owned();
    let named = self.repository.resolve_as(revision, Hint::Committish)?;
    let (peeled, kind) = self.repository.deref_tags(named)?;
    if kind != Some(Object::Commit) {
      return Err(GitError::new("not-found", format!("{shown} does not name a commit")));
    }
    if !self.commits.by_id.contains_key(&peeled) {
      return Err(GitError::new(
        "unsupported-feature",
        format!(
          "{shown} names a commit this native repository holds no native commit for, as an import before native history left it. Import the Git repository into it again to derive its history."
        ),
      ));
    }
    Ok(peeled)
  }

  fn commit(&self, id: &NativeId) -> GitResult<&Commit> {
    self.commits.by_id.get(id).ok_or_else(|| {
      corrupt(format!(
        "a native commit names {id} as a parent, which is not a native commit"
      ))
    })
  }

  /// Git's revision walk without limits: the newest commit of those waiting
  /// first, by commit date, each reached once, a commit's parents waiting
  /// behind every commit of their date already waiting
  /// (`commit_list_insert_by_date`). Like Git's list, a wide history costs
  /// time in the number of commits waiting.
  fn print(&self, tip: NativeId, format: &Format, out: &mut Vec<u8>) -> GitResult<()> {
    let mut waiting: Vec<(u64, NativeId)> = vec![(self.commit(&tip)?.date(), tip)];
    let mut seen: HashSet<NativeId> = HashSet::from([tip]);
    let abbrev = |id: &NativeId| self.abbreviate(id);
    let mut first = true;
    while !waiting.is_empty() {
      let (_, id) = waiting.remove(0);
      let commit = self.commit(&id)?;
      if !first && format.separated() {
        out.push(b'\n');
      }
      first = false;
      let text = format
        .render(commit, &id, &abbrev)
        .map_err(|failure| match failure {
          Failure::Unimplemented(what) => {
            unsupported(format!("cst log of the commit {id}, {what},"))
          }
          Failure::Fatal(why) => {
            GitError::new("malformed-input", format!("the commit {id}: {why}"))
          }
          Failure::Abbreviation(error) => error,
        })?;
      out.extend_from_slice(&text);
      for parent in &commit.parents {
        if !seen.insert(*parent) {
          continue;
        }
        let when = self.commit(parent)?.date();
        let at = waiting
          .iter()
          .position(|(other, _)| *other < when)
          .unwrap_or(waiting.len());
        waiting.insert(at, (when, *parent));
      }
    }
    Ok(())
  }

  /// An ID's prefix that names it alone among the objects a prefix may
  /// name (`Repository::candidates`), so a revision resolves it, at least as
  /// long as Git's `core.abbrev=auto` makes one for a store of this many
  /// objects (ADR-0046, decision 5; commits.md §6).
  fn abbreviate(&self, id: &NativeId) -> GitResult<String> {
    let bits = (usize::BITS - self.commits.objects.leading_zeros()) as usize;
    let mut length = bits.div_ceil(2).max(SHORTEST);
    let hex = id.hex();
    while length < hex.len() && self.repository.candidates(&hex[..length])?.len() > 1 {
      length += 1;
    }
    Ok(hex[..length].to_string())
  }
}
