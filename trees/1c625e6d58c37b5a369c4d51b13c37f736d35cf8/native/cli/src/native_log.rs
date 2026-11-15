//! `cst log` and `cst show` in a native repository (#416, #417; ADR-0046
//! decision 2, ADR-0047 decision 12). They read native commits and tags
//! alone, never the preserved Git objects they derive from, and run no Git.
//!
//! - **`--format`** prints each commit as `git log --format` prints it on
//!   the Git-backed original, byte for byte, IDs translated
//!   (`causet_history::pretty`), and `show` prints an annotated tag as `git
//!   show` does before what it tags.
//! - **Without `--format`** they print cst's own human output, and with
//!   `--json` the `causet.log/v1` and `causet.show/v1` documents.
//! - **The walk** is Git's revision walk: newest first by commit date, a
//!   range's excluded commits marked as Git marks them, `limit_list` and its
//!   slop included, then `--skip`, `-n` and `--reverse`.
//!
//! Every option outside that set is refused, never passed to Git: there is
//! none to pass to. So is a patch: `show` takes `-s` with `--format`.

use crate::native::report;
use crate::native_repository::{bytes_of, corrupt};
use crate::native_revision::{Hint, Object, Repository, unsupported};
use causet_engine::errors::{GitError, GitResult};
use causet_history::actor::Actor;
use causet_history::commit::{Commit, Commits};
use causet_history::date::{DateMode, ident_date};
use causet_history::pretty::{self, Failure, Format, Options};
use causet_history::signature::Signature;
use causet_history::tag::Tag;
use causet_import::store_error;
use causet_model::json::{Object as JsonObject, Value, string, stringify_pretty};
use causet_store::id::{NativeId, Type, hex};
use std::collections::{HashMap, HashSet, VecDeque};
use std::ffi::OsString;
use std::io::Write as _;
use std::path::Path;

const LOG_USAGE: &str = "Usage: cst log [<options>] [<revision>...] [--json | --format=<format>]";
const SHOW_USAGE: &str =
  "Usage: cst show [-s] [<options>] [<object>...] [--json | --format=<format>]";

/// The `causet.log/v1` and `causet.show/v1` documents.
pub const LOG_SCHEMA: &str = "causet.log/v1";
pub const SHOW_SCHEMA: &str = "causet.show/v1";

/// Git's `FALLBACK_DEFAULT_ABBREV`.
const SHORTEST: usize = 7;

/// `limit_list`'s `SLOP`.
const SLOP: u32 = 5;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Command {
  Log,
  Show,
}

impl Command {
  fn name(self) -> &'static str {
    match self {
      Command::Log => "log",
      Command::Show => "show",
    }
  }

  fn usage(self) -> &'static str {
    match self {
      Command::Log => LOG_USAGE,
      Command::Show => SHOW_USAGE,
    }
  }
}

/// What an invocation asked for.
struct Request {
  format: Option<Format>,
  json: bool,
  options: Options,
  revisions: Vec<Vec<u8>>,
  max_count: Option<usize>,
  skip: usize,
  reverse: bool,
  first_parent: bool,
  min_parents: usize,
  max_parents: Option<usize>,
  no_patch: bool,
}

fn unknown(command: Command, option: &[u8]) -> GitError {
  GitError::new(
    "usage-unknown-option",
    format!(
      "Unknown option '{}' for 'cst {}' in a native repository. {}",
      String::from_utf8_lossy(option),
      command.name(),
      command.usage()
    ),
  )
}

/// A count, `None` for a negative one, which Git takes as no limit.
fn limit(command: Command, option: &str, value: &[u8]) -> GitResult<Option<usize>> {
  match value.strip_prefix(b"-") {
    Some(digits) => count(command, option, digits).map(|_| None),
    None => count(command, option, value).map(Some),
  }
}

fn count(command: Command, option: &str, value: &[u8]) -> GitResult<usize> {
  std::str::from_utf8(value)
    .ok()
    .filter(|text| !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit()))
    .and_then(|text| text.parse().ok())
    .ok_or_else(|| {
      GitError::new(
        "usage-invalid-option-value",
        format!(
          "cst {} {option} takes a count, not '{}'.",
          command.name(),
          String::from_utf8_lossy(value)
        ),
      )
    })
}

/// The options Git prints a patch or diff with, which no phase builds yet.
const PATCH: [&str; 13] = [
  "-p",
  "-u",
  "--patch",
  "--stat",
  "--numstat",
  "--shortstat",
  "--name-only",
  "--name-status",
  "--raw",
  "--cc",
  "-m",
  "-c",
  "--summary",
];

