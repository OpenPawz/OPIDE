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

You have access to all tools the user has authorized. Call tools directly without conversational confirmation; the user controls approval through OPIDE's mode toggle (Ask / Auto / Yolo) and a banner will surface when the engine needs their input. Treat that banner as out of band: do not stall the agent loop waiting for it. If a tool call fails, handle the error and try a different approach.

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

/// Return the Open-VSX target-platform string for the current host
/// (e.g. "darwin-arm64", "linux-x64"). Used by the extension installer
/// to pick the right VSIX for extensions that ship native binaries
/// per platform — Claude Code being the canonical example.
///
/// Open-VSX targetPlatform values match VS Code's marketplace:
/// {linux,darwin,win32,alpine}-{x64,arm64}. Anything else falls
/// through; the installer's fallback path handles unknown platforms
/// by using the publisher's default `files.download`.
#[tauri::command]
fn get_target_platform() -> String {
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        "linux" => "linux",
        "windows" => "win32",
        other => other,
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        other => other,
    };
    format!("{os}-{arch}")
}

/// Open the OPIDE chat in a detached window. The detached window loads
/// `chat.html` which renders only the chat panel — no full workbench, no
/// Monaco editor. State migration between the auxiliary-bar slot and the
/// detached window happens through localStorage at the key
/// `opide:chat:detached-state`. Engine events broadcast to all webviews
/// via `app.emit()` so the detached window receives the same payloads
/// as the main window for free.
#[tauri::command]
async fn open_chat_window(app: tauri::AppHandle) -> Result<String, String> {
    let window_label = "opide-chat-detached";

    // If the chat is already detached, focus that window instead of
    // spawning a duplicate. Multi-instance detached chat is not a v1
    // feature.
    if let Some(existing) = app.get_webview_window(window_label) {
        let _ = existing.set_focus();
        return Ok(window_label.to_string());
    }

    let mut builder = tauri::WebviewWindowBuilder::new(
        &app,
        window_label,
        WebviewUrl::App("chat.html".into()),
    )
    .title("OPIDE Chat")
    .inner_size(420.0, 720.0)
    .min_inner_size(320.0, 480.0)
    .resizable(true)
    .decorations(true);

    // On macOS tie the chat window's lifecycle to the main OPIDE window
    // so minimise / close cascades. On other platforms parent-window
    // tracking is not as clean; the window stays independent and the
    // user manages it via the OS.
    #[cfg(target_os = "macos")]
    {
        if let Some(main) = app.get_webview_window("main") {
            builder = builder.parent(&main).map_err(|e| format!("parent: {e}"))?;
        }
    }

    builder
        .build()
        .map_err(|e| format!("Failed to open chat window: {e}"))?;

    log::info!("[opide] opened detached chat window: {}", window_label);
    Ok(window_label.to_string())
}

/// Close the detached chat window programmatically. Called by the
/// chat-window's Reattach button after it has serialised state into
/// localStorage and emitted a `chat-reattach` event.
#[tauri::command]
async fn close_chat_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("opide-chat-detached") {
        window.close().map_err(|e| format!("close: {e}"))?;
    }
    Ok(())
}


