//! Takes the help text and the version from the JavaScript CLI, the oracle
//! (ADR-0037), so the two implementations cannot drift apart on either.
#![forbid(unsafe_code)]

use std::{env, fs, path::Path};

fn main() {
  let manifest = env::var("CARGO_MANIFEST_DIR").expect("manifest directory");
  let root = Path::new(&manifest).join("../..");
  let cli = root.join("src/cli.js");
  let version = root.join("src/version.js");
  println!("cargo:rerun-if-changed={}", cli.display());
  println!("cargo:rerun-if-changed={}", version.display());

  let cli_source = fs::read_to_string(&cli).expect("read src/cli.js");
  let help = between(&cli_source, "const HELP = `", "`;").expect("src/cli.js declares HELP");
  // A template literal is taken verbatim only when it has no escapes and no
  // substitutions; anything else would need JavaScript's evaluation rules.
  assert!(
    !help.contains('\\') && !help.contains("${"),
    "HELP in src/cli.js now uses escapes or substitutions; teach build.rs to evaluate them"
  );
  let help = help.replace("\r\n", "\n");

  let version_source = fs::read_to_string(&version).expect("read src/version.js");
  let version = between(&version_source, "export const VERSION = \"", "\";")
    .expect("src/version.js declares VERSION");

  let out = Path::new(&env::var("OUT_DIR").expect("OUT_DIR")).to_path_buf();
  fs::write(out.join("help.txt"), help).expect("write help.txt");
  fs::write(out.join("version.txt"), version).expect("write version.txt");
}

fn between<'a>(source: &'a str, open: &str, close: &str) -> Option<&'a str> {
  let start = source.find(open)? + open.len();
  let length = source[start..].find(close)?;
  Some(&source[start..start + length])
}
