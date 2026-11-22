//! `log --format` as Git prints it (ADR-0046, decision 2): Git's
//! `repo_format_commit_message` from `pretty.c`, followed step by step, with
//! native IDs where Git prints Git IDs. A placeholder Git does not know is
//! printed as Git prints it, `%` and all. One Git knows that reads what
//! native history does not hold yet, or the host's time zone or terminal, is
//! refused, never printed differently from Git:
//!
//! - decorations, `%d`, `%D`, `%S`, `%(decorate)` and `%(describe)`, which
//!   need names (#418);
//! - notes, `%N`, which become facts (#419), and the reflog, `%g…`;
//! - Git signatures, `%G…`, which native history keeps in the preserved
//!   bytes only (commits.md §7.1);
//! - the mailmap, `%aN`, `%aE`, `%aL` and the committer's;
//! - `%ah` and `%ch`, and a padding column counted from the terminal's width;
//! - `%C(always,…)`: cst never colours, so every other colour prints nothing,
//!   as Git's does when its output is not a terminal;
//! - padding and wrapping of text that is UTF-8 but not ASCII, whose width
//!   needs Git's tables of character widths.

use crate::commit::Commit;
use crate::date::{DateMode, ident_date};
use crate::signature::Signature;
use crate::text::is_git_space;
use crate::trailers;
use causet_store::id::NativeId;

/// Why a commit's text could not be printed.
#[derive(Debug, PartialEq, Eq)]
pub enum Failure<E> {
  /// It needs what is not implemented yet, such as re-encoding a message
  /// from an encoding other than ISO-8859-1.
  Unimplemented(String),
  /// Git's `log` dies on it, as on a date before the Unix epoch.
  Fatal(String),
  /// An ID could not be abbreviated.
  Abbreviation(E),
}

/// What a command sets that changes how placeholders print.
#[derive(Clone, Copy, Debug)]
pub struct Options {
  /// `--date`, for `%ad` and `%cd`.
  pub date: DateMode,
  /// The time relative dates count back from, in seconds since the epoch.
  pub now: u64,
}

impl Default for Options {
  fn default() -> Options {
    Options {
      date: DateMode::Normal,
      now: std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |since| since.as_secs()),
    }
  }
}

/// A `--format` value: its template, and whether each commit's text is
/// terminated (`tformat:`, and a bare format with a placeholder) or
/// separated (`format:`) by a line feed.
#[derive(Debug)]
pub struct Format {
  template: Vec<u8>,
  terminated: bool,
}

impl Format {
  /// Whether `--format=` names one of Git's formats, such as `oneline`,
  /// rather than giving a template: no `format:` or `tformat:`, and no `%`.
  pub fn is_named(spec: &[u8]) -> bool {
    !spec.is_empty()
      && !spec.starts_with(b"format:")
      && !spec.starts_with(b"tformat:")
      && !spec.contains(&b'%')
  }

  /// Parses the value of `--format=` as Git's `get_commit_format` does. A
  /// named format, and a template using a placeholder that is refused, is
  /// refused with what it is.
  pub fn parse(spec: &[u8]) -> Result<Format, String> {
    let (template, terminated) = if let Some(rest) = spec.strip_prefix(b"format:") {
      (rest, false)
    } else if spec.is_empty() {
      (spec, true)
    } else if let Some(rest) = spec.strip_prefix(b"tformat:") {
      (rest, true)
    } else if spec.contains(&b'%') {
      (spec, true)
    } else {
      return Err(format!(
        "the format {}, which names no placeholder,",
        String::from_utf8_lossy(spec)
      ));
    };
    let format = Format {
      template: template.to_vec(),
      terminated,
    };
    // A refused placeholder is refused whatever the commit, before anything
    // is printed: what reaches one is the template alone.
    let sample = sample();
    let abbrev = |id: &NativeId| Ok::<_, ()>(id.hex()[..7].to_string());
    let options = Options {
      date: DateMode::Normal,
      now: 0,
    };
    if let Err(Failure::Unimplemented(what)) =
      format.render_with(&sample, &NativeId([0; 32]), &abbrev, &options)
    {
      return Err(what);
    }
    Ok(format)
  }

  /// Whether a line feed goes between two commits' texts (`format:`),
  /// rather than ending each (`render` adds it).
  pub fn separated(&self) -> bool {
    !self.terminated
  }

  /// One commit's text, its own ID `id`, abbreviating IDs with `abbrev`,
  /// dates in Git's default mode relative to now.
  pub fn render<E>(
    &self,
    commit: &Commit,
    id: &NativeId,
    abbrev: &dyn Fn(&NativeId) -> Result<String, E>,
  ) -> Result<Vec<u8>, Failure<E>> {
    self.render_with(commit, id, abbrev, &Options::default())
  }

  /// `render`, with a command's options.
  pub fn render_with<E>(
    &self,
    commit: &Commit,
    id: &NativeId,
    abbrev: &dyn Fn(&NativeId) -> Result<String, E>,
    options: &Options,
  ) -> Result<Vec<u8>, Failure<E>> {
    let mut state = State {
      commit,
      id,
      abbrev,
      options,
      recoded: Text::of(commit),
      wrap_start: 0,
      width: 0,
      indent1: 0,
      indent2: 0,
      padding: 0,
      flush: Flush::None,
      truncate: Truncate::None,
    };
    let mut out = Vec::new();
    let format = self.template.as_slice();
    let mut at = 0;
    loop {
      let Some(percent) = format[at..].iter().position(|&byte| byte == b'%') else {
        out.extend_from_slice(&format[at..]);
        break;
      };
      out.extend_from_slice(&format[at..at + percent]);
      at += percent + 1;
      if format.get(at) == Some(&b'%') {
        out.push(b'%');
        at += 1;
        continue;
      }
      match state.item(&mut out, &format[at..])? {
        0 => out.push(b'%'),
        consumed => at += consumed,
      }
    }
    state.rewrap(&mut out, 0, 0, 0)?;
    // Git's `commit_format_is_empty`: an empty `tformat:` ends with nothing.
    if self.terminated && !self.template.is_empty() {
      out.push(b'\n');
    }
    Ok(out)
  }
}

