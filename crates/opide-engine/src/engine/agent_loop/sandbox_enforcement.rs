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
            // U+2028 LINE SEPARATOR / U+2029 PARAGRAPH SEPARATOR are valid
            // unescaped inside JSON strings (so a model can emit them in tool
            // args), but in pre-ES2019 JS they are line terminators that are
            // illegal unescaped inside a string literal. Since this output is
            // embedded as a double-quoted JS literal for JSON.parse(...), an
            // unescaped one would break the literal at lex time — the classic
            // "JSON is not a subset of JS" hazard. Escape them explicitly.
            '\u{2028}' => out.push_str("\\u2028"),
            '\u{2029}' => out.push_str("\\u2029"),
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

// ── Tier classification ──────────────────────────────────────────────────────
//
// Single source of truth for tool tier lookup. The agent_loop main loop
// uses these via classify_tool_tier; the force-sandbox single-tool path
// and the multi-tool batch path both call the same helper so the tier
// label and the auto-approve decision stay consistent across all three
// code sites.

/// Tier 1, safe: read-only, never mutate user state. Always auto-approve.
pub const TIER1_SAFE: &[&str] = &[
    "fetch",
    "read_file",
    "list_directory",
    "soul_read",
    "soul_list",
    "memory_search",
    "memory_stats",
    "self_info",
    "web_search",
    "web_read",
    "web_screenshot",
    "web_browse",
    "list_tasks",
    "email_read",
    "slack_read",
    "telegram_read",
    "google_gmail_list",
    "google_gmail_read",
    "google_calendar_list",
    "google_drive_list",
    "google_drive_read",
    "google_sheets_read",
    "sol_balance",
    "sol_quote",
    "sol_portfolio",
    "sol_token_info",
    "dex_balance",
    "dex_quote",
    "dex_portfolio",
    "dex_token_info",
    "dex_check_token",
    "dex_search_token",
    "dex_watch_wallet",
    "dex_whale_transfers",
    "dex_top_traders",
    "dex_trending",
    "coinbase_prices",
    "coinbase_balance",
    "agent_list",
    "agent_skills",
    "agent_read_messages",
    "list_squads",
    "skill_search",
    "skill_list",
    "request_tools",
    "mcp_refresh",
    "search_ncnodes",
    "n8n_list_workflows",
    "canvas_push",
    "canvas_update",
    "canvas_save",
    "canvas_load",
    "canvas_list_dashboards",
    "canvas_delete_dashboard",
    "canvas_list_templates",
    "canvas_from_template",
    "canvas_create_template",
    "trello_list_boards",
    "trello_get_board",
    "trello_get_lists",
    "trello_get_cards",
    "trello_get_card",
    "trello_search",
    "trello_get_labels",
    "trello_get_members",
    "execute_plan",
];

/// Tier 2, reversible: local writes that can be undone. Auto-approve in 'auto' mode.
///
/// B198 (and the audit findings 1A): `execute_code` deliberately not in this
/// list. The sandbox JS body can call `ctx.tool('ide_run_command', ...)` or
/// `ctx.exec(...)` to reach the host shell with full user privilege; an
/// auto-approve here would let an agent sneak destructive commands past
/// every other gate.
pub const TIER2_REVERSIBLE: &[&str] = &[
    "soul_write",
    "memory_store",
    "memory_knowledge",
    "update_profile",
    "create_task",
    "manage_task",
    "write_file",
    "agent_skill_assign",
    "skill_install",
    "agent_send_message",
    "create_squad",
    "manage_squad",
    "squad_broadcast",
];

/// Tier 3, external: irreversible outbound actions. Always prompt.
pub const TIER3_EXTERNAL: &[&str] = &[
    "email_send",
    "google_gmail_send",
    "google_docs_create",
    "google_drive_upload",
    "google_drive_share",
    "google_calendar_create",
    "google_sheets_append",
    "google_api",
    "image_generate",
    "trello_create_board",
    "trello_update_board",
    "trello_create_list",
    "trello_update_list",
    "trello_archive_list",
    "trello_create_card",
    "trello_update_card",
    "trello_move_card",
    "trello_add_comment",
    "trello_create_label",
    "trello_update_label",
    "trello_add_label",
    "trello_remove_label",
    "trello_create_checklist",
    "trello_add_checklist_item",
    "trello_toggle_checklist_item",
];

