//! The fact log (facts.md §4): two chains of entries, shared and local, each
//! joined by union. An entry adds facts and retires facts current at its
//! parents, so the log is an observed-remove set.

use crate::action::{ActionActor, Time};
use crate::fact::{decode_ids, encode_ids};
use causet_store::encoding::Reader;
use causet_store::id::{NativeId, Type};
use std::collections::{BTreeSet, HashMap, HashSet};

/// Which chain an entry belongs to (§3.4).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Scope {
  /// Exchanged with other clones from N5 on.
  Shared = 1,
  /// The clone's own, never exchanged.
  Local = 2,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
  pub scope: Scope,
  /// Entries of the same scope, in byte order.
  pub parents: Vec<NativeId>,
  /// The facts it adds, in byte order.
  pub adds: Vec<NativeId>,
  /// The facts current at its parents that it retires, in byte order.
  pub retires: Vec<NativeId>,
  /// Who wrote it; an imported entry may have none (§5.1).
  pub actor: Option<ActionActor>,
  pub time: Option<Time>,
}

impl Entry {
  pub fn encode(&self) -> Vec<u8> {
    let mut out = Vec::new();
    out.push(self.scope as u8);
    encode_ids(&self.parents, &mut out);
    encode_ids(&self.adds, &mut out);
    encode_ids(&self.retires, &mut out);
    ActionActor::encode_optional(&self.actor, &mut out);
    Time::encode_optional(&self.time, &mut out);
    out
  }

  /// A body, checked against the rules a body alone can be held to: that its
  /// parents, adds and retires have its scope, and that what it adds and
  /// retires fits what is current at its parents, need the store.
  pub fn decode(body: &[u8]) -> Result<Entry, String> {
    let mut reader = Reader::new(body);
    let scope = match reader.u8()? {
      0x01 => Scope::Shared,
      0x02 => Scope::Local,
      code => return Err(format!("an entry has the scope {code:02x}, which is not one")),
    };
    let parents = decode_ids(&mut reader, "parents")?;
    let adds = decode_ids(&mut reader, "adds")?;
    let retires = decode_ids(&mut reader, "retires")?;
    let actor = ActionActor::decode_optional(&mut reader)?;
    let time = Time::decode_optional(&mut reader)?;
    if !reader.rest().is_empty() {
      return Err("an entry has bytes after its time".into());
    }
    Ok(Entry { scope, parents, adds, retires, actor, time })
  }

  pub fn id(&self) -> NativeId {
    NativeId::of(Type::FactLogEntry, &self.encode())
  }
}

/// What is current at an entry or a set of heads (§4.1): each add still
/// alive, as the fact and the entry that added it, and each add some reached
/// entry retired, so that a join never brings one back.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct State {
  alive: BTreeSet<(NativeId, NativeId)>,
  removed: BTreeSet<(NativeId, NativeId)>,
}

impl State {
  /// The state at no entry: nothing current.
  pub fn empty() -> State {
    State::default()
  }