/// Build the native application menu (macOS menu bar + Windows/Linux window
/// menu).
///
/// Accelerator policy: OPIDE runs a full VS Code workbench in the webview, and
/// VS Code owns all the editor keybindings (Cmd+S/N/W/Z/F, Cmd+Shift+P, …). A
/// native menu accelerator would intercept the keystroke BEFORE the webview
/// sees it, which breaks context-aware bindings and, worse, native Undo/Redo
/// (Cmd+Z) and Close-Window (Cmd+W) would shadow Monaco's own undo stack and
/// VS Code's close-tab. So the editor-action items carry NO accelerator (they
/// stay clickable; the keys flow to VS Code). Only universally-safe predefined
/// accelerators are kept (clipboard, Quit, Hide, Minimize, Fullscreen), which
/// do the same thing whether the OS or the webview handles them.
///
/// Custom items carry a dotted id (e.g. `file.save`) forwarded to the frontend
/// via `menu-action`, which runs the matching VS Code workbench command.
fn build_app_menu(
    handle: &tauri::AppHandle,
) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};

    // App menu (shown under the app name on macOS).
    let app_menu = Submenu::with_items(
        handle,
        "OPIDE",
        true,
        &[
            &PredefinedMenuItem::about(handle, Some("About OPIDE"), Some(AboutMetadata::default()))?,
            &PredefinedMenuItem::separator(handle)?,
            &MenuItem::with_id(handle, "app.settings", "Settings…", true, None::<&str>)?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::services(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::hide(handle, None)?,
            &PredefinedMenuItem::hide_others(handle, None)?,
            &PredefinedMenuItem::show_all(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::quit(handle, None)?,
        ],
    )?;

    let file_menu = Submenu::with_items(
        handle,
        "File",
        true,
        &[
            &MenuItem::with_id(handle, "file.new", "New File", true, None::<&str>)?,
            &PredefinedMenuItem::separator(handle)?,
            &MenuItem::with_id(handle, "file.open", "Open File…", true, None::<&str>)?,
            &MenuItem::with_id(handle, "file.openFolder", "Open Folder…", true, None::<&str>)?,
            &PredefinedMenuItem::separator(handle)?,
            &MenuItem::with_id(handle, "file.save", "Save", true, None::<&str>)?,
            &MenuItem::with_id(handle, "file.saveAs", "Save As…", true, None::<&str>)?,
            &MenuItem::with_id(handle, "file.saveAll", "Save All", true, None::<&str>)?,
            &PredefinedMenuItem::separator(handle)?,
            &MenuItem::with_id(handle, "file.closeEditor", "Close Editor", true, None::<&str>)?,
        ],
    )?;

    let edit_menu = Submenu::with_items(
        handle,
        "Edit",
        true,
        &[
            // Undo/Redo dispatch VS Code commands (no accelerator) so they hit
            // Monaco's undo stack, not the webview's DOM undo.
            &MenuItem::with_id(handle, "edit.undo", "Undo", true, None::<&str>)?,
            &MenuItem::with_id(handle, "edit.redo", "Redo", true, None::<&str>)?,
            &PredefinedMenuItem::separator(handle)?,
            // Clipboard is identical whether the OS or webview handles it, so
            // the standard Cmd+X/C/V/A accelerators are safe to keep.
            &PredefinedMenuItem::cut(handle, None)?,
            &PredefinedMenuItem::copy(handle, None)?,
            &PredefinedMenuItem::paste(handle, None)?,
            &PredefinedMenuItem::select_all(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &MenuItem::with_id(handle, "edit.find", "Find", true, None::<&str>)?,
            &MenuItem::with_id(handle, "edit.replace", "Replace", true, None::<&str>)?,
        ],
    )?;

    let view_menu = Submenu::with_items(
        handle,
        "View",
        true,
        &[
            &MenuItem::with_id(handle, "view.commandPalette", "Command Palette…", true, None::<&str>)?,
            &PredefinedMenuItem::separator(handle)?,
            &MenuItem::with_id(handle, "view.explorer", "Explorer", true, None::<&str>)?,
            &MenuItem::with_id(handle, "view.search", "Search", true, None::<&str>)?,
            &MenuItem::with_id(handle, "view.scm", "Source Control", true, None::<&str>)?,
            &MenuItem::with_id(handle, "view.terminal", "Toggle Terminal", true, None::<&str>)?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::fullscreen(handle, None)?,
        ],
    )?;

    let window_menu = Submenu::with_items(
        handle,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(handle, None)?,
            &PredefinedMenuItem::maximize(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            // Custom (no Cmd+W accelerator) so VS Code's Cmd+W = close-tab is
            // preserved; this closes the whole window when clicked.
            &MenuItem::with_id(handle, "window.close", "Close Window", true, None::<&str>)?,
        ],
    )?;

    let help_menu = Submenu::with_items(
        handle,
        "Help",
        true,
        &[
            &MenuItem::with_id(handle, "help.docs", "OPIDE Documentation", true, None::<&str>)?,
        ],
    )?;

    Menu::with_items(
        handle,
        &[&app_menu, &file_menu, &edit_menu, &view_menu, &window_menu, &help_menu],
    )
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// Install a process-wide panic hook that records crashes locally.
///
/// Privacy-first: OPIDE never phones home. Panics are written to a local
/// `crash.log` in the data dir (always works, even before the logger is up,
/// so users can voluntarily attach it to a bug report) and to the structured
/// app log once `tauri_plugin_log` has initialised. Without this a panic in a
/// background thread would vanish to stderr and the crash would be invisible.
fn install_panic_hook() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "unknown".to_string());
        let msg = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| (*s).to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "<non-string panic payload>".to_string());
        let thread = std::thread::current()
            .name()
            .unwrap_or("unnamed")
            .to_string();
        let backtrace = std::backtrace::Backtrace::force_capture();
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);

        // Structured app log (file once the logger is registered).
        log::error!(
            "[panic] thread '{}' panicked at {}: {}\n{}",
            thread, location, msg, backtrace
        );

        // Dedicated crash.log — append so successive crashes accumulate.
        let dir = opide_engine::engine::paths::paw_data_dir();
        let _ = std::fs::create_dir_all(&dir);
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("crash.log"))
        {
            use std::io::Write;
            let _ = writeln!(
                f,
                "[{ts}] PANIC thread='{thread}' at {location}: {msg}\n{backtrace}\n"
            );
        }

        // Preserve default behaviour (prints to stderr).
        default_hook(info);
    }));
}

