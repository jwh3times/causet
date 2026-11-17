//! Import's fact log (docs/native-history/facts.md §5): the history of
//! `refs/notes/causet` becomes the shared chain, one entry per notes commit,
//! each adding the facts its tree gives that are not current at its parents
//! and retiring those current there that it does not give. The commits the
//! records name are roots of import's walk (§5.5), so the facts can name
//! their native commits.
//!
//! The local chain (§5.3) gets at most one entry per import, whose parents
//! are its heads, bringing what is current there to the original's local
//! facts: a parked fact for each disputed copy under
//! `refs/causet/quarantine/` and a fact for each disposition of
//! `dispositions.json`. A repository that keeps its records
//! under the legacy names (§5.1) is read under them alike.

use crate::{Importer, store_error};
use causet_engine::errors::{GitError, GitResult};
use causet_engine::locations::{CURRENT_NAMES, LEGACY_NAMES, Names};
use causet_history::fact::Fact;
use causet_history::fact_log::{Entry, Scope, State};
use causet_history::local::{disposition_roots, dispositions, disputed, local_entry};
use causet_history::notes::{Note, facts_of_notes, notes_commit_action, roots_of_notes};
use causet_store::id::{NativeId, Type};
use causet_store::StoreError;
use causet_store::objects::GitKind;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

/// Whether a snapshot whose refs have these names keeps cst's records under
/// the legacy names (§5.1): when it holds neither `refs/notes/causet` nor a
/// ref under `refs/causet/`. A migrated repository holds both, and is read
/// under the current names.
pub fn uses_legacy_names<'a>(mut names: impl Iterator<Item = &'a [u8]>) -> bool {
  let root = format!("{}/", CURRENT_NAMES.refs_root);
  !names.any(|name| name == CURRENT_NAMES.notes_ref.as_bytes() || name.starts_with(root.as_bytes()))
}

/// The names in use (§5.1).
fn record_names(refs: &[crate::git::Listed]) -> Names {
  if uses_legacy_names(refs.iter().map(|entry| entry.name.as_slice())) { LEGACY_NAMES } else { CURRENT_NAMES }
}

/// A disputed copy (§5.3): its ref's name after the quarantine prefix, and
/// the Git ID of what the ref names.
struct Dispute {
  remainder: Vec<u8>,
  object: String,
}

/// What the local chain is built from (§5.3): the disputed copies, and the
/// `dispositions.json` registry, when there is one.
pub(crate) struct LocalSources {
  disputes: Vec<Dispute>,
  dispositions: Option<Vec<u8>>,
}

impl LocalSources {
  /// The objects the disputed copies' refs name, whose bytes the parked
  /// facts keep.
  pub(crate) fn blobs(&self) -> HashSet<String> {
    self.disputes.iter().map(|dispute| dispute.object.clone()).collect()
  }
}

/// One note of a notes tree: the Git ID of what it is attached to, in
/// lowercase hex, and the Git ID of what the note is.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct NoteAt {
  attachment: String,
  blob: String,
}

/// One commit of the notes history.
pub(crate) struct NotesCommit {
  id: String,
  parents: Vec<String>,
  /// Its notes, in byte order of path.
  notes: Vec<NoteAt>,
  payload: Vec<u8>,
}

/// The notes history, parents before children.
pub(crate) struct NotesHistory {
  commits: Vec<NotesCommit>,
}

impl NotesHistory {
  /// The distinct notes of every commit: what the derivation reads.
  fn distinct(&self) -> Vec<NoteAt> {
    let mut seen = HashSet::new();
    self
      .commits
      .iter()
      .flat_map(|commit| commit.notes.iter())
      .filter(|note| seen.insert((*note).clone()))
      .cloned()
      .collect()
  }

  /// The blobs this import reads that a note is: their bytes are kept as
  /// they are stored.
  pub(crate) fn blobs(&self) -> HashSet<String> {
    self.distinct().into_iter().map(|note| note.blob).collect()
  }
}

/// Whether a tree entry's name is a fan-out directory: two hex digits.
fn fan_out(name: &[u8]) -> bool {
  name.len() == 2 && name.iter().all(u8::is_ascii_hexdigit)
}

