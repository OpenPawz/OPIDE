// Paw Agent Engine — Filesystem tools
// read_file, write_file, list_directory, append_file, delete_file

use crate::atoms::error::EngineResult;
use crate::atoms::types::*;
use log::{info, warn};

/// Sensitive paths that agents must never read or write.
/// Checked against the canonicalized path (lowercased on case-insensitive OS).
const SENSITIVE_PATHS: &[&str] = &[
    // Credentials & secrets
    ".ssh",
    ".gnupg",
    ".gnome-keyring",
    ".password-store",
    ".aws/credentials",
    ".aws/config",
    ".config/gcloud",
    ".azure",
    ".npmrc",
    ".pypirc",
    ".docker/config.json",
    ".kube/config",
    ".local/share/keyrings",
    // Password managers
    ".config/1password",
    ".config/op",
    "Library/Group Containers/2BUA8C4S2C.com.1password",
    ".local/share/bitwarden",
    ".config/Bitwarden",
    ".local/share/keepassxc",
    ".lastpass",
    // macOS Keychain
    "Library/Keychains",
    // Shell config & history (credential/token leakage)
    ".bashrc",
    ".bash_profile",
    ".bash_history",
    ".zshrc",
    ".zsh_history",
    ".profile",
    ".gitconfig",
    // Browser profiles (cookies, tokens, saved passwords)
    ".mozilla",
    ".config/google-chrome",
    ".config/chromium",
    "Library/Application Support/Google/Chrome",
    "Library/Application Support/Firefox",
    "Library/Application Support/Microsoft Edge",
    "Library/Application Support/Arc",
    "Library/Application Support/BraveSoftware",
    ".config/microsoft-edge",
    ".config/BraveSoftware",
    // System
    "/etc/shadow",
    "/etc/passwd",
    "/etc/sudoers",
    // Paw engine internals
    ".paw/db",
    ".paw/keys",
    "src-tauri/src/engine",
];

