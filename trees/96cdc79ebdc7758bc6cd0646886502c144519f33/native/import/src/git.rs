//! The reads of the source repository: its object format, its refs, its
//! commits' ancestry, and objects' types and bytes, each through `git` with
//! replacement disabled, so every object is read as stored.

use causet_engine::errors::{GitError, GitResult};
use causet_engine::process::{RunOptions, run_git};

/// The most object bytes one `cat-file --batch` returns.
const BATCH_BYTES: u64 = 64 * 1024 * 1024;

fn options(source: &str) -> RunOptions {
  let mut options = RunOptions::new(source).env("GIT_NO_REPLACE_OBJECTS", "1");
  options.import_read = true;
  options
}

fn args(items: &[&str]) -> Vec<String> {
  items.iter().map(|item| item.to_string()).collect()
}

fn malformed(what: &str) -> GitError {
  GitError::new(
    "git-response-malformed",
    format!("git printed {what} that this build could not read"),
  )
}

pub fn object_format(source: &str) -> GitResult<String> {
  Ok(
    run_git(
      &args(&["rev-parse", "--show-object-format"]),
      &options(source),
    )?
    .stdout,
  )
}

/// Every ref `for-each-ref` lists, then `HEAD` when it resolves, as
/// (name, object ID).
pub fn refs(source: &str) -> GitResult<Vec<(String, String)>> {
  let listed = run_git(
    &args(&["for-each-ref", "--format=%(objectname) %(refname)"]),
    &options(source),
  )?
  .stdout;
  let mut refs = Vec::new();
  for line in listed.lines().filter(|line| !line.is_empty()) {
    let (id, name) = line
      .split_once(' ')
      .ok_or_else(|| malformed("a ref line"))?;
    refs.push((name.to_string(), id.to_string()));
  }
  let head = run_git(
    &args(&["rev-parse", "--verify", "--quiet", "HEAD"]),
    &options(source).allow_failure(),
  )?;
  if head.ok && !head.stdout.is_empty() {
    refs.push(("HEAD".into(), head.stdout));
  }
  Ok(refs)
}

/// The commits reachable from these, themselves included, in `rev-list`
/// order. Only commits: their trees are followed by import itself.
pub fn commits(source: &str, starts: &[String]) -> GitResult<Vec<String>> {
  if starts.is_empty() {
    return Ok(Vec::new());
  }
  let input = starts.join("\n") + "\n";
  let listed = run_git(
    &args(&["rev-list", "--stdin"]),
    &options(source).input(input),
  )?
  .stdout;
  Ok(
    listed
      .lines()
      .filter(|line| !line.is_empty())
      .map(str::to_string)
      .collect(),
  )
}

/// Each object's type and size, in the order given.
pub fn types(source: &str, ids: &[String]) -> GitResult<Vec<(String, u64)>> {
  if ids.is_empty() {
    return Ok(Vec::new());
  }
  let input = ids.join("\n") + "\n";
  let listed = run_git(
    &args(&[
      "cat-file",
      "--batch-check=%(objectname) %(objecttype) %(objectsize)",
    ]),
    &options(source).input(input),
  )?
  .stdout;
  let mut types = Vec::with_capacity(ids.len());
  for (line, id) in listed.lines().zip(ids) {
    if line == format!("{id} missing") {
      return Err(GitError::new(
        "unsupported-repository-shape",
        format!(
          "{source} names the object {id} but does not hold it, so it cannot be imported whole"
        ),
      ));
    }
    let mut fields = line.split(' ');
    let (Some(named), Some(kind), Some(size)) = (fields.next(), fields.next(), fields.next())
    else {
      return Err(malformed("an object line"));
    };
    if named != id {
      return Err(malformed("an object line"));
    }
    types.push((
      kind.to_string(),
      size.parse().map_err(|_| malformed("an object size"))?,
    ));
  }
  if types.len() != ids.len() {
    return Err(malformed("fewer object lines than it was asked for"));
  }
  Ok(types)
}

/// The objects' bytes, in batches of at most 64 MiB, passed to `each` in the
/// order given. `sizes` are the objects' sizes from `types`.
pub fn contents(
  source: &str,
  ids: &[String],
  sizes: &[u64],
  each: &mut dyn FnMut(&str, &str, Vec<u8>) -> GitResult<()>,
) -> GitResult<()> {
  let mut start = 0;
  while start < ids.len() {
    let mut end = start;
    let mut bytes = 0;
    while end < ids.len() && (end == start || bytes + sizes[end] <= BATCH_BYTES) {
      bytes += sizes[end];
      end += 1;
    }
    let batch = &ids[start..end];
    let mut options = options(source).binary().input(batch.join("\n") + "\n");
    options.max_buffer = usize::try_from(bytes)
      .unwrap_or(usize::MAX)
      .saturating_add(batch.len() * 128 + 4096);
    let output = run_git(&args(&["cat-file", "--batch"]), &options)?.bytes;
    let mut rest = output.as_slice();
    for id in batch {
      let newline = rest
        .iter()
        .position(|&byte| byte == b'\n')
        .ok_or_else(|| malformed("an object header"))?;
      let header =
        std::str::from_utf8(&rest[..newline]).map_err(|_| malformed("an object header"))?;
      let mut fields = header.split(' ');
      let (Some(named), Some(kind), Some(size)) = (fields.next(), fields.next(), fields.next())
      else {
        return Err(malformed("an object header"));
      };
      let size: usize = size.parse().map_err(|_| malformed("an object size"))?;
      if named != id || rest.len() < newline + 1 + size + 1 || rest[newline + 1 + size] != b'\n' {
        return Err(malformed("an object"));
      }
      let body = rest[newline + 1..newline + 1 + size].to_vec();
      let kind = kind.to_string();
      rest = &rest[newline + 1 + size + 1..];
      each(id, &kind, body)?;
    }
    start = end;
  }
  Ok(())
}
