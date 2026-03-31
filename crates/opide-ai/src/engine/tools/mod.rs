// ── OPIDE Tools ─────────────────────────────────────────────────────────────
// Split from a single 1,189-line file into three focused modules:
//   tool_defs.rs    — what tools exist (definitions + schemas)
//   tool_executor.rs — what happens when a tool is called (routing + execution)
//   host_api.rs     — OpideHostApi bridging sandbox to IDE operations

mod tool_defs;
mod tool_executor;
pub(crate) mod host_api;

pub use tool_defs::definitions;
pub use tool_executor::execute;
