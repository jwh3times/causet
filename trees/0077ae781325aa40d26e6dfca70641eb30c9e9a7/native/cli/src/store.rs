//! Local state files, read as `src/store.js` reads them.

use causet_engine::errors::{GitError, GitResult};
use causet_model::json::{Value, parse};
use causet_model::schemas::within_bound;

/// `assertWithinBound(name, actual, subject)`.
pub fn assert_within_bound(name: &str, actual: u64, subject: &str) -> GitResult<()> {
  if within_bound(name, actual) {
    return Ok(());
  }
  let limit = causet_model::registry::RESOURCE_BOUNDS
    .iter()
    .find(|(bound, _)| *bound == name)
    .map_or(0, |(_, limit)| *limit);
  Err(
    GitError::new(
      "resource-bound-exceeded",
      format!("{subject} exceeds the {name} resource bound of {limit}."),
    )
    .details(
      "causet refuses to interpret a record larger than its published resource bound; see docs/schemas/compatibility.md.",
    ),
  )
}

/// `readJson(filePath, fallback)`: `None` when the file does not exist.
pub fn read_json(path: &str) -> GitResult<Option<Value>> {
  let metadata = match std::fs::metadata(path) {
    Ok(metadata) => metadata,
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
    Err(error) => return Err(GitError::new("internal-invariant", error.to_string())),
  };
  assert_within_bound(
    "localStateBytes",
    metadata.len(),
    &format!("Local state file '{path}'"),
  )?;
  let raw = match std::fs::read(path) {
    Ok(raw) => raw,
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
    Err(error) => return Err(GitError::new("internal-invariant", error.to_string())),
  };
  let text = String::from_utf8_lossy(&raw);
  // Node decodes a leading byte-order mark as U+FEFF, which JSON.parse refuses.
  parse(&text).map(Some).map_err(|_| {
    GitError::new(
      "malformed-input",
      format!("Local state file '{path}' is not valid JSON."),
    )
    .details("Recover or remove the file; causet will not guess its contents.")
  })
}

/// `ensureLabRuntime(cwd)`: the runtime directory, created when missing.
pub fn ensure_lab_runtime(cwd: &str) -> GitResult<String> {
  let context = causet_engine::engine::repo_context(cwd)?;
  let directory = causet_engine::locations::runtime_directory(&context.common_dir, cwd)?;
  std::fs::create_dir_all(&directory)
    .map_err(|error| crate::envelope::io_failure(&error, "mkdir", &directory))?;
  Ok(directory)
}

/// `initLab(cwd)`: the runtime directory and the notes configuration, and the
/// repository root it reports.
pub fn init_lab(cwd: &str) -> GitResult<String> {
  let context = causet_engine::engine::repo_context(cwd)?;
  ensure_lab_runtime(cwd)?;
  let notes_ref = causet_engine::locations::names(cwd)?.notes_ref;
  for key in ["notes.displayRef", "notes.rewriteRef"] {
    let args = ["config", key, notes_ref].map(String::from);
    causet_engine::process::run_git(&args, &causet_engine::process::RunOptions::new(&context.root))?;
  }
  Ok(context.root)
}
