//! The merge-tree session of ADR-0016: one `git merge-tree --stdin` process
//! reused for every clean step of a forecast. Each request is one
//! `<base> -- <ours> <theirs>` line; a clean answer is exactly
//! `1\0<tree>\0\0`, and the first conflicted answer ends the session.
//!
//! Git flushes each record before reading the next line only from 2.49, so the
//! session learns the exact version from the trace2 `version` event its own
//! process writes before reading any input, and refuses the first request on
//! an older Git without writing it.

use crate::environment;
use crate::metrics::{self, Item};
use crate::text;
use causet_model::json::string;
use std::io::{BufRead as _, BufReader, Write as _};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// The oldest Git the merge-tree engine works on (`MERGE_TREE_ENGINE_MIN_GIT`).
pub const MERGE_TREE_ENGINE_MIN_GIT: &str = "2.49";
const VERSION_WAIT: Duration = Duration::from_secs(10);
const SESSION_TIMEOUT: Duration = Duration::from_secs(60);
const STDERR_LIMIT: usize = 64 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MergeResult {
  pub clean: bool,
  pub tree: String,
}

/// A failed request. `session_failure` is `too-old` or `exited` where the
/// JavaScript session names one; `git_version` is what the process reported.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MergeTreeError {
  pub message: String,
  pub session_failure: Option<String>,
  pub git_version: Option<String>,
}

enum Event {
  Version(String),
}

struct Process {
  child: Child,
  stdin: Option<ChildStdin>,
  records: Receiver<Result<MergeResult, (String, Option<String>)>>,
  events: Receiver<Event>,
  stderr: Arc<Mutex<String>>,
  started: Instant,
  pid: u32,
}

/// `MergeTreeSession`.
pub struct MergeTreeSession {
  cwd: String,
  attr_source: Option<String>,
  session_id: String,
  process: Option<Process>,
  startup_error: Option<String>,
  closed: bool,
  process_counted: bool,
  git_command: String,
  spoof_git_version: Option<String>,
  /// `pending`, `ok`, `too-old` or `unknown` (no version event in time).
  version_state: &'static str,
  unusable: Option<String>,
  /// The Git version the session process reported, once known.
  pub git_version: Option<String>,
}

fn version_parts(text: &str) -> Option<(u64, u64)> {
  let bytes = text.as_bytes();
  let mut index = 0;
  while index < bytes.len() {
    if bytes[index].is_ascii_digit() {
      let start = index;
      while index < bytes.len() && bytes[index].is_ascii_digit() {
        index += 1;
      }
      if index + 1 < bytes.len() && bytes[index] == b'.' && bytes[index + 1].is_ascii_digit() {
        let major = text[start..index].parse().ok()?;
        let minor_start = index + 1;
        let mut end = minor_start;
        while end < bytes.len() && bytes[end].is_ascii_digit() {
          end += 1;
        }
        return Some((major, text[minor_start..end].parse().ok()?));
      }
    } else {
      index += 1;
    }
  }
  None
}

/// `versionAtLeast(required, text)`: an unparsable version counts as new
/// enough, so Git itself reports any failure.
fn version_at_least(required: &str, text: &str) -> bool {
  let Some((major, minor)) = version_parts(text) else {
    return true;
  };
  let mut wanted = required
    .split('.')
    .map(|part| part.parse::<u64>().unwrap_or(0));
  let (want_major, want_minor) = (wanted.next().unwrap_or(0), wanted.next().unwrap_or(0));
  major > want_major || (major == want_major && minor >= want_minor)
}

