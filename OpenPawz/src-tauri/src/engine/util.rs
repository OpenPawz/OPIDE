/// Truncate a string to at most `max_bytes` bytes, rounding down to the
/// nearest UTF-8 character boundary so we never panic on a byte-level slice.
#[inline]
pub fn safe_truncate(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes {
        return s;
    }
    &s[..s.floor_char_boundary(max_bytes)]
}

/// Truncate a `String` in place at the largest char boundary ≤ `max_bytes`,
/// then append a marker. Replaces ad-hoc `String::truncate(n)` calls that
/// would panic when `n` lands on a multi-byte UTF-8 boundary
/// (B130 exec output, B167 fetch body).
#[inline]
pub fn safe_truncate_in_place(s: &mut String, max_bytes: usize, marker: &str) {
    if s.len() <= max_bytes {
        return;
    }
    let cut = s.floor_char_boundary(max_bytes);
    s.truncate(cut);
    s.push_str(marker);
}

/// Sanitize a tool name for OpenAI/Azure/Kimi compatibility (only
/// `[A-Za-z0-9_-]`). When the sanitized form differs from the original,
/// append a stable 6-char hash suffix so distinct originals like `foo.bar`
/// and `foo_bar` don't collide on the wire — both used to map to `foo_bar`,
/// and the model's tool-call response then routed ambiguously (B99). Total
/// length stays ≤ 64 characters (56 + 1 + 6 = 63), within the OpenAI cap.
pub fn sanitize_tool_name(name: &str) -> String {
    let sanitized: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if sanitized == name {
        // No munging happened — safe to return as-is.
        if sanitized.len() <= 64 {
            return sanitized;
        }
    }
    // Either name was rewritten, or it's longer than 64 chars; append a
    // stable hash suffix to disambiguate.
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    name.hash(&mut hasher);
    let hash_hex = format!("{:x}", hasher.finish());
    let head: String = sanitized.chars().take(56).collect();
    format!("{}_{}", head, &hash_hex[..6])
}

// ── Credential / sensitive-path helpers (B133/B132/B194) ───────────────────
//
// These were originally local to `engine/tools/filesystem.rs` (B133/B138),
// but OPIDE's tool layout routes file ops through the sandbox's
// `host_api.rs` instead of the standalone filesystem tool. Moving the
// detectors here lets BOTH paths reuse the same gates so a fix in one
// place protects every file-write entry point.

/// Sensitive paths that no agent may read or write — credentials, browser
/// profiles, password managers, shell history, engine internals.
/// Matched against the canonicalised path (lowercased on case-insensitive OS).
pub const SENSITIVE_PATHS: &[&str] = &[
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

/// Refuse if `path` (raw or canonical) intersects a `SENSITIVE_PATHS` entry.
/// Returns `Err(reason)` on hit, `Ok(())` otherwise. Caller decides
/// whether to convert to a tool error or a user-visible refusal.
///
/// B194: ported from filesystem.rs so host_api.rs (the sandbox path
/// OPIDE actually uses) can apply the same gate.
pub fn check_sensitive_path(raw_path: &str) -> Result<(), String> {
    let canonical = std::path::Path::new(raw_path)
        .canonicalize()
        .ok()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| raw_path.to_string());

    // Build a set of strings to match each `SENSITIVE_PATHS` entry against.
    // Always include both the raw input AND the canonical form. On macOS,
    // also include the canonical form with a leading `/private` stripped —
    // `canonicalize("/etc/passwd")` returns `/private/etc/passwd`, so a
    // pattern like `/etc/passwd` would otherwise miss.
    let normalize = |s: &str| -> String {
        #[cfg(target_os = "macos")]
        let out = s.replace('\\', "/").to_lowercase();
        #[cfg(not(target_os = "macos"))]
        let out = s.replace('\\', "/");
        out
    };
    let raw_norm = normalize(raw_path);
    let canon_norm = normalize(&canonical);
    let canon_no_private = canon_norm
        .strip_prefix("/private")
        .map(|s| s.to_string())
        .unwrap_or_else(|| canon_norm.clone());
    let candidates: [&str; 3] = [&raw_norm, &canon_norm, &canon_no_private];

    for sensitive in SENSITIVE_PATHS {
        // B138: engine source carve-out for forks.
        #[cfg(feature = "engine-fork-mode")]
        {
            if *sensitive == "src-tauri/src/engine" {
                continue;
            }
        }

        let hit = if sensitive.starts_with('/') {
            candidates.iter().any(|c| c.starts_with(sensitive))
        } else {
            let needle = format!("/{}/", sensitive);
            let needle_end = format!("/{}", sensitive);
            candidates
                .iter()
                .any(|c| c.contains(&needle) || c.ends_with(&needle_end))
        };
        if hit {
            return Err(format!(
                "Refusing access to '{}': blocked by security policy (matched '{}').",
                raw_path, sensitive
            ));
        }
    }
    Ok(())
}