/// A commit every placeholder can be printed for, to find a template's
/// refusals before any commit is printed.
fn sample() -> Commit {
  let signature = Signature::Fields {
    name: b"A".to_vec(),
    email: b"a@example.com".to_vec(),
    time: 0,
    offset: 0,
  };
  Commit {
    tree: NativeId([0; 32]),
    parents: vec![NativeId([0; 32])],
    author: signature.clone(),
    committer: signature,
    encoding: None,
    actors: Vec::new(),
    change_id: None,
    derived_from: None,
    origin_commit: None,
    preserved: None,
    message: b"subject\n\nbody\n\nKey: value\n".to_vec(),
  }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Flush {
  None,
  Left,
  Right,
  Both,
  LeftAndSteal,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Truncate {
  None,
  Left,
  Middle,
  Right,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Magic {
  None,
  DeleteLineFeedBeforeEmpty,
  LineFeedBeforeNonEmpty,
  SpaceBeforeNonEmpty,
}

/// A commit's text as Git's `logmsg_reencode` gives it in UTF-8: its message
/// and its last author and committer lines, each to its first NUL, as Git
/// reads the commit's buffer as a C string, and empty for a line it does not
/// have. What `%B`, `%an` and `%cn` read.
pub struct Text {
  pub message: Vec<u8>,
  pub author: Vec<u8>,
  pub committer: Vec<u8>,
}

/// A commit's `Text`, or why it cannot be had, such as an encoding that is
/// not implemented.
pub fn text(commit: &Commit) -> Result<Text, String> {
  Text::of(commit)
}

/// What Git's `split_ident_line` finds in an identity line: its name, its
/// email, and its date's digits and zone when it has both; `None` when it
/// has no `<…>`.
pub struct Identity {
  pub name: Vec<u8>,
  pub email: Vec<u8>,
  pub date: Option<(Vec<u8>, Vec<u8>)>,
}

pub fn identity(line: &[u8]) -> Option<Identity> {
  split_ident(line).map(|ident| Identity {
    name: ident.name.to_vec(),
    email: ident.email.to_vec(),
    date: ident
      .date
      .map(|(digits, zone)| (digits.to_vec(), zone.to_vec())),
  })
}

impl Text {
  fn of(commit: &Commit) -> Result<Text, String> {
    let recode = Recoding::of(commit.encoding.as_deref())?;
    let line = |signature: &Signature| match signature.line() {
      Some(line) => recode.apply(until_nul(&line)),
      None => Vec::new(),
    };
    Ok(Text {
      message: recode.apply(until_nul(&commit.message)),
      author: line(&commit.author),
      committer: line(&commit.committer),
    })
  }
}

struct State<'a, E> {
  commit: &'a Commit,
  id: &'a NativeId,
  abbrev: &'a dyn Fn(&NativeId) -> Result<String, E>,
  options: &'a Options,
  recoded: Result<Text, String>,
  wrap_start: usize,
  width: usize,
  indent1: usize,
  indent2: usize,
  padding: i64,
  flush: Flush,
  truncate: Truncate,
}

type Rendered<T, E> = Result<T, Failure<E>>;

fn refused<T, E>(what: &str) -> Rendered<T, E> {
  Err(Failure::Unimplemented(what.to_string()))
}

impl<E> State<'_, E> {
  fn recoded(&self) -> Rendered<&Text, E> {
    self
      .recoded
      .as_ref()
      .map_err(|why| Failure::Unimplemented(why.clone()))
  }

  fn abbreviated(&self, id: &NativeId) -> Rendered<String, E> {
    (self.abbrev)(id).map_err(Failure::Abbreviation)
  }

  /// Git's `format_commit_item`: the `-`, `+` and space prefixes, and
  /// padding.
  fn item(&mut self, out: &mut Vec<u8>, placeholder: &[u8]) -> Rendered<usize, E> {
    let magic = match placeholder.first() {
      Some(b'-') => Magic::DeleteLineFeedBeforeEmpty,
      Some(b'+') => Magic::LineFeedBeforeNonEmpty,
      Some(b' ') => Magic::SpaceBeforeNonEmpty,
      _ => Magic::None,
    };
    let placeholder = if magic == Magic::None {
      placeholder
    } else {
      // `%+w()` could change what came before it, so Git refuses it.
      if placeholder.get(1) == Some(&b'w') {
        return Ok(0);
      }
      &placeholder[1..]
    };
    let before = out.len();
    let consumed = if self.flush == Flush::None {
      self.one(out, placeholder)?
    } else {
      self.padded(out, placeholder)?
    };
    match magic {
      Magic::None => return Ok(consumed),
      Magic::DeleteLineFeedBeforeEmpty if out.len() == before => {
        while out.last() == Some(&b'\n') {
          out.pop();
        }
      }
      _ if out.len() != before => match magic {
        Magic::LineFeedBeforeNonEmpty => out.insert(before, b'\n'),
        Magic::SpaceBeforeNonEmpty => out.insert(before, b' '),
        _ => {}
      },
      _ => {}
    }
    Ok(consumed + 1)
  }

  /// Git's `format_commit_one`: one placeholder, and how many bytes of the
  /// template it took, 0 for one Git does not know.
  fn one(&mut self, out: &mut Vec<u8>, placeholder: &[u8]) -> Rendered<usize, E> {
    let Some(&first) = placeholder.first() else {
      return Ok(0);
    };
    match first {
      b'C' => return self.color(placeholder),
      b'n' => {
        out.push(b'\n');
        return Ok(1);
      }
      b'x' => {
        let digit = |at: usize| {
          placeholder
            .get(at)
            .and_then(|&byte| (byte as char).to_digit(16))
        };
        return Ok(match (digit(1), digit(2)) {
          (Some(high), Some(low)) => {
            out.push((high * 16 + low) as u8);
            3
          }
          _ => 0,
        });
      }
      b'w' => return self.wrap(out, placeholder),
      b'<' | b'>' => return self.padding(placeholder),
      _ => {}
    }
    if placeholder.starts_with(b"(describe") {
      return refused("the placeholder %(describe), which needs names,");
    }
    match first {
      b'H' => {
        out.extend_from_slice(self.id.hex().as_bytes());
        return Ok(1);
      }
      b'h' => {
        out.extend_from_slice(self.abbreviated(self.id)?.as_bytes());
        return Ok(1);
      }
      b'T' => {
        out.extend_from_slice(self.commit.tree.hex().as_bytes());
        return Ok(1);
      }
      b't' => {
        out.extend_from_slice(self.abbreviated(&self.commit.tree)?.as_bytes());
        return Ok(1);
      }
      b'P' | b'p' => {
        for (at, parent) in self.commit.parents.iter().enumerate() {
          if at > 0 {
            out.push(b' ');
          }
          let shown = if first == b'P' {
            parent.hex()
          } else {
            self.abbreviated(parent)?
          };
          out.extend_from_slice(shown.as_bytes());
        }
        return Ok(1);
      }
      // `get_revision_mark` with no revision walk to ask: a commit `log`
      // shows is neither a boundary nor uninteresting.
      b'm' => {
        out.push(b'>');
        return Ok(1);
      }
      b'd' | b'D' => return refused("the placeholder %d or %D, which needs names,"),
      b'S' => return refused("the placeholder %S, which needs names,"),
      b'g' => return refused("a reflog placeholder, %g…,"),
      b'N' => return refused("the placeholder %N, which reads notes,"),
      b'G' => {
        return refused(
          "a signature placeholder, %G…, which reads Git signatures native history does not carry,",
        );
      }
      _ => {}
    }
    if placeholder.starts_with(b"(decorate") {
      return refused("the placeholder %(decorate), which needs names,");
    }
    match first {
      b'a' | b'c' => {
        let recoded = self.recoded()?;
        let line = if first == b'a' {
          recoded.author.clone()
        } else {
          recoded.committer.clone()
        };
        let part = placeholder.get(1).copied().unwrap_or(0);
        return self.person(out, part, &line);
      }
      b'e' => {
        if let Some(encoding) = &self.commit.encoding {
          out.extend_from_slice(until_nul(encoding));
        }
        return Ok(1);
      }
      b'B' => {
        out.extend_from_slice(&self.recoded()?.message);
        return Ok(1);
      }
      b's' => {
        out.extend_from_slice(&subject(&self.recoded()?.message));
        return Ok(1);
      }
      b'f' => {
        sanitized(&self.recoded()?.message, out);
        return Ok(1);
      }
      b'b' => {
        out.extend_from_slice(body(&self.recoded()?.message));
        return Ok(1);
      }
      _ => {}
    }
    if let Some(arg) = placeholder.strip_prefix(b"(trailers") {
      return self.trailers(out, placeholder, arg);
    }
    Ok(0)
  }

  /// Git's `parse_color`, with colour never wanted.
  fn color(&self, placeholder: &[u8]) -> Rendered<usize, E> {
    if placeholder[1..].starts_with(b"(auto)") {
      return Ok(7);
    }
    if placeholder.get(1) == Some(&b'(') {
      let Some(end) = placeholder[2..].iter().position(|&byte| byte == b')') else {
        return Ok(0);
      };
      if placeholder[2..].starts_with(b"always,") {
        return refused("%C(always,…), since cst never colours its output,");
      }
      return Ok(2 + end + 1);
    }
    for name in [&b"red"[..], b"green", b"blue", b"reset"] {
      if placeholder[1..].starts_with(name) {
        return Ok(1 + name.len());
      }
    }
    Ok(0)
  }

  /// Git's `format_person_part`.
  fn person(&self, out: &mut Vec<u8>, part: u8, line: &[u8]) -> Rendered<usize, E> {
    // Of the parts Git cannot print, these take their two bytes anyway.
    let skip = |part: u8| {
      if matches!(part, b'n' | b'e' | b't' | b'd' | b'D' | b'r' | b'i') {
        2
      } else {
        0
      }
    };
    let Some(ident) = split_ident(line) else {
      return Ok(skip(part));
    };
    match part {
      b'N' | b'E' | b'L' => return refused("a mailmap placeholder, %aN, %aE or %aL,"),
      b'n' => {
        out.extend_from_slice(ident.name);
        return Ok(2);
      }
      b'e' => {
        out.extend_from_slice(ident.email);
        return Ok(2);
      }
      b'l' => {
        let local = match ident.email.iter().position(|&byte| byte == b'@') {
          Some(at) => &ident.email[..at],
          None => ident.email,
        };
        out.extend_from_slice(local);
        return Ok(2);
      }
      _ => {}
    }
    let Some((digits, zone)) = ident.date else {
      return Ok(skip(part));
    };
    let mode = match part {
      b't' => {
        out.extend_from_slice(digits);
        return Ok(2);
      }
      b'd' => self.options.date,
      b'D' => DateMode::Rfc,
      b'r' => DateMode::Relative,
      b'i' => DateMode::Iso,
      b'I' => DateMode::IsoStrict,
      b's' => DateMode::Short,
      b'h' => return refused("a human date, %ah or %ch, which reads the host's time zone,"),
      _ => return Ok(skip(part)),
    };
    let shown = ident_date(digits, zone, mode, self.options.now).map_err(Failure::Fatal)?;
    out.extend_from_slice(shown.as_bytes());
    Ok(2)
  }

  /// `%(trailers[:options])`.
  fn trailers(&self, out: &mut Vec<u8>, placeholder: &[u8], arg: &[u8]) -> Rendered<usize, E> {
    let mut options = trailers::Options::default();
    let mut rest = arg;
    if let Some(after) = rest.strip_prefix(b":") {
      rest = after;
      match trailer_options(rest, &mut options) {
        Some(after) => rest = after,
        None => return Ok(0),
      }
    }
    if rest.first() != Some(&b')') {
      return Ok(0);
    }
    let message = &self.recoded()?.message;
    trailers::format(&message[subject_start(message)..], &options, out);
    Ok(placeholder.len() - rest.len() + 1)
  }

  /// `%w(…)`: Git's `rewrap_message_tail` with the arguments its `strtoul`
  /// reads. An argument with a sign or leading space is refused, and one
  /// too large for an `int`, which Git's `strbuf_add_wrapped_text` dies on.
  fn wrap(&mut self, out: &mut Vec<u8>, placeholder: &[u8]) -> Rendered<usize, E> {
    if placeholder.get(1) != Some(&b'(') {
      return Ok(0);
    }
    let start = 2;
    let Some(close) = placeholder[start..].iter().position(|&byte| byte == b')') else {
      return Ok(0);
    };
    let end = start + close;
    let (mut width, mut indent1, mut indent2) = (0, 0, 0);
    if end > start {
      let (value, mut next) = strtoul(placeholder, start)?;
      width = value;
      if placeholder[next] == b',' {
        let (value, after) = strtoul(placeholder, next + 1)?;
        indent1 = value;
        next = after;
        if placeholder[next] == b',' {
          let (value, after) = strtoul(placeholder, next + 1)?;
          indent2 = value;
          next = after;
        }
      }
      if placeholder[next] != b')' {
        return Ok(0);
      }
    }
    self.rewrap(out, width, indent1, indent2)?;
    Ok(end + 1)
  }

  fn rewrap(
    &mut self,
    out: &mut Vec<u8>,
    width: usize,
    indent1: usize,
    indent2: usize,
  ) -> Rendered<(), E> {
    if (self.width, self.indent1, self.indent2) == (width, indent1, indent2) {
      return Ok(());
    }
    if self.wrap_start < out.len() {
      let text = until_nul(&out[self.wrap_start..]).to_vec();
      out.truncate(self.wrap_start);
      wrapped(
        out,
        &text,
        self.indent1 as i64,
        self.indent2 as i64,
        self.width as i64,
      )?;
    }
    self.wrap_start = out.len();
    self.width = width;
    self.indent1 = indent1;
    self.indent2 = indent2;
    Ok(())
  }

  /// Git's `parse_padding_placeholder`. Its padding takes effect even when
  /// a later part of the placeholder is malformed, as Git's does.
  fn padding(&mut self, placeholder: &[u8]) -> Rendered<usize, E> {
    let mut at = 1;
    let flush = match placeholder[0] {
      b'<' => Flush::Right,
      _ => match placeholder.get(1) {
        Some(b'<') => {
          at += 1;
          Flush::Both
        }
        Some(b'>') => {
          at += 1;
          Flush::LeftAndSteal
        }
        _ => Flush::Left,
      },
    };
    let to_column = placeholder.get(at) == Some(&b'|');
    if to_column {
      at += 1;
    }
    if placeholder.get(at) != Some(&b'(') {
      return Ok(0);
    }
    let start = at + 1;
    let Some(span) = placeholder[start..]
      .iter()
      .position(|&byte| matches!(byte, b',' | b')'))
    else {
      return Ok(0);
    };
    let end = start + span;
    if end == start {
      return Ok(0);
    }
    /// Git's `FORMATTING_LIMIT`.
    const LIMIT: i64 = 16 * 1024;
    let (width, next) = strtol(placeholder, start);
    if !(-LIMIT..=LIMIT).contains(&width) || next == start || width == 0 {
      return Ok(0);
    }
    if width < 0 {
      if to_column {
        return refused("a padding column counted back from the terminal's width");
      }
      return Ok(0);
    }
    self.padding = if to_column { -width } else { width };
    self.flush = flush;
    if placeholder[end] == b',' {
      let from = end + 1;
      let Some(close) = placeholder[from..].iter().position(|&byte| byte == b')') else {
        return Ok(0);
      };
      if close == 0 {
        return Ok(0);
      }
      let option = &placeholder[from..];
      self.truncate = if option.starts_with(b"trunc)") {
        Truncate::Right
      } else if option.starts_with(b"ltrunc)") {
        Truncate::Left
      } else if option.starts_with(b"mtrunc)") {
        Truncate::Middle
      } else {
        return Ok(0);
      };
      return Ok(from + close + 1);
    }
    self.truncate = Truncate::None;
    Ok(end + 1)
  }

  /// Git's `format_and_pad_commit`: the next placeholder, and any colours
  /// before it, padded or truncated to the width the padding set.
  fn padded(&mut self, out: &mut Vec<u8>, placeholder: &[u8]) -> Rendered<usize, E> {
    let mut local = Vec::new();
    let mut total = 0;
    let mut padding = self.padding;
    if padding < 0 {
      let start = out.iter().rposition(|&byte| byte == b'\n').unwrap_or(0);
      let occupied = display_width(until_nul(&out[start..]))?;
      padding = -padding - occupied;
    }
    let mut rest = placeholder;
    loop {
      let modifier = rest.first() == Some(&b'C');
      let consumed = self.one(&mut local, rest)?;
      total += consumed;
      if !modifier {
        break;
      }
      rest = &rest[consumed..];
      if rest.first() != Some(&b'%') {
        break;
      }
      rest = &rest[1..];
      total += 1;
    }
    let len = display_width(&local)?;
    if self.flush == Flush::LeftAndSteal {
      let mut ch = out.len() as isize - 1;
      while len > padding && ch > 0 {
        let at = ch as usize;
        if out[at] == b' ' {
          ch -= 1;
          padding += 1;
          continue;
        }
        if out[at] != b'm' {
          break;
        }
        let mut p = at - 1;
        while p > 0 && at - p < 10 && out[p] != 0x1b {
          p -= 1;
        }
        if out[p] != 0x1b || at + 1 - p != escape_length(out, p) {
          break;
        }
        local = [&out[p..=at], local.as_slice()].concat();
        ch = p as isize - 1;
      }
      out.truncate((ch + 1) as usize);
      self.flush = Flush::Left;
    }
    if len > padding {
      let (from, span) = match self.truncate {
        Truncate::Left => (0, len - (padding - 2)),
        Truncate::Middle => (padding / 2 - 1, len - (padding - 2)),
        Truncate::Right => (padding - 2, len - (padding - 2)),
        Truncate::None => (0, 0),
      };
      if self.truncate != Truncate::None {
        replace_columns(&mut local, from, span, b"..")?;
      }
      out.extend_from_slice(&local);
    } else {
      let at = out.len();
      let offset = match self.flush {
        Flush::Left => padding - len,
        Flush::Both => (padding - len) / 2,
        _ => 0,
      } as usize;
      let count = (padding - len) as usize + local.len();
      out.resize(at + count, b' ');
      out[at + offset..at + offset + local.len()].copy_from_slice(&local);
    }
    self.flush = Flush::None;
    Ok(total)
  }
}

/// Git's `format_set_trailers_options`: what follows `%(trailers:`, up to
/// the `)` it leaves, or `None` for an option Git does not know.
fn trailer_options<'a>(mut rest: &'a [u8], options: &mut trailers::Options) -> Option<&'a [u8]> {
  loop {
    if rest.first() == Some(&b')') {
      return Some(rest);
    }
    if let Some((value, after)) = argument(rest, b"key") {
      let mut key = value?.to_vec();
      if key.last() == Some(&b':') {
        key.pop();
      }
      options.keys.push(key);
      options.only = true;
      rest = after;
    } else if let Some((value, after)) = argument(rest, b"separator") {
      options.separator = Some(literal(value.unwrap_or(b"")));
      rest = after;
    } else if let Some((value, after)) = argument(rest, b"key_value_separator") {
      options.key_value_separator = Some(literal(value.unwrap_or(b"")));
      rest = after;
    } else {
      let mut matched = None;
      for (name, flag) in [
        (&b"only"[..], &mut options.only),
        (b"unfold", &mut options.unfold),
        (b"keyonly", &mut options.key_only),
        (b"valueonly", &mut options.value_only),
      ] {
        if let Some((value, after)) = argument(rest, name) {
          let truth = match value {
            None => Some(true),
            Some(value) => maybe_bool(value),
          };
          if let Some(truth) = truth {
            *flag = truth;
            matched = Some(after);
            break;
          }
        }
      }
      rest = matched?;
    }
  }
}

