// ── OPIDE AI ────────────────────────────────────────────────────────────────
//
// The competitive advantage: AST indexer, WASM skill registry, tool executor,
// diff editor review, codebase intelligence. This crate is PRIVATE — not
// included in the open-source distribution.
//
// Depends on:
//   - opide-shell (for ide_mcp, git — shell operations)
//   - opide-sandbox (for WASM + JS execution engines)
//   - paw_temp_lib (for EngineState, types, traits)

pub mod engine;
pub mod indexer;
