//! The native content store of N1 (ADR-0045, #297), built to the contract in
//! `docs/native-store/`. So far it holds the chunker (#300); objects, the
//! index and import follow in their own tickets.
#![forbid(unsafe_code)]

pub mod chunker;
