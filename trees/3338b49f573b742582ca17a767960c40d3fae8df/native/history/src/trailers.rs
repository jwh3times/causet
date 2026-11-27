//! `%(trailers)` as Git prints it (`trailer.c`, `pretty.c`): a message's
//! trailer block found as Git finds it, with no trailer configuration, the
//! comment character `#` and the separator `:`, then printed by the
//! placeholder's options.

use crate::text::is_git_space;

const COMMENT: u8 = b'#';
const SEPARATORS: &[u8] = b":";
const GIT_GENERATED: [&[u8]; 2] = [b"Signed-off-by: ", b"(cherry picked from commit "];
const CUT_LINE: &[u8] = b"------------------------ >8 ------------------------\n";

/// The options of `%(trailers:…)`.
#[derive(Default)]
pub struct Options {
  /// `key=`: the keys kept, each matched without case, a final `:` dropped.
  pub keys: Vec<Vec<u8>>,
  pub only: bool,
  pub unfold: bool,
  pub key_only: bool,
  pub value_only: bool,
  pub separator: Option<Vec<u8>>,
  pub key_value_separator: Option<Vec<u8>>,
}

impl Options {
  fn untouched(&self) -> bool {
    !self.only
      && !self.unfold
      && self.keys.is_empty()
      && self.separator.is_none()
      && !self.key_only
      && !self.value_only
      && self.key_value_separator.is_none()
  }
}

/// A byte of a C string: NUL past its end.
fn at(text: &[u8], index: usize) -> u8 {
  text.get(index).copied().unwrap_or(0)
}

/// Git's `next_line`: past the line feed, or at the end.
fn next_line(text: &[u8], from: usize) -> usize {
  match text[from..].iter().position(|&byte| byte == b'\n') {
    Some(at) => from + at + 1,
    None => text.len(),
  }
}

/// Git's `last_line`: where the line before `len` begins, a final line feed
/// counting as part of the last line; `None` before the first.
fn last_line(text: &[u8], len: usize) -> Option<usize> {
  if len == 0 {
    return None;
  }
  if len == 1 {
    return Some(0);
  }
  (0..=len - 2)
    .rev()
    .find(|&index| text[index] == b'\n')
    .map_or(Some(0), |index| Some(index + 1))
}

/// `trailer.c`'s `is_blank_line`.
fn is_blank_line(text: &[u8], from: usize) -> bool {
  let mut index = from;
  while at(text, index) != 0 && at(text, index) != b'\n' && is_git_space(at(text, index)) {
    index += 1;
  }
  at(text, index) == 0 || at(text, index) == b'\n'
}

/// Git's `find_separator`: where a line's separator is, or `None` when the
/// line is no trailer.
fn find_separator(line: &[u8]) -> Option<usize> {
  let mut whitespace = false;
  for (index, &byte) in line.iter().enumerate() {
    if byte == 0 {
      break;
    }
    if SEPARATORS.contains(&byte) {
      return Some(index);
    }
    if !whitespace && (byte.is_ascii_alphanumeric() || byte == b'-') {
      continue;
    }
    if index != 0 && (byte == b' ' || byte == b'\t') {
      whitespace = true;
      continue;
    }
    break;
  }
  None
}

/// `wt_status_locate_end`: the end of a message before a scissors line.
fn locate_end(text: &[u8]) -> usize {
  let mut pattern = vec![b'\n', COMMENT, b' '];
  pattern.extend_from_slice(CUT_LINE);
  if text.starts_with(&pattern[1..]) {
    return 0;
  }
  match text
    .windows(pattern.len())
    .position(|window| window == pattern.as_slice())
  {
    Some(found) => (found + 1).min(text.len()),
    None => text.len(),
  }
}

