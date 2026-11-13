//! The program a causal rebase runs, and the messages it commits:
//! `rebaseProgram` of `src/forecasts.js`, `resolveStepParents` and
//! `recreatedMergeMessage` of `src/rebase-topology.js`, and the message
//! helpers of `src/rebase-interactive.js` (ADR-0034, ADR-0035).
//!
//! Both the forecast and the application run the program built here, which is
//! what lets a forecast be an approval of the real run.

use causet_engine::errors::{GitError, GitResult};
use causet_engine::text;
use causet_model::js::{get, nullish, text as js_text};
use causet_model::json::{Object, Value, string};
use std::collections::HashMap;

/// One step of a program: a pick, a recreated merge, or a commit the rewrite
/// leaves out.
pub(crate) struct ProgramItem {
  pub kind: &'static str,
  /// `item.action`: set only by a program that states its parents.
  pub action: Option<String>,
  /// The topology step, which names where the step's parents come from.
  pub step: Option<Value>,
  pub change: Value,
  /// The declared `squash` and `fixup` items this step melds in, each with
  /// the `change` it absorbs.
  pub absorbs: Vec<Value>,
}

impl ProgramItem {
  /// The step as the rebase journal holds it.
  pub fn to_value(&self) -> Value {
    let mut item = Object::new();
    item.set("kind", string(self.kind));
    if self.kind == "pick" {
      if let Some(action) = &self.action {
        item.set("action", string(action));
      }
    }
    if let Some(step) = &self.step {
      item.set("step", step.clone());
    }
    item.set("change", self.change.clone());
    if self.kind == "pick" && self.step.is_some() {
      item.set("absorbs", Value::Array(self.absorbs.clone()));
    }
    Value::Object(item)
  }

  /// A step of a plain queue: `{ kind: "pick", change }`.
  pub fn pick(change: &Value) -> Self {
    ProgramItem {
      kind: "pick",
      action: None,
      step: None,
      change: change.clone(),
      absorbs: Vec::new(),
    }
  }
}

fn as_text(value: Option<&Value>) -> Option<String> {
  match value {
    Some(Value::String(units)) => Some(causet_model::json::lossy(units)),
    _ => None,
  }
}

fn items<'a>(value: Option<&'a Value>) -> &'a [Value] {
  match value {
    Some(Value::Array(items)) => items,
    _ => &[],
  }
}

/// `isAbsorbing(action)`.
pub(crate) fn is_absorbing(action: Option<&Value>) -> bool {
  matches!(as_text(action).as_deref(), Some("squash" | "fixup"))
}

/// `SURVIVING_ACTIONS.has(action)`.
pub(crate) fn is_surviving(action: Option<&Value>) -> bool {
  matches!(as_text(action).as_deref(), Some("replay" | "reword" | "edit"))
}

/// `rebaseProgram(plan)`: every step of the rewrite, in the order the
/// application runs them.
pub(crate) fn rebase_program(plan: &Value) -> Vec<ProgramItem> {
  let changes = items(get(Some(plan), "changes"));
  let replayed: HashMap<String, &Value> = changes
    .iter()
    .filter(|change| is_surviving(get(Some(change), "action")))
    .map(|change| (js_text(get(Some(change), "commit")), change))
    .collect();
  let mut absorbed_into: HashMap<String, Vec<Value>> = HashMap::new();
  for item in items(get(Some(plan), "interactive")) {
    if !is_absorbing(get(Some(item), "action")) {
      continue;
    }
    let mut entry = match item {
      Value::Object(item) => item.clone(),
      _ => Object::new(),
    };
    let commit = get(Some(item), "commit");
    if let Some(change) = changes
      .iter()
      .find(|change| causet_model::js::strict_equals(get(Some(change), "commit"), commit))
    {
      entry.set("change", change.clone());
    }
    absorbed_into
      .entry(js_text(get(Some(item), "target")))
      .or_default()
      .push(Value::Object(entry));
  }
  let merges: HashMap<String, &Value> = items(get(Some(plan), "recreatedMerges"))
    .iter()
    .map(|merge| (js_text(get(Some(merge), "commit")), merge))
    .collect();
  items(get(get(Some(plan), "topology"), "steps"))
    .iter()
    .map(|step| {
      let commit = js_text(get(Some(step), "commit"));
      if as_text(get(Some(step), "kind")).as_deref() == Some("recreate-merge") {
        let merge = merges.get(&commit).copied();
        let or = |name: &str, otherwise: String| match get(merge, name) {
          value if nullish(value) => string(&otherwise),
          value => value.cloned().unwrap_or(Value::Null),
        };
        let mut change = Object::new();
        change.set("commit", string(&commit));
        change.set("shortCommit", or("shortCommit", commit.chars().take(12).collect()));
        change.set("changeId", or("originChangeId", format!("git:{commit}")));
        change.set("subject", or("subject", String::new()));
        return ProgramItem {
          kind: "recreate-merge",
          action: None,
          step: Some(step.clone()),
          change: Value::Object(change),
          absorbs: Vec::new(),
        };
      }
      match replayed.get(&commit) {
        Some(change) => ProgramItem {
          kind: "pick",
          action: as_text(get(Some(change), "action")),
          step: Some(step.clone()),
          change: (*change).clone(),
          absorbs: absorbed_into.get(&commit).cloned().unwrap_or_default(),
        },
        None => {
          let mut change = Object::new();
          change.set("commit", string(&commit));
          ProgramItem {
            kind: "omit",
            action: None,
            step: Some(step.clone()),
            change: Value::Object(change),
            absorbs: Vec::new(),
          }
        }
      }
    })
    .collect()
}

