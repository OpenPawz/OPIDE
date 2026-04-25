// ── OPIDE Frontend Tool Bridge ───────────────────────────────────────────────
// Bridges agent tool calls to the frontend (Monaco editor) for data that only
// the frontend can provide: diagnostics, symbols, selection, open files.
//
// Flow:
//   1. Agent calls ide_get_diagnostics (or similar)
//   2. Rust emits "ide-tool-request" Tauri event with { request_id, tool, args }
//   3. Frontend gathers data from Monaco, calls ide_tool_response command
//   4. Rust resolves the pending request and returns data to the agent

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::oneshot;

// ─── Types ───────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Clone)]
pub struct ToolRequest {
    pub request_id: String,
    pub tool: String,
    pub args: serde_json::Value,
}

#[derive(Debug, Deserialize)]
pub struct ToolResponse {
    pub request_id: String,
    pub result: serde_json::Value,
}

// ─── Pending Requests ────────────────────────────────────────────────────────

pub struct FrontendBridgeState {
    pending: Mutex<HashMap<String, oneshot::Sender<serde_json::Value>>>,
    pending_reviews: Mutex<HashMap<String, oneshot::Sender<bool>>>,
}

impl FrontendBridgeState {
    pub fn new() -> Self {
        Self {
            pending: Mutex::new(HashMap::new()),
            pending_reviews: Mutex::new(HashMap::new()),
        }
    }
}

// ─── Edit Review (Accept/Reject diff flow) ──────────────────────────────────

/// Sent to the frontend to open a Monaco diff editor for user review.
#[derive(Debug, Serialize, Clone)]
pub struct EditReviewRequest {
    pub request_id: String,
    pub path: String,
    pub original_content: String,
    pub proposed_content: String,
    pub tool_name: String,
    pub description: String,
}

/// Send a proposed edit to the frontend for review in a Monaco diff editor.
/// Blocks until the user accepts or rejects (120s timeout).
pub async fn request_edit_review(
    app: &AppHandle,
    path: &str,
    original_content: &str,
    proposed_content: &str,
    tool_name: &str,
    description: &str,
) -> Result<bool, String> {
    let request_id = uuid::Uuid::new_v4().to_string();

    let (tx, rx) = oneshot::channel::<bool>();

    // Store the pending review
    if let Some(state) = app.try_state::<FrontendBridgeState>() {
        let mut pending = state.pending_reviews.lock().map_err(|e: std::sync::PoisonError<_>| e.to_string())?;
        pending.insert(request_id.clone(), tx);
    } else {
        return Err("FrontendBridgeState not registered".to_string());
    }

    // Emit the review request to the focused window only — not all windows
    let payload = EditReviewRequest {
        request_id: request_id.clone(),
        path: path.to_string(),
        original_content: original_content.to_string(),
        proposed_content: proposed_content.to_string(),
        tool_name: tool_name.to_string(),
        description: description.to_string(),
    };
    // B170: same cleanup discipline as request_from_frontend_timeout.
    let cleanup_review = |id: &str| {
        if let Some(state) = app.try_state::<FrontendBridgeState>() {
            if let Ok(mut pending) = state.pending_reviews.lock() {
                let _ = pending.remove(id);
            }
        }
    };

    let emitted = app
        .get_webview_window("main")
        .and_then(|w: tauri::WebviewWindow| w.emit("ide-edit-review", &payload).ok());
    if emitted.is_none() {
        // No main window — fall back to broadcast.
        if let Err(e) = app.emit("ide-edit-review", &payload) {
            cleanup_review(&request_id);
            return Err(format!("Failed to emit edit review request: {e}"));
        }
    }

    log::info!("[frontend-bridge] Edit review requested for {} ({})", path, request_id);

    // Await response with 120-second timeout (user needs time to review)
    match tokio::time::timeout(std::time::Duration::from_secs(120), rx).await {
        Ok(Ok(accepted)) => {
            log::info!("[frontend-bridge] Edit review {}: {}", if accepted { "accepted" } else { "rejected" }, path);
            Ok(accepted)
        }
        Ok(Err(_)) => Err("Edit review channel closed".to_string()),
        Err(_) => {
            cleanup_review(&request_id);
            Err("Edit review timed out (120s) — edit was not applied".to_string())
        }
    }
}

