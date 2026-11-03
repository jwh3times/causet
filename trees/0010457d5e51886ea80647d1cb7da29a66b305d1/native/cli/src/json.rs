//! The failure envelope (ADR-0021) for a front-end refusal, rendered by the
//! shared record model so every command writes the same bytes.

use crate::front::Failure;

pub fn envelope(failure: &Failure) -> String {
  causet_model::errors::envelope(failure.code, &failure.message, "", 1)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn front_end_refusals_render_the_published_envelope() {
    let failure = Failure {
      message: "x".into(),
      code: "usage-unknown-command",
    };
    assert_eq!(
      envelope(&failure),
      "{\n  \"schema\": \"causet.error/v1\",\n  \"code\": \"usage-unknown-command\",\n  \"message\": \"x\",\n  \"details\": \"\",\n  \"exitCode\": 1\n}"
    );
  }

  #[test]
  fn every_front_end_code_is_published() {
    for code in [
      "usage-conflicting-options",
      "usage-invalid-option-value",
      "usage-missing-argument",
      "usage-unknown-command",
    ] {
      assert!(causet_model::errors::is_published_code(code), "{code}");
    }
  }
}
