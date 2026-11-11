//! What `src/migration.js` reports without migrating: the state `cst doctor`
//! shows (ADR-0039 §3).

use crate::store::read_json;
use causet_engine::engine;
use causet_engine::errors::{GitError, GitResult};
use causet_engine::locations::{LEGACY_NAMES, migration_marker_path, repository_names};
use causet_engine::types::{RefEntry, RepoContext};
use causet_model::json::{Value, lossy};
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
