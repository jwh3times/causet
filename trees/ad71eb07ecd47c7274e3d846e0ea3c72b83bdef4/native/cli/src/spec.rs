//! `cst spec show` and `cst spec status`: specification manifests as
//! `src/specs.js` materializes them, and the semantic three-way merge planner
//! a pending operation's conflicted Markdown runs through (`planSpecMerge`).
//!
//! Manifests are tracked files, and so untrusted: they are read as JSON with
//! JavaScript semantics, and the block parser's regular expressions are
//! evaluated as the JavaScript engine backtracks them.

use crate::records::{not_callable, short};
use crate::resolve::read_pending_operation;
use crate::store::{assert_within_bound, read_json};
use causet_engine::errors::{GitError, GitResult};
use causet_engine::locations::{CURRENT_NAMES, LEGACY_NAMES, names};
use causet_engine::{engine, text};
use causet_model::js::{
  get, join, length, locale_compare, nullish, same_value_zero, strict_equals, text as js_text,
  to_js_string, truthy,
};
use causet_model::json::{
  Object, Value, js, lossy, number_to_string, parse, string, stringify, stringify_pretty,
};
use causet_model::schemas::canonical_schema;
use unicode_normalization::UnicodeNormalization as _;

pub const SPEC_PARSER: &str = "stable-markdown-blocks/v2";
const LEGACY_PARSER: &str = "stable-markdown-blocks/v1";
pub const SPEC_MERGE_ALGORITHM: &str = "stable-markdown-three-way/v2";
pub const SPEC_MANIFEST_SCHEMA: &str = "causet.spec-manifest/v4";
pub const SPEC_ID_ALGORITHM: &str = "artifact-semantic-key-sha256/v1";

fn sha256(text: &str) -> String {
  causet_model::sha256::hex(text.as_bytes())
}

fn number(value: usize) -> Value {
  Value::Number(value as f64)
}

fn as_text(value: Option<&Value>) -> Option<String> {
  match value {
    Some(Value::String(units)) => Some(lossy(units)),
    _ => None,
  }
}

/// `normalizeMarkdown(text)`.
pub fn normalize_markdown(text: &str) -> String {
  text.replace("\r\n", "\n").replace('\r', "\n")
}

fn split_lines(text: &str) -> Vec<String> {
  normalize_markdown(text)
    .split('\n')
    .map(str::to_string)
    .collect()
}

fn trim_end(text: &str) -> &str {
  text.trim_end_matches(text::is_space)
}

/// `blockContent(lines, start, endExclusive)`: a clamped `slice`, joined and
/// trimmed at the end.
fn block_content(lines: &[String], start: i64, end: i64) -> String {
  let length = lines.len() as i64;
  let clamp = |index: i64| if index < 0 { (length + index).max(0) } else { index.min(length) } as usize;
  let (start, end) = (clamp(start), clamp(end));
  if start >= end {
    return String::new();
  }
  trim_end(&lines[start..end].join("\n")).to_string()
}

fn deterministic_entity_id(artifact_id: &str, semantic_key: &str) -> String {
  format!(
    "ent_{}",
    &sha256(&format!("{artifact_id}\0{semantic_key}"))[..24]
  )
}

/// `slug(value)`: NFKD, lowercased, with every run of anything but `[a-z0-9]`
/// as one `-`, trimmed of `-`, at most 80 characters, or `untitled`.
pub(crate) fn slug(value: &str) -> String {
  let lowered = value.nfkd().collect::<String>().to_lowercase();
  let mut out = String::new();
  let mut pending = false;
  for c in lowered.chars() {
    if c.is_ascii_lowercase() || c.is_ascii_digit() {
      if pending && !out.is_empty() {
        out.push('-');
      }
      pending = false;
      out.push(c);
    } else {
      pending = true;
    }
  }
  let sliced: String = out.chars().take(80).collect();
  if sliced.is_empty() {
    "untitled".into()
  } else {
    sliced
  }
}

/// `/^ {0,3}(`{3,}|~{3,})(.*)$/s`: the fence and the rest of its line.
fn fence(line: &str) -> Option<(String, String)> {
  let indent = line.bytes().take_while(|byte| *byte == b' ').count();
  if indent > 3 {
    return None;
  }
  let rest = &line[indent..];
  let marker = rest.chars().next().filter(|c| *c == '`' || *c == '~')?;
  let run = rest.chars().take_while(|c| *c == marker).count();
  if run < 3 {
    return None;
  }
  let split = marker.len_utf8() * run;
  Some((rest[..split].to_string(), rest[split..].to_string()))
}

/// `literalLines(lines)`: which lines are inside a fenced code block.
fn literal_lines(lines: &[String]) -> Vec<bool> {
  let mut open: Option<String> = None;
  lines
    .iter()
    .map(|line| {
      let delimiter = fence(line);
      if let Some(current) = &open {
        if let Some((marker, rest)) = &delimiter
          && marker.starts_with(current.chars().next().unwrap_or('`'))
          && marker.chars().count() >= current.chars().count()
          && rest.chars().all(|c| c == ' ' || c == '\t')
        {
          open = None;
        }
        return true;
      }
      if let Some((marker, rest)) = delimiter
        && (marker.starts_with('~') || !rest.contains('`'))
      {
        open = Some(marker);
        return true;
      }
      false
    })
    .collect()
}

/// `(\s+)(.+?)\s*$` from `start`, backtracking as the engine does: the
/// lazy capture, or `None`. `min_space` is how many spaces must precede it.
fn lazy_capture(chars: &[char], start: usize, min_space: usize) -> Option<String> {
  let mut run = 0;
  while start + run < chars.len() && text::is_space(chars[start + run]) {
    run += 1;
  }
  if run < min_space {
    return None;
  }
  let tail = |at: usize| chars[at..].iter().all(|c| text::is_space(*c));
  for skipped in (min_space..=run).rev() {
    let capture = start + skipped;
    let mut end = capture;
    while end < chars.len() && !text::is_line_terminator(chars[end]) {
      end += 1;
      if tail(end) {
        return Some(chars[capture..end].iter().collect());
      }
    }
  }
  None
}

/// `/^(#{1,6})\s+(.+?)\s*$/`: the level and the raw title.
fn heading(line: &str) -> Option<(usize, String)> {
  let chars: Vec<char> = line.chars().collect();
  let hashes = chars.iter().take_while(|c| **c == '#').count();
  if hashes == 0 {
    return None;
  }
  // `#{1,6}` backtracks to fewer hashes only when a space can follow, and a
  // hash is not a space, so only the greedy count can match.
  if hashes > 6 {
    return None;
  }
  lazy_capture(&chars, hashes, 1).map(|title| (hashes, title))
}

/// `title.replace(/\s+#+\s*$/, "").trim()`.
fn heading_title(raw: &str) -> String {
  let chars: Vec<char> = raw.chars().collect();
  for start in 0..chars.len() {
    if !text::is_space(chars[start]) {
      continue;
    }
    let mut index = start;
    while index < chars.len() && text::is_space(chars[index]) {
      index += 1;
    }
    let hashes = chars[index..].iter().take_while(|c| **c == '#').count();
    if hashes == 0 {
      continue;
    }
    if chars[index + hashes..].iter().all(|c| text::is_space(*c)) {
      let kept: String = chars[..start].iter().collect();
      return text::trim(&kept).to_string();
    }
  }
  text::trim(raw).to_string()
}

/// `/^\s*(REQ-[A-Za-z0-9._-]+)\s*:\s*(.+?)\s*$/`: the requirement identifier.
fn requirement(line: &str) -> Option<String> {
  let chars: Vec<char> = line.chars().collect();
  let mut index = 0;
  while index < chars.len() && text::is_space(chars[index]) {
    index += 1;
  }
  let prefix: Vec<char> = "REQ-".chars().collect();
  if chars.len() < index + prefix.len() || chars[index..index + prefix.len()] != prefix[..] {
    return None;
  }
  let id_start = index;
  index += prefix.len();
  let body = chars[index..]
    .iter()
    .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    .count();
  if body == 0 {
    return None;
  }
  index += body;
  let id: String = chars[id_start..index].iter().collect();
  while index < chars.len() && text::is_space(chars[index]) {
    index += 1;
  }
  if chars.get(index) != Some(&':') {
    return None;
  }
  lazy_capture(&chars, index + 1, 0).map(|_| id)
}

struct Block {
  kind: &'static str,
  semantic_key: String,
  title: String,
  level: Option<usize>,
  start_line: usize,
  end_line: usize,
  content_hash: String,
}

