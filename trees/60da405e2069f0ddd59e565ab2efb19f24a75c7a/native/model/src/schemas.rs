//! Record classification, compatibility and structural validation, ported from
//! `src/schemas.js`, which stays the authority. The validators follow the
//! JavaScript expressions they port, including where JavaScript throws: a
//! malformed member can make them raise a `TypeError` (#172), and that is
//! reported here as [`Thrown`] until the JavaScript is fixed first (ADR-0037).

use crate::json::{
  JsString, Object, Value, js, lossy, number_to_string, object, string, stringify,
};
use crate::registry::{
  Family, PROVENANCE_ROLE_NAMES, RECORD_FAMILIES, RESOLUTION_SIGNATURE_ALGORITHM, RESOURCE_BOUNDS,
};

pub const SCHEMA_NAMESPACE: &str = "causet.";
pub const LEGACY_SCHEMA_NAMESPACE: &str = "vcs-lab.";

/// Where the JavaScript validator raises instead of returning.
#[derive(Debug, PartialEq, Eq)]
pub struct Thrown;

// ---------------------------------------------------------------------------
// Classification and compatibility
// ---------------------------------------------------------------------------

/// `canonicalSchema`: the `causet.*` spelling a stored schema stands for.
pub fn canonical_schema(schema: &str) -> String {
  match schema.strip_prefix(LEGACY_SCHEMA_NAMESPACE) {
    Some(rest) => format!("{SCHEMA_NAMESPACE}{rest}"),
    None => schema.to_string(),
  }
}

pub fn family(name: &str) -> Option<&'static Family> {
  RECORD_FAMILIES.iter().find(|family| family.name == name)
}

#[derive(Debug, PartialEq)]
pub struct Classification {
  pub known: bool,
  pub family: Option<String>,
  pub version: Option<f64>,
  pub scope: Option<&'static str>,
  pub legacy_name: bool,
}

/// `schemaClassification`; `None` stands for any non-string or empty schema.
pub fn schema_classification(schema: Option<&str>) -> Classification {
  let Some(schema) = schema.filter(|schema| !schema.is_empty()) else {
    return Classification {
      known: false,
      family: None,
      version: None,
      scope: None,
      legacy_name: false,
    };
  };
  let canonical = canonical_schema(schema);
  // `/^(.+)\/v(\d+)$/`: the family is everything before the last `/v<digits>`.
  // `.` matches no line terminator, so a family containing one never matches.
  let parsed = canonical.rfind("/v").and_then(|at| {
    let digits = &canonical[at + 2..];
    let name = &canonical[..at];
    let terminator = name.contains(['\n', '\r', '\u{2028}', '\u{2029}']);
    (at > 0
      && !terminator
      && !digits.is_empty()
      && digits.bytes().all(|byte| byte.is_ascii_digit()))
    .then(|| (name.to_string(), digits.parse::<f64>().expect("digits")))
  });
  // `KNOWN_SCHEMAS` holds exact spellings: `v01` is not `v1` there, although
  // compatibility reads its version as 1.
  let known = parsed.as_ref().and_then(|(name, _)| {
    family(name).filter(|family| {
      family
        .registered
        .iter()
        .any(|v| canonical == format!("{name}/v{v}"))
    })
  });
  Classification {
    known: known.is_some(),
    family: parsed.as_ref().map(|(name, _)| name.clone()),
    version: parsed.map(|(_, version)| version),
    scope: known.map(|family| family.scope),
    legacy_name: canonical != schema,
  }
}

#[derive(Debug, PartialEq)]
pub struct Compatibility {
  pub family: Option<String>,
  pub version: Option<f64>,
  pub policy: Option<&'static Family>,
  pub readable: bool,
  pub migrated: bool,
  pub disposition: &'static str,
}

impl PartialEq for Family {
  fn eq(&self, other: &Self) -> bool {
    self.name == other.name
  }
}

impl std::fmt::Debug for Family {
  fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    formatter.write_str(self.name)
  }
}