/// A step's new parent: where it comes from, and the commit that is.
pub(crate) struct Parent {
  pub source: Value,
  pub origin: Value,
  pub commit: String,
}

/// `resolveStepParents(step, ontoHead, rewritten)`: the step's new parents
/// against the mapping built so far.
pub(crate) fn resolve_step_parents(
  step: &Value,
  onto_head: &str,
  rewritten: &HashMap<String, String>,
) -> GitResult<Vec<Parent>> {
  items(get(Some(step), "parents"))
    .iter()
    .map(|parent| {
      let resolved = |commit: &str| Parent {
        source: get(Some(parent), "source").cloned().unwrap_or(Value::Null),
        origin: get(Some(parent), "origin").cloned().unwrap_or(Value::Null),
        commit: commit.to_string(),
      };
      if as_text(get(Some(parent), "source")).as_deref() == Some("new-base") {
        return Ok(resolved(onto_head));
      }
      let origin = js_text(get(Some(parent), "origin"));
      match rewritten.get(&origin).filter(|commit| !commit.is_empty()) {
        Some(commit) => Ok(resolved(commit)),
        None => Err(GitError::new(
          "internal-invariant",
          format!(
            "Rebase topology named {} as a parent before it was rewritten.",
            origin.chars().take(12).collect::<String>()
          ),
        )),
      }
    })
    .collect()
}

/// `recreatedMergeMessage({ subject, changeId, originChangeId, originCommit })`.
pub(crate) fn recreated_merge_message(
  subject: Option<&Value>,
  change_id: &str,
  origin_change_id: Option<&Value>,
  origin_commit: &str,
) -> String {
  let subject = match subject {
    value if nullish(value) => String::new(),
    value => js_text(value),
  };
  let heading = match text::trim(&subject) {
    "" => format!("Merge {}", origin_commit.chars().take(12).collect::<String>()),
    trimmed => trimmed.to_string(),
  };
  let derived = match origin_change_id {
    value if nullish(value) => format!("git:{origin_commit}"),
    value => js_text(value),
  };
  format!(
    "{heading}\n\nChange-Id: {change_id}\nDerived-From: {derived}\nOrigin-Commit: {origin_commit}\n"
  )
}

/// `/^Change-Id:\s*/i.test(line)`.
fn is_change_id_line(line: &str) -> bool {
  line
    .get(.."change-id:".len())
    .is_some_and(|start| start.eq_ignore_ascii_case("change-id:"))
}

/// `line.match(/^Change-Id:\s*(.+?)\s*$/i)?.[1]`, as the JavaScript engine
/// backtracks it: the value without the whitespace around it, a single
/// whitespace character for a value of nothing else, and no match where a
/// line terminator other than `\n` interrupts the value.
fn declared_change_id(line: &str) -> Option<String> {
  if !is_change_id_line(line) {
    return None;
  }
  let rest = &line["change-id:".len()..];
  let value = text::trim(rest);
  if value.is_empty() {
    return rest
      .chars()
      .rev()
      .find(|character| !text::is_line_terminator(*character))
      .map(String::from);
  }
  // `.` refuses a line terminator, and only whitespace may follow the value.
  (!value.contains(text::is_line_terminator)).then(|| value.to_string())
}

/// The lines of `text` that are not `Change-Id` trailers, joined and without
/// trailing whitespace.
fn without_identity(message: &str) -> String {
  let kept: Vec<&str> = text::split_lines(message)
    .into_iter()
    .filter(|line| !is_change_id_line(line))
    .collect();
  kept.join("\n").trim_end_matches(text::is_space).to_string()
}

fn declared_identities(message: &str) -> Vec<String> {
  text::split_lines(message)
    .into_iter()
    .filter_map(declared_change_id)
    .filter(|value| !value.is_empty())
    .collect()
}

