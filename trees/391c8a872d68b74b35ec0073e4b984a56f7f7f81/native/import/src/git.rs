//! The reads of the source repository: its shape, its object format, its
//! refs, its commits' ancestry, and objects' types and bytes, each through
//! `git` with replacement disabled, so every object is read as stored.

use causet_engine::errors::{GitError, GitResult};
use causet_engine::process::{RunOptions, run_git};

/// The most object bytes one `cat-file --batch` returns.
const BATCH_BYTES: u64 = 64 * 1024 * 1024;

/// The variables that point Git at a repository or change what it reads
/// there, as `git rev-parse --local-env-vars` lists them, and
/// `GIT_NAMESPACE`, which hides refs. The source is named by its path, so none
/// of the caller's may apply to it.
const LOCAL_ENVIRONMENT: [&str; 16] = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_OBJECT_DIRECTORY",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_GRAFT_FILE",
  "GIT_INDEX_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_REPLACE_REF_BASE",
  "GIT_PREFIX",
  "GIT_SHALLOW_FILE",
  "GIT_COMMON_DIR",
  "GIT_NAMESPACE",
];

/// The repository being imported.
pub struct Source {
  /// As the caller named it.
  pub path: String,
  /// Its common directory, absolute, once known: every read after the first
  /// is of it, so a linked worktree's refs and `HEAD` are its main
  /// worktree's (objects.md §6).
  git_dir: Option<String>,
  pub format: String,
}

/// A ref as the source lists it.
pub struct Listed {
  pub name: Vec<u8>,
  /// The object it resolves to, when it resolves.
  pub id: Option<String>,
  /// For a symbolic ref, the name it points to.
  pub symbolic: Option<Vec<u8>>,
}

fn args(items: &[&str]) -> Vec<String> {
  items.iter().map(|item| item.to_string()).collect()
}

fn malformed(what: &str) -> GitError {
  GitError::new(
    "git-response-malformed",
    format!("git printed {what} that this build could not read"),
  )
}

fn refused(path: &str, why: &str) -> GitError {
  GitError::new(
    "unsupported-repository-shape",
    format!("{path} {why}, so its history cannot be imported exactly (ADR-0045, decision 1)."),
  )
}

/// Whether a configuration value means false to Git (`git_parse_maybe_bool`):
/// `None` is a key written without a value, which means true.
fn falsy(value: Option<&[u8]>) -> bool {
  let Some(value) = value else {
    return false;
  };
  let value = String::from_utf8_lossy(value).trim().to_ascii_lowercase();
  if matches!(value.as_str(), "" | "false" | "no" | "off") {
    return true;
  }
  let digits = value.trim_end_matches(['k', 'm', 'g']);
  digits.len() + 1 >= value.len() && digits.parse::<i64>() == Ok(0)
}

/// A path as `git` printed it.
#[cfg(unix)]
fn path_of(bytes: &[u8]) -> std::path::PathBuf {
  use std::os::unix::ffi::OsStringExt;
  std::ffi::OsString::from_vec(bytes.to_vec()).into()
}

#[cfg(not(unix))]
fn path_of(bytes: &[u8]) -> std::path::PathBuf {
  String::from_utf8_lossy(bytes).into_owned().into()
}

impl Source {
  fn options(&self) -> RunOptions {
    let mut options = RunOptions::new(&self.path);
    for name in LOCAL_ENVIRONMENT {
      options = options.env_remove(name);
    }
    // A promisor the shape check missed then fails as a missing object
    // rather than fetching into the source.
    options = options
      .env("GIT_NO_REPLACE_OBJECTS", "1")
      .env("GIT_NO_LAZY_FETCH", "1");
    if let Some(git_dir) = &self.git_dir {
      options = options.env("GIT_DIR", git_dir);
    }
    options.import_read = true;
    options
  }