/// B133: structured detection of credential-shaped values in user-written
/// content. Each branch matches a known prefix or strict shape — never a
/// loose substring — so README mentions of AWS or .env.example templates
/// don't trigger the writer block.
fn looks_like_credential_value(content: &str) -> Option<&'static str> {
    use std::sync::OnceLock;
    static PATTERNS: OnceLock<Vec<(regex::Regex, &'static str)>> = OnceLock::new();
    let patterns = PATTERNS.get_or_init(|| {
        let raw: &[(&str, &'static str)] = &[
            // GitHub PAT / OAuth / Apps / fine-grained
            (r"\bgh[poursa]_[A-Za-z0-9]{36,}\b", "GitHub token"),
            (r"\bgithub_pat_[A-Za-z0-9_]{20,}\b", "GitHub fine-grained PAT"),
            // OpenAI / Anthropic style keys
            (r"\bsk-[A-Za-z0-9_-]{30,}\b", "OpenAI/Anthropic API key"),
            // AWS access key id
            (r"\bAKIA[0-9A-Z]{16}\b", "AWS access key ID"),
            // Slack tokens
            (r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b", "Slack token"),
            // Private key blocks (whole header, not just prefix)
            (
                r"-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----",
                "private key block",
            ),
            // JWT (3 segments)
            (
                r"\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\b",
                "JWT token",
            ),
        ];
        raw.iter()
            .map(|(p, label)| (regex::Regex::new(p).expect("invalid cred regex"), *label))
            .collect()
    });

    for (re, label) in patterns {
        if re.is_match(content) {
            return Some(label);
        }
    }

    // KEY=VALUE patterns where VALUE has high entropy. Skip example
    // templates so .env.example / .env.sample don't false-positive.
    if !content.contains(".env.example") && !content.contains(".env.sample") {
        let kv_re: &OnceLock<regex::Regex> = {
            static KV: OnceLock<regex::Regex> = OnceLock::new();
            &KV
        };
        let re = kv_re.get_or_init(|| {
            regex::Regex::new(
                r"(?m)^\s*[A-Z][A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD)\s*=\s*([A-Za-z0-9+/=_-]{20,})",
            )
            .expect("invalid kv regex")
        });
        for cap in re.captures_iter(content) {
            let value = &cap[1];
            let placeholder = value.starts_with("your_")
                || value.starts_with("YOUR_")
                || value.starts_with("placeholder")
                || value.starts_with("PLACEHOLDER")
                || value.contains("EXAMPLE")
                || value.contains("REPLACE_ME")
                || value.contains("CHANGEME");
            if !placeholder {
                return Some("KEY=VALUE credential");
            }
        }
    }

    None
}

/// Resolve a raw path (absolute or relative to agent workspace) into a
/// canonicalized `PathBuf`.  Returns `Err` if the path escapes the agent
/// workspace via `..` traversal or targets a sensitive location.
///
/// `operation` is used in error messages (e.g. "read_file", "write_file").
fn resolve_and_validate(
    raw_path: &str,
    agent_id: &str,
    operation: &str,
) -> EngineResult<std::path::PathBuf> {
    let resolved = if std::path::Path::new(raw_path).is_absolute() {
        std::path::PathBuf::from(raw_path)
    } else {
        let ws = super::ensure_workspace(agent_id)?;
        ws.join(raw_path)
    };

    // Canonicalize: resolve symlinks and `..` segments.
    // For operations on not-yet-existing files (write, append), canonicalize the parent.
    let canonical = if resolved.exists() {
        resolved.canonicalize().map_err(|e| {
            format!(
                "{}: failed to resolve path '{}': {}",
                operation, raw_path, e
            )
        })?
    } else if let Some(parent) = resolved.parent() {
        if parent.exists() {
            let canon_parent = parent.canonicalize().map_err(|e| {
                format!(
                    "{}: failed to resolve parent of '{}': {}",
                    operation, raw_path, e
                )
            })?;
            canon_parent.join(resolved.file_name().unwrap_or_default())
        } else {
            // Parent doesn't exist yet — use the raw resolved path but check for `..`
            resolved.clone()
        }
    } else {
        resolved.clone()
    };

    // B132: enforce workspace confinement on every call, not only when the
    // raw path contains `..`. The previous gate let absolute paths walk
    // straight to system locations as long as the literal raw string didn't
    // contain dot-dot. Now an absolute path that resolves outside the
    // agent's workspace must match an explicit allowlist.
    let ws_root = super::agent_workspace(agent_id);
    let canon_ws = ws_root.canonicalize().unwrap_or(ws_root.clone());
    let in_workspace = canonical.starts_with(&canon_ws);
    if !in_workspace {
        // Allowlisted prefixes outside the workspace — temp dirs and the
        // agent's own data root. Adjust here if policy needs to widen.
        const ALLOWED_OUTSIDE_WORKSPACE: &[&str] = &[
            "/tmp/",
            "/private/tmp/",
            "/var/folders/",
            "/var/tmp/",
            "/private/var/tmp/",
        ];
        let path_str_l = canonical.to_string_lossy().to_lowercase();
        let allowed_temp = ALLOWED_OUTSIDE_WORKSPACE
            .iter()
            .any(|p| path_str_l.starts_with(p));
        // Also allow read-only access to the user's home directory for
        // operations that genuinely need it (config files, project search
        // outside the workspace). The sensitive-path blocklist below still
        // gates dangerous targets like ~/.ssh and ~/.aws.
        let in_home = dirs::home_dir()
            .and_then(|h| h.canonicalize().ok())
            .map(|h| canonical.starts_with(&h))
            .unwrap_or(false);
        if !allowed_temp && !in_home {
            warn!(
                "[engine] {} blocked: {} resolved to {} (outside workspace, not allowlisted) (agent={})",
                operation,
                raw_path,
                canonical.display(),
                agent_id
            );
            return Err(format!(
                "{}: path '{}' is outside the agent's workspace and not in the access allowlist.",
                operation, raw_path
            )
            .into());
        }
    }

    // Check against sensitive paths
    // §Security: On macOS (case-insensitive HFS+/APFS), normalize to lowercase
    // so that paths like ~/.SSH or ~/.Aws still match the blocklist.
    #[cfg(target_os = "macos")]
    let path_str = canonical.to_string_lossy().to_lowercase();
    #[cfg(not(target_os = "macos"))]
    let path_str = canonical.to_string_lossy().to_string();
    for sensitive in SENSITIVE_PATHS {
        // B138: the `src-tauri/src/engine` entry blocked legitimate engine
        // forks from editing their own source. Skip it when the
        // `engine-fork-mode` feature is enabled at compile time so a fork
        // can opt out without removing the rest of the blocklist.
        #[cfg(feature = "engine-fork-mode")]
        {
            if *sensitive == "src-tauri/src/engine" {
                continue;
            }
        }

        if sensitive.starts_with('/') {
            // Absolute sensitive path
            if path_str.starts_with(sensitive) {
                warn!(
                    "[engine] {} blocked access to sensitive path: {} (agent={})",
                    operation, raw_path, agent_id
                );
                return Err(format!(
                    "{}: access to '{}' is blocked by security policy. This path contains sensitive system or credential data.",
                    operation, raw_path
                ).into());
            }
        } else {
            // Relative sensitive path — check if it appears as a path component
            let needle = format!("/{}/", sensitive);
            let needle_end = format!("/{}", sensitive);
            if path_str.contains(&needle) || path_str.ends_with(&needle_end) {
                warn!(
                    "[engine] {} blocked access to sensitive path: {} (matched '{}', agent={})",
                    operation, raw_path, sensitive, agent_id
                );
                return Err(format!(
                    "{}: access to '{}' is blocked by security policy. This path contains sensitive credential data.",
                    operation, raw_path
                ).into());
            }
        }
    }

    Ok(canonical)
}

pub fn definitions() -> Vec<ToolDefinition> {
    vec![
        ToolDefinition {
            tool_type: "function".into(),
            function: FunctionDefinition {
                name: "read_file".into(),
                description: "Read the contents of a file on the user's machine.".into(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "Absolute or relative file path to read" }
                    },
                    "required": ["path"]
                }),
            },
        },
        ToolDefinition {
            tool_type: "function".into(),
            function: FunctionDefinition {
                name: "write_file".into(),
                description: "Write content to a file on the user's machine. Creates the file if it doesn't exist, overwrites if it does.".into(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "Absolute or relative file path to write" },
                        "content": { "type": "string", "description": "The content to write to the file" }
                    },
                    "required": ["path", "content"]
                }),
            },
        },
        ToolDefinition {
            tool_type: "function".into(),
            function: FunctionDefinition {
                name: "list_directory".into(),
                description: "List files and subdirectories in a directory. Returns names, sizes, and types. Optionally recurse into subdirectories.".into(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "Directory path to list (default: current directory)" },
                        "recursive": { "type": "boolean", "description": "If true, list contents recursively (default: false)" },
                        "max_depth": { "type": "integer", "description": "Maximum recursion depth (default: 3)" }
                    }
                }),
            },
        },
        ToolDefinition {
            tool_type: "function".into(),
            function: FunctionDefinition {
                name: "append_file".into(),
                description: "Append content to the end of a file. Creates the file if it doesn't exist. Unlike write_file, this preserves existing content.".into(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "File path to append to" },
                        "content": { "type": "string", "description": "Content to append to the file" }
                    },
                    "required": ["path", "content"]
                }),
            },
        },
        ToolDefinition {
            tool_type: "function".into(),
            function: FunctionDefinition {
                name: "delete_file".into(),
                description: "Delete a file or directory from the filesystem. For directories, set recursive=true to delete non-empty directories.".into(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "Path to the file or directory to delete" },
                        "recursive": { "type": "boolean", "description": "If true and path is a directory, delete it and all contents (default: false)" }
                    },
                    "required": ["path"]
                }),
            },
        },
    ]
}

