//! A native repository's commands (N1: ADR-0045 decision 11, ADR-0046
//! decision 9). They are experimental and not contracts, behind the opt-in
//! `CAUSET_EXPERIMENTAL=native` (ADR-0042 decision 5). `cst import` copies a
//! Git repository's objects and refs into a new native repository, or adds
//! what is new to an existing one, and
//! `cst import --verify` checks that each rebuilds to its Git ID; in one,
//! `cst cat-file` prints an object without running Git, the inspection
//! commands of `native_inspection` list and verify it, and every other
//! command is refused, because a native repository has no Git to pass it to
//! (ADR-0046 decision 4).

use crate::environment;
use crate::native::report;
use crate::native_inspection;
use crate::native_log;
use crate::native_revision::Repository;
use causet_engine::errors::{GitError, GitResult};
use causet_import::store_error;
use causet_store::id::{GitAlgorithm, NativeId, Type, hex};
use causet_store::objects::{GitKind, Kind, Preserved, Target, Tree, git_mode, parse_git_tree};
use causet_store::StoreError;
use causet_store::reconstruct;
use causet_store::store::Store;
use std::ffi::OsString;
use std::io::Write as _;
use std::path::{Path, PathBuf};

/// The opt-in, as a user sets it.
pub const OPT_IN: &str = "CAUSET_EXPERIMENTAL=native";

const IMPORT_USAGE: &str =
  "Usage: cst import <git-repo> <dest>, or cst import --verify [<native-repo>]";

const HELP: &str = "causet — a native repository (experimental, not a contract)

This directory holds a native store, made by cst import. Its commands are
experimental: they need CAUSET_EXPERIMENTAL=native, and their format and
output may change without notice (ADR-0042).

Usage:
  cst cat-file (-p | -t | -s) <object>      print an object, its type or its size
  cst cat-file (--batch | --batch-check) [--buffer]
                                            answer each object named on standard
                                            input, in Git's formats
  cst ls-tree [-d] [-r] [-t] [-z] [-l | --name-only | --object-only
              | --format=<format>] <tree-ish> [<path>...]
                                            list a tree, as git ls-tree does
  cst rev-parse [--verify [-q]] [--symbolic-full-name | --abbrev-ref]
                [--all | --branches | --tags | --remotes] [<rev>...]
                                            name objects, as git rev-parse does
  cst for-each-ref [--format=<format>] [--sort=[-]refname] [--count=<n>]
                   [<pattern>...]           list the refs of the snapshot
  cst log [<revision>] --format=<format>    a revision's history, as git log
                                            --format prints it: %H %h %T %t
                                            %P %p %an %ae %ad %cn %ce %cd %s
                                            %b %n %%
  cst fsck                                  verify the store: every copy of
                                            every object, and absent content
  cst import --verify [<native-repo>]       check that every imported object
                                            rebuilds to its Git ID, without Git
  cst import <git-repo> <dest>              make another native repository, or
                                            add a Git repository's new history
                                            to the native repository <dest>
  cst version

An <object>, <tree-ish> or <rev> is a ref, HEAD, a native ID or a unique
prefix of one, with Git's ~<n>, ^<n>, ^{<type>} and :<path>.

A native repository runs no Git, so every other command is refused here.";

/// What kind of repository a directory is in (ADR-0042 decision 1): the
/// nearest directory, upward, with `.cst/format` or `.git` decides.
enum RepositoryKind {
  Native(PathBuf),
  Ambiguous(PathBuf),
  Other,
}

fn kind_of(directory: &Path) -> RepositoryKind {
  for candidate in directory.ancestors() {
    let native = candidate.join(".cst").join("format").is_file();
    let git = candidate.join(".git").exists();
    match (native, git) {
      (true, true) => return RepositoryKind::Ambiguous(candidate.to_path_buf()),
      (true, false) => return RepositoryKind::Native(candidate.to_path_buf()),
      (false, true) => return RepositoryKind::Other,
      _ => {}
    }
  }
  RepositoryKind::Other
}

