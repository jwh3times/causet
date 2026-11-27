//! `cst fetch`, `cst pull`, `cst push` and `cst clone` (ADR-0040): Git's
//! commands, which also carry the shared-portable records between this clone
//! and an ordinary Git remote.
//!
//! The carried refs are named exactly: `refs/notes/causet`,
//! `refs/causet/retention` and `refs/causet/resolutions/*`. Checkpoints,
//! quarantine and every other `refs/causet/*` family stay in the clone.
//!
//! Fetching never trusts the remote. Its carried refs are fetched into a
//! staging namespace, `refs/causet-remote/<remote>/`, that nothing pushes;
//! exported as an envelope from a disposable repository that borrows this
//! clone's objects; and imported in ADR-0030 park mode, so every check an
//! envelope import makes applies unchanged. The remote's own notes and
//! retention commits then become parents of this clone's, so the next push
//! is a fast-forward.
//!
//! Pushing never forces a carried ref. The records go first, in one atomic
//! push, and only then does `git push` run with the caller's arguments, so a
//! branch never reaches a remote before the records about it. A remote whose
//! carried refs moved since the last fetch is fetched and merged, then the
//! push is retried a bounded number of times.

use crate::export::{export_metadata, temporary_directory};
use crate::import::import_metadata;
use crate::notes_write::{commit_with_parents, with_notes_lock};
use causet_engine::errors::{GitError, GitResult};
use causet_engine::locations::{names, ref_family};
use causet_engine::process::{RunOptions, run_git};
use causet_engine::{engine, text};
use causet_model::js::get;
use causet_model::json::{Object, Value, string};

/// The staging namespace for a remote's carried refs.
const STAGING_ROOT: &str = "refs/causet-remote";

/// How many times a records push is attempted when the remote's carried refs
/// keep moving underneath it.
const PUSH_ATTEMPTS: usize = 3;

/// Options of Git's commands that take their value as the next argument, so
/// that value is never mistaken for the remote or the directory.
const FETCH_VALUE_OPTIONS: &[&str] = &[
  "--depth", "--deepen", "--shallow-since", "--shallow-exclude", "--upload-pack", "-o",
  "--server-option", "--negotiation-tip", "-j", "--jobs", "--refmap", "--filter",
  "--recurse-submodules-default", "--submodule-prefix",
];
const PULL_VALUE_OPTIONS: &[&str] = &["-s", "--strategy", "-X", "--strategy-option"];
const PUSH_VALUE_OPTIONS: &[&str] = &["--repo", "--receive-pack", "--exec", "-o", "--push-option", "--recurse-submodules"];
const CLONE_VALUE_OPTIONS: &[&str] = &[
  "-o", "--origin", "-b", "--branch", "-u", "--upload-pack", "--reference", "--reference-if-able",
  "--separate-git-dir", "--depth", "--shallow-since", "--shallow-exclude", "-c", "--config",
  "--server-option", "-j", "--jobs", "--template", "--filter", "--bundle-uri", "--revision",
];

fn owned(args: &[&str]) -> Vec<String> {
  args.iter().map(|item| item.to_string()).collect()
}

fn quiet(args: &[&str], cwd: &str) -> GitResult<String> {
  Ok(run_git(&owned(args), &RunOptions::new(cwd))?.stdout)
}

fn config_values(key: &str, cwd: &str) -> GitResult<Vec<String>> {
  let read = run_git(&owned(&["config", "--get-all", key]), &RunOptions::new(cwd).allow_failure())?;
  Ok(text::split_lines(&read.stdout).into_iter().filter(|line| !line.is_empty()).map(str::to_string).collect())
}

fn configured_remotes(cwd: &str) -> GitResult<Vec<String>> {
  let read = run_git(&owned(&["remote"]), &RunOptions::new(cwd).allow_failure())?;
  Ok(text::split_lines(&read.stdout).into_iter().filter(|line| !line.is_empty()).map(str::to_string).collect())
}

fn has(args: &[String], names: &[&str]) -> bool {
  args.iter().any(|item| names.contains(&item.as_str()))
}

