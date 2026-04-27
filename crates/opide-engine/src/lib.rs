//! OPIDE engine — agent loop, providers, sessions, MCP.
//!
//! This crate replaces the vendored `OpenPawz/src-tauri` path-dep. The
//! migration is sequenced in `OPENPAWZ_EXTRACTION_PLAN.md` at the repo
//! root. During the migration, modules are moved here phase-by-phase
//! and `paw_temp_lib::*` re-exports keep OpenPawz's own internal code
//! compiling against the same types until phase 6 deletes the folder.
//!
//! Phase 0 (this commit): scaffold only — no code yet.

#[doc(hidden)]
pub fn ping() {}
