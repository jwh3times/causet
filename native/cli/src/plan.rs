//! `cst merge-plan` and `cst rebase-plan`: the causal planners of
//! `src/merge-plan.js` and `src/rebase-plan.js`, with the topology analysis of
//! `src/rebase-topology.js`, the declared interactive program of
//! `src/rebase-interactive.js`, and their renderings.

use crate::metadata::{accepted_causal_records, read_causal_record_catalog};
use causet_engine::errors::{GitError, GitResult};
use causet_engine::session::with_object_session;
use causet_engine::types::HistoryOptions;
use causet_engine::{engine, text};
use causet_model::js::{get, text as js_text, truthy};
use causet_model::json::{Object, Value, lossy, string, stringify};
use std::collections::{BTreeSet, HashMap, HashSet};

const RECEIPT_TYPES: [&str; 3] = ["landing", "reconciliation", "rebase"];
const NEW_BASE: &str = "new-base";
const REWRITTEN: &str = "rewritten";

fn number(value: usize) -> Value {
  Value::Number(value as f64)
}

fn strings(items: &[String]) -> Value {
  Value::Array(items.iter().map(|item| string(item)).collect())
}

fn nullable(value: Option<&str>) -> Value {
  value.map_or(Value::Null, string)
}

fn as_text(value: Option<&Value>) -> Option<String> {
  match value {
    Some(Value::String(units)) => Some(lossy(units)),
    _ => None,
  }
}

/// `commit.slice(0, 12)`.
fn short(commit: &str) -> String {
  commit.chars().take(12).collect()
}

/// `extractChangeId(commit, message)`.
fn extract_change_id(commit: &str, message: &str) -> String {
  text::extract_trailer(message, "Change-Id").unwrap_or_else(|| format!("git:{commit}"))
}

fn plural(count: usize) -> &'static str {
  if count == 1 { "" } else { "s" }
}

// ---------------------------------------------------------------------------
// Merge plan
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub struct Change {
  commit: String,
  change_id: String,
  subject: String,
  status: &'static str,
  proof: Option<&'static str>,
  changed_paths: Vec<String>,
}

pub struct MergePlan {
  target_head: String,
  source_ref: String,
  source_head: String,
  target_tree: String,
  source_tree: String,
  exact_state_equality: bool,
  physical_base: String,
  effective_base: (String, String),
  reachable_receipts: Vec<String>,
  quarantined_facts: Vec<String>,
  range_base: String,
  changes: Vec<Change>,
}

struct ReceiptCoverage {
  receipts: Vec<Value>,
  commits: HashSet<String>,
  change_ids: HashSet<String>,
  amended: HashSet<String>,
  quarantined: Vec<String>,
}

fn record_type(record: &Value) -> Option<String> {
  as_text(get(Some(record), "type"))
}

fn string_items(value: Option<&Value>) -> Vec<String> {
  match value {
    Some(Value::Array(items)) => items.iter().filter_map(|item| as_text(Some(item))).collect(),
    _ => Vec::new(),
  }
}

/// `receiptCoverage(directCommits, cwd)`.
fn receipt_coverage(direct_commits: &HashSet<String>, cwd: &str) -> GitResult<ReceiptCoverage> {
  let (records, conflicting) = read_causal_record_catalog(cwd)?;
  let reachable: Vec<&Value> = records
    .iter()
    .filter(|record| {
      as_text(get(Some(record), "attachedTo")).is_some_and(|target| direct_commits.contains(&target))
    })
    .collect();
  let receipt_records: Vec<&Value> = reachable
    .iter()
    .copied()
    .filter(|record| record_type(record).is_some_and(|kind| RECEIPT_TYPES.contains(&kind.as_str())))
    .collect();
  let receipts = accepted_causal_records(&receipt_records, cwd, &conflicting)?;
  let mut commits = HashSet::new();
  let mut change_ids = HashSet::new();
  for receipt in &receipts {
    commits.extend(string_items(get(Some(receipt), "absorbedCommits")));
    change_ids.extend(string_items(get(Some(receipt), "absorbedChanges")));
  }
  // `amendedChangeIds(reachable, cwd, conflictingIds)`.
  let amendment_records: Vec<&Value> = reachable
    .iter()
    .copied()
    .filter(|record| record_type(record).as_deref() == Some("amendment"))
    .collect();
  let amended = accepted_causal_records(&amendment_records, cwd, &conflicting)?
    .iter()
    .filter(|record| truthy(get(Some(record), "changeId")))
    .filter_map(|record| as_text(get(Some(record), "changeId")))
    .collect();
  // `quarantinedFacts(reachable, catalog)`.
  let mut quarantined: Vec<String> = reachable
    .iter()
    .filter_map(|record| as_text(get(Some(record), "id")))
    .filter(|id| conflicting.contains(id))
    .collect::<BTreeSet<String>>()
    .into_iter()
    .collect();
  text::sort(&mut quarantined);
  Ok(ReceiptCoverage { receipts, commits, change_ids, amended, quarantined })
}

/// `chooseEffectiveBase(physicalBase, receipts, sourceHead, cwd)`.
fn choose_effective_base(
  physical_base: &str,
  receipts: &[Value],
  source_head: &str,
  cwd: &str,
) -> GitResult<(String, String)> {
  let mut effective = physical_base.to_string();
  let mut reason = "physical-ancestry".to_string();
  for receipt in receipts {
    let candidate = get(Some(receipt), "sourceHead");
    if !truthy(candidate) {
      continue;
    }
    let candidate = js_text(candidate);
    if !engine::is_ancestor(&candidate, source_head, cwd)? {
      continue;
    }
    if engine::is_ancestor(&effective, &candidate, cwd)? {
      effective = candidate;
      reason = format!("causal-receipt:{}", js_text(get(Some(receipt), "id")));
    }
  }
  Ok((effective, reason))
}

