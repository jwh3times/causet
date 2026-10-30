# Binding license source

The napi-rs crates omit a license file from their crate archives. The adjacent
`napi-rs-LICENSE` is the upstream MIT license at the source commit recorded in
napi 3.12.4's `.cargo_vcs_info.json`:
[1492b220](https://github.com/napi-rs/napi-rs/blob/1492b220d5ad01807b2dcbd250e8383f9d738311/LICENSE).
The build includes it with the binding's third-party notices. Other selected
crates supply their license texts in the downloaded crate archive.
