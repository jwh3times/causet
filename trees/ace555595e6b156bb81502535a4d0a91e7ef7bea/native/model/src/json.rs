//! JSON exactly as the JavaScript CLI sees it: `JSON.parse`, `JSON.stringify`,
//! and ECMAScript number formatting. Strings are UTF-16 code units, because
//! member ordering, lengths and lone surrogates are all defined in those
//! units; objects enumerate their members in ECMAScript property order.

use std::fmt::Write as _;

/// A JavaScript string: UTF-16 code units, lone surrogates included.
pub type JsString = Vec<u16>;

pub fn js(text: &str) -> JsString {
  text.encode_utf16().collect()
}

pub fn lossy(units: &[u16]) -> String {
  String::from_utf16_lossy(units)
}

#[derive(Clone, Debug)]
pub enum Value {
  Null,
  Bool(bool),
  Number(f64),
  String(JsString),
  Array(Vec<Value>),
  Object(Object),
}

/// An object's own members, unique by name, in the order they were created.
/// `JSON.parse` keeps the first position of a repeated name and its last value.
#[derive(Clone, Debug, Default)]
pub struct Object {
  entries: Vec<(JsString, Value)>,
}

impl Object {
  pub fn new() -> Self {
    Self::default()
  }

  pub fn get(&self, name: &str) -> Option<&Value> {
    let name = js(name);
    self.get_units(&name)
  }

  pub fn get_units(&self, name: &[u16]) -> Option<&Value> {
    self
      .entries
      .iter()
      .find(|(key, _)| key == name)
      .map(|(_, value)| value)
  }

  /// `CreateDataProperty`: a new name is appended, an existing one keeps its place.
  pub fn insert(&mut self, name: JsString, value: Value) {
    match self.entries.iter_mut().find(|(key, _)| *key == name) {
      Some(entry) => entry.1 = value,
      None => self.entries.push((name, value)),
    }
  }

  pub fn set(&mut self, name: &str, value: Value) {
    self.insert(js(name), value);
  }

  pub fn remove(&mut self, name: &str) {
    let name = js(name);
    self.entries.retain(|(key, _)| *key != name);
  }

  /// Own member names in ECMAScript `OrdinaryOwnPropertyKeys` order: array
  /// indices ascending, then every other name in creation order.
  pub fn keys(&self) -> Vec<&JsString> {
    let mut indices: Vec<(u32, &JsString)> = self
      .entries
      .iter()
      .filter_map(|(key, _)| array_index(key).map(|index| (index, key)))
      .collect();
    indices.sort_by_key(|(index, _)| *index);
    let mut keys: Vec<&JsString> = indices.into_iter().map(|(_, key)| key).collect();
    keys.extend(
      self
        .entries
        .iter()
        .map(|(key, _)| key)
        .filter(|key| array_index(key).is_none()),
    );
    keys
  }

  pub fn len(&self) -> usize {
    self.entries.len()
  }

  pub fn is_empty(&self) -> bool {
    self.entries.is_empty()
  }
}

/// The value of `key` as an ECMAScript array index (a canonical decimal
/// integer below 2^32 - 1), if it is one.
fn array_index(key: &[u16]) -> Option<u32> {
  if key.is_empty() || key.len() > 10 || !key.iter().all(|unit| (0x30..=0x39).contains(unit)) {
    return None;
  }
  if key.len() > 1 && key[0] == 0x30 {
    return None;
  }
  let value: u64 = key
    .iter()
    .fold(0, |acc, unit| acc * 10 + u64::from(unit - 0x30));
  (value < 4_294_967_295).then_some(value as u32)
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/// `JSON.parse(text)`; the error names the first offending position.
pub fn parse(text: &str) -> Result<Value, String> {
  let units: Vec<u16> = text.encode_utf16().collect();
  let mut parser = Parser {
    units: &units,
    at: 0,
  };
  parser.whitespace();
  let value = parser.value()?;
  parser.whitespace();
  if parser.at != units.len() {
    return Err(format!("unexpected content at {}", parser.at));
  }
  Ok(value)
}

struct Parser<'a> {
  units: &'a [u16],
  at: usize,
}

