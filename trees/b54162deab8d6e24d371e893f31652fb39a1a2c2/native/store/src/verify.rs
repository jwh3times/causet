//! The store's verification (objects.md §8; storage.md §4): what `cst fsck`
//! runs. Every container is read whole, every frame is decompressed, and
//! every present copy of every object is checked against its ID and the rules
//! of its type, in every container that holds one. Every known ID must have an
//! index entry. An object absent by promise or by policy is reported by its
//! state, not as corruption. It reads the store alone and writes nothing.

use crate::StoreError;
use crate::container::{ABSENT_BY_POLICY, ABSENT_BY_PROMISE, Container, Form, PRESENT};
use crate::id::{NativeId, Type, hex};
use crate::objects::{Annotation, ChunkList, GitKind, Kind, Preserved, RefTarget, Snapshot, Target, Tree};
use crate::store::Store;
use causet_model::sha256;
use std::collections::{HashMap, HashSet};

/// What verification found. The store is sound when `problems` is empty;
/// absent objects are states, not problems.
#[derive(Clone, Debug, Default)]
pub struct Verification {
  pub containers: usize,
  /// The objects the indexes list, each once.
  pub objects: usize,
  /// The present copies checked, every container's counted.
  pub copies: usize,
  pub annotations: usize,
  /// Content no container holds present, by state (objects.md §8).
  pub absent_by_promise: Vec<NativeId>,
  pub absent_by_policy: Vec<NativeId>,
  /// Each corruption found, naming the object or container.
  pub problems: Vec<String>,
}

/// What one checked copy names, for the known-ID checks that need every
/// container read first.
enum Names {
  Nothing,
  Tree(Tree),
  Snapshot(Snapshot),
  Annotation(Annotation),
  Preserved(GitKind),
}

pub fn verify(store: &Store) -> Result<Verification, StoreError> {
  let mut found = Verification {
    containers: store.containers().len(),
    ..Verification::default()
  };
  let mut kinds: HashMap<[u8; 32], Type> = HashMap::new();
  let mut present: HashSet<[u8; 32]> = HashSet::new();
  let mut absent: HashMap<[u8; 32], u8> = HashMap::new();
  let mut named: Vec<(NativeId, Names)> = Vec::new();
  let mut preserved_kinds: HashMap<NativeId, GitKind> = HashMap::new();
  let mut subjects: HashMap<NativeId, NativeId> = HashMap::new();
  for container in store.containers() {
    let at = name(container);
    check_trailer(container, &mut found.problems)?;
    for (digest, record) in container.names.iter().zip(&container.records) {
      match kinds.get(digest) {
        Some(kind) if *kind != record.kind => found.problems.push(format!(
          "{}: it is {} in one container and {} in {at}",
          hex(digest),
          type_name(*kind),
          type_name(record.kind)
        )),
        Some(_) => {}
        None => {
          kinds.insert(*digest, record.kind);
        }
      }
      if record.state == PRESENT {
        present.insert(*digest);
      } else {
        absent.insert(*digest, record.state);
      }
    }
    let mut by_frame: Vec<Vec<usize>> = vec![Vec::new(); container.frames.len()];
    for (position, record) in container.records.iter().enumerate() {
      if record.state == PRESENT {
        by_frame[record.frame as usize].push(position);
      }
    }
    for (number, held) in by_frame.into_iter().enumerate() {
      let frame = match container.frame(number as u32) {
        Ok(frame) => frame,
        Err(error) => {
          found.problems.push(error.to_string());
          for position in held {
            found.problems.push(format!(
              "{}, its copy in {at}: it is in a frame that does not read",
              hex(&container.names[position])
            ));
          }
          continue;
        }
      };
      for position in held {
        let id = NativeId(container.names[position]);
        let record = &container.records[position];
        let start = record.offset as usize;
        let bytes = &frame[start..start + record.length as usize];
        found.copies += 1;
        match check_copy(store, &id, record.kind, record.form, bytes)? {
          Ok(names) => {
            match &names {
              Names::Preserved(kind) => {
                preserved_kinds.insert(id, *kind);
              }
              Names::Annotation(annotation) => {
                subjects.insert(id, annotation.subject);
              }
              _ => {}
            }
            named.push((id, names));
          }
          Err(why) => found.problems.push(format!("{id}, its copy in {at}: {why}")),
        }
      }
    }
  }
  // The annotation table must agree with each annotation's own subject.
  for container in store.containers() {
    for (subject, position) in &container.annotations {
      let id = NativeId(container.names[*position as usize]);
      if subjects.get(&id).is_some_and(|own| own.0 != *subject) {
        found.problems.push(format!(
          "{id}: {}'s annotation table gives it the subject {}, which is not its own",
          name(container),
          hex(subject)
        ));
      }
    }
  }
  let entry = |id: &NativeId| kinds.get(&id.0).copied();
  for (by, names) in &named {
    match names {
      Names::Tree(tree) => {
        for item in &tree.entries {
          let Target::Native(target) = &item.target else {
            continue;
          };
          let fits = match (item.kind, entry(target)) {
            (_, None) => {
              found.problems.push(format!(
                "{by}: its entry {} names {target}, which has no index entry",
                String::from_utf8_lossy(&item.name)
              ));
              continue;
            }
            (Kind::Tree, Some(Type::Tree)) => true,
            (Kind::Tree, Some(Type::Preserved)) => preserved_kinds
              .get(target)
              .is_none_or(|kind| *kind == GitKind::Tree),
            (Kind::Tree, Some(_)) => false,
            (_, Some(kind)) => kind == Type::Content,
          };
          if !fits {
            found.problems.push(format!(
              "{by}: its entry {} names {target} as a {:?} entry, which it is not",
              String::from_utf8_lossy(&item.name),
              item.kind
            ));
          }
        }
      }
      // The current snapshot is checked whole below.
      Names::Snapshot(snapshot) if *by != store.snapshot => {
        for item in &snapshot.refs {
          if let RefTarget::Direct(target) = &item.target
            && entry(target).is_none()
          {
            found.problems.push(format!(
              "{by}: its ref {} names {target}, which has no index entry",
              String::from_utf8_lossy(&item.name)
            ));
          }
        }
      }
      Names::Annotation(annotation) => {
        if entry(&annotation.subject).is_none() {
          found.problems.push(format!(
            "{by}: its subject {}, which has no index entry",
            annotation.subject
          ));
        }
      }
      Names::Nothing | Names::Preserved(_) | Names::Snapshot(_) => {}
    }
  }
  for aliases in store.aliases() {
    for (digest, native) in aliases.rows() {
      if entry(native).is_none() {
        found.problems.push(format!(
          "the {} alias row of {} names {native}, which has no index entry",
          aliases.algorithm.name(),
          hex(digest)
        ));
      }
    }
  }
  if let Err(error) = store.refs() {
    found.problems.push(error.to_string());
  }
  found.objects = kinds.len();
  found.annotations = kinds
    .values()
    .filter(|kind| **kind == Type::Annotation)
    .count();
  let mut absent: Vec<([u8; 32], u8)> = absent
    .into_iter()
    .filter(|(digest, _)| !present.contains(digest))
    .collect();
  absent.sort();
  for (digest, state) in absent {
    match state {
      ABSENT_BY_PROMISE => found.absent_by_promise.push(NativeId(digest)),
      ABSENT_BY_POLICY => found.absent_by_policy.push(NativeId(digest)),
      _ => unreachable!("a container's index admits no other state"),
    }
  }
  Ok(found)
}

