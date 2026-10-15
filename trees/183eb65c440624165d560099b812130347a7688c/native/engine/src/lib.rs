//! The Git engine the ported commands share (issue #143, ADR-0037), ported
//! from `src/git.js` and `src/engine.js`, which stay the authority:
//!
//! - [`engine`]: the read catalog of ADR-0019 behind one [`engine::ReadBackend`]
//!   trait, with the Git backend and the gitoxide backend of ADR-0027, the
//!   fallback reasons, and the engine selection;
//! - [`session`] and [`merge_tree`]: the object session (ADR-0009) and the
//!   merge-tree session (ADR-0016), as child processes without a worker;
//! - [`process`]: explicit mutations, with the same arguments and environment,
//!   and the bypass rule that refuses a read outside the seam in native mode;
//! - [`metrics`]: processes, session queries, fallbacks, native and direct
//!   reads, as `beginGitMetrics` / `endGitMetrics` count them;
//! - [`differential`]: `cst doctor --differential`.
#![forbid(unsafe_code)]

pub mod differential;
pub mod engine;
pub mod environment;
pub mod errors;
mod git;
pub mod locations;
pub mod merge_tree;
pub mod metrics;
mod native;
pub mod process;
pub mod session;
pub mod text;
pub mod types;

/// The common byte-input target for the mutation fuzzer: every parser of Git
/// output, the session and merge-tree record readers, and the JavaScript
/// string operations they rely on. Nothing here runs Git.
pub fn fuzz_parsers(data: &[u8]) {
  git::fuzz_parsers(data);
  for query in [session::Query::Info, session::Query::Contents] {
    let mut reader = std::io::Cursor::new(data);
    for _ in 0..4 {
      if session::read_response(&mut reader, query).is_err() {
        break;
      }
    }
  }
  let mut reader = std::io::Cursor::new(data);
  for _ in 0..4 {
    if merge_tree::read_record(&mut reader).is_err() {
      break;
    }
  }
  let text = String::from_utf8_lossy(data);
  let _ = text::extract_trailer(&text, "Change-Id");
  let _ = text::number(&text);
  let _ = text::split_space_runs(&text);
  let _ = text::split_lines(&text);
}