/// `ignored_log_message_bytes`: how much of a message's end is comments,
/// blank lines, an old conflicts block, or after a scissors line.
fn ignored(text: &[u8]) -> usize {
  let len = text.len();
  let cutoff = locate_end(text);
  let mut boc = 0;
  let mut bol = 0;
  let mut in_conflicts = false;
  while bol < cutoff {
    let next = next_line(text, bol);
    if text[bol..cutoff].first() == Some(&COMMENT) || text[bol] == b'\n' {
      if boc == 0 {
        boc = bol;
      }
    } else if text[bol..].starts_with(b"Conflicts:\n") {
      in_conflicts = true;
      if boc == 0 {
        boc = bol;
      }
    } else if in_conflicts && text[bol] == b'\t' {
    } else if boc != 0 {
      boc = 0;
      in_conflicts = false;
    }
    bol = next;
  }
  if boc != 0 { len - boc } else { len - cutoff }
}

/// `find_trailer_block_start`.
fn block_start(text: &[u8], len: usize) -> usize {
  let mut only_spaces = true;
  let mut recognized = false;
  let (mut trailer_lines, mut non_trailer_lines, mut continuations) = (0i64, 0i64, 0i64);
  // The first paragraph is the title and cannot be trailers.
  let mut start = 0;
  while start < len {
    if text[start] == COMMENT {
      start = next_line(text, start);
      continue;
    }
    if is_blank_line(text, start) {
      break;
    }
    start = next_line(text, start);
  }
  let end_of_title = start;
  let mut line = last_line(text, len);
  while let Some(bol) = line.filter(|&bol| bol >= end_of_title) {
    line = last_line(text, bol);
    if text.get(bol) == Some(&COMMENT) {
      non_trailer_lines += continuations;
      continuations = 0;
      continue;
    }
    if is_blank_line(text, bol) {
      if only_spaces {
        continue;
      }
      non_trailer_lines += continuations;
      if (recognized && trailer_lines * 3 >= non_trailer_lines)
        || (trailer_lines > 0 && non_trailer_lines == 0)
      {
        return next_line(text, bol);
      }
      return len;
    }
    only_spaces = false;
    if GIT_GENERATED
      .iter()
      .any(|prefix| text[bol..].starts_with(prefix))
    {
      trailer_lines += 1;
      continuations = 0;
      recognized = true;
      continue;
    }
    let first = at(text, bol);
    if find_separator(&text[bol..]).is_some_and(|at| at >= 1) && !is_git_space(first) {
      trailer_lines += 1;
      continuations = 0;
    } else if is_git_space(first) {
      continuations += 1;
    } else {
      non_trailer_lines += 1 + continuations;
      continuations = 0;
    }
  }
  len
}

/// `strbuf_trim`.
fn trim(bytes: &[u8]) -> &[u8] {
  let start = bytes
    .iter()
    .position(|&byte| !is_git_space(byte))
    .unwrap_or(bytes.len());
  let end = bytes
    .iter()
    .rposition(|&byte| !is_git_space(byte))
    .map_or(start, |at| at + 1);
  &bytes[start..end.max(start)]
}

/// `unfold_value`.
fn unfold(value: &[u8]) -> Vec<u8> {
  let mut out = Vec::with_capacity(value.len());
  let mut index = 0;
  while index < value.len() {
    let byte = value[index];
    index += 1;
    if byte == b'\n' {
      while index < value.len() && is_git_space(value[index]) {
        index += 1;
      }
      out.push(b' ');
    } else {
      out.push(byte);
    }
  }
  trim(&out).to_vec()
}

enum Item {
  Trailer { token: Vec<u8>, value: Vec<u8> },
  Other(Vec<u8>),
}