fn ambiguous(root: &Path) -> GitError {
  GitError::new(
    "unsupported-repository-shape",
    format!(
      "{} holds both .cst and .git, so it is neither kind of repository: every repository is one kind (ADR-0042, decision 1).",
      root.display()
    ),
  )
}

fn enabled() -> bool {
  matches!(environment::value("EXPERIMENTAL"), Ok(Some(value)) if value == "native")
}

fn opt_in_required(command: &str) -> GitError {
  GitError::new(
    "precondition-not-met",
    format!(
      "cst {command} is experimental and not a contract: set {OPT_IN} to use it (ADR-0042, decision 5). Its format may change without notice."
    ),
  )
}

fn answer(result: GitResult<i32>) -> i32 {
  match result {
    Ok(status) => status,
    Err(error) => report(&error, false),
  }
}

/// The exit status when this invocation is `cst import` or is in a native
/// repository; `None` leaves it to the rest of `cst`, unchanged.
pub fn intercept(words: &[String], raw: &[OsString]) -> Option<i32> {
  let first = words.first()?.as_str();
  if first == "import" {
    return Some(answer(import(&words[1..]).map(|()| 0)));
  }
  if std::env::var_os("GIT_DIR").is_some() {
    return None;
  }
  let directory = std::env::current_dir().ok()?;
  let help = matches!(first, "help" | "--help" | "-h");
  let version = matches!(first, "version" | "--version" | "-V");
  match kind_of(&directory) {
    RepositoryKind::Other => None,
    RepositoryKind::Ambiguous(_) if help || version => None,
    RepositoryKind::Ambiguous(root) => Some(report(&ambiguous(&root), false)),
    RepositoryKind::Native(_) if version => None,
    RepositoryKind::Native(_) if help => {
      let _ = writeln!(std::io::stdout().lock(), "{HELP}");
      Some(0)
    }
    RepositoryKind::Native(root) => Some(answer(native_command(first, &raw[1..], &root))),
  }
}

fn native_command(command: &str, args: &[OsString], root: &Path) -> GitResult<i32> {
  if !enabled() {
    return Err(opt_in_required(command));
  }
  match command {
    "cat-file" => cat_file(args, root).map(|()| 0),
    "ls-tree" => native_inspection::ls_tree(args, root),
    "rev-parse" => native_inspection::rev_parse(args, root),
    "for-each-ref" => native_inspection::for_each_ref(args, root),
    "fsck" => native_inspection::fsck(args, root),
    "log" => native_log::log(args, root),
    "git" => Err(GitError::new(
      "unavailable-in-native-repository",
      "A native repository has no Git to run, so cst git is refused here (ADR-0046, decision 4).",
    )),
    _ => Err(GitError::new(
      "unavailable-in-native-repository",
      format!(
        "cst {command} is not implemented in a native repository yet, and a native repository has no Git to pass it to. Run cst --help for the commands it has."
      ),
    )),
  }
}

fn import(args: &[String]) -> GitResult<()> {
  if !enabled() {
    return Err(opt_in_required("import"));
  }
  let verifying = args.iter().any(|arg| arg == "--verify");
  let positionals: Vec<&String> = args.iter().filter(|arg| !arg.starts_with('-')).collect();
  if let Some(option) = args
    .iter()
    .find(|arg| arg.starts_with('-') && *arg != "--verify")
  {
    return Err(GitError::new(
      "usage-unknown-option",
      format!("Unknown option '{option}' for 'cst import'. {IMPORT_USAGE}"),
    ));
  }
  if verifying {
    return verify(&positionals);
  }
  let [source, destination] = positionals.as_slice() else {
    return Err(GitError::new(
      "usage-missing-argument",
      format!("cst import takes a Git repository and a destination. {IMPORT_USAGE}"),
    ));
  };
  let root = Path::new(destination.as_str());
  if root.join(".cst").join("format").is_file() && root.join(".git").exists() {
    return Err(ambiguous(root));
  }
  let started = std::time::Instant::now();
  let imported = causet_import::import(source, root)?;
  if let Some(file) = causet_engine::environment::test_hook("CAUSET_TEST_IMPORT_REPORT") {
    write_cost(&file, started.elapsed(), &imported.cost)?;
  }
  let mut out = std::io::stdout().lock();
  let preserved = if imported.preserved_trees > 0 {
    format!(", {} kept in Git's encoding", imported.preserved_trees)
  } else {
    String::new()
  };
  let counts = format!(
    "{}, {}{preserved}, {}, {}",
    count(imported.blobs, "blob"),
    count(imported.trees + imported.preserved_trees, "tree"),
    count(imported.commits, "commit"),
    count(imported.tags, "tag"),
  );
  let _ = if imported.added {
    writeln!(
      out,
      "Imported {source} into {destination}, adding {counts} to what it held, from a {} repository.",
      imported.algorithm
    )
  } else {
    writeln!(
      out,
      "Imported {source} into {destination}: {counts}, from a {} repository.",
      imported.algorithm
    )
  };
  let head = match imported.head {
    Some(id) => format!("HEAD is at {id}."),
    None => "HEAD is unborn.".into(),
  };
  let _ = writeln!(
    out,
    "Its ref snapshot records {}, {} symbolic. {head}",
    count(imported.refs, "ref"),
    imported.symbolic
  );
  Ok(())
}

