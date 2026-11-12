//! The reconstruction check (objects.md §9.2) on stores written to order: the
//! contract's example history rebuilds to its Git IDs in both algorithms, and
//! each way a row can fail to rebuild is named, without stopping the rest.

use causet_store::id::{GitAlgorithm, NativeId, Type, hex, unhex};
use causet_store::objects::{
  Entry, GitKind, Kind, Preserved, Ref, RefTarget, Snapshot, Target, Tree,
};
use causet_store::reconstruct::{self, Rebuilt};
use causet_store::store::{Store, StoreWriter};
use std::path::PathBuf;

fn scratch(name: &str) -> PathBuf {
  let directory = std::env::temp_dir().join(format!(
    "causet-reconstruct-test-{}-{name}",
    std::process::id()
  ));
  let _ = std::fs::remove_dir_all(&directory);
  directory
}

/// A Git SHA-1 ID, as hex.
fn sha1(object: &str) -> String {
  use sha1_checked::Digest as _;
  hex(&sha1_checked::Sha1::digest(object.as_bytes()))
}

fn digest(text: &str) -> Vec<u8> {
  unhex(text).unwrap()
}

fn commit(tree: &str) -> Vec<u8> {
  format!(
    "tree {tree}\n\
     author A U Thor <author@example.com> 1112911993 -0700\n\
     committer C O Mitter <committer@example.com> 1112911993 -0700\n\nAdd hello\n"
  )
  .into_bytes()
}

/// The example history in `algorithm`, given its blob, tree and commit IDs:
/// `hello.txt` holding "hello\n", committed and named by `main` and `HEAD`.
fn example(name: &str, algorithm: GitAlgorithm, ids: [&str; 3]) -> PathBuf {
  let root = scratch(name);
  let mut writer = StoreWriter::create(&root, algorithm).unwrap();
  let content = writer.put_content(b"hello\n").unwrap();
  let tree = writer
    .put_tree(
      &Tree::from_entries(vec![Entry {
        name: b"hello.txt".to_vec(),
        kind: Kind::File,
        target: Target::Native(content),
      }])
      .unwrap(),
    )
    .unwrap();
  let commit = writer
    .put_preserved(&Preserved {
      algorithm,
      kind: GitKind::Commit,
      payload: commit(ids[1]),
    })
    .unwrap();
  for (id, native) in ids.iter().zip([content, tree, commit]) {
    writer.alias(digest(id), native);
  }
  let snapshot = Snapshot::new(
    algorithm,
    vec![
      Ref {
        name: b"HEAD".to_vec(),
        target: RefTarget::Symbolic(b"refs/heads/main".to_vec()),
      },
      Ref {
        name: b"refs/heads/main".to_vec(),
        target: RefTarget::Direct(commit),
      },
    ],
  )
  .unwrap();
  writer.finish(&snapshot).unwrap();
  root
}

#[test]
fn the_contracts_example_history_rebuilds_to_its_git_ids() {
  for (algorithm, ids) in [
    (
      GitAlgorithm::Sha1,
      [
        "ce013625030ba8dba906f756967f9e9ca394464a",
        "aaa96ced2d9a1c8e72c56b253a0e2fe78393feb7",
        "2425d53ec1283e808c60bcaea110ba01aca5a887",
      ],
    ),
    (
      GitAlgorithm::Sha256,
      [
        "2cf8d83d9ee29543b34a87727421fdecb7e3f3a183d337639025de576db9ebb4",
        "c7187e8fdb691b3a692e5f3f0bbcb6359e5046285225f18f9773d4fe54268c55",
        "d67e9860887d4eb2d617c2ce3a4aa12da94725a45596320a6a6b3b479bcf0fb8",
      ],
    ),
  ] {
    let root = example(&format!("example-{}", algorithm.name()), algorithm, ids);
    let found = reconstruct::check(&Store::open(&root).unwrap()).unwrap();
    assert!(found.failures.is_empty(), "{:?}", found.failures);
    assert_eq!(found.rows, 3);
    assert_eq!(
      found.rebuilt,
      Rebuilt {
        blobs: 1,
        trees: 1,
        commits: 1,
        tags: 0
      }
    );
    std::fs::remove_dir_all(&root).unwrap();
  }
}

