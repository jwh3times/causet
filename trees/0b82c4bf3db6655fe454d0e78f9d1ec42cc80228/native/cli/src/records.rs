//! The human renderings of causal records in `src/cli.js`: `formatReceipts`
//! (for `cst receipts`) and `formatCausalEdges` (for `cst graph`). A record is
//! untrusted JSON, so every member is rendered as a template literal renders
//! it, and a member of the wrong type fails where the JavaScript throws, with
//! its message.

use causet_engine::errors::{GitError, GitResult};
use causet_model::js::{
  get, join, length, nullish, same_value_zero, strict_equals, text, to_fixed, to_js_string, truthy,
};
use causet_model::json::{Value, js};

/// `short(value)`: the first twelve UTF-16 units of `String(value)`, or `-`.
pub fn short(value: Option<&Value>) -> String {
  if !truthy(value) {
    return "-".into();
  }
  let units = to_js_string(value);
  String::from_utf16_lossy(&units[..units.len().min(12)])
}

/// `a ?? b`.
fn or<'a>(value: Option<&'a Value>, fallback: Option<&'a Value>) -> Option<&'a Value> {
  if nullish(value) { fallback } else { value }
}

/// `${a ?? "text"}`.
fn or_text(value: Option<&Value>, fallback: &str) -> String {
  if nullish(value) {
    fallback.into()
  } else {
    text(value)
  }
}

/// `${(value ?? []).length}`.
fn count(value: Option<&Value>) -> String {
  if nullish(value) {
    return "0".into();
  }
  text(length(value).as_ref())
}

/// The `TypeError` V8 raises for `<expression>.<method>(...)` on `value`.
pub fn not_callable(expression: &str, method: &str, value: Option<&Value>) -> GitError {
  match value {
    None => GitError::uncoded(format!(
      "Cannot read properties of undefined (reading '{method}')"
    )),
    Some(Value::Null) => GitError::uncoded(format!(
      "Cannot read properties of null (reading '{method}')"
    )),
    _ => GitError::uncoded(format!("{expression}.{method} is not a function")),
  }
}

/// `<expression>.join(separator)`, which only an array can answer.
fn join_member(value: Option<&Value>, expression: &str, separator: &str) -> GitResult<String> {
  match value {
    Some(Value::Array(items)) => Ok(String::from_utf16_lossy(&join(items, &js(separator)))),
    other => Err(not_callable(expression, "join", other)),
  }
}

/// `<expression>.toFixed(2)`, which only a number can answer.
fn fixed(value: Option<&Value>, expression: &str) -> GitResult<String> {
  match value {
    Some(Value::Number(number)) => Ok(to_fixed(*number, 2)),
    other => Err(not_callable(expression, "toFixed", other)),
  }
}

/// `item.<name>` inside a `.map` callback, which throws on `null`.
fn item_member<'a>(item: &'a Value, name: &str) -> GitResult<Option<&'a Value>> {
  match item {
    Value::Null => Err(GitError::uncoded(format!(
      "Cannot read properties of null (reading '{name}')"
    ))),
    other => Ok(get(Some(other), name)),
  }
}

/// `<expression>.map(callback)`, which only an array can answer.
fn map_member<T>(
  value: Option<&Value>,
  expression: &str,
  callback: impl Fn(&Value) -> GitResult<T>,
) -> GitResult<Vec<T>> {
  match value {
    Some(Value::Array(items)) => items.iter().map(callback).collect(),
    other => Err(not_callable(expression, "map", other)),
  }
}

/// `recordTitle(record)`.
fn record_title(record: &Value) -> String {
  let kind = text(or(
    get(Some(record), "type"),
    Some(&causet_model::json::string("record")),
  ));
  format!(
    "{} {}",
    kind.to_uppercase(),
    or_text(get(Some(record), "id"), "(no id)")
  )
}

/// `formatGitActivity(git)`.
fn git_activity(git: Option<&Value>) -> GitResult<Option<String>> {
  if !truthy(git) {
    return Ok(None);
  }
  let processes = or(get(git, "processes"), get(git, "count"));
  Ok(Some(format!(
    "git work     {} processes; {} queries ({} ms)",
    text(processes),
    text(get(git, "count")),
    fixed(get(git, "totalMs"), "git.totalMs")?
  )))
}