fn parse(command: Command, args: &[OsString]) -> GitResult<Request> {
  let mut request = Request {
    format: None,
    json: false,
    options: Options::default(),
    revisions: Vec::new(),
    max_count: None,
    skip: 0,
    reverse: false,
    first_parent: false,
    min_parents: 0,
    max_parents: None,
    no_patch: false,
  };
  let args: Vec<Vec<u8>> = args.iter().map(bytes_of).collect();
  let mut at = 0;
  let value = |at: &mut usize, option: &str| -> GitResult<Vec<u8>> {
    *at += 1;
    args.get(*at).cloned().ok_or_else(|| {
      GitError::new(
        "usage-missing-argument",
        format!(
          "cst {} {option} needs a value. {}",
          command.name(),
          command.usage()
        ),
      )
    })
  };
  while at < args.len() {
    let arg = &args[at];
    if arg == b"--" {
      if at + 1 < args.len() {
        return Err(unsupported(format!("cst {} with paths", command.name())));
      }
      break;
    }
    if !arg.starts_with(b"-") || arg == b"-" {
      request.revisions.push(arg.clone());
      at += 1;
      continue;
    }
    let log = command == Command::Log;
    if let Some(spec) = arg
      .strip_prefix(b"--format=")
      .or_else(|| arg.strip_prefix(b"--pretty="))
    {
      if Format::is_named(spec) {
        return Err(unsupported(format!(
          "cst {} --format={}, one of Git's named formats, its human output, which cst does not reproduce: cst {} without --format prints cst's own, and",
          command.name(),
          String::from_utf8_lossy(spec),
          command.name()
        )));
      }
      request.format = Some(
        Format::parse(spec)
          .map_err(|what| unsupported(format!("cst {} --format with {what}", command.name())))?,
      );
    } else if arg == b"--pretty" || arg == b"--oneline" {
      return Err(unsupported(format!(
        "cst {} {}, one of Git's named formats, its human output, which cst does not reproduce: cst {} without it prints cst's own, and",
        command.name(),
        String::from_utf8_lossy(arg),
        command.name()
      )));
    } else if arg == b"--json" {
      request.json = true;
    } else if arg == b"-s" || arg == b"--no-patch" {
      request.no_patch = true;
    } else if let Some(mode) = arg.strip_prefix(b"--date=") {
      request.options.date = date_mode(command, mode)?;
    } else if arg == b"--date" {
      let mode = value(&mut at, "--date")?;
      request.options.date = date_mode(command, &mode)?;
    } else if arg == b"--relative-date" {
      request.options.date = DateMode::Relative;
    } else if PATCH.contains(&String::from_utf8_lossy(arg).as_ref()) {
      let hint = if command == Command::Show {
        " (cst show -s --format prints a commit without one)"
      } else {
        ""
      };
      return Err(unsupported(format!(
        "cst {} {}, which prints a patch{hint},",
        command.name(),
        String::from_utf8_lossy(arg)
      )));
    } else if log && let Some(n) = arg.strip_prefix(b"--max-count=") {
      request.max_count = limit(command, "--max-count", n)?;
    } else if log && arg == b"--max-count" {
      let n = value(&mut at, "--max-count")?;
      request.max_count = limit(command, "--max-count", &n)?;
    } else if log && arg == b"-n" {
      let n = value(&mut at, "-n")?;
      request.max_count = limit(command, "-n", &n)?;
    } else if log && let Some(n) = arg.strip_prefix(b"-n") {
      request.max_count = limit(command, "-n", n)?;
    } else if log && arg.len() > 1 && arg[1].is_ascii_digit() {
      request.max_count = limit(command, "-<n>", &arg[1..])?;
    } else if log && let Some(n) = arg.strip_prefix(b"--skip=") {
      request.skip = count(command, "--skip", n)?;
    } else if log && arg == b"--skip" {
      let n = value(&mut at, "--skip")?;
      request.skip = count(command, "--skip", &n)?;
    } else if log && arg == b"--reverse" {
      request.reverse = true;
    } else if log && arg == b"--first-parent" {
      request.first_parent = true;
    } else if log && arg == b"--merges" {
      request.min_parents = 2;
    } else if log && arg == b"--no-merges" {
      request.max_parents = Some(1);
    } else {
      return Err(unknown(command, arg));
    }
    at += 1;
  }
  if request.json && request.format.is_some() {
    return Err(GitError::new(
      "usage-conflicting-options",
      format!(
        "cst {} takes --json or --format, not both. {}",
        command.name(),
        command.usage()
      ),
    ));
  }
  Ok(request)
}

fn date_mode(command: Command, name: &[u8]) -> GitResult<DateMode> {
  DateMode::parse(name).ok_or_else(|| {
    unsupported(format!(
      "cst {} --date={}: of Git's date formats, default, relative, short, iso, iso-strict, rfc, raw and unix are implemented, and any other",
      command.name(),
      String::from_utf8_lossy(name)
    ))
  })
}

