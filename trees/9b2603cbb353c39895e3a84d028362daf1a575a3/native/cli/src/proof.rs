//! `cst proof-bundle` and `cst verify-proof`: the portable proof bundle of
//! `src/proof-bundle.js` and the Git bindings of `src/proof-binding.js`, with
//! the command handling and rendering in `src/cli.js`.
//!
//! The bundle is another party's document, so the verifier reproduces the
//! JavaScript reading of every shape it can hold: values compare as `===` and
//! SameValueZero compare them, interpolations use ECMAScript `ToString`, a
//! missing member is `undefined` and leaves its key out of the report, and a
//! member read from `null` fails with the V8 message.

use crate::lineage::{lineage_identity_id, lineage_relation, repository_lineage};
use crate::metadata::{accepted_causal_records, read_causal_record_catalog};
use crate::plan::{coverage_evidence, merge_plan};
use crate::records::short;
use crate::spec::sha1_hex;
use crate::store::assert_within_bound;
use causet_engine::errors::{GitError, GitResult};
use causet_engine::locations::names;
use causet_engine::types::HistoryOptions;
use causet_engine::{engine, text};
use causet_model::canonical::canonical_json;
use causet_model::js::{
  default_sort, get, length, same_value_zero, strict_equals, text as js_text, to_js_string,
  to_number, truthy,
};
use causet_model::json::{JsString, Object, Value, js, lossy, parse, string, stringify, stringify_pretty};
use causet_model::schemas::{canonical_schema, schema_classification, validate_note_record, within_bound};
use std::collections::{HashMap, HashSet};

pub const PROOF_BUNDLE_SCHEMA: &str = "causet.proof-bundle/v2";
const PROOF_BUNDLE_SCHEMA_V1: &str = "causet.proof-bundle/v1";
const READABLE_BUNDLE_SCHEMAS: [&str; 2] = [PROOF_BUNDLE_SCHEMA_V1, PROOF_BUNDLE_SCHEMA];
const RECEIPT_TYPES: [&str; 3] = ["landing", "reconciliation", "rebase"];

fn number(value: usize) -> Value {
  Value::Number(value as f64)
}

fn strings(items: &[String]) -> Value {
  Value::Array(items.iter().map(|item| string(item)).collect())
}

fn as_text(value: Option<&Value>) -> Option<String> {
  match value {
    Some(Value::String(units)) => Some(lossy(units)),
    _ => None,
  }
}

fn object_of(members: Vec<(&str, Value)>) -> Value {
  let mut object = Object::new();
  for (name, value) in members {
    object.set(name, value);
  }
  Value::Object(object)
}

/// A message assembled from text and interpolated values, kept in UTF-16 so a
/// lone surrogate the bundle carried survives into the report.
#[derive(Default)]
struct Message(JsString);

impl Message {
  fn new(text: &str) -> Self {
    Self(js(text))
  }

  fn s(mut self, text: &str) -> Self {
    self.0.extend(js(text));
    self
  }

  /// `${value}`.
  fn v(mut self, value: Option<&Value>) -> Self {
    self.0.extend(to_js_string(value));
    self
  }

  fn units(mut self, units: &[u16]) -> Self {
    self.0.extend_from_slice(units);
    self
  }

  fn value(self) -> Value {
    Value::String(self.0)
  }
}

/// `Cannot read properties of null (reading '<name>')`.
fn read_of_null(name: &str) -> GitError {
  GitError::uncoded(format!("Cannot read properties of null (reading '{name}')"))
}

/// `value.name` where reading from `null` throws.
fn member<'a>(value: Option<&'a Value>, name: &str) -> GitResult<Option<&'a Value>> {
  match value {
    Some(Value::Null) => Err(read_of_null(name)),
    other => Ok(get(other, name)),
  }
}

/// `value[index]` for a JSON value.
fn element(value: Option<&Value>, index: usize) -> Option<Value> {
  match value {
    Some(Value::Array(items)) => items.get(index).cloned(),
    Some(Value::String(units)) => units.get(index).map(|unit| Value::String(vec![*unit])),
    Some(Value::Object(object)) => object.get(&index.to_string()).cloned(),
    _ => None,
  }
}

/// `value ?? fallback` for an optional value.
fn or_null(value: Option<&Value>) -> Value {
  match value {
    None | Some(Value::Null) => Value::Null,
    Some(other) => other.clone(),
  }
}

fn array_items(value: Option<&Value>) -> &[Value] {
  match value {
    Some(Value::Array(items)) => items,
    _ => &[],
  }
}

/// Insert `name` unless the value is `undefined`, as `JSON.stringify` omits it.
fn set_defined(object: &mut Object, name: &str, value: Option<&Value>) {
  if let Some(value) = value {
    object.set(name, value.clone());
  }
}

fn canonical(value: &Value) -> GitResult<String> {
  canonical_json(value).map_err(|error| GitError::uncoded(error.to_string()))
}

fn sha256(text: &str) -> String {
  causet_model::sha256::hex(text.as_bytes())
}

// ---------------------------------------------------------------------------
// Git objects (`src/proof-binding.js`)
// ---------------------------------------------------------------------------

/// `gitObjectId(type, bytes, objectFormat)`.
fn git_object_id(kind: &str, bytes: &[u8], object_format: &str) -> String {
  let mut data = format!("{kind} {}\0", bytes.len()).into_bytes();
  data.extend_from_slice(bytes);
  if object_format == "sha256" {
    causet_model::sha256::hex(&data)
  } else {
    sha1_hex(&data)
  }
}

const BASE64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// `buffer.toString("base64")`.
fn base64_encode(bytes: &[u8]) -> String {
  let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
  for chunk in bytes.chunks(3) {
    let value = (u32::from(chunk[0]) << 16)
      | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
      | u32::from(*chunk.get(2).unwrap_or(&0));
    for index in 0..4 {
      if index <= chunk.len() {
        out.push(BASE64[((value >> (18 - 6 * index)) & 63) as usize] as char);
      } else {
        out.push('=');
      }
    }
  }
  out
}

/// `Buffer.from(text, "base64")`: Node skips every character outside the
/// standard and URL-safe alphabets, stops at the first `=`, and drops the
/// bits of a trailing partial byte.
fn base64_decode(units: &[u16]) -> Vec<u8> {
  let mut out = Vec::with_capacity(units.len() * 3 / 4);
  let mut buffer: u32 = 0;
  let mut bits = 0;
  for unit in units {
    let value = match *unit {
      0x3d => break,
      unit @ 0x41..=0x5a => unit - 0x41,
      unit @ 0x61..=0x7a => unit - 0x61 + 26,
      unit @ 0x30..=0x39 => unit - 0x30 + 52,
      0x2b | 0x2d => 62,
      0x2f | 0x5f => 63,
      _ => continue,
    };
    buffer = (buffer << 6) | u32::from(value);
    bits += 6;
    if bits >= 8 {
      bits -= 8;
      out.push((buffer >> bits) as u8);
      buffer &= (1 << bits) - 1;
    }
  }
  out
}

/// The lines `^…$` sees under the `m` flag.
fn js_lines(text: &str) -> impl Iterator<Item = &str> {
  text.split(text::is_line_terminator)
}

fn hex_after<'a>(line: &'a str, prefix: &str) -> Option<&'a str> {
  line
    .strip_prefix(prefix)
    .filter(|rest| !rest.is_empty() && rest.bytes().all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f')))
}

/// `parseRawCommit(bytes)`.
struct RawCommit {
  tree: Option<String>,
  parents: Vec<String>,
  subject: String,
  change_id: Option<String>,
}

fn parse_raw_commit(bytes: &[u8]) -> RawCommit {
  let text = String::from_utf8_lossy(bytes);
  let (header, message) = match text.find("\n\n") {
    Some(split) => (&text[..split], &text[split + 2..]),
    None => (&text[..], ""),
  };
  RawCommit {
    tree: js_lines(header).find_map(|line| hex_after(line, "tree ")).map(str::to_string),
    parents: js_lines(header)
      .filter_map(|line| hex_after(line, "parent "))
      .map(str::to_string)
      .collect(),
    subject: message.split('\n').next().unwrap_or_default().to_string(),
    change_id: text::extract_trailer(message, "Change-Id"),
  }
}

/// `parseRawTree(bytes, objectFormat)`: each entry's name and object id.
fn parse_raw_tree(bytes: &[u8], object_format: &str) -> Vec<(String, String)> {
  let width = if object_format == "sha256" { 32 } else { 20 };
  let mut entries = Vec::new();
  let mut offset = 0;
  while offset < bytes.len() {
    let Some(space) = bytes[offset..].iter().position(|byte| *byte == b' ').map(|at| offset + at) else {
      break;
    };
    let Some(nul) = bytes[space..].iter().position(|byte| *byte == 0).map(|at| space + at) else {
      break;
    };
    if nul + 1 + width > bytes.len() {
      break;
    }
    let name = String::from_utf8_lossy(&bytes[space + 1..nul]).into_owned();
    let oid: String = bytes[nul + 1..nul + 1 + width]
      .iter()
      .map(|byte| format!("{byte:02x}"))
      .collect();
    entries.push((name, oid));
    offset = nul + 1 + width;
  }
  entries
}

// ---------------------------------------------------------------------------
// Building the bindings
// ---------------------------------------------------------------------------

