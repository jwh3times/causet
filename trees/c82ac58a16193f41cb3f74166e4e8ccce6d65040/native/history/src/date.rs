//! Git's dates as `log` prints them (`date.c`): an identity line's time and
//! zone in each `--date` mode a native repository implements, byte for byte
//! with Git, the C library's behaviour included.

use crate::text::decimal;

/// A `--date` mode. Git's `local`, `human`, `format:` and `auto:` modes read
/// the host's time zone or terminal and are not implemented.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DateMode {
  Normal,
  Relative,
  Short,
  Iso,
  IsoStrict,
  Rfc,
  Raw,
  Unix,
}

impl DateMode {
  /// The mode `--date=<name>` names, as Git's `parse_date_format` reads the
  /// names it implements here; `None` for any other.
  pub fn parse(name: &[u8]) -> Option<DateMode> {
    Some(match name {
      b"default" => DateMode::Normal,
      b"relative" => DateMode::Relative,
      b"short" => DateMode::Short,
      b"iso" | b"iso8601" => DateMode::Iso,
      b"iso-strict" | b"iso8601-strict" => DateMode::IsoStrict,
      b"rfc" | b"rfc2822" => DateMode::Rfc,
      b"raw" => DateMode::Raw,
      b"unix" => DateMode::Unix,
      _ => return None,
    })
  }
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

/// Git's `date_overflows` where `time_t` is 64 bits: the time does not fit
/// a signed `time_t`.
fn overflows(time: u64) -> bool {
  time > i64::MAX as u64
}

/// Git's `show_ident_date`: the date of an identity line's digits and zone
/// in `mode`, `now` being the time `relative` measures from. A date Git's
/// `log` dies on is an error saying why.
pub fn ident_date(digits: &[u8], zone: &[u8], mode: DateMode, now: u64) -> Result<String, String> {
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
  show_date(time, tz as i32, mode, now)
}

const WEEKDAYS: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS: [&str; 12] = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/// A broken-down time, as `gmtime_r` fills one.
struct Tm {
  year: i64,
  month: i64,
  day: i64,
  hour: u64,
  minute: u64,
  second: u64,
  weekday: usize,
}

/// Git's `show_date`, for the modes `DateMode` names.
fn show_date(time: u64, tz: i32, mode: DateMode, now: u64) -> Result<String, String> {
  match mode {
    DateMode::Unix => return Ok(time.to_string()),
    DateMode::Raw => return Ok(format!("{time} {tz:+05}")),
    DateMode::Relative => return Ok(relative(time, now)),
    _ => {}
  }
  let (tm, tz) = match time_to_tm(time, tz)? {
    Some(tm) => (tm, tz),
    None => (time_to_tm(0, 0)?.expect("the epoch"), 0),
  };
  Ok(match mode {
    DateMode::Short => format!("{:04}-{:02}-{:02}", tm.year, tm.month, tm.day),
    DateMode::Iso => format!(
      "{:04}-{:02}-{:02} {:02}:{:02}:{:02} {tz:+05}",
      tm.year, tm.month, tm.day, tm.hour, tm.minute, tm.second
    ),
    DateMode::IsoStrict => {
      let mut shown = format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}",
        tm.year, tm.month, tm.day, tm.hour, tm.minute, tm.second
      );
      if tz == 0 {
        shown.push('Z');
      } else {
        let magnitude = tz.unsigned_abs();
        shown.push(if tz >= 0 { '+' } else { '-' });
        shown.push_str(&format!("{:02}:{:02}", magnitude / 100, magnitude % 100));
      }
      shown
    }
    DateMode::Rfc => format!(
      "{}, {} {} {} {:02}:{:02}:{:02} {tz:+05}",
      WEEKDAYS[tm.weekday],
      tm.day,
      MONTHS[tm.month as usize - 1],
      tm.year,
      tm.hour,
      tm.minute,
      tm.second
    ),
    // `show_date_normal`, which hides the zone when it is the one a human
    // date is relative to: -1 when none is.
    _ => {
      let mut shown = format!(
        "{} {} {} {:02}:{:02}:{:02} {}",
        WEEKDAYS[tm.weekday],
        MONTHS[tm.month as usize - 1],
        tm.day,
        tm.hour,
        tm.minute,
        tm.second,
        tm.year
      );
      if tz != -1 {
        shown.push_str(&format!(" {tz:+05}"));
      }
      shown
    }
  })
}

/// Git's `time_to_tm`: `gm_time_t`, which dies on a time it cannot shift by
/// the zone, with its `int` arithmetic, then `gmtime_r`, `None` when that
/// fails.
fn time_to_tm(time: u64, tz: i32) -> Result<Option<Tm>, String> {
  let magnitude = if tz < 0 { -tz } else { tz };
  let minutes = (magnitude / 100) * 60 + magnitude % 100;
  let minutes = if tz < 0 { -minutes } else { minutes };
  // `minutes * 60` is an `int`, converted to the unsigned timestamp.
  let shift = minutes.wrapping_mul(60) as i64 as u64;
  let shifted = if minutes > 0 {
    if shift > u64::MAX - time {
      return Err(format!(
        "the timestamp {time} with the zone +{tz:04} is too large, as Git's log dies on"
      ));
    }
    time.wrapping_add(shift)
  } else {
    let back = minutes.wrapping_neg().wrapping_mul(60) as i64 as u64;
    if time < back {
      return Err(format!(
        "the timestamp {time} {tz:04} is before the Unix epoch, as Git's log dies on"
      ));
    }
    time.wrapping_add(shift)
  };
  if overflows(shifted) {
    return Err(format!(
      "the timestamp {shifted} is too large, as Git's log dies on"
    ));
  }
  Ok(gmtime(shifted))
}

