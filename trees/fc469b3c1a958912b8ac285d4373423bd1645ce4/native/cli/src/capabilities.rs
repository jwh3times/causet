//! `cst capabilities` and `cst capabilities --against`, as
//! `src/capabilities.js` and the formatters in `src/cli.js` answer them
//! (ADR-0033). A peer document is untrusted JSON, so every member is read
//! with JavaScript semantics, including the few places where the JavaScript
//! raises a `TypeError` instead of a refusal.

use crate::envelope::{ENVELOPE_MANIFEST, METADATA_ENVELOPE_SCHEMA, read_envelope};
use crate::lineage::{lineage_relation, repository_lineage};
use causet_engine::engine;
use causet_engine::errors::{GitError, GitResult};
use causet_engine::text;
use causet_model::canonical::{CANONICAL_JSON_PROFILE, hashed_payload};
use causet_model::ids::LOGICAL_ID_PROFILE;
use causet_model::js::{
  default_sort, get, join, locale_compare, nullish, numeric_sort, same_value_zero, strict_equals,
  text as js_text, truthy,
};
use causet_model::json::{Object, Value, js, lossy, parse, string};
use causet_model::registry::{
  ERROR_ENVELOPE_SCHEMA, EXCHANGE_FEATURES, EXCHANGED_SCOPES, METADATA_LINEAGE_ALGORITHM,
  RECORD_FAMILIES, RESOLUTION_SIGNATURE_ALGORITHM, RESOURCE_BOUNDS,
};
use causet_model::schemas::{
  LEGACY_SCHEMA_NAMESPACE, SCHEMA_NAMESPACE, assert_readable_schema, canonical_schema,
};

pub const CAPABILITIES_SCHEMA: &str = "causet.capabilities/v1";
pub const CAPABILITY_REPORT_SCHEMA: &str = "causet.capability-report/v1";
const OBJECT_FORMATS: [&str; 2] = ["sha1", "sha256"];
const ADVERTISED_BOUNDS: [&str; 8] = [
  "noteContainerBytes",
  "noteContainerRecords",
  "envelopeManifestBytes",
  "envelopeBundleBytes",
  "envelopeRecords",
  "provenanceActors",
  "capabilityDocumentBytes",
  "proofBundleBytes",
];

fn number(value: f64) -> Value {
  Value::Number(value)
}

fn strings(items: &[&str]) -> Value {
  Value::Array(items.iter().map(|item| string(item)).collect())
}

fn versions(items: &[u32]) -> Value {
  let mut sorted = items.to_vec();
  sorted.sort_unstable();
  Value::Array(
    sorted
      .into_iter()
      .map(|version| number(f64::from(version)))
      .collect(),
  )
}

fn bound(name: &str) -> u64 {
  RESOURCE_BOUNDS
    .iter()
    .find(|(bound, _)| *bound == name)
    .map_or(0, |(_, limit)| *limit)
}

fn items(value: Option<&Value>) -> &[Value] {
  match value {
    Some(Value::Array(items)) => items,
    _ => &[],
  }
}

fn as_str(value: Option<&Value>) -> String {
  match value {
    Some(Value::String(units)) => lossy(units),
    _ => String::new(),
  }
}

/// `canonicalSchema(value)` on any JSON value: only a string is rewritten.
fn canonical_value(value: Option<&Value>) -> Option<Value> {
  match value {
    Some(Value::String(units)) => Some(string(&canonical_schema(&lossy(units)))),
    other => other.cloned(),
  }
}

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