/// Whether an invocation asked for `--json`, which a refusal answers as an
/// envelope.
fn wants_json(args: &[OsString]) -> bool {
  args
    .iter()
    .take_while(|arg| *arg != "--")
    .any(|arg| arg == "--json")
}

/// `cst log`: the history of the revisions given, `HEAD` by default.
pub fn log(args: &[OsString], root: &Path) -> GitResult<i32> {
  let json = wants_json(args);
  match run_log(args, root) {
    Err(error) if json => Ok(report(&error, true)),
    other => other,
  }
}

/// `cst show`: each object given, `HEAD` by default.
pub fn show(args: &[OsString], root: &Path) -> GitResult<i32> {
  let json = wants_json(args);
  match run_show(args, root) {
    Err(error) if json => Ok(report(&error, true)),
    other => other,
  }
}

fn run_log(args: &[OsString], root: &Path) -> GitResult<i32> {
  let request = parse(Command::Log, args)?;
  let repository = Repository::open(root)?;
  let history = History {
    repository: &repository,
    commits: repository.commits().map_err(store_error)?,
  };
  let mut starts = Vec::new();
  if request.revisions.is_empty() {
    starts.push((history.commit_named(b"HEAD")?, false));
  }
  for revision in &request.revisions {
    starts.extend(history.range(revision)?);
  }
  let shown = history.walk(&starts, &request)?;
  let mut printer = Printer::new(&history, &request);
  for id in &shown {
    printer.commit(id)?;
  }
  printer.finish(LOG_SCHEMA, "commits")
}

fn run_show(args: &[OsString], root: &Path) -> GitResult<i32> {
  let request = parse(Command::Show, args)?;
  if request.format.is_some() && !request.no_patch {
    return Err(unsupported(
      "cst show --format without -s, which Git follows with a patch, which",
    ));
  }
  let repository = Repository::open(root)?;
  let history = History {
    repository: &repository,
    commits: repository.commits().map_err(store_error)?,
  };
  let names = if request.revisions.is_empty() {
    vec![b"HEAD".to_vec()]
  } else {
    request.revisions.clone()
  };
  let mut objects = Vec::new();
  for name in &names {
    let shown = String::from_utf8_lossy(name).into_owned();
    let id = repository.resolve_as(name, Hint::Any)?;
    objects.push((shown, id));
  }
  let mut printer = Printer::new(&history, &request);
  printer.typed = true;
  for (shown, id) in objects {
    let mut id = id;
    let mut seen = HashSet::new();
    loop {
      if !seen.insert(id) {
        return Err(corrupt(format!("the tag {id} names itself")));
      }
      match repository.object(&id)? {
        // Git's `SHOWN`: a commit `show` printed already, as what a tag
        // tags or by name, is not printed again.
        Some(Object::Commit) => {
          history.require_native(&id, &shown)?;
          if printer.shown.insert(id) {
            printer.commit(&id)?;
          }
          break;
        }
        Some(Object::Tag) => {
          if repository.store.held(&id).map_err(store_error)? != Some(Type::NativeTag) {
            return Err(old_import(&shown, "tag"));
          }
          let tag = repository.native_tag(&id).map_err(store_error)?;
          printer.tag(&id, &tag)?;
          id = tag.target;
        }
        Some(other) => {
          return Err(unsupported(format!(
            "cst show of {shown}, a {},",
            other.name()
          )));
        }
        None => {
          return Err(GitError::new(
            "not-found",
            format!("{shown} names no object"),
          ));
        }
      }
    }
  }
  printer.finish(SHOW_SCHEMA, "objects")
}

fn old_import(shown: &str, what: &str) -> GitError {
  GitError::new(
    "unsupported-feature",
    format!(
      "{shown} names a {what} this native repository holds no native {what} for, as an import before native history left it. Import the Git repository into it again to derive its history."
    ),
  )
}

/// A native repository with its native commits read.
struct History<'a> {
  repository: &'a Repository,
  commits: &'a Commits,
}

/// What Git's walk marks a commit with.
#[derive(Default, Clone, Copy)]
struct Flags {
  uninteresting: bool,
  seen: bool,
}

