//! The command front end: everything `main` in `src/cli.js` decides before a
//! command touches the repository. It reproduces the JavaScript CLI's global
//! flags, environment checks, help, version, generic option parsing, and each
//! command's argument-only usage checks, in the same order, so those outcomes
//! can be answered natively byte for byte. Whatever needs the repository is
//! `Delegate`, and so is any input whose JavaScript behavior this module does
//! not model exactly: when in doubt, the oracle answers.

use crate::parsed::{Opt, Parsed};

pub const READ_ENGINES: [&str; 2] = ["git", "native"];
pub const FORECAST_ENGINES: [&str; 2] = ["worktree", "merge-tree"];

/// A `CliError` as `src/errors.js` defines it. `details` is always empty and
/// `exitCode` always 1 for the failures the front end raises.
#[derive(Debug, PartialEq, Eq)]
pub struct Failure {
  pub message: String,
  pub code: &'static str,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
  Help,
  Version,
  /// `json` is whether `--json` was in scope when the failure was raised
  /// (ADR-0021): failures before command dispatch are always prose.
  Fail {
    failure: Failure,
    json: bool,
  },
  /// The command needs the JavaScript CLI; `command` names it for diagnostics.
  Delegate {
    command: String,
  },
  /// A ported command, answered by this CLI. `settings` are the variables its
  /// global flags select, as `setEnvironmentValue` would.
  Native {
    command: String,
    parsed: Parsed,
    settings: Vec<(&'static str, String)>,
  },
}

/// The commands this CLI answers natively. A command joins only when every
/// CLI-level test that exercises it passes against this CLI in all six modes
/// (ADR-0037 §4).
pub const NATIVE_COMMANDS: &[&str] = &[
  "audit identity",
  "branch",
  "capabilities",
  "cherry-pick",
  "commit",
  "compact-merge",
  "doctor",
  "forecast",
  "graph",
  "hard-squash",
  "init",
  "merge",
  "merge-plan",
  "metadata dispose",
  "metadata export",
  "metadata import",
  "metadata retain",
  "metadata status",
  "metadata validate",
  "proof-bundle",
  "provenance",
  "rebase-plan",
  "receipts",
  "reconcile",
  "resolve apply",
  "resolve list",
  "resolve reject",
  "resolve status",
  "spec index",
  "spec merge-plan",
  "spec resolve",
  "spec show",
  "spec status",
  "verify-proof",
  "workspace archive",
  "workspace checkpoint",
  "workspace create",
  "workspace forecast",
  "workspace list",
  "workspace move",
  "workspace prune",
  "workspace repair",
  "workspace restore",
];

/// Whether this invocation is a ported command: the command, or for a command
/// with subcommands, the command and its subcommand.
fn is_native(command: &str, parsed: &Parsed) -> bool {
  // `cst resolve` alone is `cst resolve status` (`positionals[0] ?? "status"`).
  let default = (command == "resolve").then_some("status");
  NATIVE_COMMANDS.contains(&command)
    || parsed
      .positionals
      .first()
      .map(String::as_str)
      .or(default)
      .is_some_and(|subcommand| {
        NATIVE_COMMANDS.contains(&format!("{command} {subcommand}").as_str())
      })
}

fn fail(message: impl Into<String>, code: &'static str, json: bool) -> Outcome {
  Outcome::Fail {
    failure: Failure {
      message: message.into(),
      code,
    },
    json,
  }
}

/// Decide an invocation. `env` looks up a user-facing environment variable by
/// the name after its prefix, the way the JavaScript CLI sees it (`CAUSET_`,
/// then `VLAB_`); `None` means unset.
pub fn decide(raw: &[String], env: &dyn Fn(&str) -> Option<String>, help: &str) -> Outcome {
  let has = |flag: &str| raw.iter().any(|item| item == flag);
  if has("--git-session") && has("--no-git-session") {
    return fail(
      "Choose only one of --git-session or --no-git-session.",
      "usage-conflicting-options",
      false,
    );
  }
  // Each selector: its flag, its accepted values, and the label its
  // environment variable's error uses. A flag replaces the variable's value.
  let selectors = [
    ("--forecast-engine", &FORECAST_ENGINES, "forecast engine"),
    ("--engine", &READ_ENGINES, "engine"),
  ];
  let mut selections = [env("FORECAST_ENGINE"), env("ENGINE")];
  let mut settings: Vec<(&'static str, String)> = Vec::new();
  if has("--trace-git") {
    settings.push(("TRACE", "1".into()));
  }
  if has("--git-session") {
    settings.push(("GIT_SESSION", "1".into()));
  }
  if has("--no-git-session") {
    settings.push(("GIT_SESSION", "0".into()));
  }
  let names = ["FORECAST_ENGINE", "ENGINE"];
  let mut args: Vec<&str> = Vec::new();
  let mut index = 0;
  while index < raw.len() {
    let item = raw[index].as_str();
    index += 1;
    if matches!(item, "--trace-git" | "--git-session" | "--no-git-session") {
      continue;
    }
    let selector = selectors
      .iter()
      .position(|(flag, ..)| item == *flag || item.starts_with(&format!("{flag}=")));
    let Some(slot) = selector else {
      args.push(item);
      continue;
    };
    let (flag, allowed, _) = selectors[slot];
    let value = if item.contains('=') {
      Some(&item[flag.len() + 1..])
    } else {
      index += 1;
      raw.get(index - 1).map(String::as_str)
    };
    match value {
      Some(value) if allowed.contains(&value) => {
        selections[slot] = Some(value.to_string());
        settings.push((names[slot], value.to_string()));
      }
      _ => {
        return fail(
          format!("{flag} requires one of: {}.", allowed.join(", ")),
          "usage-invalid-option-value",
          false,
        );
      }
    }
  }
  // The environment selections are validated on every command, as the flags are.
  for ((_, allowed, label), selection) in selectors.iter().zip(&selections) {
    if let Some(value) = selection.as_deref().filter(|value| !value.is_empty()) {
      if !allowed.contains(&value) {
        return fail(
          format!(
            "Unknown {label} '{value}'. Use one of: {}.",
            allowed.join(", ")
          ),
          "usage-invalid-option-value",
          false,
        );
      }
    }
  }

  let command = args.first().copied().unwrap_or("");
  if matches!(command, "" | "help" | "--help" | "-h") {
    return Outcome::Help;
  }
  if matches!(command, "version" | "--version" | "-V") {
    return Outcome::Version;
  }
  let parsed = match parse_args(&args[1..]) {
    Ok(Some(parsed)) => parsed,
    Ok(None) => {
      return Outcome::Delegate {
        command: command.to_string(),
      };
    }
    Err(failure) => {
      return Outcome::Fail {
        failure,
        json: false,
      };
    }
  };
  let json = parsed.truthy("json");
  match usage_check(command, &parsed, help) {
    Some(failure) => Outcome::Fail { failure, json },
    None if is_native(command, &parsed) => Outcome::Native {
      command: command.to_string(),
      parsed,
      settings,
    },
    None => Outcome::Delegate {
      command: command.to_string(),
    },
  }
}

const REPEATABLE_FLAGS: &[&str] = &[
  "--authored-by",
  "--generated-by",
  "--reviewed-by",
  "--reword",
  "--edit",
  "--squash",
  "--fixup",
];

const VALUE_FLAGS: &[&str] = &[
  "--message",
  "-m",
  "--from",
  "--path",
  "--owner",
  "--focus",
  "--cone",
  "--against",
  "--anchors-from",
  "--label",
  "--reason",
  "--resolution",
  "--use-forecast",
  "--samples",
  "--warmup",
  "--documents",
  "--blocks",
  "--history",
  "--workspaces",
  "--notes",
  "--resolutions",
  "--budget-ms",
  "--areas",
  "--files-per-area",
];

/// `item.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())`.
fn option_key(item: &str) -> String {
  let mut key = String::new();
  let mut chars = item[2..].chars().peekable();
  while let Some(c) = chars.next() {
    match chars.peek() {
      Some(next) if c == '-' && next.is_ascii_lowercase() => {
        key.push(next.to_ascii_uppercase());
        chars.next();
      }
      _ => key.push(c),
    }
  }
  key
}

/// `parseArgs` in `src/cli.js`. `Ok(None)` means the JavaScript CLI would not
/// behave as modeled here (a repeatable flag spreading a non-array value
/// throws a `TypeError`), so the caller delegates.
fn parse_args(args: &[&str]) -> Result<Option<Parsed>, Failure> {
  let mut parsed = Parsed::default();
  let mut index = 0;
  while index < args.len() {
    let item = args[index];
    let repeatable = REPEATABLE_FLAGS.contains(&item);
    if repeatable || VALUE_FLAGS.contains(&item) {
      let Some(value) = args.get(index + 1) else {
        return Err(Failure {
          message: format!("{item} requires a value."),
          code: "usage-missing-argument",
        });
      };
      let key = if item == "-m" {
        "message".to_string()
      } else {
        option_key(item)
      };
      if repeatable {
        match parsed.options.get_mut(&key) {
          None => {
            parsed
              .options
              .insert(key, Opt::Values(vec![value.to_string()]));
          }
          Some(Opt::Values(values)) => values.push(value.to_string()),
          Some(_) => return Ok(None),
        }
      } else {
        parsed.options.insert(key, Opt::Value(value.to_string()));
      }
      index += 2;
    } else if item.starts_with("--") {
      parsed.options.insert(option_key(item), Opt::Flag);
      index += 1;
    } else {
      parsed.positionals.push(item.to_string());
      index += 1;
    }
  }
  Ok(Some(parsed))
}

fn missing(usage: &str) -> Failure {
  Failure {
    message: format!("Missing required argument. Usage: {usage}"),
    code: "usage-missing-argument",
  }
}

fn failure(message: &str, code: &'static str) -> Failure {
  Failure {
    message: message.to_string(),
    code,
  }
}

/// Each command's checks that `src/cli.js` makes from its arguments alone,
/// before any repository access, in its order. `None` delegates.
fn usage_check(command: &str, parsed: &Parsed, help: &str) -> Option<Failure> {
  let require = |present: bool, usage: &str| (!present).then(|| missing(usage));
  let p = |index| parsed.positional(index);
  let positional = |index: usize| parsed.positionals.get(index).map(String::as_str);
  let conflicting_action = || {
    let actions = ["status", "continue", "abort"]
      .iter()
      .filter(|key| parsed.truthy(key))
      .count();
    (actions > 1).then(|| {
      failure(
        "Choose only one of --status, --continue, or --abort.",
        "usage-conflicting-options",
      )
    })
  };
  let any_action = || {
    ["status", "continue", "abort"]
      .iter()
      .any(|key| parsed.truthy(key))
  };
  match command {
    "init" | "graph" | "provenance" | "receipts" | "capabilities" | "doctor" | "migrate" => None,
    "commit" => require(parsed.truthy("message"), "cst commit -m <message>"),
    "branch" => require(p(0), "cst branch <name> [from]"),
    "merge" | "compact-merge" | "hard-squash" => require(p(0), &format!("cst {command} <source>")),
    "proof-bundle" => require(p(0), "cst proof-bundle <source>"),
    "verify-proof" => require(p(0), "cst verify-proof <file>"),
    "merge-plan" => require(p(0), "cst merge-plan <source>"),
    "rebase-plan" | "rebase-forecast" => require(p(0), &format!("cst {command} <onto> [<source>]"))
      .or_else(|| {
        (parsed.positionals.len() > 2).then(|| Failure {
          message: format!("Usage: cst {command} <onto> [<source>]"),
          code: "usage-missing-argument",
        })
      }),
    "rebase" => conflicting_action().or_else(|| {
      if any_action() {
        return None;
      }
      require(p(0), "cst rebase <onto>").or_else(|| {
        (parsed.positionals.len() > 1)
          .then(|| failure("Usage: cst rebase <onto>", "usage-missing-argument"))
      })
    }),
    "forecast" => require(p(0), "cst forecast <source>"),
    "reconcile" => conflicting_action().or_else(|| {
      if any_action() {
        None
      } else {
        require(p(0), "cst reconcile <source>")
      }
    }),
    "resolve" => match positional(0).unwrap_or("status") {
      "status" | "apply" | "reject" | "list" => None,
      _ => Some(failure(
        "Unknown resolve command. Use status, apply, reject, or list.",
        "usage-unknown-command",
      )),
    },
    "cherry-pick" => require(p(0), "cst cherry-pick <commit-or-change-id>"),
    "audit" => (positional(0) != Some("identity")).then(|| {
      failure(
        "Unknown audit command. Use identity.",
        "usage-unknown-command",
      )
    }),
    "metadata" => match positional(0) {
      Some("retain" | "status" | "validate" | "benchmark") => None,
      Some("export") => require(p(1), "cst metadata export <directory>"),
      Some("import") => require(p(1), "cst metadata import <directory> --dry-run|--apply"),
      Some("dispose") => require(
        p(1),
        "cst metadata dispose <record-id> --keep-local|--replace-local",
      )
      .or_else(|| {
        (parsed.truthy("keepLocal") == parsed.truthy("replaceLocal")).then(|| {
          failure(
            "Choose exactly one of --keep-local or --replace-local for a disposition.",
            "usage-conflicting-options",
          )
        })
      }),
      _ => Some(failure(
        "Unknown metadata command. Use status, validate, retain, export, import, dispose, or benchmark.",
        "usage-unknown-command",
      )),
    },
    "workspace" => match positional(0) {
      Some("list" | "checkpoint" | "prune") => None,
      Some("create") => require(p(1), "cst workspace create <name>"),
      Some("move") => require(p(1), "cst workspace move <name> <directory>")
        .or_else(|| require(p(2), "cst workspace move <name> <directory>")),
      Some("archive") => require(p(1), "cst workspace archive <name>"),
      Some("restore") => require(p(1), "cst workspace restore <name>"),
      Some("repair") => {
        require(p(1), "cst workspace repair <name> --path <directory>").or_else(|| {
          require(
            parsed.truthy("path"),
            "cst workspace repair <name> --path <directory>",
          )
        })
      }
      Some("forecast") => require(p(1), "cst workspace forecast <target> <source>")
        .or_else(|| require(p(2), "cst workspace forecast <target> <source>")),
      _ => Some(failure(
        "Unknown workspace command. Use create, list, checkpoint, move, archive, restore, repair, prune, or forecast.",
        "usage-unknown-command",
      )),
    },
    "spec" => match positional(0) {
      Some("status" | "resolve" | "benchmark") => None,
      Some("index") if parsed.truthy("all") => None,
      Some("index") => require(p(1), "cst spec index <file>"),
      Some("show") => require(p(1), "cst spec show <file>"),
      Some("merge-plan") => {
        let usage = "cst spec merge-plan <file> <base> <ours> <theirs>";
        (1..=4).find_map(|index| require(p(index), usage))
      }
      _ => Some(failure(
        "Unknown spec command. Use index, show, merge-plan, status, resolve, or benchmark.",
        "usage-unknown-command",
      )),
    },
    _ => Some(Failure {
      message: format!("Unknown command '{command}'.\n\n{help}"),
      code: "usage-unknown-command",
    }),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn run(args: &[&str]) -> Outcome {
    run_with(args, &[])
  }

  fn run_with(args: &[&str], env: &[(&str, &str)]) -> Outcome {
    let raw: Vec<String> = args.iter().map(|item| item.to_string()).collect();
    let lookup = |name: &str| {
      env
        .iter()
        .find(|(key, _)| *key == name)
        .map(|(_, value)| value.to_string())
    };
    decide(&raw, &lookup, "HELP")
  }

  fn failed(outcome: Outcome) -> (String, &'static str, bool) {
    match outcome {
      Outcome::Fail { failure, json } => (failure.message, failure.code, json),
      other => panic!("expected a failure, got {other:?}"),
    }
  }

  fn delegated(outcome: Outcome) -> bool {
    matches!(outcome, Outcome::Delegate { .. })
  }

  #[test]
  fn help_and_version_spellings() {
    for args in [
      &[][..],
      &[""],
      &["help"],
      &["--help"],
      &["-h"],
      &["--trace-git"],
      &["--engine=git", "help"],
    ] {
      assert_eq!(run(args), Outcome::Help, "{args:?}");
    }
    for args in [
      &["version"][..],
      &["--version"],
      &["-V"],
      &["--no-git-session", "version", "--json"],
    ] {
      assert_eq!(run(args), Outcome::Version, "{args:?}");
    }
  }

  #[test]
  fn global_flags_fail_as_prose_in_order() {
    let (message, code, json) = failed(run(&[
      "--git-session",
      "--no-git-session",
      "--engine=bogus",
    ]));
    assert_eq!(
      message,
      "Choose only one of --git-session or --no-git-session."
    );
    assert_eq!((code, json), ("usage-conflicting-options", false));
    let (message, _, json) = failed(run(&["--engine", "bogus", "commit", "--json"]));
    assert_eq!(message, "--engine requires one of: git, native.");
    assert!(!json);
    let (message, _, _) = failed(run(&["--forecast-engine"]));
    assert_eq!(
      message,
      "--forecast-engine requires one of: worktree, merge-tree."
    );
    let (message, _, _) = failed(run(&["--engine="]));
    assert_eq!(message, "--engine requires one of: git, native.");
  }

  #[test]
  fn a_flag_value_is_consumed_even_when_it_looks_like_a_flag() {
    let (message, _, _) = failed(run(&["--engine", "--trace-git"]));
    assert_eq!(message, "--engine requires one of: git, native.");
    assert_eq!(run(&["--engine", "native", "--help"]), Outcome::Help);
  }

  #[test]
  fn environment_selections_are_validated_after_the_flags() {
    let (message, code, _) = failed(run_with(
      &["version"],
      &[("FORECAST_ENGINE", "x"), ("ENGINE", "y")],
    ));
    assert_eq!(
      message,
      "Unknown forecast engine 'x'. Use one of: worktree, merge-tree."
    );
    assert_eq!(code, "usage-invalid-option-value");
    let (message, _, _) = failed(run_with(&["version"], &[("ENGINE", "y")]));
    assert_eq!(message, "Unknown engine 'y'. Use one of: git, native.");
    assert_eq!(
      run_with(&["--engine=git", "version"], &[("ENGINE", "y")]),
      Outcome::Version
    );
    assert_eq!(run_with(&["version"], &[("ENGINE", "")]), Outcome::Version);
  }

  #[test]
  fn a_missing_flag_value_is_prose_even_with_json() {
    let (message, code, json) = failed(run(&["commit", "--json", "-m"]));
    assert_eq!(message, "-m requires a value.");
    assert_eq!((code, json), ("usage-missing-argument", false));
    let (message, _, _) = failed(run(&["no-such-command", "--reviewed-by"]));
    assert_eq!(message, "--reviewed-by requires a value.");
  }

  #[test]
  fn an_unknown_command_honours_json() {
    let (message, code, json) = failed(run(&["no-such-command", "--json"]));
    assert_eq!(message, "Unknown command 'no-such-command'.\n\nHELP");
    assert_eq!((code, json), ("usage-unknown-command", true));
    let (_, _, json) = failed(run(&["--json"]));
    assert!(!json, "--json as the command is not an option");
    let (_, _, json) = failed(run(&["x", "-m", "--json"]));
    assert!(!json, "a consumed value is not an option");
  }

  #[test]
  fn command_usage_checks() {
    let cases: &[(&[&str], &str)] = &[
      (
        &["commit"],
        "Missing required argument. Usage: cst commit -m <message>",
      ),
      (
        &["commit", "-m", ""],
        "Missing required argument. Usage: cst commit -m <message>",
      ),
      (
        &["hard-squash"],
        "Missing required argument. Usage: cst hard-squash <source>",
      ),
      (
        &["rebase-plan", "a", "b", "c"],
        "Usage: cst rebase-plan <onto> [<source>]",
      ),
      (
        &["rebase", "--status", "--abort"],
        "Choose only one of --status, --continue, or --abort.",
      ),
      (&["rebase", "a", "b"], "Usage: cst rebase <onto>"),
      (
        &["resolve", ""],
        "Unknown resolve command. Use status, apply, reject, or list.",
      ),
      (&["audit"], "Unknown audit command. Use identity."),
      (
        &["metadata", "dispose", "r"],
        "Choose exactly one of --keep-local or --replace-local for a disposition.",
      ),
      (
        &["workspace", "repair", "w", "--path", ""],
        "Missing required argument. Usage: cst workspace repair <name> --path <directory>",
      ),
      (
        &["spec", "merge-plan", "f", "b", "o"],
        "Missing required argument. Usage: cst spec merge-plan <file> <base> <ours> <theirs>",
      ),
      (
        &["spec"],
        "Unknown spec command. Use index, show, merge-plan, status, resolve, or benchmark.",
      ),
    ];
    for (args, expected) in cases {
      let (message, _, _) = failed(run(args));
      assert_eq!(&message, expected, "{args:?}");
    }
  }

  #[test]
  fn commands_that_need_the_repository_delegate() {
    for args in [
      &["rebase", "--status", "extra", "args"][..],
      &["spec", "benchmark", "--documents", "2"],
      &["commit", "--authoredBy", "--authored-by", "a"],
    ] {
      assert!(delegated(run(args)), "{args:?}");
    }
  }

  #[test]
  fn ported_commands_are_answered_natively_with_their_flag_selections() {
    for args in [
      &["doctor", "--benchmark"][..],
      &["init", "--json"],
      &["metadata", "retain", "--apply"],
      &["metadata", "export", "x"],
      &["metadata", "import", "x", "--apply", "--park-conflicts"],
      &["metadata", "dispose", "r", "--replace-local", "--reason", "peer is right"],
      &["commit", "-m", "x", "--generated-by", "agent", "--all"],
      &["branch", "feature", "main"],
      &["merge", "feature", "--compact", "-m", "Land it"],
      &["merge", "feature", "--hard-squash"],
      &["compact-merge", "feature", "--json"],
      &["hard-squash", "feature"],
      &["cherry-pick", "ch_abc", "--fork", "--json"],
      &["cherry-pick", "HEAD~1", "--repeat"],
      &["capabilities", "--json"],
      &["metadata", "status"],
      &["metadata", "validate", "--strict"],
      &["resolve"],
      &["resolve", "list", "--json"],
      &["forecast", "feature", "--target-checkpoint", "--accept-candidates"],
      &["resolve", "apply", "--all"],
      &["resolve", "reject", "f", "--resolution", "res_x", "--json"],
      &["spec", "show", "a.md"],
      &["spec", "status"],
      &["spec", "merge-plan", "f", "b", "o", "t", "--json"],
      &["spec", "index", "f", "--force"],
      &["spec", "index", "--all", "--json"],
      &["spec", "resolve", "specs/a.md", "--all"],
      &["merge-plan", "feature", "--json"],
      &["rebase-plan", "main", "feature", "--from", "base", "--squash", "a=b"],
      &["proof-bundle", "feature"],
      &["verify-proof", "bundle.json", "--offline", "--anchors-from", "origin"],
      &["workspace", "list"],
      &["workspace", "checkpoint", "--label", "x", "--json"],
      &["workspace", "prune", "--apply"],
      &["workspace", "create", "w", "--cone", "src", "--from", "main"],
      &["workspace", "move", "w", "d"],
      &["workspace", "archive", "w"],
      &["workspace", "restore", "w", "--path", "p"],
      &["workspace", "repair", "w", "--path", "p"],
      &["workspace", "forecast", "a", "b", "--source-checkpoint"],
      &["reconcile", "feature", "--accept-candidates", "--use-forecast", "forecast_x"],
      &["reconcile", "--status", "--json"],
      &["reconcile", "--abort"],
      &["reconcile", "feature", "--fork"],
      &["reconcile", "--continue"],
      &["reconcile", "--continue", "--fork", "--json"],
    ] {
      assert!(matches!(run(args), Outcome::Native { .. }), "{args:?}");
    }
    // A command is native per subcommand: these still delegate.
    for args in [
      &["rebase", "--continue"][..],
      &["spec", "benchmark"],
      &["rebase-forecast", "main"],
    ] {
      assert!(delegated(run(args)), "{args:?}");
    }
    let Outcome::Native {
      settings, parsed, ..
    } = run(&[
      "--trace-git",
      "--no-git-session",
      "--engine",
      "native",
      "doctor",
      "--differential",
    ])
    else {
      panic!("doctor is native");
    };
    assert!(parsed.truthy("differential"));
    assert_eq!(
      settings,
      [
        ("TRACE", "1".to_string()),
        ("GIT_SESSION", "0".to_string()),
        ("ENGINE", "native".to_string())
      ]
    );
  }

  #[test]
  fn option_keys_are_camel_cased_like_the_javascript_regex() {
    assert_eq!(option_key("--allow-empty"), "allowEmpty");
    assert_eq!(option_key("--a--b"), "a-B");
    assert_eq!(option_key("--files-per-area"), "filesPerArea");
    assert_eq!(option_key("--X-Y"), "X-Y");
  }
}