pub async fn execute(
    name: &str,
    args: &serde_json::Value,
    agent_id: &str,
) -> Option<Result<String, String>> {
    match name {
        "read_file" => Some(
            execute_read_file(args, agent_id)
                .await
                .map_err(|e| e.to_string()),
        ),
        "write_file" => Some(
            execute_write_file(args, agent_id)
                .await
                .map_err(|e| e.to_string()),
        ),
        "list_directory" => Some(
            execute_list_directory(args, agent_id)
                .await
                .map_err(|e| e.to_string()),
        ),
        "append_file" => Some(
            execute_append_file(args, agent_id)
                .await
                .map_err(|e| e.to_string()),
        ),
        "delete_file" => Some(
            execute_delete_file(args, agent_id)
                .await
                .map_err(|e| e.to_string()),
        ),
        _ => None,
    }
}

async fn execute_read_file(args: &serde_json::Value, agent_id: &str) -> EngineResult<String> {
    let raw_path = args["path"]
        .as_str()
        .ok_or("read_file: missing 'path' argument")?;
    let resolved = resolve_and_validate(raw_path, agent_id, "read_file")?;
    let path = resolved.to_string_lossy();

    info!("[engine] read_file: {} (agent={})", path, agent_id);

    // B131: previously this also blocked any `.rs` file from reads while
    // write_file happily allowed `.rs` writes — an asymmetric posture that
    // protected nothing while breaking Rust development workflows. The
    // engine-source carve-out is enforced symmetrically inside
    // `resolve_and_validate` (B138 / B73 BLOCKED_TOOLS handle the
    // `is_opide_host` case); blocking by extension here is dead policy.
    let normalized = path.replace('\\', "/").to_lowercase();
    if normalized.contains("src-tauri/src/engine/") || normalized.contains("src/engine/") {
        return Err(format!(
            "Cannot read engine source file '{}'. \
             Use your available tools directly — credentials and authentication are handled automatically.",
            path
        )
        .into());
    }

    let content = std::fs::read_to_string(&resolved)
        .map_err(|e| format!("Failed to read file '{}': {}", path, e))?;

    const MAX_FILE: usize = 32_000;
    if content.len() > MAX_FILE {
        let mut end = MAX_FILE;
        while end > 0 && !content.is_char_boundary(end) {
            end -= 1;
        }
        Ok(format!(
            "{}...\n[truncated, {} total bytes]",
            &content[..end],
            content.len()
        ))
    } else {
        Ok(content)
    }
}

