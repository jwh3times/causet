//! N1's inspection commands in a native repository (ADR-0046 decisions 3 and
//! 9; #304). `cst ls-tree`, `cst rev-parse` and `cst for-each-ref` answer
//! byte for byte as Git does on the original, with native IDs where Git
//! prints Git IDs; `cst fsck` verifies the store. Each implements the part of
//! Git's command its usage names, and refuses any other option rather than
//! approximate it: a machine format is either byte-identical or absent
//! (ADR-0046). Like Git, each prints what it found before a failure.

use crate::native_repository::{Listed, bytes_of, corrupt, listing, quoted, size};
use crate::native_revision::{Hint, Object, Repository, unsupported};
use causet_engine::errors::{GitError, GitResult};
use causet_import::store_error;
use causet_store::id::{NativeId, Type};
use causet_store::store::Store;
use causet_store::verify;
use std::ffi::OsString;
use std::io::Write as _;
use std::path::Path;

/// Writes what a command printed, then passes its result on.
fn finish(out: Vec<u8>, result: GitResult<i32>) -> GitResult<i32> {
  let _ = std::io::stdout().lock().write_all(&out);
  result
}

fn lossy(bytes: &[u8]) -> String {
  String::from_utf8_lossy(bytes).into_owned()
}

fn unknown_option(command: &str, option: &str, usage: &str) -> GitError {
  GitError::new(
    "usage-unknown-option",
    format!("Unknown option '{option}' for 'cst {command}'. {usage}"),
  )
}

/// An option's value, given as `--name=<value>` or as the next argument.
fn value(arg: &[u8], name: &str, rest: &mut std::slice::Iter<OsString>) -> GitResult<Option<Vec<u8>>> {
  if arg == name.as_bytes() {
    return rest.next().map(|next| Some(bytes_of(next))).ok_or_else(|| {
      GitError::new("usage-missing-argument", format!("option '{name}' requires a value"))
    });
  }
  Ok(
    arg
      .strip_prefix(name.as_bytes())
      .and_then(|rest| rest.strip_prefix(b"="))
      .map(<[u8]>::to_vec),
  )
}

/// An object's size as Git reports it.
fn object_size(repository: &Repository, id: &NativeId) -> GitResult<u64> {
  let store = &repository.store;
  if store.held(id) == Some(Type::Content) {
    return store.content_size(id).map_err(store_error);
  }
  let read = store.read_known(id).map_err(store_error)?;
  Ok(size(store, &read.kind, &read.body)? as u64)
}

/// A name as Git's `get_oid_committish` reads it, `None` when it names
/// nothing or is ambiguous, as each makes it no revision at all.
fn committish(repository: &Repository, name: &[u8]) -> GitResult<Option<NativeId>> {
  match repository.resolve_as(name, Hint::Committish) {
    Ok(id) => Ok(Some(id)),
    Err(error) if matches!(error.code, "not-found" | "ambiguous-match") => Ok(None),
    Err(error) => Err(error),
  }
}

/// Git's `max_allowed_tree_depth`, the default of `core.maxTreeDepth`.
const MAX_TREE_DEPTH: usize = 2048;

const LS_TREE_USAGE: &str = "Usage: cst ls-tree [-d] [-r] [-t] [-z] [-l | --name-only | --name-status | --object-only | --format=<format>] <tree-ish> [<path>...]";

/// The entry formats of `ls-tree` that exclude each other.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Shown {
  Entries,
  Long,
  NameOnly,
  NameStatus,
  ObjectOnly,
}

impl Shown {
  fn option(self) -> &'static str {
    match self {
      Shown::Entries => "",
      Shown::Long => "-l",
      Shown::NameOnly => "--name-only",
      Shown::NameStatus => "--name-status",
      Shown::ObjectOnly => "--object-only",
    }
  }
}

/// A piece of an `ls-tree --format`.
enum Piece {
  Literal(Vec<u8>),
  Mode,
  Type,
  Name,
  Size { padded: bool },
  Path,
}

/// Git's `ls-tree --format`: `%(<field>)`, and `%%`, `%n` and `%x<hex>`. Git
/// reports a bad format at the first entry it prints, so the error waits for
/// one.
fn ls_tree_format(format: &[u8]) -> Result<Vec<Piece>, GitError> {
  let bad = |what: String| {
    GitError::new(
      "usage-invalid-option-value",
      format!("bad ls-tree format: {what}"),
    )
  };
  let mut pieces = Vec::new();
  let mut literal = Vec::new();
  let mut at = 0;
  while at < format.len() {
    if format[at] != b'%' {
      literal.push(format[at]);
      at += 1;
      continue;
    }
    let rest = &format[at + 1..];
    if let Some(byte) = literal_escape(rest) {
      literal.push(byte);
      at += if rest[0] == b'x' { 4 } else { 2 };
      continue;
    }
    if rest.first() != Some(&b'(') {
      return Err(bad(format!("element '{}' does not start with '('", lossy(rest))));
    }
    let Some(end) = rest.iter().position(|&byte| byte == b')') else {
      return Err(bad(format!("element '{}' does not end in ')'", lossy(rest))));
    };
    let piece = match &rest[..=end] {
      b"(objectmode)" => Piece::Mode,
      b"(objecttype)" => Piece::Type,
      b"(objectsize:padded)" => Piece::Size { padded: true },
      b"(objectsize)" => Piece::Size { padded: false },
      b"(objectname)" => Piece::Name,
      b"(path)" => Piece::Path,
      other => return Err(bad(format!("%{}", lossy(other)))),
    };
    pieces.push(Piece::Literal(std::mem::take(&mut literal)));
    pieces.push(piece);
    at += end + 2;
  }
  pieces.push(Piece::Literal(literal));
  Ok(pieces)
}

/// `%%`, `%n` and `%x<two hex digits>`, as Git's `strbuf_expand_literal`
/// reads them after a `%`.
fn literal_escape(rest: &[u8]) -> Option<u8> {
  match rest {
    [b'%', ..] => Some(b'%'),
    [b'n', ..] => Some(b'\n'),
    [b'x', high, low, ..] => hex_pair(*high, *low),
    _ => None,
  }
}

fn hex_pair(high: u8, low: u8) -> Option<u8> {
  let digit = |byte: u8| (byte as char).to_digit(16);
  Some((digit(high)? * 16 + digit(low)?) as u8)
}

