//! `src/migration.js`: the state `cst doctor` shows, and `cst migrate`, which
//! moves a repository's metadata from the names used before issue #159 to
//! the current ones (ADR-0039 §3).

use crate::store::read_json;
use causet_engine::errors::{GitError, GitResult};
use causet_engine::locations::{
  CURRENT_NAMES, LEGACY_NAMES, Names, forget_repository_names, migration_marker_path,
  repository_names,
};
use causet_engine::metrics::iso_now;
use causet_engine::process::{RunOptions, run_git};
use causet_engine::types::{RefEntry, RepoContext};
use causet_engine::{engine, text};
use causet_model::js::{get, nullish, text as js_text, truthy};
use causet_model::json::{Object, Value, lossy, string, stringify_pretty};
use causet_model::schemas::assert_readable_schema;

/// `readMarker(context)`: the migration marker, or `None` without one.
fn read_marker(context: &RepoContext) -> GitResult<Option<Value>> {
  let path = migration_marker_path(context);
  let Some(marker) = read_json(&path)? else {
    return Ok(None);
  };
  let schema = match &marker {
    Value::Object(object) => match object.get("schema") {
      Some(Value::String(units)) => Some(lossy(units)),
      _ => None,
    },
    _ => None,
  };
  assert_readable_schema(
    schema.as_deref(),
    &format!("The migration marker at '{path}'"),
    Some("causet.migration"),
    "Read it with the causet build that wrote it.",
  )
  .map_err(|refusal| GitError::new(refusal.code, refusal.message).details(refusal.details))?;
  Ok(Some(marker))
}

/// `legacyRefs(context)`.
fn legacy_refs(context: &RepoContext) -> GitResult<Vec<RefEntry>> {
  let mut refs = engine::list_refs(LEGACY_NAMES.notes_ref, &context.root)?;
  refs.extend(engine::list_refs(
    &format!("{}/", LEGACY_NAMES.refs_root),
    &context.root,
  )?);
  Ok(refs)
}

/// `advancedLegacyRefs(cwd)`: former refs that moved since `cst migrate`
/// recorded them.
pub fn advanced_legacy_refs(cwd: &str) -> GitResult<Vec<RefEntry>> {
  let names = repository_names(cwd)?;
  if names.state == "unmigrated" || !names.evidence.legacy {
    return Ok(Vec::new());
  }
  let context = engine::repo_context(cwd)?;
  let marker = read_marker(&context)?;
  let recorded = match &marker {
    Some(Value::Object(object)) => match object.get("refs") {
      Some(Value::Object(refs)) => Some(refs.clone()),
      _ => None,
    },
    _ => None,
  };
  Ok(
    legacy_refs(&context)?
      .into_iter()
      .filter(|entry| {
        let recorded_oid = recorded.as_ref().and_then(|refs| refs.get(&entry.name));
        !matches!(recorded_oid, Some(Value::String(units)) if lossy(units) == entry.oid)
      })
      .collect(),
  )
}

/// `migrationState(cwd)`: `unmigrated`, `migrated`, or `mixed`.
pub fn migration_state(cwd: &str) -> GitResult<&'static str> {
  let names = repository_names(cwd)?;
  if names.state == "unmigrated" {
    return Ok("unmigrated");
  }
  if !names.evidence.legacy {
    return Ok("migrated");
  }
  Ok(if advanced_legacy_refs(cwd)?.is_empty() {
    "migrated"
  } else {
    "mixed"
  })
}

/// Ref families that exist only while an operation runs (ADR-0039 §1).
const TRANSIENT_FAMILIES: [&str; 3] = ["rebase", "exports", "import-staging"];

fn owned(args: &[&str]) -> Vec<String> {
  args.iter().map(|arg| (*arg).to_string()).collect()
}

/// `currentName(ref)`.
fn current_name(name: &str) -> String {
  if name == LEGACY_NAMES.notes_ref {
    CURRENT_NAMES.notes_ref.to_string()
  } else {
    format!(
      "{}/{}",
      CURRENT_NAMES.refs_root,
      name.get(LEGACY_NAMES.refs_root.len() + 1..).unwrap_or_default()
    )
  }
}

/// One planned step: where it moves from and to, and what is done about it.
struct Step {
  from: String,
  to: String,
  action: &'static str,
}

/// A ref the plan creates, advances or leaves.
struct RefStep {
  step: Step,
  oid: String,
  current: Option<String>,
}

