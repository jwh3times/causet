//! Answers Git engine requests, one JSON line in and one out, so the suites
//! can run `src/engine.js` and the Rust engine over the same repositories and
//! compare values and process counts operation for operation.
//!
//! A request is either a group of calls,
//! `{ "cwd", "engine", "session", "warm", "calls": [{ "op", "args", "options" }] }`,
//! answered with one `{ value | error, metrics }` per call, or
//! `{ "differential": cwd }`, answered with the differential report.
//!
//! Two calls are not catalog operations: `$run` runs `run_git` with the given
//! arguments (a mutation, or a read outside the seam), and `$mergeTree` runs
//! each `[base, ours, theirs]` of its arguments through one merge-tree session.
#![forbid(unsafe_code)]

use causet_engine::differential::run_differential;
use causet_engine::engine::{self, ReadEngine, parse_engine, with_read_engine};
use causet_engine::errors::{GitError, GitResult};
use causet_engine::merge_tree::MergeTreeSession;
use causet_engine::metrics;
use causet_engine::process::{RunOptions, run_git};
use causet_engine::session::with_object_session;
use causet_engine::types::{Canonical, HistoryOptions, IndexOptions};
use causet_model::json::{Object, Value, lossy, object, parse, string, stringify};
use std::io::{BufRead as _, Write as _};

fn text(value: Option<&Value>) -> String {
  match value {
    Some(Value::String(units)) => lossy(units),
    _ => String::new(),
  }
}

fn texts(value: Option<&Value>) -> Vec<String> {
  match value {
    Some(Value::Array(items)) => items.iter().map(|item| text(Some(item))).collect(),
    _ => Vec::new(),
  }
}

fn flag(options: Option<&Value>, name: &str) -> bool {
  match options {
    Some(Value::Object(options)) => matches!(options.get(name), Some(Value::Bool(true))),
    _ => false,
  }
}

fn member<'a>(value: &'a Value, name: &str) -> Option<&'a Value> {
  match value {
    Value::Object(object) => object.get(name),
    _ => None,
  }
}

fn error_value(error: &GitError) -> Value {
  object([
    ("code", string(error.code)),
    ("message", string(&error.message)),
    ("details", string(&error.details)),
    ("exitCode", Value::Number(f64::from(error.exit_code))),
  ])
}

/// The metrics a comparison can hold to equality: every count, and the
/// per-command counts in command order, without timings.
fn metrics_value(measured: &metrics::Metrics) -> Value {
  let mut native = Object::new();
  for (operation, count) in &measured.native_reads {
    native.set(operation, Value::Number(*count as f64));
  }
  let mut commands = measured.by_command.clone();
  commands.sort_by(|left, right| causet_engine::text::compare(&left.command, &right.command));
  object([
    ("count", Value::Number(measured.count as f64)),
    ("processes", Value::Number(measured.processes as f64)),
    (
      "sessionQueries",
      Value::Number(measured.session_queries as f64),
    ),
    ("cacheHits", Value::Number(measured.cache_hits as f64)),
    ("failed", Value::Number(measured.failed as f64)),
    ("fallbacks", metrics::fallbacks_value(&measured.fallbacks)),
    ("nativeReads", Value::Object(native)),
    ("directReads", Value::Number(measured.direct_reads as f64)),
    (
      "commands",
      Value::Array(
        commands
          .iter()
          .map(|entry| {
            object([
              ("command", string(&entry.command)),
              ("count", Value::Number(entry.count as f64)),
              ("processes", Value::Number(entry.processes as f64)),
              (
                "sessionQueries",
                Value::Number(entry.session_queries as f64),
              ),
              ("cacheHits", Value::Number(entry.cache_hits as f64)),
            ])
          })
          .collect(),
      ),
    ),
  ])
}

fn value<T: Canonical>(result: GitResult<T>) -> GitResult<Value> {
  result.map(|value| value.canonical())
}

