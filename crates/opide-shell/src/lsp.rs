// OPIDE LSP Bridge — spawns language servers and bridges JSON-RPC to the frontend.
//
// The Rust side manages language server processes:
//   - Spawn: start a language server for a given language
//   - Forward: pipe JSON-RPC messages between frontend ↔ language server
//   - Lifecycle: restart on crash, kill on workspace close
//
// The frontend connects via:
//   - `lsp_start` → spawn a language server, returns server_id
//   - `lsp_send` → send a JSON-RPC message to a running server
//   - `lsp-message` event → receive JSON-RPC responses/notifications from server
//   - `lsp_stop` → kill a language server

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

// ─── Types ───────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Clone)]
pub struct LspStartResult {
    pub server_id: String,
    pub language: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct LspMessageEvent {
    pub server_id: String,
    pub message: String,
}

#[derive(Debug, Deserialize)]
pub struct LspStartRequest {
    /// Language identifier: "typescript", "rust", "python", etc.
    pub language: String,
    /// Workspace root path — passed as rootUri to the language server
    pub workspace_path: String,
}

// ─── Known Language Servers ──────────────────────────────────────────────────

struct LspConfig {
    command: &'static str,
    args: &'static [&'static str],
}

fn get_lsp_config(language: &str) -> Option<LspConfig> {
    match language {
        "typescript" | "javascript" | "typescriptreact" | "javascriptreact" => Some(LspConfig {
            command: "typescript-language-server",
            args: &["--stdio"],
        }),
        "rust" => Some(LspConfig {
            command: "rust-analyzer",
            args: &[],
        }),
        "python" => Some(LspConfig {
            command: "pylsp",
            args: &[],
        }),
        "go" => Some(LspConfig {
            command: "gopls",
            args: &[],
        }),
        "c" | "cpp" | "objective-c" => Some(LspConfig {
            command: "clangd",
            args: &[],
        }),
        "css" | "scss" | "less" => Some(LspConfig {
            command: "css-languageserver",
            args: &["--stdio"],
        }),
        "html" => Some(LspConfig {
            command: "html-languageserver",
            args: &["--stdio"],
        }),
        "json" => Some(LspConfig {
            command: "json-languageserver",
            args: &["--stdio"],
        }),
        _ => None,
    }
}

// ─── Server Instance ─────────────────────────────────────────────────────────

struct LspInstance {
    child: Child,
    stdin_writer: Option<std::process::ChildStdin>,
}

// ─── State ───────────────────────────────────────────────────────────────────

pub struct LspState {
    servers: Mutex<HashMap<String, LspInstance>>,
}

impl LspState {
    pub fn new() -> Self {
        Self {
            servers: Mutex::new(HashMap::new()),
        }
    }
}

// ─── JSON-RPC Helpers ────────────────────────────────────────────────────────

/// Encode a JSON-RPC message with Content-Length header (LSP wire format)
fn encode_lsp_message(json: &str) -> Vec<u8> {
    let header = format!("Content-Length: {}\r\n\r\n", json.len());
    let mut msg = header.into_bytes();
    msg.extend_from_slice(json.as_bytes());
    msg
}

/// Outcome of one read_lsp_message call.
/// `Skip` means the framing was malformed but the stream is still alive — caller
/// should continue. Used by B123 to keep the reader thread up after a corrupt
/// message instead of treating it as EOF.
enum LspRead {
    Message(String),
    Skip,
    Eof,
}

/// Read one JSON-RPC message from a BufReader (blocking)
fn read_lsp_message(reader: &mut BufReader<std::process::ChildStdout>) -> LspRead {
    // Cap message size at 16 MiB so a malicious or buggy server can't OOM us.
    const MAX_MSG_BYTES: usize = 16 * 1024 * 1024;

    let mut content_length: Option<usize> = None;
    let mut header_line = String::new();
    loop {
        header_line.clear();
        match reader.read_line(&mut header_line) {
            Ok(0) => return LspRead::Eof,
            Ok(_) => {
                let trimmed = header_line.trim();
                if trimmed.is_empty() {
                    break; // End of headers
                }
                if let Some(len_str) = trimmed.strip_prefix("Content-Length: ") {
                    match len_str.parse::<usize>() {
                        Ok(n) if n <= MAX_MSG_BYTES => content_length = Some(n),
                        Ok(n) => {
                            log::warn!(
                                "[lsp] Content-Length too large ({}); skipping message",
                                n
                            );
                            // B123: skip rather than return EOF — server is still alive.
                            return LspRead::Skip;
                        }
                        Err(e) => {
                            log::warn!("[lsp] Bad Content-Length '{}': {}", len_str, e);
                            return LspRead::Skip;
                        }
                    }
                }
            }
            Err(_) => return LspRead::Eof,
        }
    }

    let len = match content_length {
        Some(n) => n,
        None => return LspRead::Skip, // header block ended without Content-Length
    };
    if len == 0 {
        return LspRead::Skip;
    }

    let mut body = vec![0u8; len];
    match std::io::Read::read_exact(reader, &mut body) {
        Ok(()) => match String::from_utf8(body) {
            Ok(s) => LspRead::Message(s),
            Err(_) => LspRead::Skip,
        },
        Err(_) => LspRead::Eof,
    }
}

