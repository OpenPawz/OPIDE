// OPIDE DAP Bridge — Debug Adapter Protocol process manager.
//
// Same architecture as lsp.rs — Rust spawns debug adapter processes
// and bridges DAP JSON messages between the frontend and the adapter.
//
// DAP uses the same Content-Length framed JSON protocol as LSP.
// VS Code's debug-service-override handles the UI (breakpoints,
// call stack, variables, watch). We just provide the transport.
//
// Supported adapters (auto-detected):
//   - codelldb (Rust/C/C++)
//   - node-debug (Node.js / JavaScript / TypeScript)
//   - debugpy (Python)

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

// ─── Types ───────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Clone)]
pub struct DapStartResult {
    pub adapter_id: String,
    pub adapter_type: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct DapMessageEvent {
    pub adapter_id: String,
    pub message: String,
}

#[derive(Debug, Deserialize)]
pub struct DapStartRequest {
    /// Debug adapter type: "codelldb", "node", "debugpy", "lldb", etc.
    pub adapter_type: String,
    /// Working directory
    pub cwd: Option<String>,
    /// Optional path to a custom debug adapter executable
    pub adapter_path: Option<String>,
}

// ─── Known Debug Adapters ────────────────────────────────────────────────────

struct DapConfig {
    command: &'static str,
    args: &'static [&'static str],
}

fn get_dap_config(adapter_type: &str) -> Option<DapConfig> {
    match adapter_type {
        "codelldb" | "lldb" | "rust" | "c" | "cpp" => Some(DapConfig {
            command: "codelldb",
            args: &["--port", "0"], // 0 = use stdio mode
        }),
        "node" | "node-debug" | "javascript" | "typescript" => Some(DapConfig {
            command: "node",
            args: &["--inspect-brk"], // Node.js built-in debugger
        }),
        "debugpy" | "python" => Some(DapConfig {
            command: "python3",
            args: &["-m", "debugpy.adapter"],
        }),
        _ => None,
    }
}

// ─── Instance ────────────────────────────────────────────────────────────────

struct DapInstance {
    _child: Child,
    stdin_writer: Option<std::process::ChildStdin>,
}

// ─── State ───────────────────────────────────────────────────────────────────

pub struct DapState {
    adapters: Mutex<HashMap<String, DapInstance>>,
}

impl DapState {
    pub fn new() -> Self {
        Self {
            adapters: Mutex::new(HashMap::new()),
        }
    }
}

// ─── Wire Protocol (same as LSP) ─────────────────────────────────────────────

fn encode_dap_message(json: &str) -> Vec<u8> {
    let header = format!("Content-Length: {}\r\n\r\n", json.len());
    let mut msg = header.into_bytes();
    msg.extend_from_slice(json.as_bytes());
    msg
}

fn read_dap_message(reader: &mut BufReader<std::process::ChildStdout>) -> Option<String> {
    let mut content_length: usize = 0;
    loop {
        let mut line = String::new();
        match reader.read_line(&mut line) {
            Ok(0) => return None,
            Ok(_) => {
                let trimmed = line.trim();
                if trimmed.is_empty() { break; }
                if let Some(len_str) = trimmed.strip_prefix("Content-Length: ") {
                    content_length = len_str.parse().unwrap_or(0);
                }
            }
            Err(_) => return None,
        }
    }
    if content_length == 0 { return None; }

    let mut body = vec![0u8; content_length];
    match std::io::Read::read_exact(reader, &mut body) {
        Ok(()) => String::from_utf8(body).ok(),
        Err(_) => None,
    }
}

// ─── Commands ────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn dap_start(
    app: AppHandle,
    state: tauri::State<'_, DapState>,
    request: DapStartRequest,
) -> Result<DapStartResult, String> {
    // Use custom path or resolve from known adapters
    let (cmd, args): (String, Vec<String>) = if let Some(ref path) = request.adapter_path {
        (path.clone(), vec![])
    } else {
        let config = get_dap_config(&request.adapter_type)
            .ok_or_else(|| format!("Unknown debug adapter: {}", request.adapter_type))?;
        (
            config.command.to_string(),
            config.args.iter().map(|s| s.to_string()).collect(),
        )
    };

    let cwd = request.cwd.unwrap_or_else(|| "/tmp".to_string());

    let mut child = Command::new(&cmd)
        .args(&args)
        .current_dir(&cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn debug adapter '{}': {e}", cmd))?;

    let adapter_id = uuid::Uuid::new_v4().to_string();

    let stdout = child.stdout.take().ok_or("Failed to capture adapter stdout")?;
    let stdin = child.stdin.take().ok_or("Failed to capture adapter stdin")?;

    // Store instance
    {
        let mut adapters = state.adapters.lock().map_err(|e| e.to_string())?;
        adapters.insert(adapter_id.clone(), DapInstance {
            _child: child,
            stdin_writer: Some(stdin),
        });
    }

    // Reader thread
    let aid = adapter_id.clone();
    let app_handle = app.clone();
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            match read_dap_message(&mut reader) {
                Some(message) => {
                    let _ = app_handle.emit("dap-message", DapMessageEvent {
                        adapter_id: aid.clone(),
                        message,
                    });
                }
                None => {
                    log::info!("[opide-dap] reader ended for {}", aid);
                    break;
                }
            }
        }
    });

    log::info!("[opide-dap] started {} adapter ({})", request.adapter_type, adapter_id);

    Ok(DapStartResult {
        adapter_id,
        adapter_type: request.adapter_type,
    })
}

#[tauri::command]
pub async fn dap_send(
    state: tauri::State<'_, DapState>,
    adapter_id: String,
    message: String,
) -> Result<(), String> {
    let mut adapters = state.adapters.lock().map_err(|e| e.to_string())?;
    let instance = adapters.get_mut(&adapter_id)
        .ok_or_else(|| format!("Debug adapter not found: {adapter_id}"))?;

    let stdin = instance.stdin_writer.as_mut()
        .ok_or("DAP stdin not available")?;

    let encoded = encode_dap_message(&message);
    stdin.write_all(&encoded).map_err(|e| format!("DAP write failed: {e}"))?;
    stdin.flush().map_err(|e| format!("DAP flush failed: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn dap_stop(
    state: tauri::State<'_, DapState>,
    adapter_id: String,
) -> Result<(), String> {
    let mut adapters = state.adapters.lock().map_err(|e| e.to_string())?;
    if let Some(mut instance) = adapters.remove(&adapter_id) {
        if let Err(e) = instance._child.kill() { log::warn!("[dap] kill failed: {}", e); }
        log::info!("[opide-dap] stopped {}", adapter_id);
        Ok(())
    } else {
        Err(format!("Debug adapter not found: {adapter_id}"))
    }
}
