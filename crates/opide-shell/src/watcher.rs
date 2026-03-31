// OPIDE File Watcher — powered by the `notify` crate.
//
// Watches directories for changes and emits Tauri events so the frontend
// TauriFileSystemProvider can fire onDidChangeFile and the Explorer refreshes.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use notify::{recommended_watcher, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

// ─── Types ───────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Clone)]
pub struct FsChangeEvent {
    /// "created" | "updated" | "deleted"
    pub kind: String,
    pub path: String,
}

// ─── State ───────────────────────────────────────────────────────────────────

pub struct WatcherState {
    watchers: Mutex<HashMap<String, RecommendedWatcher>>,
}

impl WatcherState {
    pub fn new() -> Self {
        Self {
            watchers: Mutex::new(HashMap::new()),
        }
    }
}

// ─── Commands ────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn fs_watch(
    app: AppHandle,
    state: tauri::State<'_, WatcherState>,
    path: String,
    recursive: bool,
) -> Result<String, String> {
    let watch_path = PathBuf::from(&path);
    if !watch_path.exists() {
        return Err(format!("Path does not exist: {path}"));
    }

    let watch_id = uuid::Uuid::new_v4().to_string();
    let app_handle = app.clone();

    let mut watcher = recommended_watcher(move |res: Result<Event, notify::Error>| {
        if let Ok(event) = res {
            let kind = match event.kind {
                EventKind::Create(_) => "created",
                EventKind::Modify(_) => "updated",
                EventKind::Remove(_) => "deleted",
                _ => return, // ignore access, other
            };

            for path in event.paths {
                let _ = app_handle.emit(
                    "fs-change",
                    FsChangeEvent {
                        kind: kind.to_string(),
                        path: path.to_string_lossy().to_string(),
                    },
                );
            }
        }
    })
    .map_err(|e| format!("Failed to create watcher: {e}"))?;

    let mode = if recursive {
        RecursiveMode::Recursive
    } else {
        RecursiveMode::NonRecursive
    };

    watcher
        .watch(&watch_path, mode)
        .map_err(|e| format!("Failed to watch path: {e}"))?;

    let mut watchers = state.watchers.lock().map_err(|e| e.to_string())?;
    watchers.insert(watch_id.clone(), watcher);

    log::info!("[opide-watcher] watching {} (id: {})", path, watch_id);

    // Trigger codebase indexer when a root workspace directory is watched.
    // Root workspaces are recursive watches on directories that don't contain
    // path separators in common subdirs (.vscode, node_modules, etc.)
    if recursive && watch_path.is_dir()
        && !path.contains(".vscode")
        && !path.contains("node_modules")
        && !path.contains(".git/")
    {
        // Indexer trigger moved to lib.rs setup block — watcher focuses on file change events.
        // The workspace-open listener in lib.rs handles initial indexing.
        log::info!("[opide-watcher] watching {} (id: {})", path, watch_id);
    }

    Ok(watch_id)
}

#[tauri::command]
pub async fn fs_unwatch(
    state: tauri::State<'_, WatcherState>,
    watch_id: String,
) -> Result<(), String> {
    let mut watchers = state.watchers.lock().map_err(|e| e.to_string())?;
    if watchers.remove(&watch_id).is_some() {
        log::info!("[opide-watcher] unwatched {}", watch_id);
        Ok(())
    } else {
        Err(format!("Watch not found: {watch_id}"))
    }
}