#[test]
fn each_row_that_does_not_rebuild_is_named_and_the_rest_are_still_checked() {
  let root = scratch("failures");
  let mut writer = StoreWriter::create(&root, GitAlgorithm::Sha1).unwrap();
  let hello = writer.put_content(b"hello\n").unwrap();
  // "hello\n" under the Git ID of "world\n".
  writer.alias(digest("cc628ccd10742baea8241c5924df992b5c019f71"), hello);
  // A tree naming content that has no row.
  let orphan = writer.put_content(b"orphan\n").unwrap();
  let tree = writer
    .put_tree(
      &Tree::from_entries(vec![Entry {
        name: b"x".to_vec(),
        kind: Kind::File,
        target: Target::Native(orphan),
      }])
      .unwrap(),
    )
    .unwrap();
  writer.alias(vec![0x11; 20], tree);
  // A commit built on a tree that has no row.
  let commit = writer
    .put_preserved(&Preserved {
      algorithm: GitAlgorithm::Sha1,
      kind: GitKind::Commit,
      payload: commit("aaa96ced2d9a1c8e72c56b253a0e2fe78393feb7"),
    })
    .unwrap();
  writer.alias(digest("2425d53ec1283e808c60bcaea110ba01aca5a887"), commit);
  // A kept tree, `040000 sub` naming the empty tree, which has no row.
  let mut payload = b"040000 sub\0".to_vec();
  payload.extend(digest("4b825dc642cb6eb9a060e54bf8d69288fbee4904"));
  let kept = writer
    .put_preserved(&Preserved {
      algorithm: GitAlgorithm::Sha1,
      kind: GitKind::Tree,
      payload,
    })
    .unwrap();
  writer.alias(vec![0x22; 20], kept);
  // A SHA-256 object in the SHA-1 file.
  let foreign = writer
    .put_preserved(&Preserved {
      algorithm: GitAlgorithm::Sha256,
      kind: GitKind::Tag,
      payload: b"not parsed".to_vec(),
    })
    .unwrap();
  writer.alias(vec![0x33; 20], foreign);
  // A ref snapshot, which no Git object becomes, and an object the store
  // does not hold.
  let snapshot = Snapshot::new(GitAlgorithm::Sha1, Vec::new()).unwrap();
  writer.alias(
    vec![0x44; 20],
    NativeId::of(Type::Snapshot, &snapshot.encode()),
  );
  let missing = NativeId([0x07; 32]);
  writer.alias(vec![0x55; 20], missing);
  // And one row that rebuilds.
  let empty = writer.put_tree(&Tree::default()).unwrap();
  writer.alias(digest("4b825dc642cb6eb9a060e54bf8d69288fbee4904"), empty);
  writer.finish(&snapshot).unwrap();

  let found = reconstruct::check(&Store::open(&root).unwrap()).unwrap();
  assert_eq!(found.rows, 8);
  assert_eq!(
    found.rebuilt,
    Rebuilt {
      trees: 1,
      ..Rebuilt::default()
    }
  );
  let why: Vec<(String, String)> = found
    .failures
    .iter()
    .filter_map(|failure| Some((failure.git.as_ref()?.hex(), failure.why.clone())))
    .collect();
  let named = |id: &str| -> String {
    why
      .iter()
      .find(|(git, _)| git == id)
      .unwrap_or_else(|| panic!("{id} is not named: {why:?}"))
      .1
      .clone()
  };
  assert_eq!(why.len(), 7, "{why:?}");
  // The content only the failing tree names has no row of its own either.
  let unaliased: Vec<String> = found
    .failures
    .iter()
    .filter(|failure| failure.git.is_none())
    .map(ToString::to_string)
    .collect();
  assert_eq!(
    unaliased,
    [format!(
      "native {orphan}: it is content no chunk list names, which has no alias row"
    )]
  );
  assert_eq!(
    named("cc628ccd10742baea8241c5924df992b5c019f71"),
    "it rebuilds to ce013625030ba8dba906f756967f9e9ca394464a"
  );
  assert_eq!(
    named(&hex(&[0x11; 20])),
    format!("its entry x names {orphan}, which has no sha1 alias row")
  );
  assert_eq!(
    named("2425d53ec1283e808c60bcaea110ba01aca5a887"),
    "it names sha1 aaa96ced2d9a1c8e72c56b253a0e2fe78393feb7, which has no alias row"
  );
  // The empty tree has a row, so the kept tree's entry is found, and the
  // kept tree fails only on its own ID.
  assert!(
    named(&hex(&[0x22; 20])).starts_with("it rebuilds to "),
    "{why:?}"
  );
  assert_eq!(
    named(&hex(&[0x33; 20])),
    "it is a preserved sha256 object, in the sha1 alias file"
  );
  assert_eq!(
    named(&hex(&[0x44; 20])),
    "it is a ref snapshot, which no Git object becomes"
  );
  // The row holds only the missing object's short reference, which no index
  // entry's name begins with, so it names no native object.
  assert_eq!(
    named(&hex(&[0x55; 20])),
    format!(
      "it names {}, a short reference no index entry's name begins with",
      hex(&missing.short())
    )
  );
  let unresolved = found
    .failures
    .iter()
    .find(|failure| failure.git.as_ref().is_some_and(|git| git.digest == [0x55; 20]))
    .unwrap();
  assert_eq!(unresolved.native, None);
  assert_eq!(
    unresolved.to_string(),
    format!("sha1 {}: {}", hex(&[0x55; 20]), unresolved.why)
  );
  let shown = found.failures[0].to_string();
  assert!(
    shown.starts_with(&format!(
      "sha1 {} (native ",
      found.failures[0].git.as_ref().unwrap().hex()
    )),
    "{shown}"
  );
  std::fs::remove_dir_all(&root).unwrap();
}

