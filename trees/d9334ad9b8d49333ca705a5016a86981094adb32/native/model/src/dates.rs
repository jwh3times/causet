//! Whether a record's `createdAt` is a timestamp. The JavaScript validator asks
//! `!Number.isNaN(Date.parse(value))`, and V8 answers from the ECMAScript
//! date-time string format and, failing that, from an implementation-defined
//! fallback no other implementation can reproduce (#173). This accepts exactly
//! the ECMAScript format as V8 applies it: days 01-31 whatever the month,
//! `24:00` only as `24:00`, `24:00:00` or `24:00:00.000...`, a fraction of one
//! or more digits, offsets up to `±23:59`, and the ±8.64e15 ms range.

pub fn parses(text: &str) -> bool {
  parse(text.as_bytes()).is_some()
}

/// `Date.parse(text)` for a timestamp in the ECMAScript format: milliseconds
/// since the epoch, or `None` where JavaScript answers `NaN`.
pub fn parse_ms(text: &str) -> Option<f64> {
  parse(text.as_bytes())
}

fn number(bytes: &[u8], at: &mut usize, width: usize) -> Option<i64> {
  let digits = bytes.get(*at..*at + width)?;
  if !digits.iter().all(u8::is_ascii_digit) {
    return None;
  }
  *at += width;
  Some(
    digits
      .iter()
      .fold(0, |acc, digit| acc * 10 + i64::from(digit - b'0')),
  )
}

fn literal(bytes: &[u8], at: &mut usize, byte: u8) -> bool {
  if bytes.get(*at) == Some(&byte) {
    *at += 1;
    true
  } else {
    false
  }
}

fn parse(bytes: &[u8]) -> Option<f64> {
  let mut at = 0;
  let year = match bytes.first()? {
    b'+' | b'-' => {
      let negative = bytes[0] == b'-';
      at = 1;
      let value = number(bytes, &mut at, 6)?;
      if negative { -value } else { value }
    }
    _ => number(bytes, &mut at, 4)?,
  };
  let (mut month, mut day) = (1, 1);
  if literal(bytes, &mut at, b'-') {
    month = number(bytes, &mut at, 2)?;
    if literal(bytes, &mut at, b'-') {
      day = number(bytes, &mut at, 2)?;
    }
  }
  if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
    return None;
  }
  let (mut hour, mut minute, mut second, mut millis) = (0, 0, 0, 0.0);
  let mut offset_minutes = 0;
  if literal(bytes, &mut at, b'T') {
    hour = number(bytes, &mut at, 2)?;
    if !literal(bytes, &mut at, b':') {
      return None;
    }
    minute = number(bytes, &mut at, 2)?;
    let mut fraction_nonzero = false;
    if literal(bytes, &mut at, b':') {
      second = number(bytes, &mut at, 2)?;
      if literal(bytes, &mut at, b'.') {
        let start = at;
        while bytes.get(at).is_some_and(u8::is_ascii_digit) {
          at += 1;
        }
        if at == start {
          return None;
        }
        let digits = std::str::from_utf8(&bytes[start..at]).ok()?;
        fraction_nonzero = digits.bytes().any(|digit| digit != b'0');
        let padded: String = digits
          .chars()
          .chain(std::iter::repeat('0'))
          .take(3)
          .collect();
        millis = padded.parse::<f64>().ok()?;
      }
    }
    if hour > 24
      || minute > 59
      || second > 59
      || (hour == 24 && (minute != 0 || second != 0 || fraction_nonzero))
    {
      return None;
    }
    match bytes.get(at) {
      Some(b'Z') => at += 1,
      Some(sign @ (b'+' | b'-')) => {
        let sign = if *sign == b'-' { -1 } else { 1 };
        at += 1;
        let offset_hours = number(bytes, &mut at, 2)?;
        if !literal(bytes, &mut at, b':') {
          return None;
        }
        let offset_mins = number(bytes, &mut at, 2)?;
        if offset_hours > 23 || offset_mins > 59 {
          return None;
        }
        offset_minutes = sign * (offset_hours * 60 + offset_mins);
      }
      _ => {}
    }
  }
  if at != bytes.len() {
    return None;
  }
  let days = days_from_civil(year, month, day);
  let time = (days * 86_400_000) as f64
    + ((hour * 60 + minute - offset_minutes) * 60_000 + second * 1000) as f64
    + millis;
  (time.abs() <= 8.64e15).then_some(time)
}

/// Days from 1970-01-01 to a proleptic Gregorian date, allowing day 29-31 of
/// short months to roll into the next one, as ECMAScript `MakeDay` does.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
  let (y, m) = if month <= 2 {
    (year - 1, month + 9)
  } else {
    (year, month - 3)
  };
  let era = y.div_euclid(400);
  let year_of_era = y - era * 400;
  let day_of_year = (153 * m + 2) / 5;
  let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
  era * 146_097 + day_of_era - 719_468 + (day - 1)
}

#[cfg(test)]
mod tests {
  use super::parses;

  #[test]
  fn iso_shapes_follow_v8() {
    for accepted in [
      "2020",
      "2020-01",
      "2021-02-30",
      "2020-01-01T24:00",
      "2020-01-01T24:00:00.000Z",
      "2020-01-01T10:00Z",
      "2020-01-01T10:00:00.1234Z",
      "2020-01-01T10:00:00.000+05:30",
      "+002020-01-01",
      "-000001-01-01",
      "+275760-09-13T00:00:00.000Z",
    ] {
      assert!(parses(accepted), "{accepted}");
    }
    for refused in [
      "2020-13-01",
      "2020-00-10",
      "2020-01-32",
      "2020-01-01T24:00:01",
      "2020-01-01T23:60",
      "2020-01-01T10:00:00+24:00",
      "+275760-09-13T00:00:00.001Z",
      "2020-01-01T10",
      "20200101",
      "2020-01-01T10:00:00.Z",
      "2020-01-01T10:00:00.000Z ",
    ] {
      assert!(!parses(refused), "{refused}");
    }
  }
}
