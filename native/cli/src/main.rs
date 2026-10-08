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
mod rebase_forecast;
mod rebase_program;
mod reconcile;
mod records;
mod resolve;
mod retain;
mod spec;
mod store;
mod target_overlay;
mod workspaces;

use front::Outcome;
use std::{env, ffi::OsString, io::Write, process};

const HELP: &str = include_str!(concat!(env!("OUT_DIR"), "/help.txt"));
const VERSION: &str = include_str!(concat!(env!("OUT_DIR"), "/version.txt"));

/// Chooses between the native answer and the JavaScript CLI: `always`
/// delegates every invocation, so a ported command can be compared with the
/// oracle; `never` refuses to delegate, so a test can prove what is native.
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
    Outcome::Delegate { command } => {
      if delegation == Delegation::Never {
        exit_with(&format!(
          "cst: '{command}' is not ported to the Rust CLI yet, and {DELEGATE_VARIABLE}=never forbids delegating it.\n"
        ));
      }
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

/// The front end sees what the JavaScript CLI would see. Arguments or
/// selector variables that are not valid Unicode reach Node with replacement
/// characters, which `front` does not model, so those invocations delegate.
fn decide(raw: &[OsString]) -> Outcome {
  let Some(args) = raw
    .iter()
    .map(|item| item.clone().into_string().ok())
    .collect::<Option<Vec<_>>>()
  else {
    return Outcome::Delegate {
      command: String::new(),
    };
  };
  let names = ["FORECAST_ENGINE", "ENGINE"];
  if names.iter().any(|name| environment::value(name).is_err()) {
    return Outcome::Delegate {
      command: String::new(),
    };
  }
  front::decide(&args, &|name| environment::value(name).ok().flatten(), HELP)
}

fn exit_with(message: &str) -> ! {
  let _ = std::io::stderr().write_all(message.as_bytes());
  process::exit(1);
}