/// A notes setting the plan repoints or keeps.
struct ConfigStep {
  key: &'static str,
  from: Option<String>,
  action: &'static str,
}

/// What `migrationPlan(cwd)` returns.
struct Plan {
  context: RepoContext,
  before: &'static str,
  marker: Option<Value>,
  refusal: Option<GitError>,
  refs: Vec<RefStep>,
  config: Vec<ConfigStep>,
  paths: Vec<Step>,
  spec_files: usize,
  spec_action: &'static str,
}

/// `migrationPlan(cwd)`: every step, each with its postcondition already
/// checked, and the first reason nothing may move. The plan is built even
/// when it is refused, so a dry run can show it all.
fn migration_plan(cwd: &str) -> GitResult<Plan> {
  let context = engine::repo_context(cwd)?;
  let before = repository_names(cwd)?.state;
  let marker = read_marker(&context)?;
  let mut refusal: Option<GitError> = None;
  let mut refuse = |error: GitError| {
    if refusal.is_none() {
      refusal = Some(error);
    }
  };

  // Nothing moves while an operation holds state under either set of names.
  let mut git_dirs = vec![context.common_dir.clone()];
  git_dirs.extend(engine::list_worktree_git_dirs(&context.root)?);
  let sets: [&Names; 2] = [&LEGACY_NAMES, &CURRENT_NAMES];
  for git_dir in &git_dirs {
    for set in sets {
      for (file, command) in [("reconciliation.json", "reconcile"), ("rebase.json", "rebase")] {
        let journal = text::join(&text::join(git_dir, set.runtime), file);
        if std::path::Path::new(&journal).exists() {
          refuse(
            GitError::new(
              "operation-in-progress",
              format!(
                "A {command} operation is in progress ('{journal}'); cst migrate moves nothing while one is."
              ),
            )
            // A journal under the former names belongs to a build that still
            // read them; this one refuses the repository until it is migrated.
            .details(if set.runtime == LEGACY_NAMES.runtime && before == "unmigrated" {
              format!(
                "Finish it with cst {command} --continue, or discard it with cst {command} --abort, using the build that started it (causet 0.21 or earlier), then run cst migrate again."
              )
            } else {
              format!(
                "Finish it with cst {command} --continue, or discard it with cst {command} --abort, then run cst migrate again."
              )
            }),
          );
        }
      }
    }
  }
  let legacy = legacy_refs(&context)?;
  for entry in &legacy {
    let family = entry
      .name
      .get(LEGACY_NAMES.refs_root.len() + 1..)
      .unwrap_or_default()
      .split('/')
      .next()
      .unwrap_or_default();
    if entry.name != LEGACY_NAMES.notes_ref && TRANSIENT_FAMILIES.contains(&family) {
      refuse(
        GitError::new(
          "operation-in-progress",
          format!(
            "The transient ref '{}' belongs to an unfinished operation; cst migrate moves nothing while one exists.",
            entry.name
          ),
        )
        .details(
          "Finish or abort the operation that owns it (a causal rebase, a metadata export, or a metadata import), then run cst migrate again.",
        ),
      );
    }
  }

  let mut current = engine::list_refs(CURRENT_NAMES.notes_ref, &context.root)?;
  current.extend(engine::list_refs(&format!("{}/", CURRENT_NAMES.refs_root), &context.root)?);
  let recorded = |name: &str| match get(get(marker.as_ref(), "refs"), name) {
    value if nullish(value) => None,
    Some(Value::String(units)) => Some(lossy(units)),
    _ => Some(String::new()),
  };
  let mut refs = Vec::new();
  for entry in &legacy {
    let to = current_name(&entry.name);
    // A later listing of the same name replaces an earlier one, as in a `Map`.
    let existing = current.iter().rev().find(|held| held.name == to).map(|held| held.oid.clone());
    let action = match &existing {
      None => "create",
      Some(existing) if *existing == entry.oid => "present",
      // The former ref moved after an earlier migration. Only a fast-forward
      // of a new ref that did not move itself is taken; anything else is a
      // real disagreement, which the envelope import resolves under ADR-0030.
      Some(existing)
        if recorded(&entry.name).as_deref() == Some(existing.as_str())
          && engine::is_ancestor(existing, &entry.oid, &context.root)? =>
      {
        "fast-forward"
      }
      Some(_) => {
        refuse(
          GitError::new(
            "precondition-not-met",
            format!(
              "Both '{}' and '{to}' moved since the migration; cst migrate will not choose between them.",
              entry.name
            ),
          )
          .details(
            "Export the former side with an older build (cst metadata export) and import it here with cst metadata import --dry-run, then --apply; the import applies ADR-0030's conflict policy.",
          ),
        );
        "conflict"
      }
    };
    refs.push(RefStep {
      step: Step {
        from: entry.name.clone(),
        to,
        action,
      },
      oid: entry.oid.clone(),
      current: existing,
    });
  }

  let mut config = Vec::new();
  for key in ["notes.displayRef", "notes.rewriteRef"] {
    let read = run_git(
      &owned(&["config", "--get", key]),
      &RunOptions::new(&context.root).allow_failure(),
    )?;
    let value = Some(text::trim(&read.stdout).to_string()).filter(|value| !value.is_empty());
    let action = if value.as_deref() == Some(LEGACY_NAMES.notes_ref) { "repoint" } else { "keep" };
    config.push(ConfigStep {
      key,
      from: value,
      action,
    });
  }

  let mut paths = Vec::new();
  for git_dir in &git_dirs {
    let from = text::join(git_dir, LEGACY_NAMES.runtime);
    if !std::path::Path::new(&from).exists() {
      continue;
    }
    let entries = std::fs::read_dir(&from).map_err(|error| crate::envelope::io_failure(&error, "scandir", &from))?;
    let mut names = Vec::new();
    for entry in entries {
      let entry = entry.map_err(|error| crate::envelope::io_failure(&error, "scandir", &from))?;
      names.push(entry.file_name().to_string_lossy().into_owned());
    }
    // `fs.readdirSync` lists in byte order off Windows, where libuv sorts
    // what the directory yields; on Windows both take the file system's order.
    if !cfg!(windows) {
      names.sort();
    }
    for name in names {
      if name.ends_with(".lock") {
        continue;
      }
      let target = text::join(&text::join(git_dir, CURRENT_NAMES.runtime), &name);
      let action = if std::path::Path::new(&target).exists() { "present" } else { "move" };
      paths.push(Step {
        from: text::join(&from, &name),
        to: target,
        action,
      });
    }
  }

  let tracked_legacy = engine::list_tracked_paths(&owned(&[LEGACY_NAMES.specs_dir]), &context.root)?;
  let tracked_current = engine::list_tracked_paths(&owned(&[CURRENT_NAMES.specs_dir]), &context.root)?;
  let spec_action = if tracked_legacy.is_empty() {
    "none"
  } else if tracked_current.is_empty() {
    "move"
  } else {
    "present"
  };
  if spec_action == "present" {
    refuse(
      GitError::new(
        "precondition-not-met",
        format!(
          "Both {} and {} hold tracked manifests; cst migrate will not merge them.",
          LEGACY_NAMES.specs_dir, CURRENT_NAMES.specs_dir
        ),
      )
      .details("Keep one directory: remove or move the other with git, commit, and run cst migrate again."),
    );
  }
  Ok(Plan {
    context,
    before,
    marker,
    refusal,
    refs,
    config,
    paths,
    spec_files: tracked_legacy.len(),
    spec_action,
  })
}