/// `{ id, ...block }`.
fn block_value(id: Value, block: &Block) -> Value {
  let mut object = Object::new();
  object.set("id", id);
  object.set("kind", string(block.kind));
  object.set("semanticKey", string(&block.semantic_key));
  object.set("title", string(&block.title));
  object.set("level", block.level.map_or(Value::Null, number));
  object.set("startLine", number(block.start_line));
  object.set("endLine", number(block.end_line));
  object.set("contentHash", string(&block.content_hash));
  Value::Object(object)
}

/// `parseBlocks(text, parser)`.
fn parse_blocks(text: &str, parser: &str) -> Vec<Block> {
  let lines = split_lines(text);
  let literal = if parser == SPEC_PARSER {
    literal_lines(&lines)
  } else {
    Vec::new()
  };
  let is_literal = |index: usize| literal.get(index).copied().unwrap_or(false);
  let mut headings: Vec<(usize, usize, String, String)> = Vec::new();
  let mut occurrence: Vec<(String, usize)> = Vec::new();
  let count = |occurrence: &mut Vec<(String, usize)>, key: &str| match occurrence
    .iter_mut()
    .find(|(existing, _)| existing == key)
  {
    Some((_, number)) => {
      *number += 1;
      *number
    }
    None => {
      occurrence.push((key.to_string(), 1));
      1
    }
  };
  for (index, line) in lines.iter().enumerate() {
    if is_literal(index) {
      continue;
    }
    let Some((level, raw)) = heading(line) else {
      continue;
    };
    let title = heading_title(&raw);
    let base = format!("section:{level}:{}", slug(&title));
    let number = count(&mut occurrence, &base);
    headings.push((index, level, title, format!("{base}:{number}")));
  }
  let mut blocks = Vec::new();
  let first = headings.first().map_or(lines.len(), |heading| heading.0);
  let preamble = block_content(&lines, 0, first as i64);
  if !preamble.is_empty() || headings.is_empty() {
    blocks.push(Block {
      kind: "preamble",
      semantic_key: "preamble:1".into(),
      title: "Preamble".into(),
      level: None,
      start_line: 1,
      end_line: first.max(1),
      content_hash: sha256(&preamble),
    });
  }
  for (position, (index, level, title, key)) in headings.iter().enumerate() {
    let end = headings
      .get(position + 1)
      .map_or(lines.len(), |next| next.0);
    let content = block_content(&lines, *index as i64, end as i64);
    blocks.push(Block {
      kind: "section",
      semantic_key: key.clone(),
      title: title.clone(),
      level: Some(*level),
      start_line: index + 1,
      end_line: (index + 1).max(end),
      content_hash: sha256(&content),
    });
  }
  let mut requirements: Vec<(String, usize)> = Vec::new();
  for (index, line) in lines.iter().enumerate() {
    if is_literal(index) {
      continue;
    }
    let Some(id) = requirement(line) else {
      continue;
    };
    let id = id.to_uppercase();
    let number = count(&mut requirements, &id);
    blocks.push(Block {
      kind: "requirement",
      semantic_key: format!("requirement:{id}:{number}"),
      title: id,
      level: None,
      start_line: index + 1,
      end_line: index + 1,
      content_hash: sha256(text::trim(line)),
    });
  }
  blocks.sort_by(|left, right| {
    left
      .start_line
      .cmp(&right.start_line)
      .then_with(|| locale_compare(left.kind, right.kind))
  });
  blocks
}

/// A `Map` keyed as JavaScript keys one: the later set of a key wins and
/// keeps its first position.
#[derive(Default, Clone)]
struct ValueMap(Vec<(Value, Value)>);

impl ValueMap {
  fn position(&self, key: &Value) -> Option<usize> {
    if matches!(key, Value::Array(_) | Value::Object(_)) {
      return None;
    }
    self
      .0
      .iter()
      .position(|(existing, _)| same_value_zero(Some(existing), Some(key)))
  }

  fn set(&mut self, key: Value, value: Value) {
    match self.position(&key) {
      Some(index) => self.0[index].1 = value,
      None => self.0.push((key, value)),
    }
  }

  fn get(&self, key: &Value) -> Option<&Value> {
    self.position(key).map(|index| &self.0[index].1)
  }

  fn has(&self, key: &Value) -> bool {
    self.position(key).is_some()
  }
}

/// `Object.entries(value)` for a JSON value.
fn entries(value: Option<&Value>) -> Vec<(Value, Value)> {
  match value {
    Some(Value::Object(object)) => object
      .keys()
      .into_iter()
      .map(|key| {
        (
          Value::String(key.clone()),
          object.get_units(key).cloned().unwrap_or(Value::Null),
        )
      })
      .collect(),
    Some(Value::Array(items)) => items
      .iter()
      .enumerate()
      .map(|(index, item)| (string(&index.to_string()), item.clone()))
      .collect(),
    Some(Value::String(units)) => units
      .iter()
      .enumerate()
      .map(|(index, unit)| (string(&index.to_string()), Value::String(vec![*unit])))
      .collect(),
    _ => Vec::new(),
  }
}

/// `for (const item of value ?? [])`.
fn iterate_or_empty(value: Option<&Value>) -> GitResult<Vec<Value>> {
  match value {
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
      number_to_string(*number)
    ))),
    Some(Value::Bool(flag)) => Err(GitError::uncoded(format!(
      "boolean {flag} is not iterable (cannot read property Symbol(Symbol.iterator))"
    ))),
    _ => Err(GitError::uncoded(
      "object is not iterable (cannot read property Symbol(Symbol.iterator))",
    )),
  }
}

/// `manifestOverrideMap(manifest)`.
fn manifest_override_map(manifest: Option<&Value>) -> GitResult<ValueMap> {
  let mut overrides = ValueMap::default();
  let declared = get(manifest, "idOverrides");
  for (key, value) in entries(if nullish(declared) { None } else { declared }) {
    overrides.set(key, value);
  }
  let artifact = get(manifest, "artifactId");
  if !truthy(artifact) {
    return Ok(overrides);
  }
  for block in iterate_or_empty(get(manifest, "blocks"))? {
    let key = get(Some(&block), "semanticKey");
    let id = get(Some(&block), "id");
    if truthy(key) && truthy(id) {
      let expected = string(&deterministic_entity_id(&js_text(artifact), &js_text(key)));
      if !strict_equals(id, Some(&expected)) {
        overrides.set(
          key.cloned().unwrap_or(Value::Null),
          id.cloned().unwrap_or(Value::Null),
        );
      }
    }
  }
  Ok(overrides)
}

/// `manifestParser(storedManifest)`: the parser a manifest was built with.
fn manifest_parser(stored: Option<&Value>) -> GitResult<&'static str> {
  if !matches!(stored, Some(Value::Object(_) | Value::Array(_))) {
    return Err(GitError::new(
      "malformed-input",
      "Specification manifest is missing or invalid.",
    ));
  }
  let schema = get(stored, "schema");
  let canonical = as_text(schema).map(|schema| canonical_schema(&schema));
  let known = [
    "causet.spec-manifest/v1",
    "causet.spec-manifest/v2",
    "causet.spec-manifest/v3",
    SPEC_MANIFEST_SCHEMA,
  ];
  if !canonical
    .as_deref()
    .is_some_and(|schema| known.contains(&schema))
  {
    return Err(GitError::new(
      "unknown-schema-version",
      format!("Unsupported specification manifest '{}'.", js_text(schema)),
    ));
  }
  if !truthy(get(stored, "artifactId")) || !truthy(get(stored, "source")) {
    return Err(GitError::new(
      "malformed-input",
      "Specification manifest is missing artifact identity.",
    ));
  }
  let canonical = canonical.unwrap_or_default();
  let parser = if canonical == SPEC_MANIFEST_SCHEMA {
    SPEC_PARSER
  } else {
    LEGACY_PARSER
  };
  let sparse = canonical == "causet.spec-manifest/v3" || canonical == SPEC_MANIFEST_SCHEMA;
  let declared_parser = get(stored, "parser");
  let declared_ids = get(stored, "idAlgorithm");
  if ((sparse || declared_parser.is_some())
    && !strict_equals(declared_parser, Some(&string(parser))))
    || ((sparse || declared_ids.is_some())
      && !strict_equals(declared_ids, Some(&string(SPEC_ID_ALGORITHM))))
  {
    return Err(GitError::new(
      "unknown-schema-version",
      "Specification manifest uses an unsupported parser or ID algorithm.",
    ));
  }
  Ok(parser)
}