/// `capabilityDocument()`: what this build reads and writes, repository-scoped
/// inside a repository.
pub fn capability_document(cwd: &str) -> GitResult<Value> {
  let exchanged: Vec<_> = RECORD_FAMILIES
    .iter()
    .filter(|family| EXCHANGED_SCOPES.contains(&family.scope))
    .collect();
  let mut families: Vec<(&str, Value)> = exchanged
    .iter()
    .map(|family| {
      let mut entry = Object::new();
      entry.set("family", string(family.name));
      entry.set("scope", string(family.scope));
      entry.set("written", versions(family.written));
      entry.set("readable", versions(family.readable));
      entry.set("unknownVersion", string(family.unknown_version));
      (family.name, Value::Object(entry))
    })
    .collect();
  families.sort_by(|left, right| locale_compare(left.0, right.0));
  let mut aliases: Vec<(String, Value)> = exchanged
    .iter()
    .map(|family| {
      let spelling = format!(
        "{LEGACY_SCHEMA_NAMESPACE}{}",
        &family.name[SCHEMA_NAMESPACE.len()..]
      );
      let mut entry = Object::new();
      entry.set("spelling", string(&spelling));
      entry.set("family", string(family.name));
      entry.set("access", string("read"));
      (spelling, Value::Object(entry))
    })
    .collect();
  aliases.sort_by(|left, right| locale_compare(&left.0, &right.0));
  let mut features: Vec<&str> = EXCHANGE_FEATURES.to_vec();
  features.sort_by(|left, right| text::compare(left, right));
  let mut bound_names = ADVERTISED_BOUNDS.to_vec();
  bound_names.sort_by(|left, right| text::compare(left, right));
  let mut bounds = Object::new();
  for name in bound_names {
    bounds.set(name, number(bound(name) as f64));
  }
  let mut producer = Object::new();
  producer.set("name", string("causet"));
  producer.set("version", string(crate::VERSION));
  let mut profiles = Object::new();
  profiles.set("canonicalJson", string(CANONICAL_JSON_PROFILE));
  profiles.set("logicalId", string(LOGICAL_ID_PROFILE));
  profiles.set("errorEnvelope", string(ERROR_ENVELOPE_SCHEMA));
  let mut algorithms = Object::new();
  algorithms.set("lineage", string(METADATA_LINEAGE_ALGORITHM));
  algorithms.set(
    "resolutionSignature",
    string(RESOLUTION_SIGNATURE_ALGORITHM),
  );
  algorithms.set("integrity", string("sha256"));

  let mut document = Object::new();
  document.set("schema", string(CAPABILITIES_SCHEMA));
  document.set("producer", Value::Object(producer));
  document.set(
    "families",
    Value::Array(families.into_iter().map(|(_, entry)| entry).collect()),
  );
  document.set(
    "aliases",
    Value::Array(aliases.into_iter().map(|(_, entry)| entry).collect()),
  );
  document.set("profiles", Value::Object(profiles));
  document.set("algorithms", Value::Object(algorithms));
  document.set("objectFormats", strings(&OBJECT_FORMATS));
  document.set("features", strings(&features));
  document.set("bounds", Value::Object(bounds));
  if let Some(repository) = repository_scope(cwd)? {
    document.set("repository", repository);
  }
  let hash = hashed_payload(&Value::Object(document.clone()))
    .map(|bytes| causet_model::sha256::hex(bytes.as_bytes()))
    .map_err(|error| {
      GitError::new(
        "malformed-input",
        "Capability document is not representable in the canonical JSON profile.",
      )
      .details(error.to_string())
    })?;
  let mut integrity = Object::new();
  integrity.set("algorithm", string("sha256"));
  integrity.set("documentHash", string(&hash));
  document.set("integrity", Value::Object(integrity));
  Ok(Value::Object(document))
}

/// `repositoryScope(cwd)`: the repository members, or none outside one.
fn repository_scope(cwd: &str) -> GitResult<Option<Value>> {
  let Ok(context) = engine::repo_context(cwd) else {
    return Ok(None);
  };
  let mut scope = Object::new();
  scope.set("objectFormat", string(&context.object_format));
  scope.set("lineage", repository_lineage(&context.root)?);
  Ok(Some(Value::Object(scope)))
}

// ---------------------------------------------------------------------------
// Reading a peer's statement
// ---------------------------------------------------------------------------

/// `readPeerCapabilities(target)`: the normalized peer document and where it
/// came from.
fn read_peer_capabilities(target: &str) -> GitResult<(&'static str, Value)> {
  let resolved = text::resolve_path(target);
  let metadata = match std::fs::metadata(&resolved) {
    Ok(metadata) => metadata,
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
      return Err(GitError::new(
        "not-found",
        format!("No capability document or envelope at '{resolved}'."),
      ));
    }
    Err(error) => return Err(crate::envelope::io_failure(&error, "stat", &resolved)),
  };
  if metadata.is_dir() {
    return peer_from_envelope(&resolved);
  }
  let limit = bound("capabilityDocumentBytes");
  if metadata.len() > limit {
    return Err(
      GitError::new(
        "resource-bound-exceeded",
        format!(
          "Capability document '{resolved}' exceeds the capabilityDocumentBytes bound of {limit}."
        ),
      )
      .details(
        "The bound is checked before the document is parsed; see docs/schemas/compatibility.md.",
      ),
    );
  }
  let parsed = std::fs::read(&resolved)
    .ok()
    .and_then(|raw| parse(&String::from_utf8_lossy(&raw)).ok())
    .ok_or_else(|| {
      GitError::new(
        "malformed-input",
        format!("Capability document '{resolved}' is not valid JSON."),
      )
    })?;
  if !matches!(parsed, Value::Object(_)) {
    return Err(GitError::new(
      "malformed-input",
      format!("Capability document '{resolved}' is not a JSON object."),
    ));
  }
  let schema = match get(Some(&parsed), "schema") {
    Some(Value::String(units)) => Some(lossy(units)),
    _ => None,
  };
  assert_readable_schema(
    schema.as_deref(),
    &format!("The capability document at '{resolved}'"),
    Some("causet.capabilities"),
    "Ask the peer for a version this build reads, or upgrade this build.",
  )
  .map_err(|refusal| GitError::new(refusal.code, refusal.message).details(refusal.details))?;
  Ok(("document", normalize_peer(&parsed)))
}

