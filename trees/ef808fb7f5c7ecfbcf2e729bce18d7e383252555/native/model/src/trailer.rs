//! The `Change-Id` trailer expression as the JavaScript CLI evaluated it,
//! with the ECMAScript whitespace it depends on. Git-backed cst lifts a
//! change's identity from a commit message with it, and import lifts a native
//! commit's identity the same way (docs/native-history/commits.md §5.3), so
//! both kinds of repository agree on every commit's identity.

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
