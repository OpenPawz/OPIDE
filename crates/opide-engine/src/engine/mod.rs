// Pawz Agent Engine — Native Rust AI agent runtime
// Direct AI API calls, in-process tool execution, and Tauri IPC
// for zero-network-hop communication.

pub mod agent_loop;
pub mod chat;
pub mod compaction;
pub mod constrained;
pub mod engram;
pub mod events;
pub mod http;
pub mod injection;
pub mod key_vault;
pub mod mcp;
pub mod memory;
pub mod paths;
pub mod pricing;
pub mod provider_registry;
pub mod providers;
pub mod routing;
pub mod sessions;
pub mod state;
pub mod telemetry;
pub mod tool_index;
pub mod tool_metadata;
pub mod tool_registry;
pub mod tools;
pub mod types;
pub mod util;
pub mod vault;