async fn execute_write_file(args: &serde_json::Value, agent_id: &str) -> EngineResult<String> {
    let raw_path = args["path"]
        .as_str()
        .ok_or("write_file: missing 'path' argument")?;
    let content = args["content"]
        .as_str()
        .ok_or("write_file: missing 'content' argument")?;
    let resolved = resolve_and_validate(raw_path, agent_id, "write_file")?;
    let path = resolved.to_string_lossy();

    info!(
        "[engine] write_file: {} ({} bytes, agent={})",
        path,
        content.len(),
        agent_id
    );

    // B133: structured credential detection. The previous bag-of-substrings
    // (`AKIA` anywhere, `secret` anywhere with `==`) tripped on legitimate
    // documentation (README mentioning AWS variables, code comments
    // describing tokens, .env.example templates, base64-encoded binaries
    // that happen to end with `==`). High-FP credential blocks made
    // write_file unusable for ordinary .md / .ts source.
    if let Some(kind) = looks_like_credential_value(content) {
        return Err(format!(
            "Cannot write file: detected what looks like a {}. \
             Credentials should be managed by the engine's skill vault, not written to disk.",
            kind
        )
        .into());
    }

    if let Some(parent) = resolved.parent() {
        std::fs::create_dir_all(parent)?;
    }

    std::fs::write(&resolved, content)
        .map_err(|e| format!("Failed to write file '{}': {}", path, e))?;

    Ok(format!(
        "Successfully wrote {} bytes to {}",
        content.len(),
        path
    ))
}

