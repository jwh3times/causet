//! Takes the version from the package manifest, `package.json`, which release
//! preparation sets, so `cst --version` and the published packages cannot
//! disagree. Until #243 the help text and the version came from the
//! JavaScript CLI, the oracle (ADR-0037); the help text now lives beside the
//! Rust CLI, in `src/help.txt`.
#![forbid(unsafe_code)]

use std::{env, fs, path::Path};

fn main() {
  let manifest = env::var("CARGO_MANIFEST_DIR").expect("manifest directory");
  let package = Path::new(&manifest).join("../../package.json");
  println!("cargo:rerun-if-changed={}", package.display());

  let package_source = fs::read_to_string(&package).expect("read package.json");
  let version = between(&package_source, "\"version\": \"", "\"").expect("package.json declares a version");
  assert!(
    !version.is_empty() && version.chars().all(|c| c.is_ascii_alphanumeric() || ".-+".contains(c)),
    "package.json's version '{version}' is not a plain semantic version"
  );

  let out = Path::new(&env::var("OUT_DIR").expect("OUT_DIR")).to_path_buf();
  fs::write(out.join("version.txt"), version).expect("write version.txt");
}

fn between<'a>(source: &'a str, open: &str, close: &str) -> Option<&'a str> {
  let start = source.find(open)? + open.len();
  let length = source[start..].find(close)?;
  Some(&source[start..start + length])
}