/// `Object.fromEntries([...map].sort(([left], [right]) => left.localeCompare(right)))`.
fn sorted_overrides(map: &ValueMap) -> GitResult<Value> {
  let mut items = map.0.clone();
  causet_model::js::try_v8_sort_by(&mut items, |left, right| match &left.0 {
    Value::String(units) => Ok(
      match locale_compare(&lossy(units), &js_text(Some(&right.0))) {
        std::cmp::Ordering::Less => -1.0,
        std::cmp::Ordering::Equal => 0.0,
        std::cmp::Ordering::Greater => 1.0,
      },
    ),
    other => Err(not_callable("left", "localeCompare", Some(other))),
  })?;
  let mut object = Object::new();
  for (key, value) in items {
    object.insert(to_js_string(Some(&key)), value);
  }
  Ok(Value::Object(object))
}

/// `materializeManifest(raw, storedManifest)`.
fn materialize_manifest(raw: &str, stored: &Value) -> GitResult<Value> {
  let parser = manifest_parser(Some(stored))?;
  let overrides = manifest_override_map(Some(stored))?;
  let canonical = normalize_markdown(raw);
  let artifact = js_text(get(Some(stored), "artifactId"));
  let blocks: Vec<Value> = parse_blocks(&canonical, parser)
    .iter()
    .map(|block| {
      let id = match overrides.get(&string(&block.semantic_key)) {
        Some(value) if !matches!(value, Value::Null) => value.clone(),
        _ => string(&deterministic_entity_id(&artifact, &block.semantic_key)),
      };
      block_value(id, block)
    })
    .collect();
  let mut manifest = match stored {
    Value::Object(object) => object.clone(),
    Value::Array(items) => {
      let mut object = Object::new();
      for (index, item) in items.iter().enumerate() {
        object.set(&index.to_string(), item.clone());
      }
      object
    }
    _ => Object::new(),
  };
  manifest.set(
    "schema",
    get(Some(stored), "schema").cloned().unwrap_or(Value::Null),
  );
  manifest.set("sourceBytes", number(canonical.len()));
  manifest.set("sourceLines", number(split_lines(&canonical).len()));
  manifest.set("entityCount", number(blocks.len()));
  let declared = get(Some(stored), "idAlgorithm");
  manifest.set(
    "idAlgorithm",
    if nullish(declared) {
      string(SPEC_ID_ALGORITHM)
    } else {
      declared.cloned().unwrap_or(Value::Null)
    },
  );
  manifest.set("idOverrides", sorted_overrides(&overrides)?);
  manifest.set("blocks", Value::Array(blocks));
  Ok(Value::Object(manifest))
}

/// `path.relative(from, to)`, with Windows's case-insensitive comparison.
fn relative_path(from: &str, to: &str) -> String {
  let split = |path: &str| -> Vec<String> {
    path
      .split(text::SEPARATOR)
      .filter(|part| !part.is_empty())
      .map(str::to_string)
      .collect()
  };
  let (from_parts, to_parts) = (split(from), split(to));
  let same = |left: &str, right: &str| {
    if cfg!(windows) {
      left.to_lowercase() == right.to_lowercase()
    } else {
      left == right
    }
  };
  if cfg!(windows)
    && from_parts
      .first()
      .zip(to_parts.first())
      .is_some_and(|(left, right)| !same(left, right))
  {
    return to.to_string();
  }
  let common = from_parts
    .iter()
    .zip(&to_parts)
    .take_while(|(left, right)| same(left, right))
    .count();
  let mut parts: Vec<String> = vec!["..".to_string(); from_parts.len() - common];
  parts.extend(to_parts[common..].iter().cloned());
  parts.join(&text::SEPARATOR.to_string())
}

/// `relativeSpecPath(file, context, cwd)`.
fn relative_spec_path(file: &str, root: &str, cwd: &str) -> GitResult<String> {
  let absolute = text::resolve(cwd, file);
  let relative = relative_path(root, &absolute);
  if relative.starts_with("..") || std::path::Path::new(&relative).is_absolute() {
    return Err(GitError::new(
      "path-outside-repository",
      "Specification must be inside the repository.",
    ));
  }
  Ok(
    relative
      .split(text::SEPARATOR)
      .collect::<Vec<_>>()
      .join("/"),
  )
}

fn manifest_path_from_relative(relative: &str, root: &str) -> GitResult<String> {
  let directory = names(root)?
    .specs_dir
    .split('/')
    .fold(root.to_string(), |path, part| text::join(&path, part));
  let file = format!("{relative}.json");
  Ok(text::resolve_path(&text::join(&directory, &file)))
}

/// `readSpecManifest(file)`: `{ manifestPath, manifest }`.
pub fn read_spec_manifest(file: &str, cwd: &str) -> GitResult<Value> {
  let context = engine::repo_context(cwd)?;
  let relative = relative_spec_path(file, &context.root, cwd)?;
  let manifest_path = {
    let context = engine::repo_context(cwd)?;
    let relative = relative_spec_path(file, &context.root, cwd)?;
    manifest_path_from_relative(&relative, &context.root)?
  };
  if let Ok(metadata) = std::fs::metadata(&manifest_path) {
    assert_within_bound(
      "specManifestBytes",
      metadata.len(),
      &format!("Spec manifest '{manifest_path}'"),
    )?;
  }
  let stored = read_json(&manifest_path)?;
  if !truthy(stored.as_ref()) {
    return Err(GitError::new(
      "not-found",
      format!("No manifest exists for '{file}'. Run 'cst spec index {file}'."),
    ));
  }
  let stored = stored.unwrap_or(Value::Null);
  let absolute = text::resolve_path(&text::join(&context.root, &relative));
  if !std::path::Path::new(&absolute).exists() {
    return Err(GitError::new(
      "not-found",
      format!("Spec not found: {file}"),
    ));
  }
  let bytes = std::fs::read(&absolute)
    .map_err(|error| crate::envelope::io_failure(&error, "read", &absolute))?;
  let raw = normalize_markdown(&String::from_utf8_lossy(&bytes));
  if !strict_equals(
    Some(&string(&sha256(&raw))),
    get(Some(&stored), "sourceHash"),
  ) {
    return Err(
      GitError::new(
        "stale-manifest",
        format!("Spec manifest for '{file}' is stale."),
      )
      .details(format!("Re-index it with: cst spec index {file}")),
    );
  }
  let mut result = Object::new();
  result.set("manifestPath", string(&manifest_path));
  result.set("manifest", materialize_manifest(&raw, &stored)?);
  Ok(Value::Object(result))
}

// ---------------------------------------------------------------------------
// The merge planner
// ---------------------------------------------------------------------------

/// A block with its content: `{ ...block, content }`.
#[derive(Clone)]
struct Content {
  block: Value,
  content: String,
}

impl Content {
  fn member(&self, name: &str) -> Option<&Value> {
    get(Some(&self.block), name)
  }

  fn id(&self) -> Value {
    self.member("id").cloned().unwrap_or(Value::Null)
  }
}

struct Stage {
  exists: bool,
  raw: Option<String>,
  source_hash: Option<String>,
  manifest: Option<Value>,
  manifest_hash: Option<String>,
  blocks: Vec<Content>,
}

impl Stage {
  fn fingerprint(&self) -> Value {
    let mut object = Object::new();
    object.set("exists", Value::Bool(self.exists));
    object.set(
      "sourceHash",
      self.source_hash.as_deref().map_or(Value::Null, string),
    );
    object.set(
      "manifestHash",
      self.manifest_hash.as_deref().map_or(Value::Null, string),
    );
    Value::Object(object)
  }
}

