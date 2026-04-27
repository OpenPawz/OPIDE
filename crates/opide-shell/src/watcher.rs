// OPIDE File Watcher — powered by the `notify` crate.
//
// Watches directories for changes and emits Tauri events so the frontend
// TauriFileSystemProvider can fire onDidChangeFile and the Explorer refreshes.

use std::collections::{HashMap, HashSet};
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

/// B124: a single Watcher per canonical root, shared by every subscriber.
/// Previously each `fs_watch` call spun up its own Watcher even when the
/// path matched an existing one — overlapping watches duplicated kernel
/// events and consumed FDs without bound.
struct WatcherEntry {
    /// Held to keep the watcher alive — dropping it stops kernel notifications.
    /// Reads happen entirely via the closure passed to `recommended_watcher`.
    #[allow(dead_code)]
    watcher: RecommendedWatcher,
    subscriber_ids: HashSet<String>,
}

pub struct WatcherState {
    /// canonical_path -> shared watcher entry
    by_path: Mutex<HashMap<String, WatcherEntry>>,
    /// subscriber watch_id -> canonical path it joined
    by_id: Mutex<HashMap<String, String>>,
}

impl WatcherState {
    pub fn new() -> Self {
        Self {
            by_path: Mutex::new(HashMap::new()),
            by_id: Mutex::new(HashMap::new()),
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
    // Dedup by canonical path — symlinks and `..` should resolve to the same entry.
    let canonical = watch_path
        .canonicalize()
        .map_err(|e| format!("Cannot canonicalize {path}: {e}"))?
        .to_string_lossy()
        .to_string();

    let watch_id = uuid::Uuid::new_v4().to_string();

    // Fast path: already watching this canonical root — register a new
    // subscriber id and return.
    {
        let mut by_path = state.by_path.lock().map_err(|e| e.to_string())?;
        if let Some(entry) = by_path.get_mut(&canonical) {
            entry.subscriber_ids.insert(watch_id.clone());
            drop(by_path);
            state
                .by_id
                .lock()
                .map_err(|e| e.to_string())?
                .insert(watch_id.clone(), canonical);
            return Ok(watch_id);
        }
    }

    // First subscriber for this path — create the underlying watcher.
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

    {
        let mut by_path = state.by_path.lock().map_err(|e| e.to_string())?;
        let mut subs = HashSet::new();
        subs.insert(watch_id.clone());
        by_path.insert(
            canonical.clone(),
            WatcherEntry {
                watcher,
                subscriber_ids: subs,
            },
        );
    }
    state
        .by_id
        .lock()
        .map_err(|e| e.to_string())?
        .insert(watch_id.clone(), canonical);

    log::info!("[opide-watcher] watching {} (id: {})", path, watch_id);
    // B128: removed the dead conditional log block — it duplicated the line
    // above and never gated any behavior.
    Ok(watch_id)
}

#[tauri::command]
pub async fn fs_unwatch(
    state: tauri::State<'_, WatcherState>,
    watch_id: String,
) -> Result<(), String> {
    let canonical = {
        let mut by_id = state.by_id.lock().map_err(|e| e.to_string())?;
        by_id.remove(&watch_id)
    };
    let Some(canonical) = canonical else {
        return Err(format!("Watch not found: {watch_id}"));
    };

    let mut by_path = state.by_path.lock().map_err(|e| e.to_string())?;
    if let Some(entry) = by_path.get_mut(&canonical) {
        entry.subscriber_ids.remove(&watch_id);
        if entry.subscriber_ids.is_empty() {
            by_path.remove(&canonical);
            log::info!("[opide-watcher] unwatched {} (last subscriber)", canonical);
        } else {
            log::debug!(
                "[opide-watcher] released subscriber {}; {} remain on {}",
                watch_id,
                entry.subscriber_ids.len(),
                canonical
            );
        }
    }
    Ok(())
}