/// `formatReceipt(record)`.
fn format_receipt(record: &Value) -> GitResult<String> {
  let member = |name: &str| get(Some(record), name);
  let attached = member("attachedTo");
  let kind = member("type");
  let is = |name: &str| strict_equals(kind, Some(&causet_model::json::string(name)));
  let mut lines = vec![record_title(record)];
  let conflicts = |lines: &mut Vec<String>| -> GitResult<()> {
    if truthy(
      length(or(
        member("conflictedPaths"),
        Some(&Value::Array(Vec::new())),
      ))
      .as_ref(),
    ) {
      lines.push(format!(
        "  conflicts   {}",
        join_member(member("conflictedPaths"), "record.conflictedPaths", ", ")?
      ));
    }
    Ok(())
  };
  let timings = member("timings");
  if is("landing") {
    lines.push(format!(
      "  landing     {}",
      short(or(member("landingCommit"), attached))
    ));
    lines.push(format!(
      "  source      {} @ {}",
      or_text(member("sourceRef"), "-"),
      short(member("sourceHead"))
    ));
    lines.push(format!("  mode        {}", or_text(member("mode"), "-")));
    lines.push(format!(
      "  absorbed    {} changes in {} commits",
      count(member("absorbedChanges")),
      count(member("absorbedCommits"))
    ));
  } else if is("application") {
    lines.push(format!(
      "  applied     {} <= {}",
      short(or(member("appliedCommit"), attached)),
      short(member("originCommit"))
    ));
    lines.push(format!(
      "  change      {}",
      or_text(or(member("appliedChangeId"), member("originChangeId")), "-")
    ));
    lines.push(format!(
      "  relation    {}",
      or_text(member("relation"), "-")
    ));
    conflicts(&mut lines)?;
    if truthy(length(or(member("resolutions"), Some(&Value::Array(Vec::new())))).as_ref()) {
      let decisions = map_member(member("resolutions"), "record.resolutions", |item| {
        Ok(
          item_member(item, "decision")?
            .cloned()
            .unwrap_or(Value::Null),
        )
      })?;
      lines.push(format!(
        "  resolutions {}",
        String::from_utf16_lossy(&join(&decisions, &js(", ")))
      ));
    }
    if truthy(
      length(or(
        member("semanticMerges"),
        Some(&Value::Array(Vec::new())),
      ))
      .as_ref(),
    ) {
      let merges = map_member(member("semanticMerges"), "record.semanticMerges", |item| {
        let decision = item_member(item, "decision")?;
        Ok(format!(
          "{}:{}",
          or_text(decision, "recorded"),
          text(get(Some(item), "path"))
        ))
      })?;
      lines.push(format!("  spec merges {}", merges.join(", ")));
    }
  } else if is("rebase-application") {
    lines.push(format!(
      "  replayed    {} <= {}",
      short(or(member("appliedCommit"), attached)),
      short(member("originCommit"))
    ));
    lines.push(format!(
      "  change      {}",
      or_text(or(member("appliedChangeId"), member("originChangeId")), "-")
    ));
    lines.push(format!(
      "  relation    {}",
      or_text(member("relation"), "-")
    ));
    lines.push(format!(
      "  trees       {} -> {}",
      short(member("targetBeforeTree")),
      short(member("resultTree"))
    ));
    conflicts(&mut lines)?;
  } else if is("resolution") {
    lines.push(format!("  signature   {}", short(member("signature"))));
    lines.push(format!("  result      {}", short(member("resultBlob"))));
    lines.push(format!(
      "  path        {}",
      or_text(member("originalPath"), "-")
    ));
    lines.push(format!(
      "  decision    {}",
      or_text(member("decision"), "-")
    ));
  } else if is("reconciliation") {
    lines.push(format!(
      "  result      {}",
      short(or(member("resultCommit"), attached))
    ));
    lines.push(format!(
      "  source      {} @ {}",
      or_text(member("sourceRef"), "-"),
      short(member("sourceHead"))
    ));
    lines.push(format!(
      "  covered     {} changes; {} applied now",
      count(member("absorbedChanges")),
      count(member("applied"))
    ));
    if truthy(member("forecastId")) {
      lines.push(format!("  forecast    {}", text(member("forecastId"))));
    }
    if get(timings, "activeApplicationMs").is_some() {
      lines.push(format!(
        "  active time {} ms",
        fixed(
          get(timings, "activeApplicationMs"),
          "record.timings.activeApplicationMs"
        )?
      ));
    }
    if get(get(timings, "git"), "count").is_some()
      && let Some(activity) = git_activity(get(timings, "git"))?
    {
      lines.push(format!("  {activity}"));
    }
    if member("exactStateEqualityAfter").is_some() {
      lines.push(format!(
        "  same before {}",
        if truthy(member("exactStateEqualityBefore")) {
          "yes"
        } else {
          "no"
        }
      ));
      lines.push(format!(
        "  same after  {}",
        if truthy(member("exactStateEqualityAfter")) {
          "yes"
        } else {
          "no"
        }
      ));
    } else if member("exactStateEquality").is_some() {
      lines.push(format!(
        "  same before {}",
        if truthy(member("exactStateEquality")) {
          "yes"
        } else {
          "no"
        }
      ));
      lines.push("  same after  not recorded by v1 receipt".into());
    } else {
      lines.push("  same state  not recorded".into());
    }
  } else if is("rebase") {
    lines.push(format!(
      "  result      {}",
      short(or(member("resultCommit"), attached))
    ));
    lines.push(format!(
      "  source      {} @ {}",
      or_text(member("sourceRef"), "-"),
      short(member("sourceHead"))
    ));
    lines.push(format!(
      "  onto        {} @ {}",
      or_text(member("ontoRef"), "-"),
      short(member("ontoHead"))
    ));
    lines.push(format!(
      "  coverage    {} changes; {} replayed",
      count(member("absorbedChanges")),
      count(member("applications"))
    ));
    lines.push(format!(
      "  same state  {}",
      if truthy(member("exactStateEqualityAfter")) {
        "yes"
      } else {
        "no"
      }
    ));
    if truthy(member("forecastId")) {
      lines.push(format!("  forecast    {}", text(member("forecastId"))));
    }
    if get(timings, "activeApplicationMs").is_some() {
      lines.push(format!(
        "  active time {} ms",
        fixed(
          get(timings, "activeApplicationMs"),
          "record.timings.activeApplicationMs"
        )?
      ));
    }
  } else {
    lines.push(format!("  attached    {}", short(attached)));
  }
  if truthy(member("createdAt")) {
    lines.push(format!("  created     {}", text(member("createdAt"))));
  }
  Ok(lines.join("\n"))
}

