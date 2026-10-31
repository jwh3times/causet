//! The Git engine: the Git implementation of every operation in the catalog,
//! as `src/git.js` implements it. Each operation is one process or the
//! object session, parses Git's output with the same expressions, and fails
//! with the same codes and messages.
//!
//! Domain code calls the seam (`crate::engine`), never these functions.

use crate::errors::{GitError, GitResult};
use crate::process::{GitOutput, RunOptions, read_git, read_text};
use crate::session::{self, Query, SessionObject, parse_header, validate_expressions};
use crate::text;
use crate::types::*;
use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap, HashSet};

thread_local! {
  static CONTEXTS: RefCell<HashMap<String, RepoContext>> = RefCell::new(HashMap::new());
  static GIT_VERSION: RefCell<Option<GitVersion>> = const { RefCell::new(None) };
}

fn lines(text: &str) -> Vec<String> {
  text::split_lines(text)
    .into_iter()
    .filter(|line| !line.is_empty())
    .map(str::to_string)
    .collect()
}

fn nul_fields(text: &str) -> Vec<String> {
  text
    .split('\0')
    .filter(|field| !field.is_empty())
    .map(str::to_string)
    .collect()
}

fn owned(items: &[&str]) -> Vec<String> {
  items.iter().map(|item| item.to_string()).collect()
}

fn read(args: &[String], options: RunOptions) -> GitResult<GitOutput> {
  let args: Vec<&str> = args.iter().map(String::as_str).collect();
  read_git(&args, options)
}

// ---------------------------------------------------------------------------
// Repository and host
// ---------------------------------------------------------------------------

pub fn repo_context(cwd: &str) -> GitResult<RepoContext> {
  let key = text::resolve_path(cwd);
  if let Some(context) = CONTEXTS.with(|contexts| contexts.borrow().get(&key).cloned()) {
    return Ok(context);
  }
  let output = read_text(
    &[
      "rev-parse",
      "--show-toplevel",
      "--git-dir",
      "--git-common-dir",
      "--show-object-format",
    ],
    cwd,
  )?;
  let fields = text::split_lines(&output);
  let field = |index: usize| fields.get(index).copied().unwrap_or("");
  let (root, git_dir, common_dir, object_format) = (field(0), field(1), field(2), field(3));
  if root.is_empty()
    || git_dir.is_empty()
    || common_dir.is_empty()
    || !["sha1", "sha256"].contains(&object_format)
  {
    return Err(GitError::new(
      "git-response-malformed",
      "Git did not return a complete repository context.",
    ));
  }
  let context = RepoContext {
    root: text::resolve_path(root),
    git_dir: text::resolve(cwd, git_dir),
    common_dir: text::resolve(cwd, common_dir),
    object_format: object_format.to_string(),
  };
  CONTEXTS.with(|contexts| contexts.borrow_mut().insert(key, context.clone()));
  Ok(context)
}

/// `/(\d+)\.(\d+)(?:\.(\d+))?/`, leftmost.
fn version_parts(raw: &str) -> Option<[f64; 3]> {
  let bytes = raw.as_bytes();
  let run = |mut index: usize| {
    let start = index;
    while index < bytes.len() && bytes[index].is_ascii_digit() {
      index += 1;
    }
    (start, index)
  };
  let mut index = 0;
  while index < bytes.len() {
    if !bytes[index].is_ascii_digit() {
      index += 1;
      continue;
    }
    let (start, end) = run(index);
    if end + 1 < bytes.len() && bytes[end] == b'.' && bytes[end + 1].is_ascii_digit() {
      let (minor_start, minor_end) = run(end + 1);
      let patch = if minor_end + 1 < bytes.len()
        && bytes[minor_end] == b'.'
        && bytes[minor_end + 1].is_ascii_digit()
      {
        let (patch_start, patch_end) = run(minor_end + 1);
        text::number(&raw[patch_start..patch_end])
      } else {
        0.0
      };
      return Some([
        text::number(&raw[start..end]),
        text::number(&raw[minor_start..minor_end]),
        patch,
      ]);
    }
    index = end;
  }
  None
}

/// `git --version`, run at most once per process.
pub fn git_version(cwd: &str) -> GitResult<GitVersion> {
  if let Some(version) = GIT_VERSION.with(|cached| cached.borrow().clone()) {
    return Ok(version);
  }
  let raw = text::trim(&read_git(&["--version"], RunOptions::new(cwd))?.stdout).to_string();
  let version = GitVersion {
    parts: version_parts(&raw),
    raw,
  };
  GIT_VERSION.with(|cached| *cached.borrow_mut() = Some(version.clone()));
  Ok(version)
}

pub fn is_inside_work_tree(cwd: &str) -> GitResult<bool> {
  let probe = read_git(
    &["rev-parse", "--is-inside-work-tree"],
    RunOptions::new(cwd).allow_failure(),
  )?;
  Ok(probe.ok && probe.stdout == "true")
}

pub fn git_path(name: &str, cwd: &str) -> GitResult<String> {
  read_text(&["rev-parse", "--git-path", name], cwd)
}

// ---------------------------------------------------------------------------
// Objects
// ---------------------------------------------------------------------------

fn session_one(cwd: &str, query: Query, expression: String) -> Option<SessionObject> {
  session::query(cwd, query, &[expression]).and_then(|mut objects| objects.pop())
}

