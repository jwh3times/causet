//! `cst doctor`, as `src/cli.js` answers it. Members are computed in the
//! order the JavaScript object literal evaluates them, so a failure, and every
//! Git process, happens at the same point. `implementation` and `node` are the
//! runtime self-description ADR-0037 §5 allows to differ.

use crate::migration::migration_state;
use crate::parsed::Parsed;
use causet_engine::errors::{GitError, GitResult};
use causet_engine::locations::names;
use causet_engine::metrics;
use causet_engine::process::{RunOptions, run_git};
use causet_engine::session::{enabled as session_enabled, with_object_session};
use causet_engine::{differential, engine, environment, text};
use causet_model::json::{Object, Value, string};
use std::time::Instant;

fn round(value: f64) -> f64 {
  format!("{value:.2}").parse().unwrap_or(value)
}

/// `positiveInteger(value, fallback, name, minimum)`.
fn positive_integer(
  value: Option<&str>,
  fallback: u32,
  name: &str,
  minimum: u32,
) -> GitResult<u32> {
  let Some(value) = value else {
    return Ok(fallback);
  };
  let parsed = text::number(value);
  if parsed.fract() != 0.0 || !parsed.is_finite() || parsed < f64::from(minimum) || parsed > 100.0 {
    return Err(GitError::new(
      "usage-invalid-option-value",
      format!("{name} must be an integer between {minimum} and 100."),
    ));
  }
  Ok(parsed as u32)
}

/// `percentile(sorted, fraction)`.
fn percentile(sorted: &[f64], fraction: f64) -> f64 {
  let index = ((sorted.len() as f64 * fraction).ceil() as usize).max(1) - 1;
  sorted[index]
}

/// `gitBenchmark(options)`: the raw cost of one Git process on this host.
/// These probes deliberately bypass the engine seam (`raw_probe`).
fn git_benchmark(parsed: &Parsed, cwd: &str) -> GitResult<Value> {
  let samples = positive_integer(parsed.value("samples"), 3, "--samples", 1)?;
  let warmup = positive_integer(parsed.value("warmup"), 1, "--warmup", 0)?;
  let notes = format!("--ref={}", names(cwd)?.notes_name);
  let probes: [(&str, Vec<&str>, bool); 4] = [
    ("head", vec!["rev-parse", "HEAD"], false),
    ("status", vec!["status", "--porcelain=v1"], false),
    ("history", vec!["log", "-20", "--format=%H"], false),
    ("notes", vec!["notes", &notes, "list"], true),
  ];
  let mut results = Vec::new();
  for (name, args, allow_failure) in probes {
    let args: Vec<String> = args.iter().map(|item| item.to_string()).collect();
    let mut options = RunOptions::new(cwd);
    options.allow_failure = allow_failure;
    options.raw_probe = true;
    for _ in 0..warmup {
      run_git(&args, &options)?;
    }
    let mut measured = Vec::new();
    for _ in 0..samples {
      measured.push(run_git(&args, &options)?.duration_ms);
    }
    let mut sorted = measured.clone();
    sorted.sort_by(|left, right| left.partial_cmp(right).unwrap_or(std::cmp::Ordering::Equal));
    let mut probe = Object::new();
    probe.set("name", string(name));
    probe.set("warmup", Value::Number(f64::from(warmup)));
    probe.set(
      "samplesMs",
      Value::Array(
        measured
          .iter()
          .map(|sample| Value::Number(round(*sample)))
          .collect(),
      ),
    );
    probe.set(
      "averageMs",
      Value::Number(round(measured.iter().sum::<f64>() / measured.len() as f64)),
    );
    probe.set("medianMs", Value::Number(round(percentile(&sorted, 0.5))));
    probe.set("p95Ms", Value::Number(round(percentile(&sorted, 0.95))));
    probe.set("minMs", Value::Number(round(sorted[0])));
    probe.set("maxMs", Value::Number(round(sorted[sorted.len() - 1])));
    results.push(Value::Object(probe));
  }
  Ok(Value::Array(results))
}

/// `gitObjectSessionBenchmark(options, cwd)`.
fn object_session_benchmark(parsed: &Parsed, cwd: &str) -> GitResult<Value> {
  let samples = positive_integer(parsed.value("samples"), 3, "--samples", 1)?;
  let collector = metrics::begin("doctor-object-session");
  let started = Instant::now();
  let outcome = with_object_session(cwd, || -> GitResult<()> {
    for _ in 0..samples {
      let head = engine::current_head(cwd)?;
      engine::tree_id(&head, cwd)?;
      engine::commit_subject(&head, cwd)?;
    }
    Ok(())
  });
  let duration = started.elapsed().as_secs_f64() * 1000.0;
  let measured = metrics::end(collector);
  outcome?;
  let mut report = Object::new();
  report.set("enabled", Value::Bool(session_enabled()));
  report.set("rounds", Value::Number(f64::from(samples)));
  report.set("logicalReads", Value::Number(f64::from(samples * 3)));
  report.set("durationMs", Value::Number(round(duration)));
  report.set("git", measured.to_value());
  Ok(Value::Object(report))
}

pub fn doctor(parsed: &Parsed, cwd: &str) -> GitResult<Value> {
  // A diagnostic must not change what it diagnoses: the doctor reads the
  // repository context and writes nothing.
  let context = engine::repo_context(cwd)?;
  let mut report = Object::new();
  report.set("ok", Value::Bool(true));
  report.set("version", string(crate::VERSION));
  report.set("implementation", string("rust"));
  report.set("git", string(&engine::git_version(cwd)?.raw));
  report.set("node", Value::Null);
  report.set("repository", string(&context.root));
  report.set("notesRef", string(names(&context.root)?.notes_ref));
  report.set("engine", engine::describe_read_engines()?);
  report.set("forecastEngine", string(&engine::forecast_engine()?));
  report.set(
    "legacyEnvironment",
    Value::Array(
      environment::legacy_variables_in_use()
        .iter()
        .map(|name| string(name))
        .collect(),
    ),
  );
  report.set("migration", string(migration_state(&context.root)?));
  if parsed.truthy("differential") {
    report.set(
      "differential",
      differential::run_differential(&context.root)?,
    );
  }
  if parsed.truthy("benchmark") {
    report.set("benchmark", git_benchmark(parsed, cwd)?);
    report.set(
      "objectSession",
      object_session_benchmark(parsed, &context.root)?,
    );
  }
  Ok(Value::Object(report))
}
