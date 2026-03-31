// ── OPIDE Host API ──────────────────────────────────────────────────────────
// Bridges the sandbox's synchronous HostApi trait to OPIDE's async Tauri commands.
// Uses tokio::task::block_in_place + runtime::Handle::block_on() since the
// sandbox runs on a dedicated thread.

use serde_json::json;
use tauri::Manager;

pub(crate) struct OpideHostApi {
    app_handle: tauri::AppHandle,
    rt: tokio::runtime::Handle,
}

impl OpideHostApi {
    pub(crate) fn new(app_handle: tauri::AppHandle) -> Self {
        Self {
            app_handle,
            rt: tokio::runtime::Handle::current(),
        }
    }

    /// Run an async future from sync context without panicking.
    /// Uses block_in_place to avoid "Cannot start a runtime from within a runtime".
    fn block_on<F: std::future::Future>(&self, future: F) -> F::Output {
        tokio::task::block_in_place(|| self.rt.block_on(future))
    }
}

impl opide_sandbox::HostApi for OpideHostApi {
    fn file_read(&self, path: &str) -> Result<opide_sandbox::FileReadResult, String> {
        let path = path.to_string();
        match self.block_on(opide_shell::ide_mcp::ide_read_file(path.clone())) {
            Ok(result) => Ok(opide_sandbox::FileReadResult {
                content: result.content,
                path: result.path,
                size: result.size,
            }),
            Err(e) => {
                log::warn!("[host-api] file_read failed for '{}': {}", path, e);
                Ok(opide_sandbox::FileReadResult {
                    content: format!("[ERROR: Failed to read file '{}': {}]", path, e),
                    path,
                    size: 0,
                })
            }
        }
    }

    fn file_write(&self, path: &str, content: &str) -> Result<(), String> {
        let path = path.to_string();
        let content = content.to_string();

        let original = self.block_on(async {
            tokio::fs::read_to_string(&path).await.unwrap_or_default()
        });

        // New files are auto-approved — no diff to show, no review needed.
        // Writes to /tmp/ are always auto-approved — they're outside the project,
        // no user files are at risk (pipeline output, build artifacts, etc).
        // Only modifications to existing project files require user review.
        let is_tmp = path.starts_with("/tmp/") || path.starts_with("/var/folders/");
        if original.is_empty() || is_tmp {
            log::info!("[host-api] file_write: '{}' — auto-approved", path);
            return self.block_on(opide_shell::ide_mcp::ide_write_file(path, content));
        }

        let desc = format!("Modify {} ({} bytes)", path, content.len());
        match self.block_on(crate::engine::frontend_bridge::request_edit_review(
            &self.app_handle, &path, &original, &content, "ide_write_file", &desc,
        )) {
            Ok(true) => self.block_on(opide_shell::ide_mcp::ide_write_file(path, content)),
            Ok(false) => {
                log::info!("[host-api] Write to '{}' not accepted (user declined or review closed)", path);
                Err(format!("Write to '{}' was not accepted", path))
            }
            Err(e) => {
                log::warn!("[host-api] Edit review unavailable for '{}': {}", path, e);
                Err(format!("Write to '{}' blocked: review UI unavailable ({})", path, e))
            }
        }
    }

    fn file_append(&self, path: &str, content: &str) -> Result<(), String> {
        let path = path.to_string();
        let content = content.to_string();
        let existing = match self.block_on(opide_shell::ide_mcp::ide_read_file(path.clone())) {
            Ok(fc) => fc.content,
            Err(_) => String::new(),
        };
        let combined = format!("{}{}", existing, content);

        // Appending to a new file (no existing content) is auto-approved.
        if existing.is_empty() {
            log::info!("[host-api] file_append: new file '{}' — auto-approved", path);
            return match self.block_on(opide_shell::ide_mcp::ide_write_file(path.clone(), combined)) {
                Ok(()) => Ok(()),
                Err(e) => { log::warn!("[host-api] file_append write failed for '{}': {}", path, e); Err(e) }
            };
        }

        let desc = format!("Append to {} ({} bytes)", path, content.len());
        match self.block_on(crate::engine::frontend_bridge::request_edit_review(
            &self.app_handle, &path, &existing, &combined, "ide_append_file", &desc,
        )) {
            Ok(true) => match self.block_on(opide_shell::ide_mcp::ide_write_file(path.clone(), combined)) {
                Ok(()) => Ok(()),
                Err(e) => {
                    log::warn!("[host-api] file_append write failed for '{}': {}", path, e);
                    Err(e)
                }
            },
            Ok(false) => {
                log::info!("[host-api] Append to '{}' not accepted (user declined or review closed)", path);
                Err(format!("Append to '{}' was not accepted", path))
            }
            Err(e) => {
                log::warn!("[host-api] Edit review unavailable for '{}': {}", path, e);
                Err(format!("Append to '{}' blocked: review UI unavailable ({})", path, e))
            }
        }
    }