/// What an import cost, as JSON in `file`, for the corpora's reports (#347):
/// its seconds in all; each phase's seconds and the process's peak memory as
/// it ended; the process's peak memory; and the held metadata and objects
/// files' peak sizes. Memory is `null` where the system does not tell it. The
/// `CAUSET_TEST_IMPORT_REPORT` test hook asks for it, and nothing checks it.
/// It is written before the import's summary, so a file that cannot be
/// written fails the command although the repository was imported.
fn write_cost(file: &str, elapsed: std::time::Duration, cost: &causet_import::Cost) -> GitResult<()> {
  use causet_model::json::{Object, Value, stringify};
  let bytes = |bytes: Option<u64>| bytes.map_or(Value::Null, |bytes| Value::Number(bytes as f64));
  let seconds = |took: std::time::Duration| Value::Number((took.as_secs_f64() * 1000.0).round() / 1000.0);
  let mut phases = Object::new();
  for phase in &cost.phases {
    let mut entry = Object::new();
    entry.set("seconds", seconds(phase.took));
    entry.set("peakMemory", bytes(phase.peak_memory));
    phases.set(phase.name, Value::Object(entry));
  }
  let mut report = Object::new();
  report.set("seconds", seconds(elapsed));
  report.set("phases", Value::Object(phases));
  report.set("peakMemory", bytes(causet_import::peak_memory()));
  report.set("heldMetadata", bytes(Some(cost.held_metadata)));
  report.set("heldObjects", bytes(Some(cost.held_objects)));
  std::fs::write(file, format!("{}\n", stringify(&Value::Object(report))))
    .map_err(|error| crate::envelope::io_failure(&error, "open", file))
}

/// The reconstruction check (objects.md §9.2) on the native repository
/// `named`, or the one the current directory is in. It reads only the store.
fn verify(named: &[&String]) -> GitResult<()> {
  let root = match named {
    // The repository the current directory is in, as for its other commands.
    [] => {
      let start = std::env::current_dir().map_err(|error| {
        GitError::new(
          "not-found",
          format!("cst cannot read the current directory: {error}"),
        )
      })?;
      match kind_of(&start) {
        RepositoryKind::Native(root) => root,
        RepositoryKind::Ambiguous(root) => return Err(ambiguous(&root)),
        RepositoryKind::Other => {
          return Err(GitError::new(
            "not-found",
            format!(
              "{} is not in a native repository, so there is nothing to verify. {IMPORT_USAGE}",
              start.display()
            ),
          ));
        }
      }
    }
    // A named repository is named by its root, so a mistyped path cannot
    // verify the repository around it.
    [path] => {
      let root = PathBuf::from(path.as_str());
      if path.is_empty() || !root.join(".cst").join("format").is_file() {
        return Err(GitError::new(
          "not-found",
          format!("'{path}' is not a native repository: it has no .cst/format. {IMPORT_USAGE}"),
        ));
      }
      if root.join(".git").exists() {
        return Err(ambiguous(&root));
      }
      root
    }
    _ => {
      return Err(GitError::new(
        "usage-unknown-option",
        format!("cst import --verify takes at most one native repository. {IMPORT_USAGE}"),
      ));
    }
  };
  let store = Store::open(&root).map_err(store_error)?;
  let found = reconstruct::check(&store).map_err(store_error)?;
  if !found.failures.is_empty() {
    const SHOWN: usize = 20;
    let mut details: Vec<String> = found
      .failures
      .iter()
      .take(SHOWN)
      .map(|failure| format!("  {failure}"))
      .collect();
    if found.failures.len() > SHOWN {
      details.push(format!("  and {} more", found.failures.len() - SHOWN));
    }
    return Err(
      corrupt(format!(
        "{} {} the reconstruction check (objects.md §9.2):",
        count(found.failures.len(), "object"),
        if found.failures.len() == 1 {
          "fails"
        } else {
          "fail"
        }
      ))
      .details(details.join("\n")),
    );
  }
  let rebuilt = &found.rebuilt;
  let _ = writeln!(
    std::io::stdout().lock(),
    "Verified {}: {}, {}, {} and {}, each rebuilt to its Git ID.",
    root.display(),
    count(rebuilt.blobs, "blob"),
    count(rebuilt.trees, "tree"),
    count(rebuilt.commits, "commit"),
    count(rebuilt.tags, "tag")
  );
  Ok(())
}

