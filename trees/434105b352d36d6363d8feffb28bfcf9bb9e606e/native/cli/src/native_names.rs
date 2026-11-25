//! Names in a native repository (#418; ADR-0047 decisions 9 and 12,
//! docs/native-history/operations.md §2.3): `cst branch` and `cst tag` list
//! the branches, tags and remote-tracking names import made of the ref
//! snapshot (§4.1). With `--format` they print as `git branch --format` and
//! `git tag --format` print the original, IDs translated (ADR-0046, decision
//! 2); without it, cst's own human output. They start no Git process, and
//! every write is refused until the operation log and native writes exist
//! (#423, #426).

use crate::native::report;
use crate::native_inspection::{
  Field, Part, RefRow, Wild, finish, lossy, print_refs, ref_format, unknown_option, value, wildmatch,
};
use crate::native_log::wants_json;
use crate::native_repository::{bytes_of, corrupt};
use crate::native_revision::{Repository, SYMREF_MAXDEPTH, unsupported};
use causet_engine::errors::{GitError, GitResult};
use causet_history::names::{self, Kind, Name, Target};
use causet_model::json::{Object as JsonObject, Value, string, stringify_pretty};
use causet_store::id::{NativeId, hex};
use std::ffi::OsString;
use std::path::Path;

/// The document `--json` prints.
const SCHEMA: &str = "causet.names/v1";

const BRANCH_USAGE: &str =
  "Usage: cst branch [-r | -a] [--json | --format=<format>] [(-l | --list) [<pattern>...]]";
const TAG_USAGE: &str = "Usage: cst tag [--json | --format=<format>] [(-l | --list) [<pattern>...]]";

/// The options of `git branch` that write, or list in a way not built yet,
/// each refused as unimplemented rather than unknown.
const BRANCH_GIT_OPTIONS: &[&str] = &[
  "-v", "-vv", "--verbose", "-q", "--quiet", "-t", "--track", "--no-track", "-u", "--set-upstream-to",
  "--unset-upstream", "--color", "--no-color", "--contains", "--no-contains", "--abbrev", "--no-abbrev",
  "-d", "--delete", "-D", "-m", "--move", "-M", "-c", "--copy", "-C", "--show-current", "--create-reflog",
  "--edit-description", "-f", "--force", "--merged", "--no-merged", "--column", "--no-column", "--sort",
  "--points-at", "-i", "--ignore-case", "--recurse-submodules", "--omit-empty",
];

/// The same of `git tag`.
const TAG_GIT_OPTIONS: &[&str] = &[
  "-n", "-d", "--delete", "-v", "--verify", "-a", "--annotate", "-m", "--message", "-F", "--file",
  "--trailer", "-e", "--edit", "--no-edit", "-s", "--sign", "--no-sign", "-u", "--local-user", "-f",
  "--force", "--cleanup", "--create-reflog", "--column", "--no-column", "--contains", "--no-contains",
  "--merged", "--no-merged", "--points-at", "--sort", "-i", "--ignore-case", "--color", "--omit-empty",
];

#[derive(Clone, Copy, PartialEq, Eq)]
enum Command {
  Branch,
  Tag,
}

impl Command {
  fn word(self) -> &'static str {
    match self {
      Command::Branch => "branch",
      Command::Tag => "tag",
    }
  }

  fn usage(self) -> &'static str {
    match self {
      Command::Branch => BRANCH_USAGE,
      Command::Tag => TAG_USAGE,
    }
  }

  fn git_options(self) -> &'static [&'static str] {
    match self {
      Command::Branch => BRANCH_GIT_OPTIONS,
      Command::Tag => TAG_GIT_OPTIONS,
    }
  }
}

enum Output {
  Human,
  Json,
  Format(Vec<u8>),
}

/// What a listing asked for.
struct Listing {
  kinds: Vec<Kind>,
  patterns: Vec<Vec<u8>>,
  output: Output,
}

/// `cst branch`: the branches, with `-r` the remote-tracking names, and with
/// `-a` both.
pub fn branch(args: &[OsString], root: &Path) -> GitResult<i32> {
  list_with_envelope(Command::Branch, args, root)
}

/// `cst tag`: the tags.
pub fn tag(args: &[OsString], root: &Path) -> GitResult<i32> {
  list_with_envelope(Command::Tag, args, root)
}

/// A listing, a refusal under `--json` answered as the failure envelope
/// (ADR-0021).
fn list_with_envelope(command: Command, args: &[OsString], root: &Path) -> GitResult<i32> {
  match list(command, args, root) {
    Err(error) if wants_json(args) => Ok(report(&error, true)),
    other => other,
  }
}