/// Tauri command: frontend calls this to accept or reject a pending edit review.
#[tauri::command]
pub async fn ide_edit_review_response(
    state: tauri::State<'_, FrontendBridgeState>,
    request_id: String,
    accepted: bool,
) -> Result<(), String> {
    let mut pending = state.pending_reviews.lock().map_err(|e| e.to_string())?;
    if let Some(tx) = pending.remove(&request_id) {
        if tx.send(accepted).is_err() { log::warn!("[frontend-bridge] Edit review response channel closed for {}", request_id); }
        Ok(())
    } else {
        Err(format!("No pending edit review with id: {}", request_id))
    }
}

// ─── Request / Resolve ───────────────────────────────────────────────────────

/// Send a request to the frontend and await the response.
/// `timeout_secs`: how long to wait before giving up (default fast queries = 5s,
/// terminal commands that may need user interaction = up to 300s).
pub async fn request_from_frontend(
    app: &AppHandle,
    tool: &str,
    args: serde_json::Value,
) -> Result<serde_json::Value, String> {
    request_from_frontend_timeout(app, tool, args, 5).await
}

pub async fn request_from_frontend_timeout(
    app: &AppHandle,
    tool: &str,
    args: serde_json::Value,
    timeout_secs: u64,
) -> Result<serde_json::Value, String> {
    let request_id = uuid::Uuid::new_v4().to_string();

    let (tx, rx) = oneshot::channel::<serde_json::Value>();

    // Store the pending request
    if let Some(state) = app.try_state::<FrontendBridgeState>() {
        let mut pending = state.pending.lock().map_err(|e: std::sync::PoisonError<_>| e.to_string())?;
        pending.insert(request_id.clone(), tx);
    } else {
        return Err("FrontendBridgeState not registered".to_string());
    }

    // B170: any failure path between `pending.insert` and the timeout match
    // must remove the pending entry, or the map leaks for the lifetime of the
    // FrontendBridgeState. The emit error case below was the missing branch.
    let cleanup = |id: &str| {
        if let Some(state) = app.try_state::<FrontendBridgeState>() {
            if let Ok(mut pending) = state.pending.lock() {
                let _ = pending.remove(id);
            }
        }
    };

    if let Err(e) = app.emit(
        "ide-tool-request",
        ToolRequest {
            request_id: request_id.clone(),
            tool: tool.to_string(),
            args,
        },
    ) {
        cleanup(&request_id);
        return Err(format!("Failed to emit tool request: {e}"));
    }

    match tokio::time::timeout(std::time::Duration::from_secs(timeout_secs), rx).await {
        Ok(Ok(result)) => Ok(result),
        Ok(Err(_)) => Err("Frontend bridge channel closed".to_string()),
        Err(_) => {
            cleanup(&request_id);
            Err(format!("Frontend tool request timed out ({}s)", timeout_secs))
        }
    }
}

// ─── Tauri Command (called by frontend to resolve a pending request) ─────────

#[tauri::command]
pub async fn ide_tool_response(
    state: tauri::State<'_, FrontendBridgeState>,
    response: ToolResponse,
) -> Result<(), String> {
    let mut pending = state.pending.lock().map_err(|e| e.to_string())?;
    if let Some(tx) = pending.remove(&response.request_id) {
        if tx.send(response.result).is_err() { log::warn!("[frontend-bridge] Tool response channel closed for {}", response.request_id); }
        Ok(())
    } else {
        Err(format!(
            "No pending request with id: {}",
            response.request_id
        ))
    }
}