fn build_merge_plan_in_session(
  target_ref: &str,
  source_ref: &str,
  cwd: &str,
  range_base: Option<&str>,
) -> GitResult<MergePlan> {
  let heads = engine::resolve_object_ids(
    &[format!("{target_ref}^{{commit}}"), format!("{source_ref}^{{commit}}")],
    cwd,
  )?;
  let (target_head, source_head) = (heads[0].clone(), heads[1].clone());
  let physical_base = engine::merge_base(&target_head, &source_head, cwd)?;
  let trees = engine::resolve_object_ids(
    &[format!("{target_head}^{{tree}}"), format!("{source_head}^{{tree}}")],
    cwd,
  )?;
  let (target_tree, source_tree) = (trees[0].clone(), trees[1].clone());
  let exact_state_equality = target_tree == source_tree;

  // `directChangeCoverage(targetHead, cwd)`.
  let history = engine::commit_history(&[target_head.clone()], cwd, HistoryOptions::default())?;
  let direct_commits: HashSet<String> = history.iter().map(|item| item.commit.clone()).collect();
  let direct_change_ids: HashSet<String> = history
    .iter()
    .map(|item| extract_change_id(&item.commit, &item.message))
    .collect();
  let receipt = receipt_coverage(&direct_commits, cwd)?;
  let candidates: HashSet<String> =
    engine::patch_equivalent_commits(&target_head, &source_head, &physical_base, cwd)?
      .into_iter()
      .collect();
  let range_base = range_base.unwrap_or(&physical_base).to_string();
  let source_history = engine::commit_history(
    &[format!("{range_base}..{source_head}")],
    cwd,
    HistoryOptions { reverse: true, paths: true },
  )?;
  let effective_base = choose_effective_base(&physical_base, &receipt.receipts, &source_head, cwd)?;

  let changes = source_history
    .into_iter()
    .map(|item| {
      let change_id = extract_change_id(&item.commit, &item.message);
      let (status, proof) = if direct_commits.contains(&item.commit) {
        ("covered", Some("commit-ancestry"))
      } else if receipt.commits.contains(&item.commit) {
        ("covered", Some("receipt-commit"))
      } else if direct_change_ids.contains(&change_id) || receipt.change_ids.contains(&change_id) {
        if receipt.amended.contains(&change_id) {
          ("candidate-equivalent", Some("amended-change-id"))
        } else if direct_change_ids.contains(&change_id) {
          ("covered", Some("stable-change-id"))
        } else {
          ("covered", Some("receipt-change-id"))
        }
      } else if candidates.contains(&item.commit) {
        ("candidate-equivalent", Some("git-patch-id-heuristic"))
      } else {
        ("new", None)
      };
      Change {
        commit: item.commit,
        change_id,
        subject: item.subject,
        status,
        proof,
        changed_paths: item.changed_paths.unwrap_or_default(),
      }
    })
    .collect();

  let mut reachable_receipts: Vec<String> = Vec::new();
  for receipt in &receipt.receipts {
    let id = js_text(get(Some(receipt), "id"));
    if !reachable_receipts.contains(&id) {
      reachable_receipts.push(id);
    }
  }

  Ok(MergePlan {
    target_head,
    source_ref: source_ref.to_string(),
    source_head,
    target_tree,
    source_tree,
    exact_state_equality,
    physical_base,
    effective_base,
    reachable_receipts,
    quarantined_facts: receipt.quarantined,
    range_base,
    changes,
  })
}

/// `buildMergePlanBetween(targetRef, sourceRef, cwd, { rangeBase })`.
fn build_merge_plan_between(
  target_ref: &str,
  source_ref: &str,
  cwd: &str,
  range_base: Option<&str>,
) -> GitResult<MergePlan> {
  with_object_session(cwd, || build_merge_plan_in_session(target_ref, source_ref, cwd, range_base))
}

fn counts(changes: &[Change]) -> (usize, usize, usize) {
  let count = |status: &str| changes.iter().filter(|change| change.status == status).count();
  (count("covered"), count("candidate-equivalent"), count("new"))
}

fn counts_value(changes: &[Change]) -> Value {
  let (covered, candidate, new) = counts(changes);
  let mut object = Object::new();
  object.set("covered", number(covered));
  object.set("candidate-equivalent", number(candidate));
  object.set("new", number(new));
  Value::Object(object)
}

fn effective_base_value(base: &(String, String)) -> Value {
  let mut object = Object::new();
  object.set("commit", string(&base.0));
  object.set("reason", string(&base.1));
  Value::Object(object)
}

fn change_object(change: &Change) -> Object {
  let mut object = Object::new();
  object.set("commit", string(&change.commit));
  object.set("shortCommit", string(&short(&change.commit)));
  object.set("changeId", string(&change.change_id));
  object.set("subject", string(&change.subject));
  object.set("status", string(change.status));
  object.set("proof", nullable(change.proof));
  object.set("changedPaths", strings(&change.changed_paths));
  object
}