/// A path argument as Git's `prefix_path` normalizes it, from the top: `.`
/// and empty components are dropped and `..` climbs, and a trailing `/`, or
/// one that a final `.` or `..` implies, is kept.
fn pathspec(arg: &[u8]) -> GitResult<Vec<u8>> {
  let shown = lossy(arg);
  if arg.is_empty() {
    return Err(GitError::new(
      "malformed-input",
      "empty string is not a valid pathspec. please use . instead if you meant to match all paths",
    ));
  }
  if arg[0] == b':' {
    return Err(unsupported(format!("The pathspec '{shown}', with magic,")));
  }
  let outside = || {
    GitError::new(
      "path-outside-repository",
      format!("{shown}: '{shown}' is outside the repository"),
    )
  };
  if arg[0] == b'/' {
    return Err(outside());
  }
  let parts: Vec<&[u8]> = arg.split(|&byte| byte == b'/').collect();
  let mut kept: Vec<&[u8]> = Vec::new();
  let mut slash = arg.ends_with(b"/");
  for (at, part) in parts.iter().enumerate() {
    let last = at + 1 == parts.len();
    match *part {
      b"" => {}
      b"." => slash |= last,
      b".." => {
        kept.pop().ok_or_else(outside)?;
        slash |= last;
      }
      name => kept.push(name),
    }
  }
  let mut spec = kept.join(&b'/');
  if slash && !spec.is_empty() {
    spec.push(b'/');
  }
  Ok(spec)
}

/// What `tree_entry_interesting` decides for an entry.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Interest {
  /// Neither it nor any later entry of this tree.
  AllNot,
  Not,
  Yes,
  /// It and every later entry of this tree.
  All,
}

/// Git's `do_match` for literal path specs, which are all `ls-tree` takes:
/// `base` is the entry's tree's path with its trailing `/`.
fn interest(specs: &[Vec<u8>], base: &[u8], entry: &Listed) -> Interest {
  let directory = entry.mode & 0o170000 == 0o040000;
  let link = entry.mode & 0o170000 == 0o160000;
  let mut never = Interest::AllNot;
  for spec in specs.iter().rev() {
    if base.len() >= spec.len() {
      // A spec naming a directory the base is in matches all of it.
      if base.starts_with(spec)
        && (spec.is_empty() || base.get(spec.len()) == Some(&b'/') || spec.ends_with(b"/"))
      {
        return Interest::All;
      }
      continue;
    }
    let Some(rest) = spec.strip_prefix(base) else {
      continue;
    };
    if matches_entry(rest, &entry.name, directory, link, &mut never) {
      return Interest::Yes;
    }
  }
  never
}

/// Git's `match_entry`. Entries are in Git's order, so a spec that sorts
/// before this entry matches no later one either.
fn matches_entry(spec: &[u8], path: &[u8], directory: bool, link: bool, never: &mut Interest) -> bool {
  if *never != Interest::Not {
    let common = spec.len().min(path.len());
    if spec[..common] < path[..common] {
      return false;
    }
    *never = Interest::Not;
  }
  if path.len() > spec.len() {
    return false;
  }
  if spec.len() > path.len() {
    if spec[path.len()] != b'/' {
      return false;
    }
    // Only a directory, or a submodule link named with one trailing slash,
    // leads to a longer path.
    if !directory && (!link || spec.len() > path.len() + 1) {
      return false;
    }
  }
  spec[..path.len()] == *path
}

struct Listing<'a> {
  repository: &'a Repository,
  recursive: bool,
  show_trees: bool,
  trees_only: bool,
  terminator: u8,
  shown: Shown,
  format: Option<Result<Vec<Piece>, GitError>>,
  specs: Vec<Vec<u8>>,
}

impl Listing<'_> {
  /// Git's `show_recursive`, which `ls-tree` uses in place of its path specs
  /// to decide whether to go into a tree: with `-r`, or toward a spec below it.
  fn into(&self, base: &[u8], name: &[u8]) -> bool {
    self.recursive
      || self.specs.iter().any(|spec| {
        spec.strip_prefix(base).is_some_and(|rest| {
          rest.len() > name.len() && rest[name.len()] == b'/' && rest[..name.len()] == *name
        })
      })
  }

  /// Git's `read_tree_at` with `ls-tree`'s `show_tree_*`.
  fn walk(&self, tree: NativeId, base: &mut Vec<u8>, depth: usize, out: &mut Vec<u8>) -> GitResult<()> {
    if depth > MAX_TREE_DEPTH {
      return Err(GitError::new(
        "resource-bound-exceeded",
        "exceeded maximum allowed tree depth",
      ));
    }
    let store = &self.repository.store;
    let not_a_tree = |id: &str| GitError::new("not-found", format!("Object {id} not a tree"));
    let read = store.read_known(&tree).map_err(store_error)?;
    let entries = listing(store, &read.kind, &read.body)?.ok_or_else(|| not_a_tree(&tree.hex()))?;
    let mut all = self.specs.is_empty();
    for entry in &entries {
      if !all {
        match interest(&self.specs, base, entry) {
          Interest::AllNot => break,
          Interest::Not => continue,
          Interest::Yes => {}
          Interest::All => all = true,
        }
      }
      let into = entry.kind == "tree" && self.into(base, &entry.name);
      let show = match entry.kind {
        "blob" => !self.trees_only,
        "tree" if into => self.show_trees,
        _ => true,
      };
      if show {
        self.print(base, entry, out)?;
      }
      if into {
        let target = entry.target.ok_or_else(|| not_a_tree(&entry.shown))?;
        let length = base.len();
        base.extend_from_slice(&entry.name);
        base.push(b'/');
        self.walk(target, base, depth + 1, out)?;
        base.truncate(length);
      }
    }
    Ok(())
  }

  fn size(&self, entry: &Listed) -> GitResult<Option<u64>> {
    if entry.kind != "blob" {
      return Ok(None);
    }
    let target = entry.target.ok_or_else(|| {
      GitError::new("not-found", format!("could not get object info about '{}'", entry.shown))
    })?;
    object_size(self.repository, &target).map(Some)
  }

  fn print(&self, base: &[u8], entry: &Listed, out: &mut Vec<u8>) -> GitResult<()> {
    let path = [base, &entry.name].concat();
    // A line ends in a line feed, its path C-quoted where needed, or with
    // `-z` in a NUL, its path as it is.
    let named = |out: &mut Vec<u8>| {
      if self.terminator == b'\n' {
        out.extend_from_slice(&quoted(&path));
      } else {
        out.extend_from_slice(&path);
      }
    };
    if let Some(format) = &self.format {
      let pieces = format.as_ref().map_err(Clone::clone)?;
      for piece in pieces {
        match piece {
          Piece::Literal(bytes) => out.extend_from_slice(bytes),
          Piece::Mode => out.extend_from_slice(format!("{:06o}", entry.mode).as_bytes()),
          Piece::Type => out.extend_from_slice(entry.kind.as_bytes()),
          Piece::Name => out.extend_from_slice(entry.shown.as_bytes()),
          Piece::Size { padded } => {
            let text = self.size(entry)?.map_or_else(|| "-".to_string(), |size| size.to_string());
            let text = if *padded { format!("{text:>7}") } else { text };
            out.extend_from_slice(text.as_bytes());
          }
          // Quoted whatever the line ends in, as Git does.
          Piece::Path => out.extend_from_slice(&quoted(&path)),
        }
      }
      out.push(self.terminator);
      return Ok(());
    }
    match self.shown {
      Shown::Entries => {
        out.extend_from_slice(format!("{:06o} {} {}\t", entry.mode, entry.kind, entry.shown).as_bytes());
        named(out);
      }
      Shown::Long => {
        let size = self.size(entry)?.map_or_else(|| "-".to_string(), |size| size.to_string());
        out.extend_from_slice(
          format!("{:06o} {} {} {size:>7}\t", entry.mode, entry.kind, entry.shown).as_bytes(),
        );
        named(out);
      }
      Shown::NameOnly | Shown::NameStatus => named(out),
      Shown::ObjectOnly => out.extend_from_slice(entry.shown.as_bytes()),
    }
    out.push(self.terminator);
    Ok(())
  }
}

