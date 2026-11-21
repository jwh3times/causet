//! Repository lineage, as `src/metadata.js` states and compares it
//! (`repositoryLineage`, `lineageIdentityId`, `lineageRelation`).

use causet_engine::engine;
use causet_engine::errors::{GitError, GitResult};
use causet_model::canonical::canonical_json;
use causet_model::js::{get, nullish, same_value_zero, strict_equals};
use causet_model::json::{Object, Value, string};
use causet_model::registry::METADATA_LINEAGE_ALGORITHM;

/// `lineageIdentityId(identity)`: the id a stated identity must carry.
pub fn lineage_identity_id(identity: &Value) -> GitResult<String> {
  let mut hashed = Object::new();
  for name in ["algorithm", "objectFormat", "rootCommits"] {
    if let Some(value) = get(Some(identity), name) {
      hashed.set(name, value.clone());
    }
  }
  let bytes =
    canonical_json(&Value::Object(hashed)).map_err(|error| GitError::uncoded(error.to_string()))?;
  Ok(format!(
    "lineage_{}",
    causet_model::sha256::hex(bytes.as_bytes())
  ))
}

/// `repositoryLineage(cwd)`.
pub fn repository_lineage(cwd: &str) -> GitResult<Value> {
  let context = engine::repo_context(cwd)?;
  let mut identity = Object::new();
  identity.set("algorithm", string(METADATA_LINEAGE_ALGORITHM));
  identity.set("objectFormat", string(&context.object_format));
  identity.set(
    "rootCommits",
    Value::Array(
      engine::root_commits(cwd)?
        .iter()
        .map(|root| string(root))
        .collect(),
    ),
  );
  let id = lineage_identity_id(&Value::Object(identity.clone()))?;
  identity.set("id", string(&id));
  Ok(Value::Object(identity))
}

/// `lineageRelation(source, destination)`: `same`, `fork`, `unrelated` or
/// `incompatible`. A source whose `rootCommits` is neither an array nor
/// absent fails as the JavaScript `.some` call does.
pub fn lineage_relation(
  source: Option<&Value>,
  destination: Option<&Value>,
) -> GitResult<&'static str> {
  let algorithm = string(METADATA_LINEAGE_ALGORITHM);
  if !strict_equals(get(source, "algorithm"), Some(&algorithm))
    || !strict_equals(get(destination, "algorithm"), Some(&algorithm))
    || !strict_equals(
      get(source, "objectFormat"),
      get(destination, "objectFormat"),
    )
  {
    return Ok("incompatible");
  }
  if strict_equals(get(source, "id"), get(destination, "id")) {
    return Ok("same");
  }
  let destination_roots: Vec<&Value> = match get(destination, "rootCommits") {
    Some(Value::Array(items)) => items.iter().collect(),
    _ => Vec::new(),
  };
  let source_roots = get(source, "rootCommits");
  let roots: &[Value] = match source_roots {
    Some(Value::Array(items)) => items,
    value if nullish(value) => &[],
    _ => {
      return Err(GitError::uncoded(
        "(source.rootCommits ?? []).some is not a function",
      ));
    }
  };
  Ok(
    if roots.iter().any(|root| {
      destination_roots
        .iter()
        .any(|other| same_value_zero(Some(root), Some(other)))
    }) {
      "fork"
    } else {
      "unrelated"
    },
  )
}