/// Pick a free TCP port on the loopback interface for the in-process
/// localhost asset server (release builds). Binding to port 0 lets the OS
/// choose an available port; we read it back, then drop the listener so
/// the localhost plugin can bind it. The tiny race window between drop and
/// re-bind is acceptable on loopback. Falls back to a fixed high port if
/// probing fails for any reason.
#[cfg(not(debug_assertions))]
fn pick_localhost_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .ok()
        .and_then(|l| l.local_addr().ok())
        .map(|addr| addr.port())
        .unwrap_or(49317)
}

pub fn run() {
    // Record crashes locally before anything else can panic (startup
    // `.expect()` calls, background threads, the tokio runtime).
    install_panic_hook();

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

    // Release builds serve the bundled frontend over http://localhost:<port>
    // (see the localhost plugin + window creation in setup() below) so VS Code
    // extension webviews can register their service workers. WKWebView rejects
    // serviceWorker.register() on the tauri:// custom protocol. Dev already runs
    // on http://localhost:5180 (vite), so this only affects release.
    #[cfg(not(debug_assertions))]
    let localhost_port: u16 = pick_localhost_port();

    // `mut` is only used in release (the localhost plugin is added below under
    // cfg(not(debug_assertions))); allow it so debug builds don't warn.
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default()
        // Webview resource loading is handled by monaco-vscode-api's
        // workbench webview service worker (registered via
        // @codingame/monaco-vscode-view-common-service-override).
        // Extensions get URLs of the form
        // https://file+.vscode-resource.vscode-cdn.net/<path> from
        // webview.asWebviewUri(); the service worker intercepts those
        // requests and serves them from the webview's localResourceRoots.
        // No custom Tauri URI scheme needed.
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
        // ── Native application menu ───────────────────────────────────────────
        .menu(|handle| build_app_menu(handle))
        .on_menu_event(|app, event| {
            use tauri::Emitter;
            // Predefined items (copy/paste/undo/quit/…) are handled natively by
            // the OS and don't reach here. Custom items carry a dotted id
            // (e.g. "file.save"); forward it to the frontend, which runs the
            // matching VS Code workbench command.
            let id = event.id().as_ref().to_string();
            let _ = app.emit("menu-action", id);
        })
        // ── Startup background tasks ──────────────────────────────────────────
        .setup(move |app| {
            // Logged here (not at builder time) so it lands in opide.log —
            // the log plugin only routes messages once the app is built.
            #[cfg(not(debug_assertions))]
            log::info!("[opide] serving frontend over http://localhost:{localhost_port}");

            // ── Create the main window ────────────────────────────────────
            // We build it here (not in tauri.conf.json) so release can point
            // it at the in-process localhost server while dev keeps the normal
            // devUrl flow. Settings mirror the previous tauri.conf window.
            {
                use tauri::{WebviewUrl, WebviewWindowBuilder};
                #[cfg(not(debug_assertions))]
                let url = WebviewUrl::External(
                    format!("http://localhost:{localhost_port}")
                        .parse()
                        .expect("valid localhost url"),
                );
                #[cfg(debug_assertions)]
                let url = WebviewUrl::default();

                WebviewWindowBuilder::new(app, "main", url)
                    .title("OPIDE")
                    .inner_size(1440.0, 900.0)
                    .min_inner_size(900.0, 600.0)
                    .resizable(true)
                    .center()
                    .build()?;
            }

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
            opide_shell::extensions::ext_get_disabled,
            opide_shell::extensions::ext_set_disabled,
            opide_ai::engine::frontend_bridge::ide_tool_response,
            opide_ai::engine::frontend_bridge::ide_edit_review_response,
            open_new_window,
            open_chat_window,
            close_chat_window,
            get_target_platform,
            opide_shell::ide_mcp::ide_read_file,
            opide_shell::ide_mcp::ide_write_file,
            opide_shell::ide_mcp::ide_read_file_bytes,
            opide_shell::ide_mcp::ide_write_file_bytes,
            opide_shell::ide_mcp::ide_stat,
            opide_shell::ide_mcp::open_external,
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
            // Memory palace surface — store/list/search/visualize engram memories.
            // Phase 1 stripped these as "unused"; phase 2 frontend restoration
            // showed they're load-bearing for the Memory Palace view.
            commands::memory::engine_memory_store,
            commands::memory::engine_memory_search,
            commands::memory::engine_memory_stats,
            commands::memory::engine_memory_get,
            commands::memory::engine_memory_update,
            commands::memory::engine_memory_delete,
            commands::memory::engine_memory_list,
            commands::memory::engine_memory_edges,
            commands::memory::engine_memory_embedding_projection,
            commands::memory::engine_memory_backfill,
            commands::memory::engine_get_memory_config,
            commands::memory::engine_test_embedding,
            commands::memory::engine_embedding_status,
            commands::memory::engine_embedding_pull_model,
            // ── OpenPawz: MCP ───────────────────────────────────────────
            commands::mcp::engine_mcp_save_server,
            commands::mcp::engine_mcp_connect,
            commands::mcp::engine_mcp_disconnect,
            commands::mcp::engine_mcp_execute_tool,
        ]);

    // Localhost asset server (release only). Serves the bundled frontend over
    // http://localhost:<port> so VS Code extension webview service workers can
    // register (WKWebView rejects them on the tauri:// custom protocol).
    // We intentionally do NOT set COOP/COEP here: dev already runs on a plain
    // http://localhost origin with no such headers and extension webviews work
    // there, while COEP `require-corp` would risk blocking cross-origin asset
    // and IPC loads. Matching dev keeps behaviour identical and low-risk.
    #[cfg(not(debug_assertions))]
    {
        builder = builder.plugin(
            tauri_plugin_localhost::Builder::new(localhost_port).build(),
        );
    }

    builder
        .run(tauri::generate_context!())
        .expect("error while running OPIDE");
}