/// `cst ls-tree`: Git's `ls-tree`, from the top of the tree (a native
/// repository has no working tree in N1, so there is no current directory
/// within it to list from).
pub fn ls_tree(args: &[OsString], root: &Path) -> GitResult<i32> {
  let mut recursive = false;
  let mut show_trees = false;
  let mut trees_only = false;
  let mut terminator = b'\n';
  let mut shown = Shown::Entries;
  let mut format = None;
  let mut positionals: Vec<Vec<u8>> = Vec::new();
  let mut options_done = false;
  let mut rest = args.iter();
  while let Some(arg) = rest.next() {
    let arg = bytes_of(arg);
    if options_done || arg.first() != Some(&b'-') || arg == b"-" {
      positionals.push(arg);
      continue;
    }
    let mut choose = |mode: Shown| -> GitResult<()> {
      if shown != Shown::Entries && shown != mode {
        return Err(GitError::new(
          "usage-conflicting-options",
          format!(
            "options '{}' and '{}' cannot be used together",
            mode.option(),
            shown.option()
          ),
        ));
      }
      shown = mode;
      Ok(())
    };
    match arg.as_slice() {
      b"--" => options_done = true,
      b"--long" => choose(Shown::Long)?,
      b"--name-only" => choose(Shown::NameOnly)?,
      b"--name-status" => choose(Shown::NameStatus)?,
      b"--object-only" => choose(Shown::ObjectOnly)?,
      // Every path is from the top already.
      b"--full-name" | b"--full-tree" => {}
      _ if arg.starts_with(b"--format") => match value(&arg, "--format", &mut rest)? {
        Some(text) => format = Some(text),
        None => return Err(unknown_option("ls-tree", &lossy(&arg), LS_TREE_USAGE)),
      },
      _ if arg.starts_with(b"--abbrev") => {
        return Err(unsupported("cst ls-tree --abbrev, whose abbreviations Git's would not match,"));
      }
      _ if arg.starts_with(b"--") => {
        return Err(unknown_option("ls-tree", &lossy(&arg), LS_TREE_USAGE));
      }
      flags => {
        for &flag in &flags[1..] {
          match flag {
            b'd' => trees_only = true,
            b'r' => recursive = true,
            b't' => show_trees = true,
            b'z' => terminator = 0,
            b'l' => choose(Shown::Long)?,
            _ => {
              return Err(unknown_option("ls-tree", &format!("-{}", flag as char), LS_TREE_USAGE));
            }
          }
        }
      }
    }
  }
  if format.is_some() && shown != Shown::Entries {
    return Err(GitError::new(
      "usage-conflicting-options",
      "--format can't be combined with other format-altering options",
    ));
  }
  // Git prints the formats its modes are the same as by those modes, which
  // quote no path under `-z`.
  let fast: [(&[u8], Shown); 4] = [
    (b"%(objectmode) %(objecttype) %(objectname)%x09%(path)", Shown::Entries),
    (b"%(objectmode) %(objecttype) %(objectname) %(objectsize:padded)%x09%(path)", Shown::Long),
    (b"%(path)", Shown::NameOnly),
    (b"%(objectname)", Shown::ObjectOnly),
  ];
  if let Some((_, mode)) = fast.iter().find(|(text, _)| format.as_deref() == Some(*text)) {
    shown = *mode;
    format = None;
  }
  // `-d -r` shows the trees it goes into, as `-t` does.
  if trees_only && recursive {
    show_trees = true;
  }
  let Some((tree, paths)) = positionals.split_first() else {
    return Err(GitError::new(
      "usage-missing-argument",
      format!("cst ls-tree needs a tree-ish. {LS_TREE_USAGE}"),
    ));
  };
  let specs = paths.iter().map(|path| pathspec(path)).collect::<GitResult<Vec<_>>>()?;
  let repository = Repository::open(root)?;
  let id = repository.resolve(tree)?;
  let tree = repository.tree_of(id)?;
  let listing = Listing {
    repository: &repository,
    recursive,
    show_trees,
    trees_only,
    terminator,
    shown,
    format: format.map(|text| ls_tree_format(&text)),
    specs,
  };
  let mut out = Vec::new();
  let result = listing.walk(tree, &mut Vec::new(), 0, &mut out).map(|()| 0);
  finish(out, result)
}

const REV_PARSE_USAGE: &str = "Usage: cst rev-parse [--verify [-q]] [--symbolic | --symbolic-full-name | --abbrev-ref[=strict|loose]] [--all | --branches | --tags | --remotes] [<rev>...] [-- <arg>...]";

#[derive(Clone, Copy, PartialEq, Eq)]
enum Symbolic {
  No,
  AsIs,
  Full,
}

struct RevParse<'a> {
  repository: &'a Repository,
  symbolic: Symbolic,
  /// `--abbrev-ref`, and whether it is strict.
  abbrev_ref: Option<bool>,
  out: Vec<u8>,
}