/// `rewordedMessage(text, changeId)`: the message a `reword` commits, which
/// must not declare another identity and cannot be empty.
pub(crate) fn reworded_message(message: &str, change_id: &str) -> GitResult<String> {
  if declared_identities(message).iter().any(|value| value != change_id) {
    return Err(
      GitError::new(
        "identity-not-preserved",
        format!("A reworded message cannot declare a different identity than {change_id}."),
      )
      .details(
        "Leave the Change-Id out; the operation appends the original. Use --fork if you intend a different logical change.",
      ),
    );
  }
  let body = without_identity(message);
  if text::trim(&body).is_empty() {
    return Err(
      GitError::new("usage-invalid-option-value", "A reworded message cannot be empty.")
        .details("Supply the new message with: cst rebase --continue -m \"<message>\""),
    );
  }
  Ok(format!("{body}\n\nChange-Id: {change_id}\n"))
}

/// `absorbedMessage(survivingMessage, absorbed, changeId)`: the surviving
/// message with the prose of each `squash` under it and exactly one trailer.
/// `absorbed` pairs each absorbed change's action with its message.
pub(crate) fn absorbed_message(surviving: &str, absorbed: &[(String, String)], change_id: &str) -> String {
  let mut parts = vec![without_identity(surviving)];
  for (action, message) in absorbed {
    if action != "squash" {
      continue;
    }
    let prose = without_identity(message);
    if !prose.is_empty() {
      parts.push(prose);
    }
  }
  parts.retain(|part| !part.is_empty());
  format!("{}\n\nChange-Id: {change_id}\n", parts.join("\n\n"))
}

/// `assertSingleIdentity(message, expected)`: exactly one `Change-Id`, and the
/// one the action promised.
pub(crate) fn assert_single_identity(message: &str, expected: &str) -> GitResult<()> {
  let found = declared_identities(message);
  if found.len() == 1 && found[0] == expected {
    return Ok(());
  }
  let message = if found.len() == 1 {
    format!("The rewritten message carries identity {}, not {expected}.", found[0])
  } else {
    format!(
      "The rewritten message carries {} Change-Id trailers; exactly one is required.",
      found.len()
    )
  };
  Err(GitError::new("identity-not-preserved", message).details(
    "Remove the Change-Id lines from the message you supply; the operation appends the right one. Use --fork if you intend a different identity.",
  ))
}

/// `entry.change?.changeId ?? `git:${entry.commit}``.
pub(crate) fn absorbed_change_id(entry: &Value) -> Value {
  match get(get(Some(entry), "change"), "changeId") {
    value if nullish(value) => string(&format!("git:{}", js_text(get(Some(entry), "commit")))),
    value => value.cloned().unwrap_or(Value::Null),
  }
}

/// Whether a program needs the worktree oracle because a step rewrites a
/// commit: `(step.action && step.action !== "replay") || step.absorbs?.length`.
pub(crate) fn is_interactive(program: &[ProgramItem]) -> bool {
  program.iter().any(|item| {
    item.action.as_deref().is_some_and(|action| !action.is_empty() && action != "replay")
      || !item.absorbs.is_empty()
  })
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn declared_identities_follow_the_javascript_expression() {
    assert_eq!(declared_change_id("Change-Id: ch_1  "), Some("ch_1".into()));
    assert_eq!(declared_change_id("change-id:ch_1"), Some("ch_1".into()));
    assert_eq!(declared_change_id("Change-Id:"), None);
    assert_eq!(declared_change_id("Change-Id:   "), Some(" ".into()));
    assert_eq!(declared_change_id("Change-Id: a\rb"), None);
    assert_eq!(declared_change_id("Change-Id: a \r"), Some("a".into()));
    assert_eq!(declared_change_id(" Change-Id: a"), None);
  }

  #[test]
  fn a_surviving_message_keeps_one_identity() {
    let message = absorbed_message(
      "Keep\n\nChange-Id: ch_a\n",
      &[
        ("squash".into(), "Fold\n\nbody\n\nChange-Id: ch_b\n".into()),
        ("fixup".into(), "Drop\n\nChange-Id: ch_c\n".into()),
      ],
      "ch_a",
    );
    assert_eq!(message, "Keep\n\nFold\n\nbody\n\nChange-Id: ch_a\n");
    assert!(assert_single_identity(&message, "ch_a").is_ok());
    assert!(assert_single_identity(&message, "ch_b").is_err());
    assert!(reworded_message("New\n\nChange-Id: ch_b\n", "ch_a").is_err());
    assert_eq!(reworded_message("New\r\nChange-Id: ch_a\n", "ch_a").unwrap(), "New\n\nChange-Id: ch_a\n");
  }

}