fn count(number: usize, noun: &str) -> String {
  format!("{number} {noun}{}", if number == 1 { "" } else { "s" })
}

#[cfg(unix)]
pub(crate) fn bytes_of(arg: &OsString) -> Vec<u8> {
  use std::os::unix::ffi::OsStrExt;
  arg.as_bytes().to_vec()
}

#[cfg(not(unix))]
pub(crate) fn bytes_of(arg: &OsString) -> Vec<u8> {
  arg.to_string_lossy().into_owned().into_bytes()
}

fn cat_file(args: &[OsString], root: &Path) -> GitResult<()> {
  let usage = "Usage: cst cat-file (-p | -t | -s) <object> | (--batch | --batch-check) [--buffer]";
  let mut mode = None;
  let mut object = None;
  let mut buffer = false;
  for arg in args {
    let text = arg.to_string_lossy();
    match text.as_ref() {
      "-p" | "-t" | "-s" | "--batch" | "--batch-check" => {
        if mode.replace(text.into_owned()).is_some() {
          return Err(GitError::new(
            "usage-conflicting-options",
            format!("Choose one of -p, -t, -s, --batch or --batch-check. {usage}"),
          ));
        }
      }
      "--buffer" => buffer = true,
      flag if flag.starts_with("--batch=") || flag.starts_with("--batch-check=") => {
        return Err(GitError::new(
          "unsupported-feature",
          format!(
            "cst cat-file {flag}: a format of your own is not implemented in a native repository yet; this build answers Git's default formats."
          ),
        ));
      }
      "--batch-command" | "--batch-all-objects" | "-e" => {
        return Err(GitError::new(
          "unsupported-feature",
          format!(
            "cst cat-file {text} is not implemented in a native repository yet; this build answers -p, -t, -s, --batch and --batch-check."
          ),
        ));
      }
      flag if flag.starts_with('-') => {
        return Err(GitError::new(
          "usage-unknown-option",
          format!("Unknown option '{flag}' for 'cst cat-file'. {usage}"),
        ));
      }
      _ => {
        if object.replace(bytes_of(arg)).is_some() {
          return Err(GitError::new(
            "usage-unknown-option",
            format!("cst cat-file takes one object. {usage}"),
          ));
        }
      }
    }
  }
  if let Some(batch) = mode.as_deref().filter(|mode| mode.starts_with("--batch")) {
    if object.is_some() {
      return Err(GitError::new(
        "usage-conflicting-options",
        format!("cst cat-file {batch} reads its objects from standard input, and takes none. {usage}"),
      ));
    }
    return cat_file_batch(root, batch == "--batch", buffer);
  }
  if buffer {
    return Err(GitError::new(
      "usage-unknown-option",
      format!("cst cat-file --buffer goes with --batch or --batch-check. {usage}"),
    ));
  }
  let (Some(mode), Some(object)) = (mode, object) else {
    return Err(GitError::new(
      "usage-missing-argument",
      format!("cst cat-file needs -p, -t or -s and an object. {usage}"),
    ));
  };
  let repository = Repository::open(root)?;
  let store = &repository.store;
  let id = repository.resolve(&object)?;
  // A whole native ID names itself, held or not.
  let read = store.read(&id).map_err(|error| match error {
    StoreError::NotFound(_) => GitError::new(
      "not-found",
      format!("Not a valid object name {}", String::from_utf8_lossy(&object)),
    ),
    other => store_error(other),
  })?;
  let mut out = Vec::new();
  match mode.as_str() {
    "-t" => writeln!(out, "{}", type_name(&read.kind, &read.body)?).expect("in memory"),
    "-s" => writeln!(out, "{}", size(store, &read.kind, &read.body)?).expect("in memory"),
    _ => print(store, &read.kind, read.body, &mut out)?,
  }
  let _ = std::io::stdout().lock().write_all(&out);
  Ok(())
}

