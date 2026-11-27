//! `cst provenance`: the declared provenance of commits, read from their
//! notes and never derived (FR-TRUST-04), as `src/cli.js` and
//! `src/provenance.js` answer it.

use crate::notes::read_notes;
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
