//! `log --format` as Git prints it (ADR-0046, decision 2): the placeholders
//! a native repository implements, each byte for byte with Git's
//! `pretty.c`, with native IDs where Git prints Git IDs. A placeholder it
//! does not implement is refused, never printed differently from Git.

use crate::commit::Commit;
use crate::signature::Signature;
use crate::text::{decimal, is_git_space};
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Person {
  Author,
  Committer,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Field {
  Name,
  Email,
  Date,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Part {
  Literal(Vec<u8>),
  Hash,
  ShortHash,
  Tree,
  ShortTree,
  Parents,
  ShortParents,
  Person(Person, Field),
  Subject,
  Body,
}

/// A `--format` value: its placeholders and literal text, and whether each
/// commit's text is terminated (`tformat:`, and a bare format with a
/// placeholder) or separated (`format:`) by a line feed.
#[derive(Debug)]
pub struct Format {
  parts: Vec<Part>,
  terminated: bool,
}

impl Format {
  /// Parses the value of `--format=`. A named format, and any placeholder
  /// not implemented yet, is refused with what it is.
  pub fn parse(spec: &[u8]) -> Result<Format, String> {
    let (template, terminated) = if let Some(rest) = spec.strip_prefix(b"format:") {
      (rest, false)
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
    let mut parts = Vec::new();
    let mut literal = Vec::new();
    let mut rest = template;
    while let Some((&byte, after)) = rest.split_first() {
      rest = after;
      if byte != b'%' {
        literal.push(byte);
        continue;
      }
      let (part, width) = match rest {
        [b'%', ..] => (Part::Literal(b"%".to_vec()), 1),
        [b'n', ..] => (Part::Literal(b"\n".to_vec()), 1),
        [b'H', ..] => (Part::Hash, 1),
        [b'h', ..] => (Part::ShortHash, 1),
        [b'T', ..] => (Part::Tree, 1),
        [b't', ..] => (Part::ShortTree, 1),
        [b'P', ..] => (Part::Parents, 1),
        [b'p', ..] => (Part::ShortParents, 1),
        [b's', ..] => (Part::Subject, 1),
        [b'b', ..] => (Part::Body, 1),
        [who @ (b'a' | b'c'), what @ (b'n' | b'e' | b'd'), ..] => {
          let person = if *who == b'a' {
            Person::Author
          } else {
            Person::Committer
          };
          let field = match what {
            b'n' => Field::Name,
            b'e' => Field::Email,
            _ => Field::Date,
          };
          (Part::Person(person, field), 2)
        }
        _ => {
          let shown: String = String::from_utf8_lossy(&rest[..rest.len().min(2)]).into_owned();
          return Err(format!("the placeholder %{shown}"));
        }
      };
      if let Part::Literal(text) = &part {
        literal.extend_from_slice(text);
      } else {
        if !literal.is_empty() {
          parts.push(Part::Literal(std::mem::take(&mut literal)));
        }
        parts.push(part);
      }
      rest = &rest[width..];
    }
    if !literal.is_empty() {
      parts.push(Part::Literal(literal));
    }
    Ok(Format { parts, terminated })
  }

  /// Whether a line feed goes between two commits' texts (`format:`),
  /// rather than ending each (`render` adds it).
  pub fn separated(&self) -> bool {
    !self.terminated
  }

  /// One commit's text, its own ID `id`, abbreviating IDs with `abbrev`.
  pub fn render<E>(
    &self,
    commit: &Commit,
    id: &NativeId,
    abbrev: &dyn Fn(&NativeId) -> Result<String, E>,
  ) -> Result<Vec<u8>, Failure<E>> {
    let abbrev = |id: &NativeId| abbrev(id).map_err(Failure::Abbreviation);
    let recode = Recoding::of(commit.encoding.as_deref()).map_err(Failure::Unimplemented)?;
    let message = recode.apply(until_nul(&commit.message));
    let mut out = Vec::new();
    for part in &self.parts {
      match part {
        Part::Literal(text) => out.extend_from_slice(text),
        Part::Hash => out.extend_from_slice(id.hex().as_bytes()),
        Part::ShortHash => out.extend_from_slice(abbrev(id)?.as_bytes()),
        Part::Tree => out.extend_from_slice(commit.tree.hex().as_bytes()),
        Part::ShortTree => out.extend_from_slice(abbrev(&commit.tree)?.as_bytes()),
        Part::Parents | Part::ShortParents => {
          for (at, parent) in commit.parents.iter().enumerate() {
            if at > 0 {
              out.push(b' ');
            }
            let shown = if *part == Part::Parents {
              parent.hex()
            } else {
              abbrev(parent)?
            };
            out.extend_from_slice(shown.as_bytes());
          }
        }
        Part::Person(person, field) => {
          let signature = match person {
            Person::Author => &commit.author,
            Person::Committer => &commit.committer,
          };
          let line = match signature {
            Signature::None => Vec::new(),
            other => recode.apply(&other.line().expect("a line")),
          };
          out.extend_from_slice(&person_part(&line, *field).map_err(Failure::Fatal)?);
        }
        Part::Subject => out.extend_from_slice(&subject(&message)),
        Part::Body => out.extend_from_slice(body(&message)),
      }
    }
    // Git's `commit_format_is_empty`: an empty `tformat:` ends with nothing.
    if self.terminated && !self.parts.is_empty() {
      out.push(b'\n');
    }
    Ok(out)
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
    let span = digits_of(date_begin);
    if date_begin >= line.len() || span == 0 {
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

/// Git's `format_person_part` for `%an`, `%ae` and `%ad`, the date in
/// `DATE_NORMAL`. A line Git cannot split, and a date it does not find,
/// print nothing.
fn person_part(line: &[u8], field: Field) -> Result<Vec<u8>, String> {
  let Some(ident) = split_ident(line) else {
    return Ok(Vec::new());
  };
  Ok(match field {
    Field::Name => ident.name.to_vec(),
    Field::Email => ident.email.to_vec(),
    Field::Date => match ident.date {
      None => Vec::new(),
      Some((digits, zone)) => normal_date(digits, zone)?.into_bytes(),
    },
  })
}

/// `strtol` of a sign and digits, the largest magnitude when it does not
/// fit.
fn parse_zone(zone: &[u8]) -> i64 {
  let magnitude = zone[1..].iter().try_fold(0i64, |value, digit| {
    value.checked_mul(10)?.checked_add(i64::from(digit - b'0'))
  });
  match (zone[0], magnitude) {
    (b'-', Some(value)) => -value,
    (b'-', None) => i64::MIN,
    (_, Some(value)) => value,
    (_, None) => i64::MAX,
  }
}

/// Git's `date_overflows` where `time_t` is 64 bits.
fn overflows(time: u64) -> bool {
  time >= i64::MAX as u64
}

const WEEKDAYS: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS: [&str; 12] = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/// Git's `show_ident_date` and `show_date` in `DATE_NORMAL`, in the line's
/// own zone: `Thu Apr 7 15:13:13 2005 -0700`. A date Git's `log` dies on is
/// an error.
fn normal_date(digits: &[u8], zone: &[u8]) -> Result<String, String> {
  let mut time = decimal(digits);
  let mut tz = 0i64;
  if overflows(time) {
    time = 0;
  } else {
    tz = parse_zone(zone);
    if tz >= i64::from(i32::MAX) || tz <= i64::from(i32::MIN) {
      tz = 0;
    }
  }
  // Git's `gm_time_t`.
  let magnitude = tz.abs();
  let minutes = (magnitude / 100) * 60 + magnitude % 100;
  let minutes = if tz < 0 { -minutes } else { minutes };
  let seconds = minutes * 60;
  let shown = |time: u64, tz: i64| {
    // `time` is below 2^63, so its day count fits easily.
    let days = (time / 86_400) as i64;
    let of_day = time % 86_400;
    let (year, month, day) = civil(days);
    format!(
      "{} {} {} {:02}:{:02}:{:02} {} {:+05}",
      WEEKDAYS[(days + 4).rem_euclid(7) as usize],
      MONTHS[month as usize - 1],
      day,
      of_day / 3600,
      of_day / 60 % 60,
      of_day % 60,
      year,
      tz
    )
  };
  let local = if seconds > 0 {
    time.checked_add(seconds as u64).ok_or_else(|| {
      format!("the timestamp {time} with the zone {tz:+05} is too large, as Git's log dies on")
    })?
  } else if (time as i128) < -(seconds as i128) {
    return Err(format!(
      "the timestamp {time} {tz:04} is before the Unix epoch, as Git's log dies on"
    ));
  } else {
    time - seconds.unsigned_abs()
  };
  if overflows(local) {
    return Err(format!(
      "the timestamp {local} is too large, as Git's log dies on"
    ));
  }
  // `gmtime_r` fails when the year does not fit `tm_year`; Git then shows
  // the epoch in UTC.
  let (year, _, _) = civil((local / 86_400) as i64);
  if year - 1900 > i64::from(i32::MAX) {
    return Ok(shown(0, 0));
  }
  Ok(shown(local, tz))
}

/// The proleptic Gregorian date of a day count from 1970-01-01.
fn civil(days: i64) -> (i64, i64, i64) {
  let z = days + 719_468;
  let era = z.div_euclid(146_097);
  let of_era = z.rem_euclid(146_097);
  let year_of_era = (of_era - of_era / 1460 + of_era / 36_524 - of_era / 146_096) / 365;
  let of_year = of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
  let shifted = (5 * of_year + 2) / 153;
  let day = of_year - (153 * shifted + 2) / 5 + 1;
  let month = if shifted < 10 {
    shifted + 3
  } else {
    shifted - 9
  };
  let year = year_of_era + era * 400 + i64::from(month <= 2);
  (year, month, day)
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