/// The arguments that are not options or option values, in order.
fn positionals(args: &[String], value_options: &[&[&str]]) -> Vec<String> {
  let mut found = Vec::new();
  let mut index = 0;
  let mut options_ended = false;
  while index < args.len() {
    let item = &args[index];
    index += 1;
    if options_ended || !item.starts_with('-') || item == "-" {
      found.push(item.clone());
    } else if item == "--" {
      options_ended = true;
    } else if value_options.iter().any(|list| list.contains(&item.as_str())) {
      index += 1;
    }
  }
  found
}

fn current_branch(cwd: &str) -> GitResult<Option<String>> {
  engine::symbolic_ref("HEAD", cwd, true)
}

/// The remote a fetch or pull with these arguments reads from: the named one
/// (each member of a remote group, or every remote with `--all`), else the
/// current branch's remote, else `origin`.
fn fetch_remotes(args: &[String], extra: &[&str], cwd: &str) -> GitResult<Vec<String>> {
  let remotes = configured_remotes(cwd)?;
  if has(args, &["--all"]) {
    return Ok(remotes);
  }
  let named = positionals(args, &[FETCH_VALUE_OPTIONS, extra]);
  let chosen: Vec<String> = if has(args, &["--multiple"]) {
    named
  } else if let Some(first) = named.into_iter().next() {
    vec![first]
  } else {
    let branch_remote = match current_branch(cwd)? {
      Some(branch) => config_values(&format!("branch.{branch}.remote"), cwd)?.pop(),
      None => None,
    };
    vec![branch_remote.unwrap_or_else(|| "origin".to_string())]
  };
  let mut expanded = Vec::new();
  for name in chosen {
    let group = if remotes.contains(&name) { Vec::new() } else { config_values(&format!("remotes.{name}"), cwd)? };
    if group.is_empty() {
      expanded.push(name);
    } else {
      for member in group {
        expanded.extend(text::split_space_runs(&member).into_iter().map(str::to_string));
      }
    }
  }
  Ok(expanded)
}

/// The remote a push with these arguments writes to, as `git push` chooses it.
fn push_remote(args: &[String], cwd: &str) -> GitResult<String> {
  if let Some(first) = positionals(args, &[PUSH_VALUE_OPTIONS]).into_iter().next() {
    return Ok(first);
  }
  if let Some(index) = args.iter().position(|item| item == "--repo") {
    if let Some(value) = args.get(index + 1) {
      return Ok(value.clone());
    }
  }
  if let Some(value) = args.iter().find_map(|item| item.strip_prefix("--repo=")) {
    return Ok(value.to_string());
  }
  let branch = current_branch(cwd)?;
  if let Some(branch) = &branch {
    if let Some(value) = config_values(&format!("branch.{branch}.pushRemote"), cwd)?.pop() {
      return Ok(value);
    }
  }
  if let Some(value) = config_values("remote.pushDefault", cwd)?.pop() {
    return Ok(value);
  }
  if let Some(branch) = &branch {
    if let Some(value) = config_values(&format!("branch.{branch}.remote"), cwd)?.pop() {
      return Ok(value);
    }
  }
  Ok("origin".to_string())
}

/// The staging prefix for a remote: its name when that makes a valid ref
/// component, otherwise a digest of the URL or path it was given as.
fn staging_prefix(remote: &str, cwd: &str) -> GitResult<String> {
  let named = configured_remotes(cwd)?.iter().any(|name| name == remote);
  if named {
    let candidate = format!("{STAGING_ROOT}/{remote}");
    let check = run_git(
      &owned(&["check-ref-format", &format!("{candidate}/notes")]),
      &RunOptions::new(cwd).allow_failure(),
    )?;
    if check.ok {
      return Ok(candidate);
    }
  }
  let digest = causet_model::sha256::hex(remote.as_bytes());
  Ok(format!("{STAGING_ROOT}/url-{}", &digest[..16]))
}

struct Carried {
  notes: Option<String>,
  retention: Option<String>,
  resolutions: Vec<(String, String)>,
}

/// The carried refs of a list of refs, with names relative to `prefix` (the
/// repository's own names, or a staging prefix).
fn carried_in(entries: &[(String, String)], notes_name: &str, retention_name: &str, resolutions_prefix: &str) -> Carried {
  let find = |name: &str| entries.iter().find(|(entry, _)| entry == name).map(|(_, oid)| oid.clone());
  Carried {
    notes: find(notes_name),
    retention: find(retention_name),
    resolutions: entries
      .iter()
      .filter_map(|(name, oid)| name.strip_prefix(resolutions_prefix).map(|rest| (rest.to_string(), oid.clone())))
      .collect(),
  }
}

