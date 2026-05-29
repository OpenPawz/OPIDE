// OPIDE Search — powered by the `ignore` + `grep` crates (same as ripgrep).
//
// Provides:
//   - `search_files`: project-wide text search with context lines
//   - `search_file_list`: fast file listing respecting .gitignore (for Cmd+P)

use ignore::WalkBuilder;
use grep_searcher::sinks::UTF8;
use grep_searcher::Searcher;
use serde::{Deserialize, Serialize};

// ─── Types ───────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Clone)]
pub struct SearchMatch {
    pub path: String,
    pub line_number: u64,
    pub line_text: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct SearchResult {
    pub matches: Vec<SearchMatch>,
    pub total_matches: usize,
    pub truncated: bool,
}

#[derive(Debug, Deserialize)]
pub struct SearchRequest {
    pub root: String,
    pub query: String,
    pub is_regex: bool,
    pub case_sensitive: bool,
    pub glob: Option<String>,
    pub max_results: Option<usize>,
}

// ─── Commands ────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn search_files(request: SearchRequest) -> Result<SearchResult, String> {
    let max_results = request.max_results.unwrap_or(500);
    // Collect one extra past the cap so we can tell "exactly max_results
    // matches and that's all" (truncated=false) from "hit the cap and
    // there's more" (truncated=true). Without this, a result set that
    // lands exactly on the cap is always flagged truncated.
    let collect_cap = max_results.saturating_add(1);

    // Build the regex matcher
    let pattern = if request.is_regex {
        request.query.clone()
    } else {
        regex::escape(&request.query)
    };

    let matcher = grep_regex::RegexMatcherBuilder::new()
        .case_insensitive(!request.case_sensitive)
        .build(&pattern)
        .map_err(|e| format!("Invalid search pattern: {e}"))?;

    let mut all_matches = Vec::new();

    // Walk files respecting .gitignore. hidden(false) so dotfiles and
    // dot-directories ARE searchable — people grep .github/workflows,
    // .vscode/settings.json, .env.example constantly, and excluding
    // them silently is surprising. The heavy hidden dir (.git) is still
    // skipped by the explicit /.git/ check below, and .gitignore'd files
    // stay excluded via git_ignore(true).
    let walker = WalkBuilder::new(&request.root)
        .hidden(false)         // include dotfiles/dotdirs (except .git, skipped below)
        .git_ignore(true)      // respect .gitignore
        .git_global(true)      // respect global gitignore
        .git_exclude(true)     // respect .git/info/exclude
        .build();

    let mut searcher = Searcher::new();

    for entry in walker {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };

        // Skip directories
        if entry.file_type().map_or(true, |ft| !ft.is_file()) {
            continue;
        }

        let path = entry.path();

        // B125: previously this list also blocked Solidity-specific dirs
        // (`deployments/`, `artifacts/`, `cache_forge/`, `typechain-types/`,
        // `out/`) which made search opaque on non-Solidity workspaces. Rely
        // on `.gitignore` (already honored by WalkBuilder above) for
        // project-specific exclusions, and only keep universal noise here.
        let path_str_check = path.to_string_lossy();
        if path_str_check.contains("/node_modules/")
            || path_str_check.contains("/.git/")
            || path_str_check.contains("/target/")
        {
            continue;
        }

        // Skip files larger than 500KB to prevent context blowouts
        if let Ok(meta) = std::fs::metadata(path) {
            if meta.len() > 500_000 {
                continue;
            }
        }

        let path_str = path.to_string_lossy().to_string();
        // Strip the root prefix for cleaner display
        let relative = path_str
            .strip_prefix(&request.root)
            .unwrap_or(&path_str)
            .trim_start_matches('/');

        // Apply glob filter if provided. Match against the RELATIVE
        // path (not just the file name) so path globs like
        // `src/**/*.ts` work — consistent with search_file_list.
        if let Some(ref glob) = request.glob {
            if !glob_match(glob, relative) {
                continue;
            }
        }

        let relative_owned = relative.to_string();

        let _ = searcher.search_path(
            &matcher,
            path,
            UTF8(|line_number, line_text| {
                if all_matches.len() < collect_cap {
                    all_matches.push(SearchMatch {
                        path: relative_owned.clone(),
                        line_number,
                        line_text: line_text.trim_end().to_string(),
                    });
                }
                Ok(all_matches.len() < collect_cap)
            }),
        );

        if all_matches.len() >= collect_cap {
            break;
        }
    }

    // We over-collected by one to detect real truncation. If we got the
    // extra match, there was more than the cap — flag truncated and
    // trim back down to max_results.
    let truncated = all_matches.len() > max_results;
    if truncated {
        all_matches.truncate(max_results);
    }
    let total = all_matches.len();

    Ok(SearchResult {
        matches: all_matches,
        total_matches: total,
        truncated,
    })
}

#[tauri::command]
pub async fn search_file_list(
    root: String,
    max_results: Option<usize>,
    pattern: Option<String>,
) -> Result<Vec<String>, String> {
    let max = max_results.unwrap_or(5000);

    // Compile the optional glob once. A `None` or empty/`*` pattern is treated
    // as "match everything" so we don't pay the matcher cost for the common
    // case where the caller just wants every file.
    let compiled = match pattern.as_deref() {
        None | Some("") | Some("*") => None,
        Some(p) => Some(glob::Pattern::new(p).map_err(|e| format!("invalid glob: {e}"))?),
    };

    // hidden(false): match search_files — dotfiles/dotdirs are listable
    // (Cmd+P should find .github/workflows/ci.yml). .git is skipped
    // explicitly below; .gitignore'd files stay excluded.
    let walker = WalkBuilder::new(&root)
        .hidden(false)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .build();

    let mut files = Vec::new();

    for entry in walker {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };

        if entry.file_type().map_or(true, |ft| !ft.is_file()) {
            continue;
        }

        // Now that hidden(false) lets the walker descend into dotdirs,
        // skip the heavy/noisy ones explicitly — same set search_files
        // filters. Without this, Cmd+P would list every object under
        // .git/, plus node_modules/ and target/ if not gitignored.
        let path_check = entry.path().to_string_lossy();
        if path_check.contains("/.git/")
            || path_check.contains("/node_modules/")
            || path_check.contains("/target/")
        {
            continue;
        }

        let path = entry.path().to_string_lossy().to_string();
        let relative = path
            .strip_prefix(&root)
            .unwrap_or(&path)
            .trim_start_matches('/')
            .to_string();

        if let Some(g) = &compiled {
            if !g.matches(&relative) {
                continue;
            }
        }

        files.push(relative);

        if files.len() >= max {
            break;
        }
    }

    Ok(files)
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/// B126: real glob semantics via the `glob` crate — handles `**`, `{a,b}`,
/// `[abc]`, `?`, `*`. The naive replace-based regex previously produced
/// false matches on patterns containing brackets, braces, or other
/// regex-meaningful characters that aren't part of the glob spec.
fn glob_match(pattern: &str, name: &str) -> bool {
    glob::Pattern::new(pattern)
        .map(|p| p.matches(name))
        .unwrap_or(false)
}