fn parse(command: Command, args: &[OsString]) -> GitResult<Listing> {
  let mut listing = false;
  let (mut remotes, mut all) = (false, false);
  let mut format: Option<Vec<u8>> = None;
  let mut json = false;
  let mut positionals: Vec<Vec<u8>> = Vec::new();
  let mut options_done = false;
  let mut rest = args.iter();
  while let Some(arg) = rest.next() {
    let arg = bytes_of(arg);
    if options_done || arg.first() != Some(&b'-') || arg == b"-" {
      positionals.push(arg);
      continue;
    }
    let shown = lossy(&arg);
    match shown.as_str() {
      "--" => options_done = true,
      "--json" => json = true,
      "-l" | "--list" => listing = true,
      "-r" | "--remotes" if command == Command::Branch => remotes = true,
      "-a" | "--all" if command == Command::Branch => all = true,
      // Short flags given together, as `-al`, each judged as it would be
      // alone, so `-lv` is Git's `-v` and `-lz` is unknown.
      _ if arg.len() > 2 && arg[1] != b'-' => {
        for &letter in &arg[1..] {
          match letter {
            b'l' => listing = true,
            b'r' if command == Command::Branch => remotes = true,
            b'a' if command == Command::Branch => all = true,
            _ if command.git_options().contains(&format!("-{}", letter as char).as_str()) => {
              return Err(unsupported(format!("cst {} {shown}", command.word())));
            }
            _ => return Err(unknown_option(command.word(), &shown, command.usage())),
          }
        }
      }
      _ if arg.starts_with(b"--format") => {
        format = Some(
          value(&arg, "--format", &mut rest)?
            .ok_or_else(|| unknown_option(command.word(), &shown, command.usage()))?,
        );
      }
      _ => {
        let name = shown.split('=').next().unwrap_or_default();
        if command.git_options().contains(&name) {
          return Err(unsupported(format!("cst {} {shown}", command.word())));
        }
        return Err(unknown_option(command.word(), &shown, command.usage()));
      }
    }
  }
  if !positionals.is_empty() && !listing && (remotes || all) {
    // Git's refusal too: `-r` and `-a` list, and take no name.
    return Err(GitError::new(
      "usage-conflicting-options",
      format!("cst branch -r and -a take no branch name; to list by pattern, add -l. {BRANCH_USAGE}"),
    ));
  }
  if !positionals.is_empty() && !listing {
    return Err(unsupported(format!(
      "Creating a {} with cst {} <name>",
      command.word(),
      command.word()
    )));
  }
  let kinds = match command {
    Command::Tag => vec![Kind::Tag],
    Command::Branch if all => vec![Kind::Branch, Kind::RemoteTracking],
    Command::Branch if remotes => vec![Kind::RemoteTracking],
    Command::Branch => vec![Kind::Branch],
  };
  let output = match (format, json) {
    (Some(_), true) => {
      return Err(GitError::new(
        "usage-conflicting-options",
        format!("cst {} takes --json or --format, not both. {}", command.word(), command.usage()),
      ));
    }
    (Some(format), false) => Output::Format(format),
    (None, true) => Output::Json,
    (None, false) => Output::Human,
  };
  Ok(Listing { kinds, patterns: positionals, output })
}

/// Every name the repository holds: those its ref snapshot becomes.
fn read_names(repository: &Repository) -> GitResult<Vec<Name>> {
  names::from_snapshot(&repository.snapshot, |id| repository.named(*id))
}

/// The name a symbolic name ends at and its object, following names as Git
/// follows symbolic refs; `None` for one that ends at no name, or reads more
/// than `SYMREF_MAXDEPTH` names.
fn resolve<'a>(names: &'a [Name], name: &'a Name) -> Option<(&'a Name, NativeId)> {
  let mut at = name;
  for _ in 0..SYMREF_MAXDEPTH {
    match &at.target {
      Target::Object(id) => return Some((at, *id)),
      Target::Name(kind, target) => {
        at = names.iter().find(|other| other.kind == *kind && other.name == *target)?;
      }
    }
  }
  None
}

/// ref-filter's `match_pattern` for `git branch` and `git tag`: the name,
/// without its namespace, matched as a glob in which `*` crosses `/`.
fn matches(patterns: &[Vec<u8>], name: &Name) -> bool {
  patterns.is_empty()
    || patterns
      .iter()
      .any(|pattern| wildmatch(pattern, &name.name, false) == Wild::Match)
}