/// `schemaCompatibility`.
pub fn schema_compatibility(schema: Option<&str>) -> Compatibility {
  let classification = schema_classification(schema);
  let policy = classification.family.as_deref().and_then(family);
  let (Some(policy), Some(version)) = (policy, classification.version) else {
    return Compatibility {
      family: classification.family,
      version: classification.version,
      policy: None,
      readable: false,
      migrated: false,
      disposition: "unknown-family",
    };
  };
  let has = |versions: &[u32]| versions.iter().any(|v| f64::from(*v) == version);
  let readable = has(policy.readable);
  let migrated = readable && !has(policy.written);
  Compatibility {
    family: classification.family,
    version: Some(version),
    policy: Some(policy),
    readable,
    migrated,
    disposition: if readable {
      if migrated { "migrate" } else { "accept" }
    } else {
      policy.unknown_version
    },
  }
}

/// A refusal as `assertReadableSchema` raises it.
#[derive(Debug, PartialEq, Eq)]
pub struct Refusal {
  pub code: &'static str,
  pub message: String,
  pub details: String,
}

/// `assertReadableSchema`: `Ok` when a reader accepts `schema`.
pub fn assert_readable_schema(
  schema: Option<&str>,
  subject: &str,
  family_name: Option<&str>,
  recovery: &str,
) -> Result<(), Refusal> {
  let compatibility = schema_compatibility(schema);
  let quoted = match schema {
    Some(text) if !text.is_empty() => crate::json::quote(&js(text)),
    _ => "(missing)".into(),
  };
  if let Some(expected) = family_name.filter(|name| !name.is_empty()) {
    if compatibility.family.as_deref() != Some(expected) {
      return Err(Refusal {
        code: "wrong-record-family",
        message: format!("{subject} carries schema {quoted}, not a {expected} record."),
        details: recovery.to_string(),
      });
    }
  }
  if compatibility.readable {
    return Ok(());
  }
  let known = match compatibility.policy {
    Some(policy) => format!(
      "This build reads {} of that family.",
      policy
        .readable
        .iter()
        .map(|v| format!("v{v}"))
        .collect::<Vec<_>>()
        .join(", ")
    ),
    None => "This build does not know that record family.".into(),
  };
  let details = [known.as_str(), recovery]
    .iter()
    .filter(|part| !part.is_empty())
    .copied()
    .collect::<Vec<_>>()
    .join(" ");
  Err(Refusal {
    code: "unknown-schema-version",
    message: format!("{subject} carries unsupported schema {quoted}."),
    details,
  })
}

/// `withinBound`; an unknown bound name is a programming error.
pub fn within_bound(name: &str, actual: u64) -> bool {
  let limit = RESOURCE_BOUNDS
    .iter()
    .find(|(bound, _)| *bound == name)
    .unwrap_or_else(|| panic!("Unknown resource bound '{name}'."))
    .1;
  actual <= limit
}

// ---------------------------------------------------------------------------
// JavaScript value semantics
// ---------------------------------------------------------------------------

/// `value[name]` for a JSON value; `None` is `undefined`.
fn get<'a>(value: Option<&'a Value>, name: &str) -> Option<&'a Value> {
  match value {
    Some(Value::Object(object)) => object.get(name),
    _ => None,
  }
}

/// `value[name]`, which throws only when `value` is `null` or `undefined`.
fn get_strict<'a>(value: Option<&'a Value>, name: &str) -> Result<Option<&'a Value>, Thrown> {
  match value {
    None | Some(Value::Null) => Err(Thrown),
    other => Ok(get(other, name)),
  }
}

fn as_str(value: Option<&Value>) -> Option<&JsString> {
  match value {
    Some(Value::String(units)) => Some(units),
    _ => None,
  }
}

fn is_non_empty_string(value: Option<&Value>) -> bool {
  as_str(value).is_some_and(|units| !units.is_empty())
}

fn equals_str(value: Option<&Value>, text: &str) -> bool {
  as_str(value).is_some_and(|units| *units == js(text))
}

fn one_of(value: Option<&Value>, texts: &[&str]) -> bool {
  texts.iter().any(|text| equals_str(value, text))
}

/// `value && typeof value === "object"` (arrays included).
fn is_object(value: Option<&Value>) -> bool {
  matches!(value, Some(Value::Object(_) | Value::Array(_)))
}

fn is_plain_object(value: Option<&Value>) -> bool {
  matches!(value, Some(Value::Object(_)))
}

fn truthy(value: Option<&Value>) -> bool {
  match value {
    None | Some(Value::Null) => false,
    Some(Value::Bool(flag)) => *flag,
    Some(Value::Number(number)) => *number != 0.0 && !number.is_nan(),
    Some(Value::String(units)) => !units.is_empty(),
    Some(Value::Array(_) | Value::Object(_)) => true,
  }
}

