//! `cst cherry-pick`: `cherryPick` of `src/operations.js`, with the identity
//! model's origin choice and coverage check.

use crate::audit::identity_preserving_edges;
use crate::host;
use crate::metadata::{accepted_causal_records, read_causal_record_catalog};
use crate::notes::list_note_records;
use crate::notes_write::append_note;
use crate::provenance::carry_provenance_safely;
use causet_engine::errors::{GitError, GitResult};
use causet_engine::process::{GIT_NO_RERERE, RunOptions, run_git};
use causet_engine::types::HistoryOptions;
use causet_engine::{engine, text};
use causet_model::js::get;
use causet_model::json::{Object, Value, lossy, string};
use std::collections::HashSet;

/// The commit `value` names: a revision, or for a `ch_*` id the logical
/// change's origin among the commits carrying it.
fn resolve_change_or_commit(value: &str, cwd: &str) -> GitResult<String> {
  if !value.starts_with("ch_") {
    return engine::resolve_revision(value, cwd);
  }
  let bearers = engine::find_commits_by_change_id(value, cwd)?;
  if bearers.is_empty() {
    return Err(GitError::new(
      "revision-not-resolved",
      format!("No commit with Change-Id '{value}' was found."),
    ));
  }
  origin_of_change(bearers, cwd)
}

/// `originOfChange(bearers, cwd)`: the bearer no identity-preserving
/// application record names as its applied commit, else the earliest bearer.
fn origin_of_change(bearers: Vec<String>, cwd: &str) -> GitResult<String> {
  if bearers.len() == 1 {
    return Ok(bearers.into_iter().next().unwrap_or_default());
  }
  let records = list_note_records(cwd)?;
  let record_refs: Vec<&Value> = records.iter().collect();
  // A `Set` of the applied values: only a string can equal a commit.
  let applied: HashSet<String> = identity_preserving_edges(&record_refs)
    .into_iter()
    .filter_map(|(_, applied)| match applied {
      Value::String(units) => Some(lossy(units)),
      _ => None,
    })
    .collect();
  let origins: Vec<&String> = bearers.iter().filter(|commit| !applied.contains(*commit)).collect();
  Ok(origins.first().copied().unwrap_or(&bearers[0]).clone())
}

