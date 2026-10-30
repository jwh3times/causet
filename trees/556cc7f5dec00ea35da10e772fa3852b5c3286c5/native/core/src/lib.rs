//! Bounded, read-only Git acquisition. Domain validation stays in JavaScript.
#![forbid(unsafe_code)]

use gix::{ObjectId, Repository, objs::Kind};
use std::collections::{BTreeMap, VecDeque};

pub type Result<T> = std::result::Result<T, String>;
const MAX_BYTES: u64 = 64 * 1024 * 1024;
fn err(e: impl std::fmt::Display) -> String {
  e.to_string()
}

fn open(cwd: &str) -> Result<Repository> {
  for key in [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_NAMESPACE",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_PARAMETERS",
    "GIT_REPLACE_REF_BASE",
    "GIT_ALLOC_LIMIT",
  ] {
    if std::env::var_os(key).is_some() {
      return Err(format!("unsupported environment: {key}"));
    }
  }
  let repo = gix::discover_opts(
    cwd,
    Default::default(),
    gix::open::Options::default().config_overrides(["gitoxide.objects.allocLimit=67108864"]),
  )
  .map_err(err)?;
  if repo.workdir().is_none() || repo.object_hash() != gix::hash::Kind::Sha1 {
    return Err("unsupported repository profile".into());
  }
  let config = repo.config_snapshot();
  if config.string("extensions.refStorage").is_some()
    || config.string("extensions.partialClone").is_some()
    || config
      .sections_by_name("remote")
      .is_some_and(|mut sections| {
        sections.any(|section| section.value_implicit("promisor").is_some())
      })
    || repo.common_dir().join("info/grafts").exists()
    || repo
      .references()
      .map_err(err)?
      .prefixed("refs/replace/")
      .map_err(err)?
      .next()
      .is_some()
  {
    return Err("unsupported repository extension".into());
  }
  Ok(repo)
}

pub struct Context {
  pub root: String,
  pub git_dir: String,
  pub common_dir: String,
}
fn absolute(path: &std::path::Path) -> Result<String> {
  let p = std::fs::canonicalize(path).map_err(err)?;
  let s = p.to_str().ok_or("non-UTF-8 path")?;
  if s.starts_with("\\\\?\\UNC\\") {
    return Err("unsupported UNC repository".into());
  }
  Ok(s.strip_prefix("\\\\?\\").unwrap_or(s).to_owned())
}
pub fn context(cwd: &str) -> Result<Context> {
  let repo = open(cwd)?;
  Ok(Context {
    root: absolute(repo.workdir().ok_or("bare repository")?)?,
    git_dir: repo.git_dir().to_str().ok_or("non-UTF-8 path")?.to_owned(),
    common_dir: repo
      .common_dir()
      .to_str()
      .ok_or("non-UTF-8 path")?
      .to_owned(),
  })
}

pub fn refs(pattern: &str, cwd: &str) -> Result<Vec<(String, String)>> {
  if !pattern.starts_with("refs/") || pattern.bytes().any(|b| b"*?[]\\".contains(&b)) {
    return Err("unsupported ref pattern".into());
  }
  let repo = open(cwd)?;
  let mut result = BTreeMap::new();
  for reference in repo.references().map_err(err)?.all().map_err(err)? {
    let reference = reference.map_err(err)?;
    let name = std::str::from_utf8(reference.name().as_bstr()).map_err(err)?;
    if name == pattern
      || name
        .strip_prefix(pattern)
        .is_some_and(|s| pattern.ends_with('/') || s.starts_with('/'))
    {
      let id = reference.try_id().ok_or("symbolic reference")?;
      if repo.try_find_header(id.detach()).map_err(err)?.is_none() {
        return Err("dangling reference".into());
      }
      result.insert(name.to_owned(), id.to_string());
    }
  }
  Ok(result.into_iter().collect())
}

fn oid(text: &str) -> Result<ObjectId> {
  if text.len() != 40 {
    return Err("unsupported object name".into());
  }
  ObjectId::from_hex(text.as_bytes()).map_err(err)
}

