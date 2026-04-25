// ── OPIDE Codebase Indexer ───────────────────────────────────────────────────
// Scans the workspace, parses source files with tree-sitter, extracts symbols,
// imports, exports, and builds a project-level index.
//
// Phase I1: File scanner + symbol extraction (tree-sitter)
// Phase I2: Embedding generation (Ollama/OpenAI/Voyage)
// Phase I3: Vector index (HNSW) + persistence
// Phase I4: Agent context injection
// Phase I5: IDE integration (startup, file watcher, semantic search)

pub mod types;
pub mod scanner;
pub mod parser;
pub mod chunker;
pub mod embeddings;
pub mod index;
pub mod context;
pub mod call_graph;
pub mod type_graph;

use std::path::Path;
use std::sync::Mutex;
use types::*;

/// Managed Tauri state for the codebase index.
pub struct IndexerState {
    pub index: Mutex<Option<index::CodeIndex>>,
    /// External index for repos cloned outside the workspace (e.g., /tmp/audit/).
    /// AST tools check this if the primary workspace index doesn't have results.
    pub external_index: Mutex<Option<index::CodeIndex>>,
}

/// Build a full project index from a workspace root.
pub fn index_workspace(root: &Path) -> ProjectIndex {
    let mut project = ProjectIndex::new(root.to_string_lossy().to_string());

    // Scan files
    let source_files = scanner::scan_workspace(root);
    log::info!(
        "[indexer] Scanned {} source files in {}",
        source_files.len(),
        root.display()
    );

    // Parse each file
    let mut read_failures = 0usize;
    let mut empty_parse = 0usize;
    for sf in &source_files {
        let content = match std::fs::read_to_string(&sf.path) {
            Ok(c) => c,
            Err(e) => {
                // B178: log instead of silently dropping the file. Surfaces
                // permission and encoding failures that would otherwise be
                // invisible until somebody noticed missing search results.
                log::warn!("[indexer] Read failed for {}: {}", sf.path.display(), e);
                read_failures += 1;
                continue;
            }
        };

        let mut file_index = parser::parse_file(&content, sf.language);
        if file_index.symbols.is_empty() && !content.trim().is_empty() {
            empty_parse += 1;
            log::debug!("[indexer] Empty parse result for {}", sf.path.display());
        }
        file_index.path = sf.relative_path.clone();
        file_index.size = sf.size;

        project.files.push(file_index);
    }
    if read_failures > 0 {
        log::warn!("[indexer] {} files unreadable", read_failures);
    }
    if empty_parse > 0 {
        log::info!(
            "[indexer] {} files produced empty parse results",
            empty_parse
        );
    }

    // Build dependency graph from imports
    for file in &project.files {
        let deps: Vec<String> = file
            .imports
            .iter()
            .filter(|imp| imp.source.starts_with('.')) // only local imports
            .map(|imp| resolve_import_path(&file.path, &imp.source))
            .collect();

        if !deps.is_empty() {
            project.dependency_graph.insert(file.path.clone(), deps);
        }
    }

    // Detect framework, deps, entry points, config files
    project.framework = scanner::detect_framework(root);
    project.package_deps = scanner::extract_package_deps(root);
    project.entry_points = scanner::find_entry_points(root);
    project.config_files = scanner::find_config_files(root);

    log::info!(
        "[indexer] Index complete: {} files, {} symbols, framework={:?}",
        project.file_count(),
        project.symbol_count(),
        project.framework,
    );

    project
}

