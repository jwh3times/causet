//! `cst`, the Rust command-line interface (ADR-0037). `front` decides each
//! invocation byte for byte as the JavaScript CLI did, and `native` runs it;
//! a command `cst` does not define is Git's, and runs `git` (ADR-0040).
#![forbid(unsafe_code)]

mod audit;
mod capabilities;
mod cherry_pick;
mod commit;
mod dispose;
mod doctor;
mod envelope;
mod environment;
mod export;
mod forecast;
mod front;
mod host;
mod import;
mod json;
mod landing;
mod lineage;
mod metadata;
mod migration;
mod native;
mod notes;
mod notes_write;
mod parsed;
mod plan;
mod proof;
mod provenance;
mod rebase;
mod rebase_forecast;
mod rebase_program;
mod reconcile;
mod records;
mod resolve;
mod retain;
mod scale_benchmark;
mod spec;
mod store;
mod sync;
mod target_overlay;
mod workspaces;

use front::Outcome;
use std::{env, ffi::OsString, io::Write, process};

const HELP: &str = include_str!("help.txt");
const VERSION: &str = include_str!(concat!(env!("OUT_DIR"), "/version.txt"));

fn main() {
  let raw: Vec<OsString> = env::args_os().skip(1).collect();
  let words: Vec<String> = raw.iter().map(|item| item.to_string_lossy().into_owned()).collect();
  if let Some(skip) = front::passthrough(&words) {
    process::exit(git(&raw[skip..]));
  }
  let outcome = decide(&raw);
  let mut stdout = std::io::stdout().lock();
  let mut stderr = std::io::stderr().lock();
  // Output errors are ignored, as Node ignores them on a closed stream.
  let code = match outcome {
    Outcome::Native {
      command,
      parsed,
      settings,
    } => {
      drop(stdout);
      drop(stderr);
      native::run(&command, &parsed, &settings)
    }
    Outcome::Sync {
      command,
      args,
      json,
      records,
      settings,
    } => {
      drop(stdout);
      drop(stderr);
      native::select(&settings);
      sync::run(&command, &args, json, records, &native::canonical_working_directory())
    }
    Outcome::Help => {
      let _ = writeln!(stdout, "{HELP}");
      0
    }
    Outcome::Version => {
      let _ = writeln!(stdout, "causet {VERSION}");
      0
    }
    Outcome::Fail {
      failure,
      json: true,
    } => {
      let _ = writeln!(stdout, "{}", json::envelope(&failure));
      1
    }
    Outcome::Fail {
      failure,
      json: false,
    } => {
      let _ = writeln!(stderr, "cst: {}", failure.message);
      1
    }
    Outcome::Unmigrated { json } => {
      drop(stdout);
      drop(stderr);
      native::report(&causet_engine::locations::unmigrated_error(), json)
    }
  };
  process::exit(code);
}

/// Run Git with `args` exactly as given (ADR-0040), as Git itself: on Unix
/// `cst` becomes the `git` process, so signals, the terminal, a pager, an
/// editor and the exit status are Git's with nothing between. Windows has no
/// exec; there `git` runs as a child with the standard streams inherited and
/// its status returned.
fn git(args: &[OsString]) -> i32 {
  let mut command = process::Command::new("git");
  command.args(args);
  match run_as_git(&mut command) {
    Ok(code) => code,
    Err(error) => {
      eprintln!("cst: could not run git: {error}");
      1
    }
  }
}

#[cfg(unix)]
fn run_as_git(command: &mut process::Command) -> std::io::Result<i32> {
  use std::os::unix::process::CommandExt;
  // Returns only when the exec failed.
  Err(command.exec())
}

#[cfg(not(unix))]
fn run_as_git(command: &mut process::Command) -> std::io::Result<i32> {
  Ok(command.status()?.code().unwrap_or(1))
}

/// The front end sees what the JavaScript CLI would see. Node decodes an
/// argument or a variable that is not valid Unicode with replacement
/// characters, and so does this.
fn decide(raw: &[OsString]) -> Outcome {
  let args: Vec<String> = raw
    .iter()
    .map(|item| item.to_string_lossy().into_owned())
    .collect();
  front::decide(
    &args,
    &|name| match environment::value(name) {
      Ok(value) => value,
      Err(raw) => Some(raw.to_string_lossy().into_owned()),
    },
    &|settings| {
      native::select(settings);
      // Outside a repository there is nothing to refuse; the command says so itself.
      causet_engine::locations::repository_names(&native::canonical_working_directory())
        .is_ok_and(|names| names.state == "unmigrated")
    },
    HELP,
  )
}