/// Common byte-input target for a bounded mutation fuzzer (no repository writes).
pub fn fuzz_parsers(data: &[u8]) {
  let _ = tree_entries(data);
  let _ = gix::objs::TagRef::from_bytes(data, gix::hash::Kind::Sha1);
  let _ = gix::objs::CommitRef::from_bytes(data, gix::hash::Kind::Sha1);
  if let Ok(text) = std::str::from_utf8(data) {
    let _ = oid(text);
  }
}
fn object<'a>(repo: &'a Repository, id: ObjectId, remaining: &mut u64) -> Result<gix::Object<'a>> {
  let header = repo.find_header(id).map_err(err)?;
  let size = header.size();
  if size > *remaining {
    return Err("native object budget exceeded".into());
  }
  *remaining -= size;
  let object = repo.find_object(id).map_err(err)?;
  if object.data.len() as u64 != size {
    return Err("object header changed".into());
  }
  Ok(object)
}

/// Parse raw SHA-1 trees without allocation proportional to an untrusted length.
pub fn tree_entries(data: &[u8]) -> Result<Vec<(u32, Vec<u8>, ObjectId)>> {
  let mut rest = data;
  let mut out = Vec::new();
  let mut previous = None;
  while !rest.is_empty() {
    let space = rest
      .iter()
      .position(|b| *b == b' ')
      .ok_or("missing tree mode")?;
    if space == 0 || space > 6 || !rest[..space].iter().all(|b| (b'0'..=b'7').contains(b)) {
      return Err("invalid tree mode".into());
    }
    let mode =
      u32::from_str_radix(std::str::from_utf8(&rest[..space]).map_err(err)?, 8).map_err(err)?;
    rest = &rest[space + 1..];
    let nul = rest
      .iter()
      .position(|b| *b == 0)
      .ok_or("missing tree name")?;
    if nul == 0 || rest.len() < nul + 21 {
      return Err("truncated tree entry".into());
    }
    let name = rest[..nul].to_vec();
    if name.contains(&b'/') {
      return Err("invalid tree name".into());
    }
    let mut key = name.clone();
    if mode & 0o170000 == 0o040000 {
      key.push(b'/');
    }
    if previous.as_ref().is_some_and(|last: &Vec<u8>| last >= &key) {
      return Err("unordered tree entries".into());
    }
    previous = Some(key);
    let id = ObjectId::from_bytes_or_panic(&rest[nul + 1..nul + 21]);
    out.push((mode, name, id));
    rest = &rest[nul + 21..];
  }
  Ok(out)
}

fn resolve(repo: &Repository, expression: &str, remaining: &mut u64) -> Result<Option<ObjectId>> {
  let (base, suffix) = if let Some(base) = expression.strip_suffix("^{commit}") {
    (base, "commit")
  } else if let Some(base) = expression.strip_suffix("^{tree}") {
    (base, "tree")
  } else if let Some(base) = expression.strip_suffix(":result") {
    (base, "result")
  } else {
    (expression, "")
  };
  let mut id =
    if base.starts_with("refs/") && !base.bytes().any(|b| b"~^:{}?*[\\\n\r\0".contains(&b)) {
      match repo.try_find_reference(base).map_err(err)? {
        Some(reference) => reference.try_id().ok_or("symbolic reference")?.detach(),
        None => return Ok(None),
      }
    } else {
      oid(base)?
    };
  if repo.try_find_header(id).map_err(err)?.is_none() {
    return Ok(None);
  }
  if suffix.is_empty() {
    return Ok(Some(id));
  }
  for _ in 0..64 {
    let obj = object(repo, id, remaining)?;
    match obj.kind {
      Kind::Tag => {
        gix::objs::TagRef::from_bytes(&obj.data, repo.object_hash()).map_err(err)?;
        let line = obj
          .data
          .split(|b| *b == b'\n')
          .next()
          .ok_or("invalid tag")?;
        let target = line.strip_prefix(b"object ").ok_or("invalid tag")?;
        id = oid(std::str::from_utf8(target).map_err(err)?)?;
      }
      Kind::Commit if suffix == "commit" => return Ok(Some(id)),
      Kind::Commit => {
        gix::objs::CommitRef::from_bytes(&obj.data, repo.object_hash()).map_err(err)?;
        let line = obj
          .data
          .split(|b| *b == b'\n')
          .next()
          .ok_or("invalid commit")?;
        id = oid(
          std::str::from_utf8(line.strip_prefix(b"tree ").ok_or("invalid commit")?).map_err(err)?,
        )?;
      }
      Kind::Tree if suffix == "tree" => return Ok(Some(id)),
      Kind::Tree if suffix == "result" => {
        let matches: Vec<_> = tree_entries(&obj.data)?
          .into_iter()
          .filter(|(_, name, _)| name == b"result")
          .collect();
        if matches.len() > 1 {
          return Err("duplicate tree path".into());
        }
        return Ok(matches.first().map(|(_, _, id)| *id));
      }
      _ => return Err("unsupported peel".into()),
    }
  }
  Err("peel depth exceeded".into())
}

