//! The engine differential behind `cst doctor --differential`, as
//! `runDifferential` in `src/engine.js` computes it: every cataloged
//! operation run through each engine over probes derived from the
//! repository itself, compared by the digest of its canonical value.
//!
//! The digests are the same bytes the JavaScript engine computes, so a
//! differential from either implementation can be compared with the other's.

use crate::engine::{self, READ_ENGINES, READ_OPERATIONS, ReadEngine, with_read_engine};
use crate::errors::{GitError, GitResult};
use crate::locations;
use crate::metrics;
use crate::types::{Canonical, HistoryOptions, IndexOptions};
use causet_model::json::{Object, Value, object, string, stringify};

type Run<'a> = Box<dyn Fn() -> GitResult<Value> + 'a>;
type HeadRun<'a> = Box<dyn Fn(&str, &str) -> GitResult<Value> + 'a>;

struct Probe<'a> {
  operation: &'static str,
  run: Option<Run<'a>>,
  skipped: Option<&'static str>,
}

fn run<'a>(operation: &'static str, body: impl Fn() -> GitResult<Value> + 'a) -> Probe<'a> {
  Probe {
    operation,
    run: Some(Box::new(body)),
    skipped: None,
  }
}

fn skip<'a>(operation: &'static str, reason: &'static str) -> Probe<'a> {
  Probe {
    operation,
    run: None,
    skipped: Some(reason),
  }
}

/// `resultDigest(value)`: SHA-256 of the canonical JSON.
pub fn digest(value: &Value) -> String {
  causet_model::sha256::hex(stringify(value).as_bytes())
}

fn canonical<T: Canonical>(result: GitResult<T>) -> GitResult<Value> {
  result.map(|value| value.canonical())
}

