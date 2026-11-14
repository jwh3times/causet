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
use causet_model::registry::PROVENANCE_KIND_NAMES;
use causet_model::schemas::within_bound;

const PROVENANCE_SCHEMA: &str = "causet.provenance/v1";
const PROVENANCE_ROLES: [&str; 3] = ["authored", "generated", "reviewed"];

/// A declared actor: `{role, actor}` with the optional `kind` and `for` of
/// ADR-0047 decision 3. An absent kind is unstated, never a claim of either.
#[derive(Clone, Default)]
pub struct Actor {
  pub role: String,
  pub actor: String,
  pub kind: Option<String>,
  /// `for`: whom an agent acts for, present only with kind agent.
  pub on_behalf_of: Option<String>,
}

impl Actor {
  pub fn new(role: &str, actor: &str) -> Actor {
    Actor { role: role.into(), actor: actor.into(), ..Actor::default() }
  }
}

/// What the entries for one actor say about one optional member, united
/// across all of them: an unstated entry is no claim, and once two entries
/// disagree the member stays contested, since a record cannot hold both and
/// choosing one would be a claim nobody made.
#[derive(Clone, PartialEq)]
enum Claim {
  Unstated,
  Stated(String),
  Contested,
}

impl Claim {
  fn of(value: &Option<String>) -> Claim {
    value.clone().map_or(Claim::Unstated, Claim::Stated)
  }

  fn unite(self, other: Claim) -> Claim {
    match (self, other) {
      (Claim::Unstated, other) | (other, Claim::Unstated) => other,
      (Claim::Stated(left), Claim::Stated(right)) if left == right => Claim::Stated(left),
      _ => Claim::Contested,
    }
  }

  fn value(self) -> Option<String> {
    match self {
      Claim::Stated(value) => Some(value),
      Claim::Unstated | Claim::Contested => None,
    }
  }
}

/// `normalizeActors(actors)`: validated, deduplicated on the pair, and ordered
/// so the same declaration always produces the same record bytes. The entries
/// for one pair unite their `kind` and `for` claims (`Claim`), whatever order
/// they come in, and `for` stays only beside kind agent.
pub(crate) fn normalize_actors(actors: &[Actor]) -> GitResult<Vec<Actor>> {
  let mut seen: Vec<(Actor, Claim, Claim)> = Vec::new();
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
    if let Some(kind) = &entry.kind
      && !PROVENANCE_KIND_NAMES.contains(&kind.as_str())
    {
      return Err(
        GitError::new("invalid-identifier", format!("'{kind}' is not an actor kind."))
          .details(format!("Kinds are: {}.", PROVENANCE_KIND_NAMES.join(", "))),
      );
    }
    if entry.on_behalf_of.as_deref().is_some_and(str::is_empty)
      || (entry.on_behalf_of.is_some() && entry.kind.as_deref() != Some("agent"))
    {
      return Err(GitError::new(
        "invalid-identifier",
        format!("The actor '{actor}' names whom it acts for without being an agent."),
      ));
    }
    let (kind, on_behalf_of) = (Claim::of(&entry.kind), Claim::of(&entry.on_behalf_of));
    match seen.iter_mut().find(|(known, ..)| known.role == role && known.actor == actor) {
      Some((_, known_kind, known_for)) => {
        *known_kind = known_kind.clone().unite(kind);
        *known_for = known_for.clone().unite(on_behalf_of);
      }
      None => seen.push((Actor::new(&role, &actor), kind, on_behalf_of)),
    }
  }
  let mut united: Vec<Actor> = seen
    .into_iter()
    .map(|(mut actor, kind, on_behalf_of)| {
      actor.kind = kind.value();
      actor.on_behalf_of = on_behalf_of.value().filter(|_| actor.kind.as_deref() == Some("agent"));
      actor
    })
    .collect();
  united.sort_by(|left, right| {
    locale_compare(&left.role, &right.role).then_with(|| locale_compare(&left.actor, &right.actor))
  });
  Ok(united)
}