impl History<'_> {
  /// The native commit a revision names, through tags, as every N1 command
  /// resolves names (commits.md §6). A commit with no native commit is one
  /// an import before native history left.
  fn commit_named(&self, revision: &[u8]) -> GitResult<NativeId> {
    let shown = String::from_utf8_lossy(revision).into_owned();
    let named = self.repository.resolve_as(revision, Hint::Committish)?;
    let (peeled, kind) = self.repository.deref_tags(named)?;
    if kind != Some(Object::Commit) {
      return Err(GitError::new(
        "not-found",
        format!("{shown} does not name a commit"),
      ));
    }
    self.require_native(&peeled, &shown)?;
    Ok(peeled)
  }

  fn require_native(&self, id: &NativeId, shown: &str) -> GitResult<()> {
    if self.commits.by_id.contains_key(id) {
      Ok(())
    } else {
      Err(old_import(shown, "commit"))
    }
  }

  /// A revision argument's commits, each with whether it is excluded: `rev`,
  /// `^rev`, and `a..b`, either side `HEAD` when empty.
  fn range(&self, revision: &[u8]) -> GitResult<Vec<(NativeId, bool)>> {
    if let Some(at) = revision.windows(2).position(|pair| pair == b"..") {
      let (left, right) = (&revision[..at], &revision[at + 2..]);
      if right.first() == Some(&b'.') {
        return Err(unsupported(format!(
          "cst log of {}, a symmetric difference,",
          String::from_utf8_lossy(revision)
        )));
      }
      let side = |name: &[u8]| {
        if name.is_empty() {
          b"HEAD".to_vec()
        } else {
          name.to_vec()
        }
      };
      return Ok(vec![
        (self.commit_named(&side(left))?, true),
        (self.commit_named(&side(right))?, false),
      ]);
    }
    if let Some(excluded) = revision.strip_prefix(b"^") {
      return Ok(vec![(self.commit_named(excluded)?, true)]);
    }
    Ok(vec![(self.commit_named(revision)?, false)])
  }

  fn commit(&self, id: &NativeId) -> GitResult<&Commit> {
    self.commits.by_id.get(id).ok_or_else(|| {
      corrupt(format!(
        "a native commit names {id} as a parent, which is not a native commit"
      ))
    })
  }

  /// Git's revision walk (`prepare_revision_walk`, `get_revision`): the
  /// commits shown, in the order shown.
  fn walk(&self, starts: &[(NativeId, bool)], request: &Request) -> GitResult<Vec<NativeId>> {
    let mut walk = Walk {
      history: self,
      flags: HashMap::new(),
      parsed: starts.iter().map(|(id, _)| *id).collect(),
      first_parent: request.first_parent,
    };
    for (id, excluded) in starts {
      if *excluded {
        walk.flags.entry(*id).or_default().uninteresting = true;
      }
    }
    let mut list: Vec<NativeId> = Vec::new();
    for (id, excluded) in starts {
      if *excluded {
        walk.mark_parents_uninteresting(id)?;
      }
      let flags = walk.flags.entry(*id).or_default();
      if !flags.seen {
        flags.seen = true;
        list.push(*id);
      }
    }
    // `commit_list_sort_by_date`, a stable sort, newest first.
    let mut dated = Vec::with_capacity(list.len());
    for id in list {
      dated.push((self.commit(&id)?.date(), id));
    }
    dated.sort_by(|a, b| b.0.cmp(&a.0));
    let mut list: VecDeque<(u64, NativeId)> = dated.into_iter().collect();
    let limited = starts.iter().any(|(_, excluded)| *excluded);
    let mut candidates = Vec::new();
    if limited {
      // `limit_list`.
      let mut date = u64::MAX;
      let mut slop = SLOP;
      let mut cache: Option<NativeId> = None;
      while let Some((_, id)) = list.pop_front() {
        if cache == Some(id) {
          cache = None;
        }
        walk.process_parents(&id, &mut list)?;
        if walk.uninteresting(&id) {
          walk.mark_parents_uninteresting(&id)?;
          slop = walk.still_interesting(&list, date, slop, &mut cache);
          if slop > 0 {
            continue;
          }
          break;
        }
        date = self.commit(&id)?.date();
        candidates.push(id);
      }
    }
    // `get_revision`: what `simplify_commit` keeps, then `--skip`, `-n`
    // and `--reverse`.
    let mut shown = Vec::new();
    let mut skip = request.skip;
    let mut remaining = request.max_count;
    let mut candidates = candidates.into_iter();
    loop {
      if remaining == Some(0) {
        break;
      }
      let next = if limited {
        candidates.next()
      } else {
        match list.pop_front() {
          Some((_, id)) => {
            walk.process_parents(&id, &mut list)?;
            Some(id)
          }
          None => None,
        }
      };
      let Some(id) = next else {
        break;
      };
      if walk.uninteresting(&id) {
        continue;
      }
      let parents = self.commit(&id)?.parents.len();
      if parents < request.min_parents || request.max_parents.is_some_and(|most| parents > most) {
        continue;
      }
      if skip > 0 {
        skip -= 1;
        continue;
      }
      shown.push(id);
      if let Some(left) = remaining.as_mut() {
        *left -= 1;
      }
    }
    if request.reverse {
      shown.reverse();
    }
    Ok(shown)
  }

  /// An ID's prefix that names it alone among the objects a prefix may
  /// name (`Repository::candidates`), so a revision resolves it, at least as
  /// long as Git's `core.abbrev=auto` makes one for a store of this many
  /// objects (ADR-0046, decision 5; commits.md §6).
  fn abbreviate(&self, id: &NativeId) -> GitResult<String> {
    let bits = (usize::BITS - self.commits.objects.leading_zeros()) as usize;
    let mut length = bits.div_ceil(2).max(SHORTEST);
    let hex = id.hex();
    while length < hex.len() && self.repository.candidates(&hex[..length])?.len() > 1 {
      length += 1;
    }
    Ok(hex[..length].to_string())
  }
}

