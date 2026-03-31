// ── OPIDE Execution Engine ───────────────────────────────────────────────────
// Standalone crate: sandboxed JS runtime for agent code execution.
//
// The agent writes code on the fly and runs it in a secure JS sandbox (rquickjs).
// All I/O goes through the HostApi trait — no raw filesystem or network access.

pub mod host_api;
mod executor;

// JS executor exports
pub use executor::{
    LogCallback, SandboxResult,
    execute_js, execute_js_async,
    execute_js_with_host, execute_js_with_host_async,
    execute_js_with_host_streaming, execute_js_with_host_streaming_async,
};

// Shared type exports
pub use host_api::{
    HostApi, FileReadResult, ExecResult, DirEntry,
    GitStatusResult, GitFileStatus, GitDiffResult, GitLogEntry, GitBranch, SearchMatch,
    Diagnostic, DiagnosticsResult, SelectionResult, OpenFilesResult,
};
