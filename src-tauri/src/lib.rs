// OPIDE — Tauri entry point.
// Boots OPIDE V2's window with the full OpenPawz engine state and commands.
// All engine logic lives in the `opide_engine` crate (OpenPawz/src-tauri).

// OPIDE AI crate provides engine + indexer

use opide_engine::commands;
use tauri::Manager;
use tauri::WebviewUrl;

const OPIDE_IDENTITY: &str = r#"# OPIDE Agent Identity

You are the coding agent inside OPIDE, a native desktop IDE built with Rust and Tauri.

## Capabilities

- Full filesystem, terminal, and git access
- JavaScript execution sandbox (execute_code) for multi-step operations
- AST-level code intelligence: callers, callees, impact analysis, type hierarchies
- Semantic search across the codebase via embeddings
- MCP server connections for extensibility
- Web browsing, fetching, and search

## Tool Access

You have full access to all your tools. Never ask the user for permission — just call the tool directly. If a tool call fails, handle the error and try a different approach.

## Workspace

When a workspace is open, the AST indexer builds a call graph, type hierarchy, and embeddings in the background. Once indexed, AST tools give you the full picture across the entire codebase in one call — use them as your primary analysis method before reading individual files.

When opening a new workspace or cloning a repo, call `ide_open_workspace` to trigger indexing. Wait for indexing to complete before using `ide_ast_*` tools (try a query — if it returns results, the index is ready).
"#;

