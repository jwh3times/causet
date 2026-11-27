//! cst's records in a native repository (#419; ADR-0047 decisions 5-8,
//! docs/native-history/facts.md): the fact log as a record source, so that
//! `cst provenance` and `cst receipts` read facts through the same readers
//! as in a Git-backed repository, and native history as the commits
//! `cst provenance` inspects. Neither starts a Git process.
//!
//! The source hands over every current fact of state `00` that a note held,
//! one container per subject, as the notes hand over every record: the
//! readers judge them as they judge a note's records. A parked fact is no
//! record, and no reader is handed one (facts.md §3.3).

use crate::native::{print, report};
use crate::notes::NOTE_SCHEMA;
use crate::native_log;
use crate::native_revision::Repository;
use crate::parsed::Parsed;
use crate::provenance::CommitReads;
use crate::record_source::{Container, RecordSource};
use causet_engine::errors::{GitError, GitResult};
use causet_history::catalog::Catalogs;
use causet_history::fact::Fact;
use causet_history::fact_log::{self, Scope};
use causet_import::store_error;
use causet_model::js::get;
use causet_model::json::{self, Value};
use causet_store::id::NativeId;
use std::collections::BTreeMap;
use std::ffi::OsString;

/// The fact log of a native repository, as a record source.
pub struct FactLog<'a> {
  repository: &'a Repository,
}

impl<'a> FactLog<'a> {
  pub fn of(repository: &'a Repository) -> FactLog<'a> {
    FactLog { repository }
  }

  /// One `causet.note/v1` container per subject, in byte order of the
  /// subject's Git ID as Git lists notes, its records in order of
  /// `createdAt`, then of their bytes.
  fn containers_of(&self, by_subject: BTreeMap<NativeId, Vec<Vec<u8>>>) -> GitResult<Vec<Container>> {
    let mut containers = Vec::with_capacity(by_subject.len());
    for (subject, mut records) in by_subject {
      records.sort_by(|a, b| (created(a), a).cmp(&(created(b), b)));
      let joined: Vec<String> = records.iter().map(|record| String::from_utf8_lossy(record).into_owned()).collect();
      let text = format!("{{\"schema\":\"{NOTE_SCHEMA}\",\"records\":[{}]}}", joined.join(","));
      // Git lists notes by their attachment's Git ID; a subject with none,
      // which nothing imported writes yet, sorts by its native ID.
      let order = match self.repository.git_id(&subject) {
        Ok(id) => id,
        Err(error) if error.code == "not-found" => subject.hex(),
        Err(error) => return Err(error),
      };
      containers.push((order, Container { target: subject.hex(), id: subject.hex(), bytes: Some(text.into_bytes()) }));
    }
    containers.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(containers.into_iter().map(|(_, container)| container).collect())
  }
}

/// The facts current at a chain's heads (facts.md §4.2), in byte order of
/// ID.
pub(crate) fn current(repository: &Repository, scope: Scope) -> GitResult<Vec<(NativeId, Fact)>> {
  fact_log::current(&repository.store, scope).map_err(store_error)
}

/// A record's `createdAt`, by which a container lists its records.
fn created(record: &[u8]) -> String {
  std::str::from_utf8(record)
    .ok()
    .and_then(|text| json::parse(text).ok())
    .and_then(|value| match get(Some(&value), "createdAt") {
      Some(Value::String(units)) => Some(json::lossy(units)),
      _ => None,
    })
    .unwrap_or_default()
}

impl RecordSource for FactLog<'_> {
  fn containers(&self) -> GitResult<Vec<Container>> {
    let mut by_subject: BTreeMap<NativeId, Vec<Vec<u8>>> = BTreeMap::new();
    for (_, fact) in current(self.repository, Scope::Shared)? {
      if let Fact::Record { subject: Some(subject), record, .. } = fact {
        by_subject.entry(subject).or_default().push(record);
      }
    }
    self.containers_of(by_subject)
  }