impl RevParse<'_> {
  /// Git's `show_with_type`.
  fn show(&mut self, reversed: bool, text: &[u8]) {
    if reversed {
      self.out.push(b'^');
    }
    self.out.extend_from_slice(text);
    self.out.push(b'\n');
  }

  /// Git's `show_rev`: the ID, or with a symbolic option, the name.
  fn show_rev(&mut self, reversed: bool, id: &NativeId, name: Option<&[u8]>) {
    let name = name.filter(|_| self.symbolic != Symbolic::No || self.abbrev_ref.is_some());
    let Some(name) = name else {
      self.show(reversed, id.hex().as_bytes());
      return;
    };
    if self.symbolic == Symbolic::AsIs && self.abbrev_ref.is_none() {
      self.show(reversed, name);
      return;
    }
    let short: &[u8] = if name == b"@" { b"HEAD" } else { name };
    let refs = self.repository.dwim(short);
    match refs.as_slice() {
      // Not a ref: nothing, so a caller need not filter out non-refs.
      [] => {}
      [(full, _)] => {
        let full = match self.abbrev_ref {
          Some(strict) => self.repository.shorten(full, strict),
          None => full.clone(),
        };
        self.show(reversed, &full);
      }
      _ => {
        let _ = writeln!(std::io::stderr(), "cst: refname '{}' is ambiguous", lossy(name));
      }
    }
  }

  /// Git's `try_difference`: `<a>..<b>` and `<a>...<b>`, either side `HEAD`
  /// when empty. `false` when it is not a range of two revisions.
  fn difference(&mut self, arg: &[u8]) -> GitResult<bool> {
    let Some(dots) = arg.windows(2).position(|pair| pair == b"..") else {
      return Ok(false);
    };
    let symmetric = arg.get(dots + 2) == Some(&b'.');
    let start: &[u8] = if dots == 0 { b"HEAD" } else { &arg[..dots] };
    let end = &arg[dots + 2 + usize::from(symmetric)..];
    let end: &[u8] = if end.is_empty() { b"HEAD" } else { end };
    if arg.len() == 2 {
      // `..` alone is a path, the parent directory.
      return Ok(false);
    }
    let (Some(from), Some(to)) = (committish(self.repository, start)?, committish(self.repository, end)?) else {
      return Ok(false);
    };
    if symmetric {
      return Err(unsupported(format!(
        "'{}', which needs the merge bases of its two sides,",
        lossy(arg)
      )));
    }
    self.show_rev(false, &to, Some(end));
    self.show_rev(true, &from, Some(start));
    Ok(true)
  }

  /// Git's `try_parent_shorthands`: `<rev>^!`, `<rev>^@` and `<rev>^-[<n>]`.
  fn parent_shorthands(&mut self, arg: &[u8]) -> GitResult<bool> {
    let find = |marker: &[u8]| arg.windows(2).position(|pair| pair == marker);
    let (at, include_rev, include_parents, exclude) = if let Some(at) = find(b"^!") {
      if at + 2 != arg.len() {
        return Ok(false);
      }
      (at, true, false, 0)
    } else if let Some(at) = find(b"^@") {
      if at + 2 != arg.len() {
        return Ok(false);
      }
      (at, false, true, 0)
    } else if let Some(at) = find(b"^-") {
      let number = &arg[at + 2..];
      // Git's `strtoul`, which must read all of it, and not 0.
      let exclude = if number.is_empty() {
        1
      } else {
        match std::str::from_utf8(number)
          .ok()
          .map(|text| text.strip_prefix('+').unwrap_or(text))
          .filter(|text| text.bytes().all(|byte| byte.is_ascii_digit()))
          .and_then(|text| text.parse::<usize>().ok())
        {
          Some(number) if number > 0 => number,
          _ => return Ok(false),
        }
      };
      (at, true, false, exclude)
    } else {
      return Ok(false);
    };
    let name = &arg[..at];
    let Some(id) = committish(self.repository, name)? else {
      return Ok(false);
    };
    let Some(commit) = self.repository.commit_of(id)? else {
      return Ok(false);
    };
    let parents = self.repository.parents(&commit)?;
    if exclude > parents.len() {
      return Ok(false);
    }
    if include_rev {
      self.show_rev(false, &id, Some(name));
    }
    for (number, parent) in parents.iter().enumerate() {
      let number = number + 1;
      if exclude != 0 && number != exclude {
        continue;
      }
      let shown = (self.symbolic != Symbolic::No).then(|| [name, format!("^{number}").as_bytes()].concat());
      self.show_rev(!include_parents, parent, shown.as_deref());
    }
    Ok(true)
  }

  /// `--all` and its kinds: every ref whose name begins with `prefix`. Git
  /// names each by the rest of its name, so `--tags` names `v1` where `--all`
  /// names `refs/tags/v1`.
  fn refs(&mut self, prefix: &[u8], strip: bool) {
    let listed: Vec<(Vec<u8>, NativeId)> = self
      .repository
      .snapshot
      .refs
      .iter()
      .filter(|entry| entry.name.starts_with(prefix))
      .filter_map(|entry| {
        let (_, id) = self.repository.resolve_ref(&entry.name)?;
        let name = if strip { &entry.name[prefix.len()..] } else { &entry.name[..] };
        Some((name.to_vec(), id))
      })
      .collect();
    for (name, id) in listed {
      self.show_rev(false, &id, Some(&name));
    }
  }
}

/// `cst rev-parse`: Git's, for the revisions of a native repository.
pub fn rev_parse(args: &[OsString], root: &Path) -> GitResult<i32> {
  let repository = Repository::open(root)?;
  let mut parse = RevParse {
    repository: &repository,
    symbolic: Symbolic::No,
    abbrev_ref: None,
    out: Vec::new(),
  };
  let result = rev_parse_into(&mut parse, args);
  finish(std::mem::take(&mut parse.out), result)
}