/// Carried objects, keyed by id, in the order they were added.
#[derive(Default)]
struct Carried {
  order: Vec<String>,
  objects: HashMap<String, (&'static str, Vec<u8>)>,
}

impl Carried {
  fn absorb(&mut self, carried: Vec<(String, &'static str, Vec<u8>)>) {
    for (oid, kind, bytes) in carried {
      if !self.objects.contains_key(&oid) {
        self.order.push(oid.clone());
      }
      self.objects.insert(oid, (kind, bytes));
    }
  }
}

/// `readRaw(oids, type, cwd)`: the raw bytes of every id, or a refusal naming
/// the first one missing.
fn read_raw(oids: &[String], kind: &'static str, cwd: &str) -> GitResult<Vec<(String, &'static str, Vec<u8>)>> {
  let mut unique: Vec<String> = Vec::new();
  for oid in oids {
    if !oid.is_empty() && !unique.contains(oid) {
      unique.push(oid.clone());
    }
  }
  if unique.is_empty() {
    return Ok(Vec::new());
  }
  let objects = engine::read_git_objects(&unique, cwd)?;
  let mut carried = Vec::new();
  for (oid, object) in unique.into_iter().zip(objects.records) {
    if !object.exists || object.kind.as_deref() != Some(kind) {
      return Err(
        GitError::new(
          "not-found",
          format!("Cannot bind the proof bundle: {kind} '{oid}' is missing from this repository."),
        )
        .details("A proof bundle carries Git objects; one that is absent cannot be proven."),
      );
    }
    carried.push((oid, kind, object.content.unwrap_or_default()));
  }
  Ok(carried)
}

/// `commitPath(from, to, cwd)`: the shortest chain from `from` down to `to`.
fn commit_path(from: &str, to: &str, cwd: &str) -> GitResult<Option<Vec<String>>> {
  if from == to {
    return Ok(Some(vec![to.to_string()]));
  }
  let between = engine::ancestry_path(from, to, cwd)?;
  if between.is_empty() {
    return Ok(None);
  }
  let parents_of: HashMap<&str, &Vec<String>> = between
    .iter()
    .map(|row| (row.commit.as_str(), &row.parents))
    .collect();
  let mut queue = std::collections::VecDeque::from([vec![from.to_string()]]);
  let mut seen: HashSet<String> = HashSet::from([from.to_string()]);
  while let Some(chain) = queue.pop_front() {
    let tip = chain.last().expect("non-empty").clone();
    if tip == to {
      return Ok(Some(chain));
    }
    for parent in parents_of.get(tip.as_str()).map(|parents| parents.as_slice()).unwrap_or_default() {
      if seen.insert(parent.clone()) {
        let mut next = chain.clone();
        next.push(parent.clone());
        queue.push_back(next);
      }
    }
  }
  Ok(None)
}

/// `notePath(notesTip, attachment, cwd)`: the trees from the notes commit's
/// root down to the note blob for `attachment`.
fn note_path(notes_tip: &str, attachment: &str, cwd: &str) -> GitResult<Option<(Vec<String>, String)>> {
  let commit = engine::read_git_objects(&[notes_tip.to_string()], cwd)?.records.remove(0);
  if !commit.exists || commit.kind.as_deref() != Some("commit") {
    return Ok(None);
  }
  let root = parse_raw_commit(commit.content.as_deref().unwrap_or_default()).tree;
  let context = engine::repo_context(cwd)?;
  let mut trees = Vec::new();
  let mut current = root;
  let mut remaining = attachment.to_string();
  while let Some(oid) = current.filter(|oid| !oid.is_empty()) {
    trees.push(oid.clone());
    let tree = engine::read_git_objects(&[oid], cwd)?.records.remove(0);
    if !tree.exists || tree.kind.as_deref() != Some("tree") {
      return Ok(None);
    }
    let entries = parse_raw_tree(tree.content.as_deref().unwrap_or_default(), &context.object_format);
    let Some((name, child)) = entries
      .into_iter()
      .find(|(name, _)| remaining == *name || remaining.starts_with(name.as_str()))
    else {
      return Ok(None);
    };
    if name == remaining {
      return Ok(Some((trees, child)));
    }
    remaining = remaining[name.len()..].to_string();
    current = Some(child);
  }
  Ok(None)
}

/// `targetCommitCarrying(changeId, plan, cwd)`.
fn target_commit_carrying(change_id: &str, target_head: &str, cwd: &str) -> GitResult<Option<String>> {
  let history = engine::commit_history(&[target_head.to_string()], cwd, HistoryOptions::default())?;
  for item in history {
    if text::extract_trailer(&item.message, "Change-Id").as_deref() == Some(change_id) {
      return Ok(Some(item.commit));
    }
    if format!("git:{}", item.commit) == change_id {
      return Ok(Some(item.commit));
    }
  }
  Ok(None)
}

fn path_value(claim: &str, subject: &str, from: &str, to: &str, commits: &[String]) -> Value {
  object_of(vec![
    ("claim", string(claim)),
    ("subject", string(subject)),
    ("from", string(from)),
    ("to", string(to)),
    ("commits", strings(commits)),
  ])
}

/// `buildBindings(plan, evidence, lineage, cwd)`: the members a verifier
/// without the repository checks, in the order the bundle carries them.
fn build_bindings(plan: &Value, evidence: &Value, lineage: &Value, cwd: &str) -> GitResult<Vec<(&'static str, Value)>> {
  engine::repo_context(cwd)?;
  let field = |name: &str| js_text(get(Some(plan), name));
  let (target_head, source_head, physical_base) =
    (field("targetHead"), field("sourceHead"), field("physicalBase"));
  let mut carried = Carried::default();

  // 1. The bound source inventory, and every parent its walk needs.
  let inventory: Vec<String> = engine::commit_history(
    &[format!("{physical_base}..{source_head}")],
    cwd,
    HistoryOptions { reverse: true, paths: false },
  )?
  .into_iter()
  .map(|item| item.commit)
  .collect();
  carried.absorb(read_raw(&inventory, "commit", cwd)?);
  let mut parents: Vec<String> = Vec::new();
  for oid in &inventory {
    let bytes = &carried.objects[oid].1;
    for parent in parse_raw_commit(bytes).parents {
      if !carried.objects.contains_key(&parent) && !parents.contains(&parent) {
        parents.push(parent);
      }
    }
  }
  carried.absorb(read_raw(&parents, "commit", cwd)?);

  // 2. Reachability for every positive claim, and for the bases.
  let mut paths = Vec::new();
  let mut add_path = |carried: &mut Carried, claim: &str, subject: &str, to: Option<&str>| -> GitResult<()> {
    let Some(to) = to.filter(|to| !to.is_empty()) else {
      return Ok(());
    };
    let Some(chain) = commit_path(&target_head, to, cwd)? else {
      return Ok(());
    };
    carried.absorb(read_raw(&chain, "commit", cwd)?);
    paths.push(path_value(claim, subject, &target_head, to, &chain));
    Ok(())
  };
  // `new Map(receipts.map((receipt) => [receipt.id, receipt]))`.
  let mut receipts_by_id: Vec<(Value, &Value)> = Vec::new();
  for receipt in array_items(get(Some(evidence), "receipts")) {
    let id = or_null(get(Some(receipt), "id"));
    match receipts_by_id.iter_mut().find(|(key, _)| same_value_zero(Some(key), Some(&id))) {
      Some(entry) => entry.1 = receipt,
      None => receipts_by_id.push((id, receipt)),
    }
  }
  for change in array_items(get(Some(plan), "changes")) {
    let text_of = |name: &str| js_text(get(Some(change), name));
    if text_of("status") != "covered" {
      continue;
    }
    let (proof, commit, change_id) = (text_of("proof"), text_of("commit"), text_of("changeId"));
    if proof == "commit-ancestry" {
      add_path(&mut carried, &proof, &commit, Some(&commit))?;
      continue;
    }
    if proof == "stable-change-id" {
      let target = target_commit_carrying(&change_id, &target_head, cwd)?;
      add_path(&mut carried, &proof, &commit, target.as_deref())?;
      continue;
    }
    // A receipt proof terminates at the receipt's attachment commit.
    for (_, receipt) in &receipts_by_id {
      let (list, wanted) = if proof == "receipt-commit" {
        ("absorbedCommits", &commit)
      } else {
        ("absorbedChanges", &change_id)
      };
      if array_items(get(Some(receipt), list)).iter().any(|item| as_text(Some(item)).as_deref() == Some(wanted)) {
        let attached = as_text(get(Some(receipt), "attachedTo"));
        add_path(&mut carried, &proof, &commit, attached.as_deref())?;
      }
    }
  }
  add_path(&mut carried, "physical-base-ancestry", &physical_base, Some(&physical_base))?;
  let effective = js_text(get(get(Some(plan), "effectiveBase"), "commit"));
  if !effective.is_empty() && effective != physical_base {
    if let Some(chain) = commit_path(&source_head, &effective, cwd)? {
      carried.absorb(read_raw(&chain, "commit", cwd)?);
      paths.push(path_value("effective-base", &effective, &source_head, &effective, &chain));
    }
  }

  // 3. Receipt inclusion, anchored to the notes tip only.
  let notes_tip = engine::ref_target(names(cwd)?.notes_ref, cwd)?;
  let mut inclusions = Vec::new();
  if let Some(tip) = &notes_tip {
    carried.absorb(read_raw(std::slice::from_ref(tip), "commit", cwd)?);
    for receipt in array_items(get(Some(evidence), "receipts")) {
      let Some(attachment) = as_text(get(Some(receipt), "attachedTo")).filter(|value| !value.is_empty()) else {
        continue;
      };
      let Some((trees, blob)) = note_path(tip, &attachment, cwd)? else {
        continue;
      };
      carried.absorb(read_raw(&trees, "tree", cwd)?);
      carried.absorb(read_raw(std::slice::from_ref(&blob), "blob", cwd)?);
      inclusions.push(object_of(vec![
        ("id", or_null(get(Some(receipt), "id"))),
        ("attachment", string(&attachment)),
        ("path", strings(&trees)),
        ("blob", string(&blob)),
      ]));
    }
  }

  let mut order = carried.order.clone();
  order.sort_by(|left, right| causet_model::js::locale_compare(left, right));
  let mut objects = Object::new();
  for oid in &order {
    let (kind, bytes) = &carried.objects[oid];
    objects.set(
      oid,
      object_of(vec![("type", string(kind)), ("base64", string(&base64_encode(bytes)))]),
    );
  }
  let tip_value = notes_tip.as_deref().map_or(Value::Null, string);
  Ok(vec![
    ("objects", Value::Object(objects)),
    ("sourceInventory", object_of(vec![("commits", strings(&inventory))])),
    ("reachability", object_of(vec![("paths", Value::Array(paths))])),
    (
      "receiptInclusion",
      object_of(vec![("notesTip", tip_value.clone()), ("receipts", Value::Array(inclusions))]),
    ),
    (
      "anchors",
      object_of(vec![
        ("targetHead", string(&target_head)),
        ("sourceHead", string(&source_head)),
        ("notesTip", tip_value),
        (
          "lineageRoots",
          Value::Array(array_items(get(Some(lineage), "rootCommits")).to_vec()),
        ),
      ]),
    ),
  ])
}

/// `bundleHash(bundle)`: everything except `integrity` and `signatures`.
fn bundle_hash(bundle: &Object) -> GitResult<String> {
  let mut payload = bundle.clone();
  payload.remove("integrity");
  payload.remove("signatures");
  canonical_json(&Value::Object(payload))
    .map(|bytes| sha256(&bytes))
    .map_err(|error| {
      GitError::new(
        "malformed-input",
        "The proof bundle cannot be hashed under the canonical JSON profile.",
      )
      .details(error.to_string())
    })
}

/// `assertWithinProofBound(bundle)`.
fn assert_within_proof_bound(bundle: &Object) -> GitResult<()> {
  let value = Value::Object(bundle.clone());
  let bytes = stringify_pretty(&value).len() + 1;
  if within_bound("proofBundleBytes", bytes as u64) {
    return Ok(());
  }
  let mut sizes: Vec<(&str, usize)> = ["objects", "evidence", "reachability", "receiptInclusion", "sourceInventory"]
    .into_iter()
    .map(|member| (member, stringify(&or_null(bundle.get(member))).len()))
    .collect();
  sizes.sort_by(|left, right| right.1.cmp(&left.1));
  let (member, size) = sizes[0];
  let limit = causet_model::registry::RESOURCE_BOUNDS
    .iter()
    .find(|(bound, _)| *bound == "proofBundleBytes")
    .map_or(0, |(_, limit)| *limit);
  Err(
    GitError::new(
      "resource-bound-exceeded",
      format!("The proof bundle is {bytes} bytes, over the proofBundleBytes bound of {limit}."),
    )
    .details(format!(
      "The largest member is '{member}' at {size} bytes. A truncated proof cannot be told apart from an omission, so nothing was emitted."
    )),
  )
}

/// `buildProofBundle(sourceRef, cwd)`.
pub fn build_proof_bundle(source_ref: &str, cwd: &str) -> GitResult<Value> {
  let plan = merge_plan(source_ref, cwd)?;
  let evidence = coverage_evidence(source_ref, cwd)?;
  let lineage = repository_lineage(cwd)?;
  let field = |name: &str| get(Some(&plan), name).cloned().unwrap_or(Value::Null);
  let changes: Vec<Value> = array_items(get(Some(&plan), "changes"))
    .iter()
    .map(|change| {
      let mut object = Object::new();
      for name in ["commit", "changeId", "subject", "status", "proof"] {
        object.set(name, or_null(get(Some(change), name)));
      }
      Value::Object(object)
    })
    .collect();
  let mut bundle = Object::new();
  bundle.set("schema", string(PROOF_BUNDLE_SCHEMA));
  bundle.set("repository", object_of(vec![("lineage", lineage.clone())]));
  bundle.set("target", object_of(vec![("head", field("targetHead"))]));
  bundle.set(
    "source",
    object_of(vec![("ref", field("sourceRef")), ("head", field("sourceHead"))]),
  );
  bundle.set("physicalBase", field("physicalBase"));
  bundle.set("effectiveBase", field("effectiveBase"));
  bundle.set("evidence", evidence.clone());
  bundle.set("changes", Value::Array(changes));
  bundle.set("counts", field("counts"));
  for (name, value) in build_bindings(&plan, &evidence, &lineage, cwd)? {
    bundle.set(name, value);
  }
  let hash = bundle_hash(&bundle)?;
  bundle.set(
    "integrity",
    object_of(vec![("algorithm", string("sha256")), ("bundleHash", string(&hash))]),
  );
  assert_within_proof_bound(&bundle)?;
  Ok(Value::Object(bundle))
}

// ---------------------------------------------------------------------------
// Document shape (`assertProofBundleDocument`)
// ---------------------------------------------------------------------------

fn is_plain_object(value: Option<&Value>) -> bool {
  matches!(value, Some(Value::Object(_)))
}

fn schema_text(bundle: &Value) -> Option<String> {
  as_text(get(Some(bundle), "schema"))
}

/// `canonicalSchema(bundle.schema)` as one of the readable versions.
fn readable_schema(bundle: &Value) -> Option<&'static str> {
  let schema = canonical_schema(&schema_text(bundle)?);
  READABLE_BUNDLE_SCHEMAS.into_iter().find(|readable| *readable == schema)
}

fn is_v2(bundle: &Value) -> bool {
  readable_schema(bundle) == Some(PROOF_BUNDLE_SCHEMA)
}

/// `assertProofBundleDocument(bundle)`.
pub fn assert_proof_bundle_document(bundle: &Value) -> GitResult<()> {
  if !is_plain_object(Some(bundle)) {
    return Err(GitError::new("malformed-input", "The proof bundle is not a JSON object."));
  }
  let schema = get(Some(bundle), "schema");
  if readable_schema(bundle).is_none() {
    let classified = schema_classification(schema_text(bundle).as_deref());
    let own = schema_classification(Some(PROOF_BUNDLE_SCHEMA));
    if classified.family.is_some() && classified.family == own.family && classified.version.is_some() {
      return Err(
        GitError::new(
          "unknown-schema-version",
          format!(
            "The proof bundle carries unsupported schema {}.",
            stringify(schema.unwrap_or(&Value::Null))
          ),
        )
        .details(format!("This build reads {}.", READABLE_BUNDLE_SCHEMAS.join(", "))),
      );
    }
    return Err(GitError::new(
      "wrong-record-family",
      format!(
        "Not a causet.proof-bundle document (found {}).",
        stringify(&or_null(schema))
      ),
    ));
  }
  let mut problems: Vec<String> = Vec::new();
  let expect_object = |problems: &mut Vec<String>, value: Option<&Value>, name: &str, required: bool| {
    match value {
      None if required => problems.push(format!("{name} is required")),
      None => {}
      Some(Value::Object(_)) => {}
      Some(_) => problems.push(format!("{name} must be an object")),
    }
  };
  let expect_array = |problems: &mut Vec<String>, value: Option<&Value>, name: &str, required: bool| {
    match value {
      None if required => problems.push(format!("{name} is required")),
      None => {}
      Some(Value::Array(_)) => {}
      Some(_) => problems.push(format!("{name} must be an array")),
    }
  };
  let expect_string = |problems: &mut Vec<String>, value: Option<&Value>, name: &str| {
    if !matches!(value, Some(Value::String(units)) if !units.is_empty()) {
      problems.push(format!("{name} must be a non-empty string"));
    }
  };
  for name in ["repository", "target", "source", "effectiveBase", "evidence", "counts", "integrity"] {
    expect_object(&mut problems, get(Some(bundle), name), name, true);
  }
  expect_string(&mut problems, get(Some(bundle), "physicalBase"), "physicalBase");
  let changes = get(Some(bundle), "changes");
  expect_array(&mut problems, changes, "changes", true);
  if let Some(Value::Array(changes)) = changes {
    for (index, change) in changes.iter().enumerate() {
      let label = format!("changes[{index}]");
      expect_object(&mut problems, Some(change), &label, true);
      if let Value::Object(_) = change {
        expect_string(&mut problems, get(Some(change), "commit"), &format!("{label}.commit"));
        expect_string(&mut problems, get(Some(change), "changeId"), &format!("{label}.changeId"));
        if !matches!(get(Some(change), "subject"), Some(Value::String(_))) {
          problems.push(format!("{label}.subject must be a string"));
        }
        if !matches!(
          as_text(get(Some(change), "status")).as_deref(),
          Some("covered" | "candidate-equivalent" | "new")
        ) {
          problems.push(format!("{label}.status must be covered, candidate-equivalent, or new"));
        }
        match get(Some(change), "proof") {
          Some(Value::Null) => {}
          Some(Value::String(units)) if !units.is_empty() => {}
          _ => problems.push(format!("{label}.proof must be a non-empty string or null")),
        }
      }
    }
  }
  let evidence = get(Some(bundle), "evidence");
  if is_plain_object(evidence) {
    for name in ["receipts", "targetCommits", "targetChangeIds", "patchEquivalentCommits"] {
      expect_array(&mut problems, get(evidence, name), &format!("evidence.{name}"), true);
    }
    if let Some(Value::Array(receipts)) = get(evidence, "receipts") {
      for (index, receipt) in receipts.iter().enumerate() {
        let label = format!("evidence.receipts[{index}]");
        expect_object(&mut problems, Some(receipt), &label, true);
        if let Value::Object(_) = receipt {
          for name in ["absorbedCommits", "absorbedChanges"] {
            expect_array(&mut problems, get(Some(receipt), name), &format!("{label}.{name}"), false);
          }
        }
      }
    }
  }
  if is_v2(bundle) {
    for name in ["objects", "sourceInventory", "reachability", "receiptInclusion", "anchors"] {
      expect_object(&mut problems, get(Some(bundle), name), name, true);
    }
    if let Some(Value::Object(objects)) = get(Some(bundle), "objects") {
      for key in objects.keys() {
        let oid = lossy(key);
        let object = objects.get_units(key);
        if !is_plain_object(object) {
          problems.push(format!("objects.{oid} must be an object"));
          continue;
        }
        expect_string(&mut problems, get(object, "base64"), &format!("objects.{oid}.base64"));
        if !matches!(as_text(get(object, "type")).as_deref(), Some("commit" | "tree" | "blob")) {
          problems.push(format!("objects.{oid}.type must be commit, tree, or blob"));
        }
      }
    }
    let inventory = get(Some(bundle), "sourceInventory");
    if is_plain_object(inventory) {
      expect_array(&mut problems, get(inventory, "commits"), "sourceInventory.commits", true);
    }
    let reachability = get(Some(bundle), "reachability");
    if is_plain_object(reachability) {
      let paths = get(reachability, "paths");
      expect_array(&mut problems, paths, "reachability.paths", true);
      if let Some(Value::Array(paths)) = paths {
        for (index, entry) in paths.iter().enumerate() {
          let label = format!("reachability.paths[{index}]");
          expect_object(&mut problems, Some(entry), &label, true);
          if let Value::Object(_) = entry {
            expect_array(&mut problems, get(Some(entry), "commits"), &format!("{label}.commits"), true);
          }
        }
      }
    }
    let inclusion = get(Some(bundle), "receiptInclusion");
    if is_plain_object(inclusion) {
      expect_array(&mut problems, get(inclusion, "receipts"), "receiptInclusion.receipts", true);
    }
  }
  if !problems.is_empty() {
    return Err(
      GitError::new("malformed-input", "The proof bundle is not structurally valid.")
        .details(problems.join("\n")),
    );
  }
  Ok(())
}

// ---------------------------------------------------------------------------
// The binding check (`verifyBindings`)
// ---------------------------------------------------------------------------

struct CarriedObject {
  kind: String,
  bytes: Vec<u8>,
}

struct Binding<'a> {
  bundle: &'a Value,
  carried: Vec<(JsString, CarriedObject)>,
  problems: Vec<Value>,
}