/// `left === right`. Two parsed objects or arrays are never the same object.
fn strict_equals(left: Option<&Value>, right: Option<&Value>) -> bool {
  match (left, right) {
    (None, None) => true,
    (Some(Value::Null), Some(Value::Null)) => true,
    (Some(Value::Bool(a)), Some(Value::Bool(b))) => a == b,
    (Some(Value::Number(a)), Some(Value::Number(b))) => a == b,
    (Some(Value::String(a)), Some(Value::String(b))) => a == b,
    _ => false,
  }
}

/// `(value ?? [])` used as an array: its items, or [`Thrown`] where the
/// JavaScript method call on a non-array would throw.
fn items_or_throw(value: Option<&Value>) -> Result<&[Value], Thrown> {
  match value {
    None | Some(Value::Null) => Ok(&[]),
    Some(Value::Array(items)) => Ok(items),
    Some(_) => Err(Thrown),
  }
}

/// `(value ?? []).includes(needle)`; on a string this is a substring test.
fn includes(value: Option<&Value>, needle: Option<&Value>) -> Result<bool, Thrown> {
  match value {
    None | Some(Value::Null) => Ok(false),
    Some(Value::Array(items)) => Ok(items.iter().any(|item| same_value_zero(Some(item), needle))),
    Some(Value::String(units)) => {
      let needle = to_js_string(needle);
      Ok(
        needle.is_empty()
          || units
            .windows(needle.len())
            .any(|window| window == needle.as_slice()),
      )
    }
    Some(_) => Err(Thrown),
  }
}

fn same_value_zero(left: Option<&Value>, right: Option<&Value>) -> bool {
  match (left, right) {
    (Some(Value::Number(a)), Some(Value::Number(b))) => a == b || (a.is_nan() && b.is_nan()),
    _ => strict_equals(left, right),
  }
}

/// ECMAScript `ToString` of a JSON value.
fn to_js_string(value: Option<&Value>) -> JsString {
  match value {
    None => js("undefined"),
    Some(Value::Null) => js("null"),
    Some(Value::Bool(flag)) => js(if *flag { "true" } else { "false" }),
    Some(Value::Number(number)) => js(&number_to_string(*number)),
    Some(Value::String(units)) => units.clone(),
    Some(Value::Array(items)) => {
      let mut out = Vec::new();
      for (index, item) in items.iter().enumerate() {
        if index > 0 {
          out.push(u16::from(b','));
        }
        if !matches!(item, Value::Null) {
          out.extend(to_js_string(Some(item)));
        }
      }
      out
    }
    Some(Value::Object(_)) => js("[object Object]"),
  }
}

/// `(value ?? []).length > 0`.
fn has_length(value: Option<&Value>) -> bool {
  match value {
    Some(Value::Array(items)) => !items.is_empty(),
    Some(Value::String(units)) => !units.is_empty(),
    _ => false,
  }
}

/// `for (const item of value ?? [])`: an array's items, a string's code points.
fn iterate(value: Option<&Value>) -> Result<Vec<Value>, Thrown> {
  match value {
    None | Some(Value::Null) => Ok(Vec::new()),
    Some(Value::Array(items)) => Ok(items.clone()),
    Some(Value::String(units)) => {
      let mut out = Vec::new();
      let mut index = 0;
      while index < units.len() {
        let pair = matches!(units[index], 0xd800..=0xdbff)
          && matches!(units.get(index + 1), Some(0xdc00..=0xdfff));
        let width = if pair { 2 } else { 1 };
        out.push(Value::String(units[index..index + width].to_vec()));
        index += width;
      }
      Ok(out)
    }
    Some(_) => Err(Thrown),
  }
}

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FieldError {
  pub field: String,
  pub expectation: String,
}

pub fn oid_length(object_format: &str) -> usize {
  if object_format == "sha256" { 64 } else { 40 }
}

/// `isOid`: hexadecimal of the format's length, either case.
pub fn is_oid(value: Option<&Value>, object_format: &str) -> bool {
  as_str(value).is_some_and(|units| {
    units.len() == oid_length(object_format)
      && units
        .iter()
        .all(|unit| char::from_u32(u32::from(*unit)).is_some_and(|c| c.is_ascii_hexdigit()))
  })
}

struct Errors(Vec<FieldError>);

