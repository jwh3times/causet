//! `cst audit identity`: the repository-wide identity audit of
//! `src/identity-audit.js` (FR-ID-06) and its rendering in `src/cli.js`.
//! Records are untrusted JSON, so every member is compared and printed with
//! JavaScript semantics, and a member of the wrong type fails where the
//! JavaScript throws.

use crate::notes::list_note_records;
use causet_engine::errors::{GitError, GitResult};
use causet_engine::types::HistoryOptions;
use causet_engine::{engine, text};
use causet_model::js::{
  default_sort, get, locale_compare, nullish, same_value_zero, strict_equals, text as js_text,
  to_js_string, truthy, try_v8_sort_by,
};
use causet_model::json::{Object, Value, lossy, string};
use std::collections::HashMap;

pub const IDENTITY_AUDIT_SCHEMA: &str = "causet.identity-audit/v1";

fn number(value: usize) -> Value {
  Value::Number(value as f64)
}

fn strings(items: &[String]) -> Value {
  Value::Array(items.iter().map(|item| string(item)).collect())
}

/// The `Change-Id` of one line: `/^Change-Id:\s*(.+?)\s*$/i` without the
/// multiline flag, so `^` and `$` are the line's ends.
fn line_trailer(line: &str) -> Option<String> {
  let chars: Vec<char> = line.chars().collect();
  let prefix: Vec<char> = "change-id:".chars().collect();
  if chars.len() < prefix.len()
    || !chars
      .iter()
      .zip(&prefix)
      .all(|(actual, expected)| actual.is_ascii() && actual.to_ascii_lowercase() == *expected)
  {
    return None;
  }
  let after = prefix.len();
  let mut run = 0;
  while after + run < chars.len() && text::is_space(chars[after + run]) {
    run += 1;
  }
  let tail = |at: usize| chars[at..].iter().all(|c| text::is_space(*c));
  for skipped in (0..=run).rev() {
    let capture = after + skipped;
    let mut end = capture;
    while end < chars.len() && !text::is_line_terminator(chars[end]) {
      end += 1;
      if tail(end) {
        let captured: String = chars[capture..end].iter().collect();
        return Some(text::trim(&captured).to_string());
      }
    }
  }
  None
}

/// `changeIdTrailers(message)`: every `Change-Id` trailer, in order.
fn change_id_trailers(message: &str) -> Vec<String> {
  text::split_lines(message)
    .into_iter()
    .filter_map(line_trailer)
    .collect()
}

/// A JavaScript value as a `Map` or `Set` key: by value for a primitive, by
/// identity for an object or array (`unique` numbers each occurrence).
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
enum Key {
  Text(Vec<u16>),
  Number(u64),
  Bool(bool),
  Null,
  Unique(usize),
}

struct Keys(usize);

impl Keys {
  fn of(&mut self, value: &Value) -> Key {
    match value {
      Value::String(units) => Key::Text(units.clone()),
      Value::Number(number) => Key::Number(if *number == 0.0 {
        0
      } else if number.is_nan() {
        u64::MAX
      } else {
        number.to_bits()
      }),
      Value::Bool(flag) => Key::Bool(*flag),
      Value::Null => Key::Null,
      Value::Array(_) | Value::Object(_) => {
        self.0 += 1;
        Key::Unique(self.0)
      }
    }
  }
}

/// Union-find over keys (`makeComponents`).
#[derive(Default)]
struct Components {
  parent: HashMap<Key, Key>,
}

impl Components {
  fn find(&mut self, node: &Key) -> Key {
    let mut root = node.clone();
    while let Some(parent) = self.parent.get(&root) {
      if *parent == root {
        break;
      }
      root = parent.clone();
    }
    self
      .parent
      .entry(node.clone())
      .or_insert_with(|| node.clone());
    let mut cursor = node.clone();
    while let Some(next) = self.parent.get(&cursor).cloned() {
      if next == root || next == cursor {
        break;
      }
      self.parent.insert(cursor, root.clone());
      cursor = next;
    }
    root
  }

