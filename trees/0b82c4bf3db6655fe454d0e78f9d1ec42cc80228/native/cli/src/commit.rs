//! `cst commit`: `createCommit` of `src/operations.js` with the declared
//! provenance of `src/provenance.js`.

use crate::host;
use crate::notes_write::{append_note, with_notes_lock};
use crate::parsed::{Opt, Parsed};
use causet_engine::errors::{GitError, GitResult};
use causet_engine::process::{RunOptions, run_git};
use causet_engine::{engine, environment, text};
use causet_model::js::locale_compare;
use causet_model::json::{Object, Value, string};
use causet_model::schemas::within_bound;

const PROVENANCE_SCHEMA: &str = "causet.provenance/v1";
const PROVENANCE_ROLES: [&str; 3] = ["authored", "generated", "reviewed"];

#[derive(Clone)]
pub struct Actor {
  pub role: String,
  pub actor: String,
}

/// `normalizeActors(actors)`: validated, deduplicated on the pair, and ordered
/// so the same declaration always produces the same record bytes.
pub(crate) fn normalize_actors(actors: &[Actor]) -> GitResult<Vec<Actor>> {
  let mut seen: Vec<Actor> = Vec::new();
  for entry in actors {
    let role = text::trim(&entry.role).to_string();
    let actor = text::trim(&entry.actor).to_string();
    if !PROVENANCE_ROLES.contains(&role.as_str()) {
      return Err(
        GitError::new("invalid-identifier", format!("'{role}' is not a provenance role."))
          .details(format!("Roles are: {}.", PROVENANCE_ROLES.join(", "))),
      );
    }
    if actor.is_empty() {
      return Err(GitError::new(
        "invalid-identifier",
        format!("The '{role}' provenance role needs an actor name."),
      ));
    }
    match seen.iter_mut().find(|known| known.role == role && known.actor == actor) {
      Some(known) => *known = Actor { role, actor },
      None => seen.push(Actor { role, actor }),
    }
  }
  seen.sort_by(|left, right| {
    locale_compare(&left.role, &right.role).then_with(|| locale_compare(&left.actor, &right.actor))
  });
  Ok(seen)
}

/// `declaredActors(options)`: the `--authored-by`, `--generated-by` and
/// `--reviewed-by` declarations, and `CAUSET_AGENT` as a generating actor.
pub fn declared_actors(parsed: &Parsed) -> GitResult<Vec<Actor>> {
  let mut actors = Vec::new();
  for (role, key) in [("authored", "authoredBy"), ("generated", "generatedBy"), ("reviewed", "reviewedBy")] {
    let values: Vec<String> = match parsed.options.get(key) {
      Some(Opt::Values(values)) => values.clone(),
      Some(Opt::Value(value)) if !value.is_empty() => vec![value.clone()],
      // A later `--authoredBy` replaces the list with `true`, which
      // `String(true)` names as an actor.
      Some(Opt::Flag) => vec!["true".to_string()],
      _ => Vec::new(),
    };
    for actor in values {
      actors.push(Actor { role: role.into(), actor });
    }
  }
  if let Some(agent) = environment::value("AGENT") {
    let agent = text::trim(&agent);
    if !agent.is_empty() {
      actors.push(Actor { role: "generated".into(), actor: agent.into() });
    }
  }
  normalize_actors(&actors)
}

fn actors_value(actors: &[Actor]) -> Value {
  Value::Array(
    actors
      .iter()
      .map(|entry| {
        let mut object = Object::new();
        object.set("role", string(&entry.role));
        object.set("actor", string(&entry.actor));
        Value::Object(object)
      })
      .collect(),
  )
}

