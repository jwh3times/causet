//! The invocation-scoped object session (ADR-0009): one persistent
//! `git cat-file --batch-command` process per repository, answering `info`
//! and `contents` queries for the life of a `with_object_session` call.
//!
//! The JavaScript engine runs the process in a worker thread and waits on a
//! shared buffer; here a reader thread parses responses into a channel. What
//! is observable is kept: the same queries, the same cache of immutable
//! expressions, the same metrics (one process, counted on the first query),
//! the same response budget, and the same fallback to ordinary processes when
//! the session fails.

use crate::environment;
use crate::errors::{GitError, GitResult};
use crate::metrics::{self, Item};
use crate::text;
use causet_model::json::{Value, object, string, stringify};
use std::cell::RefCell;
use std::collections::HashMap;
use std::io::{BufReader, Read as _, Write as _};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::rc::Rc;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const SESSION_INFO_BUFFER_BYTES: usize = 1024 * 1024;
const SESSION_CONTENT_BUFFER_BYTES: usize = 64 * 1024 * 1024;
const SESSION_TIMEOUT: Duration = Duration::from_secs(60);
const STDERR_LIMIT: usize = 64 * 1024;

/// One object as the session (or `git cat-file --batch`) describes it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionObject {
  pub expression: String,
  pub exists: bool,
  pub oid: Option<String>,
  pub kind: Option<String>,
  pub size: u64,
  pub content: Option<Vec<u8>>,
}

impl SessionObject {
  pub(crate) fn missing(expression: &str) -> Self {
    Self {
      expression: expression.to_string(),
      exists: false,
      oid: None,
      kind: None,
      size: 0,
      content: None,
    }
  }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Query {
  Info,
  Contents,
}

impl Query {
  fn name(self) -> &'static str {
    match self {
      Query::Info => "info",
      Query::Contents => "contents",
    }
  }
}

/// `sessionResponseBytes(command)`, including the `CAUSET_TEST_SESSION_BUFFER_BYTES`
/// test hook, which is inert unless it is a positive integer.
fn response_budget(query: Query) -> usize {
  if let Some(value) = environment::test_hook("CAUSET_TEST_SESSION_BUFFER_BYTES") {
    let number = text::number(&value);
    if number.fract() == 0.0 && number > 0.0 && number.is_finite() {
      return number as usize;
    }
  }
  match query {
    Query::Info => SESSION_INFO_BUFFER_BYTES,
    Query::Contents => SESSION_CONTENT_BUFFER_BYTES,
  }
}

/// The byte length of the JSON response the JavaScript worker would have
/// written into its shared buffer, which decides whether it overflowed.
fn response_length(results: &[SessionObject]) -> usize {
  let mut length = r#"{"ok":true,"results":[]}"#.len();
  for (index, result) in results.iter().enumerate() {
    let base64 = result
      .content
      .as_ref()
      .map(|content| content.len().div_ceil(3) * 4);
    let shape = object([
      ("expression", string(&result.expression)),
      ("exists", Value::Bool(result.exists)),
      ("oid", result.oid.as_deref().map_or(Value::Null, string)),
      ("type", result.kind.as_deref().map_or(Value::Null, string)),
      ("size", Value::Number(result.size as f64)),
      (
        "content",
        if base64.is_some() {
          string("")
        } else {
          Value::Null
        },
      ),
    ]);
    length += stringify(&shape).len() + base64.unwrap_or(0) + usize::from(index > 0);
  }
  length
}

/// `immutableObjectExpression`: a full object ID, optionally peeled, optionally
/// with a path. Only these are cached.
fn immutable(expression: &str) -> bool {
  let hex = expression.bytes().take_while(u8::is_ascii_hexdigit).count();
  if !(40..=64).contains(&hex) {
    return false;
  }
  let mut rest = &expression[hex..];
  for peel in ["^{blob}", "^{commit}", "^{tag}", "^{tree}"] {
    if let Some(after) = strip_prefix_ignore_case(rest, peel) {
      rest = after;
      break;
    }
  }
  rest.is_empty() || (rest.starts_with(':') && !rest.chars().any(text::is_line_terminator))
}