struct Names {
  notes: String,
  retention: String,
  resolutions: String,
}

fn local_names(cwd: &str) -> GitResult<Names> {
  Ok(Names {
    notes: names(cwd)?.notes_ref.to_string(),
    retention: ref_family("retention", cwd)?,
    resolutions: format!("{}/", ref_family("resolutions", cwd)?),
  })
}

fn local_carried(names: &Names, cwd: &str) -> GitResult<Carried> {
  let resolutions = engine::list_refs(&names.resolutions, cwd)?
    .into_iter()
    .map(|entry| (entry.name, entry.oid))
    .collect::<Vec<_>>();
  let mut entries = resolutions;
  for name in [&names.notes, &names.retention] {
    if let Some(oid) = engine::ref_target(name, cwd)? {
      entries.push((name.clone(), oid));
    }
  }
  Ok(carried_in(&entries, &names.notes, &names.retention, &names.resolutions))
}

fn remote_carried(remote: &str, names: &Names, cwd: &str) -> GitResult<Carried> {
  let Some(entries) = engine::remote_refs(remote, cwd)? else {
    return Err(GitError::new(
      "not-found",
      format!("Could not read the refs of remote '{remote}' to carry its records."),
    ));
  };
  let entries: Vec<(String, String)> = entries.into_iter().map(|entry| (entry.name, entry.oid)).collect();
  Ok(carried_in(&entries, &names.notes, &names.retention, &names.resolutions))
}

fn contains(ancestor: &str, descendant: Option<&str>, cwd: &str) -> GitResult<bool> {
  let Some(descendant) = descendant else {
    return Ok(false);
  };
  if ancestor == descendant {
    return Ok(true);
  }
  if !engine::revision_resolves(&format!("{ancestor}^{{commit}}"), cwd)? {
    return Ok(false);
  }
  engine::is_ancestor(ancestor, descendant, cwd)
}

fn oid_or_null(value: &Option<String>) -> Value {
  value.as_deref().map(string).unwrap_or(Value::Null)
}