/// `provenanceRecord(commit, changeId, actors, origin, carriedFrom)`.
pub(crate) fn provenance_record(
  commit: &str,
  change_id: Option<&str>,
  actors: &[Actor],
  origin: &str,
  carried_from: &[String],
) -> GitResult<Value> {
  if !within_bound("provenanceActors", actors.len() as u64) {
    let limit = causet_model::registry::RESOURCE_BOUNDS
      .iter()
      .find(|(bound, _)| *bound == "provenanceActors")
      .map_or(0, |(_, limit)| *limit);
    return Err(
      GitError::new(
        "resource-bound-exceeded",
        format!(
          "A provenance record would carry {} actors, over the provenanceActors bound of {limit}.",
          actors.len()
        ),
      )
      .details(
        "Provenance carried through a landing is the union of the absorbed commits' actors; see docs/schemas/compatibility.md.",
      ),
    );
  }
  let mut record = Object::new();
  record.set("schema", string(PROVENANCE_SCHEMA));
  record.set("type", string("provenance"));
  record.set("id", string(&host::new_id("prov")));
  record.set("commit", string(commit));
  record.set("changeId", change_id.map_or(Value::Null, string));
  record.set("actors", actors_value(actors));
  record.set("origin", string(origin));
  record.set("carriedFrom", Value::Array(carried_from.iter().map(|commit| string(commit)).collect()));
  record.set("createdAt", string(&causet_engine::metrics::iso_now()));
  Ok(Value::Object(record))
}

/// `declareProvenance(commit, changeId, actors, cwd)`: the record attached, or
/// `None` when nothing was declared.
fn declare_provenance(commit: &str, change_id: &str, actors: &[Actor], cwd: &str) -> GitResult<Option<Value>> {
  let normalized = normalize_actors(actors)?;
  if normalized.is_empty() {
    return Ok(None);
  }
  let record = provenance_record(commit, Some(change_id), &normalized, "declared", &[])?;
  append_note(commit, &record, cwd, &[])?;
  Ok(Some(record))
}

fn commit_with_provenance(message: &str, all: bool, allow_empty: bool, actors: &[Actor], cwd: &str) -> GitResult<Value> {
  let change_id = host::new_id("ch");
  let mut args = vec!["commit".to_string()];
  if all {
    args.push("--all".into());
  }
  if allow_empty {
    args.push("--allow-empty".into());
  }
  args.push("-m".into());
  args.push(format!("{message}\n\nChange-Id: {change_id}"));
  run_git(&args, &RunOptions::new(cwd))?;
  let commit = engine::current_head(cwd)?;
  let provenance = declare_provenance(&commit, &change_id, actors, cwd).map_err(|error| {
    let details: Vec<String> = [
      error.message.clone(),
      error.details.clone(),
      format!("Keep this commit and inspect it with 'git show {commit}' and 'cst provenance {commit}'."),
      "Do not retry commit as though it failed before creation. After fixing the notes write failure, use the provenance repair procedure in docs/identity/README.md to attach the original declaration to this exact commit.".into(),
    ]
    .into_iter()
    .filter(|part| !part.is_empty())
    .collect();
    let exit_code = error.exit_code;
    let mut failure = GitError::new(
      error.code,
      format!("Commit '{commit}' was created, but declared provenance could not be published."),
    )
    .details(details.join("\n"));
    failure.exit_code = exit_code;
    failure
  })?;
  let mut result = Object::new();
  result.set("commit", string(&commit));
  result.set("changeId", string(&change_id));
  result.set("message", string(&engine::commit_message(&commit, cwd)?));
  if let Some(provenance) = provenance {
    result.set("provenance", provenance);
  }
  Ok(Value::Object(result))
}

/// `createCommit(message, options)`: the notes lock is taken before Git can
/// change HEAD whenever provenance will be published.
pub fn create_commit(message: &str, all: bool, allow_empty: bool, actors: &[Actor], cwd: &str) -> GitResult<Value> {
  if actors.is_empty() {
    return commit_with_provenance(message, all, allow_empty, actors, cwd);
  }
  with_notes_lock(cwd, || commit_with_provenance(message, all, allow_empty, actors, cwd))
}