fn resolve_peeled(revision: &str, peel: &str, noun: &str, cwd: &str) -> GitResult<String> {
  let expression = format!("{revision}^{{{peel}}}");
  let failure = || {
    GitError::new(
      "revision-not-resolved",
      format!("Git revision '{revision}' did not resolve to a {noun}."),
    )
  };
  if let Some(object) = session_one(cwd, Query::Info, expression.clone()) {
    if !object.exists || object.kind.as_deref() != Some(peel) {
      return Err(failure());
    }
    return Ok(object.oid.unwrap_or_default());
  }
  let result = read_git(
    &["rev-parse", "--verify", "--quiet", &expression],
    RunOptions::new(cwd).allow_failure(),
  )?;
  if !result.ok || result.stdout.is_empty() {
    return Err(failure().details(result.stderr));
  }
  Ok(result.stdout)
}

pub fn resolve_revision(revision: &str, cwd: &str) -> GitResult<String> {
  resolve_peeled(revision, "commit", "commit", cwd)
}

pub fn resolve_object_ids(expressions: &[String], cwd: &str) -> GitResult<Vec<String>> {
  if expressions.is_empty() {
    return Ok(Vec::new());
  }
  let failure = || {
    GitError::new(
      "revision-not-resolved",
      "Git did not resolve every requested object expression.",
    )
  };
  if let Some(objects) = session::query(cwd, Query::Info, expressions) {
    if objects.iter().any(|object| !object.exists) {
      return Err(failure());
    }
    return Ok(
      objects
        .into_iter()
        .map(|object| object.oid.unwrap_or_default())
        .collect(),
    );
  }
  let mut args = owned(&["rev-parse"]);
  args.extend(expressions.iter().cloned());
  let result = read(&args, RunOptions::new(cwd).allow_failure())?;
  let ids = if result.ok {
    lines(&result.stdout)
  } else {
    Vec::new()
  };
  if !result.ok || ids.len() != expressions.len() {
    return Err(failure().details(if result.ok {
      String::new()
    } else {
      result.stderr
    }));
  }
  Ok(ids)
}

pub fn revision_resolves(name: &str, cwd: &str) -> GitResult<bool> {
  Ok(
    read_git(
      &["rev-parse", "--verify", "--quiet", name],
      RunOptions::new(cwd).allow_failure(),
    )?
    .ok,
  )
}

pub fn tree_id(revision: &str, cwd: &str) -> GitResult<String> {
  resolve_peeled(revision, "tree", "tree", cwd)
}

pub fn read_git_blob(blob: &str, cwd: &str) -> GitResult<Vec<u8>> {
  let failure = || {
    GitError::new(
      "revision-not-resolved",
      format!("Git object '{blob}' is not a blob."),
    )
  };
  if let Some(object) = session_one(cwd, Query::Contents, blob.to_string()) {
    if !object.exists || object.kind.as_deref() != Some("blob") {
      return Err(failure());
    }
    return Ok(object.content.unwrap_or_default());
  }
  let result = read_git(
    &["cat-file", "blob", blob],
    RunOptions::new(cwd).binary().allow_failure(),
  )?;
  if !result.ok {
    return Err(failure().details(result.stderr));
  }
  Ok(result.bytes)
}

fn record(object: SessionObject) -> ObjectRecord {
  ObjectRecord {
    expression: object.expression,
    exists: object.exists,
    oid: object.oid,
    kind: object.kind,
    size: object.size,
    content: object.content,
  }
}

pub fn read_git_objects(expressions: &[String], cwd: &str) -> GitResult<Objects> {
  let objects = |records| Objects {
    records,
    with_content: true,
  };
  if expressions.is_empty() {
    return Ok(objects(Vec::new()));
  }
  validate_expressions(expressions)?;
  if let Some(answers) = session::query(cwd, Query::Contents, expressions) {
    return Ok(objects(answers.into_iter().map(record).collect()));
  }
  let input = format!("{}\n", expressions.join("\n"));
  let response = read_git(
    &["cat-file", "--batch"],
    RunOptions::new(cwd).binary().input(input),
  )?
  .bytes;
  Ok(objects(parse_batch(&response, expressions)?))
}

/// `git cat-file --batch` output, one record per expression.
fn parse_batch(response: &[u8], expressions: &[String]) -> GitResult<Vec<ObjectRecord>> {
  let mut results = Vec::with_capacity(expressions.len());
  let mut offset = 0;
  for expression in expressions {
    let Some(newline) = response[offset.min(response.len())..]
      .iter()
      .position(|byte| *byte == b'\n')
      .map(|index| offset + index)
    else {
      return Err(GitError::new(
        "git-response-malformed",
        "Git returned a truncated cat-file batch response.",
      ));
    };
    let header = String::from_utf8_lossy(&response[offset..newline]).into_owned();
    offset = newline + 1;
    if header.ends_with(" missing") {
      results.push(ObjectRecord {
        expression: expression.clone(),
        exists: false,
        oid: None,
        kind: None,
        size: 0,
        content: None,
      });
      continue;
    }
    let Some((oid, kind, size)) = parse_header(&header) else {
      return Err(GitError::new(
        "git-response-malformed",
        format!("Unexpected git cat-file batch header: {header}"),
      ));
    };
    let end = offset.saturating_add(usize::try_from(size).unwrap_or(usize::MAX));
    if end >= response.len() || response[end] != b'\n' {
      return Err(GitError::new(
        "git-response-malformed",
        "Git returned a malformed cat-file batch object.",
      ));
    }
    results.push(ObjectRecord {
      expression: expression.clone(),
      exists: true,
      oid: Some(oid),
      kind: Some(kind),
      size,
      content: Some(response[offset..end].to_vec()),
    });
    offset = end + 1;
  }
  Ok(results)
}

