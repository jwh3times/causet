//! The canonical JSON profile (`docs/canonical-json/`, `src/canonical-json.js`)
//! and the legacy sorted-key serializer that record digests still use
//! (`canonicalJson` in `src/metadata.js`).

use crate::json::{Object, Value, js, lossy, number_to_string, quote, stringify};

pub const CANONICAL_JSON_PROFILE: &str = "causet.canonical-json/v1";

const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// Why a value has no canonical form; the message is the JavaScript one.
#[derive(Debug, PartialEq, Eq)]
pub struct CanonicalError(pub String);

/// The canonical bytes of `value` under `causet.canonical-json/v1`.
pub fn canonical_json(value: &Value) -> Result<String, CanonicalError> {
  let mut out = String::new();
  serialize(&mut out, value, "$")?;
  Ok(out)
}

/// The bytes a document's hash and signatures cover: the document without its
/// reserved top-level `integrity` and `signatures` members.
pub fn hashed_payload(value: &Value) -> Result<String, CanonicalError> {
  match value {
    Value::Object(object) => {
      let mut copy = object.clone();
      copy.remove("integrity");
      copy.remove("signatures");
      canonical_json(&Value::Object(copy))
    }
    // `delete null.integrity` is a TypeError; on any other primitive it is a no-op.
    Value::Null => Err(CanonicalError(
      "Cannot convert undefined or null to object".into(),
    )),
    other => canonical_json(other),
  }
}

fn serialize(out: &mut String, value: &Value, path: &str) -> Result<(), CanonicalError> {
  match value {
    Value::Null => out.push_str("null"),
    Value::Bool(flag) => out.push_str(if *flag { "true" } else { "false" }),
    Value::String(units) => out.push_str(&quote(units)),
    Value::Number(number) => {
      if !(number.fract() == 0.0 && number.abs() <= MAX_SAFE_INTEGER) {
        return Err(CanonicalError(format!(
          "{path} is {}; {CANONICAL_JSON_PROFILE} accepts only integers with a magnitude of at most 2^53 - 1",
          number_to_string(*number)
        )));
      }
      if *number == 0.0 && number.is_sign_negative() {
        return Err(CanonicalError(format!(
          "{path} is negative zero; {CANONICAL_JSON_PROFILE} forbids it because serialization would lose the sign"
        )));
      }
      out.push_str(&number_to_string(*number));
    }
    Value::Array(items) => {
      out.push('[');
      for (index, item) in items.iter().enumerate() {
        if index > 0 {
          out.push(',');
        }
        serialize(out, item, &format!("{path}[{index}]"))?;
      }
      out.push(']');
    }
    Value::Object(object) => {
      // `Array.prototype.sort` compares UTF-16 code units, as RFC 8785 requires.
      let mut keys = object.keys();
      keys.sort();
      out.push('{');
      for (index, key) in keys.into_iter().enumerate() {
        if index > 0 {
          out.push(',');
        }
        out.push_str(&quote(key));
        out.push(':');
        serialize(
          out,
          object.get_units(key).expect("own key"),
          &format!("{path}.{}", lossy(key)),
        )?;
      }
      out.push('}');
    }
  }
  Ok(())
}

/// `canonicalJson` of `src/metadata.js`: every object's members are sorted by
/// UTF-16 code units and re-created, so ECMAScript property order then puts
/// array-index names first, and `JSON.stringify` writes the result. Frozen:
/// envelopes persist digests made with it.
pub fn legacy_canonical_json(value: &Value) -> String {
  stringify(&sorted(value))
}

fn sorted(value: &Value) -> Value {
  match value {
    Value::Array(items) => Value::Array(items.iter().map(sorted).collect()),
    Value::Object(object) => {
      let mut keys: Vec<_> = object.keys().into_iter().cloned().collect();
      keys.sort();
      let mut copy = Object::new();
      for key in keys {
        let member = sorted(object.get_units(&key).expect("own key"));
        copy.insert(key, member);
      }
      Value::Object(copy)
    }
    other => other.clone(),
  }
}

/// `{ attachment, record }` digested as `src/metadata.js` does for each record.
pub fn record_digest(attachment: &str, record: &Value) -> String {
  let mut entry = Object::new();
  entry.insert(js("attachment"), Value::String(js(attachment)));
  entry.insert(js("record"), record.clone());
  crate::sha256::hex(legacy_canonical_json(&Value::Object(entry)).as_bytes())
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::json::parse;

  #[test]
  fn members_sort_by_utf16_code_units() {
    let value = parse(r#"{"ﬁ":1,"😀":2,"a":3,"A":4}"#).unwrap();
    assert_eq!(
      canonical_json(&value).unwrap(),
      r#"{"A":4,"a":3,"😀":2,"ﬁ":1}"#
    );
  }

  #[test]
  fn non_integers_and_negative_zero_are_refused_with_the_path() {
    let value = parse(r#"{"x":[1,1.5]}"#).unwrap();
    assert_eq!(
      canonical_json(&value).unwrap_err().0,
      "$.x[1] is 1.5; causet.canonical-json/v1 accepts only integers with a magnitude of at most 2^53 - 1"
    );
    assert!(
      canonical_json(&parse("-0").unwrap())
        .unwrap_err()
        .0
        .contains("negative zero")
    );
    assert_eq!(canonical_json(&parse("1.0").unwrap()).unwrap(), "1");
  }

  #[test]
  fn the_legacy_serializer_puts_index_names_first() {
    let value = parse(r#"{"b":1,"10":2,"a":3,"2":4}"#).unwrap();
    assert_eq!(
      legacy_canonical_json(&value),
      r#"{"2":4,"10":2,"a":3,"b":1}"#
    );
  }
}
