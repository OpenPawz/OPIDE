// ── JS Sandbox Executor ─────────────────────────────────────────────────────
// Split from a single 1,843-line file into focused modules:
//   runtime.rs     — QuickJS runtime setup, execution, result handling
//   host_inject.rs — ctx.* function injection (file_read, exec, git, etc.)
//   helpers.rs     — JS↔JSON conversion, log extraction, async wrappers

mod host_inject;
mod helpers;
mod runtime;

#[cfg(test)]
pub(crate) mod tests;

// Re-export the public API (same as before the split)
pub use runtime::{
    LogCallback, SandboxResult,
    execute_js, execute_js_with_host, execute_js_with_host_streaming,
};
pub use helpers::{
    execute_js_async, execute_js_with_host_async, execute_js_with_host_streaming_async,
};