/// The state of Git's walk: each commit's flags, and which commits it has
/// parsed, which decides how far `mark_parents_uninteresting` reaches.
struct Walk<'a> {
  history: &'a History<'a>,
  flags: HashMap<NativeId, Flags>,
  parsed: HashSet<NativeId>,
  first_parent: bool,
}

impl Walk<'_> {
  fn uninteresting(&self, id: &NativeId) -> bool {
    self.flags.get(id).is_some_and(|flags| flags.uninteresting)
  }

  fn parents(&self, id: &NativeId) -> GitResult<Vec<NativeId>> {
    Ok(self.history.commit(id)?.parents.clone())
  }

  /// `commit_list_insert_by_date`: after every commit of its date or newer.
  fn insert(&self, list: &mut VecDeque<(u64, NativeId)>, id: NativeId) -> GitResult<()> {
    let when = self.history.commit(&id)?.date();
    let at = list
      .iter()
      .position(|(other, _)| *other < when)
      .unwrap_or(list.len());
    list.insert(at, (when, id));
    Ok(())
  }

  /// `process_parents`.
  fn process_parents(
    &mut self,
    id: &NativeId,
    list: &mut VecDeque<(u64, NativeId)>,
  ) -> GitResult<()> {
    let parents = self.parents(id)?;
    if self.uninteresting(id) {
      for parent in parents {
        self.flags.entry(parent).or_default().uninteresting = true;
        self.parsed.insert(parent);
        if !self.history.commit(&parent)?.parents.is_empty() {
          self.mark_parents_uninteresting(&parent)?;
        }
        let flags = self.flags.entry(parent).or_default();
        if flags.seen {
          continue;
        }
        flags.seen = true;
        self.insert(list, parent)?;
      }
      return Ok(());
    }
    for parent in parents {
      self.parsed.insert(parent);
      let flags = self.flags.entry(parent).or_default();
      if !flags.seen {
        flags.seen = true;
        self.insert(list, parent)?;
      }
      if self.first_parent {
        break;
      }
    }
    Ok(())
  }

  /// `mark_parents_uninteresting`: through the commits already parsed.
  fn mark_parents_uninteresting(&mut self, id: &NativeId) -> GitResult<()> {
    let mut pending: Vec<NativeId> = Vec::new();
    for parent in self.parents(id)? {
      self.mark_one(parent, &mut pending)?;
    }
    while let Some(next) = pending.pop() {
      self.mark_one(next, &mut pending)?;
    }
    Ok(())
  }

  fn mark_one(&mut self, id: NativeId, pending: &mut Vec<NativeId>) -> GitResult<()> {
    let flags = self.flags.entry(id).or_default();
    if flags.uninteresting {
      return Ok(());
    }
    flags.uninteresting = true;
    if self.parsed.contains(&id) {
      pending.extend(self.parents(&id)?);
    }
    Ok(())
  }

  /// `still_interesting`, with `everybody_uninteresting`.
  fn still_interesting(
    &self,
    list: &VecDeque<(u64, NativeId)>,
    date: u64,
    slop: u32,
    cache: &mut Option<NativeId>,
  ) -> u32 {
    let Some((first, _)) = list.front() else {
      return 0;
    };
    if date <= *first {
      return SLOP;
    }
    if let Some(cached) = cache
      && !self.uninteresting(cached)
    {
      return SLOP;
    }
    if let Some((_, interesting)) = list.iter().find(|(_, id)| !self.uninteresting(id)) {
      *cache = Some(*interesting);
      return SLOP;
    }
    slop - 1
  }
}

