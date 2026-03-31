// ── Sandbox Enforcement ──────────────────────────────────────────────────────
//
// Consolidated enforcement rules for OPIDE's sandbox execution engine.
// All sandbox routing decisions are made here — not scattered through
// the agent loop. This prevents OpenPawz updates from accidentally
// breaking enforcement.
//
// Gated by: ExternalToolExecutor being registered in Tauri state.
// When no executor is registered (standalone OpenPawz), none of this runs.

use crate::engine::types::ToolCall;

/// Check if the sandbox execution engine is available.
/// Returns true when a host app (OPIDE) has registered an ExternalToolExecutor.
pub fn has_sandbox(app_handle: &tauri::AppHandle) -> bool {
    use tauri::Manager;
    app_handle
        .try_state::<Box<dyn crate::engine::tools::ExternalToolExecutor>>()
        .is_some()
}

/// Extract a JS execution block from LLM response text.
/// Returns the code if the text contains a ```javascript or ```js block
/// with `function run(ctx)` — indicating the model wrote sandbox code
/// instead of using the execute_code tool call.
pub fn extract_js_execution_block(content: &str) -> Option<String> {
    let markers = ["```javascript", "```js"];

    for marker in &markers {
        if let Some(start_idx) = content.find(marker) {
            let code_start = start_idx + marker.len();
            if let Some(end_idx) = content[code_start..].find("```") {
                let code = content[code_start..code_start + end_idx].trim();
                if code.contains("function run") && code.contains("ctx") {
                    return Some(code.to_string());
                }
            }
        }
    }

    None
}

/// Build a ToolCall that routes code through the execute_code sandbox.
pub fn make_execute_code_call(code: &str) -> ToolCall {
    let exec_args = serde_json::json!({"code": code});
    ToolCall {
        id: format!("jsblock_{}", uuid::Uuid::new_v4()),
        call_type: "function".into(),
        function: crate::engine::types::FunctionCall {
            name: "execute_code".to_string(),
            arguments: serde_json::to_string(&exec_args).unwrap_or_default(),
        },
        thought_signature: None,
        thought_parts: Vec::new(),
    }
}

/// Should a single tool call be forced through the sandbox?
/// Returns true for non-query `ide_*` tools. WASM tools and read-only
/// queries are excluded — they run directly.
pub fn should_force_single_tool(tc: &ToolCall) -> bool {
    if tc.function.name == "execute_code" {
        return false;
    }

    let is_ide_tool = tc.function.name.starts_with("ide_");
    if !is_ide_tool {
        return false;
    }

    // Read-only queries don't need sandbox wrapping
    let is_single_query = matches!(
        tc.function.name.as_str(),
        "ide_get_diagnostics" | "ide_get_selection" | "ide_get_open_files"
        | "ide_get_project_overview" | "ide_ast_callers" | "ide_ast_callees"
        | "ide_ast_impact" | "ide_ast_definition" | "ide_ast_type_info"
        | "ide_get_codebase_context" | "ide_search_semantic"
    );

    !is_single_query
}

/// Build JS code that wraps a single tool call for sandbox execution.
pub fn build_single_tool_sandbox_code(tc: &ToolCall) -> String {
    let args_clean = tc.function.arguments.replace('\\', "\\\\").replace('`', "\\`");
    format!(
        "function run(ctx) {{\n  var result = ctx.tool(\"{}\", JSON.parse(`{}`));\n  return result;\n}}",
        tc.function.name, args_clean
    )
}

/// Should multiple tool calls be batched through the sandbox?
/// Returns false if any tool is execute_code (already sandboxed) or
/// if any tool is a WASM skill (must run natively, not through JS).
pub fn should_batch_tools(tool_calls: &[ToolCall]) -> bool {
    if tool_calls.len() <= 1 {
        return false;
    }
    if tool_calls[0].function.name == "execute_code" {
        return false;
    }
    // WASM tools cannot be wrapped in JS sandbox — causes stack overflow
    let has_wasm = tool_calls.iter().any(|tc| tc.function.name.starts_with("wasm_"));
    !has_wasm
}

/// Build JS code that batches multiple tool calls into one sandbox execution.
pub fn build_batch_sandbox_code(tool_calls: &[ToolCall]) -> String {
    let mut js_lines = Vec::new();
    js_lines.push("function run(ctx) {".to_string());
    js_lines.push("  var results = [];".to_string());

    for tc in tool_calls {
        let args_clean = tc.function.arguments.replace('\\', "\\\\").replace('`', "\\`");
        js_lines.push(format!(
            "  results.push({{ tool: \"{}\", result: ctx.tool(\"{}\", JSON.parse(`{}`)) }});",
            tc.function.name, tc.function.name, args_clean
        ));
        js_lines.push(format!("  ctx.log(\"Executed: {}\");", tc.function.name));
    }

    js_lines.push("  return { batch: true, count: results.length, results: results };".to_string());
    js_lines.push("}".to_string());

    js_lines.join("\n")
}

/// Is a tool call auto-approved (no human-in-the-loop needed)?
/// IDE tools and WASM skills are always auto-approved because they
/// run in the sandbox or WASM runtime — both are isolated.
pub fn is_sandbox_auto_approved(tc: &ToolCall) -> bool {
    tc.function.name.starts_with("ide_")
        || tc.function.name.starts_with("wasm_")
        || tc.function.name == "execute_code"
}
