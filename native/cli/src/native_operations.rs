//! The operation log in a native repository (#423; ADR-0047 decisions 10
//! and 12, docs/native-history/operations.md §3): who a write's operation
//! names as its actor, writing one with no lock, and `cst op log` and
//! `cst op show`, cst's own commands, with human output and `--json`
//! (`causet.operations/v1`, `causet.operation/v1`).
//!
//! An operation's actor is declared, never inferred, as provenance is:
//! `--actor <name>`, with `--kind human|agent` and `--for <name>`, or
//! without it `CAUSET_AGENT`, naming an agent. Its time is the clock's, at
//! offset +0000, since the local zone is not known without a dependency.

use crate::native::report;
use crate::native_inspection::{lossy, value};
use crate::native_log::wants_json;
use crate::native_repository::bytes_of;
use crate::native_revision::Repository;
use causet_engine::environment;
use causet_engine::errors::{GitError, GitResult};
use causet_history::action::{ActionActor, Time};
use causet_history::actor::Kind as ActorKind;
use causet_history::date::{DateMode, ident_date};
use causet_history::names::{Name, Target, Value as NameValue};
use causet_history::op_log;
use causet_history::operation::{Operation, View};
use causet_import::store_error;
use causet_model::json::{Object as JsonObject, Value, string, stringify_pretty};
use causet_store::id::{NativeId, Type, hex};
use std::ffi::OsString;
use std::io::Write as _;
use std::path::Path;

/// The documents `--json` prints.
const OPERATION_SCHEMA: &str = "causet.operation/v1";
const OPERATIONS_SCHEMA: &str = "causet.operations/v1";

const OP_USAGE: &str = "Usage: cst op log [-<n> | -n <n> | --max-count=<n>] [--json], or cst op show [<operation>] [--json]";

/// How many hex digits human output shows of an ID.
pub const SHOWN: usize = 12;

/// The first digits of an ID, as human output shows it.
pub fn short(id: &NativeId) -> String {
  id.hex()[..SHOWN].to_string()
}

/// The actor options a write takes, as given.
#[derive(Default)]
pub struct ActorOptions {
  actor: Option<String>,
  kind: Option<String>,
  on_behalf_of: Option<String>,
}

impl ActorOptions {
  /// Takes `arg` when it is one of the actor options, reading its value from
  /// `rest` when it is given apart; whether it was one.
  pub fn take(&mut self, arg: &[u8], rest: &mut std::slice::Iter<OsString>) -> GitResult<bool> {
    for (name, slot) in [("--actor", &mut self.actor), ("--kind", &mut self.kind), ("--for", &mut self.on_behalf_of)] {
      if arg == name.as_bytes() || arg.starts_with(format!("{name}=").as_bytes()) {
        let given = value(arg, name, rest)?.expect("the option's value");
        *slot = Some(lossy(&given));
        return Ok(true);
      }
    }
    Ok(false)
  }

  /// Whether any was given.
  pub fn given(&self) -> bool {
    self.actor.is_some() || self.kind.is_some() || self.on_behalf_of.is_some()
  }