impl<'a> Binding<'a> {
  /// `carried.get(value)`: only a string can name a carried object.
  fn object(&self, value: Option<&Value>) -> Option<&CarriedObject> {
    let Some(Value::String(units)) = value else {
      return None;
    };
    self
      .carried
      .iter()
      .find(|(key, _)| key == units)
      .map(|(_, object)| object)
  }

  fn commit_at(&self, value: Option<&Value>) -> Option<RawCommit> {
    self
      .object(value)
      .filter(|object| object.kind == "commit")
      .map(|object| parse_raw_commit(&object.bytes))
  }

  fn problem(&mut self, message: Message) {
    self.problems.push(message.value());
  }

  fn at(&self, path: &[&str]) -> Option<&'a Value> {
    let bundle: &'a Value = self.bundle;
    path.iter().fold(Some(bundle), |value, name| get(value, name))
  }
}

/// `sameSet(left, right)`, failing as the spread of a non-iterable does.
fn same_set(left: Option<&Value>, right: Option<&Value>) -> GitResult<bool> {
  let spread = |value: Option<&Value>, name: &str| -> GitResult<Vec<Value>> {
    match value {
      None | Some(Value::Null) => Ok(Vec::new()),
      Some(Value::Array(items)) => Ok(items.clone()),
      Some(Value::String(units)) => Ok(code_points(units).into_iter().map(Value::String).collect()),
      Some(_) => Err(GitError::uncoded(format!("({name} ?? []) is not iterable"))),
    }
  };
  let mut first = spread(left, "left")?;
  let mut second = spread(right, "right")?;
  default_sort(&mut first);
  default_sort(&mut second);
  Ok(
    first.len() == second.len()
      && first
        .iter()
        .zip(&second)
        .all(|(left, right)| strict_equals(Some(left), Some(right))),
  )
}