    fn file_delete(&self, path: &str) -> Result<(), String> {
        let path = path.to_string();
        let desc = format!("Delete {}", path);
        match self.block_on(crate::engine::frontend_bridge::request_edit_review(
            &self.app_handle, &path, &path, "", "ide_delete_file", &desc,
        )) {
            Ok(true) => match self.block_on(async {
                match tokio::fs::remove_file(&path).await {
                    Ok(()) => Ok(()),
                    Err(_) => tokio::fs::remove_dir(&path).await
                        .map_err(|e| format!("Delete failed: {e}")),
                }
            }) {
                Ok(()) => Ok(()),
                Err(e) => {
                    log::warn!("[host-api] file_delete failed for '{}': {}", path, e);
                    Err(e)
                }
            },
            Ok(false) => {
                log::info!("[host-api] Delete of '{}' not accepted (user declined or review closed)", path);
                Err(format!("Delete of '{}' was not accepted", path))
            }
            Err(e) => {
                log::warn!("[host-api] Edit review unavailable for '{}': {} — delete blocked for safety", path, e);
                Err(format!("Delete of '{}' blocked: review UI unavailable ({})", path, e))
            }
        }
    }

    fn list_dir(&self, path: &str) -> Result<Vec<opide_sandbox::DirEntry>, String> {
        let path = path.to_string();
        match self.block_on(opide_shell::ide_mcp::ide_list_dir(path.clone())) {
            Ok(result) => Ok(result.entries.into_iter().map(|e| opide_sandbox::DirEntry {
                name: e.name,
                is_dir: e.is_dir,
                size: e.size,
            }).collect()),
            Err(e) => {
                log::warn!("[host-api] list_dir failed for '{}': {}", path, e);
                Ok(vec![])
            }
        }
    }

    fn apply_edit(&self, path: &str, start_line: usize, end_line: usize, new_content: &str) -> Result<(), String> {
        let path = path.to_string();
        let new_content = new_content.to_string();

        // Gate through edit review if frontend is available
        let original = match self.block_on(async {
            tokio::fs::read_to_string(&path).await.map_err(|e| format!("Read failed: {e}"))
        }) {
            Ok(s) => s,
            Err(e) => {
                log::warn!("[host-api] apply_edit: cannot read '{}': {}", path, e);
                return Err(format!("Cannot read '{}' for editing: {}", path, e));
            }
        };
        let proposed = match opide_shell::ide_mcp::compute_edit(&original, start_line, end_line, &new_content) {
            Ok(p) => p,
            Err(e) => {
                log::warn!("[host-api] apply_edit: compute_edit failed for '{}': {}", path, e);
                return Err(format!("Edit computation failed for '{}': {}", path, e));
            }
        };
        let desc = format!("Edit {} lines {}-{}", path, start_line, end_line);
        match self.block_on(crate::engine::frontend_bridge::request_edit_review(
            &self.app_handle, &path, &original, &proposed, "ide_apply_edit", &desc,
        )) {
            Ok(true) => self.block_on(async {
                tokio::fs::write(&path, &proposed).await.map_err(|e| format!("Write failed: {e}"))
            }),
            Ok(false) => {
                log::info!("[host-api] Edit to '{}' rejected by user", path);
                Err(format!("Edit to '{}' was rejected by user review", path))
            }
            Err(e) => {
                log::warn!("[host-api] Edit review unavailable for '{}': {} — edit blocked for safety", path, e);
                Err(format!("Edit to '{}' blocked: review UI unavailable ({})", path, e))
            }
        }
    }