/// Fetch a remote's carried refs into its staging namespace, then bring the
/// records in through an envelope import in park mode. `dry_run` previews the
/// import and changes nothing but the staging refs.
pub fn fetch_records(remote: &str, dry_run: bool, cwd: &str) -> GitResult<Value> {
  let context = engine::repo_context(cwd)?;
  let root = context.root.clone();
  let names = local_names(&root)?;
  let prefix = staging_prefix(remote, &root)?;
  // Every command that reaches the remote runs where the caller's Git
  // command ran, so a remote named by a relative path means what it means to
  // Git (which resolves it from the top of the worktree).
  let offered = remote_carried(remote, &names, cwd)?;
  let mut refspecs = Vec::new();
  if offered.notes.is_some() {
    refspecs.push(format!("+{}:{prefix}/notes", names.notes));
  }
  if offered.retention.is_some() {
    refspecs.push(format!("+{}:{prefix}/retention", names.retention));
  }
  if !offered.resolutions.is_empty() {
    refspecs.push(format!("+{}*:{prefix}/resolutions/*", names.resolutions));
  }
  // What a previous fetch staged and the remote no longer offers goes.
  for stale in engine::list_refs(&format!("{prefix}/"), &root)? {
    let suffix = &stale.name[prefix.len() + 1..];
    let kept = match suffix {
      "notes" => offered.notes.is_some(),
      "retention" => offered.retention.is_some(),
      other => other
        .strip_prefix("resolutions/")
        .is_some_and(|name| offered.resolutions.iter().any(|(offered, _)| offered == name)),
    };
    if !kept {
      quiet(&["update-ref", "-d", &stale.name, &stale.oid], &root)?;
    }
  }
  if !refspecs.is_empty() {
    let mut args = vec!["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--no-recurse-submodules", remote];
    args.extend(refspecs.iter().map(String::as_str));
    quiet(&args, cwd)?;
  }
  let staged_entries: Vec<(String, String)> = engine::list_refs(&format!("{prefix}/"), &root)?
    .into_iter()
    .map(|entry| (entry.name, entry.oid))
    .collect();
  let staged = carried_in(
    &staged_entries,
    &format!("{prefix}/notes"),
    &format!("{prefix}/retention"),
    &format!("{prefix}/resolutions/"),
  );
  let local = local_carried(&names, &root)?;

  let mut report = Object::new();
  report.set("remote", string(remote));
  report.set("direction", string("fetch"));
  let mut staged_value = Object::new();
  staged_value.set("notes", oid_or_null(&staged.notes));
  staged_value.set("retention", oid_or_null(&staged.retention));
  staged_value.set("resolutions", Value::Number(staged.resolutions.len() as f64));
  report.set("staged", Value::Object(staged_value));

  let resolutions_known = staged
    .resolutions
    .iter()
    .all(|(name, oid)| local.resolutions.iter().any(|(local_name, local_oid)| local_name == name && local_oid == oid));
  let notes_known = match &staged.notes {
    None => true,
    Some(oid) => contains(oid, local.notes.as_deref(), &root)?,
  };
  let retention_known = match &staged.retention {
    None => true,
    Some(oid) => contains(oid, local.retention.as_deref(), &root)?,
  };
  if notes_known && retention_known && resolutions_known {
    report.set("upToDate", Value::Bool(true));
    report.set("excluded", Value::Number(0.0));
    report.set("import", Value::Null);
    report.set("merged", merged_value("unchanged", "unchanged"));
    return Ok(Value::Object(report));
  }

  let workspace = temporary_directory("causet-remote-records-")?;
  let outcome = (|| -> GitResult<(Value, Value)> {
    let inspection = text::join(&workspace, "repository");
    let envelope = text::join(&workspace, "envelope");
    quiet(&["init", "-q", &format!("--object-format={}", context.object_format), &inspection], &root)?;
    let common = if std::path::Path::new(&context.common_dir).is_absolute() {
      context.common_dir.clone()
    } else {
      text::join(&root, &context.common_dir)
    };
    let alternates = text::join(&inspection, ".git/objects/info/alternates");
    std::fs::write(&alternates, format!("{}\n", text::join(&common, "objects")))
      .map_err(|error| crate::envelope::io_failure(&error, "open", &alternates))?;
    let mut commands = Vec::new();
    if let Some(oid) = &staged.notes {
      commands.push(format!("create {} {oid}", names.notes));
    }
    if let Some(oid) = &staged.retention {
      commands.push(format!("create {} {oid}", names.retention));
    }
    for (name, oid) in &staged.resolutions {
      commands.push(format!("create {}{name} {oid}", names.resolutions));
    }
    // The lineage the remote states is the one its branches carry, as this
    // clone last fetched them; a remote known only by URL is taken to share
    // this clone's.
    let tracking = engine::list_refs(&format!("refs/remotes/{remote}/"), &root)?;
    if tracking.is_empty() {
      if let Ok(head) = engine::resolve_revision("HEAD^{commit}", &root) {
        commands.push(format!("create refs/heads/lineage {head}"));
      }
    }
    for entry in tracking {
      if engine::revision_resolves(&format!("{}^{{commit}}", entry.oid), &root)? {
        commands.push(format!("create {} {}", entry.name, entry.oid));
      }
    }
    let mut options = RunOptions::new(&inspection);
    options.input = Some(format!("{}\n", commands.join("\n")).into_bytes());
    run_git(&owned(&["update-ref", "--stdin"]), &options)?;
    let exported = export_metadata(&envelope, &inspection)?;
    let imported = import_metadata(&envelope, dry_run, !dry_run, true, &root)?;
    Ok((exported, imported))
  })();
  let _ = std::fs::remove_dir_all(&workspace);
  let (exported, imported) = outcome?;
  let excluded = match get(Some(&exported), "quarantinedRecords") {
    Some(Value::Number(count)) => *count,
    Some(Value::Array(items)) => items.len() as f64,
    _ => 0.0,
  };
  let merged = if dry_run {
    merged_value("unchanged", "unchanged")
  } else {
    with_notes_lock(&root, || {
      let notes = adopt_parent(&names.notes, staged.notes.as_deref(), remote, &root)?;
      let retention = adopt_parent(&names.retention, staged.retention.as_deref(), remote, &root)?;
      Ok(merged_value(notes, retention))
    })?
  };
  report.set("upToDate", Value::Bool(false));
  report.set("excluded", Value::Number(excluded));
  report.set("import", imported);
  report.set("merged", merged);
  Ok(Value::Object(report))
}