/// Git's `match_placeholder_arg_value`: `name`, then `=value` or nothing,
/// then `,` (passed) or `)` (left); the value, `None` for none, and the rest.
fn argument<'a>(rest: &'a [u8], name: &[u8]) -> Option<(Option<&'a [u8]>, &'a [u8])> {
  let after = rest.strip_prefix(name)?;
  let (value, after) = match after.first() {
    Some(b'=') => {
      let value = &after[1..];
      let span = value
        .iter()
        .position(|&byte| matches!(byte, b',' | b')'))
        .unwrap_or(value.len());
      (Some(&value[..span]), &value[span..])
    }
    Some(b',' | b')') => (None, after),
    _ => return None,
  };
  match after.first() {
    Some(b',') => Some((value, &after[1..])),
    Some(b')') => Some((value, after)),
    _ => None,
  }
}

/// Git's `git_parse_maybe_bool`: the boolean words, and an integer, with a
/// unit, true when not zero.
fn maybe_bool(value: &[u8]) -> Option<bool> {
  let text = String::from_utf8_lossy(value).to_ascii_lowercase();
  match text.as_str() {
    "" | "false" | "no" | "off" => return Some(false),
    "true" | "yes" | "on" => return Some(true),
    _ => {}
  }
  let trimmed = text.trim_start_matches([' ', '\t', '\n', '\x0b', '\x0c', '\r']);
  let (negative, unsigned) = match trimmed.as_bytes().first() {
    Some(b'-') => (true, &trimmed[1..]),
    Some(b'+') => (false, &trimmed[1..]),
    _ => (false, trimmed),
  };
  let (radix, digits) = if let Some(hex) = unsigned.strip_prefix("0x") {
    (16, hex)
  } else if unsigned.len() > 1 && unsigned.starts_with('0') {
    (8, &unsigned[1..])
  } else {
    (10, unsigned)
  };
  let span = digits
    .chars()
    .take_while(|digit| digit.is_digit(radix))
    .count();
  if span == 0 && radix != 8 {
    return None;
  }
  let number = i128::from_str_radix(if span == 0 { "0" } else { &digits[..span] }, radix).ok()?;
  let factor: i128 = match &digits[span..] {
    "" => 1,
    "k" => 1024,
    "m" => 1024 * 1024,
    "g" => 1024 * 1024 * 1024,
    _ => return None,
  };
  let number = if negative { -number } else { number };
  let value = number.checked_mul(factor)?;
  if value > i128::from(i32::MAX) || value < i128::from(i32::MIN) {
    return None;
  }
  Some(value != 0)
}