impl Importer<'_> {
  /// The commits of the notes history and their notes (§5.1, §5.2), or
  /// `None` when the snapshot has no notes ref to read under the names in
  /// use.
  pub(crate) fn notes_history(&self, refs: &[crate::git::Listed]) -> GitResult<Option<NotesHistory>> {
    if crate::without_history() {
      return Ok(None);
    }
    let notes_ref = record_names(refs).notes_ref.as_bytes();
    let Some(tip) = refs
      .iter()
      .find(|entry| entry.name == notes_ref && entry.symbolic.is_none())
      .and_then(|entry| entry.id.clone())
    else {
      return Ok(None);
    };
    // Every commit the notes ref reaches through parents, parents first.
    let mut order: Vec<NotesCommit> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut stack: Vec<(String, bool)> = vec![(tip, false)];
    let mut read: HashMap<String, (Vec<String>, Vec<u8>)> = HashMap::new();
    while let Some((id, expanded)) = stack.pop() {
      if expanded {
        let (parents, payload) = read.remove(&id).expect("read when first reached");
        let notes = self.notes_of(&id, &payload)?;
        order.push(NotesCommit { id, parents, notes, payload });
        continue;
      }
      if !seen.insert(id.clone()) {
        continue;
      }
      let (parents, payload) = self.commit_parts(&id, notes_ref)?;
      stack.push((id.clone(), true));
      for parent in parents.iter().rev() {
        if !seen.contains(parent) {
          stack.push((parent.clone(), false));
        }
      }
      read.insert(id, (parents, payload));
    }
    Ok(Some(NotesHistory { commits: order }))
  }

  /// A notes commit's parents, as Git parses them, and its payload, from
  /// what this import read or what the store held already.
  fn commit_parts(&self, id: &str, notes_ref: &[u8]) -> GitResult<(Vec<String>, Vec<u8>)> {
    if self.held_at.contains_key(id) {
      let payload = self.body(id).ok_or_else(|| self.lost(id))?;
      return Ok((self.parents.get(id).cloned().unwrap_or_default(), payload));
    }
    let (_, kept) = self.held_preserved(id)?.ok_or_else(|| self.lost(id))?;
    if kept.kind != GitKind::Commit {
      return Err(GitError::new(
        "unsupported-repository-shape",
        format!("{} reaches {id}, which is not a commit", String::from_utf8_lossy(notes_ref)),
      ));
    }
    let parents = kept
      .header_ids()
      .into_iter()
      .filter(|header| !header.first)
      .map(|header| crate::hex(&header.digest))
      .collect();
    Ok((parents, kept.payload))
  }

  /// A notes commit's notes, in byte order of path (§5.2): each path of its
  /// tree, through fan-out directories, that spells a whole Git ID in either
  /// case.
  fn notes_of(&self, commit: &str, payload: &[u8]) -> GitResult<Vec<NoteAt>> {
    let tree = crate::built_on(self.algorithm, GitKind::Commit, payload).ok_or_else(|| self.lost(commit))?;
    let width = self.algorithm.length() * 2;
    let mut notes: Vec<(Vec<u8>, String, String)> = Vec::new();
    let mut pending: Vec<(String, Vec<u8>, Vec<u8>)> = vec![(tree, Vec::new(), Vec::new())];
    while let Some((tree, path, name)) = pending.pop() {
      for (entry, mode, id) in self.entries(&tree).ok_or_else(|| self.lost(&tree))? {
        let spelled = [name.as_slice(), &entry].concat();
        let entry_path = if path.is_empty() { entry.clone() } else { [path.as_slice(), b"/", &entry].concat() };
        let directory = mode.is_some_and(|mode| mode & 0o170000 == 0o040000);
        if directory && fan_out(&entry) && spelled.len() < width {
          pending.push((id, entry_path, spelled));
        } else if spelled.len() == width && spelled.iter().all(u8::is_ascii_hexdigit) {
          let attachment = String::from_utf8_lossy(&spelled).to_ascii_lowercase();
          notes.push((entry_path, attachment, id));
        }
      }
    }
    notes.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(notes.into_iter().map(|(_, attachment, blob)| NoteAt { attachment, blob }).collect())
  }

  /// A note's bytes: as this import read them, or as the store held them,
  /// or `None` when it is no blob.
  fn note_bytes(&self, blob: &str) -> GitResult<Option<Vec<u8>>> {
    if let Some(bytes) = self.note_blobs.get(blob) {
      return Ok(Some(bytes.clone()));
    }
    if self.types.contains_key(blob) {
      return Ok(None);
    }
    let (Some(store), Some(native)) = (self.store.existing(), self.held(blob)) else {
      return Ok(None);
    };
    if store.held(&native).map_err(store_error)? != Some(Type::Content) {
      return Ok(None);
    }
    Ok(Some(store.read(&native).map_err(store_error)?.body))
  }

  /// Whether this import reads an object, or the store holds it already.
  fn reads_or_holds(&self, id: &str) -> bool {
    self.types.contains_key(id) || self.held(id).is_some()
  }

  /// The commits the records import can take name (§5.5).
  pub(crate) fn fact_roots(&self, history: &NotesHistory) -> GitResult<Vec<String>> {
    let mut notes = Vec::new();
    for note in history.distinct() {
      notes.push(Note { bytes: self.note_bytes(&note.blob)?, attachment: note.attachment });
    }
    Ok(roots_of_notes(&notes, self.algorithm.name(), |id| self.reads_or_holds(id)))
  }

  /// The ID a fact names an object by (facts.md §3.2): the native commit or
  /// tag imported from a commit or tag, and otherwise the store's object.
  fn fact_name(&mut self, id: &str) -> Option<NativeId> {
    if let Some(native) = self.commits.get(id).or_else(|| self.tags.get(id)) {
      return Some(*native);
    }
    let preserved = self.native_of(id)?;
    if let Ok(Some(native)) = self.held_commit(&preserved) {
      return Some(native);
    }
    if let Ok(Some(native)) = self.held_tag(&preserved) {
      return Some(native);
    }
    Some(preserved)
  }

  /// The disputed copies and the dispositions the local chain is built from
  /// (§5.3), or `None` under `without_history`.
  pub(crate) fn local_sources(&self, refs: &[crate::git::Listed]) -> Option<LocalSources> {
    if crate::without_history() {
      return None;
    }
    let names = record_names(refs);
    let quarantine = format!("{}/quarantine/", names.refs_root);
    let disputes = refs
      .iter()
      .filter(|entry| entry.symbolic.is_none())
      .filter_map(|entry| {
        let remainder = entry.name.strip_prefix(quarantine.as_bytes())?.to_vec();
        Some(Dispute { remainder, object: entry.id.clone()? })
      })
      .collect();
    Some(LocalSources { disputes, dispositions: self.source.shared_local_file(names.runtime, "dispositions.json") })
  }

  /// The objects the dispositions import can take name (§5.5).
  pub(crate) fn local_roots(&self, sources: &LocalSources) -> Vec<String> {
    match &sources.dispositions {
      Some(file) => disposition_roots(file, self.algorithm.name(), |id| self.reads_or_holds(id)),
      None => Vec::new(),
    }
  }

  /// Writes the local chain's entry for this import (§5.3), and the facts
  /// it adds, when it changes what is current; whether it wrote one.
  pub(crate) fn local_chain(&mut self, sources: &LocalSources) -> GitResult<bool> {
    let mut facts = Vec::new();
    for dispute in &sources.disputes {
      let bytes = self.note_bytes(&dispute.object)?.unwrap_or_default();
      facts.extend(disputed(&dispute.remainder, bytes));
    }
    if let Some(file) = &sources.dispositions {
      let format = self.algorithm.name();
      facts.extend(dispositions(file, format, |id| self.fact_name(id)));
    }
    let (heads, current) = self.held_local_chain()?;
    let Some(entry) = local_entry(&heads, &current, &facts) else {
      return Ok(false);
    };
    let bodies: BTreeMap<NativeId, Vec<u8>> = facts.iter().map(|fact| (fact.id(), fact.encode())).collect();
    for id in &entry.adds {
      self.store.put_metadata(Type::Fact, &bodies[id]).map_err(store_error)?;
    }
    self.store.put_metadata(Type::FactLogEntry, &entry.encode()).map_err(store_error)?;
    Ok(true)
  }

  /// The local chain of the store this import adds to: its heads, every
  /// held local entry no other names as a parent, and the facts current at
  /// them. Both are empty for a new store.
  fn held_local_chain(&self) -> GitResult<(Vec<NativeId>, BTreeSet<NativeId>)> {
    let Some(store) = self.store.existing() else {
      return Ok((Vec::new(), BTreeSet::new()));
    };
    let corrupt = |id: &NativeId, why: String| store_error(StoreError::Corrupt(format!("the fact-log entry {id}: {why}")));
    let mut entries: HashMap<NativeId, Entry> = HashMap::new();
    for id in store.present_of(Type::FactLogEntry).map_err(store_error)? {
      let entry = Entry::decode(&store.read(&id).map_err(store_error)?.body).map_err(|why| corrupt(&id, why))?;
      if entry.scope == Scope::Local {
        entries.insert(id, entry);
      }
    }
    let named: HashSet<NativeId> = entries.values().flat_map(|entry| entry.parents.iter().copied()).collect();
    let mut heads: Vec<NativeId> = entries.keys().filter(|id| !named.contains(id)).copied().collect();
    heads.sort();
    let state = State::at(&heads, |id| entries.get(id).cloned().ok_or_else(|| corrupt(id, "it is not held".into())))?;
    Ok((heads, state.current()))
  }

  /// Writes the shared chain: each notes commit's facts, then its entry,
  /// parents first.
  pub(crate) fn fact_log(&mut self, history: &NotesHistory) -> GitResult<()> {
    let format = self.algorithm.name();
    // The facts of each group of a tree's notes that share an attachment,
    // derived once: they depend on those notes alone, since a record's fact
    // names its attachment, so only a record of another note on the same
    // object can repeat it (§5.2, 3). A group is most often one note.
    let mut by_group: HashMap<Vec<NoteAt>, Vec<Fact>> = HashMap::new();
    let groups_of = |commit: &NotesCommit| -> Vec<Vec<NoteAt>> {
      let mut groups: Vec<Vec<NoteAt>> = Vec::new();
      for note in &commit.notes {
        match groups.iter_mut().find(|group| group[0].attachment == note.attachment) {
          Some(group) => group.push(note.clone()),
          None => groups.push(vec![note.clone()]),
        }
      }
      groups
    };
    for commit in &history.commits {
      for group in groups_of(commit) {
        if by_group.contains_key(&group) {
          continue;
        }
        let mut notes = Vec::with_capacity(group.len());
        for note in &group {
          notes.push(Note { attachment: note.attachment.clone(), bytes: self.note_bytes(&note.blob)? });
        }
        let facts = facts_of_notes(&notes, format, |id| self.fact_name(id));
        by_group.insert(group, facts);
      }
    }
    let mut children: HashMap<&str, usize> = HashMap::new();
    for commit in &history.commits {
      for parent in &commit.parents {
        *children.entry(parent.as_str()).or_default() += 1;
      }
    }
    let mut entries: HashMap<String, NativeId> = HashMap::new();
    let mut states: HashMap<String, State> = HashMap::new();
    // Written once the chain is derived, in the store's order for them
    // (storage.md §3.2): every fact in byte order of ID, then the entries in
    // the order the walk leaves their notes commits.
    let mut facts: BTreeMap<NativeId, Vec<u8>> = BTreeMap::new();
    let mut bodies: Vec<Vec<u8>> = Vec::with_capacity(history.commits.len());
    for commit in &history.commits {
      let joined = State::join(commit.parents.iter().filter_map(|parent| states.get(parent)));
      let mut given: HashMap<NativeId, &Fact> = HashMap::new();
      for group in groups_of(commit) {
        for fact in &by_group[&group] {
          given.entry(fact.id()).or_insert(fact);
        }
      }
      let current = joined.current();
      let mut adds: Vec<NativeId> = given.keys().filter(|id| !current.contains(id)).copied().collect();
      let mut retires: Vec<NativeId> = current.iter().filter(|id| !given.contains_key(id)).copied().collect();
      adds.sort();
      retires.sort();
      for id in &adds {
        facts.entry(*id).or_insert_with(|| given[id].encode());
      }
      let mut parents: Vec<NativeId> = commit.parents.iter().filter_map(|parent| entries.get(parent).copied()).collect();
      parents.sort();
      parents.dedup();
      let (actor, time) = notes_commit_action(&commit.payload);
      let entry = Entry { scope: Scope::Shared, parents, adds, retires, actor, time };
      let id = entry.id();
      bodies.push(entry.encode());
      entries.insert(commit.id.clone(), id);
      states.insert(commit.id.clone(), joined.apply(id, &entry));
      for parent in &commit.parents {
        if let Some(count) = children.get_mut(parent.as_str()) {
          *count -= 1;
          if *count == 0 {
            states.remove(parent);
          }
        }
      }
    }
    for body in facts.values() {
      self.store.put_metadata(Type::Fact, body).map_err(store_error)?;
    }
    for body in &bodies {
      self.store.put_metadata(Type::FactLogEntry, body).map_err(store_error)?;
    }
    Ok(())
  }
}
