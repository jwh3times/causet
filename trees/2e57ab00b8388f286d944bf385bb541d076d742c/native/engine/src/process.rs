//! One Git process, as `runGit` in `src/git.js` launches it: the caller's
//! environment plus `GIT_TERMINAL_PROMPT=0`, captured output, metrics, the
//! object-session invalidation after a successful mutation, and the bypass
//! rule of ADR-0019.

use crate::errors::{GitError, GitResult};
use crate::metrics::{self, Item};
use crate::text;
use causet_model::json::{Value, string};
use std::io::{Read as _, Write as _};
use std::process::{Command, Stdio};
use std::time::Instant;

const DEFAULT_MAX_BUFFER: usize = 256 * 1024 * 1024;

/// Configuration prepended to every `cherry-pick` and landing `merge`
/// (ADR-0018): Git's `rerere` must not resolve or record a conflict.
pub const GIT_NO_RERERE: [&str; 2] = ["-c", "rerere.enabled=false"];

const READ_ONLY_GIT_COMMANDS: [&str; 15] = [
  "--version",
  "cat-file",
  "cherry",
  "diff",
  "for-each-ref",
  "log",
  "ls-files",
  "ls-tree",
  "merge-base",
  "rev-list",
  "rev-parse",
  "show",
  "show-ref",
  "status",
  "symbolic-ref",
];

/// `gitCommandName(args)`: the subcommand after any `-c <value>` pairs.
pub fn command_name(args: &[String]) -> String {
  let mut index = 0;
  while args.get(index).map(String::as_str) == Some("-c") {
    index += 2;
  }
  args.get(index).cloned().unwrap_or_else(|| "unknown".into())
}

/// `gitCommandMutates(args)`: whether an invocation can change repository
/// state. A read-only command may run only through the engine seam.
pub fn mutates(args: &[String]) -> bool {
  let command = command_name(args);
  let has = |names: &[&str]| args.iter().any(|item| names.contains(&item.as_str()));
  if READ_ONLY_GIT_COMMANDS.contains(&command.as_str()) {
    // `symbolic-ref <name> <ref>` writes; causet only ever reads one name.
    return command == "symbolic-ref"
      && args.iter().filter(|item| !item.starts_with('-')).count() > 2;
  }
  match command.as_str() {
    "notes" => !has(&["list", "show"]),
    "worktree" => !has(&["list"]),
    "branch" => !has(&["--show-current", "--list"]),
    "hash-object" => has(&["-w"]),
    _ => true,
  }
}

/// The options of `runGit`.
#[derive(Clone, Debug)]
pub struct RunOptions {
  pub cwd: String,
  pub env: Vec<(String, String)>,
  pub input: Option<Vec<u8>>,
  pub allow_failure: bool,
  pub trim: bool,
  pub binary: bool,
  pub max_buffer: usize,
  /// The doctor's deliberate process-cost probes, the one sanctioned read
  /// outside the seam.
  pub raw_probe: bool,
  pub(crate) engine_read: bool,
}

impl RunOptions {
  pub fn new(cwd: &str) -> Self {
    Self {
      cwd: cwd.to_string(),
      env: Vec::new(),
      input: None,
      allow_failure: false,
      trim: true,
      binary: false,
      max_buffer: DEFAULT_MAX_BUFFER,
      raw_probe: false,
      engine_read: false,
    }
  }

  pub fn allow_failure(mut self) -> Self {
    self.allow_failure = true;
    self
  }

  pub fn untrimmed(mut self) -> Self {
    self.trim = false;
    self
  }

  pub fn binary(mut self) -> Self {
    self.binary = true;
    self.trim = false;
    self
  }

  pub fn input(mut self, input: impl Into<Vec<u8>>) -> Self {
    self.input = Some(input.into());
    self
  }

  pub fn env(mut self, name: &str, value: &str) -> Self {
    self.env.push((name.to_string(), value.to_string()));
    self
  }
}

/// What `runGit` returns. `stdout` is the decoded (and, unless untrimmed,
/// trimmed) text; a binary invocation leaves it empty and fills `bytes`.
#[derive(Clone, Debug)]
pub struct GitOutput {
  pub ok: bool,
  pub status: i32,
  pub stdout: String,
  pub bytes: Vec<u8>,
  pub stderr: String,
  pub output: String,
  pub duration_ms: f64,
}

fn errno(error: &std::io::Error) -> &'static str {
  match error.kind() {
    std::io::ErrorKind::NotFound => "ENOENT",
    std::io::ErrorKind::PermissionDenied => "EACCES",
    _ => "EIO",
  }
}

