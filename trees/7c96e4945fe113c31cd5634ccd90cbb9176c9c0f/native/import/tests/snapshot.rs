//! The ref snapshot an import records is the source's refs as
//! `git for-each-ref` lists them, and its `HEAD`, each with its own kind
//! (objects.md §6), on SHA-1 and SHA-256 sources.

use causet_store::id::{GitAlgorithm, hex};
use causet_store::objects::{RefTarget, Snapshot};
use causet_store::store::Store;
use std::path::{Path, PathBuf};
use std::process::Command;

fn scratch(name: &str) -> PathBuf {
  let directory =
    std::env::temp_dir().join(format!("causet-import-test-{}-{name}", std::process::id()));
  let _ = std::fs::remove_dir_all(&directory);
  std::fs::create_dir_all(&directory).unwrap();
  directory
}

/// `git` in `repo`, isolated from the caller's configuration, with a fixed
/// identity; its trimmed standard output.
fn git(repo: &Path, args: &[&str], input: Option<&[u8]>) -> String {
  let empty = repo.parent().unwrap().join("empty-config");
  std::fs::write(&empty, b"").unwrap();
  let mut command = Command::new("git");
  command
    .args(args)
    .current_dir(repo)
    .env("GIT_CONFIG_NOSYSTEM", "1")
    .env("GIT_CONFIG_GLOBAL", &empty)
    .env("GIT_AUTHOR_NAME", "A U Thor")
    .env("GIT_AUTHOR_EMAIL", "author@example.com")
    .env("GIT_AUTHOR_DATE", "1112911993 -0700")
    .env("GIT_COMMITTER_NAME", "C O Mitter")
    .env("GIT_COMMITTER_EMAIL", "committer@example.com")
    .env("GIT_COMMITTER_DATE", "1112911993 -0700")
    .stdin(std::process::Stdio::piped())
    .stdout(std::process::Stdio::piped())
    .stderr(std::process::Stdio::piped());
  let mut child = command.spawn().unwrap();
  {
    use std::io::Write as _;
    let mut stdin = child.stdin.take().unwrap();
    if let Some(input) = input {
      stdin.write_all(input).unwrap();
    }
  }
  let output = child.wait_with_output().unwrap();
  assert!(
    output.status.success(),
    "git {args:?}: {}",
    String::from_utf8_lossy(&output.stderr)
  );
  String::from_utf8(output.stdout).unwrap().trim().to_string()
}

/// A history with a ref of every family objects.md §6 names: branches, a
/// remote-tracking branch and its symbolic `HEAD`, a tag on a tree, a
/// replacement, notes, a stash, a bisect ref, and cst's own refs.
fn source(root: &Path, format: &str) -> PathBuf {
  let repo = root.join("source");
  std::fs::create_dir_all(&repo).unwrap();
  git(
    &repo,
    &[
      "init",
      "-q",
      "-b",
      "main",
      &format!("--object-format={format}"),
    ],
    None,
  );
  let blob = git(&repo, &["hash-object", "-w", "--stdin"], Some(b"hello\n"));
  let tree = git(
    &repo,
    &["mktree"],
    Some(format!("100644 blob {blob}\thello.txt\n").as_bytes()),
  );
  let first = git(&repo, &["commit-tree", &tree, "-m", "one"], None);
  let second = git(
    &repo,
    &["commit-tree", &tree, "-p", &first, "-m", "two"],
    None,
  );
  for (name, id) in [
    ("refs/heads/main", &second),
    ("refs/heads/topic", &first),
    ("refs/remotes/origin/main", &first),
    ("refs/tags/tree", &tree),
    ("refs/notes/commits", &first),
    ("refs/stash", &second),
    ("refs/bisect/bad", &second),
    ("refs/causet/records/x", &blob),
  ] {
    git(&repo, &["update-ref", name, id], None);
  }
  git(
    &repo,
    &[
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/main",
    ],
    None,
  );
  // A chain: each link is recorded as itself, not where the chain ends.
  git(
    &repo,
    &["symbolic-ref", "refs/heads/alias", "refs/heads/main"],
    None,
  );
  git(
    &repo,
    &["symbolic-ref", "refs/heads/alias2", "refs/heads/alias"],
    None,
  );
  git(&repo, &["replace", &first, &second], None);
  repo
}

/// The snapshot's refs as (name, Git ID it resolves to, symbolic target).
fn recorded(store: &Store) -> Vec<(String, Option<String>, Option<String>)> {
  let snapshot: Snapshot = store.refs().unwrap();
  let resolve = |name: &[u8]| {
    let mut name = name.to_vec();
    for _ in 0..=snapshot.refs.len() {
      match &snapshot
        .refs
        .iter()
        .find(|entry| entry.name == name)?
        .target
      {
        RefTarget::Direct(id) => return Some(hex(&store.git(snapshot.algorithm, id).unwrap().unwrap())),
        RefTarget::Symbolic(target) => name = target.clone(),
      }
    }
    None
  };
  snapshot
    .refs
    .iter()
    .map(|entry| {
      let symbolic = match &entry.target {
        RefTarget::Direct(_) => None,
        RefTarget::Symbolic(target) => Some(String::from_utf8(target.clone()).unwrap()),
      };
      (
        String::from_utf8(entry.name.clone()).unwrap(),
        resolve(&entry.name),
        symbolic,
      )
    })
    .collect()
}

