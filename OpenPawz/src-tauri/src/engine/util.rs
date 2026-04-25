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
