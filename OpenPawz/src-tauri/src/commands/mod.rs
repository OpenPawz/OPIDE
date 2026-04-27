// Paw Command Modules — Systems Layer
//
// Each sub-module is a thin Tauri command wrapper.
// Heavy logic lives in engine/ organisms; these modules
// only deserialise, delegate, and serialise.

pub mod agent;
pub mod chat;
pub mod config;
pub mod mcp;
pub mod memory;
pub mod state;