impl Errors {
  fn check(&mut self, condition: bool, field: impl Into<String>, expectation: impl Into<String>) {
    if !condition {
      self.0.push(FieldError {
        field: field.into(),
        expectation: expectation.into(),
      });
    }
  }

  fn oid(&mut self, owner: Option<&Value>, field: &str, format: &str) {
    self.oid_labelled(owner, field, field, format, false);
  }

  fn oid_labelled(
    &mut self,
    owner: Option<&Value>,
    field: &str,
    label: &str,
    format: &str,
    nullable: bool,
  ) {
    let value = get(owner, field);
    let expectation = if nullable {
      format!("{format} OID or null")
    } else {
      format!("{format} OID")
    };
    self.check(
      (nullable && matches!(value, Some(Value::Null))) || is_oid(value, format),
      label,
      expectation,
    );
  }

  fn oid_array(&mut self, owner: Option<&Value>, field: &str, format: &str) {
    let ok = matches!(get(owner, field), Some(Value::Array(items)) if items.iter().all(|item| is_oid(Some(item), format)));
    self.check(ok, field, format!("array of {format} OIDs"));
  }

  fn string_array(&mut self, owner: Option<&Value>, field: &str) {
    let ok = matches!(get(owner, field), Some(Value::Array(items)) if items.iter().all(|item| is_non_empty_string(Some(item))));
    self.check(ok, field, "array of non-empty strings");
  }

  fn non_empty(&mut self, owner: Option<&Value>, field: &str, label: &str) {
    self.check(
      is_non_empty_string(get(owner, field)),
      label,
      "non-empty string",
    );
  }

  fn array(&mut self, owner: Option<&Value>, field: &str) {
    self.check(
      matches!(get(owner, field), Some(Value::Array(_))),
      field,
      "array",
    );
  }

  fn operation(&mut self, owner: Option<&Value>) {
    let ok = as_str(get(owner, "rebaseOperation")).is_some_and(|units| units.len() > 3);
    self.check(ok, "rebaseOperation", "non-empty operation ID");
  }

  fn attachment(&mut self, record: Option<&Value>, field: &str) {
    let attached = get(record, "attachedTo");
    if attached.is_some() && !strict_equals(get(record, field), attached) {
      self.0.push(FieldError {
        field: "attachedTo".into(),
        expectation: format!("same OID as {field}"),
      });
    }
  }
}

fn common(errors: &mut Errors, record: Option<&Value>, expected_type: &str, format: &str) {
  errors.check(is_plain_object(record), "$", "object");
  if !is_plain_object(record) {
    return;
  }
  errors.check(
    as_str(get(record, "schema")).is_some(),
    "schema",
    "versioned schema string",
  );
  errors.check(
    equals_str(get(record, "type"), expected_type),
    "type",
    expected_type,
  );
  errors.check(
    as_str(get(record, "id")).is_some_and(|units| units.len() > 3),
    "id",
    "non-empty record ID",
  );
  if let Some(created) = get(record, "createdAt") {
    let ok = as_str(Some(created)).is_some_and(|units| crate::dates::parses(&lossy(units)));
    errors.check(ok, "createdAt", "ISO-compatible timestamp");
  }
  if let Some(attached) = get(record, "attachedTo") {
    errors.check(
      is_oid(Some(attached), format),
      "attachedTo",
      format!("{format} commit OID"),
    );
  }
}