pub fn inspect_git_objects(expressions: &[String], cwd: &str) -> GitResult<Objects> {
  let objects = |records| Objects {
    records,
    with_content: false,
  };
  if expressions.is_empty() {
    return Ok(objects(Vec::new()));
  }
  validate_expressions(expressions)?;
  if let Some(answers) = session::query(cwd, Query::Info, expressions) {
    return Ok(objects(
      answers
        .into_iter()
        .zip(expressions)
        .map(|(object, expression)| ObjectRecord {
          expression: expression.clone(),
          exists: object.exists,
          oid: if object.exists { object.oid } else { None },
          kind: if object.exists { object.kind } else { None },
          size: if object.exists { object.size } else { 0 },
          content: None,
        })
        .collect(),
    ));
  }
  let output = read_git(
    &["cat-file", "--batch-check"],
    RunOptions::new(cwd)
      .untrimmed()
      .input(format!("{}\n", expressions.join("\n"))),
  )?
  .stdout;
  Ok(objects(parse_batch_check(&output, expressions)?))
}

/// `git cat-file --batch-check` output, one line per expression.
fn parse_batch_check(output: &str, expressions: &[String]) -> GitResult<Vec<ObjectRecord>> {
  let mut fields: Vec<&str> = output.split('\n').collect();
  if fields.last() == Some(&"") {
    fields.pop();
  }
  if fields.len() != expressions.len() {
    return Err(GitError::new(
      "git-response-malformed",
      "Git did not classify every requested object expression.",
    ));
  }
  let mut records = Vec::with_capacity(expressions.len());
  for (expression, line) in expressions.iter().zip(fields) {
    if line.ends_with(" missing") || line.ends_with(" ambiguous") {
      records.push(ObjectRecord {
        expression: expression.clone(),
        exists: false,
        oid: None,
        kind: None,
        size: 0,
        content: None,
      });
      continue;
    }
    let Some((oid, kind, size)) = parse_header(line) else {
      return Err(GitError::new(
        "git-response-malformed",
        format!("Unexpected git cat-file batch-check line: {line}"),
      ));
    };
    records.push(ObjectRecord {
      expression: expression.clone(),
      exists: true,
      oid: Some(oid),
      kind: Some(kind),
      size,
      content: None,
    });
  }
  Ok(records)
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

pub fn merge_base(left: &str, right: &str, cwd: &str) -> GitResult<String> {
  read_text(&["merge-base", left, right], cwd)
}

pub fn is_ancestor(ancestor: &str, descendant: &str, cwd: &str) -> GitResult<bool> {
  Ok(
    read_git(
      &["merge-base", "--is-ancestor", ancestor, descendant],
      RunOptions::new(cwd).allow_failure(),
    )?
    .ok,
  )
}

pub fn list_commits(base: &str, tip: &str, cwd: &str) -> GitResult<Vec<String>> {
  Ok(lines(&read_text(
    &["rev-list", "--reverse", &format!("{base}..{tip}")],
    cwd,
  )?))
}

pub fn reachable_commits(revision: &str, cwd: &str) -> GitResult<Vec<String>> {
  Ok(lines(&read_text(&["rev-list", revision], cwd)?))
}

pub fn count_commits(revision: &str, cwd: &str) -> GitResult<f64> {
  Ok(text::number(&read_text(
    &["rev-list", "--count", revision],
    cwd,
  )?))
}

pub fn merge_commits_between(base: &str, tip: &str, cwd: &str) -> GitResult<Vec<String>> {
  let output = read_text(&["rev-list", "--parents", &format!("{base}..{tip}")], cwd)?;
  if output.is_empty() {
    return Ok(Vec::new());
  }
  let mut merges: Vec<String> = text::split_lines(&output)
    .into_iter()
    .map(|line| text::split_space_runs(text::trim(line)))
    .filter(|fields| fields.len() > 2)
    .map(|fields| fields[0].to_string())
    .collect();
  text::sort(&mut merges);
  Ok(merges)
}

fn parent_rows(output: &str) -> Vec<CommitParents> {
  lines(output)
    .iter()
    .map(|line| {
      let mut fields = text::split_space_runs(text::trim(line))
        .into_iter()
        .filter(|field| !field.is_empty())
        .map(str::to_string);
      CommitParents {
        commit: fields.next().unwrap_or_default(),
        parents: fields.collect(),
      }
    })
    .collect()
}

pub fn commit_topology(base: &str, tip: &str, cwd: &str) -> GitResult<Vec<CommitParents>> {
  validate_expressions(&[base, tip])?;
  let output = read_text(
    &[
      "rev-list",
      "--parents",
      "--topo-order",
      "--reverse",
      &format!("{base}..{tip}"),
    ],
    cwd,
  )?;
  Ok(parent_rows(&output))
}

pub fn root_commits(cwd: &str) -> GitResult<Vec<String>> {
  // Replacement refs and grafts must not turn an unrelated lineage into a
  // shared one (issue #88).
  let result = read_git(
    &[
      "rev-list",
      "--max-parents=0",
      "--branches",
      "--tags",
      "--remotes",
    ],
    RunOptions::new(cwd)
      .allow_failure()
      .env("GIT_NO_REPLACE_OBJECTS", "1"),
  )?;
  let mut seen = HashSet::new();
  let mut roots: Vec<String> = if result.ok && !result.stdout.is_empty() {
    lines(&result.stdout)
  } else {
    Vec::new()
  };
  roots.retain(|root| seen.insert(root.clone()));
  text::sort(&mut roots);
  Ok(roots)
}

pub fn commit_history(
  revisions: &[String],
  cwd: &str,
  options: HistoryOptions,
) -> GitResult<Vec<CommitRecord>> {
  let mut args = owned(&["log", "-z"]);
  if options.reverse {
    args.push("--reverse".into());
  }
  if options.paths {
    args.push("--name-only".into());
  }
  args.push("--format=%x00%H%x00%s%x00%B".into());
  args.extend(revisions.iter().cloned());
  let output = read(&args, RunOptions::new(cwd).untrimmed())?.stdout;
  Ok(parse_history(&output, options.paths))
}

/// `git log -z --format=%x00%H%x00%s%x00%B [--name-only]` output. Every record
/// starts with an empty field, which is what bounds a `-z` name list.
fn parse_history(output: &str, with_paths: bool) -> Vec<CommitRecord> {
  let fields: Vec<&str> = output.split('\0').collect();
  let mut records = Vec::new();
  let mut index = 0;
  while index < fields.len() {
    if !fields[index].is_empty() {
      index += 1;
      continue;
    }
    if index + 3 >= fields.len() {
      break;
    }
    let commit = text::trim(fields[index + 1]);
    if commit.is_empty() {
      index += 1;
      continue;
    }
    let mut entry = CommitRecord {
      commit: commit.to_string(),
      subject: fields[index + 2].to_string(),
      message: fields[index + 3].to_string(),
      changed_paths: None,
    };
    index += 4;
    if with_paths {
      let mut paths = Vec::new();
      while index < fields.len() && !fields[index].is_empty() {
        let field = fields[index];
        let path = field.strip_prefix('\n').unwrap_or(field);
        if !path.is_empty() {
          paths.push(path.to_string());
        }
        index += 1;
      }
      entry.changed_paths = Some(paths);
    }
    records.push(entry);
  }
  records
}

pub fn commit_message(commit: &str, cwd: &str) -> GitResult<String> {
  let failure = || {
    GitError::new(
      "revision-not-resolved",
      format!("Git revision '{commit}' did not resolve to a commit."),
    )
  };
  if let Some(object) = session_one(cwd, Query::Contents, format!("{commit}^{{commit}}")) {
    if !object.exists || object.kind.as_deref() != Some("commit") {
      return Err(failure());
    }
    let raw = String::from_utf8_lossy(object.content.as_deref().unwrap_or_default()).into_owned();
    let message = raw
      .find("\n\n")
      .map_or("", |separator| &raw[separator + 2..]);
    return Ok(text::trim(message).to_string());
  }
  let result = read_git(
    &["show", "-s", "--format=%B", &format!("{commit}^{{commit}}")],
    RunOptions::new(cwd).allow_failure(),
  )?;
  if !result.ok {
    return Err(failure().details(result.stderr));
  }
  Ok(result.stdout)
}

pub fn commit_subject(commit: &str, cwd: &str) -> GitResult<String> {
  if session::healthy(cwd) {
    let message = commit_message(commit, cwd)?;
    return Ok(text::split_lines(&message)[0].to_string());
  }
  read_text(&["show", "-s", "--format=%s", commit], cwd)
}

pub fn find_commits_by_change_id(change_id: &str, cwd: &str) -> GitResult<Vec<String>> {
  let output = read_git(
    &["log", "--all", "--format=%H%x1f%ct%x1f%B%x1e"],
    RunOptions::new(cwd).untrimmed(),
  )?
  .stdout;
  Ok(parse_bearers(&output, change_id))
}

/// The commits of `git log --all --format=%H%x1f%ct%x1f%B%x1e` output whose
/// `Change-Id` trailer is `change_id`, earliest committer date first.
fn parse_bearers(output: &str, change_id: &str) -> Vec<String> {
  let mut bearers: Vec<(String, f64)> = Vec::new();
  for entry in output.split('\u{1e}') {
    if text::trim(entry).is_empty() {
      continue;
    }
    let Some(first) = entry.find('\u{1f}') else {
      continue;
    };
    let Some(second) = entry[first + 1..]
      .find('\u{1f}')
      .map(|index| first + 1 + index)
    else {
      continue;
    };
    let commit = text::trim(&entry[..first]).to_string();
    let committed_at = text::number(&entry[first + 1..second]);
    let message = &entry[second + 1..];
    if text::extract_trailer(message, "Change-Id").as_deref() == Some(change_id) {
      bearers.push((commit, committed_at));
    }
  }
  bearers.sort_by(|left, right| {
    let delta = left.1 - right.1;
    if delta != 0.0 && !delta.is_nan() {
      delta.partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal)
    } else {
      text::compare(&left.0, &right.0)
    }
  });
  bearers.into_iter().map(|(commit, _)| commit).collect()
}

