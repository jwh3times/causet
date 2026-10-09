//! `cst`, the Rust command-line interface (ADR-0037). While the port is under
//! way it answers natively only what `front` models byte for byte, and
//! delegates every other invocation, whole, to the JavaScript CLI.
#![forbid(unsafe_code)]

mod audit;
mod capabilities;
mod cherry_pick;
mod commit;
mod delegate;
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
mod target_overlay;
mod workspaces;

use front::Outcome;
use std::{env, ffi::OsString, io::Write, process};

const HELP: &str = include_str!(concat!(env!("OUT_DIR"), "/help.txt"));
const VERSION: &str = include_str!(concat!(env!("OUT_DIR"), "/version.txt"));

/// `always` hands every invocation to the JavaScript CLI, the oracle a native
/// answer can be compared with (ADR-0037 §6). `auto` and `never` both answer
/// natively: every command is ported, so there is nothing left to delegate.
const DELEGATE_VARIABLE: &str = "CAUSET_DELEGATE";

#[derive(Clone, Copy, PartialEq, Eq)]
enum Delegation {
  Auto,
  Always,
  Never,
}

fn main() {
  let raw: Vec<OsString> = env::args_os().skip(1).collect();
  let delegation = match environment::value("DELEGATE")
    .as_ref()
    .map(|value| value.as_deref())
  {
    Ok(None | Some("" | "auto")) => Delegation::Auto,
    Ok(Some("always")) => Delegation::Always,
    Ok(Some("never")) => Delegation::Never,
    Ok(Some(other)) => exit_with(&format!(
      "cst: Unknown delegation mode '{other}' in {DELEGATE_VARIABLE}. Use one of: auto, always, never.\n"
    )),
    Err(_) => exit_with(&format!("cst: {DELEGATE_VARIABLE} is not valid Unicode.\n")),
  };
  let outcome = if delegation == Delegation::Always {
    Outcome::Delegate {
      command: String::new(),
    }
  } else {
    decide(&raw)
  };
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
    Outcome::Delegate { .. } => {
      let _ = stdout.flush();
      drop(stdout);
      drop(stderr);
      match delegate::entry_point().and_then(|entry| {
        delegate::run(&entry, &raw).map_err(|error| {
          format!(
            "Node.js could not be started to run {}: {error}",
            entry.display()
          )
        })
      }) {
        Ok(code) => code,
        Err(message) => exit_with(&format!("cst: {message}\n")),
      }
    }
  };
  process::exit(code);
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

fn exit_with(message: &str) -> ! {
  let _ = std::io::stderr().write_all(message.as_bytes());
  process::exit(1);
}