fn is_object_id(text: &str) -> bool {
  (40..=64).contains(&text.len())
    && text
      .bytes()
      .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

impl MergeTreeSession {
  pub fn new(cwd: &str, attr_source: Option<&str>) -> Self {
    let git_command =
      if environment::test_hook("CAUSET_TEST_MERGE_TREE_SESSION_FAILURE").as_deref() == Some("1") {
        "vlab-intentionally-missing-git".to_string()
      } else {
        "git".to_string()
      };
    Self {
      cwd: text::resolve_path(cwd),
      attr_source: attr_source.map(str::to_string),
      session_id: format!("{}-merge-tree", std::process::id()),
      process: None,
      startup_error: None,
      closed: false,
      process_counted: false,
      git_command,
      spoof_git_version: environment::test_hook("CAUSET_TEST_MERGE_TREE_GIT_VERSION"),
      version_state: "pending",
      unusable: None,
      git_version: None,
    }
  }

  fn start(&mut self) {
    if self.process.is_some() || self.startup_error.is_some() {
      return;
    }
    let mut command = Command::new(&self.git_command);
    command
      .args(["merge-tree", "--stdin"])
      .current_dir(&self.cwd)
      .env("GIT_TERMINAL_PROMPT", "0")
      .env("GIT_TRACE2_EVENT", "2")
      .env("GIT_TRACE2_EVENT_BRIEF", "1")
      .stdin(Stdio::piped())
      .stdout(Stdio::piped())
      .stderr(Stdio::piped());
    if let Some(source) = &self.attr_source {
      command.env("GIT_ATTR_SOURCE", source);
    }
    let mut child = match command.spawn() {
      Ok(child) => child,
      Err(error) => {
        let code = if error.kind() == std::io::ErrorKind::NotFound {
          "ENOENT"
        } else {
          "EIO"
        };
        self.startup_error = Some(format!("spawn {} {code}", self.git_command));
        return;
      }
    };
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr_pipe = child.stderr.take().expect("piped stderr");
    let stderr = Arc::new(Mutex::new(String::new()));
    let (event, events) = mpsc::channel();
    let tail = Arc::clone(&stderr);
    let observe_version = self.spoof_git_version.is_none();
    std::thread::spawn(move || {
      let mut reader = BufReader::new(stderr_pipe);
      let mut line = Vec::new();
      while matches!(reader.read_until(b'\n', &mut line), Ok(read) if read > 0) {
        let text = String::from_utf8_lossy(&line).into_owned();
        let text = text.strip_suffix('\n').unwrap_or(&text);
        let text = text.strip_suffix('\r').unwrap_or(text);
        if text.starts_with('{')
          && let Ok(causet_model::json::Value::Object(parsed)) = causet_model::json::parse(text)
          && let Some(causet_model::json::Value::String(name)) = parsed.get("event")
        {
          if causet_model::json::lossy(name) == "version" && observe_version {
            let exe = match parsed.get("exe") {
              Some(causet_model::json::Value::String(exe)) => causet_model::json::lossy(exe),
              Some(causet_model::json::Value::Null) | None => "undefined".into(),
              Some(other) => causet_model::json::stringify(other),
            };
            let _ = event.send(Event::Version(exe));
          }
        } else {
          let mut kept = tail.lock().unwrap_or_else(|poison| poison.into_inner());
          kept.push_str(text);
          kept.push('\n');
          if kept.len() > STDERR_LIMIT {
            let cut = kept.len() - STDERR_LIMIT;
            let cut = (cut..kept.len())
              .find(|index| kept.is_char_boundary(*index))
              .unwrap_or(0);
            kept.drain(..cut);
          }
        }
        line.clear();
      }
    });
    let (record, records) = mpsc::channel();
    std::thread::spawn(move || {
      let mut reader = BufReader::new(stdout);
      loop {
        let result = read_record(&mut reader);
        let last = !matches!(result, Ok(MergeResult { clean: true, .. }));
        if record.send(result).is_err() || last {
          break;
        }
      }
    });
    self.process = Some(Process {
      pid: child.id(),
      stdin: child.stdin.take(),
      child,
      records,
      events,
      stderr,
      started: Instant::now(),
    });
  }

  fn failure(&self, message: String, session_failure: Option<&str>) -> MergeTreeError {
    MergeTreeError {
      message,
      session_failure: session_failure.map(str::to_string),
      git_version: self.git_version.clone(),
    }
  }

  fn too_old(&self) -> MergeTreeError {
    let version = self.git_version.clone().unwrap_or_default();
    self.failure(
      format!(
        "Git {version} is older than the {MERGE_TREE_ENGINE_MIN_GIT} the merge-tree engine needs (git merge-tree --stdin flushes each record only from {MERGE_TREE_ENGINE_MIN_GIT})."
      ),
      Some("too-old"),
    )
  }

  fn observe_version(&mut self, version: String) {
    if self.git_version.is_some() {
      return;
    }
    self.version_state = if version_at_least(MERGE_TREE_ENGINE_MIN_GIT, &version) {
      "ok"
    } else {
      "too-old"
    };
    self.git_version = Some(version);
  }

  /// Wait (from the process start) for the version event, as the worker's
  /// timer does, and settle the version state.
  fn settle_version(&mut self) {
    if self.version_state != "pending" {
      return;
    }
    if let Some(spoofed) = self.spoof_git_version.clone() {
      self.observe_version(spoofed);
      return;
    }
    let Some(process) = self.process.as_ref() else {
      return;
    };
    let remaining = VERSION_WAIT.saturating_sub(process.started.elapsed());
    match process.events.recv_timeout(remaining) {
      Ok(Event::Version(version)) => self.observe_version(version),
      Err(RecvTimeoutError::Timeout) => self.version_state = "unknown",
      Err(RecvTimeoutError::Disconnected) => {}
    }
    if self.version_state == "too-old"
      && let Some(process) = self.process.as_mut()
    {
      // No request was written; end the input so the process exits cleanly.
      drop(process.stdin.take());
    }
  }

  fn exited(&mut self) -> MergeTreeError {
    let Some(process) = self.process.as_mut() else {
      return self.failure(
        "The git merge-tree session process has exited.".into(),
        None,
      );
    };
    let deadline = Instant::now() + Duration::from_secs(2);
    let status = loop {
      match process.child.try_wait() {
        Ok(Some(status)) => {
          break status
            .code()
            .map_or("null".to_string(), |code| code.to_string());
        }
        Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(5)),
        _ => break "null".to_string(),
      }
    };
    let stderr = process
      .stderr
      .lock()
      .map(|text| text::trim(&text).to_string())
      .unwrap_or_default();
    let suffix = if stderr.is_empty() {
      String::new()
    } else {
      format!(" {stderr}")
    };
    self.failure(
      format!("git merge-tree session exited with status {status}.{suffix}"),
      Some("exited"),
    )
  }

  fn exchange(
    &mut self,
    base: &str,
    ours: &str,
    theirs: &str,
  ) -> Result<MergeResult, MergeTreeError> {
    self.start();
    if let Some(error) = &self.startup_error {
      return Err(self.failure(error.clone(), None));
    }
    self.settle_version();
    if self.version_state == "too-old" {
      return Err(self.too_old());
    }
    if let Some(reason) = &self.unusable {
      return Err(self.failure(reason.clone(), None));
    }
    let line = format!("{base} -- {ours} {theirs}\n");
    let process = self.process.as_mut().expect("started");
    let written = process.stdin.as_mut().map(|stdin| {
      stdin
        .write_all(line.as_bytes())
        .and_then(|()| stdin.flush())
    });
    if !matches!(written, Some(Ok(()))) {
      return Err(self.exited());
    }
    match process.records.recv_timeout(SESSION_TIMEOUT) {
      Ok(Ok(result)) => {
        if !result.clean {
          self.unusable = Some(
            "The merge-tree session reported a conflict and accepts no further requests.".into(),
          );
        }
        Ok(result)
      }
      Ok(Err((message, _))) if message == "eof" => Err(self.exited()),
      Ok(Err((message, unusable))) => {
        self.unusable = unusable;
        Err(self.failure(message, None))
      }
      Err(RecvTimeoutError::Timeout) => Err(self.failure("timeout".into(), None)),
      Err(RecvTimeoutError::Disconnected) => Err(self.exited()),
    }
  }

  /// Merge `theirs` onto `ours` relative to `base`, all full object IDs.
  pub fn merge(
    &mut self,
    base: &str,
    ours: &str,
    theirs: &str,
  ) -> Result<MergeResult, MergeTreeError> {
    if self.closed {
      return Err(self.failure("The merge-tree session is already closed.".into(), None));
    }
    if ![base, ours, theirs].iter().all(|oid| is_object_id(oid)) {
      return Err(self.failure(
        "Merge-tree session arguments must be full object IDs.".into(),
        None,
      ));
    }
    let started = Instant::now();
    let outcome = self.exchange(base, ours, theirs);
    let duration_ms = started.elapsed().as_secs_f64() * 1000.0;
    let process_started = !self.process_counted;
    self.process_counted = true;
    let item = Item {
      command: "merge-tree-session".into(),
      duration_ms,
      ok: outcome.is_ok(),
      transport: "session",
      process_started,
      cache_hit: false,
    };
    metrics::record(item.clone());
    metrics::trace(&item);
    outcome.map_err(|error| match error.message.as_str() {
      "timeout" => MergeTreeError {
        message: "Timed out waiting for the Git merge-tree session.".into(),
        ..error
      },
      _ => MergeTreeError {
        message: format!("Git merge-tree session failed: {}", error.message),
        ..error
      },
    })
  }

  pub fn close(&mut self) {
    if self.closed {
      return;
    }
    self.closed = true;
    if let Some(mut process) = self.process.take() {
      drop(process.stdin.take());
      crate::session::stop(&mut process.child, process.pid);
      metrics::diagnostic(
        "merge-tree-session-closed",
        vec![("sessionId", string(&self.session_id))],
      );
    }
  }
}