  /// The actor an operation records: `--actor`, of `--kind` and for
  /// `--for`; or without it the agent `CAUSET_AGENT` names, for `--for`.
  /// With neither, refused: an actor is declared, never inferred.
  pub fn actor(&self, command: &str) -> GitResult<ActionActor> {
    let kind = match self.kind.as_deref() {
      None => None,
      Some("human") => Some(ActorKind::Human),
      Some("agent") => Some(ActorKind::Agent),
      Some(other) => {
        return Err(GitError::new(
          "usage-invalid-option-value",
          format!("--kind takes human or agent, not '{other}'."),
        ));
      }
    };
    let agent = environment::value("AGENT").map(|agent| agent.trim().to_string()).filter(|agent| !agent.is_empty());
    let (actor, kind) = match (&self.actor, agent) {
      (Some(actor), _) => (actor.trim().to_string(), kind),
      (None, Some(agent)) => {
        if kind.is_some() {
          return Err(GitError::new(
            "usage-conflicting-options",
            "--kind describes the actor --actor names; CAUSET_AGENT always names an agent.",
          ));
        }
        (agent, Some(ActorKind::Agent))
      }
      (None, None) => {
        return Err(
          GitError::new("usage-missing-argument", format!("cst {command} records who ran it, and no actor was declared."))
            .details(
              "Name the actor with --actor <name>, with --kind human|agent and --for <name> as they apply, or set CAUSET_AGENT; an operation's actor is declared, never inferred.",
            ),
        );
      }
    };
    if actor.is_empty() {
      return Err(GitError::new("usage-invalid-option-value", "--actor takes a name, and it is empty."));
    }
    let on_behalf_of = self.on_behalf_of.as_deref().map(str::trim).map(str::to_string);
    if on_behalf_of.as_deref() == Some("") {
      return Err(GitError::new("usage-invalid-option-value", "--for takes a name, and it is empty."));
    }
    if on_behalf_of.is_some() && kind != Some(ActorKind::Agent) {
      return Err(GitError::new(
        "usage-conflicting-options",
        "--for names who an agent acts for, so it needs --kind agent or CAUSET_AGENT.",
      ));
    }
    Ok(ActionActor { actor, kind, on_behalf_of })
  }
}

/// Now, as an operation records it: the clock's seconds at offset +0000.
pub fn now() -> Time {
  let seconds = std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map_or(0, |elapsed| elapsed.as_secs());
  Time { seconds, offset: 0 }
}

/// Writes the operation that follows the repository's current one with
/// `view`, as `actor` ran `command`: one operation, whatever it changed.
/// Its ID, and the operation.
pub fn write(repository: &Repository, actor: ActionActor, command: Vec<Vec<u8>>, view: View) -> GitResult<(NativeId, Operation)> {
  let operation = Operation { parents: vec![repository.operation], actor: Some(actor), time: Some(now()), command, view };
  let id = op_log::write(&repository.store.root, &operation, &[]).map_err(store_error)?;
  Ok((id, operation))
}

/// A time as `date` shows it: `iso-strict` for JSON, `iso` for people.
fn date(time: &Time, mode: DateMode) -> String {
  let magnitude = time.offset.unsigned_abs();
  let zone = format!("{}{:02}{:02}", if time.offset < 0 { '-' } else { '+' }, magnitude / 60, magnitude % 60);
  ident_date(time.seconds.to_string().as_bytes(), zone.as_bytes(), mode, 0).unwrap_or_default()
}

fn actor_json(actor: &ActionActor) -> Value {
  let mut object = JsonObject::new();
  object.set("actor", string(&actor.actor));
  if let Some(kind) = actor.kind {
    object.set("kind", string(kind.name()));
  }
  if let Some(principal) = &actor.on_behalf_of {
    object.set("for", string(principal));
  }
  Value::Object(object)
}

fn ids_json(ids: &[NativeId]) -> Value {
  Value::Array(ids.iter().map(|id| string(&id.hex())).collect())
}

/// A name's bytes as JSON carries them: `name`, decoded as UTF-8 with
/// replacement, and `nameHex`, the bytes, when they are not UTF-8.
pub fn set_name(object: &mut JsonObject, name: &[u8]) {
  object.set("name", string(&lossy(name)));
  if std::str::from_utf8(name).is_err() {
    object.set("nameHex", string(&hex(name)));
  }
}