/// `differentialProbes(cwd)`.
fn probes<'a>(cwd: &'a str) -> GitResult<Vec<Probe<'a>>> {
  let names = locations::names(cwd)?;
  let notes_ref = names.notes_name;
  let head = with_read_engine(ReadEngine::Git, || engine::current_head(cwd)).ok();
  let roots = match &head {
    Some(_) => with_read_engine(ReadEngine::Git, || engine::root_commits(cwd))?,
    None => Vec::new(),
  };
  let root = roots.first().cloned().or_else(|| head.clone());
  let blob = with_read_engine(ReadEngine::Git, || {
    engine::index_entries(cwd, &IndexOptions::default())
  })?
  .into_iter()
  .find(|entry| entry.stage == 0.0)
  .and_then(|entry| entry.blob);
  let head_probe = |operation: &'static str, body: HeadRun<'a>| -> Probe<'a> {
    match (&head, &root) {
      (Some(head), Some(root)) => {
        let (head, root) = (head.clone(), root.clone());
        run(operation, move || body(&head, &root))
      }
      _ => skip(operation, "the repository has no commit on HEAD"),
    }
  };
  let notes = format!("refs/notes/{notes_ref}");
  let notes_for_exists = notes.clone();
  let specs = names.specs_dir;
  Ok(vec![
    run("repoContext", move || canonical(engine::repo_context(cwd))),
    run("gitVersion", move || canonical(engine::git_version(cwd))),
    run("isInsideWorkTree", move || {
      canonical(engine::is_inside_work_tree(cwd))
    }),
    run("gitPath", move || {
      canonical(engine::git_path("sequencer", cwd))
    }),
    head_probe(
      "resolveRevision",
      Box::new(move |_, _| canonical(engine::resolve_revision("HEAD", cwd))),
    ),
    head_probe(
      "resolveObjectIds",
      Box::new(move |_, _| {
        canonical(engine::resolve_object_ids(
          &["HEAD^{commit}".to_string(), "HEAD^{tree}".to_string()],
          cwd,
        ))
      }),
    ),
    run("revisionResolves", move || {
      canonical(engine::revision_resolves("CHERRY_PICK_HEAD", cwd))
    }),
    head_probe(
      "treeId",
      Box::new(move |_, _| canonical(engine::tree_id("HEAD", cwd))),
    ),
    match blob {
      Some(blob) => run("readGitBlob", move || {
        canonical(engine::read_git_blob(&blob, cwd))
      }),
      None => skip("readGitBlob", "the index has no blob"),
    },
    head_probe(
      "readGitObjects",
      Box::new(move |head, _| {
        canonical(engine::read_git_objects(&[format!("{head}^{{tree}}")], cwd))
      }),
    ),
    // Only shapes the native backend implements: OID-rooted, with the one
    // path it resolves (a retained resolution's `:result`).
    head_probe(
      "inspectGitObjects",
      Box::new(move |head, _| {
        canonical(engine::inspect_git_objects(
          &[
            format!("{head}^{{commit}}"),
            format!("{head}^{{tree}}"),
            format!("{head}:result"),
          ],
          cwd,
        ))
      }),
    ),
    head_probe(
      "mergeBase",
      Box::new(move |head, _| canonical(engine::merge_base(head, head, cwd))),
    ),
    head_probe(
      "isAncestor",
      Box::new(move |head, root| canonical(engine::is_ancestor(root, head, cwd))),
    ),
    head_probe(
      "listCommits",
      Box::new(move |head, root| canonical(engine::list_commits(root, head, cwd))),
    ),
    head_probe(
      "reachableCommits",
      Box::new(move |head, _| canonical(engine::reachable_commits(head, cwd))),
    ),
    head_probe(
      "countCommits",
      Box::new(move |head, _| canonical(engine::count_commits(head, cwd))),
    ),
    head_probe(
      "mergeCommitsBetween",
      Box::new(move |head, root| canonical(engine::merge_commits_between(root, head, cwd))),
    ),
    head_probe(
      "commitTopology",
      Box::new(move |head, root| canonical(engine::commit_topology(root, head, cwd))),
    ),
    run("rootCommits", move || canonical(engine::root_commits(cwd))),
    head_probe(
      "commitHistory",
      Box::new(move |head, _| {
        canonical(engine::commit_history(
          &[head.to_string()],
          cwd,
          HistoryOptions {
            reverse: true,
            paths: false,
          },
        ))
      }),
    ),
    head_probe(
      "commitMessage",
      Box::new(move |head, _| canonical(engine::commit_message(head, cwd))),
    ),
    head_probe(
      "commitSubject",
      Box::new(move |head, _| canonical(engine::commit_subject(head, cwd))),
    ),
    head_probe(
      "findCommitsByChangeId",
      Box::new(move |head, _| {
        let change_id = engine::change_id_for_commit(head, cwd)?;
        canonical(engine::find_commits_by_change_id(&change_id, cwd))
      }),
    ),
    head_probe(
      "patchEquivalentCommits",
      Box::new(move |head, root| {
        canonical(engine::patch_equivalent_commits(head, head, root, cwd))
      }),
    ),
    head_probe(
      "historyGraph",
      Box::new(move |_, _| canonical(engine::history_graph(cwd))),
    ),
    head_probe(
      "ancestryPath",
      Box::new(move |head, root| canonical(engine::ancestry_path(head, root, cwd))),
    ),
    head_probe(
      "treePaths",
      Box::new(move |head, _| canonical(engine::tree_paths(&format!("{head}^{{tree}}"), cwd))),
    ),
    // The one catalog read that leaves the machine, so the probe asks this
    // repository about itself rather than reaching for a network.
    run("remoteRefs", move || {
      let root = engine::repo_context(cwd)?.root;
      canonical(engine::remote_refs(&root, cwd))
    }),
    run("refExists", move || {
      canonical(engine::ref_exists(&notes_for_exists, cwd))
    }),
    run("refTarget", move || {
      canonical(engine::ref_target(&notes, cwd))
    }),
    run("listRefs", move || {
      canonical(engine::list_refs("refs/heads/", cwd))
    }),
    run("symbolicRef", move || {
      canonical(engine::symbolic_ref("HEAD", cwd, true))
    }),
    run("pseudoRefTarget", move || {
      canonical(engine::pseudo_ref_target("CHERRY_PICK_HEAD", cwd))
    }),
    run("listNoteEntries", move || {
      canonical(engine::list_note_entries(notes_ref, cwd))
    }),
    head_probe(
      "readNoteText",
      Box::new(move |head, _| canonical(engine::read_note_text(notes_ref, head, cwd))),
    ),
    run("workspaceStatus", move || {
      canonical(engine::workspace_status(cwd))
    }),
    run("porcelainStatus", move || {
      canonical(engine::porcelain_status(cwd, true))
    }),
    run("unmergedPaths", move || {
      canonical(engine::unmerged_paths(cwd))
    }),
    run("indexEntries", move || {
      canonical(engine::index_entries(cwd, &IndexOptions::default()))
    }),
    run("listTrackedPaths", move || {
      canonical(engine::list_tracked_paths(&[specs.to_string()], cwd))
    }),
    run("pathInventory", move || {
      canonical(engine::path_inventory(&["*.md".to_string()], cwd))
    }),
    run("ignoredPaths", move || {
      canonical(engine::ignored_paths(cwd))
    }),
    run("listWorktrees", move || {
      canonical(engine::list_worktrees(cwd))
    }),
    run("listWorktreeGitDirs", move || {
      canonical(engine::list_worktree_git_dirs(cwd))
    }),
  ])
}