/// A string's code points, as its iterator yields them (a lone surrogate is
/// one item).
fn code_points(units: &[u16]) -> Vec<JsString> {
  let mut points = Vec::new();
  let mut index = 0;
  while index < units.len() {
    let unit = units[index];
    let pair = (0xd800..0xdc00).contains(&unit)
      && units.get(index + 1).is_some_and(|next| (0xdc00..0xe000).contains(next));
    let width = if pair { 2 } else { 1 };
    points.push(units[index..index + width].to_vec());
    index += width;
  }
  points
}

/// `verifyInventory(bundle, commitAt, problems)`.
fn verify_inventory(binding: &mut Binding) -> Value {
  let bundle = binding.bundle;
  let claimed = array_items(binding.at(&["sourceInventory", "commits"])).to_vec();
  let changes: Vec<Value> = array_items(get(Some(bundle), "changes"))
    .iter()
    .map(|change| or_null(get(Some(change), "commit")))
    .collect();
  let same_list = claimed.len() == changes.len()
    && claimed
      .iter()
      .zip(&changes)
      .all(|(left, right)| strict_equals(Some(left), Some(right)));
  if !same_list {
    binding.problem(Message::new("sourceInventory.commits does not enumerate the change list in its order"));
  }

  // Walk parents from the source head, and require the walk to reach the
  // physical base. The head is its own node, so it equals itself only.
  let head = binding.at(&["source", "head"]).cloned();
  let physical_base = get(Some(bundle), "physicalBase").cloned();
  let mut visited: Vec<(Value, bool)> = Vec::new();
  let mut queue: std::collections::VecDeque<(Value, bool)> = std::collections::VecDeque::new();
  if truthy(head.as_ref()) {
    queue.push_back((head.clone().expect("truthy"), true));
  }
  let mut reaches_base = false;
  while let Some((oid, is_head)) = queue.pop_front() {
    if visited
      .iter()
      .any(|(seen, seen_head)| (is_head && *seen_head) || same_value_zero(Some(seen), Some(&oid)))
    {
      continue;
    }
    visited.push((oid.clone(), is_head));
    if strict_equals(Some(&oid), physical_base.as_ref()) {
      reaches_base = true;
      continue;
    }
    let Some(commit) = binding.commit_at(Some(&oid)) else {
      binding.problem(
        Message::new("the inventory walk needs commit ").v(Some(&oid)).s(", which is not carried"),
      );
      continue;
    };
    for parent in commit.parents {
      queue.push_back((string(&parent), false));
    }
  }
  if !reaches_base {
    binding.problem(
      Message::new("the inventory walk from ")
        .v(head.as_ref())
        .s(" never reaches the physical base ")
        .v(physical_base.as_ref()),
    );
  }
  let walked: Vec<(Value, bool)> = visited
    .into_iter()
    .filter(|(oid, _)| !strict_equals(Some(oid), physical_base.as_ref()))
    .collect();
  for oid in &claimed {
    if !walked.iter().any(|(seen, _)| same_value_zero(Some(seen), Some(oid))) {
      binding.problem(
        Message::new("inventory commit ").v(Some(oid)).s(" is not reachable from the source head"),
      );
    }
  }
  for (oid, is_head) in &walked {
    let inside = claimed.iter().any(|item| same_value_zero(Some(item), Some(oid)));
    let equals_head = *is_head || strict_equals(Some(oid), head.as_ref());
    if !inside && equals_head {
      binding.problem(Message::new("commit ").v(Some(oid)).s(" is in the range but not in the inventory"));
    }
  }

  let mut identities_agree = true;
  for change in array_items(get(Some(bundle), "changes")) {
    let commit_value = get(Some(change), "commit");
    let Some(commit) = binding.commit_at(commit_value) else {
      binding.problem(Message::new("change ").v(commit_value).s(" carries no commit object"));
      identities_agree = false;
      continue;
    };
    let expected: JsString = match &commit.change_id {
      Some(id) => js(id),
      None => Message::new("git:").v(commit_value).0,
    };
    let claimed_id = get(Some(change), "changeId");
    if !matches!(claimed_id, Some(Value::String(units)) if *units == expected) {
      binding.problem(
        Message::new("change ")
          .v(commit_value)
          .s(" claims Change-Id '")
          .v(claimed_id)
          .s("' but its commit carries '")
          .units(&expected)
          .s("'"),
      );
      identities_agree = false;
    }
    let claimed_subject = get(Some(change), "subject");
    if !matches!(claimed_subject, Some(Value::String(units)) if *units == js(&commit.subject)) {
      binding.problem(
        Message::new("change ")
          .v(commit_value)
          .s(" claims subject '")
          .v(claimed_subject)
          .s("' but its commit carries '")
          .s(&commit.subject)
          .s("'"),
      );
      identities_agree = false;
    }
  }

  object_of(vec![
    ("commits", number(claimed.len())),
    ("enumeratesChanges", Value::Bool(same_list)),
    ("reachesPhysicalBase", Value::Bool(reaches_base)),
    ("identitiesAgree", Value::Bool(identities_agree)),
    ("complete", Value::Bool(same_list && reaches_base && identities_agree)),
  ])
}

/// `pathHolds(entry, bundle, carried, commitAt, change, problems)`.
fn path_holds(binding: &mut Binding, entry: &Value, change: &Value) -> GitResult<bool> {
  let bundle = binding.bundle;
  let commit_value = get(Some(change), "commit");
  let from = get(Some(entry), "from");
  let to = get(Some(entry), "to");
  if !strict_equals(from, binding.at(&["target", "head"])) {
    binding.problem(
      Message::new("a reachability path for ")
        .v(commit_value)
        .s(" starts at ")
        .v(from)
        .s(", not the target head"),
    );
    return Ok(false);
  }
  let chain = array_items(get(Some(entry), "commits"));
  if chain.is_empty()
    || !strict_equals(chain.first(), from)
    || !strict_equals(chain.last(), to)
  {
    binding.problem(
      Message::new("a reachability path for ")
        .v(commit_value)
        .s(" does not run from ")
        .v(from)
        .s(" to ")
        .v(to),
    );
    return Ok(false);
  }
  for index in 0..chain.len() - 1 {
    let Some(commit) = binding.commit_at(Some(&chain[index])) else {
      binding.problem(
        Message::new("reachability path commit ").v(Some(&chain[index])).s(" is not carried"),
      );
      return Ok(false);
    };
    let next = &chain[index + 1];
    if !commit.parents.iter().any(|parent| same_value_zero(Some(&string(parent)), Some(next))) {
      binding.problem(
        Message::new("")
          .v(Some(next))
          .s(" is not a parent of ")
          .v(Some(&chain[index]))
          .s(", so the path is not a real chain"),
      );
      return Ok(false);
    }
  }
  let Some(end) = binding.commit_at(to) else {
    binding.problem(Message::new("reachability path end ").v(to).s(" is not carried"));
    return Ok(false);
  };
  let proof = get(Some(change), "proof");
  let proof_is = |name: &str| matches!(proof, Some(Value::String(units)) if *units == js(name));
  if proof_is("commit-ancestry") {
    return Ok(strict_equals(to, commit_value));
  }
  if proof_is("stable-change-id") {
    let carried_id: JsString = match &end.change_id {
      Some(id) => js(id),
      None => Message::new("git:").v(to).0,
    };
    let claimed_id = get(Some(change), "changeId");
    if !matches!(claimed_id, Some(Value::String(units)) if *units == carried_id) {
      binding.problem(
        Message::new("the target commit ")
          .v(to)
          .s(" does not carry Change-Id '")
          .v(claimed_id)
          .s("'"),
      );
      return Ok(false);
    }
    return Ok(true);
  }
  let receipts = array_items(get(get(Some(bundle), "receiptInclusion"), "receipts"));
  let mut included = false;
  for receipt in receipts {
    if strict_equals(member(Some(receipt), "attachment")?, to) {
      included = true;
      break;
    }
  }
  if !included {
    binding.problem(
      Message::new("the receipt attachment ").v(to).s(" carries no inclusion proof"),
    );
    return Ok(false);
  }
  Ok(true)
}

