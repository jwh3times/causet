//! The JavaScript string operations the Git engine applies to Git's output,
//! reproduced exactly: `String.prototype.trim`, `split(/\r?\n/)`,
//! `split(/\s+/)`, `Number(text)`, the default `Array.prototype.sort`, the
//! `Change-Id` trailer expression, and `path.resolve` / `path.join`.

/// ECMAScript `WhiteSpace` and `LineTerminator`: what `\s` and `trim` match.
pub fn is_space(c: char) -> bool {
  matches!(
    c,
    '\u{9}' | '\u{a}' | '\u{b}' | '\u{c}' | '\u{d}' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
      ..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
  )
}

/// ECMAScript `LineTerminator`: where `^` and `$` match in multiline mode and
/// what `.` refuses.
pub fn is_line_terminator(c: char) -> bool {
  matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// `text.trim()`.
pub fn trim(text: &str) -> &str {
  text.trim_matches(is_space)
}

/// `text.split(/\r?\n/)`: a `\r` is removed only where a `\n` follows it.
pub fn split_lines(text: &str) -> Vec<&str> {
  let mut out = Vec::new();
  let mut rest = text;
  loop {
    match rest.find('\n') {
      Some(index) => {
        let line = &rest[..index];
        out.push(line.strip_suffix('\r').unwrap_or(line));
        rest = &rest[index + 1..];
      }
      None => {
        out.push(rest);
        return out;
      }
    }
  }
}

/// `text.split(/\s+/)`, including the empty first or last field a leading or
/// trailing run produces.
pub fn split_space_runs(text: &str) -> Vec<&str> {
  let mut out = Vec::new();
  let mut start = 0;
  let mut in_run = false;
  let mut run_start = 0;
  for (index, c) in text.char_indices() {
    if is_space(c) {
      if !in_run {
        in_run = true;
        run_start = index;
      }
    } else if in_run {
      out.push(&text[start..run_start]);
      start = index;
      in_run = false;
    }
  }
  if in_run {
    out.push(&text[start..run_start]);
    out.push("");
  } else {
    out.push(&text[start..]);
  }
  out
}

/// `Number(text)`: ECMAScript `StringToNumber`.
pub fn number(text: &str) -> f64 {
  let text = trim(text);
  if text.is_empty() {
    return 0.0;
  }
  for (prefix, radix) in [
    ("0x", 16),
    ("0X", 16),
    ("0o", 8),
    ("0O", 8),
    ("0b", 2),
    ("0B", 2),
  ] {
    if let Some(digits) = text.strip_prefix(prefix) {
      if digits.is_empty() || !digits.chars().all(|c| c.is_digit(radix)) {
        return f64::NAN;
      }
      return digits.chars().fold(0.0, |total, c| {
        total * f64::from(radix) + f64::from(c.to_digit(radix).unwrap_or(0))
      });
    }
  }
  let (negative, body) = match text.as_bytes()[0] {
    b'-' => (true, &text[1..]),
    b'+' => (false, &text[1..]),
    _ => (false, text),
  };
  let magnitude = if body == "Infinity" {
    f64::INFINITY
  } else if decimal_literal(body) {
    body.parse::<f64>().unwrap_or(f64::NAN)
  } else {
    return f64::NAN;
  };
  if negative { -magnitude } else { magnitude }
}

/// `StrUnsignedDecimalLiteral` without `Infinity`.
fn decimal_literal(text: &str) -> bool {
  let bytes = text.as_bytes();
  let mut index = 0;
  let digits = |index: &mut usize| {
    let start = *index;
    while *index < bytes.len() && bytes[*index].is_ascii_digit() {
      *index += 1;
    }
    *index - start
  };
  let whole = digits(&mut index);
  let mut fraction = 0;
  if index < bytes.len() && bytes[index] == b'.' {
    index += 1;
    fraction = digits(&mut index);
  }
  if whole == 0 && fraction == 0 {
    return false;
  }
  if index < bytes.len() && (bytes[index] == b'e' || bytes[index] == b'E') {
    index += 1;
    if index < bytes.len() && (bytes[index] == b'+' || bytes[index] == b'-') {
      index += 1;
    }
    if digits(&mut index) == 0 {
      return false;
    }
  }
  index == bytes.len()
}

/// The default `Array.prototype.sort` order: UTF-16 code units.
pub fn compare(left: &str, right: &str) -> std::cmp::Ordering {
  left.encode_utf16().cmp(right.encode_utf16())
}

pub fn sort(items: &mut [String]) {
  items.sort_by(|left, right| compare(left, right));
}

/// `extractTrailer(message, name)`: the first match of
/// `new RegExp("^" + name + ":\\s*(.+?)\\s*$", "im")`, trimmed.
///
/// The expression is evaluated as the JavaScript engine backtracks it,
/// including its surprises: `\s*` crosses line ends, so an empty trailer takes
/// the next line, and a trailer of only spaces at the end of the message
/// yields the empty string rather than no match.
pub fn extract_trailer(message: &str, name: &str) -> Option<String> {
  let chars: Vec<char> = message.chars().collect();
  let pattern: Vec<char> = format!("{name}:").chars().collect();
  let length = chars.len();
  // Only an ASCII character can match an ASCII pattern character under a
  // non-Unicode `i` flag: canonicalization never maps a non-ASCII character
  // to an ASCII one.
  let same = |pattern: char, actual: char| {
    actual.is_ascii() && pattern.to_ascii_uppercase() == actual.to_ascii_uppercase()
  };
  // `\s*$`: somewhere in the whitespace run starting at `at` is the end of
  // the input or a position before a line terminator.
  let tail = |at: usize| {
    let mut position = at;
    loop {
      if position == length || is_line_terminator(chars[position]) {
        return true;
      }
      if !is_space(chars[position]) {
        return false;
      }
      position += 1;
    }
  };
  for start in 0..length {
    if start > 0 && !is_line_terminator(chars[start - 1]) {
      continue;
    }
    if start + pattern.len() > length
      || !pattern
        .iter()
        .zip(&chars[start..])
        .all(|(expected, actual)| same(*expected, *actual))
    {
      continue;
    }
    let after = start + pattern.len();
    let mut run = 0;
    while after + run < length && is_space(chars[after + run]) {
      run += 1;
    }
    for skipped in (0..=run).rev() {
      let capture = after + skipped;
      let mut end = capture;
      while end < length && !is_line_terminator(chars[end]) {
        end += 1;
        if tail(end) {
          let text: String = chars[capture..end].iter().collect();
          return Some(trim(&text).to_string());
        }
      }
    }
  }
  None
}

#[cfg(windows)]
pub const SEPARATOR: char = '\\';
#[cfg(not(windows))]
pub const SEPARATOR: char = '/';

/// `path.resolve(base, relative)`: absolute, normalized, and without a
/// trailing separator except at a root. Symbolic links are not followed.
pub fn resolve(base: &str, relative: &str) -> String {
  let joined = std::path::Path::new(base).join(relative);
  resolve_path(&joined.to_string_lossy())
}

/// `path.resolve(path)`.
#[cfg(windows)]
pub fn resolve_path(path: &str) -> String {
  let text = if path.is_empty() { "." } else { path };
  let absolute = std::path::absolute(text)
    .map(|value| value.to_string_lossy().into_owned())
    .unwrap_or_else(|_| text.replace('/', "\\"));
  strip_trailing(absolute)
}

#[cfg(not(windows))]
pub fn resolve_path(path: &str) -> String {
  let absolute = if path.starts_with('/') {
    path.to_string()
  } else {
    let current = std::env::current_dir()
      .map(|value| value.to_string_lossy().into_owned())
      .unwrap_or_else(|_| "/".into());
    format!("{current}/{path}")
  };
  let mut parts: Vec<&str> = Vec::new();
  for part in absolute.split('/') {
    match part {
      "" | "." => {}
      ".." => {
        parts.pop();
      }
      other => parts.push(other),
    }
  }
  format!("/{}", parts.join("/"))
}

#[cfg(windows)]
fn strip_trailing(mut path: String) -> String {
  while path.len() > 3 && path.ends_with('\\') {
    path.pop();
  }
  path
}

/// `path.join(directory, name)` for a normalized directory and a plain name.
pub fn join(directory: &str, name: &str) -> String {
  if directory.ends_with(SEPARATOR) {
    format!("{directory}{name}")
  } else {
    format!("{directory}{SEPARATOR}{name}")
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn trim_and_splits_follow_javascript() {
    assert_eq!(trim("\u{feff} a \u{85}"), "a \u{85}");
    assert_eq!(split_lines("a\r\nb\rc\n"), ["a", "b\rc", ""]);
    assert_eq!(split_lines(""), [""]);
    assert_eq!(split_lines("x\r"), ["x\r"]);
    assert_eq!(split_space_runs(" a  b "), ["", "a", "b", ""]);
    assert_eq!(split_space_runs(""), [""]);
    assert_eq!(split_space_runs("a"), ["a"]);
  }

  #[test]
  fn number_follows_string_to_number() {
    assert_eq!(number(" 12\n"), 12.0);
    assert_eq!(number(""), 0.0);
    assert_eq!(number("0x1f"), 31.0);
    assert_eq!(number("-Infinity"), f64::NEG_INFINITY);
    assert_eq!(number(".5"), 0.5);
    assert_eq!(number("5."), 5.0);
    for text in ["inf", "NaN", "1e", "--1", "1 2", "0x", "+0x1", "."] {
      assert!(number(text).is_nan(), "{text}");
    }
  }

  #[test]
  fn sort_is_by_utf16_code_units() {
    let mut items = vec!["\u{ff61}".to_string(), "\u{1f600}".to_string()];
    sort(&mut items);
    assert_eq!(items, ["\u{1f600}", "\u{ff61}"]);
  }

  #[test]
  fn trailers_match_as_the_javascript_expression_backtracks() {
    let id = |text: &str| extract_trailer(text, "Change-Id");
    assert_eq!(id("subject\n\nChange-Id: ch_1\n").as_deref(), Some("ch_1"));
    assert_eq!(id("subject\n\nchange-id:ch_2  ").as_deref(), Some("ch_2"));
    assert_eq!(id("Change-Id:\nnext line").as_deref(), Some("next line"));
    assert_eq!(id("x\nChange-Id: ").as_deref(), Some(""));
    assert_eq!(id("x Change-Id: a"), None);
    assert_eq!(id("Change-Id:"), None);
    assert_eq!(id("\u{2028}CHANGE-ID: b\u{2029}").as_deref(), Some("b"));
    assert_eq!(id("Change-\u{130}d: c"), None);
  }
}
