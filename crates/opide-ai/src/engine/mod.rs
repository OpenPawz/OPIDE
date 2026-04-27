// ── OPIDE Engine Layer ───────────────────────────────────────────────────────
// Wraps the OpenPawz engine with IDE-specific tool execution.
// Hooks in via ExternalToolExecutor trait defined in OpenPawz.

pub mod tools;
pub mod tool_filter;
pub mod frontend_bridge;

use opide_engine::engine::tools::ExternalToolExecutor;

/// OPIDE's IDE tool executor — routes ide_* and execute_code calls.
pub struct OpideToolExecutor;

#[async_trait::async_trait]
impl ExternalToolExecutor for OpideToolExecutor {
    async fn try_execute(
        &self,
        name: &str,
        args: &serde_json::Value,
        _agent_id: &str,
        app_handle: &tauri::AppHandle,
    ) -> Option<Result<String, String>> {
        tools::execute(name, args, app_handle).await
    }

    fn tool_definitions(&self) -> Vec<opide_engine::atoms::types::ToolDefinition> {
        tools::definitions()
    }

    fn tool_definitions_dynamic(&self, _app_handle: &tauri::AppHandle) -> Vec<opide_engine::atoms::types::ToolDefinition> {
        tools::definitions()
    }
}