fn list(command: Command, args: &[OsString], root: &Path) -> GitResult<i32> {
  let listing = parse(command, args)?;
  let parts = match &listing.output {
    Output::Format(format) => Some(listed_format(command, format)?),
    Output::Human | Output::Json => None,
  };
  let repository = Repository::open(root)?;
  let names = read_names(&repository)?;
  let shown: Vec<&Name> = names
    .iter()
    .filter(|name| listing.kinds.contains(&name.kind) && matches(&listing.patterns, name))
    .collect();
  let mut out = Vec::new();
  let result = match parts {
    Some(parts) => {
      // Git lists only the refs that resolve, as `ref-filter` skips a broken one.
      let rows: Vec<RefRow> = shown
        .iter()
        .filter_map(|name| {
          let (end, id) = resolve(&names, name)?;
          let symbolic = matches!(name.target, Target::Name(..));
          Some(RefRow {
            name: name.kind.reference(&name.name),
            symref: symbolic.then(|| end.kind.reference(&end.name)),
            id,
          })
        })
        .collect();
      print_refs(&repository, None, &rows, &parts, &mut out).map(|()| 0)
    }
    None if matches!(listing.output, Output::Json) => {
      let mut entries = Vec::with_capacity(shown.len());
      for name in &shown {
        entries.push(name_json(&repository, name)?);
      }
      let mut document = JsonObject::new();
      document.set("schema", string(SCHEMA));
      document.set("names", Value::Array(entries));
      out.extend_from_slice(stringify_pretty(&Value::Object(document)).as_bytes());
      out.push(b'\n');
      Ok(0)
    }
    None => {
      human(&listing, &shown, &mut out);
      Ok(0)
    }
  };
  finish(out, result)
}

/// A listing's `--format`, as for-each-ref parses it, less `%(HEAD)`: a
/// native repository's `HEAD` is no name (operations.md §4.1).
fn listed_format(command: Command, format: &[u8]) -> GitResult<Vec<Part>> {
  let parts = ref_format(format, command.word())?;
  if parts.iter().any(|part| matches!(part, Part::Field(Field::Head))) {
    return Err(GitError::new(
      "unsupported-feature",
      format!(
        "The field %(HEAD) of cst {} marks the ref HEAD names, and a native repository's HEAD is no name (docs/native-history/operations.md §4.1), so it is refused.",
        command.word()
      ),
    ));
  }
  Ok(parts)
}

/// cst's own listing: a name a line, a symbolic one followed by ` -> ` and
/// the name it names, with that name's kind when it is another. Beside
/// branches, a remote-tracking name is `remotes/<name>`, as Git shows one.
fn human(listing: &Listing, shown: &[&Name], out: &mut Vec<u8>) {
  let mixed = listing.kinds.len() > 1;
  for name in shown {
    if mixed && name.kind == Kind::RemoteTracking {
      out.extend_from_slice(b"remotes/");
    }
    out.extend_from_slice(&name.name);
    if let Target::Name(kind, target) = &name.target {
      out.extend_from_slice(b" -> ");
      if *kind != name.kind {
        out.extend_from_slice(kind.word().as_bytes());
        out.push(b' ');
      }
      out.extend_from_slice(target);
    }
    out.push(b'\n');
  }
}

/// A name's bytes as JSON carries them: `name`, decoded as UTF-8 with
/// replacement, and `nameHex`, the bytes, when they are not UTF-8.
fn set_name(object: &mut JsonObject, name: &[u8]) {
  object.set("name", string(&lossy(name)));
  if std::str::from_utf8(name).is_err() {
    object.set("nameHex", string(&hex(name)));
  }
}

/// A name as `causet.names/v1` holds it: its kind, name and local mark, and
/// its target, an object by its ID and Git type, or a name by its kind and
/// name.
fn name_json(repository: &Repository, name: &Name) -> GitResult<Value> {
  let mut object = JsonObject::new();
  object.set("kind", string(name.kind.word()));
  set_name(&mut object, &name.name);
  object.set("local", Value::Bool(name.local));
  let mut target = JsonObject::new();
  match &name.target {
    Target::Object(id) => {
      let Some(kind) = repository.object(id)? else {
        return Err(corrupt(format!(
          "the {} {} names {id}, which the store does not hold",
          name.kind.word(),
          lossy(&name.name)
        )));
      };
      target.set("object", string(&id.hex()));
      target.set("type", string(kind.name()));
    }
    Target::Name(kind, named) => {
      target.set("kind", string(kind.word()));
      set_name(&mut target, named);
    }
  }
  object.set("target", Value::Object(target));
  Ok(Value::Object(object))
}
