//! A Git tree entry's mode, as Git reads it. The rule lives here because the
//! Git-side tree readers (`causet-core`, `causet-engine`) and N1's store
//! (`causet-store`) all follow it, and this is the crate they all depend on.

/// A tree entry's mode as Git reads it (`get_mode` in Git's `tree-walk.c`):
/// one or more octal digits, in an unsigned 32-bit number that wraps as Git's
/// does, so `10000000000000000000000000100644` is `100644`. `None` when Git
/// cannot read the mode, a sign or an empty mode included.
pub fn git_mode(mode: &[u8]) -> Option<u32> {
  if mode.is_empty() || !mode.iter().all(|digit| (b'0'..=b'7').contains(digit)) {
    return None;
  }
  Some(mode.iter().fold(0u32, |value, digit| (value << 3).wrapping_add(u32::from(digit - b'0'))))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn a_mode_reads_as_git_reads_it() {
    assert_eq!(git_mode(b"100644"), Some(0o100644));
    assert_eq!(git_mode(b"40000"), Some(0o40000));
    // Older Gits wrote the leading zero; `git fsck` only warns about it.
    assert_eq!(git_mode(b"0100644"), Some(0o100644));
    // Git's unsigned int wraps: the digits past 32 bits fall away.
    assert_eq!(git_mode(b"10000000000000000000000000100644"), Some(0o100644));
    assert_eq!(git_mode(b"77777777777"), Some(u32::MAX));
  }

  #[test]
  fn a_mode_git_cannot_read_is_refused() {
    for unread in [&b""[..], b"+100644", b"-100644", b"-1", b"100648", b"10 644"] {
      assert_eq!(git_mode(unread), None, "{}", String::from_utf8_lossy(unread));
    }
  }
}