/// Run a full index of the workspace: scan, parse, chunk, embed, persist.
/// Called at startup (in background) and on manual re-index.
pub async fn run_full_index(
    workspace: &str,
    state: &IndexerState,
    app_handle: &tauri::AppHandle,
) {
    use tauri::Emitter;

    // Guard: never index an empty or non-existent path.
    // B179: emit a final progress event even on the skip paths so the
    // activity feed can clear its "indexing" state instead of showing the
    // spinner forever.
    if workspace.trim().is_empty() {
        log::warn!("[indexer] Skipping index — workspace path is empty");
        let _ = app_handle.emit(
            "indexer-progress",
            serde_json::json!({
                "phase": "skipped",
                "reason": "no workspace",
                "percent": 100,
            }),
        );
        return;
    }
    let root = Path::new(workspace);
    if !root.exists() {
        log::warn!("[indexer] Skipping index — path does not exist: {}", workspace);
        let _ = app_handle.emit(
            "indexer-progress",
            serde_json::json!({
                "phase": "skipped",
                "reason": "path not found",
                "percent": 100,
            }),
        );
        return;
    }

    // Check if we have a cached index that's not stale
    if !index::CodeIndex::is_stale(workspace) {
        if let Some(cached) = index::CodeIndex::load_from_disk(workspace) {
            let chunks = cached.chunk_count();
            let symbols = cached.project.symbol_count();
            let files = cached.project.file_count();
            log::info!("[indexer] Using cached index ({} chunks, {} symbols)", chunks, symbols);
            if let Ok(mut idx) = state.index.lock() {
                *idx = Some(cached);
            }
            // Emit progress events so the activity feed meters update even for cached indexes
            let _ = app_handle.emit("indexer-progress", serde_json::json!({
                "phase": "scanning", "current": files, "total": files, "percent": 100,
            }));
            let _ = app_handle.emit("indexer-progress", serde_json::json!({
                "phase": "ast_ready", "current": chunks, "total": chunks, "percent": 100,
            }));
            let _ = app_handle.emit("indexer-progress", serde_json::json!({
                "phase": "complete", "percent": 100,
            }));
            return;
        }
    }

    log::info!("[indexer] Building index for {}", workspace);
    let _ = app_handle.emit("indexer-progress", serde_json::json!({
        "phase": "scanning",
        "current": 0,
        "total": 0,
        "percent": 0,
    }));

    // Phase I1: Scan and parse
    let project = index_workspace(root);

    let _ = app_handle.emit("indexer-progress", serde_json::json!({
        "phase": "chunking",
        "current": 0,
        "total": project.file_count(),
        "percent": 25,
    }));

    // Phase I2: Chunk
    let mut chunks = chunker::chunk_project(&project, root);
    log::info!("[indexer] {} chunks from {} files", chunks.len(), project.file_count());

    // Phase I3: Build index IMMEDIATELY (AST, call graph, type hierarchy)
    // This makes ide_ast_* tools available right away without waiting for embeddings.
    let mut code_index = index::CodeIndex::new(workspace.to_string(), project);
    code_index.add_chunks(chunks.clone());

    log::info!(
        "[indexer] Index ready: {} chunks, {} symbols (embeddings pending)",
        code_index.chunk_count(),
        code_index.project.symbol_count(),
    );

    // Store in state NOW — AST tools work immediately
    if let Ok(mut idx) = state.index.lock() {
        *idx = Some(code_index);
    }

    let _ = app_handle.emit("indexer-progress", serde_json::json!({
        "phase": "ast_ready",
        "current": chunks.len(),
        "total": chunks.len(),
        "percent": 50,
    }));

    // Phase I2: Embed in background — non-blocking
    // AST, WASM skills, and call graph are already available above.
    // Embeddings only needed for ide_search_semantic (nice-to-have).
    let embedded = match embeddings::embed_chunks(&mut chunks, app_handle).await {
        Ok(n) => n,
        Err(e) => {
            log::warn!("[indexer] Embedding failed: {} — semantic search unavailable, AST tools still work", e);
            0
        }
    };

    // Update index with embedded chunks and persist
    let mut save_error: Option<String> = None;
    if let Ok(mut idx) = state.index.lock() {
        if let Some(ref mut code_index) = *idx {
            code_index.update_chunks(chunks);
            if let Err(e) = code_index.save_to_disk() {
                log::warn!("[indexer] Failed to save index: {}", e);
                save_error = Some(e.to_string());
            }
        }
    }
    // B180: surface save failures to the frontend so the user knows the
    // in-memory index is correct but won't survive a restart.
    if let Some(err) = save_error {
        let _ = app_handle.emit(
            "indexer-progress",
            serde_json::json!({
                "phase": "cache_save_failed",
                "error": err,
                "percent": 100,
            }),
        );
    }

    let _ = app_handle.emit("indexer-progress", serde_json::json!({
        "phase": "complete",
        "percent": 100,
    }));

    log::info!(
        "[indexer] Embeddings complete: {} embedded",
        embedded,
    );
}

/// Incrementally update the index for a single file that changed.