/// `/^(-|\+)\s+([0-9a-f]+)/i`.
fn cherry_line(line: &str) -> Option<(char, String)> {
  let mut chars = line.chars().peekable();
  let sign = chars.next().filter(|sign| *sign == '-' || *sign == '+')?;
  let mut spaces = 0;
  while chars.peek().is_some_and(|c| text::is_space(*c)) {
    chars.next();
    spaces += 1;
  }
  if spaces == 0 {
    return None;
  }
  let hex: String = chars.take_while(char::is_ascii_hexdigit).collect();
  (!hex.is_empty()).then_some((sign, hex))
}

pub fn patch_equivalent_commits(
  target: &str,
  source: &str,
  base: &str,
  cwd: &str,
) -> GitResult<Vec<String>> {
  let result = read_git(
    &["cherry", target, source, base],
    RunOptions::new(cwd).allow_failure(),
  )?;
  if !result.ok || result.stdout.is_empty() {
    return Ok(Vec::new());
  }
  Ok(
    text::split_lines(&result.stdout)
      .into_iter()
      .filter_map(cherry_line)
      .filter(|(sign, _)| *sign == '-')
      .map(|(_, commit)| commit)
      .collect(),
  )
}

pub fn history_graph(cwd: &str) -> GitResult<String> {
  read_text(
    &[
      "log",
      "--graph",
      "--oneline",
      "--decorate",
      "--branches",
      "--tags",
      "--remotes",
      "HEAD",
    ],
    cwd,
  )
}