impl Drop for MergeTreeSession {
  fn drop(&mut self) {
    self.close();
  }
}

fn read_token(reader: &mut impl std::io::BufRead) -> Option<String> {
  let mut token = Vec::new();
  match reader.read_until(0, &mut token) {
    Ok(read) if read > 0 && token.last() == Some(&0) => {
      token.pop();
      Some(String::from_utf8_lossy(&token).into_owned())
    }
    _ => None,
  }
}

/// One record: `<status>\0<tree>\0`, then `\0` for a clean merge. The rest of
/// a conflicted record is never read; the session ends with it.
pub(crate) fn read_record(
  reader: &mut impl std::io::BufRead,
) -> Result<MergeResult, (String, Option<String>)> {
  let eof = || ("eof".to_string(), None);
  let status = read_token(reader).ok_or_else(eof)?;
  let tree = read_token(reader).ok_or_else(eof)?;
  let unusable = |message: String| (message.clone(), Some(message));
  if !is_object_id(&tree) {
    return Err(unusable(format!(
      "Unexpected git merge-tree session response: {status} {tree}"
    )));
  }
  match status.as_str() {
    "1" => {
      let mut terminator = [0u8; 1];
      reader.read_exact(&mut terminator).map_err(|_| eof())?;
      if terminator[0] != 0 {
        return Err(unusable(
          "Git returned a malformed merge-tree session record.".into(),
        ));
      }
      Ok(MergeResult { clean: true, tree })
    }
    "0" => Ok(MergeResult { clean: false, tree }),
    other => Err(unusable(format!(
      "Unexpected git merge-tree session status: {other}"
    ))),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn versions_compare_as_the_worker_compares_them() {
    assert!(version_at_least("2.49", "2.49.0.windows.1"));
    assert!(version_at_least("2.49", "git version 3.0"));
    assert!(!version_at_least("2.49", "2.48.1"));
    assert!(version_at_least("2.49", "unknown"));
  }

  #[test]
  fn records_parse_clean_and_conflicted_answers() {
    let tree = "b".repeat(40);
    let mut clean = std::io::Cursor::new(format!("1\0{tree}\0\0").into_bytes());
    assert_eq!(
      read_record(&mut clean),
      Ok(MergeResult {
        clean: true,
        tree: tree.clone()
      })
    );
    let mut conflicted = std::io::Cursor::new(format!("0\0{tree}\0x\0").into_bytes());
    assert_eq!(
      read_record(&mut conflicted),
      Ok(MergeResult { clean: false, tree })
    );
    let mut malformed = std::io::Cursor::new(b"1\0zz\0\0".to_vec());
    assert!(read_record(&mut malformed).is_err());
  }
}
