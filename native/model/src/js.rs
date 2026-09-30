//! JavaScript value semantics over parsed JSON, for the ported commands that
//! read records and documents the way `src/` does: property access,
//! truthiness, strict equality, `ToString`, and the two sort orders
//! (`Array.prototype.sort` without a comparator, and `String.localeCompare`).
//!
//! `None` stands for `undefined`: a missing member, or a property a
//! non-object does not have.

use crate::json::{JsString, Value, js, number_to_string};
use std::cmp::Ordering;

/// `value[name]` for a JSON value: the member of a plain object, and nothing
/// for anything else (no JSON array, string or primitive has a named member a
/// command reads).
pub fn get<'a>(value: Option<&'a Value>, name: &str) -> Option<&'a Value> {
  match value {
    Some(Value::Object(object)) => object.get(name),
    _ => None,
  }
}

/// JavaScript truthiness.
pub fn truthy(value: Option<&Value>) -> bool {
  match value {
    None | Some(Value::Null) => false,
    Some(Value::Bool(flag)) => *flag,
    Some(Value::Number(number)) => *number != 0.0 && !number.is_nan(),
    Some(Value::String(units)) => !units.is_empty(),
    Some(Value::Array(_) | Value::Object(_)) => true,
  }
}

/// `left === right`. Two parsed objects or arrays are never the same object.
pub fn strict_equals(left: Option<&Value>, right: Option<&Value>) -> bool {
  match (left, right) {
    (None, None) => true,
    (Some(Value::Null), Some(Value::Null)) => true,
    (Some(Value::Bool(a)), Some(Value::Bool(b))) => a == b,
    (Some(Value::Number(a)), Some(Value::Number(b))) => a == b,
    (Some(Value::String(a)), Some(Value::String(b))) => a == b,
    _ => false,
  }
}

/// SameValueZero, as `includes`, `Set` and `Map` compare.
pub fn same_value_zero(left: Option<&Value>, right: Option<&Value>) -> bool {
  match (left, right) {
    (Some(Value::Number(a)), Some(Value::Number(b))) => a == b || (a.is_nan() && b.is_nan()),
    _ => strict_equals(left, right),
  }
}

/// `value ?? fallback` where only `null` and `undefined` fall back.
pub fn nullish(value: Option<&Value>) -> bool {
  matches!(value, None | Some(Value::Null))
}

/// ECMAScript `ToString` of a JSON value (`String(value)`, template
/// interpolation, `Array.prototype.join`).
pub fn to_js_string(value: Option<&Value>) -> JsString {
  match value {
    None => js("undefined"),
    Some(Value::Null) => js("null"),
    Some(Value::Bool(flag)) => js(if *flag { "true" } else { "false" }),
    Some(Value::Number(number)) => js(&number_to_string(*number)),
    Some(Value::String(units)) => units.clone(),
    Some(Value::Array(items)) => join(items, &js(",")),
    Some(Value::Object(_)) => js("[object Object]"),
  }
}

/// `ToString` as Rust text.
pub fn text(value: Option<&Value>) -> String {
  String::from_utf16_lossy(&to_js_string(value))
}

/// `items.join(separator)`: `null` and `undefined` items join as empty.
pub fn join(items: &[Value], separator: &[u16]) -> JsString {
  let mut out = Vec::new();
  for (index, item) in items.iter().enumerate() {
    if index > 0 {
      out.extend_from_slice(separator);
    }
    if !matches!(item, Value::Null) {
      out.extend(to_js_string(Some(item)));
    }
  }
  out
}

/// `ToNumber` of a JSON value, as the `(left, right) => left - right`
/// comparator applies it.
pub fn to_number(value: &Value) -> f64 {
  match value {
    Value::Null => 0.0,
    Value::Bool(flag) => f64::from(u8::from(*flag)),
    Value::Number(number) => *number,
    Value::String(units) => string_to_number(&String::from_utf16_lossy(units)),
    Value::Array(items) => match items.as_slice() {
      [] => 0.0,
      [only] => string_to_number(&text(Some(only))),
      _ => f64::NAN,
    },
    Value::Object(_) => f64::NAN,
  }
}

/// `StringToNumber` for the common cases: decimal, with surrounding
/// whitespace; anything else is `NaN`.
fn string_to_number(text: &str) -> f64 {
  let trimmed = text.trim();
  if trimmed.is_empty() {
    return 0.0;
  }
  let valid = trimmed
    .trim_start_matches(['+', '-'])
    .bytes()
    .all(|byte| byte.is_ascii_digit() || matches!(byte, b'.' | b'e' | b'E' | b'+' | b'-'));
  if trimmed == "Infinity" || trimmed == "+Infinity" {
    return f64::INFINITY;
  }
  if trimmed == "-Infinity" {
    return f64::NEG_INFINITY;
  }
  if valid {
    trimmed.parse().unwrap_or(f64::NAN)
  } else {
    f64::NAN
  }
}

/// `Array.prototype.sort()` without a comparator: by `ToString`, in UTF-16
/// code units, stably.
pub fn default_sort(items: &mut [Value]) {
  items.sort_by(|left, right| to_js_string(Some(left)).cmp(&to_js_string(Some(right))));
}