fn merged_value(notes: &str, retention: &str) -> Value {
  let mut merged = Object::new();
  merged.set("notes", string(notes));
  merged.set("retention", string(retention));
  Value::Object(merged)
}

/// Make the remote's commit an ancestor of the local ref, so the next push is
/// a fast-forward: nothing when it already is, a fast-forward when the local
/// ref is behind it with the same tree, and otherwise a commit with the local
/// tree and both parents. The tree is always the local one, which the import
/// has already brought up to date; nothing is taken from the remote unchecked.
fn adopt_parent(name: &str, remote: Option<&str>, remote_name: &str, cwd: &str) -> GitResult<&'static str> {
  let Some(remote) = remote else {
    return Ok("unchanged");
  };
  let Some(local) = engine::ref_target(name, cwd)? else {
    // Nothing of the remote's was accepted, so there is nothing to descend from.
    return Ok("unchanged");
  };
  if contains(remote, Some(&local), cwd)? {
    return Ok("unchanged");
  }
  let local_tree = engine::tree_id(&local, cwd)?;
  if engine::is_ancestor(&local, remote, cwd)? && engine::tree_id(remote, cwd)? == local_tree {
    quiet(&["update-ref", name, remote, &local], cwd)?;
    return Ok("fast-forward");
  }
  let message = format!("Merge causet records from {remote_name}");
  let merge = commit_with_parents(&local_tree, &[local.clone(), remote.to_string()], cwd, &message, &[])?;
  quiet(&["update-ref", name, &merge, &local], cwd)?;
  Ok("merge")
}

/// Push the carried refs to a remote in one atomic push, never forced.
/// Refuses while a conflict parked in this clone has no disposition.
pub fn push_records(remote: &str, dry_run: bool, cwd: &str) -> GitResult<Value> {
  let root = engine::repo_context(cwd)?.root;
  let names = local_names(&root)?;
  let quarantine = format!("{}/", ref_family("quarantine", &root)?);
  let refuse_parked = || -> GitResult<()> {
    let parked = engine::list_refs(&quarantine, &root)?;
    if parked.is_empty() {
      return Ok(());
    }
    Err(GitError::new(
      "conflict-blocked",
      format!(
        "{} parked record conflict(s) have no disposition, so pushing would replace the remote's copy without a decision. Dispose of each with 'cst metadata dispose <record-id> --keep-local|--replace-local' ('cst metadata status' lists them), or push without the records with --no-records.",
        parked.len()
      ),
    ))
  };
  refuse_parked()?;
  let mut fetched = Vec::new();
  let mut last_failure = String::new();
  for attempt in 1..=PUSH_ATTEMPTS {
    let offered = remote_carried(remote, &names, cwd)?;
    let mut local = local_carried(&names, &root)?;
    let behind = |remote_oid: &Option<String>, local_oid: &Option<String>| -> GitResult<bool> {
      Ok(match remote_oid {
        Some(oid) => local_oid.is_some() && !contains(oid, local_oid.as_deref(), &root)?,
        None => false,
      })
    };
    if behind(&offered.notes, &local.notes)? || behind(&offered.retention, &local.retention)? {
      fetched.push(fetch_records(remote, dry_run, cwd)?);
      refuse_parked()?;
      local = local_carried(&names, &root)?;
    }
    let mut refspecs = Vec::new();
    let mut pushed = Vec::new();
    for (name, local_oid, remote_oid) in [
      (&names.notes, &local.notes, &offered.notes),
      (&names.retention, &local.retention, &offered.retention),
    ] {
      if let Some(oid) = local_oid {
        if remote_oid.as_ref() != Some(oid) && !(dry_run && behind(remote_oid, local_oid)?) {
          refspecs.push(format!("{oid}:{name}"));
          pushed.push(string(name));
        }
      }
    }
    let mut skipped = Vec::new();
    for (name, oid) in &local.resolutions {
      let full = format!("{}{name}", names.resolutions);
      match offered.resolutions.iter().find(|(offered, _)| offered == name) {
        None => {
          refspecs.push(format!("{oid}:{full}"));
          pushed.push(string(&full));
        }
        Some((_, remote_oid)) if remote_oid != oid => skipped.push(string(&full)),
        Some(_) => {}
      }
    }
    let mut report = Object::new();
    report.set("remote", string(remote));
    report.set("direction", string("push"));
    report.set("fetched", Value::Array(fetched.clone()));
    report.set("skipped", Value::Array(skipped));
    report.set("attempts", Value::Number(attempt as f64));
    if refspecs.is_empty() {
      report.set("upToDate", Value::Bool(true));
      report.set("pushed", Value::Array(Vec::new()));
      return Ok(Value::Object(report));
    }
    // The caller's client hooks run once, on the push of their own refs.
    let mut args = vec!["push", "--atomic", "--quiet", "--no-verify"];
    if dry_run {
      args.push("--dry-run");
    }
    args.push(remote);
    args.extend(refspecs.iter().map(String::as_str));
    let result = run_git(&owned(&args), &RunOptions::new(cwd).allow_failure())?;
    if result.ok {
      report.set("upToDate", Value::Bool(false));
      report.set("pushed", Value::Array(pushed));
      return Ok(Value::Object(report));
    }
    last_failure = result.stderr;
  }
  Err(
    GitError::new(
      "stale-input",
      format!("The records could not be pushed to '{remote}' after {PUSH_ATTEMPTS} attempts; its causal refs kept moving or the push was refused."),
    )
    .details(last_failure),
  )
}

