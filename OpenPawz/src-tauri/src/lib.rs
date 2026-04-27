// Paw — library entry point.
//
// Phase 1 of the OPIDE extraction: the standalone OpenPawz Tauri binary
// is no longer compiled in this tree. OPIDE consumes this crate as a
// library (engine + commands + atoms) and wires its own `run()` in
// `src-tauri/src/main.rs`. The legacy `run()` lived behind the
// `channels`/`docker`/`browser`/`dex` features and depended on dozens
// of modules (mail, n8n, oauth, channels, telemetry, etc.) that have
// been removed. If a standalone OpenPawz binary is ever resurrected,
// it will be rebuilt against the slim engine surface.

// ── Paw Atoms (constants, error types) ────────────────────────────────────
pub mod atoms;

// ── Paw Agent Engine ───────────────────────────────────────────────────
pub mod engine;

// ── Paw Command Modules (Systems layer) ───────────────────────────────
pub mod commands;