/// Open a new OPIDE window (multi-window support)
#[tauri::command]
async fn open_new_window(app: tauri::AppHandle, folder_path: Option<String>) -> Result<String, String> {
    let window_id = format!("opide-{}", uuid::Uuid::new_v4().to_string().split('-').next().unwrap_or("0"));

    let url = match folder_path {
        Some(ref path) => {
            let encoded = urlencoding::encode(path);
            WebviewUrl::App(format!("index.html#{}", encoded).into())
        }
        None => WebviewUrl::App("index.html".into()),
    };

    tauri::WebviewWindowBuilder::new(&app, &window_id, url)
        .title("OPIDE")
        .inner_size(1440.0, 900.0)
        .min_inner_size(900.0, 600.0)
        .center()
        .build()
        .map_err(|e| format!("Failed to open new window: {e}"))?;

    log::info!("[opide] opened new window: {}", window_id);
    Ok(window_id)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Increase tokio worker thread stack size from 2MB to 8MB.
    // Concurrent AI tool execution and sandbox operations need deep stacks.
    // Leak the runtime so it lives for the entire process lifetime.
    let rt = Box::leak(Box::new(
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .thread_stack_size(8 * 1024 * 1024)
            .build()
            .expect("Failed to build tokio runtime"),
    ));
    tauri::async_runtime::set(rt.handle().clone());

    let engine_state = opide_engine::engine::state::EngineState::new()
        .expect("Failed to initialize OpenPawz engine");

    // Pre-load encryption keys (single keychain prompt instead of per-subsystem).
    opide_engine::engine::key_vault::prefetch();

    // Initialize cognitive event bus (required before engram/working-memory calls).
    opide_engine::engine::engram::cognitive_event::init();

    tauri::Builder::default()
        .manage(engine_state)
        .manage(opide_shell::terminal::TerminalState::new())
        .manage(opide_shell::watcher::WatcherState::new())
        .manage(opide_shell::lsp::LspState::new())
        .manage(opide_shell::dap::DapState::new())
        .manage(opide_shell::extension_host::ExtHostState::new())
        // Register OPIDE's IDE tool executor with the OpenPawz engine
        .manage(Box::new(opide_ai::engine::OpideToolExecutor) as Box<dyn opide_engine::engine::tools::ExternalToolExecutor>)
        // OPIDE ↔ OpenPawz bridge: custom provider factory (ClaudeCode CLI)
        .manage(Box::new(opide_bridge::OpideProviderFactory) as Box<dyn opide_engine::atoms::traits::ProviderFactory>)
        // OPIDE ↔ OpenPawz bridge: tool assembler — controls which tools the model sees
        // Removes individual file tools (ide_read_file, ide_write_file, etc.)
        // forcing all file work through execute_code sandbox
        .manage(Box::new(opide_bridge::OpideToolAssembler) as Box<dyn opide_engine::atoms::traits::ToolAssembler>)
        // Frontend bridge state (for tools that query Monaco editor)
        .manage(opide_ai::engine::frontend_bridge::FrontendBridgeState::new())
        // Codebase indexer state
        .manage(opide_ai::indexer::IndexerState {
            index: std::sync::Mutex::new(None),
            external_index: std::sync::Mutex::new(None),
        })
        // ── Plugins ──────────────────────────────────────────────────────────
        .plugin(
            tauri_plugin_log::Builder::new()
                .target(tauri_plugin_log::Target::new(
                    tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("opide".into()),
                    },
                ))
                .max_file_size(5_000_000)
                .level(log::LevelFilter::Info)
                .level_for("paw_temp", log::LevelFilter::Debug)
                // ── Console noise reduction ─────────────────────────────────
                // Only show warnings+ from noisy modules. Keeps the console
                // readable: agent rounds, tool calls, errors. Nothing else.

                // Per-round noise (fires every single tool call)
                .level_for("opide_engine::engine::agent_loop::helpers", log::LevelFilter::Warn)
                .level_for("opide_engine::engine::binary_ipc", log::LevelFilter::Warn)
                .level_for("opide_engine::engine::engram::context_continuity", log::LevelFilter::Warn)
                .level_for("opide_engine::engine::engram::context_builder", log::LevelFilter::Warn)
                .level_for("opide_engine::engine::http", log::LevelFilter::Warn)

                // Per-message noise (fires every chat send)
                .level_for("opide_engine::engine::chat", log::LevelFilter::Warn)
                .level_for("opide_engine::engine::telemetry", log::LevelFilter::Warn)
                .level_for("opide_engine::engine::memory::embedding", log::LevelFilter::Warn)
                .level_for("opide_engine::engine::engram::encryption", log::LevelFilter::Warn)
                .level_for("opide_engine::engine::engram::graph", log::LevelFilter::Warn)
                .level_for("opide_engine::engine::engram::bridge", log::LevelFilter::Warn)
                .level_for("opide_engine::engine::engram::cognitive_state", log::LevelFilter::Warn)
                .level_for("opide_engine::engine::sessions::agent_files", log::LevelFilter::Warn)

                // Provider internals (thinking budget, request signing, cache stats)
                .level_for("opide_engine::engine::providers", log::LevelFilter::Warn)

                // Pricing / cost tracking (fake estimates, not real API costs)
                .level_for("opide_engine::engine::pricing", log::LevelFilter::Warn)

                // Skill library seeding (startup noise)
                .level_for("opide_engine::engine::engram::skill_library", log::LevelFilter::Warn)
                .level_for("opide_engine::engine::skills", log::LevelFilter::Warn)

                // MCP server lifecycle (spawning, connecting, tool counts)
                .level_for("opide_engine::engine::mcp::client", log::LevelFilter::Warn)
                .level_for("opide_engine::engine::mcp::transport", log::LevelFilter::Warn)

                // Extension host / bridge (adapter scan, registration)
                .level_for("opide_shell::extension_host", log::LevelFilter::Warn)

                // File watcher (watch/unwatch every folder open)
                .level_for("opide_shell::watcher", log::LevelFilter::Warn)

                // Terminal spawn/kill
                .level_for("opide_shell::terminal", log::LevelFilter::Warn)

                // Indexer (workspace open, cache load)
                .level_for("opide_ai::indexer", log::LevelFilter::Warn)
                .level_for("opide_ai::indexer::index", log::LevelFilter::Warn)

                // Bridge (procedural memory seeding)
                .level_for("opide_bridge", log::LevelFilter::Warn)
                .build(),
        )
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        // ── Startup background tasks ──────────────────────────────────────────
        .setup(|app| {
            // Set OPIDE identity on the default agent
            {
                let state = app.state::<opide_engine::engine::state::EngineState>();
                let store = &state.store;
                if let Err(e) = store.set_agent_file("default", "IDENTITY.md", OPIDE_IDENTITY) {
                    log::error!("[opide] Failed to seed IDENTITY.md: {}", e);
                }

                // Seed OPIDE procedural memories — teaches agent to use WASM/sandbox/AST
                opide_bridge::seed_opide_procedural_memories(store);
            }

            // OPIDE: unlimited tool rounds — security audits on large codebases
            // need to run uninterrupted. Loop detector still catches stuck agents.
            {
                let state = app.state::<opide_engine::engine::state::EngineState>();
                let mut cfg = state.config.lock();
                cfg.max_tool_rounds = u32::MAX;
                cfg.context_window_tokens = 200_000;
                cfg.daily_budget_usd = 0.0; // Disable — OPIDE has no budget cap
            }

            // Cron heartbeat removed — OPIDE doesn't use cron tasks.
            // Re-add if OPIDE ever needs scheduled background tasks.

            // Codebase indexer: listen for workspace open events and index in background
            let idx_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                use tauri::Listener;
                let handle = idx_handle.clone();
                idx_handle.listen("open-workspace", move |event| {
                    let payload: serde_json::Value = serde_json::from_str(
                        event.payload()
                    ).unwrap_or_default();

                    if let Some(path) = payload.get("path").and_then(|p| p.as_str()) {
                        let workspace = path.to_string();
                        let h = handle.clone();
                        tauri::async_runtime::spawn(async move {
                            use tauri::Manager;
                            if let Some(state) = h.try_state::<opide_ai::indexer::IndexerState>() {
                                log::info!("[indexer] Workspace opened — indexing {}", workspace);
                                opide_ai::indexer::run_full_index(&workspace, &state, &h).await;
                            }
                        });
                    }
                });
            });

            Ok(())
        })
        // ── OPIDE commands + essential OpenPawz commands ─────────────────────────
        .invoke_handler(tauri::generate_handler![
            // ── OPIDE Native ────────────────────────────────────────────
            opide_shell::terminal::terminal_spawn,
            opide_shell::terminal::terminal_write,
            opide_shell::terminal::terminal_resize,
            opide_shell::terminal::terminal_kill,
            opide_shell::watcher::fs_watch,
            opide_shell::watcher::fs_unwatch,
            opide_shell::git::git_status,
            opide_shell::git::git_diff,
            opide_shell::git::git_stage,
            opide_shell::git::git_stage_all,
            opide_shell::git::git_unstage,
            opide_shell::git::git_commit,
            opide_shell::git::git_log,
            opide_shell::git::git_branches,
            opide_shell::git::git_checkout,
            opide_shell::git::git_checkpoint_create,
            opide_shell::git::git_checkpoint_restore,
            opide_shell::search::search_files,
            opide_shell::search::search_file_list,
            opide_shell::lsp::lsp_start,
            opide_shell::lsp::lsp_send,
            opide_shell::lsp::lsp_stop,
            opide_shell::lsp::lsp_list,
            opide_shell::dap::dap_start,
            opide_shell::dap::dap_send,
            opide_shell::dap::dap_stop,
            opide_shell::remote::remote_connect,
            opide_shell::remote::remote_exec,
            opide_shell::remote::remote_read_file,
            opide_shell::remote::remote_write_file,
            opide_shell::remote::remote_list_dir,
            opide_shell::extension_host::ext_host_start,
            opide_shell::extension_host::ext_host_send,
            opide_shell::extension_host::ext_host_stop,
            opide_shell::extension_host::ext_host_status,
            opide_shell::extension_host::ext_host_log,
            // B63/B64: Open VSX installer pipeline replaces curl/unzip shell.
            opide_shell::extensions::ext_fetch_url_text,
            opide_shell::extensions::ext_download_url_to_path,
            opide_shell::extensions::ext_extract_vsix,
            opide_ai::engine::frontend_bridge::ide_tool_response,
            opide_ai::engine::frontend_bridge::ide_edit_review_response,
            open_new_window,
            opide_shell::ide_mcp::ide_read_file,
            opide_shell::ide_mcp::ide_write_file,
            opide_shell::ide_mcp::ide_delete_file,
            opide_shell::ide_mcp::ide_list_dir,
            opide_shell::ide_mcp::ide_run_command,
            opide_shell::ide_mcp::ide_get_git_status,
            opide_shell::ide_mcp::ide_get_git_diff,
            opide_shell::ide_mcp::ide_search_text,
            opide_shell::ide_mcp::ide_apply_edit,
            opide_ai::indexer::context::ide_get_codebase_context,
            opide_ai::indexer::context::ide_search_semantic,
            opide_ai::indexer::trigger_reindex,
            opide_ai::indexer::index_external_path,
            opide_ai::indexer::get_index_status,
            // ── OpenPawz: Chat & Sessions ────────────────────────────────
            commands::chat::engine_chat_send,
            commands::chat::engine_chat_history,
            commands::chat::engine_chat_abort,
            commands::chat::engine_chat_inject,
            commands::chat::engine_chat_surface,
            commands::chat::engine_agent_reset,
            commands::chat::engine_sessions_list,
            commands::chat::engine_approve_tool,
            commands::chat::engine_set_active_workspace,
            // ── OpenPawz: Config ────────────────────────────────────────
            commands::config::engine_get_config,
            commands::config::engine_set_config,
            commands::config::engine_upsert_provider,
            commands::config::engine_list_provider_models,
            // ── OpenPawz: Agents ────────────────────────────────────────
            commands::agent::engine_list_all_agents,
            // ── OpenPawz: Memory ────────────────────────────────────────
            commands::memory::engine_message_feedback,
            // ── OpenPawz: MCP ───────────────────────────────────────────
            commands::mcp::engine_mcp_save_server,
            commands::mcp::engine_mcp_connect,
            commands::mcp::engine_mcp_disconnect,
            commands::mcp::engine_mcp_execute_tool,
        ])
        .run(tauri::generate_context!())
        .expect("error while running OPIDE");
}
