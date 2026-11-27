//! Which refs of an imported snapshot become names, and what each names
//! (docs/native-history/operations.md §4.1, ADR-0047 decision 9).

use causet_history::names::{self, Kind, Name, Target, Value};
use causet_store::id::{GitAlgorithm, NativeId, Type};
use causet_store::objects::{Ref, RefTarget, Snapshot};
use std::convert::Infallible;

fn object(text: &str) -> NativeId {
  NativeId::of(Type::Content, text.as_bytes())
}

fn direct(name: &str, target: &NativeId) -> Ref {
  Ref { name: name.as_bytes().to_vec(), target: RefTarget::Direct(*target) }
}

fn symbolic(name: &str, target: &str) -> Ref {
  Ref { name: name.as_bytes().to_vec(), target: RefTarget::Symbolic(target.as_bytes().to_vec()) }
}

fn named(kind: Kind, name: &str, target: Target) -> Name {
  Name { kind, name: name.as_bytes().to_vec(), local: false, value: Value::Resolved(target) }
}

/// The derivation, with every object's native form `object("native " + …)`
/// standing in for the native commit or tag import derived.
fn derived(refs: Vec<Ref>, forms: &[(&NativeId, &NativeId)]) -> Vec<Name> {
  let snapshot = Snapshot::new(GitAlgorithm::Sha1, refs).unwrap();
  names::from_snapshot(&snapshot, |id| {
    Ok::<_, Infallible>(forms.iter().find(|(git, _)| *git == id).map_or(*id, |(_, native)| **native))
  })
  .unwrap()
}

#[test]
fn branches_tags_and_remote_tracking_refs_become_names_and_every_other_ref_stays_in_the_snapshot() {
  let commit = object("a preserved commit");
  let native_commit = object("its native commit");
  let tag = object("a preserved tag");
  let native_tag = object("its native tag");
  let tree = object("a tree");
  let notes = object("the notes' carrier commit");
  let refs = vec![
    symbolic("HEAD", "refs/heads/main"),
    direct("refs/heads/main", &commit),
    direct("refs/heads/causet/ws/topic", &commit),
    direct("refs/tags/v1", &tag),
    direct("refs/tags/tree-tag", &tree),
    direct("refs/remotes/origin/main", &commit),
    symbolic("refs/remotes/origin/HEAD", "refs/remotes/origin/main"),
    // cst's records: facts, never names.
    direct("refs/notes/causet", &notes),
    direct("refs/notes/vcs-lab", &notes),
    direct("refs/causet/retention", &notes),
    direct("refs/causet/quarantine/abc", &notes),
    direct("refs/vcs-lab/retention", &notes),
    // The bridge's alone.
    direct("refs/notes/commits", &notes),
    direct("refs/stash", &commit),
    direct("refs/replace/0123", &commit),
    direct("refs/bisect/bad", &commit),
    direct("refs/worktree/x", &commit),
    direct("refs/causet-remote/origin/notes", &notes),
    direct("refs/other/thing", &commit),
  ];
  let names = derived(refs, &[(&commit, &native_commit), (&tag, &native_tag)]);
  assert_eq!(
    names,
    vec![
      named(Kind::Branch, "causet/ws/topic", Target::Object(native_commit)),
      named(Kind::Branch, "main", Target::Object(native_commit)),
      named(Kind::Tag, "tree-tag", Target::Object(tree)),
      named(Kind::Tag, "v1", Target::Object(native_tag)),
      named(Kind::RemoteTracking, "origin/HEAD", Target::Name(Kind::RemoteTracking, b"origin/main".to_vec())),
      named(Kind::RemoteTracking, "origin/main", Target::Object(native_commit)),
    ]
  );
}

#[test]
fn a_symbolic_ref_names_a_name_only_when_its_target_is_in_one_of_the_three_namespaces() {
  let commit = object("a commit");
  let refs = vec![
    direct("refs/heads/main", &commit),
    // To another kind's namespace, and to a name the snapshot does not hold.
    symbolic("refs/heads/to-tag", "refs/tags/v1"),
    symbolic("refs/tags/to-remote", "refs/remotes/origin/main"),
    symbolic("refs/heads/dangling", "refs/heads/gone"),
    // To refs that are no names: snapshot only.
    symbolic("refs/heads/to-head", "HEAD"),
    symbolic("refs/heads/to-notes", "refs/notes/causet"),
    symbolic("refs/remotes/origin/to-stash", "refs/stash"),
    // A namespace with nothing after it is no name.
    symbolic("refs/heads/to-nothing", "refs/heads/"),
  ];
  let names = derived(refs, &[]);
  assert_eq!(
    names,
    vec![
      named(Kind::Branch, "dangling", Target::Name(Kind::Branch, b"gone".to_vec())),
      named(Kind::Branch, "main", Target::Object(commit)),
      named(Kind::Branch, "to-tag", Target::Name(Kind::Tag, b"v1".to_vec())),
      named(Kind::Tag, "to-remote", Target::Name(Kind::RemoteTracking, b"origin/main".to_vec())),
    ]
  );
}

#[test]
fn a_name_need_not_be_utf8_and_keeps_its_bytes() {
  let commit = object("a commit");
  let refs = vec![Ref { name: b"refs/heads/caf\xe9".to_vec(), target: RefTarget::Direct(commit) }];
  let names = derived(refs, &[]);
  assert_eq!(names, vec![Name { kind: Kind::Branch, name: b"caf\xe9".to_vec(), local: false, value: Value::Resolved(Target::Object(commit)) }]);
}

#[test]
fn each_kind_has_its_code_word_and_namespace() {
  let kinds = [Kind::Branch, Kind::Tag, Kind::RemoteTracking];
  let described: Vec<(u8, &str, &[u8])> = kinds.iter().map(|kind| (kind.code(), kind.word(), kind.namespace())).collect();
  assert_eq!(
    described,
    vec![
      (0x01, "branch", &b"refs/heads/"[..]),
      (0x02, "tag", &b"refs/tags/"[..]),
      (0x03, "remote-tracking", &b"refs/remotes/"[..]),
    ]
  );
  assert_eq!(Kind::Tag.reference(b"v1"), b"refs/tags/v1".to_vec());
}