/// `buildMergePlan(sourceRef)`: the plan for merging `sourceRef` into HEAD.
pub fn merge_plan(source_ref: &str, cwd: &str) -> GitResult<Value> {
  let plan = build_merge_plan_between("HEAD", source_ref, cwd, None)?;
  let mut object = Object::new();
  object.set("schema", string("causet.merge-plan/v1"));
  object.set("targetHead", string(&plan.target_head));
  object.set("sourceRef", string(&plan.source_ref));
  object.set("sourceHead", string(&plan.source_head));
  object.set("targetTree", string(&plan.target_tree));
  object.set("sourceTree", string(&plan.source_tree));
  object.set("exactStateEquality", Value::Bool(plan.exact_state_equality));
  object.set("physicalBase", string(&plan.physical_base));
  object.set("effectiveBase", effective_base_value(&plan.effective_base));
  object.set("reachableReceipts", strings(&plan.reachable_receipts));
  object.set("quarantinedFacts", strings(&plan.quarantined_facts));
  object.set("rangeBase", string(&plan.range_base));
  object.set("counts", counts_value(&plan.changes));
  object.set(
    "changes",
    Value::Array(plan.changes.iter().map(|change| Value::Object(change_object(change))).collect()),
  );
  Ok(Value::Object(object))
}

fn member(value: &Value, name: &str) -> String {
  js_text(get(Some(value), name))
}

fn string_list(value: &Value, name: &str) -> Vec<String> {
  match get(Some(value), name) {
    Some(Value::Array(items)) => items.iter().map(|item| js_text(Some(item))).collect(),
    _ => Vec::new(),
  }
}

fn effective_base_line(plan: &Value) -> String {
  let base = get(Some(plan), "effectiveBase").cloned().unwrap_or(Value::Null);
  format!("{} ({})", short(&member(&base, "commit")), member(&base, "reason"))
}

fn count_of(plan: &Value, name: &str) -> String {
  js_text(get(get(Some(plan), "counts"), name))
}

fn array<'a>(value: &'a Value, name: &str) -> &'a [Value] {
  match get(Some(value), name) {
    Some(Value::Array(items)) => items,
    _ => &[],
  }
}

fn proof_suffix(change: &Value) -> String {
  if truthy(get(Some(change), "proof")) {
    format!(" [{}]", member(change, "proof"))
  } else {
    String::new()
  }
}

/// `formatMergePlan(plan)`.
pub fn format_merge_plan(plan: &Value) -> String {
  let mut lines = vec![
    format!("target       {}", short(&member(plan, "targetHead"))),
    format!("source       {} ({})", member(plan, "sourceRef"), short(&member(plan, "sourceHead"))),
    format!("physical base {}", short(&member(plan, "physicalBase"))),
    format!("effective base {}", effective_base_line(plan)),
    format!(
      "same state   {}",
      if truthy(get(Some(plan), "exactStateEquality")) { "yes" } else { "no" }
    ),
    String::new(),
  ];
  let changes = array(plan, "changes");
  if changes.is_empty() {
    lines.push("No source changes are outside the physical ancestry.".into());
  } else {
    for change in changes {
      let marker = match member(change, "status").as_str() {
        "covered" => "=",
        "candidate-equivalent" => "?",
        _ => "+",
      };
      lines.push(format!(
        "{marker} {} {} {}{}",
        member(change, "shortCommit"),
        member(change, "changeId"),
        member(change, "subject"),
        proof_suffix(change)
      ));
    }
  }
  lines.push(String::new());
  lines.push(format!(
    "summary      {} covered, {} candidate, {} new",
    count_of(plan, "covered"),
    count_of(plan, "candidate-equivalent"),
    count_of(plan, "new")
  ));
  let quarantined = string_list(plan, "quarantinedFacts");
  if !quarantined.is_empty() {
    lines.push(format!(
      "quarantined  {} reachable fact{} excluded: {}",
      quarantined.len(),
      plural(quarantined.len()),
      quarantined.join(", ")
    ));
    lines.push("Coverage was computed on reduced evidence; resolve with cst metadata dispose.".into());
  }
  if count_of(plan, "candidate-equivalent") != "0" {
    lines.push("Candidates are advisory and are never silently suppressed.".into());
  }
  lines.join("\n")
}

// ---------------------------------------------------------------------------
// Rebase topology (`src/rebase-topology.js`)
// ---------------------------------------------------------------------------

struct Parent {
  source: &'static str,
  origin: Option<String>,
}

struct Step {
  kind: &'static str,
  commit: String,
  parents: Vec<Parent>,
}

struct Unsupported {
  commit: String,
  parents: Vec<String>,
  reason: &'static str,
  code: &'static str,
  details: String,
}

struct Topology {
  range_base: String,
  source_head: String,
  onto_head: String,
  merge_commits: Vec<String>,
  unsupported_merges: Vec<Unsupported>,
  steps: Vec<Step>,
}

/// `unsupportedShape(node, ontoHead, inRange, cwd)`.
fn unsupported_shape(
  commit: &str,
  parents: &[String],
  onto_head: &str,
  in_range: &HashSet<String>,
  cwd: &str,
) -> GitResult<Option<Unsupported>> {
  if parents.len() > 2 {
    return Ok(Some(Unsupported {
      commit: commit.to_string(),
      parents: parents.to_vec(),
      reason: "octopus-merge",
      code: "unsupported-repository-shape",
      details: format!(
        "{} joins {} parents. The order an octopus merge resolved in is not recoverable from the result, so its recreation cannot be forecast.",
        short(commit),
        parents.len()
      ),
    }));
  }
  for parent in parents {
    if in_range.contains(parent) || engine::is_ancestor(parent, onto_head, cwd)? {
      continue;
    }
    return Ok(Some(Unsupported {
      commit: commit.to_string(),
      parents: parents.to_vec(),
      reason: "parent-outside-range",
      code: "unsupported-range",
      details: format!(
        "{} joins {}, which is neither in the rebased range nor an ancestor of the new base. The join would reference a line this rebase is not rewriting and cannot map.",
        short(commit),
        short(parent)
      ),
    }));
  }
  Ok(None)
}