fn rev_parse_into(parse: &mut RevParse, args: &[OsString]) -> GitResult<i32> {
  let mut verify = false;
  let mut quiet = false;
  let mut as_is = false;
  let mut options_done = false;
  let mut verified: Vec<(bool, NativeId, Vec<u8>)> = Vec::new();
  // Git looks ahead for `--`: before it, what names no revision is an error,
  // not a path.
  let dashdash = args.iter().any(|arg| arg == "--");
  let no_single = |quiet: bool| -> GitResult<i32> {
    if quiet {
      return Ok(1);
    }
    Err(GitError::new("revision-not-resolved", "Needed a single revision"))
  };
  for arg in args {
    let arg = bytes_of(arg);
    if as_is {
      parse.show(false, &arg);
      continue;
    }
    if arg == b"--" {
      as_is = true;
      parse.show(false, &arg);
      continue;
    }
    if !options_done && arg.first() == Some(&b'-') {
      match arg.as_slice() {
        b"--end-of-options" => {
          options_done = true;
          parse.show(false, &arg);
        }
        b"--verify" => verify = true,
        b"-q" | b"--quiet" => quiet = true,
        b"--symbolic" => parse.symbolic = Symbolic::AsIs,
        b"--symbolic-full-name" => parse.symbolic = Symbolic::Full,
        b"--abbrev-ref" | b"--abbrev-ref=strict" => parse.abbrev_ref = Some(true),
        b"--abbrev-ref=loose" => parse.abbrev_ref = Some(false),
        b"--all" => parse.refs(b"refs/", false),
        b"--branches" => parse.refs(b"refs/heads/", true),
        b"--tags" => parse.refs(b"refs/tags/", true),
        b"--remotes" => parse.refs(b"refs/remotes/", true),
        _ if arg.starts_with(b"--abbrev-ref=") => {
          return Err(GitError::new(
            "usage-invalid-option-value",
            format!("unknown mode for --abbrev-ref: {}", lossy(&arg[13..])),
          ));
        }
        _ => {
          return Err(
            unsupported(format!("cst rev-parse {}", lossy(&arg))).details(REV_PARSE_USAGE),
          );
        }
      }
      continue;
    }
    if parse.difference(&arg)? || parse.parent_shorthands(&arg)? {
      continue;
    }
    let (reversed, name) = match arg.strip_prefix(b"^") {
      Some(name) => (true, name),
      None => (false, arg.as_slice()),
    };
    match parse.repository.resolve(name) {
      Ok(id) if verify => verified.push((reversed, id, name.to_vec())),
      Ok(id) => parse.show_rev(reversed, &id, Some(name)),
      Err(error) if matches!(error.code, "not-found" | "ambiguous-match") => {
        if verify {
          return no_single(quiet);
        }
        if dashdash {
          return Err(GitError::new(
            "revision-not-resolved",
            format!("bad revision '{}'", lossy(&arg)),
          ));
        }
        // Git takes it for a path, prints it, then finds no such path.
        parse.show(false, &arg);
        let message = if name.contains(&b':') || error.code == "ambiguous-match" {
          error.message
        } else {
          format!(
            "ambiguous argument '{}': unknown revision or path not in the working tree.",
            lossy(&arg)
          )
        };
        let code = if error.code == "ambiguous-match" { error.code } else { "revision-not-resolved" };
        return Err(GitError::new(code, message));
      }
      Err(error) => return Err(error),
    }
  }
  if verify {
    let [(reversed, id, name)] = verified.as_slice() else {
      return no_single(quiet);
    };
    parse.show_rev(*reversed, id, Some(name));
  }
  Ok(0)
}

const FOR_EACH_REF_USAGE: &str =
  "Usage: cst for-each-ref [--format=<format>] [--sort=[-]refname] [--count=<n>] [<pattern>...]";

/// How a ref name is shown: `:short`, `:lstrip=<n>` (or `:strip`) and
/// `:rstrip=<n>`.
#[derive(Clone, Copy)]
enum Strip {
  Whole,
  Short,
  Left(i64),
  Right(i64),
}

#[derive(Clone, Copy)]
enum Field {
  RefName(Strip),
  SymRef(Strip),
  Head,
  /// Fields of the object, and with `*` of the object a tag peels to.
  ObjectName(bool),
  ObjectType(bool),
  ObjectSize(bool),
  Tree(bool),
  Parent(bool),
  NumParent(bool),
  Object(bool),
}

enum Part {
  Literal(Vec<u8>),
  Field(Field),
}

fn ref_format(format: &[u8]) -> GitResult<Vec<Part>> {
  let mut parts = Vec::new();
  let mut literal = Vec::new();
  let mut at = 0;
  while at < format.len() {
    // Git's `append_literal`: `%%` is `%`, `%<two hex digits>` a byte, and any
    // other `%` itself.
    if format[at] == b'%' {
      match format.get(at + 1) {
        Some(b'(') => {
          let Some(end) = format[at..].iter().position(|&byte| byte == b')') else {
            return Err(GitError::new(
              "usage-invalid-option-value",
              format!("malformed format string {}", lossy(&format[at..])),
            ));
          };
          parts.push(Part::Literal(std::mem::take(&mut literal)));
          parts.push(Part::Field(field(&format[at + 2..at + end])?));
          at += end + 1;
          continue;
        }
        Some(b'%') => {
          literal.push(b'%');
          at += 2;
          continue;
        }
        _ => {
          if let (Some(&high), Some(&low)) = (format.get(at + 1), format.get(at + 2))
            && let Some(byte) = hex_pair(high, low)
          {
            literal.push(byte);
            at += 3;
            continue;
          }
        }
      }
    }
    literal.push(format[at]);
    at += 1;
  }
  parts.push(Part::Literal(literal));
  Ok(parts)
}

fn field(atom: &[u8]) -> GitResult<Field> {
  let text = lossy(atom);
  let (deref, name) = match text.strip_prefix('*') {
    Some(name) => (true, name),
    None => (false, text.as_str()),
  };
  let (name, argument) = match name.split_once(':') {
    Some((name, argument)) => (name, Some(argument)),
    None => (name, None),
  };
  let refused = |what: &str| unsupported(format!("The field %({what}) of cst for-each-ref"));
  let unrecognized = || {
    GitError::new(
      "usage-invalid-option-value",
      format!("unrecognized %({name}) argument: {}", argument.unwrap_or_default()),
    )
  };
  let strip = |argument: Option<&str>| -> GitResult<Strip> {
    let integer = |value: &str, option: &str| {
      value.parse::<i64>().map_err(|_| {
        GitError::new(
          "usage-invalid-option-value",
          format!("Integer value expected refname:{option}={value}"),
        )
      })
    };
    Ok(match argument {
      None => Strip::Whole,
      Some("short") => Strip::Short,
      Some(argument) => {
        if let Some(value) = argument.strip_prefix("lstrip=") {
          Strip::Left(integer(value, "lstrip")?)
        } else if let Some(value) = argument.strip_prefix("strip=") {
          Strip::Left(integer(value, "strip")?)
        } else if let Some(value) = argument.strip_prefix("rstrip=") {
          Strip::Right(integer(value, "rstrip")?)
        } else {
          return Err(unrecognized());
        }
      }
    })
  };
  let plain = |field: Field| -> GitResult<Field> {
    match argument {
      None => Ok(field),
      Some(_) => Err(refused(&text)),
    }
  };
  match name {
    "refname" | "symref" | "HEAD" if deref => Err(refused(&text)),
    "refname" => Ok(Field::RefName(strip(argument)?)),
    "symref" => Ok(Field::SymRef(strip(argument)?)),
    "HEAD" => plain(Field::Head),
    "objectname" => plain(Field::ObjectName(deref)),
    "objecttype" => plain(Field::ObjectType(deref)),
    "objectsize" => plain(Field::ObjectSize(deref)),
    "tree" => plain(Field::Tree(deref)),
    "parent" => plain(Field::Parent(deref)),
    "numparent" => plain(Field::NumParent(deref)),
    "object" => plain(Field::Object(deref)),
    "type" | "tag" | "author" | "authorname" | "authoremail" | "authordate" | "committer"
    | "committername" | "committeremail" | "committerdate" | "tagger" | "taggername"
    | "taggeremail" | "taggerdate" | "creator" | "creatordate" | "subject" | "body"
    | "contents" | "trailers" | "signature" | "upstream" | "push" | "worktreepath"
    | "deltabase" | "describe" | "raw" | "if" | "then" | "else" | "end" | "align" | "rest"
    | "ahead-behind" | "is-base" => Err(refused(&text)),
    _ => Err(GitError::new(
      "usage-invalid-option-value",
      format!("unknown field name: {text}"),
    )),
  }
}

