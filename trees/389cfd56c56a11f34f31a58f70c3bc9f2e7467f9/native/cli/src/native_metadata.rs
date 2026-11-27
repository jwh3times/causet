//! `cst metadata status` and `cst metadata validate` in a native repository
//! (#420; ADR-0047 decision 12; docs/native-history/facts.md §4.2, §6). The
//! report is the Git-backed one, made by the same validators over the same
//! records: each current fact crosses the bridge as its Git record (§6), a
//! parked fact as its bytes at its place, and the reads the inventory makes
//! are answered from the store, the ref snapshot and the fact log. Its Git
//! IDs are then shown as the native IDs of what they name, as `cst
//! provenance` shows them, and no Git process runs.
//!
//! What a native repository does not have is reported empty: tracked
//! specification manifests and worktree-private state wait for N3's working
//! copy, and `workspaces.json` is not imported (facts.md §5.4). Its records
//! are reported under the current names, legacy ones included: a native
//! repository has no migration window.

use crate::metadata::{Diagnostics, Inventory, metadata_with, report_of, snapshot_of};
use crate::native::{print, report};
use crate::native_facts::current;
use crate::native_revision::{Object as Kind, Repository};
use crate::record_source::{Container, RecordSource};
use causet_engine::errors::{GitError, GitResult};
use causet_engine::locations::{CURRENT_NAMES, LEGACY_NAMES, Names};
use causet_engine::types::{ObjectRecord, RefEntry};
use causet_history::fact::{Fact, Reason};
use causet_history::fact_log::Scope;
use causet_import::store_error;
use causet_model::canonical::record_digest;
use causet_model::js::{get, locale_compare};
use causet_model::json::{self, Object, Value, string};
use causet_model::schemas::object_id_fields;
use causet_store::id::NativeId;
use causet_store::objects::RefTarget;
use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::ffi::OsString;
use std::path::Path;

/// The schema of a disposition registry, which the local chain's
/// dispositions are reported as.
const DISPOSITIONS_SCHEMA: &str = "causet.dispositions/v1";

/// A native repository's reads, and the records its fact log hands over.
pub struct NativeInventory<'a> {
  repository: &'a Repository,
  root: String,
  format: &'static str,
  /// Whether the snapshot keeps the records under the legacy names
  /// (facts.md §5.1).
  legacy: bool,
  /// The note containers the shared chain's current facts give, as Git
  /// holds them.
  containers: Vec<Container>,
  /// The disputed copies the local chain holds.
  disputes: Vec<Dispute>,
  /// The local chain's dispositions, as Git records.
  dispositions: Vec<Value>,
  /// The digests of the parked records the containers hold, with why each
  /// is parked.
  unused: HashMap<String, String>,
  /// Git ID → the ID the report shows it as, once looked up.
  shown: RefCell<HashMap<String, String>>,
}

/// A disputed copy the local chain holds (facts.md §5.3).
struct Dispute {
  /// Its ref's name after the quarantine prefix: the source lineage, `/`,
  /// and the record ID.
  place: String,
  record: String,
  fact: NativeId,
  /// The content its ref named, or nothing when it named no content.
  bytes: Vec<u8>,
}

/// The record source of a native report: the containers the inventory made.
struct Bridge<'a>(&'a [Container]);

impl RecordSource for Bridge<'_> {
  fn containers(&self) -> GitResult<Vec<Container>> {
    Ok(self.0.to_vec())
  }
}

fn lossy(bytes: &[u8]) -> String {
  String::from_utf8_lossy(bytes).into_owned()
}

/// Why a parked fact is parked, as a report says it.
fn why(reason: Reason) -> &'static str {
  match reason {
    Reason::Unreadable => "reason 01, a note import cannot read",
    Reason::Untaken => "reason 02, a record import cannot take",
    Reason::Repeated => "reason 03, a repeated copy",
    Reason::Disputed => "reason 04, a disputed copy",
  }
}

