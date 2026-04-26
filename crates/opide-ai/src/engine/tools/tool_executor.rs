// ── OPIDE Tool Executor ──────────────────────────────────────────────────────
// Routes tool calls to their implementations: shell commands, git operations,
// AST queries, WASM skills, sandbox execution.

use super::host_api::OpideHostApi;
use log::info;
use serde_json::Value;
use std::sync::Arc;
use tauri::Manager;

/// B195: if the command redirects into a sensitive path, return that
/// target so the caller can refuse before invoking the shell. Returns
/// `None` for everything that looks safe.
///
/// This is intentionally a heuristic, not a parser: shells have many
/// ways to express I/O (heredocs, `dd of=`, named pipes, here-strings),
/// and a determined adversary can always find a bypass. The point is to
/// catch the obvious shapes so a simple `printf '…' > /etc/passwd`
/// doesn't sail through. Defence-in-depth, not a security boundary —
/// the real boundary is the user-approval gate at the agent loop tier.
pub(crate) fn sensitive_redirect_target(command: &str) -> Option<String> {
    let target = extract_redirect_target(command)?;
    if paw_temp_lib::engine::util::check_sensitive_path(&target).is_err() {
        Some(target)
    } else {
        None
    }
}

fn extract_redirect_target(command: &str) -> Option<String> {
    // Strip strings so we don't confuse `echo "> /etc/passwd"` for a redirect.
    let mut depth_squote = false;
    let mut depth_dquote = false;
    let mut prev_was_escape = false;
    let mut sanitised = String::with_capacity(command.len());
    for c in command.chars() {
        if prev_was_escape {
            sanitised.push(c);
            prev_was_escape = false;
            continue;
        }
        match c {
            '\\' => {
                prev_was_escape = true;
                sanitised.push(c);
            }
            '\'' if !depth_dquote => {
                depth_squote = !depth_squote;
                sanitised.push(' ');
            }
            '"' if !depth_squote => {
                depth_dquote = !depth_dquote;
                sanitised.push(' ');
            }
            _ if depth_squote || depth_dquote => sanitised.push(' '),
            _ => sanitised.push(c),
        }
    }

    // `>`, `>>`, `1>`, `2>`, `&>` then path. Also `tee [-a] path`.
    let tokens: Vec<&str> = sanitised.split_whitespace().collect();
    for (i, tok) in tokens.iter().enumerate() {
        let redirect = matches!(*tok, ">" | ">>" | "1>" | "2>" | "&>" | "1>>" | "2>>");
        if redirect {
            if let Some(target) = tokens.get(i + 1) {
                return Some((*target).to_string());
            }
        }
        if *tok == "tee" {
            // tee [-a] [-i] target
            let mut j = i + 1;
            while let Some(t) = tokens.get(j) {
                if t.starts_with('-') {
                    j += 1;
                } else {
                    return Some((*t).to_string());
                }
            }
        }
        // `>file` (no space). Strip leading > / >>.
        if let Some(rest) = tok
            .strip_prefix(">>")
            .or_else(|| tok.strip_prefix('>'))
            .filter(|r| !r.is_empty())
        {
            return Some(rest.to_string());
        }
    }
    None
}

#[cfg(test)]
mod redirect_tests {
    use super::extract_redirect_target;

    #[test]
    fn detects_simple_redirect() {
        assert_eq!(
            extract_redirect_target("printf 'hi' > /tmp/x"),
            Some("/tmp/x".to_string()),
        );
    }

    #[test]
    fn detects_append_redirect() {
        assert_eq!(
            extract_redirect_target("echo line >> /etc/hosts"),
            Some("/etc/hosts".to_string()),
        );
    }

    #[test]
    fn detects_no_space_redirect() {
        // Reproducing the exact shape Kimi used to bypass B194:
        // `printf 'OPENAI_API_KEY=…' >/Users/.../test.env`
        assert_eq!(
            extract_redirect_target("printf 'KEY=v' >/Users/foo/test.env"),
            Some("/Users/foo/test.env".to_string()),
        );
    }