/// Structured detection of credential-shaped values in user-written
/// content. Each branch matches a known prefix or strict shape — never a
/// loose substring — so README mentions of AWS or .env.example templates
/// don't trigger a writer block.
///
/// B133/B194: this is the only credential heuristic in the engine. Both
/// `tools/filesystem.rs::execute_write_file` (standalone OpenPawz path)
/// and `crates/opide-ai/.../host_api.rs::file_write` (OPIDE sandbox path)
/// call it, so fixes/additions ripple to every file-write surface.
pub fn looks_like_credential_value(content: &str) -> Option<&'static str> {
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
        static KV: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
        let re = KV.get_or_init(|| {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ascii_only() {
        assert_eq!(safe_truncate("hello world", 5), "hello");
    }

    #[test]
    fn exact_len() {
        assert_eq!(safe_truncate("abc", 3), "abc");
    }

    #[test]
    fn under_limit() {
        assert_eq!(safe_truncate("ab", 10), "ab");
    }

    #[test]
    fn emoji_boundary() {
        // 🔴 is 4 bytes (U+1F534)
        let s = "aa🔴bb"; // bytes: a(1) a(1) 🔴(4) b(1) b(1) = 8
        assert_eq!(safe_truncate(s, 3), "aa"); // can't fit the emoji
        assert_eq!(safe_truncate(s, 6), "aa🔴"); // emoji fits fully
        assert_eq!(safe_truncate(s, 5), "aa"); // mid-emoji → back up
        assert_eq!(safe_truncate(s, 4), "aa"); // mid-emoji → back up
    }

    #[test]
    fn empty() {
        assert_eq!(safe_truncate("", 10), "");
    }

    #[test]
    fn sanitize_tool_name_passes_clean() {
        assert_eq!(sanitize_tool_name("exec"), "exec");
        assert_eq!(sanitize_tool_name("mcp_filesystem_read_file"), "mcp_filesystem_read_file");
    }

    #[test]
    fn sanitize_tool_name_disambiguates_punctuation() {
        let a = sanitize_tool_name("foo.bar");
        let b = sanitize_tool_name("foo_bar");
        // foo_bar passes through clean; foo.bar gets a hash suffix.
        assert_eq!(b, "foo_bar");
        assert!(a.starts_with("foo_bar_"));
        assert_ne!(a, b, "punctuation variants must not collide");
    }

    #[test]
    fn sanitize_tool_name_caps_long_names() {
        let long_a = "a".repeat(80);
        let long_b = format!("{}_extra", "a".repeat(75));
        let san_a = sanitize_tool_name(&long_a);
        let san_b = sanitize_tool_name(&long_b);
        assert!(san_a.len() <= 64);
        assert!(san_b.len() <= 64);
        assert_ne!(san_a, san_b, "different long inputs must hash to different suffixes");
    }

    #[test]
    fn cred_detector_catches_real_keys() {
        // The exact .env content Kimi wrote to disk in the B194 reproduction.
        assert_eq!(
            looks_like_credential_value("OPENAI_API_KEY=sk-1234567890abcdefghijklmnop1234"),
            Some("OpenAI/Anthropic API key"),
        );
        assert_eq!(
            looks_like_credential_value("AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE"),
            Some("AWS access key ID"),
        );
        assert_eq!(
            looks_like_credential_value("ghp_abcdefghijklmnopqrstuvwxyz0123456789"),
            Some("GitHub token"),
        );
    }

    #[test]
    fn cred_detector_skips_documentation() {
        // README mentioning AWS shouldn't trigger.
        assert_eq!(
            looks_like_credential_value("# Setting AWS_ACCESS_KEY_ID is required"),
            None,
        );
        // .env.example placeholders should not trigger.
        assert_eq!(
            looks_like_credential_value(
                "# .env.example\nOPENAI_API_KEY=your_key_here\nGITHUB_TOKEN=PLACEHOLDER"
            ),
            None,
        );
    }

    #[test]
    fn cred_detector_catches_kv_with_real_entropy() {
        let content = "DATABASE_PASSWORD=q9aF2pZxR7nEvKjL3mN5oQ1sU4tY6wB8";
        assert!(looks_like_credential_value(content).is_some());
    }

    #[test]
    fn sensitive_path_blocks_ssh() {
        assert!(check_sensitive_path("/Users/foo/.ssh/id_rsa").is_err());
        assert!(check_sensitive_path("/home/foo/.aws/credentials").is_err());
        assert!(check_sensitive_path("/etc/passwd").is_err());
    }

    #[test]
    fn sensitive_path_allows_normal_files() {
        assert!(check_sensitive_path("/Users/foo/Desktop/notes.md").is_ok());
        assert!(check_sensitive_path("/tmp/scratch.txt").is_ok());
    }

    #[test]
    fn multibyte_various() {
        // é is 2 bytes, 中 is 3 bytes
        let s = "aé中b"; // 1+2+3+1 = 7
        assert_eq!(safe_truncate(s, 1), "a");
        assert_eq!(safe_truncate(s, 2), "a"); // mid-é
        assert_eq!(safe_truncate(s, 3), "aé");
        assert_eq!(safe_truncate(s, 5), "aé"); // mid-中
        assert_eq!(safe_truncate(s, 6), "aé中");
    }
}
