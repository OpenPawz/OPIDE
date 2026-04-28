// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
pub(crate) mod tests {
    use crate::executor::{execute_js, execute_js_with_host, execute_js_with_host_streaming, LogCallback, SandboxResult};
    use crate::host_api::*;
    use std::sync::{Arc, Mutex};

    // ── Mock Host API for testing ───────────────────────────────────

    struct MockHost {
        files: Mutex<std::collections::HashMap<String, String>>,
        branch: String,
        commits: Mutex<Vec<GitLogEntry>>,
    }

    impl MockHost {
        fn new() -> Self {
            Self {
                files: Mutex::new(std::collections::HashMap::new()),
                branch: "main".to_string(),
                commits: Mutex::new(vec![
                    GitLogEntry {
                        id: "abc123".to_string(),
                        short_id: "abc123".to_string(),
                        message: "initial commit".to_string(),
                        author: "test".to_string(),
                    },
                ]),
            }
        }

        fn with_file(self, path: &str, content: &str) -> Self {
            self.files.lock().unwrap().insert(path.to_string(), content.to_string());
            self
        }
    }

    impl HostApi for MockHost {
        fn file_read(&self, path: &str) -> Result<FileReadResult, String> {
            let files = self.files.lock().unwrap();
            match files.get(path) {
                Some(content) => Ok(FileReadResult {
                    content: content.clone(),
                    path: path.to_string(),
                    size: content.len() as u64,
                }),
                None => Err(format!("File not found: {path}")),
            }
        }

        fn file_write(&self, path: &str, content: &str) -> Result<(), String> {
            self.files.lock().unwrap().insert(path.to_string(), content.to_string());
            Ok(())
        }

        fn file_append(&self, path: &str, content: &str) -> Result<(), String> {
            let mut files = self.files.lock().unwrap();
            let entry = files.entry(path.to_string()).or_default();
            entry.push_str(content);
            Ok(())
        }

        fn file_delete(&self, path: &str) -> Result<(), String> {
            let mut files = self.files.lock().unwrap();
            if files.remove(path).is_some() {
                Ok(())
            } else {
                Err(format!("File not found: {path}"))
            }
        }

        fn list_dir(&self, _path: &str) -> Result<Vec<DirEntry>, String> {
            let files = self.files.lock().unwrap();
            Ok(files
                .keys()
                .map(|k| DirEntry {
                    name: k.clone(),
                    is_dir: false,
                    size: 0,
                })
                .collect())
        }

        fn apply_edit(
            &self,
            path: &str,
            start_line: usize,
            end_line: usize,
            new_content: &str,
        ) -> Result<(), String> {
            let mut files = self.files.lock().unwrap();
            let content = files.get(path).ok_or(format!("File not found: {path}"))?.clone();
            let lines: Vec<&str> = content.lines().collect();

            let mut result = String::new();
            for line in &lines[..start_line - 1] {
                result.push_str(line);
                result.push('\n');
            }
            result.push_str(new_content);
            if !new_content.ends_with('\n') {
                result.push('\n');
            }
            let after = end_line.min(lines.len());
            for line in &lines[after..] {
                result.push_str(line);
                result.push('\n');
            }

            files.insert(path.to_string(), result);
            Ok(())
        }

        fn exec(&self, command: &str, _cwd: Option<&str>) -> Result<ExecResult, String> {
            Ok(ExecResult {
                stdout: format!("mock: {command}"),
                stderr: String::new(),
                exit_code: 0,
            })
        }

        fn git_status(&self, _repo: Option<&str>) -> Result<GitStatusResult, String> {
            let files = self.files.lock().unwrap();
            Ok(GitStatusResult {
                branch: Some(self.branch.clone()),
                files: files
                    .keys()
                    .map(|k| GitFileStatus {
                        path: k.clone(),
                        status: "modified".to_string(),
                        staged: false,
                    })
                    .collect(),
                ahead: 0,
                behind: 0,
            })
        }

        fn git_diff(&self, _repo: Option<&str>, _staged: bool) -> Result<Vec<GitDiffResult>, String> {
            Ok(vec![GitDiffResult {
                path: "test.rs".to_string(),
                patch: "+added line\n-removed line".to_string(),
            }])
        }

        fn git_stage(&self, _repo: Option<&str>, _paths: Vec<String>) -> Result<(), String> {
            Ok(())
        }