impl Parser<'_> {
  fn peek(&self) -> Option<u16> {
    self.units.get(self.at).copied()
  }

  fn whitespace(&mut self) {
    while matches!(self.peek(), Some(0x20 | 0x09 | 0x0a | 0x0d)) {
      self.at += 1;
    }
  }

  fn expect(&mut self, literal: &str) -> Result<(), String> {
    for expected in literal.encode_utf16() {
      if self.peek() != Some(expected) {
        return Err(format!("expected '{literal}' at {}", self.at));
      }
      self.at += 1;
    }
    Ok(())
  }

  fn value(&mut self) -> Result<Value, String> {
    match self.peek() {
      Some(0x7b) => self.object(),
      Some(0x5b) => self.array(),
      Some(0x22) => self.string().map(Value::String),
      Some(0x74) => self.expect("true").map(|()| Value::Bool(true)),
      Some(0x66) => self.expect("false").map(|()| Value::Bool(false)),
      Some(0x6e) => self.expect("null").map(|()| Value::Null),
      Some(unit) if unit == 0x2d || (0x30..=0x39).contains(&unit) => self.number(),
      _ => Err(format!("unexpected token at {}", self.at)),
    }
  }

  fn object(&mut self) -> Result<Value, String> {
    self.at += 1;
    let mut object = Object::new();
    self.whitespace();
    if self.peek() == Some(0x7d) {
      self.at += 1;
      return Ok(Value::Object(object));
    }
    loop {
      self.whitespace();
      if self.peek() != Some(0x22) {
        return Err(format!("expected a member name at {}", self.at));
      }
      let name = self.string()?;
      self.whitespace();
      self.expect(":")?;
      self.whitespace();
      let value = self.value()?;
      object.insert(name, value);
      self.whitespace();
      match self.peek() {
        Some(0x2c) => self.at += 1,
        Some(0x7d) => {
          self.at += 1;
          return Ok(Value::Object(object));
        }
        _ => return Err(format!("expected ',' or '}}' at {}", self.at)),
      }
    }
  }

  fn array(&mut self) -> Result<Value, String> {
    self.at += 1;
    let mut items = Vec::new();
    self.whitespace();
    if self.peek() == Some(0x5d) {
      self.at += 1;
      return Ok(Value::Array(items));
    }
    loop {
      self.whitespace();
      items.push(self.value()?);
      self.whitespace();
      match self.peek() {
        Some(0x2c) => self.at += 1,
        Some(0x5d) => {
          self.at += 1;
          return Ok(Value::Array(items));
        }
        _ => return Err(format!("expected ',' or ']' at {}", self.at)),
      }
    }
  }

  fn string(&mut self) -> Result<JsString, String> {
    self.at += 1;
    let mut out = Vec::new();
    loop {
      let unit = self
        .peek()
        .ok_or_else(|| "unterminated string".to_string())?;
      self.at += 1;
      match unit {
        0x22 => return Ok(out),
        0x5c => {
          let escape = self
            .peek()
            .ok_or_else(|| "unterminated escape".to_string())?;
          self.at += 1;
          match escape {
            0x22 => out.push(0x22),
            0x5c => out.push(0x5c),
            0x2f => out.push(0x2f),
            0x62 => out.push(0x08),
            0x66 => out.push(0x0c),
            0x6e => out.push(0x0a),
            0x72 => out.push(0x0d),
            0x74 => out.push(0x09),
            0x75 => {
              let mut code = 0u16;
              for _ in 0..4 {
                let digit = self
                  .peek()
                  .and_then(|unit| char::from_u32(u32::from(unit))?.to_digit(16));
                let digit = digit.ok_or_else(|| format!("bad \\u escape at {}", self.at))?;
                code = code * 16 + digit as u16;
                self.at += 1;
              }
              out.push(code);
            }
            _ => return Err(format!("bad escape at {}", self.at)),
          }
        }
        unit if unit < 0x20 => return Err(format!("control character in string at {}", self.at)),
        unit => out.push(unit),
      }
    }
  }

  fn number(&mut self) -> Result<Value, String> {
    let start = self.at;
    if self.peek() == Some(0x2d) {
      self.at += 1;
    }
    let digits = |parser: &mut Self| {
      let from = parser.at;
      while matches!(parser.peek(), Some(0x30..=0x39)) {
        parser.at += 1;
      }
      parser.at - from
    };
    match self.peek() {
      Some(0x30) => self.at += 1,
      Some(0x31..=0x39) => {
        digits(self);
      }
      _ => return Err(format!("bad number at {}", self.at)),
    }
    if self.peek() == Some(0x2e) {
      self.at += 1;
      if digits(self) == 0 {
        return Err(format!("bad fraction at {}", self.at));
      }
    }
    if matches!(self.peek(), Some(0x65 | 0x45)) {
      self.at += 1;
      if matches!(self.peek(), Some(0x2b | 0x2d)) {
        self.at += 1;
      }
      if digits(self) == 0 {
        return Err(format!("bad exponent at {}", self.at));
      }
    }
    let lexeme: String = self.units[start..self.at]
      .iter()
      .map(|&unit| unit as u8 as char)
      .collect();
    // Rust's parse is correctly rounded, as ECMAScript requires; an overflow
    // is infinity in both.
    lexeme
      .parse::<f64>()
      .map(Value::Number)
      .map_err(|error| error.to_string())
  }
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/// `JSON.stringify(string)`: well-formed, so a lone surrogate is escaped.
pub fn quote(units: &[u16]) -> String {
  let mut out = String::with_capacity(units.len() + 2);
  out.push('"');
  let mut index = 0;
  while index < units.len() {
    let unit = units[index];
    match unit {
      0x22 => out.push_str("\\\""),
      0x5c => out.push_str("\\\\"),
      0x08 => out.push_str("\\b"),
      0x0c => out.push_str("\\f"),
      0x0a => out.push_str("\\n"),
      0x0d => out.push_str("\\r"),
      0x09 => out.push_str("\\t"),
      0x00..=0x1f => {
        let _ = write!(out, "\\u{unit:04x}");
      }
      0xd800..=0xdbff if matches!(units.get(index + 1), Some(0xdc00..=0xdfff)) => {
        let pair = [unit, units[index + 1]];
        out.push_str(&String::from_utf16_lossy(&pair));
        index += 1;
      }
      0xd800..=0xdfff => {
        let _ = write!(out, "\\u{unit:04x}");
      }
      _ => out.push(char::from_u32(u32::from(unit)).unwrap_or('\u{fffd}')),
    }
    index += 1;
  }
  out.push('"');
  out
}