pub fn ancestry_path(from: &str, to: &str, cwd: &str) -> GitResult<Vec<CommitParents>> {
  validate_expressions(&[from, to])?;
  let scan = read_git(
    &[
      "rev-list",
      "--ancestry-path",
      "--topo-order",
      "--parents",
      &format!("{to}..{from}"),
    ],
    RunOptions::new(cwd).allow_failure(),
  )?;
  if !scan.ok {
    return Ok(Vec::new());
  }
  let mut on_path: HashSet<String> = HashSet::from([to.to_string()]);
  let rows: Vec<CommitParents> = lines(&scan.stdout)
    .iter()
    .map(|line| {
      let mut fields = line
        .split(' ')
        .filter(|field| !field.is_empty())
        .map(str::to_string);
      let row = CommitParents {
        commit: fields.next().unwrap_or_default(),
        parents: fields.collect(),
      };
      on_path.insert(row.commit.clone());
      row
    })
    .collect();
  Ok(
    rows
      .into_iter()
      .map(|row| CommitParents {
        parents: row
          .parents
          .into_iter()
          .filter(|parent| on_path.contains(parent))
          .collect(),
        commit: row.commit,
      })
      .collect(),
  )
}

pub fn tree_paths(tree: &str, cwd: &str) -> GitResult<Vec<String>> {
  validate_expressions(&[tree])?;
  let listed = read_git(
    &["ls-tree", "-r", "--name-only", "-z", tree],
    RunOptions::new(cwd).allow_failure(),
  )?;
  if !listed.ok {
    return Ok(Vec::new());
  }
  Ok(nul_fields(&listed.stdout))
}

pub fn remote_refs(remote: &str, cwd: &str) -> GitResult<Option<Vec<RefEntry>>> {
  validate_expressions(&[remote])?;
  let scan = read_git(&["ls-remote", remote], RunOptions::new(cwd).allow_failure())?;
  if !scan.ok {
    return Ok(None);
  }
  let mut entries = Vec::new();
  for line in lines(&scan.stdout) {
    let fields = text::split_space_runs(&line);
    let (oid, name) = (
      fields.first().copied().unwrap_or(""),
      fields.get(1).copied().unwrap_or(""),
    );
    if !oid.is_empty() && !name.is_empty() {
      entries.push(RefEntry {
        name: name.to_string(),
        oid: oid.to_string(),
      });
    }
  }
  Ok(Some(entries))
}

// ---------------------------------------------------------------------------
// Refs and notes
// ---------------------------------------------------------------------------

pub fn ref_exists(name: &str, cwd: &str) -> GitResult<bool> {
  Ok(
    read_git(
      &["show-ref", "--verify", "--quiet", name],
      RunOptions::new(cwd).allow_failure(),
    )?
    .ok,
  )
}

pub fn ref_target(name: &str, cwd: &str) -> GitResult<Option<String>> {
  let result = read_git(
    &["show-ref", "--verify", "--hash", name],
    RunOptions::new(cwd).allow_failure(),
  )?;
  Ok(result.ok.then_some(result.stdout))
}

pub fn list_refs(pattern: &str, cwd: &str) -> GitResult<Vec<RefEntry>> {
  let scan = read_git(
    &[
      "for-each-ref",
      "--format=%(refname)%00%(objectname)",
      pattern,
    ],
    RunOptions::new(cwd).allow_failure(),
  )?;
  if !scan.ok {
    return Err(
      GitError::new(
        "git-command-failed",
        format!("Could not scan refs under '{pattern}'."),
      )
      .details(scan.stderr),
    );
  }
  let mut entries = Vec::new();
  for line in text::split_lines(&scan.stdout) {
    if line.is_empty() {
      continue;
    }
    let mut fields = line.split('\0');
    let (name, oid) = (fields.next().unwrap_or(""), fields.next().unwrap_or(""));
    if !name.is_empty() && !oid.is_empty() {
      entries.push(RefEntry {
        name: name.to_string(),
        oid: oid.to_string(),
      });
    }
  }
  Ok(entries)
}

pub fn symbolic_ref(name: &str, cwd: &str, short: bool) -> GitResult<Option<String>> {
  let mut args = vec!["symbolic-ref", "--quiet"];
  if short {
    args.push("--short");
  }
  args.push(name);
  let result = read_git(&args, RunOptions::new(cwd).allow_failure())?;
  Ok((result.ok && !result.stdout.is_empty()).then_some(result.stdout))
}

pub fn pseudo_ref_target(name: &str, cwd: &str) -> GitResult<Option<String>> {
  let result = read_git(
    &[
      "rev-parse",
      &format!("{name}^{{commit}}"),
      "--symbolic-full-name",
      name,
    ],
    RunOptions::new(cwd).allow_failure(),
  )?;
  if !result.ok {
    return Ok(None);
  }
  let fields = text::split_lines(&result.stdout);
  let oid = fields.first().copied().unwrap_or("");
  let full_name = fields.get(1).copied().unwrap_or("");
  // A branch named like the pseudo-ref must not pass for a pending
  // operation: only a name outside `refs/` is the sequencer's.
  if full_name.starts_with("refs/") {
    return Ok(None);
  }
  let valid = (40..=64).contains(&oid.len()) && oid.bytes().all(|byte| byte.is_ascii_hexdigit());
  Ok(valid.then(|| oid.to_string()))
}

enum NoteTreeEntry {
  Note { target: String, note: String },
  Fanout { tree: String, prefix: String },
}