  fn union(&mut self, left: &Key, right: &Key) {
    let a = self.find(left);
    let b = self.find(right);
    if a != b {
      self.parent.insert(a, b);
    }
  }
}

fn is_application(record: &Value) -> bool {
  matches!(
    as_text(get(Some(record), "type")).as_deref(),
    Some("application" | "rebase-application")
  )
}

fn as_text(value: Option<&Value>) -> Option<String> {
  match value {
    Some(Value::String(units)) => Some(lossy(units)),
    _ => None,
  }
}

/// `a ?? b`.
fn or<'a>(value: Option<&'a Value>, fallback: Option<&'a Value>) -> Option<&'a Value> {
  if nullish(value) { fallback } else { value }
}

/// `actorTokens(actor)`: the lowercase alphanumeric words of a name.
fn actor_tokens(actor: &str) -> Vec<String> {
  let lowered = actor.to_lowercase();
  let mut tokens = Vec::new();
  let mut current = String::new();
  for c in lowered.chars() {
    if c.is_ascii_lowercase() || c.is_ascii_digit() {
      current.push(c);
    } else if !current.is_empty() {
      tokens.push(std::mem::take(&mut current));
    }
  }
  if !current.is_empty() {
    tokens.push(current);
  }
  tokens
}

/// `nearDuplicateActorNames(left, right)`.
fn near_duplicate(left: &str, right: &str) -> bool {
  if left == right {
    return false;
  }
  let (a, b) = (actor_tokens(left), actor_tokens(right));
  if a.is_empty() || b.is_empty() {
    return false;
  }
  if a.join(" ") == b.join(" ") {
    return true;
  }
  let (small, large) = if a.len() <= b.len() {
    (&a, &b)
  } else {
    (&b, &a)
  };
  if !small.iter().all(|token| large.contains(token)) {
    return false;
  }
  large
    .iter()
    .any(|token| !small.contains(token) && !token.bytes().all(|byte| byte.is_ascii_digit()))
}

