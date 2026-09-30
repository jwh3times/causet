//! The gitoxide backend: the five operations `causet-core` is qualified for
//! (ADR-0027), with the checks `src/native-engine.js` applies around the
//! N-API binding. A refusal whose message starts "unsupported " is an
//! unsupported input; anything else is a native error. Either way the seam
//! answers with Git and records why.

use crate::engine::Refusal;
use crate::text;
use crate::types::*;

/// The profile `describeReadEngines` reports.
pub const PROFILE: &str = "files-sha1-resolution-v1";

/// The operations this backend answers, sorted.
pub const OPERATIONS: [&str; 5] = [
  "inspectGitObjects",
  "listNoteEntries",
  "listRefs",
  "readGitObjects",
  "repoContext",
];

fn refusal(message: String) -> Refusal {
  if message.starts_with("unsupported ") {
    Refusal::UnsupportedInput(message)
  } else {
    Refusal::Failed(message)
  }
}

/// `realpathSync.native(path)`, without the verbatim prefix Windows adds.
fn real_path(path: &str) -> Result<String, Refusal> {
  let real = std::fs::canonicalize(path).map_err(|error| Refusal::Failed(error.to_string()))?;
  let real = real.to_string_lossy().into_owned();
  Ok(match real.strip_prefix(r"\\?\UNC\") {
    Some(share) => format!(r"\\{share}"),
    None => real.strip_prefix(r"\\?\").unwrap_or(&real).to_string(),
  })
}

fn directory(cwd: &str) -> String {
  text::resolve_path(cwd)
}

pub fn repo_context(cwd: &str) -> Result<RepoContext, Refusal> {
  let resolved = directory(cwd);
  if resolved.starts_with(r"\\") || real_path(&resolved)? != resolved {
    return Err(refusal("unsupported aliased repository path".into()));
  }
  let context = causet_core::context(&resolved).map_err(refusal)?;
  let mut checked = Vec::new();
  for raw in [context.git_dir, context.common_dir] {
    if !std::path::Path::new(&raw).is_absolute() {
      return Err(refusal("unsupported relative Git directory".into()));
    }
    let normalized = text::resolve_path(&raw);
    if normalized.starts_with(r"\\") || real_path(&normalized)? != normalized {
      return Err(refusal("unsupported aliased Git directory".into()));
    }
    checked.push(normalized);
  }
  let common_dir = checked.pop().expect("two directories");
  let git_dir = checked.pop().expect("two directories");
  Ok(RepoContext {
    root: context.root,
    git_dir,
    common_dir,
    object_format: "sha1".into(),
  })
}

pub fn list_refs(pattern: &str, cwd: &str) -> Result<Vec<RefEntry>, Refusal> {
  Ok(
    causet_core::refs(pattern, &directory(cwd))
      .map_err(refusal)?
      .into_iter()
      .map(|(name, oid)| RefEntry { name, oid })
      .collect(),
  )
}

fn objects(expressions: &[String], cwd: &str, contents: bool) -> Result<Objects, Refusal> {
  let records = if expressions.is_empty() {
    Vec::new()
  } else {
    causet_core::objects(expressions.to_vec(), &directory(cwd), contents)
      .map_err(refusal)?
      .into_iter()
      .map(|record| ObjectRecord {
        expression: record.expression,
        exists: record.oid.is_some(),
        oid: record.oid,
        kind: record.kind,
        size: record.size,
        content: record.content,
      })
      .collect()
  };
  Ok(Objects {
    records,
    with_content: contents,
  })
}

pub fn inspect_git_objects(expressions: &[String], cwd: &str) -> Result<Objects, Refusal> {
  objects(expressions, cwd, false)
}

pub fn read_git_objects(expressions: &[String], cwd: &str) -> Result<Objects, Refusal> {
  objects(expressions, cwd, true)
}

pub fn list_note_entries(notes_ref: &str, cwd: &str) -> Result<Vec<NoteEntry>, Refusal> {
  Ok(
    causet_core::notes(notes_ref, &directory(cwd))
      .map_err(refusal)?
      .into_iter()
      .map(|(note, target)| NoteEntry { note, target })
      .collect(),
  )
}