  /// Opens the source and refuses one whose history Git itself reads
  /// differently from its stored objects: a shallow clone, a partial clone,
  /// or a repository with grafts. Nothing is written before this.
  pub fn open(path: &str) -> GitResult<Source> {
    let mut source = Source {
      path: path.to_string(),
      git_dir: None,
      format: String::new(),
    };
    let shape = run_git(
      &args(&[
        "rev-parse",
        "--show-object-format",
        "--is-shallow-repository",
        "--path-format=absolute",
        "--git-dir",
        "--git-common-dir",
        "--git-path",
        "info/grafts",
      ]),
      &source.options().binary(),
    )?
    .bytes;
    let shape = shape.strip_suffix(b"\n").unwrap_or(&shape);
    let lines: Vec<&[u8]> = shape.split(|&byte| byte == b'\n').collect();
    let [format, shallow, git_dir, common, grafts] = lines[..] else {
      return Err(refused(
        path,
        "is at a path holding a line feed, which this build cannot read from git",
      ));
    };
    if shallow == b"true" {
      return Err(refused(
        path,
        "is a shallow clone, which lacks commits its history names",
      ));
    }
    let grafted = std::fs::read(path_of(grafts)).is_ok_and(|bytes| {
      bytes
        .split(|&byte| byte == b'\n')
        .any(|line| !line.trim_ascii().is_empty() && !line.starts_with(b"#"))
    });
    if grafted {
      return Err(refused(
        path,
        &format!(
          "has grafts ({}), which give its commits parents they do not store",
          String::from_utf8_lossy(grafts)
        ),
      ));
    }
    source.format = String::from_utf8_lossy(format).into_owned();
    // A linked worktree is read through its main worktree (objects.md §6);
    // any other source is found from its path, as Git finds it.
    let same = |a: &[u8], b: &[u8]| {
      a == b
        || std::fs::canonicalize(path_of(a))
          .ok()
          .is_some_and(|a| std::fs::canonicalize(path_of(b)).ok() == Some(a))
    };
    if !same(git_dir, common) {
      let common = std::str::from_utf8(common).map_err(|_| {
        refused(
          path,
          "is a linked worktree whose main repository's path is not UTF-8, which this build cannot pass to git",
        )
      })?;
      source.git_dir = Some(common.to_string());
    }
    let promisors = run_git(
      &args(&[
        "config",
        "-z",
        "--get-regexp",
        r"^(extensions\.partialclone|remote\..*\.promisor)$",
      ]),
      &source.options().binary().allow_failure(),
    )?;
    if promisors.status > 1 {
      return Err(malformed("its configuration"));
    }
    for entry in promisors
      .bytes
      .split(|&byte| byte == 0)
      .filter(|entry| !entry.is_empty())
    {
      let (key, value) = match entry.iter().position(|&byte| byte == b'\n') {
        Some(at) => (&entry[..at], Some(&entry[at + 1..])),
        None => (entry, None),
      };
      if key == b"extensions.partialclone" || !falsy(value) {
        return Err(refused(
          path,
          &format!(
            "is a partial clone ({}), which may lack objects its history names",
            String::from_utf8_lossy(key)
          ),
        ));
      }
    }
    Ok(source)
  }

  /// The ref a symbolic ref points to, one step: not where a chain of them
  /// ends, which is what `%(symref)` gives.
  fn symbolic(&self, name: &[u8]) -> GitResult<Option<Vec<u8>>> {
    let name = String::from_utf8_lossy(name);
    let read = run_git(
      &args(&["symbolic-ref", "--quiet", "--no-recurse", name.as_ref()]),
      &self.options().binary().allow_failure(),
    )?;
    if !read.ok {
      return Ok(None);
    }
    let target = read.bytes.strip_suffix(b"\n").unwrap_or(&read.bytes);
    Ok(Some(target.to_vec()))
  }

  /// Every ref `for-each-ref` lists, and `HEAD`: each name with the object it
  /// resolves to, and for a symbolic ref the name it points to. `HEAD` on an
  /// unborn branch resolves to nothing.
  pub fn refs(&self) -> GitResult<Vec<Listed>> {
    let listed = run_git(
      &args(&[
        "for-each-ref",
        "--format=%(objectname)%00%(symref)%00%(refname)",
      ]),
      &self.options().binary(),
    )?
    .bytes;
    let mut refs = Vec::new();
    for line in listed
      .split(|&byte| byte == b'\n')
      .filter(|line| !line.is_empty())
    {
      let fields: Vec<&[u8]> = line.split(|&byte| byte == 0).collect();
      let [id, symbolic, name] = fields[..] else {
        return Err(malformed("a ref line"));
      };
      let id = std::str::from_utf8(id).map_err(|_| malformed("a ref line"))?;
      let symbolic = match (symbolic.is_empty(), std::str::from_utf8(name)) {
        (true, _) => None,
        (false, Ok(_)) => Some(
          self
            .symbolic(name)?
            .ok_or_else(|| malformed("a symbolic ref"))?,
        ),
        // A name that is not UTF-8 cannot be passed back to git, so it keeps
        // the end of its chain, which is its target unless it is a chain.
        (false, Err(_)) => Some(symbolic.to_vec()),
      };
      refs.push(Listed {
        name: name.to_vec(),
        id: Some(id.to_string()),
        symbolic,
      });
    }
    let head = match self.symbolic(b"HEAD")? {
      Some(target) => Listed {
        name: b"HEAD".to_vec(),
        id: None,
        symbolic: Some(target),
      },
      None => {
        let detached = run_git(
          &args(&["rev-parse", "--verify", "--quiet", "HEAD"]),
          &self.options().allow_failure(),
        )?;
        if !detached.ok || detached.stdout.is_empty() {
          return Err(refused(
            &self.path,
            "has a HEAD that is neither symbolic nor an object",
          ));
        }
        Listed {
          name: b"HEAD".to_vec(),
          id: Some(detached.stdout),
          symbolic: None,
        }
      }
    };
    refs.push(head);
    Ok(refs)
  }

  /// The commits Git's `--all` starts from: the refs, and what the snapshot
  /// does not record, other worktrees' `HEAD` and per-worktree refs.
  pub fn all_tips(&self) -> GitResult<Vec<String>> {
    let listed = run_git(
      &args(&["rev-list", "--all", "--no-walk=unsorted"]),
      &self.options(),
    )?
    .stdout;
    Ok(
      listed
        .lines()
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect(),
    )
  }

