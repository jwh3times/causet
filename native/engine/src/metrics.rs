//! Git metrics, trace lines and session diagnostics, as `src/git.js` keeps
//! them: every active collector sees every Git process, session query and
//! cache hit, every engine fallback, every native read and every direct read.

use crate::environment;
use causet_model::json::{Value, object, string, stringify};
use std::cell::RefCell;
use std::io::Write as _;

/// One Git invocation, session query or cache hit.
#[derive(Clone, Debug)]
pub struct Item {
  pub command: String,
  pub duration_ms: f64,
  pub ok: bool,
  pub transport: &'static str,
  pub process_started: bool,
  pub cache_hit: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Fallback {
  pub operation: String,
  pub reason: String,
  pub detail: Option<String>,
}

#[derive(Default)]
struct Collector {
  id: u64,
  label: String,
  commands: Vec<Item>,
  fallbacks: Vec<Fallback>,
  direct_reads: u64,
  native_reads: Vec<(String, u64)>,
}

thread_local! {
  static COLLECTORS: RefCell<Vec<Collector>> = const { RefCell::new(Vec::new()) };
  static NEXT_COLLECTOR: RefCell<u64> = const { RefCell::new(1) };
}

/// A handle for `end`; collectors nest and overlap freely.
#[derive(Debug)]
pub struct CollectorId(u64);

/// `beginGitMetrics(label)`.
pub fn begin(label: &str) -> CollectorId {
  let id = NEXT_COLLECTOR.with(|next| {
    let mut next = next.borrow_mut();
    *next += 1;
    *next
  });
  COLLECTORS.with(|collectors| {
    collectors.borrow_mut().push(Collector {
      id,
      label: label.to_string(),
      ..Collector::default()
    })
  });
  CollectorId(id)
}

pub(crate) fn record(item: Item) {
  COLLECTORS.with(|collectors| {
    for collector in collectors.borrow_mut().iter_mut() {
      collector.commands.push(item.clone());
    }
  });
}

/// `recordEngineFallback(record)`.
pub fn record_fallback(fallback: Fallback) {
  COLLECTORS.with(|collectors| {
    for collector in collectors.borrow_mut().iter_mut() {
      collector.fallbacks.push(fallback.clone());
    }
  });
}

/// `recordNativeRead(operation)`.
pub fn record_native_read(operation: &str) {
  COLLECTORS.with(|collectors| {
    for collector in collectors.borrow_mut().iter_mut() {
      match collector
        .native_reads
        .iter_mut()
        .find(|(name, _)| name == operation)
      {
        Some((_, count)) => *count += 1,
        None => collector.native_reads.push((operation.to_string(), 1)),
      }
    }
  });
}

pub(crate) fn record_direct_read(command: &str) {
  COLLECTORS.with(|collectors| {
    for collector in collectors.borrow_mut().iter_mut() {
      collector.direct_reads += 1;
    }
  });
  if environment::value("TRACE").as_deref() == Some("1") {
    eprint(&format!(
      "[cst trace] git {command} was read outside the engine seam\n"
    ));
  }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FallbackCount {
  pub operation: String,
  pub reason: String,
  pub count: u64,
}

#[derive(Clone, Debug)]
pub struct CommandMetrics {
  pub command: String,
  pub count: u64,
  pub processes: u64,
  pub session_queries: u64,
  pub cache_hits: u64,
  pub total_ms: f64,
  pub max_ms: f64,
}

/// What `endGitMetrics` returns.
#[derive(Clone, Debug)]
pub struct Metrics {
  pub label: String,
  pub count: u64,
  pub processes: u64,
  pub session_queries: u64,
  pub cache_hits: u64,
  pub total_ms: f64,
  pub failed: u64,
  pub engine: String,
  pub fallbacks: Vec<FallbackCount>,
  pub native_reads: Vec<(String, u64)>,
  pub direct_reads: u64,
  pub by_command: Vec<CommandMetrics>,
}

fn two_places(value: f64) -> f64 {
  format!("{value:.2}").parse().unwrap_or(value)
}

/// `aggregateFallbacks`: one entry per operation and reason, sorted.
pub fn aggregate(fallbacks: &[Fallback]) -> Vec<FallbackCount> {
  let mut out: Vec<FallbackCount> = Vec::new();
  for item in fallbacks {
    match out
      .iter_mut()
      .find(|entry| entry.operation == item.operation && entry.reason == item.reason)
    {
      Some(entry) => entry.count += 1,
      None => out.push(FallbackCount {
        operation: item.operation.clone(),
        reason: item.reason.clone(),
        count: 1,
      }),
    }
  }
  out.sort_by(|left, right| {
    crate::text::compare(&left.operation, &right.operation)
      .then_with(|| crate::text::compare(&left.reason, &right.reason))
  });
  out
}

/// `endGitMetrics(collector)`.
pub fn end(id: CollectorId) -> Metrics {
  let collector = COLLECTORS.with(|collectors| {
    let mut collectors = collectors.borrow_mut();
    let index = collectors
      .iter()
      .position(|collector| collector.id == id.0)
      .expect("an active collector");
    collectors.remove(index)
  });
  let items = &collector.commands;
  let mut by_command: Vec<CommandMetrics> = Vec::new();
  for item in items {
    let entry = match by_command
      .iter_mut()
      .position(|entry| entry.command == item.command)
    {
      Some(index) => &mut by_command[index],
      None => {
        by_command.push(CommandMetrics {
          command: item.command.clone(),
          count: 0,
          processes: 0,
          session_queries: 0,
          cache_hits: 0,
          total_ms: 0.0,
          max_ms: 0.0,
        });
        by_command.last_mut().expect("just pushed")
      }
    };
    entry.count += 1;
    entry.processes += u64::from(item.process_started);
    entry.session_queries += u64::from(item.transport == "session");
    entry.cache_hits += u64::from(item.cache_hit);
    entry.total_ms += item.duration_ms;
    entry.max_ms = entry.max_ms.max(item.duration_ms);
  }
  for entry in &mut by_command {
    entry.total_ms = two_places(entry.total_ms);
    entry.max_ms = two_places(entry.max_ms);
  }
  by_command.sort_by(|left, right| {
    right
      .total_ms
      .partial_cmp(&left.total_ms)
      .unwrap_or(std::cmp::Ordering::Equal)
      .then_with(|| crate::text::compare(&left.command, &right.command))
  });
  let count =
    |predicate: &dyn Fn(&Item) -> bool| items.iter().filter(|item| predicate(item)).count() as u64;
  Metrics {
    label: collector.label.clone(),
    count: items.len() as u64,
    processes: count(&|item| item.process_started),
    session_queries: count(&|item| item.transport == "session"),
    cache_hits: count(&|item| item.cache_hit),
    total_ms: two_places(items.iter().map(|item| item.duration_ms).sum()),
    failed: count(&|item| !item.ok),
    engine: crate::engine::read_engine()
      .map(|engine| engine.name().to_string())
      .unwrap_or_else(|_| environment::value("ENGINE").unwrap_or_default()),
    fallbacks: aggregate(&collector.fallbacks),
    native_reads: collector.native_reads.clone(),
    direct_reads: collector.direct_reads,
    by_command,
  }
}

impl Metrics {
  /// The JSON `endGitMetrics` returns, in its member order.
  pub fn to_value(&self) -> Value {
    let mut native = causet_model::json::Object::new();
    for (operation, count) in &self.native_reads {
      native.set(operation, Value::Number(*count as f64));
    }
    object([
      ("count", Value::Number(self.count as f64)),
      ("processes", Value::Number(self.processes as f64)),
      ("sessionQueries", Value::Number(self.session_queries as f64)),
      ("cacheHits", Value::Number(self.cache_hits as f64)),
      ("totalMs", Value::Number(self.total_ms)),
      ("failed", Value::Number(self.failed as f64)),
      ("engine", string(&self.engine)),
      ("fallbacks", fallbacks_value(&self.fallbacks)),
      ("nativeReads", Value::Object(native)),
      ("directReads", Value::Number(self.direct_reads as f64)),
      (
        "byCommand",
        Value::Array(
          self
            .by_command
            .iter()
            .map(|entry| {
              object([
                ("command", string(&entry.command)),
                ("count", Value::Number(entry.count as f64)),
                ("processes", Value::Number(entry.processes as f64)),
                (
                  "sessionQueries",
                  Value::Number(entry.session_queries as f64),
                ),
                ("cacheHits", Value::Number(entry.cache_hits as f64)),
                ("totalMs", Value::Number(entry.total_ms)),
                ("maxMs", Value::Number(entry.max_ms)),
              ])
            })
            .collect(),
        ),
      ),
    ])
  }
}

pub fn fallbacks_value(fallbacks: &[FallbackCount]) -> Value {
  Value::Array(
    fallbacks
      .iter()
      .map(|item| {
        object([
          ("operation", string(&item.operation)),
          ("reason", string(&item.reason)),
          ("count", Value::Number(item.count as f64)),
        ])
      })
      .collect(),
  )
}

// ---------------------------------------------------------------------------
// Trace and diagnostics
// ---------------------------------------------------------------------------

pub(crate) fn eprint(text: &str) {
  let _ = std::io::stderr().write_all(text.as_bytes());
}

/// `traceGitMetric(item)`.
pub(crate) fn trace(item: &Item) {
  if environment::value("TRACE").as_deref() != Some("1") {
    return;
  }
  let detail = if item.cache_hit {
    "cache hit"
  } else if item.transport == "session" {
    if item.process_started {
      "new persistent process"
    } else {
      "reused persistent process"
    }
  } else {
    "new process"
  };
  eprint(&format!(
    "[cst trace] {:.1}ms git {} ({detail})\n",
    item.duration_ms, item.command
  ));
}

pub(crate) fn trace_line(text: &str) {
  if environment::value("TRACE").as_deref() == Some("1") {
    eprint(text);
  }
}

/// `sessionDiagnostic(event, details)`: one JSON line on stderr, and appended
/// to `CAUSET_GIT_SESSION_DIAGNOSTICS_FILE` when that is set.
pub(crate) fn diagnostic(event: &str, details: Vec<(&str, Value)>) {
  if environment::value("GIT_SESSION_DIAGNOSTICS").as_deref() != Some("1") {
    return;
  }
  let mut line = causet_model::json::Object::new();
  line.set("at", string(&iso_now()));
  line.set("pid", Value::Number(f64::from(std::process::id())));
  line.set("event", string(event));
  for (name, value) in details {
    line.set(name, value);
  }
  let text = format!("[cst session] {}\n", stringify(&Value::Object(line)));
  eprint(&text);
  if let Some(path) =
    environment::value("GIT_SESSION_DIAGNOSTICS_FILE").filter(|path| !path.is_empty())
    && let Ok(mut file) = std::fs::OpenOptions::new()
      .create(true)
      .append(true)
      .open(path)
  {
    // Diagnostics must never change session behavior.
    let _ = file.write_all(text.as_bytes());
  }
}

/// `new Date().toISOString()`.
fn iso_now() -> String {
  let now = std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .unwrap_or_default();
  let millis = now.as_millis() as i64;
  let days = millis.div_euclid(86_400_000);
  let rest = millis.rem_euclid(86_400_000);
  // Howard Hinnant's civil-from-days.
  let z = days + 719_468;
  let era = z.div_euclid(146_097);
  let doe = z.rem_euclid(146_097);
  let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
  let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  let mp = (5 * doy + 2) / 153;
  let day = doy - (153 * mp + 2) / 5 + 1;
  let month = if mp < 10 { mp + 3 } else { mp - 9 };
  let year = yoe + era * 400 + i64::from(month <= 2);
  format!(
    "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
    rest / 3_600_000,
    rest / 60_000 % 60,
    rest / 1000 % 60,
    rest % 1000
  )
}
