//! What `cst fsck` checks of native history (commits.md §9), beyond what
//! the store checks of every object: each native commit decodes by its
//! rules, names a tree and native commits, and, when it was imported, is
//! exactly what import derives from its preserved commit, whose tree and
//! parents it names through the alias map.

use crate::commit::{Commit, derive};
use causet_store::StoreError;
use causet_store::id::{NativeId, Type};
use causet_store::objects::{GitKind, Preserved};
use causet_store::store::Store;
use std::collections::HashMap;

/// Every problem native history's objects have, each naming its object.
pub fn problems(store: &Store) -> Result<Vec<String>, StoreError> {
  let mut problems = Vec::new();
  let mut commits = Vec::new();
  for (id, kind, _) in store.present()? {
    if kind != Type::NativeCommit {
      continue;
    }
    match Commit::decode(&store.read(&id)?.body) {
      Ok(commit) => commits.push((id, commit)),
      Err(why) => problems.push(format!("the native commit {id}: {why}")),
    }
  }
  let by_preserved: HashMap<NativeId, NativeId> = commits
    .iter()
    .filter_map(|(id, commit)| Some((commit.preserved?, *id)))
    .collect();
  for (id, commit) in &commits {
    if let Err(why) = check(store, commit, &by_preserved)? {
      problems.push(format!("the native commit {id}: {why}"));
    }
  }
  Ok(problems)
}

/// A preserved object, or why the store holds none of that ID.
fn preserved(store: &Store, id: &NativeId) -> Result<Result<Preserved, String>, StoreError> {
  match store.held(id)? {
    Some(Type::Preserved) => Ok(Preserved::decode(&store.read(id)?.body)),
    _ => Ok(Err(format!("{id} is not a preserved Git object it holds"))),
  }
}

/// The inner `Err` is the commit's problem; the outer, a read that failed.
fn check(
  store: &Store,
  commit: &Commit,
  by_preserved: &HashMap<NativeId, NativeId>,
) -> Result<Result<(), String>, StoreError> {
  let tree = commit.tree;
  let is_tree = match store.held(&tree)? {
    Some(Type::Tree) => true,
    Some(Type::Preserved) => preserved(store, &tree)?.is_ok_and(|kept| kept.kind == GitKind::Tree),
    _ => false,
  };
  if !is_tree {
    return Ok(Err(format!(
      "its tree {tree} is not a tree the store holds"
    )));
  }
  for parent in &commit.parents {
    if store.held(parent)? != Some(Type::NativeCommit) {
      return Ok(Err(format!(
        "its parent {parent} is not a native commit the store holds"
      )));
    }
  }
  let Some(source) = commit.preserved else {
    return Ok(Ok(()));
  };
  let kept = match preserved(store, &source)? {
    Ok(kept) if kept.kind == GitKind::Commit => kept,
    Ok(_) => {
      return Ok(Err(format!(
        "{source}, which it names as imported from, is not a Git commit"
      )));
    }
    Err(why) => return Ok(Err(why)),
  };
  let headers = kept.header_ids();
  let mut named = Vec::with_capacity(headers.len());
  for header in &headers {
    named.push(store.native(kept.algorithm, &header.digest)?);
  }
  let built_on = headers
    .iter()
    .zip(&named)
    .find(|(header, _)| header.first)
    .map(|(_, native)| *native);
  if built_on != Some(Some(tree)) {
    return Ok(Err(format!(
      "its tree is not the tree its preserved commit {source} names"
    )));
  }
  let parents: Vec<Option<NativeId>> = headers
    .iter()
    .zip(&named)
    .filter(|(header, _)| !header.first)
    .map(|(_, native)| native.and_then(|native| by_preserved.get(&native).copied()))
    .collect();
  if parents != commit.parents.iter().copied().map(Some).collect::<Vec<_>>() {
    return Ok(Err(format!(
      "its parents are not the native commits of the parents its preserved commit {source} names"
    )));
  }
  if derive(&kept.payload, source, tree, commit.parents.clone()) != *commit {
    return Ok(Err(format!(
      "it is not what import derives from its preserved commit {source}"
    )));
  }
  Ok(Ok(()))
}