/// `declaredActors(options)`: the `--authored-by`, `--generated-by` and
/// `--reviewed-by` declarations, and `CAUSET_AGENT` as a generating actor.
pub fn declared_actors(parsed: &Parsed) -> GitResult<Vec<Actor>> {
  let mut actors = Vec::new();
  for (role, key) in [("authored", "authoredBy"), ("generated", "generatedBy"), ("reviewed", "reviewedBy")] {
    let values: Vec<String> = match parsed.options.get(key) {
      Some(Opt::Values(values)) => values.clone(),
      Some(Opt::Value(value)) if !value.is_empty() => vec![value.clone()],
      // A camel-case spelling never reaches here (#262), so a flag is no
      // actor; it is never named "true".
      _ => Vec::new(),
    };
    for actor in values {
      actors.push(Actor::new(role, &actor));
    }
  }
  if let Some(agent) = environment::value("AGENT") {
    let agent = text::trim(&agent);
    if !agent.is_empty() {
      actors.push(Actor::new("generated", agent));
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
        if let Some(kind) = &entry.kind {
          object.set("kind", string(kind));
        }
        if let Some(on_behalf_of) = &entry.on_behalf_of {
          object.set("for", string(on_behalf_of));
        }
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
      format!("Do not retry commit as though it failed before creation. After fixing the notes write failure, attach the original declaration to this exact commit with 'cst provenance declare {commit}' and the same actors (docs/identity/README.md §7)."),
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

#[cfg(test)]
mod tests {
  use super::*;

  fn kinded(role: &str, actor: &str, kind: Option<&str>, on_behalf_of: Option<&str>) -> Actor {
    Actor {
      role: role.into(),
      actor: actor.into(),
      kind: kind.map(str::to_string),
      on_behalf_of: on_behalf_of.map(str::to_string),
    }
  }

  fn claims(actors: &[Actor]) -> Vec<(Option<String>, Option<String>)> {
    normalize_actors(actors)
      .ok()
      .expect("valid actors")
      .into_iter()
      .map(|actor| (actor.kind, actor.on_behalf_of))
      .collect()
  }

  #[test]
  fn claims_about_one_actor_unite_and_a_disagreement_leaves_the_kind_unstated() {
    let agent = || kinded("generated", "claude", Some("agent"), Some("Ada"));
    let unstated = kinded("generated", "claude", None, None);
    let agreed = (Some("agent".to_string()), Some("Ada".to_string()));
    assert_eq!(claims(&[agent(), unstated.clone()]), vec![agreed.clone()]);
    assert_eq!(claims(&[unstated, agent()]), vec![agreed]);
    // Nobody claimed both, so the record claims neither.
    let human = kinded("generated", "claude", Some("human"), None);
    assert_eq!(claims(&[agent(), human]), vec![(None, None)]);
    let other = kinded("generated", "claude", Some("agent"), Some("Bob"));
    assert_eq!(claims(&[agent(), other]), vec![(Some("agent".to_string()), None)]);
  }

  #[test]
  fn a_disagreement_stays_settled_whatever_order_the_sources_come_in() {
    // A hard squash unites any number of sources: a later claim must not
    // restore a member an earlier pair already disagreed on.
    let agent = kinded("generated", "claude", Some("agent"), Some("Ada"));
    let human = kinded("generated", "claude", Some("human"), None);
    let bob = kinded("generated", "claude", Some("agent"), Some("Bob"));
    for order in [
      [agent.clone(), human.clone(), agent.clone()],
      [agent.clone(), agent.clone(), human.clone()],
      [human.clone(), agent.clone(), agent.clone()],
    ] {
      assert_eq!(claims(&order), vec![(None, None)]);
    }
    for order in [
      [agent.clone(), bob.clone(), agent.clone()],
      [bob.clone(), agent.clone(), agent.clone()],
    ] {
      assert_eq!(claims(&order), vec![(Some("agent".to_string()), None)]);
    }
  }

  #[test]
  fn a_kind_outside_the_two_or_a_principal_without_an_agent_is_refused() {
    for actor in [
      kinded("generated", "a", Some("robot"), None),
      kinded("generated", "a", None, Some("Ada")),
      kinded("authored", "a", Some("human"), Some("Ada")),
      kinded("generated", "a", Some("agent"), Some("")),
    ] {
      assert!(normalize_actors(&[actor]).is_err());
    }
  }
}