/// `primaryBlocks(raw, manifest)`.
fn primary_blocks(raw: &str, manifest: &Value) -> GitResult<Vec<Content>> {
  let lines = split_lines(raw);
  let line = |block: &Value, name: &str| match get(Some(block), name) {
    Some(Value::Number(number)) => *number as i64,
    _ => 0,
  };
  let mut primary = Vec::new();
  for block in match get(Some(manifest), "blocks") {
    Some(Value::Array(items)) => items.clone(),
    _ => Vec::new(),
  } {
    let kind = as_text(get(Some(&block), "kind"));
    if !matches!(kind.as_deref(), Some("preamble" | "section")) {
      continue;
    }
    let content = block_content(
      &lines,
      line(&block, "startLine") - 1,
      line(&block, "endLine"),
    );
    if !strict_equals(
      Some(&string(&sha256(&content))),
      get(Some(&block), "contentHash"),
    ) {
      return Err(GitError::new(
        "malformed-input",
        format!(
          "Spec manifest block '{}' does not match '{}'.",
          js_text(get(Some(&block), "id")),
          js_text(get(Some(manifest), "source"))
        ),
      ));
    }
    let mut copy = match &block {
      Value::Object(object) => object.clone(),
      _ => Object::new(),
    };
    copy.set("content", string(&content));
    primary.push(Content {
      block: Value::Object(copy),
      content,
    });
  }
  let has_preamble = primary
    .iter()
    .any(|block| as_text(block.member("kind")).as_deref() == Some("preamble"));
  let first_start = primary.first().map(|block| line(&block.block, "startLine"));
  if !has_preamble && first_start.is_some_and(|start| start > 1) {
    let start = first_start.unwrap_or(1);
    let content = block_content(&lines, 0, start - 1);
    if !content.is_empty() {
      let preamble = Block {
        kind: "preamble",
        semantic_key: "preamble:1".into(),
        title: "Preamble".into(),
        level: None,
        start_line: 1,
        end_line: (start - 1) as usize,
        content_hash: sha256(&content),
      };
      let artifact = js_text(get(Some(manifest), "artifactId"));
      let mut block = match block_value(
        string(&deterministic_entity_id(&artifact, "preamble:1")),
        &preamble,
      ) {
        Value::Object(object) => object,
        _ => Object::new(),
      };
      block.set("content", string(&content));
      primary.insert(
        0,
        Content {
          block: Value::Object(block),
          content,
        },
      );
    }
  }
  let mut ids: Vec<Value> = Vec::new();
  for block in &primary {
    let id = block.id();
    let repeated = !matches!(id, Value::Array(_) | Value::Object(_))
      && ids
        .iter()
        .any(|seen| same_value_zero(Some(seen), Some(&id)));
    if repeated {
      return Err(GitError::new(
        "malformed-input",
        format!(
          "Spec manifest for '{}' has duplicate block IDs.",
          js_text(get(Some(manifest), "source"))
        ),
      ));
    }
    ids.push(id);
  }
  Ok(primary)
}

/// `revisionStageFromObjects(file, revision, sourceObject, manifestObject)`.
fn revision_stage(
  file: &str,
  revision: &str,
  source: &causet_engine::types::ObjectRecord,
  manifest_object: &causet_engine::types::ObjectRecord,
) -> GitResult<Stage> {
  let decode = |object: &causet_engine::types::ObjectRecord| {
    object.exists.then(|| {
      normalize_markdown(&String::from_utf8_lossy(
        object.content.as_deref().unwrap_or_default(),
      ))
    })
  };
  let raw = decode(source);
  let manifest_raw = decode(manifest_object);
  let Some(raw) = raw else {
    return Ok(Stage {
      exists: false,
      raw: None,
      source_hash: None,
      manifest: None,
      manifest_hash: manifest_raw.as_deref().map(sha256),
      blocks: Vec::new(),
    });
  };
  let Some(manifest_raw) = manifest_raw else {
    return Err(
      GitError::new(
        "not-found",
        format!("No committed spec manifest exists for '{file}' at {revision}."),
      )
      .details(format!("Index and commit it with: cst spec index {file}")),
    );
  };
  assert_within_bound(
    "specManifestBytes",
    manifest_raw.len() as u64,
    &format!("Spec manifest for '{file}' at {revision}"),
  )?;
  let stored = parse(&manifest_raw).map_err(|_| {
    GitError::new(
      "malformed-input",
      format!("Spec manifest for '{file}' at {revision} is invalid JSON."),
    )
  })?;
  if matches!(stored, Value::Null) {
    return Err(GitError::uncoded(
      "Cannot read properties of null (reading 'source')",
    ));
  }
  if !strict_equals(get(Some(&stored), "source"), Some(&string(file))) {
    return Err(GitError::new(
      "malformed-input",
      format!("Spec manifest source does not match '{file}' at {revision}."),
    ));
  }
  let normalized = sha256(&raw);
  let mut compatible = vec![normalized.clone()];
  let schema = as_text(get(Some(&stored), "schema")).map(|schema| canonical_schema(&schema));
  if schema.as_deref() == Some("causet.spec-manifest/v1") {
    compatible.push(sha256(&raw.replace('\n', "\r\n")));
  }
  let declared = get(Some(&stored), "sourceHash");
  if !compatible
    .iter()
    .any(|hash| strict_equals(Some(&string(hash)), declared))
  {
    return Err(
      GitError::new(
        "stale-manifest",
        format!("Spec manifest for '{file}' is stale at {revision}."),
      )
      .details(format!(
        "Re-index and commit it with: cst spec index {file}"
      )),
    );
  }
  let manifest = materialize_manifest(&raw, &stored)?;
  let blocks = primary_blocks(&raw, &manifest)?;
  Ok(Stage {
    exists: true,
    raw: Some(raw),
    source_hash: Some(normalized),
    manifest: Some(manifest),
    manifest_hash: Some(sha256(&manifest_raw)),
    blocks,
  })
}

/// `revisionStages(file, revisions, cwd)`: both manifest directories are read
/// in one batch, and the current one wins when it exists.
fn revision_stages(file: &str, revisions: &[String], cwd: &str) -> GitResult<Vec<Stage>> {
  let expressions: Vec<String> = revisions
    .iter()
    .flat_map(|revision| {
      [
        format!("{revision}:{file}"),
        format!("{revision}:{}/{file}.json", CURRENT_NAMES.specs_dir),
        format!("{revision}:{}/{file}.json", LEGACY_NAMES.specs_dir),
      ]
    })
    .collect();
  let objects = engine::read_git_objects(&expressions, cwd)?.records;
  revisions
    .iter()
    .enumerate()
    .map(|(index, revision)| {
      // The current directory's manifest when it exists, else the one a revision
      // from before the migration keeps under the former directory (#183).
      let current = &objects[index * 3 + 1];
      let manifest = if current.exists { current } else { &objects[index * 3 + 2] };
      revision_stage(file, revision, &objects[index * 3], manifest)
    })
    .collect()
}

/// `migrationEntityId(artifactId, semanticKey, reserved, assigned)`.
fn migration_entity_id(artifact: &str, key: &str, taken: &dyn Fn(&Value) -> bool) -> String {
  let mut counter = 0;
  loop {
    let id = format!(
      "ent_{}",
      &sha256(&format!("{artifact}\0fence-migration/v2\0{key}\0{counter}"))[..24]
    );
    counter += 1;
    if !taken(&string(&id)) {
      return id;
    }
  }
}

/// `migrateManifest(raw, storedManifest).blocks`.
fn migrated_blocks(raw: &str, stored: &Value) -> GitResult<Vec<Value>> {
  let historical = materialize_manifest(raw, stored)?;
  let historical_blocks = match get(Some(&historical), "blocks") {
    Some(Value::Array(items)) => items.clone(),
    _ => Vec::new(),
  };
  let mut reserved = ValueMap::default();
  for block in &historical_blocks {
    reserved.set(
      get(Some(block), "id").cloned().unwrap_or(Value::Null),
      Value::Null,
    );
  }
  if reserved.0.len() != historical_blocks.len() {
    return Err(GitError::new(
      "malformed-input",
      "Specification migration found duplicate entity IDs.",
    ));
  }
  for block in iterate_or_empty(get(Some(stored), "blocks"))? {
    let key = js_text(get(Some(&block), "semanticKey"));
    let declared = get(get(Some(stored), "idOverrides"), &key);
    if declared.is_some() && !strict_equals(declared, get(Some(&block), "id")) {
      return Err(GitError::new(
        "malformed-input",
        "Specification migration found conflicting ID overrides.",
      ));
    }
  }
  let location = |block: &Value| {
    stringify(&Value::Array(
      ["kind", "startLine", "level", "title"]
        .iter()
        .map(|name| get(Some(block), name).cloned().unwrap_or(Value::Null))
        .collect(),
    ))
  };
  let mut previous: Vec<(String, Value)> = Vec::new();
  for block in &historical_blocks {
    let key = location(block);
    match previous.iter_mut().find(|(existing, _)| *existing == key) {
      Some(entry) => entry.1 = block.clone(),
      None => previous.push((key, block.clone())),
    }
  }
  let artifact = js_text(get(Some(&historical), "artifactId"));
  let mut assigned = ValueMap::default();
  let mut blocks = Vec::new();
  for block in parse_blocks(raw, SPEC_PARSER) {
    let candidate = block_value(Value::Null, &block);
    let matched = previous
      .iter()
      .find(|(key, _)| *key == location(&candidate))
      .map(|(_, block)| block);
    let mut id = match matched.and_then(|block| get(Some(block), "id")) {
      Some(value) if !matches!(value, Value::Null) => value.clone(),
      _ => string(&deterministic_entity_id(&artifact, &block.semantic_key)),
    };
    if matched.is_none() && (reserved.has(&id) || assigned.has(&id)) {
      id = string(&migration_entity_id(
        &artifact,
        &block.semantic_key,
        &|candidate| reserved.has(candidate) || assigned.has(candidate),
      ));
    }
    if assigned.has(&id) {
      return Err(GitError::new(
        "malformed-input",
        "Specification migration found conflicting entity IDs.",
      ));
    }
    assigned.set(id.clone(), Value::Null);
    blocks.push(block_value(id, &block));
  }
  Ok(blocks)
}