impl<'a> NativeInventory<'a> {
  pub fn open(repository: &'a Repository, root: &Path) -> GitResult<NativeInventory<'a>> {
    let legacy = causet_import::uses_legacy_names(repository.snapshot.refs.iter().map(|entry| entry.name.as_slice()));
    let mut inventory = NativeInventory {
      repository,
      root: root.to_string_lossy().into_owned(),
      format: repository.snapshot.algorithm.name(),
      legacy,
      containers: Vec::new(),
      disputes: Vec::new(),
      dispositions: Vec::new(),
      unused: HashMap::new(),
      shown: RefCell::new(HashMap::new()),
    };
    inventory.read_shared()?;
    inventory.read_local()?;
    Ok(inventory)
  }

  /// The shared chain's current facts as note containers (facts.md §6): one
  /// for each attachment, holding its records' Git records and its parked
  /// records' bytes, and one for each note import could not read.
  fn read_shared(&mut self) -> GitResult<()> {
    let mut records: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for (id, fact) in current(self.repository, Scope::Shared)? {
      match fact {
        Fact::Record { subject: Some(subject), record, .. } => {
          let attachment = self.repository.git_id(&subject)?;
          let git = self.git_record(&record)?;
          records.entry(attachment).or_default().push(json::stringify(&git));
        }
        // A record no note held is not in a note container.
        Fact::Record { subject: None, .. } => {}
        Fact::Parked { reason: Reason::Unreadable, place, bytes, .. } => {
          self.containers.push(Container { target: lossy(&place), id: id.hex(), bytes: Some(bytes) });
        }
        Fact::Parked { reason, place, bytes, .. } => {
          let place = lossy(&place);
          if let Ok(raw) = json::parse(&lossy(&bytes)) {
            self.unused.insert(record_digest(&place, &raw), why(reason).to_string());
          }
          records.entry(place).or_default().push(lossy(&bytes));
        }
      }
    }
    for (attachment, texts) in records {
      let note = format!("{{\"schema\":\"causet.note/v1\",\"records\":[{}]}}", texts.join(","));
      self.containers.push(Container { id: attachment.clone(), target: attachment, bytes: Some(note.into_bytes()) });
    }
    Ok(())
  }

  /// The local chain's current facts: the disputed copies, and the
  /// dispositions as Git records, in order of `decidedAt`, then of ID.
  fn read_local(&mut self) -> GitResult<()> {
    for (id, fact) in current(self.repository, Scope::Local)? {
      match fact {
        Fact::Parked { reason: Reason::Disputed, place, id: record, bytes } => {
          self.disputes.push(Dispute { place: lossy(&place), record: lossy(&record.unwrap_or_default()), fact: id, bytes });
        }
        Fact::Record { record, .. } => self.dispositions.push(self.git_record(&record)?),
        Fact::Parked { .. } => {}
      }
    }
    let key = |value: &Value| {
      let member = |name: &str| match get(Some(value), name) {
        Some(Value::String(units)) => json::lossy(units),
        _ => String::new(),
      };
      (member("decidedAt"), member("id"))
    };
    self.dispositions.sort_by_key(|value| key(value));
    Ok(())
  }

  /// A fact's record as its Git record (facts.md §6): each object ID the
  /// Git ID of what it names.
  fn git_record(&self, record: &[u8]) -> GitResult<Value> {
    let value = json::parse(&lossy(record))
      .map_err(|why| crate::native_repository::corrupt(format!("a fact's record is not JSON: {why}")))?;
    let schema = match get(Some(&value), "schema") {
      Some(Value::String(units)) => json::lossy(units),
      _ => String::new(),
    };
    let fields: HashSet<&str> = object_id_fields(&schema).iter().copied().collect();
    self.to_git(&value, "", &fields)
  }

  fn to_git(&self, value: &Value, path: &str, fields: &HashSet<&str>) -> GitResult<Value> {
    Ok(match value {
      Value::String(units) if fields.contains(path) => {
        let shown = json::lossy(units);
        let native = NativeId::from_hex(&shown)
          .ok_or_else(|| crate::native_repository::corrupt(format!("a fact names {shown}, which is no native ID")))?;
        string(&self.repository.git_id(&native)?)
      }
      Value::Array(items) => Value::Array(items.iter().map(|item| self.to_git(item, path, fields)).collect::<GitResult<_>>()?),
      Value::Object(object) => {
        let mut copy = Object::new();
        for key in object.keys() {
          let name = json::lossy(key);
          let child = if path.is_empty() { name } else { format!("{path}.{name}") };
          copy.insert(key.clone(), self.to_git(object.get_units(key).expect("a key it lists"), &child, fields)?);
        }
        Value::Object(copy)
      }
      other => other.clone(),
    })
  }

  /// What an expression names, as `git cat-file --batch` reads it: its Git
  /// ID, type and content. A name the store does not hold does not exist.
  fn lookup(&self, expression: &str) -> GitResult<ObjectRecord> {
    let missing = ObjectRecord {
      expression: expression.to_string(),
      exists: false,
      oid: None,
      kind: None,
      size: 0,
      content: None,
    };
    let Ok(id) = self.repository.resolve(expression.as_bytes()) else {
      return Ok(missing);
    };
    let kind = match self.repository.object(&id)? {
      Some(kind @ (Kind::Blob | Kind::Tree | Kind::Commit | Kind::Tag)) => kind,
      _ => return Ok(missing),
    };
    let Ok(oid) = self.repository.git_id(&id) else {
      return Ok(missing);
    };
    let content = if kind == Kind::Blob {
      Some(self.repository.store.read(&id).map_err(store_error)?.body)
    } else {
      None
    };
    Ok(ObjectRecord {
      expression: expression.to_string(),
      exists: true,
      oid: Some(oid),
      kind: Some(kind.name().to_string()),
      size: content.as_ref().map_or(0, |bytes| bytes.len() as u64),
      content,
    })
  }

  /// The ref names under `<refs root>/<family>/` in the names in use, each
  /// under the current names, with the Git ID of what it names.
  fn refs_under(&self, family: &str) -> GitResult<Vec<RefEntry>> {
    let names = if self.legacy { LEGACY_NAMES } else { CURRENT_NAMES };
    let prefix = format!("{}/{family}/", names.refs_root);
    let mut refs = Vec::new();
    for entry in &self.repository.snapshot.refs {
      let (Some(rest), RefTarget::Direct(id)) = (entry.name.strip_prefix(prefix.as_bytes()), &entry.target) else {
        continue;
      };
      refs.push(RefEntry {
        name: format!("{}/{family}/{}", CURRENT_NAMES.refs_root, lossy(rest)),
        oid: self.repository.git_id(id)?,
      });
    }
    refs.sort_by(|left, right| locale_compare(&left.name, &right.name));
    Ok(refs)
  }

  /// The ID the report shows a Git ID as: the native ID of what it names,
  /// or the Git ID itself when the store has no such object.
  fn shown(&self, git: &str) -> GitResult<String> {
    if let Some(found) = self.shown.borrow().get(git) {
      return Ok(found.clone());
    }
    let shown = match self.repository.git_named(git)? {
      Some(id) => id.hex(),
      None => git.to_string(),
    };
    self.shown.borrow_mut().insert(git.to_string(), shown.clone());
    Ok(shown)
  }

  /// A text with each whole Git ID shown as a native one: a run of
  /// lowercase hex of a Git ID's length, with no letter, digit or `_` on
  /// either side.
  fn translated(&self, text: &str) -> GitResult<String> {
    let width = causet_model::schemas::oid_length(self.format);
    let bytes = text.as_bytes();
    let word = |byte: u8| byte.is_ascii_alphanumeric() || byte == b'_';
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
      if !word(bytes[at]) {
        out.push(bytes[at]);
        at += 1;
        continue;
      }
      let start = at;
      while at < bytes.len() && word(bytes[at]) {
        at += 1;
      }
      let run = &text[start..at];
      if run.len() == width && run.bytes().all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f')) {
        out.extend_from_slice(self.shown(run)?.as_bytes());
      } else {
        out.extend_from_slice(run.as_bytes());
      }
    }
    Ok(String::from_utf8(out).expect("only ASCII runs were replaced"))
  }

  fn translate(&self, value: Value) -> GitResult<Value> {
    Ok(match value {
      Value::String(units) => string(&self.translated(&json::lossy(&units))?),
      Value::Array(items) => Value::Array(items.into_iter().map(|item| self.translate(item)).collect::<GitResult<_>>()?),
      Value::Object(object) => {
        let mut copy = Object::new();
        for key in object.keys() {
          copy.insert(key.clone(), self.translate(object.get_units(key).expect("a key it lists").clone())?);
        }
        Value::Object(copy)
      }
      other => other,
    })
  }
}