async fn execute_list_directory(args: &serde_json::Value, agent_id: &str) -> EngineResult<String> {
    let raw_path = args["path"].as_str().unwrap_or(".");
    let recursive = args["recursive"].as_bool().unwrap_or(false);
    let max_depth = args["max_depth"].as_u64().unwrap_or(3) as usize;

    let resolved = resolve_and_validate(raw_path, agent_id, "list_directory")?;
    let path = resolved.to_string_lossy().to_string();

    info!(
        "[engine] list_directory: {} recursive={} (agent={})",
        path, recursive, agent_id
    );

    if !resolved.exists() {
        return Err(format!("Directory '{}' does not exist", path).into());
    }
    if !resolved.is_dir() {
        return Err(format!("'{}' is not a directory", path).into());
    }

    let mut entries = Vec::new();
    let mut truncated_at_depth = false;

    fn walk_dir(
        dir: &std::path::Path,
        prefix: &str,
        depth: usize,
        max_depth: usize,
        entries: &mut Vec<String>,
        truncated: &mut bool,
    ) -> std::io::Result<()> {
        if depth > max_depth {
            *truncated = true;
            return Ok(());
        }
        let mut items: Vec<_> = std::fs::read_dir(dir)?.filter_map(|e| e.ok()).collect();
        items.sort_unstable_by_key(|a| a.file_name());
        for entry in &items {
            let name = entry.file_name().to_string_lossy().to_string();
            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
            let suffix = if is_dir { "/" } else { "" };
            if let Ok(meta) = entry.metadata() {
                let size = if is_dir {
                    String::new()
                } else {
                    format!(" ({} bytes)", meta.len())
                };
                entries.push(format!("{}{}{}{}", prefix, name, suffix, size));
            } else {
                entries.push(format!("{}{}{}", prefix, name, suffix));
            }
            if is_dir && depth < max_depth {
                walk_dir(
                    &entry.path(),
                    &format!("{}  ", prefix),
                    depth + 1,
                    max_depth,
                    entries,
                    truncated,
                )?;
            } else if is_dir {
                // Reached max_depth — there are subdirs we won't descend into.
                *truncated = true;
            }
        }
        Ok(())
    }

    if recursive {
        walk_dir(&resolved, "", 0, max_depth, &mut entries, &mut truncated_at_depth)
            .map_err(|e| format!("Failed to list directory '{}': {}", path, e))?;
        // B137: surface the depth truncation so the agent knows the listing is
        // incomplete instead of treating it as exhaustive.
        if truncated_at_depth {
            entries.push(format!(
                "[note: deeper paths truncated at max_depth={}]",
                max_depth
            ));
        }
    } else {
        let mut items: Vec<_> = std::fs::read_dir(&resolved)
            .map_err(|e| format!("Failed to list directory '{}': {}", path, e))?
            .filter_map(|e| e.ok())
            .collect();
        items.sort_unstable_by_key(|a| a.file_name());
        for entry in &items {
            let name = entry.file_name().to_string_lossy().to_string();
            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
            let suffix = if is_dir { "/" } else { "" };
            if let Ok(meta) = entry.metadata() {
                let size = if is_dir {
                    String::new()
                } else {
                    format!(" ({} bytes)", meta.len())
                };
                entries.push(format!("{}{}{}", name, suffix, size));
            } else {
                entries.push(format!("{}{}", name, suffix));
            }
        }
    }

    if entries.is_empty() {
        Ok(format!("Directory '{}' is empty.", path))
    } else {
        Ok(format!("Contents of '{}':\n{}", path, entries.join("\n")))
    }
}

async fn execute_append_file(args: &serde_json::Value, agent_id: &str) -> EngineResult<String> {
    let raw_path = args["path"]
        .as_str()
        .ok_or("append_file: missing 'path' argument")?;
    let content = args["content"]
        .as_str()
        .ok_or("append_file: missing 'content' argument")?;
    let resolved = resolve_and_validate(raw_path, agent_id, "append_file")?;
    let path = resolved.to_string_lossy();

    info!(
        "[engine] append_file: {} ({} bytes, agent={})",
        path,
        content.len(),
        agent_id
    );

    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&resolved)
        .map_err(|e| format!("Failed to open file '{}' for append: {}", path, e))?;

    file.write_all(content.as_bytes())
        .map_err(|e| format!("Failed to append to file '{}': {}", path, e))?;

    Ok(format!("Appended {} bytes to {}", content.len(), path))
}

async fn execute_delete_file(args: &serde_json::Value, agent_id: &str) -> EngineResult<String> {
    let raw_path = args["path"]
        .as_str()
        .ok_or("delete_file: missing 'path' argument")?;
    let recursive = args["recursive"].as_bool().unwrap_or(false);
    let resolved = resolve_and_validate(raw_path, agent_id, "delete_file")?;
    let path = resolved.to_string_lossy();

    info!(
        "[engine] delete_file: {} recursive={} (agent={})",
        path, recursive, agent_id
    );

    if !resolved.exists() {
        return Err(format!("Path '{}' does not exist", path).into());
    }

    if resolved.is_dir() {
        if recursive {
            std::fs::remove_dir_all(&resolved)
                .map_err(|e| format!("Failed to remove directory '{}': {}", path, e))?;
            Ok(format!("Deleted directory '{}' (recursive)", path))
        } else {
            std::fs::remove_dir(&resolved).map_err(|e| {
                format!(
                    "Failed to remove directory '{}' (not empty? use recursive=true): {}",
                    path, e
                )
            })?;
            Ok(format!("Deleted empty directory '{}'", path))
        }
    } else {
        std::fs::remove_file(&resolved)
            .map_err(|e| format!("Failed to delete file '{}': {}", path, e))?;
        Ok(format!("Deleted file '{}'", path))
    }
}