    fn exec(&self, command: &str, cwd: Option<&str>) -> Result<opide_sandbox::ExecResult, String> {
        let command = command.to_string();
        let cwd = cwd.map(|s| s.to_string());
        match self.block_on(opide_shell::ide_mcp::ide_run_command(command.clone(), cwd)) {
            Ok(result) => Ok(opide_sandbox::ExecResult {
                stdout: result.stdout,
                stderr: result.stderr,
                exit_code: result.exit_code,
            }),
            Err(e) => {
                log::warn!("[host-api] exec failed for '{}': {}", command, e);
                Ok(opide_sandbox::ExecResult {
                    stdout: String::new(),
                    stderr: format!("Command failed: {}", e),
                    exit_code: 1,
                })
            }
        }
    }

    fn git_status(&self, repo: Option<&str>) -> Result<opide_sandbox::GitStatusResult, String> {
        let repo = repo.unwrap_or("").to_string();
        match self.block_on(opide_shell::git::git_status(repo)) {
            Ok(result) => Ok(opide_sandbox::GitStatusResult {
                branch: result.branch,
                files: result.files.into_iter().map(|f| opide_sandbox::GitFileStatus {
                    path: f.path,
                    status: f.status,
                    staged: f.staged,
                }).collect(),
                ahead: result.ahead,
                behind: result.behind,
            }),
            Err(e) => {
                log::warn!("[host-api] git_status failed: {}", e);
                Ok(opide_sandbox::GitStatusResult {
                    branch: None,
                    files: vec![],
                    ahead: 0,
                    behind: 0,
                })
            }
        }
    }

    fn git_diff(&self, repo: Option<&str>, staged: bool) -> Result<Vec<opide_sandbox::GitDiffResult>, String> {
        let repo = repo.unwrap_or("").to_string();
        match self.block_on(opide_shell::git::git_diff(repo, staged)) {
            Ok(result) => Ok(result.into_iter().map(|d| opide_sandbox::GitDiffResult {
                path: d.path,
                patch: d.patch,
            }).collect()),
            Err(e) => {
                log::warn!("[host-api] git_diff failed: {}", e);
                Ok(vec![])
            }
        }
    }

    fn git_stage(&self, repo: Option<&str>, paths: Vec<String>) -> Result<(), String> {
        let repo = repo.unwrap_or("").to_string();
        match self.block_on(opide_shell::git::git_stage(repo, paths)) {
            Ok(()) => Ok(()),
            Err(e) => {
                log::warn!("[host-api] git_stage failed: {}", e);
                Err(e)
            }
        }
    }

    fn git_commit(&self, repo: Option<&str>, message: &str) -> Result<String, String> {
        let request = opide_shell::git::GitCommitRequest {
            repo_path: repo.unwrap_or("").to_string(),
            message: message.to_string(),
        };
        match self.block_on(opide_shell::git::git_commit(request)) {
            Ok(hash) => Ok(hash),
            Err(e) => {
                log::warn!("[host-api] git_commit failed: {}", e);
                Err(e)
            }
        }
    }

    fn git_log(&self, repo: Option<&str>, limit: Option<usize>) -> Result<Vec<opide_sandbox::GitLogEntry>, String> {
        let repo = repo.unwrap_or("").to_string();
        match self.block_on(opide_shell::git::git_log(repo, limit)) {
            Ok(result) => Ok(result.into_iter().map(|e| opide_sandbox::GitLogEntry {
                id: e.id,
                short_id: e.short_id,
                message: e.message,
                author: e.author,
            }).collect()),
            Err(e) => {
                log::warn!("[host-api] git_log failed: {}", e);
                Ok(vec![])
            }
        }
    }