/// `contentDecision(id, base, ours, theirs)`: the outcome, the conflict and
/// who deleted, and the chosen block.
fn content_decision(
  base: Option<&Content>,
  ours: Option<&Content>,
  theirs: Option<&Content>,
) -> (
  &'static str,
  Option<&'static str>,
  Option<&'static str>,
  Option<Content>,
) {
  let same = |left: Option<&Content>, right: Option<&Content>| {
    strict_equals(
      left.and_then(|block| block.member("contentHash")),
      right.and_then(|block| block.member("contentHash")),
    )
  };
  if base.is_some() {
    if ours.is_none() && theirs.is_none() {
      return ("deleted-both", None, None, None);
    }
    if ours.is_none() {
      if same(base, theirs) {
        return ("deleted-ours", None, None, None);
      }
      return ("conflict", Some("delete-vs-edit"), Some("ours"), None);
    }
    if theirs.is_none() {
      if same(base, ours) {
        return ("deleted-theirs", None, None, None);
      }
      return ("conflict", Some("delete-vs-edit"), Some("theirs"), None);
    }
    let ours_changed = !same(base, ours);
    let theirs_changed = !same(base, theirs);
    return match (ours_changed, theirs_changed) {
      (false, false) => ("unchanged", None, None, ours.cloned()),
      (true, false) => ("ours-edit", None, None, ours.cloned()),
      (false, true) => ("theirs-edit", None, None, theirs.cloned()),
      _ if same(ours, theirs) => ("identical-edit", None, None, ours.cloned()),
      _ => ("conflict", Some("same-block-edit"), None, None),
    };
  }
  if ours.is_some() && theirs.is_some() {
    if same(ours, theirs) {
      return ("identical-add", None, None, ours.cloned());
    }
    return ("conflict", Some("same-block-concurrent-add"), None, None);
  }
  if ours.is_some() {
    return ("ours-add", None, None, ours.cloned());
  }
  ("theirs-add", None, None, theirs.cloned())
}

/// An ASCII-only case-insensitive prefix test, as a non-Unicode `/i` makes.
fn ascii_starts(text: &str, prefix: &str) -> bool {
  text.len() >= prefix.len()
    && text.as_bytes()[..prefix.len()].eq_ignore_ascii_case(prefix.as_bytes())
}

/// An ASCII-only case-insensitive suffix test.
fn ascii_ends(text: &str, suffix: &str) -> bool {
  text.len() >= suffix.len()
    && text.as_bytes()[text.len() - suffix.len()..].eq_ignore_ascii_case(suffix.as_bytes())
}

fn key_eq(left: &Value, right: &Value) -> bool {
  !matches!(left, Value::Array(_) | Value::Object(_)) && same_value_zero(Some(left), Some(right))
}

fn contains(items: &[Value], value: &Value) -> bool {
  items.iter().any(|item| key_eq(item, value))
}

/// `orderAdded(stage, skeletonSet)`: each run of added blocks after the
/// skeleton block it follows (`"__start__"` before the first).
fn order_added(stage: &Stage, skeleton: &[Value]) -> Vec<(Value, Vec<Value>)> {
  let mut groups: Vec<(Value, Vec<Value>)> = Vec::new();
  let mut anchor = string("__start__");
  for block in &stage.blocks {
    let id = block.id();
    if contains(skeleton, &id) {
      anchor = id;
      continue;
    }
    match groups
      .iter_mut()
      .find(|(existing, _)| key_eq(existing, &anchor))
    {
      Some((_, items)) => items.push(id),
      None => groups.push((anchor.clone(), vec![id])),
    }
  }
  groups
}

fn anchor_of<'a>(groups: &'a [(Value, Vec<Value>)], id: &Value) -> Option<&'a Value> {
  let mut found = None;
  for (anchor, ids) in groups {
    if contains(ids, id) {
      found = Some(anchor);
    }
  }
  found
}

/// `mergeOrder(base, ours, theirs, chosen)`: the order, its decision, and any
/// ordering conflict.
fn merge_order(
  base: &Stage,
  ours: &Stage,
  theirs: &Stage,
  chosen: &[(Value, Content)],
) -> (Vec<Value>, &'static str, Vec<Value>) {
  let chosen_ids: Vec<Value> = chosen.iter().map(|(id, _)| id.clone()).collect();
  let base_ids: Vec<Value> = base
    .blocks
    .iter()
    .map(Content::id)
    .filter(|id| contains(&chosen_ids, id))
    .collect();
  let projection = |stage: &Stage| -> Vec<Value> {
    stage
      .blocks
      .iter()
      .map(Content::id)
      .filter(|id| contains(&base_ids, id))
      .collect()
  };
  let same_array = |left: &[Value], right: &[Value]| {
    left.len() == right.len()
      && left
        .iter()
        .zip(right)
        .all(|(a, b)| strict_equals(Some(a), Some(b)))
  };
  let (ours_projection, theirs_projection) = (projection(ours), projection(theirs));
  let conflict = |kind: &str, extra: Option<(&str, Value)>| {
    let mut object = Object::new();
    object.set("type", string(kind));
    if let Some((name, value)) = extra {
      object.set(name, value);
    }
    (Vec::new(), "conflict", vec![Value::Object(object)])
  };
  let (skeleton, decision) = if same_array(&ours_projection, &theirs_projection) {
    let decision = if same_array(&base_ids, &ours_projection) {
      "unchanged"
    } else {
      "same-move"
    };
    (ours_projection.clone(), decision)
  } else if same_array(&ours_projection, &base_ids) {
    (theirs_projection.clone(), "theirs-move")
  } else if same_array(&theirs_projection, &base_ids) {
    (ours_projection.clone(), "ours-move")
  } else {
    return conflict("conflicting-block-order", None);
  };
  let ours_added = order_added(ours, &skeleton);
  let theirs_added = order_added(theirs, &skeleton);
  for id in &chosen_ids {
    if contains(&base_ids, id) {
      continue;
    }
    if let (Some(left), Some(right)) = (anchor_of(&ours_added, id), anchor_of(&theirs_added, id))
      && !strict_equals(Some(left), Some(right))
    {
      return conflict("concurrent-add-placement", Some(("blockId", id.clone())));
    }
  }
  let mut anchors: Vec<Value> = Vec::new();
  for (anchor, _) in ours_added.iter().chain(&theirs_added) {
    if !contains(&anchors, anchor) {
      anchors.push(anchor.clone());
    }
  }
  let group = |groups: &[(Value, Vec<Value>)], anchor: &Value| -> Vec<Value> {
    groups
      .iter()
      .find(|(existing, _)| key_eq(existing, anchor))
      .map(|(_, ids)| ids.clone())
      .unwrap_or_default()
  };
  for anchor in &anchors {
    let ours_items: Vec<Value> = group(&ours_added, anchor)
      .into_iter()
      .filter(|id| anchor_of(&theirs_added, id).is_some())
      .collect();
    let theirs_items: Vec<Value> = group(&theirs_added, anchor)
      .into_iter()
      .filter(|id| anchor_of(&ours_added, id).is_some())
      .collect();
    if !same_array(&ours_items, &theirs_items) {
      return conflict(
        "conflicting-added-block-order",
        Some(("anchor", anchor.clone())),
      );
    }
  }
  let mut order: Vec<Value> = Vec::new();
  let append = |order: &mut Vec<Value>, anchor: &Value| {
    for id in group(&ours_added, anchor)
      .into_iter()
      .chain(group(&theirs_added, anchor))
    {
      if contains(&chosen_ids, &id)
        && !order
          .iter()
          .any(|existing| strict_equals(Some(existing), Some(&id)))
      {
        order.push(id);
      }
    }
  };
  append(&mut order, &string("__start__"));
  for id in &skeleton {
    if !order
      .iter()
      .any(|existing| strict_equals(Some(existing), Some(id)))
    {
      order.push(id.clone());
    }
    append(&mut order, id);
  }
  for id in &chosen_ids {
    if !order
      .iter()
      .any(|existing| strict_equals(Some(existing), Some(id)))
    {
      order.push(id.clone());
    }
  }
  (order, decision, Vec::new())
}

