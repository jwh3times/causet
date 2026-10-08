//! What the cataloged operations return, and `canonicalValue` of each: the
//! JSON `src/engine.js` digests for the engine differential, with members
//! sorted, `undefined` as `null`, and bytes as `{ bytes, sha256 }`.

use causet_model::json::{Object, Value, string};

/// A value in its `canonicalValue` form.
pub trait Canonical {
  fn canonical(&self) -> Value;
}

/// An object with its members sorted as `Object.keys(value).sort()` sorts
/// them.
pub fn sorted(mut members: Vec<(&str, Value)>) -> Value {
  members.sort_by(|left, right| crate::text::compare(left.0, right.0));
  let mut object = Object::new();
  for (name, value) in members {
    object.set(name, value);
  }
  Value::Object(object)
}

/// A `Buffer`: `{ bytes, sha256 }`.
pub fn bytes(data: &[u8]) -> Value {
  sorted(vec![
    ("bytes", Value::Number(data.len() as f64)),
    ("sha256", string(&causet_model::sha256::hex(data))),
  ])
}

fn text(value: &Option<String>) -> Value {
  value.as_deref().map_or(Value::Null, string)
}

impl Canonical for String {
  fn canonical(&self) -> Value {
    string(self)
  }
}

impl Canonical for bool {
  fn canonical(&self) -> Value {
    Value::Bool(*self)
  }
}

impl Canonical for f64 {
  fn canonical(&self) -> Value {
    Value::Number(*self)
  }
}

impl Canonical for Vec<u8> {
  fn canonical(&self) -> Value {
    bytes(self)
  }
}

impl<T: Canonical> Canonical for Option<T> {
  fn canonical(&self) -> Value {
    self.as_ref().map_or(Value::Null, Canonical::canonical)
  }
}

impl<T: Canonical> Canonical for Vec<T> {
  fn canonical(&self) -> Value {
    Value::Array(self.iter().map(Canonical::canonical).collect())
  }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RepoContext {
  pub root: String,
  pub git_dir: String,
  pub common_dir: String,
  pub object_format: String,
}

impl Canonical for RepoContext {
  fn canonical(&self) -> Value {
    sorted(vec![
      ("root", string(&self.root)),
      ("gitDir", string(&self.git_dir)),
      ("commonDir", string(&self.common_dir)),
      ("objectFormat", string(&self.object_format)),
    ])
  }
}

#[derive(Clone, Debug, PartialEq)]
pub struct GitVersion {
  pub raw: String,
  pub parts: Option<[f64; 3]>,
}

impl Canonical for GitVersion {
  fn canonical(&self) -> Value {
    sorted(vec![
      ("raw", string(&self.raw)),
      (
        "parts",
        self.parts.map_or(Value::Null, |parts| {
          Value::Array(parts.iter().map(|part| Value::Number(*part)).collect())
        }),
      ),
    ])
  }
}

/// `inspectGitObjects` and, with `content`, `readGitObjects`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ObjectRecord {
  pub expression: String,
  pub exists: bool,
  pub oid: Option<String>,
  pub kind: Option<String>,
  pub size: u64,
  pub content: Option<Vec<u8>>,
}

/// `inspectGitObjects` has no `content` member; `readGitObjects` always has
/// one. The flag records which shape a record is.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Objects {
  pub records: Vec<ObjectRecord>,
  pub with_content: bool,
}

