//! Dependency-free, reproducible mutation fuzz target for every native byte parser.
//! Run with a case count and optional integer seed; any panic fails the run.
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
  let seeds: Vec<Vec<u8>> = vec![
        Vec::new(), vec![0; 64], vec![255; 64],
        b"100644 result\0abcdefghijklmnopqrst".to_vec(),
        b"object 1234567890123456789012345678901234567890\ntype commit\ntag test\n\nmessage".to_vec(),
        b"tree 1234567890123456789012345678901234567890\nauthor A <a@b> 0 +0000\ncommitter A <a@b> 0 +0000\n\nmessage".to_vec(),
        b"1234567890123456789012345678901234567890".to_vec(),
    ];
  let random = |state: &mut u64| {
    *state = state.wrapping_mul(6364136223846793005).wrapping_add(1);
    *state
  };
  for index in 0..cases {
    let mut bytes = seeds[index % seeds.len()].clone();
    for _ in 0..(random(&mut state) % 16) {
      let at = (random(&mut state) as usize) % (bytes.len() + 1);
      match random(&mut state) % 4 {
        0 if at < bytes.len() => {
          bytes[at] = random(&mut state) as u8;
        }
        1 => {
          bytes.insert(at, random(&mut state) as u8);
        }
        2 => bytes.truncate(at),
        _ if bytes.len() < 65536 => {
          let copy = bytes.clone();
          bytes.extend(copy);
        }
        _ => {}
      }
    }
    vlab_core::fuzz_parsers(&bytes);
  }
  println!("completed {cases} mutation cases without a panic");
}
