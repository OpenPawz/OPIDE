// ── Host API Injection (Zero JSON) ──────────────────────────────────────────
// Every host function is bound directly with typed parameters.
// Rust receives native types from rquickjs, calls HostApi, returns native
// JS objects constructed in Rust. No JSON.stringify, no JSON.parse.

use crate::host_api::HostApi;
use rquickjs::{Function, function::Opt};
use std::sync::Arc;

/// Convert a host error string into a rquickjs error.
fn host_err(msg: String) -> rquickjs::Error {
    rquickjs::Error::new_from_js_message("host", "Error", msg)
}

/// Inject host API functions onto the `ctx` JS object — all typed, no JSON.
pub(super) fn inject_host_api(ctx: &rquickjs::Ctx<'_>, host: Arc<dyn HostApi>) -> Result<(), String> {
    let globals = ctx.globals();
    let ctx_obj: rquickjs::Object = globals.get("ctx").map_err(|e| format!("No ctx object: {e}"))?;

    // ── ctx.file_read(path) → {content, path, size} ─────────────────
    // Raw binding returns JSON string; JS wrapper in the eval block below
    // parses it into the object the agent expects: {content, path, size}.
    {
        let h = host.clone();
        let func = Function::new(ctx.clone(), move |path: String| -> rquickjs::Result<String> {
            h.file_read(&path)
                .map(|r| serde_json::json!({
                    "content": r.content,
                    "path": r.path,
                    "size": r.size
                }).to_string())
                .map_err(host_err)
        })
        .map_err(|e| format!("file_read bind: {e}"))?;
        ctx_obj.set("__file_read_raw", func).map_err(|e| format!("set file_read: {e}"))?;
    }

    // ── ctx.file_write(path, content) → void (throws on error) ──────
    {
        let h = host.clone();
        let func = Function::new(
            ctx.clone(),
            move |path: String, content: String| -> rquickjs::Result<()> {
                h.file_write(&path, &content)
                    .map_err(host_err)
            },
        )
        .map_err(|e| format!("file_write bind: {e}"))?;
        ctx_obj.set("file_write", func).map_err(|e| format!("set file_write: {e}"))?;
    }

    // ── ctx.file_append(path, content) → void ───────────────────────
    {
        let h = host.clone();
        let func = Function::new(
            ctx.clone(),
            move |path: String, content: String| -> rquickjs::Result<()> {
                h.file_append(&path, &content)
                    .map_err(host_err)
            },
        )
        .map_err(|e| format!("file_append bind: {e}"))?;
        ctx_obj.set("file_append", func).map_err(|e| format!("set file_append: {e}"))?;
    }

    // ── ctx.file_delete(path) → void ────────────────────────────────
    {
        let h = host.clone();
        let func = Function::new(ctx.clone(), move |path: String| -> rquickjs::Result<()> {
            h.file_delete(&path)
                .map_err(host_err)
        })
        .map_err(|e| format!("file_delete bind: {e}"))?;
        ctx_obj.set("file_delete", func).map_err(|e| format!("set file_delete: {e}"))?;
    }

    // ── ctx.list_dir(path) → string (newline-separated entries) ────
    {
        let h = host.clone();
        let func = Function::new(ctx.clone(), move |path: String| -> rquickjs::Result<String> {
            h.list_dir(&path)
                .map(|entries| entries.into_iter().map(|e| {
                    if e.is_dir { format!("{}/", e.name) } else { e.name }
                }).collect::<Vec<_>>().join("\n"))
                .map_err(host_err)
        })
        .map_err(|e| format!("list_dir bind: {e}"))?;
        ctx_obj.set("list_dir", func).map_err(|e| format!("set list_dir: {e}"))?;
    }

    // ── ctx.apply_edit(path, start, end, content) → void ────────────
    {
        let h = host.clone();
        let func = Function::new(
            ctx.clone(),
            move |path: String, start: usize, end: usize, content: String| -> rquickjs::Result<()> {
                h.apply_edit(&path, start, end, &content)
                    .map_err(host_err)
            },
        )
        .map_err(|e| format!("apply_edit bind: {e}"))?;
        ctx_obj.set("apply_edit", func).map_err(|e| format!("set apply_edit: {e}"))?;
    }

    // ── Complex return types: Rust returns typed struct, JS wrapper builds object ──
    // For functions that return objects with multiple fields, we return individual
    // values and let a thin JS wrapper construct the object. This avoids capturing
    // Ctx in closures (which causes QuickJS GC assertion failures).

    // ── ctx.exec(command, cwd?) → { stdout, stderr, exit_code } ─────
    // B153: return a JSON envelope instead of `\x1F`-delimited tuple. The
    // separator could legitimately appear inside shell output (binary
    // dumps, terminal control sequences, base64 streams), and would
    // mis-split into wrong stdout/stderr fields. JSON.parse on the JS
    // side is well under a microsecond for these payloads.
    {
        let h = host.clone();
        let func = Function::new(
            ctx.clone(),
            move |command: String, cwd: Opt<String>| -> rquickjs::Result<String> {
                let r = h.exec(&command, cwd.0.as_deref()).map_err(host_err)?;
                let payload = serde_json::json!({
                    "stdout": r.stdout,
                    "stderr": r.stderr,
                    "exit_code": r.exit_code,
                });
                Ok(payload.to_string())
            },
        )
        .map_err(|e| format!("exec bind: {e}"))?;
        ctx_obj.set("__exec_typed", func).map_err(|e| format!("set exec: {e}"))?;
    }

    // ── ctx.git_status(repo?) → { branch, ahead, behind, files_count }
    {
        let h = host.clone();
        let func = Function::new(
            ctx.clone(),
            move |repo: Opt<String>| -> rquickjs::Result<String> {
                let r = h.git_status(repo.0.as_deref().filter(|s| !s.is_empty())).map_err(host_err)?;
                // Return "branch\x1Fahead\x1Fbehind\x1Ffile_count\x1Ffile1\x1Ffile2..."
                let mut parts = vec![
                    r.branch.unwrap_or_default(),
                    r.ahead.to_string(),
                    r.behind.to_string(),
                    r.files.len().to_string(),
                ];
                for f in &r.files {
                    parts.push(format!("{}:{}:{}", f.path, f.status, if f.staged { "staged" } else { "unstaged" }));
                }
                Ok(parts.join("\x1F"))
            },
        )
        .map_err(|e| format!("git_status bind: {e}"))?;
        ctx_obj.set("__git_status_typed", func).map_err(|e| format!("set git_status: {e}"))?;
    }

    // ── ctx.git_diff(repo?, staged?) → string (the diff text) ───────
    {
        let h = host.clone();
        let func = Function::new(
            ctx.clone(),
            move |repo: Opt<String>, staged: Opt<bool>| -> rquickjs::Result<String> {
                let diffs = h.git_diff(repo.0.as_deref(), staged.0.unwrap_or(false))
                    .map_err(host_err)?;
                Ok(diffs.into_iter().map(|d| format!("--- {}\n{}", d.path, d.patch)).collect::<Vec<_>>().join("\n"))
            },
        )
        .map_err(|e| format!("git_diff bind: {e}"))?;
        ctx_obj.set("git_diff", func).map_err(|e| format!("set git_diff: {e}"))?;
    }

    // ── ctx.git_stage(repo?, paths) → void ──────────────────────────
    {
        let h = host.clone();
        let func = Function::new(
            ctx.clone(),
            move |repo: String, paths: Vec<String>| -> rquickjs::Result<()> {
                let repo_opt = if repo.is_empty() { None } else { Some(repo.as_str()) };
                h.git_stage(repo_opt, paths)
                    .map_err(host_err)
            },
        )
        .map_err(|e| format!("git_stage bind: {e}"))?;
        ctx_obj.set("__git_stage_typed", func).map_err(|e| format!("set git_stage: {e}"))?;
    }

    // ── ctx.git_commit(repo?, message) → string (commit id) ─────────
    {
        let h = host.clone();
        let func = Function::new(
            ctx.clone(),
            move |repo: String, message: String| -> rquickjs::Result<String> {
                let repo_opt = if repo.is_empty() { None } else { Some(repo.as_str()) };
                h.git_commit(repo_opt, &message)
                    .map_err(host_err)
            },
        )
        .map_err(|e| format!("git_commit bind: {e}"))?;
        ctx_obj.set("__git_commit_typed", func).map_err(|e| format!("set git_commit: {e}"))?;
    }

    // ── ctx.git_log(repo?, limit?) → formatted string ─────────────
    {
        let h = host.clone();
        let func = Function::new(
            ctx.clone(),
            move |repo: Opt<String>, limit: Opt<i32>| -> rquickjs::Result<String> {
                let entries = h.git_log(repo.0.as_deref(), limit.0.map(|n| n as usize)).map_err(host_err)?;
                // Each entry as "id|message|author", separated by \x1F
                Ok(entries.into_iter().map(|e| format!("{}|{}|{}", e.short_id, e.message, e.author)).collect::<Vec<_>>().join("\x1F"))
            },
        )
        .map_err(|e| format!("git_log bind: {e}"))?;
        ctx_obj.set("__git_log_typed", func).map_err(|e| format!("set git_log: {e}"))?;
    }

    // ── ctx.git_branches(repo?) → string (newline-separated) ──────
    {
        let h = host.clone();
        let func = Function::new(
            ctx.clone(),
            move |repo: Opt<String>| -> rquickjs::Result<String> {
                h.git_branches(repo.0.as_deref())
                    .map(|branches| branches.into_iter().map(|b| {
                        if b.is_head { format!("* {}", b.name) } else { b.name }
                    }).collect::<Vec<_>>().join("\n"))
                    .map_err(host_err)
            },
        )
        .map_err(|e| format!("git_branches bind: {e}"))?;
        ctx_obj.set("git_branches", func).map_err(|e| format!("set git_branches: {e}"))?;
    }

    // ── ctx.git_checkout(repo?, branch) → void ──────────────────────
    {
        let h = host.clone();
        let func = Function::new(
            ctx.clone(),
            move |repo: String, branch: String| -> rquickjs::Result<()> {
                let repo_opt = if repo.is_empty() { None } else { Some(repo.as_str()) };
                h.git_checkout(repo_opt, &branch)
                    .map_err(host_err)
            },
        )
        .map_err(|e| format!("git_checkout bind: {e}"))?;
        ctx_obj.set("__git_checkout_typed", func).map_err(|e| format!("set git_checkout: {e}"))?;
    }

    // ── ctx.search(query, root?) → string (formatted matches) ───────
    {
        let h = host.clone();
        let func = Function::new(
            ctx.clone(),
            move |query: String, root: Opt<String>| -> rquickjs::Result<String> {
                let matches = h.search(&query, root.0.as_deref())
                    .map_err(host_err)?;
                Ok(matches.into_iter().map(|m| format!("{}:{}: {}", m.path, m.line, m.text)).collect::<Vec<_>>().join("\n"))
            },
        )
        .map_err(|e| format!("search bind: {e}"))?;
        ctx_obj.set("search", func).map_err(|e| format!("set search: {e}"))?;
    }

    // ── ctx.diagnostics(path?) → typed array ──────────────────────
    {
        let h = host.clone();
        let func = Function::new(
            ctx.clone(),
            move |path: Opt<String>| -> rquickjs::Result<String> {
                let r = h.diagnostics(path.0.as_deref()).map_err(host_err)?;
                // Each diagnostic as "path|line|severity|message", separated by \x1F
                Ok(r.diagnostics.into_iter().map(|d| format!("{}|{}|{}|{}", d.path, d.line, d.severity, d.message)).collect::<Vec<_>>().join("\x1F"))
            },
        )
        .map_err(|e| format!("diagnostics bind: {e}"))?;
        ctx_obj.set("__diagnostics_typed", func).map_err(|e| format!("set diagnostics: {e}"))?;
    }

    // ── ctx.selection() → typed array [text, path, start, end] ──────
    {
        let h = host.clone();
        let func = Function::new(ctx.clone(), move || -> rquickjs::Result<String> {
            let r = h.selection().map_err(host_err)?;
            // "text\x1Fpath\x1Fstart\x1Fend"
            Ok(format!("{}\x1F{}\x1F{}\x1F{}",
                r.text.unwrap_or_default(),
                r.path.unwrap_or_default(),
                r.start_line.map_or(String::new(), |n| n.to_string()),
                r.end_line.map_or(String::new(), |n| n.to_string()),
            ))
        })
        .map_err(|e| format!("selection bind: {e}"))?;
        ctx_obj.set("__selection_typed", func).map_err(|e| format!("set selection: {e}"))?;
    }

    // ── ctx.open_files() → string (newline-separated paths) ────────
    {
        let h = host.clone();
        let func = Function::new(ctx.clone(), move || -> rquickjs::Result<String> {
            h.open_files()
                .map(|r| r.files.join("\n"))
                .map_err(host_err)
        })
        .map_err(|e| format!("open_files bind: {e}"))?;
        ctx_obj.set("open_files", func).map_err(|e| format!("set open_files: {e}"))?;
    }

    // ── ctx.open_file(path, line?) → void ───────────────────────────
    {
        let h = host.clone();
        let func = Function::new(
            ctx.clone(),
            move |path: String, line: Opt<i32>| -> rquickjs::Result<()> {
                h.open_file(&path, line.0.map(|n| n as usize))
                    .map_err(host_err)
            },
        )
        .map_err(|e| format!("open_file bind: {e}"))?;
        ctx_obj.set("open_file", func).map_err(|e| format!("set open_file: {e}"))?;
    }

    // ── ctx.tool(name, args) → result (still JSON for generic gateway)
    // This is the ONE function that keeps JSON — because it's a generic
    // gateway to any tool, and we can't know the return type at compile time.
    // All typed functions above should be preferred.
    {
        let h = host.clone();
        let func = Function::new(
            ctx.clone(),
            move |name: String, args_json: String| -> rquickjs::Result<String> {
                let args: serde_json::Value = serde_json::from_str(&args_json)
                    .unwrap_or(serde_json::Value::Object(serde_json::Map::new()));
                match h.tool(&name, &args) {
                    Ok(result) => Ok(result.to_string()),
                    Err(e) => Err(host_err(e)),
                }
            },
        )
        .map_err(|e| format!("tool bind: {e}"))?;
        ctx_obj.set("__tool_raw", func).map_err(|e| format!("set tool: {e}"))?;
    }

    // Thin JS wrappers for complex return types — construct objects from typed arrays.
    // No JSON.parse anywhere except the generic tool gateway.
    ctx.eval::<(), &str>(r#"
        // Helper: convert null/undefined to ""
        var _s = function(v) { return (v == null || v === undefined) ? "" : String(v); };

        ctx.exec = function(command, cwd) {
            // B153: JSON envelope — stdout may legitimately contain the
            // \x1F unit-separator that the old protocol used as a delimiter.
            var raw = (cwd != null) ? ctx.__exec_typed(command, cwd) : ctx.__exec_typed(command);
            try { return JSON.parse(raw); }
            catch (e) { return { stdout: raw || "", stderr: "", exit_code: -1 }; }
        };
        ctx.git_status = function(repo) {
            var raw = (repo != null) ? ctx.__git_status_typed(repo) : ctx.__git_status_typed();
            var r = raw.split(String.fromCharCode(31));
            var result = { branch: r[0], ahead: parseInt(r[1]), behind: parseInt(r[2]), files: [] };
            var fc = parseInt(r[3]);
            for (var i = 0; i < fc; i++) {
                var parts = r[4 + i].split(":");
                result.files.push({ path: parts[0], status: parts[1], staged: parts[2] === "staged" });
            }
            return result;
        };
        ctx.git_stage = function(repo, paths) {
            ctx.__git_stage_typed(_s(repo), paths);
        };
        ctx.git_commit = function(repo, message) {
            return ctx.__git_commit_typed(_s(repo), message);
        };
        ctx.git_checkout = function(repo, branch) {
            ctx.__git_checkout_typed(_s(repo), branch);
        };
        ctx.git_log = function(repo, limit) {
            var raw;
            if (repo != null && limit != null) raw = ctx.__git_log_typed(repo, limit);
            else if (repo != null) raw = ctx.__git_log_typed(repo);
            else raw = ctx.__git_log_typed();
            if (!raw) return [];
            return raw.split(String.fromCharCode(31)).filter(function(e) { return e.length > 0; }).map(function(entry) {
                var parts = entry.split("|");
                return { id: parts[0], message: parts[1], author: parts[2] };
            });
        };
        ctx.diagnostics = function(path) {
            var raw = (path != null) ? ctx.__diagnostics_typed(path) : ctx.__diagnostics_typed();
            if (!raw) return { count: 0, diagnostics: [] };
            var entries = raw.split(String.fromCharCode(31)).filter(function(e) { return e.length > 0; });
            return {
                count: entries.length,
                diagnostics: entries.map(function(entry) {
                    var parts = entry.split("|");
                    return { path: parts[0], line: parseInt(parts[1]), severity: parts[2], message: parts.slice(3).join("|") };
                })
            };
        };
        ctx.selection = function() {
            var r = ctx.__selection_typed().split(String.fromCharCode(31));
            return {
                text: r[0] || null,
                path: r[1] || null,
                start_line: r[2] ? parseInt(r[2]) : null,
                end_line: r[3] ? parseInt(r[3]) : null
            };
        };
        ctx.file_read = function(path) {
            return JSON.parse(ctx.__file_read_raw(path));
        };
        ctx.tool = function(name, args) {
            return JSON.parse(ctx.__tool_raw(name, JSON.stringify(args || {})));
        };
    "#).map_err(|e| format!("wrappers: {e}"))?;

    Ok(())
}