/// `analyzeRebaseTopology(rangeBase, sourceHead, ontoHead, cwd)`.
fn analyze_rebase_topology(
  range_base: &str,
  source_head: &str,
  onto_head: &str,
  cwd: &str,
) -> GitResult<Topology> {
  let nodes = engine::commit_topology(range_base, source_head, cwd)?;
  let in_range: HashSet<String> = nodes.iter().map(|node| node.commit.clone()).collect();
  let mut unsupported_merges = Vec::new();
  let mut steps = Vec::new();
  let mut merge_commits = Vec::new();
  for node in &nodes {
    let is_merge = node.parents.len() > 1;
    if is_merge {
      merge_commits.push(node.commit.clone());
      if let Some(unsupported) =
        unsupported_shape(&node.commit, &node.parents, onto_head, &in_range, cwd)?
      {
        unsupported_merges.push(unsupported);
        continue;
      }
    }
    let parents = if node.parents.is_empty() {
      vec![Parent { source: NEW_BASE, origin: None }]
    } else {
      node
        .parents
        .iter()
        .map(|parent| Parent {
          source: if in_range.contains(parent) { REWRITTEN } else { NEW_BASE },
          origin: Some(parent.clone()),
        })
        .collect()
    };
    steps.push(Step {
      kind: if is_merge { "recreate-merge" } else { "pick" },
      commit: node.commit.clone(),
      parents,
    });
  }
  Ok(Topology {
    range_base: range_base.to_string(),
    source_head: source_head.to_string(),
    onto_head: onto_head.to_string(),
    merge_commits,
    unsupported_merges,
    steps,
  })
}

fn unsupported_value(item: &Unsupported) -> Value {
  let mut object = Object::new();
  object.set("commit", string(&item.commit));
  object.set("parents", strings(&item.parents));
  object.set("reason", string(item.reason));
  object.set("code", string(item.code));
  object.set("details", string(&item.details));
  Value::Object(object)
}

fn topology_value(topology: &Topology) -> Value {
  let steps = topology
    .steps
    .iter()
    .map(|step| {
      let parents = step
        .parents
        .iter()
        .map(|parent| {
          let mut object = Object::new();
          object.set("source", string(parent.source));
          object.set("origin", nullable(parent.origin.as_deref()));
          Value::Object(object)
        })
        .collect();
      let mut object = Object::new();
      object.set("kind", string(step.kind));
      object.set("commit", string(&step.commit));
      object.set("parents", Value::Array(parents));
      Value::Object(object)
    })
    .collect();
  let mut object = Object::new();
  object.set("rangeBase", string(&topology.range_base));
  object.set("sourceHead", string(&topology.source_head));
  object.set("ontoHead", string(&topology.onto_head));
  object.set("mergeCommits", strings(&topology.merge_commits));
  object.set(
    "unsupportedMerges",
    Value::Array(topology.unsupported_merges.iter().map(unsupported_value).collect()),
  );
  object.set("steps", Value::Array(steps));
  object.set("linearHistory", Value::Bool(topology.merge_commits.is_empty()));
  object.set("supported", Value::Bool(topology.unsupported_merges.is_empty()));
  Value::Object(object)
}

/// `topologyFingerprintInput(topology)`.
fn topology_fingerprint_input(topology: &Topology) -> Value {
  Value::Array(
    topology
      .steps
      .iter()
      .filter(|step| step.kind == "recreate-merge")
      .map(|step| {
        let mut object = Object::new();
        object.set("commit", string(&step.commit));
        object.set(
          "parents",
          Value::Array(
            step
              .parents
              .iter()
              .map(|parent| {
                Value::Array(vec![string(parent.source), nullable(parent.origin.as_deref())])
              })
              .collect(),
          ),
        );
        Value::Object(object)
      })
      .collect(),
  )
}

// ---------------------------------------------------------------------------
// Declared interactive actions (`src/rebase-interactive.js`)
// ---------------------------------------------------------------------------

const INTERACTIVE_ACTIONS: [&str; 4] = ["reword", "edit", "squash", "fixup"];

fn is_absorbing(action: &str) -> bool {
  matches!(action, "squash" | "fixup")
}

struct Declaration {
  action: &'static str,
  subject: String,
  target: Option<String>,
}

/// `parseDeclaration(action, value)`.
fn parse_declaration(action: &'static str, value: &str) -> GitResult<Declaration> {
  let text_value = text::trim(value);
  if text_value.is_empty() {
    return Err(
      GitError::new("usage-missing-argument", format!("--{action} requires a commit."))
        .details(if is_absorbing(action) {
          format!("Use --{action} <subject>=<target>.")
        } else {
          format!("Use --{action} <commit>.")
        }),
    );
  }
  // Positions are UTF-16 offsets in JavaScript; `=` is ASCII, so the byte
  // offset of the first one splits the same text.
  let separator = text_value.find('=');
  if !is_absorbing(action) {
    if separator.is_some() {
      return Err(
        GitError::new("usage-invalid-option-value", format!("--{action} names one commit, not a pair."))
          .details(format!(
            "Use --{action} <commit>. Only --squash and --fixup take <subject>=<target>."
          )),
      );
    }
    return Ok(Declaration { action, subject: text_value.to_string(), target: None });
  }
  match separator {
    Some(index) if index > 0 && index != text_value.len() - 1 => Ok(Declaration {
      action,
      subject: text::trim(&text_value[..index]).to_string(),
      target: Some(text::trim(&text_value[index + 1..]).to_string()),
    }),
    _ => Err(
      GitError::new(
        "usage-invalid-option-value",
        format!("--{action} needs both a subject and a target."),
      )
      .details(format!(
        "Use --{action} <subject>=<target>. The target is the commit that survives and keeps its identity."
      )),
    ),
  }
}