  /// The containers of these subjects alone, found through the catalog of
  /// the facts naming each object (ADR-0047 decision 14), so that reading
  /// one commit's records reads no other fact.
  fn containers_for(&self, objects: &[String]) -> GitResult<Vec<Container>> {
    let catalogs = Catalogs::of(&self.repository.store);
    let mut by_subject: BTreeMap<NativeId, Vec<Vec<u8>>> = BTreeMap::new();
    for object in objects {
      let Some(wanted) = NativeId::from_hex(object).filter(|id| id.hex() == *object) else {
        continue;
      };
      if by_subject.contains_key(&wanted) {
        continue;
      }
      // The catalog lists the current facts of both chains, but a local
      // fact never has a subject (facts.md §5.3): a disposition has none,
      // and a disputed copy is parked. So these are the shared records
      // `containers` gives.
      for id in catalogs.facts_naming(&wanted).map_err(store_error)? {
        if let Fact::Record { subject: Some(subject), record, .. } = Fact::read(&self.repository.store, &id).map_err(store_error)?
          && subject == wanted
        {
          by_subject.entry(subject).or_default().push(record);
        }
      }
    }
    self.containers_of(by_subject)
  }
}

/// Native history as the commits `cst provenance` inspects.
pub struct NativeCommits<'a> {
  repository: &'a Repository,
}

impl CommitReads for NativeCommits<'_> {
  fn resolve(&self, revision: &str) -> GitResult<String> {
    Ok(native_log::commit_named(self.repository, revision)?.hex())
  }

  fn reachable(&self, revision: &str) -> GitResult<Vec<String>> {
    Ok(native_log::reachable(self.repository, revision)?.iter().map(NativeId::hex).collect())
  }

  fn subject(&self, commit: &str) -> GitResult<String> {
    let id = NativeId::from_hex(commit)
      .ok_or_else(|| GitError::new("not-found", format!("{commit} is no native ID")))?;
    native_log::subject(self.repository, &id)
  }
}

/// `cst provenance` and `cst receipts` in a native repository, their
/// arguments parsed as the front end parses them in a Git-backed one.
pub fn records_command(command: &str, args: &[OsString], root: &std::path::Path) -> GitResult<i32> {
  let mut words = vec![command.to_string()];
  words.extend(args.iter().map(|arg| arg.to_string_lossy().into_owned()));
  let json = crate::native_log::wants_json(args);
  // The front end's own parser, with no environment variable set and the
  // repository counted as migrated: a native repository has neither
  // Git-backed settings nor a migration window. Its help text is not used.
  let parsed = match crate::front::decide(&words, &|_| None, &|_| false, "") {
    crate::front::Outcome::Native { parsed, .. } => parsed,
    crate::front::Outcome::Fail { failure, json } => {
      return Ok(report(&GitError::new(failure.code, failure.message), json));
    }
    _ => {
      let refused = GitError::new(
        "usage-unknown-option",
        format!("cst {command} takes no such arguments in a native repository; cst --help there lists what it takes"),
      );
      return Ok(report(&refused, json));
    }
  };
  match answer(command, &parsed, root) {
    Ok(value) => {
      print(&value);
      Ok(0)
    }
    Err(error) => Ok(report(&error, json)),
  }
}

fn answer(command: &str, parsed: &Parsed, root: &std::path::Path) -> GitResult<Value> {
  let repository = Repository::open(root)?;
  let source = FactLog::of(&repository);
  match command {
    "provenance" if parsed.positionals.first().map(String::as_str) == Some("declare") => Err(crate::native_revision::unsupported(
      "cst provenance declare, which records a fact,",
    )),
    "provenance" => crate::provenance::provenance(parsed, &source, &NativeCommits { repository: &repository }),
    _ => {
      let records = crate::notes::list_note_records(&source)?;
      if parsed.truthy("json") {
        Ok(Value::Array(records))
      } else {
        Ok(json::string(&crate::records::format_receipts(&records)?))
      }
    }
  }
}