/// `report(plan, mode)`.
fn report(plan: &Plan, mode: &str) -> GitResult<Value> {
  let changed = |actions: Vec<&str>| {
    Value::Number(
      actions
        .into_iter()
        .filter(|action| !matches!(*action, "present" | "keep" | "none"))
        .count() as f64,
    )
  };
  let or_null = |value: &Option<String>| value.as_deref().map_or(Value::Null, string);
  let mut result = Object::new();
  result.set("schema", string("causet.migration-report/v1"));
  result.set("mode", string(mode));
  result.set("stateBefore", string(plan.before));
  result.set(
    "stateAfter",
    string(if mode == "apply" { migration_state(&plan.context.root)? } else { plan.before }),
  );
  result.set(
    "refused",
    match &plan.refusal {
      Some(refusal) => {
        let mut refused = Object::new();
        refused.set("code", string(refusal.code));
        refused.set("message", string(&refusal.message));
        refused.set("details", string(&refusal.details));
        Value::Object(refused)
      }
      None => Value::Null,
    },
  );
  result.set(
    "refs",
    Value::Array(
      plan
        .refs
        .iter()
        .map(|entry| {
          let mut item = Object::new();
          item.set("from", string(&entry.step.from));
          item.set("to", string(&entry.step.to));
          item.set("oid", string(&entry.oid));
          item.set("action", string(entry.step.action));
          Value::Object(item)
        })
        .collect(),
    ),
  );
  result.set(
    "config",
    Value::Array(
      plan
        .config
        .iter()
        .map(|entry| {
          let mut item = Object::new();
          item.set("key", string(entry.key));
          item.set("from", or_null(&entry.from));
          item.set("to", string(CURRENT_NAMES.notes_ref));
          item.set("action", string(entry.action));
          Value::Object(item)
        })
        .collect(),
    ),
  );
  let relative = |path: &str| {
    crate::spec::relative_path(&plan.context.common_dir, path)
      .split(text::SEPARATOR)
      .collect::<Vec<_>>()
      .join("/")
  };
  result.set(
    "paths",
    Value::Array(
      plan
        .paths
        .iter()
        .map(|entry| {
          let mut item = Object::new();
          item.set("from", string(&relative(&entry.from)));
          item.set("to", string(&relative(&entry.to)));
          item.set("action", string(entry.action));
          Value::Object(item)
        })
        .collect(),
    ),
  );
  let mut specs = Object::new();
  specs.set("from", string(LEGACY_NAMES.specs_dir));
  specs.set("to", string(CURRENT_NAMES.specs_dir));
  specs.set("files", Value::Number(plan.spec_files as f64));
  specs.set("action", string(plan.spec_action));
  result.set("specs", Value::Object(specs));
  let moving = plan.spec_action == "move";
  let mut summary = Object::new();
  summary.set("refs", changed(plan.refs.iter().map(|entry| entry.step.action).collect()));
  summary.set("config", changed(plan.config.iter().map(|entry| entry.action).collect()));
  summary.set("paths", changed(plan.paths.iter().map(|entry| entry.action).collect()));
  summary.set("specs", Value::Number(if moving { plan.spec_files as f64 } else { 0.0 }));
  summary.set("commitRequired", Value::Bool(moving));
  result.set("summary", Value::Object(summary));
  Ok(Value::Object(result))
}