/// `declaredInteractiveActions(options)`.
fn declared_interactive_actions(values: &HashMap<&'static str, Vec<String>>) -> GitResult<Vec<Declaration>> {
  let mut declarations = Vec::new();
  for action in INTERACTIVE_ACTIONS {
    for value in values.get(action).map(Vec::as_slice).unwrap_or_default() {
      declarations.push(parse_declaration(action, value)?);
    }
  }
  Ok(declarations)
}

#[derive(Clone)]
struct Action {
  action: &'static str,
  commit: String,
  target: Option<String>,
}

fn refuse(message: String, details: &str) -> GitError {
  GitError::new("unsupported-range", message).details(details)
}

/// `resolveInteractiveProgram(declarations, plan, resolve)`: the actions in
/// range order, and the action each subject commit takes.
fn resolve_interactive_program(
  declarations: &[Declaration],
  changes: &[RebaseChange],
  merge_commits: &[String],
  cwd: &str,
) -> GitResult<(Vec<Action>, HashMap<String, Action>)> {
  if declarations.is_empty() {
    return Ok((Vec::new(), HashMap::new()));
  }
  let replayable: HashSet<&str> = changes
    .iter()
    .filter(|change| change.action == "replay")
    .map(|change| change.change.commit.as_str())
    .collect();
  let merges: HashSet<&str> = merge_commits.iter().map(String::as_str).collect();
  let range_order: HashMap<&str, usize> = changes
    .iter()
    .enumerate()
    .map(|(index, change)| (change.change.commit.as_str(), index))
    .collect();

  let named = |expression: &str, role: &str, action: &str| -> GitResult<String> {
    let resolved = engine::resolve_object_ids(&[format!("{expression}^{{commit}}")], cwd)
      .ok()
      .and_then(|ids| ids.into_iter().next());
    let Some(commit) = resolved else {
      return Err(refuse(
        format!("--{action} names {expression}, which does not resolve to a commit."),
        "Name a commit inside the rebased range.",
      ));
    };
    if merges.contains(commit.as_str()) {
      return Err(refuse(
        format!("--{action} names the merge {} as its {role}.", short(&commit)),
        "A recreated merge claims nothing, so it has no identity to reword, amend, or absorb (ADR-0034).",
      ));
    }
    if !replayable.contains(commit.as_str()) {
      return Err(refuse(
        format!(
          "--{action} names {} as its {role}, which this rebase does not replay.",
          short(&commit)
        ),
        if range_order.contains_key(commit.as_str()) {
          "The change is already covered, so the rebase omits it and there is nothing to rewrite."
        } else {
          "Name a commit inside the rebased range."
        },
      ));
    }
    Ok(commit)
  };

  let mut actions: Vec<Action> = Vec::new();
  let mut by_commit: HashMap<String, Action> = HashMap::new();
  for declaration in declarations {
    let subject = named(&declaration.subject, "subject", declaration.action)?;
    if let Some(existing) = by_commit.get(&subject) {
      return Err(refuse(
        format!(
          "{} is named by both --{} and --{}.",
          short(&subject),
          existing.action,
          declaration.action
        ),
        "Declare one action per commit; two have no defined composition.",
      ));
    }
    let target = match &declaration.target {
      None => None,
      Some(target) => Some(named(target, "target", declaration.action)?),
    };
    if let Some(target) = &target {
      if *target == subject {
        return Err(refuse(
          format!(
            "--{} would absorb {} into itself.",
            declaration.action,
            short(&subject)
          ),
          "Name a different target; the target is the commit that survives.",
        ));
      }
      if range_order[target.as_str()] > range_order[subject.as_str()] {
        return Err(refuse(
          format!("--{} names a target that comes after its subject.", declaration.action),
          &format!(
            "{} is replayed after {}. Absorption melds a commit into one that has already been applied.",
            short(target),
            short(&subject)
          ),
        ));
      }
    }
    let resolved = Action { action: declaration.action, commit: subject.clone(), target };
    actions.push(resolved.clone());
    by_commit.insert(subject, resolved);
  }

  for action in &actions {
    let Some(target) = &action.target else { continue };
    if let Some(target_action) = by_commit.get(target) {
      if is_absorbing(target_action.action) {
        return Err(refuse(
          format!(
            "--{} absorbs into {}, which is itself absorbed into {}.",
            action.action,
            short(target),
            short(target_action.target.as_deref().unwrap_or_default())
          ),
          "Absorb into a surviving commit. A chain would make the surviving identity depend on the order it is resolved in.",
        ));
      }
    }
  }

  actions.sort_by_key(|action| range_order[action.commit.as_str()]);
  Ok((actions, by_commit))
}

// ---------------------------------------------------------------------------
// Rebase plan (`src/rebase-plan.js`)
// ---------------------------------------------------------------------------

struct RebaseChange {
  change: Change,
  action: &'static str,
}

/// The `--from`, `--reword`, `--edit`, `--squash`, and `--fixup` options.
pub struct RebaseOptions {
  pub from: Option<String>,
  pub interactive: HashMap<&'static str, Vec<String>>,
}

