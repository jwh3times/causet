//! Merging concurrent operations (docs/native-history/operations.md §3.3,
//! ADR-0047 decision 10): the view several operations leave together, from
//! the view of their latest common ancestors. Each name is merged 3-way, and
//! one the sides moved apart becomes a conflicted name; each fact-log chain's
//! heads are joined by union.

use crate::names::{Name, Target, Value};
use crate::operation::View;
use causet_store::id::NativeId;
use std::collections::BTreeSet;

/// A value as its adds and removes, a missing name being one absent add
/// (§3.3).
fn adds_and_removes(name: Option<&Name>) -> (Vec<Option<Target>>, Vec<Option<Target>>) {
  match name.map(|name| &name.value) {
    None => (vec![None], Vec::new()),
    Some(Value::Resolved(target)) => (vec![Some(target.clone())], Vec::new()),
    Some(Value::Conflicted { adds, removes }) => (adds.clone(), removes.clone()),
  }
}

/// Simplifies adds and removes (§2.2): while some remove equals an add, the
/// first such remove and the first add equal to it go. Then a value whose
/// adds are all one target resolves to it. `None` is no name at all: every
/// add left is absent.
fn simplify(mut adds: Vec<Option<Target>>, mut removes: Vec<Option<Target>>) -> Option<Value> {
  while let Some(at) = removes.iter().position(|remove| adds.contains(remove)) {
    let remove = removes.remove(at);
    let add = adds.iter().position(|add| *add == remove).expect("an equal add");
    adds.remove(add);
  }
  if adds.iter().all(|add| *add == adds[0]) {
    return adds.swap_remove(0).map(Value::Resolved);
  }
  Some(Value::Conflicted { adds, removes })
}

/// The view `sides` leave together from `base`, the view of their latest
/// common ancestors (§3.3). The sides come in byte order of their
/// operations' IDs, which orders a conflicted name's adds.
/// `without_ancestors` is given each chain's heads, the union of the
/// sides', in byte order, and returns them less any that is an ancestor of
/// another, which needs the entries.
pub fn views<E>(base: &View, sides: &[&View], mut without_ancestors: impl FnMut(Vec<NativeId>) -> Result<Vec<NativeId>, E>) -> Result<View, E> {
  let keys: BTreeSet<_> = std::iter::once(base)
    .chain(sides.iter().copied())
    .flat_map(|view| view.names.iter().map(|name| (name.kind, name.name.clone())))
    .collect();
  let mut names = Vec::with_capacity(keys.len());
  for (kind, name) in keys {
    let held = base.name(kind, &name);
    let (base_adds, base_removes) = adds_and_removes(held);
    let mut adds = Vec::new();
    let mut removes = Vec::new();
    for (at, side) in sides.iter().enumerate() {
      let (side_adds, side_removes) = adds_and_removes(side.name(kind, &name));
      adds.extend(side_adds);
      removes.extend(side_removes);
      if at > 0 {
        adds.extend(base_removes.iter().cloned());
        removes.extend(base_adds.iter().cloned());
      }
    }
    let Some(value) = simplify(adds, removes) else {
      continue;
    };
    // A side that holds the name and marks it otherwise than the base wins;
    // a mark has two values, so every such side agrees.
    let base_mark = held.is_some_and(|held| held.local);
    let local = sides.iter().filter_map(|side| side.name(kind, &name)).map(|name| name.local).find(|&mark| mark != base_mark).unwrap_or(base_mark);
    names.push(Name { kind, name, local, value });
  }
  let union = |chain: fn(&View) -> &Vec<NativeId>| -> Vec<NativeId> {
    sides.iter().flat_map(|side| chain(side).iter().copied()).collect::<BTreeSet<_>>().into_iter().collect()
  };
  let shared = without_ancestors(union(|view| &view.shared))?;
  let local = without_ancestors(union(|view| &view.local))?;
  Ok(View { shared, local, names })
}