/// Git's `lstrip_ref_components`: drops the first `count` components, or
/// with a negative `count`, keeps the last `-count`.
fn left_strip(name: &[u8], count: i64) -> Vec<u8> {
  let slashes = name.iter().filter(|&&byte| byte == b'/').count() as i64;
  let mut remaining = if count < 0 { slashes + count + 1 } else { count };
  let mut at = 0;
  while remaining > 0 {
    match name.get(at) {
      None => return Vec::new(),
      Some(b'/') => remaining -= 1,
      Some(_) => {}
    }
    at += 1;
  }
  name[at..].to_vec()
}

/// Git's `rstrip_ref_components`.
fn right_strip(name: &[u8], count: i64) -> Vec<u8> {
  let slashes = name.iter().filter(|&&byte| byte == b'/').count() as i64;
  let mut remaining = if count < 0 { slashes + count + 1 } else { count };
  let mut name = name.to_vec();
  while remaining > 0 {
    remaining -= 1;
    match name.iter().rposition(|&byte| byte == b'/') {
      Some(at) => name.truncate(at),
      None => return Vec::new(),
    }
  }
  name
}

/// A ref `for-each-ref` lists.
struct RefRow {
  name: Vec<u8>,
  /// The ref a symbolic ref ends at.
  symref: Option<Vec<u8>>,
  id: NativeId,
}

fn stripped(repository: &Repository, name: &[u8], strip: Strip) -> Vec<u8> {
  match strip {
    Strip::Whole => name.to_vec(),
    // `warn_ambiguous_refs`, on by default, makes it strict.
    Strip::Short => repository.shorten(name, true),
    Strip::Left(count) => left_strip(name, count),
    Strip::Right(count) => right_strip(name, count),
  }
}

fn expand(
  repository: &Repository,
  head: Option<&[u8]>,
  listed: &RefRow,
  field: Field,
  out: &mut Vec<u8>,
) -> GitResult<()> {
  let object_field = |deref: bool| -> GitResult<Option<(NativeId, Object)>> {
    let kind = repository.object(&listed.id)?;
    let Some(kind) = kind else {
      return Err(corrupt(format!("the ref {} names {}, which the store does not hold", lossy(&listed.name), listed.id)));
    };
    if !deref {
      return Ok(Some((listed.id, kind)));
    }
    if kind != Object::Tag {
      return Ok(None);
    }
    Ok(match repository.deref_tags(listed.id)? {
      (id, Some(kind)) => Some((id, kind)),
      (_, None) => None,
    })
  };
  let text: Vec<u8> = match field {
    Field::RefName(strip) => stripped(repository, &listed.name, strip),
    Field::SymRef(strip) => match &listed.symref {
      Some(target) => stripped(repository, target, strip),
      None => Vec::new(),
    },
    Field::Head => {
      if head == Some(listed.name.as_slice()) {
        b"*".to_vec()
      } else {
        b" ".to_vec()
      }
    }
    Field::ObjectName(deref) => object_field(deref)?.map(|(id, _)| id.hex().into_bytes()).unwrap_or_default(),
    Field::ObjectType(deref) => object_field(deref)?
      .map(|(_, kind)| kind.name().as_bytes().to_vec())
      .unwrap_or_default(),
    Field::ObjectSize(deref) => match object_field(deref)? {
      Some((id, _)) => object_size(repository, &id)?.to_string().into_bytes(),
      None => Vec::new(),
    },
    Field::Tree(deref) => match object_field(deref)? {
      Some((id, Object::Commit)) => repository.tree_of(id)?.hex().into_bytes(),
      _ => Vec::new(),
    },
    Field::Parent(deref) => match object_field(deref)? {
      Some((id, Object::Commit)) => repository
        .parents(&id)?
        .iter()
        .map(NativeId::hex)
        .collect::<Vec<_>>()
        .join(" ")
        .into_bytes(),
      _ => Vec::new(),
    },
    Field::NumParent(deref) => match object_field(deref)? {
      Some((id, Object::Commit)) => repository.parents(&id)?.len().to_string().into_bytes(),
      _ => Vec::new(),
    },
    Field::Object(deref) => match object_field(deref)? {
      Some((id, Object::Tag)) => repository.tagged(&id)?.hex().into_bytes(),
      _ => Vec::new(),
    },
  };
  out.extend_from_slice(&text);
  Ok(())
}