/// `verifyCoverage(bundle, carried, commitAt, problems)`.
fn verify_coverage(binding: &mut Binding) -> GitResult<Value> {
  let bundle = binding.bundle;
  let paths = array_items(binding.at(&["reachability", "paths"])).to_vec();
  let mut results = Vec::new();
  let result = |change: &Value, proven: bool, reason: Option<&str>| {
    object_of(vec![
      ("commit", or_null(get(Some(change), "commit"))),
      ("proof", or_null(get(Some(change), "proof"))),
      ("proven", Value::Bool(proven)),
      ("reason", reason.map_or(Value::Null, string)),
    ])
  };
  for change in array_items(get(Some(bundle), "changes")) {
    let commit = get(Some(change), "commit");
    if as_text(get(Some(change), "status")).as_deref() != Some("covered") {
      results.push(result(change, false, Some("not-a-positive-claim")));
      continue;
    }
    let candidates: Vec<&Value> = paths
      .iter()
      .filter(|entry| strict_equals(get(Some(entry), "subject"), commit))
      .collect();
    if candidates.is_empty() {
      binding.problem(
        Message::new("covered change ").v(commit).s(" carries no reachability path from the target head"),
      );
      results.push(result(change, false, Some("no-carried-path")));
      continue;
    }
    let mut valid = false;
    for entry in candidates {
      if path_holds(binding, entry, change)? {
        valid = true;
        break;
      }
    }
    if !valid {
      results.push(result(change, false, Some("path-does-not-hold")));
      continue;
    }
    results.push(result(change, true, None));
  }
  Ok(Value::Array(results))
}

/// `verifyReceipts(bundle, carried, objectFormat, problems)`.
fn verify_receipts(binding: &mut Binding, object_format: &str) -> GitResult<Value> {
  let bundle = binding.bundle;
  let notes_tip = or_null(binding.at(&["receiptInclusion", "notesTip"]));
  let mut results = Vec::new();
  for entry in array_items(binding.at(&["receiptInclusion", "receipts"])) {
    let id = member(Some(entry), "id")?;
    let attachment = member(Some(entry), "attachment")?;
    let report = |included: bool, validates: bool, absorbs: bool| {
      let mut object = Object::new();
      set_defined(&mut object, "id", id);
      set_defined(&mut object, "attachment", attachment);
      object.set("included", Value::Bool(included));
      object.set("validates", Value::Bool(validates));
      object.set("absorbs", Value::Bool(absorbs));
      Value::Object(object)
    };
    let Some(tip) = binding.object(Some(&notes_tip)).filter(|object| object.kind == "commit") else {
      binding.problem(
        Message::new("the notes tip ").v(Some(&notes_tip)).s(" is not carried, so no receipt is included"),
      );
      results.push(report(false, false, false));
      continue;
    };
    let root = parse_raw_commit(&tip.bytes).tree.map_or(Value::Null, |tree| string(&tree));
    let path = get(Some(entry), "path");
    let first = if matches!(path, None | Some(Value::Null)) {
      None
    } else {
      element(path, 0)
    };
    if !strict_equals(first.as_ref(), Some(&root)) {
      binding.problem(
        Message::new("the inclusion proof for ")
          .v(id)
          .s(" does not start at the notes tip tree"),
      );
      results.push(report(false, false, false));
      continue;
    }
    let mut ok = true;
    let mut index = 0usize;
    while length(path).is_some_and(|count| (index as f64) < to_number(&count)) {
      let step = element(path, index);
      let tree = binding.object(step.as_ref()).filter(|object| object.kind == "tree");
      let Some(tree) = tree else {
        binding.problem(
          Message::new("inclusion tree ").v(step.as_ref()).s(" for ").v(id).s(" is not carried"),
        );
        ok = false;
        break;
      };
      let next = match element(path, index + 1) {
        None | Some(Value::Null) => get(Some(entry), "blob").cloned(),
        other => other,
      };
      let contains = parse_raw_tree(&tree.bytes, object_format)
        .iter()
        .any(|(_, oid)| matches!(&next, Some(Value::String(units)) if *units == js(oid)));
      if !contains {
        binding.problem(
          Message::new("inclusion tree ")
            .v(step.as_ref())
            .s(" for ")
            .v(id)
            .s(" does not contain ")
            .v(next.as_ref()),
        );
        ok = false;
        break;
      }
      index += 1;
    }
    if !ok {
      results.push(report(false, false, false));
      continue;
    }
    let blob_value = get(Some(entry), "blob");
    let Some(blob) = binding.object(blob_value).filter(|object| object.kind == "blob") else {
      binding.problem(
        Message::new("the note blob ").v(blob_value).s(" for ").v(id).s(" is not carried"),
      );
      results.push(report(false, false, false));
      continue;
    };
    let Ok(container) = parse(&String::from_utf8_lossy(&blob.bytes)) else {
      binding.problem(Message::new("the note blob for ").v(id).s(" is not valid JSON"));
      results.push(report(true, false, false));
      continue;
    };
    let records: &[Value] = match get(Some(&container), "records") {
      None | Some(Value::Null) => &[],
      Some(Value::Array(items)) => items,
      Some(_) => {
        return Err(GitError::uncoded(
          "((intermediate value) ?? []).find is not a function",
        ));
      }
    };
    let record = records
      .iter()
      .find(|item| strict_equals(get(Some(item), "id"), id));
    let Some(record) = record.filter(|record| truthy(Some(record))) else {
      binding.problem(Message::new("the note blob for ").v(id).s(" does not hold that record"));
      results.push(report(true, false, false));
      continue;
    };
    let mut spread = spread_object(record);
    match attachment {
      Some(value) => spread.set("attachedTo", value.clone()),
      None => spread.remove("attachedTo"),
    }
    let errors = validate_note_record(Some(&Value::Object(spread)), object_format);
    if !errors.is_empty() {
      let fields: Vec<&str> = errors.iter().map(|error| error.field.as_str()).collect();
      binding.problem(
        Message::new("receipt ").v(id).s(" does not validate: ").s(&fields.join(", ")),
      );
      results.push(report(true, false, false));
      continue;
    }
    let claimed = array_items(get(get(Some(bundle), "evidence"), "receipts"))
      .iter()
      .find(|item| strict_equals(get(Some(item), "id"), id));
    let same_commits = same_set(
      claimed.and_then(|item| get(Some(item), "absorbedCommits")),
      get(Some(record), "absorbedCommits"),
    )?;
    let same_changes = same_set(
      claimed.and_then(|item| get(Some(item), "absorbedChanges")),
      get(Some(record), "absorbedChanges"),
    )?;
    if !same_commits || !same_changes {
      binding.problem(
        Message::new("receipt ")
          .v(id)
          .s(" in the evidence does not match the record the notes tip holds"),
      );
      results.push(report(true, true, false));
      continue;
    }
    results.push(report(true, true, true));
  }
  Ok(Value::Array(results))
}

/// `{ ...value }` for a JSON value.
fn spread_object(value: &Value) -> Object {
  match value {
    Value::Object(object) => object.clone(),
    Value::Array(items) => {
      let mut object = Object::new();
      for (index, item) in items.iter().enumerate() {
        object.set(&index.to_string(), item.clone());
      }
      object
    }
    Value::String(units) => {
      let mut object = Object::new();
      for (index, unit) in units.iter().enumerate() {
        object.set(&index.to_string(), Value::String(vec![*unit]));
      }
      object
    }
    _ => Object::new(),
  }
}

/// `verifyStatedAnchors(bundle, problems)`.
fn verify_stated_anchors(binding: &mut Binding) -> GitResult<bool> {
  let anchors = binding.at(&["anchors"]).cloned();
  let mut agrees = true;
  let checks = [
    ("targetHead", binding.at(&["target", "head"]).cloned()),
    ("sourceHead", binding.at(&["source", "head"]).cloned()),
    ("notesTip", Some(or_null(binding.at(&["receiptInclusion", "notesTip"])))),
  ];
  for (name, own) in checks {
    let stated = get(anchors.as_ref(), name);
    if !strict_equals(stated, own.as_ref()) {
      binding.problem(
        Message::new("anchors.")
          .s(name)
          .s(" states ")
          .v(stated)
          .s(" but the bundle's own member is ")
          .v(own.as_ref()),
      );
      agrees = false;
    }
  }
  let roots = binding.at(&["repository", "lineage", "rootCommits"]).cloned();
  if !same_set(get(anchors.as_ref(), "lineageRoots"), roots.as_ref())? {
    binding.problem(Message::new("anchors.lineageRoots does not match the stated lineage"));
    agrees = false;
  }
  Ok(agrees)
}

/// `verifyBindings(bundle)`.
fn verify_bindings(bundle: &Value) -> GitResult<Value> {
  let object_format = if as_text(get(get(get(Some(bundle), "repository"), "lineage"), "objectFormat")).as_deref()
    == Some("sha256")
  {
    "sha256"
  } else {
    "sha1"
  };
  let mut binding = Binding { bundle, carried: Vec::new(), problems: Vec::new() };
  let declared = match get(Some(bundle), "objects") {
    Some(Value::Object(objects)) => objects.len(),
    _ => 0,
  };
  if let Some(Value::Object(objects)) = get(Some(bundle), "objects") {
    for key in objects.keys() {
      let object = objects.get_units(key);
      let (Some(Value::String(base64)), Some(Value::String(kind))) =
        (get(object, "base64"), get(object, "type"))
      else {
        binding.problem(Message::new("objects.").units(key).s(" is not a carried object"));
        continue;
      };
      let bytes = base64_decode(base64);
      let kind = lossy(kind);
      let recomputed = git_object_id(&kind, &bytes, object_format);
      if js(&recomputed) != *key {
        binding.problem(
          Message::new("objects.")
            .units(key)
            .s(" hashes to ")
            .s(&recomputed)
            .s(", so its bytes are not the object it claims to be"),
        );
        continue;
      }
      binding.carried.push((key.clone(), CarriedObject { kind, bytes }));
    }
  }
  let inventory = verify_inventory(&mut binding);
  let coverage = verify_coverage(&mut binding)?;
  let receipts = verify_receipts(&mut binding, object_format)?;
  let anchors_agree = verify_stated_anchors(&mut binding)?;
  let carried = binding.carried.len();
  let agrees = binding.problems.is_empty();
  Ok(object_of(vec![
    ("checked", Value::Bool(true)),
    ("objectFormat", string(object_format)),
    ("objects", object_of(vec![("carried", number(carried)), ("declared", number(declared))])),
    ("sourceInventory", inventory),
    ("coverage", coverage),
    ("receipts", receipts),
    ("anchorsAgree", Value::Bool(anchors_agree)),
    ("problems", Value::Array(binding.problems)),
    ("agrees", Value::Bool(agrees)),
  ]))
}

// ---------------------------------------------------------------------------
// The lattice, the repository comparison, anchors, and the report
// ---------------------------------------------------------------------------

