//! The failure envelope (ADR-0021) and its closed code vocabulary, shared by
//! every command. `src/errors.js` stays the authority for the vocabulary.

use crate::json::{Object, Value, js, stringify_pretty};
use crate::registry::{ERROR_CODES, ERROR_ENVELOPE_SCHEMA};

/// Whether `code` is a member of the published vocabulary.
pub fn is_published_code(code: &str) -> bool {
  ERROR_CODES.iter().any(|(published, _)| *published == code)
}

/// The envelope exactly as `JSON.stringify(errorEnvelope(error), null, 2)`
/// writes it in `bin/vlab.js`. A code outside the vocabulary is a defect at
/// the raise site, as it is in `CliError`.
pub fn envelope(code: &str, message: &str, details: &str, exit_code: i32) -> String {
  assert!(
    is_published_code(code),
    "'{code}' is not a published causet error code."
  );
  let mut document = Object::new();
  document.set("schema", Value::String(js(ERROR_ENVELOPE_SCHEMA)));
  document.set("code", Value::String(js(code)));
  document.set("message", Value::String(js(message)));
  document.set("details", Value::String(js(details)));
  document.set("exitCode", Value::Number(f64::from(exit_code)));
  stringify_pretty(&Value::Object(document))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn the_envelope_has_the_published_member_order() {
    assert_eq!(
      envelope("usage-unknown-command", "x", "", 1),
      "{\n  \"schema\": \"causet.error/v1\",\n  \"code\": \"usage-unknown-command\",\n  \"message\": \"x\",\n  \"details\": \"\",\n  \"exitCode\": 1\n}"
    );
  }

  #[test]
  #[should_panic(expected = "not a published causet error code")]
  fn an_unpublished_code_is_a_defect() {
    envelope("no-such-code", "x", "", 1);
  }
}