  /// The state at several entries together, given the state at each: every
  /// add any of them keeps, less every add any of them saw retired.
  pub fn join<'a>(states: impl IntoIterator<Item = &'a State>) -> State {
    let mut joined = State::empty();
    for state in states {
      joined.alive.extend(state.alive.iter().copied());
      joined.removed.extend(state.removed.iter().copied());
    }
    let removed = &joined.removed;
    joined.alive.retain(|pair| !removed.contains(pair));
    joined
  }

  /// The state at `entry`, `id`, from the join of its parents' states: its
  /// retires remove every add of those facts it has seen, and its adds are
  /// alive.
  pub fn apply(mut self, id: NativeId, entry: &Entry) -> State {
    for fact in &entry.retires {
      let seen: Vec<(NativeId, NativeId)> = self.adds_of(fact).copied().collect();
      for pair in seen {
        self.alive.remove(&pair);
        self.removed.insert(pair);
      }
    }
    for fact in &entry.adds {
      self.alive.insert((*fact, id));
    }
    self
  }

  /// The facts current here.
  pub fn current(&self) -> BTreeSet<NativeId> {
    self.alive.iter().map(|(fact, _)| *fact).collect()
  }

  /// Whether a fact is current here.
  pub fn is_current(&self, fact: &NativeId) -> bool {
    self.adds_of(fact).next().is_some()
  }

  /// The adds of a fact still alive here, with the entries that made them.
  fn adds_of(&self, fact: &NativeId) -> impl Iterator<Item = &(NativeId, NativeId)> {
    self.alive.range((*fact, NativeId([0; 32]))..=(*fact, NativeId([0xff; 32])))
  }

  /// The state at `heads`, reading every entry they reach with `read`.
  pub fn at<E>(heads: &[NativeId], mut read: impl FnMut(&NativeId) -> Result<Entry, E>) -> Result<State, E> {
    // Every entry reached, parents before children.
    let mut order: Vec<(NativeId, Entry)> = Vec::new();
    let mut seen: HashSet<NativeId> = HashSet::new();
    let mut stack: Vec<(NativeId, Option<Entry>)> = heads.iter().rev().map(|id| (*id, None)).collect();
    while let Some((id, read_entry)) = stack.pop() {
      match read_entry {
        Some(entry) => order.push((id, entry)),
        None => {
          if !seen.insert(id) {
            continue;
          }
          let entry = read(&id)?;
          let parents: Vec<NativeId> = entry.parents.clone();
          stack.push((id, Some(entry)));
          for parent in parents.iter().rev() {
            if !seen.contains(parent) {
              stack.push((*parent, None));
            }
          }
        }
      }
    }
    let mut states: HashMap<NativeId, State> = HashMap::new();
    for (id, entry) in &order {
      let joined = State::join(entry.parents.iter().filter_map(|parent| states.get(parent)));
      states.insert(*id, joined.apply(*id, entry));
    }
    Ok(State::join(heads.iter().filter_map(|head| states.get(head))))
  }
}

/// Every problem of a fact log's entries (facts.md §4.1, §8), each with the
/// entry it is in: a parent that is no entry the store holds, or is of the
/// other scope; and an add of a fact already current at its parents, or a
/// retire of one that is not; and a fact of the other scope. `facts` gives
/// the scope of each fact the store holds.
pub fn problems(entries: &HashMap<NativeId, Entry>, facts: &impl Fn(&NativeId) -> Option<Scope>) -> Vec<(NativeId, String)> {
  let mut problems = Vec::new();
  let mut ids: Vec<&NativeId> = entries.keys().collect();
  ids.sort();
  // Parents first, as `State::at` reads them; an entry whose parents are
  // missing is checked against the parents it has.
  let mut order: Vec<NativeId> = Vec::new();
  let mut seen: HashSet<NativeId> = HashSet::new();
  for start in ids {
    let mut stack = vec![(*start, false)];
    while let Some((id, expanded)) = stack.pop() {
      if expanded {
        order.push(id);
        continue;
      }
      if !seen.insert(id) {
        continue;
      }
      stack.push((id, true));
      for parent in entries[&id].parents.iter().rev() {
        if entries.contains_key(parent) && !seen.contains(parent) {
          stack.push((*parent, false));
        }
      }
    }
  }
  let mut states: HashMap<NativeId, State> = HashMap::new();
  for id in order {
    let entry = &entries[&id];
    for parent in &entry.parents {
      match entries.get(parent) {
        None => problems.push((id, format!("its parent {parent} is no fact-log entry the store holds"))),
        Some(other) if other.scope != entry.scope => {
          problems.push((id, format!("its parent {parent} is an entry of the other chain")));
        }
        Some(_) => {}
      }
    }
    let joined = State::join(entry.parents.iter().filter_map(|parent| states.get(parent)));
    for fact in entry.adds.iter().chain(&entry.retires) {
      match facts(fact) {
        None => problems.push((id, format!("it adds or retires {fact}, which is no fact the store holds"))),
        Some(scope) if scope != entry.scope => {
          problems.push((id, format!("it adds or retires {fact}, a fact of the other chain")));
        }
        Some(_) => {}
      }
    }
    for fact in &entry.adds {
      if joined.is_current(fact) {
        problems.push((id, format!("it adds {fact}, which is current at its parents already")));
      }
    }
    for fact in &entry.retires {
      if !joined.is_current(fact) {
        problems.push((id, format!("it retires {fact}, which is not current at its parents")));
      }
    }
    states.insert(id, joined.apply(id, entry));
  }
  problems
}