/// The refs as Git lists them, in the same shape, `HEAD` included.
fn listed(repo: &Path) -> Vec<(String, Option<String>, Option<String>)> {
  let mut refs: Vec<_> = git(
    repo,
    &[
      "for-each-ref",
      "--format=%(refname) %(objectname) %(symref)",
    ],
    None,
  )
  .lines()
  .map(|line| {
    // The last line's empty `%(symref)` is trimmed with the output.
    let mut fields = line.splitn(3, ' ');
    let (name, id) = (fields.next().unwrap(), fields.next().unwrap());
    // `%(symref)` is where a chain ends; the ref itself points one step.
    let symbolic = (!fields.next().unwrap_or("").is_empty())
      .then(|| git(repo, &["symbolic-ref", "--no-recurse", name], None));
    (name.to_string(), Some(id.to_string()), symbolic)
  })
  .collect();
  let head = git(
    repo,
    &["symbolic-ref", "--quiet", "--no-recurse", "HEAD"],
    None,
  );
  let resolved = refs
    .iter()
    .find(|(name, _, _)| *name == head)
    .and_then(|(_, id, _)| id.clone());
  refs.push(("HEAD".into(), resolved, Some(head)));
  refs.sort();
  refs
}

#[test]
fn the_snapshot_records_every_ref_git_lists_with_its_own_kind() {
  for (format, algorithm) in [
    ("sha1", GitAlgorithm::Sha1),
    ("sha256", GitAlgorithm::Sha256),
  ] {
    let root = scratch(&format!("snapshot-{format}"));
    let repo = source(&root, format);
    let destination = root.join("native");
    let imported = causet_import::import(repo.to_str().unwrap(), &destination).unwrap();
    let store = Store::open(&destination).unwrap();
    assert_eq!(store.refs().unwrap().algorithm, algorithm);
    let mut snapshot = recorded(&store);
    snapshot.sort();
    assert_eq!(snapshot, listed(&repo), "{format}");
    assert_eq!((imported.refs, imported.symbolic), (snapshot.len(), 4));
    assert_eq!(Some(store.snapshot), imported.snapshot);
    std::fs::remove_dir_all(&root).unwrap();
  }
}

#[test]
fn an_unborn_or_detached_head_is_recorded_as_it_is() {
  let root = scratch("head");
  let repo = source(&root, "sha1");
  git(&repo, &["symbolic-ref", "HEAD", "refs/heads/unborn"], None);
  let unborn = root.join("unborn");
  let imported = causet_import::import(repo.to_str().unwrap(), &unborn).unwrap();
  assert_eq!(imported.head, None);
  let head = recorded(&Store::open(&unborn).unwrap())
    .into_iter()
    .find(|(name, _, _)| name == "HEAD")
    .unwrap();
  assert_eq!(
    head,
    ("HEAD".into(), None, Some("refs/heads/unborn".into()))
  );

  let topic = git(&repo, &["rev-parse", "refs/heads/topic"], None);
  git(&repo, &["update-ref", "--no-deref", "HEAD", &topic], None);
  let detached = root.join("detached");
  let imported = causet_import::import(repo.to_str().unwrap(), &detached).unwrap();
  let store = Store::open(&detached).unwrap();
  let head = recorded(&store)
    .into_iter()
    .find(|(name, _, _)| name == "HEAD")
    .unwrap();
  assert_eq!(head, ("HEAD".into(), Some(topic.clone()), None));
  assert_eq!(hex(&store.git(GitAlgorithm::Sha1, &imported.head.unwrap()).unwrap().unwrap()), topic);
  std::fs::remove_dir_all(&root).unwrap();
}

/// Makes `name` name a commit the repository then loses: the commit is
/// written loose and its file removed, so the ref is left naming an object
/// the repository does not hold, whatever the ref storage.
fn break_ref(repo: &Path, name: &str) -> String {
  let tree = git(repo, &["rev-parse", "HEAD^{tree}"], None);
  let lost = git(repo, &["commit-tree", &tree, "-m", "lost"], None);
  git(repo, &["update-ref", name, &lost], None);
  let objects = PathBuf::from(git(repo, &["rev-parse", "--git-path", "objects"], None));
  let objects = if objects.is_absolute() { objects } else { repo.join(objects) };
  std::fs::remove_file(objects.join(&lost[..2]).join(&lost[2..])).unwrap();
  lost
}

#[test]
fn a_ref_naming_an_object_the_source_does_not_hold_is_refused_by_name() {
  let root = scratch("broken-ref");
  let repo = source(&root, "sha1");
  let lost = break_ref(&repo, "refs/heads/broken");
  let destination = root.join("native");
  let refused = causet_import::import(repo.to_str().unwrap(), &destination).unwrap_err();
  assert_eq!(refused.code, "unsupported-repository-shape", "{}", refused.message);
  assert!(refused.message.contains("refs/heads/broken"), "{}", refused.message);
  assert!(refused.message.contains(&lost), "{}", refused.message);
  assert!(refused.message.ends_with("cannot be imported exactly (ADR-0045, decision 1)."), "{}", refused.message);
  assert!(!destination.exists(), "nothing is written");
  std::fs::remove_dir_all(&root).unwrap();
}

#[test]
fn another_worktrees_head_naming_an_object_the_source_does_not_hold_is_refused_by_name() {
  let root = scratch("broken-worktree-head");
  let repo = source(&root, "sha1");
  let linked = root.join("linked");
  git(&repo, &["worktree", "add", "-q", "--detach", linked.to_str().unwrap(), "HEAD"], None);
  let lost = break_ref(&linked, "HEAD");
  let destination = root.join("native");
  let refused = causet_import::import(repo.to_str().unwrap(), &destination).unwrap_err();
  assert_eq!(refused.code, "unsupported-repository-shape", "{}", refused.message);
  assert!(refused.message.contains("the HEAD of the worktree"), "{}", refused.message);
  assert!(refused.message.contains(&lost), "{}", refused.message);
  assert!(!destination.exists(), "nothing is written");
  std::fs::remove_dir_all(&root).unwrap();
}