/// `migrateRepository({ dryRun })`: refs created at the objects their former
/// names hold, in one transaction; the notes configuration repointed; the
/// runtime directories moved; and the tracked manifest directory moved with a
/// staged `git mv` the user commits. A marker records each former ref's
/// object. Every step checked its postcondition first, so a run after an
/// interruption completes what is missing, and nothing is ever deleted.
pub fn migrate_repository(dry_run: bool, cwd: &str) -> GitResult<Value> {
  let plan = migration_plan(cwd)?;
  if dry_run {
    return report(&plan, "dry-run");
  }
  if let Some(refusal) = &plan.refusal {
    return Err(refusal.clone());
  }
  let root = &plan.context.root;
  let mut commands = Vec::new();
  for entry in &plan.refs {
    match entry.step.action {
      "create" => commands.push(format!("create {} {}", entry.step.to, entry.oid)),
      "fast-forward" => commands.push(format!(
        "update {} {} {}",
        entry.step.to,
        entry.oid,
        entry.current.as_deref().unwrap_or_default()
      )),
      _ => {}
    }
  }
  if !commands.is_empty() {
    let mut input = vec!["start".to_string()];
    input.extend(commands);
    input.extend(["prepare".to_string(), "commit".to_string(), String::new()]);
    run_git(
      &owned(&["update-ref", "--stdin"]),
      &RunOptions::new(root).input(input.join("\n")),
    )?;
  }
  for entry in plan.config.iter().filter(|entry| entry.action == "repoint") {
    run_git(
      &owned(&["config", entry.key, CURRENT_NAMES.notes_ref]),
      &RunOptions::new(root),
    )?;
  }
  for entry in plan.paths.iter().filter(|entry| entry.action == "move") {
    if let Some(parent) = std::path::Path::new(&entry.to).parent() {
      std::fs::create_dir_all(parent)
        .map_err(|error| crate::envelope::io_failure(&error, "mkdir", &parent.to_string_lossy()))?;
    }
    std::fs::rename(&entry.from, &entry.to)
      .map_err(|error| crate::envelope::io_failure(&error, "rename", &entry.from))?;
  }
  if plan.spec_action == "move" {
    let directory = text::join(root, ".causet");
    std::fs::create_dir_all(&directory).map_err(|error| crate::envelope::io_failure(&error, "mkdir", &directory))?;
    run_git(
      &owned(&["mv", "-k", LEGACY_NAMES.specs_dir, CURRENT_NAMES.specs_dir]),
      &RunOptions::new(root),
    )?;
  }
  let mut recorded = Object::new();
  for entry in &plan.refs {
    recorded.set(&entry.step.from, string(&entry.oid));
  }
  let mut marker = Object::new();
  marker.set("schema", string("causet.migration/v1"));
  marker.set(
    "migratedAt",
    match get(plan.marker.as_ref(), "migratedAt") {
      value if nullish(value) => string(&iso_now()),
      value => value.cloned().unwrap_or(Value::Null),
    },
  );
  marker.set("updatedAt", string(&iso_now()));
  marker.set("refs", Value::Object(recorded));
  let path = migration_marker_path(&plan.context);
  if let Some(parent) = std::path::Path::new(&path).parent() {
    std::fs::create_dir_all(parent)
      .map_err(|error| crate::envelope::io_failure(&error, "mkdir", &parent.to_string_lossy()))?;
  }
  let temporary = format!("{path}.tmp-{}", std::process::id());
  std::fs::write(&temporary, format!("{}\n", stringify_pretty(&Value::Object(marker))))
    .map_err(|error| crate::envelope::io_failure(&error, "open", &temporary))?;
  std::fs::rename(&temporary, &path).map_err(|error| crate::envelope::io_failure(&error, "rename", &temporary))?;
  forget_repository_names();
  report(&plan, "apply")
}