fn strip_prefix_ignore_case<'a>(text: &'a str, prefix: &str) -> Option<&'a str> {
  (text.len() >= prefix.len() && text[..prefix.len()].eq_ignore_ascii_case(prefix))
    .then(|| &text[prefix.len()..])
}

/// `validateObjectExpressions`.
pub(crate) fn validate_expressions<S: AsRef<str>>(expressions: &[S]) -> GitResult<()> {
  for expression in expressions {
    let expression = expression.as_ref();
    if expression.contains('\n') || expression.contains('\r') {
      return Err(GitError::new(
        "unsafe-input",
        "Git object expressions cannot contain newlines.",
      ));
    }
  }
  Ok(())
}

struct SessionProcess {
  child: Child,
  stdin: Option<ChildStdin>,
  expect: Sender<Query>,
  responses: Receiver<Result<SessionObject, String>>,
  stderr: Arc<Mutex<String>>,
  pid: u32,
}

struct ObjectSession {
  cwd: String,
  session_id: String,
  cache: HashMap<String, SessionObject>,
  process_counted: bool,
  closed: bool,
  failed: bool,
  process: Option<SessionProcess>,
  startup_error: Option<String>,
  git_command: String,
  next_request: u64,
}

thread_local! {
  static SESSIONS: RefCell<HashMap<String, Rc<RefCell<ObjectSession>>>> = RefCell::new(HashMap::new());
  static NEXT_SESSION: RefCell<u64> = const { RefCell::new(1) };
}

fn session_id() -> String {
  NEXT_SESSION.with(|next| {
    let mut next = next.borrow_mut();
    let id = *next;
    *next += 1;
    format!("{}-{id}", std::process::id())
  })
}

impl ObjectSession {
  fn new(cwd: String) -> Self {
    let git_command =
      if environment::test_hook("CAUSET_TEST_GIT_SESSION_FAILURE").as_deref() == Some("1") {
        "vlab-intentionally-missing-git".to_string()
      } else {
        "git".to_string()
      };
    let session = Self {
      session_id: session_id(),
      cwd,
      cache: HashMap::new(),
      process_counted: false,
      closed: false,
      failed: false,
      process: None,
      startup_error: None,
      git_command,
      next_request: 1,
    };
    metrics::diagnostic(
      "session-created",
      vec![
        ("sessionId", string(&session.session_id)),
        ("cwd", string(&session.cwd)),
        ("gitCommand", string(&session.git_command)),
        ("workerStarted", Value::Bool(false)),
      ],
    );
    session
  }