/// The entries of one raw notes tree that Git would load: notes at the full
/// hash width and two-hex-digit fanout directories before it (notes.c,
/// load_subtree). `None` when the tree is malformed, which delegates the
/// whole listing to Git.
fn parse_note_tree(content: &[u8], width: usize, prefix: &str) -> Option<Vec<NoteTreeEntry>> {
  let mut entries = Vec::new();
  let mut offset = 0;
  while offset < content.len() {
    let space = content[offset..]
      .iter()
      .position(|byte| *byte == b' ')
      .map(|at| offset + at)?;
    let nul = content[space + 1..]
      .iter()
      .position(|byte| *byte == 0)
      .map(|at| space + 1 + at)?;
    if nul + 1 + width > content.len() {
      return None;
    }
    let mode_text = &content[offset..space];
    if mode_text.is_empty()
      || mode_text.len() > 6
      || !mode_text.iter().all(|byte| (b'0'..=b'7').contains(byte))
    {
      return None;
    }
    let mode = u32::from_str_radix(std::str::from_utf8(mode_text).ok()?, 8).ok()? & 0o170000;
    let entry_name = String::from_utf8_lossy(&content[space + 1..nul]).into_owned();
    let oid: String = content[nul + 1..nul + 1 + width]
      .iter()
      .map(|byte| format!("{byte:02x}"))
      .collect();
    offset = nul + 1 + width;
    if entry_name.is_empty() || !entry_name.bytes().all(|byte| byte.is_ascii_hexdigit()) {
      continue;
    }
    let target = format!("{prefix}{entry_name}").to_lowercase();
    if target.len() == width * 2 && mode == 0o100000 {
      if !oid.bytes().all(|byte| byte == b'0') {
        entries.push(NoteTreeEntry::Note { target, note: oid });
      }
    } else if entry_name.len() == 2 && target.len() < width * 2 && mode == 0o040000 {
      entries.push(NoteTreeEntry::Fanout {
        tree: oid,
        prefix: target,
      });
    }
  }
  Some(entries)
}

// These are optimization budgets, not input limits: exceeding either delegates
// the entire listing to Git. Never return a partial catalog.
const NOTES_SESSION_MAX_TREES: usize = 1024;
const NOTES_SESSION_MAX_BYTES: u64 = 16 * 1024 * 1024;

/// `sessionNoteEntries`: the notes tree walked through the object session,
/// or `None` to delegate the whole listing to `git notes list`.
fn session_note_entries(notes_ref: &str, cwd: &str) -> Option<Vec<NoteEntry>> {
  if notes_ref.is_empty()
    || !notes_ref
      .bytes()
      .all(|byte| byte.is_ascii_alphanumeric() || b"._/-".contains(&byte))
  {
    return None;
  }
  let name = if notes_ref.starts_with("refs/notes/") {
    notes_ref.to_string()
  } else if notes_ref.starts_with("notes/") {
    format!("refs/{notes_ref}")
  } else {
    format!("refs/notes/{notes_ref}")
  };
  let mut pending: Vec<(String, String)> = vec![(format!("{name}^{{tree}}"), String::new())];
  let mut notes: BTreeMap<String, String> = BTreeMap::new();
  let mut tree_count = 0;
  let mut total_bytes: u64 = 0;
  while !pending.is_empty() {
    let batch: Vec<(String, String)> = pending.drain(..pending.len().min(64)).collect();
    tree_count += batch.len();
    if tree_count + pending.len() > NOTES_SESSION_MAX_TREES {
      return None;
    }
    let expressions: Vec<String> = batch
      .iter()
      .map(|(expression, _)| expression.clone())
      .collect();
    let headers = session::query(cwd, Query::Info, &expressions)?;
    if tree_count == 1 && !headers[0].exists {
      return Some(Vec::new());
    }
    for header in &headers {
      if !header.exists || header.kind.as_deref() != Some("tree") {
        return None;
      }
      total_bytes += header.size;
      if total_bytes > NOTES_SESSION_MAX_BYTES {
        return None;
      }
    }
    // Size checks precede content reads, and the mutable root is pinned to
    // the object ID just inspected.
    let ids: Vec<String> = headers
      .iter()
      .map(|header| header.oid.clone().unwrap_or_default())
      .collect();
    let objects = session::query(cwd, Query::Contents, &ids)?;
    for (index, object) in objects.iter().enumerate() {
      if !object.exists || object.kind.as_deref() != Some("tree") {
        return None;
      }
      let width = object.oid.as_ref().map_or(0, |oid| oid.len() / 2);
      let content = object.content.as_deref().unwrap_or_default();
      for entry in parse_note_tree(content, width, &batch[index].1)? {
        match entry {
          NoteTreeEntry::Note { target, note } => {
            // Git concatenates duplicate attachments while loading the tree;
            // delegate rather than reimplement that.
            if notes.contains_key(&target) {
              return None;
            }
            notes.insert(target, note);
          }
          NoteTreeEntry::Fanout { tree, prefix } => {
            pending.push((tree, prefix));
            if tree_count + pending.len() > NOTES_SESSION_MAX_TREES {
              return None;
            }
          }
        }
      }
    }
  }
  Some(
    notes
      .into_iter()
      .map(|(target, note)| NoteEntry { note, target })
      .collect(),
  )
}