/// `indexEvidence(evidence)`, reduced to what classification reads: an item
/// of a different type never equals a change's string commit or identity.
struct Indexed {
  target_commits: HashSet<JsString>,
  target_change_ids: HashSet<JsString>,
  receipt_commits: HashSet<JsString>,
  receipt_change_ids: HashSet<JsString>,
  patch_equivalent_commits: HashSet<JsString>,
}

fn string_units(items: &[Value]) -> HashSet<JsString> {
  items
    .iter()
    .filter_map(|item| match item {
      Value::String(units) => Some(units.clone()),
      _ => None,
    })
    .collect()
}

fn index_evidence(evidence: Option<&Value>) -> Indexed {
  let receipts = array_items(get(evidence, "receipts"));
  let flat = |name: &str| -> Vec<Value> {
    receipts
      .iter()
      .flat_map(|receipt| array_items(get(Some(receipt), name)).to_vec())
      .collect()
  };
  Indexed {
    target_commits: string_units(array_items(get(evidence, "targetCommits"))),
    target_change_ids: string_units(array_items(get(evidence, "targetChangeIds"))),
    receipt_commits: string_units(&flat("absorbedCommits")),
    receipt_change_ids: string_units(&flat("absorbedChanges")),
    patch_equivalent_commits: string_units(array_items(get(evidence, "patchEquivalentCommits"))),
  }
}

/// `classifyFromEvidence(change, indexed)`: the status and proof.
fn classify(commit: &[u16], change_id: &[u16], indexed: &Indexed) -> (&'static str, Option<&'static str>) {
  if indexed.target_commits.contains(commit) {
    ("covered", Some("commit-ancestry"))
  } else if indexed.receipt_commits.contains(commit) {
    ("covered", Some("receipt-commit"))
  } else if indexed.target_change_ids.contains(change_id) {
    ("covered", Some("stable-change-id"))
  } else if indexed.receipt_change_ids.contains(change_id) {
    ("covered", Some("receipt-change-id"))
  } else if indexed.patch_equivalent_commits.contains(commit) {
    ("candidate-equivalent", Some("git-patch-id-heuristic"))
  } else {
    ("new", None)
  }
}

fn counts_value(statuses: &[&str]) -> Value {
  let count = |status: &str| number(statuses.iter().filter(|item| **item == status).count());
  object_of(vec![
    ("covered", count("covered")),
    ("candidate-equivalent", count("candidate-equivalent")),
    ("new", count("new")),
  ])
}

/// `lineageClaimHolds(claimed, actual, relation)`.
fn lineage_claim_holds(claimed: &Value, actual: &Value, relation: Option<&str>) -> GitResult<bool> {
  match relation {
    Some("same") => Ok(canonical(claimed)? == canonical(actual)?),
    Some("fork") => {
      if !matches!(get(Some(claimed), "rootCommits"), Some(Value::Array(_)))
        || !strict_equals(get(Some(claimed), "algorithm"), get(Some(actual), "algorithm"))
        || !strict_equals(get(Some(claimed), "objectFormat"), get(Some(actual), "objectFormat"))
      {
        return Ok(false);
      }
      let id = lineage_identity_id(claimed)?;
      Ok(strict_equals(get(Some(claimed), "id"), Some(&string(&id))))
    }
    _ => Ok(false),
  }
}

/// `verifyAgainstRepository(bundle, cwd)`.
pub fn verify_against_repository(bundle: &Value, cwd: &str) -> GitResult<Value> {
  let at = |path: &[&str]| path.iter().fold(Some(bundle), |value, name| get(value, name));
  let claimed_target = or_null(at(&["target", "head"]));
  let claimed_source = or_null(at(&["source", "head"]));
  let source_ref = or_null(at(&["source", "ref"]));
  if !truthy(Some(&claimed_target)) || !truthy(Some(&claimed_source)) || !truthy(Some(&source_ref)) {
    return Ok(object_of(vec![
      ("checked", Value::Bool(false)),
      ("reason", string("bundle-incomplete")),
      ("matches", Value::Null),
    ]));
  }
  let claimed_lineage = or_null(at(&["repository", "lineage"]));
  let actual_lineage = repository_lineage(cwd)?;
  let mut relation = None;
  if truthy(get(Some(&claimed_lineage), "id")) {
    let found = lineage_relation(Some(&claimed_lineage), Some(&actual_lineage))?;
    relation = Some(found);
    if !matches!(found, "same" | "fork") {
      return Ok(object_of(vec![
        ("checked", Value::Bool(false)),
        ("reason", string("different-repository")),
        ("matches", Value::Null),
        ("lineageRelation", string(found)),
        ("claimedLineage", or_null(get(Some(&claimed_lineage), "id"))),
        ("repositoryLineage", or_null(get(Some(&actual_lineage), "id"))),
        ("claimedObjectFormat", or_null(get(Some(&claimed_lineage), "objectFormat"))),
        ("repositoryObjectFormat", or_null(get(Some(&actual_lineage), "objectFormat"))),
      ]));
    }
  }
  let head = engine::current_head(cwd)?;
  if !strict_equals(Some(&string(&head)), Some(&claimed_target)) {
    return Ok(object_of(vec![
      ("checked", Value::Bool(false)),
      ("reason", string("target-moved")),
      ("matches", Value::Null),
      ("claimedTarget", claimed_target),
      ("repositoryTarget", string(&head)),
    ]));
  }
  let source_text = js_text(Some(&source_ref));
  let Ok(resolved) = engine::resolve_object_ids(&[format!("{source_text}^{{commit}}")], cwd) else {
    return Ok(object_of(vec![
      ("checked", Value::Bool(false)),
      ("reason", string("source-ref-missing")),
      ("matches", Value::Null),
      ("sourceRef", source_ref),
    ]));
  };
  let repository_source = resolved.into_iter().next().unwrap_or_default();
  if !strict_equals(Some(&string(&repository_source)), Some(&claimed_source)) {
    return Ok(object_of(vec![
      ("checked", Value::Bool(false)),
      ("reason", string("source-moved")),
      ("matches", Value::Null),
      ("claimedSource", claimed_source),
      ("repositorySource", string(&repository_source)),
    ]));
  }
  let actual = coverage_evidence(&source_text, cwd)?;
  let physical_base = engine::merge_base(&head, &repository_source, cwd)?;
  let source_changes: Vec<Value> = engine::commit_history(
    &[format!("{physical_base}..{repository_source}")],
    cwd,
    HistoryOptions { reverse: true, paths: false },
  )?
  .into_iter()
  .map(|item| {
    let change_id = text::extract_trailer(&item.message, "Change-Id")
      .unwrap_or_else(|| format!("git:{}", item.commit));
    object_of(vec![
      ("commit", string(&item.commit)),
      ("changeId", string(&change_id)),
      ("subject", string(&item.subject)),
    ])
  })
  .collect();
  let target_commits: HashSet<String> = array_items(get(Some(&actual), "targetCommits"))
    .iter()
    .filter_map(|item| as_text(Some(item)))
    .collect();
  let (records, conflicting) = read_causal_record_catalog(cwd)?;
  let candidates: Vec<&Value> = records
    .iter()
    .filter(|record| {
      as_text(get(Some(record), "attachedTo")).is_some_and(|target| target_commits.contains(&target))
        && as_text(get(Some(record), "type")).is_some_and(|kind| RECEIPT_TYPES.contains(&kind.as_str()))
    })
    .collect();
  let receipts = accepted_causal_records(&candidates, cwd, &conflicting)?;
  let mut effective = (physical_base.clone(), "physical-ancestry".to_string());
  for receipt in &receipts {
    let source_head = get(Some(receipt), "sourceHead");
    if !truthy(source_head) {
      continue;
    }
    let source_head = js_text(source_head);
    if engine::is_ancestor(&source_head, &repository_source, cwd)?
      && engine::is_ancestor(&effective.0, &source_head, cwd)?
    {
      effective = (
        source_head,
        format!("causal-receipt:{}", js_text(get(Some(receipt), "id"))),
      );
    }
  }
  let effective_base = object_of(vec![
    ("commit", string(&effective.0)),
    ("reason", string(&effective.1)),
  ]);
  let indexed = index_evidence(Some(&actual));
  let statuses: Vec<&str> = source_changes
    .iter()
    .map(|change| {
      let units = |name: &str| match get(Some(change), name) {
        Some(Value::String(units)) => units.clone(),
        _ => Vec::new(),
      };
      classify(&units("commit"), &units("changeId"), &indexed).0
    })
    .collect();
  let counts = counts_value(&statuses);
  let claimed_changes = Value::Array(
    array_items(get(Some(bundle), "changes"))
      .iter()
      .map(|change| {
        let mut object = Object::new();
        for name in ["commit", "changeId", "subject"] {
          set_defined(&mut object, name, get(Some(change), name));
        }
        Value::Object(object)
      })
      .collect(),
  );
  let evidence = get(Some(bundle), "evidence").cloned().unwrap_or(Value::Null);
  let lineage = lineage_claim_holds(&claimed_lineage, &actual_lineage, relation)?;
  let evidence_matches = canonical(&actual)? == canonical(&evidence)?;
  let changes_match = canonical(&Value::Array(source_changes))? == canonical(&claimed_changes)?;
  let base_matches = strict_equals(get(Some(bundle), "physicalBase"), Some(&string(&physical_base)));
  let effective_matches = canonical(&or_null(get(Some(bundle), "effectiveBase")))? == canonical(&effective_base)?;
  let counts_match = canonical(&or_null(get(Some(bundle), "counts")))? == canonical(&counts)?;
  let checks = [
    ("lineage", lineage),
    ("evidence", evidence_matches),
    ("sourceChanges", changes_match),
    ("physicalBase", base_matches),
    ("effectiveBase", effective_matches),
    ("counts", counts_match),
  ];
  let claimed_hash = sha256(&canonical(&match get(Some(bundle), "evidence") {
    None | Some(Value::Null) => Value::Object(Object::new()),
    Some(value) => value.clone(),
  })?);
  Ok(object_of(vec![
    ("checked", Value::Bool(true)),
    ("reason", Value::Null),
    ("matches", Value::Bool(checks.iter().all(|(_, holds)| *holds))),
    ("lineageRelation", relation.map_or(Value::Null, string)),
    (
      "checks",
      object_of(checks.iter().map(|(name, holds)| (*name, Value::Bool(*holds))).collect()),
    ),
    (
      "evidenceHash",
      object_of(vec![
        ("claimed", string(&claimed_hash)),
        ("repository", string(&sha256(&canonical(&actual)?))),
      ]),
    ),
  ]))
}