/// `cst cat-file --batch` and `--batch-check` (#346): Git's formats, with
/// each object's name read from a line of standard input and answered from
/// the one store this command opens. A header is `<id> <type> <size>`, the
/// ID native; with `--batch`, the object's Git encoding follows it, `size`
/// bytes and a line feed, which is what `cst cat-file -s` sizes. A name that
/// names nothing is `<name> missing`, as is content the store holds absent,
/// which Git cannot read either; a short ID of several objects is `<name>
/// ambiguous`. Each answer is written as its line is read, and flushed
/// unless `--buffer` asks otherwise, as Git's are. A name single-object
/// `cat-file` refuses, such as a path in an index, which a native repository
/// has none of, ends the batch with that refusal: answering it `missing`
/// would say what Git, which has an index, does not. A reader that stops
/// reading ends the batch quietly, as Git ends on SIGPIPE.
fn cat_file_batch(root: &Path, contents: bool, buffer: bool) -> GitResult<()> {
  let repository = Repository::open(root)?;
  let store = &repository.store;
  // A batch names many objects: the store is read whole once, with every
  // check, and each lookup then answers from what was read (#392).
  store.read_whole().map_err(store_error)?;
  let mut input = std::io::stdin().lock();
  let stdout = std::io::stdout();
  let mut out = std::io::BufWriter::new(stdout.lock());
  match batch_answers(&repository, store, &mut input, &mut out, contents, buffer) {
    Err(Stopped::Reader) => Ok(()),
    Err(Stopped::Failed(error)) => Err(error),
    Ok(()) => out.flush().or_else(quiet_on_broken_pipe),
  }
}

/// Why a batch ended before its input did.
enum Stopped {
  /// Its reader stopped reading.
  Reader,
  Failed(GitError),
}

impl From<GitError> for Stopped {
  fn from(error: GitError) -> Stopped {
    Stopped::Failed(error)
  }
}

/// A write that failed: the reader stopped reading, or the system refused.
fn write_failed(error: std::io::Error) -> Stopped {
  if error.kind() == std::io::ErrorKind::BrokenPipe {
    return Stopped::Reader;
  }
  Stopped::Failed(GitError::node(format!("cst cat-file could not write its answer: {error}"), "EIO"))
}

fn quiet_on_broken_pipe(error: std::io::Error) -> GitResult<()> {
  match write_failed(error) {
    Stopped::Reader => Ok(()),
    Stopped::Failed(error) => Err(error),
  }
}