struct Range {
  base_ref: Option<String>,
  base: Option<String>,
  tip: String,
  explicit: bool,
}

/// `currentBranch(cwd)`.
fn current_branch(cwd: &str) -> GitResult<String> {
  match engine::symbolic_ref("HEAD", cwd, true)? {
    Some(branch) if !branch.is_empty() => Ok(branch),
    _ => Err(GitError::new(
      "usage-missing-argument",
      "HEAD is detached; provide an explicit source ref for rebase planning.",
    )),
  }
}

/// `resolveRange(ontoRef, sourceRef, requestedBase, cwd)`.
fn resolve_range(source_ref: &str, requested_base: Option<&str>, cwd: &str) -> GitResult<Range> {
  let tip = engine::resolve_object_ids(&[format!("{source_ref}^{{commit}}")], cwd)?[0].clone();
  let Some(requested_base) = requested_base else {
    return Ok(Range { base_ref: None, base: None, tip, explicit: false });
  };
  let base = engine::resolve_object_ids(&[format!("{requested_base}^{{commit}}")], cwd)?[0].clone();
  if base == tip {
    return Err(
      GitError::new(
        "unsupported-range",
        format!("--from {requested_base} names the source tip, so the range would be empty."),
      )
      .details("Name a commit below the tip; the base is the exclusive lower bound."),
    );
  }
  if !engine::is_ancestor(&base, &tip, cwd)? {
    return Err(
      GitError::new(
        "unsupported-range",
        format!("--from {requested_base} is not an ancestor of {source_ref}."),
      )
      .details("A range runs from an ancestor up to a branch tip."),
    );
  }
  let branch_tips: HashSet<String> = engine::list_refs("refs/heads/", cwd)?
    .into_iter()
    .map(|entry| entry.oid)
    .collect();
  if !branch_tips.contains(&tip) {
    return Err(
      GitError::new(
        "unsupported-range",
        format!("{source_ref} resolves to {}, which is not a branch tip.", short(&tip)),
      )
      .details(
        "The commits after it would need re-parenting, which linear ranges do not do. Name a branch, or use interactive editing when it exists.",
      ),
    );
  }
  Ok(Range {
    base_ref: Some(requested_base.to_string()),
    base: Some(base),
    tip,
    explicit: true,
  })
}

/// `excludedByRange(physicalBase, rangeBase, cwd)`.
fn excluded_by_range(physical_base: &str, range_base: Option<&str>, cwd: &str) -> GitResult<Value> {
  let Some(range_base) = range_base.filter(|base| *base != physical_base) else {
    return Ok(Value::Array(Vec::new()));
  };
  let history = engine::commit_history(
    &[format!("{physical_base}..{range_base}")],
    cwd,
    HistoryOptions { reverse: true, paths: false },
  )?;
  Ok(Value::Array(
    history
      .into_iter()
      .map(|item| {
        let mut object = Object::new();
        object.set("commit", string(&item.commit));
        object.set("changeId", string(&extract_change_id(&item.commit, &item.message)));
        object.set("subject", string(&item.subject));
        Value::Object(object)
      })
      .collect(),
  ))
}

fn rebase_change_value(change: &RebaseChange) -> Value {
  let mut object = change_object(&change.change);
  object.set("action", string(change.action));
  Value::Object(object)
}

/// `fingerprint(plan)`: the plan identity a forecast approval is pinned to.
fn fingerprint(plan: &Object, changes: &[RebaseChange], topology: &Topology, actions: &[Action]) -> String {
  let field = |name: &str| plan.get(name).cloned().unwrap_or(Value::Null);
  let mut input = Object::new();
  for name in ["schema", "mode", "ontoHead", "sourceHead"] {
    input.set(name, field(name));
  }
  input.set("rangeBase", get(plan.get("range"), "base").cloned().unwrap_or(Value::Null));
  for name in ["ontoTree", "sourceTree", "physicalBase", "effectiveBase", "reachableReceipts"] {
    input.set(name, field(name));
  }
  input.set(
    "changes",
    Value::Array(
      changes
        .iter()
        .map(|change| {
          let mut object = Object::new();
          object.set("commit", string(&change.change.commit));
          object.set("changeId", string(&change.change.change_id));
          object.set("status", string(change.change.status));
          object.set("proof", nullable(change.change.proof));
          object.set("action", string(change.action));
          Value::Object(object)
        })
        .collect(),
    ),
  );
  input.set("mergeCommits", strings(&topology.merge_commits));
  input.set("topology", topology_fingerprint_input(topology));
  input.set(
    "interactive",
    Value::Array(
      actions
        .iter()
        .map(|item| {
          Value::Array(vec![
            string(item.action),
            string(&item.commit),
            nullable(item.target.as_deref()),
          ])
        })
        .collect(),
    ),
  );
  causet_model::sha256::hex(stringify(&Value::Object(input)).as_bytes())
}