impl Canonical for Objects {
  fn canonical(&self) -> Value {
    Value::Array(
      self
        .records
        .iter()
        .map(|record| {
          let mut members = vec![
            ("expression", string(&record.expression)),
            ("exists", Value::Bool(record.exists)),
            ("oid", text(&record.oid)),
            ("type", text(&record.kind)),
            ("size", Value::Number(record.size as f64)),
          ];
          if self.with_content {
            members.push((
              "content",
              record.content.as_deref().map_or(Value::Null, bytes),
            ));
          }
          sorted(members)
        })
        .collect(),
    )
  }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommitParents {
  pub commit: String,
  pub parents: Vec<String>,
}

impl Canonical for CommitParents {
  fn canonical(&self) -> Value {
    sorted(vec![
      ("commit", string(&self.commit)),
      ("parents", self.parents.canonical()),
    ])
  }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommitRecord {
  pub commit: String,
  pub subject: String,
  pub message: String,
  pub changed_paths: Option<Vec<String>>,
}

impl Canonical for CommitRecord {
  fn canonical(&self) -> Value {
    let mut members = vec![
      ("commit", string(&self.commit)),
      ("subject", string(&self.subject)),
      ("message", string(&self.message)),
    ];
    if let Some(paths) = &self.changed_paths {
      members.push(("changedPaths", paths.canonical()));
    }
    sorted(members)
  }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RefEntry {
  pub name: String,
  pub oid: String,
}

impl Canonical for RefEntry {
  fn canonical(&self) -> Value {
    sorted(vec![
      ("ref", string(&self.name)),
      ("oid", string(&self.oid)),
    ])
  }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NoteEntry {
  pub note: String,
  pub target: String,
}

impl Canonical for NoteEntry {
  fn canonical(&self) -> Value {
    sorted(vec![
      ("note", string(&self.note)),
      ("target", string(&self.target)),
    ])
  }
}

#[derive(Clone, Debug, PartialEq)]
pub struct WorkspaceStatus {
  pub ok: bool,
  pub head: Option<String>,
  pub dirty_files: Option<f64>,
  pub error: Option<String>,
  pub exit_code: i32,
}

impl Canonical for WorkspaceStatus {
  fn canonical(&self) -> Value {
    sorted(vec![
      ("ok", Value::Bool(self.ok)),
      ("head", text(&self.head)),
      (
        "dirtyFiles",
        self.dirty_files.map_or(Value::Null, Value::Number),
      ),
      ("error", text(&self.error)),
      ("exitCode", Value::Number(f64::from(self.exit_code))),
    ])
  }
}

/// An index entry. A field Git did not print is `undefined` in JavaScript,
/// which is `None` here and `null` in the canonical form.
#[derive(Clone, Debug, PartialEq)]
pub struct IndexEntry {
  pub mode: Option<String>,
  pub blob: Option<String>,
  pub stage: f64,
  pub path: String,
}

impl Canonical for IndexEntry {
  fn canonical(&self) -> Value {
    sorted(vec![
      ("mode", text(&self.mode)),
      ("blob", text(&self.blob)),
      ("stage", Value::Number(self.stage)),
      ("path", string(&self.path)),
    ])
  }
}

#[derive(Clone, Debug, PartialEq)]
pub struct InventoryEntry {
  pub tag: String,
  pub mode: Option<String>,
  pub blob: Option<String>,
  pub stage: Option<f64>,
  pub path: String,
}

impl Canonical for InventoryEntry {
  fn canonical(&self) -> Value {
    sorted(vec![
      ("tag", string(&self.tag)),
      ("mode", text(&self.mode)),
      ("blob", text(&self.blob)),
      ("stage", self.stage.map_or(Value::Null, Value::Number)),
      ("path", string(&self.path)),
    ])
  }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Worktree {
  pub path: String,
  pub head: Option<String>,
  pub branch: Option<String>,
  pub detached: bool,
  pub bare: bool,
  pub locked: Option<String>,
  pub prunable: Option<String>,
}

impl Canonical for Worktree {
  fn canonical(&self) -> Value {
    sorted(vec![
      ("path", string(&self.path)),
      ("head", text(&self.head)),
      ("branch", text(&self.branch)),
      ("detached", Value::Bool(self.detached)),
      ("bare", Value::Bool(self.bare)),
      ("locked", text(&self.locked)),
      ("prunable", text(&self.prunable)),
    ])
  }
}

/// `commitHistory` options.
#[derive(Clone, Copy, Debug, Default)]
pub struct HistoryOptions {
  pub reverse: bool,
  pub paths: bool,
}

/// `indexEntries` options.
#[derive(Clone, Debug, Default)]
pub struct IndexOptions {
  pub unmerged_only: bool,
  pub paths: Vec<String>,
}
