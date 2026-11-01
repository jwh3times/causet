//! A command's arguments as `parseArgs` in `src/cli.js` returns them.

use std::collections::HashMap;

/// An option value as `parseArgs` stores it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Opt {
  Flag,
  Value(String),
  Values(Vec<String>),
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Parsed {
  pub positionals: Vec<String>,
  pub options: HashMap<String, Opt>,
}

impl Parsed {
  /// JavaScript truthiness of `options[key]`.
  pub fn truthy(&self, key: &str) -> bool {
    match self.options.get(key) {
      None => false,
      Some(Opt::Value(value)) => !value.is_empty(),
      Some(Opt::Flag | Opt::Values(_)) => true,
    }
  }

  /// JavaScript truthiness of `positionals[index]`.
  pub fn positional(&self, index: usize) -> bool {
    self
      .positionals
      .get(index)
      .is_some_and(|value| !value.is_empty())
  }

  /// `options[key]` when it holds one value.
  pub fn value(&self, key: &str) -> Option<&str> {
    match self.options.get(key) {
      Some(Opt::Value(value)) => Some(value),
      _ => None,
    }
  }
}