fn build_rebase_plan_in_session(
  onto_ref: &str,
  requested_source_ref: Option<&str>,
  cwd: &str,
  options: &RebaseOptions,
) -> GitResult<Value> {
  let source_ref = match requested_source_ref {
    Some(source) => source.to_string(),
    None => current_branch(cwd)?,
  };
  let range = resolve_range(&source_ref, options.from.as_deref(), cwd)?;
  let causal = build_merge_plan_between(onto_ref, &source_ref, cwd, range.base.as_deref())?;
  let topology = analyze_rebase_topology(&causal.range_base, &causal.source_head, &causal.target_head, cwd)?;
  let merge_commits: HashSet<&str> = topology.merge_commits.iter().map(String::as_str).collect();
  let mut changes: Vec<RebaseChange> = causal
    .changes
    .iter()
    .filter(|change| !merge_commits.contains(change.commit.as_str()))
    .map(|change| RebaseChange {
      change: change.clone(),
      action: match change.status {
        "covered" => "omit",
        "candidate-equivalent" => "review",
        _ => "replay",
      },
    })
    .collect();
  let change_subjects: HashMap<&str, &Change> = causal
    .changes
    .iter()
    .map(|change| (change.commit.as_str(), change))
    .collect();
  let recreated_merges: Vec<Value> = topology
    .steps
    .iter()
    .filter(|step| step.kind == "recreate-merge")
    .map(|step| {
      let origin = change_subjects.get(step.commit.as_str());
      let parents = step
        .parents
        .iter()
        .map(|parent| {
          let mut object = Object::new();
          object.set("origin", nullable(parent.origin.as_deref()));
          object.set("source", string(parent.source));
          Value::Object(object)
        })
        .collect();
      let mut object = Object::new();
      object.set("commit", string(&step.commit));
      object.set("shortCommit", string(&short(&step.commit)));
      object.set(
        "originChangeId",
        string(&origin.map_or_else(|| format!("git:{}", step.commit), |change| change.change_id.clone())),
      );
      object.set("subject", string(origin.map_or("", |change| change.subject.as_str())));
      object.set("parents", Value::Array(parents));
      Value::Object(object)
    })
    .collect();

  let declared = declared_interactive_actions(&options.interactive)?;
  let (actions, by_commit) =
    resolve_interactive_program(&declared, &changes, &topology.merge_commits, cwd)?;
  for change in &mut changes {
    if let Some(action) = by_commit.get(&change.change.commit) {
      change.action = action.action;
    }
  }

  let surviving = |action: &str| matches!(action, "replay" | "reword" | "edit");
  let replay_queue: Vec<Value> = changes
    .iter()
    .filter(|change| surviving(change.action))
    .map(|change| {
      let mut object = Object::new();
      object.set("commit", string(&change.change.commit));
      object.set("shortCommit", string(&short(&change.change.commit)));
      object.set("changeId", string(&change.change.change_id));
      object.set("subject", string(&change.change.subject));
      object.set("action", string(change.action));
      Value::Object(object)
    })
    .collect();
  let omitted: Vec<Value> = changes
    .iter()
    .filter(|change| change.action == "omit")
    .map(|change| {
      let mut object = Object::new();
      object.set("commit", string(&change.change.commit));
      object.set("changeId", string(&change.change.change_id));
      object.set("proof", nullable(change.change.proof));
      Value::Object(object)
    })
    .collect();
  let candidates: Vec<Value> = changes
    .iter()
    .filter(|change| change.action == "review")
    .map(|change| {
      let mut object = Object::new();
      object.set("commit", string(&change.change.commit));
      object.set("changeId", string(&change.change.change_id));
      object.set("proof", nullable(change.change.proof));
      object.set("subject", string(&change.change.subject));
      Value::Object(object)
    })
    .collect();
  let plain: Vec<Change> = changes.iter().map(|change| change.change.clone()).collect();
  let supported = topology.unsupported_merges.is_empty();
  let linear = topology.merge_commits.is_empty();
  let candidate_decision_required = !candidates.is_empty();

  let mut range_value = Object::new();
  range_value.set("baseRef", nullable(range.base_ref.as_deref()));
  range_value.set("base", string(&causal.range_base));
  range_value.set("tip", string(&range.tip));
  range_value.set("explicit", Value::Bool(range.explicit));

  let mut constraints = Object::new();
  constraints.set("supported", Value::Bool(supported));
  constraints.set("linearHistory", Value::Bool(linear));
  constraints.set("mergeCommits", strings(&topology.merge_commits));
  constraints.set(
    "unsupportedMerges",
    Value::Array(topology.unsupported_merges.iter().map(unsupported_value).collect()),
  );

  let interactive = Value::Array(
    actions
      .iter()
      .map(|item| {
        let mut object = Object::new();
        object.set("action", string(item.action));
        object.set("commit", string(&item.commit));
        object.set("target", nullable(item.target.as_deref()));
        Value::Object(object)
      })
      .collect(),
  );

  let mut plan = Object::new();
  plan.set("schema", string("causet.rebase-plan/v3"));
  plan.set("mode", string(if linear { "linear" } else { "merge-preserving" }));
  plan.set("ontoRef", string(onto_ref));
  plan.set("ontoHead", string(&causal.target_head));
  plan.set("sourceRef", string(&source_ref));
  plan.set("sourceHead", string(&causal.source_head));
  plan.set("ontoTree", string(&causal.target_tree));
  plan.set("sourceTree", string(&causal.source_tree));
  plan.set("exactStateEquality", Value::Bool(causal.exact_state_equality));
  plan.set("physicalBase", string(&causal.physical_base));
  plan.set("effectiveBase", effective_base_value(&causal.effective_base));
  plan.set("reachableReceipts", strings(&causal.reachable_receipts));
  plan.set("quarantinedFacts", strings(&causal.quarantined_facts));
  plan.set("range", Value::Object(range_value));
  plan.set(
    "excludedByRange",
    excluded_by_range(&causal.physical_base, range.base.as_deref(), cwd)?,
  );
  plan.set("constraints", Value::Object(constraints));
  plan.set("counts", counts_value(&plain));
  plan.set("topology", topology_value(&topology));
  plan.set("recreatedMerges", Value::Array(recreated_merges));
  plan.set("interactive", interactive);
  plan.set("changes", Value::Array(changes.iter().map(rebase_change_value).collect()));
  plan.set("replayQueue", Value::Array(replay_queue));
  plan.set("omitted", Value::Array(omitted));
  plan.set("candidates", Value::Array(candidates));
  plan.set("candidateDecisionRequired", Value::Bool(candidate_decision_required));
  plan.set(
    "executableWithoutReview",
    Value::Bool(supported && !candidate_decision_required),
  );
  let fingerprint = fingerprint(&plan, &changes, &topology, &actions);
  plan.set("fingerprint", string(&fingerprint));
  Ok(Value::Object(plan))
}

