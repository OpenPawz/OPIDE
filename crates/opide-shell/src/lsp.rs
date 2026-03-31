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

/// Read one JSON-RPC message from a BufReader (blocking)
fn read_lsp_message(reader: &mut BufReader<std::process::ChildStdout>) -> Option<String> {
    // Read headers
    let mut content_length: usize = 0;
    loop {
        let mut line = String::new();
        match reader.read_line(&mut line) {
            Ok(0) => return None, // EOF
            Ok(_) => {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    break; // End of headers
                }
                if let Some(len_str) = trimmed.strip_prefix("Content-Length: ") {
                    content_length = len_str.parse().unwrap_or(0);
                }
            }
            Err(_) => return None,
        }
    }

    if content_length == 0 {
        return None;
    }

    // Read body
    let mut body = vec![0u8; content_length];
    match std::io::Read::read_exact(reader, &mut body) {
        Ok(()) => String::from_utf8(body).ok(),
        Err(_) => None,
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

    // Check if the command exists
    let which_result = Command::new("which")
        .arg(config.command)
        .output();
    if which_result.map(|o| !o.status.success()).unwrap_or(true) {
        return Err(format!(
            "Language server '{}' not found. Install it first.",
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
                Some(message) => {
                    let _ = app_handle.emit(
                        "lsp-message",
                        LspMessageEvent {
                            server_id: sid.clone(),
                            message,
                        },
                    );
                }
                None => {
                    log::info!("[opide-lsp] reader ended for {}", sid);
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
    let mut servers = state.servers.lock().map_err(|e| e.to_string())?;

    if let Some(mut instance) = servers.remove(&server_id) {
        // Send shutdown request then kill
        if let Some(ref mut stdin) = instance.stdin_writer {
            let shutdown = r#"{"jsonrpc":"2.0","id":999999,"method":"shutdown","params":null}"#;
            if let Err(e) = stdin.write_all(&encode_lsp_message(shutdown)) { log::warn!("[lsp] shutdown write failed: {}", e); }
            if let Err(e) = stdin.flush() { log::warn!("[lsp] shutdown flush failed: {}", e); }
        }
        // Give it a moment then kill
        if let Err(e) = instance.child.kill() { log::warn!("[lsp] kill failed: {}", e); }
        log::info!("[opide-lsp] stopped {}", server_id);
        Ok(())
    } else {
        Err(format!("LSP server not found: {server_id}"))
    }
}

#[tauri::command]
pub async fn lsp_list(
    state: tauri::State<'_, LspState>,
) -> Result<Vec<String>, String> {
    let servers = state.servers.lock().map_err(|e| e.to_string())?;
    Ok(servers.keys().cloned().collect())
}
