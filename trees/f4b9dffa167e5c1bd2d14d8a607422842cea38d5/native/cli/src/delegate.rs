//! Delegation to the JavaScript CLI (ADR-0037, decision 4): an unported
//! command runs `node bin/vlab.js` with the same arguments, environment,
//! working directory and standard streams, and its exit code becomes ours.
//! It adds exactly one process on Windows and none on POSIX, where the
//! JavaScript CLI replaces this process.

use crate::environment;
use std::{
  env,
  ffi::OsString,
  io,
  path::{Path, PathBuf},
  process::Command,
};

/// The environment variable that names the JavaScript entry point to delegate
/// to, for layouts where it is not beside an ancestor of this executable.
pub const ENTRY_VARIABLE: &str = "CAUSET_JS_CLI";

/// The JavaScript CLI's entry point: `CAUSET_JS_CLI` (or `VLAB_JS_CLI`) if
/// set, otherwise the
/// first ancestor directory of this executable that holds a package with
/// `bin/vlab.js`. That covers the repository build (`native/target/release`)
/// and the npm package (`bin/native`, ADR-0038) alike.
pub fn entry_point() -> Result<PathBuf, String> {
  if let Some(named) = environment::value_os("JS_CLI").filter(|value| !value.is_empty()) {
    return Ok(PathBuf::from(named));
  }
  let executable = env::current_exe()
    .and_then(resolve_links)
    .map_err(|error| format!("the location of this executable is unknown: {error}"))?;
  executable
    .ancestors()
    .skip(1)
    .map(|directory| directory.join("bin").join("vlab.js"))
    .find(|candidate| is_package_entry(candidate))
    .ok_or_else(|| {
      format!(
        "no JavaScript CLI (bin/vlab.js) was found above {}; set {ENTRY_VARIABLE} to its path",
        executable.display()
      )
    })
}

/// An npm bin link on POSIX is a symlink, and the package is found from its
/// target. Windows links bins with shims, and canonicalizing there yields a
/// `\\?\` verbatim path that Node cannot load an entry point from.
#[cfg(unix)]
fn resolve_links(path: PathBuf) -> io::Result<PathBuf> {
  path.canonicalize()
}

#[cfg(not(unix))]
fn resolve_links(path: PathBuf) -> io::Result<PathBuf> {
  Ok(path)
}

fn is_package_entry(candidate: &Path) -> bool {
  candidate.is_file()
    && candidate
      .parent()
      .and_then(Path::parent)
      .is_some_and(|package| package.join("package.json").is_file())
}

/// Run the JavaScript CLI in place of this invocation and return its exit
/// code. On POSIX this returns only if the JavaScript CLI could not start.
pub fn run(entry: &Path, args: &[OsString]) -> io::Result<i32> {
  let mut command = Command::new("node");
  command.arg(entry).args(args);
  hand_over(command)
}

#[cfg(unix)]
fn hand_over(mut command: Command) -> io::Result<i32> {
  use std::os::unix::process::CommandExt;
  Err(command.exec())
}

#[cfg(not(unix))]
fn hand_over(mut command: Command) -> io::Result<i32> {
  let status = command.status()?;
  // Without a code the child was ended from outside; report it as a failure.
  Ok(status.code().unwrap_or(1))
}