/// One present copy checked: its bytes, or for a chunk list the content it
/// resolves to, hash to its ID, and its body keeps its type's rules. `Err`
/// is the copy's corruption; a store error is one this build cannot judge.
fn check_copy(
  store: &Store,
  id: &NativeId,
  kind: Type,
  form: Form,
  bytes: &[u8],
) -> Result<Result<Names, String>, StoreError> {
  match form {
    Form::Body => {}
    Form::ChunkList => {
      let list = match ChunkList::decode(bytes) {
        Ok(list) => list,
        Err(why) => return Ok(Err(why)),
      };
      // Every chunk is known, so each needs an index entry, as content, even
      // where an absent one leaves the list unresolved below. A nested list
      // has its own copies, checked in turn.
      for (chunk, _) in &list.chunks {
        match store.held(chunk) {
          None => return Ok(Err(format!("its chunk list names {chunk}, which has no index entry"))),
          Some(Type::Content) => {}
          Some(_) => return Ok(Err(format!("its chunk list names {chunk}, which is not content"))),
        }
      }
      // A chunk list's own copy is checked by the content it resolves to.
      // Content absent by promise or policy leaves it unhashed, and is not
      // corruption (objects.md §8).
      return Ok(match store.resolve(id, bytes) {
        Ok(content) if NativeId::of(Type::Content, &content) == *id => Ok(Names::Nothing),
        Ok(_) => Err("its chunks do not hash to its ID".into()),
        Err(StoreError::Absent(_)) => Ok(Names::Nothing),
        Err(StoreError::Corrupt(why)) => Err(why),
        Err(other) => return Err(other),
      });
    }
    Form::Delta => {
      return Err(StoreError::Unsupported(format!(
        "{id} is stored as a delta, which this build does not read yet (#306)"
      )));
    }
  }
  if NativeId::of(kind, bytes) != *id {
    return Ok(Err("its bytes do not hash to its ID".into()));
  }
  Ok(match kind {
    Type::Content => Ok(Names::Nothing),
    Type::Tree => Tree::decode(bytes).map(Names::Tree),
    Type::Preserved => Preserved::decode(bytes).map(|preserved| Names::Preserved(preserved.kind)),
    Type::Snapshot => Snapshot::decode(bytes).map(Names::Snapshot),
    // Only what every type shares is checked: an unknown type's payload is
    // not decoded (objects.md §7).
    Type::Annotation => Annotation::decode(bytes).map(Names::Annotation),
  })
}

/// The trailer is the SHA-256 of every byte before it (storage.md §4); the
/// container's name was checked against it when the store opened.
fn check_trailer(container: &Container, problems: &mut Vec<String>) -> Result<(), StoreError> {
  let bytes =
    std::fs::read(&container.path).map_err(|error| StoreError::io(&container.path, error))?;
  let (before, trailer) = bytes.split_at(bytes.len() - 32);
  if sha256::digest(before) != trailer {
    problems.push(format!(
      "{}: its trailer is not the SHA-256 of its bytes",
      container.path.display()
    ));
  }
  Ok(())
}

fn name(container: &Container) -> String {
  container
    .path
    .file_name()
    .map(|name| name.to_string_lossy().into_owned())
    .unwrap_or_default()
}

fn type_name(kind: Type) -> &'static str {
  match kind {
    Type::Content => "content",
    Type::Tree => "a tree",
    Type::Preserved => "a preserved Git object",
    Type::Snapshot => "a ref snapshot",
    Type::Annotation => "an annotation",
  }
}