/// `peerFromEnvelope(directory)`: what an envelope manifest states.
fn peer_from_envelope(directory: &str) -> GitResult<(&'static str, Value)> {
  let manifest_path = text::join(directory, ENVELOPE_MANIFEST);
  if !std::path::Path::new(&manifest_path).exists() {
    return Err(
      GitError::new(
        "not-found",
        format!("'{directory}' is a directory but holds no {ENVELOPE_MANIFEST}."),
      )
      .details("Give a capability document, or a metadata envelope directory."),
    );
  }
  let manifest = read_envelope(directory)?;
  let capabilities = get(Some(&manifest), "capabilities");
  let mut features: Vec<Value> = match capabilities {
    Some(Value::Array(items)) => items.clone(),
    Some(Value::String(units)) => String::from_utf16_lossy(units)
      .chars()
      .map(|c| string(&c.to_string()))
      .collect(),
    value if nullish(value) => Vec::new(),
    _ => {
      return Err(GitError::uncoded(
        "(envelope.manifest.capabilities ?? []) is not iterable",
      ));
    }
  };
  default_sort(&mut features);
  let mut document = Object::new();
  document.set("schema", string(CAPABILITIES_SCHEMA));
  if let Some(producer) = get(Some(&manifest), "producer") {
    document.set("producer", producer.clone());
  }
  if let Some(repository) = get(Some(&manifest), "repository") {
    document.set("repository", repository.clone());
  }
  document.set("features", Value::Array(features));
  document.set("statedBy", string(METADATA_ENVELOPE_SCHEMA));
  Ok(("envelope", normalize_peer(&Value::Object(document))))
}

/// `normalizePeer(document)`: what the peer did not state, kept distinct from
/// what it stated as empty.
fn normalize_peer(document: &Value) -> Value {
  let member = |name: &str| get(Some(document), name);
  let is_array = |name: &str| matches!(member(name), Some(Value::Array(_)));
  let mut normalized = match document {
    Value::Object(object) => object.clone(),
    _ => Object::new(),
  };
  let mut stated = Object::new();
  stated.set("families", Value::Bool(is_array("families")));
  stated.set("profiles", Value::Bool(truthy(member("profiles"))));
  stated.set("algorithms", Value::Bool(truthy(member("algorithms"))));
  stated.set("bounds", Value::Bool(truthy(member("bounds"))));
  stated.set("objectFormats", Value::Bool(is_array("objectFormats")));
  stated.set("features", Value::Bool(is_array("features")));
  stated.set("repository", Value::Bool(truthy(member("repository"))));
  normalized.set("stated", Value::Object(stated));
  let families = items(member("families"))
    .iter()
    .map(|entry| {
      // `{ ...entry, family }`: only a plain object's named members survive
      // a spread in a way anything below can read.
      let mut copy = match entry {
        Value::Object(object) => object.clone(),
        _ => Object::new(),
      };
      match canonical_value(get(Some(entry), "family")) {
        Some(family) => copy.set("family", family),
        None => copy.remove("family"),
      }
      Value::Object(copy)
    })
    .collect();
  normalized.set("families", Value::Array(families));
  normalized.set("features", Value::Array(items(member("features")).to_vec()));
  normalized.set(
    "objectFormats",
    Value::Array(items(member("objectFormats")).to_vec()),
  );
  Value::Object(normalized)
}

// ---------------------------------------------------------------------------
// Negotiation
// ---------------------------------------------------------------------------

/// `sortedVersions(versions)`: `[...versions].sort((left, right) => left - right)`.
fn sorted_versions(value: Option<&Value>) -> GitResult<Vec<Value>> {
  let mut spread = match value {
    Some(Value::Array(items)) => items.clone(),
    Some(Value::String(units)) => String::from_utf16_lossy(units)
      .chars()
      .map(|c| string(&c.to_string()))
      .collect(),
    value if nullish(value) => Vec::new(),
    _ => return Err(GitError::uncoded("versions is not iterable")),
  };
  numeric_sort(&mut spread);
  Ok(spread)
}

fn includes(haystack: &[Value], needle: &Value) -> bool {
  haystack
    .iter()
    .any(|item| same_value_zero(Some(item), Some(needle)))
}

fn max_number(values: &[Value]) -> Value {
  values
    .iter()
    .map(causet_model::js::to_number)
    .fold(None, |best: Option<f64>, value| {
      Some(match best {
        None => value,
        Some(best) if best.is_nan() || value.is_nan() => f64::NAN,
        Some(best) => best.max(value),
      })
    })
    .map_or(Value::Null, number)
}