/// Run Git with the caller's arguments and the standard streams inherited,
/// returning its exit status (`128 + signal` when a signal ended it).
fn git_inherited(args: &[String], cwd: &str) -> i32 {
  match std::process::Command::new("git").args(args).current_dir(cwd).status() {
    Ok(status) => status.code().unwrap_or_else(|| signal_status(&status)),
    Err(error) => {
      eprintln!("cst: could not run git: {error}");
      1
    }
  }
}

#[cfg(unix)]
fn signal_status(status: &std::process::ExitStatus) -> i32 {
  use std::os::unix::process::ExitStatusExt;
  status.signal().map_or(1, |signal| 128 + signal)
}

#[cfg(not(unix))]
fn signal_status(_: &std::process::ExitStatus) -> i32 {
  1
}

/// The directory `git clone` creates for these arguments: the one named,
/// else the last component of the repository with `.git` and trailing
/// slashes removed, as Git guesses it.
fn clone_directory(args: &[String], cwd: &str) -> Option<String> {
  let found = positionals(args, &[CLONE_VALUE_OPTIONS]);
  let directory = match found.as_slice() {
    [_, directory, ..] => directory.clone(),
    [repository] => {
      let mut name = repository.trim_end().trim_end_matches('/').to_string();
      for suffix in ["/.git", ".git", ".bundle"] {
        if let Some(stripped) = name.strip_suffix(suffix) {
          name = stripped.trim_end_matches('/').to_string();
        }
      }
      let start = name.rfind(['/', ':', '\\']).map_or(0, |index| index + 1);
      let base = name[start..].to_string();
      if base.is_empty() {
        return None;
      }
      if has(args, &["--bare", "--mirror"]) {
        format!("{base}.git")
      } else {
        base
      }
    }
    [] => return None,
  };
  let path = std::path::Path::new(&directory);
  let full = if path.is_absolute() { path.to_path_buf() } else { std::path::Path::new(cwd).join(path) };
  full.is_dir().then(|| full.to_string_lossy().into_owned())
}

fn clone_remote_name(args: &[String], cwd: &str) -> String {
  for (index, item) in args.iter().enumerate() {
    if item == "-o" || item == "--origin" {
      if let Some(value) = args.get(index + 1) {
        return value.clone();
      }
    }
    if let Some(value) = item.strip_prefix("--origin=") {
      return value.to_string();
    }
  }
  config_values("clone.defaultRemoteName", cwd)
    .ok()
    .and_then(|mut values| values.pop())
    .unwrap_or_else(|| "origin".to_string())
}

