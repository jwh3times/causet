//! `log --format` as Git prints it. Every expected string here is what
//! `git log -1 --format=…` printed (Git 2.51) for a commit with the same
//! identity lines and message, made with `git hash-object --literally`.

use causet_history::commit::Commit;
use causet_history::pretty::{Failure, Format};
use causet_history::signature::Signature;
use causet_store::id::NativeId;

const ALL: &[u8] = b"[%an][%ae][%ad][%cn][%ce][%cd][%s][%b]";

fn commit(author: Option<&[u8]>, committer: &[u8], message: &[u8]) -> Commit {
  let signature = |line: Option<&[u8]>| line.map_or(Signature::None, Signature::from_line);
  Commit {
    tree: NativeId([7; 32]),
    parents: vec![NativeId([1; 32]), NativeId([2; 32])],
    author: signature(author),
    committer: signature(Some(committer)),
    encoding: None,
    actors: Vec::new(),
    change_id: None,
    derived_from: None,
    origin_commit: None,
    preserved: Some(NativeId([9; 32])),
    message: message.to_vec(),
  }
}

fn shown(format: &[u8], commit: &Commit) -> Result<Vec<u8>, String> {
  let short = |id: &NativeId| Ok::<_, ()>(id.hex()[..7].to_string());
  Format::parse(format)?
    .render(commit, &NativeId([5; 32]), &short)
    .map_err(|failure| format!("{failure:?}"))
}

#[test]
fn identities_dates_subject_and_body_print_as_git_prints_them() {
  let ordinary = commit(
    Some(b"A U Thor <author@example.com> 1112911993 -0700"),
    b"C O Mitter <committer@example.com> 1112912053 +0530",
    b"Subject line  \nsecond line\n\n\nBody para\n\nmore\n",
  );
  assert_eq!(
    shown(ALL, &ordinary).unwrap(),
    b"[A U Thor][author@example.com][Thu Apr 7 15:13:13 2005 -0700][C O Mitter][committer@example.com][Fri Apr 8 03:44:13 2005 +0530][Subject line second line][Body para\n\nmore\n]\n"
  );
}

#[test]
fn an_identity_git_cannot_split_prints_nothing_and_blank_lines_lead_no_subject() {
  let odd = commit(
    Some(b"nobody"),
    b"Odd <odd@example.com> 1112911993 +0060",
    b"\n  \nLater subject\n",
  );
  assert_eq!(
    shown(ALL, &odd).unwrap(),
    b"[][][][Odd][odd@example.com][Thu Apr 7 23:13:13 2005 +0060][Later subject][]\n"
  );
}

#[test]
fn a_name_keeps_its_leading_space_and_a_line_without_a_date_has_none() {
  let spaced = commit(
    Some(b" Spaced   <sp@example.com>   42   -0130"),
    b"<x@y> 0 +0000",
    b"only subject",
  );
  assert_eq!(
    shown(b"[%an][%ae][%cn][%ce][%cd]", &spaced).unwrap(),
    b"[ Spaced][sp@example.com][][x@y][Thu Jan 1 00:00:00 1970 +0000]\n"
  );
  let dateless = commit(
    Some(b"Dateless <d@example.com>"),
    b"Junk <j@example.com> notatime",
    b"\x01sub\x00ject\nline two\n\nbo\x00dy\n",
  );
  // A NUL ends the message, as it ends Git's C string.
  assert_eq!(
    shown(b"[%an][%ae][%ad][%cn][%cd][%s][%b]", &dateless).unwrap(),
    b"[Dateless][d@example.com][][Junk][][\x01sub][]\n"
  );
}

#[test]
fn far_dates_print_and_a_date_before_the_epoch_is_refused() {
  let far = commit(
    Some(b"Late <late@example.com> 4102444800 +1400"),
    b"Early <e@example.com> 86399 -1200",
    b"NY\n",
  );
  assert_eq!(
    shown(b"[%ad][%cd]", &far).unwrap(),
    b"[Fri Jan 1 14:00:00 2100 +1400][Thu Jan 1 11:59:59 1970 -1200]\n"
  );
  // Git dies: "Timestamp before Unix epoch: 42 -130".
  let early = commit(
    Some(b"Spaced <sp@example.com> 42 -0130"),
    b"<x@y> 0 +0000",
    b"x",
  );
  assert!(shown(b"%ad", &early).is_err());
}

#[test]
fn ids_print_full_or_abbreviated_and_format_separates_where_tformat_terminates() {
  let ordinary = commit(None, b"<x@y> 0 +0000", b"x");
  let full = |byte: u8| NativeId([byte; 32]).hex();
  assert_eq!(
    String::from_utf8(shown(b"%H %h|%T %t|%P|%p|%%|%n", &ordinary).unwrap()).unwrap(),
    format!(
      "{} {}|{} {}|{} {}|{} {}|%|\n\n",
      full(5),
      &full(5)[..7],
      full(7),
      &full(7)[..7],
      full(1),
      full(2),
      &full(1)[..7],
      &full(2)[..7]
    )
  );
  assert_eq!(shown(b"format:%s", &ordinary).unwrap(), b"x");
  assert_eq!(shown(b"tformat:%s", &ordinary).unwrap(), b"x\n");
  // Git's `commit_format_is_empty`: an empty `tformat:` ends with nothing,
  // and an empty `format:` still separates.
  assert_eq!(shown(b"tformat:", &ordinary).unwrap(), b"");
  assert!(!Format::parse(b"tformat:").unwrap().separated());
  assert!(Format::parse(b"format:").unwrap().separated());
  assert!(
    Format::parse(b"%G?").is_err(),
    "a placeholder not implemented is refused"
  );
  assert!(
    Format::parse(b"oneline").is_err(),
    "a named format is refused"
  );
}

#[test]
fn a_message_in_an_encoding_not_implemented_yet_is_refused_as_such() {
  let mut shift_jis = commit(None, b"<x@y> 0 +0000", b"x");
  shift_jis.encoding = Some(b"SHIFT_JIS".to_vec());
  let short = |id: &NativeId| Ok::<_, ()>(id.hex());
  let failed = Format::parse(b"%s")
    .unwrap()
    .render(&shift_jis, &NativeId([5; 32]), &short);
  assert!(
    matches!(failed, Err(Failure::Unimplemented(_))),
    "{failed:?}"
  );
}