/// Tier 4, dangerous: financial / destructive. Always prompt.
pub const TIER4_DANGEROUS: &[&str] = &[
    "exec",
    "run_command",
    "delete_file",
    "ide_delete_file",
    "sol_swap",
    "sol_transfer",
    "sol_wallet_create",
    "dex_swap",
    "dex_transfer",
    "dex_wallet_create",
    "coinbase_trade",
    "coinbase_transfer",
    "coinbase_wallet_create",
];

/// Returns the tier label ("safe", "reversible", "external", "dangerous",
/// or "unknown") for a given tool name. The tier label flows to the
/// frontend in `EngineEvent::ToolRequest.tool_tier`.
///
/// Unknown is the safe default: any tool that doesn't appear in the four
/// lists (e.g. dynamic MCP tools, brand-new IDE tools, `execute_code`)
/// must be prompted.
pub fn classify_tool_tier(name: &str) -> &'static str {
    if TIER1_SAFE.contains(&name) {
        "safe"
    } else if TIER2_REVERSIBLE.contains(&name) {
        "reversible"
    } else if TIER3_EXTERNAL.contains(&name) {
        "external"
    } else if TIER4_DANGEROUS.contains(&name) {
        "dangerous"
    } else {
        "unknown"
    }
}

/// Should this tool be auto-approved (no human-in-the-loop prompt) given
/// the current approval policy? Mirrors the `skip_hil` predicate in the
/// per-tc loop in agent_loop::run_agent_turn so all three sandbox routing
/// branches (single force-sandbox, multi-tool batch, per-tc loop) reach
/// the same decision.
pub fn should_auto_approve(
    tc: &ToolCall,
    auto_approve_all: bool,
    user_approved_tools: &[String],
) -> bool {
    if auto_approve_all {
        return true;
    }
    if user_approved_tools.iter().any(|t| t == &tc.function.name) {
        return true;
    }
    if is_sandbox_auto_approved(tc) {
        return true;
    }
    let name = tc.function.name.as_str();
    TIER1_SAFE.contains(&name) || TIER2_REVERSIBLE.contains(&name)
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

    #[test]
    fn js_quote_json_escapes_line_and_paragraph_separators() {
        // U+2028 / U+2029 are legal unescaped in JSON but break a pre-ES2019
        // JS string literal. They must be emitted as   /   so the
        // generated JSON.parse("...") literal survives the JS lexer.
        let q = js_quote_json("before\u{2028}after\u{2029}end");
        assert!(q.contains("\\u2028"), "U+2028 must be escaped: {}", q);
        assert!(q.contains("\\u2029"), "U+2029 must be escaped: {}", q);
        // The raw separators must NOT appear unescaped in the output.
        assert!(!q.contains('\u{2028}'));
        assert!(!q.contains('\u{2029}'));
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

    // ── Tier classification + auto-approve helpers (audit finding 1A) ──

    #[test]
    fn classify_tool_tier_returns_safe_for_tier1_examples() {
        for name in &["fetch", "read_file", "memory_search", "self_info"] {
            assert_eq!(classify_tool_tier(name), "safe", "{}", name);
        }
    }

    #[test]
    fn classify_tool_tier_returns_reversible_for_tier2_examples() {
        for name in &["soul_write", "memory_store", "write_file"] {
            assert_eq!(classify_tool_tier(name), "reversible", "{}", name);
        }
    }

    #[test]
    fn classify_tool_tier_returns_external_for_tier3_examples() {
        for name in &["email_send", "google_drive_upload", "trello_create_card"] {
            assert_eq!(classify_tool_tier(name), "external", "{}", name);
        }
    }

    #[test]
    fn classify_tool_tier_returns_dangerous_for_tier4_examples() {
        for name in &["exec", "run_command", "delete_file", "ide_delete_file"] {
            assert_eq!(classify_tool_tier(name), "dangerous", "{}", name);
        }
    }

    #[test]
    fn classify_tool_tier_returns_unknown_for_force_sandbox_targets() {
        // These are the headline tools from finding 1A. None of them appear
        // in any of the tier lists, so they fall to "unknown" which means
        // the engine must prompt before running them.
        for name in &[
            "ide_run_command",
            "ide_git_commit",
            "ide_git_checkout",
            "ide_git_stage",
            "ide_git_stage_all",
            "ide_create_project",
            "ide_open_workspace",
            "execute_code",
        ] {
            assert_eq!(classify_tool_tier(name), "unknown", "{}", name);
        }
    }

    #[test]
    fn classify_tool_tier_returns_unknown_for_dynamic_mcp_tools() {
        // Dynamic MCP tools (mcp_*) and unknown names default to "unknown"
        // so the engine prompts.
        for name in &["mcp_some_server_tool", "totally_made_up_tool"] {
            assert_eq!(classify_tool_tier(name), "unknown", "{}", name);
        }
    }

    #[test]
    fn should_auto_approve_returns_true_for_yolo_mode() {
        let tc = make_tc("ide_run_command", r#"{"command": "rm -rf /"}"#);
        assert!(
            should_auto_approve(&tc, true, &[]),
            "yolo mode (auto_approve_all) should bypass every prompt"
        );
    }

    #[test]
    fn should_auto_approve_returns_true_for_user_approved_tools() {
        let tc = make_tc("ide_run_command", r#"{"command": "ls"}"#);
        let approved: Vec<String> = vec!["ide_run_command".into()];
        assert!(
            should_auto_approve(&tc, false, &approved),
            "tools the user added to user_approved_tools should auto-approve"
        );
    }

    #[test]
    fn should_auto_approve_returns_true_for_read_only_ide_tools() {
        let tc = make_tc("ide_read_file", r#"{"path": "src/main.rs"}"#);
        assert!(
            should_auto_approve(&tc, false, &[]),
            "read-only IDE tools auto-approve via is_sandbox_auto_approved"
        );
    }

    #[test]
    fn should_auto_approve_returns_true_for_wasm_skills() {
        let tc = make_tc("wasm_audit_solidity", r#"{"contract": "..."}"#);
        assert!(
            should_auto_approve(&tc, false, &[]),
            "wasm_* skills run isolated and auto-approve"
        );
    }

    #[test]
    fn should_auto_approve_returns_true_for_tier1_tools() {
        let tc = make_tc("memory_search", r#"{"query": "previous bugs"}"#);
        assert!(should_auto_approve(&tc, false, &[]));
    }

    #[test]
    fn should_auto_approve_returns_true_for_tier2_tools() {
        let tc = make_tc("memory_store", r#"{"content": "x"}"#);
        assert!(should_auto_approve(&tc, false, &[]));
    }

    #[test]
    fn should_auto_approve_returns_false_for_force_sandboxed_ide_run_command() {
        // The headline finding from 1A: ide_run_command must prompt in
        // 'ask' / 'auto' mode. Auto-approval here is the bug we're fixing.
        let tc = make_tc("ide_run_command", r#"{"command": "git push"}"#);
        assert!(
            !should_auto_approve(&tc, false, &[]),
            "ide_run_command MUST prompt outside yolo mode"
        );
    }

    #[test]
    fn should_auto_approve_returns_false_for_force_sandboxed_git_writes() {
        for name in &[
            "ide_git_commit",
            "ide_git_checkout",
            "ide_git_stage_all",
            "ide_git_stage",
            "ide_git_unstage",
            "ide_create_project",
            "ide_open_workspace",
        ] {
            let tc = make_tc(name, "{}");
            assert!(
                !should_auto_approve(&tc, false, &[]),
                "{} MUST prompt outside yolo mode",
                name
            );
        }
    }

    #[test]
    fn should_auto_approve_returns_false_for_execute_code() {
        // B198 deliberately removed execute_code from tier2_reversible.
        let tc = make_tc("execute_code", r#"{"code": "function run(ctx){...}"}"#);
        assert!(
            !should_auto_approve(&tc, false, &[]),
            "execute_code MUST prompt outside yolo mode"
        );
    }

    #[test]
    fn should_auto_approve_returns_false_for_unknown_mcp_tool() {
        let tc = make_tc("mcp_some_server_tool", "{}");
        assert!(
            !should_auto_approve(&tc, false, &[]),
            "unknown / dynamic tools must prompt"
        );
    }
}