/// `anchorsFromLsRemote(bundle, remote, cwd)`.
pub fn anchors_from_ls_remote(bundle: &Value, remote: &str, cwd: &str) -> GitResult<Value> {
  let Some(advertised) = engine::remote_refs(remote, cwd)? else {
    return Ok(object_of(vec![
      ("channel", string("ls-remote")),
      ("remote", string(remote)),
      ("available", Value::Bool(false)),
      ("reason", string("remote-unreadable")),
      ("confirmed", Value::Array(Vec::new())),
      ("unconfirmed", Value::Array(Vec::new())),
      ("anchored", Value::Bool(false)),
      ("details", string("The remote could not be read; no anchor was confirmed or denied.")),
    ]));
  };
  let mut refs_by_oid: Vec<(String, Vec<String>)> = Vec::new();
  for entry in advertised {
    match refs_by_oid.iter_mut().find(|(oid, _)| *oid == entry.oid) {
      Some((_, refs)) => refs.push(entry.name),
      None => refs_by_oid.push((entry.oid, vec![entry.name])),
    }
  }
  let anchors = get(Some(bundle), "anchors");
  let pick = |anchor: &str, fallback: Option<&Value>| match get(anchors, anchor) {
    None | Some(Value::Null) => or_null(fallback),
    Some(value) => value.clone(),
  };
  let wanted: Vec<(&str, Value)> = [
    ("targetHead", pick("targetHead", get(get(Some(bundle), "target"), "head"))),
    ("sourceHead", pick("sourceHead", get(get(Some(bundle), "source"), "head"))),
    ("notesTip", pick("notesTip", None)),
  ]
  .into_iter()
  .filter(|(_, oid)| truthy(Some(oid)))
  .collect();
  let mut confirmed = Vec::new();
  let mut unconfirmed = Vec::new();
  for (name, oid) in &wanted {
    let refs = match oid {
      Value::String(units) => refs_by_oid
        .iter()
        .find(|(advertised, _)| js(advertised) == *units)
        .map(|(_, refs)| refs),
      _ => None,
    };
    match refs {
      Some(refs) => confirmed.push(object_of(vec![
        ("anchor", string(name)),
        ("oid", oid.clone()),
        ("refs", strings(refs)),
      ])),
      None => unconfirmed.push(object_of(vec![
        ("anchor", string(name)),
        ("oid", oid.clone()),
        ("reason", string("not-a-ref-tip-on-the-chosen-remote")),
      ])),
    }
  }
  let roots = match get(anchors, "lineageRoots") {
    None | Some(Value::Null) => Value::Array(Vec::new()),
    Some(value) => value.clone(),
  };
  let mut lineage_roots = Object::new();
  set_defined(&mut lineage_roots, "count", length(Some(&roots)).as_ref());
  lineage_roots.set("supplied", Value::Bool(false));
  lineage_roots.set("reason", string("root-commits-are-not-ref-tips"));
  let anchored = !wanted.is_empty() && unconfirmed.is_empty();
  Ok(object_of(vec![
    ("channel", string("ls-remote")),
    ("remote", string(remote)),
    ("available", Value::Bool(true)),
    ("reason", Value::Null),
    ("confirmed", Value::Array(confirmed)),
    ("unconfirmed", Value::Array(unconfirmed)),
    ("lineageRoots", Value::Object(lineage_roots)),
    ("anchored", Value::Bool(anchored)),
  ]))
}

fn unavailable(conclusion: &str, reason: &str) -> Value {
  object_of(vec![("conclusion", string(conclusion)), ("reason", string(reason))])
}

/// `verifyProofBundle(bundle, repository, anchors)`.
pub fn verify_proof_bundle(bundle: &Value, repository: Option<Value>, anchors: Option<Value>) -> GitResult<Value> {
  assert_proof_bundle_document(bundle)?;
  let binding = if is_v2(bundle) {
    verify_bindings(bundle)?
  } else {
    object_of(vec![
      ("checked", Value::Bool(false)),
      ("reason", string("not-carried")),
      ("problems", Value::Array(Vec::new())),
      ("agrees", Value::Bool(false)),
      ("coverage", Value::Array(Vec::new())),
      ("receipts", Value::Array(Vec::new())),
    ])
  };
  let binding_checked = truthy(get(Some(&binding), "checked"));
  let binding_agrees = truthy(get(Some(&binding), "agrees"));
  let anchored = truthy(get(anchors.as_ref(), "anchored"));
  let tier = if !binding_checked || !binding_agrees {
    "self-consistent"
  } else if anchored {
    "anchored"
  } else {
    "bound"
  };
  // `new Map(coverage.map((entry) => [entry.commit, entry]))`: the last entry
  // for a commit wins.
  let coverage = array_items(get(Some(&binding), "coverage"));
  let proven_for = |commit: Option<&Value>| {
    coverage
      .iter()
      .rev()
      .find(|entry| same_value_zero(get(Some(entry), "commit"), commit))
      .is_some_and(|entry| truthy(get(Some(entry), "proven")))
  };
  let mut missing = vec![
    unavailable(
      "new-work-is-absent",
      "Coverage is a positive claim with a compact proof; newness is an absence claim over the whole target history, which no bounded bundle can carry. Only the repository-backed comparison establishes it.",
    ),
    unavailable(
      "candidate-equivalence",
      "A patch-identity match is a claim about trees, and trees are what the bundle deliberately does not carry, so a candidate stays advisory.",
    ),
    unavailable(
      "physical-base-is-best-common-ancestor",
      "The carried path shows the stated base is an ancestor of both heads, not that no nearer common ancestor exists; that needs the full graph.",
    ),
  ];
  if !anchored {
    missing.push(unavailable(
      "anchors-are-current",
      "The bundle states its anchors and cannot prove them. Obtain them from a channel you trust to raise every bound conclusion to the anchored tier.",
    ));
  }
  if !binding_checked {
    missing.push(unavailable(
      "source-inventory-is-complete",
      "A v1 bundle carries no Git objects, so a verifier without the repository cannot tell an omitted change from a change that never existed.",
    ));
    missing.push(unavailable(
      "coverage-rests-on-reachable-commits",
      "Without carried reachability paths, a coverage claim is only as good as the evidence list the sender chose to state.",
    ));
  }
  let integrity = get(Some(bundle), "integrity");
  let expected = or_null(get(integrity, "bundleHash"));
  let Value::Object(bundle_object) = bundle else {
    unreachable!("checked to be an object");
  };
  let actual = bundle_hash(bundle_object)?;
  let intact = strict_equals(Some(&expected), Some(&string(&actual)));
  let indexed = index_evidence(match get(Some(bundle), "evidence") {
    None | Some(Value::Null) => None,
    other => other,
  });
  let changes = array_items(get(Some(bundle), "changes"));
  let statuses: Vec<String> = changes
    .iter()
    .map(|change| js_text(get(Some(change), "status")))
    .collect();
  let counts = counts_value(&statuses.iter().map(String::as_str).collect::<Vec<_>>());
  let counts_agree = canonical(&or_null(get(Some(bundle), "counts")))? == canonical(&counts)?;
  let mut commits: Vec<&Value> = Vec::new();
  for change in changes {
    if let Some(commit) = get(Some(change), "commit") {
      if !commits.iter().any(|seen| same_value_zero(Some(seen), Some(commit))) {
        commits.push(commit);
      }
    }
  }
  let unique_commits = commits.len() == changes.len();
  let mut disagreements = Vec::new();
  for change in changes {
    let units = |name: &str| match get(Some(change), name) {
      Some(Value::String(units)) => units.clone(),
      _ => Vec::new(),
    };
    let (status, proof) = classify(&units("commit"), &units("changeId"), &indexed);
    let claimed_status = get(Some(change), "status");
    let claimed_proof = get(Some(change), "proof");
    let proof_value = proof.map_or(Value::Null, string);
    if !strict_equals(Some(&string(status)), claimed_status) || !strict_equals(Some(&proof_value), claimed_proof) {
      disagreements.push(object_of(vec![
        ("commit", or_null(get(Some(change), "commit"))),
        ("changeId", or_null(get(Some(change), "changeId"))),
        (
          "claimed",
          object_of(vec![("status", or_null(claimed_status)), ("proof", or_null(claimed_proof))]),
        ),
        (
          "recomputed",
          object_of(vec![("status", string(status)), ("proof", proof_value)]),
        ),
      ]));
    }
  }
  let disagreement_count = disagreements.len();
  let repository_checked = truthy(get(repository.as_ref(), "checked"));
  let repository_failed = matches!(get(repository.as_ref(), "matches"), Some(Value::Bool(false)));
  let report_changes: Vec<Value> = changes
    .iter()
    .map(|change| {
      let proven = proven_for(get(Some(change), "commit"));
      object_of(vec![
        ("commit", or_null(get(Some(change), "commit"))),
        ("status", or_null(get(Some(change), "status"))),
        ("proof", or_null(get(Some(change), "proof"))),
        ("proven", Value::Bool(proven)),
        ("tier", string(if proven { tier } else { "self-consistent" })),
      ])
    })
    .collect();
  let ok = intact
    && disagreement_count == 0
    && counts_agree
    && unique_commits
    && !repository_failed
    && (!binding_checked || binding_agrees);
  let statement = if repository_checked {
    "The classification was recomputed from the bundle's evidence, and the evidence, complete source inventory, identities, subjects, counts, and physical/effective bases were compared with the repository."
  } else {
    "Recomputing the classification from the bundle's own evidence proves the plan follows from what it states, not that the evidence is true. Repository source completeness, commit identities, and bases were not checked."
  };
  Ok(object_of(vec![
    ("schema", string("causet.proof-verification/v1")),
    ("bundleSchema", or_null(get(Some(bundle), "schema"))),
    (
      "integrity",
      object_of(vec![
        ("algorithm", or_null(get(integrity, "algorithm"))),
        ("claimed", expected),
        ("computed", string(&actual)),
        ("intact", Value::Bool(intact)),
      ]),
    ),
    (
      "classification",
      object_of(vec![
        ("changes", number(changes.len())),
        ("reproduced", number(changes.len() - disagreement_count)),
        ("disagreements", Value::Array(disagreements)),
        (
          "counts",
          object_of(vec![
            ("claimed", or_null(get(Some(bundle), "counts"))),
            ("recomputed", counts),
            ("agrees", Value::Bool(counts_agree)),
          ]),
        ),
        ("uniqueCommits", Value::Bool(unique_commits)),
        (
          "agrees",
          Value::Bool(disagreement_count == 0 && counts_agree && unique_commits),
        ),
      ]),
    ),
    (
      "repository",
      repository.unwrap_or_else(|| {
        object_of(vec![
          ("checked", Value::Bool(false)),
          ("reason", string("not-requested")),
          ("matches", Value::Null),
        ])
      }),
    ),
    ("binding", binding),
    (
      "anchors",
      anchors.unwrap_or_else(|| {
        object_of(vec![
          ("channel", string("none")),
          ("confirmed", Value::Array(Vec::new())),
          ("unconfirmed", Value::Array(Vec::new())),
          ("anchored", Value::Bool(false)),
        ])
      }),
    ),
    ("tier", string(tier)),
    ("changes", Value::Array(report_changes)),
    ("unavailable", Value::Array(missing)),
    (
      "trust",
      object_of(vec![
        ("evidenceCheckedAgainstRepository", Value::Bool(repository_checked)),
        ("statement", string(statement)),
      ]),
    ),
    ("ok", Value::Bool(ok)),
  ]))
}