/// Git's `strbuf_expand_literal_cb` over a separator: `%n`, `%xNN` and `%%`.
fn literal(value: &[u8]) -> Vec<u8> {
  let mut out = Vec::new();
  let mut at = 0;
  while at < value.len() {
    if value[at] != b'%' {
      out.push(value[at]);
      at += 1;
      continue;
    }
    at += 1;
    let digit = |at: usize| value.get(at).and_then(|&byte| (byte as char).to_digit(16));
    match value.get(at) {
      Some(b'%') => {
        out.push(b'%');
        at += 1;
      }
      Some(b'n') => {
        out.push(b'\n');
        at += 1;
      }
      Some(b'x') if digit(at + 1).is_some() && digit(at + 2).is_some() => {
        out.push((digit(at + 1).unwrap() * 16 + digit(at + 2).unwrap()) as u8);
        at += 3;
      }
      _ => out.push(b'%'),
    }
  }
  out
}

/// `strtoul` of digits from `at`: the value and where it ended. A sign or
/// leading space, and a value an `int` cannot hold, are refused.
fn strtoul<E>(bytes: &[u8], at: usize) -> Rendered<(usize, usize), E> {
  if bytes
    .get(at)
    .is_some_and(|&byte| matches!(byte, b'+' | b'-') || byte.is_ascii_whitespace() || byte == 0x0b)
  {
    return refused("a %w() argument with a sign or leading space");
  }
  let span = bytes[at..]
    .iter()
    .take_while(|byte| byte.is_ascii_digit())
    .count();
  let mut value: u64 = 0;
  for digit in &bytes[at..at + span] {
    value = value
      .saturating_mul(10)
      .saturating_add(u64::from(digit - b'0'));
  }
  if value > i32::MAX as u64 {
    return refused("a %w() argument too large for Git to wrap with");
  }
  Ok((value as usize, at + span))
}

