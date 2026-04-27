// ── OPIDE AI ────────────────────────────────────────────────────────────────
//
// OPIDE AI crate — AST indexing, code intelligence, and sandbox execution.
//
// Depends on:
//   - opide-shell (for ide_mcp, git — shell operations)
//   - opide-sandbox (for WASM + JS execution engines)
//   - opide_engine (for EngineState, types, traits)

pub mod engine;
pub mod indexer;
