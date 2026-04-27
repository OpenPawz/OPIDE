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

/// Escape a JSON-string payload for safe embedding inside a JS double-quoted
/// string literal. The wrapped JS does `JSON.parse(<this>)` — so the input is
/// already JSON; we just need to make it survive the JS lexer.
///
/// This avoids the `${...}` interpolation hazard that template literals (`...`)
/// have: double-quoted JS strings do NOT interpolate, so we sidestep it
/// entirely.
fn js_quote_json(args: &str) -> String {
    let mut out = String::with_capacity(args.len() + 8);
    out.push('"');
    for c in args.chars() {
        match c {
            '"'  => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\x08' => out.push_str("\\b"),
            '\x0c' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Build JS code that wraps a single tool call for sandbox execution.
pub fn build_single_tool_sandbox_code(tc: &ToolCall) -> String {
    let args_literal = js_quote_json(&tc.function.arguments);
    format!(
        "function run(ctx) {{\n  var result = ctx.tool({:?}, JSON.parse({}));\n  return result;\n}}",
        tc.function.name, args_literal
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
        let args_literal = js_quote_json(&tc.function.arguments);
        js_lines.push(format!(
            "  results.push({{ tool: {:?}, result: ctx.tool({:?}, JSON.parse({})) }});",
            tc.function.name, tc.function.name, args_literal
        ));
        js_lines.push(format!(
            "  ctx.log({:?});",
            format!("Executed: {}", tc.function.name)
        ));
    }

    js_lines.push("  return { batch: true, count: results.length, results: results };".to_string());
    js_lines.push("}".to_string());

    js_lines.join("\n")
}

/// Read-only `ide_*` tools — these only inspect the user's environment,
/// they never mutate it. Always safe to run without approval.
const READ_ONLY_IDE_TOOLS: &[&str] = &[
    "ide_read_file",
    "ide_list_dir",
    "ide_search_text",
    "ide_search_semantic",
    "ide_get_diagnostics",
    "ide_get_selection",
    "ide_get_open_files",
    "ide_open_file", // opens an editor pane; no filesystem mutation
    "ide_get_terminal_output",
    "ide_get_project_overview",
    // Git read paths — diff/status/log/branches don't touch the working tree.
    "ide_git_status",
    "ide_git_diff",
    "ide_git_log",
    "ide_git_branches",
    // AST queries — pure index reads.
    "ide_ast_callers",
    "ide_ast_callees",
    "ide_ast_impact",
    "ide_ast_definition",
    "ide_ast_type_info",
];

/// Is a tool call auto-approved (no human-in-the-loop needed)?
///
/// B196: previously this returned true for ALL `ide_*` and `execute_code`,
/// on the theory that the QuickJS sandbox makes them "isolated". That's
/// only half-true — the sandbox prevents JS from escaping into native
/// code, but `ctx.file_write`, `ctx.exec`, and `ide_run_command` reach
/// real host filesystem and shell with full user privilege. B194/B195
/// added engine-level credential gates, but the user never SAW any
/// approval prompt for ordinary writes (e.g. an agent overwriting
/// ~/Documents/important.txt with arbitrary content) because the
/// engine bypassed the human-in-the-loop entirely.
///
/// Now: only auto-approve genuinely read-only tools (the explicit
/// `READ_ONLY_IDE_TOOLS` list) and WASM skills (which run in the
/// isolated WASM runtime with no host filesystem access). Everything
/// else — `execute_code`, `ide_run_command`, `ide_write_file`,
/// `ide_apply_edit`, `ide_delete_file`, `ide_git_commit`, mutating git
/// ops, `ide_create_project`, `ide_open_workspace` — flows through
/// the agent loop's standard tier classification + approval prompt.
pub fn is_sandbox_auto_approved(tc: &ToolCall) -> bool {
    if tc.function.name.starts_with("wasm_") {
        return true;
    }
    READ_ONLY_IDE_TOOLS.contains(&tc.function.name.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::types::{FunctionCall, ToolCall};

    fn make_tc(name: &str, args: &str) -> ToolCall {
        ToolCall {
            id: "test_id".into(),
            call_type: "function".into(),
            function: FunctionCall {
                name: name.into(),
                arguments: args.into(),
            },
            thought_signature: None,
            thought_parts: Vec::new(),
        }
    }

    #[test]
    fn js_quote_json_handles_template_literal_traps() {
        // The classic "${...}" interpolation trap that broke template-literal builders.
        let q = js_quote_json(r#"{"path": "${HOME}/.ssh/id_rsa"}"#);
        // The output is wrapped in double quotes (not backticks), so ${} doesn't interpolate.
        assert!(q.starts_with('"') && q.ends_with('"'));
        assert!(q.contains("${HOME}"));
        assert!(!q.contains('`'));
    }

    #[test]
    fn js_quote_json_escapes_double_quote_and_backslash() {
        let q = js_quote_json(r#"{"key": "value with \"quote\" and \\ backslash"}"#);
        // Backslashes and quotes must be properly escaped for JS string literal.
        assert!(q.contains(r#"\\\""#) || q.contains(r#"\""#));
    }

    #[test]
    fn js_quote_json_escapes_control_chars() {
        let q = js_quote_json("line1\nline2\ttab");
        assert!(q.contains("\\n"));
        assert!(q.contains("\\t"));
    }

    // ── B196 auto-approve scope ────────────────────────────────

    #[test]
    fn auto_approve_keeps_read_only_ide_tools() {
        for tool in &[
            "ide_read_file",
            "ide_search_text",
            "ide_get_diagnostics",
            "ide_ast_callers",
            "ide_git_status",
            "ide_git_diff",
        ] {
            assert!(
                is_sandbox_auto_approved(&make_tc(tool, "{}")),
                "{} should still auto-approve (read-only)",
                tool
            );
        }
    }

    #[test]
    fn auto_approve_keeps_wasm_skills() {
        // WASM skills run isolated in the WASM runtime — auto-approve preserved.
        assert!(is_sandbox_auto_approved(&make_tc("wasm_solidity_audit", "{}")));
        assert!(is_sandbox_auto_approved(&make_tc("wasm_anything", "{}")));
    }

    #[test]
    fn auto_approve_drops_execute_code() {
        // The reproducer shape: execute_code with ctx.file_write inside
        // the JS body. Engine MUST prompt the user before running this.
        assert!(!is_sandbox_auto_approved(&make_tc(
            "execute_code",
            r#"{"code":"function run(ctx) { ctx.file_write('/tmp/x', 'y'); }"}"#
        )));
    }

    #[test]
    fn auto_approve_drops_ide_run_command() {
        // Shell commands reach zsh -l -c with full user privilege —
        // never auto-approve.
        assert!(!is_sandbox_auto_approved(&make_tc(
            "ide_run_command",
            r#"{"command":"echo hi"}"#
        )));
    }

    #[test]
    fn auto_approve_drops_mutating_ide_tools() {
        for tool in &[
            "ide_write_file",
            "ide_apply_edit",
            "ide_delete_file",
            "ide_git_commit",
            "ide_git_stage",
            "ide_git_checkout",
            "ide_create_project",
            "ide_open_workspace",
        ] {
            assert!(
                !is_sandbox_auto_approved(&make_tc(tool, "{}")),
                "{} must require approval (mutates filesystem or workspace)",
                tool
            );
        }
    }

    #[test]
    fn build_single_tool_sandbox_code_safe_against_dollar_brace() {
        let tc = make_tc("ide_read_file", r#"{"path": "${PWD}/secret"}"#);
        let code = build_single_tool_sandbox_code(&tc);
        // Body uses double quotes for the args literal; ${} inside double quotes
        // is just a literal character sequence in JS.
        assert!(code.contains("JSON.parse("));
        assert!(!code.contains('`'), "no backticks should appear in the generated code");
    }

    #[test]
    fn build_batch_sandbox_code_safe_against_dollar_brace() {
        let calls = vec![
            make_tc("ide_read_file",  r#"{"path": "${A}"}"#),
            make_tc("ide_write_file", r#"{"content": "x${B}y"}"#),
        ];
        let code = build_batch_sandbox_code(&calls);
        assert!(!code.contains('`'));
        assert!(code.contains("JSON.parse("));
    }
}