/// `strtol` of what follows `at`, with C's leading space and sign: the value
/// and where it ended, at `at` when no digit follows.
fn strtol(bytes: &[u8], at: usize) -> (i64, usize) {
  let mut index = at;
  while bytes
    .get(index)
    .is_some_and(|&byte| matches!(byte, b' ' | b'\t' | b'\n' | 0x0b | 0x0c | b'\r'))
  {
    index += 1;
  }
  let negative = bytes.get(index) == Some(&b'-');
  if matches!(bytes.get(index), Some(b'-' | b'+')) {
    index += 1;
  }
  let span = bytes[index.min(bytes.len())..]
    .iter()
    .take_while(|byte| byte.is_ascii_digit())
    .count();
  if span == 0 {
    return (0, at);
  }
  let value = bytes[index..index + span]
    .iter()
    .fold(0i64, |value, digit| {
      value
        .saturating_mul(10)
        .saturating_add(i64::from(digit - b'0'))
    });
  (if negative { -value } else { value }, index + span)
}

/// Git's `display_mode_esc_sequence_len`: an ANSI colour sequence's length
/// at `at`, 0 when none begins there.
fn escape_length(bytes: &[u8], at: usize) -> usize {
  let byte = |index: usize| bytes.get(index).copied().unwrap_or(0);
  if byte(at) != 0x1b || byte(at + 1) != b'[' {
    return 0;
  }
  let mut index = at + 2;
  while byte(index).is_ascii_digit() || byte(index) == b';' {
    index += 1;
  }
  if byte(index) != b'm' {
    return 0;
  }
  index + 1 - at
}

