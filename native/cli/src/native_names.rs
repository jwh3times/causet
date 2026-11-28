//! Names in a native repository (#418, #423; ADR-0047 decisions 9, 10 and
//! 12, docs/native-history/operations.md §2.3): `cst branch` and `cst tag`
//! list the branches, tags and remote-tracking names of the current view.
//! With `--format` they print as `git branch --format` and `git tag
//! --format` print the original, IDs translated (ADR-0046, decision 2);
//! without it, cst's own human output. They start no Git process.
//!
//! `cst branch` also writes, each invocation one operation (§3.2): it
//! creates a branch at a start point, moves one with `-f`, deletes branches
//! with `-d`, and marks one local with `--local`. The operation names its
//! actor, declared with `--actor` or `CAUSET_AGENT`. `cst tag` writes
//! nothing yet (#426).

use crate::native::report;
use crate::native_inspection::{
  Field, Part, RefRow, Wild, finish, lossy, print_refs, ref_format, unknown_option, value, wildmatch,
};
use crate::native_log::wants_json;
use crate::native_operations::{self, ActorOptions, print_json, short};
use crate::native_repository::bytes_of;
use crate::native_revision::{Hint, Repository, SYMREF_MAXDEPTH, unsupported};
use causet_engine::errors::{GitError, GitResult};
use causet_history::names::{Kind, Name, Target, Value as NameValue};
use causet_model::json::{Object as JsonObject, Value, string, stringify_pretty};
use causet_store::id::NativeId;
use std::ffi::OsString;
use std::io::Write as _;
use std::path::Path;

/// The document `--json` prints for a listing: v2 holds a conflicted name's
/// sides, which v1's required target cannot (#424).
const SCHEMA: &str = "causet.names/v2";

const BRANCH_USAGE: &str = "Usage: cst branch [-r | -a] [--json | --format=<format>] [(-l | --list) [<pattern>...]], \
cst branch [--local] [-f | --force] <name> <start-point>, cst branch (-d | -D | --delete) <name>..., \
or cst branch (--local | --no-local) <name>; a write takes --actor <name> [--kind human|agent] [--for <name>]";
const TAG_USAGE: &str = "Usage: cst tag [--json | --format=<format>] [(-l | --list) [<pattern>...]]";

/// The options of `git branch` not built here, each refused as
/// unimplemented rather than unknown.
const BRANCH_GIT_OPTIONS: &[&str] = &[
  "-v", "-vv", "--verbose", "-q", "--quiet", "-t", "--track", "--no-track", "-u", "--set-upstream-to",
  "--unset-upstream", "--color", "--no-color", "--contains", "--no-contains", "--abbrev", "--no-abbrev",
  "-m", "--move", "-M", "-c", "--copy", "-C", "--show-current", "--create-reflog", "--edit-description",
  "--merged", "--no-merged", "--column", "--no-column", "--sort", "--points-at", "-i", "--ignore-case",
  "--recurse-submodules", "--omit-empty",
];

/// The same of `git tag`, every write among them (#426).
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

/// What a branch write asked for.
enum Change {
  /// Create `name` at `start`, or with `force` create or move it there.
  Set { name: Vec<u8>, start: Vec<u8>, force: bool, local: Option<bool> },
  /// Delete each.
  Delete(Vec<Vec<u8>>),
  /// Mark an existing branch local, or not.
  Mark { name: Vec<u8>, local: bool },
}

struct Write {
  change: Change,
  actor: ActorOptions,
  json: bool,
}

enum Request {
  List(Listing),
  Write(Write),
}

/// `cst branch`: a listing or a write.
pub fn branch(args: &[OsString], root: &Path) -> GitResult<i32> {
  with_envelope(Command::Branch, args, root)
}

/// `cst tag`: the tags.
pub fn tag(args: &[OsString], root: &Path) -> GitResult<i32> {
  with_envelope(Command::Tag, args, root)
}

/// A command, a refusal under `--json` answered as the failure envelope
/// (ADR-0021).
fn with_envelope(command: Command, args: &[OsString], root: &Path) -> GitResult<i32> {
  let result = match parse(command, args) {
    Ok(Request::List(listing)) => list(command, listing, root),
    Ok(Request::Write(write)) => write_branch(write, args, root),
    Err(error) => Err(error),
  };
  match result {
    Err(error) if wants_json(args) => Ok(report(&error, true)),
    other => other,
  }
}

fn conflicting(message: String) -> GitError {
  GitError::new("usage-conflicting-options", message)
}