/// `buildRebasePlan(ontoRef, sourceRef, cwd, options)`.
pub fn rebase_plan(
  onto_ref: &str,
  source_ref: Option<&str>,
  cwd: &str,
  options: &RebaseOptions,
) -> GitResult<Value> {
  with_object_session(cwd, || build_rebase_plan_in_session(onto_ref, source_ref, cwd, options))
}

/// `formatRebasePlan(plan)`.
pub fn format_rebase_plan(plan: &Value) -> String {
  let mut lines = vec![
    if member(plan, "mode") == "merge-preserving" {
      "Causal rebase plan (merge-preserving)".to_string()
    } else {
      "Causal rebase plan".to_string()
    },
    format!("onto          {} ({})", member(plan, "ontoRef"), short(&member(plan, "ontoHead"))),
    format!("source        {} ({})", member(plan, "sourceRef"), short(&member(plan, "sourceHead"))),
    format!("physical base {}", short(&member(plan, "physicalBase"))),
    format!("effective base {}", effective_base_line(plan)),
    format!(
      "same state    {}",
      if truthy(get(Some(plan), "exactStateEquality")) { "yes" } else { "no" }
    ),
    format!("fingerprint   {}", member(plan, "fingerprint")),
    String::new(),
  ];
  let changes = array(plan, "changes");
  if changes.is_empty() {
    lines.push("No source changes are outside the physical ancestry.".into());
  } else {
    for change in changes {
      let action = member(change, "action");
      let marker = match action.as_str() {
        "omit" => "=",
        "review" => "?",
        _ => "+",
      };
      lines.push(format!(
        "{marker} {} {} {} -> {action}{}",
        member(change, "shortCommit"),
        member(change, "changeId"),
        member(change, "subject"),
        proof_suffix(change)
      ));
    }
  }
  lines.push(String::new());
  lines.push(format!(
    "summary       {} omitted, {} review, {} replay",
    count_of(plan, "covered"),
    count_of(plan, "candidate-equivalent"),
    count_of(plan, "new")
  ));
  lines.push(format!("replay queue  {}", array(plan, "replayQueue").len()));
  let merges = array(plan, "recreatedMerges");
  if !merges.is_empty() {
    lines.push(format!(
      "recreated     {} merge{} preserved as joins; each takes a new identity and claims nothing",
      merges.len(),
      plural(merges.len())
    ));
    for merge in merges {
      let parents: Vec<String> = array(merge, "parents")
        .iter()
        .map(|parent| {
          if member(parent, "source") == NEW_BASE {
            "the new base".to_string()
          } else {
            short(&member(parent, "origin"))
          }
        })
        .collect();
      lines.push(format!(
        "  M {} {} <- {}",
        member(merge, "shortCommit"),
        member(merge, "subject"),
        parents.join(" + ")
      ));
    }
  }
  let range = get(Some(plan), "range").cloned().unwrap_or(Value::Null);
  if truthy(get(Some(&range), "explicit")) {
    lines.push(format!(
      "range         {} ({})..{}",
      member(&range, "baseRef"),
      short(&member(&range, "base")),
      short(&member(&range, "tip"))
    ));
  }
  let excluded = array(plan, "excludedByRange");
  if !excluded.is_empty() {
    lines.push(format!(
      "excluded      {} commit{} below the range base stay behind",
      excluded.len(),
      plural(excluded.len())
    ));
    for item in excluded {
      lines.push(format!(
        "  - {} {} {}",
        short(&member(item, "commit")),
        member(item, "changeId"),
        member(item, "subject")
      ));
    }
  }
  let quarantined = string_list(plan, "quarantinedFacts");
  if !quarantined.is_empty() {
    lines.push(format!(
      "quarantined   {} reachable fact{} excluded: {}",
      quarantined.len(),
      plural(quarantined.len()),
      quarantined.join(", ")
    ));
  }
  let constraints = get(Some(plan), "constraints").cloned().unwrap_or(Value::Null);
  if !truthy(get(Some(&constraints), "supported")) {
    let unsupported = array(&constraints, "unsupportedMerges");
    lines.push(format!(
      "unsupported   {} merge commit{} of an unsupported shape; this plan cannot be executed",
      unsupported.len(),
      plural(unsupported.len())
    ));
    for merge in unsupported {
      lines.push(format!(
        "  ! {} {}: {}",
        short(&member(merge, "commit")),
        member(merge, "reason"),
        member(merge, "details")
      ));
    }
  } else if truthy(get(Some(plan), "candidateDecisionRequired")) {
    lines.push("review        heuristic candidates require explicit acceptance".into());
  } else {
    lines.push("execution     no candidate decision is required".into());
  }
  lines.push(String::new());
  lines.push("The current HEAD, index, and working files were not changed.".into());
  lines.join("\n")
}