/// How Git measures text's width: by columns when it is UTF-8, which is
/// implemented for ASCII alone, or by bytes when it is not UTF-8.
enum Measure {
  Ascii,
  Bytes,
}

fn measure<E>(bytes: &[u8]) -> Rendered<Measure, E> {
  if bytes.is_ascii() {
    Ok(Measure::Ascii)
  } else if std::str::from_utf8(bytes).is_err() {
    Ok(Measure::Bytes)
  } else {
    refused("padding or wrapping text that is not ASCII")
  }
}

/// Git's `git_wcwidth` of an ASCII byte.
fn ascii_width(byte: u8) -> i64 {
  match byte {
    0 => 0,
    0x01..=0x1f | 0x7f => -1,
    _ => 1,
  }
}

/// Git's `utf8_strnwidth`, colour sequences skipped.
fn display_width<E>(bytes: &[u8]) -> Rendered<i64, E> {
  if let Measure::Bytes = measure(bytes)? {
    return Ok(bytes.len() as i64);
  }
  let mut width = 0;
  let mut at = 0;
  while at < bytes.len() {
    loop {
      let skip = escape_length(bytes, at);
      if skip == 0 {
        break;
      }
      at += skip;
    }
    if at >= bytes.len() {
      break;
    }
    width += ascii_width(bytes[at]).max(0);
    at += 1;
  }
  Ok(width)
}

