//! The error envelope (ADR-0021) exactly as `JSON.stringify(envelope, null, 2)`
//! renders it in `bin/vlab.js`.

use crate::front::Failure;

pub const ERROR_ENVELOPE_SCHEMA: &str = "vcs-lab.error/v1";

/// A JSON string literal as `JSON.stringify` writes one: only `"`, `\` and
/// control characters are escaped, and everything else, U+2028 included, is
/// written as itself.
pub fn string(value: &str) -> String {
  let mut out = String::with_capacity(value.len() + 2);
  out.push('"');
  for c in value.chars() {
    match c {
      '"' => out.push_str("\\\""),
      '\\' => out.push_str("\\\\"),
      '\u{8}' => out.push_str("\\b"),
      '\u{c}' => out.push_str("\\f"),
      '\n' => out.push_str("\\n"),
      '\r' => out.push_str("\\r"),
      '\t' => out.push_str("\\t"),
      c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
      c => out.push(c),
    }
  }
  out.push('"');
  out
}

pub fn envelope(failure: &Failure) -> String {
  format!(
    "{{\n  \"schema\": {},\n  \"code\": {},\n  \"message\": {},\n  \"details\": \"\",\n  \"exitCode\": 1\n}}",
    string(ERROR_ENVELOPE_SCHEMA),
    string(failure.code),
    string(&failure.message),
  )
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn strings_escape_like_json_stringify() {
    assert_eq!(string("a\"b\\c"), r#""a\"b\\c""#);
    assert_eq!(
      string("\n\t\r\u{8}\u{c}\u{1}\u{1f}"),
      r#""\n\t\r\b\f\u0001\u001f""#
    );
    assert_eq!(string("— \u{2028} \u{7f}"), "\"— \u{2028} \u{7f}\"");
  }

  #[test]
  fn the_envelope_has_the_published_member_order() {
    let failure = Failure {
      message: "x".into(),
      code: "usage-unknown-command",
    };
    assert_eq!(
      envelope(&failure),
      "{\n  \"schema\": \"vcs-lab.error/v1\",\n  \"code\": \"usage-unknown-command\",\n  \"message\": \"x\",\n  \"details\": \"\",\n  \"exitCode\": 1\n}"
    );
  }
}