/// `formatReceipts(records)`.
pub fn format_receipts(records: &[Value]) -> GitResult<String> {
  if records.is_empty() {
    return Ok("No causal records found.".into());
  }
  let rendered = records
    .iter()
    .map(format_receipt)
    .collect::<GitResult<Vec<_>>>()?;
  Ok(format!(
    "{} causal record{}\n\n{}",
    records.len(),
    if records.len() == 1 { "" } else { "s" },
    rendered.join("\n\n")
  ))
}

/// `formatCausalEdges(records)`.
pub fn format_causal_edges(records: &[Value]) -> GitResult<String> {
  fn member<'a>(record: &'a Value, name: &str) -> Option<&'a Value> {
    get(Some(record), name)
  }
  let is = |record: &Value, name: &str| {
    strict_equals(
      member(record, "type"),
      Some(&causet_model::json::string(name)),
    )
  };
  // A `Map` from `${resultCommit}:${sourceHead}` to the last such record.
  let mut by_application: Vec<(String, usize)> = Vec::new();
  for (index, record) in records.iter().enumerate() {
    let applied = member(record, "applied");
    let single = matches!(length(applied), Some(Value::Number(count)) if count == 1.0);
    if !is(record, "reconciliation") || !single {
      continue;
    }
    // `record.applied[0]`: an array's first item, a string's first unit, or
    // an object's own "0" member.
    let application = match applied {
      Some(Value::Array(items)) => items.first().cloned(),
      Some(Value::String(units)) => Some(Value::String(units[..1].to_vec())),
      other => get(other, "0").cloned(),
    };
    let source = match &application {
      None => {
        return Err(GitError::uncoded(
          "Cannot read properties of undefined (reading 'sourceCommit')",
        ));
      }
      Some(Value::Null) => {
        return Err(GitError::uncoded(
          "Cannot read properties of null (reading 'sourceCommit')",
        ));
      }
      Some(item) => item,
    };
    if strict_equals(
      get(Some(source), "sourceCommit"),
      member(record, "sourceHead"),
    ) && strict_equals(
      get(Some(source), "appliedCommit"),
      member(record, "resultCommit"),
    ) {
      let key = format!(
        "{}:{}",
        text(member(record, "resultCommit")),
        text(member(record, "sourceHead"))
      );
      by_application.retain(|(existing, _)| *existing != key);
      by_application.push((key, index));
    }
  }
  // The ids of the reconciliations an application line already covered: a
  // `Set`, so a string id matches by value and an object id only itself.
  let mut consumed: Vec<(usize, Option<Value>)> = Vec::new();
  let is_consumed = |consumed: &[(usize, Option<Value>)], index: usize, id: Option<&Value>| {
    consumed.iter().any(|(owner, seen)| {
      *owner == index
        || match (seen, id) {
          (Some(Value::Object(_) | Value::Array(_)), _) => false,
          (seen, id) => same_value_zero(seen.as_ref(), id),
        }
    })
  };
  let mut lines = Vec::new();
  for (index, record) in records.iter().enumerate() {
    let attached = member(record, "attachedTo");
    if is(record, "landing") {
      lines.push(format!(
        "{} <= {}  {}; {} changes absorbed",
        short(or(member(record, "landingCommit"), attached)),
        short(member(record, "sourceHead")),
        text(member(record, "mode")),
        count(member(record, "absorbedChanges"))
      ));
    } else if is(record, "application") {
      let relation = or_text(member(record, "relation"), "application");
      let key = format!(
        "{}:{}",
        text(or(member(record, "appliedCommit"), attached)),
        text(member(record, "originCommit"))
      );
      let reconciliation = by_application
        .iter()
        .find(|(existing, _)| *existing == key)
        .map(|(_, owner)| *owner);
      let suffix = match reconciliation {
        Some(owner) => {
          let covered = get(Some(&records[owner]), "absorbedChanges");
          let covered = match length(covered) {
            value if nullish(covered) || nullish(value.as_ref()) => "0".to_string(),
            value => text(value.as_ref()),
          };
          consumed.push((owner, get(Some(&records[owner]), "id").cloned()));
          format!("; reconciliation {covered} covered")
        }
        None => String::new(),
      };
      lines.push(format!(
        "{} <= {}  {relation} {}{suffix}",
        short(or(member(record, "appliedCommit"), attached)),
        short(member(record, "originCommit")),
        or_text(
          or(
            member(record, "appliedChangeId"),
            member(record, "originChangeId")
          ),
          "unknown"
        )
      ));
    } else if is(record, "rebase-application") {
      lines.push(format!(
        "{} <= {}  {} {}",
        short(or(member(record, "appliedCommit"), attached)),
        short(member(record, "originCommit")),
        or_text(member(record, "relation"), "causal-rebase"),
        or_text(
          or(
            member(record, "appliedChangeId"),
            member(record, "originChangeId")
          ),
          "unknown"
        )
      ));
    } else if is(record, "reconciliation") {
      if is_consumed(&consumed, index, member(record, "id")) {
        continue;
      }
      lines.push(format!(
        "{} <= {}  reconcile; {} covered, {} applied",
        short(or(member(record, "resultCommit"), attached)),
        short(member(record, "sourceHead")),
        count(member(record, "absorbedChanges")),
        count(member(record, "applied"))
      ));
    } else if is(record, "rebase") {
      lines.push(format!(
        "{} <= {}  rebase onto {}; {} covered, {} replayed",
        short(or(member(record, "resultCommit"), attached)),
        short(member(record, "sourceHead")),
        short(member(record, "ontoHead")),
        count(member(record, "absorbedChanges")),
        count(member(record, "applications"))
      ));
    }
  }
  if lines.is_empty() {
    return Ok("  (none)".into());
  }
  Ok(
    lines
      .iter()
      .map(|line| format!("  {line}"))
      .collect::<Vec<_>>()
      .join("\n"),
  )
}
