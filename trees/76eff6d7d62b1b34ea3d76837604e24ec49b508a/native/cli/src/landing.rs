//! `cst branch` and the landings `cst merge`, `compact-merge` and
//! `hard-squash`: `src/cli.js` and `land` of `src/landings.js`.

use crate::host;
use crate::notes_write::append_note;
use crate::provenance::carry_provenance_safely;
use causet_engine::errors::{GitError, GitResult};
use causet_engine::process::{GIT_NO_RERERE, RunOptions, run_git};
use causet_engine::engine;
use causet_model::json::{Object, Value, string};

/// `cst branch <name> [from]`: `git switch -c`, reported as text.
pub fn branch(name: &str, from: Option<&str>, cwd: &str) -> GitResult<String> {
  let from = from.unwrap_or("HEAD");
  run_git(&["switch", "-c", name, from].map(String::from), &RunOptions::new(cwd))?;
  Ok(format!("Created and switched to {name} from {from}"))
}

fn strings(values: &[String]) -> Value {
  Value::Array(values.iter().map(|value| string(value)).collect())
}

/// `commitLandingMessage(mode, sourceRef, sourceHead, absorbedChanges, custom)`.
fn landing_message(mode: &str, source_ref: &str, source_head: &str, absorbed_changes: &[String], custom: Option<&str>) -> String {
  let title = match custom {
    Some(custom) => custom.to_string(),
    None => format!("{} {source_ref}", if mode == "compact" { "Compact merge" } else { "Hard squash" }),
  };
  let mut trailers = vec![format!("Landing-Mode: {mode}"), format!("Source-Revision: {source_head}")];
  trailers.extend(absorbed_changes.iter().map(|change_id| format!("Absorbs: {change_id}")));
  format!("{title}\n\n{}", trailers.join("\n"))
}

/// `land(sourceRef, mode, { message })`: the landing commit and its
/// `causet.landing/v1` receipt, with the absorbed commits' declared
/// provenance carried onto it (FR-ID-08).
pub fn land(source_ref: &str, mode: &str, custom: Option<&str>, cwd: &str) -> GitResult<Value> {
  engine::assert_clean(cwd)?;
  let target_before = engine::current_head(cwd)?;
  let source_head = engine::resolve_revision(source_ref, cwd)?;
  let base = engine::merge_base(&target_before, &source_head, cwd)?;
  let absorbed_commits = engine::list_commits(&base, &source_head, cwd)?;
  let absorbed_changes = absorbed_commits
    .iter()
    .map(|commit| engine::change_id_for_commit(commit, cwd))
    .collect::<GitResult<Vec<_>>>()?;
  let message = landing_message(mode, source_ref, &source_head, &absorbed_changes, custom);

  let mut args: Vec<String> = GIT_NO_RERERE.iter().map(|part| part.to_string()).collect();
  if mode == "compact" {
    args.extend(["merge", "--no-ff", "--no-commit", &source_head].map(String::from));
  } else {
    args.extend(["merge", "--squash", &source_head].map(String::from));
  }
  let mut options = RunOptions::new(cwd);
  options.allow_failure = true;
  let merged = run_git(&args, &options)?;
  if !merged.ok {
    return Err(
      GitError::new(
        "conflict-blocked",
        format!(
          "The {mode} landing produced conflicts. Resolve them with Git, then commit manually; no receipt was recorded."
        ),
      )
      .details(merged.output),
    );
  }

  run_git(&["commit", "-m", &message].map(String::from), &RunOptions::new(cwd))?;
  let landing_commit = engine::current_head(cwd)?;
  let mut receipt = Object::new();
  receipt.set("schema", string("causet.landing/v1"));
  receipt.set("type", string("landing"));
  receipt.set("id", string(&host::new_id("land")));
  receipt.set("mode", string(mode));
  receipt.set("sourceRef", string(source_ref));
  receipt.set("sourceHead", string(&source_head));
  receipt.set("sourceSubject", string(&engine::commit_subject(&source_head, cwd)?));
  receipt.set("targetBefore", string(&target_before));
  receipt.set("landingCommit", string(&landing_commit));
  receipt.set("base", string(&base));
  receipt.set("absorbedCommits", strings(&absorbed_commits));
  receipt.set("absorbedChanges", strings(&absorbed_changes));
  receipt.set("resultTree", string(&engine::tree_id(&landing_commit, cwd)?));
  receipt.set("createdAt", string(&causet_engine::metrics::iso_now()));
  let receipt = Value::Object(receipt);
  append_note(&landing_commit, &receipt, cwd, &[])?;
  carry_provenance_safely(&absorbed_commits, &landing_commit, None, cwd);
  Ok(receipt)
}