  fn start(&mut self) {
    if self.process.is_some() || self.startup_error.is_some() {
      return;
    }
    let spawned = Command::new(&self.git_command)
      .args(["cat-file", "--batch-command"])
      .current_dir(&self.cwd)
      .env("GIT_TERMINAL_PROMPT", "0")
      .stdin(Stdio::piped())
      .stdout(Stdio::piped())
      .stderr(Stdio::piped())
      .spawn();
    let mut child = match spawned {
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
    let mut stderr_pipe = child.stderr.take().expect("piped stderr");
    let stderr = Arc::new(Mutex::new(String::new()));
    let tail = Arc::clone(&stderr);
    std::thread::spawn(move || {
      let mut buffer = [0u8; 8192];
      while let Ok(read) = stderr_pipe.read(&mut buffer) {
        if read == 0 {
          break;
        }
        let mut text = tail.lock().unwrap_or_else(|poison| poison.into_inner());
        text.push_str(&String::from_utf8_lossy(&buffer[..read]));
        if text.len() > STDERR_LIMIT {
          let cut = text.len() - STDERR_LIMIT;
          let cut = (cut..text.len())
            .find(|index| text.is_char_boundary(*index))
            .unwrap_or(0);
          text.drain(..cut);
        }
      }
    });
    let (expect, expected) = mpsc::channel::<Query>();
    let (answer, responses) = mpsc::channel();
    std::thread::spawn(move || {
      let mut reader = BufReader::new(stdout);
      while let Ok(query) = expected.recv() {
        let result = read_response(&mut reader, query);
        let failed = result.is_err();
        if answer.send(result).is_err() || failed {
          break;
        }
      }
    });
    self.process = Some(SessionProcess {
      pid: child.id(),
      stdin: child.stdin.take(),
      child,
      expect,
      responses,
      stderr,
    });
  }

  fn request(&mut self, query: Query, expressions: &[String]) -> GitResult<Vec<SessionObject>> {
    if self.closed {
      return Err(GitError::new(
        "session-unavailable",
        "The Git object session is already closed.",
      ));
    }
    validate_expressions(expressions)?;
    let request_id = self.next_request;
    self.next_request += 1;
    metrics::diagnostic(
      "request-start",
      vec![
        ("sessionId", string(&self.session_id)),
        ("requestId", Value::Number(request_id as f64)),
        ("command", string(query.name())),
        ("expressions", diagnostic_expressions(expressions)),
      ],
    );
    let keys: Vec<Option<String>> = expressions
      .iter()
      .map(|expression| immutable(expression).then(|| format!("{}\0{expression}", query.name())))
      .collect();
    let mut results: Vec<Option<SessionObject>> = keys
      .iter()
      .map(|key| key.as_ref().and_then(|key| self.cache.get(key).cloned()))
      .collect();
    if results.iter().all(Option::is_some) {
      let item = Item {
        command: "object-cache".into(),
        duration_ms: 0.0,
        ok: true,
        transport: "cache",
        process_started: false,
        cache_hit: true,
      };
      metrics::record(item.clone());
      metrics::trace(&item);
      metrics::diagnostic(
        "request-cache-hit",
        vec![
          ("sessionId", string(&self.session_id)),
          ("requestId", Value::Number(request_id as f64)),
          ("command", string(query.name())),
          ("count", Value::Number(expressions.len() as f64)),
        ],
      );
      return Ok(
        results
          .into_iter()
          .map(|result| result.expect("cached"))
          .collect(),
      );
    }
    let missing: Vec<usize> = (0..expressions.len())
      .filter(|index| results[*index].is_none())
      .collect();
    let started = Instant::now();
    self.start();
    let outcome = self.exchange(query, missing.iter().map(|index| &expressions[*index]));
    let duration_ms = started.elapsed().as_secs_f64() * 1000.0;
    let process_started = !self.process_counted;
    self.process_counted = true;
    let outcome = outcome.and_then(|answers| {
      if response_length(&answers) > response_budget(query) {
        Err("Git object-session response exceeded its shared buffer.".to_string())
      } else {
        Ok(answers)
      }
    });
    let item = Item {
      command: "cat-file-session".into(),
      duration_ms,
      ok: outcome.is_ok(),
      transport: "session",
      process_started,
      cache_hit: false,
    };
    metrics::record(item.clone());
    metrics::trace(&item);
    metrics::diagnostic(
      "response-received",
      vec![
        ("sessionId", string(&self.session_id)),
        ("requestId", Value::Number(request_id as f64)),
        ("command", string(query.name())),
        ("ok", Value::Bool(outcome.is_ok())),
        (
          "error",
          outcome
            .as_ref()
            .err()
            .map_or(Value::Null, |message| string(message)),
        ),
      ],
    );
    let answers = match outcome {
      Ok(answers) => answers,
      Err(message) if message == "timeout" => {
        return Err(GitError::new(
          "session-unavailable",
          "Timed out waiting for the Git object session.",
        ));
      }
      Err(message) => {
        return Err(GitError::new(
          "session-unavailable",
          format!("Git object session failed: {message}"),
        ));
      }
    };
    for (position, answer) in answers.into_iter().enumerate() {
      let index = missing[position];
      if let Some(key) = &keys[index] {
        self.cache.insert(key.clone(), answer.clone());
      }
      results[index] = Some(answer);
    }
    Ok(
      results
        .into_iter()
        .map(|result| result.expect("answered"))
        .collect(),
    )
  }

  /// Write every query, then read every answer: the reader thread drains
  /// Git's output as it arrives, so the writes cannot deadlock.
  fn exchange<'a>(
    &mut self,
    query: Query,
    expressions: impl Iterator<Item = &'a String>,
  ) -> Result<Vec<SessionObject>, String> {
    if let Some(error) = &self.startup_error {
      return Err(error.clone());
    }
    let process = self.process.as_mut().expect("started");
    let expressions: Vec<&String> = expressions.collect();
    for expression in &expressions {
      if process.expect.send(query).is_err() {
        return Err(exited(process));
      }
      let written = process
        .stdin
        .as_mut()
        .map(|stdin| stdin.write_all(format!("{} {expression}\n", query.name()).as_bytes()));
      if !matches!(written, Some(Ok(()))) {
        return Err(exited(process));
      }
    }
    if let Some(stdin) = process.stdin.as_mut() {
      let _ = stdin.flush();
    }
    let deadline = Instant::now() + SESSION_TIMEOUT;
    let mut answers = Vec::with_capacity(expressions.len());
    for expression in expressions {
      let remaining = deadline.saturating_duration_since(Instant::now());
      match process.responses.recv_timeout(remaining) {
        Ok(Ok(mut answer)) => {
          answer.expression = expression.clone();
          answers.push(answer);
        }
        Ok(Err(message)) if message == "eof" => return Err(exited(process)),
        Ok(Err(message)) => return Err(message),
        Err(RecvTimeoutError::Timeout) => return Err("timeout".into()),
        Err(RecvTimeoutError::Disconnected) => return Err(exited(process)),
      }
    }
    Ok(answers)
  }

