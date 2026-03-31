// ── OPIDE IDE Tool Definitions ───────────────────────────────────────────────
// Defines the tools the AI agent can call. Each tool has a name, description,
// and JSON schema for parameters.

use paw_temp_lib::atoms::types::{FunctionDefinition, ToolDefinition};
use serde_json::{json, Value};

// ─── Tool Definitions ────────────────────────────────────────────────────────

pub fn definitions() -> Vec<ToolDefinition> {
    vec![
        // ── File Operations ──────────────────────────────────────────
        tool("ide_read_file", "Read a file from the workspace. Returns content, language, and size.", json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "Absolute path to the file" }
            },
            "required": ["path"]
        })),
        tool("ide_write_file", "Write or create a file. Creates parent directories if needed.", json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "Absolute path to write" },
                "content": { "type": "string", "description": "File content" }
            },
            "required": ["path", "content"]
        })),
        tool("ide_list_dir", "List directory contents. Returns name, is_dir, size for each entry.", json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "Directory path" }
            },
            "required": ["path"]
        })),
        tool("ide_apply_edit", "Apply a surgical line-range edit to a file. Replaces lines start_line through end_line with new_content.", json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "File path" },
                "start_line": { "type": "integer", "description": "First line to replace (1-based)" },
                "end_line": { "type": "integer", "description": "Last line to replace (1-based, inclusive)" },
                "new_content": { "type": "string", "description": "Replacement content" }
            },
            "required": ["path", "start_line", "end_line", "new_content"]
        })),
        tool("ide_delete_file", "Delete a file or empty directory.", json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "Path to delete" }
            },
            "required": ["path"]
        })),

        // ── Shell Execution ──────────────────────────────────────────
        tool("ide_run_command", "Execute a shell command. Returns stdout, stderr, and exit code.", json!({
            "type": "object",
            "properties": {
                "command": { "type": "string", "description": "Shell command to run" },
                "cwd": { "type": "string", "description": "Working directory (optional)" }
            },
            "required": ["command"]
        })),

        // ── Git Operations ───────────────────────────────────────────
        tool("ide_git_status", "Get git status: branch, modified files, untracked, ahead/behind.", json!({
            "type": "object",
            "properties": {
                "repo_path": { "type": "string", "description": "Repository root path" }
            },
            "required": ["repo_path"]
        })),
        tool("ide_git_diff", "Get git diff of uncommitted changes.", json!({
            "type": "object",
            "properties": {
                "repo_path": { "type": "string", "description": "Repository root path" },
                "staged": { "type": "boolean", "description": "If true, show staged changes only" }
            },
            "required": ["repo_path", "staged"]
        })),
        tool("ide_git_stage", "Stage specific files for commit.", json!({
            "type": "object",
            "properties": {
                "repo_path": { "type": "string", "description": "Repository root path" },
                "paths": { "type": "array", "items": { "type": "string" }, "description": "Files to stage" }
            },
            "required": ["repo_path", "paths"]
        })),
        tool("ide_git_stage_all", "Stage all changes.", json!({
            "type": "object",
            "properties": {
                "repo_path": { "type": "string", "description": "Repository root path" }
            },
            "required": ["repo_path"]
        })),
        tool("ide_git_unstage", "Unstage specific files.", json!({
            "type": "object",
            "properties": {
                "repo_path": { "type": "string", "description": "Repository root path" },
                "paths": { "type": "array", "items": { "type": "string" }, "description": "Files to unstage" }
            },
            "required": ["repo_path", "paths"]
        })),
        tool("ide_git_commit", "Create a git commit with the staged changes.", json!({
            "type": "object",
            "properties": {
                "repo_path": { "type": "string", "description": "Repository root path" },
                "message": { "type": "string", "description": "Commit message" }
            },
            "required": ["repo_path", "message"]
        })),
        tool("ide_git_log", "View recent commit history.", json!({
            "type": "object",
            "properties": {
                "repo_path": { "type": "string", "description": "Repository root path" },
                "limit": { "type": "integer", "description": "Max commits to return (default 20)" }
            },
            "required": ["repo_path"]
        })),
        tool("ide_git_branches", "List all git branches.", json!({
            "type": "object",
            "properties": {
                "repo_path": { "type": "string", "description": "Repository root path" }
            },
            "required": ["repo_path"]
        })),
        tool("ide_git_checkout", "Switch to a different branch.", json!({
            "type": "object",
            "properties": {
                "repo_path": { "type": "string", "description": "Repository root path" },
                "branch_name": { "type": "string", "description": "Branch to checkout" }
            },
            "required": ["repo_path", "branch_name"]
        })),

        // ── Search Operations ────────────────────────────────────────
        tool("ide_search_text", "Search for text across the workspace using ripgrep. Returns file paths, line numbers, and matching lines.", json!({
            "type": "object",
            "properties": {
                "root": { "type": "string", "description": "Directory to search in" },
                "query": { "type": "string", "description": "Search text or regex" },
                "case_sensitive": { "type": "boolean", "description": "Case sensitive (default false)" },
                "max_results": { "type": "integer", "description": "Max results (default 50)" }
            },
            "required": ["root", "query"]
        })),

        // ── Codebase Index Tools ────────────────────────────────────
        tool("ide_search_semantic", "Semantic search across the codebase using embeddings. Finds code related to a concept, not just text matches. Returns ranked results with file paths and line ranges.", json!({
            "type": "object",
            "properties": {
                "query": { "type": "string", "description": "Natural language query (e.g. 'authentication logic', 'button click handler')" },
                "limit": { "type": "integer", "description": "Max results (default 10)" }
            },
            "required": ["query"]
        })),
        tool("ide_get_project_overview", "Get the project structure summary: framework, file counts, dependencies, entry points, config files.", json!({
            "type": "object",
            "properties": {}
        })),

        // ── AST God View Tools ────────────────────────────────────────
        tool("ide_ast_callers", "Who calls this function? Returns all call sites across the codebase.", json!({
            "type": "object",
            "properties": {
                "function": { "type": "string", "description": "Function name to look up" }
            },
            "required": ["function"]
        })),
        tool("ide_ast_callees", "What does this function call? Returns all functions called by the given function.", json!({
            "type": "object",
            "properties": {
                "function": { "type": "string", "description": "Function name to look up" }
            },
            "required": ["function"]
        })),
        tool("ide_ast_impact", "What breaks if I change this symbol? Transitive impact analysis through call graph and type hierarchy.", json!({
            "type": "object",
            "properties": {
                "symbol": { "type": "string", "description": "Symbol name (function, type, component)" }
            },
            "required": ["symbol"]
        })),
        tool("ide_ast_definition", "Where is this symbol defined? Returns file path and line number.", json!({
            "type": "object",
            "properties": {
                "symbol": { "type": "string", "description": "Symbol name to find" }
            },
            "required": ["symbol"]
        })),
        tool("ide_ast_type_info", "Get type hierarchy: what it extends/implements, what extends it, usage count.", json!({
            "type": "object",
            "properties": {
                "type_name": { "type": "string", "description": "Type/interface/class name" }
            },
            "required": ["type_name"]
        })),

        // ── Open Workspace ────────────────────────────────────────────
        tool("ide_open_workspace", "Open an existing folder as the IDE workspace. This triggers the AST indexer, call graph builder, and embedding generator. Use this after cloning a repo to enable full code intelligence. Wait for indexing to complete before using ide_ast_* tools.", json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "Absolute path to the folder to open as workspace (e.g., ~/.opide/audit/repo-name)" }
            },
            "required": ["path"]
        })),

        // ── External Indexing ─────────────────────────────────────────
        tool("ide_index_external", "Index an external directory for AST analysis without switching workspace. After indexing, all ide_ast_* tools will include results from this path.", json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "Absolute path to the directory to index (e.g., /tmp/repo/)" }
            },
            "required": ["path"]
        })),

        // ── Frontend Bridge Tools (data from Monaco editor) ──────────
        tool("ide_get_diagnostics", "Get LSP diagnostics (errors and warnings) for a file or the entire workspace.", json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "File path (optional — omit for all workspace diagnostics)" }
            }
        })),
        tool("ide_get_selection", "Get the user's current editor selection (text and line range).", json!({
            "type": "object",
            "properties": {}
        })),
        tool("ide_get_open_files", "List all currently open editor tabs.", json!({
            "type": "object",
            "properties": {}
        })),
        tool("ide_open_file", "Open a file in the editor, optionally jumping to a specific line.", json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "File path to open" },
                "line": { "type": "integer", "description": "Line number to jump to (optional)" }
            },
            "required": ["path"]
        })),
        tool("ide_get_terminal_output", "Get the recent terminal output (last 50 lines).", json!({
            "type": "object",
            "properties": {}
        })),

        // ── Workspace ───────────────────────────────────────────────
        tool("ide_create_project", "Create a new project directory and open it as the workspace. Use this when no folder is open and the user wants to start a new project. Creates the directory and opens it in the IDE.", json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "Absolute path for the new project directory (e.g. /Users/name/projects/my-app)" },
                "name": { "type": "string", "description": "Project name (used as directory name if path not provided)" }
            },
            "required": ["name"]
        })),

        // ── Execution Engine ───────────────────────────────────────
        tool("execute_code", "Execute a JavaScript function in a sandboxed runtime. ONLY use this for multi-step operations that cannot be done with individual tool calls (e.g. loops over files, conditional logic, test-fix cycles). For single operations, use the specific tool instead.\n\nThe function receives a ctx object. Read-only methods return safe defaults on failure. Write methods THROW on failure (wrap in try/catch).\n\nSafe methods (return defaults on error, never throw):\n- ctx.file_read(path) -> {content, path, size} — on error, content contains '[ERROR: ...]'\n- ctx.exec(command, cwd?) -> {stdout, stderr, exit_code} — cwd is optional working directory; on error, returns exit_code=1. ALWAYS pass cwd when working in an external repo (e.g. ctx.exec('find . -name Foo.java', '/path/to/repo'))\n- ctx.search(query, root?) -> string — newline-separated matches formatted as 'path:line: text'. root is optional directory to search in. Split on '\\n' to iterate. Returns '' on failure\n- ctx.git_status(repo?) -> {branch, files, ahead, behind} — repo is optional path. files is array of {path, status, staged}. Returns empty on failure\n- ctx.git_diff(repo?, staged?) -> string — raw unified diff text. repo and staged are optional. Returns '' on failure\n- ctx.git_log(repo?, limit?) -> [{id, message, author}] — repo and limit are optional. Returns [] on failure\n- ctx.diagnostics(path?) -> {diagnostics, count} — path is optional. Each diagnostic has {path, line, severity, message}. Returns empty on failure\n- ctx.selection() -> {text, path, start_line, end_line} — returns nulls on failure\n- ctx.open_files() -> string — newline-separated list of open file paths. Returns '' on failure\n- ctx.open_file(path, line?) -> void (never throws)\n- ctx.list_dir(path) -> string — newline-separated entries; directories have trailing '/'. Returns '' on failure\n- ctx.tool(name, args) -> JSON result — on error, returns {error: '...'}\n- ctx.log(msg) -> void\n\nWrite methods (THROW on failure — always use try/catch):\n- ctx.file_write(path, content) -> void — throws if rejected or review unavailable\n- ctx.file_append(path, content) -> void — throws on write failure\n- ctx.file_delete(path) -> void — throws if file not found\n- ctx.apply_edit(path, start, end, content) -> void — throws if rejected\n- ctx.git_stage(repo, paths) -> void — throws on failure\n- ctx.git_commit(repo, msg) -> string — throws on failure\n- ctx.git_checkout(repo, branch) -> void — throws on failure\n\nPattern:\n  var r = ctx.file_read('/path');\n  if (r.content.startsWith('[ERROR')) return {error: r.content};\n  // exec with cwd for external repos:\n  var out = ctx.exec('find . -name Foo.java', '/path/to/repo').stdout.trim();\n  // list_dir returns a string — split to iterate:\n  var entries = ctx.list_dir('/some/dir').split('\\n').filter(function(e) { return e.length > 0; });\n  // search returns a string — split to iterate:\n  var lines = ctx.search('myFunction', '/path/to/repo').split('\\n').filter(function(l) { return l.length > 0; });\n  try { ctx.file_write('/path', 'data'); } catch(e) { return {error: String(e)}; }", json!({
            "type": "object",
            "properties": {
                "code": { "type": "string", "description": "JavaScript function: function run(ctx) { ... return result; }" }
            },
            "required": ["code"]
        })),
    ]
}

fn tool(name: &str, description: &str, parameters: Value) -> ToolDefinition {
    ToolDefinition {
        tool_type: "function".to_string(),
        function: FunctionDefinition {
            name: name.to_string(),
            description: description.to_string(),
            parameters,
        },
    }
}