fn parse(command: Command, args: &[OsString]) -> GitResult<Request> {
  let mut listing = false;
  let (mut remotes, mut all) = (false, false);
  let mut format: Option<Vec<u8>> = None;
  let mut json = false;
  let (mut force, mut delete) = (false, false);
  let mut local: Option<bool> = None;
  let mut actor = ActorOptions::default();
  let mut positionals: Vec<Vec<u8>> = Vec::new();
  let mut options_done = false;
  let mut rest = args.iter();
  let branch = command == Command::Branch;
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
      "-r" | "--remotes" if branch => remotes = true,
      "-a" | "--all" if branch => all = true,
      "-f" | "--force" if branch => force = true,
      "-d" | "-D" | "--delete" if branch => delete = true,
      "--local" if branch => local = Some(true),
      "--no-local" if branch => local = Some(false),
      _ if branch && actor.take(&arg, &mut rest)? => {}
      // Short flags given together, as `-al`, each judged as it would be
      // alone, so `-lv` is Git's `-v` and `-lz` is unknown.
      _ if arg.len() > 2 && arg[1] != b'-' => {
        for &letter in &arg[1..] {
          match letter {
            b'l' => listing = true,
            b'r' if branch => remotes = true,
            b'a' if branch => all = true,
            b'f' if branch => force = true,
            b'd' | b'D' if branch => delete = true,
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
  let writing = force || delete || local.is_some() || actor.given() || (!positionals.is_empty() && !listing);
  if !writing || listing {
    if force || delete || local.is_some() || actor.given() {
      return Err(conflicting(format!("cst branch -l lists, and takes no option that writes. {BRANCH_USAGE}")));
    }
    return parse_listing(command, remotes, all, format, json, positionals).map(Request::List);
  }
  if command == Command::Tag {
    return Err(unsupported("Creating a tag with cst tag <name> (#426)"));
  }
  if remotes || all {
    if !delete && !force && local.is_none() && !actor.given() {
      // Git's refusal too: `-r` and `-a` list, and take no name.
      return Err(conflicting(format!(
        "cst branch -r and -a take no branch name; to list by pattern, add -l. {BRANCH_USAGE}"
      )));
    }
    return Err(GitError::new(
      "unsupported-feature",
      "Remote-tracking names are written by import only until N5 defines remotes (docs/native-history/operations.md §2.1), so cst branch -r and -a do not write.",
    ));
  }
  if format.is_some() {
    return Err(conflicting(format!("--format formats a listing, and a write prints no names. {BRANCH_USAGE}")));
  }
  let change = if delete {
    if force || local.is_some() {
      return Err(conflicting(format!("cst branch -d deletes, and takes neither -f nor --local. {BRANCH_USAGE}")));
    }
    if positionals.is_empty() {
      return Err(GitError::new("usage-missing-argument", format!("cst branch -d takes the branches to delete. {BRANCH_USAGE}")));
    }
    Change::Delete(positionals)
  } else {
    if positionals.len() > 2 {
      return Err(conflicting(format!("cst branch takes a branch name and a start point, and no more. {BRANCH_USAGE}")));
    }
    let mut positionals = positionals.into_iter();
    let (Some(name), start) = (positionals.next(), positionals.next()) else {
      return Err(GitError::new("usage-missing-argument", format!("cst branch takes the branch to write. {BRANCH_USAGE}")));
    };
    match (start, local) {
      (Some(start), local) => Change::Set { name, start, force, local },
      (None, Some(local)) if !force => Change::Mark { name, local },
      (None, _) => {
        return Err(GitError::new(
          "usage-missing-argument",
          format!(
            "cst branch {} needs a start point: a native repository's HEAD is no name until N3 defines workspaces (docs/native-history/operations.md §4.1). {BRANCH_USAGE}",
            lossy(&name)
          ),
        ));
      }
    }
  };
  Ok(Request::Write(Write { change, actor, json }))
}

fn parse_listing(
  command: Command,
  remotes: bool,
  all: bool,
  format: Option<Vec<u8>>,
  json: bool,
  positionals: Vec<Vec<u8>>,
) -> GitResult<Listing> {
  let kinds = match command {
    Command::Tag => vec![Kind::Tag],
    Command::Branch if all => vec![Kind::Branch, Kind::RemoteTracking],
    Command::Branch if remotes => vec![Kind::RemoteTracking],
    Command::Branch => vec![Kind::Branch],
  };
  let output = match (format, json) {
    (Some(_), true) => {
      return Err(conflicting(format!(
        "cst {} takes --json or --format, not both. {}",
        command.word(),
        command.usage()
      )));
    }
    (Some(format), false) => Output::Format(format),
    (None, true) => Output::Json,
    (None, false) => Output::Human,
  };
  Ok(Listing { kinds, patterns: positionals, output })
}

/// The name a symbolic name ends at and its object, following names as Git
/// follows symbolic refs; `None` for one that ends at no name, or reads more
/// than `SYMREF_MAXDEPTH` names.
fn resolve<'a>(names: &'a [Name], name: &'a Name) -> Option<(&'a Name, NativeId)> {
  let mut at = name;
  for _ in 0..SYMREF_MAXDEPTH {
    match at.resolved()? {
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
  patterns.is_empty() || patterns.iter().any(|pattern| wildmatch(pattern, &name.name, false) == Wild::Match)
}

fn list(command: Command, listing: Listing, root: &Path) -> GitResult<i32> {
  let parts = match &listing.output {
    Output::Format(format) => Some(listed_format(command, format)?),
    Output::Human | Output::Json => None,
  };
  let repository = Repository::open(root)?;
  let names = &repository.view.names;
  let shown: Vec<&Name> =
    names.iter().filter(|name| listing.kinds.contains(&name.kind) && matches(&listing.patterns, name)).collect();
  let mut out = Vec::new();
  let result = match parts {
    Some(parts) => {
      // Git lists only the refs that resolve, as `ref-filter` skips a broken
      // one. A conflicted name names no one object, so it is left out too,
      // and said so (operations.md §2.3).
      warn_conflicted(&shown);
      let rows: Vec<RefRow> = shown
        .iter()
        .filter_map(|name| {
          let (end, id) = resolve(names, name)?;
          let symbolic = matches!(name.resolved(), Some(Target::Name(..)));
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
        entries.push(native_operations::view_name_json(&repository, name)?);
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

/// Says on stderr that each conflicted name of `shown` is left out of a
/// `--format` listing, which prints one object a name.
pub fn warn_conflicted(shown: &[&Name]) {
  let mut err = std::io::stderr().lock();
  for name in shown.iter().filter(|name| name.resolved().is_none()) {
    let _ = writeln!(err, "warning: the {} {} is conflicted, so it is left out", name.kind.word(), lossy(&name.name));
  }
}

/// cst's own listing: a name a line, a symbolic one followed by ` -> ` and
/// the name it names, with that name's kind when it is another, and a
/// conflicted one by its sides, as `main (conflicted: 0136ed38eb3a,
/// absent)`. Beside branches, a remote-tracking name is `remotes/<name>`, as
/// Git shows one.
fn human(listing: &Listing, shown: &[&Name], out: &mut Vec<u8>) {
  let mixed = listing.kinds.len() > 1;
  for name in shown {
    if mixed && name.kind == Kind::RemoteTracking {
      out.extend_from_slice(b"remotes/");
    }
    out.extend_from_slice(&name.name);
    match &name.value {
      NameValue::Resolved(Target::Name(kind, target)) => {
        out.extend_from_slice(b" -> ");
        if *kind != name.kind {
          out.extend_from_slice(kind.word().as_bytes());
          out.push(b' ');
        }
        out.extend_from_slice(target);
      }
      NameValue::Resolved(Target::Object(_)) => {}
      NameValue::Conflicted { .. } => {
        out.extend_from_slice(format!(" ({})", native_operations::conflicted_sides(name)).as_bytes());
      }
    }
    out.push(b'\n');
  }
}

/// Git's `check_refname_format` for `refs/heads/<name>`, and its
/// `strbuf_check_branch_ref`: what a branch's name must be for the bridge to
/// make a ref of it.
fn check_branch_name(name: &[u8]) -> GitResult<()> {
  let refuse = |why: &str| {
    Err(GitError::new("invalid-identifier", format!("'{}' is not a valid branch name: {why}.", lossy(name))))
  };
  if name.is_empty() {
    return refuse("it is empty");
  }
  if name.starts_with(b"-") {
    return refuse("it begins with '-'");
  }
  if name == b"HEAD" || name == b"@" {
    return refuse("it is reserved");
  }
  if name.ends_with(b"/") || name.ends_with(b".") {
    return refuse("it ends with '/' or '.'");
  }
  if name.windows(2).any(|pair| pair == b".." || pair == b"@{" || pair == b"//") {
    return refuse("it holds '..', '@{' or '//'");
  }
  if name.iter().any(|&byte| byte < 0x20 || byte == 0x7f || b" ~^:?*[\\".contains(&byte)) {
    return refuse("it holds a control character, a space, or one of ~^:?*[\\");
  }
  if name.split(|&byte| byte == b'/').any(|part| part.starts_with(b".") || part.ends_with(b".lock")) {
    return refuse("a component begins with '.' or ends with '.lock'");
  }
  Ok(())
}

/// Refuses a new branch that one already held would be a directory of, or
/// that would be a directory of one: Git cannot hold both
/// `refs/heads/a` and `refs/heads/a/b`, so the bridge could make no ref of
/// it.
fn check_no_directory_clash(view: &causet_history::operation::View, name: &[u8]) -> GitResult<()> {
  let under = |parent: &[u8], child: &[u8]| child.len() > parent.len() && child.starts_with(parent) && child[parent.len()] == b'/';
  let clash = view
    .names
    .iter()
    .filter(|held| held.kind == Kind::Branch)
    .find(|held| under(&held.name, name) || under(name, &held.name));
  match clash {
    Some(held) => Err(GitError::new(
      "already-exists",
      format!(
        "A branch '{}' cannot be created beside the branch '{}': Git cannot hold both refs/heads/{} and refs/heads/{}.",
        lossy(name),
        lossy(&held.name),
        lossy(name),
        lossy(&held.name)
      ),
    )),
    None => Ok(()),
  }
}

/// The branch `name` of the current view, refused when there is none.
fn held<'a>(repository: &'a Repository, name: &[u8]) -> GitResult<&'a Name> {
  repository
    .view
    .name(Kind::Branch, name)
    .ok_or_else(|| GitError::new("not-found", format!("No branch named '{}'.", lossy(name))))
}

/// What a branch held before a write, as human output shows it.
fn was(name: &Name) -> String {
  match &name.value {
    NameValue::Resolved(target) => native_operations::shown_target(target),
    NameValue::Conflicted { .. } => native_operations::conflicted_sides(name),
  }
}

/// `cst branch`'s writes: one operation, whatever it changes.
fn write_branch(write: Write, args: &[OsString], root: &Path) -> GitResult<i32> {
  let actor = write.actor.actor("branch")?;
  let repository = Repository::open(root)?;
  let mut view = repository.view.clone();
  let mut said: Vec<String> = Vec::new();
  match &write.change {
    Change::Set { name, start, force, local } => {
      check_branch_name(name)?;
      let resolved = repository.resolve_as(start, Hint::Committish)?;
      let commit = repository.commit_of(resolved)?.ok_or_else(|| {
        GitError::new("no-match", format!("'{}' is not a commit, so a branch cannot start there.", lossy(start)))
      })?;
      let existing = view.name(Kind::Branch, name).cloned();
      if existing.is_none() {
        check_no_directory_clash(&view, name)?;
      }
      let mark = match (&existing, local) {
        (_, Some(local)) => *local,
        (Some(existing), None) => existing.local,
        (None, None) => false,
      };
      match &existing {
        Some(_) if !force => {
          return Err(GitError::new(
            "already-exists",
            format!("A branch named '{}' already exists; move it with -f.", lossy(name)),
          ));
        }
        Some(existing) if existing.resolved().is_none() => {
          said.push(format!("Resolved branch {} ({}) to {}.", lossy(name), was(existing), short(&commit)));
        }
        Some(existing) => {
          said.push(format!("Moved branch {} from {} to {}.", lossy(name), was(existing), short(&commit)));
        }
        None => said.push(format!("Created branch {} at {}.", lossy(name), short(&commit))),
      }
      if mark {
        said.push(format!("Branch {} is local.", lossy(name)));
      }
      view = view.with(Name { kind: Kind::Branch, name: name.clone(), local: mark, value: NameValue::Resolved(Target::Object(commit)) });
    }
    Change::Delete(names) => {
      let checked_out = repository.head_branches();
      for name in names {
        let existing = held(&repository, name)?;
        if checked_out.iter().any(|branch| branch == name) {
          return Err(GitError::new(
            "no-match",
            format!(
              "The branch '{}' is the one HEAD names, so it is not deleted: HEAD would name nothing (docs/native-history/operations.md §2.4).",
              lossy(name)
            ),
          ));
        }
        // A name given twice is deleted once.
        if view.name(Kind::Branch, name).is_none() {
          continue;
        }
        said.push(format!("Deleted branch {} (was {}).", lossy(name), was(existing)));
        view = view.without(Kind::Branch, name);
      }
    }
    Change::Mark { name, local } => {
      let mut existing = held(&repository, name)?.clone();
      existing.local = *local;
      said.push(format!("Branch {} is {}.", lossy(name), if *local { "local" } else { "not local" }));
      view = view.with(existing);
    }
  }
  let mut command = vec![b"branch".to_vec()];
  command.extend(args.iter().map(bytes_of));
  let (id, operation) = native_operations::write(&repository, actor, command, view)?;
  if write.json {
    print_json(&native_operations::operation_json(&repository, &id, &operation)?);
    return Ok(0);
  }
  said.push(format!("Operation {}.", short(&id)));
  let mut out = std::io::stdout().lock();
  for line in said {
    let _ = writeln!(out, "{line}");
  }
  Ok(0)
}
