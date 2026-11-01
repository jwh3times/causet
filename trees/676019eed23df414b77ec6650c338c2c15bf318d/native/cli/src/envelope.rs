//! Reading a metadata envelope, as `readEnvelope` in
//! `src/metadata-envelope.js` validates one: every check in its order, with
//! the same refusals. A regular-expression test coerces its input with
//! `ToString`, as `RegExp.prototype.test` does.

use causet_engine::errors::{GitError, GitResult};
use causet_engine::text;
use causet_model::canonical::hashed_payload;
use causet_model::js::{get, strict_equals, to_js_string, truthy};
use causet_model::json::{Value, lossy, number_to_string, parse};
use causet_model::registry::RESOURCE_BOUNDS;
use causet_model::schemas::canonical_schema;

pub const ENVELOPE_MANIFEST: &str = "manifest.json";
pub const ENVELOPE_BUNDLE: &str = "objects.bundle";
pub const METADATA_ENVELOPE_SCHEMA: &str = "causet.metadata-envelope/v1";
const NOTE_REFS: [&str; 2] = ["refs/notes/causet", "refs/notes/vcs-lab"];
const RESOLUTION_REF_PREFIXES: [&str; 2] =
  ["refs/causet/resolutions/", "refs/vcs-lab/resolutions/"];

fn bound(name: &str) -> u64 {
  RESOURCE_BOUNDS
    .iter()
    .find(|(bound, _)| *bound == name)
    .map_or(0, |(_, limit)| *limit)
}

fn malformed(message: &str) -> GitError {
  GitError::new("malformed-input", message)
}

fn as_text(value: Option<&Value>) -> Option<String> {
  match value {
    Some(Value::String(units)) => Some(lossy(units)),
    _ => None,
  }
}

/// `validRef(ref)`.
fn valid_ref(value: Option<&Value>) -> bool {
  let Some(name) = as_text(value) else {
    return false;
  };
  name.starts_with("refs/")
    && !name.chars().any(|c| (c as u32) <= 0x20 || c as u32 == 0x7f)
    && !['~', '^', ':', '?', '*', '[', '\\']
      .iter()
      .any(|c| name.contains(*c))
    && !name.contains("..")
    && !name.contains("@{")
    && !name.ends_with('.')
    && !name.ends_with('/')
    && !name.contains("//")
}

/// `isOid(value, objectFormat)`.
pub fn is_oid(value: Option<&Value>, format: &str) -> bool {
  let width = if format == "sha256" { 64 } else { 40 };
  as_text(value)
    .is_some_and(|text| text.len() == width && text.bytes().all(|byte| byte.is_ascii_hexdigit()))
}

/// `/^[0-9a-f]{64}$/i.test(value)`, which coerces `value` to a string.
fn is_sha256_text(value: Option<&Value>) -> bool {
  let units = to_js_string(value);
  units.len() == 64
    && units
      .iter()
      .all(|unit| (*unit as u8 as u16 == *unit) && (*unit as u8).is_ascii_hexdigit())
}

/// `manifestHash(value)`.
pub(crate) fn manifest_hash(manifest: &Value) -> GitResult<String> {
  hashed_payload(manifest)
    .map(|bytes| causet_model::sha256::hex(bytes.as_bytes()))
    .map_err(|error| {
      GitError::new(
        "malformed-input",
        "Metadata envelope manifest is not representable in the canonical JSON profile.",
      )
      .details(error.to_string())
    })
}

