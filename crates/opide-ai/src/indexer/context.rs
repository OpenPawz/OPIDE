// ── Agent Context Builder ────────────────────────────────────────────────────
// Builds context strings from the codebase index for injection into the agent's
// system prompt every turn. Three sections:
//
// 1. Project overview — framework, file count, deps, entry points (~200 tokens)
// 2. Symbol table — all functions, components, types organized by kind (~300 tokens)
// 3. Relevant context — top-k chunks matching the user's query (~500-1000 tokens)

use super::index::{CodeIndex, SearchResult};
use super::types::*;

/// Build the static project overview (doesn't change per turn).
pub fn build_project_overview(index: &CodeIndex) -> String {
    let project = &index.project;
    let mut parts = Vec::new();

    // Framework + language
    let framework = project.framework.as_deref().unwrap_or("Unknown");
    parts.push(format!("Project: {} ({})",
        project.root.split('/').last().unwrap_or("project"),
        framework,
    ));

    // File counts
    let test_files = project.files.iter().filter(|f| {
        f.path.contains(".test.") || f.path.contains(".spec.") || f.path.contains("/test/")
    }).count();
    let source_files = project.file_count() - test_files;
    parts.push(format!("Files: {} source, {} test", source_files, test_files));

    // Entry points
    if !project.entry_points.is_empty() {
        parts.push(format!("Entry: {}", project.entry_points.join(", ")));
    }

    // Key dependencies (top 10)
    if !project.package_deps.is_empty() {
        let top_deps: Vec<&str> = project.package_deps
            .iter()
            .filter(|d| !d.starts_with("@types/"))
            .take(10)
            .map(|d| d.as_str())
            .collect();
        if !top_deps.is_empty() {
            parts.push(format!("Deps: {}", top_deps.join(", ")));
        }
    }

    // Config files
    if !project.config_files.is_empty() {
        parts.push(format!("Config: {}", project.config_files.join(", ")));
    }

    parts.join("\n")
}

/// Build the symbol table — all symbols organized by kind.
pub fn build_symbol_table(index: &CodeIndex) -> String {
    let mut components = Vec::new();
    let mut functions = Vec::new();
    let mut types_interfaces = Vec::new();
    let mut classes = Vec::new();
    let mut hooks = Vec::new();

    for (_path, symbol) in index.project.all_symbols() {
        if !symbol.exported {
            continue; // Only show exported symbols
        }

        match symbol.kind {
            SymbolKind::Component => components.push(symbol.name.clone()),
            SymbolKind::Function => {
                if symbol.name.starts_with("use") && symbol.name.len() > 3
                    && symbol.name.chars().nth(3).map_or(false, |c| c.is_uppercase()) {
                    hooks.push(symbol.name.clone());
                } else {
                    functions.push(symbol.name.clone());
                }
            }
            SymbolKind::Interface | SymbolKind::Type => {
                types_interfaces.push(symbol.name.clone());
            }
            SymbolKind::Class | SymbolKind::Struct => {
                classes.push(symbol.name.clone());
            }
            _ => {}
        }
    }

    let mut parts = Vec::new();

    if !components.is_empty() {
        components.sort();
        components.dedup();
        parts.push(format!("Components: {}", components.join(", ")));
    }
    if !hooks.is_empty() {
        hooks.sort();
        hooks.dedup();
        parts.push(format!("Hooks: {}", hooks.join(", ")));
    }
    if !functions.is_empty() {
        functions.sort();
        functions.dedup();
        // Limit to 30 functions
        if functions.len() > 30 {
            let count = functions.len();
            functions.truncate(30);
            parts.push(format!("Functions: {} (+{} more)", functions.join(", "), count - 30));
        } else {
            parts.push(format!("Functions: {}", functions.join(", ")));
        }
    }
    if !types_interfaces.is_empty() {
        types_interfaces.sort();
        types_interfaces.dedup();
        parts.push(format!("Types: {}", types_interfaces.join(", ")));
    }
    if !classes.is_empty() {
        classes.sort();
        classes.dedup();
        parts.push(format!("Classes: {}", classes.join(", ")));
    }

    parts.join("\n")
}