/// A JavaScript line terminator, where a multiline `^` may match.
fn is_line_terminator(c: char) -> bool {
  matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// Each capture of `message.matchAll(/^Absorbs:\s*(\S+)/gim)`. `\s*` may cross
/// a line break, and the case folding of a non-Unicode regular expression
/// never maps a non-ASCII character onto these ASCII letters.
fn absorbed_change_ids(message: &str) -> Vec<String> {
  let chars: Vec<char> = message.chars().collect();
  let pattern: Vec<char> = "absorbs:".chars().collect();
  let mut captures = Vec::new();
  let mut start = 0;
  while start < chars.len() {
    let at_line_start = start == 0 || is_line_terminator(chars[start - 1]);
    let matches_word = chars.len() - start >= pattern.len()
      && chars[start..start + pattern.len()]
        .iter()
        .zip(&pattern)
        .all(|(c, p)| c.to_ascii_lowercase() == *p);
    if at_line_start && matches_word {
      let mut value = start + pattern.len();
      while value < chars.len() && text::is_space(chars[value]) {
        value += 1;
      }
      let mut end = value;
      while end < chars.len() && !text::is_space(chars[end]) {
        end += 1;
      }
      if end > value {
        captures.push(chars[value..end].iter().collect());
        start = end;
        continue;
      }
    }
    start += 1;
  }
  captures
}

const COVERING_RELATIONS: [&str; 5] = [
  "same-logical-change",
  "causal-reconciliation",
  "contextual-application",
  "causal-rebase",
  "contextual-rebase",
];

fn is_text(value: Option<&Value>, expected: &str) -> bool {
  matches!(value, Some(Value::String(units)) if lossy(units) == expected)
}

/// `targetCoversChange(originCommit, originChangeId, targetHead, cwd)`.
fn target_covers_change(origin_commit: &str, origin_change_id: &str, target_head: &str, cwd: &str) -> GitResult<bool> {
  let history = engine::commit_history(&[target_head.to_string()], cwd, HistoryOptions::default())?;
  for item in &history {
    if item.commit == origin_commit
      || text::extract_trailer(&item.message, "Change-Id").as_deref() == Some(origin_change_id)
    {
      return Ok(true);
    }
    if absorbed_change_ids(&item.message).iter().any(|id| id == origin_change_id) {
      return Ok(true);
    }
  }

  // A stock Git commit has no stable trailer to copy; only a validated
  // identity-preserving record attached to the target's history proves it.
  let reachable: HashSet<&str> = history.iter().map(|item| item.commit.as_str()).collect();
  let (records, conflicting) = read_causal_record_catalog(cwd)?;
  let applications: Vec<&Value> = records
    .iter()
    .filter(|record| {
      let member = |name: &str| get(Some(record), name);
      matches!(member("attachedTo"), Some(Value::String(units)) if reachable.contains(lossy(units).as_str()))
        && is_text(member("originCommit"), origin_commit)
        && is_text(member("originChangeId"), origin_change_id)
        && COVERING_RELATIONS.iter().any(|relation| is_text(member("relation"), relation))
    })
    .collect();
  if applications.is_empty() {
    return Ok(false);
  }
  let accepted = accepted_causal_records(&applications, cwd, &conflicting)?;
  Ok(!identity_preserving_edges(&accepted.iter().collect::<Vec<_>>()).is_empty())
}

fn conflict(output: String) -> GitError {
  GitError::new("conflict-blocked", "Cherry-pick produced conflicts.").details(output)
}

/// `cherryPick(value, { fork, repeat })`: the `causet.application/v1` record,
/// or a no-op report when the target already covers the change.
pub fn cherry_pick(value: &str, fork: bool, repeat: bool, cwd: &str) -> GitResult<Value> {
  engine::assert_clean(cwd)?;
  let origin_commit = resolve_change_or_commit(value, cwd)?;
  let origin_change_id = engine::change_id_for_commit(&origin_commit, cwd)?;
  let target_before = engine::current_head(cwd)?;
  if !repeat && target_covers_change(&origin_commit, &origin_change_id, &target_before, cwd)? {
    let mut report = Object::new();
    report.set("noOp", Value::Bool(true));
    report.set("reason", string("target-already-covers-change-id"));
    report.set("originCommit", string(&origin_commit));
    report.set("originChangeId", string(&origin_change_id));
    report.set("targetBefore", string(&target_before));
    return Ok(Value::Object(report));
  }

  let mut allow_failure = RunOptions::new(cwd);
  allow_failure.allow_failure = true;
  let mut args: Vec<String> = GIT_NO_RERERE.iter().map(|part| part.to_string()).collect();
  let mut applied_change_id = origin_change_id.clone();
  if fork {
    args.extend(["cherry-pick", "--no-commit", &origin_commit].map(String::from));
    let picked = run_git(&args, &allow_failure)?;
    if !picked.ok {
      return Err(conflict(picked.output));
    }
    applied_change_id = host::new_id("ch");
    let message = [
      engine::commit_subject(&origin_commit, cwd)?,
      String::new(),
      format!("Change-Id: {applied_change_id}"),
      format!("Derived-From: {origin_change_id}"),
      format!("Origin-Commit: {origin_commit}"),
    ]
    .join("\n");
    run_git(&["commit", "-m", &message].map(String::from), &RunOptions::new(cwd))?;
  } else {
    args.extend(["cherry-pick", "-x", &origin_commit].map(String::from));
    let picked = run_git(&args, &allow_failure)?;
    if !picked.ok {
      return Err(conflict(picked.output));
    }
  }
  let applied_commit = engine::current_head(cwd)?;

  let mut application = Object::new();
  application.set("schema", string("causet.application/v1"));
  application.set("type", string("application"));
  application.set("id", string(&host::new_id("apply")));
  application.set("originCommit", string(&origin_commit));
  application.set("originChangeId", string(&origin_change_id));
  application.set("appliedCommit", string(&applied_commit));
  application.set("appliedChangeId", string(&applied_change_id));
  application.set("targetBefore", string(&target_before));
  application.set("relation", string(if fork { "derived-fork" } else { "same-logical-change" }));
  application.set("createdAt", string(&causet_engine::metrics::iso_now()));
  let application = Value::Object(application);
  append_note(&applied_commit, &application, cwd, &[])?;
  // The origin's declared provenance carries onto the result (FR-ID-08).
  carry_provenance_safely(&[origin_commit], &applied_commit, Some(&applied_change_id), cwd);
  Ok(application)
}

#[cfg(test)]
mod tests {
  use super::absorbed_change_ids;

  #[test]
  fn absorbs_trailers_are_read_as_the_javascript_expression_reads_them() {
    let cases: [(&str, &[&str]); 6] = [
      ("Land\n\nAbsorbs: ch_a\nAbsorbs: ch_b", &["ch_a", "ch_b"]),
      ("absorbs:ch_a\nABSORBS:\tch_b", &["ch_a", "ch_b"]),
      // `\s*` crosses the line break, so the next line's word is captured.
      ("Absorbs:\nAbsorbs: ch_a", &["Absorbs:"]),
      ("Not Absorbs: ch_a\r\nAbsorbs: ch_b\u{2028}Absorbs: ch_c", &["ch_b", "ch_c"]),
      ("Absorbs:   ", &[]),
      ("Abſorbs: ch_a", &[]),
    ];
    for (message, expected) in cases {
      assert_eq!(absorbed_change_ids(message), expected, "{message:?}");
    }
  }
}
