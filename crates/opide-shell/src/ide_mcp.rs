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

#[derive(Debug, Serialize)]
pub struct FileStat {
    /// VS Code FileType bitmask: File=1, Directory=2, SymbolicLink=64.
    #[serde(rename = "type")]
    pub file_type: u32,
    pub size: u64,
    /// Epoch milliseconds.
    pub ctime: u64,
    pub mtime: u64,
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

/// Raw-bytes file read for vscode.workspace.fs.readFile, which returns a
/// Uint8Array. The text-based ide_read_file corrupts binary files (images,
/// wasm, fonts) because it reads as UTF-8. Returns standard base64 of the
/// raw bytes; the caller decodes to bytes.
#[tauri::command]
pub async fn ide_read_file_bytes(path: String) -> Result<String, String> {
    use base64::Engine;
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|e| format!("Read failed: {e}"))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// Raw-bytes file write for vscode.workspace.fs.writeFile. `content_base64`
/// is standard base64 of the raw bytes to write — no UTF-8 round-trip, so
/// binary content survives intact. Creates parent directories.
#[tauri::command]
pub async fn ide_write_file_bytes(path: String, content_base64: String) -> Result<(), String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(content_base64.as_bytes())
        .map_err(|e| format!("Invalid base64: {e}"))?;
    if let Some(parent) = Path::new(&path).parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("Mkdir failed: {e}"))?;
    }
    let len = bytes.len();
    tokio::fs::write(&path, bytes)
        .await
        .map_err(|e| format!("Write failed: {e}"))?;
    log::info!("[opide-mcp] wrote {} ({} bytes, binary)", path, len);
    Ok(())
}

/// Real stat for vscode.workspace.fs.stat. The previous frontend fake read
/// the entire file just to get its size and reported ctime/mtime = now.
/// `file_type` uses VS Code's FileType bitmask: File=1, Directory=2,
/// SymbolicLink=64 (OR-combined for symlinks). Times are epoch millis.
#[tauri::command]
pub async fn ide_stat(path: String) -> Result<FileStat, String> {
    // symlink_metadata so we can detect a symlink without following it,
    // then resolve the target's kind for the combined bitmask.
    let meta = tokio::fs::symlink_metadata(&path)
        .await
        .map_err(|e| format!("Stat failed: {e}"))?;
    let ft = meta.file_type();
    let mut file_type: u32 = 0;
    if ft.is_symlink() {
        file_type |= 64;
        if let Ok(target) = tokio::fs::metadata(&path).await {
            file_type |= if target.is_dir() { 2 } else { 1 };
        } else {
            file_type |= 1;
        }
    } else if ft.is_dir() {
        file_type = 2;
    } else {
        file_type = 1;
    }
    let to_ms = |t: std::io::Result<std::time::SystemTime>| -> u64 {
        t.ok()
            .and_then(|st| st.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    };
    Ok(FileStat {
        file_type,
        size: meta.len(),
        ctime: to_ms(meta.created()),
        mtime: to_ms(meta.modified()),
    })
}

#[tauri::command]
pub async fn ide_delete_file(path: String, recursive: Option<bool>) -> Result<(), String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Err(format!("Not found: {path}"));
    }

    if p.is_dir() && recursive.unwrap_or(false) {
        tokio::fs::remove_dir_all(&path)
            .await
            .map_err(|e| format!("Remove dir failed: {e}"))?;
    } else if p.is_dir() {
        tokio::fs::remove_dir(&path)
            .await
            .map_err(|e| format!("Remove dir failed: {e}"))?;
    } else {
        tokio::fs::remove_file(&path)
            .await
            .map_err(|e| format!("Remove file failed: {e}"))?;
    }

    log::info!("[opide-mcp] deleted {path}");
    Ok(())
}

#[tauri::command]
pub async fn ide_list_dir(
    path: String,
    include_hidden: Option<bool>,
) -> Result<DirectoryListing, String> {
    // Agent tools hide dotfiles by default (cleaner listings); the extension
    // host's vscode.workspace.fs.readDirectory passes include_hidden=true
    // because its contract is to return EVERY entry (.gitignore, .env,
    // .vscode, …).
    let show_hidden = include_hidden.unwrap_or(false);
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
        if !show_hidden && name.starts_with('.') {
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
    let cwd = cwd.unwrap_or_else(|| {
        std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string())
    });

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