    #[test]
    fn detects_tee() {
        assert_eq!(
            extract_redirect_target("echo hi | tee /etc/passwd"),
            Some("/etc/passwd".to_string()),
        );
        assert_eq!(
            extract_redirect_target("echo hi | tee -a /etc/hosts"),
            Some("/etc/hosts".to_string()),
        );
    }

    #[test]
    fn ignores_string_literals() {
        // `echo "> /etc/passwd"` is just printing text; not a redirect.
        assert_eq!(
            extract_redirect_target("echo \"> /etc/passwd\""),
            None,
        );
        assert_eq!(
            extract_redirect_target("echo '> /etc/passwd'"),
            None,
        );
    }

    #[test]
    fn ignores_safe_commands() {
        assert_eq!(extract_redirect_target("ls -la"), None);
        assert_eq!(extract_redirect_target("git status"), None);
        assert_eq!(extract_redirect_target("cargo build"), None);
    }

    #[test]
    fn detects_stderr_and_combined() {
        assert_eq!(
            extract_redirect_target("cmd 2> /tmp/err.log"),
            Some("/tmp/err.log".to_string()),
        );
        assert_eq!(
            extract_redirect_target("cmd &> /etc/output"),
            Some("/etc/output".to_string()),
        );
    }
}

pub async fn execute(
    name: &str,
    args: &Value,
    _app_handle: &tauri::AppHandle,
) -> Option<Result<String, String>> {
    let args_str = serde_json::to_string(args).unwrap_or_default();
    let args_preview: String = args_str.chars().take(150).collect();
    info!("[tools] {} args={}{}", name, args_preview, if args_str.len() > 150 { "..." } else { "" });

    match name {
        // ── File Operations ──────────────────────────────────────
        "ide_read_file" => {
            let path = args["path"].as_str().unwrap_or("").to_string();
            Some(match opide_shell::ide_mcp::ide_read_file(path).await {
                Ok(fc) => Ok(serde_json::to_string_pretty(&fc).unwrap_or_default()),
                Err(e) => Err(e),
            })
        }
        "ide_write_file" => {
            let path = args["path"].as_str().unwrap_or("").to_string();
            let content = args["content"].as_str().unwrap_or("").to_string();

            // Read current content for diff (empty string = new file)
            let original = tokio::fs::read_to_string(&path).await.unwrap_or_default();

            // New files (no existing content) are auto-approved — no review needed.
            // Only modifications to existing files require user review.
            let approved = if original.is_empty() {
                log::info!("[tools] ide_write_file: new file {} — auto-approved", path);
                true
            } else {
                let desc = format!("Modify {} ({} bytes)", path, content.len());
                match crate::engine::frontend_bridge::request_edit_review(
                    _app_handle, &path, &original, &content, "ide_write_file", &desc,
                ).await {
                    Ok(accepted) => accepted,
                    Err(e) => {
                        log::warn!("[tools] Edit review failed for {}: {}", path, e);
                        return Some(Err(format!("Could not review changes to {}: {}", path, e)));
                    }
                }
            };

            if approved {
                Some(match opide_shell::ide_mcp::ide_write_file(path.clone(), content.clone()).await {
                    Ok(()) => Ok(format!("Wrote {} ({} bytes)", path, content.len())),
                    Err(e) => Err(e),
                })
            } else {
                Some(Ok(format!("Write to {} was not accepted — no changes made", path)))
            }
        }
        "ide_list_dir" => {
            let path = args["path"].as_str().unwrap_or("").to_string();
            Some(match opide_shell::ide_mcp::ide_list_dir(path).await {
                Ok(dl) => Ok(serde_json::to_string_pretty(&dl).unwrap_or_default()),
                Err(e) => Err(e),
            })
        }
        "ide_apply_edit" => {
            let path = args["path"].as_str().unwrap_or("").to_string();
            let start = args["start_line"].as_u64().unwrap_or(1) as usize;
            let end = args["end_line"].as_u64().unwrap_or(1) as usize;
            let new_content = args["new_content"].as_str().unwrap_or("").to_string();

            // Read current content and compute proposed result
            let original = match tokio::fs::read_to_string(&path).await {
                Ok(c) => c,
                Err(e) => return Some(Err(format!("Read failed: {e}"))),
            };
            let proposed = match opide_shell::ide_mcp::compute_edit(&original, start, end, &new_content) {
                Ok(p) => p,
                Err(e) => return Some(Err(e)),
            };
            let desc = format!("Edit {} lines {}-{}", path, start, end);

            // Request user review via Monaco diff editor
            match crate::engine::frontend_bridge::request_edit_review(
                _app_handle, &path, &original, &proposed, "ide_apply_edit", &desc,
            ).await {
                Ok(true) => {
                    // Accepted — write the computed result
                    Some(match tokio::fs::write(&path, &proposed).await {
                        Ok(()) => Ok(format!("Applied edit to {} (lines {}-{}) — approved", path, start, end)),
                        Err(e) => Err(format!("Write failed: {e}")),
                    })
                }
                Ok(false) => {
                    Some(Ok(format!("Edit to {} rejected by user", path)))
                }
                Err(e) => {
                    log::warn!("[tools] Edit review failed for {}: {}", path, e);
                    Some(Err(format!("Edit to {} blocked — review gate error: {}", path, e)))
                }
            }
        }
        "ide_delete_file" => {
            let path = args["path"].as_str().unwrap_or("").to_string();
            let desc = format!("Delete {}", path);
            match crate::engine::frontend_bridge::request_edit_review(
                _app_handle, &path, &path, "", "ide_delete_file", &desc,
            ).await {
                Ok(true) => Some(match tokio::fs::remove_file(&path).await {
                    Ok(()) => Ok(format!("Deleted {} — approved", path)),
                    Err(e) => match tokio::fs::remove_dir(&path).await {
                        Ok(()) => Ok(format!("Deleted directory {} — approved", path)),
                        Err(_) => Err(format!("Delete failed: {}", e)),
                    }
                }),
                Ok(false) => Some(Ok(format!("Delete of {} rejected by user", path))),
                Err(e) => {
                    log::warn!("[tools] Delete review failed for {}: {}", path, e);
                    Some(Err(format!("Delete of {} blocked — review gate error: {}", path, e)))
                }
            }
        }

        // ── Shell Execution ──────────────────────────────────────
        // Runs directly via opide_shell (zsh -l -c) for reliable captured output.
        // After execution, emits "agent-command-echo" so the frontend can display
        // the command and its output in the active terminal panel.
        "ide_run_command" => {
            let command = args["command"].as_str().unwrap_or("").to_string();
            let cwd = args["cwd"].as_str().map(|s| s.to_string());

            if command.is_empty() {
                return Some(Err("ide_run_command: 'command' is required".to_string()));
            }

            // B195: shell commands bypass host_api.rs and the B194 file
            // gates. Reproduced 2026-04-26: after B194 refused
            // `ctx.file_write(.../test.env, OPENAI_API_KEY=sk-...)`, the
            // model retried via `ide_run_command` with
            // `printf 'OPENAI_API_KEY=sk-...' > .../test.env` and the
            // shell happily wrote the credential to disk.
            //
            // Run the same credential heuristic over the command string
            // itself. Any literal credential-shaped value in the command
            // (in a `printf`/`echo`/heredoc) gets refused before the
            // shell sees it.
            if let Some(kind) = paw_temp_lib::engine::util::looks_like_credential_value(&command) {
                log::warn!(
                    "[tools] B195: refusing ide_run_command — command contains {}",
                    kind
                );
                return Some(Err(format!(
                    "Refusing to run command: it contains what looks like a {}. \
                     Use the engine's skill vault for credentials, or pass them \
                     via environment variables instead of literal values.",
                    kind
                )));
            }

            // B195: also reject commands that redirect into known-sensitive
            // paths even when the content alone wouldn't trip. Catches
            // `cat foo > ~/.ssh/authorized_keys`, `touch /etc/passwd`, etc.
            if let Some(target) = sensitive_redirect_target(&command) {
                log::warn!(
                    "[tools] B195: refusing ide_run_command — redirects to sensitive path '{}'",
                    target
                );
                return Some(Err(format!(
                    "Refusing to run command: redirects to '{}', which is blocked by \
                     the sensitive-path policy.",
                    target
                )));
            }

            match opide_shell::ide_mcp::ide_run_command(command.clone(), cwd.clone()).await {
                Ok(result) => {
                    // Echo to the terminal panel so the user can see what the agent ran
                    use tauri::Emitter;
                    let _ = _app_handle.emit("agent-command-echo", serde_json::json!({
                        "command": &command,
                        "cwd": cwd,
                        "stdout": &result.stdout,
                        "stderr": &result.stderr,
                        "exit_code": result.exit_code,
                    }));
                    Some(Ok(serde_json::to_string_pretty(&serde_json::json!({
                        "stdout":    result.stdout,
                        "stderr":    result.stderr,
                        "exit_code": result.exit_code,
                    })).unwrap_or_default()))
                }
                Err(e) => Some(Err(format!("ide_run_command failed: {}", e))),
            }
        }

        // ── Git Operations ───────────────────────────────────────
        "ide_git_status" => {
            let repo = args["repo_path"].as_str().unwrap_or("").to_string();
            Some(match opide_shell::git::git_status(repo).await {
                Ok(s) => Ok(serde_json::to_string_pretty(&s).unwrap_or_default()),
                Err(e) => Err(e),
            })
        }
        "ide_git_diff" => {
            let repo = args["repo_path"].as_str().unwrap_or("").to_string();
            let staged = args["staged"].as_bool().unwrap_or(false);
            Some(match opide_shell::git::git_diff(repo, staged).await {
                Ok(d) => Ok(serde_json::to_string_pretty(&d).unwrap_or_default()),
                Err(e) => Err(e),
            })
        }
        "ide_git_stage" => {
            let repo = args["repo_path"].as_str().unwrap_or("").to_string();
            let paths: Vec<String> = args["paths"]
                .as_array()
                .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
                .unwrap_or_default();
            Some(match opide_shell::git::git_stage(repo, paths).await {
                Ok(()) => Ok("Files staged".to_string()),
                Err(e) => Err(e),
            })
        }
        "ide_git_stage_all" => {
            let repo = args["repo_path"].as_str().unwrap_or("").to_string();
            Some(match opide_shell::git::git_stage_all(repo).await {
                Ok(()) => Ok("All changes staged".to_string()),
                Err(e) => Err(e),
            })
        }
        "ide_git_unstage" => {
            let repo = args["repo_path"].as_str().unwrap_or("").to_string();
            let paths: Vec<String> = args["paths"]
                .as_array()
                .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
                .unwrap_or_default();
            Some(match opide_shell::git::git_unstage(repo, paths).await {
                Ok(()) => Ok("Files unstaged".to_string()),
                Err(e) => Err(e),
            })
        }
        "ide_git_commit" => {
            let repo = args["repo_path"].as_str().unwrap_or("").to_string();
            let msg = args["message"].as_str().unwrap_or("").to_string();
            let request = opide_shell::git::GitCommitRequest { repo_path: repo, message: msg };
            Some(match opide_shell::git::git_commit(request).await {
                Ok(r) => Ok(serde_json::to_string_pretty(&r).unwrap_or_default()),
                Err(e) => Err(e),
            })
        }
        "ide_git_log" => {
            let repo = args["repo_path"].as_str().unwrap_or("").to_string();
            let limit = args["limit"].as_u64().map(|n| n as usize);
            Some(match opide_shell::git::git_log(repo, limit).await {
                Ok(l) => Ok(serde_json::to_string_pretty(&l).unwrap_or_default()),
                Err(e) => Err(e),
            })
        }
        "ide_git_branches" => {
            let repo = args["repo_path"].as_str().unwrap_or("").to_string();
            Some(match opide_shell::git::git_branches(repo).await {
                Ok(b) => Ok(serde_json::to_string_pretty(&b).unwrap_or_default()),
                Err(e) => Err(e),
            })
        }
        "ide_git_checkout" => {
            let repo = args["repo_path"].as_str().unwrap_or("").to_string();
            let branch = args["branch_name"].as_str().unwrap_or("").to_string();
            Some(match opide_shell::git::git_checkout(repo, branch).await {
                Ok(()) => Ok("Branch switched".to_string()),
                Err(e) => Err(e),
            })
        }

        // ── Search Operations ────────────────────────────────────
        "ide_search_text" => {
            let root = args["root"].as_str().unwrap_or("").to_string();
            let query = args["query"].as_str().unwrap_or("").to_string();
            let case_sensitive = args["case_sensitive"].as_bool().unwrap_or(false);
            let max_results = args["max_results"].as_u64().map(|n| n as usize);
            Some(
                match opide_shell::ide_mcp::ide_search_text(root, query, Some(case_sensitive), max_results)
                    .await
                {
                    Ok(r) => Ok(serde_json::to_string_pretty(&r).unwrap_or_default()),
                    Err(e) => Err(e),
                },
            )
        }

        // ── AST God View Tools ────────────────────────────────────
        // Helper: get the best available index (workspace first, then external fallback)
        "ide_ast_callers" => {
            let function = args["function"].as_str().unwrap_or("").to_string();
            if let Some(state) = _app_handle.try_state::<crate::indexer::IndexerState>() {
                // Try workspace index first, then external
                for index_slot in [&state.index, &state.external_index] {
                    if let Ok(ref guard) = index_slot.lock().map_err(|e| e.to_string()) {
                        if let Some(ref index) = **guard {
                            let callers = index.call_graph.callers_of(&function);
                            if !callers.is_empty() {
                                let result: Vec<String> = callers.iter().map(|e| format!("{}:{} (line {})", e.from_file, e.from_function, e.from_line)).collect();
                                return Some(Ok(result.join("\n")));
                            }
                        }
                    }
                }
                return Some(Ok(format!("No callers found for '{}'. The function may not exist in the index or has no callers.", function)));
            }
            Some(Ok("IndexerState not registered".to_string()))
        }
        "ide_ast_callees" => {
            let function = args["function"].as_str().unwrap_or("").to_string();
            if let Some(state) = _app_handle.try_state::<crate::indexer::IndexerState>() {
                for index_slot in [&state.index, &state.external_index] {
                    if let Ok(ref guard) = index_slot.lock().map_err(|e| e.to_string()) {
                        if let Some(ref index) = **guard {
                            let callees = index.call_graph.callees_of(&function);
                            if !callees.is_empty() {
                                let result: Vec<String> = callees.iter().map(|e| {
                                    let file = e.to_file.as_deref().unwrap_or("unknown");
                                    format!("{} ({}:{})", e.to_function, file, e.from_line)
                                }).collect();
                                return Some(Ok(result.join("\n")));
                            }
                        }
                    }
                }
                return Some(Ok(format!("No callees found for '{}'", function)));
            }
            Some(Ok("Index not available".to_string()))
        }
        "ide_ast_impact" => {
            let symbol = args["symbol"].as_str().unwrap_or("").to_string();
            if let Some(state) = _app_handle.try_state::<crate::indexer::IndexerState>() {
                for index_slot in [&state.index, &state.external_index] {
                    if let Ok(ref guard) = index_slot.lock().map_err(|e| e.to_string()) {
                        if let Some(ref index) = **guard {
                            let mut impact = index.call_graph.impact_of(&symbol);
                            impact.extend(index.type_graph.impact_of_type_change(&symbol));
                            if !impact.is_empty() {
                                return Some(Ok(impact.join("\n")));
                            }
                        }
                    }
                }
                return Some(Ok(format!("No impact found for '{}'", symbol)));
            }
            Some(Ok("Index not available".to_string()))
        }
        "ide_ast_definition" => {
            let symbol = args["symbol"].as_str().unwrap_or("").to_string();
            if let Some(state) = _app_handle.try_state::<crate::indexer::IndexerState>() {
                for index_slot in [&state.index, &state.external_index] {
                    if let Ok(ref guard) = index_slot.lock().map_err(|e| e.to_string()) {
                        if let Some(ref index) = **guard {
                            if let Some(file) = index.type_graph.definition_of(&symbol) {
                                return Some(Ok(file.clone()));
                            }
                            for file in &index.project.files {
                                for sym in &file.symbols {
                                    if sym.name == symbol { return Some(Ok(format!("{}:{}", file.path, sym.start_line))); }
                                }
                            }
                        }
                    }
                }
                return Some(Ok(format!("'{}' not found in index", symbol)));
            }
            Some(Ok("Index not available".to_string()))
        }
        "ide_ast_type_info" => {
            let type_name = args["type_name"].as_str().unwrap_or("").to_string();
            if let Some(state) = _app_handle.try_state::<crate::indexer::IndexerState>() {
                for index_slot in [&state.index, &state.external_index] {
                    if let Ok(ref guard) = index_slot.lock().map_err(|e| e.to_string()) {
                        if let Some(ref index) = **guard {
                            let parents: Vec<String> = index.type_graph.parents_of(&type_name).iter().map(|r| format!("{} ({:?})", r.name, r.kind)).collect();
                            let children: Vec<String> = index.type_graph.children_of(&type_name).iter().map(|r| format!("{} ({:?})", r.name, r.kind)).collect();
                            let usages = index.type_graph.usages_of(&type_name).len();
                            let ancestry = index.type_graph.ancestry_of(&type_name);
                            if !parents.is_empty() || !children.is_empty() || usages > 0 {
                                return Some(Ok(format!("Type: {}\nExtends/Implements: {}\nExtended by: {}\nUsed in: {} locations\nAncestry: {}",
                                    type_name,
                                    if parents.is_empty() { "none".into() } else { parents.join(", ") },
                                    if children.is_empty() { "none".into() } else { children.join(", ") },
                                    usages,
                                    if ancestry.is_empty() { "none".into() } else { ancestry.join(" → ") },
                                )));
                            }
                        }
                    }
                }
                return Some(Ok(format!("Type '{}' not found in index", type_name)));
            }
            Some(Ok("Index not available".to_string()))
        }
        // ── Index External Path Tool ──────────────────────────────────
        "ide_index_external" => {
            let path = args["path"].as_str().unwrap_or("").to_string();
            if path.is_empty() {
                return Some(Err("Path is required".to_string()));
            }
            if let Some(state) = _app_handle.try_state::<crate::indexer::IndexerState>() {
                match crate::indexer::index_external_path(path.clone(), state, _app_handle.clone()).await {
                    Ok(msg) => return Some(Ok(msg)),
                    Err(e) => return Some(Err(e)),
                }
            }
            Some(Err("IndexerState not registered".to_string()))
        }

        // ── Codebase Index Tools ──────────────────────────────────
        "ide_search_semantic" => {
            let query = args["query"].as_str().unwrap_or("").to_string();
            let limit = args["limit"].as_u64().map(|n| n as usize);
            if let Some(state) = _app_handle.try_state::<crate::indexer::IndexerState>() {
                Some(match crate::indexer::context::ide_search_semantic(
                    query, limit, state, _app_handle.clone()
                ).await {
                    Ok(results) => {
                        let formatted: Vec<String> = results.iter().map(|r| {
                            format!("{}:{}-{} {} (score: {:.2})", r.file_path, r.start_line, r.end_line, r.name, r.score)
                        }).collect();
                        Ok(formatted.join("\n"))
                    }
                    Err(e) => Err(e),
                })
            } else {
                Some(Err("Indexer not initialized".to_string()))
            }
        }
        "ide_get_project_overview" => {
            if let Some(state) = _app_handle.try_state::<crate::indexer::IndexerState>() {
                Some(match crate::indexer::context::ide_get_codebase_context(state).await {
                    Ok(ctx) => Ok(ctx),
                    Err(e) => Err(e),
                })
            } else {
                Some(Err("Indexer not initialized".to_string()))
            }
        }

        // ── Open Workspace (existing folder) ─────────────────────
        "ide_open_workspace" => {
            let path = args["path"].as_str().unwrap_or("").to_string();
            if path.is_empty() {
                return Some(Err("Path is required".to_string()));
            }
            if !std::path::Path::new(&path).exists() {
                return Some(Err(format!("Path does not exist: {}", path)));
            }
            use tauri::Emitter;
            if let Err(e) = _app_handle.emit("open-workspace", serde_json::json!({ "path": &path })) {
                log::warn!("[tools] Failed to emit open-workspace for {}: {}", path, e);
            }
            Some(Ok(format!(
                "Opening workspace: {}\n\
                 The AST indexer, call graph, and embeddings are now building.\n\
                 Wait for indexing to complete before using ide_ast_* tools.\n\
                 Try ide_ast_callers with a common function name to check if the index is ready.",
                path
            )))
        }

        // ── Create Project & Open Workspace ──────────────────────
        "ide_create_project" => {
            let name = args["name"].as_str().unwrap_or("new-project").to_string();
            let path = args["path"].as_str().map(|s| s.to_string()).unwrap_or_else(|| {
                let home = dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from("/tmp"));
                home.join("projects").join(&name).to_string_lossy().to_string()
            });

            // Create the directory and src subdirectory
            Some(match std::fs::create_dir_all(format!("{}/src", &path)) {
                Ok(()) => {
                    // Emit event to frontend to open this folder as workspace
                    use tauri::Emitter;
                    if let Err(e) = _app_handle.emit("open-workspace", serde_json::json!({ "path": &path })) {
                        log::warn!("[tools] Failed to emit open-workspace for {}: {}", path, e);
                    }
                    Ok(format!(
                        "Created project directory at: {}\n\
                         The workspace is now opening. Use this path as the base for all file operations.\n\
                         Example: ctx.file_write(\"{}/src/App.tsx\", code)",
                        path, path
                    ))
                }
                Err(e) => Err(format!("Failed to create directory: {e}")),
            })
        }

        // ── Frontend Bridge Tools (query Monaco editor) ──────────
        "ide_get_diagnostics" | "ide_get_selection" | "ide_get_open_files"
        | "ide_open_file" | "ide_get_terminal_output" => {
            Some(
                match crate::engine::frontend_bridge::request_from_frontend(
                    _app_handle,
                    name,
                    args.clone(),
                )
                .await
                {
                    Ok(result) => Ok(serde_json::to_string_pretty(&result).unwrap_or_default()),
                    Err(e) => Err(e),
                },
            )
        }

        // ── Execution Engine ──────────────────────────────────────
        "execute_code" => {
            let code = args["code"].as_str().unwrap_or("").to_string();
            if code.is_empty() {
                return Some(Err("No code provided".to_string()));
            }

            let host = Arc::new(OpideHostApi::new(_app_handle.clone()));

            // Set up real-time log streaming via Tauri events
            let app_for_logs = _app_handle.clone();
            let log_callback: opide_sandbox::LogCallback = Arc::new(move |msg: &str| {
                use tauri::Emitter;
                if let Err(e) = app_for_logs.emit("sandbox-progress", serde_json::json!({
                    "message": msg,
                    "timestamp": std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis()
                })) { log::warn!("[tools] sandbox-progress emit failed: {}", e); }
            });

            let result = opide_sandbox::execute_js_with_host_streaming_async(
                code, host, log_callback
            ).await;

            let output = if result.success {
                let mut out = String::new();
                if !result.logs.is_empty() {
                    out.push_str("Logs:\n");
                    for log in &result.logs {
                        out.push_str(&format!("  {}\n", log));
                    }
                    out.push('\n');
                }
                out.push_str("Result:\n");
                out.push_str(&serde_json::to_string_pretty(&result.value).unwrap_or_default());
                out.push_str(&format!("\n\nCompleted in {}ms", result.elapsed_ms));
                out
            } else {
                format!(
                    "Execution failed: {}\n\nLogs before failure:\n{}",
                    result.error.unwrap_or_default(),
                    result.logs.join("\n")
                )
            };

            Some(if result.success { Ok(output) } else { Err(output) })
        }

        _ => None, // Not an IDE tool — let OpenPawz handle it
    }
}

