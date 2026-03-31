// OPIDE Terminal — PTY management via portable-pty.
//
// Each terminal instance gets:
//   - A PTY master/slave pair
//   - A background reader thread that streams output via Tauri events
//   - Tauri commands for write, resize, and kill
//
// Frontend connects via @codingame/monaco-vscode-terminal-service-override.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;
use std::thread;

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

// ─── Types ───────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Clone)]
pub struct TerminalSpawnResult {
    pub terminal_id: String,
    pub pid: u32,
}

#[derive(Debug, Serialize, Clone)]
pub struct TerminalDataEvent {
    pub terminal_id: String,
    pub data: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct TerminalExitEvent {
    pub terminal_id: String,
    pub exit_code: Option<i32>,
}

#[derive(Debug, Deserialize)]
pub struct TerminalSpawnRequest {
    pub cwd: Option<String>,
    pub shell: Option<String>,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
    pub env: Option<HashMap<String, String>>,
}

// ─── Terminal Instance ───────────────────────────────────────────────────────

struct TerminalInstance {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    // child is kept alive so the process doesn't get dropped
    _child: Box<dyn portable_pty::Child + Send + Sync>,
}

// ─── State ───────────────────────────────────────────────────────────────────

pub struct TerminalState {
    terminals: Mutex<HashMap<String, TerminalInstance>>,
}

impl TerminalState {
    pub fn new() -> Self {
        Self {
            terminals: Mutex::new(HashMap::new()),
        }
    }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

fn default_shell() -> String {
    if cfg!(target_os = "windows") {
        std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into())
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into())
    }
}

fn default_cwd() -> String {
    std::env::var("HOME").unwrap_or_else(|_| "/".into())
}

// ─── Commands ────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn terminal_spawn(
    app: AppHandle,
    state: tauri::State<'_, TerminalState>,
    request: TerminalSpawnRequest,
) -> Result<TerminalSpawnResult, String> {
    let cols = request.cols.unwrap_or(80);
    let rows = request.rows.unwrap_or(24);
    let shell = request.shell.unwrap_or_else(default_shell);
    let cwd = request.cwd.unwrap_or_else(default_cwd);

    let pty_system = native_pty_system();

    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to open PTY: {e}"))?;

    let mut cmd = CommandBuilder::new(&shell);
    cmd.cwd(&cwd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

    // Merge any extra env vars from the request
    if let Some(env_vars) = request.env {
        for (key, val) in env_vars {
            cmd.env(key, val);
        }
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn shell: {e}"))?;

    // Drop the slave — child owns it now
    drop(pair.slave);

    let pid = child
        .process_id()
        .unwrap_or(0);

    let terminal_id = uuid::Uuid::new_v4().to_string();

    // Clone reader for the background thread
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Failed to clone PTY reader: {e}"))?;

    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("Failed to take PTY writer: {e}"))?;

    // Store the terminal instance
    {
        let mut terminals = state.terminals.lock().map_err(|e| e.to_string())?;
        terminals.insert(
            terminal_id.clone(),
            TerminalInstance {
                master: pair.master,
                writer,
                _child: child,
            },
        );
    }

    // Spawn background reader thread — streams PTY output to frontend
    let tid = terminal_id.clone();
    let app_handle = app.clone();
    thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break, // EOF — shell exited
                Ok(n) => {
                    // PTY output is raw bytes — convert to String (lossy for non-UTF8)
                    let data = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = app_handle.emit(
                        "terminal-data",
                        TerminalDataEvent {
                            terminal_id: tid.clone(),
                            data,
                        },
                    );
                }
                Err(e) => {
                    log::warn!("[opide-terminal] reader error for {}: {}", tid, e);
                    break;
                }
            }
        }
        // Terminal exited — notify frontend
        let _ = app_handle.emit(
            "terminal-exit",
            TerminalExitEvent {
                terminal_id: tid.clone(),
                exit_code: None, // portable-pty doesn't easily give exit code from reader thread
            },
        );
        log::info!("[opide-terminal] reader thread ended for {}", tid);
    });

    let result = TerminalSpawnResult {
        terminal_id,
        pid: pid as u32,
    };
    log::info!("[opide-terminal] spawned terminal {} (pid {})", result.terminal_id, result.pid);
    Ok(result)
}

#[tauri::command]
pub async fn terminal_write(
    state: tauri::State<'_, TerminalState>,
    terminal_id: String,
    data: String,
) -> Result<(), String> {
    let mut terminals = state.terminals.lock().map_err(|e| e.to_string())?;
    let instance = terminals
        .get_mut(&terminal_id)
        .ok_or_else(|| format!("Terminal not found: {terminal_id}"))?;

    instance
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| format!("Write failed: {e}"))?;
    instance
        .writer
        .flush()
        .map_err(|e| format!("Flush failed: {e}"))?;

    Ok(())
}

#[tauri::command]
pub async fn terminal_resize(
    state: tauri::State<'_, TerminalState>,
    terminal_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let terminals = state.terminals.lock().map_err(|e| e.to_string())?;
    let instance = terminals
        .get(&terminal_id)
        .ok_or_else(|| format!("Terminal not found: {terminal_id}"))?;

    instance
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Resize failed: {e}"))?;

    Ok(())
}

#[tauri::command]
pub async fn terminal_kill(
    state: tauri::State<'_, TerminalState>,
    terminal_id: String,
) -> Result<(), String> {
    let mut terminals = state.terminals.lock().map_err(|e| e.to_string())?;

    if terminals.remove(&terminal_id).is_some() {
        log::info!("[opide-terminal] killed terminal {}", terminal_id);
        Ok(())
    } else {
        Err(format!("Terminal not found: {terminal_id}"))
    }
}