/// `cst for-each-ref`: Git's, over the ref snapshot.
pub fn for_each_ref(args: &[OsString], root: &Path) -> GitResult<i32> {
  let mut format: Vec<u8> = b"%(objectname) %(objecttype)\t%(refname)".to_vec();
  let mut descending = false;
  let mut count: Option<usize> = None;
  let mut patterns: Vec<Vec<u8>> = Vec::new();
  let mut options_done = false;
  let mut rest = args.iter();
  while let Some(arg) = rest.next() {
    let arg = bytes_of(arg);
    if options_done || arg.first() != Some(&b'-') {
      patterns.push(arg);
      continue;
    }
    if arg == b"--" {
      options_done = true;
    } else if arg.starts_with(b"--format") {
      format = value(&arg, "--format", &mut rest)?
        .ok_or_else(|| unknown_option("for-each-ref", &lossy(&arg), FOR_EACH_REF_USAGE))?;
    } else if arg.starts_with(b"--sort") {
      let key = value(&arg, "--sort", &mut rest)?
        .ok_or_else(|| unknown_option("for-each-ref", &lossy(&arg), FOR_EACH_REF_USAGE))?;
      descending = match key.as_slice() {
        b"refname" => false,
        b"-refname" => true,
        other => {
          return Err(unsupported(format!("cst for-each-ref --sort={}", lossy(other))));
        }
      };
    } else if arg.starts_with(b"--count") {
      let text = value(&arg, "--count", &mut rest)?
        .ok_or_else(|| unknown_option("for-each-ref", &lossy(&arg), FOR_EACH_REF_USAGE))?;
      let number = std::str::from_utf8(&text)
        .ok()
        .and_then(|text| text.parse::<i64>().ok())
        .ok_or_else(|| {
          GitError::new(
            "usage-invalid-option-value",
            format!("option `count' expects a numerical value, not {}", lossy(&text)),
          )
        })?;
      if number < 0 {
        return Err(GitError::new(
          "usage-invalid-option-value",
          format!("invalid --count argument: `{number}'"),
        ));
      }
      count = (number > 0).then_some(number as usize);
    } else {
      return Err(unsupported(format!("cst for-each-ref {}", lossy(&arg))));
    }
  }
  let parts = ref_format(&format)?;
  let repository = Repository::open(root)?;
  let head = repository.resolve_ref(b"HEAD").map(|(name, _)| name);
  let mut listed: Vec<RefRow> = repository
    .snapshot
    .refs
    .iter()
    .filter(|entry| entry.name.starts_with(b"refs/"))
    .filter(|entry| patterns.is_empty() || patterns.iter().any(|pattern| matches_ref(pattern, &entry.name)))
    .filter_map(|entry| {
      let (end, id) = repository.resolve_ref(&entry.name)?;
      let symbolic = matches!(entry.target, causet_store::objects::RefTarget::Symbolic(_));
      Some(RefRow {
        name: entry.name.clone(),
        symref: symbolic.then_some(end),
        id,
      })
    })
    .collect();
  if descending {
    listed.reverse();
  }
  if let Some(count) = count {
    listed.truncate(count);
  }
  let mut out = Vec::new();
  let result = (|| {
    for entry in &listed {
      for part in &parts {
        match part {
          Part::Literal(bytes) => out.extend_from_slice(bytes),
          Part::Field(field) => expand(&repository, head.as_deref(), entry, *field, &mut out)?,
        }
      }
      out.push(b'\n');
    }
    Ok(0)
  })();
  finish(out, result)
}