  fn shut_down(&mut self, event: &str) {
    if let Some(mut process) = self.process.take() {
      // The worker's shutdown events, in its order, so a diagnostics reader
      // sees the same close sequence from either implementation. Requests are
      // synchronous here, so none is ever pending at close.
      let pending = || ("pending", Value::Number(0.0));
      let exited = process.child.try_wait().ok().flatten();
      metrics::diagnostic(
        "close-start",
        vec![
          pending(),
          ("gitExitCode", exited.and_then(|status| status.code()).map_or(Value::Null, |code| Value::Number(f64::from(code)))),
          ("gitSignalCode", Value::Null),
        ],
      );
      drop(process.stdin.take());
      if exited.is_none() {
        metrics::diagnostic("close-stdin-end", vec![pending()]);
      }
      metrics::diagnostic(event, vec![("sessionId", string(&self.session_id))]);
      let stopped = stop(&mut process.child, process.pid);
      if stopped.killed {
        metrics::diagnostic(
          "close-git-kill",
          vec![
            pending(),
            ("pid", Value::Number(f64::from(process.pid))),
            ("tree", Value::Bool(cfg!(windows))),
          ],
        );
      }
      metrics::diagnostic(
        "git-close",
        vec![
          ("code", stopped.code.map_or(Value::Null, |code| Value::Number(f64::from(code)))),
          ("signal", if stopped.killed && stopped.code.is_none() { string("SIGKILL") } else { Value::Null }),
          pending(),
        ],
      );
      metrics::diagnostic(
        "close-finish",
        vec![pending(), ("ok", Value::Bool(true)), ("error", Value::Null)],
      );
    }
  }

  fn close(&mut self) {
    if self.closed {
      return;
    }
    self.closed = true;
    if self.process.is_none() {
      // A session that never started its process, as one that never created
      // its worker: a refusal before the first object read.
      metrics::diagnostic("session-close-no-worker", vec![("sessionId", string(&self.session_id))]);
      return;
    }
    self.shut_down("session-close-terminated");
  }

  fn disable(&mut self) {
    if self.closed {
      return;
    }
    self.failed = true;
    self.closed = true;
    self.shut_down("session-disable-terminated");
  }
}

/// `git cat-file session exited with status <code>.` and Git's stderr.
fn exited(process: &mut SessionProcess) -> String {
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
  format!("git cat-file session exited with status {status}.{suffix}")
}

