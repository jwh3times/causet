use napi::{Error, Result, bindgen_prelude::Buffer};
use napi_derive::napi;

fn convert<T>(result: vlab_core::Result<T>) -> Result<T> {
  result.map_err(Error::from_reason)
}

#[napi(catch_unwind)]
pub fn profile_version() -> u32 {
  1
}

#[napi(object)]
pub struct Context {
  pub root: String,
  pub git_dir: String,
  pub common_dir: String,
  pub object_format: String,
}
#[napi(object)]
pub struct RefRecord {
  pub name: String,
  pub oid: String,
}
#[napi(object)]
pub struct NoteRecord {
  pub note: String,
  pub target: String,
}
#[napi(object)]
pub struct ObjectRecord {
  pub expression: String,
  pub exists: bool,
  pub oid: Option<String>,
  pub kind: Option<String>,
  pub size: f64,
  pub content: Option<Buffer>,
}

#[napi(catch_unwind)]
pub fn repo_context(cwd: String) -> Result<Context> {
  let c = convert(vlab_core::context(&cwd))?;
  Ok(Context {
    root: c.root,
    git_dir: c.git_dir,
    common_dir: c.common_dir,
    object_format: "sha1".into(),
  })
}
#[napi(catch_unwind)]
pub fn list_refs(pattern: String, cwd: String) -> Result<Vec<RefRecord>> {
  Ok(
    convert(vlab_core::refs(&pattern, &cwd))?
      .into_iter()
      .map(|(name, oid)| RefRecord { name, oid })
      .collect(),
  )
}
#[napi(catch_unwind)]
pub fn read_objects(
  expressions: Vec<String>,
  cwd: String,
  contents: bool,
) -> Result<Vec<ObjectRecord>> {
  Ok(
    convert(vlab_core::objects(expressions, &cwd, contents))?
      .into_iter()
      .map(|r| ObjectRecord {
        expression: r.expression,
        exists: r.oid.is_some(),
        oid: r.oid,
        kind: r.kind,
        size: r.size as f64,
        content: r.content.map(Into::into),
      })
      .collect(),
  )
}
#[napi(catch_unwind)]
pub fn list_note_entries(notes_ref: String, cwd: String) -> Result<Vec<NoteRecord>> {
  Ok(
    convert(vlab_core::notes(&notes_ref, &cwd))?
      .into_iter()
      .map(|(note, target)| NoteRecord { note, target })
      .collect(),
  )
}