/// Git's `match_name_as_path`: a pattern matches a ref it is a prefix of up
/// to a `/`, or that it matches as a glob in which `*` stops at `/`.
fn matches_ref(pattern: &[u8], name: &[u8]) -> bool {
  if let Some(rest) = name.strip_prefix(pattern)
    && (rest.is_empty() || rest[0] == b'/' || pattern.ends_with(b"/"))
  {
    return true;
  }
  wildmatch(pattern, name) == Wild::Match
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Wild {
  Match,
  NoMatch,
  AbortAll,
  AbortToStarStar,
}

/// Git's `wildmatch` with `WM_PATHNAME`: `*` and `?` stop at `/`, `**`
/// between slashes crosses them, and `[...]` takes ranges, `!` and the
/// POSIX classes.
fn wildmatch(pattern: &[u8], text: &[u8]) -> Wild {
  let special = |byte: u8| matches!(byte, b'*' | b'?' | b'[' | b'\\');
  let at = |bytes: &[u8], index: usize| bytes.get(index).copied().unwrap_or(0);
  let (mut p, mut t) = (0usize, 0usize);
  while p < pattern.len() {
    let mut p_ch = pattern[p];
    let t_ch = at(text, t);
    if t_ch == 0 && p_ch != b'*' {
      return Wild::AbortAll;
    }
    match p_ch {
      b'?' => {
        if t_ch == b'/' {
          return Wild::NoMatch;
        }
      }
      b'*' => {
        p += 1;
        let match_slash;
        if at(pattern, p) == b'*' {
          let before = p.checked_sub(2);
          while at(pattern, p) == b'*' {
            p += 1;
          }
          if before.is_none_or(|before| pattern[before] == b'/')
            && (p == pattern.len()
              || pattern[p] == b'/'
              || (pattern[p] == b'\\' && at(pattern, p + 1) == b'/'))
          {
            if at(pattern, p) == b'/' && wildmatch(&pattern[p + 1..], &text[t..]) == Wild::Match {
              return Wild::Match;
            }
            match_slash = true;
          } else {
            match_slash = false;
          }
        } else {
          match_slash = false;
        }
        if p == pattern.len() {
          if !match_slash && text[t..].contains(&b'/') {
            return Wild::NoMatch;
          }
          return Wild::Match;
        }
        if !match_slash && pattern[p] == b'/' {
          // One `*` and a `/`: the rest of this component.
          match text[t..].iter().position(|&byte| byte == b'/') {
            Some(slash) => {
              t += slash;
              // The loop's step consumes the slash with the pattern's.
              p += 1;
              t += 1;
              continue;
            }
            None => return Wild::NoMatch,
          }
        }
        let mut t_ch = t_ch;
        loop {
          if t_ch == 0 {
            break;
          }
          if !special(pattern[p]) {
            let literal = pattern[p];
            loop {
              t_ch = at(text, t);
              if t_ch == 0 || (!match_slash && t_ch == b'/') || t_ch == literal {
                break;
              }
              t += 1;
            }
            if t_ch != literal {
              if match_slash {
                return Wild::AbortAll;
              }
              // Stopped at a `/`: an enclosing `**` may still go on.
              return Wild::AbortToStarStar;
            }
          }
          let matched = wildmatch(&pattern[p..], &text[t..]);
          if matched != Wild::NoMatch {
            if !match_slash || matched != Wild::AbortToStarStar {
              return matched;
            }
          } else if !match_slash && t_ch == b'/' {
            return Wild::AbortToStarStar;
          }
          t += 1;
          t_ch = at(text, t);
        }
        return Wild::AbortAll;
      }
      b'[' => {
        p += 1;
        p_ch = at(pattern, p);
        let negated = p_ch == b'!' || p_ch == b'^';
        if negated {
          p += 1;
          p_ch = at(pattern, p);
        }
        let mut previous = 0u8;
        let mut matched = false;
        loop {
          if p_ch == 0 {
            return Wild::AbortAll;
          }
          if p_ch == b'\\' {
            p += 1;
            p_ch = at(pattern, p);
            if p_ch == 0 {
              return Wild::AbortAll;
            }
            if t_ch == p_ch {
              matched = true;
            }
          } else if p_ch == b'-' && previous != 0 && at(pattern, p + 1) != 0 && at(pattern, p + 1) != b']' {
            p += 1;
            p_ch = at(pattern, p);
            if p_ch == b'\\' {
              p += 1;
              p_ch = at(pattern, p);
              if p_ch == 0 {
                return Wild::AbortAll;
              }
            }
            if t_ch <= p_ch && t_ch >= previous {
              matched = true;
            }
            p_ch = 0;
          } else if p_ch == b'[' && at(pattern, p + 1) == b':' {
            let start = p + 2;
            let mut end = start;
            while at(pattern, end) != 0 && at(pattern, end) != b']' {
              end += 1;
            }
            if at(pattern, end) == 0 {
              return Wild::AbortAll;
            }
            if end < start + 1 || pattern[end - 1] != b':' {
              // No `:]`: an ordinary `[`.
              p = start - 2;
              p_ch = b'[';
              if t_ch == p_ch {
                matched = true;
              }
            } else {
              let class = &pattern[start..end - 1];
              let member = match class {
                b"alnum" => t_ch.is_ascii_alphanumeric(),
                b"alpha" => t_ch.is_ascii_alphabetic(),
                b"blank" => t_ch == b' ' || t_ch == b'\t',
                b"cntrl" => t_ch.is_ascii_control(),
                b"digit" => t_ch.is_ascii_digit(),
                b"graph" => t_ch.is_ascii_graphic(),
                b"lower" => t_ch.is_ascii_lowercase(),
                b"print" => t_ch.is_ascii_graphic() || t_ch == b' ',
                b"punct" => t_ch.is_ascii_punctuation(),
                b"space" => t_ch.is_ascii_whitespace() || t_ch == 0x0b,
                b"upper" => t_ch.is_ascii_uppercase(),
                b"xdigit" => t_ch.is_ascii_hexdigit(),
                _ => return Wild::AbortAll,
              };
              if member {
                matched = true;
              }
              p = end;
              p_ch = 0;
            }
          } else if t_ch == p_ch {
            matched = true;
          }
          previous = p_ch;
          p += 1;
          p_ch = at(pattern, p);
          if p_ch == b']' {
            break;
          }
        }
        if matched == negated || t_ch == b'/' {
          return Wild::NoMatch;
        }
      }
      _ => {
        if p_ch == b'\\' {
          p += 1;
          p_ch = at(pattern, p);
        }
        if t_ch != p_ch {
          return Wild::NoMatch;
        }
      }
    }
    p += 1;
    t += 1;
  }
  if t < text.len() { Wild::NoMatch } else { Wild::Match }
}

/// `cst fsck`: the store's verification (objects.md §8, storage.md §4).
pub fn fsck(args: &[OsString], root: &Path) -> GitResult<i32> {
  if let Some(arg) = args.first() {
    return Err(unsupported(format!("cst fsck {}", arg.to_string_lossy())));
  }
  let store = Store::open(root).map_err(store_error)?;
  let found = verify::verify(&store).map_err(store_error)?;
  let mut out = Vec::new();
  for id in &found.absent_by_promise {
    writeln!(out, "absent by promise: {id}").expect("in memory");
  }
  for id in &found.absent_by_policy {
    writeln!(out, "absent by policy: {id}").expect("in memory");
  }
  if !found.problems.is_empty() {
    const SHOWN: usize = 20;
    let mut details: Vec<String> = found
      .problems
      .iter()
      .take(SHOWN)
      .map(|problem| format!("  {problem}"))
      .collect();
    if found.problems.len() > SHOWN {
      details.push(format!("  and {} more", found.problems.len() - SHOWN));
    }
    let problems = found.problems.len();
    return finish(
      out,
      Err(
        corrupt(format!(
          "verification found {problems} {} (objects.md §8, storage.md §4):",
          if problems == 1 { "problem" } else { "problems" }
        ))
        .details(details.join("\n")),
      ),
    );
  }
  let absent = found.absent_by_promise.len() + found.absent_by_policy.len();
  writeln!(
    out,
    "Verified {}: {} in {}, each present copy checked. {} present, {} absent by promise, {} absent by policy.",
    root.display(),
    count(found.objects, "object"),
    count(found.containers, "container"),
    found.objects - absent,
    found.absent_by_promise.len(),
    found.absent_by_policy.len()
  )
  .expect("in memory");
  finish(out, Ok(0))
}

fn count(number: usize, noun: &str) -> String {
  format!("{number} {noun}{}", if number == 1 { "" } else { "s" })
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn globs_match_as_gits_wildmatch_with_pathname_matches() {
    let cases: &[(&str, &str, bool)] = &[
      ("refs/heads/*", "refs/heads/main", true),
      ("refs/heads/*", "refs/heads/a/b", false),
      ("refs/*/main", "refs/heads/main", true),
      ("refs/**/main", "refs/heads/x/main", true),
      ("refs/**/main", "refs/main", true),
      ("refs/**", "refs/a/b/c", true),
      ("refs/t*", "refs/tags/v1", false),
      ("refs/tags/v?", "refs/tags/v1", true),
      ("refs/tags/v[0-9]", "refs/tags/v7", true),
      ("refs/tags/v[!0-9]", "refs/tags/v7", false),
      ("refs/tags/v[[:digit:]]", "refs/tags/v3", true),
      ("refs/tags/\\*", "refs/tags/*", true),
      ("refs/tags/*1", "refs/tags/v1", true),
      ("refs/tags/*x", "refs/tags/v1", false),
      ("*", "refs", true),
      ("*", "refs/heads", false),
    ];
    for (pattern, text, expected) in cases {
      assert_eq!(
        wildmatch(pattern.as_bytes(), text.as_bytes()) == Wild::Match,
        *expected,
        "{pattern} {text}"
      );
    }
  }

  #[test]
  fn ref_names_strip_as_git_strips_them() {
    let name = b"refs/heads/topic/x";
    assert_eq!(left_strip(name, 2), b"topic/x");
    assert_eq!(left_strip(name, -1), b"x");
    assert_eq!(left_strip(name, 9), b"");
    assert_eq!(right_strip(name, 1), b"refs/heads/topic");
    assert_eq!(right_strip(name, -1), b"refs");
    assert_eq!(right_strip(name, 9), b"");
  }

  #[test]
  fn path_specs_normalize_as_gits_do() {
    for (arg, spec) in [
      ("a", "a"),
      ("./a", "a"),
      ("a//b", "a/b"),
      ("a/.", "a/"),
      ("a/b/..", "a/"),
      ("a/..", ""),
      ("./", ""),
      (".", ""),
      ("a/b/f/x/..", "a/b/f/"),
    ] {
      assert_eq!(pathspec(arg.as_bytes()).unwrap(), spec.as_bytes(), "{arg}");
    }
    assert!(pathspec(b"..").is_err());
    assert!(pathspec(b"").is_err());
  }
}