/// `buildManifest(source, raw, { artifactId, preferredIds, sourceBlob })` and
/// `serializeSpecManifest`: the stored text of a merged manifest.
fn serialized_merge_manifest(
  source: &str,
  markdown: &str,
  artifact: &Value,
  preferred: &ValueMap,
  blob: &str,
) -> GitResult<String> {
  let canonical = normalize_markdown(markdown);
  let artifact_text = js_text(Some(artifact));
  let mut overrides: Vec<(String, Value)> = Vec::new();
  let blocks = parse_blocks(&canonical, SPEC_PARSER);
  for block in &blocks {
    let id = match preferred.get(&string(&block.semantic_key)) {
      Some(value) if !matches!(value, Value::Null) => value.clone(),
      _ => string(&deterministic_entity_id(
        &artifact_text,
        &block.semantic_key,
      )),
    };
    let expected = string(&deterministic_entity_id(
      &artifact_text,
      &block.semantic_key,
    ));
    if !strict_equals(Some(&id), Some(&expected)) {
      match overrides
        .iter_mut()
        .find(|(key, _)| *key == block.semantic_key)
      {
        Some(entry) => entry.1 = id,
        None => overrides.push((block.semantic_key.clone(), id)),
      }
    }
  }
  let mut map = ValueMap::default();
  for (key, value) in overrides {
    map.set(string(&key), value);
  }
  let mut stored = Object::new();
  stored.set("schema", string(SPEC_MANIFEST_SCHEMA));
  stored.set("artifactId", artifact.clone());
  stored.set("source", string(source));
  stored.set("sourceHash", string(&sha256(&canonical)));
  if !blob.is_empty() {
    stored.set("sourceBlob", string(blob));
  }
  stored.set("entityCount", number(blocks.len()));
  stored.set("representation", string("annotated-markdown"));
  stored.set("parser", string(SPEC_PARSER));
  stored.set("idAlgorithm", string(SPEC_ID_ALGORITHM));
  stored.set("idOverrides", sorted_overrides(&map)?);
  Ok(format!("{}\n", stringify_pretty(&Value::Object(stored))))
}

/// `gitBlobId(value, algorithm)`.
fn git_blob_id(content: &str, format: &str) -> String {
  let mut bytes = format!("blob {}\0", content.len()).into_bytes();
  bytes.extend_from_slice(content.as_bytes());
  if format == "sha256" {
    causet_model::sha256::hex(&bytes)
  } else {
    sha1_hex(&bytes)
  }
}

/// SHA-1, for a blob identifier in a SHA-1 repository.
pub(crate) fn sha1_hex(data: &[u8]) -> String {
  let mut h: [u32; 5] = [0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0];
  let mut message = data.to_vec();
  let bits = (data.len() as u64).wrapping_mul(8);
  message.push(0x80);
  while message.len() % 64 != 56 {
    message.push(0);
  }
  message.extend_from_slice(&bits.to_be_bytes());
  for chunk in message.chunks(64) {
    let mut w = [0u32; 80];
    for (index, word) in chunk.chunks(4).enumerate() {
      w[index] = u32::from_be_bytes([word[0], word[1], word[2], word[3]]);
    }
    for index in 16..80 {
      w[index] = (w[index - 3] ^ w[index - 8] ^ w[index - 14] ^ w[index - 16]).rotate_left(1);
    }
    let [mut a, mut b, mut c, mut d, mut e] = h;
    for (index, word) in w.iter().enumerate() {
      let (f, k) = match index {
        0..=19 => ((b & c) | (!b & d), 0x5A827999),
        20..=39 => (b ^ c ^ d, 0x6ED9EBA1),
        40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1BBCDC),
        _ => (b ^ c ^ d, 0xCA62C1D6),
      };
      let temp = a
        .rotate_left(5)
        .wrapping_add(f)
        .wrapping_add(e)
        .wrapping_add(k)
        .wrapping_add(*word);
      e = d;
      d = c;
      c = b.rotate_left(30);
      b = a;
      a = temp;
    }
    for (state, value) in h.iter_mut().zip([a, b, c, d, e]) {
      *state = state.wrapping_add(value);
    }
  }
  h.iter().map(|word| format!("{word:08x}")).collect()
}

fn revisions_value(revisions: &[Option<Value>; 3]) -> Value {
  let mut object = Object::new();
  for (name, value) in ["base", "ours", "theirs"].iter().zip(revisions) {
    if let Some(value) = value {
      object.set(name, value.clone());
    }
  }
  Value::Object(object)
}

fn single(name: &str, count: usize) -> Value {
  let mut object = Object::new();
  object.set(name, number(count));
  Value::Object(object)
}