fn batch_answers(
  repository: &Repository,
  store: &Store,
  input: &mut impl std::io::BufRead,
  out: &mut impl std::io::Write,
  contents: bool,
  buffer: bool,
) -> Result<(), Stopped> {
  let mut line = Vec::new();
  loop {
    line.clear();
    let read = input
      .read_until(b'\n', &mut line)
      .map_err(|error| GitError::node(format!("cst cat-file could not read its input: {error}"), "EIO"))?;
    if read == 0 {
      return Ok(());
    }
    // Git's strbuf_getline: the line feed goes, and a carriage return before it.
    if line.last() == Some(&b'\n') {
      line.pop();
      if line.last() == Some(&b'\r') {
        line.pop();
      }
    }
    match batch_object(repository, &line)? {
      Batched::Found { id, kind, body } => {
        let shown = type_name(&kind, &body)?;
        let bytes = git_bytes(store, &kind, body)?;
        writeln!(out, "{} {shown} {}", id.hex(), bytes.len()).map_err(write_failed)?;
        if contents {
          out.write_all(&bytes).and_then(|()| out.write_all(b"\n")).map_err(write_failed)?;
        }
      }
      Batched::Missing => {
        out.write_all(&line).and_then(|()| out.write_all(b" missing\n")).map_err(write_failed)?;
      }
      Batched::Ambiguous => {
        out.write_all(&line).and_then(|()| out.write_all(b" ambiguous\n")).map_err(write_failed)?;
      }
    }
    if !buffer {
      out.flush().map_err(write_failed)?;
    }
  }
}

/// What one line of `cat-file --batch` input names.
enum Batched {
  Found { id: NativeId, kind: Type, body: Vec<u8> },
  Missing,
  Ambiguous,
}

fn batch_object(repository: &Repository, name: &[u8]) -> GitResult<Batched> {
  let id = match repository.resolve(name) {
    Ok(id) => id,
    Err(error) if error.code == "not-found" => return Ok(Batched::Missing),
    Err(error) if error.code == "ambiguous-match" => return Ok(Batched::Ambiguous),
    Err(error) => return Err(error),
  };
  match repository.store.read(&id) {
    Ok(read) => Ok(Batched::Found { id, kind: read.kind, body: read.body }),
    // A whole native ID names itself, held or not; content held absent is
    // what Git cannot read either (objects.md §8).
    Err(StoreError::NotFound(_) | StoreError::Absent(_)) => Ok(Batched::Missing),
    Err(other) => Err(store_error(other)),
  }
}

/// An object's Git encoding, which `cat-file -s` sizes: a tree's entries
/// with each target's Git ID, a preserved object's payload, and any other
/// object's body.
fn git_bytes(store: &Store, kind: &Type, body: Vec<u8>) -> GitResult<Vec<u8>> {
  match kind {
    Type::Tree => {
      let tree = Tree::decode(&body).map_err(corrupt)?;
      reconstruct::tree_encoding(store, algorithm(store)?, &tree)
        .map_err(store_error)?
        .ok_or_else(|| corrupt("a tree names an object that has no alias row"))
    }
    Type::Preserved => Ok(Preserved::decode(&body).map_err(corrupt)?.payload),
    _ => Ok(body),
  }
}

pub(crate) fn corrupt(what: impl std::fmt::Display) -> GitError {
  GitError::new(
    "store-corrupt",
    format!("the native store is corrupt: {what}"),
  )
}

/// One entry of a tree as Git lists it: in Git's order for a native tree, and
/// as written for one kept in Git's encoding.
pub(crate) struct Listed {
  /// The mode after Git's `canon_mode`.
  pub mode: u32,
  pub kind: &'static str,
  pub name: Vec<u8>,
  /// The native object it names, when the store holds one.
  pub target: Option<NativeId>,
  /// The ID it prints: the native ID, or a Git ID that has no alias row.
  pub shown: String,
}

/// A Git ID's native object, when the store imported it.
pub(crate) fn alias(store: &Store, algorithm: GitAlgorithm, digest: &[u8]) -> GitResult<Option<NativeId>> {
  store.native(algorithm, digest).map_err(store_error)
}

