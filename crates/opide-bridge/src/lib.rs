// ── OPIDE Bridge ────────────────────────────────────────────────────────────
//
// Implements OpenPawz hook traits for IDE-specific behavior.
// This crate is the boundary between OPIDE and OpenPawz — all IDE
// customizations live here, not in OpenPawz source files.

pub mod claude_code;

use paw_temp_lib::atoms::engram_types::{MemoryScope, ProceduralMemory, ProceduralStep};
use paw_temp_lib::atoms::traits::{AiProvider, ProviderFactory, ToolAssembler};
use paw_temp_lib::atoms::types::ToolDefinition;
use paw_temp_lib::engine::sessions::SessionStore;
use paw_temp_lib::engine::types::{ProviderConfig, ProviderKind};

// ── Provider Factory ────────────────────────────────────────────────────────

/// OPIDE's ProviderFactory — handles ClaudeCode and any future OPIDE-specific providers.
pub struct OpideProviderFactory;

impl ProviderFactory for OpideProviderFactory {
    fn create_provider(&self, config: &ProviderConfig) -> Option<Box<dyn AiProvider>> {
        match config.kind {
            ProviderKind::ClaudeCode => {
                Some(Box::new(claude_code::ClaudeCodeProvider::new(config)))
            }
            _ => None,
        }
    }
}

// ── Tool Assembler ──────────────────────────────────────────────────────────

/// Tools the model is allowed to see. Everything NOT on this list is filtered out.
///
/// Key design: individual file operations (read/write/edit/delete/list_dir) are
/// REMOVED. The model must use execute_code (sandbox) for file operations.
/// This forces batch operations (1 round instead of 10) and ensures all writes
/// go through the diff editor review gate.
///
/// mcp_* tools always pass through regardless of this list.
const OPIDE_EXPOSED_TOOLS: &[&str] = &[
    // Sandbox — all file operations go through here
    "execute_code",

    // AST queries — instant structured results from the indexer
    "ide_ast_callers",
    "ide_ast_callees",
    "ide_ast_impact",
    "ide_ast_definition",
    "ide_ast_type_info",
    "ide_get_project_overview",
    "ide_search_semantic",
    "ide_search_text",

    // Read-only IDE state
    "ide_get_diagnostics",
    "ide_get_selection",
    "ide_get_open_files",
    "ide_open_file",
    "ide_get_terminal_output",

    // Git — all git tools stay direct
    "ide_git_status",
    "ide_git_diff",
    "ide_git_stage",
    "ide_git_stage_all",
    "ide_git_unstage",
    "ide_git_commit",
    "ide_git_log",
    "ide_git_branches",
    "ide_git_checkout",

    // Shell — build tools, tests, linters
    "ide_run_command",

    // Workspace
    "ide_create_project",

    // OpenPawz tools kept for workflows
    "memory_store",
    "memory_search",
    "soul_read",
    "soul_write",
    "soul_list",
    "self_info",
    "fetch",
    "web_search",
    "web_read",
    "request_tools",
    "execute_plan",

    // Agent collaboration
    "agent_send_message",
    "agent_read_messages",
    "agent_list",
    "agent_skills",
];

/// OPIDE's ToolAssembler — controls which tools the AI model sees.
///
/// Removes individual file operations (ide_read_file, ide_write_file, etc.)
/// forcing all file work through execute_code sandbox. WASM and MCP tools
/// always pass through.
pub struct OpideToolAssembler;

impl ToolAssembler for OpideToolAssembler {
    fn filter_tools(&self, tools: Vec<ToolDefinition>) -> Vec<ToolDefinition> {
        tools
            .into_iter()
            .filter(|tool| {
                let name = tool.function.name.as_str();
                name.starts_with("mcp_")
                    || OPIDE_EXPOSED_TOOLS.contains(&name)
            })
            .collect()
    }
}

// ── Engram Procedural Memory Seeding ────────────────────────────────────────

/// Seed OPIDE-specific procedural memories into the engram system.
/// These teach the agent to use WASM skills, execute_code sandbox, and AST queries
/// instead of individual file tool calls. Runs at startup, idempotent (deterministic IDs).
pub fn seed_opide_procedural_memories(store: &SessionStore) {
    let memories = opide_procedural_memories();
    let mut written = 0;
    for mem in &memories {
        if store.engram_store_procedural(mem).is_ok() {
            written += 1;
        }
    }
    if written > 0 {
        log::info!("[opide-bridge] Seeded {} procedural memories", written);
    }
}

fn opide_procedural_memories() -> Vec<ProceduralMemory> {
    let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
    let scope = MemoryScope {
        global: true,
        ..Default::default()
    };

    vec![
        ProceduralMemory {
            id: "opide-multi-file-edit".into(),
            trigger: "create files refactor scaffold rename across files write multiple files edit code".into(),
            steps: vec![
                ProceduralStep {
                    description: "Use execute_code for all file operations. Write a function run(ctx) that calls ctx.file_read() to read files and ctx.file_write() to write them. This batches multiple operations into one round instead of individual tool calls. All writes go through diff editor review.".into(),
                    tool_name: Some("execute_code".into()),
                    args_pattern: Some("{\"code\": \"function run(ctx) { var content = ctx.file_read('path'); ctx.file_write('path', modified); return { done: true }; }\"}".into()),
                    expected_outcome: Some("Multiple files read/written in one sandbox execution".into()),
                },
            ],
            success_rate: 1.0,
            execution_count: 0,
            scope: scope.clone(),
            created_at: now.clone(),
            updated_at: None,
        },
        ProceduralMemory {
            id: "opide-codebase-review".into(),
            trigger: "review codebase understand architecture audit code structure overview".into(),
            steps: vec![
                ProceduralStep {
                    description: "Start with ide_get_project_overview for the high-level structure. Then use AST query tools: ide_ast_callers to find who calls a function, ide_ast_callees to find what it calls, ide_ast_impact for change impact analysis, ide_ast_type_info for type hierarchies. Use ide_search_semantic for concept-based search.".into(),
                    tool_name: Some("ide_get_project_overview".into()),
                    args_pattern: Some("{}".into()),
                    expected_outcome: Some("Complete architectural understanding from indexed data".into()),
                },
            ],
            success_rate: 1.0,
            execution_count: 0,
            scope: scope.clone(),
            created_at: now.clone(),
            updated_at: None,
        },
        ProceduralMemory {
            id: "opide-test-fix-loop".into(),
            trigger: "fix test run tests debug failure test loop".into(),
            steps: vec![
                ProceduralStep {
                    description: "Use execute_code to batch the test-fix cycle: read the failing test, read the source, apply the fix, run the test, check the output — all in one sandbox execution. Use ctx.file_read(), ctx.file_write(), ctx.exec() within a single function run(ctx).".into(),
                    tool_name: Some("execute_code".into()),
                    args_pattern: Some("{\"code\": \"function run(ctx) { var test = ctx.file_read('test.rs'); var src = ctx.file_read('src.rs'); ctx.file_write('src.rs', fixed); var result = ctx.exec('cargo test'); return result; }\"}".into()),
                    expected_outcome: Some("Test fixed and verified in one round".into()),
                },
            ],
            success_rate: 1.0,
            execution_count: 0,
            scope: scope.clone(),
            created_at: now.clone(),
            updated_at: None,
        },
    ]
}