/// Git's `strbuf_utf8_replace`: the columns from `from`, `span` wide,
/// replaced by `with`. Text that is not UTF-8 is left as it is.
fn replace_columns<E>(text: &mut Vec<u8>, from: i64, span: i64, with: &[u8]) -> Rendered<(), E> {
  if let Measure::Bytes = measure(text)? {
    return Ok(());
  }
  let mut out = Vec::with_capacity(text.len());
  let mut with = Some(with);
  let mut column = 0;
  let mut at = 0;
  while at < text.len() {
    loop {
      let skip = escape_length(text, at);
      if skip == 0 {
        break;
      }
      out.extend_from_slice(&text[at..at + skip]);
      at += skip;
    }
    if at >= text.len() {
      break;
    }
    let width = ascii_width(text[at]).max(0);
    if width != 0 && column >= from && column < from + span {
      if let Some(with) = with.take() {
        out.extend_from_slice(with);
      }
    } else {
      out.push(text[at]);
    }
    column += width;
    at += 1;
  }
  *text = out;
  Ok(())
}

/// Git's `strbuf_add_wrapped_text`.
fn wrapped<E>(
  out: &mut Vec<u8>,
  text: &[u8],
  indent1: i64,
  indent2: i64,
  width: i64,
) -> Rendered<(), E> {
  if width <= 0 {
    indented(out, text, indent1, indent2);
    return Ok(());
  }
  let columns = matches!(measure(text)?, Measure::Ascii);
  let byte = |index: usize| text.get(index).copied().unwrap_or(0);
  let mut at = 0;
  let mut bol = 0;
  let mut indent = indent1;
  let mut w = indent1;
  let mut space: Option<usize> = None;
  if indent < 0 {
    w = -indent;
    space = Some(at);
  }
  loop {
    loop {
      let skip = escape_length(text, at);
      if skip == 0 {
        break;
      }
      at += skip;
    }
    let c = byte(at);
    if c == 0 || is_git_space(c) {
      let mut new_line = false;
      if w <= width || space.is_none() {
        let mut start = bol;
        if c == 0 && at == start {
          return Ok(());
        }
        match space {
          Some(from) => start = from,
          None => out.extend(std::iter::repeat_n(b' ', indent.max(0) as usize)),
        }
        out.extend_from_slice(&text[start..at]);
        if c == 0 {
          return Ok(());
        }
        space = Some(at);
        if c == b'\t' {
          w |= 0x07;
        } else if c == b'\n' {
          let next = at + 1;
          space = Some(next);
          if byte(next) == b'\n' {
            out.push(b'\n');
            new_line = true;
          } else if !byte(next).is_ascii_alphanumeric() {
            new_line = true;
          } else {
            out.push(b' ');
          }
        }
        if !new_line {
          w += 1;
          at += 1;
        }
      } else {
        new_line = true;
      }
      if new_line {
        out.push(b'\n');
        let from = space.expect("a line breaks only after a space");
        at = from + usize::from(is_git_space(byte(from)));
        bol = at;
        space = None;
        indent = indent2;
        w = indent2;
      }
      continue;
    }
    w += if columns { ascii_width(c) } else { 1 };
    at += 1;
  }
}

/// Git's `strbuf_add_indented_text`.
fn indented(out: &mut Vec<u8>, text: &[u8], indent1: i64, indent2: i64) {
  let mut indent = indent1.max(0);
  let mut rest = text;
  while !rest.is_empty() {
    let end = rest
      .iter()
      .position(|&byte| byte == b'\n')
      .map_or(rest.len(), |at| at + 1);
    out.extend(std::iter::repeat_n(b' ', indent as usize));
    out.extend_from_slice(&rest[..end]);
    rest = &rest[end..];
    indent = indent2;
  }
}

/// Git reads a commit's buffer as a C string from here on.
fn until_nul(bytes: &[u8]) -> &[u8] {
  match bytes.iter().position(|&byte| byte == 0) {
    Some(at) => &bytes[..at],
    None => bytes,
  }
}

/// How Git's `logmsg_reencode` turns a commit's text into the output
/// encoding, UTF-8: not at all when the commit is UTF-8, by its own word or
/// by default. Of the other encodings only ISO-8859-1 is implemented yet.
enum Recoding {
  None,
  Latin1,
}