/// Tauri command: trigger a full re-index of the workspace.
#[tauri::command]
pub async fn trigger_reindex(
    workspace: String,
    state: tauri::State<'_, IndexerState>,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    // Guard: reject empty paths
    if workspace.trim().is_empty() {
        return Err("Cannot reindex: workspace path is empty".to_string());
    }

    // Clear existing index
    if let Ok(mut idx) = state.index.lock() {
        *idx = None;
    }

    run_full_index(&workspace, &state, &app_handle).await;

    let count = state.index.lock()
        .map(|idx| idx.as_ref().map_or(0, |i| i.chunk_count()))
        .unwrap_or(0);

    Ok(format!("Re-indexed: {} chunks", count))
}

/// Query the current index status — used by the activity feed to show meters
/// when the index was loaded from cache before the frontend listener was ready.
#[tauri::command]
pub fn get_index_status(
    state: tauri::State<'_, IndexerState>,
) -> Result<serde_json::Value, String> {
    if let Ok(idx) = state.index.lock() {
        if let Some(ref index) = *idx {
            return Ok(serde_json::json!({
                "has_index": true,
                "files": index.project.file_count(),
                "chunks": index.chunk_count(),
                "symbols": index.project.symbol_count(),
                "functions": index.call_graph.function_count(),
                "edges": index.call_graph.edge_count(),
            }));
        }
    }
    Ok(serde_json::json!({ "has_index": false }))
}

/// Index an external path (e.g., /tmp/audit-repo/) without switching workspace.
/// Stores the result in `external_index` so AST tools can query it alongside the workspace index.
pub async fn run_external_index(
    path: &str,
    state: &IndexerState,
    app_handle: &tauri::AppHandle,
) {
    use tauri::Emitter;

    let root = Path::new(path);
    if !root.exists() {
        log::warn!("[indexer] External path does not exist: {}", path);
        return;
    }

    log::info!("[indexer] Building external index for {}", path);
    let _ = app_handle.emit("indexer-progress", serde_json::json!({
        "phase": "scanning",
        "source": "external",
        "path": path,
        "current": 0,
        "total": 0,
        "percent": 0,
    }));

    // Phase I1: Scan and parse
    let project = index_workspace(root);

    let _ = app_handle.emit("indexer-progress", serde_json::json!({
        "phase": "chunking",
        "source": "external",
        "path": path,
        "current": 0,
        "total": project.file_count(),
        "percent": 25,
    }));

    // Phase I2: Chunk
    let chunks = chunker::chunk_project(&project, root);
    log::info!("[indexer] External: {} chunks from {} files", chunks.len(), project.file_count());

    // Build index (AST, call graph, type hierarchy)
    let mut code_index = index::CodeIndex::new(path.to_string(), project);
    code_index.add_chunks(chunks);

    log::info!(
        "[indexer] External index ready: {} chunks, {} symbols",
        code_index.chunk_count(),
        code_index.project.symbol_count(),
    );

    // Store in external_index slot
    if let Ok(mut idx) = state.external_index.lock() {
        *idx = Some(code_index);
    }

    let _ = app_handle.emit("indexer-progress", serde_json::json!({
        "phase": "ast_ready",
        "source": "external",
        "path": path,
        "percent": 100,
    }));
}

/// Tauri command: index an external path without switching workspace.
#[tauri::command]
pub async fn index_external_path(
    path: String,
    state: tauri::State<'_, IndexerState>,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    // Clear existing external index
    if let Ok(mut idx) = state.external_index.lock() {
        *idx = None;
    }

    run_external_index(&path, &state, &app_handle).await;

    let count = state.external_index.lock()
        .map(|idx| idx.as_ref().map_or(0, |i| i.chunk_count()))
        .unwrap_or(0);

    Ok(format!("External index built: {} chunks", count))
}

/// Resolve a relative import path to a file path.
/// "./Button" from "src/components/Card.tsx" → "src/components/Button"
fn resolve_import_path(from_file: &str, import_source: &str) -> String {
    let from_dir = Path::new(from_file)
        .parent()
        .unwrap_or(Path::new(""));

    let resolved = from_dir.join(import_source);
    let resolved_str = resolved.to_string_lossy().to_string();

    // Normalize: remove ./ and resolve ../
    let mut parts: Vec<&str> = Vec::new();
    for part in resolved_str.split('/') {
        match part {
            "." | "" => {}
            ".." => { parts.pop(); }
            p => parts.push(p),
        }
    }

    parts.join("/")
}