/// `(left, right) => left - right`. A `NaN` difference counts as equal, so
/// with a non-number present the comparator is inconsistent and the result is
/// whatever V8's algorithm makes of it; [`v8_sort_by`] reproduces that.
pub fn numeric_sort(items: &mut [Value]) {
  v8_sort_by(items, |left, right| to_number(left) - to_number(right));
}

/// `Array.prototype.sort(comparator)` as V8 runs it. Below 64 elements that
/// is one counted run extended by binary insertion (V8's TimSort), exactly;
/// above, any stable sort gives the same order for a consistent comparator,
/// which is the only kind a larger array meets here.
pub fn v8_sort_by<T: Clone>(items: &mut [T], compare: impl Fn(&T, &T) -> f64) {
  let order = |left: &T, right: &T| {
    let value = compare(left, right);
    if value.is_nan() { 0.0 } else { value }
  };
  let length = items.len();
  if length < 2 {
    return;
  }
  if length >= 64 {
    items.sort_by(|left, right| {
      order(left, right)
        .partial_cmp(&0.0)
        .unwrap_or(Ordering::Equal)
    });
    return;
  }
  // CountAndMakeRun.
  let mut run = 2;
  let descending = order(&items[1], &items[0]) < 0.0;
  while run < length {
    let step = order(&items[run], &items[run - 1]);
    if (descending && step >= 0.0) || (!descending && step < 0.0) {
      break;
    }
    run += 1;
  }
  if descending {
    items[..run].reverse();
  }
  // BinaryInsertionSort over the rest.
  for start in run..length {
    let pivot = items[start].clone();
    let (mut left, mut right) = (0, start);
    while left < right {
      let middle = left + ((right - left) >> 1);
      if order(&pivot, &items[middle]) < 0.0 {
        right = middle;
      } else {
        left = middle + 1;
      }
    }
    items[left..=start].rotate_right(1);
    items[left] = pivot;
  }
}

/// The collation `String.prototype.localeCompare` applies under Node's ICU
/// root locale, for the text a command sorts this way: family names, spellings,
/// member names and timestamps, which are ASCII. Characters compare first by
/// their primary weight (whitespace, then punctuation and symbols in ICU's
/// order, then digits, then letters without regard to case); a tie is broken
/// by case, lowercase first. Text outside ASCII keeps code-point order after
/// every ASCII character, which is an approximation the ported commands never
/// meet in practice.
pub fn locale_compare(left: &str, right: &str) -> Ordering {
  let primary = |text: &str| text.chars().map(primary_weight).collect::<Vec<_>>();
  primary(left).cmp(&primary(right)).then_with(|| {
    let tertiary = |text: &str| {
      text
        .chars()
        .map(|c| u8::from(c.is_ascii_uppercase()))
        .collect::<Vec<_>>()
    };
    tertiary(left).cmp(&tertiary(right))
  })
}

const ICU_ASCII_ORDER: &str =
  "\t\n\u{b}\u{c}\r _-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$0123456789abcdefghijklmnopqrstuvwxyz";

fn primary_weight(c: char) -> u32 {
  let folded = c.to_ascii_lowercase();
  match ICU_ASCII_ORDER.find(folded) {
    Some(index) => index as u32,
    None => 0x100 + c as u32,
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::json::parse;

  #[test]
  fn to_string_follows_ecmascript() {
    let value = parse(r#"[1, "a", null, [2, [3]], {"x": 1}, true, 1e21]"#).unwrap();
    assert_eq!(text(Some(&value)), "1,a,,2,3,[object Object],true,1e+21");
    assert_eq!(text(None), "undefined");
  }

  #[test]
  fn sorts_follow_the_javascript_orders() {
    let mut items = match parse(r#"["b", 10, "a", 9, null, "B"]"#).unwrap() {
      Value::Array(items) => items,
      _ => unreachable!(),
    };
    default_sort(&mut items);
    assert_eq!(text(Some(&Value::Array(items))), "10,9,B,a,b,");
    let mut numbers = match parse(r#"[3, "1", 2, "x", 0]"#).unwrap() {
      Value::Array(items) => items,
      _ => unreachable!(),
    };
    numeric_sort(&mut numbers);
    assert_eq!(text(Some(&Value::Array(numbers))), "0,1,2,3,x");
  }

  #[test]
  fn locale_compare_orders_names_as_icu_does() {
    let mut names = vec![
      "causet.rebase-application",
      "causet.rebase",
      "causet.landing",
      "Zeta",
      "alpha",
      "Alpha",
      "a_b",
      "a-b",
      "a.b",
      "a1",
      "2026-09-30T12:00:00.000Z",
      "2026-09-30T12:00:00Z",
      "",
    ];
    names.sort_by(|left, right| locale_compare(left, right));
    assert_eq!(
      names,
      [
        "",
        "2026-09-30T12:00:00.000Z",
        "2026-09-30T12:00:00Z",
        "a_b",
        "a-b",
        "a.b",
        "a1",
        "alpha",
        "Alpha",
        "causet.landing",
        "causet.rebase",
        "causet.rebase-application",
        "Zeta",
      ]
    );
  }
}
