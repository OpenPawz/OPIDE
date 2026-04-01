// ── OPIDE AI ────────────────────────────────────────────────────────────────
//
// OPIDE AI crate — AST indexing, code intelligence, and sandbox execution.
//
// Depends on:
//   - opide-shell (for ide_mcp, git — shell operations)
//   - opide-sandbox (for WASM + JS execution engines)
//   - paw_temp_lib (for EngineState, types, traits)

pub mod engine;
pub mod indexer;