impl Recoding {
  fn of(encoding: Option<&[u8]>) -> Result<Recoding, String> {
    let Some(encoding) = encoding else {
      return Ok(Recoding::None);
    };
    let name = String::from_utf8_lossy(encoding).to_ascii_uppercase();
    match name.as_str() {
      "UTF-8" | "UTF8" => Ok(Recoding::None),
      "ISO-8859-1" | "ISO8859-1" | "ISO_8859-1" | "LATIN1" | "L1" | "ISO-IR-100" | "CP819"
      | "IBM819" | "CSISOLATIN1" => Ok(Recoding::Latin1),
      _ => Err(format!(
        "re-encoding a commit message from {}",
        String::from_utf8_lossy(encoding)
      )),
    }
  }

  fn apply(&self, bytes: &[u8]) -> Vec<u8> {
    match self {
      Recoding::None => bytes.to_vec(),
      Recoding::Latin1 => bytes
        .iter()
        .map(|&byte| byte as char)
        .collect::<String>()
        .into_bytes(),
    }
  }
}

/// What Git's `split_ident_line` finds in an identity line: the name, the
/// email, and the date's digits and zone when the line has both.
struct Ident<'a> {
  name: &'a [u8],
  email: &'a [u8],
  date: Option<(&'a [u8], &'a [u8])>,
}

fn split_ident(line: &[u8]) -> Option<Ident<'_>> {
  let line = until_nul(line);
  let mail_begin = line.iter().position(|&byte| byte == b'<')? + 1;
  let name_end = line[..mail_begin - 1]
    .iter()
    .rposition(|&byte| !is_git_space(byte))
    .map_or(0, |at| at + 1);
  let mail_end = mail_begin + line[mail_begin..].iter().position(|&byte| byte == b'>')?;
  // The date follows the last `>`, which helps with a stray `>` in the email.
  let last = line
    .iter()
    .rposition(|&byte| byte == b'>')
    .expect("the email's `>`");
  let digits_of = |at: usize| {
    line[at..]
      .iter()
      .take_while(|byte| byte.is_ascii_digit())
      .count()
  };
  let skip = |mut at: usize| {
    while at < line.len() && is_git_space(line[at]) {
      at += 1;
    }
    at
  };
  let date = (|| {
    let date_begin = skip(last + 1);
    if date_begin >= line.len() {
      return None;
    }
    let span = digits_of(date_begin);
    if span == 0 {
      return None;
    }
    let zone_begin = skip(date_begin + span);
    if zone_begin >= line.len() || !matches!(line[zone_begin], b'+' | b'-') {
      return None;
    }
    let zone_span = digits_of(zone_begin + 1);
    (zone_span > 0).then(|| {
      (
        &line[date_begin..date_begin + span],
        &line[zone_begin..zone_begin + 1 + zone_span],
      )
    })
  })();
  Some(Ident {
    name: &line[..name_end],
    email: &line[mail_begin..mail_end],
    date,
  })
}

/// Git's `get_one_line`: a line with its line feed, or the rest.
fn one_line(text: &[u8]) -> usize {
  text
    .iter()
    .position(|&byte| byte == b'\n')
    .map_or(text.len(), |at| at + 1)
}

/// Git's `is_blank_line`: the line without its trailing whitespace, `None`
/// when nothing is left.
fn unblank(line: &[u8]) -> Option<&[u8]> {
  let end = line
    .iter()
    .rposition(|&byte| !is_git_space(byte))
    .map(|at| at + 1)?;
  Some(&line[..end])
}

/// Git's `skip_blank_lines`.
fn skip_blank(mut text: &[u8]) -> &[u8] {
  loop {
    let length = one_line(text);
    if length == 0 || unblank(&text[..length]).is_some() {
      return text;
    }
    text = &text[length..];
  }
}

/// Where the subject begins: past the blank lines before it.
fn subject_start(message: &[u8]) -> usize {
  message.len() - skip_blank(message).len()
}

/// `%s`: the first paragraph, its lines joined by spaces, each without its
/// trailing whitespace.
fn subject(message: &[u8]) -> Vec<u8> {
  let mut text = skip_blank(message);
  let mut out = Vec::new();
  loop {
    let length = one_line(text);
    let Some(line) = (length > 0).then(|| unblank(&text[..length])).flatten() else {
      return out;
    };
    if !out.is_empty() {
      out.push(b' ');
    }
    out.extend_from_slice(line);
    text = &text[length..];
  }
}

/// `%f`: Git's `format_sanitized_subject` of the subject's first line.
fn sanitized(message: &[u8], out: &mut Vec<u8>) {
  let text = skip_blank(message);
  let line = &text[..text
    .iter()
    .position(|&byte| byte == b'\n')
    .unwrap_or(text.len())];
  let start = out.len();
  let mut space = 2;
  let mut at = 0;
  while at < line.len() {
    let byte = line[at];
    if byte.is_ascii_alphanumeric() || byte == b'.' || byte == b'_' {
      if space == 1 {
        out.push(b'-');
      }
      space = 0;
      out.push(byte);
      if byte == b'.' {
        while line.get(at + 1) == Some(&b'.') {
          at += 1;
        }
      }
    } else {
      space |= 1;
    }
    at += 1;
  }
  while out.len() > start && matches!(out.last(), Some(b'.' | b'-')) {
    out.pop();
  }
}

/// `%b`: everything after the subject's paragraph and the blank lines that
/// follow it.
fn body(message: &[u8]) -> &[u8] {
  let mut text = skip_blank(message);
  loop {
    let length = one_line(text);
    if length == 0 || unblank(&text[..length]).is_none() {
      break;
    }
    text = &text[length..];
  }
  skip_blank(text)
}