/// `validateNoteRecord`: the structural faults of one shared note record.
pub fn validate_note_record(
  record: Option<&Value>,
  format: &str,
) -> Result<Vec<FieldError>, Thrown> {
  let schema = as_str(get(record, "schema")).map(|units| canonical_schema(&lossy(units)));
  let classification = schema_classification(schema.as_deref());
  if !classification.known || classification.scope != Some("note-record") {
    return Ok(vec![FieldError {
      field: "schema".into(),
      expectation: "supported causal note record schema".into(),
    }]);
  }
  let schema = schema.expect("classified");
  let mut errors = Errors(Vec::new());
  let e = &mut errors;
  match schema.as_str() {
    "causet.landing/v1" => {
      common(e, record, "landing", format);
      e.check(
        one_of(get(record, "mode"), &["compact", "hard-squash"]),
        "mode",
        "compact or hard-squash",
      );
      for field in [
        "sourceHead",
        "targetBefore",
        "landingCommit",
        "base",
        "resultTree",
      ] {
        e.oid(record, field, format);
      }
      e.oid_array(record, "absorbedCommits", format);
      e.string_array(record, "absorbedChanges");
      e.attachment(record, "landingCommit");
    }
    "causet.application/v1" | "causet.application/v4" => {
      common(e, record, "application", format);
      let mut fields = vec!["originCommit", "appliedCommit", "targetBefore"];
      if schema == "causet.application/v4" {
        fields.extend(["sourceTree", "resultTree"]);
      }
      for field in fields {
        e.oid(record, field, format);
      }
      for field in ["originChangeId", "appliedChangeId", "relation"] {
        e.non_empty(record, field, field);
      }
      e.attachment(record, "appliedCommit");
    }
    "causet.reconciliation/v6" => {
      common(e, record, "reconciliation", format);
      for field in [
        "sourceHead",
        "targetBefore",
        "resultCommit",
        "targetTreeBefore",
        "sourceTree",
        "resultTree",
      ] {
        e.oid(record, field, format);
      }
      e.oid_array(record, "absorbedCommits", format);
      e.string_array(record, "absorbedChanges");
      e.array(record, "applied");
      e.attachment(record, "resultCommit");
    }
    "causet.provenance/v1" => {
      common(e, record, "provenance", format);
      e.oid(record, "commit", format);
      let origin = get(record, "origin");
      e.check(
        one_of(origin, &["declared", "carried"]),
        "origin",
        "declared or carried",
      );
      e.oid_array(record, "carriedFrom", format);
      let change = get(record, "changeId");
      e.check(
        matches!(change, Some(Value::Null)) || is_non_empty_string(change),
        "changeId",
        "non-empty string or null",
      );
      let actors_ok = matches!(get(record, "actors"), Some(Value::Array(actors)) if !actors.is_empty() && actors.iter().all(|actor| {
        is_object(Some(actor)) && one_of(get(Some(actor), "role"), PROVENANCE_ROLE_NAMES) && is_non_empty_string(get(Some(actor), "actor"))
      }));
      e.check(
        actors_ok,
        "actors",
        format!(
          "non-empty array of {{role, actor}} with role in {}",
          PROVENANCE_ROLE_NAMES.join("|")
        ),
      );
      let carried = equals_str(origin, "carried");
      let sources = get(record, "carriedFrom");
      let sources_ok = match sources {
        Some(Value::Array(items)) => {
          if carried {
            !items.is_empty()
          } else {
            items.is_empty()
          }
        }
        _ => false,
      };
      e.check(
        sources_ok,
        "carriedFrom",
        if carried {
          "at least one source commit"
        } else {
          "empty for a declared record"
        },
      );
      e.attachment(record, "commit");
    }
    "causet.rebase-application/v1" => {
      common(e, record, "rebase-application", format);
      for field in [
        "originCommit",
        "appliedCommit",
        "targetBefore",
        "sourceTree",
        "targetBeforeTree",
        "resultTree",
      ] {
        e.oid(record, field, format);
      }
      for field in ["originChangeId", "appliedChangeId", "relation"] {
        e.non_empty(record, field, field);
      }
      e.operation(record);
      e.check(
        one_of(
          get(record, "relation"),
          &["causal-rebase", "contextual-rebase", "contextual-fork"],
        ),
        "relation",
        "supported rebase relation",
      );
      for field in ["conflictedPaths", "resolutions", "semanticMerges"] {
        e.array(record, field);
      }
      e.attachment(record, "appliedCommit");
    }
    "causet.rebase/v1" | "causet.rebase/v2" | "causet.rebase/v3" => {
      common(e, record, "rebase", format);
      for field in [
        "sourceHead",
        "ontoHead",
        "physicalBase",
        "resultCommit",
        "sourceTree",
        "ontoTree",
        "resultTree",
      ] {
        e.oid(record, field, format);
      }
      e.oid_array(record, "absorbedCommits", format);
      e.oid_array(record, "forkedSourceCommits", format);
      e.string_array(record, "absorbedChanges");
      for field in ["omitted", "acceptedCandidates", "applications"] {
        e.array(record, field);
      }
      let fingerprint = as_str(get(record, "planFingerprint")).is_some_and(|units| {
        units.len() == 64
          && units
            .iter()
            .all(|u| char::from_u32(u32::from(*u)).is_some_and(|c| c.is_ascii_hexdigit()))
      });
      e.check(fingerprint, "planFingerprint", "SHA-256 value");
      let base = get(record, "effectiveBase");
      e.check(
        truthy(base) && is_object(base),
        "effectiveBase",
        "base descriptor",
      );
      if truthy(base) && is_object(base) {
        e.oid(base, "commit", format);
      }
      for (index, application) in items_or_throw(get(record, "applications"))?
        .iter()
        .enumerate()
      {
        let application = Some(application);
        e.check(
          is_plain_object(application),
          format!("applications[{index}]"),
          "object",
        );
        if !is_plain_object(application) {
          continue;
        }
        for field in [
          "sourceCommit",
          "appliedCommit",
          "targetBeforeTree",
          "resultTree",
        ] {
          e.oid(application, field, format);
        }
        for field in ["sourceChangeId", "appliedChangeId", "relation"] {
          e.non_empty(
            application,
            field,
            &format!("applications[{index}].{field}"),
          );
        }
      }
      if schema != "causet.rebase/v1" {
        e.array(record, "recreatedMerges");
        for (index, merge) in items_or_throw(get(record, "recreatedMerges"))?
          .iter()
          .enumerate()
        {
          let label = format!("recreatedMerges[{index}]");
          let merge = Some(merge);
          e.check(is_plain_object(merge), label.clone(), "object");
          if !is_plain_object(merge) {
            continue;
          }
          for field in ["originCommit", "resultCommit"] {
            e.oid(merge, field, format);
          }
          for field in ["originChangeId", "changeId"] {
            e.non_empty(merge, field, &format!("{label}.{field}"));
          }
          e.check(
            !strict_equals(get(merge, "changeId"), get(merge, "originChangeId")),
            format!("{label}.changeId"),
            "an identity distinct from the original merge's",
          );
          e.check(
            equals_str(get(merge, "relation"), "recreated-merge"),
            format!("{label}.relation"),
            "recreated-merge",
          );
          e.check(
            matches!(get(merge, "cleanJoin"), Some(Value::Bool(_))),
            format!("{label}.cleanJoin"),
            "boolean",
          );
          e.check(
            matches!(get(merge, "resolutions"), Some(Value::Array(_))),
            format!("{label}.resolutions"),
            "array",
          );
          let parents = get(merge, "parents");
          e.check(
            matches!(parents, Some(Value::Array(items)) if items.len() == 2),
            format!("{label}.parents"),
            "exactly two parents",
          );
          for (position, parent) in items_or_throw(parents)?.iter().enumerate() {
            let parent = Some(parent);
            e.check(
              is_plain_object(parent),
              format!("{label}.parents[{position}]"),
              "object",
            );
            if is_plain_object(parent) {
              e.oid(parent, "commit", format);
            }
          }
          let absorbed = includes(get(record, "absorbedCommits"), get(merge, "originCommit"))?;
          e.check(
            !absorbed,
            format!("{label}.originCommit"),
            "a commit the receipt does not absorb",
          );
        }
      }
      e.attachment(record, "resultCommit");
    }
    "causet.amendment/v1" => {
      common(e, record, "amendment", format);
      for field in ["commit", "originCommit", "treeBefore", "treeAfter"] {
        e.oid(record, field, format);
      }
      e.non_empty(record, "changeId", "changeId");
      e.check(
        !strict_equals(get(record, "treeBefore"), get(record, "treeAfter")),
        "treeAfter",
        "a tree different from treeBefore",
      );
      e.operation(record);
      e.attachment(record, "commit");
    }
    "causet.interactive-absorption/v1" => {
      common(e, record, "interactive-absorption", format);
      e.oid(record, "survivingCommit", format);
      e.oid_array(record, "absorbedCommits", format);
      e.string_array(record, "absorbedChanges");
      e.non_empty(record, "survivingChangeId", "survivingChangeId");
      e.check(
        one_of(get(record, "action"), &["squash", "fixup"]),
        "action",
        "squash or fixup",
      );
      let survivor_absorbed = includes(
        get(record, "absorbedChanges"),
        get(record, "survivingChangeId"),
      )?;
      e.check(
        !survivor_absorbed,
        "absorbedChanges",
        "identities other than the survivor's",
      );
      e.check(
        has_length(get(record, "absorbedCommits")),
        "absorbedCommits",
        "at least one absorbed commit",
      );
      e.operation(record);
      e.attachment(record, "survivingCommit");
    }
    "causet.resolution/v1" => {
      common(e, record, "resolution", format);
      e.check(
        equals_str(get(record, "algorithm"), RESOLUTION_SIGNATURE_ALGORITHM),
        "algorithm",
        RESOLUTION_SIGNATURE_ALGORITHM,
      );
      let signature = as_str(get(record, "signature")).is_some_and(|units| {
        let text = lossy(units);
        text.len() == 69
          && text
            .get(..5)
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case("rsig_"))
          && text[5..].bytes().all(|byte| byte.is_ascii_hexdigit())
      });
      e.check(signature, "signature", "rsig_ SHA-256 value");
      for side in ["base", "ours", "theirs"] {
        let value = get(record, side);
        e.check(
          matches!(value, Some(Value::Null)) || (truthy(value) && is_object(value)),
          side,
          "stage object or null",
        );
        if truthy(value) {
          e.oid(value, "blob", format);
        }
      }
      e.oid_labelled(record, "resultBlob", "resultBlob", format, true);
      e.oid(record, "resolutionCommit", format);
      let reference = as_str(get(record, "ref")).is_some_and(|units| {
        let text = lossy(units);
        text.starts_with("refs/causet/resolutions/")
          || text.starts_with("refs/vcs-lab/resolutions/")
      });
      e.check(reference, "ref", "resolution retention ref");
      e.attachment(record, "resolutionCommit");
    }
    _ => {}
  }
  Ok(errors.0)
}