struct Finding {
  code: &'static str,
  severity: &'static str,
  message: String,
  extra: Vec<(&'static str, Value)>,
}

/// The `TypeError` of `for (const { actor } of record.actors ?? [])`.
fn actors_of(record: &Value) -> GitResult<Vec<Value>> {
  match get(Some(record), "actors") {
    value if nullish(value) => Ok(Vec::new()),
    Some(Value::Array(items)) => Ok(items.clone()),
    Some(Value::String(units)) => Ok(
      String::from_utf16_lossy(units)
        .chars()
        .map(|c| string(&c.to_string()))
        .collect(),
    ),
    Some(Value::Number(number)) => Err(GitError::uncoded(format!(
      "number {} is not iterable (cannot read property Symbol(Symbol.iterator))",
      causet_model::json::number_to_string(*number)
    ))),
    Some(Value::Bool(flag)) => Err(GitError::uncoded(format!(
      "boolean {flag} is not iterable (cannot read property Symbol(Symbol.iterator))"
    ))),
    _ => Err(GitError::uncoded(
      "object is not iterable (cannot read property Symbol(Symbol.iterator))",
    )),
  }
}

/// `auditIdentity(cwd)`.
pub fn audit_identity(cwd: &str) -> GitResult<Value> {
  let context = engine::repo_context(cwd)?;
  let commits = engine::commit_history(&["--all".to_string()], cwd, HistoryOptions::default())?;
  let records = list_note_records(cwd)?;
  let applications: Vec<&Value> = records
    .iter()
    .filter(|record| is_application(record))
    .collect();
  let mut findings: Vec<Finding> = Vec::new();
  let mut keys = Keys(0);

  // 1. A commit message that claims two identities.
  let mut trailers_by_commit: HashMap<String, Vec<String>> = HashMap::new();
  for commit in &commits {
    let trailers = change_id_trailers(&commit.message);
    let mut distinct: Vec<String> = Vec::new();
    for trailer in &trailers {
      if !distinct.contains(trailer) {
        distinct.push(trailer.clone());
      }
    }
    trailers_by_commit.insert(commit.commit.clone(), trailers);
    if distinct.len() > 1 {
      findings.push(Finding {
        code: "conflicting-change-id-trailer",
        severity: "error",
        message: format!(
          "Commit {} carries {} different Change-Id trailers; planning reads only the first.",
          commit.commit,
          distinct.len()
        ),
        extra: vec![
          ("commit", string(&commit.commit)),
          ("changeIds", strings(&distinct)),
        ],
      });
    }
  }

  // 2. Identity-preserving derivation links commits that may share an ID.
  let mut components = Components::default();
  for record in &applications {
    let member = |name: &str| get(Some(record), name);
    let origin = member("originCommit");
    let applied = or(member("appliedCommit"), member("attachedTo"));
    if !truthy(origin) || !truthy(applied) {
      continue;
    }
    if truthy(member("originChangeId"))
      && truthy(member("appliedChangeId"))
      && strict_equals(member("originChangeId"), member("appliedChangeId"))
    {
      let (origin, applied) = (
        keys.of(origin.unwrap_or(&Value::Null)),
        keys.of(applied.unwrap_or(&Value::Null)),
      );
      components.union(&origin, &applied);
    }
  }
  let mut by_change_id: Vec<(String, Vec<String>)> = Vec::new();
  for commit in &commits {
    let trailers = trailers_by_commit
      .get(&commit.commit)
      .cloned()
      .unwrap_or_default();
    let mut seen: Vec<String> = Vec::new();
    for change_id in trailers {
      if seen.contains(&change_id) {
        continue;
      }
      seen.push(change_id.clone());
      match by_change_id
        .iter_mut()
        .find(|(existing, _)| *existing == change_id)
      {
        Some((_, bearers)) => bearers.push(commit.commit.clone()),
        None => by_change_id.push((change_id, vec![commit.commit.clone()])),
      }
    }
  }
  // `[...map].sort()`: entries ordered by their `ToString`, `id,commit,...`.
  let mut sorted = by_change_id.clone();
  sorted.sort_by(|left, right| {
    let key = |entry: &(String, Vec<String>)| format!("{},{}", entry.0, entry.1.join(","));
    text::compare(&key(left), &key(right))
  });
  for (change_id, bearers) in &sorted {
    if bearers.len() < 2 {
      continue;
    }
    let mut groups: Vec<(Key, Vec<String>)> = Vec::new();
    for commit in bearers {
      let root = components.find(&Key::Text(commit.encode_utf16().collect()));
      match groups.iter_mut().find(|(existing, _)| *existing == root) {
        Some((_, group)) => group.push(commit.clone()),
        None => groups.push((root, vec![commit.clone()])),
      }
    }
    if groups.len() > 1 {
      let mut all = bearers.clone();
      text::sort(&mut all);
      findings.push(Finding {
        code: "change-id-collision",
        severity: "error",
        message: format!(
          "Change-Id {change_id} is carried by {} commits in {} groups with no recorded derivation between them.",
          bearers.len(),
          groups.len()
        ),
        extra: vec![
          ("changeId", string(change_id)),
          ("commits", strings(&all)),
          (
            "unlinkedGroups",
            Value::Array(
              groups
                .into_iter()
                .map(|(_, mut group)| {
                  text::sort(&mut group);
                  strings(&group)
                })
                .collect(),
            ),
          ),
        ],
      });
    }
  }

  // 3. One applied commit, several claimed origins: a `Map` of `Map`s, keyed
  //    by `SameValueZero`, the later record for one origin winning.
  let mut origins_by_applied: Vec<(Value, Key, Vec<(Value, Key, Option<Value>)>)> = Vec::new();
  for record in &applications {
    let member = |name: &str| get(Some(record), name);
    let applied = or(member("appliedCommit"), member("attachedTo"));
    if !truthy(applied) || !truthy(member("originCommit")) {
      continue;
    }
    let applied = applied.cloned().unwrap_or(Value::Null);
    let applied_key = keys.of(&applied);
    let origin = member("originCommit").cloned().unwrap_or(Value::Null);
    let id = member("id").cloned();
    let position = origins_by_applied.iter().position(|(value, key, _)| {
      *key == applied_key
        || same_value_zero(Some(value), Some(&applied))
          && !matches!(applied, Value::Array(_) | Value::Object(_))
    });
    let index = match position {
      Some(index) => index,
      None => {
        origins_by_applied.push((applied.clone(), applied_key, Vec::new()));
        origins_by_applied.len() - 1
      }
    };
    let origins = &mut origins_by_applied[index].2;
    let origin_key = keys.of(&origin);
    let existing = origins.iter().position(|(value, _, _)| {
      same_value_zero(Some(value), Some(&origin))
        && !matches!(origin, Value::Array(_) | Value::Object(_))
    });
    match existing {
      Some(at) => origins[at].2 = id,
      None => origins.push((origin, origin_key, id)),
    }
  }
  let mut applied_sorted = origins_by_applied;
  applied_sorted.sort_by(|left, right| {
    let key = |value: &Value| format!("{},[object Map]", js_text(Some(value)));
    text::compare(&key(&left.0), &key(&right.0))
  });
  for (applied, _, origins) in applied_sorted {
    if origins.len() < 2 {
      continue;
    }
    let mut entries: Vec<(Value, Option<Value>)> = origins
      .into_iter()
      .map(|(origin, _, id)| (origin, id))
      .collect();
    try_v8_sort_by(&mut entries, |left, right| {
      let this = match &left.0 {
        Value::String(units) => lossy(units),
        Value::Null => {
          return Err(GitError::uncoded(
            "Cannot read properties of null (reading 'localeCompare')",
          ));
        }
        _ => {
          return Err(GitError::uncoded(
            "left.originCommit.localeCompare is not a function",
          ));
        }
      };
      let that = js_text(Some(&right.0));
      Ok(match locale_compare(&this, &that) {
        std::cmp::Ordering::Less => -1.0,
        std::cmp::Ordering::Equal => 0.0,
        std::cmp::Ordering::Greater => 1.0,
      })
    })?;
    let count = entries.len();
    findings.push(Finding {
      code: "ambiguous-origin",
      severity: "error",
      message: format!(
        "Commit {} is claimed by {count} application records with different origins.",
        js_text(Some(&applied))
      ),
      extra: vec![
        ("commit", applied.clone()),
        (
          "origins",
          Value::Array(
            entries
              .into_iter()
              .map(|(origin, id)| {
                let mut entry = Object::new();
                entry.set("originCommit", origin);
                if let Some(id) = id {
                  entry.set("recordId", id);
                }
                Value::Object(entry)
              })
              .collect(),
          ),
        ),
      ],
    });
  }

  // 4/5. The identity invariants the records are meant to hold.
  for record in &applications {
    let member = |name: &str| get(Some(record), name);
    if !truthy(member("originChangeId")) || !truthy(member("appliedChangeId")) {
      continue;
    }
    let forked = as_text(member("relation")).as_deref() == Some("contextual-fork");
    let same = strict_equals(member("originChangeId"), member("appliedChangeId"));
    let id_extra = |extra: &mut Vec<(&'static str, Value)>| {
      if let Some(id) = member("id") {
        extra.push(("recordId", id.clone()));
      }
    };
    if forked && same {
      let mut extra = Vec::new();
      id_extra(&mut extra);
      extra.push((
        "changeId",
        member("originChangeId").cloned().unwrap_or(Value::Null),
      ));
      findings.push(Finding {
        code: "fork-without-new-identity",
        severity: "error",
        message: format!(
          "Record {} is a fork but keeps the origin Change-Id, which FR-ID-03 forbids.",
          js_text(member("id"))
        ),
        extra,
      });
    }
    if !forked && !same {
      let relation = if nullish(member("relation")) {
        "non-fork".to_string()
      } else {
        js_text(member("relation"))
      };
      let mut extra = Vec::new();
      id_extra(&mut extra);
      extra.push((
        "originChangeId",
        member("originChangeId").cloned().unwrap_or(Value::Null),
      ));
      extra.push((
        "appliedChangeId",
        member("appliedChangeId").cloned().unwrap_or(Value::Null),
      ));
      findings.push(Finding {
        code: "identity-not-preserved",
        severity: "error",
        message: format!(
          "Record {} is a {relation} application but changed the Change-Id, which FR-ID-02 forbids.",
          js_text(member("id"))
        ),
        extra,
      });
    }
  }

  // 6. Provenance actor names that look like one actor spelled two ways.
  let mut commits_by_actor: Vec<(String, Vec<Value>)> = Vec::new();
  for record in &records {
    if as_text(get(Some(record), "type")).as_deref() != Some("provenance") {
      continue;
    }
    for item in actors_of(record)? {
      let actor = match &item {
        Value::Null => {
          return Err(GitError::uncoded(
            "Cannot destructure property 'actor' of '.for' as it is null.",
          ));
        }
        other => get(Some(other), "actor"),
      };
      let Some(actor) = as_text(actor).filter(|actor| !actor.is_empty()) else {
        continue;
      };
      let commit = or(get(Some(record), "commit"), get(Some(record), "attachedTo"))
        .cloned()
        .unwrap_or(Value::Null);
      let index = match commits_by_actor
        .iter()
        .position(|(existing, _)| *existing == actor)
      {
        Some(index) => index,
        None => {
          commits_by_actor.push((actor.clone(), Vec::new()));
          commits_by_actor.len() - 1
        }
      };
      let set = &mut commits_by_actor[index].1;
      let present = !matches!(commit, Value::Array(_) | Value::Object(_))
        && set
          .iter()
          .any(|seen| same_value_zero(Some(seen), Some(&commit)));
      if !present {
        set.push(commit);
      }
    }
  }
  let mut actor_names: Vec<String> = commits_by_actor
    .iter()
    .map(|(actor, _)| actor.clone())
    .collect();
  text::sort(&mut actor_names);
  let name_key = |name: &str| Key::Text(name.encode_utf16().collect());
  let mut actor_groups = Components::default();
  for i in 0..actor_names.len() {
    for j in i + 1..actor_names.len() {
      if near_duplicate(&actor_names[i], &actor_names[j]) {
        actor_groups.union(&name_key(&actor_names[i]), &name_key(&actor_names[j]));
      }
    }
  }
  let mut spellings: Vec<(Key, Vec<String>)> = Vec::new();
  for actor in &actor_names {
    let root = actor_groups.find(&name_key(actor));
    match spellings.iter_mut().find(|(existing, _)| *existing == root) {
      Some((_, group)) => group.push(actor.clone()),
      None => spellings.push((root, vec![actor.clone()])),
    }
  }
  for (_, group) in spellings {
    if group.len() < 2 {
      continue;
    }
    let first_commits = group
      .iter()
      .map(|actor| {
        let mut commits = commits_by_actor
          .iter()
          .find(|(existing, _)| existing == actor)
          .map(|(_, commits)| commits.clone())
          .unwrap_or_default();
        default_sort(&mut commits);
        commits.into_iter().next().unwrap_or(Value::Null)
      })
      .collect();
    findings.push(Finding {
      code: "near-duplicate-actor-names",
      severity: "warning",
      message: format!(
        "Provenance names {}, which look like one actor spelled {} ways.",
        group
          .iter()
          .map(|actor| format!("'{actor}'"))
          .collect::<Vec<_>>()
          .join(", "),
        group.len()
      ),
      extra: vec![
        ("actors", strings(&group)),
        ("commits", Value::Array(first_commits)),
      ],
    });
  }

  let errors = findings
    .iter()
    .filter(|item| item.severity == "error")
    .count();
  let warnings = findings
    .iter()
    .filter(|item| item.severity == "warning")
    .count();
  let count = |code: &str| findings.iter().filter(|item| item.code == code).count();
  let mut summary = Object::new();
  summary.set("errors", number(errors));
  summary.set("warnings", number(warnings));
  summary.set("collisions", number(count("change-id-collision")));
  summary.set(
    "conflictingTrailers",
    number(count("conflicting-change-id-trailer")),
  );
  summary.set("ambiguousOrigins", number(count("ambiguous-origin")));
  summary.set(
    "nearDuplicateActors",
    number(count("near-duplicate-actor-names")),
  );
  summary.set("clean", Value::Bool(errors == 0 && warnings == 0));
  findings.sort_by(|left, right| {
    locale_compare(left.code, right.code)
      .then_with(|| locale_compare(&left.message, &right.message))
  });
  let mut repository = Object::new();
  repository.set("root", string(&context.root));
  repository.set("objectFormat", string(&context.object_format));
  let mut scanned = Object::new();
  scanned.set("commits", number(commits.len()));
  scanned.set("changeIds", number(by_change_id.len()));
  scanned.set("applicationRecords", number(applications.len()));
  scanned.set("causalRecords", number(records.len()));
  let mut result = Object::new();
  result.set("schema", string(IDENTITY_AUDIT_SCHEMA));
  result.set("repository", Value::Object(repository));
  result.set("scanned", Value::Object(scanned));
  result.set(
    "findings",
    Value::Array(
      findings
        .iter()
        .map(|item| {
          let mut finding = Object::new();
          finding.set("code", string(item.code));
          finding.set("severity", string(item.severity));
          finding.set("message", string(&item.message));
          for (name, value) in &item.extra {
            finding.set(name, value.clone());
          }
          Value::Object(finding)
        })
        .collect(),
    ),
  );
  result.set("summary", Value::Object(summary));
  Ok(Value::Object(result))
}

/// `formatIdentityAudit(result)`.
pub fn format_identity_audit(result: &Value) -> String {
  let at = |path: &[&str]| {
    path
      .iter()
      .fold(Some(result), |value, name| get(value, name))
  };
  let text = |path: &[&str]| js_text(at(path));
  let mut lines = vec![
    "Identity audit".to_string(),
    format!("repository   {}", text(&["repository", "root"])),
    format!(
      "scanned      {} commits, {} change IDs, {} application records",
      text(&["scanned", "commits"]),
      text(&["scanned", "changeIds"]),
      text(&["scanned", "applicationRecords"])
    ),
    format!("collisions   {}", text(&["summary", "collisions"])),
    format!(
      "trailers     {} commits claiming more than one identity",
      text(&["summary", "conflictingTrailers"])
    ),
    format!(
      "origins      {} commits with more than one claimed origin",
      text(&["summary", "ambiguousOrigins"])
    ),
    format!(
      "actors       {} groups of near-duplicate actor names",
      text(&["summary", "nearDuplicateActors"])
    ),
    format!(
      "findings     {} errors, {} warnings",
      text(&["summary", "errors"]),
      text(&["summary", "warnings"])
    ),
  ];
  if let Some(Value::Array(findings)) = at(&["findings"]) {
    for item in findings {
      let member = |name: &str| get(Some(item), name);
      lines.push(format!(
        "  {} {}: {}",
        if as_text(member("severity")).as_deref() == Some("error") {
          "!"
        } else {
          "?"
        },
        js_text(member("code")),
        String::from_utf16_lossy(&to_js_string(member("message")))
      ));
    }
  }
  lines.push(String::new());
  let errors = matches!(at(&["summary", "errors"]), Some(Value::Number(count)) if *count == 0.0);
  lines.push(
    if truthy(at(&["summary", "clean"])) {
      "No identity collisions or ambiguous origins were found."
    } else if errors {
      "Logical identity is unambiguous; review the warnings above (see docs/identity/README.md §8)."
    } else {
      "Review the findings above; logical identity is not unambiguous in this repository."
    }
    .to_string(),
  );
  lines.join("\n")
}