/// `validateManifestShape(manifest)`.
fn validate_manifest_shape(manifest: &Value) -> GitResult<()> {
  let manifest_ref = Some(manifest);
  if !matches!(manifest, Value::Object(_)) {
    return Err(malformed(
      "Metadata envelope manifest must be a JSON object.",
    ));
  }
  let schema = get(manifest_ref, "schema");
  let canonical = as_text(schema).map(|text| canonical_schema(&text));
  if canonical.as_deref() != Some(METADATA_ENVELOPE_SCHEMA) {
    let shown = match schema {
      None | Some(Value::Null) => "(missing)".to_string(),
      other => lossy(&to_js_string(other)),
    };
    return Err(GitError::new(
      "unknown-schema-version",
      format!("Unsupported metadata envelope schema '{shown}'."),
    ));
  }
  let refs = match get(manifest_ref, "refs") {
    Some(Value::Array(items)) => items,
    _ => {
      return Err(malformed(
        "Metadata envelope manifest has invalid refs or records.",
      ));
    }
  };
  let records = match get(manifest_ref, "records") {
    Some(Value::Array(items)) => items,
    _ => {
      return Err(malformed(
        "Metadata envelope manifest has invalid refs or records.",
      ));
    }
  };
  let repository = get(manifest_ref, "repository");
  if !truthy(get(repository, "objectFormat")) || !truthy(get(repository, "lineage")) {
    return Err(malformed(
      "Metadata envelope manifest has no repository lineage.",
    ));
  }
  let format = match as_text(get(repository, "objectFormat")) {
    Some(format) if format == "sha1" || format == "sha256" => format,
    _ => {
      return Err(malformed(
        "Metadata envelope declares an unsupported Git object format.",
      ));
    }
  };
  let roots_valid = match get(get(repository, "lineage"), "rootCommits") {
    Some(Value::Array(roots)) => roots.iter().all(|root| is_oid(Some(root), &format)),
    _ => false,
  };
  if !roots_valid {
    return Err(malformed(
      "Metadata envelope has malformed lineage anchors.",
    ));
  }
  let mut logical = Vec::new();
  let mut bundled = Vec::new();
  for entry in refs {
    let entry = Some(entry);
    let name = as_text(get(entry, "ref"));
    let supported = name.as_deref().is_some_and(|name| {
      NOTE_REFS.contains(&name)
        || RESOLUTION_REF_PREFIXES
          .iter()
          .any(|prefix| name.starts_with(prefix))
    });
    if !truthy(entry)
      || !valid_ref(get(entry, "ref"))
      || !valid_ref(get(entry, "bundleRef"))
      || !is_oid(get(entry, "oid"), &format)
      || !supported
    {
      return Err(malformed(
        "Metadata envelope contains an invalid or unsupported ref entry.",
      ));
    }
    let name = name.unwrap_or_default();
    let bundle = as_text(get(entry, "bundleRef")).unwrap_or_default();
    if logical.contains(&name) || bundled.contains(&bundle) {
      return Err(malformed("Metadata envelope contains duplicate refs."));
    }
    logical.push(name);
    bundled.push(bundle);
  }
  if records.len() as u64 > bound("envelopeRecords") {
    return Err(GitError::new(
      "resource-bound-exceeded",
      "Metadata envelope record inventory exceeds the supported limit.",
    ));
  }
  for record in records {
    let record = Some(record);
    let is_string = |name: &str| matches!(get(record, name), Some(Value::String(_)));
    if !truthy(record)
      || !is_string("id")
      || !is_string("schema")
      || !is_string("type")
      || !is_oid(get(record, "attachment"), &format)
      || !is_sha256_text(get(record, "digest"))
    {
      return Err(malformed(
        "Metadata envelope contains a malformed record inventory entry.",
      ));
    }
    let reference = get(record, "ref");
    if !matches!(reference, Some(Value::Null)) {
      let resolution = as_text(reference).is_some_and(|name| {
        RESOLUTION_REF_PREFIXES
          .iter()
          .any(|prefix| name.starts_with(prefix))
      });
      if !valid_ref(reference) || !resolution {
        return Err(malformed(
          "Metadata envelope contains a malformed resolution record ref.",
        ));
      }
    }
  }
  let integrity = get(manifest_ref, "integrity");
  let algorithm_ok = strict_equals(
    get(integrity, "algorithm"),
    Some(&causet_model::json::string("sha256")),
  );
  if !algorithm_ok
    || !strict_equals(
      get(integrity, "manifestHash"),
      Some(&causet_model::json::string(&manifest_hash(manifest)?)),
    )
  {
    return Err(GitError::new(
      "integrity-check-failed",
      "Metadata envelope manifest integrity check failed.",
    ));
  }
  Ok(())
}

/// Node's description of a non-string `path` argument.
fn received(value: Option<&Value>) -> String {
  match value {
    None => "Received undefined".into(),
    Some(Value::Null) => "Received null".into(),
    Some(Value::Bool(flag)) => format!("Received type boolean ({flag})"),
    Some(Value::Number(number)) => {
      let shown = if *number == 0.0 && number.is_sign_negative() {
        "-0".to_string()
      } else {
        number_to_string(*number)
      };
      format!("Received type number ({shown})")
    }
    Some(Value::Array(_)) => "Received an instance of Array".into(),
    Some(Value::Object(_)) => "Received an instance of Object".into(),
    Some(Value::String(_)) => unreachable!("a string is a valid path"),
  }
}