fn compare_repository(local: &Value, peer: &Value) -> GitResult<Value> {
  let local_repository = get(Some(local), "repository");
  let peer_repository = get(Some(peer), "repository");
  if !truthy(local_repository) || !truthy(peer_repository) {
    return Ok(Value::Null);
  }
  let relation = lineage_relation(
    get(peer_repository, "lineage"),
    get(local_repository, "lineage"),
  )?;
  let lineage_id = |repository: Option<&Value>| match get(repository, "lineage") {
    None => Err(GitError::uncoded(
      "Cannot read properties of undefined (reading 'id')",
    )),
    Some(Value::Null) => Err(GitError::uncoded(
      "Cannot read properties of null (reading 'id')",
    )),
    lineage => Ok(get(lineage, "id").cloned()),
  };
  let mut comparison = Object::new();
  if let Some(format) = get(local_repository, "objectFormat") {
    comparison.set("localObjectFormat", format.clone());
  }
  if let Some(format) = get(peer_repository, "objectFormat") {
    comparison.set("peerObjectFormat", format.clone());
  }
  comparison.set(
    "objectFormatAgreed",
    Value::Bool(strict_equals(
      get(local_repository, "objectFormat"),
      get(peer_repository, "objectFormat"),
    )),
  );
  if let Some(id) = lineage_id(local_repository)? {
    comparison.set("localLineage", id);
  }
  if let Some(id) = lineage_id(peer_repository)? {
    comparison.set("peerLineage", id);
  }
  comparison.set("lineageRelation", string(relation));
  comparison.set("admitted", Value::Bool(matches!(relation, "same" | "fork")));
  Ok(Value::Object(comparison))
}

fn compare_families(local: &Value, peer: &Value, stated: bool) -> GitResult<Value> {
  let peer_families = items(get(Some(peer), "families"));
  let mut compared = Vec::new();
  for entry in items(get(Some(local), "families")) {
    let family = get(Some(entry), "family");
    // A `Map` keyed by `family`: the last entry of a repeated key wins.
    let other = peer_families
      .iter()
      .rev()
      .find(|candidate| same_value_zero(get(Some(candidate), "family"), family));
    let peer_readable = sorted_versions(get(other, "readable"))?;
    let peer_written = sorted_versions(get(other, "written"))?;
    let written = items(get(Some(entry), "written"));
    let readable = items(get(Some(entry), "readable"));
    let sendable: Vec<Value> = written
      .iter()
      .filter(|version| includes(&peer_readable, version))
      .cloned()
      .collect();
    let unreadable: Vec<Value> = written
      .iter()
      .filter(|version| !includes(&peer_readable, version))
      .cloned()
      .collect();
    let receivable: Vec<Value> = peer_written
      .iter()
      .filter(|version| includes(readable, version))
      .cloned()
      .collect();
    let status = if !stated {
      "peer-not-stated"
    } else if other.is_none() {
      "peer-unknown-family"
    } else if sendable.is_empty() {
      "blocked"
    } else if unreadable.is_empty() {
      "compatible"
    } else {
      "reduced"
    };
    let mut result = Object::new();
    result.set("family", family.cloned().unwrap_or(Value::Null));
    result.set(
      "scope",
      get(Some(entry), "scope").cloned().unwrap_or(Value::Null),
    );
    result.set("localWritten", Value::Array(written.to_vec()));
    result.set("localReadable", Value::Array(readable.to_vec()));
    result.set("peerWritten", Value::Array(peer_written));
    result.set("peerReadable", Value::Array(peer_readable));
    result.set("selectedForSend", max_number(&sendable));
    result.set("selectedForReceive", max_number(&receivable));
    result.set("unreadableByPeer", Value::Array(unreadable));
    result.set(
      "peerDisposition",
      get(other, "unknownVersion")
        .filter(|value| !matches!(value, Value::Null))
        .cloned()
        .unwrap_or(Value::Null),
    );
    result.set("status", string(status));
    compared.push(Value::Object(result));
  }
  Ok(Value::Array(compared))
}

fn object_entries(value: Option<&Value>) -> Vec<(String, Value)> {
  match value {
    Some(Value::Object(object)) => object
      .keys()
      .into_iter()
      .map(|key| {
        (
          lossy(key),
          object.get_units(key).cloned().unwrap_or(Value::Null),
        )
      })
      .collect(),
    _ => Vec::new(),
  }
}

fn sorted_by_name(mut entries: Vec<(String, Value)>) -> Value {
  entries.sort_by(|left, right| locale_compare(&left.0, &right.0));
  Value::Array(entries.into_iter().map(|(_, entry)| entry).collect())
}