// ─── Commands ────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn lsp_start(
    app: AppHandle,
    state: tauri::State<'_, LspState>,
    request: LspStartRequest,
) -> Result<LspStartResult, String> {
    let config = get_lsp_config(&request.language)
        .ok_or_else(|| format!("No language server configured for: {}", request.language))?;

    // B119: cross-platform existence check via the `which` crate. The old
    // `Command::new("which")` only worked on Unix and shelled out for every
    // start, which also made it racy with PATH changes mid-session.
    if which::which(config.command).is_err() {
        return Err(format!(
            "Language server '{}' not found in PATH. Install it first.",
            config.command
        ));
    }

    // Spawn the language server process
    let mut child = Command::new(config.command)
        .args(config.args)
        .current_dir(&request.workspace_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn {}: {e}", config.command))?;

    let server_id = uuid::Uuid::new_v4().to_string();

    // Take stdout for the reader thread
    let stdout = child
        .stdout
        .take()
        .ok_or("Failed to capture language server stdout")?;

    // Take stdin for writing
    let stdin = child
        .stdin
        .take()
        .ok_or("Failed to capture language server stdin")?;

    // Store the instance
    {
        let mut servers = state.servers.lock().map_err(|e| e.to_string())?;
        servers.insert(
            server_id.clone(),
            LspInstance {
                child,
                stdin_writer: Some(stdin),
            },
        );
    }

    // Spawn reader thread — reads JSON-RPC from language server, emits to frontend
    let sid = server_id.clone();
    let app_handle = app.clone();
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            match read_lsp_message(&mut reader) {
                LspRead::Message(message) => {
                    let _ = app_handle.emit(
                        "lsp-message",
                        LspMessageEvent {
                            server_id: sid.clone(),
                            message,
                        },
                    );
                }
                // B123: malformed frame — already logged inside the reader.
                LspRead::Skip => continue,
                LspRead::Eof => {
                    log::info!("[opide-lsp] reader ended for {}", sid);
                    // B122: notify frontend so it can drop its handle / restart.
                    let _ = app_handle.emit(
                        "lsp-exit",
                        serde_json::json!({ "server_id": &sid }),
                    );
                    break;
                }
            }
        }
    });

    // Also spawn stderr reader for logging
    // (language servers often log to stderr)
    let sid2 = server_id.clone();
    if let Some(stderr) = {
        let mut servers = state.servers.lock().map_err(|e| e.to_string())?;
        servers.get_mut(&server_id).and_then(|s| s.child.stderr.take())
    } {
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                match line {
                    Ok(l) => log::debug!("[opide-lsp:{}] {}", sid2, l),
                    Err(_) => break,
                }
            }
        });
    }

    log::info!(
        "[opide-lsp] started {} ({}) for workspace: {}",
        config.command,
        server_id,
        request.workspace_path
    );

    Ok(LspStartResult {
        server_id,
        language: request.language,
    })
}

#[tauri::command]
pub async fn lsp_send(
    state: tauri::State<'_, LspState>,
    server_id: String,
    message: String,
) -> Result<(), String> {
    let mut servers = state.servers.lock().map_err(|e| e.to_string())?;
    let instance = servers
        .get_mut(&server_id)
        .ok_or_else(|| format!("LSP server not found: {server_id}"))?;

    let stdin = instance
        .stdin_writer
        .as_mut()
        .ok_or("LSP stdin not available")?;

    let encoded = encode_lsp_message(&message);
    stdin
        .write_all(&encoded)
        .map_err(|e| format!("LSP write failed: {e}"))?;
    stdin
        .flush()
        .map_err(|e| format!("LSP flush failed: {e}"))?;

    Ok(())
}

#[tauri::command]
pub async fn lsp_stop(
    state: tauri::State<'_, LspState>,
    server_id: String,
) -> Result<(), String> {
    let instance = {
        let mut servers = state.servers.lock().map_err(|e| e.to_string())?;
        servers.remove(&server_id)
    };
    let Some(mut instance) = instance else {
        return Err(format!("LSP server not found: {server_id}"));
    };

    // B120: use a UUID-based shutdown id instead of the magic 999999 — that
    // value can collide with real long-running request ids on busy servers.
    if let Some(ref mut stdin) = instance.stdin_writer {
        let shutdown = format!(
            r#"{{"jsonrpc":"2.0","id":"opide-shutdown-{}","method":"shutdown","params":null}}"#,
            uuid::Uuid::new_v4()
        );
        if let Err(e) = stdin.write_all(&encode_lsp_message(&shutdown)) {
            log::warn!("[lsp] shutdown write failed: {}", e);
        }
        if let Err(e) = stdin.flush() {
            log::warn!("[lsp] shutdown flush failed: {}", e);
        }
    }
    // Drop stdin so the server sees EOF and exits gracefully.
    instance.stdin_writer = None;

    // B121: give the server up to 2s to exit cleanly; only SIGKILL if it
    // doesn't go on its own. Run the wait off the async runtime.
    let mut child = instance.child;
    tokio::task::spawn_blocking(move || {
        for _ in 0..20 {
            match child.try_wait() {
                Ok(Some(_)) => return,
                _ => std::thread::sleep(std::time::Duration::from_millis(100)),
            }
        }
        if let Err(e) = child.kill() {
            log::warn!("[lsp] kill failed: {}", e);
        }
        let _ = child.wait();
    })
    .await
    .map_err(|e| format!("LSP wait task: {e}"))?;

    log::info!("[opide-lsp] stopped {}", server_id);
    Ok(())
}

#[tauri::command]
pub async fn lsp_list(
    state: tauri::State<'_, LspState>,
) -> Result<Vec<String>, String> {
    let servers = state.servers.lock().map_err(|e| e.to_string())?;
    Ok(servers.keys().cloned().collect())
}