#[test]
fn a_kept_tree_naming_an_object_with_no_row_is_named() {
  let root = scratch("kept");
  let mut writer = StoreWriter::create(&root, GitAlgorithm::Sha1).unwrap();
  let mut payload = b"040000 sub\0".to_vec();
  payload.extend(digest("4b825dc642cb6eb9a060e54bf8d69288fbee4904"));
  // A submodule link is not followed, so it needs no row.
  payload.extend(b"160000 link\0");
  payload.extend([0x66; 20]);
  let kept = writer
    .put_preserved(&Preserved {
      algorithm: GitAlgorithm::Sha1,
      kind: GitKind::Tree,
      payload,
    })
    .unwrap();
  writer.alias(vec![0x22; 20], kept);
  writer
    .finish(&Snapshot::new(GitAlgorithm::Sha1, Vec::new()).unwrap())
    .unwrap();
  let found = reconstruct::check(&Store::open(&root).unwrap()).unwrap();
  assert_eq!(found.failures.len(), 1);
  assert_eq!(
    found.failures[0].why,
    "it names sha1 4b825dc642cb6eb9a060e54bf8d69288fbee4904, which has no alias row"
  );
  std::fs::remove_dir_all(&root).unwrap();
}

#[test]
fn only_the_header_lines_git_reads_are_followed() {
  let root = scratch("headers");
  let mut writer = StoreWriter::create(&root, GitAlgorithm::Sha1).unwrap();
  let empty = writer.put_tree(&Tree::default()).unwrap();
  writer.alias(digest("4b825dc642cb6eb9a060e54bf8d69288fbee4904"), empty);
  // Git reads a commit's first line as its tree and the `parent` lines
  // straight after it as its parents, and a tag's first line as its object;
  // a later `tree`, `parent` or `object` line names nothing it follows.
  let late = "2222222222222222222222222222222222222222";
  let payload = format!(
    "tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\n\
     author A <a@e> 1 +0000\nparent {late}\ncommitter C <c@e> 1 +0000\ntree {late}\n\nlate\n"
  );
  let commit = writer
    .put_preserved(&Preserved {
      algorithm: GitAlgorithm::Sha1,
      kind: GitKind::Commit,
      payload: payload.clone().into_bytes(),
    })
    .unwrap();
  let id = sha1(&format!("commit {}\0{payload}", payload.len()));
  writer.alias(digest(&id), commit);
  let payload =
    format!("object {id}\ntype commit\ntag v\ntagger T <t@e> 1 +0000\nobject {late}\n\nmsg\n");
  let tag = writer
    .put_preserved(&Preserved {
      algorithm: GitAlgorithm::Sha1,
      kind: GitKind::Tag,
      payload: payload.clone().into_bytes(),
    })
    .unwrap();
  writer.alias(
    digest(&sha1(&format!("tag {}\0{payload}", payload.len()))),
    tag,
  );
  // A parent straight after the tree is followed.
  let payload = format!("tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\nparent {late}\n\nchild\n");
  let child = writer
    .put_preserved(&Preserved {
      algorithm: GitAlgorithm::Sha1,
      kind: GitKind::Commit,
      payload: payload.clone().into_bytes(),
    })
    .unwrap();
  writer.alias(
    digest(&sha1(&format!("commit {}\0{payload}", payload.len()))),
    child,
  );
  writer
    .finish(&Snapshot::new(GitAlgorithm::Sha1, Vec::new()).unwrap())
    .unwrap();
  let found = reconstruct::check(&Store::open(&root).unwrap()).unwrap();
  let why: Vec<&str> = found
    .failures
    .iter()
    .map(|failure| failure.why.as_str())
    .collect();
  assert_eq!(
    why,
    [format!("it names sha1 {late}, which has no alias row")]
  );
  assert_eq!(found.failures[0].native, Some(child));
  assert_eq!(
    (
      found.rebuilt.trees,
      found.rebuilt.commits,
      found.rebuilt.tags
    ),
    (1, 1, 1)
  );
  std::fs::remove_dir_all(&root).unwrap();
}

