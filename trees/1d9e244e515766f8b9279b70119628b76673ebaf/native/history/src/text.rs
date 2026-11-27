//! The C library behaviour Git's parsers rely on, which native history reads
//! the same bytes with.

/// Git's `isspace`: space, tab, line feed and carriage return.
pub(crate) fn is_git_space(byte: u8) -> bool {
  matches!(byte, b' ' | b'\t' | b'\n' | b'\r')
}

/// `strtoumax` of decimal digits: their value, or the largest value when it
/// does not fit.
pub(crate) fn decimal(digits: &[u8]) -> u64 {
  digits
    .iter()
    .try_fold(0u64, |value, digit| {
      value.checked_mul(10)?.checked_add(u64::from(digit - b'0'))
    })
    .unwrap_or(u64::MAX)
}