  /// The commits reachable from these and not from `except`, themselves
  /// included, in `rev-list` order, each with its parents as Git parses them.
  /// Only commits: their trees are followed by import itself.
  pub fn commits(
    &self,
    starts: &[String],
    except: &[String],
  ) -> GitResult<Vec<(String, Vec<String>)>> {
    if starts.is_empty() {
      return Ok(Vec::new());
    }
    let mut input = starts.join("\n") + "\n";
    for id in except {
      input.push('^');
      input.push_str(id);
      input.push('\n');
    }
    let listed = run_git(
      &args(&["rev-list", "--parents", "--stdin"]),
      &self.options().input(input),
    )?
    .stdout;
    Ok(
      listed
        .lines()
        .filter(|line| !line.is_empty())
        .map(|line| {
          let mut ids = line.split(' ').map(str::to_string);
          let commit = ids.next().unwrap_or_default();
          (commit, ids.collect())
        })
        .collect(),
    )
  }

  /// Those of these objects the source holds, in the order given.
  pub fn holding(&self, ids: &[String]) -> GitResult<Vec<String>> {
    if ids.is_empty() {
      return Ok(Vec::new());
    }
    let input = ids.join("\n") + "\n";
    let listed = run_git(
      &args(&["cat-file", "--batch-check=%(objectname)"]),
      &self.options().input(input),
    )?
    .stdout;
    Ok(
      listed
        .lines()
        .zip(ids)
        .filter(|(line, id)| line == id)
        .map(|(_, id)| id.clone())
        .collect(),
    )
  }

  /// Each object's type and size, in the order given.
  pub fn types(&self, ids: &[String]) -> GitResult<Vec<(String, u64)>> {
    if ids.is_empty() {
      return Ok(Vec::new());
    }
    let input = ids.join("\n") + "\n";
    let listed = run_git(
      &args(&[
        "cat-file",
        "--batch-check=%(objectname) %(objecttype) %(objectsize)",
      ]),
      &self.options().input(input),
    )?
    .stdout;
    let mut types = Vec::with_capacity(ids.len());
    for (line, id) in listed.lines().zip(ids) {
      if line == format!("{id} missing") {
        return Err(GitError::new(
          "unsupported-repository-shape",
          format!(
            "{} names the object {id} but does not hold it, so it cannot be imported whole",
            self.path
          ),
        ));
      }
      let mut fields = line.split(' ');
      let (Some(named), Some(kind), Some(size)) = (fields.next(), fields.next(), fields.next())
      else {
        return Err(malformed("an object line"));
      };
      if named != id {
        return Err(malformed("an object line"));
      }
      types.push((
        kind.to_string(),
        size.parse().map_err(|_| malformed("an object size"))?,
      ));
    }
    if types.len() != ids.len() {
      return Err(malformed("fewer object lines than it was asked for"));
    }
    Ok(types)
  }

  /// The objects' bytes, in batches of at most 64 MiB, passed to `each` in the
  /// order given. `sizes` are the objects' sizes from `types`.
  pub fn contents(
    &self,
    ids: &[String],
    sizes: &[u64],
    each: &mut dyn FnMut(&str, &str, Vec<u8>) -> GitResult<()>,
  ) -> GitResult<()> {
    let mut start = 0;
    while start < ids.len() {
      let mut end = start;
      let mut bytes = 0;
      while end < ids.len() && (end == start || bytes + sizes[end] <= BATCH_BYTES) {
        bytes += sizes[end];
        end += 1;
      }
      let batch = &ids[start..end];
      let mut options = self.options().binary().input(batch.join("\n") + "\n");
      options.max_buffer = usize::try_from(bytes)
        .unwrap_or(usize::MAX)
        .saturating_add(batch.len() * 128 + 4096);
      let output = run_git(&args(&["cat-file", "--batch"]), &options)?.bytes;
      let mut rest = output.as_slice();
      for id in batch {
        let newline = rest
          .iter()
          .position(|&byte| byte == b'\n')
          .ok_or_else(|| malformed("an object header"))?;
        let header =
          std::str::from_utf8(&rest[..newline]).map_err(|_| malformed("an object header"))?;
        let mut fields = header.split(' ');
        let (Some(named), Some(kind), Some(size)) = (fields.next(), fields.next(), fields.next())
        else {
          return Err(malformed("an object header"));
        };
        let size: usize = size.parse().map_err(|_| malformed("an object size"))?;
        if named != id || rest.len() < newline + 1 + size + 1 || rest[newline + 1 + size] != b'\n' {
          return Err(malformed("an object"));
        }
        let body = rest[newline + 1..newline + 1 + size].to_vec();
        let kind = kind.to_string();
        rest = &rest[newline + 1 + size + 1..];
        each(id, &kind, body)?;
      }
      start = end;
    }
    Ok(())
  }
}