/// `%(trailers…)` of a message from its subject on, as a C string.
pub fn format(message: &[u8], options: &Options, out: &mut Vec<u8>) {
  let text = match message.iter().position(|&byte| byte == 0) {
    Some(end) => &message[..end],
    None => message,
  };
  let end = text.len() - ignored(text);
  let start = block_start(text, end);
  if options.untouched() {
    out.extend_from_slice(&text[start..end]);
    return;
  }
  // `trailer_block_get`: the block's lines, continuations joined to the
  // trailer before them.
  let mut lines: Vec<Vec<u8>> = Vec::new();
  let mut last: Option<usize> = None;
  let mut from = start;
  while from < end {
    let to = (next_line(text, from)).min(end);
    let line = &text[from..to];
    from = to;
    if let Some(index) = last
      && is_git_space(line[0])
    {
      lines[index].extend_from_slice(line);
      continue;
    }
    lines.push(line.to_vec());
    last = find_separator(line)
      .is_some_and(|at| at >= 1)
      .then_some(lines.len() - 1);
  }
  let mut items = Vec::new();
  for line in &lines {
    if line.first() == Some(&COMMENT) {
      continue;
    }
    match find_separator(line).filter(|&at| at >= 1) {
      Some(at) => {
        let value = trim(&line[at + 1..]);
        items.push(Item::Trailer {
          token: trim(&line[..at]).to_vec(),
          value: if options.unfold {
            unfold(value)
          } else {
            value.to_vec()
          },
        });
      }
      None if !options.only => {
        let value = line.strip_suffix(b"\n").unwrap_or(line);
        items.push(Item::Other(value.to_vec()));
      }
      None => {}
    }
  }
  let origin = out.len();
  for item in items {
    match item {
      Item::Trailer { token, value } => {
        let kept = options.keys.is_empty()
          || options
            .keys
            .iter()
            .any(|key| key.len() == token.len() && key.eq_ignore_ascii_case(&token));
        if !kept {
          continue;
        }
        if let Some(separator) = &options.separator
          && out.len() != origin
        {
          out.extend_from_slice(separator);
        }
        if !options.value_only {
          out.extend_from_slice(&token);
        }
        if !options.key_only && !options.value_only {
          match &options.key_value_separator {
            Some(separator) => out.extend_from_slice(separator),
            None => {
              let last = token.iter().rev().find(|&&byte| !is_git_space(byte));
              if last.is_some_and(|byte| !SEPARATORS.contains(byte)) {
                out.extend_from_slice(&[SEPARATORS[0], b' ']);
              }
            }
          }
        }
        if !options.key_only {
          out.extend_from_slice(&value);
        }
        if options.separator.is_none() {
          out.push(b'\n');
        }
      }
      Item::Other(value) if !options.only => {
        if let Some(separator) = &options.separator
          && out.len() != origin
        {
          out.extend_from_slice(separator);
        }
        out.extend_from_slice(&value);
        if options.separator.is_some() {
          while out.last().is_some_and(|&byte| is_git_space(byte)) {
            out.pop();
          }
        } else {
          out.push(b'\n');
        }
      }
      Item::Other(_) => {}
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn shown(message: &[u8], options: &Options) -> String {
    let mut out = Vec::new();
    format(message, options, &mut out);
    String::from_utf8(out).unwrap()
  }

  #[test]
  fn the_block_is_the_last_paragraph_of_trailers() {
    let message = b"subject\n\nbody text\n\nChange-Id: ch_1\nSigned-off-by: A <a@x>\n";
    assert_eq!(
      shown(message, &Options::default()),
      "Change-Id: ch_1\nSigned-off-by: A <a@x>\n"
    );
    let keyed = Options {
      keys: vec![b"change-id".to_vec()],
      value_only: true,
      ..Options::default()
    };
    assert_eq!(shown(message, &keyed), "ch_1\n");
    // A subject alone has no trailers, even when it looks like one.
    assert_eq!(shown(b"Change-Id: ch_1\n", &Options::default()), "");
    // A paragraph mostly of prose is no block without a Git-generated line.
    assert_eq!(shown(b"s\n\nprose here\nKey: v\n", &Options::default()), "");
  }

  #[test]
  fn continuations_fold_into_their_trailer() {
    let message = b"s\n\nKey: first\n  second\nOther: x\n";
    let unfolded = Options {
      unfold: true,
      ..Options::default()
    };
    assert_eq!(shown(message, &unfolded), "Key: first second\nOther: x\n");
    let separated = Options {
      separator: Some(b", ".to_vec()),
      only: true,
      ..Options::default()
    };
    assert_eq!(shown(message, &separated), "Key: first\n  second, Other: x");
  }
}
