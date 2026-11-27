//! `cst provenance`: the declared provenance of commits, read from their
//! notes and never derived (FR-TRUST-04), as `src/cli.js` and
//! `src/provenance.js` answer it.

use crate::commit::{Actor, normalize_actors, provenance_record};
use crate::notes::read_notes;
use crate::notes_write::append_note;
use crate::parsed::Parsed;
use crate::records::not_callable;
use causet_engine::engine;
use causet_engine::errors::{GitError, GitResult};
use causet_model::js::{get, join, nullish, text, to_js_string};
use causet_model::json::{Object, Value, js, lossy, string};
use causet_model::schemas::canonical_schema;

pub const PROVENANCE_SCHEMA: &str = "causet.provenance/v1";
const AGENT_ENV: &str = "CAUSET_AGENT";

/// `provenanceFor(commits)`: every provenance record attached to each commit.
fn provenance_for(commits: &[String], cwd: &str) -> GitResult<Vec<(String, Vec<Value>)>> {
  let mut unique: Vec<String> = Vec::new();
  for commit in commits {
    if !commit.is_empty() && !unique.contains(commit) {
      unique.push(commit.clone());
    }
  }
  if unique.is_empty() {
    return Ok(Vec::new());
  }
  let notes = read_notes(&unique, cwd)?;
  let mut found = Vec::new();
  for commit in unique {
    let records: Vec<Value> = notes
      .get(&commit)
      .map(|records| {
        records
          .iter()
          .filter(|record| match get(Some(record), "schema") {
            Some(Value::String(units)) => canonical_schema(&lossy(units)) == PROVENANCE_SCHEMA,
            _ => false,
          })
          .cloned()
          .collect()
      })
      .unwrap_or_default();
    if !records.is_empty() {
      found.push((commit, records));
    }
  }
  Ok(found)
}

fn or_value(value: Option<&Value>, fallback: Value) -> Value {
  if nullish(value) {
    fallback
  } else {
    value.cloned().unwrap_or(fallback)
  }
}

/// The entries `cst provenance` reports, in commit order.
fn entries(commits: &[String], cwd: &str) -> GitResult<Vec<Value>> {
  let found = provenance_for(commits, cwd)?;
  let mut entries = Vec::new();
  for commit in commits {
    let Some((_, records)) = found.iter().find(|(candidate, _)| candidate == commit) else {
      continue;
    };
    for record in records {
      let member = |name: &str| get(Some(record), name);
      let mut entry = Object::new();
      entry.set("commit", string(commit));
      entry.set("subject", string(&engine::commit_subject(commit, cwd)?));
      if let Some(id) = member("id") {
        entry.set("id", id.clone());
      }
      entry.set("changeId", or_value(member("changeId"), Value::Null));
      entry.set(
        "actors",
        or_value(member("actors"), Value::Array(Vec::new())),
      );
      if let Some(origin) = member("origin") {
        entry.set("origin", origin.clone());
      }
      entry.set(
        "carriedFrom",
        or_value(member("carriedFrom"), Value::Array(Vec::new())),
      );
      entry.set("createdAt", or_value(member("createdAt"), Value::Null));
      entries.push(Value::Object(entry));
    }
  }
  Ok(entries)
}

fn pad_end(text: &[u16], width: usize) -> String {
  let mut padded = String::from_utf16_lossy(text);
  padded.push_str(&" ".repeat(width.saturating_sub(text.len())));
  padded
}

/// `formatProvenance(entries)`.
fn format_provenance(entries: &[Value]) -> GitResult<String> {
  if entries.is_empty() {
    return Ok(format!(
      "No provenance has been declared for the commits inspected.\n\nProvenance is declared, never inferred: causet records only what an actor stated with --authored-by, --generated-by, --reviewed-by, or the {AGENT_ENV} environment variable."
    ));
  }
  let mut lines = vec!["Declared provenance (unverified claims, not detection)".to_string()];
  for entry in entries {
    let member = |name: &str| get(Some(entry), name);
    let origin = if matches!(member("origin"), Some(Value::String(units)) if lossy(units) == "carried")
    {
      let sources = match member("carriedFrom") {
        Some(Value::Array(items)) => items
          .iter()
          .map(|source| match source {
            Value::String(units) => Ok(Value::String(units[..units.len().min(12)].to_vec())),
            Value::Array(items) => Ok(Value::Array(items[..items.len().min(12)].to_vec())),
            other => Err(not_callable("c", "slice", Some(other))),
          })
          .collect::<GitResult<Vec<_>>>()?,
        other => return Err(not_callable("entry.carriedFrom", "map", other)),
      };
      format!(
        "carried from {}",
        String::from_utf16_lossy(&join(&sources, &js(", ")))
      )
    } else {
      "declared".to_string()
    };
    let commit = text(member("commit"));
    lines.push(format!(
      "{}  {}",
      String::from_utf16_lossy(&commit.encode_utf16().take(12).collect::<Vec<_>>()),
      text(member("subject"))
    ));
    lines.push(format!("  {}  {origin}", text(member("id"))));
    let actors: Vec<Value> = match member("actors") {
      Some(Value::Array(items)) => items.clone(),
      Some(Value::String(units)) => String::from_utf16_lossy(units)
        .chars()
        .map(|c| string(&c.to_string()))
        .collect(),
      _ => return Err(GitError::uncoded("entry.actors is not iterable")),
    };
    for actor in &actors {
      let role = match actor {
        Value::Null => {
          return Err(GitError::uncoded(
            "Cannot read properties of null (reading 'role')",
          ));
        }
        other => get(Some(other), "role"),
      };
      let role = match role {
        Some(Value::String(units)) => pad_end(units, 9),
        other => return Err(not_callable("actor.role", "padEnd", other)),
      };
      lines.push(format!(
        "    {role} {}",
        String::from_utf16_lossy(&to_js_string(get(Some(actor), "actor")))
      ));
    }
  }
  Ok(lines.join("\n"))
}