    fn git_branches(&self, repo: Option<&str>) -> Result<Vec<opide_sandbox::GitBranch>, String> {
        let repo = repo.unwrap_or("").to_string();
        match self.block_on(opide_shell::git::git_branches(repo)) {
            Ok(result) => Ok(result.into_iter().map(|b| opide_sandbox::GitBranch {
                name: b.name,
                is_head: b.is_head,
                is_remote: b.is_remote,
            }).collect()),
            Err(e) => {
                log::warn!("[host-api] git_branches failed: {}", e);
                Ok(vec![])
            }
        }
    }

    fn git_checkout(&self, repo: Option<&str>, branch: &str) -> Result<(), String> {
        let repo = repo.unwrap_or("").to_string();
        let branch = branch.to_string();
        match self.block_on(opide_shell::git::git_checkout(repo, branch.clone())) {
            Ok(()) => Ok(()),
            Err(e) => {
                log::warn!("[host-api] git_checkout failed for '{}': {}", branch, e);
                Err(e)
            }
        }
    }

    fn search(&self, query: &str, root: Option<&str>) -> Result<Vec<opide_sandbox::SearchMatch>, String> {
        let root = root.unwrap_or("").to_string();
        let query = query.to_string();
        match self.block_on(
            opide_shell::ide_mcp::ide_search_text(root, query.clone(), Some(false), Some(50))
        ) {
            Ok(result) => {
                let matches: Vec<opide_sandbox::SearchMatch> = result
                    .get("matches")
                    .and_then(|m| m.as_array())
                    .map(|arr| arr.iter().filter_map(|v| {
                        Some(opide_sandbox::SearchMatch {
                            path: v.get("path")?.as_str()?.to_string(),
                            line: v.get("line")?.as_u64()? as usize,
                            text: v.get("text")?.as_str()?.to_string(),
                        })
                    }).collect())
                    .unwrap_or_default();
                Ok(matches)
            }
            Err(e) => {
                log::warn!("[host-api] search failed for '{}': {}", query, e);
                Ok(vec![])
            }
        }
    }

    fn diagnostics(&self, path: Option<&str>) -> Result<opide_sandbox::DiagnosticsResult, String> {
        let args = match path {
            Some(p) => json!({"path": p}),
            None => json!({}),
        };
        match self.block_on(
            crate::engine::frontend_bridge::request_from_frontend(&self.app_handle, "ide_get_diagnostics", args)
        ) {
            Ok(result) => {
                let diagnostics: Vec<opide_sandbox::Diagnostic> = result
                    .get("diagnostics")
                    .and_then(|d| d.as_array())
                    .map(|arr| arr.iter().filter_map(|v| {
                        Some(opide_sandbox::Diagnostic {
                            path: v.get("path")?.as_str()?.to_string(),
                            line: v.get("line")?.as_u64()? as usize,
                            column: v.get("column")?.as_u64().unwrap_or(1) as usize,
                            severity: v.get("severity")?.as_str()?.to_string(),
                            message: v.get("message")?.as_str()?.to_string(),
                            source: v.get("source").and_then(|s| s.as_str()).unwrap_or("").to_string(),
                        })
                    }).collect())
                    .unwrap_or_default();
                let count = diagnostics.len();
                Ok(opide_sandbox::DiagnosticsResult { diagnostics, count })
            }
            Err(e) => {
                log::warn!("[host-api] diagnostics unavailable: {}", e);
                Ok(opide_sandbox::DiagnosticsResult { diagnostics: vec![], count: 0 })
            }
        }
    }

    fn selection(&self) -> Result<opide_sandbox::SelectionResult, String> {
        match self.block_on(
            crate::engine::frontend_bridge::request_from_frontend(&self.app_handle, "ide_get_selection", json!({}))
        ) {
            Ok(result) => Ok(opide_sandbox::SelectionResult {
                text: result.get("text").and_then(|t| t.as_str()).map(|s| s.to_string()),
                path: result.get("path").and_then(|p| p.as_str()).map(|s| s.to_string()),
                start_line: result.get("range").and_then(|r| r.get("start_line")).and_then(|l| l.as_u64()).map(|n| n as usize),
                end_line: result.get("range").and_then(|r| r.get("end_line")).and_then(|l| l.as_u64()).map(|n| n as usize),
            }),
            Err(e) => {
                log::warn!("[host-api] selection unavailable: {}", e);
                Ok(opide_sandbox::SelectionResult {
                    text: None,
                    path: None,
                    start_line: None,
                    end_line: None,
                })
            }
        }
    }