pub fn list_note_entries(notes_ref: &str, cwd: &str) -> GitResult<Vec<NoteEntry>> {
  if let Some(entries) = session_note_entries(notes_ref, cwd) {
    return Ok(entries);
  }
  let result = read_git(
    &["notes", &format!("--ref={notes_ref}"), "list"],
    RunOptions::new(cwd).allow_failure(),
  )?;
  if !result.ok || result.stdout.is_empty() {
    return Ok(Vec::new());
  }
  Ok(
    lines(&result.stdout)
      .iter()
      .filter_map(|line| {
        let fields = text::split_space_runs(text::trim(line));
        let note = fields.first().copied().unwrap_or("");
        let target = fields.get(1).copied().unwrap_or("");
        (!note.is_empty() && !target.is_empty()).then(|| NoteEntry {
          note: note.to_string(),
          target: target.to_string(),
        })
      })
      .collect(),
  )
}

pub fn read_note_text(notes_ref: &str, target: &str, cwd: &str) -> GitResult<Option<String>> {
  let result = read_git(
    &["notes", &format!("--ref={notes_ref}"), "show", target],
    RunOptions::new(cwd).allow_failure(),
  )?;
  Ok(result.ok.then_some(result.stdout))
}

// ---------------------------------------------------------------------------
// Worktree, index, and status
// ---------------------------------------------------------------------------

pub fn workspace_status(cwd: &str) -> GitResult<WorkspaceStatus> {
  let status = read_git(
    &["status", "--porcelain=v2", "--branch", "-z"],
    RunOptions::new(cwd).allow_failure().untrimmed(),
  )?;
  if !status.ok {
    return Ok(WorkspaceStatus {
      ok: false,
      head: None,
      dirty_files: None,
      error: Some(status.output),
      exit_code: if status.status == 0 { 1 } else { status.status },
    });
  }
  let (head, dirty_files) = parse_status(&status.stdout);
  Ok(WorkspaceStatus {
    ok: true,
    head,
    dirty_files: Some(dirty_files),
    error: None,
    exit_code: 0,
  })
}

/// `git status --porcelain=v2 --branch -z`: the exact HEAD and the number of
/// changed or untracked entries. A rename or copy (`2 ...`) carries its
/// original path in a second field that is not another entry.
fn parse_status(output: &str) -> (Option<String>, f64) {
  let mut head = None;
  let mut dirty_files = 0.0;
  let fields: Vec<&str> = output.split('\0').collect();
  let mut index = 0;
  while index < fields.len() {
    let field = fields[index];
    if field.is_empty() {
      index += 1;
      continue;
    }
    if let Some(header) = field.strip_prefix("# ") {
      if let Some(oid) = header.strip_prefix("branch.oid ") {
        head = (oid != "(initial)").then(|| oid.to_string());
      }
      index += 1;
      continue;
    }
    dirty_files += 1.0;
    if field.starts_with("2 ") {
      index += 1;
    }
    index += 1;
  }
  (head, dirty_files)
}

pub fn porcelain_status(cwd: &str, nul_terminated: bool) -> GitResult<String> {
  let mut args = vec!["status", "--porcelain=v1"];
  if nul_terminated {
    args.push("-z");
  }
  let mut options = RunOptions::new(cwd);
  options.trim = !nul_terminated;
  Ok(read_git(&args, options)?.stdout)
}

pub fn unmerged_paths(cwd: &str) -> GitResult<Vec<String>> {
  let result = read_git(
    &["diff", "--name-only", "--diff-filter=U"],
    RunOptions::new(cwd).allow_failure(),
  )?;
  Ok(lines(&result.stdout))
}

fn index_fields(header: &str) -> (Option<String>, Option<String>, f64) {
  let fields = text::split_space_runs(header);
  (
    fields.first().map(|field| field.to_string()),
    fields.get(1).map(|field| field.to_string()),
    fields.get(2).map_or(f64::NAN, |field| text::number(field)),
  )
}

pub fn index_entries(cwd: &str, options: &IndexOptions) -> GitResult<Vec<IndexEntry>> {
  let mut args = owned(&[
    "ls-files",
    if options.unmerged_only {
      "-u"
    } else {
      "--stage"
    },
    "-z",
  ]);
  if !options.paths.is_empty() {
    args.push("--".into());
    args.extend(options.paths.iter().cloned());
  }
  let output = read(&args, RunOptions::new(cwd).untrimmed())?.stdout;
  Ok(parse_index(&output))
}

/// `git ls-files --stage -z` (or `-u -z`) output.
fn parse_index(output: &str) -> Vec<IndexEntry> {
  let mut entries = Vec::new();
  for record in output.split('\0') {
    let Some(tab) = record.find('\t') else {
      continue;
    };
    let (mode, blob, stage) = index_fields(&record[..tab]);
    entries.push(IndexEntry {
      mode,
      blob,
      stage,
      path: record[tab + 1..].to_string(),
    });
  }
  entries
}

pub fn list_tracked_paths(pathspecs: &[String], cwd: &str) -> GitResult<Vec<String>> {
  let mut args = owned(&["ls-files", "-z", "--"]);
  args.extend(pathspecs.iter().cloned());
  let result = read(&args, RunOptions::new(cwd).untrimmed().allow_failure())?;
  if !result.ok || result.stdout.is_empty() {
    return Ok(Vec::new());
  }
  let mut paths = nul_fields(&result.stdout);
  text::sort(&mut paths);
  Ok(paths)
}

pub fn path_inventory(pathspecs: &[String], cwd: &str) -> GitResult<Vec<InventoryEntry>> {
  let mut args = owned(&[
    "ls-files",
    "-z",
    "-t",
    "--cached",
    "--modified",
    "--others",
    "--exclude-standard",
    "--stage",
    "--full-name",
    "--",
  ]);
  args.extend(pathspecs.iter().cloned());
  let output = read(&args, RunOptions::new(cwd).untrimmed())?.stdout;
  Ok(parse_inventory(&output))
}

