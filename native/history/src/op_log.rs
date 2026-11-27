//! The operation log (docs/native-history/operations.md §3.2): the clone's
//! operation heads, which are current, the view a reader reads, and how a
//! writer adds an operation without a lock.
//!
//! Merging several current heads is #424's (§3.3). Until then a reader that
//! finds more than one gets them as `Current::Several`, and refuses.

use crate::operation::Operation;
use causet_store::StoreError;
use causet_store::heads;
use causet_store::id::{NativeId, Type};
use causet_store::store::{Store, add_metadata};
use std::collections::{HashMap, HashSet};
use std::path::Path;

/// The clone's current state.
#[derive(Debug)]
pub enum Current {
  /// No heads directory: a store an earlier build imported, before the
  /// operation log.
  Missing,
  /// One current head, and its operation, whose view is the current view.
  One(NativeId, Operation),
  /// Several current heads, in byte order: their merge is the current view
  /// (§3.3, #424).
  Several(Vec<NativeId>),
}

/// The clone's heads, as its files name them: every head, with the strays
/// that name none. `None` without a heads directory.
pub fn heads(store: &Store) -> Result<Option<(Vec<NativeId>, Vec<String>)>, StoreError> {
  heads::list(&store.root.join(".cst"))
}

/// The heads less any that is an ancestor of another (§3.2), in byte order.
/// Each head must be an operation the store holds.
pub fn current_heads(store: &Store, heads: &[NativeId]) -> Result<Vec<NativeId>, StoreError> {
  let mut operations = Vec::with_capacity(heads.len());
  for head in heads {
    operations.push(Operation::read(store, head)?);
  }
  if heads.len() < 2 {
    return Ok(heads.to_vec());
  }
  // Every operation some head reaches through its parents, the heads
  // themselves not counted unless another reaches them.
  let mut reached: HashSet<NativeId> = HashSet::new();
  let mut stack: Vec<NativeId> = operations.iter().flat_map(|operation| operation.parents.iter().copied()).collect();
  while let Some(id) = stack.pop() {
    if reached.insert(id) {
      stack.extend(Operation::read(store, &id)?.parents);
    }
  }
  Ok(heads.iter().filter(|head| !reached.contains(head)).copied().collect())
}

/// The clone's current state (§3.2).
pub fn current(store: &Store) -> Result<Current, StoreError> {
  let Some((heads, _)) = heads(store)? else {
    return Ok(Current::Missing);
  };
  if heads.is_empty() {
    return Err(StoreError::Corrupt(format!(
      "{} holds no operation head, so the store has no current view",
      heads::directory(&store.root.join(".cst")).display()
    )));
  }
  let mut current = current_heads(store, &heads)?;
  if current.len() > 1 {
    return Ok(Current::Several(current));
  }
  let id = current.pop().expect("one current head");
  let operation = Operation::read(store, &id)?;
  Ok(Current::One(id, operation))
}

/// Writes `operation` as §3.2 says, with no lock: the operation, and these
/// other objects it names, in a new container; then its head file, created
/// exclusively; then the removal of its parents' head files. Its ID.
pub fn write(root: &Path, operation: &Operation, others: &[(Type, &[u8])]) -> Result<NativeId, StoreError> {
  let body = operation.encode();
  let mut objects: Vec<(Type, &[u8])> = others.to_vec();
  objects.push((Type::Operation, &body));
  let id = *add_metadata(root, &objects)?.last().expect("the operation's ID");
  let directory = root.join(".cst");
  heads::add(&directory, &id)?;
  heads::remove(&directory, &operation.parents)?;
  Ok(id)
}

/// The operations `from` reaches through parents, itself first, each after
/// every operation reached that names it as a parent: newest first, as
/// `cst op log` lists them. `limit` stops the walk after that many.
pub fn log(store: &Store, from: &[NativeId], limit: Option<usize>) -> Result<Vec<(NativeId, Operation)>, StoreError> {
  // Every reached operation, read once, then ordered by repeatedly taking
  // the newest whose children are all listed: Kahn's order, ties broken by
  // time and then ID so a listing is the same each time.
  let mut read: HashMap<NativeId, Operation> = HashMap::new();
  let mut stack: Vec<NativeId> = from.to_vec();
  while let Some(id) = stack.pop() {
    if read.contains_key(&id) {
      continue;
    }
    let operation = Operation::read(store, &id)?;
    stack.extend(operation.parents.iter().copied());
    read.insert(id, operation);
  }
  let mut children: HashMap<NativeId, usize> = HashMap::new();
  for operation in read.values() {
    for parent in &operation.parents {
      *children.entry(*parent).or_default() += 1;
    }
  }
  let key = |id: &NativeId, operation: &Operation| (operation.time.map(|time| time.seconds), *id);
  let mut ready: Vec<NativeId> = read.keys().filter(|id| !children.contains_key(id)).copied().collect();
  let mut listed = Vec::new();
  while !ready.is_empty() && limit.is_none_or(|limit| listed.len() < limit) {
    ready.sort_by_key(|id| key(id, &read[id]));
    let id = ready.pop().expect("one ready");
    let operation = read.remove(&id).expect("read");
    for parent in &operation.parents {
      let count = children.get_mut(parent).expect("a counted parent");
      *count -= 1;
      if *count == 0 {
        ready.push(*parent);
      }
    }
    listed.push((id, operation));
  }
  Ok(listed)
}
