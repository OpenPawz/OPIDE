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
use std::sync::{Arc, Mutex};
use std::thread;

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::utf8::Utf8Decoder;

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
    /// B115: per-terminal Arc<Mutex> so terminal_write can release the
    /// HashMap lock before doing the (potentially blocking) PTY write.
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    /// B110: a ChildKiller is independent of the Child handle, so the kill
    /// path can SIGKILL even while the exit-waiter thread is blocked on
    /// `wait()` holding the Child mutex.
    killer: Arc<Mutex<Box<dyn portable_pty::ChildKiller + Send + Sync>>>,
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

/// B117: cross-platform shell selection — prefer pwsh/powershell on Windows,
/// fall back through zsh→bash→sh on Unix.
fn default_shell() -> String {
    if cfg!(target_os = "windows") {
        if which::which("pwsh").is_ok() {
            return "pwsh".to_string();
        }
        if which::which("powershell").is_ok() {
            return "powershell".to_string();
        }
        std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into())
    } else if let Ok(s) = std::env::var("SHELL") {
        if !s.is_empty() {
            return s;
        }
        fallback_unix_shell()
    } else {
        fallback_unix_shell()
    }
}

fn fallback_unix_shell() -> String {
    for candidate in &["/bin/zsh", "/bin/bash", "/bin/sh"] {
        if std::path::Path::new(candidate).exists() {
            return (*candidate).to_string();
        }
    }
    "/bin/sh".to_string()
}

/// B118: use `dirs::home_dir` instead of HOME env so Windows USERPROFILE and
/// macOS sandbox paths are resolved correctly.
fn default_cwd() -> String {
    dirs::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| {
            if cfg!(target_os = "windows") {
                "C:\\".to_string()
            } else {
                "/".to_string()
            }
        })
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

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn shell: {e}"))?;
    // Split off a killer handle BEFORE handing the Child to the exit-waiter
    // thread (which will hold the Child for the duration of `wait()`).
    let killer = child.clone_killer();

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

    // The Child stays exclusively in the exit-waiter thread; only the killer
    // is shared with the terminal_kill command.
    let writer_arc = Arc::new(Mutex::new(writer));
    let killer_arc: Arc<Mutex<Box<dyn portable_pty::ChildKiller + Send + Sync>>> =
        Arc::new(Mutex::new(killer));

    // Store the terminal instance
    {
        let mut terminals = state.terminals.lock().map_err(|e| e.to_string())?;
        terminals.insert(
            terminal_id.clone(),
            TerminalInstance {
                master: pair.master,
                writer: Arc::clone(&writer_arc),
                killer: Arc::clone(&killer_arc),
            },
        );
    }

    // Spawn background reader thread — streams PTY output to frontend.
    // B109: decode UTF-8 across chunk boundaries so multi-byte characters
    // aren't corrupted into U+FFFD when split.
    // B116: retry on Interrupted/WouldBlock; only break on real EOF/fatal error.
    let tid = terminal_id.clone();
    let app_handle = app.clone();
    thread::spawn(move || {
        let mut buf = [0u8; 4096];
        let mut decoder = Utf8Decoder::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break, // EOF — shell exited
                Ok(n) => {
                    let data = decoder.push(&buf[..n]);
                    if !data.is_empty() {
                        let _ = app_handle.emit(
                            "terminal-data",
                            TerminalDataEvent {
                                terminal_id: tid.clone(),
                                data,
                            },
                        );
                    }
                }
                Err(e) => {
                    use std::io::ErrorKind::*;
                    if matches!(e.kind(), Interrupted | WouldBlock) {
                        std::thread::sleep(std::time::Duration::from_millis(10));
                        continue;
                    }
                    log::warn!("[opide-terminal] reader fatal error for {}: {}", tid, e);
                    break;
                }
            }
        }
        log::info!("[opide-terminal] reader thread ended for {}", tid);
    });

    // B111: dedicated exit-waiter thread that reports the real exit code.
    // Reader EOF and child exit are not guaranteed to coincide, so wait on
    // the child explicitly. The Child is owned solely by this thread; the
    // kill path uses the cloned killer handle.
    let tid_exit = terminal_id.clone();
    let app_exit = app.clone();
    thread::spawn(move || {
        let exit_code = child.wait().ok().map(|s| s.exit_code() as i32);
        let _ = app_exit.emit(
            "terminal-exit",
            TerminalExitEvent {
                terminal_id: tid_exit,
                exit_code,
            },
        );
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
    // B115: clone the writer Arc out, then drop the HashMap lock before doing
    // the (potentially blocking) PTY write. Otherwise every other terminal
    // command queues behind one slow writer.
    let writer = {
        let terminals = state.terminals.lock().map_err(|e| e.to_string())?;
        terminals
            .get(&terminal_id)
            .map(|i| Arc::clone(&i.writer))
            .ok_or_else(|| format!("Terminal not found: {terminal_id}"))?
    };

    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let mut w = writer.lock().map_err(|e| e.to_string())?;
        w.write_all(data.as_bytes())
            .map_err(|e| format!("Write failed: {e}"))?;
        w.flush().map_err(|e| format!("Flush failed: {e}"))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("Write task: {e}"))?
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
    // B110: kill+wait off the async runtime. Just dropping the instance leaves
    // a zombie until the OS reaps it; the exit-waiter thread also blocks
    // forever on `wait` if we don't actually send SIGKILL.
    let instance = {
        let mut terminals = state.terminals.lock().map_err(|e| e.to_string())?;
        terminals.remove(&terminal_id)
    };
    let Some(instance) = instance else {
        return Err(format!("Terminal not found: {terminal_id}"));
    };

    let killer = instance.killer;
    tokio::task::spawn_blocking(move || {
        if let Ok(mut k) = killer.lock() {
            let _ = k.kill();
            // Don't wait here — the exit-waiter thread spawned in terminal_spawn
            // is already blocked on .wait() and will release once kill() lands.
        }
    })
    .await
    .map_err(|e| format!("Kill task failed: {e}"))?;

    log::info!("[opide-terminal] killed terminal {}", terminal_id);
    Ok(())
}