/// ECMAScript `Number::toString(10)`.
pub fn number_to_string(value: f64) -> String {
  if value.is_nan() {
    return "NaN".into();
  }
  if value == 0.0 {
    return "0".into();
  }
  if value.is_infinite() {
    return if value > 0.0 {
      "Infinity".into()
    } else {
      "-Infinity".into()
    };
  }
  let sign = if value < 0.0 { "-" } else { "" };
  // `{:e}` is the shortest round-tripping digit string, as ECMAScript's is.
  let scientific = format!("{:e}", value.abs());
  let (mantissa, exponent) = scientific.split_once('e').expect("scientific notation");
  let digits: String = mantissa.chars().filter(char::is_ascii_digit).collect();
  let k = digits.len() as i64;
  let n = exponent.parse::<i64>().expect("exponent") + 1;
  let body = if k <= n && n <= 21 {
    format!("{digits}{}", "0".repeat((n - k) as usize))
  } else if 0 < n && n <= 21 {
    format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
  } else if -6 < n && n <= 0 {
    format!("0.{}{digits}", "0".repeat((-n) as usize))
  } else {
    let exponent = n - 1;
    let sign = if exponent < 0 { "-" } else { "+" };
    let rest = if k == 1 {
      String::new()
    } else {
      format!(".{}", &digits[1..])
    };
    format!("{}{rest}e{sign}{}", &digits[..1], exponent.abs())
  };
  format!("{sign}{body}")
}

/// `JSON.stringify(value)` without indentation.
pub fn stringify(value: &Value) -> String {
  let mut out = String::new();
  write_value(&mut out, value, None, 0);
  out
}