    fn open_files(&self) -> Result<opide_sandbox::OpenFilesResult, String> {
        match self.block_on(
            crate::engine::frontend_bridge::request_from_frontend(&self.app_handle, "ide_get_open_files", json!({}))
        ) {
            Ok(result) => {
                let files: Vec<String> = result
                    .get("files")
                    .and_then(|f| f.as_array())
                    .map(|arr| arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect())
                    .unwrap_or_default();
                let count = files.len();
                Ok(opide_sandbox::OpenFilesResult { files, count })
            }
            Err(e) => {
                log::warn!("[host-api] open_files unavailable: {}", e);
                Ok(opide_sandbox::OpenFilesResult { files: vec![], count: 0 })
            }
        }
    }

    fn open_file(&self, path: &str, line: Option<usize>) -> Result<(), String> {
        let args = match line {
            Some(l) => json!({"path": path, "line": l}),
            None => json!({"path": path}),
        };
        match self.block_on(
            crate::engine::frontend_bridge::request_from_frontend(&self.app_handle, "ide_open_file", args)
        ) {
            Ok(_) => Ok(()),
            Err(e) => {
                log::warn!("[host-api] open_file failed for '{}': {}", path, e);
                Ok(())  // non-critical — don't crash the sandbox for a UI operation
            }
        }
    }

    fn ast_callers(&self, function: &str) -> Result<Vec<String>, String> {
        if let Some(state) = self.app_handle.try_state::<crate::indexer::IndexerState>() {
            if let Ok(idx) = state.index.lock() {
                if let Some(ref index) = *idx {
                    let callers = index.call_graph.callers_of(function);
                    return Ok(callers.iter().map(|e| format!("{}:{} (line {})", e.from_file, e.from_function, e.from_line)).collect());
                }
            }
        }
        Ok(vec![])
    }

    fn ast_callees(&self, function: &str) -> Result<Vec<String>, String> {
        if let Some(state) = self.app_handle.try_state::<crate::indexer::IndexerState>() {
            if let Ok(idx) = state.index.lock() {
                if let Some(ref index) = *idx {
                    let callees = index.call_graph.callees_of(function);
                    return Ok(callees.iter().map(|e| format!("{} ({}:{})", e.to_function, e.from_file, e.from_line)).collect());
                }
            }
        }
        Ok(vec![])
    }

    fn ast_impact(&self, symbol: &str) -> Result<Vec<String>, String> {
        if let Some(state) = self.app_handle.try_state::<crate::indexer::IndexerState>() {
            if let Ok(idx) = state.index.lock() {
                if let Some(ref index) = *idx {
                    let mut impact = index.call_graph.impact_of(symbol);
                    impact.extend(index.type_graph.impact_of_type_change(symbol));
                    return Ok(impact);
                }
            }
        }
        Ok(vec![])
    }

    fn ast_definition(&self, symbol: &str) -> Result<Option<String>, String> {
        if let Some(state) = self.app_handle.try_state::<crate::indexer::IndexerState>() {
            if let Ok(idx) = state.index.lock() {
                if let Some(ref index) = *idx {
                    if let Some(file) = index.type_graph.definition_of(symbol) {
                        return Ok(Some(file.clone()));
                    }
                    for file in &index.project.files {
                        for sym in &file.symbols {
                            if sym.name == symbol {
                                return Ok(Some(format!("{}:{}", file.path, sym.start_line)));
                            }
                        }
                    }
                }
            }
        }
        Ok(None)
    }