/// One line per remote for a person; the JSON report carries the rest.
fn describe(report: &Value) -> String {
  let remote = causet_model::js::text(get(Some(report), "remote"));
  let up_to_date = matches!(get(Some(report), "upToDate"), Some(Value::Bool(true)));
  let count = |value: Option<&Value>| match value {
    Some(Value::Number(number)) => *number as i64,
    Some(Value::Array(items)) => items.len() as i64,
    _ => 0,
  };
  match causet_model::js::text(get(Some(report), "direction")).as_str() {
    "push" if up_to_date => format!("cst: records already on '{remote}'"),
    "push" => format!(
      "cst: records pushed to '{remote}': {} ref(s){}",
      count(get(Some(report), "pushed")),
      match count(get(Some(report), "skipped")) {
        0 => String::new(),
        skipped => format!(", {skipped} resolution ref(s) left as the remote holds them"),
      }
    ),
    _ if up_to_date => format!("cst: records from '{remote}' up to date"),
    _ => {
      let summary = get(get(Some(report), "import"), "summary");
      format!(
        "cst: records from '{remote}': {} added, {} parked, {} excluded as invalid",
        count(get(summary, "addRecords")),
        count(get(summary, "parkRecords")),
        count(get(Some(report), "excluded")),
      )
    }
  }
}

/// Run one of the four commands. `args` are Git's; `json` and `records` are
/// the two flags `cst` takes for itself (`--json`, `--no-records`).
pub fn run(command: &str, args: &[String], json: bool, records: bool, cwd: &str) -> i32 {
  let dry_run = has(args, &["--dry-run", "-n"]) && command != "clone";
  let mut reports: Vec<Value> = Vec::new();
  let finish = |status: i32, reports: Vec<Value>, error: Option<&GitError>| -> i32 {
    if json {
      let mut result = Object::new();
      result.set("command", string(command));
      result.set("gitStatus", Value::Number(status as f64));
      result.set("records", if records { Value::Array(reports) } else { Value::Null });
      result.set(
        "error",
        match error {
          Some(error) => {
            let mut object = Object::new();
            object.set("code", string(error.code));
            object.set("message", string(&error.message));
            Value::Object(object)
          }
          None => Value::Null,
        },
      );
      crate::native::print(&Value::Object(result));
    } else {
      for report in &reports {
        eprintln!("{}", describe(report));
      }
      if let Some(error) = error {
        eprintln!("cst: {}", error.message);
      }
    }
    if error.is_some() && status == 0 { 1 } else { status }
  };
  let mut git_args = vec![command.to_string()];
  git_args.extend(args.iter().cloned());

  if command == "push" {
    if records && has(args, &["--mirror"]) {
      let error = GitError::new(
        "usage-conflicting-options",
        "--mirror would also push this clone's checkpoint and quarantine refs. Run 'cst git push --mirror' for Git's own, or 'cst push --no-records --mirror'.",
      );
      return finish(1, reports, Some(&error));
    }
    if records && !has(args, &["--delete", "-d"]) {
      let pushed = push_remote(args, cwd).and_then(|remote| push_records(&remote, dry_run, cwd));
      match pushed {
        Ok(report) => reports.push(report),
        // The branch is not pushed without its records.
        Err(error) => return finish(1, reports, Some(&error)),
      }
    }
    let status = git_inherited(&git_args, cwd);
    return finish(status, reports, None);
  }

  let status = git_inherited(&git_args, cwd);
  if status != 0 || !records {
    return finish(status, reports, None);
  }
  let (remotes, directory) = match command {
    "clone" => {
      let Some(directory) = clone_directory(args, cwd) else {
        let error = GitError::new("not-found", "The cloned directory could not be found, so no records were fetched; run 'cst init' and 'cst fetch' in it.");
        return finish(status, reports, Some(&error));
      };
      if has(args, &["--bare", "--mirror"]) {
        let error = GitError::new("usage-conflicting-options", "A bare clone has no worktree for causet; its records were not fetched.");
        return finish(status, reports, Some(&error));
      }
      if let Err(error) = crate::store::init_lab(&directory) {
        return finish(status, reports, Some(&error));
      }
      (Ok(vec![clone_remote_name(args, cwd)]), directory)
    }
    "pull" => (fetch_remotes(args, PULL_VALUE_OPTIONS, cwd).map(|mut remotes| {
      remotes.truncate(1);
      remotes
    }), cwd.to_string()),
    _ if dry_run => return finish(status, reports, None),
    _ => (fetch_remotes(args, &[], cwd), cwd.to_string()),
  };
  let remotes = match remotes {
    Ok(remotes) => remotes,
    Err(error) => return finish(status, reports, Some(&error)),
  };
  for remote in remotes {
    match fetch_records(&remote, false, &directory) {
      Ok(report) => reports.push(report),
      Err(error) => return finish(status, reports, Some(&error)),
    }
  }
  finish(status, reports, None)
}
