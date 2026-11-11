//! Dependency-free, reproducible mutation fuzz target for the record model:
//! the JSON parser every note, envelope and journal passes through, and every
//! function that then reads the parsed value. Run with a case count and an
//! optional integer seed; any panic fails the run.
#![forbid(unsafe_code)]

use causet_model::canonical::{
  canonical_json, hashed_payload, legacy_canonical_json, record_digest,
};
use causet_model::json::{parse, stringify, stringify_pretty};
use causet_model::schemas::{
  referenced_objects, resolution_signature, schema_classification, validate_note_record,
};

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
  let seeds: Vec<Vec<u8>> = vec![
    b"{}".to_vec(),
    b"[1,-0,1.5,1e400,\"\\ud800\",{\"\":null}]".to_vec(),
    format!(
      r#"{{"schema":"causet.rebase/v3","type":"rebase","id":"rebase_x","applications":[{{"sourceCommit":"{oid}"}}],"recreatedMerges":[{{"parents":[{{"commit":"{oid}"}},null],"originCommit":"{oid}"}}],"absorbedCommits":["{oid}"],"effectiveBase":{{"commit":"{oid}"}}}}"#
    )
    .into_bytes(),
    format!(
      r#"{{"schema":"vcs-lab.provenance/v1","type":"provenance","id":"prov_x","commit":"{oid}","actors":[{{"role":"generated","actor":"a"}}],"origin":"carried","carriedFrom":["{oid}"],"changeId":null,"createdAt":"2026-09-30T12:00:00.000Z","attachedTo":"{oid}"}}"#
    )
    .into_bytes(),
    format!(
      r#"{{"schema":"causet.resolution/v1","type":"resolution","id":"resolution_x","base":{{"blob":"{oid}"}},"ours":null,"theirs":"x","resultBlob":null,"ref":"refs/causet/resolutions/x","signature":"rsig_{}"}}"#,
      "0".repeat(64)
    )
    .into_bytes(),
    br#"{"schema":"causet.interactive-absorption/v1","absorbedChanges":"abc","survivingChangeId":"b","absorbedCommits":5}"#.to_vec(),
  ];
  let random = |state: &mut u64| {
    *state = state.wrapping_mul(6364136223846793005).wrapping_add(1);
    *state >> 33
  };
  let mut parsed = 0usize;
  for index in 0..cases {
    let mut bytes = seeds[index % seeds.len()].clone();
    for _ in 0..(random(&mut state) % 8) {
      let at = (random(&mut state) as usize) % (bytes.len() + 1);
      match random(&mut state) % 4 {
        0 if at < bytes.len() => {
          let alphabet = b"{}[]\":,\\-0123456789eE.tfnaxu \n";
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
    let text = String::from_utf8_lossy(&bytes);
    let Ok(value) = parse(&text) else { continue };
    parsed += 1;
    let _ = canonical_json(&value);
    let _ = hashed_payload(&value);
    let _ = legacy_canonical_json(&value);
    let _ = record_digest("0000000000000000000000000000000000000000", &value);
    let _ = stringify(&value);
    let _ = stringify_pretty(&value);
    let _ = validate_note_record(Some(&value), "sha1");
    let _ = validate_note_record(Some(&value), "sha256");
    let _ = referenced_objects(Some(&value));
    let _ = resolution_signature(Some(&value));
    let _ = schema_classification(Some(&text));
  }
  println!("completed {cases} mutation cases without a panic ({parsed} parsed as JSON)");
}