fn object_of(members: &[(&str, Value)]) -> Value {
  let mut object = Object::new();
  for (name, value) in members {
    object.set(name, value.clone());
  }
  Value::Object(object)
}

fn zero() -> Value {
  Value::Number(0.0)
}

impl Inventory for NativeInventory<'_> {
  fn root(&self) -> &str {
    &self.root
  }

  fn object_format(&self) -> &str {
    self.format
  }

  fn names(&self) -> GitResult<Names> {
    Ok(CURRENT_NAMES)
  }

  fn objects(&self, expressions: Vec<String>) -> GitResult<HashMap<String, ObjectRecord>> {
    let unique: BTreeSet<String> = expressions.into_iter().filter(|item| !item.is_empty()).collect();
    unique.into_iter().map(|expression| Ok((expression.clone(), self.lookup(&expression)?))).collect()
  }

  /// A disputed copy is read from its fact, by the ID `quarantine_refs`
  /// gives it.
  fn read_objects(&self, ids: &[String]) -> GitResult<Vec<ObjectRecord>> {
    ids
      .iter()
      .map(|id| {
        match self.disputes.iter().find(|dispute| dispute.fact.hex() == *id) {
          // Its bytes are empty when its ref named no content (§5.3).
          Some(Dispute { bytes, .. }) => Ok(ObjectRecord {
            expression: id.clone(),
            exists: !bytes.is_empty(),
            oid: Some(id.clone()),
            kind: (!bytes.is_empty()).then(|| "blob".to_string()),
            size: bytes.len() as u64,
            content: Some(bytes.clone()),
          }),
          None => self.lookup(id),
        }
      })
      .collect()
  }

  fn family_refs(&self, family: &str) -> GitResult<Vec<RefEntry>> {
    self.refs_under(family)
  }

  fn peeled_commits(&self, refs: &[RefEntry]) -> GitResult<HashMap<String, Option<String>>> {
    let mut peeled = HashMap::new();
    for entry in refs {
      let commit = self.lookup(&format!("{}^{{commit}}", entry.oid))?;
      let commit = (commit.exists && commit.kind.as_deref() == Some("commit")).then_some(commit.oid).flatten();
      peeled.insert(entry.name.clone(), commit);
    }
    Ok(peeled)
  }

  fn parked_ids(&self) -> GitResult<BTreeSet<String>> {
    Ok(self.disputes.iter().map(|dispute| dispute.record.clone()).collect())
  }

  fn quarantine_refs(&self) -> GitResult<Vec<RefEntry>> {
    Ok(
      self
        .disputes
        .iter()
        .map(|dispute| RefEntry { name: format!("{}/quarantine/{}", CURRENT_NAMES.refs_root, dispute.place), oid: dispute.fact.hex() })
        .collect(),
    )
  }

  /// `localRef(ref)`: a ref a record names, under the current names.
  fn local_ref(&self, name: &str) -> GitResult<String> {
    if name == CURRENT_NAMES.notes_ref || name == LEGACY_NAMES.notes_ref {
      return Ok(CURRENT_NAMES.notes_ref.to_string());
    }
    for set in [CURRENT_NAMES, LEGACY_NAMES] {
      if let Some(rest) = name.strip_prefix(&format!("{}/", set.refs_root)) {
        return Ok(format!("{}/{rest}", CURRENT_NAMES.refs_root));
      }
    }
    Ok(name.to_string())
  }

  fn dispositions(&self) -> GitResult<Value> {
    Ok(object_of(&[
      ("schema", string(DISPOSITIONS_SCHEMA)),
      ("dispositions", Value::Array(self.dispositions.clone())),
    ]))
  }

  fn dispositions_path(&self) -> GitResult<String> {
    Ok(format!("the fact log of {}", self.root))
  }

  fn tracked(&self, _: &mut Diagnostics) -> GitResult<Value> {
    Ok(object_of(&[
      ("manifestCount", zero()),
      ("bySchema", Value::Object(Object::new())),
      ("consistentCount", zero()),
      ("manifests", Value::Array(Vec::new())),
    ]))
  }

  fn workspace_registry(&self, _: &mut Diagnostics) -> GitResult<Value> {
    Ok(object_of(&[
      ("present", Value::Bool(false)),
      ("schema", Value::Null),
      ("count", zero()),
      ("workspaces", Value::Array(Vec::new())),
    ]))
  }

  fn private_state(&self, _: &mut Diagnostics) -> GitResult<Value> {
    Ok(object_of(&[
      ("worktreeCount", zero()),
      ("pendingOperationCount", zero()),
      ("forecastCount", zero()),
      ("worktrees", Value::Array(Vec::new())),
    ]))
  }

  fn migration(&self, _: &mut Diagnostics) -> GitResult<()> {
    Ok(())
  }

  /// `repositoryLineage`: the root commits the branches, tags and
  /// remote-tracking names reach, by their Git IDs, so the lineage is the
  /// original's.
  fn lineage(&self) -> GitResult<Value> {
    let repository = self.repository;
    let mut pending = Vec::new();
    for entry in &repository.snapshot.refs {
      let named = [&b"refs/heads/"[..], b"refs/tags/", b"refs/remotes/"].iter().any(|prefix| entry.name.starts_with(prefix));
      if let (true, RefTarget::Direct(id)) = (named, &entry.target)
        && let Some(commit) = repository.commit_of(repository.named(*id)?)?
      {
        pending.push(commit);
      }
    }
    let mut seen = HashSet::new();
    let mut roots = Vec::new();
    while let Some(commit) = pending.pop() {
      if !seen.insert(commit) {
        continue;
      }
      let parents = repository.parents(&commit)?;
      if parents.is_empty() {
        roots.push(repository.git_id(&commit)?);
      }
      pending.extend(parents);
    }
    causet_engine::text::sort(&mut roots);
    roots.dedup();
    let mut identity = Object::new();
    identity.set("algorithm", string(causet_model::registry::METADATA_LINEAGE_ALGORITHM));
    identity.set("objectFormat", string(self.format));
    identity.set("rootCommits", Value::Array(roots.iter().map(|root| string(root)).collect()));
    let id = crate::lineage::lineage_identity_id(&Value::Object(identity.clone()))?;
    identity.set("id", string(&id));
    Ok(Value::Object(identity))
  }

  fn unused(&self) -> HashMap<String, String> {
    self.unused.clone()
  }

  fn present(&self, report: Value) -> GitResult<Value> {
    self.translate(report)
  }
}

