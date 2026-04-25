// ── OPIDE Tool Filter ────────────────────────────────────────────────────────
// Allowlist of tools the IDE agent should see. Everything NOT on this list
// is filtered out before being sent to the AI model.
//
// This keeps the agent focused on coding — no email, Slack, trading, Canvas.

/// Tools the OPIDE agent is allowed to use.
/// IDE-specific tools + essential OpenPawz tools for coding workflows.
pub const IDE_ALLOWED_TOOLS: &[&str] = &[
    // ── OPIDE IDE Tools (from engine/tools.rs) ───────────────────────
    "ide_read_file",
    "ide_write_file",
    "ide_list_dir",
    "ide_apply_edit",
    "ide_delete_file",
    "ide_run_command",
    "ide_git_status",
    "ide_git_diff",
    "ide_git_stage",
    "ide_git_stage_all",
    "ide_git_unstage",
    "ide_git_commit",
    "ide_git_log",
    "ide_git_branches",
    "ide_git_checkout",
    "ide_search_text",

    // ── Frontend Bridge Tools (Monaco editor state) ──────────────────
    "ide_get_diagnostics",
    "ide_get_selection",
    "ide_get_open_files",
    "ide_open_file",
    "ide_get_terminal_output",

    // ── OpenPawz tools kept for coding workflows ─────────────────────
    // Memory — cross-session knowledge about the project
    "memory_store",
    "memory_search",

    // Soul files — agent identity and user preferences
    "soul_read",
    "soul_write",
    "soul_list",
    "self_info",

    // Web — look up documentation, APIs, error messages
    "fetch",
    "web_search",
    "web_read",

    // Parallel execution — read/edit multiple files at once
    "execute_plan",

    // Codebase Index
    "ide_search_semantic",
    "ide_get_project_overview",

    // AST God View
    "ide_ast_callers",
    "ide_ast_callees",
    "ide_ast_impact",
    "ide_ast_definition",
    "ide_ast_type_info",

    // External indexing — index repos without switching workspace
    "ide_index_external",

    // Workspace
    "ide_create_project",
    "ide_open_workspace",

    // Execution engine — sandboxed JS for multi-step operations
    "execute_code",

    // Agent collaboration — delegate tasks to specialist agents
    "agent_send_message",
    "agent_read_messages",
    "agent_list",
    "agent_skills",
];