/// A Node `fs` error: its code, and `<code>: <description>, <syscall> '<path>'`.
pub fn io_failure(error: &std::io::Error, syscall: &str, path: &str) -> GitError {
  let (code, description) = match error.kind() {
    std::io::ErrorKind::IsADirectory => ("EISDIR", "illegal operation on a directory"),
    std::io::ErrorKind::PermissionDenied => ("EACCES", "permission denied"),
    std::io::ErrorKind::NotADirectory => ("ENOTDIR", "not a directory"),
    std::io::ErrorKind::NotFound => ("ENOENT", "no such file or directory"),
    std::io::ErrorKind::AlreadyExists => ("EEXIST", "file already exists"),
    _ => ("EIO", "i/o error"),
  };
  // A read of an open descriptor names no path.
  let target = if syscall == "read" {
    String::new()
  } else {
    format!(" '{path}'")
  };
  GitError::node(format!("{code}: {description}, {syscall}{target}"), code)
}

/// `readEnvelope(envelopePath)`: the validated manifest.
pub fn read_envelope(envelope_path: &str) -> GitResult<Value> {
  let directory = text::resolve_path(envelope_path);
  let manifest_path = text::join(&directory, ENVELOPE_MANIFEST);
  let not_found = || {
    GitError::new(
      "not-found",
      format!("Metadata envelope not found at '{directory}'."),
    )
  };
  let size = match std::fs::metadata(&manifest_path) {
    Ok(metadata) => metadata.len(),
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Err(not_found()),
    Err(error) => {
      return Err(io_failure(&error, "stat", &manifest_path));
    }
  };
  if size > bound("envelopeManifestBytes") {
    return Err(GitError::new(
      "resource-bound-exceeded",
      "Metadata envelope manifest exceeds the supported size limit.",
    ));
  }
  let raw = match std::fs::read(&manifest_path) {
    Ok(raw) => raw,
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Err(not_found()),
    Err(error) => return Err(io_failure(&error, "read", &manifest_path)),
  };
  let manifest = parse(&String::from_utf8_lossy(&raw))
    .map_err(|_| malformed("Metadata envelope manifest is not valid JSON."))?;
  validate_manifest_shape(&manifest)?;
  let payload = get(Some(&manifest), "payload");
  if truthy(payload) {
    let file = match get(payload, "file") {
      Some(Value::String(units)) => lossy(units),
      other => {
        return Err(GitError::node(
          format!(
            "The \"path\" argument must be of type string. {}",
            received(other)
          ),
          "ERR_INVALID_ARG_TYPE",
        ));
      }
    };
    let bundle_path = text::join(&directory, &file);
    let bundle_exists = std::path::Path::new(&text::resolve_path(&bundle_path)).exists();
    if file != ENVELOPE_BUNDLE || !bundle_exists {
      return Err(malformed("Metadata envelope payload is missing."));
    }
    let declared = get(payload, "bytes");
    let safe = match declared {
      Some(Value::Number(number)) => {
        number.fract() == 0.0 && number.abs() <= 9_007_199_254_740_991.0
      }
      _ => false,
    };
    let bytes = match declared {
      Some(Value::Number(number)) => *number,
      _ => f64::NAN,
    };
    if !safe
      || bytes < 0.0
      || bytes > bound("envelopeBundleBytes") as f64
      || !is_sha256_text(get(payload, "sha256"))
    {
      return Err(malformed(
        "Metadata envelope payload declaration is invalid or too large.",
      ));
    }
    let integrity = || {
      GitError::new(
        "integrity-check-failed",
        "Metadata envelope payload integrity check failed.",
      )
    };
    let size = std::fs::metadata(&bundle_path)
      .map_err(|error| io_failure(&error, "stat", &bundle_path))?
      .len();
    if size as f64 != bytes {
      return Err(integrity());
    }
    let content =
      std::fs::read(&bundle_path).map_err(|error| io_failure(&error, "read", &bundle_path))?;
    // Strict equality: the regular expression above coerced the value, this
    // comparison does not.
    let actual = causet_model::json::string(&causet_model::sha256::hex(&content));
    if content.len() as f64 != bytes || !strict_equals(Some(&actual), get(payload, "sha256")) {
      return Err(integrity());
    }
  } else {
    let refs =
      matches!(get(Some(&manifest), "refs"), Some(Value::Array(items)) if !items.is_empty());
    let records =
      matches!(get(Some(&manifest), "records"), Some(Value::Array(items)) if !items.is_empty());
    if refs || records {
      return Err(malformed(
        "Metadata envelope declares records without a Git payload.",
      ));
    }
  }
  Ok(manifest)
}