/// A target as `causet.names/v1` holds it: an object by its ID and Git
/// type, or a name by its kind and name.
pub fn target_json(repository: &Repository, target: &Target) -> GitResult<Value> {
  let mut object = JsonObject::new();
  match target {
    Target::Object(id) => {
      let Some(kind) = repository.object(id)? else {
        return Err(crate::native_repository::corrupt(format!("a name targets {id}, which the store does not hold")));
      };
      object.set("object", string(&id.hex()));
      object.set("type", string(kind.name()));
    }
    Target::Name(kind, named) => {
      object.set("kind", string(kind.word()));
      set_name(&mut object, named);
    }
  }
  Ok(Value::Object(object))
}

/// A name as an operation's view holds it: its kind, name and local mark,
/// and its target, or for a conflicted one its sides and bases.
fn view_name_json(repository: &Repository, name: &Name) -> GitResult<Value> {
  let mut object = JsonObject::new();
  object.set("kind", string(name.kind.word()));
  set_name(&mut object, &name.name);
  object.set("local", Value::Bool(name.local));
  match &name.value {
    NameValue::Resolved(target) => object.set("target", target_json(repository, target)?),
    NameValue::Conflicted { adds, removes } => {
      let list = |targets: &[Option<Target>]| -> GitResult<Value> {
        let mut items = Vec::with_capacity(targets.len());
        for target in targets {
          items.push(match target {
            Some(target) => target_json(repository, target)?,
            None => Value::Null,
          });
        }
        Ok(Value::Array(items))
      };
      let mut conflicted = JsonObject::new();
      conflicted.set("adds", list(adds)?);
      conflicted.set("removes", list(removes)?);
      object.set("conflicted", Value::Object(conflicted));
    }
  }
  Ok(Value::Object(object))
}

/// What an operation records but its view.
fn summary_json(id: &NativeId, operation: &Operation) -> JsonObject {
  let mut object = JsonObject::new();
  fill_summary(&mut object, id, operation);
  object
}

fn fill_summary(object: &mut JsonObject, id: &NativeId, operation: &Operation) {
  object.set("id", string(&id.hex()));
  object.set("parents", ids_json(&operation.parents));
  object.set("actor", operation.actor.as_ref().map_or(Value::Null, actor_json));
  object.set("time", operation.time.as_ref().map_or(Value::Null, |time| string(&date(time, DateMode::IsoStrict))));
  object.set("command", Value::Array(operation.command.iter().map(|argument| string(&lossy(argument))).collect()));
}

/// `causet.operation/v1`: an operation whole, its view included.
pub fn operation_json(repository: &Repository, id: &NativeId, operation: &Operation) -> GitResult<Value> {
  let mut document = JsonObject::new();
  document.set("schema", string(OPERATION_SCHEMA));
  fill_summary(&mut document, id, operation);
  let mut view = JsonObject::new();
  view.set("shared", ids_json(&operation.view.shared));
  view.set("local", ids_json(&operation.view.local));
  let mut names = Vec::with_capacity(operation.view.names.len());
  for name in &operation.view.names {
    names.push(view_name_json(repository, name)?);
  }
  view.set("names", Value::Array(names));
  document.set("view", Value::Object(view));
  Ok(Value::Object(document))
}

/// Prints a JSON document and a line feed.
pub fn print_json(value: &Value) {
  let mut out = std::io::stdout().lock();
  let _ = writeln!(out, "{}", stringify_pretty(value));
}

/// An argument as the command line shows it: quoted when it holds a space
/// or a quote, or is empty.
fn shell_word(argument: &[u8]) -> String {
  let text = lossy(argument);
  if !text.is_empty() && !text.chars().any(|character| character.is_whitespace() || character == '"' || character == '\'') {
    return text;
  }
  format!("'{}'", text.replace('\'', "'\\''"))
}

