//! `cst metadata export <directory>`: `exportMetadata` of
//! `src/metadata-transfer.js` with the manifest of `src/metadata-envelope.js`.

use crate::envelope::{ENVELOPE_BUNDLE, ENVELOPE_MANIFEST, METADATA_ENVELOPE_SCHEMA, io_failure, manifest_hash};
use crate::metadata::{full_snapshot, trust_state};
use crate::notes_write::{build_retention_commit, record_dependencies};
use causet_engine::errors::{GitError, GitResult};
use causet_engine::locations::{CURRENT_NAMES, local_ref, names};
use causet_engine::process::{RunOptions, run_git};
use causet_engine::{engine, metrics, text};
use causet_model::canonical::legacy_canonical_json;
use causet_model::js::{get, locale_compare, nullish, text as js_text};
use causet_model::json::{Object, Value, string, stringify_pretty};
use causet_model::registry::EXCHANGE_FEATURES;

/// `DETERMINISTIC_CARRIER_ENV`: envelope carriers hash the same everywhere.
const DETERMINISTIC_ENV: [(&str, &str); 6] = [
  ("GIT_AUTHOR_NAME", "causet metadata envelope"),
  ("GIT_AUTHOR_EMAIL", "metadata-envelope@example.invalid"),
  ("GIT_AUTHOR_DATE", "2000-01-01T00:00:00Z"),
  ("GIT_COMMITTER_NAME", "causet metadata envelope"),
  ("GIT_COMMITTER_EMAIL", "metadata-envelope@example.invalid"),
  ("GIT_COMMITTER_DATE", "2000-01-01T00:00:00Z"),
];
const MAX_COMMIT_PARENTS: usize = 64;

fn sha256(bytes: &[u8]) -> String {
  causet_model::sha256::hex(bytes)
}

fn git(args: &[&str], cwd: &str, env: &[(String, String)], input: Option<Vec<u8>>) -> GitResult<String> {
  let mut options = RunOptions::new(cwd);
  options.env = env.to_vec();
  options.input = input;
  let args: Vec<String> = args.iter().map(|arg| (*arg).to_string()).collect();
  Ok(run_git(&args, &options)?.stdout)
}

/// `groupRecords(entries)`: records by attachment, in first-seen attachment
/// order, each group ordered by creation time, id, then canonical bytes.
fn group_records(entries: &[(String, Value, String)]) -> Vec<(String, Vec<Value>)> {
  let mut grouped: Vec<(String, Vec<Value>)> = Vec::new();
  for (attachment, record, _) in entries {
    match grouped.iter_mut().find(|(known, _)| known == attachment) {
      Some((_, records)) => records.push(record.clone()),
      None => grouped.push((attachment.clone(), vec![record.clone()])),
    }
  }
  let field = |record: &Value, name: &str| match get(Some(record), name) {
    value if nullish(value) => String::new(),
    value => js_text(value),
  };
  for (_, records) in &mut grouped {
    records.sort_by(|left, right| {
      locale_compare(&field(left, "createdAt"), &field(right, "createdAt"))
        .then_with(|| locale_compare(&field(left, "id"), &field(right, "id")))
        .then_with(|| locale_compare(&legacy_canonical_json(left), &legacy_canonical_json(right)))
    });
  }
  grouped
}