/// The latest time `gmtime_r` converts: on Windows, Git's `gmtime_r` is the
/// C runtime's `gmtime_s`, which stops at the end of the year 3000; glibc
/// and the BSDs stop where the year no longer fits an `int`.
#[cfg(windows)]
const LATEST: u64 = 32_535_215_999;
#[cfg(not(windows))]
const LATEST: u64 = u64::MAX;

fn gmtime(time: u64) -> Option<Tm> {
  if time > LATEST {
    return None;
  }
  // `time` is below 2^63, so its day count fits easily.
  let days = (time / 86_400) as i64;
  let of_day = time % 86_400;
  let (year, month, day) = civil(days);
  if year - 1900 > i64::from(i32::MAX) {
    return None;
  }
  Some(Tm {
    year,
    month,
    day,
    hour: of_day / 3600,
    minute: of_day / 60 % 60,
    second: of_day % 60,
    weekday: (days + 4).rem_euclid(7) as usize,
  })
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

fn counted(number: u64, one: &str) -> String {
  if number == 1 {
    format!("{number} {one}")
  } else {
    format!("{number} {one}s")
  }
}

/// Git's `show_date_relative`, in English, as Git prints it untranslated.
pub fn relative(time: u64, now: u64) -> String {
  if now < time {
    return "in the future".into();
  }
  let mut diff = now - time;
  if diff < 90 {
    return format!("{} ago", counted(diff, "second"));
  }
  diff = (diff + 30) / 60;
  if diff < 90 {
    return format!("{} ago", counted(diff, "minute"));
  }
  diff = (diff + 30) / 60;
  if diff < 36 {
    return format!("{} ago", counted(diff, "hour"));
  }
  diff = (diff + 12) / 24;
  if diff < 14 {
    return format!("{} ago", counted(diff, "day"));
  }
  if diff < 70 {
    return format!("{} ago", counted((diff + 3) / 7, "week"));
  }
  if diff < 365 {
    return format!("{} ago", counted((diff + 15) / 30, "month"));
  }
  if diff < 1825 {
    let total = (diff * 12 * 2 + 365) / (365 * 2);
    let (years, months) = (total / 12, total % 12);
    if months > 0 {
      return format!(
        "{}, {} ago",
        counted(years, "year"),
        counted(months, "month")
      );
    }
    return format!("{} ago", counted(years, "year"));
  }
  format!("{} ago", counted((diff + 183) / 365, "year"))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn relative_dates_count_as_git_counts_them() {
    let now = 2_000_000_000;
    let cases: [(u64, &str); 12] = [
      (0, "0 seconds ago"),
      (1, "1 second ago"),
      (89, "89 seconds ago"),
      (90, "2 minutes ago"),
      (60 * 89 + 29, "89 minutes ago"),
      (3600 * 35, "35 hours ago"),
      (86_400 * 13, "13 days ago"),
      (86_400 * 14, "2 weeks ago"),
      (86_400 * 69, "10 weeks ago"),
      (86_400 * 400, "1 year, 1 month ago"),
      (86_400 * 365 * 2, "2 years ago"),
      (86_400 * 365 * 10, "10 years ago"),
    ];
    for (ago, expected) in cases {
      assert_eq!(relative(now - ago, now), expected, "{ago}");
    }
    assert_eq!(relative(now + 1, now), "in the future");
  }

  #[test]
  fn every_mode_prints_a_time_as_git_does() {
    let shown = |mode| ident_date(b"1112911993", b"-0700", mode, 0).unwrap();
    assert_eq!(shown(DateMode::Normal), "Thu Apr 7 15:13:13 2005 -0700");
    assert_eq!(shown(DateMode::Short), "2005-04-07");
    assert_eq!(shown(DateMode::Iso), "2005-04-07 15:13:13 -0700");
    assert_eq!(shown(DateMode::IsoStrict), "2005-04-07T15:13:13-07:00");
    assert_eq!(shown(DateMode::Rfc), "Thu, 7 Apr 2005 15:13:13 -0700");
    assert_eq!(shown(DateMode::Raw), "1112911993 -0700");
    assert_eq!(shown(DateMode::Unix), "1112911993");
    assert_eq!(
      ident_date(b"1112911993", b"+0000", DateMode::IsoStrict, 0).unwrap(),
      "2005-04-07T22:13:13Z"
    );
    // A zone of -0001 is the one Git's normal date hides.
    assert_eq!(
      ident_date(b"1112911993", b"-0001", DateMode::Normal, 0).unwrap(),
      "Thu Apr 7 22:12:13 2005"
    );
    assert!(ident_date(b"10", b"-0100", DateMode::Normal, 0).is_err());
  }
}