/// An operation's header as `cst op log` and `cst op show` print it.
fn header(id: &NativeId, operation: &Operation, current: bool, out: &mut String) {
  out.push_str(&format!("operation {}{}\n", id.hex(), if current { " (current)" } else { "" }));
  if let Some(actor) = &operation.actor {
    let mut said = actor.actor.clone();
    match (actor.kind, &actor.on_behalf_of) {
      (Some(kind), Some(principal)) => said.push_str(&format!(" ({}, for {principal})", kind.name())),
      (Some(kind), None) => said.push_str(&format!(" ({})", kind.name())),
      (None, _) => {}
    }
    out.push_str(&format!("Actor:   {said}\n"));
  }
  if let Some(time) = &operation.time {
    out.push_str(&format!("Date:    {}\n", date(time, DateMode::Iso)));
  }
  let command: Vec<String> = operation.command.iter().map(|argument| shell_word(argument)).collect();
  out.push_str(&format!("Command: {}\n", command.join(" ")));
}

/// A target as human output shows it.
pub fn shown_target(target: &Target) -> String {
  match target {
    Target::Object(id) => short(id),
    Target::Name(kind, named) => format!("{} {}", kind.word(), lossy(named)),
  }
}

/// `cst op`: `log` or `show`.
pub fn op(args: &[OsString], root: &Path) -> GitResult<i32> {
  let json = wants_json(args);
  match run(args, root) {
    Err(error) if json => Ok(report(&error, true)),
    other => other,
  }
}

fn run(args: &[OsString], root: &Path) -> GitResult<i32> {
  // `--json` may come before the subcommand, and is the subcommand's.
  let Some(at) = args.iter().position(|arg| arg != "--json") else {
    return Err(GitError::new("usage-missing-argument", format!("cst op takes log or show. {OP_USAGE}")));
  };
  let rest: Vec<OsString> = args[..at].iter().chain(&args[at + 1..]).cloned().collect();
  match args[at].to_string_lossy().as_ref() {
    "log" => log(&rest, root),
    "show" => show(&rest, root),
    other => Err(GitError::new(
      "usage-unknown-command",
      format!("cst op has no subcommand '{other}'; it takes log or show. {OP_USAGE}"),
    )),
  }
}

fn unknown(subcommand: &str, arg: &str) -> GitError {
  GitError::new("usage-unknown-option", format!("Unknown option '{arg}' for 'cst op {subcommand}'. {OP_USAGE}"))
}

fn count(text: &[u8], option: &str) -> GitResult<usize> {
  std::str::from_utf8(text).ok().and_then(|digits| digits.parse().ok()).ok_or_else(|| {
    GitError::new("usage-invalid-option-value", format!("{option} takes a number, not '{}'.", lossy(text)))
  })
}

/// `cst op log`: the operations the current one reaches, newest first.
fn log(args: &[OsString], root: &Path) -> GitResult<i32> {
  let mut json = false;
  let mut limit: Option<usize> = None;
  let mut rest = args.iter();
  while let Some(arg) = rest.next() {
    let arg = bytes_of(arg);
    let shown = lossy(&arg);
    if arg == b"--json" {
      json = true;
    } else if arg == b"-n" || arg.starts_with(b"--max-count") {
      let name = if arg == b"-n" { "-n" } else { "--max-count" };
      let given = value(&arg, name, &mut rest)?.ok_or_else(|| unknown("log", &shown))?;
      limit = Some(count(&given, name)?);
    } else if let Some(given) = arg.strip_prefix(b"-n") {
      // `-n<n>`, attached, as Git takes it.
      limit = Some(count(given, "-n")?);
    } else if arg.len() > 1 && arg[0] == b'-' && arg[1..].iter().all(u8::is_ascii_digit) {
      limit = Some(count(&arg[1..], "-<n>")?);
    } else if arg.first() == Some(&b'-') {
      return Err(unknown("log", &shown));
    } else {
      return Err(GitError::new("usage-unknown-option", format!("cst op log takes no operation, and was given '{shown}'. {OP_USAGE}")));
    }
  }
  let repository = Repository::open(root)?;
  let listed = op_log::log(&repository.store, &[repository.operation], limit).map_err(store_error)?;
  if json {
    let mut document = JsonObject::new();
    document.set("schema", string(OPERATIONS_SCHEMA));
    document.set(
      "operations",
      Value::Array(listed.iter().map(|(id, operation)| Value::Object(summary_json(id, operation))).collect()),
    );
    print_json(&Value::Object(document));
    return Ok(0);
  }
  let mut out = String::new();
  for (index, (id, operation)) in listed.iter().enumerate() {
    if index > 0 {
      out.push('\n');
    }
    header(id, operation, *id == repository.operation, &mut out);
  }
  let _ = std::io::stdout().lock().write_all(out.as_bytes());
  Ok(0)
}