/// `compareNamed(localGroup, peerGroup, stated)`.
fn compare_named(local_group: Option<&Value>, peer_group: Option<&Value>, stated: bool) -> Value {
  let entries = object_entries(local_group)
    .into_iter()
    .map(|(name, value)| {
      let peer_value = get(peer_group, &name);
      let mut entry = Object::new();
      entry.set("name", string(&name));
      entry.set("local", value.clone());
      entry.set(
        "peer",
        if stated {
          peer_value
            .filter(|value| !matches!(value, Value::Null))
            .cloned()
            .unwrap_or(Value::Null)
        } else {
          Value::Null
        },
      );
      entry.set("stated", Value::Bool(stated));
      entry.set(
        "agreed",
        Value::Bool(!stated || strict_equals(canonical_value(peer_value).as_ref(), Some(&value))),
      );
      (name, Value::Object(entry))
    })
    .collect();
  sorted_by_name(entries)
}

fn compare_object_formats(local: &Value, peer: &Value, stated: bool) -> Value {
  let mut local_formats = items(get(Some(local), "objectFormats")).to_vec();
  default_sort(&mut local_formats);
  let peer_formats = items(get(Some(peer), "objectFormats"));
  let mut result = Object::new();
  result.set("local", Value::Array(local_formats));
  if stated {
    let mut sorted = peer_formats.to_vec();
    default_sort(&mut sorted);
    result.set("peer", Value::Array(sorted));
    let mut common: Vec<Value> = items(get(Some(local), "objectFormats"))
      .iter()
      .filter(|format| includes(peer_formats, format))
      .cloned()
      .collect();
    default_sort(&mut common);
    result.set("common", Value::Array(common));
  } else {
    result.set("peer", Value::Null);
    result.set("common", Value::Null);
  }
  result.set("stated", Value::Bool(stated));
  Value::Object(result)
}

/// A `Set` of the values, in first-insertion order.
fn unique(values: &[Value]) -> Vec<Value> {
  let mut out: Vec<Value> = Vec::new();
  for value in values {
    let repeated = !matches!(value, Value::Array(_) | Value::Object(_))
      && out
        .iter()
        .any(|seen| same_value_zero(Some(seen), Some(value)));
    if !repeated {
      out.push(value.clone());
    }
  }
  out
}

fn compare_features(local: &Value, peer: &Value, stated: bool) -> Value {
  let local_features = unique(items(get(Some(local), "features")));
  let peer_features = unique(items(get(Some(peer), "features")));
  let sorted = |mut values: Vec<Value>| {
    default_sort(&mut values);
    Value::Array(values)
  };
  let mut result = Object::new();
  result.set("stated", Value::Bool(stated));
  result.set(
    "common",
    sorted(
      local_features
        .iter()
        .filter(|token| includes(&peer_features, token))
        .cloned()
        .collect(),
    ),
  );
  result.set(
    "localOnly",
    sorted(
      local_features
        .iter()
        .filter(|token| !includes(&peer_features, token))
        .cloned()
        .collect(),
    ),
  );
  result.set(
    "peerOnly",
    sorted(
      peer_features
        .iter()
        .filter(|token| !includes(&local_features, token))
        .cloned()
        .collect(),
    ),
  );
  Value::Object(result)
}

fn compare_bounds(local: &Value, peer: &Value, stated: bool) -> Value {
  let peer_bounds = get(Some(peer), "bounds");
  let entries = object_entries(get(Some(local), "bounds"))
    .into_iter()
    .map(|(name, value)| {
      let sending = get(peer_bounds, &name);
      let mut entry = Object::new();
      entry.set("name", string(&name));
      entry.set("receiving", value);
      entry.set(
        "sending",
        if stated {
          sending
            .filter(|value| !matches!(value, Value::Null))
            .cloned()
            .unwrap_or(Value::Null)
        } else {
          Value::Null
        },
      );
      entry.set("stated", Value::Bool(stated && sending.is_some()));
      (name, Value::Object(entry))
    })
    .collect();
  sorted_by_name(entries)
}