        fn git_commit(&self, _repo: Option<&str>, message: &str) -> Result<String, String> {
            let id = format!("mock_{}", message.len());
            self.commits.lock().unwrap().push(GitLogEntry {
                id: id.clone(),
                short_id: id.clone(),
                message: message.to_string(),
                author: "test".to_string(),
            });
            Ok(id)
        }

        fn git_log(&self, _repo: Option<&str>, limit: Option<usize>) -> Result<Vec<GitLogEntry>, String> {
            let commits = self.commits.lock().unwrap();
            let limit = limit.unwrap_or(20).min(commits.len());
            Ok(commits[..limit].to_vec())
        }

        fn git_branches(&self, _repo: Option<&str>) -> Result<Vec<GitBranch>, String> {
            Ok(vec![
                GitBranch { name: "main".to_string(), is_head: true, is_remote: false },
                GitBranch { name: "dev".to_string(), is_head: false, is_remote: false },
            ])
        }

        fn git_checkout(&self, _repo: Option<&str>, _branch: &str) -> Result<(), String> {
            Ok(())
        }

        fn search(&self, query: &str, _root: Option<&str>) -> Result<Vec<SearchMatch>, String> {
            let files = self.files.lock().unwrap();
            let mut matches = Vec::new();
            for (path, content) in files.iter() {
                for (i, line) in content.lines().enumerate() {
                    if line.contains(query) {
                        matches.push(SearchMatch {
                            path: path.clone(),
                            line: i + 1,
                            text: line.to_string(),
                        });
                    }
                }
            }
            Ok(matches)
        }

        fn diagnostics(&self, path: Option<&str>) -> Result<DiagnosticsResult, String> {
            // Mock: return errors for files that contain "ERROR:" comments
            let files = self.files.lock().unwrap();
            let mut diagnostics = Vec::new();
            for (fpath, content) in files.iter() {
                if let Some(filter) = path {
                    if fpath != filter { continue; }
                }
                for (i, line) in content.lines().enumerate() {
                    if line.contains("// ERROR:") {
                        let msg = line.trim_start_matches("// ERROR:").trim().to_string();
                        diagnostics.push(Diagnostic {
                            path: fpath.clone(),
                            line: i + 1,
                            column: 1,
                            severity: "error".to_string(),
                            message: msg,
                            source: "mock-lsp".to_string(),
                        });
                    } else if line.contains("// WARN:") {
                        let msg = line.trim_start_matches("// WARN:").trim().to_string();
                        diagnostics.push(Diagnostic {
                            path: fpath.clone(),
                            line: i + 1,
                            column: 1,
                            severity: "warning".to_string(),
                            message: msg,
                            source: "mock-lsp".to_string(),
                        });
                    }
                }
            }
            let count = diagnostics.len();
            Ok(DiagnosticsResult { diagnostics, count })
        }

        fn selection(&self) -> Result<SelectionResult, String> {
            // Mock: return a fixed selection
            Ok(SelectionResult {
                text: Some("selected text".to_string()),
                path: Some("/src/app.rs".to_string()),
                start_line: Some(10),
                end_line: Some(15),
            })
        }

        fn open_files(&self) -> Result<OpenFilesResult, String> {
            let files = self.files.lock().unwrap();
            let paths: Vec<String> = files.keys().cloned().collect();
            let count = paths.len();
            Ok(OpenFilesResult { files: paths, count })
        }

        fn open_file(&self, _path: &str, _line: Option<usize>) -> Result<(), String> {
            Ok(())
        }

        fn ast_callers(&self, _: &str) -> Result<Vec<String>, String> { Ok(vec![]) }
        fn ast_callees(&self, _: &str) -> Result<Vec<String>, String> { Ok(vec![]) }
        fn ast_impact(&self, _: &str) -> Result<Vec<String>, String> { Ok(vec![]) }
        fn ast_definition(&self, _: &str) -> Result<Option<String>, String> { Ok(None) }
        fn ast_type_info(&self, _: &str) -> Result<String, String> { Ok(String::new()) }