fn call(op: &str, args: &[Value], options: Option<&Value>, cwd: &str) -> GitResult<Value> {
  let arg = |index: usize| text(args.get(index));
  let list = |index: usize| texts(args.get(index));
  match op {
    "repoContext" => value(engine::repo_context(cwd)),
    "gitVersion" => value(engine::git_version(cwd)),
    "isInsideWorkTree" => value(engine::is_inside_work_tree(cwd)),
    "gitPath" => value(engine::git_path(&arg(0), cwd)),
    "resolveRevision" => value(engine::resolve_revision(&arg(0), cwd)),
    "resolveObjectIds" => value(engine::resolve_object_ids(&list(0), cwd)),
    "revisionResolves" => value(engine::revision_resolves(&arg(0), cwd)),
    "treeId" => value(engine::tree_id(&arg(0), cwd)),
    "readGitBlob" => value(engine::read_git_blob(&arg(0), cwd)),
    "readGitObjects" => value(engine::read_git_objects(&list(0), cwd)),
    "inspectGitObjects" => value(engine::inspect_git_objects(&list(0), cwd)),
    "mergeBase" => value(engine::merge_base(&arg(0), &arg(1), cwd)),
    "isAncestor" => value(engine::is_ancestor(&arg(0), &arg(1), cwd)),
    "listCommits" => value(engine::list_commits(&arg(0), &arg(1), cwd)),
    "reachableCommits" => value(engine::reachable_commits(&arg(0), cwd)),
    "countCommits" => value(engine::count_commits(&arg(0), cwd)),
    "mergeCommitsBetween" => value(engine::merge_commits_between(&arg(0), &arg(1), cwd)),
    "commitTopology" => value(engine::commit_topology(&arg(0), &arg(1), cwd)),
    "rootCommits" => value(engine::root_commits(cwd)),
    "commitHistory" => value(engine::commit_history(
      &list(0),
      cwd,
      HistoryOptions {
        reverse: flag(options, "reverse"),
        paths: flag(options, "paths"),
      },
    )),
    "commitMessage" => value(engine::commit_message(&arg(0), cwd)),
    "commitSubject" => value(engine::commit_subject(&arg(0), cwd)),
    "findCommitsByChangeId" => value(engine::find_commits_by_change_id(&arg(0), cwd)),
    "patchEquivalentCommits" => value(engine::patch_equivalent_commits(
      &arg(0),
      &arg(1),
      &arg(2),
      cwd,
    )),
    "historyGraph" => value(engine::history_graph(cwd)),
    "ancestryPath" => value(engine::ancestry_path(&arg(0), &arg(1), cwd)),
    "treePaths" => value(engine::tree_paths(&arg(0), cwd)),
    "remoteRefs" => value(engine::remote_refs(&arg(0), cwd)),
    "refExists" => value(engine::ref_exists(&arg(0), cwd)),
    "refTarget" => value(engine::ref_target(&arg(0), cwd)),
    "listRefs" => value(engine::list_refs(&arg(0), cwd)),
    "symbolicRef" => value(engine::symbolic_ref(&arg(0), cwd, flag(options, "short"))),
    "pseudoRefTarget" => value(engine::pseudo_ref_target(&arg(0), cwd)),
    "listNoteEntries" => value(engine::list_note_entries(&arg(0), cwd)),
    "readNoteText" => value(engine::read_note_text(&arg(0), &arg(1), cwd)),
    "workspaceStatus" => value(engine::workspace_status(cwd)),
    "porcelainStatus" => value(engine::porcelain_status(
      cwd,
      flag(options, "nulTerminated"),
    )),
    "unmergedPaths" => value(engine::unmerged_paths(cwd)),
    "indexEntries" => value(engine::index_entries(
      cwd,
      &IndexOptions {
        unmerged_only: flag(options, "unmergedOnly"),
        paths: options
          .map(|options| texts(member(options, "paths")))
          .unwrap_or_default(),
      },
    )),
    "listTrackedPaths" => value(engine::list_tracked_paths(&list(0), cwd)),
    "pathInventory" => value(engine::path_inventory(&list(0), cwd)),
    "ignoredPaths" => value(engine::ignored_paths(cwd)),
    "listWorktrees" => value(engine::list_worktrees(cwd)),
    "listWorktreeGitDirs" => value(engine::list_worktree_git_dirs(cwd)),
    "$run" => {
      let output = run_git(&list(0), &RunOptions::new(cwd).allow_failure())?;
      Ok(object([
        ("ok", Value::Bool(output.ok)),
        ("stdout", string(&output.stdout)),
      ]))
    }
    "$mergeTree" => {
      let mut session = MergeTreeSession::new(cwd, None);
      let answers = args
        .iter()
        .map(|merge| {
          let step = texts(Some(merge));
          let field = |index: usize| step.get(index).cloned().unwrap_or_default();
          match session.merge(&field(0), &field(1), &field(2)) {
            Ok(result) => object([
              ("clean", Value::Bool(result.clean)),
              ("tree", string(&result.tree)),
            ]),
            Err(error) => object([(
              "error",
              object([
                ("message", string(&error.message)),
                (
                  "sessionFailure",
                  error.session_failure.as_deref().map_or(Value::Null, string),
                ),
              ]),
            )]),
          }
        })
        .collect();
      session.close();
      Ok(Value::Array(answers))
    }
    other => Err(GitError::new(
      "usage-unknown-command",
      format!("unknown operation {other}"),
    )),
  }
}

fn group(request: &Value) -> Value {
  let cwd = text(member(request, "cwd"));
  let engine = match parse_engine(&text(member(request, "engine"))) {
    Ok(engine) => engine,
    Err(_) => ReadEngine::Git,
  };
  if matches!(member(request, "warm"), Some(Value::Bool(true))) {
    with_read_engine(ReadEngine::Git, || {
      let _ = engine::repo_context(&cwd);
      let _ = engine::git_version(&cwd);
    });
  }
  let calls = match member(request, "calls") {
    Some(Value::Array(calls)) => calls.clone(),
    _ => Vec::new(),
  };
  let run = || {
    calls
      .iter()
      .map(|entry| {
        let op = text(member(entry, "op"));
        let args = match member(entry, "args") {
          Some(Value::Array(args)) => args.clone(),
          _ => Vec::new(),
        };
        let collector = metrics::begin(&op);
        let outcome = with_read_engine(engine, || call(&op, &args, member(entry, "options"), &cwd));
        let measured = metrics::end(collector);
        let mut reply = Object::new();
        match outcome {
          Ok(value) => reply.set("value", value),
          Err(error) => reply.set("error", error_value(&error)),
        }
        reply.set("metrics", metrics_value(&measured));
        Value::Object(reply)
      })
      .collect::<Vec<_>>()
  };
  let results = if matches!(member(request, "session"), Some(Value::Bool(true))) {
    with_object_session(&cwd, run)
  } else {
    run()
  };
  object([("results", Value::Array(results))])
}

fn main() {
  let stdin = std::io::stdin();
  let mut stdout = std::io::stdout().lock();
  for line in stdin.lock().lines() {
    let Ok(line) = line else { break };
    if line.trim().is_empty() {
      continue;
    }
    let reply = match parse(&line) {
      Ok(request) => match member(&request, "differential") {
        Some(cwd) => match run_differential(&text(Some(cwd))) {
          Ok(report) => report,
          Err(error) => object([("error", error_value(&error))]),
        },
        None => group(&request),
      },
      Err(message) => object([("error", string(&message))]),
    };
    let _ = writeln!(stdout, "{}", stringify(&reply));
    let _ = stdout.flush();
  }
}