#[test]
fn an_object_the_store_holds_from_git_without_a_row_is_named() {
  let root = scratch("unaliased");
  let mut writer = StoreWriter::create(&root, GitAlgorithm::Sha1).unwrap();
  // Content cut into chunks: the chunks need no row, the content does.
  let large: Vec<u8> = (0..200_000u32)
    .map(|at| (at.wrapping_mul(2_654_435_761) >> 24) as u8)
    .collect();
  let content = writer.put_content(&large).unwrap();
  let tree = writer.put_tree(&Tree::default()).unwrap();
  let kept = writer
    .put_preserved(&Preserved {
      algorithm: GitAlgorithm::Sha1,
      kind: GitKind::Commit,
      payload: b"not parsed".to_vec(),
    })
    .unwrap();
  writer
    .finish(&Snapshot::new(GitAlgorithm::Sha1, Vec::new()).unwrap())
    .unwrap();
  let store = Store::open(&root).unwrap();
  assert!(store.chunk_list(&content).unwrap().chunks.len() > 1);
  let found = reconstruct::check(&store).unwrap();
  assert_eq!(found.rows, 0);
  let mut shown: Vec<String> = found.failures.iter().map(ToString::to_string).collect();
  shown.sort();
  let mut expected = vec![
    format!("native {content}: it is content no chunk list names, which has no alias row"),
    format!("native {tree}: it is a tree, which has no alias row"),
    format!("native {kept}: it is a preserved Git object, which has no alias row"),
  ];
  expected.sort();
  assert_eq!(shown, expected);
  std::fs::remove_dir_all(&root).unwrap();
}