/// `temporaryDirectory(prefix)`: a fresh directory under the system temporary
/// root, in canonical form.
fn temporary_directory(prefix: &str) -> GitResult<String> {
  let root = std::env::temp_dir();
  for attempt in 0..100u32 {
    let suffix = causet_model::ids::new_id("t").map_err(GitError::uncoded)?;
    let candidate = root.join(format!("{prefix}{}{attempt}", &suffix[suffix.len() - 6..]));
    match std::fs::create_dir(&candidate) {
      Ok(()) => {
        let real = std::fs::canonicalize(&candidate).unwrap_or(candidate);
        let text = real.to_string_lossy().into_owned();
        return Ok(text.strip_prefix(r"\\?\").map(str::to_string).unwrap_or(text));
      }
      Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
      Err(error) => {
        return Err(io_failure(&error, "mkdtemp", &candidate.to_string_lossy()));
      }
    }
  }
  Err(GitError::uncoded("Could not create a temporary directory."))
}

/// `buildNotesCommit(entries, cwd, { message, deterministic, parents })`,
/// through a temporary index.
fn build_notes_commit(entries: &[(String, Value, String)], cwd: &str, message: &str, parents: &[String]) -> GitResult<String> {
  let temporary = temporary_directory("vlab-metadata-index-")?;
  let mut env: Vec<(String, String)> = vec![("GIT_INDEX_FILE".into(), text::join(&temporary, "index"))];
  env.extend(DETERMINISTIC_ENV.iter().map(|(name, value)| ((*name).to_string(), (*value).to_string())));
  let result = (|| -> GitResult<String> {
    git(&["read-tree", "--empty"], cwd, &env, None)?;
    for (attachment, records) in group_records(entries) {
      let mut note = Object::new();
      note.set("schema", string("causet.note/v1"));
      note.set("records", Value::Array(records));
      let body = format!("{}\n", stringify_pretty(&Value::Object(note)));
      let blob = git(&["hash-object", "-w", "--stdin"], cwd, &env, Some(body.into_bytes()))?;
      let path = format!("{}/{}", &attachment[..2], &attachment[2..]);
      git(&["update-index", "--add", "--cacheinfo", "100644", &blob, &path], cwd, &env, None)?;
    }
    let tree = git(&["write-tree"], cwd, &env, None)?;
    // `collapseCommitParents`: no sorting, only deduplication and layering.
    let mut layer: Vec<String> = Vec::new();
    for parent in parents {
      if !layer.contains(parent) {
        layer.push(parent.clone());
      }
    }
    let mut depth = 0;
    while layer.len() > MAX_COMMIT_PARENTS {
      let mut next = Vec::new();
      for (index, group) in layer.chunks(MAX_COMMIT_PARENTS).enumerate() {
        let mut args = vec!["commit-tree", tree.as_str()];
        for parent in group {
          args.push("-p");
          args.push(parent);
        }
        args.extend(["-F", "-"]);
        next.push(git(&args, cwd, &env, Some(format!("{message} retention {depth}:{index}\n").into_bytes()))?);
      }
      layer = next;
      depth += 1;
    }
    let mut args = vec!["commit-tree", tree.as_str()];
    for parent in &layer {
      args.push("-p");
      args.push(parent);
    }
    args.extend(["-F", "-"]);
    git(&args, cwd, &env, Some(format!("{message}\n").into_bytes()))
  })();
  let _ = std::fs::remove_dir_all(&temporary);
  result
}

fn null_or(value: Option<&Value>) -> Value {
  value.cloned().unwrap_or(Value::Null)
}

/// `buildEnvelopeManifest(snapshot, payload, refs, includedNamespaces)`.
fn build_envelope_manifest(
  object_format: &str,
  lineage: &Value,
  records: &[(String, Value, String)],
  payload: Value,
  mut refs: Vec<Value>,
  included: [String; 2],
) -> GitResult<Value> {
  let summaries: Vec<Value> = records
    .iter()
    .map(|(attachment, record, digest)| {
      let resolution = js_text(get(Some(record), "type")) == "resolution"
        && matches!(get(Some(record), "type"), Some(Value::String(_)));
      let mut summary = Object::new();
      summary.set("attachment", string(attachment));
      for name in ["id", "schema", "type"] {
        if let Some(value) = get(Some(record), name) {
          summary.set(name, value.clone());
        }
      }
      summary.set("digest", string(digest));
      summary.set("ref", if resolution { null_or(get(Some(record), "ref")) } else { Value::Null });
      summary.set(
        "resultBlob",
        if resolution { null_or(get(Some(record), "resultBlob")) } else { Value::Null },
      );
      Value::Object(summary)
    })
    .collect();
  refs.sort_by(|left, right| locale_compare(&js_text(get(Some(left), "ref")), &js_text(get(Some(right), "ref"))));
  let mut capabilities: Vec<&str> = EXCHANGE_FEATURES.to_vec();
  capabilities.sort_unstable();
  let mut producer = Object::new();
  producer.set("name", string("causet"));
  producer.set("version", string(crate::VERSION));
  let mut repository = Object::new();
  repository.set("objectFormat", string(object_format));
  repository.set("lineage", lineage.clone());
  let mut trust = Object::new();
  trust.set("cryptographicallySigned", Value::Bool(false));
  trust.set("authorized", Value::Bool(false));
  trust.set(
    "statement",
    string("Hashes and Git object IDs establish integrity only, not actor identity or authorization."),
  );
  let mut manifest = Object::new();
  manifest.set("schema", string(METADATA_ENVELOPE_SCHEMA));
  manifest.set("producer", Value::Object(producer));
  manifest.set("repository", Value::Object(repository));
  manifest.set("capabilities", Value::Array(capabilities.iter().map(|item| string(item)).collect()));
  manifest.set("includedNamespaces", Value::Array(included.iter().map(|item| string(item)).collect()));
  manifest.set(
    "excludedScopes",
    Value::Array(
      [
        "tracked-portable/spec-manifests (moves with ordinary Git content)",
        "shared-local/workspaces",
        "shared-local/checkpoints",
        "worktree-private/reconciliations",
        "worktree-private/rebases",
        "worktree-private/forecasts",
      ]
      .iter()
      .map(|item| string(item))
      .collect(),
    ),
  );
  manifest.set("refs", Value::Array(refs));
  manifest.set("records", Value::Array(summaries));
  manifest.set("payload", payload);
  manifest.set("trust", Value::Object(trust));
  let hash = manifest_hash(&Value::Object(manifest.clone()))?;
  let mut integrity = Object::new();
  integrity.set("algorithm", string("sha256"));
  integrity.set("manifestHash", string(&hash));
  manifest.set("integrity", Value::Object(integrity));
  Ok(Value::Object(manifest))
}

fn ref_entry(name: &str, bundle_ref: &str, oid: &str) -> Value {
  let mut entry = Object::new();
  entry.set("ref", string(name));
  entry.set("bundleRef", string(bundle_ref));
  entry.set("oid", string(oid));
  Value::Object(entry)
}

/// `path.resolve(cwd, target)`.
fn resolve_against(cwd: &str, target: &str) -> String {
  if std::path::Path::new(target).is_absolute() {
    text::resolve_path(target)
  } else {
    text::resolve_path(&text::join(cwd, target))
  }
}

/// `exportMetadata(envelopePath)`.
pub fn export_metadata(envelope_path: &str, cwd: &str) -> GitResult<Value> {
  let context = engine::repo_context(cwd)?;
  let directory = resolve_against(cwd, envelope_path);
  if std::path::Path::new(&directory).exists() {
    return Err(GitError::new(
      "already-exists",
      format!("Metadata export path already exists: '{directory}'."),
    ));
  }
  let collector = metrics::begin("metadata-export");
  let snapshot = match full_snapshot(&context) {
    Ok(snapshot) => snapshot,
    Err(error) => {
      metrics::end(collector);
      return Err(error);
    }
  };
  let mut key_input = Object::new();
  key_input.set("lineage", snapshot.lineage.clone());
  key_input.set(
    "records",
    Value::Array(snapshot.records.iter().map(|(_, _, digest)| string(digest)).collect()),
  );
  let export_key = sha256(legacy_canonical_json(&Value::Object(key_input)).as_bytes())[..24].to_string();
  let temporary_ref = format!("{}/exports/{export_key}/notes", CURRENT_NAMES.refs_root);
  let root = context.root.clone();
  let mut created = false;
  let outcome = (|| -> GitResult<Value> {
    std::fs::create_dir(&directory).map_err(|error| io_failure(&error, "mkdir", &directory))?;
    created = true;
    let mut refs = Vec::new();
    let mut bundle_refs: Vec<String> = Vec::new();
    let repository = names(&root)?;
    if !snapshot.records.is_empty() {
      let entries: Vec<(String, Value)> = snapshot
        .records
        .iter()
        .map(|(attachment, record, _)| (attachment.clone(), record.clone()))
        .collect();
      let dependencies = record_dependencies(&entries, &root, false)?;
      let carrier = build_retention_commit(
        &dependencies,
        None,
        &root,
        &format!("causet metadata objects {export_key}"),
        &DETERMINISTIC_ENV,
      )?;
      let notes = build_notes_commit(&snapshot.records, &root, &format!("causet metadata export {export_key}"), &[carrier])?;
      git(&["update-ref", &temporary_ref, &notes], &root, &[], None)?;
      refs.push(ref_entry(repository.notes_ref, &temporary_ref, &notes));
      bundle_refs.push(temporary_ref.clone());
    }
    // `portableResolutionRefs(snapshot)`: the retained refs an accepted
    // resolution record names.
    let mut accepted: Vec<String> = Vec::new();
    for (_, record, _) in &snapshot.records {
      if js_text(get(Some(record), "type")) == "resolution" {
        accepted.push(local_ref(&js_text(get(Some(record), "ref")), &root)?);
      }
    }
    let resolution_refs = get(get(get(Some(&snapshot.scopes), "sharedPortable"), "resolutions"), "refs");
    if let Some(Value::Array(entries)) = resolution_refs {
      for entry in entries {
        let name = js_text(get(Some(entry), "ref"));
        if accepted.contains(&name) {
          refs.push(ref_entry(&name, &name, &js_text(get(Some(entry), "oid"))));
          bundle_refs.push(name);
        }
      }
    }
    let mut payload = Value::Null;
    let mut bytes = 0usize;
    if !bundle_refs.is_empty() {
      let bundle_path = text::join(&directory, ENVELOPE_BUNDLE);
      let mut args = vec!["bundle", "create", bundle_path.as_str()];
      args.extend(bundle_refs.iter().map(String::as_str));
      git(&args, &root, &[], None)?;
      let content = std::fs::read(&bundle_path).map_err(|error| io_failure(&error, "open", &bundle_path))?;
      bytes = content.len();
      let mut object = Object::new();
      object.set("file", string(ENVELOPE_BUNDLE));
      object.set("bytes", Value::Number(bytes as f64));
      object.set("sha256", string(&sha256(&content)));
      payload = Value::Object(object);
    }
    let manifest = build_envelope_manifest(
      &context.object_format,
      &snapshot.lineage,
      &snapshot.records,
      payload.clone(),
      refs,
      [repository.notes_ref.to_string(), format!("{}/resolutions/*", repository.refs_root)],
    )?;
    let manifest_path = text::join(&directory, ENVELOPE_MANIFEST);
    std::fs::write(&manifest_path, format!("{}\n", stringify_pretty(&manifest)))
      .map_err(|error| io_failure(&error, "open", &manifest_path))?;
    let count = |name: &str| match get(Some(&manifest), name) {
      Some(Value::Array(items)) => Value::Number(items.len() as f64),
      _ => Value::Number(0.0),
    };
    let mut result = Object::new();
    result.set("schema", string("causet.metadata-export/v1"));
    result.set("path", string(&directory));
    result.set("manifest", string(&manifest_path));
    result.set(
      "payload",
      if nullish(Some(&payload)) {
        Value::Null
      } else {
        string(&text::join(&directory, ENVELOPE_BUNDLE))
      },
    );
    result.set("records", count("records"));
    result.set("refs", count("refs"));
    result.set("quarantinedRecords", snapshot.quarantined.clone());
    result.set("bytes", Value::Number(bytes as f64));
    // Filled in once the collector ends, below.
    result.set("git", Value::Null);
    result.set("trust", get(Some(&manifest), "trust").cloned().unwrap_or(Value::Null));
    Ok(Value::Object(result))
  })();
  // `endGitMetrics` runs on success and failure alike, before the cleanup.
  let git_metrics = metrics::end(collector).to_value();
  let outcome = outcome.map(|mut result| {
    if let Value::Object(object) = &mut result {
      object.set("git", git_metrics);
    }
    result
  });
  if outcome.is_err() && created {
    let _ = std::fs::remove_dir_all(&directory);
  }
  // `safeDeleteRef(temporaryNoteRef)`, whatever happened.
  if engine::ref_exists(&temporary_ref, &root).unwrap_or(false) {
    let mut options = RunOptions::new(&root);
    options.allow_failure = true;
    let _ = run_git(&["update-ref".to_string(), "-d".to_string(), temporary_ref.clone()], &options);
  }
  outcome
}

/// `formatMetadataTransfer(result)` for an export.
pub fn format_export(result: &Value) -> String {
  let text = |name: &str| js_text(get(Some(result), name));
  [
    "Metadata exported".to_string(),
    format!("path         {}", text("path")),
    format!("records      {}", text("records")),
    format!("refs         {}", text("refs")),
    format!("quarantined  {} excluded", text("quarantinedRecords")),
    format!("payload      {} bytes", text("bytes")),
    format!("trust        integrity only; {}", trust_state(get(Some(result), "trust"))),
  ]
  .join("\n")
}