// ---------------------------------------------------------------------------
// Referenced objects and resolution signatures
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObjectReference {
  pub oid: JsString,
  pub kind: &'static str,
  pub field: String,
}

/// `referencedObjectsForRecord`: every object a record names, in its order.
pub fn referenced_objects(record: Option<&Value>) -> Result<Vec<ObjectReference>, Thrown> {
  let schema = as_str(get_strict(record, "schema")?).map(|units| canonical_schema(&lossy(units)));
  let mut objects = Vec::new();
  let mut add = |value: Option<&Value>, kind: &'static str, field: &str| {
    if let Some(units) = as_str(value) {
      objects.push(ObjectReference {
        oid: units.clone(),
        kind,
        field: field.to_string(),
      });
    }
  };
  let schema = schema.unwrap_or_default();
  match schema.as_str() {
    "causet.landing/v1" => {
      for field in ["sourceHead", "targetBefore", "landingCommit", "base"] {
        add(get(record, field), "commit", field);
      }
      for oid in iterate(get(record, "absorbedCommits"))? {
        add(Some(&oid), "commit", "absorbedCommits");
      }
      add(get(record, "resultTree"), "tree", "resultTree");
    }
    "causet.application/v1" | "causet.application/v4" => {
      for field in ["originCommit", "appliedCommit", "targetBefore"] {
        add(get(record, field), "commit", field);
      }
      if schema == "causet.application/v4" {
        for field in ["sourceTree", "resultTree"] {
          add(get(record, field), "tree", field);
        }
      }
    }
    "causet.reconciliation/v6" => {
      for field in ["sourceHead", "targetBefore", "resultCommit"] {
        add(get(record, field), "commit", field);
      }
      for oid in iterate(get(record, "absorbedCommits"))? {
        add(Some(&oid), "commit", "absorbedCommits");
      }
      for field in ["targetTreeBefore", "sourceTree", "resultTree"] {
        add(get(record, field), "tree", field);
      }
    }
    "causet.rebase-application/v1" => {
      for field in ["originCommit", "appliedCommit", "targetBefore"] {
        add(get(record, field), "commit", field);
      }
      for field in ["sourceTree", "targetBeforeTree", "resultTree"] {
        add(get(record, field), "tree", field);
      }
    }
    "causet.rebase/v1" | "causet.rebase/v2" | "causet.rebase/v3" => {
      for field in ["sourceHead", "ontoHead", "physicalBase", "resultCommit"] {
        add(get(record, field), "commit", field);
      }
      for merge in iterate(get(record, "recreatedMerges"))? {
        let merge = Some(&merge);
        add(
          get_strict(merge, "originCommit")?,
          "commit",
          "recreatedMerges.originCommit",
        );
        add(
          get(merge, "resultCommit"),
          "commit",
          "recreatedMerges.resultCommit",
        );
        for parent in iterate(get(merge, "parents"))? {
          add(
            get_strict(Some(&parent), "commit")?,
            "commit",
            "recreatedMerges.parents.commit",
          );
        }
      }
      add(
        get(get(record, "effectiveBase"), "commit"),
        "commit",
        "effectiveBase.commit",
      );
      for oid in iterate(get(record, "absorbedCommits"))? {
        add(Some(&oid), "commit", "absorbedCommits");
      }
      for application in iterate(get(record, "applications"))? {
        let application = Some(&application);
        add(
          get_strict(application, "sourceCommit")?,
          "commit",
          "applications.sourceCommit",
        );
        add(
          get(application, "appliedCommit"),
          "commit",
          "applications.appliedCommit",
        );
        add(
          get(application, "targetBeforeTree"),
          "tree",
          "applications.targetBeforeTree",
        );
        add(
          get(application, "resultTree"),
          "tree",
          "applications.resultTree",
        );
      }
      for field in ["sourceTree", "ontoTree", "resultTree"] {
        add(get(record, field), "tree", field);
      }
    }
    "causet.amendment/v1" => {
      for field in ["commit", "originCommit"] {
        add(get(record, field), "commit", field);
      }
      for field in ["treeBefore", "treeAfter"] {
        add(get(record, field), "tree", field);
      }
    }
    "causet.interactive-absorption/v1" => {
      add(get(record, "survivingCommit"), "commit", "survivingCommit");
      for oid in iterate(get(record, "absorbedCommits"))? {
        add(Some(&oid), "commit", "absorbedCommits");
      }
    }
    "causet.provenance/v1" => {
      add(get(record, "commit"), "commit", "commit");
      for oid in iterate(get(record, "carriedFrom"))? {
        add(Some(&oid), "commit", "carriedFrom");
      }
    }
    "causet.resolution/v1" => {
      add(
        get(record, "resolutionCommit"),
        "commit",
        "resolutionCommit",
      );
      for field in ["base", "ours", "theirs"] {
        add(
          get(get(record, field), "blob"),
          "blob",
          &format!("{field}.blob"),
        );
      }
      add(get(record, "resultBlob"), "blob", "resultBlob");
    }
    _ => {}
  }
  Ok(objects)
}

