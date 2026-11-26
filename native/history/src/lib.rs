//! Native history (ADR-0047): the objects a native repository's history is
//! made of, as `docs/native-history/` defines them, how import derives them
//! from Git's, and how a reader prints them as Git does.
#![forbid(unsafe_code)]

pub mod action;
pub mod actor;
pub mod catalog;
pub mod commit;
pub mod date;
pub mod fact;
pub mod fact_log;
pub mod local;
pub mod names;
pub mod notes;
pub mod pretty;
pub mod signature;
pub mod tag;
mod text;
pub mod trailers;
pub mod verify;