/// `runGit(args, options)`.
pub fn run_git(args: &[String], options: &RunOptions) -> GitResult<GitOutput> {
  let command = command_name(args);
  let mutating = mutates(args);
  if !mutating && !options.engine_read && !options.raw_probe {
    // A read that did not come through the engine seam.
    metrics::record_direct_read(&command);
    if crate::engine::read_engine()? == crate::engine::ReadEngine::Native {
      return Err(GitError::new(
        "internal-invariant",
        format!(
          "git {command} was read outside the engine seam; every Git read must be an operation of src/engine.js."
        ),
      ));
    }
  }

  let started = Instant::now();
  metrics::diagnostic(
    "git-spawn-start",
    vec![
      ("cwd", string(&options.cwd)),
      ("args", strings(args)),
      ("command", string(&command)),
    ],
  );
  let spawned = Command::new("git")
    .args(args)
    .current_dir(&options.cwd)
    .env("GIT_TERMINAL_PROMPT", "0")
    .envs(options.env.iter().map(|(name, value)| (name, value)))
    .stdin(if options.input.is_some() {
      Stdio::piped()
    } else {
      Stdio::null()
    })
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .spawn();
  let mut child = match spawned {
    Ok(child) => child,
    Err(error) => {
      return Err(GitError::new(
        "git-unavailable",
        format!("Could not run git: spawnSync git {}", errno(&error)),
      ));
    }
  };
  // Input, output and errors move concurrently, so neither side can fill a
  // pipe the other is not draining.
  let writer = child.stdin.take().map(|mut stdin| {
    let input = options.input.clone().unwrap_or_default();
    std::thread::spawn(move || {
      let _ = stdin.write_all(&input);
    })
  });
  let mut stderr_pipe = child.stderr.take().expect("piped stderr");
  let errors = std::thread::spawn(move || {
    let mut buffer = Vec::new();
    let _ = stderr_pipe.read_to_end(&mut buffer);
    buffer
  });
  let mut stdout_bytes = Vec::new();
  if let Some(mut stdout) = child.stdout.take() {
    let _ = stdout.read_to_end(&mut stdout_bytes);
  }
  let stderr_bytes = errors.join().unwrap_or_default();
  if let Some(writer) = writer {
    let _ = writer.join();
  }
  let status = child.wait().map_err(|error| {
    GitError::new(
      "git-unavailable",
      format!("Could not run git: spawnSync git {}", errno(&error)),
    )
  })?;
  if stdout_bytes.len() > options.max_buffer || stderr_bytes.len() > options.max_buffer {
    return Err(GitError::new(
      "git-unavailable",
      "Could not run git: spawnSync git ENOBUFS",
    ));
  }
  let duration_ms = started.elapsed().as_secs_f64() * 1000.0;
  let code = status.code();
  metrics::diagnostic(
    "git-spawn-end",
    vec![
      ("cwd", string(&options.cwd)),
      ("args", strings(args)),
      ("command", string(&command)),
      (
        "status",
        code.map_or(Value::Null, |code| Value::Number(f64::from(code))),
      ),
      ("error", Value::Null),
      ("durationMs", Value::Number(three_places(duration_ms))),
    ],
  );
  let stderr_text = String::from_utf8_lossy(&stderr_bytes);
  let stderr = text::trim(&stderr_text).to_string();
  let (stdout, bytes) = if options.binary {
    (String::new(), stdout_bytes)
  } else {
    let decoded = String::from_utf8_lossy(&stdout_bytes).into_owned();
    let decoded = if options.trim {
      text::trim(&decoded).to_string()
    } else {
      decoded
    };
    (decoded, Vec::new())
  };
  let output = if options.binary {
    stderr.clone()
  } else {
    [stdout.as_str(), stderr.as_str()]
      .into_iter()
      .filter(|part| !part.is_empty())
      .collect::<Vec<_>>()
      .join("\n")
  };
  let ok = code == Some(0);
  let item = Item {
    command: command.clone(),
    duration_ms,
    ok,
    transport: "spawn",
    process_started: true,
    cache_hit: false,
  };
  metrics::record(item.clone());
  metrics::trace(&item);
  if ok && mutating {
    crate::session::invalidate(&options.cwd);
  }
  if !ok && !options.allow_failure {
    return Err(
      GitError::new(
        "git-command-failed",
        format!("git {} failed", args.join(" ")),
      )
      .details(output)
      .exit_code(code.filter(|code| *code != 0).unwrap_or(1)),
    );
  }
  Ok(GitOutput {
    ok,
    status: code.unwrap_or(1),
    stdout,
    bytes,
    stderr,
    output,
    duration_ms,
  })
}

/// `gitText(args, options)`: a mutating command's trimmed standard output.
pub fn git_text(args: &[String], options: &RunOptions) -> GitResult<String> {
  Ok(run_git(args, options)?.stdout)
}

/// A read of the Git engine: the one mark that lets `run_git` tell a seam
/// read from a read that bypassed it.
pub(crate) fn read_git(args: &[&str], options: RunOptions) -> GitResult<GitOutput> {
  let args: Vec<String> = args.iter().map(|item| item.to_string()).collect();
  run_git(
    &args,
    &RunOptions {
      engine_read: true,
      ..options
    },
  )
}

pub(crate) fn read_text(args: &[&str], cwd: &str) -> GitResult<String> {
  Ok(read_git(args, RunOptions::new(cwd))?.stdout)
}

fn strings(items: &[String]) -> Value {
  Value::Array(items.iter().map(|item| string(item)).collect())
}

fn three_places(value: f64) -> f64 {
  format!("{value:.3}").parse().unwrap_or(value)
}

#[cfg(test)]
mod tests {
  use super::*;

  fn args(items: &[&str]) -> Vec<String> {
    items.iter().map(|item| item.to_string()).collect()
  }

  #[test]
  fn mutation_detection_follows_the_javascript_rules() {
    assert!(!mutates(&args(&["rev-parse", "HEAD"])));
    assert!(!mutates(&args(&["-c", "x=y", "log"])));
    assert!(mutates(&args(&["symbolic-ref", "HEAD", "refs/heads/x"])));
    assert!(!mutates(&args(&["symbolic-ref", "--quiet", "HEAD"])));
    assert!(!mutates(&args(&["notes", "--ref=x", "list"])));
    assert!(mutates(&args(&["notes", "--ref=x", "add"])));
    assert!(!mutates(&args(&["worktree", "list"])));
    assert!(!mutates(&args(&["branch", "--show-current"])));
    assert!(mutates(&args(&["hash-object", "-w", "x"])));
    assert!(!mutates(&args(&["hash-object", "x"])));
    assert!(mutates(&args(&["commit", "-m", "x"])));
    assert_eq!(command_name(&args(&["-c", "a=b", "-c", "c=d"])), "unknown");
  }
}