/// Close stdin, give Git two seconds to exit, then end the process tree, as
/// the worker's shutdown does.
pub(crate) fn stop(child: &mut Child, pid: u32) -> Stopped {
  let deadline = Instant::now() + Duration::from_secs(2);
  loop {
    match child.try_wait() {
      Ok(Some(status)) => return Stopped { code: status.code(), killed: false },
      Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(2)),
      _ => break,
    }
  }
  if cfg!(windows) {
    let killed = Command::new("taskkill.exe")
      .args(["/PID", &pid.to_string(), "/T", "/F"])
      .stdin(Stdio::null())
      .stdout(Stdio::null())
      .stderr(Stdio::null())
      .status();
    if !matches!(killed, Ok(status) if status.success()) {
      let _ = child.kill();
    }
  } else {
    let _ = child.kill();
  }
  let code = child.wait().ok().and_then(|status| status.code());
  Stopped { code, killed: true }
}

/// How a stopped Git process ended: its exit code, if it had one, and whether
/// it had to be killed after the grace period.
pub(crate) struct Stopped {
  pub code: Option<i32>,
  pub killed: bool,
}

/// One response: a header line, and for `contents` the object and its `\n`.
pub(crate) fn read_response(
  reader: &mut impl std::io::BufRead,
  query: Query,
) -> Result<SessionObject, String> {
  let mut header = Vec::new();
  match reader.read_until(b'\n', &mut header) {
    Ok(0) => return Err("eof".into()),
    Ok(_) if header.last() == Some(&b'\n') => {
      header.pop();
    }
    Ok(_) => return Err("eof".into()),
    Err(error) => return Err(error.to_string()),
  }
  let header = String::from_utf8_lossy(&header).into_owned();
  if header.ends_with(" missing") {
    return Ok(SessionObject::missing(""));
  }
  let Some((oid, kind, size)) = parse_header(&header) else {
    return Err(format!("Unexpected git cat-file session header: {header}"));
  };
  if query == Query::Info {
    return Ok(SessionObject {
      expression: String::new(),
      exists: true,
      oid: Some(oid),
      kind: Some(kind),
      size,
      content: None,
    });
  }
  let length = usize::try_from(size).map_err(|_| "object too large".to_string())?;
  let mut content = vec![0u8; length];
  reader
    .read_exact(&mut content)
    .map_err(|_| "eof".to_string())?;
  let mut terminator = [0u8; 1];
  reader
    .read_exact(&mut terminator)
    .map_err(|_| "eof".to_string())?;
  if terminator[0] != b'\n' {
    return Err("Git returned malformed session object content.".into());
  }
  Ok(SessionObject {
    expression: String::new(),
    exists: true,
    oid: Some(oid),
    kind: Some(kind),
    size,
    content: Some(content),
  })
}

/// `/^([0-9a-f]+) (\S+) (\d+)$/` on a batch header.
pub(crate) fn parse_header(header: &str) -> Option<(String, String, u64)> {
  let mut parts = header.split(' ');
  let oid = parts.next()?;
  let kind = parts.next()?;
  let size = parts.next()?;
  if parts.next().is_some()
    || oid.is_empty()
    || !oid
      .bytes()
      .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    || kind.is_empty()
    || kind.chars().any(text::is_space)
    || size.is_empty()
    || !size.bytes().all(|b| b.is_ascii_digit())
  {
    return None;
  }
  Some((oid.to_string(), kind.to_string(), size.parse().ok()?))
}