/// `negotiate(local, peer, { source })`.
fn negotiate(local: &Value, peer: &Value, source: &str) -> GitResult<Value> {
  let stated = get(Some(peer), "stated");
  let flag = |name: &str| truthy(get(stated, name));
  let mut local_summary = Object::new();
  local_summary.set(
    "producer",
    get(Some(local), "producer").cloned().unwrap_or(Value::Null),
  );
  local_summary.set(
    "repositoryScoped",
    Value::Bool(truthy(get(Some(local), "repository"))),
  );
  let mut peer_summary = Object::new();
  peer_summary.set("source", string(source));
  peer_summary.set(
    "producer",
    get(Some(peer), "producer")
      .filter(|value| !matches!(value, Value::Null))
      .cloned()
      .unwrap_or(Value::Null),
  );
  peer_summary.set(
    "statedBy",
    get(Some(peer), "statedBy")
      .filter(|value| !matches!(value, Value::Null))
      .cloned()
      .unwrap_or_else(|| string(CAPABILITIES_SCHEMA)),
  );
  peer_summary.set(
    "repositoryScoped",
    Value::Bool(truthy(get(Some(peer), "repository"))),
  );
  peer_summary.set("statedFamilies", Value::Bool(flag("families")));
  peer_summary.set("statedProfiles", Value::Bool(flag("profiles")));
  peer_summary.set("statedBounds", Value::Bool(flag("bounds")));
  let mut report = Object::new();
  report.set("schema", string(CAPABILITY_REPORT_SCHEMA));
  report.set("local", Value::Object(local_summary));
  report.set("peer", Value::Object(peer_summary));
  report.set("repository", compare_repository(local, peer)?);
  report.set("families", compare_families(local, peer, flag("families"))?);
  report.set(
    "profiles",
    compare_named(
      get(Some(local), "profiles"),
      get(Some(peer), "profiles"),
      flag("profiles"),
    ),
  );
  report.set(
    "algorithms",
    compare_named(
      get(Some(local), "algorithms"),
      get(Some(peer), "algorithms"),
      flag("algorithms"),
    ),
  );
  report.set(
    "objectFormats",
    compare_object_formats(local, peer, flag("objectFormats")),
  );
  report.set("features", compare_features(local, peer, flag("features")));
  report.set("bounds", compare_bounds(local, peer, flag("bounds")));
  Ok(Value::Object(report))
}

// ---------------------------------------------------------------------------
// What makes an exchange impossible, rather than smaller
// ---------------------------------------------------------------------------

fn js_join(values: Option<&Value>, separator: &str) -> String {
  String::from_utf16_lossy(&join(items(values), &js(separator)))
}

/// `assertExchangePossible(report)`: refuse what cannot happen, and summarize
/// the rest.
fn assert_exchange_possible(report: Value) -> GitResult<Value> {
  let repository = get(Some(&report), "repository");
  if truthy(repository) && !truthy(get(repository, "objectFormatAgreed")) {
    return Err(
      GitError::new(
        "repository-mismatch",
        format!(
          "The peer repository uses object format '{}', not '{}'.",
          js_text(get(repository, "peerObjectFormat")),
          js_text(get(repository, "localObjectFormat"))
        ),
      )
      .details("Git object formats are not interchangeable; no exchange between them is possible."),
    );
  }
  if truthy(repository) && !truthy(get(repository, "admitted")) {
    return Err(
      GitError::new(
        "repository-mismatch",
        format!(
          "The peer repository lineage is {}; an exchange requires the same repository or an ordinary fork of it.",
          js_text(get(repository, "lineageRelation"))
        ),
      )
      .details(format!(
        "Local lineage {}, peer lineage {}.",
        js_text(get(repository, "localLineage")),
        js_text(get(repository, "peerLineage"))
      )),
    );
  }
  for (group, singular) in [("profiles", "profile"), ("algorithms", "algorithm")] {
    for entry in items(get(Some(&report), group)) {
      let entry = Some(entry);
      if truthy(get(entry, "stated")) && !truthy(get(entry, "agreed")) {
        let peer = match get(entry, "peer") {
          value if nullish(value) => "(missing)".to_string(),
          value => js_text(value),
        };
        return Err(
          GitError::new(
            "no-common-version",
            format!(
              "The peer states {singular} {} as '{peer}', not '{}'.",
              js_text(get(entry, "name")),
              js_text(get(entry, "local"))
            ),
          )
          .details(
            "Every hash and identifier in an exchange is read under these, so a disagreement leaves nothing both sides would read the same way.",
          ),
        );
      }
    }
  }
  let families = items(get(Some(&report), "families"));
  let own = families
    .iter()
    .find(|entry| as_str(get(Some(entry), "family")) == "causet.capabilities");
  if let Some(own) = own
    && as_str(get(Some(own), "status")) == "blocked"
  {
    let peer_reads = js_join(get(Some(own), "peerReadable"), ", ");
    return Err(
      GitError::new(
        "no-common-version",
        format!(
          "The peer reads no {} version this build writes (writes {}; peer reads {}).",
          js_text(get(Some(own), "family")),
          js_join(get(Some(own), "localWritten"), ", "),
          if peer_reads.is_empty() {
            "none".to_string()
          } else {
            peer_reads
          }
        ),
      )
      .details("Negotiation itself needs a document both sides can read. Upgrade one side."),
    );
  }
  Ok(summarize(report))
}

