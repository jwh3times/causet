//! Dependency-free, reproducible mutation fuzz target for the Git engine's
//! parsers of Git output. Run with a case count and an optional integer seed;
//! any panic fails the run.
#![forbid(unsafe_code)]

fn main() {
  let cases: usize = std::env::args()
    .nth(1)
    .unwrap_or("200000".into())
    .parse()
    .expect("case count");
  let mut state: u64 = std::env::args()
    .nth(2)
    .unwrap_or("83".into())
    .parse()
    .expect("seed");
  let oid = "a".repeat(40);
  let mut note_tree = b"100644 ".to_vec();
  note_tree.extend(oid.as_bytes());
  note_tree.push(0);
  note_tree.extend([0x11; 20]);
  note_tree.extend(b"40000 ab\0");
  note_tree.extend([0x22; 20]);
  let seeds: Vec<Vec<u8>> = vec![
    format!("{oid} blob 5\nhello\n{oid} missing\n").into_bytes(),
    format!("\0{oid}\0subject\0subject\n\nChange-Id: ch_x\n\0\nsrc/a.rs\0b\0\0{oid}\0s\0m\0").into_bytes(),
    format!("{oid}\x1f1700000000\x1fsubject\n\nChange-Id: ch_x\x1e\n{oid}\x1f1\x1fx\x1e").into_bytes(),
    format!("# branch.oid {oid}\0# branch.head main\01 .M N... 100644 100644 100644 {oid} {oid} a\02 R. N... 100644 100644 100644 {oid} {oid} R100 b\0c\0? d\0").into_bytes(),
    format!("100644 {oid} 0\tpath with space\0160000 {oid} 2\tsub\0H 100644 {oid} 0\tx\0? y\0").into_bytes(),
    format!("worktree /a\0HEAD {oid}\0branch refs/heads/main\0\0worktree /b\0detached\0locked reason\0prunable\0\0").into_bytes(),
    format!("1\0{oid}\0\0").into_bytes(),
    format!("0\0{oid}\0conflict\0").into_bytes(),
    format!("{oid} {oid}\n- {oid}\n+ {oid}\ngit version 2.49.0.windows.1\n").into_bytes(),
    note_tree,
  ];
  let random = |state: &mut u64| {
    *state = state.wrapping_mul(6364136223846793005).wrapping_add(1);
    *state >> 33
  };
  for index in 0..cases {
    let mut bytes = seeds[index % seeds.len()].clone();
    for _ in 0..(random(&mut state) % 8) {
      let at = (random(&mut state) as usize) % (bytes.len() + 1);
      match random(&mut state) % 4 {
        0 if at < bytes.len() => {
          let alphabet = b"\0\n\t \x1e\x1f0123456789abcdef-+#?:.^{}";
          bytes[at] = alphabet[(random(&mut state) as usize) % alphabet.len()]
        }
        1 => bytes.insert(at, random(&mut state) as u8),
        2 => bytes.truncate(at),
        _ if bytes.len() < 16384 => {
          let copy = bytes[at.min(bytes.len())..].to_vec();
          bytes.extend(copy);
        }
        _ => {}
      }
    }
    causet_engine::fuzz_parsers(&bytes);
  }
  println!("completed {cases} mutation cases without a panic");
}
