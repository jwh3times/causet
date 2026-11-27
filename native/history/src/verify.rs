//! What `cst fsck` checks of native history (commits.md §9), beyond what
//! the store checks of every object: each native commit decodes by its
//! rules, names a tree and native commits, and, when it was imported, is
//! exactly what import derives from its preserved commit, whose tree and
//! parents it names through the alias map; and each native tag decodes,
//! names an object a tag may name (§4.2), and, when it was imported, is
//! exactly what import derives from its preserved tag. Each fact decodes,
//! holds canonical JSON of the schema it names, and names only objects the
//! store holds, never an operation, and each fact-log entry decodes and
//! keeps the log's rules (facts.md §8). Each operation keeps
//! operations.md §7's rules, and each head file names one.

use crate::commit::{Commit, derive};
use crate::fact::Fact;
use crate::fact_log::{self, Entry, Scope};
use crate::names::{Target, Value};
use crate::op_log;
use crate::operation::Operation;
use crate::tag::{self, Tag};
use causet_store::StoreError;
use causet_store::id::{NativeId, Type};
use causet_store::objects::{GitKind, Preserved};
use causet_store::store::Store;
use std::collections::HashMap;

/// Every problem native history's objects have, each naming its object.
pub fn problems(store: &Store) -> Result<Vec<String>, StoreError> {
  let mut problems = Vec::new();
  let mut commits = Vec::new();
  let mut tags = Vec::new();
  let mut facts = HashMap::new();
  let mut entries = HashMap::new();
  let mut operations = Vec::new();
  for (id, kind, _) in store.present()? {
    match kind {
      Type::NativeCommit => match Commit::decode(&store.read(&id)?.body) {
        Ok(commit) => commits.push((id, commit)),
        Err(why) => problems.push(format!("the native commit {id}: {why}")),
      },
      Type::NativeTag => match Tag::decode(&store.read(&id)?.body) {
        Ok(tag) => tags.push((id, tag)),
        Err(why) => problems.push(format!("the native tag {id}: {why}")),
      },
      Type::Fact => match Fact::decode(&store.read(&id)?.body) {
        Ok(fact) => {
          if let Err(why) = check_fact(store, &fact)? {
            problems.push(format!("the fact {id}: {why}"));
          }
          facts.insert(id, fact.scope());
        }
        Err(why) => problems.push(format!("the fact {id}: {why}")),
      },
      Type::FactLogEntry => match Entry::decode(&store.read(&id)?.body) {
        Ok(entry) => {
          entries.insert(id, entry);
        }
        Err(why) => problems.push(format!("the fact-log entry {id}: {why}")),
      },
      Type::Operation => match Operation::decode(&store.read(&id)?.body) {
        Ok(operation) => operations.push((id, operation)),
        Err(why) => problems.push(format!("the operation {id}: {why}")),
      },
      _ => {}
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
  let tags_by_preserved: HashMap<NativeId, NativeId> = tags
    .iter()
    .filter_map(|(id, tag)| Some((tag.preserved?, *id)))
    .collect();
  for (id, tag) in &tags {
    if let Err(why) = check_tag(store, tag, &by_preserved, &tags_by_preserved)? {
      problems.push(format!("the native tag {id}: {why}"));
    }
  }
  for (id, why) in fact_log::problems(&entries, &|fact| facts.get(fact).copied()) {
    problems.push(format!("the fact-log entry {id}: {why}"));
  }
  problems.extend(operation_problems(store, &operations)?);
  Ok(problems)
}

/// A fact's problem, or a read that failed: a record that is not the
/// canonical JSON of the schema it names, names that are not its record's
/// object IDs and its subject (§3.2), or a name the store does not hold.
fn check_fact(store: &Store, fact: &Fact) -> Result<Result<(), String>, StoreError> {
  let Fact::Record { schema, subject, names, record, .. } = fact else {
    return Ok(Ok(()));
  };
  let parsed = std::str::from_utf8(record).ok().and_then(|text| causet_model::json::parse(text).ok());
  let Some(parsed) = parsed else {
    return Ok(Err("its record is not JSON".into()));
  };
  if causet_model::canonical::canonical_json(&parsed).ok().as_deref().map(str::as_bytes) != Some(record.as_slice()) {
    return Ok(Err("its record is not in the canonical JSON profile".into()));
  }
  let named = match causet_model::js::get(Some(&parsed), "schema") {
    Some(causet_model::json::Value::String(units)) => causet_model::json::lossy(units).into_bytes(),
    _ => Vec::new(),
  };
  if named != *schema {
    return Ok(Err("its schema is not its record's".into()));
  }
  let mut expected: Vec<NativeId> = Vec::new();
  for (field, id) in crate::notes::object_ids(&parsed) {
    match NativeId::from_hex(&id) {
      Some(id) => expected.push(id),
      None => return Ok(Err(format!("its record's {field} is no native ID"))),
    }
  }
  expected.extend(subject.iter().copied());
  expected.sort();
  expected.dedup();
  if expected != *names {
    return Ok(Err("its names are not its record's object IDs and its subject".into()));
  }
  for name in names {
    match store.held(name)? {
      None => return Ok(Err(format!("it names {name}, which the store does not hold"))),
      // An operation belongs to its clone and is never exchanged
      // (operations.md §1), and a shared fact is: one naming an operation
      // would carry the clone's own state with it.
      Some(Type::Operation) => {
        return Ok(Err(format!("it names the operation {name}, which belongs to its clone and is never exchanged")));
      }
      Some(_) => {}
    }
  }
  Ok(Ok(()))
}

/// Every problem of the operation log (operations.md §7): each operation
/// against §2.2's and §3.1's rules, with every parent, head and target held,
/// and each head file naming an operation the store holds.
fn operation_problems(store: &Store, operations: &[(NativeId, Operation)]) -> Result<Vec<String>, StoreError> {
  let mut problems = Vec::new();
  for (id, operation) in operations {
    let mut found = |why: String| problems.push(format!("the operation {id}: {why}"));
    for parent in &operation.parents {
      if store.held(parent)? != Some(Type::Operation) {
        found(format!("its parent {parent} is no operation the store holds"));
      }
    }
    if operation.parents.is_empty() && !operation.is_import() {
      found("it has no parent, and only import's into a new store has none".into());
    }
    for (scope, heads) in [(Scope::Shared, &operation.view.shared), (Scope::Local, &operation.view.local)] {
      let mut held = true;
      for head in heads {
        match store.held(head)? {
          // An entry that does not decode is reported as itself, above.
          Some(Type::FactLogEntry) => match fact_log::read_entry(store, head) {
            Ok(entry) if entry.scope != scope => {
              found(format!("its head {head} is an entry of the other chain"));
              held = false;
            }
            Ok(_) => {}
            Err(_) => held = false,
          },
          _ => {
            found(format!("its head {head} is no fact-log entry the store holds"));
            held = false;
          }
        }
      }
      // An entry missing below a head is the fact log's own problem, which
      // its checks report.
      if held && fact_log::without_ancestors(store, heads).is_ok_and(|kept| kept != *heads) {
        found("one of its heads is an ancestor of another".into());
      }
    }
    for name in &operation.view.names {
      let targets: Vec<&Target> = match &name.value {
        Value::Resolved(target) => vec![target],
        Value::Conflicted { adds, removes } => adds.iter().chain(removes).flatten().collect(),
      };
      for target in targets {
        let Target::Object(object) = target else { continue };
        let fits = match store.held(object)? {
          Some(Type::NativeCommit | Type::NativeTag | Type::Tree | Type::Content) => true,
          // A preserved object that does not decode is the store's problem,
          // which its own checks report; it is not the operation's.
          Some(Type::Preserved) => {
            Preserved::decode(&store.read(object)?.body).is_ok_and(|preserved| preserved.kind == GitKind::Tree)
          }
          _ => false,
        };
        if !fits {
          found(format!(
            "its {} {} names {object}, which is no native commit, native tag, tree or content the store holds",
            name.kind.word(),
            String::from_utf8_lossy(&name.name)
          ));
        }
      }
    }
  }
  if let Some((heads, strays)) = op_log::heads(store)? {
    for head in heads {
      if store.held(&head)? != Some(Type::Operation) {
        problems.push(format!("the operation head {head} names no operation the store holds"));
      }
    }
    for stray in strays {
      problems.push(format!("{stray} in .cst/op-heads/ names no operation"));
    }
  }
  Ok(problems)
}

/// A native tag's problem, or a read that failed.
fn check_tag(
  store: &Store,
  tag: &Tag,
  commits: &HashMap<NativeId, NativeId>,
  tags: &HashMap<NativeId, NativeId>,
) -> Result<Result<(), String>, StoreError> {
  let target = tag.target;
  let fits = match store.held(&target)? {
    Some(Type::NativeCommit | Type::NativeTag | Type::Tree | Type::Content) => true,
    Some(Type::Preserved) => {
      preserved(store, &target)?.is_ok_and(|kept| kept.kind == GitKind::Tree)
    }
    _ => false,
  };
  if !fits {
    return Ok(Err(format!(
      "its target {target} is not a native commit, a native tag, a tree or content the store holds"
    )));
  }
  let Some(source) = tag.preserved else {
    return Ok(Ok(()));
  };
  let kept = match preserved(store, &source)? {
    Ok(kept) if kept.kind == GitKind::Tag => kept,
    Ok(_) => {
      return Ok(Err(format!(
        "{source}, which it names as imported from, is not a Git tag"
      )));
    }
    Err(why) => return Ok(Err(why)),
  };
  let named = match kept.header_ids().into_iter().find(|header| header.first) {
    Some(header) => store.native(kept.algorithm, &header.digest)?,
    None => None,
  };
  let named = named.map(|native| {
    commits
      .get(&native)
      .or_else(|| tags.get(&native))
      .copied()
      .unwrap_or(native)
  });
  if named != Some(target) {
    return Ok(Err(format!(
      "its target is not the native form of what its preserved tag {source} names"
    )));
  }
  if tag::derive(&kept.payload, source, target) != *tag {
    return Ok(Err(format!(
      "it is not what import derives from its preserved tag {source}"
    )));
  }
  Ok(Ok(()))
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