/// `runDifferential(cwd)`: every probe through each engine, with the Git
/// engine as oracle.
pub fn run_differential(cwd: &str) -> GitResult<Value> {
  let probes = probes(cwd)?;
  let mut operations = Vec::with_capacity(probes.len());
  let mut counts = [0u64; 3];
  for probe in &probes {
    let Some(body) = &probe.run else {
      counts[2] += 1;
      operations.push(object([
        ("operation", string(probe.operation)),
        ("status", string("skipped")),
        ("reason", string(probe.skipped.unwrap_or_default())),
      ]));
      continue;
    };
    let mut results = Object::new();
    let mut reference: Option<(Option<String>, Option<String>)> = None;
    let mut equal = true;
    for name in READ_ENGINES {
      let engine = engine::parse_engine(name)?;
      let collector = metrics::begin(&format!("differential-{name}"));
      let outcome = with_read_engine(engine, body);
      let measured = metrics::end(collector);
      let (digest, error) = match outcome {
        Ok(value) => (Some(digest(&value)), None),
        Err(error) => (None, Some(error.message)),
      };
      let fallbacks: Vec<_> = measured
        .fallbacks
        .into_iter()
        .filter(|item| item.operation == probe.operation)
        .collect();
      results.set(
        name,
        object([
          ("digest", digest.as_deref().map_or(Value::Null, string)),
          ("error", error.as_deref().map_or(Value::Null, string)),
          ("processes", Value::Number(measured.processes as f64)),
          ("fallbacks", metrics::fallbacks_value(&fallbacks)),
          ("directReads", Value::Number(measured.direct_reads as f64)),
        ]),
      );
      match &reference {
        None => reference = Some((digest, error)),
        Some(expected) => equal &= expected.0 == digest && expected.1 == error,
      }
    }
    counts[usize::from(!equal)] += 1;
    operations.push(object([
      ("operation", string(probe.operation)),
      ("status", string(if equal { "equal" } else { "different" })),
      ("results", Value::Object(results)),
    ]));
  }
  if probes.len() != READ_OPERATIONS.len()
    || probes
      .iter()
      .any(|probe| !READ_OPERATIONS.contains(&probe.operation))
  {
    return Err(GitError::new(
      "internal-invariant",
      "The differential probes do not cover the operation catalog exactly.",
    ));
  }
  Ok(object([
    ("schema", string("causet.engine-differential/v1")),
    (
      "engines",
      Value::Array(READ_ENGINES.iter().map(|engine| string(engine)).collect()),
    ),
    ("oracle", string(READ_ENGINES[0])),
    ("operations", Value::Array(operations)),
    (
      "counts",
      object([
        ("equal", Value::Number(counts[0] as f64)),
        ("different", Value::Number(counts[1] as f64)),
        ("skipped", Value::Number(counts[2] as f64)),
      ]),
    ),
    ("equal", Value::Bool(counts[1] == 0)),
  ]))
}