/// Build the God View context — architecture, hot paths, type chains.
/// This is the structural intelligence that makes the agent understand the codebase.
pub fn build_god_view(index: &CodeIndex) -> String {
    let mut parts = Vec::new();

    // ── Hot paths (most-called functions) ────────────────────────────
    let hot = index.call_graph.hot_functions(8);
    if !hot.is_empty() {
        let mut hot_lines = Vec::new();
        for (func, count) in &hot {
            // Clean up the key (file:function format)
            let display = if func.contains(':') {
                func.split(':').last().unwrap_or(func)
            } else {
                func
            };
            hot_lines.push(format!("  {} — {} callers", display, count));
        }
        parts.push(format!("Hot paths:\n{}", hot_lines.join("\n")));
    }

    // ── Type chains (types with inheritance) ─────────────────────────
    let mut type_chains = Vec::new();
    for (_path, symbol) in index.project.all_symbols() {
        if !matches!(symbol.kind, SymbolKind::Class | SymbolKind::Interface | SymbolKind::Struct) {
            continue;
        }
        let ancestry = index.type_graph.ancestry_of(&symbol.name);
        if !ancestry.is_empty() {
            type_chains.push(format!("  {} → {}", symbol.name, ancestry.join(" → ")));
        }
        let children = index.type_graph.children_of(&symbol.name);
        if !children.is_empty() {
            let child_names: Vec<&str> = children.iter().map(|c| c.name.as_str()).collect();
            type_chains.push(format!("  {} ← [{}]", symbol.name, child_names.join(", ")));
        }
    }
    type_chains.sort();
    type_chains.dedup();
    if !type_chains.is_empty() {
        let display: Vec<&str> = type_chains.iter().take(10).map(|s| s.as_str()).collect();
        parts.push(format!("Type hierarchy:\n{}", display.join("\n")));
    }

    // ── Architecture layers (group files by directory) ───────────────
    let mut dir_groups: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();
    for file in &index.project.files {
        let dir = file.path.split('/').take(2).collect::<Vec<&str>>().join("/");
        let exported: Vec<String> = file.symbols.iter()
            .filter(|s| s.exported)
            .map(|s| s.name.clone())
            .collect();
        if !exported.is_empty() {
            dir_groups.entry(dir).or_default().extend(exported);
        }
    }
    if !dir_groups.is_empty() {
        let mut arch_lines = Vec::new();
        let mut dirs: Vec<(&String, &Vec<String>)> = dir_groups.iter().collect();
        dirs.sort_by_key(|(k, _)| k.as_str());
        for (dir, symbols) in dirs.iter().take(8) {
            let display: Vec<&str> = symbols.iter().take(5).map(|s| s.as_str()).collect();
            let extra = if symbols.len() > 5 { format!(" +{}", symbols.len() - 5) } else { String::new() };
            arch_lines.push(format!("  {} → {}{}", dir, display.join(", "), extra));
        }
        parts.push(format!("Architecture:\n{}", arch_lines.join("\n")));
    }

    // ── Call graph stats ─────────────────────────────────────────────
    let func_count = index.call_graph.function_count();
    let edge_count = index.call_graph.edge_count();
    let type_count = index.type_graph.type_count();
    if func_count > 0 {
        parts.push(format!("Graph: {} functions, {} call edges, {} types tracked", func_count, edge_count, type_count));
    }

    parts.join("\n\n")
}

/// Build relevant context for a specific user query.
/// Returns the top-k search results formatted as context.

/// Build the full codebase context string for the agent.
/// Combines project overview + symbol table + relevant results.

/// Tauri command: get the codebase context as a string.
/// Called from ide-context.ts to inject into the agent's prompt.
#[tauri::command]
pub async fn ide_get_codebase_context(
    state: tauri::State<'_, super::IndexerState>,
) -> Result<String, String> {
    let index = state.index.lock().map_err(|e| e.to_string())?;
    match index.as_ref() {
        Some(idx) => {
            let overview = build_project_overview(idx);
            let symbols = build_symbol_table(idx);
            let god_view = build_god_view(idx);
            let mut parts = vec![overview, symbols];
            if !god_view.is_empty() {
                parts.push(god_view);
            }
            Ok(parts.join("\n\n"))
        }
        // B193: previously returned `Ok(String::new())` here, which left
        // the agent with an empty result and no way to tell why. Now we
        // explicitly say "no index" so the agent knows to call
        // `ide_open_workspace` instead of guessing the project is empty.
        None => Ok(
            "No workspace is currently indexed. Call `ide_open_workspace` with an absolute \
             path to load one, or `ide_create_project` to scaffold a new project. AST and \
             semantic tools become available once indexing completes."
                .to_string(),
        ),
    }
}

/// Tauri command: semantic search against the codebase index.
#[tauri::command]
pub async fn ide_search_semantic(
    query: String,
    limit: Option<usize>,
    state: tauri::State<'_, super::IndexerState>,
    app_handle: tauri::AppHandle,
) -> Result<Vec<SearchResult>, String> {
    use tauri::Manager;

    let k = limit.unwrap_or(10);

    // Embed the query
    let embed_client = {
        let engine_state = app_handle
            .try_state::<opide_engine::engine::state::EngineState>()
            .ok_or("EngineState not available")?;
        let memory_config = engine_state.memory_config.lock();
        opide_engine::engine::memory::embedding::EmbeddingClient::new(&memory_config)
    };

    let query_embedding = embed_client.embed(&query).await
        .map_err(|e| format!("Failed to embed query: {e}"))?;

    // Search the index
    let index = state.index.lock().map_err(|e| e.to_string())?;
    match index.as_ref() {
        Some(idx) => Ok(idx.query(&query_embedding, k)),
        None => Ok(Vec::new()),
    }
}