/// Where each command's output goes: `--format`'s bytes, cst's human
/// output, or the JSON document's entries.
struct Printer<'a> {
  history: &'a History<'a>,
  request: &'a Request,
  out: Vec<u8>,
  entries: Vec<Value>,
  shown_one: bool,
  /// The commits printed so far.
  shown: HashSet<NativeId>,
  /// Whether each JSON entry says what type of object it is, as `show`'s do.
  typed: bool,
}

impl<'a> Printer<'a> {
  fn new(history: &'a History<'a>, request: &'a Request) -> Printer<'a> {
    Printer {
      history,
      request,
      out: Vec::new(),
      entries: Vec::new(),
      shown_one: false,
      shown: HashSet::new(),
      typed: false,
    }
  }

  fn commit(&mut self, id: &NativeId) -> GitResult<()> {
    let commit = self.history.commit(id)?;
    if self.request.json {
      let kind = self.typed.then_some("commit");
      self
        .entries
        .push(commit_json(id, commit, &self.request.options, kind));
      return Ok(());
    }
    let Some(format) = &self.request.format else {
      if self.shown_one {
        self.out.push(b'\n');
      }
      self.shown_one = true;
      human_commit(
        &mut self.out,
        id,
        commit,
        self.history,
        &self.request.options,
      )?;
      return Ok(());
    };
    if self.shown_one && format.separated() {
      self.out.push(b'\n');
    }
    self.shown_one = true;
    let abbrev = |id: &NativeId| self.history.abbreviate(id);
    match format.render_with(commit, id, &abbrev, &self.request.options) {
      Ok(text) => {
        self.out.extend_from_slice(&text);
        Ok(())
      }
      Err(Failure::Unimplemented(what)) => {
        self.out.clear();
        Err(unsupported(format!("printing the commit {id}, {what},")))
      }
      Err(Failure::Fatal(why)) => {
        self.flush();
        Err(GitError::new(
          "malformed-input",
          format!("the commit {id}: {why}"),
        ))
      }
      Err(Failure::Abbreviation(error)) => Err(error),
    }
  }

  /// An annotated tag, as `git show` prints one before what it tags.
  fn tag(&mut self, id: &NativeId, tag: &Tag) -> GitResult<()> {
    if self.request.json {
      let target = self.history.repository.object(&tag.target)?;
      self
        .entries
        .push(tag_json(id, tag, target, &self.request.options));
      return Ok(());
    }
    if self.request.format.is_none() {
      if self.shown_one {
        self.out.push(b'\n');
      }
      self.shown_one = true;
      human_tag(&mut self.out, id, tag, &self.request.options);
      return Ok(());
    }
    if self.shown_one {
      self.out.push(b'\n');
    }
    self.out.extend_from_slice(b"tag ");
    self.out.extend_from_slice(&tag.name);
    self.out.push(b'\n');
    // `show_tagger` with a user format: the name and email, no date.
    if let Some(line) = tag.tagger.line()
      && let Some(identity) = pretty::identity(&line)
    {
      self.out.extend_from_slice(b"Tagger: ");
      self.out.extend_from_slice(&identity.name);
      self.out.extend_from_slice(b" <");
      self.out.extend_from_slice(&identity.email);
      self.out.extend_from_slice(b">\n");
    }
    // Git prints the tag from its blank line on; a tag with no message has
    // no blank line in any tag Git writes.
    if !tag.message.is_empty() {
      self.out.push(b'\n');
      self.out.extend_from_slice(&tag.message);
    }
    self.shown_one = true;
    Ok(())
  }

  fn flush(&mut self) {
    let _ = std::io::stdout().lock().write_all(&self.out);
    self.out.clear();
  }

  fn finish(mut self, schema: &str, member: &str) -> GitResult<i32> {
    if self.request.json {
      let mut document = JsonObject::new();
      document.set("schema", string(schema));
      document.set(member, Value::Array(std::mem::take(&mut self.entries)));
      let text = stringify_pretty(&Value::Object(document));
      let _ = writeln!(std::io::stdout().lock(), "{text}");
      return Ok(0);
    }
    self.flush();
    Ok(0)
  }
}

/// Text as JSON carries it, decoded as UTF-8 with replacement.
fn text(bytes: &[u8]) -> Value {
  string(&String::from_utf8_lossy(bytes))
}

fn optional_text(value: Option<&str>) -> Value {
  value.map_or(Value::Null, string)
}

/// An identity line as JSON carries it: the line, in UTF-8 as Git prints
/// it, the name and email Git finds in it, and its date in ISO 8601, each
/// `null` when Git finds none; `lineHex` holds the stored bytes when they
/// are not UTF-8.
fn signature_json(signature: &Signature, shown: &[u8], options: &Options) -> Value {
  let Some(stored) = signature.line() else {
    return Value::Null;
  };
  let mut object = JsonObject::new();
  object.set("line", text(shown));
  let identity = pretty::identity(shown);
  object.set(
    "name",
    identity
      .as_ref()
      .map_or(Value::Null, |found| text(&found.name)),
  );
  object.set(
    "email",
    identity
      .as_ref()
      .map_or(Value::Null, |found| text(&found.email)),
  );
  let date = identity
    .as_ref()
    .and_then(|found| found.date.as_ref())
    .and_then(|(digits, zone)| ident_date(digits, zone, DateMode::IsoStrict, options.now).ok());
  object.set("date", optional_text(date.as_deref()));
  if std::str::from_utf8(&stored).is_err() {
    object.set("lineHex", string(&hex(&stored)));
  }
  Value::Object(object)
}

fn actors_json(actors: &[Actor]) -> Value {
  Value::Array(
    actors
      .iter()
      .map(|actor| {
        let mut object = JsonObject::new();
        object.set("role", string(actor.role.name()));
        object.set("actor", string(&actor.actor));
        if let Some(kind) = actor.kind {
          object.set("kind", string(kind.name()));
        }
        if let Some(principal) = &actor.on_behalf_of {
          object.set("for", string(principal));
        }
        Value::Object(object)
      })
      .collect(),
  )
}

/// A message as JSON carries it: in UTF-8 as `%B` prints it, and
/// `messageHex`, the stored bytes, when those are not UTF-8.
fn message_json(object: &mut JsonObject, stored: &[u8], shown: &[u8]) {
  object.set("message", text(shown));
  if std::str::from_utf8(stored).is_err() {
    object.set("messageHex", string(&hex(stored)));
  }
}

fn commit_json(id: &NativeId, commit: &Commit, options: &Options, kind: Option<&str>) -> Value {
  let shown = pretty::text(commit);
  let mut object = JsonObject::new();
  if let Some(kind) = kind {
    object.set("type", string(kind));
  }
  object.set("id", string(&id.hex()));
  object.set("tree", string(&commit.tree.hex()));
  object.set(
    "parents",
    Value::Array(
      commit
        .parents
        .iter()
        .map(|parent| string(&parent.hex()))
        .collect(),
    ),
  );
  let line = |signature: &Signature, recoded: Option<&Vec<u8>>| {
    let shown = recoded
      .cloned()
      .or_else(|| signature.line())
      .unwrap_or_default();
    signature_json(signature, &shown, options)
  };
  object.set(
    "author",
    line(&commit.author, shown.as_ref().ok().map(|text| &text.author)),
  );
  object.set(
    "committer",
    line(
      &commit.committer,
      shown.as_ref().ok().map(|text| &text.committer),
    ),
  );
  object.set(
    "encoding",
    commit.encoding.as_deref().map_or(Value::Null, text),
  );
  object.set("changeId", optional_text(commit.change_id.as_deref()));
  object.set("derivedFrom", optional_text(commit.derived_from.as_deref()));
  object.set(
    "originCommit",
    optional_text(commit.origin_commit.as_deref()),
  );
  object.set("actors", actors_json(&commit.actors));
  let message = match &shown {
    Ok(text) => text.message.clone(),
    Err(_) => commit.message.clone(),
  };
  message_json(&mut object, &commit.message, &message);
  Value::Object(object)
}

fn tag_json(id: &NativeId, tag: &Tag, target: Option<Object>, options: &Options) -> Value {
  let mut object = JsonObject::new();
  object.set("type", string("tag"));
  object.set("id", string(&id.hex()));
  object.set("name", text(&tag.name));
  if std::str::from_utf8(&tag.name).is_err() {
    object.set("nameHex", string(&hex(&tag.name)));
  }
  object.set("target", string(&tag.target.hex()));
  object.set(
    "targetType",
    target.map_or(Value::Null, |kind| string(kind.name())),
  );
  let line = tag.tagger.line().unwrap_or_default();
  object.set("tagger", signature_json(&tag.tagger, &line, options));
  object.set("actors", actors_json(&tag.actors));
  message_json(&mut object, &tag.message, &tag.message);
  Value::Object(object)
}

/// An identity for cst's human output: its name and email as Git finds
/// them, or the line as it is, and its date in the command's mode, or the
/// line's digits and zone when Git's `log` would die on it.
fn human_identity(line: &[u8], options: &Options) -> (Vec<u8>, Option<Vec<u8>>) {
  match pretty::identity(line) {
    Some(identity) => {
      let mut who = identity.name.clone();
      if !who.is_empty() {
        who.push(b' ');
      }
      who.push(b'<');
      who.extend_from_slice(&identity.email);
      who.push(b'>');
      let date = identity.date.map(|(digits, zone)| {
        match ident_date(&digits, &zone, options.date, options.now) {
          Ok(shown) => shown.into_bytes(),
          Err(_) => [digits.as_slice(), b" ", zone.as_slice()].concat(),
        }
      });
      (who, date)
    }
    None => (line.to_vec(), None),
  }
}

fn human_actors(out: &mut Vec<u8>, actors: &[Actor]) {
  if actors.is_empty() {
    return;
  }
  let shown: Vec<String> = actors
    .iter()
    .map(|actor| {
      let kind = match (actor.kind, &actor.on_behalf_of) {
        (Some(kind), Some(principal)) => format!(" ({}, for {principal})", kind.name()),
        (Some(kind), None) => format!(" ({})", kind.name()),
        (None, _) => String::new(),
      };
      format!("{} by {}{kind}", actor.role.name(), actor.actor)
    })
    .collect();
  out.extend_from_slice(format!("Actors:  {}\n", shown.join("; ")).as_bytes());
}

fn human_message(out: &mut Vec<u8>, message: &[u8]) {
  if message.is_empty() {
    return;
  }
  out.push(b'\n');
  let trimmed = message.strip_suffix(b"\n").unwrap_or(message);
  for line in trimmed.split(|&byte| byte == b'\n') {
    if !line.is_empty() {
      out.extend_from_slice(b"    ");
      out.extend_from_slice(line);
    }
    out.push(b'\n');
  }
}

/// cst's own human output of a commit (docs/native-history/reading.md §5).
fn human_commit(
  out: &mut Vec<u8>,
  id: &NativeId,
  commit: &Commit,
  history: &History,
  options: &Options,
) -> GitResult<()> {
  let shown = pretty::text(commit).ok();
  out.extend_from_slice(format!("commit {id}\n").as_bytes());
  let line = |recoded: Option<&Vec<u8>>, signature: &Signature| match recoded {
    Some(line) => (!line.is_empty()).then(|| line.clone()),
    None => signature.line(),
  };
  let author = line(shown.as_ref().map(|text| &text.author), &commit.author)
    .map(|line| human_identity(&line, options));
  let committer = line(
    shown.as_ref().map(|text| &text.committer),
    &commit.committer,
  )
  .map(|line| human_identity(&line, options));
  if commit.parents.len() > 1 {
    let mut parents = Vec::new();
    for parent in &commit.parents {
      parents.push(history.abbreviate(parent)?);
    }
    out.extend_from_slice(format!("Merge:   {}\n", parents.join(" ")).as_bytes());
  }
  if let Some((who, date)) = &author {
    out.extend_from_slice(b"Author:  ");
    out.extend_from_slice(who);
    out.push(b'\n');
    if let Some(date) = date {
      out.extend_from_slice(b"Date:    ");
      out.extend_from_slice(date);
      out.push(b'\n');
    }
  }
  if let Some((who, date)) = &committer
    && author.as_ref() != Some(&(who.clone(), date.clone()))
  {
    out.extend_from_slice(b"Commit:  ");
    out.extend_from_slice(who);
    if let Some(date) = date {
      out.extend_from_slice(b", ");
      out.extend_from_slice(date);
    }
    out.push(b'\n');
  }
  if let Some(change) = &commit.change_id {
    out.extend_from_slice(format!("Change:  {change}\n").as_bytes());
  }
  let lineage: Vec<String> = [
    commit
      .derived_from
      .as_ref()
      .map(|from| format!("derived from {from}")),
    commit
      .origin_commit
      .as_ref()
      .map(|origin| format!("origin {origin}")),
  ]
  .into_iter()
  .flatten()
  .collect();
  if !lineage.is_empty() {
    out.extend_from_slice(format!("Lineage: {}\n", lineage.join("; ")).as_bytes());
  }
  human_actors(out, &commit.actors);
  let message = shown.map_or_else(|| commit.message.clone(), |text| text.message);
  human_message(out, &message);
  Ok(())
}

/// cst's own human output of an annotated tag.
fn human_tag(out: &mut Vec<u8>, id: &NativeId, tag: &Tag, options: &Options) {
  out.extend_from_slice(b"tag ");
  out.extend_from_slice(&tag.name);
  out.extend_from_slice(format!(" {id}\n").as_bytes());
  if let Some(line) = tag.tagger.line() {
    let (who, date) = human_identity(&line, options);
    out.extend_from_slice(b"Tagger:  ");
    out.extend_from_slice(&who);
    out.push(b'\n');
    if let Some(date) = date {
      out.extend_from_slice(b"Date:    ");
      out.extend_from_slice(&date);
      out.push(b'\n');
    }
  }
  human_actors(out, &tag.actors);
  human_message(out, &tag.message);
}