fn diagnostic_expressions(expressions: &[String]) -> Value {
  let mut shown: Vec<Value> = expressions
    .iter()
    .take(8)
    .map(|item| string(item))
    .collect();
  if expressions.len() > 8 {
    shown.push(string(&format!("... {} more", expressions.len() - 8)));
  }
  Value::Array(shown)
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

/// `gitObjectSessionEnabled()`: `CAUSET_GIT_SESSION` forces it on (`1`) or off
/// (`0`); otherwise it is the default on Windows only.
pub fn enabled() -> bool {
  match environment::value("GIT_SESSION").as_deref() {
    Some("0") => false,
    Some("1") => true,
    _ => cfg!(windows),
  }
}

fn active(cwd: &str) -> Option<Rc<RefCell<ObjectSession>>> {
  let key = text::resolve_path(cwd);
  SESSIONS.with(|sessions| sessions.borrow().get(&key).cloned())
}

/// Whether a session is open for `cwd` and has not failed.
pub(crate) fn healthy(cwd: &str) -> bool {
  active(cwd).is_some_and(|session| !session.borrow().failed)
}

/// `invalidateObjectSession(cwd)`, after a successful mutation.
pub(crate) fn invalidate(cwd: &str) {
  if let Some(session) = active(cwd) {
    session.borrow_mut().cache.clear();
  }
}

/// `queryObjectSession`: the session's answer, or `None` when there is no
/// session or it failed, in which case it is disabled for the rest of its
/// life and the caller uses ordinary processes.
pub(crate) fn query(cwd: &str, query: Query, expressions: &[String]) -> Option<Vec<SessionObject>> {
  let session = active(cwd)?;
  if session.borrow().failed {
    return None;
  }
  let result = session.borrow_mut().request(query, expressions);
  match result {
    Ok(objects) => Some(objects),
    Err(error) => {
      let mut session = session.borrow_mut();
      metrics::diagnostic(
        "session-fallback",
        vec![
          ("sessionId", string(&session.session_id)),
          ("command", string(query.name())),
          ("expressions", diagnostic_expressions(expressions)),
          ("message", string(&error.message)),
        ],
      );
      session.disable();
      metrics::trace_line(&format!(
        "[cst trace] Git object session unavailable; using ordinary processes ({})\n",
        error.message
      ));
      None
    }
  }
}

struct Registration {
  key: String,
}

impl Drop for Registration {
  fn drop(&mut self) {
    let session = SESSIONS.with(|sessions| sessions.borrow_mut().remove(&self.key));
    if let Some(session) = session {
      let mut session = session.borrow_mut();
      metrics::diagnostic(
        "session-exit",
        vec![
          ("sessionId", string(&session.session_id)),
          ("cwd", string(&self.key)),
        ],
      );
      session.close();
    }
  }
}

/// `withGitObjectSession(cwd, callback)`: run `callback` with a session open
/// for `cwd`. Re-entrant; a no-op when sessions are disabled.
pub fn with_object_session<T>(cwd: &str, callback: impl FnOnce() -> T) -> T {
  if !enabled() {
    return callback();
  }
  let key = text::resolve_path(cwd);
  if SESSIONS.with(|sessions| sessions.borrow().contains_key(&key)) {
    return callback();
  }
  let session = ObjectSession::new(key.clone());
  metrics::diagnostic(
    "session-enter",
    vec![
      ("sessionId", string(&session.session_id)),
      ("cwd", string(&key)),
    ],
  );
  SESSIONS.with(|sessions| {
    sessions
      .borrow_mut()
      .insert(key.clone(), Rc::new(RefCell::new(session)))
  });
  let _registration = Registration { key };
  callback()
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn only_full_object_ids_are_cached() {
    let oid = "a".repeat(40);
    assert!(immutable(&oid));
    assert!(immutable(&format!("{oid}^{{TREE}}")));
    assert!(immutable(&format!("{oid}:path/x")));
    assert!(immutable(&format!("{oid}^{{commit}}:")));
    assert!(!immutable(&format!("{oid}^{{commit}}~1")));
    assert!(!immutable(&"a".repeat(39)));
    assert!(!immutable(&format!("{oid}:a\u{2028}")));
    assert!(!immutable("HEAD"));
  }

  #[test]
  fn headers_parse_as_the_javascript_expression_does() {
    assert_eq!(
      parse_header(&format!("{} blob 12", "a".repeat(40))),
      Some(("a".repeat(40), "blob".into(), 12))
    );
    assert_eq!(parse_header("A blob 1"), None);
    assert_eq!(parse_header("a blob 1 x"), None);
    assert_eq!(parse_header("a blob -1"), None);
  }

  #[test]
  fn the_response_length_is_the_workers_json() {
    let answer = SessionObject {
      expression: "x".into(),
      exists: true,
      oid: Some("ab".into()),
      kind: Some("blob".into()),
      size: 4,
      content: Some(b"abcd".to_vec()),
    };
    let expected = r#"{"ok":true,"results":[{"expression":"x","exists":true,"oid":"ab","type":"blob","size":4,"content":"YWJjZA=="},{"expression":"y","exists":false,"oid":null,"type":null,"size":0,"content":null}]}"#;
    assert_eq!(
      response_length(&[answer, SessionObject::missing("y")]),
      expected.len()
    );
  }
}