/// `cst verify-proof <file>`: the report and whether the bundle verified.
pub fn verify_proof(file: &str, offline: bool, anchors_from: Option<&str>, cwd: &str) -> GitResult<(Value, bool)> {
  // `path.resolve(file)`, against the process's own working directory.
  let bundle_path = text::resolve_path(file);
  let read = || -> GitResult<Vec<u8>> {
    let not_found = || GitError::new("not-found", format!("Proof bundle not found: {file}"));
    let unreadable = |error: GitError| {
      GitError::new("malformed-input", format!("Proof bundle '{file}' could not be read."))
        .details(error.message)
    };
    let size = match std::fs::metadata(&bundle_path) {
      // Node refuses to read a directory as EISDIR on every platform; Windows
      // would otherwise report it as access denied.
      Ok(metadata) if metadata.is_dir() => {
        assert_within_bound("proofBundleBytes", metadata.len(), &format!("Proof bundle '{file}'"))?;
        return Err(unreadable(GitError::node(
          "EISDIR: illegal operation on a directory, read",
          "EISDIR",
        )));
      }
      Ok(metadata) => metadata.len(),
      Err(error) => {
        return Err(match error.kind() {
          std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory => not_found(),
          _ => unreadable(crate::envelope::io_failure(&error, "stat", &bundle_path)),
        });
      }
    };
    assert_within_bound("proofBundleBytes", size, &format!("Proof bundle '{file}'"))?;
    std::fs::read(&bundle_path).map_err(|error| match error.kind() {
      std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory => not_found(),
      _ => unreadable(crate::envelope::io_failure(&error, "read", &bundle_path)),
    })
  };
  let raw = read()?;
  let bundle = parse(&String::from_utf8_lossy(&raw)).map_err(|_| {
    GitError::new("malformed-input", format!("Proof bundle '{file}' is not valid JSON."))
  })?;
  assert_proof_bundle_document(&bundle)?;
  let repository = if offline {
    None
  } else if engine::repo_context(cwd).is_err() {
    Some(object_of(vec![
      ("checked", Value::Bool(false)),
      ("reason", string("not-a-repository")),
      ("matches", Value::Null),
    ]))
  } else {
    Some(verify_against_repository(&bundle, cwd)?)
  };
  let anchors = match anchors_from.filter(|remote| !remote.is_empty()) {
    Some(remote) => Some(anchors_from_ls_remote(&bundle, remote, cwd)?),
    None => None,
  };
  let result = verify_proof_bundle(&bundle, repository, anchors)?;
  let ok = truthy(get(Some(&result), "ok"));
  Ok((result, ok))
}

/// `formatProofVerification(result)`.
pub fn format_proof_verification(result: &Value) -> String {
  let at = |path: &[&str]| path.iter().fold(Some(result), |value, name| get(value, name));
  let text_at = |path: &[&str]| js_text(at(path));
  let flag = |path: &[&str]| truthy(at(path));
  let tier = text_at(&["tier"]);
  let tier_prose = match tier.as_str() {
    "self-consistent" => "self-consistent: the classification follows from the evidence the bundle states".to_string(),
    "bound" => "bound: the stated evidence is tied to Git objects between the heads the bundle states".to_string(),
    "anchored" => "anchored: those heads were confirmed from a channel you chose, so a third party may act on this".to_string(),
    _ => tier,
  };
  let algorithm = match at(&["integrity", "algorithm"]) {
    None | Some(Value::Null) => "unknown".to_string(),
    value => js_text(value),
  };
  let mut lines = vec![
    "Proof bundle verification".to_string(),
    format!("bundle       {}", text_at(&["bundleSchema"])),
    format!("tier         {tier_prose}"),
    format!(
      "integrity    {} ({algorithm})",
      if flag(&["integrity", "intact"]) { "intact" } else { "BROKEN" }
    ),
    format!(
      "changes      {}/{} reproduced from the evidence the bundle states",
      text_at(&["classification", "reproduced"]),
      text_at(&["classification", "changes"])
    ),
    format!(
      "counts       {} with the supplied changes",
      if flag(&["classification", "counts", "agrees"]) { "agree" } else { "DO NOT AGREE" }
    ),
    format!(
      "inventory    {}",
      if flag(&["classification", "uniqueCommits"]) { "unique commits" } else { "DUPLICATE commits" }
    ),
    format!(
      "evidence     {}",
      if flag(&["repository", "checked"]) {
        if flag(&["repository", "matches"]) {
          "matches this repository".to_string()
        } else {
          "DOES NOT MATCH this repository".to_string()
        }
      } else {
        format!("not checked against a repository ({})", text_at(&["repository", "reason"]))
      }
    ),
  ];
  lines.push(format!(
    "binding      {}",
    if flag(&["binding", "checked"]) {
      if flag(&["binding", "agrees"]) {
        format!(
          "holds; {} carried objects recompute their own ids",
          text_at(&["binding", "objects", "carried"])
        )
      } else {
        "DOES NOT HOLD".to_string()
      }
    } else {
      format!("not carried by this bundle version ({})", text_at(&["binding", "reason"]))
    }
  ));
  if text_at(&["anchors", "channel"]) != "none" {
    let remote = match at(&["anchors", "remote"]) {
      None | Some(Value::Null) => String::new(),
      value => js_text(value),
    };
    let line = format!(
      "anchors      {} confirmed, {} unconfirmed via {} {remote}",
      array_items(at(&["anchors", "confirmed"])).len(),
      array_items(at(&["anchors", "unconfirmed"])).len(),
      text_at(&["anchors", "channel"])
    );
    lines.push(line.trim_end_matches(text::is_space).to_string());
    for entry in array_items(at(&["anchors", "unconfirmed"])) {
      lines.push(format!(
        "  ? anchor {} {}: {}",
        js_text(get(Some(entry), "anchor")),
        short(get(Some(entry), "oid")),
        js_text(get(Some(entry), "reason"))
      ));
    }
  }
  if flag(&["repository", "lineageRelation"]) {
    lines.push(format!("lineage      {}", text_at(&["repository", "lineageRelation"])));
  }
  for problem in array_items(at(&["binding", "problems"])) {
    lines.push(format!("  ! binding: {}", js_text(Some(problem))));
  }
  if let Some(Value::Object(checks)) = at(&["repository", "checks"]) {
    for key in checks.keys() {
      if !truthy(checks.get_units(key)) {
        lines.push(format!("  ! repository {} does not match", lossy(key)));
      }
    }
  }
  for item in array_items(at(&["classification", "disagreements"])) {
    let part = |side: &str, name: &str| {
      let value = get(get(Some(item), side), name);
      match value {
        None | Some(Value::Null) if name == "proof" => "none".to_string(),
        value => js_text(value),
      }
    };
    lines.push(format!(
      "  ! {} {}: claimed {}/{}, recomputed {}/{}",
      short(get(Some(item), "commit")),
      js_text(get(Some(item), "changeId")),
      part("claimed", "status"),
      part("claimed", "proof"),
      part("recomputed", "status"),
      part("recomputed", "proof")
    ));
  }
  lines.push(String::new());
  lines.push(
    if flag(&["ok"]) {
      "The classification follows from the evidence the bundle states."
    } else {
      "The bundle does not verify."
    }
    .to_string(),
  );
  let missing = array_items(at(&["unavailable"]));
  if !missing.is_empty() {
    lines.push(String::new());
    lines.push("Conclusions unavailable from the carried material".to_string());
    for entry in missing {
      lines.push(format!(
        "  - {}: {}",
        js_text(get(Some(entry), "conclusion")),
        js_text(get(Some(entry), "reason"))
      ));
    }
  }
  lines.push(String::new());
  lines.push(text_at(&["trust", "statement"]));
  lines.join("\n")
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn base64_decoding_is_as_lenient_as_node() {
    let decode = |text: &str| -> String {
      base64_decode(&js(text)).iter().map(|byte| format!("{byte:02x}")).collect()
    };
    // Values from `Buffer.from(text, "base64").toString("hex")` on Node 26.
    for (text, hex) in [
      ("YWJj", "616263"),
      ("YW Jj", "616263"),
      ("YWJ", "6162"),
      ("Y", ""),
      ("YW=Jj", "61"),
      ("YWJj==YWJj", "616263"),
      ("Y$WJj", "616263"),
      ("YW-_", "616fbf"),
      ("=YWJj", ""),
      ("YWJj\u{e9}ZA==", "61626364"),
      ("YWJjZ", "616263"),
      ("abcd", "69b71d"),
      ("a=bc", ""),
    ] {
      assert_eq!(decode(text), hex, "{text:?}");
    }
    assert_eq!(base64_encode(b"abcd"), "YWJjZA==");
    assert_eq!(base64_encode(b""), "");
  }

  #[test]
  fn raw_commits_are_read_as_the_javascript_expressions_read_them() {
    let commit = parse_raw_commit(
      b"tree abc\nparent 01\nparent zz\nparent 02\rauthor x\n\nsubject\nbody\n\nChange-Id:  ch_1 \n",
    );
    assert_eq!(commit.tree.as_deref(), Some("abc"));
    assert_eq!(commit.parents, ["01", "02"]);
    assert_eq!(commit.subject, "subject");
    assert_eq!(commit.change_id.as_deref(), Some("ch_1"));
  }
}