/// `cst metadata status` and `cst metadata validate [--strict]` in a native
/// repository, their arguments parsed as the front end parses them in a
/// Git-backed one. The other `cst metadata` commands are refused.
pub fn metadata_command(args: &[OsString], root: &Path) -> GitResult<i32> {
  let mut words = vec!["metadata".to_string()];
  words.extend(args.iter().map(|arg| arg.to_string_lossy().into_owned()));
  let json = crate::native_log::wants_json(args);
  let parsed = match crate::front::decide(&words, &|_| None, &|_| false, "") {
    crate::front::Outcome::Native { parsed, .. } => parsed,
    crate::front::Outcome::Fail { failure, json } => {
      return Ok(report(&GitError::new(failure.code, failure.message), json));
    }
    _ => {
      let refused = GitError::new(
        "usage-unknown-option",
        "cst metadata takes no such arguments in a native repository; cst --help there lists what it takes",
      );
      return Ok(report(&refused, json));
    }
  };
  let subcommand = parsed.positionals.first().map(String::as_str).unwrap_or_default();
  if !matches!(subcommand, "status" | "validate") {
    let refused = crate::native_revision::unsupported(format!("cst metadata {subcommand}"));
    return Ok(report(&refused, json));
  }
  let answered = Repository::open(root).and_then(|repository| {
    let inventory = NativeInventory::open(&repository, root)?;
    let source = Bridge(&inventory.containers);
    metadata_with(subcommand, parsed.truthy("strict"), parsed.truthy("json"), &|schema| {
      report_of(&inventory, snapshot_of(&inventory, &source)?, schema)
    })
  });
  match answered {
    Ok((value, code)) => {
      print(&value);
      Ok(code)
    }
    Err(error) => Ok(report(&error, json)),
  }
}