/// `git ls-files -z -t --stage ...` output, untracked entries included.
fn parse_inventory(output: &str) -> Vec<InventoryEntry> {
  let mut entries = Vec::new();
  for record in nul_fields(output) {
    if let Some(path) = record.strip_prefix("? ") {
      entries.push(InventoryEntry {
        tag: "?".into(),
        mode: None,
        blob: None,
        stage: None,
        path: path.to_string(),
      });
      continue;
    }
    let mut chars = record.chars();
    let tag = chars.next().map(String::from).unwrap_or_default();
    chars.next();
    let body = chars.as_str();
    let Some(tab) = body.find('\t') else {
      continue;
    };
    let mut fields = body[..tab].split(' ');
    let mode = fields.next().map(str::to_string);
    let blob = fields.next().map(str::to_string);
    let stage = fields.next().map_or(f64::NAN, text::number);
    entries.push(InventoryEntry {
      tag,
      mode,
      blob,
      stage: Some(stage),
      path: body[tab + 1..].to_string(),
    });
  }
  entries
}

pub fn ignored_paths(cwd: &str) -> GitResult<Vec<String>> {
  let output = read_git(
    &[
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "-z",
    ],
    RunOptions::new(cwd).untrimmed(),
  )?
  .stdout;
  Ok(nul_fields(&output))
}

pub fn list_worktree_git_dirs(cwd: &str) -> GitResult<Vec<String>> {
  let directory = text::join(&repo_context(cwd)?.common_dir, "worktrees");
  let entries = match std::fs::read_dir(&directory) {
    Ok(entries) => entries,
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
    Err(error) => return Err(GitError::new("internal-invariant", error.to_string())),
  };
  let mut paths = Vec::new();
  for entry in entries {
    let entry = entry.map_err(|error| GitError::new("internal-invariant", error.to_string()))?;
    let kind = entry
      .file_type()
      .map_err(|error| GitError::new("internal-invariant", error.to_string()))?;
    if kind.is_dir() || kind.is_symlink() {
      paths.push(text::join(&directory, &entry.file_name().to_string_lossy()));
    }
  }
  text::sort(&mut paths);
  Ok(paths)
}

pub fn list_worktrees(cwd: &str) -> GitResult<Vec<Worktree>> {
  let output = read_git(
    &["worktree", "list", "--porcelain", "-z"],
    RunOptions::new(cwd).untrimmed(),
  )?
  .stdout;
  Ok(parse_worktrees(&output))
}

/// `git worktree list --porcelain -z` output.
fn parse_worktrees(output: &str) -> Vec<Worktree> {
  let mut worktrees = Vec::new();
  let mut current: Option<Worktree> = None;
  for field in output.split('\0') {
    if field.is_empty() {
      if let Some(worktree) = current.take() {
        worktrees.push(worktree);
      }
      continue;
    }
    if let Some(path) = field.strip_prefix("worktree ") {
      if let Some(worktree) = current.take() {
        worktrees.push(worktree);
      }
      current = Some(Worktree {
        path: path.to_string(),
        head: None,
        branch: None,
        detached: false,
        bare: false,
        locked: None,
        prunable: None,
      });
      continue;
    }
    let Some(worktree) = current.as_mut() else {
      continue;
    };
    if let Some(head) = field.strip_prefix("HEAD ") {
      worktree.head = Some(head.to_string());
    } else if let Some(branch) = field.strip_prefix("branch ") {
      worktree.branch = Some(branch.to_string());
    } else if field == "detached" {
      worktree.detached = true;
    } else if field == "bare" {
      worktree.bare = true;
    } else if field == "locked" || field.starts_with("locked ") {
      worktree.locked = Some(text::trim(&field["locked".len()..]).to_string());
    } else if field == "prunable" || field.starts_with("prunable ") {
      worktree.prunable = Some(text::trim(&field["prunable".len()..]).to_string());
    }
  }
  if let Some(worktree) = current {
    worktrees.push(worktree);
  }
  worktrees
}

/// Every parser of Git output above, on arbitrary bytes, for the mutation
/// fuzzer. Git output is untrusted input like any other repository data.
pub(crate) fn fuzz_parsers(data: &[u8]) {
  let text = String::from_utf8_lossy(data);
  let expressions: Vec<String> = text.split('\n').take(8).map(str::to_string).collect();
  let _ = parse_batch(data, &expressions);
  let _ = parse_batch_check(&text, &expressions);
  let _ = parse_history(&text, false);
  let _ = parse_history(&text, true);
  let _ = parse_bearers(&text, "ch_x");
  for width in [20, 32] {
    let _ = parse_note_tree(data, width, "");
    let _ = parse_note_tree(data, width, "ab");
  }
  let _ = parse_status(&text);
  let _ = parse_index(&text);
  let _ = parse_inventory(&text);
  let _ = parse_worktrees(&text);
  let _ = parent_rows(&text);
  let _ = version_parts(&text);
  for line in text::split_lines(&text) {
    let _ = cherry_line(line);
    let _ = parse_header(line);
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn versions_and_cherry_lines_parse_as_the_expressions_do() {
    assert_eq!(
      version_parts("git version 2.49.0.windows.1"),
      Some([2.0, 49.0, 0.0])
    );
    assert_eq!(version_parts("git version 2.50"), Some([2.0, 50.0, 0.0]));
    assert_eq!(version_parts("a12b3.4.5"), Some([3.0, 4.0, 5.0]));
    assert_eq!(version_parts("none"), None);
    assert_eq!(
      cherry_line("- abc123 subject"),
      Some(('-', "abc123".into()))
    );
    assert_eq!(cherry_line("+\tABC"), Some(('+', "ABC".into())));
    assert_eq!(cherry_line("-abc"), None);
    assert_eq!(cherry_line("- xyz"), None);
  }
}