/// The entries of a tree or of a tree kept in Git's encoding; `None` for any
/// other object.
pub(crate) fn listing(store: &Store, kind: &Type, body: &[u8]) -> GitResult<Option<Vec<Listed>>> {
  match kind {
    Type::Tree => {
      let tree = Tree::decode(body).map_err(corrupt)?;
      let mut listed = Vec::with_capacity(tree.entries.len());
      for entry in tree.git_ordered() {
        let mode = u32::from_str_radix(
          std::str::from_utf8(entry.kind.git_mode()).expect("ASCII"),
          8,
        )
        .expect("octal");
        let (kind, target, shown) = match &entry.target {
          Target::Native(id) => {
            // A target must fit its kind (objects.md §4.1), which the index says.
            let held = store.known_kind(id).map_err(store_error)?;
            let fits = if entry.kind == Kind::Tree {
              matches!(held, Type::Tree | Type::Preserved)
            } else {
              held == Type::Content
            };
            if !fits {
              return Err(corrupt(format!(
                "a tree names {id} as a {:?} entry, which it is not",
                entry.kind
              )));
            }
            (
              if entry.kind == Kind::Tree {
                "tree"
              } else {
                "blob"
              },
              Some(*id),
              id.hex(),
            )
          }
          Target::Git(commit) => {
            let native = alias(store, commit.algorithm(), &commit.digest)?;
            (
              "commit",
              native,
              native.map_or_else(|| commit.hex(), |id| id.hex()),
            )
          }
        };
        listed.push(Listed {
          mode,
          kind,
          name: entry.name.clone(),
          target,
          shown,
        });
      }
      Ok(Some(listed))
    }
    Type::Preserved => {
      let preserved = Preserved::decode(body).map_err(corrupt)?;
      if preserved.kind != GitKind::Tree {
        return Ok(None);
      }
      let malformed = || {
        GitError::new(
          "malformed-input",
          "The tree is kept in Git's encoding, and Git cannot read it either.",
        )
      };
      let entries =
        parse_git_tree(&preserved.payload, preserved.algorithm).ok_or_else(malformed)?;
      let mut listed = Vec::with_capacity(entries.len());
      for entry in entries {
        let mode = git_mode(&entry.mode).ok_or_else(malformed)?;
        let (mode, kind) = canonical_mode(mode);
        let target = alias(store, preserved.algorithm, &entry.digest)?;
        listed.push(Listed {
          mode,
          kind,
          name: entry.name,
          target,
          shown: target.map_or_else(|| hex(&entry.digest), |id| id.hex()),
        });
      }
      Ok(Some(listed))
    }
    _ => Ok(None),
  }
}

pub(crate) fn type_name(kind: &Type, body: &[u8]) -> GitResult<&'static str> {
  Ok(match kind {
    Type::Content => "blob",
    Type::Tree => "tree",
    Type::Preserved => Preserved::decode(body).map_err(corrupt)?.kind.name(),
    Type::Snapshot => "snapshot",
    Type::Annotation => "annotation",
    Type::NativeCommit => "native-commit",
  })
}

/// The Git algorithm the store's Git encodings are in: its one alias file's.
fn algorithm(store: &Store) -> GitResult<GitAlgorithm> {
  match store.algorithms().as_slice() {
    [algorithm] => Ok(*algorithm),
    _ => Err(GitError::new(
      "unsupported-feature",
      "This store has no single Git algorithm, so its trees have no one Git encoding to measure.",
    )),
  }
}

/// The size Git reports: a tree's is its Git encoding's.
pub(crate) fn size(store: &Store, kind: &Type, body: &[u8]) -> GitResult<usize> {
  Ok(match kind {
    Type::Tree => Tree::decode(body)
      .map_err(corrupt)?
      .git_size(algorithm(store)?),
    Type::Preserved => Preserved::decode(body).map_err(corrupt)?.payload.len(),
    _ => body.len(),
  })
}

fn print(store: &Store, kind: &Type, body: Vec<u8>, out: &mut Vec<u8>) -> GitResult<()> {
  if let Some(entries) = listing(store, kind, &body)? {
    for entry in entries {
      line(
        out,
        &format!("{:06o}", entry.mode),
        entry.kind,
        &entry.shown,
        &entry.name,
      );
    }
  } else if *kind == Type::Preserved {
    let preserved = Preserved::decode(&body).map_err(corrupt)?;
    out.extend_from_slice(&translated(store, &preserved)?);
  } else {
    out.extend_from_slice(&body);
  }
  Ok(())
}

