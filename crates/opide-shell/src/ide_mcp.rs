// OPIDE IDE-MCP Bridge — exposes IDE capabilities as MCP tools for OpenPawz agents.
//
// This module doesn't create a new MCP server — it registers tools with the
// existing OpenPawz MCP infrastructure so agents can use IDE features:
//
//   - read_file / write_file / list_files — file operations
//   - search_text / search_files — project search
//   - git_status / git_diff / git_commit — git operations
//   - run_terminal — execute commands in the workspace
//   - get_diagnostics — LSP diagnostics for a file
//   - get_open_editors — list currently open files
//
// These tools are available to any OpenPawz agent during a chat session,
// giving agents full awareness of the IDE state and project context.

use serde::Serialize;
use std::path::Path;

// ─── Tool Results ────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct FileContent {
    pub path: String,
    pub content: String,
    pub language: String,
    pub size: u64,
}

#[derive(Debug, Serialize)]
pub struct DirectoryListing {
    pub path: String,
    pub entries: Vec<DirectoryEntry>,
}

#[derive(Debug, Serialize)]
pub struct DirectoryEntry {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
}

#[derive(Debug, Serialize)]
pub struct CommandResult {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
}

// ─── IDE Tool Commands ───────────────────────────────────────────────────────
// These are Tauri commands that agents call through the OpenPawz engine.
// The engine's tool bridge routes MCP tool calls to these.

#[tauri::command]
pub async fn ide_read_file(path: String) -> Result<FileContent, String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Err(format!("File not found: {path}"));
    }

    let content = tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| format!("Read failed: {e}"))?;

    let metadata = tokio::fs::metadata(&path)
        .await
        .map_err(|e| format!("Stat failed: {e}"))?;

    let language = detect_language(&path);

    Ok(FileContent {
        path,
        content,
        language,
        size: metadata.len(),
    })
}

#[tauri::command]
pub async fn ide_write_file(path: String, content: String) -> Result<(), String> {
    // Ensure parent directory exists
    if let Some(parent) = Path::new(&path).parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("Mkdir failed: {e}"))?;
    }

    tokio::fs::write(&path, &content)
        .await
        .map_err(|e| format!("Write failed: {e}"))?;

    log::info!("[opide-mcp] wrote {} ({} bytes)", path, content.len());
    Ok(())
}

#[tauri::command]
pub async fn ide_list_dir(path: String) -> Result<DirectoryListing, String> {
    let mut entries = Vec::new();
    let mut dir = tokio::fs::read_dir(&path)
        .await
        .map_err(|e| format!("Read dir failed: {e}"))?;

    while let Some(entry) = dir
        .next_entry()
        .await
        .map_err(|e| format!("Dir entry failed: {e}"))?
    {
        let name = entry.file_name().to_string_lossy().to_string();
        // Skip hidden files
        if name.starts_with('.') {
            continue;
        }
        let meta = entry.metadata().await.ok();
        entries.push(DirectoryEntry {
            name,
            is_dir: meta.as_ref().map_or(false, |m| m.is_dir()),
            size: meta.as_ref().map_or(0, |m| m.len()),
        });
    }

    entries.sort_by(|a, b| {
        b.is_dir.cmp(&a.is_dir).then(a.name.cmp(&b.name))
    });

    Ok(DirectoryListing { path, entries })
}

#[tauri::command]
pub async fn ide_run_command(
    command: String,
    cwd: Option<String>,
) -> Result<CommandResult, String> {
    let cwd = cwd.unwrap_or_else(|| "/tmp".to_string());

    let output = tokio::process::Command::new("zsh")
        .arg("-l")
        .arg("-c")
        .arg(&command)
        .current_dir(&cwd)
        .output()
        .await
        .map_err(|e| format!("Command failed: {e}"))?;

    Ok(CommandResult {
        exit_code: output.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
    })
}

// ─── Git Tools (delegates to git.rs) ─────────────────────────────────────────

#[tauri::command]
pub async fn ide_get_git_status(repo_path: String) -> Result<serde_json::Value, String> {
    let status = crate::git::git_status(repo_path).await?;
    serde_json::to_value(status).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn ide_get_git_diff(repo_path: String, staged: bool) -> Result<serde_json::Value, String> {
    let diff = crate::git::git_diff(repo_path, staged).await?;
    serde_json::to_value(diff).map_err(|e| e.to_string())
}

// ─── Search Tools (delegates to search.rs) ───────────────────────────────────

#[tauri::command]
pub async fn ide_search_text(
    root: String,
    query: String,
    case_sensitive: Option<bool>,
    max_results: Option<usize>,
) -> Result<serde_json::Value, String> {
    let result = crate::search::search_files(crate::search::SearchRequest {
        root,
        query,
        is_regex: false,
        case_sensitive: case_sensitive.unwrap_or(false),
        glob: None,
        max_results,
    })
    .await?;
    serde_json::to_value(result).map_err(|e| e.to_string())
}

// ─── Apply Edit (surgical line-range replacement) ────────────────────────────

/// Compute the result of a line-range edit without writing to disk.
/// Returns the proposed new file content.
pub fn compute_edit(
    content: &str,
    start_line: usize,
    end_line: usize,
    new_content: &str,
) -> Result<String, String> {
    let lines: Vec<&str> = content.lines().collect();
    let total = lines.len();

    if start_line == 0 || start_line > total + 1 || end_line < start_line {
        return Err(format!(
            "Invalid line range {start_line}-{end_line} (file has {total} lines)"
        ));
    }

    let mut result = String::new();
    for line in &lines[..start_line - 1] {
        result.push_str(line);
        result.push('\n');
    }
    result.push_str(new_content);
    if !new_content.ends_with('\n') {
        result.push('\n');
    }
    let after_start = end_line.min(total);
    for line in &lines[after_start..] {
        result.push_str(line);
        result.push('\n');
    }
    Ok(result)
}

#[tauri::command]
pub async fn ide_apply_edit(
    path: String,
    start_line: usize,
    end_line: usize,
    new_content: String,
) -> Result<(), String> {
    let content = tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| format!("Read failed: {e}"))?;

    let result = compute_edit(&content, start_line, end_line, &new_content)?;

    tokio::fs::write(&path, &result)
        .await
        .map_err(|e| format!("Write failed: {e}"))?;

    log::info!(
        "[opide-mcp] applied edit to {} lines {}-{} ({} bytes new)",
        path,
        start_line,
        end_line,
        new_content.len()
    );
    Ok(())
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

fn detect_language(path: &str) -> String {
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");

    match ext {
        "rs" => "rust",
        "ts" | "tsx" => "typescript",
        "js" | "jsx" | "mjs" | "cjs" => "javascript",
        "py" => "python",
        "go" => "go",
        "java" => "java",
        "c" | "h" => "c",
        "cpp" | "cc" | "cxx" | "hpp" => "cpp",
        "cs" => "csharp",
        "rb" => "ruby",
        "php" => "php",
        "swift" => "swift",
        "kt" | "kts" => "kotlin",
        "html" | "htm" => "html",
        "css" => "css",
        "scss" => "scss",
        "less" => "less",
        "json" => "json",
        "yaml" | "yml" => "yaml",
        "toml" => "toml",
        "xml" => "xml",
        "md" | "markdown" => "markdown",
        "sh" | "bash" | "zsh" => "shellscript",
        "sql" => "sql",
        "dockerfile" | "Dockerfile" => "dockerfile",
        _ => "plaintext",
    }
    .to_string()
}