fn summarize(report: Value) -> Value {
  let families = items(get(Some(&report), "families"));
  let status = |entry: &Value| as_str(get(Some(entry), "status"));
  let counted: Vec<&Value> = families
    .iter()
    .filter(|entry| status(entry) != "peer-not-stated")
    .collect();
  let reduced: Vec<&Value> = counted
    .iter()
    .copied()
    .filter(|entry| status(entry) == "reduced")
    .collect();
  let blocked: Vec<&Value> = counted
    .iter()
    .copied()
    .filter(|entry| matches!(status(entry).as_str(), "blocked" | "peer-unknown-family"))
    .collect();
  let mut blockers: Vec<(String, Value)> = blocked
    .iter()
    .map(|entry| {
      let subject = as_str(get(Some(entry), "family"));
      let kind = status(entry);
      let detail = if kind == "peer-unknown-family" {
        "the peer does not advertise this family".to_string()
      } else {
        format!(
          "the peer reads none of {}",
          js_join(get(Some(entry), "localWritten"), ", ")
        )
      };
      let mut blocker = Object::new();
      blocker.set("kind", string(&kind));
      blocker.set("subject", string(&subject));
      blocker.set("detail", string(&detail));
      (subject, Value::Object(blocker))
    })
    .collect();
  blockers.sort_by(|left, right| locale_compare(&left.0, &right.0));
  let mut reductions: Vec<(String, Value)> = reduced
    .iter()
    .map(|entry| {
      let subject = as_str(get(Some(entry), "family"));
      let mut reduction = Object::new();
      reduction.set("subject", string(&subject));
      reduction.set(
        "unreadableByPeer",
        get(Some(entry), "unreadableByPeer")
          .cloned()
          .unwrap_or(Value::Null),
      );
      reduction.set(
        "selectedForSend",
        get(Some(entry), "selectedForSend")
          .cloned()
          .unwrap_or(Value::Null),
      );
      (subject, Value::Object(reduction))
    })
    .collect();
  reductions.sort_by(|left, right| locale_compare(&left.0, &right.0));
  let mut summary = Object::new();
  summary.set("families", number(counted.len() as f64));
  summary.set("reducedFamilies", number(reduced.len() as f64));
  summary.set("blockedFamilies", number(blocked.len() as f64));
  summary.set("exchangeable", Value::Bool(true));
  summary.set(
    "fullyCompatible",
    Value::Bool(reduced.is_empty() && blocked.is_empty()),
  );
  summary.set(
    "blockers",
    Value::Array(blockers.into_iter().map(|(_, blocker)| blocker).collect()),
  );
  summary.set(
    "reductions",
    Value::Array(
      reductions
        .into_iter()
        .map(|(_, reduction)| reduction)
        .collect(),
    ),
  );
  let mut result = match report {
    Value::Object(object) => object,
    _ => Object::new(),
  };
  result.set("summary", Value::Object(summary));
  Value::Object(result)
}

/// `negotiateAgainst(target)`: this build's document, the peer's, and what
/// the two conclude.
pub fn negotiate_against(target: &str, cwd: &str) -> GitResult<Value> {
  let local = capability_document(cwd)?;
  let (source, peer) = read_peer_capabilities(target)?;
  assert_exchange_possible(negotiate(&local, &peer, source)?)
}

// ---------------------------------------------------------------------------
// Human renderings (`formatCapabilities`, `formatCapabilityReport`)
// ---------------------------------------------------------------------------

fn pad_end(text: &str, width: usize) -> String {
  let length = text.encode_utf16().count();
  format!("{text}{}", " ".repeat(width.saturating_sub(length)))
}

fn versions_text(values: Option<&Value>) -> String {
  js_join(values, ", v")
}

