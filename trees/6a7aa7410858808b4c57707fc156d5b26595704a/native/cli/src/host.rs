//! What the notes lock and record ids need from the operating system, as Node
//! provides it: `os.hostname()`, `process.kill(pid, 0)`, `randomBytes`, and
//! the test hooks of `src/faults.js`.

/// `os.hostname()`, read once per process. Every crate here forbids
/// `unsafe` (ADR-0037), so the name comes from the kernel's own file on
/// Linux and from the system `hostname` command elsewhere, which prints the
/// same case-preserved name Node reports.
pub fn hostname() -> String {
  static NAME: std::sync::OnceLock<String> = std::sync::OnceLock::new();
  NAME
    .get_or_init(|| {
      if let Ok(name) = std::fs::read_to_string("/proc/sys/kernel/hostname") {
        return name.trim().to_string();
      }
      std::process::Command::new("hostname")
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .unwrap_or_default()
    })
    .clone()
}

/// `process.kill(pid, 0)` succeeding, or failing with `EPERM`: a process this
/// one may not signal is still a process. Asked of the system, because the
/// check is only made for a lock its holder may have abandoned.
pub fn process_is_running(pid: i64) -> bool {
  if pid <= 0 {
    return false;
  }
  if cfg!(windows) {
    let filter = format!("PID eq {pid}");
    return std::process::Command::new("tasklist")
      .args(["/FI", &filter, "/NH", "/FO", "CSV"])
      .stdin(std::process::Stdio::null())
      .stderr(std::process::Stdio::null())
      .output()
      .is_ok_and(|output| String::from_utf8_lossy(&output.stdout).contains(&format!("\"{pid}\"")));
  }
  if std::path::Path::new("/proc/self").exists() {
    return std::path::Path::new(&format!("/proc/{pid}")).exists();
  }
  std::process::Command::new("kill")
    .args(["-0", &pid.to_string()])
    .stdin(std::process::Stdio::null())
    .output()
    .is_ok_and(|output| {
      output.status.success()
        || String::from_utf8_lossy(&output.stderr).to_lowercase().contains("not permitted")
    })
}

/// `Date.now()`.
pub fn now_ms() -> f64 {
  std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map_or(0.0, |elapsed| elapsed.as_millis() as f64)
}

/// `newId(prefix)`: the model's identifier, from the clock and the system CSPRNG.
pub fn new_id(prefix: &str) -> String {
  causet_model::ids::new_id(prefix).expect("the operating system's random source")
}

/// Exit code used when a fault point fires (`FAULT_EXIT_CODE`).
const FAULT_EXIT_CODE: i32 = 70;
/// Exit code used when a gate is never released (`GATE_EXIT_CODE`).
const GATE_EXIT_CODE: i32 = 71;

fn stop(message: &str, code: i32) -> ! {
  use std::io::Write as _;
  let _ = std::io::stderr().write_all(message.as_bytes());
  std::process::exit(code);
}

/// `faultPoint(name)`: exit here, with no unwinding, when
/// `CAUSET_TEST_FAULT` names this point.
pub fn fault_point(name: &str) {
  if std::env::var("CAUSET_TEST_FAULT").as_deref() == Ok(name) {
    stop(&format!("cst: fault injected at {name}\n"), FAULT_EXIT_CODE);
  }
}

/// `gatePoint(name)`: wait here until the test creates `CAUSET_TEST_GATE_FILE`,
/// after announcing arrival in `<file>.reached`.
pub fn gate_point(name: &str) {
  if std::env::var("CAUSET_TEST_GATE").as_deref() != Ok(name) {
    return;
  }
  let Some(file) = std::env::var_os("CAUSET_TEST_GATE_FILE").filter(|file| !file.is_empty()) else {
    stop(
      &format!("cst: gate {name} requested without CAUSET_TEST_GATE_FILE\n"),
      GATE_EXIT_CODE,
    );
  };
  let file = std::path::PathBuf::from(file);
  let mut reached = file.clone().into_os_string();
  reached.push(".reached");
  let _ = std::fs::write(&reached, format!("{}\n", std::process::id()));
  let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
  while !file.exists() {
    if std::time::Instant::now() > deadline {
      stop(&format!("cst: gate {name} was never released\n"), GATE_EXIT_CODE);
    }
    std::thread::sleep(std::time::Duration::from_millis(20));
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn ids_have_the_javascript_shape() {
    let id = new_id("prov");
    assert_eq!(id.len(), "prov_".len() + 9 + 12, "{id}");
    assert!(id.starts_with("prov_"));
    assert!(id[5..].chars().all(|c| c.is_ascii_digit() || c.is_ascii_lowercase()));
    assert_ne!(new_id("prov"), new_id("prov"));
  }

  #[test]
  fn this_process_is_running() {
    assert!(process_is_running(i64::from(std::process::id())));
    assert!(!hostname().is_empty());
  }
}