/// `resolutionSignatureFor(stages)`.
pub fn resolution_signature(stages: Option<&Value>) -> Result<String, Thrown> {
  let stage = |name: &str| -> Result<Value, Thrown> {
    Ok(match get_strict(stages, name)? {
      None | Some(Value::Null) => Value::Null,
      Some(value) => value.clone(),
    })
  };
  let document = object([
    ("algorithm", string(RESOLUTION_SIGNATURE_ALGORITHM)),
    ("base", stage("base")?),
    ("ours", stage("ours")?),
    ("theirs", stage("theirs")?),
  ]);
  Ok(format!(
    "rsig_{}",
    crate::sha256::hex(stringify(&document).as_bytes())
  ))
}

pub fn empty_object() -> Value {
  Value::Object(Object::new())
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::json::parse;

  #[test]
  fn a_legacy_spelling_classifies_as_its_current_family() {
    let current = schema_classification(Some("causet.landing/v1"));
    let legacy = schema_classification(Some("vcs-lab.landing/v1"));
    assert!(legacy.legacy_name && legacy.known);
    assert_eq!(legacy.family, current.family);
    assert_eq!(
      schema_compatibility(Some("vcs-lab.rebase/v1")).disposition,
      "migrate"
    );
    assert_eq!(
      schema_compatibility(Some("causet.nope/v1")).disposition,
      "unknown-family"
    );
  }

  #[test]
  fn a_malformed_member_throws_where_javascript_throws() {
    let record =
      parse(r#"{"schema":"causet.rebase/v3","type":"rebase","id":"rebase_x","applications":"x"}"#)
        .unwrap();
    assert_eq!(validate_note_record(Some(&record), "sha1"), Err(Thrown));
    let record = parse(r#"{"schema":"causet.rebase/v3","applications":[null]}"#).unwrap();
    assert_eq!(referenced_objects(Some(&record)), Err(Thrown));
  }

  #[test]
  fn resolution_signatures_hash_the_stages_as_json_stringify_writes_them() {
    assert_eq!(
      resolution_signature(Some(&empty_object())).unwrap(),
      format!(
        "rsig_{}",
        crate::sha256::hex(
          br#"{"algorithm":"ordered-three-way-blobs/v1","base":null,"ours":null,"theirs":null}"#
        )
      )
    );
  }
}