/// `JSON.stringify(value, null, 2)`.
pub fn stringify_pretty(value: &Value) -> String {
  let mut out = String::new();
  write_value(&mut out, value, Some(2), 0);
  out
}

fn write_value(out: &mut String, value: &Value, indent: Option<usize>, depth: usize) {
  match value {
    Value::Null => out.push_str("null"),
    Value::Bool(flag) => out.push_str(if *flag { "true" } else { "false" }),
    Value::Number(number) if number.is_finite() => out.push_str(&number_to_string(*number)),
    Value::Number(_) => out.push_str("null"),
    Value::String(units) => out.push_str(&quote(units)),
    Value::Array(items) => {
      if items.is_empty() {
        out.push_str("[]");
        return;
      }
      out.push('[');
      for (index, item) in items.iter().enumerate() {
        if index > 0 {
          out.push(',');
        }
        newline(out, indent, depth + 1);
        write_value(out, item, indent, depth + 1);
      }
      newline(out, indent, depth);
      out.push(']');
    }
    Value::Object(object) => {
      if object.is_empty() {
        out.push_str("{}");
        return;
      }
      out.push('{');
      for (index, key) in object.keys().into_iter().enumerate() {
        if index > 0 {
          out.push(',');
        }
        newline(out, indent, depth + 1);
        out.push_str(&quote(key));
        out.push(':');
        if indent.is_some() {
          out.push(' ');
        }
        write_value(
          out,
          object.get_units(key).expect("own key"),
          indent,
          depth + 1,
        );
      }
      newline(out, indent, depth);
      out.push('}');
    }
  }
}

fn newline(out: &mut String, indent: Option<usize>, depth: usize) {
  if let Some(width) = indent {
    out.push('\n');
    out.push_str(&" ".repeat(width * depth));
  }
}

// ---------------------------------------------------------------------------
// Building values in Rust
// ---------------------------------------------------------------------------

pub fn string(text: &str) -> Value {
  Value::String(js(text))
}

pub fn object<const N: usize>(members: [(&str, Value); N]) -> Value {
  let mut object = Object::new();
  for (name, value) in members {
    object.set(name, value);
  }
  Value::Object(object)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn numbers_format_as_ecmascript_does() {
    for (value, text) in [
      (0.0, "0"),
      (-0.0, "0"),
      (1.0, "1"),
      (1.5, "1.5"),
      (-42.0, "-42"),
      (0.1, "0.1"),
      (1e21, "1e+21"),
      (1e20, "100000000000000000000"),
      (1.5e-7, "1.5e-7"),
      (0.000001, "0.000001"),
      (123456789.123, "123456789.123"),
      (5e-324, "5e-324"),
      (9007199254740991.0, "9007199254740991"),
    ] {
      assert_eq!(number_to_string(value), text, "{value}");
    }
  }

  #[test]
  fn parse_keeps_the_first_position_and_last_value_of_a_repeated_name() {
    let value = parse(r#"{"b":1,"2":2,"a":3,"b":4,"1":5}"#).unwrap();
    assert_eq!(stringify(&value), r#"{"1":5,"2":2,"b":4,"a":3}"#);
  }

  #[test]
  fn strings_escape_like_json_stringify() {
    let value = parse(r#""\u0000\b\t\n\f\r\u001f\"\\/\ud800😀é""#).unwrap();
    assert_eq!(
      stringify(&value),
      "\"\\u0000\\b\\t\\n\\f\\r\\u001f\\\"\\\\/\\ud800😀é\""
    );
  }

  #[test]
  fn pretty_printing_matches_two_space_indentation() {
    let value = parse(r#"{"a":[1,{"b":[]}],"c":{}}"#).unwrap();
    assert_eq!(
      stringify_pretty(&value),
      "{\n  \"a\": [\n    1,\n    {\n      \"b\": []\n    }\n  ],\n  \"c\": {}\n}"
    );
  }

  #[test]
  fn malformed_text_is_refused() {
    for text in [
      "",
      "{",
      "[1,]",
      "{\"a\" 1}",
      "01",
      "1.",
      "-",
      "\"\u{1}\"",
      "tru",
      "1 2",
    ] {
      assert!(parse(text).is_err(), "{text:?}");
    }
  }
}
