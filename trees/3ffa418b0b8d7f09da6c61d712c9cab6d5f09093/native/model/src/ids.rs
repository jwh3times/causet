//! Logical identifiers (`src/ids.js`, `docs/identity/README.md`):
//! `<namespace>_<minted><random>`, where `minted` is the millisecond clock in
//! base 36 padded to nine characters and `random` is 48 bits in hex.

use std::time::{SystemTime, UNIX_EPOCH};

pub const LOGICAL_ID_PROFILE: &str = "causet.logical-id/v1";
pub const ID_ENTROPY_BITS: u32 = 48;

/// Every namespace an identifier may carry, and what it names. Closed: a name
/// outside this list is not a causet logical identifier.
pub const ID_NAMESPACES: &[(&str, &str)] = &[
  (
    "ch",
    "a logical change, carried by the Change-Id commit trailer",
  ),
  ("land", "a landing receipt"),
  ("apply", "an application receipt"),
  ("reconcile", "a reconciliation receipt"),
  ("reconcile_op", "a worktree-private reconciliation journal"),
  ("rebase", "a completed causal rebase receipt"),
  ("rebase_apply", "a rebase application receipt"),
  ("rebase_op", "a worktree-private rebase journal"),
  ("forecast", "a stored reconciliation forecast"),
  ("rebase_forecast", "a stored rebase forecast"),
  ("resolution", "a recorded conflict resolution"),
  ("ws", "a workspace registry entry"),
  ("prov", "a declared authorship provenance record"),
  ("artifact", "a specification artifact"),
  ("disposition", "a local decision about a parked conflict"),
  (
    "amend",
    "a recorded divergence between what an identity contained before an interactive edit and after",
  ),
  (
    "absorb",
    "an interactive absorption of one or more identities into a surviving commit",
  ),
];

/// Mint an identifier in `namespace` from the clock and the system CSPRNG.
pub fn new_id(namespace: &str) -> Result<String, String> {
  let millis = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map_err(|error| error.to_string())?
    .as_millis();
  let mut random = [0u8; 6];
  getrandom::fill(&mut random).map_err(|error| error.to_string())?;
  let random: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
  Ok(format!("{namespace}_{:0>9}{random}", base36(millis)))
}

fn base36(mut value: u128) -> String {
  if value == 0 {
    return "0".into();
  }
  let mut digits = Vec::new();
  while value > 0 {
    digits.push(std::char::from_digit((value % 36) as u32, 36).expect("digit"));
    value /= 36;
  }
  digits.iter().rev().collect()
}

#[derive(Debug, PartialEq, Eq)]
pub enum ParsedId {
  Valid {
    namespace: String,
    minted: String,
    random: String,
  },
  Invalid {
    reason: &'static str,
    namespace: Option<String>,
  },
}

/// `parseLogicalId`: the parts of an identifier, or why it is not one.
pub fn parse_logical_id(value: Option<&str>) -> ParsedId {
  let invalid = |reason| ParsedId::Invalid {
    reason,
    namespace: None,
  };
  let Some(value) = value.filter(|value| !value.is_empty()) else {
    return invalid("not-a-string");
  };
  if value.starts_with("git:") {
    return invalid("commit-fallback-identity");
  }
  // `^(?<namespace>[a-z][a-z_]*)_(?<minted>[0-9a-z]{9})(?<random>[0-9a-f]{12})$`:
  // the tail is fixed-length, so the namespace is everything before it.
  let bytes = value.as_bytes();
  if !value.is_ascii() || bytes.len() < 23 || bytes[bytes.len() - 22] != b'_' {
    return invalid("malformed");
  }
  let (namespace, tail) = value.split_at(bytes.len() - 22);
  let (minted, random) = tail[1..].split_at(9);
  let namespace_ok = namespace.as_bytes()[0].is_ascii_lowercase()
    && namespace
      .bytes()
      .all(|byte| byte.is_ascii_lowercase() || byte == b'_');
  let minted_ok = minted
    .bytes()
    .all(|byte| byte.is_ascii_digit() || byte.is_ascii_lowercase());
  let random_ok = random
    .bytes()
    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte));
  if !(namespace_ok && minted_ok && random_ok) {
    return invalid("malformed");
  }
  if !ID_NAMESPACES.iter().any(|(name, _)| *name == namespace) {
    return ParsedId::Invalid {
      reason: "unknown-namespace",
      namespace: Some(namespace.into()),
    };
  }
  ParsedId::Valid {
    namespace: namespace.into(),
    minted: minted.into(),
    random: random.into(),
  }
}

/// `isLogicalId`: an identifier, optionally of one namespace.
pub fn is_logical_id(value: Option<&str>, namespace: Option<&str>) -> bool {
  match parse_logical_id(value) {
    ParsedId::Valid {
      namespace: found, ..
    } => namespace.is_none_or(|expected| expected == found),
    ParsedId::Invalid { .. } => false,
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn minted_identifiers_parse_back() {
    for namespace in ["ch", "land", "reconcile_op", "rebase_forecast"] {
      let id = new_id(namespace).unwrap();
      assert!(is_logical_id(Some(&id), Some(namespace)), "{id}");
      assert_eq!(id.len(), namespace.len() + 22);
    }
  }

  #[test]
  fn malformed_and_foreign_identifiers_say_why() {
    assert_eq!(
      parse_logical_id(Some("git:abc")),
      ParsedId::Invalid {
        reason: "commit-fallback-identity",
        namespace: None
      }
    );
    assert_eq!(
      parse_logical_id(Some("ch_0mulzqqkl9a8129884dd6x")),
      ParsedId::Invalid {
        reason: "malformed",
        namespace: None
      }
    );
    assert_eq!(
      parse_logical_id(Some("zzz_0mulzqqkl9a8129884dd6")),
      ParsedId::Invalid {
        reason: "unknown-namespace",
        namespace: Some("zzz".into())
      }
    );
    assert!(is_logical_id(
      Some("reconcile_op_0mulzqqkl9a8129884dd6"),
      Some("reconcile_op")
    ));
  }
}
