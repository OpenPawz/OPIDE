// ── OPIDE Shell ─────────────────────────────────────────────────────────────
//
// IDE infrastructure: terminal, git, LSP, DAP, file watcher, search,
// remote development, IDE-MCP bridge, extension host.
//
// Every module is self-contained — no cross-dependencies between them.
// All expose Tauri commands via #[tauri::command].

pub mod utf8;
pub mod terminal;
pub mod git;
pub mod lsp;
pub mod dap;
pub mod watcher;
pub mod search;
pub mod remote;
pub mod ide_mcp;
pub mod extension_host;