/// `cst provenance [revision] [--all] [--json]`.
pub fn provenance(parsed: &Parsed, cwd: &str) -> GitResult<Value> {
  // `positionals[0] ?? "HEAD"`: an empty argument stays empty.
  let revision = parsed
    .positionals
    .first()
    .cloned()
    .unwrap_or_else(|| "HEAD".into());
  let commits = if parsed.truthy("all") {
    engine::reachable_commits(&revision, cwd)?
  } else {
    vec![engine::resolve_revision(&revision, cwd)?]
  };
  let entries = entries(&commits, cwd)?;
  if parsed.truthy("json") {
    let mut report = Object::new();
    report.set("revision", string(&revision));
    report.set("inspected", Value::Number(commits.len() as f64));
    report.set("entries", Value::Array(entries));
    return Ok(Value::Object(report));
  }
  Ok(string(&format_provenance(&entries)?))
}

/// `for (const actor of record.actors ?? [])`: an array's items, nothing for a
/// missing or empty value, and a failure wherever JavaScript would throw. A
/// string's characters have no `role`, so `normalizeActors` refuses them.
fn carried_actor_entries(actors: Option<&Value>) -> GitResult<&[Value]> {
  match actors {
    None | Some(Value::Null) => Ok(&[]),
    Some(Value::Array(items)) => Ok(items),
    Some(Value::String(units)) if units.is_empty() => Ok(&[]),
    Some(_) => Err(GitError::uncoded("record.actors is not a list of actors")),
  }
}

/// `String(entry?.[name] ?? "")`.
fn member_text(entry: &Value, name: &str) -> String {
  let value = get(Some(entry), name);
  if nullish(value) { String::new() } else { text(value) }
}

/// `carryProvenance(fromCommits, toCommit, changeId, cwd)`: the union of the
/// sources' declared actors, attached to `to_commit` as a `carried` record
/// naming its immediate sources, or `None` when no source declared anything.
///
/// `known` is a read of many commits' provenance a publication loop already
/// made, so the notes ref is listed once for the loop rather than once per
/// application (ADR-0013).
fn carry_provenance(
  from_commits: &[String],
  to_commit: &str,
  change_id: Option<&str>,
  cwd: &str,
  known: Option<&[(String, Vec<Value>)]>,
) -> GitResult<Option<Value>> {
  let mut sources: Vec<String> = from_commits.iter().filter(|commit| !commit.is_empty()).cloned().collect();
  sources.sort();
  sources.dedup();
  let read;
  let existing = match known {
    Some(known) => known,
    None => {
      read = provenance_for(&sources, cwd)?;
      &read
    }
  };
  if existing.is_empty() {
    return Ok(None);
  }
  let mut actors = Vec::new();
  let mut carried_from = Vec::new();
  for commit in &sources {
    let Some((_, records)) = existing.iter().find(|(candidate, _)| candidate == commit) else {
      continue;
    };
    carried_from.push(commit.clone());
    for record in records {
      for entry in carried_actor_entries(get(Some(record), "actors"))? {
        actors.push(Actor { role: member_text(entry, "role"), actor: member_text(entry, "actor") });
      }
    }
  }
  let normalized = normalize_actors(&actors)?;
  if normalized.is_empty() {
    return Ok(None);
  }
  let record = provenance_record(to_commit, change_id, &normalized, "carried", &carried_from)?;
  append_note(to_commit, &record, cwd, &[])?;
  Ok(Some(record))
}

/// `carryProvenanceSafely(fromCommits, toCommit, changeId, cwd)`: a failure
/// never loses the rewrite that already happened, so it is dropped here as
/// every caller in `src/` drops the returned error.
pub fn carry_provenance_safely(from_commits: &[String], to_commit: &str, change_id: Option<&str>, cwd: &str) {
  let _ = carry_provenance(from_commits, to_commit, change_id, cwd, None);
}

/// `carryProvenanceForApplications(applications, cwd)`: provenance carried for
/// a whole publication loop from one read of the notes ref. Each application
/// names its origin, its result and the change the result bears.
pub fn carry_provenance_for_applications(applications: &[(String, String, Option<String>)], cwd: &str) -> GitResult<()> {
  if applications.is_empty() {
    return Ok(());
  }
  let origins: Vec<String> = applications
    .iter()
    .map(|(origin, ..)| origin.clone())
    .filter(|origin| !origin.is_empty())
    .collect();
  let known = provenance_for(&origins, cwd)?;
  if known.is_empty() {
    return Ok(());
  }
  for (origin, applied, change_id) in applications {
    let _ = carry_provenance(std::slice::from_ref(origin), applied, change_id.as_deref(), cwd, Some(&known));
  }
  Ok(())
}