        fn tool(&self, name: &str, args: &serde_json::Value) -> Result<serde_json::Value, String> {
            // Mock: route known tools, error on unknown
            match name {
                "ide_read_file" => {
                    let path = args["path"].as_str().unwrap_or("");
                    match self.file_read(path) {
                        Ok(r) => Ok(serde_json::to_value(r).unwrap()),
                        Err(e) => Err(e),
                    }
                }
                "memory_search" => {
                    let query = args["query"].as_str().unwrap_or("");
                    Ok(serde_json::json!({
                        "results": [
                            { "content": format!("mock memory result for: {query}"), "score": 0.9 }
                        ]
                    }))
                }
                "memory_store" => {
                    Ok(serde_json::json!({"ok": true, "stored": true}))
                }
                _ => Err(format!("Unknown tool: {name}")),
            }
        }
    }

    // ── Phase 1 Tests (no host API) ─────────────────────────────────

    #[test]
    fn test_basic_return_value() {
        let result = execute_js(r#"
            function run(ctx) {
                return { ok: true, value: 42 };
            }
        "#);
        assert!(result.success, "Error: {:?}", result.error);
        assert_eq!(result.value["ok"], true);
        assert_eq!(result.value["value"], 42);
    }

    #[test]
    fn test_arithmetic() {
        let result = execute_js(r#"
            function run(ctx) { return { sum: 1 + 2 + 3 }; }
        "#);
        assert!(result.success);
        assert_eq!(result.value["sum"], 6);
    }

    #[test]
    fn test_string_operations() {
        let result = execute_js(r#"
            function run(ctx) {
                const name = "hello world";
                return { upper: name.toUpperCase(), len: name.length };
            }
        "#);
        assert!(result.success);
        assert_eq!(result.value["upper"], "HELLO WORLD");
        assert_eq!(result.value["len"], 11);
    }

    #[test]
    fn test_loops_and_arrays() {
        let result = execute_js(r#"
            function run(ctx) {
                const items = [];
                for (let i = 0; i < 5; i++) items.push(i * 2);
                return { items, count: items.length };
            }
        "#);
        assert!(result.success);
        assert_eq!(result.value["count"], 5);
        assert_eq!(result.value["items"], serde_json::json!([0, 2, 4, 6, 8]));
    }

    #[test]
    fn test_ctx_log() {
        let result = execute_js(r#"
            function run(ctx) {
                ctx.log("step 1");
                ctx.log("step 2");
                ctx.log("done");
                return { steps: 3 };
            }
        "#);
        assert!(result.success);
        assert_eq!(result.logs.len(), 3);
        assert_eq!(result.logs[0], "step 1");
        assert_eq!(result.logs[2], "done");
    }

    #[test]
    fn test_no_run_function() {
        let result = execute_js("var x = 42;");
        assert!(result.success);
        assert_eq!(result.value["error"], "No run(ctx) function defined");
    }

    #[test]
    fn test_syntax_error() {
        let result = execute_js("function run(ctx) { return {{{; }");
        assert!(!result.success);
        assert!(result.error.is_some());
    }

    #[test]
    fn test_runtime_error() {
        let result = execute_js("function run(ctx) { return undefinedVariable.property; }");
        assert!(!result.success);
        assert!(result.error.is_some());
    }

    #[test]
    fn test_memory_limit() {
        // Memory limit is 128 MB (see runtime::MEMORY_LIMIT). Allocate well
        // beyond that — 5000 strings × 100_000 chars each. QuickJS strings
        // are stored as UTF-16 (≈2 bytes/char), so this is roughly 1 GB,
        // which decisively exceeds the 128 MB cap regardless of internal
        // overhead. Was previously sized for a 10 MB cap.
        let result = execute_js(r#"
            function run(ctx) {
                var arr = [];
                for (var i = 0; i < 5000; i++) {
                    var s = "";
                    for (var j = 0; j < 100000; j++) s += "A";
                    arr.push(s);
                }
                return { len: arr.length };
            }
        "#);
        assert!(!result.success, "Should have hit memory limit");
    }

    #[test]
    fn test_no_require() {
        let result = execute_js("function run(ctx) { var fs = require('fs'); return {}; }");
        assert!(!result.success);
    }

    #[test]
    fn test_no_global_access() {
        let result = execute_js(r#"
            function run(ctx) {
                return {
                    has_process: typeof process !== 'undefined',
                    has_window: typeof window !== 'undefined',
                    has_fetch: typeof fetch !== 'undefined',
                    has_require: typeof require !== 'undefined'
                };
            }
        "#);
        assert!(result.success);
        assert_eq!(result.value["has_process"], false);
        assert_eq!(result.value["has_window"], false);
    }

    #[test]
    fn test_elapsed_time_reported() {
        let result = execute_js("function run(ctx) { return { ok: true }; }");
        assert!(result.success);
        assert!(result.elapsed_ms < 5000);
    }

    // ── Phase 2 Tests (with host API) ───────────────────────────────

    #[test]
    fn test_host_file_write_and_read() {
        let host = Arc::new(MockHost::new());
        let result = execute_js_with_host(r#"
            function run(ctx) {
                ctx.file_write("/test.txt", "hello world");
                var r = ctx.file_read("/test.txt");
                return { content: r.content, size: r.content.length };
            }
        "#, host);
        assert!(result.success, "Error: {:?}", result.error);
        assert_eq!(result.value["content"], "hello world");
        assert_eq!(result.value["size"], 11);
    }

    #[test]
    fn test_host_file_read_not_found() {
        let host = Arc::new(MockHost::new());
        let result = execute_js_with_host(r#"
            function run(ctx) {
                try { ctx.file_read("/nonexistent.txt"); return { error: null }; }
                catch(e) { return { error: e.message || String(e) }; }
            }
        "#, host);
        assert!(result.success);
        assert!(result.value["error"].as_str().unwrap().contains("not found"));
    }

    #[test]
    fn test_host_file_append() {
        let host = Arc::new(MockHost::new());
        let result = execute_js_with_host(r#"
            function run(ctx) {
                ctx.file_write("/log.txt", "line 1\n");
                ctx.file_append("/log.txt", "line 2\n");
                var r = ctx.file_read("/log.txt");
                return { content: r.content };
            }
        "#, host);
        assert!(result.success, "Error: {:?}", result.error);
        assert_eq!(result.value["content"], "line 1\nline 2\n");
    }

    #[test]
    fn test_host_file_delete() {
        let host = Arc::new(MockHost::new());
        let result = execute_js_with_host(r#"
            function run(ctx) {
                ctx.file_write("/temp.txt", "delete me");
                ctx.file_delete("/temp.txt");
                try { ctx.file_read("/temp.txt"); return { deleted: true, read_error: null }; }
                catch(e) { return { deleted: true, read_error: e.message || String(e) }; }
            }
        "#, host);
        assert!(result.success, "Error: {:?}", result.error);
        assert!(result.value["read_error"].as_str().unwrap().contains("not found"));
    }

    #[test]
    fn test_host_list_dir() {
        let host = Arc::new(MockHost::new().with_file("/a.txt", "a").with_file("/b.txt", "b"));
        let result = execute_js_with_host(r#"
            function run(ctx) {
                var entries = ctx.list_dir("/").split("\n").filter(function(l) { return l.length > 0; });
                return { count: entries.length };
            }
        "#, host);
        assert!(result.success, "Error: {:?}", result.error);
        assert_eq!(result.value["count"], 2);
    }

    #[test]
    fn test_host_exec() {
        let host = Arc::new(MockHost::new());
        let result = execute_js_with_host(r#"
            function run(ctx) {
                var r = ctx.exec("echo hello");
                return { stdout: r.stdout, exit_code: r.exit_code };
            }
        "#, host);
        assert!(result.success, "Error: {:?}", result.error);
        assert_eq!(result.value["stdout"], "mock: echo hello");
        assert_eq!(result.value["exit_code"], 0);
    }

    #[test]
    fn test_host_apply_edit() {
        let host = Arc::new(MockHost::new().with_file("/code.rs", "line 1\nline 2\nline 3\n"));
        let result = execute_js_with_host(r#"
            function run(ctx) {
                ctx.apply_edit("/code.rs", 2, 2, "replaced line 2");
                var r = ctx.file_read("/code.rs");
                return { content: r.content };
            }
        "#, host);
        assert!(result.success, "Error: {:?}", result.error);
        let content = result.value["content"].as_str().unwrap();
        assert!(content.contains("line 1"));
        assert!(content.contains("replaced line 2"));
        assert!(content.contains("line 3"));
        assert!(!content.contains("\nline 2\n"));
    }

    #[test]
    fn test_host_multi_file_scaffold() {
        let host = Arc::new(MockHost::new());
        let result = execute_js_with_host(r#"
            function run(ctx) {
                var files = [
                    { path: "/src/app.tsx", content: "export function App() { return <div/>; }" },
                    { path: "/src/index.tsx", content: "import { App } from './App';" },
                    { path: "/package.json", content: '{"name":"test"}' }
                ];
                for (var i = 0; i < files.length; i++) {
                    ctx.file_write(files[i].path, files[i].content);
                    ctx.log("Created " + files[i].path);
                }
                return { files_created: files.length };
            }
        "#, host);
        assert!(result.success, "Error: {:?}", result.error);
        assert_eq!(result.value["files_created"], 3);
        assert_eq!(result.logs.len(), 3);
        assert_eq!(result.logs[0], "Created /src/app.tsx");
    }

    #[test]
    fn test_host_read_modify_write_loop() {
        let host = Arc::new(
            MockHost::new()
                .with_file("/a.ts", "const oldName = 1;")
                .with_file("/b.ts", "import { oldName } from './a';")
                .with_file("/c.ts", "// no change here"),
        );
        let result = execute_js_with_host(r#"
            function run(ctx) {
                var files = ["/a.ts", "/b.ts", "/c.ts"];
                var updated = 0;
                for (var i = 0; i < files.length; i++) {
                    var r = ctx.file_read(files[i]);
                    var content = r.content;
                    if (content.includes("oldName")) {
                        var newContent = content.replaceAll("oldName", "newName");
                        ctx.file_write(files[i], newContent);
                        updated++;
                        ctx.log("Updated " + files[i]);
                    }
                }
                return { scanned: files.length, updated: updated };
            }
        "#, host.clone());
        assert!(result.success, "Error: {:?}", result.error);
        assert_eq!(result.value["scanned"], 3);
        assert_eq!(result.value["updated"], 2);
        assert_eq!(result.logs.len(), 2);

        // Verify the files were actually modified
        let a = host.file_read("/a.ts").unwrap();
        assert!(a.content.contains("newName"));
        assert!(!a.content.contains("oldName"));
    }

    #[test]
    fn test_host_exec_with_cwd() {
        let host = Arc::new(MockHost::new());
        let result = execute_js_with_host(r#"
            function run(ctx) {
                var r = ctx.exec("ls", "/tmp");
                return { stdout: r.stdout };
            }
        "#, host);
        assert!(result.success, "Error: {:?}", result.error);
    }

    #[test]
    fn test_host_logs_still_work() {
        let host = Arc::new(MockHost::new());
        let result = execute_js_with_host(r#"
            function run(ctx) {
                ctx.log("before file ops");
                ctx.file_write("/test.txt", "data");
                ctx.log("after file ops");
                return { ok: true };
            }
        "#, host);
        assert!(result.success);
        assert_eq!(result.logs.len(), 2);
        assert_eq!(result.logs[0], "before file ops");
        assert_eq!(result.logs[1], "after file ops");
    }

    // ── Phase 3 Tests (git + search) ────────────────────────────────

    #[test]
    fn test_git_status() {
        let host = Arc::new(MockHost::new().with_file("/src/app.rs", "fn main() {}"));
        let result = execute_js_with_host(r#"
            function run(ctx) {
                var status = ctx.git_status();
                return {
                    branch: status.branch,
                    file_count: status.files.length,
                    ahead: status.ahead
                };
            }
        "#, host);
        assert!(result.success, "Error: {:?}", result.error);
        assert_eq!(result.value["branch"], "main");
        assert_eq!(result.value["file_count"], 1);
        assert_eq!(result.value["ahead"], 0);
    }

    #[test]
    fn test_git_diff() {
        let host = Arc::new(MockHost::new());
        let result = execute_js_with_host(r#"
            function run(ctx) {
                var diff = ctx.git_diff();
                return { has_diff: diff.length > 0 };
            }
        "#, host);
        assert!(result.success, "Error: {:?}", result.error);
        assert_eq!(result.value["has_diff"], true);
    }

    #[test]
    fn test_git_commit() {
        let host = Arc::new(MockHost::new());
        let result = execute_js_with_host(r#"
            function run(ctx) {
                ctx.git_stage(null, ["src/app.rs"]);
                var commit_id = ctx.git_commit(null, "feat: add app");
                return { commit_id: commit_id };
            }
        "#, host);
        assert!(result.success, "Error: {:?}", result.error);
        assert!(result.value["commit_id"].as_str().unwrap().starts_with("mock_"));
    }

    #[test]
    fn test_git_log() {
        let host = Arc::new(MockHost::new());
        let result = execute_js_with_host(r#"
            function run(ctx) {
                var log = ctx.git_log();
                return {
                    count: log.length,
                    first_msg: log.length > 0 ? log[0].message : "",
                    first_author: log.length > 0 ? log[0].author : ""
                };
            }
        "#, host);
        assert!(result.success, "Error: {:?}", result.error);
        assert_eq!(result.value["count"], 1);
        assert_eq!(result.value["first_msg"], "initial commit");
    }

    #[test]
    fn test_git_branches() {
        let host = Arc::new(MockHost::new());
        let result = execute_js_with_host(r#"
            function run(ctx) {
                var branches = ctx.git_branches().split("\n").filter(function(b) { return b.length > 0; });
                var head = branches.filter(function(b) { return b.indexOf("* ") === 0; });
                return { count: branches.length, has_head: head.length > 0 };
            }
        "#, host);
        assert!(result.success, "Error: {:?}", result.error);
        assert_eq!(result.value["count"], 2);
        assert_eq!(result.value["has_head"], true);
    }

    #[test]
    fn test_git_checkout() {
        let host = Arc::new(MockHost::new());
        let result = execute_js_with_host(r#"
            function run(ctx) {
                ctx.git_checkout(null, "dev");
                return { switched: true };
            }
        "#, host);
        assert!(result.success, "Error: {:?}", result.error);
        assert_eq!(result.value["switched"], true);
    }

    #[test]
    fn test_search() {
        let host = Arc::new(
            MockHost::new()
                .with_file("/src/app.rs", "fn main() {\n    println!(\"hello\");\n}")
                .with_file("/src/lib.rs", "pub fn hello() {}\npub fn world() {}")
                .with_file("/src/util.rs", "// no matches here"),
        );
        let result = execute_js_with_host(r#"
            function run(ctx) {
                var matches = ctx.search("hello");
                var lines = matches.split("\n").filter(function(l) { return l.length > 0; });
                return { count: lines.length };
            }
        "#, host);
        assert!(result.success, "Error: {:?}", result.error);
        assert_eq!(result.value["count"], 2);
    }

    #[test]
    fn test_search_no_results() {
        let host = Arc::new(MockHost::new().with_file("/a.txt", "nothing here"));
        let result = execute_js_with_host(r#"
            function run(ctx) {
                var matches = ctx.search("nonexistent");
                var lines = matches.split("\n").filter(function(l) { return l.length > 0; });
                return { count: lines.length };
            }
        "#, host);
        assert!(result.success, "Error: {:?}", result.error);
        assert_eq!(result.value["count"], 0);
    }

    // ── Phase 4 Tests (frontend bridge — IDE state) ───────────────

    #[test]
    fn test_diagnostics() {
        let host = Arc::new(
            MockHost::new()
                .with_file("/src/app.rs", "fn main() {}\n// ERROR: unused variable\nlet x = 1;")
                .with_file("/src/lib.rs", "// WARN: deprecated function\npub fn old() {}"),
        );
        let result = execute_js_with_host(r#"
            function run(ctx) {
                var d = ctx.diagnostics();
                var errors = d.diagnostics.filter(function(x) { return x.severity === "error"; });
                var warnings = d.diagnostics.filter(function(x) { return x.severity === "warning"; });
                return { total: d.count, errors: errors.length, warnings: warnings.length };
            }
        "#, host);
        assert!(result.success, "Error: {:?}", result.error);
        assert_eq!(result.value["total"], 2);
        assert_eq!(result.value["errors"], 1);
        assert_eq!(result.value["warnings"], 1);
    }

    #[test]
    fn test_diagnostics_filtered_by_path() {
        let host = Arc::new(
            MockHost::new()
                .with_file("/src/app.rs", "// ERROR: type mismatch")
                .with_file("/src/lib.rs", "// ERROR: missing import\n// WARN: unused"),
        );
        let result = execute_js_with_host(r#"
            function run(ctx) {
                var d = ctx.diagnostics("/src/lib.rs");
                return { count: d.count, first_msg: d.diagnostics[0].message };
            }
        "#, host);
        assert!(result.success, "Error: {:?}", result.error);
        assert_eq!(result.value["count"], 2);
        assert_eq!(result.value["first_msg"], "missing import");
    }

    #[test]
    fn test_selection() {
        let host = Arc::new(MockHost::new());
        let result = execute_js_with_host(r#"
            function run(ctx) {
                var sel = ctx.selection();
                return {
                    text: sel.text,
                    path: sel.path,
                    start: sel.start_line,
                    end: sel.end_line
                };
            }
        "#, host);
        assert!(result.success, "Error: {:?}", result.error);
        assert_eq!(result.value["text"], "selected text");
        assert_eq!(result.value["path"], "/src/app.rs");
        assert_eq!(result.value["start"], 10);
        assert_eq!(result.value["end"], 15);
    }

    #[test]
    fn test_open_files() {
        let host = Arc::new(
            MockHost::new()
                .with_file("/src/app.rs", "")
                .with_file("/src/lib.rs", ""),
        );
        let result = execute_js_with_host(r#"
            function run(ctx) {
                var f = ctx.open_files().split("\n").filter(function(l) { return l.length > 0; });
                return { count: f.length };
            }
        "#, host);
        assert!(result.success, "Error: {:?}", result.error);
        assert_eq!(result.value["count"], 2);
    }

    #[test]
    fn test_open_file() {
        let host = Arc::new(MockHost::new());
        let result = execute_js_with_host(r#"
            function run(ctx) {
                ctx.open_file("/src/app.rs", 42);
                return { opened: true };
            }
        "#, host);
        assert!(result.success, "Error: {:?}", result.error);
        assert_eq!(result.value["opened"], true);
    }

    #[test]
    fn test_diagnostics_driven_fix_loop() {
        // The OPIDE-specific use case: read diagnostics, fix errors, verify
        let host = Arc::new(
            MockHost::new()
                .with_file("/src/app.rs", "// ERROR: missing semicolon\nlet x = 1\n// ERROR: unused import\nuse std::io;"),
        );
        let result = execute_js_with_host(r#"
            function run(ctx) {
                // Get diagnostics
                var d = ctx.diagnostics("/src/app.rs");
                ctx.log("Found " + d.count + " issues");

                // Read file
                var content = ctx.file_read("/src/app.rs").content;
                var lines = content.split("\n");

                // "Fix" by removing error comment lines
                var fixed = lines.filter(function(line) {
                    return !line.startsWith("// ERROR:");
                }).join("\n");

                ctx.file_write("/src/app.rs", fixed);
                ctx.log("Applied fixes");

                // Re-check diagnostics
                var after = ctx.diagnostics("/src/app.rs");
                ctx.log("Remaining issues: " + after.count);

                return { before: d.count, after: after.count, fixed: d.count - after.count };
            }
        "#, host);
        assert!(result.success, "Error: {:?}", result.error);
        assert_eq!(result.value["before"], 2);
        assert_eq!(result.value["after"], 0);
        assert_eq!(result.value["fixed"], 2);
        assert_eq!(result.logs.len(), 3);
    }

    // ── Phase 5 Tests (generic tool gateway) ──────────────────────

    #[test]
    fn test_tool_gateway_read_file() {
        let host = Arc::new(MockHost::new().with_file("/src/app.rs", "fn main() {}"));
        let result = execute_js_with_host(r#"
            function run(ctx) {
                var result = ctx.tool("ide_read_file", { path: "/src/app.rs" });
                return { content: result.content || result.result || "", has_result: true };
            }
        "#, host);
        assert!(result.success, "Error: {:?}", result.error);
        assert_eq!(result.value["has_result"], true);
    }

    #[test]
    fn test_tool_gateway_memory_search() {
        let host = Arc::new(MockHost::new());
        let result = execute_js_with_host(r#"
            function run(ctx) {
                var r = ctx.tool("memory_search", { query: "project setup" });
                return { count: r.results.length, first: r.results[0].content };
            }
        "#, host);
        assert!(result.success, "Error: {:?}", result.error);
        assert_eq!(result.value["count"], 1);
        assert!(result.value["first"].as_str().unwrap().contains("project setup"));
    }

    #[test]
    fn test_tool_gateway_memory_store() {
        let host = Arc::new(MockHost::new());
        let result = execute_js_with_host(r#"
            function run(ctx) {
                var r = ctx.tool("memory_store", { content: "important note", category: "project" });
                return { stored: r.stored };
            }
        "#, host);
        assert!(result.success, "Error: {:?}", result.error);
        assert_eq!(result.value["stored"], true);
    }

    #[test]
    fn test_tool_gateway_unknown_tool() {
        let host = Arc::new(MockHost::new());
        let result = execute_js_with_host(r#"
            function run(ctx) {
                try { var r = ctx.tool("nonexistent_tool", {}); return { error: null }; }
                catch(e) { return { error: e.message || String(e) }; }
            }
        "#, host);
        assert!(result.success, "Error: {:?}", result.error);
        assert!(result.value["error"].as_str().unwrap().contains("Unknown tool"));
    }

    #[test]
    fn test_tool_gateway_no_args() {
        let host = Arc::new(MockHost::new());
        let result = execute_js_with_host(r#"
            function run(ctx) {
                var r = ctx.tool("memory_search");
                return { count: r.results.length };
            }
        "#, host);
        assert!(result.success, "Error: {:?}", result.error);
        assert_eq!(result.value["count"], 1);
    }

    // ── Phase 7 Tests (log streaming) ─────────────────────────────

    #[test]
    fn test_streaming_log_callback() {
        let host = Arc::new(MockHost::new());
        let streamed: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let streamed_clone = streamed.clone();

        let callback: LogCallback = Arc::new(move |msg: &str| {
            streamed_clone.lock().unwrap().push(msg.to_string());
        });

        let result = execute_js_with_host_streaming(r#"
            function run(ctx) {
                ctx.log("step 1: reading files");
                ctx.file_write("/test.txt", "hello");
                ctx.log("step 2: file written");
                ctx.log("step 3: done");
                return { ok: true };
            }
        "#, host, callback);

        assert!(result.success, "Error: {:?}", result.error);

        // Verify logs are in the final result
        assert_eq!(result.logs.len(), 3);
        assert_eq!(result.logs[0], "step 1: reading files");

        // Verify the callback received all logs in real-time
        let streamed_logs = streamed.lock().unwrap();
        assert_eq!(streamed_logs.len(), 3);
        assert_eq!(streamed_logs[0], "step 1: reading files");
        assert_eq!(streamed_logs[1], "step 2: file written");
        assert_eq!(streamed_logs[2], "step 3: done");
    }

    #[test]
    fn test_streaming_callback_on_error() {
        let host = Arc::new(MockHost::new());
        let streamed: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let streamed_clone = streamed.clone();

        let callback: LogCallback = Arc::new(move |msg: &str| {
            streamed_clone.lock().unwrap().push(msg.to_string());
        });

        let result = execute_js_with_host_streaming(r#"
            function run(ctx) {
                ctx.log("before error");
                throw new Error("something broke");
            }
        "#, host, callback);

        assert!(!result.success);
        // The log before the error should still have been streamed
        let streamed_logs = streamed.lock().unwrap();
        assert_eq!(streamed_logs.len(), 1);
        assert_eq!(streamed_logs[0], "before error");
    }

    #[test]
    fn test_full_workflow_git_and_files() {
        // Simulate: create files, search, stage, commit, check log
        let host = Arc::new(MockHost::new());
        let result = execute_js_with_host(r#"
            function run(ctx) {
                // Create files
                ctx.file_write("/src/app.rs", "fn main() { println!(\"hello\"); }");
                ctx.file_write("/src/lib.rs", "pub fn add(a: i32, b: i32) -> i32 { a + b }");
                ctx.log("Files created");

                // Search for a function
                var matches = ctx.search("fn main");
                var match_lines = matches.split("\n").filter(function(l) { return l.length > 0; });
                ctx.log("Found " + match_lines.length + " matches for fn main");

                // Check status
                var status = ctx.git_status();
                ctx.log("Branch: " + status.branch + ", files: " + status.files.length);

                // Commit
                ctx.git_stage(null, ["/src/app.rs", "/src/lib.rs"]);
                var commit_id = ctx.git_commit(null, "feat: initial app");
                ctx.log("Committed: " + commit_id);

                // Check log
                var log = ctx.git_log(null, 5);

                return {
                    files_created: 2,
                    search_matches: match_lines.length,
                    branch: status.branch,
                    commits: log.length,
                    last_commit: log.length > 0 ? log[log.length - 1].message : ""
                };
            }
        "#, host);
        assert!(result.success, "Error: {:?}", result.error);
        assert_eq!(result.value["files_created"], 2);
        assert_eq!(result.value["search_matches"], 1);
        assert_eq!(result.value["branch"], "main");
        assert_eq!(result.value["commits"], 2); // initial + new
        assert_eq!(result.value["last_commit"], "feat: initial app");
        assert_eq!(result.logs.len(), 4);
    }

}
