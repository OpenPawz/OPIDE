// ── Host API Trait ───────────────────────────────────────────────────────────
// Defines the interface between the JS sandbox and the host application.
// The consuming app (OPIDE, OP/IO) implements this trait to provide
// file_read, file_write, exec, git, search, etc. The sandbox calls these
// synchronously from JS — the implementation bridges to async via block_on.

use serde::{Deserialize, Serialize};

// ─── Result Types ───────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FileReadResult {
    pub content: String,
    pub path: String,
    pub size: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ExecResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DirEntry {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GitStatusResult {
    pub branch: Option<String>,
    pub files: Vec<GitFileStatus>,
    pub ahead: usize,
    pub behind: usize,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GitFileStatus {
    pub path: String,
    pub status: String,
    pub staged: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GitDiffResult {
    pub path: String,
    pub patch: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GitLogEntry {
    pub id: String,
    pub short_id: String,
    pub message: String,
    pub author: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GitBranch {
    pub name: String,
    pub is_head: bool,
    pub is_remote: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SearchMatch {
    pub path: String,
    pub line: usize,
    pub text: String,
}

// ─── IDE State Types (Frontend Bridge) ──────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Diagnostic {
    pub path: String,
    pub line: usize,
    pub column: usize,
    pub severity: String, // "error", "warning", "info"
    pub message: String,
    pub source: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DiagnosticsResult {
    pub diagnostics: Vec<Diagnostic>,
    pub count: usize,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SelectionResult {
    pub text: Option<String>,
    pub path: Option<String>,
    pub start_line: Option<usize>,
    pub end_line: Option<usize>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct OpenFilesResult {
    pub files: Vec<String>,
    pub count: usize,
}

// ─── Host API Trait ─────────────────────────────────────────────────────────

/// Trait that the consuming app implements to give the sandbox access to
/// host capabilities. All methods are blocking — the implementation should
/// use `tokio::runtime::Handle::current().block_on()` to bridge async code.
pub trait HostApi: Send + Sync {
    // ── Filesystem ──────────────────────────────────────────────────

    /// Read a file. Returns content and metadata.
    fn file_read(&self, path: &str) -> Result<FileReadResult, String>;

    /// Write a file. Creates parent directories if needed.
    fn file_write(&self, path: &str, content: &str) -> Result<(), String>;

    /// Append to a file. Creates the file if it doesn't exist.
    fn file_append(&self, path: &str, content: &str) -> Result<(), String>;

    /// Delete a file or empty directory.
    fn file_delete(&self, path: &str) -> Result<(), String>;

    /// List directory contents.
    fn list_dir(&self, path: &str) -> Result<Vec<DirEntry>, String>;

    /// Apply a surgical line-range edit to a file.
    fn apply_edit(
        &self,
        path: &str,
        start_line: usize,
        end_line: usize,
        new_content: &str,
    ) -> Result<(), String>;

    // ── Execution ───────────────────────────────────────────────────

    /// Execute a shell command. Returns stdout, stderr, exit code.
    fn exec(&self, command: &str, cwd: Option<&str>) -> Result<ExecResult, String>;

    // ── Git ─────────────────────────────────────────────────────────

    /// Get git status: branch, modified files, ahead/behind.
    fn git_status(&self, repo: Option<&str>) -> Result<GitStatusResult, String>;

    /// Get git diff. If staged=true, show only staged changes.
    fn git_diff(&self, repo: Option<&str>, staged: bool) -> Result<Vec<GitDiffResult>, String>;

    /// Stage specific files.
    fn git_stage(&self, repo: Option<&str>, paths: Vec<String>) -> Result<(), String>;

    /// Commit staged changes.
    fn git_commit(&self, repo: Option<&str>, message: &str) -> Result<String, String>;

    /// View recent commit history.
    fn git_log(&self, repo: Option<&str>, limit: Option<usize>) -> Result<Vec<GitLogEntry>, String>;

    /// List all branches.
    fn git_branches(&self, repo: Option<&str>) -> Result<Vec<GitBranch>, String>;

    /// Switch to a branch.
    fn git_checkout(&self, repo: Option<&str>, branch: &str) -> Result<(), String>;

    // ── Search ──────────────────────────────────────────────────────

    /// Search for text across files. Returns matching lines.
    fn search(&self, query: &str, root: Option<&str>) -> Result<Vec<SearchMatch>, String>;

    // ── IDE State (Frontend Bridge) ─────────────────────────────────
    // These query live editor state. In OPIDE, they go through the Tauri
    // event bridge to Monaco. In OP/IO or tests, they can return mock data.

    /// Get LSP diagnostics (errors/warnings) for a file or the whole workspace.
    fn diagnostics(&self, path: Option<&str>) -> Result<DiagnosticsResult, String>;

    /// Get the user's current text selection in the editor.
    fn selection(&self) -> Result<SelectionResult, String>;

    /// Get list of currently open editor tabs.
    fn open_files(&self) -> Result<OpenFilesResult, String>;

    /// Open a file in the editor, optionally jumping to a line.
    fn open_file(&self, path: &str, line: Option<usize>) -> Result<(), String>;

    // ── AST Queries (A4 — God View) ────────────────────────────────
    // Structural code intelligence — call graphs, type hierarchies, scopes.

    /// Who calls this function? Returns "file:function (line N)" strings.
    fn ast_callers(&self, function: &str) -> Result<Vec<String>, String>;

    /// What does this function call?
    fn ast_callees(&self, function: &str) -> Result<Vec<String>, String>;

    /// What breaks if I change this symbol? Transitive impact analysis.
    fn ast_impact(&self, symbol: &str) -> Result<Vec<String>, String>;

    /// Where is this symbol defined? Returns "file:line".
    fn ast_definition(&self, symbol: &str) -> Result<Option<String>, String>;

    /// Type hierarchy: parents (extends/implements) and children.
    fn ast_type_info(&self, type_name: &str) -> Result<String, String>;

    // ── Generic Tool Gateway ────────────────────────────────────────

    /// Call any registered tool by name with JSON args. Returns JSON result.
    fn tool(&self, name: &str, args: &serde_json::Value) -> Result<serde_json::Value, String>;
}