/// `planSpecMerge(file, base, ours, theirs)`.
fn plan_spec_merge(file: &str, revisions: [Option<Value>; 3], cwd: &str) -> GitResult<Value> {
  let context = engine::repo_context(cwd)?;
  let relative = relative_spec_path(file, &context.root, cwd)?;
  if !ascii_ends(&relative, ".md") {
    return Err(GitError::new(
      "unsupported-feature",
      "Semantic spec merge currently supports Markdown files only.",
    ));
  }
  let manifest_file = format!("{}/{relative}.json", names(cwd)?.specs_dir);
  let revision_text: Vec<String> = revisions
    .iter()
    .map(|value| js_text(value.as_ref()))
    .collect();
  let header = |status: &str, artifact: Value, signature: Value, with_revisions: bool| {
    let mut plan = Object::new();
    plan.set("schema", string("causet.spec-merge-plan/v2"));
    plan.set("algorithm", string(SPEC_MERGE_ALGORITHM));
    plan.set("status", string(status));
    plan.set("file", string(&relative));
    plan.set("manifestFile", string(&manifest_file));
    plan.set("artifactId", artifact);
    plan.set("signature", signature);
    if with_revisions {
      plan.set("revisions", revisions_value(&revisions));
    }
    plan
  };
  let stages = (|| -> GitResult<(Vec<Stage>, Vec<&'static str>)> {
    let stages = revision_stages(&relative, &revision_text, cwd)?;
    let mut migration = Vec::new();
    for (index, stage) in stages.iter().enumerate() {
      let Some(manifest) = &stage.manifest else {
        continue;
      };
      let schema = as_text(get(Some(manifest), "schema")).map(|schema| canonical_schema(&schema));
      if !stage.exists || schema.as_deref() == Some(SPEC_MANIFEST_SCHEMA) {
        continue;
      }
      let corrected = migrated_blocks(stage.raw.as_deref().unwrap_or_default(), manifest)?;
      let current = get(Some(manifest), "blocks")
        .cloned()
        .unwrap_or(Value::Null);
      if stringify(&Value::Array(corrected)) != stringify(&current) {
        migration.push(["base", "ours", "theirs"][index]);
      }
    }
    Ok((stages, migration))
  })();
  let (stages, migration) = match stages {
    Ok(result) => result,
    Err(error) => {
      let mut plan = header("blocked", Value::Null, Value::Null, true);
      plan.set("base", Value::Null);
      plan.set("ours", Value::Null);
      plan.set("theirs", Value::Null);
      plan.set("decisions", Value::Array(Vec::new()));
      plan.set("counts", single("semantic-metadata-unavailable", 1));
      let mut ordering = Object::new();
      ordering.set("decision", string("not-evaluated"));
      ordering.set("order", Value::Array(Vec::new()));
      plan.set("ordering", Value::Object(ordering));
      let mut conflict = Object::new();
      conflict.set("type", string("semantic-metadata-unavailable"));
      conflict.set("message", string(&error.message));
      plan.set("conflicts", Value::Array(vec![Value::Object(conflict)]));
      plan.set("result", Value::Null);
      return Ok(Value::Object(plan));
    }
  };
  let (base, ours, theirs) = (&stages[0], &stages[1], &stages[2]);
  let fingerprints = |plan: &mut Object| {
    plan.set("base", base.fingerprint());
    plan.set("ours", ours.fingerprint());
    plan.set("theirs", theirs.fingerprint());
  };
  if !migration.is_empty() {
    let mut plan = header("blocked", Value::Null, Value::Null, true);
    fingerprints(&mut plan);
    plan.set("decisions", Value::Array(Vec::new()));
    plan.set("counts", single("parser-migration-required", 1));
    let mut ordering = Object::new();
    ordering.set("decision", string("not-evaluated"));
    ordering.set("order", Value::Array(Vec::new()));
    plan.set("ordering", Value::Object(ordering));
    let mut conflict = Object::new();
    conflict.set("type", string("parser-migration-required"));
    conflict.set(
      "stages",
      Value::Array(migration.iter().map(|stage| string(stage)).collect()),
    );
    conflict.set(
      "message",
      string("Index and commit a shared baseline before branching. For existing divergent history, review an ordinary Git merge and re-index its result."),
    );
    plan.set("conflicts", Value::Array(vec![Value::Object(conflict)]));
    plan.set("result", Value::Null);
    return Ok(Value::Object(plan));
  }
  let mut artifacts: Vec<Value> = Vec::new();
  for stage in &stages {
    let artifact = get(stage.manifest.as_ref(), "artifactId");
    if truthy(artifact) {
      let artifact = artifact.cloned().unwrap_or(Value::Null);
      if !contains(&artifacts, &artifact) || matches!(artifact, Value::Array(_) | Value::Object(_))
      {
        artifacts.push(artifact);
      }
    }
  }
  if artifacts.len() != 1 {
    let mut plan = header("blocked", Value::Null, Value::Null, false);
    fingerprints(&mut plan);
    plan.set("decisions", Value::Array(Vec::new()));
    plan.set("counts", single("artifact-identity-mismatch", 1));
    let mut ordering = Object::new();
    ordering.set("decision", string("not-evaluated"));
    plan.set("ordering", Value::Object(ordering));
    let mut conflict = Object::new();
    conflict.set("type", string("artifact-identity-mismatch"));
    plan.set("conflicts", Value::Array(vec![Value::Object(conflict)]));
    plan.set("result", Value::Null);
    return Ok(Value::Object(plan));
  }
  let artifact = artifacts.remove(0);
  let mut signed = Object::new();
  signed.set("algorithm", string(SPEC_MERGE_ALGORITHM));
  signed.set("artifactId", artifact.clone());
  signed.set("base", base.fingerprint());
  signed.set("ours", ours.fingerprint());
  signed.set("theirs", theirs.fingerprint());
  let signature = format!("ssig_{}", sha256(&stringify(&Value::Object(signed))));
  // `new Map(blocks.map((block) => [block.id, block]))`: the later block of
  // an id wins and keeps the first position.
  let by_id = |stage: &Stage| -> Vec<(Value, Content)> {
    let mut map: Vec<(Value, Content)> = Vec::new();
    for block in &stage.blocks {
      let id = block.id();
      match map.iter_mut().find(|(existing, _)| key_eq(existing, &id)) {
        Some(entry) => entry.1 = block.clone(),
        None => map.push((id, block.clone())),
      }
    }
    map
  };
  let (base_by_id, ours_by_id, theirs_by_id) = (by_id(base), by_id(ours), by_id(theirs));
  let lookup = |map: &[(Value, Content)], id: &Value| {
    map
      .iter()
      .find(|(existing, _)| key_eq(existing, id))
      .map(|(_, block)| block.clone())
  };
  let mut ids: Vec<Value> = Vec::new();
  for (id, _) in base_by_id.iter().chain(&ours_by_id).chain(&theirs_by_id) {
    if !contains(&ids, id) || matches!(id, Value::Array(_) | Value::Object(_)) {
      ids.push(id.clone());
    }
  }
  let mut decisions = Vec::new();
  let mut chosen: Vec<(Value, Content)> = Vec::new();
  let mut conflicts = Vec::new();
  let mut counts: Vec<(String, usize)> = Vec::new();
  let bump = |counts: &mut Vec<(String, usize)>, key: &str| match counts
    .iter_mut()
    .find(|(existing, _)| existing == key)
  {
    Some((_, count)) => *count += 1,
    None => counts.push((key.to_string(), 1)),
  };
  for id in &ids {
    let (b, o, t) = (
      lookup(&base_by_id, id),
      lookup(&ours_by_id, id),
      lookup(&theirs_by_id, id),
    );
    let (outcome, conflict, deleted_by, block) =
      content_decision(b.as_ref(), o.as_ref(), t.as_ref());
    let mut decision = Object::new();
    decision.set("id", id.clone());
    decision.set("outcome", string(outcome));
    if let Some(conflict) = conflict {
      decision.set("conflict", string(conflict));
    }
    if let Some(deleted_by) = deleted_by {
      decision.set("deletedBy", string(deleted_by));
    }
    decisions.push(Value::Object(decision));
    bump(&mut counts, conflict.unwrap_or(outcome));
    if let Some(block) = block {
      match chosen.iter_mut().find(|(existing, _)| key_eq(existing, id)) {
        Some(entry) => entry.1 = block,
        None => chosen.push((id.clone(), block)),
      }
    }
    if let Some(conflict) = conflict {
      let first = |name: &str| {
        [&b, &o, &t]
          .iter()
          .filter_map(|block| block.as_ref().and_then(|block| block.member(name)))
          .find(|value| !nullish(Some(value)))
          .cloned()
          .unwrap_or(Value::Null)
      };
      let mut entry = Object::new();
      entry.set("type", string(conflict));
      entry.set("blockId", id.clone());
      entry.set("semanticKey", first("semanticKey"));
      entry.set("title", first("title"));
      entry.set("deletedBy", deleted_by.map_or(Value::Null, string));
      conflicts.push(Value::Object(entry));
    }
  }
  let (order, ordering_decision, ordering_conflicts) = merge_order(base, ours, theirs, &chosen);
  if let Some(first) = ordering_conflicts.first() {
    bump(&mut counts, &js_text(get(Some(first), "type")));
  }
  conflicts.extend(ordering_conflicts);
  let mut result = Value::Null;
  if conflicts.is_empty() {
    let ordered: Vec<Content> = order
      .iter()
      .filter_map(|id| {
        chosen
          .iter()
          .find(|(existing, _)| key_eq(existing, id))
          .map(|(_, block)| block.clone())
      })
      .collect();
    let mut outcome = Object::new();
    if ordered.is_empty() && (!ours.exists || !theirs.exists) {
      outcome.set("deleted", Value::Bool(true));
      outcome.set("markdown", Value::Null);
      outcome.set("manifest", Value::Null);
      outcome.set("markdownHash", Value::Null);
      outcome.set("manifestHash", Value::Null);
    } else {
      let joined = ordered
        .iter()
        .map(|block| trim_end(&block.content).to_string())
        .collect::<Vec<_>>()
        .join("\n\n");
      let markdown = format!("{}\n", trim_end(&joined));
      let mut preferred = ValueMap::default();
      for stage in &stages {
        for block in match get(stage.manifest.as_ref(), "blocks") {
          Some(Value::Array(items)) => items.clone(),
          _ => Vec::new(),
        } {
          let key = get(Some(&block), "semanticKey")
            .cloned()
            .unwrap_or(Value::Null);
          if !preferred.has(&key) {
            preferred.set(key, get(Some(&block), "id").cloned().unwrap_or(Value::Null));
          }
        }
      }
      for block in &ordered {
        preferred.set(
          block.member("semanticKey").cloned().unwrap_or(Value::Null),
          block.id(),
        );
      }
      let blob = git_blob_id(&markdown, &context.object_format);
      let serialized =
        serialized_merge_manifest(&relative, &markdown, &artifact, &preferred, &blob)?;
      outcome.set("deleted", Value::Bool(false));
      outcome.set("markdownHash", string(&sha256(&markdown)));
      outcome.set("manifestHash", string(&sha256(&serialized)));
    }
    result = Value::Object(outcome);
  }
  let mut plan = header(
    if conflicts.is_empty() {
      "clean"
    } else {
      "blocked"
    },
    artifact,
    string(&signature),
    true,
  );
  fingerprints(&mut plan);
  plan.set("decisions", Value::Array(decisions));
  let mut count_object = Object::new();
  for (key, count) in counts {
    count_object.set(&key, number(count));
  }
  plan.set("counts", Value::Object(count_object));
  let mut ordering = Object::new();
  ordering.set("decision", string(ordering_decision));
  ordering.set("order", Value::Array(order));
  plan.set("ordering", Value::Object(ordering));
  plan.set("conflicts", Value::Array(conflicts));
  plan.set("result", result);
  Ok(Value::Object(plan))
}

/// `compactSpecMerge(plan)`.
fn compact_spec_merge(plan: &Value) -> Value {
  let member = |name: &str| get(Some(plan), name).cloned().unwrap_or(Value::Null);
  let result = get(Some(plan), "result");
  let hash = |name: &str| {
    let value = get(result, name);
    if nullish(value) {
      Value::Null
    } else {
      value.cloned().unwrap_or(Value::Null)
    }
  };
  let mut compact = Object::new();
  compact.set("path", member("file"));
  compact.set("manifestPath", member("manifestFile"));
  compact.set("signature", member("signature"));
  compact.set("algorithm", member("algorithm"));
  compact.set("status", member("status"));
  compact.set("counts", member("counts"));
  if let Some(decision) = get(get(Some(plan), "ordering"), "decision") {
    compact.set("ordering", decision.clone());
  }
  compact.set("conflicts", member("conflicts"));
  compact.set("resultMarkdownHash", hash("markdownHash"));
  compact.set("resultManifestHash", hash("manifestHash"));
  compact.set(
    "resolvedPaths",
    Value::Array(vec![member("file"), member("manifestFile")]),
  );
  compact.set("selectionMethod", Value::Null);
  Value::Object(compact)
}