/// `formatMigration(result)`.
pub fn format_migration(result: &Value) -> String {
  let member = |name: &str| get(Some(result), name);
  let items = |name: &str| match member(name) {
    Some(Value::Array(items)) => items.clone(),
    _ => Vec::new(),
  };
  let padded = |entry: &Value| format!("{:<12}", js_text(get(Some(entry), "action")));
  let applying = js_text(member("mode")) == "apply";
  let mut lines = vec![
    format!(
      "{} metadata to the causet names (ADR-0039)",
      if applying { "Migrated" } else { "Would migrate" }
    ),
    format!(
      "state        {} -> {}",
      js_text(member("stateBefore")),
      js_text(member("stateAfter"))
    ),
  ];
  let refused = member("refused").filter(|refused| truthy(Some(refused)));
  if let Some(refused) = refused {
    lines.push(format!("refused      {}", js_text(get(Some(refused), "message"))));
    lines.push(format!("             {}", js_text(get(Some(refused), "details"))));
  }
  for entry in items("refs") {
    lines.push(format!(
      "ref          {} {} -> {}",
      padded(&entry),
      js_text(get(Some(&entry), "from")),
      js_text(get(Some(&entry), "to"))
    ));
  }
  for entry in items("config") {
    let from = get(Some(&entry), "from");
    let shown = if js_text(get(Some(&entry), "action")) == "repoint" {
      js_text(get(Some(&entry), "to"))
    } else if nullish(from) {
      "(unset)".to_string()
    } else {
      js_text(from)
    };
    lines.push(format!(
      "config       {} {} = {shown}",
      padded(&entry),
      js_text(get(Some(&entry), "key"))
    ));
  }
  for entry in items("paths") {
    lines.push(format!(
      "path         {} {} -> {}",
      padded(&entry),
      js_text(get(Some(&entry), "from")),
      js_text(get(Some(&entry), "to"))
    ));
  }
  let specs = member("specs");
  if js_text(get(specs, "action")) != "none" {
    lines.push(format!(
      "specs        {:<12} {} -> {} ({} files)",
      js_text(get(specs, "action")),
      js_text(get(specs, "from")),
      js_text(get(specs, "to")),
      js_text(get(specs, "files"))
    ));
  }
  if truthy(get(member("summary"), "commitRequired")) {
    lines.push(String::new());
    lines.push(format!(
      "The manifest move is staged, not committed: review it and commit it (git commit -m \"Move specification manifests to {}\").",
      js_text(get(specs, "to"))
    ));
  }
  if applying && refused.is_none() {
    lines.push(String::new());
    lines.push(
      "The former refs stay where they were; publish the new ones with git push <remote> 'refs/notes/causet' 'refs/causet/*'."
        .to_string(),
    );
  }
  lines.join("\n")
}