pub struct ObjectRecord {
  pub expression: String,
  pub oid: Option<String>,
  pub kind: Option<String>,
  pub size: u64,
  pub content: Option<Vec<u8>>,
}
pub fn objects(expressions: Vec<String>, cwd: &str, contents: bool) -> Result<Vec<ObjectRecord>> {
  if expressions.is_empty() {
    return Ok(Vec::new());
  }
  if expressions.len() > 65536 {
    return Err("native batch budget exceeded".into());
  }
  let repo = open(cwd)?;
  let mut remaining = MAX_BYTES;
  expressions
    .into_iter()
    .map(|expression| {
      let id = resolve(&repo, &expression, &mut remaining)?;
      let header = id
        .map(|id| repo.try_find_header(id).map_err(err))
        .transpose()?
        .flatten();
      match (id, header) {
        (Some(id), Some(header)) => Ok(ObjectRecord {
          expression,
          oid: Some(id.to_string()),
          kind: Some(header.kind().to_string()),
          size: header.size(),
          content: if contents {
            Some(object(&repo, id, &mut remaining)?.data.clone())
          } else {
            None
          },
        }),
        _ => Ok(ObjectRecord {
          expression,
          oid: None,
          kind: None,
          size: 0,
          content: None,
        }),
      }
    })
    .collect()
}

pub fn notes(notes_ref: &str, cwd: &str) -> Result<Vec<(String, String)>> {
  if notes_ref.is_empty()
    || !notes_ref
      .bytes()
      .all(|b| b.is_ascii_alphanumeric() || b"._/-".contains(&b))
  {
    return Err("unsupported notes ref".into());
  }
  let name = if notes_ref.starts_with("refs/notes/") {
    notes_ref.to_owned()
  } else if notes_ref.starts_with("notes/") {
    format!("refs/{notes_ref}")
  } else {
    format!("refs/notes/{notes_ref}")
  };
  let repo = open(cwd)?;
  let mut remaining = 16 * 1024 * 1024;
  let Some(root) = resolve(&repo, &format!("{name}^{{tree}}"), &mut remaining)? else {
    return Ok(Vec::new());
  };
  let mut queue = VecDeque::from([(root, String::new())]);
  let mut notes = BTreeMap::new();
  let mut visited = 0;
  while let Some((id, prefix)) = queue.pop_front() {
    visited += 1;
    if visited > 1024 {
      return Err("notes tree budget exceeded".into());
    }
    let obj = object(&repo, id, &mut remaining)?;
    if obj.kind != Kind::Tree {
      return Err("invalid notes tree".into());
    }
    for (mode, name, id) in tree_entries(&obj.data)? {
      if !name.iter().all(u8::is_ascii_hexdigit) {
        continue;
      }
      let name = std::str::from_utf8(&name).map_err(err)?;
      let target = format!("{prefix}{name}").to_ascii_lowercase();
      if target.len() == 40 && mode & 0o170000 == 0o100000 && !id.is_null() {
        if notes.insert(target, id.to_string()).is_some() {
          return Err("duplicate note target".into());
        }
      } else if name.len() == 2 && target.len() < 40 && mode & 0o170000 == 0o040000 {
        queue.push_back((id, target));
      }
    }
  }
  Ok(
    notes
      .into_iter()
      .map(|(target, note)| (note, target))
      .collect(),
  )
}