/// The operation a prefix of its ID names: the current one for none.
fn resolve(repository: &Repository, given: Option<&[u8]>) -> GitResult<NativeId> {
  let Some(given) = given else {
    return Ok(repository.operation);
  };
  let prefix = lossy(given);
  if prefix.len() < 4 || prefix.len() > 64 || !prefix.bytes().all(|byte| byte.is_ascii_hexdigit()) {
    return Err(GitError::new(
      "invalid-identifier",
      format!("'{prefix}' is not an operation ID: give at least 4 of its hex digits."),
    ));
  }
  let found = repository
    .store
    .matching(&prefix.to_ascii_lowercase(), |kind| kind == Type::Operation)
    .map_err(store_error)?;
  match found.as_slice() {
    [id] => Ok(*id),
    [] => Err(GitError::new("not-found", format!("No operation's ID begins with {prefix}."))),
    many => Err(GitError::new(
      "ambiguous-match",
      format!(
        "{prefix} begins {} operations' IDs: {}. Give more of its digits.",
        many.len(),
        many.iter().map(short).collect::<Vec<_>>().join(", ")
      ),
    )),
  }
}

/// `cst op show`: an operation and its view.
fn show(args: &[OsString], root: &Path) -> GitResult<i32> {
  let mut json = false;
  let mut given: Option<Vec<u8>> = None;
  for arg in args {
    let arg = bytes_of(arg);
    if arg == b"--json" {
      json = true;
    } else if arg.first() == Some(&b'-') {
      return Err(unknown("show", &lossy(&arg)));
    } else if given.is_some() {
      return Err(GitError::new("usage-conflicting-options", format!("cst op show takes one operation. {OP_USAGE}")));
    } else {
      given = Some(arg);
    }
  }
  let repository = Repository::open(root)?;
  let id = resolve(&repository, given.as_deref())?;
  let operation = Operation::read(&repository.store, &id).map_err(store_error)?;
  if json {
    print_json(&operation_json(&repository, &id, &operation)?);
    return Ok(0);
  }
  let mut out = String::new();
  header(&id, &operation, id == repository.operation, &mut out);
  if !operation.parents.is_empty() {
    let parents: Vec<String> = operation.parents.iter().map(NativeId::hex).collect();
    out.push_str(&format!("Parents: {}\n", parents.join(" ")));
  }
  let heads = |ids: &[NativeId]| if ids.is_empty() { "none".to_string() } else { ids.iter().map(NativeId::hex).collect::<Vec<_>>().join(" ") };
  out.push_str(&format!("\nShared heads: {}\nLocal heads:  {}\n", heads(&operation.view.shared), heads(&operation.view.local)));
  for name in &operation.view.names {
    let local = if name.local { " (local)" } else { "" };
    let value = match &name.value {
      NameValue::Resolved(target) => shown_target(target),
      NameValue::Conflicted { adds, .. } => {
        let sides: Vec<String> = adds.iter().map(|add| add.as_ref().map_or("absent".to_string(), shown_target)).collect();
        format!("conflicted: {}", sides.join(", "))
      }
    };
    out.push_str(&format!("{} {}{local} -> {value}\n", name.kind.word(), lossy(&name.name)));
  }
  let _ = std::io::stdout().lock().write_all(out.as_bytes());
  Ok(0)
}
