//! Native history (ADR-0047): the objects a native repository's history is
//! made of, as `docs/native-history/` defines them, how import derives them
//! from Git's, and how a reader prints them as Git does.
#![forbid(unsafe_code)]

pub mod actor;
pub mod commit;
pub mod pretty;
pub mod signature;
mod text;
pub mod verify;