/// A commit's or tag's payload as `cat-file -p` prints it here: as Git
/// prints it, with each header ID Git's parser follows
/// (`Preserved::header_ids`) translated to its native ID when it names an
/// imported object. Nothing else changes: not a later `tree`, `parent` or
/// `object` line, which Git does not follow, nor an ID in a message or a
/// signature.
fn translated(store: &Store, preserved: &Preserved) -> GitResult<Vec<u8>> {
  let payload = &preserved.payload;
  let mut out = Vec::with_capacity(payload.len() + 256);
  let mut copied = 0;
  for id in preserved.header_ids() {
    if let Some(native) = alias(store, preserved.algorithm, &id.digest)? {
      out.extend_from_slice(&payload[copied..id.at.start]);
      out.extend_from_slice(native.hex().as_bytes());
      copied = id.at.end;
    }
  }
  out.extend_from_slice(&payload[copied..]);
  Ok(out)
}

/// Git's `canon_mode`, which `ls-tree` and so `cat-file -p` print, with the
/// type the mode implies.
pub(crate) fn canonical_mode(mode: u32) -> (u32, &'static str) {
  match mode & 0o170000 {
    0o100000 => (
      0o100000 | if mode & 0o100 != 0 { 0o755 } else { 0o644 },
      "blob",
    ),
    0o120000 => (0o120000, "blob"),
    0o040000 => (0o040000, "tree"),
    _ => (0o160000, "commit"),
  }
}

fn line(out: &mut Vec<u8>, mode: &str, kind: &str, id: &str, name: &[u8]) {
  out.extend_from_slice(format!("{mode} {kind} {id}\t").as_bytes());
  out.extend_from_slice(&quoted(name));
  out.push(b'\n');
}

/// A name as Git's `ls-tree` writes it with `core.quotePath` at its default:
/// unchanged when it needs no quoting, otherwise C-quoted in double quotes,
/// with every byte from 0x80 up in octal.
pub(crate) fn quoted(name: &[u8]) -> Vec<u8> {
  let escape = |byte: u8| -> Option<Vec<u8>> {
    Some(match byte {
      0x07 => b"\\a".to_vec(),
      0x08 => b"\\b".to_vec(),
      b'\t' => b"\\t".to_vec(),
      b'\n' => b"\\n".to_vec(),
      0x0b => b"\\v".to_vec(),
      0x0c => b"\\f".to_vec(),
      b'\r' => b"\\r".to_vec(),
      b'"' => b"\\\"".to_vec(),
      b'\\' => b"\\\\".to_vec(),
      byte if byte < 0x20 || byte >= 0x7f => format!("\\{byte:03o}").into_bytes(),
      _ => return None,
    })
  };
  if name.iter().all(|&byte| escape(byte).is_none()) {
    return name.to_vec();
  }
  let mut out = vec![b'"'];
  for &byte in name {
    match escape(byte) {
      Some(escaped) => out.extend_from_slice(&escaped),
      None => out.push(byte),
    }
  }
  out.push(b'"');
  out
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn names_are_quoted_as_ls_tree_quotes_them() {
    assert_eq!(quoted(b"plain"), b"plain");
    assert_eq!(quoted(b"sp ace"), b"sp ace");
    assert_eq!(quoted(b"tab\tname"), b"\"tab\\tname\"");
    assert_eq!(quoted("é".as_bytes()), b"\"\\303\\251\"");
    assert_eq!(quoted(b"quo\"te"), b"\"quo\\\"te\"");
    assert_eq!(quoted(b"back\\slash"), b"\"back\\\\slash\"");
    assert_eq!(quoted(b"del\x7f"), b"\"del\\177\"");
    assert_eq!(quoted(b"esc\x1b"), b"\"esc\\033\"");
    assert_eq!(quoted(b"bell\x07"), b"\"bell\\a\"");
  }

  #[test]
  fn modes_print_as_git_canonicalizes_them() {
    assert_eq!(canonical_mode(0o100664), (0o100644, "blob"));
    assert_eq!(canonical_mode(0o100775), (0o100755, "blob"));
    assert_eq!(canonical_mode(0o40000), (0o040000, "tree"));
    assert_eq!(canonical_mode(0o120000), (0o120000, "blob"));
    assert_eq!(canonical_mode(0), (0o160000, "commit"));
  }
}