pub fn format_capabilities(document: &Value) -> String {
  let member = |path: &[&str]| {
    path
      .iter()
      .fold(Some(document), |value, name| get(value, name))
  };
  let text = |path: &[&str]| js_text(member(path));
  let repository = member(&["repository"]);
  let mut lines = vec![
    "Capabilities".to_string(),
    format!("schema       {}", text(&["schema"])),
    format!(
      "producer     {} {}",
      text(&["producer", "name"]),
      text(&["producer", "version"])
    ),
    format!(
      "scope        {}",
      if truthy(repository) {
        "repository"
      } else {
        "build"
      }
    ),
  ];
  if truthy(repository) {
    lines.push(format!(
      "repository   {}; lineage {}",
      text(&["repository", "objectFormat"]),
      text(&["repository", "lineage", "id"])
    ));
  }
  let families = items(member(&["families"]));
  lines.push(format!("families     {} exchanged", families.len()));
  lines.push(format!(
    "profiles     canonical JSON {}; identity {}; errors {}",
    text(&["profiles", "canonicalJson"]),
    text(&["profiles", "logicalId"]),
    text(&["profiles", "errorEnvelope"])
  ));
  lines.push(format!(
    "algorithms   lineage {}; resolution {}; integrity {}",
    text(&["algorithms", "lineage"]),
    text(&["algorithms", "resolutionSignature"]),
    text(&["algorithms", "integrity"])
  ));
  lines.push(format!(
    "formats      {}",
    js_join(member(&["objectFormats"]), ", ")
  ));
  lines.push(format!(
    "features     {}",
    js_join(member(&["features"]), ", ")
  ));
  lines.push(format!(
    "integrity    {} {}",
    text(&["integrity", "algorithm"]),
    text(&["integrity", "documentHash"])
  ));
  lines.push(String::new());
  for entry in families {
    let written = items(get(Some(entry), "written"));
    let also: Vec<Value> = items(get(Some(entry), "readable"))
      .iter()
      .filter(|version| !includes(written, version))
      .cloned()
      .collect();
    let writes = versions_text(get(Some(entry), "written"));
    lines.push(format!(
      "  {} writes v{}{}; unknown: {} ({})",
      pad_end(&js_text(get(Some(entry), "family")), 30),
      if writes.is_empty() {
        "-".to_string()
      } else {
        writes
      },
      if also.is_empty() {
        String::new()
      } else {
        format!("; also reads v{}", versions_text(Some(&Value::Array(also))))
      },
      js_text(get(Some(entry), "unknownVersion")),
      js_text(get(Some(entry), "scope"))
    ));
  }
  lines.push(String::new());
  lines.push("Bounds a peer must respect when sending to this build".into());
  for (name, value) in object_entries(member(&["bounds"])) {
    lines.push(format!(
      "  {} {}",
      pad_end(&name, 26),
      js_text(Some(&value))
    ));
  }
  lines.join("\n")
}

pub fn format_capability_report(report: &Value) -> String {
  let member = |path: &[&str]| {
    path
      .iter()
      .fold(Some(report), |value, name| get(value, name))
  };
  let text = |path: &[&str]| js_text(member(path));
  let producer = member(&["peer", "producer"]);
  let mut lines = vec![
    "Capability negotiation".to_string(),
    format!(
      "peer         {} via {}",
      if truthy(producer) {
        format!(
          "{} {}",
          js_text(get(producer, "name")),
          js_text(get(producer, "version"))
        )
      } else {
        "(unnamed)".to_string()
      },
      text(&["peer", "source"])
    ),
    format!(
      "compatible   {}; exchange is possible",
      if truthy(member(&["summary", "fullyCompatible"])) {
        "fully"
      } else {
        "partially"
      }
    ),
  ];
  if truthy(member(&["repository"])) {
    lines.push(format!(
      "repository   {}; {} both sides",
      text(&["repository", "lineageRelation"]),
      text(&["repository", "localObjectFormat"])
    ));
  } else {
    lines.push("repository   not compared; one side is build-scoped".into());
  }
  lines.push(format!(
    "families     {} compared, {} reduced, {} blocked",
    text(&["summary", "families"]),
    text(&["summary", "reducedFamilies"]),
    text(&["summary", "blockedFamilies"])
  ));
  if !truthy(member(&["peer", "statedFamilies"])) {
    lines.push("             the peer document states no families, so none were compared".into());
  }
  lines.push(format!(
    "features     {} shared; {} local only, {} peer only",
    items(member(&["features", "common"])).len(),
    items(member(&["features", "localOnly"])).len(),
    items(member(&["features", "peerOnly"])).len()
  ));
  for entry in items(member(&["families"])) {
    let entry = Some(entry);
    let status = as_str(get(entry, "status"));
    if status == "compatible" {
      continue;
    }
    let disposition = get(entry, "peerDisposition");
    let detail = match status.as_str() {
      "reduced" => format!(
        "sends v{}; peer cannot read v{} ({})",
        js_text(get(entry, "selectedForSend")),
        versions_text(get(entry, "unreadableByPeer")),
        js_text(disposition)
      ),
      "blocked" => format!(
        "peer reads none of v{} ({})",
        versions_text(get(entry, "localWritten")),
        if nullish(disposition) {
          "unstated".to_string()
        } else {
          js_text(disposition)
        }
      ),
      "peer-unknown-family" => "the peer does not advertise it".to_string(),
      _ => "not stated by the peer".to_string(),
    };
    lines.push(format!(
      "  {} {}: {detail}",
      if status == "reduced" { "?" } else { "!" },
      js_text(get(entry, "family"))
    ));
  }
  for token in items(member(&["features", "localOnly"])) {
    lines.push(format!(
      "  ? feature {}: withheld, the peer does not advertise it",
      js_text(Some(token))
    ));
  }
  lines.join("\n")
}