    fn ast_type_info(&self, type_name: &str) -> Result<String, String> {
        if let Some(state) = self.app_handle.try_state::<crate::indexer::IndexerState>() {
            if let Ok(idx) = state.index.lock() {
                if let Some(ref index) = *idx {
                    let parents: Vec<String> = index.type_graph.parents_of(type_name).iter()
                        .map(|r| format!("{} ({:?})", r.name, r.kind)).collect();
                    let children: Vec<String> = index.type_graph.children_of(type_name).iter()
                        .map(|r| format!("{} ({:?})", r.name, r.kind)).collect();
                    let usages = index.type_graph.usages_of(type_name).len();
                    let ancestry = index.type_graph.ancestry_of(type_name);
                    return Ok(format!(
                        "Type: {}\nParents: {}\nChildren: {}\nUsages: {}\nAncestry: {}",
                        type_name,
                        if parents.is_empty() { "none".into() } else { parents.join(", ") },
                        if children.is_empty() { "none".into() } else { children.join(", ") },
                        usages,
                        if ancestry.is_empty() { "none".into() } else { ancestry.join(" → ") },
                    ));
                }
            }
        }
        Ok(format!("Type: {} (index not available)", type_name))
    }

    fn tool(&self, name: &str, args: &serde_json::Value) -> Result<serde_json::Value, String> {
        // Gate through IDE tool filter — sandbox cannot call tools outside the allowlist.
        if !crate::engine::tool_filter::IDE_ALLOWED_TOOLS.contains(&name) {
            log::warn!("[host-api] ctx.tool('{}') blocked — not in IDE_ALLOWED_TOOLS", name);
            return Ok(json!({"error": format!("Tool '{}' is not available in this context", name)}));
        }

        // Emit sandbox-subtool-start so the activity feed can show this sub-tool in real time.
        // These events carry no session_id/run_id — the activity feed guards them with
        // `activeExecElement` (only processes them when an execute_code parent is active).
        let subtool_call_id = format!("sandbox_{}", uuid::Uuid::new_v4());
        {
            use tauri::Emitter;
            let args_preview = {
                let s = serde_json::to_string(args).unwrap_or_default();
                if s.len() > 120 { format!("{}…", &s[..117]) } else { s }
            };
            let _ = self.app_handle.emit("sandbox-subtool-start", serde_json::json!({
                "tool_name": name,
                "tool_call_id": &subtool_call_id,
                "args_preview": args_preview,
            }));
        }
        let subtool_start = std::time::Instant::now();

        // Route through the same executor chain — IDE tools first, then OpenPawz
        let name = name.to_string();
        let args = args.clone();
        let app = self.app_handle.clone();
        let result = match self.block_on(async {
            // Try IDE tools first
            if let Some(result) = super::tool_executor::execute(&name, &args, &app).await {
                return match result {
                    Ok(s) => Ok(serde_json::from_str(&s).unwrap_or(json!({"result": s}))),
                    Err(e) => Err(e),
                };
            }

            // Fall back to OpenPawz tool chain
            use paw_temp_lib::engine::tools::execute_tool;
            let tc = paw_temp_lib::atoms::types::ToolCall {
                id: format!("sandbox_{}", uuid::Uuid::new_v4()),
                call_type: "function".to_string(),
                function: paw_temp_lib::atoms::types::FunctionCall {
                    name: name.clone(),
                    arguments: serde_json::to_string(&args).unwrap_or_default(),
                },
                thought_signature: None,
                thought_parts: Vec::new(),
            };
            let result = execute_tool(&tc, &app, "sandbox").await;
            if result.success {
                Ok(serde_json::from_str(&result.output).unwrap_or(json!({"result": result.output})))
            } else {
                Err(result.output)
            }
        }) {
            Ok(v) => Ok(v),
            Err(e) => {
                log::warn!("[host-api] tool '{}' failed: {}", name, e);
                Ok(json!({"error": format!("Tool '{}' failed: {}", name, e)}))
            }
        };

        // Emit sandbox-subtool-end so the activity feed can mark the entry complete
        {
            use tauri::Emitter;
            let duration_ms = subtool_start.elapsed().as_millis() as u64;
            let success = result.as_ref()
                .map(|v| v.get("error").is_none())
                .unwrap_or(false);
            let _ = self.app_handle.emit("sandbox-subtool-end", serde_json::json!({
                "tool_call_id": &subtool_call_id,
                "success": success,
                "duration_ms": duration_ms,
            }));
        }

        result
    }
}