/// `specFilesForConflictPaths(paths)`: the Markdown a conflict touches,
/// directly or through its manifest under either directory.
fn spec_files_for_conflict_paths(paths: Option<&Value>) -> GitResult<Vec<Value>> {
  let items = match paths {
    Some(Value::Array(items)) => items.clone(),
    Some(Value::String(units)) => String::from_utf16_lossy(units)
      .chars()
      .map(|c| string(&c.to_string()))
      .collect(),
    _ => return Err(GitError::uncoded("paths is not iterable")),
  };
  let mut files: Vec<Value> = Vec::new();
  let add = |files: &mut Vec<Value>, value: Value| {
    if !contains(files, &value) || matches!(value, Value::Array(_) | Value::Object(_)) {
      files.push(value);
    }
  };
  for file in items {
    // `/.md$/i.test(file)`, which coerces the value to a string.
    if ascii_ends(&js_text(Some(&file)), ".md") {
      add(&mut files, file.clone());
    }
    // `file.match(/^.(?:causet|vcs-lab)/specs/(.+.md).json$/i)`.
    let Value::String(units) = &file else {
      return Err(not_callable("file", "match", Some(&file)));
    };
    let name = lossy(units);
    for prefix in [".causet/specs/", ".vcs-lab/specs/"] {
      if ascii_starts(&name, prefix)
        && ascii_ends(&name, ".md.json")
        && name.len() >= prefix.len() + ".md.json".len()
      {
        let inner = &name[prefix.len()..name.len() - ".json".len()];
        if inner.chars().count() >= 4 && !inner.chars().any(text::is_line_terminator) {
          add(&mut files, string(inner));
        }
        break;
      }
    }
  }
  causet_model::js::default_sort(&mut files);
  Ok(files)
}

/// `operationMergeEndpoints(current)`: base, target and source revisions.
fn operation_merge_endpoints(current: Option<&Value>, cwd: &str) -> GitResult<[Option<Value>; 3]> {
  let kind = as_text(get(current, "kind"));
  let parents = get(current, "mergeParents");
  let two = matches!(length(parents), Some(Value::Number(count)) if count == 2.0);
  if kind.as_deref() == Some("recreate-merge") && two {
    let commits = match parents {
      Some(Value::Array(items)) => items
        .iter()
        .map(|parent| match parent {
          Value::Null => Err(GitError::uncoded(
            "Cannot read properties of null (reading 'commit')",
          )),
          other => Ok(js_text(get(Some(other), "commit"))),
        })
        .collect::<GitResult<Vec<String>>>()?,
      other => return Err(not_callable("current.mergeParents", "map", other)),
    };
    let base = engine::merge_base(&commits[0], &commits[1], cwd)?;
    return Ok([
      Some(string(&base)),
      Some(string(&commits[0])),
      Some(string(&commits[1])),
    ]);
  }
  Ok([
    Some(string(&format!(
      "{}^",
      js_text(get(current, "sourceCommit"))
    ))),
    get(current, "targetBefore").cloned(),
    get(current, "sourceCommit").cloned(),
  ])
}

/// `pendingSpecMergeStatus()`.
pub fn pending_spec_merge_status(cwd: &str) -> GitResult<Value> {
  let operation = read_pending_operation(cwd)?;
  let current = get(operation.as_ref(), "current");
  let mut plans = Vec::new();
  if truthy(current) {
    let conflicted = get(current, "conflictedPaths");
    let empty = Value::Array(Vec::new());
    let markdown = spec_files_for_conflict_paths(if nullish(conflicted) {
      Some(&empty)
    } else {
      conflicted
    })?;
    let endpoints = operation_merge_endpoints(current, cwd)?;
    for file in markdown {
      let Value::String(units) = &file else {
        return Err(GitError::node(
          "The \"paths[1]\" argument must be of type string.",
          "ERR_INVALID_ARG_TYPE",
        ));
      };
      plans.push(plan_spec_merge(&lossy(units), endpoints.clone(), cwd)?);
    }
  }
  let mut status = Object::new();
  status.set("active", Value::Bool(!plans.is_empty()));
  let id = get(operation.as_ref(), "id");
  status.set(
    "operationId",
    if nullish(id) {
      Value::Null
    } else {
      id.cloned().unwrap_or(Value::Null)
    },
  );
  status.set(
    "plans",
    Value::Array(plans.iter().map(compact_spec_merge).collect()),
  );
  Ok(Value::Object(status))
}

/// `formatSpecConflict(conflict)`.
fn format_spec_conflict(conflict: &Value) -> String {
  let member = |name: &str| get(Some(conflict), name);
  let label = format!(
    "{}{}",
    js_text(member("type")),
    if truthy(member("title")) {
      format!(": {}", js_text(member("title")))
    } else {
      String::new()
    }
  );
  if as_text(member("type")).as_deref() != Some("parser-migration-required") {
    return label;
  }
  let stages = match member("stages") {
    Some(Value::Array(items)) => String::from_utf16_lossy(&join(items, &js(", "))),
    _ => String::new(),
  };
  format!("{label}: legacy {stages}\n  {}", js_text(member("message")))
}

/// `formatSpecMergeStatus(status)`.
pub fn format_spec_merge_status(status: &Value) -> String {
  if !truthy(get(Some(status), "active")) {
    return "No semantic specification merge is pending.".into();
  }
  let mut lines = vec![format!(
    "operation    {}",
    js_text(get(Some(status), "operationId"))
  )];
  let plans = match get(Some(status), "plans") {
    Some(Value::Array(items)) => items.clone(),
    _ => Vec::new(),
  };
  for plan in &plans {
    let member = |name: &str| get(Some(plan), name);
    lines.push(String::new());
    lines.push(format!("path         {}", js_text(member("path"))));
    lines.push(format!("status       {}", js_text(member("status"))));
    lines.push(format!("signature    {}", short(member("signature"))));
    lines.push(format!("ordering     {}", js_text(member("ordering"))));
    if let Some(Value::Array(conflicts)) = member("conflicts") {
      for conflict in conflicts {
        lines.push(format!("  ! {}", format_spec_conflict(conflict)));
      }
    }
  }
  if plans
    .iter()
    .any(|plan| as_text(get(Some(plan), "status")).as_deref() == Some("clean"))
  {
    lines.push(String::new());
    lines.push("Apply deterministic suggestions with: cst spec resolve --all".into());
  }
  lines.join("\n")
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn slugs_match_javascript_normalization() {
    assert_eq!(slug("Café Ünïcode ﬁx"), "cafe-u-ni-code-fix");
    assert_eq!(slug("  "), "untitled");
    assert_eq!(slug("Ｆｕｌｌ ｗｉｄｔｈ"), "full-width");
    assert_eq!(slug(&"a".repeat(90)), "a".repeat(80));
    assert_eq!(slug("İstanbul"), "i-stanbul");
  }

  #[test]
  fn block_expressions_backtrack_as_javascript_does() {
    let title = |line: &str| heading(line).map(|(level, raw)| (level, heading_title(&raw)));
    assert_eq!(title("# A  ##"), Some((1, "A".into())));
    assert_eq!(title("#\tTabbed"), Some((1, "Tabbed".into())));
    assert_eq!(title("#"), None);
    assert_eq!(title("# "), None);
    assert_eq!(title("####### x"), None);
    assert_eq!(title("### trailing # ##"), Some((3, "trailing #".into())));
    assert_eq!(title("# a\u{2028}b"), None);
    assert_eq!(title("##  two  spaces "), Some((2, "two  spaces".into())));
    assert_eq!(requirement("REQ-ONE: first").as_deref(), Some("REQ-ONE"));
    assert_eq!(
      requirement("  REQ-3.x_y-z :  value").as_deref(),
      Some("REQ-3.x_y-z")
    );
    assert_eq!(requirement("REQ-: x"), None);
    assert_eq!(requirement("REQ-A:"), None);
    assert_eq!(requirement("REQ-A: \u{2028}").as_deref(), Some("REQ-A"));
    assert_eq!(requirement("req-a: x"), None);
  }
}
